import { test } from '@playwright/test'
import { consoleApi, expect, GATEWAY } from './helpers'

test('Connect: a token with web tools, and the MCP endpoint takes it', async ({ page, request }) => {
  const name = `web-e2e-${Date.now() % 100000}`
  await page.goto('/connect')
  const section = page.getByTestId('web-for-apps')
  await expect(section).toContainText('What the server cannot protect')
  await section.getByLabel('Token name').fill(name)
  await section.getByTestId('web-token-create').click()
  const tok = (await section.getByTestId('web-token').textContent())!.trim()
  expect(tok).toMatch(/^lls_/)
  // the snippets carry this server's MCP URL
  await expect(section.locator('pre', { hasText: 'mcpServers' })).toContainText(':8443/tools/mcp')
  const list = await (await consoleApi(page.request, 'GET', '/api/tokens')).json()
  expect(list.find((t: { name: string }) => t.name === name).scopes).toEqual(expect.arrayContaining(['inference', 'web']))
  const r = await request.post(`${GATEWAY}/tools/mcp`, {
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  })
  expect(r.status()).toBe(200)
  expect(await r.text()).toContain('web_search')
  // the list on Access shows the scope
  await page.goto('/access')
  await expect(page.getByText(name).first()).toBeVisible()
})
