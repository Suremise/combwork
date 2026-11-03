// The Assistant's change boundary in a dialect (HI-2450): what a change is called is data, said in the Assistant's chain
// in the refusal it reads, and in the Default in the activity line Hive keeps (its panel, hive.log, the event stream).
// With no chain, both read exactly as before.
import { join } from 'path'
import { mkdirSync } from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { agentMsg, setChainResolver, type DialectChain } from '../src/shared/agentText'
import { inRequestScope } from '../src/shared/agentText/asyncScope'

const base = tempDir('hive-control-dialect-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { config } = await import('../src/main/config')
const control = await import('../src/main/assistantControl')

const WS = join(base, 'ws')
const ACT = { kind: 'create-task' } as const
const WHAT = agentMsg({ id: 'test.control.what', text: 'create a card in {project}' })
const what = [WHAT, { project: 'webapp' }] as const
const chain = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })
/** As the Assistant's request runs (servers.ts opens its scope): its session's chain applies. */
const asAssistant = <T>(fn: () => T): T => inRequestScope({ projectPath: WS, agentId: 'assistant' }, fn)
const setControl = (level: 'look' | 'agents' | 'projects'): void => {
  config.settings.assistant = { ...config.settings.assistant, control: level } as typeof config.settings.assistant
}
/** The refusal it reads, and the activity line kept for it. */
const refused = (fn: () => void): { error: string; kept: { text: string; error?: string; reason?: string } } => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(control.ChangeRefused)
    const last = control.actions(WS).at(-1)!
    return { error: (e as Error).message, kept: { text: last.text, error: last.error, reason: last.reason } }
  }
  throw new Error('not refused')
}

afterEach(() => {
  setChainResolver(null)
  setControl('projects')
})

const DEFAULT = {
  error: "The user's settings (Settings → Assistant → Control: Look and advise) don't let you create a card in webapp. Tell the user what you would do instead.",
  kept: { text: 'Create a card in webapp', error: 'not allowed by Settings → Assistant → Control', reason: 'Not allowed by Settings → Assistant → Control' }
}

describe("the change boundary's refusal", () => {
  it('reads as before with no chain', () => {
    setControl('look')
    expect(asAssistant(() => refused(() => control.refuseUnlessAllowed(WS, 'agents', what, ACT)))).toEqual(DEFAULT)
    expect(asAssistant(() => refused(() => control.admit(WS, 'token', 'agents', what, ACT)))).toEqual(DEFAULT)
  })

  it("is said in the Assistant's chain, while the activity line it keeps is the Default's", () => {
    setControl('look')
    setChainResolver(() =>
      chain({
        'test.control.what': 'add a card to {project}',
        'control.refused': 'Blocked at {level}: you may not {what}.',
        'control.level.look': 'look-only',
        'control.notAllowed': 'blocked',
        'control.notAllowedReason': 'Blocked'
      })
    )
    const r = asAssistant(() => refused(() => control.refuseUnlessAllowed(WS, 'agents', what, ACT)))
    expect(r.error).toBe('Blocked at look-only: you may not add a card to webapp.')
    expect(r.kept).toEqual(DEFAULT.kept)
    expect(asAssistant(() => refused(() => control.admit(WS, 'token', 'agents', what, ACT))).kept).toEqual(DEFAULT.kept)
  })

  it("the guard's refusals at the moment of the change are said in the Assistant's chain too", () => {
    setControl('projects')
    setChainResolver(() => chain({ 'control.turnedDown': 'Control was lowered.', 'control.sessionEnded': 'Your session ended.' }))
    const guard = asAssistant(() => control.admit(WS, 'not-the-token', 'agents', what, ACT))
    expect(() => asAssistant(guard)).toThrow('Your session ended.')
    setControl('look')
    expect(() => asAssistant(guard)).toThrow('Control was lowered.')
    setChainResolver(null)
    expect(() => asAssistant(guard)).toThrow('The user turned Settings → Assistant → Control down before this change was made: nothing changed here.')
  })

  it("names the control levels in the caller's chain", () => {
    expect((['look', 'agents', 'projects'] as const).map(control.levelName)).toEqual(['Look and advise', 'Control agents', 'Control agents and create projects'])
    setChainResolver(() => chain({ 'control.level.agents': 'Agents only' }))
    expect(asAssistant(() => control.levelName('agents'))).toBe('Agents only')
  })
})
