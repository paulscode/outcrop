// Memory strata: VRAM and RAM drawn as a geological core sample. The layers sit from the bottom up (the experts at the
// base), free memory is the open air at the top, and every layer explains on hover what it is and what it buys.

import { useMemo } from 'react'
import { isNum } from '@/lib/format'
import type { EngineSnapshot, MemoryInfo, MemoryLayer, MetricsSample } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Tip } from '../ui/menu'

export interface Layer {
  key: string
  label: string
  gib: number
  note?: string
}

const COLOR: Record<string, string> = {
  experts: 'var(--layer-1)',
  arena: 'var(--layer-1)',
  dense: 'var(--layer-2)',
  kv: 'var(--layer-5)',
  mtp: 'var(--layer-4)',
  ngram: 'var(--layer-3)',
  convcache: 'var(--layer-6)',
  pagecache: 'var(--layer-5)',
  other: 'var(--layer-7)',
  free: 'transparent',
}

export function layerColor(key: string): string {
  return COLOR[key] ?? 'var(--layer-7)'
}

function fmt(g: number): string {
  if (g >= 100) return `${Math.round(g)} GiB`
  if (g >= 10) return `${g.toFixed(1)} GiB`
  if (g >= 1) return `${g.toFixed(2)} GiB`
  return `${Math.round(g * 1024)} MiB`
}

/** Layers from /api/memory, or worked out from the live sample and the engine's settings when that is not available. */
export function useStrata(mem: MemoryInfo | null | undefined, sample: MetricsSample | null, engine: EngineSnapshot | null) {
  return useMemo(() => {
    if (mem?.vram?.layers?.length) {
      const vram = mem.vram.layers.map((l: MemoryLayer) => ({ key: l.key, label: l.label, gib: (l.mib ?? 0) / 1024, note: l.note }))
      const ram = mem.ram.layers.map((l: MemoryLayer) => ({ key: l.key, label: l.label, gib: l.gib ?? 0, note: l.note }))
      return { vram, vramTotal: mem.vram.total_mib / 1024, ram, ramTotal: mem.ram.total_gib, derived: false }
    }
    const g = sample?.gpu
    const e = engine?.engine
    const h = sample?.host
    const vram: Layer[] = []
    const vt = isNum(g?.mem_total) && g.mem_total ? g.mem_total / 1024 : null
    if (vt) {
      const used = isNum(g?.mem_used) ? g.mem_used / 1024 : 0
      const experts = isNum(e?.expert_cache_mib) ? e.expert_cache_mib / 1024 : 0
      const free = isNum(e?.vram_free_mib) ? e.vram_free_mib / 1024 : Math.max(0, vt - used)
      if (experts) vram.push({ key: 'experts', label: 'Expert cache', gib: experts, note: `${e?.expert_slots ?? '—'} experts kept on the card` })
      vram.push({ key: 'other', label: 'Weights, KV and buffers', gib: Math.max(0, vt - experts - free) })
      vram.push({ key: 'free', label: 'Free', gib: free })
    }
    const ram: Layer[] = []
    const rt = h?.ram_total ?? null
    if (rt) {
      const arena = isNum(e?.arena_mib) ? e.arena_mib / 1024 : 0
      const conv = isNum(engine?.conversation_cache?.bytes) ? engine.conversation_cache.bytes / 2 ** 30 : 0
      const used = h?.ram_used ?? 0
      const cached = h?.cached ?? 0
      if (arena) ram.push({ key: 'arena', label: 'Expert arena', gib: arena, note: 'every expert, pinned for the GPU to fetch' })
      if (conv) ram.push({ key: 'convcache', label: 'Conversation cache', gib: conv })
      ram.push({ key: 'other', label: 'Everything else', gib: Math.max(0, used - arena - conv) })
      ram.push({ key: 'pagecache', label: 'Page cache', gib: cached, note: 'files kept in RAM' })
      ram.push({ key: 'free', label: 'Free', gib: Math.max(0, rt - used - cached) })
    }
    return { vram, vramTotal: vt ?? 0, ram, ramTotal: rt ?? 0, derived: true }
  }, [mem, sample, engine])
}

/** One core sample: a column of layers (base at the bottom), with a legend beside it. */
export function CoreSample({
  title,
  total,
  layers,
  height = 176,
  className,
  compact,
}: {
  title: string
  total: number
  layers: Layer[]
  height?: number
  className?: string
  compact?: boolean
}) {
  const sum = Math.max(total, layers.reduce((a, l) => a + l.gib, 0)) || 1
  const solid = layers.filter((l) => l.key !== 'free' && l.gib > 0)
  const free = layers.find((l) => l.key === 'free')
  const used = solid.reduce((a, l) => a + l.gib, 0)
  return (
    <figure className={cn('flex min-w-0 gap-4', className)} aria-label={`${title}: ${fmt(used)} of ${fmt(sum)} in use`}>
      <div
        className="relative flex w-12 shrink-0 flex-col-reverse overflow-hidden rounded-md border border-line-strong bg-sunken sm:w-14"
        style={{ height }}
      >
        {solid.map((l, i) => {
          const h = Math.max(2, (l.gib / sum) * height)
          return (
            <Tip
              key={l.key}
              side="right"
              content={
                <span>
                  <span className="font-semibold">{l.label}</span> · <span className="num">{fmt(l.gib)}</span>
                  {l.note ? <span className="block text-muted">{l.note}</span> : null}
                </span>
              }
            >
              <div
                className="strata-layer relative w-full shrink-0 transition-[height] duration-700 ease-out"
                style={{ height: h, backgroundColor: layerColor(l.key), zIndex: solid.length - i }}
                aria-hidden
              />
            </Tip>
          )
        })}
        {free && free.gib > 0 ? <div className="hatch w-full flex-1" aria-hidden /> : null}
      </div>
      <figcaption className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] font-semibold">{title}</span>
          <span className="num text-xs text-faint">
            {fmt(used)} / {fmt(sum)}
          </span>
        </div>
        <ul className={cn('mt-2 grid', compact ? 'gap-1' : 'gap-1.5')}>
          {[...solid].reverse().map((l) => (
            <li key={l.key} className="flex min-w-0 items-center gap-2 text-xs">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: layerColor(l.key) }} aria-hidden />
              <Tip content={l.note}>
                <span className="min-w-0 truncate text-muted">{l.label}</span>
              </Tip>
              <span className="num ml-auto shrink-0 text-fg">{fmt(l.gib)}</span>
            </li>
          ))}
          {free ? (
            <li className="flex items-center gap-2 text-xs">
              <span className="hatch size-2.5 shrink-0 rounded-[3px] border border-line-strong" aria-hidden />
              <Tip content={free.note}>
                <span className="text-muted">{free.label}</span>
              </Tip>
              <span className="num ml-auto text-fg">{fmt(free.gib)}</span>
            </li>
          ) : null}
        </ul>
      </figcaption>
    </figure>
  )
}

/** A horizontal band of the same layers, for tight places (phones, the System page header). */
export function StrataBand({ layers, total, label, className }: { layers: Layer[]; total: number; label: string; className?: string }) {
  const sum = Math.max(total, layers.reduce((a, l) => a + l.gib, 0)) || 1
  return (
    <div className={cn('flex h-3 w-full overflow-hidden rounded-full bg-sunken', className)} role="img" aria-label={label}>
      {layers
        .filter((l) => l.gib > 0)
        .map((l) => (
          <div
            key={l.key}
            className={cn('h-full transition-[width] duration-700', l.key === 'free' && 'hatch')}
            style={{ width: `${(l.gib / sum) * 100}%`, background: l.key === 'free' ? undefined : layerColor(l.key) }}
          />
        ))}
    </div>
  )
}
