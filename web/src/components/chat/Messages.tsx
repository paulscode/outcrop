// The conversation's messages: your questions (editable, with versions), the answers with their thinking, the web tool
// calls drawn where they ran, citation pills with a card, the sources row, the footer, and the live phase line.

import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  ExternalLink,
  FileText,
  Globe,
  Hand,
  Loader2,
  Pencil,
  RotateCcw,
  ScrollText,
  Search,
  ShieldX,
  X,
} from 'lucide-react'
import { HoverCard as HC } from 'radix-ui'
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { answerTool } from '@/lib/chat/data'
import { citedNumbers, citedSources, citeOf, hostOf, interleave, linkCitations, safeHref, toolLine, waitDeadline, type LiveAnswer } from '@/lib/chat/logic'
import type { Message, Source, ToolCall } from '@/lib/chat/types'
import { fixed, int, isNum } from '@/lib/format'
import { gatewayStore, metricsStore, riverStore } from '@/lib/live'
import { activeRid, inflightList, isGenerating, liveRate } from '@/lib/requests'
import { shallow, useStore } from '@/lib/store'
import { cn, useNow } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Tip } from '@/components/ui/menu'
import { CopyButton } from '@/components/ui/misc'
import { Monogram } from './bits'

const Markdown = lazy(() => import('@/components/playground/Markdown'))

function Plain({ text }: { text: string }) {
  return <div className="whitespace-pre-wrap text-[14px] leading-[1.7] text-fg">{text}</div>
}

// ------------------------------------------------------------------------------------------------------ versions
export function Versions({ m, onPick, disabled }: { m: Message; onPick: (id: string) => void; disabled?: boolean }) {
  const v = m.versions
  if (!v || v.count < 2) return null
  const go = (d: number) => {
    const i = v.index + d
    if (i >= 0 && i < v.count) onPick(v.ids[i])
  }
  return (
    <span className="inline-flex items-center text-xs text-faint" data-testid="versions">
      <button type="button" onClick={() => go(-1)} disabled={disabled || v.index === 0} className="rounded p-1 hover:bg-panel-2 hover:text-fg disabled:opacity-40" aria-label="The previous version">
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="num min-w-[3.2em] text-center" aria-live="polite">
        {v.index + 1} / {v.count}
      </span>
      <button type="button" onClick={() => go(1)} disabled={disabled || v.index >= v.count - 1} className="rounded p-1 hover:bg-panel-2 hover:text-fg disabled:opacity-40" aria-label="The next version">
        <ChevronRight className="size-3.5" />
      </button>
    </span>
  )
}

// ---------------------------------------------------------------------------------------------------- questions
export const UserBubble = memo(function UserBubble({
  m,
  busy,
  onEdit,
  onPick,
  highlight,
}: {
  m: Message
  busy: boolean
  onEdit: (text: string) => void
  onPick: (id: string) => void
  highlight?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.content)
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (editing) {
      ta.current?.focus()
      ta.current?.setSelectionRange(draft.length, draft.length)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])
  const save = () => {
    const t = draft.trim()
    // a question can be only pictures: its text may be empty, the pictures go with it
    if ((!t && !m.images.length) || busy) return
    setEditing(false)
    if (t !== m.content.trim()) onEdit(t)
  }
  return (
    <div className={cn('group/u flex flex-col items-end gap-1 scroll-mt-24', highlight && 'chat-flash')} data-msg-id={m.id}>
      {editing ? (
        <div className="grid w-full max-w-[min(100%,640px)] gap-2 rounded-2xl border border-focus/60 bg-panel-2 p-2">
          <label htmlFor={`edit-${m.id}`} className="sr-only">
            Edit your question
          </label>
          <Textarea
            id={`edit-${m.id}`}
            ref={ta}
            value={draft}
            rows={Math.min(10, Math.max(2, draft.split('\n').length))}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(false)
                setDraft(m.content)
              } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                save()
              }
            }}
            className="resize-none border-0 bg-transparent text-[14px]"
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto pl-1 text-[11px] text-faint">Sends it again as a new version; the earlier one is kept.</span>
            <Button size="xs" variant="ghost" onClick={() => (setEditing(false), setDraft(m.content))}>
              Cancel
            </Button>
            <Button size="xs" variant="primary" onClick={save} disabled={busy || (!draft.trim() && !m.images.length)}>
              Send
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid max-w-[min(85%,640px)] gap-2 rounded-2xl rounded-br-md border border-line-strong bg-panel-3 px-4 py-2.5">
          {m.images.length ? (
            <div className="flex flex-wrap gap-2">
              {m.images.map((src, i) => (
                <img key={i} src={src} alt={`attached picture ${i + 1}`} className="max-h-40 rounded-lg border border-line object-contain" />
              ))}
            </div>
          ) : null}
          {m.content ? <div className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-fg">{m.content}</div> : null}
        </div>
      )}
      {!editing ? (
        <div className="flex h-7 items-center gap-0.5 text-faint opacity-100 transition-opacity sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover/u:opacity-100">
          <Versions m={m} onPick={onPick} disabled={busy} />
          <Tip content="Edit and send again (a new version)">
            <button
              type="button"
              onClick={() => (setDraft(m.content), setEditing(true))}
              disabled={busy}
              className="rounded-md p-1.5 hover:bg-panel-2 hover:text-fg disabled:opacity-40"
              aria-label="Edit this question"
            >
              <Pencil className="size-3.5" />
            </button>
          </Tip>
          <CopyButton value={m.content} label="Copy the question" size="xs" className="border-0 bg-transparent" />
        </div>
      ) : null}
    </div>
  )
})

/** The summary a continued chat starts from. */
export function NoteCard({ m }: { m: Message }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-panel/60 px-4 py-3" data-msg-id={m.id}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 text-left text-[13px]">
        <ScrollText className="size-4 text-faint" aria-hidden />
        <span className="font-medium text-fg">Continued from a summary</span>
        <span className="text-xs text-faint">the model starts from this note, not the whole earlier chat</span>
        <ChevronDown className={cn('ml-auto size-4 text-faint transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open ? (
        <Suspense fallback={<Plain text={m.content} />}>
          <Markdown text={m.content} className="mt-2 text-[13px] text-muted" />
        </Suspense>
      ) : null}
    </div>
  )
}

// --------------------------------------------------------------------------------------------------- thinking
function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const isOpen = open ?? live
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (live && isOpen && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [text, live, isOpen])
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  return (
    <div className="rounded-lg border border-think/25 bg-think-bg/50">
      <button type="button" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]">
        <Brain className={cn('size-4 text-think', live && 'animate-pulse')} aria-hidden />
        <span className="font-medium text-think">{live ? 'Thinking…' : 'Thought'}</span>
        <span className="num text-xs text-faint">{words ? `${int(words)} words` : ''}</span>
        <ChevronDown className={cn('ml-auto size-4 text-faint transition-transform', isOpen && 'rotate-180')} aria-hidden />
      </button>
      {isOpen ? (
        <div ref={box} className="max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-think/20 px-3 py-2 text-[13px] leading-relaxed text-muted scrollbar-thin">
          {text}
        </div>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------------ tools
function ToolIcon({ t }: { t: ToolCall }) {
  if (t.state === 'running') return <Loader2 className="size-3.5 animate-spin text-answer" aria-hidden />
  if (t.state === 'waiting') return <Hand className="size-3.5 text-warn" aria-hidden />
  if (t.state === 'refused' || t.state === 'declined') return <ShieldX className="size-3.5 text-warn" aria-hidden />
  if (t.state === 'error' || t.state === 'skipped') return <AlertTriangle className="size-3.5 text-faint" aria-hidden />
  if (t.state === 'stopped') return <CircleStop className="size-3.5 text-faint" aria-hidden />
  if (t.name === 'web_search') return <Search className="size-3.5 text-faint" aria-hidden />
  if (t.name === 'open_page') return <FileText className="size-3.5 text-faint" aria-hidden />
  return <Globe className="size-3.5 text-faint" aria-hidden />
}

/** A link from the web or the model: http(s) only; any other address is shown as text, never as a link. */
function SafeLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const ok = safeHref(href)
  if (!ok) {
    return (
      <span title={href} className={className}>
        {children}
      </span>
    )
  }
  return (
    <a href={ok} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" title={href} className={className}>
      {children}
    </a>
  )
}

/**
 * "Ask before opening pages": while a page waits for your yes, the tab's title says so, and (only if notifications were
 * already allowed for the console, and the tab is in the background) one quiet notification per page.
 */
export function useWaitingSignal(tools: ToolCall[]) {
  const waiting = tools.filter((t) => t.state === 'waiting')
  // a call's id may come back in a later round: when it started (and where) tells the calls apart
  const callKey = (t: ToolCall) => `${t.id}:${t.started ?? ''}:${t.at}`
  const key = waiting.map(callKey).join(' ')
  const told = useRef(new Set<string>())
  useEffect(() => {
    if (!key) return
    const before = document.title
    const mine = `⏸ A page waits for your yes · ${before}`
    document.title = mine
    for (const t of waiting) {
      if (told.current.has(callKey(t))) continue
      told.current.add(callKey(t))
      try {
        if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('A page waits for your yes', { body: `Open ${hostOf(t.url ?? t.args.url ?? '') || 'a page'}?`, tag: `chat-wait-${t.id}`, silent: true })
        }
      } catch {
        /* notifications not available here */
      }
    }
    return () => {
      if (document.title === mine) document.title = before
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

/** 4:59, 0:07 */
function mmss(s: number): string {
  const n = Math.max(0, Math.ceil(s))
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}

function WaitCountdown({ t }: { t: ToolCall }) {
  const now = useNow(1000)
  const [seen] = useState(() => Date.now() / 1000)
  const left = waitDeadline(t, seen) - now
  return (
    <span className="num ml-auto text-xs text-faint" data-testid="wait-countdown">
      {left > 0 ? `a no in ${mmss(left)}` : 'no answer: declined'}
    </span>
  )
}

/** What became of an opened page, in a sentence. */
function toolOutcome(t: ToolCall): string {
  switch (t.state) {
    case 'declined':
      return 'You declined to open it.'
    case 'error':
      return 'It could not be read.'
    case 'stopped':
      return 'Not opened: the answer stopped first.'
    case 'skipped':
      return 'Not run: the tool budget or time for this answer was spent.'
    default:
      return 'Its readable text went to the model.'
  }
}

function ToolDetail({ t }: { t: ToolCall }) {
  if (t.name === 'web_search' && t.state === 'skipped')
    return (
      <p className="text-faint">
        Not searched: <span className="text-fg">“{t.args.query}”</span>. {toolOutcome(t)}
      </p>
    )
  if (t.name === 'web_search')
    return (
      <div className="grid gap-1">
        <p className="text-faint">
          Sent to the search engine: <span className="text-fg">“{t.args.query}”</span>
          {isNum(t.ms) ? <span className="num"> · {int(t.ms)} ms</span> : null}
        </p>
        {t.links?.length ? (
          <ul className="grid gap-0.5">
            {t.links.map((l) => (
              <li key={l} className="flex min-w-0 items-center gap-2">
                <Monogram domain={hostOf(l)} />
                <SafeLink href={l} className="truncate text-muted hover:text-fg hover:underline">
                  {l.replace(/^https?:\/\//, '')}
                </SafeLink>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    )
  if (t.state === 'refused')
    return (
      <p className="text-muted">
        This link did not come from a search in this chat or from you, so it was not opened. A page may have asked for it;
        refusing it keeps your conversation from being sent there.
        {t.args.url ? <span className="mt-1 block break-all font-mono text-[11.5px] text-faint">{t.args.url}</span> : null}
      </p>
    )
  return (
    <div className="grid gap-1 text-faint">
      {t.args.url ? (
        <SafeLink href={t.args.url} className="break-all font-mono text-[11.5px] text-muted hover:text-fg hover:underline">
          {t.args.url}
        </SafeLink>
      ) : null}
      <p>
        {toolOutcome(t)}
        {isNum(t.chars) && t.chars > 0 ? <span className="num"> · {int(t.chars)} characters</span> : null}
        {isNum(t.ms) ? <span className="num"> · {int(t.ms)} ms</span> : null}
      </p>
    </div>
  )
}

function ToolRow({ t, chatId }: { t: ToolCall; chatId: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const reply = async (allow: boolean) => {
    setBusy(true)
    try {
      await answerTool(chatId, t.id, allow)
    } catch (e) {
      toast.error('That did not go through', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  if (t.state === 'waiting') {
    const url = t.url ?? t.args.url ?? ''
    return (
      <li className="grid gap-2 rounded-md border border-warn/35 bg-warn-bg px-2.5 py-2" data-testid="tool-waiting">
        <div className="flex items-center gap-2">
          <ToolIcon t={t} />
          <span className="font-medium text-fg">Open {hostOf(url) || 'this page'}?</span>
          <span className="text-faint">You asked to be asked before each page.</span>
          <WaitCountdown t={t} />
        </div>
        <span className="break-all font-mono text-[11.5px] text-muted">{url}</span>
        <div className="flex gap-2">
          <Button size="xs" variant="primary" onClick={() => reply(true)} disabled={busy}>
            <Check aria-hidden /> Allow
          </Button>
          <Button size="xs" variant="outline" onClick={() => reply(false)} disabled={busy}>
            <X aria-hidden /> Decline
          </Button>
        </div>
      </li>
    )
  }
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-panel-2"
        data-testid="tool-row"
      >
        <ChevronRight className={cn('size-3 shrink-0 text-faint transition-transform', open && 'rotate-90')} aria-hidden />
        <ToolIcon t={t} />
        {t.name === 'open_page' && t.args.url && t.state === 'done' ? <Monogram domain={hostOf(t.args.url)} /> : null}
        <span className={cn('truncate', t.state === 'running' ? 'text-fg' : t.state === 'refused' || t.state === 'declined' ? 'text-warn' : 'text-muted')}>
          {toolLine(t)}
        </span>
      </button>
      {open ? <div className="ml-[2.1rem] mt-0.5 pb-1 text-[12px] leading-relaxed">{<ToolDetail t={t} />}</div> : null}
    </li>
  )
}

function ToolGroup({ tools, chatId }: { tools: ToolCall[]; chatId: string }) {
  return (
    <ul className="grid gap-0.5 border-l-2 border-line-strong py-0.5 pl-2 text-[13px] animate-in fade-in-0 slide-in-from-left-1 duration-300" aria-label="Web tools used">
      {tools.map((t, i) => (
        // an engine may reuse a call's id in a later round: the place keeps the rows apart
        <ToolRow key={`${t.id || 'call'}:${i}`} t={t} chatId={chatId} />
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------------------------------- citations
function SourceCard({ s }: { s: Source }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2 text-[11px] text-faint">
        <Monogram domain={s.domain} />
        <span className="truncate">{s.domain}</span>
        {s.opened || s.kind === 'page' ? <span className="ml-auto rounded bg-answer-bg px-1 text-answer">read</span> : <span className="ml-auto">search result</span>}
      </div>
      <p className="text-[13px] font-medium leading-snug text-fg">{s.title || s.domain}</p>
      {s.snippet ? <p className="line-clamp-4 text-xs leading-relaxed text-muted">{s.snippet}</p> : null}
      <SafeLink href={s.url} className="mt-0.5 inline-flex min-w-0 items-center gap-1 text-xs text-info hover:underline">
        <span className="truncate">{s.url.replace(/^https?:\/\//, '')}</span>
        <ExternalLink className="size-3 shrink-0" aria-hidden />
      </SafeLink>
    </div>
  )
}

const cardClass =
  'z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-lg border border-line-strong bg-panel p-3 shadow-xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=closed]:animate-out data-[state=closed]:fade-out-0'

/** [n] in the answer: a pill; hover (or tap, or focus and Enter) shows the source. */
function CitePill({ s }: { s: Source }) {
  const [open, setOpen] = useState(false)
  // Esc closes it for good: the focus and the pointer still on the pill must not open it again at once
  const escAt = useRef(0)
  const close = () => {
    escAt.current = Date.now()
    setOpen(false)
  }
  const change = (o: boolean) => {
    if (o && Date.now() - escAt.current < 600) return
    setOpen(o)
  }
  return (
    <HC.Root open={open} onOpenChange={change} openDelay={150} closeDelay={120}>
      <HC.Trigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            setOpen((o) => !o)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && open) {
              e.stopPropagation()
              close()
            }
          }}
          aria-label={`Source ${s.n}: ${s.title || s.domain}`}
          aria-expanded={open}
          className="mx-0.5 inline-flex h-[1.35em] min-w-[1.35em] -translate-y-px items-center justify-center rounded-full border border-answer/35 bg-answer-bg px-1 align-middle font-mono text-[10.5px] font-semibold leading-none text-answer no-underline transition-colors hover:bg-answer hover:text-bg"
          data-testid="cite"
        >
          {s.n}
        </button>
      </HC.Trigger>
      <HC.Portal>
        <HC.Content side="top" sideOffset={6} collisionPadding={12} className={cardClass} onEscapeKeyDown={close} data-testid="cite-card">
          <SourceCard s={s} />
        </HC.Content>
      </HC.Portal>
    </HC.Root>
  )
}

function CitePillFor({ n, sources }: { n: number; sources: { current: Map<number, Source> } }) {
  const s = sources.current.get(n)
  return s ? <CitePill s={s} /> : null
}

function SourcesRow({ sources }: { sources: Source[] }) {
  if (!sources.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Sources">
      <span className="mr-0.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Sources</span>
      {sources.map((s) => (
        <SafeLink
          key={s.n}
          href={s.url}
          className="inline-flex h-6 max-w-[16rem] items-center gap-1.5 rounded-full border border-line-strong bg-panel-2 pl-1 pr-2 text-[11.5px] text-muted transition-colors hover:border-faint hover:text-fg"
        >
          <Monogram domain={s.domain} />
          <span className="num text-faint">{s.n}</span>
          <span className="truncate">{s.domain}</span>
        </SafeLink>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------- phase line
/**
 * What is happening before text arrives, from the gateway's live view of this request (`rid`): held during a preset
 * switch, waiting behind others, or reading the prompt with the engine's progress.  Then thinking, then writing.
 */
function PhaseLine({ live }: { live: LiveAnswer }) {
  const now = useNow(250)
  const rid = live.rid
  const q = useStore(
    riverStore,
    (s) => {
      const me = rid ? s.inflight[rid] : undefined
      const ahead = me ? inflightList(s).filter((f) => f.rid !== rid && isGenerating(f) && f.started_at < me.started_at && !f.denied).length : 0
      return { known: !!me, held: me?.phase === 'held', mine: !!me && activeRid(s) === rid, ahead, rate: me ? liveRate(me, Date.now() / 1000) : null }
    },
    shallow,
  )
  const hold = useStore(gatewayStore, (g) => (g?.hold && g.hold.ready === false ? g.hold.reason || 'a preset switch' : null))
  const e = useStore(metricsStore, (x) => ({ st: x.latest?.engine?.state, r: x.latest?.engine?.prompt_read, t: x.latest?.engine?.prompt_total }), shallow)
  if (live.phase === 'tool' || live.phase === 'ended') return null
  let tone: 'read' | 'warn' | 'neutral' | 'think' | 'answer' = 'read'
  let text = 'Reading the prompt'
  let extra = ''
  if (live.phase === 'thinking') {
    tone = 'think'
    text = 'Thinking'
  } else if (live.phase === 'writing') {
    tone = 'answer'
    text = 'Writing'
    const rate = q.rate ?? (live.writingAt && now - live.writingAt > 0.6 ? live.deltas / (now - (live.firstAt ?? now)) : null)
    extra = isNum(rate) && rate > 0 ? `${fixed(rate, 0)} tok/s` : ''
  } else if (q.held || (hold && !q.known)) {
    tone = 'warn'
    text = 'The server is switching presets; your message goes as soon as it’s back'
  } else if (q.known && !q.mine && q.ahead > 0) {
    tone = 'neutral'
    text = `Waiting behind ${q.ahead} other request${q.ahead === 1 ? '' : 's'}: the server answers one at a time`
  } else {
    const reading = (e.st === 'reading' || e.st === 'prefill') && isNum(e.t) && e.t > 0 && (q.mine || !q.known)
    const pct = reading ? Math.min(99, Math.round(((e.r ?? 0) / e.t!) * 100)) : 0
    if (pct > 0) extra = `${pct}%`
    else if (live.ridAt) extra = `${fixed(Math.max(0, now - live.ridAt), 1)} s`
  }
  const color = { read: 'text-read', warn: 'text-warn', neutral: 'text-muted', think: 'text-think', answer: 'text-answer' }[tone]
  const dot = { read: 'bg-read', warn: 'bg-warn', neutral: 'bg-faint', think: 'bg-think', answer: 'bg-answer' }[tone]
  return (
    <div className="flex items-center gap-2 text-xs" data-testid="phase" aria-hidden>
      <span className={cn('size-1.5 animate-pulse rounded-full', dot)} />
      <span className={color}>{text}</span>
      {extra ? <span className="num text-faint">{extra}</span> : null}
    </div>
  )
}

// --------------------------------------------------------------------------------------------------------- answers
function Footer({ m, children }: { m: Message; children?: ReactNode }) {
  const st = m.stats
  const searches = m.tools.filter((t) => t.name === 'web_search' && t.state === 'done').length
  const reads = m.tools.filter((t) => t.name === 'open_page' && t.state === 'done').length
  const bits: Array<{ v: string; tip: string }> = []
  if (st.preset) bits.push({ v: st.preset, tip: 'The preset that wrote this answer' })
  if (isNum(st.completion_tokens)) bits.push({ v: `${int(st.completion_tokens)} tokens`, tip: 'Tokens written, thinking included' })
  if (isNum(st.tok_s)) bits.push({ v: `${fixed(st.tok_s, st.tok_s >= 100 ? 0 : 1)} tok/s`, tip: 'Answer speed' })
  if (searches) bits.push({ v: `${searches} search${searches === 1 ? '' : 'es'}`, tip: 'Web searches this answer made' })
  if (reads) bits.push({ v: `${reads} page${reads === 1 ? '' : 's'} read`, tip: 'Pages it opened' })
  if (isNum(st.ms)) bits.push({ v: `${fixed(st.ms / 1000, 1)} s`, tip: `The whole answer${isNum(st.ttft_ms) ? `; the first token after ${fixed(st.ttft_ms / 1000, 1)} s` : ''}` })
  return (
    <div className="flex min-h-7 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-faint" data-testid="answer-footer">
      {bits.map((b, i) => (
        <Tip key={i} content={b.tip}>
          <span className="num cursor-default">
            {i ? <span className="mr-1.5 text-line-strong">·</span> : null}
            {b.v}
          </span>
        </Tip>
      ))}
      {m.status === 'stopped' ? (
        <span className="inline-flex items-center gap-1 text-warn">
          <CircleStop className="size-3" aria-hidden /> stopped
        </span>
      ) : null}
      {st.finish === 'length' ? <span className="text-warn">· cut at the token limit</span> : null}
      <span className="ml-auto flex items-center gap-0.5">{children}</span>
    </div>
  )
}

export const AnswerBlock = memo(function AnswerBlock({
  m,
  live,
  chatId,
  busy,
  onRegenerate,
  onPick,
  highlight,
}: {
  m: Message
  live: LiveAnswer | null
  chatId: string
  busy: boolean
  onRegenerate: () => void
  onPick: (id: string) => void
  highlight?: boolean
}) {
  const streaming = m.status === 'streaming'
  const byN = useMemo(() => new Map(m.sources.map((s) => [s.n, s])), [m.sources])
  const valid = useMemo(() => new Set(citedNumbers(m.content).filter((n) => byN.has(n))), [m.content, byN])
  const parts = useMemo(() => interleave(m.content, m.tools), [m.content, m.tools])
  const cited = useMemo(() => citedSources(m.content, m.sources), [m.content, m.sources])
  // stable, so the pills are not drawn anew (closing an open card) when the chat reloads
  const sourcesRef = useRef(byN)
  sourcesRef.current = byN
  const link = useCallback((href: string) => {
    const n = citeOf(href)
    return n !== null && sourcesRef.current.has(n) ? <CitePillFor n={n} sources={sourcesRef} /> : null
  }, [])
  const empty = !m.content && !m.tools.length && !m.reasoning
  const lastText = [...parts].reverse().find((p) => p.kind === 'text')?.key
  const caret = streaming && live?.phase === 'writing'
  return (
    <article className={cn('grid min-w-0 grid-cols-1 gap-3 scroll-mt-24', highlight && 'chat-flash')} aria-label="Answer" data-msg-id={m.id} aria-busy={streaming || undefined}>
      {m.reasoning ? <Reasoning text={m.reasoning} live={streaming && live?.phase === 'thinking'} /> : null}
      {parts.map((p) =>
        p.kind === 'tools' ? (
          <ToolGroup key={p.key} tools={p.tools} chatId={chatId} />
        ) : (
          <Suspense key={p.key} fallback={<Plain text={p.text} />}>
            <Markdown text={linkCitations(p.text, valid)} link={valid.size ? link : undefined} className={caret && p.key === lastText ? 'chat-caret' : undefined} />
          </Suspense>
        ),
      )}
      {streaming && live ? <PhaseLine live={live} /> : null}
      {streaming && !live ? (
        <div className="flex items-center gap-2 text-xs text-faint">
          <span className="size-1.5 animate-pulse rounded-full bg-faint" aria-hidden /> Catching up…
        </div>
      ) : null}
      {m.status === 'error' ? (
        <div className="flex flex-wrap items-start gap-2 rounded-lg border border-error/35 bg-error-bg px-3 py-2 text-[13px]" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-error" aria-hidden />
          <span className="min-w-0 flex-1 text-fg">{m.error || 'The answer failed.'}</span>
          <Button size="xs" variant="outline" onClick={onRegenerate} disabled={busy}>
            <RotateCcw aria-hidden /> Try again
          </Button>
        </div>
      ) : null}
      {!streaming && m.status === 'done' && empty ? <p className="text-[13px] text-faint">The answer was empty.</p> : null}
      {!streaming ? <SourcesRow sources={cited} /> : null}
      {!streaming ? (
        <Footer m={m}>
          <Versions m={m} onPick={onPick} disabled={busy} />
          {m.content ? <CopyButton value={m.content} label="Copy the answer" size="xs" className="border-0 bg-transparent" /> : null}
          <Tip content="Another answer to the same question (the earlier one is kept)">
            <button type="button" onClick={onRegenerate} disabled={busy} className="rounded-md p-1.5 hover:bg-panel-2 hover:text-fg disabled:opacity-40" aria-label="Regenerate this answer" data-testid="regenerate">
              <RotateCcw className="size-3.5" />
            </button>
          </Tip>
        </Footer>
      ) : null}
    </article>
  )
})
