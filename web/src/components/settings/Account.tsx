import { useQueryClient } from '@tanstack/react-query'
import { Check, Eye, EyeOff, KeyRound, Lightbulb, Loader2, Sparkles, UserRound, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { CopyButton, LiveRegion } from '@/components/ui/misc'
import { api, ApiError } from '@/lib/api'
import { dateTime, int } from '@/lib/format'
import { qk, useServerState, useSession } from '@/lib/queries'
import type { PasswordVerdict } from '@/lib/types'
import { cn, useDebounced } from '@/lib/utils'
import { Callout, SettingsSection } from './Section'

const WORDS = ['very weak', 'weak', 'fair', 'strong', 'very strong']

/** Four bars and plain words: how hard the new password is to guess, from the server's own check (zxcvbn + the rules). */
export function StrengthMeter({ verdict, checking, length }: { verdict: PasswordVerdict | null; checking: boolean; length: number }) {
  const score = verdict?.score ?? 0
  const ok = !!verdict?.ok
  const color = !verdict ? 'var(--line-strong)' : ok ? 'var(--ok)' : score >= 2 ? 'var(--warn)' : 'var(--error)'
  const min = verdict?.min_length ?? 16
  return (
    <div className="grid gap-2" data-testid="strength-meter">
      <div className="flex items-center gap-1.5" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className="h-1.5 flex-1 rounded-full transition-colors duration-300"
            style={{ background: verdict && (score >= i || (ok && i <= 4)) ? color : 'var(--line)' }}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className={cn('font-medium', !verdict ? 'text-faint' : ok ? 'text-ok' : score >= 2 ? 'text-warn' : 'text-error')}>
          {checking && !verdict ? (
            <span className="inline-flex items-center gap-1.5 text-faint">
              <Loader2 className="size-3 animate-spin" aria-hidden /> Checking…
            </span>
          ) : verdict ? (
            <>
              {ok ? 'Strong enough' : `Not accepted yet: ${WORDS[score] ?? ''}`}
              {verdict.crack_time ? (
                <span className="font-normal text-faint">
                  {' '}
                  · {/^(less than|centuries)/.test(verdict.crack_time) ? verdict.crack_time : `about ${verdict.crack_time}`} to guess offline
                </span>
              ) : null}
            </>
          ) : (
            'Type a new password, or generate one'
          )}
        </span>
        <span className={cn('num', length >= min || length === 0 ? 'text-faint' : 'text-warn')}>
          {int(length)} of at least {int(min)} characters
        </span>
      </div>
      {verdict && (verdict.reasons.length || verdict.suggestions.length) ? (
        <ul className="grid gap-1 text-xs leading-relaxed">
          {verdict.reasons.map((r) => (
            <li key={r} className="flex gap-1.5 text-fg">
              <X className="mt-0.5 size-3.5 shrink-0 text-error" aria-label="problem" />
              <span>{r[0].toUpperCase() + r.slice(1)}</span>
            </li>
          ))}
          {verdict.suggestions.map((s) => (
            <li key={s} className="flex gap-1.5 text-muted">
              <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-faint" aria-label="suggestion" />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      ) : verdict?.ok ? (
        <p className="flex items-center gap-1.5 text-xs text-ok">
          <Check className="size-3.5" aria-hidden /> It meets every rule.
        </p>
      ) : null}
    </div>
  )
}

function PasswordInput({
  id,
  value,
  onChange,
  show,
  onToggle,
  autoComplete,
  invalid,
  describedBy,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  show: boolean
  onToggle?: () => void
  autoComplete: string
  invalid?: boolean
  describedBy?: string
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        spellCheck={false}
        autoCapitalize="none"
        className={onToggle ? 'pr-10' : undefined}
      />
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-faint hover:text-fg"
          aria-label={show ? 'Hide the passwords' : 'Show the passwords'}
          aria-pressed={show}
        >
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      ) : null}
    </div>
  )
}

export function AccountSection() {
  const qc = useQueryClient()
  const { data: st } = useServerState()
  const { data: sess } = useSession()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [generated, setGenerated] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [verdict, setVerdict] = useState<PasswordVerdict | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const meterId = useId()
  const dNext = useDebounced(next, 350)

  // The server checks the candidate (the breached-password list and zxcvbn live there); nothing is cached.
  useEffect(() => {
    if (!dNext) {
      setVerdict(null)
      setChecking(false)
      return
    }
    const ac = new AbortController()
    setChecking(true)
    api
      .post<PasswordVerdict>('/api/auth/password/check', { password: dNext }, { signal: ac.signal })
      .then((v) => {
        setVerdict(v)
        setAnnounce(v.ok ? 'The new password is strong enough' : `Not accepted yet: ${v.reasons[0] ?? ''}`)
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') setVerdict(null)
      })
      .finally(() => {
        if (!ac.signal.aborted) setChecking(false)
      })
    return () => ac.abort()
  }, [dNext])

  useEffect(() => {
    if (next !== dNext) setChecking(!!next)
  }, [next, dNext])

  const generate = async () => {
    setGenerating(true)
    try {
      const r = await api.get<{ passphrase: string }>('/api/auth/generate')
      setNext(r.passphrase)
      setConfirm(r.passphrase)
      setGenerated(r.passphrase)
      setShow(true)
    } catch (e) {
      toast.error('Generating a passphrase failed', { description: (e as Error).message })
    } finally {
      setGenerating(false)
    }
  }

  const mismatch = !!confirm && confirm !== next
  const fresh = verdict && dNext === next
  const canSubmit = !!current && !!next && confirm === next && !!fresh && verdict!.ok && !busy

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/auth/password', { current, new: next }, { no401: true, noReauth: true })
      setCurrent('')
      setNext('')
      setConfirm('')
      setGenerated(null)
      setVerdict(null)
      setShow(false)
      void qc.invalidateQueries({ queryKey: qk.sessions })
      toast.success('Password changed', { description: 'Every other session was signed out; this one stays.' })
      setAnnounce('Password changed')
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) setError('The current password is wrong.')
        else if (err.status === 429) setError(err.message)
        else setError(err.message)
      } else setError('The console is not answering.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      id="account"
      title="Account and password"
      icon={UserRound}
      meta={st?.user ? `Signed in as ${st.user}` : undefined}
      description={
        <>
          One account, with a password only, so it has to be strong: <strong className="font-medium text-fg">at least 16 characters</strong>,
          any characters, spaces welcome. A few unrelated words make a good one. Common and breached passwords are refused, and so
          are ones containing your username, the server’s name, “outcrop”, “strata” or “qwen”. Changing it signs out every other
          session.
        </>
      }
    >
      <LiveRegion message={announce} />
      <form onSubmit={submit} className="grid max-w-xl gap-4" autoComplete="on">
        <input type="text" name="username" autoComplete="username" value={st?.user ?? ''} readOnly hidden />
        <Field label="Current password" htmlFor="pw-current">
          <PasswordInput
            id="pw-current"
            value={current}
            onChange={(v) => {
              setCurrent(v)
              setError(null)
            }}
            show={false}
            autoComplete="current-password"
          />
        </Field>
        <div className="grid gap-1.5">
          <div className="flex items-end justify-between gap-2">
            <label htmlFor="pw-new" className="text-[13px] font-medium text-fg">
              New password
            </label>
            <Button type="button" size="xs" variant="ghost" onClick={generate} loading={generating}>
              {generating ? null : <Sparkles />} Generate a passphrase
            </Button>
          </div>
          <PasswordInput
            id="pw-new"
            value={next}
            onChange={(v) => {
              setNext(v)
              if (generated && v !== generated) setGenerated(null)
            }}
            show={show}
            onToggle={() => setShow((s) => !s)}
            autoComplete="new-password"
            invalid={!!verdict && fresh === true && !verdict.ok}
            describedBy={meterId}
          />
          <div id={meterId} className="mt-1">
            <StrengthMeter verdict={fresh ? verdict : null} checking={checking} length={next.length} />
          </div>
        </div>
        {generated ? (
          <Callout tone="ok" icon={KeyRound} title="Your new passphrase">
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code className="num rounded-md border border-line bg-sunken px-2 py-1 text-[13px] text-fg" data-testid="generated-passphrase">
                {generated}
              </code>
              <CopyButton value={generated} label="Copy the passphrase" showLabel />
            </div>
            <p className="mt-2 text-xs">
              Six random words, about 77 bits. Save it in your password manager or write it down before you change the password.
            </p>
          </Callout>
        ) : null}
        <Field label="New password, again" htmlFor="pw-confirm" error={mismatch ? 'The two new passwords are not the same.' : undefined}>
          <PasswordInput id="pw-confirm" value={confirm} onChange={setConfirm} show={show} autoComplete="new-password" invalid={mismatch} />
        </Field>
        {error ? (
          <Callout tone="error" icon={X} title={error} />
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>
            Change the password
          </Button>
          <span className="text-xs text-faint">
            {sess ? <>This session started {dateTime(sess.created_at)}{sess.remember ? ', remembered on this device' : ''}.</> : null}
          </span>
        </div>
      </form>
    </SettingsSection>
  )
}
