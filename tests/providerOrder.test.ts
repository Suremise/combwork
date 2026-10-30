// The providers' order (HI-1965): no screen sets it since decision A (HI-2113: the one order is the accounts'), but one
// saved by 0.9 is still read. config.updateSettings takes a list of provider ids, each once, and refuses anything else
// with nothing changed; what Automatic picks follows the saved order; the Assistant's settings tools don't offer it.
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-provider-order-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { config } = await import('../src/main/config')
const { autoProvider, setInstalledCheck } = await import('../src/shared/providers')
const { SETTINGS_CATALOG } = await import('../src/shared/settingsCatalog')

describe("the providers' saved order (HI-1965, read only since HI-2113)", () => {
  afterEach(() => {
    config.updateSettings({ providerOrder: [] })
    setInstalledCheck(() => false)
  })

  it('a saved list of provider ids is kept, and Automatic follows it', () => {
    config.updateSettings({ providers: { 'claude-code': { enabled: true }, codex: { enabled: true } } as never })
    setInstalledCheck(() => true)
    expect(autoProvider(config.settings)).toBe('claude-code')
    config.updateSettings({ providerOrder: ['codex', 'claude-code', 'copilot'] })
    expect(config.settings.providerOrder).toEqual(['codex', 'claude-code', 'copilot'])
    expect(autoProvider(config.settings)).toBe('codex')
  })

  it('refuses one that is not a list of ids, each once, and changes nothing', () => {
    config.updateSettings({ providerOrder: ['copilot'] })
    for (const bad of ['codex', ['codex', 'codex'], ['codex', 7], [''], null]) {
      expect(() => config.updateSettings({ providerOrder: bad as never }), JSON.stringify(bad)).toThrow('providerOrder must list provider ids, each once.')
    }
    expect(config.settings.providerOrder).toEqual(['copilot'])
  })

  it("a reset gives Hive's order back, and no revision is kept beside it", () => {
    config.updateSettings({ providerOrder: ['copilot', 'codex'] })
    config.resetSettings('providerOrder')
    expect(config.settings.providerOrder).toEqual([])
    expect('providerOrderRevision' in config.settings).toBe(false)
  })

  it("isn't among the settings the Assistant's tools list or change", () => {
    expect(SETTINGS_CATALOG.filter((e) => /providerorder/i.test(`${e.id} ${e.key}`))).toEqual([])
  })
})
