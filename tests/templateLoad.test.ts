// The Load template dialog's detail (#268): same-name replacements marked, each new agent's settings in short (inherited
// ones as what they resolve to, marked "(default)"), and (#1436) each one's role in the workflow, note, pairing and a
// provider swapped for one that can run here; every created agent works in the project folder.
import { describe, expect, it } from 'vitest'
import { roleShown, templateAgentSettings, templateLoadDetail, templateLoadView } from '../src/shared/templateLoad'
import type { AppSettings, ProjectConfig } from '../src/shared/types'
import type { ModelInfo } from '../src/shared/models'

const cfg = { providers: {}, defaultProvider: undefined } as unknown as Pick<ProjectConfig, 'providers' | 'defaultProvider'>
const settings = { defaultProvider: 'claude-code', providers: { 'claude-code': { enabled: true, defaultModel: '', defaultEffort: '', defaultPermissionMode: 'default' } } } as unknown as AppSettings
const info: ModelInfo = { defaultModel: 'claude-opus-5-5', catalog: { source: 'cli', version: null, at: '', models: [{ value: 'opus', resolved: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }] } } as unknown as ModelInfo

describe('the Load template dialog (#268)', () => {
  it("shows a created agent's model, effort and mode; what it leaves to the defaults as what that is, marked", () => {
    const own = templateAgentSettings({ name: 'B', role: 'builder', provider: 'claude-code', model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }, cfg, settings, info)
    expect(own).toMatch(/^Opus 5\.5 · High · \S.*$/)
    expect(own).not.toMatch(/default/)
    const inherited = templateAgentSettings({ name: 'R', role: 'reviewer', provider: 'claude-code' }, cfg, settings, info)
    expect(inherited.split(' · ')).toHaveLength(3)
    expect(inherited.split(' · ').every((part) => part.endsWith('(default)'))).toBe(true)
    expect(inherited).toMatch(/^Opus 5\.5 \(default\) · Medium \(default\)/)
  })

  it('marks a model the template leaves to a project that chose one as the default too (#310); one the agent chose, not', () => {
    const opusProject = { providers: { 'claude-code': { model: 'opus', effort: 'inherit', permissionMode: 'inherit', extraArgs: '' } }, defaultProvider: undefined } as unknown as Pick<ProjectConfig, 'providers' | 'defaultProvider'>
    expect(templateAgentSettings({ name: 'R', role: 'reviewer', provider: 'claude-code' }, opusProject, settings, info)).toMatch(/^Opus 5\.5 \(default\) · /)
    expect(templateAgentSettings({ name: 'B', role: 'builder', provider: 'claude-code', model: 'opus' }, opusProject, settings, info)).toMatch(/^Opus 5\.5 · /)
    // Nothing says which model: named as the CLI's default, once.
    const none = templateAgentSettings({ name: 'N', role: 'builder', provider: 'claude-code' }, cfg, settings, null)
    expect(none).toMatch(/^Claude Code default · /)
    expect(none).not.toMatch(/default \(default\)/)
  })

  it('marks agents a new one of the same name replaces, with each agent\'s role, pairing and a provider swapped; a removed worktree agent\'s worktree stays', () => {
    const plan = {
      remove: [
        { id: 'a', name: 'Claude', running: false, dirty: 0, worktree: { path: 'D:/x/site/claude', branch: 'hive/claude' } },
        { id: 'b', name: 'Old', running: false, dirty: 0 }
      ],
      create: [
        { name: 'claude', role: 'builder' as const, note: 'UI', provider: 'claude-code' as const },
        { name: 'Reviewer', role: 'reviewer' as const, provider: 'claude-code' as const }
      ],
      pairs: [{ builder: 0, reviewer: 1 }],
      swaps: [{ index: 1, from: 'codex' as const, to: 'claude-code' as const, problem: 'notInstalled' as const }]
    }
    const text = templateLoadDetail(plan, cfg, settings, () => info)
    expect(text).toContain('• Claude (its worktree and branch hive/claude stay): replaced by a new agent with the same name')
    expect(text).toContain('• Old\n')
    expect(text).toMatch(/• claude — Builder \(paired: Reviewer\) \(new\): Claude Code, Opus 5\.5 \(default\)/)
    expect(text).toMatch(/• Reviewer — Reviewer \(paired: claude\): Claude Code, [^\n]*\n {4}Codex isn’t installed: Claude Code instead\.\n\n/)
    // No worktree anywhere: nothing said of one for the created agents.
    expect(text).not.toMatch(/own worktree|reuses|setup command/)
    // Nothing removed: no Removed list and nothing about removed agents.
    const fresh = templateLoadDetail({ ...plan, remove: [] }, cfg, settings, () => info)
    expect(fresh.startsWith('Created:')).toBe(true)
    expect(fresh).not.toMatch(/replaced|\(new\)|conversations stay/)
    expect(roleShown({ role: 'either' })).toBe('Either')
  })

  it("as a table (#511): each created agent in the template's order, its role, note, pairing and settings with the defaults marked", () => {
    const plan = {
      remove: [{ id: 'a', name: 'Claude', running: false, dirty: 0, worktree: { path: 'D:/x/site/claude', branch: 'hive/claude' } }],
      create: [
        { name: 'HI-B1', role: 'builder' as const, note: 'UI', provider: 'claude-code' as const, model: 'opus' },
        { name: 'claude', role: 'either' as const, provider: 'claude-code' as const },
        { name: 'HI-R1', role: 'reviewer' as const, provider: 'claude-code' as const }
      ],
      pairs: [{ builder: 0, reviewer: 2 }],
      swaps: [{ index: 2, from: 'codex' as const, to: 'claude-code' as const, problem: 'off' as const }]
    }
    const v = templateLoadView(plan, cfg, settings, () => info)
    expect(v.created.map((a) => [a.name, a.role, a.note, a.pairedWith, a.swapped])).toEqual([
      ['HI-B1', 'builder', 'UI', 'HI-R1', undefined],
      ['claude', 'either', undefined, undefined, undefined],
      ['HI-R1', 'reviewer', undefined, 'HI-B1', 'Codex is turned off (Settings → Providers): Claude Code instead.']
    ])
    expect(v.created[0]).toMatchObject({ replaces: false, providerName: 'Claude Code', model: { text: 'Opus 5.5', isDefault: false }, effort: { text: 'Medium', isDefault: true } })
    expect(v.created[1]).toMatchObject({ replaces: true, model: { text: 'Opus 5.5', isDefault: true } })
    // "(default)" is the view's to show, never in the text it shows.
    expect(v.created.every((a) => [a.model, a.effort, a.mode].every((x) => !x || !/default\)/.test(x.text)))).toBe(true)
    expect(v.removed).toEqual([{ name: 'Claude', note: 'its worktree and branch hive/claude stay', replaced: true }])
    expect(v.notes).toEqual(["Their conversations stay in the Sessions tab, and their open cards go back (Active ones to Todo). The layout becomes the template's."])
  })
})
