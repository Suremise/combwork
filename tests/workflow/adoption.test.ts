// The upgrade's adoption (#1218, SPEC §16.17, workflow/adoption.ts): each project gets options matching how it works,
// cards from before 1.0 are marked and get no facts, and cards in flight are adopted from what their folder shows. Run
// again, or by two at once, it adds nothing, and a card changed while it runs is never written from stale reads.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from '../tempDir'
import { as09, readCard, writeCard, writeCardOutside } from '../boardDb'
import { commit, gitRepo, sh } from './harness'
import { allOff } from '../../src/shared/workflow/options'
import { foldCard, type Fact } from '../../src/shared/workflow/facts'

const base = tempDir('hive-adoption-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../../src/main/workspace')
const store = await import('../../src/main/boardStore')
const tasks = await import('../../src/main/tasks')
const { adoptNow, adoptWorkspace } = await import('../../src/main/workflow/adoption')
const { FactStore } = await import('../../src/main/workflow/factStore')
const { cardWork } = await import('../../src/main/workflow/cardWork')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const at = new Date(Date.UTC(2026, 9, 1)).toISOString()
const card = (number: number, project: string, column: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ number, title: `Card ${number}`, description: '', project, agent: null, column, order: number, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: at, createdBy: 'You', updatedAt: at, ...more })

async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}

let n = 0
/**
 * A workspace whose board 0.9 left, upgraded to 1.0 (its adoption not run yet): a Git project `p` (a builder B1 in a
 * worktree off main, one commit ahead, and a reviewer), a None project `n`, and a card in each column; returns it and
 * where B1's worktree is.
 */
async function world(): Promise<{ ws: string; w: WS; wt: string }> {
  const ws = join(base, `ws-${++n}`)
  const p = gitRepo(join(ws, 'p'))
  const wt = join(base, `wt-${n}`)
  sh(p, 'worktree', 'add', '-q', '-b', 'hive/b1', wt)
  commit(wt, { 'src/b.txt': 'b1\n' }, 'B1 builds')
  mkdirSync(join(p, '.combwork'), { recursive: true })
  writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1', worktree: { path: wt, branch: 'hive/b1', base: 'main' } }, { id: 'r1', name: 'R1 (reviewer)' }] }))
  mkdirSync(join(ws, 'n', '.combwork'), { recursive: true })
  writeFileSync(join(ws, 'n', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  const w = await open(ws)
  const cards = [
    card(1, 'p', 'todo'),
    card(2, 'p', 'doing', { agent: 'b1', agentName: 'B1' }),
    card(3, 'p', 'review', { agent: 'b1', agentName: 'B1' }),
    card(4, 'p', 'passed', { agent: 'b1', agentName: 'B1' }),
    card(5, 'p', 'done'),
    card(6, 'p', 'onhold'),
    card(7, 'p', 'doing', { archived: true }),
    card(8, 'n', 'doing', { agent: 'a1', agentName: 'Agent 1' }),
    card(9, '', 'doing'),
    card(10, 'gone', 'review')
  ]
  for (const c of cards) await writeCard(w, c.number as number, c)
  // As 0.9 left it, then upgraded: the cards up to here are the adoption's.
  opened.splice(opened.indexOf(w), 1)
  await disposeWorkspaceService(w)
  store.closeBoard(ws)
  as09(store.boardFile(ws))
  const up = await open(ws)
  await inWorkspace(up, () => store.upgradeBoard(up))
  return { ws, w: up, wt }
}

/** Runs `fn` once, just after the adoption has classified the cards (its first read after its snapshot is the projects' list). */
function afterSnapshot(w: WS, fn: () => void): void {
  const list = w.listProjectPaths.bind(w)
  let done = false
  w.listProjectPaths = async (opts) => {
    if (!done) {
      done = true
      fn()
    }
    return list(opts)
  }
}
/** A card's saved document changed by another Combwork (its own connection to the file). */
const editOutside = (ws: string, w: WS, num: number, change: Record<string, unknown>): void => writeCardOutside(ws, num, { ...readCard(w, num), ...change })

const factsOf = (w: WS, project: string, num: number): { kind: string; data: Record<string, unknown>; source: string }[] => FactStore.forBoard(w, { project, key: project }).facts(num) as never
const foldOf = (w: WS, project: string, num: number) => foldCard(FactStore.forBoard(w, { project, key: project }).facts(num) as Fact[])
const marked = (w: WS): number[] => store.adoptionCards(w).filter((c) => c.preWorkflow).map((c) => c.number)
const cardOf = (w: WS, num: number) => store.adoptionCards(w).find((c) => c.number === num)
const allFacts = (w: WS): number => store.boardRead(w, (db) => (db.prepare('SELECT COUNT(*) AS n FROM card_facts').get() as { n: number }).n)
const config = (ws: string, project: string): Record<string, unknown> => JSON.parse(readFileSync(join(ws, project, '.combwork', 'project.json'), 'utf8'))
const clearDone = (w: WS): Promise<unknown> => store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare("DELETE FROM board_meta WHERE key = 'adoption'").run()))

describe("the upgrade's adoption (#1218)", () => {
  it('marks cards from before 1.0, adopts those in flight, and gives each project its options', async () => {
    const { ws, w, wt } = await world()
    const r = await adoptNow(w)
    expect(r).toEqual({ adopted: 4, marked: 6, configured: 2, failed: 0, changed: 0 })
    // Todo, Done, On Hold, archived, a workspace card and a removed project's: no facts, marked.
    expect(marked(w)).toEqual([1, 5, 6, 7, 9, 10])
    for (const c of [1, 5, 6, 7]) expect(factsOf(w, 'p', c)).toEqual([])
    // Doing: Adopted from B1's worktree, merging into main, with the head it observed (a commit ahead of its base).
    const head = sh(wt, 'rev-parse', 'HEAD')
    const mainHead = sh(join(ws, 'p'), 'rev-parse', 'main')
    expect(head).not.toBe(mainHead)
    const doing = factsOf(w, 'p', 2)
    expect(doing.map((f) => f.kind)).toEqual(['Adopted'])
    expect(doing[0]).toMatchObject({ source: 'observed', data: { folder: wt, line: 'hive/b1', base: mainHead, head, target: 'main', builder: 'b1', adoptedFrom: 'doing' } })
    // Review: Adopted, and an adopted Submitted at its head with the change's files.
    const review = factsOf(w, 'p', 3)
    expect(review.map((f) => f.kind)).toEqual(['Adopted', 'Submitted'])
    expect(review[1].data).toMatchObject({ revision: head, base: mainHead, adopted: true, files: [expect.objectContaining({ path: 'src/b.txt' })] })
    // Passed: Adopted with passedBefore1_0, its head, and no verdict.
    const passed = factsOf(w, 'p', 4)
    expect(passed.map((f) => f.kind)).toEqual(['Adopted'])
    expect(passed[0].data).toMatchObject({ adoptedFrom: 'passed', passedBefore1_0: true, base: mainHead, head })
    // The fold keeps the head observed apart from the base (Doing and Passed have no submission to carry it).
    for (const c of [2, 3, 4]) expect(foldOf(w, 'p', c)).toMatchObject({ head, started: { base: mainHead } })
    // Each at the stage its column stands for (no Moved: a card's stage is its column's until a 1.0 rule moves it).
    const fs = FactStore.forBoard(w, { project: 'p', key: 'p' })
    expect([2, 3, 4].map((c) => fs.card(c).stage)).toEqual(['active', 'review', 'approved'])
    // None: adopted with nothing read (unknown, never a failure); its head unknown in the fold too.
    expect(factsOf(w, 'n', 8)[0]).toMatchObject({ kind: 'Adopted', data: { folder: 'project', line: null, base: null, head: null, target: null, builder: 'a1' } })
    expect(foldOf(w, 'n', 8).head).toBeNull()
    // Options as it works today: Git with a reviewer agent and worktrees; None with neither. The platform recorded too.
    expect(config(ws, 'p')).toMatchObject({ platform: 'git', workflow: { platform: 'git', preset: null, options: { review: 'agent', noSelfReview: true, folder: 'slots' } } })
    expect(config(ws, 'n')).toMatchObject({ platform: 'none', workflow: { platform: 'none', preset: null, options: { review: 'none', folder: 'project' } } })
    // HI-1697: Git's merge style and commit message weren't chosen: the merge queue asks before the first merge. None merges nothing.
    expect((config(ws, 'p').workflow as Record<string, unknown>).mergeAsk).toBe(true)
    expect((config(ws, 'n').workflow as Record<string, unknown>).mergeAsk).toBeUndefined()
    const rulesets = store.boardRead(w, (db) => (db.prepare('SELECT COUNT(*) AS n FROM rulesets').get() as { n: number }).n)
    expect(rulesets).toBe(2)
    // The card's work view (#1223) reads them so: adopted from its column, its submission adopted; a Todo card from before 1.0.
    expect(cardWork(w, 3)).toMatchObject({ adopted: true, adoptedFrom: 'review', preWorkflow: false, revisions: [expect.objectContaining({ revision: head, adopted: true })] })
    expect(cardWork(w, 4)).toMatchObject({ adopted: true, adoptedFrom: 'passed' })
    expect(cardWork(w, 1)).toMatchObject({ adopted: false, preWorkflow: true, revisions: [] })
    // Nothing moved on the board.
    expect(store.adoptionCards(w).map((c) => c.column)).toEqual(['todo', 'doing', 'review', 'passed', 'done', 'onhold', 'doing', 'doing', 'doing', 'review'])
  })

  it('a Started fact, and an Adopted one from before round 2, keep their base as the head', () => {
    const started = (kind: 'Started' | 'Adopted'): Fact => ({ card: 1, seq: 1, kind, at, actor: 'hive', source: 'observed', data: { folder: 'project', line: 'main', base: 'b0', target: 'main', builder: 'b1', cardKind: 'code' } }) as unknown as Fact
    expect(foldCard([started('Started')]).head).toBe('b0')
    expect(foldCard([started('Adopted')]).head).toBe('b0')
  })

  it('runs once: after it has finished, and run again even with its mark gone, it adds nothing', async () => {
    const { ws, w } = await world()
    await adoptNow(w)
    const facts = allFacts(w)
    const before = readFileSync(join(ws, 'p', '.combwork', 'project.json'), 'utf8')
    expect(await adoptNow(w)).toBeNull()
    await clearDone(w)
    expect(await adoptNow(w)).toEqual({ adopted: 0, marked: 0, configured: 0, failed: 0, changed: 0 })
    expect(allFacts(w)).toBe(facts)
    expect(readFileSync(join(ws, 'p', '.combwork', 'project.json'), 'utf8')).toBe(before)
  })

  it('two at once (another Combwork, a start during the upgrade) add each fact once', async () => {
    const { w } = await world()
    const [a, b] = await Promise.all([adoptNow(w), adoptNow(w)])
    expect(a!.adopted + b!.adopted).toBe(4)
    expect(a!.marked + b!.marked).toBe(6)
    expect(a!.configured + b!.configured).toBe(2)
    for (const c of [2, 3, 4]) expect(factsOf(w, 'p', c).filter((f) => f.kind === 'Adopted')).toHaveLength(1)
    expect(factsOf(w, 'p', 3).filter((f) => f.kind === 'Submitted')).toHaveLength(1)
    // And the coalesced run (what Combwork starts) while another is going: one run.
    const facts = allFacts(w)
    await clearDone(w)
    await Promise.all([adoptWorkspace(w), adoptWorkspace(w)])
    expect(allFacts(w)).toBe(facts)
    expect(store.boardValue(w, 'adoption')).not.toBeNull()
  })

  it('handles only the cards from before 1.0: one made since is never marked, and a board made by 1.0 adopts nothing', async () => {
    const { w } = await world()
    await writeCard(w, 11, card(11, 'p', 'todo'))
    expect(await adoptNow(w)).toMatchObject({ marked: 6 })
    expect(cardOf(w, 11)).toMatchObject({ preWorkflow: false, facts: false })
    // A new board: none of its cards are from before 1.0.
    const fresh = join(base, `ws-${++n}`)
    mkdirSync(join(fresh, 'q', '.combwork'), { recursive: true })
    writeFileSync(join(fresh, 'q', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    const f = await open(fresh)
    await writeCard(f, 1, card(1, 'q', 'doing'))
    expect(await adoptNow(f)).toMatchObject({ adopted: 0, marked: 0 })
    expect(store.adoptionCards(f)).toMatchObject([{ number: 1, facts: false, preWorkflow: false }])
  })

  it('leaves a card another Combwork started after its snapshot as it is, its stage and column too', async () => {
    const { ws, w } = await world()
    afterSnapshot(w, () => {
      const other = FactStore.open(store.boardFile(ws), { project: 'p', key: 'p' })
      other.tx((tx) => {
        tx.append(2, { kind: 'Moved', actor: 'user', source: 'recorded', data: { from: 'active', to: 'review', cause: 'user' } })
        tx.setStage(2, 'review')
      })
      other.close()
    })
    const r = await adoptNow(w)
    expect(factsOf(w, 'p', 2).map((f) => f.kind)).toEqual(['Moved'])
    expect(FactStore.forBoard(w, { project: 'p', key: 'p' }).card(2)).toMatchObject({ stage: 'review', category: 'review' })
    // Not this run's: the others adopted, and the run finished.
    expect(r).toMatchObject({ adopted: 3, changed: 0 })
    expect(store.boardValue(w, 'adoption')).not.toBeNull()
  })

  it('a card moved after its snapshot is classified again from fresh data, never written from stale reads', async () => {
    const { ws, w } = await world()
    // The Doing card moved to Done meanwhile (no facts), and the Todo card started as on 0.9 (Doing, no facts).
    afterSnapshot(w, () => {
      editOutside(ws, w, 2, { column: 'done' })
      editOutside(ws, w, 1, { column: 'doing', agent: 'b1', agentName: 'B1' })
    })
    expect(await adoptNow(w)).toMatchObject({ changed: 2 })
    expect(factsOf(w, 'p', 2)).toEqual([])
    expect(cardOf(w, 2)).toMatchObject({ column: 'done', preWorkflow: false })
    expect(cardOf(w, 1)).toMatchObject({ column: 'doing', preWorkflow: false, facts: false })
    // Not finished: the next run reads them again, and handles them as they are now.
    expect(store.boardValue(w, 'adoption')).toBeNull()
    expect(await adoptNow(w)).toMatchObject({ adopted: 1, marked: 1, changed: 0 })
    expect(factsOf(w, 'p', 1).map((f) => f.kind)).toEqual(['Adopted'])
    expect(cardOf(w, 2)).toMatchObject({ column: 'done', preWorkflow: true, facts: false })
    expect(cardOf(w, 1)?.column).toBe('doing')
    expect(store.boardValue(w, 'adoption')).not.toBeNull()
  })

  it("a card whose agent's folder changed after it was read is read again, by Combwork's run itself", async () => {
    const { ws, w } = await world()
    const file = join(ws, 'p', '.combwork', 'project.json')
    sh(join(ws, 'p'), 'branch', 'release')
    afterSnapshot(w, () => {
      const cfg = JSON.parse(readFileSync(file, 'utf8'))
      cfg.agents[0].worktree.base = 'release'
      writeFileSync(file, JSON.stringify(cfg))
    })
    await adoptWorkspace(w)
    // Read again with the folder as it is now: merging into release.
    for (const c of [2, 3, 4]) expect(factsOf(w, 'p', c).filter((f) => f.kind === 'Adopted').map((f) => f.data.target)).toEqual(['release'])
    expect(store.boardValue(w, 'adoption')).not.toBeNull()
  })

  it('leaves a card started before it runs, and options already set, as they are', async () => {
    const { ws, w } = await world()
    // Card 2 started under 1.0 by another Hive before this one adopts it: it has facts, so it isn't adopted.
    const other = FactStore.open(store.boardFile(ws), { project: 'p', key: 'p' })
    other.tx((tx) => tx.append(2, { kind: 'Moved', actor: 'user', source: 'recorded', data: { from: 'todo', to: 'active', cause: 'user' } }))
    other.close()
    const own = { platform: 'git', preset: null, options: { ...allOff('git'), review: 'none' } }
    const cfg = config(ws, 'p')
    writeFileSync(join(ws, 'p', '.combwork', 'project.json'), JSON.stringify({ ...cfg, workflow: own }))
    const r = await adoptNow(w)
    expect(config(ws, 'p').workflow).toEqual(own)
    expect(r!.configured).toBe(1)
    expect(factsOf(w, 'p', 2).map((f) => f.kind)).toEqual(['Moved'])
    expect(marked(w)).not.toContain(2)
  })

  it("an adopted card's cycle goes on under the ruleset it was adopted with: its submission, review and verdict (#1249)", async () => {
    const { w } = await world()
    await adoptNow(w)
    const adopted = (factsOf(w, 'p', 2)[0] as unknown as { ruleset?: string }).ruleset
    expect(adopted).toEqual(expect.any(String))
    const b1 = { kind: 'agent', name: 'B1 (p)', self: { project: 'p', agentId: 'b1' } } as const
    const r1 = { kind: 'agent', name: 'R1 (p)', self: { project: 'p', agentId: 'r1' } } as const
    await inWorkspace(w, () => tasks.updateTask(2, { column: 'review' }, b1, { comment: 'Done' }))
    await inWorkspace(w, () => tasks.updateTask(2, { review: 'start' }, r1))
    await inWorkspace(w, () => tasks.updateTask(2, { review: 'failed' }, r1, { comment: 'Needs a test' }))
    const after = factsOf(w, 'p', 2) as unknown as { kind: string; ruleset?: string }[]
    // The agents' old moves are intents (#1268): the submission's move after it, the failed verdict's back to Active.
    expect(after.map((f) => f.kind)).toEqual(['Adopted', 'Submitted', 'Moved', 'ReviewStarted', 'Verdict', 'Moved'])
    for (const f of after) expect([f.kind, f.ruleset]).toEqual([f.kind, adopted])
  })
})

// A copy of the live board (HIVE_STORE_ROUNDTRIP_DB, never the file in place): every card handled, none moved, once.
describe.runIf(!!process.env.HIVE_STORE_ROUNDTRIP_DB && existsSync(process.env.HIVE_STORE_ROUNDTRIP_DB))('on a copy of a live board (#1218)', () => {
  it('handles every card once and moves none', async () => {
    const ws = join(base, 'live')
    mkdirSync(join(ws, '.combwork'), { recursive: true })
    copyFileSync(process.env.HIVE_STORE_ROUNDTRIP_DB!, join(ws, '.combwork', 'hive.db'))
    const w = await open(ws)
    if (store.upgradeWaiting(ws)) await inWorkspace(w, () => store.upgradeBoard(w))
    const before = store.adoptionCards(w)
    // Its projects as plain folders (None): their cards in flight are adopted with nothing read.
    for (const p of new Set(before.map((c) => c.project).filter((name) => name && /^[\w.-]+$/.test(name)))) {
      mkdirSync(join(ws, p, '.combwork'), { recursive: true })
      writeFileSync(join(ws, p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    }
    const inFlight = before.filter((c) => !c.archived && ['doing', 'review', 'passed'].includes(c.column) && c.project && existsSync(join(ws, c.project))).length
    const t0 = performance.now()
    const r = await adoptNow(w)
    const ms = performance.now() - t0
    const after = store.adoptionCards(w)
    expect(r).not.toBeNull()
    expect(r!.failed + r!.changed).toBe(0)
    expect(r!.adopted).toBe(inFlight)
    expect(after.map((c) => [c.number, c.column])).toEqual(before.map((c) => [c.number, c.column]))
    // Every card is marked or has facts; none both.
    for (const c of after) expect(c.preWorkflow !== c.facts).toBe(true)
    console.log(`adoption of a live board copy: ${after.length} cards, ${r!.adopted} adopted, ${r!.marked} marked in ${ms.toFixed(0)} ms`)
    expect(await adoptNow(w)).toBeNull()
  }, 120_000)
})
