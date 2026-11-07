// The CLI test homes' leases (#478 for Codex; HI-2606 for both): one slot per home, by its real path, held for a whole
// real suite, a scenario run or a clean, across worktrees. A home is reset (testHomes.mjs) only under its lease, so the
// lease is what keeps a reset from running under a CLI another run started there.
//
// Reentrant within one run's process tree: a holder passes what it holds to the children it starts for it in
// CW_TEST_HOME_LEASES (leasesEnv: a suite, a nested runner), and they reuse it instead of queueing behind their parent.
// One order: Claude Code's home before Codex's. Asking for Claude Code's while Codex's is held (here or by a parent) is
// refused, so two runs needing both can never hold one each and wait for the other.
import { createHash } from 'crypto'
import { realpathSync } from 'fs'
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

/** What this process holds itself (for the order check), and what a parent passed it (reused). */
const own = new Map()
function inherited(env = process.env) {
  try {
    const v = JSON.parse(env[LEASES_VAR] || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}
/** Every lease held in this run's tree: `{ cli: lockDir }`. */
export function heldLeases(env = process.env) {
  return { ...inherited(env), ...Object.fromEntries(own) }
}
/**
 * The variable a holder gives the children it starts for what holds the leases (a suite, a nested runner): never set on
 * this process's own environment, where suites running beside it would take it for theirs.
 */
export function leasesEnv(leases, env = process.env) {
  const held = { ...inherited(env) }
  for (const l of leases) if (l?.cli && l.dir) held[l.cli] = l.dir
  return Object.keys(held).length ? { [LEASES_VAR]: JSON.stringify(held) } : {}
}

/**
 * Takes a CLI test home's lease (waiting in turn, as the slots do), or reuses the one a parent passed this process
 * (CW_TEST_HOME_LEASES). Refused out of order: Claude Code's while Codex's is held. `release()` lets it go (a reused
 * one: nothing).
 */
export async function acquireTestHome(cli, home, { poolRoot, env = process.env, ...options } = {}) {
  const dir = homeLockDir(cli, home, poolRoot)
  if (inherited(env)[cli] === dir) return { release() {}, reused: true, waitedMs: 0, dir, cli }
  const held = heldLeases(env)
  const after = HOME_ORDER.slice(HOME_ORDER.indexOf(cli) + 1).filter((c) => held[c])
  if (after.length) throw new Error(`${NAMES[cli]} is asked for while ${after.map((c) => NAMES[c]).join(' and ')} is held: test home leases are taken in the order ${HOME_ORDER.join(', then ')}`)
  const lease = await waitForSlot(dir, { ...options, slots: 1 })
  lease.dir = dir
  lease.cli = cli
  if (!lease.release) return lease
  own.set(cli, dir)
  const release = lease.release
  lease.release = () => {
    // waitForSlot registers this cleanup on exit. Suites release earlier too; don't accumulate exit listeners.
    process.off('exit', release)
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
