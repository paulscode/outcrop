// Formatting for every number the console shows.  Missing values become an em dash, never NaN or a crash.

export const DASH = '—'

export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 12,408 */
export function int(v: number | null | undefined): string {
  return isNum(v) ? nf0.format(Math.round(v)) : DASH
}

/** Fixed decimals: fixed(41.83, 1) = "41.8" */
export function fixed(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return DASH
  if (digits === 0) return nf0.format(v)
  if (digits === 1) return nf1.format(v)
  if (digits === 2) return nf2.format(v)
  return v.toFixed(digits)
}

/** Compact counts: 950, 1.2 K, 84 K, 1.9 M */
export function compact(v: number | null | undefined): string {
  if (!isNum(v)) return DASH
  const a = Math.abs(v)
  if (a < 1000) return nf0.format(v)
  if (a < 10_000) return `${(v / 1000).toFixed(1)} K`
  if (a < 1_000_000) return `${Math.round(v / 1000)} K`
  if (a < 10_000_000) return `${(v / 1_000_000).toFixed(1)} M`
  if (a < 1_000_000_000) return `${Math.round(v / 1_000_000)} M`
  return `${(v / 1_000_000_000).toFixed(1)} B`
}

/** 0.913 -> "91 %" (a share between 0 and 1) */
export function pct(share: number | null | undefined, digits = 0): string {
  if (!isNum(share)) return DASH
  return `${(share * 100).toFixed(digits)}%`
}

/** 97 -> "97 %" (already a percentage) */
export function pct100(v: number | null | undefined, digits = 0): string {
  if (!isNum(v)) return DASH
  return `${v.toFixed(digits)}%`
}

/** Bytes, binary units: 716320040 -> "683 MiB" */
export function bytes(v: number | null | undefined, digits?: number): string {
  if (!isNum(v)) return DASH
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  let x = v
  while (Math.abs(x) >= 1024 && i < units.length - 1) {
    x /= 1024
    i++
  }
  const d = digits ?? (i === 0 ? 0 : x < 10 ? 1 : 0)
  return `${x.toFixed(d)} ${units[i]}`
}

/** MiB -> "23.4 GiB" (or MiB under 1 GiB) */
export function mib(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return DASH
  if (Math.abs(v) >= 1024) return `${(v / 1024).toFixed(digits)} GiB`
  return `${Math.round(v)} MiB`
}

export function gib(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return DASH
  return `${v.toFixed(digits)} GiB`
}

/** Seconds as a duration: 0.42 -> "420 ms", 61.2 -> "61 s", 425 -> "7 min 5 s", 7300 -> "2 h 2 min" */
export function dur(s: number | null | undefined, opts: { precise?: boolean } = {}): string {
  if (!isNum(s)) return DASH
  if (s < 0) s = 0
  if (s < 1) return `${Math.round(s * 1000)} ms`
  if (s < 10) return `${s.toFixed(1)} s`
  if (s < 60) return `${Math.round(s)} s`
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const r = Math.round(s % 60)
    return opts.precise && r ? `${m} min ${r} s` : `${m} min`
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600)
    const m = Math.round((s % 3600) / 60)
    return m ? `${h} h ${m} min` : `${h} h`
  }
  const d = Math.floor(s / 86400)
  const h = Math.round((s % 86400) / 3600)
  return h ? `${d} d ${h} h` : `${d} d`
}

/** Milliseconds: 712.4 -> "712 ms", 5304 -> "5.3 s" */
export function ms(v: number | null | undefined): string {
  if (!isNum(v)) return DASH
  return dur(v / 1000)
}

/** A countdown clock: 754 -> "12:34", 4000 -> "1:06:40" */
export function clock(s: number | null | undefined): string {
  if (!isNum(s)) return DASH
  const t = Math.max(0, Math.round(s))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = t % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`
}

/** "2 min ago", "in 3 days" */
export function ago(ts: number | null | undefined, now = Date.now() / 1000): string {
  if (!isNum(ts)) return DASH
  const d = now - ts
  const a = Math.abs(d)
  let s: string
  if (a < 5) return d >= 0 ? 'just now' : 'now'
  if (a < 60) s = `${Math.round(a)} s`
  else if (a < 3600) s = `${Math.round(a / 60)} min`
  else if (a < 86400) s = `${Math.round(a / 3600)} h`
  else if (a < 86400 * 60) s = `${Math.round(a / 86400)} day${Math.round(a / 86400) === 1 ? '' : 's'}`
  else s = `${Math.round(a / (86400 * 30))} months`
  return d >= 0 ? `${s} ago` : `in ${s}`
}

const tf = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const tfm = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
const df = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const dfy = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const dtf = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** 15:58:02 */
export function time(ts: number | null | undefined): string {
  return isNum(ts) ? tf.format(new Date(ts * 1000)) : DASH
}
/** 15:58 */
export function hm(ts: number | null | undefined): string {
  return isNum(ts) ? tfm.format(new Date(ts * 1000)) : DASH
}
/** 3 Nov */
export function day(ts: number | null | undefined): string {
  if (!isNum(ts)) return DASH
  const d = new Date(ts * 1000)
  return d.getFullYear() === new Date().getFullYear() ? df.format(d) : dfy.format(d)
}
/** 3 Nov, 15:58 */
export function dateTime(ts: number | null | undefined): string {
  return isNum(ts) ? dtf.format(new Date(ts * 1000)) : DASH
}
/** Today: 15:58:02; earlier: 3 Nov 15:58 */
export function when(ts: number | null | undefined, now = Date.now() / 1000): string {
  if (!isNum(ts)) return DASH
  const a = new Date(ts * 1000)
  const b = new Date(now * 1000)
  if (a.toDateString() === b.toDateString()) return time(ts)
  return dateTime(ts)
}

/** Context sizes: 262144 -> "262K", 1048576 -> "1M" */
export function ctx(n: number | null | undefined): string {
  if (!isNum(n)) return DASH
  if (n >= 1_048_576 && n % 1_048_576 === 0) return `${n / 1_048_576}M`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${Math.round(n / 1000)}K`
}

/** Tokens per second: "41.8 tok/s" */
export function tps(v: number | null | undefined): string {
  return isNum(v) ? `${fixed(v, v >= 100 ? 0 : 1)} tok/s` : DASH
}

/** Temperatures and power */
export function temp(v: number | null | undefined): string {
  return isNum(v) ? `${Math.round(v)} °C` : DASH
}
export function watts(v: number | null | undefined): string {
  return isNum(v) ? `${Math.round(v)} W` : DASH
}
export function mhz(v: number | null | undefined): string {
  return isNum(v) ? `${int(v)} MHz` : DASH
}

/** Plural helper: plural(3, 'request') -> "3 requests" */
export function plural(n: number | null | undefined, one: string, many = `${one}s`): string {
  if (!isNum(n)) return `${DASH} ${many}`
  return `${int(n)} ${n === 1 ? one : many}`
}

/** "lls_7QmK2xRf_…" stays; a long secret is cut to a recognizable start. */
export function hint(s: string | null | undefined, n = 12): string {
  if (!s) return DASH
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** A local date for "YYYY-MM-DD" keys (usage days). */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The last `n` local days as keys, oldest first. */
export function lastDays(n: number, now = new Date()): string[] {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    out.push(dayKey(d))
  }
  return out
}

/** Seconds since local midnight, for "today" totals. */
export function hoursSinceMidnight(now = new Date()): number {
  const m = new Date(now)
  m.setHours(0, 0, 0, 0)
  return Math.max(0.01, (now.getTime() - m.getTime()) / 3_600_000)
}

/** Readable device from a User-Agent: "Firefox on Linux" */
export function device(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /curl\//.test(ua)
              ? 'curl'
              : ua.split('/')[0].slice(0, 24)
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux|X11/.test(ua)
            ? 'Linux'
            : ''
  return os ? `${browser} on ${os}` : browser
}

/** Clamp to [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** The mean of the finite numbers in a list, or null. */
export function mean(xs: Array<number | null | undefined>): number | null {
  const v = xs.filter(isNum)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

/** The median of the finite numbers in a list, or null. */
export function median(xs: Array<number | null | undefined>): number | null {
  const v = xs.filter(isNum).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
