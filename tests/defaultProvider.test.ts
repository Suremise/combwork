// The default provider follows what's installed (#474): Automatic (the default) gives new agents the first provider
// turned on and installed, a default the user chose wins, and a project with no agents warns only about a provider
// the user chose, or when nothing is installed.
import { afterEach, describe, expect, it } from 'vitest'
import { AUTO_PROVIDER, agentProvider, autoProvider, autoProviderPending, chosenDefaultProvider, defaultProviderPending, defaultProviderLabel, defaultProviderWarning, inProviderOrder, orderedProviders, projectDefaultProvider, providerWarnings, providersInUse, setInstalledCheck } from '../src/shared/providers'
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

const INHERIT = { defaultProvider: 'inherit' }

afterEach(() => setInstalledCheck(() => false))

describe('Automatic', () => {
  it('is the default for a fresh install', () => {
    expect(DEFAULT_SETTINGS.defaultProvider).toBe(AUTO_PROVIDER)
    expect(chosenDefaultProvider(INHERIT, DEFAULT_SETTINGS)).toBeNull()
  })

  it('picks the first provider turned on and installed', () => {
    installed(['codex'])
    expect(projectDefaultProvider(INHERIT, settings(ALL))).toBe('codex')
    installed(['copilot'])
    expect(projectDefaultProvider(INHERIT, settings(['copilot']))).toBe('copilot')
    expect(projectDefaultProvider(INHERIT, settings(ALL))).toBe('copilot')
    // Claude Code first when it can run.
    installed(['claude-code', 'codex'])
    expect(projectDefaultProvider(INHERIT, settings(ALL))).toBe('claude-code')
    // Installed but turned off: not used.
    expect(projectDefaultProvider(INHERIT, settings(['codex']))).toBe('codex')
  })

  it('with nothing installed: the first turned on, else Claude Code', () => {
    installed([])
    expect(autoProvider(settings(['codex', 'copilot']))).toBe('codex')
    expect(autoProvider(settings([]))).toBe('claude-code')
  })

  it('says what it picks', () => {
    installed(['copilot'])
    expect(defaultProviderLabel(settings(ALL))).toBe('Automatic (GitHub Copilot)')
    expect(defaultProviderLabel(settings([]))).toBe('Automatic')
    expect(defaultProviderLabel(settings(ALL, 'codex'))).toBe('Codex')
  })

  it('never resolves from partial detection: Codex found before Claude Code has answered (#506)', () => {
    // Detection as Hive hears it: found, missing, or null while still looking.
    const heard: Partial<Record<ProviderId, boolean | null>> = { 'claude-code': null, codex: true, copilot: null }
    setInstalledCheck((id) => heard[id] ?? null)
    expect(autoProviderPending(settings(ALL))).toBe(true)
    expect(defaultProviderPending(INHERIT, settings(ALL))).toBe(true)
    // Its best guess meanwhile is Claude Code (not yet known missing), never Codex.
    expect(autoProvider(settings(ALL))).toBe('claude-code')
    expect(defaultProviderLabel(settings(ALL))).toBe('Automatic (checking…)')
    // A chosen default doesn't wait.
    expect(defaultProviderPending(INHERIT, settings(ALL, 'codex'))).toBe(false)
    // Claude Code answers found, Copilot hasn't answered: still pending (every turned-on provider must answer).
    heard['claude-code'] = true
    expect(autoProviderPending(settings(ALL))).toBe(true)
    expect(defaultProviderLabel(settings(ALL))).toBe('Automatic (checking…)')
    // A provider turned off doesn't count.
    expect(autoProviderPending(settings(['claude-code', 'codex']))).toBe(false)
    heard.copilot = false
    expect(autoProviderPending(settings(ALL))).toBe(false)
    expect(autoProvider(settings(ALL))).toBe('claude-code')
    expect(defaultProviderLabel(settings(ALL))).toBe('Automatic (Claude Code)')
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

describe('a default the user chose', () => {
  it("wins over Automatic, Settings' or the project's own, even when it isn't installed", () => {
    installed(['copilot'])
    expect(projectDefaultProvider(INHERIT, settings(ALL, 'claude-code'))).toBe('claude-code')
    expect(projectDefaultProvider({ defaultProvider: 'codex' }, settings(ALL))).toBe('codex')
    expect(chosenDefaultProvider({ defaultProvider: 'codex' }, settings(ALL))).toBe('codex')
  })

  it("never moves an agent's own provider", () => {
    installed(['copilot'])
    expect(agentProvider({ provider: 'claude-code' }, INHERIT, settings(ALL))).toBe('claude-code')
    // An agent without one (the Assistant's) follows the default.
    expect(agentProvider({}, INHERIT, settings(ALL))).toBe('copilot')
  })
})

describe("a project's warning before it has agents", () => {
  it('names no CLI nobody chose: a Codex-only or Copilot-only install sees none', () => {
    expect(defaultProviderWarning(INHERIT, settings(['codex']), installed(['codex']))).toBeNull()
    expect(defaultProviderWarning(INHERIT, settings(['copilot']), installed(['copilot']))).toBeNull()
    // Claude Code turned on but missing is the providers banner's to say, not this.
    expect(defaultProviderWarning(INHERIT, settings(ALL), installed(['copilot']))).toBeNull()
  })

  it('warns when nothing is installed, or nothing is turned on', () => {
    expect(defaultProviderWarning(INHERIT, settings(ALL), installed([]))).toEqual({ text: 'No coding agent CLI is installed — Help → Provider Setup', fix: 'setup' })
    expect(defaultProviderWarning(INHERIT, settings([]), installed([]))).toEqual({ text: 'No coding agents are turned on — Settings → Providers', fix: 'providers' })
  })

  it('says nothing while Hive is still looking', () => {
    expect(defaultProviderWarning(INHERIT, settings(['codex']), () => ({ found: false, checking: true }))).toBeNull()
    expect(defaultProviderWarning(INHERIT, settings(['codex']), () => undefined)).toBeNull()
  })

  it('names a chosen default that is missing or turned off', () => {
    expect(defaultProviderWarning(INHERIT, settings(ALL, 'claude-code'), installed(['codex']))).toEqual({ text: "Claude Code isn't installed — Help → Provider Setup", fix: 'setup' })
    expect(defaultProviderWarning({ defaultProvider: 'codex' }, settings(['copilot']), installed(['copilot']))).toEqual({ text: 'Codex is turned off — Settings → Providers', fix: 'providers' })
    expect(defaultProviderWarning(INHERIT, settings(ALL, 'codex'), installed(['codex']))).toBeNull()
  })
})

describe('which providers Hive warns about (the banner, the status bar, Provider Setup opening)', () => {
  const ids = (w: ReturnType<typeof providerWarnings>) => w.providers.map((p) => p.id)

  it('not a provider only turned on: Automatic on Codex leaves a missing Claude Code alone', () => {
    const info = installed(['codex'])
    const s = settings(ALL)
    const w = providerWarnings(s, info, providersInUse(s, [{ config: INHERIT, agents: [{ provider: 'codex' }] }]))
    expect(w).toMatchObject({ noneInstalled: false })
    expect(ids(w)).toEqual(['codex'])
    // Copilot-only the same.
    const c = providerWarnings(s, installed(['copilot']), providersInUse(s, []))
    expect(ids(c)).toEqual(['copilot'])
  })

  it("an agent's provider, a project's own default and a chosen default are in use", () => {
    const info = installed(['codex'])
    const s = settings(ALL)
    expect(ids(providerWarnings(s, info, providersInUse(s, [{ config: INHERIT, agents: [{ provider: 'claude-code' }] }])))).toEqual(['claude-code', 'codex'])
    expect(ids(providerWarnings(s, info, providersInUse(s, [{ config: { defaultProvider: 'copilot' }, agents: [] }])))).toEqual(['codex', 'copilot'])
    const chosen = settings(ALL, 'claude-code')
    expect(ids(providerWarnings(chosen, info, providersInUse(chosen, [])))).toEqual(['claude-code'])
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
    expect(defaultProviderLabel(inOrder(['copilot', 'codex', 'claude-code']))).toBe('Automatic (GitHub Copilot)')
    // The first in the order not installed: the next that is.
    installed(['claude-code', 'copilot'])
    expect(projectDefaultProvider(INHERIT, inOrder(['codex', 'copilot', 'claude-code']))).toBe('copilot')
    // Turned off: skipped, whatever its place.
    installed(ALL)
    expect(autoProvider(inOrder(['codex', 'copilot', 'claude-code'], ['claude-code', 'copilot']))).toBe('copilot')
    // A default the user chose still wins over the order.
    expect(projectDefaultProvider(INHERIT, { ...inOrder(['codex']), defaultProvider: 'claude-code' })).toBe('claude-code')
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
