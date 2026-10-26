// Where an installer built in a git worktree goes (#150): the user looks for installers in the main checkout's dist, so
// `npm run dist` in an agent's worktree copies the installer, its blockmap, latest.yml and build-info.json there too
// (the worktree keeps its own). It never replaces an installer of the same name built from other code without saying
// so: build-info.json beside each says what it was built from, and is only written when that is certain (the code
// didn't change while it was built). Several worktrees can copy at once: a lock in the main dist makes each check and
// copy the whole set in turn. Kept apart from dist.mjs so tests/distcopy.test.ts can check it with a temporary
// repository and worktrees.
import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { fingerprint } from '../tests/e2e/record.mjs'
import { writeAppIdentity } from './appIdentity.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * The checkout at cwd: { root, worktree, main } where worktree is true in a linked git worktree (its git dir isn't the
 * common one) and main is the main checkout's folder (the first `git worktree list` entry), or null outside git.
 */
export function checkoutOf(cwd) {
  let root, gitDir, common
  try {
    ;[gitDir, common, root] = git(cwd, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel').split(/\r?\n/)
  } catch {
    return null
  }
  const main = /^worktree (.+)$/m.exec(git(cwd, 'worktree', 'list', '--porcelain'))?.[1] ?? root
  return { root, worktree: !same(gitDir, common), main }
}

/**
 * What a build is made from, read together: { version, code, head, branch }. code is the e2e fingerprint (HEAD plus a
 * hash of uncommitted changes; dist/ and out/ are ignored by git, so the build's own output doesn't count).
 */
export function buildIdentity(root) {
  return {
    version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    code: fingerprint(root),
    head: git(root, 'rev-parse', 'HEAD'),
    branch: git(root, 'branch', '--show-current') || null
  }
}

/** Why a build's provenance can't be trusted (its identity before and after building differ), or null. */
export function provenanceProblem(before, after) {
  const changed = ['version', 'code', 'head', 'branch'].filter((k) => before[k] !== after[k])
  return changed.length ? `the ${changed.join(', ')} changed while it was built (${changed.map((k) => `${before[k]} → ${after[k]}`).join('; ')})` : null
}

/** The files `npm run dist` makes for a version that belong with the installer; build-info.json last. */
export const installerFiles = (version) => [`Hive-Setup-${version}.exe`, `Hive-Setup-${version}.exe.blockmap`, 'latest.yml', 'build-info.json']

/** build-info.json in a dist folder, or null (none, or unreadable). */
export function readBuildInfo(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'build-info.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * What to do with a worktree's installer: { copy: [file names], refuse: why or null, note: or null }. It copies the
 * whole set or nothing: it refuses when a file of the set is missing in the worktree's dist, or when the build there
 * isn't the one described (build-info.json for another version or code). It refuses (unless replace) when the main
 * dist already has an installer of this name built from other code (another fingerprint) or from code it can't tell
 * (no build-info.json); one built from the same code is replaced. note: the main checkout is at another commit than
 * this build, which AGENTS.md says it should match.
 */
export function planCopy({ version, from, to, info, theirs = readBuildInfo(to), mainHead = null, replace = false }) {
  const files = installerFiles(version)
  const missing = files.filter((f) => !existsSync(join(from, f)))
  if (missing.length) return { copy: [], refuse: `${missing.join(', ')} missing in ${from}`, note: null }
  const ours = readBuildInfo(from)
  if (!ours || ours.version !== version || ours.code !== info.code) return { copy: [], refuse: `${join(from, 'build-info.json')} doesn't describe this build`, note: null }
  const exe = `Hive-Setup-${version}.exe`
  let refuse = null
  if (existsSync(join(to, exe)) && !replace) {
    if (!theirs || theirs.version !== version) refuse = `${join(to, exe)} is already there, built from code it can't tell (no build-info.json)`
    else if (theirs.code !== info.code) refuse = `${join(to, exe)} is already there, built from other code: ${theirs.code}${theirs.branch ? ` (${theirs.branch})` : ''} at ${theirs.builtAt}, where this one is ${info.code}${info.branch ? ` (${info.branch})` : ''}`
  }
  const note = mainHead && info.head && mainHead !== info.head ? `the main checkout is at ${mainHead.slice(0, 12)}, not at this build's commit ${info.head.slice(0, 12)}` : null
  return { copy: refuse ? [] : files, refuse, note }
}

/**
 * Runs fn holding the main dist's copy lock (`.installer-copy.lock`, a folder: creating one is atomic), so two
 * worktrees never check and copy at the same time. A lock older than staleMs was left by a crash; one held past
 * timeoutMs makes this run give up (throws).
 */
export function withCopyLock(dir, fn, { staleMs = 10 * 60_000, timeoutMs = 5 * 60_000 } = {}) {
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, '.installer-copy.lock')
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e
      if (Date.now() - start > timeoutMs) throw new Error(`another copy into ${dir} still holds ${lock}`, { cause: e })
      let age = 0
      try {
        age = Date.now() - statSync(lock).mtimeMs
      } catch {
        // Just released, or not readable yet: try again after the pause.
      }
      if (age > staleMs) rmSync(lock, { recursive: true, force: true })
      pause(50)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  }
}

/**
 * Copies the set into `to` so it is never trusted half-done: each file goes to a temporary name first; then the old
 * build-info.json is removed, the others are moved into place, and build-info.json comes last. If anything fails, the
 * temporary files go and no build-info.json is left describing a set it doesn't match (the next copy then can't tell
 * what is there, and refuses), and the error is thrown.
 */
export function copySet(from, to, files) {
  const tmp = (f) => join(to, `${f}.copying-${process.pid}`)
  // Until the first file is moved into place the old set is whole, and its build-info.json still true.
  let swapping = false
  try {
    for (const f of files) copyFileSync(join(from, f), tmp(f))
    swapping = true
    rmSync(join(to, 'build-info.json'), { force: true })
    for (const f of files.filter((n) => n !== 'build-info.json')) renameSync(tmp(f), join(to, f))
    renameSync(tmp('build-info.json'), join(to, 'build-info.json'))
  } catch (e) {
    for (const f of files) rmSync(tmp(f), { force: true })
    if (swapping) rmSync(join(to, 'build-info.json'), { force: true })
    throw e
  }
}

/**
 * Copies a worktree's installer to the main checkout's dist as planCopy says, under the copy lock (the main dist's
 * build-info.json is read again under it); returns the lines to print. Outside a worktree, or with here, it does
 * nothing.
 */
export function copyToMain({ root, version, info, here = false, replace = false }) {
  const c = checkoutOf(root)
  if (!c?.worktree) return []
  const from = join(root, 'dist')
  if (here) return [`Installer: ${join(from, `Hive-Setup-${version}.exe`)} (kept in this worktree: --here)`]
  const to = join(c.main, 'dist')
  let mainHead = null
  try {
    mainHead = git(c.main, 'rev-parse', 'HEAD')
  } catch {
    // Not readable: no note.
  }
  let plan
  try {
    plan = withCopyLock(to, () => {
      const p = planCopy({ version, from, to, info, mainHead, replace })
      if (!p.refuse) copySet(from, to, p.copy)
      return p
    })
  } catch (e) {
    return [`Not copied to the main checkout: ${e.message}.`, `Installer: ${join(from, `Hive-Setup-${version}.exe`)} (this worktree).`]
  }
  if (plan.refuse) return [`Not copied to the main checkout: ${plan.refuse}.`, `Installer: ${join(from, `Hive-Setup-${version}.exe`)} (this worktree). Run again with --replace to copy it over anyway.`]
  return [`Installer: ${join(to, `Hive-Setup-${version}.exe`)} (copied from this worktree, which keeps its own)`, ...(plan.note ? [`Note: ${plan.note}.`] : [])]
}

/**
 * The packaged app's own record of what it was built from (#274), inside dist/win-unpacked, which the installer's e2e
 * suites test. Not build-info.json: that describes the installer set beside it, which goes to the main checkout's dist
 * (copyToMain) without win-unpacked, so there it can describe another build than the win-unpacked it sits next to. This
 * one never moves: removed before packaging (dist.mjs), written by finishDist once the build's code is certain.
 */
export const UNPACKED_INFO = join('win-unpacked', '.hive-build-info.json')

/** What dist/win-unpacked was built from (UNPACKED_INFO), or null: none (an older build, or one whose code changed). */
export function readUnpackedInfo(dist) {
  try {
    return JSON.parse(readFileSync(join(dist, UNPACKED_INFO), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Before packaging (dist.mjs): neither the installer set's build-info.json nor win-unpacked's record may outlive the
 * build they describe, should this one fail part way.
 */
export function clearDistInfo(dist) {
  rmSync(join(dist, 'build-info.json'), { force: true })
  rmSync(join(dist, UNPACKED_INFO), { force: true })
}

/**
 * What npm run dist does, in order (scripts/dist.mjs gives it the real steps; tests give fakes, #281): notes what the
 * build is made from; removes an earlier build's records (build-info.json and win-unpacked's own: a build that fails part
 * way would leave an installer and a dist/win-unpacked they describe wrongly); builds out/ and stamps it (buildStamped,
 * under the worktree's build lock); packages the installer; then finishDist. run(cmd) runs a command and exits on
 * failure. Returns finishDist's lines.
 */
export function makeDist({ root, here = false, replace = false, run, buildStamped, identity = buildIdentity, clear = clearDistInfo, finish = finishDist, warn = console.warn, stampApp = writeAppIdentity }) {
  // What the build is made from, before and after: an edit or a commit while it runs leaves its code unknown.
  const before = identity(root)
  clear(join(root, 'dist'))
  const { stamped } = buildStamped({ root, runBuild: () => run('npm run build') })
  if (!stamped) warn("\nThe source changed while it was building: out/ isn't stamped as this source's (npm run e2e -- --build rebuilds it).\n")
  // A local build says so (#1647): the app's identity file and its installer's wait for another Hive installer.
  stampApp(root, { version: before.version, commit: before.head, local: true })
  run('npx electron-builder --win --publish never')
  return finish({ root, before, after: identity(root), here, replace })
}

/**
 * After the build: writes dist/build-info.json and win-unpacked's record (UNPACKED_INFO), and copies to the main
 * checkout (copyToMain), only if what the build is made from didn't change while it ran (before and after:
 * buildIdentity). Otherwise neither record (old ones are removed: they would describe other code) and nothing is
 * copied: the installer's code can't be told, so it must be built again on code that stays put. Returns the lines to
 * print.
 */
export function finishDist({ root, before, after, builtAt = new Date().toISOString(), here = false, replace = false }) {
  const dist = join(root, 'dist')
  const exe = join(dist, `Hive-Setup-${after.version}.exe`)
  const problem = provenanceProblem(before, after)
  if (problem) {
    clearDistInfo(dist)
    return [`The build's code can't be told: ${problem}. No build-info.json was written and nothing was copied to the main checkout: build again once the code stays put.`, `Installer: ${exe} (this worktree, unlabelled)`]
  }
  const info = { ...before, builtAt, builtIn: root }
  if (existsSync(join(dist, 'win-unpacked'))) writeFileSync(join(dist, UNPACKED_INFO), JSON.stringify(info, null, 2))
  writeFileSync(join(dist, 'build-info.json'), JSON.stringify(info, null, 2))
  const lines = copyToMain({ root, version: before.version, info, here, replace })
  return lines.length ? lines : [`Installer: ${exe}`]
}
