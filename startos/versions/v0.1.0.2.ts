import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_0_2 = VersionInfo.of({
  version: '0.1.0:2',
  releaseNotes: {
    en_US:
      'Outcrop now follows changes to your hardware. With less RAM, it moves to the hardware profile that fits before ' +
      'any preset starts, and a notification says what changed. With more RAM or another GPU, a task offers the profile ' +
      'that fits; Update hardware settings takes it (and downloads its model pack, if it adds one).\n\n' +
      'New under Configure: Models to keep. Keeping only the boot preset’s model pack fits a smaller disk (about 120 GB ' +
      'for speed); Outcrop chooses it by itself at the first start when the disk is too small for every pack.',
  },
  migrations: {
    // Nothing to migrate: the new setting ("packs" in presets.json) defaults to every pack, and 0.1.0:1 ignores it
    // (lib/strata_presets.py settings() keeps only the settings it knows), so going back is safe too.
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
