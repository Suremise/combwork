// HI-3602: the workspaces each released version left open in this build as before, and a 0.9 one is refused plainly,
// untouched (its upgrade to 1.0 is gone). Board schema versions by release (git show v<x>:src/main/boardStore.ts): 1.0.0
// left v24; 1.6.0, 1.7.0 and 1.7.1 all v34, this build's, so one fixture covers those three (their workspace format
// differs from this build's in nothing else: no folder or names move since 1.1). The 1.0 fixture is a board made by this
// build's steps up to 24 (their code pinned to v1.0.0's by tests/combworkMove10.test.ts, which covers 1.0's folders and
// stored paths) holding a filled workspace's rows, with 1.0's names on disk.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { join, relative } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { as09 } from './boardDb'

const base = tempDir('cw-ws-versions-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const watches = await import('../src/main/watches')
const { fileSchemaVersion, formatTestHooks, openDb } = await import('../src/main/db')

type WS = ReturnType<typeof createWorkspaceService>
const user = { kind: 'user' } as const
const services: WS[] = []
let n = 0
afterAll(async () => {
  for (const w of services) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
afterEach(() => {
  formatTestHooks.copy = undefined
})

const LATEST = Math.max(...store.BOARD_MIGRATIONS.map((m) => m.version))
// old-name: begin workspaceVersions-inputs
/** 1.0's folder and board file, and its names the names upgrade renamed (HI-2587). */
const OLD_DIR = '.hive'
const OLD_DB = 'hive.db'
const OLD_VERSION_COLUMN = 'hive_version'
const OLD_COMMENT_COLUMN = 'hive_text'
// old-name: end workspaceVersions-inputs

async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  services.push(w)
  await w.open(ws)
  return w
}
async function close(w: WS): Promise<void> {
  const path = w.path!
  services.splice(services.indexOf(w), 1)
  await disposeWorkspaceService(w)
  store.closeBoard(path)
}

/** Every file under `dir`, by its path there, with its size and its bytes' hash: what "nothing changed" compares. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        out[`${relative(dir, p)}/`] = 'dir'
        walk(p)
      } else out[relative(dir, p)] = `${statSync(p).size}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`
    }
  }
  walk(dir)
  return out
}

interface Filled {
  ws: string
  alpha: string
  cards: { number: number; doc: string }[]
  lane: string
  watched: number
  session: string
}

/** A workspace made and filled by this build's services: cards with a comment, history and a link, a lane, a card watch, a session. */
async function filled(): Promise<Filled> {
  const ws = join(base, `ws-${++n}`)
  const alpha = join(ws, 'alpha')
  mkdirSync(join(alpha, '.combwork'), { recursive: true })
  writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'Builder' }, { id: 'r1', name: 'Reviewer' }] }))
  const w = await open(ws)
  const a = await inWorkspace(w, () => tasks.createTask({ title: 'First', project: 'alpha', description: 'What it is' }, user))
  const b = await inWorkspace(w, () => tasks.createTask({ title: 'Second', project: 'alpha', links: [a.number] }, user))
  await inWorkspace(w, () => tasks.commentTask(a.number, 'A comment', user))
  await inWorkspace(w, () => tasks.updateTask(b.number, { column: 'doing' }, user))
  const lane = await inWorkspace(w, () => lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [a.number], name: 'A lane', brief: 'Its brief.', by: 'the Assistant' }))
  await inWorkspace(w, () => watches.registerWatch(w, alpha, 'b1', { cards: [b.number], changes: ['column'] }))
  const session = '00000000-0000-4000-8000-0000000000bb'
  await inWorkspace(w, () => w.upsertSession(alpha, { id: session, agent: 'claude-code', agentId: 'b1', cwd: alpha, names: 2, name: 'x', lastActiveAt: '2026-11-01T00:00:00.000Z' }))
  const cards = (await inWorkspace(w, () => store.cardDocs(w))).map((c) => ({ number: c.number, doc: JSON.stringify(c.doc) }))
  await watches.settled()
  await close(w)
  return { ws, alpha, cards, lane: lane.lane.id, watched: b.number, session }
}

/** What a filled workspace has, read back by this build. */
async function expectFilled(w: WS, f: Filled): Promise<void> {
  const cards = (await inWorkspace(w, () => store.cardDocs(w))).map((c) => ({ number: c.number, doc: JSON.stringify(c.doc) }))
  expect(cards).toEqual(f.cards)
  expect((await inWorkspace(w, () => lanes.rawLanes(w))).map((l) => l.id)).toEqual([f.lane])
  expect((await inWorkspace(w, () => watches.loadedWatchFor(w, f.alpha, 'b1')))?.cards).toEqual([f.watched])
  expect((await inWorkspace(w, () => w.sessionRecord(f.alpha, f.session)))?.agentId).toBe('b1')
  // Writable: a card made and moved.
  const c = await inWorkspace(w, () => tasks.createTask({ title: 'After', project: 'alpha' }, user))
  await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'doing' }, user))
  expect(inWorkspace(w, () => store.boardState(w)).readOnly).toBeNull()
}

/** The columns of `table` a row is written with (not generated ones). */
const writable = (db: DatabaseSync, schema: string, table: string): string[] =>
  (db.prepare(`SELECT name, hidden FROM pragma_table_xinfo(?, ?)`).all(table, schema) as { name: string; hidden: number }[]).filter((c) => c.hidden === 0).map((c) => c.name)

/**
 * The filled workspace's board as 1.0.0 left it: a board made by the steps up to 24 (1.0.0's last) holding the rows of
 * every table it has, then 1.0's names (the comment and version columns, the board file and the folders).
 */
function as10(f: Filled): void {
  const file = store.boardFile(f.ws)
  const old = join(f.ws, '.combwork', 'v24.db')
  openDb(old, { migrations: store.BOARD_MIGRATIONS.filter((m) => m.version <= 24), appVersion: '1.0.0' }).close()
  const db = new DatabaseSync(old)
  db.exec('PRAGMA foreign_keys = OFF')
  db.prepare('ATTACH DATABASE ? AS now').run(file)
  const tablesOf = (schema: string): string[] => (db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'`).all() as { name: string }[]).map((r) => r.name)
  const virtualOwned = new Set((db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name LIKE 'card_search%'").all() as { name: string }[]).map((r) => r.name))
  db.exec('BEGIN')
  for (const t of tablesOf('main').filter((x) => x !== 'schema_version' && !virtualOwned.has(x))) {
    const cols = writable(db, 'main', t).filter((c) => writable(db, 'now', t).includes(c))
    if (!cols.length) continue
    db.exec(`DELETE FROM main."${t}"`)
    db.exec(`INSERT INTO main."${t}" (${cols.map((c) => `"${c}"`).join(', ')}) SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM now."${t}"`)
  }
  db.exec('COMMIT')
  db.exec('DETACH DATABASE now')
  db.exec(`ALTER TABLE card_comments RENAME COLUMN app_text TO ${OLD_COMMENT_COLUMN}`)
  db.exec(`ALTER TABLE schema_version RENAME COLUMN app_version TO ${OLD_VERSION_COLUMN}`)
  db.close()
  for (const s of ['', '-wal', '-shm']) if (existsSync(`${file}${s}`)) renameSync(`${file}${s}`, join(f.ws, '.combwork', `now.db${s}`))
  renameSync(old, join(f.ws, '.combwork', OLD_DB))
  for (const dir of [f.ws, f.alpha, join(f.ws, '.combwork', 'assistant')]) if (existsSync(join(dir, '.combwork'))) renameSync(join(dir, '.combwork'), join(dir, OLD_DIR))
}

describe('a workspace each released version left opens as before (HI-3602)', () => {
  it('1.0.0 (board v24, its names and folders): the group\'s later steps run, its cards, lane, watch and session there, writable', async () => {
    const f = await filled()
    as10(f)
    expect(fileSchemaVersion(join(f.ws, OLD_DIR, OLD_DB))).toBe(24)
    const w = await open(f.ws)
    expect(fileSchemaVersion(store.boardFile(f.ws))).toBe(LATEST)
    // The ordinary copy before the later steps, of the file as 1.0 left it.
    expect(readdirSync(join(f.ws, '.combwork', 'backups')).filter((x) => x.startsWith('combwork-v24-'))).toHaveLength(1)
    await expectFilled(w, f)
    await close(w)
  })

  it('1.6.0, 1.7.0 and 1.7.1 (board v34, as this build): nothing to run, no copy, everything there and writable', async () => {
    const f = await filled()
    expect(fileSchemaVersion(store.boardFile(f.ws))).toBe(34)
    const backups = join(f.ws, '.combwork', 'backups')
    const had = existsSync(backups) ? readdirSync(backups) : []
    const w = await open(f.ws)
    expect(fileSchemaVersion(store.boardFile(f.ws))).toBe(34)
    await expectFilled(w, f)
    expect(existsSync(backups) ? readdirSync(backups) : []).toEqual(had)
    await close(w)
  })

  it('a new workspace: its board made at the latest version, no refusal', async () => {
    const ws = join(base, `new-${++n}`)
    mkdirSync(ws, { recursive: true })
    const w = await open(ws)
    await inWorkspace(w, () => tasks.createTask({ title: 'New' }, user))
    expect(fileSchemaVersion(store.boardFile(ws))).toBe(LATEST)
    await close(w)
  })
})

/** A workspace whose board 0.9 left (its file before the 1.0 group), with a card and a backup, under 0.9's names. */
async function workspace09(layout: 'old' | 'moved'): Promise<string> {
  const f = await filled()
  as09(store.boardFile(f.ws))
  const file = store.boardFile(f.ws)
  const raw = new DatabaseSync(file)
  raw.exec(`ALTER TABLE schema_version RENAME COLUMN app_version TO ${OLD_VERSION_COLUMN}`)
  raw.close()
  mkdirSync(join(f.ws, '.combwork', 'backups'), { recursive: true })
  writeFileSync(join(f.ws, '.combwork', 'backups', 'combwork-v1-2025-01-01T00-00-00-000Z.db'), 'an older copy')
  renameSync(file, join(f.ws, '.combwork', OLD_DB))
  if (layout === 'old') for (const dir of [f.ws, f.alpha]) renameSync(join(dir, '.combwork'), join(dir, OLD_DIR))
  return f.ws
}

describe('a 0.9 workspace is refused plainly, untouched (HI-3602)', () => {
  for (const layout of ['old', 'moved'] as const) {
    it(`${layout === 'old' ? `in 0.9's own folders (${OLD_DIR}, ${OLD_DB})` : 'in folders a 1.x build moved (.combwork), its upgrade never made'}: refused, every file as it was`, async () => {
      const ws = await workspace09(layout)
      const was = snapshot(ws)
      const w = createWorkspaceService()
      services.push(w)
      await expect(w.open(ws)).rejects.toThrow("This workspace is from Combwork 0.9, which this version can't open.")
      expect(w.path).toBeNull()
      expect(snapshot(ws)).toEqual(was)
    })
  }

  it('a 0.9 board only in its WAL (no -shm): refused, nothing added; a probe that fails refuses the open, untouched', async () => {
    const ws = await workspace09('moved')
    const file = join(ws, '.combwork', OLD_DB)
    // Its commits kept only in the WAL, as a Combwork that ended without quitting leaves it.
    const live = new DatabaseSync(file)
    live.exec('PRAGMA wal_autocheckpoint = 0')
    live.exec("INSERT INTO board_meta (key, value) VALUES ('after', '1')")
    const copy = join(base, `wal-${++n}`)
    mkdirSync(copy)
    copyFileSync(file, join(copy, OLD_DB))
    copyFileSync(`${file}-wal`, join(copy, `${OLD_DB}-wal`))
    live.close()
    copyFileSync(join(copy, OLD_DB), file)
    copyFileSync(join(copy, `${OLD_DB}-wal`), `${file}-wal`)
    expect(existsSync(`${file}-shm`)).toBe(false)
    const was = snapshot(ws)
    const w = createWorkspaceService()
    services.push(w)
    await expect(w.open(ws)).rejects.toThrow("This workspace is from Combwork 0.9, which this version can't open.")
    expect(snapshot(ws)).toEqual(was)
    formatTestHooks.copy = () => {
      throw new Error('EBUSY: resource busy or locked')
    }
    await expect(w.open(ws)).rejects.toThrow(/Combwork couldn't read this workspace's board to check its version: .*EBUSY.*Try opening it again\./)
    expect(w.path).toBeNull()
    expect(snapshot(ws)).toEqual(was)
  })
})
