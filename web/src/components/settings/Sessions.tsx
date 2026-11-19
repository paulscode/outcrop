import { useQueryClient } from '@tanstack/react-query'
import { Laptop, LogOut, MonitorSmartphone, Smartphone, TerminalSquare } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tip } from '@/components/ui/menu'
import { Badge, Empty, Skeleton } from '@/components/ui/misc'
import { signOut } from '@/lib/actions'
import { api, ApiError } from '@/lib/api'
import { ago, dateTime, device, int } from '@/lib/format'
import { qk, useSessions } from '@/lib/queries'
import type { SessionRow } from '@/lib/types'
import { useNow } from '@/lib/utils'
import { SettingsSection } from './Section'

function DeviceIcon({ ua }: { ua: string | null }) {
  const d = device(ua)
  const Icon = /iOS|Android/.test(d) ? Smartphone : /curl/.test(d) ? TerminalSquare : Laptop
  return <Icon className="size-4 shrink-0 text-faint" aria-hidden />
}

function SessionItem({ s, now, onEnd, busy }: { s: SessionRow; now: number; onEnd: (s: SessionRow) => void; busy: boolean }) {
  const name = device(s.user_agent)
  const action = s.current ? (
    <Button size="xs" variant="ghost" onClick={() => signOut()}>
      <LogOut /> Sign out
    </Button>
  ) : (
    <Button size="xs" variant="danger-outline" onClick={() => onEnd(s)} loading={busy} aria-label={`Sign out ${name} at ${s.ip ?? 'unknown address'}`}>
      Sign out
    </Button>
  )
  const active = s.current ? 'now' : ago(s.last_seen_at, now)
  return (
    <li className="px-4 py-3 sm:px-5" data-testid="session-row">
      <div className="flex items-start gap-3 sm:grid sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_6.5rem] sm:items-center sm:gap-x-4">
        <div className="flex min-w-0 flex-1 items-start gap-2.5 sm:items-center">
          <span className="mt-0.5 sm:mt-0">
            <DeviceIcon ua={s.user_agent} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-[13px] font-medium text-fg">{name}</span>
              {s.current ? <Badge tone="ok">This device</Badge> : null}
              {s.remember ? (
                <Tip content="Signed in with “Remember this device”: it stays signed in for 30 days.">
                  <Badge>remembered</Badge>
                </Tip>
              ) : null}
            </div>
            <Tip content={s.user_agent || 'No user agent'}>
              <p className="num truncate text-xs text-faint">{s.ip ?? '—'}</p>
            </Tip>
            <p className="mt-0.5 text-xs text-muted sm:hidden">
              Active {active} · signed in {ago(s.created_at, now)}
            </p>
          </div>
        </div>
        <Tip content={dateTime(s.last_seen_at)}>
          <span className="hidden text-[13px] text-muted sm:inline">{active}</span>
        </Tip>
        <Tip content={`Signed in ${dateTime(s.created_at)}; ends ${dateTime(s.expires_at)} unless used again`}>
          <span className="hidden text-[13px] text-muted sm:inline">{ago(s.created_at, now)}</span>
        </Tip>
        <div className="shrink-0 sm:flex sm:justify-end">{action}</div>
      </div>
    </li>
  )
}

export function SessionsSection() {
  const qc = useQueryClient()
  const { data, isPending, isError, error, refetch } = useSessions()
  const now = useNow(30_000)
  const [ending, setEnding] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const [allBusy, setAllBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const SHOWN = 6
  const others = (data ?? []).filter((s) => !s.current)

  const endOne = async (s: SessionRow) => {
    setEnding(s.id)
    try {
      await api.del(`/api/auth/sessions/${encodeURIComponent(s.id)}`)
      toast.success('Session signed out', { description: `${device(s.user_agent)} at ${s.ip ?? 'an unknown address'}` })
      void qc.invalidateQueries({ queryKey: qk.sessions })
    } catch (e) {
      toast.error('Signing out that session failed', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setEnding(null)
    }
  }

  const endOthers = async () => {
    setAllBusy(true)
    try {
      const r = await api.post<{ ended: number }>('/api/auth/sessions/end-others')
      toast.success(r.ended ? `Signed out ${int(r.ended)} other session${r.ended === 1 ? '' : 's'}` : 'There were no other sessions')
      void qc.invalidateQueries({ queryKey: qk.sessions })
      setConfirmAll(false)
    } catch (e) {
      toast.error('Signing out everywhere else failed', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setAllBusy(false)
    }
  }

  return (
    <SettingsSection
      id="sessions"
      title="Sessions"
      icon={MonitorSmartphone}
      meta={data ? `${int(data.length)} signed in` : undefined}
      description="Every browser signed in to the console. A session ends after 12 hours without use, or 30 days with “Remember this device”, and after 30 days at most either way."
      actions={
        others.length ? (
          <Button size="xs" variant="danger-outline" onClick={() => setConfirmAll(true)}>
            Sign out everywhere else
          </Button>
        ) : null
      }
    >
      <div className="-m-4 sm:-m-5">
        {isPending ? (
          <div className="grid gap-3 p-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : isError ? (
          <Empty title="The sessions did not load" action={<Button onClick={() => refetch()}>Try again</Button>}>
            {(error as Error).message}
          </Empty>
        ) : (
          <>
            <div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_6.5rem] gap-x-4 border-b border-line px-5 py-2 text-[11px] font-medium uppercase tracking-wider text-faint sm:grid">
              <span>Device and address</span>
              <span>Last active</span>
              <span>Signed in</span>
              <span />
            </div>
            <ul className="divide-y divide-line">
              {[...(data ?? [])]
                .sort((a, b) => Number(b.current) - Number(a.current) || b.last_seen_at - a.last_seen_at)
                .slice(0, showAll ? undefined : SHOWN)
                .map((s) => (
                  <SessionItem key={s.id} s={s} now={now} onEnd={endOne} busy={ending === s.id} />
                ))}
            </ul>
            {(data?.length ?? 0) > SHOWN ? (
              <div className="border-t border-line p-2 text-center">
                <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                  {showAll ? 'Show fewer' : `Show all ${int(data!.length)}`}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Sign out everywhere else?</DialogTitle>
            <DialogDescription>
              {int(others.length)} other session{others.length === 1 ? '' : 's'} will be signed out at once, and their live views
              close. This browser stays signed in.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmAll(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={endOthers} loading={allBusy}>
              Sign them out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  )
}
