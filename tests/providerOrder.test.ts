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

  it('refuses one that is not a list of ids, each once, and changes nothing', () => {
    config.updateSettings({ providerOrder: ['copilot'] })
    for (const bad of ['codex', ['codex', 'codex'], ['codex', 7], [''], null]) {
      expect(() => config.updateSettings({ providerOrder: bad as never }), JSON.stringify(bad)).toThrow('providerOrder must list provider ids, each once.')
    }
    expect(config.settings.providerOrder).toEqual(['copilot'])
  })
})
