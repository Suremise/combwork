// The merge queue (SPEC §16.9): Hive performs merges, one entry at a time per target. An entry's way through: check it
// is still approved and not already in the target; test-merge it in the queue's own worktree; run the merge checks on
// exactly that result (installing clean when the manifests changed); then advance the target only on green, after
// writing `IntegrationStarted`, by compare-and-swap (not checked out) or the journaled read-tree/update-ref protocol
// (checked out). A target that moved since the test is tested again; it never advances an untested target.
//
// P2 spike (#1118): the core of the queue over the spike's runtime. The repository lock across processes, hooks and
// signing pauses are P5's. The merge checks (#1349) run as Hive's own runs (queueChecks.ts), each bracketed here: green
// only when it exited 0 and its `CheckRan` counted for exactly the test merge's revision.

import { spawn, type ChildProcess } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'original-fs'
import { join } from 'path'
import { git, GIT_PREFIX } from '../git'
import { endTree } from '../progressReporters/wrapper'
import { openEntry, type CardState, type FactData, type QueueEntry } from '../../shared/workflow/facts'
import type { TransientFailure } from '../../shared/types'
import { notApproved } from '../../shared/workflow/guards'
import { hasStage } from '../../shared/workflow/compile'
import { FOR_YOU, workflowText } from '../../shared/workflow/texts'
import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import { withWriteFence, type CardRecord } from './factStore'
import { LeaseLost } from './queueRunner'
import { reconcile } from './reconcile'
import { bracketEnd, bracketStart } from './queueChecks'
import { HIVE_RUNS } from '../progress'
import type { Workflow, Write } from './runtime'
import type { RunCheck } from '../../shared/types'
import type { QueueStep } from '../../shared/workflow/queue'

export interface CheckResult {
  ok: boolean
  /** The failure was the environment (a check that didn't start, a network error, a timeout), not a result. */
  transient?: boolean
  /** Why it was (#1362): recorded on the card's IntegrationFailed. */
  cause?: TransientFailure
  output: string
  /** The command that ran, and its run's id (a progress run's, when Hive keeps runs). */
  command?: string
  run?: string
  /** Tells the check's run how it counted (its details say why not). */
  note?: (c: RunCheck) => void
}

/** What a merge check or install runs for: the card, and the test merge's result revision it runs on. */
export interface CheckContext {
  card: string
  number: number
  revision: string
  /** Nothing was installed before the checks (no setup command and no lock file): this check's run says so. */
  noInstall?: boolean
}

/** What the merge checks of a test merge came to: green (every one passed and counted), red, or not proved. */
type ChecksOutcome = { kind: 'green' } | { kind: 'red'; transient: boolean; cause?: TransientFailure; output: string } | { kind: 'uncounted' }

export interface QueueConfig {
  /** The queue's own worktree (a merge slot, kept warm). */
  folder: string
  /** Runs a named merge check (its configured command) in a folder, on the test merge's result. */
  runCheck: (name: string, command: string, folder: string, ctx: CheckContext) => Promise<CheckResult>
  /** Installs dependencies there; `clean` from scratch (`npm ci`). `skipped`: there was nothing to install. */
  install?: (folder: string, clean: boolean, ctx: CheckContext) => Promise<CheckResult & { skipped?: boolean }>
  /** The files whose change since the last install means a clean install (#187). */
  manifests?: string[]
  /** An agent builds in this folder (holds file locks there, or has a run going in it). */
  folderBusy?: (folder: string) => boolean
  /**
   * Whether this queue's runner still holds its target's lease (#1360, QueueRunner.holds): checked inside every store
   * write the queue's work makes (its facts, reconciliation's, values, a pause: withWriteFence), which is refused whole
   * once it doesn't, and the queue stops. Left out, always.
   */
  holds?: () => boolean
  /**
   * Runs git for the queue (its test merges, the advance, the pins): the runner's recording one in the app (#1360,
   * QueueRunner.git: its processes in the lease's job, recorded before they run); left out, Hive's own git().
   */
  git?: (cwd: string, args: string[], opts?: QueueGitOptions) => Promise<QueueGitResult>
  /**
   * The longest Hive's merge commit runs when the repository signs its commits (#1350, Advanced
   * `hive.queue.signSeconds`): a signer still waiting then (for a passphrase) is ended and the entry pauses. 60 s left out.
   */
  signTimeoutMs?: number
  /**
   * Runs the advance under the repository's lock across processes (#1347, withRepoLock), its `IntegrationStarted` and
   * the ref's compare-and-swap together; left out, as it is.
   */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>
  /**
   * Whether workflow rules are enforced now (Settings → Advanced, `hive.workflow.enforce`, read at each use): off, an
   * entry stops just before its advance, paused `rulesOff`, and an advance already begun finishes. Left out, always.
   */
  enforced?: () => boolean
  /**
   * A target checked out in a folder (§16.9.2) pauses `checkedOut` instead of being advanced there (#1348: until
   * #1351 builds that advance).
   */
  pauseCheckedOut?: boolean
  /**
   * Told each step of an entry's way as it begins (#1353: the queue's model shows what is testing now), and null once the
   * entry has its outcome.
   */
  onStep?: (step: QueueStepInfo | null) => void
  /** Test seams: crash injection and races between the queue's steps. */
  hooks?: {
    afterTest?: (entry: string) => void | Promise<void>
    afterChecks?: (entry: string) => void | Promise<void>
    afterStarted?: (entry: string) => void | Promise<void>
    afterFiles?: (entry: string) => void | Promise<void>
    afterAdvance?: (entry: string) => void | Promise<void>
  }
}

/** How the queue runs a git command that may run the repository's hooks or sign (#1350): its environment and bound. */
export interface QueueGitOptions {
  env?: NodeJS.ProcessEnv
  /** Ends the command's whole tree (git, its hooks, its signer) once it has run this long. */
  timeoutMs?: number
}

export interface QueueGitResult {
  ok: boolean
  out: string
  err: string
  code: number
  /** Ended at its bound (QueueGitOptions.timeoutMs). */
  timedOut?: boolean
  /** Its stderr as far as it had come when the bound ended it: what was running then. */
  errAtTimeout?: string
}

export type QueueOutcome =
  | { card: string; entry: string; outcome: 'integrated'; result: string; retests: number }
  | { card: string; entry: string; outcome: 'returned'; reason: FactData['IntegrationFailed']['reason']; transient: boolean }
  | { card: string; entry: string; outcome: 'paused'; reason: PauseReason; files?: string[]; message?: string }
  | { card: string; entry: string; outcome: 'skipped'; why: 'notApproved' | 'cancelled' }
  | { card: string; entry: string; outcome: 'integratedOutside' }

/** The entry a queue is taking through its steps now: its card, revision, the target's head it tests on, since when. */
export interface QueueStepInfo {
  card: string
  number: number
  entry: string
  revision: string
  /** The target's head the test merge is made on (null until it is read). */
  expected: string | null
  step: QueueStep
  /** When the queue took the entry (ISO). */
  started: string
}

/**
 * `uncounted`: its checks passed but didn't count for the result MAX_RETESTS times in a row (the card's `CheckRan` says
 * why). `signingWaits`: signing Hive's commit waited for a passphrase (or a pinentry) and was ended; `signing`: it failed
 * (git's message in the pause). `hookTimedOut`: a hook of a signed commit was still running at the signing bound.
 * `identity`: no commit identity for the repository (its folder in the pause). `user`: Pause queue (the user's, or the
 * Assistant's within Control: #1353).
 */
export type PauseReason = 'user' | 'targetMovesFast' | 'folderBusy' | 'wrongBranch' | 'staged' | 'unstagedChanges' | 'identity' | 'needsYou' | 'uncounted' | 'checkedOut' | 'rulesOff' | 'signingWaits' | 'signing' | 'hookTimedOut'

/** The longest a signed merge commit runs when the config gives none (Advanced `hive.queue.signSeconds`'s default). */
const SIGN_TIMEOUT_MS = 60_000

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
  let top: string | null = null
  let own = ''
  let text = ''
  const add = (t: string): void => {
    if (!t) return
    text += t
    if (open) open.text += t
    else own += t
  }
  const lines = err.split('\n')
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? '\n' : ''
    const { text: t, ev } = splitTraceLine(line)
    if (!ev) return add(t + nl)
    // Text cut by an event (no newline of its own) keeps a line of its own.
    add(t ? `${t}\n` : '')
    // The top git's session id has no parent's prefix; a git a hook runs is `<parent>/<own>`: its events are only
    // dropped from the text, never a source.
    if (top === null && !ev.sid.includes('/')) top = ev.sid
    if (ev.sid !== top || ev.child_id === undefined) return
    if (ev.event === 'child_start') {
      const argv = ev.argv ?? []
      const signer = argv.includes('-bsau') || (argv.includes('-Y') && argv.includes('sign'))
      const c: CommitChild = { kind: ev.child_class === 'hook' ? 'hook' : signer ? 'signer' : 'other', ...(ev.child_class === 'hook' ? { name: ev.hook_name ?? argv[0] ?? 'hook' } : {}), text: '' }
      children.push(c)
      byId.set(ev.child_id, c)
      open = c
    } else if (ev.event === 'child_exit') {
      const c = byId.get(ev.child_id)
      if (c) c.code = ev.code
      if (open === c) open = null
    }
  })
  return { traced: top !== null, children, open, git: own, text }
}

const joined = (...parts: (string | undefined)[]): string => parts.map((p) => p?.trim()).filter(Boolean).join('\n')

/**
 * Why Hive's merge, or a squash's commit, failed (#1350), from the source of each piece of what it said (its stream,
 * readCommitStream), never from words in another's (a hook that passed saying "passphrase" changes nothing):
 * - ended at the bound: always a pause, decided by what was running when it was ended (`cut`, its stream until then;
 *   ending it may make a hook exit non-zero, which is never its rejection): a hook → `hookTimedOut`; the signer, or
 *   nothing known in a repository that signs → `signingWaits`; else `needsYou`;
 * - a hook that exited non-zero → returned (`hook`) with its own text, then git's;
 * - the signer exiting non-zero → `signingWaits` when its own text says it needs a passphrase, a pinentry or a
 *   terminal, else `signing`, with its text and git's;
 * - anything else (an index lock, a broken repository) → `needsYou` with git's own lines, never a return.
 * With no trace (an old git), only git's own "Not committing merge" is a hook. A message never has an event in it.
 */
export function commitFailed(r: QueueGitResult, signs: boolean): { fail: 'hook'; log: string } | { pause: PauseReason; message?: string } {
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
  if (signer) return { pause: SIGN_WAITS.test(signer.text) ? 'signingWaits' : 'signing', message: joined(signer.text, s.git) }
  return { pause: 'needsYou', message: joined(r.out, s.git) }
}

/**
 * The environment of Hive's commits (#1350): no prompt is ever waited on. git asks for no credentials, ssh-keygen never
 * asks for a passphrase, and a credential manager stays non-interactive; a pinentry window is ended by the bound.
 */
function commitEnv(): NodeJS.ProcessEnv {
  // GIT_TRACE2_EVENT=2: git's trace2 events on its own stderr, in order with what its hooks and signer write there.
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never', GIT_TRACE2_EVENT: '2' }
}

/**
 * git as Hive runs it, with no input (no terminal to prompt on), in an environment and within a bound: at the bound its
 * whole tree (git, a hook, a signer) is ended, and the result says so. The queue's git when its config gives none (tests;
 * the app runs it through the runner's recorded spawn).
 */
function gitTree(cwd: string, args: string[], opts: QueueGitOptions): Promise<QueueGitResult> {
  return new Promise((res) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    let child: ChildProcess
    try {
      child = spawn('git', [...GIT_PREFIX, ...args], { cwd, env: opts.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return res({ ok: false, out: '', err: e instanceof Error ? e.message : String(e), code: -1 })
    }
    let atTimeout: string | undefined
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          atTimeout = Buffer.concat(err).toString('utf8')
          endTree(child)
        }, opts.timeoutMs)
      : undefined
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    let settled = false
    const done = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      res({ ok: code === 0 && !timedOut, code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8').trim(), ...(timedOut ? { timedOut, errAtTimeout: atTimeout } : {}) })
    }
    child.once('error', (e) => {
      err.push(Buffer.from(e.message))
      done(-1)
    })
    // `exit`, not `close`: a descendant that got away may hold the output open.
    child.once('exit', (c) => setImmediate(() => done(c ?? 1)))
  })
}

/**
 * How many times an entry is tested again for a target that moved (§16.9.1 step 6), or for checks that passed without
 * counting (#1349), before it pauses.
 */
export const MAX_RETESTS = 3

const refSafe = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '-')

/** A runner that lost its lease stops at once: no outcome (another Hive's runner carries on). */
const lostIsNull = (e: unknown): null => {
  if (e instanceof LeaseLost) return null
  throw e
}

export class MergeQueue {
  /** Entries a restart's recovery found should run again from the test merge. */
  private rerun = new Set<string>()

  constructor(
    readonly wf: Workflow,
    readonly cfg: QueueConfig
  ) {}

  private get project(): string {
    return this.wf.cfg.project
  }

  private git(cwd: string, args: string[], opts?: QueueGitOptions): Promise<QueueGitResult> {
    return this.cfg.git ? this.cfg.git(cwd, args, opts) : opts ? gitTree(cwd, args, opts) : git(cwd, args)
  }

  paused(target: string): { reason: PauseReason; card: string; files?: string[]; message?: string } | null {
    return this.wf.store.queuePause(target) as { reason: PauseReason; card: string; files?: string[]; message?: string } | null
  }

  resume(target: string): void {
    this.wf.store.setQueuePause(target, null)
  }

  /** Pauses the target's queue at this entry: its reason, the files or folder it names, git's message (bounded). */
  private async pause(target: string, card: CardRecord, entry: QueueEntry, reason: PauseReason, files?: string[], message?: string): Promise<QueueOutcome> {
    const m = message?.trim().slice(0, 4000) || undefined
    await this.wf.locked(() => this.wf.store.setQueuePause(target, { reason, card: card.key, ...(files ? { files } : {}), ...(m ? { message: m } : {}) }))
    return { card: card.key, entry: entry.id, outcome: 'paused', reason, ...(files ? { files } : {}), ...(m ? { message: m } : {}) }
  }

  /**
   * Runs the queue's work with every store write it makes fenced by the runner's lease (withWriteFence): checked inside
   * each write, which throws LeaseLost (undone whole) once the runner doesn't hold the target.
   */
  private fenced<T>(target: string, fn: () => Promise<T>): Promise<T> {
    const holds = this.cfg.holds
    if (!holds) return fn()
    return withWriteFence(() => {
      if (!holds()) throw new LeaseLost(target)
    }, fn)
  }

  /** The queue's entries for a target, in the order they were requested: open, or recovered to run again. */
  entries(target?: string): { card: CardRecord; entry: QueueEntry }[] {
    const out: { card: CardRecord; entry: QueueEntry }[] = []
    for (const f of this.wf.store.factsOfKind('IntegrationRequested')) {
      const d = f.data as FactData['IntegrationRequested']
      if (target && d.target !== target) continue
      const s = this.wf.state(f.card)
      const e = s.entries.find((x) => x.id === d.entry)
      if (e && (e.state === 'open' || (e.state === 'started' && this.rerun.has(e.id)))) out.push({ card: this.wf.store.card(f.card), entry: e })
    }
    return out
  }

  /** Runs the queue for a target until it is empty or paused; the outcomes in order. */
  async drain(target: string): Promise<QueueOutcome[]> {
    const out: QueueOutcome[] = []
    for (let i = 0; i < 50; i++) {
      const o = await this.runOnce(target).catch(lostIsNull)
      if (!o) break
      out.push(o)
      if (o.outcome === 'paused') break
    }
    return out
  }

  /** Takes the next entry for the target and takes it as far as it goes. Null when there's none or the queue is paused. */
  async runOnce(target: string): Promise<QueueOutcome | null> {
    if (this.paused(target)) return null
    const next = this.entries(target)[0]
    if (!next) return null
    return this.fenced(target, () => this.process(next.card, next.entry)).catch(lostIsNull)
  }

  private async write<T>(card: CardRecord, fn: (w: Write) => T): Promise<T> {
    const s = this.wf.state(card)
    return this.wf.write(card, this.wf.rulesetOf(card, s), 'hive', fn)
  }

  /**
   * The advance's authority, decided in the transaction that writes `IntegrationStarted` (§16.4.6, §16.9.1 step 6):
   * the entry still the card's open one, the card in Merging, approved at the current generation and not stale. A
   * decision, a cancel or a stale pass that landed after the queue's last check stops it here, before git is touched.
   * Workflow rules turned off by now (while the queue waited for the repository lock, say): no advance begins, `rulesOff`.
   * The queue paused by now (Pause queue): none begins either, `held`, the entry left open.
   */
  private startAdvance(card: CardRecord, entry: QueueEntry, data: FactData['IntegrationStarted']): Promise<'started' | 'denied' | 'rulesOff' | 'held'> {
    return this.write(card, (w) => {
      const s = w.state()
      const e = s.entries.find((x) => x.id === entry.id)
      const open = !!e && (e.state === 'open' || (e.state === 'started' && this.rerun.has(e.id)))
      const r = w.ruleset!
      const approved = r.options.review === 'none' ? !s.stale : !notApproved(s, r, card.labels)
      if (!open || s.stage !== 'merging' || !approved) return 'denied' as const
      if (this.cfg.enforced && !this.cfg.enforced()) return 'rulesOff' as const
      if (this.wf.store.queuePause(entry.target)) return 'held' as const
      w.fact('IntegrationStarted', data)
      return 'started' as const
    })
  }

  /** Is the entry still the card's open one, approved at the current generation and not stale (§16.9.1 step 2)? */
  private stillApproved(card: CardRecord, entry: QueueEntry): { s: CardState; ok: boolean; cancelled: boolean } {
    const s = this.wf.state(card)
    const e = s.entries.find((x) => x.id === entry.id)
    const cancelled = !e || e.state === 'cancelled' || e.state === 'failed' || e.state === 'integrated'
    const r = this.wf.rulesetOf(card, s)
    const ok = !cancelled && (r.options.review === 'none' ? !s.stale : !notApproved(s, r, card.labels))
    return { s, ok, cancelled }
  }

  private async process(card: CardRecord, entry: QueueEntry): Promise<QueueOutcome> {
    try {
      return await this.steps(card, entry)
    } finally {
      this.cfg.onStep?.(null)
    }
  }

  private async steps(card: CardRecord, entry: QueueEntry): Promise<QueueOutcome> {
    const target = entry.target
    const started = new Date().toISOString()
    let retests = 0
    let uncounted = 0
    for (;;) {
      const check = this.stillApproved(card, entry)
      if (!check.ok) return this.skip(card, entry, check.cancelled)
      const s = check.s
      const revision = s.approved?.revision ?? entry.revision
      const step = (now: QueueStep, expected: string | null): void => this.cfg.onStep?.({ card: card.key, number: card.id, entry: entry.id, revision, expected, step: now, started })
      step('testMerge', null)
      const base = s.approved?.base ?? s.latest?.base ?? s.started?.base ?? ''
      // Already in the target (merged by hand meanwhile): observed, no empty merge.
      const found = await G.contains(this.project, target, { base, revision, key: s.latest?.key })
      if (!isUnknown(found) && found) {
        await reconcile(this.wf, card)
        return { card: card.key, entry: entry.id, outcome: 'integratedOutside' }
      }
      const expected = await G.lineHead(this.project, target)
      if (isUnknown(expected) || !expected) return this.pause(target, card, entry, 'needsYou')

      // The test merge, in the queue's own worktree, at the expected revision.
      step('testMerge', expected)
      const test = await this.testMerge(card, s, revision, expected)
      if ('pause' in test) return this.pause(target, card, entry, test.pause, test.files, test.message)
      if ('fail' in test) return this.returnCard(card, entry, revision, target, test.fail, false, test.files, test.log)
      const result = test.result
      await this.cfg.hooks?.afterTest?.(entry.id)

      // The merge checks, on exactly that result (dependencies from scratch when the manifests changed). Passed but not
      // proved (something changed the folder while one ran): tested again from a fresh test merge, then paused.
      step('checks', expected)
      const checks = await this.mergeChecks(card, result)
      if (checks.kind === 'red') return this.returnCard(card, entry, revision, target, 'checks', checks.transient, undefined, checks.output, checks.cause)
      if (checks.kind === 'uncounted') {
        if (++uncounted > MAX_RETESTS) return this.pause(target, card, entry, 'uncounted')
        continue
      }
      await this.cfg.hooks?.afterChecks?.(entry.id)

      // The last check before the target moves: still approved (a decision since cancels the entry).
      const last = this.stillApproved(card, entry)
      if (!last.ok) return this.skip(card, entry, last.cancelled)
      // Paused meanwhile (Pause queue): the entry's checks are done, and it waits, open, for Resume (from its test merge).
      const held = this.paused(target)
      if (held) return this.held(card, entry, held.reason)
      step('advance', expected)
      const now = await G.lineHead(this.project, target)
      if (isUnknown(now) || now !== expected) {
        // The target moved since the test: tested again against the new head; never an untested advance.
        if (++retests > MAX_RETESTS) return this.pause(target, card, entry, 'targetMovesFast')
        continue
      }
      // Workflow rules turned off meanwhile: no advance begins (an entry already begun finishes: recover). Decided again
      // in the write of `IntegrationStarted` (startAdvance), after the wait for the lock.
      if (this.cfg.enforced && !this.cfg.enforced()) return this.pause(target, card, entry, 'rulesOff')
      const where = await G.checkouts(this.project)
      if (isUnknown(where)) return this.pause(target, card, entry, 'needsYou')
      // Checked out in a folder, as far as is known now (advanceRef looks again under the lock).
      const folder = where[target] ?? null
      if (folder && this.cfg.pauseCheckedOut) return this.pause(target, card, entry, 'checkedOut', [folder])
      const adv = folder ? await this.advanceCheckedOut(card, entry, target, expected, result, folder) : await this.advanceRef(card, entry, target, expected, result)
      // Checked out in a folder while the queue waited for the lock: looked at again, the checked-out way.
      if (adv === 'checkedOut') {
        if (++retests > MAX_RETESTS) return this.pause(target, card, entry, 'targetMovesFast')
        continue
      }
      if (adv === 'moved') {
        if (++retests > MAX_RETESTS) return this.pause(target, card, entry, 'targetMovesFast')
        entry = this.wf.state(card).entries.at(-1)!
        continue
      }
      if (adv === 'denied') return this.skip(card, entry, this.stillApproved(card, entry).cancelled)
      if (adv === 'held') return this.held(card, entry, this.paused(target)?.reason ?? 'user')
      if (typeof adv === 'object') return this.pause(target, card, entry, adv.pause, adv.files)
      await this.integrated(card, entry, revision, target, result, s.started?.target === target && this.wf.rulesetOf(card, s).options.style === 'squash' ? 'squash' : 'merge', 'hive')
      return { card: card.key, entry: entry.id, outcome: 'integrated', result, retests }
    }
  }

  /**
   * Whether the entry is still open (or begun) in this write's state: an outcome the queue writes late (a red check, a
   * stale pass, a moved target) is written only then, so one removed from the queue meanwhile (Remove from queue, a
   * decision) keeps its cancellation and the card where that put it (#1353).
   */
  private isOpen(w: Write, entry: QueueEntry): boolean {
    const e = w.state().entries.find((x) => x.id === entry.id)
    return !!e && (e.state === 'open' || e.state === 'started')
  }

  /** Paused by someone while the entry ran (Pause queue): it stays open, and the pause as it is. */
  private held(card: CardRecord, entry: QueueEntry, reason: string): QueueOutcome {
    return { card: card.key, entry: entry.id, outcome: 'paused', reason: reason as PauseReason }
  }

  /**
   * An entry that isn't approved any more (its pass stale, a pass or approval missing at the current generation) gets
   * an outcome, so the queue never stalls on it: cancelled, the card back to Review (or Active), its builder woken. An
   * entry already cancelled (a decision, the user) needs nothing more.
   */
  private async skip(card: CardRecord, entry: QueueEntry, cancelled: boolean): Promise<QueueOutcome> {
    if (!cancelled) {
      const wrote = await this.write(card, (w) => {
        if (!this.isOpen(w, entry)) return false
        w.fact('IntegrationCancelled', { entry: entry.id, reason: 'stale' }) // i18n-ignore: a fact's kind and codes, not text
        w.move(w.ruleset && hasStage(w.ruleset, 'review') ? 'review' : 'active', 'derived')
        this.wf.wake(w, w.state().started?.builder, `${card.key} left the merge queue: it isn't approved any more`) // i18n-ignore: a wake, agent-facing
        return true
      })
      // Cancelled meanwhile: that cancellation is its outcome.
      if (!wrote) cancelled = true
    }
    return { card: card.key, entry: entry.id, outcome: 'skipped', why: cancelled ? 'cancelled' : 'notApproved' } // i18n-ignore: a reason's key, not text
  }

  private async identity(): Promise<{ name: string; email: string } | null> {
    return this.wf.cfg.options().identity ?? (await G.identity(this.project))
  }

  /**
   * The test merge (§16.9.1 step 4), committed as Hive's commits are (#1350): with the project's identity (else paused
   * `identity`, naming the folder), the repository's hooks run (one that fails returns the card), signed as the
   * repository says but never waiting on a prompt (paused). Any other failure of git pauses with its message; only a
   * conflict or a hook returns the card. A failure leaves the queue's worktree clean, at the expected revision.
   */
  private async testMerge(card: CardRecord, s: CardState, revision: string, expected: string): Promise<{ result: string } | { fail: 'conflict' | 'hook'; files?: string[]; log: string } | { pause: PauseReason; files?: string[]; message?: string }> {
    const id = await this.identity()
    if (!id) return { pause: 'identity', files: [this.project] }
    const f = this.cfg.folder
    if (!existsSync(f)) {
      const add = await this.git(this.project, ['worktree', 'add', '--detach', f, expected])
      if (!add.ok) return { pause: 'needsYou', message: add.err }
    } else {
      const co = await this.git(f, ['checkout', '--detach', '-f', expected])
      if (!co.ok) return { pause: 'needsYou', message: co.err }
      await this.git(f, ['clean', '-fdq'])
    }
    const r = this.wf.rulesetOf(card, s)
    // The reviewers whose passes count for what is merged: the latest submission, at the current generation.
    const reviewers = [...new Set(s.verdicts.filter((v) => v.pass && v.submission === s.latest?.id && v.generation === s.generation).map((v) => v.reviewer))].join(', ')
    const message = `${card.key}: ${card.title}\n\nHive-Card: ${card.key}\nHive-Revision: ${revision}${reviewers ? `\nHive-Reviewed-By: ${reviewers}` : ''}` // i18n-ignore: a commit message, in English
    const who = ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`]
    const squash = r.options.style === 'squash'
    // Signed as the repository says (never overridden), within a bound when it signs: a signer waiting for a passphrase
    // is ended with the rest of the commit's tree.
    const signs = (await this.git(f, ['config', '--type=bool', '--get', 'commit.gpgsign'])).out.trim() === 'true'
    const opts: QueueGitOptions = { env: commitEnv(), ...(signs ? { timeoutMs: this.cfg.signTimeoutMs ?? SIGN_TIMEOUT_MS } : {}) }
    const clean = async (): Promise<void> => {
      await this.git(f, ['merge', '--abort'])
      await this.git(f, ['reset', '--hard', '-q', expected])
      await this.git(f, ['clean', '-fdq'])
    }
    // Its output read with git's own trace in it (commitEnv), so a failure is told by who said what, never by words.
    const m = await this.git(f, [...who, 'merge', squash ? '--squash' : '--no-ff', ...(squash ? [] : ['--no-edit', '-m', message]), revision], opts)
    if (!m.ok) {
      const u = m.timedOut ? null : await this.git(f, ['diff', '--name-only', '--diff-filter=U'])
      const files = u?.out.split(/\r?\n/).filter(Boolean) ?? []
      await clean()
      if (files.length) return { fail: 'conflict', files, log: joined(m.out, readCommitStream(m.err).text) }
      return commitFailed(m, signs)
    }
    if (squash) {
      const c = await this.git(f, [...who, 'commit', '-q', '-m', message], opts)
      if (!c.ok) {
        await clean()
        return commitFailed(c, signs)
      }
    }
    const h = await G.head(f)
    if (isUnknown(h)) return { pause: 'needsYou' }
    await this.git(this.project, ['update-ref', `refs/hive/queue/${refSafe(card.key)}`, h])
    return { result: h }
  }


  /**
   * Runs the merge checks (G9) on the test merge's result, one after another, stopping at the first that isn't green.
   * Installs clean first when the manifests changed since the folder's last install (#187, always), or before every
   * entry's checks (`mergeInstall: 'always'`). Each check is bracketed and writes `CheckRan` at the result revision
   * (§16.13): green only if it exited 0 and counted; exit 0 but uncounted is `uncounted`, never green.
   */
  private async mergeChecks(card: CardRecord, result: string): Promise<ChecksOutcome> {
    const o = this.wf.rulesetOf(card).options
    if (!o.mergeChecks.length) return { kind: 'green' }
    const f = this.cfg.folder
    const ctx: CheckContext = { card: card.key, number: card.id, revision: result }
    const manifests = this.cfg.manifests ?? ['package.json', 'package-lock.json']
    const hash = createHash('sha256')
    for (const m of manifests) hash.update(existsSync(join(f, m)) ? readFileSync(join(f, m)) : `-${m}`)
    const now = hash.digest('hex')
    const key = `queue:installed:${f}`
    let noInstall = false
    if (this.cfg.install && (o.mergeInstall === 'always' || this.wf.store.meta(key) !== now)) {
      const i = await this.cfg.install(f, true, ctx)
      if (!i.ok) return { kind: 'red', transient: !!i.transient, ...(i.cause ? { cause: i.cause } : {}), output: i.output }
      noInstall = !!i.skipped
      await this.wf.locked(() => this.wf.store.setMeta(key, now))
    }
    for (const name of o.mergeChecks) {
      const command = o.commands[name] ?? name
      const start = await bracketStart(f)
      const r = await this.cfg.runCheck(name, command, f, { ...ctx, ...(noInstall ? { noInstall } : {}) })
      noInstall = false
      const b = await bracketEnd(f, result, start)
      const data: FactData['CheckRan'] = {
        name,
        command: r.command ?? command,
        revision: result,
        tested: b.tested,
        result: r.ok ? 'passed' : 'failed',
        run: r.run ?? randomUUID(),
        durationMs: Math.max(0, Date.now() - start.t0),
        by: HIVE_RUNS,
        counted: b.counted,
        ...(b.whyNot ? { whyNot: b.whyNot } : {})
      }
      await this.write(card, (w) => w.fact('CheckRan', data))
      r.note?.({ name, counted: b.counted, ...(b.whyNot ? { whyNot: b.whyNot } : {}) })
      if (!r.ok) return { kind: 'red', transient: !!r.transient, ...(r.cause ? { cause: r.cause } : {}), output: r.output }
      if (!b.counted) return { kind: 'uncounted' }
    }
    return { kind: 'green' }
  }

  /** The target checked out nowhere: one compare-and-swap (`update-ref <target> <result> <expected>`). */
  private async advanceRef(card: CardRecord, entry: QueueEntry, target: string, expected: string, result: string): Promise<'done' | 'moved' | 'denied' | 'held' | 'checkedOut' | { pause: PauseReason; files?: string[] }> {
    const lock = this.cfg.lock ?? (<T,>(fn: () => Promise<T>) => fn())
    // Under the repository's lock (#1347): the target still checked out nowhere (the user or another Hive may have
    // checked it out while the queue waited: a swap then would leave that folder's files behind), `IntegrationStarted`
    // (its write checks the lease, the fence, and the rules) and the ref's compare-and-swap, the lease checked once more
    // just before the swap.
    const r = await lock(async () => {
      const where = await G.checkouts(this.project)
      if (isUnknown(where)) return { pause: 'needsYou' as const }
      const folder = where[target]
      if (folder) return this.cfg.pauseCheckedOut ? { pause: 'checkedOut' as const, files: [folder] } : ('checkedOut' as const)
      const started = await this.startAdvance(card, entry, { entry: entry.id, expected, result, checkedOut: null })
      if (started === 'rulesOff') return { pause: 'rulesOff' as const }
      if (started === 'denied' || started === 'held') return started
      await this.cfg.hooks?.afterStarted?.(entry.id)
      if (this.cfg.holds && !this.cfg.holds()) throw new LeaseLost(target)
      return (await this.git(this.project, ['update-ref', `refs/heads/${target}`, result, expected])).ok ? ('done' as const) : ('moved' as const)
    })
    if (r === 'moved') {
      await this.moved(card, entry, target)
      return 'moved'
    }
    if (r === 'done') await this.cfg.hooks?.afterAdvance?.(entry.id)
    return r
  }

  /** The swap found the target moved: this entry failed (transient) and the card is queued again, to be tested again. */
  private async moved(card: CardRecord, entry: QueueEntry, target: string): Promise<void> {
    await this.write(card, (w) => {
      // Cancelled meanwhile: not queued again (the queue's next look skips it as cancelled).
      if (!this.isOpen(w, entry)) return
      w.fact('IntegrationFailed', { entry: entry.id, revision: entry.revision, target, reason: 'targetMoved', transient: true }) // i18n-ignore: a fact's kind and codes, not text
      const s = w.state()
      w.fact('IntegrationRequested', { entry: `${card.key}/e${s.lastSeq + 1}`, revision: entry.revision, key: s.latest?.key ?? null, target, style: w.ruleset!.options.style })
    })
  }

  /**
   * The target checked out in a folder (§16.9.2): conditions checked before anything is touched (else a pause), then
   * a journal: `IntegrationStarted`, phase files, read-tree, phase ref, update-ref, `Integrated`.
   */
  private async advanceCheckedOut(card: CardRecord, entry: QueueEntry, target: string, expected: string, result: string, folder: string): Promise<'done' | 'moved' | 'denied' | 'held' | { pause: PauseReason; files?: string[] }> {
    if (this.cfg.folderBusy?.(folder)) return { pause: 'folderBusy' }
    const b = await G.branch(folder)
    if (isUnknown(b) || b !== target) return { pause: 'wrongBranch' }
    const staged = await this.git(folder, ['diff', '--cached', '--quiet', expected])
    if (staged.code !== 0) return { pause: 'staged' }
    const changed = await this.git(this.project, ['diff', '--name-only', '-z', expected, result])
    if (!changed.ok) return { pause: 'needsYou' }
    const files = changed.out.split('\0').filter(Boolean)
    if (files.length) {
      const st = await this.git(folder, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...files])
      const busy = st.out.split('\0').filter(Boolean).map((l) => l.slice(3))
      if (!st.ok || busy.length) return { pause: 'unstagedChanges', files: busy }
    }
    const ref = await G.lineHead(this.project, target)
    if (ref !== expected) return 'moved'
    const started = await this.startAdvance(card, entry, { entry: entry.id, expected, result, files, checkedOut: folder })
    if (started === 'rulesOff') return { pause: 'rulesOff' }
    if (started === 'denied' || started === 'held') return started
    await this.cfg.hooks?.afterStarted?.(entry.id)
    await this.write(card, (w) => w.fact('IntegrationPhase', { entry: entry.id, phase: 'files' }))
    const rt = await this.git(folder, ['read-tree', '-m', '-u', expected, result])
    if (!rt.ok) {
      // git refused before writing: the files are as they were. The user's edit since the check pauses (named); anything
      // else is the target moving: back to the test merge.
      const st = await this.git(folder, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...files])
      const busy = st.out.split('\0').filter(Boolean).map((l) => l.slice(3))
      await this.moved(card, entry, target)
      if (busy.length) return { pause: 'unstagedChanges', files: busy }
      return 'moved'
    }
    await this.cfg.hooks?.afterFiles?.(entry.id)
    await this.write(card, (w) => w.fact('IntegrationPhase', { entry: entry.id, phase: 'ref' }))
    const u = await this.git(this.project, ['update-ref', `refs/heads/${target}`, result, expected])
    if (!u.ok) {
      await this.write(card, (w) => w.fact('IntegrationPhase', { entry: entry.id, phase: 'rollback' }))
      const back = await this.git(folder, ['read-tree', '-m', '-u', result, expected])
      if (!back.ok) return { pause: 'needsYou', files }
      await this.moved(card, entry, target)
      return 'moved'
    }
    await this.cfg.hooks?.afterAdvance?.(entry.id)
    return 'done'
  }

  /** `Integrated` → Done; the slot released, the lane ended if done; a decision recorded after the advance began → For you. */
  private async integrated(card: CardRecord, entry: QueueEntry, revision: string, target: string, result: string, method: 'merge' | 'squash', by: 'hive' | 'outside'): Promise<void> {
    await this.write(card, (w) => {
      // One Integrated per cycle, whoever writes it (the queue, or another Hive's recovery or observation).
      const st = w.state()
      if (st.integrated) return
      const startedAt = this.wf.store.facts(card.id).filter((f) => f.kind === 'IntegrationStarted' && (f.data as FactData['IntegrationStarted']).entry === entry.id).at(-1)?.seq ?? Infinity
      const f = w.tx.append(card.id, { kind: 'Integrated', actor: 'hive', source: 'recorded', dedupe: `cycle:${st.cycle}`, ...(w.ruleset ? { ruleset: w.ruleset.id } : {}), data: { entry: entry.id, revision, target, result, method, by } }) // i18n-ignore: a fact's kind and codes, not text
      w.written.push(f)
      w.move('done', 'derived')
      w.action('releaseSlot', {})
      w.action('endLaneIfDone', {})
      if (this.wf.store.facts(card.id).some((x) => x.kind === 'Decision' && x.seq > startedAt)) this.wf.askUser(w, 'decide', 'decision', workflowText(FOR_YOU.decidedAfterMerge, { card: card.key }))
    })
  }

  /** A conflict, red checks or a hook: `IntegrationFailed`, the card back to its builder with the output (§16.9.1 step 8). */
  private async returnCard(card: CardRecord, entry: QueueEntry, revision: string, target: string, reason: FactData['IntegrationFailed']['reason'], transient: boolean, files?: string[], log?: string, cause?: TransientFailure): Promise<QueueOutcome> {
    // Removed from the queue (or cancelled by a decision) while its test merge or checks ran: its cancellation stands,
    // the card where that left it (Approved), and the late failure isn't written.
    const wrote = await this.write(card, (w) => {
      if (!this.isOpen(w, entry)) return false
      // Why a transient failure was one, as codes (#1362): its cause, and the network error code that said so.
      const why = transient && cause ? { cause: cause.cause, ...(cause.code ? { code: cause.code } : {}) } : {}
      w.fact('IntegrationFailed', { entry: entry.id, revision, target, reason, transient, ...why, ...(files ? { files } : {}), ...(log ? { log: log.slice(0, 4000) } : {}) })
      w.move('active', 'derived')
      this.wf.wake(w, w.state().started?.builder, `${card.key} came back from the merge queue: ${reason}`) // i18n-ignore: a wake, agent-facing
      return true
    })
    if (!wrote) return { card: card.key, entry: entry.id, outcome: 'skipped', why: 'cancelled' } // i18n-ignore: a reason's key, not text
    return { card: card.key, entry: entry.id, outcome: 'returned', reason, transient }
  }

  /**
   * After a restart (§16.4.5): an entry with `IntegrationStarted` and no outcome is reconciled from the platform, never
   * assumed. Target not checked out: the ref at the result → `Integrated` (observed); at the expected revision → runs
   * again from the test merge; anywhere else → failed (target moved) and containment decides. Checked out: §16.9.2's
   * recovery table, whose last row pauses the queue for that target ("needs you").
   */
  /**
   * Recovers a target's entries (#1348: each target's host its own; every target's when none is given, the tests'). A
   * runner that lost its lease meanwhile stops, its recovery the next runner's.
   */
  async recover(target?: string): Promise<{ card: string; entry: string; outcome: 'integrated' | 'rerun' | 'failed' | 'needsYou' }[]> {
    return this.fenced(target ?? '', () => this.recoverAll(target)).catch((e) => lostIsNull(e) ?? [])
  }

  private async recoverAll(target?: string): Promise<{ card: string; entry: string; outcome: 'integrated' | 'rerun' | 'failed' | 'needsYou' }[]> {
    const out: { card: string; entry: string; outcome: 'integrated' | 'rerun' | 'failed' | 'needsYou' }[] = []
    for (const card of this.wf.store.cards()) {
      const s = this.wf.state(card)
      const e = openEntry(s)
      if (!e || e.state !== 'started' || !e.started || (target !== undefined && e.target !== target)) continue
      const { expected, result, checkedOut, files = [] } = e.started
      const ref = await G.lineHead(this.project, e.target)
      const done = async () => {
        await this.write(card, (w) => {
          const f = w.tx.appendObserved(card.id, { kind: 'Integrated', actor: 'outside', source: 'observed', dedupe: `cycle:${s.cycle}`, data: { entry: e.id, revision: e.revision, target: e.target, result, method: 'merge', by: 'hive' } }) // i18n-ignore: a fact's kind and codes, not text
          if (!f) return
          w.move('done', 'derived')
          w.action('releaseSlot', {})
          w.action('endLaneIfDone', {})
        })
        out.push({ card: card.key, entry: e.id, outcome: 'integrated' })
      }
      if (ref === result) {
        await done()
        continue
      }
      if (!checkedOut) {
        if (ref === expected) {
          this.rerun.add(e.id)
          out.push({ card: card.key, entry: e.id, outcome: 'rerun' })
        } else {
          // The target moved meanwhile: containment decides. Found → Done (observed); not found → tested again.
          await this.write(card, (w) => w.fact('IntegrationFailed', { entry: e.id, revision: e.revision, target: e.target, reason: 'targetMoved', transient: true })) // i18n-ignore: a fact's kind and codes, not text
          await reconcile(this.wf, card)
          if (this.wf.state(card).stage === 'merging') {
            await this.write(card, (w) => {
              const st = w.state()
              w.fact('IntegrationRequested', { entry: `${card.key}/e${st.lastSeq + 1}`, revision: e.revision, key: st.latest?.key ?? null, target: e.target, style: w.ruleset!.options.style })
            })
          }
          out.push({ card: card.key, entry: e.id, outcome: 'failed' })
        }
        continue
      }
      const found = await this.checkedOutState(e, ref)
      if (found === 'rerun') {
        this.rerun.add(e.id)
        out.push({ card: card.key, entry: e.id, outcome: 'rerun' })
      } else if (found === 'swap') {
        const u = await this.git(this.project, ['update-ref', `refs/heads/${e.target}`, result, expected])
        if (u.ok) await done()
        else {
          await this.pause(e.target, card, e, 'needsYou', files)
          out.push({ card: card.key, entry: e.id, outcome: 'needsYou' })
        }
      } else {
        await this.pause(e.target, card, e, 'needsYou', files)
        out.push({ card: card.key, entry: e.id, outcome: 'needsYou' })
      }
    }
    return out
  }

  /**
   * §16.9.2's recovery table for an advance begun into a checked-out target, the ref read as `ref`: run it again from
   * the test merge (`rerun`), finish its swap (`swap`), or the terminal state (`stuck`: needs you). Reads only.
   */
  private async checkedOutState(e: QueueEntry, ref: string | unknown): Promise<'rerun' | 'swap' | 'stuck'> {
    const { expected, result, checkedOut, files = [] } = e.started!
    if (!checkedOut) return 'stuck'
    const at = async (rev: string) => files.length === 0 || ((await this.git(checkedOut, ['diff', '--cached', '--quiet', rev, '--', ...files])).code === 0 && (await this.git(checkedOut, ['diff', '--quiet', '--', ...files])).code === 0)
    const phase = e.phases.at(-1)
    const branchOk = (await G.branch(checkedOut)) === e.target
    if (branchOk && ref === expected && phase !== 'rollback' && (await at(expected))) return 'rerun'
    if (branchOk && ref === expected && (phase === 'files' || phase === 'ref') && (await at(result))) return 'swap'
    if (phase === 'rollback' && (await at(expected))) return 'rerun'
    return 'stuck'
  }

  /**
   * Resume of a needs-you pause (#1353, §16.9.3): whether the target's begun advance is still in §16.9.2's terminal state,
   * as recovery would find it now (the files it names, or [] for none), or null when recovery can carry on. Reads only.
   */
  async stillStuck(target: string): Promise<string[] | null> {
    for (const card of this.wf.store.cards()) {
      const e = openEntry(this.wf.state(card))
      if (!e || e.state !== 'started' || !e.started || e.target !== target || !e.started.checkedOut) continue
      const ref = await G.lineHead(this.project, target)
      if (ref === e.started.result) return null
      return (await this.checkedOutState(e, ref)) === 'stuck' ? (e.started.files ?? []) : null
    }
    return null
  }
}
