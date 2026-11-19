import AxeBuilder from '@axe-core/playwright'
import { test } from '@playwright/test'
import { expect, PAGES, settle } from './helpers'

// Every page at desktop and phone width: a screenshot to look at, and axe for accessibility (serious and critical
// findings fail the test).
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 375, height: 812 },
]

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } })
    for (const p of PAGES) {
      test(`${p} looks right and passes axe`, async ({ page }) => {
        await page.goto(p)
        await settle(page, 1500)
        const name = p === '/' ? 'overview' : p.slice(1)
        await page.screenshot({ path: `test-results/screenshots/${name}-${vp.name}.png`, fullPage: true })
        // no horizontal scrolling on a phone
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(1)
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
        const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
        expect(
          bad.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`),
        ).toEqual([])
      })
    }
  })
}

test('the light theme renders and passes axe on the overview', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await settle(page, 1500)
  await page.screenshot({ path: 'test-results/screenshots/overview-light.png', fullPage: true })
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([])
})
