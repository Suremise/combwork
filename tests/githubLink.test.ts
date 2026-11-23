// A project's GitHub link and the one gh service (HI-3550). The remotes read as repositories on the GitHub host (origin
// first, the user's choice, several to choose from, another host's left out); and ghCli.ts on a fake gh first on the
// PATH it is given (never the user's own gh or sign-in): every call names its host or repository, no GitHub token
// reaches gh, its answers and failures come back as kinds, and Copilot's check goes through it too. A guard: no other
// code in main launches gh.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import { describe, expect, it } from 'vitest'
import { githubRepoOf, githubRepoUrl, parseGithubRemote } from '../src/shared/githubRepo'
import { findGh, gh, ghEnv, ghStatus, testGhSeam } from '../src/main/ghCli'
import { ghHostStatus } from '../src/main/providers/copilot/install'
import { tempDir } from './tempDir'
import { timing } from './timing.cjs'

describe('a remote as a repository on a GitHub host', () => {
  it('reads https, ssh and scp-like URLs, lower-casing the host and dropping .git, a user and a port', () => {
    expect(parseGithubRemote('https://github.com/Acme/Widgets.git')).toEqual({ host: 'github.com', owner: 'Acme', repo: 'Widgets' })
    expect(parseGithubRemote('git@GitHub.com:acme/widgets.git')).toEqual({ host: 'github.com', owner: 'acme', repo: 'widgets' })
    expect(parseGithubRemote('ssh://git@git.acme.example:2222/team/app')).toEqual({ host: 'git.acme.example', owner: 'team', repo: 'app' })
    expect(parseGithubRemote('https://tenant.ghe.com/org/repo/')).toEqual({ host: 'tenant.ghe.com', owner: 'org', repo: 'repo' })
  })
  it('refuses what isn’t owner/repo on a host', () => {
    for (const url of ['C:\\repos\\app', 'D:/repos/app.git', '../bare.git', 'https://github.com/acme', 'https://github.com/a/b/c', 'file:///x/y/z', 'https://github.com/../x']) expect(parseGithubRemote(url), url).toBeNull()
  })
  it('links origin first, keeps the user’s choice while it matches, and asks when several match without origin', () => {
    const r = (name: string, url: string) => ({ name, fetchUrl: url, pushUrl: url })
    const remotes = [r('upstream', 'https://github.com/up/app.git'), r('origin', 'git@github.com:me/app.git'), r('work', 'https://git.acme.example/t/app')]
    const of = githubRepoOf(remotes, 'GitHub.com')
    expect(of.candidates.map((c) => c.remote)).toEqual(['origin', 'upstream'])
    expect(of.linked).toMatchObject({ remote: 'origin', owner: 'me', repo: 'app' })
    expect(githubRepoOf(remotes, 'github.com', 'upstream').linked?.remote).toBe('upstream')
    // A choice no longer on the host falls back to origin.
    expect(githubRepoOf(remotes, 'github.com', 'work').linked?.remote).toBe('origin')
    const noOrigin = [r('a', 'https://github.com/x/one'), r('b', 'https://github.com/y/two')]
    expect(githubRepoOf(noOrigin, 'github.com').linked).toBeNull()
    expect(githubRepoOf(noOrigin.slice(0, 1), 'github.com').linked?.remote).toBe('a')
    // Another host's remote only: no link, so no GitHub feature.
    expect(githubRepoOf(remotes, 'tenant.ghe.com')).toEqual({ candidates: [], linked: null })
    expect(githubRepoUrl({ host: 'git.acme.example', owner: 't', repo: 'app' })).toBe('https://git.acme.example/t/app')
  })
})

const windows = process.platform === 'win32'
const base = tempDir('cw-gh-')
const nodeDir = dirname(process.execPath)
const log = join(base, 'calls.jsonl')

/** A fake gh: a one-line .cmd running Node, logging its argv and the token and host variables it got; answers by FAKE_GH_MODE. */
function fakeGh(dir: string): void {
  writeFileSync(
    join(dir, 'gh.cjs'),
    `const fs = require('fs')
const args = process.argv.slice(2)
const keys = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_PROMPT_DISABLED']
const env = Object.fromEntries(keys.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]))
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, env }) + '\\n')
const mode = process.env.FAKE_GH_MODE || 'in'
if (args[0] === '--version') { process.stdout.write('gh version 2.83.0 (2026-11-01)\\n'); process.exit(0) }
if (mode === 'hang') setTimeout(() => {}, 8000)
else if (args[0] === 'auth') {
  const host = args[args.indexOf('--hostname') + 1]
  if (mode === 'out') { process.stdout.write(JSON.stringify({ hosts: {} })); process.exit(1) }
  if (mode === 'bad') { process.stdout.write(JSON.stringify({ hosts: { [host]: [{ state: 'error', active: true, login: 'mona', error: 'token revoked' }] } })); process.exit(1) }
  process.stdout.write(JSON.stringify({ hosts: { [host]: [{ state: 'success', active: true, login: 'mona' }] } }))
} else if (mode === 'four') { process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n'); process.exit(4) }
else if (mode === 'fail') { process.stderr.write('HTTP 404: Not Found (https://api.github.com/repos/x/y)\\n'); process.exit(1) }
else process.stdout.write(JSON.stringify([{ number: 7, title: 'A pull request' }]))
`
  )
  writeFileSync(join(dir, 'gh.cmd'), '@node "%~dp0gh.cjs" %*\r\n')
}

const ghDir = tempDir('cw-gh-bin-')
fakeGh(ghDir)
/** The environment a call is given: the fake first on PATH, Node beside it, and tokens a real gh would sign in with. */
const env = (mode = 'in', extra: Record<string, string> = {}) => ({ PATH: `${ghDir};${nodeDir}`, SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', FAKE_LOG: log, FAKE_GH_MODE: mode, GH_TOKEN: 'ghp_secret', github_token: 'ghp_other', GH_HOST: 'evil.example', ...extra })
const calls = (): { args: string[]; env: Record<string, string> }[] => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const fresh = (): void => writeFileSync(log, '')

// This file's calls aren't a test copy's: they find the fake on the PATH they give.
delete process.env.CW_USER_DATA

describe('a test copy never runs the gh on its PATH (CW_TEST_GH)', () => {
  it('a test copy runs CW_TEST_GH’s fake, or none; anything else looks on the PATH', async () => {
    expect(testGhSeam({ CW_USER_DATA: 'p', CW_TEST_GH: 'C:/fake/gh.cmd' }, false)).toBe('C:/fake/gh.cmd')
    expect(testGhSeam({ CW_USER_DATA: 'p' }, false)).toBeNull()
    expect(testGhSeam({ CW_TEST_GH: 'x' }, false)).toBeUndefined()
    expect(testGhSeam({ CW_USER_DATA: 'p', CW_TEST_GH: 'x' }, true)).toBeUndefined()
    // A test copy without a fake: gh is missing, whatever its PATH has.
    expect(await findGh({ PATH: ghDir }, null)).toBeNull()
  })
})

describe.runIf(windows)('the gh service, on a fake gh', { timeout: timing('test.hang') }, () => {
  it('finds gh on the PATH it is given, a .cmd too, and nothing on a PATH without one', async () => {
    expect(await findGh({ PATH: `${nodeDir};${ghDir}` })).toBe(join(ghDir, 'gh.cmd'))
    expect(await findGh({ Path: nodeDir })).toBeNull()
  })
  it('never gives gh a token or a default host, and never prompts', () => {
    const e = ghEnv({ GH_TOKEN: 'a', Github_Token: 'b', GH_ENTERPRISE_TOKEN: 'c', GITHUB_ENTERPRISE_TOKEN: 'd', KEEP: 'x' })
    expect(e).toEqual({ KEEP: 'x', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: '' })
  })
  it('names the repository (-R host/owner/repo) or the host (--hostname) on every call, and parses JSON', async () => {
    fresh()
    const r = await gh({ repo: { host: 'tenant.ghe.com', owner: 'acme', repo: 'app' } }, ['pr', 'list', '--json', 'number,title'], { json: true, env: env() })
    expect(r).toMatchObject({ ok: true, json: [{ number: 7, title: 'A pull request' }] })
    await gh({ host: 'git.acme.example' }, ['api', 'user'], { env: env() })
    const [a, b] = calls()
    expect(a.args).toEqual(['pr', 'list', '--json', 'number,title', '-R', 'tenant.ghe.com/acme/app'])
    expect(b.args).toEqual(['api', 'user', '--hostname', 'git.acme.example'])
    // No token in any spelling, no GH_HOST: the call names its host.
    for (const c of calls()) expect(c.env).toEqual({ GH_PROMPT_DISABLED: '1' })
  })
  it('says why a call failed: not installed, signed out (exit 4), gh’s own words, or no answer in time', async () => {
    expect(await gh({ host: 'github.com' }, ['api', 'user'], { env: { PATH: nodeDir } })).toEqual({ ok: false, problem: 'missing', detail: null })
    expect(await gh({ host: 'github.com' }, ['api', 'user'], { env: env('four') })).toMatchObject({ ok: false, problem: 'signedOut' })
    expect(await gh({ host: 'github.com' }, ['api', 'user'], { env: env('fail') })).toEqual({ ok: false, problem: 'failed', detail: 'HTTP 404: Not Found (https://api.github.com/repos/x/y)' })
    expect(await gh({ host: 'github.com' }, ['api', 'user'], { env: env('hang'), timeoutMs: 1500 })).toEqual({ ok: false, problem: 'timeout', detail: null })
  })
  it('reads its sign-in on exactly the host asked: signed in as whom, signed out, a login that doesn’t work, not installed', async () => {
    fresh()
    expect(await ghStatus('tenant.ghe.com', env())).toEqual({ host: 'tenant.ghe.com', state: 'signedIn', login: 'mona', version: '2.83.0', error: null })
    expect(calls()[1].args).toEqual(['auth', 'status', '--active', '--hostname', 'tenant.ghe.com', '--json', 'hosts'])
    expect(await ghStatus('github.com', env('out'))).toMatchObject({ state: 'signedOut', login: null })
    expect(await ghStatus('github.com', env('bad'))).toMatchObject({ state: 'signedOut', login: 'mona', error: 'token revoked' })
    expect(await ghStatus('github.com', { PATH: nodeDir })).toMatchObject({ state: 'missing', version: null })
  })
  it("Copilot's sign-in check goes through it: its route's GH_HOST kept, its tokens not", async () => {
    fresh()
    expect(await ghHostStatus('tenant.ghe.com', env('in', { COPILOT_GH_HOST: 'tenant.ghe.com' }))).toMatchObject({ state: 'success', login: 'mona' })
    expect(calls()[0]).toEqual({ args: ['auth', 'status', '--active', '--hostname', 'tenant.ghe.com', '--json', 'hosts'], env: { GH_HOST: 'evil.example', GH_PROMPT_DISABLED: '1' } })
  })
})

describe('gh is launched only through ghCli.ts', () => {
  it('no other main or shared code starts a program named gh', () => {
    const root = join(__dirname, '..', 'src')
    const files: string[] = []
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(f)) files.push(p)
      }
    }
    walk(join(root, 'main'))
    walk(join(root, 'shared'))
    // A program named gh (or gh.exe) given straight to a runner: execFile, spawn, run and their kind.
    const launch = /\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync|run|runGh|pty\.spawn)\(\s*['"`]gh(?:\.exe)?['"`]/
    const found = files.filter((f) => !f.endsWith('ghCli.ts') && launch.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f))
    expect(found).toEqual([])
  })
})
