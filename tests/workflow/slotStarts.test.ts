// Cards on slots (#1438, SPEC §16.10): a start under G11 = slots asks the app for its builder's slot (`slotFor`, the
// app's leaseForStart): the card's line from the target's head in it, its `Started` with the slot and lease, and its
// `prepareSlot` action; none free, refused `start.slotAvailable`; a lease lent for a start that isn't written given back;
// a window Start that only asks lends nothing; no slot (the rules off), where the agent is.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { lineName, slugOf, type SlotForStart } from '../../src/main/workflow/runtime'
import { tempDir } from '../tempDir'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const opts = { ...preset('git', 'pair'), preChecks: [], mergeChecks: [], folder: 'slots' as const, review: 'none' as const, finish: 'agentMerges' as const }

/** A world whose starts get `answer` from slotFor, recording each ask and each lease given back. */
function world(answer: (dry: boolean) => SlotForStart) {
  const e = (env = setup(opts, { autoRun: false }))
  const asked: { card: number; builder: string; dry: boolean; target: string | null }[] = []
  const unused: string[] = []
  e.wf.cfg.slotFor = async (card, builder, o) => (asked.push({ card: card.id, builder, ...o }), answer(o.dry))
  e.wf.cfg.slotUnused = async (lease) => void unused.push(lease)
  return { e, asked, unused }
}

describe('cards on slots (#1438)', () => {
  it("starts in the builder's slot: the card's own line from the target's head, the slot and lease recorded, its preparation asked for", async () => {
    const folder = tempDir('slot-')
    const { e, asked } = world(() => ({ slot: 'slot-a', folder, lease: 'l-1', fresh: true }))
    const head = sh(e.project, 'rev-parse', 'main')
    const card = e.wf.createCard({ title: 'Fix the login' })
    const r = await e.wf.start(card.key, B1)
    moved(r)
    expect(asked).toEqual([{ card: card.id, builder: 'B1', dry: false, target: 'main' }])
    const s = e.wf.state(card)
    expect(s.started).toMatchObject({ folder, slot: 'slot-a', lease: 'l-1', line: `hive/AM/${card.key}-fix-the-login`, base: head, target: 'main', builder: 'B1' })
    expect(e.wf.folderOf(s)).toBe(folder)
    const prep = e.store.pendingActions().find((a) => a.kind === 'prepareSlot')
    expect(prep?.payload).toEqual({ folder, line: `hive/AM/${card.key}-fix-the-login`, base: head, slot: 'slot-a', lease: 'l-1', upToDate: opts.slotsUpToDate, builder: 'B1' })
    // The agent's reply says where it continues, and to end its turn.
    expect((r as { warnings?: string[] }).warnings?.join(' ')).toMatch(/You'll continue in slot-a, on hive\/AM\/.*End your turn now\./)
  })

  it('G15 on: the preparation asks for the install', async () => {
    const e = (env = setup({ ...opts, slotsUpToDate: true }, { autoRun: false }))
    e.wf.cfg.slotFor = async () => ({ slot: 'slot-a', folder: tempDir('slot-'), lease: 'l-1', fresh: true })
    const card = e.wf.createCard({ title: 'G15' })
    moved(await e.wf.start(card.key, B1))
    expect(e.store.pendingActions().find((a) => a.kind === 'prepareSlot')?.payload).toMatchObject({ upToDate: true })
  })

  it('none free: refused start.slotAvailable with why, nothing written', async () => {
    const { e } = world(() => ({ wait: "no slot free: the pool's 1 slot is in use" }))
    const card = e.wf.createCard({ title: 'Waits' })
    const r = refusedBy(await e.wf.start(card.key, B1), 'start.slotAvailable')
    expect(r.message).toMatch(/no slot is free/)
    expect(e.wf.state(card).stage).toBe('todo')
    expect(e.store.pendingActions().filter((a) => a.kind === 'prepareSlot')).toEqual([])
  })

  it('a lease lent for a start refused by another rule is given back; a lane lease (not fresh) is kept', async () => {
    const folder = tempDir('slot-')
    let fresh = true
    const { e, unused } = world(() => ({ slot: 'slot-a', folder, lease: fresh ? 'l-card' : 'l-lane', fresh }))
    const card = e.wf.createCard({ title: 'Blocked' })
    e.wf.cfg.hooks = { beforeWrite: () => void sh(e.project, 'commit', '--allow-empty', '-q', '-m', 'moved meanwhile') }
    // The target moved between the evidence and the write: refused (evidence.changed), the card's lease given back.
    refusedBy(await e.wf.start(card.key, B1), 'evidence.changed')
    expect(unused.length).toBeGreaterThan(0)
    expect(new Set(unused)).toEqual(new Set(['l-card']))
    unused.length = 0
    fresh = false
    refusedBy(await e.wf.start(card.key, B1), 'evidence.changed')
    expect(unused).toEqual([])
    e.wf.cfg.hooks = {}
  })

  it("a start written keeps its lease, even when gathered again on the way (the card started with it)", async () => {
    const folder = tempDir('slot-')
    const { e, unused } = world(() => ({ slot: 'slot-a', folder, lease: 'l-1', fresh: true }))
    const card = e.wf.createCard({ title: 'Kept' })
    moved(await e.wf.start(card.key, B1))
    expect(unused).toEqual([])
  })

  it("the window's Start that only asks (dry) lends nothing", async () => {
    const { e, asked } = world((dry) => (dry ? { slot: '', folder: '', lease: '', fresh: false } : null))
    const card = e.wf.createCard({ title: 'Asks' })
    const r = await e.wf.move(card.key, 'active', 'user', { dry: true, builder: 'B1' })
    expect('ask' in r || 'ok' in r || r).toBeTruthy()
    expect(asked.map((a) => a.dry)).toEqual([true])
    expect(e.wf.state(card).stage).toBe('todo')
  })

  it('no slot here (the rules off, or a reviewer): the card starts where the agent is, the project folder', async () => {
    const { e } = world(() => null)
    const card = e.wf.createCard({ title: 'Here' })
    moved(await e.wf.start(card.key, B1))
    const s = e.wf.state(card)
    expect(s.started).toMatchObject({ folder: 'project' })
    expect(s.started?.lease).toBeUndefined()
    expect(e.store.pendingActions().filter((a) => a.kind === 'prepareSlot')).toEqual([])
  })

  it('a card started again keeps the line it has: its base where it left the target', async () => {
    const folder = tempDir('slot-')
    const { e } = world(() => ({ slot: 'slot-a', folder, lease: 'l-1', fresh: true }))
    const card = e.wf.createCard({ title: 'Again' })
    const line = lineName('AM', card)
    const left = sh(e.project, 'rev-parse', 'main')
    sh(e.project, 'branch', line)
    sh(e.project, 'switch', '-q', line)
    commit(e.project, { 'a.txt': 'a\n' }, 'its work')
    sh(e.project, 'switch', '-q', 'main')
    commit(e.project, { 'b.txt': 'b\n' }, 'the target moved on')
    moved(await e.wf.start(card.key, B1))
    expect(e.wf.state(card).started).toMatchObject({ line, base: left })
  })

  it("names a card's line: lower case ASCII letters, digits and hyphens, at most 40, accents folded", () => {
    expect(lineName('AM', { key: 'AM-12', title: 'Fix the Login!' })).toBe('hive/AM/AM-12-fix-the-login')
    expect(slugOf('Café déjà vu — naïve')).toBe('cafe-deja-vu-naive')
    expect(slugOf('日本語のタイトル')).toBe('')
    expect(lineName('AM', { key: 'AM-3', title: '日本語' })).toBe('hive/AM/AM-3')
    const long = slugOf('A very long title that goes on and on, well past the forty characters a line may have')
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long).toBe('a-very-long-title-that-goes-on-and-on-we')
    expect(long.endsWith('-')).toBe(false)
  })
})
