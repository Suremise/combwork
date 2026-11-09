// Copilot's sign-in per GitHub host (HI-2779), on fakes of gh and Copilot that record their arguments and environment:
// the real check code (hosts.ts, install.ts, models.ts) runs them as it runs the real CLIs, and each case asserts exactly
// what each fake was started with. No real gh or Copilot, no token, no sign-in: `copilot login` is only built, never run.
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveGithubHosts, type GithubHostSettings } from '../src/shared/githubHost'
import { checkRoutes, contextKey, hostEvidence, newGeneration, routeOf, withModels, type CopilotRoute, type HostCheckDeps, readCliConfig } from '../src/main/providers/copilot/hosts'
import { copilotLoginCommand, ghHostStatus, hostCatalogsOf, primaryContext, primaryModels } from '../src/main/providers/copilot/install'
import { signInSnapshot } from '../src/main/providers/copilot/hosts'
import { cachedCatalogFor, infoAt, modelGroups } from '../src/shared/models'
import type { AgentInstallInfo, ModelCatalog } from '../src/shared/types'
import { askCopilotModels, modelEnablement } from '../src/main/providers/copilot/models'
import { run } from '../src/main/providers/common'
import { tempDir } from './tempDir'

const windows = process.platform === 'win32'
const base = tempDir('cw-copilot-hosts-')
const nodeDir = dirname(process.execPath)

/** A fake CLI: a one-line .cmd running a Node script that logs its argv and the host and token variables it got. */
function fake(name: string, body: string): string {
  const script = join(base, `${name}.cjs`)
  writeFileSync(
    script,
    `const fs = require('fs')
const seen = (k) => (process.env[k] === undefined ? undefined : /TOKEN/.test(k) ? 'set' : process.env[k])
const keys = ['GH_HOST', 'COPILOT_GH_HOST', 'COPILOT_HOME', 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_AUTO_UPDATE', 'COPILOT_OFFLINE']
const env = Object.fromEntries(keys.map((k) => [k, seen(k)]).filter(([, v]) => v !== undefined))
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cli: ${JSON.stringify(name)}, argv: process.argv.slice(2), env }) + '\\n')
${body}
`
  )
  const cmd = join(base, `${name}.cmd`)
  writeFileSync(cmd, `@node "%~dp0${name}.cjs" %*\r\n`)
  return cmd
}

// gh: prints `auth status --json hosts` for exactly the --hostname asked (as gh does), from FAKE_GH (a JSON file of hosts).
const GH = fake(
  'gh',
  `const args = process.argv.slice(2)
const host = args[args.indexOf('--hostname') + 1]
if (process.env.FAKE_GH_MODE === 'hang') setTimeout(() => {}, 60000)
else {
  const all = JSON.parse(fs.readFileSync(process.env.FAKE_GH, 'utf8'))
  process.stdout.write(JSON.stringify({ hosts: all[host] ? { [host]: all[host] } : {} }))
}`
)

// copilot --acp: answers initialize, then session/new by FAKE_COPILOT_MODE.
const COPILOT = fake(
  'copilot',
  `const mode = process.env.FAKE_COPILOT_MODE || 'ok'
const model = (id, en) => ({ modelId: id, name: id, _meta: en === undefined ? {} : { copilotEnablement: en } })
const lists = {
  ok: [model('gpt-5', 'enabled'), model('claude-sonnet-5.5', 'enabled')],
  denied: [model('gpt-5', 'disabled'), model('claude-sonnet-5.5', 'unconfigured')],
  mixed: [model('gpt-5', 'disabled'), model('claude-sonnet-5.5')],
  none: [model('gpt-5'), model('claude-sonnet-5.5')],
  partial: [model('gpt-5', 'enabled'), model('claude-opus-5.5', 'disabled')],
  // byhost: each host's own models, default and availability (HR2's round 1: two contexts that differ).
  byhost: process.env.COPILOT_GH_HOST === 'tenant.ghe.com' ? [model('tenant-only-model', 'enabled'), model('gpt-5', 'disabled')] : [model('gpt-5', 'enabled'), model('public-only-model', 'enabled')]
}
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    const say = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...o }) + '\\n')
    if (mode === 'hang') continue
    if (m.method === 'initialize') say({ result: { protocolVersion: 1 } })
    else if (m.method === 'session/new') {
      if (mode === 'error') say({ error: { code: -32000, message: 'Authentication failed: the token was rejected' } })
      else if (mode === 'malformed') say({ result: { nothing: true } })
      else say({ result: { sessionId: 'not-a-uuid', models: { availableModels: lists[mode], currentModelId: lists[mode][0].modelId } } })
    }
  }
})`
)

/** What the fakes logged, and a fresh log. */
let log = ''
const logged = (): { cli: string; argv: string[]; env: Record<string, string> }[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
let n = 0
function freshLog(): string {
  log = join(base, `log-${++n}.jsonl`)
  return log
}

/** gh's state per host, as `gh auth status --json hosts` reports it. */
function ghState(hosts: Record<string, { login: string; state: string; error?: string }>): string {
  const f = join(base, `gh-${++n}.json`)
  writeFileSync(f, JSON.stringify(Object.fromEntries(Object.entries(hosts).map(([h, v]) => [h, [{ active: true, host: h, ...v, tokenSource: 'keyring' }]]))))
  return f
}

/** A Copilot home with config.json's stored logins (Copilot 1.0.93's shape). */
function copilotHome(users: { host: string; login: string }[] = []): string {
  const home = tempDir('cw-copilot-home-')
  writeFileSync(join(home, 'config.json'), `// User settings belong in settings.json.\n${JSON.stringify({ loggedInUsers: users })}\n`)
  return home
}

/** The base environment a check starts from: only what the fakes need, never this shell's. */
function baseEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: nodeDir, SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', COPILOT_HOME: home, FAKE_LOG: log, ...extra }
}

/** The real deps on the fakes: gh with a short timeout, the listing with a short one too. */
function deps(): HostCheckDeps {
  return {
    executable: COPILOT,
    version: '1.0.106',
    ghStatus: (host, env) => ghHostStatus(host, env, (_f, args, _t, e) => run(GH, args, 4000, e)),
    cliConfig: readCliConfig,
    models: (env) => askCopilotModels(COPILOT, env, 8000)
  }
}

/** A route for a project's and its workspace's settings. */
function route(project: GithubHostSettings | null, workspace: GithubHostSettings | null, env: Record<string, string>, paths: string[] = []): CopilotRoute {
  return { ...routeOf(resolveGithubHosts(project, workspace, env), env), usedBy: [{ workspace: 'ws', projects: project ? ['app'] : [] }], paths }
}

async function check(r: CopilotRoute) {
  const out = await checkRoutes([r], deps())
  expect(out).not.toBeNull()
  return out![0]
}

afterEach(() => newGeneration())

describe.runIf(windows)('Copilot on each GitHub host, on fake gh and Copilot', { timeout: 60000 }, () => {
  it('github.com: a stored login is configured; the listing proves models, not identity', async () => {
    freshLog()
    const home = copilotHome([{ host: 'https://github.com', login: 'octo' }])
    const c = await check(route(null, null, baseEnv(home)))
    expect(c).toMatchObject({ host: 'github.com', repoHost: 'github.com', origin: 'default', state: 'configured', source: 'Copilot login', account: 'octo', models: { available: 2, unavailable: 0, metadata: 'all' } })
    const calls = logged()
    // Copilot's own order: a stored login comes before gh, so gh isn't asked.
    expect(calls.map((x) => x.cli)).toEqual(['copilot'])
    expect(calls[0].argv).toEqual(['--acp', '--no-auto-update'])
    // Legacy: nothing set, so no host variable is written.
    expect(calls[0].env).toEqual({ COPILOT_HOME: home, COPILOT_AUTO_UPDATE: 'false' })
  })

  it('nothing chooses a host: Copilot’s last stored login counts on its own host, as before (legacy)', async () => {
    freshLog()
    const home = copilotHome([{ host: 'https://acme.ghe.com', login: 'dev' }])
    const c = await check(route(null, null, baseEnv(home)))
    expect(c).toMatchObject({ host: 'acme.ghe.com', origin: 'default', state: 'configured', source: 'Copilot login', account: 'dev' })
    // A host chosen in the environment is a choice: then only a login on that host counts.
    newGeneration()
    expect(await check(route(null, null, baseEnv(home, { COPILOT_GH_HOST: 'github.com' })))).toMatchObject({ host: 'github.com', state: 'installed' })
  })

  it('tenant.ghe.com: gh is asked for exactly that host, its success verifies gh’s identity there; Sign in is login --host', async () => {
    freshLog()
    const home = copilotHome()
    const env = baseEnv(home, { FAKE_GH: ghState({ 'tenant.ghe.com': { login: 'mona', state: 'success' }, 'github.com': { login: 'other', state: 'success' } }) })
    const r = route({ host: 'tenant.ghe.com' }, null, env)
    const c = await check(r)
    expect(c).toMatchObject({ host: 'tenant.ghe.com', repoHost: 'tenant.ghe.com', origin: 'project', state: 'verified', source: 'GitHub CLI', account: 'mona' })
    const calls = logged()
    expect(calls.map((x) => x.cli)).toEqual(['gh', 'copilot'])
    expect(calls[0].argv).toEqual(['auth', 'status', '--active', '--hostname', 'tenant.ghe.com', '--json', 'hosts'])
    expect(calls[0].env).toEqual({ GH_HOST: 'tenant.ghe.com', COPILOT_GH_HOST: 'tenant.ghe.com', COPILOT_HOME: home })
    expect(calls[1].env).toEqual({ GH_HOST: 'tenant.ghe.com', COPILOT_GH_HOST: 'tenant.ghe.com', COPILOT_HOME: home, COPILOT_AUTO_UPDATE: 'false' })
    // Sign in on that host: `copilot login --host`, in the route's environment (built, never run).
    const login = copilotLoginCommand(COPILOT, 'tenant.ghe.com', [r])
    expect(login.args.slice(-3)).toEqual(['login', '--host', 'tenant.ghe.com'])
    expect(login.env).toMatchObject({ GH_HOST: 'tenant.ghe.com', COPILOT_GH_HOST: 'tenant.ghe.com', COPILOT_HOME: home })
    expect(copilotLoginCommand(COPILOT, undefined, [r]).args.slice(-1)).toEqual(['login'])
  })

  it('a GHES repository with cloud Copilot: GH_HOST stays the repository host, COPILOT_GH_HOST the Copilot host', async () => {
    freshLog()
    const home = copilotHome([{ host: 'https://acme.ghe.com', login: 'dev' }])
    const c = await check(route({ host: 'git.acme.example' }, { copilotHost: 'acme.ghe.com' }, baseEnv(home, { GH_HOST: 'stale.example', copilot_gh_host: 'github.com' })))
    expect(c).toMatchObject({ host: 'acme.ghe.com', repoHost: 'git.acme.example', origin: 'workspace', state: 'configured', account: 'dev' })
    expect(logged()[0].env).toEqual({ GH_HOST: 'git.acme.example', COPILOT_GH_HOST: 'acme.ghe.com', COPILOT_HOME: home, COPILOT_AUTO_UPDATE: 'false' })
  })

  it('a GHES repository with no Copilot host: a choice to make, and nothing is started', async () => {
    freshLog()
    const c = await check(route({ host: 'git.acme.example' }, null, baseEnv(copilotHome())))
    expect(c).toMatchObject({ host: null, repoHost: 'git.acme.example', state: 'chooseHost' })
    expect(logged()).toEqual([])
    const proxy = await check(route({ host: 'git.acme.example', copilotHost: 'ghes-proxy' }, null, baseEnv(copilotHome())))
    expect(proxy.state).toBe('proxyUnsupported')
  })

  it('no github.com fallback after an explicit enterprise failure: gh’s error on the host is unverified, with its words', async () => {
    freshLog()
    const env = baseEnv(copilotHome(), { FAKE_GH: ghState({ 'tenant.ghe.com': { login: 'mona', state: 'error', error: 'HTTP 401: Bad credentials (https://api.tenant.ghe.com/)' }, 'github.com': { login: 'octo', state: 'success' } }) })
    const c = await check(route({ host: 'tenant.ghe.com' }, null, env))
    expect(c).toMatchObject({ host: 'tenant.ghe.com', state: 'unverified', diagnostic: 'HTTP 401: Bad credentials (https://api.tenant.ghe.com/)' })
    expect(c.account).toBe('mona')
    // One gh call, for that host only; no listing, no other host.
    expect(logged().map((x) => [x.cli, x.argv.includes('--hostname') ? x.argv[x.argv.indexOf('--hostname') + 1] : ''])).toEqual([['gh', 'tenant.ghe.com']])
  })

  it('a network or TLS failure is unverified too, with its own words (never taken for a rejected token)', async () => {
    freshLog()
    const env = baseEnv(copilotHome(), { FAKE_GH: ghState({ 'tenant.ghe.com': { login: 'mona', state: 'error', error: 'x509: certificate signed by unknown authority' } }) })
    const c = await check(route({ host: 'tenant.ghe.com' }, null, env))
    expect(c).toMatchObject({ state: 'unverified', diagnostic: 'x509: certificate signed by unknown authority' })
  })

  it('gh with no login on the host is not signed in, even when it has one on github.com', async () => {
    freshLog()
    const env = baseEnv(copilotHome([{ host: 'https://github.com', login: 'octo' }]), { FAKE_GH: ghState({ 'github.com': { login: 'octo', state: 'success' } }) })
    const c = await check(route({ host: 'tenant.ghe.com' }, null, env))
    expect(c).toMatchObject({ host: 'tenant.ghe.com', state: 'installed', source: null })
  })

  it('gh hanging: connectivity unknown', async () => {
    freshLog()
    const env = baseEnv(copilotHome(), { FAKE_GH: ghState({}), FAKE_GH_MODE: 'hang' })
    const c = await check(route({ host: 'tenant.ghe.com' }, null, env))
    expect(c.state).toBe('unknown')
  })

  it('an invalid token: set, so configured, and the listing’s error makes it unverified with Copilot’s words', async () => {
    freshLog()
    const c = await check(route(null, { host: 'tenant.ghe.com' }, baseEnv(copilotHome(), { COPILOT_GITHUB_TOKEN: 'not-a-real-token', FAKE_COPILOT_MODE: 'error' })))
    expect(c).toMatchObject({ state: 'unverified', source: 'COPILOT_GITHUB_TOKEN', diagnostic: 'Authentication failed: the token was rejected' })
    const calls = logged()
    expect(calls.map((x) => x.cli)).toEqual(['copilot'])
    expect(calls[0].env).toEqual({ GH_HOST: 'tenant.ghe.com', COPILOT_GH_HOST: 'tenant.ghe.com', COPILOT_HOME: expect.any(String), COPILOT_GITHUB_TOKEN: 'set', COPILOT_AUTO_UPDATE: 'false' })
  })

  it('a denied model and a policy: all disabled is denied; mixed or missing metadata is unknown entitlement', async () => {
    const token = { COPILOT_GITHUB_TOKEN: 'x' }
    freshLog()
    expect(await check(route({ host: 'tenant.ghe.com' }, null, baseEnv(copilotHome(), { ...token, FAKE_COPILOT_MODE: 'denied' })))).toMatchObject({ state: 'denied', models: { available: 0, unavailable: 2, metadata: 'all' } })
    newGeneration()
    expect(await check(route({ host: 'tenant.ghe.com' }, null, baseEnv(copilotHome(), { ...token, FAKE_COPILOT_MODE: 'mixed' })))).toMatchObject({ state: 'configured', models: { metadata: 'some' } })
    newGeneration()
    expect(await check(route({ host: 'tenant.ghe.com' }, null, baseEnv(copilotHome(), { ...token, FAKE_COPILOT_MODE: 'none' })))).toMatchObject({ state: 'configured', models: { available: 2, metadata: 'none' } })
    newGeneration()
    // One model denied: offered apart, as unavailable, and the host isn't denied.
    expect(await check(route({ host: 'tenant.ghe.com' }, null, baseEnv(copilotHome(), { ...token, FAKE_COPILOT_MODE: 'partial' })))).toMatchObject({ state: 'configured', models: { available: 1, unavailable: 1, metadata: 'all' } })
  })

  it('a timeout or a malformed listing: unknown, never signed in or out', async () => {
    freshLog()
    const hang = await checkRoutes([route({ host: 'tenant.ghe.com' }, null, baseEnv(copilotHome(), { COPILOT_GITHUB_TOKEN: 'x', FAKE_COPILOT_MODE: 'hang' }))], { ...deps(), models: (env) => askCopilotModels(COPILOT, env, 1500) })
    expect(hang![0].state).toBe('unknown')
    newGeneration()
    expect((await check(route({ host: 'tenant.ghe.com' }, null, baseEnv(copilotHome(), { COPILOT_GITHUB_TOKEN: 'x', FAKE_COPILOT_MODE: 'malformed' })))).state).toBe('unknown')
  })

  it('BYOK or offline: no GitHub sign-in needed, neither signed out nor verified', async () => {
    freshLog()
    const c = await check(route(null, null, baseEnv(copilotHome(), { COPILOT_OFFLINE: 'true' })))
    expect(c).toMatchObject({ state: 'noSignIn', source: 'local model' })
  })

  it('a host change: a new route key, and a late answer of the old generation is dropped', async () => {
    freshLog()
    const env = baseEnv(copilotHome(), { COPILOT_GITHUB_TOKEN: 'x' })
    const before = route(null, { host: 'github.com' }, env)
    const after = route(null, { host: 'tenant.ghe.com' }, env)
    expect(before.key).not.toBe(after.key)
    // The old check is still waiting on its listing when the host changes.
    let release: () => void = () => {}
    const slow: HostCheckDeps = { ...deps(), models: (e) => new Promise((r) => (release = () => void askCopilotModels(COPILOT, e, 8000).then(r))) }
    const old = checkRoutes([before], slow)
    newGeneration()
    const now = await checkRoutes([after], deps())
    release()
    expect(await old).toBeNull()
    expect(now![0]).toMatchObject({ host: 'tenant.ghe.com' })
  })
})

describe.runIf(windows)('catalogues per GitHub host (HR2’s round 1 on HI-2779)', { timeout: 60000 }, () => {
  const token = { COPILOT_GITHUB_TOKEN: 'x', FAKE_COPILOT_MODE: 'byhost' }

  it('two contexts, different models, defaults and availability: each project’s pickers get its own host’s', async () => {
    freshLog()
    const env = baseEnv(copilotHome(), token)
    const pub = route(null, null, env, ['D:\\ws'])
    const tenant = route({ host: 'tenant.ghe.com' }, null, env, ['D:\\ws\\Tenant-App'])
    expect(await checkRoutes([pub, tenant], deps())).not.toBeNull()
    const info = { catalog: null, defaultModel: null, ...hostCatalogsOf([pub, tenant], '1.0.106', 'now') } as Pick<AgentInstallInfo, 'catalog' | 'defaultModel' | 'hostCatalogs' | 'hostRouteOf'>
    // The tenant project (by its own path, any case) and a project of the workspace without settings of its own.
    const atTenant = infoAt(info, { projectPath: 'd:\\ws\\tenant-app', workspacePath: 'D:\\ws' })
    const atOther = infoAt(info, { projectPath: 'D:\\ws\\other', workspacePath: 'D:\\ws' })
    expect(atTenant?.catalog?.models.map((m) => [m.value, !!m.unavailable])).toEqual([['tenant-only-model', false], ['gpt-5', true]])
    expect(atTenant?.defaultModel).toBe('tenant-only-model')
    expect(atOther?.catalog?.models.map((m) => [m.value, !!m.unavailable])).toEqual([['gpt-5', false], ['public-only-model', false]])
    expect(atOther?.defaultModel).toBe('gpt-5')
    // The pickers' groups: the tenant's offers only its own; gpt-5 is listed apart, as unavailable to that account.
    const groups = modelGroups('copilot', atTenant, null)
    expect(groups[0].models.map((m) => m.value)).toEqual(['tenant-only-model'])
    expect(groups.find((g) => g.unavailable)?.models.map((m) => m.value)).toEqual(['gpt-5'])
    // The order the routes come in doesn't change any project's list.
    const swapped = infoAt({ catalog: null, defaultModel: null, ...hostCatalogsOf([tenant, pub], '1.0.106', 'now') } as typeof info, { projectPath: 'D:\\ws\\Tenant-App', workspacePath: 'D:\\ws' })
    expect(swapped?.catalog?.models.map((m) => m.value)).toEqual(['tenant-only-model', 'gpt-5'])
  })

  it('a host with no listing (no sign-in there) has no catalogue: never another host’s', async () => {
    freshLog()
    const env = baseEnv(copilotHome(), { FAKE_COPILOT_MODE: 'byhost' })
    const pub = route(null, null, { ...env, COPILOT_GITHUB_TOKEN: 'x' }, ['D:\\ws'])
    const tenant = route({ host: 'tenant.ghe.com' }, null, env, ['D:\\ws\\app'])
    expect(await checkRoutes([pub, tenant], deps())).not.toBeNull()
    const info = { catalog: null, defaultModel: null, ...hostCatalogsOf([pub, tenant], '1.0.106', 'now') } as Pick<AgentInstallInfo, 'catalog' | 'defaultModel' | 'hostCatalogs' | 'hostRouteOf'>
    expect(infoAt(info, { projectPath: 'D:\\ws\\app', workspacePath: 'D:\\ws' })?.catalog).toBeNull()
  })

  it('the primary catalogue is only this generation’s listing: none after a host change, and a delayed old answer is dropped', async () => {
    freshLog()
    const env = baseEnv(copilotHome(), token)
    const pub = route(null, null, env)
    expect(await checkRoutes([pub], deps())).not.toBeNull()
    expect(primaryModels([pub])?.models.map((m) => m.value)).toEqual(['gpt-5', 'public-only-model'])
    expect(primaryContext([pub])).toMatch(/^github\.com\|github\.com\|env\|/)
    // A host change: the old listing isn't this generation's any more, so nothing is offered for it.
    newGeneration()
    expect(primaryModels([pub])).toBeNull()
    expect(primaryContext([pub])).toBeNull()
    // An old check still asking when the host changes: its late answer is never kept, so the new route never shows it.
    const tenant = route(null, { host: 'tenant.ghe.com' }, env)
    let release: () => void = () => {}
    const slow: HostCheckDeps = { ...deps(), models: (e) => new Promise((r) => (release = () => void askCopilotModels(COPILOT, e, 8000).then(r))) }
    const old = checkRoutes([pub], slow)
    newGeneration()
    expect(await checkRoutes([tenant], deps())).not.toBeNull()
    release()
    expect(await old).toBeNull()
    expect(primaryModels([pub])).toBeNull()
    expect(primaryModels([tenant])?.models.map((m) => m.value)).toEqual(['tenant-only-model', 'gpt-5'])
  })
})

describe('the saved catalogue as a cache (HR2’s round 1 on HI-2779)', () => {
  const saved: ModelCatalog = { source: 'cli', version: '1.0.106', models: [{ value: 'public-only-model', label: 'P' }], at: 'then', context: 'github.com|github.com|env|c:\\h|stored:octo|strip:1|update:0|c:\\copilot.exe@1.0.106' }
  it('is used only in the context it was read in', () => {
    expect(cachedCatalogFor(saved, '1.0.106', saved.context)?.source).toBe('cache')
    // The same version on another host or account: not used.
    expect(cachedCatalogFor(saved, '1.0.106', 'tenant.ghe.com|tenant.ghe.com|set|c:\\h|stored:mona|strip:1|update:0|c:\\copilot.exe@1.0.106')).toBeNull()
    // An enterprise check that failed after the public one was cached: no context now, so no cache.
    expect(cachedCatalogFor(saved, '1.0.106', null)).toBeNull()
    // A CLI without contexts (undefined): as before.
    expect(cachedCatalogFor({ ...saved, context: undefined }, '1.0.106', undefined)?.source).toBe('cache')
  })
})

describe('what a launch records it signs in as (HR2’s round 1 on HI-2779)', () => {
  const home = (users: { host: string; login: string }[]): string => copilotHome(users)
  it('legacy (nothing set, no host variable): the stored login’s own host, source and account', async () => {
    const h = home([{ host: 'https://tenant.ghe.com', login: 'mona' }])
    const snap = await signInSnapshot(resolveGithubHosts(null, null, {}), { COPILOT_HOME: h })
    expect(snap).toEqual({ host: 'tenant.ghe.com', repoHost: 'github.com', origin: 'default', source: 'Copilot login', account: 'mona', home: h })
  })
  it('an explicit host: a token by its name (never its value), else the stored login on that host only', async () => {
    const h = home([{ host: 'https://github.com', login: 'octo' }])
    const resolved = resolveGithubHosts({ host: 'git.acme.example', copilotHost: 'tenant.ghe.com' }, null, {})
    expect(await signInSnapshot(resolved, { COPILOT_HOME: h, COPILOT_GITHUB_TOKEN: 'secret-value' })).toEqual({ host: 'tenant.ghe.com', repoHost: 'git.acme.example', origin: 'project', source: 'COPILOT_GITHUB_TOKEN', account: null, home: h })
    expect(await signInSnapshot(resolved, { COPILOT_HOME: h })).toEqual({ host: 'tenant.ghe.com', repoHost: 'git.acme.example', origin: 'project', source: null, account: null, home: h })
    expect(JSON.stringify(await signInSnapshot(resolved, { COPILOT_HOME: h, COPILOT_GITHUB_TOKEN: 'secret-value' }))).not.toContain('secret-value')
  })
  it('none where Copilot can’t sign in (a GHES host with nothing chosen)', async () => {
    expect(await signInSnapshot(resolveGithubHosts({ host: 'git.acme.example' }, null, {}), {})).toBeNull()
  })
})

describe('the context a listing is cached by (no secret in it)', () => {
  const r = 'github.com|github.com|env|c:\\home'
  it('changes with the source, the account, the switches and the executable', () => {
    const k = (e: Parameters<typeof contextKey>[1], strip = true, upd = true, v = '1.0.106'): string => contextKey(r, e, 'C:\\copilot.exe', v, strip, upd)
    const stored = { source: 'stored' as const, variable: null, account: 'octo' }
    expect(k(stored)).not.toBe(k({ ...stored, account: 'mona' }))
    expect(k({ source: 'token', variable: 'COPILOT_GITHUB_TOKEN', account: null })).not.toBe(k({ source: 'token', variable: 'GH_TOKEN', account: null }))
    expect(k(stored)).not.toBe(k(stored, false))
    expect(k(stored)).not.toBe(k(stored, true, false))
    expect(k(stored)).not.toBe(k(stored, true, true, '1.0.107'))
    expect(k({ source: 'token', variable: 'GH_TOKEN', account: null })).not.toMatch(/gho_|ghp_/)
  })

  it('two workspaces on different hosts are different routes, each with its own listing', () => {
    const a = routeOf(resolveGithubHosts(null, { host: 'tenant.ghe.com' }, {}), {})
    const b = routeOf(resolveGithubHosts(null, null, {}), {})
    expect(a.key).not.toBe(b.key)
  })

  it('a strip-switch change moves a token from configured to absent (GH_TOKEN kept out)', () => {
    expect(hostEvidence({ GH_TOKEN: 'x' }, null, null, 'github.com')).toMatchObject({ state: 'configured', variable: 'GH_TOKEN' })
    expect(hostEvidence({}, null, null, 'github.com')).toMatchObject({ state: 'installed' })
  })

  it('the enablement metadata is counted, never assumed', () => {
    expect(modelEnablement({ models: { availableModels: [] } })).toEqual({ enablement: 'none', allDisabled: false })
    expect(withModels({ state: 'noSignIn', source: 'local', variable: null, account: null }, { kind: 'ok', read: { models: [{ value: 'm', label: 'm', unavailable: true }] }, enablement: 'all', allDisabled: true }).state).toBe('noSignIn')
  })
})
