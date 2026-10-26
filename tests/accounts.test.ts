// Hive's accounts (HI-980): the folder and its junction made and checked, removal that never reaches through a link into
// the CLI's home (also with links added partway through), accepted and observed identities kept apart, checks queued
// while one runs, the watches, and a workspace's choice of accounts. All in this file's temp folders: the CLI is never
// run (its status is faked), nothing signs in, and no real home or accounts folder is touched.
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { accountState, duplicateLogins, switchedOn, workspaceAccounts } from '../src/shared/accounts'
import type { Connection } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-accounts-')
const home = join(base, 'claude-home')
process.env.HIVE_USER_DATA = join(base, 'profile')
process.env.CLAUDE_CONFIG_DIR = home
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const accounts = await import('../src/main/accounts')
const { config } = await import('../src/main/config')
const { advanced } = await import('../src/main/advanced')
const { provider } = await import('../src/main/providers')
const { providerService } = await import('../src/main/providerService')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { claudeAccountStatus, parseClaudeAuthStatus } = await import('../src/main/providers/claude/adapter')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10_000
const FIX = join(__dirname, 'fixtures', 'advanced', 'auth-status-claude-2.1.310.jsonl')
const FIELDS = { loggedIn: 'loggedIn', email: 'email', orgId: 'orgId', plan: 'subscriptionType' }

/** What the faked `claude auth status` says, per account folder; a function to hold it (a slow check). */
const status = new Map<string, () => Promise<{ ok: true; loggedIn: boolean; email?: string; orgId?: string; plan?: string | null } | { ok: false; error: string }>>()
const signedIn = (email: string, orgId = 'org-1') => async () => ({ ok: true as const, loggedIn: true, email, orgId, plan: 'max' })
const asked: string[] = []

const projects = join(home, 'projects')
const keep = join(projects, 'C--work-alpha', 'conversation.jsonl')
const folderOf = (a: Connection): string => accounts.accountFolder(a.id)
const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)
const aside = (id: string): string => join(base, 'profile', 'accounts', `.removing-${id}`)
/** Each open sign-in's end, by account: the faked terminal stays open until a test ends it. */
const logins = new Map<string, (code: number) => void>()

beforeAll(async () => {
  advanced.load(join(base, 'profile'))
  mkdirSync(home, { recursive: true })
  config.settings.providers['claude-code'].enabled = true
  providerService.info = ((id: string) => ({ provider: id, found: true, path: 'claude.exe' })) as never
  vi.spyOn(providerService, 'runAccountLogin').mockImplementation((_p, id, _env, onExit) => {
    logins.set(id, (code) => {
      logins.delete(id)
      onExit(code)
    })
    return `task:claude-code:login:${id}`
  })
  vi.spyOn(provider('claude-code'), 'accountStatus').mockImplementation(async (_exe, env) => {
    const dir = env.CLAUDE_CONFIG_DIR!
    asked.push(dir)
    const s = [...status].find(([k]) => k.toLowerCase() === dir.toLowerCase())?.[1]
    return s ? s() : { ok: true, loggedIn: false }
  })
})
afterAll(async () => {
  accounts.stopAccountWatches()
  advanced.stop()
})
beforeEach(() => {
  // The shared folder's target, with a conversation in it that no removal may touch.
  rmSync(projects, { recursive: true, force: true })
  mkdirSync(join(projects, 'C--work-alpha'), { recursive: true })
  writeFileSync(keep, '{"kept":true}\n')
  status.clear()
  asked.length = 0
})
afterEach(async () => {
  accounts.accountTestHooks.beforeDelete = undefined
  for (const a of [...(config.get().connections ?? [])]) await accounts.removeAccount(a.id).catch(() => undefined)
  config.update((c) => (c.connections = []))
})

describe('what `claude auth status --json` says (the recorded fixture)', () => {
  const lines = readFileSync(FIX, 'utf8').trim().split(/\r?\n/)
  it('signed in: the email, organisation and plan, nothing else', () => {
    expect(parseClaudeAuthStatus(lines[0], FIELDS)).toEqual({ ok: true, loggedIn: true, email: 'user@example.com', orgId: '00000000-0000-4000-8000-000000000001', plan: 'max' })
  })
  it('signed out (exit 1, the same JSON): signed out, with no identity', () => {
    expect(parseClaudeAuthStatus(lines[1], FIELDS)).toEqual({ ok: true, loggedIn: false, email: undefined, orgId: undefined, plan: null })
  })
  it("anything else is a failed check, never signed out: not JSON, or no signed-in field", () => {
    expect(parseClaudeAuthStatus('Error: something', FIELDS).ok).toBe(false)
    expect(parseClaudeAuthStatus('{"email":"x@y"}', FIELDS).ok).toBe(false)
    expect(parseClaudeAuthStatus('{"loggedIn":"yes"}', FIELDS).ok).toBe(false)
  })
})

describe('an account’s folder and its junction', () => {
  it('is a folder of its own under the profile’s accounts, with projects a junction to the CLI home’s, checked', async () => {
    const a = await accounts.addAccount('claude-code', ' Personal ')
    expect(a).toMatchObject({ provider: 'claude-code', kind: 'signIn', name: 'Personal' })
    expect(folderOf(a)).toBe(join(base, 'profile', 'accounts', a.id))
    const link = join(folderOf(a), 'projects')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    // The conversation is found through it.
    expect(readFileSync(join(link, 'C--work-alpha', 'conversation.jsonl'), 'utf8')).toContain('kept')
  })

  it("makes the CLI home's missing projects folder (empty), and is refused without the home itself", async () => {
    rmSync(projects, { recursive: true, force: true })
    const a = await accounts.addAccount('claude-code', 'Fresh PC')
    expect(lstatSync(projects).isDirectory()).toBe(true)
    await accounts.removeAccount(a.id)
    process.env.CLAUDE_CONFIG_DIR = join(base, 'no-home')
    try {
      expect(await outcome(accounts.addAccount('claude-code', 'Nowhere'))).toMatch(/isn't there yet: run Claude Code once/)
      expect(existsSync(join(base, 'no-home'))).toBe(false)
      expect(config.get().connections ?? []).toHaveLength(0)
    } finally {
      process.env.CLAUDE_CONFIG_DIR = home
    }
  })

  it('a rename changes the name only: the id, folder and junction stay', async () => {
    const a = await accounts.addAccount('claude-code', 'Work')
    accounts.renameAccount(a.id, 'Hive overnight')
    expect(accounts.getAccount(a.id)).toMatchObject({ id: a.id, name: 'Hive overnight' })
    expect(lstatSync(join(folderOf(a), 'projects')).isSymbolicLink()).toBe(true)
  })
})

describe('removing an account', () => {
  it('removes its junction first, then its folder for good: the conversations it linked to stay', async () => {
    const a = await accounts.addAccount('claude-code', 'Gone')
    writeFileSync(join(folderOf(a), '.credentials.json'), '{}')
    mkdirSync(join(folderOf(a), 'cache', 'deep'), { recursive: true })
    writeFileSync(join(folderOf(a), 'cache', 'deep', 'x'), 'x')
    await accounts.removeAccount(a.id)
    expect(existsSync(folderOf(a))).toBe(false)
    expect(readFileSync(keep, 'utf8')).toContain('kept')
    expect(accounts.getAccount(a.id)).toBeUndefined()
  })

  it('tried again after it stopped with its junction already gone: carries on from there', async () => {
    const a = await accounts.addAccount('claude-code', 'Retry')
    rmSync(join(folderOf(a), 'projects'))
    await accounts.removeAccount(a.id)
    expect(existsSync(folderOf(a))).toBe(false)
    expect(readFileSync(keep, 'utf8')).toContain('kept')
  })

  it('a real folder where its junction should be: refused, nothing deleted, what is left said on it', async () => {
    const a = await accounts.addAccount('claude-code', 'Odd')
    rmSync(join(folderOf(a), 'projects'))
    mkdirSync(join(folderOf(a), 'projects'))
    writeFileSync(join(folderOf(a), 'projects', 'mine.txt'), 'mine')
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/wasn't removed: .*a real folder.*Nothing outside its folder was touched/)
    expect(readFileSync(join(folderOf(a), 'projects', 'mine.txt'), 'utf8')).toBe('mine')
    expect(accounts.getAccount(a.id)?.leftover).toMatch(/a real folder/)
    // Put right, Remove tries again.
    rmSync(join(folderOf(a), 'projects'), { recursive: true })
    await accounts.removeAccount(a.id)
    expect(accounts.getAccount(a.id)).toBeUndefined()
  })

  it('its junction pointing elsewhere: refused, and the other folder untouched', async () => {
    const a = await accounts.addAccount('claude-code', 'Elsewhere')
    const other = join(base, 'other-target')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'precious'), 'p')
    rmSync(join(folderOf(a), 'projects'))
    symlinkSync(other, join(folderOf(a), 'projects'), 'junction')
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/a link to .*other-target/)
    expect(readFileSync(join(other, 'precious'), 'utf8')).toBe('p')
    rmSync(join(folderOf(a), 'projects'))
  })

  it("a link Hive didn't make anywhere inside it: refused before anything is deleted", async () => {
    const a = await accounts.addAccount('claude-code', 'Linked')
    mkdirSync(join(folderOf(a), 'plugins'), { recursive: true })
    writeFileSync(join(folderOf(a), 'plugins', 'a.txt'), 'a')
    symlinkSync(projects, join(folderOf(a), 'plugins', 'sneaky'), 'junction')
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/links Hive didn't make are in it: .*sneaky/)
    // Nothing deleted: its own file is still there, and so is everything the link reaches.
    expect(existsSync(join(folderOf(a), 'plugins', 'a.txt'))).toBe(true)
    expect(readFileSync(keep, 'utf8')).toContain('kept')
    rmSync(join(folderOf(a), 'plugins', 'sneaky'))
  })

  it('renames the folder aside, then deletes it there; a folder left aside by a crash is finished later', async () => {
    const a = await accounts.addAccount('claude-code', 'Aside')
    writeFileSync(join(folderOf(a), 'one'), '1')
    const seen: string[] = []
    accounts.accountTestHooks.beforeDelete = async (dir) => void seen.push(dir)
    await accounts.removeAccount(a.id)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((d) => d === aside(a.id))).toBe(true)
    expect(existsSync(aside(a.id))).toBe(false)
    accounts.accountTestHooks.beforeDelete = undefined
    // A crash after the rename: the folder aside, its junction already gone.
    const b = await accounts.addAccount('claude-code', 'Crashed')
    rmSync(join(folderOf(b), 'projects'))
    writeFileSync(join(folderOf(b), 'two'), '2')
    renameSync(folderOf(b), aside(b.id))
    await accounts.finishLeftoverRemovals()
    expect(existsSync(aside(b.id))).toBe(false)
    expect(readFileSync(keep, 'utf8')).toContain('kept')
    // And a removal tried again for an account whose folder is only aside.
    const c = await accounts.addAccount('claude-code', 'Again')
    rmSync(join(folderOf(c), 'projects'))
    renameSync(folderOf(c), aside(c.id))
    await accounts.removeAccount(c.id)
    expect(existsSync(aside(c.id))).toBe(false)
    expect(accounts.getAccount(c.id)).toBeUndefined()
  })

  it('a folder replaced by a junction while the walk deletes: it stops, and never deletes through it', async () => {
    const a = await accounts.addAccount('claude-code', 'Race')
    mkdirSync(join(folderOf(a), 'cache'), { recursive: true })
    writeFileSync(join(folderOf(a), 'cache', 'one'), '1')
    writeFileSync(join(folderOf(a), 'cache', 'two'), '2')
    // Just before its first delete in cache\, cache\ becomes a junction to the CLI home's projects (which has a file of
    // the same name, to be sure a delete through it would show).
    writeFileSync(join(projects, 'one'), 'theirs')
    writeFileSync(join(projects, 'two'), 'theirs')
    let swapped = false
    accounts.accountTestHooks.beforeDelete = async (dir) => {
      if (swapped || !dir.endsWith('cache')) return
      swapped = true
      renameSync(dir, `${dir}-moved`)
      symlinkSync(projects, dir, 'junction')
    }
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/was replaced while it was removed/)
    expect(swapped).toBe(true)
    expect(readFileSync(join(projects, 'one'), 'utf8')).toBe('theirs')
    expect(readFileSync(join(projects, 'two'), 'utf8')).toBe('theirs')
    expect(readFileSync(keep, 'utf8')).toContain('kept')
    accounts.accountTestHooks.beforeDelete = undefined
    rmSync(join(aside(a.id), 'cache'))
  })

  it('a subfolder that becomes a junction after it was read: never descended into', async () => {
    const a = await accounts.addAccount('claude-code', 'Race2')
    mkdirSync(join(folderOf(a), 'zz'), { recursive: true })
    writeFileSync(join(folderOf(a), 'zz', 'f'), 'f')
    writeFileSync(join(folderOf(a), 'aa'), 'a')
    writeFileSync(join(projects, 'f'), 'theirs')
    let swapped = false
    accounts.accountTestHooks.beforeDelete = async (dir) => {
      // At the delete of aa (in the folder renamed aside), zz\ is swapped for a junction: read as a folder, now a link.
      if (swapped || dir !== aside(a.id)) return
      swapped = true
      renameSync(join(dir, 'zz'), join(dir, 'zz-moved'))
      symlinkSync(projects, join(dir, 'zz'), 'junction')
    }
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/changed into a link|was replaced/)
    expect(readFileSync(join(projects, 'f'), 'utf8')).toBe('theirs')
    accounts.accountTestHooks.beforeDelete = undefined
    rmSync(join(aside(a.id), 'zz'))
  })

  it('the account folder itself a junction: refused, and its target untouched', async () => {
    const a = await accounts.addAccount('claude-code', 'Swapped')
    rmSync(join(folderOf(a), 'projects'))
    renameSync(folderOf(a), `${folderOf(a)}-real`)
    symlinkSync(projects, folderOf(a), 'junction')
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/isn't a folder of its own/)
    expect(readFileSync(keep, 'utf8')).toContain('kept')
    rmSync(folderOf(a))
  })

  it('is refused while a launch holds it, its sessions run, or its sign-in is open', async () => {
    const a = await accounts.addAccount('claude-code', 'Busy')
    const release = await accounts.claimAccount(a.id)
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/Busy is in use/)
    release()
    accounts.setAccountSessions((id) => id === a.id)
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/Busy is in use/)
    accounts.setAccountSessions(() => false)
    // Its sign-in open (the terminal not ended yet).
    await accounts.signInAccount(a.id)
    expect(logins.has(a.id)).toBe(true)
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/Busy is in use/)
    logins.get(a.id)!(0)
    await accounts.removeAccount(a.id)
    expect(accounts.getAccount(a.id)).toBeUndefined()
  })

  it('a sign-in or launch asked for once removal has begun is never started: the account is gone by its turn', async () => {
    const a = await accounts.addAccount('claude-code', 'Going')
    writeFileSync(join(folderOf(a), 'x'), 'x')
    let signIn: Promise<string> | null = null
    let claim: Promise<unknown> | null = null
    accounts.accountTestHooks.beforeDelete = async () => {
      // Inside removal's critical section (its folder being deleted): both wait for its lock.
      signIn ??= accounts.signInAccount(a.id)
      claim ??= accounts.claimAccount(a.id)
    }
    await accounts.removeAccount(a.id)
    accounts.accountTestHooks.beforeDelete = undefined
    expect(await outcome(signIn!)).toMatch(/no such connection/)
    expect(await outcome(claim!)).toMatch(/no such connection/)
    expect(logins.has(a.id)).toBe(false)
  })

  it("a sign-in or launch on a folder replaced by a link is refused before anything starts (the CLI's writes would go elsewhere)", async () => {
    const a = await accounts.addAccount('claude-code', 'Hijacked')
    rmSync(join(folderOf(a), 'projects'))
    renameSync(folderOf(a), `${folderOf(a)}-real`)
    symlinkSync(home, folderOf(a), 'junction')
    expect(await outcome(accounts.signInAccount(a.id))).toMatch(/isn't the one Hive made/)
    expect(await outcome(accounts.claimAccount(a.id))).toMatch(/isn't the one Hive made/)
    expect(logins.has(a.id)).toBe(false)
    rmSync(folderOf(a))
    // Missing altogether: the same.
    expect(await outcome(accounts.signInAccount(a.id))).toMatch(/isn't the one Hive made/)
  })
})

describe("what an account's status check counts (claudeAccountStatus)", () => {
  const lines = readFileSync(FIX, 'utf8').trim().split(/\r?\n/)
  it('exit 0 with its answer, and exit 1 saying signed out, are answers', () => {
    expect(claudeAccountStatus({ stdout: lines[0], code: 0 }, FIELDS)).toMatchObject({ ok: true, loggedIn: true, email: 'user@example.com' })
    expect(claudeAccountStatus({ stdout: lines[1], code: 1 }, FIELDS)).toMatchObject({ ok: true, loggedIn: false })
  })
  it('anything else fails, whatever it printed: a timeout, another exit, exit 1 claiming signed in', () => {
    expect(claudeAccountStatus({ stdout: lines[0], code: 1, ended: true }, FIELDS).ok).toBe(false)
    expect(claudeAccountStatus({ stdout: lines[1], code: 1, ended: true }, FIELDS).ok).toBe(false)
    expect(claudeAccountStatus({ stdout: lines[0], code: 2 }, FIELDS).ok).toBe(false)
    expect(claudeAccountStatus({ stdout: lines[0], code: 1 }, FIELDS).ok).toBe(false)
    expect(claudeAccountStatus({ stdout: 'oops', code: 1 }, FIELDS).ok).toBe(false)
    expect(claudeAccountStatus({ stdout: 'oops', code: 0 }, FIELDS).ok).toBe(false)
  })
})

describe('who an account is signed in as', () => {
  it('a check keeps what the CLI said as observed; accepted is only ever the one taken on', async () => {
    const a = await accounts.addAccount('claude-code', 'Me')
    status.set(folderOf(a), signedIn('me@example.com'))
    expect(await accounts.checkAccount(a.id)).toMatchObject({ loggedIn: true, email: 'me@example.com' })
    expect(accounts.getAccount(a.id)?.accepted).toBeUndefined()
    accounts.keepNewLogin(a.id)
    expect(accounts.getAccount(a.id)?.accepted).toEqual({ email: 'me@example.com', orgId: 'org-1' })
    expect(accountState(accounts.getAccount(a.id)!)).toBe('signedIn')
    // A /login typed in a pane: a change, kept until answered, whatever later checks say.
    status.set(folderOf(a), signedIn('other@example.com'))
    await accounts.checkAccount(a.id)
    await accounts.checkAccount(a.id)
    expect(accountState(accounts.getAccount(a.id)!)).toBe('changed')
    expect(accounts.getAccount(a.id)?.accepted?.email).toBe('me@example.com')
  })

  it('a failed check (a timeout, bad output) is never signed out, keeps the last identity, and touches no accepted', async () => {
    const a = await accounts.addAccount('claude-code', 'Flaky')
    status.set(folderOf(a), signedIn('me@example.com'))
    await accounts.checkAccount(a.id)
    accounts.keepNewLogin(a.id)
    status.set(folderOf(a), async () => ({ ok: false, error: 'timed out' }))
    const o = await accounts.checkAccount(a.id)
    expect(o).toMatchObject({ loggedIn: null, error: 'timed out', email: 'me@example.com' })
    expect(accountState(accounts.getAccount(a.id)!)).toBe('failed')
    expect(accounts.getAccount(a.id)?.accepted?.email).toBe('me@example.com')
    expect(await outcome(Promise.resolve().then(() => accounts.keepNewLogin(a.id)))).toMatch(/no login to keep/)
  })

  it('signed out only when the CLI says so; its folder gone is missing', async () => {
    const a = await accounts.addAccount('claude-code', 'Out')
    expect(await accounts.checkAccount(a.id)).toMatchObject({ loggedIn: false })
    expect(accountState(accounts.getAccount(a.id)!)).toBe('signedOut')
    rmSync(join(folderOf(a), 'projects'))
    rmSync(folderOf(a), { recursive: true })
    expect(await accounts.checkAccount(a.id)).toMatchObject({ missing: true })
    expect(accountState(accounts.getAccount(a.id)!)).toBe('missing')
  })

  it('a check asked for while one runs gets one started after it, not the one under way', async () => {
    const a = await accounts.addAccount('claude-code', 'Queued')
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let n = 0
    status.set(folderOf(a), async () => {
      n++
      if (n === 1) await held
      return { ok: true, loggedIn: true, email: `v${n}@example.com`, orgId: 'org-1' }
    })
    const first = accounts.checkAccount(a.id)
    await vi.waitFor(() => expect(n).toBe(1), { timeout: HUNG_MS })
    const second = accounts.checkAccount(a.id)
    const third = accounts.checkAccount(a.id)
    release()
    expect((await first)?.email).toBe('v1@example.com')
    expect((await second)?.email).toBe('v2@example.com')
    // Asked while the first ran too: shares the one queued after it.
    expect((await third)?.email).toBe('v2@example.com')
  })

  it('at a launch, a login that changes during the check is checked again before it counts as fresh', async () => {
    const a = await accounts.addAccount('claude-code', 'Moving')
    let n = 0
    status.set(folderOf(a), async () => {
      n++
      // Its login files change while the first check runs.
      if (n === 1) accounts.accountChanged(a.id)
      return { ok: true, loggedIn: true, email: `v${n}@example.com`, orgId: 'org-1' }
    })
    const r = await accounts.confirmAccount(a.id)
    expect(r).toMatchObject({ fresh: true, observed: { email: 'v2@example.com' } })
    // One that never settles isn't called fresh.
    status.set(folderOf(a), async () => {
      accounts.accountChanged(a.id)
      return { ok: true, loggedIn: true, email: 'busy@example.com', orgId: 'org-1' }
    })
    expect((await accounts.confirmAccount(a.id)).fresh).toBe(false)
  })

  it('a check that ends after its account was removed is dropped', async () => {
    const a = await accounts.addAccount('claude-code', 'Late')
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    status.set(folderOf(a), async () => {
      await held
      return { ok: true, loggedIn: true, email: 'late@example.com', orgId: 'org-1' }
    })
    const check = accounts.checkAccount(a.id)
    // Queued behind it: the removal waits for the check's turn, then the account's queued check finds it gone.
    const again = accounts.checkAccount(a.id)
    const removal = accounts.removeAccount(a.id)
    release()
    await check
    await removal
    expect(await again).toBeNull()
    expect(accounts.getAccount(a.id)).toBeUndefined()
  })

  it('two accounts on the same login are flagged', () => {
    const o = (email: string) => ({ at: '', loggedIn: true, email, orgId: 'org-1' })
    const list: Connection[] = [
      { id: 'a', provider: 'claude-code', name: 'A', createdAt: '', observed: o('x@example.com') },
      { id: 'b', provider: 'claude-code', name: 'B', createdAt: '', observed: o('X@example.com') },
      { id: 'c', provider: 'claude-code', name: 'C', createdAt: '', observed: o('y@example.com') }
    ]
    expect(Object.fromEntries(duplicateLogins(list))).toEqual({ a: ['b'], b: ['a'] })
  })
})

describe("a workspace's accounts", () => {
  const acct = (id: string, cli: Connection['provider'] = 'claude-code'): Connection => ({ id, provider: cli, name: id, createdAt: '' })
  const all = [acct('a1'), acct('a2'), acct('a3'), acct('x1', 'codex')]

  it('not set up is undefined; turned all off stays so; unknown or other providers’ ids are dropped', () => {
    expect(workspaceAccounts({}, 'claude-code', all)).toBeUndefined()
    expect(workspaceAccounts({ connections: { 'claude-code': { on: [], default: null } } }, 'claude-code', all)).toEqual({ on: [], default: null })
    expect(workspaceAccounts({ connections: { 'claude-code': { on: ['gone', 'a2', 'x1'], default: 'gone' } } }, 'claude-code', all)).toEqual({ on: ['a2'], default: 'a2' })
  })

  it('the first one on becomes the default; the default off is replaced by the first on in list order, never another provider’s', () => {
    let w = switchedOn(undefined, 'a3', true, all)
    expect(w).toEqual({ on: ['a3'], default: 'a3' })
    w = switchedOn(w, 'a1', true, all)
    expect(w).toEqual({ on: ['a1', 'a3'], default: 'a3' })
    w = switchedOn(w, 'a3', false, all)
    expect(w).toEqual({ on: ['a1'], default: 'a1' })
    w = switchedOn(w, 'a1', false, all)
    expect(w).toEqual({ on: [], default: null })
  })

  describe('in an open workspace', () => {
    const wsPath = join(base, 'ws')
    let w: ReturnType<typeof createWorkspaceService>
    const run = <T>(fn: () => T): T => inWorkspace(w, fn)
    beforeAll(async () => {
      mkdirSync(wsPath, { recursive: true })
      w = createWorkspaceService()
      await w.open(wsPath)
    })
    afterAll(async () => {
      await disposeWorkspaceService(w)
    })

    it('turning one on saves it in workspace.json, as its default, and remembers it for new workspaces', async () => {
      const a = await accounts.addAccount('claude-code', 'Here')
      await run(() => accounts.setAccountOn(a.id, true))
      expect(JSON.parse(readFileSync(join(wsPath, '.hive', 'workspace.json'), 'utf8')).connections).toEqual({ 'claude-code': { on: [a.id], default: a.id } })
      expect(config.get().lastUsedConnection?.['claude-code']).toBe(a.id)
      expect(accounts.newWorkspaceAccounts()).toEqual({ 'claude-code': { on: [a.id], default: a.id } })
      await run(() => accounts.setAccountOn(a.id, false))
      expect(run(() => accounts.accountsView()).workspace['claude-code']).toEqual({ on: [], default: null })
    })

    it("an account on here is watched with Settings closed: its login changed is checked by itself", async () => {
      const a = await accounts.addAccount('claude-code', 'Watched')
      status.set(folderOf(a), signedIn('first@example.com'))
      await run(() => accounts.setAccountOn(a.id, true))
      await vi.waitFor(() => expect(accounts.getAccount(a.id)?.observed?.email).toBe('first@example.com'), { timeout: HUNG_MS })
      accounts.keepNewLogin(a.id)
      // A /login in a pane: the CLI writes its login files; nobody opens Settings.
      status.set(folderOf(a), signedIn('second@example.com'))
      writeFileSync(join(folderOf(a), '.claude.json'), '{"changed":1}')
      await vi.waitFor(() => expect(accountState(accounts.getAccount(a.id)!)).toBe('changed'), { timeout: HUNG_MS })
      // Its folder replaced from outside (deleted, then made again signed in as someone else): found by the accounts
      // folder's watch, and checked again.
      rmSync(join(folderOf(a), 'projects'))
      rmSync(folderOf(a), { recursive: true })
      await vi.waitFor(() => expect(accountState(accounts.getAccount(a.id)!)).toBe('missing'), { timeout: HUNG_MS })
      status.set(folderOf(a), signedIn('third@example.com'))
      mkdirSync(folderOf(a))
      symlinkSync(projects, join(folderOf(a), 'projects'), 'junction')
      writeFileSync(join(folderOf(a), '.claude.json'), '{}')
      await vi.waitFor(() => expect(accounts.getAccount(a.id)?.observed?.email).toBe('third@example.com'), { timeout: HUNG_MS })
      await run(() => accounts.setAccountOn(a.id, false))
    })
  })
})
