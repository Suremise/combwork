// HI-2462, HR1's finding 6: a workspace as Combwork 1.0.0 left it opens in this build with everything under .combwork.
// The board's schema is pinned to the released 1.0.0's: its migrations and schema sources at the v1.0.0 tag are this
// build's apart from comments (checked here against git, skipped where the tag isn't fetched). The workspace is made by
// the real services (a card with an attachment, a comment, context and its history; a shared note; a handover; the
// Assistant's home; a project), its folders then put back under 1.0's name with paths stored as 1.0 stored them, and
// opened by the real WorkspaceService: the move runs in its open, the cards' rewrite in its late phase. Then the board,
// the notes and the attachment are there, the stored paths point into .combwork, the history is as it was, and no .hive
// is left.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-move10-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const att = await import('../src/main/cardAttachments')

const ROOT = join(__dirname, '..')
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
/** Code without its comments and with the folder's name as 1.0 had it: what makes the schema. */
const code = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\.combwork/g, '.hive')
    .replace(/\s+/g, ' ')
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

describe("a 1.0.0 workspace opened in this build (HR1's finding 6)", () => {
  const tagged = atTag('src/main/boardStore.ts')

  it.skipIf(!tagged)("the board's schema is the released 1.0.0's, apart from comments", () => {
    const now = migrations(readFileSync(join(ROOT, 'src/main/boardStore.ts'), 'utf8'))
    expect(now.length).toBeGreaterThan(1000)
    expect(code(now)).toBe(code(migrations(tagged!)))
    const files = schemaFiles()
    expect(files.length).toBeGreaterThan(5)
    for (const f of files) expect(code(readFileSync(join(ROOT, f), 'utf8')), f).toBe(code(atTag(f) ?? ''))
  })

  it('opens with its board, notes, attachment and history, its paths in .combwork, no .hive left', async () => {
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
    await inWorkspace(first, () => first.upsertSession(alpha, { id: sessionId, agent: 'claude-code', agentId: 'a-coder', cwd: join(alpha, '.hive', 'slots', 'HI-1'), names: 2, name: 'x', lastActiveAt: '2026-11-01T00:00:00.000Z' }))
    mkdirSync(join(ws, '.combwork', 'shared', 'handovers'), { recursive: true })
    writeFileSync(join(ws, '.combwork', 'shared', 'plan.md'), '# Plan\n')
    await disposeWorkspaceService(first)
    store.closeAllBoards()
    const old = (p: string): string => p.replace(/\\\.combwork\\/g, '\\.hive\\')
    const shot = stored.path
    writeFileSync(join(ws, '.combwork', 'shared', 'handovers', '2026-11-01-evidence.md'), `The screenshot: ${old(shot)}\n`)
    for (const [from, to] of [
      [join(ws, '.combwork', 'assistant', '.combwork'), join(ws, '.combwork', 'assistant', '.hive')],
      [join(ws, '.combwork'), join(ws, '.hive')],
      [join(alpha, '.combwork'), join(alpha, '.hive')]
    ])
      if (existsSync(from)) renameSync(from, to)
    // And its board's file under 1.0's name (HI-2587).
    for (const s of ['', '-wal', '-shm']) if (existsSync(join(ws, '.hive', `combwork.db${s}`))) renameSync(join(ws, '.hive', `combwork.db${s}`), join(ws, '.hive', `hive.db${s}`))
    // 1.0 stored the attachment's link by its path, the comment's text and the context reference as written then.
    const db = new DatabaseSync(join(ws, '.hive', 'hive.db'))
    db.prepare('UPDATE cards SET description = ? WHERE number = ?').run(`![shot](${old(shot)})`, card.number)
    db.prepare('UPDATE card_comments SET text = ? WHERE card = ?').run(`See ${old(shot)}`, card.number)
    db.prepare('UPDATE card_context SET ref = ? WHERE card = ?').run('.hive/shared/plan.md', card.number)
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
    expect(rec?.cwd).toBe(join(alpha, '.hive', 'slots', 'HI-1'))
    const { movedPath } = await import('../src/main/combworkMove')
    expect(await movedPath(ws, rec!.cwd!)).toBe(slot)
    expect(existsSync(slot)).toBe(true)
    expect(readFileSync(shot, 'utf8')).toBe('png bytes')
    expect(readFileSync(join(ws, '.combwork', 'shared', 'plan.md'), 'utf8')).toBe('# Plan\n')
    expect(readFileSync(join(ws, '.combwork', 'shared', 'handovers', '2026-11-01-evidence.md'), 'utf8')).toBe(`The screenshot: ${shot}\n`)
    expect(JSON.parse(readFileSync(join(alpha, '.combwork', 'project.json'), 'utf8')).agents[0].id).toBe('a-coder')
    for (const d of [ws, alpha, join(ws, '.combwork', 'assistant')]) expect(readdirSync(d).filter((f) => f === '.hive'), d).toEqual([])
  })
})
