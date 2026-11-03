import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { backupPath, LOCK_STALE_MS, lockFile, moveProfile, readRecord, REGENERATED, STAGING_MARKER, type MoveOps } from '../src/main/profileMove'
import { tempDir } from './tempDir'

// HI-2461: the profile folders move from Hive's names to Combwork's at the first start, copied (never moved) so nothing
// is lost: a failed copy leaves the old folder as it was, and the old folder becomes a dated backup only once the new
// one is whole.

const NOW = new Date('2026-11-03T20:00:00Z')
const BACKUP = 'Hive.backup-2026-11-03'
const TOKEN = '0123456789abcdef'

/** A 1.0 profile: settings, usage, logs, an account's folder, and Chromium's cache. */
function oldProfile(parent: string): string {
  const dir = join(parent, 'Hive')
  mkdirSync(join(dir, 'logs'), { recursive: true })
  mkdirSync(join(dir, 'accounts', 'a-1'), { recursive: true })
  mkdirSync(join(dir, 'Cache'), { recursive: true })
  writeFileSync(join(dir, 'config.json'), '{"settings":{"theme":"dark"}}')
  writeFileSync(join(dir, 'usage-cache.json'), '{"used":42}')
  writeFileSync(join(dir, 'logs', 'main.log'), 'a line\n')
  writeFileSync(join(dir, 'accounts', 'a-1', '.credentials.json'), '{"token":"test"}')
  writeFileSync(join(dir, 'Cache', 'data_0'), 'cached')
  return dir
}

const ops = (over: Partial<MoveOps> = {}): MoveOps => ({ copyFile: (a, b) => copyFileSync(a, b), rename: (a, b) => renameSync(a, b), alive: () => false, pid: 1000, now: () => Date.now(), ...over })
const read = (p: string): string => readFileSync(p, 'utf8')

describe('the profile move (HI-2461)', () => {
  it('a new install: neither folder exists, and the new one is used', () => {
    const parent = tempDir('pm-fresh-')
    expect(moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops() })).toEqual({ kind: 'fresh', use: join(parent, 'Combwork') })
    expect(readdirSync(parent)).toEqual([])
  })

  it('copies the old folder across with its data, then keeps the old one as a dated backup', () => {
    const parent = tempDir('pm-move-')
    oldProfile(parent)
    const o = moveProfile(parent, 'Hive', 'Combwork', { now: NOW, skip: REGENERATED, ops: ops() })
    const now = join(parent, 'Combwork')
    expect(o).toEqual({ kind: 'moved', use: now, backup: join(parent, BACKUP) })
    expect(read(join(now, 'config.json'))).toBe('{"settings":{"theme":"dark"}}')
    expect(read(join(now, 'usage-cache.json'))).toBe('{"used":42}')
    expect(read(join(now, 'logs', 'main.log'))).toBe('a line\n')
    expect(read(join(now, 'accounts', 'a-1', '.credentials.json'))).toBe('{"token":"test"}')
    // Chromium makes its cache again: not copied.
    expect(existsSync(join(now, 'Cache'))).toBe(false)
    // The backup is the old folder, whole, cache and all.
    expect(read(join(parent, BACKUP, 'config.json'))).toBe('{"settings":{"theme":"dark"}}')
    expect(existsSync(join(parent, BACKUP, 'Cache', 'data_0'))).toBe(true)
    expect(existsSync(join(parent, 'Hive'))).toBe(false)
    expect(readdirSync(parent).sort()).toEqual(['Combwork', BACKUP])
    expect(readRecord(now)).toEqual({ v: 1, from: join(parent, 'Hive'), movedAt: NOW.toISOString(), backup: join(parent, BACKUP), opened: false })
    // Neither the staging marker nor the lock is left behind.
    expect(existsSync(join(now, STAGING_MARKER))).toBe(false)
    expect(existsSync(lockFile(parent, 'Combwork'))).toBe(false)
  })

  it('already moved: the new folder is used and nothing changes', () => {
    const parent = tempDir('pm-current-')
    oldProfile(parent)
    moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops() })
    const before = readdirSync(parent).sort()
    expect(moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops() })).toEqual({ kind: 'current', use: join(parent, 'Combwork') })
    expect(readdirSync(parent).sort()).toEqual(before)
  })

  it("both present, not this move's: both are left as they are and the new one is used", () => {
    const parent = tempDir('pm-both-')
    oldProfile(parent)
    mkdirSync(join(parent, 'Combwork'))
    writeFileSync(join(parent, 'Combwork', 'config.json'), '{"theirs":true}')
    expect(moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops() })).toEqual({ kind: 'both', use: join(parent, 'Combwork'), other: join(parent, 'Hive') })
    expect(read(join(parent, 'Combwork', 'config.json'))).toBe('{"theirs":true}')
    expect(read(join(parent, 'Hive', 'config.json'))).toBe('{"settings":{"theme":"dark"}}')
  })

  it('a locked file: the copy stops, its partial copy goes, and the old folder is used as it was', () => {
    const parent = tempDir('pm-locked-')
    oldProfile(parent)
    const locked = (a: string, b: string): void => {
      if (a.endsWith('usage-cache.json')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY', path: a })
      copyFileSync(a, b)
    }
    const o = moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ copyFile: locked }) })
    expect(o).toMatchObject({ kind: 'failed', use: join(parent, 'Hive'), to: join(parent, 'Combwork') })
    expect(o.kind === 'failed' && o.why).toContain('EBUSY')
    expect(readdirSync(parent)).toEqual(['Hive'])
    expect(read(join(parent, 'Hive', 'usage-cache.json'))).toBe('{"used":42}')
    // The next start, with the file free, moves it.
    expect(moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops() }).kind).toBe('moved')
  })

  it('a failed rename into place: the whole copy is removed and the old folder is used', () => {
    const parent = tempDir('pm-rename-')
    oldProfile(parent)
    const o = moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ rename: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) } }) })
    expect(o.kind).toBe('failed')
    expect(readdirSync(parent)).toEqual(['Hive'])
  })

  it('a partial move left by a start that ended partway: its marked copy goes, and the copy is made again', () => {
    const parent = tempDir('pm-partial-')
    oldProfile(parent)
    const left = join(parent, `Combwork.moving-${TOKEN}`)
    mkdirSync(left)
    writeFileSync(join(left, STAGING_MARKER), JSON.stringify({ token: TOKEN, pid: 4242 }))
    writeFileSync(join(left, 'config.json'), '{"half":')
    // Its lock too, its start ended.
    writeFileSync(lockFile(parent, 'Combwork'), JSON.stringify({ v: 1, pid: 4242, token: TOKEN, at: NOW.toISOString() }))
    const o = moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ alive: () => false }) })
    expect(o.kind).toBe('moved')
    expect(read(join(parent, 'Combwork', 'config.json'))).toBe('{"settings":{"theme":"dark"}}')
    expect(existsSync(left)).toBe(false)
    expect(readdirSync(parent).sort()).toEqual(['Combwork', BACKUP])
  })

  it("never removes what isn't positively this move's: an unmarked staging folder, a mismatched marker, a folder of another name", () => {
    const parent = tempDir('pm-unmarked-')
    oldProfile(parent)
    const unmarked = join(parent, `Combwork.moving-${TOKEN}`)
    const mismatched = join(parent, 'Combwork.moving-1111111111111111')
    const plain = join(parent, 'Combwork.moving')
    for (const d of [unmarked, mismatched, plain]) {
      mkdirSync(d)
      writeFileSync(join(d, 'user-file.txt'), 'mine')
    }
    writeFileSync(join(mismatched, STAGING_MARKER), JSON.stringify({ token: TOKEN }))
    expect(moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops() }).kind).toBe('moved')
    for (const d of [unmarked, mismatched, plain]) expect(read(join(d, 'user-file.txt'))).toBe('mine')
  })

  it('another start holding the move now (its lock fresh, its process alive): this one gives way and changes nothing', () => {
    const parent = tempDir('pm-busy-')
    oldProfile(parent)
    writeFileSync(lockFile(parent, 'Combwork'), JSON.stringify({ v: 1, pid: 4242, token: TOKEN, at: NOW.toISOString() }))
    expect(moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ alive: (pid) => pid === 4242 }) })).toEqual({ kind: 'busy', use: join(parent, 'Hive') })
    expect(readdirSync(parent).sort()).toEqual(['Combwork.move-lock', 'Hive'])
  })

  it('a lock that is absent-then-unreadable, malformed, or a live start\'s left unrefreshed: never removed, and the old folder is used', () => {
    for (const [what, body, alive, age] of [
      ['malformed', '{"v":1,"pid":', false, 0],
      ['not a lock', '{"hello":"world"}', false, 0],
      ['empty', '', false, 0],
      ['live but unrefreshed', JSON.stringify({ v: 1, pid: 4242, token: TOKEN, at: NOW.toISOString() }), true, LOCK_STALE_MS + 1000]
    ] as const) {
      const parent = tempDir('pm-badlock-')
      oldProfile(parent)
      const file = lockFile(parent, 'Combwork')
      writeFileSync(file, body)
      const o = moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ alive: () => alive, now: () => Date.now() + age }) })
      expect(o, what).toMatchObject({ kind: 'failed', use: join(parent, 'Hive') })
      expect(read(file), what).toBe(body)
      expect(readdirSync(parent).sort(), what).toEqual(['Combwork.move-lock', 'Hive'])
    }
  })

  // The interleavings the round-1 review reproduced: a second start at each step of a first one's move.
  for (const step of ['locked', 'staged', 'published'] as const) {
    it(`a second start while the first is at "${step}": it gives way, and the first's move completes whole`, () => {
      const parent = tempDir(`pm-race-${step}-`)
      oldProfile(parent)
      let second: ReturnType<typeof moveProfile> | null = null
      const first = moveProfile(parent, 'Hive', 'Combwork', {
        now: NOW,
        ops: ops({
          pid: 1000,
          step: (s) => {
            if (s === step) second = moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ pid: 2000, alive: (pid) => pid === 1000 }) })
          }
        })
      })
      expect(second).toMatchObject({ kind: 'busy' })
      expect(first).toEqual({ kind: 'moved', use: join(parent, 'Combwork'), backup: join(parent, BACKUP) })
      expect(readdirSync(parent).sort()).toEqual(['Combwork', BACKUP])
      expect(read(join(parent, 'Combwork', 'config.json'))).toBe('{"settings":{"theme":"dark"}}')
    })
  }

  // Round 3: reclaiming an ended start's lock while ownership changes (the round-2 review's interleaving).
  const DEAD = 4242
  const aliveBut = (pid: number): boolean => pid !== DEAD
  const deadLock = (parent: string): void => writeFileSync(lockFile(parent, 'Combwork'), JSON.stringify({ v: 1, pid: DEAD, token: TOKEN, at: NOW.toISOString() }))

  it("an ended start's lock, judged by X, taken over meanwhile by B; a third start C during B's copy: one owner at a time, B's staging kept", () => {
    const parent = tempDir('pm-reclaim-race-')
    oldProfile(parent)
    deadLock(parent)
    let b: ReturnType<typeof moveProfile> | null = null
    let c: ReturnType<typeof moveProfile> | null = null
    let stagingDuringC: string[] = []
    const x = moveProfile(parent, 'Hive', 'Combwork', {
      now: NOW,
      ops: ops({
        pid: 1000,
        alive: aliveBut,
        step: (s) => {
          if (s !== 'judged' || b) return
          b = moveProfile(parent, 'Hive', 'Combwork', {
            now: NOW,
            ops: ops({
              pid: 2000,
              alive: aliveBut,
              step: (t) => {
                if (t !== 'staged') return
                c = moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ pid: 3000, alive: aliveBut }) })
                stagingDuringC = readdirSync(parent).filter((n) => n.startsWith('Combwork.moving-'))
              }
            })
          })
        }
      })
    })
    expect(c).toMatchObject({ kind: 'busy' })
    expect(stagingDuringC).toHaveLength(1)
    expect(b).toEqual({ kind: 'moved', use: join(parent, 'Combwork'), backup: join(parent, BACKUP) })
    // X, resuming on its old observation, removes nothing and finds the move done.
    expect(x).toEqual({ kind: 'current', use: join(parent, 'Combwork') })
    expect(readdirSync(parent).sort()).toEqual(['Combwork', BACKUP])
    expect(read(join(parent, 'Combwork', 'config.json'))).toBe('{"settings":{"theme":"dark"}}')
  })

  it("a lock replaced by a live holder after X judged the old one ended: X never removes it, and gives way", () => {
    const parent = tempDir('pm-reclaim-replaced-')
    oldProfile(parent)
    deadLock(parent)
    const file = lockFile(parent, 'Combwork')
    const live = JSON.stringify({ v: 1, pid: 2000, token: 'fedcba9876543210', at: NOW.toISOString() })
    const staging = join(parent, 'Combwork.moving-fedcba9876543210')
    const x = moveProfile(parent, 'Hive', 'Combwork', {
      now: NOW,
      ops: ops({
        pid: 1000,
        alive: aliveBut,
        step: (s) => {
          if (s !== 'judged') return
          // As B would after its own reclaim: the ended lock gone, B's live lock and marked staging there.
          unlinkSync(file)
          writeFileSync(file, live)
          mkdirSync(staging)
          writeFileSync(join(staging, STAGING_MARKER), JSON.stringify({ token: 'fedcba9876543210', pid: 2000 }))
          writeFileSync(join(staging, 'live-copy.txt'), 'copying')
        }
      })
    })
    expect(x).toMatchObject({ kind: 'busy' })
    expect(read(file)).toBe(live)
    expect(read(join(staging, 'live-copy.txt'))).toBe('copying')
    expect(existsSync(join(parent, 'Hive'))).toBe(true)
    expect(existsSync(join(parent, 'Combwork'))).toBe(false)
  })

  it('a third start while X reclaims (its guard held): it gives way, and X then moves the profile', () => {
    const parent = tempDir('pm-reclaim-guard-')
    oldProfile(parent)
    deadLock(parent)
    let c: ReturnType<typeof moveProfile> | null = null
    const x = moveProfile(parent, 'Hive', 'Combwork', {
      now: NOW,
      ops: ops({ pid: 1000, alive: aliveBut, step: (s) => { if (s === 'reclaiming' && !c) c = moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ pid: 3000, alive: aliveBut }) }) } })
    })
    expect(c).toMatchObject({ kind: 'busy' })
    expect(x.kind).toBe('moved')
    expect(readdirSync(parent).sort()).toEqual(['Combwork', BACKUP])
  })

  it('a reclaim guard an ended start left: never removed, and the old folder is used', () => {
    const parent = tempDir('pm-reclaim-left-')
    oldProfile(parent)
    deadLock(parent)
    const guard = `${lockFile(parent, 'Combwork')}.reclaim`
    const body = JSON.stringify({ v: 1, pid: DEAD, token: '1111111111111111', at: NOW.toISOString() })
    writeFileSync(guard, body)
    const o = moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ pid: 1000, alive: aliveBut }) })
    expect(o).toMatchObject({ kind: 'failed', use: join(parent, 'Hive') })
    expect(read(guard)).toBe(body)
    expect(existsSync(lockFile(parent, 'Combwork'))).toBe(true)
  })

  it("a live start's staging folder is never removed, even by the lock's holder", () => {
    const parent = tempDir('pm-live-staging-')
    oldProfile(parent)
    const live = join(parent, 'Combwork.moving-fedcba9876543210')
    mkdirSync(live)
    writeFileSync(join(live, STAGING_MARKER), JSON.stringify({ token: 'fedcba9876543210', pid: 2000 }))
    expect(moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ pid: 1000, alive: (pid) => pid === 2000 }) }).kind).toBe('moved')
    expect(existsSync(join(live, STAGING_MARKER))).toBe(true)
  })

  it('a second start after the first released the lock: the move is already done, and it uses the new folder', () => {
    const parent = tempDir('pm-after-')
    oldProfile(parent)
    moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ pid: 1000 }) })
    expect(moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ pid: 2000, alive: () => true }) })).toEqual({ kind: 'current', use: join(parent, 'Combwork') })
  })

  it('the old folder still in use after the copy: its backup is pending, and renamed at the next start', () => {
    const parent = tempDir('pm-pending-')
    oldProfile(parent)
    const old = join(parent, 'Hive')
    const busyOld = (a: string, b: string): void => {
      if (a === old) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      renameSync(a, b)
    }
    expect(moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ rename: busyOld }) })).toEqual({ kind: 'moved', use: join(parent, 'Combwork'), backup: null })
    expect(readRecord(join(parent, 'Combwork'))?.backup).toBeNull()
    expect(existsSync(old)).toBe(true)
    expect(moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops() })).toEqual({ kind: 'backedUp', use: join(parent, 'Combwork'), backup: join(parent, BACKUP) })
    expect(readRecord(join(parent, 'Combwork'))?.backup).toBe(join(parent, BACKUP))
    expect(existsSync(old)).toBe(false)
  })

  it("a backup's name already taken: the next free one", () => {
    const parent = tempDir('pm-names-')
    mkdirSync(join(parent, BACKUP))
    expect(backupPath(parent, 'Hive', NOW)).toBe(join(parent, `${BACKUP}-2`))
  })

  it("links: one into the old folder points into the new one, any other keeps its target", () => {
    const parent = tempDir('pm-links-')
    const dir = oldProfile(parent)
    const home = tempDir('pm-home-')
    mkdirSync(join(dir, 'accounts', 'shared'))
    symlinkSync(join(dir, 'accounts', 'shared'), join(dir, 'accounts', 'a-1', 'shared'), 'junction')
    symlinkSync(home, join(dir, 'accounts', 'a-1', 'projects'), 'junction')
    moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops() })
    const a1 = join(parent, 'Combwork', 'accounts', 'a-1')
    const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()
    expect(norm(readlinkSync(join(a1, 'shared')))).toBe(norm(join(parent, 'Combwork', 'accounts', 'shared')))
    expect(norm(readlinkSync(join(a1, 'projects')))).toBe(norm(home))
  })
})
