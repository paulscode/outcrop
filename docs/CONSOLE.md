# The console (Outcrop)

A web console for this server: what it is doing now, presets, access tokens, apps, benchmarks, logs and alerts. It runs on
the server as `outcrop-console` and is at **https://YOUR-SERVER.local/** (or the server's address, such as https://192.168.1.20/).
Everything in it also works from `outcrop` over SSH. [SECURITY.md](SECURITY.md) describes how it is protected.

## First time on a device

The console uses HTTPS with a certificate from a private certificate authority (CA) made on this server. The CA
can vouch only for this server's own names (YOUR-SERVER.local, SERVER, localhost, its LAN addresses, 127.0.0.1, ::1), so trusting it
cannot let anyone impersonate another site to you.

1. Open **http://YOUR-SERVER.local/ca** on the device. It has a button for the certificate and the steps for macOS, Windows,
   Linux (with Chrome's and Firefox's own stores), iPhone and iPad, and Android.
2. Before trusting it, compare the fingerprint on that page with the one the server prints over SSH:

   ```sh
   outcrop console ca
   ```

3. Open **https://YOUR-SERVER.local/**.

Once every device you use has the CA, turn on HSTS in Settings (it makes browsers refuse plain HTTP for the console).

## The pages

| Page | What it is for |
| --- | --- |
| Chat | Your conversations with the model, saved on the server (see "Chat" below) |
| Overview | What the server is doing now (in plain words, with tok/s or how far a prompt has been read), the GPU, today's totals, the queue, the conversation cache, memory drawn as strata, recent events, and short insight cards about the engine |
| Live | A five-minute river of requests coloured by phase (waiting, reading the prompt, thinking, answering, held, refused), each request in flight with its progress and a cancel button, and the latest finished ones |
| Requests | The request log: search and filters, and a drawer with each request's timings, engine figures and, when capture was on, its bodies |
| Presets | Each preset's quality, measured speeds, how warm its files are and how long a switch should take; switch now or when idle with the launch sequence, set the boot default, the switch history, scheduled switches, and the presets.json editor |
| Access | Enforced or open (with a countdown and who and where it applies to), tokens with their 30-day use, create, import, edit, rotate, revoke; clients still calling without a token; the token-less Ollama option and CORS |
| Connect | Pick an app, make its token, copy the exact settings (or scan a QR code); it lights up when the app's first request arrives. "Web search for your apps" makes a token with the `web` scope and shows the MCP settings ([CONNECT-WEB.md](CONNECT-WEB.md)) |
| Playground | Chat with thinking, tools and pictures, per-message speed and expert-cache figures, "view as code", and two settings side by side |
| Lab | Benchmarks from the browser with a live log, their history (and the command line's, imported from bench/results), and any two runs compared against a noise band |
| System | The security posture with a fix for anything that fails, the GPU's other users and its temperature, history charts from 15 minutes to 30 days, energy by day, hardware, software, services and ports |
| Logs | The journal of every LLM service and the engine's log, live, with search and pause |
| Timeline | Everything that happened (switches, sign-ins, token changes, the API opened or closed, alerts, benchmarks): the audit log |
| Settings | Answers and memory (exact answers, the longest conversation, the models to keep: see "Settings for every preset" below), chat (internet access for the chat and apps, web on for new chats, ask before opening pages, suggested spaces, tool limits, export), password and sessions, alerts and Telegram (with commands), capture mode, energy price, backups, the CA certificate and HSTS |

Press Ctrl+K (⌘K on a Mac) anywhere for the command palette: "switch to speed", "open the API for 15 min", "new token
for n8n", "copy the Anthropic base URL".

## Signing in

There is one account. Its password is set over SSH, never through a web page, so nobody else on the network can claim the
console first:

```sh
outcrop console passwd             # choose one: at least 16 characters, hard to guess (spaces and any characters are fine)
outcrop console passwd --generate  # or six random words, shown once
```

It is refused if it is on the list of the 100,000 most common breached passwords, if zxcvbn rates it below 4 of 4, or if it
contains your username, the server's hostname, "computer", "outcrop", "strata" or "qwen". Setting it signs out every session, which is also the
recovery path if you forget it.

- "Remember this device" keeps you signed in for 30 days; otherwise a session ends after 12 hours without use.
- After 5 wrong passwords from one address, that address waits a minute, then 2, 4 … up to an hour.
- Actions that widen access ask for the password again if you last entered it more than 10 minutes ago: an admin token,
  opening the API for more than an hour, the token-less Ollama option, CORS origins, Telegram, editing presets.json.
- `outcrop console sessions` lists who is signed in; `--revoke-all` signs everyone out.

## Alerts on Telegram

Alerts always show in the console's bell and Timeline. To also get them on Telegram:

1. In Telegram, talk to **@BotFather**, send `/newbot`, pick a name, and keep the token it gives you.
2. Send your new bot any message, so it is allowed to write to you.
3. Run `outcrop alerts telegram` on the server and paste the token (it is not shown), or use Settings in the console. It finds
   your chat from that first message and sends a test.

The bot sends alerts; it takes commands only when you turn them on (below), and only from your chat. Messages never contain
prompts, answers, tokens or passwords. Choose which rules go to Telegram in
Settings; `outcrop alerts test` sends a test, `outcrop alerts off` stops Telegram (the console still shows alerts). The bot
token is kept in `~/.outcrop/state/telegram.json` (0600), not in the database.

| Rule | When |
| --- | --- |
| A service failed or is restarting | an outcrop-engine@ unit, the gateway, the console or the bridge fails or crash-restarts; the gateway is down |
| GPU hot or throttling | above 83 °C, or thermal or power throttling, for a minute (a 250K-token prompt reaches 83 °C) |
| GPU contention | another process uses the GPU for 30 s (a remote desktop session cost 7 to 15% of decode speed) |
| Disk | under 10% free |
| API opened or closed | each time, including when an open window ends by itself |
| Bursts | 5 failed console sign-ins in 10 minutes, or 20 requests without a valid token in 5 minutes |
| Token expiry | a token expires within 7 days |
| Long jobs | a benchmark longer than a minute finished |

An alert is sent once when it opens and once when it clears; repeats are suppressed while it stays open. A service that
keeps crashing is one alert, cleared once it has run for 3 minutes without a restart. Setting up Telegram refuses to guess
when more than one person has written to the bot.

**Commands from Telegram** (off unless you turn them on: `outcrop alerts commands on`, or Settings): `/status`, `/switch
PRESET`, `/close` (require tokens again) and `/help`, from your own chat only; messages from anyone else are ignored. Nothing
that widens access can be done from Telegram (no opening the API, no tokens), and every command goes in the audit log. The
console asks Telegram for new messages itself, so no port is opened to the internet.

## Chat

The model in a conversation, with the chats kept on the server ([CHAT-API.md](CHAT-API.md) has the endpoints).

- **Fresh context:** each chat is its own context. **New chat** (Ctrl+Shift+O) starts one. The ring in the composer
  shows how full the context is, and at 90% it offers to start a new chat from a summary.
- **Answers are written on the server.** Close the tab mid-answer and it keeps going. The chat is the same on every
  device, live.
- **Versions:** ‹ 2 / 3 › under an answer after "regenerate", or after editing a question.
- **Titles** are written by the model after the first answer (when the GPU is idle, or within 30 s). Click a title to rename it; one you
  wrote is never replaced.
- **Spaces** group chats and can give every chat in them the same instructions. To move a chat:
  - drag it onto a space;
  - use the space chip in the chat's header;
  - use ⋯ → Move to…;
  - or select several with Shift or Ctrl, then Move.
- **Search** (the box, `/`, or Ctrl+K) forgives typos and opens the chat at the matching message.
- **🌐 Web** lets the model search and read pages. It is on for new chats and switches per chat.
  - Every search and page shows in the answer. Sources are numbered pills, with a card for each.
  - The model opens only links from its searches or links you wrote.
  - Web answers take about 30–90 s, mostly reading the pages. 💭 Think adds about 20 s.
- **Deleting** asks first and is permanent.
- **Settings → Chat** has the master switch for internet access (chat and apps) and export.

## Strata's own chat page

It is in the console (Chat's ⋯ menu, or Ctrl+K "engine's own page"; http://YOUR-SERVER.local:8080/ redirects there), signed in with the
internal key, on its own page. There it runs in a sandbox with an opaque origin, through a link that works for 12 hours
and only while your session lasts, so a bug in that page cannot reach the console's session or API. Its policy lets it load
nothing from other sites.

## Capture mode

The request log always keeps metadata (who, when, sizes, speeds), never the text. To debug an app, capture mode keeps the
full request and answer bodies for a while: for one token or all, for the next N requests, up to 7 days, shown as a banner
while it is on. Captured bodies are kept 7 days. The console's own chat and playground requests are never captured
unless capture names the console's token: deleting a chat must remove its text.

## Settings for every preset

Three choices apply to every preset, each explained where it is chosen, with the recommended one as the default:

| Setting | Choices | What it trades |
| --- | --- | --- |
| Exact answers (`exact_answers`) | off (the default), on | Off, the engine leaves out a word's smallest contributions (its route tail skip: experts past the seventh) when they would come from RAM or the disk. On computes every word in full: 3 to 6% slower with 32 GB of RAM, about 1% with every expert in RAM ([FINDINGS.md](FINDINGS.md)) |
| Longest conversation (`context`) | profile (the default), 131072, 262144 | Every preset's context limit, except the 1M presets'. The memory for it is set aside in advance, so a shorter one leaves more RAM for the experts |
| Models to keep (`packs`) | all (the default), boot | Every pack the hardware profile offers, or only the boot preset's: about 120 GB instead of 230 GB and up, with one preset at a time ([PROFILES.md](PROFILES.md)). It takes effect when the models are next downloaded: `./setup.sh`, or the next start on StartOS |

They are in presets.json's `settings` section, which applying a hardware profile keeps, and the same on the Settings page,
on the command line (`outcrop setting`, `outcrop setting exact_answers on`) and under Configure on StartOS. A running
preset takes them when restarted: the Settings page says when it still runs with the earlier ones and offers the restart
(StartOS restarts Outcrop by itself).

## Editing presets

The editor on the Presets page edits presets.json with validation (the structure, the packs, the engine arguments each preset
renders to, and that Strata stays on loopback behind the gateway) and a diff before saving. Saving asks for the password,
keeps a backup in `~/.outcrop/state/presets-backup-*.json`, and is applied to the running preset by Restart. presets.json
lives in `~/.outcrop`, outside the repo, so `git pull` and `./setup.sh update` never change it. When the hardware profiles
change, `outcrop profile diff NAME` shows what is new and `outcrop profile apply NAME` takes it.

The editor allows only the engine's own switches (`STRATA_*`) and a few thread and device settings as environment
variables, and engine arguments without paths.

## Scheduled switches

```sh
outcrop schedule add 22:00 quality-1m            # every night: the 1M-token context for long overnight jobs
outcrop schedule add 07:00 quality --days mon,tue,wed,thu,fri
outcrop schedule                                  # list (with ids); outcrop schedule off|on|remove ID
```

At its time the console starts the switch, which waits until no request is running, so an answer is never cut off. Each
schedule runs at most once a day and only within 10 minutes of its time (a server that was off at 22:00 does not switch at
06:00). Runs and changes are in the audit log; the API is `GET` and `PUT /api/schedules`.

## Automation

Scripts and home automation can use the console's API with an `admin` token (`outcrop token create home-assistant --scope admin
--cidr 192.168.1.40`) sent as `Authorization: Bearer` to `https://YOUR-SERVER.local/api/...` (with the CA trusted). For example,
switch presets with `POST /api/presets/speed/switch` and `{"when": "idle"}`, or read `GET /api/state`. A token never counts as
the password entered again, so it cannot create admin tokens, open the API for more than an hour, turn on the token-less
option, change CORS or Telegram, edit presets.json or download backups. Every action is in the audit log under
`token:NAME`.

## Backups

```sh
outcrop console backup                  # settings, token names and rules, the audit log, history and metrics; no secrets
outcrop console backup --secrets FILE   # also the token secrets and the keys: a restore needs nothing re-issued
outcrop console backup --no-chats       # without the saved chats (they are included otherwise)
outcrop console restore FILE            # stops and starts the gateway and the console; the old database is kept beside it
```

Without secrets, a restored server knows every token's name and rules but not their values: rotate each one (`outcrop token
rotate NAME`) and give the apps the new values. Keep a backup made with `--secrets` like a password. Settings in the console
can download either kind (it asks for the password again).

## Running it

| | |
| --- | --- |
| Service | `outcrop-console.service` (HTTPS on 443, the CA page and a redirect on 80), sandboxed, as the user who ran setup |
| Certificates | `~/.outcrop/state/tls/`; renewed by `outcrop-tls-renew.timer` 30 days before they end; `outcrop console tls renew` by hand |
| Database | `~/.outcrop/state/outcrop.db` (SQLite): requests 90 days, metrics 7 days at 10 s, 90 days at 1 min, 2 years at 1 h, the audit log 1 year |
| Logs | `journalctl -u outcrop-console` |
| Install, update | `setup/install-console.sh` and `setup/install-web.sh`; then `setup/deploy.sh` on the server after a push (it resumes a deploy that stopped halfway; `--force` applies everything) |

If the server's address changes, `outcrop console tls renew --add-name NEW` reissues the certificate, but only for names the
CA allows; a new address needs a new CA (delete `~/.outcrop/state/tls` and run `setup/install-console.sh`, then install the new CA
on your devices). A DHCP reservation for the server's address avoids this.

## Developing

On another computer, without a GPU: `cd console && uv run python dev.py --fresh` starts a fake Strata, the bridge, the gateway, a
traffic generator and the console on http://localhost:8800 (sign in with the password it prints). `cd web && pnpm
dev` serves the UI with hot reload on http://localhost:5173. `cd console && uv run pytest` runs the backend tests;
[web/README.md](../web/README.md) has the UI's.
