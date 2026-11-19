// The chat page's dialogs: a space (new or edited), moving chats (a searchable picker that can make a space on the way),
// and the confirmations for deleting chats and spaces.  Opened from anywhere through `chatUi` (lib/chat/data.ts).

import { useNavigate } from '@tanstack/react-router'
import { Command } from 'cmdk'
import { Ban, Check, FolderMinus, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import {
  chatUi,
  createSpace,
  deleteChats,
  deleteSpace,
  isStandIn,
  knownChats,
  ck,
  moveChats,
  updateSpace,
  useChatList,
  useSpaces,
} from '@/lib/chat/data'
import type { Chat, Space, SpaceColor } from '@/lib/chat/types'
import { useStore } from '@/lib/store'
import { queryClient } from '@/lib/queries'
import type { ListData } from '@/lib/chat/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioItem, Segmented } from '@/components/ui/controls'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Label, Textarea } from '@/components/ui/input'
import { EMOJIS, SPACE_COLORS, SpaceMark, spaceDot, spaceTile } from './bits'

const fail = (what: string) => (e: unknown) => toast.error(what, { description: e instanceof ApiError ? e.message : String(e) })

// -------------------------------------------------------------------------------------------------- move, with undo
/** Move chats, with a toast that can put each back where it was. */
export async function moveWithUndo(chats: Chat[], to: Space | null) {
  const before = new Map<string | null, string[]>()
  // a chat known only by its id (not loaded yet): its space is not known, so it is moved, but Undo cannot put it back
  const unknown: string[] = []
  for (const c of chats) {
    if (isStandIn(c)) {
      unknown.push(c.id)
      continue
    }
    if (c.space_id === (to?.id ?? null)) continue
    const k = c.space_id
    before.set(k, [...(before.get(k) ?? []), c.id])
  }
  const ids = [...[...before.values()].flat(), ...unknown]
  if (!ids.length) return
  try {
    await moveChats(ids, to?.id ?? null)
  } catch (e) {
    fail('Moving failed')(e)
    return
  }
  const what = ids.length === 1 ? `“${chats.find((c) => c.id === ids[0])?.title || 'The chat'}”` : `${ids.length} chats`
  toast.success(to ? `Moved ${what} to ${to.emoji ? `${to.emoji} ` : ''}${to.name}` : `Moved ${what} out of its space`, {
    action: {
      label: 'Undo',
      onClick: () => {
        void (async () => {
          // only what is still where this move put it: a later move or a deleted chat is left alone
          const now = queryClient.getQueryData<ListData>(ck.list)?.chats ?? []
          const target = to?.id ?? null
          const spaces = queryClient.getQueryData<Space[]>(ck.spaces)
          let skipped = unknown.length
          for (const [sid, list] of before) {
            const back = list.filter((id) => now.find((c) => c.id === id)?.space_id === target)
            skipped += list.length - back.length
            if (sid && spaces && !spaces.some((s) => s.id === sid)) {
              skipped += back.length
              continue
            }
            if (back.length) await moveChats(back, sid).catch(fail('Undo failed'))
          }
          if (skipped) toast.message(`${skipped} chat${skipped === 1 ? '' : 's'} not moved back`, { description: 'It moved again, its space or the chat itself is gone, or where it was is not known.' })
        })()
      },
    },
  })
}

// ------------------------------------------------------------------------------------------------------- a space
type Tri = 'default' | 'on' | 'off'
const tri = (v: boolean | null | undefined): Tri => (v === true ? 'on' : v === false ? 'off' : 'default')
const untri = (v: Tri) => (v === 'on' ? true : v === 'off' ? false : null)

export function SpaceDialog({
  space,
  initialName,
  open,
  onOpenChange,
  onSaved,
}: {
  space: Space | null
  initialName?: string
  open: boolean
  onOpenChange: (o: boolean) => void
  onSaved?: (s: Space) => void
}) {
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('')
  const [color, setColor] = useState<SpaceColor>('')
  const [instructions, setInstructions] = useState('')
  const [web, setWeb] = useState<Tri>('default')
  const [thinking, setThinking] = useState<Tri>('default')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setName(space?.name ?? initialName ?? '')
    setEmoji(space?.emoji ?? '')
    setColor(space?.color ?? (SPACE_COLORS[Math.floor(Math.random() * SPACE_COLORS.length)] as SpaceColor))
    setInstructions(space?.instructions ?? '')
    setWeb(tri(space?.web))
    setThinking(tri(space?.thinking))
    setErr(null)
    // only when it opens or another space is edited: a new copy of the same space (its count changed) keeps your edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, space?.id])

  const save = async () => {
    const n = name.trim()
    if (!n) return setErr('Give the space a name.')
    setBusy(true)
    setErr(null)
    const body = { name: n, emoji, color, instructions, web: untri(web), thinking: untri(thinking) }
    try {
      const s = space ? await updateSpace(space.id, body) : await createSpace(body)
      onOpenChange(false)
      onSaved?.(s)
      if (!space) toast.success(`Made ${s.emoji ? `${s.emoji} ` : ''}${s.name}`)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="space-dialog-desc" data-testid="space-dialog">
        <DialogHeader>
          <DialogTitle>{space ? 'Edit the space' : 'A new space'}</DialogTitle>
          <DialogDescription id="space-dialog-desc">A folder with a purpose. Every chat in it gets its instructions.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="flex items-end gap-3">
            <div className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl text-xl', spaceTile(color))} aria-hidden>
              {emoji || <span className={cn('size-3 rounded-full', spaceDot(color))} />}
            </div>
            <Field label="Name" htmlFor="space-name" className="flex-1" error={err ?? undefined}>
              <Input id="space-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Home lab" autoFocus autoComplete="off" />
            </Field>
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-[13px] font-medium text-fg">Emoji</legend>
            <div className="grid grid-cols-10 gap-1" role="radiogroup" aria-label="Emoji">
              <button
                type="button"
                role="radio"
                aria-checked={!emoji}
                aria-label="No emoji"
                onClick={() => setEmoji('')}
                className={cn('flex aspect-square items-center justify-center rounded-md border text-faint hover:bg-panel-2', !emoji ? 'border-focus bg-panel-2' : 'border-transparent')}
              >
                <Ban className="size-4" aria-hidden />
              </button>
              {EMOJIS.slice(0, 39).map((e) => (
                <button
                  key={e}
                  type="button"
                  role="radio"
                  aria-checked={emoji === e}
                  aria-label={e}
                  onClick={() => setEmoji(e)}
                  className={cn('flex aspect-square items-center justify-center rounded-md border text-lg leading-none hover:bg-panel-2', emoji === e ? 'border-focus bg-panel-2' : 'border-transparent')}
                >
                  {e}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium text-fg">Colour</legend>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
              {SPACE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={c}
                  title={c}
                  onClick={() => setColor(c)}
                  className={cn('flex size-7 items-center justify-center rounded-full border-2 transition-transform hover:scale-110', color === c ? 'border-fg' : 'border-transparent')}
                >
                  <span className={cn('size-5 rounded-full', spaceDot(c))} />
                </button>
              ))}
            </div>
          </fieldset>
          <Field label="Instructions" htmlFor="space-instructions" hint={`Every chat here gets these, from its next message on. ${instructions.length} / 8000`}>
            <Textarea
              id="space-instructions"
              rows={5}
              maxLength={8000}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="My home lab: Ubuntu 26.04, an RTX 3090, Proxmox on the NAS…"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <span className="text-[13px] font-medium text-fg" id="space-web-l">
                🌐 Web for new chats
              </span>
              <Segmented<Tri>
                size="sm"
                label="Web for new chats"
                value={web}
                onValueChange={setWeb}
                options={[
                  { value: 'default', label: 'Default' },
                  { value: 'on', label: 'On' },
                  { value: 'off', label: 'Off' },
                ]}
              />
            </div>
            <div className="grid gap-1.5">
              <span className="text-[13px] font-medium text-fg">💭 Thinking for new chats</span>
              <Segmented<Tri>
                size="sm"
                label="Thinking for new chats"
                value={thinking}
                onValueChange={setThinking}
                options={[
                  { value: 'default', label: 'Default' },
                  { value: 'on', label: 'On' },
                  { value: 'off', label: 'Off' },
                ]}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} data-testid="space-save">
              {space ? 'Save' : 'Make the space'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------------- move picker
const pickItem =
  'flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-fg outline-none data-[selected=true]:bg-panel-3 [&_svg]:size-4 [&_svg]:text-faint'

export function MovePicker({ ids, onClose }: { ids: string[] | null; onClose: () => void }) {
  const { data: spaces } = useSpaces()
  const { data: list } = useChatList()
  const [q, setQ] = useState('')
  const chats = useMemo(() => knownChats(ids, list?.chats), [list, ids])
  const current = chats.length && chats.every((c) => c.space_id === chats[0].space_id) ? chats[0].space_id : undefined
  useEffect(() => setQ(''), [ids])
  const go = (s: Space | null) => {
    onClose()
    void moveWithUndo(chats, s)
  }
  return (
    <Dialog open={!!ids} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:p-0" aria-describedby={undefined} data-testid="move-picker">
        <DialogTitle className="border-b border-line px-4 py-3 pr-10 text-[13px]">
          Move {chats.length === 1 ? `“${chats[0].title || 'this chat'}”` : `${chats.length} chats`} to…
        </DialogTitle>
        <Command label="Spaces" loop>
          <Command.Input
            value={q}
            onValueChange={setQ}
            autoFocus
            placeholder="Find a space…"
            aria-label="Find a space"
            className="h-11 w-full border-b border-line bg-transparent px-4 text-[14px] text-fg outline-none placeholder:text-faint"
          />
          <Command.List className="max-h-[50vh] overflow-y-auto p-1.5 scrollbar-thin">
            <Command.Empty className="px-3 py-4 text-[13px] text-muted">No space is called that.</Command.Empty>
            {(spaces ?? []).map((s) => (
              <Command.Item key={s.id} value={`${s.name} ${s.id}`} className={pickItem} onSelect={() => go(s)}>
                <SpaceMark space={s} />
                <span className="flex-1 truncate">{s.name}</span>
                <span className="num text-xs text-faint">{s.chats}</span>
                {current === s.id ? <Check className="!text-fg" aria-label="here now" /> : null}
              </Command.Item>
            ))}
            <Command.Item value="no space none remove" className={pickItem} onSelect={() => go(null)}>
              <FolderMinus /> <span className="flex-1">No space</span>
              {current === null ? <Check className="!text-fg" aria-label="here now" /> : null}
            </Command.Item>
            <Command.Item
              value={`new space ${q}`}
              className={pickItem}
              onSelect={() => {
                const thenMove = ids ?? []
                onClose()
                chatUi.set((s) => ({ ...s, newSpace: { thenMove, name: q.trim() } }))
              }}
            >
              <Plus /> {q.trim() ? `New space “${q.trim()}”…` : 'New space…'}
            </Command.Item>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

// ------------------------------------------------------------------------------------------------------- deleting
export function DeleteChatsDialog({ ids, onClose, onDeleted }: { ids: string[] | null; onClose: () => void; onDeleted?: (ids: string[]) => void }) {
  const { data: list } = useChatList()
  const [busy, setBusy] = useState(false)
  const chats = useMemo(() => knownChats(ids, list?.chats), [list, ids])
  const n = chats.reduce((a, c) => a + c.messages, 0)
  // a chat not in the list nor open here: its count is not known
  const counted = chats.every((c) => c.created_at > 0)
  const one = chats.length === 1 ? chats[0] : null
  const run = async () => {
    if (!ids) return
    setBusy(true)
    try {
      // an answer being written is stopped by the server first, in the same call
      await deleteChats(chats.map((c) => c.id))
      toast.success(one ? `Deleted “${one.title || 'the chat'}”` : `Deleted ${chats.length} chats`)
      onDeleted?.(chats.map((c) => c.id))
      onClose()
    } catch (e) {
      fail('Deleting failed')(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!ids} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent aria-describedby="del-chat-desc" data-testid="delete-dialog">
        <DialogHeader>
          <DialogTitle>{one ? `Delete “${one.title || 'this chat'}”?` : `Delete ${chats.length} chats?`}</DialogTitle>
          <DialogDescription id="del-chat-desc">
            {!counted ? (one ? 'Its messages are' : 'Their messages are') : one ? `Its ${n} message${n === 1 ? ' is' : 's are'}` : `Their ${n} messages are`} removed from the server. This can’t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void run()} loading={busy} data-testid="confirm-delete">
            <Trash2 aria-hidden /> Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteSpaceDialog({ space, onClose, onDeleted }: { space: Space | null; onClose: () => void; onDeleted?: () => void }) {
  const [mode, setMode] = useState<'keep' | 'delete'>('keep')
  const [busy, setBusy] = useState(false)
  useEffect(() => setMode('keep'), [space])
  const run = async () => {
    if (!space) return
    setBusy(true)
    try {
      const r = await deleteSpace(space.id, mode)
      toast.success(
        mode === 'keep'
          ? `Deleted ${space.name}; its ${r.chats} chat${r.chats === 1 ? '' : 's'} moved to “No space”`
          : `Deleted ${space.name} and ${r.deleted_chats} chat${r.deleted_chats === 1 ? '' : 's'}`,
      )
      onDeleted?.()
      onClose()
    } catch (e) {
      fail('Deleting the space failed')(e)
    } finally {
      setBusy(false)
    }
  }
  const n = space?.chats ?? 0
  return (
    <Dialog open={!!space} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent aria-describedby="del-space-desc" data-testid="delete-space-dialog">
        <DialogHeader>
          <DialogTitle>
            Delete the space {space?.emoji} {space?.name}?
          </DialogTitle>
          <DialogDescription id="del-space-desc">
            {n ? `It has ${n} chat${n === 1 ? '' : 's'}. What happens to ${n === 1 ? 'it' : 'them'}?` : 'It has no chats.'}
          </DialogDescription>
        </DialogHeader>
        {n ? (
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as 'keep' | 'delete')} aria-label="Its chats">
            <div className="flex items-start gap-2.5">
              <RadioItem value="keep" id="sp-keep" className="mt-0.5" />
              <Label htmlFor="sp-keep" className="grid gap-0.5 font-normal">
                <span className="font-medium">Keep them</span>
                <span className="text-xs text-muted">They move to “No space”, as they are.</span>
              </Label>
            </div>
            <div className="flex items-start gap-2.5">
              <RadioItem value="delete" id="sp-del" className="mt-0.5" />
              <Label htmlFor="sp-del" className="grid gap-0.5 font-normal">
                <span className="font-medium text-error">Delete them too</span>
                <span className="text-xs text-muted">Removed from the server for good (an answer being written is stopped). This can’t be undone.</span>
              </Label>
            </div>
          </RadioGroup>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={mode === 'delete' ? 'danger' : 'primary'} onClick={() => void run()} loading={busy} data-testid="confirm-delete-space">
            {mode === 'delete' && n ? `Delete the space and ${n} chat${n === 1 ? '' : 's'}` : 'Delete the space'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ------------------------------------------------------------------------------------------------------- the host
/** Every chat dialog, opened through `chatUi`. */
export function ChatDialogs({ onDeleted }: { onDeleted?: (ids: string[]) => void }) {
  const ui = useStore(chatUi)
  const { data: spaces } = useSpaces()
  const { data: list } = useChatList()
  const navigate = useNavigate()
  const editing = ui.editSpace ? (spaces?.find((s) => s.id === ui.editSpace) ?? null) : null
  const delSpace = ui.deleteSpace ? (spaces?.find((s) => s.id === ui.deleteSpace) ?? null) : null
  const close = (k: keyof typeof ui) => chatUi.set((s) => ({ ...s, [k]: null }))
  const pending = ui.newSpace
  return (
    <>
      <MovePicker ids={ui.move} onClose={() => close('move')} />
      <SpaceDialog
        space={editing}
        initialName={pending?.name}
        open={!!ui.newSpace || !!editing}
        onOpenChange={(o) => {
          if (!o) chatUi.set((s) => ({ ...s, newSpace: null, editSpace: null }))
        }}
        onSaved={(s) => {
          const ids = pending?.thenMove
          if (ids?.length && !editing) {
            void moveWithUndo(knownChats(ids, list?.chats), s)
          } else if (!editing) void navigate({ to: '/chat', search: { space: s.id } })
        }}
      />
      <DeleteChatsDialog ids={ui.deleteChats} onClose={() => close('deleteChats')} onDeleted={onDeleted} />
      <DeleteSpaceDialog
        space={delSpace}
        onClose={() => close('deleteSpace')}
        onDeleted={() => {
          if (new URLSearchParams(location.search).get('space') === delSpace?.id) void navigate({ to: '/chat' })
        }}
      />
    </>
  )
}
