import { Link } from '@tanstack/react-router'
import { ShieldCheck, ShieldOff } from 'lucide-react'
import { useState } from 'react'
import { closeApi, openApi } from '@/lib/actions'
import { clock, hm } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '../ui/menu'
import { Ring } from '../viz/basic'
import { useAuthMode, windowFraction } from './Banners'

export const OPEN_CHOICES = [
  { minutes: 15, label: '15 min' },
  { minutes: 60, label: '1 h' },
  { minutes: 240, label: '4 h' },
]

/** Open-for buttons: one tap each (more than an hour asks for the password again). */
export function OpenChoices({ onDone, className }: { onDone?: () => void; className?: string }) {
  const [busy, setBusy] = useState<number | null>(null)
  return (
    <div className={cn('grid grid-cols-3 gap-2', className)}>
      {OPEN_CHOICES.map((c) => (
        <Button
          key={c.minutes}
          variant="warn-outline"
          size="sm"
          loading={busy === c.minutes}
          onClick={async () => {
            setBusy(c.minutes)
            const ok = await openApi(c.minutes)
            setBusy(null)
            if (ok) onDone?.()
          }}
        >
          {c.label}
        </Button>
      ))}
    </div>
  )
}

/** The auth mode in the top bar: Enforced, or Open with its countdown. */
export function AuthPill() {
  const { open, until, left, now } = useAuthMode()
  const [o, setO] = useState(false)
  return (
    <Popover open={o} onOpenChange={setO}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="auth-pill"
          className={cn(
            'inline-flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-colors',
            open ? 'border-warn/40 bg-warn-bg text-warn hover:bg-warn/15' : 'border-line-strong bg-panel-2 text-fg hover:bg-panel-3',
          )}
        >
          {open ? (
            <>
              <Ring fraction={windowFraction(until, now)} size={14} stroke={2} />
              <span className="sr-only">The API is </span>
              <span className="hidden sm:inline">Open</span>
              <span className="sr-only sm:hidden">open</span>
              <span className="num">{clock(left)}</span>
              <span className="sr-only"> left</span>
            </>
          ) : (
            <>
              <ShieldCheck className="size-3.5 text-ok" aria-hidden />
              <span className="sr-only">The API is </span>
              <span className="sr-only sm:not-sr-only">Enforced</span>
              <span className="sr-only">: every request needs a token</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(340px,calc(100vw-1.5rem))]">
        {open ? (
          <div className="grid gap-3">
            <div className="flex items-start gap-3">
              <ShieldOff className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
              <div>
                <p className="text-[13px] font-semibold">The API is open until {hm(until)}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">
                  Requests without a token are allowed and logged as anonymous. It closes by itself.
                </p>
              </div>
            </div>
            <Button
              variant="warn"
              onClick={async () => {
                if (await closeApi()) setO(false)
              }}
            >
              Close now
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden />
              <div>
                <p className="text-[13px] font-semibold">Enforced: every request needs a token</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">
                  To test an app without a token, open the API for a while. It closes again by itself.
                </p>
              </div>
            </div>
            <div>
              <div className="eyebrow mb-1.5">Open for</div>
              <OpenChoices onDone={() => setO(false)} />
            </div>
          </div>
        )}
        <div className="mt-3 border-t border-line pt-2.5 text-xs">
          <PopoverClose asChild>
            <Link to="/access" className="link">
              Scope, tokens and more on Access
            </Link>
          </PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  )
}
