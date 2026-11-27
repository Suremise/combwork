// HI-2462, HR1's finding 6: a workspace as Combwork 1.0.0 left it opens in this build with everything under .combwork.
// The board's schema is pinned to the released 1.0.0's: its migrations and schema sources at the v1.0.0 tag are this
// build's apart from comments (checked here against git: skipped only in a shallow clone, failing in a full one that
// lacks the tag, HI-3606; the merge's focused pick selects it for those files by UNIT_SCANS). The workspace is made by
// the real services (a card with an attachment, a comment, context and its history; a shared note; a handover; the
// Assistant's home; a project), its folders then put back under 1.0's name with paths stored as 1.0 stored them, and
// opened by the real WorkspaceService: the move runs in its open, the cards' rewrite in its late phase. Then the board,
// the notes and the attachment are there, the stored paths point into .combwork, the history is as it was, and no folder
// under 1.0's name is left.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-move10-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const att = await import('../src/main/cardAttachments')

const ROOT = join(__dirname, '..')
// old-name: begin combworkMove10-inputs
/** 1.0's folder and board file, the move's input. */
const OLD_DIR = '.hive'
const OLD_DB = 'hive.db'
/** The names the names upgrade renamed (HI-2587) as 1.0 had them in the schema's code, and the app's name (HI-2591). */
const AS_1_0: [RegExp, string][] = [
  [/\bapp_text\b/g, 'hive_text'],
  [/\bapp_version\b/g, 'hive_version'],
  [/\bappVersion\b/g, 'hiveVersion'],
  [/\bappText\b/g, 'hiveText'],
  [/combwork\.db/g, OLD_DB]
]
const APP_1_0 = 'Hive'
// old-name: end combworkMove10-inputs
const user = { kind: 'user' } as const
const services: ReturnType<typeof createWorkspaceService>[] = []
afterAll(async () => {
  for (const w of services) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

/** A source file at the v1.0.0 tag, or null where the tag isn't there (a shallow clone). */
function atTag(file: string): string | null {
  try {
    return execFileSync('git', ['show', `v1.0.0:${file}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}
/**
 * The names upgrade's own changes to the schema (HI-2587, SPEC §4.1.2), taken out: its step 25 at the 1.0 group's end,
 * the version column's rename as a database opens (renameVersionColumn), and the names it renamed (the comments'
 * `app_text`, the version column's `app_version`, the option and key `appVersion`, the field `appText`, the board's file).
 * Anything else that differs from 1.0.0 still fails.
 */
const before2587 = (s: string): string =>
  AS_1_0.reduce(
    (t, [from, to]) => t.replace(from, to),
    s
      .replace(/\r\n/g, '\n')
      .replace(/,\n  \{\n    \/\/ HI-2587, the names upgrade[\s\S]*?\n  \}\n\]/, '\n]')
      .replace(/\/\*\*\n \* `schema_version`'s column[\s\S]*?\nexport function renameVersionColumn[\s\S]*?\n\}\n/, '')
      .replace(/^.*\n.*if \(newer === null\) renameVersionColumn\(writer\)\n/m, '')
      // HI-3289's write guard and close, which change no schema: a transaction's BEGIN checks the checkpoints' guard
      // first, and a close skips its optional PRAGMA optimize while their worker holds the write lock.
      .replace(/\nexport const beginGuards = [^\n]*\n/, '\n')
      .replace(/\nexport function beginTransaction\(db: DatabaseSync\): void \{\n[\s\S]*?\n\}\n/, '\n')
      .replace(/\bbeginTransaction\(db\)/g, "db.exec('BEGIN IMMEDIATE')")
      .replace('writer: DatabaseSync) => () => boolean | void', 'writer: DatabaseSync) => () => void')
      .replace('const lockedElsewhere = stopCheckpoints?.() === true', 'stopCheckpoints?.()')
      .replace("if (!lockedElsewhere) writer.exec('PRAGMA optimize')", "writer.exec('PRAGMA optimize')")
      // HI-3374's bounds, which change no schema: the busy wait from Settings → Advanced (dbLimits, setDbBusyMs; 1.0 had
      // 5 s), and the waits for a file left by a Combwork that ended (1.0: 20 s) and for a group's lock (1.0: 1 s).
      .replace(/\nexport const dbLimits = \{ busyMs: [\d_]+ \}\n/, '\n')
      .replace(/\nexport function setDbBusyMs\(ms: number\): void \{\n[\s\S]*?\n\}\n/, '\n')
      .replace(/`PRAGMA busy_timeout = \$\{dbLimits\.busyMs\}`/g, "'PRAGMA busy_timeout = 5000'")
      .replace(/\{ timeout: dbLimits\.busyMs \}/g, '{ timeout: 5000 }')
      .replace(/export const OPENABLE_WAIT_MS = [\d_]+/, 'export const OPENABLE_WAIT_MS = 20_000')
      .replace(/const GROUP_LOCK_WAIT_MS = [\d_]+/, 'const GROUP_LOCK_WAIT_MS = 1000')
      // HI-3601's removal, which changes no schema: soleCopy(), the copy Restore the 0.9 Board Backup took of a board no
      // connection held. Neither the migrations nor an open ran it; taken out of 1.0's text, so this build lacks it.
      .replace(/\nexport function soleCopy\(file: string, dir: string, family: string, version: number\): string \{\n[\s\S]*?\n\}\n/, '\n')
  )
/** Code without its comments and with the folder's name as 1.0 had it: what makes the schema. */
const code = (s: string): string =>
  before2587(s)
    // The modules' reads (v1_0.ts's QUERIES) aren't the schema: a later card adds one on a 1.0 index (HI-2709's
    // links.dependents), and tests/schemaV1_0.test.ts checks each one's plan against the 1.0 tables.
    .replace(/\nexport const QUERIES\b[\s\S]*?\n\}\n/, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\.combwork/g, OLD_DIR)
    .replace(/\bCombwork\b/g, APP_1_0) // HI-2591: the app's name in its messages and notes, as 1.0 had it
    .replace(/\s+/g, ' ')
    .replace(UPGRADE_09_CODE, '')
    .replace(REFUSAL_09_CODE, '')
    .replace(UPGRADE_09_PIECES, '')
/**
 * HI-3602's removal of the upgrade from 0.9, which changes no schema a 1.x board runs: the group's question
 * (`OpenOptions.approve`, `Db.pending`, the waiting group's return) and its copy kept for good (`groupBackupFamily`,
 * `backupTo`'s `keepAll`), each ran only on a board from before the group (0.9's, at v1 or v2: every 1.x board is at 3
 * or later, a new one taking every step unasked); and the refusal put in their place (`refuseBefore`: TooOldError,
 * fileFormat's read, its errors and imports), which runs before a file opens and changes nothing in it. Each is the exact
 * code, comments and spacing aside, in 1.0.0's text or this build's: taken out of both, so anything else still fails.
 */
const UPGRADE_09_REMOVED: string[] = [
  'approve?: (pending: PendingGroup) => boolean ',
  'refuseBefore?: number ',
  'pending: PendingGroup | null ',
  'export const groupBackupFamily = (family: string, group: string): string => `${family}-before-${group}` ',
  ', keepAll = false',
  ' if (keepAll) return file',
  'const first = Math.min(...opts.migrations.filter((m) => m.group === group).map((m) => m.version)) if (pending.from < first && opts.approve && !opts.approve(pending)) { told() return pending } ',
  'pending.from < first ? groupBackupFamily(family, group) : null, ',
  'keptFamily: string | null, ',
  'keptFamily ?? ',
  ', new Date(), !!keptFamily',
  ' && !pending',
  'copyFileSync, ',
  'mkdtempSync, ',
  ', statSync',
  "import { tmpdir } from 'os' ",
  "import { pathToFileURL } from 'url' "
]
/** UPGRADE_09_REMOVED, each piece wherever it is (escaped for a regular expression). */
const UPGRADE_09_PIECES = new RegExp(UPGRADE_09_REMOVED.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
/** HI-3602: the waiting group's return (1.0's) and this build's plain migrate, the same code once the return is gone. */
const UPGRADE_09_CODE = /(?<=OpenOptions\): )PendingGroup \| null(?= \{)|(?<=if \(!todo\.length\) return) null|(?<=told\(\)) return null(?= \})|(?<=OpenOptions\): )void(?= \{ const from = schemaVersion)|const pending = newer === null \? migrate\(writer, file, opts\) : null if \(newer !== null \|\| pending\) writer\.exec|if \(newer === null\) migrate\(writer, file, opts\) else writer\.exec|(?<=newer, )pending, (?=close:)/g
/** HI-3602: the refusal (its errors, its test seam, fileFormat, and openDbNow's check), this build's alone. */
const REFUSAL_09_CODE = /export class TooOldError extends Error \{[\s\S]*?throw new FormatUnknownError\(file, e\) \} \} |if \(opts\.refuseBefore !== undefined\) \{ const f = fileFormat\(file, opts\.refuseBefore\) if \(f\.tables && f\.version > 0 && f\.version < opts\.refuseBefore\) throw new TooOldError\(file, f\.version\) \} /g
/** Every schema module the tag had (all of src/main/schema), and the database layer that runs them. */
function schemaFiles(): string[] {
  try {
    return [...execFileSync('git', ['ls-tree', '--name-only', 'v1.0.0', 'src/main/schema/'], { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean), 'src/main/db.ts']
  } catch {
    return []
  }
}
const migrations = (raw: string): string => {
  const s = raw.replace(/\r\n/g, '\n')
  const at = s.indexOf('export const BOARD_MIGRATIONS')
  return s.slice(at, s.indexOf('\n]\n', at) + 2)
}

/** Whether the checkout is a shallow clone (CI's default, which fetches no tags), where the tag can't be read. */
function shallow(): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true'
  } catch {
    return false
  }
}

describe("a 1.0.0 workspace opened in this build (HR1's finding 6)", () => {
  const tagged = atTag('src/main/boardStore.ts')

  // HI-3606: skipped only in a shallow clone. A full checkout without the tag fails, saying so, rather than passing a
  // change to the 1.0 schema unchecked.
  it.skipIf(!tagged && shallow())("the board's schema is the released 1.0.0's, apart from comments", () => {
    if (!tagged) throw new Error('The v1.0.0 tag is missing from this checkout: run `git fetch --tags` so the 1.0 schema can be compared')
    const now = migrations(readFileSync(join(ROOT, 'src/main/boardStore.ts'), 'utf8'))
    expect(now.length).toBeGreaterThan(1000)
    expect(code(now)).toBe(code(migrations(tagged!)))
    const files = schemaFiles()
    expect(files.length).toBeGreaterThan(5)
    for (const f of files) expect(code(readFileSync(join(ROOT, f), 'utf8')), f).toBe(code(atTag(f) ?? ''))
  })

  it('opens with its board, notes, attachment and history, its paths in .combwork, no folder under 1.0\'s name left', async () => {
    // Made by the real services, then put back as 1.0 kept it.
    const ws = join(base, 'ws')
    const alpha = join(ws, 'alpha')
    mkdirSync(join(alpha, '.combwork'), { recursive: true })
    writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-coder', name: 'Coder' }] }))
    const first = createWorkspaceService()
    services.push(first)
    await first.open(ws)
    const src = join(base, 'shot.png')
    writeFileSync(src, 'png bytes')
    const card = await inWorkspace(first, () => tasks.createTask({ title: 'With evidence', project: 'alpha', context: ['docs/x.md'] }, user))
    const stored = (await inWorkspace(first, () => att.attachToCard(first, card.number, [{ path: src }], 'You'))).attachments[0]
    await inWorkspace(first, () => tasks.commentTask(card.number, 'A comment', user))
    const history = (await inWorkspace(first, () => tasks.getTask(card.number))).history
    const rows = await inWorkspace(first, () => att.cardAttachments(first, card.number))
    // A conversation that ran in a folder inside the project's .combwork (a slot kept there): 1.0 recorded it by that path.
    const slot = join(alpha, '.combwork', 'slots', 'HI-1')
    mkdirSync(slot, { recursive: true })
    const sessionId = '00000000-0000-4000-8000-0000000000aa'
    await inWorkspace(first, () => first.upsertSession(alpha, { id: sessionId, agent: 'claude-code', agentId: 'a-coder', cwd: join(alpha, OLD_DIR, 'slots', 'HI-1'), names: 2, name: 'x', lastActiveAt: '2026-11-01T00:00:00.000Z' }))
    mkdirSync(join(ws, '.combwork', 'shared', 'handovers'), { recursive: true })
    writeFileSync(join(ws, '.combwork', 'shared', 'plan.md'), '# Plan\n')
    await disposeWorkspaceService(first)
    store.closeAllBoards()
    const old = (p: string): string => p.replace(/\\\.combwork\\/g, `\\${OLD_DIR}\\`)
    const shot = stored.path
    writeFileSync(join(ws, '.combwork', 'shared', 'handovers', '2026-11-01-evidence.md'), `The screenshot: ${old(shot)}\n`)
    for (const [from, to] of [
      [join(ws, '.combwork', 'assistant', '.combwork'), join(ws, '.combwork', 'assistant', OLD_DIR)],
      [join(ws, '.combwork'), join(ws, OLD_DIR)],
      [join(alpha, '.combwork'), join(alpha, OLD_DIR)]
    ])
      if (existsSync(from)) renameSync(from, to)
    // And its board's file under 1.0's name (HI-2587).
    for (const s of ['', '-wal', '-shm']) if (existsSync(join(ws, OLD_DIR, `combwork.db${s}`))) renameSync(join(ws, OLD_DIR, `combwork.db${s}`), join(ws, OLD_DIR, `${OLD_DB}${s}`))
    // 1.0 stored the attachment's link by its path, the comment's text and the context reference as written then.
    const db = new DatabaseSync(join(ws, OLD_DIR, OLD_DB))
    db.prepare('UPDATE cards SET description = ? WHERE number = ?').run(`![shot](${old(shot)})`, card.number)
    db.prepare('UPDATE card_comments SET text = ? WHERE card = ?').run(`See ${old(shot)}`, card.number)
    db.prepare('UPDATE card_context SET ref = ? WHERE card = ?').run(`${OLD_DIR}/shared/plan.md`, card.number)
    db.close()

    // Opened in this build.
    const w = createWorkspaceService()
    services.push(w)
    await w.open(ws)
    const now = await inWorkspace(w, () => tasks.getTask(card.number))
    expect(now.title).toBe('With evidence')
    expect(now.description).toBe(`![shot](${shot})`)
    expect(now.comments.map((c) => c.text)).toEqual([`See ${shot}`])
    expect(now.context).toEqual(['shared:plan.md'])
    expect(now.history.map((h) => JSON.stringify(h))).toEqual(history.map((h) => JSON.stringify(h)))
    const files = await inWorkspace(w, () => att.cardAttachments(w, card.number))
    expect(files.map((f) => f.path)).toEqual([shot])
    // The attachment's row as it was (its id, name, size and hash), its bytes as they were.
    expect(files.map(({ id, name, size, sha256 }) => ({ id, name, size, sha256 }))).toEqual(rows.map(({ id, name, size, sha256 }) => ({ id, name, size, sha256 })))
    // The conversation is found by the folder it recorded (its transcript's key, kept as it was), which leads to the slot's new place.
    const rec = await inWorkspace(w, () => w.sessionRecord(alpha, sessionId))
    expect(rec?.cwd).toBe(join(alpha, OLD_DIR, 'slots', 'HI-1'))
    const { movedPath } = await import('../src/main/combworkMove')
    expect(await movedPath(ws, rec!.cwd!)).toBe(slot)
    expect(existsSync(slot)).toBe(true)
    expect(readFileSync(shot, 'utf8')).toBe('png bytes')
    expect(readFileSync(join(ws, '.combwork', 'shared', 'plan.md'), 'utf8')).toBe('# Plan\n')
    expect(readFileSync(join(ws, '.combwork', 'shared', 'handovers', '2026-11-01-evidence.md'), 'utf8')).toBe(`The screenshot: ${shot}\n`)
    expect(JSON.parse(readFileSync(join(alpha, '.combwork', 'project.json'), 'utf8')).agents[0].id).toBe('a-coder')
    for (const d of [ws, alpha, join(ws, '.combwork', 'assistant')]) expect(readdirSync(d).filter((f) => f === OLD_DIR), d).toEqual([])
  })
})
