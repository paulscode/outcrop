"""lib/units.py: the systemd backend runs exactly the commands Outcrop always ran, and reads their output the same way."""
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
import units  # noqa: E402


class Fake:
    """Stands in for subprocess.run: records each command and answers from a script."""
    def __init__(self, answers=None):
        self.calls, self.answers = [], answers or {}

    def __call__(self, cmd, timeout=None):
        self.calls.append(cmd)
        out, err, rc = self.answers.get(tuple(cmd[:3]), ("", "", 0))
        return subprocess.CompletedProcess(cmd, rc, out, err)


@pytest.fixture
def fake(monkeypatch):
    f = Fake()
    monkeypatch.setattr(units, "_run", f)
    monkeypatch.delenv("OUTCROP_PLATFORM", raising=False)
    return f


def test_backend_choice(monkeypatch):
    monkeypatch.delenv("OUTCROP_PLATFORM", raising=False)
    assert units.backend() == "systemd"
    monkeypatch.setenv("OUTCROP_PLATFORM", "startos")
    assert units.backend() == "supervisor"


def test_ctl_commands(fake):
    units.ctl("start", "--no-block", "outcrop-engine@speed.service")
    units.ctl("restart", "outcrop-gateway.service", check=False)
    assert fake.calls == [["systemctl", "--no-ask-password", "start", "--no-block", "outcrop-engine@speed.service"],
                          ["systemctl", "--no-ask-password", "restart", "outcrop-gateway.service"]]


def test_ctl_falls_back_to_sudo_and_raises(fake, monkeypatch):
    monkeypatch.setattr(units.os, "geteuid", lambda: 1000)
    fake.answers[("systemctl", "--no-ask-password", "stop")] = ("", "Access denied", 1)
    fake.answers[("sudo", "-n", "systemctl")] = ("", "a password is required", 1)
    with pytest.raises(RuntimeError, match="systemctl stop outcrop-engine@x.service failed: a password is required"):
        units.ctl("stop", "outcrop-engine@x.service")
    assert fake.calls[1] == ["sudo", "-n", "systemctl", "--no-ask-password", "stop", "outcrop-engine@x.service"]


def test_list_engine_and_is_active(fake):
    fake.answers[("systemctl", "list-units", "outcrop-engine@*")] = (
        "outcrop-engine@speed.service loaded active running Strata\n"
        "outcrop-engine@quality.service loaded inactive dead Strata\n"
        "something-else.service loaded active running x\n", "", 0)
    assert units.list_engine() == [("outcrop-engine@speed.service", "active", "running"),
                                   ("outcrop-engine@quality.service", "inactive", "dead")]
    assert fake.calls[0] == ["systemctl", "list-units", "outcrop-engine@*", "--all", "--no-legend", "--plain"]
    assert units.is_active("outcrop-gateway.service") == "unknown"          # no answer
    assert fake.calls[1] == ["systemctl", "is-active", "outcrop-gateway.service"]


def test_show(fake):
    fake.answers[("systemctl", "show", "a.service")] = (
        "Id=a.service\nActiveState=active\nMainPID=42\n\nId=b.service\nActiveState=failed\nMainPID=0\n", "", 0)
    got = units.show(["a.service", "b.service"], ["ActiveState", "MainPID"])
    assert fake.calls[0] == ["systemctl", "show", "a.service", "b.service", "-p", "Id,ActiveState,MainPID"]
    assert got == {"a.service": {"Id": "a.service", "ActiveState": "active", "MainPID": "42"},
                   "b.service": {"Id": "b.service", "ActiveState": "failed", "MainPID": "0"}}
    assert units.show([], ["MainPID"]) == {}


def test_journal(fake):
    fake.answers[("journalctl", "-u", "outcrop-engine@speed.service")] = (
        "1732222222.500000 host outcrop-serve[12]: loading the experts into RAM (about 40.1 GB)\n"
        "garbage line\n"
        "1732222223.000000 host outcrop-serve[12]: ready: http://127.0.0.1:18080\n", "", 0)
    got = units.journal("outcrop-engine@speed.service", since=1732222222.1)
    assert fake.calls[0] == ["journalctl", "-u", "outcrop-engine@speed.service", "--since", "@1732222222.100",
                             "-o", "short-unix", "--no-pager", "-q"]
    assert got == [(1732222222.5, "loading the experts into RAM (about 40.1 GB)"),
                   (1732222223.0, "ready: http://127.0.0.1:18080")]
    units.journal("outcrop-gateway.service", lines=60)
    assert fake.calls[1] == ["journalctl", "-u", "outcrop-gateway.service", "-n", "60", "-o", "short-unix", "--no-pager", "-q"]


def test_follow_cmd():
    assert units.follow_cmd(["outcrop-engine@*", "outcrop-gateway.service"], message_only=True) == [
        "journalctl", "-f", "-n", "0", "-o", "short-unix", "-q", "-u", "outcrop-engine@*", "-u", "outcrop-gateway.service",
        "--output-fields=MESSAGE"]
