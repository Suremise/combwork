// Automatic follows what's installed (#474): the first provider turned on and installed. Since decision A (HI-2106,
// HI-2132) a new agent's CLI is its connection's, and Automatic is only the last resort for an agent with no CLI of its
// own; no default provider, Settings' or a project's, is read outside the migration.
import { afterEach, describe, expect, it } from 'vitest'
import { AUTO_PROVIDER, agentProvider, autoProvider, autoProviderPending, inProviderOrder, orderedProviders, providerWarnings, providersInUse, setInstalledCheck } from '../src/shared/providers'
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

describe("the providers' order (HI-1965)", () => {
  const ordered = (s: AppSettings): string[] => orderedProviders(s).map((p) => p.id)
  const inOrder = (order: string[], on = ALL): AppSettings => ({ ...settings(on), providerOrder: order })

  it("Hive's own order until the user reorders: Claude Code, Codex, GitHub Copilot", () => {
    expect(DEFAULT_SETTINGS.providerOrder).toEqual([])
    expect(ordered(settings(ALL))).toEqual(ALL)
  })

  it('Automatic picks the first turned on and installed in the order as set, and says so', () => {
    installed(['claude-code', 'codex', 'copilot'])
    expect(autoProvider(inOrder(['codex', 'copilot', 'claude-code']))).toBe('codex')
    expect(autoProvider(inOrder(['copilot', 'codex', 'claude-code']))).toBe('copilot')
    // The first in the order not installed: the next that is.
    installed(['claude-code', 'copilot'])
    expect(autoProvider(inOrder(['codex', 'copilot', 'claude-code']))).toBe('copilot')
    // Turned off: skipped, whatever its place.
    installed(ALL)
    expect(autoProvider(inOrder(['codex', 'copilot', 'claude-code'], ['claude-code', 'copilot']))).toBe('copilot')
  })

  it('names some providers: those first, the rest after in Hive’s order; unknown ids skipped', () => {
    expect(ordered(inOrder(['copilot']))).toEqual(['copilot', 'claude-code', 'codex'])
    expect(ordered(inOrder(['gemini', 'codex']))).toEqual(['codex', 'claude-code', 'copilot'])
  })

  it("a list's provider entries follow it, each run in its own places; the rest stay (Settings' and Project Settings' sections, Advanced's tabs)", () => {
    const nav = ['general', 'providers', 'p:claude-code', 'p:codex', 'p:copilot', 'assistant', 'a:claude-code', 'a:codex', 'a:copilot', 'advanced']
    const providerOf = (s: string) => (s.includes(':') ? (s.split(':')[1] as ProviderId) : null)
    expect(inProviderOrder(nav, providerOf, inOrder(['copilot', 'claude-code', 'codex']))).toEqual(['general', 'providers', 'p:copilot', 'p:claude-code', 'p:codex', 'assistant', 'a:copilot', 'a:claude-code', 'a:codex', 'advanced'])
    expect(inProviderOrder(nav, providerOf, settings(ALL))).toEqual(nav)
    // An entry of a provider this Hive doesn't know (an old Advanced group) stays where it was.
    expect(inProviderOrder(['hive', 'claude-code', 'codex', 'gemini'], (g) => (g === 'hive' ? null : (g as ProviderId)), inOrder(['codex']))).toEqual(['hive', 'codex', 'claude-code', 'gemini'])
  })

  it('survives a restart: saved, loaded as it was; a damaged one is Hive’s order', () => {
    const load = (raw: Record<string, unknown>) => migrateConfig(mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), raw), raw)
    expect(load({ version: 8, settings: { providerOrder: ['copilot', 'codex', 'claude-code'] } }).settings.providerOrder).toEqual(['copilot', 'codex', 'claude-code'])
    expect(load({ version: 8, settings: { providerOrder: ['gemini', 'codex', 'codex', 7] } }).settings.providerOrder).toEqual(['gemini', 'codex'])
    expect(load({ version: 8, settings: { providerOrder: 'codex' } }).settings.providerOrder).toEqual([])
    expect(load({ version: 8, settings: {} }).settings.providerOrder).toEqual([])
    // Its revision went with the window's moves (HI-2113): a saved one is dropped.
    expect('providerOrderRevision' in load({ version: 8, settings: { providerOrder: ['codex'], providerOrderRevision: 4 } }).settings).toBe(false)
  })
})

describe('migration (config version 8)', () => {
  const load = (raw: Record<string, unknown>) => migrateConfig(mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), raw), raw)

  it('turns the old saved default, Claude Code, into Automatic', () => {
    const c = load({ version: 7, settings: { defaultProvider: 'claude-code' } })
    expect(c.version).toBe(8)
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
