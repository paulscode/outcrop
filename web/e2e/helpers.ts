import { readFileSync } from 'node:fs'
import { expect, type APIRequestContext, type Page } from '@playwright/test'

export const USER = 'dev'
export const PASSWORD = 'harbor glacier lantern velvet orbit moss'
/** The dev gateway (console/dev.py): OpenAI/Anthropic API and Ollama API */
export const GATEWAY = process.env.OUTCROP_GATEWAY ?? 'http://127.0.0.1:18088'
export const GATEWAY_OLLAMA = process.env.OUTCROP_GATEWAY_OLLAMA ?? 'http://127.0.0.1:11444'

export const PAGES = [
  '/chat',
  '/',
  '/live',
  '/requests',
  '/presets',
  '/access',
  '/connect',
  '/playground',
  '/lab',
  '/strata',
  '/system',
  '/logs',
  '/timeline',
  '/settings',
]

/** The console API from a test: our header and origin on every change. */
export async function consoleApi(request: APIRequestContext, method: string, path: string, body?: unknown, base = 'http://localhost:8800') {
  const r = await request.fetch(base + path, {
    method,
    data: body,
    headers: { 'X-Outcrop': '1', Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  })
  return r
}

/** The dev tokens dev.py made (name -> plaintext). */
export function devTokens(): Record<string, string> {
  try {
    return JSON.parse(readFileSync('/tmp/outcrop-dev/tokens.json', 'utf8'))
  } catch {
    return {}
  }
}

/** A chat request through the gateway; returns the HTTP status. */
export async function chat(request: APIRequestContext, token: string | null, opts: { ua?: string; stream?: boolean; words?: number } = {}) {
  const r = await request.post(`${GATEWAY}/v1/chat/completions`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'User-Agent': opts.ua ?? 'curl/8.5.0',
      'Content-Type': 'application/json',
    },
    data: {
      model: 'qwen3.8-flash-next',
      max_tokens: 16,
      stream: opts.stream ?? false,
      messages: [{ role: 'user', content: 'rock '.repeat(opts.words ?? 8) }],
    },
    timeout: 120_000,
  })
  return r.status()
}

/** Collect CSP violations reported in the page (installed before any page script runs). */
export async function watchCsp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] }
    w.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'} at ${e.sourceFile}:${e.lineNumber} ${e.sample ?? ''}`)
    })
  })
  return async () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp ?? [])
}

export async function settle(page: Page, ms = 800) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(ms)
}

export { expect }
