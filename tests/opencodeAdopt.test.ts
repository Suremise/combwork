// Adopting an OpenCode session Combwork didn't make (HI-2774, design s16): sessions.adopt through the OpenCode adapter's
// adopting step. Combwork's mark goes into the account holding the session, written by the history's worker in order with
// that account's removal, so the session resumes as one Combwork made; a session read only in part, from another folder,
// under another mark or in an account going away is refused before anything is recorded; a fork stays a sub-session with
// no mark; and a record that can't be written takes back only the mark this adoption made.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-oc-adopt-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { opencode } = await import('../src/main/providers/opencode/adapter')
const history = await import('../src/main/providers/opencode/history')
const { buildMirror } = await import('../src/main/providers/opencode/mirror')
const { markPath, mirrorDir, mirrorPath } = await import('../src/main/providers/opencode/historyCore')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'proj')
const home = join(base, 'account')
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
let n = 0
const newId = (): string => `ses_adopt${String(++n).padStart(4, '0')}AAAAAAAAAAAAAAAAAA`

/** A session OpenCode's TUI made, as discovery mirrors it: complete, external, in `dir`; a fork when `fork` names its source. */
function external(dir = p, fork?: string): string {
  const id = newId()
  mkdirSync(mirrorDir(home), { recursive: true })
  const info = { id, title: `TUI ${id.slice(-4)}`, cost: 0, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1000, updated: 2000 }, location: { directory: dir }, ...(fork ? { fork: { sessionID: fork, boundary: { type: 'before', messageID: 'msg_x' } } } : {}) }
  const messages = [{ id: 'msg_u', time: { created: 1500 }, type: 'user', text: 'hello' }, { id: 'msg_a', time: { created: 1600 }, type: 'assistant', content: [{ type: 'text', text: 'hi' }], tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }]
  writeFileSync(mirrorPath(home, id), buildMirror({ w: -1, source: 'export', updated: 2000, external: true }, info, messages))
  return id
}
const record = async (id: string) => (await run(() => workspace.sessionsFile(p))).sessions.find((s) => s.id === id)

describe("adopting an OpenCode session Combwork didn't make (HI-2774)", () => {
  const realWrite = sessions.writeAdopted
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'o1', name: 'Oc', provider: 'opencode' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    opencode.allHomes = () => [home]
    await history.historyWorkerForTests('in-process')
  })
  beforeEach(() => {
    sessions.writeAdopted = realWrite
  })
  afterAll(async () => {
    sessions.writeAdopted = realWrite
    await history.historyWorkerForTests(null)
    disposeWorkspaceService(w)
  })

  it('takes it over: a record of its own, and the mark in its account that lets it resume', async () => {
    const id = external()
    await run(() => sessions.adopt(p, id))
    expect(await record(id)).toMatchObject({ id, agent: 'opencode' })
    expect((await record(id))?.sub).toBeUndefined()
    expect(JSON.parse(readFileSync(markPath(home, id), 'utf8'))).toEqual({ id, directory: p })
    // Its transcript is found through the mark now, as a session Combwork made.
    expect(await opencode.transcriptPath(p, id)).toBe(mirrorPath(home, id))
  })

  it('takes back only the mark it made when the record can\'t be written', async () => {
    const id = external()
    sessions.writeAdopted = async () => {
      throw new Error('disk full')
    }
    await expect(run(() => sessions.adopt(p, id))).rejects.toThrow('disk full')
    expect(existsSync(markPath(home, id))).toBe(false)
    expect(await record(id)).toBeUndefined()
    // A matching mark that was there before is left as it was.
    const kept = external()
    writeFileSync(markPath(home, kept), JSON.stringify({ id: kept, directory: p }))
    // (With its mark there it is Combwork's already: adopting it records it, and a failed record leaves the mark.)
    await expect(run(() => sessions.adopt(p, kept))).rejects.toThrow('disk full')
    expect(existsSync(markPath(home, kept))).toBe(true)
  })

  it('refuses one from another folder before recording anything, saying why in the window\'s language', async () => {
    const id = external(join(base, 'elsewhere'))
    await expect(run(() => sessions.adopt(p, id))).rejects.toThrow(/ran in a folder that isn't this project's/)
    expect(existsSync(markPath(home, id))).toBe(false)
    expect(await record(id)).toBeUndefined()
  })

  it('refuses when its account is removed after the first checks, leaving no mark and no record', async () => {
    const id = external()
    const real = history.opencodeHistory.adoptMark.bind(history.opencodeHistory)
    history.opencodeHistory.adoptMark = async (...a) => {
      await history.opencodeHistory.removeRoot(home)
      return real(...a)
    }
    try {
      await expect(run(() => sessions.adopt(p, id))).rejects.toThrow(/isn't one of its account's sessions any more/)
    } finally {
      history.opencodeHistory.adoptMark = real
      await history.historyWorkerForTests('in-process')
    }
    expect(existsSync(markPath(home, id))).toBe(false)
    expect(await record(id)).toBeUndefined()
  })

  it('keeps the mark of an adoption that succeeded while another of the same session failed (HR2, round 1)', async () => {
    const id = external()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    sessions.writeAdopted = async (...a) => {
      // The first adoption's record waits, then fails; the second's is written.
      if (++calls === 1) {
        await gate
        throw new Error('disk full')
      }
      return realWrite(...a)
    }
    const first = run(() => sessions.adopt(p, id))
    const second = run(() => sessions.adopt(p, id))
    release()
    await expect(first).rejects.toThrow('disk full')
    await second
    expect(await record(id)).toMatchObject({ id })
    expect(JSON.parse(readFileSync(markPath(home, id), 'utf8'))).toEqual({ id, directory: p })
  })

  it("refuses when its account goes after the mark was made but before the record: no record, no mark (HR2, round 1)", async () => {
    const id = external()
    const real = history.opencodeHistory.adoptCommit.bind(history.opencodeHistory)
    history.opencodeHistory.adoptCommit = async (...a) => {
      await history.opencodeHistory.removeRoot(home)
      return real(...a)
    }
    try {
      await expect(run(() => sessions.adopt(p, id))).rejects.toThrow(/isn't one of its account's sessions any more/)
    } finally {
      history.opencodeHistory.adoptCommit = real
      await history.historyWorkerForTests('in-process')
    }
    expect(existsSync(markPath(home, id))).toBe(false)
    expect(await record(id)).toBeUndefined()
  })

  it("holds its account's removal while its record is written, and lets it go once the record is (HR2, round 1)", async () => {
    const id = external()
    let removed = false
    let removing: Promise<unknown> = Promise.resolve()
    sessions.writeAdopted = async (...a) => {
      removing = history.opencodeHistory.removeRoot(home).then(() => (removed = true))
      // The removal waits on this adoption's record (polled a few times while it is being written).
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
      expect(removed).toBe(false)
      return realWrite(...a)
    }
    try {
      await run(() => sessions.adopt(p, id))
      await removing
      expect(removed).toBe(true)
      expect(await record(id)).toMatchObject({ id })
    } finally {
      await history.historyWorkerForTests('in-process')
    }
  })

  it('adopts a fork as a sub-session of its source, with no mark: never resumed', async () => {
    const source = newId()
    const id = external(p, source)
    await run(() => sessions.adopt(p, id))
    expect((await record(id))?.sub).toEqual({ parentId: source, kind: 'fork' })
    expect(existsSync(markPath(home, id))).toBe(false)
  })
})
