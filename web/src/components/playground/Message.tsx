import { Link } from '@tanstack/react-router'
import { AlertTriangle, ArrowUpRight, Brain, ChevronDown, CircleStop, RotateCcw, Wrench } from 'lucide-react'
import { lazy, memo, Suspense, useState } from 'react'
import { fixed, int, isNum, pct } from '@/lib/format'
import { gatewayStore, metricsStore, riverStore } from '@/lib/live'
import { activeRid, inflightList, isGenerating } from '@/lib/requests'
import type { AssistantMsg, UserMsg } from '@/lib/playground'
import { answerRate, type StreamState } from '@/lib/sse'
import { shallow, useStore } from '@/lib/store'
import type { RequestDetail } from '@/lib/types'
import { cn, useNow } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/menu'
import { CopyButton } from '@/components/ui/misc'
import { Bar } from '@/components/viz/basic'

const Markdown = lazy(() => import('./Markdown'))

function Plain({ text }: { text: string }) {
  return <div className="whitespace-pre-wrap text-[14px] leading-[1.7] text-fg">{text}</div>
}

export const UserMessage = memo(function UserMessage({ m }: { m: UserMsg }) {
  return (
    <div className="flex justify-end">
      <div className="grid max-w-[min(85%,640px)] gap-2 rounded-2xl rounded-br-md border border-line-strong bg-panel-3 px-4 py-2.5">
        {m.images.length ? (
          <div className="flex flex-wrap gap-2">
            {m.images.map((src, i) => (
              <img key={i} src={src} alt={`attached picture ${i + 1}`} className="max-h-40 rounded-lg border border-line object-contain" />
            ))}
          </div>
        ) : null}
        {m.text ? <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-fg">{m.text}</div> : null}
      </div>
    </div>
  )
})

function seconds(a: number | null | undefined, b: number | null | undefined): number | null {
  return isNum(a) && isNum(b) && b >= a ? b - a : null
}

function ThinkingBlock({ s, streaming }: { s: StreamState; streaming: boolean }) {
  const thinkingNow = streaming && s.phase === 'thinking'
  const [open, setOpen] = useState<boolean | null>(null)
  const isOpen = open ?? thinkingNow
  const now = useNow(thinkingNow ? 250 : 60_000)
  const t = seconds(s.firstTokenAt, s.thinkingEndedAt ?? (thinkingNow ? now : (s.answerAt ?? s.endedAt)))
  const tokens = s.usage?.completion_tokens_details?.reasoning_tokens
  return (
    <div className="rounded-lg border border-think/25 bg-think-bg/50">
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]"
      >
        <Brain className={cn('size-4 text-think', thinkingNow && 'animate-pulse')} aria-hidden />
        <span className="font-medium text-think">{thinkingNow ? 'Thinking…' : 'Thinking'}</span>
        <span className="num text-xs text-faint">
          {t !== null ? `${fixed(t, 1)} s` : ''}
          {isNum(tokens) ? ` · ${int(tokens)} tokens` : ''}
        </span>
        <ChevronDown className={cn('ml-auto size-4 text-faint transition-transform', isOpen && 'rotate-180')} aria-hidden />
      </button>
      {isOpen ? (
        <div className="max-h-80 overflow-y-auto whitespace-pre-wrap border-t border-think/20 px-3 py-2.5 text-[13px] leading-relaxed text-muted scrollbar-thin">
          {s.thinking}
        </div>
      ) : null}
    </div>
  )
}

function ToolCard({ name, args }: { name: string; args: string }) {
  let pretty = args
  try {
    pretty = JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    /* still streaming, or not JSON */
  }
  return (
    <div className="rounded-lg border border-line-strong bg-panel-2/70">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[13px]">
        <Wrench className="size-3.5 text-faint" aria-hidden />
        <span className="text-muted">Tool call</span>
        <code className="font-mono text-[12.5px] text-fg">{name || '…'}</code>
        <span className="ml-auto">
          <CopyButton value={pretty} label="Copy the arguments" size="xs" />
        </span>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[12px] leading-relaxed text-fg/90 scrollbar-thin">{pretty || '{}'}</pre>
    </div>
  )
}

/** Before the first token: the engine's own progress through the prompt, when it is reading one. */
/**
 * Before the first token, say what is really happening, from the gateway's and the engine's live state: held at the gateway
 * (a preset switch), waiting behind other apps' requests (one at a time), or reading the prompt, with the engine's progress.
 */
function Waiting({ since, rid }: { since: number | null; rid: string | null }) {
  const now = useNow(250)
  const e = useStore(metricsStore, (x) => ({ st: x.latest?.engine?.state, r: x.latest?.engine?.prompt_read, t: x.latest?.engine?.prompt_total }), shallow)
  const hold = useStore(gatewayStore, (g) => (g?.hold && g.hold.ready === false ? g.hold.reason || 'a preset switch' : null))
  const q = useStore(
    riverStore,
    (s) => {
      const me = rid ? s.inflight[rid] : undefined
      const active = activeRid(s)
      const ahead = me
        ? inflightList(s).filter((f) => f.rid !== rid && isGenerating(f) && f.started_at < me.started_at && !f.denied).length
        : 0
      return { held: me?.phase === 'held', mine: !!me && active === rid, ahead, known: !!me }
    },
    shallow,
  )
  const elapsed = since ? `${fixed(Math.max(0, now - since), 1)} s` : ''
  let tone = 'read'
  let text = 'Reading the prompt'
  if (q.held || (hold && !q.known)) {
    tone = 'warn'
    text = `Held at the gateway: ${hold ?? 'a preset switch'}`
  } else if (q.known && !q.mine && q.ahead > 0) {
    tone = 'neutral'
    text = `Waiting behind ${q.ahead} earlier request${q.ahead === 1 ? "" : "s"}: the server answers one at a time`
  }
  const reading = tone === 'read' && (e.st === 'reading' || e.st === 'prefill') && isNum(e.t) && e.t > 0 && (q.mine || !q.known)
  return (
    <div className="grid gap-2" aria-hidden>
      <div className="flex items-center gap-2 text-[13px]">
        <span className={cn('size-2 animate-pulse rounded-full', tone === 'read' ? 'bg-read' : tone === 'warn' ? 'bg-warn' : 'bg-faint')} />
        <span className={tone === 'read' ? 'text-read' : tone === 'warn' ? 'text-warn' : 'text-muted'}>{text}</span>
        <span className="num text-xs text-faint">{elapsed}</span>
        {reading ? (
          <span className="num ml-auto text-xs text-faint">
            {int(e.r ?? 0)} of {int(e.t)} tokens
          </span>
        ) : null}
      </div>
      {reading ? <Bar value={e.r ?? 0} max={e.t!} color="var(--read)" height={4} label="prompt read" /> : null}
    </div>
  )
}

function Stats({ m, record, children }: { m: AssistantMsg; record: RequestDetail | null; children?: React.ReactNode }) {
  const s = m.s
  const ttft = isNum(record?.ttft_ms) ? record!.ttft_ms! / 1000 : seconds(m.startedAt, s.firstTokenAt)
  const rate = s.timings?.predicted_per_second ?? record?.decode_tok_s ?? answerRate(s, s.endedAt ?? Date.now() / 1000)
  const out = s.usage?.completion_tokens ?? record?.output_tokens ?? null
  const inTok = s.usage?.prompt_tokens ?? record?.prompt_tokens ?? null
  const reused = s.timings?.cache_n ?? record?.reused_tokens ?? s.usage?.prompt_tokens_details?.cached_tokens ?? null
  const prefill = s.timings?.prompt_per_second ?? record?.prefill_tok_s ?? null
  const drafts = s.timings?.draft_n ?? record?.drafts_offered ?? null
  const kept = s.timings?.draft_n_accepted ?? record?.drafts_accepted ?? null
  const hit = record?.hit_rate ?? null
  const items: Array<{ k: string; v: string; tip: string }> = []
  if (ttft !== null) items.push({ k: 'first token', v: `${fixed(ttft, ttft < 10 ? 2 : 1)} s`, tip: 'Time to the first token (TTFT): reading the prompt, then the first step.' })
  if (isNum(rate)) items.push({ k: 'answer', v: `${fixed(rate, 1)} tok/s`, tip: 'Answer speed (decode tokens per second), as the engine measured it.' })
  if (isNum(out)) items.push({ k: 'tokens', v: `${int(out)} out${isNum(inTok) ? ` · ${int(inTok)} in` : ''}`, tip: 'Tokens written (thinking and answer) and the prompt size.' })
  if (isNum(prefill) && isNum(inTok) && inTok > 0)
    items.push({ k: 'prompt', v: `${fixed(prefill, 0)} tok/s`, tip: 'Prompt reading speed (prefill tokens per second).' })
  if (isNum(reused) && reused > 0)
    items.push({ k: 'reused', v: `${int(reused)} tokens`, tip: 'Prompt tokens taken from the conversation cache instead of being read again.' })
  if (isNum(drafts) && drafts > 0 && isNum(kept))
    items.push({ k: 'drafts kept', v: `${pct(kept / drafts)}`, tip: `MTP drafted ${int(drafts)} tokens and ${int(kept)} were accepted, which saves decode steps.` })
  if (isNum(hit)) items.push({ k: 'experts in VRAM', v: pct(hit), tip: 'Expert-cache hit rate: the share of experts this answer needed that were already in VRAM.' })
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
      {items.map((it) => (
        <Tip key={it.k} content={it.tip}>
          <span className="cursor-help">
            {it.k} <span className="num text-muted">{it.v}</span>
          </span>
        </Tip>
      ))}
      {s.finish === 'length' ? (
        <span className="inline-flex items-center gap-1 text-warn">
          <AlertTriangle className="size-3" aria-hidden /> stopped at the token limit
        </span>
      ) : null}
      {m.rid ? (
        <Tip content="This request on the Requests page: timings, engine numbers, and the captured bodies when capture is on">
          <Link to="/requests" search={{ rid: m.rid }} className="inline-flex items-center gap-0.5 text-faint hover:text-fg">
            <span className="num">{m.rid}</span>
            <ArrowUpRight className="size-3" aria-hidden />
          </Link>
        </Tip>
      ) : null}
      {children ? <span className="ml-auto">{children}</span> : null}
    </div>
  )
}

export const AssistantMessage = memo(function AssistantMessage({
  m,
  record,
  onRetry,
  label,
}: {
  m: AssistantMsg
  record: RequestDetail | null
  onRetry?: () => void
  label?: string
}) {
  const s = m.s
  const streaming = m.status === 'streaming' || m.status === 'waiting'
  const now = useNow(streaming ? 500 : 60_000)
  return (
    <article className="grid min-w-0 grid-cols-1 gap-3" aria-label={label ?? 'Answer'}>
      <div className="flex items-center gap-2 text-xs text-faint">
        <span className="font-medium text-muted">{label ?? 'Model'}</span>
        <span>·</span>
        <span>thinking {m.params.thinking ? 'on' : 'off'}</span>
        <span className="num">· temp {fixed(m.params.temperature, 2)}</span>
        {m.status === 'stopped' ? (
          <span className="inline-flex items-center gap-1 text-warn">
            <CircleStop className="size-3" aria-hidden /> stopped
          </span>
        ) : null}
      </div>
      {m.status === 'queued' ? (
        <p className="text-[13px] text-faint">Waits for the other answer: the server answers one request at a time.</p>
      ) : null}
      {m.status === 'stopped' && !m.startedAt ? <p className="text-[13px] text-faint">Not sent: stopped before its turn.</p> : null}
      {m.status === 'waiting' && !s.firstTokenAt ? <Waiting since={m.startedAt} rid={m.rid} /> : null}
      {s.thinking ? <ThinkingBlock s={s} streaming={streaming} /> : null}
      {s.content ? (
        <Suspense fallback={<Plain text={s.content} />}>
          <Markdown text={s.content} />
        </Suspense>
      ) : null}
      {s.toolCalls.map((t) => (
        <ToolCard key={t.index} name={t.name} args={t.arguments} />
      ))}
      {streaming && s.phase === 'answering' ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="size-1.5 animate-pulse rounded-full bg-answer" aria-hidden />
          <span className="text-answer">Answering</span>
          <span className="num text-faint">{isNum(answerRate(s, now)) ? `${fixed(answerRate(s, now), 1)} tok/s` : ''}</span>
        </div>
      ) : null}
      {m.status === 'error' || s.error ? (
        <div className="flex flex-wrap items-start gap-2 rounded-lg border border-error/35 bg-error-bg px-3 py-2 text-[13px]" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-error" aria-hidden />
          <span className="min-w-0 flex-1 text-fg">{m.error || s.error}</span>
          {onRetry ? (
            <Button size="xs" variant="outline" onClick={onRetry}>
              <RotateCcw aria-hidden /> Try again
            </Button>
          ) : null}
        </div>
      ) : null}
      {m.status === 'done' || (m.status === 'stopped' && m.startedAt) ? (
        <Stats m={m} record={record}>
          {s.content ? <CopyButton value={s.content} label="Copy the answer" size="xs" /> : null}
        </Stats>
      ) : null}
      {m.status === 'done' && !s.content && !s.toolCalls.length && !s.error ? (
        <p className="text-[13px] text-faint">
          The answer was empty{s.thinking ? ' (it only thought: raise the token limit, or turn thinking off)' : ''}.
        </p>
      ) : null}
    </article>
  )
})
