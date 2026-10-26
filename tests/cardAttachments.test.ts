// Card attachments (HI-1700), on the real board (a temp hive.db) with two projects: kept in the card's folder with a row
// each; the same bytes once; the limits checked up front and while streaming (a file that grows); a batch all or nothing;
// undone with the change; removed and deleted through the cards' trash, to the Recycle Bin once committed; a crash at any
// step settled at the next open from the operations' records and the committed board; a move copying the files; never a
// session's (the sessions' listing, Clean Up and Purge pass them by); and where a file may come from, by caller.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, sep } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { junction } from './pathAliases'

const base = tempDir('hive-cardattach-')
const trashDir = join(base, 'trash')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const att = await import('../src/main/cardAttachments')
const { advanced } = await import('../src/main/advanced')
const { planCleanup, planPurge } = await import('../src/shared/storage')
const { CARD_ATTACHMENT_MAX_ID } = await import('../src/shared/advanced')
const { attachmentMarkdown, attachmentRefs, escapeLinkText, withAttachmentPaths, withStoredIds } = await import('../src/shared/cardAttachments')

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

const user = { kind: 'user' } as const
let n = 0
/** A workspace with projects `p` and `q` (plain folders). */
async function workspace(): Promise<{ w: WS; root: string }> {
  const root = join(base, `ws-${++n}`)
  for (const p of ['p', 'q']) {
    mkdirSync(join(root, p, '.hive'), { recursive: true })
    writeFileSync(join(root, p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  }
  const w = createWorkspaceService()
  await w.open(root)
  opened.push(w)
  return { w, root }
}
const card = async (w: WS, project = 'p'): Promise<number> => (await inWorkspace(w, () => tasks.createTask({ title: `Card ${++n}`, project }, user))).number
const file = (dir: string, name: string, text: string): string => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), text)
  return join(dir, name)
}
const rows = (w: WS, c: number) => store.boardRead(w, (db) => db.prepare('SELECT id, file, name, comment FROM card_attachments WHERE card = ? ORDER BY at, file').all(c)) as { id: string; file: string; name: string; comment: string | null }[]
const trashed = (): string[] => {
  try {
    return readFileSync(join(trashDir, 'trash.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).from as string)
  } catch {
    return []
  }
}
const inside = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : [])

describe('keeping files with a card (HI-1700)', () => {
  it("copies a file into the card's folder, named by its number, with a row; the same bytes again give the one kept", async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const src = file(join(base, 'src'), 'shot.png', 'png bytes')
    const a = await inWorkspace(w, () => att.attachToCard(w, c, [{ path: src }], 'You'))
    expect(a.added).toEqual([true])
    const kept = a.attachments[0]
    expect(kept.path.startsWith(join(root, 'p', '.hive', 'attachments', 'cards', String(c)) + sep)).toBe(true)
    expect(kept.name).toBe('shot.png')
    expect(kept.kind).toBe('image')
    expect(readFileSync(kept.path, 'utf8')).toBe('png bytes')
    // The source stays (a copy), and the same bytes again, under another name or twice in one batch, keep one row.
    expect(existsSync(src)).toBe(true)
    const again = await inWorkspace(w, () => att.attachToCard(w, c, [{ path: file(join(base, 'src'), 'copy.png', 'png bytes') }, { data: new TextEncoder().encode('png bytes'), name: 'paste.png' }], 'You'))
    expect(again.added).toEqual([false, false])
    expect(again.attachments.map((x) => x.id)).toEqual([kept.id, kept.id])
    expect(rows(w, c)).toHaveLength(1)
    expect((await att.cardAttachments(w, c)).map((x) => x.id)).toEqual([kept.id])
  })

  it('refuses a batch whose later file is a folder, too large, or too many, and stores nothing; staging is left empty', async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const ok = file(join(base, 'src2'), 'a.txt', 'a')
    await expect(inWorkspace(w, () => att.attachToCard(w, c, [{ path: ok }, { path: join(base, 'src2') }], 'You'))).rejects.toThrow()
    await advanced.set(CARD_ATTACHMENT_MAX_ID, 1024 * 1024)
    const big = file(join(base, 'src2'), 'big.bin', 'x'.repeat(2 * 1024 * 1024))
    await expect(inWorkspace(w, () => att.attachToCard(w, c, [{ path: ok }, { path: big }], 'You'))).rejects.toThrow(/larger than/)
    await expect(inWorkspace(w, () => att.attachToCard(w, c, Array.from({ length: 11 }, () => ({ path: ok })), 'You'))).rejects.toThrow(/At most 10/)
    expect(rows(w, c)).toEqual([])
    expect(inside(join(root, 'p', '.hive', 'attachments', 'cards', '.staging'))).toEqual([])
  })

  it('stops a copy at the limit while streaming: a file that grew after it was checked fails, nothing published', async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    await advanced.set(CARD_ATTACHMENT_MAX_ID, 1024 * 1024)
    const max = advanced.get<number>(CARD_ATTACHMENT_MAX_ID)
    const growing = file(join(base, 'src3'), 'grows.log', 'start')
    // Checked small (its size up front is fine), then grown past the limit before the stream reads it.
    const staged = att.stage(join(root, 'p'), c, [{ path: growing }])
    appendFileSync(growing, 'y'.repeat(max + 10))
    await expect(staged).rejects.toThrow(/larger than/)
    expect(inside(join(root, 'p', '.hive', 'attachments', 'cards', '.staging'))).toEqual([])
    expect(rows(w, c)).toEqual([])
  })

  it('a publish undone with its change takes its files away again', async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const staging = await att.stage(join(root, 'p'), c, [{ data: new TextEncoder().encode('one'), name: 'one.txt' }])
    await expect(inWorkspace(w, () => store.boardWrite(w, async () => {
      await att.publish(w, c, staging, 'You', null)
      throw new Error('the rest of the change failed')
    }))).rejects.toThrow('the rest of the change failed')
    await staging.dispose()
    expect(rows(w, c)).toEqual([])
    expect(inside(join(root, 'p', '.hive', 'attachments', 'cards', String(c)))).toEqual([])
  })

  it('removes one through the cards’ trash, to the Recycle Bin once committed', async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const [a] = (await inWorkspace(w, () => att.attachToCard(w, c, [{ data: new TextEncoder().encode('bye'), name: 'bye.txt' }], 'You'))).attachments
    await inWorkspace(w, () => att.removeCardAttachment(w, c, a.id))
    expect(rows(w, c)).toEqual([])
    await expect.poll(() => trashed().some((t) => t.endsWith(a.file))).toBe(true)
    expect(inside(join(root, 'p', '.hive', 'attachments', 'cards', '.trash'))).toEqual([])
  })
})

describe('recovering what an interrupted operation left (HI-1700, s13)', () => {
  const { STAGING, TRASH, OP_FILE } = att.CARD_FOLDERS_FOR_TESTS

  it('a removal that crashed after its rename and before its commit is put back: the live card gets its file', async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const [a] = (await inWorkspace(w, () => att.attachToCard(w, c, [{ data: new TextEncoder().encode('keep me'), name: 'keep.txt' }], 'You'))).attachments
    // What removeCardAttachment does before its commit: the record, then the rename. Then the crash (the row stays).
    const op = join(root, 'p', '.hive', 'attachments', 'cards', TRASH, 'op1')
    mkdirSync(op, { recursive: true })
    writeFileSync(join(op, OP_FILE), JSON.stringify({ kind: 'remove', card: c, files: [{ id: a.id, file: a.file }] }))
    renameSync(a.path, join(op, a.file))
    const r = await inWorkspace(w, () => att.recoverCardAttachments(w))
    expect(r.restored).toBe(1)
    expect(readFileSync(a.path, 'utf8')).toBe('keep me')
    expect(existsSync(op)).toBe(false)
  })

  it('a removal that committed and then crashed finishes: the file goes to the Recycle Bin', async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const [a] = (await inWorkspace(w, () => att.attachToCard(w, c, [{ data: new TextEncoder().encode('go'), name: 'go.txt' }], 'You'))).attachments
    const op = join(root, 'p', '.hive', 'attachments', 'cards', TRASH, 'op2')
    mkdirSync(op, { recursive: true })
    writeFileSync(join(op, OP_FILE), JSON.stringify({ kind: 'remove', card: c, files: [{ id: a.id, file: a.file }] }))
    renameSync(a.path, join(op, a.file))
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare('DELETE FROM card_attachments WHERE card = ?').run(c)))
    const r = await inWorkspace(w, () => att.recoverCardAttachments(w))
    expect(r.binned).toBe(1)
    expect(existsSync(a.path)).toBe(false)
    expect(trashed().some((t) => t.endsWith(a.file))).toBe(true)
  })

  it("a card's deletion that crashed before its commit gives the live card its folder back; one whose card is gone, to the Recycle Bin", async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const [a] = (await inWorkspace(w, () => att.attachToCard(w, c, [{ data: new TextEncoder().encode('folder'), name: 'f.txt' }], 'You'))).attachments
    const cards = join(root, 'p', '.hive', 'attachments', 'cards')
    const op = join(cards, TRASH, 'op3')
    mkdirSync(op, { recursive: true })
    writeFileSync(join(op, OP_FILE), JSON.stringify({ kind: 'delete', card: c }))
    renameSync(join(cards, String(c)), join(op, 'files'))
    await inWorkspace(w, () => att.recoverCardAttachments(w))
    expect(readFileSync(a.path, 'utf8')).toBe('folder')
    // A record nobody can read is left alone, never removed by its age.
    const unreadable = join(cards, TRASH, 'op4')
    mkdirSync(unreadable, { recursive: true })
    writeFileSync(join(unreadable, 'x.txt'), 'x')
    const r = await inWorkspace(w, () => att.recoverCardAttachments(w))
    expect(r.left).toBe(1)
    expect(existsSync(join(unreadable, 'x.txt'))).toBe(true)
  })

  it('staging goes; a file with no row goes to the Recycle Bin; a folder of a card that is gone goes too', async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const cards = join(root, 'p', '.hive', 'attachments', 'cards')
    file(join(cards, STAGING, 'opx'), '0.part', 'half')
    const stray = file(join(cards, String(c)), 'stray.txt', 'no row')
    file(join(cards, '999999'), 'orphan.txt', 'no card')
    await inWorkspace(w, () => att.recoverCardAttachments(w))
    expect(inside(join(cards, STAGING))).toEqual([])
    expect(existsSync(stray)).toBe(false)
    expect(existsSync(join(cards, '999999'))).toBe(false)
  })
})

describe('moving and deleting a card with attachments (HI-1700)', () => {
  it('a move copies the files to the new project, the old folder going once committed; undone, the copies go', async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const [a] = (await inWorkspace(w, () => att.attachToCard(w, c, [{ data: new TextEncoder().encode('moving'), name: 'm.txt' }], 'You'))).attachments
    const to = join(root, 'q', '.hive', 'attachments', 'cards', String(c), a.file)
    // Undone: the copy goes, the original stays.
    await expect(inWorkspace(w, () => store.boardWrite(w, async () => {
      await att.moveCardFolder(w, c, 'p', 'q')
      throw new Error('the move failed later')
    }))).rejects.toThrow()
    expect(existsSync(to)).toBe(false)
    expect(existsSync(a.path)).toBe(true)
    // Through the board's move: the files follow the card.
    await inWorkspace(w, () => tasks.updateTask(c, { project: 'q' }, user))
    expect(readFileSync(to, 'utf8')).toBe('moving')
    await expect.poll(() => existsSync(a.path)).toBe(false)
    expect((await att.cardAttachments(w, c))[0].path).toBe(to)
  })

  it("deleting a card sends its folder to the Recycle Bin; archiving keeps it", async () => {
    const { w } = await workspace()
    const c = await card(w)
    const [a] = (await inWorkspace(w, () => att.attachToCard(w, c, [{ data: new TextEncoder().encode('d'), name: 'd.txt' }], 'You'))).attachments
    await inWorkspace(w, () => tasks.archiveTask(c, true))
    expect(existsSync(a.path)).toBe(true)
    await inWorkspace(w, () => tasks.deleteTask(c))
    await expect.poll(() => existsSync(a.path)).toBe(false)
    expect(trashed().some((t) => t.endsWith(`${sep}${c}`) || t.includes(`${sep}files`))).toBe(true)
  })
})

describe("never a session's (HI-1700)", () => {
  it("Clean Up with every option and Purge leave the cards' folder alone", () => {
    const facts = { sessions: [], attachmentFolders: [{ name: 'cards', path: 'C:\\x\\.hive\\attachments\\cards', bytes: 5 }], liveNames: new Set<string>(), now: Date.now() }
    expect(planCleanup(facts, { archivedAttachmentsDays: 0, orphanAttachments: true, archivedBackupsDays: 0, goneBackups: true })).toEqual([])
    const purge = planPurge({ host: 'C:\\x', hostName: 'x', sessions: [], files: [], attachmentFolders: [{ name: 'cards', path: 'C:\\x\\.hive\\attachments\\cards', files: [{ path: 'C:\\x\\.hive\\attachments\\cards\\a.txt', bytes: 1, mtimeMs: 1 }] }], deletedUsage: [], liveNames: new Set() })
    expect(purge.items).toEqual([])
  })
})

describe('where a file may come from (HI-1700, s13 §2)', () => {
  it("a project's agent: its project, its slots and the temp folder; never another project's, nested or through a junction, nor Hive's own folders", async () => {
    const { w, root } = await workspace()
    const agent = { kind: 'agent', project: 'p' } as const
    const own = file(join(root, 'p', 'src'), 'mine.png', 'mine')
    const slot = file(join(w.worktreesRoot, 'p', 'slot-a'), 'slot.png', 'slot')
    const shot = file(tempDir('hive-shot-'), 'screenshot.png', 'shot')
    for (const ok of [own, slot, shot]) expect(await att.attachableSource(w, agent, ok)).toBeTruthy()
    // Another project: refused, though the test workspace is itself in the temp folder.
    await expect(att.attachableSource(w, agent, file(join(root, 'q'), 'theirs.png', 'theirs'))).rejects.toThrow(/not a file that can be attached/)
    // Another project nested inside the caller's own: protected first.
    mkdirSync(join(root, 'p', 'nested'), { recursive: true })
    junction(join(root, 'q'), join(root, 'p', 'nested', 'q-link'))
    await expect(att.attachableSource(w, agent, join(root, 'p', 'nested', 'q-link', 'theirs.png'))).rejects.toThrow(/not a file that can be attached/)
    // The Assistant's home and the workspace's .hive; a project's .hive but its attachments; a folder; nothing there.
    await expect(att.attachableSource(w, agent, file(join(w.assistantHome, '.hive', 'attachments', 's1'), 'a.png', 'a'))).rejects.toThrow()
    await expect(att.attachableSource(w, agent, file(join(root, '.hive'), 'x.txt', 'x'))).rejects.toThrow()
    await expect(att.attachableSource(w, agent, join(root, 'p', '.hive', 'project.json'))).rejects.toThrow()
    expect(await att.attachableSource(w, agent, file(join(root, 'p', '.hive', 'attachments', 's1'), 'pasted.png', 'p'))).toBeTruthy()
    await expect(att.attachableSource(w, agent, join(root, 'p'))).rejects.toThrow()
    await expect(att.attachableSource(w, agent, join(root, 'p', 'nothing.png'))).rejects.toThrow(/not a file that can be attached/)
  })

  it("the Assistant and scripts: the workspace, the projects' folders, its home and the temp folder; a .hive only through attachments", async () => {
    const { w, root } = await workspace()
    const ws = { kind: 'workspace' } as const
    expect(await att.attachableSource(w, ws, file(join(root, 'q'), 'theirs.png', 't'))).toBeTruthy()
    expect(await att.attachableSource(w, ws, file(join(w.assistantHome, '.hive', 'attachments', 's1'), 'pasted.png', 'a'))).toBeTruthy()
    await expect(att.attachableSource(w, ws, join(root, 'q', '.hive', 'project.json'))).rejects.toThrow()
  })

  it("Attach to card from a pane: only that host's session attachments", async () => {
    const { w, root } = await workspace()
    const pane = { kind: 'pane', host: join(root, 'p') } as const
    expect(await att.attachableSource(w, pane, file(join(root, 'p', '.hive', 'attachments', 's1'), 'x.png', 'x'))).toBeTruthy()
    await expect(att.attachableSource(w, pane, file(join(root, 'q', '.hive', 'attachments', 's1'), 'y.png', 'y'))).rejects.toThrow()
    await expect(att.attachableSource(w, pane, file(join(root, 'p'), 'z.png', 'z'))).rejects.toThrow()
  })
})

describe("attachment links in a card's text (HI-1700)", () => {
  it('escapes names, finds references, gives drafts their stored ids and agents the paths', () => {
    expect(escapeLinkText('a [b]*c_<d>`.png')).toBe('a \\[b\\]\\*c\\_\\<d\\>\\`.png')
    expect(attachmentMarkdown('shot.png', 'image', 'attachment:abc')).toBe('![shot.png](attachment:abc)')
    expect(attachmentMarkdown('log.txt', 'text', 'attachment:abc')).toBe('[log.txt](attachment:abc)')
    const text = 'See ![s](attachment:draft-1) and [l](attachment:0123456789ab), again ![s](attachment:draft-1).'
    expect(attachmentRefs(text)).toEqual(['draft-1', '0123456789ab'])
    const stored = withStoredIds(text, new Map([['draft-1', 'aaaaaaaaaaaa']]))
    expect(attachmentRefs(stored)).toEqual(['aaaaaaaaaaaa', '0123456789ab'])
    expect(withAttachmentPaths(stored, [{ id: 'aaaaaaaaaaaa', path: 'C:\\w\\p\\.hive\\attachments\\cards\\1\\s.png' }])).toBe('See ![s](C:\\w\\p\\.hive\\attachments\\cards\\1\\s.png) and [l](attachment removed), again ![s](C:\\w\\p\\.hive\\attachments\\cards\\1\\s.png).')
  })
})
