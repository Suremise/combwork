// HI-2993 (SPEC §16.9.4): follow mode's transport store in Combwork's profile (queueTransportStore.ts, safeStorage as the
// stub's stand-in). A store there but unreadable now is never taken as empty: a save then refuses, writing nothing, so a
// passing read error never drops other targets' snapshots; a read that fails once is tried again.
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import type { TransportSnapshot } from '../src/main/platform/integration'

let profile = tempDir('cw-transport-store-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => profile

const { queueTransportStore: store, queueTransportTestHooks: hooks, TransportStoreUnreadable } = await import('../src/main/queueTransportStore')

afterEach(() => {
  hooks.beforeRead = undefined
  profile = tempDir('cw-transport-store-')
})

const snap = (url: string): TransportSnapshot => ({ remote: 'origin', url, display: url, ref: 'refs/heads/main', config: [], objects: 'C:/repo/.git/objects', alternates: [], format: 'sha1' })
/** A read failing as Windows fails one on a file another process holds. */
const busy = (): Error => Object.assign(new Error('EBUSY: resource busy or locked, open queue-transport.json'), { code: 'EBUSY' })
/** `beforeRead` failing the next `n` reads. */
const failReads = (n: number): void => {
  let left = n
  hooks.beforeRead = async () => {
    if (left-- > 0) throw busy()
  }
}
const fileText = (): string => readFileSync(join(profile, 'queue-transport.json'), 'utf8')

describe('the transport store and a read that fails (HI-2993)', () => {
  it('no store yet is empty: the first save keeps its snapshot', async () => {
    const a = (await store.save('C:/P', 'main', snap('https://example.com/a.git')))!
    expect(await store.load(a.id, a.digest)).toMatchObject({ url: 'https://example.com/a.git' })
  })

  it('unreadable on every try: the save refuses and writes nothing; the other targets’ snapshots are all still there', async () => {
    const a = (await store.save('C:/P', 'main', snap('https://example.com/a.git')))!
    const b = (await store.save('C:/P', '1.2.0', snap('https://example.com/b.git')))!
    const before = fileText()
    failReads(3)
    await expect(store.save('C:/P', 'next', snap('https://example.com/c.git'))).rejects.toBeInstanceOf(TransportStoreUnreadable)
    expect(fileText()).toBe(before)
    hooks.beforeRead = undefined
    expect(await store.load(a.id, a.digest)).toMatchObject({ url: 'https://example.com/a.git' })
    expect(await store.load(b.id, b.digest)).toMatchObject({ url: 'https://example.com/b.git' })
  })

  it('a read that fails once is tried again: the save keeps every snapshot beside its own', async () => {
    const a = (await store.save('C:/P', 'main', snap('https://example.com/a.git')))!
    failReads(1)
    const c = (await store.save('C:/P', 'next', snap('https://example.com/c.git')))!
    expect(await store.load(a.id, a.digest)).toMatchObject({ url: 'https://example.com/a.git' })
    expect(await store.load(c.id, c.digest)).toMatchObject({ url: 'https://example.com/c.git' })
  })

  it('unreadable: a load answers none, and drop and a target’s clean-up write nothing', async () => {
    const a = (await store.save('C:/P', 'main', snap('https://example.com/a.git')))!
    const before = fileText()
    failReads(3)
    expect(await store.load(a.id, a.digest)).toBeNull()
    failReads(3)
    await store.drop(a.id)
    failReads(3)
    await store.dropExcept('C:/P', 'main', new Set())
    expect(fileText()).toBe(before)
    hooks.beforeRead = undefined
    expect(await store.load(a.id, a.digest)).toMatchObject({ url: 'https://example.com/a.git' })
  })
})
