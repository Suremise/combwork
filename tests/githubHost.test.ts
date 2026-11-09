// The GitHub host settings (HI-2779, shared/githubHost.ts): what a host may be, the resolver's table (every row, each
// with inherited GH_HOST/COPILOT_GH_HOST that disagree, in mixed case), and the environment written for Copilot.
import { describe, expect, it } from 'vitest'
import { applyGithubHostChange, cleanGithubSettings, githubHostEnv, parseCopilotChoice, parseGithubHost, resolveGithubHosts } from '../src/shared/githubHost'

describe('a GitHub host', () => {
  it('is a host name, normalised, with its kind', () => {
    expect(parseGithubHost('github.com')).toEqual({ ok: true, host: 'github.com', kind: 'github' })
    expect(parseGithubHost('  Acme.GHE.com ')).toEqual({ ok: true, host: 'acme.ghe.com', kind: 'ghe-cloud' })
    expect(parseGithubHost('https://git.acme.example/')).toEqual({ ok: true, host: 'git.acme.example', kind: 'ghes' })
    expect(parseGithubHost('HTTPS://github.com')).toMatchObject({ ok: true, host: 'github.com' })
  })

  it('refuses credentials, paths, queries, ports and other schemes, saying which', () => {
    const reason = (v: unknown): unknown => {
      const p = parseGithubHost(v)
      return p.ok ? 'ok' : p.reason
    }
    expect(reason('')).toBe('empty')
    expect(reason('http://github.com')).toBe('scheme')
    expect(reason('ssh://git@github.com')).toBe('scheme')
    expect(reason('git@github.com')).toBe('credentials')
    expect(reason('https://user:ghp_secret@github.com')).toBe('credentials')
    expect(reason('https://github.com/acme/repo')).toBe('path')
    expect(reason('github.com/acme')).toBe('path')
    expect(reason('github.com?x=1')).toBe('query')
    expect(reason('github.com#top')).toBe('query')
    expect(reason('github.com:8443')).toBe('port')
    expect(reason('localhost')).toBe('invalid')
    expect(reason('10.0.0.1')).toBe('invalid')
    expect(reason('-bad.example')).toBe('invalid')
    expect(reason('bad_name.example')).toBe('invalid')
    expect(reason('//github.com')).toBe('scheme')
    expect(reason(42)).toBe('invalid')
  })

  it("takes a cloud host, 'repo' or the proxy for Copilot, never a GHES host", () => {
    expect(parseCopilotChoice('repo')).toEqual({ ok: true, value: 'repo' })
    expect(parseCopilotChoice('ghes-proxy')).toEqual({ ok: true, value: 'ghes-proxy' })
    expect(parseCopilotChoice('acme.ghe.com')).toEqual({ ok: true, value: 'acme.ghe.com', kind: 'ghe-cloud' })
    expect(parseCopilotChoice('git.acme.example')).toEqual({ ok: false, reason: 'notCloud' })
  })

  it('a change re-derives every stored value and refuses a bad one, naming the field', () => {
    expect(applyGithubHostChange(undefined, { host: 'https://Acme.ghe.com' })).toEqual({ ok: true, value: { host: 'acme.ghe.com', kind: 'ghe-cloud' } })
    expect(applyGithubHostChange({ host: 'acme.ghe.com', kind: 'ghe-cloud', copilotHost: 'repo' }, { copilotHost: null, host: null })).toEqual({ ok: true, value: {} })
    expect(applyGithubHostChange({}, { host: 'x@github.com' })).toEqual({ ok: false, field: 'host', reason: 'credentials' })
    expect(applyGithubHostChange({}, { copilotHost: 'git.acme.example' })).toEqual({ ok: false, field: 'copilotHost', reason: 'notCloud' })
  })

  it('reads a hand-edited file defensively: a kind is never taken from it', () => {
    expect(cleanGithubSettings({ host: 'acme.ghe.com', kind: 'github' })).toEqual({ host: 'acme.ghe.com', kind: 'ghe-cloud' })
    expect(cleanGithubSettings({ host: 'https://u:p@x.com' })).toBeUndefined()
    expect(cleanGithubSettings('nope')).toBeUndefined()
  })
})

describe('the resolver (its table, HR2’s design check on HI-2779)', () => {
  // Inherited host variables that disagree with every setting below, spelled as Windows lets them be.
  const conflicting = { gh_host: 'other.ghe.com', Copilot_Gh_Host: 'github.com', PATH: 'C:\\bin' }

  it('legacy: nothing set at either level, the environment decides as before, untouched', () => {
    const r = resolveGithubHosts(null, null, conflicting)
    expect(r).toMatchObject({ levelsSet: false, repo: { host: 'other.ghe.com', origin: 'environment' }, copilot: { host: 'github.com', origin: 'environment', choice: 'environment' } })
    expect(githubHostEnv(conflicting, r)).toEqual(conflicting)
    expect(resolveGithubHosts(null, null, { PATH: 'x' })).toMatchObject({ repo: { host: 'github.com', origin: 'default' }, copilot: { host: 'github.com', origin: 'default' } })
    // COPILOT_GH_HOST is Copilot's alone: it never moves the repositories' host.
    expect(resolveGithubHosts(null, null, { COPILOT_GH_HOST: 'acme.ghe.com' })).toMatchObject({ repo: { host: 'github.com', origin: 'default' }, copilot: { host: 'acme.ghe.com' } })
  })

  it('(a) the repo host set on a cloud host, no Copilot choice: Copilot signs in there, whatever was inherited', () => {
    const r = resolveGithubHosts({ host: 'tenant.ghe.com' }, null, conflicting)
    expect(r.copilot).toMatchObject({ host: 'tenant.ghe.com', kind: 'ghe-cloud', choice: 'inherit', origin: 'project' })
    expect(githubHostEnv(conflicting, r)).toEqual({ PATH: 'C:\\bin', GH_HOST: 'tenant.ghe.com', COPILOT_GH_HOST: 'tenant.ghe.com' })
    // From the workspace, the same.
    expect(resolveGithubHosts(null, { host: 'tenant.ghe.com' }, conflicting).copilot).toMatchObject({ host: 'tenant.ghe.com', origin: 'workspace' })
  })

  it('(b) the repo host set on GHES, no Copilot choice: a choice to make, never a cloud host from the environment', () => {
    const r = resolveGithubHosts({ host: 'git.acme.example' }, null, conflicting)
    expect(r.copilot).toMatchObject({ host: null, problem: 'chooseCopilotHost', choice: 'inherit' })
    // No host written, and the inherited ones removed: nothing signs Copilot in on a host the settings didn't choose.
    expect(githubHostEnv(conflicting, r)).toEqual({ PATH: 'C:\\bin' })
  })

  it('(c) an explicit Copilot host wins, at either level; the project’s over the workspace’s', () => {
    const r = resolveGithubHosts({ host: 'git.acme.example', copilotHost: 'acme.ghe.com' }, null, conflicting)
    expect(r).toMatchObject({ repo: { host: 'git.acme.example', kind: 'ghes' }, copilot: { host: 'acme.ghe.com', choice: 'host', origin: 'project' } })
    expect(githubHostEnv(conflicting, r)).toEqual({ PATH: 'C:\\bin', GH_HOST: 'git.acme.example', COPILOT_GH_HOST: 'acme.ghe.com' })
    expect(resolveGithubHosts({ host: 'git.acme.example' }, { copilotHost: 'github.com' }, conflicting).copilot).toMatchObject({ host: 'github.com', origin: 'workspace' })
    expect(resolveGithubHosts({ copilotHost: 'github.com' }, { copilotHost: 'acme.ghe.com' }, conflicting).copilot).toMatchObject({ host: 'github.com', origin: 'project' })
  })

  it("(d) 'repo' uses the project's own repo host, clearing a workspace's Copilot host", () => {
    const ws = { host: 'acme.ghe.com', copilotHost: 'acme.ghe.com' }
    const r = resolveGithubHosts({ host: 'github.com', copilotHost: 'repo' }, ws, conflicting)
    expect(r.copilot).toMatchObject({ host: 'github.com', choice: 'repo', origin: 'project' })
    expect(githubHostEnv(conflicting, r)).toEqual({ PATH: 'C:\\bin', GH_HOST: 'github.com', COPILOT_GH_HOST: 'github.com' })
    // 'repo' on a GHES host: still a choice to make.
    expect(resolveGithubHosts({ host: 'git.acme.example', copilotHost: 'repo' }, null, {}).copilot.problem).toBe('chooseCopilotHost')
  })

  it('a project inherits its workspace’s Copilot choice when it sets none', () => {
    const r = resolveGithubHosts({ host: 'git.acme.example' }, { copilotHost: 'acme.ghe.com' }, {})
    expect(r.copilot).toMatchObject({ host: 'acme.ghe.com', origin: 'workspace' })
  })

  it('only a Copilot choice set: the repo host still comes from GH_HOST, written back as it was', () => {
    const r = resolveGithubHosts(null, { copilotHost: 'acme.ghe.com' }, { GH_HOST: 'git.acme.example' })
    expect(r.repo).toMatchObject({ host: 'git.acme.example', origin: 'environment' })
    expect(githubHostEnv({ GH_HOST: 'git.acme.example' }, r)).toEqual({ GH_HOST: 'git.acme.example', COPILOT_GH_HOST: 'acme.ghe.com' })
  })

  it('the proxy: not supported yet, nothing written', () => {
    const r = resolveGithubHosts({ host: 'git.acme.example', copilotHost: 'ghes-proxy' }, null, conflicting)
    expect(r.copilot).toMatchObject({ host: null, problem: 'ghesProxyUnsupported', choice: 'proxy' })
    expect(githubHostEnv(conflicting, r)).toEqual({ PATH: 'C:\\bin' })
  })

  it('an unusable inherited host is ignored, not passed on as one', () => {
    expect(resolveGithubHosts(null, null, { GH_HOST: 'https://u:p@x.example/path' })).toMatchObject({ repo: { host: 'github.com', origin: 'default' } })
  })
})
