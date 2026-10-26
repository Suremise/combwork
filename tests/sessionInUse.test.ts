// Archiving and deleting sessions checks nothing has them in use (#239): running in any window, a CLI still writing
// the transcript, Hive reading it or showing it in another window, or another program holding the CLI's transcript or
// Hive's copy open. Each session is all or nothing (a failure after the first move or trash puts everything back), and
// a bulk action skips those in use and says why. The CLI's own transcripts are never touched. Sub-sessions are found
// for old adopted records too, and in the folders of worktree agents.
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import type { SessionBulkProgress } from '../src/shared/types'

const base = tempDir('hive-inuse-')
// The CLIs' homes are the test's (never ~/.claude or ~/.codex).
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
process.env.CODEX_HOME = join(base, 'codex-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// The Recycle Bin, as deleting the file; `failTrash` makes it fail for a file, as it does for one in use.
const trashed: string[] = []
let failTrash: ((p: string) => boolean) | null = null
;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (p) => {
  if (failTrash?.(p)) throw Object.assign(new Error('The process cannot access the file because it is being used by another process.'), { code: 'EBUSY' })
  rmSync(p, { recursive: true, force: true })
  trashed.push(p)
}

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { sessions, SessionInUse } = await import('../src/main/sessions')
// What a delete does under its lock before the copies go: record what the session used (#1106).
const { usageHistory } = await import('../src/main/usageHistory')
const { setViewing, whileReading } = await import('../src/main/transcriptReads')
const { encodeProjectPath } = await import('../src/main/providers/claude/usage')
const { onHiveEvent } = await import('../src/main/events')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'proj')
const cli = join(base, 'cli')
const s = sessions as unknown as { live: Map<string, unknown>; noteExit: (id: string) => void }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
let n = 0
const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const old = new Date(Date.now() - 3600_000)
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 15000

const transcript = (sid: string): string =>
  [
    { type: 'user', sessionId: sid, timestamp: old.toISOString(), message: { role: 'user', content: 'Task' } },
    { type: 'assistant', sessionId: sid, requestId: 'r1', timestamp: old.toISOString(), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, output_tokens: 50 } } }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
const write = (file: string, text: string, at: Date = old): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
  utimesSync(file, at, at)
}
const backup = (id: string, archived = false): string => join(p, '.hive', archived ? 'archive' : 'sessions', `${id}.jsonl`)
const cliFile = (id: string): string => join(cli, `${id}.jsonl`)

/** One of Hive's sessions: its record, Hive's backup and the CLI's transcript (written long ago unless `at`). */
async function session(opts: { archivedCopy?: boolean; at?: Date } = {}): Promise<string> {
  const id = newId()
  await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', name: id, lastActiveAt: old.toISOString() }))
  write(backup(id), transcript(id))
  if (opts.archivedCopy) write(backup(id, true), transcript(id))
  write(cliFile(id), transcript(id), opts.at)
  return id
}
const records = async (): Promise<string[]> => (await run(() => workspace.sessionsFile(p))).sessions.map((r) => r.id)

/** Holds a file open the way an editor or a virus scanner can: no sharing, so it can't be moved or deleted. */
const holders: ChildProcess[] = []
async function hold(file: string): Promise<void> {
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 60`
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  holders.push(child)
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the file was not held in time')), 20000)
    child.stdout!.on('data', (d) => {
      if (String(d).includes('held')) {
        clearTimeout(t)
        resolve()
      }
    })
    child.on('exit', () => reject(new Error('the holder exited')))
  })
}

// The real lookup, for the tests that find transcripts in the CLIs' (test) homes; the others use a folder of the test's.
const realTranscript = sessions.providerTranscript.bind(sessions)
const cliLookup = vi.spyOn(sessions, 'providerTranscript')
const fakeLookup = async (_p: string, id: string) => (existsSync(cliFile(id)) ? { path: cliFile(id), provider: 'claude-code' as const } : null)

describe.runIf(process.platform === 'win32')('archiving and deleting sessions in use', () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'c1', name: 'Agent 1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    // The CLI's transcripts, from a folder of the test's (never ~/.claude).
    cliLookup.mockImplementation(fakeLookup)
  })
  beforeEach(async () => {
    trashed.length = 0
    failTrash = null
    await w.mutateSessions(p, (f) => {
      f.sessions = []
      f.deleted = []
      f.deletedUsage = []
    })
  })
  afterEach(() => {
    cliLookup.mockImplementation(fakeLookup)
    s.live.clear()
    for (const h of holders.splice(0)) h.kill()
  })
  afterAll(async () => {
    cliLookup.mockRestore()
    await disposeWorkspaceService(w)
  })

  it('a copy another program holds stops the delete before any copy goes (all or nothing)', async () => {
    const id = await session({ archivedCopy: true })
    // Both copies exist; the second one moved (the archive's) is held.
    await hold(backup(id, true))
    const err = await run(() => sessions.delete(p, id)).catch((e) => e)
    expect(err).toBeInstanceOf(SessionInUse)
    expect(err.reason).toBe('in-use')
    expect(trashed).toEqual([])
    expect(existsSync(backup(id))).toBe(true)
    expect(existsSync(backup(id, true))).toBe(true)
    expect(existsSync(`${backup(id)}.moving`)).toBe(false)
    expect(await records()).toContain(id)
    expect(existsSync(cliFile(id))).toBe(true)
  })

  it('archiving a session whose copy is held changes nothing', async () => {
    const id = await session()
    await hold(backup(id))
    const err = await run(() => sessions.archive(p, id, true)).catch((e) => e)
    expect(err).toBeInstanceOf(SessionInUse)
    expect(existsSync(backup(id))).toBe(true)
    expect(existsSync(backup(id, true))).toBe(false)
    expect((await run(() => workspace.sessionsFile(p))).sessions.find((r) => r.id === id)?.archived).toBe(false)
  })

  it('Delete all skips what is in use, says why, and deletes the rest; later items go on after a skipped one', async () => {
    const live = await session()
    const held = await session()
    // Started outside Hive, its CLI still writing it (a Codex guardian review still going, say).
    const writing = newId()
    write(cliFile(writing), transcript(writing), new Date())
    const reading = await session()
    const free1 = await session()
    const free2 = await session()
    // Running in another window's workspace: still running.
    s.live.set(`d:\\elsewhere#c9`, { state: { provider: 'claude-code', runId: 'run-x', projectPath: 'D:\\elsewhere', agentId: 'c9', sessionId: live, status: 'ready' } })
    await hold(backup(held))
    let release!: () => void
    const reader = whileReading(p, reading, () => new Promise<void>((r) => (release = r)))
    const r = await run(() => sessions.bulk(p, 'delete', [live, held, writing, reading, free1, free2, '../not-an-id']))
    release()
    await reader
    expect(r.done.sort()).toEqual([free1, free2].sort())
    const why = Object.fromEntries(r.skipped.map((x) => [x.id, x.reason]))
    expect(why).toEqual({ [live]: 'live', [held]: 'in-use', [writing]: 'in-use', [reading]: 'reading', '../not-an-id': 'failed' })
    expect(await records()).toEqual(expect.arrayContaining([live, held, reading]))
    expect((await run(() => workspace.sessionsFile(p))).deleted).not.toContain(writing)
    expect(await records()).not.toContain(free1)
    const file = await run(() => workspace.sessionsFile(p))
    expect(file.deleted).toEqual(expect.arrayContaining([free1, free2]))
    // Totals keep what the deleted ones used (the usage history, #1106).
    const kept = (await run(() => sessions.keptUsage(p))).map((k) => k.id)
    expect([live, held, writing, reading, free1, free2].filter((id) => kept.includes(id)).sort()).toEqual([free1, free2].sort())
    // The CLI's own transcripts stay.
    for (const id of [live, held, writing, reading, free1, free2]) expect(existsSync(cliFile(id))).toBe(true)
  })

  it("one of Hive's sessions whose CLI Hive saw exit archives at once; one written just now by a CLI Hive doesn't run waits", async () => {
    const id = await session({ at: new Date() })
    // Adopted, and resumed in a terminal: written a moment ago, and Hive never saw that CLI.
    expect(await run(() => sessions.archive(p, id, true)).catch((e) => e.reason)).toBe('in-use')
    // Hive ran it, and saw its CLI exit (Archive and Start New archives one just stopped).
    s.noteExit(id)
    await run(() => sessions.archive(p, id, true))
    // Archived copies are compressed (#1110).
    expect(existsSync(backup(id, true) + '.gz')).toBe(true)
    const r = await run(() => sessions.bulk(p, 'delete', [id]))
    expect(r.done).toEqual([id])
  })

  it('a session that starts while the delete waits is kept', async () => {
    const id = await session()
    // It starts after the first check, while its usage is recorded under the lock.
    const usage = vi.spyOn(usageHistory, 'recordNow').mockImplementation(async () => {
      s.live.set(`${p.toLowerCase()}#c1`, { state: { provider: 'claude-code', runId: 'run-y', projectPath: p, agentId: 'c1', sessionId: id, status: 'starting' } })
      return true
    })
    const r = await run(() => sessions.bulk(p, 'delete', [id]))
    usage.mockRestore()
    expect(r.skipped).toEqual([{ id, reason: 'live' }])
    expect(existsSync(backup(id))).toBe(true)
    expect(await records()).toContain(id)
  })

  it("Archive all skips sessions started outside Hive (Hive has nothing of theirs to keep) and unarchives what's archived", async () => {
    const mine = await session()
    const outside = newId()
    write(cliFile(outside), transcript(outside))
    const r = await run(() => sessions.bulk(p, 'archive', [mine, outside]))
    expect(r).toEqual({ done: [mine], skipped: [{ id: outside, reason: 'external' }] })
    expect(existsSync(backup(mine, true) + '.gz')).toBe(true)
    expect(await records()).not.toContain(outside)
    const back = await run(() => sessions.bulk(p, 'unarchive', [mine]))
    expect(back.done).toEqual([mine])
    expect(existsSync(backup(mine) + '.gz')).toBe(true)
  })

  it('a bulk action tells the windows how far it has got, ending with none, works on a few at once, and answers in the order asked (#1659)', async () => {
    const mine = [await session(), await session(), await session(), await session(), await session(), await session(), await session()]
    const outside = newId()
    write(cliFile(outside), transcript(outside))
    const ids = [mine[0], outside, ...mine.slice(1), '../not-an-id']
    const seen: SessionBulkProgress[][] = []
    const off = onHiveEvent((e) => {
      if (e.type === 'session-bulk' && e.projectPath === p) seen.push(e.runs)
    })
    let at = 0
    let most = 0
    const archive = sessions.archive.bind(sessions)
    const counted = vi.spyOn(sessions, 'archive').mockImplementation(async (...a) => {
      most = Math.max(most, ++at)
      try {
        return await archive(...a)
      } finally {
        at--
      }
    })
    try {
      const r = await run(() => sessions.bulk(p, 'archive', ids))
      expect(r.done).toEqual(mine)
      expect(r.skipped.map((x) => [x.id, x.reason])).toEqual([
        [outside, 'external'],
        ['../not-an-id', 'failed']
      ])
    } finally {
      off()
      counted.mockRestore()
    }
    expect(most).toBeGreaterThan(0)
    expect(most).toBeLessThanOrEqual(4)
    expect(seen[0]).toEqual([{ id: expect.any(Number), action: 'archive', done: 0, total: ids.length }])
    expect(seen.at(-2)).toEqual([{ id: seen[0][0].id, action: 'archive', done: ids.length, total: ids.length }])
    expect(seen.at(-1)).toEqual([])
    const counts = seen.slice(0, -1).map((x) => x[0].done)
    expect(counts).toEqual([...counts].sort((a, b) => a - b))
  })

  it("a bulk action that ends while another runs on the same host leaves the other's progress shown (#1659)", async () => {
    const held = [await session(), await session()]
    const outside = newId()
    write(cliFile(outside), transcript(outside))
    const seen: SessionBulkProgress[][] = []
    const off = onHiveEvent((e) => {
      if (e.type === 'session-bulk' && e.projectPath === p) seen.push(e.runs)
    })
    // The long one's archives wait until released: it is still running when the short one ends.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const archive = sessions.archive.bind(sessions)
    const waiting = vi.spyOn(sessions, 'archive').mockImplementation(async (...a) => {
      await gate
      return archive(...a)
    })
    try {
      const long = run(() => sessions.bulk(p, 'archive', held))
      await vi.waitFor(() => expect(seen.at(-1)?.length).toBe(1), { timeout: HUNG_MS })
      const longId = seen.at(-1)![0].id
      // A second one, quickly skipped (started outside Hive): it ends first.
      const short = await run(() => sessions.bulk(p, 'archive', [outside]))
      expect(short.skipped).toEqual([{ id: outside, reason: 'external' }])
      expect(seen.at(-1)).toEqual([{ id: longId, action: 'archive', done: 0, total: 2 }])
      release()
      expect((await long).done).toEqual(held)
      expect(seen.at(-1)).toEqual([])
    } finally {
      release()
      off()
      waiting.mockRestore()
    }
  })

  it('a delete that fails after a copy went to the Recycle Bin puts that copy back, and keeps the record', async () => {
    const id = await session({ archivedCopy: true })
    // The second copy (the archive's) fails to go, after the first has gone.
    failTrash = (f) => f.toLowerCase() === backup(id, true).toLowerCase()
    const r = await run(() => sessions.bulk(p, 'delete', [id]))
    expect(r.skipped).toEqual([{ id, reason: 'in-use' }])
    expect(trashed.map((t) => t.toLowerCase())).toEqual([backup(id).toLowerCase()])
    expect(existsSync(backup(id))).toBe(true)
    expect(existsSync(backup(id, true))).toBe(true)
    expect(existsSync(`${backup(id)}.spare`)).toBe(false)
    expect(await records()).toContain(id)
    expect((await run(() => workspace.sessionsFile(p))).deleted ?? []).not.toContain(id)
  })

  it('an archive that fails after its copies moved puts them back, and the record stays unarchived', async () => {
    const id = await session()
    const save = vi.spyOn(w, 'upsertSession').mockRejectedValueOnce(new Error('disk full'))
    const err = await run(() => sessions.archive(p, id, true)).catch((e) => e)
    save.mockRestore()
    expect(String(err)).toMatch(/disk full/)
    expect(existsSync(backup(id))).toBe(true)
    expect(existsSync(backup(id, true))).toBe(false)
    expect(existsSync(`${backup(id, true)}.archiving`)).toBe(false)
    expect((await run(() => workspace.sessionsFile(p))).sessions.find((r) => r.id === id)?.archived).toBe(false)
  })

  it("a CLI transcript another program holds keeps the session (external, adopted, or archived), and isn't changed", async () => {
    const outside = newId()
    write(cliFile(outside), transcript(outside))
    const adopted = await session()
    const archiving = await session()
    await hold(cliFile(outside))
    await hold(cliFile(adopted))
    await hold(cliFile(archiving))
    const r = await run(() => sessions.bulk(p, 'delete', [outside, adopted]))
    expect(r.done).toEqual([])
    expect(Object.fromEntries(r.skipped.map((x) => [x.id, x.reason]))).toEqual({ [outside]: 'in-use', [adopted]: 'in-use' })
    expect((await run(() => workspace.sessionsFile(p))).deleted ?? []).not.toContain(outside)
    expect((await run(() => sessions.bulk(p, 'archive', [archiving]))).skipped).toEqual([{ id: archiving, reason: 'in-use' }])
    expect(existsSync(backup(archiving))).toBe(true)
    expect(existsSync(backup(archiving, true))).toBe(false)
  })

  it('a transcript open in a Sessions view, in any window, is skipped; once the view closes it goes', async () => {
    const id = await session()
    setViewing(7, 'v1', p, id)
    expect((await run(() => sessions.bulk(p, 'delete', [id]))).skipped).toEqual([{ id, reason: 'open' }])
    expect((await run(() => sessions.bulk(p, 'archive', [id]))).skipped).toEqual([{ id, reason: 'open' }])
    expect(await run(() => sessions.delete(p, id)).catch((e) => e.reason)).toBe('open')
    // The view closes (the window asking closes its own first): now it goes.
    setViewing(7, 'v1', null, null)
    expect((await run(() => sessions.bulk(p, 'delete', [id]))).done).toEqual([id])
  })

  it("a view can't open on a session while it is being archived or deleted", async () => {
    const id = await session()
    const { transcripts } = await import('../src/main/transcripts')
    let during: unknown = null
    const usage = vi.spyOn(usageHistory, 'recordNow').mockImplementation(async () => {
      during = await run(async () => transcripts.viewing(7, 'v2', p, id)).catch((e) => e)
      return true
    })
    const r = await run(() => sessions.bulk(p, 'delete', [id]))
    usage.mockRestore()
    expect(String(during)).toMatch(/being archived or deleted/)
    expect(r.done).toEqual([id])
  })

  it("nothing reads a session's transcript while it is being deleted", async () => {
    const id = await session()
    const { transcripts } = await import('../src/main/transcripts')
    let during: unknown = null
    const usage = vi.spyOn(usageHistory, 'recordNow').mockImplementation(async () => {
      during = await run(() => transcripts.read(p, id)).catch((e) => e)
      return true
    })
    await run(() => sessions.bulk(p, 'delete', [id]))
    usage.mockRestore()
    expect(String(during)).toMatch(/being archived or deleted/)
  })

  it('an adopted guardian review from before sub-sessions is found, kept on its record, and never resumed', async () => {
    const parent = await session()
    const id = newId()
    await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', name: 'Adopted review', lastActiveAt: new Date().toISOString() }))
    const side = transcript(id).replace(/"sessionId":"[^"]+"/g, `"isSidechain":true,"sessionId":"${parent}"`)
    write(join(process.env.CLAUDE_CONFIG_DIR!, 'projects', encodeProjectPath(p), `${id}.jsonl`), side)
    const item = (await run(() => sessions.list(p))).find((x) => x.id === id)
    expect(item?.sub).toEqual({ parentId: parent, kind: 'sub-agent' })
    expect((await run(() => workspace.sessionsFile(p))).sessions.find((r) => r.id === id)?.sub).toEqual({ parentId: parent, kind: 'sub-agent' })
    // The newest record, but never the agent's session to resume: its parent is.
    const info = await run(async () => sessions.liveInfo(p, await workspace.projectConfig(p)))
    expect(info.agents[0].resume?.id).toBe(parent)
  })

  it("a sub-session of a session that ran in a worktree is listed under it; that folder's other sessions aren't", async () => {
    const wt = join(base, 'wt-coder')
    const parent = newId()
    await run(() => workspace.upsertSession(p, { id: parent, agent: 'claude-code', name: 'Worktree work', cwd: wt, lastActiveAt: old.toISOString() }))
    const child = newId()
    const stranger = newId()
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', encodeProjectPath(wt))
    write(join(dir, `${child}.jsonl`), transcript(child).replace(/"sessionId":"[^"]+"/g, `"isSidechain":true,"sessionId":"${parent}"`))
    write(join(dir, `${stranger}.jsonl`), transcript(stranger))
    const list = await run(() => sessions.list(p))
    expect(list.find((x) => x.id === child)?.sub).toEqual({ parentId: parent, kind: 'sub-agent' })
    expect(list.some((x) => x.id === stranger)).toBe(false)
  })

  it("a sub-session found in a removed agent's old worktree is read, searched and checked from there, like any other", async () => {
    cliLookup.mockImplementation(realTranscript)
    const { transcripts } = await import('../src/main/transcripts')
    // The worktree's agent is gone (project.json has none there); only the parent's record says where it ran.
    const wt = join(base, 'wt-removed')
    const parent = newId()
    await run(() => workspace.upsertSession(p, { id: parent, agent: 'claude-code', name: 'Old worktree work', cwd: wt, agentId: 'a-gone', agentName: 'Gone', lastActiveAt: old.toISOString() }))
    const child = newId()
    const file = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', encodeProjectPath(wt), `${child}.jsonl`)
    write(file, transcript(child).replace(/"sessionId":"[^"]+"/g, `"isSidechain":true,"sessionId":"${parent}"`).replace('Task', 'Check the unicorn parser'))
    expect((await run(() => sessions.list(p))).find((x) => x.id === child)?.hasTranscript).toBe(true)
    const read = await run(() => transcripts.read(p, child))
    expect(read?.items.some((i) => i.kind === 'user' && /unicorn/.test(i.text))).toBe(true)
    const hits = await run(() => transcripts.search(p, 'unicorn', null))
    expect(hits.map((h) => h.sessionId)).toContain(child)
    await hold(file)
    expect((await run(() => sessions.bulk(p, 'delete', [child]))).skipped).toEqual([{ id: child, reason: 'in-use' }])
    for (const h of holders.splice(0)) h.kill()
  })

  it("the Assistant's sub-sessions, from the workspace folder it runs in, are listed and read", async () => {
    cliLookup.mockImplementation(realTranscript)
    const { transcripts } = await import('../src/main/transcripts')
    const home = join(wsPath, '.hive', 'assistant')
    const parent = newId()
    await run(() => workspace.upsertSession(home, { id: parent, agent: 'claude-code', name: 'Overseeing', lastActiveAt: old.toISOString() }))
    const child = newId()
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', encodeProjectPath(wsPath))
    write(join(dir, `${child}.jsonl`), transcript(child).replace(/"sessionId":"[^"]+"/g, `"isSidechain":true,"sessionId":"${parent}"`).replace('Task', 'Survey the projects'))
    // A conversation someone had in a terminal in the workspace folder isn't the Assistant's.
    const stranger = newId()
    write(join(dir, `${stranger}.jsonl`), transcript(stranger))
    const list = await run(() => sessions.list(home))
    expect(list.find((x) => x.id === child)?.sub?.parentId).toBe(parent)
    expect(list.some((x) => x.id === stranger)).toBe(false)
    const read = await run(() => transcripts.read(home, child))
    expect(read?.items.some((i) => i.kind === 'user' && /Survey/.test(i.text))).toBe(true)
  })

  it('refuses a folder outside the workspace and an unknown action', async () => {
    await expect(run(() => sessions.bulk(join(base, 'elsewhere'), 'delete', [newId()]))).rejects.toThrow()
    await expect(run(() => sessions.bulk(p, 'wipe' as never, [newId()]))).rejects.toThrow(/Unknown action/)
    await expect(run(() => sessions.bulk(p, 'delete', 'x' as never))).rejects.toThrow(/list/)
  })
})
