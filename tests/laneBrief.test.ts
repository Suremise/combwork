// The brief a lane started from the window gives its agents (#1280, SPEC §16.11.3): the cards in order, where the
// builder works, the reviewer, what the project's options require, how to move cards and report, and the user's note;
// every Combwork tool it names is one the Combwork MCP server has.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { laneBrief, laneRules, type LaneBriefInput } from '../src/shared/laneBrief'

const input = (over: Partial<LaneBriefInput> = {}): LaneBriefInput => ({
  project: 'alpha',
  cards: [
    { key: 'AL-1', title: 'Lane data' },
    { key: 'AL-2', title: 'Lane hover' }
  ],
  builder: { name: 'B1', folder: 'D:\\ws.worktrees\\alpha\\b1', branch: 'cw/b1' },
  reviewer: { name: 'R1' },
  options: { review: 'agent', preChecks: ['typecheck', 'lint'], finish: 'agentMerges', okBefore: { mode: 'labels', labels: ['ui'] }, target: 'main' },
  rounds: 10,
  note: '  Keep the API stable.  ',
  ...over
})

describe("a lane's brief on slots (#1438)", () => {
  it('names the slot the builder works in, a new branch per card', () => {
    const b = laneBrief(input({ builder: { name: 'B1', folder: null, branch: null, slot: 'slot-b' } }), 'builder')
    expect(b).toContain("B1 works in slot-b, a new branch per card (Combwork makes each card's branch there from the target and gives the card to B1 there); work goes to main.")
    expect(laneBrief(input({ builder: { name: 'B1', folder: null, branch: null, slot: 'slot-b' } }), 'reviewer')).toContain('B1 works in slot-b, a new branch per card')
  })
})

describe("a lane's brief on the reviewer pool (#1443)", () => {
  it("names the pool's reviewers and tells the builder to give cw_lane no reviewer", () => {
    const b = laneBrief(input({ reviewer: null, pool: ['HI-R1', 'HI-R2'] }), 'builder')
    expect(b).toContain('use the card-loop skill as the builder, reviewed by the pool (HI-R1 and HI-R2): Combwork gives each card you submit to a free reviewer of it, and its lane is registered already, so give cw_lane no reviewer; rounds: 10.')
    expect(laneBrief(input({ reviewer: null, pool: [] }), 'builder')).toContain('reviewed by the pool (nobody in it yet)')
  })
})

describe("a lane's brief (#1280)", () => {
  it("the builder's: card-loop as the builder with its reviewer, the cards in order, where it works, the rules, the intents, the note", () => {
    const b = laneBrief(input(), 'builder')
    expect(b).toContain('use the card-loop skill as the builder, with R1 as the reviewer; rounds: 10.')
    expect(b).toContain('1. AL-1 Lane data\n2. AL-2 Lane hover')
    expect(b).toContain('B1 works in D:\\ws.worktrees\\alpha\\b1 (branch cw/b1); work goes to main.')
    expect(b).toContain('- A reviewer agent reviews each card before it is merged.')
    expect(b).toContain('- Checks that pass before review: typecheck and lint. Run each as `cw-progress --check <name> --card "<key>"` before submitting.')
    expect(b).toContain('- The builder merges each approved card (merge-ready), then reports it with cw_report_merge; Combwork checks it is in.')
    expect(b).toContain("- Cards labelled ui wait for the user's OK before they are merged (Combwork asks them).")
    expect(b).toContain('cw_lane next')
    expect(b.endsWith("The user's note: Keep the API stable.")).toBe(true)
  })

  it("the reviewer's: card-loop as the reviewer of the builder's lane, reviewing by intent", () => {
    const r = laneBrief(input({ note: '' }), 'reviewer')
    expect(r).toContain("You are the reviewer of B1's lane in alpha that the user started: use the card-loop skill as the reviewer; rounds: 10.")
    expect(r).toContain('cw_start_review and cw_verdict')
    expect(r).not.toContain("The user's note")
  })

  it('no reviewer, the project folder, rules off', () => {
    const b = laneBrief(input({ reviewer: null, builder: { name: 'B1', folder: null, branch: null }, options: null }), 'builder')
    expect(b).toContain('with no reviewer')
    expect(b).toContain('B1 works in the project folder.')
    expect(b).toContain('- Workflow rules are off in this project: the cards move as you put them (cw_update_task).')
  })

  it("each option's line", () => {
    const o = input().options!
    expect(laneRules({ ...o, review: 'none', preChecks: [], finish: 'hiveMerges', okBefore: { mode: 'never', labels: [] } })).toEqual(['No review is needed.', 'Combwork merges each approved card.'])
    expect(laneRules({ ...o, review: 'agentThenYou', preChecks: ['unit'], finish: 'committed', okBefore: { mode: 'every', labels: [] } })).toEqual(['A reviewer agent reviews each card, then the user does, before it is merged.', 'Checks that pass before review: unit. Run each as `cw-progress --check <name> --card "<key>"` before submitting.', 'A card is done once its work is committed.', "Every card waits for the user's OK before it is merged (Combwork asks them)."])
    expect(laneRules({ ...o, review: 'you', finish: 'accept', preChecks: [], okBefore: { mode: 'labels', labels: [] } })).toEqual(['The user reviews each card before it is merged.', 'An approved card is accepted where it is (no merge).'])
  })

  it('every Combwork tool it names is one the Combwork MCP server has', () => {
    const server = readFileSync(join(__dirname, '..', 'src', 'main', 'mcp', 'hive-mcp.ts'), 'utf8')
    const text = ['builder', 'reviewer'].map((r) => laneBrief(input(), r as 'builder' | 'reviewer')).join('\n') + laneRules(null).join('\n')
    const named = [...new Set(text.match(/cw_[a-z_]+/g))]
    expect(named.length).toBeGreaterThan(5)
    for (const t of named) expect(server, t).toMatch(new RegExp(`['"]${t}['"]`))
  })
})
