import { AlertTriangle, KeyRound, ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import { dateTime } from '@/lib/format'
import { qk, queryClient } from '@/lib/queries'
import type { Listener, Scope, Token, TokenCreated } from '@/lib/types'
import { Button } from '../ui/button'
import { Checkbox, Segmented } from '../ui/controls'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Field, Input, Select, Textarea } from '../ui/input'
import { CopyButton } from '../ui/misc'

export interface TokenFormValue {
  name: string
  scopes: Scope[]
  listeners: Listener[]
  cidrs: string
  expires: string
  rpm: string
  concurrency: string
  notes: string
  value: string
}

export const EXPIRY_CHOICES = [
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '365d', label: '1 year' },
  { value: 'never', label: 'Never' },
  { value: 'date', label: 'On a date…' },
]

export function emptyForm(name = ''): TokenFormValue {
  return { name, scopes: ['inference'], listeners: ['openai', 'ollama'], cidrs: '', expires: '90d', rpm: '', concurrency: '', notes: '', value: '' }
}

function refresh() {
  void queryClient.invalidateQueries({ queryKey: qk.tokens })
  void queryClient.invalidateQueries({ queryKey: qk.access })
  void queryClient.invalidateQueries({ queryKey: ['token'] })
}

/** The form for a new, imported or edited token. */
export function TokenForm({
  v,
  set,
  mode,
  error,
}: {
  v: TokenFormValue
  set: (v: TokenFormValue) => void
  mode: 'create' | 'import' | 'edit'
  error?: string | null
}) {
  const [date, setDate] = useState('')
  const toggleScope = (s: Scope, on: boolean) => set({ ...v, scopes: on ? [...new Set([...v.scopes, s])] : v.scopes.filter((x) => x !== s) })
  const listenerValue = v.listeners.length === 2 ? 'both' : v.listeners[0] ?? 'both'
  return (
    <div className="grid gap-4">
      <Field label="Name" htmlFor="tok-name" hint="Usually the app or the machine: it shows in the request log.">
        <Input id="tok-name" value={v.name} onChange={(e) => set({ ...v, name: e.target.value })} placeholder="open-webui" autoComplete="off" autoFocus />
      </Field>
      {mode === 'import' ? (
        <Field label="The existing token" htmlFor="tok-value" hint="At least 24 characters, no spaces. It is stored only as a keyed hash.">
          <Input id="tok-value" type="password" value={v.value} onChange={(e) => set({ ...v, value: e.target.value })} autoComplete="off" spellCheck={false} />
        </Field>
      ) : null}
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-[13px] font-medium">What it may do</legend>
        {(
          [
            ['inference', 'Ask the model', 'chat, messages, responses, models; the Ollama API'],
            ['telemetry', 'Read metrics', 'for Grafana or Home Assistant sensors'],
            ['web', 'Web tools', 'lets this app’s model search the web and read pages through the server (off unless you grant it)'],
            ['admin', 'Admin', 'loading, settings and the request log: asks for your password'],
          ] as Array<[Scope, string, string]>
        ).map(([s, label, hint]) => (
          <label key={s} className="flex items-start gap-2.5 text-[13px]">
            <Checkbox checked={v.scopes.includes(s)} onCheckedChange={(c) => toggleScope(s, c === true)} className="mt-0.5" aria-label={label} />
            <span>
              {label} <span className="text-faint">· {hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <span className="text-[13px] font-medium">Ports</span>
          <Segmented
            label="Ports this token works on"
            size="sm"
            value={listenerValue as 'both' | 'openai' | 'ollama'}
            onValueChange={(x) => set({ ...v, listeners: x === 'both' ? ['openai', 'ollama'] : [x] })}
            options={[
              { value: 'both', label: 'Both' },
              { value: 'openai', label: '8080', title: 'OpenAI and Anthropic APIs' },
              { value: 'ollama', label: '11434', title: 'Ollama API' },
            ]}
          />
        </div>
        <Field label="Expires" htmlFor="tok-exp">
          <div className="flex gap-2">
            <Select
              id="tok-exp"
              value={EXPIRY_CHOICES.some((c) => c.value === v.expires) ? v.expires : 'date'}
              onChange={(e) => set({ ...v, expires: e.target.value === 'date' ? date || 'date' : e.target.value })}
            >
              {mode === 'edit' ? <option value="keep">Keep as it is</option> : null}
              {EXPIRY_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
            {!EXPIRY_CHOICES.some((c) => c.value === v.expires) && v.expires !== 'keep' ? (
              <Input
                type="date"
                aria-label="Expiry date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value)
                  set({ ...v, expires: e.target.value || 'date' })
                }}
              />
            ) : null}
          </div>
        </Field>
      </div>
      <Field label="Only from these addresses" htmlFor="tok-cidr" hint="Optional: addresses or networks, like 192.168.1.30 or 192.168.1.0/24. Empty: any address on the LAN.">
        <Input id="tok-cidr" value={v.cidrs} onChange={(e) => set({ ...v, cidrs: e.target.value })} placeholder="192.168.1.30" spellCheck={false} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Requests per minute" htmlFor="tok-rpm" hint="Empty: no limit">
          <Input id="tok-rpm" inputMode="numeric" value={v.rpm} onChange={(e) => set({ ...v, rpm: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <Field label="At once" htmlFor="tok-conc" hint="Requests in flight; empty: no limit">
          <Input id="tok-conc" inputMode="numeric" value={v.concurrency} onChange={(e) => set({ ...v, concurrency: e.target.value.replace(/\D/g, '') })} />
        </Field>
      </div>
      <Field label="Notes" htmlFor="tok-notes">
        <Textarea id="tok-notes" rows={2} value={v.notes} onChange={(e) => set({ ...v, notes: e.target.value })} />
      </Field>
      {error ? (
        <p className="flex items-start gap-2 rounded-md border border-error/30 bg-error-bg px-3 py-2 text-[13px]" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-error" aria-hidden />
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function toBody(v: TokenFormValue) {
  const num = (s: string) => (s.trim() ? Number(s) : null)
  return {
    name: v.name.trim(),
    scopes: v.scopes,
    listeners: v.listeners,
    cidrs: v.cidrs.split(/[\s,]+/).filter(Boolean),
    expires: v.expires === 'date' ? 'never' : v.expires,
    rpm: num(v.rpm),
    concurrency: num(v.concurrency),
    notes: v.notes,
  }
}

/**
 * While a token is shown (once), the dialog closes only through its button: Esc, a click outside or the ✕ would lose it
 * for good.
 */
const keepOpen = {
  hideClose: true,
  onEscapeKeyDown: (e: Event) => e.preventDefault(),
  onInteractOutside: (e: Event) => e.preventDefault(),
}

/** The token, shown once, with copy; it cannot be shown again. */
export function TokenOnce({ name, plaintext, onDone, children }: { name: string; plaintext: string; onDone: () => void; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <div className="mb-2 flex size-9 items-center justify-center rounded-lg border border-line-strong bg-panel-2">
          <KeyRound className="size-4 text-ok" aria-hidden />
        </div>
        <DialogTitle>The token for {name}</DialogTitle>
        <DialogDescription>Copy it now: it is shown only once. The server keeps only a keyed hash of it.</DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-2 rounded-lg border border-line-strong bg-sunken p-3">
        <code className="num min-w-0 flex-1 break-all text-[13px] text-fg" data-testid="token-plaintext">
          {plaintext}
        </code>
        <span onClick={() => setCopied(true)}>
          <CopyButton value={plaintext} label="Copy the token" showLabel toastText="Token copied" />
        </span>
      </div>
      {children}
      <DialogFooter>
        <Button variant={copied ? 'primary' : 'secondary'} onClick={onDone}>
          {copied ? 'Done' : 'I have saved it'}
        </Button>
      </DialogFooter>
    </div>
  )
}

/** New token or import: the form, then the token once. */
export function NewTokenDialog({
  open,
  onOpenChange,
  mode = 'create',
  initialName,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  mode?: 'create' | 'import'
  initialName?: string
}) {
  const [v, setV] = useState(() => emptyForm(initialName))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<TokenCreated | null>(null)
  useEffect(() => {
    if (open) {
      setV(emptyForm(initialName))
      setError(null)
      setMade(null)
    }
  }, [open, initialName])
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body = { ...toBody(v), ...(mode === 'import' ? { value: v.value.trim() } : {}) }
      const r = await api.post<TokenCreated>(mode === 'import' ? '/api/tokens/import' : '/api/tokens', body)
      refresh()
      if (mode === 'import') {
        toast.success(`Token ${r.token.name} imported`, { description: 'Apps that already use it keep working.' })
        onOpenChange(false)
      } else setMade(r)
    } catch (e2) {
      if (!(e2 instanceof ApiError && e2.reauth)) setError((e2 as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" {...(made?.plaintext ? keepOpen : {})}>
        {made?.plaintext ? (
          <TokenOnce name={made.token.name} plaintext={made.plaintext} onDone={() => onOpenChange(false)} />
        ) : (
          <form onSubmit={submit} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>{mode === 'import' ? 'Import a token' : 'New token'}</DialogTitle>
              <DialogDescription>
                {mode === 'import'
                  ? 'Keep a key an app already has (for example from before the gateway): it becomes a named token you can limit, rotate and revoke.'
                  : 'One token per app, so each can be revoked alone and the log shows who sent what.'}
              </DialogDescription>
            </DialogHeader>
            <TokenForm v={v} set={setV} mode={mode} error={error} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy} disabled={!v.name.trim() || !v.scopes.length || v.expires === 'date' || (mode === 'import' && v.value.trim().length < 24)}>
                {mode === 'import' ? 'Import' : 'Create the token'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function EditTokenDialog({ token, onOpenChange }: { token: Token | null; onOpenChange: (o: boolean) => void }) {
  const [v, setV] = useState<TokenFormValue>(emptyForm())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (token)
      setV({
        name: token.name,
        scopes: token.scopes,
        listeners: token.listeners,
        cidrs: token.cidrs.join(', '),
        expires: 'keep',
        rpm: token.rpm ? String(token.rpm) : '',
        concurrency: token.concurrency ? String(token.concurrency) : '',
        notes: token.notes,
        value: '',
      })
    setError(null)
  }, [token])
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      const { expires, ...rest } = toBody(v)
      await api.patch(`/api/tokens/${token.id}`, v.expires === 'keep' ? rest : { ...rest, expires })
      refresh()
      toast.success(`Token ${v.name} saved`)
      onOpenChange(false)
    } catch (e2) {
      if (!(e2 instanceof ApiError && e2.reauth)) setError((e2 as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!token} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Edit {token?.name}</DialogTitle>
            <DialogDescription>
              Changes apply at once, without a restart. {token?.expires_at ? `It expires ${dateTime(token.expires_at)}.` : 'It never expires.'}
            </DialogDescription>
          </DialogHeader>
          <TokenForm v={v} set={setV} mode="edit" error={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function RotateDialog({ token, onOpenChange }: { token: Token | null; onOpenChange: (o: boolean) => void }) {
  const [grace, setGrace] = useState('24h')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<TokenCreated | null>(null)
  useEffect(() => {
    setMade(null)
    setGrace('24h')
  }, [token])
  const go = async () => {
    if (!token) return
    setBusy(true)
    try {
      const r = await api.post<TokenCreated>(`/api/tokens/${token.id}/rotate`, { grace })
      refresh()
      setMade(r)
    } catch (e) {
      toast.error('Rotating failed', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!token} onOpenChange={onOpenChange}>
      <DialogContent {...(made?.plaintext ? keepOpen : {})}>
        {made?.plaintext ? (
          <TokenOnce name={made.token.name} plaintext={made.plaintext} onDone={() => onOpenChange(false)}>
            <p className="text-xs text-muted">
              {grace === 'none' ? 'The old value stopped working now.' : `The old value keeps working for ${grace === '1h' ? 'an hour' : grace === '24h' ? 'a day' : 'a week'}, so you can update the app meanwhile.`}
            </p>
          </TokenOnce>
        ) : (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Rotate {token?.name}</DialogTitle>
              <DialogDescription>It gets a new value. Its name, limits and history stay.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <span className="text-[13px] font-medium">The old value keeps working for</span>
              <Segmented
                label="Grace period"
                value={grace as 'none' | '1h' | '24h' | '7d'}
                onValueChange={setGrace}
                options={[
                  { value: 'none', label: 'No grace' },
                  { value: '1h', label: '1 hour' },
                  { value: '24h', label: '1 day' },
                  { value: '7d', label: '1 week' },
                ]}
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={go} loading={busy}>
                Rotate
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function RevokeDialog({ token, onOpenChange }: { token: Token | null; onOpenChange: (o: boolean) => void }) {
  const [reason, setReason] = useState('')
  const [disconnect, setDisconnect] = useState(true)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setReason('')
    setDisconnect(true)
  }, [token])
  const go = async () => {
    if (!token) return
    setBusy(true)
    try {
      const r = await api.post<{ cancelled: number }>(`/api/tokens/${token.id}/revoke`, { reason, disconnect })
      refresh()
      toast.success(`${token.name} is revoked`, {
        description: `It stopped working at once${r.cancelled ? `; ${r.cancelled} running request${r.cancelled > 1 ? 's were' : ' was'} disconnected` : ''}.`,
      })
      onOpenChange(false)
    } catch (e) {
      toast.error('Revoking failed', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!token} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="grid gap-4">
          <DialogHeader>
            <div className="mb-2 flex size-9 items-center justify-center rounded-lg border border-error/30 bg-error-bg">
              <ShieldAlert className="size-4 text-error" aria-hidden />
            </div>
            <DialogTitle>Revoke {token?.name}?</DialogTitle>
            <DialogDescription>
              Every app using it gets a 401 from the next request on. This cannot be undone; you can make a new token later.
            </DialogDescription>
          </DialogHeader>
          <Field label="Reason (optional)" htmlFor="rv-reason">
            <Input id="rv-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="the laptop was sold" />
          </Field>
          <label className="flex items-center gap-2.5 text-[13px]">
            <Checkbox checked={disconnect} onCheckedChange={(c) => setDisconnect(c === true)} aria-label="Also disconnect its running requests" />
            Also disconnect its running requests
          </label>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={go} loading={busy} data-testid="confirm-revoke">
              Revoke
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
