import { useNavigate, useSearch } from '@tanstack/react-router'
import { Eye, EyeOff, Lock, ShieldAlert, TerminalSquare } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { clock } from '@/lib/format'
import { qk, queryClient } from '@/lib/queries'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/controls'
import { Input, Label } from '@/components/ui/input'
import { LogoMark } from '@/components/shell/Logo'

/** A quiet geological cross-section behind the sign-in card: strata lines, drawn once (no animation). */
function Strata() {
  const layers = [
    { y: 62, c: 'var(--layer-7)', o: 0.55 },
    { y: 68, c: 'var(--layer-5)', o: 0.5 },
    { y: 74, c: 'var(--layer-2)', o: 0.45 },
    { y: 80, c: 'var(--layer-1)', o: 0.4 },
    { y: 86, c: 'var(--layer-3)', o: 0.35 },
    { y: 92, c: 'var(--layer-4)', o: 0.3 },
  ]
  return (
    <svg className="pointer-events-none absolute inset-x-0 bottom-0 h-[55vh] w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      {layers.map((l, i) => (
        <path
          key={i}
          d={`M0 ${l.y} C 18 ${l.y - 6 + i}, 34 ${l.y + 5}, 52 ${l.y - 2} S 82 ${l.y - 9 + i * 0.5}, 100 ${l.y - 4} L100 100 L0 100 Z`}
          fill={l.c}
          opacity={l.o * 0.35}
        />
      ))}
      {layers.map((l, i) => (
        <path
          key={`s${i}`}
          d={`M0 ${l.y} C 18 ${l.y - 6 + i}, 34 ${l.y + 5}, 52 ${l.y - 2} S 82 ${l.y - 9 + i * 0.5}, 100 ${l.y - 4}`}
          fill="none"
          stroke={l.c}
          strokeOpacity={0.5}
          strokeWidth={0.12}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  )
}

export default function SignIn() {
  const navigate = useNavigate()
  const search = useSearch({ from: '/signin' })
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [locked, setLocked] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now() / 1000)
  const pwRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!locked) return
    const id = setInterval(() => {
      const n = Date.now() / 1000
      setNow(n)
      if (n >= locked) {
        setLocked(null)
        setError(null)
      }
    }, 500)
    return () => clearInterval(id)
  }, [locked])

  useEffect(() => {
    // Already signed in? Go straight in.
    api
      .get('/api/auth/session', { no401: true })
      .then(() => navigate({ to: search.next ?? '/', replace: true }))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (locked) return
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/auth/login', { username: username.trim(), password, remember }, { no401: true, noReauth: true })
      queryClient.removeQueries({ queryKey: qk.state })
      await navigate({ to: search.next ?? '/', replace: true })
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          const ra = (err as ApiError & { retryAfter?: number }).retryAfter
          setLocked(Date.now() / 1000 + (ra && Number.isFinite(ra) ? ra : 60))
          setNow(Date.now() / 1000)
          setError(err.message)
        } else if (err.status === 401) {
          setError('Wrong username or password.')
          setPassword('')
          pwRef.current?.focus()
        } else {
          setError(err.message)
        }
      } else setError('The console is not answering.')
    } finally {
      setBusy(false)
    }
  }

  const left = locked ? Math.max(0, locked - now) : 0

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-bg px-4 py-10">
      <Strata />
      <div className="relative w-full max-w-[380px]">
        <div className="mb-7 flex flex-col items-center text-center">
          <LogoMark className="size-11" />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Outcrop</h1>
          <p className="mt-1 text-[13px] text-muted">The console of the local model server</p>
        </div>
        <form onSubmit={submit} className="panel grid gap-4 p-6" aria-describedby={error ? 'signin-error' : undefined} noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your user name on the server"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                ref={pwRef}
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!error && !locked}
                className="pr-10"
                required
              />
              <button
                type="button"
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-faint hover:text-fg"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? 'Hide the password' : 'Show the password'}
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-muted">
            <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} aria-label="Remember this device for 30 days" />
            Remember this device for 30 days
          </label>
          {error ? (
            <div
              id="signin-error"
              role="alert"
              data-testid="signin-error"
              className={
                locked
                  ? 'flex gap-2.5 rounded-lg border border-warn/35 bg-warn-bg p-3 text-[13px] text-fg'
                  : 'flex gap-2.5 rounded-lg border border-error/35 bg-error-bg p-3 text-[13px] text-fg'
              }
            >
              <ShieldAlert className={locked ? 'mt-0.5 size-4 shrink-0 text-warn' : 'mt-0.5 size-4 shrink-0 text-error'} aria-hidden />
              <div>
                <p>{locked ? 'Too many failed sign-ins from this address.' : error}</p>
                {locked ? (
                  <p className="mt-1 text-muted">
                    Try again in <span className="num text-fg" data-testid="lockout-countdown">{clock(left)}</span>. Each
                    further failure doubles the wait, up to an hour.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
          <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!password || !!locked}>
            <Lock aria-hidden /> Sign in
          </Button>
        </form>
        <p className="mt-5 flex items-start justify-center gap-2 text-center text-xs leading-relaxed text-faint">
          <TerminalSquare className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Forgot the password? Set a new one over SSH:{' '}
            <code className="whitespace-nowrap rounded bg-panel-2 px-1 py-0.5 text-muted">outcrop console passwd</code>
          </span>
        </p>
      </div>
    </div>
  )
}
