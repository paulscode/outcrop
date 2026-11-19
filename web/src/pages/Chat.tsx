// Chat: saved conversations with the model, in spaces, searchable, with web access under the console's rules
// (docs/CHAT-API.md).  /chat starts a new chat, /chat?space=ID opens a space, /chat/$chatId a conversation.

import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { chatUi, openChatUi, useChatList, useChatsLive } from '@/lib/chat/data'
import { Dialog, DialogTitle, SheetContent } from '@/components/ui/dialog'
import { Conversation, headerRename } from '@/components/chat/Conversation'
import { ChatDialogs } from '@/components/chat/Dialogs'
import { ChatSidebar, clearSelection, renameStore, selection } from '@/components/chat/Sidebar'
import { NewChat, SpaceView } from '@/components/chat/Start'
import { usePhone } from '@/components/chat/bits'

function typing(t: EventTarget | null) {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
}

export default function ChatPage() {
  useChatsLive()
  const params = useParams({ strict: false }) as { chatId?: string }
  const search = useSearch({ strict: false }) as { space?: string; msg?: string }
  const chatId = params.chatId ?? null
  const spaceId = chatId ? null : (search.space ?? null)
  const [drawer, setDrawer] = useState(false)
  const navigate = useNavigate()
  const phone = usePhone()
  const { data: list } = useChatList()

  // F2 renames, ⌘⌫ deletes (the selection, the focused row, or this chat), Esc clears the selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // "/" searches, also from the composer while it is empty (it has the focus when a chat opens)
      const t = e.target as HTMLTextAreaElement | null
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && t?.id === 'chat-input' && !t.value) {
        const box = [...document.querySelectorAll<HTMLElement>('[data-slash-focus]')].find((el) => el.offsetParent !== null)
        if (box) {
          e.preventDefault()
          box.focus()
          return
        }
      }
      if (typing(e.target) || document.querySelector('[role="dialog"]')) return
      const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-chat-id]')?.dataset.chatId
      const sel = selection.get().ids
      if (e.key === 'F2') {
        e.preventDefault()
        if (row) renameStore.set(row)
        else if (chatId) headerRename.current?.()
      } else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)) {
        const ids = sel.length ? sel : row ? [row] : chatId ? [chatId] : []
        if (ids.length) {
          e.preventDefault()
          openChatUi({ deleteChats: ids })
        }
      } else if (e.key === 'Escape' && sel.length) {
        clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chatId])

  // a selection is for the chats on screen: drop deleted ones
  useEffect(() => {
    const ids = new Set((list?.chats ?? []).map((c) => c.id))
    const s = selection.get()
    if (s.ids.some((i) => !ids.has(i))) selection.set({ ...s, ids: s.ids.filter((i) => ids.has(i)) })
  }, [list])

  // leaving the page: nothing stays selected or half-open
  useEffect(
    () => () => {
      clearSelection()
      chatUi.set({ move: null, newSpace: null, editSpace: null, deleteChats: null, deleteSpace: null, rename: null })
    },
    [],
  )

  const open = () => setDrawer(true)
  return (
    <div className="flex h-full min-h-0">
      {phone ? null : (
        <aside className="flex w-[272px] shrink-0 flex-col border-r border-line bg-bg" aria-label="Chats and spaces">
          <ChatSidebar activeId={chatId} activeSpace={spaceId} />
        </aside>
      )}
      <Dialog open={phone && drawer} onOpenChange={setDrawer}>
        <SheetContent side="left" aria-describedby={undefined} className="w-[min(320px,88vw)] p-0 pt-10 md:hidden" onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogTitle className="sr-only">Chats and spaces</DialogTitle>
          <ChatSidebar activeId={chatId} activeSpace={spaceId} onNavigate={() => setDrawer(false)} />
        </SheetContent>
      </Dialog>
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Chat">
        {chatId ? (
          <Conversation key={chatId} chatId={chatId} msg={search.msg} onOpenSidebar={open} />
        ) : spaceId ? (
          <SpaceView key={spaceId} spaceId={spaceId} onOpenSidebar={open} />
        ) : (
          <NewChat onOpenSidebar={open} />
        )}
      </section>
      <ChatDialogs
        onDeleted={(ids) => {
          if (chatId && ids.includes(chatId)) void navigate({ to: '/chat', replace: true })
        }}
      />
    </div>
  )
}
