import { describe, expect, it } from 'vitest'
import { buildBody, codeViews, DEFAULT_PARAMS, parseTools, shortenImages, toPython, type Msg } from './playground'
import { emptyStream } from './sse'

const done = (content: string): Msg => ({
  id: 'a',
  role: 'assistant',
  status: 'done',
  s: { ...emptyStream(), content, phase: 'done' },
  startedAt: 1,
  rid: 'req_1',
  params: DEFAULT_PARAMS,
})

describe('buildBody', () => {
  it('sends the conversation, the system prompt and the thinking switch', () => {
    const msgs: Msg[] = [
      { id: '1', role: 'user', text: 'hi', images: [] },
      done('hello'),
      { id: '2', role: 'user', text: 'and?', images: [] },
    ]
    const b = buildBody({ ...DEFAULT_PARAMS, system: 'Be brief.', thinking: false, maxTokens: 64 }, msgs, 'qwen')
    expect(b.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'and?' },
    ])
    expect(b).toMatchObject({
      model: 'qwen',
      stream: true,
      max_tokens: 64,
      chat_template_kwargs: { enable_thinking: false },
      stream_options: { include_usage: true },
    })
    expect(b.tools).toBeUndefined()
  })

  it('leaves out failed answers and sends pictures as image_url parts', () => {
    const failed: Msg = { ...(done('') as Extract<Msg, { role: 'assistant' }>), status: 'error' }
    const b = buildBody(DEFAULT_PARAMS, [{ id: '1', role: 'user', text: 'what is this?', images: ['data:image/png;base64,AAAA'] }, failed], 'm')
    expect(b.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ])
  })

  it('adds tools only when they are on and valid', () => {
    const on = buildBody({ ...DEFAULT_PARAMS, toolsOn: true }, [{ id: '1', role: 'user', text: 'x', images: [] }], 'm')
    expect(Array.isArray(on.tools)).toBe(true)
    const bad = buildBody({ ...DEFAULT_PARAMS, toolsOn: true, tools: '{' }, [{ id: '1', role: 'user', text: 'x', images: [] }], 'm')
    expect(bad.tools).toBeUndefined()
  })
})

describe('buildBody with tool calls', () => {
  const called = (extra: Partial<Extract<Msg, { role: 'assistant' }>> = {}): Msg => ({
    ...(done('') as Extract<Msg, { role: 'assistant' }>),
    id: 'a1',
    s: { ...emptyStream(), phase: 'done', finish: 'tool_calls', toolCalls: [{ index: 0, id: 'c9', name: 'get_weather', arguments: '{"city":"Oslo"}' }] },
    ...extra,
  })
  const ask: Msg = { id: '1', role: 'user', text: 'weather in Oslo?', images: [] }

  it('sends the call and its result, linked by the call id', () => {
    const b = buildBody({ ...DEFAULT_PARAMS, toolsOn: true }, [ask, called({ toolResults: ['{"temp_c": 4}'] })], 'm')
    expect(b.messages).toEqual([
      { role: 'user', content: 'weather in Oslo?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }],
      },
      { role: 'tool', tool_call_id: 'c9', content: '{"temp_c": 4}' },
    ])
  })

  it('makes an id when the engine sent none, and leaves out a call nobody answered', () => {
    const noId = called({ toolResults: ['sunny'] })
    if (noId.role === 'assistant') noId.s.toolCalls = [{ index: 0, name: 'get_weather', arguments: '' }]
    const b = buildBody(DEFAULT_PARAMS, [ask, noId], 'm')
    const msgs = b.messages as Array<Record<string, unknown>>
    expect(msgs[1].tool_calls).toEqual([{ id: 'call_a1_0', type: 'function', function: { name: 'get_weather', arguments: '{}' } }])
    expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'call_a1_0', content: 'sunny' })

    const unanswered = buildBody(DEFAULT_PARAMS, [ask, called(), { id: '2', role: 'user', text: 'never mind', images: [] }], 'm')
    expect(unanswered.messages).toEqual([
      { role: 'user', content: 'weather in Oslo?' },
      { role: 'user', content: 'never mind' },
    ])
  })
})

describe('parseTools', () => {
  it('explains what is wrong', () => {
    expect(parseTools('{}')).toMatchObject({ ok: false })
    expect(parseTools('[{"type":"function"}]')).toMatchObject({ ok: false })
    expect(parseTools('[{"type":"function","function":{"name":"f"}}]')).toMatchObject({ ok: true })
    expect(parseTools('nope')).toMatchObject({ ok: false })
  })
})

describe('view as code', () => {
  it('writes Python literals', () => {
    expect(toPython({ a: true, b: null, c: [1, 'x'], d: false })).toBe('{"a": True, "b": None, "c": [1, "x"], "d": False}')
  })

  it('shortens pictures and never puts a real token in', () => {
    const img = `data:image/png;base64,${'A'.repeat(4000)}`
    const { shortened, body } = shortenImages({ messages: [{ content: [{ image_url: { url: img } }] }] })
    expect(shortened).toBe(1)
    expect(JSON.stringify(body)).toContain('…(3 KB)')
    const v = codeViews(buildBody(DEFAULT_PARAMS, [{ id: '1', role: 'user', text: "it's", images: [] }], 'qwen'), 'http://192.168.1.20:8080/v1')
    expect(v.curl).toContain('curl -N http://192.168.1.20:8080/v1/chat/completions')
    expect(v.curl).toContain('Bearer $TOKEN')
    expect(v.curl).toContain(`it'\\''s`)
    expect(v.python).toContain('extra_body={"chat_template_kwargs": {"enable_thinking": True}}')
    expect(v.python).toContain('api_key=os.environ["TOKEN"]')
    expect(v.js).toContain('"chat_template_kwargs"')
    expect(v.js).toContain('process.env.TOKEN')
    for (const s of [v.curl, v.python, v.js]) expect(s).not.toMatch(/lls_/)
  })
})
