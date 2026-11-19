// The model's answer as Markdown: GitHub tables and lists, math with KaTeX, code highlighted by Shiki.  Everything the model
// writes goes through rehype-sanitize first (no raw HTML, no scripts, no event handlers); KaTeX then renders the math nodes
// it left in place.  HTML code blocks can be previewed in a frame with every permission off (sandbox="").
//
// This module is loaded lazily (React.lazy), so none of it is in the console's first download.

import 'katex/dist/katex.min.css'
import './markdown.css'

import { Code2, Eye } from 'lucide-react'
import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { safeHref } from '@/lib/links'
import { CopyButton } from '@/components/ui/misc'
import { highlight, type Tok } from './highlight'

type Schema = typeof defaultSchema

// Keep the class names remark-math gives math (rehype-katex finds them after the sanitizer has run).
const schema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-./, 'math-inline', 'math-display']],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', 'math', 'math-inline', 'math-display']],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', 'math', 'math-display']],
  },
}

interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

function textOf(n: HastNode | undefined): string {
  if (!n) return ''
  if (n.type === 'text') return n.value ?? ''
  return (n.children ?? []).map(textOf).join('')
}

function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const [lines, setLines] = useState<Tok[][] | null>(null)
  const [preview, setPreview] = useState(false)
  useEffect(() => {
    let live = true
    const id = setTimeout(() => {
      highlight(code, lang)
        .then((h) => live && setLines(h))
        .catch(() => live && setLines(null))
    }, 150)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [code, lang])
  const isHtml = lang === 'html' || lang === 'htm'
  return (
    <div className="pg-code">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] text-faint">
        <Code2 className="size-3.5" aria-hidden />
        <span className="font-mono">{lang || 'text'}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {isHtml ? (
            <button
              type="button"
              onClick={() => setPreview((p) => !p)}
              aria-pressed={preview}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-line-strong bg-panel-2 px-1.5 text-[11px] text-muted hover:text-fg"
            >
              <Eye className="size-3" aria-hidden /> {preview ? 'Code' : 'Preview'}
            </button>
          ) : null}
          <CopyButton value={code} label="Copy the code" size="xs" />
        </span>
      </div>
      {preview && isHtml ? (
        // No scripts, no forms, no same-origin access: a picture of the page, nothing more.
        <iframe title="HTML preview (sandboxed)" sandbox="" srcDoc={code} referrerPolicy="no-referrer" />
      ) : lines ? (
        <pre className="shiki">
          <code>
            {lines.map((line, i) => (
              <span className="line" key={i}>
                {line.map((t, j) => (
                  <span key={j} style={t.style as CSSProperties | undefined}>
                    {t.content}
                  </span>
                ))}
                {i < lines.length - 1 ? '\n' : null}
              </span>
            ))}
          </code>
        </pre>
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}

/**
 * A link the model wrote: to a place in the same answer (#…, footnotes), or out to an http(s) page.  Anything else (a
 * path on this console, mailto:, …) is shown as text, so an answer cannot send you anywhere else.
 */
function ExtLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (href?.startsWith('#')) return <a href={href}>{children}</a>
  const ok = safeHref(href)
  if (!ok) return <span title={href}>{children}</span>
  return (
    <a href={href} target="_blank" rel="noreferrer noopener nofollow" referrerPolicy="no-referrer" title={href}>
      {children}
    </a>
  )
}

const components: Components = {
  pre({ node }) {
    const code = (node as unknown as HastNode | undefined)?.children?.find((c) => c.type === 'element' && c.tagName === 'code')
    const cls = code?.properties?.className
    const list = Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? cls.split(/\s+/) : []
    const lang = list.find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? null
    return <CodeBlock code={textOf(code).replace(/\n$/, '')} lang={lang} />
  },
  a({ href, children }) {
    return <ExtLink href={href}>{children}</ExtLink>
  },
  img({ src, alt }) {
    // Only pictures that are already in the page (data: URLs); nothing is fetched from elsewhere.
    if (typeof src === 'string' && src.startsWith('data:image/')) return <img src={src} alt={alt ?? ''} />
    return <span className="text-faint">[picture: {alt || 'not loaded'}]</span>
  },
}

const FENCE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g
const INLINE_CODE = /(`+[^`\n]*`+)/g
const DISPLAY_BRACKETS = /\\\[([\s\S]+?)\\\]/g
const INLINE_PARENS = /\\\(([\s\S]+?)\\\)/g
const ONE_LINE_DISPLAY = /^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm

/**
 * Models write math in several ways; remark-math reads $…$ and $$ blocks on their own lines.  Outside code, turn \(…\)
 * into $…$, \[…\] into a $$ block, and a line that is only $$…$$ into a $$ block, so display math is shown as such.
 */
export function normalizeMath(text: string): string {
  return text
    .split(FENCE)
    .map((part, i) => {
      if (i % 2 === 1) return part // a fenced code block (closed, or still streaming)
      return part
        .split(INLINE_CODE)
        .map((seg, j) => {
          if (j % 2 === 1) return seg // inline code
          return seg
            .replace(DISPLAY_BRACKETS, (_m, body: string) => ['', '$$', body.trim(), '$$', ''].join('\n'))
            .replace(INLINE_PARENS, (_m, body: string) => ['$', body.trim(), '$'].join(''))
            .replace(ONE_LINE_DISPLAY, (_m, body: string) => ['$$', body.trim(), '$$'].join('\n'))
        })
        .join('')
    })
    .join('')
}

/**
 * `link`, when given, may draw a link its own way (the chat's citation pills): it gets the href and the link's text, and
 * returns null to leave the link as it is.
 */
function Markdown({ text, link, className }: { text: string; link?: (href: string, children: ReactNode) => ReactNode | null; className?: string }) {
  const comps = useMemo<Components>(
    () =>
      link
        ? {
            ...components,
            a(props) {
              const own = typeof props.href === 'string' ? link(props.href, props.children) : null
              return own ?? <ExtLink href={props.href}>{props.children}</ExtLink>
            },
          }
        : components,
    [link],
  )
  return (
    <div className={className ? `pg-md ${className}` : 'pg-md'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeSanitize, schema], [rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false }]]}
        components={comps}
        skipHtml
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  )
}

export default memo(Markdown)
