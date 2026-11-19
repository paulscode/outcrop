import { defineConfig } from '@playwright/test'

// End-to-end tests run against the whole dev stack (console/dev.py: the fake Strata, the gateway, the console), which
// serves the built UI (web/dist) on :8800, so the console's own headers and CSP apply.  `pnpm e2e` builds first.
const BASE = process.env.OUTCROP_URL ?? 'http://localhost:8800'
export const STATE = 'test-results/.auth/dev.json'

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: BASE,
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'cd ../console && .venv/bin/python dev.py --fresh',
    url: `${BASE}/api/auth/session`,
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'ignore',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'console',
      testIgnore: [/auth\.setup\.ts/, /signin\.spec\.ts/],
      dependencies: ['setup'],
      use: { storageState: STATE },
    },
    // signing in (and the lockout it ends with) runs last: the lockout blocks new sign-ins from this address for a while
    { name: 'signin', testMatch: /signin\.spec\.ts/, dependencies: ['console'] },
  ],
})
