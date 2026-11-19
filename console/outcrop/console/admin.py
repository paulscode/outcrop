"""outcrop console … and outcrop alerts …: the commands that need the console's packages (run with its Python).

  console passwd [--generate] [--user NAME]   set the console password (over SSH only; ends every session)
  console sessions [--revoke-all]             the signed-in sessions
  console url                                 where the console is
  console ca                                  the CA's fingerprint (compare with the /ca.crt page) and the certificate's dates
  console tls ensure | renew [--add-name NAME] [--if-due]
  console backup [FILE] [--secrets] [--no-chats]  the database, the chats (and with --secrets the keys) as a .tar.gz
  console restore FILE                        put a backup back (stops and starts the gateway and the console)
  alerts telegram                             set up Telegram: reads the bot token (not shown), finds your chat, sends a test
  alerts test | status | off
  alerts commands on | off                    /status, /switch PRESET, /close from your own Telegram chat
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from ..common import config, db
from . import auth, passwords, tls

B, D, G, Y, R, X = "\033[1m", "\033[2m", "\033[32m", "\033[33m", "\033[31m", "\033[0m"
if not sys.stdout.isatty():
    B = D = G = Y = R = X = ""


def src() -> str:
    c = os.environ.get("SSH_CLIENT", "").split()
    return f"ssh {c[0]}" if c else "local"


def cmd_passwd(a) -> int:
    con = db.connect()
    user = a.user or (auth.get_user(con)["username"] if auth.get_user(con) else os.environ.get("USER") or "admin")
    if a.generate:
        pw = passwords.generate(username=user)
        auth.set_password(con, user, pw, actor="cli", source=src())
        print(f"{G}password set{X} for {B}{user}{X}. It is shown only now; keep it in your password manager:\n")
        print(f"  {B}{pw}{X}\n")
        print(f"{D}Six random words (about 77 bits). Every console session has been signed out.{X}")
        return 0
    if not sys.stdin.isatty():
        pw = sys.stdin.readline().rstrip("\n")
        v = passwords.check(pw, user)
        if not v.ok:
            print(f"{R}not accepted:{X} " + "; ".join(v.reasons), file=sys.stderr)
            return 1
        auth.set_password(con, user, pw, actor="cli", source=src())
        print(f"password set for {user}")
        return 0
    print(f"Console password for {B}{user}{X}: at least {passwords.MIN_LEN} characters, hard to guess. Spaces are fine.")
    print(f"{D}(Or run `outcrop console passwd --generate` for six random words.){X}")
    for _ in range(5):
        pw = getpass.getpass("new password: ")
        v = passwords.check(pw, user)
        if not v.ok:
            print(f"{Y}not accepted:{X} " + "; ".join(v.reasons))
            for s in v.suggestions[:2]:
                print(f"  {D}{s}{X}")
            continue
        if getpass.getpass("again: ") != pw:
            print(f"{Y}the two did not match{X}")
            continue
        auth.set_password(con, user, pw, actor="cli", source=src())
        print(f"{G}password set{X} for {B}{user}{X} (estimated time to crack offline: {v.crack_time}). "
              f"Every console session has been signed out.")
        return 0
    return 1


def cmd_sessions(a) -> int:
    con = db.connect()
    u = auth.get_user(con)
    if u is None:
        print("no console account yet: outcrop console passwd")
        return 1
    if a.revoke_all:
        n = con.execute("DELETE FROM sessions").rowcount
        db.add_event(con, "signin.out", f"all {n} console session(s) ended", actor="cli", source=src(), level="warn")
        print(f"ended {n} session(s)")
        return 0
    rows = auth.sessions_of(con, u["id"])
    if not rows:
        print("no one is signed in")
    for r in rows:
        print(f"{r['ip'] or '?':16s} last seen {datetime.fromtimestamp(r['last_seen_at']):%Y-%m-%d %H:%M}  "
              f"signed in {datetime.fromtimestamp(r['created_at']):%Y-%m-%d %H:%M}  {'remembered ' if r['remember'] else ''}"
              f"{D}{(r['user_agent'] or '')[:70]}{X}")
    return 0


def cmd_url(a) -> int:
    h = socket.gethostname()
    addrs = config.lan_addresses()
    print(f"https://{h}.local/" + (f"   (or https://{addrs[0]}/)" if addrs else ""))
    print(f"{D}First time on a device: http://{h}.local/ca has the certificate and the steps to trust it.{X}")
    return 0


def cmd_ca(a) -> int:
    st = tls.status()
    if not st.get("ca"):
        print("no CA yet: setup/install-console.sh creates it")
        return 1
    print(f"{B}CA fingerprint (SHA-256):{X}\n  {st['ca_fingerprint']}")
    print(f"{B}It can vouch only for:{X} {', '.join(st['constraints'])}")
    print(f"{B}CA valid until:{X} {st['ca_not_after'][:10]}")
    if st.get("server_not_after"):
        print(f"{B}Server certificate:{X} {', '.join(st['server_names'])}; valid until {st['server_not_after'][:10]} "
              f"({st['days_left']} days; renewed 30 days before)")
    print(f"{D}The certificate file: {tls.paths()['ca_crt']}  (also at http://{socket.gethostname()}.local/ca.crt){X}")
    return 0


def cmd_tls(a) -> int:
    if a.action == "ensure":
        r = tls.ensure(extra=a.add_name)
        print(f"TLS: {', '.join(r['made']) or 'nothing'} made; CA {r['ca_fingerprint'][:23]}…; server certificate for "
              f"{', '.join(r['names'])}" + (f"; {Y}outside the CA's names: {', '.join(r['outside_ca'])}{X}"
                                             if r["outside_ca"] else ""))
        return 0
    if a.action == "renew":
        before = tls.status()
        due = not before.get("days_left") or before["days_left"] < tls.RENEW_BEFORE_DAYS
        if a.if_due and not due and not a.add_name:
            print(f"the certificate is good for {before['days_left']} more days")
            return 0
        r = tls.ensure(force_server=True, extra=a.add_name)
        print(f"renewed: {', '.join(r['names'])}; valid until {r['server_not_after'][:10]}")
        if r["outside_ca"]:
            print(f"{Y}not covered (outside the CA's name constraints): {', '.join(r['outside_ca'])}. A new address needs a "
                  f"new CA: remove {tls.paths()['ca_key'].parent} and run setup/install-console.sh, then install the new CA "
                  f"on your devices.{X}")
        try:
            con = db.connect()
            db.add_event(con, "console.tls", f"server certificate renewed until {r['server_not_after'][:10]}", actor="cli",
                         source=src())
        except Exception:
            pass
        # The console and the gateway's HTTPS port (8443) load the certificate at start.  Restart them when nothing runs
        # (a chat answer, a switch, a request): the old certificate stays valid for weeks, so there is time to wait.
        outcrop = [sys.executable, str(config.PROJECT / "bin" / "outcrop")]
        problems = []
        if subprocess.run(["systemctl", "is-active", "-q", "outcrop-console.service"]).returncode == 0:
            subprocess.run([*outcrop, "gateway", "wait-idle", "--console", "--timeout", "3600"], capture_output=True)
            r1 = subprocess.run(["systemctl", "--no-ask-password", "try-restart", "outcrop-console.service"],
                                capture_output=True, text=True)
            if r1.returncode != 0:
                problems.append(f"the console was not restarted ({(r1.stderr or '').strip()[:160]})")
        if subprocess.run(["systemctl", "is-active", "-q", "outcrop-gateway.service"]).returncode == 0:
            r2 = subprocess.run([*outcrop, "gateway", "restart", "--when-idle", "--timeout", "3600"], capture_output=True,
                                text=True)
            if r2.returncode != 0:
                problems.append("the gateway was busy for an hour and was not restarted")
        if problems:
            msg = "the new certificate is not in use yet: " + "; ".join(problems) + " (it is at the next restart)"
            print(f"{Y}{msg}{X}", file=sys.stderr)
            try:
                db.add_event(db.connect(), "console.tls", msg, actor="cli", source=src(), level="error")
            except Exception:
                pass
            return 1
        return 0
    print(__doc__)
    return 2


def cmd_backup(a) -> int:
    from . import backup
    dest = Path(a.file or f"outcrop-backup-{time.strftime('%Y%m%d-%H%M%S')}{'-with-secrets' if a.secrets else ''}.tar.gz")
    _, meta = backup.make(dest, secrets=a.secrets, chats=not a.no_chats)
    c = meta["counts"]
    print(f"{G}backup{X} {dest} ({dest.stat().st_size / 1e6:.1f} MB): {c['tokens']} tokens, {c['requests']} requests, "
          f"{c['events']} events" + (f"; {Y}with secrets: keep it like a password{X}" if a.secrets else
                                     "; no secrets (tokens must be rotated after a restore)"))
    try:
        db.add_event(db.connect(), "backup.make", f"backup made{' with secrets' if a.secrets else ''}", actor="cli",
                     source=src(), level="warn" if a.secrets else "info")
    except Exception:
        pass
    return 0


def cmd_restore(a) -> int:
    from . import backup
    if sys.stdin.isatty() and not a.yes:
        if input(f"Replace the console's state with {a.file}? The gateway and console restart. [y/N] ").lower() != "y":
            return 1
    for u in ("outcrop-console.service", "outcrop-gateway.service"):
        subprocess.run(["systemctl", "--no-ask-password", "stop", u], capture_output=True)
    still = [u for u in ("outcrop-console.service", "outcrop-gateway.service")
             if subprocess.run(["systemctl", "is-active", "-q", u]).returncode == 0]
    if still:
        # they would go on writing into the database being replaced
        print(f"{R}could not stop {', '.join(still)}: nothing restored{X} (sudo systemctl stop them, then run this again)",
              file=sys.stderr)
        return 1
    try:
        meta = backup.restore(Path(a.file))
        if not meta.get("secrets"):
            # the backup had no token secrets: make the local tools' token again (outcrop, the lab, bench)
            from ..common import tokens
            tokens.ensure_local_token(db.connect(), tokens.load_pepper(), by="restore")
    finally:
        for u in ("outcrop-gateway.service", "outcrop-console.service"):
            subprocess.run(["systemctl", "--no-ask-password", "start", u], capture_output=True)
    print(f"{G}restored{X} the backup of {datetime.fromtimestamp(meta['made_at']):%Y-%m-%d %H:%M} from {meta['host']}"
          + ("" if meta.get("secrets") else f"; {Y}it had no secrets: rotate each token (outcrop token rotate NAME){X}")
          + (f"; the previous database is kept as {meta['previous_db']}" if meta.get("previous_db") else ""))
    return 0


def cmd_alerts(a) -> int:
    from .alerts import tg_find_chat, tg_load, tg_public, tg_save, tg_send
    act = a.action or "status"
    if act == "telegram":
        print("Telegram alerts. If you have not yet: talk to @BotFather in Telegram, send /newbot, and keep the token it gives;")
        print("then send your new bot any message (so it may write to you).\n")
        token = getpass.getpass("bot token (not shown): ").strip() if sys.stdin.isatty() else sys.stdin.readline().strip()
        if ":" not in token:
            print(f"{R}that does not look like a bot token (123456:ABC-...){X}")
            return 1
        info, msg = tg_find_chat(token)
        if info is None or not info.get("chat_id"):
            print(f"{R}{msg}{X}")
            return 1
        d = {"token": token, "enabled": True, **info}
        ok, why = tg_send(f"✓ {socket.gethostname()}: Telegram alerts are set up. You will get a message here when "
                          f"something needs you.", d)
        if not ok:
            print(f"{R}the test message failed: {why}{X}")
            return 1
        tg_save({**d, "last_ok": time.time()})
        try:
            db.add_event(db.connect(), "alerts.telegram", f"Telegram alerts set up (bot @{info.get('bot_username')})",
                         actor="cli", source=src())
        except Exception:
            pass
        print(f"{G}done{X}: @{info.get('bot_username')} will write to {info.get('chat_name')} (chat {info['chat_id']}). "
              f"A test message was sent.")
        return 0
    if act == "commands":
        from .tgcommands import set_enabled
        on = (a.value or "").lower() == "on"
        if (a.value or "").lower() not in ("on", "off"):
            print(f"Telegram commands are {'on' if tg_load().get('commands') else 'off'}: outcrop alerts commands on|off")
            return 0
        try:
            set_enabled(on)
        except ValueError as e:
            print(f"{R}{e}{X}")
            return 1
        db.add_event(db.connect(), "alerts.commands", f"Telegram commands turned {'on' if on else 'off'}", actor="cli",
                     source=src(), level="warn" if on else "info")
        print(f"Telegram commands {'on: /status, /switch PRESET, /close, /help from your chat' if on else 'off'}"
              + (" (the console picks this up within 10 s)" if on else ""))
        return 0
    if act == "test":
        ok, why = tg_send(f"ℹ {socket.gethostname()}: a test message (outcrop alerts test).")
        print("sent" if ok else f"{R}failed: {why}{X}")
        return 0 if ok else 1
    if act == "off":
        d = tg_load()
        if d:
            d["enabled"] = False
            tg_save(d)
        print("Telegram alerts off (the console still shows them)")
        return 0
    print(json.dumps(tg_public(), indent=1))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="outcrop console")
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("passwd")
    p.add_argument("--generate", action="store_true")
    p.add_argument("--user")
    s = sub.add_parser("sessions")
    s.add_argument("--revoke-all", action="store_true")
    sub.add_parser("url")
    sub.add_parser("ca")
    t = sub.add_parser("tls")
    t.add_argument("action", choices=["ensure", "renew"])
    t.add_argument("--add-name", action="append")
    t.add_argument("--if-due", action="store_true")
    b = sub.add_parser("backup")
    b.add_argument("file", nargs="?")
    b.add_argument("--secrets", action="store_true", help="also the keys and token secrets (keep it like a password)")
    b.add_argument("--no-chats", action="store_true", help="leave the saved chats out")
    r = sub.add_parser("restore")
    r.add_argument("file")
    r.add_argument("--yes", action="store_true")
    al = sub.add_parser("alerts")
    al.add_argument("action", nargs="?", choices=["telegram", "test", "status", "off", "commands"])
    al.add_argument("value", nargs="?", help="(commands) on | off")
    a = ap.parse_args(argv)
    fn = {"passwd": cmd_passwd, "sessions": cmd_sessions, "url": cmd_url, "ca": cmd_ca, "tls": cmd_tls,
          "backup": cmd_backup, "restore": cmd_restore, "alerts": cmd_alerts}.get(a.cmd)
    if fn is None:
        print(__doc__)
        return 2
    return fn(a)


if __name__ == "__main__":
    sys.exit(main())
