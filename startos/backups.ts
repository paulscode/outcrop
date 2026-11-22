import { sdk } from './sdk'

// The state (database, tokens, presets.json, logs) and StartOS's store; not the models (hundreds of GB, downloaded again)
export const { createBackup, restoreInit } = sdk.setupBackups(
  async ({ effects }) => sdk.Backups.ofVolumes('main', 'startos'),
)
