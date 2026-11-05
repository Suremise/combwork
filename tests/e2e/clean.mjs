// Housekeeping for %LOCALAPPDATA%\hive-test (#253): what the tests leave behind there is removed once it is no longer
// needed, so the folder stays small without anyone tidying it by hand.
//
//   npm run test:clean                  removes what is stale and prints each area's size
//   npm run test:clean -- --dry-run     lists what it would remove (and what it keeps, and why), removes nothing
//   npm run test:clean -- --days N      the age after which leftovers go (default 3; 0: everything not kept below)
//
// The e2e runner and the scenario runner run the same clean-up when they finish (bounded: autoClean), so nothing piles
// up; `test:clean` is for on-demand use and for the sizes.
//
// What goes:
// - In an idle e2e lane (no runner holds its claim: lanes.mjs; the clean-up claims it while it works, so no runner starts
//   in it meanwhile): every suite folder no run claims (a failed suite's is claimed by its run's logs until they are
//   pruned: logs.mjs, #285), and anything left from before suites had folders of their own, whatever their age. In an idle
//   scenario lane: numbered copies (`<scenario>-2`…) whatever their age, the rest (what --keep left) by age.
// - In the e2e work folder: anything but `lanes` and `logs` older than the age (suites run on their own, probes).
// - Anything else in hive-test older than the age (one-off folders and files: reviewers' and builders' probes).
//   `scratch\<agent>-<date>` is the place for probes that must be under hive-test: its folders go by the same age.
// - In `tmp` (the test runs' temp folders: tests/runTemp.mts, #992, HI-2102): anything older than a day (TMP_DAYS; --days less
//   than that goes by --days). Each test removes its own; this is for what a stopped run left.
// - In the Codex test home (#404, codexPlan), under its lease (codexHomeLock.mjs; nothing while a run holds it): rollouts
//   older than the age, package copies Codex no longer runs, and unfinished downloads in its cache older than the age.
// What stays, always:
// - The CLI test homes' sign-ins, config, sandbox setup and databases (`codex`: all but the above; `claude`: never
//   opened); scenario results and baselines; the claims
//   and locks (`e2e-lanes`, `heavy-slots`, `build-locks`), the concurrency checker's folders (it removes its own:
//   tempWorktrees.mjs) and the Progress panel's timings. Logs (`e2e\logs`) are pruned by the runner (logs.mjs).
// - A lane a runner holds.
// - Anything a card that isn't Done (nor archived) cites (evidence.cjs: its path, a path inside it, or a folder it is
//   in), listed as "kept: cited by #n"; once the card is Done, the age rule applies. While the board can't be read (none
//   found up from this repository's main checkout, or a card that can't be read), nothing at all is removed: what is
//   cited can't be known. The same rules hold wherever tests delete their output (evidence.cjs).
// Links (a worktree's node_modules is a junction) are removed as links, never followed.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { acquireCodexHome } from './codexHomeLock.mjs'
import { LANES, claimHeld, withLock } from './lanes.mjs'
import { processAlive } from './logs.mjs'
import { SUITES } from './suites.mjs'

const require = createRequire(import.meta.url)
const runContext = require('./runContext.cjs')
const { claimedByRuns, evidenceFor, linkOnPath, safeList, sizeOf, removeTree } = require('./evidence.cjs')

/** Leftovers older than this many days go (--days). */
export const PRUNE_DAYS = 3
/** The test runs' temp folders (`tmp`, tests/runTemp.mts) go after a day: no run lasts that long (#992). */
export const TMP_DAYS = 1
const DAY = 24 * 60 * 60_000

/** What stays in hive-test whatever its age, and why (the names of its own folders and files). */
export const KEPT = {
  codex: 'the Codex test home (its sign-in; old rollouts, package copies and unfinished downloads go: codexPlan)',
  claude: 'the Claude Code test home (its sign-in)',
  scenarios: 'scenario results and baselines (Performance → Compare)',
  'e2e-lanes': "the lanes' claims",
  'heavy-slots': 'the heavy-run slots',
  'build-locks': "the worktrees' build locks",
  concurrency: "the concurrency checker's folders (it removes its own)",
  'progress-timings.json': "the Progress panel's suite timings",
  'config.json': "the machine's test settings (heavySlots, sideSlots, modelTrials, smallRun: slots.mjs CONFIG_FILE, #589, HI-2070)"
}

/**
 * Holds lane k's claim (lanes.mjs) for the clean-up: its release, or null when another runner holds it. A lane this
 * process holds already (owner) is its to work in: a release that leaves the claim alone.
 */
export async function holdLane(dir, k, { owner = process.pid, alive = processAlive, now = () => Date.now() } = {}) {
  mkdirSync(dir, { recursive: true })
  return withLock(dir, async () => {
    const file = join(dir, `lane-${k}.json`)
    let claim = null
    try {
      claim = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // No claim.
    }
    if (claimHeld(claim, alive, now())) {
      // This process's own lane (a runner pruning its runs before it lets the lane go): it may work in it, and the
      // claim stays its.
      return claim.pid === owner ? () => {} : null
    }
    writeFileSync(file, JSON.stringify({ pid: owner, at: now(), root: 'test:clean' }))
    return () => {
      try {
        if (JSON.parse(readFileSync(file, 'utf8')).pid === owner) rmSync(file, { force: true })
      } catch {
        // Gone already.
      }
    }
  })
}

/** When something was last changed: it, or anything directly in it (a profile's mtime alone misses new files deeper). */
export function lastChanged(p) {
  const st = lstatSync(p)
  let t = st.mtimeMs
  if (st.isDirectory())
    for (const name of safeList(p))
      try {
        t = Math.max(t, lstatSync(join(p, name)).mtimeMs)
      } catch {
        // Gone meanwhile.
      }
  return t
}

/**
 * What the clean-up would do in root (hive-test): [{ path, rel, remove, why }] for each thing it looked at (not the
 * kept areas), in order. held(k): whether lane k's claim is held (the clean-up claims an idle lane before removing
 * anything in it: clean()). ev: the evidence rules (evidence.cjs), which keep what cards cite and, while the board
 * can't be read, everything.
 */
export function plan({ root, days = PRUNE_DAYS, now = Date.now(), held = () => false, ev, suites = SUITES.map((s) => s.name), claimed = claimedByRuns([join(root, 'e2e', 'logs')]) }) {
  const out = []
  const suiteNames = new Set(suites)
  /** A suite's folder: its name, or `<name>-2`… when an earlier one was kept (evidence.cjs freshFolder). */
  const suiteFolder = (name) => suiteNames.has(name.replace(/-\d+$/, '')) || suiteNames.has(name)
  const look = (path, { legacy = false, leftover = null, area, maxDays = days }) => {
    const maxAge = maxDays * DAY
    const rel = relative(root, path).split(sep).join('/')
    let age
    try {
      // A file just written can be stamped a moment after now.
      age = Math.max(0, now - lastChanged(path))
    } catch {
      return
    }
    const kept = ev.protects(path)
    const item = { path, rel, area, age }
    if (kept) out.push({ ...item, remove: false, why: kept })
    else if (legacy) out.push({ ...item, remove: true, why: 'left in the lane from before suites had folders of their own' })
    else if (leftover) out.push({ ...item, remove: true, why: leftover })
    else if (area === 'lane' && leftover === false) out.push({ ...item, remove: false, why: 'its failed run keeps it (it goes with the run’s logs)' })
    else if (age >= maxAge) out.push({ ...item, remove: true, why: `${(age / DAY).toFixed(1)} days old` })
    else out.push({ ...item, remove: false, why: `newer than ${maxDays} day${maxDays === 1 ? '' : 's'}` })
  }
  // An e2e lane holds the folders of suites running now (only in a lane a runner holds) and of failed suites, which
  // their run's logs claim (evidence.cjs recordKept) until those are pruned (logs.mjs). Anything else in an idle lane is left
  // over, whatever its age (#285). A scenario lane holds what --keep left, by age, but not numbered copies (`-2`…),
  // which only pile up.
  const lane = (dir, k, kind) => {
    if (!existsSync(dir)) return
    if (held(k)) {
      out.push({ path: dir, rel: relative(root, dir).split(sep).join('/'), area: 'lane', remove: false, why: 'a runner holds the lane', lane: k })
      return
    }
    for (const name of safeList(dir)) {
      const p = join(dir, name)
      if (kind === 'e2e') look(p, { area: 'lane', legacy: !suiteFolder(name), leftover: claimed.has(resolve(p).toLowerCase()) ? false : 'no run keeps it' })
      else look(p, { area: 'lane', leftover: /-\d+$/.test(name) ? 'a copy an earlier run left' : null })
    }
  }
  const e2e = join(root, 'e2e')
  for (let k = 0; k < LANES; k++) {
    lane(join(e2e, 'lanes', String(k)), k, 'e2e')
    lane(join(root, 'scenarios', 'lanes', String(k)), k, 'scenarios')
  }
  for (const name of safeList(e2e)) if (name !== 'lanes' && name !== 'logs') look(join(e2e, name), { area: 'e2e' })
  for (const name of safeList(join(root, 'scratch'))) look(join(root, 'scratch', name), { area: 'scratch' })
  for (const name of safeList(join(root, 'tmp'))) look(join(root, 'tmp', name), { area: 'tmp', maxDays: Math.min(days, TMP_DAYS) })
  for (const name of safeList(root)) if (!(name in KEPT) && !['e2e', 'scratch', 'tmp'].includes(name)) look(join(root, name), { area: 'other' })
  out.push(...codexPlan({ root, days, now, ev }))
  return out
}

/**
 * What goes from the Codex test home (#404), which otherwise only grows (1.8 GB on 8 Oct 2026). Only these, each listed
 * as an item of area 'codex':
 * - rollouts (`sessions\YYYY\MM\DD\rollout-*.jsonl`) older than the age: a year, month or day folder whose rollouts are
 *   all that old goes whole, else its old rollouts one by one. Codex's index and databases still name them; it lists and
 *   resumes the rest as before;
 * - package copies Codex no longer runs: a `packages\<name>\releases\<version>` that is neither the release its
 *   `current` link points to nor the one its `auto-update-version` names. Only when what is there says which those are:
 *   a link or marker that is blank, malformed or names no release there keeps all of that package's releases;
 * - downloads Codex left unfinished in `cache\<name>\.tmp*`, older than the age.
 * Never its sign-in (`auth.json`), config, sandbox setup (`.sandbox`, `.sandbox-bin`, `cap_sid`), databases (Codex
 * prunes its own logs), plugins, skills or history: nothing else in it is looked at. Never a user's own ~/.codex, and
 * nothing reached through a link (junction or symlink) anywhere on its path, the home's own included: a folder that is
 * a link isn't looked in, and an item that is one, or has one on its way, isn't listed. Each item's check() says, just
 * before it goes, why it must stay after all (it changed, or a link appeared), or null: clean() plans the home again
 * under its lease, and checks each item at once before removing it.
 */
export function codexPlan({ root, home = join(root, 'codex'), days = PRUNE_DAYS, now = Date.now(), ev }) {
  const out = []
  if (runContext.isUserCliHome(home) || !existsSync(home) || linkOnPath(home)) return out
  const maxAge = days * DAY
  const rel = (p) => relative(root, p).split(sep).join('/')
  const stat = (p) => {
    try {
      return lstatSync(p)
    } catch {
      return null
    }
  }
  const age = (p) => Math.max(0, now - (stat(p)?.mtimeMs ?? now))
  /** A real folder (not a link to one). */
  const isDir = (p) => !!stat(p)?.isDirectory()
  /** A real folder's entries; nothing for anything else, so no link is ever looked through. */
  const list = (p) => (isDir(p) ? safeList(p) : [])
  const add = (path, why, still) => {
    const kept = ev.protects(path)
    const check = () => (linkOnPath(path) ? 'a link is on its way' : still())
    out.push({ path, rel: rel(path), area: 'codex', age: age(path), remove: !kept, why: kept ?? why, check })
  }
  // Rollouts: whether everything under a folder is a rollout older than the age (an empty folder is, once old itself).
  // With memo, each path is looked at once in the plan (HI-2365: sessions() asked again at every depth); an item's
  // check() looks afresh, just before it goes.
  const staleBy = (memo) => {
    const stale = (p) => {
      if (memo?.has(p)) return memo.get(p)
      const st = stat(p)
      let r
      if (st?.isDirectory()) {
        const names = safeList(p)
        r = names.every((n) => stale(join(p, n))) && (names.length > 0 || Math.max(0, now - st.mtimeMs) >= maxAge)
      } else r = !!st?.isFile() && /^rollout-.*\.jsonl$/.test(basename(p)) && Math.max(0, now - st.mtimeMs) >= maxAge
      memo?.set(p, r)
      return r
    }
    return stale
  }
  const stale = staleBy(new Map())
  const staleNow = staleBy(null)
  const staleStill = (p) => () => (staleNow(p) ? null : 'it changed since the plan')
  const sessions = (dir, depth) => {
    for (const name of list(dir)) {
      const p = join(dir, name)
      if (!isDir(p)) {
        if (stale(p)) add(p, `a rollout ${(age(p) / DAY).toFixed(1)} days old`, staleStill(p))
      } else if (stale(p)) add(p, `rollouts all older than ${days} days`, staleStill(p))
      else if (depth < 3) sessions(p, depth + 1)
    }
  }
  sessions(join(home, 'sessions'), 0)
  for (const pkg of list(join(home, 'packages'))) {
    const dir = join(home, 'packages', pkg)
    const used = releasesInUse(dir)
    if (!used) continue
    for (const v of list(join(dir, 'releases')))
      if (!used.has(v.toLowerCase())) {
        const p = join(dir, 'releases', v)
        if (isDir(p)) add(p, `a copy of Codex's ${pkg} it no longer runs (it runs ${[...used].join(', ')})`, () => (releasesInUse(dir)?.has(v.toLowerCase()) === false ? null : 'Codex runs it now, or which it runs is no longer clear'))
      }
  }
  for (const c of list(join(home, 'cache')))
    for (const name of list(join(home, 'cache', c))) {
      const p = join(home, 'cache', c, name)
      const unfinished = () => name.startsWith('.tmp') && !!stat(p)?.isFile() && age(p) >= maxAge
      if (unfinished()) add(p, `an unfinished download ${(age(p) / DAY).toFixed(1)} days old`, () => (unfinished() ? null : 'it changed since the plan'))
    }
  return out
}

/** A release's name as Codex writes it (`0.160.1-x86_64-pc-windows-msvc`): no path, nothing blank. */
const RELEASE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/

/**
 * The releases a Codex package uses (lower-cased names), from its `current` link and its `auto-update-version`, each
 * naming a real folder in its `releases` (the link pointing right into it); or null when that can't be told: neither
 * there, either one there but blank, malformed or naming no release there, or `releases` not a real folder.
 */
function releasesInUse(dir) {
  const releases = join(dir, 'releases')
  const realDir = (p) => {
    try {
      return lstatSync(p).isDirectory()
    } catch {
      return false
    }
  }
  if (!realDir(releases)) return null
  const used = new Set()
  const current = join(dir, 'current')
  if (lstatSafe(current)) {
    try {
      const target = realpathSync.native(current)
      const name = basename(target)
      if (realpathSync.native(dirname(target)).toLowerCase() !== realpathSync.native(releases).toLowerCase() || !RELEASE.test(name) || !realDir(join(releases, name))) return null
      used.add(name.toLowerCase())
    } catch {
      return null
    }
  }
  const marker = join(dir, 'auto-update-version')
  if (lstatSafe(marker)) {
    let v
    try {
      v = readFileSync(marker, 'utf8').trim()
    } catch {
      return null
    }
    if (!RELEASE.test(v) || !realDir(join(releases, v))) return null
    used.add(v.toLowerCase())
  }
  return used.size ? used : null
}

function lstatSafe(p) {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** Which lanes of the plan each item is in (e2e or scenarios lane k), so the clean-up claims them first. */
function laneOf(root, p) {
  const m = /^(?:e2e|scenarios)\/lanes\/(\d+)(?:\/|$)/.exec(relative(root, p).split(sep).join('/'))
  return m ? Number(m[1]) : null
}

/**
 * Removes what plan() says goes, each idle lane under its claim. budgetMs bounds the time (a runner's clean-up at its
 * end): what is left goes next time; the Codex test home last, under its lease (acquire: codexHomeLock.mjs's). Returns
 * { items, removed: [{ rel, size }], failed: [{ rel, error }], freed, stopped }.
 */
// The lanes it prunes, root's e2e/lanes/<k> and scenarios/lanes/<k>, are the machine pool's, so the claims that protect
// them are the machine pool's too (#1133): a runner with a pool of its own (CW_TEST_LANES_DIR: the concurrency check's
// waiting runs) read its own pool's claims, found lanes 0 and 1 free there as it ended, and removed the machine lanes'
// folders under other worktrees' running suites (their fake CLIs' homes, which no process held open; the fakes died).
export async function clean({ root = runContext.TEST_ROOT, lanesDir = runContext.MACHINE_LANES_DIR, days = PRUNE_DAYS, dryRun = false, budgetMs = Infinity, ev, now = Date.now(), alive = processAlive, owner = process.pid, acquire = acquireCodexHome } = {}) {
  const start = Date.now()
  const heldNow = new Set()
  for (let k = 0; k < LANES; k++) {
    let claim = null
    try {
      claim = JSON.parse(readFileSync(join(lanesDir, `lane-${k}.json`), 'utf8'))
    } catch {
      // None.
    }
    if (claimHeld(claim, alive, now)) heldNow.add(k)
  }
  // One look at the board to list what goes; each removal looks again (ev.protects reads it afresh).
  const look = ev.snapshot()
  const items = plan({ root, days, now, held: (k) => heldNow.has(k), ev: look })
  const result = { items, removed: [], failed: [], freed: 0, stopped: false, blocked: look.ok ? null : look.why }
  if (dryRun || !look.ok) return result
  const releases = new Map()
  /** Removes one item (its lane, if any, claimed by the caller): unless it is cited since the plan. */
  const remove = (item) => {
    // Cited since the plan (the cards are read again after a while)?
    const kept = ev.protects(item.path)
    if (kept) {
      result.failed.push({ rel: item.rel, error: kept })
      return
    }
    try {
      const size = removeTree(item.path)
      result.removed.push({ rel: item.rel, size })
      result.freed += size
    } catch (e) {
      result.failed.push({ rel: item.rel, error: e.code ?? e.message })
    }
  }
  const late = () => {
    if (Date.now() - start <= budgetMs) return false
    result.stopped = true
    return true
  }
  let lease = null
  try {
    for (const item of items.filter((i) => i.remove && i.area !== 'codex')) {
      if (late()) break
      const k = laneOf(root, item.path)
      if (k !== null && !releases.has(k)) {
        const release = await holdLane(lanesDir, k, { owner, alive })
        releases.set(k, release)
      }
      if (k !== null && !releases.get(k)) {
        result.failed.push({ rel: item.rel, error: 'a runner took the lane meanwhile' })
        continue
      }
      remove(item)
    }
    // The Codex test home, under its lease (codexHomeLock.mjs, taken without waiting: while a run holds it, nothing
    // there goes). What goes is planned again now the lease is held, and each item checked at once before it goes, so
    // nothing Codex took up or refreshed since the first look is removed.
    if (!result.stopped && items.some((i) => i.remove && i.area === 'codex')) {
      const got = await acquire(join(root, 'codex'), { poolRoot: join(root, 'codex-home-locks'), wait: false, owner, alive, root: 'test:clean', what: 'housekeeping' })
      if (!got.release) {
        for (const item of items.filter((i) => i.remove && i.area === 'codex')) result.failed.push({ rel: item.rel, error: 'a run is using the Codex test home' })
      } else {
        lease = got
        const fresh = codexPlan({ root, days, now: Math.max(now, Date.now()), ev: ev.snapshot() })
        result.items = [...items.filter((i) => i.area !== 'codex'), ...fresh]
        for (const item of fresh.filter((i) => i.remove)) {
          if (late()) break
          const changed = item.check()
          if (changed) result.failed.push({ rel: item.rel, error: changed })
          else remove(item)
        }
      }
    }
  } finally {
    for (const release of releases.values()) release?.()
    lease?.release()
  }
  return result
}

export const mb = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`)

/**
 * The runners' clean-up when they finish (run.mjs, tests/scenarios/run.mjs): the same rules, at most budgetMs, one line
 * said (nothing when there was nothing to do). Never fails the run.
 */
export async function autoClean({ root, ev = evidenceFor(root), log = console.log, budgetMs = 60_000 } = {}) {
  try {
    const r = await clean({ budgetMs, ev })
    if (r.blocked) log(`\nHousekeeping (hive-test): nothing removed: ${r.blocked}.`)
    else if (r.removed.length || r.failed.length || r.stopped)
      log(`\nHousekeeping (hive-test): removed ${r.removed.length} stale item${r.removed.length === 1 ? '' : 's'} (${mb(r.freed)})${r.failed.length ? `, ${r.failed.length} kept (in use, or cited meanwhile)` : ''}${r.stopped ? '; the rest next time' : ''}. npm run test:clean -- --dry-run lists what is there.`)
  } catch (e) {
    log(`\nHousekeeping (hive-test) didn't run: ${e.message}`)
  }
}

/** Each area's size, for the report. */
export function areaSizes(root = runContext.TEST_ROOT) {
  const rows = []
  const add = (label, p) => existsSync(p) && rows.push([label, sizeOf(p)])
  const e2e = join(root, 'e2e')
  for (let k = 0; k < LANES; k++) add(`e2e\\lanes\\${k}`, join(e2e, 'lanes', String(k)))
  add('e2e\\logs', join(e2e, 'logs'))
  rows.push(['e2e (suites run on their own, probes)', safeList(e2e).filter((n) => n !== 'lanes' && n !== 'logs').reduce((t, n) => t + sizeOf(join(e2e, n)), 0)])
  for (const name of Object.keys(KEPT)) add(name, join(root, name))
  add('scratch', join(root, 'scratch'))
  add('tmp (test runs)', join(root, 'tmp'))
  rows.push(['other (one-off)', safeList(root).filter((n) => !(n in KEPT) && !['e2e', 'scratch', 'tmp'].includes(n)).reduce((t, n) => t + sizeOf(join(root, n)), 0)])
  return rows
}

// --- npm run test:clean
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const at = args.indexOf('--days')
  const days = at >= 0 ? Number(args[at + 1]) : PRUNE_DAYS
  const unknown = args.filter((a, i) => a !== '--dry-run' && a !== '--days' && !(i === at + 1 && at >= 0))
  if (!Number.isFinite(days) || days < 0 || unknown.length) {
    console.error(`Usage: npm run test:clean [-- --dry-run] [--days N]${unknown.length ? ` (unknown: ${unknown.join(' ')})` : ''}`)
    process.exit(2)
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const ev = evidenceFor(root)
  console.log(`hive-test: ${runContext.TEST_ROOT}`)
  if (!ev.ok) console.log(`Nothing is removed: ${ev.why}.`)
  const r = await clean({ days, dryRun, ev })
  for (const i of r.items.filter((x) => !x.remove && !x.why.startsWith('newer than '))) console.log(`  kept: ${i.rel} (${i.why})`)
  if (dryRun) {
    const goes = r.items.filter((i) => i.remove)
    for (const i of goes) console.log(`  would remove: ${i.rel} (${i.why})`)
    console.log(`\n${goes.length} item${goes.length === 1 ? '' : 's'} would go (measuring)…`)
    console.log(`They hold ${mb(goes.reduce((t, i) => t + sizeOf(i.path), 0))}.`)
  } else {
    for (const i of r.removed) console.log(`  removed: ${i.rel} (${mb(i.size)})`)
    for (const f of r.failed) console.log(`  couldn't remove: ${f.rel} (${f.error})`)
    console.log(`\nRemoved ${r.removed.length} item${r.removed.length === 1 ? '' : 's'}, freed ${mb(r.freed)}.`)
  }
  console.log('\nSizes (measuring)…')
  const rows = areaSizes()
  for (const [label, size] of rows) console.log(`  ${label.padEnd(40)}${mb(size).padStart(9)}`)
  console.log(`  ${'total'.padEnd(40)}${mb(rows.reduce((t, [, s]) => t + s, 0)).padStart(9)}`)
}
