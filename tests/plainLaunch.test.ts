import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { advanced } from '../src/main/advanced'
import { claudeCode } from '../src/main/providers/claude/adapter'
import { codex } from '../src/main/providers/codex/adapter'
import { copilot } from '../src/main/providers/copilot/adapter'
import type { LaunchContext } from '../src/main/providers/types'
import { launchPolicy, terminalPreset } from '../src/shared/launchPolicy'
import type { ProviderId } from '../src/shared/types'
import { tempDir } from './tempDir'

// "Launch as from a terminal" (HI-2670): a launch on a connection with every switch off, as sessions.ts prepares it (no
// combwork server, guidance, notes, skills or Combwork's variables; every override off), gets none of Combwork's
// additions to what the model sees. Each CLI keeps only what reports its status to Combwork, listed here by name: its
// hooks, Claude Code's status line forwarder and its MCP file (empty), Copilot's hooks plugin and its MCP file (empty).

const base = tempDir('cw-plain-launch-')
const homes = { CODEX_HOME: process.env.CODEX_HOME, COPILOT_HOME: process.env.COPILOT_HOME }
beforeAll(() => {
  // Never the user's own homes: the adapters read their config.
  process.env.CODEX_HOME = join(base, 'codex-home')
  process.env.COPILOT_HOME = join(base, 'copilot-home')
  mkdirSync(join(base, 'profile'), { recursive: true })
  advanced.load(join(base, 'profile'))
})
afterAll(() => {
  advanced.stop()
  for (const [k, v] of Object.entries(homes)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(base, { recursive: true, force: true })
})

let n = 0
/** A launch as sessions.ts makes it: with everything (`plain` false), or on a connection with the terminal preset. */
function launch(cli: ProviderId, plain: boolean, over: Partial<LaunchContext> = {}): LaunchContext {
  const cwd = join(base, 'proj')
  mkdirSync(cwd, { recursive: true })
  const run = `r${++n}`
  const policy = launchPolicy(plain ? { launch: terminalPreset(cli) } : null, cli)
  return {
    projectPath: cwd, agentId: `a-${n}`, executable: 'C:\\bin\\cli.exe', cwd, workspacePath: base, runId: run, sessionId: '0cb916db-26aa-40f2-86b5-1ba81b225fd2',
    resume: false, name: '', skills: [], model: null, effort: null, permissionMode: null, extraArgs: [],
    mcpServers: plain ? {} : { combwork: { command: 'node', args: ['cw-mcp.js'], env: { CW_GUIDANCE: '1' } } },
    hookUrl: `http://127.0.0.1:5000/hook?run=${run}`, hookAuthFile: join(base, 'auth.txt'), privateDir: join(base, `private-${run}`),
    guidance: plain ? '' : 'Combwork guidance', notes: plain ? '' : 'Workspace notes', allowBackgroundSessions: false, use200kContext: false,
    overrides: policy.overrides,
    env: plain ? { PATH: 'C:\\Windows', CW_HOOK_TOKEN: 't', CW_RUN_ID: run } : { PATH: 'C:\\Windows', CW_HOOK_TOKEN: 't', CW_RUN_ID: run, CW_PROJECT: 'proj', CW_AGENT: 'HB1', CW_API_URL: 'http://127.0.0.1:5000' },
    ...over
  }
}

/** The values a command's `-c` options set, by their key. */
const configKeys = (args: string[]): string[] => args.filter((_a, i) => args[i - 1] === '-c').map((v) => v.split('=')[0])

describe('Claude Code, launched as from a terminal', () => {
  it("passes none of Combwork's additions: no strict MCP, appended prompt, pre-approved tools or prompt snapshot", async () => {
    const full = launch('claude-code', false, { resume: true, cliVersion: '2.1.305', trustedCombworkTools: ['cw_inbox'] })
    await claudeCode.prepareLaunch(full)
    const everything = claudeCode.buildCommand('C:\\bin\\claude.exe', full).args
    // With everything, as before.
    expect(everything).toEqual(expect.arrayContaining(['--strict-mcp-config', '--append-system-prompt-file', '--allowedTools', '--system-prompt-snapshot']))
    const ctx = launch('claude-code', true, { resume: true, cliVersion: '2.1.305' })
    await claudeCode.prepareLaunch(ctx)
    const args = claudeCode.buildCommand('C:\\bin\\claude.exe', ctx).args
    for (const flag of ['--strict-mcp-config', '--append-system-prompt-file', '--allowedTools', '--system-prompt-snapshot']) expect(args, flag).not.toContain(flag)
    // Its MCP file has no server: the user's own config decides, with --strict-mcp-config gone.
    expect(JSON.parse(readFileSync(join(ctx.privateDir, 'mcp.json'), 'utf8')).mcpServers).toEqual({})
    // Its settings hold only what reports status: its hooks, and the status line forwarder (the user's own after it).
    const settings = JSON.parse(readFileSync(join(ctx.privateDir, 'settings.json'), 'utf8'))
    expect(Object.keys(settings).sort()).toEqual(['hooks', 'statusLine'])
  })
})

describe('Codex, launched as from a terminal', () => {
  it("passes no title items, MCP servers, servers turned off, or developer instructions: only its hooks and launch settings", () => {
    const everything = configKeys(codex.buildCommand('C:\\bin\\codex.exe', launch('codex', false)).args)
    expect(everything).toEqual(expect.arrayContaining(['tui.terminal_title', 'mcp_servers.combwork']))
    const keys = configKeys(codex.buildCommand('C:\\bin\\codex.exe', launch('codex', true)).args)
    for (const k of keys) expect(k, k).toMatch(/^(hooks\.|projects$|notice\.hide_rate_limit_model_nudge$)/)
    expect(keys.some((k) => k.startsWith('hooks.'))).toBe(true)
  })
})

describe('Copilot, launched as from a terminal', () => {
  it("passes no MCP instructions, isolation, pre-approval or update switch, and writes no instructions of Combwork's", async () => {
    const full = launch('copilot', false)
    await copilot.prepareLaunch(full)
    const all = copilot.buildCommand('C:\\bin\\copilot.exe', full)
    expect(all.args).toEqual(expect.arrayContaining(['--allow-all-mcp-server-instructions', '--disable-builtin-mcps', '--allow-tool=combwork', '--no-auto-update']))
    const ctx = launch('copilot', true)
    await copilot.prepareLaunch(ctx)
    const cmd = copilot.buildCommand('C:\\bin\\copilot.exe', ctx)
    for (const flag of ['--allow-all-mcp-server-instructions', '--disable-builtin-mcps', '--no-auto-update']) expect(cmd.args, flag).not.toContain(flag)
    // Its permission mode's own approvals stay (the connection's mode); none of Combwork's server.
    expect(cmd.args.some((a) => a.startsWith('--allow-tool=combwork') || a === '--disable-mcp-server')).toBe(false)
    expect(cmd.env?.COPILOT_AUTO_UPDATE).toBeUndefined()
    expect(cmd.env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBeUndefined()
    expect(JSON.parse(readFileSync(join(ctx.privateDir, 'mcp.json'), 'utf8')).mcpServers).toEqual({})
    expect(existsSync(join(ctx.privateDir, 'instructions', '.github', 'instructions', 'combwork.instructions.md'))).toBe(false)
  })
})
