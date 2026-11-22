import { sdk } from '../sdk'
import { dependencies } from '../dependencies'
import { setInterfaces } from '../interfaces'
import { versionGraph } from '../versions'
import { actions } from '../actions'
import { restoreInit } from '../backups'
import { setPassword } from '../actions/setPassword'
import { storeJson } from '../fileModels/store.json'
import { i18n } from '../i18n'

// Until a console password is set, a critical task asks for one (the console cannot be signed in to without it)
const watchPassword = sdk.setupOnInit(async (effects) => {
  if (!(await storeJson.read((s) => s.passwordSet).const(effects))) {
    await sdk.action.createOwnTask(effects, setPassword, 'critical', {
      reason: i18n('Set a console password before signing in'),
    })
  }
})

export const init = sdk.setupInit(
  restoreInit,
  versionGraph,
  setInterfaces,
  actions,
  dependencies,
  watchPassword,
)

export const uninit = sdk.setupUninit(versionGraph)
