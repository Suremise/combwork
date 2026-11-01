// Agents' workflow roles (#1430, SPEC §16.10.6): an agent's own role, else the guess from its note or name (HR1 and
// HI-R2 read as reviewers, as do notes and names saying review; anything else as a builder), either-role agents both
// building and reviewing, and the readers that use it: the preset step's suggestion, the upgrade's reviewer option
// (adoption) and the short project listing. Nothing is written for an agent whose role is a guess.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { as09 } from './boardDb'

const base = tempDir('hive-workflowroles-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const store = await import('../src/main/boardStore')
const { adoptNow } = await import('../src/main/workflow/adoption')
const { cleanWorkflowRole } = await import('../src/main/projectAgents')
const { agentWorkflowRole, buildsWork, reviewsWork, takesCards, isWorkflowRole, workflowPairs: pairsOf, WORKFLOW_ROLES } = await import('../src/shared/workflow/roles')
const { suggestPreset } = await import('../src/shared/workflow/presetStep')
const { projectRowText } = await import('../src/shared/toolReplies')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

describe('agentWorkflowRole (#1430)', () => {
  it('the field when set, whatever the name or note says', () => {
    expect(agentWorkflowRole({ name: 'HR1', workflowRole: 'builder' })).toBe('builder')
    expect(agentWorkflowRole({ name: 'Agent 1', role: 'builder', workflowRole: 'reviewer' })).toBe('reviewer')
    expect(agentWorkflowRole({ name: 'HB1', workflowRole: 'either' })).toBe('either')
  })

  it('unset: a note saying review is a reviewer, any other note a builder', () => {
    expect(agentWorkflowRole({ name: 'Agent 2', role: 'code reviewer' })).toBe('reviewer')
    expect(agentWorkflowRole({ name: 'Agent 2', role: 'Review' })).toBe('reviewer')
    // A note wins over the name, as before 1.0.
    expect(agentWorkflowRole({ name: 'HR1', role: 'docs' })).toBe('builder')
  })

  it("unset, no note: a name saying review, or shaped like HR1 or HI-R2, is a reviewer; HB1, Agent 1 and Solo's one agent are builders", () => {
    for (const name of ['Reviewer', 'R1 (reviewer)', 'HR1', 'HR6', 'HI-R2', 'AM-R12', 'r3']) expect(agentWorkflowRole({ name }), name).toBe('reviewer')
    for (const name of ['HB1', 'HI-B1', 'Agent 1', 'Builder', 'Claude', 'R2D2', 'HRX1']) expect(agentWorkflowRole({ name }), name).toBe('builder')
  })

  it('{key}-R{n} reads as a reviewer for every project key length (2–4 letters), and nothing longer or shorter', () => {
    for (const name of ['AB-R1', 'ABC-R2', 'ABCD-R1', 'abcd-r12', 'HIVR1']) expect(agentWorkflowRole({ name }), name).toBe('reviewer')
    for (const name of ['ABCDE-R1', 'A-R1', 'ABCDR1', 'ABCD-B1', 'ABCD-R', '-R1']) expect(agentWorkflowRole({ name }), name).toBe('builder')
  })

  it('an unknown stored value reads as the guess', () => {
    expect(agentWorkflowRole({ name: 'HR1', workflowRole: 'boss' as never })).toBe('reviewer')
    expect(isWorkflowRole('boss')).toBe(false)
  })

  it('buildsWork and reviewsWork: either does both, a generalist neither (HI-686); takesCards: any but a reviewer', () => {
    expect([buildsWork('builder'), buildsWork('reviewer'), buildsWork('either'), buildsWork('generalist')]).toEqual([true, false, true, false])
    expect([reviewsWork('builder'), reviewsWork('reviewer'), reviewsWork('either'), reviewsWork('generalist')]).toEqual([false, true, true, false])
    expect([takesCards('builder'), takesCards('reviewer'), takesCards('either'), takesCards('generalist')]).toEqual([true, false, true, true])
  })

  it('a role as saved: builder, reviewer, either or generalist, else refused', () => {
    expect(cleanWorkflowRole('either')).toBe('either')
    expect(cleanWorkflowRole('generalist')).toBe('generalist')
    expect(agentWorkflowRole({ name: 'HR1', workflowRole: 'generalist' })).toBe('generalist')
    expect(WORKFLOW_ROLES).toEqual(['builder', 'reviewer', 'either', 'generalist'])
    expect(() => cleanWorkflowRole('Reviewer')).toThrow(/builder, reviewer, either or generalist/)
    expect(() => cleanWorkflowRole('')).toThrow(/builder, reviewer, either or generalist/)
  })

  it('a generalist is never a builder of a pair by name, nor its reviewer (HI-686)', () => {
    expect(pairsOf([{ name: 'HB1', workflowRole: 'generalist' }, { name: 'HR1' }], [])).toEqual([])
    expect(pairsOf([{ name: 'HB1' }, { name: 'HR1', workflowRole: 'generalist' }], [])).toEqual([])
  })
})

describe('its readers (#1430)', () => {
  it("the preset step's suggestion counts reviewers by role: HB1 and HR1 are a Pair; two builders a Team", () => {
    expect(suggestPreset([{ name: 'HB1' }, { name: 'HR1' }])).toBe('pair')
    expect(suggestPreset([{ name: 'B1' }, { name: 'B2', workflowRole: 'reviewer' }])).toBe('pair')
    expect(suggestPreset([{ name: 'B1' }, { name: 'Reviewer', workflowRole: 'builder' }])).toBe('team')
  })

  it("the short project listing gives each agent's role", () => {
    const row = { name: 'p', workspace: 'w', active: true, branch: 'main', agents: [{ name: 'HB1', provider: 'claude-code', workflowRole: 'builder', status: 'stopped', branch: null, backgroundTasks: 0 }] }
    expect(projectRowText(row, false)).toBe('p (on, main): HB1 [claude-code, builder] stopped')
  })

  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
  let n = 0
  /** A 0.9 workspace (no platform recorded, an empty 0.9 board) whose project `p` has these agents; upgraded and adopted. */
  async function upgraded(agents: { id: string; name: string; role?: string }[]): Promise<Record<string, any>> {
    const ws = join(base, `ws-${++n}`)
    const repo = join(ws, 'p')
    mkdirSync(join(repo, '.hive'), { recursive: true })
    mkdirSync(join(ws, '.hive'), { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents }))
    const w0 = createWorkspaceService()
    await w0.open(ws)
    await store.boardWrite(w0, async () => undefined)
    await disposeWorkspaceService(w0)
    store.closeBoard(ws)
    as09(store.boardFile(ws))
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    await inWorkspace(w, () => store.upgradeBoard(w))
    expect(await adoptNow(w)).toMatchObject({ configured: 1, failed: 0 })
    return JSON.parse(readFileSync(join(repo, '.hive', 'project.json'), 'utf8'))
  }

  it('the upgrade reads HR-named agents as reviewers (a reviewer agent reviews), and writes no role on any agent', async () => {
    const cfg = await upgraded([{ id: 'b1', name: 'HB1' }, { id: 'r1', name: 'HR1' }])
    expect(cfg.workflow).toMatchObject({ options: { review: 'agent' } })
    expect(cfg.agents.map((a: Record<string, unknown>) => a.workflowRole)).toEqual([undefined, undefined])
  })

  it('with builders only, the upgrade asks no reviewer agent', async () => {
    const cfg = await upgraded([{ id: 'b1', name: 'HB1' }, { id: 'b2', name: 'HB2' }])
    expect(cfg.workflow.options.review).not.toBe('agent')
  })
})

// #1531 (#1346 item 2): hive_project_status's pairs, so the Assistant doesn't guess which agent reviews whose work.
describe('builder and reviewer pairs', async () => {
  const { workflowPairs } = await import('../src/shared/workflow/roles')
  const lane = (id: string, builder: string, reviewer: string | null, state = 'active', pool = false) => ({ id, state, builder: { name: builder }, reviewer: reviewer ? { name: reviewer } : null, ...(pool ? { pool } : {}) })
  it("each running lane's pair first, then a builder and reviewer by their names' number, only where it is one reviewer", () => {
    const agents = [{ name: 'HB1' }, { name: 'HR1' }, { name: 'HB2' }, { name: 'HR2' }, { name: 'HB3' }, { name: 'HB4' }, { name: 'Pool R4', workflowRole: 'reviewer' as const }, { name: 'HR4' }, { name: 'Writer' }]
    expect(workflowPairs(agents, [lane('lane-a', 'HB1', 'HR2'), lane('lane-b', 'HB3', null, 'paused', true), lane('lane-c', 'HB2', 'HR1', 'ended')])).toEqual([
      { builder: 'HB1', reviewer: 'HR2', lane: 'lane-a' },
      { builder: 'HB3', reviewer: null, pool: true, lane: 'lane-b' }
    ])
    // Not in a running lane: HB2 has no reviewer by number (HR2 is in a lane); HB4 has two (Pool R4, HR4): no guess.
    expect(workflowPairs(agents.slice(0, 4), [])).toEqual([
      { builder: 'HB1', reviewer: 'HR1', byName: true },
      { builder: 'HB2', reviewer: 'HR2', byName: true }
    ])
    expect(workflowPairs(agents, [lane('lane-a', 'HB1', 'HR2')]).filter((x) => x.byName)).toEqual([])
    expect(workflowPairs([{ name: 'Solo' }], [])).toEqual([])
  })

  it("a running lane's pair carries its state as hive_lane list says it, the card it is on (HI-2271); pairs by name carry none", async () => {
    const { laneStateText, laneLine } = await import('../src/shared/lanes')
    const card = (number: number, column: string, more: object = {}) => ({ number, title: `Card ${number}`, column, blocked: null, round: 1, reviewing: false, ...more })
    const info = (id: string, builder: string, reviewer: string, state: string, current: number | null, cards: object[], more: object = {}) => ({ id, project: 'alpha', name: null, builder: { id: builder, name: builder }, reviewer: { id: reviewer, name: reviewer }, cards, current, state, pausedOn: null, rounds: 10, waitMinutes: 360, status: null, ...more }) as never
    const running = info('lane-a', 'HB1', 'HR1', 'active', 2, [card(1, 'done'), card(2, 'review'), card(3, 'todo')])
    const paused = info('lane-b', 'HB2', 'HR2', 'paused', 4, [card(4, 'doing', { blocked: 'Waits for the API key' })], { pausedOn: 4 })
    const pairs = workflowPairs([{ name: 'HB1' }, { name: 'HR1' }, { name: 'HB2' }, { name: 'HR2' }, { name: 'HB3' }, { name: 'HR3' }], [running, paused], laneStateText)
    expect(pairs).toEqual([
      { builder: 'HB1', reviewer: 'HR1', lane: 'lane-a', state: 'active, on #2' },
      { builder: 'HB2', reviewer: 'HR2', lane: 'lane-b', state: 'paused, #4 is blocked' },
      { builder: 'HB3', reviewer: 'HR3', byName: true }
    ])
    // The same words as the lane's own line.
    for (const [p, l] of [[pairs[0], running], [pairs[1], paused]] as const) expect(laneLine(l)).toContain(`: ${p.state}; `)
  })
})
