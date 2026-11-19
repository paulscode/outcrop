import { test } from '@playwright/test'
import { expect, GATEWAY } from './helpers'

test('the connect wizard lights up on the app\'s first request', async ({ page, request }) => {
  await page.goto('/connect')
  await page.getByTestId('app-claude-code').click()
  await expect(page).toHaveURL(/app=claude-code/)
  const name = `cc-e2e-${Date.now() % 100000}`
  await page.getByLabel('Token name').fill(name)
  await page.getByTestId('connect-create').click()
  const token = (await page.getByTestId('connect-token').first().textContent())!.trim()
  expect(token).toMatch(/^lls_/)
  await expect(page.getByTestId('connect-status')).toContainText('Waiting for the first request')
  // the app's first request, as Claude Code sends it (Anthropic Messages API)
  const r = await request.post(`${GATEWAY}/v1/messages`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'claude-cli/2.1.0 (external, cli)', 'Content-Type': 'application/json' },
    data: { model: 'x', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] },
    timeout: 120_000,
  })
  expect(r.status()).toBe(200)
  await expect(page.getByTestId('connected-line')).toContainText('Connected: Claude Code from', { timeout: 60_000 })
  await expect(page.getByTestId('connected-line')).toContainText('first token')
  await page.screenshot({ path: 'test-results/screenshots/connect-connected.png', fullPage: true })
})
