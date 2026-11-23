import { T } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { mounts } from './utils'

/** The settings for every preset (lib/strata_presets.py SETTINGS), kept in presets.json's "settings" section: the same
 *  ones as the console's Settings page and `outcrop setting`, so each shows what any of them chose last. */
export type Settings = {
  exact_answers: 'off' | 'on'
  context: 'profile' | '131072' | '262144'
}

const PY = '/opt/outcrop/venv/bin/python'
const SCRIPT = '/opt/outcrop/docker/settings.py'

/** This machine's settings (the defaults before the first start has made presets.json). */
export async function readSettings(effects: T.Effects): Promise<Settings> {
  return sdk.SubContainer.withTemp(
    effects,
    { imageId: 'main' },
    mounts(sdk),
    'settings-get',
    async (sub) => {
      const r = await sub.exec([PY, SCRIPT, 'get'], { user: 'outcrop' })
      if (r.exitCode !== 0) {
        throw new Error(
          `Reading the settings failed: ${String(r.stderr).trim() || 'unknown reason'}`,
        )
      }
      return JSON.parse(String(r.stdout)) as Settings
    },
  )
}

/** Write the settings that changed; returns their names.  The volume is prepared first (presets.json is made from this
 *  machine's hardware profile the first time). */
export async function applySettings(
  effects: T.Effects,
  want: Settings,
): Promise<string[]> {
  return sdk.SubContainer.withTemp(
    effects,
    { imageId: 'main' },
    mounts(sdk),
    'settings-set',
    async (sub) => {
      await sub.execFail(['/opt/outcrop/docker/prepare.sh'], { user: 'root' })
      const r = await sub.exec([PY, SCRIPT, 'set'], {
        user: 'outcrop',
        input: JSON.stringify(want),
      })
      if (r.exitCode !== 0) {
        throw new Error(
          `The settings were not saved: ${String(r.stderr).trim() || 'unknown reason'}`,
        )
      }
      return (JSON.parse(String(r.stdout)) as { changed: string[] }).changed
    },
  )
}
