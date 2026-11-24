// A card's GitHub source (HI-3551): what the user types read against the project's GitHub link (an address of its
// repository's pull request or issue, or #n; another host or repository refused), a saved source read back only when
// well formed, the label, the PR line's name, and when a PR can't take a push (a fork without maintainer edits).
import { describe, expect, it } from 'vitest'
import { cleanSource, parseSourceRef, prLineName, prPushable, prRefs, sameSource, sourceLabel } from '../src/shared/githubSource'

const link = { host: 'github.com', owner: 'Acme', repo: 'App' }

describe("a card's GitHub source", () => {
  it('reads an address of the linked repository’s pull request or issue, or a number', () => {
    expect(parseSourceRef('https://github.com/acme/app/pull/12', link)).toEqual({ ref: link, number: 12, kind: 'pr' })
    expect(parseSourceRef('https://GitHub.com/Acme/App/issues/3#issuecomment-1', link)).toEqual({ ref: link, number: 3, kind: 'issue' })
    expect(parseSourceRef(' #42 ', link)).toEqual({ ref: link, number: 42, kind: null })
    expect(parseSourceRef('42', link)).toEqual({ ref: link, number: 42, kind: null })
  })
  it('refuses another repository or host, anything else, and any source without a link', () => {
    expect(parseSourceRef('https://github.com/other/app/pull/1', link)).toEqual({ error: 'otherRepo' })
    expect(parseSourceRef('https://tenant.ghe.com/acme/app/pull/1', link)).toEqual({ error: 'otherRepo' })
    expect(parseSourceRef('https://github.com/acme/app/commit/abc', link)).toEqual({ error: 'notGithub' })
    expect(parseSourceRef('fix the bug', link)).toEqual({ error: 'notGithub' })
    expect(parseSourceRef('#1', null)).toEqual({ error: 'noLink' })
    expect(parseSourceRef('https://github.com/acme/app/pull/1', null)).toEqual({ error: 'noLink' })
  })
  it('keeps a saved source only when well formed (a PR with its branches)', () => {
    const pr = { kind: 'pr', host: 'github.com', owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/pull/7', title: 'T', pr: { headRef: 'f', baseRef: 'main', crossRepository: true, maintainerCanModify: false } }
    expect(cleanSource(pr)).toEqual(pr)
    expect(cleanSource({ ...pr, pr: undefined })).toBeUndefined()
    expect(cleanSource({ ...pr, number: 0 })).toBeUndefined()
    expect(cleanSource({ ...pr, kind: 'issue', pr: undefined })).toMatchObject({ kind: 'issue', number: 7 })
    expect(cleanSource('nonsense')).toBeUndefined()
  })
  it('labels, names and compares PR cards, and says when a fork can’t take a push', () => {
    expect(sourceLabel('pr')).toBe('github-pr')
    expect(sourceLabel('issue')).toBe('github-issue')
    expect(prLineName('HI', 'HI-12', 7)).toBe('cw/HI/HI-12-pr-7')
    expect(prRefs(7)).toEqual({ head: 'refs/cw/pr/7/head', base: 'refs/cw/pr/7/base' })
    const a = { kind: 'pr' as const, host: 'GitHub.com', owner: 'acme', repo: 'APP', number: 7 }
    expect(sameSource(a, { ...a, host: 'github.com', repo: 'app' })).toBe(true)
    expect(sameSource(a, { ...a, number: 8 })).toBe(false)
    expect(prPushable({ kind: 'pr', pr: { headRef: 'f', baseRef: 'm', crossRepository: true, maintainerCanModify: false } })).toEqual({ ok: false, why: 'fork' })
    expect(prPushable({ kind: 'pr', pr: { headRef: 'f', baseRef: 'm', crossRepository: true, maintainerCanModify: true } })).toEqual({ ok: true })
    expect(prPushable({ kind: 'pr', pr: { headRef: 'f', baseRef: 'm', crossRepository: false, maintainerCanModify: false } })).toEqual({ ok: true })
  })
})
