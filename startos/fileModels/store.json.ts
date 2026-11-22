import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// StartOS-side state, on the `startos` volume no subcontainer mounts.  Outcrop's own secrets (the password hash, the
// tokens) stay in its database on `main`; this only remembers that a console password was set.
const shape = z.looseObject({
  passwordSet: z.boolean().catch(false),
})

export const storeJson = FileHelper.json(
  { base: sdk.volumes.startos, subpath: 'store.json' },
  shape,
)
