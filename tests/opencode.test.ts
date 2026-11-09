// OpenCode 2 as a provider (HI-2759, against 2.2.6; the runtime facts are HI-2758's, the recordings HI-2763's): readiness
// and versions (V1, the archived project and editor copies refused), the catalog from `opencode models` (Claude Agent's
// never offered), the environment (credentials stripped, ambient chains blocked, Combwork's roots and switches set last),
// the provider and MCP policies, the private config, saved credentials, session ids and the launch arguments.
import { readFileSync } from 'fs'
import { basename, join } from 'path'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-opencode-')
process.env.CW_USER_DATA = join(base, 'userdata')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { isRejectedPath, isSupportedVersion, newestV2, parseOpencodeVersion, installScript, opencodeUpdateCommand } = await import('../src/main/providers/opencode/install')
const { parseOpencodeModels } = await import('../src/main/providers/opencode/models')
const { ambientBlockers, credentialPattern, opencodeEnv, opencodeRoots } = await import('../src/main/providers/opencode/home')
const { chosenAmbient, checkConfig, launchConfig, loginConfig, mcpPolicies, opencodeServer, parseAuthList, providerPolicies } = await import('../src/main/providers/opencode/config')
const { isSessionId, newSessionId, protectedArg, launchGuidance } = await import('../src/main/providers/opencode/adapter')
const { LAUNCHER_SOURCE, launcherEnv } = await import('../src/main/providers/opencode/launcher')
const { OPENCODE_DESCRIPTOR, isClaudeAgentModel, isOpencodeModelId, opencodeAgentOf, opencodeModeFlags, opencodeModelLabel } = await import('../src/shared/opencode')
const { TOOLS_SERVER } = await import('../src/shared/assistantTools')

const FIX = join(__dirname, 'fixtures', 'advanced')
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8')
const AMBIENT = ['amazon-bedrock', 'google-vertex', 'azure']

describe('install and readiness (opencode 2.2.6)', () => {
  it('its version, as `opencode --version` prints it; only OpenCode 2 or later is used', () => {
    expect(parseOpencodeVersion(fixture('version-opencode-2.2.6.txt'))).toBe('2.2.6')
    expect(parseOpencodeVersion('opencode v2.3.0-beta.1\r\n')).toBe('2.3.0-beta.1')
    // V1's and the archived project's forms aren't this pattern: not found, so never used.
    expect(parseOpencodeVersion('1.19.5\n')).toBeNull()
    expect(parseOpencodeVersion('opencode version 0.0.55\n')).toBeNull()
    expect(isSupportedVersion('2.2.6')).toBe(true)
    expect(isSupportedVersion('1.19.5')).toBe(false)
    expect(isSupportedVersion('0.0.55')).toBe(false)
  })

  it("an editor's copy and OpenCode 1's npm package are never used; the standalone OpenCode 2 is", () => {
    expect(isRejectedPath('C:\\Users\\d\\.vscode\\extensions\\sst-dev.opencode-1.0\\bin\\opencode.exe')).toBe(true)
    expect(isRejectedPath('C:\\Users\\d\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe')).toBe(true)
    expect(isRejectedPath('C:\\Users\\d\\AppData\\Local\\Programs\\OpenCode\\opencode.exe')).toBe(false)
    expect(isRejectedPath('C:\\Users\\d\\AppData\\Roaming\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe')).toBe(false)
  })

  it('the newest OpenCode 2 release from GitHub\'s list, never the V1 release it labels "Latest", nor drafts and prereleases', () => {
    expect(newestV2([{ tag_name: 'v1.19.5' }, { tag_name: 'v2.2.5' }, { tag_name: 'v2.2.6' }, { tag_name: 'v2.3.0', prerelease: true }, { tag_name: 'v2.9.0', draft: true }, { tag_name: 'nightly' }, null])).toBe('2.2.6')
    expect(newestV2([{ tag_name: 'v1.19.5' }])).toBeNull()
  })

  it('install and update: the official standalone asset, checked against SHA256SUMS; npm installs through npm', () => {
    const s = installScript('C:\\Users\\O\'Neil\\AppData\\Local\\Programs\\OpenCode')
    expect(s).toContain("'^v2\\.\\d+\\.\\d+$'")
    expect(s).toContain('opencode-windows-$arch.zip')
    expect(s).toContain('SHA256SUMS')
    expect(s).toContain('Get-FileHash -Algorithm SHA256')
    expect(s).toContain("'C:\\Users\\O''Neil\\AppData\\Local\\Programs\\OpenCode'")
    expect(opencodeUpdateCommand('C:\\Users\\d\\AppData\\Roaming\\npm\\opencode.cmd').args.join(' ')).toContain('npm install -g @opencode/cli@latest')
    expect(opencodeUpdateCommand('D:\\tools\\oc\\opencode.exe').args.join(' ')).toContain("'D:\\tools\\oc'")
  })
})

describe('the catalog (opencode models)', () => {
  it('each provider/model line is a model, its id kept as listed; Claude Agent\'s and odd lines are left out', () => {
    const models = parseOpencodeModels(fixture('models-opencode-2.2.6.txt'))
    expect(models.map((m) => m.value)).toEqual(['ollama/qwen3:8b', 'opencode/big-pickle', 'opencode/crouton-alpha-free', 'opencode/glm-5.3-flash-free'])
    expect(models[0].label).toBe('qwen3:8b (ollama)')
    expect(parseOpencodeModels('claude-agent/claude-opus-5-5\nnot a model\nollama/qwen3:8b\nollama/qwen3:8b\n').map((m) => m.value)).toEqual(['ollama/qwen3:8b'])
  })

  it('model ids are unknown-safe: any provider/model is one, Claude Agent\'s is recognised in any case', () => {
    expect(isOpencodeModelId('openrouter/anthropic/claude-x')).toBe(true)
    expect(isOpencodeModelId('gpt-6')).toBe(false)
    expect(isClaudeAgentModel('Claude-Agent/opus')).toBe(true)
    expect(isClaudeAgentModel('anthropic/claude-opus-5-5')).toBe(false)
    expect(opencodeModelLabel('nolabel')).toBe('nolabel')
  })
})

describe('the environment (design s10, s13)', () => {
  const hostile = {
    PATH: 'C:\\Windows',
    XDG_DATA_HOME: 'C:\\Users\\d\\.local\\share',
    XDG_CONFIG_HOME: 'C:\\evil',
    OPENCODE_CONFIG_DIR: 'C:\\evil\\cfg',
    OPENCODE_CONFIG: 'C:\\evil\\opencode.json',
    OPENCODE_PASSWORD: 'evil',
    OPENCODE_DB: 'C:\\evil\\db',
    AWS_PROFILE: 'prod',
    AWS_SHARED_CREDENTIALS_FILE: 'C:\\Users\\d\\.aws\\credentials',
    GOOGLE_APPLICATION_CREDENTIALS: 'C:\\Users\\d\\adc.json',
    OPENAI_API_KEY: 'sk-x',
    GITHUB_TOKEN: 'ghp-x',
    HF_TOKEN: 'hf-x',
    CW_HOOK_TOKEN: 'keep-me',
    CW_AGENT: 'Agent 1'
  }

  it('inherited credentials and roots go; the ambient chains point at nothing; Combwork\'s roots, config, password and switches are set last', () => {
    const env = opencodeEnv({ base: hostile, home: 'C:\\acct\\a', configDir: 'C:\\priv\\cfg', password: 'pw', ambientDir: 'C:\\priv\\amb', strip: true, noUpdate: true, keepOut: true })
    expect(env).toMatchObject({ ...opencodeRoots('C:\\acct\\a'), OPENCODE_CONFIG_DIR: 'C:\\priv\\cfg', OPENCODE_PASSWORD: 'pw', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', PATH: 'C:\\Windows', CW_HOOK_TOKEN: 'keep-me', CW_AGENT: 'Agent 1' })
    expect(env).toMatchObject(ambientBlockers('C:\\priv\\amb'))
    for (const k of ['AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'HF_TOKEN', 'OPENCODE_CONFIG', 'OPENCODE_DB']) expect(env[k], k).toBeUndefined()
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe('C:\\priv\\amb\\aws-credentials')
  })

  it('two accounts get disjoint roots', () => {
    const a = opencodeRoots('C:\\acct\\a')
    const b = opencodeRoots('C:\\acct\\b')
    for (const k of Object.keys(a)) expect(a[k]).not.toBe(b[k as keyof typeof b])
  })

  it('with the switches off: credentials and the project config pass, but never over Combwork\'s roots, config or password', () => {
    const env = opencodeEnv({ base: hostile, home: 'C:\\acct\\a', configDir: 'C:\\priv\\cfg', password: 'pw', ambientDir: 'C:\\priv\\amb', strip: false, noUpdate: false, keepOut: false })
    expect(env).toMatchObject({ AWS_PROFILE: 'prod', OPENAI_API_KEY: 'sk-x', GITHUB_TOKEN: 'ghp-x', XDG_DATA_HOME: 'C:\\acct\\a', OPENCODE_CONFIG_DIR: 'C:\\priv\\cfg', OPENCODE_PASSWORD: 'pw' })
    for (const k of ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_CONFIG', 'OPENCODE_DB', 'METADATA_SERVER_DETECTION']) expect(env[k], k).toBeUndefined()
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe('C:\\Users\\d\\.aws\\credentials')
  })

  it('an ambient chain the account chose keeps its files; the others stay blocked', () => {
    const b = ambientBlockers('C:\\amb', new Set(['amazon-bedrock']))
    expect(b.AWS_CONFIG_FILE).toBeUndefined()
    expect(b.CLOUDSDK_CONFIG).toBe('C:\\amb\\gcloud')
    expect(b.AZURE_CONFIG_DIR).toBe('C:\\amb\\azure')
  })

  it("every variable OpenCode 2.2.6's integrations read is left out; Combwork's own never are", () => {
    const list = JSON.parse(fixture('integrations-opencode-2.2.6.json')) as { methods: { names?: string[] }[] }[]
    const names = list.flatMap((i) => i.methods.flatMap((m) => m.names ?? []))
    expect(names.length).toBeGreaterThan(200)
    const p = credentialPattern()
    for (const n of names) expect(p.test(n), n).toBe(true)
    const env = opencodeEnv({ base: Object.fromEntries([...names.map((n) => [n, 'x']), ['CW_HOOK_TOKEN', 't'], ['CW_API_TOKEN', 't']]), home: 'C:\\a', configDir: 'C:\\c', strip: true })
    expect(Object.keys(env).filter((k) => names.includes(k))).toEqual([])
    expect(env.CW_HOOK_TOKEN).toBe('t')
  })
})

describe('the policies and the private config (design s7 to s16)', () => {
  it("Claude Agent is denied always; the ambient integrations unless the account saved one; all when the listing failed; with the switch off only Claude Agent", () => {
    const saved = new Map([['amazon-bedrock', ['key']], ['anthropic', ['key']]])
    expect(providerPolicies(AMBIENT, saved, true)).toEqual([
      { action: 'provider.use', resource: 'claude-agent', effect: 'deny' },
      { action: 'provider.use', resource: 'google-vertex', effect: 'deny' },
      { action: 'provider.use', resource: 'azure', effect: 'deny' }
    ])
    expect(providerPolicies(AMBIENT, null, true).map((p) => p.resource)).toEqual(['claude-agent', ...AMBIENT])
    expect(providerPolicies(AMBIENT, saved, false)).toEqual([{ action: 'provider.use', resource: 'claude-agent', effect: 'deny' }])
    for (const strip of [true, false]) {
      expect(checkConfig(AMBIENT, saved, strip, true).policies).toContainEqual({ action: 'provider.use', resource: 'claude-agent', effect: 'deny' })
      expect(launchConfig({ model: null, agent: null, mcpServers: {}, instructions: [], ambient: AMBIENT, saved, strip, noUpdate: false }).policies).toContainEqual({ action: 'provider.use', resource: 'claude-agent', effect: 'deny' })
    }
    expect(loginConfig(true).policies).toContainEqual({ action: 'provider.use', resource: 'claude-agent', effect: 'deny' })
  })

  it("an ambient chain is chosen only by a saved credential with that integration's external method, never by a key or another integration's row", () => {
    expect([...chosenAmbient(new Map([['amazon-bedrock', ['aws-profile']]]))]).toEqual(['amazon-bedrock'])
    expect([...chosenAmbient(new Map([['amazon-bedrock', ['key']], ['anthropic', ['aws-profile']], ['azure', ['key']]]))]).toEqual([])
    expect([...chosenAmbient(null)]).toEqual([])
  })

  it('MCP: every server denied, then each given allowed by name; local commands and remote URLs in 2.2.6\'s shape', () => {
    expect(mcpPolicies(['combwork'])).toEqual([{ action: 'mcp.use', resource: '*', effect: 'deny' }, { action: 'mcp.use', resource: 'combwork', effect: 'allow' }])
    expect(opencodeServer({ command: 'node', args: ['cw-mcp.js'], env: { CW_TOKEN: 't' } })).toEqual({ type: 'local', command: ['node', 'cw-mcp.js'], environment: { CW_TOKEN: 't' } })
    expect(opencodeServer({ url: 'http://127.0.0.1:9/mcp', headers: { a: 'b' } })).toEqual({ type: 'remote', url: 'http://127.0.0.1:9/mcp', headers: { a: 'b' } })
    expect(opencodeServer({})).toBeNull()
  })

  it('a launch config: the update hold, the model, the agent, the servers allowed, the instructions given explicitly', () => {
    const cfg = launchConfig({ model: 'ollama/qwen3:8b', agent: 'plan', mcpServers: { combwork: { command: 'node', args: ['x'] }, __proto__: { command: 'y' } } as never, instructions: ['C:\\p\\AGENTS.md'], ambient: AMBIENT, saved: null, strip: true, noUpdate: true })
    expect(cfg).toMatchObject({ update: 'disable', model: 'ollama/qwen3:8b', default_agent: 'plan', instructions: ['C:\\p\\AGENTS.md'] })
    expect(Object.keys((cfg.mcp as { servers: object }).servers)).toEqual(['combwork'])
    expect(cfg.policies).toContainEqual({ action: 'mcp.use', resource: '*', effect: 'deny' })
    expect(launchConfig({ model: null, agent: null, mcpServers: {}, instructions: [], ambient: AMBIENT, saved: null, strip: true, noUpdate: false })).not.toHaveProperty('update')
  })

  it("saved credentials from `opencode auth list --format json` (HI-2758's shape): methods by integration, env connections apart", () => {
    const r = parseAuthList(JSON.stringify([{ id: 'probe', name: 'Probe Ollama', connections: [{ type: 'credential', id: 'cred_1', label: 'a-saved', method: 'key' }, { type: 'env', name: 'PROBE_API_KEY' }] }, { id: 'anthropic', name: 'Anthropic', connections: [{ type: 'env', name: 'ANTHROPIC_API_KEY' }] }]))!
    expect([...r.saved]).toEqual([['probe', ['key']]])
    expect(r.integrations).toEqual([{ id: 'probe', name: 'Probe Ollama', saved: 1, env: ['PROBE_API_KEY'] }, { id: 'anthropic', name: 'Anthropic', saved: 0, env: ['ANTHROPIC_API_KEY'] }])
    expect(parseAuthList('[]')!.saved.size).toBe(0)
    expect(parseAuthList('Error: no server')).toBeNull()
  })

  it("guidance goes in the private config's AGENTS.md: Combwork's only with its tools, then the instructions and notes", () => {
    expect(launchGuidance({ guidance: 'G', instructions: 'I', notes: 'N', mcpServers: { [TOOLS_SERVER]: {} } })).toBe('G\n\nI\n\nN\n')
    expect(launchGuidance({ guidance: 'G', instructions: '', notes: '', mcpServers: {} })).toBe('')
  })
})

describe('sessions, modes and the launch', () => {
  it("Combwork picks a session id OpenCode's API takes (`ses_` and 26 base62), never a path or a quote", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()))
    expect(ids.size).toBe(50)
    for (const id of ids) {
      expect(id).toMatch(/^ses_[A-Za-z0-9]{26}$/)
      expect(isSessionId(id)).toBe(true)
    }
    for (const bad of ['', 'xyz', '12b14cd0-6972-4a51-8d38-f8c898d76659', 'ses_..\\x', 'ses_a"b']) expect(isSessionId(bad), bad).toBe(false)
  })

  it('modes: Build and Plan by their agent, Approve all by --auto; the CLI\'s own passes nothing', () => {
    expect(OPENCODE_DESCRIPTOR.permissionModes.map((m) => m.value)).toEqual(['build', 'plan', 'auto', 'cli-own'])
    expect(OPENCODE_DESCRIPTOR.permissionModes.find((m) => m.value === 'auto')?.danger).toBe(true)
    expect([opencodeAgentOf('build'), opencodeAgentOf('plan'), opencodeAgentOf('auto'), opencodeAgentOf('cli-own')]).toEqual(['build', 'plan', 'build', null])
    expect([opencodeModeFlags('auto'), opencodeModeFlags('plan')]).toEqual([['--auto'], []])
  })

  it("an agent's extra arguments may not set what Combwork does: the server, the session, the mode", () => {
    for (const a of ['--server http://x', '--standalone', '--session=ses_1', '-s ses_1', '--continue', '-c', '--auto', '--prompt hi']) expect(protectedArg([a]), a).not.toBeNull()
    expect(protectedArg(['--log-level debug'])).toBeNull()
  })

  it("the launcher is told what it runs in its environment; its source holds every step of the recipe", () => {
    const env = launcherEnv({ executable: 'C:\\oc\\opencode.exe', cwd: 'C:\\p', sessionId: 'ses_x', intent: 'resume', tuiArgs: ['--auto'], dirs: ['C:\\p', 'C:\\q'], privateDir: 'C:\\priv', owner: '1:2', marks: 'C:\\acct\\combwork-sessions', readyMs: 30000 })
    expect(env).toMatchObject({ CW_OC_EXE: 'C:\\oc\\opencode.exe', CW_OC_INTENT: 'resume', CW_OC_TUI_ARGS: '--auto', CW_OC_DIRS: 'C:\\p\u001fC:\\q', CW_OC_INFO: 'C:\\priv\\opencode-server.json', CW_OC_OWNER: '1:2' })
    for (const step of ['0x2000', 'AssignProcessToJobObject(job, GetCurrentProcess())', '"serve", "--hostname", "127.0.0.1"', '/api/info', '"--server", url, "--session", session', 'WaitHandle.WaitAny', 'c != created']) expect(LAUNCHER_SOURCE, step).toContain(step)
    // New sessions only are created; a resume never POSTs.
    const resume = LAUNCHER_SOURCE.slice(LAUNCHER_SOURCE.indexOf('} else {\n      if (got == 404)'))
    expect(resume.slice(0, resume.indexOf('try {'))).not.toContain('POST')
  })
})

describe.runIf(process.platform === 'win32')('a launch prepared and built (against the fake opencode 2.2.6)', async () => {
  const { opencode } = await import('../src/main/providers/opencode/adapter')
  const { createRequire } = await import('module')
  const { existsSync, mkdirSync, writeFileSync } = await import('fs')
  const { childEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { childEnv: (vars?: Record<string, string>) => Record<string, string> }
  const FAKE = join(__dirname, 'e2e', 'fake-opencode', 'opencode.cmd')
  const ctx = (over: Record<string, unknown> = {}) => {
    const cwd = join(base, 'proj')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'AGENTS.md'), '# project rules\n')
    return {
      projectPath: cwd, agentId: 'a-1', executable: FAKE, cwd, workspacePath: base, runId: `r-${Math.random()}`, sessionId: newSessionId(),
      resume: false, name: '', skills: [], mcpServers: { [TOOLS_SERVER]: { command: 'node', args: ['cw-mcp.js'], env: { CW_TOKEN: 't' } } }, model: 'ollama/qwen3:8b', effort: null, permissionMode: 'plan', extraArgs: [],
      hookUrl: 'http://127.0.0.1:5000/hook?run=r1', hookAuthFile: join(base, 'auth.txt'), privateDir: join(base, `private-${Math.random()}`), guidance: 'Combwork guidance', allowBackgroundSessions: false, use200kContext: false,
      env: childEnv({ OPENAI_API_KEY: 'sk-ambient', CW_AGENT: 'Agent 1' }), connectionHome: join(base, 'accounts', 'oc-1'),
      overrides: { 'opencode.override.noAutoUpdate': true, 'opencode.override.keepProjectConfigOut': true, 'opencode.override.stripCredentials': true },
      ...over
    } as never
  }

  it('the private config (servers allowed by name, Claude Agent and the ambient chains denied, the project AGENTS.md given), the launcher\'s command and environment', async () => {
    const c = ctx() as { privateDir: string; sessionId: string; connectionHome: string; cwd: string }
    expect(await opencode.prepareLaunch(c as never)).toEqual({})
    const cfg = JSON.parse(readFileSync(join(c.privateDir, 'opencode-config', 'opencode.json'), 'utf8'))
    expect(cfg).toMatchObject({ update: 'disable', model: 'ollama/qwen3:8b', default_agent: 'plan', instructions: [join(c.cwd, 'AGENTS.md')], mcp: { servers: { [TOOLS_SERVER]: { type: 'local', command: ['node', 'cw-mcp.js'], environment: { CW_TOKEN: 't' } } } } })
    expect(cfg.policies.map((p: { resource: string; effect: string }) => `${p.resource}:${p.effect}`)).toEqual(['claude-agent:deny', 'amazon-bedrock:deny', 'google-vertex:deny', 'azure:deny', '*:deny', `${TOOLS_SERVER}:allow`])
    expect(JSON.parse(readFileSync(join(c.privateDir, 'opencode-config', 'service.json'), 'utf8'))).toEqual({ disabled: true })
    expect(readFileSync(join(c.privateDir, 'opencode-config', 'AGENTS.md'), 'utf8')).toBe('Combwork guidance\n')
    const cmd = opencode.buildCommand(FAKE, c as never)
    expect(cmd.file.toLowerCase()).toMatch(/powershell\.exe$/)
    expect(cmd.env).toMatchObject({ XDG_DATA_HOME: c.connectionHome, OPENCODE_CONFIG_DIR: join(c.privateDir, 'opencode-config'), OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', CW_OC_INTENT: 'new', CW_OC_SESSION: c.sessionId, CW_AGENT: 'Agent 1' })
    expect(cmd.env!.OPENCODE_PASSWORD).toMatch(/^[0-9a-f]{48}$/)
    const [ownerPid, created] = cmd.env!.CW_OC_OWNER.split(':')
    expect([ownerPid, /^[0-9]{15,19}$/.test(created)]).toEqual([String(process.pid), true])
    expect(cmd.env!.OPENAI_API_KEY).toBeUndefined()
    // A bare Node launcher (the fake's opencode.cmd) runs as its node and script; anything else .cmd goes through cmd.exe.
    expect([basename(cmd.env!.CW_OC_EXE).toLowerCase(), basename(cmd.env!.CW_OC_PREFIX)]).toEqual(['node.exe', 'fake-opencode.cjs'])
    // Built once: a second build of the same launch is a bug.
    expect(() => opencode.buildCommand(FAKE, c as never)).toThrow()
  }, 60000)

  it("refuses Claude Agent's models, Combwork's own flags in extra arguments, and a resume of a session another account made", async () => {
    await expect(opencode.prepareLaunch(ctx({ model: 'claude-agent/claude-opus-5-5' }))).rejects.toThrow(/Claude Agent/)
    await expect(opencode.prepareLaunch(ctx({ extraArgs: ['--server http://evil'] }))).rejects.toThrow(/--server/)
    await expect(opencode.prepareLaunch(ctx({ resume: true }))).rejects.toThrow(/another OpenCode account/)
  }, 60000)

  it('resumes a session the account made (its record there), as a resume', async () => {
    const c = ctx({ resume: true }) as { connectionHome: string; sessionId: string }
    const { sessionMark } = await import('../src/main/providers/opencode/launcher')
    mkdirSync(join(c.connectionHome, 'combwork-sessions'), { recursive: true })
    writeFileSync(sessionMark(c.connectionHome, c.sessionId), '{}')
    await opencode.prepareLaunch(c as never)
    expect(opencode.buildCommand(FAKE, c as never).env).toMatchObject({ CW_OC_INTENT: 'resume' })
    expect(existsSync(sessionMark(c.connectionHome, c.sessionId))).toBe(true)
  }, 60000)
})

describe("the real tier's test provider (CW_TEST_OPENCODE_PROVIDER, HI-2763): a test seam, never the production recipe", async () => {
  const { testProviderOf, withTestProvider } = await import('../src/main/providers/opencode/config')
  const raw = JSON.stringify({ id: 'cwtest', baseURL: 'http://127.0.0.1:47123/v1', model: 'qwen3:8b' })

  it('read only by an unpackaged build, only well formed, only on loopback', () => {
    expect(testProviderOf(raw, false)).toEqual({ id: 'cwtest', baseURL: 'http://127.0.0.1:47123/v1', model: 'qwen3:8b' })
    expect(testProviderOf(raw, true)).toBeNull()
    expect(testProviderOf(undefined, false)).toBeNull()
    for (const bad of ['not json', JSON.stringify({ id: 'cwtest', baseURL: 'https://api.example.com/v1', model: 'm' }), JSON.stringify({ id: 'Bad Id', baseURL: 'http://127.0.0.1:1/v1', model: 'm' }), JSON.stringify({ id: 'x', baseURL: 'http://127.0.0.1:1/v1', model: '' })]) expect(testProviderOf(bad, false), bad).toBeNull()
  })

  it('unset, every config is exactly as written; set, its provider, a deny-all but it in place of the provider policies (the MCP ones kept), and on a launch its model', () => {
    const launch = launchConfig({ model: 'ollama/qwen3:8b', agent: 'build', mcpServers: { combwork: { command: 'node' } }, instructions: [], ambient: AMBIENT, saved: null, strip: true, noUpdate: true })
    expect(withTestProvider(launch, null, true)).toBe(launch)
    const tp = testProviderOf(raw, false)!
    const t = withTestProvider(launch, tp, true)
    expect(t).toMatchObject({ update: 'disable', model: 'cwtest/qwen3:8b', providers: { cwtest: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'http://127.0.0.1:47123/v1' }, models: { 'qwen3:8b': { name: 'qwen3:8b' } } } } })
    expect((t.policies as { action: string; resource: string; effect: string }[]).map((p) => `${p.action}:${p.resource}:${p.effect}`)).toEqual(['provider.use:*:deny', 'provider.use:cwtest:allow', 'mcp.use:*:deny', 'mcp.use:combwork:allow'])
    const check = withTestProvider(checkConfig(AMBIENT, null, true, true), tp, false)
    expect(check.model).toBeUndefined()
    expect((check.policies as { resource: string }[])[0]).toEqual({ action: 'provider.use', resource: '*', effect: 'deny' })
    expect((withTestProvider(loginConfig(true), tp, false).policies as { resource: string }[]).map((p) => p.resource)).toEqual(['*', 'cwtest', '*'])
  })
})

describe.runIf(process.platform === 'win32')("an account's Set Up (HR1 on HI-2759: never the raw CLI)", async () => {
  const { opencode } = await import('../src/main/providers/opencode/adapter')
  const FAKE = join(__dirname, 'e2e', 'fake-opencode', 'opencode.cmd')

  it("is its sign-in, prepared as one: auth login, standalone, on the account's roots and its own login config, the switches set", () => {
    const home = join(base, 'accounts', 'oc-setup')
    const cmd = opencode.accountSetUpCommand(FAKE, home)
    expect(cmd.args.slice(-3)).toEqual(['auth', 'login', '--standalone'])
    expect(cmd.env).toMatchObject({ XDG_DATA_HOME: home, OPENCODE_CONFIG_DIR: join(home, 'combwork-login'), OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' })
    const cfg = JSON.parse(readFileSync(join(home, 'combwork-login', 'opencode.json'), 'utf8'))
    expect(cfg.policies).toContainEqual({ action: 'provider.use', resource: 'claude-agent', effect: 'deny' })
    expect(JSON.parse(readFileSync(join(home, 'combwork-login', 'service.json'), 'utf8'))).toEqual({ disabled: true })
  })
})
