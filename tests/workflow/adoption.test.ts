// The upgrade's adoption (#1218, SPEC §16.17, workflow/adoption.ts): each project gets options matching how it works,
// cards from before 1.0 are marked and get no facts, and cards in flight are adopted from what their folder shows. Run
// again, or by two at once, it adds nothing.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from '../tempDir'
import { writeCard } from '../boardDb'
import { commit, gitRepo, sh } from './harness'
import { allOff } from '../../src/shared/workflow/options'

const base = tempDir('hive-adoption-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../../src/main/workspace')
const store = await import('../../src/main/boardStore')
const { adoptNow, adoptWorkspace } = await import('../../src/main/workflow/adoption')
const { FactStore } = await import('../../src/main/workflow/factStore')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const at = new Date(Date.UTC(2026, 9, 1)).toISOString()
const card = (number: number, project: string, column: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ number, title: `Card ${number}`, description: '', project, agent: null, column, order: number, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: at, createdBy: 'You', updatedAt: at, ...more })

let n = 0
/**
 * A workspace with a Git project `p` (a builder B1 in a worktree off main, and a reviewer), a None project `n`, and
 * a card in each column; returns it and where B1's worktree is.
 */
async function world(): Promise<{ ws: string; w: WS; wt: string }> {
  const ws = join(base, `ws-${++n}`)
  const p = gitRepo(join(ws, 'p'))
  const wt = join(base, `wt-${n}`)
  sh(p, 'worktree', 'add', '-q', '-b', 'hive/b1', wt)
  commit(wt, { 'src/b.txt': 'b1\n' }, 'B1 builds')
  mkdirSync(join(p, '.hive'), { recursive: true })
  writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1', worktree: { path: wt, branch: 'hive/b1', base: 'main' } }, { id: 'r1', name: 'R1 (reviewer)' }] }))
  mkdirSync(join(ws, 'n', '.hive'), { recursive: true })
  writeFileSync(join(ws, 'n', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
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
  return { ws, w, wt }
}

const factsOf = (w: WS, project: string, num: number): { kind: string; data: Record<string, unknown>; source: string }[] => FactStore.forBoard(w, { project, key: project }).facts(num) as never
const marked = (w: WS): number[] => store.adoptionCards(w).filter((c) => c.preWorkflow).map((c) => c.number)
const allFacts = (w: WS): number => store.boardRead(w, (db) => (db.prepare('SELECT COUNT(*) AS n FROM card_facts').get() as { n: number }).n)
const config = (ws: string, project: string): Record<string, unknown> => JSON.parse(readFileSync(join(ws, project, '.hive', 'project.json'), 'utf8'))

describe("the upgrade's adoption (#1218)", () => {
  it('marks cards from before 1.0, adopts those in flight, and gives each project its options', async () => {
    const { ws, w, wt } = await world()
    const r = await adoptNow(w)
    expect(r).toEqual({ adopted: 4, marked: 6, configured: 2, failed: 0 })
    // Todo, Done, On Hold, archived, a workspace card and a removed project's: no facts, marked.
    expect(marked(w)).toEqual([1, 5, 6, 7, 9, 10])
    for (const c of [1, 5, 6, 7]) expect(factsOf(w, 'p', c)).toEqual([])
    // Doing: Adopted from B1's worktree, merging into main.
    const head = sh(wt, 'rev-parse', 'HEAD')
    const mainHead = sh(join(ws, 'p'), 'rev-parse', 'main')
    const doing = factsOf(w, 'p', 2)
    expect(doing.map((f) => f.kind)).toEqual(['Adopted'])
    expect(doing[0]).toMatchObject({ source: 'observed', data: { folder: wt, line: 'hive/b1', base: mainHead, target: 'main', builder: 'b1', adoptedFrom: 'doing' } })
    // Review: Adopted, and an adopted Submitted at its head with the change's files.
    const review = factsOf(w, 'p', 3)
    expect(review.map((f) => f.kind)).toEqual(['Adopted', 'Submitted'])
    expect(review[1].data).toMatchObject({ revision: head, base: mainHead, adopted: true, files: [expect.objectContaining({ path: 'src/b.txt' })] })
    // Passed: Adopted with passedBefore1_0 and no verdict.
    const passed = factsOf(w, 'p', 4)
    expect(passed.map((f) => f.kind)).toEqual(['Adopted'])
    expect(passed[0].data).toMatchObject({ adoptedFrom: 'passed', passedBefore1_0: true })
    // Each at the stage its column stands for (no Moved: a card's stage is its column's until a 1.0 rule moves it).
    const fs = FactStore.forBoard(w, { project: 'p', key: 'p' })
    expect([2, 3, 4].map((c) => fs.card(c).stage)).toEqual(['active', 'review', 'approved'])
    // None: adopted with nothing read (unknown, never a failure).
    expect(factsOf(w, 'n', 8)[0]).toMatchObject({ kind: 'Adopted', data: { folder: 'project', line: null, base: null, target: null, builder: 'a1' } })
    // Options as it works today: Git with a reviewer agent and worktrees; None with neither. The platform recorded too.
    expect(config(ws, 'p')).toMatchObject({ platform: 'git', workflow: { platform: 'git', preset: null, options: { review: 'agent', noSelfReview: true, folder: 'slots' } } })
    expect(config(ws, 'n')).toMatchObject({ platform: 'none', workflow: { platform: 'none', preset: null, options: { review: 'none', folder: 'project' } } })
    const rulesets = store.boardRead(w, (db) => (db.prepare('SELECT COUNT(*) AS n FROM rulesets').get() as { n: number }).n)
    expect(rulesets).toBe(2)
    // Nothing moved on the board.
    expect(store.adoptionCards(w).map((c) => c.column)).toEqual(['todo', 'doing', 'review', 'passed', 'done', 'onhold', 'doing', 'doing', 'doing', 'review'])
  })

  it('runs once: after it has finished, and run again even with its mark gone, it adds nothing', async () => {
    const { ws, w } = await world()
    await adoptNow(w)
    const facts = allFacts(w)
    const before = readFileSync(join(ws, 'p', '.hive', 'project.json'), 'utf8')
    expect(await adoptNow(w)).toBeNull()
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare("DELETE FROM board_meta WHERE key = 'adoption'").run()))
    expect(await adoptNow(w)).toEqual({ adopted: 0, marked: 0, configured: 0, failed: 0 })
    expect(allFacts(w)).toBe(facts)
    expect(readFileSync(join(ws, 'p', '.hive', 'project.json'), 'utf8')).toBe(before)
  })

  it('two at once (another Hive, a start during the upgrade) add each fact once', async () => {
    const { w } = await world()
    const [a, b] = await Promise.all([adoptNow(w), adoptNow(w)])
    expect(a!.adopted + b!.adopted).toBe(4)
    expect(a!.marked + b!.marked).toBe(6)
    expect(a!.configured + b!.configured).toBe(2)
    for (const c of [2, 3, 4]) expect(factsOf(w, 'p', c).filter((f) => f.kind === 'Adopted')).toHaveLength(1)
    expect(factsOf(w, 'p', 3).filter((f) => f.kind === 'Submitted')).toHaveLength(1)
    // And the coalesced run (what Hive starts) while another is going: one run.
    const facts = allFacts(w)
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare("DELETE FROM board_meta WHERE key = 'adoption'").run()))
    await Promise.all([adoptWorkspace(w), adoptWorkspace(w)])
    expect(allFacts(w)).toBe(facts)
    expect(store.boardValue(w, 'adoption')).not.toBeNull()
  })

  it('leaves a card started meanwhile, and options already set, as they are', async () => {
    const { ws, w } = await world()
    // Card 2 started under 1.0 by another Hive before this one adopts it: it has facts, so it isn't adopted.
    const other = FactStore.open(store.boardFile(ws), { project: 'p', key: 'p' })
    other.tx((tx) => tx.append(2, { kind: 'Moved', actor: 'user', source: 'recorded', data: { from: 'todo', to: 'active', cause: 'user' } }))
    other.close()
    const own = { platform: 'git', preset: null, options: { ...allOff('git'), review: 'none' } }
    const cfg = config(ws, 'p')
    writeFileSync(join(ws, 'p', '.hive', 'project.json'), JSON.stringify({ ...cfg, workflow: own }))
    const r = await adoptNow(w)
    expect(config(ws, 'p').workflow).toEqual(own)
    expect(r!.configured).toBe(1)
    expect(factsOf(w, 'p', 2).map((f) => f.kind)).toEqual(['Moved'])
    expect(marked(w)).not.toContain(2)
  })

})

// A copy of the live board (HIVE_STORE_ROUNDTRIP_DB, never the file in place): every card handled, none moved, once.
describe.runIf(!!process.env.HIVE_STORE_ROUNDTRIP_DB && existsSync(process.env.HIVE_STORE_ROUNDTRIP_DB))('on a copy of a live board (#1218)', () => {
  it('handles every card once and moves none', async () => {
    const ws = join(base, 'live')
    mkdirSync(join(ws, '.hive'), { recursive: true })
    copyFileSync(process.env.HIVE_STORE_ROUNDTRIP_DB!, join(ws, '.hive', 'hive.db'))
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    if (store.upgradeWaiting(ws)) await store.upgradeBoard(w)
    const before = store.adoptionCards(w)
    // Its projects as plain folders (None): their cards in flight are adopted with nothing read.
    for (const p of new Set(before.map((c) => c.project).filter((name) => name && /^[\w.-]+$/.test(name)))) {
      mkdirSync(join(ws, p, '.hive'), { recursive: true })
      writeFileSync(join(ws, p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    }
    const inFlight = before.filter((c) => !c.archived && ['doing', 'review', 'passed'].includes(c.column) && c.project && existsSync(join(ws, c.project))).length
    const t0 = performance.now()
    const r = await adoptNow(w)
    const ms = performance.now() - t0
    const after = store.adoptionCards(w)
    expect(r).not.toBeNull()
    expect(r!.failed).toBe(0)
    expect(r!.adopted).toBe(inFlight)
    expect(after.map((c) => [c.number, c.column])).toEqual(before.map((c) => [c.number, c.column]))
    // Every card is marked or has facts; none both.
    for (const c of after) expect(c.preWorkflow !== c.facts).toBe(true)
    console.log(`adoption of a live board copy: ${after.length} cards, ${r!.adopted} adopted, ${r!.marked} marked in ${ms.toFixed(0)} ms`)
    expect(await adoptNow(w)).toBeNull()
  }, 120_000)
})
