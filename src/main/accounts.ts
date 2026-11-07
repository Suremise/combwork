import { randomBytes } from 'crypto'
import { basename, join, resolve, sep } from 'path'
import { app } from 'electron'
import { watch, type FSWatcher } from 'original-fs'
import { lstat, mkdir, readdir, readlink, realpath, rename, rmdir, symlink, unlink } from 'original-fs/promises'
import type { AgentDef, AgentInfo, AppConfig, Account, Connection, ConnectionDefaults, ConnectionObserved, ConnectionProblem, LaunchValues, ProjectConfig, ProjectInfo, ProviderId, ServerConnection, ServerModel, UsageMoveRule, WorkspaceConfig, WorkspaceConnections } from '../shared/types'
import { CW_DIR } from '../shared/defaults'
import { readKeptJson, withFileLock } from './fsutil'
import { baseValues, cliDefaults, connectionFor, COPILOT_ACCOUNT, homeAccount, seamAccountId, type AccountStore } from '../shared/connectionDefaults'
import { acceptable, accountState, baseConnection, cleanTag, connectionsOn, TAG_MAX, launchValues, movedInGroup, resolveAgentConnection, type AgentConnection, type ConnectionPatch, type ConnectionRow, type ConnectionTrust, type ConnectionUser, movedConnection, valuesOf, workspaceAccounts, switchedOn, type ConnectionsView } from '../shared/accounts'
import { ASSISTANT_NAME } from '../shared/assistant'
import { profileFolder } from '../shared/appName'
import { localProfileInUse } from './profileFolders'
import { agentProvider, extraArgsProblem, isProviderEnabled, modeOption, providerDescriptor, PROVIDERS } from '../shared/providers'
import { fmt, msg, tr, type Msg } from '../shared/i18n'
import { advanced } from './advanced'
import { config } from './config'
import { emit, onCombworkEvent } from './events'
import { capturedText, combworkError, CombworkError } from './combworkError'
import { createLogger, userText } from './logger'
import { connectionLoginChanged, forgetConnectionUsage, usageLogin } from './planUsage'
import { childEnv, hasPty, killPty, ptyGone } from './ptyHost'
import { connectionsManaged, testHomeSeam } from './connectionSeam'
import { provider } from './providers'
import type { TrustReading, TrustTarget } from './providers/types'
import { git } from './git'
import { withoutAccountEnv } from './providers/common'
import { providerService } from './providerService'
import { modelCaps } from '../shared/models'
import { openWorkspaces, setConnectionGuard, workspace, workspaceOf } from './workspace'
import { dropKeysExcept, keyInfo, loadKeys, removeKey, withKey } from './keyStore'
import { coverageView } from './keyCoverage'
import { aliasModels, MODEL_ALIASES, originOf, parseBaseUrl, serverDefaultModel, withRemote } from '../shared/serverConnection'
import type { ServerCaps } from '../shared/providers'
import { treeOf } from './combworkMove'

/**
 * Combwork's accounts (HI-980, SPEC §11.2): a CLI login per folder, under `<accounts>\<id>\`, each signed in through the
 * CLI's own sign-in (its login stays in its folder: Combwork never reads, stores or passes a token). Each account's folder
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
 * The accounts folder: the installed app's `%LOCALAPPDATA%\Combwork\accounts`, a dev build's `Combwork-Dev`'s, and a
 * test profile's own (under CW_USER_DATA), so no test reaches the user's. The local profile folder is the one this run
 * uses (HI-2461; Combwork's old one moved to it before, by the installer or at start: HI-2594).
 */
export function accountsRoot(): string {
  // The local folder this run chose first: a test copy's (CW_TEST_PROFILE_CHOOSE) too.
  const inUse = localProfileInUse()
  if (inUse) return join(inUse, 'accounts')
  if (process.env.CW_USER_DATA) return join(process.env.CW_USER_DATA, 'accounts')
  const local = process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local')
  return join(local, profileFolder(app.isPackaged), 'accounts')
}

export const accountFolder = (id: string): string => join(accountsRoot(), id)

const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/** Combwork's accounts: its folders (never the CLI's own homes: Copilot's sign-in, a test home), in the order. */
function list(): Account[] {
  return (config.get().accounts ?? []).filter((a) => !a.home)
}

/** Combwork's accounts (list): what today's screens and the Agent API call connections, until HI-2107 and HI-2108. */
export const combworkAccounts = (): Account[] => list()

/** Every account, the CLI's own homes too (HI-2106: Copilot's sign-in, a test home), in the order. */
export function allAccounts(): Account[] {
  return config.get().accounts ?? []
}

export function getAccount(id: string): Account | undefined {
  return list().find((a) => a.id === id)
}

function changeAccounts(fn: (connections: Account[]) => void): void {
  config.update((c) => {
    c.accounts = [...(c.accounts ?? [])]
    fn(c.accounts)
  })
  emit({ type: 'connections-changed' })
}

function changeAccount(id: string, fn: (a: Account) => void): void {
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

const NO_NAME = msg({ id: 'main.accounts.noName', defaultMessage: 'Give the connection a name.', description: 'An error adding or renaming a connection in Settings → Accounts & Connections: its name is empty.' })
const NO_ACCOUNT = msg({ id: 'main.accounts.notFound', defaultMessage: 'There is no such connection.', description: 'An error: a connection named by its id is not in Settings → Accounts & Connections (removed meanwhile).' })

function mustGet(id: string): Account {
  const a = getAccount(id)
  if (!a) throw combworkError(NO_ACCOUNT, undefined, { kind: 'notFound' })
  return a
}

/**
 * Refuses a sign-in or removal while the CLI's own check of the folder isn't confirmed ended (HI-1757: Codex's app
 * server, held by codexChecks.ts until it is gone, across a restart too).
 */
function assertNotHeld(a: Account): void {
  if (!provider(a.provider).accountHeld?.(accountFolder(a.id))) return
  throw combworkError(msg({ id: 'main.accounts.checkHeld', defaultMessage: "{name} is being checked: Combwork is still making sure {cli}'s check of it has ended. Try again in a moment.", description: "An error signing in or removing a connection ({name}, its name in Settings → Accounts & Connections): the coding agent CLI's ({cli}: \"Codex\") check of who it is signed in as hasn't been confirmed ended yet, so the connection is held." }), { name: a.name, cli: providerDescriptor(a.provider).name }, { kind: 'conflict' })
}

/** Whether the CLI's sign-in names an organisation, which an identity then needs (HI-1757: Codex's names none). */
const namesOrgs = (id: ProviderId): boolean => providerDescriptor(id).capabilities.connections?.orgs !== false

/** The provider's account support, or a refusal: one without it can't have accounts in Combwork. */
function support(id: ProviderId): { homeEnv: string; shared: readonly string[]; adapter: ReturnType<typeof provider> } {
  const caps = providerDescriptor(id).capabilities.connections
  const adapter = provider(id)
  if (!caps || !adapter.accountStatus || !adapter.accountSharedTarget || !adapter.configHome) throw combworkError(msg({ id: 'main.accounts.noProvider', defaultMessage: "{cli} can't have sign-in connections in Combwork yet.", description: 'An error: connections were asked for a coding agent CLI ({cli}: "Codex") that Combwork keeps no connections for.' }), { cli: providerDescriptor(id).name }, { kind: 'invalid' })
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
 * so never while a removal runs, and only on an account still there whose folder is the one Combwork made. Removal is
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
export const loginKey = (a: Pick<Account, 'id' | 'provider'>): string => `task:${a.provider}:login:${a.id}`

/** A server connection's (HI-1772): nothing to sign in, check or watch; its key in the key store. */
export const isServer = (a: Pick<Account, 'kind'> | undefined): boolean => a?.kind === 'server'

/** For serverConnections.ts (HI-1772): a connection's lock, and its changes, as this module's own take them. */
export const connectionInternals = {
  locked: <T>(id: string, fn: () => Promise<T>): Promise<T> => locked(id, fn),
  mustGet: (id: string): Account => mustGet(id),
  change: (id: string, fn: (a: Account) => void): void => changeAccount(id, fn),
  inUse: (a: Account): boolean => sessionsOn(a.id) || (claims.get(a.id) ?? 0) > 0 || loginsOpen.has(a.id) || hasPty(loginKey(a)),
  assertUsable: (a: Account): Promise<void> => assertUsable(a)
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
export const accountTestHooks: { beforeDelete?: (dir: string) => Promise<void>; beforeOrderRead?: () => Promise<void>; beforeUsersRead?: () => Promise<void> } = {}

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
    throw combworkError(msg({ id: 'main.accounts.badTarget', defaultMessage: "Combwork won't link a connection to {target}: it isn't one of {cli}'s own folders.", description: "An error adding a connection: the folder a connection's shared folder would link to ({target}, a path) isn't in the coding agent CLI's ({cli}) own folder." }), { target, cli: providerDescriptor(id).name }, { kind: 'invalid' })
  return target
}

/** How a link in an account's folder stands: absent, the junction Combwork made, or something else (refused). */
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
async function makeFolder(a: Account): Promise<void> {
  const dir = accountFolder(a.id)
  const { shared } = support(a.provider)
  await mkdir(accountsRoot(), { recursive: true })
  await mkdir(dir)
  try {
    await assertRealFolder(dir)
    for (const name of shared) {
      const target = sharedTarget(a.provider, name)
      // Missing (the CLI never ran here): the empty folder, its home's only change Combwork ever makes (Darren, 26 Oct). Not
      // its home: refused, rather than made.
      await mkdir(target).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'EEXIST') return
        if (e.code === 'ENOENT') throw combworkError(msg({ id: 'main.accounts.noHome', defaultMessage: "{cli}'s folder ({folder}) isn't there yet: run {cli} once, then add the connection.", description: "An error adding a connection: the coding agent CLI's ({cli}) own folder ({folder}, a path) doesn't exist on this PC." }), { cli: providerDescriptor(a.provider).name, folder: resolve(target, '..') }, { kind: 'conflict' })
        throw e
      })
      const tst = await lstat(target)
      if (tst.isSymbolicLink() || !tst.isDirectory()) throw new Unsafe(`${target} isn't a folder`) // i18n-ignore: for the log
      const link = join(dir, name)
      await symlink(target, link, 'junction')
      if ((await linkState(link, target)) !== 'ours') throw new Unsafe(`${link} isn't the junction Combwork made`) // i18n-ignore: for the log
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
async function removeFolder(a: Account): Promise<void> {
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
    if (state !== 'ours') throw new Unsafe(`${link} is ${state}, not the junction Combwork made`) // i18n-ignore: for the log
    // The link alone (unlink removes a junction, never what it points at: tests/accounts.test.ts).
    await unlink(link)
    if ((await linkState(link, target)) !== 'absent') throw new Unsafe(`${link} is still there after it was removed`) // i18n-ignore: for the log
  }
  const links = await linksUnder(dir)
  if (links.length) throw new Unsafe(`links Combwork didn't make are in it: ${links.join(', ')}`) // i18n-ignore: for the log
  // Renamed aside, one rename that follows nothing, so no account is ever at its own path half deleted; then deleted
  // there by the walk. The threat model (the Assistant's call on HI-980, 26 Oct): Combwork's own junction, the CLI's
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
  if (links.length) throw new Unsafe(`links Combwork didn't make are in it: ${links.join(', ')}`) // i18n-ignore: for the log
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
export async function addAccount(id: ProviderId, name: string, server?: ServerConnection): Promise<Account> {
  support(id)
  const n = name.trim()
  if (!n) throw combworkError(NO_NAME, undefined, { kind: 'invalid' })
  // Its base connection (HI-2106) holds what an agent with nothing of its own on it launched with before connections were
  // setups: the CLI's old per-CLI model, effort and context for its CLI's first sign-in account only (taken once,
  // HI-1774), and the CLI's mode and extra arguments; a server's models aren't the CLI's, so no model, effort or context.
  const base = { id: `a-${randomBytes(4).toString('hex')}`, provider: id, name: n, createdAt: new Date().toISOString() }
  const a: Account = server ? { ...base, kind: 'server', server } : { ...base, kind: 'signIn' }
  return locked(a.id, async () => {
    try {
      await makeFolder(a)
    } catch (e) {
      log.warn(`account ${a.id} couldn't be made: ${userText(String(e))}`)
      if (e instanceof Unsafe) throw combworkError(msg({ id: 'main.accounts.makeFailed', defaultMessage: "Couldn't make the connection's folder: {error}", description: "An error adding a connection: its folder or link couldn't be made. {error} is the reason, in English." }), { error: e.message })
      throw e
    }
    generations.set(a.id, generation(a.id) + 1)
    config.update((c) => {
      const defaults = a.kind === 'signIn' ? takeCliDefaults(c, a) : {}
      c.accounts = [...(c.accounts ?? []), a]
      c.connections = [...(c.connections ?? []), { id: newConnectionId(), account: a.id, name: a.name, ...baseValues(a, c.settings, defaults) }]
      // Its notice (HI-1774) has done its job: never shown again, even with every connection removed later.
      c.ui.connectionsIntroShown = true
    })
    emit({ type: 'connections-changed' })
    log.info(`account ${a.id} added (${a.provider})`)
    syncWatches()
    return a
  })
}

/**
 * The model that would run for a choice on an account (`model`: its connection's; else the CLI's own default in the
 * account's home, else its catalogue's), and whether an effort is one that model takes (only where its efforts are
 * known): an effort it doesn't take is kept but not used.
 */
export function effortUsable(cli: ProviderId, model: string | null, conn: Pick<Account, 'id' | 'home'> | null, effort: string): boolean {
  const info = providerService.info(cli)
  const runs = model || (conn && !conn.home ? provider(cli).configuredDefaultModel(accountFolder(conn.id)) : null) || info.defaultModel || null
  const caps = modelCaps(cli, runs, info, config.settings)
  return !caps.perModel || caps.efforts.some((e) => e.value === effort)
}

const EFFORT_REFUSED = msg({ id: 'worktrees.agent.effortRefused', defaultMessage: "{chosen, select, yes {{model}} other {The CLI's default model}} doesn't take {effort} effort. Choose one of the levels it takes.", description: "An error saving an agent's (or a connection's) settings (HI-2106): the model that would run (its name, {model}, when one is chosen; else the CLI's own default) has no such reasoning effort level ({effort}: \"max\")." })

/**
 * Refuses a connection's model and effort that don't go together (HI-2106, decision E), at every save the user makes
 * (Agent Settings, Add Agent, the Agent API, Settings → Accounts & Connections' defaults, Settings → Assistant), before anything
 * changes. One the migration carried over, or a later CLI's catalogue left, is kept and not passed at launch.
 */
export function assertEffortTaken(cli: ProviderId, model: string | null, account: Pick<Account, 'id' | 'home'> | null, effort: string): void {
  if (!effortUsable(cli, model, account, effort)) throw combworkError(EFFORT_REFUSED, { chosen: model ? 'yes' : 'no', model: model ?? '', effort }, { kind: 'invalid' })
}

/**
 * The CLI's old per-CLI model, effort and context (Settings → <CLI> before connections, kept in config only as migration
 * input: HI-1774) for a new sign-in account, if its CLI's haven't been given yet; recorded in the same write, so they
 * are taken once, by the first sign-in account of an upgrade from 0.9. Inside the config.update adding it.
 */
function takeCliDefaults(c: AppConfig, a: Account): ConnectionDefaults {
  const taken = c.connectionDefaultsTaken ?? []
  if (taken.includes(a.provider)) return {}
  c.connectionDefaultsTaken = [...taken, a.provider]
  // An account of its CLI from before this record (a preview's) had them already: recorded as taken, not given again.
  if ((c.accounts ?? []).some((x) => x.provider === a.provider && !x.home)) return {}
  return cliDefaults(c.settings, a.provider)
}

// ---------------------------------------------------------------------------
// Connections (HI-2106): the setups on the accounts that agents and the Assistant choose.
// ---------------------------------------------------------------------------

export const newConnectionId = (): string => `c-${randomBytes(4).toString('hex')}`

/** Every connection, in the order. */
export function allConnections(): Connection[] {
  return config.get().connections ?? []
}

export function getConnection(id: string | null | undefined): Connection | undefined {
  return id ? allConnections().find((c) => c.id === id) : undefined
}

/** An account by its id, the CLI's own homes too (allAccounts). */
export function accountById(id: string | null | undefined): Account | undefined {
  return id ? allAccounts().find((a) => a.id === id) : undefined
}

function changeConnections(fn: (connections: Connection[]) => void): void {
  config.update((c) => {
    c.connections = [...(c.connections ?? [])]
    fn(c.connections)
  })
  emit({ type: 'connections-changed' })
}

/**
 * The connection on an account with these values (HI-2106's rule, for the adapter of today's screens and the Agent API
 * until HI-2108): one that has them, else one made, named after what differs from the account's base connection
 * (`label` instead: the Assistant's). Made in one config change, so two at once never make two.
 */
export function connectionWith(accountId: string, values: LaunchValues, label?: string): Connection {
  let out: Connection | undefined
  let made = false
  config.update((c) => {
    const store: AccountStore = { accounts: c.accounts ?? [], connections: [...(c.connections ?? [])], newId: newConnectionId }
    out = connectionFor(store, accountId, values, label)
    made = store.connections.length !== (c.connections ?? []).length
    if (made) c.connections = store.connections
  })
  if (made) emit({ type: 'connections-changed' })
  return out!
}

const NO_CONNECTION = msg({ id: 'main.connections.notFound', defaultMessage: 'There is no such connection.', description: 'An error (HI-2107): a connection named by its id is not in Settings → Accounts & Connections (removed meanwhile).' })
const NO_CONNECTION_NAME = msg({ id: 'main.connections.noName', defaultMessage: 'Give the connection a name.', description: 'An error saving a connection (Settings → Accounts & Connections, HI-2107): its name is empty.' })
const NAME_TAKEN = msg({ id: 'main.connections.nameTaken', defaultMessage: '{account} already has a connection named {name}. Choose another name.', description: 'An error saving a connection (Settings → Accounts & Connections, HI-2107): another connection on the same account ({account}, its name) has this name ({name}).' })
const BAD_MODE = msg({ id: 'main.connections.badMode', defaultMessage: "{cli} has no permission mode {mode}.", description: 'An error saving a connection (HI-2107): the permission mode asked for ({mode}, as given) is not one of the coding agent CLI\'s ({cli}: "Codex").' })
const CONNECTION_IN_USE = msg({ id: 'main.connections.inUse', defaultMessage: 'Still in use, so {name} was kept: {users}. Choose another connection for them first, then remove it.', description: 'An error removing a connection (Settings → Accounts & Connections, HI-2107): agents or the Assistant use it ({users}: their names, listed, each with its project).' })
const CONNECTION_BEING_REMOVED = msg({ id: 'main.connections.beingRemoved', defaultMessage: '{name} is being removed already.', description: 'An error removing a connection (HI-2107): a removal of it ({name}, its name) is already under way.' })
const USER_IN = msg({ id: 'main.connections.userIn', defaultMessage: '{agent} ({project})', description: 'One user of a connection in the error refusing its removal (HI-2107): an agent ({agent}) and its project ({project}).' })

function mustConnection(id: string): { c: Connection; a: Account } {
  const c = getConnection(id)
  const a = accountById(c?.account)
  if (!c || !a) throw combworkError(NO_CONNECTION, undefined, { kind: 'notFound' })
  return { c, a }
}

/**
 * A connection's values as saved (HI-2107), from what it had and a patch: each null or '' left to the CLI; a server
 * account's take no effort or context; a permission mode its CLI doesn't have is refused, and a model and effort that
 * don't go together (decision E), before anything changes.
 */
function savedValues(a: Account, now: LaunchValues, patch: ConnectionPatch): LaunchValues {
  const next: Record<string, unknown> = { ...valuesOf(now) }
  for (const k of ['model', 'effort', 'use200kContext', 'permissionMode', 'extraArgs'] as const) if (patch[k] !== undefined) next[k] = patch[k] ?? undefined
  const mode = next.permissionMode as string | undefined
  if (mode && !modeOption(a.provider, mode as LaunchValues['permissionMode'])) throw combworkError(BAD_MODE, { cli: providerDescriptor(a.provider).name, mode }, { kind: 'invalid' })
  // A bare "--" (#523): Combwork passes the task after its own, and a launch refuses it; refused here, before it is saved.
  const argsProblem = typeof next.extraArgs === 'string' ? capturedText((t) => extraArgsProblem(next.extraArgs as string, t)) : null
  // agent-text: extraArgsProblem
  if (argsProblem) throw new CombworkError(argsProblem, { kind: 'invalid' })
  // Kept as the user chose it (a mode the CLI calls its default is still the user's choice), only emptied values dropped.
  const out = launchValues(next as LaunchValues, a.provider, isServer(a))
  if (mode) out.permissionMode = mode as LaunchValues['permissionMode']
  if (out.effort && (patch.model !== undefined || patch.effort !== undefined)) assertEffortTaken(a.provider, out.model ?? null, a, out.effort)
  return out
}

const TAG_TOO_LONG = msg({ id: 'main.connections.tagTooLong', defaultMessage: 'A tag can be at most {max, number} characters.', description: "An error saving a connection (HI-2530): its tag, a short free-text label the user gives it (\"Builders\"), is too long. {max} is the most it can be." })

/** A connection's tag as saved (HI-2530), from what it had and a patch: trimmed, '' or null none, refused when too long. */
function savedTag(now: string | undefined, patch: ConnectionPatch): { tag?: string } {
  const tag = patch.tag === undefined ? now : cleanTag(patch.tag)
  if (tag && tag.length > TAG_MAX) throw combworkError(TAG_TOO_LONG, { max: TAG_MAX }, { kind: 'invalid' })
  return tag ? { tag } : {}
}

function assertNameFree(a: Account, name: string, except?: string): string {
  const n = name.trim()
  if (!n) throw combworkError(NO_CONNECTION_NAME, undefined, { kind: 'invalid' })
  if (connectionsOn(a.id, allConnections()).some((x) => x.id !== except && x.name.trim().toLowerCase() === n.toLowerCase())) throw combworkError(NAME_TAKEN, { account: a.name, name: n }, { kind: 'conflict' })
  return n
}

/** Each open workspace read again after a connection changed: running agents on it are offered Restart, or Switch Now for its mode. */
function refreshOpen(): void {
  for (const w of openWorkspaces()) void w.refresh().catch(() => undefined)
}

/** Adds a connection on an account (HI-2107: Settings' Add Connection, the Agent API's), after its others. */
export function addConnection(accountId: string, input: ConnectionPatch & { name: string }): Connection {
  const a = accountById(accountId)
  if (!a) throw combworkError(NO_ACCOUNT, undefined, { kind: 'notFound' })
  const name = assertNameFree(a, input.name)
  const made: Connection = { id: newConnectionId(), account: a.id, name, ...savedValues(a, {}, input), ...savedTag(undefined, input) }
  changeConnections((all) => {
    // After the account's last, so the base stays first.
    const last = all.map((x) => x.account).lastIndexOf(a.id)
    all.splice(last < 0 ? all.length : last + 1, 0, made)
  })
  log.info(`connection ${made.id} added on ${a.id}`)
  return made
}

/** Changes a connection's name or values (HI-2107); running agents on it are offered Restart, or Switch Now for a mode. */
export function updateConnection(id: string, patch: ConnectionPatch): Connection {
  const { c, a } = mustConnection(id)
  const name = patch.name === undefined ? c.name : assertNameFree(a, patch.name, id)
  const next: Connection = { id, account: a.id, name, ...savedValues(a, c, patch), ...savedTag(c.tag, patch) }
  changeConnections((all) => {
    const i = all.findIndex((x) => x.id === id)
    if (i >= 0) all[i] = next
  })
  refreshOpen()
  return next
}

/** A copy of a connection, after it, named "<name> (2)" (the first number free on its account). */
export function duplicateConnection(id: string): Connection {
  const { c, a } = mustConnection(id)
  const taken = new Set(connectionsOn(a.id, allConnections()).map((x) => x.name.trim().toLowerCase()))
  let n = 2
  while (taken.has(`${c.name} (${n})`.toLowerCase())) n++
  const made: Connection = { ...valuesOf(c), ...(c.tag ? { tag: c.tag } : {}), id: newConnectionId(), account: a.id, name: `${c.name} (${n})` }
  changeConnections((all) => {
    const i = all.findIndex((x) => x.id === id)
    all.splice(i + 1, 0, made)
  })
  return made
}

/**
 * Who uses each connection in the open workspaces (HI-2107): their projects' agents and their Assistants, as their
 * project.json says (an agent's `connection` is its connection's id there). Workspaces not open aren't read: an agent of
 * theirs whose connection is removed launches on its CLI's first usable one, saying so (decision H).
 */
export function connectionUsers(): Map<string, ConnectionUser[]> {
  const out = new Map<string, ConnectionUser[]>()
  const add = (id: string | undefined, u: ConnectionUser): void => {
    if (id) out.set(id, [...(out.get(id) ?? []), u])
  }
  for (const w of openWorkspaces()) {
    const info = w.info()
    if (!info) continue
    for (const p of info.projects) for (const a of p.config.agents ?? []) add(a.connection, { projectPath: p.path, project: p.name, agentId: a.id, agent: a.name ?? a.id })
    const home = info.assistant
    const own = home?.config.agents?.[0]
    if (home && own) add(own.connection, { projectPath: home.path, project: info.name, agentId: own.id, agent: ASSISTANT_NAME, assistant: true })
  }
  return out
}

/** Removes a connection (HI-2107): refused while an agent or the Assistant in an open workspace uses it, naming them. */
export async function removeConnection(id: string): Promise<void> {
  const { c } = mustConnection(id)
  if (removing.has(id)) throw combworkError(CONNECTION_BEING_REMOVED, { name: c.name }, { kind: 'conflict' })
  // Marked first: from here no write gives it to an agent (mutateProjectConfig asks connectionAssignable under each
  // project's lock), and each project's agents are read as saved, under that lock, never from a window's snapshot. A
  // write that got in before the mark is either saved by the time its project is read (the lock waits for it) or refused.
  removing.add(id)
  try {
    await accountTestHooks.beforeUsersRead?.()
    const users = await savedUsers(id)
    if (users.length) throw combworkError(CONNECTION_IN_USE, { name: c.name, users: fmt.list(users.map((u) => (u.assistant ? u.agent : tr(USER_IN, { agent: u.agent, project: u.project })))) }, { kind: 'conflict' })
    changeConnections((all) => all.splice(0, all.length, ...all.filter((x) => x.id !== id)))
    log.info(`connection ${id} removed`)
  } finally {
    removing.delete(id)
  }
}

/** Connections being removed now: none may be given to an agent meanwhile (HI-2107). */
const removing = new Set<string>()

/** Whether an agent may be given this connection now: it exists and isn't being removed. */
export const connectionAssignable = (id: string): boolean => !removing.has(id) && !!getConnection(id)

/**
 * The agents and Assistants of the open workspaces whose saved project.json names a connection, each file read under
 * the lock its writes take (mutateProjectConfig's).
 */
async function savedUsers(id: string): Promise<ConnectionUser[]> {
  const out: ConnectionUser[] = []
  const seen = new Set<string>()
  for (const w of openWorkspaces()) {
    if (!w.path) continue
    const homes = [...(w.info()?.projects ?? []).map((p) => ({ path: p.path, name: p.name, assistant: false })), { path: w.assistantHome, name: basename(w.path), assistant: true }]
    for (const h of homes) {
      if (seen.has(h.path.toLowerCase())) continue
      seen.add(h.path.toLowerCase())
      const file = join(h.path, CW_DIR, 'project.json')
      const cfg = await withFileLock(file, () => readKeptJson<Partial<ProjectConfig>>(file, {}))
      for (const a of cfg.agents ?? []) if (a.connection === id) out.push({ projectPath: h.path, project: h.name, agentId: a.id, agent: h.assistant ? ASSISTANT_NAME : (a.name ?? a.id), ...(h.assistant ? { assistant: true as const } : {}) })
    }
  }
  return out
}

/** Moves a connection to `index` among its account's (HI-2107; 0: its base, what a new agent on the account gets first). */
export function moveConnectionInAccount(id: string, index: number): void {
  mustConnection(id)
  const before = allConnections().map((x) => x.id).join()
  config.update((c) => void (c.connections = movedInGroup(c.connections ?? [], id, Math.trunc(index), (x) => x.account)))
  if (allConnections().map((x) => x.id).join() !== before) emit({ type: 'connections-changed' })
}

/** The connections as Settings shows them (HI-2107): in their accounts' order, then their own, with who uses each. */
function connectionRows(): ConnectionRow[] {
  const users = connectionUsers()
  const order = allAccounts().map((a) => a.id)
  const conns = allConnections().filter((c) => order.includes(c.account))
  const rows = [...conns].sort((x, y) => order.indexOf(x.account) - order.indexOf(y.account) || conns.indexOf(x) - conns.indexOf(y))
  return rows.map((c) => {
    const a = accountById(c.account)!
    const unusable = !!c.effort && !isServer(a) && !effortUsable(a.provider, c.model ?? null, a, c.effort)
    return { ...c, users: users.get(c.id) ?? [], ...(unusable ? { effortUnusable: true as const } : {}) }
  })
}

/**
 * The account a CLI's agents use where they have no other here (decision H): its first on in the workspace; Copilot's
 * sign-in (on everywhere); a test home's (the seam) where none is on; else none.
 */
export function accountHere(cli: ProviderId, cfg: WorkspaceConfig | null): Account | null {
  const ws = cfg ? workspaceAccounts(cfg, cli, list()) : undefined
  const on = ws?.default ? getAccount(ws.default) : undefined
  if (on) return on
  if (!providerDescriptor(cli).capabilities.connections) return accountById(COPILOT_ACCOUNT) ?? null
  return seamOn(cli) ? (accountById(seamAccountId(cli)) ?? null) : null
}

/**
 * The account a new agent named nothing for goes on (decision A, HI-2106: no default provider): the first in the one
 * order that's usable here (on in the workspace, or the CLI's own home), whose CLI is on and installed.
 */
export function firstUsableAccount(cfg: WorkspaceConfig | null): Account | null {
  for (const a of allAccounts()) {
    if (!isProviderEnabled(config.settings, a.provider) || !providerService.info(a.provider).path) continue
    if (accountHere(a.provider, cfg)?.id === a.id) return a
  }
  return null
}

/** Whether a test copy runs a CLI on its CLI test home (connectionSeam.ts). */
const seamOn = (cli: ProviderId): boolean => {
  const caps = providerDescriptor(cli).capabilities.connections
  return !!caps && testHomeSeam(caps.homeEnv)
}

/** accountHere, with a test home's account (and its base connection) made the first time the seam needs it. */
export function firstAccountHere(cli: ProviderId, cfg: WorkspaceConfig | null): Account | null {
  const here = accountHere(cli, cfg)
  if (here || !seamOn(cli)) return here
  let a: Account | undefined
  config.update((c) => {
    const store: AccountStore = { accounts: [...(c.accounts ?? [])], connections: [...(c.connections ?? [])], newId: newConnectionId }
    a = homeAccount(store, cli, new Date().toISOString())
    if (!baseConnection(a.id, store.connections)) connectionFor(store, a.id, {})
    c.accounts = store.accounts
    c.connections = store.connections
  })
  // A window's choice of connection lists it now (HI-2118: the template dialogs make it as they ask for their options).
  if (a) emit({ type: 'connections-changed' })
  return a ?? null
}

/**
 * Sets an account's usage move (HI-2195), or turns it off (null): at `percent` of its weekly or 5-hour limit (or either),
 * its agents move to another account of the same CLI. Refused for an account it can't name.
 */
export function setUsageMove(id: string, rule: UsageMoveRule | null): void {
  const a = mustGet(id)
  if (rule) {
    const percent = Math.round(Number(rule.percent))
    const target = getAccount(String(rule.to))
    const BAD = msg({ id: 'main.accounts.usageMove.bad', defaultMessage: 'Choose a share from 1% to 100%, a limit, and another account of the same CLI to move its agents to.', description: "An error setting an account's usage move in Settings → Accounts & Connections (HI-2195): the share, the limit or the account to move to isn't one it can be." })
    if (!(percent >= 1 && percent <= 100) || !['weekly', 'fiveHour', 'any'].includes(rule.limit) || !target || target.id === a.id || target.provider !== a.provider) throw combworkError(BAD, undefined, { kind: 'invalid' })
    changeAccount(id, (x) => (x.usageMove = { percent, limit: rule.limit, to: target.id }))
  } else changeAccount(id, (x) => delete x.usageMove)
}

export function renameAccount(id: string, name: string): void {
  mustGet(id)
  const n = name.trim()
  if (!n) throw combworkError(NO_NAME, undefined, { kind: 'invalid' })
  changeAccount(id, (a) => (a.name = n))
}

/** How long Remove waits for a sign-in or Set Up terminal it closed to end (HI-1870): a bound for a hung kill. */
const TERMINAL_GONE_MS = 15_000

/**
 * What else follows an account (HI-2683: a server connection's diagnostics, which register here rather than this module
 * importing them): told once an account being removed has lost its key, so what was asked for it stops at once and what
 * was read of it is dropped, never left running to its deadline.
 */
const removedHooks: ((id: string) => void)[] = []
export function onAccountRemoved(fn: (id: string) => void): void {
  removedHooks.push(fn)
}

/**
 * Removes an account: refused while anything runs on it (its agents, a launch, its sign-in). With `closeTerminal`
 * (HI-1870: the user said yes to closing it), its sign-in or Set Up terminal is ended first rather than refused; agents
 * on it still refuse. Its folder goes for good (removeFolder); the account stays listed, saying what's left, until that
 * succeeds.
 */
export async function removeAccount(id: string, opts: { closeTerminal?: boolean } = {}): Promise<void> {
  const a = mustGet(id)
  const running = (): boolean => sessionsOn(id) || (claims.get(id) ?? 0) > 0
  const terminalOpen = (): boolean => loginsOpen.has(id) || hasPty(loginKey(a))
  const RUNNING = msg({ id: 'main.accounts.running', defaultMessage: '{name} has agents running on it: stop them, then remove it.', description: 'An error removing a connection ({name}, its name in Settings → Accounts & Connections): agents run on it, or one is starting.' })
  const IN_USE = msg({ id: 'main.accounts.inUse', defaultMessage: '{name} is in use: stop the agents on it and close its sign-in, then remove it.', description: 'An error removing a connection ({name}, its name in Settings → Accounts & Connections): agents run on it, or its sign-in terminal is open.' })
  const refuse = (): void => {
    if (running()) throw combworkError(RUNNING, { name: a.name }, { kind: 'conflict' })
    if (terminalOpen()) throw combworkError(IN_USE, { name: a.name }, { kind: 'conflict' })
  }
  if (running()) refuse()
  if (opts.closeTerminal && hasPty(loginKey(a))) {
    // Waited on before the kill (its exit can't be missed); a kill that fails or never ends it is refused below, as open.
    const gone = ptyGone(loginKey(a), TERMINAL_GONE_MS)
    killPty(loginKey(a))
    await gone
  }
  refuse()
  assertNotHeld(a)
  await locked(id, async () => {
    // Asked again under the lock: a launch or sign-in may have started while it waited.
    refuse()
    assertNotHeld(a)
    // A server connection's key goes first (HI-1772): if that fails, nothing else is removed, the row still shows its
    // key, and Remove tries again; a later failure leaves no key behind.
    if (isServer(a)) {
      try {
        await removeKey(id)
      } catch (e) {
        log.warn(`connection ${id}'s key couldn't be removed: ${userText(String((e as Error).message ?? e))}`)
        throw combworkError(msg({ id: 'main.accounts.keyRemoveFailed', defaultMessage: "{name} wasn't removed: its key couldn't be deleted. Nothing was changed; Remove tries again.", description: "An error removing a server connection ({name}, its name in Settings → Accounts & Connections): its stored API key couldn't be deleted, so the connection was left as it was." }), { name: a.name }, { kind: 'conflict' })
      }
    }
    // Its key is gone: what was asked for it stops now (HI-2683, HR3 round 1), whatever comes of the rest.
    for (const fn of removedHooks) {
      try {
        fn(id)
      } catch (e) {
        log.warn('an account removal hook failed', e)
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
      throw combworkError(msg({ id: 'main.accounts.removeFailed', defaultMessage: "{name} wasn't removed: {error}. Nothing outside its folder was touched; Remove tries again.", description: "An error removing a connection ({name}): its folder couldn't all be deleted. {error} is the reason, in English." }), { name: a.name, error: why }, { kind: 'conflict' })
    }
    // Its connections go with it (HI-2106): agents on one launch on their CLI's first usable connection, saying so (decision H).
    config.update((c) => void (c.connections = (c.connections ?? []).filter((x) => x.account !== id)))
    changeAccounts((all) => {
      all.splice(0, all.length, ...all.filter((x) => x.id !== id))
      // A usage move to it has nowhere to go (HI-2195): turned off, and Settings shows it so.
      for (let i = 0; i < all.length; i++) if (all[i].usageMove?.to === id) all[i] = { ...all[i], usageMove: undefined }
    })
    config.update((c) => {
      for (const [p, v] of Object.entries(c.lastUsedConnection ?? {})) if (v === id) delete c.lastUsedConnection![p as ProviderId]
    })
    forgetConnectionUsage(id)
    setUpRead.delete(id)
    for (const k of [...trustState.keys()]) if (k.startsWith(`${id}|`)) dropTrust(k)
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

/**
 * Per connection, whether its CLI's first-run setup is done in its folder (HI-1870: Set Up), as last read from the
 * CLI's own files (connectionSetUp); null, can't be told. Read again at each check, as Settings shows, and as a Set Up
 * ends; never kept, so a folder set up elsewhere (an agent's pane) shows as done at the next read.
 */
const setUpRead = new Map<string, boolean | null>()

/** The longest git may take to list a project's worktrees for the trust check (HI-1870): unknown past it. */
const GIT_TRUST_MS = 10_000

/** A project's folder for the trust check (HI-1870): its name, where Set Up opens, and how the CLIs look it up. */
interface ProjectTarget extends TrustTarget {
  project: string
}

/**
 * The folders a workspace's projects need trusted (HI-1870), one per project: a Git project's main repository root
 * (`git rev-parse --git-common-dir`'s parent, real path), which covers the project and every slot, copy and worktree
 * made from it (probed: Claude Code 2.1.311, Codex 0.164.0; a worktree's own entry covers only itself), or a project
 * without Git's own real path. Read off main's thread (git's worker, async file calls).
 */
export function trustTargets(projects: readonly { name: string; path: string }[]): Promise<ProjectTarget[]> {
  // One resolution per project set at a time, shared by every connection and window asking for it.
  const sig = JSON.stringify(projects)
  const under = targetsInFlight.get(sig)
  if (under) return under
  const now = Promise.all(projects.map((p) => targetSlot(() => resolveTarget(p)))).finally(() => targetsInFlight.delete(sig))
  targetsInFlight.set(sig, now)
  return now
}

/** Target resolutions under way, by project set (HI-1870 round 1: refreshes join them rather than start more git). */
const targetsInFlight = new Map<string, Promise<ProjectTarget[]>>()

/** How many projects' folders are resolved at once, across every connection, window and workspace: the rest wait. */
const TARGETS_AT_ONCE = 4
let targetsRunning = 0
const targetsWaiting: (() => void)[] = []
async function targetSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (targetsRunning >= TARGETS_AT_ONCE) await new Promise<void>((r) => targetsWaiting.push(r))
  targetsRunning++
  try {
    return await fn()
  } finally {
    targetsRunning--
    targetsWaiting.shift()?.()
  }
}

/** One project's folder for the trust check (trustTargets). */
async function resolveTarget(p: { name: string; path: string }): Promise<ProjectTarget> {
  const real = await realpath(p.path).catch(() => null)
  // An 8.3 path (a `~N` part its long form doesn't have): Claude Code doesn't expand it.
  const short = /~\d/.test(p.path) && !!real && real.toLowerCase() !== resolve(p.path).toLowerCase()
  const run = (cwd: string, args: string[]) => git(cwd, args, undefined, undefined, { timeout: GIT_TRUST_MS }).catch(() => null)
  const r = await run(p.path, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'])
  if (!r?.ok) {
    // Not a repository (git says so): the folder itself. Anything else (a bare repository, a timeout, git missing)
    // can't be told, and Set Up never opens in a git folder.
    const notRepo = !!r && /not a git repository/i.test(r.err)
    return { project: p.name, root: notRepo ? real : null, git: !notRepo && !!real, short, folder: real }
  }
  const [gitDir, common, top] = r.out.trim().split(/\r?\n/)
  const same = (a?: string, b?: string): boolean => !!a && !!b && resolve(a).toLowerCase() === resolve(b).toLowerCase()
  // In the main working tree (its git folder the common one, wherever that is kept): its top level.
  let tree: string | undefined = same(gitDir, common) ? top : undefined
  if (!tree) {
    // A linked worktree: the main working tree, as git lists it first, checked to be one (not a git folder).
    const worktrees = await run(p.path, ['worktree', 'list', '--porcelain'])
    const first = worktrees?.ok ? worktrees.out.split(/\r?\n\r?\n/)[0].split(/\r?\n/) : []
    const listed = first.includes('bare') ? undefined : first.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
    const check = listed ? await run(listed, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']) : null
    const [itsCommon, itsTop] = check?.ok ? check.out.trim().split(/\r?\n/) : []
    if (same(itsCommon, common) && same(itsTop, listed)) tree = itsTop
  }
  return { project: p.name, root: tree ? await realpath(tree).catch(() => null) : null, git: true, short, folder: real }
}

const trustKey = (id: string, ws: string): string => `${id}|${ws.toLowerCase()}`

/** A folder still to trust: its project, where it is asked, and whether it's a Git root (HI-2520: no inherited trust then). */
type PendingTrust = { project: string; folder: string; git: boolean }
type TrustAnswer = { pending: PendingTrust[]; unknown: boolean }
type Projects = { name: string; path: string }[]

/**
 * A connection's trust of one workspace's projects (HI-1870 round 3), per `<id>|<workspace>`. At most one read runs; a
 * request meanwhile only marks it `dirty` (nothing is queued). `gen` moves when the project set asked for changes, the
 * connection's own generation moves, or one of its terminals ends; a read's answer is kept only if `gen` is still the
 * one it started at, and a read ending dirty, or with `gen` moved, reads once more for the projects wanted now.
 */
interface TrustState {
  gen: number
  sig: string
  projects: Projects
  /** The connection's own generation when `gen` last moved (removed or made again: everything older is stale). */
  conn: number
  running: boolean
  dirty: boolean
  result?: { gen: number; answer: TrustAnswer }
  /**
   * Callers waiting for a current answer (Set Up's folder): resolved once idle with one (null: none could be read), or
   * `cancelled` when the state goes (its connection removed, its workspace closed).
   */
  waiters: ((a: TrustAnswer | null | 'cancelled') => void)[]
  /** Gone from the map (dropTrust): a read of it still under way stores nothing, reads no more and tells no one. */
  retired: boolean
}
const trustState = new Map<string, TrustState>()

/** Asks for a connection's trust of a workspace's projects; `changed`: something may have changed it (a terminal ended). */
function requestTrust(id: string, ws: string, projects: Projects, mayHaveChanged = false): TrustState {
  const key = trustKey(id, ws)
  const sig = JSON.stringify(projects)
  const conn = generation(id)
  let st = trustState.get(key)
  if (!st) {
    st = { gen: 0, sig, projects, conn, running: false, dirty: false, waiters: [], retired: false }
    trustState.set(key, st)
  }
  if (st.sig !== sig || st.conn !== conn || mayHaveChanged) {
    st.gen++
    st.sig = sig
    st.projects = projects
    st.conn = conn
  }
  if (st.running) st.dirty = true
  else void runTrust(key, id, st)
  return st
}

/** The one read of a key: its answer kept only while its generation is current, then once more if it went stale. */
async function runTrust(key: string, id: string, st: TrustState): Promise<void> {
  st.running = true
  st.dirty = false
  const gen = st.gen
  const answer = await readTrustOnce(id, st.projects).catch(() => null)
  st.running = false
  // Removed meanwhile, or the workspace closed (and maybe opened again, with a new state for the key): this read's state
  // is retired, and its waiters were told. Nothing of it goes on.
  if (st.retired || trustState.get(key) !== st) return
  if (!getAccount(id) || st.conn !== generation(id)) return dropTrust(key)
  const current = gen === st.gen
  if (current && answer) {
    const was = st.result
    st.result = { gen, answer }
    // A new generation's answer is a change to show even when it reads the same (round 3: Checking… must clear).
    if (!was || was.gen !== gen || JSON.stringify(was.answer) !== JSON.stringify(answer)) emit({ type: 'connections-changed' })
  }
  if (st.dirty || !current) return void runTrust(key, id, st)
  for (const w of st.waiters.splice(0)) w(st.result?.gen === st.gen ? st.result.answer : null)
}

/**
 * Tests only (unpackaged builds): CW_TEST_HOLD_TRUST=<file> holds each trust read until that file exists, so a suite
 * can show Checking… (HI-1870 round 3).
 */
async function trustTestHold(): Promise<void> {
  const file = !app.isPackaged ? process.env.CW_TEST_HOLD_TRUST : undefined
  if (!file) return
  while (!(await lstat(file).then(() => true, () => false))) await new Promise((r) => setTimeout(r, 100))
}

/** One reading of a connection's trust of these projects, through its adapter. */
async function readTrustOnce(id: string, projects: Projects): Promise<TrustAnswer | null> {
  await trustTestHold()
  const a = getAccount(id)
  const read = a && provider(a.provider).connectionTrusts
  if (!a || !read) return null
  // No folder it would be used in here (HI-1871): nothing to read, nothing pending.
  if (!projects.length) return { pending: [], unknown: false }
  const targets = await trustTargets(projects)
  const got = await read.call(provider(a.provider), accountFolder(id), targets).catch(() => targets.map(() => null))
  // Not trusted: asked at its root, or where the CLI's own reading says (Codex: the project's own folder's entry).
  const askAt = (t: ProjectTarget, r: TrustReading): string | null => (r === false ? t.root : r && typeof r === 'object' ? r.at : null)
  return { pending: targets.flatMap((t, i) => {
    const at = askAt(t, got[i])
    return at ? [{ project: t.project, folder: at, git: t.git }] : []
  }), unknown: got.some((x) => x === null) }
}

/** A key's state gone (its connection removed, its workspace closed): its waiters told there is no answer. */
function dropTrust(key: string): void {
  const st = trustState.get(key)
  if (!st) return
  trustState.delete(key)
  st.retired = true
  for (const w of st.waiters.splice(0)) w('cancelled')
}

/** Every workspace a connection's trust was read for, read again: one of its terminals ended (it may have changed). */
export function rereadTrust(id: string): void {
  for (const [k, st] of trustState) if (k.startsWith(`${id}|`)) requestTrust(id, k.slice(id.length + 1), st.projects, true)
}

/**
 * A connection's trust of this window's workspace as the view shows it (HI-1870 round 3): its answer while current;
 * else `checking`, keeping the projects already found untrusted that are still here (a definite not-done). Never done
 * from an answer for another set of projects, nor before one.
 */
function trustShown(id: string, ws: string, here: Projects): TrustAnswer & { checking?: true } {
  const st = trustState.get(trustKey(id, ws))
  const r = st?.result
  // A refresh of the same set leaves its generation (and so its answer) current while it reads again.
  if (st && r && r.gen === st.gen && st.sig === JSON.stringify(here)) return r.answer
  return { pending: (r?.answer.pending ?? []).filter((p) => here.some((h) => h.name === p.project)), unknown: true, checking: true }
}

/** Forgets trust read for workspaces no window has open any more. */
function pruneTrust(): void {
  const open = new Set(openWorkspaces().map((w) => w.path!.toLowerCase()))
  for (const k of [...trustState.keys()]) if (!open.has(k.slice(k.indexOf('|') + 1))) dropTrust(k)
}

/**
 * Where a connection's Set Up opens (HI-1870): the first folder of this window's workspace it doesn't trust yet, read
 * now (once a current answer is in), so the CLI asks its trust question there; none, its own folder (its first-run
 * screens). Always a folder there is.
 */
export async function setUpFolder(id: string): Promise<string | undefined> {
  return (await setUpPlace(id))?.folder
}

/**
 * Where a connection's Set Up opens, and what its terminal's hint says of it (HI-1871 round 1: the place actually
 * used, read now, never the one the window last showed); undefined: its own folder (its first-run screens).
 */
export async function setUpPlace(id: string): Promise<ConnectionTrust['setUpIn']> {
  const a = getAccount(id)
  if (!a || !workspace.path || !onHere(a)) return undefined
  const st = requestTrust(id, workspace.path, projectsFor(a), true)
  const answer = await new Promise<TrustAnswer | null | 'cancelled'>((r) => st.waiters.push(r))
  // Removed, or its workspace closed, while Combwork checked: Set Up opens nowhere (never its own folder instead).
  if (answer === 'cancelled') throw combworkError(msg({ id: 'main.accounts.setUpCancelled', defaultMessage: "{name}'s Set Up didn't open: the connection was removed or its workspace closed while Combwork checked its folders.", description: "An error opening a connection's Set Up (Settings → Accounts & Connections, HI-1870; {name}, its name): Combwork was checking which of the workspace's folders its coding agent CLI trusts when the connection was removed or the workspace closed, so nothing was started." }), { name: a.name }, { kind: 'conflict' })
  return answer ? setUpTarget(a, answer.pending) : undefined
}

/**
 * Where Set Up asks a CLI's trust question next (HI-1871), from the resolved trust roots still pending (each a main
 * repository root, or a project without Git's own folder: never a worktree's path). For a CLI whose trust of a folder
 * covers the plain folders inside it (`trustInherits`: Claude Code), the workspace's own folder while it covers a pending
 * folder without Git: one answer for all of those and the Assistant's home. A Git root is never covered by a folder
 * above it (HI-2520, measured with Claude Code 2.1.316–2.1.318), so each is asked at its own root, as is a root outside
 * the workspace (a worktree project's main repository kept elsewhere: HR3's case). Otherwise the first pending root
 * (Codex: one per project; a trusted folder above a repository doesn't cover it).
 */
function setUpTarget(a: Account, pending: TrustAnswer['pending']): ConnectionTrust['setUpIn'] {
  return chooseSetUpTarget(!!providerDescriptor(a.provider).capabilities.connections?.trustInherits, workspace.path, pending)
}

/** setUpTarget's choice, from whether the CLI's trust is inherited, the workspace's folder and the pending roots. */
export function chooseSetUpTarget(inherits: boolean, ws: string | null | undefined, pending: TrustAnswer['pending']): ConnectionTrust['setUpIn'] {
  if (!pending.length) return undefined
  const inside = (folder: string): boolean => !!ws && (folder + sep).toLowerCase().startsWith((resolve(ws) + sep).toLowerCase())
  // Only a pending folder without Git: the workspace's trust covers no repository, so asking there again would loop.
  if (ws && inherits && pending.some((p) => !p.git && inside(p.folder))) return { folder: resolve(ws), workspace: true }
  return { folder: pending[0].folder, project: pending[0].project }
}

/** Whether a connection is on in this window's workspace: its trust of the workspace's folders counts then. */
const onHere = (a: Account): boolean => !!workspace.path && !!workspaceAccounts(workspace.config, a.provider, list())?.on.includes(a.id)

/**
 * The folders of this window's workspace a connection would be used in (HI-1871, Darren 27 Oct ~22:30): the projects
 * with an agent whose connection, resolved as its launch would be (its own if on here, else the first in the order
 * that's on), is this one, and the Assistant's home when the Assistant's is. "Needs set up" counts only these.
 * Resolved as sessions.ts launches (HI-2162): an agent names a connection (HI-2108), whose account is the one counted.
 */
const projectsFor = (a: Account): { name: string; path: string }[] => {
  const info = workspace.info()
  const cfg = workspace.config
  const accounts = allAccounts()
  const connections = allConnections()
  const usedBy = (p: ProjectInfo, cliOf: (agent: AgentInfo) => ProviderId): boolean =>
    p.agents.some((ag) => {
      const cli = cliOf(ag)
      if (cli !== a.provider) return false
      const r = resolveAgentConnection(cfg, cli, ag.connection, accounts, connections)
      return r.ok && r.account.id === a.id
    })
  const projects = (info?.projects ?? []).filter((p) => usedBy(p, (ag) => agentProvider(ag, config.settings))).map((p) => ({ name: p.name, path: p.path }))
  const home = info?.assistant
  // An Assistant that names no CLI yet: the first usable account's, as its launch (decision A).
  const assistantCli = (ag: AgentInfo): ProviderId => (!ag.provider && !ag.connection ? (firstUsableAccount(cfg)?.provider ?? agentProvider(ag, config.settings)) : agentProvider(ag, config.settings))
  return home && usedBy(home, assistantCli) ? [...projects, { name: home.name, path: home.path }] : projects
}

/** Reads a connection's set-up state again, telling the windows when it changed. */
export async function readSetUp(id: string): Promise<void> {
  const a = getAccount(id)
  if (!a) return
  const read = provider(a.provider).connectionSetUp
  if (!read) return
  const gen = generation(id)
  let now: boolean | null
  try {
    now = await read.call(provider(a.provider), accountFolder(id))
  } catch {
    now = null
  }
  if (generation(id) !== gen || !getAccount(id) || setUpRead.get(id) === now) return
  setUpRead.set(id, now)
  emit({ type: 'connections-changed' })
}

/** Reads the folder's sign-in from the CLI, and keeps it as `observed` unless the account was removed meanwhile. */
async function checkOnce(id: string): Promise<ConnectionObserved | null> {
  void readSetUp(id)
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
      observed = s.ok ? { at, loggedIn: s.loggedIn, ...(s.loggedIn ? { email: s.email, orgId: s.orgId, plan: s.plan ?? null, ...(s.loginExpiresAt ? { loginExpiresAt: s.loginExpiresAt } : {}) } : {}) } : { ...keptIdentity(a.observed), at, loggedIn: null, error: s.error }
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
 * Opens the account's sign-in: the CLI's own login in a terminal of Combwork's, on its folder. Once it ends, the account is
 * checked; its first good login becomes the one accepted. Returns the terminal's key.
 */
export function signInAccount(id: string): Promise<string> {
  return openLoginTerminal(id, false)
}

/**
 * Opens a sign-in connection's Set Up (HI-1826): the CLI itself on its folder, so the user answers its first-run screens
 * (its theme, its notes), which a browser sign-in (`claude auth login`) leaves unanswered, before an agent starts on it.
 * Combwork types nothing and writes none of its files. The terminal is the sign-in's (one of the two at a time), and once it
 * ends the account is checked as after a sign-in. Returns the terminal's key.
 */
export function setUpSignInConnection(id: string, folder?: string): Promise<string> {
  return openLoginTerminal(id, true, folder)
}

async function openLoginTerminal(id: string, setUp: boolean, folder?: string): Promise<string> {
  // A server connection has no sign-in: its Set Up opens the CLI instead (serverConnections.ts).
  if (isServer(mustGet(id))) throw combworkError(NO_ACCOUNT, undefined, { kind: 'invalid' })
  // Started under the account's lock, so never while it is being removed: the account checked still there (a removal
  // before it wins), and its folder still the one Combwork made (a folder replaced by a link would take the CLI's login
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
        // Its trust read again too (HI-1870): a Set Up's trust question may have been answered.
        rereadTrust(id)
        void checkAccount(id).then((o) => {
          if (generation(id) !== gen) return
          const ok = acceptable(o ?? undefined, namesOrgs(a.provider))
          // Only a good, signed-in answer is taken on, and only when none is yet; a different one is a change to answer.
          if (ok && !getAccount(id)?.accepted) changeAccount(id, (x) => (x.accepted = ok))
        })
      }, setUp ? { env: {}, cwd: folder ?? accountFolder(id) } : undefined)
    } catch (e) {
      loginsOpen.delete(id)
      throw e
    }
  })
}

/**
 * Refuses an account that can't be used now: half removed, or its folder not the one Combwork made (missing, or replaced by
 * a link). Called under its lock, before anything is started on it.
 */
async function assertUsable(a: Account): Promise<void> {
  if (a.leftover) throw combworkError(msg({ id: 'main.accounts.leftover', defaultMessage: '{name} is half removed: remove it again first.', description: "An error signing a connection in ({name}): an earlier removal stopped partway, so it can't be used." }), { name: a.name }, { kind: 'conflict' })
  try {
    await assertRealFolder(accountFolder(a.id))
  } catch (e) {
    log.warn(`account ${a.id}'s folder can't be used: ${userText(String((e as Error).message ?? e))}`)
    throw combworkError(msg({ id: 'main.accounts.folderNotUsable', defaultMessage: "{name}'s folder isn't the one Combwork made (it is missing, or was moved or replaced), so nothing was started on it. Remove the connection and add it again.", description: "An error signing a connection in or starting on it ({name}, its name): its folder is missing or isn't the one Combwork made." }), { name: a.name }, { kind: 'conflict' })
  }
}

/** Keeps the login an account is now signed in as (its change answered): refused without a good one to keep. */
export function keepNewLogin(id: string): void {
  const a = mustGet(id)
  const ok = acceptable(a.observed, namesOrgs(a.provider))
  if (!ok) throw combworkError(msg({ id: 'main.accounts.nothingToKeep', defaultMessage: "{name} isn't signed in as anyone Combwork could check, so there's no login to keep.", description: "An error: Keep the new login was asked for a connection ({name}) whose latest check didn't find it signed in." }), { name: a.name }, { kind: 'conflict' })
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
    // Not there, or not the folder Combwork made: missing until the accounts folder's watch sees it back.
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

/** Every watch closed (Combwork quitting, tests). */
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
  if (check) for (const a of all) void (isServer(a) ? readSetUp(a.id) : checkAccount(a.id))
  // One not read yet (just added): its set-up state read once, a few files, its answer telling the windows (HI-1870).
  else for (const a of all) if (!setUpRead.has(a.id)) void readSetUp(a.id)
  // Its trust of the folders it would be used in here (HI-1870; HI-1871: only those, Darren), for each connection on
  // here: read as shown, and when that set of projects changed.
  pruneTrust()
  const hereOf = new Map(workspace.path ? all.filter(onHere).map((a) => [a.id, projectsFor(a)] as const) : [])
  // Read when shown (a refresh joins the read under way), or when this set of projects hasn't been read yet.
  if (workspace.path) for (const [id, here] of hereOf) if (check || trustState.get(trustKey(id, workspace.path))?.sig !== JSON.stringify(here)) requestTrust(id, workspace.path, here)
  const trustOf = (a: Account): { trust?: ConnectionTrust } => {
    const here = hereOf.get(a.id)
    if (!workspace.path || !here || !provider(a.provider).connectionTrusts) return {}
    const t = trustShown(a.id, workspace.path, here)
    const setUpIn = setUpTarget(a, t.pending)
    return { trust: { ...t, ...(setUpIn ? { setUpIn } : {}) } }
  }
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
  const keyOf = (a: Account): { key?: { last4: string; at: string } } => {
    const k = isServer(a) ? keyInfo(a.id) : undefined
    return k && k.origin === originOf(a.server?.baseUrl ?? '') ? { key: { last4: k.last4, at: k.at } } : {}
  }
  const intro = !config.get().ui.connectionsIntroShown && !all.length ? providers.filter((p) => !testHome.includes(p)) : []
  return { ...(intro.length ? { intro } : {}), providers, connections: all.map((a) => ({ ...shownServer(a), defaults: defaultsOf(a), signingIn: hasPty(loginKey(a)), folder: accountFolder(a.id), ...keyOf(a), ...(setUpRead.has(a.id) ? { setUp: setUpRead.get(a.id) } : {}), ...trustOf(a) })), workspace: ws, testHome, masking: coverageView(), order: allAccounts().map((a) => a.id), homes: allAccounts().filter((a) => a.home), connectionRows: connectionRows() }
}

/** An account's defaults as today's screens show them (HI-2106, until HI-2107): its base connection's model, effort and context. */
function defaultsOf(a: Account): ConnectionDefaults {
  const b = baseConnection(a.id, allConnections())
  return { ...(b?.model ? { model: b.model } : {}), ...(b?.effort ? { effort: b.effort } : {}), ...(b?.use200kContext ? { use200kContext: true } : {}) }
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

/** Turns an account on or off in the asking window's workspace only (which is used follows the order, HI-1875). */
export async function setAccountOn(id: string, on: boolean): Promise<void> {
  const a = mustGet(id)
  await saveChoice((c) => {
    const next = switchedOn(workspaceAccounts(c, a.provider, list()), id, on, list())
    // Only which are on (HI-2106): which is used follows the order.
    return { ...c.connections, [a.provider]: { on: next.on } }
  })
}

/**
 * Moves an account to `index` in the one order of accounts (HI-2107, decision A: every CLI's, the CLI's own homes too;
 * Combwork-wide). It never turns one on or off: what a new agent gets, and what an agent whose connection can't be used
 * here falls back to, is the first in the order that's on there, for new launches only.
 */
export function moveConnection(id: string, index: number): void {
  if (!accountById(id)) throw combworkError(NO_ACCOUNT, undefined, { kind: 'notFound' })
  const before = allAccounts().map((a) => a.id).join()
  config.update((c) => void (c.accounts = movedInGroup(c.accounts ?? [], id, Math.trunc(index))))
  if (allAccounts().map((a) => a.id).join() === before) return
  emit({ type: 'connections-changed' })
  // Running agents keep their connection; each open workspace is read again, so one now on another connection than
  // the order picks shows the restart banner's offer to switch it at its next safe point (HI-1755).
  for (const w of openWorkspaces()) void w.refresh().catch(() => undefined)
}

/**
 * HI-1875's one-time move, quietly, at start: each CLI's most recently used workspace default goes to the top of its
 * order, the rest in the list's order. That default is the one recorded in the workspace.json of the most recently
 * opened workspace (`recentWorkspaces`, newest first) that has one for that CLI, read only; never
 * `lastUsedConnection`, which a launch on an agent's own connection writes too (HR3, HI-1875's design). None recorded:
 * the list's order stays. A default left in a workspace.json is ignored from then on (the first on in the order is
 * used). Reordered meanwhile by the user: their order stands.
 */
export async function migrateConnectionOrder(): Promise<void> {
  if (config.get().connectionOrderMigrated) return
  await accountTestHooks.beforeOrderRead?.()
  const before = list().map((a) => a.id).join()
  const tops = new Map<ProviderId, string>()
  for (const ws of config.get().recentWorkspaces) {
    const cfg = await readKeptJson<Partial<WorkspaceConfig>>(join(treeOf(ws), 'workspace.json'), {})
    for (const [p, w] of Object.entries(cfg.connections ?? {}) as [ProviderId, WorkspaceConnections | undefined][]) {
      const id = w?.default
      if (id && !tops.has(p) && getAccount(id)?.provider === p) tops.set(p, id)
    }
  }
  config.update((c) => {
    if (c.connectionOrderMigrated) return
    if ((c.accounts ?? []).filter((a) => !a.home).map((a) => a.id).join() === before) {
      for (const id of tops.values()) {
        c.accounts = movedConnection(c.accounts ?? [], id, 0)
        // As if moved before the accounts migration read them (HI-2106): the workspaces it reads them for later see this order too.
        const m = c.migrations?.accounts1
        if (m) m.legacy = movedConnection(m.legacy, id, 0)
      }
    }
    c.connectionOrderMigrated = true
  })
  if (tops.size) {
    log.info(`connections: preference order begins with each CLI's most recent workspace default (HI-1875): ${[...tops].map(([p, id]) => `${p} ${id}`).join(', ')}`)
    emit({ type: 'connections-changed' })
  }
}

/**
 * An agent as the window reads it (HI-2108), once its project is migrated: `connection` is its connection's id, as saved,
 * and its model, effort, context and mode are its connection's values, which its footer shows before it starts and its
 * mode badge's menu reads. They are never sent back: a change is a change of its connection.
 */
export function agentLaunchView(a: AgentDef, cfg: Pick<ProjectConfig, 'migrations'>): Partial<AgentInfo> {
  // Not migrated yet, or no connection yet (its CLI has no account: its own, as kept): as it is.
  if (!cfg.migrations?.accounts1 || !a.connection) return {}
  const c = getConnection(a.connection)
  return { model: c?.model, effort: c?.effort, use200kContext: c?.use200kContext, permissionMode: c?.permissionMode }
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
  note?: 'offFallback' | 'missing' | 'unknownLogin' | 'loginChanged'
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
  none: msg({ id: 'main.connections.launch.none', defaultMessage: 'No {cli} account is on in this workspace. Add one in Settings → Accounts & Connections and sign it in, then start {agent} again.', description: "Starting an agent ({agent}, its name) is refused: its workspace has no account on for its coding agent CLI ({cli}: \"Claude Code\"). Settings → Accounts & Connections names a section." }),
  offHere: msg({ id: 'main.connections.launch.offHere', defaultMessage: "{n, plural, one {{cli}'s account, {names}, is off in this workspace.} other {{cli}'s accounts, {names}, are off in this workspace.}} Turn one on with On here in Settings → Accounts & Connections, then start {agent} again.", description: "Starting an agent ({agent}, its name) is refused (HI-2650): its coding agent CLI ({cli}: \"Claude Code\") has accounts, but none is on in this workspace. {names}: their names, joined (\"Work and Personal\"); {n}: how many. On here is the switch on each account's row in Settings → Accounts & Connections." }),
  offNoDefault: msg({ id: 'main.connections.launch.offNoDefault', defaultMessage: "{agent}'s account, {name}, is off in this workspace, and no other {cli} account is on. Turn one on in Settings → Accounts & Connections.", description: "Starting an agent ({agent}) is refused: the connection chosen for it ({name}) is off in this workspace and there's no default to use instead. {cli} is the coding agent CLI." }),
  deleted: msg({ id: 'main.connections.launch.deleted', defaultMessage: "The connection chosen for {agent} no longer exists. Choose another in its Agent Settings.", description: 'Starting an agent ({agent}) is refused: the connection chosen for it was removed. Agent Settings names a dialog.' }),
  changedAgain: msg({ id: 'main.connections.launch.changedAgain', defaultMessage: "{agent}'s connection was changed again while it was starting. Start it again.", description: "Starting an agent ({agent}, its name) failed: the connection chosen for it was changed while it was starting, and again while Combwork started it once more on the new choice. A connection is how a coding agent CLI signs in or reaches its model (Settings → Accounts & Connections)." }),
  otherProvider: msg({ id: 'main.connections.launch.otherProvider', defaultMessage: 'The connection chosen for {agent} is for another CLI. Pick a {cli} connection in its Agent Settings.', description: 'Starting an agent ({agent}) is refused: the connection chosen for it belongs to another coding agent CLI. {cli} is the agent\'s CLI ("Claude Code").' }),
  signedOut: msg({ id: 'main.connections.launch.signedOut', defaultMessage: '{name} is signed out. Sign it in again in Settings → Accounts & Connections, then start {agent}.', description: "Starting an agent ({agent}) is refused: its account ({name}) isn't signed in." }),
  changing: msg({ id: 'main.connections.launch.changing', defaultMessage: "{name}'s login kept changing while Combwork checked it. Try starting {agent} again in a moment.", description: "Starting an agent ({agent}) is refused: its connection's ({name}) login changed again and again while Combwork checked who it is signed in as." }),
  noKey: msg({ id: 'main.connections.launch.noKey', defaultMessage: '{name} has no key. Add one in Settings → Accounts & Connections, then start {agent}.', description: "Starting an agent ({agent}) is refused: its server account ({name}) reaches a server that needs an API key, and none is saved for it. Settings → Accounts & Connections names a section." })
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
function shownServer(a: Account): Account {
  const caps = a.server ? providerDescriptor(a.provider).capabilities.connections?.server : undefined
  return caps && a.server ? { ...a, server: { ...a.server, models: effectiveModels(caps, a.server) } } : a
}

/**
 * A server connection's part of a launch (HI-1772): its key decrypted for this launch's environment (refused without
 * one, unless its server is this machine's), and that key masked from now until the launch's process is gone.
 */
async function serverPart(a: Account, caps: ServerCaps, agentName: string): Promise<{ part: NonNullable<LaunchConnection['server']>; keyV: string | null; origin: string }> {
  const b = parseBaseUrl(a.server?.baseUrl ?? '')
  if (!a.server || !b.ok) throw combworkError(LAUNCH.noKey, { name: a.name, agent: agentName }, { kind: 'conflict' })
  const got = await withKey(a.id, b.origin)
  if (!got && !b.local) throw combworkError(LAUNCH.noKey, { name: a.name, agent: agentName }, { kind: 'conflict' })
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
  // Never on the order from before its one-time move (HI-1875 round 1): agents and the Assistant alike come here.
  await connectionOrderReady()
  const cli = providerDescriptor(o.provider).name
  // Its connection's account, or its CLI's first usable here (HI-2106, decision H).
  const choose = (wanted: string | null | undefined): AgentConnection => resolveAgentConnection(o.workspaceConfig, o.provider, wanted, allAccounts(), allConnections())
  const sameAs = (now: AgentConnection, id: string): boolean => now.ok && now.account.id === id
  const choice = choose(o.wanted)
  if (!choice.ok) {
    if (choice.why === 'none' && testHomeSeam(caps.homeEnv)) return null
    const name = choice.wanted ? (getConnection(choice.wanted)?.name ?? choice.wanted) : ''
    // None on here, but the CLI has accounts (HI-2650): they are off here, never "add one".
    const off = choice.why === 'none' ? list().filter((a) => a.provider === o.provider) : []
    if (off.length) throw combworkError(LAUNCH.offHere, { agent: o.agentName, cli, n: off.length, names: fmt.list(off.map((a) => a.name)) }, { kind: 'conflict' })
    throw combworkError(LAUNCH[choice.why], { agent: o.agentName, cli, name }, { kind: 'conflict' })
  }
  // A test home's account (the seam): the CLI's own home, as before connections.
  if (choice.account.home) return null
  const id = choice.account.id
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
        throw combworkError(NO_ACCOUNT, undefined, { kind: 'notFound' })
      }
      return {
        id,
        name: a.name,
        folder: accountFolder(id),
        homeEnv: caps.homeEnv,
        ...(choice.note ? { note: choice.note } : {}),
        release,
        server: part,
        stillValid: (wanted) => same() && sameAs(choose(wanted), id)
      }
    }
    const { observed, fresh } = await confirmAccount(id)
    const a = getAccount(id)
    if (!a || generation(id) !== gen) throw combworkError(NO_ACCOUNT, undefined, { kind: 'notFound' })
    if (!fresh) throw combworkError(LAUNCH.changing, { name: a.name, agent: o.agentName }, { kind: 'conflict' })
    if (observed?.missing) await assertUsable(a)
    if (observed?.loggedIn === false) throw combworkError(LAUNCH.signedOut, { name: a.name, agent: o.agentName }, { kind: 'conflict' })
    const note = choice.note ?? (observed?.loggedIn === null ? 'unknownLogin' : accountState(a) === 'changed' ? 'loginChanged' : undefined)
    return {
      id,
      name: a.name,
      folder: accountFolder(id),
      homeEnv: caps.homeEnv,
      ...(note ? { note } : {}),
      ...(usageLogin(observed) ? { login: usageLogin(observed)! } : {}),
      release,
      stillValid: (wanted) => generation(id) === gen && !!getAccount(id) && sameAs(choose(wanted), id)
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
      if (again) throw combworkError(LAUNCH.changedAgain, { agent: o.agentName }, { kind: 'conflict' })
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
 * Combwork shows or allows from a CLI's home; undefined when the provider's sign-in isn't its connections' (it has none, or
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
  missing: msg({ id: 'main.connections.choice.missing', defaultMessage: "The connection chosen for {agent} no longer exists. Choose another, or the workspace's default.", description: "An error saving an agent's settings (or adding one): the connection chosen for it ({agent}, its name) was removed. A connection is how a coding agent CLI signs in or reaches its model (Settings → Accounts & Connections)." }),
  otherCli: msg({ id: 'main.connections.choice.otherCli', defaultMessage: "{name} is for another CLI than {agent}'s. Choose one of its own.", description: "An error saving an agent's settings (or adding one): the connection chosen ({name}) belongs to another coding agent CLI than the agent's ({agent}, its name)." }),
  off: msg({ id: 'main.connections.choice.off', defaultMessage: "{name} isn't on in this workspace. Turn it on in Settings → Accounts & Connections, or choose another for {agent}.", description: "An error saving an agent's settings (or adding one): the connection chosen ({name}) is off in this workspace, so it can't be the agent's ({agent}, its name). Settings → Accounts & Connections names a section." })
}

/**
 * Why a connection can't be saved as an agent's own choice in a project now (HI-1769): removed, another CLI's, or not on
 * in its workspace; null when it can. Read from memory, so it is checked again with the write that saves it.
 */
export function connectionProblem(id: string, cli: ProviderId, projectPath: string): ConnectionProblem | null {
  const a = accountById(id)
  if (!a) return 'missing'
  if (a.provider !== cli) return 'otherCli'
  // The CLI's own home (Copilot's sign-in, a test home) is on everywhere.
  return a.home || connectionOnHere(id, cli, projectPath) ? null : 'off'
}

/** Refuses a connection that can't be an agent's own choice here (connectionProblem), saying why. */
export function assertConnectionHere(id: string, cli: ProviderId, projectPath: string, agent: string): void {
  const why = connectionProblem(id, cli, projectPath)
  if (why) throw combworkError(CHOICE[why], { agent, name: accountById(id)?.name ?? id }, { kind: 'conflict' })
}

/** Whether a connection is one of the provider's on in the workspace a project (or host) belongs to (HI-1755). */
export function connectionOnHere(id: string, cli: ProviderId, projectPath: string): boolean {
  const ws = workspaceOf(projectPath)
  return !!ws.path && !!workspaceAccounts(ws.config, cli, list())?.on.includes(id)
}

/** The connections' one-time order move under way or done (HI-1875 round 1): what depends on the order waits for it. */
let orderReady: Promise<void> = Promise.resolve()

/** Starts the one-time order move (once, at Combwork's start); its failure is logged, the order then as it was. */
export function startConnectionOrder(): Promise<void> {
  orderReady = migrateConnectionOrder().catch((e) => log.warn("connections: the preference order's one-time move failed", e))
  return orderReady
}

/** Resolves once the connections' order is final: before it, a launch would use the old one. */
export const connectionOrderReady = (): Promise<void> => orderReady

/** Returns once the order is final (index.ts waits for it before workspaces open and the Agent API starts). */
export function initConnections(): Promise<void> {
  // No agent is given a connection that is gone or being removed (HI-2107).
  setConnectionGuard(connectionAssignable)
  // The most recent workspace default becomes the top of its CLI's preference order, once (HI-1875); what depends on
  // the order (a launch on a connection) waits for it. A new workspace starts with none on (HI-2650, Darren 6 Nov).
  const ready = startConnectionOrder()
  onCombworkEvent((e) => {
    if (e.type !== 'workspace-changed') return
    syncWatches()
    // A workspace closed: its connections' trust reads are dropped, and a Set Up waiting on one is cancelled (HI-1870).
    pruneTrust()
  })
  // The patterns of models a server runs elsewhere (HI-1773): a change re-marks the models windows show.
  const patterns = (): string => PROVIDERS.flatMap((p) => p.capabilities.connections?.server?.presets ?? []).map((p) => (p.remoteModels ? advanced.pattern(p.remoteModels).source : '')).join('\n')
  let shown = patterns()
  advanced.onChange(() => {
    // A CLI's trust reading may follow an advanced setting (HI-1871: Codex's per-launch trust): read again, fresh.
    for (const [k, st] of trustState) requestTrust(k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1), st.projects, true)
    const now = patterns()
    if (now === shown) return
    shown = now
    emit({ type: 'connections-changed' })
  })
  return ready
}
