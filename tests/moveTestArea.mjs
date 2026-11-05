// npm run test:move-area [-- --dry-run] [--from <folder> --to <folder>] (HI-2590): moves the test area from
// %LOCALAPPDATA%\hive-test, its name before 1.1, to %LOCALAPPDATA%\combwork-test (tests/testArea.cjs), once and one way.
// Run by the developer or a release, at a time no test runs; never by a test run (they refuse until it is done).
//
// - It refuses while a runner holds a slot, a lane, a build lock or a Codex home lock in the old folder, or a process's
//   command line names it (listed: it ends none), and when the new folder is there already (unless it holds an
//   unfinished move of the same folders, which it resumes).
// - The move is one rename on the same volume: all or nothing, instant, and the folders keep their permissions (those
//   Codex's sandbox set among them). Something holding a file in it makes the rename fail: nothing moves.
// - The sign-ins hold no paths (claude\.credentials.json, codex\auth.json: tokens only). Three files name folders under
//   the test area by absolute path (REWRITES: Claude Code's per-folder trust and its plugin marketplace's folder, Codex's
//   per-folder trust): each is rewritten to the new path in every spelling found, after a copy goes to
//   move-backup-<time> in the new folder. Run records, results and logs name the old path as history and stay as written;
//   the scenario baselines name no path.
// - Resumable (MARKER): written in the old folder before the rename, it moves with it and goes once every rewrite is
//   done. A run that finds the new folder with a marker for the same folders resumes the rewrites (each is idempotent,
//   and a file's backup is written once); one that finds the old folder with a stale marker (the rename never happened)
//   starts over. CW_MOVE_FAIL_AFTER=<n> (only this script reads it, for proving that) stops it after the n-th rewrite.
// - Then it reports both test homes' sign-ins (claude auth status, codex login status: read only), removes the old
//   update suite's download caches (%LOCALAPPDATA%\hive-test-updater*, throwaway), and prints the Defender lines.
// - Then, and on a rerun once the area is moved, the scenario benchmarks' schema is converted to 1.1's
//   (convertBenchmarks.mjs, HI-2605); --dry-run says how many it would convert.
// --from and --to move another folder (a copy, to prove the move on); the rewrites then also replace the real old
// folder's path, which the copy's files name.
import { spawnSync } from 'child_process'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import { convertBenchmarks } from './convertBenchmarks.mjs'
import { claimHeld } from './e2e/lanes.mjs'

const require = createRequire(import.meta.url)
const { NAME, OLD_NAME, MARKER, absent, present, areas } = require('./testArea.cjs')

/** The files under the test area that name its folders by absolute path, and must name the new one after the move. */
export const REWRITES = ['claude/.claude.json', 'claude/plugins/known_marketplaces.json', 'codex/config.toml']
/** Where runners keep their claims in the test area (heavy and side slots, lanes, build locks, Codex home locks). */
export const CLAIM_DIRS = ['heavy-slots', 'e2e-lanes', 'build-locks', 'codex-home-locks']

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * text with each path under one of froms replaced by the same path under to, in each spelling a file may hold: back
 * slashes, JSON's doubled ones, forward slashes; any letter case. Idempotent: text naming none of froms is unchanged.
 * Returns { text, count }.
 */
export function rewriteText(text, froms, to) {
  let count = 0
  for (const from of froms) {
    const parts = resolve(from).split(/[\\/]+/).filter(Boolean)
    const toParts = resolve(to).split(/[\\/]+/).filter(Boolean)
    for (const sep of ['\\\\', '\\', '/']) {
      const re = new RegExp(`${parts.map(escape).join(escape(sep))}(?=$|${escape(sep)}|["'\\]\\s,}])`, 'gi')
      text = text.replace(re, () => {
        count++
        return toParts.join(sep)
      })
    }
  }
  return { text, count }
}

/** A folder in a claim folder this new, with no claim in it yet, is a claim being made (build.mjs's and lanes.mjs's locks: their 30 s). */
export const CLAIM_MAKING_MS = 30_000

/**
 * The claims in root's claim folders that keep the area busy: [{ file, pid, what }]. Fails closed (HR1, HI-2590 round
 * 1): only a claim folder or file that isn't there (gone between listing and reading: released) counts as no claim. A
 * claim it can't read, or that isn't whole JSON (being written: claims aren't written atomically; or broken), and a lock
 * folder just made with its claim not written yet, keep it busy too, as does a claim held by a live process; listing a
 * claim folder failing otherwise throws.
 */
export function liveClaims(root, alive, now = Date.now()) {
  const out = []
  const busy = (file, what, pid = null) => out.push({ file: relative(root, file), pid, what })
  for (const d of CLAIM_DIRS) {
    const dir = join(root, d)
    let names = []
    try {
      names = readdirSync(dir, { recursive: true })
    } catch (e) {
      if (absent(e)) continue
      throw e
    }
    for (const n of names) {
      const file = join(dir, String(n))
      let st
      try {
        st = statSync(file)
      } catch (e) {
        if (absent(e)) continue
        busy(file, `couldn't look at it (${e.code || e.message})`)
        continue
      }
      if (st.isDirectory()) {
        let inside = []
        try {
          inside = readdirSync(file)
        } catch (e) {
          if (absent(e)) continue
          busy(file, `couldn't list it (${e.code || e.message})`)
          continue
        }
        if (!inside.some((x) => x.endsWith('.json')) && now - st.mtimeMs < CLAIM_MAKING_MS) busy(file, 'a claim being made')
        continue
      }
      if (!file.endsWith('.json')) continue
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch (e) {
        if (absent(e)) continue
        busy(file, `couldn't read it (${e.code || e.message})`)
        continue
      }
      let claim
      try {
        claim = JSON.parse(text)
      } catch {
        busy(file, 'not a whole claim: being written, or broken (look at it)')
        continue
      }
      if (claimHeld(claim, alive)) busy(file, claim.what || claim.root || '', claim.pid)
    }
  }
  return out
}

/** What a run finds: 'fresh' (move it), 'resume' (finish the rewrites), 'restart' (a stale marker: move it), or 'done'/'refuse' with why. */
export function moveState(from, to) {
  const marker = (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, MARKER), 'utf8'))
    } catch (e) {
      return absent(e) ? null : { unreadable: e.code || e.message }
    }
  }
  const same = (m) => m && resolve(m.from ?? '').toLowerCase() === resolve(from).toLowerCase() && resolve(m.to ?? '').toLowerCase() === resolve(to).toLowerCase()
  let fromThere, toThere
  try {
    fromThere = present(from)
    toThere = present(to)
  } catch (e) {
    return { state: 'refuse', why: `couldn't look at ${e.path ?? 'a folder'} (${e.code || e.message}): fix its access first.` }
  }
  if (toThere) {
    const m = marker(to)
    if (m?.unreadable) return { state: 'refuse', why: `couldn't read the move marker in ${to} (${m.unreadable}): fix its access first.` }
    if (m && same(m) && !fromThere) return { state: 'resume', marker: m }
    if (m) return { state: 'refuse', why: `${to} holds a move marker for other folders, or the old folder is back too (${JSON.stringify(m)}): look at both before going on.` }
    if (fromThere) return { state: 'refuse', why: `both ${from} and ${to} are there: a checkout older than the move (HI-2590) has made the old one again. Look at what is in it; nothing is moved.` }
    return { state: 'done', why: `the test area is at ${to} already: nothing to move.` }
  }
  if (!fromThere) return { state: 'refuse', why: `there is no ${from} to move.` }
  const m = marker(from)
  if (m?.unreadable) return { state: 'refuse', why: `couldn't read the move marker in ${from} (${m.unreadable}): fix its access first.` }
  return m ? { state: 'restart' } : { state: 'fresh' }
}

/** The rewrites in to, resumable: each file's backup is written once, each write is atomic. Returns [{ file, count }]. */
export function rewriteAll(to, { froms, backup, failAfter = Infinity, say = () => {} }) {
  const done = []
  for (const rel of REWRITES) {
    const file = join(to, rel)
    if (!present(file)) {
      done.push({ file: rel, count: 0, missing: true })
      continue
    }
    const before = readFileSync(file, 'utf8')
    const kept = join(backup, rel)
    if (!present(kept)) {
      mkdirSync(dirname(kept), { recursive: true })
      writeFileSync(kept, before)
    }
    const { text, count } = rewriteText(before, froms, to)
    if (count) {
      const tmp = `${file}.move-${process.pid}`
      writeFileSync(tmp, text)
      renameSync(tmp, file)
    }
    done.push({ file: rel, count })
    say(`  ${rel}: ${count} path${count === 1 ? '' : 's'} rewritten`)
    if (done.length >= failAfter) throw new Error(`stopped after ${done.length} rewrite(s) (CW_MOVE_FAIL_AFTER)`)
  }
  for (const rel of REWRITES) {
    const file = join(to, rel)
    if (present(file) && rewriteText(readFileSync(file, 'utf8'), froms, to).count) throw new Error(`${rel} still names the old folder after its rewrite`)
  }
  return done
}

/**
 * Moves from to to (moveState first). opts: froms (the paths the rewrites replace; from and the real old folder),
 * running (the processes naming from: [{ pid, commandLine }]), alive (a pid's process is running), dryRun, failAfter,
 * say. Returns { state, moved, rewrites } or throws with what to do.
 */
export function moveArea(from, to, { froms = [from], running = [], alive = () => false, dryRun = false, failAfter = Infinity, say = () => {}, now = () => new Date() } = {}) {
  const st = moveState(from, to)
  if (st.state === 'refuse') throw new Error(`Not moved: ${st.why}`)
  if (st.state === 'done') {
    say(st.why)
    return { state: 'done', moved: false, rewrites: [] }
  }
  const holder = st.state === 'resume' ? to : from
  const claims = liveClaims(holder, alive)
  if (claims.length || running.length) {
    const lines = [...claims.map((c) => `  a runner's claim ${c.file} (${c.pid == null ? c.what : `process ${c.pid}${c.what ? `, ${c.what}` : ''}`})`),...running.map((p) => `  process ${p.pid}: ${p.commandLine}`)]
    throw new Error(`Not moved: tests are using ${holder}. Wait for them to end (nothing is stopped here):\n${lines.join('\n')}`)
  }
  if (dryRun) {
    say(`Would ${st.state === 'resume' ? 'finish the move to' : 'move'} ${from} → ${to}, then rewrite ${REWRITES.join(', ')}.`)
    return { state: st.state, moved: false, rewrites: [] }
  }
  let marker = st.marker
  if (st.state !== 'resume') {
    marker = { from: resolve(from), to: resolve(to), startedAt: now().toISOString().replace(/[:.]/g, '-'), files: REWRITES }
    writeFileSync(join(from, MARKER), JSON.stringify(marker, null, 2) + '\n')
    try {
      renameSync(from, to)
    } catch (e) {
      rmSync(join(from, MARKER), { force: true })
      throw new Error(`Not moved: ${from} couldn't be renamed (${e.code || e.message}). Something holds a file in it (a test, an editor, a CLI with a test home open, a scan): close it and run this again. Nothing changed.`, { cause: e })
    }
    say(`Moved ${from} → ${to}.`)
  } else say(`Finishing the move to ${to} (started ${marker.startedAt}).`)
  const rewrites = rewriteAll(to, { froms, backup: join(to, `move-backup-${marker.startedAt}`), failAfter, say })
  rmSync(join(to, MARKER), { force: true })
  return { state: st.state, moved: true, rewrites }
}

// ------------------------------------------------------------------------------------------------ the command

const main = resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
if (main) {
  const args = process.argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const real = areas()
  const from = resolve(opt('--from') ?? real.old)
  const to = resolve(opt('--to') ?? (opt('--from') ? join(dirname(from), NAME) : real.area))
  for (const p of [from, to]) if (!isAbsolute(p)) throw new Error(`${p} isn't an absolute path`)
  const { processes, namesFolder } = require('./e2e/folderProcesses.cjs')
  const { processAlive } = await import('./e2e/logs.mjs')
  const st = moveState(from, to)
  const running = st.state === 'fresh' || st.state === 'restart' || st.state === 'resume' ? processes().filter((p) => p.pid !== process.pid && namesFolder(p.commandLine ?? '', st.state === 'resume' ? to : from)) : []
  const failAfter = Number(process.env.CW_MOVE_FAIL_AFTER) || Infinity
  let result
  try {
    result = moveArea(from, to, { froms: [...new Set([from, real.old])], running, alive: processAlive, dryRun: args.includes('--dry-run'), failAfter, say: (l) => console.log(l) })
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  if (result.moved) {
    const { baseEnv } = require('./e2e/runContext.cjs')
    // Read only: whether each home is still signed in (Codex says it on stderr). One command line for the shell, which
    // finds claude and codex (.cmd or .exe) on PATH.
    const status = (command, env) => {
      const r = spawnSync(command, { encoding: 'utf8', env: { ...baseEnv(), ...env }, timeout: 60_000, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim()
      return r.error ? `couldn't tell (${r.error.message})` : out || `nothing said (exit ${r.status})`
    }
    console.log(`\nClaude Code's test home (${join(to, 'claude')}): ${status('claude auth status', { CLAUDE_CONFIG_DIR: join(to, 'claude') })}`)
    console.log(`Codex's test home (${join(to, 'codex')}): ${status('codex login status', { CODEX_HOME: join(to, 'codex') })}`)
    if (!opt('--from')) {
      const local = dirname(real.old)
      for (const n of readdirSync(local)) {
        if (!/^hive-test-updater(-[\w-]+)?$/i.test(n)) continue
        try {
          if (statSync(join(local, n)).isDirectory()) rmSync(join(local, n), { recursive: true, force: true })
          console.log(`Removed the old update suite's download cache ${n}.`)
        } catch (e) {
          console.log(`Couldn't remove ${n} (${e.code || e.message}): remove it by hand.`)
        }
      }
    }
    console.log(`\nMicrosoft Defender: exclude the new folder and drop the old one, in PowerShell as administrator:\n  Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\\${NAME}"\n  Remove-MpPreference -ExclusionPath "$env:LOCALAPPDATA\\${OLD_NAME}"`)
  }
  // The scenario benchmarks' schema (HI-2605), once the area is in its new place: after the move, or on a rerun.
  if (result.moved || result.state === 'done') {
    console.log('')
    try {
      const conv = convertBenchmarks(to, { dryRun: args.includes('--dry-run'), alive: processAlive, say: (l) => console.log(l) })
      if (conv.failed.length) process.exit(1)
    } catch (e) {
      console.error(e.message)
      process.exit(1)
    }
  }
}
