"""Hardware profiles: which presets a machine gets, from its GPU and its RAM.

A profile is a file in profiles/: a presets.json template plus a "profile" block that says which machines it is for,
which model packs it needs, and which preset starts at boot. A profile can extend another ("extends"): objects merge
key by key, anything else (lists, numbers, strings) is replaced, and null removes a key. Profiles marked "abstract"
are only for extending.

`outcrop profile ...` and ./setup.sh use this module. Applying a profile writes $OUTCROP_HOME/presets.json, the file the
engine, the gateway and the console read.
"""
from __future__ import annotations

import copy
import datetime as dt
import difflib
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
PROFILE_DIR = Path(os.environ.get("OUTCROP_PROFILES") or PROJECT / "profiles")
OUTCROP_HOME = Path(os.environ.get("OUTCROP_HOME") or Path.home() / ".outcrop")
PRESETS_FILE = Path(os.environ.get("OUTCROP_PRESETS") or OUTCROP_HOME / "presets.json")

# Disk space, in GB, measured on the reference system: each pack's download, its Q8-dense copy and its prepared pack
# files, and what every install needs (the shared n-gram table, the MTP draft layer, the picture encoder, sources,
# the engine and the CUDA installer).
PACK_GB = {"q2_0": 76, "iq2_xs": 80, "iq3_xxs": 94, "iq3_s": 109}
# without the Q8-dense copy, which only the Maxwell profiles make: the download and the pack files (measured on a StartOS
# server, 2026-11-22: the copy is as big as shard 1 again; IQ3_S's shard 1 from its 84 GB download less the shared table)
PACK_GB_NO_Q8 = {"q2_0": 40, "iq2_xs": 42, "iq3_xxs": 48, "iq3_s": 57}
BASE_GB = 42


def merge(a, b):
    """b over a: objects merge key by key, null deletes, anything else replaces."""
    if not isinstance(a, dict) or not isinstance(b, dict):
        return copy.deepcopy(b)
    out = copy.deepcopy(a)
    for k, v in b.items():
        if v is None:
            out.pop(k, None)
        else:
            out[k] = merge(out.get(k), v) if isinstance(v, dict) else copy.deepcopy(v)
    return out


def raw(name: str) -> dict:
    p = PROFILE_DIR / f"{name}.json"
    if not p.is_file():
        raise KeyError(f"no profile {name!r} in {PROFILE_DIR} (outcrop profile list shows them)")
    return json.loads(p.read_text(encoding="utf-8"))


def compose(name: str, _seen: tuple = ()) -> dict:
    """The profile with everything it extends merged in."""
    if name in _seen:
        raise ValueError(f"profiles extend each other in a loop: {' -> '.join((*_seen, name))}")
    me = raw(name)
    if not isinstance(me, dict) or not isinstance(me.get("profile"), dict):
        raise ValueError(f"profile {name!r} has no \"profile\" block (docs/PROFILES.md)")
    parent = me["profile"].get("extends")
    if not parent:
        return me
    out = merge(compose(parent, (*_seen, name)), me)
    out["profile"] = me["profile"]                  # the profile block is the profile's own, never inherited
    return out


def usable(name: str) -> dict:
    """The composed profile, if it can be applied: not an abstract one (those are only for extending)."""
    prof = compose(name)
    if prof.get("profile", {}).get("abstract"):
        raise ValueError(f"{name} is only for other profiles to extend; choose one of {', '.join(names())}")
    return prof


def names(include_abstract: bool = False) -> list[str]:
    out = []
    for p in sorted(PROFILE_DIR.glob("*.json")):
        try:
            prof = json.loads(p.read_text(encoding="utf-8")).get("profile") or {}
            lo = (prof.get("match", {}).get("ram_gib") or [0])[0]
        except Exception:                                # a broken file: compose() reports it to whoever asks
            prof, lo = {}, 0
        if include_abstract or not prof.get("abstract"):
            out.append((lo, p.stem))
    return [n for _, n in sorted(out)]           # smallest RAM first


def disk_gb(prof: dict) -> int:
    sizes = PACK_GB if prof.get("common", {}).get("q8_dense", True) else PACK_GB_NO_Q8
    return BASE_GB + sum(sizes.get(p, 100) for p in prof["profile"].get("packs", []))


# ------------------------------------------------------------------------------------------------- the machine

def _run(*cmd) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def facts() -> dict:
    """What matters for choosing a profile, read from this machine."""
    f: dict = {"gpus": [], "ram_gib": 0, "cpus": os.cpu_count() or 0, "os": {}, "driver": None, "arch": platform.machine()}
    for line in _run("nvidia-smi", "--query-gpu=name,memory.total,driver_version,pcie.link.gen.max,pcie.link.width.current,"
                     "index,uuid", "--format=csv,noheader,nounits").splitlines():
        parts = [x.strip() for x in line.split(",")]
        if len(parts) >= 7:
            try:
                vram, memory = int(float(parts[1] or 0)), "discrete"
            except ValueError:
                # "[N/A]": a GPU with no memory of its own, such as the GB10 (DGX Spark), whose memory is the CPU's
                vram, memory = 0, "unified"
            f["gpus"].append({"name": parts[0], "vram_mib": vram, "memory": memory,
                              "pcie": f"Gen{parts[3]} x{parts[4]}", "index": parts[5], "uuid": parts[6]})
            f["driver"] = parts[2]
    try:
        for line in open("/proc/meminfo"):
            if line.startswith("MemTotal:"):
                f["ram_gib"] = round(int(line.split()[1]) / (1 << 20))
    except OSError:
        pass
    try:
        for line in open("/etc/os-release"):
            k, _, v = line.strip().partition("=")
            if k in ("ID", "ID_LIKE", "VERSION_ID", "PRETTY_NAME", "UBUNTU_CODENAME"):
                f["os"][k] = v.strip('"')
    except OSError:
        pass
    d = OUTCROP_HOME
    while not d.exists() and d != d.parent:
        d = d.parent
    f["disk"] = {"path": str(OUTCROP_HOME), "free_gb": shutil.disk_usage(d).free // 10**9}
    return f


def matched_gpu(prof: dict, f: dict) -> dict | None:
    m = prof["profile"].get("match", {})
    return (next((g for g in f["gpus"] if g["name"] in m.get("gpus", [])), None)
            or next((g for g in f["gpus"] if g["name"] in m.get("similar_gpus", [])), None))


def fit(prof: dict, f: dict) -> tuple[str | None, list[str]]:
    """How well a profile fits this machine: "exact" (a GPU it was made for and RAM in its range), "similar" (a GPU
    of the same family), or None, with the reasons."""
    m = prof["profile"].get("match", {})
    why = []
    gpu = next((g for g in f["gpus"] if g["name"] in m.get("gpus", [])), None)
    kind = "exact" if gpu else None
    if not gpu:
        gpu = next((g for g in f["gpus"] if g["name"] in m.get("similar_gpus", [])), None)
        kind = "similar" if gpu else None
    if not gpu:
        names_ = ", ".join(g["name"] for g in f["gpus"]) or "no NVIDIA GPU found"
        return None, [f"made for {', '.join(m.get('gpus', []))}; this machine has {names_}"]
    if m.get("arch") and f.get("arch") not in m["arch"]:
        return None, [f"for {', '.join(m['arch'])} CPUs; this machine is {f.get('arch') or 'unknown'}"]
    if m.get("memory", "discrete") != gpu.get("memory", "discrete"):
        return None, [f"for a GPU with {m.get('memory', 'discrete')} memory; {gpu['name']} has "
                      f"{gpu.get('memory', 'discrete')} memory"]
    if gpu["vram_mib"] < m.get("vram_mib_min", 0):
        return None, [f"needs {m['vram_mib_min']} MiB of VRAM; {gpu['name']} has {gpu['vram_mib']}"]
    lo, hi = m.get("ram_gib", [0, 10**6])
    if not lo <= f["ram_gib"] < hi:
        return None, [f"for {lo} to {hi} GiB of RAM; this machine has {f['ram_gib']}"]
    if kind == "similar":
        why.append(f"{gpu['name']} is the same GPU family as {', '.join(m['gpus'])}, but this profile was not tested on it")
    return kind, why


def suggest(f: dict | None = None) -> tuple[str | None, str, list[str]]:
    """The best profile for this machine: (name, "exact"/"similar"/"none", reasons)."""
    f = f or facts()
    if not f["gpus"]:
        return None, "none", ["no NVIDIA GPU found: is the NVIDIA driver installed? (`nvidia-smi` should list the card)"]
    similar = None
    reasons = []
    for n in names():
        try:
            kind, why = fit(compose(n), f)
        except (KeyError, ValueError) as e:              # a broken profile file: say so, and go on
            reasons.append(f"{n}: cannot be read ({str(e).strip(chr(39))})")
            continue
        if kind == "exact":
            return n, "exact", why
        if kind == "similar" and not similar:
            similar = (n, why)
        reasons += [f"{n}: {w}" for w in why]
    if similar:
        return similar[0], "similar", similar[1]
    return None, "none", reasons


# ------------------------------------------------------------------------------------------------- applying

def render(name: str, current: dict | None = None, f: dict | None = None) -> dict:
    """The presets.json a profile gives. The network sections (server, gateway, console) of an existing file are kept:
    they are this machine's choices, not the profile's. On a machine with more than one NVIDIA GPU (`f`, from facts()),
    the engine and the console are pointed at the card the profile matched, by its UUID."""
    prof = usable(name)
    out = {k: v for k, v in prof.items() if k != "profile"}
    if f and len(f.get("gpus", [])) > 1:
        g = matched_gpu(prof, f)
        if g and g.get("uuid"):
            out.setdefault("common", {}).setdefault("env", {})["CUDA_VISIBLE_DEVICES"] = g["uuid"]
    if current:
        for k in ("server", "gateway", "console"):
            if k in current:
                out[k] = current[k]
    p = prof["profile"]
    out = {"profile": {"name": p["name"], "title": p.get("title", ""), "default_preset": p.get("default_preset"),
                       "applied": dt.date.today().isoformat()}, **out}
    return out


def current() -> dict | None:
    try:
        return json.loads(PRESETS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def diff(name: str) -> str:
    cur = current()
    new = render(name, cur, facts())
    a = json.dumps({k: v for k, v in (cur or {}).items() if k != "profile"}, indent=2).splitlines(True)
    b = json.dumps({k: v for k, v in new.items() if k != "profile"}, indent=2).splitlines(True)
    return "".join(difflib.unified_diff(a, b, f"{PRESETS_FILE} (now)", f"{PRESETS_FILE} (profile {name})"))


def apply(name: str) -> tuple[Path, Path | None]:
    """Write presets.json from profile `name`, keeping a copy of the old file. Returns (file, backup or None)."""
    cur = current()
    new = render(name, cur, facts())
    PRESETS_FILE.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if PRESETS_FILE.exists():
        backup = PRESETS_FILE.with_name(f"presets.json.{dt.datetime.now():%Y%m%d-%H%M%S}.bak")
        shutil.copy2(PRESETS_FILE, backup)
    # in place, not by renaming a new file over it: the console's sandbox sees this file through a bind mount of the
    # file itself, which would keep showing the old, deleted one
    with open(PRESETS_FILE, "a+", encoding="utf-8") as f:
        f.seek(0)
        f.truncate()
        f.write(json.dumps(new, indent=2) + "\n")
    os.chmod(PRESETS_FILE, 0o600)
    return PRESETS_FILE, backup
