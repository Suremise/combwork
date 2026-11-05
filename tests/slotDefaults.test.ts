// A Git project's copied files as they inherit (HI-1765): the project's own (`slots.copy`, or before 1.0 its
// `worktreeCopy`), its workspace's, Combwork's, then the built-in default. Left out inherits; an empty string is "none",
// kept at the level that set it.
import { describe, expect, it } from 'vitest'
import { slotCopyOf } from '../src/shared/slotDefaults'
import { SLOT_COPY_DEFAULT } from '../src/shared/defaults'

describe("a project's copied files and where they come from (slotCopyOf)", () => {
  const levels = { global: { copy: 'hive.env' }, workspace: { copy: 'ws.env' } }

  it('takes the nearest level that sets it: the project, its workspace, Combwork, then the default', () => {
    expect(slotCopyOf({ slots: { copy: 'p.env' }, worktreeCopy: 'old.env' }, levels)).toEqual({ value: 'p.env', origin: 'project' })
    // The project's own from before 1.0, after slots.copy.
    expect(slotCopyOf({ slots: {}, worktreeCopy: 'old.env' }, levels)).toEqual({ value: 'old.env', origin: 'project' })
    expect(slotCopyOf({ worktreeCopy: null }, levels)).toEqual({ value: 'ws.env', origin: 'workspace' })
    expect(slotCopyOf({ worktreeCopy: null }, { global: levels.global })).toEqual({ value: 'hive.env', origin: 'global' })
    expect(slotCopyOf({ worktreeCopy: null }, {})).toEqual({ value: SLOT_COPY_DEFAULT, origin: 'default' })
    expect(SLOT_COPY_DEFAULT).toBe('.env*')
  })

  it('keeps an explicit none at the level that set it, over the levels above', () => {
    expect(slotCopyOf({ slots: { copy: '' }, worktreeCopy: null }, levels)).toEqual({ value: '', origin: 'project' })
    expect(slotCopyOf({ worktreeCopy: '' }, levels)).toEqual({ value: '', origin: 'project' })
    expect(slotCopyOf({ worktreeCopy: null }, { ...levels, workspace: { copy: '' } })).toEqual({ value: '', origin: 'workspace' })
    expect(slotCopyOf({ worktreeCopy: null }, { global: { copy: '' }, workspace: {} })).toEqual({ value: '', origin: 'global' })
  })

  it("a level's own form (no project) inherits from the levels above it", () => {
    expect(slotCopyOf(null, { global: { copy: 'hive.env' } })).toEqual({ value: 'hive.env', origin: 'global' })
    expect(slotCopyOf(null, { global: null, workspace: null })).toEqual({ value: SLOT_COPY_DEFAULT, origin: 'default' })
  })
})
