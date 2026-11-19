"""Backups: without secrets they carry no token HMACs or keys; with secrets a restore brings the tokens back."""
import tarfile

from outcrop.common import config, db, tokens
from outcrop.console import backup, chatdb


def test_backup_and_restore(tmp_path, monkeypatch):
    state = tmp_path / "state"
    monkeypatch.setattr(config, "STATE", state)
    monkeypatch.setattr(config, "DB_PATH", state / "outcrop.db")
    monkeypatch.setattr(config, "PEPPER_FILE", state / "pepper")
    config.ensure_state_dir()
    pepper = tokens.load_pepper()
    con = db.connect()
    _, plain = tokens.create(con, pepper, "app")
    db.set_setting(con, "auth.mode", {"mode": "enforced"})
    con.close()
    (state / "upstream_key").write_text("internal\n")
    cdb = chatdb.connect(state / "chats.db")
    ch = chatdb.create_chat(cdb)
    chatdb.add_message(cdb, ch["id"], None, "user", "keep me")
    cdb.close()

    plain_tar, meta = backup.make(tmp_path / "b.tar.gz", secrets=False)
    names = tarfile.open(tmp_path / "b.tar.gz").getnames()
    assert "outcrop-backup/state/pepper" not in names and "outcrop-backup/state/upstream_key" not in names
    assert meta["counts"]["token_secrets"] == 0 and meta["counts"]["tokens"] == 1
    assert oct((tmp_path / "b.tar.gz").stat().st_mode)[-3:] == "600"
    assert "outcrop-backup/state/chats.db" in names and meta["counts"]["chat_messages"] == 1
    _, m2 = backup.make(tmp_path / "n.tar.gz", chats=False)
    assert "outcrop-backup/state/chats.db" not in tarfile.open(tmp_path / "n.tar.gz").getnames() and not m2["chats"]

    backup.make(tmp_path / "s.tar.gz", secrets=True)
    assert "outcrop-backup/state/pepper" in tarfile.open(tmp_path / "s.tar.gz").getnames()

    # lose everything, then restore with secrets: the token works again
    for f in state.iterdir():
        if f.is_file():
            f.unlink()
    m = backup.restore(tmp_path / "s.tar.gz")
    assert m["secrets"] is True
    cache = tokens.TokenCache(tokens.load_pepper(create=False))
    cache.load(db.connect())
    assert cache.lookup(plain).status == "ok"
    assert oct((state / "pepper").stat().st_mode)[-3:] == "600"
    assert db.events(db.connect(), 3, kinds=["backup.restore"])
    assert chatdb.path(chatdb.connect(state / "chats.db"), ch["id"])[0]["content"] == "keep me"


def test_restore_refuses_foreign_archives(tmp_path):
    bad = tmp_path / "bad.tar.gz"
    with tarfile.open(bad, "w:gz") as t:
        (tmp_path / "x").write_text("x")
        t.add(tmp_path / "x", arcname="etc/passwd")
    try:
        backup.restore(bad)
    except ValueError as e:
        assert "not an Outcrop backup" in str(e)
    else:
        raise AssertionError("accepted a foreign archive")
