// The console's chat API (docs/CHAT-API.md): saved chats, spaces, messages as a tree, tool calls and their sources.

export interface Chat {
  id: string
  space_id: string | null
  title: string
  /** first: the question's first line; auto: written by the model; user: yours, never replaced */
  title_source: 'none' | 'first' | 'auto' | 'user'
  pinned: boolean
  web: boolean
  thinking: boolean
  head: string | null
  suggested_space: string | null
  created_at: number
  updated_at: number
  messages: number
  running: boolean
}

export type SpaceColor = '' | 'slate' | 'red' | 'orange' | 'amber' | 'green' | 'teal' | 'sky' | 'blue' | 'violet' | 'pink'

export interface Space {
  id: string
  name: string
  emoji: string
  color: SpaceColor
  instructions: string
  web: boolean | null
  thinking: boolean | null
  sort: number
  chats: number
  created_at: number
  updated_at: number
}

/** stopped: the answer ended (Stop, an error) before the call finished; skipped: not run (the tool budget was spent) */
export type ToolState = 'running' | 'waiting' | 'done' | 'error' | 'refused' | 'declined' | 'skipped' | 'stopped'

export interface ToolCall {
  id: string
  name: 'web_search' | 'open_page' | string
  args: { query?: string; url?: string }
  state: ToolState
  at: number
  summary?: string
  url?: string
  ms?: number
  chars?: number
  links?: string[]
  started?: number
}

export interface Source {
  n: number
  url: string
  title: string
  domain: string
  snippet?: string
  kind: 'result' | 'page'
  opened?: boolean
}

export interface MessageStats {
  preset?: string
  web?: boolean
  thinking?: boolean
  tool_calls?: number
  requests?: number
  ms?: number
  ttft_ms?: number | null
  prompt_tokens?: number
  context_tokens?: number
  completion_tokens?: number
  tok_s?: number
  finish?: string
}

export type MessageStatus = 'done' | 'streaming' | 'stopped' | 'error'

export interface Message {
  id: string
  chat_id: string
  parent_id: string | null
  role: 'user' | 'assistant' | 'note'
  content: string
  reasoning: string
  images: string[]
  tools: ToolCall[]
  sources: Source[]
  stats: MessageStats
  status: MessageStatus
  error: string | null
  created_at: number
  versions?: { index: number; count: number; ids: string[] }
}

export interface ChatDetail {
  chat: Chat
  messages: Message[]
  context: { used: number; max: number | null } | null
  space: Space | null
  suggested_space: Space | null
}

export interface ChatList {
  chats: Chat[]
  running: Record<string, string>
}

export interface ChatSettings {
  web_allowed: boolean
  web_default: boolean
  ask_before_open: boolean
  /** apps' open_page may open any public link, not only their own search results */
  apps_any_link?: boolean
  suggest_spaces: boolean
  max_tool_calls: number
  tool_time_s: number
  web_ready: boolean
  web_status: { ready: boolean; why: string | null; search: boolean | null; fetch: boolean | null; checked: number }
}

export interface SearchResult {
  chat: Chat
  score: number
  msg_id: string | null
  snippet: { text: string; highlights: Array<[number, number]> } | null
}

export interface TurnResult {
  chat: Chat
  user?: Message
  assistant: Message
}

/** One event of GET /api/chats/{id}/stream. */
export type StreamEvent =
  | {
      type: 'snapshot'
      message_id: string
      content: string
      reasoning: string
      tools: ToolCall[]
      sources: Source[]
      rid: string | null
      /** when that request was sent (unix seconds): the phase timer survives a reload or another device */
      rid_at?: number | null
      status: MessageStatus
      /** the error, when the run has just failed (status 'error') */
      error?: string | null
      /** not the server's: readStream adds the server's time from the response's Date header (unix seconds) */
      server_now?: number
    }
  | { type: 'request'; rid: string; /** unix seconds */ at?: number }
  | { type: 'delta'; content?: string; reasoning?: string }
  | { type: 'tool'; tool: ToolCall }
  | { type: 'sources'; sources: Source[] }
  | { type: 'done' | 'stopped'; stats?: MessageStats }
  /** status: the HTTP code of the engine's failure, when there was one */
  | { type: 'error'; error: string; status?: number }
  | { type: 'idle' }

/** A `chats` topic event (the sidebar on every open console). */
export type ChatsEvent =
  | { type: 'chat'; chat: Chat; running?: boolean; titled?: boolean }
  | { type: 'chat.deleted'; id: string }
  | { type: 'space'; space: Space }
  | { type: 'spaces'; spaces: Space[] }
  | { type: 'space.deleted'; id: string; chats: 'keep' | 'delete' }
