// jj's bounded runner (SPEC §16.3.6 port 1, HI-2793's J0): finds the standalone jj, checks its version against the
// pinned one (resources/tested-vcs.json), and runs its commands off main's thread with an output cap, a time limit and
// cancellation. Reads by default: every command runs with `--ignore-working-copy` (R5.3: no snapshot) unless a caller
// asks to write, and J0 has no writer. Not registered as a platform (repoPorts.ts): nothing in Combwork runs jj yet but
// Copy Diagnostics' row and detection's tests. Git's runner is untouched (§16.3.6: a later platform adds its own).

import { existsSync } from 'original-fs'
import { stat } from 'original-fs/promises'
import { delimiter, dirname, join, resolve } from 'path'
import { SHARE_ENV, Worker } from 'worker_threads'
import { jjRunnable, jjToolOf, parseJjVersion, TESTED_JJ, type JjTool } from '../../shared/jjTool'
import { createLogger, userText } from '../logger'
import { bundledScriptExists, workerHere, workerStarted } from '../workerThreads'
import { runJj, type JjOutcome, type JjRequest } from './jjProcess'
import type { RunOptions, RunResult } from './repoContext'
import type { JjWorkerMessage, JjWorkerReply } from './jjWorker'
import type { OpPreviewInput } from './jjOpView'
import type { PrintSources } from './jjSourcesPrint'
import { previewTask, printTask, type OpFence, type OpPreviewAnswer } from './jjPreviewTask'

const log = createLogger('jj')

/**
 * The editor jj is given: a program that isn't there, so a command that would open an editor fails at once rather than
 * waiting for a window no one sees. Combwork never edits jj's own config (a CLI's config is the user's): it overrides
 * it per command (`--config`, which wins over the user's, the repository's and the workspace's, jj 0.47.1's config.md).
 */
export const JJ_NO_EDITOR = 'combwork-no-editor'

/**
 * What every jj command starts with, whatever the user's or the repository's config says: no pager, no colour, no
 * editor of any kind (`ui.editor`, `ui.diff-editor`, `ui.merge-editor`), no filesystem monitor (`fsmonitor.backend`,
 * which can register watchman triggers).
 */
export const JJ_PREFIX = [
  '--no-pager',
  '--color=never',
  `--config=ui.editor="${JJ_NO_EDITOR}"`,
  `--config=ui.diff-editor="${JJ_NO_EDITOR}"`,
  `--config=ui.merge-editor="${JJ_NO_EDITOR}"`,
  '--config=fsmonitor.backend="none"'
] as const

/**
 * What a read adds (R5.3): no snapshot of the working copy (`--ignore-working-copy`: the files are never recorded as a
 * new commit, and a stale workspace is never brought up to date), and, should a read reach the working copy, no
 * automatic stale update (`snapshot.auto-update-stale`).
 */
export const JJ_READ = ['--ignore-working-copy', '--config=snapshot.auto-update-stale=false'] as const

/** A command's bounds, unset: 16 MB of output (git()'s), a minute. */
export const JJ_DEFAULTS = { maxOutput: 16 * 1024 * 1024, timeout: 60_000, versionTimeout: 10_000 }

/** A jj command's options: port 1's, plus cancellation and whether it may write. */
export interface JjRunOptions extends RunOptions {
  signal?: AbortSignal
  /** It may change the repository: run without `--ignore-working-copy`. No J0 caller writes. */
  write?: boolean
  /**
   * A read whose answer names no file (ids, names, flags, absolute roots): run from outside its folder (readAt, HI-2912).
   * Never for one that prints a file's path, which jj gives relative to its working folder. Ignored for a write.
   */
  away?: boolean
}

/** What a jj command answered: port 1's RunResult, plus whether it was cancelled. Never an answer when `code` is -1. */
export interface JjRunResult extends RunResult {
  cancelled?: true
}

/**
 * Where an `away` read runs (HI-2912): from the parent of its folder's workspace root, that root given as
 * `--repository` (which, unlike a working folder, jj doesn't search upward from), so the read never holds the folder as
 * its working folder. On Windows a process's working folder (or one inside it) can't be renamed, and a slot's quiet
 * probe (slots.ts `quiet`) renames the slot's folder: the reads polled in a slot (its listing's staleness, every 200 ms
 * in jjwindow) kept it "in use" most of the time under load (probed with jj 0.47.1, two reads at a time: 76 of 84 probes
 * in use, none from outside). Null when the folder isn't there (such a read doesn't run, as when it ran in it). Writes,
 * and reads that print paths, stay in their folder: only its slot's operation writes there, and a write's working folder
 * keeps a probe from renaming the folder while it goes on.
 */
export async function readAt(folder: string): Promise<{ cwd: string; args: string[] } | null> {
  const at = resolve(folder)
  if (!(await isDir(at))) return null
  let root = at
  for (let d = at; ; d = dirname(d)) {
    if (await isDir(join(d, '.jj'))) {
      root = d
      break
    }
    if (dirname(d) === d) break
  }
  return { cwd: dirname(root), args: ['--repository', root] }
}

const isDir = (folder: string): Promise<boolean> => stat(folder).then((s) => s.isDirectory(), () => false)

export interface JjRunner {
  /**
   * Runs jj in `folder` (an `away` read: on it, from outside, readAt) with `args`, prefixed (JJ_PREFIX, and JJ_READ unless
   * `write`). Runs the pinned jj or a newer (untested) one, whose answers its callers don't trust (jjSupported); never
   * one missing or too old.
   */
  run(folder: string, args: readonly string[], o?: JjRunOptions): Promise<JjRunResult>
  /** Checks the tool again (`jj --version`), one check at a time. */
  readiness(): Promise<JjTool>
  /** The tool as last checked, without checking. */
  readinessNow(): JjTool
  /** What to say when jj can't run (missing, too old, not checked), in English; null when it runs. */
  problem(): string | null
  /** Ends every command under way (each one's process tree) and jj's worker, within `ms`: Combwork quitting. */
  shutdown(ms?: number): Promise<void>
  /** An operation's final answer off main's thread, on jj's worker (HI-2800): the preview, then the print against `fence`. */
  preview?(input: OpPreviewInput, fence: OpFence): Promise<OpPreviewAnswer>
  /** One print of an operation preview's sources off main's thread, on jj's worker (HI-2800): its hash, `over` a bound, null unreadable. */
  print?(sources: PrintSources): Promise<string | 'over' | null>
}

/** The jj Windows starts for `jj` on this PATH (jj.exe in each folder, in order), or null. */
export function jjOnPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.PATH ?? env.Path ?? ''
  for (const d of path.split(delimiter)) {
    if (!d) continue
    const f = join(d.replace(/^"|"$/g, ''), 'jj.exe')
    if (existsSync(f)) return f
  }
  return null
}

/** The environment a jj command gets: Combwork's (or the one given), with no editor and no credential prompts. */
export function jjEnv(base: NodeJS.ProcessEnv, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, ...extra, JJ_EDITOR: JJ_NO_EDITOR, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' }
}

/** A command's outcome as port 1's result: anything but jj's own exit is code -1 and never an answer (rule 3). */
export function resultOf(o: JjOutcome, what: string): JjRunResult {
  const buf = Buffer.from(o.stdout.buffer, o.stdout.byteOffset, o.stdout.byteLength)
  const stderr = Buffer.from(o.stderr.buffer, o.stderr.byteOffset, o.stderr.byteLength).toString('utf8').trim()
  if ('exit' in o.end) return { out: buf.toString('utf8'), ok: o.end.exit === 0, buf, err: stderr, code: o.end.exit }
  const why = o.end.notRun
  const said = stderr || `jj ${what} didn't run to an exit (${why}${o.end.detail ? `: ${o.end.detail}` : ''})` // i18n-ignore: jj's side of an error, in English as jj's messages are
  return {
    out: buf.toString('utf8'),
    ok: false,
    buf,
    err: said,
    code: -1,
    ...(why === 'missing' ? { missing: true } : { notRun: why }),
    ...(why === 'timedOut' ? { timedOut: true } : {}),
    ...(why === 'cancelled' ? { cancelled: true as const } : {})
  }
}

/** A result for a command that never started because the tool can't run (missing or too old). */
const refused = (t: JjTool, what: string): JjRunResult => ({
  out: '',
  ok: false,
  buf: Buffer.alloc(0),
  err: problemOf(t) ?? `jj ${what} didn't run`, // i18n-ignore: for the log and the caller's message
  code: -1,
  ...(t.state === 'missing' ? { missing: true } : { notRun: t.state === 'old' ? 'old' : 'unknown' })
})

/**
 * What to tell the user when jj can't run, in English; null when it runs. J0's callers are the log, Copy Diagnostics and
 * detection's unknown reasons: the J card that shows them to agents or the window makes them agent or window messages.
 */
export function problemOf(t: JjTool): string | null {
  // log: the log's and Copy Diagnostics' English (problemOf's comment)
  if (t.state === 'missing') return "Jujutsu (jj) isn't installed (or isn't on Combwork's PATH)" // i18n-ignore: the log's English
  // log: the log's and Copy Diagnostics' English (problemOf's comment)
  if (t.state === 'old') return `Jujutsu ${t.version} is older than Combwork is tested with (${TESTED_JJ.version})` // i18n-ignore: the log's English
  // log: the log's and Copy Diagnostics' English (problemOf's comment)
  if (t.state === 'unknown') return `Couldn't check Jujutsu${t.error ? `: ${t.error}` : ''}` // i18n-ignore: the log's English
  return null
}

/** Where jj's commands run: its worker thread, started with the first; here where there is no built script (unit tests). */
class JjThread {
  private worker: Worker | null = null
  private calls = new Map<number, (r: JjOutcome | null) => void>()
  private previews = new Map<number, (r: OpPreviewAnswer | null) => void>()
  private prints = new Map<number, (r: string | 'over' | null | undefined) => void>()
  private next = 0
  private lost = ''

  constructor(private readonly script: () => string) {}

  run(m: JjRequest, signal?: AbortSignal): Promise<JjOutcome> {
    const w = this.ensure()
    if (!w) return runJj(m, signal)
    const id = ++this.next
    return new Promise((done) => {
      const cancel = (): void => w.postMessage({ id, cancel: true } satisfies JjWorkerMessage, [])
      signal?.addEventListener('abort', cancel, { once: true })
      this.calls.set(id, (r) => {
        signal?.removeEventListener('abort', cancel)
        done(r ?? { stdout: new Uint8Array(), stderr: Buffer.from(`Combwork's jj worker ended (${this.lost})`), end: { notRun: 'failed', detail: 'ERR_JJ_WORKER' } }) // i18n-ignore: for the log and the caller's message
      })
      w.postMessage({ id, run: m } satisfies JjWorkerMessage, [])
      if (signal?.aborted) cancel()
    })
  }

  /** An operation's final answer worked out on the worker (HI-2800): the preview, then its fence; here where there is no built script (unit tests). */
  preview(input: OpPreviewInput, fence: OpFence): Promise<OpPreviewAnswer> {
    const w = this.ensure()
    if (!w) return Promise.resolve(previewTask(input, fence))
    const id = ++this.next
    return new Promise((done, fail) => {
      this.previews.set(id, (r) => (r ? done(r) : fail(new Error(`Combwork's jj worker ended (${this.lost})`)))) // i18n-ignore: for the log
      w.postMessage({ id, preview: input, fence } satisfies JjWorkerMessage, [])
    })
  }

  /** One print of an operation preview's sources on the worker (HI-2800): its hash, `over` a bound, null unreadable; here without a worker. */
  print(sources: PrintSources): Promise<string | 'over' | null> {
    const w = this.ensure()
    if (!w) return Promise.resolve(printTask(sources) ?? null)
    const id = ++this.next
    return new Promise((done, fail) => {
      this.prints.set(id, (r) => (r === undefined ? fail(new Error(`Combwork's jj worker ended (${this.lost})`)) : done(r))) // i18n-ignore: for the log
      w.postMessage({ id, print: sources } satisfies JjWorkerMessage, [])
    })
  }

  private ensure(): Worker | null {
    if (this.worker) return this.worker
    const script = this.script()
    if (!bundledScriptExists(script)) {
      workerHere('jj', "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
      return null
    }
    const w = new Worker(script, { env: SHARE_ENV })
    this.worker = w
    workerStarted('jj', w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    w.on('message', (r: JjWorkerReply) => {
      if ('preview' in r) {
        const p = this.previews.get(r.id)
        this.previews.delete(r.id)
        p?.(r.preview)
        return
      }
      if ('print' in r) {
        const p = this.prints.get(r.id)
        this.prints.delete(r.id)
        p?.(r.print)
        return
      }
      const c = this.calls.get(r.id)
      this.calls.delete(r.id)
      c?.(r.outcome)
    })
    const gone = (why: string): void => {
      if (this.worker !== w) return
      this.worker = null
      log.warn(`jj's worker ended (${why}); it starts again with the next command`)
      this.lost = why
      for (const c of this.calls.values()) c(null)
      this.calls.clear()
      for (const p of this.previews.values()) p(null)
      this.previews.clear()
      for (const p of this.prints.values()) p(undefined)
      this.prints.clear()
    }
    w.on('error', (e: Error) => gone(e.message))
    w.on('exit', (code) => gone(`exit code ${code}`)) // i18n-ignore: for the log
    w.unref()
    return w
  }

  /** Ends the worker (its commands were ended first: the runner's shutdown); the next command starts another. */
  async stop(): Promise<void> {
    const w = this.worker
    if (!w) return
    this.worker = null
    this.lost = 'stopped'
    await w.terminate()
    for (const c of this.calls.values()) c(null)
    this.calls.clear()
    for (const p of this.previews.values()) p(null)
    this.previews.clear()
    for (const p of this.prints.values()) p(undefined)
    this.prints.clear()
  }
}

/** The worker's script, beside main's (as git-worker.js is). */
const jjWorkerScript = (): string => join(__dirname, 'jj-worker.js')
const thread = new JjThread(jjWorkerScript)

/**
 * A jj runner. `exe`: this jj (the real-jj fixtures' portable one), else the one on the environment's PATH, found again
 * at each check. `env`: the environment it runs in (tests isolate jj's config and home), else Combwork's. `here`: run
 * on this thread rather than jj's worker (tests); `worker`: a test's build of jj's worker. `before`: arguments before jj's own (tests: a fake jj, a script node runs).
 * `versionTimeout`: the check's time limit (tests).
 */
export function createJjRunner(o: { exe?: string; env?: NodeJS.ProcessEnv; here?: boolean; before?: readonly string[]; worker?: string; versionTimeout?: number } = {}): JjRunner {
  let current: JjTool = { state: 'unknown' }
  let checking: Promise<JjTool> | null = null
  const base = (): NodeJS.ProcessEnv => o.env ?? process.env
  const ownThread = o.worker ? new JjThread(() => o.worker!) : thread
  const exec = (m: JjRequest, signal?: AbortSignal): Promise<JjOutcome> => (o.here ? runJj(m, signal) : ownThread.run(m, signal))

  // Everything of this runner's under way, each with its own cancel and its end: every run from its first step
  // (readiness included) and every check, so shutdown owns all of it and nothing starts after it (HR2, HI-2793 round 1).
  const running = new Set<{ ac: AbortController; ended: Promise<unknown> }>()
  let closed = false
  const own = <T>(ac: AbortController, work: Promise<T>): Promise<T> => {
    const entry = { ac, ended: work }
    running.add(entry)
    return work.finally(() => running.delete(entry))
  }
  /** A result for a command that never started because the runner was shut down, or its run was cancelled first. */
  const stopped = (what: string, why: 'failed' | 'cancelled'): JjRunResult => resultOf({ stdout: new Uint8Array(), stderr: new Uint8Array(), end: why === 'failed' ? { notRun: 'failed', detail: 'shut down' } : { notRun: 'cancelled' } }, what) // i18n-ignore: a protocol detail, for the log

  const readiness = (): Promise<JjTool> => {
    // Shut down: no check starts; the tool as last checked.
    if (closed) return Promise.resolve(current)
    checking ??= (async (): Promise<JjTool> => {
      const exe = o.exe ?? jjOnPath(base()) ?? undefined
      if (!exe) return { state: 'missing' }
      const ac = new AbortController()
      const r = resultOf(await own(ac, exec({ exe, cwd: process.cwd(), args: [...(o.before ?? []), '--version'], env: jjEnv(base()), maxOutput: 64 * 1024, timeout: o.versionTimeout ?? JJ_DEFAULTS.versionTimeout }, ac.signal)), '--version')
      // Only jj's own successful exit is an answer (rule 3): a version printed by a run that failed, timed out, was
      // capped or cancelled is never taken for the tool's.
      const version = r.ok ? parseJjVersion(r.out) : null
      if (version) return jjToolOf(version, exe)
      if (r.missing) return { state: 'missing' }
      return { state: 'unknown', path: exe, error: r.timedOut ? 'jj --version took too long' : r.ok ? `jj --version said "${r.out.trim().slice(0, 80)}"` : r.err.split(/\r?\n/)[0] || `exit code ${r.code}` } // i18n-ignore: jj's own answer, for the log and Copy Diagnostics
    })()
      .then((next) => {
        if (next.state !== current.state || next.version !== current.version || next.path !== current.path) {
          if (next.state === 'ok') log.info(`Jujutsu ${next.version} at ${userText(next.path ?? '?')}`)
          else if (next.state === 'untested') log.warn(`Jujutsu ${next.version} at ${userText(next.path ?? '?')} is newer than the tested ${TESTED_JJ.version}: untested, so nothing it says is trusted`)
          else log.warn(problemOf(next) ?? 'Jujutsu: unknown') // i18n-ignore: for the log
        }
        current = next
        return next
      })
      .finally(() => {
        checking = null
      })
    return checking
  }

  return {
    readiness,
    readinessNow: () => current,
    problem: () => problemOf(current),
    preview: (input, fence) => (o.here ? Promise.resolve(previewTask(input, fence)) : ownThread.preview(input, fence)),
    print: (sources) => (o.here ? Promise.resolve(printTask(sources) ?? null) : ownThread.print(sources)),
    async shutdown(ms = 5000) {
      closed = true
      for (const r of running) r.ac.abort()
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([Promise.allSettled([...running].map((r) => r.ended)), new Promise((res) => (timer = setTimeout(res, ms)))])
      clearTimeout(timer)
      await ownThread.stop()
    },
    run(folder, args, opts = {}) {
      const what = args[0] ?? ''
      if (closed) return Promise.resolve(stopped(what, 'failed'))
      // The run's own cancel, from its first step: its caller's signal, or shutdown.
      const ac = new AbortController()
      const cancel = (): void => ac.abort()
      opts.signal?.addEventListener('abort', cancel, { once: true })
      if (opts.signal?.aborted) ac.abort()
      const work = (async (): Promise<JjRunResult> => {
        // Not usable as last checked (never checked, missing, an answer it couldn't read): checked again first, so one
        // installed since runs. A jj too old stays refused until Check again (no `--version` before every command).
        const t = jjRunnable(current) || current.state === 'old' ? current : await readiness()
        // Shut down or cancelled while it waited: nothing starts.
        if (closed) return stopped(what, 'failed')
        if (ac.signal.aborted) return stopped(what, 'cancelled')
        if (!jjRunnable(t) || !t.path) return refused(t, what)
        // An away read on a folder that isn't there doesn't run, as when it ran in it (Node: ENOENT for a missing working
        // folder).
        const away = opts.away && !opts.write ? await readAt(folder) : null
        if (opts.away && !opts.write && !away) return resultOf({ stdout: new Uint8Array(), stderr: new Uint8Array(), end: { notRun: 'failed', detail: 'ENOENT' } }, what) // i18n-ignore: a protocol detail, for the log
        const full = [...(o.before ?? []), ...JJ_PREFIX, ...(opts.write ? [] : JJ_READ), ...(away ? away.args : []), ...args]
        const r = resultOf(await exec({ exe: t.path, cwd: away ? away.cwd : folder, args: full, env: jjEnv(base(), opts.env), maxOutput: opts.maxOutput ?? JJ_DEFAULTS.maxOutput, timeout: opts.timeout ?? JJ_DEFAULTS.timeout, ...(opts.input !== undefined ? { input: opts.input } : {}) }, ac.signal), what)
        // The tool went (uninstalled, moved): checked again, so the next command and Copy Diagnostics say so.
        if (r.missing) void readiness()
        return r
      })()
      return own(ac, work).finally(() => opts.signal?.removeEventListener('abort', cancel))
    }
  }
}

/** Combwork's jj: the one on its PATH. Checked only when something asks (detection of a .jj, Copy Diagnostics). */
export const jjRunner: JjRunner = createJjRunner()
