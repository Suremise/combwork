import type { OutgoingHttpHeaders } from 'http'
import type { AppUpdater } from 'electron-updater'
import type { CancellationToken, CustomPublishOptions } from 'builder-util-runtime'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider'
import { compareVersions } from '../shared/updates'

/**
 * Combwork's GitHub update feed (HI-2311). With pre-releases on, electron-updater (6.8.9, GitHubProvider.getLatestVersion)
 * takes the channel from the running version's pre-release id: a running `-rc.n` is only offered a later `-rc.n` (never
 * the release, and with no later RC it says no version is published), and a running `-beta.n` skips every RC. So a
 * pre-release install with Include pre-releases on is offered the newest version newer by semver instead, whichever
 * of beta, RC or release it is. A stable install, or pre-releases off, is electron-updater's own choice, unchanged.
 *
 * How: the tag is picked here from the releases feed, and electron-updater's own code runs on that feed with the picked
 * entry first and a view of the updater whose version has no pre-release part, so its "stable version, pre-releases on"
 * branch takes the first entry. The rest (the channel's .yml, falling back to latest.yml, notes, download paths) is its
 * code, unchanged. The view reaches only this provider: whether the pick is an update is the real updater's decision.
 */

/** The highest semver tag (a `v` prefix allowed), whether or not it's newer than the running version; null if none is. */
export function pickTag(tags: string[]): string | null {
  let best: string | null = null
  for (const t of tags) {
    if (compareVersions(t, '0.0.0') === null) continue
    if (best === null || (compareVersions(t, best) ?? 0) > 0) best = t
  }
  return best
}

const ENTRY = /<entry\b[\s\S]*?<\/entry>/g
const TAG = /\/tag\/(v?[^/]+)$/ // electron-updater's hrefRegExp

/** The feed's entries with their tags (null: no release link). */
function entriesOf(feed: string): { text: string; tag: string | null }[] {
  return (feed.match(ENTRY) ?? []).map((text) => {
    const href = /<link\b[^>]*\bhref="([^"]*)"/.exec(text)?.[1]
    return { text, tag: href ? (TAG.exec(href)?.[1] ?? null) : null }
  })
}

/** The feed with the entry for `tag` moved first. */
export function withFirst(feed: string, tag: string): string {
  const entries = entriesOf(feed)
  const picked = entries.find((e) => e.tag === tag)
  const first = entries[0]
  if (!picked || picked === first) return feed
  const at = feed.indexOf(first.text)
  const rest = feed.slice(at).replace(picked.text, '')
  return feed.slice(0, at) + picked.text + rest
}

const isPrerelease = (v: string): boolean => /^v?\d+\.\d+\.\d+-/.test(v)

export class CombworkGitHubProvider extends GitHubProvider {
  private readonly real: AppUpdater
  private readonly view: { on: boolean; version: string }
  /** While a pick is made: the feed already fetched, served again to electron-updater's code. */
  private feed: string | null = null

  /** From setFeedURL's custom options: the repository's owner and repo. */
  constructor(options: CustomPublishOptions, updater: AppUpdater, runtimeOptions: ProviderRuntimeOptions) {
    const view = { on: false, version: '' }
    const seen = new Proxy(updater, {
      get: (target, key) => {
        if (view.on && key === 'currentVersion') return view.version
        if (view.on && key === 'channel') return null
        return Reflect.get(target, key, target)
      }
    })
    super({ provider: 'github', owner: String(options.owner), repo: String(options.repo) }, seen, runtimeOptions)
    this.real = updater
    this.view = view
  }

  async getLatestVersion(): ReturnType<GitHubProvider['getLatestVersion']> {
    const current = this.real.currentVersion.version
    if (!this.real.allowPrerelease || !isPrerelease(current)) return super.getLatestVersion()
    const feed = await this.httpRequest(new URL(`/${this.options.owner}/${this.options.repo}/releases.atom`, this.baseUrl), { accept: 'application/xml, application/atom+xml, text/xml, */*' })
    const tag = feed ? pickTag(entriesOf(feed).flatMap((e) => (e.tag ? [e.tag] : []))) : null
    if (!feed || !tag) return super.getLatestVersion()
    this.feed = withFirst(feed, tag)
    this.view.version = current.replace(/-.*$/, '')
    this.view.on = true
    try {
      return await super.getLatestVersion()
    } finally {
      this.view.on = false
      this.feed = null
    }
  }

  protected httpRequest(url: URL, headers?: OutgoingHttpHeaders | null, cancellationToken?: CancellationToken): Promise<string | null> {
    if (this.feed !== null && url.pathname.endsWith('.atom')) return Promise.resolve(this.feed)
    return super.httpRequest(url, headers, cancellationToken)
  }
}
