// Claude Code under an organisation's managed policy (HI-2777): the admin snippet and Combwork's launch hooks built
// identical (so the CLI runs a handler in both once), the policy that would keep Combwork's hooks away read from recorded
// managed settings (one test per shape, and their combinations), and the snippet's command run through both shells
// Claude Code uses, with a Unicode folder for the auth file.
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import http from 'http'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

// A child's environment from the run context's allowlist, never this shell's (tests/README.md, Isolation).
const runContext = createRequire(import.meta.url)('./e2e/runContext.cjs') as { childEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

const userData = await vi.hoisted(async () => (await import('./tempDir')).tempDir('cw-managed-hooks-'))
vi.mock('electron', () => ({ app: { getPath: () => userData, getVersion: () => '0.0.0-test', isPackaged: false } }))

const { CLAUDE_HOOK_EVENTS, claudeHookHandlers, claudeManagedSnippet, fixedHookUrl, forwardCommand, forwardScript } = await import('../src/shared/claudeHookHandlers')
const { hookCause, urlAllowed } = await import('../src/main/providers/claude/hookPolicy')
const { usedAdminSources, parseRegSettings, managedFiles } = await import('../src/main/providers/claude/updateChannel')

const base = tempDir('cw-managed-hooks-base-')
afterAll(() => {
  rmSync(base, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

const T = { hook: 5, preToolUse: 10 }
const URL47821 = 'http://127.0.0.1:47821/hook'

describe('the admin snippet (HI-2777)', () => {
  it('posts each HTTP hook to the fixed URL with the token from the environment, and holds no secret', () => {
    const s = claudeManagedSnippet([47821], T) as { hooks: Record<string, any[]>; statusLine: { command: string } }
    expect(Object.keys(s.hooks)).toEqual([...CLAUDE_HOOK_EVENTS])
    for (const ev of CLAUDE_HOOK_EVENTS.filter((e) => e !== 'SessionStart')) {
      const h = s.hooks[ev][0].hooks[0]
      expect(h).toEqual({ type: 'http', url: URL47821, timeout: ev === 'PreToolUse' ? 10 : 5, headers: { Authorization: 'Bearer $CW_HOOK_TOKEN' }, allowedEnvVars: ['CW_HOOK_TOKEN'] })
    }
    expect(s.hooks.PreToolUse[0].matcher).toBe('*')
    expect(s.hooks.SessionStart[0].hooks[0]).toMatchObject({ type: 'command', timeout: 5 })
    expect(s.statusLine.command).toMatch(/^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/)
    // No port in the command hooks (they read CW_HOOK_URL), no token anywhere.
    expect(JSON.stringify(s.hooks.SessionStart)).not.toContain('4782')
    expect(JSON.stringify(s)).not.toMatch(/[0-9a-f]{48}/)
  })

  it('names one handler per port asked for, in one array per event; the status line can be left out', () => {
    const s = claudeManagedSnippet([47821, 47822, 47821], T, { statusLine: false }) as { hooks: Record<string, any[]>; statusLine?: unknown }
    expect(s.hooks.Stop[0].hooks.map((h: { url: string }) => h.url)).toEqual([URL47821, 'http://127.0.0.1:47822/hook'])
    expect(s.hooks.SessionStart[0].hooks).toHaveLength(1)
    expect(s.statusLine).toBeUndefined()
  })

  it('its command reads the URL and auth file from the launch, gives curl only the file name, and sends nothing outside Combwork', () => {
    const script = forwardScript(5, '?statusline')
    expect(script).toContain('$u=$env:CW_HOOK_URL; $a=$env:CW_HOOK_AUTH_FILE')
    expect(script).toContain('if (-not $u -or -not $a) { exit 0 }')
    expect(script).toContain('Set-Location -LiteralPath (Split-Path -LiteralPath $a)')
    expect(script).toContain('-H "@$(Split-Path $a -Leaf)"')
    // "$u?statusline" would read a PowerShell variable named u?statusline: the URL is a subexpression.
    expect(script).toContain('"$($u)?statusline"')
    const encoded = forwardCommand(5).split(' ').pop()!
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(forwardScript(5))
  })

  it("the user guide's snippet is the one Combwork makes for port 47821 and the default timeouts, its script decoded", async () => {
    const { advancedDef } = await import('../src/shared/advanced')
    const defaults = { hook: advancedDef('claude-code.hooks.timeoutSeconds')!.default as number, preToolUse: advancedDef('claude-code.hooks.preToolUseTimeoutSeconds')!.default as number }
    const { claudeManagedSnippetText, MANAGED_POLICY_GUIDE } = await import('../src/shared/claudeHookHandlers')
    const guide = readFileSync(join(__dirname, '..', 'docs', 'USER_GUIDE.md'), 'utf8').replace(/\r\n/g, '\n')
    const section = guide.slice(guide.indexOf(`<a id="${MANAGED_POLICY_GUIDE}"></a>`))
    expect(section.length).toBeLessThan(guide.length)
    expect(/```json\n([\s\S]*?)\n```/.exec(section)?.[1]).toBe(claudeManagedSnippetText([47821], defaults))
    expect(/```powershell\n([\s\S]*?)\n```/.exec(section)?.[1]).toBe(forwardScript(defaults.hook))
  })

  it("Combwork's launch hooks are the snippet's for its port and timeouts, handler for handler (so the CLI runs each once)", async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const project = join(base, 'project')
    mkdirSync(project, { recursive: true })
    const priv = join(base, 'private')
    const ctx = { projectPath: project, agentId: 'a1', cwd: project, skills: [], mcpServers: {}, hookUrl: 'http://127.0.0.1:9/hook?run=r', fixedHookUrl: URL47821, env: { CLAUDE_CONFIG_DIR: join(base, 'home') }, extraArgs: [], hookAuthFile: join(priv, 'hook-auth.txt'), privateDir: priv, overrides: {} }
    await claudeCode.prepareLaunch(ctx as never)
    const settings = JSON.parse(readFileSync(join(priv, 'settings.json'), 'utf8'))
    const snippet = claudeManagedSnippet([47821], { hook: 5, preToolUse: 10 }) as { hooks: Record<string, unknown> }
    expect(settings.hooks).toEqual(snippet.hooks)
    // With the Agent API not listening: the run's server, which knows the run by its token, then they differ.
    expect(claudeHookHandlers(['http://127.0.0.1:9/hook?run=r'], T)).not.toEqual(snippet.hooks)
    expect(fixedHookUrl(47822)).toBe('http://127.0.0.1:47822/hook')
  })
})

/** Managed sources as usedAdminSources gives them. */
const used = (...docs: { kind: 'hklm' | 'file' | 'hkcu'; settings: Record<string, unknown> }[]) => ({ used: docs })
const file = (settings: Record<string, unknown>) => used({ kind: 'file', settings })
const scope = (kind: 'cli' | 'local' | 'project' | 'user', json: unknown, label = `${kind} settings`, unsure?: string) => ({ kind, label, json, ...(unsure ? { unsure } : {}) })
const NEED = { url: URL47821, envVar: 'CW_HOOK_TOKEN' }
const read = (settings: Record<string, unknown>) => async () => ({ state: 'read' as const, settings })
const absent = async () => ({ state: 'absent' as const })
const unreadable = async () => ({ state: 'unreadable' as const })

describe("what would keep Combwork's hooks away, from recorded managed settings (HI-2777)", () => {
  it('the registry policy (HKLM) allowing only managed hooks: named, with the snippet offered', () => {
    const doc = parseRegSettings('HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode\r\n    Settings    REG_SZ    {"allowManagedHooksOnly":true}\r\n')
    expect(doc.state).toBe('read')
    const c = hookCause(used({ kind: 'hklm', settings: (doc as { settings: Record<string, unknown> }).settings }), [], NEED)
    expect(c).toMatchObject({ why: 'managedOnly', setting: 'allowManagedHooksOnly', snippet: true })
    expect(c!.where).toMatch(/HKLM/)
  })

  it('the managed settings file, merged with its drop-ins (a later scalar winning)', async () => {
    const dir = join(base, 'managed-file')
    mkdirSync(join(dir, 'managed-settings.d'), { recursive: true })
    writeFileSync(join(dir, 'managed-settings.json'), JSON.stringify({ allowManagedHooksOnly: false }))
    writeFileSync(join(dir, 'managed-settings.d', '50-hooks.json'), JSON.stringify({ allowManagedHooksOnly: true }))
    const got = await usedAdminSources({ hklm: absent, files: () => managedFiles(dir), hkcu: absent })
    expect(hookCause(got, [], NEED)).toMatchObject({ why: 'managedOnly', where: "Claude Code's managed settings file" })
  })

  it("a drop-in's allowlist entries join the base file's, never replace them (review round 1)", async () => {
    const dir = join(base, 'managed-lists')
    mkdirSync(join(dir, 'managed-settings.d'), { recursive: true })
    writeFileSync(join(dir, 'managed-settings.json'), JSON.stringify({ allowedHttpHookUrls: ['http://127.0.0.1:47821/hook*'], httpHookAllowedEnvVars: ['CW_HOOK_TOKEN'] }))
    writeFileSync(join(dir, 'managed-settings.d', '10-corp.json'), JSON.stringify({ allowedHttpHookUrls: ['https://hooks.corp.example/*'], httpHookAllowedEnvVars: ['OTHER'] }))
    expect(await managedFiles(dir)).toEqual({ state: 'read', settings: { allowedHttpHookUrls: ['http://127.0.0.1:47821/hook*', 'https://hooks.corp.example/*'], httpHookAllowedEnvVars: ['CW_HOOK_TOKEN', 'OTHER'] } })
    expect(hookCause(await usedAdminSources({ hklm: absent, files: () => managedFiles(dir), hkcu: absent }), [], NEED)).toBeNull()
  })

  it('merged managed sources lock allowManagedHooksOnly if any of them does: a higher false never hides a lower true (review round 1)', async () => {
    const got = await usedAdminSources({ hklm: read({ managedSourcesBehavior: 'merge', allowManagedHooksOnly: false }), files: read({ allowManagedHooksOnly: true }), hkcu: absent })
    expect(hookCause(got, [], NEED)).toMatchObject({ why: 'managedOnly', where: "Claude Code's managed settings file" })
    // First wins (no merge): the file isn't used, so its lock isn't either.
    expect(hookCause(await usedAdminSources({ hklm: read({ allowManagedHooksOnly: false }), files: read({ allowManagedHooksOnly: true }), hkcu: absent }), [], NEED)).toBeNull()
  })

  it('managed disableAllHooks: every hook is off, managed ones too, so no snippet; it wins over allowManagedHooksOnly', () => {
    expect(hookCause(file({ disableAllHooks: true, allowManagedHooksOnly: true }), [], NEED)).toMatchObject({ why: 'off', setting: 'disableAllHooks', snippet: false })
  })

  it('allowManagedHooksOnly with a lower disableAllHooks: managed only is the cause (a lower one never stops managed hooks), the other named beside it', () => {
    expect(hookCause(file({ allowManagedHooksOnly: true }), [scope('user', { disableAllHooks: true }, "Claude Code's settings.json")], NEED)).toEqual({ why: 'managedOnly', setting: 'allowManagedHooksOnly', where: "Claude Code's managed settings file", snippet: true, also: "Claude Code's settings.json" })
  })

  it("an HTTP hook allowlist without Combwork's URL (they merge across files; * matches anything)", () => {
    expect(hookCause(file({ allowedHttpHookUrls: ['https://hooks.example.com/*'] }), [], NEED)).toMatchObject({ why: 'blocked', setting: 'allowedHttpHookUrls', snippet: true })
    // Another file's entry lets it through: the lists are merged.
    expect(hookCause(file({ allowedHttpHookUrls: ['https://hooks.example.com/*'] }), [scope('user', { allowedHttpHookUrls: ['http://127.0.0.1:*'] })], NEED)).toBeNull()
    expect(urlAllowed(URL47821, ['http://127.0.0.1:47821/hook*'])).toBe(true)
    expect(urlAllowed(URL47821, ['HTTP://127.0.0.1:*'])).toBe(true)
    expect(urlAllowed(URL47821, ['http://localhost:*'])).toBe(false)
  })

  it("an env allowlist without the token's variable (hooks would arrive with no token)", () => {
    expect(hookCause(file({ httpHookAllowedEnvVars: ['OTHER'] }), [], NEED)).toMatchObject({ why: 'blocked', setting: 'httpHookAllowedEnvVars' })
    expect(hookCause(file({ httpHookAllowedEnvVars: ['CW_HOOK_TOKEN'] }), [], NEED)).toBeNull()
  })

  it('disableAllHooks in the deciding scope that is not managed (the first that sets it, highest first)', () => {
    expect(hookCause(used(), [scope('project', { disableAllHooks: false }), scope('user', { disableAllHooks: true })], NEED)).toBeNull()
    expect(hookCause(used(), [scope('local', { disableAllHooks: true }, 'local file'), scope('user', { disableAllHooks: false })], NEED)).toMatchObject({ why: 'off', where: 'local file', snippet: false })
  })

  it('none: nothing local keeps them away', () => {
    expect(hookCause(used(), [scope('user', { hooks: {} })], NEED)).toBeNull()
  })

  it("a source Combwork couldn't read is said, never taken as none (review round 1): HKLM, the file, a drop-in, HKCU, a settings scope", async () => {
    const dir = join(base, 'managed-bad-dropin')
    mkdirSync(join(dir, 'managed-settings.d'), { recursive: true })
    writeFileSync(join(dir, 'managed-settings.json'), JSON.stringify({ disableAllHooks: false }))
    writeFileSync(join(dir, 'managed-settings.d', '20-broken.json'), '{ not json')
    const cases: [string, Parameters<typeof usedAdminSources>[0], RegExp][] = [
      ['HKLM', { hklm: unreadable, files: absent, hkcu: absent }, /HKLM/],
      ['the file', { hklm: absent, files: unreadable, hkcu: absent }, /managed settings file/],
      ['a drop-in', { hklm: absent, files: () => managedFiles(dir), hkcu: absent }, /managed settings file/],
      ['HKCU, with no admin source', { hklm: absent, files: absent, hkcu: unreadable }, /HKCU/],
      ['a merged source below', { hklm: read({ managedSourcesBehavior: 'merge' }), files: unreadable, hkcu: absent }, /managed settings file/]
    ]
    for (const [name, sources, where] of cases) {
      const c = hookCause(await usedAdminSources(sources), [], NEED)
      expect(c?.why, name).toBe('unreadable')
      expect(c?.where, name).toMatch(where)
      expect(c?.snippet, name).toBe(true)
    }
    expect(hookCause(used(), [scope('user', null, "Claude Code's settings.json", "couldn't be read (EACCES)")], NEED)).toMatchObject({ why: 'unreadable', where: "Claude Code's settings.json" })
    // A definite cause in a scope it could read still comes first.
    expect(hookCause(used(), [scope('local', { disableAllHooks: true }, 'local file'), scope('user', null, 'user file', 'unreadable')], NEED)).toMatchObject({ why: 'off', where: 'local file' })
  })

  it('which managed sources count, as Claude Code chooses them: HKLM over the file (first wins), HKCU only with no admin source', async () => {
    expect(await usedAdminSources({ hklm: read({ allowManagedHooksOnly: false }), files: read({ allowManagedHooksOnly: true }), hkcu: absent })).toEqual(used({ kind: 'hklm', settings: { allowManagedHooksOnly: false } }))
    expect(await usedAdminSources({ hklm: absent, files: absent, hkcu: read({ allowManagedHooksOnly: true }) })).toEqual(used({ kind: 'hkcu', settings: { allowManagedHooksOnly: true } }))
    expect(await usedAdminSources({ hklm: absent, files: read({ disableAllHooks: false }), hkcu: read({ allowManagedHooksOnly: true }) })).toEqual(used({ kind: 'file', settings: { disableAllHooks: false } }))
  })
})

// The longest a shell run here takes: a bound for a hung one, never how long it should take.
const CHILD_HUNG_MS = 20000

/** Runs `command` through `shell` with `input` on stdin, in the run context's environment plus `env`; bounded. */
function run(shell: string, args: string[], input: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, { env: runContext.childEnv(env), windowsHide: true })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.resume()
    // A child that doesn't end is ended, and the test fails: never left behind.
    const t = setTimeout(() => {
      child.kill()
      reject(new Error(`${shell} didn't end within ${CHILD_HUNG_MS} ms`))
    }, CHILD_HUNG_MS)
    child.on('error', (e) => {
      clearTimeout(t)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, out })
    })
    child.stdin.end(input, 'utf8')
  })
}

const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'

describe.runIf(process.platform === 'win32')("the snippet's command through Git Bash and PowerShell, a Unicode folder for the auth file (HI-2777)", () => {
  it('posts stdin byte for byte with the header from the file, prints the reply, and sends nothing without the variables', async () => {
    const got: { url: string; auth: string; body: string }[] = []
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        got.push({ url: req.url ?? '', auth: req.headers.authorization ?? '', body: Buffer.concat(chunks).toString('utf8') })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":"réplique"}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const port = (server.address() as { port: number }).port
      const dir = join(base, 'Jöhn Dœ 日本 folder')
      mkdirSync(dir, { recursive: true })
      const auth = join(dir, 'hook-auth.txt')
      writeFileSync(auth, 'Authorization: Bearer synthetic-token\n')
      const env = { CW_HOOK_URL: `http://127.0.0.1:${port}/hook`, CW_HOOK_AUTH_FILE: auth }
      const body = '{"hook_event_name":"SessionStart","cwd":"C:\\\\Üsers\\\\日本","x":"é"}'
      const shells: [string, string[]][] = [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', forwardCommand(5)]]]
      if (await run('cmd.exe', ['/c', 'if exist', `"${gitBash}"`, 'echo', 'y'], '', {}).then((r) => r.out.includes('y'))) shells.push([gitBash, ['-c', forwardCommand(5)]])
      for (const [shell, args] of shells) {
        const r = await run(shell, args, body, env)
        expect(r.code, shell).toBe(0)
        expect(r.out.trim(), shell).toBe('{"ok":"réplique"}')
        expect(got.pop(), shell).toEqual({ url: '/hook', auth: 'Bearer synthetic-token', body })
      }
      // The status line's: ?statusline after the URL.
      const s = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', forwardCommand(5, '?statusline')], '{"model":{"id":"m"}}', env)
      expect(s.code).toBe(0)
      expect(got.pop()?.url).toBe('/hook?statusline')
      // Outside Combwork (no variables): exits 0, sends nothing.
      const none = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', forwardCommand(5)], body, { CW_HOOK_URL: '', CW_HOOK_AUTH_FILE: '' })
      expect(none.code).toBe(0)
      expect(got).toHaveLength(0)
    } finally {
      server.close()
    }
  }, 30000)
})
