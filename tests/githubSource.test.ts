// A card's GitHub source (HI-3551): what the user types read against the project's GitHub link (an address of its
// repository's pull request or issue, or #n; another host or repository refused), a saved source read back only when
// well formed, the label, the PR line's name, and when a PR can't take a push (a fork without maintainer edits).
import { describe, expect, it } from 'vitest'
import { cleanSource, clipBody, outsideAuthor, parseSourceRef, SOURCE_BODY_MAX, prLineName, prPushable, prRefs, sameSource, sourceLabel } from '../src/shared/githubSource'

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

describe('a pull request’s author and body (HI-3553)', () => {
  const pr = { kind: 'pr', host: 'github.com', owner: 'acme', repo: 'app', number: 7, url: 'u', title: 'T', pr: { headRef: 'f', baseRef: 'main', crossRepository: false, maintainerCanModify: true } }
  it('keeps the author and their standing when well formed', () => {
    expect(cleanSource({ ...pr, author: { login: 'mona', association: 'MEMBER' } })?.author).toEqual({ login: 'mona', association: 'MEMBER' })
    expect(cleanSource({ ...pr, author: { login: 'mona' } })?.author).toEqual({ login: 'mona', association: null })
    expect(cleanSource({ ...pr, author: { login: '' } })).not.toHaveProperty('author')
    expect(cleanSource({ ...pr, author: 'mona' })).not.toHaveProperty('author')
  })
  it('warns of a pull request or issue whose author isn’t one of the repository’s, or isn’t known to be', () => {
    const by = (association: string | null) => ({ kind: 'pr' as const, author: { login: 'x', association } })
    for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR', 'member']) expect(outsideAuthor(by(a))).toBeNull()
    for (const a of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN']) expect(outsideAuthor(by(a))).toBe('outside')
    expect(outsideAuthor(by(null))).toBe('unknown')
    expect(outsideAuthor({ kind: 'pr' })).toBe('unknown')
    // HI-3555: an issue's author the same way.
    expect(outsideAuthor({ kind: 'issue', author: { login: 'x', association: 'NONE' } })).toBe('outside')
    expect(outsideAuthor({ kind: 'issue', author: { login: 'x', association: 'MEMBER' } })).toBeNull()
  })
  it('keeps a body with \n line ends, no control characters but tab, and at most its limit', () => {
    expect(clipBody(' a\r\nb\rc\t\u001b[31md\u0000 ')).toBe('a\nb\nc\t[31md')
    expect(clipBody(null)).toBe('')
    const long = clipBody('x'.repeat(SOURCE_BODY_MAX + 50))
    expect(long).toHaveLength(SOURCE_BODY_MAX)
    expect(long.endsWith('…')).toBe(true)
    expect(clipBody('x'.repeat(SOURCE_BODY_MAX))).toBe('x'.repeat(SOURCE_BODY_MAX))
  })
})
