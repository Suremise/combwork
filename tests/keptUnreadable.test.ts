// Kept files that are there but can't be read (HI-2414): locked by another program, access refused, a disk error. Such
// a read is never taken for a new file: a change to it is refused (KeptFileUnreadable), and a plain read gives its .bak's
// value and keeps anything from being written over it, so neither the file nor its .bak is replaced by defaults.
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
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

const base = tempDir('cw-keptunreadable-')
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
/** Something else saving a kept file in place, part way (changed "a moment ago" for the whole read: unsettled, #1600). */
function savingNow(f: string, text: string): void {
  writeFileSync(f, text)
  const soon = new Date(Date.now() + 60_000)
  utimesSync(f, soon, soon)
}
/** A kept file's text as writeKeptJson writes it. */
const pretty = (v: unknown): string => JSON.stringify(v, null, 2) + '\n'
function bytes(f: string): { file: string; bak: string } {
  reads.peeking = true
  try {
    return { file: readFileSync(f, 'utf8'), bak: readFileSync(`${f}.bak`, 'utf8') }
  } finally {
    reads.peeking = false
  }
}

describe('a kept file that is there but unreadable (HI-2414)', () => {
  const dir = tempDir('cw-keptlocked-')
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

  it("a plain read gives its .bak's value; a holder's saves are refused until its own read succeeds again", async () => {
    const f = await saved({ agents: ['a'], id: 'p1' })
    const before = bytes(f)
    // The .bak older than the file (written separately, or an edit outside Combwork): what a stale holder would save.
    writeFileSync(`${f}.bak`, JSON.stringify({ agents: [] }))
    const older = bytes(f)
    const holder = {}
    lock(f)
    await expect(readKeptJson(f, {}, { holder })).resolves.toEqual({ agents: [] })
    // Without a .bak: the caller's default for the read.
    rmSync(`${f}.bak`)
    await expect(readKeptJson(f, { fresh: true })).resolves.toEqual({ fresh: true })
    writeFileSync(`${f}.bak`, older.bak)
    await expect(writeKeptJson(f, { agents: [], chime: 'on' }, { holder })).rejects.toBeInstanceOf(KeptFileUnreadable)
    expect(bytes(f)).toEqual(older)
    // Readable again, and read by someone else (HR3's round 1): that proves nothing about what the holder keeps.
    reads.locked.clear()
    await expect(readKeptJson(f, {})).resolves.toEqual({ agents: ['a'], id: 'p1' })
    expect(readKeptJsonSync(f, null)).toEqual({ agents: ['a'], id: 'p1' })
    await expect(writeKeptJson(f, { agents: [], chime: 'on' }, { holder })).rejects.toBeInstanceOf(KeptFileUnreadable)
    expect(bytes(f)).toEqual(older)
    // Another holder, and a write naming none (a change read for itself), aren't held back by this one.
    await writeKeptJson(f, { agents: ['a'], id: 'p1' }, { holder: {} })
    expect(bytes(f).file).toBe(before.file)
    // The holder's own read: its saves go through again.
    await expect(readKeptJson(f, {}, { holder })).resolves.toEqual({ agents: ['a'], id: 'p1' })
    await writeKeptJson(f, { agents: ['a'], id: 'p1', chime: 'on' }, { holder })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ agents: ['a'], id: 'p1', chime: 'on' })
  })

  it('the synchronous read (config.json) the same way', async () => {
    const f = await saved({ settings: { theme: 'dark' } })
    const before = bytes(f)
    const holder = {}
    lock(f)
    expect(readKeptJsonSync(f, null, { holder })).toEqual({ settings: { theme: 'dark' } })
    reads.locked.clear()
    await readKeptJson(f, null)
    await expect(writeKeptJson(f, { settings: {} }, { compact: true, bakOncePerRun: true, holder })).rejects.toBeInstanceOf(KeptFileUnreadable)
    expect(bytes(f)).toEqual(before)
    expect(readKeptJsonSync(f, null, { holder })).toEqual({ settings: { theme: 'dark' } })
    await writeKeptJson(f, { settings: { theme: 'light' } }, { compact: true, holder })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ settings: { theme: 'light' } })
  })

  it('a file that is gone is still new: the default, and written as usual', async () => {
    const f = join(dir, 'new.json')
    const holder = {}
    await expect(readKeptJson(f, { fresh: true }, { unsettled: 'throw' })).resolves.toEqual({ fresh: true })
    expect(readKeptJsonSync(f, null, { holder })).toBeNull()
    await writeKeptJson(f, { fresh: true }, { holder })
    expect(bytes(f)).toEqual({ file: pretty({ fresh: true }), bak: pretty({ fresh: true }) })
    // Unreadable once, then deleted: no longer held back.
    lock(f)
    await readKeptJson(f, {}, { holder })
    rmSync(f)
    reads.locked.clear()
    await writeKeptJson(f, { again: true }, { holder })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ again: true })
  })

  it("a holder's read again that gets the .bak (the file still being saved) keeps its saves refused (HR3's round 2)", async () => {
    const f = await saved({ projects: ['saved-project'], chime: true })
    const finished = readFileSync(f, 'utf8')
    writeFileSync(`${f}.bak`, JSON.stringify({ projects: [], chime: true }))
    const older = bytes(f)
    const holder = {}
    lock(f)
    await expect(readKeptJson(f, {}, { holder })).resolves.toEqual({ projects: [], chime: true })
    reads.locked.clear()
    // Something else saving it in place: part way, and "a moment ago" for the whole read, so still unsettled.
    savingNow(f, '{')
    await expect(readKeptJson(f, {}, { holder })).resolves.toEqual({ projects: [], chime: true })
    expect(readKeptJsonSync(f, null, { holder })).toEqual({ projects: [], chime: true })
    // The save finishes; the holder still has the .bak's value.
    writeFileSync(f, finished)
    await expect(writeKeptJson(f, { projects: [], chime: false }, { holder })).rejects.toBeInstanceOf(KeptFileUnreadable)
    expect(bytes(f)).toEqual({ file: finished, bak: older.bak })
    // Its read of the finished file: the file's settings, saved as usual.
    await expect(readKeptJson(f, {}, { holder })).resolves.toEqual({ projects: ['saved-project'], chime: true })
    await writeKeptJson(f, { projects: ['saved-project'], chime: false }, { holder })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ projects: ['saved-project'], chime: false })
  })

  it('a damaged file recovered from its .bak is the file again: its holder can save', async () => {
    const f = await saved({ n: 1 })
    const holder = {}
    writeFileSync(f, '{"n": ')
    const old = new Date(Date.now() - 60_000) // damaged a while ago, not a save in progress (#1601)
    utimesSync(f, old, old)
    await expect(readKeptJson(f, null, { holder })).resolves.toEqual({ n: 1 })
    await writeKeptJson(f, { n: 2 }, { holder })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ n: 2 })
  })

  it('retryWhileSaving runs a change again while the file is unreadable, KEPT_TRIES times in all', async () => {
    let runs = 0
    await expect(retryWhileSaving(async () => (++runs, Promise.reject(new KeptFileUnreadable('x.json'))))).rejects.toBeInstanceOf(KeptFileUnreadable)
    expect(runs).toBe(KEPT_TRIES)
  })

  it("says the file couldn't be read, as a conflict", () => {
    const e = new KeptFileUnreadable('C:\\ws\\.combwork\\project.json')
    expect(e.message).toBe("C:\\ws\\.combwork\\project.json couldn't be read: nothing was changed. Try again in a moment.")
    expect(e.kind).toBe('conflict')
  })
})

describe('a project setting saved while project.json is unreadable (HI-2414)', () => {
  it('is refused: project.json and its .bak stay byte for byte, the saved agents and id kept', async () => {
    const ws = join(base, 'ws')
    const alpha = join(ws, 'alpha')
    mkdirSync(join(alpha, '.combwork'), { recursive: true })
    const file = join(alpha, '.combwork', 'project.json')
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

describe("workspace.json unreadable when its workspace opens (HI-2414, HR3's round 1)", () => {
  it('its settings are never saved from the .bak, even once another reader has read the file', async () => {
    const ws = join(base, 'ws-settings')
    const file = join(ws, '.combwork', 'workspace.json')
    mkdirSync(join(ws, '.combwork'), { recursive: true })
    // The file has a server turned on; its .bak, from before, doesn't.
    const saved = { version: 1, mcp: { enabled: ['saved-server'] } }
    writeFileSync(file, pretty(saved))
    writeFileSync(`${file}.bak`, pretty({ version: 1, mcp: { enabled: [] } }))
    const before = bytes(file)
    const w = createWorkspaceService()
    onTestFinished(() => disposeWorkspaceService(w))
    lock(file)
    await w.open(ws)
    reads.locked.clear()
    // Another reader (the journal's, the accounts') reads the file as it is.
    await expect(readKeptJson(file, {})).resolves.toMatchObject({ mcp: { enabled: ['saved-server'] } })
    await expect(w.saveWorkspaceConfig()).rejects.toBeInstanceOf(KeptFileUnreadable)
    await expect(w.saveWorkspaceConfigWith(() => ({}))).rejects.toBeInstanceOf(KeptFileUnreadable)
    expect(bytes(file)).toEqual(before)
    // Read again by the workspace (workspace.json changed on disk): saved as usual, its server kept.
    writeFileSync(file, JSON.stringify(saved))
    await w['reloadConfig']()
    await w.saveWorkspaceConfig()
    expect(JSON.parse(readFileSync(file, 'utf8')).mcp.enabled).toEqual(['saved-server'])
  })

  it("unreadable, then read again part way through another program's save, then saved: the finished settings kept (HR3's round 2)", async () => {
    const ws = join(base, 'ws-saving')
    const file = join(ws, '.combwork', 'workspace.json')
    mkdirSync(join(ws, '.combwork'), { recursive: true })
    const saved = { version: 1, mcp: { enabled: ['saved-server'] } }
    writeFileSync(file, pretty(saved))
    writeFileSync(`${file}.bak`, pretty({ version: 1, mcp: { enabled: [] } }))
    const older = bytes(file).bak
    const w = createWorkspaceService()
    onTestFinished(() => disposeWorkspaceService(w))
    lock(file)
    await w.open(ws)
    reads.locked.clear()
    // Another program saves it in place: read by the workspace part way (the .bak's value again), then finished.
    savingNow(file, '{')
    await w['reloadConfig']()
    writeFileSync(file, pretty(saved))
    // Refused, unless the workspace's watcher has read the finished file meanwhile (then it saves what it read): either
    // way the server stays on, in the file and its .bak.
    await w.saveWorkspaceConfig().catch((e: unknown) => expect(e).toBeInstanceOf(KeptFileUnreadable))
    const after = bytes(file)
    expect(JSON.parse(after.file).mcp.enabled).toEqual(['saved-server'])
    expect(after.bak === older || JSON.parse(after.bak).mcp.enabled[0] === 'saved-server').toBe(true)
  })
})
