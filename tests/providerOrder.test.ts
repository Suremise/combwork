// The providers' order (HI-1965) went with decision A (HI-2113, HI-2139): every provider list is in Combwork's order. A 0.9
// one stays in config.json, read-only, for the migration (accountsMigration.test.ts); one sent to config.updateSettings
// (an older script's settings:update) changes nothing, Automatic picks in Combwork's order, and the Assistant's settings tools
// don't offer it.
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-provider-order-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { config } = await import('../src/main/config')
const { autoProvider, setInstalledCheck } = await import('../src/shared/providers')
const { SETTINGS_CATALOG } = await import('../src/shared/settingsCatalog')

describe("the providers' order is gone (HI-2139)", () => {
  afterEach(() => setInstalledCheck(() => false))

  it("one sent changes nothing, and the rest of the patch applies; Automatic picks in Combwork's order", () => {
    config.updateSettings({ providers: { 'claude-code': { enabled: true }, codex: { enabled: true } } as never })
    setInstalledCheck(() => true)
    const before = config.settings.providerOrder
    config.updateSettings({ providerOrder: ['codex', 'claude-code', 'copilot'], sessions: { transcriptWarnMB: 77 } } as never)
    expect(config.settings.providerOrder).toEqual(before)
    expect(config.settings.sessions.transcriptWarnMB).toBe(77)
    expect(autoProvider(config.settings)).toBe('claude-code')
  })

  it("isn't among the settings the Assistant's tools list or change", () => {
    expect(SETTINGS_CATALOG.filter((e) => /providerorder/i.test(`${e.id} ${e.key}`))).toEqual([])
  })
})
