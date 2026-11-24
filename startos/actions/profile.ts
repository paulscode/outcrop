import { T } from '@start9labs/start-sdk'
import { i18n } from '../i18n'
import { sdk } from '../sdk'
import { HARDWARE_TASK, mounts } from '../utils'

// presets.json is made from this machine's hardware profile at the first start and then kept, so neither an update that
// improves the profile nor more RAM changes it by itself.  This applies the profile that fits this machine now, as this
// version has it (docker/profile.py): the same one with its newest settings, or after the RAM or the GPU changed, the one
// that fits (startos/hardware.ts offers it in a task).
export const profile = sdk.Action.withoutInput(
  'profile',

  async ({ effects }) => ({
    name: i18n('Update hardware settings'),
    description: i18n(
      'Takes the settings for your kind of machine (its hardware profile): the newest ones, which an update of Outcrop may have improved, or after you added RAM or changed the GPU, those of the profile that fits it now. Your choices under Configure, the boot preset and the network settings are kept.',
    ),
    warning: i18n(
      'If there is anything new, Outcrop restarts to use it (a few minutes, or longer when a bigger profile needs a model pack downloaded). Changes made to the presets in the web console’s editor are replaced by the profile’s; a copy of the old file is kept.',
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
      target: string
      changes: boolean
      diff: string
      hardware: { new_packs: string[]; download_gb: number }
    }
    await sdk.action.clearTask(effects, HARDWARE_TASK)
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
        : `${
            out.target !== out.profile
              ? `${i18n('Changed the hardware profile from')} ${out.profile} ${i18n('to')} ${out.target}.${
                  out.hardware.new_packs.length
                    ? ` ${i18n('It downloads')} ${out.hardware.new_packs.join(', ')} (${out.hardware.download_gb} GB) ${i18n('when Outcrop starts; the Models health check shows the progress.')}`
                    : ''
                }`
              : `${i18n('Updated to the newest settings of the hardware profile')} ${out.profile}.`
          } ${
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
