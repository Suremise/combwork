// Models and capabilities from the CLIs, with editable fallbacks (#125): contract tests against recorded replies (Claude
// Code 2.1.289's initialize, Codex 0.160's debug models, personal fields removed), defensive parsing, and the shared
// resolution the pickers, the footer and the Agent API use.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { parseClaudeInitialize } from '../src/main/providers/claude/models'
import { parseCodexModels } from '../src/main/providers/codex/models'
import { catalogLabel, catalogModel, chosenName, cliDefaultEffort, effortText, effortUnknown, fallbackEfforts, fallbackModels, modelCaps, modelGroups, modelSource, modelSourceText, shippedModels } from '../src/shared/models'
import { tr } from '../src/shared/i18n'
import { modeCaveat } from '../src/shared/providers'
import { agentModelShown, effectiveModelLabel, effortLabel, footerChoices, launchedWithOf } from '../src/shared/defaults'
import { listedPriceModels, modelPrice, priceRows, usesOwnPrices } from '../src/shared/prices'
import { config } from '../src/main/config'
import type { AgentInstallInfo, AppSettings, ModelCatalog, ProviderSettings } from '../src/shared/types'

const fixture = (f: string): string => readFileSync(join(__dirname, 'fixtures', f), 'utf8')
const claudeReply = JSON.parse(fixture('claude-initialize.json')).response.response
const claude = parseClaudeInitialize(claudeReply)!
const codex = parseCodexModels(fixture('codex-debug-models.json'))!
const catalog = (models: ModelCatalog['models'], extra: Partial<ModelCatalog> = {}): Pick<AgentInstallInfo, 'catalog' | 'configuredEffort' | 'observedEfforts' | 'defaultModel'> => ({ catalog: { source: 'cli', version: '1', models, at: '', ...extra } })
const settingsWith = (provider: string, ps: Partial<ProviderSettings>): Pick<AppSettings, 'providers'> => ({ providers: { [provider]: ps as ProviderSettings } })

// Claude Code 2.1.294's entry for Haiku 5.5, as the CLI reports it (the reviewer's model-only capture, #397): unlike Haiku
// 4.5, it takes effort and runs in Auto. The alias now resolves to 5.5 on the first-party API.
describe("Claude Code 2.1.294's Haiku 5.5 reply (#397)", () => {
  const haiku55 = {
    value: 'haiku',
    resolvedModel: 'claude-haiku-5-5',
    displayName: 'Haiku',
    description: 'Haiku 5.5 · Fastest for quick answers · $0.10/$0.50 per Mtok ($0.50/$2.50 for prompts over 100k)',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true
  }
  it("the alias is Haiku 5.5, with the levels it takes and Auto", () => {
    const parsed = parseClaudeInitialize({ models: [haiku55] })!
    expect(parsed.models.find((m) => m.value === 'haiku')).toMatchObject({ resolved: 'claude-haiku-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAuto: true })
  })
  it('the price of the alias is Haiku 5.5 (the rates up to 100,000 prompt tokens)', () => {
    expect(modelPrice('claude-code', 'haiku')).toMatchObject({ input: 0.1, output: 0.5 })
  })
})

describe("Claude Code's initialize reply (2.1.289)", () => {
  it('lists exactly the models it reports, Fable included, without "default" (which is the CLI default model)', () => {
    expect(claude.models.map((m) => m.value)).toEqual(['opus', 'fable', 'sonnet', 'haiku', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'])
    expect(claude.defaultModel).toBe('claude-opus-5-5')
    expect(claude.models.find((m) => m.value === 'fable')).toMatchObject({ label: 'Fable 5.1', resolved: 'claude-fable-5-1' })
  })

  it("per model: its own effort levels (none for Haiku, no xhigh for 4.6) and whether it runs in Auto", () => {
    const by = (v: string) => claude.models.find((m) => m.value === v)!
    expect(by('opus').efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(by('claude-opus-4-6').efforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(by('haiku')).toMatchObject({ efforts: [], supportsAuto: false, resolved: 'claude-haiku-4-5-20251001' })
    expect(by('sonnet').supportsAuto).toBe(true)
    // An id that is its own resolved model carries no separate resolved.
    expect(by('claude-opus-4-8').resolved).toBeUndefined()
  })

  it('never keeps anything but the models: account and the other personal fields are not read', () => {
    const withAccount = { ...claudeReply, account: { email: 'someone@example.com', organization: 'Org' }, commands: [{ name: 'mine' }], pid: 1 }
    expect(JSON.stringify(parseClaudeInitialize(withAccount))).not.toMatch(/someone@example|Org|mine/)
    expect(JSON.stringify(parseClaudeInitialize(withAccount))).toBe(JSON.stringify(claude))
  })

  it('reads an older or odd reply defensively: unknown fields ignored, missing ones left out, garbage is null', () => {
    // An older CLI without the per-model flags says nothing about effort or Auto: Hive falls back for them.
    const old = parseClaudeInitialize({ models: [{ value: 'opus', displayName: 'Opus' }, { value: 'haiku', resolvedModel: 'haiku', weird: 1 }] })!
    expect(old.models).toEqual([{ value: 'opus', label: 'Opus' }, { value: 'haiku', label: 'haiku' }])
    // Odd entries are skipped; levels that aren't strings are dropped.
    const odd = parseClaudeInitialize({ models: [null, 5, { displayName: 'no value' }, { value: 'x', supportsEffort: true, supportedEffortLevels: ['low', 3, 'low', ''] }] })!
    expect(odd.models).toEqual([{ value: 'x', label: 'x', efforts: ['low'] }])
    for (const bad of [null, 'text', {}, { models: 'no' }, { models: [] }, { models: [{ value: 'default' }] }]) expect(parseClaudeInitialize(bad)).toBeNull()
  })

  it('an odd capability field is unknown, so the edited fallback applies; a stated "none" still wins (review round 1)', () => {
    const valid = { value: 'opus', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsAutoMode: true }
    const r = parseClaudeInitialize({
      models: [
        valid,
        { value: 'odd', supportsEffort: true, supportedEffortLevels: 'high', supportsAutoMode: 'yes' },
        { value: 'junk-levels', supportedEffortLevels: [null, 3, ''] },
        { value: 'odd-flag', supportsEffort: 'sure', supportedEffortLevels: ['low'] },
        { value: 'says-yes-no-list', supportsEffort: true },
        { value: 'contradicts', supportsEffort: false, supportedEffortLevels: ['low'] },
        { value: 'says-none', supportsEffort: false, supportsAutoMode: false },
        { value: 'empty', supportedEffortLevels: [] },
        { value: 'like-haiku' }
      ]
    })!
    const by = (v: string) => r.models.find((m) => m.value === v)!
    for (const v of ['odd', 'junk-levels', 'odd-flag', 'says-yes-no-list', 'contradicts']) expect(by(v).efforts, v).toBeUndefined()
    expect(by('odd').supportsAuto).toBeUndefined()
    // Stated negatives, and the protocol's own (a model without the fields in a reply that states them: Haiku).
    expect(by('says-none')).toMatchObject({ efforts: [], supportsAuto: false })
    expect(by('empty').efforts).toEqual([])
    expect(by('like-haiku')).toMatchObject({ efforts: [], supportsAuto: false })
    // Odd fields on one model are no evidence that the reply states them: nothing is "none" then.
    const onlyOdd = parseClaudeInitialize({ models: [{ value: 'a', supportsEffort: 'x', supportsAutoMode: 1 }, { value: 'b' }] })!
    expect(onlyOdd.models).toEqual([{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }])
    // In the pickers: an odd model offers the user's edited fallback (and the shipped guess for Auto); a stated none offers none.
    const own = settingsWith('claude-code', { effortFallback: [{ value: 'low', label: 'Quick' }, { value: 'max', label: 'Deep' }] })
    expect(modelCaps('claude-code', 'odd', catalog(r.models), own)).toMatchObject({ perModel: false, efforts: [{ value: 'low', label: 'Quick' }, { value: 'max', label: 'Deep' }], supportsAuto: undefined })
    expect(modelCaps('claude-code', 'says-none', catalog(r.models), own)).toMatchObject({ perModel: true, efforts: [], supportsAuto: false })
    expect(modeCaveat('claude-code', 'auto', 'claude-haiku-4-5', modelCaps('claude-code', 'odd', catalog(r.models), own))).toMatch(/^Claude Code may not offer Auto/)
  })

  it('shows unavailable_models as unavailable when the reply has them', () => {
    const r = parseClaudeInitialize({ ...claudeReply, unavailable_models: [{ value: 'claude-mythos-1', displayName: 'Mythos 1' }, { value: 'opus' }] })!
    expect(r.models.at(-1)).toEqual({ value: 'claude-mythos-1', label: 'Mythos 1', efforts: [], supportsAuto: false, unavailable: true })
    expect(r.models.filter((m) => m.value === 'opus')).toHaveLength(1)
    const groups = modelGroups('claude-code', catalog(r.models), null)
    expect(groups.map((g) => [g.label, !!g.unavailable])).toEqual([['Claude Code models', false], ['Not available to this account', true]])
  })
})

describe("an alias and the model it stands for (#248), from Claude Code 2.1.289's reply", () => {
  const info = { ...catalog(claude.models), defaultModel: claude.defaultModel }
  const by = (v: string) => claude.models.find((m) => m.value === v)!

  it('pickers: an alias reads "Opus (Opus 5.5)", a pinned version as the CLI names it', () => {
    expect(catalogLabel('claude-code', by('opus'), info)).toBe('Opus (Opus 5.5)')
    expect(catalogLabel('claude-code', by('fable'), info)).toBe('Fable (Fable 5.1)')
    // Haiku's alias stands for a dated id: named without the date.
    expect(catalogLabel('claude-code', by('haiku'), info)).toBe('Haiku (Haiku 4.5)')
    expect(catalogLabel('claude-code', by('claude-opus-4-8'), info)).toBe('Opus 4.8')
    const labels = modelGroups('claude-code', info, null)[0].models.map((m) => m.label)
    expect(labels.slice(0, 4)).toEqual(['Opus (Opus 5.5)', 'Fable (Fable 5.1)', 'Sonnet (Sonnet 5.5)', 'Haiku (Haiku 4.5)'])
    expect(labels).toContain('Sonnet 5')
  })

  it('a CLI that names the alias itself ("Opus") keeps that name, with the model it stands for', () => {
    const own = catalog([{ value: 'opus', label: 'Opus', resolved: 'claude-opus-5-5' }, { value: 'claude-opus-5-5', label: 'Opus 5.5 (pinned)' }])
    expect(catalogLabel('claude-code', own.catalog!.models[0], own)).toBe('Opus (Opus 5.5 (pinned))')
    expect(chosenName('claude-code', 'opus', own)).toBe('Opus')
  })

  it('footers: the Assistant on "Opus" and an agent on the default both run Opus 5.5', () => {
    expect(agentModelShown('claude-code', 'opus', '', info)).toEqual({ label: 'Opus 5.5', chosenAs: 'Opus' })
    expect(agentModelShown('claude-code', 'inherit', '', info)).toEqual({ label: 'Opus 5.5 (default)', chosenAs: null })
    // Inherited from Hive's default, an alias.
    expect(agentModelShown('claude-code', 'inherit', 'sonnet', info)).toEqual({ label: 'Sonnet 5.5 (default)', chosenAs: 'Sonnet' })
    expect(agentModelShown('claude-code', 'claude-opus-4-8', '', info)).toEqual({ label: 'Opus 4.8', chosenAs: null })
    expect(effectiveModelLabel('claude-code', 'fable', '', info)).toBe('Fable 5.1')
  })

  it("the CLI's own default given as an alias (Claude Code's settings.json model: \"opus\") resolves too, still marked default", () => {
    const configured = { ...catalog(claude.models), defaultModel: 'opus' }
    expect(agentModelShown('claude-code', 'inherit', '', configured)).toEqual({ label: 'Opus 5.5 (default)', chosenAs: 'Opus' })
    expect(effectiveModelLabel('claude-code', undefined, '', configured)).toBe('Opus 5.5 (default)')
    // Not in the catalog (or no catalog): as named.
    expect(effectiveModelLabel('claude-code', 'inherit', '', { defaultModel: 'opus' })).toBe('Opus (default)')
  })

  it("HI-1996: a running session's footer shows its own launch's model and effort (settings changed since, an effort left out), never the settings as they are now", () => {
    const footer = (a: { model?: string; effort?: string }, live: Parameters<typeof footerChoices>[1]) => {
      const c = footerChoices(a, live)
      return { model: agentModelShown('claude-code', c.model, c.modelGlobal, info).label, effort: effortLabel('claude-code', undefined, c.effort, c.effortGlobal, 'medium') }
    }
    // Its connection's choice, changed to Haiku after it launched on Opus at high: still Opus at high, its own.
    expect(footer({ model: 'haiku', effort: 'low' }, { launchedWith: { model: 'opus', effort: 'high', own: true } })).toEqual({ model: 'Opus 5.5', effort: 'High' })
    // Its effort left out at launch (the model doesn't take it, HI-1770), though one is saved: the model's default.
    expect(footer({ effort: 'xhigh' }, { launchedWith: { model: 'opus', effort: null, own: true } }).effort).toBe('Medium (default)')
    // Launched with no model: its CLI's default, whatever its connection says now.
    expect(footer({ model: 'sonnet' }, { launchedWith: { model: null, effort: null } }).model).toBe('Opus 5.5 (default)')
  })

  it("HI-2398: a model its connection chose shows plainly before and after launch; \"(default)\" only when its CLI chooses", () => {
    const cx = { ...catalog(codex.models), defaultModel: 'gpt-6.1-sol' }
    const shown = (a: { model?: string; effort?: string }, live: Parameters<typeof footerChoices>[1], running?: string) => {
      const c = footerChoices(a, live)
      return agentModelShown('codex', c.model, c.modelGlobal, cx, running).label
    }
    // Two connections on one account: one with an explicit model, one with none.
    const astra = { model: 'gpt-6-astra' }
    const plain = {}
    // Before launch (the window's agent carries its connection's values, agentLaunchView).
    expect(shown(astra, null)).toBe('GPT-6 Astra')
    expect(shown(plain, null)).toBe('GPT-6.1 Sol (default)')
    // Launched (sessions.ts records it with launchedWithOf: a model given is its connection's), before and after the CLI reports it.
    expect(launchedWithOf('gpt-6-astra', 'high')).toEqual({ model: 'gpt-6-astra', effort: 'high', own: true })
    expect(launchedWithOf(null, null)).toEqual({ model: null, effort: null })
    expect(shown(astra, { launchedWith: launchedWithOf('gpt-6-astra', null) })).toBe('GPT-6 Astra')
    expect(shown(astra, { launchedWith: launchedWithOf('gpt-6-astra', null) }, 'gpt-6-astra')).toBe('GPT-6 Astra')
    expect(shown(plain, { launchedWith: launchedWithOf(null, null) })).toBe('GPT-6.1 Sol (default)')
    expect(shown(plain, { launchedWith: launchedWithOf(undefined, null) }, 'gpt-6.1-sol')).toBe('GPT-6.1 Sol (default)')
  })

  it('a running session shows the model it reports, whatever was chosen', () => {
    expect(agentModelShown('claude-code', 'opus', '', info, 'claude-opus-5-5')).toEqual({ label: 'Opus 5.5', chosenAs: 'Opus' })
    // The CLI picked another model than the alias resolved to when Hive last asked: the session says what runs.
    expect(agentModelShown('claude-code', 'opus', '', info, 'claude-opus-5-6')).toEqual({ label: 'Opus 5.6', chosenAs: 'Opus' })
    expect(agentModelShown('claude-code', 'inherit', '', info, 'claude-sonnet-5-5')).toEqual({ label: 'Sonnet 5.5 (default)', chosenAs: null })
  })

  it('never guesses: an alias the CLI does not list, or no catalog at all, shows as named', () => {
    expect(agentModelShown('claude-code', 'opus', '', null)).toEqual({ label: 'Opus', chosenAs: null })
    expect(agentModelShown('claude-code', 'opus[1m]', '', info)).toEqual({ label: 'Opus (1M)', chosenAs: null })
    expect(agentModelShown('claude-code', 'some-model', '', info)).toEqual({ label: 'some-model', chosenAs: null })
    expect(agentModelShown('claude-code', 'inherit', '', catalog(claude.models))).toEqual({ label: 'Claude Code default', chosenAs: null })
  })

  it('Codex reports no aliases: its names are unchanged', () => {
    const cx = catalog(codex.models)
    expect(modelGroups('codex', cx, null)[0].models[0]).toEqual({ value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' })
    expect(agentModelShown('codex', 'gpt-5.5', '', cx, 'gpt-5.5')).toEqual({ label: 'GPT-5.5', chosenAs: null })
  })
})

describe('codex debug models (0.160)', () => {
  it("lists its models in its order, gpt-6.1-sol first, without hidden ones", () => {
    expect(codex.models.map((m) => m.value)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'])
    expect(codex.models[0]).toMatchObject({ label: 'GPT-6.1 Sol', defaultEffort: 'low' })
  })

  it("per model: its own levels (Luna stops at max, GPT-5.5 at xhigh) and default effort", () => {
    const by = (v: string) => codex.models.find((m) => m.value === v)!
    expect(by('gpt-6.1-sol').efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(by('gpt-6-luna').efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(by('gpt-5.5')).toMatchObject({ efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' })
  })

  it('reads odd output defensively', () => {
    expect(parseCodexModels('﻿{"models":[{"slug":"a","supported_reasoning_levels":["low",{"effort":"high"},{}],"default_reasoning_level":"max","extra":true}]}')!.models).toEqual([{ value: 'a', label: 'a', efforts: ['low', 'high'] }])
    for (const bad of ['', 'not json', '{}', '{"models":{}}', '{"models":[{"visibility":"hide","slug":"x"}]}']) expect(parseCodexModels(bad)).toBeNull()
    // Levels all invalid, or not a list: unknown (the fallback applies), with no default; an empty list: none (review round 1).
    const r = parseCodexModels(JSON.stringify({ models: [{ slug: 'junk', supported_reasoning_levels: [null, 3, {}], default_reasoning_level: 'low' }, { slug: 'text', supported_reasoning_levels: 'high' }, { slug: 'none', supported_reasoning_levels: [] }] }))!
    expect(r.models).toEqual([{ value: 'junk', label: 'junk', defaultEffort: 'low' }, { value: 'text', label: 'text' }, { value: 'none', label: 'none', efforts: [] }])
    const own = settingsWith('codex', { effortFallback: [{ value: 'turbo', label: 'Turbo' }] })
    expect(modelCaps('codex', 'junk', catalog(r.models), own).efforts).toEqual([{ value: 'turbo', label: 'Turbo' }])
    expect(modelCaps('codex', 'none', catalog(r.models), own).efforts).toEqual([])
  })
})

describe('the pickers: the CLI is the source, the editable fallback otherwise', () => {
  it("offers the CLI's models when it answered, else the shipped list, else the user's edited one", () => {
    expect(modelGroups('claude-code', catalog(claude.models), null)[0].models.map((m) => m.value)).toContain('fable')
    // Without an answer: the descriptor's groups, as shipped.
    expect(modelGroups('codex', null, null).map((g) => g.label)).toEqual(['GPT-6.1', 'GPT-6', 'Older versions'])
    const edited = settingsWith('codex', { modelFallback: [{ value: 'gpt-7', label: 'GPT-7' }, { value: 'gpt-5.5', label: 'GPT-5.5', older: true }, { value: ' ', label: 'blank' }] })
    expect(modelGroups('codex', null, edited)).toEqual([
      { label: 'Codex models', models: [{ value: 'gpt-7', label: 'GPT-7' }] },
      { label: 'Older versions', older: true, models: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] }
    ])
    // The CLI's answer wins over an edited fallback.
    expect(modelGroups('codex', catalog(codex.models), edited)[0].models[0].value).toBe('gpt-6.1-sol')
    expect(fallbackModels('codex', edited).map((m) => m.value)).toEqual(['gpt-7', 'gpt-5.5'])
    expect(fallbackModels('codex', settingsWith('codex', { modelFallback: [] }))).toEqual(shippedModels('codex'))
  })

  it('says where the models come from', () => {
    expect(modelSourceText('claude-code', modelSource('claude-code', { catalog: { source: 'cli', version: '2.1.289', models: claude.models, at: '' } }, null))).toBe('From Claude Code 2.1.289')
    expect(modelSourceText('claude-code', modelSource('claude-code', { catalog: { source: 'cache', version: '2.1.289', models: claude.models, at: '' } }, null))).toMatch(/^From Claude Code 2\.1\.289 \(as it last said/)
    expect(modelSourceText('codex', modelSource('codex', null, null))).toBe("Fallback (Codex couldn't be asked)")
    expect(modelSourceText('codex', modelSource('codex', null, settingsWith('codex', { modelFallback: [{ value: 'x', label: 'x' }] })))).toMatch(/as you edited it/)
  })

  it("finds a model by alias, resolved id, date or 1M suffix", () => {
    const info = catalog(claude.models)
    expect(catalogModel(info, 'claude-fable-5-1')?.value).toBe('fable')
    expect(catalogModel(info, 'claude-haiku-4-5')?.value).toBe('haiku')
    expect(catalogModel(info, 'claude-opus-4-6[1m]')?.value).toBe('claude-opus-4-6')
    expect(catalogModel(info, 'OPUS')?.value).toBe('opus')
    expect(catalogModel(info, 'claude-unknown-9')).toBeUndefined()
  })

  it("effort pickers offer the selected model's levels; without the CLI's word, the fallback list", () => {
    const info = catalog(claude.models)
    expect(modelCaps('claude-code', 'claude-opus-4-6', info, null)).toMatchObject({ perModel: true, efforts: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'max', label: 'Max' }] })
    expect(modelCaps('claude-code', 'haiku', info, null)).toMatchObject({ perModel: true, efforts: [], supportsAuto: false, label: 'Haiku 4.5' })
    expect(modelCaps('codex', 'gpt-5.5', catalog(codex.models), null).efforts.map((e) => e.value)).toEqual(['low', 'medium', 'high', 'xhigh'])
    // No catalog, or a model it doesn't describe: the fallback, the user's edited one if any (with their names).
    expect(modelCaps('codex', 'gpt-x', null, null)).toMatchObject({ perModel: false, efforts: fallbackEfforts('codex', null) })
    const own = settingsWith('claude-code', { effortFallback: [{ value: 'low', label: 'Quick' }, { value: 'max', label: 'Deep' }] })
    expect(modelCaps('claude-code', 'claude-x', null, own).efforts).toEqual([{ value: 'low', label: 'Quick' }, { value: 'max', label: 'Deep' }])
    // The user's names apply to a model's own levels too.
    expect(modelCaps('claude-code', 'opus', info, own).efforts[0]).toEqual({ value: 'low', label: 'Quick' })
    // No model chosen: the CLI's default model's.
    expect(modelCaps('claude-code', null, { ...info, defaultModel: 'claude-opus-4-6' }, null).efforts.map((e) => e.value)).not.toContain('xhigh')
  })

  it("the model's default effort: the CLI's config, else its catalog, else the one seen in sessions; none without effort", () => {
    const info = { ...catalog(codex.models), observedEfforts: { 'claude-opus-5-5': 'high', 'gpt-5.5': 'max' } }
    expect(modelCaps('codex', 'gpt-6.1-sol', info, null).defaultEffort).toBe('low')
    expect(modelCaps('codex', 'gpt-6.1-sol', { ...info, configuredEffort: 'high' }, null).defaultEffort).toBe('high')
    expect(modelCaps('claude-code', 'opus', { ...catalog(claude.models), observedEfforts: { 'claude-opus-5-5': 'high' } }, null).defaultEffort).toBe('high')
    expect(modelCaps('claude-code', 'haiku', { ...catalog(claude.models), observedEfforts: { 'claude-haiku-4-5': 'high' } }, null).defaultEffort).toBeNull()
    expect(modelCaps('claude-code', 'opus', catalog(claude.models), null).defaultEffort).toBeNull()
    expect(effortText('codex', null, 'gpt-6-sol', catalog(codex.models), null)).toBe('Medium, default')
    expect(effortText('codex', 'high', 'gpt-6-sol', catalog(codex.models), null)).toBe('High')
    expect(effortText('codex', null, 'gpt-x', null, null)).toBe('default')
    // Whether that is the CLI's default unnamed (#885: the pickers then name the CLI, not "default").
    expect(effortUnknown('codex', null, 'gpt-x', null, null)).toBe(true)
    expect(effortUnknown('codex', 'inherit', 'gpt-6-sol', catalog(codex.models), null)).toBe(false)
    expect(effortUnknown('codex', 'high', 'gpt-x', null, null)).toBe(false)
    // What the effort lists call it: the CLI's default, once (#916).
    expect(cliDefaultEffort('claude-code', tr)).toBe("Claude Code's default")
    expect(cliDefaultEffort('codex', tr)).toBe("Codex's default")
  })

  it('the footer shows the default effort when nothing is set or reported', () => {
    expect(effortLabel('codex', undefined, 'inherit', '', 'medium')).toBe('Medium (default)')
    expect(effortLabel('codex', 'high', 'inherit', '', 'medium')).toBe('High')
    expect(effortLabel('codex', undefined, 'inherit', '', null)).toBeNull()
    // The user's names for the levels, as in the pickers: chosen, live, global and the default alike (#230); reset, Hive's.
    const named = settingsWith('codex', { effortFallback: [{ value: 'medium', label: 'Mid' }, { value: 'high', label: 'Deep' }] })
    expect(effortLabel('codex', undefined, 'inherit', '', 'medium', named)).toBe('Mid (default)')
    expect(effortLabel('codex', 'high', 'inherit', '', 'medium', named)).toBe('Deep')
    expect(effortLabel('codex', undefined, 'high', '', null, named)).toBe('Deep')
    expect(effortLabel('codex', undefined, 'inherit', 'medium', null, named)).toBe('Mid')
    expect(effortLabel('codex', undefined, 'inherit', '', 'medium', settingsWith('codex', {}))).toBe('Medium (default)')
    // The same name the pickers show for the same level.
    expect(modelCaps('codex', 'gpt-6-sol', catalog(codex.models), named).efforts.find((e) => e.value === 'high')?.label).toBe('Deep')
  })

  it("Auto's caveat follows what Claude Code says about the model, else the shipped guess", () => {
    expect(modeCaveat('claude-code', 'auto', 'haiku', { supportsAuto: false, label: 'Haiku 4.5' })).toBe("Claude Code doesn't offer Auto with Haiku 4.5: it runs in Manual instead (asking before edits and commands), and Combwork shows that mode.")
    expect(modeCaveat('claude-code', 'auto', 'haiku', { supportsAuto: true })).toBeNull()
    expect(modeCaveat('claude-code', 'auto', 'claude-newmodel', { supportsAuto: false, label: 'New 1' })).toMatch(/Auto with New 1/)
    expect(modeCaveat('claude-code', 'auto', 'haiku')).toMatch(/may not offer Auto with Haiku/)
    expect(modeCaveat('claude-code', 'manual', 'haiku', { supportsAuto: false })).toBeNull()
  })
})

describe('prices: editable defaults, with models added and removed', () => {
  it('a removed shipped price is gone from the table and the estimate; the user can add their own', () => {
    const s = settingsWith('codex', { prices: { 'gpt-7': { input: 1, cachedInput: 0.1, output: 2 } }, pricesRemoved: ['gpt-5.5'] })
    expect(modelPrice('codex', 'gpt-5.5', s)).toBeNull()
    expect(modelPrice('codex', 'gpt-7', s)).toMatchObject({ input: 1 })
    expect(modelPrice('codex', 'gpt-6.1-sol', s)).toMatchObject({ input: 2 })
    const rows = priceRows('codex', s)
    expect(rows.map((r) => r.model)).not.toContain('gpt-5.5')
    expect(rows.at(-1)).toMatchObject({ model: 'gpt-7', shipped: false, edited: true })
  })
})

describe("price tables follow the CLI's model list (#436)", () => {
  it("lists the CLI's models by the ids the table uses: an alias by the id it stands for, a dated id without its date", () => {
    const listed = listedPriceModels('claude-code', claude)!
    expect(listed).toContain('claude-opus-5-5')
    // haiku → claude-haiku-4-5-20251001 in this reply.
    expect(listed).toContain('claude-haiku-4-5')
    expect(listed).not.toContain('opus')
    expect(listedPriceModels('codex', null)).toBeNull()
  })

  // A CLI update adds a model Hive has no price for.
  const newer = { ...codex, models: [...codex.models, { value: 'gpt-reserve', label: 'GPT Reserve' }] }

  it('a listed model with no price is a row to enter one; a priced one the CLI no longer lists stays, marked', () => {
    expect(listedPriceModels('codex', codex)).not.toContain('gpt-reserve')
    const rows = priceRows('codex', settingsWith('codex', {}), listedPriceModels('codex', newer))
    expect(rows.find((r) => r.model === 'gpt-reserve')).toEqual({ model: 'gpt-reserve', price: null, shipped: false, edited: false, listed: true })
    expect(rows.find((r) => r.model === 'gpt-6.1-sol')).toMatchObject({ shipped: true, listed: true })
    expect(rows.find((r) => r.model === 'gpt-5.3-codex')).toMatchObject({ shipped: true, listed: false })
    // Each model once, the unpriced ones after the priced.
    expect(new Set(rows.map((r) => r.model)).size).toBe(rows.length)
    expect(rows.findIndex((r) => !r.price)).toBeGreaterThan(rows.findLastIndex((r) => r.price))
  })

  it("a price entered for a listed model makes it the user's row; without a list nothing is marked", () => {
    const s = settingsWith('codex', { prices: { 'gpt-reserve': { input: 1, cachedInput: 0.1, output: 2 } } })
    const rows = priceRows('codex', s, listedPriceModels('codex', newer))
    expect(rows.filter((r) => r.model === 'gpt-reserve')).toEqual([{ model: 'gpt-reserve', price: { input: 1, cachedInput: 0.1, output: 2 }, shipped: false, edited: true, listed: true }])
    expect(priceRows('codex', s).every((r) => r.listed === null && r.price)).toBe(true)
  })

  it("Claude Code's model removed by the user but still listed shows to enter a price again", () => {
    const rows = priceRows('claude-code', settingsWith('claude-code', { pricesRemoved: ['claude-opus-5-5'] }), listedPriceModels('claude-code', claude))
    expect(rows.filter((r) => r.model === 'claude-opus-5-5')).toEqual([{ model: 'claude-opus-5-5', price: null, shipped: false, edited: false, listed: true }])
  })

  it('the choice of cost source is only for a provider that reports its cost (the descriptor), and the report by default', () => {
    expect(usesOwnPrices('claude-code', settingsWith('claude-code', {}))).toBe(false)
    expect(usesOwnPrices('claude-code', settingsWith('claude-code', { costSource: 'prices' }))).toBe(true)
    expect(usesOwnPrices('copilot', settingsWith('copilot', { costSource: 'prices' }))).toBe(true)
    // Codex has no report: its table is the only source anyway, so there is no choice to make.
    expect(usesOwnPrices('codex', settingsWith('codex', { costSource: 'prices' }))).toBe(false)
  })
})

describe('config: the fallbacks store only the user’s edits, and Reset goes back to the defaults', () => {
  it('replaces a list, drops blank and repeated entries, and null resets it', () => {
    const was = structuredClone(config.settings.providers)
    try {
      let s = config.setProviderFallback('codex', 'models', [{ value: ' gpt-7 ', label: '', older: true }, { value: 'GPT-7', label: 'twice' }, { value: '', label: 'none' }])
      expect(s.providers.codex.modelFallback).toEqual([{ value: 'gpt-7', label: 'gpt-7', older: true }])
      s = config.setProviderFallback('codex', 'efforts', [{ value: 'low', label: 'Low' }])
      expect(s.providers.codex.effortFallback).toEqual([{ value: 'low', label: 'Low' }])
      s = config.setProviderFallback('codex', 'models', null)
      expect('modelFallback' in s.providers.codex).toBe(false)
      s = config.setProviderPrices('codex', {}, ['gpt-5.5', 'gpt-5.5'])
      expect(s.providers.codex.pricesRemoved).toEqual(['gpt-5.5'])
      s = config.setProviderPrices('codex', {}, [])
      expect('pricesRemoved' in s.providers.codex).toBe(false)
    } finally {
      config.settings.providers = was
    }
  })
})
