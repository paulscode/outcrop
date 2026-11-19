# Contributing

Outcrop is for people running a capable model on budget, upgradable hardware. The most useful contributions come
from running it on a machine like yours and telling us what you found.

## Ways to help

- **A hardware profile for your machine.** Different RAM, a card from the same family (Tesla M40 24 GB), a different
  disk. [docs/PROFILES.md](docs/PROFILES.md), "A profile for your machine", walks through it. Include what you
  measured.
- **Measurements on a profile marked "not tested yet".** Run it, then `outcrop bench` (speed) and `outcrop test`
  (answers) on each preset, and open an issue or a pull request with the numbers and your hardware (`outcrop profile`
  prints the relevant parts).
- **Problems with `./setup.sh`.** Its log is in `~/.outcrop/logs/setup-*.log`. An issue with the step that failed and
  the end of that log helps the most. Check the log for anything private before you post it.
- **Other GPU families.** The engine is built for Maxwell (`sm_52`) with the patches in `patches/`. Support for other
  cards is welcome; open an issue first so we can talk about the approach.
- **Bugs and features** in the gateway, the console or the `outcrop` command: issues and pull requests.

## Working on the code

You do not need a GPU: the tests run the whole stack against a fake engine.

```sh
# the gateway, the console and the command (Python 3.12, uv)
uv sync --project console
uv run --project console pytest console/tests -q
uv run --project console ruff check console/outcrop console/tests lib --select E,F,W,B --ignore E501,E701,E702,B008,B905

# the web console (Node 22.12 or newer, pnpm)
cd web && pnpm install && pnpm typecheck && pnpm test
pnpm e2e                                  # builds, then Playwright against the whole stack (console/dev.py)

# shell scripts
shellcheck -S warning setup.sh setup/*.sh setup/outcrop-boot bin/outcrop-gateway bin/outcrop-console
```

`cd console && uv run python dev.py --fresh` starts the gateway, the console and a fake engine with traffic, so you can use the
console in a browser without a GPU. It prints the address and a password.

CI runs all of the above, and more shell checks, on every pull request ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Guidelines

- **Security first.** The gateway and the console face a home network. [docs/SECURITY.md](docs/SECURITY.md) describes
  what they defend and how; a change that weakens it needs a good reason and a test.
- **Pin what you download.** Sources by commit, models by revision and SHA-256, images by digest, dependencies by lock
  file. New dependencies: prefer releases at least two weeks old, except security fixes.
- **Measure before you tune.** A setting in a profile or preset should come with the numbers that chose it.
- **Plain writing.** Docs and messages are for people who are not experts: short sentences, the concrete fact, no
  jargon without an explanation.

By contributing, you agree that your contribution is licensed under the project's [MIT License](LICENSE).
