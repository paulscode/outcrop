# Example: a security review with an agent and your own Outcrop installation

An AI coding agent reviews a codebase for security bugs, using the model on your Outcrop installation: no cloud, and no
network for the agent. The method is **map, then review**:

1. **Map.** The agent maps the project's security-critical subsystems and ends with a list, one line each.
2. **Review.** For each line, in the map's own words, a fresh agent session reviews that one part.

A broad "audit this repository" prompt asks one session to cover everything, and on a large codebase it runs out of
time or attention before it gets far. The map splits the work into pieces a session can finish. Nobody needs to know
in advance where the bug is: every part gets reviewed, and the most serious findings come first in each report.

The agent is [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh`). It is not part of Outcrop;
this folder has what it takes to run it against your server. [coldcard/](coldcard/) is a worked example: a 2023
snapshot of the COLDCARD hardware-wallet firmware, which had a seed-entropy bug that was found and fixed only in 2026.

## What you need

- An Outcrop installation that answers (`outcrop test`). Any profile works; slower presets just take longer.
- On the same machine: Docker and `socat` (both come with Outcrop's setup), and **sudo without a password prompt**: each
  run mounts a copy of the repository with overlayfs, and unmounts it hours later. If your sudo asks for a password, a
  rule for just those two commands is enough, in `/etc/sudoers.d/outcrop-bug-hunt` (edit it with `sudo visudo -f`):

  ```
  YOUR-USER ALL=(root) NOPASSWD: /usr/bin/mount, /usr/bin/umount
  ```

  Docker is used through `sudo` when your user is not in the `docker` group (the rule then needs `/usr/bin/docker` too).
- The repository to review, as a git checkout on that machine.

## 1. The dsh image

dsh runs in a container started with `--network none`. Its only way out is a socket to Outcrop's gateway.

```sh
cd examples/bug-hunt/harness
sudo docker build -t outcrop-bug-hunt:dsh-0.2.1-rc.3 .
sudo docker run --rm --network none --entrypoint dsh outcrop-bug-hunt:dsh-0.2.1-rc.3 --version     # 0.2.1-rc.3
```

The Dockerfile pins the base image by digest, dsh by version, and npm dependencies to those published before
2026-10-24 (`NPM_BEFORE`).

## 2. A token for the runs

A token that can only run the model, only on the OpenAI port, and only from this machine. `--save` writes it to a file
only you can read, and it is never shown:

```sh
outcrop token create bug-hunt --scope inference --listener openai --cidr 127.0.0.1/32 --expires 90d \
  --save ~/.config/outcrop/bug-hunt-token
```

## Two dsh settings a local model needs

`harness/dsh.patch.yml` holds dsh's settings for these runs. Two of them **must** change from dsh's defaults when the
model runs on one local server, which answers one request at a time:

```yaml
- id: llm-pi-ai
  config:
    providers:
      outcrop:
        streamIdleTimeoutMs: 1800000    # 30 minutes; dsh's default is 300000 (5 minutes)
- id: subagent
  config:
    maxActiveSubagents: 1               # dsh's default is 8
```

- **`streamIdleTimeoutMs`:** how long dsh waits for a reply to start before it drops the request and retries. A
  request that is waiting its turn sends nothing, and with conversations of 100K+ tokens the wait can pass 5 minutes.
- **`maxActiveSubagents`:** how many helper agents dsh runs at once. Each is another conversation queued on the same
  server.

With the defaults, long runs stall: requests time out while waiting, their retries join the same queue, and a run can
spend hours getting nowhere. dsh's error log says `pi-ai stream idle timeout after 300000ms`, and Outcrop's request log
(the console's Requests page) shows many requests ending after exactly 5 minutes. The names are from dsh 0.2.1-rc.3;
dsh refuses settings it does not recognise, so a short run shows whether another version accepted them.

The file also switches off everything in dsh that reaches the internet: web search, page fetching, the DeepSeek
session-log upload and telemetry.

## 3. Run the strategy

```sh
cd examples/bug-hunt/harness
ABOUT="the firmware for the COLDCARD hardware wallet" REPO=~/src/firmware ./run-strategy.sh my-review
```

- `ABOUT` completes the prompts' first sentence, "This repository is ...". The prompts are in [prompts/](prompts/).
- Runs go to `~/bug-hunt/runs/` (`RUNS=` changes it): first `my-review-M-1` (the map), then `my-review-S-1`,
  `my-review-S-2` ... (one review per subsystem, in the map's order).
- Each run may take up to 4 hours (`LIMIT_M=`, `LIMIT_S=`). On an M6000, a map takes about 40 minutes to 2.5 hours and a
  review 30 minutes to 3 hours, so a 20-subsystem map can mean a day or two in all.
- Stopped halfway? Run the same command again: finished runs are skipped.
- `run-one.sh PROMPT_FILE NAME` runs one finished prompt the same way (`REPO=` as above): a prompt with nothing left to
  fill in, such as those in [coldcard/prompts/](coldcard/prompts/), not `prompts/map.txt` itself.

Each run's answer is the last `"final"` event in its `events.jsonl`:

```sh
python3 -c 'import json,sys; print([json.loads(l) for l in open(sys.argv[1]) if "\"final\"" in l][-1]["text"])' \
  ~/bug-hunt/runs/my-review-S-6/events.jsonl
```

The full session logs, helper agents included, are in each run's `home/sessions/`. Anything a run wrote is in its
`upper/`; the repository itself is never changed.

## By hand, in dsh's browser UI

The same two prompts work interactively, with dsh installed on your own machine (`npm install -g @deepseek-ai/dsh`):

```sh
cd ~/src/firmware
export GATEWAY_API_KEY=$(cat ~/.config/outcrop/bug-hunt-token)      # a token allowed from this machine (below)
dsh web --patch /path/to/outcrop/examples/bug-hunt/harness/interactive.patch.yml
```

The token from step 2 works only on the server itself (`--cidr 127.0.0.1/32`). On another computer, make one for it:
the same command with that computer's address in `--cidr`. Set `baseURL` in `interactive.patch.yml` to your server first. Then, in a new chat, paste `prompts/map.txt` (with
`{ABOUT}` filled in). Pick a line from its `## Subsystems` list, and in a **fresh** chat paste `prompts/review.txt` with
that line in place of `{SUBSYSTEM}`, word for word.

**The internet:** dsh's web tools are off in these settings, but on an ordinary machine the agent's shell commands can
still reach the internet (`curl`, `git fetch`). The container in `run-one.sh` has no network at all; by hand, watch the
tool calls.

## Things you will see

- **"This looks like a benchmark with planted bugs."** Models say this about almost any review request, with or
  without a reason. It does not stop them finding real bugs, but they may compare the code with the upstream version
  they remember, which cannot find a bug that is upstream too.
- **Long quiet stretches** while the server reads a long prompt. Waiting, not stuck.
- **A broken answer:** a tool call written out as text (`<tool_call> <function=...>`). Run it again.
- **False alarms.** Check each finding against the code before acting on it.
