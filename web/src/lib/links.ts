// Links from the web or the model are untrusted: only http(s) ones become links.

/** A link from the web or the model, as an href only when it is http(s); anything else is shown as text. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}
