import { utils } from '@start9labs/start-sdk'
import { applyConsolePassword } from '../consolePassword'
import { storeJson } from '../fileModels/store.json'
import { sdk } from '../sdk'

// On install (and on any init that finds none): a random console password, applied to the console and kept for the
// Console password action, so the console is protected from the first start without the user inventing one.  A restore
// brings back both the console's state and this store, so it finds one and does nothing.
export const seedPassword = sdk.setupOnInit(async (effects) => {
  const current = await storeJson.read((s) => s.consolePassword).once()
  if (current) return
  const password = utils.getDefaultString({ charset: 'a-z,A-Z,0-9', len: 24 })
  await applyConsolePassword(effects, password)
  await storeJson.merge(effects, { consolePassword: password })
})
