import { test } from '@playwright/test'
import { chat, expect } from './helpers'

test('open the API for a while: the banner and countdown everywhere, then close it', async ({ page, request }) => {
  await page.goto('/access')
  await expect(page.getByTestId('access-mode')).toHaveText(/Enforced/i)
  expect(await chat(request, null)).toBe(401)
  await page.getByTestId('open-15').click()
  await expect(page.getByTestId('access-mode')).toHaveText(/Open/i)
  // the countdown runs on Access and in the banner on every page
  const c1 = await page.getByTestId('access-countdown').textContent()
  expect(c1).toMatch(/^1[45]:\d\d$/)
  await page.goto('/')
  const banner = page.getByTestId('auth-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('The API is open')
  const a = await page.getByTestId('auth-countdown').textContent()
  await page.waitForTimeout(2200)
  const b = await page.getByTestId('auth-countdown').textContent()
  expect(a).not.toBe(b)
  // a request without a token now gets in
  expect(await chat(request, null)).toBe(200)
  await page.screenshot({ path: 'test-results/screenshots/api-open-banner.png' })
  // close it from the banner
  await banner.getByRole('button', { name: 'Close now' }).click()
  await expect(page.getByTestId('auth-banner')).toBeHidden()
  await expect(page.getByTestId('auth-pill')).toContainText('Enforced')
  expect(await chat(request, null)).toBe(401)
})
