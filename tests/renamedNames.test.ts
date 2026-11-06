// HI-2463: what agents see is Combwork's (cw_* tools, the combwork server, [CW] lines, cw-progress). What Combwork stored
// before under its earlier names is converted once by the names upgrade (storedNames.test.ts, HI-2598).
import { describe, expect, it } from 'vitest'
import { CW_TOOLS, isReservedServerName, TOOLS_SERVER } from '../src/shared/assistantTools'
import { DOORBELL_PREFIX, isDoorbell } from '../src/shared/doorbell'


describe('the renamed names (HI-2463)', () => {
  it('every tool is cw_, under the combwork server, the only reserved name (any other is an ordinary one, HI-2594)', () => {
    expect(TOOLS_SERVER).toBe('combwork')
    expect(CW_TOOLS.every((t) => /^cw_[a-z_]+$/.test(t))).toBe(true)
    for (const name of ['combwork', ' Combwork ', 'COMBWORK']) expect(isReservedServerName(name), name).toBe(true)
    for (const name of ['demo', ' Demo ', 'demo2', 'cw', 'combwork-tools', '']) expect(isReservedServerName(name), name).toBe(false)
  })

  it('the doorbell is known by its current opening, never another', () => {
    expect(DOORBELL_PREFIX).toBe('[CW] New in your inbox: ')
    expect(isDoorbell('[CW] New in your inbox: 1 message (m1). Call cw_inbox to read it.')).toBe(true)
    expect(isDoorbell('[Demo] New in your inbox: 1 message (m1). Call demo_inbox to read it.')).toBe(false)
  })
})
