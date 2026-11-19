// The chat's composer: the Playground's (text, pictures, Send and Stop) with the chat's own switches: 🌐 Web (per chat,
// greyed out with the reason when the web is not ready), 💭 Think, and the context meter, which offers a fresh chat from
// a summary when the conversation nears the model's context window.

import { useNavigate } from '@tanstack/react-router'
import { Globe, Lightbulb, ScrollText } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { summarize, useChatSettings } from '@/lib/chat/data'
import { getDraft, updateDraft } from '@/lib/chat/drafts'
import { contextLevel, kTokens } from '@/lib/chat/logic'
import { CHAT_PICTURES } from '@/lib/pictures'
import { cn } from '@/lib/utils'
import { Composer } from '@/components/playground/Composer'
import { Tip } from '@/components/ui/menu'


function Toggle({
  on,
  onChange,
  icon: Icon,
  label,
  tip,
  disabledWhy,
  testId,
}: {
  on: boolean
  onChange: (v: boolean) => void
  icon: typeof Globe
  label: string
  tip: string
  disabledWhy?: string | null
  testId?: string
}) {
  const off = !!disabledWhy
  return (
    <Tip content={off ? disabledWhy : tip}>
      <button
        type="button"
        aria-pressed={!off && on}
        aria-disabled={off || undefined}
        aria-label={off ? `${label}: unavailable. ${disabledWhy}` : label}
        onClick={() => {
          if (off) toast.message(`${label} is not available`, { description: disabledWhy ?? undefined })
          else onChange(!on)
        }}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
          off
            ? 'cursor-not-allowed border-line text-faint line-through decoration-faint/60'
            : on
              ? 'border-answer/40 bg-answer-bg text-answer'
              : 'border-line-strong text-faint hover:text-fg',
        )}
        data-testid={testId}
      >
        <Icon className="size-3.5" aria-hidden />
        <span className="hidden min-[400px]:inline">{label}</span>
      </button>
    </Tip>
  )
}

/** ◔ 18K of 256K: a ring that fills with the conversation, amber at 75%, and at 90% offers a fresh chat. */
function ContextMeter({ used, max, chatId }: { used: number; max: number | null; chatId: string | null }) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  if (!max || used <= 0) return null
  const f = Math.min(1, used / max)
  const level = contextLevel(used, max)
  const r = 7
  const c = 2 * Math.PI * r
  const color = level === 'full' ? 'stroke-error' : level === 'warn' ? 'stroke-warn' : 'stroke-faint'
  const run = async () => {
    if (!chatId) return
    setBusy(true)
    const id = toast.loading('Summarizing this chat…', { description: 'It takes about as long as an answer.' })
    try {
      const c2 = await summarize(chatId)
      toast.success('A new chat starts from the summary', { id, description: c2.title })
      void navigate({ to: '/chat/$chatId', params: { chatId: c2.id } })
    } catch (e) {
      toast.error('Summarizing failed', { id, description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="flex items-center gap-1.5">
      {level === 'full' && chatId ? (
        <Tip content="The model summarizes this conversation and a new chat opens with that summary as its first note: fresh context without starting from zero.">
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy}
            className="inline-flex h-7 items-center gap-1 rounded-full border border-warn/40 bg-warn-bg px-2 text-[11px] font-medium text-warn hover:opacity-90 disabled:opacity-50"
            data-testid="summarize"
          >
            <ScrollText className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Start a new chat from a summary</span>
            <span className="sm:hidden">Summarize</span>
          </button>
        </Tip>
      ) : null}
      <Tip content={`${used.toLocaleString()} of ${max.toLocaleString()} tokens of the model's context are used by this conversation${level !== 'ok' ? '. Long chats get slower and the model sees less of the start.' : '.'}`}>
        <span
          className={cn('num inline-flex h-7 cursor-default items-center gap-1.5 rounded-full px-1.5 text-[11px]', level === 'full' ? 'text-error' : level === 'warn' ? 'text-warn' : 'text-faint')}
          role="meter"
          aria-label="Context used"
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={used}
          aria-valuetext={`${kTokens(used)} of ${kTokens(max)} tokens`}
          data-testid="context-meter"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" className="-rotate-90" aria-hidden>
            <circle cx="9" cy="9" r={r} fill="none" className="stroke-line-strong" strokeWidth="2.5" />
            <circle
              cx="9"
              cy="9"
              r={r}
              fill="none"
              className={cn(color, 'transition-[stroke-dashoffset] duration-700 ease-out')}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - Math.max(f, used > 0 ? 0.03 : 0))}
            />
          </svg>
          <span className="hidden sm:inline">
            {kTokens(used)} of {kTokens(max)}
          </span>
        </span>
      </Tip>
    </span>
  )
}

export function ChatComposer({
  draftKey,
  chatId,
  web,
  thinking,
  onWeb,
  onThinking,
  context,
  busy,
  onSend,
  onStop,
  placeholder,
  autoFocus,
}: {
  draftKey: string
  chatId: string | null
  web: boolean
  thinking: boolean
  onWeb: (v: boolean) => void
  onThinking: (v: boolean) => void
  context?: { used: number; max: number | null } | null
  busy: boolean
  onSend: (text: string, images: string[]) => Promise<boolean> | boolean
  onStop: () => void
  placeholder?: string
  autoFocus?: boolean
}) {
  const { data: settings } = useChatSettings()
  const [, force] = useState(0)
  // drafts survive switching between chats (lib/chat/drafts.ts); each change starts from the draft as it is now
  const d = getDraft(draftKey)
  const setText = (text: string) => {
    updateDraft(draftKey, (x) => ({ ...x, text }))
    force((n) => n + 1)
  }
  const setImages = (v: string[] | ((prev: string[]) => string[])) => {
    updateDraft(draftKey, (x) => ({ ...x, images: typeof v === 'function' ? v(x.images) : v }))
    force((n) => n + 1)
  }
  const sending = useRef(false)
  const webWhy = settings && !settings.web_ready ? (settings.web_status.why ?? (settings.web_allowed ? 'Web search is not reachable right now.' : 'Internet access for chat is blocked in Settings.')) : null
  const send = async () => {
    const text = d.text.trim()
    if ((!text && !d.images.length) || busy || sending.current) return
    sending.current = true
    const saved = { ...d }
    updateDraft(draftKey, () => ({ text: '', images: [] }))
    force((n) => n + 1)
    try {
      const ok = await onSend(text, saved.images)
      // not sent: put it back, unless something new was typed meanwhile
      if (!ok) updateDraft(draftKey, (x) => (x.text || x.images.length ? x : saved))
    } finally {
      sending.current = false
      force((n) => n + 1)
    }
  }
  return (
    <Composer
      inputId="chat-input"
      label="Your message"
      value={d.text}
      onChange={setText}
      images={d.images}
      setImages={setImages}
      pictures={CHAT_PICTURES}
      onSend={() => void send()}
      onStop={onStop}
      busy={busy}
      placeholder={placeholder ?? 'Ask anything…'}
      autoFocus={autoFocus}
      tools={
        <span className="flex items-center gap-1">
          <Toggle
            on={web}
            onChange={onWeb}
            icon={Globe}
            label="Web"
            tip={web ? 'The model may search the web and read pages for this chat. Click to turn it off.' : 'Off: the model is not offered the web tools in this chat.'}
            disabledWhy={webWhy}
            testId="toggle-web"
          />
          <Toggle
            on={thinking}
            onChange={onThinking}
            icon={Lightbulb}
            label="Think"
            tip={thinking ? 'The model thinks before it answers (slower, often better).' : 'Answers straight away, without thinking first.'}
            testId="toggle-think"
          />
        </span>
      }
      meter={context ? <ContextMeter used={context.used} max={context.max} chatId={chatId} /> : null}
    />
  )
}
