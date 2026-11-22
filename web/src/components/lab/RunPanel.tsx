import { Gauge, Play, Square } from 'lucide-react'
import { CASE_HELP, CASES, type CaseName, type LabRun } from '@/lib/bench'
import { clock, dur, mib } from '@/lib/format'
import { metricsStore, riverStore } from '@/lib/live'
import { shallow, useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox, Segmented } from '@/components/ui/controls'
import { Dot, Panel, PanelHeader } from '@/components/ui/misc'

export type Kind = 'quickbench' | 'validate' | 'qualgate' | 'apitest'

export const KINDS: Array<{ value: Kind; label: string; what: string; speed: boolean }> = [
  {
    value: 'quickbench',
    label: 'quickbench',
    what: 'Speed: how fast the model reads each prompt and writes each answer, for the cases you pick, through the gateway.',
    speed: true,
  },
  {
    value: 'validate',
    label: 'validate',
    what: 'Everything, one after the other: the quality gate, the API test and quickbench. The full check after a change.',
    speed: true,
  },
  {
    value: 'qualgate',
    label: 'qualgate',
    what: 'Quality: a fixed set of tasks with known answers. It flags wrong, empty or broken answers.',
    speed: false,
  },
  {
    value: 'apitest',
    label: 'apitest',
    what: 'The API: the OpenAI, Anthropic and Ollama endpoints answer correctly, streamed and not (fast mode).',
    speed: false,
  },
]

/** Other processes on the GPU, from the live sample (sharing it with a remote desktop cost 7 to 15 % of decode speed). */
export function useGpuOthers() {
  return useStore(
    metricsStore,
    (s) => (s.latest?.gpu?.procs ?? []).filter((p) => !(p.name || '').includes('strata') && (p.mem ?? 0) > 0),
    shallow,
  )
}

export function RunPanel({
  kind,
  setKind,
  cases,
  setCases,
  repeat,
  setRepeat,
  preset,
  running,
  runningSince,
  starting,
  cancelling,
  onStart,
  onCancel,
  runs,
  now,
}: {
  kind: Kind
  setKind: (k: Kind) => void
  cases: CaseName[]
  setCases: (c: CaseName[]) => void
  repeat: number
  setRepeat: (n: number) => void
  preset: string | null
  running: LabRun | null
  runningSince: number | null
  starting: boolean
  cancelling: boolean
  onStart: () => void
  onCancel: () => void
  runs: LabRun[]
  now: number
}) {
  const others = useGpuOthers()
  // requests from apps (the benchmark's own requests are recognized as "bench" and left out)
  const inflight = useStore(riverStore, (s) => Object.values(s.inflight).filter((f) => f.app !== 'bench').length)
  const k = KINDS.find((x) => x.value === kind)!
  const last = runs.find((r) => r.kind === kind && r.status === 'ok' && r.ended_at)
  const busy = !!running
  const toggle = (c: CaseName, on: boolean) => setCases(on ? CASES.filter((x) => x === c || cases.includes(x)) : cases.filter((x) => x !== c))

  return (
    <Panel aria-labelledby="run-title">
      <PanelHeader id="run-title" title="Run a benchmark" icon={<Gauge />} meta={preset ? `on ${preset}, through the gateway` : undefined} />
      <div className="grid gap-4 p-4">
        <Segmented
          label="What to run"
          value={kind}
          onValueChange={(v) => setKind(v)}
          options={KINDS.map((x) => ({ value: x.value, label: x.label, disabled: busy }))}
          className="w-full [&>*]:flex-1"
        />
        <p className="min-h-[2.5rem] text-[13px] leading-relaxed text-muted">{k.what}</p>

        {k.speed ? (
          <>
            <fieldset className="grid gap-2" disabled={busy}>
              <legend className="eyebrow mb-1.5">Cases</legend>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {CASES.map((c) => {
                  const on = cases.includes(c)
                  return (
                    <label
                      key={c}
                      className={cn(
                        'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors',
                        on ? 'border-line-strong bg-panel-2' : 'border-line hover:bg-panel-2/50',
                        busy && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={on}
                        onCheckedChange={(v) => toggle(c, v === true)}
                        aria-label={`${c}: ${CASE_HELP[c]}`}
                        disabled={busy || (on && cases.length === 1)}
                      />
                      <span className="min-w-0">
                        <span className="num block text-[13px] text-fg">{c}</span>
                        <span className="block text-xs text-faint">{CASE_HELP[c]}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
            <div className="flex flex-wrap items-center gap-3">
              <span className="eyebrow" id="repeat-label">
                Repeat
              </span>
              <Segmented
                label="Repeat each case"
                size="sm"
                value={String(repeat)}
                onValueChange={(v) => setRepeat(Number(v))}
                options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: <span className="num">{n}×</span>, disabled: busy }))}
              />
              <span className="text-xs text-faint">the median of the repeats is kept</span>
            </div>
          </>
        ) : null}

        <ul className="grid gap-1.5 text-[13px]" aria-label="Conditions">
          <li className="flex items-start gap-2">
            <Dot tone={others.length ? 'warn' : 'ok'} className="mt-1.5" />
            {others.length ? (
              <span className="text-warn">
                Also on the GPU: {others.map((p) => `${p.name} (${mib(p.mem)})`).join(', ')}. The run will be marked, and its
                speeds may be low (a remote desktop on the GPU cost 7 to 15%).
              </span>
            ) : (
              <span className="text-muted">Strata has the GPU to itself.</span>
            )}
          </li>
          <li className="flex items-start gap-2">
            <Dot tone={inflight ? 'warn' : 'ok'} className="mt-1.5" />
            <span className={inflight ? 'text-warn' : 'text-muted'}>
              {inflight
                ? `${inflight} request${inflight === 1 ? ' is' : 's are'} running now. They and the benchmark share the engine, so both are slower.`
                : 'No other requests are running.'}
            </span>
          </li>
        </ul>

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          {busy ? (
            <>
              <Button variant="danger-outline" onClick={onCancel} loading={cancelling}>
                <Square aria-hidden /> Cancel {running?.kind}
              </Button>
              <span className="num text-[13px] text-muted" aria-live="off">
                running {clock(runningSince ? now - runningSince : null)}
              </span>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={onStart} loading={starting} disabled={k.speed && !cases.length}>
                <Play aria-hidden /> Start {kind}
              </Button>
              {last ? (
                <span className="text-xs text-faint">
                  the last {kind} took <span className="num">{dur((last.ended_at ?? 0) - last.started_at, { precise: true })}</span>
                </span>
              ) : null}
            </>
          )}
        </div>
        <p className="-mt-1 text-xs text-faint">One run at a time. It uses the local-tools token and is logged like any app.</p>
      </div>
    </Panel>
  )
}
