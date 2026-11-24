import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_0_1 = VersionInfo.of({
  version: '0.1.0:1',
  releaseNotes: {
    en_US:
      'A health check that never answers can no longer hold up stopping, updating or restarting Outcrop. StartOS waits for each check to finish before it stops the service, and a check stuck waiting inside the container could keep it waiting for good. A check still running after one minute is now left behind: it shows its last result twice more, then reads "This check has not finished after one minute" (starting, not failure) until it answers.',
  },
  migrations: {
    // Nothing to migrate: a change to the health checks only.
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
