import { sdk } from './sdk'

// The state (database, tokens, presets.json, logs) and StartOS's store; not the models (hundreds of GB, downloaded again).
// The models volume is mounted inside main (/data/models, /data/data), and those mounts show through in main's directory,
// so main's copy leaves them out by name. rsync's --delete does not touch excluded paths: a restore keeps them too.
export const { createBackup, restoreInit } = sdk.setupBackups(
  async ({ effects }) =>
    sdk.Backups.withOptions({ exclude: ['/models/', '/data/'] })
      .addVolume('main')
      .addVolume('startos'),
)
