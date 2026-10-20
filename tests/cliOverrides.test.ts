import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { advanced } from '../src/main/advanced'
import { claudeCode } from '../src/main/providers/claude/adapter'
import { codex } from '../src/main/providers/codex/adapter'
import { copilot } from '../src/main/providers/copilot/adapter'
import { copilotEnv } from '../src/main/providers/copilot/home'
import { copilotCheckEnv } from '../src/main/providers/copilot/install'
import { catalogArgs } from '../src/main/providers/copilot/models'
import type { LaunchContext } from '../src/main/providers/types'
import { ADVANCED_DEFS, advancedDef, overrideId, rightClickToCliId } from '../src/shared/advanced'
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
    expect(switches.map((d) => d.id).sort()).toEqual(['claude-code.override.promptSnapshotOff', 'codex.override.terminalTitle', 'copilot.override.allMcpInstructions', 'copilot.override.noAutoUpdate'])
    for (const d of switches) {
      expect(d, d.id).toMatchObject({ kind: 'boolean', default: true, applies: 'sessions' })
      expect(d.id).toBe(overrideId(d.group, d.id.split('.').slice(2).join('.')))
    }
    // Every id of that form is marked as one.
    expect(ADVANCED_DEFS.filter((d) => d.id.split('.')[1] === 'override' && !d.override)).toEqual([])
  })

  it('pass right-click to the CLIs that track the mouse (row 25): Copilot and Codex, not Claude Code', () => {
    for (const p of ['copilot', 'codex']) expect(advancedDef(rightClickToCliId(p)), p).toMatchObject({ kind: 'boolean', default: false, applies: 'now' })
    expect(advancedDef(rightClickToCliId('claude-code'))).toBeUndefined()
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
    // Other tools' tokens are still left out (#450): that is another override, with its own card (#1281).
    expect(copilotEnv({ GH_TOKEN: 'x' }).GH_TOKEN).toBeUndefined()
  })
})
