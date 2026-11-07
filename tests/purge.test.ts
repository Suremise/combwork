// Purge… (#1138): everything Combwork keeps per session goes as the preview listed it, for a session, a project or the
// workspace; the CLIs' files, running sessions and the usage history stay, so totals never change; and what changes
// between the preview and the removal (a session resumed, viewed, given a new copy, its CLI copy back or gone) is left
// alone.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { PurgeTarget, SessionUsage } from '../src/shared/types'
import { tempDir } from './tempDir'
import { bound } from './keepType'

const base = tempDir('cw-purge-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// The Recycle Bin, as a folder of the test's: what went there can be told from what was deleted for good.
const bin = join(base, 'bin')
mkdirSync(bin, { recursive: true })
let binned = 0
;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (p) => renameSync(p, join(bin, `${++binned}`))

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { PREVIEW_MS, purge, purgePreview } = await import('../src/main/storage')
const { usageHistory } = await import('../src/main/usageHistory')
const { setViewing } = await import('../src/main/transcriptReads')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'purged')
const other = join(wsPath, 'other')
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
    { type: 'user', sessionId: sid, timestamp: ago(20), message: { role: 'user', content: 'Task' } },
    { type: 'assistant', sessionId: sid, requestId: 'r1', timestamp: ago(20), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 } } }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
const write = (file: string, text: string): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}
const active = (id: string, host = p): string => join(host, '.combwork', 'sessions', `${id}.jsonl`)
const archived = (id: string, host = p): string => join(host, '.combwork', 'archive', `${id}.jsonl`)
const attachments = (id: string, host = p): string => join(host, '.combwork', 'attachments', id)
const records = async (host = p) => (await run(() => workspace.sessionsFile(host))).sessions
const binCount = (): number => readdirSync(bin).length

/** A session of Combwork's with a backup and an attachment; `inCli`: the CLI still has its transcript. */
async function session(inCli: boolean, opts: { host?: string; archived?: boolean } = {}): Promise<string> {
  const host = opts.host ?? p
  const id = newId()
  await run(() => workspace.upsertSession(host, { id, agent: 'claude-code', name: `s${n}`, archived: !!opts.archived, lastActiveAt: ago(20) }))
  write(opts.archived ? archived(id, host) : active(id, host), transcript(id))
  write(join(attachments(id, host), 'a.png'), 'png')
  if (inCli) write(join(cli, `${id}.jsonl`), transcript(id))
  return id
}
const runningOn = (id: string, host = p): void => {
  s.live.set(`${host.toLowerCase()}#c1`, { state: { provider: 'claude-code', runId: 'run-x', projectPath: host, agentId: 'c1', sessionId: id, status: 'ready' } })
}

// The CLI's transcripts, from a folder of the test's (never ~/.claude).
const realTranscript = bound(sessions, sessions.providerTranscript)
const cliLookup = vi.spyOn(sessions, 'providerTranscript')
const lookup = async (_p: string, id: string) => (existsSync(join(cli, `${id}.jsonl`)) ? { path: join(cli, `${id}.jsonl`), provider: 'claude-code' as const } : null)
const realRecord = bound(usageHistory, usageHistory.recordNow)

/**
 * Previews, then purges what it listed; `meanwhile` runs between the two, in the removal's last lookup of the target
 * session's CLI copy before its files go (under its reservation and locks).
 */
async function purgeWith(target: PurgeTarget, opts: { permanent?: boolean; session?: string; meanwhile?: () => Promise<void>; before?: () => Promise<void> } = {}) {
  const preview = await run(() => purgePreview(target))
  await opts.before?.()
  let calls = 0
  cliLookup.mockImplementation(async (pp, id) => {
    // The plan's lookup is the first, sessions.purge's the second.
    if (id === opts.session && opts.meanwhile && ++calls === 2) await opts.meanwhile()
    return lookup(pp, id)
  })
  const result = await run(() => purge(preview.id, preview.items.map((i) => i.key), !!opts.permanent))
  cliLookup.mockImplementation(lookup)
  return { preview, result }
}
const project: PurgeTarget = { kind: 'project', projectPath: p }
const totalTokens = async (id: string): Promise<number | undefined> => {
  const u = (await run(() => sessions.usage(p, id))) ?? (await run(() => sessions.keptUsage(p))).find((k) => k.id === id)?.usage
  return u ? u.inputTokens + u.outputTokens : undefined
}
const reasons = (r: { skipped: { reason: string }[] }): string => r.skipped.map((x) => x.reason).join('\n')

describe('Purge', () => {
  beforeAll(async () => {
    for (const host of [p, other]) {
      mkdirSync(join(host, '.combwork'), { recursive: true })
      writeFileSync(join(host, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'c1', name: 'Agent 1' }] }))
    }
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    w = createWorkspaceService()
    await w.open(wsPath)
    cliLookup.mockImplementation(lookup)
  })
  // Each test starts from no sessions, so what Purge does is only to the test's own.
  beforeEach(async () => {
    for (const host of [p, other]) {
      for (const d of ['archive', 'sessions', 'attachments']) rmSync(join(host, '.combwork', d), { recursive: true, force: true })
      await w.mutateSessions(host, (f) => {
        f.sessions = []
        f.deleted = []
        f.deletedUsage = []
      })
    }
  })
  afterEach(() => {
    s.live.clear()
    // The test's own spies (the CLI lookup's stays).
    for (const m of [usageHistory.recordNow, usageHistory.recordKept, w.mutateSessions]) vi.mocked(m).mockRestore?.()
    cliLookup.mockImplementation(lookup)
  })
  afterAll(async () => {
    cliLookup.mockImplementation(realTranscript)
    await disposeWorkspaceService(w)
  })

  it("lists every file of Combwork's with its size, and removes exactly that to the Recycle Bin; the CLI's copy and the totals stay", async () => {
    const kept = await session(true)
    const arch = await session(true, { archived: true })
    const before = [await totalTokens(kept), await totalTokens(arch)]
    const { preview, result } = await purgeWith(project)
    expect(preview.items.map((i) => [i.kind, i.sessionId]).sort()).toEqual([['attachments', arch], ['attachments', kept], ['backup', arch], ['backup', kept]].sort())
    expect(preview.items.every((i) => i.bytes > 0 && !i.lastCopy)).toBe(true)
    expect(result).toMatchObject({ removed: 4, deleted: 0, skipped: [] })
    expect([existsSync(active(kept)), existsSync(archived(arch)), existsSync(attachments(kept)), existsSync(attachments(arch))]).toEqual([false, false, false, false])
    expect(binCount()).toBeGreaterThanOrEqual(4)
    // The records stay (the CLI still has them), and so do the CLI's transcripts and what the sessions used.
    expect((await records()).map((r) => r.id).sort()).toEqual([kept, arch].sort())
    expect([existsSync(join(cli, `${kept}.jsonl`)), existsSync(join(cli, `${arch}.jsonl`))]).toEqual([true, true])
    rmSync(join(cli, `${kept}.jsonl`))
    expect([await totalTokens(kept), await totalTokens(arch)]).toEqual(before)
  })

  it('deletes a session whose last copy goes, as Delete does, and still counts what it used', async () => {
    const id = await session(false)
    const before = await totalTokens(id)
    const { preview, result } = await purgeWith(project)
    expect(preview.items.find((i) => i.kind === 'backup')?.lastCopy).toBe(true)
    expect(result).toMatchObject({ deleted: 1, skipped: [] })
    expect(await records()).toEqual([])
    expect((await run(() => workspace.sessionsFile(p))).deleted).toContain(id)
    expect(await totalTokens(id)).toBe(before)
  })

  it('permanently: nothing goes to the Recycle Bin', async () => {
    const id = await session(true)
    const was = binCount()
    const { result } = await purgeWith(project, { permanent: true })
    expect(result).toMatchObject({ removed: 2, skipped: [] })
    expect([existsSync(active(id)), existsSync(attachments(id)), binCount()]).toEqual([false, false, was])
  })

  it("leaves running sessions alone, and says how many; what's left of deleted sessions goes", async () => {
    const live = await session(true)
    runningOn(live)
    const dead = newId()
    write(active(dead) + '.gz', 'gz')
    write(join(attachments(dead), 'b.txt'), 'b')
    write(join(p, '.combwork', 'attachments', 'run-abc', 'c.txt'), 'c')
    // Not Combwork's per session: left alone.
    write(join(p, '.combwork', 'sessions', 'notes.txt'), 'mine')
    const { preview, result } = await purgeWith(project)
    expect(preview.running).toBe(1)
    expect(preview.items.some((i) => i.sessionId === live)).toBe(false)
    expect(preview.items.map((i) => i.kind).sort()).toEqual(['leftover-backup', 'orphan-attachments', 'orphan-attachments'])
    expect(result.skipped).toEqual([])
    expect([existsSync(active(live)), existsSync(attachments(live)), existsSync(active(dead) + '.gz'), existsSync(attachments(dead)), existsSync(join(p, '.combwork', 'attachments', 'run-abc'))]).toEqual([true, true, false, false, false])
    expect(existsSync(join(p, '.combwork', 'sessions', 'notes.txt'))).toBe(true)
  })

  it("removes a session's leftover spare and half-made copies with it", async () => {
    const id = await session(true)
    write(active(id) + '.spare', 'x')
    write(active(id) + '.gz.123-456.tmp', 'x')
    const { preview, result } = await purgeWith(project)
    expect(preview.items.filter((i) => i.kind === 'leftover-backup').length).toBe(2)
    expect(result.skipped).toEqual([])
    expect(readdirSync(join(p, '.combwork', 'sessions'))).toEqual([])
  })

  it("drops old kept usage once the usage history has it, and the totals don't change", async () => {
    const id = await session(true)
    const usage = (await run(() => sessions.usage(p, id))) as SessionUsage
    // A record whose transcript went, kept only for its usage; and a deleted session's.
    const gone = newId()
    await run(() => workspace.upsertSession(p, { id: gone, agent: 'claude-code', name: 'gone', archived: true, lastActiveAt: ago(30), keptUsage: { ...usage, sessionId: gone } }))
    const del = newId()
    await w.mutateSessions(p, (f) => {
      f.deletedUsage = [{ id: del, provider: 'claude-code', name: 'deleted', usage: { ...usage, sessionId: del } }]
    })
    const before = [await totalTokens(gone), await totalTokens(del)]
    const { preview, result } = await purgeWith(project)
    expect(preview.items.filter((i) => i.kind === 'kept-usage' || i.kind === 'deleted-usage').map((i) => [i.kind, i.sessionId, !i.path])).toEqual([
      ['kept-usage', gone, true],
      ['deleted-usage', del, true]
    ])
    expect(result.skipped).toEqual([])
    const f = await run(() => workspace.sessionsFile(p))
    expect([f.sessions.find((r) => r.id === gone)?.keptUsage, f.deletedUsage ?? []]).toEqual([undefined, []])
    expect([await totalTokens(gone), await totalTokens(del)]).toEqual(before)
    expect(before.every((t) => t && t > 0)).toBe(true)
  })

  it("keeps old usage the history couldn't take", async () => {
    const id = newId()
    const usage = { sessionId: id, provider: 'claude-code', inputTokens: 5, outputTokens: 7 } as unknown as SessionUsage
    await w.mutateSessions(p, (f) => {
      f.deletedUsage = [{ id, provider: 'claude-code', name: 'deleted', usage }]
    })
    vi.spyOn(usageHistory, 'recordKept').mockResolvedValue(false)
    const { result } = await purgeWith(project)
    expect(reasons(result)).toMatch(/couldn't record it in the usage history/)
    expect((await run(() => workspace.sessionsFile(p))).deletedUsage?.map((k) => k.id)).toEqual([id])
  })

  it("a session's own purge touches only that session", async () => {
    const one = await session(true)
    const two = await session(true)
    const { preview, result } = await purgeWith({ kind: 'session', projectPath: p, sessionId: one })
    expect(new Set(preview.items.map((i) => i.sessionId))).toEqual(new Set([one]))
    expect(result.skipped).toEqual([])
    expect([existsSync(active(one)), existsSync(active(two)), existsSync(attachments(two))]).toEqual([false, true, true])
  })

  it("the workspace's covers each project", async () => {
    const a = await session(true)
    const b = await session(true, { host: other })
    const { preview, result } = await purgeWith({ kind: 'workspace' })
    expect(new Set(preview.items.map((i) => i.hostName))).toEqual(new Set(['purged', 'other']))
    expect(result.skipped).toEqual([])
    expect([existsSync(active(a)), existsSync(active(b, other))]).toEqual([false, false])
  })

  it('a session resumed before the removal keeps everything (it no longer qualifies)', async () => {
    const id = await session(false)
    const { result } = await purgeWith(project, { before: async () => runningOn(id) })
    expect(result.removed).toBe(0)
    expect(reasons(result)).toMatch(/no longer qualifies/)
    expect([existsSync(active(id)), existsSync(attachments(id)), (await records()).length]).toEqual([true, true, 1])
  })

  it('a session resumed while it is checked keeps everything', async () => {
    const id = await session(false)
    const { result } = await purgeWith(project, { session: id, meanwhile: async () => runningOn(id) })
    expect(reasons(result)).toMatch(/running/)
    expect([existsSync(active(id)), existsSync(attachments(id)), (await records()).length]).toEqual([true, true, 1])
  })

  it('a session resumed while what it used is recorded keeps everything', async () => {
    const id = await session(true)
    vi.spyOn(usageHistory, 'recordNow').mockImplementation(async (pp, i) => {
      const u = await realRecord(pp, i)
      if (i === id) runningOn(id)
      return u
    })
    const { result } = await purgeWith(project)
    expect(reasons(result)).toMatch(/running/)
    expect([existsSync(active(id)), existsSync(attachments(id))]).toEqual([true, true])
  })

  it("can't be resumed while its files go", async () => {
    const id = await session(true)
    let refused = ''
    vi.spyOn(usageHistory, 'recordNow').mockImplementation(async (pp, i) => {
      if (i === id) refused = await run(() => sessions.start(p, { agentId: 'c1', resumeId: id })).then(() => 'started', (e: Error) => e.message)
      return realRecord(pp, i)
    })
    const { result } = await purgeWith(project)
    expect(refused).toMatch(/archiving, deleting or cleaning up this session's files/)
    expect(result.skipped).toEqual([])
    expect(existsSync(active(id))).toBe(false)
  })

  it("a session whose last copy is open in Combwork is left alone; one the view reads from the CLI's copy is purged", async () => {
    const last = await session(false)
    const cliHas = await session(true)
    setViewing(7, 'v1', p, last)
    setViewing(7, 'v2', p, cliHas)
    try {
      const { result } = await purgeWith(project)
      expect(reasons(result)).toMatch(/open in Combwork/)
      expect([existsSync(active(last)), existsSync(attachments(last)), (await records()).some((r) => r.id === last)]).toEqual([true, true, true])
      expect([existsSync(active(cliHas)), existsSync(attachments(cliHas))]).toEqual([false, false])
    } finally {
      setViewing(7, 'v1', null, null)
      setViewing(7, 'v2', null, null)
    }
  })

  it('a copy made meanwhile that the preview did not list: the session keeps both', async () => {
    const id = await session(true)
    const { result } = await purgeWith(project, { session: id, meanwhile: async () => write(archived(id), transcript(id)) })
    expect(reasons(result)).toMatch(/copies changed/)
    expect([existsSync(active(id)), existsSync(archived(id))]).toEqual([true, true])
  })

  it("the CLI's copy back or gone since the preview: the session is left alone", async () => {
    const back = await session(false)
    let r = await purgeWith(project, { session: back, meanwhile: async () => write(join(cli, `${back}.jsonl`), transcript(back)) })
    expect(reasons(r.result)).toMatch(/has this session's transcript again/)
    expect([existsSync(active(back)), (await records()).length]).toEqual([true, 1])
    const gone = await session(true)
    r = await purgeWith({ kind: 'session', projectPath: p, sessionId: gone }, { session: gone, meanwhile: async () => rmSync(join(cli, `${gone}.jsonl`)) })
    expect(reasons(r.result)).toMatch(/no longer has this session's transcript/)
    expect(existsSync(active(gone))).toBe(true)
  })

  it("keeps a session whose usage can't be recorded", async () => {
    const id = await session(false)
    vi.spyOn(usageHistory, 'recordNow').mockImplementation(async (pp, i) => (i === id ? false : realRecord(pp, i)))
    const { result } = await purgeWith(project)
    expect(reasons(result)).toMatch(/couldn't record what the session used/)
    expect([existsSync(active(id)), (await records()).length]).toEqual([true, 1])
  })

  it('a last copy whose record fails to go is put back, permanently too (all or nothing)', async () => {
    for (const permanent of [false, true]) {
      const id = await session(false)
      const real = bound(w, w.mutateSessions)
      vi.spyOn(w, 'mutateSessions').mockImplementation((pp, fn) => (pp === p ? Promise.reject(new Error('EIO')) : real(pp, fn)))
      const { result } = await purgeWith({ kind: 'session', projectPath: p, sessionId: id }, { permanent })
      vi.mocked(w.mutateSessions).mockRestore?.()
      expect(reasons(result)).toMatch(/EIO/)
      expect([existsSync(active(id)), (await records()).some((r) => r.id === id)]).toEqual([true, true])
    }
  })

  it("a deleted session's leftovers that belong to a session again are left alone", async () => {
    const id = newId()
    write(join(attachments(id), 'b.txt'), 'b')
    const { result } = await purgeWith(project, { before: async () => void (await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', name: 'back', archived: false, lastActiveAt: ago(1) }))) })
    // Listed as a deleted session's: no longer one, so it no longer qualifies.
    expect(reasons(result)).toMatch(/no longer qualifies/)
    expect(existsSync(join(attachments(id), 'b.txt'))).toBe(true)
  })

  it('removes only what the preview listed', async () => {
    const id = await session(true)
    const preview = await run(() => purgePreview(project))
    const later = await session(true)
    const result = await run(() => purge(preview.id, preview.items.map((i) => i.key), false))
    expect(result.skipped).toEqual([])
    expect([existsSync(active(id)), existsSync(active(later)), existsSync(attachments(later))]).toEqual([false, true, true])
  })

  it("only Combwork's plain files go from an attachments folder: a folder inside stays, and so does the folder", async () => {
    const id = await session(true)
    mkdirSync(join(attachments(id), 'inner'))
    const { preview, result } = await purgeWith(project, { permanent: true })
    expect(preview.items.filter((i) => i.kind === 'attachments').map((i) => i.path)).toEqual([join(attachments(id), 'a.png')])
    expect(result.skipped).toEqual([])
    expect([existsSync(join(attachments(id), 'a.png')), existsSync(join(attachments(id), 'inner'))]).toEqual([false, true])
  })

  // Round 1's findings (HR4): the preview is what is applied, not what a fresh plan would list.
  it("a session whose CLI copy goes while the preview is open isn't deleted without its warning", async () => {
    const id = await session(true)
    const { preview, result } = await purgeWith(project, { before: async () => rmSync(join(cli, `${id}.jsonl`)) })
    expect(preview.items.some((i) => i.lastCopy)).toBe(false)
    expect(result.deleted).toBe(0)
    expect(reasons(result)).toMatch(/last copy changed since the preview/)
    expect([existsSync(active(id)), (await records()).some((r) => r.id === id)]).toEqual([true, true])
  })

  it('a session whose CLI copy comes back while the preview is open keeps its record and backup', async () => {
    const id = await session(false)
    const { result } = await purgeWith(project, { before: async () => write(join(cli, `${id}.jsonl`), transcript(id)) })
    expect(result.deleted).toBe(0)
    expect(reasons(result)).toMatch(/last copy changed since the preview/)
    expect(existsSync(active(id))).toBe(true)
  })

  it('attachments added or changed after the preview stay, either way', async () => {
    for (const permanent of [false, true]) {
      const id = await session(true)
      write(join(attachments(id), 'b.png'), 'png')
      const { result } = await purgeWith(project, {
        permanent,
        before: async () => {
          write(join(attachments(id), 'later.png'), 'later')
          write(join(attachments(id), 'b.png'), 'png, edited')
        }
      })
      expect([existsSync(join(attachments(id), 'a.png')), existsSync(join(attachments(id), 'b.png')), existsSync(join(attachments(id), 'later.png'))]).toEqual([false, true, true])
      expect(reasons(result)).toMatch(/changed since the preview/)
      expect(existsSync(active(id))).toBe(false)
    }
  })

  it("a deleted session's attachments added after the preview stay", async () => {
    const dead = newId()
    write(join(attachments(dead), 'b.txt'), 'b')
    const { result } = await purgeWith(project, { before: async () => write(join(attachments(dead), 'c.txt'), 'c') })
    expect(result.skipped).toEqual([])
    expect([existsSync(join(attachments(dead), 'b.txt')), existsSync(join(attachments(dead), 'c.txt'))]).toEqual([false, true])
  })

  it('a backup written to after the preview: the session keeps everything', async () => {
    const id = await session(true)
    const { result } = await purgeWith(project, { before: async () => write(active(id), transcript(id) + transcript(id)) })
    expect(result.removed).toBe(0)
    expect([existsSync(active(id)), existsSync(join(attachments(id), 'a.png'))]).toEqual([true, true])
  })

  it('a spare a crash left as the only copy is kept and counted, never purged as a leftover', async () => {
    // Combwork stopped in a delete between moving the backup and removing the record: only <backup>.spare is left.
    const id = await session(false)
    renameSync(active(id), active(id) + '.spare')
    const { preview, result } = await purgeWith(project, { permanent: true })
    expect([preview.recoverable, preview.items.some((i) => i.path?.endsWith('.spare'))]).toEqual([1, false])
    expect(result.skipped).toEqual([])
    expect([existsSync(active(id) + '.spare'), (await records()).some((r) => r.id === id)]).toEqual([true, true])
  })

  it("a spare beside its backup is a leftover, also when it's the session's last copy", async () => {
    const id = await session(false)
    write(active(id) + '.spare', transcript(id))
    const { preview, result } = await purgeWith(project)
    expect([preview.recoverable, preview.items.filter((i) => i.kind === 'leftover-backup').length]).toEqual([0, 1])
    expect(result).toMatchObject({ deleted: 1, skipped: [] })
    expect(readdirSync(join(p, '.combwork', 'sessions'))).toEqual([])
  })

  it('a preview is applied once, and an unknown one is refused', async () => {
    await session(true)
    const preview = await run(() => purgePreview(project))
    await run(() => purge(preview.id, preview.items.map((i) => i.key), false))
    await expect(run(() => purge(preview.id, preview.items.map((i) => i.key), false))).rejects.toThrow(/out of date/)
    await expect(run(() => purge('nope', [], false))).rejects.toThrow(/out of date/)
  })

  // #1158: a preview's age is checked when it is applied, not only when another is made.
  it('a preview applies up to PREVIEW_MS after it was made, and is refused after, with nothing removed', async () => {
    const t0 = Date.now()
    const clock = vi.spyOn(Date, 'now')
    try {
      const onTime = await session(true)
      clock.mockReturnValue(t0)
      const fresh = await run(() => purgePreview({ kind: 'session', projectPath: p, sessionId: onTime }))
      clock.mockReturnValue(t0 + PREVIEW_MS)
      const result = await run(() => purge(fresh.id, fresh.items.map((i) => i.key), false))
      expect(result).toMatchObject({ removed: 2, skipped: [] })
      expect(existsSync(active(onTime))).toBe(false)

      const late = await session(true)
      clock.mockReturnValue(t0)
      const stale = await run(() => purgePreview({ kind: 'session', projectPath: p, sessionId: late }))
      expect(stale.items.length).toBe(2)
      clock.mockReturnValue(t0 + PREVIEW_MS + 1)
      const was = binCount()
      await expect(run(() => purge(stale.id, stale.items.map((i) => i.key), false))).rejects.toThrow(/out of date\. Open Purge again/)
      expect([existsSync(active(late)), existsSync(join(attachments(late), 'a.png')), (await records()).some((r) => r.id === late), binCount()]).toEqual([true, true, true, was])
      // Forgotten once refused: going back in time doesn't bring it back.
      clock.mockReturnValue(t0)
      await expect(run(() => purge(stale.id, stale.items.map((i) => i.key), false))).rejects.toThrow(/out of date/)
    } finally {
      clock.mockRestore()
    }
  })

  it('refuses a target that is not one', async () => {
    await expect(run(() => purgePreview({ kind: 'nope' } as unknown as PurgeTarget))).rejects.toThrow(/Unknown purge target/)
    await expect(run(() => purgePreview({ kind: 'session', projectPath: p, sessionId: '../x' }))).rejects.toThrow(/Invalid session id/)
    await expect(run(() => purgePreview({ kind: 'project', projectPath: join(base, 'elsewhere') }))).rejects.toThrow()
  })
})
