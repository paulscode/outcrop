// What you have typed but not sent, per chat (or "new", or "space:ID"): kept in memory for this tab, so switching chats
// keeps it.  Empty drafts are removed, and a deleted chat's draft goes with it, so a tab open for days does not grow.

export interface Draft {
  text: string
  images: string[]
}

const drafts = new Map<string, Draft>()
const EMPTY: Draft = { text: '', images: [] }

export function getDraft(key: string): Draft {
  return drafts.get(key) ?? EMPTY
}

/** Change a draft from what it is now (not from what a render saw): async picture reads can't undo typing. */
export function updateDraft(key: string, fn: (d: Draft) => Draft): Draft {
  const next = fn(getDraft(key))
  if (!next.text && !next.images.length) drafts.delete(key)
  else drafts.set(key, next)
  return next
}

export function dropDraft(key: string) {
  drafts.delete(key)
}

export function draftCount() {
  return drafts.size
}
