// Compressed transcript backups (#1110): a session's backups are gzipped once it ends or is archived, never while it
// runs; archiving and unarchiving move them compressed; the viewer, search, export and usage read them as plain ones;
// Storage says what they hold before compression. Backup retention (off by default) sends Combwork's copies of sessions idle
// that long to the Recycle Bin, only where the CLI still has the session, after the usage history has what it used; a
// session whose only copy is Combwork's is never touched.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { gunzipSync, gzipSync } from 'zlib'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-backup-gz-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// The Recycle Bin, as deleting the file.
const trashed: string[] = []
;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (p) => {
  rmSync(p, { recursive: true, force: true })
  trashed.push(p)
}

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { transcripts } = await import('../src/main/transcripts')
const { projectStorage } = await import('../src/main/storage')
const { config } = await import('../src/main/config')
const { usageHistory } = await import('../src/main/usageHistory')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'proj')
const cli = join(base, 'cli')
const s = sessions as unknown as { live: Map<string, unknown> }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString()
let n = 0
const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

const at = ago(100)
const transcript = (sid: string, words = 'Compress the backups'): string =>
  [
    { type: 'user', sessionId: sid, timestamp: at, message: { role: 'user', content: words } },
    ...Array.from({ length: 40 }, (_, i) => ({ type: 'assistant', sessionId: sid, requestId: `r${i}`, timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: `Step ${i} done. ${'Detail '.repeat(20)}` }], usage: { input_tokens: 10, output_tokens: 50 } } }))
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
const write = (file: string, text: string): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}
const backup = (id: string, archived = false): string => join(p, '.combwork', archived ? 'archive' : 'sessions', `${id}.jsonl`)
const cliFile = (id: string): string => join(cli, `${id}.jsonl`)
const gz = (file: string): string => gunzipSync(readFileSync(file + '.gz')).toString('utf8')

/** One of Combwork's sessions, last active `days` ago, with a plain backup; `inCli`: the CLI still has its transcript. */
async function session(opts: { days?: number; inCli?: boolean; archived?: boolean } = {}): Promise<string> {
  const id = newId()
  await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', name: id, archived: !!opts.archived, lastActiveAt: ago(opts.days ?? 100) }))
  write(backup(id, !!opts.archived), transcript(id))
  if (opts.inCli) write(cliFile(id), transcript(id))
  return id
}
const running = (id: string): void => void s.live.set(`x-${id}`, { state: { sessionId: id } })

const cliLookup = vi.spyOn(sessions, 'providerTranscript')
const lookup = async (_p: string, id: string) => (existsSync(cliFile(id)) ? { path: cliFile(id), provider: 'claude-code' as const } : null)

describe('compressed transcript backups', () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'c1', name: 'Agent 1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    cliLookup.mockImplementation(lookup)
  })
  beforeEach(async () => {
    trashed.length = 0
    config.settings.sessions.backupRetention = 'off'
    for (const d of ['archive', 'sessions']) rmSync(join(p, '.combwork', d), { recursive: true, force: true })
    await w.mutateSessions(p, (f) => {
      f.sessions = []
      f.deleted = []
      f.deletedUsage = []
    })
  })
  afterEach(() => s.live.clear())
  afterAll(async () => {
    config.settings.sessions.backupRetention = 'off'
    cliLookup.mockRestore()
    await disposeWorkspaceService(w)
  })

  it("compresses a session's backups once it has ended, never while it runs", async () => {
    const id = await session()
    const live = await session()
    running(live)
    await run(() => sessions.compressBackups(p, id))
    await run(() => sessions.compressBackups(p, live))
    expect([existsSync(backup(id)), gz(backup(id))]).toEqual([false, transcript(id)])
    expect([existsSync(backup(live)), existsSync(backup(live) + '.gz')]).toEqual([true, false])
  })

  it('compresses what ended before, the oldest first, leaving sessions active in the last ten minutes', async () => {
    const old = await session({ days: 3 })
    const recent = await session({ days: 1 / (24 * 60) })
    expect(await run(() => sessions.compressIdleBackups(p))).toBe(1)
    expect([existsSync(backup(old) + '.gz'), existsSync(backup(old))]).toEqual([true, false])
    expect([existsSync(backup(recent)), existsSync(backup(recent) + '.gz')]).toEqual([true, false])
  })

  it('archives and unarchives a compressed backup, compressed; a plain backup newer than the compressed one wins', async () => {
    const id = await session()
    await run(() => sessions.compressBackups(p, id))
    await run(() => sessions.archive(p, id, true))
    expect([existsSync(backup(id) + '.gz'), existsSync(backup(id, true)), gz(backup(id, true))]).toEqual([false, false, transcript(id)])
    await run(() => sessions.archive(p, id, false))
    expect([existsSync(backup(id, true) + '.gz'), gz(backup(id))]).toEqual([false, transcript(id)])
    // Resumed since it was compressed: the live (plain) copy has more.
    write(backup(id), transcript(id, 'Resumed and went on'))
    await run(() => sessions.archive(p, id, true))
    expect([existsSync(backup(id)), existsSync(backup(id) + '.gz'), gz(backup(id, true))]).toEqual([false, false, transcript(id, 'Resumed and went on')])
  })

  it('is viewed, searched, exported and counted from its compressed backup alone', async () => {
    const id = await session()
    const before = await run(() => transcripts.read(p, id))
    await run(() => sessions.compressBackups(p, id))
    expect(existsSync(backup(id))).toBe(false)
    const read = await run(() => transcripts.read(p, id))
    expect(read?.items.length).toBe(before?.items.length)
    expect(read?.items.some((i) => i.kind === 'user' && /Compress the backups/.test(i.text))).toBe(true)
    expect((await run(() => transcripts.search(p, 'Step 39', id))).length).toBeGreaterThan(0)
    expect(await run(() => transcripts.markdown(p, id, 'Export'))).toMatch(/Step 39 done/)
    const u = await vi.waitFor(async () => {
      const x = await run(() => sessions.usage(p, id))
      if (!x) throw new Error('no usage yet')
      return x
    }, { timeout: 30000 })
    expect([u.inputTokens, u.outputTokens]).toEqual([400, 2000])
  })

  it("shows an image from a compressed backup (found by where it is in the decompressed transcript)", async () => {
    const id = await session()
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const image = { type: 'user', sessionId: id, timestamp: at, message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: 'Look at this' }] } }
    write(backup(id), transcript(id) + JSON.stringify(image) + '\n')
    await run(() => sessions.compressBackups(p, id))
    expect(existsSync(backup(id))).toBe(false)
    expect(await run(() => transcripts.image(p, id, 0))).toBe(`data:image/png;base64,${png}`)
  })

  it('a compressed backup replaced by another of the same size is read again: view, search, export and polling', async () => {
    const id = await session()
    // Stored, not deflated (#1156): the content has the time and the session id in it, which deflate compressed a byte
    // apart for some of them; stored, the size is the content's, so the two always match.
    const gzOf = (word: string): Buffer => gzipSync(transcript(id) + JSON.stringify({ type: 'user', sessionId: id, timestamp: at, message: { role: 'user', content: `Last word ${word}` } }) + '\n', { level: 0 })
    const [a, b] = [gzOf('AAAA'), gzOf('BBBB')]
    expect(a.length).toBe(b.length)
    rmSync(backup(id))
    writeFileSync(backup(id) + '.gz', a)
    const first = await run(() => transcripts.read(p, id))
    expect(first?.items.at(-1)).toMatchObject({ kind: 'user', text: 'Last word AAAA' })
    expect(await run(() => transcripts.read(p, id, { knownVersion: first!.version }))).toBeNull()
    // Replaced whole, as compressing a resumed session's backup at its end does.
    writeFileSync(backup(id) + '.gz.tmp', b)
    renameSync(backup(id) + '.gz.tmp', backup(id) + '.gz')
    const again = await run(() => transcripts.read(p, id, { knownVersion: first!.version }))
    expect(again?.items.at(-1)).toMatchObject({ kind: 'user', text: 'Last word BBBB' })
    expect(again?.version).not.toBe(first?.version)
    expect((await run(() => transcripts.search(p, 'AAAA', id))).length).toBe(0)
    expect((await run(() => transcripts.search(p, 'BBBB', id))).length).toBeGreaterThan(0)
    expect(await run(() => transcripts.markdown(p, id, 'Export'))).toMatch(/Last word BBBB/)
  })

  it('Storage gives what the backups hold before compression', async () => {
    const id = await session()
    const archived = await session({ archived: true })
    await run(() => sessions.compressBackups(p, id))
    await run(() => sessions.compressBackups(p, archived))
    const st = await run(() => projectStorage(p, true))
    expect(st.sessionsRaw).toBe(Buffer.byteLength(transcript(id)))
    expect(st.archiveRaw).toBe(Buffer.byteLength(transcript(archived)))
    expect(st.sessions).toBeLessThan(st.sessionsRaw!)
  })

  describe('retention', () => {
    it('is off by default: nothing goes', async () => {
      await session({ days: 400, inCli: true })
      expect(await run(() => sessions.applyRetention(p))).toBe(0)
      expect(trashed).toEqual([])
    })

    it("sends Combwork's copies of sessions idle that long to the Recycle Bin, only where the CLI has the session, and keeps what they used", async () => {
      config.settings.sessions.backupRetention = '30'
      const gone = await session({ days: 40, inCli: true })
      write(backup(gone, true) + '.gz', '')
      const combworkOnly = await session({ days: 400 })
      const recent = await session({ days: 10, inCli: true })
      const live = await session({ days: 40, inCli: true })
      running(live)
      await run(() => sessions.compressBackups(p, gone))
      expect(await run(() => sessions.applyRetention(p))).toBe(1)
      expect(trashed.sort()).toEqual([backup(gone) + '.gz', backup(gone, true) + '.gz'].sort())
      // The session stays, from the CLI's copy; what it used, from the usage history.
      expect((await run(() => workspace.sessionsFile(p))).sessions.map((r) => r.id)).toContain(gone)
      expect(existsSync(cliFile(gone))).toBe(true)
      const u = await run(() => sessions.usage(p, gone))
      expect(u && u.outputTokens).toBe(2000)
      for (const kept of [combworkOnly, recent, live]) expect(existsSync(backup(kept)), kept).toBe(true)
    })

    // What decides it can change while it waits: before the session is reserved (the first look at the CLI), and while
    // what it used is recorded. Each change keeps its copies.
    const changes: [string, (id: string) => Promise<void>][] = [
      ['active again', async (id) => void (await run(() => workspace.upsertSession(p, { id, lastActiveAt: new Date().toISOString() })))],
      ['retention turned off', async () => void (config.settings.sessions.backupRetention = 'off')],
      ['started', async (id) => running(id)],
      ["dropped by the CLI", async (id) => rmSync(cliFile(id), { force: true })]
    ]
    for (const [what, change] of changes) {
      it(`keeps the copies of a session ${what} before it is reserved, or while what it used is recorded`, async () => {
        config.settings.sessions.backupRetention = '30'
        const before = await session({ days: 400, inCli: true })
        let looks = 0
        cliLookup.mockImplementation(async (pp, id) => {
          if (id === before && looks++ === 0) await change(id)
          return lookup(pp, id)
        })
        expect(await run(() => sessions.applyRetention(p))).toBe(0)
        expect(existsSync(backup(before))).toBe(true)
        cliLookup.mockImplementation(lookup)
        s.live.clear()
        // Out of the next run: the CLI no longer has it.
        rmSync(cliFile(before), { force: true })

        config.settings.sessions.backupRetention = '30'
        const during = await session({ days: 400, inCli: true })
        const record = vi.spyOn(usageHistory, 'recordNow').mockImplementation(async (_p, id) => {
          if (id === during) await change(id)
          return true
        })
        try {
          expect(await run(() => sessions.applyRetention(p))).toBe(0)
        } finally {
          record.mockRestore()
        }
        expect(trashed).toEqual([])
        expect(existsSync(backup(during))).toBe(true)
      })
    }
  })
})
