import { randomBytes } from 'crypto'
import { join, resolve } from 'path'
import { app } from 'electron'
import { watch, type FSWatcher } from 'original-fs'
import { lstat, mkdir, readdir, readlink, realpath, rename, rmdir, symlink, unlink } from 'original-fs/promises'
import type { AppConfig, Connection, ConnectionDefaults, ConnectionObserved, ConnectionProblem, ProviderId, ServerConnection, ServerModel, WorkspaceConfig } from '../shared/types'
import { cliDefaults } from '../shared/connectionDefaults'
import { acceptable, accountState, resolveConnection, workspaceAccounts, switchedOn, type ConnectionsView } from '../shared/accounts'
import { profileFolder } from '../shared/appName'
import { isProviderEnabled, providerDescriptor, PROVIDERS } from '../shared/providers'
import { msg, type Msg } from '../shared/i18n'
import { advanced } from './advanced'
import { config } from './config'
import { emit, onHiveEvent } from './events'
import { hiveError } from './hiveError'
import { createLogger, userText } from './logger'
import { connectionLoginChanged, forgetConnectionUsage, usageLogin } from './planUsage'
import { childEnv, hasPty } from './ptyHost'
import { connectionsManaged, testHomeSeam } from './connectionSeam'
import { provider } from './providers'
import { withoutAccountEnv } from './providers/common'
import { providerService } from './providerService'
import { openWorkspaces, setNewWorkspaceExtras, workspace, workspaceOf } from './workspace'
import { dropKeysExcept, keyInfo, loadKeys, removeKey, withKey } from './keyStore'
import { coverageView } from './keyCoverage'
import { aliasModels, MODEL_ALIASES, originOf, parseBaseUrl, serverDefaultModel, withRemote } from '../shared/serverConnection'
import type { ServerCaps } from '../shared/providers'

/**
 * Hive's accounts (HI-980, SPEC §11.2): a CLI login per folder, under `<accounts>\<id>\`, each signed in through the
 * CLI's own sign-in (its login stays in its folder: Hive never reads, stores or passes a token). Each account's folder
 * links the CLI's shared folders (Claude Code's `projects\`: transcripts and memory) back to the CLI's own home by a
 * junction, so every account finds every conversation. Removing one removes its junctions first, checks they are gone,
 * and only then deletes the folder, by a walk that stops at any link (never following one into the CLI's home).
 *
 * Who each account is signed in as comes from the CLI's own status (`claude auth status --json`): at every launch
 * (`confirm`, HI-1755), when its login files change (a watch on its folder, and one on the accounts folder for the folder
 * itself replaced), after its sign-in, and when Settings → Accounts is shown. `accepted` (who the user took it on as) and
 * `observed` (the latest check) are kept apart: a check never clears a change the user hasn't answered.
 *
 * Each launch on a connection goes through connectionForLaunch (HI-1755): which connection, its folder checked, its
 * login confirmed, and a claim that keeps it from being removed until the session runs.
 */

const log = createLogger('accounts')

/** How long a watched change waits for more before its check (a sign-in writes several files). */
const DEBOUNCE_MS = 1000
/** Checks run at once over all connections: each starts the CLI. */
const CHECKS_AT_ONCE = 2
/** A watch that failed is tried again after 1, 2, 4, 8 and 16 s, then every minute while it is wanted. */
const RETRY_MS = [1000, 2000, 4000, 8000, 16000]
const RETRY_LATER_MS = 60_000
/** At a launch, checks run again while the login keeps changing under them, at most this many in all. */
const CONFIRM_ROUNDS = 3

// ---------------------------------------------------------------------------
// Where accounts live.
// ---------------------------------------------------------------------------

/**
 * The accounts folder: the installed Hive's `%LOCALAPPDATA%\Hive\accounts`, a dev build's `Hive-Dev`'s, and a test
 * profile's own (under HIVE_USER_DATA), so no test reaches the user's.
 */
export function accountsRoot(): string {
  if (process.env.HIVE_USER_DATA) return join(process.env.HIVE_USER_DATA, 'accounts')
  const local = process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local')
  return join(local, profileFolder(app.isPackaged), 'accounts')
}

export const accountFolder = (id: string): string => join(accountsRoot(), id)

const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

function list(): Connection[] {
  return config.get().connections ?? []
}

export function getAccount(id: string): Connection | undefined {
  return list().find((a) => a.id === id)
}

function changeAccounts(fn: (connections: Connection[]) => void): void {
  config.update((c) => {
    c.connections = [...(c.connections ?? [])]
    fn(c.connections)
  })
  emit({ type: 'connections-changed' })
}

function changeAccount(id: string, fn: (a: Connection) => void): void {
  changeAccounts((all) => {
    const i = all.findIndex((a) => a.id === id)
    if (i >= 0) {
      const next = structuredClone(all[i])
      fn(next)
      all[i] = next
    }
  })
  // Its plan usage is a login's (HI-1756): another login's figures go once it is signed in as someone else.
  connectionLoginChanged(id)
}

// ---------------------------------------------------------------------------
// Refusals, in the user's language.
// ---------------------------------------------------------------------------

const NO_NAME = msg({ id: 'main.accounts.noName', defaultMessage: 'Give the connection a name.', description: 'An error adding or renaming a connection in Settings → Connections: its name is empty.' })
const NO_ACCOUNT = msg({ id: 'main.accounts.notFound', defaultMessage: 'There is no such connection.', description: 'An error: a connection named by its id is not in Settings → Connections (removed meanwhile).' })

function mustGet(id: string): Connection {
  const a = getAccount(id)
  if (!a) throw hiveError(NO_ACCOUNT, undefined, { kind: 'notFound' })
  return a
}

/**
 * Refuses a sign-in or removal while the CLI's own check of the folder isn't confirmed ended (HI-1757: Codex's app
 * server, held by codexChecks.ts until it is gone, across a restart too).
 */
function assertNotHeld(a: Connection): void {
  if (!provider(a.provider).accountHeld?.(accountFolder(a.id))) return
  throw hiveError(msg({ id: 'main.accounts.checkHeld', defaultMessage: "{name} is being checked: Hive is still making sure {cli}'s check of it has ended. Try again in a moment.", description: "An error signing in or removing a connection ({name}, its name in Settings → Connections): the coding agent CLI's ({cli}: \"Codex\") check of who it is signed in as hasn't been confirmed ended yet, so the connection is held." }), { name: a.name, cli: providerDescriptor(a.provider).name }, { kind: 'conflict' })
}

/** Whether the CLI's sign-in names an organisation, which an identity then needs (HI-1757: Codex's names none). */
const namesOrgs = (id: ProviderId): boolean => providerDescriptor(id).capabilities.connections?.orgs !== false

/** The provider's account support, or a refusal: one without it can't have accounts in Hive. */
function support(id: ProviderId): { homeEnv: string; shared: readonly string[]; adapter: ReturnType<typeof provider> } {
  const caps = providerDescriptor(id).capabilities.connections
  const adapter = provider(id)
  if (!caps || !adapter.accountStatus || !adapter.accountSharedTarget || !adapter.configHome) throw hiveError(msg({ id: 'main.accounts.noProvider', defaultMessage: "{cli} can't have sign-in connections in Hive yet.", description: 'An error: connections were asked for a coding agent CLI ({cli}: "Codex") that Hive keeps no connections for.' }), { cli: providerDescriptor(id).name }, { kind: 'invalid' })
  return { homeEnv: caps.homeEnv, shared: caps.shared, adapter }
}

// ---------------------------------------------------------------------------
// One change at a time per account, across every window (one main process).
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>()

function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  locks.set(id, tail)
  void tail.then(() => {
    if (locks.get(id) === tail) locks.delete(id)
  })
  return run
}

/** Launches under way on each account (HI-1755 takes one from confirm until its session is live or failed). */
const claims = new Map<string, number>()

/**
 * Takes a launch's claim on an account (HI-1755 holds it through the launch's start): taken under the account's lock,
 * so never while a removal runs, and only on an account still there whose folder is the one Hive made. Removal is
 * refused while one is held. Returns its release.
 */
export async function claimAccount(id: string): Promise<() => void> {
  await locked(id, async () => {
    await assertUsable(mustGet(id))
    claims.set(id, (claims.get(id) ?? 0) + 1)
  })
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (claims.get(id) ?? 1) - 1
    if (n > 0) claims.set(id, n)
    else claims.delete(id)
  }
}

/** Whether something runs on the account (HI-1755 adds its live sessions): removal is refused meanwhile. */
let sessionsOn: (id: string) => boolean = () => false
export function setAccountSessions(fn: (id: string) => boolean): void {
  sessionsOn = fn
}

/** Its sign-in's terminal (a server connection's Set Up, HI-1772): one per connection, refusing removal while open. */
export const loginKey = (a: Pick<Connection, 'id' | 'provider'>): string => `task:${a.provider}:login:${a.id}`

/** A server connection's (HI-1772): nothing to sign in, check or watch; its key in the key store. */
export const isServer = (a: Pick<Connection, 'kind'> | undefined): boolean => a?.kind === 'server'

/** For serverConnections.ts (HI-1772): a connection's lock, and its changes, as this module's own take them. */
export const connectionInternals = {
  locked: <T>(id: string, fn: () => Promise<T>): Promise<T> => locked(id, fn),
  mustGet: (id: string): Connection => mustGet(id),
  change: (id: string, fn: (a: Connection) => void): void => changeAccount(id, fn),
  inUse: (a: Connection): boolean => sessionsOn(a.id) || (claims.get(a.id) ?? 0) > 0 || loginsOpen.has(a.id) || hasPty(loginKey(a)),
  assertUsable: (a: Connection): Promise<void> => assertUsable(a)
}

/** Accounts whose sign-in is open (from its start, under the lock, to its end): removal is refused meanwhile. */
const loginsOpen = new Set<string>()

/** Each account's generation: removing it (or making it again) moves it on, so a check started before is dropped. */
const generations = new Map<string, number>()
const generation = (id: string): number => generations.get(id) ?? 0

// ---------------------------------------------------------------------------
// The folder and its junctions.
// ---------------------------------------------------------------------------

/** For tests: run before each delete of a removal (with the folder it is in), to change the folder meanwhile. */
export const accountTestHooks: { beforeDelete?: (dir: string) => Promise<void> } = {}

/** Why a folder can't be used or removed safely, in English (the log and `leftover`), with the text for the user. */
class Unsafe extends Error {}

/** Checks the accounts folder and an account's folder are real folders (not links), and the latter where it should be. */
async function assertRealFolder(dir: string): Promise<void> {
  for (const d of [accountsRoot(), dir]) {
    const st = await lstat(d)
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Unsafe(`${d} isn't a folder of its own (a link or a file)`) // i18n-ignore: for the log
  }
  if (!samePath(await realpath(dir), dir)) throw new Unsafe(`${dir} resolves elsewhere`) // i18n-ignore: for the log
}

/** A shared folder's target, checked: absolute, in the CLI's own home, neither the accounts folder nor in it. */
function sharedTarget(id: ProviderId, name: string): string {
  const { adapter } = support(id)
  const target = resolve(adapter.accountSharedTarget!(name))
  const home = resolve(adapter.configHome!())
  const root = resolve(accountsRoot()).toLowerCase()
  const t = target.toLowerCase()
  if (!samePath(resolve(target, '..'), home) || t === root || t.startsWith(root + '\\') || root.startsWith(t + '\\'))
    throw hiveError(msg({ id: 'main.accounts.badTarget', defaultMessage: "Hive won't link a connection to {target}: it isn't one of {cli}'s own folders.", description: "An error adding a connection: the folder a connection's shared folder would link to ({target}, a path) isn't in the coding agent CLI's ({cli}) own folder." }), { target, cli: providerDescriptor(id).name }, { kind: 'invalid' })
  return target
}

/** How a link in an account's folder stands: absent, the junction Hive made, or something else (refused). */
async function linkState(link: string, target: string): Promise<'absent' | 'ours' | string> {
  let st
  try {
    st = await lstat(link)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw e
  }
  if (!st.isSymbolicLink()) return st.isDirectory() ? 'a real folder' : 'a file' // i18n-ignore: for the log
  const to = await readlink(link)
  return samePath(to, target) ? 'ours' : `a link to ${to}` // i18n-ignore: for the log
}

/** Makes an account's folder and its junctions (each checked), or throws, having removed what it made. */
async function makeFolder(a: Connection): Promise<void> {
  const dir = accountFolder(a.id)
  const { shared } = support(a.provider)
  await mkdir(accountsRoot(), { recursive: true })
  await mkdir(dir)
  try {
    await assertRealFolder(dir)
    for (const name of shared) {
      const target = sharedTarget(a.provider, name)
      // Missing (the CLI never ran here): the empty folder, its home's only change Hive ever makes (Darren, 26 Oct). Not
      // its home: refused, rather than made.
      await mkdir(target).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'EEXIST') return
        if (e.code === 'ENOENT') throw hiveError(msg({ id: 'main.accounts.noHome', defaultMessage: "{cli}'s folder ({folder}) isn't there yet: run {cli} once, then add the connection.", description: "An error adding a connection: the coding agent CLI's ({cli}) own folder ({folder}, a path) doesn't exist on this PC." }), { cli: providerDescriptor(a.provider).name, folder: resolve(target, '..') }, { kind: 'conflict' })
        throw e
      })
      const tst = await lstat(target)
      if (tst.isSymbolicLink() || !tst.isDirectory()) throw new Unsafe(`${target} isn't a folder`) // i18n-ignore: for the log
      const link = join(dir, name)
      await symlink(target, link, 'junction')
      if ((await linkState(link, target)) !== 'ours') throw new Unsafe(`${link} isn't the junction Hive made`) // i18n-ignore: for the log
    }
  } catch (e) {
    await removeFolder(a).catch((r) => log.warn(`couldn't take back the half-made folder of account ${a.id}: ${userText(String(r))}`))
    throw e
  }
}

/** The entries of a folder, each with its own lstat, and the folder's identity before and after reading them. */
async function entries(dir: string): Promise<{ ino: number; items: { path: string; link: boolean; dir: boolean }[] }> {
  const before = await lstat(dir)
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Unsafe(`${dir} changed into a link while it was removed`) // i18n-ignore: for the log
  const names = await readdir(dir)
  const after = await lstat(dir)
  if (after.isSymbolicLink() || after.ino !== before.ino) throw new Unsafe(`${dir} was replaced while it was removed`) // i18n-ignore: for the log
  const items = []
  for (const n of names) {
    const p = join(dir, n)
    const st = await lstat(p)
    items.push({ path: p, link: st.isSymbolicLink(), dir: st.isDirectory() })
  }
  return { ino: before.ino, items }
}

/** Every link under a folder, never followed (the first pass of a removal: none may be there). */
async function linksUnder(dir: string): Promise<string[]> {
  const { items } = await entries(dir)
  const out: string[] = []
  for (const it of items) {
    if (it.link) out.push(it.path)
    else if (it.dir) out.push(...(await linksUnder(it.path)))
  }
  return out
}

/**
 * Deletes a folder that has no links in it, deepest first, checking before each delete that the folder it is in is
 * still the one read (not replaced by a link meanwhile), and stopping at any link found, so it can never reach outside.
 */
async function deleteTree(dir: string): Promise<void> {
  const { ino, items } = await entries(dir)
  const same = async (): Promise<void> => {
    await accountTestHooks.beforeDelete?.(dir)
    const st = await lstat(dir)
    if (st.isSymbolicLink() || st.ino !== ino) throw new Unsafe(`${dir} was replaced while it was removed`) // i18n-ignore: for the log
  }
  for (const it of items) {
    if (it.link) throw new Unsafe(`${it.path} is a link, added while the folder was removed`) // i18n-ignore: for the log
    if (it.dir) await deleteTree(it.path)
    else {
      await same()
      await unlink(it.path)
    }
  }
  await same()
  await rmdir(dir)
}

/**
 * Removes an account's folder for good (Darren, 26 Oct: its login with it, not to the Recycle Bin): its junctions
 * first (each the link alone, checked gone; one already gone is a removal tried again), then, only with no link left in
 * it, the folder. Anything unexpected (a real folder where a junction should be, a link elsewhere, the folder itself a
 * link) stops it before anything is deleted. Throws Unsafe or the file system's error; what is left stays.
 */
async function removeFolder(a: Connection): Promise<void> {
  const dir = accountFolder(a.id)
  // One renamed aside by an earlier try that stopped: finished first.
  await finishRemoving(removingFolder(a.id))
  if (!(await exists(dir))) return
  await assertRealFolder(dir)
  const caps = providerDescriptor(a.provider).capabilities.connections
  for (const name of caps?.shared ?? []) {
    const link = join(dir, name)
    const target = sharedTarget(a.provider, name)
    const state = await linkState(link, target)
    if (state === 'absent') continue
    if (state !== 'ours') throw new Unsafe(`${link} is ${state}, not the junction Hive made`) // i18n-ignore: for the log
    // The link alone (unlink removes a junction, never what it points at: tests/accounts.test.ts).
    await unlink(link)
    if ((await linkState(link, target)) !== 'absent') throw new Unsafe(`${link} is still there after it was removed`) // i18n-ignore: for the log
  }
  const links = await linksUnder(dir)
  if (links.length) throw new Unsafe(`links Hive didn't make are in it: ${links.join(', ')}`) // i18n-ignore: for the log
  // Renamed aside, one rename that follows nothing, so no account is ever at its own path half deleted; then deleted
  // there by the walk. The threat model (the Assistant's call on HI-980, 26 Oct): Hive's own junction, the CLI's
  // writes and the user's changes before removal began, not another process racing the walk (SPEC §11.2).
  const aside = removingFolder(a.id)
  await rename(dir, aside)
  await finishRemoving(aside)
}

/** Where an account's folder goes while it is deleted (`<accounts>\.removing-<id>`). */
const removingFolder = (id: string): string => join(accountsRoot(), `${REMOVING}${id}`)
const REMOVING = '.removing-'

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

/** Deletes a folder renamed aside for removal, if there is one: a real folder, with no link anywhere in it. */
async function finishRemoving(aside: string): Promise<void> {
  if (!(await exists(aside))) return
  await assertRealFolder(aside)
  const links = await linksUnder(aside)
  if (links.length) throw new Unsafe(`links Hive didn't make are in it: ${links.join(', ')}`) // i18n-ignore: for the log
  await deleteTree(aside)
}

let leftoversDone = false
/** Once, at start (the first time accounts are used): finishLeftoverRemovals. */
function startLeftovers(): void {
  if (leftoversDone) return
  leftoversDone = true
  void finishLeftoverRemovals()
  // Keys of connections no longer there, or no longer server connections (a config restored from its backup): gone.
  void dropKeysExcept(() => new Set(list().filter(isServer).map((a) => a.id))).catch((e) => log.warn(`old keys couldn't be removed: ${userText(String((e as Error).message ?? e))}`))
}

/** Finishes removals a crash or a quit stopped, their folders renamed aside (`.removing-<id>`). */
export async function finishLeftoverRemovals(): Promise<void> {
  let names: string[]
  try {
    names = await readdir(accountsRoot())
  } catch {
    return
  }
  for (const n of names.filter((x) => x.startsWith(REMOVING))) {
    await finishRemoving(join(accountsRoot(), n)).catch((e) => log.warn(`a removed account's folder ${n} couldn't be finished: ${userText(String((e as Error).message ?? e))}`))
  }
}

// ---------------------------------------------------------------------------
// Add, rename, remove.
// ---------------------------------------------------------------------------

/**
 * Adds a connection, its folder and junctions made and checked; then the window offers its Sign in (a sign-in
 * connection) or it is ready to use (a server connection, HI-1772: `server` given, checked by serverConnections.ts).
 */
export async function addAccount(id: ProviderId, name: string, server?: ServerConnection): Promise<Connection> {
  support(id)
  const n = name.trim()
  if (!n) throw hiveError(NO_NAME, undefined, { kind: 'invalid' })
  // Its defaults (HI-1770, HI-1774): the CLI's old per-CLI ones for its first sign-in connection only (they are migration
  // input, taken once: takeCliDefaults), else none, the CLI deciding; a server's models aren't the CLI's, so none.
  const base = { id: `a-${randomBytes(4).toString('hex')}`, provider: id, name: n, createdAt: new Date().toISOString() }
  const a: Connection = server ? { ...base, kind: 'server', server, defaults: {} } : { ...base, kind: 'signIn', defaults: {} }
  return locked(a.id, async () => {
    try {
      await makeFolder(a)
    } catch (e) {
      log.warn(`account ${a.id} couldn't be made: ${userText(String(e))}`)
      if (e instanceof Unsafe) throw hiveError(msg({ id: 'main.accounts.makeFailed', defaultMessage: "Couldn't make the connection's folder: {error}", description: "An error adding a connection: its folder or link couldn't be made. {error} is the reason, in English." }), { error: e.message })
      throw e
    }
    generations.set(a.id, generation(a.id) + 1)
    let added = a
    config.update((c) => {
      added = a.kind === 'signIn' ? takeCliDefaults(c, a) : a
      c.connections = [...(c.connections ?? []), added]
      // Its notice (HI-1774) has done its job: never shown again, even with every connection removed later.
      c.ui.connectionsIntroShown = true
    })
    emit({ type: 'connections-changed' })
    log.info(`account ${a.id} added (${a.provider})`)
    syncWatches()
    return added
  })
}

/**
 * A connection's defaults for the agents on it (HI-1770): model, effort and context, each '' or null to leave it to the
 * CLI. Edited, they are the user's (no longer the CLI's as copied).
 */
export function setConnectionDefaults(id: string, patch: { model?: string | null; effort?: string | null; use200kContext?: boolean | null }): void {
  const a = mustGet(id)
  const next: ConnectionDefaults = { ...a.defaults }
  if (patch.model !== undefined) next.model = patch.model?.trim() || undefined
  if (patch.effort !== undefined) next.effort = patch.effort?.trim() || undefined
  if (patch.use200kContext !== undefined) next.use200kContext = providerDescriptor(a.provider).capabilities.contextLimit && typeof patch.use200kContext === 'boolean' ? patch.use200kContext : undefined
  for (const k of Object.keys(next) as (keyof ConnectionDefaults)[]) if (next[k] === undefined) delete next[k]
  changeAccount(id, (c) => {
    c.defaults = next
    delete c.defaultsFrom
  })
}

/**
 * A connection given the CLI's old per-CLI model, effort and context (Settings → <CLI> before connections, kept in
 * config only as migration input: HI-1774), if its CLI's haven't been given yet; recorded in the same write, so they
 * are taken once, by the first sign-in connection of an upgrade from 0.9. Inside the config.update adding it.
 */
function takeCliDefaults(c: AppConfig, a: Connection): Connection {
  const taken = c.connectionDefaultsTaken ?? []
  if (taken.includes(a.provider)) return a
  c.connectionDefaultsTaken = [...taken, a.provider]
  // A connection of its CLI made before this record (a preview's) had them already: recorded as taken, not given again.
  if ((c.connections ?? []).some((x) => x.provider === a.provider)) return a
  return { ...a, defaults: cliDefaults(c.settings, a.provider), defaultsFrom: 'cli' }
}

/**
 * The connections from before this record (a preview's, HI-1774 round 1): connections made before they had defaults
 * (HI-1755's) get the CLI's old ones (HI-1770), only where `defaults` is absent (one the user emptied or edited is never
 * filled in again); and every CLI with a connection, whatever its defaults, is recorded as having taken them, so none is
 * given them again, even once those connections are removed.
 */
export function seedConnectionDefaults(): void {
  const all = list()
  const taken = config.get().connectionDefaultsTaken ?? []
  if (!all.some((a) => a.defaults === undefined || !taken.includes(a.provider))) return
  config.update((c) => {
    c.connections = (c.connections ?? []).map((a) => (a.defaults === undefined ? { ...a, defaults: cliDefaults(c.settings, a.provider), defaultsFrom: 'cli' as const } : a))
    c.connectionDefaultsTaken = [...new Set([...(c.connectionDefaultsTaken ?? []), ...c.connections.map((a) => a.provider)])]
  })
  emit({ type: 'connections-changed' })
}

export function renameAccount(id: string, name: string): void {
  mustGet(id)
  const n = name.trim()
  if (!n) throw hiveError(NO_NAME, undefined, { kind: 'invalid' })
  changeAccount(id, (a) => (a.name = n))
}

/**
 * Removes an account: refused while anything runs on it (its agents, a launch, its sign-in). Its folder goes for good
 * (removeFolder); the account stays listed, saying what's left, until that succeeds.
 */
export async function removeAccount(id: string): Promise<void> {
  const a = mustGet(id)
  const inUse = (): boolean => sessionsOn(id) || (claims.get(id) ?? 0) > 0 || loginsOpen.has(id) || hasPty(loginKey(a))
  const IN_USE = msg({ id: 'main.accounts.inUse', defaultMessage: '{name} is in use: stop the agents on it and close its sign-in, then remove it.', description: 'An error removing a connection ({name}, its name in Settings → Connections): agents run on it, or its sign-in terminal is open.' })
  if (inUse()) throw hiveError(IN_USE, { name: a.name }, { kind: 'conflict' })
  assertNotHeld(a)
  await locked(id, async () => {
    // Asked again under the lock: a launch or sign-in may have started while it waited.
    if (inUse()) throw hiveError(IN_USE, { name: a.name }, { kind: 'conflict' })
    assertNotHeld(a)
    // A server connection's key goes first (HI-1772): if that fails, nothing else is removed, the row still shows its
    // key, and Remove tries again; a later failure leaves no key behind.
    if (isServer(a)) {
      try {
        await removeKey(id)
      } catch (e) {
        log.warn(`connection ${id}'s key couldn't be removed: ${userText(String((e as Error).message ?? e))}`)
        throw hiveError(msg({ id: 'main.accounts.keyRemoveFailed', defaultMessage: "{name} wasn't removed: its key couldn't be deleted. Nothing was changed; Remove tries again.", description: "An error removing a server connection ({name}, its name in Settings → Connections): its stored API key couldn't be deleted, so the connection was left as it was." }), { name: a.name }, { kind: 'conflict' })
      }
    }
    // Checks started before are dropped from here (their result would bring it back).
    generations.set(id, generation(id) + 1)
    unwatch(id)
    try {
      await removeFolder(a)
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      log.warn(`account ${id}'s folder couldn't all be removed: ${userText(why)}`)
      changeAccount(id, (x) => (x.leftover = why))
      syncWatches()
      throw hiveError(msg({ id: 'main.accounts.removeFailed', defaultMessage: "{name} wasn't removed: {error}. Nothing outside its folder was touched; Remove tries again.", description: "An error removing a connection ({name}): its folder couldn't all be deleted. {error} is the reason, in English." }), { name: a.name, error: why }, { kind: 'conflict' })
    }
    changeAccounts((all) => all.splice(0, all.length, ...all.filter((x) => x.id !== id)))
    config.update((c) => {
      for (const [p, v] of Object.entries(c.lastUsedConnection ?? {})) if (v === id) delete c.lastUsedConnection![p as ProviderId]
    })
    forgetConnectionUsage(id)
    log.info(`account ${id} removed`)
    syncWatches()
  })
}

// ---------------------------------------------------------------------------
// Who it is signed in as.
// ---------------------------------------------------------------------------

/** Running checks, at most CHECKS_AT_ONCE: the others wait their turn. */
let running = 0
const waiting: (() => void)[] = []
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= CHECKS_AT_ONCE) await new Promise<void>((r) => waiting.push(r))
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/** Per account: the check under way, and the one queued after it (asked for while it ran). */
const inFlight = new Map<string, { now: Promise<ConnectionObserved | null>; next?: Promise<ConnectionObserved | null> }>()
/** Per account: how many changes its watch has seen (confirm checks again while it moves). */
const changes = new Map<string, number>()

/** Reads the folder's sign-in from the CLI, and keeps it as `observed` unless the account was removed meanwhile. */
async function checkOnce(id: string): Promise<ConnectionObserved | null> {
  const a = getAccount(id)
  // A server connection has no sign-in to check (HI-1772).
  if (!a || isServer(a)) return null
  const gen = generation(id)
  const dir = accountFolder(id)
  const at = new Date().toISOString()
  let observed: ConnectionObserved
  try {
    await assertRealFolder(dir)
    const { homeEnv, adapter } = support(a.provider)
    const exe = providerService.info(a.provider).path
    if (!exe) observed = { ...a.observed, at, loggedIn: null, error: `${adapter.descriptor.name} isn't installed` } // i18n-ignore: for the log
    else {
      const s = await slot(() => adapter.accountStatus!(exe, withoutAccountEnv(adapter, childEnv({ [homeEnv]: dir }))))
      observed = s.ok ? { at, loggedIn: s.loggedIn, ...(s.loggedIn ? { email: s.email, orgId: s.orgId, plan: s.plan ?? null } : {}) } : { ...keptIdentity(a.observed), at, loggedIn: null, error: s.error }
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    observed = code === 'ENOENT' || e instanceof Unsafe ? { at, loggedIn: null, missing: true } : { ...keptIdentity(a.observed), at, loggedIn: null, error: String((e as Error).message ?? e) }
  }
  // Removed (or made again) while it ran: its answer is about a folder that's gone.
  if (generation(id) !== gen || !getAccount(id)) return null
  if (observed.error) log.warn(`account ${id}'s check failed: ${userText(observed.error)}`)
  changeAccount(id, (x) => (x.observed = observed))
  if (observed.loggedIn === true) for (const fn of signedInListeners) fn(id)
  return observed
}

/** The last good identity, kept beside a failed check (shown as it was, with "Couldn't check"). */
const keptIdentity = (o: ConnectionObserved | undefined): Partial<ConnectionObserved> => (o && !o.error && !o.missing && o.loggedIn ? { email: o.email, orgId: o.orgId, plan: o.plan } : {})

/**
 * Checks an account's sign-in, by a check that starts after this call: one under way is joined only by the check queued
 * after it, so a change seen while it ran is always checked again. Null: the account is gone.
 */
export function checkAccount(id: string): Promise<ConnectionObserved | null> {
  const f = inFlight.get(id)
  if (!f) return startCheck(id)
  // Started once the one under way ends: it becomes the one under way then (startCheck), for callers after it.
  f.next ??= f.now.catch(() => null).then(() => startCheck(id))
  return f.next
}

function startCheck(id: string): Promise<ConnectionObserved | null> {
  const now = locked(id, () => checkOnce(id))
  inFlight.set(id, { now })
  void now
    .catch(() => null)
    .then(() => {
      // Its queued check, if any, takes its place as it starts.
      const e = inFlight.get(id)
      if (e?.now === now && !e.next) inFlight.delete(id)
    })
  return now
}

/**
 * Who an account is signed in as for a launch (HI-1755): a fresh check, run again while its login keeps changing
 * under it (at most CONFIRM_ROUNDS), so a launch never goes ahead on an answer older than the folder. `fresh: false`
 * when it kept changing. The login is stamped before and after each check itself (HI-1873): a change whose event the
 * watch hasn't delivered or compared yet still counts, and a busy folder's other writes never do.
 */
export async function confirmAccount(id: string): Promise<{ observed: ConnectionObserved | null; fresh: boolean }> {
  let observed: ConnectionObserved | null = null
  for (let i = 0; i < CONFIRM_ROUNDS; i++) {
    const seen = changes.get(id) ?? 0
    const before = await loginStamp(id)
    observed = await checkAccount(id)
    const after = await loginStamp(id)
    if (before === after && (changes.get(id) ?? 0) === seen) return { observed, fresh: true }
  }
  return { observed, fresh: false }
}

/**
 * Opens the account's sign-in: the CLI's own login in a terminal of Hive's, on its folder. Once it ends, the account is
 * checked; its first good login becomes the one accepted. Returns the terminal's key.
 */
export function signInAccount(id: string): Promise<string> {
  return openLoginTerminal(id, false)
}

/**
 * Opens a sign-in connection's Set Up (HI-1826): the CLI itself on its folder, so the user answers its first-run screens
 * (its theme, its notes), which a browser sign-in (`claude auth login`) leaves unanswered, before an agent starts on it.
 * Hive types nothing and writes none of its files. The terminal is the sign-in's (one of the two at a time), and once it
 * ends the account is checked as after a sign-in. Returns the terminal's key.
 */
export function setUpSignInConnection(id: string): Promise<string> {
  return openLoginTerminal(id, true)
}

async function openLoginTerminal(id: string, setUp: boolean): Promise<string> {
  // A server connection has no sign-in: its Set Up opens the CLI instead (serverConnections.ts).
  if (isServer(mustGet(id))) throw hiveError(NO_ACCOUNT, undefined, { kind: 'invalid' })
  // Started under the account's lock, so never while it is being removed: the account checked still there (a removal
  // before it wins), and its folder still the one Hive made (a folder replaced by a link would take the CLI's login
  // writes elsewhere).
  return locked(id, async () => {
    const a = mustGet(id)
    const { homeEnv } = support(a.provider)
    await assertUsable(a)
    assertNotHeld(a)
    const gen = generation(id)
    loginsOpen.add(id)
    try {
      return providerService.runAccountLogin(a.provider, id, { [homeEnv]: accountFolder(id) }, () => {
        loginsOpen.delete(id)
        void checkAccount(id).then((o) => {
          if (generation(id) !== gen) return
          const ok = acceptable(o ?? undefined, namesOrgs(a.provider))
          // Only a good, signed-in answer is taken on, and only when none is yet; a different one is a change to answer.
          if (ok && !getAccount(id)?.accepted) changeAccount(id, (x) => (x.accepted = ok))
        })
      }, setUp ? { env: {}, cwd: accountFolder(id) } : undefined)
    } catch (e) {
      loginsOpen.delete(id)
      throw e
    }
  })
}

/**
 * Refuses an account that can't be used now: half removed, or its folder not the one Hive made (missing, or replaced by
 * a link). Called under its lock, before anything is started on it.
 */
async function assertUsable(a: Connection): Promise<void> {
  if (a.leftover) throw hiveError(msg({ id: 'main.accounts.leftover', defaultMessage: '{name} is half removed: remove it again first.', description: "An error signing a connection in ({name}): an earlier removal stopped partway, so it can't be used." }), { name: a.name }, { kind: 'conflict' })
  try {
    await assertRealFolder(accountFolder(a.id))
  } catch (e) {
    log.warn(`account ${a.id}'s folder can't be used: ${userText(String((e as Error).message ?? e))}`)
    throw hiveError(msg({ id: 'main.accounts.folderNotUsable', defaultMessage: "{name}'s folder isn't the one Hive made (it is missing, or was moved or replaced), so nothing was started on it. Remove the connection and add it again.", description: "An error signing a connection in or starting on it ({name}, its name): its folder is missing or isn't the one Hive made." }), { name: a.name }, { kind: 'conflict' })
  }
}

/** Keeps the login an account is now signed in as (its change answered): refused without a good one to keep. */
export function keepNewLogin(id: string): void {
  const a = mustGet(id)
  const ok = acceptable(a.observed, namesOrgs(a.provider))
  if (!ok) throw hiveError(msg({ id: 'main.accounts.nothingToKeep', defaultMessage: "{name} isn't signed in as anyone Hive could check, so there's no login to keep.", description: "An error: Keep the new login was asked for a connection ({name}) whose latest check didn't find it signed in." }), { name: a.name }, { kind: 'conflict' })
  changeAccount(id, (x) => (x.accepted = ok))
}

// ---------------------------------------------------------------------------
// Watches: an account's login files, and the accounts folder for a folder replaced.
// ---------------------------------------------------------------------------

interface Watched {
  w: FSWatcher | null
  timer: NodeJS.Timeout | null
  retry: NodeJS.Timeout | null
  tries: number
  /** The login as last seen (loginStamp): an event counts as a change only when it moved (HI-1873). Unset: not seen yet. */
  stamp?: string | null
  /** The comparisons, one at a time: the last one queued. */
  comparing: Promise<void> | null
  /** A comparison is queued and not started yet: it covers events until it starts. */
  queued: boolean
}
const watched = new Map<string, Watched>()
let rootWatch: FSWatcher | null = null

/** The accounts on in any open workspace: those watched (HI-1755 adds those its sessions run on). */
function wantedIds(): Set<string> {
  const out = new Set<string>()
  const all = list()
  for (const w of openWorkspaces()) for (const p of PROVIDERS) for (const id of workspaceAccounts(w.config, p.id, all)?.on ?? []) out.add(id)
  for (const a of all) if (sessionsOn(a.id)) out.add(a.id)
  // A server connection's folder holds no login to watch (HI-1772).
  for (const a of all) if (isServer(a)) out.delete(a.id)
  return out
}

/** A change seen on an account (its watch's, or a test's): counted (confirm asks again) and checked once things settle. */
export const accountChanged = (id: string): void => changed(id)

function changed(id: string): void {
  changes.set(id, (changes.get(id) ?? 0) + 1)
  const w = watched.get(id)
  if (!w) return
  if (w.timer) clearTimeout(w.timer)
  w.timer = setTimeout(() => {
    w.timer = null
    void checkAccount(id)
  }, DEBOUNCE_MS)
}

/**
 * What a change to an account's login moves, never reading a file: its folder's identity (made again or replaced) and
 * each login file's id, size and write time. Not its access or change times: a CLI reading the login, or Codex's sandbox
 * setting ACLs over the folder, moves those (HI-1873). Null for a provider naming no login files: every event counts,
 * as before, and only events count at a launch.
 */
async function loginStamp(id: string): Promise<string | null> {
  const a = getAccount(id)
  const isLogin = a && provider(a.provider).accountLoginFile?.bind(provider(a.provider))
  if (!isLogin) return null
  const dir = accountFolder(id)
  try {
    const d = await lstat(dir, { bigint: true })
    const parts = [`${d.isDirectory() ? 'dir' : 'other'}:${d.ino}`]
    for (const name of (await readdir(dir)).filter(isLogin).sort()) {
      const s = await lstat(join(dir, name), { bigint: true }).catch(() => null)
      parts.push(s ? `${name}:${s.ino}:${s.size}:${s.mtimeNs}` : `${name}:gone`)
    }
    return parts.join('|')
  } catch (e) {
    return `error:${(e as NodeJS.ErrnoException).code ?? String(e)}`
  }
}

/** The folder's identity, from a stamp: when it moves, the folder was made again or replaced, and is watched again. */
const folderOf = (stamp: string | null | undefined): string | undefined => stamp?.split('|')[0]

/**
 * Something happened in or to an account's folder (its watch, or the accounts folder's): counted as a change only when
 * the login moved since it was last seen. A busy folder (agents' logs and databases, Codex's sandbox) reports events
 * all the time, some with no file name on Windows, and counting each kept every launch's check from settling (HI-1873).
 * Compared one at a time; events before a queued comparison starts are covered by it.
 */
function noticed(id: string): void {
  const w = watched.get(id)
  if (!w || w.queued) return
  w.queued = true
  const run = (w.comparing ?? Promise.resolve()).then(async () => {
    w.queued = false
    if (watched.get(id) !== w) return
    const stamp = await loginStamp(id)
    if (watched.get(id) !== w || (stamp !== null && stamp === w.stamp)) return
    const moved = folderOf(stamp) !== folderOf(w.stamp)
    w.stamp = stamp
    if (moved) attach(id)
    changed(id)
  })
  w.comparing = run
  void run.finally(() => {
    if (w.comparing === run) w.comparing = null
  })
}

/** Whether an account's folder is watched now, its login seen (tests wait for it). */
export const accountWatched = (id: string): boolean => !!watched.get(id)?.w

/** An event in an account's folder (its watch's, or a test's): a login file's, or one with no name, is compared. */
export function accountFolderEvent(id: string, name: string | Buffer | null): void {
  const a = getAccount(id)
  if (!a) return
  const isLogin = provider(a.provider).accountLoginFile
  // No name (some changes on Windows, a busy folder's above all): compared like a login file's.
  if (typeof name !== 'string' || !isLogin || isLogin.call(provider(a.provider), name)) noticed(id)
}

function attach(id: string): void {
  const w = watched.get(id)
  if (!w) return
  w.w?.close()
  w.w = null
  if (!getAccount(id)) return
  void assertRealFolder(accountFolder(id)).then(
    async () => {
      if (watched.get(id) !== w) return
      // The login as it is before the watch starts: what its events are compared with (a change after it is seen).
      const stamp = await loginStamp(id)
      if (watched.get(id) !== w || w.w) return
      w.stamp = stamp
      try {
        const fw = watch(accountFolder(id), { persistent: false })
        fw.on('change', (_kind, name) => accountFolderEvent(id, name))
        fw.on('error', (e) => lost(id, e))
        w.w = fw
        w.tries = 0
      } catch (e) {
        lost(id, e)
      }
    },
    // Not there, or not the folder Hive made: missing until the accounts folder's watch sees it back.
    () => {
      if (watched.get(id) === w) void checkAccount(id)
    }
  )
}

/** A watch that failed: closed, and tried again with a bounded backoff while it is wanted (launches check anyway). */
function lost(id: string, e: unknown): void {
  const w = watched.get(id)
  if (!w) return
  log.warn(`account ${id}'s watch stopped: ${userText(String((e as Error)?.message ?? e))}`)
  w.w?.close()
  w.w = null
  if (w.retry) return
  const ms = RETRY_MS[w.tries] ?? RETRY_LATER_MS
  w.tries++
  w.retry = setTimeout(() => {
    w.retry = null
    if (watched.get(id) === w) {
      attach(id)
      changed(id)
    }
  }, ms)
}

function unwatch(id: string): void {
  const w = watched.get(id)
  if (!w) return
  watched.delete(id)
  w.w?.close()
  if (w.timer) clearTimeout(w.timer)
  if (w.retry) clearTimeout(w.retry)
}

/** The accounts folder's watch: an account's folder deleted, renamed or made again is watched again and checked. */
function syncRoot(): void {
  if (!watched.size) {
    rootWatch?.close()
    rootWatch = null
    return
  }
  if (rootWatch) return
  try {
    rootWatch = watch(accountsRoot(), { persistent: false })
    rootWatch.on('change', (_kind, name) => {
      const ids = typeof name === 'string' ? [name] : [...watched.keys()]
      // A folder's own events reach here too (its files written, made or deleted): only one made again counts (noticed).
      for (const id of ids) if (watched.has(id)) noticed(id)
    })
    rootWatch.on('error', (e) => {
      log.warn(`the accounts folder's watch stopped: ${userText(String(e.message))}`)
      rootWatch?.close()
      rootWatch = null
      setTimeout(syncRoot, RETRY_LATER_MS).unref()
    })
  } catch (e) {
    log.warn(`the accounts folder can't be watched: ${userText(String((e as Error).message ?? e))}`)
    rootWatch = null
  }
}

/** Watches the accounts wanted now, and no others; each newly watched is checked. */
export function syncWatches(): void {
  startLeftovers()
  const want = wantedIds()
  for (const id of [...watched.keys()]) if (!want.has(id)) unwatch(id)
  for (const id of want) {
    if (watched.has(id)) continue
    watched.set(id, { w: null, timer: null, retry: null, tries: 0, comparing: null, queued: false })
    attach(id)
    void checkAccount(id)
  }
  syncRoot()
}

/** Every watch closed (Hive quitting, tests). */
export function stopAccountWatches(): void {
  for (const id of [...watched.keys()]) unwatch(id)
  syncRoot()
}

// ---------------------------------------------------------------------------
// A workspace's choice of accounts.
// ---------------------------------------------------------------------------

/** What Settings → Accounts shows for the asking window's workspace; each account checked again as it is shown. */
export function accountsView(check = false): ConnectionsView {
  const all = list()
  if (check) for (const a of all) if (!isServer(a)) void checkAccount(a.id)
  void loadKeys()
  const providers = PROVIDERS.filter((p) => !!p.capabilities.connections && isProviderEnabled(config.settings, p.id)).map((p) => p.id)
  const cfg = workspace.path ? workspace.config : null
  const ws: ConnectionsView['workspace'] = {}
  for (const p of providers) {
    const w = workspaceAccounts(cfg, p, all)
    if (w) ws[p] = w
  }
  const testHome = providers.filter((p) => !connectionsManaged(p))
  // A server connection's key: only that one is set, its last 4 characters and when (keyStore.ts); never the key.
  const keyOf = (a: Connection): { key?: { last4: string; at: string } } => {
    const k = isServer(a) ? keyInfo(a.id) : undefined
    return k && k.origin === originOf(a.server?.baseUrl ?? '') ? { key: { last4: k.last4, at: k.at } } : {}
  }
  const intro = !config.get().ui.connectionsIntroShown && !all.length ? providers.filter((p) => !testHome.includes(p)) : []
  return { ...(intro.length ? { intro } : {}), providers, connections: all.map((a) => ({ ...shownServer(a), signingIn: hasPty(loginKey(a)), folder: accountFolder(a.id), ...keyOf(a) })), workspace: ws, testHome, masking: coverageView() }
}

/** Dismisses the one-time notice that agents run on connections (HI-1774), in every window. */
export function dismissConnectionsIntro(): void {
  if (config.get().ui.connectionsIntroShown) return
  config.update((c) => void (c.ui.connectionsIntroShown = true))
  emit({ type: 'connections-changed' })
}

/** Saves the asking window's workspace's accounts for a provider, worked out from how they are when it is written. */
async function saveChoice(fn: (cfg: WorkspaceConfig) => WorkspaceConfig['connections']): Promise<void> {
  await workspace.saveWorkspaceConfigWith((c) => ({ connections: fn(c) }))
  emit({ type: 'connections-changed' })
  syncWatches()
}

/** Turns an account on or off in the asking window's workspace (on, with no default yet: it becomes the default). */
export async function setAccountOn(id: string, on: boolean): Promise<void> {
  const a = mustGet(id)
  let chosen: string | null = null
  await saveChoice((c) => {
    const next = switchedOn(workspaceAccounts(c, a.provider, list()), id, on, list())
    chosen = next.default
    return { ...c.connections, [a.provider]: next }
  })
  if (chosen) noteLastUsed(a.provider, chosen)
}

/** Makes an account the asking window's workspace's default for its provider (turning it on if it isn't). */
export async function setAccountDefault(id: string): Promise<void> {
  const a = mustGet(id)
  await saveChoice((c) => {
    const cur = workspaceAccounts(c, a.provider, list())
    const on = switchedOn(cur, id, true, list())
    return { ...c.connections, [a.provider]: { on: on.on, default: id } }
  })
  noteLastUsed(a.provider, id)
}

/** The Assistant's own connection for a provider in the asking window's workspace (HI-1755); null: the default. */
export async function setAssistantConnection(id: ProviderId, connection: string | null): Promise<void> {
  if (connection) {
    const a = mustGet(connection)
    if (a.provider !== id) throw hiveError(NO_ACCOUNT, undefined, { kind: 'invalid' })
  }
  await workspace.saveWorkspaceConfigWith((c) => ({ assistantConnection: { ...c.assistantConnection, [id]: connection } }))
  emit({ type: 'connections-changed' })
}

/** The account a new workspace starts with (Darren, 26 Oct): the last chosen as a default, or launched on (HI-1755). */
export function noteLastUsed(id: ProviderId, accountId: string): void {
  if (config.get().lastUsedConnection?.[id] === accountId) return
  config.update((c) => (c.lastUsedConnection = { ...c.lastUsedConnection, [id]: accountId }))
}

/**
 * A new workspace's accounts (only when it is made: opening one never turns an account on): the last used of each
 * provider, on and its default. Undefined with none.
 */
export function newWorkspaceAccounts(): WorkspaceConfig['connections'] | undefined {
  const out: NonNullable<WorkspaceConfig['connections']> = {}
  for (const [p, id] of Object.entries(config.get().lastUsedConnection ?? {}) as [ProviderId, string][]) if (id && getAccount(id)?.provider === p) out[p] = { on: [id], default: id }
  return Object.keys(out).length ? out : undefined
}

// ---------------------------------------------------------------------------
// Launching on a connection (HI-1755).
// ---------------------------------------------------------------------------

/** A launch's connection: its folder given as the CLI's home, held (claimed) until the launch ends either way. */
export interface LaunchConnection {
  id: string
  name: string
  folder: string
  homeEnv: string
  /** Why it isn't exactly what was chosen, or what its check couldn't say: shown on the agent. */
  note?: 'offFallback' | 'unknownLogin' | 'loginChanged'
  /** Who it launches as, from its fresh check (planUsage.ts usageLogin; a check that failed keeps the last one): its usage's. */
  login?: string
  /** Ends the launch's claim: once its session runs (its live state then keeps it from removal) or it failed. */
  release: () => void
  /**
   * A server connection's (HI-1772): the variables its launch gets (its server, its models, its key: secret, given to
   * that launch's environment only and never kept), its models for the footer, and its key's use for masking, ended
   * by whoever holds the launch once its process is gone (or it never started); `local`, it runs only on this PC
   * (runsLocally).
   */
  server?: { env: Record<string, string>; models: ServerModel[]; local: boolean }
  /**
   * Asked at the last moment, with the agent's (or the Assistant's) choice as saved then: whether that choice, resolved
   * again with its workspace's connections as they are now, is still this connection, and it is still there.
   */
  stillValid: (wanted: string | null | undefined) => boolean
}

/** Told when a connection is found signed in (its check), with its id: sessions end that connection's sign-out wait. */
const signedInListeners: ((id: string) => void)[] = []
export function onConnectionSignedIn(fn: (id: string) => void): void {
  signedInListeners.push(fn)
}

/** A server connection's key replaced (HI-1772): as a sign-in found again, its agents stopped by a refused key carry on. */
export function connectionReadyAgain(id: string): void {
  for (const fn of signedInListeners) fn(id)
}

const LAUNCH = {
  none: msg({ id: 'main.connections.launch.none', defaultMessage: 'No {cli} connection is on in this workspace. Add one in Settings → Connections and sign it in, then start {agent} again.', description: "Starting an agent ({agent}, its name) is refused: its workspace has no connection on for its coding agent CLI ({cli}: \"Claude Code\"). Settings → Connections names a section." }),
  offNoDefault: msg({ id: 'main.connections.launch.offNoDefault', defaultMessage: "{agent}'s connection, {name}, is off in this workspace, and no other {cli} connection is on. Turn one on in Settings → Connections.", description: "Starting an agent ({agent}) is refused: the connection chosen for it ({name}) is off in this workspace and there's no default to use instead. {cli} is the coding agent CLI." }),
  deleted: msg({ id: 'main.connections.launch.deleted', defaultMessage: "The connection chosen for {agent} no longer exists. Pick another in its Agent Settings, or let it use the workspace's default.", description: 'Starting an agent ({agent}) is refused: the connection chosen for it was removed. Agent Settings names a dialog.' }),
  changedAgain: msg({ id: 'main.connections.launch.changedAgain', defaultMessage: "{agent}'s connection was changed again while it was starting. Start it again.", description: "Starting an agent ({agent}, its name) failed: the connection chosen for it was changed while it was starting, and again while Hive started it once more on the new choice. A connection is how a coding agent CLI signs in or reaches its model (Settings → Connections)." }),
  otherProvider: msg({ id: 'main.connections.launch.otherProvider', defaultMessage: 'The connection chosen for {agent} is for another CLI. Pick a {cli} connection in its Agent Settings.', description: 'Starting an agent ({agent}) is refused: the connection chosen for it belongs to another coding agent CLI. {cli} is the agent\'s CLI ("Claude Code").' }),
  signedOut: msg({ id: 'main.connections.launch.signedOut', defaultMessage: '{name} is signed out. Sign it in again in Settings → Connections, then start {agent}.', description: "Starting an agent ({agent}) is refused: its connection ({name}) isn't signed in." }),
  changing: msg({ id: 'main.connections.launch.changing', defaultMessage: "{name}'s login kept changing while Hive checked it. Try starting {agent} again in a moment.", description: "Starting an agent ({agent}) is refused: its connection's ({name}) login changed again and again while Hive checked who it is signed in as." }),
  noKey: msg({ id: 'main.connections.launch.noKey', defaultMessage: '{name} has no key. Add one in Settings → Connections, then start {agent}.', description: "Starting an agent ({agent}) is refused: its server connection ({name}) reaches a server that needs an API key, and none is saved for it. Settings → Connections names a section." })
}

/**
 * A server connection's launch variables (HI-1772), as its CLI's descriptor names them: its base URL, its key (or, for
 * a local server with none, the descriptor's placeholder, which isn't secret), each alias's model, its subagents' (the
 * haiku alias's) and its default model (the opus alias's, else sonnet's, else its first), so nothing asks the server
 * for a Claude model it doesn't have.
 */
export function serverEnv(caps: ServerCaps, server: ServerConnection, key: string | null): Record<string, string> {
  const alias = aliasModels(server.models)
  const env: Record<string, string> = { [caps.baseUrlEnv]: server.baseUrl, [caps.keyEnv]: key ?? caps.keylessToken }
  for (const a of MODEL_ALIASES) if (alias[a]) env[caps.aliasEnv[a]] = alias[a]!
  if (caps.subagentEnv && alias.haiku) env[caps.subagentEnv] = alias.haiku
  const main = serverDefaultModel(server.models)
  if (main) env[caps.modelEnv] = main
  return env
}

/**
 * Whether a model id is one a server connection's preset says its server runs elsewhere (HI-1773: an Ollama cloud
 * model), by the preset's advanced pattern; false for a preset with none, or none chosen.
 */
export function remoteModelTest(caps: ServerCaps, preset: string | undefined): (id: string) => boolean {
  const setting = caps.presets.find((p) => p.id === preset)?.remoteModels
  if (!setting) return () => false
  const re = advanced.pattern(setting)
  return (id) => re.test(id)
}

/** A server connection's models as they run now (HI-1773): its listing's marks, and its preset's pattern as set now. */
export function effectiveModels(caps: ServerCaps, server: ServerConnection): ServerModel[] {
  return withRemote(server.models, remoteModelTest(caps, server.preset))
}

/**
 * Whether a server connection runs only on this PC (HI-1773): its server is, and none of its models is one the server
 * runs elsewhere (effectiveModels). Its sessions are then free (local).
 */
export function runsLocally(caps: ServerCaps, server: ServerConnection, local: boolean): boolean {
  return local && !effectiveModels(caps, server).some((m) => m.remote)
}

/** A connection as a window sees it: a server connection's models as they run now (effectiveModels). */
function shownServer(a: Connection): Connection {
  const caps = a.server ? providerDescriptor(a.provider).capabilities.connections?.server : undefined
  return caps && a.server ? { ...a, server: { ...a.server, models: effectiveModels(caps, a.server) } } : a
}

/**
 * A server connection's part of a launch (HI-1772): its key decrypted for this launch's environment (refused without
 * one, unless its server is this machine's), and that key masked from now until the launch's process is gone.
 */
async function serverPart(a: Connection, caps: ServerCaps, agentName: string): Promise<{ part: NonNullable<LaunchConnection['server']>; keyV: string | null; origin: string }> {
  const b = parseBaseUrl(a.server?.baseUrl ?? '')
  if (!a.server || !b.ok) throw hiveError(LAUNCH.noKey, { name: a.name, agent: agentName }, { kind: 'conflict' })
  const got = await withKey(a.id, b.origin)
  if (!got && !b.local) throw hiveError(LAUNCH.noKey, { name: a.name, agent: agentName }, { kind: 'conflict' })
  return { part: { env: serverEnv(caps, a.server, got?.key ?? null), models: effectiveModels(caps, a.server), local: runsLocally(caps, a.server, b.local) }, keyV: got?.v ?? null, origin: b.origin }
}

/**
 * The connection a launch runs on (HI-1755), or null for a provider without connections (or a test copy on its CLI
 * test home: testHomeSeam). Resolved from what was asked for and the workspace's choice (resolveConnection); refused,
 * saying why, when there is none to use; then claimed (its folder checked, under its lock) and its login confirmed
 * afresh: signed out, still changing, or its folder unusable refuse; a check that couldn't tell goes ahead, noted. The
 * caller releases it however the launch ends, and asks stillValid() again before its process starts.
 */
export async function connectionForLaunch(o: { provider: ProviderId; workspaceConfig: WorkspaceConfig | null; wanted: string | null | undefined; agentName: string }): Promise<LaunchConnection | null> {
  const caps = providerDescriptor(o.provider).capabilities.connections
  // A CLI without connections (Copilot: its own machine-wide login, HI-1758) launches as it always has.
  if (!caps) return null
  const cli = providerDescriptor(o.provider).name
  const choose = (wanted: string | null | undefined): ReturnType<typeof resolveConnection> => resolveConnection(o.workspaceConfig, o.provider, wanted, list())
  const choice = choose(o.wanted)
  if (!choice.ok) {
    if (choice.why === 'none' && testHomeSeam(caps.homeEnv)) return null
    const name = choice.wanted ? (getAccount(choice.wanted)?.name ?? choice.wanted) : ''
    throw hiveError(LAUNCH[choice.why], { agent: o.agentName, cli, name }, { kind: 'conflict' })
  }
  const id = choice.id
  const release = await claimAccount(id)
  try {
    const gen = generation(id)
    const chosen = getAccount(id)
    if (chosen && isServer(chosen) && caps.server) {
      // A server connection (HI-1772): no login to confirm; its key, if it needs one, for this launch alone.
      const { part, keyV, origin } = await serverPart(chosen, caps.server, o.agentName)
      const a = getAccount(id)
      // The connection, its server and its key as prepared, still so at the last look.
      const same = (): boolean => {
        const now = getAccount(id)
        return generation(id) === gen && !!now && isServer(now) && originOf(now.server?.baseUrl ?? '') === origin && (keyInfo(id)?.origin === origin ? keyInfo(id)!.v : null) === keyV
      }
      if (!a || !same()) {
        throw hiveError(NO_ACCOUNT, undefined, { kind: 'notFound' })
      }
      noteLastUsed(o.provider, id)
      return {
        id,
        name: a.name,
        folder: accountFolder(id),
        homeEnv: caps.homeEnv,
        ...(choice.note ? { note: choice.note } : {}),
        release,
        server: part,
        stillValid: (wanted) => same() && (() => {
          const now = choose(wanted)
          return now.ok && now.id === id
        })()
      }
    }
    const { observed, fresh } = await confirmAccount(id)
    const a = getAccount(id)
    if (!a || generation(id) !== gen) throw hiveError(NO_ACCOUNT, undefined, { kind: 'notFound' })
    if (!fresh) throw hiveError(LAUNCH.changing, { name: a.name, agent: o.agentName }, { kind: 'conflict' })
    if (observed?.missing) await assertUsable(a)
    if (observed?.loggedIn === false) throw hiveError(LAUNCH.signedOut, { name: a.name, agent: o.agentName }, { kind: 'conflict' })
    const note = choice.note ?? (observed?.loggedIn === null ? 'unknownLogin' : accountState(a) === 'changed' ? 'loginChanged' : undefined)
    noteLastUsed(o.provider, id)
    return {
      id,
      name: a.name,
      folder: accountFolder(id),
      homeEnv: caps.homeEnv,
      ...(note ? { note } : {}),
      ...(usageLogin(observed) ? { login: usageLogin(observed)! } : {}),
      release,
      stillValid: (wanted) => generation(id) === gen && !!getAccount(id) && (() => {
        const now = choose(wanted)
        return now.ok && now.id === id
      })()
    }
  } catch (e) {
    release()
    throw e
  }
}

/** A launch whose connection's choice was changed (or the connection removed) while it was starting: started again once. */
class ConnectionChanged extends Error {}

/**
 * Launches on the connection chosen (HI-1755): the choice as saved now (`chosen`), prepared (connectionForLaunch), and
 * looked at again at the last moment: `run` awaits `lastLook()` as its last await before the spawn, which ends the run
 * when the choice saved then, resolved again, isn't the connection prepared. It is then started once more on that
 * choice (the first claim released), and refused, saying why, if that changes too. Each launch looks at its own choice
 * (and the defaults it follows) only, so another agent's or the Assistant's save never ends it.
 */
export async function launchOnChosen(o: { provider: ProviderId; workspaceConfig: WorkspaceConfig | null; agentName: string; chosen: () => Promise<string | null | undefined> }, run: (conn: LaunchConnection | null, lastLook: () => Promise<void>) => Promise<void>): Promise<void> {
  // A CLI without connections (Copilot): it launches on its own login, no choice read.
  if (!providerDescriptor(o.provider).capabilities.connections) return run(null, async () => undefined)
  for (let again = false; ; again = true) {
    const conn = await connectionForLaunch({ provider: o.provider, workspaceConfig: o.workspaceConfig, wanted: await o.chosen(), agentName: o.agentName })
    try {
      await run(conn, async () => {
        if (conn && !conn.stillValid(await o.chosen())) throw new ConnectionChanged()
      })
      return
    } catch (e) {
      if (!(e instanceof ConnectionChanged)) throw e
      if (again) throw hiveError(LAUNCH.changedAgain, { agent: o.agentName }, { kind: 'conflict' })
      log.info(`${userText(o.agentName)}: its connection was changed while it was starting; starting it on the one chosen now`)
    } finally {
      conn?.release()
    }
  }
}

/** A connection's home, for what the CLI reads from it: its memory, skills and settings (HI-1755). */
export interface ConnectionHome {
  id: string
  name: string
  home: string
}

/**
 * The homes of a provider's connections on in a workspace (or, with no workspace given, in every open one), for what
 * Hive shows or allows from a CLI's home; undefined when the provider's sign-in isn't its connections' (it has none, or
 * the test seam is on), so the CLI's own home is used as before.
 */
export function connectionHomes(id: ProviderId, cfg?: WorkspaceConfig | null): ConnectionHome[] | undefined {
  if (!connectionsManaged(id)) return undefined
  const all = list()
  const ids = new Set<string>()
  for (const c of cfg !== undefined ? (cfg ? [cfg] : []) : openWorkspaces().map((w) => w.config)) for (const x of workspaceAccounts(c, id, all)?.on ?? []) ids.add(x)
  return all.filter((a) => ids.has(a.id)).map((a) => ({ id: a.id, name: a.name, home: accountFolder(a.id) }))
}

const CHOICE: Record<ConnectionProblem, Msg> = {
  missing: msg({ id: 'main.connections.choice.missing', defaultMessage: "The connection chosen for {agent} no longer exists. Choose another, or the workspace's default.", description: "An error saving an agent's settings (or adding one): the connection chosen for it ({agent}, its name) was removed. A connection is how a coding agent CLI signs in or reaches its model (Settings → Connections)." }),
  otherCli: msg({ id: 'main.connections.choice.otherCli', defaultMessage: "{name} is for another CLI than {agent}'s. Choose one of its own.", description: "An error saving an agent's settings (or adding one): the connection chosen ({name}) belongs to another coding agent CLI than the agent's ({agent}, its name)." }),
  off: msg({ id: 'main.connections.choice.off', defaultMessage: "{name} isn't on in this workspace. Turn it on in Settings → Connections, or choose another for {agent}.", description: "An error saving an agent's settings (or adding one): the connection chosen ({name}) is off in this workspace, so it can't be the agent's ({agent}, its name). Settings → Connections names a section." })
}

/**
 * Why a connection can't be saved as an agent's own choice in a project now (HI-1769): removed, another CLI's, or not on
 * in its workspace; null when it can. Read from memory, so it is checked again with the write that saves it.
 */
export function connectionProblem(id: string, cli: ProviderId, projectPath: string): ConnectionProblem | null {
  const a = getAccount(id)
  if (!a) return 'missing'
  if (a.provider !== cli) return 'otherCli'
  return connectionOnHere(id, cli, projectPath) ? null : 'off'
}

/** Refuses a connection that can't be an agent's own choice here (connectionProblem), saying why. */
export function assertConnectionHere(id: string, cli: ProviderId, projectPath: string, agent: string): void {
  const why = connectionProblem(id, cli, projectPath)
  if (why) throw hiveError(CHOICE[why], { agent, name: getAccount(id)?.name ?? id }, { kind: 'conflict' })
}

/** Whether a connection is one of the provider's on in the workspace a project (or host) belongs to (HI-1755). */
export function connectionOnHere(id: string, cli: ProviderId, projectPath: string): boolean {
  const ws = workspaceOf(projectPath)
  return !!ws.path && !!workspaceAccounts(ws.config, cli, list())?.on.includes(id)
}

/**
 * Connections' part of Hive's start (index.ts; nothing runs as this module loads, which other modules import): a new
 * workspace starts with the last-used connections, and the watches follow the open workspaces and their choices.
 */
export function initConnections(): void {
  // Connections from before the old per-CLI defaults' record (a preview's) count as having taken them, at once.
  seedConnectionDefaults()
  setNewWorkspaceExtras(() => {
    const connections = newWorkspaceAccounts()
    return connections ? { connections } : {}
  })
  onHiveEvent((e) => {
    if (e.type === 'workspace-changed') syncWatches()
  })
  // The patterns of models a server runs elsewhere (HI-1773): a change re-marks the models windows show.
  const patterns = (): string => PROVIDERS.flatMap((p) => p.capabilities.connections?.server?.presets ?? []).map((p) => (p.remoteModels ? advanced.pattern(p.remoteModels).source : '')).join('\n')
  let shown = patterns()
  advanced.onChange(() => {
    const now = patterns()
    if (now === shown) return
    shown = now
    emit({ type: 'connections-changed' })
  })
}
