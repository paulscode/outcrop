// The console API's shapes (console/outcrop/console/app.py, live.py, control.py, system.py, alerts.py).
// Every field the backend may omit or null is optional here: the UI shows "—" rather than failing.

export type AuthMode = 'enforced' | 'open'

export interface ServerState {
  host: string
  version: string
  user: string
  dev: boolean
  fake: boolean
  started_at: number
  console: { https: boolean; hsts: boolean; tls: TlsStatus | null }
  server: {
    preset: string | null
    default: string | null
    presets: string[]
    model_id: string
  }
  auth: {
    mode: AuthMode
    until: number | null
    addresses: string[]
    listeners: string[]
  }
  tokenless: { enabled: boolean; addresses: string[] }
  gateway: GatewayState
  switch: SwitchState | null
  alerts: { open: number }
  urls: {
    openai: string
    anthropic: string
    ollama: string
    hostname: string
    addresses: string[]
    openai_port: number
    ollama_port: number
  }
}

export interface GatewayState {
  up?: boolean
  version?: string
  started_at?: number
  db_ok?: boolean
  auth?: {
    mode?: AuthMode
    until?: number | null
    addresses?: string[]
    listeners?: string[]
    by?: string | null
  }
  tokenless?: { enabled: boolean; addresses: string[] }
  strata?: {
    up?: boolean
    loaded?: boolean
    preset?: string | null
    model?: string | null
  }
  hold?: {
    ready?: boolean
    reason?: string
    explicit?: unknown
    since?: number
    waiting?: number
  }
  inflight?: Flight[]
  counts?: { requests?: number; denied?: number; errors?: number }
  tokens?: number
  capture?: { enabled?: boolean }
  listen?: { openai?: number; ollama?: number }
}

// ------------------------------------------------------------------------------------------------- live metrics
export interface GpuProc {
  pid: number
  mem: number
  name: string
  kind: 'compute' | 'graphics'
}

export interface MetricsSample {
  t: number
  gpu: {
    util?: number | null
    mem_util?: number | null
    mem_used?: number | null
    mem_total?: number | null
    temp?: number | null
    power?: number | null
    sm_clock?: number | null
    mem_clock?: number | null
    fan?: number | null
    pcie_gen?: number | null
    pcie_width?: number | null
    throttle?: string[] | null
    pcie_rx?: number | null
    pcie_tx?: number | null
    procs?: GpuProc[]
    energy_j?: number | null
  }
  host: {
    cpu?: number
    cpu_nodes?: number[]
    ram_total?: number
    ram_available?: number
    ram_used?: number
    cached?: number
    anon?: number
    mlocked?: number
    disk_read?: number
    disk_write?: number
    net_rx?: number
    net_tx?: number
    load?: number
  }
  engine: {
    state?: string | null
    phase?: string | null
    queued?: number | null
    active?: number | null
    prompt_read?: number | null
    prompt_total?: number | null
    generated?: number | null
    tok_s?: number | null
    loaded?: boolean | null
  }
  gw: { inflight?: number; held?: number }
}

export interface EngineRequest {
  id: string
  time: number
  duration_s?: number
  finish?: string
  prompt_tokens?: number
  reused?: number
  output_tokens?: number
  prompt_read?: number
  prompt_ms?: number
  decode_ms?: number
  decode_tok_s?: number
  hit_rate?: number
  pcie_share?: number
  drafts_offered?: number
  drafts_accepted?: number
  first_engine_token_s?: number
}

export interface EngineSnapshot {
  engine: {
    model?: string
    version?: string
    context?: number
    kv?: string
    kv_resident?: number
    expert_slots?: number
    expert_cache_mib?: number
    vram_free_mib?: number
    arena_mib?: number
    pool_workers?: number
    spec?: number
    mtp_max?: number
    drafting?: string
    conversation_cache_mib?: number
    conversation_cache_slots?: number
    prefill_cap?: number
  }
  live: {
    state?: string
    queued?: number
    phase?: string | null
    prompt_tokens?: number | null
    prompt_read?: number | null
    prompt_total?: number | null
    generated?: number | null
    max_tokens?: number | null
    elapsed_s?: number | null
    tok_s?: number | null
    tok_s_mean?: number | null
    prefill_tok_s_mean?: number | null
  }
  conversation_cache: {
    enabled?: boolean
    budget_mib?: number
    slots?: number
    parked?: number
    bytes?: number
    evictions?: number
    parks?: number
    restores?: number
    requests?: number
    requests_reused?: number
    reused_tokens?: number
    prompt_tokens?: number
    last_event?: string
    last_at?: number
  }
  totals: {
    since?: number
    requests?: number
    prompt_tokens?: number
    reused?: number
    output_tokens?: number
    prompt_ms?: number
    decode_ms?: number
    drafts_offered?: number
    drafts_accepted?: number
  }
  requests: EngineRequest[]
  hardware_static?: {
    gpu_name?: string
    cpu_name?: string
    cores?: number
    threads?: number
    numa_nodes?: number
  }
  at?: number
}

export interface UnitState {
  active?: string
  sub?: string
  since?: string | null
  pid?: number
  restarts?: number
  result?: string
  enabled?: string
}
export type Units = Record<string, UnitState>

// ------------------------------------------------------------------------------------------------------ requests
export type FlightPhase =
  | 'waiting'
  | 'held'
  | 'reading'
  | 'thinking'
  | 'answering'
  | 'done'
  | string

/** A gateway request, as request.start announces it and later events complete it. */
export interface Flight {
  rid: string
  listener?: string
  method?: string
  path?: string
  client_ip?: string
  app?: string
  token_id?: string | null
  token?: string | null
  auth?: string
  model?: string | null
  stream?: boolean | number | null
  started_at: number
  first_token_at?: number | null
  answer_at?: number | null
  first_byte_at?: number | null
  ended_at?: number | null
  tokens?: number
  think_tokens?: number
  answer_tokens?: number
  phase?: FlightPhase
  held_ms?: number | null
  held_reason?: string
  kind?: string
  status?: number | null
  outcome?: string | null
  error?: string | null
  prompt_tokens?: number | null
  output_tokens?: number | null
  reused_tokens?: number | null
  ttft_ms?: number | null
  think_ms?: number | null
  prefill_tok_s?: number | null
  decode_tok_s?: number | null
  hit_rate?: number | null
  pcie_share?: number | null
  drafts_offered?: number | null
  drafts_accepted?: number | null
  finish?: string | null
  preset?: string | null
  user_agent?: string
  route_class?: string
  auth_reason?: string
  bytes_in?: number | null
  bytes_out?: number | null
  denied?: boolean
  reason?: string
}

export interface RequestRow extends Flight {
  id: number
  token_name?: string | null
  strata_id?: string | null
}

export interface RequestDetail extends RequestRow {
  live?: boolean
  captured?: { request: string | null; response: string | null }
}

export interface AuthFail {
  rid: string
  ip: string
  app: string
  path: string
  listener: string
  status: number
  reason: string
  token: string | null
  at?: number
}

// --------------------------------------------------------------------------------------------------------- tokens
export type Scope = 'inference' | 'telemetry' | 'web' | 'admin'
export type Listener = 'openai' | 'ollama'

export interface Token {
  id: string
  name: string
  notes: string
  kind: 'user' | 'local-tools'
  scopes: Scope[]
  listeners: Listener[]
  cidrs: string[]
  expires_at: number | null
  rpm: number | null
  concurrency: number | null
  imported: boolean
  hint: string
  created_at: number
  created_by: string
  rotated_at: number | null
  revoked_at: number | null
  revoked_by: string | null
  revoke_reason: string | null
  last_used_at: number | null
  last_ip: string | null
  last_app: string | null
  status: 'active' | 'revoked' | 'expired'
  usage?: {
    days: Record<string, number>
    requests: number
    prompt_tokens: number
    output_tokens: number
    errors: number
  }
}

export interface TokenDetail extends Token {
  recent: Array<
    Pick<
      RequestRow,
      | 'rid'
      | 'started_at'
      | 'client_ip'
      | 'app'
      | 'path'
      | 'status'
      | 'outcome'
      | 'prompt_tokens'
      | 'output_tokens'
      | 'ttft_ms'
      | 'decode_tok_s'
    >
  >
  seen: Array<{ app: string; client_ip: string; n: number; last: number }>
}

export interface TokenCreated {
  token: Token
  plaintext: string | null
}

export interface AccessInfo {
  mode: {
    mode: AuthMode
    until?: number
    addresses?: string[]
    listeners?: string[]
    by?: string
    at?: number
  }
  tokenless: { enabled: boolean; addresses: string[] }
  cors: string[]
  hosts: string[]
  anonymous: Array<{
    client_ip: string
    app: string
    n: number
    denied: number
    last: number
    reason: string | null
  }>
  max_open_minutes: number
}

// -------------------------------------------------------------------------------------------------------- presets
export interface Measured {
  decode: number
  prompt: number
  ttft: number
}

export interface PresetCard {
  name: string
  pack: string
  description: string
  context: number
  rope: { scaling: string; scale: number } | null
  quality: number | null
  bits: number | null
  running: boolean
  default: boolean
  warm: number | null
  estimate_s: number | null
  expert_slots: number | null
  measured: { at?: number } & Partial<
    Record<'chat' | 'code' | 'story' | 'doc4k', Measured>
  >
  measured_from: string
  last_switch_s?: number
  last_switch_at?: number
  expert_vram_gib?: number
  arena_gib?: number
  load_rate?: number
}

export interface PresetsResponse {
  presets: PresetCard[]
  current: string | null
  default: string | null
  switch: SwitchState | null
}

export interface SwitchEvent {
  type:
    | 'plan'
    | 'phase'
    | 'progress'
    | 'experts_loaded'
    | 'drain'
    | 'tick'
    | 'waiting'
    | 'done'
  phase?: string
  label?: string
  at?: number
  elapsed_s?: number
  rss_gib?: number
  target_gib?: number | null
  gib?: string | number
  rate?: string | number
  left?: number
  count?: number
  ok?: boolean
  error?: string | null
  total_s?: number
  reason?: string
  preset?: string
  from?: string | null
  warm?: number | null
  estimate_s?: number | null
  ram_need_gib?: number
  ram_avail_gib?: number
  low_ram?: boolean
  slots?: string
  vram?: string
  gb?: string
}

export interface SwitchState {
  id: string
  to: string
  from: string | null
  status: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled'
  when: 'now' | 'idle'
  events: SwitchEvent[]
  last?: SwitchEvent
  started_at: number
  ended_at?: number
  by: string
  restart: boolean
  error?: string
}

export interface SwitchRecord {
  id: number
  started_at: number
  ended_at: number | null
  from_preset: string | null
  to_preset: string
  by: string
  phases: Array<{
    key: string
    label: string
    start: number
    end: number | null
  }>
  ok: number | null
  error: string | null
  warm: number | null
}

// ---------------------------------------------------------------------------------------------- events and alerts
export interface EventRow {
  id: number
  at: number
  kind: string
  level: 'info' | 'warn' | 'error'
  actor: string
  source: string
  summary: string
  details: Record<string, unknown>
}

export interface AlertRow {
  id: number
  rule: string
  key: string
  level: 'info' | 'warn' | 'error'
  opened_at: number
  closed_at: number | null
  last_seen: number
  summary: string
  details: Record<string, unknown>
  acked_at: number | null
  sent: { telegram?: string }
}

export interface TelegramPublic {
  configured: boolean
  enabled: boolean
  bot: string | null
  chat_id: number | null
  chat_name: string | null
  token_hint: string | null
  last_ok: number | null
  last_error: string | null
  last_error_at: number | null
  /** Telegram commands from your own chat (/status, /switch PRESET, /close) */
  commands?: boolean
}

export interface AlertRule {
  enabled: boolean
  telegram: boolean
  label: string
  level: 'info' | 'warn' | 'error'
}

export interface AlertsSummary {
  open: AlertRow[]
  recent: AlertRow[]
  telegram: TelegramPublic
  unacked: number
  rules?: Record<string, AlertRule>
}

// --------------------------------------------------------------------------------------------------------- system
export interface PostureCheck {
  key: string
  ok: boolean
  title: string
  detail: string
  fix: string | null
  level: 'ok' | 'info' | 'warn' | 'error'
}

export interface SystemInfo {
  info: {
    hostname: string
    os: string
    kernel: string
    cpu: string | null
    cores: number | null
    threads: number | null
    numa_nodes: number
    gpu: {
      name?: string
      driver?: string
      cuda?: string | null
      memory?: 'discrete' | 'unified'
      vram_total_mib?: number | null
      power_limit_w?: number | null
      pcie_gen_max?: number | null
      pcie_width_max?: number | null
    }
    cuda: string | null
    strata_commit: string
    patches: string[]
    engines: string[]
    models: Array<{ path: string; gib: number }>
    python: string
    console_version: string
    disk: { total_gb: number; free_gb: number; used_pct: number }
    units: Units
    engine: EngineSnapshot['engine'] | null
    ports: Array<{ address: string; port: number | string; lan: boolean }>
    uptime_s: number
  }
  posture: PostureCheck[]
}

export interface MetricsSeries {
  range: string
  step_s: number
  points: Array<Record<string, number>>
}

export interface TlsStatus {
  ca: boolean
  ca_fingerprint?: string
  ca_subject?: string
  ca_not_after?: string
  constraints?: string[]
  server_not_after?: string
  server_names?: string[]
  days_left?: number
}

export interface SessionRow {
  id: string
  created_at: number
  last_seen_at: number
  expires_at: number
  remember: number
  ip: string | null
  user_agent: string | null
  current: boolean
}

export interface SessionInfo {
  user: string
  created_at: number
  expires_at: number
  remember: boolean
  reauth_ok: boolean
  reauth_until: number
}

export interface PasswordVerdict {
  ok: boolean
  score: number
  reasons: string[]
  suggestions: string[]
  crack_time: string | null
  length: number
  min_length: number
}

export interface RequestsSummary {
  n: number
  p: number | null
  o: number | null
  err: number | null
  denied: number | null
  ttft: number | null
  dec: number | null
  hit: number | null
  by_app: Array<{ app: string; n: number; o: number | null }>
  hours: number
}

// ----------------------------------------------------------------------------------- more endpoints
export interface LogLine {
  t: number
  msg: string
  level: 'info' | 'warn' | 'error'
  source?: string
}

export interface MemoryLayer {
  key: string
  label: string
  mib?: number
  gib?: number
  note?: string
}

export interface MemoryInfo {
  /** one memory for the CPU and the GPU (a GB10): the GPU's layers are in `ram`, and `vram` is empty */
  unified?: boolean
  vram: { total_mib: number; layers: MemoryLayer[] }
  ram: { total_gib: number; layers: MemoryLayer[] }
  conversation_cache: {
    slots: number
    budget_gib: number
    parked: number
    bytes: number
    requests: number
    requests_reused: number
    reused_tokens: number
    /** the gateway's last requests with a prompt (up to 500) */
    recent?: {
      requests: number
      prompt_tokens: number
      reused_tokens: number
      requests_reused: number
    }
    items?: Array<{ tokens: number; bytes: number; age_s: number }>
  }
}

export interface EnergyDay {
  day: string
  kwh: number
  requests: number
  output_tokens: number
  tokens_per_joule: number | null
}

/** GET/PUT /api/settings/engine: the settings for every preset (presets.json's "settings"). */
export interface EngineSetting {
  key: string
  title: string
  /** what it trades, in plain words */
  about: string
  default: string
  value: string
  values: Array<{ value: string; label: string }>
}
export interface EngineSettings {
  settings: EngineSetting[]
  /** the running preset, if any */
  running: string | null
  /** true: the running preset started before the last change, and takes it when restarted (null: unknown) */
  pending: boolean | null
}

export interface EnergyInfo {
  days: EnergyDay[]
  today: Partial<EnergyDay>
  price_per_kwh: number | null
  note: string
}

export type BenchKind = 'quickbench' | 'validate' | 'qualgate' | 'apitest'
export type CaseName = 'chat' | 'code' | 'story' | 'doc4k'

export interface BenchRun {
  id: number | string
  kind: BenchKind | 'import' | string
  preset: string | null
  status: 'running' | 'ok' | 'failed' | 'cancelled'
  started_at: number
  ended_at: number | null
  result: Record<string, unknown>
  contention: number | boolean
  source: string | null
  log?: string
  args?: Record<string, unknown>
}

export interface CaptureState {
  enabled: boolean
  until: number | null
  token_id: string | null
  max_requests: number | null
  count: number
}

export interface PresetsRaw {
  text: string
  hash: string
}

export interface PresetsValidation {
  ok: boolean
  errors: string[]
  diff: string
  rendered: Record<string, { args: string[]; env: Record<string, string> }>
}
