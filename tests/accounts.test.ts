// Hive's accounts (HI-980): the folder and its junction made and checked, removal that never reaches through a link into
// the CLI's home (also with links added partway through), accepted and observed identities kept apart, checks queued
// while one runs, the watches, and a workspace's choice of accounts. All in this file's temp folders: the CLI is never
// run (its status is faked), nothing signs in, and no real home or accounts folder is touched.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { accountState, connectionReadiness, duplicateLogins, switchedOn, workspaceAccounts } from '../src/shared/accounts'
import type { Connection } from '../src/shared/types'
import { tempDir } from './tempDir'

/**
 * The terminals (HI-1870): which are open, by key, and what closing one does. `endsOnKill` (the default) ends it as a
 * kill does, its exit run; off, a kill that never ends it. `gone` is ptyGone's answer, the bound passed.
 */
const terminals = vi.hoisted(() => ({ open: new Set<string>(), killed: [] as string[], endsOnKill: true, onKill: (_key: string): void => undefined, beforeGone: async (): Promise<void> => undefined }))
vi.mock('../src/main/ptyHost', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/ptyHost')>()
  return {
    ...real,
    hasPty: (key: string) => terminals.open.has(key),
    killPty: (key: string) => {
      terminals.killed.push(key)
      if (terminals.endsOnKill) terminals.onKill(key)
    },
    ptyGone: async (key: string) => {
      await terminals.beforeGone()
      return !terminals.open.has(key)
    }
  }
})

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
/** What each terminal was opened to run, by account: its Set Up's working folder and variables, or none for its sign-in. */
const setUps = new Map<string, { env: Record<string, string>; cwd: string } | undefined>()

beforeAll(async () => {
  advanced.load(join(base, 'profile'))
  mkdirSync(home, { recursive: true })
  config.settings.providers['claude-code'].enabled = true
  providerService.info = ((id: string) => ({ provider: id, found: true, path: 'claude.exe' })) as never
  vi.spyOn(providerService, 'runAccountLogin').mockImplementation((_p, id, _env, onExit, setUp) => {
    const key = `task:claude-code:login:${id}`
    setUps.set(id, setUp)
    terminals.open.add(key)
    logins.set(id, (code) => {
      logins.delete(id)
      terminals.open.delete(key)
      onExit(code)
    })
    return key
  })
  // A kill ends the terminal, its exit run, as node-pty's does.
  terminals.onKill = (key) => logins.get(key.split(':').at(-1)!)?.(1)
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
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/Busy has agents running on it/)
    release()
    accounts.setAccountSessions((id) => id === a.id)
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/Busy has agents running on it/)
    accounts.setAccountSessions(() => false)
    // Its sign-in open (the terminal not ended yet).
    await accounts.signInAccount(a.id)
    expect(logins.has(a.id)).toBe(true)
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/Busy is in use/)
    logins.get(a.id)!(0)
    await accounts.removeAccount(a.id)
    expect(accounts.getAccount(a.id)).toBeUndefined()
  })

  describe('with its sign-in or Set Up terminal open, the user saying to close it (HI-1870)', () => {
    afterEach(() => {
      terminals.killed.length = 0
      terminals.endsOnKill = true
      terminals.beforeGone = async () => undefined
      accounts.setAccountSessions(() => false)
    })

    it('ends the terminal, waits for its end, then removes it; without being told to, still refused', async () => {
      const a = await accounts.addAccount('claude-code', 'Open')
      await accounts.setUpSignInConnection(a.id)
      expect(await outcome(accounts.removeAccount(a.id))).toMatch(/Open is in use/)
      expect(terminals.killed).toEqual([])
      await accounts.removeAccount(a.id, { closeTerminal: true })
      expect(terminals.killed).toEqual([`task:claude-code:login:${a.id}`])
      expect(logins.has(a.id)).toBe(false)
      expect(accounts.getAccount(a.id)).toBeUndefined()
      expect(existsSync(folderOf(a))).toBe(false)
    })

    it('agents running on it still refuse, and its terminal is left open', async () => {
      const a = await accounts.addAccount('claude-code', 'Running')
      await accounts.signInAccount(a.id)
      accounts.setAccountSessions((id) => id === a.id)
      expect(await outcome(accounts.removeAccount(a.id, { closeTerminal: true }))).toMatch(/Running has agents running on it/)
      expect(terminals.killed).toEqual([])
      expect(logins.has(a.id)).toBe(true)
      expect(accounts.getAccount(a.id)).toBeDefined()
      logins.get(a.id)!(0)
    })

    it('a kill that never ends it is refused, the connection and its folder kept', async () => {
      const a = await accounts.addAccount('claude-code', 'Stuck')
      await accounts.signInAccount(a.id)
      terminals.endsOnKill = false
      expect(await outcome(accounts.removeAccount(a.id, { closeTerminal: true }))).toMatch(/Stuck is in use/)
      expect(terminals.killed).toHaveLength(1)
      expect(accounts.getAccount(a.id)).toBeDefined()
      expect(existsSync(folderOf(a))).toBe(true)
      logins.get(a.id)!(0)
    })

    it('an agent or a sign-in started while it waited for the terminal to end is still refused (checked again after)', async () => {
      const a = await accounts.addAccount('claude-code', 'Gap')
      await accounts.signInAccount(a.id)
      terminals.beforeGone = async () => accounts.setAccountSessions((id) => id === a.id)
      expect(await outcome(accounts.removeAccount(a.id, { closeTerminal: true }))).toMatch(/Gap has agents running on it/)
      expect(accounts.getAccount(a.id)).toBeDefined()
      accounts.setAccountSessions(() => false)
      await accounts.signInAccount(a.id)
      terminals.beforeGone = async () => void (await accounts.signInAccount(a.id))
      expect(await outcome(accounts.removeAccount(a.id, { closeTerminal: true }))).toMatch(/Gap is in use/)
      expect(accounts.getAccount(a.id)).toBeDefined()
      logins.get(a.id)!(0)
    })

    it('a terminal already ended removes as usual, nothing killed', async () => {
      const a = await accounts.addAccount('claude-code', 'Ended')
      await accounts.signInAccount(a.id)
      logins.get(a.id)!(0)
      await accounts.removeAccount(a.id, { closeTerminal: true })
      expect(terminals.killed).toEqual([])
      expect(accounts.getAccount(a.id)).toBeUndefined()
    })
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

describe("a sign-in connection's Set Up (HI-1826)", () => {
  it("runs the CLI itself on its folder, in the sign-in's terminal; once it ends the account is checked and its login taken on", async () => {
    const a = await accounts.addAccount('claude-code', 'Fresh')
    status.set(folderOf(a), signedIn('fresh@example.com'))
    expect(await accounts.setUpSignInConnection(a.id)).toBe(`task:claude-code:login:${a.id}`)
    // The CLI on the folder, as its working folder, with no variables of a server's.
    expect(setUps.get(a.id)).toEqual({ env: {}, cwd: folderOf(a) })
    // Open, it counts as the sign-in's terminal: removal waits for it.
    expect(await outcome(accounts.removeAccount(a.id))).toMatch(/Fresh is in use/)
    logins.get(a.id)!(0)
    await vi.waitFor(() => expect(accounts.getAccount(a.id)?.accepted?.email).toBe('fresh@example.com'), { timeout: HUNG_MS })
    // Its sign-in opens the login, not the CLI.
    await accounts.signInAccount(a.id)
    expect(setUps.get(a.id)).toBeUndefined()
    logins.get(a.id)!(0)
  })

  it("is refused on a folder replaced by a link, and on a server connection (whose Set Up is serverConnections')", async () => {
    const a = await accounts.addAccount('claude-code', 'Moved')
    rmSync(join(folderOf(a), 'projects'))
    renameSync(folderOf(a), `${folderOf(a)}-real`)
    symlinkSync(home, folderOf(a), 'junction')
    expect(await outcome(accounts.setUpSignInConnection(a.id))).toMatch(/isn't the one Hive made/)
    expect(logins.has(a.id)).toBe(false)
    rmSync(folderOf(a))
    config.update((c) => c.connections!.push({ id: 'acc-server1', provider: 'claude-code', name: 'Server', kind: 'server' } as Connection))
    expect(await outcome(accounts.setUpSignInConnection('acc-server1'))).not.toBe('ok')
    expect(logins.has('acc-server1')).toBe(false)
  })
})

describe("whether a connection's first-run setup is done (HI-1870: Needs set up)", () => {
  const ONBOARDING = join(__dirname, 'fixtures', 'advanced', 'onboarding-claude-2.1.311.jsonl')
  const [onboarded, fresh] = readFileSync(ONBOARDING, 'utf8').trim().split(/\r?\n/)
  const setUpOf = (dir: string) => provider('claude-code').connectionSetUp!(dir)
  const folder = (name: string, claudeJson?: string): string => {
    const dir = join(base, 'setup', name)
    mkdirSync(dir, { recursive: true })
    if (claudeJson !== undefined) writeFileSync(join(dir, '.claude.json'), claudeJson)
    return dir
  }

  it("Claude Code: done in the recorded onboarded home, not in a new one (its sign-in check run there), nor with no .claude.json yet", async () => {
    expect(await setUpOf(folder('onboarded', onboarded))).toBe(true)
    expect(await setUpOf(folder('fresh', fresh))).toBe(false)
    expect(await setUpOf(folder('none'))).toBe(false)
  })

  it("can't be told from a file it can't read (not JSON): unknown, never done or not", async () => {
    expect(await setUpOf(folder('broken', '{"hasCompletedOnboarding": tru'))).toBeNull()
  })

  it('reads the field Settings → Advanced names', async () => {
    const dir = folder('renamed', JSON.stringify({ onboardedAt: true }))
    expect(await setUpOf(dir)).toBe(false)
    await advanced.set('claude-code.accounts.onboardedField', 'onboardedAt')
    try {
      expect(await setUpOf(dir)).toBe(true)
    } finally {
      await advanced.set('claude-code.accounts.onboardedField', null)
    }
  })

  it("is in the connections' list once read, again as Settings shows it, and gone with the connection", async () => {
    const a = await accounts.addAccount('claude-code', 'Fresh one')
    accounts.accountsView(true)
    await vi.waitFor(() => expect(accounts.accountsView().connections.find((c) => c.id === a.id)?.setUp).toBe(false), { timeout: HUNG_MS })
    writeFileSync(join(folderOf(a), '.claude.json'), onboarded)
    accounts.accountsView(true)
    await vi.waitFor(() => expect(accounts.accountsView().connections.find((c) => c.id === a.id)?.setUp).toBe(true), { timeout: HUNG_MS })
    await accounts.removeAccount(a.id)
    const again = await accounts.addAccount('claude-code', 'Fresh one')
    expect(accounts.accountsView().connections.find((c) => c.id === again.id)).not.toHaveProperty('setUp')
  })
})

describe("whether a connection trusts a workspace's folders (HI-1870)", () => {
  const TRUST = join(__dirname, 'fixtures', 'advanced', 'trust-entry-claude-2.1.311.json')
  const trustsOf = (dir: string, targets: { root: string | null; git: boolean; short: boolean }[]) => provider('claude-code').connectionTrusts!(dir, targets)
  const trustHome = (name: string, claudeJson?: string): string => {
    const dir = join(base, 'trust', name)
    mkdirSync(dir, { recursive: true })
    if (claudeJson !== undefined) writeFileSync(join(dir, '.claude.json'), claudeJson)
    return dir
  }
  const t = (root: string | null, short = false) => ({ root, git: true, short })

  it("Claude Code: the recorded entry's folder and its subfolders; not another case, not an 8.3 path (unknown), as 2.1.311 looked them up", async () => {
    // The recorded entry (C:/work/alpha), and the entry Claude Code writes itself for a subfolder it ran in (false).
    const j = JSON.parse(readFileSync(TRUST, 'utf8'))
    j.projects['C:/work/alpha/child'] = { hasTrustDialogAccepted: false }
    const dir = trustHome('claude', JSON.stringify(j))
    expect(await trustsOf(dir, [t('C:\\work\\alpha'), t('C:\\work\\alpha\\child'), t('C:\\work\\beta'), t('C:\\WORK\\ALPHA'), t('C:\\work\\alpha', true), t(null)])).toEqual([true, true, false, false, null, null])
  })

  it("Claude Code: no .claude.json yet is untrusted; one it can't read is unknown", async () => {
    expect(await trustsOf(trustHome('none'),[t('C:\\work\\alpha')])).toEqual([false])
    expect(await trustsOf(trustHome('broken','{"projects": {'), [t('C:\\work\\alpha')])).toEqual([null])
  })

  it('Claude Code: reads the field Settings → Advanced names', async () => {
    const dir = trustHome('renamed',JSON.stringify({ projects: { 'C:/work/alpha': { trustedNow: true } } }))
    expect(await trustsOf(dir, [t('C:\\work\\alpha')])).toEqual([false])
    await advanced.set('claude-code.accounts.trustField', 'trustedNow')
    try {
      expect(await trustsOf(dir, [t('C:\\work\\alpha')])).toEqual([true])
    } finally {
      await advanced.set('claude-code.accounts.trustField', null)
    }
  })

  it("finds each project's folder as the CLIs look it up: a worktree project's main repository root, which covers its slots", async () => {
    const { execFileSync } = await import('child_process')
    const g = (cwd: string, ...a: string[]): void => void execFileSync('git', a, { cwd })
    const repo = join(base, 'trust-git', 'alpha')
    mkdirSync(repo, { recursive: true })
    g(repo, 'init', '-q')
    g(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x')
    const asProject = join(base, 'trust-git', 'alpha-wt')
    g(repo, 'worktree', 'add', '-q', '--detach', asProject)
    const slot = join(base, 'trust-git.worktrees', 'alpha-wt', 'slot-a')
    g(asProject, 'worktree', 'add', '-q', '--detach', slot)
    const plain = join(base, 'trust-git', 'notes')
    mkdirSync(plain, { recursive: true })
    // Its git folder kept elsewhere (`--separate-git-dir`): the working tree is still the root. A bare one has none.
    const separate = join(base, 'trust-git', 'separate')
    mkdirSync(join(base, 'trust-git-meta'), { recursive: true })
    g(join(base, 'trust-git'), 'init', '-q', '--separate-git-dir', join(base, 'trust-git-meta', 'separate.git'), separate)
    const bare = join(base, 'trust-git', 'bare.git')
    g(join(base, 'trust-git'), 'init', '-q', '--bare', bare)
    const got = await accounts.trustTargets([
      { name: 'alpha', path: repo },
      { name: 'alpha-wt', path: asProject },
      { name: 'slot', path: slot },
      { name: 'notes', path: plain },
      { name: 'separate', path: separate },
      { name: 'bare', path: bare },
      { name: 'gone', path: join(base, 'trust-git', 'gone') }
    ])
    const root = realpathSync.native(repo)
    expect(got.map((x) => [x.project, x.root, x.git])).toEqual([
      ['alpha', root, true],
      ['alpha-wt', root, true],
      ['slot', root, true],
      ['notes', realpathSync.native(plain), false],
      ['separate', realpathSync.native(separate), true],
      ['bare', null, true],
      ['gone', null, false]
    ])
  })
})

describe("whether a connection is set up (connectionReadiness, HI-1870)", () => {
  it('anything definitely not done wins, then anything unknown, else done', () => {
    const none = { pending: [], unknown: false }
    const pending = { pending: [{ project: 'alpha', folder: 'C:\\w\\alpha' }], unknown: false }
    expect(connectionReadiness({ setUp: true })).toBe('done')
    expect(connectionReadiness({ setUp: true, trust: none })).toBe('done')
    expect(connectionReadiness({ setUp: false, trust: { ...none, unknown: true } })).toBe('needed')
    expect(connectionReadiness({ setUp: null, trust: pending })).toBe('needed')
    expect(connectionReadiness({ setUp: true, trust: { ...none, unknown: true } })).toBe('unknown')
    expect(connectionReadiness({ setUp: null })).toBe('unknown')
    expect(connectionReadiness({})).toBe('unknown')
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

    describe("its trust of the workspace's projects (HI-1870 round 3: one read at a time, dirty not queued, answers kept only while current)", () => {
      const names = ['alpha', 'beta', 'gamma']
      const folders = names.map((n) => join(wsPath, n))
      // Each trust read held until the test answers it: how many projects it was asked about, and its answer.
      let held: { projects: number; answer: (v: (boolean | null)[]) => void }[] = []
      let spy: { mockRestore: () => void }
      let a: Connection
      const row = () => run(() => accounts.accountsView()).connections.find((c) => c.id === a.id)!
      const projectsNow = async (n: number): Promise<void> => {
        for (const [i, f] of folders.entries()) if (i < n) mkdirSync(f, { recursive: true })
        else rmSync(f, { recursive: true, force: true })
        await w.refresh()
      }
      beforeEach(async () => {
        held = []
        spy = vi.spyOn(provider('claude-code'), 'connectionTrusts').mockImplementation((_home, targets) => new Promise((answer) => held.push({ projects: targets.length, answer })))
        a = await accounts.addAccount('claude-code', 'Trusting')
        writeFileSync(join(folderOf(a), '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
        await projectsNow(1)
        await run(() => accounts.setAccountOn(a.id, true))
        await vi.waitFor(() => expect(row().setUp).toBe(true), { timeout: HUNG_MS })
        await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: HUNG_MS })
      })
      afterEach(async () => {
        spy.mockRestore()
        for (const h of held) h.answer([])
        await run(() => accounts.setAccountOn(a.id, false)).catch(() => undefined)
        await projectsNow(0)
      })

      it('while its first read is held: Checking…, never done; refreshes mark it dirty, so one more read, not one each', async () => {
        expect(row().trust).toEqual({ pending: [], unknown: true, checking: true })
        expect(connectionReadiness(row())).toBe('unknown')
        for (let i = 0; i < 13; i++) run(() => accounts.accountsView(true))
        held[0].answer([true])
        // Answered while dirty: kept (its generation is current: same projects), then exactly one more read.
        await vi.waitFor(() => expect(held).toHaveLength(2), { timeout: HUNG_MS })
        expect(row().trust).toEqual({ pending: [], unknown: false })
        expect(connectionReadiness(row())).toBe('done')
        held[1].answer([true])
        await vi.waitFor(() => expect(row().trust).toEqual({ pending: [], unknown: false }), { timeout: HUNG_MS })
        expect(held).toHaveLength(2)
      })

      it("a terminal's end, then the projects changing, while a read is held; the stale read answered first: dropped, one read for the current set, Set Up gets its folder", async () => {
        // A Set Up asked for (its terminal's end has the same effect): marks it dirty and moves its generation.
        const folder = run(() => accounts.setUpFolder(a.id))
        await projectsNow(2)
        row()
        held[0].answer([false])
        // The stale answer (alpha untrusted) is never applied; one read for both projects follows, none for alpha alone.
        await vi.waitFor(() => expect(held).toHaveLength(2), { timeout: HUNG_MS })
        expect(held[1].projects).toBe(2)
        expect(row().trust?.checking).toBe(true)
        held[1].answer([true, false])
        expect(await folder).toBe(realpathSync.native(folders[1]))
        expect(row().trust).toEqual({ pending: [{ project: 'beta', folder: realpathSync.native(folders[1]) }], unknown: false })
        expect(held).toHaveLength(2)
      })

      it('the same, with the newer read answered while still dirty: never the stale answer, exactly one more read for the current set', async () => {
        await projectsNow(2)
        row()
        const folder = run(() => accounts.setUpFolder(a.id))
        held[0].answer([false])
        await vi.waitFor(() => expect(held).toHaveLength(2), { timeout: HUNG_MS })
        // Asked again while that one runs (Settings shown): dirty, so one more after it, for the same two projects.
        run(() => accounts.accountsView(true))
        held[1].answer([false, true])
        await vi.waitFor(() => expect(held).toHaveLength(3), { timeout: HUNG_MS })
        expect(held[2].projects).toBe(2)
        held[2].answer([true, true])
        expect(await folder).toBeUndefined()
        expect(row().trust).toEqual({ pending: [], unknown: false })
        expect(held).toHaveLength(3)
      })

      it('removed while a read is held: its Set Up waiter is told there is no folder, and nothing is written', async () => {
        const folder = run(() => accounts.setUpFolder(a.id))
        await run(() => accounts.setAccountOn(a.id, false))
        await accounts.removeAccount(a.id)
        expect(await folder).toBeUndefined()
        held[0].answer([false])
        await vi.waitFor(() => expect(accounts.getAccount(a.id)).toBeUndefined(), { timeout: HUNG_MS })
        expect(held).toHaveLength(1)
      })
    })
  })
})
