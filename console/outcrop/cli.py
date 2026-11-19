"""The outcrop commands for API access and the console: token, auth, gateway, audit, console, alerts, desktop.

Standard library only (outcrop runs it with the system Python); the few commands that need the console's packages
(`console passwd`) run themselves again with the console's Python.
"""
from __future__ import annotations

import argparse
import getpass
import ipaddress
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

from .common import config, db, tokens
from .common.tokens import TokenError

sys.path.insert(0, str(config.PROJECT / "lib"))
import outcrop_control as LC  # noqa: E402

B, D, G, Y, R, X = "\033[1m", "\033[2m", "\033[32m", "\033[33m", "\033[31m", "\033[0m"
if not sys.stdout.isatty():
    B = D = G = Y = R = X = ""
VENV_PY = Path(os.environ.get("OUTCROP_VENV") or config.OUTCROP_HOME / "venv" / "outcrop") / "bin" / "python"
WHO = "cli"


def src() -> str:
    return LC._ssh_source()


def die(msg: str, code: int = 1):
    print(f"{R}{msg}{X}", file=sys.stderr)
    sys.exit(code)


def when(ts: float | None, rel: bool = True) -> str:
    if not ts:
        return "-"
    d = datetime.fromtimestamp(ts)
    if not rel:
        return f"{d:%Y-%m-%d %H:%M}"
    dt = time.time() - ts
    if -60 < dt < 60:
        return "now" if dt >= 0 else "in under a minute"
    fut = dt < 0
    a = abs(dt)
    s = (f"{a / 60:.0f} min" if a < 3600 else f"{a / 3600:.1f} h" if a < 86400 * 2 else f"{a / 86400:.0f} days")
    return f"in {s}" if fut else f"{s} ago"


def con():
    return db.connect()


def pepper() -> bytes:
    return tokens.load_pepper()


def poke():
    """Tell the gateway at once (it also notices within a second by itself)."""
    LC.gateway("POST", "/reload")


# ------------------------------------------------------------------------------------------------------------ tokens

def token_line(t: dict) -> str:
    if t["revoked_at"]:
        state = f"{D}revoked {when(t['revoked_at'], False)}{X}"
    elif t["expires_at"] and t["expires_at"] <= time.time():
        state = f"{Y}expired{X}"
    else:
        state = G + "active" + X
    exp = "never" if not t["expires_at"] else when(t["expires_at"], False)
    used = when(t["last_used_at"]) + (f" · {t['last_app']}" if t.get("last_app") else "") if t["last_used_at"] else "never"
    lim = ",".join(t["listeners"]) if set(t["listeners"]) != {"openai", "ollama"} else "both ports"
    nets = ",".join(t["cidrs"]) or "any address"
    return (f"{B}{t['name']:18s}{X} {t['hint']:16s} {','.join(t['scopes']):22s} {state:16s} expires {exp:16s} "
            f"used {used}  {D}{lim}, {nets}{X}")


def cmd_token(a):
    c = con()
    p = pepper()
    try:
        if a.action in (None, "list"):
            rows = tokens.list_tokens(c, include_revoked=a.all)
            if not rows:
                print("no tokens yet: outcrop token create NAME")
            for t in rows:
                print(token_line(t))
            return
        if a.action in ("create", "import"):
            if not a.name:
                die(f"usage: outcrop token {a.action} NAME [--scope ...] [--expires ...]")
            value = None
            if a.action == "import":
                if sys.stdin.isatty():
                    value = getpass.getpass("token value (not shown): ")
                else:
                    value = sys.stdin.readline().strip()
            if "admin" in (a.scope or "") and sys.stdin.isatty() and a.action == "create":
                print(f"{Y}an admin token can unload the model and change Strata's settings.{X}")
            tok, plain = tokens.create(c, p, a.name, scopes=a.scope, listeners=a.listener, cidrs=a.cidr,
                                       expires_at=tokens.parse_expiry(a.expires or "never"), rpm=a.rpm,
                                       concurrency=a.concurrency, notes=a.notes or "", by=WHO, source=src(), value=value)
            poke()
            if value is None and a.save:
                # into a file only its owner can read, and never on the screen
                path = Path(a.save).expanduser()
                path.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as f:
                    f.write(plain + "\n")
                os.chmod(path, 0o600)
                print(f"{G}created{X} {B}{tok['name']}{X} ({','.join(tok['scopes'])}); the token is in {path} (not shown)")
            elif value is None:
                print(f"{G}created{X} {B}{tok['name']}{X} ({','.join(tok['scopes'])}). The token, shown only now:\n")
                print(f"  {B}{plain}{X}\n")
                print(f"{D}Apps send it as  Authorization: Bearer <token>  (OpenAI, Ollama) or x-api-key (Anthropic).{X}")
            else:
                print(f"{G}imported{X} {B}{tok['name']}{X} as {tok['hint']}")
            return
        if a.action == "show":
            t = tokens.find(c, a.name or "", include_revoked=True)
            if not t:
                die(f"no token {a.name!r}")
            print(token_line(t))
            for k in ("id", "kind", "notes", "created_at", "created_by", "rotated_at", "revoked_at", "revoke_reason",
                      "rpm", "concurrency", "last_ip"):
                v = t.get(k)
                if v not in (None, "", 0):
                    print(f"  {k:14s} {when(v, False) if k.endswith('_at') else v}")
            u = c.execute("SELECT sum(requests) r, sum(prompt_tokens) p, sum(output_tokens) o FROM usage_daily "
                          "WHERE token_id=? AND day >= date('now','-30 day')", (t["id"],)).fetchone()
            print(f"  last 30 days  {u['r'] or 0} requests, {u['p'] or 0:,} tokens in, {u['o'] or 0:,} out")
            return
        if a.action == "rotate":
            tok, plain = tokens.rotate(c, p, a.name or "", tokens.parse_grace(a.grace), by=WHO, source=src())
            poke()
            g = f"; the old value keeps working for {a.grace}" if a.grace and tokens.parse_grace(a.grace) > 0 else \
                "; the old value has stopped working"
            print(f"{G}rotated{X} {B}{tok['name']}{X}{g}. The new token, shown only now:\n\n  {B}{plain}{X}\n")
            return
        if a.action == "revoke":
            t = tokens.revoke(c, a.name or "", by=WHO, source=src(), reason=a.reason or "")
            poke()
            n = 0
            if a.disconnect:
                n = (LC.gateway("POST", "/cancel", {"token_id": t["id"], "reason": "the token was revoked"}) or {}).get(
                    "cancelled", 0)
            print(f"{G}revoked{X} {B}{t['name']}{X}" + (f"; {n} running request(s) cancelled" if a.disconnect else ""))
            return
        if a.action == "set":
            fields = {}
            if a.new_name:
                fields["name"] = a.new_name
            if a.scope:
                fields["scopes"] = a.scope
            if a.listener:
                fields["listeners"] = a.listener
            if a.cidr is not None:
                fields["cidrs"] = a.cidr
            if a.expires:
                fields["expires_at"] = tokens.parse_expiry(a.expires)
            if a.rpm is not None:
                fields["rpm"] = a.rpm or None
            if a.concurrency is not None:
                fields["concurrency"] = a.concurrency or None
            if a.notes is not None:
                fields["notes"] = a.notes
            t = tokens.update(c, a.name or "", by=WHO, source=src(), **fields)
            poke()
            print(token_line(t))
            return
        die(f"unknown token command {a.action!r}")
    except TokenError as e:
        die(str(e))
    finally:
        c.close()


# -------------------------------------------------------------------------------------------------------------- auth

def auth_summary(c, short: bool = False) -> str:
    st = LC.gateway("GET", "/state")
    mode = db.get_setting(c, "auth.mode")
    tl = db.get_setting(c, "ollama.tokenless")
    now = time.time()
    if mode.get("mode") == "open" and float(mode.get("until") or 0) > now:
        scope = []
        if mode.get("addresses"):
            scope.append("only " + ", ".join(mode["addresses"]))
        if mode.get("listeners") and set(mode["listeners"]) != {"openai", "ollama"}:
            scope.append("only port " + ",".join("8080" if x == "openai" else "11434" for x in mode["listeners"]))
        s = (f"{Y}{B}OPEN{X}{Y} until {datetime.fromtimestamp(mode['until']):%H:%M} ({when(mode['until'])}): requests "
             f"without a token are allowed{(' (' + '; '.join(scope) + ')') if scope else ''}{X}")
    else:
        n = c.execute("SELECT count(*) FROM tokens WHERE revoked_at IS NULL AND kind='user'").fetchone()[0]
        s = f"{G}enforced{X}: every request needs a token ({n} token{'s' if n != 1 else ''})"
    if tl.get("enabled"):
        s += f"; {Y}Ollama port without a token for {', '.join(tl.get('addresses') or ['nobody'])}{X}"
    if st is None and Path("/etc/systemd/system/outcrop-gateway.service").exists():
        s += f"; {R}the gateway is not running{X}"
    elif st is None:
        s += f"; {D}the gateway is not installed{X}"
    return s


def cmd_auth(a):
    c = con()
    try:
        if a.action in (None, "status"):
            print(f"{B}Access:{X}   {auth_summary(c)}")
            rows = c.execute("SELECT client_ip, app, count(*) n, max(started_at) last, "
                             "sum(auth='denied') denied FROM requests WHERE auth IN ('open','denied','tokenless') "
                             "AND route_class != 'public' AND started_at > ? GROUP BY client_ip, app ORDER BY last DESC "
                             "LIMIT 20", (time.time() - 7 * 86400,)).fetchall()
            if rows:
                print(f"\n{B}Clients calling without a valid token{X} (last 7 days):")
                for r in rows:
                    print(f"  {r['client_ip']:16s} {r['app'] or '?':18s} {r['n']:5d} requests ({r['denied']} refused), "
                          f"last {when(r['last'])}")
            return
        if a.action == "open":
            dur = tokens.parse_duration(a.duration or "15m")
            if dur > 24 * 3600:
                die("the API can be opened for at most 24 hours")
            addrs = []
            for x in a.only or []:
                try:
                    addrs.append(str(ipaddress.ip_network(x, strict=False)))
                except ValueError:
                    die(f"{x!r} is not an address or network")
            lis = tokens.norm_listeners(a.listener) if a.listener else ["openai", "ollama"]
            until = time.time() + dur
            with db.tx(c):
                db.set_setting(c, "auth.mode", {"mode": "open", "until": until, "addresses": addrs, "listeners": lis,
                                                "by": WHO, "at": time.time()}, by=WHO)
                db.add_event(c, "auth.open", f"API opened for {tokens._fmt_dur(dur)}"
                             + (f" for {', '.join(addrs)}" if addrs else " for the whole LAN")
                             + ("" if set(lis) == {"openai", "ollama"} else f" on {','.join(lis)} only"),
                             actor=WHO, source=src(), level="warn", details={"until": until, "addresses": addrs,
                                                                             "listeners": lis})
            poke()
            print(f"{Y}open{X} until {datetime.fromtimestamp(until):%H:%M}; it closes by itself. "
                  f"`outcrop auth close` closes it now.")
            return
        if a.action == "close":
            with db.tx(c):
                was = db.get_setting(c, "auth.mode")
                db.set_setting(c, "auth.mode", {"mode": "enforced"}, by=WHO)
                if was.get("mode") == "open":
                    db.add_event(c, "auth.close", "API closed: tokens are required again", actor=WHO, source=src())
            poke()
            print(f"{G}enforced{X}: every request needs a token")
            return
        if a.action == "tokenless":
            cur = db.get_setting(c, "ollama.tokenless")
            on = (a.duration or "").lower()
            if on not in ("on", "off"):
                print(f"token-less Ollama option: {'on' if cur.get('enabled') else 'off'}; addresses: "
                      f"{', '.join(cur.get('addresses') or []) or 'none'}")
                print("  outcrop auth tokenless on --only 192.168.1.30   |   outcrop auth tokenless off")
                return
            addrs = cur.get("addresses") or []
            if a.only:
                addrs = []
                for x in a.only:
                    try:
                        addrs.append(str(ipaddress.ip_network(x, strict=False)))
                    except ValueError:
                        die(f"{x!r} is not an address or network")
            if on == "on" and not addrs:
                die("name the app's address: outcrop auth tokenless on --only 192.168.1.30")
            with db.tx(c):
                db.set_setting(c, "ollama.tokenless", {"enabled": on == "on", "addresses": addrs}, by=WHO)
                db.add_event(c, "auth.tokenless", f"token-less Ollama option turned {on}"
                             + (f" for {', '.join(addrs)}" if on == "on" else ""), actor=WHO, source=src(),
                             level="warn" if on == "on" else "info", details={"enabled": on == "on", "addresses": addrs})
            poke()
            print(f"token-less Ollama option {on}" + (f" for {', '.join(addrs)} (port 11434 only)" if on == "on" else ""))
            return
        die(f"unknown auth command {a.action!r}")
    finally:
        c.close()


# ----------------------------------------------------------------------------------------------------------- gateway

def cmd_gateway(a):
    act = a.action or "status"
    if act == "status":
        st = LC.gateway("GET", "/state")
        unit = LC.unit_state(LC.GATEWAY_UNIT)
        if st is None:
            print(f"{B}Gateway:{X}  {unit}; the control socket does not answer")
            if LC.SP.bypass():
                print(f"{Y}bypass in force{X}: Strata serves the LAN itself. `outcrop gateway restore` ends it.")
            return
        up = time.time() - st["started_at"]
        https = f", {st['listen']['https']} (HTTPS)" if st["listen"].get("https") else ""
        print(f"{B}Gateway:{X}  {G}running{X} for {up / 3600:.1f} h, ports {st['listen']['openai']}, "
              f"{st['listen']['ollama']} (Ollama){https}; {st['tokens']} tokens; {st['counts']['requests']} requests, "
              f"{st['counts']['denied']} refused, {st['counts']['errors']} errors since start")
        s = st["strata"]
        print(f"{B}Strata:{X}   {'loaded' if s['loaded'] else 'up, not loaded' if s['up'] else 'not answering'}"
              f"{', preset ' + s['preset'] if s.get('preset') else ''}")
        h = st["hold"]
        if not h["ready"]:
            print(f"{B}Hold:{X}     {Y}new requests wait: {h['reason']}{X} ({h['waiting']} waiting)")
        for f in st["inflight"]:
            print(f"  {f['rid']}  {f['app']:14s} {f['client_ip']:15s} {f.get('token') or f['auth']:12s} {f['path']:24s} "
                  f"{f['phase']:9s} {f['tokens']} tokens, {time.time() - f['started_at']:.0f} s")
        return
    if act == "wait-idle":
        who = "the console's chat answers" if a.console else "requests and switches"
        print(f"waiting until {who} are done (at most {a.timeout:.0f} s) ...", flush=True)
        if not wait_idle(a.timeout, console_only=a.console):
            print(f"{Y}still busy after {a.timeout:.0f} s{X}", file=sys.stderr)
            sys.exit(3)
        return
    if act == "restart":
        if a.when_idle:
            print(f"waiting until no request or switch is running (at most {a.timeout:.0f} s) ...", flush=True)
            if not wait_idle(a.timeout):
                print(f"{Y}still busy after {a.timeout:.0f} s: not restarted; run it again later{X}", file=sys.stderr)
                sys.exit(3)
        LC.systemctl("restart", LC.GATEWAY_UNIT)
        LC.audit("gateway.restart", "gateway restarted", actor=WHO)
        print("gateway restarted")
        return
    if act == "bypass":
        bypass()
        return
    if act == "restore":
        restore()
        return
    die(f"unknown gateway command {act!r}")


def bypass():
    """Emergency: Strata itself serves the LAN on port 8080 with one new token as its key (a model restart)."""
    if LC.SP.bypass():
        die("a bypass is already in force: `outcrop gateway restore` ends it")
    c = con()
    try:
        old = tokens.find(c, "emergency-bypass")
        if old:
            tokens.revoke(c, old["id"], by=WHO, reason="replaced")
        _, plain = tokens.create(c, pepper(), "emergency-bypass", notes="the key Strata takes during a gateway bypass",
                                 expires_at=time.time() + 30 * 86400, by=WHO, source=src())
        local = config.read_secret(config.LOCAL_TOKEN_FILE)
        keys = [plain] + ([local] if local else [])
        config.write_secret(config.BYPASS_FILE, json.dumps({"keys": keys, "at": time.time(), "by": WHO}))
        db.add_event(c, "gateway.bypass", "gateway bypass: Strata serves the LAN itself with the emergency key",
                     actor=WHO, source=src(), level="warn")
    finally:
        c.close()
    print("stopping the gateway ...", flush=True)
    LC.systemctl("stop", LC.GATEWAY_UNIT, check=False)
    now = LC.current() or LC.default_preset()
    print(f"restarting {now} on port 8080 with the emergency key (about a minute) ...", flush=True)
    LC.systemctl("restart", LC.BRIDGE_UNIT, check=False)
    if now:
        LC.switch(now, restart=True, by=WHO)
    print(f"\n{Y}bypass in force{X}. Apps must now send this key (shown only now):\n\n  {B}{plain}{X}\n\n"
          f"Per-token rules, open mode and the request log are off until `outcrop gateway restore`.")


def restore():
    """Back behind the gateway.  The gateway starts first, so requests wait at its hold during the model restart instead
    of being refused."""
    if not LC.SP.bypass():
        print("no bypass in force")
        return
    now = LC.current() or LC.default_preset()
    if now:
        print(f"stopping {now} (it moves back to loopback) ...", flush=True)
        LC.systemctl("stop", LC.UNIT.format(now), check=False, timeout=300)
    # only now, so the gateway (which does not start while the file exists) follows within a second
    config.BYPASS_FILE.unlink()
    LC.audit("gateway.restore", "gateway restored: tokens are checked by the gateway again", actor=WHO)
    LC.systemctl("restart", LC.BRIDGE_UNIT, check=False)
    LC.systemctl("start", LC.GATEWAY_UNIT, check=False)
    for _ in range(50):                                    # until its control socket answers
        if LC.gateway("GET", "/state") is not None:
            break
        time.sleep(0.2)
    if now:
        print(f"starting {now} behind the gateway (about a minute; requests wait meanwhile) ...", flush=True)
        LC.switch(now, by=WHO)
    c = con()
    try:
        t = tokens.find(c, "emergency-bypass")
        if t:
            tokens.revoke(c, t["id"], by=WHO, reason="bypass ended")
    finally:
        c.close()
    print(f"{G}restored{X}: the gateway checks tokens again")


# ------------------------------------------------------------------------------------------------------------- audit

def cmd_audit(a):
    c = con()
    try:
        rows = db.events(c, a.n, kinds=[a.kind] if a.kind else None)
    finally:
        c.close()
    for e in reversed(rows):
        lvl = {"warn": Y, "error": R}.get(e["level"], "")
        who = e["actor"] + (f" ({e['source']})" if e["source"] else "")
        print(f"{D}{datetime.fromtimestamp(e['at']):%Y-%m-%d %H:%M:%S}{X}  {e['kind']:16s} {lvl}{e['summary']}{X}  "
              f"{D}{who}{X}")


# ---------------------------------------------------------------------------------------------------------- schedules

def cmd_schedule(a):
    from .console import schedules
    c = con()
    try:
        items = schedules.load(c)
        act = a.action or "list"
        if act == "list":
            if not items:
                print("no scheduled switches: outcrop schedule add 22:00 quality-1m [--days mon,tue]")
            for i in items:
                last = when(i.get("last_run")) if i.get("last_run") else "never"
                print(f"{i['id']}  {i['at']}  {i['preset']:14s} {','.join(i['days']) or 'every day':28s} "
                      f"{'' if i['enabled'] else Y + 'off  ' + X}{D}last run {last}{X}")
            return
        if act == "add":
            if not a.args or len(a.args) != 2:
                die("usage: outcrop schedule add HH:MM PRESET [--days mon,tue]")
            try:
                it = schedules.normalize({"at": a.args[0], "preset": a.args[1],
                                          "days": [d for d in (a.days or "").split(",") if d]}, LC.SP.names())
            except ValueError as e:
                die(str(e))
            schedules.save(c, items + [it], WHO, src())
            print(f"at {it['at']} {', '.join(it['days']) or 'every day'}: switch to {it['preset']} (waits until no request "
                  f"is running)  [{it['id']}]")
            return
        if act in ("remove", "on", "off"):
            if not a.args:
                die(f"usage: outcrop schedule {act} ID")
            ids = {i["id"] for i in items}
            if a.args[0] not in ids:
                die(f"no schedule {a.args[0]!r}")
            if act == "remove":
                items = [i for i in items if i["id"] != a.args[0]]
            else:
                for i in items:
                    if i["id"] == a.args[0]:
                        i["enabled"] = act == "on"
            schedules.save(c, items, WHO, src())
            print("done")
            return
        die(f"unknown schedule command {act!r}")
    finally:
        c.close()


# ------------------------------------------------------------------------------------------------- console, desktop

def cmd_console(a):
    """Commands that need the console's packages run with its Python."""
    if not VENV_PY.exists():
        die(f"the console is not installed ({VENV_PY} is missing): setup/install-console.sh")
    env = {**os.environ, "PYTHONPATH": str(config.PROJECT / "console")}
    argv = [str(VENV_PY), "-m", "outcrop.console.admin", *sys.argv[sys.argv.index("console") + 1:]]
    os.execve(argv[0], argv, env)


def cmd_alerts(a):
    if not VENV_PY.exists():
        die(f"the console is not installed ({VENV_PY} is missing): setup/install-console.sh")
    env = {**os.environ, "PYTHONPATH": str(config.PROJECT / "console")}
    argv = [str(VENV_PY), "-m", "outcrop.console.admin", "alerts", *sys.argv[sys.argv.index("alerts") + 1:]]
    os.execve(argv[0], argv, env)


def cmd_desktop(a):
    act = a.action
    if act == "on":
        LC.systemctl("start", "display-manager.service")
        print("the desktop is starting (for this session; it stays off at boot)")
    elif act == "off":
        LC.systemctl("stop", "display-manager.service")
        print("the desktop is off")
    else:
        st = LC.unit_state("display-manager.service")
        dflt = LC.out(["systemctl", "get-default"])
        print(f"desktop: {st}; boots to {dflt}")


def _chat_answers_running() -> bool:
    """Answers the console is writing, from its chats database: between two requests (a search, a page being read)
    nothing is in flight at the gateway, yet the answer is not done."""
    import sqlite3
    p = LC.STATE / "chats.db"
    if not p.exists() or LC.unit_state("outcrop-console.service") != "active":
        return False                                  # no console: leftover rows are from before its last stop
    try:
        con = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=2)
        try:
            # an answer started over 3 hours ago is not running (a crash left it behind)
            return con.execute("SELECT 1 FROM messages WHERE status='streaming' AND created_at > ? LIMIT 1",
                               (time.time() - 3 * 3600,)).fetchone() is not None
        finally:
            con.close()
    except sqlite3.Error:
        return False


def wait_idle(timeout: float, console_only: bool = False, quiet_s: float = 5.0) -> bool:
    """True once nothing has run for `quiet_s` seconds: no request in flight (or, console_only, none of the console's
    chat answers), no hold (unless console_only) and no preset switch.  False after `timeout`."""
    end, calm, silent = time.time() + timeout, None, None
    while time.time() < end:
        st = LC.gateway("GET", "/state")
        if st is None:
            if LC.unit_state(LC.GATEWAY_UNIT) != "active":
                return True                               # the gateway is down: nothing to wait for
            silent = silent or time.time()
            if time.time() - silent > 30:
                return True                               # up but silent for 30 s: hung; a restart is what it needs
            calm = None
            time.sleep(1)
            continue
        silent = None
        busy = [f for f in st.get("inflight") or [] if not console_only or f.get("token") == "console-playground"]
        if not busy and _chat_answers_running():
            # an answer between two requests (a web search, a page, a click it waits for) is still running, and its
            # next request would hit a gateway that is restarting
            busy = ["a chat answer between requests"]
        held = not console_only and not (st.get("hold") or {}).get("ready", True)
        if busy or held or LC.switch_running():          # the console runs switches too: never cut one off
            calm = None
        else:
            calm = calm or time.time()
            if time.time() - calm >= quiet_s:
                return True
        time.sleep(1)
    return False


# -------------------------------------------------------------------------------------------------------------- main

def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="outcrop")
    sub = ap.add_subparsers(dest="cmd")
    t = sub.add_parser("token", help="API tokens")
    t.add_argument("action", nargs="?", choices=["list", "create", "import", "show", "rotate", "revoke", "set"])
    t.add_argument("name", nargs="?")
    t.add_argument("--scope", help="inference (default), telemetry, admin, web (the web tools for apps); comma-separated")
    t.add_argument("--listener", help="openai (port 8080), ollama (port 11434) or both (default)")
    t.add_argument("--cidr", action="append", help="allowed address or network (repeat); default any")
    t.add_argument("--expires", help="never (default), 7d, 30d, 90d, 365d, 12h or a date")
    t.add_argument("--rpm", type=int, help="requests per minute (0: no limit)")
    t.add_argument("--concurrency", type=int, help="requests at once (0: no limit)")
    t.add_argument("--notes")
    t.add_argument("--save", metavar="FILE", help="(create) write the token to FILE (readable by you only) instead of showing it")
    t.add_argument("--name", dest="new_name", help="(set) a new name")
    t.add_argument("--grace", help="(rotate) how long the old value keeps working: none, 1h, 24h, 7d")
    t.add_argument("--disconnect", action="store_true", help="(revoke) also cancel its running requests")
    t.add_argument("--reason")
    t.add_argument("--all", action="store_true", help="(list) include revoked tokens")
    a = sub.add_parser("auth", help="enforced or open")
    a.add_argument("action", nargs="?", choices=["status", "open", "close", "tokenless"])
    a.add_argument("duration", nargs="?", help="(open) 15m, 1h, 4h ... up to 24h; (tokenless) on | off")
    a.add_argument("--only", action="append", help="only this address or network (repeat)")
    a.add_argument("--listener", help="only openai (8080) or ollama (11434)")
    g = sub.add_parser("gateway", help="the API gateway")
    g.add_argument("action", nargs="?", choices=["status", "restart", "bypass", "restore", "wait-idle"])
    g.add_argument("--when-idle", action="store_true")
    g.add_argument("--timeout", type=float, default=900, help="(restart --when-idle, wait-idle) seconds to wait at most")
    g.add_argument("--console", action="store_true", help="(wait-idle) only the console's chat answers")
    au = sub.add_parser("audit", help="the audit log")
    au.add_argument("-n", type=int, default=50)
    au.add_argument("--kind", help="e.g. token.*, auth.*, signin.*")
    sc = sub.add_parser("schedule", help="scheduled preset switches")
    sc.add_argument("action", nargs="?", choices=["list", "add", "remove", "on", "off"])
    sc.add_argument("args", nargs="*")
    sc.add_argument("--days", help="mon,tue,... (default every day)")
    sub.add_parser("console", help="console account, sessions, URL, CA").add_argument("rest", nargs=argparse.REMAINDER)
    sub.add_parser("alerts", help="Telegram alerts").add_argument("rest", nargs=argparse.REMAINDER)
    d = sub.add_parser("desktop", help="the graphical desktop")
    d.add_argument("action", nargs="?", choices=["on", "off", "status"])
    return ap


def main(argv=None) -> int:
    a = parser().parse_args(argv)
    fn = {"token": cmd_token, "auth": cmd_auth, "gateway": cmd_gateway, "audit": cmd_audit, "console": cmd_console,
          "alerts": cmd_alerts, "desktop": cmd_desktop, "schedule": cmd_schedule}.get(a.cmd)
    if fn is None:
        parser().print_help()
        return 2
    fn(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
