"""Scheduled switches: run a preset at a time of day, for example quality-1m overnight and quality in the morning.

Each schedule is {"id", "at": "HH:MM", "days": ["mon", ...] (empty: every day), "preset", "enabled"}.  At its time the console
starts a switch that waits until no request is running (so an answer is never cut off), once per day.  Kept in the settings
table under "schedules"; every run and every change goes in the audit log.
"""
from __future__ import annotations

import asyncio
import logging
import re
import secrets
from datetime import datetime

from ..common import db

log = logging.getLogger("outcrop.console")
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def normalize(item: dict, presets: list[str]) -> dict:
    at = str(item.get("at") or "").strip()
    if not re.fullmatch(r"([01]?\d|2[0-3]):[0-5]\d", at):
        raise ValueError("at is a time like 22:00")
    hh, mm = at.split(":")
    preset = str(item.get("preset") or "")
    if preset not in presets:
        raise ValueError(f"no preset {preset!r}")
    days = [str(d).lower()[:3] for d in item.get("days") or []]
    if any(d not in DAYS for d in days):
        raise ValueError("days are mon, tue, wed, thu, fri, sat, sun")
    return {"id": item.get("id") or secrets.token_hex(4), "at": f"{int(hh):02d}:{mm}", "days": days, "preset": preset,
            "enabled": bool(item.get("enabled", True)), "last_run": item.get("last_run")}


def load(con) -> list[dict]:
    return db.get_setting(con, "schedules", []) or []


def save(con, items: list[dict], by: str, source: str = "") -> list[dict]:
    with db.tx(con):
        db.set_setting(con, "schedules", items, by=by)
        db.add_event(con, "schedule.change", "schedules: " + ("; ".join(
            f"{i['preset']} at {i['at']}" + (f" ({','.join(i['days'])})" if i["days"] else "") + ("" if i["enabled"] else " (off)")
            for i in items) or "none"), actor=by, source=source)
    return items


def due(item: dict, now: datetime) -> bool:
    """At or within 10 minutes after its time today, on one of its days, and not yet run today."""
    if not item.get("enabled"):
        return False
    if item.get("days") and DAYS[now.weekday()] not in item["days"]:
        return False
    hh, mm = map(int, item["at"].split(":"))
    start = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if not 0 <= (now - start).total_seconds() < 600:
        return False
    last = item.get("last_run")
    return not last or datetime.fromtimestamp(last).date() != now.date()


class Scheduler:
    def __init__(self, h):
        self.h = h
        self.warned: set = set()

    async def run(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self.tick)
            except Exception:
                log.exception("scheduled switches")
            await asyncio.sleep(30)

    def tick(self, now: datetime | None = None) -> list[str]:
        """Start what is due.  A schedule counts as run once its switch has started (or its preset already runs); if
        a switch is in progress it tries again on the next tick, within its 10-minute window.  Only the schedules that
        ran are written back, onto a fresh read, so an edit made meanwhile is kept."""
        con = self.h.ctx.con()
        now = now or datetime.now()
        ran: dict[str, float] = {}
        started = []
        for it in load(con):
            if not due(it, now):
                continue
            if self.h.ctl.current() == it["preset"]:
                ran[it["id"]] = now.timestamp()
                db.add_event(con, "schedule.run", f"schedule {it['at']}: {it['preset']} already runs", actor="schedule")
                continue
            try:
                self.h.switches.start(it["preset"], when="idle", cancel_inflight=False, by="schedule",
                                      source=f"schedule {it['at']}")
            except Exception as e:
                key = (it["id"], now.date())
                if key not in self.warned:
                    self.warned.add(key)
                    db.add_event(con, "schedule.run", f"schedule {it['at']}: could not switch to {it['preset']} yet "
                                 f"({getattr(e, 'detail', e)}); trying again for 10 minutes", actor="schedule",
                                 level="warn")
                continue
            ran[it["id"]] = now.timestamp()
            started.append(it["preset"])
            db.add_event(con, "schedule.run", f"schedule {it['at']}: switching to {it['preset']} when idle",
                         actor="schedule")
        if ran:
            with db.tx(con):
                items = load(con)
                for it in items:
                    if it.get("id") in ran:
                        it["last_run"] = ran[it["id"]]
                db.set_setting(con, "schedules", items, by="schedule")
        return started
