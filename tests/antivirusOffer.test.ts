// The antivirus suggestion's reminders (#348): folders not offered before at once, the same ones again at most once a
// day and with no limit, until Don't Ask Again or they stop being slowed. On a fixture only (CW_TEST_ANTIVIRUS) and
// a fake clock: nothing here reads or changes the machine's Defender settings.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { nextOffer, offerOf, REMIND_MS, remindAtOf } from '../src/shared/antivirus'
import { tempDir } from './tempDir'

const base = tempDir('hive-av-offer-')
// config.json goes to the test's own profile.
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { suggestionFor, dismissFor, workspaceFolders } = await import('../src/main/antivirus')
const { config } = await import('../src/main/config')

const HOUR = 60 * 60_000
const DEFENDER_ON = 397568
const fixture = join(base, 'fixture.json')
const probe = (exclusions: string[] = ['N/A: Must be an administrator to view exclusions']) => ({
  defender: { antivirus: true, realTime: true, mode: 'Normal' },
  exclusions,
  perfMode: 1,
  products: [{ name: 'Windows Defender', state: DEFENDER_ON }],
  volumes: []
})
const setFixture = (f: object): void => writeFileSync(fixture, JSON.stringify(f))
const env = process.env.CW_TEST_ANTIVIRUS

let n = 0
/** A workspace as the suggestion needs it: a folder, its lifetime and no projects. */
function open(path = join(base, `ws${++n}`)) {
  mkdirSync(path, { recursive: true })
  return { path, w: { path, lifetime: new AbortController().signal, listProjectPaths: async () => [] } as never }
}

beforeAll(() => {
  process.env.CW_TEST_ANTIVIRUS = fixture
})
afterAll(async () => {
  if (env === undefined) delete process.env.CW_TEST_ANTIVIRUS
  else process.env.CW_TEST_ANTIVIRUS = env
  await config.flush()
  rmSync(base, { recursive: true, force: true })
})
let now = Date.parse('2026-10-07T09:00:00Z')
const at = (t: number): void => {
  now = t
  vi.setSystemTime(t)
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at(now + 1000 * HOUR) // Each test starts well after the last: statuses aren't kept that long.
  setFixture({ probe: probe() })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('nextOffer (#348)', () => {
  const t0 = new Date('2026-10-07T09:00:00Z')
  const later = (ms: number): Date => new Date(t0.getTime() + ms)
  it('suggests folders not offered before at once, the same ones only a day after the last time, with no limit', () => {
    const first = nextOffer(null, 'a', t0)
    expect(first).toEqual({ offerKey: 'a', count: 1, lastAt: t0.toISOString() })
    expect(nextOffer(first, 'a', later(REMIND_MS - 1))).toBeNull()
    let o = first!
    expect(remindAtOf(first, 'a')).toBe(later(REMIND_MS).toISOString())
    expect(remindAtOf(first, 'b')).toBeNull() // Other folders: suggested at once, nothing to wait for.
    expect(remindAtOf(null, 'a')).toBeNull()
    expect(remindAtOf(offerOf('a'), 'a')).toBeNull() // #316's form: when isn't known, so a reminder may come now.
    for (let i = 2; i <= 6; i++) {
      const next = nextOffer(o, 'a', later((i - 1) * REMIND_MS))
      expect(next?.count).toBe(i)
      o = next!
    }
    // Other folders (the worktrees folder appeared): at once, counted afresh.
    expect(nextOffer(first, 'a|b', later(HOUR))).toEqual({ offerKey: 'a|b', count: 1, lastAt: later(HOUR).toISOString() })
    expect(nextOffer(first, '', later(10 * REMIND_MS))).toBeNull() // Nothing slowed: nothing to suggest.
  })

  it('reads #316’s form (the folders only) as suggested once, at an unknown time, and ignores what isn’t an offer', () => {
    expect(offerOf('a')).toEqual({ offerKey: 'a', count: 1, lastAt: '' })
    expect(nextOffer(offerOf('a'), 'a', t0)?.count).toBe(2)
    expect(nextOffer(offerOf('a'), 'b', t0)?.count).toBe(1)
    for (const bad of [null, '', 3, { count: 2 }, { offerKey: '' }]) expect(offerOf(bad)).toBeNull()
    expect(offerOf({ offerKey: 'a', count: -1, lastAt: 5 })).toEqual({ offerKey: 'a', count: 1, lastAt: '' })
  })
})

describe('suggestionFor (#348)', () => {
  it('reminds a day later, each time it matters, and never sooner', async () => {
    const { w } = open()
    const t0 = now
    const day = new Date(t0 + REMIND_MS).toISOString()
    // Each answer says when a reminder may come, so a window whose agents keep running asks again then.
    expect(await suggestionFor(w)).toMatchObject({ offer: { count: 1 }, remindAt: day })
    expect(await suggestionFor(w)).toEqual({ offer: null, remindAt: day })
    at(now + 23 * HOUR)
    expect(await suggestionFor(w)).toEqual({ offer: null, remindAt: day })
    at(now + HOUR)
    expect((await suggestionFor(w)).offer?.count).toBe(2)
    expect((await suggestionFor(w)).offer).toBeNull()
    // No limit: a third, fourth… a day apart each.
    at(now + 3 * REMIND_MS)
    expect((await suggestionFor(w)).offer?.count).toBe(3)
    at(now + REMIND_MS)
    expect((await suggestionFor(w)).offer?.count).toBe(4)
  })

  it('stops for good with Don’t Ask Again, given before or while it decides', async () => {
    const a = open()
    expect((await suggestionFor(a.w)).offer?.count).toBe(1)
    dismissFor(a.w)
    at(now + 10 * REMIND_MS)
    expect((await suggestionFor(a.w)).offer).toBeNull()
    // Given while the status is being read: it holds.
    const b = open()
    const asking = suggestionFor(b.w)
    dismissFor(b.w)
    expect(await asking).toEqual({ offer: null, remindAt: null })
  })

  it('stops once the folders are excluded, and a new folder is suggested at once with its own count', async () => {
    const { path, w } = open()
    expect((await suggestionFor(w)).offer?.count).toBe(1)
    // The worktrees folder appears: other folders, suggested at once (no day's wait), counted afresh.
    mkdirSync(`${path}.worktrees`)
    expect((await suggestionFor(w)).offer?.count).toBe(1)
    expect((await suggestionFor(w)).offer).toBeNull()
    // Every folder excluded: nothing slows the workspace, so nothing is suggested, however long it has been.
    setFixture({ probe: probe((await workspaceFolders(w)).map((f) => f.path)) })
    at(now + 5 * REMIND_MS)
    expect((await suggestionFor(w)).offer).toBeNull()
  })

  it('suggests once when two windows ask at once', async () => {
    const { path, w } = open()
    const other = { path, lifetime: new AbortController().signal, listProjectPaths: async () => [] } as never
    const answers = await Promise.all([suggestionFor(w), suggestionFor(other), suggestionFor(w)])
    expect(answers.filter((a) => a.offer).length).toBe(1)
    at(now + REMIND_MS)
    const reminders = await Promise.all([suggestionFor(other), suggestionFor(w)])
    expect(reminders.filter((r) => r.offer).map((r) => r.offer!.count)).toEqual([2])
  })

  it('takes #316’s remembered offer as the first: the same folders come back as a reminder', async () => {
    const { w } = open()
    const first = await suggestionFor(w)
    const key = (w as { path: string }).path.toLowerCase()
    config.update((c) => {
      c.antivirus = { ...c.antivirus, offered: { ...c.antivirus?.offered, [key]: first.offer!.status.offerKey } }
    })
    expect((await suggestionFor(w)).offer?.count).toBe(2)
  })
})
