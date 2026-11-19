import { test } from '@playwright/test'
import { expect, PAGES, settle, watchCsp } from './helpers'

// The console's CSP with style-src 'self' (no 'unsafe-inline'), as the ZAP baseline asks.  Until the console sends it, the
// test puts it on the page itself, so the UI is proven to work under it.
const STRICT =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self'; frame-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; " +
  "form-action 'self'; object-src 'none'"

test.describe('content security policy', () => {
  test('no page breaks the strict CSP (style-src self)', async ({ page }) => {
    await page.route('**/*', async (route) => {
      const req = route.request()
      // only the console's own top-level documents (Strata's framed page keeps its own sandbox CSP)
      if (req.resourceType() !== 'document' || req.frame().parentFrame() !== null) return route.continue()
      const resp = await route.fetch()
      await route.fulfill({ response: resp, headers: { ...resp.headers(), 'content-security-policy': STRICT } })
    })
    const violations = await watchCsp(page)
    const consoleCsp: string[] = []
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to (apply|load|execute)/i.test(m.text())) consoleCsp.push(m.text())
    })
    for (const p of PAGES) {
      await page.goto(p)
      await settle(page, 1200)
      expect(await violations(), `CSP violations on ${p}`).toEqual([])
    }
    // Dialogs lock the page's scroll, toasts and the palette render: the paths that used to inject <style>.
    await page.goto('/')
    await settle(page)
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.type('theme')
    await page.keyboard.press('Enter')
    await page.getByTestId('user-menu').click()
    await page.keyboard.press('Escape')
    await page.getByTestId('auth-pill').click()
    await page.keyboard.press('Escape')
    await settle(page)
    expect(await violations(), 'CSP violations from dialogs, menus and toasts').toEqual([])
    expect(consoleCsp, 'CSP messages in the console').toEqual([])
  })
})
