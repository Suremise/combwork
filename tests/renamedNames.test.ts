// HI-2463: what agents see is Combwork's (cw_* tools, the combwork server, [CW] lines, cw-progress), and what Combwork
// wrote before under Hive's names is read with the current ones: its own pending lines and stored tool names only, never
// anyone's words, and no unknown hive_ name made up into a tool.
import { describe, expect, it } from 'vitest'
import { currentToolName, HIVE_TOOLS, isReservedServerName, LEGACY_TOOLS_SERVER, TOOLS_SERVER } from '../src/shared/assistantTools'
import { currentProtocolText, DOORBELL_PREFIX, isDoorbell, LEGACY_NOTICE_PREFIX, NOTICE_PREFIX } from '../src/shared/doorbell'

describe('the renamed names (HI-2463)', () => {
  it('every tool is cw_, under the combwork server, and hive stays reserved', () => {
    expect(TOOLS_SERVER).toBe('combwork')
    expect(LEGACY_TOOLS_SERVER).toBe('hive')
    expect(HIVE_TOOLS.every((t) => /^cw_[a-z_]+$/.test(t))).toBe(true)
    for (const name of ['combwork', 'hive', ' Hive ', 'COMBWORK']) expect(isReservedServerName(name), name).toBe(true)
    for (const name of ['hive2', 'cw', 'combwork-tools', '']) expect(isReservedServerName(name), name).toBe(false)
  })

  it("a stored tool name is read as its current one; a name that was never a tool stays as it was", () => {
    expect(currentToolName('hive_inbox')).toBe('cw_inbox')
    expect(currentToolName('hive_wait_for_tasks')).toBe('cw_wait_for_tasks')
    expect(currentToolName('cw_inbox')).toBe('cw_inbox')
    expect(currentToolName('hive_private_secret')).toBe('hive_private_secret')
    expect(currentToolName('hive_')).toBe('hive_')
    expect(currentToolName('other_inbox')).toBe('other_inbox')
  })

  it("Combwork's own old line is said with the current prefix, tools and cw-progress", () => {
    expect(NOTICE_PREFIX).toBe('[CW] ')
    expect(LEGACY_NOTICE_PREFIX).toBe('[Hive] ')
    expect(currentProtocolText('[Hive] HI-4 is in Review: call hive_inbox, then hive_wait_for_tasks (mcp__hive__hive_wait_for_tasks); hive-progress shows runs.')).toBe(
      '[CW] HI-4 is in Review: call cw_inbox, then cw_wait_for_tasks (mcp__combwork__cw_wait_for_tasks); cw-progress shows runs.'
    )
    // Only a leading prefix is Combwork's; one quoted further on, an unknown hive_ name and words containing hive stay.
    expect(currentProtocolText('Quoted: "[Hive] x" in hive_secret_notes, archive_hive, hive-progressive, myhive_inbox.')).toBe('Quoted: "[Hive] x" in hive_secret_notes, archive_hive, hive-progressive, myhive_inbox.')
    // Already current: unchanged.
    expect(currentProtocolText('[CW] call cw_inbox.')).toBe('[CW] call cw_inbox.')
  })

  it('the doorbell is known by its current opening, never the old one', () => {
    expect(DOORBELL_PREFIX).toBe('[CW] New in your inbox: ')
    expect(isDoorbell('[CW] New in your inbox: 1 message (m1). Call cw_inbox to read it.')).toBe(true)
    expect(isDoorbell('[Hive] New in your inbox: 1 message (m1). Call hive_inbox to read it.')).toBe(false)
  })
})
