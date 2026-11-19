import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  type ErrorComponentProps,
} from '@tanstack/react-router'
import { AlertOctagon } from 'lucide-react'
import { api, ApiError } from './lib/api'
import { qk, queryClient } from './lib/queries'
import type { ServerState } from './lib/types'
import { AppShell } from './components/shell/Shell'
import { Button } from './components/ui/button'

function RootLayout() {
  return <Outlet />
}

function PageError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="mx-auto mt-16 max-w-lg rounded-xl border border-error/30 bg-error-bg p-6" role="alert">
      <div className="flex items-center gap-2 text-error">
        <AlertOctagon className="size-5" aria-hidden />
        <h2 className="text-[15px] font-semibold">This page failed to load</h2>
      </div>
      <p className="mt-2 text-[13px] text-muted">{(error as Error)?.message || String(error)}</p>
      <Button className="mt-4" onClick={reset}>
        Try again
      </Button>
    </div>
  )
}

function Pending() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading">
      <div className="h-36 animate-pulse rounded-xl border border-line bg-panel" />
      <div className="grid gap-4 md:grid-cols-3">
        <div className="h-28 animate-pulse rounded-xl border border-line bg-panel" />
        <div className="h-28 animate-pulse rounded-xl border border-line bg-panel" />
        <div className="h-28 animate-pulse rounded-xl border border-line bg-panel" />
      </div>
    </div>
  )
}

const rootRoute = createRootRoute({ component: RootLayout })

const signinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signin',
  validateSearch: (s: Record<string, unknown>): { next?: string } => ({
    next: typeof s.next === 'string' && s.next.startsWith('/') && !s.next.startsWith('//') ? s.next : undefined,
  }),
  component: lazyRouteComponent(() => import('./pages/SignIn')),
})

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AppShell,
  errorComponent: PageError,
  beforeLoad: async ({ location }) => {
    try {
      await queryClient.ensureQueryData({ queryKey: qk.state, queryFn: () => api.get<ServerState>('/api/state', { no401: true }) })
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        throw redirect({ to: '/signin', search: { next: location.href !== '/' ? location.href : undefined } })
      }
      throw e
    }
  },
})

function page<const P extends string, S extends Record<string, unknown> = Record<never, never>>(
  path: P,
  loader: () => Promise<{ default: React.ComponentType }>,
  validateSearch?: (s: Record<string, unknown>) => S,
) {
  return createRoute({
    getParentRoute: () => appRoute,
    path,
    component: lazyRouteComponent(loader),
    errorComponent: PageError,
    pendingComponent: Pending,
    validateSearch: validateSearch ?? ((() => ({})) as unknown as (s: Record<string, unknown>) => S),
  })
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

type Opt<K extends string> = Partial<Record<K, string>>
function pick<K extends string>(...keys: K[]) {
  return (s: Record<string, unknown>): Opt<K> => {
    const out: Opt<K> = {}
    for (const k of keys) {
      const v = str(s[k])
      if (v !== undefined) out[k] = v
    }
    return out
  }
}

const routes = [
  page('/chat', () => import('./pages/Chat'), pick('space')),
  page('/chat/$chatId', () => import('./pages/Chat'), pick('msg')),
  page('/', () => import('./pages/Overview')),
  page('/live', () => import('./pages/Live')),
  page('/requests', () => import('./pages/Requests'), pick('app', 'token', 'status', 'q', 'ip', 'rid')),
  page('/presets', () => import('./pages/Presets'), pick('tab')),
  page('/access', () => import('./pages/Access'), pick('token', 'new')),
  page('/connect', () => import('./pages/Connect'), pick('app')),
  page('/playground', () => import('./pages/Playground')),
  page('/lab', () => import('./pages/Lab'), pick('run')),
  page('/strata', () => import('./pages/StrataChat')),
  page('/system', () => import('./pages/System')),
  page('/logs', () => import('./pages/Logs'), pick('source', 'q')),
  page('/timeline', () => import('./pages/Timeline'), pick('kind')),
  page('/settings', () => import('./pages/Settings')),
]

const routeTree = rootRoute.addChildren([signinRoute, appRoute.addChildren(routes)])

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  defaultPendingMs: 150,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
