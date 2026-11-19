import { useQuery } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { FlaskConical } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import { CASES, defaultPair, hasSpeed, speedLine, type CaseName, type LabRun } from '@/lib/bench'
import { useLiveTopic } from '@/lib/live'
import { qk, queryClient, useBenchRuns, useServerState } from '@/lib/queries'
import { useNow } from '@/lib/utils'
import { Empty, Panel } from '@/components/ui/misc'
import { Compare } from '@/components/lab/Compare'
import { History, RunDetail } from '@/components/lab/History'
import { LogPanel, type Watched } from '@/components/lab/LogPanel'
import { KINDS, RunPanel, type Kind } from '@/components/lab/RunPanel'

const MAX_LINES = 5000
const KEY = 'outcrop.lab'

function loadPrefs(): { cases?: CaseName[]; repeat?: number } {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}')
  } catch {
    return {}
  }
}

export default function Lab() {
  const search = useSearch({ strict: false }) as { run?: string }
  const now = useNow(1000)
  const { data: st } = useServerState()
  const runsQ = useBenchRuns()
  const runs = useMemo(() => ((runsQ.data ?? []) as unknown as LabRun[]).slice().sort((a, b) => b.started_at - a.started_at), [runsQ.data])

  const prefs = useRef(loadPrefs()).current
  const [kind, setKind] = useState<Kind>(() => (KINDS.some((k) => k.value === search.run) ? (search.run as Kind) : 'quickbench'))
  const [cases, setCases] = useState<CaseName[]>(() =>
    prefs.cases?.length ? CASES.filter((c) => prefs.cases!.includes(c)) : [...CASES],
  )
  const [repeat, setRepeat] = useState<number>(() => (prefs.repeat && prefs.repeat >= 1 && prefs.repeat <= 5 ? prefs.repeat : 3))
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ cases, repeat }))
    } catch {
      /* private mode */
    }
  }, [cases, repeat])
  useEffect(() => {
    if (search.run && KINDS.some((k) => k.value === search.run)) setKind(search.run as Kind)
  }, [search.run])

  const [watched, setWatched] = useState<Watched | null>(null)
  const watchedRef = useRef<Watched | null>(null)
  watchedRef.current = watched
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [importing, setImporting] = useState(false)
  const [open, setOpen] = useState<LabRun | null>(null)
  const [aId, setAId] = useState<LabRun['id'] | null>(null)
  const [bId, setBId] = useState<LabRun['id'] | null>(null)
  const picked = useRef(false)

  // The default pair: the newest run with speeds against the previous one on the same preset.
  useEffect(() => {
    if (picked.current || !runs.length) return
    const [a, b] = defaultPair(runs)
    if (a || b) {
      setAId(a?.id ?? null)
      setBId(b?.id ?? null)
      picked.current = true
    }
  }, [runs])

  // A run that just finished becomes B, against the run before it on the same preset (or just before it) as A.
  const pendingB = useRef<LabRun['id'] | null>(null)
  useEffect(() => {
    const id = pendingB.current
    if (id === null) return
    const b = runs.find((r) => String(r.id) === String(id))
    if (!b || b.status !== 'ok' || !hasSpeed(b)) return
    const before = runs
      .filter((r) => r.id !== b.id && r.status === 'ok' && hasSpeed(r) && r.started_at < b.started_at)
      .sort((x, y) => y.started_at - x.started_at)
    const a = before.find((r) => r.preset === b.preset) ?? before[0] ?? null
    setBId(b.id)
    setAId(a?.id ?? null)
    pendingB.current = null
    picked.current = true
  }, [runs])

  // The newest run started from a browser: its log fills the panel until another run starts.
  const lastRun = useMemo(() => runs.find((r) => r.kind !== 'import' && !r.source && r.status !== 'running') ?? null, [runs])
  const lastLog = useQuery({
    queryKey: ['bench-run', lastRun?.id, 'log'],
    queryFn: () => api.get<LabRun>(`/api/bench/runs/${encodeURIComponent(String(lastRun!.id))}`),
    enabled: !!lastRun && !watched,
    staleTime: Infinity,
  })

  // A run that is already going when the page opens (started in another browser): watch it.
  const running = runs.find((r) => r.status === 'running') ?? null
  useEffect(() => {
    if (running && (!watched || (watched.id !== running.id && watched.status !== 'running'))) {
      setWatched({
        id: running.id,
        kind: running.kind,
        preset: running.preset,
        startedAt: running.started_at,
        status: 'running',
        endedAt: null,
        lines: [],
        result: null,
        joinedLate: true,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running?.id])

  const finish = useCallback((id: LabRun['id'], status: Watched['status'], result: Record<string, unknown> | null) => {
    setWatched((w) => (w && String(w.id) === String(id) ? { ...w, status, result, endedAt: Date.now() / 1000 } : w))
    void queryClient.invalidateQueries({ queryKey: qk.bench })
    const w = watchedRef.current
    const what = w && String(w.id) === String(id) ? w.kind : 'The benchmark'
    const line = result ? speedLine({ result }) : ''
    if (status === 'ok') {
      toast.success(`${what} finished`, { description: line || undefined })
      // judge the new run against the one before it, as soon as the history has it
      if (line) pendingB.current = id
    } else if (status === 'failed') toast.error(`${what} failed`, { description: 'The log says why.' })
    else toast(`${what} was cancelled`)
  }, [])

  useLiveTopic('bench', (m) => {
    if (m.snapshot) return
    const d = m.d as { id?: number | string; line?: string; status?: Watched['status']; result?: Record<string, unknown> }
    if (d?.id === undefined) return
    if (typeof d.line === 'string') {
      const line = d.line
      setWatched((w) => {
        if (w && String(w.id) === String(d.id)) {
          const lines = w.lines.length >= MAX_LINES ? [...w.lines.slice(-MAX_LINES + 1), line] : [...w.lines, line]
          return { ...w, lines }
        }
        if (!w || w.status !== 'running') {
          // a run started elsewhere: follow it
          void queryClient.invalidateQueries({ queryKey: qk.bench })
          return {
            id: d.id!,
            kind: '…',
            preset: null,
            startedAt: Date.now() / 1000,
            status: 'running',
            endedAt: null,
            lines: [line],
            result: null,
            joinedLate: true,
          }
        }
        return w
      })
    }
    if (d.status && d.status !== 'running') finish(d.id, d.status, d.result ?? null)
  })

  // Fill in the kind and preset of a run first seen through its log lines.
  useEffect(() => {
    if (watched && watched.kind === '…') {
      const r = runs.find((x) => String(x.id) === String(watched.id))
      if (r) setWatched({ ...watched, kind: r.kind, preset: r.preset, startedAt: r.started_at })
    }
  }, [runs, watched])

  const start = async () => {
    setStarting(true)
    const k = KINDS.find((x) => x.value === kind)!
    try {
      const body = k.speed ? { kind, cases: cases.join(','), repeat } : { kind }
      const r = await api.post<{ id: number }>('/api/bench/runs', body)
      // the first log lines can arrive on the socket before this answer: keep them
      setWatched((w) =>
        w && String(w.id) === String(r.id)
          ? { ...w, kind, preset: st?.server.preset ?? w.preset, joinedLate: false }
          : {
              id: r.id,
              kind,
              preset: st?.server.preset ?? null,
              startedAt: Date.now() / 1000,
              status: 'running',
              endedAt: null,
              lines: [],
              result: null,
              joinedLate: false,
            },
      )
      void queryClient.invalidateQueries({ queryKey: qk.bench })
    } catch (e) {
      toast.error(`Starting ${kind} failed`, { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setStarting(false)
    }
  }

  const cancel = async () => {
    if (!watched) return
    setCancelling(true)
    try {
      await api.post(`/api/bench/runs/${encodeURIComponent(String(watched.id))}/cancel`)
    } catch (e) {
      toast.error('Cancelling failed', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setCancelling(false)
    }
  }

  const doImport = async () => {
    setImporting(true)
    try {
      const r = await api.post<{ imported: number }>('/api/bench/import')
      toast.success(r.imported ? `Imported ${r.imported} result file${r.imported === 1 ? '' : 's'}` : 'Nothing new in bench/results')
      void queryClient.invalidateQueries({ queryKey: qk.bench })
    } catch (e) {
      toast.error('Importing failed', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setImporting(false)
    }
  }

  if (runsQ.data === null) {
    return (
      <Panel>
        <Empty icon={<FlaskConical />} title="The benchmark lab is not on this server yet">
          This console's backend has no <code className="text-xs">/api/bench/runs</code>. Update the console (
          <code className="text-xs">setup/deploy.sh</code> on the server) and reload. Until then,{' '}
          <code className="text-xs">outcrop bench</code> runs quickbench over SSH.
        </Empty>
      </Panel>
    )
  }

  const runningRun = watched?.status === 'running' ? (runs.find((r) => String(r.id) === String(watched.id)) ?? null) : null
  const busyRun: LabRun | null =
    watched?.status === 'running'
      ? (runningRun ?? {
          id: watched.id,
          kind: watched.kind,
          preset: watched.preset,
          status: 'running',
          started_at: watched.startedAt,
          ended_at: null,
          result: {},
          contention: 0,
          source: null,
        })
      : null
  const byId = (id: LabRun['id'] | null) => (id === null ? null : (runs.find((r) => String(r.id) === String(id)) ?? null))
  const shown: Watched | null =
    watched ??
    (lastRun
      ? {
          id: lastRun.id,
          kind: lastRun.kind,
          preset: lastRun.preset,
          startedAt: lastRun.started_at,
          status: (['ok', 'failed', 'cancelled'].includes(lastRun.status) ? lastRun.status : 'ok') as Watched['status'],
          endedAt: lastRun.ended_at,
          lines: (lastLog.data?.log ?? '').split('\n').filter((l, i, a) => l || i < a.length - 1),
          result: lastRun.result,
          joinedLate: false,
        }
      : null)

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
        <RunPanel
          kind={kind}
          setKind={setKind}
          cases={cases}
          setCases={setCases}
          repeat={repeat}
          setRepeat={setRepeat}
          preset={st?.server.preset ?? null}
          running={busyRun}
          runningSince={watched?.status === 'running' ? watched.startedAt : null}
          starting={starting}
          cancelling={cancelling}
          onStart={start}
          onCancel={cancel}
          runs={runs}
          now={now}
        />
        <LogPanel w={shown} now={now} previous={!watched && !!lastRun} />
      </div>
      <Compare runs={runs} a={byId(aId)} b={byId(bId)} setA={setAId} setB={setBId} />
      <History
        runs={runs}
        loading={runsQ.isLoading}
        aId={aId}
        bId={bId}
        setA={(id) => {
          picked.current = true
          setAId(id)
        }}
        setB={(id) => {
          picked.current = true
          setBId(id)
        }}
        onOpen={setOpen}
        onImport={doImport}
        importing={importing}
        now={now}
      />
      <RunDetail run={open} onClose={() => setOpen(null)} now={now} />
    </div>
  )
}
