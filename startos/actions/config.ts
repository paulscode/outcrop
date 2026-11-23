import { applyConsolePassword } from '../consolePassword'
import { storeJson } from '../fileModels/store.json'
import { i18n } from '../i18n'
import { sdk } from '../sdk'
import { applySettings, readSettings, Settings } from '../settings'

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
  // The settings for every preset: the same as the console's Settings page ("Answers and memory") and `outcrop setting`.
  // Each says in plain words what it trades; the recommended choice is the default.
  exactAnswers: Value.select({
    name: i18n('Exact answers'),
    description: i18n(
      'To save time, the engine leaves out the smallest contributions to each word when they would have to be fetched from RAM or the disk. In our tests this changed how answers were worded, more often than not, but not how many were right. On computes every word in full, exactly as the model would, and answers come more slowly when the machine reads from its disk: measured 3 to 6% slower with 32 GB of RAM, and about 1% with plenty of RAM.',
    ),
    footnote: i18n(
      'Off is faster, and is what we recommend. On gives exactly what the full model would write, more slowly. Changing it restarts Outcrop (a few minutes).',
    ),
    default: 'off',
    values: {
      off: i18n('Off: faster (recommended)'),
      on: i18n('On: slower, every answer computed in full'),
    },
  }),
  context: Value.select({
    name: i18n('Longest conversation'),
    description: i18n(
      'How much one conversation can hold: the chat so far, or a document and the questions about it. The memory for it is set aside in advance, so a shorter limit leaves more memory for the model itself, which makes a machine with little memory faster. The presets for a million tokens keep their own length.',
    ),
    footnote: i18n(
      'Keep the hardware profile’s choice unless you need longer conversations, or want a little more speed on a 32 GB machine. Changing it restarts Outcrop (a few minutes).',
    ),
    default: 'profile',
    values: {
      profile: i18n('As the hardware profile sets it (recommended)'),
      '131072': i18n('131,072 tokens (about 100,000 words)'),
      '262144': i18n('262,144 tokens (about 200,000 words)'),
    },
  }),
})

export const config = sdk.Action.withInput(
  'config',

  async ({ effects }) => ({
    name: i18n('Configure'),
    description: i18n(
      'The console password, whether answers are computed in full, and how long a conversation can be',
    ),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  inputSpec,

  // pre-filled with the current settings: the password from StartOS's store (it was made at install), the rest from
  // presets.json, where the console may have changed them too
  async ({ effects }) => {
    const s = await readSettings(effects)
    return {
      consolePassword:
        (await storeJson.read((x) => x.consolePassword).once()) ?? undefined,
      exactAnswers: s.exact_answers,
      context: s.context,
    }
  },

  async ({ effects, input }) => {
    const current = await storeJson.read((s) => s.consolePassword).once()
    if (input.consolePassword !== current) {
      // applied first: a password the console refuses is not stored, and the old one keeps working
      await applyConsolePassword(effects, input.consolePassword)
    }
    await storeJson.merge(effects, { consolePassword: input.consolePassword })
    const want: Settings = {
      exact_answers: input.exactAnswers,
      context: input.context,
    }
    const changed = await applySettings(effects, want)
    // the engine reads them when a preset starts: a running Outcrop restarts to use them now
    if (changed.length > 0) {
      const st = await effects.getStatus({})
      if (st?.desired.main === 'running') await sdk.restart(effects)
    }
  },
)
