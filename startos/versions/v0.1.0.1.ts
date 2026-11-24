import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_0_1 = VersionInfo.of({
  version: '0.1.0:1',
  releaseNotes: {
    en_US:
      'Fixes: Outcrop no longer stops starting after a while. Each start, password change or action left more ' +
      'mounts behind, and after about 16 of them a start failed with "No space left on device" until the server ' +
      'was restarted. The models are now mounted beside the data rather than inside it; your models are kept. A ' +
      'health check that never answers can no longer hold up stopping, updating or restarting Outcrop: one still ' +
      'running after a minute shows its last result twice more, then "This check has not finished after one ' +
      'minute" (starting, not failure) until it answers.\n\n' +
      'New: a Check answers and speed action asks the model six questions with known answers and times its ' +
      "writing. An Update hardware settings action applies this version's settings for your hardware, keeping " +
      'your own choices: run it on an M6000 or M40 for the new disk settings (with 32 GB, 59 to 77% less read ' +
      'from the disk and as fast or faster; with 64 GB, about half as much at the same speed). Configure now has Exact answers and Longest ' +
      'conversation, each explained where you choose it.',
  },
  migrations: {
    // Nothing to migrate here: the health checks change, and docker/prepare.sh turns 0.1.0:0's empty mount folders
    // into the links to the models volume when Outcrop starts.
    up: async ({ effects }) => {},
    // 0.1.0:0 mounts the models volume where this version keeps links to it (/data/models, /data/data), so it would
    // mount onto links to folders it does not have: refused rather than left broken.
    down: IMPOSSIBLE,
  },
})
