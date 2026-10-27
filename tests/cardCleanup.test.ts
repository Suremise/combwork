// Archived cards' attachments cleaned up (HI-1842, Darren's decisions of 27 Oct 2026), on the real board (a temp hive.db):
// only archived cards, the project's days after archiving (30 by default, Off keeps them); open and Done cards keep theirs,
// as do cards brought back from the archive, or archived with their hidden or removed project. Each card's files go through
// the cards' trash to the Recycle Bin (here the suite's trash folder), their rows with them, and the card gets a comment of
// Hive's saying how many and which. Clean Up Now removes what its preview listed, each card checked again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-cardcleanup-')
const trashDir = join(base, 'trash')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const att = await import('../src/main/cardAttachments')
const cleanup = await import('../src/main/cardAttachmentCleanup')
const { advanced } = await import('../src/main/advanced')
const { archivedSince, cleanupDays, cleanupDue } = await import('../src/shared/cardCleanup')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
beforeAll(() => {
  process.env.HIVE_TEST_TRASH_DIR = trashDir
})
afterAll(async () => {
  delete process.env.HIVE_TEST_TRASH_DIR
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const DAY = 86_400_000
const user = { kind: 'user' } as const
let n = 0
/** A workspace with project `p` (its clean-up as given: none is the default, 30 days). */
async function workspace(choice?: string): Promise<{ w: WS; p: string }> {
  const root = join(base, `ws-${++n}`)
  mkdirSync(join(root, 'p', '.hive'), { recursive: true })
  writeFileSync(join(root, 'p', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [], ...(choice ? { cardAttachmentCleanup: choice } : {}) }))
  const w = createWorkspaceService()
  await w.open(root)
  opened.push(w)
  return { w, p: join(root, 'p') }
}
/** A card of p with files attached (`column`, and archived or not). */
async function card(w: WS, opts: { column?: 'todo' | 'done'; archived?: boolean; files?: string[] } = {}): Promise<{ n: number; paths: string[] }> {
  const c = (await inWorkspace(w, () => tasks.createTask({ title: `Card ${++n}`, project: 'p', column: opts.column ?? 'todo' }, user))).number
  const src = join(base, `src-${n}`)
  mkdirSync(src, { recursive: true })
  const sources = (opts.files ?? ['shot.png', 'run.log']).map((name) => {
    writeFileSync(join(src, name), `${name} of #${c}`)
    return { path: join(src, name) }
  })
  const kept = await inWorkspace(w, () => att.attachToCard(w, c, sources, 'You'))
  if (opts.archived) await inWorkspace(w, () => tasks.archiveTask(c, true))
  return { n: c, paths: kept.attachments.map((a) => a.path) }
}
const rows = (w: WS, c: number): number => (store.boardRead(w, (db) => db.prepare('SELECT count(*) AS n FROM card_attachments WHERE card = ?').get(c)) as { n: number }).n
const trashed = (): string[] => {
  try {
    return readFileSync(join(trashDir, 'trash.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).from as string)
  } catch {
    return []
  }
}
const later = (days: number): number => Date.now() + days * DAY

describe('the rules (shared/cardCleanup.ts)', () => {
  it('a choice in days: 3, 7, 30 or 90; Never is off; anything else the default, 30', () => {
    expect(['3', '7', '30', '90'].map(cleanupDays)).toEqual([3, 7, 30, 90])
    expect(cleanupDays('off')).toBeNull()
    expect(cleanupDays(undefined)).toBe(30)
    expect(cleanupDays('12')).toBe(30)
  })

  it("when a card was archived: its latest archive line, else its last change; due only archived, not with its project, past the days", () => {
    const at = (iso: string, what: string) => ({ at: iso, by: 'You', what })
    const c = { archived: true, updatedAt: '2026-10-20T00:00:00Z', history: [at('2026-09-01T00:00:00Z', 'Archived'), at('2026-09-05T00:00:00Z', 'Brought back from the archive'), at('2026-10-01T00:00:00Z', 'Archived in a batch of 3 (All in Done)')] }
    expect(archivedSince(c)).toBe(Date.parse('2026-10-01T00:00:00Z'))
    expect(archivedSince({ ...c, history: [] })).toBe(Date.parse('2026-10-20T00:00:00Z'))
    const t = Date.parse('2026-10-31T00:00:00Z')
    expect(cleanupDue(c, 30, t)).toBe(true)
    expect(cleanupDue(c, 90, t)).toBe(false)
    expect(cleanupDue(c, null, t)).toBe(false)
    expect(cleanupDue({ ...c, archived: false }, 3, t)).toBe(false)
    expect(cleanupDue({ ...c, archivedFor: 'project-hidden' }, 3, t)).toBe(false)
    expect(cleanupDue({ ...c, archivedFor: 'project-removed' }, 3, t)).toBe(false)
    expect(cleanupDue({ ...c, archivedFor: 'done' }, 3, t)).toBe(true)
  })
})

describe("cleaning up archived cards' attachments (HI-1842)", () => {
  it("an archived card's files go to the Recycle Bin after the days, rows and all, with Hive's comment; open and Done cards keep theirs", async () => {
    const { w, p } = await workspace()
    const archived = await card(w, { archived: true })
    const open = await card(w)
    const done = await card(w, { column: 'done' })
    // Not yet: 29 days on.
    expect(await cleanup.cardCleanupPreview(p, w, later(29))).toEqual([])
    expect(await inWorkspace(w, () => cleanup.cleanUpCardAttachments(p, { now: later(29) }, w))).toEqual({ cards: 0, files: 0, bytes: 0 })
    expect(rows(w, archived.n)).toBe(2)
    // 31 days on: the archived card is listed, with its files, and only it.
    const preview = await cleanup.cardCleanupPreview(p, w, later(31))
    expect(preview.map((i) => [i.card, i.files.map((f) => f.name).sort()])).toEqual([[archived.n, ['run.log', 'shot.png']]])
    expect(preview[0].key).toBe(store.cardKeys(w, [archived.n]).get(archived.n) ?? null)
    const r = await inWorkspace(w, () => cleanup.cleanUpCardAttachments(p, { now: later(31) }, w))
    expect(r.cards).toBe(1)
    expect(r.files).toBe(2)
    expect(r.bytes).toBeGreaterThan(0)
    expect(rows(w, archived.n)).toBe(0)
    expect(archived.paths.every((f) => !existsSync(f))).toBe(true)
    await expect.poll(() => archived.paths.every((f) => trashed().some((t) => t.endsWith(f.split(/[\\/]/).pop()!)))).toBe(true)
    const after = await inWorkspace(w, () => tasks.getTask(archived.n))
    expect(after.archived).toBe(true)
    const said = after.comments.at(-1)!
    expect(said.by).toBe('Hive')
    expect(said.text).toMatch(/^Removed 2 attachments \(.*shot\.png.*\): this project removes archived cards' attachments 30 days after archiving \(Project Settings → Storage\)\. They are in the Recycle Bin\.$/)
    expect(said.hiveText).toBeTruthy()
    expect(await inWorkspace(w, () => att.cardAttachments(w, archived.n))).toEqual([])
    // Open and Done cards keep theirs.
    expect([rows(w, open.n), rows(w, done.n)]).toEqual([2, 2])
    expect([...open.paths, ...done.paths].every((f) => existsSync(f))).toBe(true)
    // Again: nothing more to do, no second comment.
    expect((await inWorkspace(w, () => cleanup.cleanUpCardAttachments(p, { now: later(31) }, w))).cards).toBe(0)
    expect((await inWorkspace(w, () => tasks.getTask(archived.n))).comments.filter((c) => c.by === 'Hive').length).toBe(1)
  })

  it('follows the project: 3 days removes sooner; Never keeps them', async () => {
    const soon = await workspace('3')
    const a = await card(soon.w, { archived: true, files: ['a.txt'] })
    expect((await inWorkspace(soon.w, () => cleanup.cleanUpCardAttachments(soon.p, { now: later(4) }, soon.w))).files).toBe(1)
    expect(rows(soon.w, a.n)).toBe(0)
    const never = await workspace('off')
    const b = await card(never.w, { archived: true, files: ['b.txt'] })
    expect(await cleanup.cardCleanupPreview(never.p, never.w, later(400))).toEqual([])
    expect((await inWorkspace(never.w, () => cleanup.cleanUpCardAttachments(never.p, { now: later(400) }, never.w))).files).toBe(0)
    expect(rows(never.w, b.n)).toBe(1)
  })

  it('a card brought back from the archive keeps its files; Clean Up Now leaves a card listed that is no longer due', async () => {
    const { w, p } = await workspace()
    const back = await card(w, { archived: true, files: ['back.txt'] })
    const listed = await card(w, { archived: true, files: ['listed.txt'] })
    const gone = await card(w, { archived: true, files: ['gone.txt'] })
    await inWorkspace(w, () => tasks.archiveTask(back.n, false))
    const preview = await cleanup.cardCleanupPreview(p, w, later(31))
    expect(preview.map((i) => i.card).sort()).toEqual([listed.n, gone.n].sort())
    // Brought back after the preview: Clean Up Now passes it by.
    await inWorkspace(w, () => tasks.archiveTask(listed.n, false))
    const r = await inWorkspace(w, () => cleanup.cleanUpCardAttachments(p, { only: preview.map((i) => i.card), now: later(31) }, w))
    expect(r).toMatchObject({ cards: 1, files: 1 })
    expect([rows(w, back.n), rows(w, listed.n), rows(w, gone.n)]).toEqual([1, 1, 0])
  })

  it('a whole workspace in one run; a run asked for while one is under way joins it', async () => {
    const { w } = await workspace('3')
    await card(w, { archived: true, files: ['x.txt'] })
    const r = await cleanup.cleanUpWorkspace(w, later(4))
    expect(r.files).toBe(1)
    const first = cleanup.cleanUpSoon(w)
    expect(cleanup.cleanUpSoon(w)).toBe(first)
    await first
  })
})
