// Screenshots of pages for a quick look while developing:  node scripts/shot.mjs [--base URL] [--phone] [--light] /path ...
// Signs in as the dev user (console/dev.py) and saves PNGs to test-results/shots/.
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const args = process.argv.slice(2)
let base = process.env.OUTCROP_URL ?? 'http://localhost:5173'
const paths = []
let phone = false
let light = false
let wait = 2500
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base') base = args[++i]
  else if (args[i] === '--phone') phone = true
  else if (args[i] === '--light') light = true
  else if (args[i] === '--wait') wait = Number(args[++i])
  else paths.push(args[i])
}
if (!paths.length) paths.push('/')
const out = 'test-results/shots'
mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: phone ? { width: 375, height: 812 } : { width: 1440, height: 900 },
  deviceScaleFactor: phone ? 2 : 1,
  colorScheme: light ? 'light' : 'dark',
  reducedMotion: 'no-preference',
})
const page = await ctx.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))
const r = await page.request.post(`${base}/api/auth/login`, {
  data: { username: 'dev', password: 'harbor glacier lantern velvet orbit moss', remember: false },
  headers: { 'X-Outcrop': '1', Origin: base },
})
if (!r.ok()) console.error('sign-in failed', r.status(), await r.text())
for (const p of paths) {
  await page.goto(base + p, { waitUntil: 'networkidle' }).catch(() => {})
  await page.waitForTimeout(wait)
  const name = `${out}/${(p.replace(/[^a-z0-9]+/gi, '_') || 'root').replace(/^_+|_+$/g, '') || 'overview'}${phone ? '-phone' : ''}${light ? '-light' : ''}.png`
  await page.screenshot({ path: name, fullPage: true })
  console.log('saved', name)
}
if (errors.length) console.log('console errors:\n' + errors.join('\n'))
await browser.close()
