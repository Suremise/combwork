// Hook tokens (#345): one per launch, checked against the launch a hook names and ended with it; hook commands read the
// header from a file in Hive's user data, so nothing Hive generates for a launch (either provider) holds a token.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { redactLog } from '../src/shared/redact'
import { tempDir } from './tempDir'

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

// Its own user data folder, so the auth files never meet another test's.
const userData = await vi.hoisted(async () => (await import('./tempDir')).tempDir('hive-hook-tokens-'))
vi.mock('electron', () => ({ app: { getPath: () => userData, getVersion: () => '0.0.0-test', isPackaged: false } }))

const { clearHookAuth, endHookToken, hookAuthFile, hookTokenMatches, newHookToken, refusedHookNote } = await import('../src/main/hookTokens')

const base = tempDir('hive-hook-launch-')
afterAll(() => {
  rmSync(base, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

/** A path as hook commands write it: forward slashes. */
const slashed = (p: string): string => p.replace(/\\/g, '/')

/** Every file under a folder whose content holds `text`. */
function filesHolding(dir: string, text: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...filesHolding(p, text))
    else if (readFileSync(p, 'utf8').includes(text)) out.push(p)
  }
  return out
}

describe('hook tokens per launch (#345)', () => {
  it("takes a launch's own token, not another launch's, and none once it has ended", async () => {
    const a = await newHookToken('runa')
    const b = await newHookToken('runb')
    expect(a.token).not.toBe(b.token)
    expect(hookTokenMatches('runa', `Bearer ${a.token}`)).toBe(true)
    // Another session's token, a wrong one, none, or no launch named.
    expect(hookTokenMatches('runa', `Bearer ${b.token}`)).toBe(false)
    expect(hookTokenMatches('runa', 'Bearer nope')).toBe(false)
    expect(hookTokenMatches('runa', undefined)).toBe(false)
    expect(hookTokenMatches(null, `Bearer ${a.token}`)).toBe(false)
    expect(hookTokenMatches('runc', `Bearer ${a.token}`)).toBe(false)
    // Ended: refused, and its file goes; the other launch's still works.
    endHookToken('runa')
    expect(hookTokenMatches('runa', `Bearer ${a.token}`)).toBe(false)
    await vi.waitFor(() => expect(existsSync(a.file)).toBe(false), { timeout: HUNG_MS })
    expect(hookTokenMatches('runb', `Bearer ${b.token}`)).toBe(true)
    endHookToken('runb')
  })

  it("writes the header curl reads to a file in Hive's user data, and clears what an earlier run left", async () => {
    const t = await newHookToken('runfile')
    expect(t.file).toBe(join(userData, 'launches', 'runfile', 'hook-auth.txt'))
    expect(t.dir).toBe(join(userData, 'launches', 'runfile'))
    expect(readFileSync(t.file, 'utf8')).toBe(`Authorization: Bearer ${t.token}\n`)
    expect(() => hookAuthFile('../x')).toThrow()
    await clearHookAuth()
    expect(existsSync(join(userData, 'launches'))).toBe(false)
    endHookToken('runfile')
  })

  it('no file Hive generates in a project, and no argument it passes, holds a secret: the hook token, MCP servers\' own, a --settings env (Claude Code and Codex)', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const { codex } = await import('../src/main/providers/codex/adapter')
    // Hook trust is checked against the Codex executable; not what this test is about.
    ;(codex as unknown as { checkHookHashes: () => Promise<void> }).checkHookHashes = async () => undefined
    const project = join(base, 'project')
    const skill = join(base, 'skills', 'demo')
    mkdirSync(skill, { recursive: true })
    mkdirSync(project, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: demo\n---\n\nA skill.\n')
    // Synthetic secrets: a workspace MCP server's env and header, and the env of a user's --settings.
    const SECRETS = ['SYNTHETIC-MCP-ENV-SECRET', 'SYNTHETIC-MCP-HEADER-SECRET', 'SYNTHETIC-SETTINGS-ENV-SECRET']
    const mcpServers = {
      combwork: { command: 'node', args: ['cw-mcp.js'], env: { CW_API_TOKEN_FILE: join(userData, 'agent-api', 'x.json') } },
      third: { command: 'node', args: ['server.js'], env: { API_KEY: SECRETS[0] } },
      remote: { type: 'http', url: 'https://mcp.example/x', headers: { Authorization: `Bearer ${SECRETS[1]}` } }
    }
    for (const adapter of [claudeCode, codex]) {
      const runId = `run${adapter.id.replace(/\W/g, '')}`
      const auth = await newHookToken(runId)
      const ctx = {
        projectPath: project, agentId: 'a1', executable: 'C:/bin/cli.exe', cwd: project, workspacePath: base, runId, sessionId: '00000000-0000-4000-8000-000000000000',
        resume: false, name: '', skills: [{ name: 'demo', sourcePath: skill }], mcpServers,
        model: null, effort: null, permissionMode: null, extraArgs: adapter === claudeCode ? ['--settings', JSON.stringify({ env: { MY_API_KEY: SECRETS[2] } })] : [],
        hookUrl: `http://127.0.0.1:9/hook?run=${runId}`, hookAuthFile: auth.file, privateDir: auth.dir, guidance: 'Guidance.',
        env: { CW_HOOK_TOKEN: auth.token }, allowBackgroundSessions: false, use200kContext: false
      }
      await adapter.prepareLaunch(ctx as never)
      const cmd = adapter.buildCommand(ctx.executable, ctx as never)
      const args = cmd.args.join(' ')
      for (const secret of [auth.token, ...SECRETS]) {
        expect(filesHolding(project, secret), `${adapter.id}: ${secret.slice(0, 12)}`).toEqual([])
        // Codex leaves out an MCP server with a literal secret (it would be on its command line), with a warning.
        expect(args, `${adapter.id}: ${secret.slice(0, 12)}`).not.toContain(secret)
      }
      if (adapter === claudeCode) {
        // Claude Code still gets every server and the user's settings: from the launch's private folder, outside the project.
        expect(auth.dir.toLowerCase().startsWith(project.toLowerCase())).toBe(false)
        const mcpFile = cmd.args[cmd.args.indexOf('--mcp-config') + 1]
        const settingsFile = cmd.args[cmd.args.indexOf('--settings') + 1]
        expect([mcpFile, settingsFile]).toEqual([join(auth.dir, 'mcp.json'), join(auth.dir, 'settings.json')])
        expect(JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers).toEqual(mcpServers)
        const settings = JSON.parse(readFileSync(settingsFile, 'utf8'))
        expect(settings.env).toEqual({ MY_API_KEY: SECRETS[2] })
        // Its hook commands read the header from the auth file.
        expect(settings.statusLine.command).toContain(`-H "@${slashed(auth.file)}"`)
        expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(`-H "@${slashed(auth.file)}"`)
      } else {
        expect(args).toContain(`@${slashed(auth.file)}`)
      }
      // The launch ends: its private folder goes.
      endHookToken(runId)
      await vi.waitFor(() => expect(existsSync(auth.dir)).toBe(false), { timeout: HUNG_MS })
    }
  })

  it('logs a refused hook call once a run, saying why, and names only runs this Hive started (#711)', async () => {
    await newHookToken('runlive')
    await newHookToken('runended')
    endHookToken('runended')
    // A wrong token for a running launch, an ended launch, none named: each said once.
    expect(refusedHookNote('runlive')).toBe("Refused a hook call for run runlive: its token didn't match the launch's")
    expect(refusedHookNote('runlive')).toBeNull()
    expect(refusedHookNote('runended')).toBe('Refused a hook call for run runended: that launch has ended')
    expect(refusedHookNote('runended')).toBeNull()
    expect(refusedHookNote(null)).toBe('Refused a hook call that named no launch')
    expect(refusedHookNote(null)).toBeNull()
    // What a caller sent that names no run of Hive's is never in the log, however it looks (review round 1: a plain
    // word a character check takes for a run id, or a forged log line), and Copy Diagnostics keeps the reason.
    const unknown = refusedHookNote('ConfidentialAcquisitionDelta')
    expect(unknown).toBe("Refused a hook call naming a run this Hive didn't start")
    expect(refusedHookNote('a b\n[ERROR] forged')).toBeNull()
    const copied = redactLog(`2026-10-14T02:36:34.759Z [INFO] [servers] ${unknown}`, { home: 'C:\\Users\\nobody', folders: [], names: [] })
    expect(copied).not.toContain('Confidential')
    expect(copied).toContain("naming a run this Hive didn't start")
  })
})
