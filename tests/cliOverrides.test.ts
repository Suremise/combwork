import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
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
      'claude-code.override.mcpIsolation', 'claude-code.override.preApproveHiveTools', 'claude-code.override.promptSnapshotOff',
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

  it("Hive's hive server wins over a native one of that name, whose tool lists would filter it (it merges key by key)", async () => {
    nativeConfig('[mcp_servers.hive]\ncommand = "node"\nargs = ["native.js"]\nenabled = false\nenabled_tools = ["only_this"]\ndisabled_tools = ["hive_notify"]\nstartup_timeout_sec = 5\n')
    for (const isolation of [true, false]) {
      await advanced.set(overrideId('codex', 'mcpIsolation'), isolation ? null : false)
      const t = hiveTable(context())!
      expect(t).toContain('enabled=true')
      expect(t).toContain(`enabled_tools=[${HIVE_TOOLS.map((n) => `"${n}"`).join(',')}]`)
      expect(t).toContain('disabled_tools=[]')
      expect(t).toContain('args=["hive-mcp.js"]')
    }
    expect(outrankNativeHive([join(home(), 'config.toml')])).toEqual({ enabled_tools: [...HIVE_TOOLS], disabled_tools: [] })
    expect(outrankNativeHive([join(home(), 'missing.toml')])).toEqual({})
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
