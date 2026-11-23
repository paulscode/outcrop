import { sdk } from './sdk'

// The state (database, tokens, presets.json, logs) and StartOS's store; not the models (hundreds of GB, downloaded again).
// The models volume is mounted beside main (/mnt/models, /mnt/data), and main holds links to them (models, data); before
// 0.1.0.1 it was mounted inside main, and those mounts showed through in main's folder, so main's copy still leaves both
// names out. rsync's --delete does not touch excluded paths: a restore keeps them too.
export const { createBackup, restoreInit } = sdk.setupBackups(
  async ({ effects }) =>
    sdk.Backups.withOptions({ exclude: ['/models/', '/data/'] })
      .addVolume('main')
      .addVolume('startos'),
)
