// Meta's Muse Code as a provider (HI-3202, against 1.4.20; each rule below is what the real binary showed, offline): the
// start context's limit (16,384 UTF-8 bytes of the hook's whole output, newlines included; one byte more and Muse keeps
// none: tests/fixtures/muse/guidance-limit-1.4.20.json), hook commands with no quote (Muse escapes `"` as `\"` before
// cmd /C), MCP server values whose env and headers are whole ${VAR}s, the launch's arguments (resume takes no prompt),
// the project's own config (fail closed), the hooks as Combwork reads them, and the account's environment.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-muse-')
process.env.CW_USER_DATA = join(base, 'userdata')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { startContext, utf8Bytes, hookPath, cmdUrl, museForwardCommand, museHooks, museServer, launchServers, museArgs, HOOK_EVENTS, passableName } = await import('../src/main/providers/muse/launch')
const { projectConfig, judgeProject, sameServer, UnreadableConfig } = await import('../src/main/providers/muse/projectConfig')
const { normalizeMuseHook, museLockReply, museEditedPaths, musePatchPaths } = await import('../src/main/providers/muse/hooks')
const { museEnv, museRoots } = await import('../src/main/providers/muse/home')
const { parseMuseVersion, classifySandbox } = await import('../src/main/providers/muse/install')
const { TOOLS_SERVER } = await import('../src/shared/assistantTools')

const MAX = 16384
const fixture = (p: string): string => readFileSync(join(__dirname, 'fixtures', p), 'utf8')

describe("Muse's start context", () => {
  it('is the guidance whole up to the limit, counted in UTF-8 bytes with its newlines (16,384 kept, as 1.4.20 kept it)', () => {
    const limit = JSON.parse(fixture('muse/guidance-limit-1.4.20.json')) as { runs: { hookOutputBytes: number; hooks: { status: string }[] }[] }
    expect(limit.runs.map((r) => [r.hookOutputBytes, r.hooks[0].status])).toEqual([
      [16384, 'completed'],
      [16385, 'failed']
    ])
    // Two-byte characters: 8191 of them and a newline is 16,383 bytes; one more character is 16,385.
    const fits = `${'é'.repeat(8191)}\nx`
    expect(utf8Bytes(fits)).toBe(MAX)
    expect(startContext(fits, MAX, 'C:\\full.md')).toEqual({ printed: fits, full: null })
  })

  it('is a pointer naming the launch’s own full file when one byte over, never the guidance cut', () => {
    const over = 'é'.repeat(8192) + '\n'
    expect(utf8Bytes(over)).toBe(MAX + 1)
    const s = startContext(over, MAX, 'C:\\launches\\r1\\muse-guidance-full.md')
    expect(s.full).toBe(over)
    expect(s.printed).toContain('C:\\launches\\r1\\muse-guidance-full.md')
    expect(utf8Bytes(s.printed)).toBeLessThanOrEqual(MAX)
    expect(s.printed).not.toContain('é')
  })

  it('refuses when even the pointer would not fit', () => {
    expect(startContext('x'.repeat(200), 100, 'C:\\' + 'p'.repeat(200))).toMatchObject({ printed: '', tooLong: true })
  })
})

describe("Muse's hook commands", () => {
  it('hold no quote: paths are given as they are when cmd reads them whole, else by their 8.3 name, else none', async () => {
    const short = async (p: string): Promise<string | null> => (p.includes('John Smith') ? 'C:\\Users\\JOHNSM~1\\x\\a.txt' : null)
    expect(await hookPath('C:\\Users\\jo\\AppData\\x\\a.txt', short)).toBe('C:\\Users\\jo\\AppData\\x\\a.txt')
    expect(await hookPath('C:\\Users\\John Smith\\x\\a.txt', short)).toBe('C:\\Users\\JOHNSM~1\\x\\a.txt')
    expect(await hookPath('C:\\Users\\A&B\\x\\a.txt', short)).toBeNull()
    expect(await hookPath('C:\\Users\\50%\\a.txt', async () => 'C:\\Users\\50%\\a.txt')).toBeNull()
  })

  it("forward to the hook server with the token from the launch's file, the URL's & escaped for cmd", () => {
    const c = museForwardCommand('http://127.0.0.1:47822/hook?run=r1&agent=a', 'C:\\x\\hook-auth.txt', 10)
    expect(c).not.toContain('"')
    expect(c).toContain('-H @C:/x/hook-auth.txt')
    expect(c).toContain('http://127.0.0.1:47822/hook?run=r1^&agent=a')
    expect(cmdUrl('a|b<c>(d)^e')).toBe('a^|b^<c^>^(d^)^^e')
  })

  it('give every event, SessionStart printing the guidance first, only PreToolUse reading the reply, Interrupt async', () => {
    const h = museHooks('http://h/?r=1', 'C:\\a.txt', 'C:\\g.md', 10) as Record<string, { hooks: { command: string; async?: boolean }[] }[]>
    expect(Object.keys(h)).toEqual([...HOOK_EVENTS])
    expect(h.SessionStart[0].hooks.map((x) => x.command.split(' ')[0])).toEqual(['type', 'curl.exe'])
    expect(h.SessionStart[0].hooks[0].command).toBe('type C:\\g.md')
    expect(h.PreToolUse[0].hooks[0].command).not.toMatch(/-o NUL$/)
    for (const e of HOOK_EVENTS.filter((x) => x !== 'PreToolUse')) expect(h[e][0].hooks.at(-1)!.command).toMatch(/-o NUL$/)
    expect(h.Interrupt[0].hooks[0].async).toBe(true)
    expect(JSON.stringify(h)).not.toContain('\\"')
  })
})

describe("Muse's MCP server values", () => {
  it('put each literal env value in a variable of their own, and name it (1.4.20 refuses a literal)', () => {
    const s = museServer(TOOLS_SERVER, { command: 'node', args: ['cw-mcp.js'], env: { CW_API_URL: 'http://127.0.0.1:1', CW_API_TOKEN_FILE: 'C:\\t.txt' } }, 'CW_MUSE_MCP_0', {})
    expect(s).toEqual({ value: { command: 'node', args: ['cw-mcp.js'], env: { CW_API_URL: '${CW_MUSE_MCP_0_0}', CW_API_TOKEN_FILE: '${CW_MUSE_MCP_0_1}' }, mode: 'required' }, vars: { CW_MUSE_MCP_0_0: 'http://127.0.0.1:1', CW_MUSE_MCP_0_1: 'C:\\t.txt' } })
  })

  it("pass the user's own ${VAR} as it is when set, and leave a server out for an unset one, a literal secret or mixed text", () => {
    expect(museServer('gh', { command: 'gh-mcp', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } }, 'P', { GITHUB_TOKEN: 'x' })).toEqual({ value: { command: 'gh-mcp', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } }, vars: {} })
    expect(museServer('gh', { command: 'gh-mcp', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } }, 'P', {})).toEqual({ skipped: 'unset' })
    expect(museServer('gh', { command: 'gh-mcp', env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnop' } }, 'P', {})).toEqual({ skipped: 'secret' })
    expect(museServer('gh', { url: 'https://x/mcp', headers: { Authorization: 'Bearer ${T}' } }, 'P', { T: 'x' })).toEqual({ skipped: 'mixed' })
    expect(museServer('web', { url: 'https://x/mcp', headers: { 'X-Team': 'blue' } }, 'P', {})).toEqual({ value: { url: 'https://x/mcp', headers: { 'X-Team': '${P_0}' } }, vars: { P_0: 'blue' } })
  })

  it('leave out a name a -c key would misread, and a server the project defines the same (Muse starts it from there)', () => {
    expect(passableName('a.b')).toBe(false)
    const r = launchServers({ 'a.b': { command: 'x' }, same: { command: 'y' }, ok: { command: 'z', env: { A: '1' } } }, new Set(['same']), {})
    expect(Object.keys(r.pass)).toEqual(['ok'])
    expect([...r.skipped.keys()]).toEqual(['a.b'])
    expect(Object.keys(r.vars)).toEqual(['CW_MUSE_MCP_0_0'])
  })
})

describe("Muse's launch arguments", () => {
  const ctx = { executable: 'C:\\muse.exe', resume: false, sessionId: '', model: 'muse-spark-1.2', effort: 'high' as const, permissionMode: 'never', extraArgs: ['--x'], initialPrompt: '-starts with a dash' }
  it('a new session: its mode, trust for the run, the hooks and servers, other CLIs’ personal skills and rules off, the task after --', () => {
    const a = museArgs({ ctx, hooks: { Stop: [] }, servers: { combwork: { command: 'n' } }, keepPersonalOut: true })
    expect(a).toEqual(['--model', 'muse-spark-1.2', '--reasoning-effort', 'high', '--approval-mode', 'never', '--trust-workspace', '-c', 'hooks={"Stop":[]}', '-c', 'mcpServers.combwork={"command":"n"}', '-c', 'context.foreign_personal_skills=false', '-c', 'context.foreign_personal_rules=false', '--x', '--', 'Task: -starts with a dash'])
  })
  it('a resume: `resume <id>` first, and no prompt (1.4.20 refuses one: it is typed once the session is up)', () => {
    const a = museArgs({ ctx: { ...ctx, resume: true, sessionId: '01a1da18-f9d5-7bc0-a1ba-a8b02a3d6294' }, hooks: {}, servers: {}, keepPersonalOut: false })
    expect(a.slice(0, 2)).toEqual(['resume', '01a1da18-f9d5-7bc0-a1ba-a8b02a3d6294'])
    expect(a).not.toContain('--')
    expect(a).not.toContain('context.foreign_personal_skills=false')
    expect(() => museArgs({ ctx: { ...ctx, resume: true, sessionId: '..\\x' }, hooks: {}, servers: {}, keepPersonalOut: false })).toThrow()
  })
})

describe("the project's own Muse config (fail closed)", () => {
  const repo = join(base, 'repo')
  const sub = join(repo, 'pkg', 'app')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(sub, { recursive: true })
  const write = (p: string, text: string): void => {
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, text)
  }

  it("reads .mcp.json and .muse settings and hooks from the folder up to the repository root, nested roots too", async () => {
    write(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { top: { command: 'a' } } }))
    write(join(repo, 'pkg', '.mcp.json'), JSON.stringify({ mcpServers: { mid: { url: 'https://m' } } }))
    write(join(sub, '.muse', 'settings.json'), JSON.stringify({ mcpServers: { own: { command: 'b' } }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }))
    write(join(sub, '.muse', 'hooks.json'), JSON.stringify({ hooks: { Stop: [] } }))
    const c = await projectConfig(sub)
    expect([...c.servers.keys()].sort()).toEqual(['mid', 'own', 'top'])
    expect(c.hookFiles).toEqual([join(sub, '.muse', 'settings.json')])
  })

  it("refuses a server not given, given otherwise, or defined twice differently; a same one isn't passed again", async () => {
    const c = await projectConfig(sub)
    const v = judgeProject({ top: { command: 'a' }, mid: { url: 'https://other' } }, c)
    expect([...v.refused.keys()].sort()).toEqual(['mid', 'own'])
    expect([...v.fromProject]).toEqual(['top'])
    expect(sameServer({ command: 'a', args: [] }, { command: 'a' })).toBe(true)
    expect(sameServer({ command: 'a', env: { X: '1' } }, { command: 'a' })).toBe(false)
    expect(sameServer({}, {})).toBe(false)
  })

  it("never reads a file it can't understand as empty", async () => {
    write(join(repo, '.mcp.json'), '{ not json')
    await expect(projectConfig(sub)).rejects.toBeInstanceOf(UnreadableConfig)
    write(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: [] }))
    await expect(projectConfig(sub)).rejects.toThrow(/mcpServers is not an object/)
    write(join(repo, '.mcp.json'), '{}')
    write(join(sub, '.muse', 'hooks.json'), JSON.stringify({ Stop: 'x' }))
    await expect(projectConfig(sub)).rejects.toThrow(/not a list/)
  })
})

describe("Muse's hooks as Combwork reads them", () => {
  const edit = { names: /^(write_file|edit_file|apply_patch)$/, pathField: 'path' }
  const recorded = fixture('muse/hooks-1.4.20-echo.jsonl')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(JSON.parse(l).stdin) as Record<string, unknown>)

  it("reads 1.4.20's recorded SessionStart, UserPromptSubmit and Stop: the session id, the turn, the prompt, the reply", () => {
    const [start, prompt, stop] = recorded.slice(0, 3).map((b) => normalizeMuseHook(b, edit))
    expect(start).toMatchObject({ event: { kind: 'start', source: 'startup' }, sessionId: '01a1d9f2-e1a5-7300-bebb-9ee68a049822', transcriptPath: null, mode: null })
    expect(prompt).toMatchObject({ event: { kind: 'prompt', text: 'probe local1: hello' }, ids: { turn: '01a1d9f2-ed3a-7d92-b086-b1bcdf63aec4' } })
    expect(stop).toMatchObject({ event: { kind: 'stop', lastMessage: 'echo: probe local1: hello' } })
  })

  it("takes an edit's files (absolute against its cwd), a patch's own files, and nothing of other tools", () => {
    expect(museEditedPaths('write_file', { path: 'src\\a.ts' }, 'C:\\p', edit)).toEqual(['C:\\p\\src\\a.ts'])
    expect(musePatchPaths('*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n*** End Patch')).toEqual(['a.ts', 'b.ts'])
    expect(museEditedPaths('apply_patch', { patch: '*** Add File: c.ts\n+x' }, 'C:\\p', edit)).toEqual(['C:\\p\\c.ts'])
    expect(museEditedPaths('powershell', { command: 'rm a.ts' }, 'C:\\p', edit)).toEqual([])
    const pre = normalizeMuseHook({ hook_event_name: 'PreToolUse', tool_name: 'edit_file', tool_input: { path: 'C:\\p\\x.ts' }, tool_use_id: 'c1', cwd: 'C:\\p' }, edit)
    expect(pre).toMatchObject({ event: { kind: 'toolStart' }, editedPaths: ['C:\\p\\x.ts'], ids: { call: 'c1' } })
  })

  it('blocks a locked edit as its SDK documents, an ask too (Muse has no ask), a warning not at all', () => {
    expect(museLockReply({ kind: 'deny', reason: 'held' })).toEqual({ decision: 'block', reason: 'held' })
    expect(museLockReply({ kind: 'ask', reason: 'held' })).toEqual({ decision: 'block', reason: 'held' })
    expect(museLockReply({ kind: 'warn', context: 'c' })).toEqual({})
  })
})

describe("Muse's environment, install and sandbox", () => {
  it("runs on the account's two roots, never inherited ones, with META_API_KEY and MUSE_CUSTOM_HEADERS left out", () => {
    const env = museEnv({ PATH: 'p', XDG_DATA_HOME: 'C:\\user', xdg_config_home: 'C:\\user2', META_API_KEY: 'k', MUSE_CUSTOM_HEADERS: 'h', CW_X: '1' }, 'C:\\acct', true)
    expect(env).toEqual({ PATH: 'p', CW_X: '1', ...museRoots('C:\\acct') })
    expect(museRoots('C:\\acct')).toEqual({ XDG_DATA_HOME: 'C:\\acct', XDG_CONFIG_HOME: 'C:\\acct\\xdg-config' })
    expect(museEnv({ META_API_KEY: 'k' }, 'C:\\acct', false).META_API_KEY).toBe('k')
  })

  it('reads its version and its sandbox check as 1.4.20 prints them', () => {
    expect(parseMuseVersion('Muse Code 1.4.20 (1.4.20-R8619.1)\n')).toBe('1.4.20')
    expect(parseMuseVersion('muse 9')).toBeNull()
    const text = fixture('advanced/sandbox-check-muse-1.4.20.txt')
    expect(classifySandbox({ stdout: text, stderr: '', code: 1 }, /^status=setup_required\s*$/m)).toBe('setup')
    expect(classifySandbox({ stdout: 'status=ready\n', stderr: '', code: 0 }, /^status=setup_required\s*$/m)).toBe('ready')
    expect(classifySandbox({ stdout: '', stderr: 'boom', code: 1 }, /^status=setup_required\s*$/m)).toBe('unknown')
  })
})
