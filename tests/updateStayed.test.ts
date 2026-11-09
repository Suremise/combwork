// A CLI that stays on its version after an update (HI-2777): Provider Setup says a policy may decide it, tentatively, for
// as long as the CLI and its version stay the same and at most a day.
import { describe, expect, it } from 'vitest'
import { STAYED_MS, judgeStayed } from '../src/main/updateStayed'

const isNewer = (a: string, b: string): boolean => a.localeCompare(b, undefined, { numeric: true }) > 0
const P = 'C:\\Users\\jo\\.local\\bin\\claude.exe'
const at = 1_000_000

describe('a version that stays put after an update (HI-2777)', () => {
  it("an update that ended well but didn't move the version towards the one offered", () => {
    expect(judgeStayed({ expect: { path: P, from: '2.1.311', offered: '2.1.319' }, prev: { path: P, version: '2.1.311' }, next: { path: P, version: '2.1.311', latest: '2.1.319' }, held: null, now: at, isNewer })).toEqual({ path: P, version: '2.1.311', offered: '2.1.319', at })
  })

  it('an update that reached the offered version: nothing to say', () => {
    expect(judgeStayed({ expect: { path: P, from: '2.1.311', offered: '2.1.319' }, prev: { path: P, version: '2.1.311' }, next: { path: P, version: '2.1.319', latest: '2.1.319' }, held: null, now: at, isNewer })).toBeNull()
  })

  it('a later check finding an older version than the last (a session put it back)', () => {
    expect(judgeStayed({ expect: null, prev: { path: P, version: '2.1.319' }, next: { path: P, version: '2.1.311', latest: '2.1.319' }, held: null, now: at, isNewer })).toMatchObject({ version: '2.1.311', offered: '2.1.319' })
  })

  it('kept while the CLI and version stay, gone when either changes or after a day', () => {
    const held = { path: P, version: '2.1.311', offered: '2.1.319', at }
    const same = { expect: null, prev: { path: P, version: '2.1.311' }, next: { path: P, version: '2.1.311', latest: '2.1.319' }, held, isNewer }
    expect(judgeStayed({ ...same, now: at + 1000 })).toBe(held)
    expect(judgeStayed({ ...same, now: at + STAYED_MS + 1 })).toBeNull()
    expect(judgeStayed({ ...same, next: { path: 'D:\\other\\claude.exe', version: '2.1.311', latest: '2.1.319' }, now: at })).toBeNull()
    expect(judgeStayed({ ...same, prev: { path: P, version: '2.1.311' }, next: { path: P, version: '2.1.315', latest: '2.1.319' }, now: at })).toBeNull()
  })

  it('another CLI than the one updated, or no version: nothing', () => {
    expect(judgeStayed({ expect: { path: 'D:\\x\\claude.exe', from: '2.1.311', offered: '2.1.319' }, prev: { path: P, version: '2.1.311' }, next: { path: P, version: '2.1.311', latest: '2.1.319' }, held: null, now: at, isNewer })).toBeNull()
    expect(judgeStayed({ expect: null, prev: { path: P, version: '2.1.311' }, next: { path: P, version: null, latest: null }, held: null, now: at, isNewer })).toBeNull()
  })
})
