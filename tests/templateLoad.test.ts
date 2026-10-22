// The Load template dialog's detail (#268): same-name replacements marked, each new agent's settings in short (inherited
// ones as what they resolve to, marked "(default)"), each new worktree's branch and folder, and the setup command.
import { describe, expect, it } from 'vitest'
import { oldWorktreesNotice, templateAgentSettings, templateLoadDetail, templateLoadView } from '../src/shared/templateLoad'
import type { AppSettings, ProjectConfig } from '../src/shared/types'
import type { ModelInfo } from '../src/shared/models'

const cfg = { providers: {}, defaultProvider: undefined } as unknown as Pick<ProjectConfig, 'providers' | 'defaultProvider'>
const settings = { defaultProvider: 'claude-code', providers: { 'claude-code': { enabled: true, defaultModel: '', defaultEffort: '', defaultPermissionMode: 'default' } } } as unknown as AppSettings
const info: ModelInfo = { defaultModel: 'claude-opus-5-5', catalog: { source: 'cli', version: null, at: '', models: [{ value: 'opus', resolved: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }] } } as unknown as ModelInfo

describe('the Load template dialog (#268)', () => {
  it("shows a created agent's model, effort and mode; what it leaves to the defaults as what that is, marked", () => {
    const own = templateAgentSettings({ name: 'B', provider: 'claude-code', model: 'opus', effort: 'high', permissionMode: 'acceptEdits', worktree: false }, cfg, settings, info)
    expect(own).toMatch(/^Opus 5\.5 · High · \S.*$/)
    expect(own).not.toMatch(/default/)
    const inherited = templateAgentSettings({ name: 'R', provider: 'claude-code', worktree: false }, cfg, settings, info)
    expect(inherited.split(' · ')).toHaveLength(3)
    expect(inherited.split(' · ').every((part) => part.endsWith('(default)'))).toBe(true)
    expect(inherited).toMatch(/^Opus 5\.5 \(default\) · Medium \(default\)/)
  })

  it('marks a model the template leaves to a project that chose one as the default too (#310); one the agent chose, not', () => {
    const opusProject = { providers: { 'claude-code': { model: 'opus', effort: 'inherit', permissionMode: 'inherit', extraArgs: '' } }, defaultProvider: undefined } as unknown as Pick<ProjectConfig, 'providers' | 'defaultProvider'>
    expect(templateAgentSettings({ name: 'R', provider: 'claude-code', worktree: false }, opusProject, settings, info)).toMatch(/^Opus 5\.5 \(default\) · /)
    expect(templateAgentSettings({ name: 'B', provider: 'claude-code', model: 'opus', worktree: false }, opusProject, settings, info)).toMatch(/^Opus 5\.5 · /)
    // Nothing says which model: named as the CLI's default, once.
    const none = templateAgentSettings({ name: 'N', provider: 'claude-code', worktree: false }, cfg, settings, null)
    expect(none).toMatch(/^Claude Code default · /)
    expect(none).not.toMatch(/default \(default\)/)
  })

  it("marks agents a new one of the same name replaces, gives each new worktree's branch and folder, and the setup command", () => {
    const plan = {
      remove: [
        { id: 'a', name: 'Claude', running: false, dirty: 0, worktree: { path: 'D:/x/site/claude', branch: 'hive/claude' } },
        { id: 'b', name: 'Old', running: false, dirty: 0 }
      ],
      create: [
        { name: 'claude', role: 'builder', provider: 'claude-code' as const, worktree: true },
        { name: 'Reviewer', provider: 'claude-code' as const, worktree: false }
      ],
      worktrees: [{ branch: 'hive/claude-2', path: 'D:/x/site/claude-2', base: 'main' }, null],
      setup: 'npm install'
    }
    const text = templateLoadDetail(plan, cfg, settings, () => info)
    expect(text).toContain('• Claude (its worktree and branch hive/claude stay): replaced by a new agent with the same name')
    expect(text).toContain('• Old\n')
    expect(text).toMatch(/• claude — builder \(new\): Claude Code, Opus 5\.5 \(default\)/)
    expect(text).toContain('    own worktree on hive/claude-2 (from main) in D:/x/site/claude-2')
    expect(text).toMatch(/• Reviewer: Claude Code, [^\n]*\n\n/)
    expect(text).toContain("Each new worktree runs the project's setup command (npm install) before its agent first starts.")
    // No worktrees, or no setup command: no setup line.
    expect(templateLoadDetail({ ...plan, setup: null }, cfg, settings, () => info)).not.toContain('setup command')
    expect(templateLoadDetail({ ...plan, worktrees: [null, null] }, cfg, settings, () => info)).not.toContain('setup command')
    // #289: a worktree a created agent works in again goes on with it; a merged, clean one can be removed (the tick box);
    // one with unmerged work stays, saying why.
    const reuse = templateLoadDetail({ ...plan, worktrees: [{ branch: 'hive/claude', path: 'D:/x/site/claude', base: 'main', reuse: true }, null] }, cfg, settings, () => info)
    expect(reuse).toContain('• Claude (its worktree on hive/claude goes on with the new Claude): replaced by a new agent with the same name')
    expect(reuse).toContain('    reuses its worktree on hive/claude in D:/x/site/claude (clean; its branch is left as it is)')
    expect(reuse).not.toContain('setup command')
    const old = { ...plan, remove: [{ id: 'c', name: 'Codex', running: false, dirty: 0, worktree: { path: 'D:/x/site/codex', branch: 'hive/codex' } }, { id: 'd', name: 'Dev', running: false, dirty: 0, worktree: { path: 'D:/x/site/dev', branch: 'hive/dev' } }], mergedInto: 'main', oldWorktrees: [{ agent: 'Codex', path: 'D:/x/site/codex', branch: 'hive/codex', removable: true }, { agent: 'Dev', path: 'D:/x/site/dev', branch: 'hive/dev', removable: false, why: '2 commits not merged into main' }] }
    const both = templateLoadDetail(old, cfg, settings, () => info)
    expect(both).toContain('• Codex (its worktree and branch hive/codex, merged into main and clean, stay unless you tick below)')
    expect(both).toContain('• Dev (its worktree and branch hive/dev stay: 2 commits not merged into main)')
    expect(templateLoadDetail({ ...plan, worktrees: [{ branch: 'hive/claude-2', path: 'D:/x/site/claude-2', base: 'main', notReused: 'hive/claude has 1 uncommitted file' }, null] }, cfg, settings, () => info)).toContain('in D:/x/site/claude-2 (new: hive/claude has 1 uncommitted file)')
    // Nothing removed: no Removed list and nothing about removed agents.
    const fresh = templateLoadDetail({ ...plan, remove: [] }, cfg, settings, () => info)
    expect(fresh.startsWith('Created:')).toBe(true)
    expect(fresh).not.toMatch(/replaced|\(new\)|conversations stay/)
  })

  it("as a table (#511): each created agent in the template's order, its settings with the defaults marked, where it works", () => {
    const plan = {
      remove: [{ id: 'a', name: 'Claude', running: false, dirty: 0, worktree: { path: 'D:/x/site/claude', branch: 'hive/claude' } }],
      create: [
        { name: 'HB1', role: 'builder', provider: 'claude-code' as const, model: 'opus', worktree: true },
        { name: 'claude', provider: 'claude-code' as const, worktree: true },
        { name: 'HR1', provider: 'claude-code' as const, worktree: false }
      ],
      worktrees: [{ branch: 'hive/hb1', path: 'D:/x/site/hb1', base: 'main' }, { branch: 'hive/claude', path: 'D:/x/site/claude', base: 'main', reuse: true as const }, null],
      setup: null
    }
    const v = templateLoadView(plan, cfg, settings, () => info)
    expect(v.created.map((a) => a.name)).toEqual(['HB1', 'claude', 'HR1'])
    expect(v.created[0]).toMatchObject({ role: 'builder', replaces: false, providerName: 'Claude Code', model: { text: 'Opus 5.5', isDefault: false }, effort: { text: 'Medium', isDefault: true }, where: { kind: 'new', branch: 'hive/hb1', path: 'D:/x/site/hb1', base: 'main' } })
    expect(v.created[1]).toMatchObject({ replaces: true, model: { text: 'Opus 5.5', isDefault: true }, where: { kind: 'reuse', branch: 'hive/claude' } })
    expect(v.created[2].where).toEqual({ kind: 'folder' })
    // "(default)" is the view's to show, never in the text it shows.
    expect(v.created.every((a) => [a.model, a.effort, a.mode].every((x) => !x || !/default\)/.test(x.text)))).toBe(true)
    expect(v.removed).toEqual([{ name: 'Claude', note: 'its worktree on hive/claude goes on with the new Claude', replaced: true }])
    expect(v.notes).toEqual(["Their conversations stay in the Sessions tab, and their open cards go back (Active ones to Todo). The layout becomes the template's."])
  })

  it("the notice after removing old worktrees says what went whole, whose branch stayed and why, and what was kept (#313)", () => {
    expect(oldWorktreesNotice([])).toBeNull()
    expect(oldWorktreesNotice([{ branch: 'hive/a', removed: true }, { branch: 'hive/b', removed: true }])).toEqual({ level: 'success', title: 'Removed 2 old worktrees', detail: 'hive/a, hive/b, with their branches: merged and clean.' })
    // The folder went, the branch stayed: not "with its branch".
    const partly = oldWorktreesNotice([{ branch: 'hive/a', removed: true }, { branch: 'hive/b', removed: true, branchKept: true, why: 'main changed since it was checked' }])
    expect(partly).toEqual({ level: 'warning', title: "An old worktree's branch was kept", detail: 'Removed with its branch: hive/a.\nhive/b: its folder was removed, but the branch was kept (main changed since it was checked).' })
    expect(partly!.detail).not.toMatch(/hive\/b, with/)
    const mixed = oldWorktreesNotice([{ branch: 'hive/b', removed: true, branchKept: true }, { branch: 'hive/c', removed: false, why: 'an agent works in it now' }])
    expect(mixed).toEqual({ level: 'warning', title: 'An old worktree was kept', detail: 'hive/b: its folder was removed, but the branch was kept.\nhive/c: kept (an agent works in it now).' })
  })
})
