// CHANGELOG.md's sections (HI-2968). It merges with `merge=union` (.gitattributes), which keeps both sides of a
// conflicting hunk: bringing a release into the next version once left a second "## 1.3.0" holding the next version's
// unreleased notes, above 1.4.0, and the release would have renamed an Unreleased that lacked them. In check:repo, which
// every merge runs: one section per version, newest first, Unreleased (when there is one) above them all.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const text = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf8')
const headings = [...text.matchAll(/^## (.*?)\s*$/gm)].map((m) => m[1])
const versionOf = (h: string): string | null => /^(\d+\.\d+\.\d+)(?:\s|$)/.exec(h)?.[1] ?? null
const versions = headings.map(versionOf).filter((v): v is string => v !== null)
const parts = (v: string): number[] => v.split('.').map(Number)
const newer = (a: string, b: string): boolean => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

describe('CHANGELOG.md', () => {
  it('has a section for released versions', () => {
    expect(versions.length).toBeGreaterThan(0)
  })

  it('heads each section with Unreleased or a version', () => {
    expect(headings.filter((h) => h !== 'Unreleased' && !versionOf(h))).toEqual([])
  })

  it('has one section per version', () => {
    expect(versions.filter((v, i) => versions.indexOf(v) !== i)).toEqual([])
  })

  it('lists versions newest first', () => {
    expect(versions.filter((v, i) => i > 0 && !newer(versions[i - 1], v))).toEqual([])
  })

  it('has at most one Unreleased, above every version', () => {
    const at = headings.flatMap((h, i) => (h === 'Unreleased' ? [i] : []))
    expect(at.length).toBeLessThanOrEqual(1)
    if (at.length) expect(at[0]).toBe(0)
  })
})
