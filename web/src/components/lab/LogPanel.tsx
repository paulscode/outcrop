import { ArrowDown, CircleCheck, CircleX, Loader2, SquareTerminal } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { checksOf, speedOf, CASES } from '@/lib/bench'
import { clock, dur, fixed } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Badge, CopyButton, Panel, PanelHeader } from '@/components/ui/misc'

export interface Watched {
  id: number | string
  kind: string
  preset: string | null
  startedAt: number
  status: 'running' | 'ok' | 'failed' | 'cancelled'
  endedAt: number | null
  lines: string[]
  result: Record<string, unknown> | null
  /** lines printed before this page saw the run are missing (the backend keeps the log only at the end) */
  joinedLate: boolean
}

function lineClass(l: string): string {
  if (l.startsWith('$ ')) return 'text-faint'
  if (/traceback|error|exception|\bfail(ed|ure)?\b|\bFAIL\b/i.test(l)) return 'text-error'
  const m = l.match(/(\d+) of (\d+) passed/)
  if (m) return m[1] === m[2] ? 'text-ok' : 'text-warn'
  if (/\bwarn(ing)?\b/i.test(l)) return 'text-warn'
  return 'text-fg/90'
}

export function LogPanel({ w, now, previous = false }: { w: Watched | null; now: number; previous?: boolean }) {
  const box = useRef<HTMLPreElement>(null)
  const [follow, setFollow] = useState(true)
  const lines = w?.lines ?? []

  useLayoutEffect(() => {
    const el = box.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [lines.length, follow])

  useEffect(() => setFollow(true), [w?.id])

  const onScroll = () => {
    const el = box.current
    if (!el) return
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atEnd !== follow) setFollow(atEnd)
  }

  const running = w?.status === 'running'
  const took = w ? (w.endedAt ?? now) - w.startedAt : null
  const speed = w?.result ? speedOf({ result: w.result }) : {}
  const checks = w?.result ? checksOf({ result: w.result }) : []

  return (
    <Panel aria-labelledby="log-title" className="flex min-h-[420px] flex-col">
      <PanelHeader
        id="log-title"
        title="Log"
        icon={<SquareTerminal />}
        meta={w ? `${previous ? 'the last run: ' : ''}#${w.id} ${w.kind}${w.preset ? ` on ${w.preset}` : ''}` : undefined}
        actions={lines.length ? <CopyButton value={lines.join('\n')} label="Copy the log" /> : null}
      />
      <div className="relative min-h-0 flex-1">
        <pre
          ref={box}
          onScroll={onScroll}
          tabIndex={0}
          aria-label="Benchmark output"
          aria-live="off"
          className="absolute inset-0 overflow-auto whitespace-pre-wrap break-words bg-sunken/70 px-4 py-3 font-mono text-[12px] leading-[1.65] scrollbar-thin"
        >
          {w?.joinedLate ? (
            <span className="block text-faint"># earlier lines of this run appear when it ends; new ones appear as they come{'\n'}</span>
          ) : null}
          {lines.length ? (
            lines.map((l, i) => (
              <span key={i} className={cn('block', lineClass(l))}>
                {l || ' '}
              </span>
            ))
          ) : (
            <span className="text-faint">
              {w ? (running ? 'Starting…' : 'This run printed nothing.') : 'Start a run to see its output here, line by line.'}
            </span>
          )}
          {running ? <span className="inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-faint" aria-hidden /> : null}
        </pre>
        {!follow && lines.length ? (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="absolute bottom-3 right-4 inline-flex items-center gap-1 rounded-full border border-line-strong bg-panel-3 px-2.5 py-1 text-xs text-fg shadow-lg"
          >
            <ArrowDown className="size-3" aria-hidden /> Follow the output
          </button>
        ) : null}
      </div>
      <footer className="flex min-h-11 flex-wrap items-center gap-2 border-t border-line px-4 py-2 text-[13px]" role="status" aria-live="polite">
        {w ? (
          <>
            {running ? (
              <Loader2 className="size-4 animate-spin text-faint" aria-hidden />
            ) : w.status === 'ok' ? (
              <CircleCheck className="size-4 text-ok" aria-hidden />
            ) : (
              <CircleX className={cn('size-4', w.status === 'failed' ? 'text-error' : 'text-faint')} aria-hidden />
            )}
            <span className={cn(w.status === 'failed' && 'text-error')}>
              {running
                ? 'Running'
                : w.status === 'ok'
                  ? 'Finished'
                  : w.status === 'failed'
                    ? 'Failed'
                    : 'Cancelled'}
            </span>
            <span className="num text-muted">{running ? clock(took) : `after ${dur(took, { precise: true })}`}</span>
            {!running
              ? CASES.filter((c) => speed[c]?.decode !== undefined).map((c) => (
                  <Badge key={c} className="num">
                    {c} {fixed(speed[c]!.decode, 1)} tok/s
                  </Badge>
                ))
              : null}
            {!running
              ? checks.map((c, i) => (
                  <Badge key={i} tone={c.passed === c.total ? 'ok' : 'warn'} className="num">
                    {c.cmd} {c.passed}/{c.total}
                  </Badge>
                ))
              : null}
          </>
        ) : (
          <span className="text-faint">Nothing running.</span>
        )}
      </footer>
    </Panel>
  )
}
