# Outcrop

A simple framework for running a capable LLM on budget, upgradable hardware. Outcrop runs
[Qwen3.8-Flash-Next](https://huggingface.co/Qwen/Qwen3.8-Flash-Next) (125B parameters, 6B active per token) on a used
**Quadro M6000 24 GB** with **32 GB of RAM or more**, through the [Strata](https://github.com/Niko1221/Strata) engine.
Your apps reach it on your home network with the OpenAI, Anthropic or Ollama API, each with its own access token, and a
web console shows what it is doing, lets you chat with it, and manages it all.

- **Fast enough to use:** 32 to 49 tokens a second on one M6000, depending on the RAM and the preset.
- **Private:** the model, your chats and your tokens stay on your machine. The chat's web search is optional.
- **Made to be copied:** one script checks your machine, picks a hardware profile, installs and starts everything.
- **Made to grow:** more RAM unlocks better presets. Profiles for other machines are welcome ([CONTRIBUTING.md](CONTRIBUTING.md)).

## What you need

| | |
| --- | --- |
| GPU | Quadro M6000 24 GB. The Tesla M40 24 GB is the same chip, but not tested yet |
| RAM | 32 GB or more. 64 GB adds the best-quality preset; 128 GB adds million-token contexts |
| CPU | Any x86-64 with AVX2 (Intel Haswell or AMD Zen and newer) |
| Disk | about 210 to 320 GB free, on an SSD (it depends on the profile) |
| System | Ubuntu 24.04, or a system built on it (Zorin OS 18, Linux Mint 22) |
| Driver | NVIDIA driver 580 (575 works too; drivers after 580 dropped Maxwell cards) |
| Network | Internet for the setup (about 110 to 170 GB of downloads), and a home network for your apps |

## Install

```sh
sudo apt install git   # if it is not installed yet
git clone https://github.com/paulscode/outcrop.git
cd outcrop
./setup.sh --check     # looks at your computer and suggests a profile; changes nothing
./setup.sh             # installs everything and starts the server (asks first)
```

`./setup.sh` checks the system, the driver, the GPU, RAM, disk space and the internet, and tells you how to fix
anything missing. Then it shows the plan and asks before it changes anything. The install takes from one hour to several
(most of it downloading the model). If it stops, run it again: finished steps are skipped. Installing over SSH? Run it
inside `tmux` (`sudo apt install tmux`, then `tmux`), so a dropped connection does not stop it.

At the end it prints the console's address: `YOUR-SERVER` below stands for your server's hostname (`hostname` prints it),
and its network address works too. On each device, first open `http://YOUR-SERVER.local/ca` and install the
certificate it offers, so your browser trusts the console. Then sign in with the password you chose during setup.

### On StartOS

Outcrop is also a [StartOS](https://start9.com) 0.4 service: install it from the paulscode registry in the StartOS
marketplace, or sideload its `.s9pk` from the [releases](https://github.com/paulscode/outcrop/releases). It needs the
same hardware, plus [startos-nvidia-legacy](https://github.com/paulscode/startos-nvidia-legacy) for the driver.
[docs/STARTOS.md](docs/STARTOS.md) has the details and what differs from an Ubuntu install.

## Using it

**The console** at `https://YOUR-SERVER.local` shows each request as it is read, thought about and answered. It has
a chat (with saved conversations and optional web search), the presets and switching between them, access tokens, a
wizard for connecting apps, a playground, benchmarks, logs, alerts (also on Telegram) and the security settings.
[docs/CONSOLE.md](docs/CONSOLE.md) is its guide.

**The command line**, on the server:

```sh
outcrop                   # what runs now, the boot default, the API address, GPU and RAM
outcrop list              # the presets ( > running, * boot default )
outcrop switch speed      # run another preset now; the boot default stays the same
outcrop default balanced  # choose the preset started at boot
outcrop token create NAME # a token for an app (shown once)
outcrop connect           # how to point apps at the server
outcrop logs [-f]         # the service journal and the engine log
outcrop test              # a quick answer check;  outcrop bench: a quick speed check
outcrop profile           # this machine and its hardware profile
```

`outcrop --help` lists the rest. (`llmctl`, the old name, still works.)

## Presets

A preset is a model pack and its settings. Which ones you get depends on your hardware profile
([docs/PROFILES.md](docs/PROFILES.md)):

| Preset | Pack | Bits per weight | Quality (task average) | 32 GB of RAM | 64 GB and more |
| --- | --- | --- | --- | --- | --- |
| `speed` | Q2_0 | 2.4 | 89.1 | yes, the default | yes |
| `balanced` | IQ3_XXS | 3.0 | 92.6 | yes, slower when RAM is busy | yes |
| `quality` | IQ3_S | 3.5 | 93.3 | no | yes |
| `speed-1m`, `balanced-1m`, `quality-1m` | as above, 1M-token context | | | no | 128 GB and more |

- **Quality** is ISTA-DASLab's task average (AIME25, GPQA-Diamond, LiveCodeBench v6) for each pack; the original
  model scores 93.1.
- **Speed**, decoding chat and code, in tokens a second: with 32 GB of RAM, 40 to 44 on `speed` and 32 to 34 on
  `balanced`; with 64 GB, 43 to 49 on `speed` and 39 to 44 on `balanced` and `quality`. Prompts read at about 200 tokens
  a second. Each profile's measurements are in its file ([docs/PROFILES.md](docs/PROFILES.md)), and the reference
  system's in [docs/FINDINGS.md](docs/FINDINGS.md).
- **Context** is 262,144 tokens on the base presets. The `-1m` presets stretch it to 1,048,576 with YaRN scaling, which
  changes answers a little at every length; use them only when you need more than 262K.
- **Pictures** work on every preset, read by a CPU encoder so the GPU keeps its memory for the model.

A switch takes about 70 seconds with 64 GB of RAM or more, and about 10 minutes with 32 GB, where the pack is read from
disk each time. Requests that arrive meanwhile wait at the gateway and are answered by the new preset.

## Connecting apps

Every app needs a token. Make one per app, so each can be revoked alone and the request log shows who sent what:

```sh
outcrop token create open-webui
outcrop token create home-assistant --listener ollama --cidr 192.168.1.20
```

`outcrop connect` and the console's Connect page show these with your server's address.

| App speaks | Base URL | The token goes in |
| --- | --- | --- |
| OpenAI (Open WebUI, LibreChat, Continue, Cline, Aider, Zed, Jan, n8n, LangChain, the `openai` SDK ...) | `http://YOUR-SERVER.local:8080/v1` | the app's API key field. Any model name works |
| Anthropic (Claude Code, the `anthropic` SDK) | `http://YOUR-SERVER.local:8080` | `ANTHROPIC_AUTH_TOKEN`, with `ANTHROPIC_BASE_URL` set to that URL |
| Ollama (Home Assistant, Obsidian plugins, Enchanted, Raycast ...) | `http://YOUR-SERVER.local:11434` | an `Authorization: Bearer <token>` header |

- **HTTPS:** the same API is on port 8443 with the console's certificate, for apps that can trust it.
- **Thinking** is on by default. A request can turn it off with `"chat_template_kwargs": {"enable_thinking": false}`
  (`"think": false` on the Ollama API); replies come much sooner.
- **One request at a time.** Others wait their turn. The engine is fastest with one stream.
- **Tokens** can be limited to one port, to addresses, to a scope, to a rate, and can expire.
  [docs/SECURITY.md](docs/SECURITY.md) has the details, and [docs/CONNECT-WEB.md](docs/CONNECT-WEB.md) how apps can use
  the server's web search.

## Updating

```sh
cd outcrop && git pull && ./setup.sh update
```

It applies what changed and restarts only what needs it, waiting for running requests to finish. When the hardware
profiles change, it says so: `outcrop profile diff NAME` shows what is new and `outcrop profile apply NAME` takes it.

## How it is put together

| Path | Holds |
| --- | --- |
| `setup.sh` | Checks the machine, suggests a profile, installs and starts everything; `./setup.sh update` applies updates |
| `profiles/` | The hardware profiles ([docs/PROFILES.md](docs/PROFILES.md)) |
| `bin/outcrop` | The command line (`/usr/local/bin/outcrop` links to it) |
| `bin/outcrop-serve` | What the engine service runs: renders the preset's config and starts Strata |
| `console/` | The API gateway (ports 8080, 11434, 8443: tokens, limits, the request log) and the console's backend, in the Python package `outcrop`, with its tests and a fake engine for running everything without a GPU |
| `web/` | The console's web UI (React, TypeScript) |
| `lib/` | What the command and the console share: presets, profiles, starting and switching the engine |
| `systemd/` | The services: `outcrop-engine@PRESET`, `outcrop-gateway`, `outcrop-console`, `outcrop-boot` (the boot default), `outcrop-ollama-bridge`, and the chat's web search (`outcrop-fetch`, `outcrop-searxng`) |
| `setup/` | The install steps `setup.sh` runs; `harden.sh` (an optional firewall, LAN only, and SSH keys only) |
| `patches/` | Strata patches for Maxwell (`sm_52`) |
| `bench/` | Speed, quality and API checks |
| `examples/` | [bug-hunt](examples/bug-hunt/): a security review of any codebase with an AI agent and your own server |
| `~/.outcrop/` | Everything the install makes, outside the repo: presets.json, models, the engine, logs and state |

## Troubleshooting

- **`outcrop` says "starting" for more than 5 minutes:** `outcrop logs` shows what the engine loaded and why it
  stopped.
- **An app gets 401:** it sent no token, an unknown one, or one that was revoked, expired or rotated (the message says
  which). **403:** the token is not allowed on that port, from that address, or for that kind of request.
- **Slower than expected:** a hot card (above 80 C) loses speed on long prompts, a desktop session on the server takes
  some of the GPU, and with 32 GB of RAM other programs slow the `balanced` preset down.
- **Setup stopped:** its log is in `~/.outcrop/logs/`. Fix what it says, then run `./setup.sh` again.

## Credits

Outcrop stands on [Strata](https://github.com/Niko1221/Strata) (MIT), [llama.cpp](https://github.com/ggml-org/llama.cpp),
the Qwen team's [Qwen3.8-Flash-Next](https://huggingface.co/Qwen/Qwen3.8-Flash-Next), ISTA-DASLab's
[GSQ-RCO packs](https://huggingface.co/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF) and
[SearXNG](https://github.com/searxng/searxng). The console's password checks use the EFF's long wordlist (CC BY 3.0 US)
and a breached-passwords list from [SecLists](https://github.com/danielmiessler/SecLists) (MIT); see
[console/outcrop/console/data/](console/outcrop/console/data/README.md). The models are downloaded from Hugging Face under their own licenses.

Outcrop itself is under the [MIT License](LICENSE).
