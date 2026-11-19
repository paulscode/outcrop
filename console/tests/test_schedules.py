"""Scheduled switches: due once a day at their time, on their days, waiting until idle."""
import types
from datetime import datetime

import pytest

from outcrop.common import db
from outcrop.console import schedules as S


def test_normalize_and_due():
    it = S.normalize({"at": "7:05", "preset": "quality", "days": ["Monday"]}, ["quality"])
    assert it["at"] == "07:05" and it["days"] == ["mon"] and it["enabled"]
    with pytest.raises(ValueError):
        S.normalize({"at": "25:00", "preset": "quality"}, ["quality"])
    with pytest.raises(ValueError):
        S.normalize({"at": "07:00", "preset": "turbo"}, ["quality"])
    mon = datetime(2026, 11, 9, 7, 6)                      # a Monday
    assert S.due(it, mon)
    assert not S.due(it, mon.replace(day=10))              # Tuesday
    assert not S.due(it, mon.replace(minute=0))            # before its time
    assert not S.due(it, mon.replace(hour=8))              # more than 10 minutes late
    it["last_run"] = mon.timestamp()
    assert not S.due(it, mon.replace(minute=8))            # once a day


def test_tick_starts_an_idle_switch(tmp_path):
    con = db.connect(tmp_path / "s.db")
    started = []
    h = types.SimpleNamespace(ctx=types.SimpleNamespace(con=lambda: con),
                              ctl=types.SimpleNamespace(current=lambda: "quality"),
                              switches=types.SimpleNamespace(start=lambda name, **kw: started.append((name, kw["when"]))))
    S.save(con, [S.normalize({"at": "22:00", "preset": "quality-1m"}, ["quality-1m"])], "test")
    sch = S.Scheduler(h)
    assert sch.tick(datetime(2026, 11, 7, 22, 1)) == ["quality-1m"] and started == [("quality-1m", "idle")]
    assert sch.tick(datetime(2026, 11, 7, 22, 3)) == []     # not twice
    assert db.events(con, 5, kinds=["schedule.run"])
