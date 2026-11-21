"""setup/pins.env is the one place a pinned source is named: plain enough for bash and the Dockerfile, and not copied."""
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PINS = ROOT / "setup" / "pins.env"
LINE = re.compile(r"^([A-Z][A-Z0-9_]*)=([^\s'\"$`\\]+)$")
# the scripts that use the pins, and so must read them from pins.env
READERS = ["setup.sh", "setup/install.sh", "setup/build-engine.sh", "setup/download-models.sh"]


def pins() -> dict[str, str]:
    out = {}
    for n, ln in enumerate(PINS.read_text().splitlines(), 1):
        if not ln.strip() or ln.lstrip().startswith("#"):
            continue
        m = LINE.match(ln)
        assert m, f"pins.env:{n} is not a plain KEY=value line: {ln!r}"
        assert m.group(1) not in out, f"pins.env:{n} sets {m.group(1)} twice"
        out[m.group(1)] = m.group(2)
    return out


def test_plain_lines_and_bash_reads_the_same():
    p = pins()
    assert {"STRATA_COMMIT", "LLAMA_COMMIT", "CUDA_RUN", "CUDA_URL", "HF_REPO", "HF_REV"} <= p.keys()
    keys = " ".join(p)
    r = subprocess.run(["bash", "-c", f'set -eu; . "$0"; for k in {keys}; do printf "%s=%s\\n" "$k" "${{!k}}"; done', PINS],
                       capture_output=True, text=True, check=True)
    assert dict(ln.split("=", 1) for ln in r.stdout.splitlines()) == p


def test_shapes():
    p = pins()
    for k in ("STRATA_COMMIT", "LLAMA_COMMIT", "HF_REV"):
        assert re.fullmatch(r"[0-9a-f]{40}", p[k]), k
    for k, v in p.items():
        if k.startswith("SHA256_"):
            assert re.fullmatch(r"[0-9a-f]{64}", v), k
    assert p["CUDA_URL"].startswith("https://") and p["CUDA_URL"].endswith("/" + p["CUDA_RUN"])


def test_readers_source_it():
    for f in READERS:
        assert "pins.env" in (ROOT / f).read_text(), f"{f} does not read setup/pins.env"


def test_no_pin_is_copied_elsewhere():
    """A commit or a checksum written out in another file would drift from pins.env the next time a pin moves."""
    values = {k: v for k, v in pins().items() if re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", v)}
    files = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    for f in files:
        path = ROOT / f
        if path == PINS or path == Path(__file__) or not path.is_file():
            continue
        try:
            text = path.read_text()
        except UnicodeDecodeError:
            continue
        for k, v in values.items():
            assert v not in text, f"{f} repeats {k} from setup/pins.env; read it from there"
