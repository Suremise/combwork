// The providers' order (HI-1965) went with decision A (HI-2113, HI-2139): every provider list is in Hive's order. One
// sent to config.updateSettings (an older script's settings:update) isn't kept, Automatic picks in Hive's order, and the
// Assistant's settings tools don't offer it. A 0.9 one saved in config.json is dropped on load (defaultProvider.test.ts).
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-provider-order-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { config } = await import('../src/main/config')
const { autoProvider, setInstalledCheck } = await import('../src/shared/providers')
const { SETTINGS_CATALOG } = await import('../src/shared/settingsCatalog')

describe("the providers' order is gone (HI-2139)", () => {
  afterEach(() => setInstalledCheck(() => false))

  it("one sent isn't kept, and the rest of the patch is; Automatic picks in Hive's order", () => {
    config.updateSettings({ providers: { 'claude-code': { enabled: true }, codex: { enabled: true } } as never })
    setInstalledCheck(() => true)
    config.updateSettings({ providerOrder: ['codex', 'claude-code', 'copilot'], sessions: { transcriptWarnMB: 77 } } as never)
    expect('providerOrder' in config.settings).toBe(false)
    expect(config.settings.sessions.transcriptWarnMB).toBe(77)
    expect(autoProvider(config.settings)).toBe('claude-code')
  })

  it("isn't among the settings the Assistant's tools list or change", () => {
    expect(SETTINGS_CATALOG.filter((e) => /providerorder/i.test(`${e.id} ${e.key}`))).toEqual([])
  })
})
