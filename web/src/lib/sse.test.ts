import { describe, expect, it } from 'vitest'
import { answerRate, applyData, emptyStream, errorText, finishStream, SSEParser, type StreamState } from './sse'

function collect(chunks: string[]): string[] {
  const out: string[] = []
  const p = new SSEParser((d) => out.push(d))
  for (const c of chunks) p.feed(c)
  p.end()
  return out
}

describe('SSEParser', () => {
  it('splits events on blank lines and ignores comments', () => {
    expect(collect([': keep-alive\n\ndata: {"a":1}\n\ndata: [DONE]\n\n'])).toEqual(['{"a":1}', '[DONE]'])
  })

  it('handles events split across reads, and CRLF line ends', () => {
    expect(collect(['da', 'ta: {"x"', ':2}\r', '\n\r\ndata: 3\r\n', '\r\n'])).toEqual(['{"x":2}', '3'])
  })

  it('joins multi-line data with newlines and keeps a last event without its blank line', () => {
    expect(collect(['data: one\ndata: two\n\ndata: tail'])).toEqual(['one\ntwo', 'tail'])
  })

  it('ignores other fields (event:, id:)', () => {
    expect(collect(['event: message\nid: 7\ndata: ok\n\n'])).toEqual(['ok'])
  })
})

const chunk = (delta: object, extra: object = {}) =>
  JSON.stringify({ model: 'qwen', choices: [{ index: 0, delta, finish_reason: null }], ...extra })

function run(datas: Array<[string, number]>): StreamState {
  let s = emptyStream()
  for (const [d, t] of datas) s = applyData(s, d, t)
  return s
}

describe('the chat stream reducer', () => {
  it('separates thinking from the answer and times both', () => {
    const s = run([
      [chunk({ role: 'assistant', content: '' }), 10],
      [chunk({ reasoning_content: 'Let me ' }), 11],
      [chunk({ reasoning_content: 'think.' }), 11.5],
      [chunk({ content: 'The answer' }), 13],
      [chunk({ content: ' is 4.' }), 13.5],
      [
        JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 6 },
          timings: { predicted_per_second: 38.6, prompt_n: 10, cache_n: 2 },
        }),
        14,
      ],
      ['[DONE]', 14.1],
    ])
    expect(s.thinking).toBe('Let me think.')
    expect(s.content).toBe('The answer is 4.')
    expect(s.firstTokenAt).toBe(11)
    expect(s.answerAt).toBe(13)
    expect(s.thinkingEndedAt).toBe(13)
    expect(s.finish).toBe('stop')
    expect(s.usage?.completion_tokens).toBe(6)
    expect(s.phase).toBe('done')
    expect(s.endedAt).toBe(14.1)
    expect(s.thinkChunks).toBe(2)
    expect(s.chunks).toBe(4)
    expect(answerRate(s, 20)).toBe(38.6)
  })

  it('assembles streamed tool calls by index', () => {
    const s = run([
      [chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_', arguments: '' } }] }), 1],
      [chunk({ tool_calls: [{ index: 0, function: { name: 'weather', arguments: '{"city":' } }] }), 2],
      [chunk({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }), 3],
      [chunk({ tool_calls: [{ index: 1, function: { name: 'time', arguments: '{}' } }] }), 4],
    ])
    expect(s.toolCalls).toEqual([
      { index: 0, id: 'call_1', type: 'function', name: 'get_weather', arguments: '{"city":"Oslo"}' },
      { index: 1, name: 'time', arguments: '{}' },
    ])
    expect(s.phase).toBe('answering')
  })

  it('stops at an error inside the stream', () => {
    const s = run([
      [chunk({ content: 'Hel' }), 1],
      [JSON.stringify({ error: { message: 'the model server stopped while answering', type: 'server_error' } }), 2],
    ])
    expect(s.error).toBe('the model server stopped while answering')
    expect(s.phase).toBe('done')
    expect(s.content).toBe('Hel')
  })

  it('ignores junk and keeps the state', () => {
    const s0 = emptyStream()
    expect(applyData(s0, 'not json', 1)).toBe(s0)
  })

  it('reads a non-streamed answer (message instead of delta)', () => {
    const s = applyData(
      emptyStream(),
      JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }),
      5,
    )
    expect(s.content).toBe('hi')
    expect(s.finish).toBe('stop')
  })

  it('computes a rate from tokens when the engine sent no timings', () => {
    let s = run([
      [chunk({ content: 'a' }), 10],
      [chunk({ content: 'b' }), 11],
    ])
    s = { ...s, usage: { completion_tokens: 21 } }
    s = finishStream(s, 12)
    expect(answerRate(s, 12)).toBeCloseTo(10)
  })
})

describe('errorText', () => {
  it('reads every error shape', () => {
    expect(errorText({ error: 'plain' }, 'x')).toBe('plain')
    expect(errorText({ error: { message: 'openai style' } }, 'x')).toBe('openai style')
    expect(errorText({ detail: 'fastapi' }, 'x')).toBe('fastapi')
    expect(errorText('{"error":{"message":"in text"}}', 'x')).toBe('in text')
    expect(errorText(null, 'fallback')).toBe('fallback')
  })
})
