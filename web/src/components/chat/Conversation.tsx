// One chat: the header (its space as a chip, the title you can click to rename, a suggested space, the ⋯ menu), the
// messages with the answer being written laid over the last one, and the composer.

import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowDown,
  BookOpenText,
  ChevronDown,
  Download,
  FolderInput,
  FolderMinus,
  MessageSquareDashed,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ApiError, download } from '@/lib/api'
import { ask, openChatUi, patchChat, showVersion, stopChat, suggestTitle, useChat, useChatSettings, useJustTitled, useSpaces } from '@/lib/chat/data'
import { withLive } from '@/lib/chat/logic'
import { useAnswerStream } from '@/lib/chat/stream'
import type { Chat, Message, Space } from '@/lib/chat/types'
import { cn, useReducedMotion } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/menu'
import { Empty, LiveRegion, Skeleton } from '@/components/ui/misc'
import { ActionMenu, MOD, SpaceMark, spaceChip, TitleText, type MenuAction } from './bits'
import { ChatComposer } from './ChatComposer'
import { moveWithUndo } from './Dialogs'
import { AnswerBlock, NoteCard, UserBubble, useWaitingSignal } from './Messages'
import { RenameInput } from './Sidebar'

const failed = (what: string) => (e: unknown) => {
  if (e instanceof ApiError && e.status === 409) toast.error('An answer is being written', { description: 'Wait for it, or stop it first.' })
  else toast.error(what, { description: e instanceof ApiError ? e.message : String(e) })
}

/** Requests from outside (F2, the ⋯ menu) to rename the chat in the header. */
export const headerRename = { current: null as null | (() => void) }

function SpacePicker({ chat, space }: { chat: Chat; space: Space | null }) {
  const { data: spaces = [] } = useSpaces()
  const actions: MenuAction[] = [
    ...spaces.map((s) => ({
      key: s.id,
      label: (
        <span className="flex items-center gap-2">
          <SpaceMark space={s} />
          <span className="truncate">{s.name}</span>
          {s.id === chat.space_id ? <span className="ml-auto text-[11px] text-faint">here</span> : null}
        </span>
      ),
      onSelect: () => void moveWithUndo([chat], s),
    })),
    { key: 'none', label: 'No space', icon: FolderMinus, onSelect: () => void moveWithUndo([chat], null), sep: spaces.length > 0, disabled: !chat.space_id },
    { key: 'new', label: 'New space…', icon: Plus, onSelect: () => openChatUi({ newSpace: { thenMove: [chat.id] } }) },
  ]
  return (
    <ActionMenu
      title="Move this chat to"
      align="start"
      actions={actions}
      trigger={
        <button
          type="button"
          className={cn(
            'inline-flex h-7 max-w-[11rem] shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium transition-colors hover:brightness-110',
            space ? spaceChip(space.color) : 'border-dashed border-line-strong text-faint hover:text-fg',
          )}
          aria-label={space ? `Space: ${space.name}. Move to another` : 'No space. Move to a space'}
          data-testid="space-chip"
        >
          {space ? <SpaceMark space={space} className="w-auto" /> : null}
          <span className="truncate">{space ? space.name : 'No space'}</span>
          <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />
        </button>
      }
    />
  )
}

function Header({ chat, space, suggested, onOpenSidebar }: { chat: Chat; space: Space | null; suggested: Space | null; onOpenSidebar?: () => void }) {
  const navigate = useNavigate()
  const fresh = useJustTitled(chat.id)
  const { data: settings } = useChatSettings()
  const [renaming, setRenaming] = useState(false)
  const [titling, setTitling] = useState(false)
  useEffect(() => {
    headerRename.current = () => setRenaming(true)
    return () => {
      headerRename.current = null
    }
  }, [])
  const actions: MenuAction[] = [
    { key: 'rename', label: 'Rename', icon: Pencil, shortcut: 'F2', onSelect: () => setRenaming(true), testId: 'menu-rename' },
    {
      key: 'title',
      label: titling ? 'Writing a title…' : 'Suggest a title',
      icon: Sparkles,
      disabled: titling,
      onSelect: () => {
        setTitling(true)
        suggestTitle(chat.id)
          .catch(failed('No title came'))
          .finally(() => setTitling(false))
      },
    },
    { key: 'pin', label: chat.pinned ? 'Unpin' : 'Pin to the top', icon: chat.pinned ? PinOff : Pin, onSelect: () => void patchChat(chat.id, { pinned: !chat.pinned }).catch(failed('That did not go through')) },
    { key: 'move', label: 'Move to…', icon: FolderInput, onSelect: () => openChatUi({ move: [chat.id] }), testId: 'menu-move' },
    { key: 'export', label: 'Export as Markdown', icon: Download, onSelect: () => void download(`/api/chats/${encodeURIComponent(chat.id)}/export`, 'chat.md').catch(failed('Exporting failed')) },
    { key: 'delete', label: 'Delete…', icon: Trash2, danger: true, sep: true, shortcut: `${MOD}⌫`, onSelect: () => openChatUi({ deleteChats: [chat.id] }), testId: 'menu-delete' },
    { key: 'strata', label: 'The engine’s own page', icon: BookOpenText, sep: true, onSelect: () => navigate({ to: '/strata' }) },
  ]
  const showSuggestion = !!suggested && !chat.space_id && settings?.suggest_spaces !== false
  return (
    <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-line px-3 py-2 sm:px-4">
      {onOpenSidebar ? (
        <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={onOpenSidebar} aria-label="Show the chats">
          <PanelLeft />
        </Button>
      ) : null}
      <SpacePicker chat={chat} space={space} />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <RenameInput chat={chat} onDone={() => setRenaming(false)} className="max-w-xl text-[15px] font-semibold" />
        ) : (
          <Tip content="Click to rename (F2)">
            <button
              type="button"
              onClick={() => setRenaming(true)}
              className="flex min-w-0 max-w-full items-center rounded-md px-1 py-0.5 text-left text-[15px] font-semibold tracking-tight text-fg hover:bg-panel-2"
              data-testid="chat-title"
            >
              <TitleText title={chat.title} fresh={fresh} />
            </button>
          </Tip>
        )}
      </div>
      {showSuggestion && suggested ? (
        <span className={cn('hidden h-7 shrink-0 items-center gap-0.5 rounded-full border pl-2 text-xs animate-in fade-in-0 slide-in-from-right-2 sm:inline-flex', spaceChip(suggested.color))} data-testid="suggested-space">
          <button type="button" onClick={() => void moveWithUndo([chat], suggested)} className="inline-flex items-center gap-1 font-medium hover:underline">
            Move to <SpaceMark space={suggested} className="w-auto" /> {suggested.name}?
          </button>
          <button
            type="button"
            onClick={() => void patchChat(chat.id, { suggested_space: null }).catch(failed('That did not go through'))}
            className="ml-0.5 rounded-full p-1 opacity-70 hover:opacity-100"
            aria-label="No, keep it where it is"
          >
            <X className="size-3" />
          </button>
        </span>
      ) : null}
      <ActionMenu
        title={chat.title || 'Chat'}
        actions={actions}
        trigger={
          <Button variant="ghost" size="icon-sm" aria-label="More for this chat" data-testid="chat-menu">
            <MoreHorizontal />
          </Button>
        }
      />
    </header>
  )
}

export function Conversation({ chatId, msg, onOpenSidebar }: { chatId: string; msg?: string; onOpenSidebar?: () => void }) {
  const navigate = useNavigate()
  const reduced = useReducedMotion()
  const { data, isPending, error } = useChat(chatId)
  const { data: settings } = useChatSettings()
  const running = !!data?.chat.running
  const live = useAnswerStream(chatId, running)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [flash, setFlash] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const busy = running || !!(live && !live.ended)

  // follow the answer while you are at the bottom
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = () => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
      stick.current = bottom
      setAtBottom(bottom)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [data === undefined])
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current && !msg) el.scrollTop = el.scrollHeight
  }, [data?.messages, live?.content, live?.reasoning, live?.tools, msg])
  useEffect(() => {
    stick.current = true
  }, [chatId])

  // from a search result: to the message that matched, with a brief glow.  A match in another version is shown first.
  const [versionAsked, setVersionAsked] = useState<string | null>(null)
  const onScreen = !!msg && !!data?.messages.some((m) => m.id === msg)
  useEffect(() => {
    // the hit is done with: the same hit, opened again later, switches again
    if (!msg) setVersionAsked(null)
  }, [msg])
  useEffect(() => {
    if (!msg || !data || onScreen || versionAsked === msg) return
    setVersionAsked(msg)
    if (data.chat.running) {
      toast.message('That match is in another version of this chat', { description: 'Open it again when the answer being written is done.' })
      return
    }
    void showVersion(chatId, msg).catch(failed('Showing that version failed'))
  }, [msg, data, onScreen, versionAsked, chatId])
  useEffect(() => {
    if (!msg || !data) return
    if (!onScreen && versionAsked !== msg) return // switching to its version first
    const el = scroller.current?.querySelector(`[data-msg-id="${CSS.escape(msg)}"]`)
    if (el) {
      stick.current = false
      el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
      setFlash(msg)
    }
    const t = setTimeout(() => {
      setFlash(null)
      void navigate({ to: '/chat/$chatId', params: { chatId }, search: {}, replace: true })
    }, 2800)
    return () => clearTimeout(t)
  }, [msg, data === undefined, onScreen, versionAsked, chatId, navigate, reduced])

  // say what happened, for screen readers
  const lastStatus = useRef<string | null>(null)
  useEffect(() => {
    const st = live?.ended ? live.status : live ? 'streaming' : null
    if (st === lastStatus.current) return
    lastStatus.current = st
    if (st === 'streaming') setAnnounce('Writing the answer')
    else if (st === 'done') setAnnounce('The answer is written')
    else if (st === 'stopped') setAnnounce('Stopped')
    else if (st === 'error') setAnnounce(`The answer failed: ${live?.error ?? ''}`)
  }, [live])

  const regenerate = useCallback((m: Message) => void ask(chatId, { regenerate: m.id }).catch(failed('Asking again failed')), [chatId])
  // an edit keeps the question's pictures; parent_id "" is the first question
  const edit = useCallback(
    (m: Message, text: string) => void ask(chatId, { content: text, images: m.images, parent_id: m.parent_id ?? '' }).catch(failed('Sending failed')),
    [chatId],
  )
  const pick = useCallback((id: string) => void showVersion(chatId, id).catch(failed('Showing that version failed')), [chatId])

  useWaitingSignal(live?.ended ? [] : (live?.tools ?? []))

  // A failed refetch keeps what is on screen (a console restart, a network blip); only a chat that never loaded, or
  // that is gone, shows the error.
  const gone = error instanceof ApiError && error.status === 404
  if (error && (gone || !data)) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Empty icon={<MessageSquareDashed />} title={gone ? 'This chat is gone' : 'This chat did not load'} action={<Button asChild size="sm"><Link to="/chat">New chat</Link></Button>}>
          {gone ? 'It was deleted, here or on another device.' : (error as Error).message}
        </Empty>
      </div>
    )
  }
  if (isPending || !data) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex h-12 items-center gap-2 border-b border-line px-4">
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-5 w-64" />
        </div>
        <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8">
          <Skeleton className="ml-auto h-12 w-2/3 rounded-2xl" />
          <Skeleton className="h-28" />
        </div>
      </div>
    )
  }

  const { chat, space } = data
  const send = async (text: string, images: string[]) => {
    try {
      stick.current = true
      await ask(chatId, { content: text, images })
      return true
    } catch (e) {
      failed('Sending failed')(e)
      return false
    }
  }
  const stop = () => void stopChat(chatId).catch(failed('Stopping failed'))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LiveRegion message={announce} />
      <Header chat={chat} space={space} suggested={data.suggested_space} onOpenSidebar={onOpenSidebar} />
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto scrollbar-thin" data-testid="conversation">
        <div className="mx-auto grid w-full max-w-3xl grid-cols-1 content-start gap-6 px-3 pb-10 pt-6 sm:px-6">
          {space?.instructions ? (
            <p className="-mb-2 flex items-center justify-center gap-1.5 text-[11.5px] text-faint">
              <SpaceMark space={space} className="w-auto" /> Using {space.name}’s instructions
            </p>
          ) : null}
          {data.messages.length === 0 ? <p className="py-10 text-center text-[13px] text-muted">Nothing here yet. Ask something below.</p> : null}
          {data.messages.map((m) =>
            m.role === 'user' ? (
              <UserBubble key={m.id} m={m} busy={busy} onEdit={(t) => edit(m, t)} onPick={pick} highlight={flash === m.id} />
            ) : m.role === 'note' ? (
              <NoteCard key={m.id} m={m} />
            ) : (
              <AnswerBlock
                key={m.id}
                m={withLive(m, live)}
                live={live && live.message_id === m.id ? live : null}
                chatId={chatId}
                busy={busy}
                onRegenerate={() => regenerate(m)}
                onPick={pick}
                highlight={flash === m.id}
              />
            ),
          )}
        </div>
      </div>
      <div className="relative shrink-0 px-3 pb-3 sm:px-6 sm:pb-4">
        {!atBottom ? (
          <button
            type="button"
            onClick={() => {
              const el = scroller.current
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
            }}
            className="absolute -top-11 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-panel-3 px-3 text-xs text-muted shadow-lg animate-in fade-in-0 hover:text-fg"
          >
            <ArrowDown className="size-3.5" aria-hidden /> {busy ? 'Follow the answer' : 'To the latest'}
          </button>
        ) : null}
        <div className="mx-auto w-full max-w-3xl">
          <ChatComposer
            key={chatId}
            draftKey={chatId}
            chatId={chatId}
            web={chat.web && settings?.web_ready !== false}
            thinking={chat.thinking}
            onWeb={(v) => void patchChat(chatId, { web: v }).catch(failed('That did not go through'))}
            onThinking={(v) => void patchChat(chatId, { thinking: v }).catch(failed('That did not go through'))}
            context={data.context}
            busy={busy}
            onSend={send}
            onStop={stop}
            placeholder={chat.space_id && space ? `Ask in ${space.emoji ? `${space.emoji} ` : ''}${space.name}…` : 'Ask a follow-up…'}
            autoFocus={!('ontouchstart' in window)}
          />
        </div>
      </div>
    </div>
  )
}
