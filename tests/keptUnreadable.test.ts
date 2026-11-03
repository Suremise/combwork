// Kept files that are there but can't be read (HI-2414): locked by another program, access refused, a disk error. Such
// a read is never taken for a new file: a change to it is refused (KeptFileUnreadable), and a plain read gives its .bak's
// value and keeps anything from being written over it, so neither the file nor its .bak is replaced by defaults.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { closeAllBoards } from '../src/main/boardStore'

/** Reads of these files (lower-case paths) fail as a locked file does: the next `transient` reads, or all while `locked`. */
const reads = { locked: new Set<string>(), transient: new Map<string, number>(), peeking: false }
function refused(p: unknown): boolean {
  // The test's own look at the files (its `fs` is the same module).
  if (reads.peeking) return false
  const k = String(p).toLowerCase()
  const left = reads.transient.get(k)
  if (left) {
    reads.transient.set(k, left - 1)
    return true
  }
  return reads.locked.has(k)
}
const eperm = (p: unknown): Error => Object.assign(new Error(`EPERM: operation not permitted, open '${String(p)}' (test)`), { code: 'EPERM' })

vi.mock('original-fs/promises', async (orig) => {
  const real = await orig<typeof import('fs/promises')>()
  return { ...real, readFile: (async (p: string, o?: unknown) => (refused(p) ? Promise.reject(eperm(p)) : real.readFile(p, o as BufferEncoding))) as typeof real.readFile }
})
vi.mock('original-fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  return {
    ...real,
    readFileSync: ((p: string, o?: unknown) => {
      if (refused(p)) throw eperm(p)
      return real.readFileSync(p, o as BufferEncoding)
    }) as typeof real.readFileSync
  }
})

const base = tempDir('hive-keptunreadable-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
afterAll(() => {
  closeAllBoards()
  rmSync(base, { recursive: true, force: true })
})
afterEach(() => {
  reads.locked.clear()
  reads.transient.clear()
})

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const { KEPT_TRIES, KeptFileUnreadable, readKeptJson, readKeptJsonSync, retryWhileSaving, writeKeptJson } = await import('../src/main/fsutil')

// A refusal reads the file again after the pauses (about 1 s), KEPT_TRIES times for a change.
vi.setConfig({ testTimeout: 30_000 })

const lock = (f: string): void => void reads.locked.add(f.toLowerCase())
function bytes(f: string): { file: string; bak: string } {
  reads.peeking = true
  try {
    return { file: readFileSync(f, 'utf8'), bak: readFileSync(`${f}.bak`, 'utf8') }
  } finally {
    reads.peeking = false
  }
}

describe('a kept file that is there but unreadable (HI-2414)', () => {
  const dir = tempDir('hive-keptlocked-')
  let n = 0
  const saved = async (value: unknown): Promise<string> => {
    const f = join(dir, `kept-${++n}.json`)
    await writeKeptJson(f, value)
    return f
  }

  it('read for a change: KeptFileUnreadable, never the default; the file and its .bak untouched', async () => {
    const f = await saved({ agents: ['a'], id: 'p1' })
    const before = bytes(f)
    lock(f)
    await expect(readKeptJson(f, {}, { unsettled: 'throw' })).rejects.toBeInstanceOf(KeptFileUnreadable)
    expect(bytes(f)).toEqual(before)
  })

  it('locked only for a moment: read again after a pause, its value as it is', async () => {
    const f = await saved({ n: 1 })
    reads.transient.set(f.toLowerCase(), 2)
    await expect(readKeptJson(f, {}, { unsettled: 'throw' })).resolves.toEqual({ n: 1 })
  })

  it("a plain read gives its .bak's value, and nothing is written over it until a read succeeds again", async () => {
    const f = await saved({ agents: ['a'], id: 'p1' })
    const before = bytes(f)
    lock(f)
    await expect(readKeptJson(f, {})).resolves.toEqual({ agents: ['a'], id: 'p1' })
    // Without a .bak: the caller's default for the read, still never written over the file.
    rmSync(`${f}.bak`)
    await expect(readKeptJson(f, { fresh: true })).resolves.toEqual({ fresh: true })
    writeFileSync(`${f}.bak`, before.bak)
    await expect(writeKeptJson(f, { fresh: true })).rejects.toBeInstanceOf(KeptFileUnreadable)
    expect(bytes(f)).toEqual(before)
    // Readable again: read, then saved as usual.
    reads.locked.clear()
    await expect(writeKeptJson(f, { fresh: true })).rejects.toBeInstanceOf(KeptFileUnreadable)
    await expect(readKeptJson(f, {})).resolves.toEqual({ agents: ['a'], id: 'p1' })
    await writeKeptJson(f, { agents: ['a'], id: 'p1', chime: 'on' })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ agents: ['a'], id: 'p1', chime: 'on' })
  })

  it('the synchronous read (config.json) the same way', async () => {
    const f = await saved({ settings: { theme: 'dark' } })
    const before = bytes(f)
    lock(f)
    expect(readKeptJsonSync(f, null)).toEqual({ settings: { theme: 'dark' } })
    await expect(writeKeptJson(f, { settings: {} }, { compact: true, bakOncePerRun: true })).rejects.toBeInstanceOf(KeptFileUnreadable)
    expect(bytes(f)).toEqual(before)
  })

  it('a file that is gone is still new: the default, and written as usual', async () => {
    const f = join(dir, 'new.json')
    await expect(readKeptJson(f, { fresh: true }, { unsettled: 'throw' })).resolves.toEqual({ fresh: true })
    expect(readKeptJsonSync(f, null)).toBeNull()
    await writeKeptJson(f, { fresh: true })
    expect(bytes(f)).toEqual({ file: '{\n  "fresh": true\n}\n', bak: '{\n  "fresh": true\n}\n' })
    // Unreadable once, then deleted: no longer kept from being written.
    lock(f)
    await readKeptJson(f, {})
    rmSync(f)
    reads.locked.clear()
    await writeKeptJson(f, { again: true })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ again: true })
  })

  it('retryWhileSaving runs a change again while the file is unreadable, KEPT_TRIES times in all', async () => {
    let runs = 0
    await expect(retryWhileSaving(async () => (++runs, Promise.reject(new KeptFileUnreadable('x.json'))))).rejects.toBeInstanceOf(KeptFileUnreadable)
    expect(runs).toBe(KEPT_TRIES)
  })

  it("says the file couldn't be read, as a conflict", () => {
    const e = new KeptFileUnreadable('C:\\ws\\.hive\\project.json')
    expect(e.message).toBe("C:\\ws\\.hive\\project.json couldn't be read: nothing was changed. Try again in a moment.")
    expect(e.kind).toBe('conflict')
  })
})

describe('a project setting saved while project.json is unreadable (HI-2414)', () => {
  it('is refused: project.json and its .bak stay byte for byte, the saved agents and id kept', async () => {
    const ws = join(base, 'ws')
    const alpha = join(ws, 'alpha')
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    const file = join(alpha, '.hive', 'project.json')
    writeFileSync(file, JSON.stringify({ version: 2, agents: [] }))
    const w = createWorkspaceService()
    onTestFinished(() => disposeWorkspaceService(w))
    await w.open(ws)
    await w.updateProjectConfig(alpha, { agents: [{ id: 'a1', name: 'Builder' }] as never, chime: 'on' })
    const before = bytes(file)
    expect(JSON.parse(before.file).agents.map((a: { id: string }) => a.id)).toEqual(['a1'])
    // Recently changed, so not kept by its stat: the next read reads the file.
    writeFileSync(file, before.file)
    lock(file)
    await expect(w.updateProjectConfig(alpha, { chime: 'off' })).rejects.toBeInstanceOf(KeptFileUnreadable)
    expect(bytes(file)).toEqual(before)
    // Readable again: the change is made on the saved settings.
    reads.locked.clear()
    const cfg = await w.updateProjectConfig(alpha, { chime: 'off' })
    expect(cfg.chime).toBe('off')
    expect(JSON.parse(readFileSync(file, 'utf8')).agents.map((a: { id: string }) => a.id)).toEqual(['a1'])
  })
})
