// The launch sequence of a preset switch, from the `switch` topic's events (lib/outcrop_control.py's phases).

import { gib as fmtGib, int } from './format'
import type { SwitchEvent, SwitchState } from './types'

export type PhaseStatus = 'done' | 'current' | 'pending' | 'failed' | 'skipped'

export interface PhaseRow {
  key: string
  label: string
  status: PhaseStatus
  start?: number
  end?: number
  seconds?: number
  detail?: string
}

/** The order phases come in; the ones that have not happened yet are shown as pending. */
export const PHASE_ORDER = ['plan', 'hold', 'drain', 'stop', 'start', 'vision', 'weights', 'experts', 'gpu_cache', 'final', 'ready']

export function expectedLabel(key: string, sw: Pick<SwitchState, 'to' | 'from'>): string {
  switch (key) {
    case 'plan':
      return 'Plan'
    case 'hold':
      return 'Hold new requests'
    case 'drain':
      return 'Let running requests finish'
    case 'stop':
      return sw.from ? `Stop ${sw.from}` : 'Stop the running preset'
    case 'start':
      return `Start ${sw.to}`
    case 'vision':
      return 'Picture encoder'
    case 'weights':
      return 'Model weights'
    case 'experts':
      return 'Experts into RAM'
    case 'gpu_cache':
      return 'GPU expert cache'
    case 'final':
      return 'Final checks'
    case 'ready':
      return 'Ready'
    default:
      return key
  }
}

/** One plain sentence on what each phase does (the hover text). */
export const PHASE_HELP: Record<string, string> = {
  plan: 'Checks the preset, the free RAM and how much of the pack is already in the page cache.',
  hold: 'New requests wait at the gateway instead of failing; the new preset answers them.',
  drain: 'Requests that are already running finish first (or are cancelled, if you chose that).',
  stop: 'Stops the running engine, which gives back its pinned RAM (about 47 GiB).',
  start: 'Starts the systemd unit of the new preset.',
  vision: 'Loads the picture encoder: on the CPU, or on the GPU of a GB10.',
  weights: 'Reads the dense weights (attention, embeddings) into VRAM.',
  experts: 'Reads the experts into RAM (the expert arena); the slowest step when the pack is not in the page cache.',
  gpu_cache: 'Copies the most-used experts into the GPU expert cache in VRAM.',
  final: 'Warms up and runs the first-answer check.',
  ready: 'The engine answers; held requests are released.',
}

export interface SwitchProgress {
  phases: PhaseRow[]
  currentKey: string | null
  currentLabel: string
  elapsed: number
  estimate: number | null
  fraction: number
  expert: string | null
  expertFraction: number | null
  plan: SwitchEvent | null
  loaded: SwitchEvent | null
  drainLeft: number | null
  done: boolean
  ok: boolean
  error: string | null
  total: number | null
}

export function switchProgress(sw: SwitchState, now = Date.now() / 1000): SwitchProgress {
  const evs = sw.events ?? []
  const phaseEvs = evs.filter((e) => e.type === 'phase' && e.phase)
  const plan = [...evs].reverse().find((e) => e.type === 'plan') ?? null
  const loaded = [...evs].reverse().find((e) => e.type === 'experts_loaded') ?? null
  const doneEv = [...evs].reverse().find((e) => e.type === 'done') ?? null
  const finished = sw.status === 'done' || sw.status === 'failed' || sw.status === 'cancelled'
  const ok = sw.status === 'done' && doneEv?.ok !== false
  const last = sw.last
  const progress = last?.type === 'progress' ? last : [...evs].reverse().find((e) => e.type === 'progress') ?? null
  const drain = last?.type === 'drain' ? last : null

  const rows: PhaseRow[] = []
  phaseEvs.forEach((e, i) => {
    const next = phaseEvs[i + 1]
    const start = e.at
    const end = next?.at ?? (finished ? (sw.ended_at ?? undefined) : undefined)
    const isLast = i === phaseEvs.length - 1
    let status: PhaseStatus = 'done'
    if (isLast && !finished) status = 'current'
    if (isLast && finished && !ok) status = e.phase === 'ready' ? 'done' : 'failed'
    let detail: string | undefined
    if (e.phase === 'gpu_cache' && e.slots) detail = `${int(Number(e.slots))} experts → ${e.vram ? fmtGib(Number(e.vram)) : '—'} of VRAM`
    if (e.phase === 'experts' && loaded && (status === 'done' || finished))
      detail = `${fmtGib(Number(loaded.gib))}${loaded.rate ? ` at ${Number(loaded.rate).toFixed(1)} GiB/s` : ''}`
    if (e.phase === 'stop') detail = 'gives back its pinned RAM'
    if (e.phase === 'drain' && e.count) detail = `${e.count} running`
    rows.push({
      key: e.phase!,
      label: e.label || expectedLabel(e.phase!, sw),
      status,
      start,
      end,
      seconds: start && end ? end - start : start && status === 'current' ? now - start : undefined,
      detail,
    })
  })
  if (!finished) {
    const seen = new Set(rows.map((r) => r.key))
    const lastIdx = rows.length ? PHASE_ORDER.indexOf(rows[rows.length - 1].key) : -1
    for (const k of PHASE_ORDER) {
      if (seen.has(k) || k === 'drain' || k === 'plan') continue
      if (PHASE_ORDER.indexOf(k) <= lastIdx) continue
      rows.push({ key: k, label: expectedLabel(k, sw), status: 'pending' })
    }
  }

  const cur = rows.find((r) => r.status === 'current') ?? null
  const elapsed = finished
    ? (doneEv?.total_s ?? (sw.ended_at && sw.started_at ? sw.ended_at - sw.started_at : 0))
    : Math.max(0, now - sw.started_at)
  const estimate = plan?.estimate_s ?? null
  let fraction = finished ? 1 : estimate ? Math.min(0.97, elapsed / estimate) : 0
  let expert: string | null = null
  let expertFraction: number | null = null
  if (progress && progress.rss_gib != null && cur?.key === 'experts') {
    const target = progress.target_gib ?? null
    expert = target ? `${progress.rss_gib.toFixed(1)} of ${target.toFixed(1)} GiB` : `${progress.rss_gib.toFixed(1)} GiB`
    expertFraction = target ? Math.min(1, progress.rss_gib / target) : null
  }
  if (!finished && !estimate) {
    const idx = cur ? PHASE_ORDER.indexOf(cur.key) : 0
    fraction = Math.max(0, idx) / PHASE_ORDER.length
  }
  let currentLabel = cur?.label ?? (sw.status === 'waiting' ? 'waiting for an idle moment' : finished ? (ok ? 'ready' : 'stopped') : 'starting')
  if (drain?.left) currentLabel = `${currentLabel} (${drain.left} still running)`
  return {
    phases: rows,
    currentKey: cur?.key ?? null,
    currentLabel,
    elapsed,
    estimate,
    fraction,
    expert,
    expertFraction,
    plan,
    loaded,
    drainLeft: drain?.left ?? null,
    done: finished,
    ok,
    error: sw.error ?? doneEv?.error ?? null,
    total: doneEv?.total_s ?? null,
  }
}
