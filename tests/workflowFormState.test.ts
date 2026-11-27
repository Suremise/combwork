// The Workflow section's Save… (HI-3333): off only for a reason it says, "No changes to save" first, and a save's answer
// never drops an edit made while it ran (a preset used, a template or release offer laid over the draft).
import { describe, expect, it } from 'vitest'
import { afterSave, afterStale, loadedForm, rebaseDraft, saveOff } from '../src/renderer/src/components/workflowFormState'
import type { WorkflowForm } from '../src/shared/types'

const form = (preset: WorkflowForm['preset'], own: WorkflowForm['own']): WorkflowForm => ({ preset, own }) as WorkflowForm
const solo = form('solo', { maxAgents: 1 })
const pair = form('pair', { review: 'agent', maxAgents: 2 })

describe('a save’s answer (HI-3333)', () => {
  it('resets the draft to what was saved when nothing was edited meanwhile', () => {
    const now = { ...loadedForm('p', solo), draft: { preset: 'pair' as const, options: { ...pair.own } } }
    expect(afterSave(now, 'p', pair, false)).toEqual({ for: 'p', form: pair, draft: { preset: 'pair', options: { review: 'agent', maxAgents: 2 } } })
  })

  it('keeps an edit made while it ran, against the saved options', () => {
    const edited = { preset: 'team' as const, options: { review: 'agent' as const, maxAgents: 6 } }
    const r = afterSave({ for: 'p', form: solo, draft: edited }, 'p', pair, true)
    expect(r.form).toBe(pair)
    expect(r.draft).toEqual(edited)
  })

  it('never keeps another project’s draft, nor one with no form yet', () => {
    const other = { for: 'q', form: solo, draft: { preset: 'team' as const, options: {} } }
    expect(afterSave(other, 'p', pair, true)).toEqual(loadedForm('p', pair))
    expect(afterSave(null, 'p', pair, true)).toEqual(loadedForm('p', pair))
  })

  it('a draft read from a form is a copy of its own options', () => {
    const l = loadedForm('p', pair)
    expect(l.draft.options).toEqual(pair.own)
    expect(l.draft.options).not.toBe(pair.own)
  })
})

describe('a save found stale after moves made for it (HI-3592)', () => {
  const was = form('pair', { review: 'agent', maxAgents: 2, otherTargets: ['main', '1.1.0'], style: 'merge' })
  // The user took 1.1.0 out, raised Maximum agents and cleared Merge style; another window then set the style to squash
  // and the review to none, and chose another preset.
  const draft = { preset: 'pair' as const, options: { review: 'agent' as const, maxAgents: 4, otherTargets: ['main'] } }
  const now = form('team', { review: 'none', maxAgents: 2, otherTargets: ['main', '1.1.0'], style: 'squash' })

  it("keeps the user's own edits, laid over the options as they are now, never the old values of what changed elsewhere", () => {
    expect(rebaseDraft(was, draft, now)).toEqual({ preset: 'team', options: { review: 'none', maxAgents: 4, otherTargets: ['main'] } })
  })

  it('a preset the user chose is kept over the one chosen elsewhere', () => {
    expect(rebaseDraft(was, { ...draft, preset: 'solo' }, now).preset).toBe('solo')
  })

  it('the form is the options as they are now, the draft rebased onto them', () => {
    const r = afterStale('p', was, draft, now)
    expect(r.form).toBe(now)
    expect(r.for).toBe('p')
    expect(r.draft).toEqual(rebaseDraft(was, draft, now))
  })
})

describe('why Save… is off (HI-3333)', () => {
  const on = { dirty: true, settings: true, blocked: false, missingBranches: 0 }
  it('can be pressed with a change and nothing in the way', () => expect(saveOff(on)).toBeNull())
  it('says there is nothing to save first, whatever else holds', () => {
    expect(saveOff({ ...on, dirty: false })).toBe('noChanges')
    expect(saveOff({ dirty: false, settings: false, blocked: true, missingBranches: 2 })).toBe('noChanges')
  })
  it('then a contradiction, then a branch that doesn’t exist, then settings still loading', () => {
    expect(saveOff({ ...on, blocked: true, missingBranches: 1 })).toBe('blocked')
    expect(saveOff({ ...on, missingBranches: 1, settings: false })).toBe('missingBranches')
    expect(saveOff({ ...on, settings: false })).toBe('loading')
  })
})
