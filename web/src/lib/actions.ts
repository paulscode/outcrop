// Actions shared by the pages, the banner and the command palette: they call the API, refresh what changed and say what
// happened in a toast.

import { toast } from 'sonner'
import { api, ApiError } from './api'
import { dur } from './format'
import { qk, queryClient } from './queries'
import { switchStore } from './live'
import type { SwitchState } from './types'

function fail(what: string, e: unknown) {
  const msg = e instanceof ApiError ? e.message : (e as Error)?.message || 'something went wrong'
  if (e instanceof ApiError && e.reauth && /cancelled/.test(e.message)) {
    toast(`${what}: not done`, { description: 'The password was not entered again.' })
    return
  }
  toast.error(`${what} failed`, { description: msg })
}

function refreshAccess() {
  void queryClient.invalidateQueries({ queryKey: qk.state })
  void queryClient.invalidateQueries({ queryKey: qk.access })
}

export async function openApi(minutes: number, addresses: string[] = [], listeners: string[] = []) {
  try {
    const r = await api.put<{ until: number; addresses: string[]; listeners: string[] }>('/api/access/mode', {
      mode: 'open',
      minutes,
      addresses,
      listeners,
    })
    refreshAccess()
    toast.warning(`The API is open for ${dur(minutes * 60)}`, {
      description: `Requests without a token are allowed${r.addresses?.length ? ` from ${r.addresses.join(', ')}` : ' from the whole LAN'}. It closes by itself.`,
    })
    return true
  } catch (e) {
    fail('Opening the API', e)
    return false
  }
}

export async function closeApi() {
  try {
    await api.put('/api/access/mode', { mode: 'enforced' })
    refreshAccess()
    toast.success('The API is closed', { description: 'Every request needs a token again.' })
    return true
  } catch (e) {
    fail('Closing the API', e)
    return false
  }
}

export async function switchPreset(name: string, when: 'now' | 'idle' = 'now', cancelInflight = false) {
  try {
    const s = await api.post<SwitchState>(`/api/presets/${encodeURIComponent(name)}/switch`, {
      when,
      cancel_inflight: cancelInflight,
    })
    switchStore.set(s)
    void queryClient.invalidateQueries({ queryKey: qk.presets })
    void queryClient.invalidateQueries({ queryKey: qk.state })
    toast(s.restart ? `Restarting ${name}` : `Switching to ${name}`, {
      description: when === 'idle' ? 'It starts when no request is running.' : 'New requests wait at the gateway and go to the new preset.',
    })
    return true
  } catch (e) {
    fail(`Switching to ${name}`, e)
    return false
  }
}

export async function cancelWaitingSwitch() {
  try {
    await api.post('/api/switches/current/cancel')
    toast('The switch was cancelled before it started')
  } catch (e) {
    fail('Cancelling the switch', e)
  }
}

export async function setDefaultPreset(name: string) {
  try {
    await api.put('/api/presets/default', { name })
    void queryClient.invalidateQueries({ queryKey: qk.presets })
    void queryClient.invalidateQueries({ queryKey: qk.state })
    toast.success(`${name} is the boot default`, { description: 'The server starts it after a reboot.' })
  } catch (e) {
    fail('Setting the boot default', e)
  }
}

export async function cancelRequest(rid: string) {
  try {
    const r = await api.post<{ cancelled?: number }>(`/api/requests/${encodeURIComponent(rid)}/cancel`)
    if (r && r.cancelled === 0) toast('That request had already finished')
    else toast('Request cancelled', { description: 'The client gets an error saying the administrator cancelled it.' })
  } catch (e) {
    fail('Cancelling the request', e)
  }
}

export async function ackAlerts(ids?: number[]) {
  try {
    await api.post('/api/alerts/ack', ids ? { ids } : {})
    void queryClient.invalidateQueries({ queryKey: qk.alerts })
  } catch (e) {
    fail('Acknowledging alerts', e)
  }
}

export async function signOut() {
  try {
    await api.post('/api/auth/logout', undefined, { no401: true })
  } catch {
    /* signed out anyway */
  }
  window.location.assign('/signin')
}

export { fail as toastFailure }
