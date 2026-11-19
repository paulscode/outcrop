# The chat API

The console's chat endpoints, for the web UI. [CONSOLE.md](CONSOLE.md) describes the chat as you use it. The code is in
`console/outcrop/console/chatapi.py` (routes), `chatrun.py` (answers and tools), `chatdb.py` (storage and search) and
`webtools.py` (search and pages). The tests in `console/tests/test_chat.py` show every call in use.

All calls need the console session, or an admin API token as `Authorization: Bearer` (for automation; it needs no
`X-Outcrop` header, and it never counts as the password entered again). Changes need the usual `X-Outcrop: 1` header and JSON bodies, exactly as the rest of
the console does (`api.post` in `web/src/lib/api.ts`).

## Objects

```ts
interface Chat {
  id: string
  space_id: string | null
  title: string
  title_source: 'none' | 'first' | 'auto' | 'user' // first: the question's first line; auto: written by the model
  pinned: boolean
  web: boolean // this chat's 🌐 switch
  thinking: boolean
  head: string | null // the newest message of the branch on screen
  suggested_space: string | null // a space id the model thinks fits; null when none or dismissed
  created_at: number // unix seconds
  updated_at: number
  messages: number // count, all versions
  running: boolean // an answer is being written now
}

interface Space {
  id: string
  name: string // unique, case-insensitive; at most 40 characters
  emoji: string // '' or one emoji
  color: '' | 'slate' | 'red' | 'orange' | 'amber' | 'green' | 'teal' | 'sky' | 'blue' | 'violet' | 'pink'
  instructions: string // up to 8000 characters; every chat in the space gets them
  web: boolean | null // a default for new chats here (null: the global default)
  thinking: boolean | null
  sort: number
  chats: number // count
  created_at: number
  updated_at: number
}

interface Message {
  id: string
  chat_id: string
  parent_id: string | null
  role: 'user' | 'assistant' | 'note' // note: the summary a "continued" chat starts from
  content: string // Markdown (answers); the user's text
  reasoning: string // the model's thinking, if any
  images: string[] // data: URLs (user messages)
  tools: ToolCall[] // in the order they ran
  sources: Source[] // numbered 1..n across the answer; [n] in content refers to these
  stats: {
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
  status: 'done' | 'streaming' | 'stopped' | 'error'
  error: string | null
  created_at: number
  versions: { index: number; count: number; ids: string[] } // siblings: ‹ index+1 / count ›
}

interface ToolCall {
  id: string
  name: 'web_search' | 'open_page' | string
  args: { query?: string; url?: string }
  state: 'running' | 'waiting' | 'done' | 'error' | 'refused' | 'declined' | 'skipped' | 'stopped'
  // waiting: "ask before opening pages" is on; answer it with POST .../tools/{id}
  at: number // where in `content` the call happened (characters): draw the call there
  summary?: string // the line to show: 'Searched "x" · 5 results', 'Read nvidia.com · Title', 'Refused a link…'
  url?: string // the page waiting for your yes or no
  ms?: number
  chars?: number
  links?: string[]
}

interface Source {
  n: number
  url: string
  title: string
  domain: string
  snippet?: string
  kind: 'result' | 'page'
  opened?: boolean // the model read the page, not just the search result
}
```

Show as citations only the sources whose `[n]` appears in the answer. List the opened ones first.

## Chats

**Input rules:**
- Booleans must be JSON booleans (`true`/`false`), and numbers whole numbers; anything else is a 400.
- A message holds at most 200 KB of text and 8 pictures, each at most 8 MB, as PNG, JPEG, GIF or WebP `data:` URLs,
  and 32 MB in all. A 9th picture, a picture over 8 MB or another type is a 400; a body over 32 MB a 413.
- `/head` answers 409 while an answer is being written and 404 for a message not in the chat; `/summarize` 502 when the
  engine fails.
- Settings changes that widen access need the password entered in the last 10 minutes (403 `{detail: {reauth: true, message}}`; a token
  session can't make them): `web_allowed` or `apps_any_link` on, `web_default` on, `ask_before_open` off, and
  `max_tool_calls` or `tool_time_s` raised.
- An answer can also end in an error saying it was cut off, or that the model kept asking for tools.
- A summary note carries `stats.carried_links`: the links the old chat could open.

| Call | What |
| --- | --- |
| `GET /api/chats?space=ID\|none&limit=&before=` | `{chats: Chat[], running: {chat_id: message_id}}`, newest first. |
| `POST /api/chats {space_id?, web?, thinking?, content?, images?}` | A new chat. With `content` (or `images`), its first question is sent at once: `{chat, user, assistant}`; then open the stream. `web` defaults to the space's, then to `web_default`; `thinking` to the space's, then on. |
| `GET /api/chats/{id}` | `{chat, messages: Message[] (the branch on screen, root first), context: {used, max}, space, suggested_space}`. `context.max` is the running preset's context window. |
| `PATCH /api/chats/{id} {title?, space_id?, pinned?, web?, thinking?, suggested_space: null?}` | Rename (`title_source` becomes `user`; never replaced after). Move (`space_id: null` for no space). `suggested_space: null` dismisses the suggestion. |
| `DELETE /api/chats/{id}?stop=1` | Delete for good: `{chats: 1, messages: n, ids}`. While an answer is being written: 409, or with `stop=1` it is stopped first. |
| `POST /api/chats/delete {ids, stop?}` | Several (at most 500): `{chats, messages, ids}`. 409 if one is answering, unless `stop: true`. |
| `POST /api/chats/move {ids, space_id}` | Several. `{moved: n}`. |
| `POST /api/chats/{id}/turns {content, images?, parent_id?, web?, thinking?}` | Ask. `parent_id`: edit an earlier question by sending its parent, a finished answer or a note (`""` for the first question); this makes a new version. `{user, assistant, chat}`. 409 if an answer is already being written. `web` and `thinking` apply only if the turn starts. |
| `POST /api/chats/{id}/turns {regenerate: ANSWER_ID}` | Another answer to the same question (a new version). |
| `POST /api/chats/{id}/stop` | Stop the answer; what was written is kept (`status: 'stopped'`). |
| `GET /api/chats/{id}/stream` | Server-sent events for the answer being written (below). With nothing running it sends `{type: 'idle'}` and ends. |
| `POST /api/chats/{id}/head {message_id}` | Show another version: that message and the newest branch under it. Returns the same as `GET /api/chats/{id}`. |
| `POST /api/chats/{id}/tools/{call_id} {allow}` | The answer to a `waiting` page (ask before opening). |
| `POST /api/chats/{id}/title` | Ask the model for a title again; it replaces any title, yours too (only the automatic title never replaces yours). Returns the Chat. It waits for an idle engine, at most 30 s. |
| `POST /api/chats/{id}/summarize` | A new chat that starts from a summary of this one: `{chat}`. It takes as long as an answer (10–60 s). |
| `GET /api/chats/{id}/export` | Markdown (an attachment). |
| `GET /api/chats/export` | Every chat as JSON (an attachment). |
| `GET /api/chats/stats` | For Overview: `{chats, messages, spaces, answers, searches, pages, refused, since}`. The last four count from local midnight. |
| `GET /api/chats/search?q=&space=&limit=` | `{q, results: [{chat, score, msg_id \| null, snippet: {text, highlights: [[start, end]]} \| null}]}`. `msg_id` is the message that matched (null: the title matched). `q` may contain `in:NAME` to narrow to a space (prefix match on the name). It is forgiving of typos. |

### The answer stream

`GET /api/chats/{id}/stream` sends `data: {json}` lines:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `snapshot` | `message_id, content, reasoning, tools, sources, rid, rid_at, status` | Everything so far. Always first: replace, don't append. |
| `request` | `rid, at` (when it was sent, server time) | Each request to the engine (one per tool round). The live `requests` topic has that request's phase: held during a switch, reading the prompt with %, writing. |
| `delta` | `content?`, `reasoning?` | Append. |
| `tool` | `tool: ToolCall` | Upsert by `tool.id`. |
| `sources` | `sources: Source[]` | Replace. |
| `done` / `stopped` | `stats` | The end. Reload the chat for the final message. |
| `error` | `error, status?` | The end. The message keeps `status: 'error'` and the error text. |
| `idle` | | Nothing is running. |

Comment lines (`: keepalive`) come every 15 s. If the connection breaks, open it again: you get a fresh snapshot.
`EventSource` works (it sends the cookie).

## Spaces

| Call | What |
| --- | --- |
| `GET /api/spaces` | `Space[]` in order. |
| `POST /api/spaces {name, emoji?, color?, instructions?, web?, thinking?}` | Create. 400 for a duplicate name. |
| `PATCH /api/spaces/{id} {...}` | Change. |
| `PUT /api/spaces/order {ids}` | Reorder. |
| `DELETE /api/spaces/{id}?chats=keep\|delete` | `keep` (the default) moves its chats to no space. `{space, chats, deleted_chats, ids}`. With `delete`, a `chat.deleted` event goes out for each chat. |

## Settings

`GET /api/chat/settings`:

```ts
{
  web_allowed: boolean // the master switch: false blocks web for every chat and greys out 🌐
  web_default: boolean // 🌐 for new chats
  apps_any_link: boolean // apps' web tools (POST /tools/mcp) may open any public link; off by default
  ask_before_open: boolean
  suggest_spaces: boolean
  max_tool_calls: number // 1..20
  tool_time_s: number // 10..300
  web_ready: boolean // search is reachable and allowed
  web_status: { ready: boolean; why: string | null; search: boolean | null; fetch: boolean | null; checked: number }
}
```

`PUT /api/chat/settings {any of those}` returns the same. Turning `web_allowed` on needs the password entered in the
last 10 minutes: a 403 with `{detail: {reauth: true, message}}`, the same as the other changes that widen access, already handled by the
UI's reauth dialog.

## Live updates

Subscribe to the WebSocket topic **`chats`**, the same way as the other topics. Events (`d`):

- `{type: 'chat', chat, running?, titled?}`: a chat was created or changed (title, space, pin, running). `titled: true`
  means the model just wrote the title, so animate it in.
- `{type: 'chat.deleted', id}`
- `{type: 'space', space}`, `{type: 'spaces', spaces}`
- `{type: 'space.deleted', id, chats: 'keep'|'delete'}`

These keep the sidebar the same on every open console.

## The dev stack

`cd console && uv run python dev.py --fresh` (or `.venv/bin/python dev.py --fresh`) runs everything without a GPU or
the internet:

- **The fake model writes Markdown.** Answers include a heading, a list, a table, code and math, with thinking first,
  at 40 tok/s.
- **It searches on its own.** When a question contains *latest, today, news, current, price, weather, search, look up,
  this week* or *recent*, and the chat's 🌐 is on, it calls `web_search`, opens the first result, then answers with
  citations [1] and [2].
- **Search and pages are fake.** A fake SearXNG and a fake page fetcher make the results up.
- **Titles arrive a few seconds after the first answer.**
- **Calls on cue.** `[[call web_search {"query": "x"}]]` in a question makes the fake call exactly that, which is
  useful for e2e tests. `hxxps://` in such a call becomes `https://` without counting as a link you wrote.
