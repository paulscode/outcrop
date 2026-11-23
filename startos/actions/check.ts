import { T } from '@start9labs/start-sdk'
import { i18n } from '../i18n'
import { sdk } from '../sdk'
import { mounts } from '../utils'

// Six questions with known answers, then two short writing tasks timed: what `outcrop test` and `outcrop bench` do on
// Ubuntu, through the gateway with the console's own local token.  For seeing what a setting under Configure did.
export const check = sdk.Action.withoutInput(
  'check',

  async ({ effects }) => ({
    name: i18n('Check answers and speed'),
    description: i18n(
      'Asks the model six questions with known answers, then times two short pieces of writing. Takes about a minute; for seeing what a change under Configure did.',
    ),
    warning: null,
    allowedStatuses: 'only-running',
    group: null,
    visibility: 'enabled',
  }),

  async ({ effects }): Promise<T.ActionResult & { version: '1' }> => {
    const out = await sdk.SubContainer.withTemp(
      effects,
      { imageId: 'main' },
      mounts(sdk),
      'check',
      async (sub) => {
        const url = ['--url', 'http://127.0.0.1:8080']
        const q = await sub.exec(
          ['python3', '/opt/outcrop/bench/qualgate.py', ...url],
          { user: 'outcrop' },
        )
        const b = await sub.exec(
          [
            'python3',
            '/opt/outcrop/bench/quickbench.py',
            ...url,
            '--repeat',
            '1',
            '--cases',
            'chat,code',
          ],
          { user: 'outcrop' },
        )
        return {
          answers: String(q.stdout),
          speed: String(b.stdout),
          // the last line of anything either one wrote to stderr (an error's own line), exit code or not
          errors: [q, b]
            .map((r) => String(r.stderr ?? '').trim())
            .filter(Boolean)
            .map((e) => e.split('\n').pop()),
        }
      },
    )
    const passed = (out.answers.match(/^PASS /gm) ?? []).length
    const total = passed + (out.answers.match(/^FAIL /gm) ?? []).length
    const speeds = [
      ...out.speed.matchAll(/^(\w+)\s+prompt.*decode\s+([\d.]+) tok\/s/gm),
    ].map((m) => `${m[1]} ${Math.round(Number(m[2]))}`)
    // qualgate ends with QUALITY_OK or QUALITY_FAIL: without it the check stopped part way (an engine still settling)
    const finished = /^QUALITY_(OK|FAIL)/m.test(out.answers)
    const message =
      total === 0
        ? i18n(
            'The model did not answer: is the engine still starting? See the Engine health check, then try again.',
          )
        : !finished
          ? `${i18n('The check stopped part way, after')} ${total} ${i18n('answers (the engine may still be settling after a start): try again in a minute.')}`
          : `${passed} / ${total} ${i18n('answers right')}. ${i18n('Writing speed in tokens per second (a token is about three quarters of a word):')} ${speeds.join(', ') || '?'}.`
    return {
      version: '1' as const,
      title: i18n('Check answers and speed'),
      message,
      result: {
        type: 'single' as const,
        value: [out.answers.trim(), out.speed.trim(), ...out.errors]
          .filter(Boolean)
          .join('\n\n'),
        copyable: true,
        qr: false,
        masked: false,
        launchable: false,
      },
    }
  },
)
