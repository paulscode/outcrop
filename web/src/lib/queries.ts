import { QueryClient, useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { api, ApiError, getOptional } from './api'
import type {
  AccessInfo,
  AlertsSummary,
  BenchRun,
  CaptureState,
  EnergyInfo,
  EventRow,
  MemoryInfo,
  MetricsSeries,
  PresetsResponse,
  RequestDetail,
  RequestRow,
  RequestsSummary,
  ServerState,
  SessionInfo,
  SessionRow,
  SwitchRecord,
  SystemInfo,
  TlsStatus,
  Token,
  TokenDetail,
} from './types'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      retry: (n, e) => !(e instanceof ApiError && [401, 403, 404, 405].includes(e.status)) && n < 2,
    },
    mutations: { retry: false },
  },
})

export const qk = {
  state: ['state'] as const,
  presets: ['presets'] as const,
  switches: ['switches'] as const,
  tokens: ['tokens'] as const,
  token: (id: string) => ['token', id] as const,
  access: ['access'] as const,
  alerts: ['alerts'] as const,
  system: ['system'] as const,
  metrics: (range: string) => ['metrics', range] as const,
  events: (kind: string) => ['events', kind] as const,
  requests: (f: Record<string, string | undefined>) => ['requests', f] as const,
  request: (rid: string) => ['request', rid] as const,
  summary: (hours: number) => ['summary', Math.round(hours * 10) / 10] as const,
  session: ['session'] as const,
  sessions: ['sessions'] as const,
  tls: ['tls'] as const,
  memory: ['memory'] as const,
  energy: (days: number) => ['energy', days] as const,
  bench: ['bench'] as const,
  capture: ['capture'] as const,
}

type Opts<T> = Omit<UseQueryOptions<T, Error, T, readonly unknown[]>, 'queryKey' | 'queryFn'>

export const useServerState = (o?: Opts<ServerState>) =>
  useQuery({ queryKey: qk.state, queryFn: () => api.get<ServerState>('/api/state'), refetchInterval: 30_000, ...o })

export const usePresets = (o?: Opts<PresetsResponse>) =>
  useQuery({ queryKey: qk.presets, queryFn: () => api.get<PresetsResponse>('/api/presets'), ...o })

export const useSwitches = () =>
  useQuery({ queryKey: qk.switches, queryFn: () => api.get<SwitchRecord[]>('/api/switches?limit=30') })

export const useTokens = (o?: Opts<Token[]>) =>
  useQuery({ queryKey: qk.tokens, queryFn: () => api.get<Token[]>('/api/tokens'), refetchInterval: 20_000, ...o })

export const useToken = (id: string | null) =>
  useQuery({
    queryKey: qk.token(id ?? ''),
    queryFn: () => api.get<TokenDetail>(`/api/tokens/${encodeURIComponent(id!)}`),
    enabled: !!id,
  })

export const useAccess = (o?: Opts<AccessInfo>) =>
  useQuery({ queryKey: qk.access, queryFn: () => api.get<AccessInfo>('/api/access'), refetchInterval: 15_000, ...o })

export const useAlerts = () =>
  useQuery({ queryKey: qk.alerts, queryFn: () => api.get<AlertsSummary>('/api/alerts') })

export const useSystem = () =>
  useQuery({ queryKey: qk.system, queryFn: () => api.get<SystemInfo>('/api/system'), refetchInterval: 15_000 })

export const useMetricsSeries = (range: string) =>
  useQuery({
    queryKey: qk.metrics(range),
    queryFn: () => api.get<MetricsSeries>(`/api/metrics?range=${encodeURIComponent(range)}`),
    refetchInterval: range === '15m' || range === '1h' ? 10_000 : 60_000,
  })

export const useEvents = (kind = '', limit = 150) =>
  useQuery({
    queryKey: qk.events(kind),
    queryFn: () => api.get<EventRow[]>(`/api/events?limit=${limit}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`),
    refetchInterval: 10_000,
  })

export const useRequestsSummary = (hours: number) =>
  useQuery({
    queryKey: qk.summary(hours),
    queryFn: () => api.get<RequestsSummary>(`/api/requests-summary?hours=${hours.toFixed(2)}`),
    refetchInterval: 15_000,
  })

export const useRequestDetail = (rid: string | null) =>
  useQuery({
    queryKey: qk.request(rid ?? ''),
    queryFn: () => api.get<RequestDetail>(`/api/requests/${encodeURIComponent(rid!)}`),
    enabled: !!rid,
  })

export const fetchRequests = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v))
  return api.get<RequestRow[]>(`/api/requests?${q.toString()}`)
}

export const useSessions = () =>
  useQuery({ queryKey: qk.sessions, queryFn: () => api.get<SessionRow[]>('/api/auth/sessions') })

export const useSession = () =>
  useQuery({ queryKey: qk.session, queryFn: () => api.get<SessionInfo>('/api/auth/session') })

export const useTls = () => useQuery({ queryKey: qk.tls, queryFn: () => api.get<TlsStatus>('/api/tls') })

// Endpoints from Phases 3-4: a 404 becomes null (an empty state), not an error.
export const useMemory = () =>
  useQuery({ queryKey: qk.memory, queryFn: () => getOptional<MemoryInfo>('/api/memory'), refetchInterval: 5_000 })

export const useEnergy = (days = 30) =>
  useQuery({
    queryKey: qk.energy(days),
    queryFn: () => getOptional<EnergyInfo>(`/api/energy?days=${days}`),
    refetchInterval: 60_000,
  })

export const useBenchRuns = () =>
  useQuery({ queryKey: qk.bench, queryFn: () => getOptional<BenchRun[]>('/api/bench/runs'), refetchInterval: 15_000 })

export const useCapture = () =>
  useQuery({ queryKey: qk.capture, queryFn: () => getOptional<CaptureState>('/api/capture'), refetchInterval: 10_000 })
