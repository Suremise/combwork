// A template's workflow (HI-1910): every option on one side of the split (rules carried, the project's own facts never),
// a section saved from options in force, read as untrusted (a section naming a target, commands or an identity carries
// none of them; one that can't be used is dropped and said, its sibling and the agents kept), and laid over another
// project's options (its own target, commands and identity kept; check names it has no command for flagged).
import { describe, expect, it } from 'vitest'
import { allOff, contradictions, FOCUSED_RUN, OPTION_TAKES, preset, type OptionKey, type WorkflowOptions } from '../src/shared/workflow/options'
import { carriedFor, overlayTemplateWorkflow, readTemplateWorkflow, readTemplateWorkflows, TEMPLATE_CARRIED, TEMPLATE_NOT_CARRIED, templateWorkflowOf, type WorkflowBase } from '../src/shared/workflow/templateOptions'
import { exportable, readTemplate, TEMPLATE_VERSION, isAgentTemplate } from '../src/shared/templates'
import { HIVE_TEMPLATES } from '../src/shared/templateDefaults'

/** A Git project's options: its own target, commands, identity and folders, and some rules. */
const projectA: WorkflowOptions = {
  ...preset('git', 'team', { quick: ['lint'], tests: ['unit'], commands: { lint: 'npm run lint', unit: 'npm test' }, identity: { name: 'A Person', email: 'a@example.com' }, target: 'stable-line' }),
  pushTarget: true,
  commitMessage: 'branch',
  excluded: ['dist'],
  stageNames: { review: 'Checking' },
  loopRounds: 4,
  fileLocks: 'block',
  sharedFolderWarning: false
}

describe('the split (HI-1910)', () => {
  it('puts every option on one side: the rules carried, the project’s own facts never', () => {
    const all = Object.keys(OPTION_TAKES).sort()
    const sides = [...TEMPLATE_CARRIED, ...TEMPLATE_NOT_CARRIED]
    expect(new Set(sides).size).toBe(sides.length)
    expect([...sides].sort()).toEqual(all)
    // HR5's OK on the design: how agents share a folder is a rule, carried.
    expect(TEMPLATE_CARRIED).toEqual(expect.arrayContaining(['sharedFolderWarning', 'fileLocks', 'stageNames', 'loopRounds', 'identity']))
    // HR4's OK (HI-1949): G20 is a rule, carried; its runner and picker are commands, never.
    expect(TEMPLATE_CARRIED).toContain('focusedTests')
    expect(TEMPLATE_NOT_CARRIED).toEqual(expect.arrayContaining(['target', 'targetOwn', 'pushTarget', 'commands', 'commitMessage', 'excluded']))
  })

  it('carries for each version control only what its form has: None has no merging, slots or reviewer pool', () => {
    expect(carriedFor('none')).not.toEqual(expect.arrayContaining(['finish']))
    for (const k of ['finish', 'style', 'folder', 'reviewerMode', 'mergeChecks', 'slotsUpToDate', 'identity'] as const) expect(carriedFor('none')).not.toContain(k)
    expect(carriedFor('none')).toEqual(expect.arrayContaining(['review', 'preChecks', 'dependenciesDone', 'fileLocks', 'stageNames']))
    expect(carriedFor('git')).toEqual([...TEMPLATE_CARRIED])
  })
})

describe("a section from a project's options", () => {
  it('keeps the rules and the preset, the identity as on, never the target, commands, its name and email or the folders', () => {
    const s = templateWorkflowOf(projectA, 'team')
    expect(s.preset).toBe('team')
    expect(s.options).toMatchObject({ review: 'agent', okBefore: { mode: 'labels', labels: ['ui', 'release'] }, preChecks: ['lint', 'unit'], mergeChecks: ['lint', 'unit'], identity: true, stageNames: { review: 'Checking' }, loopRounds: 4, fileLocks: 'block', sharedFolderWarning: false })
    const text = JSON.stringify(s)
    for (const fact of ['stable-line', 'npm run lint', 'npm test', 'A Person', 'a@example.com', 'dist', 'pushTarget', 'commitMessage', 'target', 'commands', 'excluded']) expect(text).not.toContain(fact)
    // A preset the version control doesn't offer isn't kept.
    expect(templateWorkflowOf(allOff('none'), 'pairAgent').preset).toBeNull()
  })
})

describe('a section read as untrusted', () => {
  const good = templateWorkflowOf(projectA, 'team')
  it('reads back what was saved', () => {
    expect(readTemplateWorkflow(JSON.parse(JSON.stringify(good)), 'git')).toEqual(good)
  })

  it('leaves out every option it never carries, however valid it looks: they never reach a project or an export', () => {
    const injected = { ...good, options: { ...good.options, target: 'evil', targetOwn: true, pushTarget: true, commands: { lint: 'rm -rf /' }, commitMessage: 'branch', excluded: ['src'], somethingNew: 1 } }
    const read = readTemplateWorkflow(injected, 'git')
    expect(read).toEqual(good)
  })

  it('refuses a section that can’t be used: a bad value, an identity that isn’t on or off, an option its version control lacks, a preset it doesn’t offer, a contradiction, stage names that can’t be saved', () => {
    const bad = (options: Record<string, unknown>, platform: 'git' | 'none' = 'git', chosen: unknown = null) => readTemplateWorkflow({ preset: chosen, options }, platform)
    expect(bad({ review: 'everyone' })).toBeNull()
    expect(bad({ identity: { name: 'Someone', email: 's@example.com' } })).toBeNull()
    expect(bad({ finish: 'hiveMerges' }, 'none')).toBeNull()
    expect(bad({}, 'none', 'pairAgent')).toBeNull()
    expect(bad({}, 'git', 'everything')).toBeNull()
    // Hive merges with everyone in the project folder: a contradiction (§16.5.4).
    expect(bad({ finish: 'hiveMerges', folder: 'project' })).toBeNull()
    expect(bad({ stageNames: { review: 'Todo' } })).toBeNull()
    expect(bad({ stageNames: { review: 'x'.repeat(40) } })).toBeNull()
    expect(readTemplateWorkflow('not a section', 'git')).toBeNull()
    expect(bad({ review: 'agent', noSelfReview: true }, 'none', 'pair')).toEqual({ preset: 'pair', options: { review: 'agent', noSelfReview: true } })
  })

  it('G20 (HI-1367): a section with focused tests on reads without a runner, the loading project’s own; every other contradiction still drops it', () => {
    const team = templateWorkflowOf(preset('git', 'team', { quick: ['lint'], tests: ['unit'], focused: { run: 'npm run focused', pick: 'npm run pick' } }), 'team')
    expect(team.options).toMatchObject({ focusedTests: true, finish: 'hiveMerges' })
    expect(JSON.stringify(team)).not.toContain('npm run')
    expect(readTemplateWorkflow(JSON.parse(JSON.stringify(team)), 'git')).toEqual(team)
    // Only the runner's contradiction is the loading project's: Hive merging with everyone in the project folder still drops it.
    expect(readTemplateWorkflow({ ...team, options: { ...team.options, folder: 'project' } }, 'git')).toBeNull()
    expect(readTemplateWorkflow({ preset: null, options: { focusedTests: true, finish: 'hiveMerges', folder: 'project' } }, 'git')).toBeNull()
    expect(readTemplateWorkflow({ preset: null, options: { focusedTests: 'yes' } }, 'git')).toBeNull()
    // None has no merging, so no G20: a None section naming it can't be used.
    expect(readTemplateWorkflow({ preset: null, options: { focusedTests: true } }, 'none')).toBeNull()
  })

  it('keeps a usable section beside one dropped, and says which was dropped', () => {
    const r = readTemplateWorkflows({ git: good, none: { preset: null, options: { finish: 'hiveMerges' } }, mercurial: good })
    expect(r.workflow).toEqual({ git: good })
    expect(r.dropped).toEqual(['none'])
  })

  it('a template file: its sections through the whitelist, a broken one dropped and said, its agents and other section kept; an export writes no more', () => {
    const raw = {
      version: TEMPLATE_VERSION,
      name: 'Imported',
      savedAt: '',
      layout: 'auto',
      agents: [{ name: 'B1', role: 'builder', provider: 'claude-code' }],
      workflow: { git: { ...good, options: { ...good.options, target: 'evil', commands: { lint: 'evil' } } }, none: { preset: null, options: { review: 'nobody' } } }
    }
    const t = readTemplate(raw)
    expect(isAgentTemplate(t)).toBe(true)
    if (!isAgentTemplate(t)) return
    expect(t.agents.map((a) => a.name)).toEqual(['B1'])
    expect(t.workflow).toEqual({ git: good })
    expect(t.workflowDropped).toEqual(['none'])
    const out = exportable({ ...t, workflow: { git: { ...good, options: { ...good.options, target: 'sneaked in' } as never } } })
    expect(out.workflow).toEqual({ git: good })
    // The rejected one written as rejected, by platform alone (HR5's round 1), never what it held.
    expect(out.workflowDropped).toEqual(['none'])
    expect(JSON.stringify(out)).not.toContain('nobody')
    // No usable section: no workflow written, the one it had said as rejected.
    const none = exportable({ ...t, workflow: { none: { preset: null, options: { review: 'nobody' } as never } }, workflowDropped: undefined })
    expect(['workflow' in none, none.workflowDropped]).toEqual([false, ['none']])
    // Read back (an import, a copy): still rejected, so never taken for no workflow.
    const again = readTemplate(JSON.parse(JSON.stringify(none)))
    expect(isAgentTemplate(again) && [again.workflow, again.workflowDropped]).toEqual([undefined, ['none']])
  })

  it('a workflow that isn’t one at all rejects both sections; a rejected mark where a usable section is now is dropped', () => {
    const base = { version: TEMPLATE_VERSION, name: 'Odd', savedAt: '', layout: 'auto', agents: [{ name: 'B1', role: 'builder', provider: 'claude-code' }] }
    const bogus = readTemplate({ ...base, workflow: 'bogus' })
    expect(isAgentTemplate(bogus) && [bogus.workflow, bogus.workflowDropped]).toEqual([undefined, ['none', 'git']])
    const marked = readTemplate({ ...base, workflow: { git: good }, workflowDropped: ['git', 'none', 'mercurial'] })
    expect(isAgentTemplate(marked) && [Object.keys(marked.workflow ?? {}), marked.workflowDropped]).toEqual([['git'], ['none']])
  })
})

describe("laid over another project's options", () => {
  const section = templateWorkflowOf(projectA, 'team')
  /** Project B: Git, its own target, commands for one of A's checks, its own identity and folders. */
  const bOptions: WorkflowOptions = { ...allOff('git'), target: 'main', commands: { lint: 'pnpm lint' }, excluded: ['build'], pushTarget: false, commitMessage: 'hive' }
  const base = (identity: WorkflowBase['identity']): WorkflowBase => ({ platform: 'git', options: bOptions, own: { target: 'main', commands: { lint: 'pnpm lint' } }, identity })

  it("sets the carried rules; B's target, commands, folders and merge message stay B's; a check B has no command for is flagged", () => {
    const o = overlayTemplateWorkflow(section, base({ name: 'B Person', email: 'b@example.com' }))
    expect(o.preset).toBe('team')
    expect(o.options).toMatchObject({ review: 'agent', okBefore: { mode: 'labels', labels: ['ui', 'release'] }, preChecks: ['lint', 'unit'], target: 'main', commands: { lint: 'pnpm lint' }, excluded: ['build'], pushTarget: false, commitMessage: 'hive' })
    expect(o.own).toMatchObject({ target: 'main', commands: { lint: 'pnpm lint' }, review: 'agent' })
    expect(o.missingCommands).toEqual(['unit'])
    // The identity on is B's own, never A's.
    expect(o.options.identity).toEqual({ name: 'B Person', email: 'b@example.com' })
    expect(o.identityOff).toBe(false)
    expect(o.changes.map((c) => c.key)).toEqual(expect.arrayContaining(['review', 'preChecks', 'identity', 'stageNames']))
    expect(o.changes.some((c) => (['target', 'commands', 'excluded'] as OptionKey[]).includes(c.key))).toBe(false)
  })

  it("HI-2269: G12 already on with a stale saved copy is no change, and its value now is git's identity now, never the copy", () => {
    const stale = { ...bOptions, identity: { name: 'Old Typo', email: 'typo@example.com' } }
    const live = { name: 'B Person', email: 'b@example.com' }
    // The template turns it on, as it is: not listed.
    const on = overlayTemplateWorkflow(section, { platform: 'git', options: stale, own: {}, identity: live })
    expect(on.changes.map((c) => c.key)).not.toContain('identity')
    // The template turns it off: listed, its value now git's identity, not the saved copy.
    const off = overlayTemplateWorkflow({ ...section, options: { ...section.options, identity: false } }, { platform: 'git', options: stale, own: {}, identity: live })
    expect(off.changes.find((c) => c.key === 'identity')).toEqual({ key: 'identity', now: live, next: null })
    // On with no identity in git now: just on.
    const none = overlayTemplateWorkflow({ ...section, options: { ...section.options, identity: false } }, { platform: 'git', options: stale, own: {}, identity: null })
    expect(none.changes.find((c) => c.key === 'identity')).toEqual({ key: 'identity', now: true, next: null })
    // Off now, turned on: its value next is git's identity.
    expect(overlayTemplateWorkflow(section, base(live)).changes.find((c) => c.key === 'identity')).toEqual({ key: 'identity', now: null, next: live })
  })

  it('G20 (HI-1949): its runner is flagged where B has none or a blank one, and B still can’t save until it is set; B’s own runner kept, nothing flagged', () => {
    const team = templateWorkflowOf(preset('git', 'team', { quick: [], tests: [], focused: { run: 'npm run focused' } }), 'team')
    const over = (commands: Record<string, string>) => overlayTemplateWorkflow(team, { platform: 'git', options: { ...bOptions, commands }, own: { commands }, identity: null })
    for (const commands of [{}, { [FOCUSED_RUN]: '  ' }] as Record<string, string>[]) {
      const o = over(commands)
      expect([o.options.focusedTests, o.missingCommands]).toEqual([true, [FOCUSED_RUN]])
      expect(contradictions(o.options)).toContain('focusedNeedsRunner')
    }
    const own = over({ [FOCUSED_RUN]: 'pnpm focused' })
    expect([own.options.commands[FOCUSED_RUN], own.missingCommands]).toEqual(['pnpm focused', []])
    expect(contradictions(own.options)).not.toContain('focusedNeedsRunner')
    // Off, or where Hive doesn't merge, it needs no runner: nothing flagged.
    expect(overlayTemplateWorkflow({ ...team, options: { ...team.options, focusedTests: false } }, { platform: 'git', options: bOptions, own: {}, identity: null }).missingCommands).toEqual([])
    expect(overlayTemplateWorkflow({ ...team, options: { ...team.options, finish: 'agentMerges' } }, { platform: 'git', options: bOptions, own: {}, identity: null }).missingCommands).toEqual([])
  })

  it('an identity on, where B has none in its git config: it stays off, and is said', () => {
    const o = overlayTemplateWorkflow(section, base(null))
    expect(o.options.identity).toBeNull()
    expect(o.identityOff).toBe(true)
  })

  it('a None section over a None project: only None’s rules', () => {
    const none = templateWorkflowOf({ ...preset('none', 'pair', { quick: ['lint'], tests: [] }) }, 'pair')
    const o = overlayTemplateWorkflow(none, { platform: 'none', options: allOff('none'), own: {}, identity: null })
    expect(o.options).toMatchObject({ platform: 'none', review: 'agent', finish: 'accept', folder: 'project', preChecks: ['lint'] })
    expect(o.missingCommands).toEqual(['lint'])
  })
})

describe("Hive's own templates' sections", () => {
  it('each carries its preset for None and Git, each usable as a file’s would be; Team 6 + pool its pool', () => {
    for (const h of HIVE_TEMPLATES) {
      const w = h.template.workflow!
      expect(w.none?.preset).toBe(h.template.suggestedPreset)
      expect(w.git?.preset).toBe(h.template.suggestedPreset)
      expect(readTemplateWorkflows(JSON.parse(JSON.stringify(w))).dropped).toEqual([])
    }
    expect(HIVE_TEMPLATES.find((h) => h.file === 'team-6-pool.json')!.template.workflow!.git!.options.reviewerMode).toBe('pool')
  })
})
