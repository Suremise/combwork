import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { junction } from './pathAliases'
import { tempDir } from './tempDir'

// writeTextAtomic's file calls, made to fail on demand: the temp file's write part way, or every rename.
const fail = vi.hoisted(() => ({ write: false, rename: false }))
vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs/promises')>()
  const writeFile: typeof real.writeFile = async (file, data, opts) => {
    if (!fail.write) return real.writeFile(file, data, opts)
    await real.writeFile(file, String(data).slice(0, 3), opts)
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  }
  const rename: typeof real.rename = async (from, to) => {
    if (fail.rename) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    return real.rename(from, to)
  }
  return { ...real, default: { ...real, writeFile, rename }, writeFile, rename }
})

const { writeTextAtomic } = await import('../src/main/fsutil')
const { BAK_AGE_MS, IMPORTED_AGE_MS, PROJECT_STORES, WORKSPACE_STORES, importedBackup, sweepLeftovers, sweepWorkspaceLeftovers } = await import('../src/main/leftovers')

const HOUR = 60 * 60 * 1000

afterEach(() => {
  vi.useRealTimers()
  fail.write = false
  fail.rename = false
})

/** Makes a file; `ageFromNow` (ms before `now`) sets its modified time, else it is as old as it really is (just made). */
function put(file: string, now: number, ageFromNow?: number): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '{}')
  if (ageFromNow !== undefined) utimesSync(file, new Date(now - ageFromNow), new Date(now - ageFromNow))
  return file
}

describe('sweeping the leftovers (#1016)', () => {
  it("sends a move's backups to the Recycle Bin two weeks after the move, by the time in their name, and nothing else (#1111)", async () => {
    const ws = tempDir('hive-leftovers-imported-')
    const hive = join(ws, '.combwork')
    const project = join(ws, 'alpha', '.combwork')
    const moved = Date.parse('2026-10-01T12:00:00.000Z')
    const now = moved + IMPORTED_AGE_MS + HOUR
    const name = (base: string, at = moved): string => `${base}.imported-${new Date(at).toISOString().replace(/[:.]/g, '-')}`
    const folder = join(hive, name('tasks'))
    put(join(folder, '1.json'), now)
    const gone = [folder, put(join(hive, 'metrics', name('metrics.json')), now), put(join(hive, name('lanes.json')), now), put(join(hive, 'assistant', name('sessions.json')), now), put(join(project, name('deliveries.json')), now)]
    const kept = [
      put(join(hive, 'metrics', name('metrics.json', moved + 2 * HOUR)), now), // moved less than two weeks ago
      put(join(hive, name('notes.json')), now), // not a store that moved
      put(join(hive, 'shared', name('metrics.json')), now), // not in its store's folder
      put(join(hive, 'metrics', 'metrics.json.imported-yesterday'), now), // no time in its name
      put(join(project, name('project.json')), now)
    ]
    // A link named like a backup is never followed nor removed.
    const target = tempDir('hive-leftovers-target-')
    put(join(target, 'keep.json'), now)
    const link = join(hive, name('watches.json'))
    junction(target, link)
    const binned: string[] = []
    const swept = await sweepLeftovers([{ hive, stores: WORKSPACE_STORES }, { hive: project, stores: PROJECT_STORES }], { now, trash: async (p) => void binned.push(p) })
    expect(binned.sort()).toEqual([...gone].sort())
    expect(swept.imported).toBe(5)
    for (const f of kept) expect(existsSync(f), f).toBe(true)
    expect(existsSync(join(target, 'keep.json'))).toBe(true)
    // One the Recycle Bin refused stays for the next open, and isn't counted.
    const again = await sweepLeftovers([{ hive, stores: WORKSPACE_STORES }], { now, trash: async () => Promise.reject(new Error('held')) })
    expect(again.imported).toBe(0)
  })

  it("reads a move's backup name: what moved, and when", () => {
    expect(importedBackup('tasks.imported-2026-10-18T09-30-05-123Z')).toEqual({ base: 'tasks', at: Date.parse('2026-10-18T09:30:05.123Z') })
    expect(importedBackup('metrics.json.imported-2026-10-18T09-30-05-123Z')?.base).toBe('metrics.json')
    expect(importedBackup('metrics.json.imported-2026-13-45T09-30-05-123Z')).toBeNull()
    expect(importedBackup('metrics.json.imported')).toBeNull()
    expect(importedBackup('tasks')).toBeNull()
  })

  it("removes old temp files and the migration's old backups, and nothing else", async () => {
    const hive = join(tempDir('hive-leftovers-'), '.combwork')
    // Files made now are eight days old at `now`: older than both limits. Ones dated an hour before `now` are new.
    const now = Date.now() + BAK_AGE_MS + 24 * HOUR
    const gone = [
      put(join(hive, 'tasks', '1.json.before-ids.bak'), now),
      put(join(hive, 'tasks', '2.json.before-ids.bak'), now),
      put(join(hive, 'tasks', '975.json.4242-17.tmp'), now),
      put(join(hive, 'metrics', 'metrics.json.4242-3.tmp'), now),
      put(join(hive, 'watches.json.4242-a1b2c3d4.tmp'), now),
      put(join(hive, 'lanes.json.before-ids.bak'), now),
      put(join(hive, 'assistant', 'sessions', '0a1b2c3d-4e5f-6789-abcd-ef0123456789.jsonl.4242-5.tmp'), now)
    ]
    const kept = [
      put(join(hive, 'tasks', '1.json'), now),
      put(join(hive, 'tasks', '3.json.before-ids.bak'), now, HOUR), // made an hour ago: kept for its week
      put(join(hive, 'metrics', 'metrics.json.4242-9.tmp'), now, HOUR), // a write that may still be under way
      put(join(hive, 'workspace.json.bak'), now), // a kept file's last good copy
      put(join(hive, 'shared', 'notes.tmp'), now), // not a name Combwork's writes use
      // A temp file's or a backup's suffix on anything but a store's own files is never taken for a failed save (round 1):
      put(join(hive, 'shared', 'research.123-abc.tmp'), now), // the user's notes
      put(join(hive, 'shared', 'handovers', 'x.md.123-4.tmp'), now),
      put(join(hive, 'attachments', 'session', 'report.123-abc.tmp'), now), // attachments
      put(join(hive, 'unknown', 'user.json.before-ids.bak'), now), // a folder Combwork doesn't know
      put(join(hive, 'unknown', 'metrics.json.1-2.tmp'), now),
      put(join(hive, 'tasks', 'notes.json.1-2.tmp'), now), // in a store, but not one of its files
      put(join(hive, 'tasks', 'board.json.before-ids.bak'), now), // a store file the migration never backed up
      put(join(hive, 'metrics', 'other.json.1-2.tmp'), now),
      put(join(hive, 'project.json.1-2.tmp'), now), // a project's file, not the workspace's
      put(join(hive, 'skills', 'mine', 'draft.1-2.tmp'), now), // the user's skills are never looked into
      put(join(hive, 'launch-a-1', 'x.json.1-2.tmp'), now)
    ]
    const swept = await sweepLeftovers([{ hive, stores: WORKSPACE_STORES }], { now })
    for (const f of gone) expect(existsSync(f), f).toBe(false)
    for (const f of kept) expect(existsSync(f), f).toBe(true)
    expect({ temp: swept.temp, bak: swept.bak }).toEqual({ temp: 4, bak: 3 })
    expect(swept.removed).toEqual(
      expect.arrayContaining([
        { dir: hive, temp: 1, bak: 1, imported: 0 },
        { dir: join(hive, 'tasks'), temp: 1, bak: 2, imported: 0 },
        { dir: join(hive, 'metrics'), temp: 1, bak: 0, imported: 0 }
      ])
    )
    // A second open finds nothing.
    expect((await sweepLeftovers([{ hive, stores: WORKSPACE_STORES }], { now })).removed).toEqual([])
  })

  it("sweeps the workspace's .combwork and each project's, hidden ones too, and says what went in one line", async () => {
    const ws = tempDir('hive-leftovers-ws-')
    const files = [join(ws, '.combwork', 'tasks', '9.json.before-ids.bak'), join(ws, 'alpha', '.combwork', 'sessions.json.12-1.tmp'), join(ws, 'beta', '.combwork', 'deliveries.json.12-ab12cd34.tmp')].map((f) => put(f, 0))
    // Opened eight days after they were made (only Date is faked: the file calls run as they do).
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + BAK_AGE_MS + 24 * HOUR)
    const fake = {
      path: ws,
      lifetime: new AbortController().signal,
      listProjectPaths: async (o: { hidden?: boolean } = {}) => [join(ws, o.hidden ? 'beta' : 'alpha')]
    }
    const swept = await sweepWorkspaceLeftovers(fake as never)
    expect({ temp: swept?.temp, bak: swept?.bak }).toEqual({ temp: 2, bak: 1 })
    for (const f of files) expect(existsSync(f), f).toBe(false)
  })

  it("never removes anything of a workspace switched away from while its projects were listed, nor looks at the next one's (round 1)", async () => {
    const a = tempDir('hive-leftovers-a-')
    const b = tempDir('hive-leftovers-b-')
    const files = [join(a, '.combwork', 'tasks', '1.json.12-1.tmp'), join(a, 'alpha', '.combwork', 'sessions.json.12-2.tmp'), join(b, '.combwork', 'tasks', '1.json.12-3.tmp'), join(b, 'beta', '.combwork', 'sessions.json.12-4.tmp')].map((f) => put(f, 0))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + BAK_AGE_MS + 24 * HOUR)
    for (const at of ['shown', 'hidden'] as const) {
      // The window opens b while a's (shown or hidden) projects are listed: a's lifetime ends, b's begins.
      const aLife = new AbortController()
      const fake = {
        path: a,
        lifetime: aLife.signal,
        listProjectPaths: async (o: { hidden?: boolean } = {}) => {
          const listed = [join(fake.path, o.hidden ? 'gamma' : fake.path === a ? 'alpha' : 'beta')]
          if ((at === 'hidden') === !!o.hidden) {
            aLife.abort()
            Object.assign(fake, { path: b, lifetime: new AbortController().signal })
          }
          return listed
        }
      }
      expect(await sweepWorkspaceLeftovers(fake as never), at).toBeNull()
      for (const f of files) expect(existsSync(f), `${at}: ${f}`).toBe(true)
    }
  })

  it('never follows a link or junction out of the .combwork: a linked store, a linked folder above one, or a linked .combwork (round 2)', async () => {
    const base = tempDir('hive-leftovers-links-')
    const now = Date.now() + BAK_AGE_MS + 24 * HOUR
    // Folders elsewhere, with old files named as a store's would be.
    const outside = (name: string, file: string): string => put(join(base, 'elsewhere', name, file), now)
    const viaTasks = outside('tasks', '1.json.12-1.tmp')
    const viaTasksBak = outside('tasks', '1.json.before-ids.bak')
    const viaMetrics = outside('metrics', join('benchmarks', 'run.json.12-2.tmp'))
    const viaHive = outside('hive', join('tasks', '2.json.12-3.tmp'))
    const ws = join(base, 'ws', '.combwork')
    mkdirSync(ws, { recursive: true })
    junction(join(base, 'elsewhere', 'tasks'), join(ws, 'tasks')) // the store itself linked
    junction(join(base, 'elsewhere', 'metrics'), join(ws, 'metrics')) // a folder above metrics/benchmarks linked
    const linkedHive = join(base, 'linked', '.combwork')
    mkdirSync(dirname(linkedHive), { recursive: true })
    junction(join(base, 'elsewhere', 'hive'), linkedHive) // the .combwork itself linked
    // A real store beside them is still swept.
    const real = put(join(ws, 'lanes.json.12-4.tmp'), now)
    const swept = await sweepLeftovers([{ hive: ws, stores: WORKSPACE_STORES }, { hive: linkedHive, stores: WORKSPACE_STORES }], { now })
    for (const f of [viaTasks, viaTasksBak, viaMetrics, viaHive]) expect(existsSync(f), f).toBe(true)
    expect(existsSync(real)).toBe(false)
    expect({ temp: swept.temp, bak: swept.bak }).toEqual({ temp: 1, bak: 0 })
  })

  it("a project's stores are only its settings, sessions, deliveries and transcript backups", async () => {
    const hive = join(tempDir('hive-leftovers-project-'), '.combwork')
    const now = Date.now() + BAK_AGE_MS + 24 * HOUR
    // A backup compressed, or decompressed to archive it, part way when Combwork stopped (#1110).
    const gone = [put(join(hive, 'project.json.1-1.tmp'), now), put(join(hive, 'sessions.json.bak.1-2.tmp'), now), put(join(hive, 'sessions', 'abc-123.jsonl.1-3.tmp'), now), put(join(hive, 'sessions', 'abc-123.jsonl.gz.1-7.tmp'), now), put(join(hive, 'archive', 'abc-123.jsonl.1-8.tmp'), now)]
    const kept = [put(join(hive, 'attachments', 'a.png.1-4.tmp'), now), put(join(hive, 'archive', 'x.json.1-5.tmp'), now), put(join(hive, 'workspace.json.1-6.tmp'), now), put(join(hive, 'project.json.before-ids.bak'), now)]
    expect((await sweepLeftovers([{ hive, stores: PROJECT_STORES }], { now })).temp).toBe(5)
    for (const f of gone) expect(existsSync(f), f).toBe(false)
    for (const f of kept) expect(existsSync(f), f).toBe(true)
  })

  it('stops when the workspace closes', async () => {
    const hive = join(tempDir('hive-leftovers-closed-'), '.combwork')
    const now = Date.now() + BAK_AGE_MS + 24 * HOUR
    const f = put(join(hive, 'tasks', '1.json.4242-1.tmp'), now)
    const life = new AbortController()
    life.abort()
    expect((await sweepLeftovers([{ hive, stores: WORKSPACE_STORES }], { now, signal: life.signal })).temp).toBe(0)
    expect(existsSync(f)).toBe(true)
  })
})

describe('a failed atomic write leaves no temp file (#1016)', () => {
  it('when the rename keeps failing (EPERM), after its retries', async () => {
    const dir = tempDir('hive-atomic-rename-')
    const file = join(dir, '975.json')
    writeFileSync(file, 'before')
    fail.rename = true
    await expect(writeTextAtomic(file, 'after')).rejects.toMatchObject({ code: 'EPERM' })
    expect(readdirSync(dir)).toEqual(['975.json'])
    expect(readFileSync(file, 'utf8')).toBe('before')
  })

  it('when writing the temp file fails part way', async () => {
    const dir = tempDir('hive-atomic-write-')
    const file = join(dir, 'metrics.json')
    writeFileSync(file, 'before')
    fail.write = true
    await expect(writeTextAtomic(file, 'a much longer text')).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(readdirSync(dir)).toEqual(['metrics.json'])
    expect(readFileSync(file, 'utf8')).toBe('before')
  })
})
