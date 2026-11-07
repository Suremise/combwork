// The Antigravity CLI as a provider (HI-2544, against agy 1.5.0; the runtime facts are HI-2543's and HI-2544's own runs):
// install and readiness (signed out only on the recorded pattern), the catalog from `agy models`, the environment (account
// variables, the updater, a private USERPROFILE with HOME kept), the workspace's .agents config (fail closed), each
// agent's private profile (Combwork's servers; a project's own server not given refuses the launch), the
// launch settings and arguments, conversation ids, and the PC-wide account.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { release } from 'os'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { createRequire } from 'module'
import { tempDir } from './tempDir'

const base = tempDir('cw-antigravity-')
process.env.CW_USER_DATA = join(base, 'userdata')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { antigravityCheckEnv, checkModels, classifyModels, isEditorCopy, parseAntigravityVersion, runAgy } = await import('../src/main/providers/antigravity/install')
const { parseModels } = await import('../src/main/providers/antigravity/models')
const { ANTIGRAVITY_ENV_STRIP, antigravityEnv, checkEnv, checkProfile, inProfile, inUserProfile, userProfileFolder, brainDir } = await import('../src/main/providers/antigravity/home')
// A spawned child's environment: the run context's allowlist, never this shell's (tests/README.md, Isolation).
const runContext = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
const childBase = (): Record<string, string> => runContext.baseEnv() as Record<string, string>
const { UnreadableConfig, scannedFolders, workspaceServers } = await import('../src/main/providers/antigravity/projectConfig')
const { copyOnboarding, onboarded, onboardingComplete, postOnboardingBlock } = await import('../src/main/providers/antigravity/onboarding')
const { AUTO_MIN_BUILD, AUTO_MIN_REVISION, AUTO_SHARED_SERVICING, GUIDANCE_FILE, RULES_MAX_BYTES, agyServer, antigravity, autoSandbox, guidanceBytes, launchGuidance, legacySseServers, regNumber, windowsVersion, antigravityArgs, isConversationId, launchSettings, profileConfig, profileFolder, sameServer, statusLineConversation } = await import('../src/main/providers/antigravity/adapter')
const { advanced } = await import('../src/main/advanced')
const { ensurePcAccounts, homeAccount, pcAccountId, pcWideSignIn } = await import('../src/shared/connectionDefaults')
const { TOOLS_SERVER } = await import('../src/shared/assistantTools')
const { combworkInstructions } = await import('../src/shared/combworkGuidance')

const FIX = join(__dirname, 'fixtures', 'advanced')
const models = readFileSync(join(FIX, 'models-antigravity-1.5.0.txt'), 'utf8')
const signedOut = readFileSync(join(FIX, 'models-signedout-antigravity-1.5.0.txt'), 'utf8')
const signInPattern = () => advanced.pattern('antigravity.signIn.needed')
const CONV = '12b14cd0-6972-4a51-8d38-f8c898d76659'

describe('install and readiness (agy 1.5.0)', () => {
  it('its version, as `agy --version` prints it; anything else is none', () => {
    expect(parseAntigravityVersion('1.5.0\n')).toBe('1.5.0')
    expect(parseAntigravityVersion('v1.6.0-rc.1\r\n')).toBe('1.6.0-rc.1')
    expect(parseAntigravityVersion('Usage of agy.exe:')).toBeNull()
  })

  it("an editor's copy is never used; the standalone CLI is", () => {
    expect(isEditorCopy('C:\\Users\\d\\.vscode\\extensions\\google.antigravity-1.0\\bin\\agy.exe')).toBe(true)
    expect(isEditorCopy('C:\\Users\\d\\AppData\\Local\\Programs\\Antigravity\\resources\\app\\bin\\agy.exe')).toBe(true)
    expect(isEditorCopy('C:\\Users\\d\\AppData\\Local\\agy\\bin\\agy.exe')).toBe(false)
  })

  it('agy models: signed in lists the models; signed out only on the recorded pattern; any other failure is an error, never a sign-in to do', () => {
    expect(classifyModels({ stdout: models, stderr: 'Fetching available models...\n', code: 0 }, signInPattern())).toMatchObject({ kind: 'ok', models: expect.arrayContaining([{ value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' }]) })
    expect(classifyModels({ stdout: '', stderr: signedOut, code: 1 }, signInPattern())).toMatchObject({ kind: 'signIn' })
    for (const text of ['Error: dial tcp: lookup api.example: no such host', 'Error: 503 Service Unavailable', 'context deadline exceeded'])
      expect(classifyModels({ stdout: '', stderr: text, code: 1 }, signInPattern()), text).toMatchObject({ kind: 'error', text })
    expect(classifyModels({ stdout: '', stderr: 'still fetching', code: 1, ended: true }, signInPattern())).toMatchObject({ kind: 'error' })
    // No pattern, or an empty one: never signed out.
    expect(classifyModels({ stdout: '', stderr: signedOut, code: 1 }, null).kind).toBe('error')
    expect(classifyModels({ stdout: '', stderr: signedOut, code: 1 }, new RegExp('')).kind).toBe('error')
    // A run that listed nothing isn't "signed in" either.
    expect(classifyModels({ stdout: '\n', stderr: '', code: 0 }, signInPattern()).kind).toBe('error')
  })

  it('readiness: not installed, or signed out; an unclassified failure raises no sign-in issue', () => {
    const info = { provider: 'antigravity', found: true, path: 'C:\\agy.exe', version: '1.5.0', source: 'installer', latestVersion: null, updateAvailable: false, authMethod: null, account: null, rejected: [] }
    expect(antigravity.readiness({ ...info, found: false, loggedIn: null }).map((i) => i.id)).toEqual(['not-installed'])
    expect(antigravity.readiness({ ...info, loggedIn: false }).map((i) => i.level)).toEqual(['error'])
    expect(antigravity.readiness({ ...info, loggedIn: null })).toEqual([])
    expect(antigravity.readiness({ ...info, loggedIn: true })).toEqual([])
  })
})

describe('the catalog (agy models: id, a tab, its display name)', () => {
  it('each model by its id, its display name apart; the ids never made from the names', () => {
    const list = parseModels(models)
    expect(list.map((m) => m.value)).toEqual(['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'])
    expect(list.find((m) => m.value === 'claude-opus-4-6-thinking')?.label).toBe('Claude Opus 4.6 (Thinking)')
  })

  it('lines it can’t read are skipped; an id of a new shape is kept as it is; no duplicates', () => {
    expect(parseModels('Fetching available models...\nnew-model.v2:preview\tSomething New\n\ngemini-x\tA\ngemini-x\tA again\n').map((m) => [m.value, m.label])).toEqual([
      ['new-model.v2:preview', 'Something New'],
      ['gemini-x', 'A']
    ])
  })
})

describe('the environment', () => {
  const env = { PATH: 'C:\\bin', GEMINI_API_KEY: 'k', agy_adc_auth: 'true', AGY_ACCOUNT: 'x@y', AGY_CLI_DISABLE_AUTO_UPDATE: 'false', HOME: 'C:\\Users\\me' }

  it('account and provider variables are left out (any case), unless the switch is off; a connection’s own put back', () => {
    const out = antigravityEnv(env, true, true)
    for (const k of ANTIGRAVITY_ENV_STRIP) expect(Object.keys(out).some((x) => x.toUpperCase() === k), k).toBe(false)
    expect(out.PATH).toBe('C:\\bin')
    expect(antigravityEnv(env, true, false).GEMINI_API_KEY).toBe('k')
    expect(antigravityEnv(env, true, true, { GEMINI_API_KEY: 'mine' }).GEMINI_API_KEY).toBe('mine')
  })

  it('never updating itself (AGY_CLI_DISABLE_AUTO_UPDATE=true), unless the switch is off: the user’s own value is left then', () => {
    expect(antigravityEnv(env, true, true).AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true')
    expect(antigravityEnv(env, false, true).AGY_CLI_DISABLE_AUTO_UPDATE).toBe('false')
  })

  it('a private USERPROFILE for agy, and the user’s HOME kept for git, Git Bash and ssh', () => {
    const out = inProfile({ USERPROFILE: 'C:\\Users\\me', Path: 'x' }, 'D:\\profile', 'C:\\Users\\me')
    expect(out.USERPROFILE).toBe('D:\\profile')
    expect(out.HOME).toBe('C:\\Users\\me')
    expect(Object.keys(out).filter((k) => k.toUpperCase() === 'USERPROFILE')).toEqual(['USERPROFILE'])
    // A HOME the user's environment sets is kept as it is.
    expect(inProfile({ HOME: '/c/Users/me' }, 'D:\\profile', 'C:\\Users\\other').HOME).toBe('/c/Users/me')
  })
})

describe("agy's checks never run in the user's own profile (HI-2698)", () => {
  // A stand-in agy that notes the profile it was run in (USERPROFILE: agy's home) and answers as 1.5.0 does.
  const bin = join(base, 'probe-agy')
  mkdirSync(bin, { recursive: true })
  const noted = join(bin, 'profile.txt')
  const agy = join(bin, 'agy.cmd')
  writeFileSync(agy, `@echo off\r\n>"${noted}" echo %USERPROFILE%\r\nif "%1"=="--version" goto version\r\necho gemini-3.8-flash-low\tGemini 3.8 Flash Low\r\nexit /b 0\r\n:version\r\necho 1.5.0\r\n`)
  const ranIn = (): string => readFileSync(noted, 'utf8').trim()

  it("the check environment's profile is Combwork's check profile, under its own data, never the user's", () => {
    const env = antigravityCheckEnv()
    expect(env.USERPROFILE).toBe(checkProfile())
    expect(checkProfile().startsWith(join(base, 'userdata'))).toBe(true)
    expect(inUserProfile(env)).toBe(false)
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true')
  })
  it("an environment with no profile of its own, or the user's, is the user's", () => {
    expect(inUserProfile({}, 'C:\\Users\\Ann')).toBe(true)
    expect(inUserProfile({ USERPROFILE: 'c:\\users\\ann\\' }, 'C:\\Users\\Ann')).toBe(true)
    expect(inUserProfile({ userprofile: 'C:\\Users\\Ann' }, 'C:\\Users\\Ann')).toBe(true)
    expect(inUserProfile({ USERPROFILE: 'C:\\Users\\Ann\\AppData\\Local\\Combwork\\antigravity\\check' }, 'C:\\Users\\Ann')).toBe(false)
  })
  it('agy --version and agy models run in the check profile (made first)', async () => {
    expect((await runAgy(agy, ['--version'], 10000, checkEnv(childBase()))).stdout.trim()).toBe('1.5.0')
    expect(ranIn()).toBe(checkProfile())
    const listed = await checkModels(agy, checkEnv(childBase()), null)
    expect(listed.kind).toBe('ok')
    expect(ranIn()).toBe(checkProfile())
  })
  it("a run that would be in the user's own profile is refused, never started", async () => {
    writeFileSync(noted, 'not run')
    // The user's own profile, or none of its own: refused before anything starts.
    await expect(runAgy(agy, ['--version'], 10000, { USERPROFILE: userProfileFolder() })).rejects.toThrow(/user's own profile/)
    await expect(checkModels(agy, {}, null)).rejects.toThrow(/user's own profile/)
    expect(ranIn()).toBe('not run')
  })
  it("the catalog's read (listModels) runs in the check profile too, never in the launch's own environment as given", async () => {
    const settings = (await import('../src/main/config')).config.settings
    settings.providers = { ...settings.providers, antigravity: { ...settings.providers?.antigravity, enabled: true } } as typeof settings.providers
    // The launch's environment as given (the allowlist's, with the user's own profile): read in the check profile all the same.
    await antigravity.listModels(agy, { ...childBase(), USERPROFILE: userProfileFolder() })
    expect(ranIn()).toBe(checkProfile())
  })
})

describe("the workspace's .agents config (what agy would load from it)", () => {
  const repo = join(base, 'repo')
  const sub = join(repo, 'packages', 'app')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, '.agents'), { recursive: true })
  mkdirSync(join(sub, '_agent'), { recursive: true })
  writeFileSync(join(repo, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { sentinel: { command: 'x' }, shared: { url: 'https://x' } } }))
  writeFileSync(join(sub, '_agent', 'mcp_config.json'), JSON.stringify({ mcpServers: { legacy: { command: 'y' } } }))

  it('each folder up to the repository root (the one with .git), and no further', () => {
    expect(scannedFolders(sub)).toEqual([sub, join(repo, 'packages'), repo])
  })

  it('its servers, the legacy folders too, from the folder and each --add-dir, each with its file and definition', async () => {
    const w = await workspaceServers([sub])
    expect([...w.keys()].sort()).toEqual(['legacy', 'sentinel', 'shared'])
    expect(w.get('sentinel')).toEqual([{ file: join(repo, '.agents', 'mcp_config.json'), def: { command: 'x' } }])
    expect(w.get('legacy')?.[0].file).toBe(join(sub, '_agent', 'mcp_config.json'))
    const added = join(base, 'added')
    mkdirSync(join(added, '.git'), { recursive: true })
    mkdirSync(join(added, '.agents'), { recursive: true })
    writeFileSync(join(added, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { extra: { command: 'z' } } }))
    expect([...(await workspaceServers([sub, added])).keys()].sort()).toEqual(['extra', 'legacy', 'sentinel', 'shared'])
  })

  it('every definition of a name, from each file (which one agy uses isn’t known); own keys only, __proto__ too', async () => {
    const two = join(base, 'two')
    mkdirSync(join(two, '.git'), { recursive: true })
    mkdirSync(join(two, '.agents'), { recursive: true })
    mkdirSync(join(two, '_agents'), { recursive: true })
    writeFileSync(join(two, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { s: { command: 'a' } } }))
    writeFileSync(join(two, '_agents', 'mcp_config.json'), '{ "mcpServers": { "s": { "command": "b" }, "__proto__": { "command": "p" }, "constructor": { "command": "c" } } }')
    const w = await workspaceServers([two])
    expect(w.get('s')?.map((x) => x.def)).toEqual([{ command: 'a' }, { command: 'b' }])
    expect([...w.keys()].sort()).toEqual(['__proto__', 'constructor', 's'])
  })

  it('a file it can’t read as JSON (or of the wrong shape) refuses: never read as empty', async () => {
    const bad = join(base, 'bad')
    mkdirSync(join(bad, '.git'), { recursive: true })
    mkdirSync(join(bad, '.agents'), { recursive: true })
    for (const text of ['{ not json', '[1, 2]', JSON.stringify({ mcpServers: ['x'] })]) {
      writeFileSync(join(bad, '.agents', 'mcp_config.json'), text)
      await expect(workspaceServers([bad]), text).rejects.toBeInstanceOf(UnreadableConfig)
    }
    // An empty file is none.
    writeFileSync(join(bad, '.agents', 'mcp_config.json'), '')
    expect((await workspaceServers([bad])).size).toBe(0)
  })
})

describe("an agent's private profile, written for each launch", () => {
  const tools = { command: 'C:\\Program Files\\Combwork\\Combwork.exe', args: ['C:\\Program Files\\Combwork\\resources\\app.asar.unpacked\\out\\main\\cw-mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1', CW_API_TOKEN: 'launch-token', CW_PROJECT: 'alpha' } }
  const project = join('C:\\repo', '.agents', 'mcp_config.json')
  const workspace = new Map([['sentinel', [{ file: project, def: { command: 'node', args: ['sentinel.js'] } }]]])
  const one = (name: string, def: unknown, file = project) => new Map([[name, [{ file, def }]]])

  it("Combwork's servers with their own env (the launch's token)", () => {
    const made = profileConfig({ [TOOLS_SERVER]: tools, remote: { url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer t' } } }, new Map())
    const servers = made.mcp.mcpServers as Record<string, Record<string, unknown>>
    expect(servers[TOOLS_SERVER]).toEqual({ command: tools.command, args: tools.args, env: tools.env })
    expect(servers.remote).toEqual({ url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer t' } })
    expect(made.refused).toBeUndefined()
  })

  it('a Streamable HTTP server goes as its url and headers; a legacy HTTP+SSE one is left out, and the user told why (HI-2547)', () => {
    const given = { [TOOLS_SERVER]: tools, http: { type: 'http', url: 'https://a/mcp' }, old: { type: 'sse', url: 'https://b/sse' }, old2: { type: 'SSE', url: 'https://c/sse' } }
    const servers = profileConfig(given, new Map()).mcp.mcpServers as Record<string, unknown>
    expect(Object.keys(servers)).toEqual([TOOLS_SERVER, 'http'])
    expect(servers.http).toEqual({ url: 'https://a/mcp' })
    expect(agyServer({ type: 'sse', url: 'https://b/sse' })).toBeNull()
    expect(legacySseServers(given)).toEqual(['old', 'old2'])
    const notice = antigravity.launchNotice({ mcpServers: given, permissionMode: 'accept-edits' } as never)
    expect(notice?.message).toMatch(/The MCP servers old and old2 use the legacy HTTP\+SSE transport/)
    expect(antigravity.launchNotice({ mcpServers: { [TOOLS_SERVER]: tools }, permissionMode: 'accept-edits' } as never)).toBeNull()
  })

  it("Auto's sandbox needs 24H2 with the August 2026 update (revision 9168 of 26100 and 26200): below it, or unknown, is said", () => {
    expect([AUTO_MIN_BUILD, AUTO_SHARED_SERVICING, AUTO_MIN_REVISION]).toEqual([26100, 26200, 9168])
    expect(autoSandbox({ build: 22631, revision: 9999 })).toBe('old')
    // HR1's case: 24H2 itself, but before the August 2026 update.
    expect(autoSandbox({ build: 26100, revision: 8000 })).toBe('old')
    expect(autoSandbox({ build: 26100, revision: 9167 })).toBe('old')
    expect(autoSandbox({ build: 26100, revision: 9168 })).toBe('ok')
    expect(autoSandbox({ build: 26200, revision: 8973 })).toBe('old')
    expect(autoSandbox({ build: 26200, revision: 9278 })).toBe('ok')
    expect(autoSandbox({ build: 26300, revision: 1 })).toBe('ok')
    expect(autoSandbox({ build: 26100, revision: null })).toBe('unknown')
    expect(autoSandbox({ build: null, revision: 9168 })).toBe('unknown')
    expect(autoSandbox({ build: 22631, revision: null })).toBe('old')
    // reg.exe's output: REG_SZ decimal (CurrentBuildNumber), REG_DWORD hex (UBR).
    const key = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
    expect(regNumber(`\r\n${key}\r\n    CurrentBuildNumber    REG_SZ    26100\r\n\r\n`)).toBe(26100)
    expect(regNumber(`\r\n${key}\r\n    UBR    REG_DWORD    0x23d0\r\n\r\n`)).toBe(9168)
    expect(regNumber(`\r\n${key}\r\n    UBR    REG_SZ    x9\r\n`)).toBeNull()
    expect(regNumber(null)).toBeNull()
  })

  it('the Auto notice follows what was read: the version below it named, an unread one said unknown, none in another mode', () => {
    const a = antigravity as unknown as { windows: unknown }
    const was = a.windows
    try {
      a.windows = { build: 26100, revision: 8000 }
      expect(antigravity.launchNotice({ mcpServers: {}, permissionMode: 'auto' } as never)?.message).toMatch(/August 2026 update or later\. This PC runs Windows build 26100\.8000/)
      a.windows = { build: 26100, revision: null }
      expect(antigravity.launchNotice({ mcpServers: {}, permissionMode: 'auto' } as never)?.message).toMatch(/couldn’t read this PC’s Windows version/)
      a.windows = null
      expect(antigravity.launchNotice({ mcpServers: {}, permissionMode: 'auto' } as never)?.message).toMatch(/couldn’t read this PC’s Windows version/)
      a.windows = { build: 26200, revision: 9168 }
      expect(antigravity.launchNotice({ mcpServers: {}, permissionMode: 'auto' } as never)).toBeNull()
      a.windows = { build: 22631, revision: 1 }
      expect(antigravity.launchNotice({ mcpServers: {}, permissionMode: 'ask' } as never)).toBeNull()
    } finally {
      a.windows = was
    }
  })

  it('this PC’s version reads from the registry, its build matching os.release', async () => {
    if (process.platform !== 'win32') return
    const v = await windowsVersion()
    expect(v.build).toBe(Number(release().split('.')[2]))
    expect(v.revision === null || Number.isSafeInteger(v.revision)).toBe(true)
  })

  it("a project server the agent wasn't given refuses the launch, naming its file: nothing stands in for it", () => {
    const made = profileConfig({ [TOOLS_SERVER]: tools }, workspace)
    expect(made.refused).toEqual(new Map([['sentinel', project]]))
    expect(Object.keys(made.mcp.mcpServers as object)).toEqual([TOOLS_SERVER])
    expect(profileConfig({}, workspace).refused?.has('sentinel')).toBe(true)
  })

  it('given under its name counts only as the very same server (were the given one to end, agy would start the project’s)', () => {
    // Identical in every field: allowed (an empty args, env or headers is the same as none).
    expect(profileConfig({ sentinel: { command: 'node', args: ['sentinel.js'] } }, workspace).refused).toBeUndefined()
    expect(profileConfig({ sentinel: { command: 'node', args: ['sentinel.js'], env: { M: 'a' } } }, one('sentinel', { command: 'node', args: ['sentinel.js'], env: { M: 'a' } })).refused).toBeUndefined()
    expect(profileConfig({ r: { url: 'https://mcp.example/mcp' } }, one('r', { url: 'https://mcp.example/mcp', headers: {} })).refused).toBeUndefined()
    // Other code: other arguments, or the same command and arguments with another environment (HR1: a server that loads
    // process.env.MODULE runs other code), or an environment only one has.
    expect(profileConfig({ sentinel: { command: 'node', args: ['other.js'] } }, workspace).refused?.get('sentinel')).toBe(project)
    expect(profileConfig({ sentinel: { command: 'node', args: ['server.cjs'], env: { MODULE: 'approved.cjs' } } }, one('sentinel', { command: 'node', args: ['server.cjs'], env: { MODULE: 'excluded.cjs' } })).refused?.has('sentinel')).toBe(true)
    expect(profileConfig({ sentinel: { command: 'node', args: ['sentinel.js'], env: { K: 'v' } } }, workspace).refused?.has('sentinel')).toBe(true)
    // Another account or scope: the same URL with other headers, or headers only one has.
    expect(profileConfig({ r: { url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer mine' } } }, one('r', { url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer other' } })).refused?.has('r')).toBe(true)
    expect(profileConfig({ r: { url: 'https://mcp.example/mcp' } }, one('r', { url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer other' } })).refused?.has('r')).toBe(true)
    // A field Combwork doesn't give (another transport, working folder, anything unrecognised): not the same.
    expect(profileConfig({ sentinel: { command: 'node', args: ['sentinel.js'] } }, one('sentinel', { command: 'node', args: ['sentinel.js'], cwd: 'C:\\elsewhere' })).refused?.has('sentinel')).toBe(true)
    expect(profileConfig({ r: { url: 'https://mcp.example/mcp' } }, one('r', { url: 'https://mcp.example/mcp', type: 'sse' })).refused?.has('r')).toBe(true)
    // Every definition of the name must be the same: one other among several refuses, naming its file.
    const other = join('C:\\repo', '_agents', 'mcp_config.json')
    const both = new Map([['sentinel', [{ file: project, def: { command: 'node', args: ['sentinel.js'] } }, { file: other, def: { command: 'node', args: ['evil.js'] } }]]])
    expect(profileConfig({ sentinel: { command: 'node', args: ['sentinel.js'] } }, both).refused?.get('sentinel')).toBe(other)
    // Combwork's own server's name in a project's file is refused too, unless it is Combwork's server as given.
    expect(profileConfig({ [TOOLS_SERVER]: tools }, one(TOOLS_SERVER, { command: 'evil.exe' })).refused?.has(TOOLS_SERVER)).toBe(true)
    expect(sameServer({ url: 'https://a' }, { command: 'https://a' })).toBe(false)
    expect(sameServer({}, {})).toBe(false)
    expect(sameServer({ env: { A: '1' } }, { env: { A: '1' } })).toBe(false)
  })

  it('a server named __proto__, constructor or toString is an entry like any other; nothing inherited counts as given', () => {
    const given = JSON.parse('{"__proto__":{"command":"node","args":["p.cjs"]},"constructor":{"command":"node","args":["c.cjs"]},"toString":{"command":"node","args":["t.cjs"]}}')
    const made = profileConfig(given, new Map())
    // Serialised as written to the profile: each its own entry (compared as text, as an object literal's __proto__ sets a prototype).
    expect(JSON.stringify(made.mcp)).toBe('{"mcpServers":{"__proto__":{"command":"node","args":["p.cjs"]},"constructor":{"command":"node","args":["c.cjs"]},"toString":{"command":"node","args":["t.cjs"]}}}')
    expect(Object.keys(made.mcp.mcpServers as object).sort()).toEqual(['__proto__', 'constructor', 'toString'])
    // A project's server of such a name, not given: refused, never taken for an inherited property.
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(profileConfig({}, one(name, { command: 'x' })).refused?.has(name), name).toBe(true)
    // Given as the very same server under such a name: allowed.
    expect(profileConfig(JSON.parse('{"constructor":{"command":"x"}}'), one('constructor', { command: 'x' })).refused).toBeUndefined()
  })

  it('agy’s form of a server: stdio or Streamable HTTP; one with neither is left out', () => {
    expect(agyServer({ command: 'node', args: [], env: {} })).toEqual({ command: 'node', env: {} })
    expect(agyServer({ description: 'x' })).toBeNull()
  })

  it('kept per agent (a moved project finds it unchanged); the Assistant’s per workspace', () => {
    expect(profileFolder('a-12ab34cd', 'C:\\ws1')).toBe(profileFolder('a-12ab34cd', 'D:\\moved\\ws1'))
    expect(profileFolder('assistant', 'C:\\ws1')).not.toBe(profileFolder('assistant', 'C:\\ws2'))
    expect(profileFolder('assistant', 'C:\\WS1')).toBe(profileFolder('assistant', 'c:\\ws1'))
  })
})

describe('launch settings and arguments (1.5.0)', () => {
  const ctx = { hookUrl: 'http://127.0.0.1:47822/hook?run=r1', hookAuthFile: 'C:\\Users\\Jo Smith\\launch\\hook-auth.txt', mcpServers: { [TOOLS_SERVER]: { command: 'c' } }, trustedCombworkTools: undefined }

  it("the status line is Combwork's own command (the run's URL and token), which agy's cmd /c can run", () => {
    const s = launchSettings(ctx, true) as { statusLine: { type: string; command: string }; permissions?: { allow: string[] } }
    expect(s.statusLine.type).toBe('command')
    expect(s.statusLine.command.startsWith('curl')).toBe(true)
    // No quote (agy escapes them for cmd, HI-2548): the token file's path is the launch's environment's, the & escaped.
    expect(s.statusLine.command).toContain('run=r1^&statusline')
    expect(s.statusLine.command).not.toContain('"')
    expect(antigravity.buildCommand('agy.exe', { ...ctx, agentId: 'a1', workspacePath: 'C:\\ws', privateDir: 'C:\\p', env: {}, overrides: {}, extraArgs: [], resume: false } as never).env?.CW_AGY_HOOK_AUTH).toBe('"@C:/Users/Jo Smith/launch/hook-auth.txt"')
    expect(s.permissions?.allow).toEqual([`mcp(${TOOLS_SERVER}/*)`])
    expect((launchSettings(ctx, false) as { permissions?: unknown }).permissions).toBeUndefined()
    expect((launchSettings({ ...ctx, trustedCombworkTools: ['cw_inbox'] }, true) as { permissions: { allow: string[] } }).permissions.allow).toEqual([`mcp(${TOOLS_SERVER}/cw_inbox)`])
  })

  const launch = { resume: false, sessionId: '', model: 'gemini-3.8-flash-low', effort: 'high', permissionMode: 'accept-edits', extraDirs: ['D:\\review copy'], extraArgs: ['--sandbox'], initialPrompt: 'Read the card' }
  it('a new launch: its settings, model, effort, mode, extra folders, the user’s arguments, then its first task', () => {
    expect(antigravityArgs(launch, 'P:\\agy-settings.json')).toEqual(['--settings', 'P:\\agy-settings.json', '--model', 'gemini-3.8-flash-low', '--effort', 'high', '--mode', 'accept-edits', '--add-dir', 'D:\\review copy', '--sandbox', '-i', 'Read the card'])
  })

  it('each mode’s flag: Ask none, the no-guardrails mode --dangerously-skip-permissions', () => {
    const flags = (permissionMode: string) => antigravityArgs({ ...launch, permissionMode, extraDirs: [], extraArgs: [], initialPrompt: undefined }, 's').slice(6)
    expect(flags('ask')).toEqual([])
    expect(flags('plan')).toEqual(['--mode', 'plan'])
    expect(flags('auto')).toEqual(['--mode', 'auto'])
    expect(flags('bypass')).toEqual(['--dangerously-skip-permissions'])
  })

  it('a resume reopens its conversation by id; anything but a conversation id is refused', () => {
    expect(antigravityArgs({ ...launch, resume: true, sessionId: CONV, extraDirs: [], extraArgs: [], initialPrompt: undefined }, 's').slice(0, 2)).toEqual(['--conversation', CONV])
    expect(() => antigravityArgs({ ...launch, resume: true, sessionId: '..\\other' }, 's')).toThrow()
  })
})

describe('conversation ids', () => {
  it("the status line's id, only when it is a conversation id (never a path)", () => {
    expect(statusLineConversation({ conversation_id: CONV })).toBe(CONV)
    expect(statusLineConversation({ session_id: CONV })).toBe(CONV)
    for (const v of ['', '..\\..\\x', 'not-an-id', 42, null]) expect(statusLineConversation({ conversation_id: v }), String(v)).toBeNull()
    expect(isConversationId(CONV.toUpperCase())).toBe(true)
  })

  it("a resume reopens only one of the agent's own conversations", async () => {
    const own = join(brainDir(profileFolder('a-own0001', 'C:\\ws')), CONV)
    mkdirSync(own, { recursive: true })
    expect(await antigravity.ownsConversation('a-own0001', 'C:\\ws', CONV)).toBe(true)
    // Another agent's, a missing one, or not an id at all.
    expect(await antigravity.ownsConversation('a-other001', 'C:\\ws', CONV)).toBe(false)
    expect(await antigravity.ownsConversation('a-own0001', 'C:\\ws', '88931470-dbf8-455e-8c2f-76840a752604')).toBe(false)
    expect(await antigravity.ownsConversation('a-own0001', 'C:\\ws', '..')).toBe(false)
  })
})

describe('the PC-wide sign-in (like Copilot’s)', () => {
  it("its own account, never Copilot's", () => {
    expect(pcWideSignIn('antigravity')).toBe(true)
    expect(pcWideSignIn('claude-code')).toBe(false)
    expect(pcAccountId('antigravity')).toBe('antigravity')
    expect(pcAccountId('copilot')).toBe('copilot')
  })

  it('made where missing, once; one already there (Copilot’s) is left as it is', () => {
    const store = { accounts: [{ id: 'copilot', provider: 'copilot', kind: 'signIn' as const, home: 'cli' as const, name: 'GitHub Copilot', createdAt: 'then' }], connections: [], newId: (() => { let n = 0; return () => `c-${++n}` })() }
    expect(ensurePcAccounts(store, 'now')).toBe(true)
    expect(store.accounts.map((a) => [a.id, a.provider, a.home, a.createdAt])).toEqual([['copilot', 'copilot', 'cli', 'then'], ['antigravity', 'antigravity', 'cli', 'now']])
    expect(store.connections.map((c: { account: string }) => c.account).sort()).toEqual(['antigravity', 'copilot'])
    expect(ensurePcAccounts(store, 'later')).toBe(false)
    expect(homeAccount(store, 'antigravity', 'later').createdAt).toBe('now')
  })
})

describe("agy's first-run screens, done once in Set up (HI-2547, Darren's (a))", () => {
  const marker = JSON.stringify({ consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, onboardingComplete: true })
  const state = 'post_onboarding: {\n  completed_steps: POST_ONBOARDING_STEP_TYPE_MANAGER_WELCOME\n  completed_steps: POST_ONBOARDING_STEP_TYPE_USAGE_MODE\n}\ninstallation_uuid: "11111111-2222-3333-4444-555555555555"\nmigrations: {\n  key: 3\n  value: MIGRATION_STATUS_COMPLETED\n}\n'
  const cli = (profile: string) => join(profile, '.gemini', 'antigravity-cli')

  it("copies only that they are done (onboarding.json, the post_onboarding block, never the installation id), and only once done", async () => {
    const from = join(base, 'onb-from')
    const to = join(base, 'onb-to')
    mkdirSync(join(cli(from), 'cache'), { recursive: true })
    expect(await copyOnboarding(from, to)).toBe(false)
    writeFileSync(join(cli(from), 'cache', 'onboarding.json'), marker)
    writeFileSync(join(cli(from), 'jetski_state.pbtxt'), state)
    expect(await copyOnboarding(from, to)).toBe(true)
    expect(await onboarded(to)).toBe(true)
    const copied = readFileSync(join(cli(to), 'jetski_state.pbtxt'), 'utf8')
    expect(copied).toMatch(/^post_onboarding: \{\n  completed_steps: POST_ONBOARDING_STEP_TYPE_MANAGER_WELCOME\n  completed_steps: POST_ONBOARDING_STEP_TYPE_USAGE_MODE\n\}\n$/)
    expect(copied).not.toContain('installation_uuid')
    // Done already: nothing again.
    expect(await copyOnboarding(from, to)).toBe(false)
    expect(onboardingComplete('{"onboardingComplete":false}')).toBe(false)
    expect(onboardingComplete('not json')).toBe(false)
    expect(postOnboardingBlock('installation_uuid: "x"\n')).toBeNull()
  })

  it("Set up runs agy in the check profile (never the user's own), in a folder of its own there that it trusts, typing nothing", () => {
    const s = antigravity.setupCommand('C:\\agy\\agy.exe')
    expect(s.env?.USERPROFILE).toBe(checkProfile())
    expect(s.cwd).toBe(join(checkProfile(), 'setup'))
    expect(s.keys).toEqual([])
    expect(s.args).toContain('--settings')
    expect(JSON.parse(readFileSync(s.args[s.args.indexOf('--settings') + 1], 'utf8'))).toEqual({ trustedWorkspaces: [join(checkProfile(), 'setup')] })
    expect(typeof s.done).toBe('function')
  })

  it("a launch trusts the folders it works in for that launch only (its own, a slot or review copy given)", () => {
    const s = launchSettings({ hookUrl: 'h', hookAuthFile: 'a', mcpServers: {}, trustedCombworkTools: undefined, cwd: 'C:\\repo', extraDirs: ['C:\\slot'] }, true) as Record<string, unknown>
    expect(s.trustedWorkspaces).toEqual(['C:\\repo', 'C:\\slot'])
  })
})

describe("Combwork's guidance in the agent's own GEMINI.md (HI-2547's listing check: agy auto-loads ~\\.gemini\\GEMINI.md)", () => {
  it('the guidance (with its tools), the launch instructions and the notes; nothing of the guidance without the tools', () => {
    const with_ = launchGuidance({ guidance: 'G', instructions: 'I', notes: 'N', mcpServers: { [TOOLS_SERVER]: { command: 'x' } } })
    expect(with_).toBe('G\n\nI\n\nN\n')
    expect(launchGuidance({ guidance: 'G', instructions: '', notes: '', mcpServers: {} })).toBe('')
    expect(GUIDANCE_FILE).toBe(join('.gemini', 'GEMINI.md'))
  })
  it("Combwork's own guidance fits agy's per-file cap (24,000 bytes), for an agent and the Assistant", () => {
    for (const role of ['agent', 'assistant'] as const) {
      const text = combworkInstructions('alpha', role)
      expect(Buffer.byteLength(text, 'utf8'), role).toBeLessThan(24000)
    }
  })

  // HR1: agy truncates a rules file over 24,000 UTF-8 bytes (Google's rules docs), so the whole file is held to it.
  const big = (bytes: number, unit = 'a'): string => unit.repeat(Math.floor(bytes / Buffer.byteLength(unit, 'utf8')))
  const tools = { [TOOLS_SERVER]: { command: 'x' } }
  it("the whole file's size is counted in UTF-8 bytes: guidance, instructions and notes with their separators", () => {
    expect(RULES_MAX_BYTES).toBe(24000)
    const g = combworkInstructions('alpha', 'agent')
    const text = launchGuidance({ guidance: g, instructions: big(3000, 'é'), notes: big(1500, '漢'), mcpServers: tools })
    expect(guidanceBytes(text)).toBe(Buffer.byteLength(g.trim(), 'utf8') + 3000 + 1500 + 2 + 2 + 1)
    expect(guidanceBytes('é')).toBe(2)
  })

  const launch = (instructions: string, notes = '') => {
    const profile = tempDir('agy-guidance-')
    return {
      ctx: { agentId: `size-${Math.random().toString(36).slice(2)}`, workspacePath: profile, cwd: profile, privateDir: profile, resume: false, guidance: 'G', instructions, notes, mcpServers: tools, permissionMode: 'accept-edits', skills: [], extraDirs: [], hookUrl: 'http://127.0.0.1:1/hook', hookAuthFile: 'auth', overrides: {}, env: {} } as never,
      profile
    }
  }
  it('a launch over the limit is refused before anything is written, naming both sizes (multibyte text, the first byte over)', async () => {
    // 'G', a separator (2) and a final newline: instructions of 23,996 bytes make exactly 24,000, one more byte is over.
    const at = launchGuidance({ guidance: 'G', instructions: big(23996), notes: '', mcpServers: tools })
    expect(guidanceBytes(at)).toBe(24000)
    const fits = launch(big(23994) + 'é')
    expect(guidanceBytes(launchGuidance(fits.ctx))).toBe(24000)
    await expect(antigravity.prepareLaunch(fits.ctx)).resolves.toBeDefined()
    expect(readFileSync(join(profileFolder((fits.ctx as { agentId: string }).agentId, fits.profile), GUIDANCE_FILE), 'utf8')).toBe(launchGuidance(fits.ctx))
    const over = launch(big(23995) + 'é')
    expect(guidanceBytes(launchGuidance(over.ctx))).toBe(24001)
    await expect(antigravity.prepareLaunch(over.ctx)).rejects.toThrow(/didn't start: .* come to 24,001 bytes, and Antigravity reads at most 24,000 bytes/)
    // HR1's probe: 24,000 bytes of instructions and 4,096 of notes.
    const probe = launch(big(24000), big(4096, '漢'))
    await expect(antigravity.prepareLaunch(probe.ctx)).rejects.toThrow(/Shorten the agent's instructions/)
    expect(existsSync(profileFolder((probe.ctx as { agentId: string }).agentId, probe.profile))).toBe(false)
  })
})

describe('an Independent launch in a profile a role agent used (HI-2731)', () => {
  it("leaves no Combwork guidance, server or agy's cache of the server; a role agent's launch has them", async () => {
    const { agyServerCache } = await import('../src/main/providers/antigravity/adapter')
    const ws = tempDir('agy-roles-')
    const ctx = (mcpServers: Record<string, unknown>) => ({ agentId: 'a-switch01', workspacePath: ws, cwd: ws, privateDir: ws, resume: false, guidance: 'Combwork guidance: cw_inbox', instructions: '', notes: '', mcpServers, permissionMode: 'accept-edits', skills: [], extraDirs: [], hookUrl: 'http://127.0.0.1:1/hook', hookAuthFile: 'auth', overrides: {}, env: {} }) as never
    const profile = profileFolder('a-switch01', ws)
    const cache = agyServerCache(profile, TOOLS_SERVER)
    const servers = (): string[] => Object.keys(JSON.parse(readFileSync(join(profile, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers)
    // As Either: the guidance, the server, and agy's cache of it as agy would leave it.
    await antigravity.prepareLaunch(ctx({ [TOOLS_SERVER]: { command: 'node', args: ['cw-mcp.js'] } }))
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, 'instructions.md'), 'Combwork guidance: cw_inbox')
    writeFileSync(join(cache, 'cw_inbox.json'), '{}')
    expect(readFileSync(join(profile, GUIDANCE_FILE), 'utf8')).toMatch(/cw_inbox/)
    expect(servers()).toEqual([TOOLS_SERVER])
    // As Independent (no combwork server: sessions.effective's): none of it is left for agy to load or find.
    await antigravity.prepareLaunch(ctx({}))
    expect(readFileSync(join(profile, GUIDANCE_FILE), 'utf8')).toBe('')
    expect(servers()).toEqual([])
    expect(existsSync(cache)).toBe(false)
    // As Either again: the guidance and server are back (agy rebuilds its cache itself).
    await antigravity.prepareLaunch(ctx({ [TOOLS_SERVER]: { command: 'node', args: ['cw-mcp.js'] } }))
    expect(readFileSync(join(profile, GUIDANCE_FILE), 'utf8')).toMatch(/cw_inbox/)
    expect(servers()).toEqual([TOOLS_SERVER])
  })
})

describe("a removed agent's profile (HI-2731, Darren's decision)", () => {
  it('goes to the Recycle Bin (a test copy’s trash folder), whole, and only its own', async () => {
    const was = process.env.CW_TEST_TRASH_DIR
    const bin = join(base, 'trash')
    process.env.CW_TEST_TRASH_DIR = bin
    try {
      const gone = profileFolder('a-gone0001', 'C:\\ws')
      const other = profileFolder('a-kept0001', 'C:\\ws')
      for (const p of [gone, other]) {
        mkdirSync(join(p, '.gemini', 'config'), { recursive: true })
        writeFileSync(join(p, GUIDANCE_FILE), 'guidance')
      }
      await antigravity.agentRemoved('a-gone0001', 'C:\\ws')
      expect(existsSync(gone)).toBe(false)
      expect(existsSync(join(other, GUIDANCE_FILE))).toBe(true)
      const moved = readFileSync(join(bin, 'trash.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { from: string; to: string })
      expect(moved.map((m) => m.from)).toEqual([gone])
      expect(readFileSync(join(moved[0].to, GUIDANCE_FILE), 'utf8')).toBe('guidance')
      // An agent that never ran on Antigravity has none: nothing to do.
      await expect(antigravity.agentRemoved('a-never001', 'C:\\ws')).resolves.toBeUndefined()
    } finally {
      if (was === undefined) delete process.env.CW_TEST_TRASH_DIR
      else process.env.CW_TEST_TRASH_DIR = was
    }
  })
})
