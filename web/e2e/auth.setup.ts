import { expect, test as setup } from '@playwright/test'
import { STATE } from '../playwright.config'
import { PASSWORD, USER } from './helpers'

setup('sign in once for the other tests', async ({ page, baseURL }) => {
  // The lockout test of an earlier run may still block this address; wait it out.
  for (let i = 0; i < 30; i++) {
    const r = await page.request.post('/api/auth/login', {
      data: { username: USER, password: PASSWORD, remember: true },
      headers: { 'X-Outcrop': '1', Origin: baseURL! },
    })
    if (r.ok()) break
    expect(r.status(), await r.text()).toBe(429)
    await page.waitForTimeout(Math.min(60, Number(r.headers()['retry-after'] ?? 10)) * 1000)
  }
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  await page.context().storageState({ path: STATE })
})
