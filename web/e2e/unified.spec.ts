import { test } from '@playwright/test'
import { expect } from './helpers'

// A GB10 (one memory for the CPU and the GPU), as the console reports it there: /api/memory has one pool, and NVML gives
// the GPU's name but no memory figures.  The answers are the dev server's own, made to look like a GB10.
const POOL = [
  {
    key: 'experts',
    label: 'Expert cache',
    gib: 46.8,
    note: "24,576 experts kept in the GPU's share",
  },
  {
    key: 'dense',
    label: 'Dense weights',
    gib: 2.0,
    note: 'attention and shared layers, every token',
  },
  {
    key: 'mtp',
    label: 'MTP drafter',
    gib: 0.9,
    note: 'guesses the next tokens to check in one pass',
  },
  {
    key: 'ngram',
    label: 'n-gram table',
    gib: 26.8,
    note: 'per-layer embeddings, read each token',
  },
  {
    key: 'convcache',
    label: 'Conversation cache',
    gib: 0,
    note: '0 of 4 recent conversations parked',
  },
  {
    key: 'pagecache',
    label: 'Page cache',
    gib: 32.3,
    note: 'model files kept in RAM',
  },
  {
    key: 'other',
    label: 'Everything else',
    gib: 10.5,
    note: "the engine's KV cache and buffers, the system",
  },
  { key: 'free', label: 'Free', gib: 2.3, note: 'unused' },
]

test.beforeEach(async ({ page }) => {
  await page.route('**/api/memory', async (route) => {
    const body = await (await route.fetch()).json()
    await route.fulfill({
      json: {
        ...body,
        unified: true,
        vram: { total_mib: 0, layers: [] },
        ram: { total_gib: 121.6, layers: POOL },
      },
    })
  })
  await page.route('**/api/system', async (route) => {
    const body = await (await route.fetch()).json()
    const gpu = {
      name: 'NVIDIA GB10',
      driver: '580.178.04',
      cuda: '13.0',
      memory: 'unified',
      vram_total_mib: null,
      power_limit_w: null,
    }
    await route.fulfill({
      json: { ...body, info: { ...body.info, gpu, cuda: '13.0' } },
    })
  })
})

test('a GB10: one memory pool on the overview, and no VRAM meter', async ({
  page,
}) => {
  await page.goto('/')
  await expect(
    page.getByText('Memory, shared by the CPU and the GPU'),
  ).toBeVisible()
  await expect(page.getByText('what fills the memory')).toBeVisible()
  await expect(page.getByText('VRAM', { exact: true })).toHaveCount(0)
})

test('a GB10 on the System page: one pool, its name, unified memory and no PCIe', async ({
  page,
}) => {
  await page.goto('/system')
  await expect(
    page.getByText('Memory, shared by the CPU and the GPU'),
  ).toBeVisible()
  await expect(page.getByText('NVIDIA GB10')).toBeVisible()
  await expect(
    page.getByText("unified: the GPU shares the system's RAM"),
  ).toBeVisible()
  await expect(page.getByText('580.178.04 · 13.0')).toBeVisible()
  await expect(page.getByText('PCIe', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Quadro M6000')).toHaveCount(0)
})
