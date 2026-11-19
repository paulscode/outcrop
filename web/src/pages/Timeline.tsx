import { useInfiniteQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowDown,
  Bell,
  ChevronRight,
  FlaskConical,
  History,
  KeyRound,
  Layers,
  Loader2,
  LogIn,
  Network,
  RefreshCw,
  Settings2,
  ShieldCheck,
  ShieldOff,
  Sparkle,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge, Empty, LiveRegion, Panel, Skeleton } from '@/components/ui/misc'
import { Tip } from '@/components/ui/menu'
import { api } from '@/lib/api'
import {
  actorWords,
  detailRows,
  eventLinks,
  eventTone,
  familyById,
  familyOf,
  FAMILIES,
  groupByDay,
  hasDetails,
  mergeEvents,
  type EventTone,
  type FamilyId,
} from '@/lib/events'
import { ago, dateTime, int, time } from '@/lib/format'
import { alertsStore, eventsTick, switchStore } from '@/lib/live'
import { useStore } from '@/lib/store'
import type { EventRow } from '@/lib/types'
import { cn, useNow } from '@/lib/utils'

const PAGE = 100

const FAMILY_ICON: Record<FamilyId, LucideIcon> = {
  presets: Layers,
  access: ShieldOff,
  tokens: KeyRound,
  signins: LogIn,
  alerts: Bell,
  bench: FlaskConical,
  console: Settings2,
  gateway: Network,
  other: Sparkle,
}

function iconFor(e: EventRow): LucideIcon {
  if (e.kind === 'auth.close') return ShieldCheck
  if (e.kind === 'signin.fail' || e.level === 'error') return AlertTriangle
  return FAMILY_ICON[familyOf(e.kind)]
}

const toneRing: Record<EventTone, string> = {
  ok: 'border-ok/40 bg-ok-bg text-ok',
  warn: 'border-warn/40 bg-warn-bg text-warn',
  error: 'border-error/40 bg-error-bg text-error',
  info: 'border-info/30 bg-panel-2 text-info',
  neutral: 'border-line-strong bg-panel-2 text-muted',
}

const toneWord: Record<EventTone, string> = {
  ok: 'resolved',
  warn: 'warning',
  error: 'error',
  info: 'notice',
  neutral: '',
}

function Details({ data }: { data: Record<string, unknown> }) {
  const rows = useMemo(() => detailRows(data, (ts) => dateTime(ts)), [data])
  const text = useMemo(() => (rows ? '' : JSON.stringify(data, null, 2)), [data, rows])
  if (rows)
    return (
      <dl className="mt-2 grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg border border-line bg-sunken px-3 py-2.5 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-faint">{k}</dt>
            <dd className="num min-w-0 break-words text-fg/90">{v}</dd>
          </div>
        ))}
      </dl>
    )
  return (
    <pre className="num mt-2 max-h-80 overflow-auto rounded-lg border border-line bg-sunken p-3 text-[12px] leading-relaxed text-muted scrollbar-thin">
      {text}
    </pre>
  )
}

function EventItem({ e, now }: { e: EventRow; now: number }) {
  const [open, setOpen] = useState(false)
  const tone = eventTone(e)
  const Icon = iconFor(e)
  const links = eventLinks(e)
  const details = hasDetails(e)
  const detailsId = `ev-${e.id}-details`
  return (
    <li className="relative grid grid-cols-[2.25rem_1fr] gap-3 py-2.5 pl-1 pr-2 sm:pr-3" data-testid="timeline-event">
      <div className="relative flex justify-center">
        <span
          className={cn('relative z-[1] mt-0.5 flex size-7 items-center justify-center rounded-full border', toneRing[tone])}
          aria-hidden
        >
          <Icon className="size-3.5" />
        </span>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="min-w-0 text-[13px] leading-snug text-fg">
            {toneWord[tone] ? <span className="sr-only">{toneWord[tone]}: </span> : null}
            {e.summary}
          </p>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-faint">
          <Tip content={`${new Date(e.at * 1000).toLocaleString()} · ${ago(e.at, now)}`}>
            <time className="num" dateTime={new Date(e.at * 1000).toISOString()}>
              {time(e.at)}
            </time>
          </Tip>
          <span aria-hidden>·</span>
          <span className="truncate">{actorWords(e.actor, e.source)}</span>
          <Tip content="The event's kind, as the audit log stores it">
            <span className="num rounded border border-line px-1 py-px text-[10.5px] text-faint">{e.kind}</span>
          </Tip>
          {tone === 'warn' || tone === 'error' ? (
            <Badge tone={tone} className="h-[18px]">
              {tone === 'warn' ? 'warning' : 'error'}
            </Badge>
          ) : null}
          {links.map((l) => (
            <Link key={l.label} to={l.to} search={l.search as never} hash={l.hash} className="link text-xs text-muted">
              {l.label}
            </Link>
          ))}
          {details ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls={detailsId}
              className="inline-flex items-center gap-0.5 rounded px-1 text-xs text-muted hover:bg-panel-2 hover:text-fg"
            >
              <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} aria-hidden />
              Details
            </button>
          ) : null}
        </div>
        {details && open ? (
          <div id={detailsId}>
            <Details data={e.details} />
          </div>
        ) : null}
      </div>
    </li>
  )
}

function FilterChips({ value, onChange, counts }: { value: string; onChange: (v: string) => void; counts: Partial<Record<FamilyId, number>> }) {
  const items: Array<{ id: string; label: string }> = [{ id: '', label: 'Everything' }, ...FAMILIES.map((f) => ({ id: f.id, label: f.label }))]
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 scrollbar-thin" role="group" aria-label="Show events of one kind">
      {items.map((it) => {
        const active = value === it.id
        const Icon = it.id ? FAMILY_ICON[it.id as FamilyId] : History
        const n = it.id ? counts[it.id as FamilyId] : undefined
        return (
          <button
            key={it.id || 'all'}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(it.id)}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
              active ? 'border-fg bg-fg text-bg' : 'border-line-strong bg-panel-2 text-muted hover:bg-panel-3 hover:text-fg',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {it.label}
            {n ? <span className={cn('num text-[10.5px]', active ? 'text-bg/70' : 'text-faint')}>{int(n)}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

export default function Timeline() {
  const search = useSearch({ strict: false }) as { kind?: string }
  const navigate = useNavigate()
  const famId = familyById(search.kind)?.id ?? ''
  // a raw kind filter from a link (`?kind=token.revoke` or `token.*,auth.*`) works too
  const raw = !famId && search.kind && /^[a-z0-9_.*,]+$/i.test(search.kind) ? search.kind : ''
  const filter = familyById(famId)?.filter ?? raw
  const now = useNow(30_000)
  const [manual, setManual] = useState(false)

  const q = useInfiniteQuery({
    queryKey: ['events-feed', filter],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api.get<EventRow[]>(
        `/api/events?limit=${PAGE}${pageParam ? `&before=${pageParam}` : ''}${filter ? `&kind=${encodeURIComponent(filter)}` : ''}`,
      ),
    getNextPageParam: (last) => (last.length >= PAGE ? last[last.length - 1].at : undefined),
    refetchInterval: 10_000,
  })

  // Something happened (a gateway event, an alert, a switch step): refresh now rather than at the next poll.
  const tick = useStore(eventsTick)
  const alerts = useStore(alertsStore)
  const sw = useStore(switchStore, (s) => (s ? `${s.id}:${s.status}` : ''))
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const id = setTimeout(() => void q.refetch(), 400)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, alerts, sw])

  const events = useMemo(() => mergeEvents(q.data?.pages ?? []), [q.data])
  const groups = useMemo(() => groupByDay(events, now), [events, now])
  const counts = useMemo(() => {
    const c: Partial<Record<FamilyId, number>> = {}
    if (!famId && !raw) for (const e of events) c[familyOf(e.kind)] = (c[familyOf(e.kind)] ?? 0) + 1
    return c
  }, [events, famId, raw])

  const newest = events[0]
  const [announce, setAnnounce] = useState('')
  const lastTop = useRef<number | null>(null)
  useEffect(() => {
    if (!newest) return
    if (lastTop.current !== null && newest.id !== lastTop.current) setAnnounce(`New event: ${newest.summary}`)
    lastTop.current = newest.id
  }, [newest])

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <LiveRegion message={announce} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
          Everything that happened on the server: switches, sign-ins, token changes, open windows, alerts and bench runs. It is
          also the audit log: each entry says who did it and from where.
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="self-start sm:self-auto"
          onClick={() => {
            setManual(true)
            void q.refetch().finally(() => setManual(false))
          }}
          aria-label="Refresh the timeline"
        >
          <RefreshCw className={cn(manual && 'animate-spin')} /> Refresh
        </Button>
      </div>
      <FilterChips
        value={raw ? '\u0000' : famId}
        counts={counts}
        onChange={(v) => navigate({ to: '/timeline', search: v ? { kind: v } : {}, replace: true })}
      />
      {raw ? (
        <p className="flex items-center gap-2 text-xs text-muted">
          Showing only <code className="num rounded border border-line bg-panel-2 px-1.5 py-0.5 text-fg">{raw}</code>
          <button type="button" className="link" onClick={() => navigate({ to: '/timeline', search: {}, replace: true })}>
            Show everything
          </button>
        </p>
      ) : null}
      <Panel>
        {q.isPending ? (
          <div className="grid gap-4 p-5" aria-busy="true" aria-label="Loading the timeline">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-7 rounded-full" />
                <div className="grid flex-1 gap-2">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : q.isError ? (
          <Empty icon={<AlertTriangle />} title="The timeline did not load" action={<Button onClick={() => q.refetch()}>Try again</Button>}>
            {(q.error as Error).message}
          </Empty>
        ) : !events.length ? (
          <Empty icon={<History />} title={famId ? `No ${familyById(famId)?.label.toLowerCase()} events yet` : raw ? `No ${raw} events yet` : 'Nothing has happened yet'}>
            Events appear here as they happen: a preset switch, a new token, a sign-in, an alert.
          </Empty>
        ) : (
          <ol aria-label="Events, newest first">
            {groups.map((g, gi) => (
              <li key={g.key} className="relative">
                <h2
                  className={cn(
                    'sticky top-14 z-[2] flex items-center gap-2 border-b border-line bg-panel/95 px-4 py-2 text-xs font-semibold text-fg backdrop-blur-sm',
                    gi === 0 && 'rounded-t-xl',
                    gi > 0 && 'border-t',
                  )}
                >
                  {g.label}
                  <span className="num font-normal text-faint">{int(g.events.length)}</span>
                </h2>
                <div className="relative px-2 sm:px-3">
                  <div className="absolute bottom-4 left-[29.5px] top-4 w-px bg-line-strong sm:left-[33.5px]" aria-hidden />
                  <ul>
                    {g.events.map((e) => (
                      <EventItem key={e.id} e={e} now={now} />
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        )}
        {q.hasNextPage ? (
          <div className="flex justify-center border-t border-line p-3">
            <Button variant="ghost" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? <Loader2 className="animate-spin" /> : <ArrowDown />} Load older events
            </Button>
          </div>
        ) : events.length ? (
          <p className="border-t border-line px-4 py-3 text-center text-xs text-faint">
            That is everything{famId || raw ? ` of this kind` : ''}: {int(events.length)} events
          </p>
        ) : null}
      </Panel>
    </div>
  )
}
