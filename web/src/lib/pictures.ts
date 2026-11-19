// Pictures attached to a message: which files may go, and how many fit next to the ones already there.  Pure, so the
// composer's checks are unit-tested.

export interface PictureRules {
  /** MIME types allowed (none given: any image/*) */
  types?: readonly string[]
  /** the largest file, in bytes */
  maxBytes?: number
  /** at most this many pictures per message */
  max?: number
  /** the pictures' data: URLs may add up to this many characters */
  maxTotal: number
}

/** The chat's server: PNG, JPEG, GIF or WebP, at most 8 MB each, 8 per question. */
export const CHAT_PICTURES = { types: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], maxBytes: 8 * 1024 * 1024, max: 8 } as const

/** Why a file cannot be attached, or null when it can (before it is read). */
export function pictureProblem(f: { name: string; type: string; size: number }, rules: PictureRules): string | null {
  if (!f.type.startsWith('image/')) return `${f.name} is not a picture`
  if (rules.types && !rules.types.includes(f.type)) return `${f.name}: only PNG, JPEG, GIF or WebP pictures can be sent`
  if (rules.maxBytes !== undefined && f.size > rules.maxBytes) return `${f.name} is over ${Math.round(rules.maxBytes / 1048576)} MB`
  if ((f.size * 4) / 3 > rules.maxTotal) return `${f.name} is too large`
  return null
}

/**
 * Pictures just read, added to the list as it is now (not as it was when the files were picked: another paste may have
 * landed meanwhile).  Those over the count or the total size are left out and counted.
 */
export function fitPictures(prev: readonly string[], incoming: readonly string[], rules: PictureRules): { list: string[]; overCount: number; overSize: number } {
  const list = [...prev]
  let total = prev.reduce((a, s) => a + s.length, 0)
  let overCount = 0
  let overSize = 0
  for (const url of incoming) {
    if (rules.max !== undefined && list.length >= rules.max) overCount++
    else if (total + url.length > rules.maxTotal) overSize++
    else {
      list.push(url)
      total += url.length
    }
  }
  return { list, overCount, overSize }
}
