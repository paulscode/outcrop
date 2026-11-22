import { test } from '@playwright/test'
import { expect, PASSWORD } from './helpers'

test.describe.configure({ mode: 'serial' })

test('signing in works, and a wrong password says so', async ({ page }) => {
  await page.goto('/presets')
  await expect(page).toHaveURL(/\/signin\?next=%2Fpresets|\/signin\?next=\/presets/)
  await page.getByLabel('Password', { exact: true }).fill('not the password at all')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('signin-error')).toContainText('Wrong password')
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/presets$/)
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  // signing out lands on the sign-in page
  await page.getByTestId('user-menu').click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/signin/)
})

test('too many failures lock the address out, with a countdown', async ({ page }) => {
  await page.goto('/signin')
  for (let i = 0; i < 7; i++) {
    await page.getByLabel('Password', { exact: true }).fill(`wrong password number ${i}`)
    await page.getByRole('button', { name: 'Sign in' }).click()
    const err = page.getByTestId('signin-error')
    await expect(err).toBeVisible()
    if (await page.getByTestId('lockout-countdown').isVisible()) break
  }
  await expect(page.getByTestId('signin-error')).toContainText('Too many failed sign-ins')
  await expect(page.getByTestId('lockout-countdown')).toHaveText(/^\d+:\d\d$/)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled()
  await page.screenshot({ path: 'test-results/screenshots/signin-lockout.png' })
})
