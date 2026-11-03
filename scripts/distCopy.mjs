// Where an installer built in a git worktree goes (#150): the user looks for installers in the main checkout's dist, so
// `npm run dist` in an agent's worktree copies the installer, its blockmap, latest.yml and build-info.json there too
// (the worktree keeps its own). It never replaces an installer of the same name built from other code without saying
// so: build-info.json beside each says what it was built from, and is only written when that is certain (the code
// didn't change while it was built). Several worktrees can copy at once: a lock in the main dist makes each check and
// copy the whole set in turn. npm run release builds in its own checkout's dist by the same rules (makeRelease, HI-2411).
// Kept apart from dist.mjs and release.mjs so tests/distcopy.test.ts can check it with a temporary repository and
// worktrees, and with the build and upload faked.
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
 * Why the installer of this version in dir mustn't be replaced by a build of info's code, or null. Unless replace, it
 * mustn't when one is there built from other code (another fingerprint in its build-info.json) or from code it can't
 * tell (no build-info.json for this version); one built from the same code may be. Both `npm run dist`'s copy to the
 * main checkout (planCopy) and `npm run release`'s build in its own dist (makeRelease) ask it first (HI-2411).
 */
export function replaceProblem({ dir, version, info, theirs = readBuildInfo(dir), replace = false }) {
  const exe = join(dir, `Hive-Setup-${version}.exe`)
  if (replace || !existsSync(exe)) return null
  if (!theirs || theirs.version !== version) return `${exe} is already there, built from code it can't tell (no build-info.json)`
  if (theirs.code !== info.code) return `${exe} is already there, built from other code: ${theirs.code}${theirs.branch ? ` (${theirs.branch})` : ''} at ${theirs.builtAt}, where this one is ${info.code}${info.branch ? ` (${info.branch})` : ''}`
  return null
}

/**
 * What to do with a worktree's installer: { copy: [file names], refuse: why or null, note: or null }. It copies the
 * whole set or nothing: it refuses when a file of the set is missing in the worktree's dist, or when the build there
 * isn't the one described (build-info.json for another version or code). It refuses (unless replace) when the main
 * dist already has an installer of this name built from other code or from code it can't tell (replaceProblem); one
 * built from the same code is replaced. note: the main checkout is at another commit than this build, which AGENTS.md
 * says it should match.
 */
export function planCopy({ version, from, to, info, theirs = readBuildInfo(to), mainHead = null, replace = false }) {
  const files = installerFiles(version)
  const missing = files.filter((f) => !existsSync(join(from, f)))
  if (missing.length) return { copy: [], refuse: `${missing.join(', ')} missing in ${from}`, note: null }
  const ours = readBuildInfo(from)
  if (!ours || ours.version !== version || ours.code !== info.code) return { copy: [], refuse: `${join(from, 'build-info.json')} doesn't describe this build`, note: null }
  const refuse = replaceProblem({ dir: to, version, info, theirs, replace })
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
      // A release building in the main dist owns it until it ends (makeRelease, HI-2411): even --replace waits for it.
      const release = releaseClaim(to)
      if (release) return { busy: `npm run release is building there (pid ${release.pid}, since ${release.at})` }
      const p = planCopy({ version, from, to, info, mainHead, replace })
      if (!p.refuse) copySet(from, to, p.copy)
      return p
    })
  } catch (e) {
    return [`Not copied to the main checkout: ${e.message}.`, `Installer: ${join(from, `Hive-Setup-${version}.exe`)} (this worktree).`]
  }
  if (plan.busy) return [`Not copied to the main checkout: ${plan.busy}.`, `Installer: ${join(from, `Hive-Setup-${version}.exe`)} (this worktree). Run npm run dist again once the release has ended to copy it.`]
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
 * checkout (copyToMain; not with copy false, as for `npm run release`), only if what the build is made from didn't
 * change while it ran (before and after: buildIdentity). Otherwise neither record (old ones are removed: they would
 * describe other code) and nothing is copied: the installer's code can't be told, so it must be built again on code
 * that stays put. Returns the lines to print.
 */
export function finishDist({ root, before, after, builtAt = new Date().toISOString(), here = false, replace = false, copy = true }) {
  const dist = join(root, 'dist')
  const exe = join(dist, `Hive-Setup-${after.version}.exe`)
  const problem = provenanceProblem(before, after)
  if (problem) {
    clearDistInfo(dist)
    if (!copy) return [`The build's code can't be told: ${problem}. No build-info.json was written: build again once the code stays put.`, `Installer: ${exe} (unlabelled)`]
    return [`The build's code can't be told: ${problem}. No build-info.json was written and nothing was copied to the main checkout: build again once the code stays put.`, `Installer: ${exe} (this worktree, unlabelled)`]
  }
  const info = { ...before, builtAt, builtIn: root }
  if (existsSync(join(dist, 'win-unpacked'))) writeFileSync(join(dist, UNPACKED_INFO), JSON.stringify(info, null, 2))
  writeFileSync(join(dist, 'build-info.json'), JSON.stringify(info, null, 2))
  const lines = copy ? copyToMain({ root, version: before.version, info, here, replace }) : []
  return lines.length ? lines : [`Installer: ${exe}`]
}

/**
 * A release's claim on the dist it builds in (makeRelease, HI-2411): `.release-build.json`, naming its process. The
 * build takes minutes, longer than the copy lock may be held (withCopyLock's staleMs), so the release takes the claim
 * under that lock with its check, and holds it, not the lock, until it ends; a worktree's copy there (copyToMain) and
 * another release refuse while it stands.
 */
export const RELEASE_CLAIM = '.release-build.json'

/** Whether process pid is running (EPERM: it is, as another user's). */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/**
 * The release claim standing on dir ({ pid, at, code }), or null: none, unreadable, or left by a release that ended
 * without removing it (its process is gone: release.mjs exits on a failed step; or older than maxAgeMs, should its pid
 * have been reused).
 */
export function releaseClaim(dir, { alive = pidAlive, now = Date.now(), maxAgeMs = 6 * 3_600_000 } = {}) {
  let claim
  try {
    claim = JSON.parse(readFileSync(join(dir, RELEASE_CLAIM), 'utf8'))
  } catch {
    return null
  }
  if (!Number.isInteger(claim?.pid) || !alive(claim.pid)) return null
  const at = Date.parse(claim.at)
  return Number.isNaN(at) || now - at > maxAgeMs ? null : claim
}

/**
 * What npm run release does once its own checks pass (scripts/release.mjs gives it the real steps; tests give fakes,
 * HI-2411), by dist's rules. It builds in its checkout's own dist, so under the dist's copy lock (which worktrees copying
 * there take too) it first refuses (unless replace) to build over an installer of the same name there built from other
 * code or from code it can't tell (replaceProblem), or while another release holds the dist; otherwise it takes the
 * release claim (RELEASE_CLAIM) in the same hold, so no copy lands between that check and its build. Then it removes an
 * earlier build's records (clearDistInfo); builds out/ (run), stamps the app as a release (local: false, #1647), and
 * publishes (publish: the draft and electron-builder's upload); then finishDist without a copy, so
 * dist/build-info.json describes the installer it uploaded; and gives up its claim (a failed step that exits leaves it
 * to its dead pid). Returns { refused: why } (nothing built) or { lines } to print.
 */
export function makeRelease({ root, replace = false, run, publish, identity = buildIdentity, clear = clearDistInfo, finish = finishDist, stampApp = writeAppIdentity }) {
  const dist = join(root, 'dist')
  const claimFile = join(dist, RELEASE_CLAIM)
  const before = identity(root)
  const refused = withCopyLock(dist, () => {
    const other = releaseClaim(dist)
    if (other) return `Not built: another npm run release is building in ${dist} (pid ${other.pid}, since ${other.at}). Run again once it has ended.`
    const problem = replaceProblem({ dir: dist, version: before.version, info: before, replace })
    if (problem) return `Not built: ${problem}. Move it aside to keep it, or run again with --replace to build over it.`
    writeFileSync(claimFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), code: before.code }, null, 2))
    return null
  })
  if (refused) return { refused }
  try {
    clear(dist)
    run('npm run build')
    stampApp(root, { version: before.version, commit: before.head, local: false })
    publish()
    return { lines: finish({ root, before, after: identity(root), copy: false }) }
  } finally {
    withCopyLock(dist, () => rmSync(claimFile, { force: true }))
  }
}
