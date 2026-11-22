"""docker/health.py: StartOS's health checks for the models and the engine, read from the supervisor."""
import importlib.util
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "lib"))
import supervisor as S  # noqa: E402

spec = importlib.util.spec_from_file_location("health", ROOT / "docker" / "health.py")
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)
PY = sys.executable


def until(cond, timeout=15.0):
    end = time.time() + timeout
    while time.time() < end:
        v = cond()
        if v:
            return v
        time.sleep(0.05)
    raise AssertionError("timed out")


def test_models_and_engine_checks(tmp_path, monkeypatch):
    go = tmp_path / "go"
    script = ("import pathlib, time, sys\n"
              "print('== fetching Qwen3.8-Flash-Next-GSQ-RCO-Q2_0-00001-of-00002.gguf', flush=True)\n"
              f"while not pathlib.Path({str(go)!r}).exists(): time.sleep(0.05)\n"
              "print('PREP_DONE q2_0', flush=True)\n"
              "print('== models ready', flush=True)\n")
    sup = S.Supervisor({"outcrop-models.service": S.Spec([PY, "-c", script], type="oneshot", remain_after_exit=True),
                        "outcrop-engine@.service": S.Spec([PY, "-c", "import time; time.sleep(60)"])},
                       tmp_path / "home" / "logs" / "units")
    srv = sup.serve(tmp_path / "run" / "supervisor.sock")
    monkeypatch.setenv("OUTCROP_PLATFORM", "startos")
    monkeypatch.setenv("OUTCROP_SUPERVISOR_SOCK", str(tmp_path / "run" / "supervisor.sock"))
    monkeypatch.setenv("OUTCROP_HOME", str(tmp_path / "home"))
    try:
        assert health.models() == {"result": "loading", "message": "Waiting to download the models"}
        assert health.engine()["message"] == "Waiting for the models"
        sup.start("outcrop-models.service", block=False)
        r = until(lambda: (lambda a: a if "fetching" in a["message"] else None)(health.models()))
        assert r["result"] == "loading" and r["message"].endswith("fetching Qwen3.8-Flash-Next-GSQ-RCO-Q2_0-00001-of-00002.gguf")
        go.write_text("")
        assert until(lambda: health.models()["result"] == "success")
        assert health.engine() == {"result": "failure", "message": "No preset is running (choose one in the console)"}
    finally:
        srv.shutdown()
        sup.shutdown()
