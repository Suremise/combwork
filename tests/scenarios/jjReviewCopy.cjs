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
/** Shells whose script argument is read as commands too: `bash -c "…"`, `pwsh -Command "…"`, `cmd /c …`. */
const SHELLS = /^(bash|sh|zsh|dash|pwsh|powershell|cmd)(\.exe)?$/i

/**
 * A shell call's commands (HI-2935), each its words (quoted text one word, its quotes gone) and `bare`, the command with
 * its quoted text emptied (`""`), where a redirection is looked for: a script's or a message's `;`, `|` or `>` is no
 * command or redirection. As the shell reads them:
 * - a command ends at a line's end, `;`, `&&`, `||` or `|`, outside quotes;
 * - outside quotes, a backslash before a quote, a backslash, a space or one of `;|&<>()` makes it a plain character
 *   (`it\'s`, `a\;b`); before anything else it stays (a Windows path);
 * - in "…", `\"` and PowerShell's `` `" `` are no end (nor `\\`, `` `` ``); '…' has no escapes;
 * - a quote spans lines until it closes, as in a shell (a script given to `node -e` over several lines); one that never
 *   does ends at its line's end;
 * - a heredoc's body (`<<EOF`, `<<'EOF'`, to a line that is exactly its tag; `<<-EOF`, its tag after leading tabs) and a
 *   PowerShell here-string (`@'…'@`, `@"…"@`) are text, never commands (a note with "Reviewer's notes" pairs no quote);
 * - the script of `bash -c`, `sh -c`, `pwsh -Command`, `cmd /c` is read as commands too: the one word after it, or the
 *   rest of the command as written (its quotes kept, HR2's round 1).
 */
function shellCommands(text, depth = 0) {
  const src = String(text)
  const out = []
  /** Each command's words' starts in `src`, and its end there: a shell's script is taken as written. */
  const spans = []
  let words = []
  let starts = []
  let bare = ''
  let word = null
  let heredocs = []
  const add = (s, at) => {
    if (word === null) {
      word = ''
      starts.push(at)
    }
    word += s
  }
  const endWord = () => {
    if (word !== null) words.push(word)
    word = null
  }
  const endCommand = (at) => {
    endWord()
    if (words.length) {
      out.push({ words, bare: bare.trim() })
      spans.push({ starts, end: at })
    }
    words = []
    starts = []
    bare = ''
  }
  /** Where a quote opened before `from` closes, its escapes honoured; -1 when it never does. */
  const closing = (q, from) => {
    for (let j = from; j < src.length; j++) {
      if (q === '"' && (src[j] === '\\' || src[j] === '`') && /["\\`]/.test(src[j + 1] ?? '')) j++
      else if (src[j] === q) return j
    }
    return -1
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '\r') {
      i++
      continue
    }
    if (c === '\n') {
      endCommand(i)
      i++
      // The bodies of heredocs started on that line, each to its tag's line: text, never commands.
      for (const h of heredocs) {
        while (i < src.length) {
          const eol = src.indexOf('\n', i)
          const line = src.slice(i, eol < 0 ? src.length : eol).replace(/\r$/, '')
          i = eol < 0 ? src.length : eol + 1
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.tag) break
        }
      }
      heredocs = []
      continue
    }
    // Outside quotes, an escaped quote, backslash, space or operator is a plain character.
    if (c === '\\' && /['"\\ \t;|&<>()]/.test(src[i + 1] ?? '')) {
      add(src[i + 1], i)
      bare += '_'
      i += 2
      continue
    }
    // A PowerShell here-string: one quoted word, to its closing line.
    if (c === '@' && (src[i + 1] === "'" || src[i + 1] === '"') && /^\r?\n/.test(src.slice(i + 2))) {
      const m = new RegExp(`\n${src[i + 1]}@`).exec(src.slice(i + 2))
      const end = m ? i + 2 + m.index : src.length
      add(src.slice(i + 2, end).replace(/^\r?\n/, '').replace(/\r$/, ''), i)
      bare += '""'
      i = m ? end + m[0].length : src.length
      continue
    }
    if (c === "'" || c === '"') {
      let end = closing(c, i + 1)
      const closed = end >= 0
      if (!closed) {
        const eol = src.indexOf('\n', i)
        end = eol < 0 ? src.length : eol
      }
      const inner = src.slice(i + 1, end).replace(/\r$/, '')
      add(c === '"' ? inner.replace(/[\\`](["\\`])/g, '$1') : inner, i)
      bare += '""'
      i = closed ? end + 1 : end
      continue
    }
    // A heredoc's start (not a `<<<` here-string): kept in the command, its body skipped after this line.
    const hd = c === '<' && src[i + 1] === '<' && src[i + 2] !== '<' ? /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(src.slice(i)) : null
    if (hd) {
      endWord()
      add(hd[0], i)
      endWord()
      bare += ` ${hd[0]} `
      heredocs.push({ tag: hd[3], strip: hd[1] === '-' })
      i += hd[0].length
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      endCommand(i)
      i += 2
      continue
    }
    if (c === ';' || c === '|') {
      endCommand(i)
      i++
      continue
    }
    if (c === ' ' || c === '\t') {
      endWord()
      bare += c
      i++
      continue
    }
    add(c, i)
    bare += c
    i++
  }
  endCommand(src.length)
  // A shell's script: its commands too. `bash -c` takes the word after -c; `pwsh -Command` and `cmd /c` the rest of the
  // command as written, its quotes kept (one quoted word: its text).
  if (depth < 3) {
    for (const [n, cmd] of [...out].entries()) {
      const w = cmd.words
      const name = (w[0] ?? '').replace(/^[&(]+/, '').replace(/^.*[\\/]/, '')
      if (!SHELLS.test(name)) continue
      const k = w.findIndex((x, j) => j > 0 && (/^cmd/i.test(name) ? /^\/[ck]$/i.test(x) : /^-(c|command)$/i.test(x)))
      if (k < 0 || k + 1 >= w.length) continue
      const rest = /^(pwsh|powershell|cmd)/i.test(name) && k + 2 < w.length
      const script = rest ? src.slice(spans[n].starts[k + 1], spans[n].end).replace(/\r/g, '') : w[k + 1]
      out.push(...shellCommands(script, depth + 1))
    }
  }
  return out
}

/**
 * What a reviewer's tool calls did to its review copy (`copy`, its folder), a line each, however quick the reviewer was:
 * a file tool's edit of a file there; or, in a shell call run there (its folder in the copy) or naming it, a jj command
 * that records or changes its working copy or commits, or a command that writes, moves or removes files. Reads aren't
 * counted, nor anything outside the copy.
 */
function copyWrites(o, copy) {
  if (!copy) return []
  const { commandText, SHELL_TOOL } = require('./gitMutations.cjs')
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
    // Read as the shell reads it (shellCommands, HI-2935): a script's or a message's `;`, `|` or `>` is no command or
    // redirection, and a shell's own script (`bash -c "…"`) is commands too.
    for (const { words, bare } of shellCommands(commandText(input))) {
      const jj = jjCall(words)
      const writes = jj ? JJ_RECORDS.has(jj[0]) || !!JJ_RECORDS_IN[jj[0]]?.has(jj[1]) : WRITES.test(words[0]?.replace(/^[&(]+/, '') ?? '') || (words[0] === 'sed' && words.some((w) => w.startsWith('-i'))) || REDIRECT.test(bare.replace(/2>\s*\S+|>\s*(\$null|nul|\/dev\/null)\b/gi, ''))
      if (writes) out.push(words.join(' '))
    }
  }
  return out
}

module.exports = { copySnapshot, firstLook, copyChanges, copyWrites, filesOf, shellCommands }
