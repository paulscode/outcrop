"""Naming the processes on the GPU.  NVML's pids are the host's: inside StartOS's container the engine's pid is not in
our /proc, and its bare number used to show up on the Overview as another program on the GPU."""
import os

from outcrop.console.live import _gpu_holders, _name_hidden, _proc_name


def test_a_visible_pid_is_named_from_proc_and_a_hidden_one_is_not():
    me = os.getpid()
    assert _proc_name(me) == open(f"/proc/{me}/comm").read().strip()
    assert _proc_name(2**22 + 12345) is None


def test_hidden_pids_take_our_own_gpu_processes_names():
    procs = [{"pid": 95929, "mem": 23981, "name": None}, {"pid": 4242, "mem": 300, "name": None}]
    _name_hidden(procs, ["strata-host"])
    # the engine is the big one; what is left over really is outside (another service on the GPU)
    assert [p["name"] for p in procs] == ["strata-host", "pid 4242"]

    none_of_ours = [{"pid": 95929, "mem": 23981, "name": None}]
    _name_hidden(none_of_ours, [])
    assert none_of_ours[0]["name"] == "pid 95929"


def test_gpu_holders_reads_nvidia_uvm_from_fds(tmp_path):
    def proc(pid, comm, links):
        d = tmp_path / str(pid)
        (d / "fd").mkdir(parents=True)
        (d / "comm").write_text(comm + "\n")
        for i, target in enumerate(links):
            os.symlink(target, d / "fd" / str(i))

    proc(164, "strata-host", ["/dev/null", "/dev/nvidiactl", "/dev/nvidia-uvm"])
    proc(138, "strata-vision", ["/dev/null"])
    proc(61, "python", ["/dev/nvidiactl", "/dev/nvidia-uvm"])   # the console or Strata's server: NVML only
    (tmp_path / "200").mkdir()                                  # a process that went away: no fd, no comm
    assert _gpu_holders(tmp_path) == ["strata-host"]
