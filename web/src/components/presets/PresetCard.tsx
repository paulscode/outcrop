import { Clock, Loader2, Play, RotateCcw, Star, Zap } from 'lucide-react'
import { useState } from 'react'
import { setDefaultPreset, switchPreset } from '@/lib/actions'
import { ago, ctx, dur, fixed, int, isNum, pct, tps } from '@/lib/format'
import type { PresetCard as Card } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/controls'
import { Badge } from '../ui/misc'
import { Popover, PopoverContent, PopoverTrigger, Tip } from '../ui/menu'

const ORIGINAL = 93.1

/** Quality on a short scale (85 to 95) with the original model's score marked. */
function QualityScale({ q }: { q: number | null }) {
  const lo = 86
  const hi = 95
  const x = (v: number) => `${((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100}%`
  return (
    <div className="grid gap-1">
      <div className="relative h-1.5 rounded-full bg-line" role="img" aria-label={`task average ${q ?? '—'}, the original model scores ${ORIGINAL}`}>
        {isNum(q) ? <div className="absolute inset-y-0 left-0 rounded-full bg-fg/80" style={{ width: x(q) }} /> : null}
        <div className="absolute -top-1 h-3.5 w-px bg-muted" style={{ left: x(ORIGINAL) }} aria-hidden />
      </div>
      <div className="flex justify-between text-[10.5px] text-faint">
        <span className="num">{isNum(q) ? `${fixed(q, 1)} task average` : 'task average —'}</span>
        <span>original {ORIGINAL}</span>
      </div>
    </div>
  )
}

/** Switch now or when idle: the second tap starts it. */
function SwitchButton({ p, busy, disabled }: { p: Card; busy: boolean; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const [cancel, setCancel] = useState(false)
  const go = async (when: 'now' | 'idle') => {
    setOpen(false)
    await switchPreset(p.name, when, cancel)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={p.running ? 'secondary' : 'primary'} size="sm" disabled={disabled} loading={busy} data-testid={`switch-${p.name}`}>
          {busy ? null : p.running ? <RotateCcw /> : <Play />}
          {p.running ? 'Restart' : 'Switch'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <p className="text-[13px] font-semibold">{p.running ? `Restart ${p.name}?` : `Switch to ${p.name}?`}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          About {dur(p.estimate_s)}. New requests wait at the gateway meanwhile, and {p.name} answers them.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="primary" size="sm" onClick={() => go('now')} data-testid="switch-now">
            Now
          </Button>
          <Button variant="secondary" size="sm" onClick={() => go('idle')}>
            When idle
          </Button>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-muted">
          <Checkbox checked={cancel} onCheckedChange={(v) => setCancel(v === true)} aria-label="Cancel running requests instead of letting them finish" />
          Cancel running requests (otherwise they finish first)
        </label>
      </PopoverContent>
    </Popover>
  )
}

export function PresetCard({ p, switching }: { p: Card; switching: string | null }) {
  const m = p.measured ?? {}
  const warm = p.warm
  const warmWord = warm === null ? 'unknown' : warm > 0.8 ? 'warm' : warm > 0.3 ? 'partly warm' : 'cold'
  const isTarget = switching === p.name
  const desc = p.description.replace(/^[^:]*:\s*/, '')
  return (
    <article
      className={cn(
        'panel relative flex flex-col overflow-hidden transition-colors',
        p.running && 'border-answer/40',
        isTarget && 'border-warn/50',
      )}
      aria-labelledby={`preset-${p.name}`}
      data-testid={`preset-${p.name}`}
    >
      {p.running ? <div className="absolute inset-x-0 top-0 h-0.5 bg-answer" aria-hidden /> : null}
      <div className="flex items-start gap-3 p-4 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`preset-${p.name}`} className="text-[17px] font-semibold tracking-tight">
              {p.name}
            </h3>
            {p.running ? (
              <Badge tone="answer">
                <span className="size-1.5 rounded-full bg-answer" aria-hidden /> running
              </Badge>
            ) : null}
            {isTarget ? (
              <Badge tone="warn">
                <Loader2 className="animate-spin" aria-hidden /> starting
              </Badge>
            ) : null}
            {p.default ? (
              <Tip content="The server starts this preset after a reboot">
                <Badge>
                  <Star aria-hidden /> boot default
                </Badge>
              </Tip>
            ) : null}
          </div>
          <p className="num mt-1 text-xs text-faint">
            {p.pack.toUpperCase()} · {isNum(p.bits) ? `${p.bits} bits/weight` : '—'} · {ctx(p.context)} context
            {p.rope ? ` (${p.rope.scaling} ×${p.rope.scale})` : ''}
          </p>
        </div>
      </div>
      <p className="px-4 text-[13px] leading-relaxed text-muted">{desc}</p>
      <div className="px-4 pt-4">
        <QualityScale q={p.quality} />
      </div>
      <dl className="grid grid-cols-3 gap-px border-y border-line bg-line mt-4">
        {[
          ['Answering', tps(m.chat?.decode), 'decode speed, the chat case of its benchmark'],
          ['Reading', m.doc4k ? `${int(m.doc4k.prompt)} tok/s` : '—', 'prompt-reading (prefill) speed, a 4K-token document'],
          ['First token', m.chat ? `${fixed(m.chat.ttft, 2)} s` : '—', 'time to the first token of a short chat'],
        ].map(([k, v, t]) => (
          <div key={k} className="bg-panel px-3 py-2.5">
            <Tip content={t}>
              <dt className="text-[11px] text-faint">{k}</dt>
            </Tip>
            <dd className="num mt-0.5 text-[14px]">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-2 px-4 py-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <Tip content="Experts kept in the GPU's expert cache (VRAM); the rest are computed from RAM">
            <span className="text-faint">Experts on the GPU</span>
          </Tip>
          <span className="num">{int(p.expert_slots)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <Tip content="How much of the pack's files are in the page cache: a warm pack switches faster">
            <span className="text-faint">Pack in page cache</span>
          </Tip>
          <span className="num">
            {warm !== null ? pct(warm) : '—'} <span className="text-faint">{warmWord}</span>
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-faint">Switch time</span>
          <span className="num">
            about {dur(p.estimate_s)}
            {p.last_switch_s ? <span className="text-faint"> · last {dur(p.last_switch_s)}, {ago(p.last_switch_at)}</span> : null}
          </span>
        </div>
      </div>
      <div className="mt-auto flex items-center gap-2 border-t border-line px-4 py-3">
        <SwitchButton p={p} busy={isTarget} disabled={!!switching} />
        {!p.default ? (
          <Button variant="ghost" size="sm" onClick={() => setDefaultPreset(p.name)}>
            <Star /> Make boot default
          </Button>
        ) : null}
        {m.at ? (
          <Tip content={`Measured ${ago(m.at)}${p.measured_from !== p.name ? ` (from ${p.measured_from})` : ''}`}>
            <span className="ml-auto hidden items-center gap-1 whitespace-nowrap text-[11px] text-faint sm:inline-flex">
              <Clock className="size-3" aria-hidden /> {ago(m.at)}
            </span>
          </Tip>
        ) : (
          <span className="ml-auto hidden items-center gap-1 text-[11px] text-faint sm:inline-flex">
            <Zap className="size-3" aria-hidden /> not measured
          </span>
        )}
      </div>
    </article>
  )
}
