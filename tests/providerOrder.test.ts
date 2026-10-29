// The providers' order as Settings saves it (HI-1965): config.updateSettings takes a list of provider ids, each once,
// and refuses anything else with nothing changed; what Automatic picks follows the saved order.
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-provider-order-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { config } = await import('../src/main/config')
const { autoProvider, setInstalledCheck } = await import('../src/shared/providers')

describe("the providers' order in Settings (HI-1965)", () => {
  afterEach(() => {
    config.updateSettings({ providerOrder: [] })
    setInstalledCheck(() => false)
  })

  it('saves a list of provider ids, and Automatic follows it', () => {
    config.updateSettings({ providers: { 'claude-code': { enabled: true }, codex: { enabled: true } } as never })
    setInstalledCheck(() => true)
    expect(autoProvider(config.settings)).toBe('claude-code')
    config.updateSettings({ providerOrder: ['codex', 'claude-code', 'copilot'] })
    expect(config.settings.providerOrder).toEqual(['codex', 'claude-code', 'copilot'])
    expect(autoProvider(config.settings)).toBe('codex')
  })

  it('a move applies to the order as it is then: two in turn, each from the result of the one before', () => {
    expect(config.moveProvider('claude-code', 1)).toMatchObject({ providerOrder: ['codex', 'claude-code', 'copilot'] })
    // HR2's round 2: the window showed Copilot moved up from Claude Code's new place; main applies it to the order now.
    expect(config.moveProvider('copilot', 1)).toMatchObject({ providerOrder: ['codex', 'copilot', 'claude-code'] })
    expect(config.settings.providerOrder).toEqual(['codex', 'copilot', 'claude-code'])
    expect(() => config.moveProvider('gemini' as never, 0)).toThrow('Unknown provider')
    expect(() => config.moveProvider('codex', -1)).toThrow('toIndex')
  })

  it('its revision: main raises it by one whenever the order changes, however; never a patch', () => {
    const rev = (): number => config.settings.providerOrderRevision
    const start = rev()
    const moved = config.moveProvider('copilot', 0)
    expect([moved.revision, rev()]).toEqual([start + 1, start + 1])
    config.updateSettings({ providerOrder: ['codex', 'copilot', 'claude-code'] })
    expect(rev()).toBe(start + 2)
    // No change to the order (the same order, another setting, a move to where it is): the same revision.
    config.updateSettings({ providerOrder: ['codex', 'copilot', 'claude-code'] })
    config.updateSettings({ defaultProvider: 'codex' })
    expect(config.moveProvider('codex', 0).revision).toBe(start + 2)
    // A patch can't set it.
    config.updateSettings({ providerOrderRevision: 0 } as never)
    expect(rev()).toBe(start + 2)
    // A reset that changes the order raises it too.
    config.resetSettings('providerOrder')
    expect([config.settings.providerOrder, rev()]).toEqual([[], start + 3])
    config.updateSettings({ defaultProvider: 'auto' })
  })

  it('refuses one that is not a list of ids, each once, and changes nothing', () => {
    config.updateSettings({ providerOrder: ['copilot'] })
    for (const bad of ['codex', ['codex', 'codex'], ['codex', 7], [''], null]) {
      expect(() => config.updateSettings({ providerOrder: bad as never }), JSON.stringify(bad)).toThrow('providerOrder must list provider ids, each once.')
    }
    expect(config.settings.providerOrder).toEqual(['copilot'])
  })
})
