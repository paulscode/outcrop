# Web search for your apps

Apps that run their own agent, such as DeepSeek Harness, Claude Code, Open WebUI or Cline, can give the model the
server's web search through MCP, the standard way of plugging tools into an agent. They get two tools:

- `web_search(query)`: numbered results, each with a title, a link and a snippet.
- `open_page(url)`: the readable text of a page from those results.

These are the same search (SearXNG on the server) and the same sandboxed page fetcher as the console's chat. The model
itself comes from the usual API: `https://YOUR-SERVER.local:8443/v1`, or `http://YOUR-SERVER.local:8080/v1`. Replace `SERVER`
with your server's hostname here and below.

## 1. A token with the `web` scope

No token has the `web` scope unless you grant it (admin tokens have it too, since admin can do everything). Make one for each app, so each app's use shows separately and you
can revoke it alone.

```sh
outcrop token create deepseek-harness --scope inference,web
```

The token is printed once. Keep it in a file on the app's computer, for example `~/.config/outcrop/web-token` (mode 0600),
rather than in the app's settings.

## 2. Connect the app

**If the app can use a remote MCP server** (Streamable HTTP), give it:

- URL: `https://YOUR-SERVER.local:8443/tools/mcp`, or `http://YOUR-SERVER.local:8080/tools/mcp` on the LAN without TLS
- Header: `Authorization: Bearer <the token>`

```json
{"mcpServers": {"web": {"type": "http", "url": "https://YOUR-SERVER.local:8443/tools/mcp",
                        "headers": {"Authorization": "Bearer ${OUTCROP_WEB_TOKEN}"}}}}
```

**If the app only starts local MCP servers (stdio)**, use the bridge. It is one Python file with no dependencies:

```sh
curl -o outcrop-ca.crt http://YOUR-SERVER.local/ca.crt         # the server's CA, if this computer doesn't trust it yet
curl --cacert outcrop-ca.crt -o ~/.local/bin/outcrop-web-mcp https://YOUR-SERVER.local/dl/outcrop-web-mcp && chmod +x ~/.local/bin/outcrop-web-mcp
```

```json
{"mcpServers": {"web": {"command": "python3", "args": ["/home/you/.local/bin/outcrop-web-mcp", "--url", "https://YOUR-SERVER.local:8443/tools/mcp"]}}}
```

The bridge needs the server's address (`--url`, or `$OUTCROP_WEB_URL`), and reads the token from `$OUTCROP_WEB_TOKEN`, or
else from `~/.config/outcrop/web-token`. If the computer doesn't trust
the server's CA, add `"--ca", "/path/to/outcrop-ca.crt"` to `args`; the certificate is at http://YOUR-SERVER.local/ca.crt.
Python from python.org on macOS ignores the system's trusted certificates, so it always needs `--ca`.

**DeepSeek Harness** connects to the endpoint directly. Its MCP client (`@deepseek-ai/dsh-mcp-client`) supports
`streamable-http` with headers, according to its README. Add an entry like
this to the harness's plugin list:

```yaml
- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: https://YOUR-SERVER.local:8443/tools/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.OUTCROP_WEB_TOKEN}`'
```

- **The tools' names:** they appear to the model as `mcp__web__web_search` and `mcp__web__open_page`.
- **Trusting the server:** the harness runs on Node, which ignores the system's trusted certificates. Start it with
  `NODE_EXTRA_CA_CERTS=/path/to/outcrop-ca.crt` (from http://YOUR-SERVER.local/ca.crt), or use
  `http://YOUR-SERVER.local:8080/tools/mcp` on a LAN you trust.
- **The model:** point the harness at `https://YOUR-SERVER.local:8443/v1` with a token. This one can serve both, since it
  has `inference,web`.

## 3. Check it

```sh
curl -s https://YOUR-SERVER.local:8443/tools/mcp -H "Authorization: Bearer $OUTCROP_WEB_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Each call shows on the console's Requests page as `tools/call web_search` or `tools/call open_page`, under the app's
token.

## What protects you

- **The `web` scope.** No token has it unless you grant it. Open mode never covers the web tools: a real token is always
  needed.
- **The master switch.** "Internet access" in the console's Settings turns the web tools off for the chat and every app
  at once.
- **The provenance rule, per token.** `open_page` opens only links that came back from that token's own searches in the
  last 24 hours. A page that tells the app's model to open `https://attacker.example/?d=<your data>` gets a refusal.
  "Apps may open any public link" in Settings lifts this for every app, for when you paste links into an app; turning
  it on asks for your password again.
- **Limits:** 30 calls a minute and 600 in any 24 hours per token, kept across restarts.
- **The fetcher can't reach your network.** The kernel stops it connecting to this machine and the LAN, and its code
  refuses private addresses, names that resolve to them, and redirects there.

**What the server cannot protect.** An app that gives its model web results **and** tools that act (writing files, a
shell, email, smart-home controls) can be steered by a malicious page into misusing those tools. That happens inside
the app, out of the server's reach. Give the `web` scope to apps that ask before acting, such as Claude Code with its
permission prompts. Don't give it to unattended automations that can act.
