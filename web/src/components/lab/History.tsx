import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Download, FileClock, History as HistoryIcon, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { CASES, checksOf, isContended, isImported, runDuration, speedOf, type LabRun } from '@/lib/bench'
import { dateTime, dur, fixed, when } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tip } from '@/components/ui/menu'
import { Badge, CopyButton, Empty, KV, Panel, PanelHeader, Skeleton } from '@/components/ui/misc'

export function StatusBadge({ status }: { status: string }) {
  if (status === 'running')
    return (
      <Badge tone="neutral">
        <Loader2 className="animate-spin" aria-hidden /> running
      </Badge>
    )
  if (status === 'ok') return <Badge tone="ok">ok</Badge>
  if (status === 'failed') return <Badge tone="error">failed</Badge>
  return <Badge>{status}</Badge>
}

function Flags({ r }: { r: LabRun }) {
  return (
    <span className="flex flex-wrap gap-1">
      {isContended(r) ? (
        <Tip content="Another process used the GPU during this run; its speeds may be low">
          <Badge tone="warn">
            <AlertTriangle aria-hidden /> GPU shared
          </Badge>
        </Tip>
      ) : null}
      {isImported(r) ? (
        <Tip content={r.source ? `Imported from ${r.source}` : 'Imported from bench/results'}>
          <Badge>
            <Download aria-hidden /> imported
          </Badge>
        </Tip>
      ) : null}
    </span>
  )
}

function PickButton({ which, on, onClick, label }: { which: 'A' | 'B'; on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      aria-pressed={on}
      aria-label={`${label} as ${which}`}
      className={cn(
        'num inline-flex size-6 items-center justify-center rounded-md border text-[11px] font-semibold transition-colors',
        on ? 'border-fg bg-fg text-bg' : 'border-line-strong text-faint hover:border-faint hover:text-fg',
      )}
    >
      {which}
    </button>
  )
}

export function History({
  runs,
  loading,
  aId,
  bId,
  setA,
  setB,
  onOpen,
  onImport,
  importing,
  now,
}: {
  runs: LabRun[]
  loading: boolean
  aId: LabRun['id'] | null
  bId: LabRun['id'] | null
  setA: (id: LabRun['id']) => void
  setB: (id: LabRun['id']) => void
  onOpen: (r: LabRun) => void
  onImport: () => void
  importing: boolean
  now: number
}) {
  return (
    <Panel aria-labelledby="hist-title">
      <PanelHeader
        id="hist-title"
        title="History"
        icon={<HistoryIcon />}
        meta={runs.length ? `${runs.length} run${runs.length === 1 ? '' : 's'} · answer speed per case, tok/s` : undefined}
        actions={
          <Tip content="Read bench/results/*.json from the repository again (runs made from the command line)">
            <Button size="xs" variant="ghost" onClick={onImport} loading={importing}>
              <Download aria-hidden /> Import results
            </Button>
          </Tip>
        }
      />
      {loading ? (
        <div className="grid gap-2 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : !runs.length ? (
        <Empty icon={<FileClock />} title="No runs yet">
          Every run started here is kept, and the results in bench/results are imported, so you can compare any two.
        </Empty>
      ) : (
        <>
          {/* phones: cards */}
          <ul className="grid gap-2 p-3 md:hidden">
            {runs.map((r) => {
              const s = speedOf(r)
              const checks = checksOf(r)
              return (
                <li key={r.id} className="rounded-lg border border-line bg-panel-2/50 text-[13px]">
                  <button
                    type="button"
                    onClick={() => onOpen(r)}
                    className="grid w-full gap-2 rounded-t-lg px-3 pb-2 pt-3 text-left transition-colors hover:bg-panel-2"
                  >
                    <span className="flex items-center gap-2">
                      <span className="num text-faint">#{r.id}</span>
                      <span className="font-medium">{r.kind === 'import' ? 'imported' : r.kind}</span>
                      {r.preset ? <span className="num text-muted">{r.preset}</span> : null}
                      <span className="ml-auto">
                        <StatusBadge status={r.status} />
                      </span>
                    </span>
                    <span className="num flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                      {CASES.filter((c) => s[c]?.decode !== undefined).map((c) => (
                        <span key={c}>
                          {c} <span className="text-fg">{fixed(s[c]!.decode, 1)}</span>
                        </span>
                      ))}
                      {checks.map((c, i) => (
                        <span key={i} className={c.passed === c.total ? 'text-ok' : 'text-warn'}>
                          {c.cmd} {c.passed}/{c.total}
                        </span>
                      ))}
                    </span>
                  </button>
                  <div className="flex items-center gap-2 px-3 pb-3 text-xs text-faint">
                    <span>{when(r.started_at, now)}</span>
                    <span className="num">· {dur(runDuration(r, now))}</span>
                    <Flags r={r} />
                    <span className="ml-auto flex gap-1.5">
                      <PickButton which="A" on={aId === r.id} onClick={() => setA(r.id)} label={`Run ${r.id}`} />
                      <PickButton which="B" on={bId === r.id} onClick={() => setB(r.id)} label={`Run ${r.id}`} />
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
          {/* wider screens: a table */}
          <div className="hidden overflow-x-auto scrollbar-thin md:block">
            <table className="w-full text-[13px]">
              <caption className="sr-only">Benchmark runs, newest first</caption>
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                  <th scope="col" className="py-2 pl-4 pr-2 font-semibold">
                    <span className="sr-only">Compare</span>
                  </th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Run</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Preset</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Status</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Started</th>
                  <th scope="col" className="py-2 pr-3 text-right font-semibold">Took</th>
                  {CASES.map((c) => (
                    <th key={c} scope="col" className="num py-2 pr-3 text-right font-semibold normal-case tracking-normal">
                      {c}
                    </th>
                  ))}
                  <th scope="col" className="py-2 pr-4 font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const s = speedOf(r)
                  const checks = checksOf(r)
                  return (
                    <tr
                      key={r.id}
                      onClick={() => onOpen(r)}
                      className={cn(
                        'cursor-pointer border-b border-line/60 transition-colors last:border-0 hover:bg-panel-2/60',
                      )}
                    >
                      <td className="py-2 pl-4 pr-2">
                        <span className="flex gap-1">
                          <PickButton which="A" on={aId === r.id} onClick={() => setA(r.id)} label={`Run ${r.id}`} />
                          <PickButton which="B" on={bId === r.id} onClick={() => setB(r.id)} label={`Run ${r.id}`} />
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          className="text-left hover:underline"
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpen(r)
                          }}
                        >
                          <span className="num text-faint">#{r.id}</span>{' '}
                          <span className="font-medium">{r.kind === 'import' ? 'imported' : r.kind}</span>
                        </button>
                      </td>
                      <td className="num py-2 pr-3 text-muted">{r.preset ?? '—'}</td>
                      <td className="py-2 pr-3">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="py-2 pr-3 text-muted">{when(r.started_at, now)}</td>
                      <td className="num py-2 pr-3 text-right text-muted">{dur(runDuration(r, now))}</td>
                      {CASES.map((c) => (
                        <td key={c} className="num py-2 pr-3 text-right">
                          {s[c]?.decode !== undefined ? fixed(s[c]!.decode, 1) : <span className="text-faint">—</span>}
                        </td>
                      ))}
                      <td className="py-2 pr-4">
                        <span className="flex flex-wrap items-center gap-1">
                          {checks.map((c, i) => (
                            <Badge key={i} tone={c.passed === c.total ? 'ok' : 'warn'} className="num">
                              {c.cmd} {c.passed}/{c.total}
                            </Badge>
                          ))}
                          <Flags r={r} />
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  )
}

/** One run in full: settings, per-case numbers with each repeat, checks, and the log. */
export function RunDetail({ run, onClose, now }: { run: LabRun | null; onClose: () => void; now: number }) {
  const q = useQuery({
    queryKey: ['bench-run', run?.id],
    queryFn: () => api.get<LabRun>(`/api/bench/runs/${encodeURIComponent(String(run!.id))}`),
    enabled: !!run,
    refetchInterval: run?.status === 'running' ? 3000 : false,
  })
  const r = q.data ?? run
  const s = r ? speedOf(r) : {}
  const checks = r ? checksOf(r) : []
  return (
    <Dialog open={!!run} onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        {r ? (
          <>
            <DialogHeader>
              <DialogTitle>
                Run <span className="num">#{r.id}</span>: {r.kind === 'import' ? 'imported results' : r.kind}
              </DialogTitle>
              <DialogDescription>
                {r.preset ? (
                  <>
                    On <span className="num text-fg">{r.preset}</span>,{' '}
                  </>
                ) : null}
                started {dateTime(r.started_at)}
                {r.args?.by ? ` by ${r.args.by}` : ''}.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-1.5">
              <StatusBadge status={r.status} />
              <Flags r={r} />
            </div>
            <KV
              rows={[
                ['Took', <span className="num">{dur(runDuration(r, now), { precise: true })}</span>],
                ...(r.args?.cases ? ([['Cases', <span className="num">{String(r.args.cases).split(',').join(', ')}</span>]] as Array<[string, React.ReactNode]>) : []),
                ...(r.args?.repeat ? ([['Repeats', <span className="num">{String(r.args.repeat)}</span>]] as Array<[string, React.ReactNode]>) : []),
                ...(r.source ? ([['From', <code className="text-xs">{r.source}</code>]] as Array<[string, React.ReactNode]>) : []),
              ]}
            />
            {Object.keys(s).length ? (
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full min-w-[480px] text-[13px]">
                  <caption className="sr-only">Speeds per case</caption>
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                      <th scope="col" className="py-2 pr-3 font-semibold">Case</th>
                      <th scope="col" className="py-2 pr-3 text-right font-semibold">Answer tok/s</th>
                      <th scope="col" className="py-2 pr-3 text-right font-semibold">Prompt tok/s</th>
                      <th scope="col" className="py-2 pr-3 text-right font-semibold">First token</th>
                      <th scope="col" className="py-2 font-semibold">Each repeat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CASES.filter((c) => s[c]).map((c) => (
                      <tr key={c} className="border-b border-line/60 last:border-0">
                        <th scope="row" className="num py-1.5 pr-3 text-left font-normal">
                          {c}
                        </th>
                        <td className="num py-1.5 pr-3 text-right">{fixed(s[c]!.decode, 1)}</td>
                        <td className="num py-1.5 pr-3 text-right">{fixed(s[c]!.prompt, 1)}</td>
                        <td className="num py-1.5 pr-3 text-right">{s[c]!.ttft !== undefined ? `${fixed(s[c]!.ttft, 2)} s` : '—'}</td>
                        <td className="num py-1.5 text-muted">{s[c]!.runs?.map((x) => fixed(x, 1)).join(' · ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {checks.length ? (
              <div className="flex flex-wrap gap-1.5">
                {checks.map((c, i) => (
                  <Badge key={i} tone={c.passed === c.total ? 'ok' : 'warn'} className="num">
                    {c.cmd}: {c.passed} of {c.total} passed
                  </Badge>
                ))}
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <span className="eyebrow">Log</span>
                {q.data?.log ? <CopyButton value={q.data.log} label="Copy the log" /> : null}
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-sunken/70 p-3 font-mono text-[12px] leading-relaxed text-fg/90 scrollbar-thin">
                {q.isLoading ? 'Loading…' : q.data?.log || (r.status === 'running' ? 'The log is kept when the run ends.' : 'No log was kept for this run.')}
              </pre>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
