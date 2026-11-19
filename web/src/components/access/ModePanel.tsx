import { Globe, Plus, ShieldCheck, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { closeApi, openApi } from '@/lib/actions'
import { api, ApiError } from '@/lib/api'
import { clock, dur, hm } from '@/lib/format'
import { qk, queryClient, useAccess, useSessions } from '@/lib/queries'
import { cn, useNow } from '@/lib/utils'
import { Button } from '../ui/button'
import { Segmented, Switch } from '../ui/controls'
import { Input } from '../ui/input'
import { Badge, Panel, PanelHeader } from '../ui/misc'
import { Tip } from '../ui/menu'
import { Ring } from '../viz/basic'
import { useAuthMode } from '../shell/Banners'

/** Addresses as removable chips with an input; "this device" is one tap. */
function AddressChips({
  value,
  onChange,
  myIp,
  placeholder = '192.168.1.30',
  label,
}: {
  value: string[]
  onChange: (v: string[]) => void
  myIp?: string | null
  placeholder?: string
  label: string
}) {
  const [text, setText] = useState('')
  const add = (a: string) => {
    const x = a.trim()
    if (x && !value.includes(x)) onChange([...value, x])
    setText('')
  }
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((a) => (
          <span key={a} className="num inline-flex h-7 items-center gap-1 rounded-md border border-line-strong bg-panel-2 pl-2 pr-1 text-xs">
            {a}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== a))} className="rounded p-0.5 text-faint hover:text-fg" aria-label={`Remove ${a}`}>
              <X className="size-3" />
            </button>
          </span>
        ))}
        {myIp && !value.includes(myIp) ? (
          <Button type="button" size="xs" variant="outline" onClick={() => add(myIp)}>
            <Plus /> this device ({myIp})
          </Button>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Input
          aria-label={label}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add(text)
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          className="h-8"
        />
        <Button type="button" size="sm" variant="secondary" onClick={() => add(text)} disabled={!text.trim()}>
          Add
        </Button>
      </div>
    </div>
  )
}

const DURATIONS = [
  { minutes: 15, label: '15 min' },
  { minutes: 60, label: '1 h' },
  { minutes: 240, label: '4 h' },
]

/** One clear control: Enforced or Open (for a set time, to a scope), with the countdown ring. */
export function ModePanel() {
  const { data: access } = useAccess()
  const { data: sessions } = useSessions()
  const { open, until, left, addresses, listeners } = useAuthMode()
  const now = useNow(1000)
  const myIp = sessions?.find((s) => s.current)?.ip ?? null
  const [who, setWho] = useState<'lan' | 'some'>('lan')
  const [addrs, setAddrs] = useState<string[]>([])
  const [where, setWhere] = useState<'both' | 'openai' | 'ollama'>('both')
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const start = access?.mode?.at ?? null
  const total = until && start ? until - start : null
  const fraction = until ? Math.max(0, Math.min(1, total ? (until - now) / total : 1)) : 0

  const doOpen = async (minutes: number, key: string) => {
    if (who === 'some' && !addrs.length) {
      toast.error('Add at least one address, or choose the whole LAN')
      return
    }
    setBusy(key)
    await openApi(minutes, who === 'some' ? addrs : [], where === 'both' ? [] : [where])
    setBusy(null)
  }

  return (
    <Panel className={cn('overflow-hidden', open && 'border-warn/40')} aria-labelledby="mode-title">
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className={cn('relative flex items-center gap-5 p-5 sm:p-6', open ? 'bg-warn-bg' : '')}>
          <Ring
            fraction={open ? fraction : 1}
            size={92}
            stroke={6}
            color={open ? 'var(--warn)' : 'var(--ok)'}
            label={open ? `${dur(left)} left of the open window` : 'enforced'}
          >
            {open ? (
              <span className="num text-[15px] font-medium text-warn" data-testid="access-countdown">
                {clock(left)}
              </span>
            ) : (
              <ShieldCheck className="size-7 text-ok" aria-hidden />
            )}
          </Ring>
          <div className="min-w-0">
            <div id="mode-title" className={cn('text-xs font-semibold uppercase tracking-[0.14em]', open ? 'text-warn' : 'text-ok')} data-testid="access-mode">
              {open ? 'Open' : 'Enforced'}
            </div>
            <p className="mt-1 text-[15px] font-medium leading-snug">
              {open ? `Requests without a token are allowed until ${hm(until)}.` : 'Every request needs a token.'}
            </p>
            <p className="mt-1 text-[13px] text-muted">
              {open
                ? `${addresses.length ? `Only ${addresses.join(', ')}` : 'The whole LAN'}, ${!listeners.length || listeners.length === 2 ? 'both ports' : listeners[0] === 'ollama' ? 'the Ollama port only' : 'the OpenAI/Anthropic port only'}. It closes by itself; anonymous requests are logged.`
                : 'Apps send their own token; anything else gets a 401 in its own API format.'}
            </p>
            {open ? (
              <Button className="mt-3" variant="warn" size="sm" loading={busy === 'close'} onClick={async () => { setBusy('close'); await closeApi(); setBusy(null) }}>
                Close now
              </Button>
            ) : null}
          </div>
        </div>
        <div className="grid gap-4 border-t border-line p-5 sm:p-6 lg:border-l lg:border-t-0">
          <div>
            <div className="eyebrow mb-2">{open ? 'Open it again for' : 'Open for testing, for'}</div>
            <div className="flex flex-wrap items-center gap-2">
              {DURATIONS.map((d) => (
                <Button key={d.minutes} variant="warn-outline" size="sm" loading={busy === String(d.minutes)} onClick={() => doOpen(d.minutes, String(d.minutes))} data-testid={`open-${d.minutes}`}>
                  {d.label}
                </Button>
              ))}
              <div className="flex items-center gap-1.5">
                <Input
                  aria-label="Custom time in minutes, up to 24 hours"
                  inputMode="numeric"
                  placeholder="min"
                  className="h-8 w-20"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value.replace(/\D/g, ''))}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!custom || Number(custom) < 1 || Number(custom) > 1440}
                  loading={busy === 'custom'}
                  onClick={() => doOpen(Number(custom), 'custom')}
                >
                  Open
                </Button>
              </div>
            </div>
            <p className="mt-1.5 text-xs text-faint">Up to 24 hours. More than an hour asks for your password again.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid content-start gap-1.5">
              <span className="text-[13px] font-medium">Who</span>
              <Segmented
                label="Who may call without a token"
                size="sm"
                value={who}
                onValueChange={setWho}
                options={[
                  { value: 'lan', label: 'Whole LAN' },
                  { value: 'some', label: 'Only some' },
                ]}
              />
            </div>
            <div className="grid content-start gap-1.5">
              <span className="text-[13px] font-medium">Where</span>
              <Segmented
                label="Which port opens"
                size="sm"
                value={where}
                onValueChange={setWhere}
                options={[
                  { value: 'both', label: 'Both' },
                  { value: 'openai', label: '8080', title: 'OpenAI and Anthropic APIs' },
                  { value: 'ollama', label: '11434', title: 'Ollama API' },
                ]}
              />
            </div>
          </div>
          {who === 'some' ? <AddressChips value={addrs} onChange={setAddrs} myIp={myIp} label="Add an address or network" /> : null}
        </div>
      </div>
    </Panel>
  )
}

/** The token-less Ollama option: off; on only for named addresses, on the Ollama port only. */
export function TokenlessPanel() {
  const { data } = useAccess()
  const t = data?.tokenless
  const [addrs, setAddrs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (t) setAddrs(t.addresses)
  }, [t])
  const save = async (enabled: boolean, addresses = addrs) => {
    setBusy(true)
    try {
      await api.put('/api/access/ollama-tokenless', { enabled, addresses })
      void queryClient.invalidateQueries({ queryKey: qk.access })
      void queryClient.invalidateQueries({ queryKey: qk.state })
      toast(enabled ? 'Token-less Ollama is on for those addresses' : 'Token-less Ollama is off')
    } catch (e) {
      if (!(e instanceof ApiError && e.reauth)) toast.error('That did not work', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel>
      <PanelHeader
        title="Ollama without a token"
        meta="for an app that cannot send one"
        actions={
          <Switch
            checked={!!t?.enabled}
            disabled={busy || (!t?.enabled && !addrs.length)}
            onCheckedChange={(on) => save(on)}
            aria-label="Allow token-less requests on the Ollama port from these addresses"
          />
        }
      />
      <div className="grid gap-3 p-4 text-[13px]">
        <p className="text-muted">
          {t?.enabled ? (
            <>
              <Badge tone="warn">on</Badge> Requests from these addresses to port 11434 need no token. It shows on the posture card.
            </>
          ) : (
            'Off: every app sends a token. Turn it on only for one app that cannot, by its address; a small adapter that adds the token is better.'
          )}
        </p>
        <AddressChips value={addrs} onChange={(a) => { setAddrs(a); if (t?.enabled) void save(true, a) }} label="Address allowed without a token" />
      </div>
    </Panel>
  )
}

/** CORS: browser apps on other origins that may call the API (password again to change). */
export function CorsPanel() {
  const { data } = useAccess()
  const [list, setList] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (data) setList(data.cors ?? [])
  }, [data])
  const dirty = JSON.stringify(list) !== JSON.stringify(data?.cors ?? [])
  return (
    <Panel>
      <PanelHeader
        icon={<Globe />}
        title="Browser apps (CORS)"
        meta="origins allowed to call the API from a web page"
        actions={
          <Button
            size="sm"
            variant={dirty ? 'primary' : 'secondary'}
            disabled={!dirty}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await api.put('/api/access/cors', { origins: list })
                void queryClient.invalidateQueries({ queryKey: qk.access })
                toast.success('CORS origins saved')
              } catch (e) {
                if (!(e instanceof ApiError && e.reauth)) toast.error('Saving failed', { description: (e as Error).message })
              } finally {
                setBusy(false)
              }
            }}
          >
            Save
          </Button>
        }
      />
      <div className="grid gap-3 p-4 text-[13px]">
        <p className="text-muted">
          {list.length ? 'Pages on these origins may call the API (with a token).' : 'None: browser pages on other sites cannot call the API.'}{' '}
          <Tip content="The gateway refuses cross-site browser POSTs unless their origin is listed here. Apps that are not web pages are not affected.">
            <span className="underline decoration-dotted underline-offset-2">Why</span>
          </Tip>
        </p>
        <AddressChips value={list} onChange={setList} placeholder="https://chat.example" label="Add an origin" />
      </div>
    </Panel>
  )
}

