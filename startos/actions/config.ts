import { applyConsolePassword } from '../consolePassword'
import { storeJson } from '../fileModels/store.json'
import { i18n } from '../i18n'
import { sdk } from '../sdk'

const { InputSpec, Value } = sdk

export const inputSpec = InputSpec.of({
  consolePassword: Value.text({
    name: i18n('Console password'),
    description: i18n(
      'The password to sign in to the web console. "Console password" under Actions shows it for copying; set your own here or generate one. At least 16 characters, and hard to guess.',
    ),
    required: true,
    default: { charset: 'a-z,A-Z,0-9', len: 24 },
    masked: true,
    generate: { charset: 'a-z,A-Z,0-9', len: 24 },
  }),
})

export const config = sdk.Action.withInput(
  'config',

  async ({ effects }) => ({
    name: i18n('Configure'),
    description: i18n('Configure Outcrop'),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  inputSpec,

  // pre-filled with the current settings (the password was made at install)
  async ({ effects }) => storeJson.read().once(),

  async ({ effects, input }) => {
    const current = await storeJson.read((s) => s.consolePassword).once()
    if (input.consolePassword !== current) {
      // applied first: a password the console refuses is not stored, and the old one keeps working
      await applyConsolePassword(effects, input.consolePassword)
    }
    await storeJson.merge(effects, input)
  },
)
