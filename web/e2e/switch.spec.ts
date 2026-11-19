import { test } from '@playwright/test'
import { chat, consoleApi, devTokens, expect } from './helpers'

test('a preset switch: the launch sequence, a request held for it and answered by the new preset', async ({ page, request }) => {
  test.setTimeout(150_000)
  const st = await (await consoleApi(page.request, 'GET', '/api/state')).json()
  const target = st.server.preset === 'speed' ? 'balanced' : 'speed'
  await page.goto('/presets')
  await page.getByTestId(`switch-${target}`).click()
  await page.getByTestId('switch-now').click()
  const seq = page.getByTestId('launch-sequence')
  await expect(seq).toBeVisible()
  await expect(page.getByTestId('launch-title')).toContainText(`Switching to ${target}`)
  // once the old preset has stopped (the model is unloaded), a new request waits at the gateway
  await expect(seq.locator('[aria-current="step"]')).toContainText(/Picture encoder|Model weights/, { timeout: 30_000 })
  const tok = devTokens()['laptop']
  const answered = chat(request, tok, { ua: 'claude-cli/2.1.0 (external, cli)' })
  await expect(seq).toContainText(/request is waiting at the gateway|requests are waiting at the gateway/, { timeout: 20_000 })
  await expect(page.getByTestId('expert-progress')).toBeVisible({ timeout: 40_000 })
  await page.screenshot({ path: 'test-results/screenshots/presets-switching.png' })
  await expect(page.getByTestId('launch-title')).toContainText(`Switched to ${target}`, { timeout: 90_000 })
  expect(await answered).toBe(200)
  // the request was held, then answered by the new preset (the log is written once Strata's figures are matched)
  await expect
    .poll(
      async () => {
        const rows = await (await consoleApi(page.request, 'GET', '/api/requests?limit=8&app=Claude%20Code')).json()
        return rows.some((r: { preset: string; held_ms: number | null }) => r.preset === target && (r.held_ms ?? 0) > 0)
      },
      { timeout: 20_000 },
    )
    .toBe(true)
  await expect(page.getByTestId(`preset-${target}`)).toContainText('running')
})

test('a switch started elsewhere (outcrop, another browser) updates the overview without a reload', async ({ page }) => {
  test.setTimeout(150_000)
  const st = await (await consoleApi(page.request, 'GET', '/api/state')).json()
  const target = st.server.preset === 'speed' ? 'balanced' : 'speed'
  const pack = target === 'speed' ? 'Q2_0' : 'IQ3_XXS'
  await page.goto('/')
  await expect(page.getByRole('link', { name: st.server.preset, exact: true })).toBeVisible()
  // not through this page's buttons, so nothing here refetches the presets on its own
  const r = await consoleApi(page.request, 'POST', `/api/presets/${target}/switch`, { when: 'now', cancel_inflight: false })
  expect(r.status()).toBeLessThan(300)
  const label = page.getByRole('link', { name: target, exact: true })
  await expect(label).toBeVisible({ timeout: 120_000 })
  await expect(label.locator('xpath=following-sibling::span[1]')).toContainText(pack, { timeout: 10_000 })
})
