// Automatic follows what's installed (#474): the first provider turned on and installed. Since decision A (HI-2106,
// HI-2132) a new agent's CLI is its connection's, and Automatic is only the last resort for an agent with no CLI of its
// own; no default provider, Settings' or a project's, is read outside the migration.
import { afterEach, describe, expect, it } from 'vitest'
import { AUTO_PROVIDER, PROVIDERS, agentProvider, autoProvider, autoProviderPending, enabledProviders, providerWarnings, providersInUse, setInstalledCheck } from '../src/shared/providers'
import { DEFAULT_APP_CONFIG, DEFAULT_SETTINGS, mergeDefaults, migrateConfig } from '../src/shared/defaults'
import type { AppSettings, ProviderId } from '../src/shared/types'

const ALL = ['claude-code', 'codex', 'copilot']

/** Settings with these providers turned on and this default. */
function settings(on: string[], defaultProvider: string = AUTO_PROVIDER): AppSettings {
  const s = structuredClone(DEFAULT_SETTINGS)
  for (const id of ALL) s.providers[id] = { ...s.providers[id], enabled: on.includes(id) }
  s.defaultProvider = defaultProvider
  return s
}

/** These CLIs are installed, as Hive found them. */
function installed(ids: string[]): (id: ProviderId) => { found: boolean; checking?: boolean } {
  setInstalledCheck((id) => ids.includes(id))
  return (id) => ({ found: ids.includes(id) })
}

afterEach(() => setInstalledCheck(() => false))

describe('Automatic', () => {
  it('is the default for a fresh install', () => {
    expect(DEFAULT_SETTINGS.defaultProvider).toBe(AUTO_PROVIDER)
  })

  it('picks the first provider turned on and installed', () => {
    installed(['codex'])
    expect(autoProvider(settings(ALL))).toBe('codex')
    installed(['copilot'])
    expect(autoProvider(settings(['copilot']))).toBe('copilot')
    expect(autoProvider(settings(ALL))).toBe('copilot')
    // Claude Code first when it can run.
    installed(['claude-code', 'codex'])
    expect(autoProvider(settings(ALL))).toBe('claude-code')
    // Installed but turned off: not used.
    expect(autoProvider(settings(['codex']))).toBe('codex')
  })

  it('with nothing installed: the first turned on, else Claude Code', () => {
    installed([])
    expect(autoProvider(settings(['codex', 'copilot']))).toBe('codex')
    expect(autoProvider(settings([]))).toBe('claude-code')
  })

  it('never resolves from partial detection: Codex found before Claude Code has answered (#506)', () => {
    // Detection as Hive hears it: found, missing, or null while still looking.
    const heard: Partial<Record<ProviderId, boolean | null>> = { 'claude-code': null, codex: true, copilot: null }
    setInstalledCheck((id) => heard[id] ?? null)
    expect(autoProviderPending(settings(ALL))).toBe(true)
    // Its best guess meanwhile is Claude Code (not yet known missing), never Codex.
    expect(autoProvider(settings(ALL))).toBe('claude-code')
    // Claude Code answers found, Copilot hasn't answered: still pending (every turned-on provider must answer).
    heard['claude-code'] = true
    expect(autoProviderPending(settings(ALL))).toBe(true)
    // A provider turned off doesn't count.
    expect(autoProviderPending(settings(['claude-code', 'codex']))).toBe(false)
    heard.copilot = false
    expect(autoProviderPending(settings(ALL))).toBe(false)
    expect(autoProvider(settings(ALL))).toBe('claude-code')
  })

  it('settles the same whatever order the CLIs answer in (#506)', () => {
    const answers: [ProviderId, boolean][] = [['claude-code', true], ['codex', true], ['copilot', false]]
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
    for (const order of orders) {
      const heard: Partial<Record<ProviderId, boolean | null>> = {}
      setInstalledCheck((id) => heard[id] ?? null)
      for (const [n, k] of order.entries()) {
        expect(autoProviderPending(settings(ALL)), `order ${order}, before answer ${n + 1}`).toBe(true)
        // Meanwhile never a provider listed after one not yet ruled out.
        expect(autoProvider(settings(ALL)), `order ${order}`).toBe('claude-code')
        heard[answers[k][0]] = answers[k][1]
      }
      expect(autoProviderPending(settings(ALL))).toBe(false)
      expect(autoProvider(settings(ALL))).toBe('claude-code')
    }
    // Claude Code missing: Codex, once all have answered, in either order.
    for (const first of ['claude-code', 'codex'] as ProviderId[]) {
      const heard: Partial<Record<ProviderId, boolean | null>> = { copilot: false }
      setInstalledCheck((id) => heard[id] ?? null)
      heard[first] = first === 'codex'
      expect(autoProviderPending(settings(ALL))).toBe(true)
      heard[first === 'codex' ? 'claude-code' : 'codex'] = first !== 'codex'
      expect(autoProviderPending(settings(ALL))).toBe(false)
      expect(autoProvider(settings(ALL))).toBe('codex')
    }
  })
})

describe('decision A: no default provider is read (HI-2132)', () => {
  it("an agent's own provider, never moved; one without (a new workspace's Assistant) gets Automatic's pick", () => {
    installed(['copilot'])
    expect(agentProvider({ provider: 'claude-code' }, settings(ALL))).toBe('claude-code')
    expect(agentProvider({}, settings(ALL))).toBe('copilot')
    // A 0.9 config's chosen default isn't read.
    expect(agentProvider({}, settings(ALL, 'codex'))).toBe('copilot')
    expect(agentProvider(null, settings(ALL, 'claude-code'))).toBe('copilot')
  })
})

describe('which providers Hive warns about (the banner, the status bar, Provider Setup opening)', () => {
  const ids = (w: ReturnType<typeof providerWarnings>) => w.providers.map((p) => p.id)

  it('not a provider only turned on: agents on Codex leave a missing Claude Code alone', () => {
    const info = installed(['codex'])
    const s = settings(ALL)
    const w = providerWarnings(s, info, providersInUse(s, [{ agents: [{ provider: 'codex' }] }]))
    expect(w).toMatchObject({ noneInstalled: false })
    expect(ids(w)).toEqual(['codex'])
    // No agents and no usable connection: none in use.
    expect(ids(providerWarnings(s, installed(['copilot']), providersInUse(s, [])))).toEqual([])
  })

  it("an agent's provider and the first usable connection's CLI are in use; a 0.9 chosen default isn't", () => {
    const info = installed(['codex'])
    const s = settings(ALL)
    expect(ids(providerWarnings(s, info, providersInUse(s, [{ agents: [{ provider: 'claude-code' }] }])))).toEqual(['claude-code'])
    expect(ids(providerWarnings(s, info, providersInUse(s, [{ agents: [] }], 'codex')))).toEqual(['codex'])
    const chosen = settings(ALL, 'claude-code')
    expect(ids(providerWarnings(chosen, info, providersInUse(chosen, [], 'codex')))).toEqual(['codex'])
  })

  it('one warning when nothing turned on is installed, none while still looking', () => {
    const s = settings(['claude-code', 'codex'])
    expect(providerWarnings(s, installed([]), providersInUse(s, []))).toEqual({ noneInstalled: true, providers: [] })
    expect(providerWarnings(s, () => ({ found: false, checking: true }), providersInUse(s, []))).toEqual({ noneInstalled: false, providers: [] })
    // At start, Claude Code not found while Codex is still being looked for: Automatic's pick isn't known, so no warning
    // (not Claude Code's).
    expect(providerWarnings(s, (id) => (id === 'codex' ? { found: false, checking: true } : { found: false }), providersInUse(s, []))).toEqual({ noneInstalled: false, providers: [] })
    expect(providerWarnings(settings([]), installed([]), new Set()).noneInstalled).toBe(false)
  })
})

describe("Hive's order (HI-2139: no order of the user's)", () => {
  it('Claude Code, Codex, GitHub Copilot: Automatic picks the first turned on and installed in it', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(ALL)
    installed(ALL)
    expect(autoProvider(settings(ALL))).toBe('claude-code')
    expect(enabledProviders(settings(['copilot', 'codex'])).map((p) => p.id)).toEqual(['codex', 'copilot'])
    // The first not installed: the next that is; turned off: skipped.
    installed(['claude-code', 'copilot'])
    expect(autoProvider(settings(['codex', 'copilot']))).toBe('copilot')
  })

  it("a 0.9 saved order is kept as the migration's input (a damaged one as none), its revision dropped; Automatic no longer follows it", () => {
    const load = (raw: Record<string, unknown>) => migrateConfig(mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), raw), raw)
    const c = load({ version: 8, settings: { providerOrder: ['copilot', 'codex', 'claude-code'], providerOrderRevision: 4 } })
    expect(c.settings.providerOrder).toEqual(['copilot', 'codex', 'claude-code'])
    expect('providerOrderRevision' in c.settings).toBe(false)
    expect(load({ version: 8, settings: { providerOrder: ['gemini', 'codex', 'codex', 7] } }).settings.providerOrder).toEqual(['gemini', 'codex'])
    expect(load({ version: 8, settings: { providerOrder: 'codex' } }).settings.providerOrder).toEqual([])
    installed(ALL)
    expect(autoProvider(c.settings)).toBe('claude-code')
  })
})

describe('migration (config version 8)', () => {
  const load = (raw: Record<string, unknown>) => migrateConfig(mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), raw), raw)

  it('turns the old saved default, Claude Code, into Automatic', () => {
    const c = load({ version: 7, settings: { defaultProvider: 'claude-code' } })
    expect(c.version).toBe(9)
    expect(c.settings.defaultProvider).toBe(AUTO_PROVIDER)
  })

  it('keeps a Codex or Copilot default, and a Claude Code one chosen since', () => {
    expect(load({ version: 7, settings: { defaultProvider: 'codex' } }).settings.defaultProvider).toBe('codex')
    expect(load({ version: 7, settings: { defaultProvider: 'copilot' } }).settings.defaultProvider).toBe('copilot')
    expect(load({ version: 8, settings: { defaultProvider: 'claude-code' } }).settings.defaultProvider).toBe('claude-code')
  })

  it('makes an unknown provider (a newer Hive wrote it) Automatic', () => {
    expect(load({ version: 8, settings: { defaultProvider: 'gemini' } }).settings.defaultProvider).toBe(AUTO_PROVIDER)
  })
})
