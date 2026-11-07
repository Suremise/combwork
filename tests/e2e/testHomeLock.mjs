// The CLI test homes' leases (#478 for Codex; HI-2606 for both): one slot per home, by its real path, held for a whole
// real suite, a scenario run or a clean, across worktrees. A home is reset (testHomes.mjs) only under its lease, so the
// lease is what keeps a reset from running under a CLI another run started there.
//
// Reentrant within one run's process tree: a holder passes what it holds to the children it starts for it in
// CW_TEST_HOME_LEASES (leasesEnv: a suite, a nested runner), and they reuse it instead of queueing behind their parent.
// One order: Claude Code's home before Codex's. Asking for Claude Code's while Codex's is held (here or by a parent) is
// refused, so two runs needing both can never hold one each and wait for the other.
import { createHash, randomBytes } from 'crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { createRequire } from 'module'
import { describeClaim, waitForSlot } from './slots.mjs'
import { slotWaitProgress } from '../progressReport.mts'

const ctx = createRequire(import.meta.url)('./runContext.cjs')

/** The CLIs with a shared test home, in the one order their leases are taken. */
export const HOME_ORDER = ['claude', 'codex']
const NAMES = { claude: 'the Claude Code test home', codex: 'the Codex test home' }
/** The variable a holder passes its children: `{ "<cli>": "<lock folder>" }`. */
export const LEASES_VAR = 'CW_TEST_HOME_LEASES'

/** The lock folder of a CLI's test home (its real path's hash); a user's own CLI home is refused. */
export function homeLockDir(cli, home, poolRoot = join(ctx.TEST_ROOT, `${cli}-home-locks`)) {
  if (!HOME_ORDER.includes(cli)) throw new Error(`no test home lease for ${cli}`)
  let canonical = resolve(home)
  try {
    canonical = realpathSync.native(canonical)
  } catch {
    // A not-yet-created test home still has a stable absolute name.
  }
  if (ctx.isUserCliHome(home) || ctx.isUserCliHome(canonical)) throw new Error(`CLI home leases require a test home, never a user's own (${NAMES[cli]})`)
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  return join(poolRoot, createHash('sha256').update(canonical).digest('hex').slice(0, 24))
}

/** What this process holds itself (for the order check). */
const own = new Map()
/** What a parent passed this process: `{ cli: { dir, gen, pid, started } }` (an older form, a bare folder, is never reused). */
function inherited(env = process.env) {
  try {
    const v = JSON.parse(env[LEASES_VAR] || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}
/** Every lease held in this run's tree, by CLI (its lock folder): for the order check. */
export function heldLeases(env = process.env) {
  return { ...Object.fromEntries(Object.entries(inherited(env)).map(([c, v]) => [c, typeof v === 'object' ? v?.dir : v])), ...Object.fromEntries(own) }
}
/**
 * The variable a holder gives the children it starts for what holds the leases (a suite, a nested runner): each lease's
 * folder with its acquisition's generation and holder (HR1 on s29), never set on this process's own environment, where
 * suites running beside it would take it for theirs.
 */
export function leasesEnv(leases, env = process.env) {
  const held = { ...inherited(env) }
  for (const l of leases) if (l?.cli && l.dir && l.gen) held[l.cli] = { dir: l.dir, gen: l.gen, pid: l.holderPid, started: l.holderStarted }
  return Object.keys(held).length ? { [LEASES_VAR]: JSON.stringify(held) } : {}
}

/** The machine's processes (folderProcesses.cjs), or null when they can't be listed. */
function listProcesses() {
  try {
    return createRequire(import.meta.url)('./folderProcesses.cjs').processes()
  } catch {
    return null
  }
}

/** A process's start may be read a little apart from when its holder recorded it (its own clock, then the system's). */
const START_SLACK_MS = 2000
const sameStart = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= START_SLACK_MS

/**
 * Whether `pid` is the live holder that was recorded (its actual start, as the system lists it, the recorded one: a pid
 * reused since is another process) and `owner` is that holder or a process it started (HR2 on s34). From one process list.
 */
export function holderLiveFor(holder, owner, list) {
  if (!list) return false
  const live = list.find((p) => p.pid === holder.pid)
  if (!live || !sameStart(live.started, holder.started)) return false
  if (owner === holder.pid) return true
  // Up the reuser's parent chain, each parent started before its child (a parent id reused since is no parent).
  const byPid = new Map(list.map((p) => [p.pid, p]))
  let p = byPid.get(owner)
  for (let hops = 0; p && hops < 64; hops++) {
    const parent = byPid.get(p.parent)
    if (!parent || parent.started > p.started) return false
    if (parent.pid === holder.pid) return sameStart(parent.started, holder.started)
    p = parent
  }
  return false
}

/** The most consumers a home's lease state keeps: past it, registering one is refused, never an old one forgotten. */
export const MAX_CONSUMERS = 2000
/** Why a lease state can't be used: unreadable, not JSON, or not its shape. Its file is never written over then. */
export class LeaseStateUnknown extends Error {}

const isConsumer = (c) => !!c && typeof c === 'object' && (typeof c.folder === 'string' ? !!c.folder : Number.isInteger(c.pid) && c.pid > 0 && typeof c.started === 'number' && c.started > 0)
const isHolder = (h) => h === null || (!!h && typeof h === 'object' && Number.isInteger(h.pid) && h.pid > 0 && typeof h.started === 'number' && typeof h.gen === 'string' && !!h.gen)

/**
 * A home's lease state (`holder.state` in its lock folder; HR1 on s17 and s29, HR2 on s34): `holder`, who holds it now
 * (pid, start, and the acquisition's random generation; null once let go), and `consumers`, what used the home and hasn't
 * been proven gone: a suite's folder (registered before it starts), its process and its test copies of Combwork.
 * Consumers outlive the lease that noted them, a clean release and a crash alike; only a reset that found none of them
 * using the home clears them (clearConsumers). A holder left in the record by a run that ended without letting go is a
 * consumer too. None there (never written, or let go with nothing left): null. Unreadable, not JSON or not that shape:
 * LeaseStateUnknown, never taken for empty.
 */
export function holderOf(dir) {
  const file = join(dir, 'holder.state')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw new LeaseStateUnknown(`${file} can't be read (${e?.code ?? e?.message})`)
  }
  let s
  try {
    s = JSON.parse(text)
  } catch {
    throw new LeaseStateUnknown(`${file} isn't JSON (cut short?)`)
  }
  if (!s || typeof s !== 'object' || !isHolder(s.holder ?? null) || !Array.isArray(s.consumers) || !s.consumers.every(isConsumer)) throw new LeaseStateUnknown(`${file} isn't a lease state (holder, consumers)`)
  return { holder: s.holder ?? null, consumers: s.consumers }
}
function writeState(dir, state) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'holder.state')
  // Nothing to keep: no record (a lock folder left as the slots leave it).
  if (!state.holder && !state.consumers.length) return void rmSync(file, { force: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, file)
}
const key = (c) => (c.folder ? `f:${String(c.folder).toLowerCase()}` : `p:${c.pid}:${c.started}`)

/**
 * Notes what uses the home under this lease (HR1 on s17, s29), before it does: a suite's folder before the suite starts
 * (the CLIs Combwork starts there name it on their command lines), the suite's process as soon as it is spawned, and its
 * test copies of Combwork. Kept until a reset proves them gone: none is ever dropped (HR2 on s34). Past MAX_CONSUMERS,
 * refused, saying what to do; under a lease whose state couldn't be read, nothing is written (its reset is refused).
 */
export function noteConsumers(lease, roots) {
  if (!lease?.dir || lease.reused || lease.stateUnknown || !roots.length) return
  const s = holderOf(lease.dir) ?? { holder: null, consumers: [] }
  const seen = new Set(s.consumers.map(key))
  const add = roots.filter((r) => isConsumer(r.folder ? { folder: r.folder } : { pid: r.pid, started: r.started }) && !seen.has(key(r))).map((r) => (r.folder ? { folder: r.folder } : { pid: r.pid, started: r.started }))
  if (s.consumers.length + add.length > MAX_CONSUMERS) throw new Error(`the test home's lease state ${join(lease.dir, 'holder.state')} already keeps ${s.consumers.length} consumers no reset has checked: run once without --warm-homes, so a reset checks and lets go of those gone`)
  if (add.length) writeState(lease.dir, { ...s, consumers: [...s.consumers, ...add] })
}

/** After a reset found none of them using the home: its consumers are let go (the holder stays as it is). */
export function clearConsumers(lease) {
  if (!lease?.dir || lease.reused || lease.stateUnknown) return
  const s = holderOf(lease.dir) ?? { holder: null, consumers: [] }
  writeState(lease.dir, { ...s, consumers: [] })
}

/**
 * Takes a CLI test home's lease (waiting in turn, as the slots do), or reuses the one a parent passed this process
 * (CW_TEST_HOME_LEASES) only while that exact acquisition still holds it (its generation, pid and start in the lease
 * state; HR1 on s29) and that holder is the live process recorded and this process is it or one it started (HR2 on s34:
 * `processes`, the process list, read once). An older token, a reused pid or an unrelated process with the current
 * token is taken for nothing. A reused lease never lets its user reset the home (`reused`: testHomes.mjs refuses).
 * Refused out of order: Claude Code's while Codex's is held. A lease state that can't be read is left as it is
 * (`stateUnknown`: no reset under it). `release()` lets it go (a reused one: nothing), keeping its consumers.
 */
export async function acquireTestHome(cli, home, { poolRoot, env = process.env, alive, owner = process.pid, ownerStarted = Math.floor(Date.now() - process.uptime() * 1000), processes = listProcesses, ...options } = {}) {
  const dir = homeLockDir(cli, home, poolRoot)
  const token = inherited(env)[cli]
  if (token && typeof token === 'object' && token.dir === dir) {
    let now = null
    try {
      now = holderOf(dir)?.holder ?? null
    } catch {
      // Unknown: never reused.
    }
    if (now && token.gen === now.gen && token.pid === now.pid && token.started === now.started && holderLiveFor(now, owner, processes())) return { release() {}, reused: true, waitedMs: 0, dir, cli }
  }
  const held = heldLeases(env)
  const after = HOME_ORDER.slice(HOME_ORDER.indexOf(cli) + 1).filter((c) => held[c])
  if (after.length) throw new Error(`${NAMES[cli]} is asked for while ${after.map((c) => NAMES[c]).join(' and ')} is held: test home leases are taken in the order ${HOME_ORDER.join(', then ')}`)
  const lease = await waitForSlot(dir, { ...options, owner, ...(alive ? { alive } : {}), slots: 1 })
  lease.dir = dir
  lease.cli = cli
  if (!lease.release) return lease
  let s
  try {
    s = holderOf(dir) ?? { holder: null, consumers: [] }
  } catch (e) {
    // Its consumers unknown: the file stays as it is for someone to look at, and no reset runs under this lease.
    lease.stateUnknown = e.message
  }
  if (s) {
    // A holder still in the record ended without letting go: what it ran may still be using the home.
    const consumers = s.holder && s.holder.pid !== owner ? [...s.consumers, { pid: s.holder.pid, started: s.holder.started }] : s.consumers
    if (s.holder && s.holder.pid !== owner) lease.takeover = { pid: s.holder.pid, started: s.holder.started }
    lease.gen = randomBytes(12).toString('hex')
    lease.holderPid = owner
    lease.holderStarted = ownerStarted
    writeState(dir, { holder: { pid: owner, started: ownerStarted, gen: lease.gen }, consumers })
  }
  own.set(cli, dir)
  const release = lease.release
  lease.release = () => {
    // waitForSlot registers this cleanup on exit. Suites release earlier too; don't accumulate exit listeners.
    process.off('exit', release)
    try {
      // Let go: no holder; what it noted using the home stays until a reset proves it gone.
      const state = lease.stateUnknown ? null : holderOf(dir)
      if (state && state.holder?.gen === lease.gen) writeState(dir, { ...state, holder: null })
    } catch {
      // Not written: the next holder takes this one for one that didn't let go, and waits for what it ran.
    }
    release()
    if (own.get(cli) === dir) own.delete(cli)
  }
  return lease
}

/** acquireTestHome, saying in the console and the Progress panel who holds the home while it waits. */
export async function waitForTestHome(cli, home, { kind, root, what, argv = process.argv.slice(2) }) {
  const queue = slotWaitProgress(kind, `npm run ${kind} -- ${argv.join(' ')}`, argv, NAMES[cli])
  let said = ''
  const lease = await acquireTestHome(cli, home, {
    root,
    what,
    onWait: ({ holders, ahead }) => {
      const who = holders.map((c) => describeClaim(c)).join('; ')
      const line = `Waiting for ${NAMES[cli]} ${home}${ahead ? `, ${ahead} ahead of this one` : ''}: held by ${who || 'a run just finishing'}.`
      if (line !== said) console.log(line)
      said = line
      queue.waiting(who)
    }
  })
  if (said) {
    const after = `${Math.round(lease.waitedMs / 1000)} s`
    console.log(`Got ${NAMES[cli]} after ${after}.`)
    await queue.finish(`got ${NAMES[cli]} after ${after}`)
  }
  return lease
}

/** The test homes a suite uses: the real Claude Code's signed-in home (`claudeHome: 'test'`), Codex's (`needs` codex, or `codexHome: 'test'`). */
export function homesOf(suite) {
  return HOME_ORDER.filter((cli) => (cli === 'claude' ? suite.claudeHome === 'test' : suite.needs?.includes('codex') || suite.codexHome === 'test'))
}
