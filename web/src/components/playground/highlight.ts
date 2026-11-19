// Shiki, loaded on first use, with the JavaScript regex engine (no WebAssembly: the console's CSP has no 'wasm-unsafe-eval')
// and only the grammars that are asked for (each is its own small chunk).

import type { HighlighterCore } from 'shiki/core'

type Loader = () => Promise<unknown>

const LANGS: Record<string, Loader> = {
  python: () => import('shiki/langs/python.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
}

const ALIAS: Record<string, string> = {
  py: 'python',
  python3: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  shellscript: 'bash',
  jsonc: 'json',
  json5: 'json',
  yml: 'yaml',
  rs: 'rust',
  golang: 'go',
  htm: 'html',
  xml: 'html',
}

export function canonicalLang(lang: string | undefined | null): string | null {
  if (!lang) return null
  const l = lang.toLowerCase().trim()
  const c = ALIAS[l] ?? l
  return LANGS[c] ? c : null
}

let core: Promise<HighlighterCore> | null = null
const loaded = new Set<string>()
const loading = new Map<string, Promise<void>>()

function highlighter(): Promise<HighlighterCore> {
  if (!core) {
    core = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ])
      return createHighlighterCore({
        themes: [import('shiki/themes/github-dark-default.mjs'), import('shiki/themes/github-light-default.mjs')],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      })
    })()
  }
  return core
}

/** One highlighted token: its text and the two themes' colors as CSS variables (applied through the CSSOM). */
export interface Tok {
  content: string
  style?: Record<string, string>
}

/**
 * Highlighted lines for a code block (both themes as CSS variables), or null for a language it does not know.
 * Tokens, not HTML: Shiki's HTML carries style="…" attributes, which the console's CSP (style-src 'self') blocks.
 */
export async function highlight(code: string, lang: string | null | undefined): Promise<Tok[][] | null> {
  const c = canonicalLang(lang)
  if (!c) return null
  const h = await highlighter()
  if (!loaded.has(c)) {
    let p = loading.get(c)
    if (!p) {
      p = (async () => {
        const mod = (await LANGS[c]()) as { default: Parameters<HighlighterCore['loadLanguage']>[0] }
        await h.loadLanguage(mod.default)
        loaded.add(c)
      })()
      loading.set(c, p)
    }
    await p
  }
  const r = h.codeToTokens(code, {
    lang: c,
    themes: { dark: 'github-dark-default', light: 'github-light-default' },
    defaultColor: false,
  })
  return r.tokens.map((line) => line.map((t) => ({ content: t.content, style: t.htmlStyle as Record<string, string> | undefined })))
}
