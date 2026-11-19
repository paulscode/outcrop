import { useMemo } from 'react'
import { encode } from 'uqr'
import { cn } from '@/lib/utils'

/** A QR code drawn as one SVG path, made here in the browser (nothing is sent anywhere). Always dark on white. */
export function Qr({ text, size = 176, className, label }: { text: string; size?: number; className?: string; label: string }) {
  const { d, n } = useMemo(() => {
    const q = encode(text, { ecc: 'M', border: 2 })
    let path = ''
    q.data.forEach((row, y) => {
      let x = 0
      while (x < row.length) {
        if (row[x]) {
          let w = 1
          while (x + w < row.length && row[x + w]) w++
          path += `M${x} ${y}h${w}v1h-${w}z`
          x += w
        } else x++
      }
    })
    return { d: path, n: q.size }
  }, [text])
  return (
    <svg
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      className={cn('rounded-lg bg-white p-1', className)}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
    >
      <rect width={n} height={n} fill="#ffffff" />
      <path d={d} fill="#0a0c0f" />
    </svg>
  )
}
