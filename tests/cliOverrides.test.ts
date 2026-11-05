import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parse as parseToml } from 'smol-toml'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { advanced } from '../src/main/advanced'
import { overridesNow } from '../src/main/advancedValues'
import { claudeCode } from '../src/main/providers/claude/adapter'
import { codex, outrankNativeHive } from '../src/main/providers/codex/adapter'
import { copilot, toolNamesLine } from '../src/main/providers/copilot/adapter'
import { copilotEnv } from '../src/main/providers/copilot/home'
import { copilotCheckEnv, copilotSignIn, ignoredTokens } from '../src/main/providers/copilot/install'
import { catalogArgs } from '../src/main/providers/copilot/models'
import type { LaunchContext } from '../src/main/providers/types'
import { ADVANCED_DEFS, advancedDef, overrideId, rightClickToCliId } from '../src/shared/advanced'
import { CW_TOOLS } from '../src/shared/assistantTools'
import { tempDir } from './tempDir'

// The off switches for Combwork's overrides of the CLIs' own behaviour (#966, #1167): each one's effect on the launch, on and off.

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
    resume: false, name: '', skills: [], mcpServers: { combwork: { command: 'node', args: ['cw-mcp.js'] } }, model: null, effort: null, permissionMode: null, extraArgs: [],
    hookUrl: 'http://127.0.0.1:5000/hook?run=r1', hookAuthFile: join(base, 'auth.txt'), privateDir: join(base, 'private'), guidance: 'Combwork guidance', allowBackgroundSessions: false, use200kContext: false,
    env: { PATH: 'C:\\Windows' },
    ...over
  }
}

describe('the override switches', () => {
  it('are booleans, on by default (what Combwork does today), named <provider>.override.<what>, taken by sessions started afterwards', () => {
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
    // Combwork's other launch arguments stay.
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
    // Combwork can't read "Action Required" from a title it didn't set: the hooks tell it instead.
    expect(codex.titleAttention!('0.163.0')).toBeNull()
    // Codex's setup keeps Combwork's title: its busy wait reads the spinner.
    expect(codex.setupCommand('C:\\bin\\codex.exe').args.some((a) => a.startsWith('tui.terminal_title='))).toBe(true)
  })
})

describe("Copilot: every MCP server's instructions (row 21)", () => {
  const instructions = (ctx: LaunchContext): string => readFileSync(join(ctx.privateDir, 'instructions', '.github', 'instructions', 'hive.instructions.md'), 'utf8')

  it("shows the hive server's instructions with the switch on; off, Combwork's guidance comes as custom instructions instead", async () => {
    const agent = context({ privateDir: join(base, 'private-on') })
    await copilot.prepareLaunch(agent)
    const on = copilot.buildCommand('C:\\bin\\copilot.exe', agent)
    expect(on.args).toContain('--allow-all-mcp-server-instructions')
    // Only the line on the hive tools' names (#1530) is custom then.
    expect(on.env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBe(join(agent.privateDir, 'instructions'))
    expect(instructions(agent)).toBe(`---\napplyTo: '**'\n---\n${toolNamesLine()}\n`)

    await advanced.set(overrideId('copilot', 'allMcpInstructions'), false)
    const off = context({ privateDir: join(base, 'private-off'), env: { PATH: 'C:\\Windows', COPILOT_CUSTOM_INSTRUCTIONS_DIRS: 'D:\\mine' } })
    await copilot.prepareLaunch(off)
    const cmd = copilot.buildCommand('C:\\bin\\copilot.exe', off)
    expect(cmd.args).not.toContain('--allow-all-mcp-server-instructions')
    expect(instructions(off)).toBe(`---\napplyTo: '**'\n---\nCombwork guidance\n\n${toolNamesLine()}\n`)
    // The user's own folders stay, Combwork's after them.
    expect(cmd.env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBe(`D:\\mine,${join(off.privateDir, 'instructions')}`)

    // The Assistant gets its role after the guidance; a launch without Combwork's tools gets no guidance.
    const assistant = context({ privateDir: join(base, 'private-assistant'), instructions: 'You are in Planner mode.' })
    await copilot.prepareLaunch(assistant)
    expect(instructions(assistant)).toBe(`---\napplyTo: '**'\n---\nCombwork guidance\n\n${toolNamesLine()}\n\nYou are in Planner mode.\n`)
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
    // Still the launch it was prepared as: the flag, and the instructions folder holding only the tool names' line.
    expect(cmd.args).toContain('--allow-all-mcp-server-instructions')
    expect(readFileSync(join(cmd.env!.COPILOT_CUSTOM_INSTRUCTIONS_DIRS!, '.github', 'instructions', 'hive.instructions.md'), 'utf8')).not.toContain('Combwork guidance')
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
    expect(readFileSync(join(dir!, '.github', 'instructions', 'hive.instructions.md'), 'utf8')).toContain('Combwork guidance')
  })

  it("Codex: the title and whether Combwork reads it come from the same launch's switch", async () => {
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

describe("Combwork's tools pre-approved (row 3)", () => {
  const assistant = (over: Partial<LaunchContext> = {}): LaunchContext => context({ trustedHiveTools: ['cw_list_tasks', 'cw_read_task'], ...over })

  it('Claude Code: the Assistant’s trusted Combwork tools with the switch on, none with it off', async () => {
    const allowed = (): string[] => { const a = claudeCode.buildCommand('C:\\bin\\claude.exe', assistant()).args; const i = a.indexOf('--allowedTools'); return i < 0 ? [] : a[i + 1].split(',') }
    expect(allowed()).toEqual(['mcp__combwork__cw_list_tasks', 'mcp__combwork__cw_read_task'])
    await advanced.set(overrideId('claude-code', 'preApproveHiveTools'), false)
    expect(allowed()).toEqual([])
    // Combwork's tools are still there: only Claude Code's trust changed.
    expect(claudeCode.buildCommand('C:\\bin\\claude.exe', assistant()).args).toContain('--mcp-config')
  })

  it('Copilot: hive (an agent) or the Assistant’s subset with the switch on, nothing with it off', async () => {
    const allowTools = (ctx: LaunchContext): string[] => copilot.buildCommand('C:\\bin\\copilot.exe', ctx).args.filter((a) => a.startsWith('--allow-tool=combwork'))
    expect(allowTools(context())).toEqual(['--allow-tool=combwork'])
    expect(allowTools(assistant())).toEqual(['--allow-tool=combwork(cw_list_tasks)', '--allow-tool=combwork(cw_read_task)'])
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
    // On: the session, the sign-in check and the catalogue (copilotEnv) leave them out; Provider Setup says so.
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
    // Nothing is left out, so Provider Setup names none, and the sign-in shown is the token's, as the sessions get it.
    expect(ignoredTokens({ GH_TOKEN: 'gho_x' })).toEqual([])
    expect(copilotSignIn(copilotCheckEnv({ GH_TOKEN: 'gho_x' }), null, null)).toMatchObject({ loggedIn: true, source: 'token', variable: 'GH_TOKEN' })
  })

  it('a change checks Copilot again (its locate settings)', () => {
    expect(copilot.locateSettings).toEqual(expect.arrayContaining([overrideId('copilot', 'stripGitHubTokens'), overrideId('copilot', 'noAutoUpdate')]))
  })
})

describe("Codex: Combwork's tools pre-approved (row 3, #1174) and its own MCP servers (row 5)", () => {
  const hiveTable = (ctx: LaunchContext): string | undefined => codex.buildCommand('C:\\bin\\codex.exe', ctx).args.find((a) => a.startsWith('mcp_servers.combwork='))
  const home = (): string => process.env.CODEX_HOME!
  const nativeConfig = (toml: string): void => {
    mkdirSync(home(), { recursive: true })
    writeFileSync(join(home(), 'config.toml'), toml)
  }
  afterEach(() => rmSync(join(home(), 'config.toml'), { force: true }))

  it("approves the whole hive server for an agent, only the Assistant's trusted tools for it, and none with the switch off", async () => {
    expect(hiveTable(context())).toContain('default_tools_approval_mode="approve"')
    expect(hiveTable(context())).toContain('enabled=true')
    const assistant = hiveTable(context({ trustedHiveTools: ['cw_list_tasks', 'cw_read_task'] }))!
    expect(assistant).not.toContain('default_tools_approval_mode')
    expect(assistant).toContain('tools={cw_list_tasks={approval_mode="approve"},cw_read_task={approval_mode="approve"}}')
    await advanced.set(overrideId('codex', 'preApproveHiveTools'), false)
    for (const t of [hiveTable(context()), hiveTable(context({ trustedHiveTools: ['cw_list_tasks'] }))]) {
      expect(t).not.toContain('approval_mode')
      // Still Combwork's server, on.
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

// Codex merges Combwork's -c mcp_servers.hive={…} into the user's own [mcp_servers.hive] key by key (0.163.0, probed), so
// each key a native one sets gets Combwork's value, whatever the isolation switch, in the user's config or the project's.
describe("Codex: Combwork's hive server over a native one of that name", () => {
  // The suite's own home, as beforeAll set it (read then, not as the module loads, when it isn't set yet: putting that
  // back would leave the string "undefined", a folder in the current one, for the tests after these).
  let homeBefore: string | undefined
  beforeEach(() => {
    homeBefore = process.env.CODEX_HOME
  })
  // A new Codex home (and project) per case: config files are read by their modification time.
  let n = 0
  const where = (place: 'home' | 'project', toml: string): LaunchContext => {
    const root = join(base, `native-${++n}`)
    process.env.CODEX_HOME = join(root, 'codex-home')
    const cwd = join(root, 'proj')
    const dir = place === 'home' ? process.env.CODEX_HOME : join(cwd, '.codex')
    mkdirSync(dir, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(dir, 'config.toml'), `[mcp_servers.combwork]\n${toml}`)
    return context({ cwd })
  }
  afterEach(() => {
    process.env.CODEX_HOME = homeBefore
  })
  /** Combwork's hive table as Codex is given it. */
  const table = (ctx: LaunchContext): Record<string, any> => {
    const arg = codex.buildCommand('C:\\bin\\codex.exe', ctx).args.find((a) => a.startsWith('mcp_servers.combwork='))!
    return parseToml(`combwork = ${arg.slice('mcp_servers.combwork='.length)}`).combwork as Record<string, any>
  }
  const places = ['home', 'project'] as const

  it('its tool lists and its off switch: all of Combwork’s tools shown, on, isolation on and off', async () => {
    for (const isolation of [true, false])
      for (const place of places) {
        await advanced.set(overrideId('codex', 'mcpIsolation'), isolation ? null : false)
        const t = table(where(place, 'command = "node"\nargs = ["native.js"]\nenabled = false\nenabled_tools = ["only_this"]\ndisabled_tools = ["cw_notify"]\n'))
        expect(t, `${place}, isolation ${isolation}`).toMatchObject({ command: 'node', args: ['cw-mcp.js'], enabled: true, enabled_tools: [...CW_TOOLS], disabled_tools: [] })
      }
  })

  it('how it starts: the session’s folder, Combwork’s startup timeout (Codex’s own default, from Settings → Advanced), not required, its environment emptied', async () => {
    for (const place of places) {
      const ctx = where(place, 'command = "node"\ncwd = "Z:/does-not-exist"\nstartup_timeout_sec = 1\nstartup_timeout_ms = 500\nrequired = true\nenv = { NODE_OPTIONS = "--inspect", CW_API_URL = "http://elsewhere" }\nenv_vars = ["SECRET"]\n')
      expect(table(ctx), place).toMatchObject({ cwd: ctx.cwd, startup_timeout_sec: 10, startup_timeout_ms: 10000, required: false, env: { NODE_OPTIONS: '' }, env_vars: [] })
    }
    // The startup timeout follows Settings → Advanced.
    await advanced.set('codex.mcp.startupTimeoutSeconds', 45)
    expect(table(where('home', 'command = "node"\nstartup_timeout_sec = 1\nstartup_timeout_ms = 500\n'))).toMatchObject({ startup_timeout_sec: 45, startup_timeout_ms: 45000 })
    // Combwork's own env stays Combwork's (here the context's server has none to set).
    const own = outrankNativeHive([], { env: { CW_PROJECT: 'p' } }, 'all', 'C:\\p')
    expect(own).toEqual({})
  })

  it("its approvals: Combwork's for every tool it names, Codex's own policy (auto) for the rest", async () => {
    const native = 'command = "node"\ndefault_tools_approval_mode = "approve"\ntools = { cw_write_shared_note = { approval_mode = "approve" }, cw_list_tasks = { approval_mode = "prompt" } }\n'
    for (const place of places) {
      // An agent: everything approved, the native per-tool "prompt" too.
      expect(table(where(place, native)), place).toMatchObject({ default_tools_approval_mode: 'approve', tools: { cw_write_shared_note: { approval_mode: 'approve' }, cw_list_tasks: { approval_mode: 'approve' } } })
      // The Assistant: its trusted tools approved, the native blanket and per-tool approvals of the rest taken back.
      const a = table({ ...where(place, native), trustedHiveTools: ['cw_list_tasks'] })
      expect(a, place).toMatchObject({ default_tools_approval_mode: 'auto', tools: { cw_list_tasks: { approval_mode: 'approve' }, cw_write_shared_note: { approval_mode: 'auto' } } })
      // An Assistant trusted with nothing: nothing approved.
      expect(table({ ...where(place, native), trustedHiveTools: [] }), place).toMatchObject({ default_tools_approval_mode: 'auto', tools: { cw_write_shared_note: { approval_mode: 'auto' }, cw_list_tasks: { approval_mode: 'auto' } } })
    }
    // The switch off: nothing approved, for an agent either.
    await advanced.set(overrideId('codex', 'preApproveHiveTools'), false)
    expect(table(where('home', native))).toMatchObject({ default_tools_approval_mode: 'auto', tools: { cw_write_shared_note: { approval_mode: 'auto' }, cw_list_tasks: { approval_mode: 'auto' } } })
  })

  it('an HTTP one: refused, saying which file to rename it in (Codex itself would refuse the mix)', () => {
    for (const place of places)
      for (const http of ['url = "http://127.0.0.1:1/native"', 'bearer_token_env_var = "TOKEN"', 'http_headers = { X = "y" }']) {
        const ctx = where(place, `${http}\n`)
        const file = place === 'home' ? join(process.env.CODEX_HOME!, 'config.toml') : join(ctx.cwd, '.codex', 'config.toml')
        expect(() => codex.buildCommand('C:\\bin\\codex.exe', ctx), `${place}: ${http}`).toThrow(`Your Codex config has an MCP server named combwork, reached over HTTP (${file}).`)
      }
  })

  it('none: nothing added', () => {
    expect(outrankNativeHive([join(base, 'missing.toml')], {}, 'all', 'C:\\p')).toEqual({})
  })

  // HI-2463: the user's own copy of Combwork's server under its name before (their [mcp_servers.hive], with the old
  // cw_* tools) is turned off for the session by a launch override, isolation on or off; their config isn't changed.
  it('a native server named hive (the name before HI-2463): off for the session, isolation on and off, its file untouched', async () => {
    for (const isolation of [true, false])
      for (const place of places) {
        await advanced.set(overrideId('codex', 'mcpIsolation'), isolation ? null : false)
        const root = join(base, `legacy-${++n}`)
        process.env.CODEX_HOME = join(root, 'codex-home')
        const cwd = join(root, 'proj')
        const dir = place === 'home' ? process.env.CODEX_HOME : join(cwd, '.codex')
        mkdirSync(dir, { recursive: true })
        mkdirSync(cwd, { recursive: true })
        const text = '[mcp_servers.hive]\ncommand = "node"\nargs = ["old-hive-mcp.js"]\n'
        writeFileSync(join(dir, 'config.toml'), text)
        const args = codex.buildCommand('C:\\bin\\codex.exe', context({ cwd })).args
        expect(args.filter((a) => a === 'mcp_servers.hive.enabled=false'), `${place}, isolation ${isolation}`).toHaveLength(1)
        expect(args.some((a) => a.startsWith('mcp_servers.combwork=')), `${place}, isolation ${isolation}`).toBe(true)
        expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe(text)
      }
  })

  it('no native hive: nothing turned off for it', () => {
    const root = join(base, `legacy-${++n}`)
    process.env.CODEX_HOME = join(root, 'codex-home')
    mkdirSync(process.env.CODEX_HOME, { recursive: true })
    const args = codex.buildCommand('C:\\bin\\codex.exe', context({ cwd: root })).args
    expect(args.some((a) => a.startsWith('mcp_servers.hive'))).toBe(false)
  })
})

describe("Claude Code's and Copilot's own MCP servers (rows 4 and 6)", () => {
  it('Claude Code: --strict-mcp-config with the switch on; off, Combwork’s file only (its servers still win by name)', async () => {
    const args = (): string[] => claudeCode.buildCommand('C:\\bin\\claude.exe', context()).args
    expect(args()).toContain('--strict-mcp-config')
    await advanced.set(overrideId('claude-code', 'mcpIsolation'), false)
    expect(args()).not.toContain('--strict-mcp-config')
    expect(args()[args().indexOf('--mcp-config') + 1]).toBe(join(base, 'private', 'mcp.json'))
  })

  it('Copilot: built-ins and the user’s servers off with the switch on; off, none disabled, Combwork’s by name least of all', async () => {
    const home = process.env.COPILOT_HOME!
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'mcp-config.json'), JSON.stringify({ mcpServers: { mine: { command: 'node' }, hive: { command: 'node', args: ['native.js'] } } }))
    try {
      const args = (): string[] => copilot.buildCommand('C:\\bin\\copilot.exe', context()).args
      expect(args()).toContain('--disable-builtin-mcps')
      // The user's own hive (Combwork's server's name before HI-2463) is theirs now: off with the others…
      expect(args().filter((a, i, all) => all[i - 1] === '--disable-mcp-server')).toEqual(['mine', 'hive'])
      await advanced.set(overrideId('copilot', 'mcpIsolation'), false)
      expect(args()).not.toContain('--disable-builtin-mcps')
      // …and with the switch off too, alone: its old hive_* tools never reach a session beside the cw_* ones.
      expect(args().filter((a, i, all) => all[i - 1] === '--disable-mcp-server')).toEqual(['hive'])
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

  it("is Combwork's alone with the switch on, whatever the user's settings say", async () => {
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'node mine.js', padding: 2 } }))
    const line = await launch()
    expect(line).toEqual({ type: 'command', command: expect.stringMatching(/^curl(\.exe)? .*&statusline"$/), padding: 0 })
    expect(line.command).not.toContain('mine.js')
  })

  it("off, runs the user's own after Combwork's, given the JSON Combwork's server echoes back, with their padding", async () => {
    await advanced.set(overrideId('claude-code', 'statusLine'), false)
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'node mine.js && echo done', padding: 2 } }))
    const line = await launch()
    expect(line.padding).toBe(2)
    expect(line.command).toMatch(/^curl(\.exe)? .*&statusline&echo" \| \(\nnode mine\.js && echo done\n\)$/)
    // The project's own wins over the user's, as Claude Code takes them.
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'project-line' } }))
    expect((await launch()).command).toMatch(/\| \(\nproject-line\n\)$/)
    // None of theirs: Combwork's own, as with the switch on.
    rmSync(join(claudeDir, 'settings.json'))
    rmSync(join(project, 'settings.json'))
    expect(await launch()).toEqual({ type: 'command', command: expect.stringMatching(/&statusline"$/), padding: 0 })
  })

  // Run as Claude Code runs it, with Git's bash (Claude Code's shell on Windows; found from git itself, never WSL's
  // bash): the user's command, however written, gets the echoed JSON unchanged and its output is the status line.
  it("off, chains any command that runs alone in bash: a comment at its end, several lines, a pipeline (HR4's round 1)", async () => {
    const { execFileSync, spawnSync } = await import('child_process')
    const bash = join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '..', '..', '..', 'bin', 'bash.exe')
    expect(existsSync(bash), bash).toBe(true)
    const { hiveStatusLine } = await import('../src/main/providers/claude/launchSettings')
    const json = '{"model":{"display_name":"Opus 5.5"},"note":"a  b\\n#c"}'
    // Combwork's forwarding command stands in as what it prints: the JSON its server echoed.
    const forward = (echo: boolean): string => (echo ? `printf '%s' '${json}'` : 'true')
    const run = (command: string): { out: string; code: number | null } => {
      const line = hiveStatusLine(forward, { type: 'command', command, padding: 3 })
      expect(line.padding).toBe(3)
      const r = spawnSync(bash, ['-c', line.command], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })
      return { out: r.stdout, code: r.status }
    }
    expect(run('printf MYLINE # my status line')).toEqual({ out: 'MYLINE', code: 0 })
    expect(run('read -r line\nprintf "first %s" "$(printf %s "$line" | head -c 10)"')).toEqual({ out: 'first {"model":{', code: 0 })
    expect(run('cat | wc -c | tr -d " "')).toEqual({ out: `${json.length}\n`, code: 0 })
    // The input whole, byte for byte.
    expect(run('cat')).toEqual({ out: json, code: 0 })
    // A command of its own that fails still fails alone: nothing of Combwork's around it hides that.
    expect(run('exit 3').code).toBe(3)
  })
})

describe("Combwork's guidance for agents (#1285, row 13)", () => {
  const codexArgs = (ctx: LaunchContext): string[] => codex.buildCommand('C:\\bin\\codex.exe', ctx).args
  const developer = (args: string[]): string | null => {
    const a = args.findLast((x) => x.startsWith('developer_instructions='))
    return a ? (parseToml(a) as { developer_instructions: string }).developer_instructions : null
  }
  /** Every developer_instructions given, in the command's order (Codex keeps the last). */
  const developers = (args: string[]): string[] => args.filter((x) => x.startsWith('developer_instructions=')).map((x) => (parseToml(x) as { developer_instructions: string }).developer_instructions)
  afterEach(() => rmSync(join(process.env.CODEX_HOME!, 'config.toml'), { force: true }))

  // What Codex itself would give the session (#1285, the Assistant's design in round 4): its offline prompt rendered
  // with the agent's own arguments, as is and with developer_instructions cleared. Combwork parses no profile and ranks no
  // layer; e2e codexownhooks checks the real Codex at every layer (HR4's probes). Here the fake Codex renders it.
  it('reads them from two renders of the prompt: one text more in front is the value, the same renders none', async () => {
    const { developerInstructionsOf } = await import('../src/main/providers/codex/adapter')
    const rest = ['<skills_instructions>', '<permissions instructions>']
    expect(developerInstructionsOf(['Mine.', ...rest], rest)).toBe('Mine.')
    expect(developerInstructionsOf(['  Mine.\n', ...rest], rest)).toBe('Mine.')
    // The same renders: none set, or set empty or blank (an empty one clears every layer below it, in Codex).
    expect(developerInstructionsOf(rest, rest)).toBe('')
    expect(developerInstructionsOf([], [])).toBe('')
    // Anything else Combwork can't tell apart, or a render missing: no answer (Combwork's guidance alone).
    expect(developerInstructionsOf(['Mine.', 'other', ...rest], rest)).toBeNull()
    expect(developerInstructionsOf(['Mine.', '<skills_instructions> changed', rest[1]], rest)).toBeNull()
    expect(developerInstructionsOf(null, rest)).toBeNull()
    expect(developerInstructionsOf(rest, null)).toBeNull()
  })

  it("reads 0.164.0's render: past its tools item with the developer role, across its developer messages (#1514's real tier)", async () => {
    const { developerTexts, developerInstructionsOf } = await import('../src/main/providers/codex/adapter')
    // 0.164.0's render (probed 23 Oct): its tools, its base instructions, then the developer_instructions first in the
    // next developer message, then the multi-agent ones; the user's context.
    const tools = { type: 'additional_tools', id: 'at_1', role: 'developer', tools: [] }
    const message = (...texts: string[]) => ({ type: 'message', role: 'developer', content: texts.map((text) => ({ type: 'input_text', text })) })
    const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>' }] }
    const render = (mine: string[]) => [tools, message('You are Codex, …'), message(...mine, '<skills_instructions>', '<permissions instructions>'), message('<multi_agent_role>'), user]
    expect(developerTexts(render(['USER-ONLY']))).toEqual(['You are Codex, …', 'USER-ONLY', '<skills_instructions>', '<permissions instructions>', '<multi_agent_role>'])
    expect(developerInstructionsOf(developerTexts(render(['USER-ONLY'])), developerTexts(render([])))).toBe('USER-ONLY')
    expect(developerInstructionsOf(developerTexts(render([])), developerTexts(render([])))).toBe('')
    // 0.163.0's: the one developer message, the value in front, no type needed.
    expect(developerInstructionsOf(developerTexts([{ role: 'developer', content: [{ text: 'Mine.' }, { text: '<skills>' }] }]), developerTexts([{ role: 'developer', content: [{ text: '<skills>' }] }]))).toBe('Mine.')
    // One text more but the rest not the same: no answer.
    expect(developerInstructionsOf(['a', 'MINE', 'b', 'c'], ['a', 'b', 'd'])).toBeNull()
    // No developer message: no texts; not a list: no answer.
    expect(developerTexts([tools, user])).toEqual([])
    expect(developerTexts({})).toBeNull()
  })

  it("Codex: Combwork's guidance after the developer_instructions Codex renders for the session's own arguments, never in their place", async () => {
    const fake = join(__dirname, 'e2e', 'fake-codex', 'fake-codex.cmd')
    // A Codex home of this test's own.
    const homeBefore = process.env.CODEX_HOME
    const home = join(base, 'developer-codex-home')
    process.env.CODEX_HOME = home
    mkdirSync(home, { recursive: true })
    const said = join(home, 'fake-developer-instructions.txt')
    const runs = (): { args: string[] }[] => (existsSync(join(home, 'fake-prompt-input.jsonl')) ? readFileSync(join(home, 'fake-prompt-input.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    const env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ComSpec: process.env.ComSpec ?? '', CODEX_HOME: home }
    /** A launch as Combwork makes it: the developer_instructions Codex keeps (the last given), every one given, and its notice. */
    const launch = async (over: Partial<LaunchContext> = {}) => {
      const ctx = context({ executable: fake, runId: `dev-${Math.random()}`, env, ...over })
      await codex.prepareLaunch(ctx)
      const args = codexArgs(ctx)
      return { kept: developer(args), all: developers(args), notice: codex.launchNotice!(ctx), args }
    }
    const launched = async (over: Partial<LaunchContext> = {}): Promise<string | null> => (await launch(over)).kept
    try {
      // Codex renders none: Combwork's alone.
      expect(await launched()).toBe('Combwork guidance')
      // Codex renders some (whatever layer they came from): Combwork's after them, the Assistant's role after that.
      writeFileSync(said, 'Codex says this.')
      expect(await launched()).toBe('Codex says this.\n\nCombwork guidance')
      expect(await launched({ instructions: 'You are the Assistant.' })).toBe('Codex says this.\n\nCombwork guidance\n\nYou are the Assistant.')
      // The agent's own arguments reach Codex untouched (it parses -pmine, -p=mine and the rest), with the cleared render.
      const before = runs().length
      expect(await launched({ extraArgs: ['-pmine', '-m', 'gpt-x'] })).toBe('Codex says this.\n\nCombwork guidance')
      expect(runs().slice(before).map((r) => r.args)).toEqual(expect.arrayContaining([['-pmine', '-m', 'gpt-x'], ['-pmine', '-m', 'gpt-x', '-c', 'developer_instructions=""']]))
      expect(runs().slice(before)).toHaveLength(2)
      // Asked again at every launch (HR4's round 4: no cache): only what Codex renders changed, and Combwork takes it.
      writeFileSync(said, 'SECOND-TARGET')
      expect(await launched({ extraArgs: ['-pmine', '-m', 'gpt-x'] })).toBe('SECOND-TARGET\n\nCombwork guidance')
      // Set empty or blank where Codex takes them: the same renders, Combwork's alone.
      for (const v of ['', '   ']) {
        writeFileSync(said, v)
        expect(await launched(), JSON.stringify(v)).toBe('Combwork guidance')
      }

      // The user's own -c developer_instructions in Extra arguments (HR4's round 4): already in what Codex renders, and
      // Combwork's combined value comes after it, so it is the one Codex keeps. Its forms, with the Assistant's role too.
      rmSync(said)
      for (const flag of ['-c', '--config']) {
        const extra = [flag, 'developer_instructions="EXTRA-ONLY"']
        const agent = await launch({ extraArgs: extra })
        expect(agent.kept, flag).toBe('EXTRA-ONLY\n\nCombwork guidance')
        expect(agent.all, flag).toEqual(['EXTRA-ONLY', 'EXTRA-ONLY\n\nCombwork guidance'])
        expect((await launch({ extraArgs: extra, instructions: 'You are the Assistant.' })).kept).toBe('EXTRA-ONLY\n\nCombwork guidance\n\nYou are the Assistant.')
        // No guidance of Combwork's: theirs alone, as they gave it.
        expect((await launch({ extraArgs: extra, guidance: '' })).all).toEqual(['EXTRA-ONLY'])
      }

      // Codex can't say (a render failing): never anything in place of the user's own (HR4's round 4, the Assistant's
      // decision). An agent: no override at all, its guidance missing, told once; the Assistant: its role alone, told.
      writeFileSync(said, '!fail')
      const failed = await launch()
      expect(failed.all).toEqual([])
      expect(failed.notice?.title).toBe("Combwork's guidance is missing for this agent")
      expect(failed.notice?.message).toMatch(/leaves yours as they are and adds none of its guidance/)
      const theirsKept = await launch({ extraArgs: ['-c', 'developer_instructions="EXTRA-ONLY"'] })
      expect(theirsKept.all).toEqual(['EXTRA-ONLY'])
      const assistant = await launch({ instructions: 'You are the Assistant.' })
      expect(assistant.kept).toBe('You are the Assistant.')
      expect(assistant.notice?.title).toBe('The Assistant started with its role only')
      // A launch Codex could answer has no notice.
      writeFileSync(said, 'Codex says this.')
      expect((await launch()).notice).toBeNull()
      // No guidance of Combwork's (the switch off, or no Combwork tools): nothing passed, and Codex isn't asked.
      const none = runs().length
      expect(await launched({ guidance: '' })).toBeNull()
      expect(runs()).toHaveLength(none)
    } finally {
      process.env.CODEX_HOME = homeBefore
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("reads Codex's render no longer than Settings → Advanced says (codex.promptInput.timeoutSeconds)", () => {
    expect(advancedDef('codex.promptInput.timeoutSeconds')).toMatchObject({ group: 'codex', kind: 'number', default: 15, unit: 's', applies: 'sessions' })
  })

  it('is a switch of its own under Combwork, on by default, taken by sessions started afterwards (e2e agentguidance checks the hive server it gives)', async () => {
    const { CW_GUIDANCE } = await import('../src/shared/advanced')
    expect(advancedDef(CW_GUIDANCE)).toMatchObject({ group: 'cw', kind: 'boolean', default: true, applies: 'sessions' })
  })
})

// Row 11 has no switch (Darren, 21 Oct): Codex keeps the user's hooks beside Combwork's, each layer's under its own key, and
// merges the trust table (e2e codexownhooks asks the installed Codex). Combwork's part: its hooks and its trust records are
// its own session-flags keys only, so nothing of the user's is named, replaced or trusted by Combwork.
describe("Codex: Combwork's hooks beside the user's own (row 11)", () => {
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
