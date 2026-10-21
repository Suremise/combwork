// "The CLI's own setting" (#1284, #966 row 1, Darren's decision on #1120 point 3): a permission choice every provider
// offers, where Hive passes no mode flag. The session keeps saying so (never a mode guessed or read off the CLI), no mode
// switches live to or from it, and the Hive Assistant is never offered it.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import type { LaunchContext } from '../src/main/providers/types'
import { CLI_OWN_MODE, isCliOwnMode } from '../src/shared/cliOwnMode'
import { assistantProjectConfig } from '../src/shared/assistant'
import { DEFAULT_PROJECT_CONFIG, DEFAULT_SETTINGS } from '../src/shared/defaults'
import { PROVIDERS, agentLaunchSettings, canSwitchModeLive, modeAllowed, modeBadgeLabel, offeredModes, permissionLabel } from '../src/shared/providers'
import { settingEntry, settingOptions } from '../src/shared/settingsCatalog'
import type { AppSettings, ProjectConfig } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-cliown-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const homes = { CODEX_HOME: process.env.CODEX_HOME, COPILOT_HOME: process.env.COPILOT_HOME }
// Never the user's own homes: the adapters read their config.
process.env.CODEX_HOME = join(base, 'codex-home')
process.env.COPILOT_HOME = join(base, 'copilot-home')
afterAll(() => {
  for (const [k, v] of Object.entries(homes)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(base, { recursive: true, force: true })
})

const settings = structuredClone(DEFAULT_SETTINGS) as AppSettings

describe('the choice', () => {
  it("is every provider's, last, allowed without any opt-in, named in English for agents and short on the badge", () => {
    for (const p of PROVIDERS) {
      expect(p.permissionModes.at(-1)?.value).toBe(CLI_OWN_MODE)
      expect(offeredModes(p.id, settings).map((m) => m.value)).toContain(CLI_OWN_MODE)
      expect(modeAllowed(p.id, CLI_OWN_MODE, settings)).toBe(true)
      expect(permissionLabel(p.id, CLI_OWN_MODE)).toBe("The CLI's own setting")
      expect(modeBadgeLabel(p.id, CLI_OWN_MODE)).toBe("CLI's own")
      // Other modes keep their own name on the badge.
      expect(modeBadgeLabel(p.id, p.defaultPermissionMode)).toBe(permissionLabel(p.id, p.defaultPermissionMode))
    }
    expect(isCliOwnMode('cli-own')).toBe(true)
    expect(isCliOwnMode('auto')).toBe(false)
  })

  it('is an agent’s, a project’s or the default’s, as any mode', () => {
    const cfg = { ...structuredClone(DEFAULT_PROJECT_CONFIG), providers: { 'claude-code': { model: 'inherit', effort: 'inherit', permissionMode: CLI_OWN_MODE, extraArgs: '', use200kContext: 'inherit' } } } as unknown as ProjectConfig
    expect(agentLaunchSettings({ provider: 'claude-code' }, cfg, settings).permissionMode).toBe(CLI_OWN_MODE)
    expect(agentLaunchSettings({ provider: 'claude-code', permissionMode: 'plan' }, cfg, settings).permissionMode).toBe('plan')
    expect(agentLaunchSettings({ provider: 'codex', permissionMode: CLI_OWN_MODE }, DEFAULT_PROJECT_CONFIG, settings).permissionMode).toBe(CLI_OWN_MODE)
  })

  it('switches nothing live: never to it, never from it, whatever the provider says', () => {
    for (const p of PROVIDERS) {
      const other = p.permissionModes.find((m) => !m.cliOwn && !m.danger)!.value
      expect(canSwitchModeLive(p.id, CLI_OWN_MODE, other, other)).toBe(false)
      expect(canSwitchModeLive(p.id, other, CLI_OWN_MODE, CLI_OWN_MODE)).toBe(false)
      expect(canSwitchModeLive(p.id, other, CLI_OWN_MODE, null)).toBe(false)
    }
    // Between the provider's own modes, as before (Codex: every preset from its menu).
    expect(canSwitchModeLive('codex', 'ask', 'read-only', 'read-only')).toBe(true)
    expect(canSwitchModeLive('claude-code', 'plan', 'auto', 'auto')).toBe(true)
  })

  it('is never the Assistant’s: not offered, and one set anyway is its provider’s Assistant mode', () => {
    for (const p of PROVIDERS) expect(offeredModes(p.id, settings, true).map((m) => m.value)).not.toContain(CLI_OWN_MODE)
    const s = structuredClone(settings)
    s.assistant.providers = { 'claude-code': { model: '', effort: '', permissionMode: CLI_OWN_MODE, extraArgs: '', use200kContext: '' } } as AppSettings['assistant']['providers']
    const cfg = assistantProjectConfig({ ...structuredClone(DEFAULT_PROJECT_CONFIG), agents: [{ id: 'assistant', name: 'Assistant', permissionMode: CLI_OWN_MODE }] } as unknown as ProjectConfig, s)
    expect(cfg.providers['claude-code'].permissionMode).toBe(PROVIDERS.find((p) => p.id === 'claude-code')!.assistantMode)
    expect(cfg.agents[0].permissionMode).toBeUndefined()
    // Nor among the options the Assistant's settings take through the Agent API.
    const options = settingOptions(settingEntry('assistant.claude-code.permissionMode')!)!.map((o) => o.value)
    expect(options).toContain('plan')
    expect(options).not.toContain(CLI_OWN_MODE)
  })
})

describe('a launch on it', () => {
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

  it('Claude Code: no --permission-mode (Auto passes it)', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const args = (mode: string) => claudeCode.buildCommand('C:\\bin\\claude.exe', context({ permissionMode: mode })).args
    expect(args('auto').join(' ')).toContain('--permission-mode auto')
    expect(args(CLI_OWN_MODE)).not.toContain('--permission-mode')
    expect(args(CLI_OWN_MODE).join(' ')).not.toContain('cli-own')
  })

  it('Codex: no sandbox, approval or Approve for me flag (Ask passes its two)', async () => {
    const { codex } = await import('../src/main/providers/codex/adapter')
    const args = (mode: string) => codex.buildCommand('C:\\bin\\codex.exe', context({ permissionMode: mode })).args
    expect(args('ask').join(' ')).toContain('-s workspace-write -a on-request')
    for (const flag of ['-s', '-a', '--approve-for-me', '--sandbox', '--ask-for-approval']) expect(args(CLI_OWN_MODE)).not.toContain(flag)
    expect(args(CLI_OWN_MODE).join(' ')).not.toContain('cli-own')
  })

  it('Copilot: no mode flag and no edit rule (Accept edits passes its write rule, Allow all its flag)', async () => {
    const { copilot } = await import('../src/main/providers/copilot/adapter')
    const args = (mode: string) => copilot.buildCommand('C:\\bin\\copilot.exe', context({ permissionMode: mode })).args
    expect(args('accept-edits').some((a) => a.startsWith('--allow-tool=write('))).toBe(true)
    expect(args('allow-all')).toContain('--allow-all')
    const own = args(CLI_OWN_MODE)
    for (const flag of ['--allow-all', '--plan', '--autopilot']) expect(own).not.toContain(flag)
    expect(own.some((a) => a.startsWith('--allow-tool=write('))).toBe(false)
    expect(own.join(' ')).not.toContain('cli-own')
    expect(copilot.launchNotice!(context({ permissionMode: CLI_OWN_MODE, cwd: join(base, 'with (parens)') }))).toBeNull()
  })
})

// A running session started on it, as sessions.ts holds it (no process runs).
describe('a running session on it', () => {
  const wsPath = join(base, 'ws')
  const p = join(wsPath, 'own')
  let w: { open: (p: string) => Promise<void>; assistantHome: string }
  let sessions: typeof import('../src/main/sessions').sessions
  let run: <T>(fn: () => Promise<T> | T) => Promise<T>
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    const ws = await import('../src/main/workspace')
    sessions = (await import('../src/main/sessions')).sessions
    const svc = ws.createWorkspaceService()
    await svc.open(wsPath)
    w = svc as never
    run = (fn) => ws.inWorkspace(svc, async () => fn())
  })
  afterAll(() => (sessions as unknown as { live: Map<string, unknown> }).live.clear())

  let n = 0
  async function live(provider: 'claude-code' | 'codex', launchMode: string, projectPath = p) {
    const adapter = provider === 'codex' ? (await import('../src/main/providers/codex/adapter')).codex : (await import('../src/main/providers/claude/adapter')).claudeCode
    const agentId = projectPath === p ? `a${++n}` : 'assistant'
    const state: Record<string, unknown> = { provider, runId: `run-own-${++n}`, projectPath, agentId, cwd: projectPath, status: 'ready', startedAt: new Date().toISOString(), launchSignature: '', unseen: false, permissionMode: launchMode }
    const l = { state, adapter, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode, configuredMode: launchMode, recognition: { footerOf: () => null } }
    const s = sessions as unknown as { live: Map<string, unknown>; runs: Map<string, string> }
    s.live.set(`${projectPath.toLowerCase()}#${agentId}`, l)
    s.runs.set(state.runId as string, `${projectPath.toLowerCase()}#${agentId}`)
    return { state, l, agentId }
  }
  const footer = (text: string) => ({ text: () => text })

  it('keeps saying so when the CLI shows a mode (its footer, its status), recording the mode seen', async () => {
    const { state, l } = await live('claude-code', CLI_OWN_MODE)
    const priv = sessions as unknown as { readFooterMode: (l: unknown, s: unknown) => void; applyDetails: (l: unknown, d: object) => void; observeMode: (l: unknown, m: string) => void }
    priv.readFooterMode(l, footer('⏵⏵ accept edits on (shift+tab to cycle)'))
    expect(state.permissionMode).toBe(CLI_OWN_MODE)
    expect(state.modeObserved).toBe('acceptEdits')
    priv.applyDetails(l, { permissionMode: 'plan' })
    expect(state.permissionMode).toBe(CLI_OWN_MODE)
    expect(state.modeObserved).toBe('plan')
    // A session launched in a mode follows what its CLI shows, as before.
    const other = await live('claude-code', 'auto')
    priv.readFooterMode(other.l, footer('⏵⏵ accept edits on (shift+tab to cycle)'))
    expect(other.state.permissionMode).toBe('acceptEdits')
    priv.observeMode(other.l, 'plan')
    expect(other.state.permissionMode).toBe('plan')
  })

  it('switches to a mode only by restarting, and a mode-launched one to it only by restarting', async () => {
    const own = await live('codex', CLI_OWN_MODE)
    expect(await run(() => sessions.setPermissionMode(p, own.agentId, 'ask'))).toMatchObject({ ok: false, restart: true })
    const preset = await live('codex', 'ask')
    expect(await run(() => sessions.setPermissionMode(p, preset.agentId, CLI_OWN_MODE))).toMatchObject({ ok: false, restart: true })
    expect(preset.state.permissionMode).toBe('ask')
  })

  it("refuses it for the Assistant, live or by a restart, naming Control", async () => {
    const a = await live('claude-code', 'auto', w.assistantHome)
    await expect(run(() => sessions.setPermissionMode(w.assistantHome, a.agentId, CLI_OWN_MODE))).rejects.toThrow(/Control setting relies on knowing the mode/)
    await expect(run(() => sessions.restartInMode(w.assistantHome, a.agentId, CLI_OWN_MODE))).rejects.toThrow(/Control setting relies on knowing the mode/)
    expect(a.state.permissionMode).toBe('auto')
  })
})
