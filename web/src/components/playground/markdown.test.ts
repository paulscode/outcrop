// The model's output is untrusted: whatever it writes must come out as text, never as script, links to javascript: or
// handlers.  Rendered on the server side of React (no DOM needed).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import Markdown, { normalizeMath } from './Markdown'

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }))
const BS = '\\'

describe('the playground markdown', () => {
  it('drops raw HTML, scripts and javascript: links', () => {
    const html = render(
      'Hi <script>alert(1)</script> <img src=x onerror=alert(2)> <a href="javascript:alert(3)">x</a> [y](javascript:alert(4)) <iframe src="https://example.org"></iframe>',
    )
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/onerror/i)
    expect(html).not.toMatch(/javascript:/i)
    expect(html).not.toMatch(/<iframe/i)
    expect(html).toContain('Hi')
  })

  it('keeps tables, lists and code, and renders math with KaTeX, inline and as a block', () => {
    const md = [
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '- one',
      '- two',
      '',
      `Inline $x^2$ and ${BS}(y${BS})`,
      '',
      `$$${BS}int_0^3 x^2${BS},dx = 9$$`,
      '',
      '```python',
      'print("hi")',
      '```',
    ].join('\n')
    const html = render(md)
    expect(html).toContain('<table>')
    expect(html).toContain('<li>one</li>')
    expect((html.match(/class="katex"/g) ?? []).length).toBe(3)
    expect(html).toMatch(/katex-display/)
    expect(html).toContain('print(&quot;hi&quot;)')
    expect(html).toContain('python')
  })

  it('opens links in a new tab without a referrer and fetches no outside pictures', () => {
    const html = render('[site](https://example.org) ![pic](https://example.org/a.png)')
    expect(html).toContain('href="https://example.org"')
    expect(html).toMatch(/rel="noreferrer noopener nofollow"/)
    expect(html).not.toContain('<img')
    expect(html).toContain('[picture: pic]')
  })

  it('makes links only of http(s) addresses: a path on this console or mailto: is text (safeHref)', () => {
    const html = render('[export](/api/chats/export) [mail](mailto:a@b.c) [rel](settings) [ok](http://example.org/x)')
    expect(html).not.toContain('href="/api/chats/export"')
    expect(html).not.toContain('href="mailto:')
    expect(html).not.toContain('href="settings"')
    expect(html).toContain('<span title="/api/chats/export">export</span>')
    expect(html).toContain('href="http://example.org/x"')
  })

  it('keeps links within the answer (footnotes)', () => {
    const html = render('A note[^1].\n\n[^1]: The note.')
    expect(html).toMatch(/href="#user-content-fn-1"/)
  })
})

describe('normalizeMath', () => {
  it('turns the usual LaTeX delimiters into what remark-math reads', () => {
    expect(normalizeMath(`a ${BS}(x^2${BS}) b`)).toBe('a $x^2$ b')
    expect(normalizeMath(`see ${BS}[${BS}int_0^1 x${BS}] here`)).toBe(`see \n$$\n${BS}int_0^1 x\n$$\n here`)
    expect(normalizeMath('$$E = mc^2$$')).toBe('$$\nE = mc^2\n$$')
    expect(normalizeMath('price $5 and $6')).toBe('price $5 and $6')
  })

  it('leaves code alone, closed or still streaming', () => {
    const code = ['```latex', `${BS}[x${BS}]`, '$$y$$', '```'].join('\n')
    expect(normalizeMath(code)).toBe(code)
    expect(normalizeMath(`\`${BS}(x${BS})\` and ${BS}(y${BS})`)).toBe(`\`${BS}(x${BS})\` and $y$`)
    const open = ['text', '```python', 'print("$$a$$")'].join('\n')
    expect(normalizeMath(open)).toBe(open)
  })
})
