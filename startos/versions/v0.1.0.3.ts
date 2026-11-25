import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_0_3 = VersionInfo.of({
  version: '0.1.0:3',
  releaseNotes: {
    en_US:
      'A preset can name the GPUs it runs on, for a server with two cards (Strata’s layer split). Nothing changes on a ' +
      'server with one card.',
  },
  migrations: {
    // Nothing to migrate: "gpu" is a new, optional preset key, which 0.1.0:2 does not read.
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
