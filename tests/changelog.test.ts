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

  // The same union merge keeps both wordings of a bullet reworded on two branches (HI-3036): two bullets with one bold
  // title in a section, the older wording beside the newer. And a release brought into the next version can leave a
  // released bullet under Unreleased too, where the next release would list it again.
  it('has no two bullets with the same bold title in one section', () => {
    expect(repeatedTitles(text)).toEqual([])
  })

  it('has no Unreleased bullet that a released version already lists', () => {
    expect(releasedAgain(text)).toEqual([])
  })

  it('catches both (HI-3036)', () => {
    const sample = ['## Unreleased', '', '### Fixed', '', '- **A** new.', '- **B** once.', '- **A** old.', '', '## 1.0.0 — 2026-01-01', '', '### Fixed', '', '- **A** new.', '- **C** same.', '', '### Added', '', '- **C** same.', ''].join('\n')
    expect(repeatedTitles(sample)).toEqual(['Unreleased › Fixed: A'])
    expect(releasedAgain(sample)).toEqual(['- **A** new.'])
  })
})

/** Each `## version › ### kind` section's bullets (nested ones too), trimmed, in order. */
function sections(md: string): { name: string; bullets: string[] }[] {
  const out: { name: string; bullets: string[] }[] = []
  let version = ''
  for (const line of md.split(/\r?\n/)) {
    const h2 = /^## (.*?)\s*$/.exec(line)
    const h3 = /^### (.*?)\s*$/.exec(line)
    if (h2) {
      version = h2[1].replace(/ — .*$/, '')
      out.push({ name: version, bullets: [] })
    } else if (h3) out.push({ name: `${version} › ${h3[1]}`, bullets: [] })
    else if (/^\s*- /.test(line) && out.length) out[out.length - 1].bullets.push(line.trim())
  }
  return out
}

/** Bold titles a section has more than once, as "section: title". */
function repeatedTitles(md: string): string[] {
  return sections(md).flatMap(({ name, bullets }) => {
    const titles = bullets.flatMap((b) => /^- \*\*(.+?)\*\*/.exec(b)?.[1] ?? [])
    return titles.filter((t, i) => titles.indexOf(t) !== i).map((t) => `${name}: ${t}`)
  })
}

/** Unreleased's bullets that a released version has word for word. */
function releasedAgain(md: string): string[] {
  const all = sections(md)
  const released = new Set(all.filter((s) => !s.name.startsWith('Unreleased')).flatMap((s) => s.bullets))
  return all.filter((s) => s.name.startsWith('Unreleased')).flatMap((s) => s.bullets.filter((b) => released.has(b)))
}
