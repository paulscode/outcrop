import { followHardware } from './hardware'
import { i18n } from './i18n'
import { sdk } from './sdk'
import { bounded, mounts, unanswered } from './utils'

const H = '/opt/outcrop/docker/health.py'

export const main = sdk.setupMain(async ({ effects }) => {
  // The names and addresses this server is reached at (its .local name, LAN addresses, any domain or onion), from the
  // console's interface: the console and the gateway accept only these in Host and Origin.  Re-runs main when they change.
  const host = await sdk.host.getOwn(effects, 'console').const()
  const iface = Object.values(host?.bindings ?? {})
    .flatMap((b) => Object.values(b.interfaces))
    .find((i) => i.id === 'console')
  const hosts = [
    ...new Set(
      iface?.addressInfo.nonLocal
        .format('hostname-info')
        .map((h) => h.hostname) ?? [],
    ),
  ]

  const sub = sdk.SubContainer.of(
    effects,
    { imageId: 'main' },
    mounts(sdk),
    'outcrop',
  )

  // before anything starts: the hardware profile that fits, and what changed (a task, or a notification)
  await followHardware(effects, sub)

  // a check's answer comes from docker/health.py, which reads the supervisor and the services themselves
  const check =
    (which: 'console' | 'models' | 'engine' | 'web') => async () => {
      const r = await sub.exec(['python3', H, which])
      try {
        const a = JSON.parse(String(r.stdout)) as {
          result: 'success' | 'loading' | 'failure'
          message: string
        }
        return { result: a.result, message: a.message }
      } catch {
        return {
          result: 'failure' as const,
          message: `health.py ${which}: ${String(r.stderr).slice(0, 200)}`,
        }
      }
    }

  return sdk.Daemons.of(effects)
    .addOneshot('prepare', {
      subcontainer: sub,
      exec: {
        command: ['/opt/outcrop/docker/prepare.sh'],
        user: 'root',
        env: { OUTCROP_HOSTS: hosts.join(',') },
      },
      requires: [],
    })
    .addDaemon('supervisor', {
      subcontainer: sub,
      // root, to start each unit as the service user (lib/supervisor.py); the engine needs up to 120 s to stop
      exec: {
        command: ['/opt/outcrop/bin/outcrop-supervisor'],
        user: 'root',
        sigtermTimeout: 180_000,
      },
      ready: {
        display: i18n('Web console'),
        gracePeriod: 120_000,
        fn: bounded(check('console'), unanswered),
      },
      requires: ['prepare'],
    })
    .addHealthCheck('models', {
      ready: {
        display: i18n('Models'),
        fn: bounded(check('models'), unanswered),
      },
      requires: ['supervisor'],
    })
    .addHealthCheck('engine', {
      ready: {
        display: i18n('Engine'),
        fn: bounded(check('engine'), unanswered),
      },
      requires: ['supervisor'],
    })
    .addHealthCheck('web', {
      ready: {
        display: i18n('Web search'),
        fn: bounded(check('web'), unanswered),
      },
      requires: ['supervisor'],
    })
})
