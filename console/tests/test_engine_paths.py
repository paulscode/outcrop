"""Where lib/strata_presets.py looks for the engine: the Ubuntu paths by default, the StartOS image's when its environment says."""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROBE = """
import json, sys
sys.path.insert(0, sys.argv[1])
import strata_presets as SP
print(json.dumps({"strata": str(SP.STRATA), "engines": str(SP.ENGINE_DIR), "cuda": SP.CUDA_LIB}))
"""
KEYS = ("OUTCROP_STRATA", "OUTCROP_ENGINE_DIR", "OUTCROP_CUDA_LIB")


def paths(tmp_path, **env) -> dict:
    e = {k: v for k, v in os.environ.items() if k not in KEYS}
    e.update(OUTCROP_HOME=str(tmp_path), **env)
    r = subprocess.run([sys.executable, "-c", PROBE, str(ROOT / "lib")], env=e, capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def test_ubuntu_defaults(tmp_path):
    assert paths(tmp_path) == {"strata": str(tmp_path / "src" / "Strata"), "engines": str(tmp_path / "bin"),
                               "cuda": "/usr/local/cuda-12.9/lib64"}


def test_image_overrides(tmp_path):
    got = paths(tmp_path, OUTCROP_STRATA="/opt/strata", OUTCROP_ENGINE_DIR="/opt/outcrop-engine/bin",
                OUTCROP_CUDA_LIB="/usr/local/cuda-12.9/targets/x86_64-linux/lib")
    assert got == {"strata": "/opt/strata", "engines": "/opt/outcrop-engine/bin",
                   "cuda": "/usr/local/cuda-12.9/targets/x86_64-linux/lib"}


def test_render_uses_them(tmp_path):
    """A rendered preset runs the engine, the picture encoder and Strata's server from the overridden places."""
    eng = tmp_path / "engines"
    eng.mkdir()
    (eng / "strata-0211").write_text("")
    (eng / "strata-vision").write_text("")
    vision = tmp_path / "home" / "models" / "vision"
    vision.mkdir(parents=True)
    (vision / "mmproj-Qwen3.8-Flash-Next-BF16.gguf").write_text("")
    script = f"""
import json, sys
sys.path.insert(0, {str(ROOT / 'lib')!r})
import profiles, strata_presets as SP
cfg = profiles.compose("m6000-64g")
cfg.pop("profile", None)
path, notes = SP.render("quality", cfg)
print(open(path).read())
"""
    e = {k: v for k, v in os.environ.items() if k not in KEYS}
    e.update(OUTCROP_HOME=str(tmp_path / "home"), OUTCROP_STRATA="/opt/strata", OUTCROP_ENGINE_DIR=str(eng),
             OUTCROP_CUDA_LIB="/opt/cuda/lib")
    r = subprocess.run([sys.executable, "-c", script], env=e, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    run = json.loads(r.stdout)
    assert run["exe"] == str(eng / "strata-0211")
    assert run["cwd"] == "/opt/strata"
    assert run["lib_dirs"] == ["/opt/cuda/lib"]
    assert run["vision"]["exe"] == str(eng / "strata-vision")
    assert run["vision"]["gpu"] is False and "elastic" not in run["vision"]     # the CPU encoder: Strata's own default


def test_render_gb10_keeps_its_gpu_encoder_loaded(tmp_path):
    """The GB10's encoder runs on the GPU and is loaded with the engine (started on demand, it found no memory CUDA counts free)."""
    eng = tmp_path / "engines"
    eng.mkdir()
    for exe in ("strata", "strata-0211", "strata-vision"):
        (eng / exe).write_text("")
    vision = tmp_path / "home" / "models" / "vision"
    vision.mkdir(parents=True)
    (vision / "mmproj-Qwen3.8-Flash-Next-BF16.gguf").write_text("")
    script = f"""
import json, sys
sys.path.insert(0, {str(ROOT / 'lib')!r})
import profiles, strata_presets as SP
cfg = profiles.compose("gb10-128g")
cfg.pop("profile", None)
path, notes = SP.render("quality", cfg)
print(open(path).read())
"""
    e = {k: v for k, v in os.environ.items() if k not in KEYS}
    e.update(OUTCROP_HOME=str(tmp_path / "home"), OUTCROP_STRATA="/opt/strata", OUTCROP_ENGINE_DIR=str(eng),
             OUTCROP_CUDA_LIB="/opt/cuda/lib")
    r = subprocess.run([sys.executable, "-c", script], env=e, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    run = json.loads(r.stdout)
    assert run["vision"]["gpu"] is True
    assert run["vision"]["elastic"] is False


def test_a_preset_on_two_gpus(tmp_path):
    """A preset's "gpu" goes to Strata's config (two cards: its layer split) and replaces the profile's one-card pin;
    anything but a short list of card numbers is refused."""
    eng = tmp_path / "engines"
    eng.mkdir()
    (eng / "strata-0211").write_text("")
    script = f"""
import json, sys
sys.path.insert(0, {str(ROOT / 'lib')!r})
import profiles, strata_presets as SP
cfg = profiles.compose("m6000-64g")
cfg.pop("profile", None)
cfg.setdefault("common", {{}}).setdefault("env", {{}})["CUDA_VISIBLE_DEVICES"] = "GPU-1234"   # as profiles.render pins it
cfg["presets"]["two"] = dict(cfg["presets"]["quality"], gpu=[0, 1])
out = {{"two": json.load(open(SP.render("two", cfg)[0])), "one": json.load(open(SP.render("quality", cfg)[0]))}}
bad = []
for g in ("0,1", [0, 0], [0, 9], [True], [], [0, 1, 2, 3, 4]):
    cfg["presets"]["bad"] = dict(cfg["presets"]["quality"], gpu=g)
    bad.append(bool(SP.unsafe(cfg, "bad")))
out["bad"] = bad
print(json.dumps(out))
"""
    e = {k: v for k, v in os.environ.items() if k not in KEYS}
    e.update(OUTCROP_HOME=str(tmp_path / "home"), OUTCROP_STRATA="/opt/strata", OUTCROP_ENGINE_DIR=str(eng),
             OUTCROP_CUDA_LIB="/opt/cuda/lib")
    r = subprocess.run([sys.executable, "-c", script], env=e, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["two"]["gpu"] == [0, 1] and "CUDA_VISIBLE_DEVICES" not in out["two"].get("env", {})
    assert "gpu" not in out["one"] and out["one"]["env"]["CUDA_VISIBLE_DEVICES"] == "GPU-1234"
    assert all(out["bad"])
