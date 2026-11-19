// The console API client.  Every change sends JSON and `X-Outcrop: 1` (the browser adds Origin); a 401 means "sign in",
// and a 403 with {"detail": {"reauth": true}} means "ask for the password again", then retry once.

export class ApiError extends Error {
  status: number
  body: unknown
  reauth: boolean
  constructor(status: number, message: string, body: unknown, reauth = false) {
    super(message)
    this.status = status
    this.body = body
    this.reauth = reauth
  }
  get notFound() {
    return this.status === 404
  }
}

type Handler401 = () => void
type ReauthHandler = (message?: string) => Promise<boolean>

let on401: Handler401 = () => {}
let onReauth: ReauthHandler = async () => false

export function setUnauthorizedHandler(fn: Handler401) {
  on401 = fn
}
export function setReauthHandler(fn: ReauthHandler) {
  onReauth = fn
}

/** The session has ended: go to the sign-in page (for callers that do not go through request(), like streams). */
export function unauthorized() {
  on401()
}

/** Ask for the password again (the dialog), for callers that do not go through request(), like downloads. */
export function askReauth(message?: string): Promise<boolean> {
  return onReauth(message)
}

/**
 * Download a file from the API (a backup): with the session cookie, asking for the password again when the API wants
 * it, then saving it under the name the server gives.
 */
export async function download(path: string, fallbackName: string): Promise<boolean> {
  const get = () => fetch(path, { credentials: 'same-origin', headers: { 'X-Outcrop': '1' }, cache: 'no-store' })
  let r = await get()
  if (r.status === 403) {
    const body = await r.json().catch(() => null)
    if (isReauth(body)) {
      if (!(await onReauth(errorMessage(body, 'Enter your password again to do this.')))) return false
      r = await get()
    }
  }
  if (r.status === 401) {
    on401()
    return false
  }
  if (!r.ok) {
    const body = await r.json().catch(() => null)
    throw new ApiError(r.status, errorMessage(body, `${r.status} ${r.statusText}`), body)
  }
  const blob = await r.blob()
  const cd = r.headers.get('Content-Disposition') ?? ''
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? fallbackName
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}

/** The human message in an error body: {"error": "..."} or FastAPI's {"detail": "..."}. */
export function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.error === 'string') return b.error
    if (typeof b.detail === 'string') return b.detail
    if (b.detail && typeof b.detail === 'object') {
      const d = b.detail as Record<string, unknown>
      if (typeof d.message === 'string') return d.message
      if (Array.isArray(b.detail)) {
        const first = b.detail[0] as { msg?: string; loc?: unknown[] } | undefined
        if (first?.msg) return `${first.loc ? `${(first.loc as unknown[]).slice(1).join('.')}: ` : ''}${first.msg}`
      }
    }
    if (Array.isArray(b.detail)) {
      const first = b.detail[0] as { msg?: string; loc?: unknown[] } | undefined
      if (first?.msg) return `${first.loc ? `${(first.loc as unknown[]).slice(1).join('.')}: ` : ''}${first.msg}`
    }
  }
  return fallback
}

function isReauth(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const d = (body as { detail?: unknown }).detail
  return !!d && typeof d === 'object' && (d as { reauth?: boolean }).reauth === true
}

export interface RequestOptions {
  /** Do not go to the sign-in page on a 401 (sign-in itself, the password checks). */
  no401?: boolean
  /** Do not ask for the password again on a reauth 403. */
  noReauth?: boolean
  signal?: AbortSignal
  headers?: Record<string, string>
}

export async function request<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = { 'X-Outcrop': '1', Accept: 'application/json', ...opts.headers }
  const init: RequestInit = { method, headers, credentials: 'same-origin', signal: opts.signal, cache: 'no-store' }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const url = path.startsWith('/') ? path : `/api/${path}`
  let r: Response
  try {
    r = await fetch(url.startsWith('/api') || url.startsWith('/ca.crt') ? url : `/api${url}`, init)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(0, 'the console is not answering (network error)', null)
  }
  const text = await r.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (r.ok) return data as T
  if (r.status === 401 && !opts.no401) {
    on401()
  }
  if (r.status === 403 && isReauth(data) && !opts.noReauth && !retried) {
    const ok = await onReauth(errorMessage(data, 'Enter your password again to do this.'))
    if (ok) return request<T>(method, path, body, opts, true)
    throw new ApiError(403, 'cancelled: the password was not entered again', data, true)
  }
  const msg = errorMessage(data, `${r.status} ${r.statusText || 'error'}`)
  const err = new ApiError(r.status, msg, data, isReauth(data))
  if (r.status === 429) {
    const ra = r.headers.get('Retry-After')
    ;(err as ApiError & { retryAfter?: number }).retryAfter = ra ? Number(ra) : undefined
  }
  throw err
}

export const api = {
  get: <T = unknown>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body, opts),
  put: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body, opts),
  patch: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body, opts),
  del: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('DELETE', path, body, opts),
}

/** GET that turns a 404 (an endpoint this backend does not have yet) into null. */
export async function getOptional<T>(path: string): Promise<T | null> {
  try {
    return await api.get<T>(path)
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null
    throw e
  }
}

/** Copy text; falls back to a hidden textarea where the async clipboard is not available (plain HTTP). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
