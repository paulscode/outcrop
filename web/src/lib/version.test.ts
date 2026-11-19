import { beforeEach, describe, expect, it } from 'vitest'
import { checkForUpdate, entryOf, updateStore } from './version'

const html = (src: string) =>
  `<!doctype html><html><head><script src="/theme.js"></script><script type="module" crossorigin src="${src}"></script></head></html>`
const serve = (body: string, ok = true) => (async () => new Response(body, { status: ok ? 200 : 503 })) as unknown as typeof fetch

describe('entryOf', () => {
  it('finds the module entry, not other scripts', () => {
    expect(entryOf(html('/assets/index-AAA.js'))).toBe('/assets/index-AAA.js')
    expect(entryOf('<script src="/theme.js"></script>')).toBeNull()
  })
})

const MINE = '/assets/index-AAA.js'

describe('checkForUpdate', () => {
  beforeEach(() => {
    updateStore.set(false)
  })
  it('says nothing while the server has the same build', async () => {
    expect(await checkForUpdate(serve(html('/assets/index-AAA.js')), MINE)).toBe(false)
  })
  it('notices a new build', async () => {
    expect(await checkForUpdate(serve(html('/assets/index-BBB.js')), MINE)).toBe(true)
    expect(updateStore.get()).toBe(true)
  })
  it('ignores a failed or unreadable answer', async () => {
    expect(await checkForUpdate(serve('', false), MINE)).toBe(false)
    expect(await checkForUpdate(serve('The console is restarting'), MINE)).toBe(false)
    const offline = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await checkForUpdate(offline, MINE)).toBe(false)
  })
})
