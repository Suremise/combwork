import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentInstallInfo } from '../src/shared/types'
import { redactLog } from '../src/shared/redact'
import { copilotCheckEnv, copilotReadiness, copilotSignIn, copilotUpdateCommand, copilotUpdateRetry, ignoredTokens, installKind, parseCopilotConfig, parseCopilotVersion, parseGhStatus } from '../src/main/providers/copilot/install'
import { storedLoginFor } from '../src/main/providers/copilot/hosts'
import { tempDir } from './tempDir'

// Provider Setup's Copilot readiness (#452): which sign-in its agents get, from the CLI's config.json (login names only),
// the environment (set or not, never read) and `gh auth status` (account and state, never the token). CLI 1.0.93.

/** A config.json as Copilot 1.0.93 writes it: a comment line, then JSON. */
const configText = (users: { host: string; login: string }[], last?: { host: string; login: string }): string =>
  `// User settings belong in settings.json.\n${JSON.stringify({ firstLaunchAt: '2026-10-08T21:06:00.000Z', loggedInUsers: users.map((u) => ({ ...u, kind: 'githubDotCom' })), ...(last ? { lastLoggedInUser: last } : {}) }, null, 2)}\n`
const ghJson = (entries: Record<string, unknown>[]): string => JSON.stringify({ hosts: { 'github.com': entries } })
const GH = 'https://github.com'

describe('Copilot sign-in detection', () => {
  const stored = parseCopilotConfig(configText([{ host: GH, login: 'octo' }], { host: GH, login: 'octo' }))
  const gh = parseGhStatus(ghJson([{ active: true, host: 'github.com', login: 'gh-user', state: 'success', tokenSource: 'keyring', scopes: 'repo', gitProtocol: 'https' }]))

  it('takes a stored login from config.json, with its account', () => {
    expect(copilotSignIn({}, stored, null)).toEqual({ loggedIn: true, source: 'stored', account: 'octo', variable: null })
  })

  it('falls back to the GitHub CLI when nothing is stored', () => {
    expect(copilotSignIn({}, parseCopilotConfig(configText([])), gh)).toEqual({ loggedIn: true, source: 'gh', account: 'gh-user', variable: null })
    expect(copilotSignIn({}, null, gh)).toMatchObject({ source: 'gh' })
  })

  it('takes a token in the environment first, in the CLI’s order, without its account', () => {
    expect(copilotSignIn({ GITHUB_TOKEN: 'x', GH_TOKEN: 'y' }, stored, gh)).toEqual({ loggedIn: true, source: 'token', account: null, variable: 'GH_TOKEN' })
    expect(copilotSignIn({ GITHUB_TOKEN: 'x', COPILOT_GITHUB_TOKEN: 'z' }, stored, gh)).toMatchObject({ variable: 'COPILOT_GITHUB_TOKEN' })
    expect(copilotSignIn({ GH_TOKEN: '  ' }, stored, null)).toMatchObject({ source: 'stored' })
  })

  it('is signed out with no login, no token and gh missing or without a login there', () => {
    const out = { loggedIn: false, source: null, account: null, variable: null }
    expect(copilotSignIn({}, null, null)).toEqual(out)
    expect(copilotSignIn({}, null, parseGhStatus(JSON.stringify({ hosts: {} })))).toEqual(out)
  })

  it('takes a gh error as unknown, not signed out (HI-2779: an error can be the network as well as a bad token)', () => {
    expect(copilotSignIn({}, parseCopilotConfig(configText([])), parseGhStatus(ghJson([{ active: true, login: 'gh-user', state: 'error' }])))).toEqual({ loggedIn: null, source: 'gh', account: 'gh-user', variable: null })
  })

  it('names the last login of several on the host asked for, never another host’s (HI-2779)', () => {
    const two = [{ host: GH, login: 'first' }, { host: GH, login: 'second' }]
    expect(storedLoginFor(parseCopilotConfig(configText(two, { host: GH, login: 'second' })), 'github.com')).toBe('second')
    expect(storedLoginFor(parseCopilotConfig(configText(two)), 'github.com')).toBe('first')
    expect(storedLoginFor(parseCopilotConfig(configText(two, { host: GH, login: 'gone' })), 'github.com')).toBe('first')
    const acme = parseCopilotConfig(configText([{ host: 'https://acme.ghe.com/', login: 'me' }]))
    expect(storedLoginFor(acme, 'acme.ghe.com')).toBe('me')
    expect(storedLoginFor(acme, 'github.com')).toBeNull()
    expect(storedLoginFor({ loggedInUsers: [{ host: GH }] }, 'github.com')).toBe('')
    expect(storedLoginFor({ loggedInUsers: [{ login: 'nohost' }] }, 'github.com')).toBe('nohost')
    expect(storedLoginFor({ loggedInUsers: 'nope' }, 'github.com')).toBeNull()
    expect(storedLoginFor(null, 'github.com')).toBeNull()
  })

  it('reads a damaged config.json or gh reply as nothing', () => {
    expect(parseCopilotConfig('// comment\n{ broken')).toBeNull()
    expect(parseGhStatus('')).toBeNull()
    expect(parseGhStatus('not json')).toBeNull()
  })

  it('checks with the environment agents get: no GH_TOKEN or GITHUB_TOKEN, no auto-update, nothing of Combwork’s', () => {
    const env = copilotCheckEnv({ PATH: 'C:\\bin', GH_TOKEN: 'a', GITHUB_TOKEN: 'b', CW_SESSION: 'x', ELECTRON_RUN_AS_NODE: '1', CHROME_CRASHPAD_PIPE_NAME: 'p', GH_CONFIG_DIR: 'D:\\gh' })
    expect(env).toEqual({ PATH: 'C:\\bin', GH_CONFIG_DIR: 'D:\\gh', COPILOT_AUTO_UPDATE: 'false' })
    expect(copilotSignIn(env, null, null).loggedIn).toBe(false)
    expect(ignoredTokens({ GH_TOKEN: 'a', GITHUB_TOKEN: '', PATH: 'x' })).toEqual(['GH_TOKEN'])
  })

  it('keeps COPILOT_GITHUB_TOKEN, a token of Copilot’s own, as the sign-in in use (#450, option B)', () => {
    const env = copilotCheckEnv({ PATH: 'C:\\bin', GH_TOKEN: 'a', COPILOT_GITHUB_TOKEN: 'c' })
    expect(env.COPILOT_GITHUB_TOKEN).toBe('c')
    expect(copilotSignIn(env, stored, gh)).toEqual({ loggedIn: true, source: 'token', account: null, variable: 'COPILOT_GITHUB_TOKEN' })
    expect(ignoredTokens({ COPILOT_GITHUB_TOKEN: 'c', GITHUB_TOKEN: 'b' })).toEqual(['GITHUB_TOKEN'])
  })
})

describe('Copilot install', () => {
  it('offers an explicit forced WinGet retry only for portable uninstall failure, in either HRESULT form', () => {
    const exe = 'C:/Users/me/AppData/Local/Microsoft/WinGet/Packages/GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe/copilot.exe'
    for (const code of [-1978335145, 0x8a150057]) {
      const retry = copilotUpdateRetry(exe, code)!
      expect(retry.command).toEqual({ file: 'winget.exe', args: ['upgrade', '--id', 'GitHub.Copilot', '--exact', '--source', 'winget', '--force'] })
      expect(retry.notice.label).toBe('Update anyway')
      expect(retry.notice.message).toContain('--force')
    }
    for (const code of [0, 1, -1978335146, 5]) expect(copilotUpdateRetry(exe, code)).toBeNull()
    expect(copilotUpdateRetry('C:/Users/me/AppData/Roaming/npm/copilot.cmd', -1978335145)).toBeNull()
    expect(copilotUpdateRetry('D:/tools/copilot.exe', -1978335145)).toBeNull()
    expect(copilotUpdateCommand(exe).args).not.toContain('--force')
  })

  it('reads its version without the sentence’s full stop', () => {
    expect(parseCopilotVersion('GitHub Copilot CLI 1.0.93.\nRun \'copilot update\' to check for updates.')).toBe('1.0.93')
    expect(parseCopilotVersion('GitHub Copilot CLI 1.1.0-beta.2.')).toBe('1.1.0-beta.2')
    expect(parseCopilotVersion('nothing')).toBeNull()
  })

  it('tells WinGet and npm installs apart, and updates through the same installer', () => {
    const winget = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe'
    const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd'
    expect(installKind(winget)).toBe('winget')
    expect(installKind('C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe\\copilot.exe')).toBe('winget')
    expect(installKind(npm)).toBe('npm')
    expect(installKind('D:\\tools\\copilot.exe')).toBe('other')
    expect(copilotUpdateCommand(winget)).toEqual({ file: 'winget.exe', args: ['upgrade', '--id', 'GitHub.Copilot', '--exact', '--source', 'winget'] })
    expect(copilotUpdateCommand(npm).args.join(' ')).toMatch(/npm install -g @github\/copilot@latest$/)
  })
})

describe('Copilot readiness', () => {
  const base: AgentInstallInfo = { provider: 'copilot', found: true, path: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe', version: '1.0.93', source: 'PATH', latestVersion: null, updateAvailable: false, loggedIn: true, authMethod: 'Copilot login', account: 'octo' }

  it('asks to install it when it is missing', () => {
    expect(copilotReadiness({ ...base, found: false, path: null }, {})).toEqual([expect.objectContaining({ id: 'not-installed', action: { label: 'Install', task: 'install' } })])
  })

  it('is ready when signed in', () => {
    expect(copilotReadiness(base, {})).toEqual([])
  })

  it('shows the login command when signed out, and never signs in itself', () => {
    const [issue] = copilotReadiness({ ...base, loggedIn: false, authMethod: null, account: null }, {})
    expect(issue).toMatchObject({ id: 'signed-out', level: 'error', action: { label: 'Sign in', task: 'login' } })
    expect(issue.detail!.join('\n')).toContain('`copilot login`')
    expect(issue.detail!.join('\n')).toContain('`gh auth login`')
    expect(issue.detail!.join('\n')).not.toContain('GH_TOKEN')
  })

  it('says when a token in Combwork’s environment isn’t passed to agents', () => {
    const [issue] = copilotReadiness({ ...base, loggedIn: false }, { GH_TOKEN: 'secret-not-read', PATH: 'x' })
    expect(issue.detail!.at(-2)).toContain('`GH_TOKEN`')
    // Where the switch keeping it out is (HI-2779): named, never changed.
    expect(issue.detail!.at(-1)).toContain('Keep GH_TOKEN and GITHUB_TOKEN from Copilot')
    expect(issue.detail!.join('\n')).not.toContain('secret-not-read')
  })

  it('offers Update only where its installer can update it', () => {
    const update = { ...base, updateAvailable: true, latestVersion: '1.0.94' }
    expect(copilotReadiness(update, {})).toEqual([{ id: 'update', level: 'info', message: 'GitHub Copilot 1.0.94 is available.', action: { label: 'Update', task: 'update' } }])
    const [other] = copilotReadiness({ ...update, path: 'D:\\tools\\copilot.exe' }, {})
    expect(other.action).toBeUndefined()
    expect(other.detail![0]).toContain('the way you installed it')
  })
})

describe('Copilot discovery log', () => {
  it('leaves a candidate’s path and what it printed out of Copy Diagnostics (userText)', async () => {
    // A custom path in a private folder whose CLI prints a private name instead of its version.
    const dir = tempDir('cw-copilot-')
    const exe = join(dir, 'Private Client', 'copilot.exe')
    mkdirSync(dirname(exe), { recursive: true })
    writeFileSync(exe, '')
    vi.resetModules()
    vi.doMock('../src/main/config', () => ({ config: { settings: { providers: { copilot: { executablePath: exe } } } } }))
    vi.doMock('../src/main/providers/common', async (actual) => ({ ...(await actual<typeof import('../src/main/providers/common')>()), run: async (file: string) => (file === exe ? { stdout: '', stderr: 'Failed loading Confidential Customer profile', code: 1 } : { stdout: '', stderr: '', code: 1 }) }))
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((l: unknown) => void lines.push(String(l)))
    try {
      const { locateCopilot } = await import('../src/main/providers/copilot/install')
      expect((await locateCopilot()).found).toBe(false)
    } finally {
      spy.mockRestore()
      vi.doUnmock('../src/main/config')
      vi.doUnmock('../src/main/providers/common')
      vi.resetModules()
      rmSync(dir, { recursive: true, force: true })
    }
    const warning = lines.find((l) => l.includes('did not report a version'))
    expect(warning).toBeDefined()
    const out = redactLog(warning!, { home: 'C:\\Users\\nobody', folders: [], names: [] })
    expect(out).toContain('did not report a version')
    expect(out).not.toMatch(/Private Client|copilot\.exe|Confidential|Customer/)
  })
})
