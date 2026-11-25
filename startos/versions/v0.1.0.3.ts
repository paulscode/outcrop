import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_0_3 = VersionInfo.of({
  version: '0.1.0:3',
  releaseNotes: {
    en_US:
      'Outcrop now uses a second Quadro M6000 (or Tesla M40): with two cards, the hardware profile for two runs every ' +
      'preset on both. Measured: long prompts read 34 to 85% faster, code and documents answered up to 31% faster, and ' +
      'with 32 GB of RAM the second card holds the experts that would otherwise be read from the disk. Adding a card is ' +
      'offered in a task (Update hardware settings takes it); taking one out moves back to the one-card profile by ' +
      'itself.\n\n' +
      'Also: a preset with several conversations at once now counts their memory before it starts, instead of ' +
      'stalling a server that does not have the RAM.',
  },
  migrations: {
    // Nothing to migrate: "gpu" is a new, optional key and the two-card profiles new files; 0.1.0:2 reads neither (a
    // two-card presets.json there runs on one card).
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
