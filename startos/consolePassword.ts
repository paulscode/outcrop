import { T } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { mounts } from './utils'

/** Set the console's password: the volume prepared first (the first time this runs, the service has not started yet),
 *  then docker/set-password.py with the password on stdin, which applies the console's own policy.  Throws with the
 *  policy's reasons when the password is refused. */
export async function applyConsolePassword(
  effects: T.Effects,
  password: string,
): Promise<void> {
  await sdk.SubContainer.withTemp(
    effects,
    { imageId: 'main' },
    mounts(sdk),
    'console-password',
    async (sub) => {
      await sub.execFail(['/opt/outcrop/docker/prepare.sh'], { user: 'root' })
      const r = await sub.exec(
        ['/opt/outcrop/venv/bin/python', '/opt/outcrop/docker/set-password.py'],
        {
          user: 'outcrop',
          input: password + '\n',
        },
      )
      if (r.exitCode !== 0) {
        throw new Error(
          `The console refused this password: ${String(r.stderr).trim() || 'unknown reason'}`,
        )
      }
    },
  )
}
