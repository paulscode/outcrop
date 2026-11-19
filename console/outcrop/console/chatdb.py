"""The saved chats (docs/CHAT-API.md): spaces, chats, messages as a tree, and a search index.  Its own SQLite file,
~/.outcrop/state/chats.db (0600), apart from the console's operational data: it can be backed up, left out or wiped alone.

Messages form a tree (parent_id): editing a question or asking for another answer adds a sibling, so earlier versions stay
(‹ 2 / 3 ›).  A chat's `head` is the newest message of the branch on screen; the conversation is the path from the root
to it.  Search: an FTS5 index with the trigram tokenizer over titles and the visible text of messages (not web pages).
"""
from __future__ import annotations

import difflib
import json
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from ..common import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS spaces(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '', web INTEGER, thinking INTEGER, sort REAL NOT NULL DEFAULT 0,
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS chats(
  id TEXT PRIMARY KEY, space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '', title_source TEXT NOT NULL DEFAULT 'none',
  pinned INTEGER NOT NULL DEFAULT 0, web INTEGER NOT NULL DEFAULT 1, thinking INTEGER NOT NULL DEFAULT 1,
  head TEXT, suggested_space TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS chats_updated ON chats(updated_at DESC);
CREATE INDEX IF NOT EXISTS chats_space ON chats(space_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, parent_id TEXT,
  role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '[]', sources TEXT NOT NULL DEFAULT '[]', images TEXT NOT NULL DEFAULT '[]',
  stats TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'done', error TEXT, created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS messages_parent ON messages(parent_id);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(text, chat_id UNINDEXED, msg_id UNINDEXED, tokenize='trigram');
"""
TITLE_MAX = 80
NAME_MAX = 40
INSTR_MAX = 8000
CONTENT_MAX = 200_000                 # bytes of text in one message
COLORS = ("", "slate", "red", "orange", "amber", "green", "teal", "sky", "blue", "violet", "pink")


def new_id(prefix: str) -> str:
    return prefix + secrets.token_hex(6)


def path_of(db_path: Path | None = None) -> Path:
    if db_path is not None:
        return Path(db_path).with_name("chats.db")
    return config.STATE / "chats.db"


def connect(p: Path) -> sqlite3.Connection:
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.touch(mode=0o600)
    con = sqlite3.connect(str(p), timeout=10, isolation_level=None, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA secure_delete=ON")             # a deleted chat's text is overwritten, not left in free pages
    con.executescript(SCHEMA)
    try:                                               # FTS5 overwrites a deleted row's index entries too (SQLite 3.42+)
        on = con.execute("SELECT v FROM search_config WHERE k='secure-delete'").fetchone()
        if not on or not on[0]:
            con.execute("INSERT INTO search(search, rank) VALUES('secure-delete', 1)")
    except sqlite3.OperationalError:
        pass
    return con


def scrub(con) -> None:
    """After deleting.  secure_delete (the table's pages) and FTS5's secure-delete (the search index) have already
    overwritten the deleted text in place; a PASSIVE checkpoint then copies those pages into chats.db without waiting for
    anyone.  Old copies of the pages in chats.db-wal, and old index segments, go at the next maintain()."""
    try:
        con.execute("PRAGMA wal_checkpoint(PASSIVE)")
    except sqlite3.OperationalError:
        pass


def maintain(con) -> None:
    """Now and then (Runner.maintain_loop, daily): merge the search index and empty the WAL (TRUNCATE waits for readers
    and writers, so it is not done on every delete)."""
    try:
        con.execute("INSERT INTO search(search) VALUES('optimize')")
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except sqlite3.OperationalError:
        pass                                           # busy: tomorrow


def as_bool(body: dict, k: str, nullable: bool = False):
    """A JSON boolean (or null when allowed), else ValueError: "false" as a string must not mean true."""
    v = body.get(k)
    if isinstance(v, bool) or (nullable and v is None):
        return v
    raise ValueError(f"{k} is true or false" + (" or null" if nullable else ""))


@contextmanager
def tx(con: sqlite3.Connection):
    con.execute("BEGIN IMMEDIATE")
    try:
        yield con
    except BaseException:
        con.execute("ROLLBACK")
        raise
    con.execute("COMMIT")


# ------------------------------------------------------------------------------------------------------------ rows

def _chat(r: sqlite3.Row | None, extra: dict | None = None) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    d["pinned"], d["web"], d["thinking"] = bool(d["pinned"]), bool(d["web"]), bool(d["thinking"])
    return d | (extra or {})


def _msg(r: sqlite3.Row) -> dict:
    d = dict(r)
    for k in ("tools", "sources", "images", "stats"):
        d[k] = json.loads(d[k] or ("{}" if k == "stats" else "[]"))
    return d


def _space(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["web"] = None if d["web"] is None else bool(d["web"])
    d["thinking"] = None if d["thinking"] is None else bool(d["thinking"])
    return d


# ---------------------------------------------------------------------------------------------------------- spaces

def clean_space(body: dict, partial: bool = False) -> dict:
    out = {}
    if "name" in body or not partial:
        name = re.sub(r"\s+", " ", str(body.get("name") or "")).strip()
        if not name:
            raise ValueError("a space needs a name")
        out["name"] = name[:NAME_MAX]
    if "emoji" in body:
        out["emoji"] = str(body.get("emoji") or "")[:8]
    if "color" in body:
        c = str(body.get("color") or "")
        if c not in COLORS:
            raise ValueError("color is one of " + ", ".join(c for c in COLORS if c))
        out["color"] = c
    if "instructions" in body:
        out["instructions"] = str(body.get("instructions") or "")[:INSTR_MAX]
    for k in ("web", "thinking"):
        if k in body:
            v = as_bool(body, k, nullable=True)
            out[k] = None if v is None else int(v)
    return out


def spaces(con) -> list[dict]:
    rows = con.execute("SELECT s.*, (SELECT count(*) FROM chats c WHERE c.space_id=s.id) AS chats "
                       "FROM spaces s ORDER BY sort, created_at").fetchall()
    return [_space(r) for r in rows]


def space(con, sid: str) -> dict | None:
    r = con.execute("SELECT s.*, (SELECT count(*) FROM chats c WHERE c.space_id=s.id) AS chats FROM spaces s WHERE id=?",
                    (sid,)).fetchone()
    return _space(r) if r else None


def create_space(con, body: dict) -> dict:
    d = clean_space(body)
    if con.execute("SELECT 1 FROM spaces WHERE lower(name)=lower(?)", (d["name"],)).fetchone():
        raise ValueError(f"there is already a space called {d['name']}")
    now = time.time()
    sid = new_id("s")
    top = con.execute("SELECT coalesce(max(sort), 0) FROM spaces").fetchone()[0]
    con.execute("INSERT INTO spaces(id, name, emoji, color, instructions, web, thinking, sort, created_at, updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)", (sid, d["name"], d.get("emoji", ""), d.get("color", ""),
                                                d.get("instructions", ""), d.get("web"), d.get("thinking"), top + 1, now, now))
    return space(con, sid)


def update_space(con, sid: str, body: dict) -> dict:
    if space(con, sid) is None:
        raise KeyError(sid)
    d = clean_space(body, partial=True)
    if "name" in d and con.execute("SELECT 1 FROM spaces WHERE lower(name)=lower(?) AND id<>?", (d["name"], sid)).fetchone():
        raise ValueError(f"there is already a space called {d['name']}")
    if d:
        con.execute(f"UPDATE spaces SET {', '.join(k + '=?' for k in d)}, updated_at=? WHERE id=?",
                    (*d.values(), time.time(), sid))
    return space(con, sid)


def order_spaces(con, ids: list[str]) -> list[dict]:
    with tx(con):
        for i, sid in enumerate(ids):
            con.execute("UPDATE spaces SET sort=? WHERE id=?", (i + 1, sid))
    return spaces(con)


def delete_space(con, sid: str, chats_too: bool) -> dict:
    sp = space(con, sid)
    if sp is None:
        raise KeyError(sid)
    with tx(con):
        ids = [r[0] for r in con.execute("SELECT id FROM chats WHERE space_id=?", (sid,))]
        if chats_too:
            for cid in ids:
                _delete_chat(con, cid)
        else:
            con.execute("UPDATE chats SET space_id=NULL WHERE space_id=?", (sid,))
        con.execute("UPDATE chats SET suggested_space=NULL WHERE suggested_space=?", (sid,))
        con.execute("DELETE FROM spaces WHERE id=?", (sid,))
    if chats_too and ids:
        scrub(con)
    return {"space": sp, "chats": len(ids), "deleted_chats": len(ids) if chats_too else 0,
            "ids": ids if chats_too else []}


# ----------------------------------------------------------------------------------------------------------- chats

LIST_COLS = ("c.id, c.space_id, c.title, c.title_source, c.pinned, c.web, c.thinking, c.head, c.suggested_space, "
             "c.created_at, c.updated_at, (SELECT count(*) FROM messages m WHERE m.chat_id=c.id) AS messages")


def list_chats(con, space_id: str | None = None, limit: int = 500, before: float | None = None) -> list[dict]:
    where, args = [], []
    if space_id == "none":
        where.append("c.space_id IS NULL")
    elif space_id:
        where.append("c.space_id=?")
        args.append(space_id)
    if before:
        where.append("c.updated_at<?")
        args.append(before)
    sql = f"SELECT {LIST_COLS} FROM chats c" + (" WHERE " + " AND ".join(where) if where else "") + \
        " ORDER BY c.updated_at DESC LIMIT ?"
    return [_chat(r) for r in con.execute(sql, (*args, min(max(limit, 1), 2000)))]


def chat(con, cid: str) -> dict | None:
    return _chat(con.execute(f"SELECT {LIST_COLS} FROM chats c WHERE c.id=?", (cid,)).fetchone())


def create_chat(con, space_id: str | None = None, web: bool = True, thinking: bool = True) -> dict:
    if space_id and space(con, space_id) is None:
        raise ValueError("no such space")
    now = time.time()
    cid = new_id("c")
    con.execute("INSERT INTO chats(id, space_id, web, thinking, created_at, updated_at) VALUES(?,?,?,?,?,?)",
                (cid, space_id or None, int(bool(web)), int(bool(thinking)), now, now))
    return chat(con, cid)


def set_title(con, cid: str, title: str, source: str) -> None:
    title = re.sub(r"\s+", " ", title).strip().strip('"').strip()[:TITLE_MAX]
    if not con.execute("UPDATE chats SET title=?, title_source=? WHERE id=?", (title, source, cid)).rowcount:
        return                                         # deleted meanwhile: no search row left behind
    con.execute("DELETE FROM search WHERE chat_id=? AND msg_id=''", (cid,))
    if title:
        con.execute("INSERT INTO search(text, chat_id, msg_id) VALUES(?,?,'')", (title, cid))


def update_chat(con, cid: str, body: dict) -> dict:
    c = chat(con, cid)
    if c is None:
        raise KeyError(cid)
    flags = {k: int(as_bool(body, k)) for k in ("pinned", "web", "thinking") if k in body}
    with tx(con):
        if "title" in body:
            t = str(body.get("title") or "").strip()
            if not t:
                raise ValueError("a title cannot be empty")
            set_title(con, cid, t, "user")
        if "space_id" in body:
            sid = body.get("space_id") or None
            if sid and space(con, sid) is None:
                raise ValueError("no such space")
            con.execute("UPDATE chats SET space_id=?, suggested_space=NULL WHERE id=?", (sid, cid))
        if "suggested_space" in body and body["suggested_space"] is None:
            con.execute("UPDATE chats SET suggested_space=NULL WHERE id=?", (cid,))
        for k, v in flags.items():
            con.execute(f"UPDATE chats SET {k}=? WHERE id=?", (v, cid))
    return chat(con, cid)


def touch(con, cid: str) -> None:
    con.execute("UPDATE chats SET updated_at=? WHERE id=?", (time.time(), cid))


def _delete_chat(con, cid: str) -> int:
    n = con.execute("SELECT count(*) FROM messages WHERE chat_id=?", (cid,)).fetchone()[0]
    con.execute("DELETE FROM search WHERE chat_id=?", (cid,))
    con.execute("DELETE FROM messages WHERE chat_id=?", (cid,))
    con.execute("DELETE FROM chats WHERE id=?", (cid,))
    return n


def delete_chats(con, ids: list[str]) -> dict:
    with tx(con):
        found = [cid for cid in ids if con.execute("SELECT 1 FROM chats WHERE id=?", (cid,)).fetchone()]
        n = sum(_delete_chat(con, cid) for cid in found)
    if found:
        scrub(con)
    return {"chats": len(found), "messages": n, "ids": found}


def move_chats(con, ids: list[str], space_id: str | None) -> int:
    if space_id and space(con, space_id) is None:
        raise ValueError("no such space")
    with tx(con):
        n = 0
        for cid in ids:
            n += con.execute("UPDATE chats SET space_id=?, suggested_space=NULL WHERE id=?", (space_id, cid)).rowcount
    return n


# -------------------------------------------------------------------------------------------------------- messages

def add_message(con, cid: str, parent_id: str | None, role: str, content: str = "", images=None, status: str = "done",
                stats: dict | None = None) -> dict:
    mid = new_id("m")
    con.execute("INSERT INTO messages(id, chat_id, parent_id, role, content, images, status, stats, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?)", (mid, cid, parent_id, role, content, json.dumps(images or []), status,
                                              json.dumps(stats or {}), time.time()))
    con.execute("UPDATE chats SET head=?, updated_at=? WHERE id=?", (mid, time.time(), cid))
    if role == "user" and content.strip():
        con.execute("INSERT INTO search(text, chat_id, msg_id) VALUES(?,?,?)", (content, cid, mid))
    return message(con, mid)


def message(con, mid: str) -> dict | None:
    r = con.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
    return _msg(r) if r else None


def save_message(con, mid: str, **fields) -> None:
    """Write a message's progress (content, reasoning, tools, sources, stats, status, error)."""
    cols, vals = [], []
    for k, v in fields.items():
        if k in ("tools", "sources", "stats"):
            v = json.dumps(v)
        cols.append(f"{k}=?")
        vals.append(v)
    if cols:
        con.execute(f"UPDATE messages SET {', '.join(cols)} WHERE id=?", (*vals, mid))


def index_answer(con, mid: str) -> None:
    m = message(con, mid)
    if m and m["content"].strip():
        con.execute("DELETE FROM search WHERE msg_id=?", (mid,))
        con.execute("INSERT INTO search(text, chat_id, msg_id) VALUES(?,?,?)", (m["content"], m["chat_id"], mid))


MSG_COLS = ("id, chat_id, parent_id, role, content, reasoning, tools, sources, stats, status, error, created_at")


def path(con, cid: str, head: str | None = None, images: bool = True) -> list[dict]:
    """The conversation on screen: root .. head, each with its versions ({index, count, ids}).  The tree is read from
    ids alone, and only the messages on the path are loaded; `images=False` leaves pictures out (as [])."""
    c = con.execute("SELECT head FROM chats WHERE id=?", (cid,)).fetchone()
    if c is None:
        return []
    tree = {r[0]: r[1] for r in con.execute("SELECT id, parent_id FROM messages WHERE chat_id=? ORDER BY created_at",
                                             (cid,))}
    kids: dict = {}
    for mid, parent in tree.items():
        kids.setdefault(parent, []).append(mid)
    ids, cur, seen = [], head or c["head"], set()
    while cur and cur in tree and cur not in seen:
        seen.add(cur)
        ids.append(cur)
        cur = tree[cur]
    ids.reverse()
    if not ids:
        return []
    cols = "*" if images else MSG_COLS + ", '[]' AS images"
    rows = {r["id"]: r for r in con.execute(f"SELECT {cols} FROM messages WHERE id IN ({','.join('?' * len(ids))})",
                                            ids)}
    res = []
    for mid in ids:
        sib = kids.get(tree[mid], [mid])
        res.append(_msg(rows[mid]) | {"versions": {"index": sib.index(mid), "count": len(sib), "ids": sib}})
    return res


def latest_leaf(con, cid: str, mid: str) -> str:
    """From a message down to the newest message under it: switching to a version shows that version's whole branch."""
    cur = mid
    for _ in range(10000):
        r = con.execute("SELECT id FROM messages WHERE chat_id=? AND parent_id=? ORDER BY created_at DESC LIMIT 1",
                        (cid, cur)).fetchone()
        if r is None:
            return cur
        cur = r[0]
    return cur


def set_head(con, cid: str, mid: str) -> None:
    if not con.execute("SELECT 1 FROM messages WHERE id=? AND chat_id=?", (mid, cid)).fetchone():
        raise KeyError(mid)
    con.execute("UPDATE chats SET head=? WHERE id=?", (latest_leaf(con, cid, mid), cid))


# ---------------------------------------------------------------------------------------------------------- search

WORD = re.compile(r"[\w'’-]+", re.U)
SCORE_WINDOW = 20_000                 # the fuzzy match reads this much of a message (an exact word is found anywhere)


def _trigrams(s: str) -> set[str]:
    s = s.lower()
    return {s[i:i + 3] for i in range(len(s) - 2)}


def _q(t: str) -> str:
    return '"' + t.replace('"', '""') + '"'


def search(con, q: str, space_id: str | None = None, limit: int = 30) -> list[dict]:
    """Chats matching `q`, best first, each with its best snippet and the ranges to highlight.  Forgiving: words match
    inside longer words ("boil" finds "boiler"), and a typo still finds the chat ("kubernets" finds "Kubernetes") through
    shared three-letter groups.  `in:NAME` narrows to a space."""
    m = re.search(r"\bin:(\S+)", q)
    if m:
        want = m.group(1).lower()
        for sp in spaces(con):
            if re.sub(r"\W", "", sp["name"].lower()).startswith(re.sub(r"\W", "", want)):
                space_id = sp["id"]
                break
        else:
            return []
        q = (q[:m.start()] + q[m.end():]).strip()
    words = [w for w in WORD.findall(q.lower()) if w]
    space_filter = ""
    sargs: list = []
    if space_id:
        space_filter = " AND chat_id IN (SELECT id FROM chats WHERE space_id=?)" if space_id != "none" else \
            " AND chat_id IN (SELECT id FROM chats WHERE space_id IS NULL)"
        sargs = [space_id] if space_id != "none" else []
    if not words:
        if not space_id:
            return []
        return [{"chat": c, "score": 0, "snippet": None, "msg_id": None} for c in list_chats(con, space_id, limit)]

    cand: dict = {}                                      # (chat, msg) -> text
    long_words = [w for w in words if len(w) >= 3]
    short_words = [w for w in words if len(w) < 3]
    if long_words:
        exact = " AND ".join(_q(w) for w in long_words)
        for r in con.execute(f"SELECT chat_id, msg_id, text FROM search WHERE search MATCH ?{space_filter} "
                             "ORDER BY rank LIMIT 300", (exact, *sargs)):
            cand[(r[0], r[1])] = r[2]
        grams = set()
        for w in long_words:
            if len(w) >= 4:
                grams |= _trigrams(w)
        if grams:
            loose = " OR ".join(_q(g) for g in sorted(grams))
            for r in con.execute(f"SELECT chat_id, msg_id, text FROM search WHERE search MATCH ?{space_filter} "
                                 "ORDER BY rank LIMIT 400", (loose, *sargs)):
                cand.setdefault((r[0], r[1]), r[2])
        if any(4 <= len(w) <= 6 for w in long_words):
            # a typo in a short word shares no letter groups ("rsut", "rust"): titles are few, so look at them all
            for r in con.execute("SELECT s.chat_id, s.msg_id, s.text FROM search s JOIN chats c ON c.id=s.chat_id "
                                 f"WHERE s.msg_id=''{space_filter} ORDER BY c.updated_at DESC LIMIT 5000",
                                 tuple(sargs)):
                cand.setdefault((r[0], r[1]), r[2])
    else:                                                # one or two letters: titles that contain them
        like = re.sub(r"([\\%_])", r"\\\1", short_words[0])
        for r in con.execute(f"SELECT chat_id, msg_id, text FROM search WHERE msg_id='' AND text LIKE ? ESCAPE '\\'"
                             f"{space_filter} LIMIT 200", (f"%{like}%", *sargs)):
            cand[(r[0], r[1])] = r[2]

    now = time.time()
    best: dict = {}
    for (cid, mid), text in cand.items():
        s, ranges = _score(text, words)
        if s <= 0:
            continue
        if mid == "":
            s *= 3                                           # titles count most
        if s > best.get(cid, (0,))[0]:
            best[cid] = (s, mid, text, ranges)
    if not best:
        return []
    out = []
    for cid, (s, mid, text, ranges) in best.items():
        c = chat(con, cid)
        if c is None:
            continue
        age_days = max(0.0, (now - c["updated_at"]) / 86400)
        score = s * (1 + 0.25 / (1 + age_days / 7))          # recent chats a little higher
        out.append({"chat": c, "score": round(score, 3), "msg_id": mid or None,
                    "snippet": None if mid == "" else _snippet(text, ranges)})
    out.sort(key=lambda x: -x["score"])
    return out[:limit]


def _score(text: str, words: list[str]) -> tuple[float, list[tuple[int, int]]]:
    """How well `text` matches: 1 per word found as written, else the share of its letter groups found in one word of
    the text (at least 60%; or a close spelling, for swapped letters), squared.  And where (for the highlight)."""
    low = text.lower()
    tokens = None                                         # only for a word not found as written, and only the start
    total, ranges = 0.0, []
    for w in words:
        i = low.find(w)
        if i >= 0:
            total += 1.0
            ranges.append((i, i + len(w)))
            continue
        if len(w) < 4:
            continue
        if tokens is None:
            tokens = [(m.start(), m.end(), m.group(0)) for m in WORD.finditer(low, 0, SCORE_WINDOW)]
        if len(w) <= 6:                                   # short words: one slip (a letter wrong, missing, extra or swapped)
            hit = next(((a, b) for a, b, tok in tokens if _one_slip(w, tok)), None)
            if hit:
                total += 0.7
                ranges.append(hit)
                continue
        g = _trigrams(w)
        bestf, bestr = 0.0, None
        for a, b, tok in tokens:
            if abs(len(tok) - len(w)) > max(3, len(w) // 2):
                continue
            f = len(g & _trigrams(tok)) / len(g)
            if f < 0.6 and f >= 0.3:                         # swapped letters break letter groups, not similarity
                r = difflib.SequenceMatcher(None, w, tok).ratio()
                f = max(f, 0.6 + (r - 0.8) if r >= 0.8 else f)
            if f > bestf:
                bestf, bestr = f, (a, b)
        if bestf >= 0.6:
            total += bestf * bestf
            ranges.append(bestr)
    if total == 0:
        return 0.0, []
    return total / len(words), sorted(set(ranges))


def _one_slip(a: str, b: str) -> bool:
    """True when b is a with one letter changed, added, removed, or two neighbours swapped."""
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        d = [i for i in range(len(a)) if a[i] != b[i]]
        return len(d) == 1 or (len(d) == 2 and d[1] == d[0] + 1 and a[d[0]] == b[d[1]] and a[d[1]] == b[d[0]])
    s, t = (a, b) if len(a) < len(b) else (b, a)
    return any(t[:i] + t[i + 1:] == s for i in range(len(t)))


def _snippet(text: str, ranges: list[tuple[int, int]], width: int = 160) -> dict:
    if not ranges:
        return {"text": text[:width], "highlights": []}
    a = ranges[0][0]
    start = max(0, a - width // 3)
    if start > 0:
        sp = text.rfind(" ", 0, start + 1)
        start = sp + 1 if sp >= 0 and a - sp < width // 2 else start
    end = min(len(text), start + width)
    piece = text[start:end]
    pre = "…" if start > 0 else ""
    post = "…" if end < len(text) else ""
    hl = [[len(pre) + x - start, len(pre) + y - start] for x, y in ranges if x >= start and y <= end]
    return {"text": (pre + piece + post).replace("\n", " "), "highlights": hl}


# ----------------------------------------------------------------------------------------------------------- stats

def stats(con, since: float) -> dict:
    """Counts for Overview: chats, messages, and what the web tools did since `since` (searches, pages, refusals)."""
    out = {"chats": con.execute("SELECT count(*) FROM chats").fetchone()[0],
           "messages": con.execute("SELECT count(*) FROM messages").fetchone()[0],
           "spaces": con.execute("SELECT count(*) FROM spaces").fetchone()[0],
           "answers": 0, "searches": 0, "pages": 0, "refused": 0, "since": since}
    for (tools,) in con.execute("SELECT tools FROM messages WHERE role='assistant' AND created_at>=?", (since,)):
        out["answers"] += 1
        for t in json.loads(tools or "[]"):
            if t.get("name") == "web_search" and t.get("state") == "done":
                out["searches"] += 1
            elif t.get("name") == "open_page" and t.get("state") == "done":
                out["pages"] += 1
            if t.get("state") == "refused":
                out["refused"] += 1
    return out


# ---------------------------------------------------------------------------------------------------------- export

def export_markdown(con, cid: str) -> str:
    c = chat(con, cid)
    if c is None:
        raise KeyError(cid)
    lines = [f"# {c['title'] or 'Chat'}", "", f"_{time.strftime('%Y-%m-%d %H:%M', time.localtime(c['created_at']))}_", ""]
    for m in path(con, cid):
        who = {"user": "You", "assistant": "Assistant", "note": "Note"}.get(m["role"], m["role"])
        lines += [f"## {who}", "", m["content"].strip() or "_(no text)_", ""]
        if m["sources"]:
            lines += ["Sources:"] + [f"{i + 1}. [{s.get('title') or s.get('url')}]({s.get('url')})"
                                     for i, s in enumerate(m["sources"])] + [""]
    return "\n".join(lines)


def export_all(con) -> dict:
    """Everything: every space, every chat (no cap), every message with its versions."""
    chats = [_chat(r) for r in con.execute(f"SELECT {LIST_COLS} FROM chats c ORDER BY c.updated_at DESC")]
    return {"exported_at": time.time(), "spaces": spaces(con),
            "chats": [c | {"messages": [_msg(r) for r in con.execute(
                "SELECT * FROM messages WHERE chat_id=? ORDER BY created_at", (c["id"],))]} for c in chats]}
