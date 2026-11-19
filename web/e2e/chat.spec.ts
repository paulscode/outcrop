import { test, type APIRequestContext, type Page } from '@playwright/test'
import { consoleApi, expect } from './helpers'

// The Chat page against the dev stack: the fake model writes Markdown at 40 tok/s, searches when a question says
// "latest", and titles arrive a few seconds after the first answer.  The traffic generator shares the engine, so answers
// can wait their turn: the timeouts are generous.
test.describe.configure({ timeout: 180_000 })

const LONG = { timeout: 90_000 }

async function newChat(request: APIRequestContext, content: string, extra: Record<string, unknown> = {}) {
  const r = await consoleApi(request, 'POST', '/api/chats', { content, web: false, thinking: false, ...extra })
  expect(r.ok(), await r.text()).toBeTruthy()
  return (await r.json()).chat.id as string
}

async function waitDone(request: APIRequestContext, id: string) {
  await expect
    .poll(async () => (await (await consoleApi(request, 'GET', `/api/chats/${id}`)).json()).chat.running, { timeout: 90_000, intervals: [500] })
    .toBe(false)
}

async function ask(page: Page, text: string) {
  const box = page.locator('#chat-input')
  await box.fill(text)
  await box.press('Enter')
}

test('ask, watch it stream, and the title arrives', async ({ page }) => {
  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible()
  // web off for this one: a plain answer
  await page.getByTestId('toggle-web').click()
  await expect(page.getByTestId('toggle-web')).toHaveAttribute('aria-pressed', 'false')
  await ask(page, 'How does sourdough hydration work?')
  await expect(page).toHaveURL(/\/chat\/c[0-9a-f]+/)
  // the question is there at once, the answer is being written
  await expect(page.getByText('How does sourdough hydration work?').first()).toBeVisible()
  await expect(page.locator('article[aria-busy="true"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop the answer' })).toBeVisible()
  // done: the footer with the preset, tokens and speed
  const footer = page.getByTestId('answer-footer')
  await expect(footer).toBeVisible(LONG)
  await expect(footer).toContainText('tokens')
  await expect(footer).toContainText('tok/s')
  // the title the model writes replaces the first line, in the header and in the sidebar
  await expect(page.getByTestId('chat-title')).toContainText('Fake title', LONG)
  await expect(page.getByTestId('chat-sidebar').getByText(/Fake title/).first()).toBeVisible()
})

test('a web answer: tool blocks, citation pills and sources', async ({ page }) => {
  await page.goto('/chat')
  await ask(page, 'What is the latest news on Rust?')
  await expect(page).toHaveURL(/\/chat\/c[0-9a-f]+/)
  await expect(page.getByTestId('tool-row').first()).toContainText(/Search(ed|ing)/, LONG)
  await expect(page.getByTestId('answer-footer')).toBeVisible(LONG)
  await expect(page.getByTestId('tool-row')).toHaveCount(2)
  await expect(page.getByTestId('tool-row').nth(1)).toContainText('Read')
  await expect(page.getByTestId('answer-footer')).toContainText('1 search')
  // [1] became a pill; its card shows the source
  const pill = page.getByTestId('cite').first()
  await expect(pill).toBeVisible()
  await pill.click()
  await expect(page.getByTestId('cite-card')).toContainText('wikipedia')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('cite-card')).toBeHidden()
  // the sources row: only cited ones, links that send no referrer
  const sources = page.getByLabel('Sources')
  const links = sources.getByRole('link')
  await expect(links).toHaveCount(2)
  await expect(links.first()).toHaveAttribute('rel', /noopener/)
  await expect(links.first()).toHaveAttribute('rel', /noreferrer/)
  await expect(links.first()).toHaveAttribute('referrerpolicy', 'no-referrer')
  await expect(links.first()).toHaveAttribute('target', '_blank')
  // a tool block opens to show what was sent
  await page.getByTestId('tool-row').first().click()
  await expect(page.getByText('Sent to the search engine')).toBeVisible()
})

test('rename from the header', async ({ page }) => {
  const id = await newChat(page.request, 'Name me later please')
  await page.goto(`/chat/${id}`)
  await page.getByTestId('chat-title').click()
  const input = page.getByTestId('rename-input')
  const name = `Bread notes ${Date.now() % 100000}`
  await input.fill(name)
  await input.press('Enter')
  await expect(page.getByTestId('chat-title')).toHaveText(name)
  await expect(page.getByTestId('chat-sidebar').getByText(name)).toBeVisible()
  // Esc cancels
  await page.getByTestId('chat-title').click()
  await page.getByTestId('rename-input').fill('Something else')
  await page.getByTestId('rename-input').press('Escape')
  await expect(page.getByTestId('chat-title')).toHaveText(name)
  await page.reload()
  await expect(page.getByTestId('chat-title')).toHaveText(name)
})

test('make a space and move a chat into it from the menu', async ({ page }) => {
  const name = `Home lab ${Date.now() % 100000}`
  const id = await newChat(page.request, 'Which VLAN should the NAS be on?')
  await page.goto('/chat')
  await page.getByTestId('new-space').click()
  const dialog = page.getByTestId('space-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('radio', { name: '🏠' }).click()
  await dialog.getByLabel('Instructions').fill('My home lab: Proxmox on the NAS.')
  await dialog.getByTestId('space-save').click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('space-title')).toHaveText(name)
  await expect(page.getByText('My home lab: Proxmox on the NAS.')).toBeVisible()

  await page.goto(`/chat/${id}`)
  await page.getByTestId('chat-menu').click()
  await page.getByTestId('menu-move').click()
  const picker = page.getByTestId('move-picker')
  await picker.getByPlaceholder('Find a space…').fill(name.slice(0, 6))
  await picker.getByRole('option', { name: new RegExp(name) }).click()
  await expect(page.getByTestId('space-chip')).toContainText(name)
  await expect(page.getByText(/Moved .* to 🏠/)).toBeVisible()
  // the space counts it
  const row = page.locator(`[data-testid="space-row"]`, { hasText: name })
  await expect(row).toContainText('1')
})

test('search forgives a typo and lands on the chat', async ({ page }) => {
  // earlier runs on the same dev stack left chats like this one: only this run's may match
  const old = await (await consoleApi(page.request, 'GET', '/api/chats/search?q=kubernetes&limit=100')).json()
  const ids = [...new Set((old.results as Array<{ chat: { id: string } }>).map((r) => r.chat.id))]
  if (ids.length) await consoleApi(page.request, 'POST', '/api/chats/delete', { ids })
  const id = await newChat(page.request, 'How do I set up Kubernetes ingress on the NAS?')
  await waitDone(page.request, id)
  // once the model's title replaces the question's first line, the match is in the message, with a snippet
  await expect
    .poll(async () => (await (await consoleApi(page.request, 'GET', `/api/chats/${id}`)).json()).chat.title_source, { timeout: 150_000 })
    .toBe('auto')
  await page.goto('/chat')
  await expect(page.locator('#chat-input')).toBeFocused()
  await page.keyboard.press('/')
  await expect(page.locator('#chat-search')).toBeFocused()
  await page.keyboard.type('kubernets')
  const first = page.getByTestId('search-result').first()
  await expect(first).toBeVisible()
  await expect(page.getByTestId('search-result').locator('mark').first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/chat/${id}`))
  await expect(page.getByText('How do I set up Kubernetes ingress on the NAS?')).toBeVisible()
})

test('delete with the confirmation', async ({ page }) => {
  const id = await newChat(page.request, 'A chat to throw away')
  await waitDone(page.request, id)
  await page.goto(`/chat/${id}`)
  await page.getByTestId('chat-menu').click()
  await page.getByTestId('menu-delete').click()
  const dialog = page.getByTestId('delete-dialog')
  await expect(dialog).toContainText('Delete “')
  await expect(dialog).toContainText('2 messages are removed from the server. This can’t be undone.')
  await dialog.getByTestId('confirm-delete').click()
  await expect(page).toHaveURL(/\/chat$/)
  expect((await consoleApi(page.request, 'GET', `/api/chats/${id}`)).status()).toBe(404)
  await expect(page.locator(`[data-chat-id="${id}"]`)).toHaveCount(0)
})

test('regenerate makes a second version: ‹ 2 / 2 ›, and back to the first', async ({ page }) => {
  const id = await newChat(page.request, 'Tell me about granite.')
  await waitDone(page.request, id)
  await page.goto(`/chat/${id}`)
  await expect(page.getByTestId('answer-footer')).toBeVisible()
  await page.getByTestId('regenerate').click()
  await expect(page.locator('article[aria-busy="true"]')).toBeVisible()
  await expect(page.getByTestId('answer-footer')).toBeVisible(LONG)
  const v = page.getByTestId('answer-footer').getByTestId('versions')
  await expect(v).toContainText('2 / 2')
  await v.getByRole('button', { name: 'The previous version' }).click()
  await expect(v).toContainText('1 / 2')
})

test('a failed reload of an open chat keeps the conversation on screen', async ({ page }) => {
  const id = await newChat(page.request, 'Keep me on screen while the console restarts.')
  await waitDone(page.request, id)
  await page.goto(`/chat/${id}`)
  await expect(page.getByTestId('answer-footer')).toBeVisible()
  // the console answers 503 for a while (a restart, a proxy in between)
  let failed = 0
  await page.route(`**/api/chats/${id}`, (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    failed++
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"restarting"}' })
  })
  // a change elsewhere makes this page fetch the chat again (moving it into a space)
  const sp = await (await consoleApi(page.request, 'POST', '/api/spaces', { name: `Blip ${Date.now() % 100000}` })).json()
  await consoleApi(page.request, 'PATCH', `/api/chats/${id}`, { space_id: sp.id })
  await expect.poll(() => failed, { timeout: 20_000 }).toBeGreaterThanOrEqual(3) // the first try and its two retries
  await page.waitForTimeout(500)
  await expect(page.getByText('This chat did not load')).toHaveCount(0)
  await expect(page.getByTestId('conversation').getByText('Keep me on screen while the console restarts.')).toBeVisible()
  await expect(page.getByTestId('answer-footer')).toBeVisible()
  // back: the next fetch brings the change
  await page.unroute(`**/api/chats/${id}`)
  await consoleApi(page.request, 'PATCH', `/api/chats/${id}`, { space_id: null })
  await expect(page.getByTestId('space-chip')).toContainText('No space')
  await consoleApi(page.request, 'DELETE', `/api/spaces/${sp.id}`)
})

test('edit the first question: a second version of the whole chat', async ({ page }) => {
  const id = await newChat(page.request, 'What is basalt made of?')
  await waitDone(page.request, id)
  await page.goto(`/chat/${id}`)
  await expect(page.getByTestId('answer-footer')).toBeVisible()
  const bubble = page.locator('[data-msg-id]').filter({ hasText: 'What is basalt made of?' }).first()
  await bubble.hover()
  await bubble.getByRole('button', { name: 'Edit this question' }).click()
  const box = page.getByLabel('Edit your question')
  await expect(box).toBeFocused()
  await box.fill('What is granite made of?')
  await box.press('Enter')
  await expect(page.getByTestId('conversation').getByText('What is granite made of?')).toBeVisible()
  await expect(page.getByTestId('conversation').getByText('What is basalt made of?')).toHaveCount(0)
  await expect(page.getByTestId('answer-footer')).toBeVisible(LONG)
  // the question is the first one again (no parent), now in two versions
  const d = await (await consoleApi(page.request, 'GET', `/api/chats/${id}`)).json()
  expect(d.messages[0].content).toBe('What is granite made of?')
  expect(d.messages[0].parent_id).toBeNull()
  expect(d.messages[0].versions.count).toBe(2)
  const edited = page.locator('[data-msg-id]').filter({ hasText: 'What is granite made of?' }).first()
  await edited.hover()
  const v = edited.getByTestId('versions')
  await expect(v).toContainText('2 / 2')
  await v.getByRole('button', { name: 'The previous version' }).click()
  await expect(page.getByTestId('conversation').getByText('What is basalt made of?')).toBeVisible()
})

test('reload in the middle of an answer: it catches up, and Stop keeps what was written', async ({ page }) => {
  const id = await newChat(page.request, 'Write at length about the rock cycle, with thinking first.', { thinking: true })
  await page.goto(`/chat/${id}`)
  await expect(page.locator('article[aria-busy="true"]')).toBeVisible(LONG)
  await page.reload()
  // the answer is still being written (by the server): the page follows it again
  await expect(page.locator('article[aria-busy="true"]')).toBeVisible()
  await expect(page.getByTestId('phase')).toBeVisible()
  await page.getByRole('button', { name: 'Stop the answer' }).click()
  await expect(page.locator('article[aria-busy="true"]')).toHaveCount(0, LONG)
  await expect(page.getByTestId('answer-footer')).toContainText('stopped')
  const d = await (await consoleApi(page.request, 'GET', `/api/chats/${id}`)).json()
  expect(d.chat.running).toBe(false)
  expect(d.messages.at(-1).status).toBe('stopped')
})

test('delete a chat while its answer is being written', async ({ page }) => {
  const id = await newChat(page.request, 'A long answer that will be deleted midway.', { thinking: true })
  await page.goto(`/chat/${id}`)
  await expect(page.locator('article[aria-busy="true"]')).toBeVisible(LONG)
  await page.getByTestId('chat-menu').click()
  await page.getByTestId('menu-delete').click()
  await page.getByTestId('delete-dialog').getByTestId('confirm-delete').click()
  await expect(page).toHaveURL(/\/chat$/)
  await expect(page.getByText(/Deleted “/)).toBeVisible()
  expect((await consoleApi(page.request, 'GET', `/api/chats/${id}`)).status()).toBe(404)
  await expect(page.locator(`[data-chat-id="${id}"]`)).toHaveCount(0)
})

test('a search hit in another version shows that version, then the message', async ({ page }) => {
  const id = await newChat(page.request, 'Tell me about quartz crystals.')
  await waitDone(page.request, id)
  const first = (await (await consoleApi(page.request, 'GET', `/api/chats/${id}`)).json()).messages[0].id as string
  // the first question edited: the chat now shows the new version
  const r = await consoleApi(page.request, 'POST', `/api/chats/${id}/turns`, { content: 'Tell me about mica sheets.', parent_id: '' })
  expect(r.ok(), await r.text()).toBeTruthy()
  await waitDone(page.request, id)
  await page.goto(`/chat/${id}?msg=${first}`)
  const conv = page.getByTestId('conversation')
  await expect(conv.getByText('Tell me about quartz crystals.')).toBeVisible()
  await expect(conv.getByText('Tell me about mica sheets.')).toHaveCount(0)
})
