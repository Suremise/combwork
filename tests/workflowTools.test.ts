// The Combwork tools a project's workflow makes unusable (HI-2694, Darren 7 Nov: launch-only): each hidden only where its
// handler refuses every operation (HR1's s15 check), by preset; kept while any card in flight or running lane still works
// under rules that use it, or sits in a stage that takes it; a session launched without a tool is given no work needing it
// until it has relaunched; and the project's list read from the board, kept until anything it is made of changes.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { BUILDER_ONLY_TOOLS, CW_TOOLS, REVIEWER_ONLY_TOOLS, WORKFLOW_TOOL_STAGES, WORKFLOW_TOOLS, hiddenForWorkflow, workflowAllows, workflowHiddenOf } from '../src/shared/assistantTools'
import { allOff, preset, type PresetId, type WorkflowOptions } from '../src/shared/workflow/options'
import { compile, mustCompile } from '../src/shared/workflow/compile'

const base = tempDir('cw-workflow-tools-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { workRetained } = await import('../src/main/workflow/cardWork')
const { workflowHiddenNow, forgetWorkflowHidden } = await import('../src/main/workflowTools')
const { advanced } = await import('../src/main/advanced')
const { WORKFLOW_ENFORCE } = await import('../src/shared/advanced')

const checks = { quick: ['typecheck'], tests: ['test'], commands: { typecheck: 'npm run typecheck', test: 'npm test' } }
const presetOf = (id: PresetId, platform: 'git' | 'none' = 'git'): WorkflowOptions => preset(platform, id, checks)
const hidden = (...sets: WorkflowOptions[]): string[] => hiddenForWorkflow(sets)
const REVIEW = ['cw_start_review', 'cw_verdict']

describe('tools by workflow (HI-2694): which are hidden', () => {
  it("are Combwork's tools, a side's each (so a side's guard covers them), and their stages real ones", () => {
    for (const t of Object.keys(WORKFLOW_TOOLS)) {
      expect(CW_TOOLS, t).toContain(t)
      expect([...BUILDER_ONLY_TOOLS, ...REVIEWER_ONLY_TOOLS], t).toContain(t)
    }
    for (const t of Object.keys(WORKFLOW_TOOL_STAGES)) expect(Object.keys(WORKFLOW_TOOLS)).toContain(t)
  })

  it('Solo (Git): no review, Committed is done: the review tools, the focused-test skip and the merge report', () => {
    expect(hidden(presetOf('solo'))).toEqual(['cw_focused_skip', 'cw_report_merge', 'cw_start_review', 'cw_verdict'])
  })

  it('Pair and Team (a reviewer agent, Combwork merges): only what their focused tests leave unused', () => {
    for (const id of ['pair', 'team', 'pairAgent'] as const) {
      const o = presetOf(id)
      const h = hidden(o)
      expect(h.filter((t) => REVIEW.includes(t)), id).toEqual([])
      expect(h.includes('cw_focused_skip'), id).toBe(!(o.focusedTests && o.finish === 'combworkMerges'))
      expect(h.includes('cw_report_merge'), id).toBe(!['combworkMerges', 'agentMerges'].includes(o.finish) && !(o.finish === 'notChecked' && o.review !== 'none'))
    }
  })

  it('Custom: review by you keeps the review tools (an agent may still review), the agent merging keeps the report', () => {
    const solo = presetOf('solo')
    expect(hidden({ ...solo, review: 'you' })).not.toContain('cw_verdict')
    expect(hidden({ ...solo, finish: 'agentMerges', folder: 'slots' })).not.toContain('cw_report_merge')
    // Not checked reports a merge only from Approved: a review or your OK before merging gives one.
    expect(hidden({ ...solo, finish: 'notChecked', folder: 'slots' })).toContain('cw_report_merge')
    expect(hidden({ ...solo, finish: 'notChecked', folder: 'slots', okBefore: { mode: 'every', labels: [] } })).not.toContain('cw_report_merge')
    const focused = { ...presetOf('pair'), focusedTests: true, finish: 'combworkMerges' as const }
    expect(hidden(focused)).not.toContain('cw_focused_skip')
    expect(hidden({ ...focused, focusedTests: false })).toContain('cw_focused_skip')
  })

  it("None: no merge, so no merge report; its Solo hides the review tools, and All off hides what Solo does", () => {
    expect(hidden(presetOf('solo', 'none'))).toEqual(['cw_focused_skip', 'cw_report_merge', 'cw_start_review', 'cw_verdict'])
    expect(hidden(presetOf('pair', 'none'))).not.toContain('cw_verdict')
    expect(hidden(allOff('git'))).toEqual(hidden(allOff('none')))
  })

  it('never hides a tool one of whose operations works under any options', () => {
    const never = ['cw_queue', 'cw_loop_step', 'cw_request_builder', 'cw_declare_paths', 'cw_merge_slot', 'cw_lane', 'cw_start_card', 'cw_submit', 'cw_put_back', 'cw_cannot_within_rules']
    for (const o of [allOff('git'), allOff('none'), presetOf('solo'), presetOf('solo', 'none')]) expect(hidden(o).filter((t) => never.includes(t))).toEqual([])
  })

  it('a tool is kept while any set of rules still in force uses it (work in flight under Pair while the project is Solo)', () => {
    expect(hidden(presetOf('solo'), presetOf('pair'))).toEqual(hidden(presetOf('pair')))
    // A card sitting in Review or Approved (left there with the rules off, moved there past them) keeps what takes it.
    expect(hiddenForWorkflow([presetOf('solo')], ['review'])).not.toContain('cw_verdict')
    expect(hiddenForWorkflow([presetOf('solo')], ['approved'])).not.toContain('cw_report_merge')
    expect(hiddenForWorkflow([presetOf('solo')], ['active'])).toEqual(hidden(presetOf('solo')))
    // Nothing known: nothing hidden.
    expect(hiddenForWorkflow([])).toEqual([])
  })

  it('a launch is read back from its env', () => {
    expect([workflowHiddenOf(undefined), workflowHiddenOf(''), workflowHiddenOf('cw_verdict,cw_start_review')]).toEqual([[], [], ['cw_verdict', 'cw_start_review']])
  })
})

describe("a running launch lacking a part's tool gets no such work until it relaunches (HR1's s11 point 2)", () => {
  const solo = ['cw_focused_skip', 'cw_report_merge', 'cw_start_review', 'cw_verdict']
  it('launched under Solo, the project now Pair: no reviewer part, and no builder part when its merge report came back', () => {
    const pairNow = hidden(presetOf('pair'))
    expect(workflowAllows(solo, pairNow, 'reviewer')).toBe(false)
    expect(workflowAllows(solo, pairNow, 'builder')).toBe(pairNow.includes('cw_report_merge'))
  })
  it('a launch that lacks only what the project still hides does both parts', () => {
    expect(workflowAllows(solo, solo, 'reviewer')).toBe(true)
    expect(workflowAllows(solo, solo, 'builder')).toBe(true)
    expect(workflowAllows([], [], 'reviewer')).toBe(true)
  })
  it("what the project allows now unreadable: a launch lacking any of the part's tools waits", () => {
    expect(workflowAllows(['cw_verdict'], null, 'reviewer')).toBe(false)
    expect(workflowAllows(['cw_verdict'], null, 'builder')).toBe(true)
    expect(workflowAllows([], null, 'reviewer')).toBe(true)
  })
})

// --- The project's list, read from the board.

const user = { kind: 'user' } as const
let n = 0
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

/** A workspace with project p, on None (no Git needed), its options `options`. */
async function workspace(options: Partial<WorkflowOptions>): Promise<WS> {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'p', '.combwork'), { recursive: true })
  writeFileSync(join(ws, 'p', '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [{ id: 'a1', name: 'Agent 1' }], workflow: { platform: 'none', options } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}
const projectPath = (w: WS): string => join(w.path!, 'p')

/** A card of p started under `rules`, in `stage`, in one board change. */
async function cardUnder(w: WS, rules: WorkflowOptions, stage: 'active' | 'review' | 'done'): Promise<number> {
  const card = (await inWorkspace(w, () => tasks.createTask({ title: `Under ${rules.review}`, project: 'p' }, user))).number
  const r = mustCompile(rules)
  const facts = FactStore.forBoard(w, { project: 'p', key: 'P' })
  await store.boardWrite(w, async () =>
    facts.tx((tx) => {
      tx.saveRuleset(r)
      tx.append(card, { kind: 'Started', actor: 'agent:a1', source: 'recorded', ruleset: r.id, data: { folder: 'project', line: '', base: '', target: '', builder: 'a1', cardKind: 'code' } } as never)
      tx.setStage(card, stage)
    })
  )
  return card
}

describe("a project's list from its options and its work in flight (HR1's s11 points 1 and 4)", () => {
  const soloNone = presetOf('solo', 'none')
  const pairNone = presetOf('pair', 'none')

  it('Solo with nothing in flight hides the review tools; a card started under Pair and still in Doing keeps them', async () => {
    const w = await workspace(soloNone)
    forgetWorkflowHidden()
    expect(w.info()?.projects[0].platform?.id).toBe('none')
    expect(workflowHiddenNow(w, projectPath(w))).toEqual(hidden(soloNone))
    const card = await cardUnder(w, pairNone, 'active')
    expect(workRetained(w, 'p')).toMatchObject({ stages: ['active'] })
    expect(workflowHiddenNow(w, projectPath(w))).toEqual(hidden(soloNone, pairNone))
    // Done: its rules no longer count, read again at the next commit (the board's token moved).
    await store.boardWrite(w, async () => FactStore.forBoard(w, { project: 'p', key: 'P' }).tx((tx) => tx.setStage(card, 'done')))
    expect(workflowHiddenNow(w, projectPath(w))).toEqual(hidden(soloNone))
  })

  it('a card archived in flight no longer counts; one in Review keeps the review tools whatever its rules', async () => {
    const w = await workspace(soloNone)
    const card = await cardUnder(w, pairNone, 'active')
    expect(workflowHiddenNow(w, projectPath(w))).not.toContain('cw_verdict')
    await inWorkspace(w, () => tasks.archiveTask(card, true))
    expect(workflowHiddenNow(w, projectPath(w))).toContain('cw_verdict')
    await cardUnder(w, soloNone, 'review')
    expect(workflowHiddenNow(w, projectPath(w))).not.toContain('cw_verdict')
  })

  it('kept until its options change: a config given with other options reads afresh', async () => {
    const w = await workspace(soloNone)
    expect(workflowHiddenNow(w, projectPath(w))).toContain('cw_verdict')
    expect(workflowHiddenNow(w, projectPath(w), { workflow: { platform: 'none', options: pairNone } } as never)).not.toContain('cw_verdict')
    expect(workflowHiddenNow(w, projectPath(w))).toContain('cw_verdict')
  })

  it('nothing hidden with the rules not enforced, or with options that do not compile', async () => {
    const w = await workspace(soloNone)
    const was = advanced.get<boolean>(WORKFLOW_ENFORCE)
    try {
      await advanced.set(WORKFLOW_ENFORCE, false)
      expect(workflowHiddenNow(w, projectPath(w))).toEqual([])
    } finally {
      await advanced.set(WORKFLOW_ENFORCE, was)
    }
    expect(workflowHiddenNow(w, projectPath(w))).not.toEqual([])
    expect(compile({ ...soloNone, folder: 'slots' }).ok).toBe(false)
  })

  it('a database closed and opened again is read afresh (its token moves)', async () => {
    const w = await workspace(soloNone)
    const before = store.boardReadToken(w)
    expect(workflowHiddenNow(w, projectPath(w))).toContain('cw_verdict')
    store.closeAllBoards()
    await cardUnder(w, pairNone, 'active')
    expect(store.boardReadToken(w)).not.toBe(before)
    expect(workflowHiddenNow(w, projectPath(w))).not.toContain('cw_verdict')
  })
})
