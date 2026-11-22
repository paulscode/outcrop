import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// StartOS-side state, on the `startos` volume no subcontainer mounts.  consolePassword: the console's password, chosen at
// random at install and changed with Configure, kept here so the Console password action can show it (the console
// itself keeps only its hash).
const shape = z.looseObject({
  consolePassword: z.string().optional().catch(undefined),
})

export const storeJson = FileHelper.json(
  { base: sdk.volumes.startos, subpath: 'store.json' },
  shape,
)
