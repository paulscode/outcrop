import { test } from '@playwright/test'
import { expect } from './helpers'

// The playground's tools: the fake model calls the tool the message names ([[call NAME {json}]]), the user types what
// it returned, and the model answers from that result.  The traffic generator shares the engine: generous timeouts.
test.describe.configure({ timeout: 180_000 })

const LONG = { timeout: 90_000 }

test('the playground points to Chat for everyday questions', async ({ page }) => {
  await page.goto('/playground')
  await expect(page.getByText('no web search, nothing saved')).toBeVisible()
  await page.getByRole('link', { name: 'Chat', exact: true }).last().click()
  await expect(page).toHaveURL(/\/chat/)
})

test('a tool call: type its result, and the model answers from it', async ({ page }) => {
  await page.goto('/playground')
  await page.getByLabel('Tools', { exact: true }).click()
  const box = page.getByPlaceholder('Ask anything…')
  await box.fill('What is the weather? [[call get_weather {"city": "Oslo"}]]')
  await box.press('Enter')

  // the call is shown, with a box for its result
  await expect(page.getByText('Tool call')).toBeVisible(LONG)
  const result = page.getByLabel('Result of get_weather')
  await expect(result).toBeVisible()
  const send = page.getByRole('button', { name: 'Send the result' })
  await expect(send).toBeDisabled()
  await result.fill('{"temp_c": 4, "sky": "rain"}')
  await send.click()

  // the result stays with the call, and the next answer saw it
  await expect(page.getByText('Result you gave')).toBeVisible()
  await expect(page.getByText(/Answer from the tools .*saw: \{"temp_c": 4, "sky": "rain"\}/)).toBeVisible(LONG)
  await expect(result).toHaveCount(0)
})
