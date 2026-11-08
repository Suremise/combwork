// An e2e wait for an agent's `status === 'ready'` (HI-2688): after a turn a fake's status is `finished`, not `ready`, so
// such a wait runs out at its bound and nothing checks it (HI-2663 found 420 of three suites' 623 s spent so). The wait
// to use is `lib.agentIdle(inv, agentId, ms)`, idle in any of the fake's idle states. Before any turn `ready` is right:
// a comment on the wait's line or the line above says so, and the reviewer judges it.
//   npm run test:waits              also runs this (testWaits.mjs's last step, reportReadyWaits): the ready waits a
//                                   branch adds or changes in tests/e2e since main (or --base), uncommitted and new files
//                                   too, with no comment; test:waits exits 1 when there is one
//   node scripts/readyWaits.mjs     the same alone; --base <ref> to compare with another ref than main
//   node scripts/readyWaits.mjs --all   every such wait in tests/e2e, commented or not (lists only, exits 0)
// It exits 2 when it can't compare (no such ref, git fails): nothing was checked. What it can't see: a wait under
// another helper's name, or one whose condition is on another line than its `until(`.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const E2E = 'tests/e2e'
/** A wait (`until(`, `lib.until(`) whose condition is an agent's status being `ready`. */
const READY_WAIT = /\buntil\(.*\bstatus\s*===\s*(['"])ready\1/
/** A line that is a comment, or ends with one. */
const COMMENT = /\/\/|\/\*/

/** The ready waits in a suite's text: each its line (from 1), its code, and whether a comment says why. */
export function findReadyWaits(text) {
  const lines = text.split(/\r?\n/)
  const found = []
  lines.forEach((l, i) => {
    if (!READY_WAIT.test(l) || /^\s*(\/\/|\*)/.test(l)) return
    // A comment on its own line, after the code (a string holding `//` aside: rare in a wait's line), or just above it.
    const commented = COMMENT.test(l.slice(l.search(READY_WAIT))) || /^\s*(\/\/|\*|\/\*)/.test(lines[i - 1] ?? '')
    found.push({ line: i + 1, code: l.trim(), commented })
  })
  return found
}

/** The lines each e2e suite changed since its merge base with `base` (a new file: 'all'). Throws when git can't compare. */
function changedLines(base) {
  // No GIT_DIR or other GIT_* from the shell: this checkout's own repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)))
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const from = git('merge-base', 'HEAD', base).trim()
  const changed = new Map()
  let file = null
  for (const l of git('diff', '--unified=0', '--no-color', '--no-ext-diff', from, '--', E2E).split('\n')) {
    if (l.startsWith('+++ ')) file = l === '+++ /dev/null' ? null : l.slice(6)
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(l)
    if (file && hunk) {
      const set = changed.get(file) ?? new Set()
      for (let n = +hunk[1]; n < +hunk[1] + +(hunk[2] ?? 1); n++) set.add(n)
      // A deletion-only hunk touches the line after it: removing a wait's comment counts.
      if (hunk[2] === '0') set.add(+hunk[1] + 1)
      changed.set(file, set)
    }
  }
  for (const f of git('ls-files', '--others', '--exclude-standard', '--', E2E).split('\n').filter(Boolean)) changed.set(f, 'all')
  return changed
}

/**
 * Says the new or changed ready waits since `base` with no comment, each on a line, then what to do; how many there are.
 * Throws when git can't compare (nothing was checked).
 */
export function reportReadyWaits(base) {
  const changed = changedLines(base)
  let found = 0
  for (const [f, lines] of changed) {
    const p = join(ROOT, f)
    if (!f.endsWith('.cjs') || !existsSync(p)) continue
    for (const w of findReadyWaits(readFileSync(p, 'utf8'))) {
      if (w.commented || (lines !== 'all' && !lines.has(w.line))) continue
      found++
      console.log(`${f}:${w.line}  ${w.code.slice(0, 140)}`)
    }
  }
  console.log(found ? `\n${found} new or changed wait(s) for an agent's ready status: after a turn a fake is \`finished\`, so use lib.agentIdle(inv, agentId, ms); before any turn, say so in a comment (HI-2688).` : `No new wait for an agent's ready status since ${base}.`)
  return found
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2)
  const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'main'
  if (args.includes('--all')) {
    let n = 0
    for (const f of readdirSync(join(ROOT, E2E)).filter((x) => x.endsWith('.cjs'))) {
      for (const w of findReadyWaits(readFileSync(join(ROOT, E2E, f), 'utf8'))) {
        n++
        console.log(`${E2E}/${f}:${w.line}${w.commented ? '  (commented)' : ''}  ${w.code.slice(0, 140)}`)
      }
    }
    console.log(`\n${n} wait(s) for an agent's ready status in ${E2E}.`)
    process.exit(0)
  }
  try {
    process.exit(reportReadyWaits(base) ? 1 : 0)
  } catch (e) {
    // Nothing was checked, so it hasn't passed.
    console.error(`Can't compare with ${base} (${String(e.message).split('\n')[0]}): nothing checked.`)
    process.exit(2)
  }
}
