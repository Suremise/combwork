// Combwork's GitHub update feed (HI-2311, src/main/updateFeed.ts): with Include pre-releases on, a pre-release install is
// offered the newest version newer by semver, whichever of beta, RC or release it is (electron-updater alone offers a
// running RC only a later RC, and a running beta never an RC). A stable install, or pre-releases off, is unchanged.
// The provider runs electron-updater's real code on a fake feed: nothing here reaches GitHub, and a URL the fake doesn't
// serve fails the test.
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'
import type { AppUpdater } from 'electron-updater'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider'
import { CombworkGitHubProvider, pickTag, withFirst } from '../src/main/updateFeed'

// The updater's version is a SemVer of electron-updater's own semver (a copy of its own, nested): another copy's isn't
// recognised as one, and reads as a stable version.
const { SemVer } = createRequire(createRequire(import.meta.url).resolve('electron-updater/out/providers/GitHubProvider'))('semver') as { SemVer: new (version: string) => unknown }

const BASE = 'https://github.com/Suremise/combwork/releases'

const entry = (tag: string): string =>
  `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><updated>2026-11-01T00:00:00Z</updated><link rel="alternate" type="text/html" href="${BASE}/tag/${tag}"/><title>Combwork ${tag}</title><content type="html">Notes of ${tag}</content></entry>`
const atom = (tags: string[]): string => `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><id>tag:github.com,2008:${BASE}</id><title>Release notes from combwork</title>${tags.map(entry).join('')}</feed>`
const yml = (tag: string): string => {
  const v = tag.replace(/^v/, '')
  return `version: ${v}\nfiles:\n  - url: Hive-Setup-${v}.exe\n    sha512: abc\n    size: 1\npath: Hive-Setup-${v}.exe\nsha512: abc\nreleaseDate: '2026-11-01T00:00:00.000Z'\n`
}

/** Checks `running` against a feed of `tags` (newest first, as GitHub lists them), with `latest` as releases/latest. */
async function check(running: string, tags: string[], opts: { prerelease?: boolean; latest?: string; upstream?: true } = {}) {
  const asked: string[] = []
  const unexpected: string[] = []
  const executor = {
    request: async (o: { protocol?: string; hostname?: string; path?: string }) => {
      const url = `${o.protocol}//${o.hostname}${o.path}`
      asked.push(url)
      if (url === `${BASE}.atom`) return atom(tags)
      if (url === `${BASE}/latest`) return JSON.stringify({ tag_name: opts.latest })
      const m = /\/download\/([^/]+)\/(latest|beta|rc|alpha)\.yml$/.exec(url)
      if (m && tags.includes(m[1])) {
        if (m[2] === 'latest') return yml(m[1])
        throw Object.assign(new Error(`404 ${url}`), { statusCode: 404 })
      }
      unexpected.push(url)
      throw new Error(`not served by the fake feed: ${url}`)
    }
  }
  const updater = { allowPrerelease: opts.prerelease ?? true, currentVersion: new SemVer(running), channel: null, fullChangelog: false } as unknown as AppUpdater
  const runtime = { isUseMultipleRangeRequest: false, platform: 'win32', executor } as never
  const provider = opts.upstream ? new GitHubProvider({ provider: 'github', owner: 'Suremise', repo: 'combwork' }, updater, runtime) : new CombworkGitHubProvider({ provider: 'custom', owner: 'Suremise', repo: 'combwork' } as never, updater, runtime)
  try {
    const info = await provider.getLatestVersion()
    return { version: info.version, tag: info.tag, notes: info.releaseNotes, asked, unexpected }
  } finally {
    expect(unexpected).toEqual([])
  }
}

describe('electron-updater alone (why Combwork has its own provider)', () => {
  it('offers a running RC no release, and a running beta no RC', async () => {
    // The release is skipped for the RC itself (up to date), or, with no RC in the feed, nothing is found at all.
    expect((await check('1.0.0-rc.2', ['v1.0.0', 'v1.0.0-rc.2'], { upstream: true })).version).toBe('1.0.0-rc.2')
    await expect(check('1.0.0-rc.2', ['v1.0.0'], { upstream: true })).rejects.toThrow(/No published versions/)
    expect((await check('1.0.0-beta.3', ['v1.0.0-rc.1', 'v1.0.0-beta.3'], { upstream: true })).version).toBe('1.0.0-beta.3')
  })
})

describe('a pre-release install with pre-releases on', () => {
  it('a running RC is offered the release (whichever order the feed lists them)', async () => {
    for (const tags of [['v1.0.0', 'v1.0.0-rc.2'], ['v1.0.0-rc.2', 'v1.0.0']]) {
      const r = await check('1.0.0-rc.2', tags)
      expect(r.version).toBe('1.0.0')
      expect(r.notes).toBe('Notes of v1.0.0')
      // The feed is read once, then the release's latest.yml.
      expect(r.asked).toEqual([`${BASE}.atom`, `${BASE}/download/v1.0.0/latest.yml`])
    }
  })

  it('a running beta is offered a newer RC, and the release once there is one', async () => {
    const rc = await check('1.0.0-beta.3', ['v1.0.0-rc.1', 'v1.0.0-beta.3'])
    expect(rc.version).toBe('1.0.0-rc.1')
    expect(rc.asked).toContain(`${BASE}/download/v1.0.0-rc.1/rc.yml`) // its channel's file, then latest.yml
    expect((await check('1.0.0-beta.3', ['v1.0.0', 'v1.0.0-rc.1', 'v1.0.0-beta.3'])).version).toBe('1.0.0')
  })

  it('a running RC is offered a later RC, and a newer beta over an older release', async () => {
    expect((await check('1.0.0-rc.2', ['v1.0.0-rc.3', 'v1.0.0-rc.2'])).version).toBe('1.0.0-rc.3')
    expect((await check('1.0.0-rc.2', ['v1.1.0-beta.1', 'v1.0.0', 'v1.0.0-rc.2'])).version).toBe('1.1.0-beta.1')
  })

  it('with nothing newer, the newest is found (the check says up to date, not that nothing was published)', async () => {
    const r = await check('1.0.0-rc.2', ['v1.0.0-rc.2', 'v1.0.0-rc.1', 'v0.9.3'])
    expect(r.version).toBe('1.0.0-rc.2')
  })
})

describe('unchanged: electron-updater chooses', () => {
  it('a stable install with pre-releases on takes the feed\'s first entry', async () => {
    expect((await check('1.0.0', ['v1.1.0-rc.1', 'v1.0.1'])).version).toBe('1.1.0-rc.1')
  })

  it('pre-releases off: releases/latest, even on a pre-release install', async () => {
    const r = await check('1.0.0-rc.2', ['v1.0.1-rc.1', 'v1.0.0'], { prerelease: false, latest: 'v1.0.0' })
    expect(r.version).toBe('1.0.0')
    expect(r.asked).toContain(`${BASE}/latest`)
  })
})

describe('pickTag and withFirst', () => {
  it('picks the highest semver tag, skipping what isn\'t a version', () => {
    expect(pickTag(['v1.0.0-rc.9', 'v1.0.0', 'v1.0.0-beta.12'])).toBe('v1.0.0')
    expect(pickTag(['v1.0.0-beta.3', 'v1.0.0-rc.1'])).toBe('v1.0.0-rc.1')
    expect(pickTag(['v1.0.0-rc.10', 'v1.0.0-rc.9'])).toBe('v1.0.0-rc.10')
    expect(pickTag(['nightly', 'v0.9.3'])).toBe('v0.9.3')
    expect(pickTag(['nightly'])).toBeNull()
    expect(pickTag([])).toBeNull()
  })

  it('moves the picked entry first and keeps the rest', () => {
    const feed = atom(['v1.0.0-rc.2', 'v1.0.0', 'v0.9.3'])
    expect(withFirst(feed, 'v1.0.0')).toBe(atom(['v1.0.0', 'v1.0.0-rc.2', 'v0.9.3']))
    expect(withFirst(feed, 'v1.0.0-rc.2')).toBe(feed)
    expect(withFirst(feed, 'v2.0.0')).toBe(feed)
  })
})
