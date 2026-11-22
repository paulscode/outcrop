import { T } from '@start9labs/start-sdk'
import { storeJson } from '../fileModels/store.json'
import { i18n } from '../i18n'
import { sdk } from '../sdk'

// Shows the console's password so the user can copy it: masked AND copyable, so the copy button works without putting
// the password on the screen.  It is changed with Configure.
export const consolePasswordInfo = sdk.Action.withoutInput(
  'console-password',

  async ({ effects }) => ({
    name: i18n('Console password'),
    description: i18n('Show the password for signing in to the web console'),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  async ({ effects }): Promise<T.ActionResult & { version: '1' }> => {
    const pw = await storeJson.read((s) => s.consolePassword).once()
    return {
      version: '1' as const,
      title: i18n('Console password'),
      message: i18n(
        'Sign in to the web console with this password. Change it with Configure.',
      ),
      result: {
        type: 'single' as const,
        value: pw ?? '',
        copyable: true,
        qr: false,
        masked: true,
        launchable: false,
      },
    }
  },
)
