import { T } from '@start9labs/start-sdk'
import { i18n } from '../i18n'
import { sdk } from '../sdk'
import { mounts } from '../utils'

// presets.json is made from this machine's hardware profile at the first start and then kept, so an update that
// improves the profile changes nothing by itself.  This applies the profile as this version has it (docker/profile.py).
export const profile = sdk.Action.withoutInput(
  'profile',

  async ({ effects }) => ({
    name: i18n('Update hardware settings'),
    description: i18n(
      'Takes the newest settings for your kind of machine (its hardware profile), which an update of Outcrop may have improved. Your choices under Configure, the boot preset and the network settings are kept.',
    ),
    warning: i18n(
      'If there is anything new, Outcrop restarts to use it (a few minutes). Changes made to the presets in the web console’s editor are replaced by the profile’s; a copy of the old file is kept.',
    ),
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  async ({ effects }): Promise<T.ActionResult & { version: '1' }> => {
    const r = await sdk.SubContainer.withTemp(
      effects,
      { imageId: 'main' },
      mounts(sdk),
      'profile',
      async (sub) => {
        await sub.execFail(['/opt/outcrop/docker/prepare.sh'], { user: 'root' })
        return sub.exec(
          [
            '/opt/outcrop/venv/bin/python',
            '/opt/outcrop/docker/profile.py',
            'apply',
          ],
          { user: 'outcrop' },
        )
      },
    )
    if (r.exitCode !== 0) {
      throw new Error(
        String(r.stderr).trim() || 'the hardware profile could not be applied',
      )
    }
    const out = JSON.parse(String(r.stdout)) as {
      profile: string
      changes: boolean
      diff: string
    }
    let restarted = false
    if (out.changes) {
      const st = await effects.getStatus({})
      if (st?.desired.main === 'running') {
        await sdk.restart(effects)
        restarted = true
      }
    }
    return {
      version: '1' as const,
      title: i18n('Update hardware settings'),
      message: !out.changes
        ? `${i18n('Already up to date: nothing new in the hardware profile')} ${out.profile}.`
        : `${i18n('Updated to the newest settings of the hardware profile')} ${out.profile}. ${
            restarted
              ? i18n('Outcrop is restarting to use them.')
              : i18n('Outcrop uses them when it starts.')
          } ${i18n('What changed is below.')}`,
      result: out.changes
        ? {
            type: 'single' as const,
            value: out.diff,
            copyable: true,
            qr: false,
            masked: false,
            launchable: false,
          }
        : null,
    }
  },
)
