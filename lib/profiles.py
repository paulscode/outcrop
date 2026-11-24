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
    """The presets.json a profile gives. The network sections (server, gateway, console) and the settings of an existing
    file are kept: they are this machine's choices, not the profile's. On a machine with more than one NVIDIA GPU (`f`, from facts()),
    the engine and the console are pointed at the card the profile matched, by its UUID."""
    prof = usable(name)
    out = {k: v for k, v in prof.items() if k != "profile"}
    if f and len(f.get("gpus", [])) > 1:
        g = matched_gpu(prof, f)
        if g and g.get("uuid"):
            out.setdefault("common", {}).setdefault("env", {})["CUDA_VISIBLE_DEVICES"] = g["uuid"]
    if current:
        for k in ("server", "gateway", "console", "settings"):
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


# ------------------------------------------------------------------------------------------------- the packs on disk
# A pack's own files: its download (models/Q2_0: shard 1, and a link to the shared n-gram shard), its Q8-dense copy and
# its prepared pack (data/packs/q2_0).  The n-gram table, the picture encoder and the MTP draft layer are shared by all.
STATE = Path(os.environ.get("OUTCROP_STATE") or OUTCROP_HOME / "state")     # as strata_presets and the console
HARDWARE_FILE = STATE / "hardware.json"
PACKS_NOTICE = STATE / "packs-notice.txt"         # first_packs()'s message, until StartOS's start has told it


def pack_paths(pack: str) -> list[Path]:
    q = pack.upper()
    return [OUTCROP_HOME / "models" / q, OUTCROP_HOME / "models" / f"{q}-q8dense",
            OUTCROP_HOME / "models" / f"{q}-q8dense.tmp", OUTCROP_HOME / "data" / "packs" / pack]


def pack_ready(pack: str) -> bool:
    """Downloaded, checked and prepared (setup/download-models.sh, then setup/prep-packs.sh)."""
    q = pack.upper()
    return ((OUTCROP_HOME / "models" / q / f"Qwen3.8-Flash-Next-GSQ-RCO-{q}-00001-of-00002.gguf.ok").is_file()
            and (OUTCROP_HOME / "data" / "packs" / pack / "native_experts.txt").is_file())


def boot_preset(cfg: dict) -> str | None:
    """The preset started at boot: the state file (as outcrop_control.default_preset), else the profile's default."""
    presets = cfg.get("presets") or {}
    try:
        v = (STATE / "default_preset").read_text(encoding="utf-8").strip()
        if v in presets:
            return v
    except OSError:
        pass
    d = (cfg.get("profile") or {}).get("default_preset")
    return d if d in presets else next(iter(presets), None)


def profile_packs(cfg: dict) -> list[str]:
    """The packs of the profile presets.json was made from (as setup/install.sh and docker/models.sh read them), else
    the packs its presets use."""
    try:
        return list(compose(cfg["profile"]["name"])["profile"]["packs"])
    except (KeyError, ValueError, TypeError):
        return sorted({p["pack"] for p in (cfg.get("presets") or {}).values() if p.get("pack")})


def wanted_packs(cfg: dict) -> list[str]:
    """The packs this machine keeps on disk: every pack of its profile, or with the setting "Models to keep" at boot,
    only the boot preset's."""
    packs = profile_packs(cfg)
    if ((cfg.get("settings") or {}).get("packs")) == "boot":
        b = boot_preset(cfg)
        pack = ((cfg.get("presets") or {}).get(b) or {}).get("pack")
        return [pack] if pack else packs[:1]
    return packs


def disk_need_gb(cfg: dict, packs: list[str] | None = None) -> int:
    """The disk the packs take (all of the profile's, by default), with what every install needs."""
    try:
        q8 = compose(cfg["profile"]["name"]).get("common", {}).get("q8_dense", True)
    except (KeyError, ValueError, TypeError):
        q8 = True
    sizes = PACK_GB if q8 else PACK_GB_NO_Q8
    return BASE_GB + sum(sizes.get(p, 100) for p in (profile_packs(cfg) if packs is None else packs))


def disk_free_gb() -> int:
    """Free space where the models go, in GiB: the unit PACK_GB's sizes come out in (du on a StartOS server, 2026-11-24:
    Q2_0 77, IQ3_XXS 94, IQ3_S 109 with their Q8 copies; the shared files 35)."""
    d = OUTCROP_HOME
    while not d.exists() and d != d.parent:
        d = d.parent
    return shutil.disk_usage(d).free // 2**30


def _on_disk_gb(packs: list[str]) -> int:
    """What the packs already downloaded take, of `packs`: room the downloads will not need again."""
    total = 0
    for pack in packs:
        for p in pack_paths(pack):
            if p.is_dir():
                for f in p.rglob("*"):
                    if f.is_file() and not f.is_symlink():
                        total += f.stat().st_size
    return total // 2**30


# ------------------------------------------------------------------------------------------------- hardware changes

def _ram_low(name: str) -> int:
    return (compose(name)["profile"].get("match", {}).get("ram_gib") or [0])[0]


def hardware(cfg: dict | None = None, f: dict | None = None) -> dict:
    """The profile presets.json came from against the one that fits this machine now.

    change: "none" (it still fits), "more" (more RAM: a bigger profile fits), "less" (less RAM: its presets may no
    longer fit), "other" (another GPU), or "unknown" (no profile fits, or no presets.json yet).  `message` says it in
    words, for the console's alert and StartOS's task; `download_gb` is what taking the profile that fits downloads."""
    cfg = current() if cfg is None else cfg
    f = f or facts()
    cur = ((cfg or {}).get("profile") or {}).get("name")
    fits, kind, why = suggest(f)
    out = {"profile": cur, "fits": fits, "ram_gib": f.get("ram_gib"), "change": "none", "message": "", "download_gb": 0,
           "new_packs": []}
    if not cur or not fits:
        out["change"] = "unknown"
        out["message"] = "; ".join(why[:3]) if not fits else ""
        return out
    try:
        still = fit(compose(cur), f)[0]
    except (KeyError, ValueError):
        still = None                                  # a profile this version no longer has
    if fits == cur or still:
        return out
    try:
        gpu_same = bool(matched_gpu(compose(cur), f))
        lower = _ram_low(fits) < _ram_low(cur)
    except (KeyError, ValueError):
        gpu_same, lower = True, False
    out["change"] = "other" if not gpu_same else "less" if lower else "more"
    newp = compose(fits)["profile"]
    keep = wanted_packs({**(cfg or {}), "profile": {"name": fits}, "presets": compose(fits).get("presets", {})})
    out["new_packs"] = [p for p in keep if not pack_ready(p)]
    out["download_gb"] = disk_need_gb({"profile": {"name": fits}}, out["new_packs"]) - BASE_GB if out["new_packs"] else 0
    title = newp.get("title", fits)
    if out["change"] == "less":
        out["message"] = (f"This server now has {f['ram_gib']} GiB of RAM, less than profile {cur} is for: profile "
                          f"{fits} ({title}) fits it, and its presets fit in this RAM.")
    elif out["change"] == "more":
        dl = f" It downloads {out['download_gb']} GB ({', '.join(out['new_packs'])})." if out["new_packs"] else ""
        out["message"] = (f"This server now has {f['ram_gib']} GiB of RAM: hardware profile {fits} ({title}) fits it, "
                          f"with presets {', '.join(compose(fits).get('presets', {}))}. Outcrop keeps {cur} until you "
                          f"apply it.{dl}")
    else:
        out["message"] = (f"This server's GPU is not the one profile {cur} was made for: {fits} ({title}) fits it. "
                          f"Outcrop keeps {cur} until you apply it.")
    return out


def change_to(name: str) -> dict:
    """Apply profile `name` because the hardware changed: presets.json (keeping the settings and the network sections,
    as apply), and a boot preset the new profile has.  Returns what changed, for the message."""
    before = current() or {}
    old_boot = boot_preset(before) if before else None
    apply(name)
    cfg = current() or {}
    boot = old_boot if old_boot in (cfg.get("presets") or {}) else (cfg.get("profile") or {}).get("default_preset")
    if boot and boot != old_boot:
        STATE.mkdir(parents=True, exist_ok=True)
        tmp = STATE / "default_preset.tmp"
        tmp.write_text(boot + "\n", encoding="utf-8")
        tmp.replace(STATE / "default_preset")
    gone = [p for p in (before.get("presets") or {}) if p not in (cfg.get("presets") or {})]
    return {"from": (before.get("profile") or {}).get("name"), "to": name, "boot_from": old_boot, "boot": boot,
            "presets_gone": gone}


def follow(f: dict | None = None) -> dict:
    """At every start, before a preset runs: hardware(), and when the RAM went down, the move to the profile that fits
    (it needs no new downloads, and a profile made for more RAM can promise more than fits, such as the conversation
    cache of the 128 GB profile or its million-token presets).  More RAM or another GPU is only reported: taking it can
    download a pack, so the user chooses.  The move is recorded in $OUTCROP_HOME/state/hardware.json.  StartOS runs this
    before every start (docker/profile.py follow); on Ubuntu the boot runs only a root-owned script, never this code,
    so there the console's alert asks for `outcrop profile apply`."""
    f = f or facts()
    h = hardware(None, f)
    if h["change"] != "less":
        return h
    moved = change_to(h["fits"])
    rec = {**moved, "ram_gib": f.get("ram_gib"), "at": dt.datetime.now().isoformat(timespec="seconds")}
    STATE.mkdir(parents=True, exist_ok=True)
    HARDWARE_FILE.write_text(json.dumps(rec, indent=1) + "\n", encoding="utf-8")
    words = f"; the boot preset is now {moved['boot']}" if moved["boot"] != moved["boot_from"] else ""
    gone = f" Presets no longer offered: {', '.join(moved['presets_gone'])}." if moved["presets_gone"] else ""
    h["moved"] = rec
    h["message"] = (f"This server now has {f.get('ram_gib')} GiB of RAM, less than profile {moved['from']} is for: Outcrop "
                    f"moved to {moved['to']} ({compose(moved['to'])['profile'].get('title', '')}){words}.{gone} Your "
                    "settings were kept; the old presets.json was kept beside it.")
    return h


def last_move() -> dict | None:
    """The last move follow() made (state/hardware.json), or None."""
    try:
        return json.loads(HARDWARE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def first_packs(cfg: dict) -> str | None:
    """At the first start, after the profile is applied: when the disk cannot hold every pack of the profile, keep only
    the boot preset's (the setting "Models to keep").  Returns a message when it chose that, else None."""
    if (cfg.get("settings") or {}).get("packs"):
        return None
    free = disk_free_gb() + _on_disk_gb(profile_packs(cfg))
    # 10% to spare: the estimates are measured sizes, and the logs, the database and the conversations grow beside them
    need = round(disk_need_gb(cfg) * 1.1)
    if free >= need:
        return None
    b = boot_preset(cfg)
    pack = ((cfg.get("presets") or {}).get(b) or {}).get("pack")
    one = disk_need_gb(cfg, [pack] if pack else [])
    cfg["settings"] = {**(cfg.get("settings") or {}), "packs": "boot"}
    with open(PRESETS_FILE, "a+", encoding="utf-8") as fh:
        fh.seek(0)
        fh.truncate()
        fh.write(json.dumps(cfg, indent=2) + "\n")
    tail = "" if free >= one else f" Even that needs about {one} GB: free some space, or use a bigger disk."
    msg = (f"The disk has about {free} GB free; every model pack of profile {cfg['profile']['name']} needs about {need}. "
           f"Outcrop keeps only the boot preset's pack ({pack}, about {one} GB with what every install needs), so only "
           f"{b} runs. To run another preset, make it the boot preset: its pack replaces this one.{tail}")
    STATE.mkdir(parents=True, exist_ok=True)
    PACKS_NOTICE.write_text(msg + "\n", encoding="utf-8")
    return msg


def take_packs_notice() -> str | None:
    """first_packs()'s message, once: StartOS's start shows it in a notification (presets.json is often made before,
    by the install's password step, which runs docker/prepare.sh)."""
    try:
        msg = PACKS_NOTICE.read_text(encoding="utf-8").strip()
        PACKS_NOTICE.unlink()
        return msg or None
    except OSError:
        return None


def remove_unwanted(cfg: dict, running: str | None = None) -> list[str]:
    """With "Models to keep" at the boot preset's only: delete the files of the profile's other packs, so a small disk
    holds one pack at a time.  Never the running preset's pack, nor the shared files.  Returns the packs removed."""
    if ((cfg.get("settings") or {}).get("packs")) != "boot":
        return []
    keep = set(wanted_packs(cfg))
    run_pack = ((cfg.get("presets") or {}).get(running) or {}).get("pack") if running else None
    if run_pack:
        keep.add(run_pack)
    gone = []
    for pack in sorted(set(PACK_GB) | set(profile_packs(cfg))):      # a bigger profile's packs too, left from before
        if pack in keep:
            continue
        paths = [p for p in pack_paths(pack) if p.exists() or p.is_symlink()]
        for p in paths:
            shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else p.unlink()
        if paths:
            gone.append(pack)
    return gone


def not_downloaded(cfg: dict, preset: str) -> str | None:
    """Why preset `preset` cannot run because its pack is not on this machine, or None.  Only on a machine that has
    packs at all (a fake engine, or the tests, have none)."""
    pack = ((cfg.get("presets") or {}).get(preset) or {}).get("pack")
    if not pack or pack_ready(pack) or not any(pack_ready(p) for p in PACK_GB):
        return None
    if ((cfg.get("settings") or {}).get("packs")) == "boot":
        return (f"preset {preset} needs the {pack} pack, which is not on this machine: with \"Models to keep\" at the "
                f"boot preset's only, make {preset} the boot preset and restart Outcrop to download it (it replaces the "
                "pack there now)")
    return (f"preset {preset} needs the {pack} pack, which is not downloaded yet: restarting Outcrop downloads it"
            if os.environ.get("OUTCROP_PLATFORM") == "startos" else
            f"preset {preset} needs the {pack} pack, which is not downloaded yet: ./setup.sh in the Outcrop folder downloads it")
