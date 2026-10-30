// Is the dev build in out/ made from the source as it is now? The runner (run.mjs) asks before running suites, so a run
// record never vouches for code that wasn't built. File times can't say: deleting a source file, or restoring an older
// copy, leaves every remaining file older than the build. So a build made with --build stamps out/ with a hash of
// everything it was made from (the paths and their contents), and a run compares that with the source now. A build
// made another way (npx electron-vite build) has no stamp, so which code it holds is unknown.
//
// Runners started at the same time in one worktree (two agents' checks, an e2e run beside a scenario run) share its
// out/: building it is done under a lock per worktree (#200, #203). The first runner to find the build stale takes the
// lock, looks again, builds once and stamps it; the others wait for the lock, look again, and find it fresh. A runner
// that only checks (no --build) waits while another builds, so it never looks at half a build. Worktrees don't wait
// for each other. A lock whose runner is gone (crashed, killed) is broken by the next one.
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { createRequire } from 'module'
import { join, relative, resolve, sep } from 'path'
import { processAlive } from './logs.mjs'

const runContext = createRequire(import.meta.url)('./runContext.cjs')

/**
 * What the build reads: its source, bundled resources and docs, the translations main bundles (locales, #767), the root
 * files the app imports, and its config.
 */
export const BUILD_INPUTS = ['src', 'resources', 'docs', 'locales', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'electron.vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json']
const STAMP = join('out', '.e2e-build.json')

/** A hash of the build's inputs: every file's path and contents (line endings ignored), so an added, deleted or changed
 * file changes it, whatever its modification time. */
export function buildInputs(root) {
  const files = []
  const walk = (p) => {
    if (!existsSync(p)) return
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p)) if (e !== 'node_modules') walk(join(p, e))
    } else files.push(p)
  }
  for (const p of BUILD_INPUTS) walk(join(root, p))
  const h = createHash('sha256')
  for (const f of files.map((p) => relative(root, p).split(sep).join('/')).sort()) {
    h.update(`${f}\0`)
    h.update(readFileSync(join(root, f)).toString('latin1').replace(/\r\n/g, '\n'))
    h.update('\0')
  }
  return h.digest('hex')
}

/** The hash out/ was stamped with by its build, or null (no build, or one made without --build). */
export function buildStamp(root) {
  try {
    return JSON.parse(readFileSync(join(root, STAMP), 'utf8')).inputs ?? null
  } catch {
    return null
  }
}

/** When out/ was stamped (an ISO time), or null. */
export function buildStampedAt(root) {
  try {
    return JSON.parse(readFileSync(join(root, STAMP), 'utf8')).at ?? null
  } catch {
    return null
  }
}

/**
 * Whether a worktree's build was made right by the runs started together in it (npm run e2e:concurrency, #282), whoever
 * built it: not two builds, and a build stamped from this source; when these runs built nothing, it was stamped since
 * the round began (the checker cleared the stamp first), by another runner in the same worktree (a second checker's).
 * A checker alone always finds the stamp gone, so its runs build it: zero builds then means someone else stamped it.
 * { ok, why }. builds: the runs' "Building" lines; stamp, inputs: buildStamp and buildInputs; at: buildStampedAt;
 * since: when the round cleared the stamp (ms).
 */
export function builtOnce({ builds, stamp, inputs, at, since }) {
  if (builds > 1) return { ok: false, why: `${builds} builds` }
  if (!stamp || stamp !== inputs) return { ok: false, why: `${builds} builds; ${stamp ? 'stamped from other source' : 'not stamped'}` }
  if (builds === 1) return { ok: true, why: 'built once by these runs' }
  const t = Date.parse(at ?? '')
  return Number.isFinite(t) && t >= since ? { ok: true, why: 'built once by another runner in this worktree, during this round' } : { ok: false, why: `0 builds, and the stamp (${at ?? 'no time'}) is older than this round` }
}

/** Where the build locks are, one folder per worktree. */
export const BUILD_LOCKS = join(process.env.LOCALAPPDATA || tmpdir(), 'hive-test', 'build-locks')
/** A lock held longer than this is from a runner stuck far beyond any build (its process may still be there). */
const LOCK_MAX_MS = 60 * 60_000
/** How long a runner waits for another's build before giving up. */
const WAIT_MS = 20 * 60_000
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * The build lock of the worktree at root: a folder in dir (creating one is atomic) named for the worktree, with its
 * holder's process id in owner.json. take() waits for it (throws after waitMs), release() lets go if it is still this
 * runner's, waitFree() waits while another runner holds it. A holder whose process is gone, or held for over an hour,
 * is broken; so is a folder with no owner after 30 s (a runner that crashed between making it and writing its owner).
 */
export function buildLock(root, { dir = BUILD_LOCKS, owner = process.pid, alive = processAlive, waitMs = WAIT_MS, pollMs = 250 } = {}) {
  const folder = join(dir, createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 16))
  const file = join(folder, 'owner.json')
  /** { pid, at } of the holder, null when free, or { stale: true } for a holder that is gone. */
  const holder = () => {
    let age
    try {
      age = Date.now() - statSync(folder).mtimeMs
    } catch {
      return null
    }
    let h
    try {
      h = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // Just made, its owner not written yet; or left so by a crash.
      return age > 30_000 ? { stale: true } : { pid: null, at: Date.now() }
    }
    return !Number.isInteger(h.pid) || !alive(h.pid) || Date.now() - Number(h.at) > LOCK_MAX_MS ? { stale: true } : h
  }
  const tryTake = () => {
    mkdirSync(dir, { recursive: true })
    try {
      mkdirSync(folder)
    } catch (e) {
      // Held; or, on Windows, just let go of and still open (as lib.withFileLock).
      if (['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) return false
      throw e
    }
    writeFileSync(file, JSON.stringify({ pid: owner, at: Date.now(), root: resolve(root) }))
    return true
  }
  const breakStale = () => {
    if (holder()?.stale) rmSync(folder, { recursive: true, force: true })
  }
  const heldByOther = () => {
    const h = holder()
    return !!h && !h.stale && h.pid !== owner
  }
  const tooLong = () => new Error(`Another runner has been building this worktree's dev build for over ${Math.round(waitMs / 60_000)} minutes (lock ${folder})`)
  return {
    folder,
    heldByOther,
    /** Takes the lock, waiting while another runner holds it: true if it had to wait. */
    take() {
      const start = Date.now()
      let waited = false
      while (!tryTake()) {
        breakStale()
        if (Date.now() - start > waitMs) throw tooLong()
        if (!heldByOther()) {
          // Broken, or let go of just now: try again after a moment (Windows may still have it open).
          pause(20)
          continue
        }
        waited = true
        pause(pollMs)
      }
      return waited
    },
    /** Lets go, if this runner still holds it. */
    release() {
      try {
        if (JSON.parse(readFileSync(file, 'utf8')).pid === owner) rmSync(folder, { recursive: true, force: true })
      } catch {
        // Not held, or gone already.
      }
    },
    /** Waits while another runner holds the lock (it is building): true if it had to wait. */
    waitFree() {
      const start = Date.now()
      let waited = false
      for (breakStale(); heldByOther(); breakStale()) {
        if (Date.now() - start > waitMs) throw tooLong()
        waited = true
        pause(pollMs)
      }
      return waited
    }
  }
}

/**
 * Why the worktree's dev build isn't from its source as it is now, or null when it is; with the inputs it was read
 * against. Also for a runner that must know before it builds (a model trial takes a CPU slot to build, HI-2070).
 */
export function buildWhy(root) {
  const hasBuild = existsSync(join(root, 'out', 'main', 'index.js'))
  const stamp = buildStamp(root)
  const inputs = buildInputs(root)
  const why = hasBuild && stamp === inputs ? null : !hasBuild ? 'there is no dev build' : !stamp ? "the dev build wasn't made with --build, so which code it holds is unknown" : 'the dev build was made from other source than this'
  return { why, inputs }
}

/**
 * Makes sure the build is the source's, or says why not. { stale, built, waited, why }:
 * - fresh (the stamp matches the source): nothing to do;
 * - otherwise, with build: under the worktree's build lock, looks again (another runner may have just built it); still
 *   stale, removes the old stamp, runs runBuild() and stamps out/ with the inputs it was made from, only if they didn't
 *   change while it built;
 * - without build: stale, with why (no build, a build of unknown code, or one of other code).
 * Both wait while another runner builds this worktree (waited). runBuild throws when the build fails: the lock is let
 * go. lock: buildLock's options (for tests).
 */
export function ensureBuild({ root, build, runBuild, lock: lockOpts = {} }) {
  const lock = buildLock(root, lockOpts)
  const look = () => buildWhy(root)
  if (!build) {
    const waited = lock.waitFree()
    const { why } = look()
    return { stale: !!why, built: false, waited, why }
  }
  if (!lock.heldByOther() && !look().why) return { stale: false, built: false, waited: false, why: null }
  const waited = lock.take()
  // Let go also when the runner exits in the middle.
  process.on('exit', lock.release)
  try {
    const { why, inputs: before } = look()
    if (!why) return { stale: false, built: false, waited, why: null }
    if (!buildAndStamp(root, before, runBuild)) return { stale: true, built: true, waited, why: 'the source changed while it was building' }
    return { stale: false, built: true, waited, why: null }
  } finally {
    process.off('exit', lock.release)
    lock.release()
  }
}

/**
 * ensureBuild for a run whose build needs a CPU slot it doesn't hold (HI-2070: a model trial with no CPU credit,
 * slots.mjs buildNeedsCpuSlot): it looks first, once no other runner of this worktree is building (ensureBuild without
 * build, which waits that out), so a build that became needed meanwhile is seen; only a stale one takes the slot
 * (takeSlot: async, its release()), held while it builds and let go after. The slot before the build lock, as every
 * runner takes them, so neither waits on the other. needsSlot false: ensureBuild as it is. ensure: for tests.
 */
export async function ensureBuildWithSlot({ root, runBuild, needsSlot, takeSlot, ensure = ensureBuild }) {
  if (!needsSlot) return ensure({ root, build: true, runBuild })
  const looked = ensure({ root, build: false })
  if (!looked.stale) return looked
  const slot = await takeSlot()
  try {
    return ensure({ root, build: true, runBuild })
  } finally {
    slot.release()
  }
}

/**
 * Runs runBuild and stamps out/ with `before` (the inputs it was made from), only if they are still the source's
 * afterwards: whether it stamped. The old stamp goes before the build touches out/: a build that fails, or whose source
 * changes while it runs, leaves output that no stamp vouches for (and a later run with the old source mustn't match
 * the old stamp). Under the worktree's build lock (the callers').
 */
function buildAndStamp(root, before, runBuild) {
  rmSync(join(root, STAMP), { force: true })
  runBuild()
  if (buildInputs(root) !== before) return false
  writeFileSync(join(root, STAMP), JSON.stringify({ inputs: before, at: new Date().toISOString() }) + '\n')
  return true
}

/**
 * Builds out/ whatever its stamp says, and stamps it as --build does (#274): for `npm run dist`, whose `npm run build`
 * makes the same dev build the packaged app is made from, so a run right after it (packaged checks with --record) finds
 * out/ from this source. Under the worktree's build lock, so a runner never looks at half a build. { stamped, waited }:
 * stamped false when the source changed while it built.
 */
export function buildStamped({ root, runBuild, lock: lockOpts = {} }) {
  const lock = buildLock(root, lockOpts)
  const waited = lock.take()
  process.on('exit', lock.release)
  try {
    return { stamped: buildAndStamp(root, buildInputs(root), runBuild), waited }
  } finally {
    process.off('exit', lock.release)
    lock.release()
  }
}

/**
 * Builds the dev build in root (both runners' runBuild): in the allowlisted environment (runContext.baseEnv), so
 * nothing of the shell the runner was started from (NODE_OPTIONS, npm_config_*, GIT_*) reaches the build. Throws, with
 * the exit code as status, when it fails. command: for tests.
 */
export function devBuild(root, { command = 'npx electron-vite build', parent = process.env } = {}) {
  const r = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true, env: runContext.baseEnv(parent) })
  if (r.status !== 0) throw Object.assign(new Error(`The build failed (exit ${r.status})`), { status: r.status ?? 1 })
}
