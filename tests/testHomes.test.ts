import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
// @ts-expect-error: plain .mjs module without types
import { assertTestHome, freshenHome, freshenedLine, HomeNotReady, MARKER } from './e2e/testHomes.mjs'
// @ts-expect-error: plain .mjs module without types
import { classify, UNCLASSIFIED } from './e2e/testHomeManifest.mjs'
// @ts-expect-error: plain .mjs module without types
import { acquireTestHome, homesOf, leasesEnv, LEASES_VAR } from './e2e/testHomeLock.mjs'

// The CLI test homes start each run fresh, keeping only the sign-in (HI-2606, design s17 with Darren's answers): fake
// homes with known bytes, the CLIs' sign-in status scripted, nothing real read or signed in.

const tmp = tempDir('cw-test-homes-')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
let n = 0
const CREDENTIALS = '{"claudeAiOauth":{"accessToken":"fake-access","refreshToken":"fake-refresh"}}'
const AUTH = '{"tokens":{"refresh_token":"fake-refresh"}}'

function claudeHome(): string {
  const home = join(tmp, `claude-${++n}`)
  mkdirSync(join(home, 'projects', 'C--ws-demo', 'memory'), { recursive: true })
  writeFileSync(join(home, 'projects', 'C--ws-demo', 'memory', 'MEMORY.md'), 'remembered')
  writeFileSync(join(home, '.credentials.json'), CREDENTIALS)
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'test@example.invalid' }, userID: 'u', hasCompletedOnboarding: true, opusProMigrationComplete: true, projects: { 'C:/ws/demo': { hasTrustDialogAccepted: true } }, skillUsage: { 'work-on-card': 3 }, tipsHistory: { x: 1 } }))
  writeFileSync(join(home, 'history.jsonl'), '{"display":"old prompt"}\n')
  writeFileSync(join(home, '.claude.json.tmp.1234.abcd'), '{')
  writeFileSync(join(home, 'settings.json'), '{"theme":"dark"}')
  writeFileSync(join(home, 'mystery.db'), 'unknown')
  return home
}

function codexHome(): string {
  const home = join(tmp, `codex-${++n}`)
  mkdirSync(join(home, 'sessions', '2026'), { recursive: true })
  mkdirSync(join(home, 'packages', '0.163.0'), { recursive: true })
  writeFileSync(join(home, 'auth.json'), AUTH)
  writeFileSync(join(home, 'config.toml'), '[windows]\nsandbox = "unelevated"\n\n[tui]\nscreen_reader_detection_done = true\n\n[projects.\'C:\\ws\\demo\']\ntrust_level = "trusted"\n\n[mcp_servers.userfake]\ncommand = "node"\n')
  for (const f of ['state_5.sqlite', 'state_5.sqlite-wal', 'memories_1.sqlite', 'history.jsonl']) writeFileSync(join(home, f), 'x')
  writeFileSync(join(home, 'packages', '0.163.0', 'codex.exe'), 'binary')
  return home
}

const status = (answers: string[]) => {
  const said: string[] = []
  return { fn: async () => (said.push(''), answers[Math.min(said.length - 1, answers.length - 1)]), said }
}
const deps = (answers: string[], extra: Record<string, unknown> = {}) => ({ status: status(answers).fn, users: async () => [], waitMs: 0, pollMs: 1, ...extra })

describe('what a reset keeps and clears (testHomeManifest.mjs)', () => {
  it('names the sign-in apart, and an entry it doesn\'t list as unclassified, which is kept and reported (Darren, point 4)', () => {
    expect(classify('claude', '.credentials.json')).toBe('sign-in')
    expect(classify('codex', 'auth.json')).toBe('sign-in')
    expect(classify('claude', 'projects')).toBe('clear')
    expect(classify('claude', '.claude.json.tmp.99.x')).toBe('clear')
    expect(classify('codex', 'state_5.sqlite-wal')).toBe('clear')
    expect(classify('codex', 'packages')).toBe('keep')
    // A new CLI version's new database: not cleared by a pattern.
    expect(classify('codex', 'state_6.sqlite')).toBe('unclassified')
    expect(UNCLASSIFIED).toBe('keep-and-report')
  })

  it('classifies every entry of the recorded homes of the CLI versions it was checked against (tests/fixtures/testHomes)', () => {
    const dir = join(__dirname, 'fixtures', 'testHomes')
    for (const file of readdirSync(dir)) {
      const cli = file.split('-')[0]
      const names = readFileSync(join(dir, file), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.replace(/<[^>]+>/g, 'x'))
      expect(names.length, file).toBeGreaterThan(10)
      expect(names.filter((nm) => classify(cli, nm) === 'unclassified'), file).toEqual([])
      // The sign-in is among them, and named apart.
      expect(names.some((nm) => classify(cli, nm) === 'sign-in'), file).toBe(true)
    }
  })
})

describe('freshenHome (HI-2606)', () => {
  it("Claude Code: clears memory, transcripts, trust, history and leftovers; keeps the sign-in byte for byte, its account fields, and what isn't classified", async () => {
    const home = claudeHome()
    const cred = statSync(join(home, '.credentials.json'))
    const r = await freshenHome('claude', home, deps(['in', 'in']))
    expect(readFileSync(join(home, '.credentials.json'), 'utf8')).toBe(CREDENTIALS)
    expect(statSync(join(home, '.credentials.json')).mtimeMs).toBe(cred.mtimeMs)
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual({ oauthAccount: { emailAddress: 'test@example.invalid' }, userID: 'u', hasCompletedOnboarding: true, opusProMigrationComplete: true })
    for (const gone of ['projects', 'history.jsonl', '.claude.json.tmp.1234.abcd', MARKER]) expect(existsSync(join(home, gone)), gone).toBe(false)
    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(readFileSync(join(home, 'mystery.db'), 'utf8')).toBe('unknown')
    expect(r.unclassified).toEqual(['mystery.db'])
    expect(freshenedLine('claude', r)).toMatch(/kept, not classified in testHomeManifest\.mjs: mystery\.db/)
    // The old .claude.json set aside, never a credential.
    expect(JSON.parse(readFileSync(join(home, '.reset-backup', '.claude.json'), 'utf8')).projects).toBeTruthy()
    expect(existsSync(join(home, '.reset-backup', '.credentials.json'))).toBe(false)
  })

  it("Codex: clears sessions, history and its databases; config.toml keeps only the sandbox and onboarding tables (no trust, no stray MCP server); auth and packages stay", async () => {
    const home = codexHome()
    await freshenHome('codex', home, deps(['in', 'in']))
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe(AUTH)
    const config = readFileSync(join(home, 'config.toml'), 'utf8')
    expect(config).toMatch(/\[windows\]/)
    expect(config).toMatch(/screen_reader_detection_done/)
    expect(config).not.toMatch(/projects|trust_level|mcp_servers|userfake/)
    for (const gone of ['sessions', 'state_5.sqlite', 'state_5.sqlite-wal', 'memories_1.sqlite', 'history.jsonl']) expect(existsSync(join(home, gone)), gone).toBe(false)
    expect(readFileSync(join(home, 'packages', '0.163.0', 'codex.exe'), 'utf8')).toBe('binary')
  })

  it('does nothing while the CLI is signed out (a skip for the environment) or its status can\'t be read (the run stops)', async () => {
    for (const [answer, kind] of [['out', 'signedOut'], ['unknown', 'unknown']] as const) {
      const home = claudeHome()
      const err = await freshenHome('claude', home, deps([answer])).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HomeNotReady)
      expect((err as { kind: string }).kind).toBe(kind)
      expect(existsSync(join(home, 'projects'))).toBe(true)
      expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).projects).toBeTruthy()
    }
  })

  it("never puts back a credential: one the status command refreshed stays refreshed when the check after fails or can't be read", async () => {
    const home = claudeHome()
    const refreshed = '{"claudeAiOauth":{"accessToken":"fake-access-2","refreshToken":"fake-refresh-2"}}'
    let calls = 0
    const st = async () => {
      calls++
      if (calls === 2) writeFileSync(join(home, '.credentials.json'), refreshed)
      return calls === 1 ? 'in' : 'unknown'
    }
    const err = await freshenHome('claude', home, { status: st, users: async () => [], waitMs: 0 }).catch((e: unknown) => e)
    expect((err as { kind: string }).kind).toBe('unknown')
    expect(readFileSync(join(home, '.credentials.json'), 'utf8')).toBe(refreshed)
  })

  it('signed out after the reset: only .claude.json is put back, and the run stops either way, saying which', async () => {
    // Back in once .claude.json is back: the kept fields miss one, said so.
    const a = claudeHome()
    const e1 = await freshenHome('claude', a, deps(['in', 'out', 'in'])).catch((e: unknown) => e)
    expect((e1 as Error).message).toMatch(/kept fields .* miss one it needs/)
    expect(JSON.parse(readFileSync(join(a, '.claude.json'), 'utf8')).projects).toBeTruthy()
    expect(readFileSync(join(a, '.credentials.json'), 'utf8')).toBe(CREDENTIALS)
    // Still out: signed out, its sign-in never touched.
    const b = claudeHome()
    const e2 = await freshenHome('claude', b, deps(['in', 'out', 'out'])).catch((e: unknown) => e)
    expect((e2 as { kind: string }).kind).toBe('signedOut')
    expect(readFileSync(join(b, '.credentials.json'), 'utf8')).toBe(CREDENTIALS)
  })

  it('waits for a home still in use, then refuses, naming who, ending nothing; resets once it is free', async () => {
    const busy = claudeHome()
    const err = await freshenHome('claude', busy, deps(['in', 'in'], { users: async () => ['claude.exe (pid 4242)'], waitMs: 20, pollMs: 5 })).catch((e: unknown) => e)
    expect((err as { kind: string }).kind).toBe('busy')
    expect((err as Error).message).toMatch(/pid 4242.*nothing was ended/)
    expect(existsSync(join(busy, 'projects'))).toBe(true)
    let left = 2
    const freed = claudeHome()
    await freshenHome('claude', freed, deps(['in', 'in'], { users: async () => (left-- > 0 ? ['codex.exe (pid 1)'] : []), waitMs: 5000, pollMs: 1 }))
    expect(existsSync(join(freed, 'projects'))).toBe(false)
  })

  it('only resets a home under the test root, never a user\'s own, and removes a link inside it as a link', async () => {
    expect(() => assertTestHome(join(process.env.USERPROFILE || homedir(), '.claude'))).toThrow(/user's own CLI home|isn't there/)
    const outside = join(tmp, `outside-${++n}`)
    mkdirSync(outside, { recursive: true })
    expect(() => assertTestHome(outside, join(tmp, 'elsewhere'))).toThrow(/isn't under the test root/)
    // A junction named like state, to a folder outside the home: the link goes, its target's files stay.
    const home = claudeHome()
    writeFileSync(join(outside, 'precious.txt'), 'keep me')
    rmSync(join(home, 'projects'), { recursive: true, force: true })
    symlinkSync(outside, join(home, 'projects'), 'junction')
    await freshenHome('claude', home, deps(['in', 'in']))
    expect(existsSync(join(home, 'projects'))).toBe(false)
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep me')
  })

  it('finishes a reset an earlier one left half done (its marker)', async () => {
    const home = claudeHome()
    writeFileSync(join(home, MARKER), '{}')
    const r = await freshenHome('claude', home, deps(['in', 'in']))
    expect(r.finishedInterrupted).toBe(true)
    expect(existsSync(join(home, MARKER))).toBe(false)
    expect(existsSync(join(home, 'projects'))).toBe(false)
  })
})

describe('the test homes\' leases (testHomeLock.mjs)', () => {
  const pool = (): string => join(tmp, `locks-${++n}`)

  it("knows which homes a suite uses: Claude Code's signed-in one, Codex's", () => {
    expect(homesOf({ claudeHome: 'test', needs: ['claude', 'codex'] })).toEqual(['claude', 'codex'])
    expect(homesOf({ claudeHome: 'own', needs: ['claude'] })).toEqual([])
    expect(homesOf({ codexHome: 'test' })).toEqual(['codex'])
  })

  it("is taken Claude Code's first: asking for it while Codex's is held is refused", async () => {
    const p = pool()
    const codex = await acquireTestHome('codex', join(tmp, 'cx'), { poolRoot: p, wait: false, alive: () => true })
    try {
      await expect(acquireTestHome('claude', join(tmp, 'cl'), { poolRoot: p, wait: false, alive: () => true })).rejects.toThrow(/order claude, then codex/)
    } finally {
      codex.release()
    }
    const claude = await acquireTestHome('claude', join(tmp, 'cl'), { poolRoot: p, wait: false, alive: () => true })
    const codex2 = await acquireTestHome('codex', join(tmp, 'cx'), { poolRoot: p, wait: false, alive: () => true })
    codex2.release()
    claude.release()
  })

  it('is reused by a child its holder passed it to, never taken again there; the holder\'s own environment is left alone', async () => {
    const p = pool()
    const held = await acquireTestHome('codex', join(tmp, 'cx2'), { poolRoot: p, wait: false, alive: () => true })
    try {
      expect(process.env[LEASES_VAR]).toBeUndefined()
      const env = leasesEnv([held], {})
      const child = await acquireTestHome('codex', join(tmp, 'cx2'), { poolRoot: p, wait: false, env })
      expect(child.reused).toBe(true)
      child.release()
    } finally {
      held.release()
    }
  })
})
