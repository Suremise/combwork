import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { advanced } from '../src/main/advanced'
import { copilot, copilotHooks, copilotMcpServer, toolNamesLine } from '../src/main/providers/copilot/adapter'
import { COPILOT_ENV_STRIP, copilotEnv } from '../src/main/providers/copilot/home'
import { parseCopilotModels } from '../src/main/providers/copilot/models'
import type { LaunchContext } from '../src/main/providers/types'
import { COPILOT_DESCRIPTOR, copilotCanApproveEdits, copilotCanSwitchLive, copilotFooterMode, copilotModeFlags, copilotModelLabel, copilotPathGlob } from '../src/shared/copilot'
import { isKnownProvider, providerDescriptor } from '../src/shared/providers'
import { tempDir } from './tempDir'

// Payloads and screens as Copilot CLI 1.0.93 sent and drew them (the #403 spike), with paths shortened.

const base = tempDir('hive-copilot-')
afterAll(() => rmSync(base, { recursive: true, force: true }))
// Never the user's ~/.copilot: the adapter reads its mcp-config.json and settings.json.
process.env.COPILOT_HOME = join(base, 'copilot-home')

function context(over: Partial<LaunchContext> = {}): LaunchContext {
  const cwd = join(base, 'proj')
  mkdirSync(cwd, { recursive: true })
  return {
    projectPath: cwd, agentId: 'a-1', executable: 'C:\\bin\\copilot.exe', cwd, workspacePath: base, runId: 'r1', sessionId: '0cb916db-26aa-40f2-86b5-1ba81b225fd2',
    resume: false, name: 'Agent 1', skills: [], mcpServers: { combwork: { command: 'node', args: ['cw-mcp.js'], env: { CW_PROJECT: 'proj' } } }, model: null, effort: null, permissionMode: 'ask', extraArgs: [],
    hookUrl: 'http://127.0.0.1:5000/hook?run=r1', hookAuthFile: join(base, 'auth.txt'), privateDir: join(base, 'private'), guidance: 'Combwork guidance', allowBackgroundSessions: false, use200kContext: false,
    env: { PATH: 'C:\\Windows', GH_TOKEN: 'gho_stray', GITHUB_TOKEN: 'ghp_other', COPILOT_GITHUB_TOKEN: 'github_pat_x', CW_HOOK_TOKEN: 'tok123' },
    ...over
  }
}

describe('Copilot descriptor', () => {
  it('is registered with its modes, efforts and capabilities', () => {
    expect(isKnownProvider('copilot')).toBe(true)
    const d = providerDescriptor('copilot')
    expect(d.name).toBe('GitHub Copilot')
    expect(d.permissionModes.map((m) => m.value)).toEqual(['ask', 'accept-edits', 'plan', 'autopilot', 'allow-all', 'cli-own'])
    expect(d.defaultPermissionMode).toBe('accept-edits')
    // Only Autopilot is behind the opt-in: Allow all is Copilot's low-interaction mode, offered to all (#490).
    expect(d.permissionModes.filter((m) => m.danger).map((m) => m.value)).toEqual(['autopilot'])
    expect(d.effortLevels.map((e) => e.value)).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(d.capabilities).toMatchObject({ fixedSessionId: true, liveModeSwitch: 'cycle', reportsCost: true, lockAsk: true, compactFocus: true })
    expect(d.modelGroups[0].models.map((m) => m.value)).toEqual(['auto'])
  })

  it('names models as Copilot lists them', () => {
    expect(copilotModelLabel('claude-sonnet-5.5')).toBe('Claude Sonnet 5.5')
    expect(copilotModelLabel('gpt-6-luna')).toBe('GPT-6 Luna')
    expect(copilotModelLabel('mai-code-1.1-flash')).toBe('MAI Code 1.1 Flash')
    expect(copilotModelLabel('kimi-k3')).toBe('Kimi K3')
    expect(copilotModelLabel('auto')).toBe('Auto')
    expect(copilotModelLabel('my model/x')).toBe('my model/x')
  })
})

describe('Copilot footer and modes', () => {
  it('reads the mode from the footer, wide or wrapped item by item in a narrow terminal', () => {
    expect(copilotFooterMode(' ← open sidebar · Interactive · Manual Approval · / commands · ? help · tab next tab        gpt-4.1')).toBe('ask')
    expect(copilotFooterMode(' ← open sidebar · Plan · Manual Approval · / commands · ? help · tab next tab')).toBe('plan')
    expect(copilotFooterMode(' ← open sidebar · Autopilot · Manual Approval · / commands · tab next tab')).toBe('autopilot')
    expect(copilotFooterMode(' ← open sidebar · Interactive · Allow All · / commands · ? help · tab next tab')).toBe('allow-all')
    // A pane too narrow for one line (seen in Combwork's agent terminal with two panes).
    expect(copilotFooterMode('← open ·Interactive · Manual · / commands · ? help · tab\nsidebar Approval next tab gpt-4.1')).toBe('ask')
    expect(copilotFooterMode('← open ·Plan · Manual · / commands\nsidebar Approval')).toBe('plan')
    // While typing, the footer lists other items; the last footer drawn wins.
    expect(copilotFooterMode('… Plan · Manual Approval · / commands\n Interactive · Manual Approval · @ files · # issues')).toBe('ask')
    expect(copilotFooterMode(' Interactive · Assisted Approval · / commands')).toBeNull()
    // Accept edits looks like Ask in the footer: the launch tells them apart.
    expect(copilotFooterMode(' ← open sidebar · Interactive · Manual Approval · / commands', 'accept-edits')).toBe('accept-edits')
    expect(copilotFooterMode(' ← open sidebar · Interactive · Manual Approval · / commands', 'plan')).toBe('ask')
    expect(copilotFooterMode(' ← open sidebar · Plan · Manual Approval · / commands', 'accept-edits')).toBe('plan')
    expect(copilotFooterMode(' ctrl+c again to exit')).toBeNull()
  })

  it('switches live within the approval it was launched with', () => {
    expect(copilotCanSwitchLive('plan', 'ask', 'ask')).toBe(true)
    expect(copilotCanSwitchLive('autopilot', 'ask', 'ask')).toBe(true)
    expect(copilotCanSwitchLive('ask', 'plan', 'ask')).toBe(true)
    expect(copilotCanSwitchLive('allow-all', 'ask', 'ask')).toBe(false)
    expect(copilotCanSwitchLive('allow-all', 'plan', 'allow-all')).toBe(true)
    expect(copilotCanSwitchLive('ask', 'allow-all', 'allow-all')).toBe(false)
    // Accept edits and Ask differ in what was approved at launch: each only in a session launched in it.
    expect(copilotCanSwitchLive('accept-edits', 'plan', 'accept-edits')).toBe(true)
    expect(copilotCanSwitchLive('accept-edits', 'ask', 'ask')).toBe(false)
    expect(copilotCanSwitchLive('ask', 'accept-edits', 'accept-edits')).toBe(false)
    expect(copilotCanSwitchLive('ask', 'plan', 'plan')).toBe(true)
    expect(copilotCanSwitchLive('accept-edits', 'plan', 'plan')).toBe(false)
    // The window doesn't know the launch: it asks the session, which says when a restart is needed.
    expect(copilotCanSwitchLive('accept-edits', 'ask', null)).toBe(true)
    expect(copilotCanSwitchLive('allow-all', 'ask', null)).toBe(false)
    expect(copilot.footerMode(' · Plan · Manual Approval · / commands')).toBe('plan')
    expect(copilot.footerMode(' · Interactive · Manual Approval · / commands', 'accept-edits')).toBe('accept-edits')
  })
})

describe('Copilot launch', () => {
  it('starts a new session under the id Combwork chose, with its hooks, MCP servers and modes', () => {
    const ctx = context({ model: 'claude-sonnet-5.5', effort: 'high', trustedCombworkTools: ['cw_list_tasks', 'cw_read_task'], initialPrompt: 'Fix the bug' })
    const { file, args, env } = copilot.buildCommand(ctx.executable, ctx)
    expect(file).toBe('C:\\bin\\copilot.exe')
    expect(args.slice(0, 4)).toEqual(['--session-id', ctx.sessionId, '--name', 'Agent 1'])
    expect(args).toContain('--no-auto-update')
    expect(args[args.indexOf('--plugin-dir') + 1]).toBe(join(ctx.privateDir, 'plugin'))
    expect(args[args.indexOf('--additional-mcp-config') + 1]).toBe(`@${join(ctx.privateDir, 'mcp.json')}`)
    expect(args).toContain('--allow-all-mcp-server-instructions')
    expect(args).toContain('--disable-builtin-mcps')
    expect(args.filter((a) => a.startsWith('--allow-tool='))).toEqual(['--allow-tool=combwork(cw_list_tasks)', '--allow-tool=combwork(cw_read_task)'])
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5.5')
    expect(args[args.indexOf('--reasoning-effort') + 1]).toBe('high')
    expect(args.slice(-2)).toEqual(['-i', 'Fix the bug'])
    // Ask: no mode flag.
    expect(args.some((a) => ['--plan', '--autopilot', '--allow-all', '--yolo'].includes(a))).toBe(false)
    // Other tools' tokens are left out of Copilot's environment alone; COPILOT_GITHUB_TOKEN, set for Copilot, stays (#450).
    for (const k of COPILOT_ENV_STRIP) expect(env?.[k]).toBeUndefined()
    expect(COPILOT_ENV_STRIP).toEqual(['GH_TOKEN', 'GITHUB_TOKEN'])
    expect(env?.COPILOT_GITHUB_TOKEN).toBe('github_pat_x')
    expect(env).toMatchObject({ PATH: 'C:\\Windows', CW_HOOK_TOKEN: 'tok123', COPILOT_HOOK_ALLOW_LOCALHOST: '1', COPILOT_AUTO_UPDATE: 'false' })
    // Its custom instructions: the hive tools' names (#1530).
    expect(env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBe(join(ctx.privateDir, 'instructions'))
    // The token never goes on the command line.
    expect(args.join(' ')).not.toContain('tok123')
  })

  it("pre-approves Combwork's tools: a project agent's all of them, the Assistant's only its trusted ones (#468)", () => {
    const allow = (over: Partial<LaunchContext>) => copilot.buildCommand('x.exe', context(over)).args.filter((a) => a.startsWith('--allow-tool='))
    expect(allow({})).toEqual(['--allow-tool=combwork'])
    expect(allow({ permissionMode: 'plan' })).toEqual(['--allow-tool=combwork'])
    expect(allow({ trustedCombworkTools: [] })).toEqual([])
    expect(allow({ trustedCombworkTools: ['cw_read_task'] })).toEqual(['--allow-tool=combwork(cw_read_task)'])
    // No hive server, nothing to approve.
    expect(allow({ mcpServers: {} })).toEqual([])
  })

  it("Accept edits approves writes under the agent's folder only, and is the default (#468)", () => {
    const ctx = context({ permissionMode: 'accept-edits', cwd: 'D:\\proj\\wt\\' })
    const { args } = copilot.buildCommand('x.exe', ctx)
    expect(args).toContain('--allow-tool=write(D:\\proj\\wt/**)')
    expect(args.some((a) => ['--plan', '--autopilot', '--allow-all', '--allow-all-tools', '--allow-all-paths', '--yolo'].includes(a))).toBe(false)
    expect(copilot.buildCommand('x.exe', context({ permissionMode: '' as never, cwd: 'D:\\proj' })).args).toContain('--allow-tool=write(D:\\proj/**)')
    expect(copilotModeFlags('ask', 'D:\\proj')).toEqual([])
    expect(copilotModeFlags('accept-edits', 'D:/proj/')).toEqual(['--allow-tool=write(D:/proj/**)'])
  })

  it("writes a folder with glob characters as a literal Copilot accepts (#468)", () => {
    // [ ] { } as one-character classes; the rest as it is.
    expect(copilotPathGlob('D:\\w\\demo[1]')).toBe('D:\\w\\demo[[]1[]]')
    expect(copilotPathGlob('D:\\w\\x{a,b}\\')).toBe('D:\\w\\x[{]a,b[}]')
    expect(copilotPathGlob("D:\\w\\a!b+c@d,e#f$g^h~i'j;k=l&m%n")).toBe("D:\\w\\a!b+c@d,e#f$g^h~i'j;k=l&m%n")
    expect(copilotModeFlags('accept-edits', 'D:\\w\\v1.2 [x] {y}')).toEqual(['--allow-tool=write(D:\\w\\v1.2 [[]x[]] [{]y[}]/**)'])
  })

  it('approves no edits where the path has parentheses, and says so (#468)', () => {
    // Copilot refuses a rule with ( or ) (and doesn't start), and any stand-in also matches a look-alike folder.
    for (const folder of ['D:\\w\\New folder (2)', 'C:\\Program Files (x86)\\proj', 'D:\\a)b']) {
      expect(copilotCanApproveEdits(folder)).toBe(false)
      expect(copilotModeFlags('accept-edits', folder)).toEqual([])
      const { args } = copilot.buildCommand('x.exe', context({ permissionMode: 'accept-edits', cwd: folder }))
      expect(args.filter((a) => a.startsWith('--allow-tool=write'))).toEqual([])
      expect(args.some((a) => /^--allow-tool=(?!combwork)/.test(a))).toBe(false)
    }
    expect(copilotCanApproveEdits('D:\\w\\demo[1]{x}')).toBe(true)
    // The notice: only for Accept edits (or the default) in such a folder.
    expect(copilot.launchNotice(context({ permissionMode: 'accept-edits', cwd: 'D:\\w\\New folder (2)' }))?.title).toBe('Copilot will ask before each edit')
    expect(copilot.launchNotice(context({ permissionMode: '' as never, cwd: 'D:\\w\\New folder (2)' }))).not.toBeNull()
    expect(copilot.launchNotice(context({ permissionMode: 'ask', cwd: 'D:\\w\\New folder (2)' }))).toBeNull()
    expect(copilot.launchNotice(context({ permissionMode: 'accept-edits', cwd: 'D:\\w\\demo[1]' }))).toBeNull()
  })

  it('resumes by id, passes each mode, and adds its instructions folder to the user’s', () => {
    const r = copilot.buildCommand('C:\\bin\\copilot.exe', context({ resume: true, permissionMode: 'plan' }))
    expect(r.args.slice(0, 2)).toEqual(['--resume', '0cb916db-26aa-40f2-86b5-1ba81b225fd2'])
    expect(r.args).not.toContain('--session-id')
    expect(r.args).not.toContain('--name')
    expect(r.args).toContain('--plan')
    expect(copilot.buildCommand('x.exe', context({ permissionMode: 'allow-all' })).args).toContain('--allow-all')
    expect(copilot.buildCommand('x.exe', context({ permissionMode: 'autopilot' })).args).toContain('--autopilot')
    const ctx = context({ instructions: 'You are the Combwork Assistant.', env: { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: 'D:\\mine' } })
    expect(copilot.buildCommand('x.exe', ctx).env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBe(`D:\\mine,${join(ctx.privateDir, 'instructions')}`)
  })

  it("turns off the user's and the project's own MCP servers, never the workspace's", () => {
    const ctx = context()
    mkdirSync(join(ctx.cwd, '.github'), { recursive: true })
    writeFileSync(join(ctx.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { theirs: { command: 'x' }, hive: { command: 'y' } } }))
    writeFileSync(join(ctx.cwd, '.github', 'mcp.json'), '// VS Code format, with a comment\n{ "servers": { "gh-only": { "url": "https://x" } } }')
    const { args } = copilot.buildCommand('x.exe', ctx)
    const off = args.flatMap((a, i) => (a === '--disable-mcp-server' ? [args[i + 1]] : []))
    // The project's own hive (Combwork's server's name before HI-2463) is theirs now, off with the others.
    expect(off.sort()).toEqual(['gh-only', 'hive', 'theirs'])
  })

  it('writes the plugin (hooks with the token), the MCP config and the instructions in the launch’s private folder', async () => {
    const ctx = context({ instructions: 'Role: assistant.', privateDir: join(base, 'private-2') })
    await copilot.prepareLaunch(ctx)
    const hooks = JSON.parse(readFileSync(join(ctx.privateDir, 'plugin', 'hooks.json'), 'utf8'))
    expect(hooks).toEqual(copilotHooks(ctx.hookUrl, 'tok123'))
    expect(JSON.parse(readFileSync(join(ctx.privateDir, 'plugin', 'plugin.json'), 'utf8')).name).toBe('combwork-launch')
    expect(JSON.parse(readFileSync(join(ctx.privateDir, 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { combwork: { type: 'local', command: 'node', args: ['cw-mcp.js'], env: { CW_PROJECT: 'proj' }, tools: ['*'] } } })
    expect(readFileSync(join(ctx.privateDir, 'instructions', '.github', 'instructions', 'combwork.instructions.md'), 'utf8')).toBe(`---\napplyTo: '**'\n---\n${toolNamesLine()}\n\nRole: assistant.\n`)
  })

  it('is ended with Ctrl+C before it is killed, so it writes its token totals (#465)', async () => {
    const exit = copilot.exitKeys
    expect(exit.keys.length).toBeGreaterThanOrEqual(2)
    expect(exit.keys.every((k) => k === '\x03')).toBe(true)
    expect((exit.keys.length - 1) * exit.gapMs).toBeLessThan(exit.graceMs)
    // Killed only if it hangs: it took up to 2.4 s to exit by itself under load, and 2.5 s killed it (#716).
    expect(exit.graceMs).toBeGreaterThanOrEqual(10_000)
    // Stop types them on conditions (HI-2272): the key that exits once its screen shows the exit armed.
    expect(exit.armed.test(readFileSync(join(__dirname, 'fixtures', 'advanced', 'exit-armed-copilot-1.0.105.txt'), 'utf8'))).toBe(true)
    expect(exit.armed.test(readFileSync(join(__dirname, 'fixtures', 'advanced', 'ready-copilot-1.0.95.txt'), 'utf8'))).toBe(false)
    // Quitting Combwork or closing a workspace (stopWhereAndWait, 3 s) waits past the grace, for the kill and its exit.
    const { stopWaitMs } = await import('../src/main/sessions')
    expect(stopWaitMs(3000, [exit.graceMs])).toBeGreaterThan(exit.graceMs)
    expect(stopWaitMs(3000, [undefined, undefined])).toBe(3000)
    expect(stopWaitMs(15_000, [exit.graceMs])).toBe(15_000)
  })

  it('never passes --mouse or --no-mouse, which Copilot saves into the user\'s own settings (#737)', () => {
    for (const resume of [false, true]) {
      const ctx = context({ resume })
      expect(copilot.buildCommand(ctx.executable, ctx).args.filter((a) => /^--(no-)?mouse\b/.test(a))).toEqual([])
    }
  })

  it('takes its exit grace from Settings → Advanced (copilot.exit.graceSeconds), at each stop (#727)', async () => {
    const { stopWaitMs } = await import('../src/main/sessions')
    advanced.load(tempDir('hive-copilot-advanced-'))
    try {
      expect(copilot.exitKeys.graceMs).toBe(10_000)
      await advanced.set('copilot.exit.graceSeconds', 25)
      expect(copilot.exitKeys.graceMs).toBe(25_000)
      // Quitting waits past the longer grace too.
      expect(stopWaitMs(3000, [copilot.exitKeys.graceMs])).toBeGreaterThan(25_000)
      // A grace shorter than the keys take, or one that would hold quitting for minutes, is refused.
      await expect(advanced.set('copilot.exit.graceSeconds', 2)).rejects.toThrow(/whole number from 3 to 60/)
      await expect(advanced.set('copilot.exit.graceSeconds', 61)).rejects.toThrow(/whole number from 3 to 60/)
      expect(copilot.exitKeys.graceMs).toBe(25_000)
      await advanced.set('copilot.exit.graceSeconds', null)
      expect(copilot.exitKeys.graceMs).toBe(10_000)
    } finally {
      await advanced.resetAll()
      advanced.stop()
    }
  })

  it('gives every event to Combwork’s hook server over HTTP, by the PascalCase names', () => {
    const h = copilotHooks('http://127.0.0.1:5000/hook?run=r1', 'tok') as { version: number; hooks: Record<string, { type: string; url: string; headers: Record<string, string>; timeoutSec: number }[]> }
    expect(h.version).toBe(1)
    expect(Object.keys(h.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'ErrorOccurred', 'PreCompact', 'SessionEnd'])
    expect(h.hooks.PreToolUse).toEqual([{ type: 'http', url: 'http://127.0.0.1:5000/hook?run=r1', headers: { Authorization: 'Bearer tok' }, timeoutSec: 10 }])
    expect(h.hooks.Stop[0].timeoutSec).toBe(5)
  })

  it('converts workspace MCP servers to Copilot’s format', () => {
    expect(copilotMcpServer({ url: 'https://x/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } })).toEqual({ type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${TOKEN}' }, tools: ['*'] })
    expect(copilotMcpServer({ type: 'sse', url: 'https://x/sse' })).toMatchObject({ type: 'sse' })
    expect(copilotMcpServer({ command: 'npx', args: ['-y', 'srv'] })).toEqual({ type: 'local', command: 'npx', args: ['-y', 'srv'], tools: ['*'] })
    expect(copilotMcpServer({ description: 'nothing to run' })).toBeNull()
  })

  it("takes other tools' tokens out of its environment, whatever their case, and keeps Copilot's own", () => {
    expect(copilotEnv({ Gh_Token: 'a', github_token: 'b', COPILOT_GITHUB_TOKEN: 'c', KEEP: 'd' })).toEqual({ COPILOT_GITHUB_TOKEN: 'c', KEEP: 'd', COPILOT_AUTO_UPDATE: 'false' })
  })
})

describe('Copilot hooks', () => {
  const h = (body: Record<string, unknown>) => copilot.normalizeHook(body)

  it('turns its hook calls into Combwork events', () => {
    expect(h({ hook_event_name: 'SessionStart', session_id: 's1', source: 'new', initial_prompt: 'do it' })).toMatchObject({ event: { kind: 'start', source: 'new' }, sessionId: 's1', mode: null })
    expect(h({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hello there' }).event).toEqual({ kind: 'prompt', text: 'hello there' })
    expect(h({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { path: 'C:\\w\\a.ts', old_str: 'x', new_str: 'y' } })).toMatchObject({ event: { kind: 'toolStart' }, editedPaths: ['C:\\w\\a.ts'] })
    expect(h({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { path: 'C:\\w\\hello.txt', file_text: 'hi' } }).editedPaths).toEqual(['C:\\w\\hello.txt'])
    expect(h({ hook_event_name: 'PreToolUse', tool_name: 'combwork-cw_ping', tool_input: {} })).toMatchObject({ event: { kind: 'toolStart' }, editedPaths: [] })
    expect(h({ hook_event_name: 'PreToolUse', tool_name: 'powershell', tool_input: { command: 'New-Item x', path: 'C:\\w' } }).editedPaths).toEqual([])
    expect(h({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: {}, tool_result: { result_type: 'success' } }).event).toEqual({ kind: 'toolEnd' })
    expect(h({ hook_event_name: 'PostToolUseFailure', tool_name: 'Edit' }).event).toEqual({ kind: 'toolEnd' })
    expect(h({ hook_event_name: 'Stop', session_id: 's1', transcript_path: 'C:\\h\\session-state\\s1\\events.jsonl', stop_reason: 'end_turn', stop_hook_active: false })).toMatchObject({ event: { kind: 'stop', lastMessage: null }, transcriptPath: 'C:\\h\\session-state\\s1\\events.jsonl' })
    expect(h({ hook_event_name: 'PreCompact', trigger: 'manual' }).event).toEqual({ kind: 'compactStart', trigger: 'manual' })
    expect(h({ hook_event_name: 'SessionEnd', reason: 'user_exit' }).event).toEqual({ kind: 'end' })
  })

  it('asks when Copilot shows a person a dialog, and only then', () => {
    expect(h({ hook_event_name: 'Notification', notification_type: 'permission_prompt', title: 'Permission needed', message: 'Run command: New-Item x' }).event).toEqual({ kind: 'ask', ask: { kind: 'permission', blocking: true, message: 'Run command: New-Item x' } })
    expect(h({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog', title: 'Information requested', message: 'Stub asks: pick one' }).event).toEqual({ kind: 'ask', ask: { kind: 'question', blocking: true, message: 'Stub asks: pick one' } })
    expect(h({ hook_event_name: 'Notification', notification_type: 'agent_idle', message: 'Done' }).event).toEqual({ kind: 'ignore' })
    // Sent also when Allow all approves the call itself: not a person being asked.
    expect(h({ hookName: 'permissionRequest', toolName: 'powershell' }).event).toEqual({ kind: 'ignore' })
  })

  describe("a question's text (HI-1945)", () => {
    // Copilot 1.0.105's hooks for ask_user, as recorded: PreToolUse (AskUserQuestion), the Notification saying only
    // "Information requested", PostToolUse. The question is the PreToolUse's, until the call ends.
    const [pre, notification, post] = readFileSync(join(__dirname, 'fixtures', 'advanced', 'question-copilot-1.0.105.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l) as Record<string, unknown>)
    const asked = (message: string) => ({ kind: 'ask', ask: { kind: 'question', blocking: true, message } })
    // Overridden in a profile of its own, never the user's.
    beforeAll(() => advanced.load(tempDir('hive-copilot-question-')))
    afterAll(async () => {
      await advanced.set('copilot.question.tool', null)
      await advanced.set('copilot.question.field', null)
    })

    it("shows the asking tool's question, not Copilot's notice, until the call ends", () => {
      expect(notification.message).toBe('Information requested')
      h(pre)
      expect(h(notification).event).toEqual(asked('Which one should I use?'))
      // Another session's question isn't this one's.
      expect(h({ ...notification, sessionId: 'other' }).event).toEqual(asked('Information requested'))
      h(post)
      expect(h(notification).event).toEqual(asked('Information requested'))
      // Stop ends it too, as an unanswered question's turn ends.
      h(pre)
      h({ hook_event_name: 'Stop', session_id: pre.session_id })
      expect(h(notification).event).toEqual(asked('Information requested'))
    })

    it('follows the advanced settings: the tool name and the question field', async () => {
      const renamed = { ...pre, tool_name: 'AskHuman', tool_input: { prompt: 'Which file?', message: 'old field' } }
      h(renamed)
      expect(h(notification).event).toEqual(asked('Information requested'))
      await advanced.set('copilot.question.tool', '^AskHuman$')
      h(renamed)
      expect(h(notification).event).toEqual(asked('old field'))
      h({ ...post, tool_name: 'AskHuman' })
      await advanced.set('copilot.question.field', 'prompt')
      h(renamed)
      expect(h(notification).event).toEqual(asked('Which file?'))
      // The renamed tool's end clears it; the default's name no longer counts.
      h(post)
      expect(h(notification).event).toEqual(asked('Which file?'))
      h({ ...post, tool_name: 'AskHuman' })
      expect(h(notification).event).toEqual(asked('Information requested'))
    })
  })

  it('tells a refused sign-in from another error that ends the turn', () => {
    expect(h({ hook_event_name: 'ErrorOccurred', error: { message: 'Request failed (401): Bad credentials', name: 'AuthError' }, error_context: 'model_call', recoverable: false }).event).toEqual({ kind: 'signIn', message: 'Request failed (401): Bad credentials' })
    expect(h({ hook_event_name: 'ErrorOccurred', error: { message: 'rate limited' }, recoverable: false }).event).toEqual({ kind: 'stop', lastMessage: 'rate limited', failed: true })
    expect(h({ hook_event_name: 'ErrorOccurred', error: { message: 'retrying' }, recoverable: true }).event).toEqual({ kind: 'ignore' })
  })

  it('answers a file lock in the format Copilot honours (deny, ask: its own dialog)', () => {
    expect(copilot.lockReply({ kind: 'deny', reason: 'Agent 2 is editing a.ts' })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Agent 2 is editing a.ts' } })
    expect(copilot.lockReply({ kind: 'ask', reason: 'held' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } })
    expect(copilot.lockReply({ kind: 'warn', context: 'careful' })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'careful' } })
  })

  it('recognises its start errors', () => {
    expect(copilot.startHint('Failed to read MCP config file "C:\\x\\mcp.json": The system cannot find the path specified.')?.fix).toBe('terminal')
    expect(copilot.startHint("error: unexpected argument '--frobnicate' found")?.fix).toBe('agent-settings')
    expect(copilot.startHint('Please use /login to sign in to use Copilot')?.fix).toBe('agent-setup')
    expect(copilot.startHint('Model "gpt-9" is not available')?.fix).toBe('agent-settings')
    expect(copilot.startHint('all good')).toBeNull()
  })
})

describe('Copilot models', () => {
  it("reads the account's models from an ACP session/new reply (Copilot Free: Auto only)", () => {
    const reply = { sessionId: 'x', models: { availableModels: [{ modelId: 'auto', name: 'Auto', description: 'Let Copilot pick the best model' }, { modelId: 'auto', name: 'Auto', description: 'Auto', _meta: { copilotUsage: '1x', copilotEnablement: 'enabled' } }], currentModelId: 'auto' } }
    expect(parseCopilotModels(reply)).toEqual({ models: [{ value: 'auto', label: 'Auto', description: 'Let Copilot pick the best model' }], defaultModel: 'auto' })
    const paid = { models: { availableModels: [{ modelId: 'claude-opus-5.5', _meta: { copilotUsage: '3x', copilotEnablement: 'disabled' } }] } }
    expect(parseCopilotModels(paid)).toEqual({ models: [{ value: 'claude-opus-5.5', label: 'Claude Opus 5.5', description: 'uses 3x', unavailable: true }] })
    expect(parseCopilotModels({ models: { availableModels: [] } })).toBeNull()
    expect(parseCopilotModels({})).toBeNull()
    expect(parseCopilotModels(null)).toBeNull()
  })
})

describe('Copilot files', () => {
  it('reads skills from its own folders and three project folders, sharing Combwork’s copies with Codex', () => {
    const roots = copilot.skillRoots()
    expect(roots.local).toEqual([join('.github', 'skills'), join('.agents', 'skills'), join('.claude', 'skills')])
    expect(copilot.skillCopyPath(context(), 'deploy')).toBe(join(context().cwd, '.agents', 'skills', 'cw-deploy'))
    expect(COPILOT_DESCRIPTOR.instructionsFile).toBe('AGENTS.md')
  })

  it("only shows its user instructions and skills from Copilot's folder, never its config or sign-in", () => {
    const home = copilot.configHome()
    expect(copilot.fileAllowed(join(home, 'copilot-instructions.md'), true)).toBe(true)
    expect(copilot.fileAllowed(join(home, 'skills', 'x', 'SKILL.md'), false)).toBe(true)
    expect(copilot.fileAllowed(join(home, 'skills', 'x', 'SKILL.md'), true)).toBe(false)
    expect(copilot.fileAllowed(join(home, 'config.json'), false)).toBe(false)
    expect(copilot.fileAllowed(join(home, 'session-state', 'x', 'events.jsonl'), false)).toBe(false)
  })
})
