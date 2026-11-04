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
const { AGENT_TEMP_FOLDER_ID, CARD_ATTACHMENT_FOLDERS_ID, CARD_ATTACHMENT_MAX_ID, advancedDef, advancedText, checkAdvanced, folderList, foldersText } = await import('../src/shared/advanced')
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
    mkdirSync(join(root, p, '.combwork'), { recursive: true })
    writeFileSync(join(root, p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
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
    expect(kept.path.startsWith(join(root, 'p', '.combwork', 'attachments', 'cards', String(c)) + sep)).toBe(true)
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
    expect(inside(join(root, 'p', '.combwork', 'attachments', 'cards', '.staging'))).toEqual([])
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
    expect(inside(join(root, 'p', '.combwork', 'attachments', 'cards', '.staging'))).toEqual([])
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
    expect(inside(join(root, 'p', '.combwork', 'attachments', 'cards', String(c)))).toEqual([])
  })

  it('removes one through the cards’ trash, to the Recycle Bin once committed', async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const [a] = (await inWorkspace(w, () => att.attachToCard(w, c, [{ data: new TextEncoder().encode('bye'), name: 'bye.txt' }], 'You'))).attachments
    await inWorkspace(w, () => att.removeCardAttachment(w, c, a.id))
    expect(rows(w, c)).toEqual([])
    await expect.poll(() => trashed().some((t) => t.endsWith(a.file))).toBe(true)
    // The removal's own folder goes after its file is in the Recycle Bin (finishTrash, after the commit): awaited, not
    // looked at once (HI-2362: under load the look came between the two).
    await expect.poll(() => inside(join(root, 'p', '.combwork', 'attachments', 'cards', '.trash')), { timeout: 20_000 }).toEqual([])
  })
})

describe('recovering what an interrupted operation left (HI-1700, s13)', () => {
  const { STAGING, TRASH, OP_FILE } = att.CARD_FOLDERS_FOR_TESTS

  it('a removal that crashed after its rename and before its commit is put back: the live card gets its file', async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const [a] = (await inWorkspace(w, () => att.attachToCard(w, c, [{ data: new TextEncoder().encode('keep me'), name: 'keep.txt' }], 'You'))).attachments
    // What removeCardAttachment does before its commit: the record, then the rename. Then the crash (the row stays).
    const op = join(root, 'p', '.combwork', 'attachments', 'cards', TRASH, 'op1')
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
    const op = join(root, 'p', '.combwork', 'attachments', 'cards', TRASH, 'op2')
    mkdirSync(op, { recursive: true })
    writeFileSync(join(op, OP_FILE), JSON.stringify({ kind: 'remove', card: c, files: [{ id: a.id, file: a.file }] }))
    renameSync(a.path, join(op, a.file))
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare('DELETE FROM card_attachments WHERE card = ?').run(c)))
    const r = await inWorkspace(w, () => att.recoverCardAttachments(w))
    expect(r.binned).toBe(1)
    expect(existsSync(a.path)).toBe(false)
    expect(trashed().some((t) => t.endsWith(a.file))).toBe(true)
  })

  it("a record naming a path outside its folder, or an id Hive never makes, is left as it is: nothing it names is touched (HR4's round 1)", async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const host = join(root, 'p')
    const victim = file(host, 'keep.txt', 'user file outside attachments')
    for (const [name, files] of [['bad-path', [{ id: 'aaaaaaaaaaaa', file: '../../../../../keep.txt' }]], ['bad-id', [{ id: 'not-a-row', file: 'keep.txt' }]], ['bad-sep', [{ id: 'aaaaaaaaaaaa', file: 'x\\..\\..\\keep.txt' }]]] as const) {
      const op = join(att.cardsRoot(host), TRASH, name)
      mkdirSync(op, { recursive: true })
      writeFileSync(join(op, OP_FILE), JSON.stringify({ kind: 'remove', card: c, files }))
    }
    const r = await inWorkspace(w, () => att.recoverCardAttachments(w))
    expect(r.left).toBe(3)
    expect(readFileSync(victim, 'utf8')).toBe('user file outside attachments')
    expect(trashed().some((t) => t.endsWith('keep.txt'))).toBe(false)
  })

  it('a .trash or cards folder that is a junction is never followed: what it leads to stays', async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const elsewhere = join(base, `elsewhere-${++n}`)
    const kept = file(join(elsewhere, 'files'), 'precious.txt', 'not Hive’s')
    writeFileSync(join(elsewhere, OP_FILE), JSON.stringify({ kind: 'delete', card: 999999 }))
    mkdirSync(join(att.cardsRoot(join(root, 'p')), TRASH), { recursive: true })
    junction(elsewhere, join(att.cardsRoot(join(root, 'p')), TRASH, 'op-link'))
    await inWorkspace(w, () => att.recoverCardAttachments(w))
    expect(readFileSync(kept, 'utf8')).toBe('not Hive’s')
    // A whole cards folder that is a junction: left as it is.
    const other = join(base, `elsewhere-${++n}`)
    const theirs = file(join(other, String(c)), 'theirs.txt', 'theirs')
    mkdirSync(join(root, 'q', '.combwork', 'attachments'), { recursive: true })
    junction(other, join(root, 'q', '.combwork', 'attachments', 'cards'))
    const r = await inWorkspace(w, () => att.recoverCardAttachments(w))
    expect(r.left).toBeGreaterThan(0)
    expect(readFileSync(theirs, 'utf8')).toBe('theirs')
  })

  it("staging still in use is left alone: a stage, then the open's recovery, then its publish (HR4's round 1)", async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const staging = await att.stage(join(root, 'p'), c, [{ data: new TextEncoder().encode('in flight'), name: 'flight.txt' }])
    await inWorkspace(w, () => att.recoverCardAttachments(w))
    const out = await inWorkspace(w, () => store.boardWrite(w, () => att.publish(w, c, staging, 'You', null)))
    await staging.dispose()
    expect(readFileSync(out.attachments[0].path, 'utf8')).toBe('in flight')
    // Disposed of, a staging left behind is recovery's again.
    file(join(att.cardsRoot(join(root, 'p')), STAGING, 'old-op'), OP_FILE, JSON.stringify({ kind: 'stage', card: c, pid: process.pid }))
    expect((await inWorkspace(w, () => att.recoverCardAttachments(w))).staged).toBe(1)
  })

  it('a project that is a path, or not the workspace’s, gets no folder: refused before anything is copied', async () => {
    const { w, root } = await workspace()
    expect(() => att.cardHost(w, '../outside')).toThrow(/not a project/)
    expect(() => att.cardHost(w, 'p\\..\\..')).toThrow(/not a project/)
    await expect(inWorkspace(w, () => att.stageDrafts(w, { files: [{ data: new TextEncoder().encode('x'), name: 'x.txt' }], keys: ['draft-1'] }, 'nope'))).rejects.toThrow(/not a project/)
    expect(existsSync(join(root, 'nope'))).toBe(false)
  })

  it("a card's deletion that crashed before its commit gives the live card its folder back; one whose card is gone, to the Recycle Bin", async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    const [a] = (await inWorkspace(w, () => att.attachToCard(w, c, [{ data: new TextEncoder().encode('folder'), name: 'f.txt' }], 'You'))).attachments
    const cards = join(root, 'p', '.combwork', 'attachments', 'cards')
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
    const cards = join(root, 'p', '.combwork', 'attachments', 'cards')
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
    const to = join(root, 'q', '.combwork', 'attachments', 'cards', String(c), a.file)
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
    const facts = { sessions: [], attachmentFolders: [{ name: 'cards', path: 'C:\\x\\.combwork\\attachments\\cards', bytes: 5 }], liveNames: new Set<string>(), now: Date.now() }
    expect(planCleanup(facts, { archivedAttachmentsDays: 0, orphanAttachments: true, archivedBackupsDays: 0, goneBackups: true })).toEqual([])
    const purge = planPurge({ host: 'C:\\x', hostName: 'x', sessions: [], files: [], attachmentFolders: [{ name: 'cards', path: 'C:\\x\\.combwork\\attachments\\cards', files: [{ path: 'C:\\x\\.combwork\\attachments\\cards\\a.txt', bytes: 1, mtimeMs: 1 }] }], deletedUsage: [], liveNames: new Set() })
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
    // The Assistant's home and the workspace's .combwork; a project's .combwork but its attachments; a folder; nothing there.
    await expect(att.attachableSource(w, agent, file(join(w.assistantHome, '.combwork', 'attachments', 's1'), 'a.png', 'a'))).rejects.toThrow()
    await expect(att.attachableSource(w, agent, file(join(root, '.combwork'), 'x.txt', 'x'))).rejects.toThrow()
    await expect(att.attachableSource(w, agent, join(root, 'p', '.combwork', 'project.json'))).rejects.toThrow()
    expect(await att.attachableSource(w, agent, file(join(root, 'p', '.combwork', 'attachments', 's1'), 'pasted.png', 'p'))).toBeTruthy()
    await expect(att.attachableSource(w, agent, join(root, 'p'))).rejects.toThrow()
    await expect(att.attachableSource(w, agent, join(root, 'p', 'nothing.png'))).rejects.toThrow(/not a file that can be attached/)
  })

  it("the Assistant and scripts: the workspace, the projects' folders, its home and the temp folder; a .combwork only through attachments", async () => {
    const { w, root } = await workspace()
    const ws = { kind: 'workspace' } as const
    expect(await att.attachableSource(w, ws, file(join(root, 'q'), 'theirs.png', 't'))).toBeTruthy()
    expect(await att.attachableSource(w, ws, file(join(w.assistantHome, '.combwork', 'attachments', 's1'), 'pasted.png', 'a'))).toBeTruthy()
    await expect(att.attachableSource(w, ws, join(root, 'q', '.combwork', 'project.json'))).rejects.toThrow()
  })

  // HI-2480: a folder the user lists (Settings → Advanced → Card attachments: more folders, Hive's or the workspace's).
  it('more folders: a file under one attaches; outside every accepted folder it is refused, saying which are and where to add one', async () => {
    const { w, root } = await workspace()
    const agent = { kind: 'agent', project: 'p' } as const
    const script = { kind: 'workspace' } as const
    // Everything a test makes is in the run's temp folder: the temp folder is one of its own here, so the rest is outside it.
    const was = process.env.HIVE_EVIDENCE
    const temp = tempDir('hive-temp-')
    att.attachTestHooks.temp = temp
    const evidence = tempDir('hive-evidence-')
    const zip = file(join(evidence, 'run4'), 'run4.zip', 'zip bytes')
    const elsewhere = file(tempDir('hive-elsewhere-'), 'other.zip', 'other')
    try {
      // Not listed: refused, naming the accepted folders, Temp's path and where to add one.
      const refused = await att.attachableSource(w, agent, zip).then(() => 'attached', (e: Error) => e.message)
      expect(refused).toBe(`${zip} is not a file that can be attached here. Files can come from your own project (its folder, its slots), the temp folder (${temp}). To attach from another folder, the user adds it there (Settings → Advanced → Card attachments: more folders, Combwork's or this workspace's): don't copy the file into the temp folder. Nothing was attached.`)
      await expect(att.attachableSource(w, script, zip)).rejects.toThrow(/Files can come from the workspace and its projects, the temp folder/)
      expect(await att.attachableSource(w, agent, file(temp, 'shot.png', 's'))).toBeTruthy()

      // Hive's own list, with a variable at its start: the agent's and the script's file attaches; elsewhere is still refused.
      process.env.HIVE_EVIDENCE = evidence
      await advanced.set(CARD_ATTACHMENT_FOLDERS_ID, '%hive_evidence%; Q:\\not\\there')
      expect(att.extraFolders(w)).toEqual([evidence, 'Q:\\not\\there'])
      expect(await att.attachableSource(w, agent, zip)).toBe(zip)
      expect(await att.attachableSource(w, script, zip)).toBe(zip)
      const still = await att.attachableSource(w, agent, elsewhere).then(() => 'attached', (e: Error) => e.message)
      expect(still).toContain(` and the folders of Settings → Advanced → Card attachments: more folders (${evidence}; Q:\\not\\there). To attach from another folder`)
      // And a card keeps it, as the tools attach a path once it is checked.
      const c = await card(w)
      const a = await inWorkspace(w, async () => att.attachToCard(w, c, [{ path: await att.attachableSource(w, agent, zip) }], 'HB1'))
      expect(a.attachments.map((x) => x.name)).toEqual(['run4.zip'])
      // Protected folders stay refused inside a listed one: another project's, and a .combwork beyond its attachments.
      await advanced.set(CARD_ATTACHMENT_FOLDERS_ID, root)
      await expect(att.attachableSource(w, agent, file(join(root, 'q'), 'theirs.png', 't'))).rejects.toThrow(/not a file that can be attached/)
      await expect(att.attachableSource(w, agent, file(join(root, '.combwork'), 'x.txt', 'x'))).rejects.toThrow(/not a file that can be attached/)

      // The workspace's own list over Hive's; unset, Hive's again. A variable that isn't set leaves its folder out.
      await w.setAdvanced(CARD_ATTACHMENT_FOLDERS_ID, [evidence])
      expect(att.extraFolders(w)).toEqual([evidence])
      await w.setAdvanced(CARD_ATTACHMENT_FOLDERS_ID, '%HIVE_NOT_SET_2480%\\x')
      expect(att.extraFolders(w)).toEqual([])
      await expect(att.attachableSource(w, agent, zip)).rejects.toThrow(/not a file that can be attached/)
      // A workspace's [] (written by hand or the API) is Hive's list, as its emptied box in Settings is.
      await w.setAdvanced(CARD_ATTACHMENT_FOLDERS_ID, [])
      expect(att.extraFolders(w)).toEqual([root])
      await w.setAdvanced(CARD_ATTACHMENT_FOLDERS_ID, null)
      expect(att.extraFolders(w)).toEqual([root])
    } finally {
      await advanced.set(CARD_ATTACHMENT_FOLDERS_ID, null)
      att.attachTestHooks.temp = null
      if (was === undefined) delete process.env.HIVE_EVIDENCE
      else process.env.HIVE_EVIDENCE = was
    }
  })

  it('more folders takes full paths, separated by semicolons; anything else is refused, saying what it takes', async () => {
    const def = advancedDef(CARD_ATTACHMENT_FOLDERS_ID)!
    expect(def).toMatchObject({ kind: 'list', paths: true, default: [], workspace: true })
    expect(checkAdvanced(def, 'C:\\Evidence; D:/runs;\\\\server\\share\\x; %LOCALAPPDATA%\\combwork-cli')).toEqual({ value: ['C:\\Evidence', 'D:/runs', '\\\\server\\share\\x', '%LOCALAPPDATA%\\combwork-cli'] })
    expect(checkAdvanced(def, 'C:\\a, b\\c')).toEqual({ value: ['C:\\a, b\\c'] })
    // As shown and read back (Settings' box joins a list of folders with ";", HI-2538): every folder kept apart.
    const two = ['C:\\Evidence, runs', 'D:\\Runs']
    expect(checkAdvanced(def, advancedText(def, two))).toEqual({ value: two })
    // Empty only as the default is written (HI-2480 round 2): text with no folder is refused (Settings' empty box resets).
    expect(checkAdvanced(def, [])).toEqual({ value: [] })
    for (const bad of ['evidence', 'C:\\a; relative\\b', '..\\up', ['C:\\a', 3], Array.from({ length: 21 }, (_, i) => `C:\\f${i}`), '', ' ; ', ['', ' ']]) {
      const r = checkAdvanced(def, bad)
      expect('error' in r && r.error, JSON.stringify(bad)).toBe('Card attachments: more folders takes up to 20 folders, each a full path (C:\\…, \\\\server\\…, or starting with a variable such as %LOCALAPPDATA%), separated by semicolons.')
    }
  })

  it('a list of folders round-trips exactly: parsed and written with ";", spaces around each trimmed (HI-2538)', () => {
    const two = ['%LOCALAPPDATA%\\combwork-cli', '%LOCALAPPDATA%\\hive-test\\scratch']
    for (const typed of ['%LOCALAPPDATA%\\combwork-cli;%LOCALAPPDATA%\\hive-test\\scratch', '%LOCALAPPDATA%\\combwork-cli; %LOCALAPPDATA%\\hive-test\\scratch', ' %LOCALAPPDATA%\\combwork-cli ;  %LOCALAPPDATA%\\hive-test\\scratch ;'])
      expect(folderList(typed), typed).toEqual(two)
    expect(foldersText(two)).toBe('%LOCALAPPDATA%\\combwork-cli;%LOCALAPPDATA%\\hive-test\\scratch')
    expect(folderList(foldersText(two))).toEqual(two)
    const def = advancedDef(CARD_ATTACHMENT_FOLDERS_ID)!
    // What the tools and Settings show is what was typed with ";": never a comma, never a space added.
    expect(advancedText(def, two)).toBe(foldersText(two))
    expect(checkAdvanced(def, advancedText(def, two))).toEqual({ value: two })
    expect(checkAdvanced(def, 'C:\\a; D:\\b')).toEqual({ value: ['C:\\a', 'D:\\b'] })
    expect(checkAdvanced(def, 'C:\\a;D:\\b')).toEqual({ value: ['C:\\a', 'D:\\b'] })
  })

  it('folders joined by a comma are refused, not kept as one folder (HI-2538); a comma inside a folder stays', () => {
    const def = advancedDef(CARD_ATTACHMENT_FOLDERS_ID)!
    const one = advancedDef(AGENT_TEMP_FOLDER_ID)!
    for (const joined of ['%LOCALAPPDATA%\\combwork-cli,%LOCALAPPDATA%\\hive-test\\scratch', 'C:\\a, D:\\b', 'C:\\a,\\\\server\\share', ['C:\\a,D:/b']]) {
      const r = checkAdvanced(def, joined)
      expect('error' in r && r.error, JSON.stringify(joined)).toMatch(/separated by semicolons\.$/)
      expect('error' in checkAdvanced(one, joined), JSON.stringify(joined)).toBe(true)
    }
    expect(checkAdvanced(def, 'C:\\Evidence, runs;D:\\x,y')).toEqual({ value: ['C:\\Evidence, runs', 'D:\\x,y'] })
  })

  it("Attach to card from a pane: only that host's session attachments", async () => {
    const { w, root } = await workspace()
    const pane = { kind: 'pane', host: join(root, 'p') } as const
    expect(await att.attachableSource(w, pane, file(join(root, 'p', '.combwork', 'attachments', 's1'), 'x.png', 'x'))).toBeTruthy()
    await expect(att.attachableSource(w, pane, file(join(root, 'q', '.combwork', 'attachments', 's1'), 'y.png', 'y'))).rejects.toThrow()
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
    expect(withAttachmentPaths(stored, [{ id: 'aaaaaaaaaaaa', path: 'C:\\w\\p\\.combwork\\attachments\\cards\\1\\s.png' }])).toBe('See ![s](C:\\w\\p\\.combwork\\attachments\\cards\\1\\s.png) and [l](attachment removed), again ![s](C:\\w\\p\\.combwork\\attachments\\cards\\1\\s.png).')
  })
})

describe("a card's change with files (HI-1700, s11 §3–4)", () => {
  it("Post: the comment's drafts get their stored ids, the files the comment they came with", async () => {
    const { w } = await workspace()
    const c = await card(w)
    const drafts = { files: [{ data: new TextEncoder().encode('pic'), name: 'pic.png' }, { data: new TextEncoder().encode('log'), name: 'run.log' }], keys: ['draft-1', 'draft-2'] }
    const staged = await inWorkspace(w, () => att.stageDrafts(w, drafts, 'p'))
    const done = await inWorkspace(w, () => tasks.changeWithAttachments(user, staged, 'comment', () => tasks.commentTask(c, 'Seen: ![pic.png](attachment:draft-1) and [run.log](attachment:draft-2)', user)))
    const said = done.comments.at(-1)!
    const files = await att.cardAttachments(w, c)
    expect(files).toHaveLength(2)
    expect(attachmentRefs(said.text).sort()).toEqual(files.map((f) => f.id).sort())
    expect(files.every((f) => f.comment === said.id)).toBe(true)
  })

  it("an agent's files with no draft are linked at the end of the description; the reply says what was stored", async () => {
    const { w } = await workspace()
    const shot = file(tempDir('hive-shot2-'), 'shot.png', 'agent shot')
    const real = await att.attachableSource(w, { kind: 'agent', project: 'p' }, shot)
    const staging = await att.stage(join(w.path!, 'p'), null, [{ path: real, name: 'shot.png' }])
    const made = await inWorkspace(w, () => tasks.changeWithAttachments({ kind: 'agent', name: 'B1' }, { staging, drafts: [null] }, 'description', () => tasks.createTask({ title: 'With a shot', project: 'p', description: 'See the screenshot.' }, user)))
    const [a] = await att.cardAttachments(w, made.number)
    expect(made.description).toBe(`See the screenshot.\n\n![shot.png](attachment:${a.id})`)
    expect(made.attached).toEqual([{ name: 'shot.png', path: a.path, added: true }])
    expect(a.comment).toBe('description')
    expect(a.by).toBe('B1')
  })

  it('the same bytes attached twice at once give one row', async () => {
    const { w } = await workspace()
    const c = await card(w)
    const twice = await Promise.all([1, 2].map(() => inWorkspace(w, () => att.attachToCard(w, c, [{ data: new TextEncoder().encode('same'), name: 'same.txt' }], 'You'))))
    expect(twice[0].attachments[0].id).toBe(twice[1].attachments[0].id)
    expect(rows(w, c)).toHaveLength(1)
  })

  it("drafts of the description and a comment together over 100 MB are refused before anything is copied; a later bad draft, nothing changed", async () => {
    const { w, root } = await workspace()
    const c = await card(w)
    await advanced.set(CARD_ATTACHMENT_MAX_ID, 30 * 1024 * 1024)
    const big = new Uint8Array(26 * 1024 * 1024)
    const drafts = { files: [1, 2, 3, 4].map((k) => ({ data: big, name: `${k}.bin` })), keys: ['draft-1', 'draft-2', 'draft-3', 'draft-4'] }
    await expect(inWorkspace(w, () => att.stageDrafts(w, drafts, 'p'))).rejects.toThrow(/At most 10 files and/)
    expect(inside(join(root, 'p', '.combwork', 'attachments', 'cards', '.staging'))).toEqual([])
    // A folder among them: refused whole.
    await expect(inWorkspace(w, () => att.stageDrafts(w, { files: [{ data: new TextEncoder().encode('ok'), name: 'ok.txt' }, { path: join(root, 'p') }], keys: ['draft-1', 'draft-2'] }, 'p'))).rejects.toThrow(/not a file/)
    expect(rows(w, c)).toEqual([])
    expect(inside(join(root, 'p', '.combwork', 'attachments', 'cards', '.staging'))).toEqual([])
  })
})

describe("a card's start prompt names its attachments (HI-1700)", () => {
  it('lists their paths (up to ten) and gives its description the paths for its links', async () => {
    const { taskPrompt } = await import('../src/shared/tasks')
    const seven = { number: 7, key: 'AL-7', title: 'Fix the button', description: 'See ![shot](attachment:aaaaaaaaaaaa).', blockedBy: [], comments: [], context: [] } as never
    const files = Array.from({ length: 12 }, (_, i) => ({ id: i === 0 ? 'aaaaaaaaaaaa' : `b${String(i).padStart(11, '0')}`, path: `C:/w/p/.combwork/attachments/cards/7/f${i}.png` }))
    const prompt = taskPrompt(seven, true, { attachments: files })
    expect(prompt).toContain('See ![shot](C:/w/p/.combwork/attachments/cards/7/f0.png).')
    expect(prompt).toContain('Its attachments (open them by path): C:/w/p/.combwork/attachments/cards/7/f0.png, ')
    expect(prompt).toContain('f9.png, and 2 more (cw_read_task lists them).')
    expect(prompt).not.toContain('f10.png')
    expect(taskPrompt(seven, true)).not.toContain('Its attachments')
  })
})
