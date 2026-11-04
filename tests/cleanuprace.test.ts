// Clean Up… while the sessions change: a session unarchived or resumed between the preview and the removal keeps
// its files, and nothing goes without what it used recorded in the usage history first (#1106: so totals survive the
// CLI's copy going).
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { DEFAULT_CLEANUP } from '../src/shared/storage'
import type { CleanupOptions } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-cleanup-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// The Recycle Bin, as deleting the file.
;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (p) => rmSync(p, { recursive: true, force: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { cleanup, cleanupPreview } = await import('../src/main/storage')
const { usageHistory } = await import('../src/main/usageHistory')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'clean')
const cli = join(base, 'cli')
const s = sessions as unknown as { live: Map<string, unknown> }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString()
let n = 0
const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

const transcript = (sid: string): string =>
  [
    { type: 'user', sessionId: sid, timestamp: ago(200), message: { role: 'user', content: 'Task' } },
    { type: 'assistant', sessionId: sid, requestId: 'r1', timestamp: ago(200), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 } } }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
const write = (file: string, text: string): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}
const archived = (id: string): string => join(p, '.combwork', 'archive', `${id}.jsonl`)
const active = (id: string): string => join(p, '.combwork', 'sessions', `${id}.jsonl`)
const attachments = (id: string): string => join(p, '.combwork', 'attachments', id)

/** An archived session 200 days old with a backup and attachments; `inCli`: the CLI still has its transcript. */
async function oldSession(inCli: boolean): Promise<string> {
  const id = newId()
  await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', name: id, archived: true, lastActiveAt: ago(200) }))
  write(archived(id), transcript(id))
  write(join(attachments(id), 'a.png'), 'png')
  if (inCli) write(join(cli, `${id}.jsonl`), transcript(id))
  return id
}

// The CLI's transcripts, from a folder of the test's (never ~/.claude).
const realTranscript = sessions.providerTranscript.bind(sessions)
const cliLookup = vi.spyOn(sessions, 'providerTranscript')
const lookup = async (_p: string, id: string) => (existsSync(join(cli, `${id}.jsonl`)) ? { path: join(cli, `${id}.jsonl`), provider: 'claude-code' as const } : null)

/**
 * Runs `meanwhile` while Clean Up is between its plan and the removal: paused in its last lookup of the session's CLI
 * copy before the removal (its plan's).
 */
async function cleanupWith(target: string, opts: CleanupOptions, meanwhile: () => Promise<void>) {
  const listed = (await run(() => cleanupPreview(p, opts))).map((i) => i.path)
  let calls = 0
  cliLookup.mockImplementation(async (pp, id) => {
    if (id === target && calls++ === 0) await meanwhile()
    return lookup(pp, id)
  })
  const result = await run(() => cleanup(p, opts, listed))
  cliLookup.mockImplementation(lookup)
  return { listed, result }
}
/** Recording what this session used fails (the others' still works). */
const realRecord = usageHistory.recordNow.bind(usageHistory)
const failUsage = (target: string, fail: () => Promise<boolean>) =>
  vi.spyOn(usageHistory, 'recordNow').mockImplementation((pp, id) => (id === target ? fail() : realRecord(pp, id)))
const totalTokens = async (id: string): Promise<number | undefined> => {
  const u = await run(() => sessions.usage(p, id))
  return u ? u.inputTokens + u.outputTokens : undefined
}

describe('Clean Up while sessions change', () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'c1', name: 'Agent 1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    cliLookup.mockImplementation(lookup)
  })
  // Each test starts from no sessions, so what Clean Up does is only to the test's own.
  beforeEach(async () => {
    for (const d of ['archive', 'sessions', 'attachments']) rmSync(join(p, '.combwork', d), { recursive: true, force: true })
    await w.mutateSessions(p, (f) => {
      f.sessions = []
      f.deleted = []
      f.deletedUsage = []
    })
  })
  afterEach(() => {
    s.live.clear()
    vi.mocked(w.mutateSessions).mockRestore?.()
  })
  afterAll(async () => {
    cliLookup.mockImplementation(realTranscript)
    await disposeWorkspaceService(w)
  })

  it('a session unarchived meanwhile keeps its backup (now the active one) and attachments', async () => {
    const id = await oldSession(true)
    const { listed, result } = await cleanupWith(id, { ...DEFAULT_CLEANUP, archivedBackupsDays: 90 }, () => run(() => sessions.archive(p, id, false)))
    expect(listed.some((l) => l.toLowerCase() === archived(id).toLowerCase())).toBe(true)
    // Compressed again once unarchived (#1110).
    expect(existsSync(active(id) + '.gz')).toBe(true)
    expect(existsSync(join(attachments(id), 'a.png'))).toBe(true)
    expect(result.skipped.join('\n')).toMatch(/no longer archived/)
  })

  it('a session resumed meanwhile keeps its backup and attachments', async () => {
    const id = await oldSession(true)
    const { result } = await cleanupWith(id, { ...DEFAULT_CLEANUP, archivedBackupsDays: 90 }, async () => {
      s.live.set(`${p.toLowerCase()}#c1`, { state: { provider: 'claude-code', runId: 'run-x', projectPath: p, agentId: 'c1', sessionId: id, status: 'ready' } })
    })
    expect([existsSync(archived(id)), existsSync(join(attachments(id), 'a.png'))]).toEqual([true, true])
    expect(result.skipped.join('\n')).toMatch(/running/)
  })

  it('a copy published meanwhile that the preview did not list: the session keeps both', async () => {
    const id = await oldSession(true)
    const { result } = await cleanupWith(id, { ...DEFAULT_CLEANUP, archivedAttachmentsDays: null, archivedBackupsDays: 90 }, async () => write(active(id), transcript(id)))
    expect([existsSync(archived(id)), existsSync(active(id))]).toEqual([true, true])
    expect(result.skipped.join('\n')).toMatch(/copies changed/)
  })

  it("a backup whose usage can't be read is kept, and its totals survive the CLI's copy going", async () => {
    const id = await oldSession(true)
    const before = await totalTokens(id)
    const usage = failUsage(id, async () => false)
    const { result } = await cleanupWith(id, { ...DEFAULT_CLEANUP, archivedAttachmentsDays: null, archivedBackupsDays: 90 }, async () => undefined)
    usage.mockRestore()
    expect(result.skipped.join('\n')).toMatch(/couldn't read what the session used/)
    expect(existsSync(archived(id))).toBe(true)
    rmSync(join(cli, `${id}.jsonl`))
    expect(await totalTokens(id)).toBe(before)
  })

  it('a session whose only copy is Hive’s is not deleted when its usage read throws', async () => {
    const id = await oldSession(false)
    const usage = failUsage(id, async () => {
      throw new Error('EBUSY')
    })
    const { result } = await cleanupWith(id, { ...DEFAULT_CLEANUP, archivedAttachmentsDays: null, goneBackups: true }, async () => undefined)
    usage.mockRestore()
    expect(result.skipped.join('\n')).toMatch(/couldn't read what the session used/)
    expect(existsSync(archived(id))).toBe(true)
    expect((await run(() => workspace.sessionsFile(p))).sessions.some((r) => r.id === id)).toBe(true)
  })

  it('unchanged sessions go, and their totals stay once the CLI drops its copy', async () => {
    const kept = await oldSession(true)
    const gone = await oldSession(false)
    const before = [await totalTokens(kept), await totalTokens(gone)]
    const { listed, result } = await cleanupWith(kept, { ...DEFAULT_CLEANUP, archivedBackupsDays: 90, goneBackups: true }, async () => undefined)
    expect(result.skipped).toEqual([])
    expect(result.removed).toBe(listed.length)
    expect([existsSync(archived(kept)), existsSync(archived(gone)), existsSync(attachments(kept))]).toEqual([false, false, false])
    rmSync(join(cli, `${kept}.jsonl`))
    // The deleted one's usage is in the history, as a deleted session's.
    expect((await run(() => sessions.keptUsage(p))).find((k) => k.id === gone)?.usage?.outputTokens).toBe(50)
    expect(await totalTokens(kept)).toBe(before[0])
    expect(before.every((t) => t && t > 0)).toBe(true)
  })
  /** Resumed while Clean Up records what it used (after its first check). */
  const resumeDuringUsage = (id: string) =>
    vi.spyOn(usageHistory, 'recordNow').mockImplementation(async (pp, i) => {
      const u = await realRecord(pp, i)
      if (i === id) s.live.set(`${p.toLowerCase()}#c1`, { state: { provider: 'claude-code', runId: 'run-y', projectPath: p, agentId: 'c1', sessionId: id, status: 'starting' } })
      return u
    })

  it('a session resumed while its usage is read keeps its backup (both clean-up kinds)', async () => {
    for (const inCli of [true, false]) {
      s.live.clear()
      const id = await oldSession(inCli)
      const usage = resumeDuringUsage(id)
      const { result } = await cleanupWith(id, { ...DEFAULT_CLEANUP, archivedAttachmentsDays: null, archivedBackupsDays: 90, goneBackups: true }, async () => undefined)
      usage.mockRestore()
      expect(existsSync(archived(id))).toBe(true)
      expect(result.skipped.join('\n')).toMatch(/running/)
      expect((await run(() => workspace.sessionsFile(p))).sessions.some((r) => r.id === id)).toBe(true)
    }
  })

  it("can't be resumed while Clean Up removes its files", async () => {
    const id = await oldSession(true)
    let refused = ''
    const usage = vi.spyOn(usageHistory, 'recordNow').mockImplementation(async (pp, i) => {
      if (i === id) refused = await run(() => sessions.start(p, { agentId: 'c1', resumeId: id })).then(() => 'started', (e: Error) => e.message)
      return realRecord(pp, i)
    })
    await cleanupWith(id, { ...DEFAULT_CLEANUP, archivedBackupsDays: 90 }, async () => undefined)
    usage.mockRestore()
    expect(refused).toMatch(/archiving, deleting or cleaning up this session's files/)
    expect(existsSync(archived(id))).toBe(false)
  })

  it("a session's only copy stays when what it used can't be saved", async () => {
    const id = await oldSession(false)
    const before = await totalTokens(id)
    const real = w.mutateSessions.bind(w)
    vi.spyOn(w, 'mutateSessions').mockImplementation(() => Promise.reject(new Error('EIO')))
    const { result } = await cleanupWith(id, { ...DEFAULT_CLEANUP, archivedAttachmentsDays: null, goneBackups: true }, async () => undefined)
    vi.mocked(w.mutateSessions).mockImplementation(real)
    expect(result.skipped.join('\n')).toMatch(/EIO/)
    expect(existsSync(archived(id))).toBe(true)
    expect(await totalTokens(id)).toBe(before)
  })

  it('a deletion that fails after its copy went puts the copy back (all or nothing) and still counts what the session used', async () => {
    const id = await oldSession(false)
    const before = await totalTokens(id)
    const real = w.mutateSessions.bind(w)
    let calls = 0
    // Deleting the record fails (what it used is in the usage history by then).
    vi.spyOn(w, 'mutateSessions').mockImplementation((pp, fn) => (++calls === 1 ? Promise.reject(new Error('EIO')) : real(pp, fn)))
    const { result } = await cleanupWith(id, { ...DEFAULT_CLEANUP, archivedAttachmentsDays: null, goneBackups: true }, async () => undefined)
    vi.mocked(w.mutateSessions).mockImplementation(real)
    expect(result.skipped.join('\n')).toMatch(/EIO/)
    expect(existsSync(archived(id))).toBe(true)
    expect(await totalTokens(id)).toBe(before)
  })
})
