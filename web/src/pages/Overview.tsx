import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, History, MessagesSquare } from 'lucide-react'
import { useEffect } from 'react'
import { AlertItem, levelIcon } from '@/components/shell/AlertBell'
import { ConvCacheCard, GpuCard, Insights, MemoryCard, QueueCard, TodayCard } from '@/components/overview/cards'
import { Hero } from '@/components/overview/Hero'
import { Empty, Panel, PanelHeader } from '@/components/ui/misc'
import { eventTone } from '@/lib/events'
import { ago } from '@/lib/format'
import { alertsStore, eventsTick, switchStore } from '@/lib/live'
import { getOptional } from '@/lib/api'
import { useEvents } from '@/lib/queries'
import { useStore } from '@/lib/store'
import { cn, useNow } from '@/lib/utils'

function Activity() {
  const alerts = useStore(alertsStore)
  const tick = useStore(eventsTick)
  const sw = useStore(switchStore, (s) => s?.status)
  const q = useEvents('', 8)
  const now = useNow(15_000)
  useEffect(() => {
    void q.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, sw, alerts?.recent?.[0]?.id])
  const open = alerts?.open ?? []
  return (
    <Panel className="flex h-full flex-col">
      <PanelHeader
        icon={<History />}
        title="Recent"
        meta={open.length ? `${open.length} open alert${open.length > 1 ? 's' : ''}` : undefined}
        actions={
          <Link to="/timeline" className="text-xs text-faint hover:text-fg">
            Timeline
          </Link>
        }
      />
      <div className="flex-1 p-2">
        {open.length ? (
          <ul className="mb-1 grid gap-1 border-b border-line pb-2">
            {open.slice(0, 3).map((a) => (
              <AlertItem key={a.id} a={a} now={now} />
            ))}
          </ul>
        ) : null}
        {q.data?.length ? (
          <ul className="grid">
            {q.data.slice(0, open.length ? 5 : 8).map((e) => {
              const tone = eventTone(e)
              return (
                <li key={e.id} className="flex items-start gap-2.5 rounded-md px-2 py-1.5">
                  <span className="mt-0.5 shrink-0 [&_svg]:size-3.5">
                    {tone === 'error' || tone === 'warn' ? levelIcon(tone) : (
                      <span className={cn('mt-1 block size-1.5 rounded-full', tone === 'ok' ? 'bg-ok' : 'bg-faint')} aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] leading-snug text-fg">{e.summary}</span>
                  <span className="num shrink-0 text-[11px] text-faint">{ago(e.at, now)}</span>
                </li>
              )
            })}
          </ul>
        ) : (
          <Empty title="Nothing has happened yet" />
        )}
      </div>
    </Panel>
  )
}

interface ChatStats {
  chats: number
  messages: number
  spaces: number
  answers: number
  searches: number
  pages: number
  refused: number
}

/** One line: what the console's chat did today, linking to it. */
function ChatToday() {
  const { data } = useQuery({ queryKey: ['chat-stats'], queryFn: () => getOptional<ChatStats>('/api/chats/stats'), refetchInterval: 30_000 })
  if (!data) return null
  const n = (v: number, one: string, many = `${one}s`) => `${v} ${v === 1 ? one : many}`
  const today = [n(data.answers, 'answer'), n(data.searches, 'search', 'searches'), `${n(data.pages, 'page')} read`]
  if (data.refused) today.push(`${n(data.refused, 'link')} refused`)
  return (
    <Link
      to="/chat"
      className="group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-panel px-4 py-2.5 text-[13px] shadow-[var(--shadow)] transition-colors hover:border-line-strong hover:bg-panel-2"
      data-testid="chat-today"
    >
      <MessagesSquare className="size-4 text-faint" aria-hidden />
      <span className="font-medium text-fg">Chat today</span>
      <span className="num text-muted">{today.join(' · ')}</span>
      <span className="num ml-auto text-xs text-faint">
        {n(data.chats, 'chat')}
        {data.spaces ? ` in ${n(data.spaces, 'space')}` : ''}
      </span>
      <ArrowRight className="size-3.5 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden />
    </Link>
  )
}

export default function Overview() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <div className="lg:col-span-8">
        <Hero />
      </div>
      <div className="lg:col-span-4">
        <GpuCard />
      </div>
      <div className="lg:col-span-12">
        <ChatToday />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:col-span-12 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <TodayCard />
        </div>
        <div className="lg:col-span-3">
          <QueueCard />
        </div>
        <div className="sm:col-span-2 lg:col-span-5">
          <ConvCacheCard />
        </div>
      </div>
      <div className="lg:col-span-8">
        <MemoryCard />
      </div>
      <div className="lg:col-span-4">
        <Activity />
      </div>
      <div className="lg:col-span-12">
        <Insights />
      </div>
    </div>
  )
}
