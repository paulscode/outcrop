import { ArrowUp, ImagePlus, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { bytes } from '@/lib/format'
import { fitPictures, pictureProblem, type PictureRules } from '@/lib/pictures'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/menu'
import { Kbd } from '@/components/ui/misc'

/** The request the console passes on is capped at 32 MiB; pictures travel as base64 (4/3 of their size). */
const MAX_TOTAL = 20 * 1024 * 1024

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(f)
  })
}

export function Composer({
  value,
  onChange,
  images,
  setImages,
  onSend,
  onStop,
  busy,
  disabled,
  placeholder,
  inputId = 'pg-input',
  label = 'Message',
  tools,
  meter,
  inputRef,
  autoFocus,
  canAttach = true,
  pictures,
  className,
}: {
  value: string
  onChange: (v: string) => void
  images: string[]
  /** takes the new list, or a function of the list as it is then (pictures are read asynchronously) */
  setImages: (v: string[] | ((prev: string[]) => string[])) => void
  onSend: () => void
  onStop: () => void
  busy: boolean
  disabled?: boolean
  placeholder?: string
  inputId?: string
  label?: string
  /** more toggles after the picture button (the chat's Web and Think) */
  tools?: React.ReactNode
  /** before the send button (the chat's context meter) */
  meter?: React.ReactNode
  inputRef?: React.RefObject<HTMLTextAreaElement | null>
  autoFocus?: boolean
  canAttach?: boolean
  /** what the server takes: the types, the size of one, how many (the chat's: PNG, JPEG, GIF or WebP, 8 MB, 8) */
  pictures?: Omit<PictureRules, 'maxTotal'>
  className?: string
}) {
  const own = useRef<HTMLTextAreaElement>(null)
  const ta = inputRef ?? own
  const file = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)

  // grow with the text, up to about ten lines
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [value])

  // the list as it is now, also between a paste and the render it causes (two quick pastes both see the first)
  const latest = useRef(images)
  latest.current = images

  const add = async (files: FileList | File[]) => {
    const rules: PictureRules = { ...pictures, maxTotal: MAX_TOTAL }
    const list: File[] = []
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue
      const why = pictureProblem(f, rules)
      if (why) toast.error(why)
      else list.push(f)
    }
    if (!list.length) return
    if (rules.max !== undefined && latest.current.length >= rules.max) {
      toast.error(`At most ${rules.max} pictures per message`, { description: 'Remove one to add another.' })
      return
    }
    const read: string[] = []
    for (const f of list) {
      try {
        read.push(await readAsDataUrl(f))
      } catch {
        toast.error(`Reading ${f.name} failed`)
      }
    }
    if (!read.length) return
    // checked against the list as it is now: typing, or another paste, meanwhile is kept, and counts
    const fit = fitPictures(latest.current, read, rules)
    latest.current = fit.list
    setImages((prev) => fitPictures(prev, read, rules).list)
    if (fit.overCount) toast.error(`At most ${rules.max} pictures per message`, { description: `${fit.overCount} not added.` })
    if (fit.overSize) toast.error(`${fit.overSize === 1 ? 'A picture was' : `${fit.overSize} pictures were`} not added`, { description: `Pictures can add up to ${bytes(MAX_TOTAL * 0.75)} per message.` })
  }

  const canSend = !disabled && !busy && (value.trim().length > 0 || images.length > 0)

  return (
    <div
      className={cn(
        'rounded-xl border bg-panel shadow-[var(--shadow)] transition-colors',
        drag ? 'border-focus' : 'border-line-strong',
        disabled && 'opacity-60',
        className,
      )}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDrag(true)
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        if (e.dataTransfer.files?.length) void add(e.dataTransfer.files)
      }}
    >
      {images.length ? (
        <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attached pictures">
          {images.map((src, i) => (
            <li key={i} className="relative">
              <img src={src} alt={`attached picture ${i + 1}`} className="size-16 rounded-lg border border-line object-cover" />
              <button
                type="button"
                onClick={() => {
                  latest.current = latest.current.filter((_, j) => j !== i)
                  setImages((prev) => prev.filter((_, j) => j !== i))
                }}
                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-line-strong bg-panel-3 text-muted hover:text-fg"
                aria-label={`Remove picture ${i + 1}`}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <textarea
        id={inputId}
        ref={ta}
        autoFocus={autoFocus}
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (canSend) onSend()
          }
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
          if (files.length) {
            e.preventDefault()
            void add(files)
          }
        }}
        placeholder={placeholder ?? 'Ask anything…'}
        className="block max-h-60 min-h-[52px] w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-[14px] leading-relaxed text-fg outline-none placeholder:text-faint"
      />
      <div className="flex items-center gap-2 px-2.5 pb-2.5">
        <input
          ref={file}
          type="file"
          accept={pictures?.types?.join(',') ?? 'image/*'}
          multiple
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            if (e.target.files?.length) void add(e.target.files)
            e.target.value = ''
          }}
        />
        {canAttach ? (
          <Tip content="Attach a picture (or paste or drop one): the model can see pictures">
            <Button variant="ghost" size="icon-sm" onClick={() => file.current?.click()} aria-label="Attach a picture" disabled={disabled || busy}>
              <ImagePlus />
            </Button>
          </Tip>
        ) : null}
        {tools}
        {tools ? null : (
          <span className="hidden items-center gap-1 text-[11px] text-faint sm:inline-flex">
            <Kbd>↵</Kbd> send · <Kbd>⇧</Kbd>
            <Kbd>↵</Kbd> new line
          </span>
        )}
        <span className="ml-auto" />
        {meter}
        {busy ? (
          <Button variant="outline" size="sm" onClick={onStop} aria-label="Stop the answer">
            <Square className="fill-current" aria-hidden /> Stop
          </Button>
        ) : (
          <Button variant="primary" size="icon-sm" onClick={onSend} disabled={!canSend} aria-label="Send">
            <ArrowUp />
          </Button>
        )}
      </div>
    </div>
  )
}
