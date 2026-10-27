// Launching on a connection (HI-1755): which connection a launch uses (resolveConnection), the test seam's bounds, the
// launch's outcomes (refused, noted, claimed and released), the safe-point switch's steps, and what is read from a
// connection's home instead of the CLI's own (memory, files). HI-1769: what an agent's rows name (connectionOf), an
// agent's own choice checked with the write that saves it (Add Agent, Agent Settings), and templates' connections (the
// load dialog's flagged agents, inherited versus pinned, a stale choice, one agent added). HI-1770: model, effort and
// context from the connection (the resolver's layers, the Assistant's own), a project's own moved onto its agents once
// (kept explicit values, a launch waiting on the move, interrupted, a later CLI), the notice from the move's record
// (scoped to a workspace, dismissed for good) and connections' defaults (copied once, edited). HI-1771: a connection named
// in the Agent API (id, unique name, ambiguous, unknown), what each caller sees of them (never storage), and an agent's
// change of connection (kept, cleared, a change of CLI resetting what was the old one's, decided again under the lock).
// In this file's temp folders
// only: the CLI is never run (its status is faked) and nothing signs in.
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { connectionRef, connectionsFor, connectionShown, resolveConnection, type ConnectionsView } from '../src/shared/accounts'
import { connectionOf } from '../src/shared/connectionLabel'
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
const { authScope, sessions, LaunchReads } = await import('../src/main/sessions')
const moves = await import('../src/main/connectionMoves')
const { agentLaunchSettings, providerDescriptor } = await import('../src/shared/providers')
const { assistantOwn, cliDefaults, moveProjectOverrides } = await import('../src/shared/connectionDefaults')
const { addAgent, updateAgent } = await import('../src/main/projectAgents')
const templates = await import('../src/main/templates')
const { TEMPLATE_VERSION } = await import('../src/shared/templates')
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
  // A project templates are loaded into (HI-1769), its agents replaced each time.
  mkdirSync(join(wsPath, 'gamma', '.hive'), { recursive: true })
  writeFileSync(join(wsPath, 'gamma', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  // Projects whose own model, effort and context move onto their agents (HI-1770), each test its own.
  // A project whose agents change connection (HI-1771).
  mkdirSync(join(wsPath, 'api1', '.hive'), { recursive: true })
  writeFileSync(join(wsPath, 'api1', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'k', name: 'Api K', provider: 'claude-code', model: 'opus', effort: 'high', use200kContext: true, lastSessionId: 's-1' }] }))
  for (const name of ['mv1', 'mv2', 'mv3', 'mv4', 'mv5', 'mv6', 'mv7', 'mv8']) {
    mkdirSync(join(wsPath, name, '.hive'), { recursive: true })
    writeFileSync(join(wsPath, name, '.hive', 'project.json'), JSON.stringify({ version: 2, providers: { 'claude-code': { model: 'haiku', effort: 'high', permissionMode: 'inherit', extraArgs: '', use200kContext: 'on' }, codex: { model: 'gpt-5', effort: 'low', permissionMode: 'inherit', extraArgs: '', use200kContext: 'inherit' } }, agents: [{ id: 'own', name: `${name} Own`, provider: 'claude-code', model: 'opus', use200kContext: false }, { id: 'none', name: `${name} None`, provider: 'claude-code' }, { id: 'cx', name: `${name} Codex`, provider: 'codex' }] }))
  }
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

describe('what an agent row names (connectionOf, HI-1769)', () => {
  const c = (id: string, cli: Connection['provider'] = 'claude-code'): ConnectionsView['connections'][number] => ({ id, provider: cli, name: `Name ${id}`, createdAt: '', signingIn: false, folder: '' })
  const view = (over: Partial<ConnectionsView> = {}): ConnectionsView => ({ preview: true, providers: ['claude-code'], connections: [c('a'), c('b'), c('x', 'codex')], workspace: { 'claude-code': { on: ['a'], default: 'a' } }, testHome: [], ...over })
  const ran = (id: string) => ({ id, name: `Name ${id}` })
  it('its own on here; none of its own: the default, inherited', () => {
    expect(connectionOf('a', 'claude-code', undefined, view())).toMatchObject({ shown: { id: 'a' }, inherited: false, other: false, desired: { ok: true, id: 'a' } })
    expect(connectionOf(undefined, 'claude-code', undefined, view())).toMatchObject({ shown: { id: 'a', name: 'Name a' }, inherited: true, other: false })
  })
  it('its own off here: the default runs it, noted; off with no default: none shown, never made up', () => {
    expect(connectionOf('b', 'claude-code', undefined, view())).toMatchObject({ shown: { id: 'a' }, desired: { ok: true, id: 'a', note: 'offFallback' } })
    const none = view({ workspace: { 'claude-code': { on: [], default: null } } })
    expect(connectionOf('b', 'claude-code', undefined, none)).toMatchObject({ shown: null, desired: { ok: false, why: 'offNoDefault', wantedName: 'Name b' } })
    expect(connectionOf(undefined, 'claude-code', undefined, none)).toMatchObject({ shown: null, desired: { ok: false, why: 'none' } })
  })
  it('removed, or another CLI’s: unusable, shown as such', () => {
    expect(connectionOf('gone', 'claude-code', undefined, view())).toMatchObject({ shown: null, desired: { ok: false, why: 'deleted' } })
    expect(connectionOf('x', 'claude-code', undefined, view())).toMatchObject({ shown: null, desired: { ok: false, why: 'otherProvider', wantedName: 'Name x' } })
  })
  it('running: always the one it runs on; ⟳ when another is chosen now, or the choice is now unusable', () => {
    expect(connectionOf('a', 'claude-code', ran('a'), view())).toMatchObject({ shown: { id: 'a' }, other: false })
    expect(connectionOf(undefined, 'claude-code', ran('b'), view())).toMatchObject({ shown: { id: 'b', name: 'Name b' }, other: true, desired: { ok: true, id: 'a' } })
    expect(connectionOf('gone', 'claude-code', ran('a'), view())).toMatchObject({ shown: { id: 'a' }, other: true, desired: { ok: false, why: 'deleted' } })
    expect(connectionOf('x', 'claude-code', ran('a'), view())).toMatchObject({ shown: { id: 'a' }, other: true, desired: { ok: false, why: 'otherProvider' } })
  })
  it('nothing where connections aren’t shown: the preview off, a CLI without them, no view yet', () => {
    expect(connectionOf('a', 'claude-code', undefined, view({ preview: false }))).toBeNull()
    expect(connectionOf('x', 'codex', undefined, view())).toBeNull()
    expect(connectionOf('a', 'claude-code', undefined, null)).toBeNull()
  })
})

describe('an agent’s own connection, checked with the write that saves it (HI-1769)', () => {
  const alpha = join(wsPath, 'alpha')
  const projectJson = join(alpha, '.hive', 'project.json')
  const agentsOf = async (p: string) => (await w.projectConfig(p)).agents
  const deferred = () => {
    let done!: () => void
    const p = new Promise<void>((r) => (done = r))
    return { p, done }
  }

  it('Add Agent: one on here is kept; off, removed or another CLI’s is refused, saying why, and nothing is added', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await accounts.addAccount('claude-code', 'Work')
    const added = await here(() => addAgent(alpha, { name: 'On Personal', connection: a.id }))
    expect(added.connection).toBe(a.id)
    expect(await outcome(here(() => addAgent(alpha, { name: 'On Work', connection: b.id })))).toMatch(/Work isn't on in this workspace/)
    expect(await outcome(here(() => addAgent(alpha, { name: 'On Gone', connection: 'a-gone' })))).toMatch(/no longer exists/)
    config.update((c) => void (c.connections = (c.connections ?? []).map((x) => (x.id === b.id ? { ...x, provider: 'codex' } : x))))
    expect(await outcome(here(() => addAgent(alpha, { name: 'On Codex', connection: b.id })))).toMatch(/for another CLI/)
    expect((await agentsOf(alpha)).map((x) => x.name)).not.toEqual(expect.arrayContaining(['On Work', 'On Gone', 'On Codex']))
    await here(() => import('../src/main/projectAgents').then((m) => m.removeAgent(alpha, added.id, { deleteWorktree: false })))
  })

  it('Add Agent: a connection turned off while it waits on its write is refused then, nothing added', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    await signedInConnection('Work', 'work@example.com')
    const lock = deferred()
    const holding = withFileLock(projectJson, () => lock.p)
    const adding = here(() => addAgent(alpha, { name: 'Stale', connection: a.id }))
    await vi.waitFor(() => expect(fileLockDepth(projectJson)).toBe(2), { timeout: HUNG_MS })
    await here(() => accounts.setAccountOn(a.id, false))
    lock.done()
    await holding
    expect(await outcome(adding)).toMatch(/Personal isn't on in this workspace/)
    expect((await agentsOf(alpha)).some((x) => x.name === 'Stale')).toBe(false)
  })

  it('Agent Settings: a new choice off, removed or another CLI’s is refused; the one already saved may stay (off here); checked under the lock', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => updateAgent(alpha, 'a-one', { connection: b.id }))
    await here(() => accounts.setAccountOn(b.id, false))
    // Saved before it went off: saving the agent again keeps it (the default runs it meanwhile).
    expect((await here(() => updateAgent(alpha, 'a-one', { connection: b.id, role: 'kept' }))).connection).toBe(b.id)
    await here(() => updateAgent(alpha, 'a-one', { connection: null }))
    expect(await outcome(here(() => updateAgent(alpha, 'a-one', { connection: b.id })))).toMatch(/Work isn't on in this workspace/)
    expect(await outcome(here(() => updateAgent(alpha, 'a-one', { connection: 'a-gone' })))).toMatch(/no longer exists/)
    // On when asked, off by the time its write runs: refused then.
    const lock = deferred()
    const holding = withFileLock(projectJson, () => lock.p)
    const saving = here(() => updateAgent(alpha, 'a-one', { connection: a.id }))
    await vi.waitFor(() => expect(fileLockDepth(projectJson)).toBe(2), { timeout: HUNG_MS })
    await here(() => accounts.setAccountOn(a.id, false))
    lock.done()
    await holding
    expect(await outcome(saving)).toMatch(/Personal isn't on in this workspace/)
    expect((await agentsOf(alpha)).find((x) => x.id === 'a-one')?.connection).toBeUndefined()
    await here(() => updateAgent(alpha, 'a-one', { role: null as unknown as string }))
  })

  it('Agent Settings: the saved connection removed since, or now another CLI’s, is refused even unchanged', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    await here(() => updateAgent(alpha, 'a-one', { connection: a.id }))
    await accounts.removeAccount(a.id)
    expect(await outcome(here(() => updateAgent(alpha, 'a-one', { connection: a.id, role: 'unchanged choice' })))).toMatch(/no longer exists/)
    await here(() => updateAgent(alpha, 'a-one', { connection: b.id }))
    config.update((c) => void (c.connections = (c.connections ?? []).map((x) => (x.id === b.id ? { ...x, provider: 'codex' } : x))))
    expect(await outcome(here(() => updateAgent(alpha, 'a-one', { connection: b.id, role: 'unchanged choice' })))).toMatch(/for another CLI/)
    // Cleared, it saves (the default again).
    await here(() => updateAgent(alpha, 'a-one', { connection: null, role: null as unknown as string }))
  })
})

describe('templates’ connections (HI-1769)', () => {
  const gamma = join(wsPath, 'gamma')
  const tplDir = join(wsPath, '.hive', 'templates')
  /** A template: T1 on Personal (its id), T2 on a connection this machine never had, T3 on none of its own. */
  function writeTemplate(file: string, personal: string) {
    mkdirSync(tplDir, { recursive: true })
    writeFileSync(join(tplDir, file), JSON.stringify({ version: TEMPLATE_VERSION, name: file, savedAt: '', layout: 'auto', agents: [
      { name: 'T1', role: 'builder', provider: 'claude-code', connection: personal, connectionName: 'Personal' },
      { name: 'T2', role: 'reviewer', provider: 'claude-code', connection: 'a-elsewhere', connectionName: 'Max 2' },
      { name: 'T3', role: 'builder', provider: 'claude-code' }
    ] }))
  }
  const ids = async () => (await w.projectConfig(gamma)).agents.map((a) => a.id)
  const byName = async (n: string) => (await w.projectConfig(gamma)).agents.find((a) => a.name === n)
  const resolved = async (n: string) => resolveConnection(w.config, 'claude-code', (await byName(n))?.connection, config.get().connections ?? [])

  it("the plan flags only an explicit id that can't be used here (never one inherited), by its index, with its name for display", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    writeTemplate('flags.json', a.id)
    const plan = await here(() => templates.templatePlan(gamma, 'workspace', 'flags.json'))
    expect(plan.connections).toEqual([{ index: 1, id: 'a-elsewhere', name: 'Max 2', problem: 'missing' }])
    // Off here: flagged as off.
    await here(() => accounts.setAccountOn(a.id, false))
    await signedInConnection('Work', 'work@example.com')
    expect((await here(() => templates.templatePlan(gamma, 'workspace', 'flags.json'))).connections.map((c) => [c.index, c.problem])).toEqual([[0, 'off'], [1, 'missing']])
  })

  it('loaded with the default chosen: it inherits, and follows a later change of default; one pinned stays pinned', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await signedInConnection('Work', 'work@example.com')
    writeTemplate('inherit.json', a.id)
    const first = await ids()
    await here(() => templates.loadTemplate(gamma, 'workspace', 'inherit.json', first, undefined, undefined, { 1: null }))
    expect((await byName('T1'))?.connection).toBe(a.id)
    expect((await byName('T2'))?.connection).toBeUndefined()
    expect((await byName('T3'))?.connection).toBeUndefined()
    expect(await resolved('T2')).toEqual({ ok: true, id: a.id })
    await here(() => accounts.setAccountDefault(b.id))
    expect(await resolved('T2')).toEqual({ ok: true, id: b.id })
    expect(await resolved('T1')).toEqual({ ok: true, id: a.id })
    // Loaded again with Personal chosen for T2 itself: pinned, it stays on Personal whatever the default.
    const second = await ids()
    await here(() => templates.loadTemplate(gamma, 'workspace', 'inherit.json', second, undefined, undefined, { 1: a.id }))
    expect((await byName('T2'))?.connection).toBe(a.id)
    expect(await resolved('T2')).toEqual({ ok: true, id: a.id })
  })

  it("an answer for an index the plan didn't flag, or a choice that can't be used: refused, nothing changed", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const b = await accounts.addAccount('claude-code', 'Work')
    writeTemplate('stale.json', a.id)
    const before = await ids()
    expect(await outcome(here(async () => templates.loadTemplate(gamma, 'workspace', 'stale.json', before, undefined, undefined, { 0: a.id, 1: null })))).toMatch(/connections changed since you looked/)
    expect(await outcome(here(async () => templates.loadTemplate(gamma, 'workspace', 'stale.json', before, undefined, undefined, { 1: b.id })))).toMatch(/Work isn't on in this workspace/)
    expect(await ids()).toEqual(before)
  })

  it('a connection turned off after the dialog showed the plan: the load is refused, the project as it was', async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    await signedInConnection('Work', 'work@example.com')
    writeTemplate('later.json', a.id)
    const plan = await here(() => templates.templatePlan(gamma, 'workspace', 'later.json'))
    expect(plan.connections.map((c) => c.index)).toEqual([1])
    const before = await ids()
    await here(() => accounts.setAccountOn(a.id, false))
    // The dialog's answers are for its plan (index 1); T1's Personal went off since: flagged now, so refused.
    expect(await outcome(here(async () => templates.loadTemplate(gamma, 'workspace', 'later.json', before, undefined, undefined, { 1: null })))).toMatch(/connections changed since you looked/)
    expect(await ids()).toEqual(before)
  })

  it("one agent added from a template: its own where it can be used; else the default, and the reply says why", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    writeTemplate('one.json', a.id)
    const t1 = await here(() => templates.addAgentFromTemplate(gamma, 'workspace', 'one.json', 0, undefined, 'One T1'))
    expect(t1.connection).toBe(a.id)
    expect(t1.connectionFallback).toBeUndefined()
    const t2 = await here(() => templates.addAgentFromTemplate(gamma, 'workspace', 'one.json', 1, undefined, 'One T2'))
    expect(t2.connection).toBeUndefined()
    expect(t2.connectionFallback).toEqual({ name: 'Max 2', problem: 'missing' })
  })

  it("saved: each agent's connection named beside its id; with Connections off nothing is flagged and only one on here is kept", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    await here(() => updateAgent(join(wsPath, 'alpha'), 'a-one', { connection: a.id }))
    await here(() => templates.saveTemplate(join(wsPath, 'alpha'), 'workspace', 'Saved'))
    const saved = JSON.parse(readFileSync(join(tplDir, 'saved.json'), 'utf8'))
    expect(saved.agents[0]).toMatchObject({ connection: a.id, connectionName: 'Personal' })
    await here(() => updateAgent(join(wsPath, 'alpha'), 'a-one', { connection: null }))
    writeTemplate('off.json', a.id)
    await advanced.set(ACCOUNTS_PREVIEW, false)
    try {
      const plan = await here(() => templates.templatePlan(gamma, 'workspace', 'off.json'))
      expect(plan.connections).toEqual([])
    } finally {
      await advanced.set(ACCOUNTS_PREVIEW, true)
    }
  })
})

describe('model, effort and context from the connection (HI-1770)', () => {
  const settings = { defaultProvider: 'claude-code', providers: { 'claude-code': { defaultModel: 'sonnet', defaultEffort: 'medium', use200kContext: true } } } as never
  const cfg = { defaultProvider: 'inherit', providers: { 'claude-code': { model: 'haiku', effort: 'high', permissionMode: 'inherit', extraArgs: '--x', use200kContext: 'on' } } } as never
  const conn = { defaults: { model: 'opus', effort: 'low', use200kContext: false } }

  it('the resolver: legacy reads the project then the CLI; with a connection, its own then the connection’s, never the project’s or the CLI’s', () => {
    expect(agentLaunchSettings({ provider: 'claude-code' }, cfg, settings)).toMatchObject({ model: 'haiku', effort: 'high', use200kContext: true })
    expect(agentLaunchSettings({ provider: 'claude-code' }, cfg, settings, { kind: 'connection', conn })).toMatchObject({ model: 'opus', effort: 'low', use200kContext: false, extraArgs: ['--x'] })
    expect(agentLaunchSettings({ provider: 'claude-code', model: 'sonnet', use200kContext: true }, cfg, settings, { kind: 'connection', conn })).toMatchObject({ model: 'sonnet', effort: 'low', use200kContext: true })
    // None usable: the agent's own alone; an explicit false context kept.
    expect(agentLaunchSettings({ provider: 'claude-code', use200kContext: false }, cfg, settings, { kind: 'connection', conn: null })).toMatchObject({ model: null, effort: null, use200kContext: false })
    expect(agentLaunchSettings({ provider: 'claude-code' }, cfg, settings, { kind: 'connection', conn: { defaults: {} } })).toMatchObject({ model: null, effort: null, use200kContext: false })
  })

  it("the Assistant's own: its agent's, else Settings → Assistant's; its connection's after", () => {
    expect(assistantOwn({ model: undefined, use200kContext: undefined }, { model: 'haiku', effort: 'low', use200kContext: 'off' })).toMatchObject({ model: 'haiku', effort: 'low', use200kContext: false })
    expect(assistantOwn({ model: 'opus', use200kContext: true }, { model: 'haiku', effort: '', use200kContext: 'off' })).toMatchObject({ model: 'opus', use200kContext: true })
  })

  it("the move: only where an agent has none of its own (an explicit off kept), only its CLI's agents, once", () => {
    const project = { version: 2, providers: { 'claude-code': { model: 'haiku', effort: 'high', permissionMode: 'inherit', extraArgs: '', use200kContext: 'on' } }, agents: [{ id: 'own', name: 'Own', provider: 'claude-code', model: 'opus', use200kContext: false }, { id: 'none', name: 'None', provider: 'claude-code' }, { id: 'cx', name: 'Cx', provider: 'codex' }] } as never
    const r = moveProjectOverrides(project, 'claude-code', (a) => a.provider!, 'now')!
    expect(r.agents.find((a) => a.id === 'own')).toMatchObject({ model: 'opus', effort: 'high', use200kContext: false })
    expect(r.agents.find((a) => a.id === 'none')).toMatchObject({ model: 'haiku', effort: 'high', use200kContext: true })
    expect(r.agents.find((a) => a.id === 'cx')).toEqual({ id: 'cx', name: 'Cx', provider: 'codex' })
    expect(r.migrations?.connections1?.['claude-code']?.moved.map((m) => m.id).sort()).toEqual(['claude-code:none:effort', 'claude-code:none:model', 'claude-code:none:use200kContext', 'claude-code:own:effort'])
    expect(moveProjectOverrides({ ...(project as object), ...r } as never, 'claude-code', (a) => a.provider!, 'later')).toBeNull()
    // A project that set nothing gives nothing.
    const plain = moveProjectOverrides({ version: 2, agents: [{ id: 'n', name: 'N', provider: 'claude-code' }] } as never, 'claude-code', (a) => a.provider!, 'now')!
    expect(plain.agents[0]).toEqual({ id: 'n', name: 'N', provider: 'claude-code' })
    expect(plain.migrations?.connections1?.['claude-code']?.moved).toEqual([])
  })

  it('moved once in one write with its record; a second run changes nothing; a later CLI with connections moves its own', async () => {
    const p = join(wsPath, 'mv1')
    await here(() => moves.ensureMoved(p, 'claude-code'))
    const once = await w.projectConfig(p)
    expect(once.agents.find((a) => a.id === 'none')).toMatchObject({ model: 'haiku', effort: 'high', use200kContext: true })
    expect(once.agents.find((a) => a.id === 'cx')?.model).toBeUndefined()
    expect(Object.keys(once.migrations?.connections1 ?? {})).toEqual(['claude-code'])
    await here(() => moves.ensureMoved(p, 'claude-code'))
    expect(await w.projectConfig(p)).toEqual(once)
    // Codex given connections later (a stand-in): its own move, Claude Code's record untouched.
    const caps = providerDescriptor('codex').capabilities as { connections?: unknown }
    caps.connections = { homeEnv: 'CODEX_HOME', shared: [] }
    try {
      await here(() => moves.ensureMoved(p, 'codex'))
      const both = await w.projectConfig(p)
      expect(both.agents.find((a) => a.id === 'cx')).toMatchObject({ model: 'gpt-5', effort: 'low' })
      expect(both.migrations?.connections1?.['claude-code']).toEqual(once.migrations?.connections1?.['claude-code'])
    } finally {
      delete caps.connections
    }
  })

  it('interrupted before its write: nothing moved, nothing recorded, and the next run moves it', async () => {
    const p = join(wsPath, 'mv2')
    const spy = vi.spyOn(w, 'mutateProjectConfig').mockRejectedValueOnce(new Error('disk full'))
    try {
      expect(await outcome(here(() => moves.ensureMoved(p, 'claude-code')))).toMatch(/disk full/)
    } finally {
      spy.mockRestore()
    }
    const before = await w.projectConfig(p)
    expect(before.migrations).toBeUndefined()
    expect(before.agents.find((a) => a.id === 'none')?.model).toBeUndefined()
    await here(() => moves.ensureMoved(p, 'claude-code'))
    expect((await w.projectConfig(p)).agents.find((a) => a.id === 'none')?.model).toBe('haiku')
  })

  it("a launch waits on the move held on the project's lock, then starts with the agent's moved values", async () => {
    await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'mv3')
    const file = join(p, '.hive', 'project.json')
    let release!: () => void
    const held = withFileLock(file, () => new Promise<void>((r) => (release = r)))
    const agent = (await w.projectConfig(p)).agents.find((a) => a.id === 'none')!
    const eff = sessions.effective(p, agent)
    await vi.waitFor(() => expect(fileLockDepth(file)).toBe(2), { timeout: HUNG_MS })
    release()
    await held
    expect(await eff).toMatchObject({ model: 'haiku', effort: 'high', use200kContext: true })
    expect((await w.projectConfig(p)).migrations?.connections1?.['claude-code']).toBeTruthy()
  })

  it('a move another caller made after the launch read its agent: the agent as saved now is used, not the one read before', async () => {
    await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'mv7')
    const before = (await w.projectConfig(p)).agents.find((a) => a.id === 'none')!
    // The open's (or a toggle's) move completes first.
    await here(() => moves.ensureMoved(p, 'claude-code'))
    expect(await sessions.effective(p, before)).toMatchObject({ model: 'haiku', effort: 'high', use200kContext: true })
  })

  it('Connections turned on while a resolution reads the rest: it finishes on the layer it began with, consistently', async () => {
    await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'mv8')
    const agent = (await w.projectConfig(p)).agents.find((a) => a.id === 'none')!
    // Its servers' read held until let go.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let reading!: () => void
    const entered = new Promise<void>((r) => (reading = r))
    class HeldReads extends LaunchReads {
      override async servers() {
        reading()
        await gate
        return super.servers()
      }
    }
    await advanced.set(ACCOUNTS_PREVIEW, false)
    try {
      const eff = sessions.effective(p, agent, new HeldReads())
      await entered
      await advanced.set(ACCOUNTS_PREVIEW, true)
      release()
      // Begun before connections: the project's values, as before (never the connection layer with nothing moved).
      expect(await eff).toMatchObject({ model: 'haiku', effort: 'high', use200kContext: true, connection: null })
    } finally {
      await advanced.set(ACCOUNTS_PREVIEW, true)
    }
    // The next one, with connections: moved first, then the agent's own (moved) values.
    expect(await sessions.effective(p, agent)).toMatchObject({ model: 'haiku', effort: 'high', use200kContext: true })
    expect((await w.projectConfig(p)).migrations?.connections1?.['claude-code']).toBeTruthy()
  })

  it("a launch whose move fails is refused, saying so; the next one moves and starts", async () => {
    await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'mv4')
    const agent = (await w.projectConfig(p)).agents.find((a) => a.id === 'none')!
    const spy = vi.spyOn(w, 'mutateProjectConfig').mockRejectedValueOnce(new Error('locked by an editor'))
    try {
      expect(await outcome(sessions.effective(p, agent))).toMatch(/couldn't move mv4's model settings to its agents: locked by an editor/)
    } finally {
      spy.mockRestore()
    }
    expect(await sessions.effective(p, agent)).toMatchObject({ model: 'haiku' })
  })

  it("the notice: from the move's record (so a stop after the move loses nothing), this workspace's only, dismissed for good", async () => {
    await signedInConnection('Personal', 'me@example.com')
    // Haiku takes no effort here: the moved "high" is kept on the agent, not used, and listed.
    const info = providerService.info
    providerService.info = ((id: string) => ({ provider: id, found: true, path: 'claude.exe', catalog: { source: 'cli', version: '1', models: [{ value: 'haiku', label: 'Haiku', efforts: [] }, { value: 'opus', label: 'Opus', efforts: ['low', 'high'] }] } })) as never
    try {
      const p = join(wsPath, 'mv5')
      await here(() => moves.ensureMoved(p, 'claude-code'))
      const shown = await moves.movedNotice(w)
      const mine = shown.filter((n) => n.project === 'mv5')
      expect(mine).toEqual([{ key: `${p.toLowerCase()}|claude-code:none:effort`, project: 'mv5', agent: 'mv5 None', field: 'effort', value: 'high' }])
      expect(moves.effortUsable('claude-code', 'opus', null, 'high')).toBe(true)
      // Another workspace's reply never has this one's projects.
      const ws2 = join(base, 'ws-notice')
      mkdirSync(ws2, { recursive: true })
      const w2 = createWorkspaceService()
      await w2.open(ws2)
      try {
        expect(await moves.movedNotice(w2)).toEqual([])
        // Dismissed from the other workspace: not its entry, so nothing changes.
        await moves.dismissMovedNotice(w2, [mine[0].key])
        expect((await moves.movedNotice(w)).some((n) => n.key === mine[0].key)).toBe(true)
      } finally {
        await disposeWorkspaceService(w2)
      }
      await moves.dismissMovedNotice(w, [mine[0].key])
      expect((await moves.movedNotice(w)).some((n) => n.key === mine[0].key)).toBe(false)
      // Run again (and Hive started again: the record and the dismissal are both kept): still dismissed.
      await here(() => moves.ensureMoved(p, 'claude-code'))
      expect((await moves.movedNotice(w)).some((n) => n.key === mine[0].key)).toBe(false)
    } finally {
      providerService.info = info
    }
  })

  it("connections' defaults: the CLI's copied on adding and once for those without; an emptied one never refilled; edited, the user's", async () => {
    const g = config.settings.providers['claude-code']
    const was = { defaultModel: g.defaultModel, defaultEffort: g.defaultEffort }
    Object.assign(g, { defaultModel: 'sonnet', defaultEffort: 'medium' })
    try {
      expect(cliDefaults(config.settings, 'claude-code')).toMatchObject({ model: 'sonnet', effort: 'medium' })
      const a = await accounts.addAccount('claude-code', 'Copied')
      expect(accounts.getAccount(a.id)).toMatchObject({ defaults: { model: 'sonnet', effort: 'medium' }, defaultsFrom: 'cli' })
      accounts.setConnectionDefaults(a.id, { model: null, effort: '' })
      expect(accounts.getAccount(a.id)?.defaults).toEqual({})
      expect(accounts.getAccount(a.id)?.defaultsFrom).toBeUndefined()
      // One from before defaults (HI-1755's): seeded once; the emptied one left as it is.
      config.update((c) => void (c.connections = [...(c.connections ?? []), { id: 'a-oldone1', provider: 'claude-code', kind: 'signIn', name: 'Old', createdAt: '' }]))
      accounts.seedConnectionDefaults()
      expect(accounts.getAccount('a-oldone1')).toMatchObject({ defaults: { model: 'sonnet' }, defaultsFrom: 'cli' })
      expect(accounts.getAccount(a.id)?.defaults).toEqual({})
      accounts.setConnectionDefaults(a.id, { model: 'opus', use200kContext: false })
      expect(accounts.getAccount(a.id)?.defaults).toEqual({ model: 'opus', use200kContext: false })
      await advanced.set(ACCOUNTS_PREVIEW, false)
      try {
        expect(await outcome(Promise.resolve().then(() => accounts.setConnectionDefaults(a.id, { model: 'haiku' })))).toMatch(/Connections are a preview/)
      } finally {
        await advanced.set(ACCOUNTS_PREVIEW, true)
      }
    } finally {
      Object.assign(g, was)
    }
  })

  it('with Connections off: launches resolve as before (the project and the CLI), and nothing is moved', async () => {
    await advanced.set(ACCOUNTS_PREVIEW, false)
    try {
      const p = join(wsPath, 'mv6')
      const agent = (await w.projectConfig(p)).agents.find((a) => a.id === 'none')!
      expect(await sessions.effective(p, agent)).toMatchObject({ model: 'haiku', effort: 'high', connection: null })
      expect((await w.projectConfig(p)).migrations).toBeUndefined()
    } finally {
      await advanced.set(ACCOUNTS_PREVIEW, true)
    }
  })
})

describe('the Agent API and connections (HI-1771)', () => {
  const c = (id: string, name: string, cli: Connection['provider'] = 'claude-code', extra: Partial<Connection> = {}): Connection => ({ id, provider: cli, name, createdAt: '', ...extra })

  it('a reference: an exact id; else a name (any case) unique among those on here; ambiguous and unknown refused', () => {
    const all = [c('a-1', 'Max'), c('a-2', 'max'), c('a-3', 'Work'), c('a-4', 'Hidden')]
    expect(connectionRef('a-4', all, ['a-1'])).toEqual({ ok: true, id: 'a-4' })
    expect(connectionRef('work', all, ['a-1', 'a-3'])).toEqual({ ok: true, id: 'a-3' })
    expect(connectionRef('MAX', all, ['a-1', 'a-2'])).toEqual({ ok: false, why: 'ambiguous', ids: ['a-1', 'a-2'] })
    // Only those on here count for a name: one of the two off, the other binds.
    expect(connectionRef('max', all, ['a-2'])).toEqual({ ok: true, id: 'a-2' })
    expect(connectionRef('Hidden', all, ['a-1'])).toEqual({ ok: false, why: 'unknown' })
    expect(connectionRef('nothing', all, [])).toEqual({ ok: false, why: 'unknown' })
  })

  it('what each caller sees: a project agent only those on here, four fields; the token and the Assistant all, with on, default and identity; never storage', () => {
    const all = [c('a-1', 'Max 1', 'claude-code', { accepted: { email: 'one@example.com', orgId: 'o' }, observed: { at: '', loggedIn: true, email: 'one@example.com', orgId: 'o', plan: 'max' }, defaults: { model: 'opus' }, defaultsFrom: 'cli' }), c('a-2', 'Elsewhere')]
    const ws = { 'claude-code': { on: ['a-1'], default: 'a-1' } }
    const narrow = connectionsFor(all, ws, false)
    expect(narrow).toEqual([{ id: 'a-1', name: 'Max 1', cli: 'claude-code', kind: 'signIn', signedIn: true }])
    const wide = connectionsFor(all, ws, true)
    expect(wide).toEqual([
      { id: 'a-1', name: 'Max 1', cli: 'claude-code', kind: 'signIn', signedIn: true, on: true, default: true, email: 'one@example.com', plan: 'max' },
      { id: 'a-2', name: 'Elsewhere', cli: 'claude-code', kind: 'signIn', signedIn: false, on: false, default: false }
    ])
    // The detail projection is the same, per caller; nothing of where its login is kept, its settings or defaults.
    for (const shown of [connectionShown(all[0], ws, true), connectionShown(all[0], ws, false), ...wide, ...narrow]) {
      expect(Object.keys(shown).sort()).not.toEqual(expect.arrayContaining(['folder']))
      expect(JSON.stringify(shown)).not.toMatch(/folder|accounts|defaults|observed|accepted|orgId|opus/)
    }
  })

  it("a change of connection: kept when left out, cleared with null; on another CLI it is that change of CLI (what was the old one's cleared), refused while it runs", async () => {
    const a = await signedInConnection('Personal', 'me@example.com')
    const p = join(wsPath, 'api1')
    await here(() => updateAgent(p, 'k', { connection: a.id }))
    // An unrelated change keeps it.
    expect((await here(() => updateAgent(p, 'k', { role: 'notes' }))).connection).toBe(a.id)
    expect((await here(() => updateAgent(p, 'k', { connection: null }))).connection).toBeUndefined()
    // Codex given connections (a stand-in): one of its own, on here, picked for a Claude Code agent.
    const caps = providerDescriptor('codex').capabilities as { connections?: unknown }
    caps.connections = { homeEnv: 'CODEX_HOME', shared: [] }
    const enabled = config.settings.providers.codex.enabled
    config.settings.providers.codex.enabled = true
    try {
      config.update((cfg) => void (cfg.connections = [...(cfg.connections ?? []), { id: 'a-codex01', provider: 'codex', kind: 'signIn', name: 'ChatGPT', createdAt: '' }]))
      await w.saveWorkspaceConfigWith((cfg) => ({ connections: { ...cfg.connections, codex: { on: ['a-codex01'], default: 'a-codex01' } } }))
      // Running: refused, nothing changed.
      const live = vi.spyOn(sessions, 'liveFor').mockReturnValue({} as never)
      try {
        expect(await outcome(here(() => updateAgent(p, 'k', { provider: 'codex', connection: 'a-codex01' })))).toMatch(/Stop the agent before changing its provider/)
      } finally {
        live.mockRestore()
      }
      expect((await w.projectConfig(p)).agents[0]).toMatchObject({ provider: 'claude-code', model: 'opus' })
      const switched = await here(() => updateAgent(p, 'k', { provider: 'codex', connection: 'a-codex01' }))
      expect(switched).toMatchObject({ provider: 'codex', connection: 'a-codex01' })
      for (const k of ['model', 'effort', 'use200kContext', 'lastSessionId'] as const) expect(switched[k]).toBeUndefined()
      // Back by provider alone: its codex connection is cleared too, never kept on Claude Code.
      const back = await here(() => updateAgent(p, 'k', { provider: 'claude-code' }))
      expect(back.provider).toBe('claude-code')
      expect(back.connection).toBeUndefined()
    } finally {
      delete caps.connections
      config.settings.providers.codex.enabled = enabled
    }
  })

  it('a change of CLI decided from the agent read before the write: changed meanwhile, refused whole', async () => {
    const p = join(wsPath, 'api1')
    const file = join(p, '.hive', 'project.json')
    let release!: () => void
    const held = withFileLock(file, () => new Promise<void>((r) => (release = r)))
    const saving = here(() => updateAgent(p, 'k', { provider: 'codex', model: 'gpt-5' }))
    await vi.waitFor(() => expect(fileLockDepth(file)).toBe(2), { timeout: HUNG_MS })
    // Meanwhile something else moves it to Codex (written while the change waits on the lock).
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.agents[0].provider = 'codex'
    writeFileSync(file, JSON.stringify(raw))
    release()
    await held
    expect(await outcome(saving)).toMatch(/provider was changed meanwhile: nothing was changed/)
    expect((await w.projectConfig(p)).agents[0].model).not.toBe('gpt-5')
    raw.agents[0].provider = 'claude-code'
    writeFileSync(file, JSON.stringify(raw))
  })
})

afterAll(async () => {
  accounts.stopAccountWatches()
  advanced.stop()
  await disposeWorkspaceService(w)
})
