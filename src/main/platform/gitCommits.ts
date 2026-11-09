// Git's commits as the merge queue makes them (#1350; HI-2790's R7 moved them here from mergeQueue.ts unchanged): their
// environment (no prompt ever waited on, git's trace2 events on its stderr), who wrote what in a commit's stderr (git, a
// hook, the signer), why one failed, and a `git config --get` read as git answered it. Git's implementation of the
// integration port (gitIntegration.ts) commits with them; mergeQueue.ts re-exports what its tests and callers name.

import type { CandidatePauseReason, QueueGitResult } from './integration'

/**
 * HI-2054: a `git config --get` as git answered it: its value, '' when git says the key isn't set (its own exit 1), or
 * `{ failed }` with git's words for a read git couldn't make (as src/main/platform/git's identity, HI-2019). A git that
 * never started, was ended by a signal or by its bound is never an answer, whatever its code or partial output.
 */
export const configRead = (r: QueueGitResult): string | { failed: string } => {
  const answered = !r.timedOut && !r.notRun && !r.signal
  if (answered && r.ok) return r.out.trim()
  if (answered && r.code === 1) return ''
  return { failed: r.err.trim() || `git exited with code ${r.code}` } // i18n-ignore: git's side of a pause's message, in English as git's are
}

/**
 * A signer's messages that say it would wait for someone (a passphrase, a pinentry, a terminal): read only once git's
 * trace says the signer is what failed, never to tell a signer from a hook.
 */
const SIGN_WAITS = /passphrase|pinentry|inappropriate ioctl|cannot open \/dev\/tty|no tty|tty.*not available/i

/** git's own line when a pre-merge-commit or commit-msg hook stopped a merge commit (used only with no trace to read). */
const MERGE_HOOK_STOPPED = /^Not committing merge;/m

/** A child git ran for a commit, as its trace names it, with the text it wrote: a hook, the signer, or another (git's own). */
export interface CommitChild {
  kind: 'hook' | 'signer' | 'other'
  /** A hook's name (`commit-msg`). */
  name?: string
  /** Its exit code; none while it ran (the stream ended, or was cut, first). */
  code?: number
  text: string
  /**
   * git's own text once it had exited, until the next child starts (HI-2399): where a newer git (Git for Windows 2.56) reprints the signer's
   * text, which it captured (`error: gpg failed to sign the data:` and gpg's lines; ssh-keygen's as `error: …`).
   */
  after: string
}

/**
 * A commit's stderr read with git's own trace in it (#1350: `GIT_TRACE2_EVENT=2`, trace2's events on git's stderr, in
 * the order things happened): each piece of text given to the source that wrote it. A child's text comes after its
 * `child_start` and before its `child_exit` (a hook writes before it exits; git writes `child_exit` once it has waited
 * for it); text while no child of the top git runs is git's own. `traced`: the top git's events were there (an old
 * git writes none). `open`: the child running where the stream ends.
 */
export interface CommitStream {
  traced: boolean
  children: CommitChild[]
  open: CommitChild | null
  git: string
  /** All the text, every source's, in order, without the events: what a message shows. */
  text: string
}

/** A trace2 event: a complete JSON record with the fields its kind needs; anything else is text, whatever it looks like. */
type TraceEvent = { event: string; sid: string; child_id?: number; child_class?: string; hook_name?: string; argv?: string[]; code?: number }

function traceEvent(s: string): TraceEvent | null {
  let v: unknown
  try {
    v = JSON.parse(s)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const e = v as Record<string, unknown>
  if (typeof e.event !== 'string' || typeof e.sid !== 'string' || typeof e.time !== 'string') return null
  if (e.event === 'child_start' && (typeof e.child_id !== 'number' || !Array.isArray(e.argv) || !e.argv.every((a) => typeof a === 'string'))) return null
  if (e.event === 'child_exit' && (typeof e.child_id !== 'number' || typeof e.code !== 'number')) return null
  return e as TraceEvent
}

/**
 * A line split into its text and the trace event ending it: an event begins at a `{"event":"` and runs to the line's
 * end, so text with no newline before it (a hook's last line) stays text. The first place a valid record starts wins;
 * an event-looking fragment that isn't one is text.
 */
function splitTraceLine(line: string): { text: string; ev: TraceEvent | null } {
  const body = line.endsWith('\r') ? line.slice(0, -1) : line
  for (let i = body.indexOf('{"event":"'); i >= 0; i = body.indexOf('{"event":"', i + 1)) {
    const ev = traceEvent(body.slice(i))
    if (ev) return { text: body.slice(0, i), ev }
  }
  return { text: line, ev: null }
}

/** Reads a commit's stderr (git's trace in it) into who wrote what (CommitStream). */
export function readCommitStream(err: string): CommitStream {
  const children: CommitChild[] = []
  const byId = new Map<number, CommitChild>()
  let open: CommitChild | null = null
  // The child that exited last, while no other has started since: git's text then is also its `after`.
  let last: CommitChild | null = null
  let top: string | null = null
  let own = ''
  let text = ''
  const add = (t: string): void => {
    if (!t) return
    text += t
    if (open) open.text += t
    else {
      own += t
      if (last) last.after += t
    }
  }
  // The top git's session starts with its `version` event (trace2's first) and has no parent's prefix; a git a hook runs
  // is `<parent>/<own>`. Only their records are events: any other record (a hook's own structured log, #1397) is text.
  const ours = (ev: TraceEvent): boolean => (top === null ? ev.event === 'version' && !ev.sid.includes('/') : ev.sid === top || ev.sid.startsWith(`${top}/`))
  const lines = err.split('\n')
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? '\n' : ''
    const { text: t, ev } = splitTraceLine(line)
    if (!ev || !ours(ev)) return add(line + nl)
    // Text cut by an event (no newline of its own) keeps a line of its own.
    add(t ? `${t}\n` : '')
    // A descendant's events are only dropped from the text, never a source.
    top ??= ev.sid
    if (ev.sid !== top || ev.child_id === undefined) return
    if (ev.event === 'child_start') {
      const argv = ev.argv ?? []
      const signer = argv.includes('-bsau') || (argv.includes('-Y') && argv.includes('sign'))
      const c: CommitChild = { kind: ev.child_class === 'hook' ? 'hook' : signer ? 'signer' : 'other', ...(ev.child_class === 'hook' ? { name: ev.hook_name ?? argv[0] ?? 'hook' } : {}), text: '', after: '' }
      children.push(c)
      byId.set(ev.child_id, c)
      open = c
      last = null
    } else if (ev.event === 'child_exit') {
      const c = byId.get(ev.child_id)
      if (c) c.code = ev.code
      if (open === c) {
        open = null
        last = c ?? null
      }
    }
  })
  return { traced: top !== null, children, open, git: own, text }
}

export const joined = (...parts: (string | undefined)[]): string => parts.map((p) => p?.trim()).filter(Boolean).join('\n')

/**
 * Why Combwork's merge, or a squash's commit, failed (#1350), from the source of each piece of what it said (its stream,
 * readCommitStream), never from words in another's (a hook that passed saying "passphrase" changes nothing):
 * - ended at the bound: always a pause, decided by what was running when it was ended (`cut`, its stream until then;
 *   ending it may make a hook exit non-zero, which is never its rejection): a hook → `hookTimedOut`; the signer, or
 *   nothing known in a repository that signs → `signingWaits`; else `needsYou`;
 * - a hook that exited non-zero → returned (`hook`) with its own text, then git's;
 * - the signer exiting non-zero → `signingWaits` when its own text says it needs a passphrase, a pinentry or a
 *   terminal, else `signing`, with its text and git's. Its own text is what it wrote while it ran (Git for Windows
 *   2.45 lets it write to stderr) and git's text right after it exited, before any other child (HI-2399: 2.56 captures it and
 *   reprints it then, `error: gpg failed to sign the data:` and gpg's lines); a hook's text is never either;
 * - anything else (an index lock, a broken repository) → `needsYou` with git's own lines, never a return.
 * With no trace (an old git), only git's own "Not committing merge" is a hook. A message never has an event in it.
 */
export function commitFailed(r: QueueGitResult, signs: boolean): { fail: 'hook'; log: string } | { pause: CandidatePauseReason; message?: string } {
  const s = readCommitStream(r.err)
  const all = joined(r.out, s.text)
  if (r.timedOut) {
    const running = readCommitStream(r.errAtTimeout ?? r.err).open
    if (running?.kind === 'hook') return { pause: 'hookTimedOut', message: all }
    return { pause: running?.kind === 'signer' || signs ? 'signingWaits' : 'needsYou', message: all }
  }
  if (!s.traced) return MERGE_HOOK_STOPPED.test(all) ? { fail: 'hook', log: all } : { pause: 'needsYou', message: all }
  const hook = s.children.find((c) => c.kind === 'hook' && c.code !== undefined && c.code !== 0)
  if (hook) return { fail: 'hook', log: joined(hook.text, s.git, r.out) }
  const signer = s.children.find((c) => c.kind === 'signer' && c.code !== undefined && c.code !== 0)
  if (signer) return { pause: SIGN_WAITS.test(signer.text) || SIGN_WAITS.test(signer.after) ? 'signingWaits' : 'signing', message: joined(signer.text, s.git) }
  return { pause: 'needsYou', message: joined(r.out, s.git) }
}

/**
 * The environment of Combwork's commits (#1350): no prompt is ever waited on. git asks for no credentials, ssh-keygen never
 * asks for a passphrase, and a credential manager stays non-interactive; a pinentry window is ended by the bound.
 */
export function commitEnv(): NodeJS.ProcessEnv {
  // GIT_TRACE2_EVENT=2: git's trace2 events on its own stderr, in order with what its hooks and signer write there.
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never', GIT_TRACE2_EVENT: '2' }
}
