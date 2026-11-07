import { spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { tempDir } from './tempDir'
// @ts-expect-error: plain .mjs module without types
import { assertTestHome, freshenHome, freshenedLine, homeUsers, HomeNotReady, MARKER, signInStatus } from './e2e/testHomes.mjs'
// @ts-expect-error: plain .mjs module without types
import { classify, UNCLASSIFIED } from './e2e/testHomeManifest.mjs'
// @ts-expect-error: plain .mjs module without types
import { acquireTestHome, holderLiveFor, holderOf, homesOf, leasesEnv, LEASES_VAR, MAX_CONSUMERS, noteConsumers } from './e2e/testHomeLock.mjs'

// The CLI test homes start each run fresh, keeping only the sign-in (HI-2606, design s17 with Darren's answers): fake
// homes with known bytes, the CLIs' sign-in status scripted, nothing real read or signed in.

const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs')
const tmp = tempDir('cw-test-homes-')
/** A process list in which this process is the holder, started at HOLDER_STARTED (its acquisitions pass ownerStarted). */
const HOLDER_STARTED = 5_000_000
const asHolder = () => [{ pid: process.pid, parent: 1, started: HOLDER_STARTED, commandLine: 'node.exe vitest' }]
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
    const held = await acquireTestHome('codex', join(tmp, 'cx2'), { poolRoot: p, wait: false, alive: () => true, ownerStarted: HOLDER_STARTED })
    try {
      expect(process.env[LEASES_VAR]).toBeUndefined()
      const env = leasesEnv([held], {})
      const child = await acquireTestHome('codex', join(tmp, 'cx2'), { poolRoot: p, wait: false, env, processes: asHolder })
      expect(child.reused).toBe(true)
      child.release()
    } finally {
      held.release()
    }
  })
})

describe('HR1 on s17: who uses a home, and putting back only what the reset wrote', () => {
  const lockPool = (): string => join(tmp, `locks-hr1-${++n}`)
  // processes() rows: { pid, parent, started, commandLine }.
  const row = (pid: number, parent: number, started: number, commandLine: string) => ({ pid, parent, started, commandLine })

  it("counts what used the home under the lease and every CLI it started (a home told only by its environment too), never another home's", async () => {
    const p = lockPool()
    const lease = await acquireTestHome('claude', join(tmp, 'clh'), { poolRoot: p, wait: false, alive: () => true })
    try {
      // A suite's test copy of Combwork (consumer 500) started a Claude Code (its home only in CLAUDE_CONFIG_DIR) and a
      // node shim; another lane's copy (900) runs its own Claude Code in another home.
      noteConsumers(lease, [{ pid: 500, started: 1000 }])
      const list = [row(500, 1, 1000, '"C:/out/electron.exe" C:/work/main'), row(501, 500, 1500, '"C:/Users/x/.local/bin/claude.exe" --session-id s'), row(502, 501, 1600, 'node.exe cw-mcp.js'), row(900, 1, 1000, 'electron.exe other'), row(901, 900, 1100, 'claude.exe --session-id other')]
      const users = homeUsers('claude', join(tmp, 'clh'), { lease, processes: () => list })
      expect(users.join(' | ')).toMatch(/pid 500/)
      expect(users.join(' | ')).toMatch(/claude\.exe \(pid 501/)
      expect(users.join(' | ')).toMatch(/node\.exe \(pid 502/)
      expect(users.join(' | ')).not.toMatch(/90[01]/)
      // Ended, and nothing it started left: nobody.
      expect(homeUsers('claude', join(tmp, 'clh'), { lease, processes: () => [list[3], list[4]] })).toEqual([])
      // A process list that can't be read is no evidence of nobody.
      expect(homeUsers('claude', join(tmp, 'clh'), { lease, processes: () => null })[0]).toMatch(/process list/)
    } finally {
      lease.release()
    }
  })

  it('after taking over from a holder that did not let go, counts what that holder and its consumers left', async () => {
    const p = lockPool()
    const home = join(tmp, 'clh2')
    // A holder (pid 700) that ended without letting go: its record is left.
    const first = await acquireTestHome('claude', home, { poolRoot: p, wait: false, owner: 700, alive: () => true })
    noteConsumers(first, [{ pid: 710, started: 2000 }])
    const second = await acquireTestHome('claude', home, { poolRoot: p, wait: false, owner: 701, alive: (pid: number) => pid !== 700 })
    try {
      expect(second.takeover).toMatchObject({ pid: 700 })
      // What it noted, and itself, stay as consumers until a reset proves them gone.
      expect(holderOf(second.dir).consumers).toEqual(expect.arrayContaining([{ pid: 710, started: 2000 }, expect.objectContaining({ pid: 700 })]))
      // The dead consumer's orphaned Claude Code (its parent field still 710) is a user.
      const users = homeUsers('claude', home, { lease: second, processes: () => [row(711, 710, 2500, 'claude.exe --resume x')] })
      expect(users.join()).toMatch(/claude\.exe \(pid 711/)
    } finally {
      second.release()
    }
  })

  it("reuses an inherited lease only while its holder still holds it, and a reused lease never resets", async () => {
    const p = lockPool()
    const home = join(tmp, 'clh3')
    const held = await acquireTestHome('claude', home, { poolRoot: p, wait: false, alive: () => true, ownerStarted: HOLDER_STARTED })
    const env = leasesEnv([held], {})
    const reused = await acquireTestHome('claude', home, { poolRoot: p, wait: false, env, alive: () => true, processes: asHolder })
    expect(reused.reused).toBe(true)
    const h = claudeHome()
    await expect(freshenHome('claude', h, { ...deps(['in', 'in']), lease: reused })).rejects.toThrow(/held by a parent run/)
    expect(existsSync(join(h, 'projects'))).toBe(true)
    held.release()
    // Stale: the parent let it go; the token is taken for nothing.
    const fresh = await acquireTestHome('claude', home, { poolRoot: p, wait: false, env, alive: () => true, processes: asHolder })
    expect(fresh.reused).toBeUndefined()
    fresh.release()
  })

  it(".claude.json is put back only while its bytes are exactly what the reset wrote: a status command's same-sized write stays", async () => {
    const home = claudeHome()
    let calls = 0
    const st = async () => {
      calls++
      if (calls === 2) {
        // The status command rewrites .claude.json with account data of the same size.
        const now = readFileSync(join(home, '.claude.json'), 'utf8')
        writeFileSync(join(home, '.claude.json'), now.replace('"u"', '"v"'))
      }
      return calls === 1 ? 'in' : 'out'
    }
    const err = await freshenHome('claude', home, { status: st, users: async () => [], waitMs: 0 }).catch((e: unknown) => e)
    expect((err as { kind: string }).kind).toBe('signedOut')
    const kept = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(kept.userID).toBe('v')
    expect(kept.projects).toBeUndefined()
  })

  it('a reset left half done is done again whole, never putting an old copy back over what the CLI wrote since', async () => {
    const home = claudeHome()
    mkdirSync(join(home, '.reset-backup'), { recursive: true })
    writeFileSync(join(home, '.reset-backup', '.claude.json'), '{"userID":"old","projects":{"stale":{}}}')
    writeFileSync(join(home, MARKER), '{}')
    await freshenHome('claude', home, deps(['in', 'in']))
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).userID).toBe('u')
  })
})

describe('HR1 on s29: consumers noted before use, kept until a reset proves them gone; tokens bound to one acquisition', () => {
  const lockPool = (): string => join(tmp, `locks-s29-${++n}`)
  // A CLI that knows its home only from its environment: node, given nothing on its command line about the home.
  const SLEEP = 'setInterval(() => {}, 1000)'
  const spawned: number[] = []
  afterAll(() => {
    for (const pid of spawned) {
      try {
        process.kill(pid)
      } catch {
        // Gone already.
      }
    }
  })
  /** A parent that starts a detached CLI stand-in (its home only in its environment) and exits: the child's pid. */
  const orphanFrom = (parentOut: string): { parent: { pid: number; started: number }; child: () => number } => {
    const started = Date.now()
    const childEnv = ctx.childEnv({ CLAUDE_CONFIG_DIR: 'x' })
    const parent = spawn(process.execPath, ['-e', `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(SLEEP)}], { detached: true, stdio: 'ignore', env: ${JSON.stringify(childEnv)} }); c.unref(); require('fs').writeFileSync(${JSON.stringify(parentOut)}, String(c.pid))`], { stdio: 'ignore', env: ctx.childEnv({}) })
    return { parent: { pid: parent.pid!, started }, child: () => Number(readFileSync(parentOut, 'utf8')) }
  }
  const waitFor = async (fn: () => boolean): Promise<void> => {
    const until = Date.now() + 20000
    while (!fn() && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  }

  it('a suite that left a CLI behind keeps the home from being reset after its lease is let go, until that CLI ends', async () => {
    const p = lockPool()
    const lockHome = join(tmp, `life-${n}`)
    const first = await acquireTestHome('claude', lockHome, { poolRoot: p, wait: false, alive: () => true })
    const out = join(tmp, `child-${n}.txt`)
    const { parent, child } = orphanFrom(out)
    // Noted as the runner notes a suite: as soon as it is spawned.
    noteConsumers(first, [parent])
    await waitFor(() => existsSync(out) && Number(readFileSync(out, 'utf8')) > 0)
    const orphan = child()
    spawned.push(orphan)
    // The suite (its parent) ends; the lease is let go as normal.
    await waitFor(() => {
      try {
        process.kill(parent.pid, 0)
        return false
      } catch {
        return true
      }
    })
    first.release()
    const second = await acquireTestHome('claude', lockHome, { poolRoot: p, wait: false, alive: () => true })
    try {
      const h = claudeHome()
      const err = await freshenHome('claude', h, { status: async () => 'in', lease: second, waitMs: 0 }).catch((e: unknown) => e)
      expect((err as { kind: string }).kind).toBe('busy')
      expect((err as Error).message).toMatch(new RegExp(`pid ${orphan}`))
      expect(existsSync(join(h, 'projects'))).toBe(true)
      // Ended: proven gone, the reset goes ahead and lets the consumer go.
      process.kill(orphan)
      await waitFor(() => {
        try {
          process.kill(orphan, 0)
          return false
        } catch {
          return true
        }
      })
      await freshenHome('claude', h, { status: async () => 'in', lease: second, waitMs: 0 })
      expect(existsSync(join(h, 'projects'))).toBe(false)
      expect(holderOf(second.dir).consumers).toEqual([])
    } finally {
      second.release()
    }
  }, 60000)

  it('a runner that ended without letting go leaves its holder as a consumer; a CLI naming the registered suite folder counts, whatever its parent chain', async () => {
    const p = lockPool()
    const lockHome = join(tmp, `life-${n}`)
    const suite = join(tmp, `suite-${n}`)
    mkdirSync(suite, { recursive: true })
    const crashed = await acquireTestHome('claude', lockHome, { poolRoot: p, wait: false, owner: 4321, alive: () => true })
    // Registered before the suite started; the runner then crashed (no release).
    noteConsumers(crashed, [{ folder: suite }])
    // A CLI whose own parent is long gone, launched with a path in the suite's folder (as Combwork passes --settings).
    const cli = spawn(process.execPath, ['-e', SLEEP, join(suite, 'profile', 'settings.json')], { detached: true, stdio: 'ignore', env: ctx.childEnv({}) })
    spawned.push(cli.pid!)
    const next = await acquireTestHome('claude', lockHome, { poolRoot: p, wait: false, alive: (pid: number) => pid !== 4321 })
    try {
      expect(next.takeover).toMatchObject({ pid: 4321 })
      const err = await freshenHome('claude', claudeHome(), { status: async () => 'in', lease: next, waitMs: 0 }).catch((e: unknown) => e)
      expect((err as Error).message).toMatch(new RegExp(`pid ${cli.pid}.*naming`))
    } finally {
      process.kill(cli.pid!)
      next.release()
    }
  }, 60000)

  it("an old run's token isn't reused while another acquisition holds the same home, nor one whose holder pid was reused", async () => {
    const p = lockPool()
    const lockHome = join(tmp, `life-${n}`)
    const old = await acquireTestHome('claude', lockHome, { poolRoot: p, wait: false, alive: () => true })
    const oldEnv = leasesEnv([old], {})
    old.release()
    const now = await acquireTestHome('claude', lockHome, { poolRoot: p, wait: false, alive: () => true, ownerStarted: HOLDER_STARTED })
    try {
      // The new holder is alive in the same folder; the old token's generation is another's.
      const viaOld = await acquireTestHome('claude', lockHome, { poolRoot: p, wait: false, env: oldEnv, alive: () => true, owner: 999, processes: asHolder })
      expect(viaOld.reused).toBeUndefined()
      viaOld.release?.()
      // The current generation, but a holder start that isn't this holder's (its pid reused): not reused either.
      const token = JSON.parse(leasesEnv([now], {})[LEASES_VAR])
      token.claude.started -= 60000
      const reusedPid = await acquireTestHome('claude', lockHome, { poolRoot: p, wait: false, env: { [LEASES_VAR]: JSON.stringify(token) }, alive: () => true, owner: 998, processes: asHolder })
      expect(reusedPid.reused).toBeUndefined()
      reusedPid.release?.()
      // The exact acquisition: reused, and it can't reset.
      const exact = await acquireTestHome('claude', lockHome, { poolRoot: p, wait: false, env: leasesEnv([now], {}), alive: () => true, processes: asHolder })
      expect(exact.reused).toBe(true)
    } finally {
      now.release()
    }
  })
})

describe('HR2 on s34: reuse checks the live holder, nothing is evicted, an unreadable ledger is never taken for empty', () => {
  const lockPool = (): string => join(tmp, `locks-s34-${++n}`)
  const holder = { pid: 300, started: 1000, gen: 'g' }

  it('reuses only for the recorded holder alive as recorded, or a process it started', () => {
    // The holder itself, as recorded.
    expect(holderLiveFor(holder, 300, [{ pid: 300, parent: 1, started: 1000 }])).toBe(true)
    // The same pid, unchanged token and state, but another process now (its actual start differs): no.
    expect(holderLiveFor(holder, 300, [{ pid: 300, parent: 1, started: 999_999 }])).toBe(false)
    // An unrelated live process with the current token: no.
    expect(holderLiveFor(holder, 400, [{ pid: 300, parent: 1, started: 1000 }, { pid: 400, parent: 1, started: 2000 }])).toBe(false)
    // A grandchild of the holder (a suite's nested runner): yes.
    expect(holderLiveFor(holder, 402, [{ pid: 300, parent: 1, started: 1000 }, { pid: 401, parent: 300, started: 1500 }, { pid: 402, parent: 401, started: 1600 }])).toBe(true)
    // A "child" started before its parent id's holder: a reused parent id, so no.
    expect(holderLiveFor(holder, 401, [{ pid: 300, parent: 1, started: 1000 }, { pid: 401, parent: 300, started: 500 }])).toBe(false)
    // No process list: no.
    expect(holderLiveFor(holder, 300, null)).toBe(false)
  })

  it('keeps every consumer no reset has checked, across releases, past any count a run reaches; refuses one past the bound rather than drop one', async () => {
    const p = lockPool()
    const lockHome = join(tmp, `cap-${n}`)
    const first = await acquireTestHome('claude', lockHome, { poolRoot: p, wait: false, alive: () => true })
    noteConsumers(first, [{ pid: 777, started: 7000 }])
    first.release()
    // Warm runs register many more without a reset: well past the 200 the earlier ledger kept.
    for (let k = 0; k < 3; k++) {
      const l = await acquireTestHome('claude', lockHome, { poolRoot: p, wait: false, alive: () => true })
      noteConsumers(l, Array.from({ length: 150 }, (_, i) => ({ pid: 10_000 + k * 1000 + i, started: 9000 })))
      l.release()
    }
    const next = await acquireTestHome('claude', lockHome, { poolRoot: p, wait: false, alive: () => true })
    try {
      expect(holderOf(next.dir).consumers).toContainEqual({ pid: 777, started: 7000 })
      // The first one still running: the reset stays blocked.
      const users = homeUsers('claude', lockHome, { lease: next, processes: () => [{ pid: 777, parent: 1, started: 7000, commandLine: 'claude.exe' }] })
      expect(users.join()).toMatch(/pid 777/)
      expect(() => noteConsumers(next, Array.from({ length: MAX_CONSUMERS }, (_, i) => ({ pid: 90_000 + i, started: 9000 })))).toThrow(/run once without --warm-homes/)
      expect(holderOf(next.dir).consumers).toContainEqual({ pid: 777, started: 7000 })
    } finally {
      next.release()
    }
  })

  for (const [what, write] of [
    ['cut short', (f: string) => writeFileSync(f, '{"holder":null,"consumers":[{"pid":5')],
    ['with consumers that are not identities', (f: string) => writeFileSync(f, JSON.stringify({ holder: null, consumers: [{ pid: 'x' }] }))],
    ['not a state at all', (f: string) => writeFileSync(f, '[]')],
    ['unreadable (a folder in its place)', (f: string) => mkdirSync(f, { recursive: true })]
  ] as const) {
    it(`a lease state ${what} is left as it is, and no reset runs under it, saying what to do`, async () => {
      const p = lockPool()
      const lockHome = join(tmp, `bad-${n}`)
      const first = await acquireTestHome('claude', lockHome, { poolRoot: p, wait: false, alive: () => true })
      const file = join(first.dir, 'holder.state')
      first.release()
      rmSync(file, { recursive: true, force: true })
      write(file)
      const before = existsSync(file) && !statSync(file).isDirectory() ? readFileSync(file, 'utf8') : null
      const next = await acquireTestHome('claude', lockHome, { poolRoot: p, wait: false, alive: () => true })
      try {
        expect(next.stateUnknown).toBeTruthy()
        const h = claudeHome()
        const err = await freshenHome('claude', h, { ...deps(['in', 'in']), lease: next }).catch((e: unknown) => e)
        expect((err as { kind: string }).kind).toBe('unknown')
        expect((err as Error).message).toMatch(/end what is left, remove the file, and run again/)
        expect(existsSync(join(h, 'projects'))).toBe(true)
        noteConsumers(next, [{ pid: 1234, started: 1 }])
      } finally {
        next.release()
      }
      // Byte for byte as it was, after the acquisition, the refused reset, a registration and the release.
      if (before !== null) expect(readFileSync(file, 'utf8')).toBe(before)
      else expect(statSync(file).isDirectory()).toBe(true)
    })
  }
})

describe('signInStatus: what each CLI says of its sign-in', () => {
  it("reads Codex's answer from stderr too (0.166.0 says it there), and Claude Code's JSON", () => {
    const run = (r: { code: number; stdout?: string; stderr?: string } | null) => () => r
    expect(signInStatus('codex', 'h', { run: run({ code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' }) })).toBe('in')
    expect(signInStatus('codex', 'h', { run: run({ code: 1, stdout: '', stderr: 'Not logged in\n' }) })).toBe('out')
    expect(signInStatus('codex', 'h', { run: run({ code: 0, stdout: '', stderr: '' }) })).toBe('unknown')
    expect(signInStatus('codex', 'h', { run: run(null) })).toBe('unknown')
    expect(signInStatus('claude', 'h', { run: run({ code: 0, stdout: '{"loggedIn": true}' }) })).toBe('in')
    expect(signInStatus('claude', 'h', { run: run({ code: 1, stdout: '{"loggedIn": false}' }) })).toBe('out')
    expect(signInStatus('claude', 'h', { run: run({ code: 0, stdout: 'garbled' }) })).toBe('unknown')
  })
})
