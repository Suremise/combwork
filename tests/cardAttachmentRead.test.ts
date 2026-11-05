// Reading a card's attachment through Combwork (HI-1751: the document tools refuse `.combwork`, so HR2 couldn't read HI-1702's
// evidence), on the real board with two projects: a page of its text by byte offset, the pages joined giving its text
// exactly (a character of any UTF-8 length at a page's end, a byte-order mark, the end of the file); an image, a PDF, a
// file with a NUL or bytes that aren't UTF-8 by its kind and path; offsets that aren't a byte of it refused, for text and
// binary alike; by name or file name; only from its card's own folder (a link anywhere on the way, a name that isn't
// plain, refused); the card moved or deleted, or its file swapped, while it is read; and only a card the caller may read.
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { junction } from './pathAliases'
import { moveFolder } from './moveFolder'

const base = tempDir('cw-attachread-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const att = await import('../src/main/cardAttachments')
const { advanced } = await import('../src/main/advanced')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
beforeAll(() => {
  process.env.CW_TEST_TRASH_DIR = join(base, 'trash')
})
afterAll(async () => {
  delete process.env.CW_TEST_TRASH_DIR
  att.attachmentReadSeams.afterOpen = null
  att.attachmentReadSeams.beforeOpen = null
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
let n = 0
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
/** A card of project p with these files attached (name → bytes), and the card as its builder reads it. */
async function cardWith(w: WS, files: Record<string, string | Buffer>) {
  const c = (await inWorkspace(w, () => tasks.createTask({ title: `Card ${++n}`, project: 'p' }, user))).number
  const src = join(base, `src-${n}`)
  mkdirSync(src, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(src, name), bytes)
  await inWorkspace(w, () => att.attachToCard(w, c, Object.keys(files).map((f) => ({ path: join(src, f) })), 'HB'))
  return { number: c, project: 'p' as string | null }
}
const read = (w: WS, c: { number: number; project: string | null }, name: string, offset: string | null = null) => inWorkspace(w, () => att.readCardAttachment(w, c, name, offset))
/** Every page of a text attachment, from offset 0 by each reply's `next`, and their contents joined. */
async function allPages(w: WS, c: { number: number; project: string | null }, name: string): Promise<{ text: string; pages: number; offsets: number[] }> {
  let at: string | null = null
  let text = ''
  const offsets: number[] = []
  for (let i = 0; i < 100; i++) {
    const r = await read(w, c, name, at)
    if ('problem' in r || r.kind !== 'text') throw new Error(JSON.stringify(r))
    offsets.push(r.offset)
    text += r.content
    if (r.next === undefined) return { text, pages: offsets.length, offsets }
    expect(r.next).toBeGreaterThan(r.offset)
    at = String(r.next)
  }
  throw new Error('more than 100 pages')
}
const folderOf = (root: string, c: number): string => join(root, 'p', '.combwork', 'attachments', 'cards', String(c))

describe("a card's attachment read through Combwork (HI-1751)", () => {
  it('a small text file whole; a long one in pages whose contents joined are its text, a character of each UTF-8 length at a page end', async () => {
    const { w } = await workspace()
    const PAGE = att.ATTACHMENT_PAGE
    // Each a page's last whole character, then one of that length straddling the page's end.
    const straddle = (ch: string): string => 'a'.repeat(PAGE - 1) + ch + 'tail\n'.repeat(10)
    const files = { 'probe.cjs': 'console.log(1)\n', 'two.txt': straddle('é'), 'three.txt': straddle('€'), 'four.txt': straddle('😀'), 'big.txt': 'line ✓\n'.repeat(40_000) }
    const c = await cardWith(w, files)
    const small = await read(w, c, 'probe.cjs')
    expect(small).toMatchObject({ name: 'probe.cjs', kind: 'text', offset: 0, content: 'console.log(1)\n', size: 15 })
    expect(small).not.toHaveProperty('next')
    for (const name of ['two.txt', 'three.txt', 'four.txt', 'big.txt']) {
      const all = await allPages(w, c, name)
      expect(all.text, name).toBe(files[name as keyof typeof files])
      expect(all.pages, name).toBeGreaterThan(1)
    }
    // The page's end moved back to the whole character: the second page starts with it.
    const first = await read(w, c, 'four.txt')
    expect('next' in first && first.next).toBe(PAGE - 1)
  })

  it('a byte-order mark left out of the first page; the end of the file: empty, no next; offsets not a byte of it refused, for text and binary alike', async () => {
    const { w } = await workspace()
    const c = await cardWith(w, { 'bom.txt': '\uFEFFhello\n', 'shot.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) })
    expect(await read(w, c, 'bom.txt')).toMatchObject({ content: 'hello\n', size: 9 })
    const end = await read(w, c, 'bom.txt', '9')
    expect(end).toMatchObject({ kind: 'text', offset: 9, content: '' })
    expect(end).not.toHaveProperty('next')
    for (const bad of ['-1', '1.5', 'x', '10', '1e3']) {
      expect(await read(w, c, 'bom.txt', bad), bad).toEqual({ problem: 'offset', size: 9 })
      expect(await read(w, c, 'shot.png', bad === '10' ? '8' : bad), bad).toEqual({ problem: 'offset', size: 7 })
    }
  })

  it('an image or PDF by kind and path; a NUL in its start, or bytes that are not UTF-8, by kind binary and path', async () => {
    const { w, root } = await workspace()
    const c = await cardWith(w, { 'shot.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'doc.pdf': '%PDF-1.4', 'blob.txt': Buffer.from([0x61, 0, 0x62]), 'latin.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) })
    const dir = folderOf(root, c.number)
    expect(await read(w, c, 'shot.png')).toMatchObject({ kind: 'image', path: expect.stringContaining(dir) })
    expect(await read(w, c, 'doc.pdf')).toMatchObject({ kind: 'pdf', path: expect.stringContaining(dir) })
    expect(await read(w, c, 'blob.txt')).toMatchObject({ kind: 'binary', path: expect.stringContaining(dir) })
    expect(await read(w, c, 'latin.txt')).toMatchObject({ kind: 'binary' })
  })

  it('by its name or its file name; several of one name: which, by file name; none: the card\'s, by file name', async () => {
    const { w } = await workspace()
    const c = await cardWith(w, { 'a.txt': 'one' })
    const src = join(base, 'again')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'a.txt'), 'two')
    await inWorkspace(w, () => att.attachToCard(w, c.number, [{ path: join(src, 'a.txt') }], 'HB'))
    const both = await read(w, c, 'a.txt')
    expect(both).toMatchObject({ problem: 'ambiguous', choices: [expect.stringMatching(/_a(-2)?\.txt$/), expect.stringMatching(/_a(-2)?\.txt$/)] })
    const files = 'choices' in both ? both.choices! : []
    expect(await read(w, c, files[0])).toMatchObject({ kind: 'text', file: files[0] })
    const none = await read(w, c, 'nope.txt')
    expect(none).toMatchObject({ problem: 'unknown' })
    expect('choices' in none ? [...none.choices!].sort() : null).toEqual([...files].sort())
  })

  it('only from its card\'s own folder: a junction at the card\'s folder, cards, attachments or .combwork, a linked file, or a name that is not plain, refused', async () => {
    const { w, root } = await workspace()
    const c = await cardWith(w, { 'a.txt': 'mine' })
    const hive = join(root, 'p', '.combwork')
    const levels = [folderOf(root, c.number), join(hive, 'attachments', 'cards'), join(hive, 'attachments'), hive]
    for (const level of levels) {
      // The real folder set aside, a junction to a copy elsewhere in its place (another project's, say). Each move tried
      // again while Windows says the folder is in use (HI-2348: under a full run's load, renaming .combwork failed with EPERM
      // once, something holding a file in it for a moment).
      const aside = `${level}-aside`
      await moveFolder(level, aside)
      const elsewhere = join(base, `elsewhere-${++n}`)
      await moveFolder(aside, elsewhere)
      junction(elsewhere, level)
      try {
        expect(await read(w, c, 'a.txt'), level).toEqual({ problem: 'outside' })
      } finally {
        rmSync(level)
        await moveFolder(elsewhere, level)
      }
      expect(await read(w, c, 'a.txt')).toMatchObject({ kind: 'text', content: 'mine' })
    }
    // A linked file in its place (where the machine lets a test make a file link).
    const dir = folderOf(root, c.number)
    const row = store.boardRead(w, (db) => db.prepare('SELECT file FROM card_attachments WHERE card = ?').get(c.number) as { file: string })
    const real = join(base, 'linked-target.txt')
    writeFileSync(real, 'elsewhere')
    await moveFolder(join(dir, row.file), join(base, 'kept.txt'))
    let linked = true
    try {
      symlinkSync(real, join(dir, row.file), 'file')
    } catch {
      linked = false
    }
    if (linked) {
      expect(await read(w, c, 'a.txt')).toEqual({ problem: 'outside' })
      rmSync(join(dir, row.file))
    }
    await moveFolder(join(base, 'kept.txt'), join(dir, row.file))
    // A row whose file isn't a plain name (a traversal written into the board): never joined.
    for (const bad of ['..\\..\\project.json', 'sub/a.txt', '..']) {
      await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare('UPDATE card_attachments SET file = ? WHERE card = ?').run(bad, c.number)))
      expect(await read(w, c, bad), bad).toEqual({ problem: 'outside' })
    }
  })

  it('the card moved or deleted, or its file swapped, while it is read: refused as changed, nothing served', async () => {
    const { w, root } = await workspace()
    try {
      const c = await cardWith(w, { 'a.txt': 'mine' })
      att.attachmentReadSeams.afterOpen = async () => {
        await inWorkspace(w, () => tasks.updateTask(c.number, { project: 'q' }, user))
      }
      expect(await read(w, c, 'a.txt')).toEqual({ problem: 'changed' })
      // Asked again with the snapshot it had (project p): the card is q's now, never read from q's folder.
      att.attachmentReadSeams.afterOpen = null
      expect(await read(w, c, 'a.txt')).toEqual({ problem: 'changed' })

      const d = await cardWith(w, { 'b.txt': 'mine' })
      const file = store.boardRead(w, (db) => db.prepare('SELECT file FROM card_attachments WHERE card = ?').get(d.number) as { file: string }).file
      att.attachmentReadSeams.afterOpen = async () => {
        // Another file put in its place.
        const p = join(folderOf(root, d.number), file)
        renameSync(p, `${p}.old`)
        writeFileSync(p, 'swapped')
      }
      expect(await read(w, d, 'b.txt')).toEqual({ problem: 'changed' })

      // The card and its attachments' rows gone from the board while its file is open (Windows keeps an open file's
      // folder, so a deletion's own folder move waits: the board is what says it is gone).
      const e = await cardWith(w, { 'c.txt': 'mine' })
      att.attachmentReadSeams.afterOpen = async () => {
        await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare('DELETE FROM card_attachments WHERE card = ?').run(e.number)))
      }
      expect(await read(w, e, 'c.txt')).toEqual({ problem: 'changed' })
    } finally {
      att.attachmentReadSeams.afterOpen = null
    }
  })

  it('only a card the caller may read: another project\'s agent finds no such card; its own project\'s agent and the user read it', async () => {
    const { w } = await workspace()
    const c = await cardWith(w, { 'a.txt': 'mine' })
    const agentOf = (project: string) => ({ kind: 'agent', name: `B (${project})`, self: { project, agentId: 'b' }, scope: project }) as const
    await expect(inWorkspace(w, () => tasks.readTask(c.number, agentOf('q') as never))).rejects.toThrow()
    expect((await inWorkspace(w, () => tasks.readTask(c.number, agentOf('p') as never))).number).toBe(c.number)
    expect((await inWorkspace(w, () => tasks.readTask(c.number, user))).number).toBe(c.number)
  })
})
describe("a card's attachment in the attachment viewer (HI-1958)", () => {
  const preview = (w: WS, card: number, id: string, max = 2 * 1024 * 1024) => inWorkspace(w, () => att.previewCardAttachment(w, card, id, max))
  it("its text by card and id, whole; an image binary, a long one too large; never another card's, nor one gone", async () => {
    const { w } = await workspace()
    const c = await cardWith(w, { 'notes.md': '\uFEFF# Notes', 'shot.png': 'png bytes', 'long.txt': 'x'.repeat(100) })
    const list = await inWorkspace(w, () => att.cardAttachments(w, c.number))
    const id = (name: string): string => list.find((a) => a.name === name)!.id
    expect(await preview(w, c.number, id('notes.md'))).toEqual({ kind: 'text', text: '# Notes' })
    expect(await preview(w, c.number, id('shot.png'))).toEqual({ kind: 'binary', text: '' })
    expect(await preview(w, c.number, id('long.txt'), 50)).toEqual({ kind: 'too-large', text: '' })
    expect(await preview(w, c.number, id('long.txt'), 100)).toEqual({ kind: 'text', text: 'x'.repeat(100) })
    // Another card's id, an id it doesn't have: refused.
    const other = await cardWith(w, { 'x.txt': 'x' })
    await expect(preview(w, other.number, id('notes.md'))).rejects.toThrow(/no such attachment/)
    // Its file gone: refused (the viewer shows that it's gone, never reads it).
    rmSync(list.find((a) => a.name === 'notes.md')!.path)
    await expect(preview(w, c.number, id('notes.md'))).rejects.toThrow(/no such attachment/)
  })

  it("its card folder swapped for a junction to another file of the same name while it is read: refused, never that file's text (HR2's round 1)", async () => {
    const { w, root } = await workspace()
    const c = await cardWith(w, { 'notes.txt': 'the card notes' })
    const [a] = await inWorkspace(w, () => att.cardAttachments(w, c.number))
    const level = folderOf(root, c.number)
    const aside = join(base, `aside-${++n}`)
    const decoy = join(base, `decoy-${n}`)
    mkdirSync(decoy, { recursive: true })
    writeFileSync(join(decoy, a.file), 'unrelated outside text')
    // After the checks before the open, before the open: the real folder moved aside, a junction to the decoy in its
    // place, so the open follows it (Windows won't move a folder with the file open, so a swap can't come later).
    att.attachmentReadSeams.beforeOpen = async () => {
      att.attachmentReadSeams.beforeOpen = null
      renameSync(level, aside)
      junction(decoy, level)
    }
    try {
      await expect(preview(w, c.number, a.id)).rejects.toThrow(/no such attachment/)
      expect(att.attachmentReadSeams.beforeOpen).toBeNull()
    } finally {
      att.attachmentReadSeams.beforeOpen = null
      rmSync(level)
      renameSync(aside, level)
    }
    expect(await preview(w, c.number, a.id)).toEqual({ kind: 'text', text: 'the card notes' })
  })
})
