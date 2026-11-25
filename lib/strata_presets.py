"""Presets for the Strata server on this machine: load presets.json and render a preset into a Strata run config.

A preset names a model pack and the settings tuned for it (context, KV cache, drafting, engine switches).  `render()` turns it
into the JSON config that Strata's serve/server.py reads (`--config`), at $OUTCROP_HOME/cfg/<preset>.json.

Paths: $OUTCROP_HOME (default ~/.outcrop) holds presets.json (made from a hardware profile in profiles/), sources, models,
packs, configs and logs.
"""
import json
import os
import re
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
OUTCROP_HOME = Path(os.environ.get("OUTCROP_HOME") or Path.home() / ".outcrop")
PRESETS_FILE = Path(os.environ.get("OUTCROP_PRESETS") or OUTCROP_HOME / "presets.json")
# Where the engine lives: setup/install.sh builds it under $OUTCROP_HOME; the StartOS image keeps it under /opt and says so in
# its environment (Dockerfile).  Unset, these are the Ubuntu paths.
STRATA = Path(os.environ.get("OUTCROP_STRATA") or OUTCROP_HOME / "src" / "Strata")
ENGINE_DIR = Path(os.environ.get("OUTCROP_ENGINE_DIR") or OUTCROP_HOME / "bin")
CUDA_LIB = os.environ.get("OUTCROP_CUDA_LIB") or "/usr/local/cuda-12.9/lib64"

# The GSQ-RCO pack files.  Shard 1 holds the model; shard 2 is the 28.8 GB n-gram table every pack shares.
SHARD = "Qwen3.8-Flash-Next-GSQ-RCO-{Q}-{n:05d}-of-00002.gguf"
# Free RAM (GiB) the engine needs to pin every routed expert in RAM ("full" arena); below it the engine keeps the most used experts
# in RAM and reads the rest from the model file ("resident").  From the M6000 exploration's 64 GB measurements, with margin.
FULL_ARENA_GIB = {"q2_0": 42, "iq2_xs": 44, "iq3_xxs": 50, "iq3_s": 57}
# The attention cache in pinned RAM per million tokens of context (Strata keeps all of it there, and the part
# --kv-resident names in VRAM too): 12.38 GiB at int8, from the engine's log for a 1M-token preset (2026-11-25).
KV_GIB_PER_MTOKEN = {"int8": 12.4}
# The fewest GiB of experts in RAM a preset is started with (the low-RAM budget's own floor is 4)
MIN_EXPERTS_GIB = 4


def load() -> dict:
    try:
        with open(PRESETS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise SystemExit(f"no {PRESETS_FILE} yet: run ./setup.sh in the Outcrop folder, or `outcrop profile apply NAME` "
                         "(`outcrop profile detect` suggests one)") from None


STATE = Path(os.environ.get("OUTCROP_STATE") or OUTCROP_HOME / "state")     # as console/outcrop/common/config.py
BYPASS_FILE = STATE / "bypass.json"
UPSTREAM_KEY_FILE = STATE / "upstream_key"


def bypass() -> dict | None:
    """`outcrop gateway bypass` in force: Strata itself serves the LAN, with the emergency keys in this file."""
    try:
        b = json.loads(BYPASS_FILE.read_text(encoding="utf-8"))
        return b if isinstance(b, dict) and b.get("keys") else None
    except (OSError, ValueError):
        return None


def gateway_mode(cfg: dict) -> bool:
    """The API gateway (outcrop-gateway) answers the LAN, and Strata listens on loopback behind it."""
    return bool(cfg.get("gateway", {}).get("enabled")) and bypass() is None


def upstream_key() -> str:
    """The internal key Strata requires behind the gateway; only the gateway and the console send it."""
    try:
        k = UPSTREAM_KEY_FILE.read_text(encoding="utf-8").strip()
        if k:
            return k
    except OSError:
        pass
    import secrets
    STATE.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE, 0o700)
    k = "strata-internal-" + secrets.token_urlsafe(32)
    fd = os.open(UPSTREAM_KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(k + "\n")
    return k


def bind(cfg: dict) -> tuple[str, int]:
    """Where Strata listens: loopback behind the gateway, or the LAN address and port 8080 without it (or in a bypass)."""
    s, g = cfg.get("server", {}), cfg.get("gateway", {})
    if s.get("private"):                 # bench/ab.py's own server on a private port
        return str(s.get("host", "127.0.0.1")), int(s.get("port", 8095))
    if bypass() is not None:
        return str(g.get("bypass_listen", "0.0.0.0")), int(g.get("port", 8080))
    return str(s.get("host", "0.0.0.0")), int(s.get("port", 8080))


def api_key(cfg: dict):
    """The key(s) Strata requires.  Behind the gateway: the internal key.  In a bypass: the emergency keys.  Without the
    gateway: $OUTCROP_HOME/state/api_key if that file exists (keeps the secret out of the git repo), else presets.json's
    server.api_key; "none" means no key is required."""
    if cfg.get("server", {}).get("private"):
        return cfg["server"].get("api_key") or "none"
    b = bypass()
    if b is not None:
        return [str(k) for k in b["keys"]]
    if gateway_mode(cfg):
        return [upstream_key()]
    f = STATE / "api_key"
    try:
        k = f.read_text(encoding="utf-8").strip()
        if k:
            return k
    except OSError:
        pass
    return cfg.get("server", {}).get("api_key") or "none"


def names(cfg: dict | None = None) -> list[str]:
    return list((cfg or load())["presets"])


MEMINFO = "/proc/meminfo"


def meminfo_kib(path: str | None = None) -> dict[str, int]:
    out = {}
    for line in open(path or MEMINFO):
        k, _, v = line.partition(":")
        if v.strip():
            out[k] = int(v.split()[0])
    return out


def startos_memory_high_kib(total_kib: int) -> int:
    """Where StartOS starts reclaiming its services' memory: all of them share one cgroup (services.slice) with
    MemoryMax = RAM - 1 GiB and MemoryHigh = 90% of that (start-core's system::limit_container_memory, StartOS 0.4.2).
    The limit sits above the container, so the container cannot read it; it is computed from the same formula."""
    max_kib = max(total_kib - (1 << 20), 512 << 10)
    return max_kib - max_kib // 10


def mem_available_gib(path: str | None = None) -> int:
    """The RAM the engine can still take, in GiB.  On StartOS no more than up to the services' reclaim line, counting
    everything in use as the services' (a little cautious: the host's own share is in it too)."""
    mi = meminfo_kib(path)
    avail = mi.get("MemAvailable", 0)
    if os.environ.get("OUTCROP_PLATFORM") == "startos":
        used = mi.get("MemTotal", 0) - avail
        avail = min(avail, max(0, startos_memory_high_kib(mi.get("MemTotal", 0)) - used))
    return avail // (1 << 20)


# What the engine needs in RAM beside its experts on StartOS, in GiB.  Measured on a 32 GB StartOS server (lab log,
# 2026-11-22), where 25 GiB were free below StartOS's line: with 15 and 18 GiB of experts kept in RAM the engine started
# and ran; with 19, 22 and the engine's own sizing it went past the line while loading and stalled for good.  The
# conversation cache did not change that (it is empty at start, and the engine's RAM guard keeps it within
# --memory-limit-mib later), so it is not counted.  8 GiB leaves 16 on that server: two below the most that worked.
STARTOS_VISION_GIB = 1
STARTOS_RESERVE_GIB = 8


def startos_budget(p: dict, top: dict, free: int) -> tuple[int, int]:
    """(GiB of experts to keep in RAM, the cgroup limit in MiB for the engine's memory guard) on StartOS.

    In low-RAM mode the engine sizes its RAM copy of the experts from MemAvailable, which in the StartOS container is the
    host's and knows nothing of the line StartOS reclaims its services' memory from (startos_memory_high_kib): past that
    line every process in the service is throttled, the engine's start stalls and the service cannot even stop.  An
    explicit --resident-budget-gib keeps it below: what Outcrop may take, less the vision encoder and a reserve."""
    vision = STARTOS_VISION_GIB if p.get("vision", top.get("vision", "cpu")) != "off" else 0
    budget = max(4, free - vision - STARTOS_RESERVE_GIB)
    if p.get("resident_budget_gib") is not None:          # a preset's own choice (measured), never above what fits
        budget = max(1, min(int(p["resident_budget_gib"]), budget))
    limit_mib = startos_memory_high_kib(meminfo_kib().get("MemTotal", 0)) // 1024
    return budget, limit_mib


# Settings: a few choices that apply to every preset, kept in presets.json's "settings" section (applying a profile keeps
# it).  Changed with `outcrop setting`, the console's Settings page or StartOS's Configure, which all show `about`: what a
# setting trades, in plain words.  The values are strings, so all three places can offer them as a list of choices.
SETTINGS = {
    "exact_answers": {
        "title": "Exact answers",
        "values": {"off": "Off: faster (recommended)", "on": "On: slower, every answer computed in full"},
        "default": "off",
        "about": "To save time, the engine leaves out the smallest contributions to each word when they would have to be "
                 "fetched from RAM or the disk. In our tests this changed how answers were worded, more often than not, "
                 "but not how many were right. On computes every word in full, exactly as the model would, and answers "
                 "come more slowly when the machine reads from its disk: measured 3 to 6% slower with 32 GB of RAM, and "
                 "about 1% with plenty of RAM.",
    },
    "context": {
        "title": "Longest conversation",
        "values": {"profile": "As the hardware profile sets it (recommended)",
                   "131072": "131,072 tokens (about 100,000 words)",
                   "262144": "262,144 tokens (about 200,000 words)"},
        "default": "profile",
        "about": "How much one conversation can hold: the chat so far, or a document and the questions about it. "
                 "The memory for it is set aside in advance, so a shorter limit leaves more RAM for the model itself, which makes a machine with little RAM faster: with 32 GB, 131,072 tokens made the "
                 "balanced preset 3 to 5% faster. The presets for a million tokens keep their own length.",
    },
    "packs": {
        "title": "Models to keep",
        "values": {"all": "Every pack the hardware profile offers (recommended)",
                   "boot": "Only the boot preset's: less disk, one preset at a time"},
        "default": "all",
        "about": "Each preset runs a model pack of 80 to 110 GB. Keeping every pack the hardware profile offers lets you "
                 "switch between its presets in a minute or two. Keeping only the boot preset's pack fits a smaller disk "
                 "(about 120 GB for the speed preset): only that preset runs, and choosing another boot preset downloads "
                 "its pack at the next start and deletes the old one. Outcrop chooses this by itself when the disk is "
                 "too small for every pack.",
    },
}


def settings(cfg: dict) -> dict[str, str]:
    """This machine's settings, each at its default when unset (or set to a value it does not offer)."""
    s = cfg.get("settings") or {}
    return {k: (str(s[k]) if str(s.get(k)) in d["values"] else d["default"]) for k, d in SETTINGS.items()}


def with_settings(p: dict, s: dict[str, str]) -> dict:
    """Preset `p` as the settings `s` change it (a copy)."""
    p = {**p, "env": dict(p.get("env") or {})}
    if s.get("exact_answers") == "on":
        p["env"]["STRATA_ROUTE_TAIL_SKIP"] = "0"     # upstream's route tail skip off (drops misses at rank 7 and beyond)
    if s.get("context", "profile") != "profile" and not p.get("rope"):   # not the 1M presets, which stretch the model's own
        p["context"] = int(s["context"])
    return p


def set_setting(key: str, value: str) -> dict[str, str]:
    """Change one setting in presets.json; returns the settings now.  Raises KeyError or ValueError for a setting or a
    value that does not exist."""
    key = key.replace("-", "_")
    if key not in SETTINGS:
        raise KeyError(f"there is no setting {key!r}: {', '.join(SETTINGS)}")
    value = str(value).replace(",", "").lower()
    if value not in SETTINGS[key]["values"]:
        raise ValueError(f"{key} is one of: {', '.join(SETTINGS[key]['values'])}")
    cfg = load()
    cfg["settings"] = {**(cfg.get("settings") or {}), key: value}
    # in place, as profiles.apply writes it: the console's sandbox sees this file through a bind mount of the file itself
    with open(PRESETS_FILE, "a+", encoding="utf-8") as f:
        f.seek(0)
        f.truncate()
        f.write(json.dumps(cfg, indent=2) + "\n")
    return settings(cfg)


def effective(cfg: dict) -> dict:
    """presets.json with the settings applied to every preset: what the engine runs (and what the console shows)."""
    s = settings(cfg)
    return {**cfg, "presets": {n: with_settings(p, s) for n, p in (cfg.get("presets") or {}).items()}}


def expand(x: str) -> str:
    return x.replace("{outcrop_home}", str(OUTCROP_HOME)).replace("{strata}", str(STRATA))


def engine_args(p: dict, top: dict, strict: bool = True) -> tuple[list[str], dict, list[str]]:
    """The engine's command line, environment and notes for preset `p`.  `strict` (a start): a preset whose conversation
    slots leave too little RAM is refused; not strict (the console's editor, while the engine holds RAM of its own),
    that is a note."""
    pack = p["pack"]
    Q = pack.upper()
    q8 = p.get("q8_dense", top.get("q8_dense", True))
    mdir = OUTCROP_HOME / "models" / (f"{Q}-q8dense" if q8 else Q)
    ctx = int(p["context"])
    notes = []
    args = ["--pack", str(OUTCROP_HOME / "data" / "packs" / pack),
            "--native", str(mdir / SHARD.format(Q=Q, n=1)),
            "--ple-gguf", str(mdir / SHARD.format(Q=Q, n=2)),
            "--expert-profile", str(STRATA / "data" / "expert-profile.bin"),
            "--expert-cache", str(p.get("expert_cache", "auto")),
            "--prefill", str(p.get("prefill", "auto")),
            "--max-context", str(ctx)]
    if p.get("mtp", True):
        args += ["--spec", str(p.get("spec", 4)), "--spec-min-p", str(p.get("spec_min_p", 0.5)),
                 "--mtp", str(OUTCROP_HOME / "data" / "mtp" / "rt")]
        if p.get("draft_vocab", "en") != "all":
            args += ["--mtp-draft-vocab", str(STRATA / "data" / f"draft_vocab_{p.get('draft_vocab', 'en')}.bin")]
    if ctx > 8192:
        args += ["--kv", p.get("kv", "int8")]
    kvr = p.get("kv_resident", 32768 if ctx >= 65536 else None)
    if kvr:
        args += ["--kv-resident", str(kvr)]
    rope = p.get("rope")
    if rope:
        args += ["--rope-scaling", rope["scaling"], "--rope-scale", str(rope["scale"])]
    # RAM mode: every expert pinned in RAM when there is room, else the most used ones (the engine reads the rest from the file).
    # A GPU with unified memory ("mmap", the GB10) does neither: its cache and the RAM are the same memory, so the experts
    # are read from the model file in place and the cache holds them all (Strata's measured setting on that part).
    need = FULL_ARENA_GIB.get(pack, 60)
    free = mem_available_gib()
    # Several conversations at once ("parallel": Strata's --batch): each slot keeps its whole attention cache in pinned
    # RAM, the first one inside the reserve below, the others beside the experts.  Counted here before the RAM mode is
    # chosen: on StartOS the experts' budget shrinks to fit; on Ubuntu the engine sizes its RAM copy itself, so only the
    # mode follows.  Refused, on both, when what is left is too little to start (4 slots of 262K tokens on 32 GB stalled
    # a StartOS server for good, 2026-11-25).
    try:
        slots = int(p.get("parallel") or 1)
    except (TypeError, ValueError):
        raise ValueError(f"parallel must be a whole number, not {p.get('parallel')!r}") from None
    if slots > 1 and ctx > 8192:
        per_slot = ctx * KV_GIB_PER_MTOKEN.get(p.get("kv", "int8"), 2 * KV_GIB_PER_MTOKEN["int8"]) / (1 << 20)
        extra = (slots - 1) * per_slot
        if free - extra < MIN_EXPERTS_GIB + STARTOS_RESERVE_GIB:
            msg = (f"{slots} conversations of {ctx:,} tokens need about {slots * per_slot:.0f} GiB of RAM for their "
                   f"attention caches, and {free} GiB is available: too little left for the model. Use fewer "
                   f"(\"parallel\") or a shorter context (32,768 tokens takes about "
                   f"{32768 * KV_GIB_PER_MTOKEN['int8'] / (1 << 20):.1f} GiB a conversation)")
            if strict:
                raise ValueError(msg)
            notes.append(msg + " - counted again when it starts, with the RAM free then")
        free -= round(extra)
        notes.append(f"{slots} conversations at once: {extra:.1f} GiB of RAM kept for the others' attention caches")
    mode = p.get("ram_mode", top.get("ram_mode", "auto"))
    if mode == "mmap":
        args += ["--mmap-experts"]
        if os.environ.get("OUTCROP_PLATFORM") == "startos":
            # the file's pages count against StartOS's line like any other memory: the engine's guard keeps what it
            # adds on its own (the conversation cache) below it
            args += ["--memory-limit-mib", str(startos_memory_high_kib(meminfo_kib().get("MemTotal", 0)) // 1024)]
        resident = False
    elif mode == "resident" or (mode == "auto" and free < need):
        if os.environ.get("OUTCROP_PLATFORM") == "startos":
            budget, limit_mib = startos_budget(p, top, free)
            args += ["--resident-budget-gib", str(budget), "--memory-limit-mib", str(limit_mib)]
            notes.append(f"low-RAM mode: {free} GiB available below StartOS's memory line, {need} GiB needed to pin "
                         f"every expert; {budget} GiB of experts kept in RAM")
        else:
            args += ["--resident-experts"]
            notes.append(f"low-RAM mode: {free} GiB available, {need} GiB needed to pin every expert")
        resident = True
    else:
        resident = False
    env = {**top.get("env", {}), **p.get("env", {})}
    if resident:
        # In low-RAM mode the prompt planner's short chunks cost 13% on a 16K prompt and saved almost no disk reads
        # (measured with 32 GB of RAM). A preset can set it back.
        env = {"STRATA_PREFILL_HOST_PLAN": "0", **env}
    env = {k: v for k, v in env.items() if v is not None and k not in p.get("drop_env", [])}
    for a in top.get("args", []) + p.get("args", []):
        args += [expand(x) for x in (a.split() if isinstance(a, str) else [a])]
    return args, {k: expand(str(v)) for k, v in env.items()}, notes


# What a preset may hand the engine.  Checked here, where the engine's config is made, and not only in the console's
# editor: presets.json is writable from inside the console's sandbox, so a console that was taken over must not be able
# to run a program of its choosing, or load a library into the engine (LD_PRELOAD, CUDA_INJECTION64_PATH ...).
ENGINE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
SAFE_ENV = re.compile(r"(STRATA_[A-Z0-9_]{1,60}|CUDA_VISIBLE_DEVICES|CUDA_DEVICE_ORDER|CUDA_MODULE_LOADING|OMP_NUM_THREADS|"
                      r"OMP_PROC_BIND|OMP_PLACES|OMP_WAIT_POLICY|MKL_NUM_THREADS|OPENBLAS_NUM_THREADS)")
SAFE_ARG = re.compile(r"(--?[a-z0-9][a-z0-9-]{0,48}(=[A-Za-z0-9._:,+-]{0,256})?|[A-Za-z0-9._:,+-]{1,256})")
SAFE_VALUE = re.compile(r"[A-Za-z0-9._:,+=-]{0,256}")       # an environment value: no paths, no spaces


UUID_RE = re.compile(r"GPU-[0-9a-fA-F-]{8,64}")


def gpu_index_by_uuid() -> dict[str, int]:
    """nvidia-smi's number for each card's UUID ({} when nvidia-smi cannot be run)."""
    import subprocess
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=index,uuid", "--format=csv,noheader"], capture_output=True,
                             text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    pairs = [ln.split(", ") for ln in out.splitlines() if ln.count(", ") == 1]
    return {u.strip(): int(i) for i, u in pairs if i.strip().isdigit()}


def card_numbers(common: dict) -> list[int]:
    """The cards a two-card profile runs on, as nvidia-smi numbers them now: from their UUIDs ("gpu_uuids", kept when
    the profile was applied), since a card added in a lower slot renumbers the others; else "gpu" as written.  Raises
    ValueError when one of those cards is not in the machine."""
    uuids, gpus = common.get("gpu_uuids"), common.get("gpu")
    if not uuids:
        return list(gpus or [])
    if gpus is not None and len(gpus) != len(uuids):
        raise ValueError(f"common.gpu names {len(gpus)} card(s) and common.gpu_uuids {len(uuids)}: the UUIDs choose the "
                         "cards (numbers shift); remove gpu_uuids to choose them by number, or give one preset its own "
                         "\"gpu\"")
    now = gpu_index_by_uuid()
    if not now:                                       # nvidia-smi cannot be run (a test, a fake engine): as written
        return list(gpus or [])
    missing = [u for u in uuids if u not in now]
    if missing:
        raise ValueError(f"{len(missing)} of the {len(uuids)} cards this hardware profile runs on are not in this "
                         "machine now: apply the profile that fits (Update hardware settings on StartOS, `outcrop "
                         "profile` on Ubuntu)")
    return [now[u] for u in uuids]


def gpu_problem(g) -> str | None:
    """What is wrong with a "gpu" value (a preset's, or the profile's in "common"), or None: absent, or a list of 1 to 4
    different card numbers as nvidia-smi numbers them."""
    if g is None or (isinstance(g, list) and 1 <= len(g) <= 4 and len(set(g)) == len(g)
                     and all(isinstance(x, int) and not isinstance(x, bool) and 0 <= x <= 7 for x in g)):
        return None
    return "gpu is a list of 1 to 4 different GPU numbers, as nvidia-smi numbers them ([0, 1])"


def unsafe(cfg: dict, name: str) -> list[str]:
    """Why preset `name` must not run (empty: it may).  The rules of the console's editor that guard what the engine runs
    and where it listens (the editor checks more, for helpful messages)."""
    p, top = cfg["presets"][name], cfg.get("common", {})
    why = []
    if p.get("pack") not in FULL_ARENA_GIB:
        why.append(f"pack {p.get('pack')!r} is not one of {', '.join(sorted(FULL_ARENA_GIB))}")
    if not re.fullmatch(r"[a-z0-9_]{1,16}", str(p.get("kv", "int8"))):
        why.append(f"kv {p.get('kv')!r} is not allowed")
    rope = p.get("rope")
    if rope is not None and (not isinstance(rope, dict) or rope.get("scaling") not in ("yarn", "linear")
                             or not isinstance(rope.get("scale"), (int, float))):
        why.append("rope is {\"scaling\": \"yarn\"|\"linear\", \"scale\": a number}")
    server = cfg.get("server") or {}
    if (cfg.get("gateway") or {}).get("enabled"):
        if server.get("private"):
            why.append("server.private is for bench/ab.py's own server, not with the gateway enabled")
        if str(server.get("host", "127.0.0.1")) not in ("127.0.0.1", "::1", "localhost"):
            why.append("with the gateway enabled, Strata must listen on 127.0.0.1 only")
    for k, v in {**top.get("env", {}), **p.get("env", {})}.items():
        if v is not None and not SAFE_VALUE.fullmatch(str(v)):
            why.append(f"the value of {k} is not allowed (letters, digits and . _ : , + = - only)")
    if gpu_problem(p.get("gpu", top.get("gpu"))):
        why.append(gpu_problem(p.get("gpu", top.get("gpu"))))
    u = top.get("gpu_uuids")
    if u is not None and not (isinstance(u, list) and len(u) <= 4 and all(isinstance(x, str) and UUID_RE.fullmatch(x) for x in u)):
        why.append("gpu_uuids is a list of up to 4 card UUIDs, as nvidia-smi prints them (GPU-...)")
    eng = p.get("engine", cfg.get("engine", "strata"))
    if not isinstance(eng, str) or not ENGINE_NAME.fullmatch(eng):
        why.append(f"engine {eng!r} is not a file name in {ENGINE_DIR}")
    for k in {**top.get("env", {}), **p.get("env", {})}:
        if not SAFE_ENV.fullmatch(str(k)):
            why.append(f"the variable {k!r} is not allowed")
    for a in top.get("args", []) + p.get("args", []):
        for tok in (a.split() if isinstance(a, str) else [str(a)]):
            if not SAFE_ARG.fullmatch(tok):
                why.append(f"the engine argument {tok!r} is not allowed")
    return why


def render(name: str, cfg: dict | None = None, strict: bool = True) -> tuple[Path, list[str]]:
    """Write $OUTCROP_HOME/cfg/<name>.json for preset `name`; returns its path and notes for the operator.  `strict`
    as engine_args: a switch's planning step renders while the running engine still holds its RAM, so it is not strict;
    outcrop-serve renders again when the engine starts, with the RAM free then, and is."""
    cfg = cfg or load()
    if name not in cfg["presets"]:
        raise KeyError(f"unknown preset {name!r}: choose one of {', '.join(cfg['presets'])}")
    bad = unsafe(cfg, name)
    if bad:
        raise ValueError(f"preset {name!r} refused: " + "; ".join(bad))
    p = with_settings(cfg["presets"][name], settings(cfg))
    server = cfg.get("server", {})
    args, env, notes = engine_args(p, cfg.get("common", {}), strict=strict)
    changed = [f"{SETTINGS[k]['title'].lower()}: {v}" for k, v in settings(cfg).items() if v != SETTINGS[k]["default"]]
    if changed:
        notes.append("settings: " + ", ".join(changed))
    engine = ENGINE_DIR / p.get("engine", cfg.get("engine", "strata"))
    model_id = server.get("model_id", "qwen3.8-flash-next")
    run = {
        "exe": str(engine), "args": args, "cwd": str(STRATA),
        "tokenizer": str(OUTCROP_HOME / "data" / "packs" / p["pack"] / "tokenizer"),
        "model_name": model_id,
        # every preset answers to the stable id above; the alias says which preset runs (GET /v1/models lists both)
        "aliases": [f"{model_id}:{name}"],
        "arch": "qwen4exp",
        "log": str(OUTCROP_HOME / "logs" / f"engine-{name}.log"),
        "lib_dirs": [CUDA_LIB], "cuda": int(cfg.get("cuda", 12)),
        "host": bind(cfg)[0], "port": bind(cfg)[1],
        "api_key": api_key(cfg),
        "engine_ready_s": 1800,
        "open_browser": False,
    }
    gpus = p.get("gpu") or card_numbers(cfg.get("common", {}))
    if gpus:
        # the cards to run on, numbered as nvidia-smi numbers them: two or more are Strata's layer split
        # (docs/MULTI_GPU.md); Strata sets CUDA_VISIBLE_DEVICES from it, so the profile's one-card pin goes.  A preset's
        # own "gpu" wins over the profile's ("common"), so one preset can run on one card of a two-card machine.
        run["gpu"] = list(gpus)
        env.pop("CUDA_VISIBLE_DEVICES", None)
    if env:
        run["env"] = env
    for k in ("parallel", "sampling", "reasoning_effort", "max_tokens", "allowed_hosts", "cors_origins", "trusted_origins",
              "pool_cores", "threads", "idle_unload_s"):
        v = p.get(k, server.get(k))
        if v is not None:
            run[k] = v
    vision = p.get("vision", cfg.get("common", {}).get("vision", "cpu"))
    mmproj = OUTCROP_HOME / "models" / "vision" / "mmproj-Qwen3.8-Flash-Next-BF16.gguf"
    if vision != "off" and mmproj.exists() and (ENGINE_DIR / "strata-vision").exists():
        run["args"] = run["args"] + ["--vision"]
        v = cfg.get("common", {}).get("vision_cfg", {})
        run["vision"] = {"exe": str(ENGINE_DIR / "strata-vision"), "mmproj": str(mmproj),
                         "model": args[args.index("--native") + 1], "gpu": vision == "gpu",
                         "max_tokens": int(v.get("max_tokens", 300)), "threads": min(int(v.get("threads", 16)), os.cpu_count() or 16)}
        if "elastic" in v:
            # Strata starts a GPU encoder with the first picture by default; false loads it with the engine and keeps it
            run["vision"]["elastic"] = v["elastic"] is True
    elif vision != "off":
        notes.append("pictures off: the vision encoder or its model file is missing")
    out = OUTCROP_HOME / "cfg" / f"{name}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(out.parent, 0o700)
    tmp = out.with_suffix(".tmp")
    # it holds Strata's internal key: readable by its owner only
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(run, indent=2) + "\n")
    os.chmod(tmp, 0o600)
    tmp.replace(out)
    return out, notes


if __name__ == "__main__":
    import sys
    for n in sys.argv[1:] or names():
        path, notes = render(n)
        print(path, *notes, sep="\n  ")
