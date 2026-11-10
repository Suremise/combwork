// What a jj review copy holds, and what changed in it while its reviewer had it (HI-2870, HR2's round 1): a reviewer
// reads the submitted change and records nothing, so its copy's files, and jj's working copy and its parent there, end
// as they began. Its failure is fixed with a unit test (tests/scenarioJjReviewCopy.test.ts), never with a model run.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

/** Every file in the copy but jj's and Git's own, by its path from the copy (forward slashes), with its content's hash. */
function filesOf(folder) {
  const out = {}
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!rel && (e.name === '.jj' || e.name === '.git')) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, e.name))).digest('hex').slice(0, 16)
    }
  }
  walk(folder, '')
  return out
}

/**
 * The copy now: its files, and jj's working copy and its parent as jj has them recorded (`jj(...args)` runs jj there
 * without snapshotting it, so the look records nothing itself). Null when the copy is gone.
 */
function copySnapshot(folder, jj) {
  if (!fs.existsSync(folder)) return null
  const at = jj('log', '--no-graph', '-r', '@', '-T', 'commit_id ++ " " ++ empty').trim().split(' ')
  return { files: filesOf(folder), at: at[0] ?? '', atEmpty: at[1] === 'true', parent: jj('log', '--no-graph', '-r', '@-', '-T', 'commit_id').trim() }
}

/**
 * Whether a look at a review copy (`view`, its `copies:list` row; `snap`, its snapshot) can be its first (HI-2907): only
 * once Combwork has it ready, never while its lease's operation is still making or resetting it (jj records `@` on the
 * revision before the copy's files are written, so a look then sees them appear later, as the reviewer's edits).
 * 'baseline': lent and ready, on `revision`: what later looks are compared with. 'seen': ready and already given back, on
 * `revision` (a quick reviewer's whole review between two looks): it was on it, with nothing left to compare. Else null.
 */
function firstLook(view, snap, revision) {
  if (!snap || snap.parent !== revision || !view?.lease) return null
  // 'leased' is set by the write that ends the lease's operation, after the copy is made, reset and checked; 'returning'
  // only by that write or after it. Before then the copy is 'creating', or keeps the state it had when free.
  if (view.state === 'leased' && !view.lease.returned) return 'baseline'
  if (view.state === 'returning' && view.lease.returned) return 'seen'
  return null
}

/**
 * What changed between two snapshots of one copy, a line each: a file edited, added or removed (without a jj command), or
 * jj's working copy or its parent moved (a commit, `jj new`, `jj describe`, `jj edit`). Empty when nothing did.
 */
function copyChanges(first, now) {
  if (!first || !now) return []
  const out = []
  for (const f of new Set([...Object.keys(first.files), ...Object.keys(now.files)])) {
    if (!(f in now.files)) out.push(`removed ${f}`)
    else if (!(f in first.files)) out.push(`added ${f}`)
    else if (first.files[f] !== now.files[f]) out.push(`edited ${f}`)
  }
  if (first.at !== now.at) out.push(`jj's working copy moved: ${first.at.slice(0, 12)} → ${now.at.slice(0, 12)}`)
  if (first.parent !== now.parent) out.push(`its parent moved: ${first.parent.slice(0, 12)} → ${now.parent.slice(0, 12)}`)
  return out
}

/**
 * jj subcommands that record or change a working copy or its commits (not reads: log, diff, show, status, file show, op
 * log), with the second word where only some of a group's do.
 */
const JJ_RECORDS = new Set(['commit', 'ci', 'new', 'describe', 'desc', 'squash', 'unsquash', 'edit', 'abandon', 'restore', 'split', 'rebase', 'absorb', 'duplicate', 'diffedit', 'resolve', 'revert', 'backout', 'parallelize', 'fix', 'undo', 'redo', 'next', 'prev', 'interdiff-apply'])
const JJ_RECORDS_IN = { op: new Set(['restore', 'revert', 'undo', 'abandon']), file: new Set(['chmod', 'track', 'untrack']), sparse: new Set(['set', 'reset', 'edit']), workspace: new Set(['add', 'forget', 'update-stale', 'rename']) }
/** A shell command that writes, moves or removes files (its first word), and a redirection into a file. */
const WRITES = /^(set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|rm|del|erase|mv|move|cp|copy|ren|rename|tee|touch|truncate)$/i
const REDIRECT = /(^|[^0-9&])>{1,2}\s*[^&\s]/

/**
 * What a reviewer's tool calls did to its review copy (`copy`, its folder), a line each, however quick the reviewer was:
 * a file tool's edit of a file there; or, in a shell call run there (its folder in the copy) or naming it, a jj command
 * that records or changes its working copy or commits, or a command that writes, moves or removes files. Reads aren't
 * counted, nor anything outside the copy.
 */
function copyWrites(o, copy) {
  if (!copy) return []
  const { commands, commandText, SHELL_TOOL } = require('./gitMutations.cjs')
  const { jjCall } = require('./jjPublishes.cjs')
  const norm = (x) => String(x).toLowerCase().replace(/\\+/g, '/').replace(/\/+$/, '')
  const top = norm(copy)
  const inCopy = (dir) => !!dir && (norm(dir) === top || norm(dir).startsWith(`${top}/`))
  const out = []
  for (const t of o.tools ?? []) {
    const input = String(t.input ?? '')
    const names = norm(input).includes(top)
    if (/^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|str_replace_editor|create|edit)$/i.test(t.name)) {
      if (names || inCopy(t.cwd)) out.push(`${t.name}: ${input.slice(0, 120)}`)
      continue
    }
    if (!SHELL_TOOL.test(t.name) || !(names || inCopy(t.cwd))) continue
    // Quoted text emptied first: a script's or a message's `;`, `|` or `>` is no command or redirection (an argument it
    // stands for, `-R "<copy>"`'s path, still counts as one; the copy is found in the input above).
    const text = commandText(input).replace(/"[^"]*"|'[^']*'/g, '""')
    for (const words of commands(text)) {
      const jj = jjCall(words)
      const writes = jj ? JJ_RECORDS.has(jj[0]) || !!JJ_RECORDS_IN[jj[0]]?.has(jj[1]) : WRITES.test(words[0]?.replace(/^[&(]+/, '') ?? '') || (words[0] === 'sed' && words.some((w) => w.startsWith('-i'))) || REDIRECT.test(words.join(' ').replace(/2>\s*\S+|>\s*(\$null|nul|\/dev\/null)\b/gi, ''))
      if (writes) out.push(words.join(' '))
    }
  }
  return out
}

module.exports = { copySnapshot, firstLook, copyChanges, copyWrites, filesOf }
