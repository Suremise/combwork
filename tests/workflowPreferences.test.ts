// Card loops and file locks as workflow options (HI-1766): how they resolve (each on its own, Hive's → the workspace's →
// the project's, a value they don't take passed over), that they aren't rules (no ruleset or preset changes, never
// Custom, kept through a preset's choice, no "How do you work?" answered by them), and how the old settings move in:
// a new value wins (key presence, false and all), a default saved into every file is no choice, both platforms' options
// get them, a project with no workflow options keeps its own until it has, and reading twice moves nothing twice.
import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, DEFAULT_PROJECT_CONFIG, mergeDefaults, migrateConfig, migrateProjectConfig } from '../src/shared/defaults'
import { compile, ruleOptions } from '../src/shared/workflow/compile'
import { allOff, FORM_OPTIONS, PREFERENCE_OPTIONS, preset, withUnpreset, type WorkflowOptions } from '../src/shared/workflow/options'
import { asksPreset } from '../src/shared/workflow/presetStep'
import { legacyPreferences, migrateGlobalFileLocks, migrateProjectPreferences, migrateWorkspacePreferences, PREFERENCE_DEFAULTS, preferencesOf, projectInfoPreferences, projectOwnPreferences } from '../src/shared/workflow/preferences'
import { resolveOptions } from '../src/main/workflow/rulesets'
import type { ProjectConfig } from '../src/shared/types'

const PREFS: Partial<WorkflowOptions> = { loopWakes: false, loopRounds: 3, loopWaitHours: 2, loopStepWaitMinutes: 45, fileLocks: 'warn' }

describe('the preferences resolve on their own (HI-1766)', () => {
  it('the defaults, then each level over the one before, for the platform in force', () => {
    expect(preferencesOf('git', {}).values).toEqual(PREFERENCE_DEFAULTS)
    const r = preferencesOf('git', { global: { git: { fileLocks: 'off', loopRounds: 4 } }, workspace: { git: { loopRounds: 5 }, none: { loopWaitHours: 9 } }, project: { loopWakes: false } })
    expect(r.values).toEqual({ ...PREFERENCE_DEFAULTS, fileLocks: 'off', loopRounds: 5, loopWakes: false })
    expect(r.origins).toEqual({ fileLocks: 'global', loopRounds: 'workspace', loopWakes: 'project', loopWaitHours: 'platform', loopStepWaitMinutes: 'platform', maxAgents: 'platform' })
  })

  it('a value an option doesn’t take is passed over, not the level: other levels and options still count', () => {
    const r = preferencesOf('none', { workspace: { none: { loopRounds: 51, loopWaitHours: 3 } }, project: { loopStepWaitMinutes: 0, fileLocks: 'nope' } as never })
    expect(r.values).toEqual({ ...PREFERENCE_DEFAULTS, loopWaitHours: 3 })
  })

  it('options whose rules contradict each other fall back to All off, but the loop settings stay the project’s', () => {
    const levels = { project: { review: 'agent' as const, noSelfReview: false, loopRounds: 7 } }
    expect(resolveOptions('git', levels).invalid).toBeTruthy()
    expect(preferencesOf('git', levels).values.loopRounds).toBe(7)
  })

  it('the resolved options show them, the defaults from the platform, with their origins', () => {
    const r = resolveOptions('none', { workspace: { none: { loopRounds: 4 } }, project: { fileLocks: 'ask' } })
    expect(r.invalid).toBeNull()
    expect([r.options.loopRounds, r.origins.loopRounds, r.options.fileLocks, r.origins.fileLocks, r.options.loopWakes, r.origins.loopWakes]).toEqual([4, 'workspace', 'ask', 'project', true, 'platform'])
  })
})

describe('they aren’t rules (HI-1766)', () => {
  it('no ruleset changes with them: None’s and Git’s All off and every preset keep their ids', () => {
    for (const platform of ['none', 'git'] as const) {
      for (const o of [allOff(platform), preset(platform, 'solo'), preset(platform, 'pair'), preset(platform, 'team')]) {
        const plain = compile(o)
        const withPrefs = compile({ ...o, ...PREFS })
        expect(plain.ok && withPrefs.ok && plain.ruleset.id === withPrefs.ruleset.id).toBe(true)
        expect(Object.keys(ruleOptions({ ...o, ...PREFS })).some((k) => (PREFERENCE_OPTIONS as readonly string[]).includes(k))).toBe(false)
      }
    }
  })

  it('no preset or All off sets them but Maximum agents (HI-2001), and the form’s Custom never counts them', () => {
    for (const platform of ['none', 'git'] as const) {
      for (const o of [allOff(platform), preset(platform, 'pair')]) for (const k of PREFERENCE_OPTIONS) expect(o[k], k).toBe(k === 'maxAgents' ? o.maxAgents : undefined)
      expect([allOff(platform).maxAgents, preset(platform, 'pair').maxAgents]).toEqual([12, 2])
      for (const k of PREFERENCE_OPTIONS) expect(FORM_OPTIONS[platform]).not.toContain(k)
    }
  })

  it('a preset or All off chosen keeps the draft’s own preferences and names, and sets none of its own', () => {
    const own = { ...PREFS, stageNames: { active: 'Building' }, review: 'none' as const }
    const { platform: _p, ...pair } = preset('git', 'pair')
    const chosen = withUnpreset({ ...pair, loopRounds: 99 } as never, own)
    expect(chosen).toMatchObject({ ...PREFS, stageNames: { active: 'Building' }, review: 'agent' })
    // Inherited (not the draft's own): the preset sets none but Maximum agents (HI-2001), so they keep inheriting.
    expect(Object.keys(withUnpreset(pair, { review: 'none' })).filter((k) => (PREFERENCE_OPTIONS as readonly string[]).includes(k))).toEqual(['maxAgents'])
  })

  it('options with only preferences answer no "How do you work?"', () => {
    const cfg = (options: Partial<WorkflowOptions>) => ({ platform: 'git' as const, workflow: { platform: 'git' as const, preset: null, options } })
    expect(asksPreset(cfg({ loopRounds: 4, fileLocks: 'off' }), 'git')).toBe(true)
    expect(asksPreset(cfg({ loopRounds: 4, review: 'agent' }), 'git')).toBe(false)
  })
})

describe("a project's settings from before HI-1766", () => {
  const old = { version: 2, agents: [], loopWakes: false, loopRounds: 4, loopWaitHours: null, loopStepWaitMinutes: 45, fileLocks: 'warn' }

  it('move into its options in force and each kept platform’s, a value set there already winning (false too), the rest untouched', () => {
    const raw = {
      ...old,
      workflow: {
        platform: 'git',
        preset: 'pair',
        options: { review: 'agent', loopWakes: true, loopRounds: 9 },
        presetAsked: 'chosen',
        kept: { none: { preset: null, options: { review: 'none', fileLocks: 'off' } } }
      }
    }
    const out = migrateProjectPreferences(raw)
    for (const k of ['loopWakes', 'loopRounds', 'loopWaitHours', 'loopStepWaitMinutes', 'fileLocks']) expect(k in out).toBe(false)
    expect(out.workflow).toEqual({
      platform: 'git',
      preset: 'pair',
      options: { review: 'agent', loopWakes: true, loopRounds: 9, loopStepWaitMinutes: 45, fileLocks: 'warn' },
      presetAsked: 'chosen',
      kept: { none: { preset: null, options: { review: 'none', fileLocks: 'off', loopWakes: false, loopRounds: 4, loopStepWaitMinutes: 45 } } }
    })
    expect(migrateProjectPreferences(out)).toBe(out)
  })

  it('a project with no workflow options keeps the ones it chose (giving it options would choose a workflow), read as its own', () => {
    const out = migrateProjectPreferences({ ...old, loopWaitHours: null })
    expect(out).toEqual({ version: 2, agents: [], loopWakes: false, loopRounds: 4, loopStepWaitMinutes: 45, fileLocks: 'warn' })
    expect('workflow' in out).toBe(false)
    expect(projectOwnPreferences('none', out as unknown as ProjectConfig)).toEqual({ loopWakes: false, loopRounds: 4, loopStepWaitMinutes: 45, fileLocks: 'warn' })
    expect(projectInfoPreferences({ config: out as unknown as ProjectConfig, platform: { id: 'none' } }, null, { none: { loopRounds: 7, loopWaitHours: 2 } })).toEqual({ ...PREFERENCE_DEFAULTS, loopWakes: false, loopRounds: 4, loopWaitHours: 2, loopStepWaitMinutes: 45, fileLocks: 'warn' })
    expect(migrateProjectPreferences(out)).toEqual(out)
  })

  it('the defaults saved into every project.json (wakes on, nothing set, Inherit) are no choice: they go, and none comes back', () => {
    const saved = { version: 2, agents: [], loopWakes: true, loopRounds: null, loopWaitHours: null, loopStepWaitMinutes: null, fileLocks: 'inherit' }
    expect(legacyPreferences(saved)).toEqual({})
    const read = mergeDefaults(structuredClone(DEFAULT_PROJECT_CONFIG), migrateProjectConfig(saved))
    for (const k of ['loopWakes', 'loopRounds', 'loopWaitHours', 'loopStepWaitMinutes', 'fileLocks']) expect(k in read).toBe(false)
  })

  it('migrateProjectConfig moves them as a project is read, and reading what it gives again changes nothing', () => {
    const raw = { ...old, workflow: { platform: 'none', preset: null, options: { review: 'none' } } }
    const once = migrateProjectConfig(structuredClone(raw))
    expect(once.workflow.options).toEqual({ review: 'none', loopWakes: false, loopRounds: 4, loopStepWaitMinutes: 45, fileLocks: 'warn' })
    expect(migrateProjectConfig(structuredClone(once))).toEqual(once)
  })
})

describe("the workspace's and Hive's settings from before HI-1766", () => {
  it("the workspace's card loop rounds and wait become its defaults for None and Git, where they don't set them", () => {
    const out = migrateWorkspacePreferences({ loops: { rounds: 4, waitHours: 2 }, workflow: { git: { loopWaitHours: 5, review: 'agent' } } } as Record<string, unknown>)
    expect(out).toEqual({ workflow: { none: { loopRounds: 4, loopWaitHours: 2 }, git: { loopRounds: 4, loopWaitHours: 5, review: 'agent' } } })
    expect(migrateWorkspacePreferences(out)).toBe(out)
    // Nothing usable: only the old key goes.
    expect(migrateWorkspacePreferences({ loops: { rounds: 0 }, advanced: {} } as Record<string, unknown>)).toEqual({ advanced: {} })
  })

  it("Settings → Agents → File locks becomes Hive's default for None and Git; Block, saved into every config, is no choice", () => {
    const load = (raw: Record<string, unknown>) => migrateConfig(mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), raw), raw)
    const warn = load({ settings: { agents: { fileLocks: 'warn' }, workflow: { git: { fileLocks: 'off' } } } })
    expect(warn.settings.workflow).toEqual({ none: { fileLocks: 'warn' }, git: { fileLocks: 'off' } })
    expect('fileLocks' in warn.settings.agents).toBe(false)
    const block = load({ settings: { agents: { fileLocks: 'block' } } })
    expect(block.settings.workflow).toBeUndefined()
    expect('fileLocks' in block.settings.agents).toBe(false)
    // Read again: as it was.
    const again = load(structuredClone(warn) as unknown as Record<string, unknown>)
    expect(again.settings.workflow).toEqual(warn.settings.workflow)
    const settings = { agents: { fileLocks: 'ask' } as Record<string, unknown>, workflow: undefined }
    migrateGlobalFileLocks(settings)
    expect(settings.workflow).toEqual({ none: { fileLocks: 'ask' }, git: { fileLocks: 'ask' } })
  })
})
