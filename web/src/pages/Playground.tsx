import { Link } from '@tanstack/react-router'
import { Columns2, MessageSquareText, MessageSquarePlus, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { buildBody, DEFAULT_PARAMS, uid, type AssistantMsg, type Msg, type Params, type UserMsg } from '@/lib/playground'
import { useServerState } from '@/lib/queries'
import { emptyStream } from '@/lib/sse'
import type { RequestDetail } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { Dialog, DialogTitle, SheetContent } from '@/components/ui/dialog'
import { Empty, LiveRegion, Panel } from '@/components/ui/misc'
import { CodeView } from '@/components/playground/CodeView'
import { Composer } from '@/components/playground/Composer'
import { AssistantMessage, UserMessage } from '@/components/playground/Message'
import { ParamsForm, summary } from '@/components/playground/Params'
import { ChatError, streamChat } from '@/components/playground/stream'

type ColId = 'A' | 'B'
interface Col {
  params: Params
  messages: Msg[]
}

const PKEY = 'outcrop.playground'

function loadParams(): Record<ColId, Params> {
  const b = { ...DEFAULT_PARAMS, thinking: false, temperature: 0.7, topP: 0.8 }
  try {
    const v = JSON.parse(localStorage.getItem(PKEY) || '{}') as Partial<Record<ColId, Partial<Params>>>
    return { A: { ...DEFAULT_PARAMS, ...v.A }, B: { ...b, ...v.B } }
  } catch {
    return { A: DEFAULT_PARAMS, B: b }
  }
}

const SUGGESTIONS = [
  'Explain what an expert cache is, in two sentences.',
  'Write a Python function that merges overlapping intervals, with a short test.',
  'What is the integral of x² from 0 to 3? Show the steps with LaTeX.',
  'Compare TCP and UDP in a small table.',
]

export default function Playground() {
  const { data: st } = useServerState()
  const model = st?.server.model_id ?? 'qwen3.8-flash-next'
  const baseUrl = st?.urls.openai ?? `http://${location.hostname}:8080/v1`

  const [cols, setCols] = useState<Record<ColId, Col>>(() => {
    const p = loadParams()
    return { A: { params: p.A, messages: [] }, B: { params: p.B, messages: [] } }
  })
  const colsRef = useRef(cols)
  colsRef.current = cols
  const [compare, setCompare] = useState(false)
  const [editing, setEditing] = useState<ColId>('A')
  const [draft, setDraft] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [records, setRecords] = useState<Record<string, RequestDetail>>({})
  const [sheet, setSheet] = useState(false)
  const [announce, setAnnounce] = useState('')
  const ctrl = useRef<AbortController | null>(null)
  const stopped = useRef(false)
  const phases = useRef<Record<string, string>>({})
  const stick = useRef(true)

  useEffect(() => {
    try {
      localStorage.setItem(PKEY, JSON.stringify({ A: cols.A.params, B: cols.B.params }))
    } catch {
      /* private mode */
    }
  }, [cols.A.params, cols.B.params])

  // Leaving the page stops the answer (the gateway then cancels it in the engine).
  useEffect(
    () => () => {
      stopped.current = true
      ctrl.current?.abort()
    },
    [],
  )

  // Follow the answer while the reader is at the bottom of the page.
  useEffect(() => {
    const onScroll = () => {
      stick.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    if (busy && stick.current) window.scrollTo({ top: document.documentElement.scrollHeight })
  }, [cols, busy])

  const patch = useCallback((c: ColId, id: string, fn: (m: AssistantMsg) => AssistantMsg) => {
    setCols((prev) => ({
      ...prev,
      [c]: { ...prev[c], messages: prev[c].messages.map((m) => (m.id === id && m.role === 'assistant' ? fn(m) : m)) },
    }))
  }, [])

  const say = useCallback((id: string, phase: string, text: string) => {
    if (phases.current[id] === phase) return
    phases.current[id] = phase
    setAnnounce(text)
  }, [])

  const fetchRecord = useCallback((id: string, rid: string) => {
    const delays = [1200, 3000, 7000, 15000]
    const attempt = async (i: number) => {
      try {
        const r = await api.get<RequestDetail>(`/api/requests/${encodeURIComponent(rid)}`)
        if (!r.live) setRecords((p) => ({ ...p, [id]: r }))
        if ((r.live || r.hit_rate == null) && i + 1 < delays.length) setTimeout(() => attempt(i + 1), delays[i + 1])
      } catch (e) {
        if (e instanceof ApiError && e.status === 404 && i + 1 < delays.length) setTimeout(() => attempt(i + 1), delays[i + 1])
      }
    }
    setTimeout(() => attempt(0), delays[0])
  }, [])

  /** Run one queued answer: its column's conversation up to it, with its column's settings. */
  const runOne = useCallback(
    async (c: ColId, id: string, history: Msg[], params: Params, label: string) => {
      const body = buildBody(params, history, model)
      const startedAt = Date.now() / 1000
      patch(c, id, (m) => ({ ...m, status: 'waiting', startedAt, s: emptyStream() }))
      say(id, 'waiting', `${label}: reading the prompt`)
      const ac = new AbortController()
      ctrl.current = ac
      try {
        const res = await streamChat(body, {
          signal: ac.signal,
          onRid: (rid) => patch(c, id, (m) => ({ ...m, rid })),
          onUpdate: (s) => {
            patch(c, id, (m) => ({ ...m, s, status: m.status === 'waiting' && s.firstTokenAt ? 'streaming' : m.status }))
            if (s.phase === 'thinking') say(id, 'thinking', `${label}: thinking`)
            else if (s.phase === 'answering') say(id, 'answering', `${label}: answering`)
          },
        })
        const status = res.aborted ? 'stopped' : res.state.error ? 'error' : 'done'
        patch(c, id, (m) => ({ ...m, s: res.state, status, rid: res.rid ?? m.rid, error: res.state.error ?? undefined }))
        const n = res.state.usage?.completion_tokens
        say(id, status, status === 'done' ? `${label}: done${n ? `, ${n} tokens` : ''}` : status === 'stopped' ? `${label}: stopped` : `${label}: failed`)
        if (res.rid) fetchRecord(id, res.rid)
      } catch (e) {
        const err = e instanceof ChatError ? e : new ChatError(0, (e as Error).message || 'failed', null)
        if (err.missing) setUnavailable(err.message)
        patch(c, id, (m) => ({ ...m, status: 'error', error: err.missing ? 'This console has no playground endpoint yet.' : err.message, rid: err.rid ?? m.rid }))
        say(id, 'error', `${label}: failed`)
      } finally {
        if (ctrl.current === ac) ctrl.current = null
      }
    },
    [model, patch, say, fetchRecord],
  )

  const which: ColId[] = compare ? ['A', 'B'] : ['A']

  const send = async (textArg?: string) => {
    const text = (textArg ?? draft).trim()
    if ((!text && !images.length) || busy) return
    const user: UserMsg = { id: uid(), role: 'user', text, images }
    const next = { ...colsRef.current }
    const jobs: Array<{ c: ColId; id: string; history: Msg[]; params: Params }> = []
    for (const c of which) {
      const aid = uid()
      const params = next[c].params
      const history = [...next[c].messages, { ...user }]
      const asst: AssistantMsg = { id: aid, role: 'assistant', status: 'queued', s: emptyStream(), startedAt: null, rid: null, params }
      next[c] = { ...next[c], messages: [...history, asst] }
      jobs.push({ c, id: aid, history, params })
    }
    colsRef.current = next
    setCols(next)
    setDraft('')
    setImages([])
    stopped.current = false
    stick.current = true
    setBusy(true)
    for (const j of jobs) {
      if (stopped.current) {
        patch(j.c, j.id, (m) => ({ ...m, status: 'stopped' }))
        continue
      }
      await runOne(j.c, j.id, j.history, j.params, compare ? `Answer ${j.c}` : 'The answer')
    }
    setBusy(false)
  }

  const stop = () => {
    stopped.current = true
    ctrl.current?.abort()
  }

  const retry = async (c: ColId, id: string) => {
    if (busy) return
    const msgs = colsRef.current[c].messages
    const i = msgs.findIndex((m) => m.id === id)
    if (i < 0) return
    stopped.current = false
    setBusy(true)
    await runOne(c, id, msgs.slice(0, i), colsRef.current[c].params, compare ? `Answer ${c}` : 'The answer')
    setBusy(false)
  }

  /** The user's results for a message's tool calls: kept on that message, then the model continues from them. */
  const answerTools = async (c: ColId, id: string, results: string[]) => {
    if (busy) return
    const msgs = colsRef.current[c].messages
    const i = msgs.findIndex((m) => m.id === id)
    if (i < 0 || i !== msgs.length - 1) return
    const prev = msgs[i] as AssistantMsg
    const params = colsRef.current[c].params
    const asst: AssistantMsg = { id: uid(), role: 'assistant', status: 'queued', s: emptyStream(), startedAt: null, rid: null, params }
    const history = [...msgs.slice(0, i), { ...prev, toolResults: results }]
    const next = { ...colsRef.current, [c]: { ...colsRef.current[c], messages: [...history, asst] } }
    colsRef.current = next
    setCols(next)
    stopped.current = false
    stick.current = true
    setBusy(true)
    await runOne(c, asst.id, history, params, compare ? `Answer ${c}` : 'The answer')
    setBusy(false)
  }

  const reset = () => {
    setCols((p) => ({ A: { ...p.A, messages: [] }, B: { ...p.B, messages: [] } }))
    setRecords({})
    phases.current = {}
  }

  const toggleCompare = (on: boolean) => {
    if (on && !cols.B.messages.length && cols.A.messages.length) {
      // B continues the same conversation; only the settings differ from here on
      setCols((p) => ({
        ...p,
        B: { ...p.B, messages: p.A.messages.filter((m) => m.role === 'user' || m.status === 'done' || m.status === 'stopped') },
      }))
    }
    setCompare(on)
    if (!on) setEditing('A')
  }

  const setParams = (p: Params) => setCols((prev) => ({ ...prev, [editing]: { ...prev[editing], params: p } }))

  // The request the next message would make (for "View as code").
  const nextBody = useMemo(() => {
    const c = cols[editing]
    const preview: UserMsg = { id: 'preview', role: 'user', text: draft.trim() || 'Your message', images }
    return buildBody(c.params, [...c.messages, preview], model)
  }, [cols, editing, draft, images, model])

  const empty = !cols.A.messages.length && (!compare || !cols.B.messages.length)

  if (unavailable) {
    return (
      <Panel>
        <Empty icon={<MessageSquareText />} title="The playground is not on this server yet">
          This console's backend has no <code className="text-xs">/api/playground/chat</code>. Update the console (
          <code className="text-xs">setup/deploy.sh</code> on the server) and reload. Meanwhile,{' '}
          <Link to="/strata" className="link">
            Strata's own chat page
          </Link>{' '}
          works.
        </Empty>
      </Panel>
    )
  }

  const params = cols[editing].params

  const thread = (c: ColId) => (
    <section className="grid min-w-0 grid-cols-1 content-start gap-6" aria-label={compare ? `Answer ${c}` : 'Conversation'}>
      {compare ? (
        <div className="sticky top-14 z-[5] -mx-1 flex items-center gap-2 border-b border-line bg-bg/90 px-1 py-2 backdrop-blur">
          <span className="flex size-6 items-center justify-center rounded-md border border-line-strong bg-panel-2 text-xs font-semibold">{c}</span>
          <span className="num truncate text-xs text-muted">{summary(cols[c].params)}</span>
          <Button
            size="xs"
            variant={editing === c ? 'secondary' : 'ghost'}
            className="ml-auto"
            onClick={() => {
              setEditing(c)
              if (window.matchMedia('(max-width: 1023px)').matches) setSheet(true)
            }}
          >
            <SlidersHorizontal aria-hidden /> Settings
          </Button>
        </div>
      ) : null}
      {cols[c].messages.map((m, i, all) =>
        m.role === 'user' ? (
          <UserMessage key={m.id} m={m} />
        ) : (
          <AssistantMessage
            key={m.id}
            m={m}
            record={records[m.id] ?? null}
            onRetry={() => retry(c, m.id)}
            onToolResults={i === all.length - 1 ? (r) => void answerTools(c, m.id, r) : undefined}
            busy={busy}
            label={compare ? `Answer ${c}` : undefined}
          />
        ),
      )}
    </section>
  )

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <LiveRegion message={announce} />
      <div className="flex min-h-[calc(100dvh-8.5rem)] min-w-0 flex-col">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Segmented
            label="Answers"
            value={compare ? 'two' : 'one'}
            onValueChange={(v) => toggleCompare(v === 'two')}
            options={[
              { value: 'one', label: 'One answer', disabled: busy },
              {
                value: 'two',
                label: (
                  <>
                    <Columns2 aria-hidden /> Compare two
                  </>
                ),
                disabled: busy,
              },
            ]}
          />
          <span className="ml-auto flex items-center gap-2">
            <CodeView body={nextBody} baseUrl={baseUrl} disabled={!!unavailable} />
            <Button variant="outline" size="sm" className="lg:hidden" onClick={() => setSheet(true)}>
              <SlidersHorizontal aria-hidden /> Settings
            </Button>
            <Button variant="ghost" size="sm" onClick={reset} disabled={busy || empty} aria-label="New conversation">
              <MessageSquarePlus aria-hidden /> <span className="hidden sm:inline">New conversation</span>
            </Button>
          </span>
        </div>

        <div className="flex-1">
          {empty ? (
            <div className="mx-auto grid max-w-2xl gap-5 py-6 text-center sm:py-12">
              <div>
                <p className="text-[15px] font-medium text-fg">Talk to the model directly.</p>
                <p className="mx-auto mt-1.5 max-w-lg text-[13px] leading-relaxed text-muted">
                  Messages go through the gateway like any app's and show up on Live and Requests as “Console”.
                  {compare ? ' Each message goes to A, then to B, each with its own settings: the server answers one request at a time.' : ''}
                </p>
                <p className="mx-auto mt-1.5 max-w-lg text-[13px] leading-relaxed text-muted">
                  This is the model as your apps see it: no web search, nothing saved. For everyday questions, with web search
                  and saved conversations, use{' '}
                  <Link to="/chat" className="link">
                    Chat
                  </Link>
                  .
                </p>
              </div>
              <ul className="grid gap-2 text-left sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      onClick={() => void send(s)}
                      disabled={busy}
                      className="h-full w-full rounded-lg border border-line bg-panel px-3.5 py-3 text-left text-[13px] leading-snug text-muted transition-colors hover:border-line-strong hover:bg-panel-2 hover:text-fg"
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : compare ? (
            <div className="grid grid-cols-1 gap-8 xl:grid-cols-2 xl:gap-6">
              {thread('A')}
              {thread('B')}
            </div>
          ) : (
            <div className="mx-auto w-full max-w-3xl">{thread('A')}</div>
          )}
        </div>

        <div
          className={cn(
            'sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 mt-6 bg-gradient-to-t from-bg from-60% to-transparent pb-3 pt-6 md:bottom-0 md:pb-5',
            !compare && 'mx-auto w-full max-w-3xl',
          )}
        >
          <Composer
            value={draft}
            onChange={setDraft}
            images={images}
            setImages={setImages}
            onSend={() => void send()}
            onStop={stop}
            busy={busy}
            disabled={!!unavailable}
            placeholder={compare ? 'Ask both…' : 'Ask anything…'}
          />
        </div>
      </div>

      <aside className="hidden lg:block" aria-label="Settings">
        <Panel className="sticky top-[4.5rem] overflow-hidden">
          <ParamsForm value={params} onChange={setParams} compare={compare} editing={editing} setEditing={setEditing} disabled={busy} />
        </Panel>
      </aside>

      <Dialog open={sheet} onOpenChange={setSheet}>
        <SheetContent side="bottom" aria-describedby={undefined} className="lg:hidden" onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <ParamsForm value={params} onChange={setParams} compare={compare} editing={editing} setEditing={setEditing} disabled={busy} inSheet />
        </SheetContent>
      </Dialog>
    </div>
  )
}
