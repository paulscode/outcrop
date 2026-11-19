import { Link } from '@tanstack/react-router'
import { AlertOctagon, AlertTriangle, Bell, CheckCheck, CircleCheck, Info, Send } from 'lucide-react'
import { useEffect } from 'react'
import { ackAlerts } from '@/lib/actions'
import { ago } from '@/lib/format'
import { alertsStore } from '@/lib/live'
import { useAlerts } from '@/lib/queries'
import { useStore } from '@/lib/store'
import type { AlertRow } from '@/lib/types'
import { cn, useNow } from '@/lib/utils'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/menu'

export function levelIcon(level: string, closed?: boolean) {
  if (closed) return <CircleCheck className="size-4 text-ok" aria-label="cleared" />
  if (level === 'error') return <AlertOctagon className="size-4 text-error" aria-label="error" />
  if (level === 'warn') return <AlertTriangle className="size-4 text-warn" aria-label="warning" />
  return <Info className="size-4 text-info" aria-label="notice" />
}

export function AlertItem({ a, now }: { a: AlertRow; now: number }) {
  const closed = !!a.closed_at && a.closed_at !== a.opened_at
  return (
    <li className={cn('flex gap-2.5 rounded-md px-2 py-2', !a.acked_at && 'bg-panel-2/60')}>
      <span className="mt-0.5 shrink-0">{levelIcon(a.level, closed)}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-snug text-fg">{a.summary}</p>
        <p className="mt-0.5 flex items-center gap-2 text-xs text-faint">
          <span>{ago(a.opened_at, now)}</span>
          {closed ? <span>· cleared {ago(a.closed_at, now)}</span> : !a.closed_at ? <span className="text-warn">· open</span> : null}
          {a.sent?.telegram ? (
            <span className="inline-flex items-center gap-1" title={`Telegram: ${a.sent.telegram}`}>
              · <Send className="size-3" aria-hidden /> {a.sent.telegram === 'ok' ? 'sent' : 'failed'}
            </span>
          ) : null}
        </p>
      </div>
    </li>
  )
}

export function AlertBell() {
  const live = useStore(alertsStore)
  const q = useAlerts()
  useEffect(() => {
    if (live) q.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live])
  const data = live ?? q.data ?? null
  const now = useNow(15_000)
  const open = data?.open ?? []
  const recent = data?.recent ?? []
  const unacked = data?.unacked ?? 0
  const worst = open.some((a) => a.level === 'error') ? 'error' : open.some((a) => a.level === 'warn') ? 'warn' : unacked ? 'info' : null
  const count = unacked || open.length
  const list = [...open, ...recent.filter((r) => !open.some((o) => o.id === r.id))].slice(0, 12)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={count ? `Alerts: ${count} new` : 'Alerts'} className="relative" data-testid="alert-bell">
          <Bell />
          {count ? (
            <span
              className={cn(
                'num absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold',
                worst === 'error' ? 'bg-error text-bg' : worst === 'warn' ? 'bg-warn text-bg' : 'bg-fg text-bg',
              )}
            >
              {count > 9 ? '9+' : count}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(380px,calc(100vw-1.5rem))] p-0">
        <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
          <div className="text-[13px] font-semibold">Alerts</div>
          <div className="flex items-center gap-1">
            {unacked ? (
              <Button size="xs" variant="ghost" onClick={() => ackAlerts()}>
                <CheckCheck /> Mark all read
              </Button>
            ) : null}
          </div>
        </div>
        {list.length ? (
          <ul className="max-h-[60vh] overflow-y-auto p-1.5 scrollbar-thin">
            {list.map((a) => (
              <AlertItem key={a.id} a={a} now={now} />
            ))}
          </ul>
        ) : (
          <div className="px-4 py-8 text-center text-[13px] text-muted">
            <CircleCheck className="mx-auto mb-2 size-5 text-ok" aria-hidden />
            Nothing needs you.
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-faint">
          <span className="inline-flex items-center gap-1.5">
            <Send className="size-3" aria-hidden />
            {data?.telegram?.configured ? `Telegram: @${data.telegram.bot}` : 'Telegram is not set up'}
          </span>
          <span className="flex gap-3">
            <Link to="/timeline" className="link">
              Timeline
            </Link>
            <Link to="/settings" hash="alerts" className="link">
              Rules
            </Link>
          </span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
