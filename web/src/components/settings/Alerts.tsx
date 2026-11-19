import { useQueryClient } from '@tanstack/react-query'
import { AlertOctagon, AlertTriangle, Bell, Eye, EyeOff, Info, Send, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/controls'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, Label } from '@/components/ui/input'
import { Tip } from '@/components/ui/menu'
import { Badge, Empty, KV, LiveRegion, Skeleton } from '@/components/ui/misc'
import { api, ApiError } from '@/lib/api'
import { ago, dateTime } from '@/lib/format'
import { qk, useAlerts } from '@/lib/queries'
import type { AlertRule, AlertsSummary, TelegramPublic } from '@/lib/types'
import { cn, useNow } from '@/lib/utils'
import { Callout, SettingsSection } from './Section'

const LEVEL = {
  error: { tone: 'error' as const, word: 'failure', Icon: AlertOctagon, color: 'text-error' },
  warn: { tone: 'warn' as const, word: 'warning', Icon: AlertTriangle, color: 'text-warn' },
  info: { tone: 'info' as const, word: 'notice', Icon: Info, color: 'text-info' },
}

function RuleRow({
  id,
  rule,
  telegram,
  onChange,
}: {
  id: string
  rule: AlertRule
  telegram: boolean
  onChange: (id: string, next: { enabled: boolean; telegram: boolean }) => void
}) {
  const lv = LEVEL[rule.level] ?? LEVEL.info
  return (
    <li className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 gap-y-1 px-4 py-2.5 sm:px-5" data-testid={`rule-${id}`}>
      <div className="flex min-w-0 items-center gap-2.5">
        <lv.Icon className={cn('size-4 shrink-0', lv.color)} aria-hidden />
        <span className={cn('text-[13px]', rule.enabled ? 'text-fg' : 'text-faint line-through decoration-line-strong')}>{rule.label}</span>
        <Badge tone={lv.tone} className="hidden sm:inline-flex">
          {lv.word}
        </Badge>
      </div>
      <div className="flex w-16 justify-center">
        <Switch
          checked={rule.enabled}
          onCheckedChange={(v) => onChange(id, { enabled: v, telegram: rule.telegram })}
          aria-label={`Alert: ${rule.label}`}
        />
      </div>
      <div className="flex w-16 justify-center">
        <Tip content={!telegram ? 'Set up Telegram below to receive these on your phone' : rule.enabled ? undefined : 'Turn the alert on first'}>
          <span>
            <Switch
              checked={rule.telegram && rule.enabled}
              disabled={!rule.enabled}
              onCheckedChange={(v) => onChange(id, { enabled: rule.enabled, telegram: v })}
              aria-label={`Send to Telegram: ${rule.label}`}
            />
          </span>
        </Tip>
      </div>
    </li>
  )
}

function TelegramSetup({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.put<TelegramPublic>('/api/alerts/telegram', { token: token.trim() })
      qc.setQueryData<AlertsSummary>(qk.alerts, (p) => (p ? { ...p, telegram: r } : p))
      void qc.invalidateQueries({ queryKey: qk.alerts })
      setToken('')
      toast.success('Telegram alerts are set up', { description: `A test message went to ${r.chat_name ?? 'your chat'} from @${r.bot}.` })
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The console is not answering.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="grid gap-4">
      <ol className="grid gap-3 text-[13px] leading-relaxed">
        {[
          <>
            In Telegram, open <strong className="font-medium text-fg">@BotFather</strong>, send <code className="rounded bg-panel-2 px-1 text-xs">/newbot</code>{' '}
            and follow its questions. It gives you a token like <code className="num rounded bg-panel-2 px-1 text-xs">123456:ABC-…</code>
          </>,
          <>Open your new bot and send it any message, so the console can find your chat.</>,
          <>Paste the token here. The console finds your chat and sends a test message.</>,
        ].map((t, i) => (
          <li key={i} className="flex gap-3">
            <span className="num flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong bg-panel-2 text-xs text-fg">
              {i + 1}
            </span>
            <span className="pt-0.5 text-muted">{t}</span>
          </li>
        ))}
      </ol>
      <div className="grid gap-1.5">
        <Label htmlFor="tg-token">Bot token</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Input
              id="tg-token"
              type={show ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder="123456789:AA…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              aria-invalid={!!error || undefined}
              className="num pr-10"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-faint hover:text-fg"
              aria-label={show ? 'Hide the token' : 'Show the token'}
              aria-pressed={show}
            >
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <Button type="submit" variant="primary" loading={busy} disabled={!token.includes(':')}>
            <Send /> Connect and send a test
          </Button>
        </div>
        <p className="text-xs text-faint">
          The token is kept in the server’s state folder (readable only by its owner), never in the database, and the console
          never shows it again. Changing it asks for your password again.
        </p>
      </div>
      {error ? (
        <Callout tone="error" icon={X} title="That did not work">
          {error}
          {/unauthorized|not found|refused/i.test(error) ? (
            <span className="mt-1 block text-xs">Telegram did not accept the token: check that you pasted all of it, as @BotFather gave it.</span>
          ) : null}
        </Callout>
      ) : null}
    </form>
  )
}

/** Telegram commands: /status, /switch PRESET, /close, only from your own chat; off unless turned on. */
function TelegramCommands({ on }: { on: boolean }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const set = async (enabled: boolean) => {
    setBusy(true)
    try {
      const r = await api.put<TelegramPublic>('/api/alerts/commands', { enabled })
      qc.setQueryData<AlertsSummary>(qk.alerts, (p) => (p ? { ...p, telegram: r } : p))
      toast.success(enabled ? 'Telegram commands are on' : 'Telegram commands are off', {
        description: enabled ? 'Your chat can send /status, /switch PRESET and /close.' : 'The bot only sends again.',
      })
    } catch (e) {
      if (!(e instanceof ApiError && e.reauth)) toast.error('That did not work', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-start gap-3 rounded-lg border border-line p-3">
      <Switch checked={on} disabled={busy} onCheckedChange={set} aria-label="Accept commands from your Telegram chat" className="mt-0.5" />
      <div className="text-[13px]">
        <p className="font-medium text-fg">Commands from your chat</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">
          {on ? (
            <>
              On: from your own chat only, <code className="rounded bg-panel-2 px-1">/status</code>, <code className="rounded bg-panel-2 px-1">/switch PRESET</code> and{' '}
              <code className="rounded bg-panel-2 px-1">/close</code> (close the API). Anything from another chat is ignored.
            </>
          ) : (
            'Off: the bot only sends, and ignores anything written to it. Turning it on asks for your password again.'
          )}
        </p>
      </div>
    </div>
  )
}

export function AlertsSection() {
  const qc = useQueryClient()
  const { data, isPending, isError, error, refetch } = useAlerts()
  const now = useNow(30_000)
  const [replace, setReplace] = useState(false)
  const [testing, setTesting] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [announce, setAnnounce] = useState('')
  const tg = data?.telegram
  const rules = data?.rules ?? {}

  const changeRule = async (id: string, next: { enabled: boolean; telegram: boolean }) => {
    const prev = data
    qc.setQueryData<AlertsSummary>(qk.alerts, (p) =>
      p?.rules ? { ...p, rules: { ...p.rules, [id]: { ...p.rules[id], ...next } } } : p,
    )
    try {
      const r = await api.put<Record<string, AlertRule>>('/api/alerts/rules', { [id]: next })
      qc.setQueryData<AlertsSummary>(qk.alerts, (p) => (p ? { ...p, rules: r } : p))
      setAnnounce(`${rules[id]?.label ?? id}: ${next.enabled ? 'on' : 'off'}${next.enabled ? `, Telegram ${next.telegram ? 'on' : 'off'}` : ''}`)
    } catch (e) {
      qc.setQueryData(qk.alerts, prev)
      toast.error('Saving the rule failed', { description: e instanceof ApiError ? e.message : String(e) })
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const r = await api.post<{ ok: boolean; message: string; telegram: TelegramPublic }>('/api/alerts/test')
      qc.setQueryData<AlertsSummary>(qk.alerts, (p) => (p ? { ...p, telegram: r.telegram } : p))
      if (r.ok) toast.success('Test message sent', { description: `Check ${r.telegram.chat_name ?? 'your Telegram chat'}.` })
      else toast.error('The test message failed', { description: r.message })
    } catch (e) {
      toast.error('The test message failed', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  const remove = async () => {
    setRemoving(true)
    try {
      const r = await api.del<TelegramPublic>('/api/alerts/telegram')
      qc.setQueryData<AlertsSummary>(qk.alerts, (p) => (p ? { ...p, telegram: r } : p))
      toast.success('Telegram alerts removed', { description: 'Alerts still show in the console’s bell and Timeline.' })
      setConfirmRemove(false)
    } catch (e) {
      toast.error('Removing Telegram failed', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setRemoving(false)
    }
  }

  return (
    <SettingsSection
      id="alerts"
      title="Alerts"
      icon={Bell}
      meta={tg?.configured ? `Telegram: @${tg.bot}` : 'In the console only'}
      description="Every alert shows in the bell and on the Timeline. The ones you choose also go to your Telegram, from a bot you create. Messages are short and never contain prompts, answers, tokens or passwords; a repeat is suppressed while an alert stays open, and a message says when it clears."
    >
      <LiveRegion message={announce} />
      <div className="grid gap-6">
        <div className="-mx-4 overflow-hidden border-y border-line sm:-mx-5">
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 border-b border-line bg-panel-2/50 px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-faint sm:px-5">
            <span>When</span>
            <Tip content="Off: this rule raises nothing and sends nothing">
              <span className="w-16 cursor-help text-center">Alert</span>
            </Tip>
            <Tip content="Also send it to your Telegram chat">
              <span className="w-16 cursor-help text-center">Telegram</span>
            </Tip>
          </div>
          {isPending ? (
            <div className="grid gap-2 p-4">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-7" />
              ))}
            </div>
          ) : isError ? (
            <Empty title="The alert rules did not load" action={<Button onClick={() => refetch()}>Try again</Button>}>
              {(error as Error).message}
            </Empty>
          ) : (
            <ul className="divide-y divide-line">
              {Object.entries(rules).map(([id, r]) => (
                <RuleRow key={id} id={id} rule={r} telegram={!!tg?.configured} onChange={changeRule} />
              ))}
            </ul>
          )}
        </div>

        <div className="grid gap-4">
          <div className="flex items-center gap-2">
            <Send className="size-4 text-faint" aria-hidden />
            <h3 className="text-[13px] font-semibold text-fg">Telegram</h3>
            {tg?.configured ? <Badge tone="ok">connected</Badge> : <Badge>not set up</Badge>}
          </div>
          {tg?.configured && !replace ? (
            <div className="grid gap-4">
              <KV
                rows={[
                  ['Bot', <span className="num">@{tg.bot}</span>],
                  ['Sends to', <span>{tg.chat_name ?? '—'} <span className="num text-faint">({tg.chat_id})</span></span>],
                  ['Token', <span className="num text-faint">{tg.token_hint ?? '—'}</span>],
                  [
                    'Last sent',
                    tg.last_ok ? (
                      <Tip content={dateTime(tg.last_ok)}>
                        <span className="text-ok">{ago(tg.last_ok, now)}</span>
                      </Tip>
                    ) : (
                      <span className="text-faint">nothing yet</span>
                    ),
                  ],
                ]}
              />
              {tg.last_error && (!tg.last_ok || (tg.last_error_at ?? 0) > tg.last_ok) ? (
                <Callout tone="error" icon={AlertOctagon} title={`The last message failed ${ago(tg.last_error_at, now)}`}>
                  {tg.last_error}. Alerts still show in the console; check the bot token or the server’s internet access.
                </Callout>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={test} loading={testing}>
                  <Send /> Send a test message
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setReplace(true)}>
                  Use another bot
                </Button>
                <Button size="sm" variant="danger-outline" onClick={() => setConfirmRemove(true)}>
                  <Trash2 /> Remove
                </Button>
              </div>
              <TelegramCommands on={!!tg.commands} />
            </div>
          ) : (
            <>
              <TelegramSetup onDone={() => setReplace(false)} />
              {replace ? (
                <div>
                  <Button size="sm" variant="ghost" onClick={() => setReplace(false)}>
                    Keep @{tg?.bot}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Stop Telegram alerts?</DialogTitle>
            <DialogDescription>
              The console forgets the bot token. Alerts keep showing in the bell and on the Timeline. You can set Telegram up again
              at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove} loading={removing}>
              Remove Telegram
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  )
}
