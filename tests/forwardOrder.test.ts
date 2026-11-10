// HI-2892 (SPEC §16.9): which way a forward merge goes on the release path, from the branches' names alone.
import { describe, expect, it } from 'vitest'
import { branchVersion, forwardDirection, forwardPermitted } from '../src/shared/workflow/forwardOrder'

describe('forwardDirection (HI-2892)', () => {
  it('two versions: older into newer is forward, newer into older backward', () => {
    expect(forwardDirection('1.4.0', '1.5.0', 'main')).toEqual({ dir: 'forward' })
    expect(forwardDirection('1.5.0', '1.4.0', 'main')).toEqual({ dir: 'backward', why: 'older' })
    expect(forwardDirection('1.9.0', '1.10.0', null)).toEqual({ dir: 'forward' })
    expect(forwardDirection('v2.0.0', 'release/1.10.3', null)).toEqual({ dir: 'backward', why: 'older' })
    // X.Y, as Start the next version names one (v2.1 → v2.2).
    expect(forwardDirection('v2.1', 'v2.2', 'main')).toEqual({ dir: 'forward' })
    expect(forwardDirection('1.5', '1.4.0', 'main')).toEqual({ dir: 'backward', why: 'older' })
  })

  it('prereleases by semver: an RC is older than its release', () => {
    expect(forwardDirection('1.5.0-rc.1', '1.5.0', null)).toEqual({ dir: 'forward' })
    expect(forwardDirection('1.5.0', '1.5.0-rc.1', null)).toEqual({ dir: 'backward', why: 'older' })
    expect(forwardDirection('1.5.0-rc.2', '1.5.0-rc.10', null)).toEqual({ dir: 'forward' })
  })

  it('the same version under two names is unknown, never "older"', () => {
    expect(forwardDirection('v1.4.0', 'release/1.4.0', null)).toEqual({ dir: 'unknown', why: 'sameVersion' })
    expect(forwardDirection('release/1.4.0', '1.4.0', 'main')).toEqual({ dir: 'unknown', why: 'sameVersion' })
    expect(forwardDirection('1.4', '1.4.0', 'main')).toEqual({ dir: 'unknown', why: 'sameVersion' })
  })

  it('the default branch into any other is forward; any other into it backward', () => {
    expect(forwardDirection('main', '1.5.0', 'main')).toEqual({ dir: 'forward' })
    expect(forwardDirection('main', 'next', 'main')).toEqual({ dir: 'forward' })
    expect(forwardDirection('1.5.0', 'main', 'main')).toEqual({ dir: 'backward', why: 'default' })
    expect(forwardDirection('hotfix', 'main', 'main')).toEqual({ dir: 'backward', why: 'default' })
  })

  it('no default branch named: main is only a name, so it orders nothing', () => {
    expect(forwardDirection('main', '1.5.0', null)).toEqual({ dir: 'unknown', why: 'unordered' })
    expect(forwardDirection('1.5.0', 'main', null)).toEqual({ dir: 'unknown', why: 'unordered' })
  })

  it('a pair the names don’t order is unknown (unrelated histories or not: names alone decide)', () => {
    expect(forwardDirection('develop', 'next', 'main')).toEqual({ dir: 'unknown', why: 'unordered' })
    expect(forwardDirection('1.4.0', 'next', 'main')).toEqual({ dir: 'unknown', why: 'unordered' })
    expect(forwardDirection('release/stable', 'release/next', 'main')).toEqual({ dir: 'unknown', why: 'unordered' })
  })

  it('branchVersion reads the whole name, else its last segment', () => {
    expect(branchVersion('1.4.0')).toBe('1.4.0')
    expect(branchVersion('v1.4.0')).toBe('v1.4.0')
    expect(branchVersion('release/1.4.0-rc.1')).toBe('1.4.0-rc.1')
    expect(branchVersion('release/next')).toBeNull()
    expect(branchVersion('1.4')).toBe('1.4.0')
    expect(branchVersion('v2.1')).toBe('v2.1.0')
    expect(branchVersion('1')).toBeNull()
  })

  it('only forward, or an override recorded, is permitted', () => {
    expect(forwardPermitted({ dir: 'forward' }, null)).toBe(true)
    expect(forwardPermitted({ dir: 'backward', why: 'older' }, null)).toBe(false)
    expect(forwardPermitted({ dir: 'unknown', why: 'unordered' }, undefined)).toBe(false)
    expect(forwardPermitted({ dir: 'backward', why: 'older' }, { by: 'assistant', dir: 'backward', why: 'older' })).toBe(true)
  })
})
