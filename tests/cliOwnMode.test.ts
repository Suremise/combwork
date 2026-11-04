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
import { legacyLaunchSettings as agentLaunchSettings } from '../src/shared/connectionDefaults'
import { PROVIDERS, canSwitchModeLive, modeAllowed, modeBadgeLabel, offeredModes, permissionLabel } from '../src/shared/providers'
import { settingEntry } from '../src/shared/settingsCatalog'
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
    // Settings → Assistant has no per-provider mode any more (HI-2108): its connection holds it, and its launch never
    // takes the CLI's own (sessions' effective()).
    expect(settingEntry('assistant.claude-code.permissionMode')).toBeUndefined()
  })
})

describe('a launch on it', () => {
  function context(over: Partial<LaunchContext> = {}): LaunchContext {
    const cwd = join(base, 'proj')
    mkdirSync(cwd, { recursive: true })
    return {
      projectPath: cwd, agentId: 'a-1', executable: 'C:\\bin\\cli.exe', cwd, workspacePath: base, runId: 'r1', sessionId: '0cb916db-26aa-40f2-86b5-1ba81b225fd2',
      resume: false, name: '', skills: [], mcpServers: { combwork: { command: 'node', args: ['cw-mcp.js'] } }, model: null, effort: null, permissionMode: null, extraArgs: [],
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

// A conversation resumed on it (#1284: the brief's resume guarantee): the same command, resuming the conversation,
// with still no mode flag; what the session then shows is the next describe's.
describe('a resumed launch on it', () => {
  const SID = '0cb916db-26aa-40f2-86b5-1ba81b225fd2'
  const context = (over: Partial<LaunchContext>): LaunchContext => {
    const cwd = join(base, 'proj')
    mkdirSync(cwd, { recursive: true })
    return {
      projectPath: cwd, agentId: 'a-1', executable: 'C:\\bin\\cli.exe', cwd, workspacePath: base, runId: 'r2', sessionId: SID,
      resume: true, name: '', skills: [], mcpServers: { combwork: { command: 'node', args: ['cw-mcp.js'] } }, model: null, effort: null, permissionMode: CLI_OWN_MODE, extraArgs: [],
      hookUrl: 'http://127.0.0.1:5000/hook?run=r2', hookAuthFile: join(base, 'auth.txt'), privateDir: join(base, 'private'), guidance: 'Hive guidance', allowBackgroundSessions: false, use200kContext: false,
      env: { PATH: 'C:\\Windows' },
      ...over
    }
  }

  it('Claude Code: --resume <id>, no --permission-mode', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const args = claudeCode.buildCommand('C:\\bin\\claude.exe', context({})).args
    expect(args.join(' ')).toContain(`--resume ${SID}`)
    expect(args).not.toContain('--permission-mode')
    expect(claudeCode.buildCommand('C:\\bin\\claude.exe', context({ permissionMode: 'plan' })).args.join(' ')).toContain('--permission-mode plan')
  })

  it('Codex: resume <id>, no sandbox, approval or Approve for me flag', async () => {
    const { codex } = await import('../src/main/providers/codex/adapter')
    const args = codex.buildCommand('C:\\bin\\codex.exe', context({})).args
    expect(args.slice(0, 2)).toEqual(['resume', SID])
    for (const flag of ['-s', '-a', '--approve-for-me']) expect(args).not.toContain(flag)
    expect(codex.buildCommand('C:\\bin\\codex.exe', context({ permissionMode: 'approve-for-me' })).args).toContain('--approve-for-me')
  })

  it('Copilot: its resume, no mode flag or edit rule', async () => {
    const { copilot } = await import('../src/main/providers/copilot/adapter')
    const args = copilot.buildCommand('C:\\bin\\copilot.exe', context({})).args
    expect(args.join(' ')).toContain(SID)
    for (const flag of ['--allow-all', '--plan', '--autopilot']) expect(args).not.toContain(flag)
    expect(args.some((a) => a.startsWith('--allow-tool=write('))).toBe(false)
    expect(copilot.buildCommand('C:\\bin\\copilot.exe', context({ permissionMode: 'allow-all' })).args).toContain('--allow-all')
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
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    const ws = await import('../src/main/workspace')
    sessions = (await import('../src/main/sessions')).sessions
    const svc = ws.createWorkspaceService()
    await svc.open(wsPath)
    w = svc as never
    run = (fn) => ws.inWorkspace(svc, async () => fn())
  })
  afterAll(() => (sessions as unknown as { live: Map<string, unknown> }).live.clear())

  let n = 0
  async function live(provider: 'claude-code' | 'codex' | 'copilot', launchMode: string, projectPath = p, over: { resumed?: boolean; title?: boolean } = {}) {
    const adapter =
      provider === 'codex' ? (await import('../src/main/providers/codex/adapter')).codex : provider === 'copilot' ? (await import('../src/main/providers/copilot/adapter')).copilot : (await import('../src/main/providers/claude/adapter')).claudeCode
    const agentId = projectPath === p ? `a${++n}` : 'assistant'
    const state: Record<string, unknown> = { provider, runId: `run-own-${++n}`, projectPath, agentId, cwd: projectPath, status: 'ready', startedAt: new Date().toISOString(), launchSignature: '', unseen: false, permissionMode: launchMode, ...(over.resumed ? { sessionId: '0cb916db-26aa-40f2-86b5-1ba81b225fd2' } : {}) }
    // `title`: Codex's attention read from its terminal title (its terminalTitle switch on), saying no person must act yet.
    const l = { state, adapter, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode, configuredMode: launchMode, recognition: { footerOf: () => null }, resumed: !!over.resumed, ...(over.title ? { titleAttention: () => false } : {}) }
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

  it('resumed, keeps saying so for every provider, the mode each CLI reports recorded as seen', async () => {
    const priv = sessions as unknown as { readFooterMode: (l: unknown, s: unknown) => void; applyDetails: (l: unknown, d: object) => void; observeMode: (l: unknown, m: string) => void }
    // Claude Code: its footer and its hooks (handleHook's observeMode).
    const claude = await live('claude-code', CLI_OWN_MODE, p, { resumed: true })
    priv.readFooterMode(claude.l, footer('⏵⏵ auto mode on (shift+tab to cycle)'))
    priv.observeMode(claude.l, 'acceptEdits')
    expect([claude.state.permissionMode, claude.state.modeObserved]).toEqual([CLI_OWN_MODE, 'acceptEdits'])
    // Codex: its rollout's preset, through the status details.
    const cx = await live('codex', CLI_OWN_MODE, p, { resumed: true })
    priv.applyDetails(cx.l, { permissionMode: 'ask' })
    expect([cx.state.permissionMode, cx.state.modeObserved]).toEqual([CLI_OWN_MODE, 'ask'])
    // Copilot: its footer.
    const cp = await live('copilot', CLI_OWN_MODE, p, { resumed: true })
    priv.readFooterMode(cp.l, footer('· Plan · Manual Approval ·'))
    expect([cp.state.permissionMode, cp.state.modeObserved]).toEqual([CLI_OWN_MODE, 'plan'])
    // Each one's live switch still restarts.
    for (const [a, to] of [[claude, 'plan'], [cx, 'read-only'], [cp, 'plan']] as const) expect(await run(() => sessions.setPermissionMode(p, a.agentId, to))).toMatchObject({ ok: false, restart: true })
  })

  // Codex's Approve for me: its reviewer, not a person, answers its permission requests (ModeOption.reviewed). On the CLI's
  // own setting Hive knows it from the mode Codex reports, for its status: by its hooks or its title (#1284 round 1).
  describe("Codex's reviewer, by the mode Codex reports", () => {
    const priv = () => sessions as unknown as { applyDetails: (l: unknown, d: object) => void; statusInput: (l: unknown) => { reviewed: boolean; attention: string }; guardCandidate: (l: unknown, ev: object) => boolean }
    const ask = { kind: 'ask', ask: { kind: 'permission', blocking: true, message: 'Codex asks to run a command' } } as const
    const step = async (launchMode: string, reported: string | null, title: boolean) => {
      const { hookStep, titleStep } = await import('../src/main/hookStatus')
      const a = await live('codex', launchMode, p, { title })
      a.state.status = 'working'
      if (reported) priv().applyDetails(a.l, { permissionMode: reported })
      const input = priv().statusInput(a.l)
      return { a, input, result: hookStep(ask as never, input as never), raised: titleStep(true, input as never), guard: priv().guardCandidate(a.l, ask) }
    }
    for (const title of [false, true]) {
      const how = title ? 'its title' : 'its hooks'
      it(`by ${how}: reported Approve for me, a permission request is the reviewer's, as on an explicit Approve for me`, async () => {
        for (const [launch, reported] of [[CLI_OWN_MODE, 'approve-for-me'], ['approve-for-me', null]] as const) {
          const { a, input, result, guard } = await step(launch, reported, title)
          expect(input.attention).toBe(title ? 'title' : 'hooks')
          expect(input.reviewed).toBe(true)
          expect(result).toMatchObject({ next: null, review: ask.ask.message, actions: [] })
          expect(guard).toBe(false)
          expect(a.state.permissionMode).toBe(launch)
        }
      })
      it(`by ${how}: reported Ask (or nothing yet), it is put to you`, async () => {
        for (const reported of ['ask', null]) {
          const { input, result } = await step(CLI_OWN_MODE, reported, title)
          expect(input.reviewed).toBe(false)
          expect((result as { review?: string | null }).review ?? null).toBeNull()
          if (title) expect(result).toMatchObject({ next: null, open: [ask.ask] })
          else expect(result).toMatchObject({ next: 'waiting', actions: expect.arrayContaining(['notifyWaiting']) })
        }
      })
    }
    it('by its title: the reviewer handing one to you still reaches you on Approve for me (the title says so)', async () => {
      const { input, raised } = await step(CLI_OWN_MODE, 'approve-for-me', true)
      expect(input.reviewed).toBe(true)
      expect(raised).toMatchObject({ next: 'waiting', actions: expect.arrayContaining(['notifyWaiting']) })
    })
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
