// Provider Setup's Codex sandbox Set up on an account (HI-3490): which account of those on in the window's workspace it
// runs on (one positively signed in, the first needing it), what it refuses, what it holds, and the sandbox items each
// window's connections view has for its own accounts. Codex is never run (its status is faked, the terminal is never
// started), nothing signs in, and no real home is touched: CODEX_HOME is this file's temp folder.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { Account } from '../src/shared/types'
import type { CommandSpec } from '../src/main/providers/types'
import { tempDir } from './tempDir'
import { timing } from './timing.cjs'

const base = tempDir('cw-codex-sandbox-setup-')
const home = join(base, 'codex-home')
const userHome = join(base, 'user-profile')
process.env.CW_USER_DATA = join(base, 'profile')
process.env.CODEX_HOME = home
;(electron.app as unknown as { getPath: (n: string) => string }).getPath = (n: string) => (n === 'home' ? userHome : join(base, 'profile'))

const accounts = await import('../src/main/accounts')
const { config } = await import('../src/main/config')
const { advanced } = await import('../src/main/advanced')
const { provider } = await import('../src/main/providers')
const { providerService } = await import('../src/main/providerService')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = timing('wait.hang')

/** What the faked status check says, per account folder: signed in, out, or a check that can't tell. */
type Said = 'in' | 'out' | 'unknown'
const says = new Map<string, Said>()
/** A status check held until its gate opens (a slow check), per account folder. */
const gates = new Map<string, Promise<void>>()
const asked: string[] = []
/** Each setup started (never a real terminal): its command, environment and end. */
const started: { cmd: CommandSpec; env: Record<string, string>; end: () => void }[] = []
/** Each started setup's end, called once each test is over (as its terminal ending would). */
const ends: (() => void)[] = []
const folderOf = (a: Account): string => accounts.accountFolder(a.id)
const sandboxOf = (a: Account, kind: string | null): void => writeFileSync(join(folderOf(a), 'config.toml'), kind ? `[windows]\nsandbox = "${kind}"\n` : '')
const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)

const w1Path = join(base, 'ws1')
const w2Path = join(base, 'ws2')
let w1: ReturnType<typeof createWorkspaceService>
let w2: ReturnType<typeof createWorkspaceService>
const in1 = <T>(fn: () => T): T => inWorkspace(w1, fn)
const in2 = <T>(fn: () => T): T => inWorkspace(w2, fn)

beforeAll(async () => {
  advanced.load(join(base, 'profile'))
  mkdirSync(home, { recursive: true })
  config.settings.providers.codex.enabled = true
  providerService.info = ((id: string) => ({ provider: id, found: true, path: 'codex.exe' })) as never
  vi.spyOn(provider('codex').models!, 'listModels').mockResolvedValue(null)
  vi.spyOn(provider('codex').accounts!, 'accountStatus').mockImplementation(async (_exe, env) => {
    const folder = env.CODEX_HOME!
    asked.push(folder)
    await gates.get(folder)
    const s = says.get(folder) ?? 'unknown'
    return s === 'unknown' ? { ok: false, error: "couldn't tell" } : { ok: true, loggedIn: s === 'in', ...(s === 'in' ? { email: 'one@example.com', plan: 'plus' } : {}) }
  })
  vi.spyOn(providerService, 'runAccountSetUp').mockImplementation((_id, cmd, env, end) => {
    started.push({ cmd, env, end })
    ends.push(end)
    return 'task:codex:setup'
  })
  for (const p of [w1Path, w2Path]) mkdirSync(p, { recursive: true })
  w1 = createWorkspaceService()
  await w1.open(w1Path)
  w2 = createWorkspaceService()
  await w2.open(w2Path)
})

afterAll(async () => {
  for (const end of ends.splice(0)) end()
  for (const a of accounts.allAccounts()) await accounts.removeAccount(a.id).catch(() => undefined)
  await disposeWorkspaceService(w1)
  await disposeWorkspaceService(w2)
  // The folder goes with the run's own temp folder (tempDir), as accounts.test.ts's does: its watches may hold it until then.
  accounts.stopAccountWatches()
  advanced.stop()
  vi.restoreAllMocks()
})

beforeEach(async () => {
  started.length = 0
  for (const end of ends.splice(0)) end()
  for (const a of accounts.allAccounts()) await accounts.removeAccount(a.id)
  says.clear()
  gates.clear()
  asked.length = 0
})

/** An account of Codex's, signed in or out as said, with its own sandbox setting (none: null), on in the workspaces given. */
async function account(name: string, said: Said, kind: string | null, on: ((fn: () => Promise<void>) => Promise<void>)[] = [in1]): Promise<Account> {
  const a = await accounts.addAccount('codex', name)
  says.set(folderOf(a), said)
  sandboxOf(a, kind)
  for (const run of on) await run(() => accounts.setAccountOn(a.id, true))
  return a
}

describe.skipIf(process.platform !== 'win32')("Codex's sandbox Set up on an account (HI-3490)", () => {
  it("runs on the first one on here that is positively signed in: one signed out, or whose check can't tell, is passed over", async () => {
    const out = await account('Out', 'out', null)
    const unsure = await account('Unsure', 'unknown', null)
    const signed = await account('Signed', 'in', null)
    expect(await in1(() => accounts.runSandboxSetUp('codex'))).toBe('task:codex:setup')
    expect(started).toHaveLength(1)
    expect(started[0].env.CODEX_HOME).toBe(folderOf(signed))
    expect(started[0].cmd.args.join(' ')).toContain('cli_auth_credentials_store="file"')
    // Those not known to be signed in were asked first; never ~/.codex.
    expect(asked).toEqual(expect.arrayContaining([folderOf(out), folderOf(unsure)]))
    expect(asked).not.toContain(home)
    expect(Object.values(started[0].env)).not.toContain(home)
  })

  it('refuses, starting nothing, when none on here is signed in', async () => {
    await account('Out', 'out', null)
    await account('Unsure', 'unknown', null)
    expect(await outcome(in1(() => accounts.runSandboxSetUp('codex')))).toMatch(/none on in this workspace is signed in/)
    // None on at all, the same.
    expect(await outcome(in2(() => accounts.runSandboxSetUp('codex')))).toMatch(/none on in this workspace is signed in/)
    expect(started).toHaveLength(0)
  })

  it('upgrades the first on the non-admin sandbox (its own, or by the fallback), and refuses when each has the default one', async () => {
    const elevated = await account('Elevated', 'in', 'elevated')
    const nonAdmin = await account('NonAdmin', 'in', 'unelevated')
    await in1(() => accounts.runSandboxSetUp('codex'))
    const upgrade = started.pop()!
    expect(upgrade.env.CODEX_HOME).toBe(folderOf(nonAdmin))
    expect(JSON.stringify(upgrade.cmd.keys)).toContain('/setup-default-sandbox')
    // A third naming none takes the first account's (the default one): nothing left to do.
    const third = await account('None', 'in', null)
    sandboxOf(nonAdmin, 'elevated')
    expect(await outcome(in1(() => accounts.runSandboxSetUp('codex')))).toMatch(/already set up/)
    // The first names none and the second the non-admin one: the third has that by the fallback, and is upgraded after
    // the second, the first being first of all.
    sandboxOf(elevated, null)
    sandboxOf(nonAdmin, 'unelevated')
    await in1(() => accounts.runSandboxSetUp('codex'))
    expect(started.pop()!.env.CODEX_HOME).toBe(folderOf(elevated))
    sandboxOf(elevated, 'elevated')
    await in1(() => accounts.runSandboxSetUp('codex'))
    expect(started.pop()!.env.CODEX_HOME).toBe(folderOf(nonAdmin))
    sandboxOf(nonAdmin, 'elevated')
    expect(await outcome(in1(() => accounts.runSandboxSetUp('codex')))).toMatch(/already set up/)
    expect(third.provider).toBe('codex')
  })

  it('holds the account while it runs: its removal is refused until the setup ends', async () => {
    const a = await account('Held', 'in', null)
    await in1(() => accounts.runSandboxSetUp('codex'))
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/agents running on it/)
    started.pop()!.end()
    expect(await outcome(accounts.removeAccount(a.id))).toBe('ok')
  })

  it("gives each window the items of its own workspace's accounts, and Set up there agrees with them", async () => {
    // A (the non-admin one, its own) on only in the first workspace; B (the default one) only in the second.
    const a = await account('Alpha', 'in', 'unelevated', [in1])
    await account('Beta', 'in', 'elevated', [in2])
    const first = in1(() => accounts.accountsView()).readiness?.codex ?? []
    expect(first.map((r) => r.id)).toEqual(['sandbox-upgrade'])
    expect(first[0].message).toContain('Alpha')
    expect(in2(() => accounts.accountsView()).readiness?.codex).toBeUndefined()
    expect(await outcome(in2(() => accounts.runSandboxSetUp('codex')))).toMatch(/already set up/)
    await in1(() => accounts.runSandboxSetUp('codex'))
    expect(started.pop()!.env.CODEX_HOME).toBe(folderOf(a))
  })

  it("with none on here signed in, its item's button opens Accounts & Connections", async () => {
    await account('Out', 'out', null)
    await accounts.checkAccount(accounts.allAccounts()[0].id)
    const [item] = in1(() => accounts.accountsView()).readiness?.codex ?? []
    expect(item).toMatchObject({ id: 'sandbox', action: { opens: 'connections' } })
    // None on at all: the same, unnamed.
    const [none] = in2(() => accounts.accountsView()).readiness?.codex ?? []
    expect(none).toMatchObject({ id: 'sandbox', action: { opens: 'connections' } })
  })

  it('offers Set up only where an account it could run on may be signed in: never for one signed out beside one that needs nothing (round 1)', async () => {
    // A needs an upgrade but is signed out; B is signed in but already on the default sandbox.
    const a = await account('Alpha', 'out', 'unelevated')
    const b = await account('Beta', 'in', 'elevated')
    await accounts.checkAccount(a.id)
    await accounts.checkAccount(b.id)
    const [item] = in1(() => accounts.accountsView()).readiness?.codex ?? []
    expect(item).toMatchObject({ id: 'sandbox-upgrade', action: { opens: 'connections' } })
    expect(item.message).toContain('Alpha')
    expect(await outcome(in1(() => accounts.runSandboxSetUp('codex')))).toMatch(/none on in this workspace is signed in/)
    expect(started).toHaveLength(0)
  })

  it('starts nothing on an account turned off in the asking workspace while its check ran, even when the check then says signed in (round 1)', async () => {
    const a = await account('Slow', 'in', null)
    let open!: () => void
    gates.set(folderOf(a), new Promise<void>((r) => (open = r)))
    const asking = in1(() => accounts.runSandboxSetUp('codex'))
    // Its check under way (asked), then the account turned off there, then the check answers: signed in.
    await vi.waitFor(() => expect(asked).toContain(folderOf(a)), { timeout: HUNG_MS })
    await in1(() => accounts.setAccountOn(a.id, false))
    open()
    expect(await outcome(asking)).toMatch(/none on in this workspace is signed in/)
    expect(started).toHaveLength(0)
  })

  it('starts nothing when a check under way replaces its signed-in answer with one that cannot tell (round 2)', async () => {
    const a = await account('Cached', 'in', null)
    await accounts.checkAccount(a.id)
    expect(accounts.getAccount(a.id)?.observed?.loggedIn).toBe(true)
    // A fresh check holds the account's lock, its answer gated; Set up, reading the signed-in answer kept, queues behind it.
    says.set(folderOf(a), 'unknown')
    let open!: () => void
    gates.set(folderOf(a), new Promise<void>((r) => (open = r)))
    const checking = accounts.checkAccount(a.id)
    await vi.waitFor(() => expect(asked.filter((f) => f === folderOf(a))).toHaveLength(2), { timeout: HUNG_MS })
    const asking = in1(() => accounts.runSandboxSetUp('codex'))
    // Set up reads the kept answer and asks for the lock without waiting on anything else: once this turn of the event
    // loop is over, it is queued behind the check.
    await new Promise<void>((r) => setImmediate(r))
    open()
    await checking
    expect(accounts.getAccount(a.id)?.observed?.loggedIn).toBeNull()
    expect(await outcome(asking)).toMatch(/none on in this workspace is signed in/)
    expect(started).toHaveLength(0)
  })
})
