import { T } from '@start9labs/start-sdk'
import { profile } from './actions/profile'
import { i18n } from './i18n'
import { sdk } from './sdk'
import { HARDWARE_TASK } from './utils'

/** What docker/profile.py follow answers (lib/profiles.py hardware() and follow()). */
type Follow = {
  first: boolean
  packs_message: string | null
  error?: string
  hardware: {
    profile: string | null
    fits: string | null
    ram_gib: number
    change: 'none' | 'more' | 'less' | 'other' | 'unknown'
    message: string
    moved?: { from: string; to: string }
  } | null
}

/**
 * Before Outcrop starts, every time: presets.json from the hardware profile that fits (the first time), and when the RAM
 * went down, the move to the smaller profile, whose presets fit (no download).  More RAM or another GPU is only offered:
 * a task on the service's page, to run "Update hardware settings" (it can download a pack).  A move, or a first start
 * on a disk too small for every pack, is told in a notification.  Never stops the start: what fails is logged.
 */
export async function followHardware(
  effects: T.Effects,
  sub: {
    exec: (
      cmd: string[],
      opts?: { user?: string },
    ) => Promise<{
      exitCode: number | null
      stdout: string | Buffer
      stderr: string | Buffer
    }>
  },
): Promise<void> {
  let r: Follow
  try {
    const x = await sub.exec(
      [
        '/opt/outcrop/venv/bin/python',
        '/opt/outcrop/docker/profile.py',
        'follow',
      ],
      { user: 'root' },
    )
    r = JSON.parse(String(x.stdout)) as Follow
  } catch (e) {
    console.error(`hardware profile check: ${String(e)}`)
    return
  }
  if (r.error) console.error(`hardware profile check: ${r.error}`)
  if (r.packs_message) {
    await sdk.notification.create(effects, {
      level: 'warning',
      title: i18n('Outcrop keeps only one model pack'),
      message: r.packs_message,
    })
  }
  const h = r.hardware
  if (!h) return
  if (h.moved) {
    await sdk.notification.create(effects, {
      level: 'warning',
      title: i18n('Outcrop moved to a smaller hardware profile'),
      message: h.message,
    })
  }
  if (h.change === 'more' || h.change === 'other') {
    await sdk.action.createOwnTask(effects, profile, 'important', {
      replayId: HARDWARE_TASK,
      reason: h.message,
    })
  } else {
    await sdk.action.clearTask(effects, HARDWARE_TASK)
  }
}
