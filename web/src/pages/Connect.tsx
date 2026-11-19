import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowLeft, Check, CheckCircle2, ChevronRight, KeyRound, Plug, Radar, RotateCcw, ShieldAlert, Smartphone } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { APPS, appById, matchesApp, monogram, type ConnectApp, type ConnectTarget } from '@/lib/apps'
import { dur, int } from '@/lib/format'
import { useLiveTopic, type LiveMsg } from '@/lib/live'
import { qk, queryClient, useServerState, useTokens } from '@/lib/queries'
import type { TokenCreated } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger, Segmented } from '@/components/ui/controls'
import { Field, Input, Select } from '@/components/ui/input'
import { Badge, CopyButton, LiveRegion, Panel, PanelHeader } from '@/components/ui/misc'
import { Qr } from '@/components/viz/Qr'
import { WebForApps } from '@/components/connect/WebForApps'

type Step = 'pick' | 'token' | 'settings'

interface Conn {
  status: 'waiting' | 'arriving' | 'connected' | 'refused'
  ip?: string
  app?: string
  path?: string
  ttft?: number | null
  status_code?: number | null
  reason?: string
  rid?: string
}

const DIALECT: Record<string, string> = { openai: 'OpenAI API', anthropic: 'Anthropic API', ollama: 'Ollama API' }

function Stepper({ step }: { step: Step }) {
  const steps: Array<[Step, string]> = [
    ['pick', 'Pick the app'],
    ['token', 'Make its token'],
    ['settings', 'Settings and the first request'],
  ]
  const idx = steps.findIndex(([s]) => s === step)
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]" aria-label="Steps">
      {steps.map(([s, label], i) => (
        <li key={s} className="flex items-center gap-2" aria-current={i === idx ? 'step' : undefined}>
          <span
            className={cn(
              'num flex size-6 items-center justify-center rounded-full border text-xs',
              i < idx ? 'border-transparent bg-fg text-bg' : i === idx ? 'border-fg text-fg' : 'border-line-strong text-faint',
            )}
          >
            {i < idx ? <Check className="size-3.5" aria-hidden /> : i + 1}
          </span>
          <span className={cn(i === idx ? 'font-medium text-fg' : 'text-faint')}>{label}</span>
          {i < steps.length - 1 ? <ChevronRight className="size-3.5 text-line-strong" aria-hidden /> : null}
        </li>
      ))}
    </ol>
  )
}

function AppTile({ app, onPick }: { app: ConnectApp; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="group flex items-center gap-3 rounded-xl border border-line bg-panel p-3.5 text-left transition-colors hover:border-line-strong hover:bg-panel-2"
      data-testid={`app-${app.id}`}
    >
      <span className="num flex size-10 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-panel-3 text-[13px] font-semibold text-fg">
        {monogram(app.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium">{app.name}</span>
        <span className="block truncate text-xs text-faint">{app.blurb}</span>
      </span>
      <ChevronRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden />
    </button>
  )
}

/** The listening panel: it lights up when this token's first request arrives. */
function Listener({ app, token, conn }: { app: ConnectApp; token: TokenCreated; conn: Conn }) {
  const connected = conn.status === 'connected'
  const tone = connected ? 'var(--answer)' : conn.status === 'refused' ? 'var(--error)' : conn.status === 'arriving' ? 'var(--read)' : 'var(--fg-faint)'
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border p-5 transition-colors duration-500',
        connected ? 'border-answer/50 bg-answer-bg' : conn.status === 'refused' ? 'border-error/40 bg-error-bg' : 'border-line bg-sunken/60',
      )}
      data-testid="connect-status"
    >
      <div className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full opacity-20 blur-2xl transition-colors duration-700" style={{ background: tone }} aria-hidden />
      <div className="relative flex items-start gap-3">
        <span className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center">
          {conn.status === 'waiting' ? <span className="animate-pulse-ring absolute inset-0 rounded-full bg-faint/40" aria-hidden /> : null}
          {connected ? (
            <CheckCircle2 className="relative size-7 text-answer" aria-hidden />
          ) : conn.status === 'refused' ? (
            <ShieldAlert className="relative size-6 text-error" aria-hidden />
          ) : (
            <Radar className={cn('relative size-6', conn.status === 'arriving' ? 'text-read' : 'text-muted')} aria-hidden />
          )}
        </span>
        <div className="min-w-0" role="status" aria-live="polite">
          {connected ? (
            <>
              <p className="text-[15px] font-semibold text-fg" data-testid="connected-line">
                Connected: {conn.app ?? app.name} from <span className="num">{conn.ip}</span>
                {conn.ttft !== null && conn.ttft !== undefined ? (
                  <>
                    , first token <span className="num">{dur(conn.ttft)}</span>
                  </>
                ) : null}
              </p>
              <p className="mt-1 text-[13px] text-muted">
                Token <span className="font-medium text-fg">{token.token.name}</span> works.{' '}
                {conn.app && !matchesApp(app, conn.app) ? `The request came from ${conn.app}, not ${app.name}; that is fine if you tested with it. ` : ''}
                {conn.rid ? (
                  <Link to="/requests" search={{ rid: conn.rid }} className="link">
                    See the request
                  </Link>
                ) : null}
              </p>
            </>
          ) : conn.status === 'arriving' ? (
            <>
              <p className="text-[15px] font-semibold">A request is arriving from {conn.app ?? 'the app'}…</p>
              <p className="mt-1 text-[13px] text-muted">
                From <span className="num">{conn.ip}</span> to <span className="num">{conn.path}</span>; the model is answering it.
              </p>
            </>
          ) : conn.status === 'refused' ? (
            <>
              <p className="text-[15px] font-semibold text-error">A request was refused</p>
              <p className="mt-1 text-[13px] text-muted">
                {conn.app ?? 'An app'} at <span className="num">{conn.ip}</span>: {conn.reason}. Check that the token is pasted whole, with no spaces.
              </p>
            </>
          ) : (
            <>
              <p className="text-[15px] font-semibold">Waiting for the first request from {app.name}…</p>
              <p className="mt-1 text-[13px] text-muted">Paste the settings, then send it anything. This lights up the moment its first request with this token arrives.</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  return `${base}-${Date.now() % 10000}`
}

export default function Connect() {
  const search = useSearch({ strict: false }) as { app?: string }
  const navigate = useNavigate()
  const { data: st } = useServerState()
  const { data: tokens } = useTokens()
  const app = appById(search.app) ?? null
  const [step, setStep] = useState<Step>(app ? 'token' : 'pick')
  const [name, setName] = useState('')
  const [hostKind, setHostKind] = useState<'address' | 'name'>('address')
  const [cidr, setCidr] = useState('')
  const [expires, setExpires] = useState('90d')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<TokenCreated | null>(null)
  const [conn, setConn] = useState<Conn>({ status: 'waiting' })

  useEffect(() => {
    if (app && !made) setStep('token')
    if (!app) setStep('pick')
  }, [app, made])
  const taken = useMemo(() => new Set((tokens ?? []).filter((t) => t.status === 'active').map((t) => t.name)), [tokens])
  useEffect(() => {
    if (app) setName(uniqueName(app.tokenName, taken))
    // only when the app changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.id])

  const address = st?.urls.addresses?.[0] ?? (st ? new URL(st.urls.openai).hostname : window.location.hostname)
  const target: ConnectTarget | null =
    app && made?.plaintext && st
      ? {
          host: hostKind === 'name' ? st.urls.hostname : address,
          openaiPort: st.urls.openai_port,
          ollamaPort: st.urls.ollama_port,
          model: st.server.model_id,
          token: made.plaintext,
        }
      : null

  // Light up on this token's first request (and say so when one is refused).
  const onRequest = (m: LiveMsg) => {
    if (m.snapshot || !made) return
    const d = m.d as Record<string, unknown>
    if (d.token_id !== made.token.id) return
    if (d.type === 'request.start' && conn.status === 'waiting') {
      setConn({ status: 'arriving', ip: d.client_ip as string, app: d.app as string, path: d.path as string, rid: d.rid as string })
    } else if (d.type === 'request.end' && conn.status !== 'connected') {
      const ttft = typeof d.ttft_ms === 'number' ? d.ttft_ms / 1000 : null
      const ok = (d.status as number) < 400
      setConn(
        ok
          ? { status: 'connected', ip: d.client_ip as string, app: d.app as string, path: d.path as string, ttft, rid: d.rid as string, status_code: d.status as number }
          : { status: 'refused', ip: d.client_ip as string, app: d.app as string, reason: `${d.status} ${(d.error as string) ?? ''}`.trim() },
      )
      void queryClient.invalidateQueries({ queryKey: qk.tokens })
    }
  }
  const onAuth = (m: LiveMsg) => {
    if (m.snapshot || !made || !app || conn.status === 'connected') return
    const d = m.d as { app?: string; ip?: string; reason?: string; token?: string | null }
    if (d.token === made.token.name || matchesApp(app, d.app)) setConn({ status: 'refused', ip: d.ip, app: d.app, reason: d.reason ?? 'no valid token' })
  }
  useLiveTopic('requests', onRequest, step === 'settings')
  useLiveTopic('auth', onAuth, step === 'settings')

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!app) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<TokenCreated>('/api/tokens', {
        name: name.trim(),
        scopes: ['inference'],
        listeners: app.listeners,
        cidrs: cidr.split(/[\s,]+/).filter(Boolean),
        expires,
        notes: `${app.name}, set up with Connect`,
      })
      setMade(r)
      setConn({ status: 'waiting' })
      setStep('settings')
      void queryClient.invalidateQueries({ queryKey: qk.tokens })
    } catch (e2) {
      if (!(e2 instanceof ApiError && e2.reauth)) setError((e2 as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const restart = () => {
    setMade(null)
    setConn({ status: 'waiting' })
    navigate({ to: '/connect', search: {} })
  }

  return (
    <div className="grid gap-4">
      <LiveRegion message={conn.status === 'connected' ? `Connected: ${conn.app} from ${conn.ip}` : ''} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Stepper step={step} />
        {step !== 'pick' ? (
          <Button variant="ghost" size="sm" onClick={restart}>
            {made ? <RotateCcw /> : <ArrowLeft />} {made ? 'Connect another app' : 'Pick another app'}
          </Button>
        ) : null}
      </div>

      {step === 'pick' ? (
        <Panel>
          <PanelHeader icon={<Plug />} title="Which app do you want to connect?" meta="each gets its own token" />
          <div className="grid gap-2.5 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {APPS.map((a) => (
              <AppTile key={a.id} app={a} onPick={() => navigate({ to: '/connect', search: { app: a.id } })} />
            ))}
          </div>
        </Panel>
      ) : null}

      {step === 'pick' ? <WebForApps /> : null}

      {step === 'token' && app ? (
        <Panel className="max-w-2xl">
          <PanelHeader icon={<KeyRound />} title={`A token for ${app.name}`} meta={DIALECT[app.dialect]} />
          <form onSubmit={create} className="grid gap-4 p-5">
            <Field label="Token name" htmlFor="c-name" hint="It shows in the request log and on Access.">
              <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid content-start gap-1.5">
                <span className="text-[13px] font-medium">Reach the server by</span>
                <Segmented
                  label="Address or name"
                  size="sm"
                  value={hostKind}
                  onValueChange={setHostKind}
                  options={[
                    { value: 'address', label: address },
                    { value: 'name', label: st?.urls.hostname ?? 'name' },
                  ]}
                />
                <span className="text-xs text-faint">The name needs mDNS (most Macs and Linux; Windows 10+).</span>
              </div>
              <Field label="Expires" htmlFor="c-exp">
                <Select id="c-exp" value={expires} onChange={(e) => setExpires(e.target.value)}>
                  <option value="30d">in 30 days</option>
                  <option value="90d">in 90 days</option>
                  <option value="365d">in a year</option>
                  <option value="never">never</option>
                </Select>
              </Field>
            </div>
            <Field label="Only from this address (optional)" htmlFor="c-cidr" hint="The computer the app runs on, like 192.168.1.50. Empty: any address on the LAN.">
              <Input id="c-cidr" value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="192.168.1.50" spellCheck={false} />
            </Field>
            <p className="text-xs text-muted">
              It may only ask the model ({app.listeners.length === 2 ? 'both ports' : app.listeners[0] === 'ollama' ? 'the Ollama port, 11434' : 'port 8080'}). You can
              limit or revoke it on Access at any time.
            </p>
            {error ? (
              <p className="rounded-md border border-error/30 bg-error-bg px-3 py-2 text-[13px]" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()} data-testid="connect-create">
                Make the token and show the settings
              </Button>
            </div>
          </form>
        </Panel>
      ) : null}

      {step === 'settings' && app && made && target ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="grid content-start gap-4">
            <Listener app={app} token={made} conn={conn} />
            <Panel>
              <PanelHeader title={`${app.name} settings`} meta={DIALECT[app.dialect]} />
              <div className="grid gap-4 p-4">
                <ul className="grid gap-2">
                  {app.fields(target).map((f) => (
                    <li key={f.label} className="grid gap-1 sm:grid-cols-[13rem_1fr_auto] sm:items-center sm:gap-3">
                      <span className="text-xs text-faint">{f.label}</span>
                      <code className={cn('num min-w-0 break-all rounded-md bg-sunken px-2.5 py-1.5 text-[13px]', f.secret && 'text-answer')} data-testid={f.secret ? 'connect-token' : undefined}>
                        {f.value}
                      </code>
                      <CopyButton value={f.value} label={`Copy ${f.label}`} toastText={`${f.label} copied`} />
                    </li>
                  ))}
                </ul>
                {app.steps?.length ? (
                  <ol className="grid gap-1.5 rounded-lg border border-line bg-panel-2/50 p-3 text-[13px]">
                    {app.steps.map((s, i) => (
                      <li key={i} className="flex gap-2.5">
                        <span className="num flex size-5 shrink-0 items-center justify-center rounded-full bg-panel-3 text-[11px] text-muted">{i + 1}</span>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {app.snippets(target).length ? (
                  <Tabs defaultValue={app.snippets(target)[0].id}>
                    <TabsList>
                      {app.snippets(target).map((s) => (
                        <TabsTrigger key={s.id} value={s.id}>
                          {s.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                    {app.snippets(target).map((s) => (
                      <TabsContent key={s.id} value={s.id} className="mt-3">
                        {s.where ? <p className="mb-2 text-xs text-faint">{s.where}</p> : null}
                        <div className="relative">
                          <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-sunken p-3.5 pr-12 font-mono text-[12.5px] leading-relaxed text-fg scrollbar-thin">
                            {s.code}
                          </pre>
                          <CopyButton value={s.code} label={`Copy the ${s.label} settings`} className="absolute right-2 top-2" toastText="Copied" />
                        </div>
                      </TabsContent>
                    ))}
                  </Tabs>
                ) : null}
                {app.note ? <p className="rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-[13px]">{app.note}</p> : null}
              </div>
            </Panel>
          </div>
          <div className="grid content-start gap-4">
            <Panel className="p-4">
              <div className="flex items-center gap-2 text-[13px] font-medium">
                <Smartphone className="size-4 text-faint" aria-hidden /> For a phone or another computer
              </div>
              <div className="mt-3 flex justify-center">
                <Qr text={app.qr(target)} size={208} label={`QR code with the ${app.name} settings and the token`} />
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted">The base URL and the token. Made here in the browser; nothing is sent anywhere.</p>
            </Panel>
            <Panel className="p-4 text-[13px]">
              <div className="flex items-center gap-2">
                <KeyRound className="size-4 text-warn" aria-hidden />
                <span className="font-medium">Shown once</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                This page is the only place the token is shown. If you lose it, rotate it on Access for a new value.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <Badge>{made.token.name}</Badge>
                <span className="num text-faint">{made.token.hint}</span>
                <span className="text-faint">· expires {made.token.expires_at ? `in ${int((made.token.expires_at - Date.now() / 1000) / 86400)} days` : 'never'}</span>
              </div>
              <Link to="/access" search={{ token: made.token.id }} className="link mt-3 inline-block text-xs">
                Manage it on Access
              </Link>
            </Panel>
          </div>
        </div>
      ) : null}
    </div>
  )
}
