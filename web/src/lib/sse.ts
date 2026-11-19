// Server-sent events from the playground (the model's OpenAI chat-completions stream, passed through by the console):
// a line parser, and a reducer that folds the chunks into one assistant message (thinking, answer, tool calls, usage).

/** Splits an SSE byte stream (decoded to text) into `data:` payloads; ignores comments (": keep-alive") and other fields. */
export class SSEParser {
  private buf = ''
  private data: string[] = []
  constructor(private onData: (data: string) => void) {}

  feed(text: string): void {
    this.buf += text
    let i: number
    // Lines end with \n, \r\n or \r.
    while ((i = this.nextBreak()) >= 0) {
      const line = this.buf.slice(0, i)
      const skip = this.buf[i] === '\r' && this.buf[i + 1] === '\n' ? 2 : 1
      this.buf = this.buf.slice(i + skip)
      this.line(line)
    }
  }

  /** The end of the stream: dispatch what is pending (a last event without its blank line). */
  end(): void {
    if (this.buf) {
      this.line(this.buf)
      this.buf = ''
    }
    this.dispatch()
  }

  private nextBreak(): number {
    const n = this.buf.indexOf('\n')
    const r = this.buf.indexOf('\r')
    if (r >= 0 && r === this.buf.length - 1) {
      // a lone \r at the end may be the first half of \r\n: wait for more
      return n >= 0 && n < r ? n : -1
    }
    if (n < 0) return r
    if (r < 0) return n
    return Math.min(n, r)
  }

  private line(line: string): void {
    if (line === '') {
      this.dispatch()
      return
    }
    if (line.startsWith(':')) return
    const c = line.indexOf(':')
    const field = c < 0 ? line : line.slice(0, c)
    let value = c < 0 ? '' : line.slice(c + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
  }

  private dispatch(): void {
    if (!this.data.length) return
    const d = this.data.join('\n')
    this.data = []
    this.onData(d)
  }
}

// ----------------------------------------------------------------------------------------------- the message state
export interface ToolCall {
  index: number
  id?: string
  type?: string
  name: string
  arguments: string
}

export interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** llama.cpp-style timings that Strata adds to the last chunk. */
export interface Timings {
  cache_n?: number
  prompt_n?: number
  prompt_ms?: number
  prompt_per_second?: number
  predicted_n?: number
  predicted_ms?: number
  predicted_per_second?: number
  draft_n?: number
  draft_n_accepted?: number
}

export type StreamPhase = 'waiting' | 'thinking' | 'answering' | 'done'

export interface StreamState {
  thinking: string
  content: string
  toolCalls: ToolCall[]
  phase: StreamPhase
  /** chunks that carried text (thinking or answer), for a live rate */
  chunks: number
  thinkChunks: number
  firstTokenAt: number | null
  answerAt: number | null
  thinkingEndedAt: number | null
  endedAt: number | null
  finish: string | null
  usage: Usage | null
  timings: Timings | null
  model: string | null
  error: string | null
}

export const emptyStream = (): StreamState => ({
  thinking: '',
  content: '',
  toolCalls: [],
  phase: 'waiting',
  chunks: 0,
  thinkChunks: 0,
  firstTokenAt: null,
  answerAt: null,
  thinkingEndedAt: null,
  endedAt: null,
  finish: null,
  usage: null,
  timings: null,
  model: null,
  error: null,
})

interface Delta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>
}

interface Chunk {
  model?: string
  choices?: Array<{ index?: number; delta?: Delta; message?: Delta; finish_reason?: string | null }>
  usage?: Usage | null
  timings?: Timings | null
  error?: { message?: string } | string
}

/** Fold one `data:` payload into the state (returns a new object; the input is not changed). */
export function applyData(s: StreamState, data: string, now: number): StreamState {
  if (data === '[DONE]') return { ...s, phase: 'done', endedAt: s.endedAt ?? now }
  let c: Chunk
  try {
    c = JSON.parse(data) as Chunk
  } catch {
    return s
  }
  return applyChunk(s, c, now)
}

export function applyChunk(s: StreamState, c: Chunk, now: number): StreamState {
  const out: StreamState = { ...s }
  if (c.error) {
    out.error = typeof c.error === 'string' ? c.error : c.error.message || 'the model reported an error'
    out.phase = 'done'
    out.endedAt = out.endedAt ?? now
    return out
  }
  if (c.model && !out.model) out.model = c.model
  const ch = c.choices?.[0]
  const d = ch?.delta ?? ch?.message
  if (d) {
    const think = d.reasoning_content ?? d.reasoning ?? null
    if (think) {
      out.thinking = s.thinking + think
      out.chunks = s.chunks + 1
      out.thinkChunks = s.thinkChunks + 1
      if (out.firstTokenAt === null) out.firstTokenAt = now
      if (out.phase === 'waiting') out.phase = 'thinking'
    }
    if (d.content) {
      out.content = s.content + d.content
      out.chunks = out.chunks + (think ? 0 : 1)
      if (out.firstTokenAt === null) out.firstTokenAt = now
      if (out.answerAt === null) out.answerAt = now
      if (s.phase === 'thinking' && out.thinkingEndedAt === null) out.thinkingEndedAt = now
      if (out.phase !== 'done') out.phase = 'answering'
    }
    if (d.tool_calls?.length) {
      const calls = s.toolCalls.map((t) => ({ ...t }))
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? calls.length
        let t = calls.find((x) => x.index === idx)
        if (!t) {
          t = { index: idx, name: '', arguments: '' }
          calls.push(t)
        }
        if (tc.id) t.id = tc.id
        if (tc.type) t.type = tc.type
        if (tc.function?.name) t.name += tc.function.name
        if (tc.function?.arguments) t.arguments += tc.function.arguments
      }
      out.toolCalls = calls
      if (out.firstTokenAt === null) out.firstTokenAt = now
      if (s.phase === 'thinking' && out.thinkingEndedAt === null) out.thinkingEndedAt = now
      if (out.phase !== 'done') out.phase = 'answering'
    }
  }
  if (ch?.finish_reason) out.finish = ch.finish_reason
  if (c.usage) out.usage = c.usage
  if (c.timings) out.timings = c.timings
  return out
}

/** The end of the stream (or of a non-streamed answer). */
export function finishStream(s: StreamState, now: number): StreamState {
  return {
    ...s,
    phase: 'done',
    endedAt: s.endedAt ?? now,
    thinkingEndedAt: s.thinkingEndedAt ?? (s.thinking && s.phase === 'thinking' ? now : s.thinkingEndedAt),
  }
}

/** Answer speed: the engine's own figure when it sent timings, else completion tokens over the time since the first. */
export function answerRate(s: StreamState, now: number): number | null {
  if (s.timings?.predicted_per_second) return s.timings.predicted_per_second
  if (s.firstTokenAt === null) return null
  const end = s.endedAt ?? now
  const dt = end - s.firstTokenAt
  if (dt < 0.4) return null
  const n = s.usage?.completion_tokens ?? s.chunks
  return n > 1 ? (n - 1) / dt : null
}

/** The human message inside an error body: {"error": "..."}, {"error": {"message": "..."}}, {"detail": "..."}. */
export function errorText(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) {
    try {
      return errorText(JSON.parse(body), body.slice(0, 300))
    } catch {
      return body.slice(0, 300)
    }
  }
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.error === 'string') return b.error
    if (b.error && typeof b.error === 'object' && typeof (b.error as { message?: unknown }).message === 'string')
      return (b.error as { message: string }).message
    if (typeof b.detail === 'string') return b.detail
    if (b.detail && typeof b.detail === 'object' && typeof (b.detail as { message?: unknown }).message === 'string')
      return (b.detail as { message: string }).message
    if (typeof b.message === 'string') return b.message
  }
  return fallback
}
