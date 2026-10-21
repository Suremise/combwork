import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parse as parseToml } from 'smol-toml'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { advanced } from '../src/main/advanced'
import { overridesNow } from '../src/main/advancedValues'
import { claudeCode } from '../src/main/providers/claude/adapter'
import { codex, outrankNativeHive } from '../src/main/providers/codex/adapter'
import { copilot } from '../src/main/providers/copilot/adapter'
import { copilotEnv } from '../src/main/providers/copilot/home'
import { copilotCheckEnv, copilotSignIn, ignoredTokens } from '../src/main/providers/copilot/install'
import { catalogArgs } from '../src/main/providers/copilot/models'
import type { LaunchContext } from '../src/main/providers/types'
import { ADVANCED_DEFS, advancedDef, overrideId, rightClickToCliId } from '../src/shared/advanced'
import { HIVE_TOOLS } from '../src/shared/assistantTools'
import { tempDir } from './tempDir'

// The off switches for Hive's overrides of the CLIs' own behaviour (#966, #1167): each one's effect on the launch, on and off.

const base = tempDir('hive-cli-overrides-')
const homes = { CODEX_HOME: process.env.CODEX_HOME, COPILOT_HOME: process.env.COPILOT_HOME }
beforeAll(() => {
  // Never the user's own homes: the adapters read their config.
  process.env.CODEX_HOME = join(base, 'codex-home')
  process.env.COPILOT_HOME = join(base, 'copilot-home')
  mkdirSync(join(base, 'profile'), { recursive: true })
  advanced.load(join(base, 'profile'))
})
afterEach(async () => {
  await advanced.resetAll()
})
afterAll(() => {
  advanced.stop()
  for (const [k, v] of Object.entries(homes)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(base, { recursive: true, force: true })
})

function context(over: Partial<LaunchContext> = {}): LaunchContext {
  const cwd = join(base, 'proj')
  mkdirSync(cwd, { recursive: true })
  return {
    projectPath: cwd, agentId: 'a-1', executable: 'C:\\bin\\cli.exe', cwd, workspacePath: base, runId: 'r1', sessionId: '0cb916db-26aa-40f2-86b5-1ba81b225fd2',
    resume: false, name: '', skills: [], mcpServers: { hive: { command: 'node', args: ['hive-mcp.js'] } }, model: null, effort: null, permissionMode: null, extraArgs: [],
    hookUrl: 'http://127.0.0.1:5000/hook?run=r1', hookAuthFile: join(base, 'auth.txt'), privateDir: join(base, 'private'), guidance: 'Hive guidance', allowBackgroundSessions: false, use200kContext: false,
    env: { PATH: 'C:\\Windows' },
    ...over
  }
}

describe('the override switches', () => {
  it('are booleans, on by default (what Hive does today), named <provider>.override.<what>, taken by sessions started afterwards', () => {
    const switches = ADVANCED_DEFS.filter((d) => d.override)
    expect(switches.map((d) => d.id).sort()).toEqual([
      'claude-code.override.mcpIsolation', 'claude-code.override.preApproveHiveTools', 'claude-code.override.promptSnapshotOff', 'claude-code.override.statusLine',
      'codex.override.mcpIsolation', 'codex.override.preApproveHiveTools', 'codex.override.terminalTitle',
      'copilot.override.allMcpInstructions', 'copilot.override.mcpIsolation', 'copilot.override.noAutoUpdate', 'copilot.override.preApproveHiveTools', 'copilot.override.stripGitHubTokens'
    ])
    for (const d of switches) {
      expect(d, d.id).toMatchObject({ kind: 'boolean', default: true, applies: 'sessions' })
      expect(d.id).toBe(overrideId(d.group, d.id.split('.').slice(2).join('.')))
    }
    // Every id of that form is marked as one.
    expect(ADVANCED_DEFS.filter((d) => d.id.split('.')[1] === 'override' && !d.override)).toEqual([])
  })

  it('pass right-click to each CLI (row 25): off by default, taken at once', () => {
    for (const p of ['claude-code', 'codex', 'copilot']) expect(advancedDef(rightClickToCliId(p)), p).toMatchObject({ kind: 'boolean', default: false, applies: 'now' })
  })
})

describe('Claude Code: --system-prompt-snapshot off on the Assistant’s resumes (row 20)', () => {
  const assistant = (): LaunchContext => context({ resume: true, cliVersion: '2.1.305', instructions: 'You are in Planner mode.' })
  const snapshot = (): string[] => claudeCode.buildCommand('C:\\bin\\claude.exe', assistant()).args.filter((a, i, all) => a === '--system-prompt-snapshot' || all[i - 1] === '--system-prompt-snapshot')

  it('is passed with the switch on, and left out with it off', async () => {
    expect(snapshot()).toEqual(['--system-prompt-snapshot', 'off'])
    await advanced.set(overrideId('claude-code', 'promptSnapshotOff'), false)
    expect(snapshot()).toEqual([])
    // Hive's other launch arguments stay.
    expect(claudeCode.buildCommand('C:\\bin\\claude.exe', assistant()).args).toContain('--append-system-prompt-file')
  })
})

describe("Codex: its terminal title (row 34)", () => {
  const title = (ctx = context()): string[] => codex.buildCommand('C:\\bin\\codex.exe', ctx).args.filter((a) => a.startsWith('tui.terminal_title='))

  it('is set with the switch on, and left to the user’s config with it off, the status then going by the hooks', async () => {
    expect(title()).toEqual(['tui.terminal_title=["activity","project-name"]'])
    expect(codex.titleAttention!('0.163.0')).toBeTypeOf('function')
    await advanced.set(overrideId('codex', 'terminalTitle'), false)
    expect(title()).toEqual([])
    expect(title(context({ resume: true }))).toEqual([])
    // Hive can't read "Action Required" from a title it didn't set: the hooks tell it instead.
    expect(codex.titleAttention!('0.163.0')).toBeNull()
    // Codex's setup keeps Hive's title: its busy wait reads the spinner.
    expect(codex.setupCommand('C:\\bin\\codex.exe').args.some((a) => a.startsWith('tui.terminal_title='))).toBe(true)
  })
})

describe("Copilot: every MCP server's instructions (row 21)", () => {
  const instructions = (ctx: LaunchContext): string => readFileSync(join(ctx.privateDir, 'instructions', '.github', 'instructions', 'hive.instructions.md'), 'utf8')

  it("shows the hive server's instructions with the switch on; off, Hive's guidance comes as custom instructions instead", async () => {
    const agent = context({ privateDir: join(base, 'private-on') })
    await copilot.prepareLaunch(agent)
    const on = copilot.buildCommand('C:\\bin\\copilot.exe', agent)
    expect(on.args).toContain('--allow-all-mcp-server-instructions')
    expect(on.env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBeUndefined()
    expect(existsSync(join(agent.privateDir, 'instructions'))).toBe(false)

    await advanced.set(overrideId('copilot', 'allMcpInstructions'), false)
    const off = context({ privateDir: join(base, 'private-off'), env: { PATH: 'C:\\Windows', COPILOT_CUSTOM_INSTRUCTIONS_DIRS: 'D:\\mine' } })
    await copilot.prepareLaunch(off)
    const cmd = copilot.buildCommand('C:\\bin\\copilot.exe', off)
    expect(cmd.args).not.toContain('--allow-all-mcp-server-instructions')
    expect(instructions(off)).toBe("---\napplyTo: '**'\n---\nHive guidance\n")
    // The user's own folders stay, Hive's after them.
    expect(cmd.env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBe(`D:\\mine,${join(off.privateDir, 'instructions')}`)

    // The Assistant gets its role after the guidance; a launch without Hive's tools gets no guidance.
    const assistant = context({ privateDir: join(base, 'private-assistant'), instructions: 'You are in Planner mode.' })
    await copilot.prepareLaunch(assistant)
    expect(instructions(assistant)).toBe("---\napplyTo: '**'\n---\nHive guidance\n\nYou are in Planner mode.\n")
    const bare = context({ privateDir: join(base, 'private-bare'), mcpServers: {} })
    await copilot.prepareLaunch(bare)
    expect(copilot.buildCommand('C:\\bin\\copilot.exe', bare).env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBeUndefined()
  })
})

describe('a launch reads its switches once (overridesNow), so its stages agree when one changes meanwhile', () => {
  const id = overrideId('copilot', 'allMcpInstructions')

  it('Copilot: prepared with the instructions switch on, then turned off before the command is built', async () => {
    const ctx = context({ privateDir: join(base, 'race-on'), overrides: overridesNow('copilot') })
    await copilot.prepareLaunch(ctx)
    await advanced.set(id, false)
    const cmd = copilot.buildCommand('C:\\bin\\copilot.exe', ctx)
    // Still the launch it was prepared as: the flag, and no instructions folder that was never written.
    expect(cmd.args).toContain('--allow-all-mcp-server-instructions')
    expect(cmd.env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBeUndefined()
  })

  it('Copilot: prepared with it off, then turned on before the command is built', async () => {
    await advanced.set(id, false)
    const ctx = context({ privateDir: join(base, 'race-off'), overrides: overridesNow('copilot') })
    await copilot.prepareLaunch(ctx)
    await advanced.set(id, null)
    const cmd = copilot.buildCommand('C:\\bin\\copilot.exe', ctx)
    expect(cmd.args).not.toContain('--allow-all-mcp-server-instructions')
    const dir = cmd.env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS
    expect(dir).toBe(join(ctx.privateDir, 'instructions'))
    expect(readFileSync(join(dir!, '.github', 'instructions', 'hive.instructions.md'), 'utf8')).toContain('Hive guidance')
  })

  it("Codex: the title and whether Hive reads it come from the same launch's switch", async () => {
    const ctx = context({ overrides: overridesNow('codex') })
    await advanced.set(overrideId('codex', 'terminalTitle'), false)
    expect(codex.buildCommand('C:\\bin\\codex.exe', ctx).args.some((a) => a.startsWith('tui.terminal_title='))).toBe(true)
    expect(codex.titleAttention!('0.163.0', ctx)).toBeTypeOf('function')
    // A launch read after the change gets neither.
    const later = context({ overrides: overridesNow('codex') })
    expect(codex.buildCommand('C:\\bin\\codex.exe', later).args.some((a) => a.startsWith('tui.terminal_title='))).toBe(false)
    expect(codex.titleAttention!('0.163.0', later)).toBeNull()
  })

  it('a snapshot holds only its own provider’s switches, each as it is now', async () => {
    await advanced.set(overrideId('copilot', 'noAutoUpdate'), false)
    const copilotNow = overridesNow('copilot')
    expect(Object.keys(copilotNow).every((k) => k.startsWith('copilot.override.'))).toBe(true)
    expect(copilotNow).toMatchObject({ [overrideId('copilot', 'noAutoUpdate')]: false, [id]: true })
    expect(Object.keys(copilotNow).filter((k) => !copilotNow[k])).toEqual([overrideId('copilot', 'noAutoUpdate')])
    expect(Object.keys(overridesNow('claude-code')).every((k) => k.startsWith('claude-code.override.'))).toBe(true)
  })
})

describe('Copilot: not updating itself (row 22)', () => {
  it('passes --no-auto-update and COPILOT_AUTO_UPDATE=false on every path with the switch on, and neither with it off', async () => {
    const launch = (): ReturnType<typeof copilot.buildCommand> => copilot.buildCommand('C:\\bin\\copilot.exe', context())
    // On: the session, the catalogue read, the sign-in check, and any other child.
    expect(launch().args).toContain('--no-auto-update')
    expect(launch().env?.COPILOT_AUTO_UPDATE).toBe('false')
    expect(catalogArgs()).toEqual(['--acp', '--no-auto-update'])
    expect(copilotCheckEnv({ PATH: 'C:\\bin' }).COPILOT_AUTO_UPDATE).toBe('false')
    expect(copilotEnv({ COPILOT_AUTO_UPDATE: 'true' }).COPILOT_AUTO_UPDATE).toBe('false')
    await advanced.set(overrideId('copilot', 'noAutoUpdate'), false)
    expect(launch().args).not.toContain('--no-auto-update')
    expect(launch().env?.COPILOT_AUTO_UPDATE).toBeUndefined()
    expect(catalogArgs()).toEqual(['--acp'])
    expect(copilotCheckEnv({ PATH: 'C:\\bin' })).toEqual({ PATH: 'C:\\bin' })
    // The user's own choice is left as it is.
    expect(copilotEnv({ COPILOT_AUTO_UPDATE: 'false' }).COPILOT_AUTO_UPDATE).toBe('false')
    expect(copilotEnv({ COPILOT_AUTO_UPDATE: 'true' }).COPILOT_AUTO_UPDATE).toBe('true')
    // Other tools' tokens are still left out (#450): another switch (row 8, below).
    expect(copilotEnv({ GH_TOKEN: 'x' }).GH_TOKEN).toBeUndefined()
  })
})

describe("Hive's tools pre-approved (row 3)", () => {
  const assistant = (over: Partial<LaunchContext> = {}): LaunchContext => context({ trustedHiveTools: ['hive_list_tasks', 'hive_read_task'], ...over })

  it('Claude Code: the Assistant’s trusted Hive tools with the switch on, none with it off', async () => {
    const allowed = (): string[] => { const a = claudeCode.buildCommand('C:\\bin\\claude.exe', assistant()).args; const i = a.indexOf('--allowedTools'); return i < 0 ? [] : a[i + 1].split(',') }
    expect(allowed()).toEqual(['mcp__hive__hive_list_tasks', 'mcp__hive__hive_read_task'])
    await advanced.set(overrideId('claude-code', 'preApproveHiveTools'), false)
    expect(allowed()).toEqual([])
    // Hive's tools are still there: only Claude Code's trust changed.
    expect(claudeCode.buildCommand('C:\\bin\\claude.exe', assistant()).args).toContain('--mcp-config')
  })

  it('Copilot: hive (an agent) or the Assistant’s subset with the switch on, nothing with it off', async () => {
    const allowTools = (ctx: LaunchContext): string[] => copilot.buildCommand('C:\\bin\\copilot.exe', ctx).args.filter((a) => a.startsWith('--allow-tool=hive'))
    expect(allowTools(context())).toEqual(['--allow-tool=hive'])
    expect(allowTools(assistant())).toEqual(['--allow-tool=hive(hive_list_tasks)', '--allow-tool=hive(hive_read_task)'])
    await advanced.set(overrideId('copilot', 'preApproveHiveTools'), false)
    expect(allowTools(context())).toEqual([])
    expect(allowTools(assistant())).toEqual([])
    expect(copilot.buildCommand('C:\\bin\\copilot.exe', context()).args).toContain('--additional-mcp-config')
  })
})

describe("Copilot: other tools' GitHub tokens (row 8)", () => {
  const env = { PATH: 'C:\\bin', GH_TOKEN: 'gho_x', github_token: 'ghp_y', COPILOT_GITHUB_TOKEN: 'c' }

  it('are left out on every path with the switch on, and kept on every path with it off, the sign-in shown as the sessions get it', async () => {
    const launch = (): Record<string, string> => copilot.buildCommand('C:\\bin\\copilot.exe', context({ env })).env!
    // On: the session, the sign-in check and the catalogue (copilotEnv) leave them out; Agent Setup says so.
    expect(launch().GH_TOKEN).toBeUndefined()
    expect(launch().github_token).toBeUndefined()
    expect(launch().COPILOT_GITHUB_TOKEN).toBe('c')
    expect(copilotCheckEnv({ PATH: 'C:\\bin', GH_TOKEN: 'gho_x' }).GH_TOKEN).toBeUndefined()
    expect(copilotEnv(env).GH_TOKEN).toBeUndefined()
    expect(ignoredTokens({ GH_TOKEN: 'gho_x' })).toEqual(['GH_TOKEN'])
    expect(copilotSignIn(copilotCheckEnv({ GH_TOKEN: 'gho_x' }), null, null)).toMatchObject({ loggedIn: false })
    await advanced.set(overrideId('copilot', 'stripGitHubTokens'), false)
    expect(launch()).toMatchObject({ GH_TOKEN: 'gho_x', github_token: 'ghp_y', COPILOT_GITHUB_TOKEN: 'c' })
    expect(copilotCheckEnv({ PATH: 'C:\\bin', GH_TOKEN: 'gho_x' }).GH_TOKEN).toBe('gho_x')
    expect(copilotEnv(env).GH_TOKEN).toBe('gho_x')
    // Nothing is left out, so Agent Setup names none, and the sign-in shown is the token's, as the sessions get it.
    expect(ignoredTokens({ GH_TOKEN: 'gho_x' })).toEqual([])
    expect(copilotSignIn(copilotCheckEnv({ GH_TOKEN: 'gho_x' }), null, null)).toMatchObject({ loggedIn: true, source: 'token', variable: 'GH_TOKEN' })
  })

  it('a change checks Copilot again (its locate settings)', () => {
    expect(copilot.locateSettings).toEqual(expect.arrayContaining([overrideId('copilot', 'stripGitHubTokens'), overrideId('copilot', 'noAutoUpdate')]))
  })
})

describe("Codex: Hive's tools pre-approved (row 3, #1174) and its own MCP servers (row 5)", () => {
  const hiveTable = (ctx: LaunchContext): string | undefined => codex.buildCommand('C:\\bin\\codex.exe', ctx).args.find((a) => a.startsWith('mcp_servers.hive='))
  const home = (): string => process.env.CODEX_HOME!
  const nativeConfig = (toml: string): void => {
    mkdirSync(home(), { recursive: true })
    writeFileSync(join(home(), 'config.toml'), toml)
  }
  afterEach(() => rmSync(join(home(), 'config.toml'), { force: true }))

  it("approves the whole hive server for an agent, only the Assistant's trusted tools for it, and none with the switch off", async () => {
    expect(hiveTable(context())).toContain('default_tools_approval_mode="approve"')
    expect(hiveTable(context())).toContain('enabled=true')
    const assistant = hiveTable(context({ trustedHiveTools: ['hive_list_tasks', 'hive_read_task'] }))!
    expect(assistant).not.toContain('default_tools_approval_mode')
    expect(assistant).toContain('tools={hive_list_tasks={approval_mode="approve"},hive_read_task={approval_mode="approve"}}')
    await advanced.set(overrideId('codex', 'preApproveHiveTools'), false)
    for (const t of [hiveTable(context()), hiveTable(context({ trustedHiveTools: ['hive_list_tasks'] }))]) {
      expect(t).not.toContain('approval_mode')
      // Still Hive's server, on.
      expect(t).toContain('enabled=true')
    }
  })

  it('turns the user’s own servers off with the switch on, and leaves them with it off', async () => {
    nativeConfig('[mcp_servers.mine]\ncommand = "node"\nargs = ["mine.js"]\n')
    const off = (): boolean => codex.buildCommand('C:\\bin\\codex.exe', context()).args.includes('mcp_servers.mine.enabled=false')
    expect(off()).toBe(true)
    await advanced.set(overrideId('codex', 'mcpIsolation'), false)
    expect(off()).toBe(false)
  })

})

// Codex merges Hive's -c mcp_servers.hive={…} into the user's own [mcp_servers.hive] key by key (0.163.0, probed), so
// each key a native one sets gets Hive's value, whatever the isolation switch, in the user's config or the project's.
describe("Codex: Hive's hive server over a native one of that name", () => {
  const homeBefore = process.env.CODEX_HOME
  // A new Codex home (and project) per case: config files are read by their modification time.
  let n = 0
  const where = (place: 'home' | 'project', toml: string): LaunchContext => {
    const root = join(base, `native-${++n}`)
    process.env.CODEX_HOME = join(root, 'codex-home')
    const cwd = join(root, 'proj')
    const dir = place === 'home' ? process.env.CODEX_HOME : join(cwd, '.codex')
    mkdirSync(dir, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(dir, 'config.toml'), `[mcp_servers.hive]\n${toml}`)
    return context({ cwd })
  }
  afterEach(() => {
    process.env.CODEX_HOME = homeBefore
  })
  /** Hive's hive table as Codex is given it. */
  const table = (ctx: LaunchContext): Record<string, any> => {
    const arg = codex.buildCommand('C:\\bin\\codex.exe', ctx).args.find((a) => a.startsWith('mcp_servers.hive='))!
    return parseToml(`hive = ${arg.slice('mcp_servers.hive='.length)}`).hive as Record<string, any>
  }
  const places = ['home', 'project'] as const

  it('its tool lists and its off switch: all of Hive’s tools shown, on, isolation on and off', async () => {
    for (const isolation of [true, false])
      for (const place of places) {
        await advanced.set(overrideId('codex', 'mcpIsolation'), isolation ? null : false)
        const t = table(where(place, 'command = "node"\nargs = ["native.js"]\nenabled = false\nenabled_tools = ["only_this"]\ndisabled_tools = ["hive_notify"]\n'))
        expect(t, `${place}, isolation ${isolation}`).toMatchObject({ command: 'node', args: ['hive-mcp.js'], enabled: true, enabled_tools: [...HIVE_TOOLS], disabled_tools: [] })
      }
  })

  it('how it starts: the session’s folder, Hive’s startup timeout (Codex’s own default, from Settings → Advanced), not required, its environment emptied', async () => {
    for (const place of places) {
      const ctx = where(place, 'command = "node"\ncwd = "Z:/does-not-exist"\nstartup_timeout_sec = 1\nstartup_timeout_ms = 500\nrequired = true\nenv = { NODE_OPTIONS = "--inspect", HIVE_API_URL = "http://elsewhere" }\nenv_vars = ["SECRET"]\n')
      expect(table(ctx), place).toMatchObject({ cwd: ctx.cwd, startup_timeout_sec: 10, startup_timeout_ms: 10000, required: false, env: { NODE_OPTIONS: '' }, env_vars: [] })
    }
    // The startup timeout follows Settings → Advanced.
    await advanced.set('codex.mcp.startupTimeoutSeconds', 45)
    expect(table(where('home', 'command = "node"\nstartup_timeout_sec = 1\nstartup_timeout_ms = 500\n'))).toMatchObject({ startup_timeout_sec: 45, startup_timeout_ms: 45000 })
    // Hive's own env stays Hive's (here the context's server has none to set).
    const own = outrankNativeHive([], { env: { HIVE_PROJECT: 'p' } }, 'all', 'C:\\p')
    expect(own).toEqual({})
  })

  it("its approvals: Hive's for every tool it names, Codex's own policy (auto) for the rest", async () => {
    const native = 'command = "node"\ndefault_tools_approval_mode = "approve"\ntools = { hive_write_shared_note = { approval_mode = "approve" }, hive_list_tasks = { approval_mode = "prompt" } }\n'
    for (const place of places) {
      // An agent: everything approved, the native per-tool "prompt" too.
      expect(table(where(place, native)), place).toMatchObject({ default_tools_approval_mode: 'approve', tools: { hive_write_shared_note: { approval_mode: 'approve' }, hive_list_tasks: { approval_mode: 'approve' } } })
      // The Assistant: its trusted tools approved, the native blanket and per-tool approvals of the rest taken back.
      const a = table({ ...where(place, native), trustedHiveTools: ['hive_list_tasks'] })
      expect(a, place).toMatchObject({ default_tools_approval_mode: 'auto', tools: { hive_list_tasks: { approval_mode: 'approve' }, hive_write_shared_note: { approval_mode: 'auto' } } })
      // An Assistant trusted with nothing: nothing approved.
      expect(table({ ...where(place, native), trustedHiveTools: [] }), place).toMatchObject({ default_tools_approval_mode: 'auto', tools: { hive_write_shared_note: { approval_mode: 'auto' }, hive_list_tasks: { approval_mode: 'auto' } } })
    }
    // The switch off: nothing approved, for an agent either.
    await advanced.set(overrideId('codex', 'preApproveHiveTools'), false)
    expect(table(where('home', native))).toMatchObject({ default_tools_approval_mode: 'auto', tools: { hive_write_shared_note: { approval_mode: 'auto' }, hive_list_tasks: { approval_mode: 'auto' } } })
  })

  it('an HTTP one: refused, saying which file to rename it in (Codex itself would refuse the mix)', () => {
    for (const place of places)
      for (const http of ['url = "http://127.0.0.1:1/native"', 'bearer_token_env_var = "TOKEN"', 'http_headers = { X = "y" }']) {
        const ctx = where(place, `${http}\n`)
        const file = place === 'home' ? join(process.env.CODEX_HOME!, 'config.toml') : join(ctx.cwd, '.codex', 'config.toml')
        expect(() => codex.buildCommand('C:\\bin\\codex.exe', ctx), `${place}: ${http}`).toThrow(`Your Codex config has an MCP server named hive, reached over HTTP (${file}).`)
      }
  })

  it('none: nothing added', () => {
    expect(outrankNativeHive([join(base, 'missing.toml')], {}, 'all', 'C:\\p')).toEqual({})
  })
})

describe("Claude Code's and Copilot's own MCP servers (rows 4 and 6)", () => {
  it('Claude Code: --strict-mcp-config with the switch on; off, Hive’s file only (its servers still win by name)', async () => {
    const args = (): string[] => claudeCode.buildCommand('C:\\bin\\claude.exe', context()).args
    expect(args()).toContain('--strict-mcp-config')
    await advanced.set(overrideId('claude-code', 'mcpIsolation'), false)
    expect(args()).not.toContain('--strict-mcp-config')
    expect(args()[args().indexOf('--mcp-config') + 1]).toBe(join(base, 'private', 'mcp.json'))
  })

  it('Copilot: built-ins and the user’s servers off with the switch on; off, none disabled, Hive’s by name least of all', async () => {
    const home = process.env.COPILOT_HOME!
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'mcp-config.json'), JSON.stringify({ mcpServers: { mine: { command: 'node' }, hive: { command: 'node', args: ['native.js'] } } }))
    try {
      const args = (): string[] => copilot.buildCommand('C:\\bin\\copilot.exe', context()).args
      expect(args()).toContain('--disable-builtin-mcps')
      expect(args().filter((a, i, all) => all[i - 1] === '--disable-mcp-server')).toEqual(['mine'])
      await advanced.set(overrideId('copilot', 'mcpIsolation'), false)
      expect(args()).not.toContain('--disable-builtin-mcps')
      expect(args()).not.toContain('--disable-mcp-server')
      expect(args()).toContain('--additional-mcp-config')
    } finally {
      rmSync(join(home, 'mcp-config.json'), { force: true })
    }
  })
})

describe("Claude Code's status line (#1285, row 12)", () => {
  const claudeDir = join(base, 'claude-config')
  const launch = async (): Promise<Record<string, any>> => {
    const ctx = context({ privateDir: join(base, 'private-statusline'), env: { PATH: 'C:\\Windows', CLAUDE_CONFIG_DIR: claudeDir } })
    await claudeCode.prepareLaunch(ctx)
    return JSON.parse(readFileSync(join(ctx.privateDir, 'settings.json'), 'utf8')).statusLine
  }
  const project = join(base, 'proj', '.claude')
  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })

  it("is Hive's alone with the switch on, whatever the user's settings say", async () => {
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'node mine.js', padding: 2 } }))
    const line = await launch()
    expect(line).toEqual({ type: 'command', command: expect.stringMatching(/^curl(\.exe)? .*&statusline"$/), padding: 0 })
    expect(line.command).not.toContain('mine.js')
  })

  it("off, runs the user's own after Hive's, given the JSON Hive's server echoes back, with their padding", async () => {
    await advanced.set(overrideId('claude-code', 'statusLine'), false)
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'node mine.js && echo done', padding: 2 } }))
    const line = await launch()
    expect(line.padding).toBe(2)
    expect(line.command).toMatch(/^curl(\.exe)? .*&statusline&echo" \| \(node mine\.js && echo done\)$/)
    // The project's own wins over the user's, as Claude Code takes them.
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'project-line' } }))
    expect((await launch()).command).toMatch(/\| \(project-line\)$/)
    // None of theirs: Hive's own, as with the switch on.
    rmSync(join(claudeDir, 'settings.json'))
    rmSync(join(project, 'settings.json'))
    expect(await launch()).toEqual({ type: 'command', command: expect.stringMatching(/&statusline"$/), padding: 0 })
  })
})

describe("Hive's guidance for agents (#1285, row 13)", () => {
  const codexArgs = (ctx: LaunchContext): string[] => codex.buildCommand('C:\\bin\\codex.exe', ctx).args
  const developer = (args: string[]): string | null => {
    const a = args.find((x) => x.startsWith('developer_instructions='))
    return a ? (parseToml(a) as { developer_instructions: string }).developer_instructions : null
  }
  afterEach(() => rmSync(join(process.env.CODEX_HOME!, 'config.toml'), { force: true }))

  it("Codex: Hive's guidance after the user's own developer_instructions, never in their place; none of Hive's, none passed", () => {
    expect(developer(codexArgs(context()))).toBe('Hive guidance')
    mkdirSync(process.env.CODEX_HOME!, { recursive: true })
    writeFileSync(join(process.env.CODEX_HOME!, 'config.toml'), 'developer_instructions = "Mine first."\n')
    expect(developer(codexArgs(context()))).toBe('Mine first.\n\nHive guidance')
    // The Assistant's role after it too.
    expect(developer(codexArgs(context({ instructions: 'You are the Assistant.' })))).toBe('Mine first.\n\nHive guidance\n\nYou are the Assistant.')
    // No guidance of Hive's (the switch off, or no Hive tools): theirs apply as Codex reads them, untouched.
    expect(developer(codexArgs(context({ guidance: '' })))).toBeNull()
  })

  it('is a switch of its own under Hive, on by default, taken by sessions started afterwards (e2e agentguidance checks the hive server it gives)', async () => {
    const { HIVE_GUIDANCE } = await import('../src/shared/advanced')
    expect(advancedDef(HIVE_GUIDANCE)).toMatchObject({ group: 'hive', kind: 'boolean', default: true, applies: 'sessions' })
  })
})

// Row 11 has no switch (Darren, 21 Oct): Codex keeps the user's hooks beside Hive's, each layer's under its own key, and
// merges the trust table (e2e codexownhooks asks the installed Codex). Hive's part: its hooks and its trust records are
// its own session-flags keys only, so nothing of the user's is named, replaced or trusted by Hive.
describe("Codex: Hive's hooks beside the user's own (row 11)", () => {
  it("passes its hooks per event and trust records for its own session-flags keys alone, whatever the user's config has", () => {
    mkdirSync(process.env.CODEX_HOME!, { recursive: true })
    writeFileSync(join(process.env.CODEX_HOME!, 'config.toml'), '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo mine"\n')
    try {
      const args = codex.buildCommand('C:\\bin\\codex.exe', context()).args
      const values = args.filter((a, i) => args[i - 1] === '-c')
      const state = values.find((v) => v.startsWith('hooks.state='))!
      const keys = Object.keys((parseToml(state) as { hooks: { state: Record<string, unknown> } }).hooks.state)
      expect(keys.length).toBeGreaterThan(5)
      for (const k of keys) expect(k).toMatch(/^C:\\<session-flags>\\config\.toml:[a-z_]+:0:0$/)
      // Its hooks are its own forwarding command; the user's hook is neither repeated nor named.
      expect(values.filter((v) => v.startsWith('hooks.') && !v.startsWith('hooks.state=')).every((v) => v.includes('curl') && !v.includes('echo mine'))).toBe(true)
      expect(args.join(' ')).not.toContain('echo mine')
    } finally {
      rmSync(join(process.env.CODEX_HOME!, 'config.toml'), { force: true })
    }
  })
})
