import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { backupPath, moveProfile, readRecord, REGENERATED, type MoveOps } from '../src/main/profileMove'
import { tempDir } from './tempDir'

// HI-2461: the profile folders move from Hive's names to Combwork's at the first start, copied (never moved) so nothing
// is lost: a failed copy leaves the old folder as it was, and the old folder becomes a dated backup only once the new
// one is whole.

const NOW = new Date('2026-11-03T20:00:00Z')
const BACKUP = 'Hive.backup-2026-11-03'

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

const ops = (over: Partial<MoveOps> = {}): MoveOps => ({ copyFile: (a, b) => copyFileSync(a, b), rename: (a, b) => renameSync(a, b), alive: () => false, pid: 1000, ...over })
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
    expect(existsSync(join(now, '.profile-move-owner.json'))).toBe(false)
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

  it('a partial move left by a start that ended partway: its copy is made again from the old folder', () => {
    const parent = tempDir('pm-partial-')
    oldProfile(parent)
    mkdirSync(join(parent, 'Combwork.moving'))
    writeFileSync(join(parent, 'Combwork.moving', '.profile-move-owner.json'), '{"pid":4242}')
    writeFileSync(join(parent, 'Combwork.moving', 'config.json'), '{"half":')
    const o = moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ alive: () => false }) })
    expect(o.kind).toBe('moved')
    expect(read(join(parent, 'Combwork', 'config.json'))).toBe('{"settings":{"theme":"dark"}}')
    expect(existsSync(join(parent, 'Combwork.moving'))).toBe(false)
  })

  it('another start copying now: this one gives way and changes nothing', () => {
    const parent = tempDir('pm-busy-')
    oldProfile(parent)
    mkdirSync(join(parent, 'Combwork.moving'))
    writeFileSync(join(parent, 'Combwork.moving', '.profile-move-owner.json'), '{"pid":4242}')
    expect(moveProfile(parent, 'Hive', 'Combwork', { now: NOW, ops: ops({ alive: (pid) => pid === 4242 }) })).toEqual({ kind: 'busy', use: join(parent, 'Hive') })
    expect(existsSync(join(parent, 'Combwork.moving', '.profile-move-owner.json'))).toBe(true)
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
