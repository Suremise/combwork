import { readFileSync as readText } from 'fs'
import { join as joinPath } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { codexMcpServer, hookHash, toToml } from '../src/main/providers/codex/adapter'
import { CodexConversationParser, parseRollout, patchPaths, presetFromSettings, rolloutDetails, rolloutPlanUsage } from '../src/main/providers/codex/rollout'
import { codexModelLabel } from '../src/shared/codex'
import { tempDir } from './tempDir'

const line = (o: unknown): string => JSON.stringify(o)

describe('Codex hook trust', () => {
  it("hashes hooks the way Codex does (values from Codex 0.159's hooks/list)", () => {
    expect(hookHash('session_start', undefined, 'echo hive-test', 5)).toBe('sha256:9304855a6bdb130c5107b4f69e530cbf6f7cb00c82e7bcd218d8bb4f071a8c7a')
    expect(hookHash('pre_tool_use', '*', 'echo hive-test', 10)).toBe('sha256:fc3016d3b175c2e0d43538eff55ae4adb352fc1d3bb47acc3ac9d651e7b68024')
    expect(hookHash('session_end', undefined, 'echo hive-test', 3)).toBe('sha256:22b9953958a5515d3eda16a1a8ce24cd1a55b3685b278840eed401bf0d7e1573')
  })
})

describe('Codex hooks', () => {
  it('turns hook calls into Hive events', async () => {
    const { codex } = await import('../src/main/providers/codex/adapter')
    const h = (body: Record<string, unknown>) => codex.normalizeHook(body)
    expect(h({ hook_event_name: 'SessionStart', session_id: 's1', transcript_path: 'C:\\x\\r.jsonl', source: 'startup', permission_mode: 'default' })).toMatchObject({ event: { kind: 'start', source: 'startup' }, sessionId: 's1', transcriptPath: 'C:\\x\\r.jsonl', mode: null })
    const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** Add File: notes.txt\n+hi\n*** Delete File: gone.txt\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch'
    expect(h({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch } })).toMatchObject({ event: { kind: 'toolStart' }, editedPaths: ['a.ts', 'notes.txt', 'gone.txt', 'old.txt', 'new.txt'] })
    expect(h({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } })).toMatchObject({ event: { kind: 'toolStart' }, editedPaths: [] })
    // The async question doesn't stop Codex; the other one does, as a permission request does until answered.
    expect(h({ hook_event_name: 'PreToolUse', tool_name: 'request_user_input_async', tool_input: { questions: [{ title: 'Which language?' }] } }).event).toMatchObject({ kind: 'ask', ask: { kind: 'question', blocking: false, message: 'Which language?' } })
    expect(h({ hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions: [{ question: 'Which language?' }] } }).event).toMatchObject({ kind: 'ask', ask: { kind: 'question', blocking: true, message: 'Which language?' } })
    expect(h({ hook_event_name: 'PreToolUse', tool_name: 'request_user_input_later', tool_input: {} }).event).toEqual({ kind: 'toolStart' })
    expect(h({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git status --short' } }).event).toMatchObject({ kind: 'ask', ask: { kind: 'permission', blocking: true, message: 'Codex asks to run git status --short' } })
    // A request and its own call's end name the same call (Codex adds a description to the request's input);
    // another command's end doesn't.
    const call = (body: Record<string, unknown>): string | undefined => {
      const e = h(body).event
      return e.kind === 'ask' ? e.ask.call : e.kind === 'toolEnd' ? e.call : undefined
    }
    const asked = call({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'curl.exe https://example.com', description: 'Check the network' } })
    expect(asked).toBeTruthy()
    expect(call({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'curl.exe https://example.com' } })).toBe(asked)
    expect(call({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })).not.toBe(asked)
    const questions = [{ question: 'Which language?' }]
    expect(call({ hook_event_name: 'PostToolUse', tool_name: 'request_user_input', tool_input: { questions } })).toBe(call({ hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions } }))
    expect(h({ hook_event_name: 'Interrupt' }).event).toEqual({ kind: 'interrupt' })
    expect(h({ hook_event_name: 'Stop', last_assistant_message: 'ok' }).event).toEqual({ kind: 'stop', lastMessage: 'ok' })
    expect(h({ hook_event_name: 'PreCompact', trigger: 'manual' }).event).toEqual({ kind: 'compactStart', trigger: 'manual' })
  })
  it('reads the patch in a code-mode script', async () => {
    const { scriptPatch } = await import('../src/main/providers/codex/rollout')
    expect(scriptPatch('const p = await tools.apply_patch("*** Begin Patch\\n*** Add File: notes.txt\\n+hi\\n*** End Patch");\ntext(p);')).toBe('*** Begin Patch\n*** Add File: notes.txt\n+hi\n*** End Patch')
    expect(scriptPatch('text(await tools.exec_command({cmd: "ls"}))')).toBeNull()
    // The patch kept in a variable first (seen with Codex 0.159).
    expect(scriptPatch('const p = "*** Begin Patch\\n*** Add File: notes.txt\\n+hi\\n*** End Patch"; text(await tools.apply_patch(p));')).toBe('*** Begin Patch\n*** Add File: notes.txt\n+hi\n*** End Patch')
  })
  it('reads the files of a patch', () => {
    expect(patchPaths('*** Begin Patch\n*** Add File: a b/c.ts\n+x\n*** End Patch')).toEqual(['a b/c.ts'])
    expect(patchPaths('no patch')).toEqual([])
  })
})

describe('Codex: when a person must act', () => {
  it('its title says so from 0.160.0 ("Action Required", blinking); older versions go by the hooks', async () => {
    const { codex } = await import('../src/main/providers/codex/adapter')
    expect(codex.titleAttention('0.159.9')).toBeNull()
    expect(codex.titleAttention(null)).toBeNull()
    for (const version of ['0.160.0', '0.161.2', '1.0.0']) {
      const asks = codex.titleAttention(version)!
      expect(asks('[ ! ] Action Required | demo'), version).toBe(true)
      expect(asks('[ . ] Action Required | demo'), version).toBe(true)
      expect(asks('demo'), version).toBe(false)
      expect(asks('⠼ demo'), version).toBe(false)
      // A project that happens to be called that isn't the prompt.
      expect(asks('⠼ Action Required'), version).toBe(false)
    }
  })

  it("pins the title's items for Hive's sessions, so a user's [tui].terminal_title can't hide it", async () => {
    const { rmSync } = await import('fs')
    const home = tempDir('hive-codex-home-')
    const before = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    try {
      const { codex } = await import('../src/main/providers/codex/adapter')
      const ctx = {
        projectPath: home, agentId: 'a-1', executable: 'C:\\bin\\codex.exe', cwd: home, workspacePath: home, runId: 'r', sessionId: '',
        resume: false, name: '', skills: [], mcpServers: {}, model: null, effort: null, permissionMode: null, extraArgs: [], hookUrl: 'http://127.0.0.1:1/hook?run=r', hookAuthFile: 'C:/hive/hook-auth/r.txt', privateDir: 'C:/hive/launches/r', guidance: '', env: {}, allowBackgroundSessions: false, use200kContext: false
      }
      const { args } = codex.buildCommand(ctx.executable, ctx)
      expect(args.join(' ')).toContain('tui.terminal_title=')
      expect(args.find((a) => a.includes('tui.terminal_title='))).toMatch(/"activity".*"project-name"/)
      // The sandbox setup task too: its busy wait reads the spinner the "activity" item puts in the title.
      const setup = codex.setupCommand('C:\\bin\\codex.exe')
      expect(setup.busyTitle).toBeTruthy()
      const title = setup.args.findIndex((a) => a.startsWith('tui.terminal_title='))
      expect(setup.args[title]).toMatch(/"activity".*"project-name"/)
      expect(setup.args[title - 1]).toBe('-c')
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = before
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("says a connection's folder is set up (HI-1870) when its launches run in a Windows sandbox: its own, or this PC's passed on", async () => {
    const { mkdirSync, rmSync, writeFileSync } = await import('fs')
    const pc = tempDir('hive-codex-pc-')
    const conn = tempDir('hive-codex-conn-')
    const before = process.env.CODEX_HOME
    process.env.CODEX_HOME = pc
    try {
      const { codex, launchConnectionArgs } = await import('../src/main/providers/codex/adapter')
      const sandboxed = (): boolean => launchConnectionArgs({ connectionHome: conn }).some((a) => a.startsWith('windows.sandbox='))
      if (process.platform !== 'win32') return void expect(await codex.connectionSetUp(conn)).toBe(true)
      // Neither: Codex asks for its sandbox setup there.
      expect(await codex.connectionSetUp(conn)).toBe(false)
      // This PC's, which its launches are given.
      writeFileSync(joinPath(pc, 'config.toml'), '[windows]\nsandbox = "elevated"\n')
      expect(sandboxed()).toBe(true)
      expect(await codex.connectionSetUp(conn)).toBe(true)
      // One the launches wouldn't pass on isn't counted.
      writeFileSync(joinPath(pc, 'config.toml'), '[windows]\nsandbox = "not a kind"\n')
      expect(sandboxed()).toBe(false)
      expect(await codex.connectionSetUp(conn)).toBe(false)
      // Its own, as its Set Up writes it.
      mkdirSync(conn, { recursive: true })
      writeFileSync(joinPath(conn, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
      expect(await codex.connectionSetUp(conn)).toBe(true)
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = before
      rmSync(pc, { recursive: true, force: true })
      rmSync(conn, { recursive: true, force: true })
    }
  })

  it("reads a connection's trust of a workspace's folders as Codex 0.164.0 looked it up (HI-1870), with Hive's per-launch trust off", async () => {
    const { mkdirSync, rmSync, writeFileSync } = await import('fs')
    const { codex } = await import('../src/main/providers/codex/adapter')
    const { advanced } = await import('../src/main/advanced')
    const real = advanced.get.bind(advanced)
    const off = vi.spyOn(advanced, 'get').mockImplementation(((id: string) => (id === 'codex.trust.perLaunch' ? false : real(id))) as typeof advanced.get)
    const home = tempDir('hive-codex-trust-')
    try {
      const t = (root: string | null, git = true) => ({ root, git, short: false })
      const targets = [t('C:\\work\\alpha'), t('c:\\WORK\\Alpha'), t('C:\\work\\beta'), t('C:\\work\\notes', false), t(null)]
      // No config.toml yet: nothing trusted (a folder without Git needs none: Codex asks only in a repository).
      expect(await codex.connectionTrusts(home, targets)).toEqual([false, false, false, true, null])
      mkdirSync(home, { recursive: true })
      writeFileSync(joinPath(home, 'config.toml'), "[projects.'C:\\work\\alpha']\ntrust_level = \"trusted\"\n\n[projects.'C:\\work\\beta']\ntrust_level = \"untrusted\"\n")
      expect(await codex.connectionTrusts(home, targets)).toEqual([true, true, false, true, null])
      // One it can't read: unknown, never untrusted.
      writeFileSync(joinPath(home, 'config.toml'), "[projects.'C:\\work\\alpha'\ntrust_level = \n")
      expect(await codex.connectionTrusts(home, targets)).toEqual([null, null, null, null, null])
    } finally {
      off.mockRestore()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("trusts each launch's own folder when Hive's per-launch trust is on (HI-1871, Darren: on by default): its -c, and nothing pending", async () => {
    const { rmSync } = await import('fs')
    const { codex } = await import('../src/main/providers/codex/adapter')
    const { advanced } = await import('../src/main/advanced')
    const home = tempDir('hive-codex-perlaunch-')
    const before = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    try {
      const ctx = {
        projectPath: home, agentId: 'a-1', executable: 'C:\\bin\\codex.exe', cwd: 'C:\\work\\HIVE.worktrees\\alpha\\slot-a', workspacePath: home, runId: 'r', sessionId: '',
        resume: false, name: '', skills: [], mcpServers: {}, model: null, effort: null, permissionMode: null, extraArgs: [], hookUrl: 'http://127.0.0.1:1/hook?run=r', hookAuthFile: 'C:/hive/hook-auth/r.txt', privateDir: 'C:/hive/launches/r', guidance: '', env: {}, allowBackgroundSessions: false, use200kContext: false
      }
      expect(advanced.get<boolean>('codex.trust.perLaunch')).toBe(true)
      const { args } = codex.buildCommand(ctx.executable, ctx)
      const i = args.findIndex((a) => a.startsWith('projects='))
      // The inline table (a dotted -c key would split the path at "HIVE.worktrees"), its folder alone.
      expect(args[i - 1]).toBe('-c')
      expect(args[i]).toBe('projects={"C:\\\\work\\\\HIVE.worktrees\\\\alpha\\\\slot-a"={trust_level="trusted"}}')
      expect(await codex.connectionTrusts(home, [{ root: 'C:\\work\\alpha', git: true, short: false }, { root: null, git: true, short: false }])).toEqual([true, true])
      // Off: no -c of it, and trust read from the connection's own file.
      const real = advanced.get.bind(advanced)
      const off = vi.spyOn(advanced, 'get').mockImplementation(((id: string) => (id === 'codex.trust.perLaunch' ? false : real(id))) as typeof advanced.get)
      try {
        expect(codex.buildCommand(ctx.executable, ctx).args.some((a) => a.startsWith('projects='))).toBe(false)
        expect(await codex.connectionTrusts(home, [{ root: 'C:\\work\\alpha', git: true, short: false }])).toEqual([false])
      } finally {
        off.mockRestore()
      }
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = before
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('passes the first task after "--", so extra arguments ending in --image keep it (#523)', async () => {
    const { rmSync } = await import('fs')
    const home = tempDir('hive-codex-home-')
    const before = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    try {
      const { codex } = await import('../src/main/providers/codex/adapter')
      const ctx = {
        projectPath: home, agentId: 'a-1', executable: 'C:\\bin\\codex.exe', cwd: home, workspacePath: home, runId: 'r', sessionId: '00000000-0000-4000-8000-000000000000',
        resume: false, name: '', skills: [], mcpServers: {}, model: null, effort: null, permissionMode: null, extraArgs: ['--image', 'a.png', 'b.png'], hookUrl: 'http://127.0.0.1:1/hook?run=r', hookAuthFile: 'C:/hive/hook-auth/r.txt', privateDir: 'C:/hive/launches/r', guidance: '', env: {}, allowBackgroundSessions: false, use200kContext: false,
        initialPrompt: 'Work on card #12'
      }
      // Codex 0.162 reads a plain argument after "--image a.png" as another image; after "--" it is the prompt.
      expect(codex.buildCommand(ctx.executable, ctx).args.slice(-5)).toEqual(['--image', 'a.png', 'b.png', '--', 'Work on card #12'])
      const resumed = codex.buildCommand(ctx.executable, { ...ctx, resume: true }).args
      expect(resumed.slice(0, 2)).toEqual(['resume', ctx.sessionId])
      expect(resumed.slice(-2)).toEqual(['--', 'Work on card #12'])
      expect(codex.buildCommand(ctx.executable, { ...ctx, initialPrompt: undefined }).args).not.toContain('--')
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = before
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("pre-approves only Hive's own server's tools: a third-party one follows Codex's approval policy (#1166)", async () => {
    const { rmSync } = await import('fs')
    const home = tempDir('hive-codex-home-')
    const before = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    try {
      const { codex } = await import('../src/main/providers/codex/adapter')
      const mcpServers = { hive: { command: 'node', args: ['hive-mcp.js'] }, gh: { command: 'npx', args: ['-y', 'gh-mcp'] }, api: { url: 'https://mcp.example.com' } }
      const ctx = {
        projectPath: home, agentId: 'a-1', executable: 'C:\\bin\\codex.exe', cwd: home, workspacePath: home, runId: 'r', sessionId: '',
        resume: false, name: '', skills: [], mcpServers, model: null, effort: null, permissionMode: null, extraArgs: [], hookUrl: 'http://127.0.0.1:1/hook?run=r', hookAuthFile: 'C:/hive/hook-auth/r.txt', privateDir: 'C:/hive/launches/r', guidance: '', env: {}, allowBackgroundSessions: false, use200kContext: false
      }
      const server = (args: string[], name: string) => args.find((a) => a.startsWith(`mcp_servers.${name}=`))
      for (const permissionMode of [null, 'read-only', 'ask', 'approve-for-me', 'full-access']) {
        const { args } = codex.buildCommand(ctx.executable, { ...ctx, permissionMode })
        expect(server(args, 'hive'), String(permissionMode)).toContain('default_tools_approval_mode="approve"')
        expect(server(args, 'gh'), String(permissionMode)).toMatch(/^mcp_servers\.gh=\{command="npx"/)
        expect(server(args, 'gh'), String(permissionMode)).not.toContain('default_tools_approval_mode')
        expect(server(args, 'api'), String(permissionMode)).toMatch(/^mcp_servers\.api=\{url="https:\/\/mcp\.example\.com"/)
        expect(server(args, 'api'), String(permissionMode)).not.toContain('default_tools_approval_mode')
        expect(args.filter((a) => a.includes('default_tools_approval_mode'))).toHaveLength(1)
      }
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = before
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('Codex settings as TOML', () => {
  it('writes inline tables for -c overrides', () => {
    expect(toToml({ a: 'x"y', 'C:\\p q': { trust_level: 'trusted' }, n: [1, true] })).toBe('{a="x\\"y","C:\\\\p q"={trust_level="trusted"},n=[1,true]}')
  })
  it('passes MCP servers with secrets as environment names only', () => {
    expect(codexMcpServer('gh', { command: 'npx', args: ['-y', 'x'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', MODE: 'fast' } }).table).toEqual({
      command: 'npx',
      args: ['-y', 'x'],
      env: { MODE: 'fast' },
      env_vars: ['GITHUB_TOKEN']
    })
    expect(codexMcpServer('api', { url: 'https://x', headers: { Authorization: 'Bearer ${API_KEY}', 'X-Team': '${TEAM}', Accept: 'json' } }).table).toEqual({
      url: 'https://x',
      bearer_token_env_var: 'API_KEY',
      env_http_headers: { 'X-Team': 'TEAM' },
      http_headers: { Accept: 'json' }
    })
    const literal = codexMcpServer('bad', { command: 'x', env: { API_TOKEN: 'ghp_abcdefghijklmnop' } })
    expect(literal.table).toBeNull()
    expect(literal.warning).toMatch(/literal secret/)
    expect(codexMcpServer('renamed', { command: 'x', env: { TOKEN: '${OTHER}' } }).table).toBeNull()
  })
})

describe('Codex rollouts', () => {
  const rollout = [
    line({ timestamp: '2026-09-29T21:00:00.000Z', type: 'session_meta', payload: { id: 'abc', cwd: 'C:\\p', cli_version: '0.159.0' } }),
    line({ timestamp: '2026-09-29T21:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] } }),
    line({ timestamp: '2026-09-29T21:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } }),
    line({ timestamp: '2026-09-29T21:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add notes' }] } }),
    line({ timestamp: '2026-09-29T21:00:02.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Add notes' }] } } }),
    line({ timestamp: '2026-09-29T21:00:03.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Thinking it over' }] } }),
    line({ timestamp: '2026-09-29T21:00:04.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git status"}', call_id: 'c1' } }),
    line({ timestamp: '2026-09-29T21:00:05.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Process exited with code 0\nclean' } }),
    line({ timestamp: '2026-09-29T21:00:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: C:\\p\\notes.txt\n+hi\n*** End Patch', call_id: 'c2' } }),
    line({ timestamp: '2026-09-29T21:00:07.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'Success. Updated the following files:\nA notes.txt' } }),
    line({ timestamp: '2026-09-29T21:00:08.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 10 }, last_token_usage: { input_tokens: 600, output_tokens: 20 }, model_context_window: 258400 }, rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 1790734354 }, secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1791321154 }, plan_type: 'plus' } } }),
    line({ timestamp: '2026-09-29T21:00:09.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } }),
    line({ timestamp: '2026-09-29T21:00:10.000Z', type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }),
    line({ timestamp: '2026-09-29T21:00:11.000Z', type: 'compacted', payload: { message: 'Summary of the work' } })
  ].join('\n') + '\n'

  it('counts usage', () => {
    const u = parseRollout(rollout, 'abc', 'Add notes')
    expect(u).toMatchObject({ provider: 'codex', title: 'Add notes', cliVersion: '0.159.0', inputTokens: 200, cacheReadTokens: 800, outputTokens: 50, reasoningTokens: 10, contextTokens: 620, contextWindow: 258400, requests: 1, userMessages: 1, lastPrompt: 'Add notes' })
    expect(u.compactions).toHaveLength(1)
  })
  it('turns records into the conversation', () => {
    const p = new CodexConversationParser('C:\\p')
    p.feed(Buffer.from(rollout))
    expect(p.items.map((i) => i.kind)).toEqual(['user', 'thinking', 'tool', 'tool', 'assistant', 'notice', 'compaction'])
    const [, , shell, edit] = p.items as any[]
    expect(shell.tool).toMatchObject({ name: 'Shell', input: 'git status', summary: 'git status', result: 'Process exited with code 0\nclean', isError: false })
    expect(edit.tool).toMatchObject({ name: 'Edit', summary: 'notes.txt' })
  })
  it('reads live details and plan limits', () => {
    const d = rolloutDetails(rollout)
    expect(d.planUsage).toMatchObject({ provider: 'codex', plan: 'plus', limits: [{ label: '5-hour', windowMinutes: 300, usedPercent: 12 }, { label: 'weekly', windowMinutes: 10080, usedPercent: 3 }] })
    expect(rolloutPlanUsage(null, 'x')).toBeNull()
    const settings = line({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-luna', approval_policy: 'on-request', approvals_reviewer: 'user', permission_profile: { type: 'managed', file_system: { type: 'restricted', entries: [{ access: 'read' }] } }, collaboration_mode: { mode: 'plan', settings: { reasoning_effort: 'low' } } } } })
    expect(rolloutDetails(settings)).toMatchObject({ modelName: 'gpt-6-luna', effort: 'low', planMode: true, permissionMode: 'read-only' })
  })
  it('tells the presets apart', () => {
    const restricted = (write: boolean) => ({ type: 'managed', file_system: { type: 'restricted', entries: [{ access: 'read' }, ...(write ? [{ access: 'write' }] : [])] } })
    expect(presetFromSettings({ approval_policy: 'on-request', approvals_reviewer: 'user', permission_profile: restricted(false) })).toBe('read-only')
    expect(presetFromSettings({ approval_policy: 'on-request', approvals_reviewer: 'user', permission_profile: restricted(true) })).toBe('ask')
  })
})

describe('Codex compactions', () => {
  const tc = (input: number, lastInput: number) =>
    line({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 5 }, last_token_usage: { input_tokens: lastInput, output_tokens: lastInput ? 5 : 0 } } } })
  const prompt = line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'hi' }] } } })
  const started = line({ type: 'event_msg', payload: { type: 'task_started' } })
  it('tells /compact (a turn without a prompt) from automatic compaction, and skips empty requests', () => {
    const manual = [started, prompt, tc(1000, 1000), started, line({ timestamp: '2026-09-30T06:36:16Z', type: 'compacted', payload: { message: '' } }), tc(1000, 0), started, prompt, tc(1400, 400)].join('\n')
    const u = parseRollout(manual, 'x', null)
    expect(u.compactions).toEqual([{ timestamp: '2026-09-30T06:36:16Z', trigger: 'manual', preTokens: 1005, postTokens: 405, lastInputTokens: 1000, lastOutputTokens: 5 }])
    expect(u.requests).toBe(2)
    const auto = [started, prompt, tc(1000, 1000), line({ type: 'compacted', payload: {} }), tc(1200, 200)].join('\n')
    expect(parseRollout(auto, 'x', null).compactions[0].trigger).toBe('auto')
  })
})

describe('Codex models', () => {
  it('names models', () => {
    expect(codexModelLabel('gpt-6-luna')).toBe('GPT-6 Luna')
    expect(codexModelLabel('gpt-5.6-terra')).toBe('GPT-5.6 Terra')
    expect(codexModelLabel('gpt-5.5')).toBe('GPT-5.5')
    expect(codexModelLabel('o4-mini')).toBe('o4-mini')
  })
})

describe('Codex skill copies', () => {
  it("replaces and removes only Hive's marked copies, and leaves the user's own folders alone", async () => {
    const { mkdirSync, writeFileSync, existsSync, readFileSync } = await import('fs')
    const { join } = await import('path')
    const root = tempDir('hive-skills-')
    const src = join(root, 'src', 'deploy')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'SKILL.md'), '# deploy v1')
    const cwd = join(root, 'proj')
    const skills = join(cwd, '.agents', 'skills')
    // The user's own folder that happens to use the prefix.
    mkdirSync(join(skills, 'hive-mine'), { recursive: true })
    writeFileSync(join(skills, 'hive-mine', 'SKILL.md'), '# mine')
    const { syncAgentsSkills } = await import('../src/main/providers/common')
    const sync = (list: { name: string; sourcePath: string }[]) => syncAgentsSkills({ cwd, skills: list } as never, 'Codex')
    await sync([{ name: 'deploy', sourcePath: src }])
    expect(readFileSync(join(skills, 'hive-deploy', 'SKILL.md'), 'utf8')).toBe('# deploy v1')
    expect(existsSync(join(skills, 'hive-deploy', '.hive-copy'))).toBe(true)
    writeFileSync(join(src, 'SKILL.md'), '# deploy v2')
    await sync([{ name: 'deploy', sourcePath: src }])
    expect(readFileSync(join(skills, 'hive-deploy', 'SKILL.md'), 'utf8')).toBe('# deploy v2')
    // Disabled: Hive's copy goes, the user's folder stays.
    await sync([])
    expect(existsSync(join(skills, 'hive-deploy'))).toBe(false)
    expect(existsSync(join(skills, 'hive-mine', 'SKILL.md'))).toBe(true)
  })
})

describe('Codex permission menu (#396)', () => {
  // Codex's /permissions menu as rendered: 0.161.0's own (captured in a test home, with Read Only and with Ask for
  // approval current), and 0.160's order (Read Only first) in the same layout, as Hive's earlier number picks assumed.
  // A line per row, however git checked the fixture out (CRLF on Windows).
  const screen = (name: string) => readText(joinPath(__dirname, 'fixtures', `codex-${name}.txt`), 'utf8').replace(/\r\n/g, '\n')
  const MODES = ['read-only', 'ask', 'approve-for-me', 'full-access'] as const

  it('finds each preset by the label Codex draws, in either order', async () => {
    const { permissionsMenuNumber } = await import('../src/main/providers/codex/permissionsMenu')
    for (const name of ['0.161-permissions-readonly', '0.161-permissions-ask']) expect(MODES.map((m) => permissionsMenuNumber(screen(name), m)), name).toEqual(['4', '1', '2', '3'])
    expect(MODES.map((m) => permissionsMenuNumber(screen('0.160-permissions-readonly'), m))).toEqual(['1', '2', '3', '4'])
  })

  it('finds nothing while the menu isn\'t drawn, or a label it doesn\'t show', async () => {
    const { permissionsMenuNumber } = await import('../src/main/providers/codex/permissionsMenu')
    const start = screen('0.161-permissions-ask').split('Update Model Permissions')[0]
    // The start screen names /permissions, but no numbered preset.
    for (const m of MODES) expect(permissionsMenuNumber(start, m), m).toBeNull()
    // A menu without a preset (renamed, or dropped by a Codex version): that one isn't found, the others are.
    const renamed = screen('0.161-permissions-ask').replace('Full Access', 'Full Control')
    expect(permissionsMenuNumber(renamed, 'full-access')).toBeNull()
    expect(permissionsMenuNumber(renamed, 'read-only')).toBe('4')
    // A label inside another's description isn't taken for it.
    expect(permissionsMenuNumber('  1. Approve for me   Unlike Ask for approval, it asks less', 'ask')).toBeNull()
  })

  it("opens /permissions and picks the number from the menu on Codex's screen; reads the confirmation Codex prints", async () => {
    const { codex } = await import('../src/main/providers/codex/adapter')
    const steps = codex.modeMenuKeys('ask')
    expect(steps.slice(0, 3).map((s) => ('keys' in s ? s.keys : null))).toEqual(['\x15', '/permissions', '\r'])
    const pick = steps[3]
    if (!('pick' in pick)) throw new Error('the last step picks from the screen')
    expect(pick.what).toBe('"Ask for approval" in Codex\'s /permissions menu')
    expect(pick.pick(screen('0.161-permissions-readonly'))).toBe('1')
    expect(pick.pick(screen('0.160-permissions-readonly'))).toBe('2')
    expect(codex.modeFromOutput('… • Permission selection requested: Read Only › Ask Codex to do anything')).toBe('read-only')
    expect(codex.modeFromOutput('Permission selection requested: Approve for me Permission selection requested: Full Access')).toBe('full-access')
    expect(codex.modeFromOutput('nothing yet')).toBeNull()
  })

  it('types the steps, waits for a pick to show, and fails clearly when it never does', async () => {
    const { PickNotFound, typeKeySteps } = await import('../src/main/keySteps')
    const { codex } = await import('../src/main/providers/codex/adapter')
    // The menu shows a moment after Enter.
    let shown = ''
    const typed: string[] = []
    await typeKeySteps(codex.modeMenuKeys('full-access'), {
      write: (k) => {
        typed.push(k)
        if (k === '\r') setTimeout(() => (shown = screen('0.161-permissions-readonly')), 150)
      },
      screen: () => shown
    })
    expect(typed).toEqual(['\x15', '/permissions', '\r', '3'])
    // Never shown: the keys before it went in, nothing is chosen, and the error says what was missing.
    const before: string[] = []
    const err = await typeKeySteps(codex.modeMenuKeys('ask'), { write: (k) => before.push(k), screen: () => 'no menu here', pickTimeoutMs: 300 }).catch((e) => e)
    expect(err).toBeInstanceOf(PickNotFound)
    expect(err.message).toBe('Couldn\'t find "Ask for approval" in Codex\'s /permissions menu.')
    expect(before).toEqual(['\x15', '/permissions', '\r'])
  })

  // #363: Codex's screens as 0.161 drew them: its input holding /permissions while a turn runs ("tab to queue
  // message"), still holding it once free, and the menu open.
  it("tells from Codex's screen whether its input still holds the command, and whether it is busy holding it", async () => {
    const { codexHoldsInput, inputHolds } = await import('../src/main/providers/codex/adapter')
    expect(inputHolds(screen('0.161-held-working'), '/permissions')).toBe(true)
    expect(inputHolds(screen('0.161-held-idle'), '/permissions')).toBe(true)
    // The menu open: its selected row is the last "›" line, not the input.
    expect(inputHolds(screen('0.161-permissions-readonly'), '/permissions')).toBe(false)
    // Taken (the input empty), or holding something else.
    expect(inputHolds(screen('0.161-held-idle').replace('› /permissions\n', '› Ask Codex to do anything\n'), '/permissions')).toBe(false)
    expect(inputHolds(screen('0.161-held-idle'), '/setup-default-sandbox')).toBe(false)
    expect(codexHoldsInput(screen('0.161-held-working'))).toBe(true)
    expect(codexHoldsInput(screen('0.161-held-idle'))).toBe(false)
    // Free, with the hint's words in the conversation above its input (someone writing about it): not busy.
    const talk = screen('0.161-held-idle').replace('› /permissions  choose', '• Codex shows "tab to queue message" while it works\n› /permissions  choose')
    expect(talk).toContain('tab to queue message')
    expect(codexHoldsInput(talk)).toBe(false)
    expect(codexHoldsInput(talk.replace('› /permissions\n', '› Ask Codex to do anything\n'))).toBe(false)
  })

  it('sends a held Enter again only while the screen holds the command once the CLI is ready, at most twice more', async () => {
    const { RESENDS, typeKeySteps } = await import('../src/main/keySteps')
    const { codex } = await import('../src/main/providers/codex/adapter')
    const held = screen('0.161-held-idle')
    const menu = screen('0.161-permissions-readonly')
    /** Types the menu keys with `react` deciding the screen after each key (the screen before any: `start`). */
    const run = async (start: string, react: (keys: string, enters: number) => string | undefined, ready?: () => Promise<true | string>) => {
      let shown = start
      const typed: string[] = []
      const err = await typeKeySteps(codex.modeMenuKeys('full-access'), {
        write: (k) => {
          typed.push(k)
          shown = react(k, typed.filter((x) => x === '\r').length) ?? shown
        },
        screen: () => shown,
        ready,
        heldSettleMs: 20,
        pickTimeoutMs: 300
      }).catch((e) => e)
      return { typed, err }
    }
    // Taken at once: the menu replaces the input. One Enter.
    expect((await run(held, (k) => (k === '\r' ? menu : undefined))).typed).toEqual(['\x15', '/permissions', '\r', '3'])
    // Held after the first Enter, taken after the second.
    expect((await run(held, (k, n) => (k === '\r' && n === 2 ? menu : undefined))).typed).toEqual(['\x15', '/permissions', '\r', '\r', '3'])
    // Never taken: Enter 1 + RESENDS times, then the pick finds no menu and nothing is chosen.
    const never = await run(held, () => undefined)
    expect(never.typed).toEqual(['\x15', '/permissions', ...Array(1 + RESENDS).fill('\r')])
    expect(never.err?.constructor?.name).toBe('PickNotFound')
    // Ready says stop (the session ended) while it waits to send again: nothing more is typed, and it says why.
    let calls = 0
    const stopped = await run(held, () => undefined, async () => (++calls < 4 ? true : 'its session ended'))
    expect(stopped.typed).toEqual(['\x15', '/permissions', '\r'])
    expect(stopped.err?.constructor?.name).toBe('KeysStopped')
    expect(stopped.err?.why).toBe('its session ended')
    // Busy again during the settle before a resend: ready is asked after it, just before the write, so nothing goes
    // into a busy CLI (here it stays busy, and typing stops).
    let busy = false
    const settling = await run(
      held,
      (k, n) => {
        if (k === '\r' && n === 1) setTimeout(() => (busy = true), 5)
        return undefined
      },
      async () => (busy ? 'it stayed busy for 30 seconds' : true)
    )
    expect(settling.typed).toEqual(['\x15', '/permissions', '\r'])
    expect(settling.err?.why).toBe('it stayed busy for 30 seconds')
    // The pick, once the menu shows: ready is asked before its number goes in. Stopped meanwhile, no number is typed.
    let opened = false
    const picking = await run(
      held,
      (k) => {
        if (k !== '\r') return undefined
        opened = true
        return menu
      },
      async () => (opened ? 'its session ended' : true)
    )
    expect(picking.typed).toEqual(['\x15', '/permissions', '\r'])
    expect(picking.err?.constructor?.name).toBe('KeysStopped')
  })
})

describe('Codex 0.159 rollout (fixture)', () => {
  // A real session (scrubbed): prompts, tool calls with apply_patch, a compaction. When a new Codex
  // version changes the format, add its fixture here.
  const text = () => require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'codex-0.159.jsonl'), 'utf8') as string
  it('reads usage, prompts and compactions', () => {
    const u = parseRollout(text(), 'fixture')
    expect(u.cliVersion).toMatch(/^0\.159/)
    expect(u.requests).toBeGreaterThan(0)
    expect(u.inputTokens + u.cacheReadTokens).toBeGreaterThan(0)
    expect(u.outputTokens).toBeGreaterThan(0)
    expect(u.userMessages).toBeGreaterThan(0)
    expect(u.compactions.length).toBe(1)
    expect(u.contextWindow).toBeGreaterThan(100000)
    expect(u.model).toMatch(/^gpt-/)
  })
  it('shows the conversation with messages and edits', () => {
    const p = new CodexConversationParser('C:\\proj')
    p.feed(Buffer.from(text()))
    const kinds = new Set(p.items.map((i) => i.kind))
    expect(kinds.has('user')).toBe(true)
    expect(kinds.has('assistant')).toBe(true)
    expect(kinds.has('tool')).toBe(true)
    expect(p.items.some((i) => i.kind === 'compaction')).toBe(true)
  })
  it('reads the live details (model, preset)', () => {
    const d = rolloutDetails(text())
    expect(d.modelName).toMatch(/^gpt-/)
    expect(d.permissionMode).toBeTruthy()
  })
})
