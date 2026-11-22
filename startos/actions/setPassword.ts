import { i18n } from '../i18n'
import { sdk } from '../sdk'
import { storeJson } from '../fileModels/store.json'
import { mounts } from '../utils'

export const setPassword = sdk.Action.withoutInput(
  'set-password',
  async ({ effects }) => ({
    name: i18n('Set console password'),
    description: i18n(
      'Make a new console password (six random words). It is shown once; every console session is signed out.',
    ),
    warning: (await storeJson.read((s) => s.passwordSet).const(effects))
      ? i18n('Replaces the current console password and signs everyone out.')
      : null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),
  async ({ effects }) => {
    const out = await sdk.SubContainer.withTemp(
      effects,
      { imageId: 'main' },
      mounts(sdk),
      'set-password',
      async (sub) => {
        // a fresh install asks for the password before its first start: the volume's layout and the console's state
        // come first (docker/prepare.sh, idempotent; the next start refreshes what it cannot know here)
        await sub.execFail(['/opt/outcrop/docker/prepare.sh'], { user: 'root' })
        return sub.execFail(
          [
            '/opt/outcrop/venv/bin/python',
            '/opt/outcrop/docker/set-password.py',
          ],
          { user: 'outcrop' },
        )
      },
    )
    const { username, password } = JSON.parse(String(out.stdout)) as {
      username: string
      password: string
    }
    await storeJson.merge(effects, { passwordSet: true })
    return {
      version: '1',
      title: i18n('Console sign-in'),
      message: i18n(
        'Keep the password in your password manager: it is shown only now.',
      ),
      result: {
        type: 'group',
        value: [
          {
            type: 'single',
            name: i18n('User name'),
            description: null,
            value: username,
            masked: false,
            copyable: true,
            qr: false,
            launchable: false,
          },
          {
            type: 'single',
            name: i18n('Password'),
            description: null,
            value: password,
            masked: true,
            copyable: true,
            qr: false,
            launchable: false,
          },
        ],
      },
    }
  },
)
