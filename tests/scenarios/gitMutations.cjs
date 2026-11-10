// The git commands in an agent's shell calls that change HEAD, the index, a branch or a ref (HI-2800, J7's jj-plain-git
// scenario; design HI-2800/s16, HR2's: every such command, not only the guidance's examples). In a jj workspace jj
// reconciles them on its next command, but HI-2781 validated none beyond a plain commit, and the session contract tells
// agents in a jj project not to run them. Reads and working-tree-only commands (status, log, diff, show, a branch or tag
// listing, restore without --staged) aren't counted. Unit-tested on recorded calls: tests/scenarioGitMutations.test.ts.

/** Subcommands that always change HEAD, the index, a branch or a ref. */
const ALWAYS = new Set(['add', 'rm', 'mv', 'commit', 'reset', 'rebase', 'merge', 'cherry-pick', 'revert', 'am', 'checkout', 'switch', 'update-ref', 'symbolic-ref', 'update-index', 'worktree', 'pull', 'fetch', 'gc', 'prune', 'replace', 'notes', 'filter-branch', 'read-tree', 'commit-tree', 'clean'])

/** Global options that take a value as the next word. */
const TAKES_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

/** Listing flags of `git branch` and `git tag`: with nothing else, a read. */
const LISTING = /^(-l|--list|-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--sort(=.*)?|--format(=.*)?|--column|--no-column|-n\d*|--color(=.*)?|--no-color|--abbrev(=.*)?|--omit-empty)$/

/** Splits a shell line into the words of each command (on ;, &&, ||, | and newlines), quotes kept out. */
function commands(text) {
  const out = []
  for (const part of String(text).split(/\r?\n|;|&&|\|\||\|/)) {
    const words = [...part.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3])
    if (words.length) out.push(words)
  }
  return out
}

/**
 * The git invocation in a command's words, if it is one: its subcommand and that subcommand's arguments, past the
 * global options (`-C <path>`, `--git-dir=…`, `-c k=v`, `--no-pager`), whatever prefix starts it (`& git`, `git.exe`, a path).
 */
function gitCall(words) {
  // The command's own word: past a call operator (`&`, `call`) or variables set for it (`GIT_X=1 git …`), never an
  // argument (`echo git commit`).
  let at = 0
  while (at < words.length && (/^(&|call|command|exec|time)$/i.test(words[at]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]))) at++
  if (at >= words.length || !/(^|[\\/])git(\.exe)?$/i.test(words[at].replace(/^[&(]+/, ''))) return null
  let i = at + 1
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i]
    i += TAKES_VALUE.has(w) ? 2 : 1
  }
  if (i >= words.length) return null
  return { sub: words[i].toLowerCase(), args: words.slice(i + 1) }
}

/** Whether one git invocation changes HEAD, the index, a branch or a ref. */
function mutates({ sub, args }) {
  if (ALWAYS.has(sub)) return true
  if (sub === 'restore') return args.some((a) => a === '--staged' || a === '-S' || /^-[a-zA-Z]*S/.test(a))
  if (sub === 'stash') return !['list', 'show'].includes((args[0] ?? '').toLowerCase())
  if (sub === 'apply') return args.some((a) => a === '--index' || a === '--cached')
  if (sub === 'branch' || sub === 'tag') return args.some((a) => !LISTING.test(a) && !(sub === 'branch' && a === '--'))
  if (sub === 'remote') return ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'prune', 'update'].includes((args[0] ?? '').toLowerCase())
  if (sub === 'config') return false
  return false
}

/** Each git command in a shell call's text that changes HEAD, the index, a branch or a ref, as written. */
function gitMutationsIn(text) {
  const found = []
  for (const words of commands(text)) {
    const call = gitCall(words)
    if (call && mutates(call)) found.push(words.join(' '))
  }
  return found
}

/** Shell tools across the CLIs (Claude Code's Bash and PowerShell, Codex's shell and exec, Copilot's, the scenarios' Shell). */
const SHELL_TOOL = /^(Bash|PowerShell|Shell|shell|exec|exec_command|local_shell|run_command|powershell|bash)$/i

/** Every git mutation an observed session ran (its shell tool calls that didn't fail to start). */
function gitMutations(o) {
  return (o.tools ?? []).filter((t) => SHELL_TOOL.test(t.name)).flatMap((t) => gitMutationsIn(commandText(t.input ?? '')))
}

/** A tool call's command text: its input as it is, or a JSON input's string values (Codex's `{"cmd": …}`, an argv array). */
function commandText(input) {
  try {
    const v = JSON.parse(input)
    if (v && typeof v === 'object') return Object.values(v).map((x) => (Array.isArray(x) ? x.join(' ') : typeof x === 'string' ? x : '')).join('\n')
  } catch {
    // not JSON: the command line itself
  }
  return input
}

module.exports = { gitMutations, gitMutationsIn }
