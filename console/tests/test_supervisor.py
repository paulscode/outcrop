"""lib/supervisor.py: systemd's behaviour for Outcrop's units, in the StartOS container; and lib/units.py talking to it."""
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

LIB = Path(__file__).resolve().parents[2] / "lib"
sys.path.insert(0, str(LIB))
import supervisor as S  # noqa: E402
import units  # noqa: E402

PY = sys.executable


def until(cond, timeout=15.0, step=0.05):
    end = time.time() + timeout
    while time.time() < end:
        v = cond()
        if v:
            return v
        time.sleep(step)
    raise AssertionError("timed out")


def specs(tmp: Path) -> dict:
    return {
        "svc.service": S.Spec([PY, "-c", "import time; print('hello', flush=True); time.sleep(60)"], restart="always",
                              restart_sec=0.2, enabled=True),
        "crash@.service": S.Spec([PY, "-c", "import sys; print('boom %i', flush=True); sys.exit(2)"], restart="on-failure",
                                 restart_sec=0.1, start_limit_interval=30, start_limit_burst=3),
        "stubborn.service": S.Spec([PY, "-c", "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                                    "print('up', flush=True); time.sleep(60)"], stop_timeout=1),
        "once.service": S.Spec([PY, "-c", "print('did it')"], type="oneshot", remain_after_exit=True, enabled=True,
                               after=["svc.service"]),
        "cond.service": S.Spec([PY, "-c", "import time; time.sleep(60)"], condition_not_exists=str(tmp / "flag")),
        "outcrop-engine@.service": S.Spec([PY, "-c", "import time; print('loading the experts into RAM', flush=True); "
                                           "time.sleep(0.3); print('ready: http://127.0.0.1:1', flush=True); time.sleep(60)"],
                                          restart="on-failure", restart_sec=0.1, stop_timeout=5),
    }


@pytest.fixture
def sup(tmp_path):
    s = S.Supervisor(specs(tmp_path), tmp_path / "home" / "logs" / "units", state_file=tmp_path / "supervisor.json")
    yield s
    s.shutdown()


def messages(sup, unit):
    p = sup.journal.path(unit)
    return [ln.split(" ", 2)[2].rstrip("\n") for ln in p.read_text().splitlines()] if p.exists() else []


def test_start_stop_and_properties(sup):
    assert sup.ctl(["start", "svc.service"])["rc"] == 0
    p = sup.show(["svc.service"])["svc.service"]
    assert (p["ActiveState"], p["SubState"], p["Result"]) == ("active", "running", "success")
    assert int(p["MainPID"]) > 0 and p["ActiveEnterTimestamp"]
    until(lambda: "hello" in messages(sup, "svc.service"))
    assert sup.ctl(["is-active", "svc.service"]) == {"rc": 0, "stdout": "active\n", "stderr": ""}
    assert sup.ctl(["stop", "svc.service"])["rc"] == 0
    p = sup.show(["svc.service"])["svc.service"]
    assert (p["ActiveState"], p["SubState"], p["MainPID"]) == ("inactive", "dead", "0")
    m = messages(sup, "svc.service")
    assert "Started svc.service." in m and "Stopping svc.service..." in m and "Stopped svc.service." in m


def test_restart_always_after_a_crash(sup):
    sup.start("svc.service")
    pid = sup.resolve("svc.service").proc.pid
    os.kill(pid, 9)
    until(lambda: sup.show(["svc.service"])["svc.service"]["NRestarts"] == "1"
          and sup.show(["svc.service"])["svc.service"]["ActiveState"] == "active")
    assert sup.resolve("svc.service").proc.pid != pid
    assert any("Main process exited, code=killed, status=9/KILL" in m for m in messages(sup, "svc.service"))


def test_on_failure_gives_up_at_the_start_limit_and_reset_failed(sup):
    """5 failures in 10 minutes and the engine stays down, as with StartLimitBurst; reset-failed lets it start again."""
    sup.ctl(["start", "crash@a.service"])
    until(lambda: sup.show(["crash@a.service"])["crash@a.service"]["Result"] == "start-limit-hit")
    p = sup.show(["crash@a.service"])["crash@a.service"]
    assert (p["ActiveState"], p["SubState"], p["NRestarts"]) == ("failed", "failed", "3")
    m = messages(sup, "crash@a.service")
    assert "boom a" in m
    assert "Main process exited, code=exited, status=2/FAILURE" in m          # what outcrop_control's FAILED_RE reads
    assert "crash@a.service: Failed with result 'exit-code'." in m
    r = sup.ctl(["start", "crash@a.service"])
    assert r["rc"] == 1 and "too quickly" in r["stderr"]
    assert sup.ctl(["reset-failed", "crash@a.service"])["rc"] == 0
    assert sup.show(["crash@a.service"])["crash@a.service"]["ActiveState"] == "inactive"
    assert sup.ctl(["start", "crash@a.service"])["rc"] == 0


def test_stop_kills_after_the_timeout(sup):
    sup.start("stubborn.service")
    until(lambda: "up" in messages(sup, "stubborn.service"))
    t = time.time()
    sup.stop("stubborn.service")
    assert 0.8 < time.time() - t < 8
    assert sup.show(["stubborn.service"])["stubborn.service"]["ActiveState"] == "inactive"
    assert any("timed out. Killing." in m for m in messages(sup, "stubborn.service"))


def test_oneshot_and_condition(sup, tmp_path):
    assert sup.ctl(["start", "once.service"])["rc"] == 0                     # blocks until it is done
    p = sup.show(["once.service"])["once.service"]
    assert (p["ActiveState"], p["SubState"]) == ("active", "exited")
    assert "did it" in messages(sup, "once.service")
    (tmp_path / "flag").write_text("")
    assert sup.ctl(["start", "cond.service"])["rc"] == 0
    assert sup.show(["cond.service"])["cond.service"]["ActiveState"] == "inactive"
    assert any("unmet condition" in m for m in messages(sup, "cond.service"))


def test_names_enable_and_boot(sup, tmp_path):
    assert sup.ctl(["start", "crash@Bad_Name.service"])["rc"] == 5
    assert sup.ctl(["start", "nope.service"])["rc"] == 5
    assert sup.is_enabled("svc.service") == "enabled" and sup.is_enabled("cond.service") == "disabled"
    assert sup.ctl(["disable", "svc.service"])["rc"] == 0
    again = S.Supervisor(specs(tmp_path), tmp_path / "j2", state_file=tmp_path / "supervisor.json")
    assert again.is_enabled("svc.service") == "disabled"                      # kept in the state file
    sup.ctl(["enable", "svc.service"])
    sup.boot()                                                                 # svc first, then once (after=svc)
    assert sup.show(["svc.service"])["svc.service"]["ActiveState"] == "active"
    assert sup.show(["once.service"])["once.service"]["SubState"] == "exited"
    assert sup.show(["cond.service"])["cond.service"]["ActiveState"] == "inactive"


# --------------------------------------------------------------------------------- lib/units.py over the socket

@pytest.fixture
def startos(sup, tmp_path, monkeypatch):
    sock = tmp_path / "run" / "supervisor.sock"
    srv = sup.serve(sock)
    monkeypatch.setenv("OUTCROP_PLATFORM", "startos")
    monkeypatch.setenv("OUTCROP_SUPERVISOR_SOCK", str(sock))
    monkeypatch.setenv("OUTCROP_HOME", str(tmp_path / "home"))
    assert oct(sock.stat().st_mode & 0o777) == "0o600"
    yield sup
    srv.shutdown()


def test_units_backend(startos):
    assert units.backend() == "supervisor"
    assert units.ctl("--no-block", "start", "outcrop-engine@speed.service").returncode == 0
    assert units.is_active("outcrop-engine@speed.service") == "active"
    assert units.list_engine() == [("outcrop-engine@speed.service", "active", "running")]
    shown = units.show(["outcrop-engine@speed.service"], ["ActiveState", "MainPID"])
    assert set(shown["outcrop-engine@speed.service"]) == {"Id", "ActiveState", "MainPID"}
    t0 = time.time() - 5
    until(lambda: any(m.startswith("ready: ") for _, m in units.journal("outcrop-engine@speed.service", since=t0)))
    assert units.journal("outcrop-engine@speed.service", lines=1)[-1][1].startswith("ready: ")
    assert units.boot_unit_installed()
    with pytest.raises(RuntimeError, match="not found"):
        units.ctl("start", "nope.service")
    assert units.ctl("stop", "outcrop-engine@speed.service").returncode == 0
    assert units.is_active("outcrop-engine@speed.service") == "inactive"


def test_switch_helpers_through_the_supervisor(startos):
    """lib/outcrop_control.py's view of the engine, unchanged, over the supervisor."""
    import outcrop_control as LC
    LC.systemctl("start", "--no-block", LC.UNIT.format("speed"))
    assert LC.running() == [("speed", "running")] and LC.current() == "speed"
    assert LC.engine_pid(LC.UNIT.format("speed")) == startos.resolve("outcrop-engine@speed.service").proc.pid
    t0 = time.time() - 5
    until(lambda: any(LC.parse_phase(m) == ("ready", {}) for _, m in LC.journal_since(LC.UNIT.format("speed"), t0)))
    assert [LC.parse_phase(m)[0] for _, m in LC.journal_since(LC.UNIT.format("speed"), t0) if LC.parse_phase(m)] == [
        "experts", "ready"]
    LC.stop_all()
    assert LC.running() == []
    stops = [m for _, m in LC.journal_since(LC.UNIT.format("speed"), t0) if LC.parse_phase(m)]
    assert LC.parse_phase(stops[-1])[0] == "stopped"              # "Stopped outcrop-engine@speed.service."


def test_follow_and_journal_commands(startos):
    startos.start("svc.service")
    until(lambda: "hello" in messages(startos, "svc.service"))
    out = subprocess.run(units.journal_cmd("svc.service", 20), capture_output=True, text=True, timeout=20).stdout
    assert "svc[" in out and ": hello" in out
    p = subprocess.Popen(units.follow_cmd(["svc.service", "outcrop-engine@*"], message_only=True), stdout=subprocess.PIPE,
                         text=True)
    try:
        time.sleep(0.8)
        startos.start("outcrop-engine@quality.service")             # a unit that appears after the follow began
        line = until(lambda: p.stdout.readline())
        t, host, rest = line.split(" ", 2)
        assert float(t) > 0 and rest.startswith("outcrop-engine@quality[")
    finally:
        p.terminate()
        p.wait(5)


def test_boot_skips_a_unit_whose_requirement_failed(tmp_path):
    sp = specs(tmp_path)
    sp = {"models.service": S.Spec([PY, "-c", "import sys; sys.exit(1)"], type="oneshot", remain_after_exit=True, enabled=True),
          "engine.service": S.Spec([PY, "-c", "import time; time.sleep(60)"], enabled=True, after=["models.service"],
                                   requires=["models.service"])}
    s = S.Supervisor(sp, tmp_path / "j")
    try:
        s.boot()
        assert s.show(["models.service"])["models.service"]["ActiveState"] == "failed"
        assert s.show(["engine.service"])["engine.service"]["ActiveState"] == "inactive"
        assert "Dependency failed for engine.service: models.service." in messages(s, "engine.service")
    finally:
        s.shutdown()


def test_outcrop_units_order(tmp_path):
    """The console is up before the models' long first download; the boot default waits for them."""
    u = S.outcrop_units(Path("/opt/outcrop"), tmp_path)
    assert "outcrop-console.service" in u["outcrop-models.service"].after
    assert u["outcrop-boot.service"].requires == ["outcrop-models.service"]
    assert u["outcrop-engine@.service"].start_limit_burst == 5 and u["outcrop-engine@.service"].restart_sec == 20


@pytest.mark.skipif(os.geteuid() != 0, reason="starting a unit as another user needs root (the image's test stage runs as root)")
def test_a_unit_gets_its_users_groups(tmp_path):
    """As systemd does: the gateway and the console reach the page fetcher's socket through the outcrop-fetch group."""
    import grp
    import pwd
    user = next((p.pw_name for p in pwd.getpwall() if p.pw_uid >= 1000 and len(grp.getgrall()) and
                 [g for g in grp.getgrall() if p.pw_name in g.gr_mem]), None)
    if user is None:
        pytest.skip("no user with a supplementary group here")
    want = sorted(g.gr_name for g in grp.getgrall() if user in g.gr_mem)
    s = S.Supervisor({"g.service": S.Spec(["id", "-Gn"], type="oneshot", user=user)}, tmp_path / "j")
    s.start("g.service")
    got = next(m for m in messages(s, "g.service") if m and not m.startswith(("Started", "Main process", "Finished")))
    assert set(want) <= set(got.split())
