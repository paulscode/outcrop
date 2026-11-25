#!/usr/bin/env python3
"""gpu-link.py [--mib N] [--reps N]  - how fast each NVIDIA card's PCIe link really is, and whether two cards can copy to
each other directly: what a layer split or a second expert cache depends on.  Standard library only (ctypes on the CUDA
runtime), so it runs in Outcrop's StartOS container as it is:

    start-cli package attach outcrop --name outcrop --user root -- python3 /opt/outcrop/bench/gpu-link.py

Measures, with pinned host memory (as Strata uses):
  - host to card and card to host, each card alone (GB/s, the best of --reps copies of --mib MiB)
  - every card at once, both directions in turn: whether the cards share lanes (a slot wired x8, or a switch)
  - card to card: cudaDeviceCanAccessPeer each way, and the speed of cudaMemcpyPeer, direct or staged through RAM
Prints a JSON line per measurement, then a summary.  Reads $OUTCROP_CUDA_LIB for libcudart (else the usual places)."""
import argparse
import ctypes
import glob
import json
import os
import threading
import time

ap = argparse.ArgumentParser()
ap.add_argument("--mib", type=int, default=256)
ap.add_argument("--reps", type=int, default=8)
a = ap.parse_args()
SIZE = a.mib << 20


def load():
    dirs = [os.environ.get("OUTCROP_CUDA_LIB", ""), "/usr/local/cuda/lib64", "/usr/local/cuda-12.9/targets/x86_64-linux/lib",
            "/usr/lib/x86_64-linux-gnu"]
    for d in dirs:
        for f in sorted(glob.glob(os.path.join(d, "libcudart.so*")), reverse=True):
            try:
                return ctypes.CDLL(f)
            except OSError:
                pass
    raise SystemExit("libcudart not found (set OUTCROP_CUDA_LIB)")


rt = load()
H2D, D2H, D2D = 1, 2, 3


def ok(err, what):
    if err != 0:
        rt.cudaGetErrorString.restype = ctypes.c_char_p
        raise SystemExit(f"{what}: {rt.cudaGetErrorString(err).decode()}")


def count() -> int:
    n = ctypes.c_int()
    ok(rt.cudaGetDeviceCount(ctypes.byref(n)), "cudaGetDeviceCount")
    return n.value


def props(dev: int) -> dict:
    name = ctypes.create_string_buffer(256)
    bus = ctypes.create_string_buffer(32)
    rt.cudaDeviceGetPCIBusId(bus, 32, dev)
    # cudaDeviceProp's name is its first field: read it with a buffer big enough for the whole struct
    p = ctypes.create_string_buffer(4096)
    rt.cudaGetDeviceProperties(p, dev)
    name.value = p.raw[:256].split(b"\0")[0]
    return {"device": dev, "name": name.value.decode(), "pci": bus.value.decode()}


class Card:
    def __init__(self, dev: int):
        self.dev = dev
        ok(rt.cudaSetDevice(dev), f"cudaSetDevice({dev})")
        self.d = ctypes.c_void_p()
        ok(rt.cudaMalloc(ctypes.byref(self.d), ctypes.c_size_t(SIZE)), f"cudaMalloc on {dev}")
        self.h = ctypes.c_void_p()
        ok(rt.cudaMallocHost(ctypes.byref(self.h), ctypes.c_size_t(SIZE)), "cudaMallocHost")
        ctypes.memset(self.h, 1, SIZE)

    def copy(self, kind: int) -> float:
        """One copy's seconds."""
        rt.cudaSetDevice(self.dev)
        dst, src = (self.d, self.h) if kind == H2D else (self.h, self.d)
        t = time.perf_counter()
        ok(rt.cudaMemcpy(dst, src, ctypes.c_size_t(SIZE), kind), "cudaMemcpy")
        ok(rt.cudaDeviceSynchronize(), "cudaDeviceSynchronize")
        return time.perf_counter() - t


def gbs(sec: float) -> float:
    return round(SIZE / sec / 1e9, 2)


def best(fn, reps=a.reps) -> float:
    fn()                                                    # warm: the link leaves its idle power state
    return min(fn() for _ in range(reps))


def out(rec: dict) -> None:
    print(json.dumps(rec), flush=True)


n = count()
info = [props(i) for i in range(n)]
for i in info:
    out({"card": i})
cards = [Card(i) for i in range(n)]
alone = {}
for c in cards:
    for kind, label in ((H2D, "host_to_card"), (D2H, "card_to_host")):
        v = gbs(best(lambda: c.copy(kind)))
        alone[(c.dev, label)] = v
        out({"test": "alone", "device": c.dev, "direction": label, "GBps": v})

together = {}
if n > 1:
    for kind, label in ((H2D, "host_to_card"), (D2H, "card_to_host")):
        res = {}

        def run(c, kind=kind, res=res):
            c.copy(kind)
            res[c.dev] = min(c.copy(kind) for _ in range(a.reps))

        th = [threading.Thread(target=run, args=(c,)) for c in cards]
        for t in th:
            t.start()
        for t in th:
            t.join()
        for d, sec in res.items():
            together[(d, label)] = gbs(sec)
            out({"test": "together", "device": d, "direction": label, "GBps": gbs(sec)})

peer = []
if n > 1:
    for s in range(n):
        for d in range(n):
            if s == d:
                continue
            can = ctypes.c_int()
            rt.cudaDeviceCanAccessPeer(ctypes.byref(can), s, d)
            if can.value:
                rt.cudaSetDevice(s)
                rt.cudaDeviceEnablePeerAccess(d, 0)
                rt.cudaGetLastError()

            def p2p(s=s, d=d):
                t = time.perf_counter()
                ok(rt.cudaMemcpyPeer(cards[d].d, d, cards[s].d, s, ctypes.c_size_t(SIZE)), "cudaMemcpyPeer")
                rt.cudaSetDevice(d)
                ok(rt.cudaDeviceSynchronize(), "cudaDeviceSynchronize")
                return time.perf_counter() - t

            v = gbs(best(p2p))
            peer.append({"from": s, "to": d, "direct": bool(can.value), "GBps": v})
            out({"test": "card_to_card", "from": s, "to": d, "can_access_peer": bool(can.value), "GBps": v})

print("\nSummary (GB/s; PCIe 3.0 x16 gives about 12-13 in practice, x8 about 6-6.5):")
for i in info:
    d = i["device"]
    line = f"  card {d} {i['name']} at {i['pci']}: to card {alone[(d, 'host_to_card')]}, to host {alone[(d, 'card_to_host')]}"
    if together:
        line += f"; all cards at once: {together[(d, 'host_to_card')]} / {together[(d, 'card_to_host')]}"
    print(line)
for p in peer:
    print(f"  card {p['from']} -> {p['to']}: {p['GBps']} ({'direct' if p['direct'] else 'no peer access: staged through RAM'})")
