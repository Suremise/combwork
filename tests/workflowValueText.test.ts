// HI-3620: a workflow option's value in words, as Save… lists what changes (from → to): an option left unset, such as
// Other branches work can merge into once its list is emptied, reads None, never "undefined".
import { describe, expect, it } from 'vitest'
import { optionValueText } from '../src/renderer/src/workflowValueText'

describe("an option's value in words (HI-3620)", () => {
  it('an emptied list of other branches reads None, as an empty one does', () => {
    expect(optionValueText('otherTargets', undefined, 'git')).toBe('None')
    expect(optionValueText('otherTargets', [], 'git')).toBe('None')
    expect(optionValueText('otherTargets', ['main', '1.2.0'], 'git')).toBe('main and 1.2.0')
  })

  it('any other option left unset reads None too, never "undefined" or "null"', () => {
    for (const v of [undefined, null]) {
      const said = optionValueText('commitMessage', v, 'git')
      expect(said).toBe('None')
    }
  })

  it('an unset Work merges into is still the default branch, and set values are as before', () => {
    expect(optionValueText('target', undefined, 'git')).toBe('The repository’s default branch')
    expect(optionValueText('target', '1.2.0', 'git')).toBe('1.2.0')
    expect(optionValueText('maxAgents', 4, 'git')).toBe('4')
    expect(optionValueText('noSelfReview', true, 'git')).toBe('On')
  })
})
