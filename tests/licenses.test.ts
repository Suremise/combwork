// THIRD_PARTY_NOTICES.md's text steps (scripts/licenseText.mjs): a build leaves an unchanged notice alone, whatever the
// line endings of the licence files it quotes or of the checkout (#148); and the committed file is up to date with what
// ships (#386), so a dependency change merged without `npm run licenses` fails here, in CI.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { licenceText, noticesDrift, noticesToWrite, staleNoticesMessage, toLf } from '../scripts/licenseText.mjs'
// @ts-expect-error: a plain .mjs module without types
import { generateNotices, repoWebUrl } from '../scripts/thirdPartyNotices.mjs'
import { tempDir } from './tempDir'

const repo = join(__dirname, '..')

describe('the notices text (scripts/licenseText.mjs)', () => {
  const lines = ['MIT License', '', 'Copyright (c) 2026 Someone', '', 'Permission is hereby granted…']

  it('quotes a licence file the same whether it has CRLF, LF, lone CR or mixed endings', () => {
    const want = lines.join('\n')
    for (const raw of [lines.join('\r\n'), lines.join('\n'), lines.join('\r'), `${lines[0]}\r\n${lines[1]}\n${lines[2]}\r${lines[3]}\r\n${lines[4]}\n`, `\r\n\n${lines.join('\r\n')}\r\n\r\n`])
      expect(licenceText(raw), JSON.stringify(raw.slice(0, 40))).toBe(want)
    expect(toLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  it('leaves the file alone when only line endings differ, as in a CRLF checkout of the LF file', () => {
    const text = `# Third-party notices\n\n${lines.join('\n')}\n`
    expect(noticesToWrite(text, text)).toBeNull()
    expect(noticesToWrite(text, text.replace(/\n/g, '\r\n'))).toBeNull()
    expect(noticesToWrite(text.replace(/\n/g, '\r\n'), text)).toBeNull()
  })

  it('writes a real change with the endings of the file on disk, and \\n for a new file', () => {
    const text = '# Third-party notices\n\n| react | 19.1.0 | MIT |\n'
    const old = '# Third-party notices\r\n\r\n| react | 19.0.0 | MIT |\r\n'
    expect(noticesToWrite(text, old)).toBe(text.replace(/\n/g, '\r\n'))
    expect(noticesToWrite(text, toLf(old))).toBe(text)
    expect(noticesToWrite(text, null)).toBe(text)
  })
})

describe('the committed notices are up to date (#386)', () => {
  it('THIRD_PARTY_NOTICES.md matches what scripts/licenses.mjs makes from the installed packages', () => {
    const { text } = generateNotices(repo)
    const drift = noticesDrift(text, readFileSync(join(repo, 'THIRD_PARTY_NOTICES.md'), 'utf8'))
    expect(drift && staleNoticesMessage(drift)).toBeNull()
  })

  it('finds a dependency whose version changed, one added and one gone, and says to regenerate', () => {
    const root = tempDir('cw-notices-')
    try {
      const pkg = (name: string, version: string, licence = 'MIT') => {
        mkdirSync(join(root, 'node_modules', name), { recursive: true })
        writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version, license: licence }))
        writeFileSync(join(root, 'node_modules', name, 'LICENSE'), `${licence} licence of ${name}\r\n`)
      }
      const deps = (names: string[]) => writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(names.map((n) => [n, '*'])) }))
      const notices = join(repo, 'scripts', 'notices')
      pkg('alpha', '1.0.0')
      pkg('gamma', '3.0.0')
      deps(['alpha', 'gamma'])
      const committed = generateNotices(root, notices).text.replace(/\n/g, '\r\n')
      expect(noticesDrift(generateNotices(root, notices).text, committed)).toBeNull()

      pkg('alpha', '1.1.0')
      pkg('beta', '2.0.0')
      deps(['alpha', 'beta'])
      const drift = noticesDrift(generateNotices(root, notices).text, committed)
      expect(drift).toEqual({ packages: ['alpha 1.0.0 → 1.1.0', 'gone: gamma 3.0.0', 'new: beta 2.0.0'] })
      expect(staleNoticesMessage(drift)).toBe(
        'THIRD_PARTY_NOTICES.md is out of date: run `npm run licenses` and commit it. Changed: alpha 1.0.0 → 1.1.0; gone: gamma 3.0.0; new: beta 2.0.0.'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails on a stale file whose packages are the same (a licence text changed), and on a missing file', () => {
    const text = '# Third-party notices\n\n| Package | Version | Licence |\n|---|---|---|\n| [react](https://github.com/facebook/react) | 19.1.0 | MIT |\n\nMIT licence\n'
    const drift = noticesDrift(text, text.replace('MIT licence', 'MIT licence, old'))
    expect(drift).toEqual({ packages: [] })
    expect(staleNoticesMessage(drift)).toBe('THIRD_PARTY_NOTICES.md is out of date: run `npm run licenses` and commit it.')
    expect(noticesDrift(text, null)).toEqual({ packages: ['new: react 19.1.0'] })
    expect(noticesDrift(text, text.replace(/\n/g, '\r\n'))).toBeNull()
  })
})

// Every package links to a web page (#788): npm's repository field has short and SSH forms that aren't links.
describe("the notices' links", () => {
  it('turns every repository form npm documents into an https:// page', () => {
    const cases: [string, string][] = [
      // The forms of the 11 packages whose links were broken, as their package.json files say them.
      ['formatjs/formatjs.git', 'https://github.com/formatjs/formatjs'], // @formatjs/fast-memoize
      ['git@github.com:formatjs/formatjs.git', 'https://github.com/formatjs/formatjs'], // @formatjs/intl, intl-messageformat
      ['nodeca/argparse', 'https://github.com/nodeca/argparse'],
      ['nodeca/js-yaml', 'https://github.com/nodeca/js-yaml'],
      ['git@github.com:jprichardson/node-jsonfile.git', 'https://github.com/jprichardson/node-jsonfile'],
      ['develar/lazy-val', 'https://github.com/develar/lazy-val'],
      ['lodash/lodash', 'https://github.com/lodash/lodash'], // lodash.escaperegexp, lodash.isequal
      ['vercel/ms', 'https://github.com/vercel/ms'],
      ['git+ssh://git@github.com/isaacs/sax-js.git', 'https://github.com/isaacs/sax-js'],
      // npm's other forms.
      ['github:owner/repo', 'https://github.com/owner/repo'],
      ['gitlab:owner/repo', 'https://gitlab.com/owner/repo'],
      ['bitbucket:owner/repo', 'https://bitbucket.org/owner/repo'],
      ['gist:11081aaa281', 'https://gist.github.com/11081aaa281'],
      ['git@gitlab.com:owner/repo.git', 'https://gitlab.com/owner/repo'],
      ['ssh://git@github.com/owner/repo.git', 'https://github.com/owner/repo'],
      ['git+https://github.com/owner/repo.git', 'https://github.com/owner/repo'],
      ['git://github.com/owner/repo.git', 'https://github.com/owner/repo'],
      ['https://github.com/owner/repo#readme', 'https://github.com/owner/repo'],
      ['https://github.com/owner/repo/', 'https://github.com/owner/repo'],
      ['http://example.org/project', 'https://example.org/project'],
      // npm's own examples of git URLs (docs.npmjs.com, package.json, "Git URLs as Dependencies"): the ssh path after a
      // colon or a slash, and a #commit-ish or #semver: range.
      ['git+ssh://git@github.com:npm/cli.git#v1.0.27', 'https://github.com/npm/cli'],
      ['git+ssh://git@github.com:npm/cli#semver:^5.0', 'https://github.com/npm/cli'],
      ['git+ssh://git@github.com/npm/cli.git', 'https://github.com/npm/cli'],
      // A numeric port stays.
      ['ssh://git@example.org:2222/owner/repo.git', 'https://example.org:2222/owner/repo'],
      ['https://example.org:8443/owner/repo', 'https://example.org:8443/owner/repo']
    ]
    for (const [value, want] of cases) expect(repoWebUrl(value), value).toBe(want)
    // Not a web page, or not a valid URL once normalised (a bad port or host).
    for (const value of ['', 'nonsense', 'file:../local', undefined, 'https://example.org:bad/repo', 'https://example.org:99999/repo', 'https://[invalid.host]/repo', 'https://localhost/repo'])
      expect(repoWebUrl(value), String(value)).toBeNull()
  })

  it("falls back to the homepage when the repository isn't a web page, else lists the name without a link", () => {
    const root = tempDir('cw-notices-links-')
    try {
      const pkg = (meta: Record<string, unknown>) => {
        const dir = join(root, 'node_modules', meta.name as string)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', license: 'MIT', ...meta }))
      }
      pkg({ name: 'home', repository: 'file:../somewhere', homepage: 'https://home.example.org/' })
      pkg({ name: 'badport', repository: { type: 'git', url: 'https://example.org:bad/repo' }, homepage: 'https://badport.example.org' })
      pkg({ name: 'bare', repository: 'nonsense', homepage: 'not a page' })
      pkg({ name: 'badhome', repository: 'nonsense', homepage: 'https://example.org:99999/home' })
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { home: '*', badport: '*', bare: '*', badhome: '*' } }))
      const { text } = generateNotices(root, join(repo, 'scripts', 'notices'))
      expect(text).toContain('| [home](https://home.example.org/) | 1.0.0 | MIT |')
      expect(text).toContain('| [badport](https://badport.example.org) | 1.0.0 | MIT |')
      expect(text).toContain('| bare | 1.0.0 | MIT |')
      expect(text).toContain('| badhome | 1.0.0 | MIT |')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the committed file links only to https:// pages', () => {
    const rows = readFileSync(join(repo, 'THIRD_PARTY_NOTICES.md'), 'utf8').split(/\r?\n/).filter((l) => l.startsWith('| ['))
    expect(rows.length).toBeGreaterThan(10)
    // Each link parses as an https:// URL to a named host (not merely starts with https://).
    const opens = (link: string): boolean => {
      try {
        const u = new URL(link)
        return u.protocol === 'https:' && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)
      } catch {
        return false
      }
    }
    const broken = rows.filter((l) => {
      const link = /^\| \[[^\]]+\]\(([^)\s]+)\)/.exec(l)?.[1]
      return !link || !opens(link)
    })
    expect(broken).toEqual([])
  })
})
