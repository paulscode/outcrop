import { test } from '@playwright/test'
import { expect } from './helpers'

test('an open tab offers a reload once the server has a newer UI', async ({ page }) => {
  await page.goto('/')
  const notice = page.getByText('A new version of Outcrop is on the server.')
  await expect(page.getByRole('link', { name: /overview/i }).first()).toBeVisible()
  // the same build: nothing to offer
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.waitForTimeout(500)
  await expect(notice).toBeHidden()
  // a deploy: the server's index.html now names another entry script
  await page.route('/', async (route) => {
    const r = await route.fetch()
    const body = (await r.text()).replace(/(<script type="module"[^>]*src=")[^"]+/, '$1/assets/index-NEWBUILD.js')
    await route.fulfill({ response: r, body })
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(notice).toBeVisible()
  await page.unroute('/')
  await page.getByRole('button', { name: 'Reload' }).click()
  await expect(notice).toBeHidden()
})
