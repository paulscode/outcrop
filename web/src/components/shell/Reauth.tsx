import { KeyRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, setReauthHandler } from '@/lib/api'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Field, Input } from '../ui/input'

interface Pending {
  message?: string
  resolve: (ok: boolean) => void
}

/**
 * "Enter your password again": anything that widens access (an admin token, opening the API for more than an hour, the
 * token-less Ollama option, CORS, Telegram) asks for it when the last entry is over 10 minutes old.  The API client calls
 * this, then retries the action.
 */
export function ReauthHost() {
  const [pending, setPending] = useState<Pending | null>(null)
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // every request waiting for the password, the shown one first; a ref, so two asked in the same tick both wait for
  // the same answer (state would only update on the next render, and the first would never be answered)
  const queue = useRef<Pending[]>([])

  useEffect(() => {
    setReauthHandler(
      (message) =>
        new Promise<boolean>((resolve) => {
          const p = { message, resolve }
          queue.current.push(p)
          if (queue.current.length === 1) setPending(p)
        }),
    )
  }, [])

  const finish = (ok: boolean) => {
    for (const q of queue.current.splice(0)) q.resolve(ok)
    setPending(null)
    setPw('')
    setErr(null)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await api.post('/api/auth/reauth', { password: pw }, { no401: true, noReauth: true })
      finish(true)
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'that did not work')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && finish(false)}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <div className="mb-2 flex size-9 items-center justify-center rounded-lg border border-line-strong bg-panel-2">
              <KeyRound className="size-4 text-warn" aria-hidden />
            </div>
            <DialogTitle>Enter your password again</DialogTitle>
            <DialogDescription>
              {pending?.message && !/enter your password again/i.test(pending.message)
                ? pending.message
                : 'This widens access to the server, so the console asks for your password once more (it remembers it for 10 minutes).'}
            </DialogDescription>
          </DialogHeader>
          <Field label="Password" htmlFor="reauth-pw" error={err}>
            <Input
              id="reauth-pw"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              aria-invalid={!!err}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => finish(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!pw}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
