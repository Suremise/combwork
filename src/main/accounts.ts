import { randomBytes } from 'crypto'
import { join, resolve } from 'path'
import { app } from 'electron'
import { watch, type FSWatcher } from 'original-fs'
import { lstat, mkdir, readdir, readlink, realpath, rename, rmdir, symlink, unlink } from 'original-fs/promises'
import type { Connection, ConnectionDefaults, ConnectionObserved, ConnectionProblem, ProviderId, WorkspaceConfig } from '../shared/types'
import { cliDefaults } from '../shared/connectionDefaults'
import { acceptable, accountState, resolveConnection, workspaceAccounts, switchedOn, type ConnectionsView } from '../shared/accounts'
import { profileFolder } from '../shared/appName'
import { isProviderEnabled, providerDescriptor, PROVIDERS } from '../shared/providers'
import { msg, type Msg } from '../shared/i18n'
import { config } from './config'
import { emit, onHiveEvent } from './events'
import { hiveError } from './hiveError'
import { createLogger, userText } from './logger'
import { childEnv, hasPty } from './ptyHost'
import { connectionsManaged, connectionsOn, testHomeSeam } from './connectionSeam'
import { provider } from './providers'
import { providerService } from './providerService'
import { openWorkspaces, setNewWorkspaceExtras, workspace, workspaceOf } from './workspace'

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
}

// ---------------------------------------------------------------------------
// Refusals, in the user's language.
// ---------------------------------------------------------------------------

const PREVIEW_OFF = msg({ id: 'main.accounts.previewOff', defaultMessage: 'Connections are a preview: turn on Settings → Advanced → Connections (preview) first.', description: 'An error: something about connections was asked while their preview switch is off. Settings → Advanced → Connections (preview) names a setting: use its name as Hive shows it.' })
const NO_NAME = msg({ id: 'main.accounts.noName', defaultMessage: 'Give the connection a name.', description: 'An error adding or renaming a connection in Settings → Connections: its name is empty.' })
const NO_ACCOUNT = msg({ id: 'main.accounts.notFound', defaultMessage: 'There is no such connection.', description: 'An error: a connection named by its id is not in Settings → Connections (removed meanwhile).' })

/** Refuses an action on connections while they are off (the preview switch, until S8): nothing is made or changed. */
function assertOn(): void {
  if (!connectionsOn()) throw hiveError(PREVIEW_OFF, undefined, { kind: 'forbidden' })
}

function mustGet(id: string): Connection {
  const a = getAccount(id)
  if (!a) throw hiveError(NO_ACCOUNT, undefined, { kind: 'notFound' })
  return a
}

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
  assertOn()
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

const loginKey = (a: Pick<Connection, 'id' | 'provider'>): string => `task:${a.provider}:login:${a.id}`

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

/** Adds an account, its folder and junctions made and checked; then the window offers its Sign in. */
export async function addAccount(id: ProviderId, name: string): Promise<Connection> {
  assertOn()
  support(id)
  const n = name.trim()
  if (!n) throw hiveError(NO_NAME, undefined, { kind: 'invalid' })
  // Its defaults the CLI's as they are now (HI-1770), until edited.
  const a: Connection = { id: `a-${randomBytes(4).toString('hex')}`, provider: id, kind: 'signIn', name: n, createdAt: new Date().toISOString(), defaults: cliDefaults(config.settings, id), defaultsFrom: 'cli' }
  return locked(a.id, async () => {
    try {
      await makeFolder(a)
    } catch (e) {
      log.warn(`account ${a.id} couldn't be made: ${userText(String(e))}`)
      if (e instanceof Unsafe) throw hiveError(msg({ id: 'main.accounts.makeFailed', defaultMessage: "Couldn't make the connection's folder: {error}", description: "An error adding a connection: its folder or link couldn't be made. {error} is the reason, in English." }), { error: e.message })
      throw e
    }
    generations.set(a.id, generation(a.id) + 1)
    changeAccounts((all) => all.push(a))
    log.info(`account ${a.id} added (${a.provider})`)
    syncWatches()
    return a
  })
}

/**
 * A connection's defaults for the agents on it (HI-1770): model, effort and context, each '' or null to leave it to the
 * CLI. Edited, they are the user's (no longer the CLI's as copied).
 */
export function setConnectionDefaults(id: string, patch: { model?: string | null; effort?: string | null; use200kContext?: boolean | null }): void {
  assertOn()
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
 * Connections made before they had defaults (HI-1755's) get the CLI's, once (HI-1770): only where `defaults` is absent,
 * so one the user emptied or edited is never filled in again.
 */
export function seedConnectionDefaults(): void {
  if (!list().some((a) => a.defaults === undefined)) return
  changeAccounts((all) => {
    for (const [i, a] of all.entries()) if (a.defaults === undefined) all[i] = { ...a, defaults: cliDefaults(config.settings, a.provider), defaultsFrom: 'cli' }
  })
}

export function renameAccount(id: string, name: string): void {
  assertOn()
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
  assertOn()
  const a = mustGet(id)
  const inUse = (): boolean => sessionsOn(id) || (claims.get(id) ?? 0) > 0 || loginsOpen.has(id) || hasPty(loginKey(a))
  const IN_USE = msg({ id: 'main.accounts.inUse', defaultMessage: '{name} is in use: stop the agents on it and close its sign-in, then remove it.', description: 'An error removing a connection ({name}, its name in Settings → Connections): agents run on it, or its sign-in terminal is open.' })
  if (inUse()) throw hiveError(IN_USE, { name: a.name }, { kind: 'conflict' })
  await locked(id, async () => {
    // Asked again under the lock: a launch or sign-in may have started while it waited.
    if (inUse()) throw hiveError(IN_USE, { name: a.name }, { kind: 'conflict' })
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
  if (!a) return null
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
      const s = await slot(() => adapter.accountStatus!(exe, childEnv({ [homeEnv]: dir })))
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
 * when it kept changing.
 */
export async function confirmAccount(id: string): Promise<{ observed: ConnectionObserved | null; fresh: boolean }> {
  let observed: ConnectionObserved | null = null
  for (let i = 0; i < CONFIRM_ROUNDS; i++) {
    const seen = changes.get(id) ?? 0
    observed = await checkAccount(id)
    if ((changes.get(id) ?? 0) === seen) return { observed, fresh: true }
  }
  return { observed, fresh: false }
}

/**
 * Opens the account's sign-in: the CLI's own login in a terminal of Hive's, on its folder. Once it ends, the account is
 * checked; its first good login becomes the one accepted. Returns the terminal's key.
 */
export async function signInAccount(id: string): Promise<string> {
  assertOn()
  mustGet(id)
  // Started under the account's lock, so never while it is being removed: the account checked still there (a removal
  // before it wins), and its folder still the one Hive made (a folder replaced by a link would take the CLI's login
  // writes elsewhere).
  return locked(id, async () => {
    const a = mustGet(id)
    const { homeEnv } = support(a.provider)
    await assertUsable(a)
    const gen = generation(id)
    loginsOpen.add(id)
    try {
      return providerService.runAccountLogin(a.provider, id, { [homeEnv]: accountFolder(id) }, () => {
        loginsOpen.delete(id)
        void checkAccount(id).then((o) => {
          if (generation(id) !== gen) return
          const ok = acceptable(o ?? undefined)
          // Only a good, signed-in answer is taken on, and only when none is yet; a different one is a change to answer.
          if (ok && !getAccount(id)?.accepted) changeAccount(id, (x) => (x.accepted = ok))
        })
      })
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
  assertOn()
  const a = mustGet(id)
  const ok = acceptable(a.observed)
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
}
const watched = new Map<string, Watched>()
let rootWatch: FSWatcher | null = null

/** The accounts on in any open workspace: those watched (HI-1755 adds those its sessions run on). */
function wantedIds(): Set<string> {
  const out = new Set<string>()
  const all = list()
  for (const w of openWorkspaces()) for (const p of PROVIDERS) for (const id of workspaceAccounts(w.config, p.id, all)?.on ?? []) out.add(id)
  for (const a of all) if (sessionsOn(a.id)) out.add(a.id)
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

function attach(id: string): void {
  const w = watched.get(id)
  if (!w) return
  w.w?.close()
  w.w = null
  const a = getAccount(id)
  if (!a) return
  const adapter = provider(a.provider)
  void assertRealFolder(accountFolder(id)).then(
    () => {
      if (watched.get(id) !== w) return
      try {
        const fw = watch(accountFolder(id), { persistent: false })
        fw.on('change', (_kind, name) => {
          // No name (some changes on Windows): checked anyway.
          if (typeof name !== 'string' || !adapter.accountLoginFile || adapter.accountLoginFile(name)) changed(id)
        })
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
      for (const id of ids) {
        if (!watched.has(id)) continue
        attach(id)
        changed(id)
      }
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
    watched.set(id, { w: null, timer: null, retry: null, tries: 0 })
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
  // Off (the preview switch, until S8): nothing is listed, and nothing is checked.
  if (!connectionsOn()) return { preview: false, providers: [], connections: [], workspace: {}, testHome: [] }
  const all = list()
  if (check) for (const a of all) void checkAccount(a.id)
  const providers = PROVIDERS.filter((p) => !!p.capabilities.connections && isProviderEnabled(config.settings, p.id)).map((p) => p.id)
  const cfg = workspace.path ? workspace.config : null
  const ws: ConnectionsView['workspace'] = {}
  for (const p of providers) {
    const w = workspaceAccounts(cfg, p, all)
    if (w) ws[p] = w
  }
  const testHome = providers.filter((p) => !connectionsManaged(p))
  return { preview: true, providers, connections: all.map((a) => ({ ...a, signingIn: hasPty(loginKey(a)), folder: accountFolder(a.id) })), workspace: ws, testHome }
}

/** Saves the asking window's workspace's accounts for a provider, worked out from how they are when it is written. */
async function saveChoice(fn: (cfg: WorkspaceConfig) => WorkspaceConfig['connections']): Promise<void> {
  await workspace.saveWorkspaceConfigWith((c) => ({ connections: fn(c) }))
  emit({ type: 'connections-changed' })
  syncWatches()
}

/** Turns an account on or off in the asking window's workspace (on, with no default yet: it becomes the default). */
export async function setAccountOn(id: string, on: boolean): Promise<void> {
  assertOn()
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
  assertOn()
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
  assertOn()
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
  /** Ends the launch's claim: once its session runs (its live state then keeps it from removal) or it failed. */
  release: () => void
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

const LAUNCH = {
  none: msg({ id: 'main.connections.launch.none', defaultMessage: 'No {cli} connection is on in this workspace. Add one in Settings → Connections and sign it in, then start {agent} again.', description: "Starting an agent ({agent}, its name) is refused: its workspace has no connection on for its coding agent CLI ({cli}: \"Claude Code\"). Settings → Connections names a section." }),
  offNoDefault: msg({ id: 'main.connections.launch.offNoDefault', defaultMessage: "{agent}'s connection, {name}, is off in this workspace, and no other {cli} connection is on. Turn one on in Settings → Connections.", description: "Starting an agent ({agent}) is refused: the connection chosen for it ({name}) is off in this workspace and there's no default to use instead. {cli} is the coding agent CLI." }),
  deleted: msg({ id: 'main.connections.launch.deleted', defaultMessage: "The connection chosen for {agent} no longer exists. Pick another in its Agent Settings, or let it use the workspace's default.", description: 'Starting an agent ({agent}) is refused: the connection chosen for it was removed. Agent Settings names a dialog.' }),
  changedAgain: msg({ id: 'main.connections.launch.changedAgain', defaultMessage: "{agent}'s connection was changed again while it was starting. Start it again.", description: "Starting an agent ({agent}, its name) failed: the connection chosen for it was changed while it was starting, and again while Hive started it once more on the new choice. A connection is how a coding agent CLI signs in or reaches its model (Settings → Connections)." }),
  otherProvider: msg({ id: 'main.connections.launch.otherProvider', defaultMessage: 'The connection chosen for {agent} is for another CLI. Pick a {cli} connection in its Agent Settings.', description: 'Starting an agent ({agent}) is refused: the connection chosen for it belongs to another coding agent CLI. {cli} is the agent\'s CLI ("Claude Code").' }),
  signedOut: msg({ id: 'main.connections.launch.signedOut', defaultMessage: '{name} is signed out. Sign it in again in Settings → Connections, then start {agent}.', description: "Starting an agent ({agent}) is refused: its connection ({name}) isn't signed in." }),
  changing: msg({ id: 'main.connections.launch.changing', defaultMessage: "{name}'s login kept changing while Hive checked it. Try starting {agent} again in a moment.", description: "Starting an agent ({agent}) is refused: its connection's ({name}) login changed again and again while Hive checked who it is signed in as." })
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
  // Connections off (the preview switch, until S8): everything launches as before.
  if (!caps || !connectionsOn()) return null
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
  // Connections off (the preview switch, until S8), or none for this CLI: it launches as before, its choice not read.
  if (!providerDescriptor(o.provider).capabilities.connections || !connectionsOn()) return run(null, async () => undefined)
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
  setNewWorkspaceExtras(() => {
    const connections = newWorkspaceAccounts()
    return connections ? { connections } : {}
  })
  onHiveEvent((e) => {
    if (e.type === 'workspace-changed') syncWatches()
  })
}
