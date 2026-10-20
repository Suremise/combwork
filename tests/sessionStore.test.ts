// A session host's records in its workspace's database (#1061, sessionStore.ts): each project's sessions.json moved in
// the first time its records are read (rows and the mark in one transaction, then the file kept as a backup), so a crash
// midway loses nothing; a change writes only the rows it changed, and concurrent changes all land; Remove from Hive
// writes them back into the folder, and a workspace finding such a file where the project has no records moves it in;
// a project renamed keeps them (they are under its id), the Assistant's are its own.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import type { SessionRecord } from '../src/shared/types'

const base = tempDir('hive-session-store-')
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
process.env.CODEX_HOME = join(base, 'codex-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// Kept files written as Hive writes them; `afterWrite`, when set, runs once a file is written (the export's, to race it).
const fileHooks = vi.hoisted(() => ({ afterWrite: null as ((path: string) => void) | null }))
vi.mock('../src/main/fsutil', async (orig) => {
  const m = await orig<typeof import('../src/main/fsutil')>()
  return { ...m, writeKeptJson: async (...a: Parameters<typeof m.writeKeptJson>) => (await m.writeKeptJson(...a), fileHooks.afterWrite?.(a[0])) }
})

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { readStore, storeTestHooks } = await import('../src/main/storeRows')
const { sessions } = await import('../src/main/sessions')
const removal = await import('../src/main/projectRemoval')
const { workspaceDb } = await import('../src/main/boardStore')
const { sessionRows, sessionsOf } = await import('../src/main/sessionStore')

const at = '2026-10-19T10:00:00.000Z'
const rec = (id: string, over: Partial<SessionRecord> = {}): SessionRecord => ({ id, agent: 'claude-code', name: `Session ${id}`, createdAt: at, lastActiveAt: at, archived: false, ...over })
const usage = (id: string) => ({ id, provider: 'claude-code' as const, usage: { inputTokens: 10, outputTokens: 20 } })
const oldFile = () => ({ version: 1, sessions: [rec('s1'), rec('s2', { cards: [{ number: 5, title: 'Five' }] }), rec('s3')], deleted: ['gone1', 'gone2'], deletedUsage: [usage('gone1'), usage('gone2')] })
const files = (p: string): string[] => readdirSync(join(p, '.hive')).filter((f) => f.startsWith('sessions.json'))
const idOf = (p: string): string => JSON.parse(readFileSync(join(p, '.hive', 'project.json'), 'utf8')).id

const wsPath = join(base, 'ws')
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const project = (name: string, file?: unknown): string => {
  const p = join(wsPath, name)
  mkdirSync(join(p, '.hive'), { recursive: true })
  if (file !== undefined) writeFileSync(join(p, '.hive', 'sessions.json'), typeof file === 'string' ? file : JSON.stringify(file))
  return p
}

beforeAll(async () => {
  for (const name of ['alpha', 'beta', 'gamma', 'delta', 'eps']) project(name, name === 'eps' ? undefined : oldFile())
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterAll(async () => {
  await disposeWorkspaceService(w)
})

describe("a host's sessions.json moved into the workspace's database (#1061)", () => {
  it('the first read moves it in, every record, deleted id and deleted usage in order; the file kept as a backup', async () => {
    const p = join(wsPath, 'alpha')
    const f = await run(() => workspace.sessionsFile(p))
    expect(f.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(f.sessions[1].cards).toEqual([{ number: 5, title: 'Five' }])
    expect(f.deleted).toEqual(['gone1', 'gone2'])
    expect(f.deletedUsage?.map((u) => u.id)).toEqual(['gone1', 'gone2'])
    expect(files(p).some((n) => n.startsWith('sessions.json.imported-'))).toBe(true)
    expect(existsSync(join(p, '.hive', 'sessions.json'))).toBe(false)
    // In the database's tables under the project's id (#1211), with the mark that it moved in.
    const db = workspaceDb(wsPath).reader
    const ids = (sql: string): string[] => (db.prepare(sql).all(idOf(p)) as { id: string }[]).map((r) => r.id)
    expect(ids('SELECT id FROM sessions WHERE host = ? ORDER BY ord')).toEqual(['s1', 's2', 's3'])
    expect(ids('SELECT id FROM sessions_deleted WHERE host = ? ORDER BY ord')).toEqual(['gone1', 'gone2'])
    expect(ids('SELECT id FROM sessions_deleted_usage WHERE host = ? ORDER BY ord')).toEqual(['gone1', 'gone2'])
    expect(JSON.parse(readStore(wsPath, 'sessions', idOf(p)).meta.get('imported')!)).toMatchObject({ rows: 3 })
    // Opening the workspace made no new file in its place.
    expect(existsSync(join(wsPath, 'eps', '.hive', 'sessions.json'))).toBe(false)
  })

  it("a file that can't be read now moves nothing in and marks nothing: the next read moves it in", async () => {
    // A folder where the file should be stands in for one held open: reading it fails.
    const p = project('locked')
    mkdirSync(join(p, '.hive', 'sessions.json'))
    await run(() => workspace.ensureProject(p))
    await run(() => workspace.projectIds({ fresh: true }))
    await expect(run(() => workspace.sessionsFile(p))).rejects.toThrow()
    expect(readStore(wsPath, 'sessions', idOf(p)).meta.has('imported')).toBe(false)
    renameSync(join(p, '.hive', 'sessions.json'), join(p, '.hive', 'held'))
    writeFileSync(join(p, '.hive', 'sessions.json'), JSON.stringify({ version: 1, sessions: [rec('late')] }))
    expect((await run(() => workspace.sessionsFile(p))).sessions.map((s) => s.id)).toEqual(['late'])
  })

  it('a file found after it moved in (a crash before its rename, or an older Hive) is kept unread: the records stay the database’s', async () => {
    const p = join(wsPath, 'beta')
    await run(() => workspace.sessionsFile(p))
    writeFileSync(join(p, '.hive', 'sessions.json'), JSON.stringify({ version: 1, sessions: [rec('stale')] }))
    const f = await run(() => workspace.sessionsFile(p))
    expect(f.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    // Kept at the next move in's check (each host is checked once a run: a new workspace service checks again).
    const other = createWorkspaceService()
    await disposeWorkspaceService(w)
    await other.open(wsPath)
    w = other
    expect((await run(() => workspace.sessionsFile(p))).sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
  })

  it('a damaged file is moved in from its backup', async () => {
    const p = project('damaged', '{"version":1,"sessions":[{"id":')
    writeFileSync(join(p, '.hive', 'sessions.json.bak'), JSON.stringify({ version: 1, sessions: [rec('from-bak')] }))
    await run(() => workspace.ensureProject(p))
    await run(() => workspace.projectIds({ fresh: true }))
    expect((await run(() => workspace.sessionsFile(p))).sessions.map((s) => s.id)).toEqual(['from-bak'])
  })
})

describe('changes', () => {
  it("write only the rows they change: a session's last activity is one row, the deleted sessions' usage untouched", async () => {
    const p = join(wsPath, 'gamma')
    await run(() => workspace.sessionsFile(p))
    // Every row written from here is counted, on the connection Hive writes with.
    const db = workspaceDb(wsPath).writer
    // Its tables' rows (#1211): a record's, its cards', the deleted lists'.
    const watched = ['sessions', 'session_cards', 'sessions_deleted', 'sessions_deleted_usage']
    db.exec('CREATE TEMP TABLE IF NOT EXISTS written (key TEXT); DELETE FROM written;')
    for (const t of watched) {
      const id = t === 'session_cards' ? 'new.session' : 'new.id'
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS w_upd_${t} AFTER UPDATE ON ${t} BEGIN INSERT INTO written VALUES ('${t}:' || ${id}); END; CREATE TEMP TRIGGER IF NOT EXISTS w_ins_${t} AFTER INSERT ON ${t} BEGIN INSERT INTO written VALUES ('${t}:' || ${id}); END;`)
    }
    await run(() => workspace.upsertSession(p, { id: 's2', lastActiveAt: '2026-10-19T11:00:00.000Z' }))
    expect((db.prepare('SELECT key FROM written').all() as { key: string }[]).map((r) => r.key)).toEqual(['sessions:s2'])
    db.exec('DELETE FROM written')
    await run(() => workspace.upsertSession(p, { id: 'new1' }))
    expect((db.prepare('SELECT key FROM written').all() as { key: string }[]).map((r) => r.key)).toEqual(['sessions:new1'])
    db.exec('DELETE FROM written;')
    for (const t of watched) db.exec(`DROP TRIGGER w_upd_${t}; DROP TRIGGER w_ins_${t};`)
    const f = await run(() => workspace.sessionsFile(p))
    expect(f.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3', 'new1'])
    expect(f.sessions[1].lastActiveAt).toBe('2026-10-19T11:00:00.000Z')
  })

  it('a deleted session that runs again leaves the deleted lists, as before', async () => {
    const p = join(wsPath, 'gamma')
    await run(() => workspace.upsertSession(p, { id: 'gone1' }))
    const f = await run(() => workspace.sessionsFile(p))
    expect(f.deleted).toEqual(['gone2'])
    expect(f.deletedUsage?.map((u) => u.id)).toEqual(['gone2'])
  })

  it('many at once all land, none lost; a change that throws writes nothing', async () => {
    const p = join(wsPath, 'gamma')
    await Promise.all(Array.from({ length: 20 }, (_, i) => run(() => workspace.upsertSession(p, { id: `burst${i}` }))))
    const ids = (await run(() => workspace.sessionsFile(p))).sessions.map((s) => s.id)
    for (let i = 0; i < 20; i++) expect(ids).toContain(`burst${i}`)
    await expect(
      run(() =>
        workspace.mutateSessions(p, (f) => {
          f.sessions = []
          throw new Error('changed my mind')
        })
      )
    ).rejects.toThrow('changed my mind')
    expect((await run(() => workspace.sessionsFile(p))).sessions.length).toBe(ids.length)
  })

  it("a record from before 0.9.3 has the Assistant's mode it was given as its persona: read as its mode (#1084)", () => {
    const rows = [{ key: 's:a', doc: JSON.stringify({ ...rec('a'), persona: 'planner' }), ord: 0 }, { key: 's:b', doc: JSON.stringify({ ...rec('b'), persona: 'planner', mode: 'coordinator' }), ord: 1 }]
    const [a, b] = sessionsOf({ rows, meta: new Map() }).sessions
    expect(a).toEqual(rec('a', { mode: 'planner' }))
    expect(b).toEqual(rec('b', { mode: 'coordinator' }))
  })

  it('rows and records round-trip, keys kept apart by kind (a deleted id equal to a record id)', () => {
    const f = { version: 1 as const, sessions: [rec('x'), rec('x')], deleted: ['x'], deletedUsage: [usage('x')] } as unknown as Parameters<typeof sessionRows>[0]
    const rows = sessionRows(f)
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
    expect(sessionsOf({ rows, meta: new Map() })).toEqual(f)
  })
})

describe('following the project', () => {
  it('the export writes them into its folder and out of the database; while held its file stays unread; released, they move back in', async () => {
    const p = join(wsPath, 'delta')
    const before = await run(() => workspace.sessionsFile(p))
    expect(await run(() => w.exportSessions(p))).toBe(3)
    expect(workspaceDb(wsPath).reader.prepare('SELECT id FROM sessions WHERE host = ?').all(idOf(p))).toEqual([])
    const written = JSON.parse(readFileSync(join(p, '.hive', 'sessions.json'), 'utf8'))
    expect(written.sessions.map((s: { id: string }) => s.id)).toEqual(['s1', 's2', 's3'])
    // Read during the removal (a refresh): nothing, and the file stays for the folder to take.
    expect((await run(() => workspace.sessionsFile(p))).sessions).toEqual([])
    expect(existsSync(join(p, '.hive', 'sessions.json'))).toBe(true)
    // A removal that didn't end with the project hidden (it failed later): its records come back.
    await run(() => w.releaseSessions(p))
    expect(await run(() => workspace.sessionsFile(p))).toEqual(before)
    expect(existsSync(join(p, '.hive', 'sessions.json'))).toBe(false)
  })

  it('a change committed as the export begins is in the file, never lost (review round 1)', async () => {
    const p = project('racing')
    await run(() => workspace.ensureProject(p))
    await run(() => workspace.projectIds({ fresh: true }))
    await run(() => workspace.upsertSession(p, { id: 'old' }))
    // Just before the export takes the lock, another change commits.
    storeTestHooks.beforeSave = async (store) => {
      if (store !== 'sessions') return
      storeTestHooks.beforeSave = null
      await run(() => workspace.upsertSession(p, { id: 'newly-committed' }))
    }
    try {
      await run(() => w.exportSessions(p))
    } finally {
      storeTestHooks.beforeSave = null
    }
    expect(JSON.parse(readFileSync(join(p, '.hive', 'sessions.json'), 'utf8')).sessions.map((x: { id: string }) => x.id)).toEqual(['old', 'newly-committed'])
    await run(() => w.releaseSessions(p))
    expect((await run(() => workspace.sessionsFile(p))).sessions.map((x) => x.id)).toEqual(['old', 'newly-committed'])
  })

  it('another connection writing as the export writes its file waits, or what it committed is kept (review round 2)', async () => {
    const p = project('elsewhere')
    await run(() => workspace.ensureProject(p))
    await run(() => workspace.projectIds({ fresh: true }))
    await run(() => workspace.upsertSession(p, { id: 'one', name: 'before' }))
    // Another process's connection to the same database (another Hive, a script) changes the record just as the file lands.
    let wrote: 'committed' | 'blocked' | null = null
    fileHooks.afterWrite = (path) => {
      if (!path.endsWith('sessions.json')) return
      fileHooks.afterWrite = null
      const db = new DatabaseSync(join(wsPath, '.hive', 'hive.db'), { timeout: 0 })
      try {
        db.prepare("UPDATE sessions SET name = 'committed elsewhere' WHERE host = ? AND id = 'one'").run(idOf(p))
        wrote = 'committed'
      } catch {
        wrote = 'blocked'
      } finally {
        db.close()
      }
    }
    try {
      await run(() => w.exportSessions(p))
    } finally {
      fileHooks.afterWrite = null
    }
    expect(wrote).not.toBeNull()
    await run(() => w.releaseSessions(p))
    const name = (await run(() => workspace.sessionsFile(p))).sessions.find((x) => x.id === 'one')?.name
    // Either the other writer had to wait (the export's one transaction held the database), or its change survives.
    if (wrote === 'committed') expect(name).toBe('committed elsewhere')
    else expect(name).toBe('before')
  })

  it('Remove from Hive with refreshes on the way leaves the file in the folder; another workspace takes them in; Restore here brings them back with what came meanwhile', { timeout: 60_000 }, async () => {
    const p = project('travels')
    await run(() => workspace.ensureProject(p))
    await run(() => workspace.projectIds({ fresh: true }))
    await run(() => workspace.upsertSession(p, { id: 't1' }))
    await run(() => workspace.upsertSession(p, { id: 't2' }))
    // Every refresh reads each project's records, as the app's does.
    w.setLiveProvider((pp, cfg, scope) => sessions.liveInfo(pp, cfg, scope))
    const exportFor = w.exportSessions.bind(w)
    w.exportSessions = async (pp: string) => {
      const n = await exportFor(pp)
      await w.refresh()
      return n
    }
    try {
      await run(() => removal.removeProject(p, 'remove'))
    } finally {
      w.exportSessions = exportFor
    }
    expect(w.hiddenProjects().find((h) => h.name === 'travels')?.mode).toBe('removed')
    await run(() => w.refresh())
    const file = join(p, '.hive', 'sessions.json')
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions.map((x: { id: string }) => x.id)).toEqual(['t1', 't2'])
    // Read while removed (a project id lookup, the board): nothing here, and the file stays.
    expect((await run(() => workspace.sessionsFile(p))).sessions).toEqual([])
    expect(existsSync(file)).toBe(true)
    // A copy of the folder opened in another workspace takes them in there.
    const otherWs = join(base, 'other-ws')
    mkdirSync(otherWs, { recursive: true })
    cpSync(p, join(otherWs, 'travels'), { recursive: true })
    const other = createWorkspaceService()
    try {
      await other.open(otherWs)
      expect((await inWorkspace(other, () => workspace.sessionsFile(join(otherWs, 'travels')))).sessions.map((x) => x.id)).toEqual(['t1', 't2'])
    } finally {
      await disposeWorkspaceService(other)
    }
    // A record made here while removed (a session ending late), then Restore: the folder's and that one.
    await run(() => workspace.upsertSession(p, { id: 'late' }))
    await run(() => removal.restoreProject('travels'))
    expect((await run(() => workspace.sessionsFile(p))).sessions.map((x) => x.id).sort()).toEqual(['late', 't1', 't2'])
    expect(existsSync(file)).toBe(false)
  })

  it('a project renamed keeps its records (they are under its id)', async () => {
    const p = join(wsPath, 'alpha')
    const before = await run(() => workspace.sessionsFile(p))
    const renamed = join(wsPath, 'alpha-renamed')
    renameSync(p, renamed)
    await run(() => workspace.projectIds({ fresh: true }))
    expect(await run(() => workspace.sessionsFile(renamed))).toEqual(before)
    renameSync(renamed, p)
    await run(() => workspace.projectIds({ fresh: true }))
  })

  it("the Assistant's records are its own", async () => {
    const home = w.assistantHome
    await run(() => workspace.upsertSession(home, { id: 'assistant-1' }))
    expect((workspaceDb(wsPath).reader.prepare("SELECT id FROM sessions WHERE host = 'assistant'").all() as { id: string }[]).map((r) => r.id)).toEqual(['assistant-1'])
    expect((await run(() => workspace.sessionsFile(join(wsPath, 'eps')))).sessions).toEqual([])
  })
})
