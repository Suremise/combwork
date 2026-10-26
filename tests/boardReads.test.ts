// The window's board reads (HI-1715, src/renderer/src/boardReads.ts): the board as main last sent it is kept apart from
// what is shown, a reply is taken only into the copy it was asked from (in the mode it was asked in, for the workspace
// still shown), only a reply taken moves the cursor on, and what is shown is made again from the copy each time.
import { describe, expect, it } from 'vitest'
import { boardReader, type BoardAsks } from '../src/renderer/src/boardReads'
import type { TaskCard, TaskChanges, TaskCursor } from '../src/shared/types'

const card = (number: number, o: Partial<TaskCard> = {}): TaskCard =>
  ({ number, title: `Card ${number}`, description: '', project: 'p', agent: null, column: 'todo', order: number, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: '', createdBy: '', updatedAt: '', ...o }) as TaskCard

/** Main as a script: each read's reply given by the test, each cursor sent recorded. */
function main() {
  const sent: (TaskCursor | null)[] = []
  const replies: TaskChanges[] = []
  let whole: TaskCard[] = []
  const asks: BoardAsks = {
    list: async () => whole,
    changes: async (since) => {
      sent.push(since)
      const r = replies.shift()
      if (!r) throw new Error('no reply scripted')
      return r
    }
  }
  return { asks, sent, reply: (r: TaskChanges) => replies.push(r), setWhole: (cards: TaskCard[]) => (whole = cards) }
}
const full = (cards: TaskCard[], mark = 10, board = 'b1'): TaskChanges => ({ board, mark, full: true, cards, numbers: cards.map((c) => c.number) })
const delta = (cards: TaskCard[], numbers: number[], mark: number, board = 'b1'): TaskChanges => ({ board, mark, full: false, cards, numbers })
const now = { ws: 'W', whole: false }

/** One read through to what is shown. */
async function readOnce(r: ReturnType<typeof boardReader>, o: { ws?: string; whole?: boolean; after?: { ws: string | null; whole: boolean } } = {}) {
  const read = r.begin(o.ws ?? 'W', o.whole ?? false)
  return read.take(await read.request, o.after ?? { ws: o.ws ?? 'W', whole: o.whole ?? false })
}
const numbers = (shown: TaskCard[] | 'again' | null): number[] | typeof shown => (Array.isArray(shown) ? shown.map((c) => c.number) : shown)

describe("the window's board reads (HI-1715)", () => {
  it('asks with no cursor first, then from the cursor of the reply it took; a delta merges into the copy', async () => {
    const m = main()
    const r = boardReader(m.asks)
    m.reply(full([card(1), card(2), card(3)]))
    expect(numbers(await readOnce(r))).toEqual([1, 2, 3])
    m.reply(delta([card(2, { title: 'Two' })], [1, 2, 3], 12))
    const shown = await readOnce(r)
    expect(m.sent).toEqual([null, { board: 'b1', mark: 10 }])
    expect((shown as TaskCard[]).find((c) => c.number === 2)!.title).toBe('Two')
    expect(numbers(shown)).toEqual([1, 2, 3])
    m.reply(delta([], [1, 2, 3], 12))
    await readOnce(r)
    expect(m.sent.at(-1)).toEqual({ board: 'b1', mark: 12 })
  })

  it('shows a card moved before main agreed as the server has it again after the next read, an empty delta too', async () => {
    const m = main()
    const r = boardReader(m.asks)
    m.reply(full([card(1), card(2)]))
    const shown = (await readOnce(r)) as TaskCard[]
    // Board.tsx's optimistic move: a new object in the shown list, the copy's untouched.
    const moved = shown.map((c) => (c.number === 1 ? { ...c, column: 'doing' as const } : c))
    expect(moved[0].column).toBe('doing')
    m.reply(delta([], [1, 2], 10))
    expect(((await readOnce(r)) as TaskCard[]).find((c) => c.number === 1)!.column).toBe('todo')
  })

  it("replaces an archived card's summary with the full card once unarchived, and the other way", async () => {
    const m = main()
    const r = boardReader(m.asks)
    m.reply(full([card(1), card(2, { archived: true, summary: true })]))
    await readOnce(r)
    m.reply(delta([card(2, { comments: [{ at: '', by: 'U', text: 'back' }] })], [1, 2], 11))
    let two = ((await readOnce(r)) as TaskCard[]).find((c) => c.number === 2)!
    expect(two.summary).toBeUndefined()
    expect(two.comments).toHaveLength(1)
    m.reply(delta([card(2, { archived: true, summary: true })], [1, 2], 12))
    two = ((await readOnce(r)) as TaskCard[]).find((c) => c.number === 2)!
    expect(two).toMatchObject({ archived: true, summary: true })
  })

  it('reads the whole board while the archived cards are wanted in full, keeping no copy, and reads from scratch after', async () => {
    const m = main()
    const r = boardReader(m.asks)
    m.reply(full([card(1)]))
    await readOnce(r)
    m.setWhole([card(1), card(9, { archived: true, comments: [{ at: '', by: 'U', text: 'in full' }] })])
    expect(numbers(await readOnce(r, { whole: true }))).toEqual([1, 9])
    m.reply(full([card(1), card(9, { archived: true, summary: true })], 20))
    await readOnce(r)
    expect(m.sent.at(-1)).toBeNull()
  })

  it('drops a reply that comes after the workspace or the mode changed, keeping its cursor', async () => {
    const m = main()
    const r = boardReader(m.asks)
    m.reply(full([card(1)]))
    await readOnce(r)
    m.reply(delta([card(1, { title: 'late' })], [1], 15))
    expect(await readOnce(r, { after: { ws: 'Other', whole: false } })).toBeNull()
    m.reply(delta([card(1, { title: 'late' })], [1], 15))
    expect(await readOnce(r, { after: { ws: 'W', whole: true } })).toBeNull()
    // Neither moved the cursor on.
    m.reply(delta([], [1], 15))
    await readOnce(r)
    expect(m.sent.at(-1)).toEqual({ board: 'b1', mark: 10 })
  })

  it('drops a reply asked from a copy that another reply replaced meanwhile', async () => {
    const m = main()
    const r = boardReader(m.asks)
    m.reply(full([card(1)]))
    await readOnce(r)
    m.reply(delta([card(1, { title: 'first' })], [1], 11))
    m.reply(delta([card(1, { title: 'second' })], [1], 12))
    const a = r.begin('W', false)
    const b = r.begin('W', false)
    const [ra, rb] = await Promise.all([a.request, b.request])
    expect(numbers(b.take(rb, now))).toEqual([1])
    expect(a.take(ra, now)).toBeNull()
  })

  it('a whole reply (a key or a project renamed, the board opened again) replaces the copy', async () => {
    const m = main()
    const r = boardReader(m.asks)
    m.reply(full([card(1), card(2)]))
    await readOnce(r)
    m.reply(full([card(1, { title: 'renamed' })], 30, 'b2'))
    expect(numbers(await readOnce(r))).toEqual([1])
    m.reply(delta([], [1], 30, 'b2'))
    await readOnce(r)
    expect(m.sent.at(-1)).toEqual({ board: 'b2', mark: 30 })
  })

  it('leaves a deleted card out, and the references to it, the copy still usable for the next delta', async () => {
    const m = main()
    const r = boardReader(m.asks)
    m.reply(full([card(1, { links: [2], blockedBy: [2] }), card(2)]))
    await readOnce(r)
    m.reply(delta([], [1], 11))
    const shown = (await readOnce(r)) as TaskCard[]
    expect(numbers(shown)).toEqual([1])
    expect(shown[0]).toMatchObject({ links: [], blockedBy: [] })
    m.reply(delta([card(3)], [1, 3], 12))
    const next = (await readOnce(r)) as TaskCard[]
    expect(numbers(next)).toEqual([1, 3])
  })

  it('a stale reply is read again, the copy and cursor as they were', async () => {
    const m = main()
    const r = boardReader(m.asks)
    m.reply(full([card(1)]))
    await readOnce(r)
    m.reply({ stale: true })
    expect(await readOnce(r)).toBe('again')
    m.reply(delta([], [1], 10))
    expect(numbers(await readOnce(r))).toEqual([1])
    expect(m.sent.at(-1)).toEqual({ board: 'b1', mark: 10 })
  })
})
