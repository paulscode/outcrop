import { test } from '@playwright/test'
import { consoleApi, expect } from './helpers'

test('the settings for every preset: explained, chosen, shown on the presets, and a restart offered', async ({ page }) => {
  try {
    await page.goto('/settings#engine')
    const section = page.locator('section#engine')
    await expect(section.getByText('Answers and memory')).toBeVisible()
    // each setting says what it trades, before anything is chosen
    await expect(section).toContainText('more slowly when the machine reads from its disk')
    await expect(section).toContainText('a shorter limit leaves more RAM for the model itself')
    await section.getByLabel('On: slower, every answer computed in full').check()
    await expect(page.getByText('Setting saved')).toBeVisible()
    await section.getByLabel('131,072 tokens (about 100,000 words)').check()
    await expect(section.getByLabel('131,072 tokens (about 100,000 words)')).toBeChecked()
    // the preset that runs started before the change: the section says so and offers the restart
    await expect(section.getByRole('button', { name: /Restart .* when idle/ })).toBeVisible()
    const presets = await (await consoleApi(page.request, 'GET', '/api/presets')).json()
    const speed = presets.presets.find((p: { name: string }) => p.name === 'speed')
    const oneM = presets.presets.find((p: { name: string }) => p.name === 'speed-1m')
    expect(speed.context).toBe(131072)
    expect(oneM.context).toBe(1048576)
  } finally {
    for (const [key, value] of [
      ['exact_answers', 'off'],
      ['context', 'profile'],
    ])
      await consoleApi(page.request, 'PUT', '/api/settings/engine', { key, value })
  }
})
