import {
  Activity,
  MessagesSquare,
  FlaskConical,
  Gauge,
  History,
  KeyRound,
  Layers,
  ListTree,
  MessageSquareText,
  Plug,
  ScrollText,
  Server,
  Settings,
  Waves,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  keywords?: string
  /** g + key jumps here */
  key?: string
}

export const NAV: Array<{ group: string; items: NavItem[] }> = [
  {
    group: '',
    items: [{ to: '/chat', label: 'Chat', icon: MessagesSquare, key: 'h', keywords: 'chat ask conversation assistant talk spaces search web' }],
  },
  {
    group: 'Operate',
    items: [
      { to: '/', label: 'Overview', icon: Gauge, key: 'o', keywords: 'home dashboard now' },
      { to: '/live', label: 'Live', icon: Waves, key: 'l', keywords: 'river lanes in flight requests now' },
      { to: '/requests', label: 'Requests', icon: ListTree, key: 'r', keywords: 'log history search' },
      { to: '/presets', label: 'Presets', icon: Layers, key: 'p', keywords: 'switch model speed balanced quality' },
    ],
  },
  {
    group: 'Access',
    items: [
      { to: '/access', label: 'Access', icon: KeyRound, key: 'a', keywords: 'tokens open enforced cors keys' },
      { to: '/connect', label: 'Connect', icon: Plug, key: 'c', keywords: 'wizard app setup claude code open webui' },
    ],
  },
  {
    group: 'Tools',
    items: [
      { to: '/playground', label: 'Playground', icon: MessageSquareText, key: 'y', keywords: 'compare try prompt bench code' },
      { to: '/lab', label: 'Lab', icon: FlaskConical, key: 'b', keywords: 'benchmark quickbench validate qualgate apitest' },
    ],
  },
  {
    group: 'Server',
    items: [
      { to: '/system', label: 'System', icon: Server, key: 's', keywords: 'hardware gpu posture security services ports energy' },
      { to: '/logs', label: 'Logs', icon: ScrollText, key: 'g', keywords: 'journal tail' },
      { to: '/timeline', label: 'Timeline', icon: History, key: 't', keywords: 'events audit log' },
      { to: '/settings', label: 'Settings', icon: Settings, key: ',', keywords: 'password sessions telegram alerts certificate' },
    ],
  },
]

export const ALL_NAV: NavItem[] = NAV.flatMap((g) => g.items)

export function titleFor(path: string): string {
  if (path === '/strata') return 'The engine’s own page'
  const exact = ALL_NAV.find((n) => n.to === path)
  if (exact) return exact.label
  const pre = ALL_NAV.filter((n) => n.to !== '/' && path.startsWith(n.to)).sort((a, b) => b.to.length - a.to.length)[0]
  return pre?.label ?? 'Outcrop'
}

export { Activity }
