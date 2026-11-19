// The chat page's sidebar: New chat, the search box (/), Pinned, Spaces (collapsible, counts, a + to start a chat in one,
// drag a chat onto one, drag spaces to reorder them), and Recent by day.  ⇧-click and ⌘-click select several chats for
// Move or Delete.  Every drag has a keyboard path through the ⋯ menus.

import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Download,
  FolderInput,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as RKeyboardEvent, type MouseEvent as RMouseEvent } from 'react'
import { toast } from 'sonner'
import { ApiError, download } from '@/lib/api'
import { loadOlder, openChatUi, orderSpaces, patchChat, useChatList, useChatSearch, useJustTitled, useSpaces } from '@/lib/chat/data'
import { groupByDate, rangeIds, reorder, spaceSlug, splitHighlights, splitQuery } from '@/lib/chat/logic'
import type { Chat, SearchResult, Space } from '@/lib/chat/types'
import { day } from '@/lib/format'
import { createStore, useStore } from '@/lib/store'
import { cn, useDebounced, useReducedMotion } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/menu'
import { Kbd, LiveRegion, Skeleton } from '@/components/ui/misc'
import { ActionMenu, MOD, SpaceChip, SpaceMark, TitleText, type MenuAction } from './bits'
import { moveWithUndo } from './Dialogs'

// ----------------------------------------------------------------------------------------------- selection, drag
/** Chats selected with ⇧-click or ⌘-click (and the anchor for ⇧). */
export const selection = createStore<{ ids: string[]; anchor: string | null }>({ ids: [], anchor: null })
export const clearSelection = () => selection.set({ ids: [], anchor: null })

/** What is being dragged, for the drop targets (dataTransfer cannot be read during dragover). */
const dragStore = createStore<{ kind: 'chats'; ids: string[] } | { kind: 'space'; id: string } | null>(null)

const OPEN_KEY = 'outcrop.chat.spaces-open'
function loadOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) || '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

/** A text box for a new title: Enter saves, Esc cancels, leaving it saves. */
export function RenameInput({ chat, onDone, className }: { chat: Chat; onDone: () => void; className?: string }) {
  const [v, setV] = useState(chat.title)
  // the title when editing began: a title the model writes meanwhile is not overwritten by an untouched box
  const initial = useRef(chat.title)
  const done = useRef(false)
  const save = async () => {
    if (done.current) return
    done.current = true
    onDone()
    const t = v.trim()
    if (t && t !== initial.current.trim() && t !== chat.title) {
      try {
        await patchChat(chat.id, { title: t })
      } catch (e) {
        toast.error('Renaming failed', { description: e instanceof ApiError ? e.message : String(e) })
      }
    }
  }
  return (
    <input
      autoFocus
      value={v}
      maxLength={200}
      aria-label="The chat's title"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          void save()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          done.current = true
          onDone()
        }
      }}
      onClick={(e) => e.stopPropagation()}
      className={cn('w-full min-w-0 rounded-md border border-focus bg-sunken px-1.5 py-0.5 text-[13px] text-fg outline-none', className)}
      data-testid="rename-input"
    />
  )
}

/** The ⋯ actions for one chat (and the long-press and right-click menu). */
export function chatActions(c: Chat, rename: () => void): MenuAction[] {
  return [
    { key: 'rename', label: 'Rename', icon: Pencil, onSelect: rename, shortcut: 'F2', testId: 'act-rename' },
    {
      key: 'pin',
      label: c.pinned ? 'Unpin' : 'Pin to the top',
      icon: c.pinned ? PinOff : Pin,
      onSelect: () => void patchChat(c.id, { pinned: !c.pinned }).catch(() => toast.error('That did not go through')),
    },
    { key: 'move', label: 'Move to…', icon: FolderInput, onSelect: () => openChatUi({ move: [c.id] }), testId: 'act-move' },
    {
      key: 'export',
      label: 'Export as Markdown',
      icon: Download,
      onSelect: () => void download(`/api/chats/${encodeURIComponent(c.id)}/export`, 'chat.md').catch(() => toast.error('Exporting failed')),
    },
    { key: 'delete', label: 'Delete…', icon: Trash2, danger: true, sep: true, onSelect: () => openChatUi({ deleteChats: [c.id] }), shortcut: `${MOD}⌫`, testId: 'act-delete' },
  ]
}

// ------------------------------------------------------------------------------------------------------ chat row
const ChatRow = memo(function ChatRow({
  chat,
  active,
  selected,
  order,
  onNavigate,
  indent,
  activeId,
}: {
  chat: Chat
  active: boolean
  selected: boolean
  order: string[]
  onNavigate?: () => void
  indent?: boolean
  activeId: string | null
}) {
  const fresh = useJustTitled(chat.id)
  const [renaming, setRenaming] = useState(false)
  const [menu, setMenu] = useState(false)
  const press = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressed = useRef(false)
  const ui = useStore(renameStore)
  useEffect(() => {
    if (ui === chat.id) {
      setRenaming(true)
      renameStore.set(null)
    }
  }, [ui, chat.id])

  const onClick = (e: RMouseEvent) => {
    if (pressed.current) {
      // the end of a long press, which opened the menu
      e.preventDefault()
      pressed.current = false
      return
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      const s = selection.get()
      const base = s.ids.length ? s.ids : []
      const ids = base.includes(chat.id) ? base.filter((x) => x !== chat.id) : [...base, chat.id]
      selection.set({ ids, anchor: chat.id })
      return
    }
    if (e.shiftKey) {
      e.preventDefault()
      const s = selection.get()
      const anchor = s.anchor ?? (activeId && order.includes(activeId) ? activeId : chat.id)
      selection.set({ ids: rangeIds(order, anchor, chat.id), anchor })
      return
    }
    clearSelection()
    onNavigate?.()
  }
  const onDragStart = (e: DragEvent) => {
    const s = selection.get()
    const ids = s.ids.includes(chat.id) ? s.ids : [chat.id]
    dragStore.set({ kind: 'chats', ids })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', ids.length > 1 ? `${ids.length} chats` : chat.title)
    if (ids.length > 1) {
      const ghost = document.createElement('div')
      ghost.className = 'fixed -top-40 left-0 rounded-full border border-line-strong bg-panel-3 px-3 py-1 text-[13px] text-fg shadow-xl'
      ghost.textContent = `${ids.length} chats`
      document.body.appendChild(ghost)
      e.dataTransfer.setDragImage(ghost, 12, 12)
      setTimeout(() => ghost.remove(), 0)
    }
  }
  const actions = chatActions(chat, () => setRenaming(true))
  return (
    <div
      className={cn(
        'group/row relative flex h-8 items-center rounded-md text-[13px] transition-colors',
        indent && 'pl-5',
        active ? 'bg-panel-3 text-fg' : selected ? 'bg-focus/15 text-fg' : 'text-muted hover:bg-panel-2 hover:text-fg',
        selected && 'shadow-[inset_0_0_0_1px_var(--focus)]',
      )}
      data-chat-id={chat.id}
      draggable={!renaming}
      onDragStart={onDragStart}
      onDragEnd={() => dragStore.set(null)}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu(true)
      }}
      onTouchStart={() => {
        pressed.current = false
        press.current = setTimeout(() => {
          pressed.current = true
          setMenu(true)
        }, 550)
      }}
      onTouchEnd={() => press.current && clearTimeout(press.current)}
      onTouchMove={() => press.current && clearTimeout(press.current)}
      data-testid="chat-row"
    >
      {renaming ? (
        <div className={cn('flex-1 px-1', indent && 'pl-0')}>
          <RenameInput chat={chat} onDone={() => setRenaming(false)} />
        </div>
      ) : (
        <Link
          to="/chat/$chatId"
          params={{ chatId: chat.id }}
          onClick={onClick}
          onDoubleClick={(e) => {
            e.preventDefault()
            setRenaming(true)
          }}
          aria-current={active ? 'page' : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2.5 pr-8 outline-offset-[-2px]"
          draggable={false}
        >
          {chat.running ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-answer" aria-label="an answer is being written" /> : null}
          <TitleText title={chat.title} fresh={fresh} />
          {selected ? <span className="sr-only"> (selected)</span> : null}
        </Link>
      )}
      {!renaming ? (
        <div className="absolute right-1 top-1/2 -translate-y-1/2">
          <ActionMenu
            title={chat.title || 'Chat'}
            open={menu}
            onOpenChange={setMenu}
            actions={actions}
            trigger={
              <button
                type="button"
                className={cn(
                  'flex size-6 items-center justify-center rounded-md text-faint hover:bg-panel-3 hover:text-fg focus-visible:opacity-100 data-[state=open]:opacity-100 md:opacity-0 md:group-hover/row:opacity-100',
                  (active || menu) && 'md:opacity-100',
                )}
                aria-label={`More for “${chat.title || 'this chat'}”`}
                data-testid="row-menu"
              >
                <MoreHorizontal className="size-4" />
              </button>
            }
          />
        </div>
      ) : null}
    </div>
  )
})

/** Ask a sidebar row to show its rename box (F2, or ⋯ → Rename in the header). */
export const renameStore = createStore<string | null>(null)

// ------------------------------------------------------------------------------------------------- the list parts
function Rows({ chats, activeId, order, onNavigate, indent }: { chats: Chat[]; activeId: string | null; order: string[]; onNavigate?: () => void; indent?: boolean }) {
  const sel = useStore(selection, (s) => s.ids)
  const reduced = useReducedMotion()
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)] gap-px">
      <AnimatePresence initial={false}>
        {chats.map((c) => (
          <motion.li
            key={c.id}
            layout={reduced ? false : 'position'}
            initial={reduced ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
          >
            <ChatRow chat={c} active={c.id === activeId} activeId={activeId} selected={sel.includes(c.id)} order={order} onNavigate={onNavigate} indent={indent} />
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  )
}

function SectionHead({ children, action, drop }: { children: React.ReactNode; action?: React.ReactNode; drop?: DropProps }) {
  return (
    <div className={cn('mb-0.5 mt-4 flex h-7 items-center gap-1 rounded-md px-2.5 first:mt-1', drop?.className)} {...drop?.handlers}>
      <h3 className="eyebrow flex-1">{children}</h3>
      {action}
    </div>
  )
}

interface DropProps {
  className?: string
  handlers: {
    onDragOver: (e: DragEvent) => void
    onDragEnter: (e: DragEvent) => void
    onDragLeave: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
  }
}

/** A drop target for dragged chats (a space, or "No space"). */
function useChatDrop(onDrop: (ids: string[]) => void, accepts: (ids: string[]) => boolean): DropProps {
  const drag = useStore(dragStore)
  const [over, setOver] = useState(0)
  const ok = drag?.kind === 'chats' && accepts(drag.ids)
  useEffect(() => {
    if (!drag) setOver(0)
  }, [drag])
  return {
    className: ok ? (over > 0 ? 'chat-drop' : 'outline-1 outline-dashed outline-line-strong -outline-offset-1') : undefined,
    handlers: {
      onDragOver: (e) => {
        if (!ok) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      },
      onDragEnter: (e) => {
        if (!ok) return
        e.preventDefault()
        setOver((n) => n + 1)
      },
      onDragLeave: () => ok && setOver((n) => Math.max(0, n - 1)),
      onDrop: (e) => {
        if (!ok || drag?.kind !== 'chats') return
        e.preventDefault()
        setOver(0)
        dragStore.set(null)
        onDrop(drag.ids)
      },
    },
  }
}

const MAX_IN_SPACE = 8

function SpaceRow({
  space,
  chats,
  open,
  setOpen,
  activeId,
  activeSpace,
  order,
  spaceIds,
  onNavigate,
}: {
  space: Space
  chats: Chat[]
  open: boolean
  setOpen: (o: boolean) => void
  activeId: string | null
  activeSpace: string | null
  order: string[]
  spaceIds: string[]
  onNavigate?: () => void
}) {
  const navigate = useNavigate()
  const { data: list } = useChatList()
  const drag = useStore(dragStore)
  const [reorderOver, setReorderOver] = useState<'above' | 'below' | null>(null)
  const drop = useChatDrop(
    (ids) => {
      const moving = (list?.chats ?? []).filter((c) => ids.includes(c.id))
      void moveWithUndo(moving, space)
    },
    (ids) => (list?.chats ?? []).some((c) => ids.includes(c.id) && c.space_id !== space.id),
  )
  const i = spaceIds.indexOf(space.id)
  const move = (d: number) => {
    const j = i + d
    if (j < 0 || j >= spaceIds.length) return
    const ids = spaceIds.slice()
    ids.splice(i, 1)
    ids.splice(j, 0, space.id)
    void orderSpaces(ids).catch(() => toast.error('Reordering failed'))
  }
  const actions: MenuAction[] = [
    { key: 'new', label: 'New chat here', icon: MessageSquarePlus, onSelect: () => navigate({ to: '/chat', search: { space: space.id } }) },
    { key: 'edit', label: 'Edit the space…', icon: Settings2, onSelect: () => openChatUi({ editSpace: space.id }) },
    { key: 'up', label: 'Move up', icon: ArrowUp, onSelect: () => move(-1), disabled: i <= 0, sep: true },
    { key: 'down', label: 'Move down', icon: ArrowDown, onSelect: () => move(1), disabled: i >= spaceIds.length - 1 },
    { key: 'delete', label: 'Delete the space…', icon: Trash2, danger: true, sep: true, onSelect: () => openChatUi({ deleteSpace: space.id }) },
  ]
  const shown = chats.slice(0, MAX_IN_SPACE)
  const isSpaceDrag = drag?.kind === 'space' && drag.id !== space.id
  return (
    <li className="relative">
      {reorderOver ? <span className={cn('pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-focus', reorderOver === 'above' ? '-top-px' : '-bottom-px')} aria-hidden /> : null}
      <div
        className={cn(
          'group/space flex h-8 items-center gap-0.5 rounded-md pr-1 text-[13px] transition-colors',
          activeSpace === space.id ? 'bg-panel-3 text-fg' : 'text-muted hover:bg-panel-2 hover:text-fg',
          drop.className,
        )}
        draggable
        onDragStart={(e) => {
          dragStore.set({ kind: 'space', id: space.id })
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', space.name)
        }}
        onDragEnd={() => {
          dragStore.set(null)
          setReorderOver(null)
        }}
        onDragOver={(e) => {
          if (isSpaceDrag) {
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            setReorderOver(e.clientY < r.top + r.height / 2 ? 'above' : 'below')
            return
          }
          drop.handlers.onDragOver(e)
        }}
        onDragEnter={drop.handlers.onDragEnter}
        onDragLeave={(e) => {
          setReorderOver(null)
          drop.handlers.onDragLeave(e)
        }}
        onDrop={(e) => {
          if (isSpaceDrag && drag?.kind === 'space') {
            e.preventDefault()
            const after = reorderOver === 'below'
            setReorderOver(null)
            dragStore.set(null)
            void orderSpaces(reorder(spaceIds, drag.id, space.id, after)).catch(() => toast.error('Reordering failed'))
            return
          }
          drop.handlers.onDrop(e)
        }}
        data-testid="space-row"
        data-space-id={space.id}
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} the chats in ${space.name}`}
          className="flex size-6 shrink-0 items-center justify-center rounded text-faint hover:text-fg"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        </button>
        <Link to="/chat" search={{ space: space.id }} onClick={onNavigate} className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pr-1 outline-offset-[-2px]" draggable={false}>
          <SpaceMark space={space} />
          <span className="truncate">{space.name}</span>
          <motion.span key={space.chats} initial={{ scale: 1.35 }} animate={{ scale: 1 }} className="num ml-auto pl-1 text-[11px] text-faint" aria-label={`${space.chats} chats`}>
            {space.chats}
          </motion.span>
        </Link>
        <Tip content={`New chat in ${space.name}`}>
          <Link
            to="/chat"
            search={{ space: space.id }}
            onClick={onNavigate}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-panel-3 hover:text-fg focus-visible:opacity-100 md:opacity-0 md:group-hover/space:opacity-100"
            aria-label={`New chat in ${space.name}`}
            draggable={false}
          >
            <Plus className="size-3.5" />
          </Link>
        </Tip>
        <ActionMenu
          title={`${space.emoji} ${space.name}`.trim()}
          actions={actions}
          trigger={
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-panel-3 hover:text-fg focus-visible:opacity-100 data-[state=open]:opacity-100 md:opacity-0 md:group-hover/space:opacity-100"
              aria-label={`More for ${space.name}`}
            >
              <MoreHorizontal className="size-4" />
            </button>
          }
        />
      </div>
      {open && chats.length ? (
        <div className="mb-1">
          <Rows chats={shown} activeId={activeId} order={order} onNavigate={onNavigate} indent />
          {chats.length > MAX_IN_SPACE ? (
            <Link to="/chat" search={{ space: space.id }} onClick={onNavigate} className="ml-5 flex h-7 items-center rounded-md px-2.5 text-xs text-faint hover:text-fg">
              All {chats.length} chats →
            </Link>
          ) : null}
        </div>
      ) : null}
      {open && !chats.length ? <p className="ml-7 py-1 text-xs text-faint">No chats yet. Drag one here.</p> : null}
    </li>
  )
}

// --------------------------------------------------------------------------------------------------------- search
function Snippet({ r }: { r: SearchResult }) {
  if (!r.snippet) return null
  return (
    <p className="line-clamp-2 text-xs leading-snug text-faint">
      {splitHighlights(r.snippet.text, r.snippet.highlights).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-warn-bg px-0.5 text-fg">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  )
}

function SearchResults({
  q,
  setQ,
  active,
  setActive,
  results,
  pending,
  spaces,
  onPick,
}: {
  q: string
  setQ: (q: string) => void
  active: number
  setActive: (i: number) => void
  results: SearchResult[]
  pending: boolean
  spaces: Space[]
  onPick: (r: SearchResult) => void
}) {
  const sp = splitQuery(q).space
  const byId = new Map(spaces.map((s) => [s.id, s]))
  return (
    <div className="grid gap-2 px-2.5 pb-3">
      {spaces.length ? (
        <div className="flex flex-wrap gap-1 px-0.5" aria-label="Narrow to a space">
          {spaces.map((s) => {
            const on = sp !== null && sp.length > 0 && spaceSlug(s.name).startsWith(sp.toLowerCase())
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const base = splitQuery(q).text
                  setQ(on ? base : `${base} in:${spaceSlug(s.name)}`.trim() + ' ')
                  document.getElementById('chat-search')?.focus()
                }}
                className={cn('rounded-full', on && 'ring-1 ring-focus')}
              >
                <SpaceChip space={s} />
              </button>
            )
          })}
        </div>
      ) : null}
      <LiveRegion message={pending ? '' : `${results.length} chat${results.length === 1 ? '' : 's'} found`} />
      {!results.length && !pending ? <p className="px-1 py-6 text-center text-[13px] text-muted">No chat matches “{splitQuery(q).text || q}”.</p> : null}
      <ul className="grid gap-0.5" role="listbox" aria-label="Chats found" id="chat-search-results">
        {results.map((r, i) => {
          const s = r.chat.space_id ? byId.get(r.chat.space_id) : undefined
          return (
            <li
              key={`${r.chat.id}-${r.msg_id}`}
              role="option"
              aria-selected={i === active}
              id={`chat-res-${i}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(r)}
              className={cn('grid w-full cursor-pointer gap-1 rounded-md px-2.5 py-2 text-left', i === active ? 'bg-panel-3' : 'hover:bg-panel-2')}
              data-testid="search-result"
            >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-fg">{r.chat.title || 'Untitled chat'}</span>
                  <span className="num ml-auto shrink-0 text-[11px] text-faint">{day(r.chat.updated_at)}</span>
                </span>
                {s ? <SpaceChip space={s} className="w-fit" /> : null}
                <Snippet r={r} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// -------------------------------------------------------------------------------------------------------- sidebar
export function ChatSidebar({ activeId, activeSpace, onNavigate, className }: { activeId: string | null; activeSpace: string | null; onNavigate?: () => void; className?: string }) {
  const { data: list, isPending } = useChatList()
  const { data: spaces = [] } = useSpaces()
  const navigate = useNavigate()
  const sel = useStore(selection, (s) => s.ids)
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim(), 160)
  const search = useChatSearch(dq)
  const [activeRes, setActiveRes] = useState(0)
  const [open, setOpenMap] = useState<Record<string, boolean>>(loadOpen)
  const [olderBusy, setOlderBusy] = useState(false)
  const chats = useMemo(() => list?.chats ?? [], [list])
  const activeChat = chats.find((c) => c.id === activeId)

  const isOpen = (id: string) => open[id] ?? activeChat?.space_id === id
  const setOpen = (id: string, o: boolean) =>
    setOpenMap((p) => {
      const n = { ...p, [id]: o }
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(n))
      } catch {
        /* private mode */
      }
      return n
    })

  const pinned = chats.filter((c) => c.pinned)
  const bySpace = useMemo(() => {
    const m = new Map<string, Chat[]>()
    for (const c of chats) if (c.space_id && !c.pinned) m.set(c.space_id, [...(m.get(c.space_id) ?? []), c])
    return m
  }, [chats])
  const known = new Set(spaces.map((s) => s.id))
  const recent = chats.filter((c) => !c.pinned && (!c.space_id || !known.has(c.space_id)))
  const groups = groupByDate(recent)

  // the order on screen, for ⇧-click
  const order = [
    ...pinned.map((c) => c.id),
    ...spaces.flatMap((s) => (isOpen(s.id) ? (bySpace.get(s.id) ?? []).slice(0, MAX_IN_SPACE).map((c) => c.id) : [])),
    ...groups.flatMap((g) => g.chats.map((c) => c.id)),
  ]

  const noSpaceDrop = useChatDrop(
    (ids) => void moveWithUndo(chats.filter((c) => ids.includes(c.id)), null),
    (ids) => chats.some((c) => ids.includes(c.id) && c.space_id),
  )

  const results = dq ? (search.data?.results ?? []) : []
  useEffect(() => setActiveRes(0), [dq])
  const pick = (r: SearchResult) => {
    onNavigate?.()
    void navigate({ to: '/chat/$chatId', params: { chatId: r.chat.id }, search: r.msg_id ? { msg: r.msg_id } : {} })
  }
  const onSearchKey = (e: RKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (q) setQ('')
      else e.currentTarget.blur()
    } else if (e.key === 'ArrowDown' && results.length) {
      e.preventDefault()
      setActiveRes((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp' && results.length) {
      e.preventDefault()
      setActiveRes((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' && results[activeRes]) {
      e.preventDefault()
      pick(results[activeRes])
    }
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="grid gap-2 p-2.5 pb-2">
        <Button asChild variant="secondary" className="justify-start" size="sm">
          <Link to="/chat" onClick={() => (clearSelection(), onNavigate?.())} data-testid="new-chat" aria-keyshortcuts="Meta+Shift+O Control+Shift+O">
            <MessageSquarePlus aria-hidden /> New chat
            <span className="ml-auto hidden gap-0.5 sm:flex" aria-hidden>
              <Kbd>{MOD}</Kbd>
              <Kbd>⇧</Kbd>
              <Kbd>O</Kbd>
            </span>
          </Link>
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
          <label htmlFor="chat-search" className="sr-only">
            Search chats
          </label>
          <input
            id="chat-search"
            data-slash-focus
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search chats…"
            autoComplete="off"
            role="combobox"
            aria-expanded={!!dq}
            aria-controls={dq ? 'chat-search-results' : undefined}
            aria-activedescendant={dq && results.length ? `chat-res-${activeRes}` : undefined}
            className="h-8 w-full rounded-md border border-line-strong bg-sunken/60 pl-8 pr-8 text-[13px] text-fg placeholder:text-faint focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-search-cancel-button]:hidden"
          />
          {q ? (
            <button type="button" onClick={() => setQ('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-faint hover:text-fg" aria-label="Clear the search">
              <X className="size-3.5" />
            </button>
          ) : (
            <Kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" aria-hidden>
              /
            </Kbd>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 scrollbar-thin" data-testid="chat-sidebar">
        {dq ? (
          <SearchResults q={q} setQ={setQ} active={activeRes} setActive={setActiveRes} results={results} pending={search.isFetching && !search.data} spaces={spaces} onPick={pick} />
        ) : isPending ? (
          <div className="grid gap-1.5 pt-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-7" />
            ))}
          </div>
        ) : (
          <nav aria-label="Chats">
            {pinned.length ? (
              <section>
                <SectionHead>Pinned</SectionHead>
                <Rows chats={pinned} activeId={activeId} order={order} onNavigate={onNavigate} />
              </section>
            ) : null}
            <section>
              <SectionHead
                action={
                  <Tip content="A new space">
                    <button type="button" onClick={() => openChatUi({ newSpace: {} })} className="rounded p-1 text-faint hover:bg-panel-2 hover:text-fg" aria-label="A new space">
                      <Plus className="size-3.5" />
                    </button>
                  </Tip>
                }
              >
                Spaces
              </SectionHead>
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-px">
                {spaces.map((s) => (
                  <SpaceRow
                    key={s.id}
                    space={s}
                    chats={bySpace.get(s.id) ?? []}
                    open={isOpen(s.id)}
                    setOpen={(o) => setOpen(s.id, o)}
                    activeId={activeId}
                    activeSpace={activeSpace}
                    order={order}
                    spaceIds={spaces.map((x) => x.id)}
                    onNavigate={onNavigate}
                  />
                ))}
                <li>
                  <button
                    type="button"
                    onClick={() => openChatUi({ newSpace: {} })}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-[13px] text-faint hover:bg-panel-2 hover:text-fg"
                    data-testid="new-space"
                  >
                    <Plus className="size-3.5" aria-hidden /> New space
                  </button>
                </li>
              </ul>
            </section>
            <section>
              <SectionHead drop={noSpaceDrop}>{noSpaceDrop.className ? 'Recent · drop here for no space' : 'Recent'}</SectionHead>
              {groups.length ? (
                groups.map((g) => (
                  <div key={g.label} className="mb-2">
                    <h4 className="px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium text-faint">{g.label}</h4>
                    <Rows chats={g.chats} activeId={activeId} order={order} onNavigate={onNavigate} />
                  </div>
                ))
              ) : (
                <p className="px-2.5 py-2 text-xs text-faint">{chats.length ? 'Every chat is in a space.' : 'Your chats will be here.'}</p>
              )}
              {list?.more ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="mx-1 mt-1"
                  loading={olderBusy}
                  onClick={async () => {
                    setOlderBusy(true)
                    await loadOlder().catch(() => toast.error('Loading older chats failed'))
                    setOlderBusy(false)
                  }}
                >
                  Show older chats
                </Button>
              ) : null}
            </section>
          </nav>
        )}
      </div>

      {sel.length ? (
        <div className="flex items-center gap-1.5 border-t border-line bg-panel-2 px-2.5 py-2 animate-in slide-in-from-bottom-2 fade-in-0" role="toolbar" aria-label="Selected chats" data-testid="selection-bar">
          <span className="num flex-1 whitespace-nowrap text-xs text-muted">{sel.length} selected</span>
          <Button size="xs" variant="outline" onClick={() => openChatUi({ move: sel })}>
            <FolderInput aria-hidden /> Move
          </Button>
          <Button size="xs" variant="danger-outline" onClick={() => openChatUi({ deleteChats: sel })}>
            <Trash2 aria-hidden /> Delete
          </Button>
          <button type="button" onClick={clearSelection} className="rounded p-1 text-faint hover:text-fg" aria-label="Clear the selection">
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  )
}
