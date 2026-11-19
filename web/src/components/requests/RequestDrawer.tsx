import { Link } from '@tanstack/react-router'
import { Ban, CheckCircle2, FileJson, XCircle } from 'lucide-react'
import { useMemo } from 'react'
import { cancelRequest } from '@/lib/actions'
import { dialect } from '@/lib/engine'
import { bytes, compact, dateTime, dur, fixed, int, isNum, ms, pct, tps } from '@/lib/format'
import { PHASE_COLOR, PHASE_LABEL, phaseDurations, segments, type PhaseKey } from '@/lib/phases'
import { useRequestDetail } from '@/lib/queries'
import { isOk, outcomeText } from '@/lib/requests'
import type { Flight, RequestDetail } from '@/lib/types'
import { useNow } from '@/lib/utils'
import { Button } from '../ui/button'
import { Dialog, DialogDescription, DialogTitle, SheetContent } from '../ui/dialog'
import { Badge, CopyButton, KV } from '../ui/misc'
import { Tip } from '../ui/menu'

/** The phases of a request as one proportional bar with its durations. */
export function PhaseBar({ f, now }: { f: Flight; now: number }) {
  const segs = useMemo(() => segments(f, now), [f, now])
  const total = Math.max(0.001, (f.ended_at ?? now) - f.started_at)
  const d = phaseDurations(segs)
  return (
    <div className="grid gap-2">
      <div className="flex h-3 overflow-hidden rounded-full bg-line" role="img" aria-label="time by phase">
        {segs.map((s, i) => (
          <div
            key={i}
            className="h-full"
            title={`${PHASE_LABEL[s.key]}: ${dur(s.end - s.start)}`}
            style={{ width: `${((s.end - s.start) / total) * 100}%`, backgroundColor: PHASE_COLOR[s.key], opacity: s.key === 'waiting' ? 0.45 : 1 }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {(Object.keys(d) as PhaseKey[]).map((k) => (
          <li key={k} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ backgroundColor: PHASE_COLOR[k] }} aria-hidden />
            <span className="text-muted">{PHASE_LABEL[k]}</span>
            <span className="num text-fg">{dur(d[k])}</span>
          </li>
        ))}
        <li className="ml-auto text-muted">
          total <span className="num text-fg">{dur(total)}</span>
        </li>
      </ul>
    </div>
  )
}

function prettyJson(s: string | null): string {
  if (!s) return ''
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

/** An SSE answer stream joined into its text (OpenAI, Anthropic and Ollama shapes). */
function streamText(raw: string | null): string | null {
  if (!raw || !/^(data:|event:|\{)/m.test(raw)) return null
  let text = ''
  for (const line of raw.split('\n')) {
    const l = line.startsWith('data: ') ? line.slice(6) : line.startsWith('{') ? line : null
    if (!l || l === '[DONE]') continue
    try {
      const j = JSON.parse(l)
      const parts = [j.choices?.[0]?.delta?.content, j.choices?.[0]?.message?.content, j.delta?.text, j.message?.content, j.response]
      text += parts.filter((x) => typeof x === 'string').join('')
    } catch {
      /* not JSON */
    }
  }
  return text || null
}

function Body({ title, raw }: { title: string; raw: string | null }) {
  const joined = title === 'Response' ? streamText(raw) : null
  const shown = joined ?? prettyJson(raw)
  return (
    <details className="group rounded-lg border border-line" open={title === 'Request'}>
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] font-medium">
        <FileJson className="size-4 text-faint" aria-hidden /> {title}
        {joined ? <Badge>joined from the stream</Badge> : null}
        <span className="num ml-auto text-xs text-faint">{bytes(raw?.length ?? 0)}</span>
        {raw ? <CopyButton value={raw} label={`Copy the ${title.toLowerCase()}`} size="xs" /> : null}
      </summary>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-line p-3 font-mono text-xs leading-relaxed text-muted scrollbar-thin">
        {shown || '(empty)'}
      </pre>
    </details>
  )
}

function Content({ r, now }: { r: RequestDetail | Flight; now: number }) {
  const live = !r.ended_at || (r as RequestDetail).live
  const ok = isOk(r)
  const reused = r.reused_tokens ?? 0
  const captured = (r as RequestDetail).captured
  return (
    <div className="grid gap-5 p-5">
      <PhaseBar f={r} now={now} />
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        {(
          [
            ['Prompt', `${int(r.prompt_tokens)}${reused ? ` (${int(reused)} reused)` : ''}`, 'tokens in; reused ones came from the conversation cache'],
            ['Answer', int(r.output_tokens), 'tokens out'],
            r.stream === false || r.stream === 0
              ? ['Whole answer', isNum(r.ttft_ms) ? ms(r.ttft_ms) : '—', 'not streamed: the app got the answer in one piece after this long']
              : ['First token', isNum(r.ttft_ms) ? ms(r.ttft_ms) : r.first_token_at ? dur(r.first_token_at - r.started_at) : '—', 'from the gateway passing it on to the first token'],
            ['Thinking', ms(r.think_ms), 'time spent on reasoning tokens'],
            ['Reading speed', isNum(r.prefill_tok_s) ? `${fixed(r.prefill_tok_s, 0)} tok/s` : '—', 'prefill'],
            ['Answer speed', tps(r.decode_tok_s), 'decode'],
            ['Experts in VRAM', pct(r.hit_rate), 'expert-cache hit rate: the share of needed experts already on the card'],
            ['Over PCIe', pct(r.pcie_share, 1), 'PCIe share'],
            ['Drafts kept', r.drafts_offered ? `${int(r.drafts_accepted)} of ${int(r.drafts_offered)}` : '—', 'MTP speculative tokens accepted'],
          ] as Array<[string, string, string]>
        ).map(([k, v, t]) => (
          <div key={k}>
            <Tip content={t}>
              <div className="text-[11px] text-faint">{k}</div>
            </Tip>
            <div className="num mt-0.5 text-[14px]">{v}</div>
          </div>
        ))}
      </div>
      <KV
        rows={[
          ['Status', <span key="s" className={ok ? 'text-ok' : 'text-error'}>{`${r.status ?? '—'} · ${outcomeText(r)}`}</span>],
          ['Endpoint', <span key="e" className="num">{`${r.method ?? ''} ${r.path ?? ''}`} <span className="text-faint">({dialect(r.path, r.listener)})</span></span>],
          ['Token', r.token ?? (r as RequestDetail).token_name ?? (r.auth === 'open' ? 'none (the API was open)' : r.auth === 'tokenless' ? 'none (token-less Ollama)' : '—')],
          ['From', <span key="f" className="num">{r.client_ip ?? '—'}</span>],
          ['User agent', <span key="u" className="break-all text-muted">{r.user_agent ?? '—'}</span>],
          ['Model, preset', `${r.model ?? '—'} · ${r.preset ?? '—'}`],
          ['Stream', r.stream === null || r.stream === undefined ? '—' : r.stream ? 'yes' : 'no'],
          ['Finish', r.finish ?? '—'],
          ['Bytes', `${bytes(r.bytes_in)} in · ${bytes(r.bytes_out)} out`],
          ['Started', dateTime(r.started_at)],
          ...(r.error ? ([['Error', <span key="err" className="text-error">{r.error}</span>]] as Array<[string, React.ReactNode]>) : []),
        ]}
      />
      {captured ? (
        <div className="grid gap-2">
          <div className="eyebrow">Captured (capture mode)</div>
          <Body title="Request" raw={captured.request} />
          <Body title="Response" raw={captured.response} />
        </div>
      ) : (
        <p className="text-xs text-faint">
          Prompts and answers are not kept. Capture mode (Settings) can keep them for a while, for debugging.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {live ? (
          <Button variant="danger-outline" size="sm" onClick={() => cancelRequest(r.rid)}>
            <Ban /> Cancel it
          </Button>
        ) : null}
        {r.app ? (
          <Button asChild variant="secondary" size="sm">
            <Link to="/requests" search={{ app: r.app }}>
              All requests from {r.app}
            </Link>
          </Button>
        ) : null}
        {r.token_id ? (
          <Button asChild variant="ghost" size="sm">
            <Link to="/access" search={{ token: r.token_id }}>
              The token
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** The request drawer: timings, engine figures, and captured bodies when capture mode was on. */
export function RequestDrawer({ rid, fallback, onClose }: { rid: string | null; fallback?: Flight | null; onClose: () => void }) {
  const q = useRequestDetail(rid)
  const now = useNow(1000)
  const r = (q.data ?? fallback ?? null) as RequestDetail | Flight | null
  const ok = r ? isOk(r) : true
  return (
    <Dialog open={!!rid} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="gap-0 p-0" data-testid="request-drawer">
        <div className="border-b border-line p-5 pr-12">
          <div className="flex items-center gap-2">
            {r && r.ended_at ? ok ? <CheckCircle2 className="size-4 text-ok" aria-hidden /> : <XCircle className="size-4 text-error" aria-hidden /> : null}
            <DialogTitle className="text-[15px] font-semibold">{r?.app ?? 'Request'}</DialogTitle>
            {r && !r.ended_at ? <Badge tone="answer">in flight</Badge> : null}
          </div>
          <DialogDescription className="num mt-1 flex items-center gap-2 text-xs text-faint">
            {rid}
            {rid ? <CopyButton value={rid} label="Copy the request ID" size="xs" /> : null}
            {r ? <span>· {dateTime(r.started_at)}</span> : null}
            {r?.prompt_tokens ? <span>· {compact(r.prompt_tokens)} in</span> : null}
          </DialogDescription>
        </div>
        {r ? <Content r={r} now={now} /> : q.isError ? <p className="p-5 text-[13px] text-muted">This request is not in the log (yet).</p> : <div className="p-5 text-[13px] text-muted">Loading…</div>}
      </SheetContent>
    </Dialog>
  )
}
