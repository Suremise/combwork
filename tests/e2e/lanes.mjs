// Runners started at the same time from different worktrees (two agents each checking their card) must not share
// Agent API ports or suite folders. Each runner claims a lane: a range of ports and a work folder for its suites, no
// other runner on this machine uses while it runs. Claims are files in a folder under %LOCALAPPDATA%\hive-test, one
// per lane (`lane-<k>.json`, with the runner's process id), taken under a short lock and released when the runner
// ends. A crashed runner's claim expires (its process is gone, or the claim is a day old, like `.active` in logs.mjs).
// A lane is only taken when its ports are free, so something else holding them (an older runner without lanes, another
// app) just moves the runner to the next lane. A runner started inside a suite doesn't claim one: it takes ports
// above its parent's (runner.mjs's portBase). Scenario runs (tests/scenarios/run.mjs) claim lanes from the same pool,
// for their folders and Agent API port. A runner that finds every lane taken waits for one (waitForLane, #707), as a heavy
// run waits for a test slot (slots.mjs), saying who holds them; --no-wait fails at once instead.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { join } from 'path'
import { processAlive } from './logs.mjs'

/**
 * Lane k's first slot port is LANE_FIRST + k × LANE_SPAN; it uses LANE_PORTS ports from one below that (the CLI lane)
 * up. Clear of the installed and dev Hives' (47821, 47822) and of the suites' own defaults (478xx–4791x) and the scenarios' (47930, tests/scenarios); and the
 * highest a runner inside a suite takes (1000 above its parent's slot) stays under 49152, where Windows hands out
 * ports to anything that asks (the hook server's among them).
 */
export const LANE_FIRST = 47940
export const LANE_SPAN = 20
export const LANES = 10
/** The CLI lane (base − 1) and up to eight slots (--jobs is at most 8), with one to spare. */
export const LANE_PORTS = 10
/** A claim older than this is from a runner that never finished (or one stuck far beyond any run). */
const CLAIM_MAX_MS = 24 * 60 * 60_000
/** The lock held while a runner looks at the claims and writes its own: only for milliseconds, so an old one is a crash. */
const LOCK = '.claiming'
const LOCK_MAX_MS = 10_000

/**
 * Where the lanes of a pool of its own (HIVE_TEST_LANES_DIR, runContext's OWN_LANES: concurrency.mjs's check of a run
 * that waits for a lane, #735) have their ports: above the machine pool's. Runs in other worktrees claim the machine
 * pool's lanes without seeing this pool's claims, so sharing ports let one of them start its test Hive on the port a
 * scenario here had just claimed, and the scenario's Agent API calls reached that Hive, which refused its token (#1127).
 * Every pool of its own has these ports, so only one is used at a time on the machine (holdOwnPool). That check starts
 * no runner inside a suite, the only thing that takes ports 1000 above a lane's.
 */
export const OWN_POOL_FIRST = LANE_FIRST + LANES * LANE_SPAN

/** Where a runner's lanes have their ports: the machine pool's, or (ownPool) a pool of its own's. */
export const lanesFirst = (ownPool) => (ownPool ? OWN_POOL_FIRST : LANE_FIRST)

/** Lane k's ports (from: the pool's first, lanesFirst): { base (the first slot's), first, last }. */
export function lanePorts(k, from = LANE_FIRST) {
  const base = from + k * LANE_SPAN
  return { base, first: base - 1, last: base - 1 + LANE_PORTS - 1 }
}

/**
 * Where lane k's suites keep their profiles, workspaces and screenshots: lanes/<k> inside the work folder, never the
 * work folder itself (a suite run on its own uses that). There are at most LANES of them, each reused by the next
 * runner in that lane; each suite has a folder of its own in it, cleared when it passes (run.mjs), and what is left
 * goes with the clean-up (clean.mjs).
 */
export function laneWork(work, k) {
  return join(work, 'lanes', String(k))
}

/** Whether a claim ({ pid, at }) still holds: its runner is running, and it isn't a day old. */
export function claimHeld(claim, alive = processAlive, now = Date.now()) {
  return !!claim && Number.isInteger(claim.pid) && claim.pid > 0 && alive(claim.pid) && now - Number(claim.at) < CLAIM_MAX_MS
}

/**
 * The lane to take: the lowest whose claim (claims[k], or none) doesn't hold and whose ports aren't busy
 * (busy: lane numbers). null when every lane is taken.
 */
export function pickLane(claims, busy = new Set(), alive = processAlive, now = Date.now()) {
  for (let k = 0; k < LANES; k++) if (!claimHeld(claims[k], alive, now) && !busy.has(k)) return k
  return null
}

/** Whether nothing listens on a port (on 127.0.0.1, where Hive's Agent API listens). */
export function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

async function lanePortsFree(k, free, from) {
  const { first, last } = lanePorts(k, from)
  for (let p = first; p <= last; p++) if (!(await free(p))) return false
  return true
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Runs fn holding the claims lock (a folder: creating one is atomic). A lock older than LOCK_MAX_MS was left by a
 * runner that crashed while holding it, and is broken. The heavy-run slots (slots.mjs) use it too. */
export async function withLock(dir, fn) {
  const lock = join(dir, LOCK)
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      // Windows refuses the folder while one just released is still being deleted (another runner's handle on it, as a
      // stat): EPERM, at times EACCES (HI-1800: 3 of 36 runners racing for it). Taken again once it is gone, within the
      // same bound; a folder Hive can't write to at all still fails then.
      if ((e.code === 'EPERM' || e.code === 'EACCES') && Date.now() - start <= 4 * LOCK_MAX_MS) {
        await sleep(50)
        continue
      }
      if (e.code !== 'EEXIST') throw e
      let age = 0
      try {
        age = Date.now() - statSync(lock).mtimeMs
      } catch {
        continue // Just released.
      }
      if (age > LOCK_MAX_MS) rmSync(lock, { recursive: true, force: true })
      else if (Date.now() - start > 4 * LOCK_MAX_MS) throw new Error(`The test claims lock ${lock} is still held`, { cause: e })
      else await sleep(50)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function readClaims(dir) {
  const claims = []
  for (const name of readdirSync(dir)) {
    const m = /^lane-(\d+)\.json$/.exec(name)
    if (!m) continue
    try {
      claims[Number(m[1])] = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      // Unreadable: no claim.
    }
  }
  return claims
}

/**
 * Claims a lane in dir for this runner: { lane, ...lanePorts(lane), release() }, or null when every lane is taken.
 * Lanes held by a live claim are skipped without looking at their ports; the others are taken only if their ports are
 * free. release() removes the claim (only if it is still this runner's). what: what the run is, for others waiting.
 * portsFrom: the pool's first port (lanesFirst).
 */
export async function claimLane(dir, { owner = process.pid, root = '', what = '', alive = processAlive, free = portFree, now = () => Date.now(), portsFrom = LANE_FIRST } = {}) {
  mkdirSync(dir, { recursive: true })
  return withLock(dir, async () => {
    const claims = readClaims(dir)
    const busy = new Set()
    for (;;) {
      const k = pickLane(claims, busy, alive, now())
      if (k === null) return null
      if (!(await lanePortsFree(k, free, portsFrom))) {
        busy.add(k)
        continue
      }
      const file = join(dir, `lane-${k}.json`)
      writeFileSync(file, JSON.stringify({ pid: owner, at: now(), root, ...(what ? { what } : {}) }))
      const release = () => {
        try {
          if (JSON.parse(readFileSync(file, 'utf8')).pid === owner) rmSync(file, { force: true })
        } catch {
          // Gone already.
        }
      }
      return { lane: k, ...lanePorts(k, portsFrom), release }
    }
  })
}

/**
 * The lanes no running runner holds (HI-1453): no claim, or one whose runner is gone (a day-old claim of a runner still
 * running is still its, unlike pickLane's). Read under the claims' lock: { lanes, at }, `at` when they were read. What
 * runs from such a lane's folder and started before `at` was left by a run that ended without ending it; a runner that
 * claims the lane after `at` starts its own after it.
 */
export async function idleLanes(dir, { alive = processAlive, now = () => Date.now() } = {}) {
  mkdirSync(dir, { recursive: true })
  return withLock(dir, async () => {
    const claims = readClaims(dir)
    const lanes = []
    for (let k = 0; k < LANES; k++) if (!(Number.isInteger(claims[k]?.pid) && claims[k].pid > 0 && alive(claims[k].pid))) lanes.push(k)
    return { lanes, at: now() }
  })
}

/**
 * Holds the machine's one pool of its own (#1127): every such pool's lanes have OWN_POOL_FIRST's ports, and each pool
 * claims its lanes under a lock of its own, so two at once (two concurrency checks) would hand out the same ports. The
 * hold is dir/own-pool.json with this process's id (a crashed holder's expires, as a lane's claim does); while another
 * live process has it, this waits, calling onWait(holder) every pollMs. Returns { release(), waitedMs }, or with
 * wait: false and the hold taken, { refused: holder } at once.
 */
export async function holdOwnPool(dir, { owner = process.pid, root = '', what = '', wait = true, pollMs = 2000, onWait = () => {}, alive = processAlive, now = () => Date.now() } = {}) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'own-pool.json')
  const started = now()
  for (;;) {
    const holder = await withLock(dir, async () => {
      let claim = null
      try {
        claim = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        // None, or unreadable: not held.
      }
      if (claimHeld(claim, alive, now())) return claim
      writeFileSync(file, JSON.stringify({ pid: owner, at: now(), root, ...(what ? { what } : {}) }))
      return null
    })
    if (!holder) {
      const release = () => {
        try {
          if (JSON.parse(readFileSync(file, 'utf8')).pid === owner) rmSync(file, { force: true })
        } catch {
          // Gone already.
        }
      }
      return { release, waitedMs: now() - started }
    }
    if (!wait) return { refused: holder }
    onWait(holder)
    await sleep(pollMs)
  }
}

/**
 * A claim, for a person: what it runs and where, whether it was left over by a session that ended (leftOver, slots.mjs,
 * #1008), its process and for how long (slots.mjs's describeClaim too).
 */
export function describeHolder(c, now = Date.now(), fallback = 'a test run') {
  const min = Math.max(0, Math.round((now - c.at) / 60_000))
  return `${c.what || fallback}${c.first ? ' (pre-merge)' : ''} in ${c.root || 'another worktree'}${c.leftOver ? ', left over from a session that ended' : ''} (process ${c.pid}, ${min} min)`
}

/** The lanes' live claims, lowest lane first ({ lane, pid, at, root, what }): who a waiting runner waits for. */
export function laneHolders(dir, alive = processAlive, now = Date.now()) {
  const claims = readClaims(dir)
  return claims.flatMap((c, k) => (claimHeld(c, alive, now) ? [{ ...c, lane: k }] : []))
}

/** What a runner waiting for a lane prints at a look that finds none (both runners). */
export function laneWaitLine({ holders }, now = Date.now()) {
  return `Waiting for a test lane (all ${LANES} are taken on this machine): held by ${holders.map((c) => describeHolder(c, now)).join('; ') || 'runs just finishing'}.`
}

/**
 * Claims a lane, waiting for one while every lane is taken (#707): with more agents than lanes checking their cards at
 * once, the extra runners wait instead of failing. { ...claimLane's, waitedMs }, or with wait: false (--no-wait), one
 * look: { refused: { holders } }. onWait({ holders }) is called at each look that finds none, every pollMs. Lanes go to
 * whichever waiting runner looks first when one is let go: a run holds one for minutes, so waiters take turns soon.
 */
export async function waitForLane(dir, { wait = true, pollMs = 2000, onWait = () => {}, ...opts } = {}) {
  const started = Date.now()
  const now = opts.now ?? (() => Date.now())
  for (;;) {
    const got = await claimLane(dir, opts)
    if (got) return { ...got, waitedMs: Date.now() - started }
    const holders = laneHolders(dir, opts.alive, now())
    if (!wait) return { refused: { holders } }
    onWait({ holders })
    await sleep(pollMs)
  }
}
