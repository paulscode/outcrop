"""The GB10 (DGX Spark class) profile: found by its unified memory and ARM CPU, never taken for a Maxwell card, and run
with Strata's Spark settings (the experts read in place; no Q8 copy)."""
import json
import os
import subprocess
import sys
from pathlib import Path

import profiles as P

ROOT = Path(__file__).resolve().parents[2]
GB10 = {"name": "NVIDIA GB10", "vram_mib": 0, "memory": "unified", "pcie": "Gen1 x1", "index": "0", "uuid": "GPU-1"}
M6000 = {"name": "Quadro M6000 24GB", "vram_mib": 24576, "memory": "discrete", "pcie": "Gen3 x16", "index": "0", "uuid": "GPU-2"}


def machine(gpu, ram, arch):
    return {"gpus": [gpu], "ram_gib": ram, "cpus": 20, "os": {}, "driver": "580.178.04", "arch": arch}


def test_nvidia_smis_na_memory_means_unified(monkeypatch):
    monkeypatch.setattr(P, "_run", lambda *cmd: "NVIDIA GB10, [N/A], 580.178.04, 1, 1, 0, GPU-1")
    g = P.facts()["gpus"][0]
    assert (g["name"], g["vram_mib"], g["memory"]) == ("NVIDIA GB10", 0, "unified")
    monkeypatch.setattr(P, "_run", lambda *cmd: "Quadro M6000 24GB, 24576, 580.95, 3, 16, 0, GPU-2")
    assert P.facts()["gpus"][0]["memory"] == "discrete"


def test_each_machine_gets_its_own_profile():
    assert P.suggest(machine(GB10, 121, "aarch64"))[:2] == ("gb10-128g", "exact")
    assert P.suggest(machine(M6000, 31, "x86_64"))[:2] == ("m6000-32g", "exact")
    # a GB10 profile never on x86, nor on a card with its own memory; a Maxwell profile never on unified memory
    kind, why = P.fit(P.compose("gb10-128g"), machine(GB10, 121, "x86_64"))
    assert kind is None and "aarch64" in why[0]
    kind, why = P.fit(P.compose("gb10-128g"), machine({**GB10, "memory": "discrete", "vram_mib": 98304}, 121, "aarch64"))
    assert kind is None and "unified" in why[0]
    assert P.fit(P.compose("m6000-128g"), machine({**M6000, "memory": "unified", "vram_mib": 0}, 121, "x86_64"))[0] is None


def test_no_q8_copy_in_the_disk_estimate():
    gb10 = P.compose("gb10-128g")
    assert gb10["common"]["q8_dense"] is False
    assert P.disk_gb(gb10) == P.BASE_GB + P.PACK_GB_NO_Q8["iq3_s"]
    assert P.disk_gb(P.compose("m6000-128g")) == P.BASE_GB + sum(P.PACK_GB[p] for p in ("q2_0", "iq3_xxs", "iq3_s"))


RENDER = """
import json, sys
sys.path.insert(0, sys.argv[1])
import profiles, strata_presets as SP
cfg = profiles.compose(sys.argv[2])
cfg.pop("profile", None)
path, notes = SP.render("quality", cfg)
print(open(path).read())
"""


def render(tmp_path, name, **env):
    e = {k: v for k, v in os.environ.items() if not k.startswith("OUTCROP_")}
    e.update(OUTCROP_HOME=str(tmp_path), OUTCROP_PROFILES=str(ROOT / "profiles"), **env)
    r = subprocess.run([sys.executable, "-c", RENDER, str(ROOT / "lib"), name], env=e, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_the_engine_runs_with_the_spark_settings(tmp_path):
    run = render(tmp_path, "gb10-128g", OUTCROP_PLATFORM="startos")
    a = run["args"]
    assert run["exe"].endswith("/strata") and run["cuda"] == 13
    assert "--mmap-experts" in a and "--resident-experts" not in a and "--resident-budget-gib" not in a
    assert "--memory-limit-mib" in a                              # StartOS's line, for the engine's own guard
    assert a[a.index("--prefill") + 1] == "auto:32768"
    assert a[a.index("--mtp-q4") + 1] == "all" and a[a.index("--mtp-hnorm") + 1] == "stream"
    assert "--ple-io" not in a                                    # the n-gram table stays on the SSD
    assert "/models/IQ3_S/" in a[a.index("--native") + 1]         # the pack as downloaded, not a Q8 copy
    assert not any(k.startswith("STRATA_Q8") for k in run.get("env", {}))
    # off StartOS, no line to keep below
    assert "--memory-limit-mib" not in render(tmp_path, "gb10-128g")["args"]


def test_maxwell_presets_unchanged(tmp_path):
    a = render(tmp_path, "m6000-256g")["args"]
    assert "--mmap-experts" not in a and "-q8dense/" in a[a.index("--native") + 1]
