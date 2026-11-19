// Connect: "Web search for your apps" (docs/CONNECT-WEB.md).  A token with inference+web, then the settings for an app's
// MCP client: the remote endpoint, DeepSeek Harness, or the stdio bridge, with a note on trusting the server's CA.

import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Globe, KeyRound, ShieldAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { qk, useServerState, useTokens } from '@/lib/queries'
import type { TokenCreated } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls'
import { Field, Input } from '@/components/ui/input'
import { Badge, CopyButton, Panel, PanelHeader } from '@/components/ui/misc'

function Snippet({ code, label }: { code: string; label: string }) {
  return (
    <div className="relative">
      <pre tabIndex={0} aria-label={label} className="max-h-80 overflow-auto rounded-lg border border-line bg-sunken p-3.5 pr-12 font-mono text-[12.5px] leading-relaxed text-fg scrollbar-thin">
        {code}
      </pre>
      <CopyButton value={code} label={`Copy the ${label}`} className="absolute right-2 top-2" toastText="Copied" />
    </div>
  )
}

export function webSnippets(host: string, origin: string) {
  const url = `https://${host}:8443/tools/mcp`
  return {
    url,
    remote: JSON.stringify(
      { mcpServers: { web: { type: 'http', url, headers: { Authorization: 'Bearer ${OUTCROP_WEB_TOKEN}' } } } },
      null,
      2,
    ),
    harness: [
      '- id: mcp-web',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      '    serverName: web',
      '    transport: streamable-http',
      `    url: ${url}`,
      '    headers:',
      "      Authorization: !!js '`Bearer ${process.env.OUTCROP_WEB_TOKEN}`'",
    ].join('\n'),
    bridgeGet: `curl -o ~/.local/bin/outcrop-web-mcp ${origin}/dl/outcrop-web-mcp && chmod +x ~/.local/bin/outcrop-web-mcp`,
    bridge: JSON.stringify({ mcpServers: { web: { command: 'python3', args: ['/home/you/.local/bin/outcrop-web-mcp'] } } }, null, 2),
    ca: `${origin}/ca.crt`,
  }
}

export function WebForApps() {
  const qc = useQueryClient()
  const { data: st } = useServerState()
  const { data: tokens } = useTokens()
  const [name, setName] = useState('web-tools')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<TokenCreated | null>(null)
  const host = st?.urls.hostname ?? location.hostname
  const s = useMemo(() => webSnippets(host, location.origin), [host])
  const taken = new Set((tokens ?? []).filter((t) => t.status === 'active').map((t) => t.name))

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<TokenCreated>('/api/tokens', {
        name: name.trim(),
        scopes: ['inference', 'web'],
        listeners: ['openai'],
        cidrs: [],
        expires: '90d',
        notes: 'Web tools for an app, set up with Connect',
      })
      setMade(r)
      void qc.invalidateQueries({ queryKey: qk.tokens })
    } catch (e2) {
      if (!(e2 instanceof ApiError && e2.reauth)) setError((e2 as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel aria-labelledby="web-apps-title" data-testid="web-for-apps">
      <PanelHeader id="web-apps-title" icon={<Globe />} title="Web search for your apps" meta="MCP: web_search and open_page, run by this server" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 p-4 sm:p-5">
        <p className="max-w-3xl text-[13px] leading-relaxed text-muted">
          Apps with their own agent (DeepSeek Harness, Claude Code, Open WebUI, Cline…) can give the model the server’s web search through MCP. It is the
          same search and sandboxed page fetcher as Chat. A token needs the <Badge tone="info">web</Badge> scope, which no token has unless you grant it.
        </p>

        {made?.plaintext ? (
          <div className="grid gap-2 rounded-lg border border-answer/30 bg-answer-bg/40 p-3">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <KeyRound className="size-4 text-answer" aria-hidden />
              <span className="font-medium">The token for {made.token.name}</span>
              <span className="text-xs text-faint">shown once: keep it in a file on the app’s computer</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="num min-w-0 flex-1 break-all rounded-md bg-sunken px-2.5 py-1.5 text-[13px] text-answer" data-testid="web-token">
                {made.plaintext}
              </code>
              <CopyButton value={made.plaintext} label="Copy the token" toastText="Token copied" />
            </div>
            <Snippet
              label="command that saves the token"
              code={`mkdir -p ~/.config/outcrop && umask 077 && printf '%s' '${made.plaintext}' > ~/.config/outcrop/web-token\nexport OUTCROP_WEB_TOKEN=$(cat ~/.config/outcrop/web-token)`}
            />
            <Link to="/access" search={{ token: made.token.id }} className="link w-fit text-xs">
              Manage it on Access
            </Link>
          </div>
        ) : (
          <form onSubmit={create} className="flex flex-wrap items-end gap-3">
            <Field label="Token name" htmlFor="web-tok-name" hint="One per app, so each shows on its own and can be revoked alone." className="w-full min-w-0 sm:w-auto sm:min-w-56 sm:max-w-sm sm:flex-1">
              <Input id="web-tok-name" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} aria-invalid={taken.has(name.trim()) || undefined} />
            </Field>
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()} data-testid="web-token-create">
              <KeyRound aria-hidden /> Make a token with web tools
            </Button>
            {error ? (
              <p className="w-full rounded-md border border-error/30 bg-error-bg px-3 py-2 text-[13px]" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        )}

        <Tabs defaultValue="remote">
          <TabsList>
            <TabsTrigger value="remote">Remote MCP</TabsTrigger>
            <TabsTrigger value="harness">DeepSeek Harness</TabsTrigger>
            <TabsTrigger value="bridge">Local bridge (stdio)</TabsTrigger>
          </TabsList>
          <TabsContent value="remote" className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-2">
            <p className="text-xs text-faint">
              For apps that take a remote MCP server (Streamable HTTP): the URL <code className="break-all text-fg">{s.url}</code> and a header{' '}
              <code className="break-all text-fg">Authorization: Bearer &lt;the token&gt;</code>.
            </p>
            <Snippet label="MCP settings" code={s.remote} />
          </TabsContent>
          <TabsContent value="harness" className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-2">
            <p className="text-xs text-faint">Add this to the harness’s plugin list. The model sees the tools as mcp__web__web_search and mcp__web__open_page.</p>
            <Snippet label="harness plugin" code={s.harness} />
          </TabsContent>
          <TabsContent value="bridge" className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-2">
            <p className="text-xs text-faint">For apps that only start local MCP servers. One Python file, no dependencies; it reads the token from $OUTCROP_WEB_TOKEN or ~/.config/outcrop/web-token.</p>
            <Snippet label="download command" code={s.bridgeGet} />
            <Snippet label="bridge settings" code={s.bridge} />
          </TabsContent>
        </Tabs>

        <p className="text-xs leading-relaxed text-muted">
          <span className="font-medium text-fg">Trusting the server.</span> Node apps ignore the system’s certificates: start them with{' '}
          <code className="break-all text-fg">NODE_EXTRA_CA_CERTS=/path/to/computer-ca.crt</code>. The bridge takes <code className="break-all text-fg">--ca /path/to/computer-ca.crt</code> in its
          args (always needed with python.org’s Python on macOS). The certificate is at{' '}
          <a href={s.ca} className="link">
            {s.ca}
          </a>
          .
        </p>

        <div className="flex gap-3 rounded-lg border border-warn/35 bg-warn-bg p-3 text-[13px] leading-relaxed" role="note">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <p className="text-muted">
            <span className="font-medium text-fg">What the server cannot protect.</span> An app that gives its model web results and tools that act (files, a shell,
            email, smart-home controls) can be steered by a malicious page into misusing them, inside the app. Give the web scope to apps that ask before acting, not to
            unattended automations.
          </p>
        </div>
      </div>
    </Panel>
  )
}
