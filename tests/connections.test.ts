// Launching on a connection (HI-1755): which connection a launch uses (resolveConnection), the test seam's bounds, the
// launch's outcomes (refused, noted, claimed and released), the safe-point switch's steps, and what is read from a
// connection's home instead of the CLI's own (memory, files). In this file's temp folders only: the CLI is never run
// (its status is faked) and nothing signs in.
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { resolveConnection } from '../src/shared/accounts'
import type { Connection, LiveSessionState } from '../src/shared/types'
import { ACCOUNTS_PREVIEW } from '../src/shared/advanced'
import { tempDir } from './tempDir'

const base = tempDir('hive-connections-')
const home = join(base, 'claude-home')
const userHome = join(base, 'user-profile')
process.env.HIVE_USER_DATA = join(base, 'profile')
process.env.CLAUDE_CONFIG_DIR = home
// No test seam here: the real rule (a test copy's own run context sets it; this file decides per test).
delete process.env.HIVE_TEST_CLI_HOME_CONNECTION
;(electron.app as unknown as { getPath: (n: string) => string }).getPath = (n: string) => (n === 'home' ? userHome : join(base, 'profile'))

const accounts = await import('../src/main/accounts')
const seam = await import('../src/main/connectionSeam')
const { config } = await import('../src/main/config')
const { advanced } = await import('../src/main/advanced')
const { provider } = await import('../src/main/providers')
const { providerService } = await import('../src/main/providerService')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { runSwitch } = await import('../src/main/connectionSwitch')
const { authScope } = await import('../src/main/sessions')
const { updateAgent } = await import('../src/main/projectAgents')
const { fileLockDepth, withFileLock } = await import('../src/main/fsutil')
const { listSkills, invalidateSkillCache } = await import('../src/main/skills')

const status = new Map<string, () => Promise<{ ok: true; loggedIn: boolean; email?: string; orgId?: string } | { ok: false; error: string }>>()
const signedIn = (email: string) => async () => ({ ok: true as const, loggedIn: true, email, orgId: 'org-1' })
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10_000
const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)

const wsPath = join(base, 'ws')
let w: ReturnType<typeof createWorkspaceService>
const here = <T>(fn: () => T): T => inWorkspace(w, fn)

beforeAll(async () => {
  advanced.load(join(base, 'profile'))
  await advanced.set(ACCOUNTS_PREVIEW, true)
  mkdirSync(join(home, 'projects'), { recursive: true })
  mkdirSync(join(userHome, '.claude'), { recursive: true })
  mkdirSync(join(wsPath, 'alpha', '.hive'), { recursive: true })
  writeFileSync(join(wsPath, 'alpha', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One' }] }))
  config.settings.providers['claude-code'].enabled = true
  providerService.info = ((id: string) => ({ provider: id, found: true, path: 'claude.exe' })) as never
  vi.spyOn(provider('claude-code'), 'accountStatus').mockImplementation(async (_exe, env) => {
    const s = [...status].find(([k]) => k.toLowerCase() === env.CLAUDE_CONFIG_DIR!.toLowerCase())?.[1]
    return s ? s() : { ok: true, loggedIn: false }
  })
  w = createWorkspaceService()
  await w.open(wsPath)
})
beforeEach(() => status.clear())
afterEach(async () => {
  for (const a of [...(config.get().connections ?? [])]) await accounts.removeAccount(a.id).catch(() => undefined)
  config.update((c) => {
    c.connections = []
    c.lastUsedConnection = {}
  })
  await w.saveWorkspaceConfigWith(() => ({ connections: undefined, assistantConnection: undefined }))
})

/** Adds a connection signed in as `email`, on here; the first one on becomes the default. */
async function signedInConnection(name: string, email: string): Promise<Connection> {
  const a = await accounts.addAccount('claude-code', name)
  status.set(accounts.accountFolder(a.id), signedIn(email))
  await accounts.checkAccount(a.id)
  accounts.keepNewLogin(a.id)
  await here(() => accounts.setAccountOn(a.id, true))
  return accounts.getAccount(a.id)!
}
const launch = (wanted?: string | null) => accounts.connectionForLaunch({ provider: 'claude-code', workspaceConfig: w.config, wanted, agentName: 'Builder' })

describe('which connection a launch uses (resolveConnection)', () => {
  const c = (id: string, p: Connection['provider'] = 'claude-code'): Connection => ({ id, provider: p, name: id, createdAt: '' })
  const all = [c('a'), c('b'), c('x', 'codex')]
  const cfg = { connections: { 'claude-code': { on: ['a'], default: 'a' } } }
  it('its own when on here; the default when it asks for none', () => {
    expect(resolveConnection(cfg, 'claude-code', 'a', all)).toEqual({ ok: true, id: 'a' })
    expect(resolveConnection(cfg, 'claude-code', undefined, all)).toEqual({ ok: true, id: 'a' })
  })
  it('its own off here: the same provider’s default, noted; no default: refused', () => {
    expect(resolveConnection(cfg, 'claude-code', 'b', all)).toEqual({ ok: true, id: 'a', note: 'offFallback' })
    expect(resolveConnection({ connections: { 'claude-code': { on: [], default: null } } }, 'claude-code', 'b', all)).toEqual({ ok: false, why: 'offNoDefault', wanted: 'b' })
  })
  it('gone, or another provider’s: refused, never another in its place; none at all: refused', () => {
    expect(resolveConnection(cfg, 'claude-code', 'gone', all)).toEqual({ ok: false, why: 'deleted', wanted: 'gone' })
    expect(resolveConnection(cfg, 'claude-code', 'x', all)).toEqual({ ok: false, why: 'otherProvider', wanted: 'x' })
    expect(resolveConnection({}, 'claude-code', undefined, all)).toEqual({ ok: false, why: 'none' })
  })
})

describe('the test seam (testHomeSeam)', () => {
  const env = (o: Record<string, string | undefined>) => ({ HIVE_USER_DATA: 'x', HIVE_TEST_CLI_HOME_CONNECTION: '1', CLAUDE_CONFIG_DIR: home, ...o })
  const user = join(userHome, '.claude')
  it('only for an unpackaged test copy given it and an explicit CLI test home', () => {
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({}), false, user)).toBe(true)
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({}), true, user)).toBe(false)
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({ HIVE_USER_DATA: undefined }), false, user)).toBe(false)
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({ HIVE_TEST_CLI_HOME_CONNECTION: '0' }), false, user)).toBe(false)
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({ CLAUDE_CONFIG_DIR: undefined }), false, user)).toBe(false)
  })
  it('never on the user’s own home, however it is spelt (a junction to it too)', () => {
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({ CLAUDE_CONFIG_DIR: user }), false, user)).toBe(false)
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({ CLAUDE_CONFIG_DIR: user.toUpperCase() + '\\' }), false, user)).toBe(false)
    const alias = join(base, 'alias-of-user-home')
    rmSync(alias, { force: true, recursive: true })
    symlinkSync(user, alias, 'junction')
    expect(seam.testHomeSeam('CLAUDE_CONFIG_DIR', env({ CLAUDE_CONFIG_DIR: alias }), false, user)).toBe(false)
  })
})

describe('a launch on a connection (connectionForLaunch)', () => {
  it('none on here: refused, never the CLI’s own home', async () => {
    expect(await outcome(launch())).toMatch(/No Claude Code connection is on in this workspace/)
  })

  it('with the seam on and none on here, the old launch (null: the CLI test home), and only then', async () => {
    process.env.HIVE_TEST_CLI_HOME_CONNECTION = '1'
    try {
      expect(await launch()).toBeNull()
      const a = await signedInConnection('Personal', 'me@example.com')
      const c = await launch()
      expect(c?.id).toBe(a.id)
      c?.release()
    } finally {
      delete process.env.HIVE_TEST_CLI_HOME_CONNECTION
    }
  })

  it('gives its folder as the home, claimed until released (removal refused meanwhile)', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const c = (await launch())!
    expect(c).toMatchObject({ id: a.id, name: 'Personal', folder: accounts.accountFolder(a.id), homeEnv: 'CLAUDE_CONFIG_DIR' })
    expect(c.note).toBeUndefined()
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/in use/)
    c.release()
    c.release()
    await accounts.removeAccount(a.id)
  })

  it('its own off here: the default, noted; its own gone or another provider’s: refused', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => accounts.setAccountOn(b.id, false))
    const c = (await launch(b.id))!
    expect(c).toMatchObject({ id: a.id, note: 'offFallback' })
    c.release()
    expect(await outcome(launch('gone'))).toMatch(/no longer exists/)
    config.update((x) => x.connections!.push({ id: 'x-codex', provider: 'codex', name: 'ChatGPT', createdAt: '' }))
    expect(await outcome(launch('x-codex'))).toMatch(/is for another CLI/)
  })

  it('signed out, or its login still changing: refused, and its claim released', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    status.set(accounts.accountFolder(a.id), async () => ({ ok: true, loggedIn: false }))
    expect(await outcome(launch())).toMatch(/Personal is signed out/)
    status.set(accounts.accountFolder(a.id), async () => {
      accounts.accountChanged(a.id)
      return { ok: true, loggedIn: true, email: 'me@example.com', orgId: 'org-1' }
    })
    expect(await outcome(launch())).toMatch(/kept changing/)
    // Nothing still holds it: removal goes ahead.
    await accounts.removeAccount(a.id)
  })

  it('its folder replaced by a link: refused before its check, never another home', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const folder = accounts.accountFolder(a.id)
    rmSync(join(folder, 'projects'))
    renameSync(folder, `${folder}-real`)
    symlinkSync(home, folder, 'junction')
    expect(await outcome(launch())).toMatch(/isn't the one Hive made/)
    rmSync(folder)
  })

  it('a check that couldn’t tell goes ahead, noted; a changed login goes ahead, noted', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    status.set(accounts.accountFolder(a.id), async () => ({ ok: false, error: 'timed out' }))
    const c1 = (await launch())!
    expect(c1.note).toBe('unknownLogin')
    c1.release()
    status.set(accounts.accountFolder(a.id), signedIn('other@example.com'))
    const c2 = (await launch())!
    expect(c2.note).toBe('loginChanged')
    c2.release()
  })

  it('stillValid: false once another connection is chosen meanwhile, or it is removed', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    const c = (await launch())!
    expect(c.id).toBe(a.id)
    expect(c.stillValid(undefined)).toBe(true)
    await here(() => accounts.setAccountDefault(b.id))
    expect(c.stillValid(undefined)).toBe(false)
    expect(c.stillValid(a.id)).toBe(true)
    // The launch was given the workspace's config as it was: a fresh resolve now picks Work.
    const fresh = await accounts.connectionForLaunch({ provider: 'claude-code', workspaceConfig: w.config, wanted: undefined, agentName: 'Builder' })
    expect(fresh?.id).toBe(b.id)
    fresh?.release()
    c.release()
  })
})

describe('what is read from a connection’s home', () => {
  it('user memory: each connection’s on here, never the CLI’s own home', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const homes = here(() => accounts.connectionHomes('claude-code', w.config))!
    expect(homes.map((h) => h.home)).toEqual([accounts.accountFolder(a.id)])
    const sources = await provider('claude-code').memorySources(wsPath, homes)
    const users = sources.filter((s) => s.id.startsWith('user'))
    expect(users.map((s) => s.path)).toEqual([join(accounts.accountFolder(a.id), 'CLAUDE.md')])
    expect(users[0].label).toContain('Personal')
  })

  it('files: a connection’s memory and skills allowed, never its login or settings, never another home', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const f = accounts.accountFolder(a.id)
    const allowed = (p: string, write = false) => provider('claude-code').fileAllowed(p, write, [f])
    expect(allowed(join(f, 'CLAUDE.md'))).toBe(true)
    expect(allowed(join(f, '.credentials.json'))).toBe(false)
    expect(allowed(join(f, 'settings.json'), true)).toBe(false)
    expect(allowed(join(home, 'CLAUDE.md'))).toBe(false)
  })

  it('its settings’ default model: the connection’s own', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    writeFileSync(join(accounts.accountFolder(a.id), 'settings.json'), JSON.stringify({ model: 'claude-own-model' }))
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'claude-home-model' }))
    expect(provider('claude-code').configuredDefaultModel(accounts.accountFolder(a.id))).toBe('claude-own-model')
  })
})

describe('sign-in, per connection (authScope)', () => {
  it('two connections’ agents are apart; a provider without one is its provider', () => {
    const st = (conn?: string): Pick<LiveSessionState, 'provider' | 'launchedConnection'> => ({ provider: 'claude-code', ...(conn ? { launchedConnection: { id: conn, name: conn } } : {}) })
    expect(authScope(st('a'))).toBe('claude-code:a')
    expect(authScope(st('b'))).not.toBe(authScope(st('a')))
    expect(authScope(st())).toBe('claude-code')
  })
})

describe('a switch at the next safe point (runSwitch)', () => {
  /** A fake agent: its turn, its quit's answers, its run, and the changes it sends. */
  function agent() {
    const looks = new Set<() => void>()
    const a = {
      held: 'it is in a turn' as string | null,
      running: true,
      quits: [] as string[],
      quitAnswer: 'sent' as 'sent' | 'held' | 'gone',
      resumes: 0,
      change: () => {
        for (const l of looks) l()
      }
    }
    const op = runSwitch({
      running: () => a.running,
      heldNow: () => a.held,
      quit: async () => {
        a.quits.push(a.quitAnswer)
        return a.quitAnswer
      },
      resume: async () => {
        a.resumes++
      },
      watch: (look) => {
        looks.add(look)
        return () => looks.delete(look)
      },
      log: () => undefined
    })
    return { a, op }
  }

  it('waits for its turn to be over; types its exit once; resumes once, only after that run exits', async () => {
    const { a, op } = agent()
    a.change()
    expect(a.quits).toEqual([])
    a.held = null
    a.change()
    await vi.waitFor(() => expect(a.quits).toEqual(['sent']), { timeout: HUNG_MS })
    a.change()
    a.change()
    expect(a.quits).toEqual(['sent'])
    expect(a.resumes).toBe(0)
    a.running = false
    a.change()
    expect(await op.done).toBe('resumed')
    a.change()
    expect(a.resumes).toBe(1)
  })

  it('a quit held (a draft, a prompt) typed nothing: asked again at the next change, still never twice once sent', async () => {
    const { a, op } = agent()
    a.held = null
    a.quitAnswer = 'held'
    a.change()
    await vi.waitFor(() => expect(a.quits).toEqual(['held']), { timeout: HUNG_MS })
    expect(op.typed).toBe(false)
    a.quitAnswer = 'sent'
    a.change()
    await vi.waitFor(() => expect(a.quits).toEqual(['held', 'sent']), { timeout: HUNG_MS })
    expect(op.typed).toBe(true)
    a.running = false
    a.change()
    expect(await op.done).toBe('resumed')
  })

  it('cancelled (stopped by hand, its workspace closing) before or after its exit: no resume', async () => {
    const first = agent()
    first.op.cancel('stopped')
    first.a.held = null
    first.a.change()
    expect(await first.op.done).toBe('cancelled')
    expect(first.a.quits).toEqual([])
    const second = agent()
    second.a.held = null
    second.a.change()
    await vi.waitFor(() => expect(second.op.typed).toBe(true), { timeout: HUNG_MS })
    second.op.cancel('its workspace closed')
    second.a.running = false
    second.a.change()
    expect(await second.op.done).toBe('cancelled')
    expect(second.a.resumes).toBe(0)
  })

  it('its run ended some other way before it was switched: nothing typed, nothing resumed', async () => {
    const { a, op } = agent()
    a.running = false
    a.change()
    expect(await op.done).toBe('gone')
    expect(a.quits).toEqual([])
    expect(a.resumes).toBe(0)
  })
})

describe('a choice saved while starting: the last look at its own choice, skills per workspace, the switch off', () => {
  const alpha = join(wsPath, 'alpha')
  const deferred = () => {
    let done!: () => void
    const p = new Promise<void>((r) => (done = r))
    return { p, done }
  }
  /** Agent One's connection as saved now, read as a launch reads it (under the lock its saves take). */
  const oneChose = () => w.savedAgent(alpha, 'a-one').then((a) => a?.connection)
  const assistantChose = async () => w.config.assistantConnection?.['claude-code']

  /**
   * A launch on `chosen` whose first `holds` runs wait, before their last look, until let go: `entered(i)` once run i
   * waits there, `go(i)` lets it on. What each run was prepared on, and what spawned (after the last look).
   */
  function heldRun(chosen: () => Promise<string | null | undefined>, holds = 1) {
    const at = Array.from({ length: holds }, deferred)
    const gates = Array.from({ length: holds }, deferred)
    const prepared: (string | null)[] = []
    const spawned: (string | null)[] = []
    const done = accounts.launchOnChosen({ provider: 'claude-code', workspaceConfig: w.config, agentName: 'One', chosen }, async (conn, lastLook) => {
      const i = prepared.push(conn?.id ?? null) - 1
      if (i < holds) {
        at[i].done()
        await gates[i].p
      }
      await lastLook()
      spawned.push(conn?.id ?? null)
    })
    // Settled here too, so a refusal a test expects isn't unhandled while it waits.
    done.catch(() => undefined)
    return { done, prepared, spawned, entered: (i: number) => at[i].p, go: (i: number) => gates[i].done() }
  }

  it("launch first, save second: the last look sees the new choice, the first claim is let go, and it starts on the new one", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => updateAgent(alpha, 'a-one', { connection: a.id }))
    const run = heldRun(oneChose)
    await run.entered(0)
    await here(() => updateAgent(alpha, 'a-one', { connection: b.id }))
    run.go(0)
    await run.done
    expect(run.prepared).toEqual([a.id, b.id])
    expect(run.spawned).toEqual([b.id])
    // Nothing still holds either (removal is refused while a launch's claim is held).
    expect(await outcome(accounts.removeAccount(a.id))).toBe('ok')
    expect(await outcome(accounts.removeAccount(b.id))).toBe('ok')
  })

  it('save first, launch second: a launch begun while the save waits on its lock reads the saved choice, never the old one', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => updateAgent(alpha, 'a-one', { connection: a.id }))
    // The project's lock held, so the save of Work waits on it (queued), not yet written.
    const file = join(alpha, '.hive', 'project.json')
    const lock = deferred()
    const holding = withFileLock(file, () => lock.p)
    const saving = here(() => updateAgent(alpha, 'a-one', { connection: b.id }))
    await vi.waitFor(() => expect(fileLockDepth(file)).toBe(2), { timeout: HUNG_MS })
    const run = heldRun(oneChose, 0)
    await vi.waitFor(() => expect(fileLockDepth(file)).toBe(3), { timeout: HUNG_MS })
    lock.done()
    await holding
    await saving
    await run.done
    expect(run.prepared).toEqual([b.id])
    expect(run.spawned).toEqual([b.id])
  })

  it("the Assistant's choice saved while it starts: it starts on the new one", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    const run = heldRun(assistantChose)
    await run.entered(0)
    await here(() => accounts.setAssistantConnection('claude-code', b.id))
    run.go(0)
    await run.done
    expect(run.prepared).toEqual([a.id, b.id])
    expect(run.spawned).toEqual([b.id])
  })

  it("others' saves never end it: the Assistant's here, and another workspace's agent, chosen meanwhile", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => updateAgent(alpha, 'a-one', { connection: a.id }))
    const ws2Path = join(base, 'ws-others')
    mkdirSync(join(ws2Path, 'beta', '.hive'), { recursive: true })
    writeFileSync(join(ws2Path, 'beta', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b-one', name: 'Beta One' }] }))
    const w2 = createWorkspaceService()
    await w2.open(ws2Path)
    try {
      await inWorkspace(w2, () => accounts.setAccountOn(b.id, true))
      const run = heldRun(oneChose)
      await run.entered(0)
      await here(() => accounts.setAssistantConnection('claude-code', b.id))
      await inWorkspace(w2, () => updateAgent(join(ws2Path, 'beta'), 'b-one', { connection: b.id }))
      run.go(0)
      await run.done
      expect(run.prepared).toEqual([a.id])
      expect(run.spawned).toEqual([a.id])
    } finally {
      await disposeWorkspaceService(w2)
    }
  })

  it('changed again while it starts once more: refused, saying so, both claims let go', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => updateAgent(alpha, 'a-one', { connection: a.id }))
    const run = heldRun(oneChose, 2)
    await run.entered(0)
    await here(() => updateAgent(alpha, 'a-one', { connection: b.id }))
    run.go(0)
    await run.entered(1)
    await here(() => updateAgent(alpha, 'a-one', { connection: a.id }))
    run.go(1)
    expect(await outcome(run.done)).toMatch(/changed again while it was starting/)
    expect(run.prepared).toEqual([a.id, b.id])
    expect(run.spawned).toEqual([])
    expect(await outcome(accounts.removeAccount(a.id))).toBe('ok')
    expect(await outcome(accounts.removeAccount(b.id))).toBe('ok')
  })

  it("machine skills: each workspace's own connections' only; a connection turned on shows its skills at once, the cache warm", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await accounts.addAccount('claude-code', 'Work')
    for (const [conn, name] of [[a, 'shared-skill'], [b, 'private-b'], [b, 'shared-skill']] as const) {
      const dir = join(accounts.accountFolder(conn.id), 'skills', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} of ${conn.name}\n---\n`)
    }
    // A second workspace with Work alone on.
    const ws2Path = join(base, 'ws2')
    mkdirSync(ws2Path, { recursive: true })
    const w2 = createWorkspaceService()
    await w2.open(ws2Path)
    try {
      await inWorkspace(w2, () => accounts.setAccountOn(b.id, true))
      invalidateSkillCache()
      const names = async (ws: typeof w) => (await inWorkspace(ws, () => listSkills())).filter((s) => s.level === 'machine').map((s) => s.path)
      const inA = await names(w)
      expect(inA.some((p) => p.includes('private-b'))).toBe(false)
      expect(inA.some((p) => p.startsWith(accounts.accountFolder(a.id)))).toBe(true)
      const inB = await names(w2)
      expect(inB.some((p) => p.includes('private-b'))).toBe(true)
      expect(inB.some((p) => p.startsWith(accounts.accountFolder(a.id)))).toBe(false)
      // Work turned on in the first workspace too: its skills there at once (no stale cache).
      await here(() => accounts.setAccountOn(b.id, true))
      expect((await names(w)).some((p) => p.includes('private-b'))).toBe(true)
    } finally {
      await disposeWorkspaceService(w2)
    }
  })

  it('the switch off: every action refused, nothing made, and the view checks nothing', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    await advanced.set(ACCOUNTS_PREVIEW, false)
    try {
      const before = (provider('claude-code').accountStatus as unknown as { mock: { calls: unknown[] } }).mock.calls.length
      expect(await outcome(accounts.addAccount('claude-code', 'No'))).toMatch(/Connections are a preview/)
      expect((config.get().connections ?? []).map((c) => c.name)).toEqual(['Personal'])
      for (const act of [() => Promise.resolve().then(() => accounts.renameAccount(a.id, 'X')), () => accounts.removeAccount(a.id), () => accounts.signInAccount(a.id), () => Promise.resolve().then(() => accounts.keepNewLogin(a.id)), () => here(() => accounts.setAccountOn(a.id, false)), () => here(() => accounts.setAccountDefault(a.id)), () => here(() => accounts.setAssistantConnection('claude-code', a.id)), () => accounts.claimAccount(a.id)])
        expect(await outcome(act())).toMatch(/Connections are a preview/)
      expect(here(() => accounts.accountsView(true))).toMatchObject({ preview: false, connections: [] })
      expect((provider('claude-code').accountStatus as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before)
      // And a launch takes the way before connections.
      expect(await launch()).toBeNull()
    } finally {
      await advanced.set(ACCOUNTS_PREVIEW, true)
    }
  })
})

afterAll(async () => {
  accounts.stopAccountWatches()
  advanced.stop()
  await disposeWorkspaceService(w)
})
