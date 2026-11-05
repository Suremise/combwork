// Per-project view preferences are saved one project at a time and merged into what is saved (#245), so a window's
// stale copy of a map can't drop another window's projects; values are cleaned and bounded.
import { describe, expect, it } from 'vitest'
import { MAX_PREF_PROJECTS, MAX_TREE_PREFS, isProjectPref, movedPrefKey, projectPrefValue, withProjectPref } from '../src/shared/uiPrefs'

describe('withProjectPref', () => {
  it("sets one project's value as the newest, keeping the others", () => {
    const saved = { a: 'codex', b: 'claude-code' }
    expect(withProjectPref(saved, 'a', 'claude-code')).toEqual({ b: 'claude-code', a: 'claude-code' })
    expect(Object.keys(withProjectPref(saved, 'a', 'claude-code'))).toEqual(['b', 'a'])
    expect(saved).toEqual({ a: 'codex', b: 'claude-code' })
  })

  it('forgets a project with null, and starts a map that is missing', () => {
    expect(withProjectPref({ a: 1, b: 2 }, 'a', null)).toEqual({ b: 2 })
    expect(withProjectPref(undefined, 'a', 1)).toEqual({ a: 1 })
  })

  it('keeps the most recently changed projects only', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_PREF_PROJECTS }, (_, i) => [`p${i}`, i]))
    const next = withProjectPref(many, 'new', -1)
    expect(Object.keys(next)).toHaveLength(MAX_PREF_PROJECTS)
    expect(next.p0).toBeUndefined()
    expect(next.new).toBe(-1)
  })
})

describe('projectPrefValue', () => {
  it('takes a known provider only for skillsProvider', () => {
    expect(projectPrefValue('skillsProvider', 'codex')).toBe('codex')
    expect(projectPrefValue('skillsProvider', 'no-such')).toBeUndefined()
    expect(projectPrefValue('skillsProvider', 3)).toBeUndefined()
  })

  it('keeps only the two booleans of skillsFold', () => {
    expect(projectPrefValue('skillsFold', { combwork: false, provider: true, extra: 1 })).toEqual({ combwork: false, provider: true })
    expect(projectPrefValue('skillsFold', { combwork: 'yes' })).toEqual({})
    expect(projectPrefValue('skillsFold', [true])).toBeUndefined()
    expect(projectPrefValue('skillsFold', null)).toBeUndefined()
  })

  it("keeps a Sessions tree's boolean branches, the newest MAX_TREE_PREFS", () => {
    expect(projectPrefValue('sessionsTree', { a: true, b: 'x', c: false })).toEqual({ a: true, c: false })
    const many = Object.fromEntries(Array.from({ length: MAX_TREE_PREFS + 5 }, (_, i) => [`k${i}`, true]))
    const kept = projectPrefValue('sessionsTree', many)!
    expect(Object.keys(kept)).toHaveLength(MAX_TREE_PREFS)
    expect(kept.k0).toBeUndefined()
  })

  it('keeps a folded project in the Assistant panel as true, nothing else', () => {
    expect(projectPrefValue('assistantFold', true)).toBe(true)
    expect(projectPrefValue('assistantFold', false)).toBeUndefined()
    expect(projectPrefValue('assistantFold', 'yes')).toBeUndefined()
  })

  it('knows which preferences are per project', () => {
    expect(projectPrefValue('combworkVcsNotice', 'none|OneDrive')).toBe('none|OneDrive')
    expect(projectPrefValue('combworkVcsNotice', 3)).toBeUndefined()
    expect(['skillsProvider', 'skillsFold', 'sessionsTree', 'combworkVcsNotice', 'assistantFold'].every(isProjectPref)).toBe(true)
    expect(isProjectPref('sidebarWidth')).toBe(false)
    expect(isProjectPref('tips')).toBe(false)
  })
})

describe("movedPrefKey (HI-2008: a moved workspace's view preferences)", () => {
  const from = String.raw`C:\Work\Demo`
  // With a trailing separator, as a folder can be given.
  const to = 'D:\\New\\Demo\\'
  it("puts a project's path, the Assistant's workspace|project and a pane's what:workspace at the new folder", () => {
    expect(movedPrefKey(String.raw`c:\work\demo\alpha`, from, to)).toBe(String.raw`d:\new\demo\alpha`)
    expect(movedPrefKey(String.raw`c:\work\demo|c:\work\demo\alpha`, from, to)).toBe(String.raw`d:\new\demo|d:\new\demo\alpha`)
    expect(movedPrefKey(String.raw`assistant-open:c:\work\demo`, from, to)).toBe(String.raw`assistant-open:d:\new\demo`)
    expect(movedPrefKey(String.raw`c:\work\demo`, from, to)).toBe(String.raw`d:\new\demo`)
  })
  it('a path counts only whole, and a key naming another folder or none is null', () => {
    expect(movedPrefKey(String.raw`c:\work\demo-two\alpha`, from, to)).toBeNull()
    expect(movedPrefKey(String.raw`assistant-open:c:\work\demob`, from, to)).toBeNull()
    expect(movedPrefKey(String.raw`c:\other\c:\work\demo`, from, to)).toBeNull()
    expect(movedPrefKey('table-rows:board', from, to)).toBeNull()
    expect(movedPrefKey('assistantTop', from, to)).toBeNull()
    expect(movedPrefKey(String.raw`c:\work\demo\alpha`, '', to)).toBeNull()
  })
})
