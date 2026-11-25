"""StartOS caps its services' memory together, above the container, where Outcrop cannot read it: the formula is used."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
import strata_presets as SP  # noqa: E402

GIB = 1 << 20          # in KiB


def meminfo(tmp_path, total_kib, avail_kib):
    p = tmp_path / "meminfo"
    p.write_text(f"MemTotal:       {total_kib} kB\nMemFree:        {avail_kib} kB\nMemAvailable:   {avail_kib} kB\n")
    return str(p)


def test_the_formula_matches_what_startos_set_on_ai_sata():
    # measured on a 32 GB server (StartOS 0.4.2.1, MemTotal 32777228 kB): services.slice MemoryHigh=29241638912 bytes
    assert abs(SP.startos_memory_high_kib(32777228) * 1024 - 29241638912) < 2 * (1 << 20)


def test_ubuntu_is_memavailable(tmp_path, monkeypatch):
    monkeypatch.delenv("OUTCROP_PLATFORM", raising=False)
    assert SP.mem_available_gib(meminfo(tmp_path, 32777228, 30 * GIB)) == 30


def test_startos_stops_at_the_reclaim_line(tmp_path, monkeypatch):
    monkeypatch.setenv("OUTCROP_PLATFORM", "startos")
    # 31.26 GiB of RAM, 30 GiB available: the reclaim line (27.2 GiB) minus the 1.26 GiB in use, so 25
    assert SP.mem_available_gib(meminfo(tmp_path, 32777228, 30 * GIB)) == 25
    # with 64 GB: 61.3 GiB total, 60 available -> 54.28 - 1.31 = 52.97, so 52
    assert SP.mem_available_gib(meminfo(tmp_path, 64289000, 60 * GIB)) == 52
    # busier than the line already: nothing
    assert SP.mem_available_gib(meminfo(tmp_path, 32777228, 2 * GIB)) == 0


def test_low_ram_mode_on_startos_has_a_budget(tmp_path, monkeypatch):
    """On StartOS the engine gets an explicit RAM budget below StartOS's line; on Ubuntu it sizes itself, as before."""
    monkeypatch.setattr(SP, "MEMINFO", meminfo(tmp_path, 32777228, 30 * GIB))
    p = {"pack": "q2_0", "context": 262144}
    top = {"args": ["--adapt-async 1", "--conversation-cache-mib 4096", "--conversation-cache-slots 2"], "vision": "cpu"}
    monkeypatch.setenv("OUTCROP_PLATFORM", "startos")
    args, _, notes = SP.engine_args(p, top)
    assert "--resident-experts" not in args
    # 25 GiB below the line, less 1 (vision) and 8 (reserve)
    assert args[args.index("--resident-budget-gib") + 1] == "16"
    assert args[args.index("--memory-limit-mib") + 1] == str(SP.startos_memory_high_kib(32777228) // 1024)
    assert "below StartOS's memory line" in notes[0]
    monkeypatch.delenv("OUTCROP_PLATFORM")
    args, _, notes = SP.engine_args(p, top)
    assert "--resident-experts" in args and "--resident-budget-gib" not in args and "--memory-limit-mib" not in args


def test_startos_budget_knobs(tmp_path, monkeypatch):
    """A preset can lower its RAM budget, never raise it past what fits: on the 32 GB test server 19 GiB and more stalled."""
    monkeypatch.setattr(SP, "MEMINFO", meminfo(tmp_path, 32777228, 30 * GIB))
    monkeypatch.setenv("OUTCROP_PLATFORM", "startos")
    top = {"args": ["--conversation-cache-mib 4096"], "vision": "cpu"}
    assert SP.startos_budget({"pack": "iq3_xxs"}, top, 25)[0] == 16
    # the conversation cache does not change it (off, the start stalled all the same)
    assert SP.startos_budget({"pack": "iq3_xxs", "args": ["--conversation-cache-mib 0"]}, top, 25)[0] == 16
    assert SP.startos_budget({"pack": "iq3_xxs", "resident_budget_gib": 12}, top, 25)[0] == 12
    assert SP.startos_budget({"pack": "iq3_xxs", "resident_budget_gib": 19}, top, 25)[0] == 16


def test_more_conversations_at_once_leave_less_for_the_experts(monkeypatch):
    """Each extra slot ("parallel") keeps its attention cache in pinned RAM: the experts' share shrinks to fit, and a
    preset whose slots leave too little to start is refused (4 slots of 262K tokens on 32 GB stalled a server)."""
    monkeypatch.setenv("OUTCROP_PLATFORM", "startos")
    monkeypatch.setattr(SP, "mem_available_gib", lambda path=None: 25)       # a 32 GB StartOS server
    monkeypatch.setattr(SP, "meminfo_kib", lambda path=None: {"MemTotal": 32 * GIB, "MemAvailable": 30 * GIB})

    def budget(p):
        args, _, notes = SP.engine_args({"pack": "q2_0", **p}, {})
        return int(args[args.index("--resident-budget-gib") + 1]), notes

    one, _ = budget({"context": 262144})
    four, notes = budget({"context": 262144, "parallel": 4})
    assert one == 16 and four < one - 8 and any("4 conversations at once" in n for n in notes)
    small, _ = budget({"context": 32768, "parallel": 4})
    assert small >= one - 2                                                  # short slots cost little
    monkeypatch.setattr(SP, "mem_available_gib", lambda path=None: 14)
    try:
        SP.engine_args({"pack": "q2_0", "context": 262144, "parallel": 4}, {})
        raise AssertionError("not refused")
    except ValueError as e:
        assert "4 conversations of 262,144 tokens" in str(e) and "fewer" in str(e)


def test_the_editor_notes_what_a_start_refuses(monkeypatch):
    """The console's editor checks presets.json while the engine holds RAM of its own: too little RAM for a preset's
    slots is a note there (strict=False), and only a start refuses it."""
    monkeypatch.setattr(SP, "mem_available_gib", lambda path=None: 8)
    p = {"pack": "q2_0", "context": 262144, "parallel": 2}
    _, _, notes = SP.engine_args(p, {}, strict=False)
    assert any("counted again when it starts" in n for n in notes)
    try:
        SP.engine_args(p, {})
        raise AssertionError("not refused")
    except ValueError:
        pass
    assert SP.gpu_problem(None) is None and SP.gpu_problem([0, 1]) is None
    assert all(SP.gpu_problem(g) for g in ("0,1", [], [0, 0], [0, 9], [True]))


def test_a_switch_plans_without_the_strict_ram_check(monkeypatch, tmp_path):
    """The switch renders the new preset while the old engine still holds its RAM: not strict there."""
    monkeypatch.setattr(SP, "mem_available_gib", lambda path=None: 8)
    cfg = {"presets": {"p4": {"pack": "q2_0", "context": 262144, "parallel": 4}}, "common": {}}
    monkeypatch.setattr(SP, "OUTCROP_HOME", tmp_path)
    SP.render("p4", cfg, strict=False)
    try:
        SP.render("p4", cfg)
        raise AssertionError("not refused")
    except ValueError:
        pass
