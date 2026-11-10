// HI-2680 (SPEC §16.5.4): when a project's Work merges into moves on (1.1.0 → 1.2.0), on the real board: the preview
// (what can follow the new target, what stays and why), the apply bound to it (each card only from the target it was
// seen with, the project's target still the new one, the caller still allowed), and the finished branch kept in Other
// branches work can merge into while anything records it, serial with a lane start on it.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

const base = tempDir('cw-retarget-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const form = await import('../src/main/workflow/optionsForm')
const retarget = await import('../src/main/workflow/retarget')
const { workflowFor } = await import('../src/main/workflow/service')
const { agentActor } = await import('../src/shared/workflow/facts')
const { preset } = await import('../src/shared/workflow/options')
const { settingEntry } = await import('../src/shared/settingsCatalog')
const settingsTools = await import('../src/main/settingsTools')
const slotsApp = await import('../src/main/slotsApp')
const slots = await import('../src/main/slots')
const { writesAt } = await import('../src/main/dbWrites')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
let n = 0
const { platform: _p, ...pair } = preset('git', 'pair')

/** A Pair project merging into 1.1.0, listing main and 1.2.0 too (each a branch). */
async function project(): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(ws, { recursive: true })
  // The harness's repository and git (its own identity set; no user config needed).
  gitRepo(repo)
  commit(repo, { '.gitignore': '.combwork/\n' }, 'ignore')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  sh(repo, 'branch', '1.1.0')
  sh(repo, 'branch', '1.2.0')
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], workflow: { platform: 'git', preset: 'pair', options: { ...pair, target: '1.1.0', otherTargets: ['main', '1.2.0'] } } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo }
}
const card = (w: WS, title: string) => inWorkspace(w, () => tasks.createTask({ title, project: 'p' }, user))
/** A card's own target set as the board keeps it (one named while 1.1.0 was another listed branch). */
const own = async (w: WS, repo: string, number: number, target: string | null) => {
  const wf = (await workflowFor(w, repo))!
  await store.boardWrite(w, async () => wf.store.updateCard(number, { target: target ?? undefined }))
}
const ownOf = async (w: WS, repo: string, number: number) => (await workflowFor(w, repo))!.store.card(number).target ?? null
/** Work merges into moved on to `to` (as the tab saves it). */
const moveTarget = (w: WS, repo: string, to: string, others = ['main', '1.1.0', '1.2.0'].filter((b) => b !== to)) => inWorkspace(w, () => form.setWorkflowOptions(w, repo, { preset: 'pair', options: { ...pair, target: to, otherTargets: others } }))

describe('the retarget preview (HI-2680)', () => {
  it('moves Todo cards on 1.1.0 with no work; keeps one with work, one started on it in the project folder (HI-2753: no line of its own), and moves a running lane on it (HI-2753: 1.1.0 ended), each with why', async () => {
    const { w, repo } = await project()
    const free = await card(w, 'Free')
    await own(w, repo, free.number, '1.1.0')
    const busy = await card(w, 'Has work')
    await own(w, repo, busy.number, '1.1.0')
    const started = await card(w, 'Started')
    const wf = (await workflowFor(w, repo))!
    expect(await store.boardWrite(w, async () => wf.start(`#${started.number}`, agentActor('b1')))).toMatchObject({ ok: true })
    // Put back with changes left in the project folder it worked in: its work.
    expect(await store.boardWrite(w, async () => wf.start(`#${busy.number}`, agentActor('b1')))).toMatchObject({ ok: true })
    expect(await store.boardWrite(w, async () => wf.putBack(`#${busy.number}`, 'user'))).toMatchObject({ ok: true })
    writeFileSync(join(repo, 'left.txt'), 'left\n')
    const lc = await card(w, 'Lane card')
    // A builder builds and a reviewer reviews (HI-2664 refuses a lane's parts the other way round).
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [lc.number], by: 'You' })
    const p = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.1.0', '1.2.0'))
    expect(p.cards.move.map((c) => c.number)).toEqual([free.number])
    expect(p.cards.keep).toEqual(expect.arrayContaining([expect.objectContaining({ number: busy.number, why: 'work' }), expect.objectContaining({ number: started.number, why: 'noLine' })]))
    // 1.1.0 is all in 1.2.0 (the same commit): it has ended, so the running lane can follow (HI-2753); its card isn't started.
    expect(p.lanes).toEqual([])
    expect(p.laneMoves).toEqual([expect.objectContaining({ builder: 'B1', card: null })])
    // The tab's check shows it while the target changes.
    const check = await inWorkspace(w, () => form.checkWorkflowChange(w, repo, { preset: 'pair', options: { ...pair, target: '1.2.0', otherTargets: ['main', '1.1.0'] } }))
    expect(check.retarget?.cards.move.map((c) => c.number)).toEqual([free.number])
    rmSync(join(repo, 'left.txt'))
  })
})

describe('the retarget apply (HI-2680)', () => {
  it('moves each card as it was previewed; one changed meanwhile, or after the target moved on again, or once refused, stays', async () => {
    const { w, repo } = await project()
    const cards = [await card(w, 'One'), await card(w, 'Two'), await card(w, 'Three')]
    for (const c of cards) await own(w, repo, c.number, '1.1.0')
    const p = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.1.0', '1.2.0'))
    expect(p.cards.move).toHaveLength(3)
    await moveTarget(w, repo, '1.2.0')
    // Two changed to main between the preview and the apply: never overwritten.
    await own(w, repo, cards[1].number, 'main')
    const r = await inWorkspace(w, () => retarget.retargetApply(w, repo, p, user))
    expect(r.moved.cards.map((c) => c.number)).toEqual([cards[0].number, cards[2].number])
    expect(r.skipped).toEqual([expect.objectContaining({ card: cards[1].number, why: 'changed' })])
    // Moved onto the project's own target now: none of its own.
    expect(await ownOf(w, repo, cards[0].number)).toBeNull()
    expect(await ownOf(w, repo, cards[1].number)).toBe('main')
    // The target moved on again (to main) before an apply: nothing more moves.
    const more = await card(w, 'Four')
    await own(w, repo, more.number, '1.1.0')
    const p2 = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.1.0', '1.2.0'))
    await moveTarget(w, repo, 'main')
    const r2 = await inWorkspace(w, () => retarget.retargetApply(w, repo, p2, user))
    expect(r2).toMatchObject({ moved: { cards: [] }, skipped: [{ card: more.number, why: 'targetChanged' }] })
    // Back on 1.2.0, the caller's authority withdrawn: refused, nothing moved.
    await moveTarget(w, repo, '1.2.0')
    const r3 = await inWorkspace(w, () => retarget.retargetApply(w, repo, p2, user, () => { throw new Error('Control turned off') }))
    expect(r3).toMatchObject({ moved: { cards: [] }, skipped: [{ card: more.number, why: 'refused' }] })
    expect(await ownOf(w, repo, more.number)).toBe('1.1.0')
  })
})

describe("the apply's checks at each write, and its failures (HR1's HI-2680 round 1, findings 2 and 3)", () => {
  it("a card's move checks the project's target under the board's lock: changed meanwhile, it stays", async () => {
    const { w, repo } = await project()
    const c = await card(w, 'One')
    await own(w, repo, c.number, '1.1.0')
    // Asked to move while the project's target is 1.1.0 still (as after a check made before the target moved on again).
    await expect(inWorkspace(w, () => tasks.setTarget(c.number, '1.2.0', user, { expect: '1.1.0', expectDefault: '1.2.0' }))).rejects.toThrow(/Work merges into changed again while/)
    expect(await ownOf(w, repo, c.number)).toBe('1.1.0')
  })

  it("a save changing Work merges into waits for the board's lock, so it and a card's move are serial", async () => {
    const { w, repo } = await project()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let entered!: () => void
    const inLock = new Promise<void>((r) => (entered = r))
    const held = store.boardWrite(w, async () => {
      entered()
      await gate
    })
    await inLock
    const save = moveTarget(w, repo, '1.2.0')
    let saved = false
    void save.then(() => (saved = true))
    // While the board's lock is held, the save hasn't written: the project's target is still 1.1.0.
    await new Promise((r) => setImmediate(r))
    expect(saved).toBe(false)
    expect((await w.projectConfig(repo)).workflow?.options.target).toBe('1.1.0')
    release()
    await held
    await save
    expect((await w.projectConfig(repo)).workflow?.options.target).toBe('1.2.0')
  })

  it('a card refused at its write because the target moved on stops the rest (targetChanged), each said', async () => {
    const { w, repo } = await project()
    const cards = [await card(w, 'One'), await card(w, 'Two')]
    for (const c of cards) await own(w, repo, c.number, '1.1.0')
    const p = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.1.0', '1.2.0'))
    await moveTarget(w, repo, '1.2.0')
    // The target moves on again after the check before the first card, before its write: the board's lock held (another
    // board write under way) while the apply passes that check, the project file changed meanwhile, then released.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const held = inWorkspace(w, () => tasks.boardLock(w, () => gate))
    let checked!: () => void
    const passed = new Promise<void>((r) => (checked = r))
    let calls = 0
    const apply = inWorkspace(w, () =>
      retarget.retargetApply(w, repo, p, user, () => {
        if (++calls === 1) checked()
      })
    )
    await passed
    await w.mutateProjectConfig(repo, (cfg) => ({ workflow: { ...cfg.workflow!, options: { ...cfg.workflow!.options, target: 'main', otherTargets: ['1.1.0', '1.2.0'] } } }))
    release()
    await held
    const r = await apply
    expect(r.moved.cards).toEqual([])
    expect(r.skipped.map((s) => [s.card, s.why])).toEqual([
      [cards[0].number, 'targetChanged'],
      [cards[1].number, 'targetChanged']
    ])
    for (const c of cards) expect(await ownOf(w, repo, c.number)).toBe('1.1.0')
  })

  it('a slot failing part way leaves the cards already moved moved, and says the slot failed: never thrown', async () => {
    const { w, repo } = await project()
    const c = await card(w, 'One')
    await own(w, repo, c.number, '1.1.0')
    const p = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.1.0', '1.2.0'))
    await moveTarget(w, repo, '1.2.0')
    const { poolFor } = await import('../src/main/slotsApp')
    const pool = await poolFor(w, repo)
    const real = pool.retarget.bind(pool)
    pool.retarget = async () => {
      throw new Error('database is locked')
    }
    try {
      const withSlot = { ...p, slots: { move: [{ name: 'slot-a', folder: join(repo, '..', 'slot-a'), target: '1.1.0', head: 'abc1234' }], keep: [] } }
      const r = await inWorkspace(w, () => retarget.retargetApply(w, repo, withSlot, user))
      expect(r.moved.cards.map((x) => x.number)).toEqual([c.number])
      expect(r.skipped).toEqual([expect.objectContaining({ slot: 'slot-a', why: 'failed', detail: 'database is locked' })])
    } finally {
      pool.retarget = real
    }
  })
})

describe("the Assistant's offered previews (HR1's HI-2680 round 1, finding 4)", () => {
  it('are kept by id for their own project only, narrowed to the items named, unknown ones said', async () => {
    const { w, repo } = await project()
    const c = await card(w, 'Free')
    await own(w, repo, c.number, '1.1.0')
    const p = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.1.0', '1.2.0'))
    const id = retarget.offerRetarget(repo, p)
    expect(retarget.offeredRetarget(id, repo)).toBe(p)
    expect(retarget.offeredRetarget(id, join(repo, '..', 'other'))).toBeNull()
    expect(retarget.offeredRetarget('rt-00000000', repo)).toBeNull()
    // A day later: gone.
    expect(retarget.offeredRetarget(id, repo, Date.now() + 25 * 60 * 60 * 1000)).toBeNull()
    const key = p.cards.move[0].key
    const { confirmed, unknown } = retarget.offeredItems(p, [key.toLowerCase(), 'slot-z', key])
    expect(confirmed.cards.move.map((x) => x.number)).toEqual([c.number])
    expect(unknown).toEqual(['slot-z'])
  })

  it('apply as offered: a card changed since the offer stays as it was changed', async () => {
    const { w, repo } = await project()
    const c = await card(w, 'Free')
    await own(w, repo, c.number, '1.1.0')
    const offered = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.1.0', '1.2.0'))
    await moveTarget(w, repo, '1.2.0')
    // Set to main by hand after the offer: the apply checks it against the target the offer saw, so it stays.
    await own(w, repo, c.number, 'main')
    const r = await inWorkspace(w, () => retarget.retargetApply(w, repo, retarget.offeredItems(offered, [offered.cards.move[0].key]).confirmed, user))
    expect(r).toMatchObject({ moved: { cards: [] }, skipped: [{ card: c.number, why: 'changed' }] })
    expect(await ownOf(w, repo, c.number)).toBe('main')
  })

  it('at most 50 are kept, the oldest dropped first', () => {
    const p = { from: 'a', to: 'b', cards: { move: [], keep: [] }, slots: { move: [], keep: [] }, lanes: [] }
    const ids = Array.from({ length: 51 }, () => retarget.offerRetarget('C:/x/p', p))
    expect(retarget.offeredRetarget(ids[0], 'C:/x/p')).toBeNull()
    expect(retarget.offeredRetarget(ids[50], 'C:/x/p')).toBe(p)
  })
})

describe('the finished branch in Other branches work can merge into (HI-2680)', () => {
  it('stays while anything records it: the tab and the settings tool refuse taking it out, naming what; once moved, it goes', async () => {
    const { w, repo } = await project()
    const c = await card(w, 'Still on 1.1.0')
    await own(w, repo, c.number, '1.1.0')
    await moveTarget(w, repo, '1.2.0', ['main', '1.1.0'])
    await expect(moveTarget(w, repo, '1.2.0', ['main'])).rejects.toThrow(/1\.1\.0 can’t be taken out of Other branches work can merge into while these use it: .*Still|HI-\d+|#\d+/)
    await expect(inWorkspace(w, () => settingsTools.applySetting(settingEntry('project.workflow.otherTargets')!, ['main'], repo))).rejects.toThrow(/1\.1\.0 can’t be taken out/)
    const p = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.1.0', '1.2.0'))
    await inWorkspace(w, () => retarget.retargetApply(w, repo, p, user))
    await moveTarget(w, repo, '1.2.0', ['main'])
    expect((await w.projectConfig(repo)).workflow?.options.otherTargets).toEqual(['main'])
  })

  it('a lane start on it and its removal are serial: whichever comes second is refused', async () => {
    // The lane first: the removal is refused, naming the lane.
    {
      const { w, repo } = await project()
      await moveTarget(w, repo, '1.2.0', ['main', '1.1.0'])
      const c = await card(w, 'Lane card')
      await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c.number], by: 'You', target: '1.1.0' })
      await expect(moveTarget(w, repo, '1.2.0', ['main'])).rejects.toThrow(/1\.1\.0 can’t be taken out .*B1/)
    }
    // The removal first: it holds the lanes' lock (as the save does) while it writes the list; the start, its own check
    // made before or after, decides under that lock afterwards and is refused, nothing recorded.
    {
      const { w, repo } = await project()
      await moveTarget(w, repo, '1.2.0', ['main', '1.1.0'])
      const c = await card(w, 'Lane card')
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const removal = lanes.withLanesLock(w, async () => {
        await gate
        await w.mutateProjectConfig(repo, (cfg) => ({ workflow: { ...cfg.workflow!, options: { ...cfg.workflow!.options, otherTargets: ['main'] } } }))
      })
      const start = lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c.number], by: 'You', target: '1.1.0' })
      release()
      await removal
      await expect(start).rejects.toThrow(/1\.1\.0 isn’t a branch work can merge into here/)
      expect(await lanes.laneOf(w, 'p', 'b1')).toBeNull()
    }
  })

  it("the settings tool's reply to a target change names what can follow it, and how", async () => {
    const { w, repo } = await project()
    const c = await card(w, 'Free')
    await own(w, repo, c.number, '1.1.0')
    await inWorkspace(w, () => settingsTools.applySetting(settingEntry('project.workflow.otherTargets')!, ['main', '1.1.0'], repo))
    const r = await inWorkspace(w, () => settingsTools.applySetting(settingEntry('project.workflow.target')!, '1.2.0', repo))
    expect(r.note).toMatch(/These still on 1\.1\.0 can follow 1\.2\.0 .*: .*\. To move them, ask the user, then cw_queue retarget/)
  })
})

describe('a slot counts against a branch in Other branches only while it uses it (HI-2886)', () => {
  let slotN = 0
  /** Takes 1.2.0 out of Other branches work can merge into, as the tab saves it. */
  const removeByForm = (w: WS, repo: string) => inWorkspace(w, () => form.setWorkflowOptions(w, repo, { preset: 'pair', options: { ...pair, target: '1.1.0', otherTargets: ['main'] } }))
  /** The same, as the settings tool saves it. */
  const removeByTool = (w: WS, repo: string) => inWorkspace(w, () => settingsTools.applySetting(settingEntry('project.workflow.otherTargets')!, ['main'], repo))
  const othersOf = async (w: WS, repo: string) => (await w.projectConfig(repo)).workflow?.options.otherTargets
  const poolOf = (w: WS, repo: string) => slotsApp.poolFor(w, repo)
  /** A slot of the project recording `target`, ready unless `set` (its other columns) says otherwise; its name. */
  async function slot(w: WS, repo: string, target: string, set: Record<string, string | number> = {}): Promise<string> {
    const id = (await poolOf(w, repo)).deps.store.project
    const name = `slot-${++slotN}`
    const at = new Date().toISOString()
    await store.boardWrite(w, async () =>
      store.boardWriteOp(w, (db) => {
        db.prepare("INSERT INTO slots (project, name, folder, state, port_base, target, created_at, used_at) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?)").run(id, name, join(base, 'slots', name), 41000 + 10 * slotN, target, at, at)
        const cols = Object.keys(set)
        if (cols.length) db.prepare(`UPDATE slots SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE project = ? AND name = ?`).run(...Object.values(set), id, name)
      })
    )
    return name
  }
  /** A lease of `name` (a card's or a carried one), open or ended. */
  async function lease(w: WS, repo: string, name: string, kind: 'card' | 'carried', open: boolean): Promise<void> {
    const id = (await poolOf(w, repo)).deps.store.project
    const at = new Date().toISOString()
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare('INSERT INTO slot_leases (id, project, slot, kind, card, agent, from_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(`l-${name}`, id, name, kind, kind === 'card' ? 9000 + slotN : null, `a-${name}`, at, open ? null : at)))
  }
  /** Gone, with its leases and any set-aside record. */
  async function drop(w: WS, repo: string, name: string): Promise<void> {
    const id = (await poolOf(w, repo)).deps.store.project
    await store.boardWrite(w, async () =>
      store.boardWriteOp(w, (db) => {
        db.prepare('DELETE FROM slots WHERE project = ? AND name = ?').run(id, name)
        db.prepare('DELETE FROM board_meta WHERE key = ?').run(slots.asideKey(id, name))
      })
    )
  }
  /** The pool's own lend of `name`, as a card's start asks for it. */
  const take = async (w: WS, repo: string, name: string) => (await poolOf(w, repo)).deps.store.take({ card: 8000 + ++slotN, agent: `t-${slotN}`, slot: name }, { size: 99, root: join(base, 'slots'), target: null, token: `tk-${slotN}`, holder: { pid: process.pid, started: 1 } })
  const refusedFor = (name: string) => new RegExp(`1\\.2\\.0 can’t be taken out .*${name}`)

  it('a free slot that last served it (ready, its lease ended) no longer keeps it: both saves take it out', async () => {
    for (const remove of [removeByForm, removeByTool]) {
      const { w, repo } = await project()
      const name = await slot(w, repo, '1.2.0')
      await lease(w, repo, name, 'card', false)
      // Read in the save's own board write, after the pool was opened (HI-2886): never a list read before its locks.
      const pooled = (await poolOf(w, repo)).deps.store
      const read = pooled.targetsInUse.bind(pooled)
      const inWrite: boolean[] = []
      pooled.targetsInUse = () => (inWrite.push(store.inBoardWrite(dirname(repo))), read())
      try {
        await remove(w, repo)
      } finally {
        pooled.targetsInUse = read
      }
      expect(inWrite).toEqual([true])
      expect(await othersOf(w, repo)).toEqual(['main'])
      // Still lendable, and still recording 1.2.0 (only its next start records another).
      expect((await poolOf(w, repo)).deps.store.slot(name)?.target).toBe('1.2.0')
      expect(await take(w, repo, name)).toMatchObject({ ok: true })
    }
  })

  it('a slot that uses it keeps it, named, in both saves: lent, dirty, gone, set aside, reserved, with a job, a writer, an open lease or a failed setup; take refuses each too', async () => {
    const { w, repo } = await project()
    const cases: { what: string; set?: Record<string, string | number>; lease?: 'card' | 'carried'; aside?: boolean }[] = [
      { what: 'lent', set: { state: 'lent' }, lease: 'card' },
      { what: 'dirty', set: { state: 'dirty' } },
      { what: 'gone', set: { state: 'gone' } },
      { what: 'set aside', aside: true },
      { what: 'reserved by an operation', set: { op: 'tk-op', op_kind: 'warm', op_pid: 1, op_started: 1 } },
      { what: 'a job', set: { job: 'job-1' } },
      { what: 'a writer', set: { writer_run: 'run-1', writer_lease: 'l-x', writer_agent: 'b1', writer_pid: 1, writer_started: 1 } },
      { what: 'an open card lease', lease: 'card' },
      { what: 'an open carried lease', lease: 'carried' },
      { what: 'a failed setup', set: { warm_error: 'setup failed' } }
    ]
    for (const c of cases) {
      const name = await slot(w, repo, '1.2.0', c.set)
      if (c.lease) await lease(w, repo, name, c.lease, true)
      if (c.aside) {
        const id = (await poolOf(w, repo)).deps.store.project
        await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?)').run(slots.asideKey(id, name), '{}')))
      }
      await expect(removeByForm(w, repo), c.what).rejects.toThrow(refusedFor(name))
      await expect(removeByTool(w, repo), c.what).rejects.toThrow(refusedFor(name))
      expect((await poolOf(w, repo)).deps.store.targetsInUse(), c.what).toEqual([{ name, target: '1.2.0' }])
      expect(await take(w, repo, name), c.what).toMatchObject({ ok: false })
      expect(await othersOf(w, repo), c.what).toEqual(['main', '1.2.0'])
      await drop(w, repo, name)
    }
    await removeByForm(w, repo)
    expect(await othersOf(w, repo)).toEqual(['main'])
  })

  it('a lease taken on another connection before the save is seen by it: refused; once the slot is free again, it goes', async () => {
    const { w, repo } = await project()
    const name = await slot(w, repo, '1.2.0')
    const id = (await poolOf(w, repo)).deps.store.project
    const other = new slots.SlotStore(slots.fileSlotConn(store.boardFile(dirname(repo))), id)
    try {
      const r = await other.take({ card: 7001, agent: 'o1', slot: name }, { size: 99, root: join(base, 'slots'), target: null, token: 'tk-other', holder: { pid: process.pid, started: 1 } })
      if (!r.ok) throw new Error(`not lent: ${JSON.stringify(r.refusal)}`)
      await expect(removeByForm(w, repo)).rejects.toThrow(refusedFor(name))
      // Its start ended and the slot settled free (no operation, the lease ended): nothing uses 1.2.0 any more.
      await other.end(r.lease.id, 'done')
      await other.conn.write((db) => db.prepare('UPDATE slots SET op = NULL, op_kind = NULL, op_lease = NULL, op_pid = NULL, op_started = NULL WHERE project = ? AND name = ?').run(id, name))
    } finally {
      other.conn.close()
    }
    await removeByForm(w, repo)
    expect(await othersOf(w, repo)).toEqual(['main'])
  })

  it("a lease asked for while the save decides waits for the save's board write: the save goes through, the lend after it", async () => {
    const { w, repo } = await project()
    const name = await slot(w, repo, '1.2.0')
    // The save held at its file write: inside its board write, after its check.
    const real = w.mutateProjectConfig.bind(w)
    const order: string[] = []
    let reached!: () => void
    const atWrite = new Promise<void>((r) => (reached = r))
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    w.mutateProjectConfig = (async (...args: Parameters<typeof real>) => {
      if (store.inBoardWrite(dirname(repo))) {
        reached()
        await gate
        const out = await real(...args)
        order.push('save')
        return out
      }
      return real(...args)
    }) as typeof w.mutateProjectConfig
    try {
      const save = removeByForm(w, repo)
      await atWrite
      // Asked from outside the save's change: its own board write, never the save's, waiting for the board's lock.
      const lend = take(w, repo, name).then((r) => (order.push('lend'), r))
      await vi.waitFor(() => expect(writesAt(dirname(repo), dirname(repo))).toBe(2))
      release()
      await save
      expect(await lend).toMatchObject({ ok: true })
      expect(order).toEqual(['save', 'lend'])
      expect(await othersOf(w, repo)).toEqual(['main'])
    } finally {
      w.mutateProjectConfig = real
    }
  })

  it("inside a board write, the slots read are that write's own, uncommitted ones included", async () => {
    const { w, repo } = await project()
    const uses = await retarget.slotUses(w, repo)
    const id = (await poolOf(w, repo)).deps.store.project
    const at = new Date().toISOString()
    const seen = await store.boardWrite(w, async () => {
      store.boardWriteOp(w, (db) => db.prepare("INSERT INTO slots (project, name, folder, state, port_base, target, created_at, used_at) VALUES (?, 'slot-u', ?, 'lent', 49990, '1.2.0', ?, ?)").run(id, join(base, 'slots', `u-${n}`), at, at))
      return uses.inUse()
    })
    expect(seen).toEqual([{ name: 'slot-u', target: '1.2.0' }])
  })

  it("a branch's deletion (the Assistant's undo) still counts a free slot recording it", async () => {
    const { w, repo } = await project()
    const name = await slot(w, repo, '1.2.0')
    const uses = await retarget.slotUses(w, repo)
    expect(await retarget.referencesTo(w, repo, '1.2.0', () => uses.all())).toEqual([name])
    expect(await retarget.referencesTo(w, repo, '1.2.0', () => uses.inUse())).toEqual([])
  })
})
