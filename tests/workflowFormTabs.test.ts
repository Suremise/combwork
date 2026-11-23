// The Workflow form's tabs (HI-3549): each group of options on one tab, in the agreed order for each version control,
// an option's tab found from its group (the check commands with the checks), and a link to an option or a tab asking
// the right form for it (the renderer store's `workflowFocus`, which the form reads to choose the tab and bring the
// option into view).
import { describe, expect, it } from 'vitest'
import { FORM_GROUPS, FORM_TABS, formTabOf, isFormTab, type FormTabId, type OptionKey } from '../src/shared/workflow/options'
import type { PlatformId } from '../src/shared/platform/descriptors'

;(globalThis as unknown as { window: unknown }).window = { combwork: { invoke: async () => null, on: () => () => {} }, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {} }) }
// The renderer's module, typed here by what the test uses: the main process's typecheck doesn't follow renderer code.
interface RendererStore {
  get: () => { workflowFocus: { at: string; option: OptionKey | null; tab?: FormTabId; n: number } | null; tabs: Record<string, string> }
  workflowFormAt: (at: string | { level: 'global' | 'workspace'; platform: PlatformId }) => string
  openWorkflowOption: (path: string, option: OptionKey | FormTabId) => void
  showWorkflowDefaults: (level: 'global' | 'workspace', option?: { key: OptionKey | FormTabId; platform: PlatformId }) => void
}
const rendererStore = '../src/renderer/src/store'
const store = (await import(/* @vite-ignore */ rendererStore)) as RendererStore

const PLATFORMS: PlatformId[] = ['git', 'none']

describe("the Workflow form's tabs (HI-3549)", () => {
  it('follow the agreed grouping: Overview first, None without Merging, Where or GitHub', () => {
    expect(FORM_TABS.git.map((t) => t.id)).toEqual(['overview', 'checks', 'merging', 'where', 'github', 'loops'])
    expect(FORM_TABS.none.map((t) => t.id)).toEqual(['overview', 'checks', 'work', 'loops'])
    expect(FORM_TABS.git.find((t) => t.id === 'checks')!.groups).toEqual(['team', 'review', 'checks'])
    expect(FORM_TABS.git.find((t) => t.id === 'loops')!.groups).toEqual(['loops', 'stages'])
  })

  it.each(PLATFORMS)('put each of %s’s groups on exactly one tab, in the groups’ order', (platform) => {
    const onTabs = FORM_TABS[platform].flatMap((t) => t.groups)
    expect(onTabs).toEqual(FORM_GROUPS[platform].map((g) => g.id))
  })

  it.each(PLATFORMS)('find a tab for every option of %s’s form, the one holding its group', (platform) => {
    for (const g of FORM_GROUPS[platform])
      for (const key of g.options) {
        const tab = formTabOf(platform, key)
        expect(tab, key).not.toBeNull()
        expect(FORM_TABS[platform].find((t) => t.id === tab)!.groups, key).toContain(g.id)
      }
  })

  it('place the options a link names where the card says', () => {
    expect(formTabOf('git', 'maxAgents')).toBe('checks')
    expect(formTabOf('git', 'mergeGuards')).toBe('checks')
    expect(formTabOf('git', 'commands')).toBe('checks')
    expect(formTabOf('git', 'target')).toBe('merging')
    expect(formTabOf('git', 'dependenciesDone')).toBe('merging')
    expect(formTabOf('git', 'fileLocks')).toBe('where')
    expect(formTabOf('git', 'stageNames')).toBe('loops')
    expect(formTabOf('none', 'dependenciesDone')).toBe('work')
    expect(formTabOf('none', 'fileLocks')).toBe('work')
    // An option a platform's form doesn't have has no tab there.
    expect(formTabOf('none', 'target')).toBeNull()
  })

  it('are told from options by name', () => {
    for (const t of [...FORM_TABS.git, ...FORM_TABS.none]) expect(isFormTab(t.id)).toBe(true)
    expect(isFormTab('maxAgents')).toBe(false)
    expect(isFormTab('review')).toBe(false)
  })
})

describe('a link to a workflow option (HI-3549)', () => {
  it("asks the project's form for the option, each link told apart", () => {
    store.openWorkflowOption('D:\\Work\\Alpha', 'maxAgents')
    const first = store.get().workflowFocus!
    expect(first).toMatchObject({ at: store.workflowFormAt('d:\\work\\alpha'), option: 'maxAgents' })
    store.openWorkflowOption('D:\\Work\\Alpha', 'maxAgents')
    expect(store.get().workflowFocus!.n).toBe(first.n + 1)
  })

  it('asks for a tab by its id, with no option to bring into view', () => {
    store.openWorkflowOption('D:\\Work\\Alpha', 'overview')
    expect(store.get().workflowFocus).toMatchObject({ option: null, tab: 'overview' })
  })

  it("asks a level's form for the platform the option is in, and chooses the level's tab", () => {
    store.showWorkflowDefaults('workspace', { key: 'loopWaitHours', platform: 'none' })
    expect(store.get().workflowFocus).toMatchObject({ at: store.workflowFormAt({ level: 'workspace', platform: 'none' }), option: 'loopWaitHours' })
    expect(store.get().tabs['settings.workflow']).toBe('workflow.workspaceDefaults')
    // A project's form and a level's are never the same form.
    expect(store.workflowFormAt({ level: 'global', platform: 'git' })).not.toBe(store.workflowFormAt('global'))
  })
})
