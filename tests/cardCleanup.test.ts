// Archived cards' attachments cleaned up (HI-1842, Darren's decisions of 27 Oct 2026), on the real board (a temp combwork.db):
// only archived cards, the project's days after archiving (30 by default, Never keeps them); open and Done cards keep theirs,
// as do cards brought back from the archive, or archived with their hidden or removed project. Round 2 (HR5's review): a
// plan and an apply that checks it again in each card's change: only planned files
// still the same on disk, in a folder of the project's own (never through a junction), of a card still archived in the
// planned project and due under the project's setting now; a plan kept for Clean Up Now is used once, within its
// workspace's lifetime; the plan's candidates leave out cards that can never be due; the automatic run waits for an idle PC.
// Round 3 (no worker, Darren's decision): a project hidden or removed since the plan keeps its cards' files; one listener
// per workspace lifetime, however many previews and queueings.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { getEventListeners } from 'events'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { junction } from './pathAliases'

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
const idle = () => true
let n = 0
/** A workspace folder with projects p and q (their clean-up as given: none is the default, 30 days). */
function folder(p?: string, q?: string): string {
  const root = join(base, `ws-${++n}`)
  for (const [name, choice] of [['p', p], ['q', q]] as const) {
    mkdirSync(join(root, name, '.combwork'), { recursive: true })
    writeFileSync(join(root, name, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [], ...(choice ? { cardAttachmentCleanup: choice } : {}) }))
  }
  return root
}
async function workspace(p?: string, q?: string): Promise<{ w: WS; root: string; p: string; q: string }> {
  const root = folder(p, q)
  const w = createWorkspaceService()
  await w.open(root)
  opened.push(w)
  return { w, root, p: join(root, 'p'), q: join(root, 'q') }
}
/** A card with files attached (`column`, archived or not, in `project`). */
async function card(w: WS, opts: { column?: 'todo' | 'done'; archived?: boolean; files?: string[]; project?: string } = {}): Promise<{ n: number; paths: string[] }> {
  const c = (await inWorkspace(w, () => tasks.createTask({ title: `Card ${++n}`, project: opts.project ?? 'p', column: opts.column ?? 'todo' }, user))).number
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
const preview = (w: WS, p: string, days: number) => inWorkspace(w, () => cleanup.cardCleanupPreview(p, w, later(days)))
const apply = (w: WS, p: string, plan: string, days: number) => inWorkspace(w, () => cleanup.applyCleanupPlan(p, plan, w, later(days)))
const run = (w: WS, p: string, days: number) => inWorkspace(w, () => cleanup.cleanUpProject(w, p, { idle, now: later(days) }))

describe('the rules (shared/cardCleanup.ts)', () => {
  it('a choice in days: 3, 7, 30 or 90; Never is off; anything else the default, 30', () => {
    expect(['3', '7', '30', '90'].map(cleanupDays)).toEqual([3, 7, 30, 90])
    expect(cleanupDays('off')).toBeNull()
    expect(cleanupDays(undefined)).toBe(30)
    expect(cleanupDays('12')).toBe(30)
  })

  it('when a card was archived: its latest archive line, else its last change; due only archived, not with its project, past the days', () => {
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
    expect(cleanupDue(c, 3, t, 1000)).toBe(true)
  })
})

describe("cleaning up archived cards' attachments (HI-1842)", () => {
  it("an archived card's files go to the Recycle Bin after the days, rows and all, with Combwork's comment; open and Done cards keep theirs", async () => {
    const { w, p } = await workspace()
    const archived = await card(w, { archived: true })
    const open = await card(w)
    const done = await card(w, { column: 'done' })
    expect((await preview(w, p, 29)).items).toEqual([])
    expect(await run(w, p, 29)).toEqual({ cards: 0, files: 0, bytes: 0, left: 0 })
    const shown = await preview(w, p, 31)
    expect(shown.items.map((i) => [i.card, i.files.map((f) => f.name).sort()])).toEqual([[archived.n, ['run.log', 'shot.png']]])
    expect(shown.items[0].key).toBe(store.cardKeys(w, [archived.n]).get(archived.n) ?? null)
    expect(shown.more).toBe(false)
    const r = await apply(w, p, shown.plan!, 31)
    expect(r).toMatchObject({ cards: 1, files: 2, left: 0 })
    expect(r.bytes).toBeGreaterThan(0)
    expect(rows(w, archived.n)).toBe(0)
    expect(archived.paths.every((f) => !existsSync(f))).toBe(true)
    await expect.poll(() => archived.paths.every((f) => trashed().some((t) => t.endsWith(f.split(/[\\/]/).pop()!)))).toBe(true)
    const after = await inWorkspace(w, () => tasks.getTask(archived.n))
    expect(after.archived).toBe(true)
    const said = after.comments.at(-1)!
    expect(said.by).toBe('Combwork')
    expect(said.text).toMatch(/^Removed 2 attachments \(.*shot\.png.*\): this project removes archived cards' attachments 30 days after archiving \(Project Settings → Storage\)\. They are in the Recycle Bin\.$/)
    expect(said.appText).toBeTruthy()
    expect([rows(w, open.n), rows(w, done.n)]).toEqual([2, 2])
    expect([...open.paths, ...done.paths].every((f) => existsSync(f))).toBe(true)
    // Used once: its Move again is refused, and the automatic run finds nothing more.
    await expect(apply(w, p, shown.plan!, 31)).rejects.toThrow(/out of date/)
    expect((await run(w, p, 31)).cards).toBe(0)
    expect((await inWorkspace(w, () => tasks.getTask(archived.n))).comments.filter((c) => c.by === 'Combwork').length).toBe(1)
  })

  it('follows the project: 3 days removes sooner; Never keeps them', async () => {
    const soon = await workspace('3')
    const a = await card(soon.w, { archived: true, files: ['a.txt'] })
    expect((await run(soon.w, soon.p, 4)).files).toBe(1)
    expect(rows(soon.w, a.n)).toBe(0)
    const never = await workspace('off')
    const b = await card(never.w, { archived: true, files: ['b.txt'] })
    expect(await preview(never.w, never.p, 400)).toEqual({ plan: null, items: [], more: false })
    expect((await run(never.w, never.p, 400)).files).toBe(0)
    expect(rows(never.w, b.n)).toBe(1)
  })

  it('only the files planned go: one attached after the preview stays', async () => {
    const { w, p } = await workspace()
    const c = await card(w, { archived: true, files: ['planned.txt'] })
    const shown = await preview(w, p, 31)
    const late = join(base, `late-${n}.txt`)
    writeFileSync(late, 'attached after the preview')
    await inWorkspace(w, () => att.attachToCard(w, c.n, [{ path: late }], 'You'))
    expect(await apply(w, p, shown.plan!, 31)).toMatchObject({ cards: 1, files: 1, left: 0 })
    expect((await inWorkspace(w, () => att.cardAttachments(w, c.n))).map((a) => a.name)).toEqual([late.split(/[\\/]/).pop()])
  })

  it('a file changed on disk after the preview stays, row and all: the apply checks the file itself, not its row', async () => {
    const { w, p } = await workspace()
    const c = await card(w, { archived: true, files: ['changed.txt', 'same.txt'] })
    const shown = await preview(w, p, 31)
    const changed = c.paths.find((f) => f.endsWith('changed.txt'))!
    writeFileSync(changed, 'replaced on disk with other bytes, longer than before')
    expect(await apply(w, p, shown.plan!, 31)).toMatchObject({ cards: 1, files: 1, left: 1 })
    expect(existsSync(changed)).toBe(true)
    expect((await inWorkspace(w, () => att.cardAttachments(w, c.n))).map((a) => a.name)).toEqual(['changed.txt'])
  })

  it("a card's folder that is a junction is never followed: what it leads to stays, and so do its rows", async () => {
    const { w, root, p } = await workspace()
    const c = await card(w, { archived: true, files: ['x.txt'] })
    const folderOf = join(root, 'p', '.combwork', 'attachments', 'cards', String(c.n))
    const outside = join(base, `outside-${n}`)
    cpSync(folderOf, outside, { recursive: true })
    renameSync(folderOf, join(base, `moved-${n}`))
    junction(outside, folderOf)
    const outsideFile = join(outside, c.paths[0].split(/[\\/]/).pop()!)
    // The plan leaves it out; an apply of a plan made before the folder was swapped leaves it too.
    expect((await preview(w, p, 31)).items).toEqual([])
    expect((await run(w, p, 31)).files).toBe(0)
    expect(existsSync(outsideFile)).toBe(true)
    expect(rows(w, c.n)).toBe(1)
  })

  it('the folder swapped for a junction between the preview and its Move: nothing moves', async () => {
    const { w, root, p } = await workspace()
    const c = await card(w, { archived: true, files: ['y.txt'] })
    const shown = await preview(w, p, 31)
    const folderOf = join(root, 'p', '.combwork', 'attachments', 'cards', String(c.n))
    const outside = join(base, `outside-${n}`)
    cpSync(folderOf, outside, { recursive: true })
    renameSync(folderOf, join(base, `moved-${n}`))
    junction(outside, folderOf)
    expect(await apply(w, p, shown.plan!, 31)).toMatchObject({ cards: 0, files: 0, left: 1 })
    expect(existsSync(join(outside, c.paths[0].split(/[\\/]/).pop()!))).toBe(true)
    expect(rows(w, c.n)).toBe(1)
  })

  it('a card brought back, moved to a project that keeps its files, or under a setting changed to Never since the preview: left', async () => {
    const { w, p } = await workspace(undefined, 'off')
    const back = await card(w, { archived: true, files: ['back.txt'] })
    const moved = await card(w, { archived: true, files: ['moved.txt'] })
    const shown = await preview(w, p, 31)
    await inWorkspace(w, () => tasks.archiveTask(back.n, false))
    await inWorkspace(w, async () => {
      await tasks.archiveTask(moved.n, false)
      await tasks.updateTask(moved.n, { project: 'q' }, user)
      await tasks.archiveTask(moved.n, true)
    })
    expect(await apply(w, p, shown.plan!, 31)).toMatchObject({ cards: 0, files: 0, left: 2 })
    expect([rows(w, back.n), rows(w, moved.n)]).toEqual([1, 1])
    // The setting changed to Never between the preview and its Move.
    const due = await card(w, { archived: true, files: ['due.txt'] })
    const again = await preview(w, p, 31)
    expect(again.items.map((i) => i.card)).toEqual([due.n])
    await w.mutateProjectConfig(p, () => ({ cardAttachmentCleanup: 'off' }))
    expect(await apply(w, p, again.plan!, 31)).toMatchObject({ cards: 0, left: 1 })
    expect(rows(w, due.n)).toBe(1)
  })

  it("a workspace switched after the preview or the queueing: the old plan is refused and the old run never touches the new workspace's cards", async () => {
    const { w, p } = await workspace('3')
    await card(w, { archived: true, files: ['a-side.txt'] })
    const shown = await preview(w, p, 31)
    cleanup.queueCleanup(w)
    // The window opens another workspace, with a due card of the same number in a project of the same name.
    const other = folder('3')
    await w.open(other)
    const b = await card(w, { archived: true, files: ['b-side.txt'] })
    await expect(apply(w, join(other, 'p'), shown.plan!, 31)).rejects.toThrow(/out of date/)
    await expect(apply(w, p, shown.plan!, 31)).rejects.toThrow(/out of date/)
    // The old lifetime's queued run is gone with it: a tick (idle) runs nothing for it.
    await cleanup.tick(idle)
    expect(rows(w, b.n)).toBe(1)
  })

  it('the plan leaves out cards that can never be due, so they never use up a batch; each batch is bounded', async () => {
    const { w, p } = await workspace()
    const kept: number[] = []
    for (let i = 0; i < 6; i++) kept.push((await card(w, { archived: true, files: [`k${i}.txt`] })).n)
    // Archived with their project hidden (restoring it brings them back): never due.
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare(`UPDATE cards SET archived_for = 'project-hidden' WHERE number IN (${kept.join(',')})`).run()))
    const due = await card(w, { archived: true, files: ['due.txt'] })
    // Two cards examined at most, one planned: the six ahead don't count.
    const first = await inWorkspace(w, () => cleanup.planBatch(w, p, 0, later(31), 1, 2))
    expect(first?.cards.map((c) => c.card)).toEqual([due.n])
    expect(first?.cards[0].files[0].identity).toMatchObject({ dev: expect.any(String), ino: expect.any(String) })
    // From the cursor: nothing after it.
    expect(await inWorkspace(w, () => cleanup.planBatch(w, p, due.n, later(31), 1, 2))).toMatchObject({ cards: [], more: false })
    expect((await run(w, p, 31)).files).toBe(1)
    expect(kept.every((k) => rows(w, k) === 1)).toBe(true)
  })

  it('the automatic run waits for an idle PC, and a paused run stays queued until it has run', async () => {
    const { w, p } = await workspace('3')
    const c = await card(w, { archived: true, files: ['auto.txt'] })
    cleanup.queueCleanup(w)
    // The PC in use: nothing runs, and it stays queued.
    await cleanup.tick(() => false, later(4))
    expect(rows(w, c.n)).toBe(1)
    // Idle: it runs, 4 days on.
    await inWorkspace(w, () => cleanup.tick(idle, later(4)))
    expect(rows(w, c.n)).toBe(0)
    expect(p).toBeTruthy()
  })

  it('input while it plans pauses it at once, even through cards not due yet; idle again, it carries on from there', async () => {
    const { w, p } = await workspace('3')
    const cs: number[] = []
    for (let i = 0; i < 3; i++) cs.push((await card(w, { archived: true, files: [`i${i}.txt`] })).n)
    // The PC in use again after the first card is read: the batch stops there, though no card is due yet.
    let asked = 0
    const batch = await inWorkspace(w, () => cleanup.planBatch(w, p, 0, later(1), 20, 100, () => asked++ < 1))
    expect(batch).toMatchObject({ paused: true, last: cs[0], cards: [] })
    // The automatic run: asked before its batch and after each card's yield; in use after the first card, it stops.
    let calls = 0
    expect(await inWorkspace(w, () => cleanup.cleanUpProject(w, p, { idle: () => calls++ < 2, now: later(1) }))).toMatchObject({ files: 0, stopped: true })
    expect(calls).toBe(3)
    // Idle again (and due): it carries on from where it stopped, round to the start, and every card's file goes.
    expect((await run(w, p, 4)).files).toBe(3)
    expect(cs.every((c) => rows(w, c) === 0)).toBe(true)
  })

  it("a project hidden or removed between the preview and its Move keeps its cards' files", async () => {
    const { w, p } = await workspace()
    const c = await card(w, { archived: true, files: ['hidden.txt'] })
    for (const mode of ['hidden', 'removed'] as const) {
      const shown = await preview(w, p, 31)
      expect(shown.items.map((i) => i.card)).toEqual([c.n])
      await w.setHidden('p', mode)
      expect(await apply(w, p, shown.plan!, 31)).toMatchObject({ cards: 0, files: 0, left: 1 })
      expect(rows(w, c.n)).toBe(1)
      await w.setHidden('p', null)
    }
  })

  it('one abort listener per workspace lifetime, however many previews and queueings', async () => {
    const { w, p } = await workspace()
    await card(w, { archived: true, files: ['l.txt'] })
    await preview(w, p, 31)
    const one = getEventListeners(w.lifetime, 'abort').length
    for (let i = 0; i < 15; i++) await preview(w, p, 31)
    cleanup.queueCleanup(w)
    cleanup.queueCleanup(w)
    expect(getEventListeners(w.lifetime, 'abort').length).toBe(one)
  })
})
