// One playground request: POST /api/playground/chat (the console passes it to the gateway with its own token, and passes the
// model's SSE stream back), read as it arrives.

import { api } from '@/lib/api'
import { applyData, emptyStream, errorText, finishStream, SSEParser, type StreamState } from '@/lib/sse'

export class ChatError extends Error {
  status: number
  rid: string | null
  constructor(status: number, message: string, rid: string | null) {
    super(message)
    this.status = status
    this.rid = rid
  }
  /** The console's backend has no playground endpoint (404 from the API, 405 from the page catch-all). */
  get missing() {
    return this.status === 404 || this.status === 405
  }
}

export interface StreamResult {
  state: StreamState
  rid: string | null
  aborted: boolean
}

const now = () => Date.now() / 1000

/**
 * Send `body` and stream the answer.  `onUpdate` is called at most every `everyMs` while text arrives (and once at the
 * end); `onRid` as soon as the gateway's request ID is known.
 */
export async function streamChat(
  body: Record<string, unknown>,
  opts: { signal: AbortSignal; onUpdate: (s: StreamState) => void; onRid?: (rid: string | null) => void; everyMs?: number },
): Promise<StreamResult> {
  const base = opts.everyMs ?? 80
  // long answers re-render less often (markdown, math and code are rendered again on each update)
  const every = () => (s.content.length > 6000 ? base * 3 : base)
  let r: Response
  try {
    r = await fetch('/api/playground/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Outcrop': '1', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: opts.signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { state: finishStream(emptyStream(), now()), rid: null, aborted: true }
    throw new ChatError(0, 'the console is not answering (network error)', null)
  }
  const rid = r.headers.get('x-request-id')
  opts.onRid?.(rid)
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    if (r.status === 401) {
      // the session ended: the shared handler takes the browser to the sign-in page
      void api.get('/api/auth/session').catch(() => {})
    }
    throw new ChatError(r.status, errorText(text, `${r.status} ${r.statusText || 'error'}`), rid)
  }

  let s = emptyStream()
  const ct = r.headers.get('content-type') || ''
  if (!ct.includes('event-stream') || !r.body) {
    // a whole answer at once (stream: false, or an error body with status 200)
    const text = await r.text()
    s = finishStream(applyData(s, text, now()), now())
    opts.onUpdate(s)
    return { state: s, rid, aborted: false }
  }

  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    last = performance.now()
    opts.onUpdate(s)
  }
  const parser = new SSEParser((d) => {
    s = applyData(s, d, now())
  })
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let aborted = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      parser.feed(dec.decode(value, { stream: true }))
      const t = performance.now()
      if (t - last >= every()) flush()
      else if (!timer) timer = setTimeout(flush, every())
    }
    parser.feed(dec.decode())
    parser.end()
  } catch (e) {
    if ((e as Error).name === 'AbortError' || opts.signal.aborted) aborted = true
    else s = { ...s, error: s.error ?? `the stream broke off (${(e as Error).message || 'network error'})` }
  }
  s = finishStream(s, now())
  flush()
  return { state: s, rid, aborted }
}
