// HI-2598 (design HI-2598/s9): the names upgrade's maps for stored values (src/main/storedNames.ts), as each step uses
// them. Each changes only what is old (null or the value itself when nothing is), so a step run again changes nothing.
import { describe, expect, it } from 'vitest'
import { namesOldProtocol, optionValue, renamedNote, ruleId, upgradedAdvancedId, upgradedAdvancedIds, upgradedOptions, upgradedOwnText, upgradedRunName, upgradedToolName } from '../src/main/storedNames'
import { ADVANCED_DEFS } from '../src/shared/advanced'

const NOTE = '(Combwork has renamed the tools and commands agents use since this was written: its tools are cw_<tool> (mcp__combwork__cw_<tool> in full), and its progress command is cw-progress.)'

describe("the stored values' maps", () => {
  it('workflow options and rule ids', () => {
    expect(optionValue.finish('hiveMerges')).toBe('combworkMerges')
    expect(optionValue.finish('agentMerges')).toBe('agentMerges')
    expect(optionValue.commitMessage('hive')).toBe('combwork')
    expect(optionValue.commitMessage('branch')).toBe('branch')
    expect(upgradedOptions({ finish: 'hiveMerges', commitMessage: 'hive', review: 'agent' })).toEqual({ finish: 'combworkMerges', commitMessage: 'combwork', review: 'agent' })
    expect(upgradedOptions({ finish: 'combworkMerges', commitMessage: 'branch' })).toBeNull()
    expect(upgradedOptions(null)).toBeNull()
    expect(ruleId('merge.hiveMerges')).toBe('merge.combworkMerges')
    expect(ruleId('move.notFromHere')).toBe('move.notFromHere')
  })

  it("Combwork's run names and tool names", () => {
    expect(upgradedRunName('Hive (merge queue)')).toBe('Combwork (merge queue)')
    expect(upgradedRunName('Hive (slot slot-b)')).toBe('Combwork (slot slot-b)')
    expect(upgradedRunName('Combwork (copy copy-1)')).toBe('Combwork (copy copy-1)')
    expect(upgradedRunName('Hive helper')).toBe('Hive helper')
    expect(upgradedToolName('hive_inbox')).toBe('cw_inbox')
    expect(upgradedToolName('hive_wait_for_tasks')).toBe('cw_wait_for_tasks')
    expect(upgradedToolName('cw_inbox')).toBe('cw_inbox')
    expect(upgradedToolName('hive_private_secret')).toBe('hive_private_secret')
    expect(upgradedToolName('hive_')).toBe('hive_')
  })

  it("Combwork's own text keeps every word: a leading [Hive] made [CW], the note once where it names old names outside its quotes", () => {
    expect(renamedNote()).toBe(NOTE)
    const old = '[Hive] HI-4 is in Review: call hive_inbox, then hive_wait_for_tasks (mcp__hive__hive_wait_for_tasks); hive-progress shows runs.'
    const now = upgradedOwnText(old)!
    expect(now).toBe(`[CW] ${old.slice(7)} ${NOTE}`)
    expect(upgradedOwnText(now)).toBeNull()
    // What it quotes is never rewritten, a person's words about the old names included.
    const relayed = 'The user answered: <<<Keep hive-progress and hive_inbox unchanged in the archived example.>>>'
    expect(upgradedOwnText(relayed)).toBeNull()
    expect(upgradedOwnText(`${relayed} Read it with hive_read_task.`)).toBe(`${relayed} Read it with hive_read_task. ${NOTE}`)
    expect(upgradedOwnText('The comment: "use hive_submit" and “hive-progress”.')).toBeNull()
    const plain = 'Quoted: "[Hive] x" in hive_secret_notes, archive_hive, hive-progressive, myhive_inbox.'
    expect(upgradedOwnText(plain)).toBeNull()
    expect(namesOldProtocol(plain)).toBe(false)
    expect(upgradedOwnText('[CW] call cw_inbox.')).toBeNull()
    expect(upgradedOwnText('[Hive] Mode: plan.')).toBe('[CW] Mode: plan.')
  })

  it("the note names only today's names (HI-2611)", () => {
    for (const old of ['hive_', 'mcp__hive__', 'hive-progress']) expect(NOTE).not.toContain(old)
  })

  it("advanced ids: Combwork's own hive.* ids and the CLIs' pre-approve switch take their new ids, the new one winning by presence", () => {
    const own = ADVANCED_DEFS.filter((d) => d.group === 'cw')
    expect(own.length).toBeGreaterThan(0)
    for (const d of own) expect(upgradedAdvancedId(`hive.${d.id.slice(3)}`)).toBe(d.id)
    expect(upgradedAdvancedId('hive.assistant.otherMcpServers')).toBe('cw.assistant.otherMcpServers')
    expect(upgradedAdvancedId('hive.agents.perProject')).toBe('cw.agents.perProject')
    expect(upgradedAdvancedId('codex.override.preApproveHiveTools')).toBe('codex.override.preApproveCombworkTools')
    expect(upgradedAdvancedId('hive.nope')).toBe('hive.nope')
    expect(upgradedAdvancedIds({ 'hive.mcp.replySeconds': 600, 'claude-code.trust.prompt': 'x', 'hive.nope': 1 })).toEqual({ record: { 'cw.mcp.replySeconds': 600, 'claude-code.trust.prompt': 'x', 'hive.nope': 1 }, renamed: ['hive.mcp.replySeconds'] })
    expect(upgradedAdvancedIds({ 'hive.restart.resumeAfterUpdate': true, 'cw.restart.resumeAfterUpdate': false }).record).toEqual({ 'cw.restart.resumeAfterUpdate': false })
    expect(upgradedAdvancedIds({ 'cw.progress.lanesShown': 0, 'hive.progress.lanesShown': 6 }).record).toEqual({ 'cw.progress.lanesShown': 0 })
    const same = { 'cw.mcp.replySeconds': 1 }
    expect(upgradedAdvancedIds(same)).toEqual({ record: same, renamed: [] })
  })
})
