// Cards on slots (#1438, SPEC §16.10): a start under G11 = slots asks the app for its builder's slot (`slotFor`, the
// app's leaseForStart): the card's line from the target's head in it, its `Started` with the slot and lease, and its
// `prepareSlot` action; none free, refused `start.slotAvailable`; a lease lent for a start that isn't written given back;
// a window Start that only asks lends nothing; no slot (the rules off), where the agent is.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { lineName, slugOf, type SlotForStart } from '../../src/main/workflow/runtime'
import { tempDir } from '../tempDir'
import { reconcile, slotPreparationOwed } from '../../src/main/workflow/reconcile'
import type { FactData } from '../../src/shared/workflow/facts'
import { GUARD_FNS, type GuardInputs } from '../../src/shared/workflow/guards'

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
    expect(s.started).toMatchObject({ folder, slot: 'slot-a', lease: 'l-1', line: `cw/AM/${card.key}-fix-the-login`, base: head, target: 'main', builder: 'B1' })
    expect(e.wf.folderOf(s)).toBe(folder)
    const prep = e.store.pendingActions().find((a) => a.kind === 'prepareSlot')
    expect(prep?.payload).toEqual({ folder, line: `cw/AM/${card.key}-fix-the-login`, base: head, slot: 'slot-a', lease: 'l-1', upToDate: opts.slotsUpToDate, builder: 'B1' })
    // The agent's reply says where it continues, and to end its turn.
    expect((r as { warnings?: string[] }).warnings?.join(' ')).toMatch(/You'll continue in slot-a, on cw\/AM\/.*End your turn now\./)
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

  it('HI-2335: a no-code card takes no slot: with none free it starts where its agent is, the slot never asked for; a code card still waits', async () => {
    const { e, asked, unused } = world(() => ({ wait: "no slot free: the pool's 1 slot is in use" }))
    const decide = e.wf.createCard({ title: 'Decide', kind: 'no-code' })
    const r = await e.wf.start(decide.key, B1)
    moved(r)
    const s = e.wf.state(decide)
    expect(s.started).toMatchObject({ folder: 'project', cardKind: 'no-code', builder: 'B1' })
    expect(s.started?.lease).toBeUndefined()
    expect(s.started?.slot).toBeUndefined()
    expect(e.wf.folderOf(s)).toBe(e.project)
    expect(asked).toEqual([])
    expect(unused).toEqual([])
    expect(e.store.pendingActions().filter((a) => a.kind === 'prepareSlot')).toEqual([])
    // Nothing tells it to move: it carries on where it runs.
    expect(JSON.stringify((r as { warnings?: string[] }).warnings ?? [])).not.toMatch(/continue in|waits for a slot/)
    // A code card is unchanged: it asks for a slot, and with none free it waits.
    const fix = e.wf.createCard({ title: 'Fix' })
    refusedBy(await e.wf.start(fix.key, B1), 'start.slotAvailable')
    expect(asked.map((a) => a.card)).toEqual([fix.id])
  })

  it("HI-2335: a no-code card's evidence covers the target its slot-less start plans on (#1401)", async () => {
    const { e } = world(() => ({ wait: 'none free' }))
    // The project folder on another branch than the default: a slot's target and the project folder's differ.
    sh(e.project, 'switch', '-q', '-c', 'dev')
    // G7 empty: a slot's target is the default branch, the project folder's is its line.
    const o = { ...e.options, target: '' }
    const p = e.wf.platform(o)
    const primedOf = async (card: ReturnType<typeof e.store.cardByKey> & object) => ((await p.prime(card, e.wf.state(card), o, 'B1')) as { target?: string | null })?.target
    const noCode = e.store.cardByKey(e.wf.createCard({ title: 'No code', kind: 'no-code' }).key)!
    const plan = (await p.start(noCode, o, 'B1', true)) as { target?: string; folder?: string }
    expect([await primedOf(noCode), plan.target, plan.folder]).toEqual(['dev', 'dev', 'project'])
    // A code card's still plans on a slot's target, the default branch.
    const code = e.store.cardByKey(e.wf.createCard({ title: 'Code' }).key)!
    expect(await primedOf(code)).toBe('main')
  })

  it('HI-2335: under Solo and with no version control a no-code card starts as before, in the project folder', async () => {
    for (const platform of ['git', 'none'] as const) {
      const e = (env = setup({ ...preset(platform, 'solo'), preChecks: [] }, { autoRun: false }))
      const asked: number[] = []
      e.wf.cfg.slotFor = async (card) => (asked.push(card.id), { wait: 'none free' })
      for (const kind of ['no-code', 'code'] as const) {
        const card = e.wf.createCard({ title: `${platform} ${kind}`, kind })
        moved(await e.wf.start(card.key, B1))
        expect(e.wf.state(card).started, `${platform} ${kind}`).toMatchObject({ folder: 'project', cardKind: kind })
      }
      expect(asked, platform).toEqual([])
      env.close()
      env = null
    }
  })

  it('HI-2335: the slot rule never holds a no-code card; a code card with no slot free is held', () => {
    const base = { ruleset: null, state: null } as unknown as Omit<GuardInputs, 'card' | 'slotFree'>
    const of = (kind: 'code' | 'no-code', slotFree: boolean) => GUARD_FNS['start.slotAvailable']({ ...base, card: { key: 'AM-1', kind, labels: [], blocked: null }, slotFree } as GuardInputs)
    expect(of('no-code', false)).toBeNull()
    expect(of('code', false)).toMatchObject({ rule: 'start.slotAvailable' })
    expect(of('code', true)).toBeNull()
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

  it("HI-3010: a submission from a slot off the card's line is refused, naming where it is; on its line, it goes", async () => {
    const folder = tempDir('slot-')
    const { e } = world(() => ({ slot: 'slot-a', folder, lease: 'l-1', fresh: true }))
    const card = e.wf.createCard({ title: 'Off its line' })
    moved(await e.wf.start(card.key, B1))
    const s = e.wf.state(card)
    const line = s.started!.line!
    // Its slot never switched onto its line (its preparation waited): its builder committed on the detached head.
    sh(e.project, 'worktree', 'add', '-q', '--detach', folder, s.started!.base!)
    const work = commit(folder, { 'a.txt': 'a\n' }, 'its work', { trailer: card.key })
    const detached = refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'platform.offLine')
    expect(detached.message).toMatch(new RegExp(`isn't on its branch ${line}: its head is detached at ${work.slice(0, 7)}`))
    expect(detached.next).toMatch(new RegExp(`git switch -c ${line}`))
    // On another branch.
    sh(folder, 'switch', '-q', '-c', 'elsewhere')
    expect(refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'platform.offLine').message).toMatch(/: it is on elsewhere,/)
    expect(e.wf.state(card).stage).toBe('active')
    // On its line, made where its work is: submitted.
    sh(folder, 'switch', '-q', '-c', line)
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  })

  it("names a card's line: lower case ASCII letters, digits and hyphens, at most 40, accents folded", () => {
    expect(lineName('AM', { key: 'AM-12', title: 'Fix the Login!' })).toBe('cw/AM/AM-12-fix-the-login')
    expect(slugOf('Café déjà vu — naïve')).toBe('cafe-deja-vu-naive')
    expect(slugOf('日本語のタイトル')).toBe('')
    expect(lineName('AM', { key: 'AM-3', title: '日本語' })).toBe('cw/AM/AM-3')
    const long = slugOf('A very long title that goes on and on, well past the forty characters a line may have')
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long).toBe('a-very-long-title-that-goes-on-and-on-we')
    expect(long.endsWith('-')).toBe(false)
  })
})

// #1551: a slot card's line is made by its slot's preparation, so between its Started and its SlotPrepared it doesn't
// exist yet: reconciliation then takes it neither for gone nor for a head moved to nothing.
describe("a slot card's line before its slot's preparation (#1551)", () => {
  const lineFacts = (e: Env, card: number) => e.store.facts(card).filter((f) => (f.kind === 'Gone' && (f.data as FactData['Gone']).what === 'line') || (f.kind === 'HeadMoved' && (f.data as FactData['HeadMoved']).to === null))

  it('is never gone while its preparation is owed; once prepared, its line deleted is gone as before', async () => {
    const { e } = world(() => ({ slot: 'slot-a', folder: tempDir('slot-'), lease: 'l-1', fresh: true }))
    const card = e.wf.createCard({ title: 'In a slot' })
    moved(await e.wf.start(card.key, B1))
    const s = e.wf.state(card)
    const line = s.started!.line!
    expect(sh(e.project, 'branch', '--list', line)).toBe('')
    expect(slotPreparationOwed(e.wf, card, s)).toBe(true)
    await reconcile(e.wf, card)
    await reconcile(e.wf, card)
    expect(lineFacts(e, card.id)).toEqual([])
    // Its preparation makes the line and records it (slotCards.ts's prepare).
    sh(e.project, 'branch', line, s.started!.base!)
    await e.wf.write(card, null, 'combwork', (w) => void w.fact('SlotPrepared', { lease: 'l-1', line, revision: s.started!.base! }))
    expect(slotPreparationOwed(e.wf, card, e.wf.state(card))).toBe(false)
    await reconcile(e.wf, card)
    expect(lineFacts(e, card.id)).toEqual([])
    // Deleted after that: gone, once.
    sh(e.project, 'branch', '-D', line)
    await reconcile(e.wf, card)
    await reconcile(e.wf, card)
    expect(e.store.facts(card.id).filter((f) => f.kind === 'Gone').map((f) => f.data)).toEqual([{ what: 'line' }])
  })

  it("a preparation of another lease doesn't count: a start again in a new lease owes its own", async () => {
    let lease = 'l-1'
    const { e } = world(() => ({ slot: 'slot-a', folder: tempDir('slot-'), lease, fresh: true }))
    const card = e.wf.createCard({ title: 'Started again' })
    moved(await e.wf.start(card.key, B1))
    const line = e.wf.state(card).started!.line!
    await e.wf.write(card, null, 'combwork', (w) => void w.fact('SlotPrepared', { lease: 'l-1', line, revision: 'r' }))
    expect(slotPreparationOwed(e.wf, card, e.wf.state(card))).toBe(false)
    // Put back, then started again in another slot's lease: the earlier preparation was for the earlier cycle.
    moved(await e.wf.move(card.key, 'todo', 'user'))
    lease = 'l-2'
    moved(await e.wf.start(card.key, B1))
    expect(e.wf.state(card).started).toMatchObject({ lease: 'l-2' })
    expect(slotPreparationOwed(e.wf, card, e.wf.state(card))).toBe(true)
    await reconcile(e.wf, card)
    expect(lineFacts(e, card.id)).toEqual([])
  })

  it("a null read of a prepared cycle's line never marks the cycle started meanwhile (HR6's round 1)", async () => {
    let lease = 'l-1'
    const { e } = world(() => ({ slot: 'slot-a', folder: tempDir('slot-'), lease, fresh: true }))
    const card = e.wf.createCard({ title: 'Race' })
    moved(await e.wf.start(card.key, B1))
    const s = e.wf.state(card)
    const line = s.started!.line!
    await e.wf.write(card, null, 'combwork', (w) => void w.fact('SlotPrepared', { lease, line, revision: s.started!.base! }))
    // Prepared, then deleted outside Combwork before this observer reads it.
    sh(e.project, 'branch', line, s.started!.base!)
    sh(e.project, 'branch', '-D', line)
    let changed = false
    // Between the read and the write: put back and started again under another lease (the same line's name).
    await reconcile(e.wf, card, {
      afterRead: async () => {
        if (changed) return
        changed = true
        moved(await e.wf.move(card.key, 'todo', 'user'))
        lease = 'l-2'
        moved(await e.wf.start(card.key, B1))
      }
    })
    expect(changed).toBe(true)
    expect(e.wf.state(card).started).toMatchObject({ lease: 'l-2', line })
    expect(slotPreparationOwed(e.wf, card, e.wf.state(card))).toBe(true)
    expect(lineFacts(e, card.id)).toEqual([])
  })

  it('a card started outside slots owes nothing', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }, { autoRun: false }))
    const card = e.wf.createCard({ title: 'On its own line' })
    moved(await e.wf.start(card.key, B1))
    expect(slotPreparationOwed(e.wf, card, e.wf.state(card))).toBe(false)
  })
})

describe('a slotted card whose target follows its remote (G21, HI-1183)', () => {
  /** Combwork merges, slots, the target tracking a bare remote; `ahead`: the remote has a commit the local target lacks. */
  function following(ahead: boolean) {
    const e = (env = setup({ ...opts, finish: 'combworkMerges', followRemote: true }, { autoRun: false }))
    const bare = tempDir('remote-').replace(/\\/g, '/') + '/origin.git'
    sh(e.project, 'init', '-q', '--bare', '-b', 'main', bare)
    sh(e.project, 'remote', 'add', 'origin', bare)
    sh(e.project, 'push', '-q', '-u', 'origin', 'main')
    if (ahead) {
      const other = tempDir('other-')
      sh(other, 'clone', '-q', bare, '.')
      sh(other, 'config', 'user.email', 'o@example.com')
      sh(other, 'config', 'user.name', 'O')
      commit(other, { 'theirs.txt': 'x\n' }, 'theirs')
      sh(other, 'push', '-q', 'origin', 'main')
    }
    e.wf.cfg.slotFor = async () => ({ slot: 'slot-a', folder: tempDir('slot-'), lease: 'l-1', fresh: true })
    return { e, bare }
  }

  it('starts from the remote’s head (fetched, never the local one), pinned until its line holds it', async () => {
    const { e, bare } = following(true)
    const card = e.wf.createCard({ title: 'From the remote' })
    moved(await e.wf.start(card.key, B1))
    const remote = sh(bare, 'rev-parse', 'main')
    expect(remote).not.toBe(sh(e.project, 'rev-parse', 'main'))
    expect(e.wf.state(card).started?.base).toBe(remote)
    expect(sh(e.project, 'rev-parse', 'refs/cw/fetch/main')).toBe(remote)
  })

  it('a remote it can’t fetch, or a local target with commits the remote lacks, refuses the start with why', async () => {
    const { e } = following(false)
    commit(e.project, { 'local.txt': 'x\n' }, 'local only')
    const card = e.wf.createCard({ title: 'Diverged' })
    expect(refusedBy(await e.wf.start(card.key, B1), 'platform.unknown').message).toMatch(/push or pull/)
    sh(e.project, 'remote', 'set-url', 'origin', tempDir('gone-').replace(/\\/g, '/') + '/none.git')
    expect(refusedBy(await e.wf.start(card.key, B1), 'platform.unknown').message).toMatch(/which main follows/)
    expect(e.wf.state(card).stage).toBe('todo')
  })
})
