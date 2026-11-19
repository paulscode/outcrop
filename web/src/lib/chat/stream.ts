// Following an answer as the console writes it: GET /api/chats/{id}/stream (server-sent events), read with fetch so it
// can be stopped, opened again when the connection breaks (a fresh snapshot), and folded into one LiveAnswer.

import { useEffect, useRef, useState } from 'react'
import { unauthorized } from '../api'
import { queryClient } from '../queries'
import { SSEParser } from '../sse'
import { ck } from './data'
import { emptyLive, reduceStream, type LiveAnswer } from './logic'
import type { StreamEvent } from './types'

const END = new Set(['done', 'stopped', 'error', 'idle'])

/**
 * Read the stream once, until it ends or breaks.  Returns true when it ended (an end event, or the chat is gone), false
 * when it broke, and 'refused' when the server will not send it (a 403): opening it again would only be refused again.
 */
export async function readStream(chatId: string, onEvent: (ev: StreamEvent) => void, signal: AbortSignal): Promise<boolean | 'refused'> {
  const r = await fetch(`/api/chats/${encodeURIComponent(chatId)}/stream`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'text/event-stream' },
    signal,
  })
  if (r.status === 404) return true
  if (r.status === 401) {
    // the session ended: retrying would never succeed
    unauthorized()
    return true
  }
  if (r.status === 403) return 'refused'
  if (!r.ok || !r.body) throw new Error(`${r.status}`)
  // the server's time, for the clocks' difference (its times in the snapshot are on its clock)
  const date = Date.parse(r.headers.get('date') ?? '')
  const serverNow = Number.isFinite(date) ? date / 1000 : undefined
  let ended = false
  const parser = new SSEParser((d) => {
    try {
      const ev = JSON.parse(d) as StreamEvent
      if (ev.type === 'snapshot' && serverNow !== undefined) ev.server_now = serverNow
      if (END.has(ev.type) || (ev.type === 'snapshot' && ev.status && ev.status !== 'streaming')) ended = true
      onEvent(ev)
    } catch {
      /* not JSON */
    }
  })
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    parser.feed(dec.decode(value, { stream: true }))
    if (ended) {
      void reader.cancel().catch(() => {})
      break
    }
  }
  parser.feed(dec.decode())
  parser.end()
  return ended
}

/**
 * The answer being written in a chat, live.  Attaches while `running` (the chat says an answer is being written, here or on
 * another device), catches up from the snapshot, and when it ends reloads the chat for the final message.
 */
export function useAnswerStream(chatId: string | null, running: boolean): LiveAnswer | null {
  const [state, setState] = useState<LiveAnswer | null>(null)
  const ctrl = useRef<AbortController | null>(null)
  // bumped when a stream ends, so a turn asked meanwhile is followed too
  const [gen, setGen] = useState(0)

  // a different chat: stop following the last one
  useEffect(() => {
    setState(null)
    return () => {
      ctrl.current?.abort()
      ctrl.current = null
    }
  }, [chatId])

  // start following when an answer is being written (it then runs to its end, even if `running` turns false first)
  useEffect(() => {
    if (!chatId || !running || ctrl.current) return
    const ac = new AbortController()
    ctrl.current = ac
    let s = emptyLive()
    let timer: ReturnType<typeof setTimeout> | null = null
    let last = 0
    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = null
      last = performance.now()
      if (!ac.signal.aborted) setState(s)
    }
    const onEvent = (ev: StreamEvent) => {
      s = reduceStream(s, ev, Date.now() / 1000)
      // long answers re-render less often (Markdown, math and code are drawn again each time)
      const every = s.content.length > 6000 ? 160 : 50
      if (ev.type !== 'delta' || performance.now() - last >= every) flush()
      else if (!timer) timer = setTimeout(flush, every)
    }
    void (async () => {
      let delay = 500
      let refused = false
      while (!ac.signal.aborted) {
        try {
          const r = await readStream(chatId, onEvent, ac.signal)
          if (r === 'refused') {
            refused = true
            break
          }
          if (r) break
          delay = 500
        } catch {
          if (ac.signal.aborted) return
        }
        // broke off: open it again (a fresh snapshot replaces what is here)
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 8000)
      }
      if (ac.signal.aborted) return
      if (refused) {
        // not followed live: the chat's live events still say when the answer is done (and reload it); the next turn
        // (running again) tries once more
        if (ctrl.current === ac) {
          ctrl.current = null
          setState(null)
        }
        return
      }
      flush()
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ck.chat(chatId) }),
        queryClient.invalidateQueries({ queryKey: ck.list }),
      ]).catch(() => {})
      if (ctrl.current === ac) {
        ctrl.current = null
        setState(null)
        setTimeout(() => setGen((g) => g + 1), 300)
      }
    })()
  }, [chatId, running, gen])

  return state
}
