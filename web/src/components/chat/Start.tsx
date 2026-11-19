// Starting a chat: the empty page (a fresh context, with a few ideas), and a space's own page (its instructions, its
// chats, and a composer that starts a chat in it).

import { Link, useNavigate } from '@tanstack/react-router'
import { Globe, MoreHorizontal, PanelLeft, Pencil, Settings2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { createChat, openChatUi, useChatList, useChatSettings, useSpaces } from '@/lib/chat/data'
import { firstLine } from '@/lib/chat/logic'
import type { Space } from '@/lib/chat/types'
import { day } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge, Empty } from '@/components/ui/misc'
import { ActionMenu, SpaceMark, spaceTile, TitleText } from './bits'
import { ChatComposer } from './ChatComposer'

const IDEAS: Array<{ text: string; web?: boolean }> = [
  { text: 'What is the latest stable Linux kernel, and what changed in it?', web: true },
  { text: 'Explain how a heat pump works, in plain words.' },
  { text: 'Write a Python function that merges overlapping intervals, with a short test.' },
  { text: 'What is the integral of x² from 0 to 3? Show the steps.' },
]

function useStart(space: Space | null) {
  const navigate = useNavigate()
  const { data: settings } = useChatSettings()
  const defWeb = space?.web ?? settings?.web_default ?? true
  const defThink = space?.thinking ?? true
  const [web, setWeb] = useState<boolean | null>(null)
  const [thinking, setThinking] = useState<boolean | null>(null)
  const w = (web ?? defWeb) && settings?.web_ready !== false
  const t = thinking ?? defThink
  const send = async (text: string, images: string[]) => {
    try {
      const r = await createChat({ content: text, images, space_id: space?.id ?? null, web: web ?? undefined, thinking: thinking ?? undefined })
      void navigate({ to: '/chat/$chatId', params: { chatId: r.chat.id } })
      return true
    } catch (e) {
      toast.error('Starting the chat failed', { description: e instanceof ApiError ? e.message : String(e) })
      return false
    }
  }
  return { web: w, thinking: t, setWeb, setThinking, send }
}

function MobileBar({ onOpenSidebar, children }: { onOpenSidebar?: () => void; children?: React.ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 md:hidden">
      <Button variant="ghost" size="icon-sm" onClick={onOpenSidebar} aria-label="Show the chats">
        <PanelLeft />
      </Button>
      {children}
    </div>
  )
}

export function NewChat({ onOpenSidebar }: { onOpenSidebar?: () => void }) {
  const s = useStart(null)
  const [busy, setBusy] = useState(false)
  const go = async (text: string, images: string[]) => {
    setBusy(true)
    const ok = await s.send(text, images)
    setBusy(false)
    return ok
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MobileBar onOpenSidebar={onOpenSidebar}>
        <span className="text-[13px] font-medium text-muted">New chat</span>
      </MobileBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-2xl content-center gap-8 px-4 py-10 sm:min-h-full sm:py-12">
          <div className="grid justify-items-center gap-3 text-center">
            <div className="relative" aria-hidden>
              <div className="absolute inset-0 -z-10 animate-breathe rounded-full bg-answer/20 blur-2xl" />
              <svg viewBox="0 0 48 48" className="size-12">
                <path d="M4 34 L16 22 L24 28 L34 14 L44 24 L44 40 L4 40 Z" className="fill-answer/15 stroke-answer" strokeWidth="1.5" strokeLinejoin="round" />
                <path d="M4 34 L16 28 L24 33 L34 24 L44 30" className="fill-none stroke-read/70" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">What’s on your mind?</h2>
            <p className="max-w-md text-[13px] leading-relaxed text-muted">
              A new chat starts with a fresh context: the model sees only this conversation. It is saved on the server, so it is on every device.
            </p>
          </div>
          <div className="mx-auto w-full max-w-2xl">
            <ChatComposer
              draftKey="new"
              chatId={null}
              web={s.web}
              thinking={s.thinking}
              onWeb={s.setWeb}
              onThinking={s.setThinking}
              busy={busy}
              onSend={go}
              onStop={() => {}}
              autoFocus={!('ontouchstart' in window)}
            />
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {IDEAS.map((i) => (
              <li key={i.text}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void go(i.text, [])}
                  className="flex h-full w-full items-start gap-2 rounded-xl border border-line bg-panel px-3.5 py-3 text-left text-[13px] leading-snug text-muted transition-all hover:-translate-y-px hover:border-line-strong hover:bg-panel-2 hover:text-fg"
                >
                  {i.web ? <Globe className="mt-0.5 size-3.5 shrink-0 text-answer" aria-label="uses the web" /> : null}
                  <span>{i.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

export function SpaceView({ spaceId, onOpenSidebar }: { spaceId: string; onOpenSidebar?: () => void }) {
  const { data: spaces, isPending } = useSpaces()
  const { data: list } = useChatList()
  const space = spaces?.find((s) => s.id === spaceId) ?? null
  const s = useStart(space)
  const [busy, setBusy] = useState(false)
  const [more, setMore] = useState(false)
  if (!space) {
    return (
      <div className="flex flex-1 flex-col">
        <MobileBar onOpenSidebar={onOpenSidebar} />
        {isPending ? null : (
          <Empty title="This space is gone" action={<Button asChild size="sm"><Link to="/chat">New chat</Link></Button>}>
            It was deleted, here or on another device.
          </Empty>
        )}
      </div>
    )
  }
  const chats = (list?.chats ?? []).filter((c) => c.space_id === space.id)
  const go = async (text: string, images: string[]) => {
    setBusy(true)
    const ok = await s.send(text, images)
    setBusy(false)
    return ok
  }
  const long = space.instructions.length > 280
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MobileBar onOpenSidebar={onOpenSidebar} />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-6 sm:px-6 sm:py-8">
          <header className="flex items-start gap-3">
            <div className={cn('flex size-12 shrink-0 items-center justify-center rounded-2xl text-2xl', spaceTile(space.color))} aria-hidden>
              {space.emoji || <SpaceMark space={space} />}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-xl font-semibold tracking-tight text-fg" data-testid="space-title">
                {space.name}
              </h2>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-faint">
                {chats.length} chat{chats.length === 1 ? '' : 's'}
                {space.web !== null ? <Badge>🌐 web {space.web ? 'on' : 'off'} for new chats</Badge> : null}
                {space.thinking !== null ? <Badge>💭 thinking {space.thinking ? 'on' : 'off'}</Badge> : null}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => openChatUi({ editSpace: space.id })}>
              <Settings2 aria-hidden /> <span className="hidden sm:inline">Edit</span>
            </Button>
            <ActionMenu
              title={space.name}
              actions={[
                { key: 'edit', label: 'Edit the space…', icon: Pencil, onSelect: () => openChatUi({ editSpace: space.id }) },
                { key: 'del', label: 'Delete the space…', icon: Trash2, danger: true, sep: true, onSelect: () => openChatUi({ deleteSpace: space.id }), testId: 'space-delete' },
              ]}
              trigger={
                <Button variant="ghost" size="icon-sm" aria-label={`More for ${space.name}`}>
                  <MoreHorizontal />
                </Button>
              }
            />
          </header>

          <section className="rounded-xl border border-line bg-panel p-4" aria-labelledby="sp-instr">
            <div className="mb-1.5 flex items-center gap-2">
              <h3 id="sp-instr" className="eyebrow">
                Instructions
              </h3>
              <span className="text-[11px] text-faint">every chat here gets these</span>
            </div>
            {space.instructions ? (
              <>
                <p className={cn('whitespace-pre-wrap text-[13px] leading-relaxed text-muted', long && !more && 'line-clamp-4')}>{space.instructions}</p>
                {long ? (
                  <button type="button" className="mt-1 text-xs text-faint hover:text-fg" onClick={() => setMore(!more)} aria-expanded={more}>
                    {more ? 'Show less' : 'Show all'}
                  </button>
                ) : null}
              </>
            ) : (
              <p className="text-[13px] text-muted">
                None yet.{' '}
                <button type="button" className="link" onClick={() => openChatUi({ editSpace: space.id })}>
                  Add instructions
                </button>{' '}
                such as what your setup is, or how you like answers.
              </p>
            )}
          </section>

          <section aria-labelledby="sp-chats">
            <h3 id="sp-chats" className="eyebrow mb-2">
              Chats
            </h3>
            {chats.length ? (
              <ul className="grid divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
                {chats.map((c) => (
                  <li key={c.id}>
                    <Link to="/chat/$chatId" params={{ chatId: c.id }} className="flex items-center gap-3 px-4 py-2.5 text-[13px] text-fg hover:bg-panel-2">
                      <TitleText title={c.title || firstLine('Untitled chat')} className="flex-1" />
                      {c.running ? <span className="size-1.5 animate-pulse rounded-full bg-answer" aria-label="an answer is being written" /> : null}
                      <span className="num shrink-0 text-xs text-faint">{day(c.updated_at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-muted">
                No chats here yet. Start one below, or drag a chat onto the space in the sidebar.
              </p>
            )}
          </section>
        </div>
      </div>
      <div className="shrink-0 px-3 pb-3 sm:px-6 sm:pb-4">
        <div className="mx-auto w-full max-w-3xl">
          <ChatComposer
            draftKey={`space:${space.id}`}
            chatId={null}
            web={s.web}
            thinking={s.thinking}
            onWeb={s.setWeb}
            onThinking={s.setThinking}
            busy={busy}
            onSend={go}
            onStop={() => {}}
            placeholder={`New chat in ${space.emoji ? `${space.emoji} ` : ''}${space.name}`}
            autoFocus={!('ontouchstart' in window)}
          />
        </div>
      </div>
    </div>
  )
}
