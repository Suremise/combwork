// HI-2598 (design HI-2598/s9): the names upgrade's maps for stored values (src/main/storedNames.ts), as each step uses
// them. Each changes only what is old (null or the value itself when nothing is), so a step run again changes nothing.
import { describe, expect, it } from 'vitest'
import { namesOldProtocol, optionValue, renamedNote, ruleId, upgradedAdvancedId, upgradedAdvancedIds, upgradedOptions, upgradedOwnText, upgradedRunName, upgradedToolName } from '../src/main/storedNames'
import { ADVANCED_DEFS } from '../src/shared/advanced'

// old-name: begin storedNames-inputs
/** 1.0's name, as its stored values, tool names and texts carry it: the upgrade's input. */
const OLD = 'hive'
const OLD_NAME = 'Hive'
// old-name: end storedNames-inputs
const NOTE = '(Combwork has renamed the tools and commands agents use since this was written: its tools are cw_<tool> (mcp__combwork__cw_<tool> in full), and its progress command is cw-progress.)'

describe("the stored values' maps", () => {
  it('workflow options and rule ids', () => {
    expect(optionValue.finish(`${OLD}Merges`)).toBe('combworkMerges')
    expect(optionValue.finish('agentMerges')).toBe('agentMerges')
    expect(optionValue.commitMessage(OLD)).toBe('combwork')
    expect(optionValue.commitMessage('branch')).toBe('branch')
    expect(upgradedOptions({ finish: `${OLD}Merges`, commitMessage: OLD, review: 'agent' })).toEqual({ finish: 'combworkMerges', commitMessage: 'combwork', review: 'agent' })
    expect(upgradedOptions({ finish: 'combworkMerges', commitMessage: 'branch' })).toBeNull()
    expect(upgradedOptions(null)).toBeNull()
    expect(ruleId(`merge.${OLD}Merges`)).toBe('merge.combworkMerges')
    expect(ruleId('move.notFromHere')).toBe('move.notFromHere')
  })

  it("Combwork's run names and tool names", () => {
    expect(upgradedRunName(`${OLD_NAME} (merge queue)`)).toBe('Combwork (merge queue)')
    expect(upgradedRunName(`${OLD_NAME} (slot slot-b)`)).toBe('Combwork (slot slot-b)')
    expect(upgradedRunName('Combwork (copy copy-1)')).toBe('Combwork (copy copy-1)')
    expect(upgradedRunName(`${OLD_NAME} helper`)).toBe(`${OLD_NAME} helper`)
    expect(upgradedToolName(`${OLD}_inbox`)).toBe('cw_inbox')
    expect(upgradedToolName(`${OLD}_wait_for_tasks`)).toBe('cw_wait_for_tasks')
    expect(upgradedToolName('cw_inbox')).toBe('cw_inbox')
    expect(upgradedToolName(`${OLD}_private_secret`)).toBe(`${OLD}_private_secret`)
    expect(upgradedToolName(`${OLD}_`)).toBe(`${OLD}_`)
  })

  it("Combwork's own text keeps every word: 1.0's leading tag made [CW], the note once where it names old names outside its quotes", () => {
    expect(renamedNote()).toBe(NOTE)
    const old = `[${OLD_NAME}] HI-4 is in Review: call ${OLD}_inbox, then ${OLD}_wait_for_tasks (mcp__${OLD}__${OLD}_wait_for_tasks); ${OLD}-progress shows runs.`
    const now = upgradedOwnText(old)!
    expect(now).toBe(`[CW] ${old.slice(OLD_NAME.length + 3)} ${NOTE}`)
    expect(upgradedOwnText(now)).toBeNull()
    // What it quotes is never rewritten, a person's words about the old names included.
    const relayed = `The user answered: <<<Keep ${OLD}-progress and ${OLD}_inbox unchanged in the archived example.>>>`
    expect(upgradedOwnText(relayed)).toBeNull()
    expect(upgradedOwnText(`${relayed} Read it with ${OLD}_read_task.`)).toBe(`${relayed} Read it with ${OLD}_read_task. ${NOTE}`)
    expect(upgradedOwnText(`The comment: "use ${OLD}_submit" and “${OLD}-progress”.`)).toBeNull()
    const plain = `Quoted: "[${OLD_NAME}] x" in ${OLD}_secret_notes, archive_${OLD}, ${OLD}-progressive, my${OLD}_inbox.`
    expect(upgradedOwnText(plain)).toBeNull()
    expect(namesOldProtocol(plain)).toBe(false)
    expect(upgradedOwnText('[CW] call cw_inbox.')).toBeNull()
    expect(upgradedOwnText(`[${OLD_NAME}] Mode: plan.`)).toBe('[CW] Mode: plan.')
  })

  it("the note names only today's names (HI-2611)", () => {
    for (const old of [`${OLD}_`, `mcp__${OLD}__`, `${OLD}-progress`]) expect(NOTE).not.toContain(old)
  })

  it("advanced ids: Combwork's own 1.0 ids and the CLIs' pre-approve switch take their new ids, the new one winning by presence", () => {
    const own = ADVANCED_DEFS.filter((d) => d.group === 'cw')
    expect(own.length).toBeGreaterThan(0)
    for (const d of own) expect(upgradedAdvancedId(`${OLD}.${d.id.slice(3)}`)).toBe(d.id)
    expect(upgradedAdvancedId(`${OLD}.assistant.otherMcpServers`)).toBe('cw.assistant.otherMcpServers')
    expect(upgradedAdvancedId(`${OLD}.agents.perProject`)).toBe('cw.agents.perProject')
    expect(upgradedAdvancedId(`codex.override.preApprove${OLD_NAME}Tools`)).toBe('codex.override.preApproveCombworkTools')
    expect(upgradedAdvancedId(`${OLD}.nope`)).toBe(`${OLD}.nope`)
    expect(upgradedAdvancedIds({ [`${OLD}.mcp.replySeconds`]: 600, 'claude-code.trust.prompt': 'x', [`${OLD}.nope`]: 1 })).toEqual({ record: { 'cw.mcp.replySeconds': 600, 'claude-code.trust.prompt': 'x', [`${OLD}.nope`]: 1 }, renamed: [`${OLD}.mcp.replySeconds`] })
    expect(upgradedAdvancedIds({ [`${OLD}.restart.resumeAfterUpdate`]: true, 'cw.restart.resumeAfterUpdate': false }).record).toEqual({ 'cw.restart.resumeAfterUpdate': false })
    expect(upgradedAdvancedIds({ 'cw.progress.lanesShown': 0, [`${OLD}.progress.lanesShown`]: 6 }).record).toEqual({ 'cw.progress.lanesShown': 0 })
    const same = { 'cw.mcp.replySeconds': 1 }
    expect(upgradedAdvancedIds(same)).toEqual({ record: same, renamed: [] })
  })
})
