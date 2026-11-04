// HI-2463: what agents see is Combwork's (cw_* tools, the combwork server, [CW] lines, cw-progress), and what Combwork
// wrote before under Hive's names keeps its words (only a leading [Hive] becomes [CW], with a note on how the names
// map), stored tool names are read as the current ones, and no unknown hive_ name is made up into a tool.
import { describe, expect, it } from 'vitest'
import { currentToolName, HIVE_TOOLS, isReservedServerName, LEGACY_TOOLS_SERVER, TOOLS_SERVER } from '../src/shared/assistantTools'
import { DOORBELL_PREFIX, isDoorbell, LEGACY_NOTICE_PREFIX, namesOldProtocol, NOTICE_PREFIX, withCurrentNames } from '../src/shared/doorbell'

const NOTE = '(Combwork has renamed what agents use: a hive_<tool> named here is now cw_<tool>, mcp__hive__ is mcp__combwork__, and hive-progress is cw-progress.)'

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

  it("Combwork's own line keeps every word: an old leading prefix made current, a note where it names old names outside its quotes", () => {
    expect(NOTICE_PREFIX).toBe('[CW] ')
    expect(LEGACY_NOTICE_PREFIX).toBe('[Hive] ')
    const old = '[Hive] HI-4 is in Review: call hive_inbox, then hive_wait_for_tasks (mcp__hive__hive_wait_for_tasks); hive-progress shows runs.'
    expect(withCurrentNames(old)).toBe(`[CW] ${old.slice(7)} ${NOTE}`)
    // HR1's round 1: what it quotes is never rewritten, a person's words about the old names included.
    const relayed = 'The user answered: <<<Keep hive-progress and hive_inbox unchanged in the archived example.>>>'
    expect(withCurrentNames(relayed)).toBe(relayed)
    // Named by Combwork itself outside the quote: noted.
    expect(withCurrentNames(`${relayed} Read it with hive_read_task.`)).toBe(`${relayed} Read it with hive_read_task. ${NOTE}`)
    expect(withCurrentNames('The comment: "use hive_submit" and “hive-progress”.')).toBe('The comment: "use hive_submit" and “hive-progress”.')
    // A quoted prefix, an unknown hive_ name and words containing hive are no old names: unchanged, no note.
    const plain = 'Quoted: "[Hive] x" in hive_secret_notes, archive_hive, hive-progressive, myhive_inbox.'
    expect(withCurrentNames(plain)).toBe(plain)
    expect(namesOldProtocol(plain)).toBe(false)
    // Already current: unchanged.
    expect(withCurrentNames('[CW] call cw_inbox.')).toBe('[CW] call cw_inbox.')
  })

  it('the doorbell is known by its current opening, never the old one', () => {
    expect(DOORBELL_PREFIX).toBe('[CW] New in your inbox: ')
    expect(isDoorbell('[CW] New in your inbox: 1 message (m1). Call cw_inbox to read it.')).toBe(true)
    expect(isDoorbell('[Hive] New in your inbox: 1 message (m1). Call hive_inbox to read it.')).toBe(false)
  })
})
