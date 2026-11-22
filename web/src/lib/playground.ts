// The playground's requests: the exact OpenAI chat-completions body it sends, and the same request as curl, Python or
// JavaScript for "View as code" (with a $TOKEN placeholder, never a real token).

import type { StreamState, ToolCall } from './sse'

export interface Params {
  system: string
  thinking: boolean
  maxTokens: number
  temperature: number
  topP: number
  toolsOn: boolean
  tools: string
}

export const DEFAULT_PARAMS: Params = {
  system: '',
  thinking: true,
  maxTokens: 2048,
  temperature: 0.6,
  topP: 0.95,
  toolsOn: false,
  tools: `[
  {
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "The current weather in a city",
      "parameters": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      }
    }
  }
]`,
}

export interface UserMsg {
  id: string
  role: 'user'
  text: string
  images: string[]
}

export type AssistantStatus = 'queued' | 'waiting' | 'streaming' | 'done' | 'stopped' | 'error'

export interface AssistantMsg {
  id: string
  role: 'assistant'
  status: AssistantStatus
  s: StreamState
  startedAt: number | null
  rid: string | null
  error?: string
  /** what the request asked for (thinking on/off etc.), shown with the answer */
  params: Params
  /** what each tool call returned, one per call in order, as typed into the playground (the playground acts as the app) */
  toolResults?: string[]
}

export type Msg = UserMsg | AssistantMsg

/** The tools JSON, if it is a valid list; otherwise the reason it is not. */
export function parseTools(text: string): { ok: true; tools: unknown[] } | { ok: false; error: string } {
  try {
    const v = JSON.parse(text)
    if (!Array.isArray(v)) return { ok: false, error: 'the tools must be a JSON list: [ {"type": "function", …} ]' }
    for (const [i, t] of v.entries()) {
      const fn = (t as { function?: { name?: unknown } })?.function
      if (!t || typeof t !== 'object' || (t as { type?: unknown }).type !== 'function' || !fn || typeof fn.name !== 'string')
        return { ok: false, error: `tool ${i + 1} needs "type": "function" and a function with a "name"` }
    }
    return { ok: true, tools: v }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** The call's own id, or a stable one when the engine sent none. */
export function toolCallId(msgId: string, t: ToolCall): string {
  return t.id || `call_${msgId}_${t.index}`
}

/** The request body for the conversation so far (the last message is the new user message). */
export function buildBody(params: Params, messages: Msg[], model: string): Record<string, unknown> {
  const out: Array<Record<string, unknown>> = []
  if (params.system.trim()) out.push({ role: 'system', content: params.system })
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.images.length) {
        out.push({
          role: 'user',
          content: [
            ...(m.text ? [{ type: 'text', text: m.text }] : []),
            ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        })
      } else out.push({ role: 'user', content: m.text })
    } else if ((m.status === 'done' || m.status === 'stopped') && (m.s.content || m.s.toolCalls.length)) {
      const results = m.toolResults
      if (m.s.toolCalls.length && results && results.length === m.s.toolCalls.length) {
        // the call and what it returned, linked by the call's id, so the model can answer from the result
        const ids = m.s.toolCalls.map((t) => toolCallId(m.id, t))
        out.push({
          role: 'assistant',
          content: m.s.content,
          tool_calls: m.s.toolCalls.map((t, i) => ({ id: ids[i], type: 'function', function: { name: t.name, arguments: t.arguments || '{}' } })),
        })
        m.s.toolCalls.forEach((_, i) => out.push({ role: 'tool', tool_call_id: ids[i], content: results[i] }))
      } else if (m.s.content) {
        // a call nobody answered is left out: an assistant tool call needs its result after it
        out.push({ role: 'assistant', content: m.s.content })
      }
    }
  }
  const body: Record<string, unknown> = {
    model,
    messages: out,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: params.maxTokens,
    temperature: params.temperature,
    top_p: params.topP,
    chat_template_kwargs: { enable_thinking: params.thinking },
  }
  if (params.toolsOn) {
    const t = parseTools(params.tools)
    if (t.ok && t.tools.length) body.tools = t.tools
  }
  return body
}

// ------------------------------------------------------------------------------------------------- view as code
/** Data URLs of pictures, shortened for showing (the real request carries them whole). */
export function shortenImages(body: unknown): { body: unknown; shortened: number } {
  let n = 0
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('data:image/') && v.length > 120) {
      n++
      const kb = Math.round((v.length * 3) / 4 / 1024)
      return `${v.slice(0, v.indexOf(',') + 1)}…(${kb} KB)`
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  const b = walk(body)
  return { body: b, shortened: n }
}

/** A JSON value as a Python literal (True/False/None, the same strings and numbers). */
export function toPython(v: unknown, indent = 0): string {
  const pad = (n: number) => '    '.repeat(n)
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'None'
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    if (v.every((x) => x === null || typeof x !== 'object')) {
      const flat = `[${v.map((x) => toPython(x)).join(', ')}]`
      if (flat.length < 72) return flat
    }
    return `[\n${v.map((x) => pad(indent + 1) + toPython(x, indent + 1)).join(',\n')},\n${pad(indent)}]`
  }
  const entries = Object.entries(v as Record<string, unknown>)
  if (!entries.length) return '{}'
  const flat = `{${entries.map(([k, x]) => `${JSON.stringify(k)}: ${toPython(x, indent)}`).join(', ')}}`
  if (flat.length < 72 && !flat.includes('\n')) return flat
  return `{\n${entries.map(([k, x]) => `${pad(indent + 1)}${JSON.stringify(k)}: ${toPython(x, indent + 1)}`).join(',\n')},\n${pad(indent)}}`
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export interface CodeViews {
  curl: string
  python: string
  js: string
  shortened: number
}

/** curl, Python (openai SDK) and JavaScript (openai SDK) for the exact request, against the gateway's OpenAI URL. */
export function codeViews(body: Record<string, unknown>, baseUrl: string): CodeViews {
  const { body: shown, shortened } = shortenImages(body)
  const b = shown as Record<string, unknown>
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
  const curl = `curl -N ${url} \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d ${shellQuote(JSON.stringify(b, null, 2))}`

  const { model, messages, stream: _s, stream_options: _so, chat_template_kwargs, ...rest } = b
  const pyArgs: string[] = [`    model=${toPython(model)}`, `    messages=${toPython(messages, 1)}`]
  for (const [k, v] of Object.entries(rest)) pyArgs.push(`    ${k}=${toPython(v, 1)}`)
  pyArgs.push('    stream=True', '    stream_options={"include_usage": True}')
  if (chat_template_kwargs) pyArgs.push(`    extra_body={"chat_template_kwargs": ${toPython(chat_template_kwargs, 1)}}`)
  const python = `import os
from openai import OpenAI

client = OpenAI(base_url=${JSON.stringify(baseUrl)}, api_key=os.environ["TOKEN"])
stream = client.chat.completions.create(
${pyArgs.join(',\n')},
)
for chunk in stream:
    if not chunk.choices:
        continue
    delta = chunk.choices[0].delta
    thinking = getattr(delta, "reasoning_content", None)
    if thinking:
        print(thinking, end="", flush=True)   # the model's thinking
    if delta.content:
        print(delta.content, end="", flush=True)
print()`

  const jsBody = JSON.stringify(b, null, 2)
    .split('\n')
    .map((l, i) => (i ? `  ${l}` : l))
    .join('\n')
  const js = `import OpenAI from 'openai'

const client = new OpenAI({ baseURL: ${JSON.stringify(baseUrl)}, apiKey: process.env.TOKEN })
// chat_template_kwargs is passed through to the model as it is
const stream = await client.chat.completions.create(${jsBody})
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta ?? {}
  if (delta.reasoning_content) process.stdout.write(delta.reasoning_content) // the model's thinking
  if (delta.content) process.stdout.write(delta.content)
}
process.stdout.write('\\n')`
  return { curl, python, js, shortened }
}

/** A short id for messages. */
export function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}
