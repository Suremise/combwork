// Kept files changed by Hive while something else is saving them (#1600): a read-modify-write (project.json, the
// record of project names, the record of handovers' owners) never writes back the .bak's value read from a file still
// being saved; it reads again a few times, then refuses, the file left as the other program saves it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { closeAllBoards } from '../src/main/boardStore'

const base = tempDir('hive-keptchanges-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
afterAll(() => {
  closeAllBoards()
  rmSync(base, { recursive: true, force: true })
})

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const notes = await import('../src/main/notes')
const names = await import('../src/main/projectNames')
const { KEPT_TRIES, KeptFileBusy, readKeptJson, retryWhileSaving, writeKeptJson } = await import('../src/main/fsutil')

// Each refusal reads the file KEPT_TRIES times, each after the pauses (about 1 s).
vi.setConfig({ testTimeout: 30_000 })

let n = 0
async function open(): Promise<{ w: ReturnType<typeof createWorkspaceService>; ws: string; alpha: string }> {
  const ws = join(base, `ws-${++n}`)
  const alpha = join(ws, 'alpha')
  mkdirSync(join(alpha, '.combwork'), { recursive: true })
  writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  const w = createWorkspaceService()
  // Closed when the test ends, passed or failed.
  onTestFinished(() => disposeWorkspaceService(w))
  await w.open(ws)
  return { w, ws, alpha }
}

/** Something else saving a kept file in place, part way (emptied "a moment ago" for the whole read): still unsettled. */
function saving(file: string): void {
  writeFileSync(file, '')
  const soon = new Date(Date.now() + 60_000)
  utimesSync(file, soon, soon)
}

/** The file as the other program left it (still empty), its .bak unchanged, nothing set aside. */
function untouched(file: string, bak: string): void {
  expect(readFileSync(file, 'utf8')).toBe('')
  expect(readFileSync(`${file}.bak`, 'utf8')).toBe(bak)
  expect(readdirSync(join(file, '..')).filter((f) => f.includes('.corrupt-'))).toEqual([])
}

describe('a kept file read for a change (#1600)', () => {
  const dir = tempDir('hive-keptbusy-')

  it('throws KeptFileBusy while it is still being saved; other reads keep its last good copy', async () => {
    const f = join(dir, 'busy.json')
    await writeKeptJson(f, { n: 5 })
    saving(f)
    await expect(readKeptJson(f, null, { unsettled: 'throw' })).rejects.toBeInstanceOf(KeptFileBusy)
    await expect(readKeptJson(f, null)).resolves.toEqual({ n: 5 })
    expect(readFileSync(f, 'utf8')).toBe('')
    // Saved: read as it is.
    writeFileSync(f, JSON.stringify({ n: 6 }))
    await expect(readKeptJson(f, null, { unsettled: 'throw' })).resolves.toEqual({ n: 6 })
  })

  it('still damaged once it stops changing: recovered as before, not refused', async () => {
    const f = join(dir, 'damaged.json')
    await writeKeptJson(f, { n: 1 })
    writeFileSync(f, '{"n": ')
    const old = new Date(Date.now() - 60_000) // damaged a while ago, not a save stalled a moment ago (#1601)
    utimesSync(f, old, old)
    await expect(readKeptJson(f, null, { unsettled: 'throw' })).resolves.toEqual({ n: 1 })
  })

  it('retryWhileSaving runs the change again while the file is busy, KEPT_TRIES times in all, and passes other errors at once', async () => {
    let runs = 0
    await expect(retryWhileSaving(async () => (++runs < KEPT_TRIES ? Promise.reject(new KeptFileBusy('x.json')) : 'done'))).resolves.toBe('done')
    expect(runs).toBe(KEPT_TRIES)
    runs = 0
    await expect(retryWhileSaving(async () => (++runs, Promise.reject(new KeptFileBusy('x.json'))))).rejects.toBeInstanceOf(KeptFileBusy)
    expect(runs).toBe(KEPT_TRIES)
    runs = 0
    await expect(retryWhileSaving(async () => (++runs, Promise.reject(new Error('other'))))).rejects.toThrow('other')
    expect(runs).toBe(1)
  })

  it('says the file is being saved by something else, as a conflict', () => {
    const e = new KeptFileBusy('C:\\ws\\.combwork\\project.json')
    expect(e.message).toBe('C:\\ws\\.combwork\\project.json is being saved by something else: nothing was changed. Try again in a moment.')
    expect(e.kind).toBe('conflict')
  })
})

describe('read-modify-write callers refuse rather than write over a save in progress (#1600)', () => {
  it('mutateProjectConfig: project.json', async () => {
    const { w, alpha } = await open()
    const file = join(alpha, '.combwork', 'project.json')
    await w.updateProjectConfig(alpha, { chime: 'on' })
    const bak = readFileSync(`${file}.bak`, 'utf8')
    saving(file)
    const changes = vi.fn(() => ({ chime: 'off' as const }))
    await expect(w.mutateProjectConfig(alpha, changes)).rejects.toBeInstanceOf(KeptFileBusy)
    expect(changes).not.toHaveBeenCalled()
    untouched(file, bak)
    // The other program's save lands: the next change is made on top of it.
    writeFileSync(file, JSON.stringify({ version: 2, agents: [], chime: 'off', hand: 'edited' }))
    await w.updateProjectConfig(alpha, { suggestFreshStart: 'on' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ chime: 'off', suggestFreshStart: 'on', hand: 'edited' })
  })

  it('noteNames and noteFormerName: project-names.json', async () => {
    const { w, ws, alpha } = await open()
    const file = join(ws, '.combwork', 'project-names.json')
    const id = (await w.projectIds()).byPath.get(alpha.toLowerCase())!
    await names.noteNames(w, [{ path: alpha, id, copy: false }])
    expect(existsSync(file)).toBe(true)
    const bak = readFileSync(`${file}.bak`, 'utf8')
    saving(file)
    await expect(names.noteFormerName(w, id, 'older')).rejects.toBeInstanceOf(KeptFileBusy)
    untouched(file, bak)
    // A project not in the record yet (a new id): its record isn't written either.
    await expect(names.noteNames(w, [{ path: join(ws, 'beta'), id: 'p-00000000bbbb', copy: false }])).rejects.toBeInstanceOf(KeptFileBusy)
    untouched(file, bak)
  })

  it('ownHandover (a handover written): handover-owners.json, and no handover left without its owner', async () => {
    const { w, ws } = await open()
    const file = join(ws, '.combwork', 'handover-owners.json')
    await inWorkspace(w, () => notes.createHandover('alpha', 'First', 'x'))
    const bak = readFileSync(`${file}.bak`, 'utf8')
    saving(file)
    // Refused before the handover is written (review round 1): never there for someone to edit, so nothing is taken back.
    const second = (): string[] => readdirSync(join(ws, '.combwork', 'shared', 'handovers')).filter((f) => f.includes('second'))
    const run = { settled: false }
    // Its outcome as a value at once (no rejection left unhandled while the folder is watched).
    const made = inWorkspace(w, () => notes.createHandover('alpha', 'Second', 'y')).then(
      () => null,
      (e: unknown) => e
    )
    void made.finally(() => (run.settled = true))
    const seen: string[] = []
    while (!run.settled) {
      seen.push(...second())
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(await made).toBeInstanceOf(KeptFileBusy)
    expect(seen).toEqual([])
    expect(second()).toEqual([])
    untouched(file, bak)
    // Saved: the handover is written and owned.
    writeFileSync(file, bak)
    const third = await inWorkspace(w, () => notes.createHandover('alpha', 'Third', 'z'))
    expect(existsSync(third)).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).owners)).toContain(basename(third))
  })
})
