import { test } from '@playwright/test'
import { chat, expect } from './helpers'

test('create a token, use it, see the request, revoke it', async ({ page, request }) => {
  await page.goto('/access')
  await page.getByTestId('new-token').click()
  const name = `e2e-${Date.now() % 1000000}`
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Create the token' }).click()
  const token = (await page.getByTestId('token-plaintext').textContent())!.trim()
  expect(token).toMatch(/^lls_/)
  await page.getByRole('button', { name: /I have saved it|Done/ }).click()
  const row = page.getByTestId(`token-row-${name}`)
  await expect(row).toBeVisible()
  await expect(row).toContainText('never')

  // use it through the gateway, as curl
  expect(await chat(request, token, { ua: 'curl/8.5.0' })).toBe(200)

  // the request shows in the log, under its token
  await page.goto(`/requests?q=curl`)
  await expect(page.getByTestId('request-row').filter({ hasText: name }).first()).toBeVisible({ timeout: 20_000 })
  // and on Access the token was last used by curl
  await page.goto('/access')
  await expect(page.getByTestId(`token-row-${name}`)).toContainText('curl', { timeout: 20_000 })

  // revoke it (and disconnect), then it no longer works
  await page.getByRole('button', { name: `Revoke ${name}` }).click()
  await page.getByTestId('confirm-revoke').click()
  await expect(page.getByTestId(`token-row-${name}`)).toHaveCount(0)
  expect(await chat(request, token)).toBe(401)
})
