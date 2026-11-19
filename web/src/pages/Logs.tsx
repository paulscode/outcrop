import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useSearch } from '@tanstack/react-router'
import { ArrowDownToLine, Pause, Play, ScrollText, Search, TerminalSquare, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Segmented, Switch } from '@/components/ui/controls'
import { Input, Label } from '@/components/ui/input'
import { Tip } from '@/components/ui/menu'
import { CopyButton, Empty, LiveRegion, Panel, Skeleton } from '@/components/ui/misc'
import { getOptional } from '@/lib/api'
import { int, time } from '@/lib/format'
import { useLiveTopic, useConnStatus } from '@/lib/live'
import {
  appendLines,
  isSource,
  LOG_SOURCES,
  MAX_LINES,
  passesLevel,
  passesQuery,
  segments,
  toEntries,
  type Level,
  type LevelFilter,
  type LogEntry,
  type LogSource,
  type RawLine,
} from '@/lib/logs'
import { cn, useDebounced } from '@/lib/utils'

const levelText: Record<Level, string> = { info: 'info', warn: 'warn', error: 'error' }
const levelClass: Record<Level, string> = { info: 'text-faint', warn: 'text-warn', error: 'text-error' }

function Line({ l, q }: { l: LogEntry; q: string }) {
  const segs = useMemo(() => segments(l.msg, q), [l.msg, q])
  return (
    <div
      className={cn(
        'px-3 py-0.5 hover:bg-panel-2/70 sm:grid sm:grid-cols-[5rem_3rem_1fr] sm:gap-x-2 sm:py-[1px]',
        l.level === 'error' && 'bg-error-bg/60',
        l.level === 'warn' && 'bg-warn-bg/40',
      )}
    >
      <span className="mr-2 select-none text-faint sm:mr-0">{l.t != null ? time(l.t) : ''}</span>
      <span className={cn('select-none', levelClass[l.level])}>{levelText[l.level]}</span>
      <span className="block min-w-0 whitespace-pre-wrap break-words text-fg/90 [overflow-wrap:anywhere] sm:inline">
        {segs.map((s, i) =>
          s.kind === 'rid' ? (
            <Link key={i} to="/requests" search={{ rid: s.text }} className="text-info underline decoration-info/40 underline-offset-2 hover:decoration-info">
              {s.text}
            </Link>
          ) : s.kind === 'mark' ? (
            <mark key={i} className="rounded-[2px] bg-warn/30 px-px text-fg">
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </span>
    </div>
  )
}

export default function Logs() {
  const search = useSearch({ strict: false }) as { source?: string; q?: string }
  const source: LogSource = isSource(search.source) ? search.source : 'strata'
  const [q, setQ] = useState(search.q ?? '')
  const dq = useDebounced(q.trim(), 400)
  const [level, setLevel] = useState<LevelFilter>('all')
  const [paused, setPaused] = useState(false)
  const [follow, setFollow] = useState(true)
  const [lines, setLines] = useState<LogEntry[]>([])
  const [waiting, setWaiting] = useState(0)
  const [announce, setAnnounce] = useState('')
  const conn = useConnStatus()

  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const held = useRef<LogEntry[]>([])
  const incoming = useRef<LogEntry[]>([])
  const box = useRef<HTMLDivElement>(null)

  const query = useQuery({
    queryKey: ['logs', source, dq],
    queryFn: () =>
      getOptional<{ source: string; lines: RawLine[] }>(
        `/api/logs?source=${encodeURIComponent(source)}&lines=300${dq ? `&q=${encodeURIComponent(dq)}` : ''}`,
      ),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    // a new search keeps the lines on screen (filtered here) until the server's answer arrives
    placeholderData: keepPreviousData,
  })
  const unavailable = query.data === null
  // the placeholder is another source's log: show the loading state rather than the wrong lines
  const switching = query.isPlaceholderData && !!query.data && query.data.source !== source

  // A new source or search: start from what the server has, then follow.
  useEffect(() => {
    if (!query.data || query.isPlaceholderData) return
    setLines(toEntries(query.data.lines ?? []))
    held.current = []
    incoming.current = []
    setWaiting(0)
    setFollow(true)
  }, [query.data, query.isPlaceholderData])

  // Live lines arrive on the `logs` topic for every source; batch them so a busy log does not re-render per line.
  useLiveTopic('logs', (m) => {
    if (m.snapshot) return
    const d = m.d as Partial<RawLine>
    if (!d || typeof d.msg !== 'string') return
    if (d.source && d.source !== source) return
    incoming.current.push(...toEntries([{ t: typeof d.t === 'number' ? d.t : null, msg: d.msg, level: d.level }]))
  })
  useEffect(() => {
    const id = setInterval(() => {
      if (!incoming.current.length) return
      const batch = incoming.current
      incoming.current = []
      if (pausedRef.current) {
        held.current = held.current.concat(batch).slice(-MAX_LINES)
        setWaiting(held.current.length)
      } else {
        setLines((l) => appendLines(l, batch))
      }
    }, 250)
    return () => clearInterval(id)
  }, [])

  const togglePause = useCallback(() => {
    if (pausedRef.current) {
      const add = held.current
      held.current = []
      setWaiting(0)
      setLines((l) => appendLines(l, add))
      setPaused(false)
      setAnnounce('Resumed: new lines appear again')
    } else {
      setPaused(true)
      setAnnounce('Paused: new lines wait until you resume')
    }
  }, [])

  const shown = useMemo(() => lines.filter((l) => passesLevel(l, level) && passesQuery(l, q)), [lines, level, q])

  // Follow the tail: stay at the bottom while following; scrolling up stops following.
  useLayoutEffect(() => {
    const el = box.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [shown, follow])
  const onScroll = () => {
    const el = box.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
    if (atBottom !== follow) setFollow(atBottom)
  }

  const src = LOG_SOURCES.find((s) => s.id === source)!
  const copyAll = useMemo(
    () => shown.map((l) => `${l.t != null ? `${time(l.t)} ` : ''}${l.level.toUpperCase().padEnd(5)} ${l.msg}`).join('\n'),
    [shown],
  )

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <LiveRegion message={announce} />
      <nav aria-label="Which log" className="min-w-0">
        <ul className="flex max-w-full items-center gap-1 overflow-x-auto border-b border-line text-[13px] scrollbar-thin">
          {LOG_SOURCES.map((s) => {
            const on = s.id === source
            return (
              <li key={s.id} className="shrink-0">
                <Tip content={s.help}>
                  <Link
                    to="/logs"
                    search={{ source: s.id, ...(q ? { q } : {}) }}
                    replace
                    aria-current={on ? 'page' : undefined}
                    className={cn(
                      '-mb-px inline-flex items-center border-b-2 px-3 py-2 font-medium transition-colors',
                      on ? 'border-fg text-fg' : 'border-transparent text-faint hover:text-fg',
                    )}
                  >
                    {s.label}
                  </Link>
                </Tip>
              </li>
            )
          })}
        </ul>
      </nav>

      <Panel>
        <fieldset disabled={unavailable} className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 border-b border-solid border-line p-3 disabled:opacity-60">
          <legend className="sr-only">Filter and follow the log</legend>
          <div className="relative min-w-[12rem] flex-1">
            <Label htmlFor="log-search" className="sr-only">
              Search the log
            </Label>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
            <Input
              id="log-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search: a request id, an error, a word…"
              className="h-8 pl-8 pr-8"
              spellCheck={false}
            />
            {q ? (
              <button
                type="button"
                onClick={() => setQ('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-faint hover:text-fg"
                aria-label="Clear the search"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <Segmented
            label="Which levels"
            size="sm"
            value={level}
            onValueChange={setLevel}
            options={[
              { value: 'all', label: 'All' },
              { value: 'warn', label: 'Warnings' },
              { value: 'error', label: 'Errors' },
            ]}
          />
          <Button size="sm" variant={paused ? 'warn-outline' : 'secondary'} onClick={togglePause} aria-pressed={paused} data-testid="logs-pause">
            {paused ? <Play /> : <Pause />}
            {paused ? (waiting ? `Resume · ${int(waiting)} new` : 'Resume') : 'Pause'}
          </Button>
          <label className="inline-flex h-8 items-center gap-2 rounded-md px-1.5 text-xs text-muted">
            <Switch checked={follow} onCheckedChange={setFollow} aria-label="Follow the newest lines" />
            Follow
          </label>
          <div className="ml-auto flex items-center gap-1.5">
            <CopyButton value={copyAll} label="Copy the lines shown" />
            <Tip content="Clear the view (the log itself is not changed)">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Clear the view"
                onClick={() => {
                  setLines([])
                  held.current = []
                  setWaiting(0)
                }}
              >
                <Trash2 />
              </Button>
            </Tip>
          </div>
        </fieldset>

        <div className="relative">
          {unavailable ? (
            <Empty icon={<ScrollText />} title="Logs are not available from this console yet" className="min-h-[360px]">
              <p>
                This backend has no log endpoint (<code className="text-xs">GET /api/logs</code>). Over SSH,{' '}
                <code className="whitespace-nowrap rounded bg-panel-2 px-1 text-xs">outcrop logs</code> shows the same journals.
              </p>
            </Empty>
          ) : query.isError ? (
            <Empty icon={<TerminalSquare />} title="The log did not load" className="min-h-[360px]" action={<Button onClick={() => query.refetch()}>Try again</Button>}>
              {(query.error as Error).message}
            </Empty>
          ) : (
            <div
              ref={box}
              onScroll={onScroll}
              role="log"
              aria-live="off"
              aria-label={`${src.label} log`}
              tabIndex={0}
              data-testid="log-view"
              className="num h-[62dvh] min-h-[360px] overflow-y-auto sm:h-[calc(100dvh-19rem)] rounded-b-xl bg-sunken py-2 text-[12px] leading-[1.6] scrollbar-thin focus-visible:outline-offset-[-2px]"
            >
              {query.isPending || switching ? (
                <div className="grid gap-2 px-3 py-1" aria-busy="true" aria-label="Loading the log">
                  {Array.from({ length: 14 }, (_, i) => (
                    <Skeleton key={i} className="h-3" />
                  ))}
                </div>
              ) : shown.length ? (
                shown.map((l) => <Line key={l.id} l={l} q={q} />)
              ) : (
                <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-1 px-6 text-center font-sans text-[13px] text-muted">
                  <ScrollText className="mb-1 size-5 text-faint" aria-hidden />
                  {lines.length ? 'No line matches these filters.' : `Nothing in the ${src.label.toLowerCase()} log yet.`}
                  {!lines.length ? <span className="text-xs text-faint">New lines appear here as they are written.</span> : null}
                </div>
              )}
            </div>
          )}
          {!follow && !unavailable && shown.length ? (
            <Button
              size="xs"
              variant="secondary"
              className="absolute bottom-3 right-4 shadow-lg"
              onClick={() => {
                setFollow(true)
                const el = box.current
                if (el) el.scrollTop = el.scrollHeight
              }}
            >
              <ArrowDownToLine /> Newest
            </Button>
          ) : null}
        </div>
      </Panel>

      <p className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint', unavailable && 'hidden')} aria-live="polite">
        <span>
          <span className="num text-muted">{int(shown.length)}</span> of <span className="num">{int(lines.length)}</span> lines shown
          {lines.length >= MAX_LINES ? ` (the newest ${int(MAX_LINES)} are kept)` : ''}
        </span>
        <span aria-hidden>·</span>
        <span className={cn(paused ? 'text-warn' : conn === 'open' ? 'text-ok' : 'text-faint')}>
          {paused ? `paused${waiting ? `, ${int(waiting)} new lines waiting` : ''}` : conn === 'open' ? 'live' : 'reconnecting…'}
        </span>
        <span aria-hidden>·</span>
        <span>{src.help}</span>
      </p>
    </div>
  )
}
