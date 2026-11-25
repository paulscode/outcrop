"""Following hardware changes (lib/profiles.py hardware(), follow()) and keeping one model pack ("Models to keep"):
less RAM moves to the profile that fits at the next start; more RAM or another GPU is only offered; a small disk keeps
the boot preset's pack only, and the packs no longer kept are removed (never the shared files)."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

import outcrop_control as LC
import profiles as P

ROOT = Path(__file__).resolve().parents[2]
M6000 = {"name": "Quadro M6000 24GB", "vram_mib": 24576, "memory": "discrete", "pcie": "Gen3 x16", "index": "0", "uuid": "GPU-2"}
GB10 = {"name": "NVIDIA GB10", "vram_mib": 0, "memory": "unified", "pcie": "Gen1 x1", "index": "0", "uuid": "GPU-1"}


def machine(ram, gpu=M6000, arch="x86_64"):
    return {"gpus": [gpu], "ram_gib": ram, "cpus": 36, "os": {}, "driver": "580.178.04", "arch": arch,
            "disk": {"path": "/x", "free_gb": 500}}


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A machine of its own: presets.json, the state and the packs under tmp_path."""
    monkeypatch.setattr(P, "OUTCROP_HOME", tmp_path)
    monkeypatch.setattr(P, "PRESETS_FILE", tmp_path / "presets.json")
    monkeypatch.setattr(P, "STATE", tmp_path / "state")
    monkeypatch.setattr(P, "HARDWARE_FILE", tmp_path / "state" / "hardware.json")
    monkeypatch.setattr(P, "PACKS_NOTICE", tmp_path / "state" / "packs-notice.txt")
    (tmp_path / "state").mkdir()
    return tmp_path


def install(home, profile, ram, boot=None, settings=None, monkeypatch=None):
    """presets.json from `profile`, as the first start makes it, on a machine with `ram` GiB."""
    monkeypatch.setattr(P, "facts", lambda: machine(ram))
    P.apply(profile)
    if settings:
        c = P.current()
        c["settings"] = settings
        P.PRESETS_FILE.write_text(json.dumps(c))
    if boot:
        (home / "state" / "default_preset").write_text(boot + "\n")


def make_pack(home, pack):
    q = pack.upper()
    d = home / "models" / q
    d.mkdir(parents=True, exist_ok=True)
    (d / f"Qwen3.8-Flash-Next-GSQ-RCO-{q}-00001-of-00002.gguf").write_bytes(b"x" * 10)
    (d / f"Qwen3.8-Flash-Next-GSQ-RCO-{q}-00001-of-00002.gguf.ok").write_text("ok")
    (home / "models" / f"{q}-q8dense").mkdir(exist_ok=True)
    p = home / "data" / "packs" / pack
    p.mkdir(parents=True, exist_ok=True)
    (p / "native_experts.txt").write_text("1")


def test_the_profile_that_fits_against_the_one_installed(home, monkeypatch):
    install(home, "m6000-32g", 31, monkeypatch=monkeypatch)
    assert P.hardware(None, machine(31))["change"] == "none"
    assert P.hardware(None, machine(47))["change"] == "none"          # 48 GB of sticks: still the 32 GB profile
    up = P.hardware(None, machine(63))
    assert (up["change"], up["fits"]) == ("more", "m6000-64g")
    assert up["new_packs"] == ["q2_0", "iq3_xxs", "iq3_s"] and up["download_gb"] > 0     # nothing on disk here
    assert "63 GiB" in up["message"] and "until you apply it" in up["message"]
    make_pack(home, "q2_0")
    make_pack(home, "iq3_xxs")
    up = P.hardware(None, machine(63))
    assert up["new_packs"] == ["iq3_s"] and up["download_gb"] == P.PACK_GB["iq3_s"]
    # a GB10 under an M6000 profile: another GPU, offered, never moved by itself
    assert P.hardware(None, machine(121, GB10, "aarch64"))["change"] == "other"
    assert P.hardware(None, machine(121, GB10, "aarch64"))["fits"] == "gb10-128g"


def test_less_ram_moves_to_the_profile_that_fits(home, monkeypatch):
    install(home, "m6000-128g", 126, boot="quality-1m", settings={"exact_answers": "on"}, monkeypatch=monkeypatch)
    monkeypatch.setattr(P, "facts", lambda: machine(31))
    h = P.follow(machine(31))
    assert h["change"] == "less" and h["moved"]["to"] == "m6000-32g"
    c = P.current()
    assert c["profile"]["name"] == "m6000-32g" and set(c["presets"]) == {"speed", "balanced"}
    assert c["settings"] == {"exact_answers": "on"}                    # the user's choices are kept
    # the boot preset is gone from the smaller profile: its default instead
    assert (home / "state" / "default_preset").read_text().strip() == "speed"
    assert "quality-1m" in h["moved"]["presets_gone"] and "boot preset is now speed" in h["message"]
    assert P.last_move()["from"] == "m6000-128g"
    assert list(home.glob("presets.json.*.bak"))                       # the old file is kept
    # the next start: nothing more to do
    assert P.follow(machine(31))["change"] == "none"


def test_less_ram_keeps_a_boot_preset_the_smaller_profile_has(home, monkeypatch):
    install(home, "m6000-64g", 63, boot="balanced", monkeypatch=monkeypatch)
    monkeypatch.setattr(P, "facts", lambda: machine(31))
    h = P.follow(machine(31))
    assert h["moved"]["boot"] == "balanced" and "boot preset is now" not in h["message"]


def test_more_ram_is_only_offered(home, monkeypatch):
    install(home, "m6000-32g", 31, monkeypatch=monkeypatch)
    before = P.PRESETS_FILE.read_text()
    h = P.follow(machine(126))
    assert h["change"] == "more" and "moved" not in h and P.PRESETS_FILE.read_text() == before
    assert P.last_move() is None


def test_a_small_disk_keeps_only_the_boot_presets_pack(home, monkeypatch):
    install(home, "m6000-32g", 31, monkeypatch=monkeypatch)
    monkeypatch.setattr(P, "disk_free_gb", lambda: 230)               # a 256 GB drive: more than one pack, less than two
    assert P.wanted_packs(P.current()) == ["q2_0", "iq3_xxs"]
    msg = P.first_packs(P.current())
    assert msg and "only the boot preset's pack (q2_0" in msg
    c = P.current()
    assert c["settings"]["packs"] == "boot" and P.wanted_packs(c) == ["q2_0"]
    assert P.first_packs(c) is None                                     # chosen once; the user may change it after
    assert P.take_packs_notice() == msg and P.take_packs_notice() is None   # told once


def test_a_disk_big_enough_keeps_every_pack(home, monkeypatch):
    install(home, "m6000-32g", 31, monkeypatch=monkeypatch)
    monkeypatch.setattr(P, "disk_free_gb", lambda: 900)
    assert P.first_packs(P.current()) is None
    assert "packs" not in (P.current().get("settings") or {})


def test_the_boot_presets_pack_follows_the_boot_preset(home, monkeypatch):
    install(home, "m6000-32g", 31, boot="balanced", settings={"packs": "boot"}, monkeypatch=monkeypatch)
    assert P.wanted_packs(P.current()) == ["iq3_xxs"]


def test_packs_no_longer_kept_are_removed_and_never_the_shared_files(home, monkeypatch):
    install(home, "m6000-32g", 31, boot="speed", monkeypatch=monkeypatch)
    for p in ("q2_0", "iq3_xxs", "iq3_s"):                            # iq3_s: left from a bigger profile
        make_pack(home, p)
    shared = [home / "models" / "ngram", home / "models" / "vision", home / "data" / "mtp"]
    for d in shared:
        d.mkdir(parents=True, exist_ok=True)
        (d / "f").write_text("1")
    assert P.remove_unwanted(P.current()) == []                        # every pack kept: nothing removed
    c = P.current()
    c["settings"] = {"packs": "boot"}
    P.PRESETS_FILE.write_text(json.dumps(c))
    assert P.remove_unwanted(P.current()) == ["iq3_s", "iq3_xxs"]
    assert P.pack_ready("q2_0") and not P.pack_ready("iq3_xxs")
    assert not (home / "models" / "IQ3_XXS-q8dense").exists() and not (home / "data" / "packs" / "iq3_xxs").exists()
    assert all((d / "f").exists() for d in shared)
    # the running preset's pack stays, whatever the boot preset is
    make_pack(home, "iq3_xxs")
    assert P.remove_unwanted(P.current(), running="balanced") == []


def test_a_preset_whose_pack_is_absent_is_refused(home, monkeypatch):
    install(home, "m6000-32g", 31, monkeypatch=monkeypatch)
    c = P.current()
    assert P.not_downloaded(c, "balanced") is None                     # no packs at all: a fake engine, or the tests
    make_pack(home, "q2_0")
    assert P.not_downloaded(c, "speed") is None
    assert "iq3_xxs pack, which is not downloaded yet" in P.not_downloaded(c, "balanced")
    c["settings"] = {"packs": "boot"}
    assert "make balanced the boot preset" in P.not_downloaded(c, "balanced")


def test_the_switch_refuses_a_preset_without_its_pack(home, monkeypatch):
    install(home, "m6000-32g", 31, monkeypatch=monkeypatch)
    make_pack(home, "q2_0")
    monkeypatch.setattr(LC.SP, "load", lambda: P.current())
    with pytest.raises(LC.SwitchError, match="iq3_xxs pack"):
        LC._switch("balanced")


# ------------------------------------------------------------------------------------- docker/profile.py (StartOS)

def run_profile_py(home, *args, ram=63):
    """docker/profile.py on a machine of `ram` GiB: nvidia-smi and /proc/meminfo are replaced through lib/profiles.py's
    own inputs (a sitecustomize that patches facts())."""
    shim = home / "shim"
    shim.mkdir(exist_ok=True)
    (shim / "sitecustomize.py").write_text(
        "import sys\nsys.path.insert(0, %r)\nimport profiles\n"
        "profiles.facts = lambda: %r\n" % (str(ROOT / "lib"), machine(ram)))
    e = {k: v for k, v in os.environ.items() if not k.startswith("OUTCROP_")}
    e.update(OUTCROP_HOME=str(home), OUTCROP_PROFILES=str(ROOT / "profiles"), PYTHONPATH=str(shim),
             PYTHONDONTWRITEBYTECODE="1")          # the shim changes between runs within one second
    r = subprocess.run([sys.executable, str(ROOT / "docker" / "profile.py"), *args], env=e, capture_output=True, text=True)
    return r


def test_startos_first_start_then_less_ram(tmp_path):
    r = run_profile_py(tmp_path, "follow", ram=126)
    out = json.loads(r.stdout)
    assert out["first"] is True and out.get("error") is None
    assert json.loads((tmp_path / "presets.json").read_text())["profile"]["name"] == "m6000-128g"
    out = json.loads(run_profile_py(tmp_path, "follow", ram=31).stdout)
    assert out["first"] is False and out["hardware"]["moved"]["to"] == "m6000-32g"
    assert json.loads((tmp_path / "presets.json").read_text())["profile"]["name"] == "m6000-32g"


def test_startos_the_action_takes_the_bigger_profile(tmp_path):
    run_profile_py(tmp_path, "follow", ram=31)
    out = json.loads(run_profile_py(tmp_path, "check", ram=63).stdout)
    assert (out["profile"], out["target"], out["changes"]) == ("m6000-32g", "m6000-64g", True)
    assert out["hardware"]["change"] == "more"
    out = json.loads(run_profile_py(tmp_path, "apply", ram=63).stdout)
    assert out["moved"]["to"] == "m6000-64g"
    assert json.loads((tmp_path / "presets.json").read_text())["profile"]["name"] == "m6000-64g"
    out = json.loads(run_profile_py(tmp_path, "check", ram=63).stdout)
    assert (out["target"], out["changes"]) == ("m6000-64g", False)


def test_startos_follow_never_fails_the_start(tmp_path):
    (tmp_path / "presets.json").write_text(json.dumps({"profile": {"name": "no-such-profile"}, "presets": {}}))
    r = run_profile_py(tmp_path, "follow", ram=31)
    assert r.returncode == 0 and json.loads(r.stdout)["hardware"]["change"] in ("unknown", "more", "less", "other", "none")


def test_startos_a_presets_file_made_before_the_start_still_tells_its_pack_choice(tmp_path):
    """The install's password step runs prepare.sh, which makes presets.json (and the one-pack choice) before the
    service's first start: the start passes the message on, once."""
    run_profile_py(tmp_path, "follow", ram=31)                          # stands in for prepare.sh making the file
    (tmp_path / "state" / "packs-notice.txt").write_text("only the boot preset's pack\n")
    out = json.loads(run_profile_py(tmp_path, "follow", ram=31).stdout)
    assert out["first"] is False and out["packs_message"] == "only the boot preset's pack"
    assert json.loads(run_profile_py(tmp_path, "follow", ram=31).stdout)["packs_message"] is None


M6000_2 = {**M6000, "index": "1", "uuid": "GPU-3"}


def two(ram):
    return {**machine(ram), "gpus": [M6000, M6000_2]}


def test_a_second_card_gets_the_two_card_profile(home, monkeypatch):
    for ram, one, both in ((31, "m6000-32g", "m6000x2-32g"), (63, "m6000-64g", "m6000x2-64g"), (126, "m6000-128g", "m6000x2-128g")):
        assert P.suggest(machine(ram))[0] == one
        assert P.suggest(two(ram))[0] == both
    r = P.render("m6000x2-64g", None, two(63))
    assert r["common"]["gpu"] == [0, 1] and "CUDA_VISIBLE_DEVICES" not in r["common"].get("env", {})
    assert "--pipeline-windows 2" in r["common"]["args"]
    assert P.render("m6000x2-128g", None, two(126))["presets"]["quality-1m"]["kv_resident"] == 131072
    # a two-card profile never fits one card
    kind, why = P.fit(P.compose("m6000x2-64g"), machine(63))
    assert kind is None and "2 of these cards" in why[0]


def test_a_card_added_is_offered_and_a_card_removed_moves_back(home, monkeypatch):
    install(home, "m6000-64g", 63, boot="quality", monkeypatch=monkeypatch)
    h = P.hardware(None, two(63))
    assert (h["change"], h["fits"]) == ("more", "m6000x2-64g") and "2 cards" in h["message"]
    assert P.follow(two(63))["change"] == "more" and P.current()["profile"]["name"] == "m6000-64g"   # only offered
    monkeypatch.setattr(P, "facts", lambda: two(63))
    P.apply("m6000x2-64g")
    assert P.current()["common"]["gpu"] == [0, 1]
    h = P.follow(machine(63))                                  # a card taken out, or failed
    assert h["change"] == "less" and h["moved"]["to"] == "m6000-64g"
    assert "1 of the 2 cards" in h["message"]
    c = P.current()
    assert "gpu" not in c["common"] and (home / "state" / "default_preset").read_text().strip() == "quality"


def test_a_second_card_is_never_taken_up_or_dropped_by_itself(home, monkeypatch):
    """Two cards with more RAM than any two-card profile is for: offered (the bigger one-card profile), never applied;
    less RAM while a second card appeared: the move keeps to one card, and the two-card profile is offered after."""
    monkeypatch.setattr(P, "facts", lambda: two(126))
    P.apply("m6000x2-128g")
    h = P.follow(two(250))
    assert h["change"] == "more" and "moved" not in h and P.current()["profile"]["name"] == "m6000x2-128g"
    assert "runs on 1 of the 2 cards" in h["message"]
    install(home, "m6000-128g", 126, monkeypatch=monkeypatch)
    h = P.follow(two(63))
    assert h["change"] == "less" and h["moved"]["to"] == "m6000-64g" and "gpu" not in P.current()["common"]
    h = P.follow(two(63))
    assert (h["change"], h["target"]) == ("more", "m6000x2-64g")


def test_the_offer_names_every_change_and_the_download(home, monkeypatch):
    install(home, "m6000-32g", 31, monkeypatch=monkeypatch)
    h = P.hardware(None, two(63))
    assert "2 cards and 63 GiB of RAM" in h["message"] and "downloads" in h["message"] and h["new_packs"]


def test_a_mixed_pair_uses_both_cards_as_untested():
    M40 = {**M6000, "name": "Tesla M40 24GB", "index": "1", "uuid": "GPU-4"}
    f = {**machine(63), "gpus": [M6000, M40]}
    n, kind, why = P.suggest(f)
    assert (n, kind) == ("m6000x2-64g", "similar") and "not tested" in why[0]
    other = {**M6000, "name": "NVIDIA GeForce RTX 3090", "uuid": "GPU-5"}
    f = {**machine(63), "gpus": [other, {**M6000, "index": "1"}]}
    assert P.suggest(f)[0] == "m6000-64g"                     # one M6000 beside another GPU: the one-card profile


def test_two_card_profiles_find_their_cards_by_uuid(home, monkeypatch):
    """The numbers shift when a card is added in a lower slot: they are worked out again from the UUIDs at every start;
    a card that is gone is refused with the reason; a profile is not applied while its cards cannot be seen."""
    import strata_presets as SP
    r = P.render("m6000x2-64g", None, two(63))
    assert r["common"]["gpu"] == [0, 1] and r["common"]["gpu_uuids"] == ["GPU-2", "GPU-3"]
    monkeypatch.setattr(SP, "gpu_index_by_uuid", lambda: {"GPU-9": 0, "GPU-2": 1, "GPU-3": 2})   # a display card at 0
    assert SP.card_numbers(r["common"]) == [1, 2]
    monkeypatch.setattr(SP, "gpu_index_by_uuid", lambda: {"GPU-2": 0})
    try:
        SP.card_numbers(r["common"])
        raise AssertionError("not refused")
    except ValueError as e:
        assert "1 of the 2 cards" in str(e)
    monkeypatch.setattr(SP, "gpu_index_by_uuid", lambda: {})                                     # no nvidia-smi
    assert SP.card_numbers(r["common"]) == [0, 1]
    try:
        P.render("m6000x2-64g", None, {**machine(63), "gpus": []})
        raise AssertionError("applied without its cards")
    except ValueError as e:
        assert "2 cards and 0 can be seen" in str(e)


def test_a_card_lost_with_more_ram_moves_without_a_download(home, monkeypatch):
    monkeypatch.setattr(P, "facts", lambda: two(31))
    P.apply("m6000x2-32g")
    h = P.follow(machine(126))
    assert h["change"] == "less" and h["moved"]["to"] == "m6000-32g"          # the same RAM's one-card profile
    assert P.follow(machine(126))["target"] == "m6000-128g"                  # then the bigger one is offered


def test_gpu_and_gpu_uuids_must_agree(monkeypatch):
    import strata_presets as SP
    monkeypatch.setattr(SP, "gpu_index_by_uuid", lambda: {"GPU-2": 0, "GPU-3": 1})
    try:
        SP.card_numbers({"gpu": [0], "gpu_uuids": ["GPU-2", "GPU-3"]})
        raise AssertionError("not refused")
    except ValueError as e:
        assert "remove gpu_uuids" in str(e)
