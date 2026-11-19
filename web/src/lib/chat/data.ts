// The chat page's data: TanStack Query caches for the chat list, the spaces, each open chat and the settings, kept in
// step with the live `chats` topic, plus the actions (create, ask, move, delete…) that update the caches at once.

import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api, ApiError } from '../api'
import { live } from '../live'
import { queryClient } from '../queries'
import { createStore, useStore } from '../store'
import { dropDraft } from './drafts'
import { applyTurn, mergeFirstPage, upsertChat } from './logic'
import type { Chat, ChatDetail, ChatList, ChatSettings, ChatsEvent, SearchResult, Space, TurnResult } from './types'

export const ck = {
  list: ['chats'] as const,
  spaces: ['spaces'] as const,
  chat: (id: string) => ['chat', id] as const,
  settings: ['chat-settings'] as const,
  search: (q: string) => ['chat-search', q] as const,
}

const PAGE = 400

export interface ListData {
  chats: Chat[]
  more: boolean
  /** older pages were loaded ("Show older chats"): a refetch of the first page keeps them */
  older?: boolean
}

async function fetchList(): Promise<ListData> {
  const r = await api.get<ChatList>(`/api/chats?limit=${PAGE}`)
  return mergeFirstPage(queryClient.getQueryData<ListData>(ck.list), r.chats, PAGE)
}

export const useChatList = () => useQuery({ queryKey: ck.list, queryFn: fetchList, staleTime: 30_000 })
export const useSpaces = () => useQuery({ queryKey: ck.spaces, queryFn: () => api.get<Space[]>('/api/spaces'), staleTime: 30_000 })
export const useChatSettings = () =>
  useQuery({ queryKey: ck.settings, queryFn: () => api.get<ChatSettings>('/api/chat/settings'), staleTime: 15_000, refetchInterval: 60_000 })
export const useChat = (id: string | null) =>
  useQuery({
    queryKey: ck.chat(id ?? ''),
    queryFn: () => api.get<ChatDetail>(`/api/chats/${encodeURIComponent(id!)}`),
    enabled: !!id,
    staleTime: 10_000,
  })

export const useChatSearch = (q: string) =>
  useQuery({
    queryKey: ck.search(q),
    queryFn: ({ signal }) => api.get<{ q: string; results: SearchResult[] }>(`/api/chats/search?q=${encodeURIComponent(q)}&limit=30`, { signal }),
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
    staleTime: 5_000,
  })

/** Older chats, beyond the first page. */
export async function loadOlder() {
  const cur = queryClient.getQueryData<ListData>(ck.list)
  if (!cur?.chats.length) return
  const oldest = Math.min(...cur.chats.map((c) => c.updated_at))
  const r = await api.get<ChatList>(`/api/chats?limit=${PAGE}&before=${oldest}`)
  queryClient.setQueryData<ListData>(ck.list, (p) => {
    const base = p?.chats ?? []
    let out = base
    for (const c of r.chats) out = upsertChat(out, c)
    return { chats: out, more: r.chats.length >= PAGE, older: true }
  })
}

// --------------------------------------------------------------------------------------------- the cache, updated
export function putChat(c: Chat) {
  queryClient.setQueryData<ListData>(ck.list, (p) => (p ? { ...p, chats: upsertChat(p.chats, c) } : p))
  queryClient.setQueryData<ChatDetail>(ck.chat(c.id), (p) => (p ? { ...p, chat: { ...p.chat, ...c } } : p))
}

function dropChat(id: string) {
  queryClient.setQueryData<ListData>(ck.list, (p) => (p ? { ...p, chats: p.chats.filter((c) => c.id !== id) } : p))
  queryClient.removeQueries({ queryKey: ck.chat(id) })
  dropDraft(id)
}

/**
 * The chats behind some ids, for the dialogs: from the list, else from an open chat's cache (an older chat opened from
 * search, or before the list has loaded), else a bare stand-in that still carries the id.
 */
/** A stand-in from knownChats: only its id is known (not its space, title or count). */
export function isStandIn(c: Chat): boolean {
  return c.created_at === 0
}

export function knownChats(ids: string[] | null, list: Chat[] | undefined): Chat[] {
  if (!ids) return []
  return ids.map((id) => {
    const c = list?.find((x) => x.id === id) ?? queryClient.getQueryData<ChatDetail>(ck.chat(id))?.chat
    return (
      c ?? {
        id,
        space_id: null,
        title: '',
        title_source: 'none',
        pinned: false,
        web: false,
        thinking: false,
        head: null,
        suggested_space: null,
        created_at: 0,
        updated_at: 0,
        messages: 0,
        running: false,
      }
    )
  })
}

function putSpace(s: Space) {
  queryClient.setQueryData<Space[]>(ck.spaces, (p) => {
    if (!p) return p
    const out = p.some((x) => x.id === s.id) ? p.map((x) => (x.id === s.id ? s : x)) : [...p, s]
    return out.sort((a, b) => a.sort - b.sort)
  })
}

/** Titles the model has just written: they type themselves in where they are shown. */
export const titledStore = createStore<Record<string, number>>({})

/** A title just written (old marks are dropped, so the map stays small in a tab open for days). */
export function markTitled(id: string) {
  const now = Date.now()
  titledStore.set((p) => {
    const out: Record<string, number> = { [id]: now }
    for (const [k, t] of Object.entries(p)) if (k !== id && now - t < 10_000) out[k] = t
    return out
  })
}

/** A space is gone (here or on another device): its chats left it, or were deleted with it. */
function forgetSpace(id: string, chats: 'keep' | 'delete') {
  queryClient.setQueryData<Space[]>(ck.spaces, (p) => p?.filter((s) => s.id !== id))
  const list = queryClient.getQueryData<ListData>(ck.list)?.chats ?? []
  if (chats === 'delete') for (const c of list.filter((x) => x.space_id === id)) dropChat(c.id)
  // open chats show the space (its chip, "Using its instructions"), or are gone with it
  for (const [key, d] of queryClient.getQueriesData<ChatDetail>({ queryKey: ['chat'] })) {
    if (d?.chat.space_id === id || d?.space?.id === id) {
      if (chats === 'delete') queryClient.removeQueries({ queryKey: key })
      else void queryClient.invalidateQueries({ queryKey: key })
    }
  }
  void queryClient.invalidateQueries({ queryKey: ck.list })
}

export function useJustTitled(id: string | null | undefined): boolean {
  return useStore(titledStore, (s) => (id ? !!s[id] && Date.now() - s[id] < 4000 : false))
}

function onEvent(ev: ChatsEvent) {
  switch (ev.type) {
    case 'chat': {
      const c = ev.running === undefined ? ev.chat : { ...ev.chat, running: ev.running }
      const known = queryClient.getQueryData<ChatDetail>(ck.chat(c.id))
      const listed = queryClient.getQueryData<ListData>(ck.list)?.chats.find((x) => x.id === c.id)
      putChat(c)
      if (ev.titled) markTitled(c.id)
      // the suggested space and the branch on screen come with the full chat: fetch it when they may have changed
      if (known && (ev.titled || known.chat.head !== c.head || known.chat.space_id !== c.space_id || ev.running !== undefined))
        void queryClient.invalidateQueries({ queryKey: ck.chat(c.id) })
      // a space's count changed: only when the chat came, left or moved
      const before = known?.chat ?? listed
      if (!before || before.space_id !== c.space_id) void queryClient.invalidateQueries({ queryKey: ck.spaces })
      break
    }
    case 'chat.deleted':
      dropChat(ev.id)
      void queryClient.invalidateQueries({ queryKey: ck.spaces })
      break
    case 'space':
      putSpace(ev.space)
      break
    case 'spaces':
      queryClient.setQueryData<Space[]>(ck.spaces, ev.spaces)
      break
    case 'space.deleted':
      forgetSpace(ev.id, ev.chats)
      break
  }
}

/** Everything the chat page shows, fetched again: what changed while nobody was listening. */
function resync() {
  // older chats loaded before are not kept: one deleted meanwhile would stay (its chat.deleted was missed)
  queryClient.setQueryData<ListData>(ck.list, (p) => (p?.older ? { ...p, older: false } : p))
  void queryClient.invalidateQueries({ queryKey: ck.list })
  void queryClient.invalidateQueries({ queryKey: ck.spaces })
  void queryClient.invalidateQueries({ queryKey: ['chat'] })
}

/** Keep the sidebar and the open chat the same on every console: the `chats` topic, while the page is open. */
export function useChatsLive() {
  useEffect(() => {
    const off = live.on('chats', (m) => {
      if (m.snapshot) return
      onEvent(m.d as ChatsEvent)
    })
    void queryClient.invalidateQueries({ queryKey: ck.list })
    // the topic's events are not replayed: after the connection comes back, catch up on what was missed
    let was = live.status.get()
    const offStatus = live.status.subscribe(() => {
      const now = live.status.get()
      if (now === 'open' && was !== 'open' && was !== 'idle' && was !== 'connecting') resync()
      was = now
    })
    return () => {
      off()
      offStatus()
    }
  }, [])
}

// --------------------------------------------------------------------------------------------------------- actions
const enc = encodeURIComponent

export async function createChat(body: { space_id?: string | null; web?: boolean; thinking?: boolean; content?: string; images?: string[] }) {
  const r = await api.post<TurnResult & { chat: Chat }>('/api/chats', body)
  putChat(r.chat)
  if (r.assistant) {
    queryClient.setQueryData<ChatDetail>(ck.chat(r.chat.id), {
      chat: r.chat,
      messages: applyTurn([], r),
      context: null,
      space: queryClient.getQueryData<Space[]>(ck.spaces)?.find((s) => s.id === r.chat.space_id) ?? null,
      suggested_space: null,
    })
  }
  if (r.chat.space_id) void queryClient.invalidateQueries({ queryKey: ck.spaces })
  return r
}

export async function ask(id: string, body: { content?: string; images?: string[]; parent_id?: string; regenerate?: string; web?: boolean; thinking?: boolean }) {
  const r = await api.post<TurnResult>(`/api/chats/${enc(id)}/turns`, body)
  queryClient.setQueryData<ChatDetail>(ck.chat(id), (p) => (p ? { ...p, chat: r.chat, messages: applyTurn(p.messages, r) } : p))
  putChat(r.chat)
  // the versions (‹ 2 / 3 ›) come with the full chat
  void queryClient.invalidateQueries({ queryKey: ck.chat(id) })
  return r
}

export async function patchChat(id: string, body: Partial<Pick<Chat, 'title' | 'space_id' | 'pinned' | 'web' | 'thinking'>> & { suggested_space?: null }) {
  const c = await api.patch<Chat>(`/api/chats/${enc(id)}`, body)
  putChat(c)
  if ('space_id' in body || 'suggested_space' in body) {
    void queryClient.invalidateQueries({ queryKey: ck.chat(id) })
    void queryClient.invalidateQueries({ queryKey: ck.spaces })
  }
  return c
}

export async function moveChats(ids: string[], space_id: string | null) {
  // at once on screen; the server's answer (and the live events) confirm it, and a failure puts them back
  const was = new Map((queryClient.getQueryData<ListData>(ck.list)?.chats ?? []).filter((c) => ids.includes(c.id)).map((c) => [c.id, c.space_id]))
  queryClient.setQueryData<ListData>(ck.list, (p) => (p ? { ...p, chats: p.chats.map((c) => (ids.includes(c.id) ? { ...c, space_id } : c)) } : p))
  try {
    const r = await api.post<{ moved: number }>('/api/chats/move', { ids, space_id })
    return r
  } catch (e) {
    queryClient.setQueryData<ListData>(ck.list, (p) =>
      p ? { ...p, chats: p.chats.map((c) => (was.has(c.id) && c.space_id === space_id ? { ...c, space_id: was.get(c.id) ?? null } : c)) } : p,
    )
    void queryClient.invalidateQueries({ queryKey: ck.list })
    throw e
  } finally {
    void queryClient.invalidateQueries({ queryKey: ck.spaces })
    for (const id of ids) void queryClient.invalidateQueries({ queryKey: ck.chat(id) })
  }
}

/** Delete for good; an answer being written in one of them is stopped first (by the server, in the same call). */
export async function deleteChats(ids: string[]) {
  const r =
    ids.length === 1
      ? await api.del<{ chats: number; messages: number }>(`/api/chats/${enc(ids[0])}?stop=1`).catch((e: unknown) => {
          // already gone (deleted on another device): that is what was asked
          if (e instanceof ApiError && e.status === 404) return { chats: 0, messages: 0 }
          throw e
        })
      : await api.post<{ chats: number; messages: number }>('/api/chats/delete', { ids, stop: true })
  for (const id of ids) dropChat(id)
  void queryClient.invalidateQueries({ queryKey: ck.spaces })
  return r
}

export async function stopChat(id: string) {
  return api.post<{ stopped: boolean }>(`/api/chats/${enc(id)}/stop`)
}

export async function showVersion(id: string, message_id: string) {
  const r = await api.post<ChatDetail>(`/api/chats/${enc(id)}/head`, { message_id })
  queryClient.setQueryData(ck.chat(id), r)
  putChat(r.chat)
  return r
}

export async function answerTool(id: string, callId: string, allow: boolean) {
  return api.post(`/api/chats/${enc(id)}/tools/${enc(callId)}`, { allow })
}

export async function suggestTitle(id: string) {
  const c = await api.post<Chat>(`/api/chats/${enc(id)}/title`)
  putChat(c)
  markTitled(c.id)
  return c
}

export async function summarize(id: string) {
  const r = await api.post<{ chat: Chat }>(`/api/chats/${enc(id)}/summarize`)
  putChat(r.chat)
  return r.chat
}

export async function createSpace(body: Partial<Space> & { name: string }) {
  const s = await api.post<Space>('/api/spaces', body)
  putSpace(s)
  return s
}

export async function updateSpace(id: string, body: Partial<Space>) {
  const s = await api.patch<Space>(`/api/spaces/${enc(id)}`, body)
  putSpace(s)
  for (const q of queryClient.getQueriesData<ChatDetail>({ queryKey: ['chat'] })) {
    if (q[1]?.space?.id === id) queryClient.setQueryData<ChatDetail>(q[0], { ...q[1], space: s })
  }
  return s
}

export async function orderSpaces(ids: string[]) {
  queryClient.setQueryData<Space[]>(ck.spaces, (p) => (p ? ids.map((id, i) => ({ ...p.find((s) => s.id === id)!, sort: i })).filter((s) => s.id) : p))
  await api.put('/api/spaces/order', { ids })
}

/** Delete a space; with `delete`, its chats too, an answer being written in one of them stopped first (by the server). */
export async function deleteSpace(id: string, chats: 'keep' | 'delete') {
  const r = await api.del<{ space: string; chats: number; deleted_chats: number; ids?: string[] }>(
    `/api/spaces/${enc(id)}?chats=${chats}${chats === 'delete' ? '&stop=1' : ''}`,
  )
  // here at once, without waiting for the live events (which may not come while the connection is down)
  for (const cid of r.ids ?? []) dropChat(cid)
  forgetSpace(id, chats)
  return r
}

export async function saveChatSettings(body: Partial<ChatSettings>) {
  const r = await api.put<ChatSettings>('/api/chat/settings', body)
  queryClient.setQueryData(ck.settings, r)
  return r
}

// ----------------------------------------------------------------------------------------- page-wide UI requests
/** Requests from outside the chat page's components (the ⌘K palette, shortcuts) to open its dialogs. */
export interface ChatUi {
  move: string[] | null
  newSpace: { thenMove?: string[]; name?: string } | null
  editSpace: string | null
  deleteChats: string[] | null
  deleteSpace: string | null
  rename: string | null
}
export const chatUi = createStore<ChatUi>({ move: null, newSpace: null, editSpace: null, deleteChats: null, deleteSpace: null, rename: null })
export const openChatUi = (p: Partial<ChatUi>) => chatUi.set((s) => ({ ...s, ...p }))
