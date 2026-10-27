// Codex's app server, asked one thing by Hive (HI-1757: a connection's sign-in check, a launch's hook check), owned from
// before it runs until its end is confirmed, with the merge queue's machinery as it is (#1360: workflow/queueJobs.ts and
// workflow/launcher.ts, on Hive's process supervisor): a named, kill-on-close job, opened with no journal; a launcher put
// in it before it is told to run Codex; the job ended and seen empty by the same supervisor that opened it (its instance
// and the job by name, asked again across every await). Kill on close is the guarantee: if Hive or its supervisor ends,
// Windows ends the job's members. With no journal nothing is ever followed outside the job: a process that escapes it is
// ended by the supervisor at once ("unowned"), unconfirmed, so a check that sees one fails and its connection stays held
// until Hive restarts. The restart releases that hold without confirming the escaped branch ended: a known limit,
// accepted as a preview limit (the Assistant's answer to HI-1757/r94; the durable recovery is HI-1811, on hold).
//
// A failed or unconfirmed end is a failed check, never the answer the server gave, and holds the connection: no other
// check, sign-in or removal of it, until a later check confirms the old end (in memory only: a restart releases it).

import { randomBytes } from 'crypto'
import { basename } from 'path'
import type { ChildProcess } from 'child_process'
import { processSupervisor } from './agentProcesses'
import { advanced } from './advanced'
import { createLogger, userText } from './logger'
import type { JobHost } from './processSupervisor'
import { LeaseJob, leaseJobGone } from './workflow/queueJobs'
import { startLauncher } from './workflow/launcher'

const log = createLogger('codex')

/** A request's answer: its result, or why there is none (a failed check). */
export type CheckAnswer = { ok: true; result: any } | { ok: false; error: string }

/** How long a launcher gets to close once its job has ended (or Hive gave it up). */
const END_MS = 10_000
const QUITTING: CheckAnswer = { ok: false, error: 'Hive is quitting' } // i18n-ignore: for the log
const ESCAPED: CheckAnswer = { ok: false, error: "a process Codex started left Hive's job: its end can't be confirmed" } // i18n-ignore: for the log

/** Tests only: another supervisor, and steps to hold a check at (before it starts, after its launcher joins, before its end's confirmation, each end). */
export const codexCheckSeams: { host?: JobHost; beforeStart?: () => Promise<void>; afterAssign?: (job: LeaseJob) => Promise<void>; beforeConfirm?: () => Promise<void>; onEnd?: (phase: 'in' | 'out') => void } = {}

const host = (): JobHost => codexCheckSeams.host ?? processSupervisor()

/** A check: its connection (the key), its job's name, and while it is Hive's, the job and its supervisor's instance. */
interface Check {
  key: string
  name: string
  job: LeaseJob | null
  instance: number | null
  /** The launcher, until it has closed. */
  child: ChildProcess | null
  closed: boolean
  /** A process of it the supervisor found outside its job and ended unconfirmed: its pid (held until Hive restarts). */
  escaped: number | null
  /** Its work in turn (serial): its end, a later check's retry, the quit's. */
  work: Promise<void>
}

/** Connections (keys) with a check under way. */
const running = new Set<string>()
/** Checks not confirmed ended, by connection: held. */
const held = new Map<string, Check>()
/** The checks under way, owned by the quit from their reservation (stopCodexChecks awaits them). */
const live = new Set<Promise<unknown>>()
/** Each running check's wait for its answer, cut short at quit. */
const aborts = new Set<() => void>()
let stopped = false

/** A home's key: a connection's folder by its id (its name in the accounts folder), else the folder itself. */
const keyOf = (home: string | undefined): string => (home ? basename(home).toLowerCase() : '~')
const nameFor = (key: string): string => `HiveCheck-${key.replace(/[^a-z0-9-]/gi, '_')}-${randomBytes(6).toString('hex')}`

/** Whether a connection's folder is held: a check of it under way, or one not confirmed ended (HI-1757). */
export function codexCheckHeld(home: string): boolean {
  const k = keyOf(home)
  return running.has(k) || held.has(k)
}

/**
 * One request to Codex's app server (`command`/`args` as spawned, `env` the connection's): owned from before it runs to
 * its confirmed end. Its connection reserved before anything is awaited; one held by an earlier check gets that check's
 * end tried again first (refused if it still can't be confirmed, or a process of it escaped).
 */
export function ownedAppServerRequest(o: Request): Promise<CheckAnswer> {
  const key = keyOf(o.env.CODEX_HOME)
  if (stopped) return Promise.resolve(QUITTING)
  if (running.has(key)) return Promise.resolve({ ok: false, error: 'a check of this connection is already running' }) // i18n-ignore: for the log
  running.add(key)
  const run = (async (): Promise<CheckAnswer> => {
    try {
      const old = held.get(key)
      if (old) {
        if (old.escaped !== null) return ESCAPED
        if (!(await serial(old, () => endCheck(old)))) return { ok: false, error: "its last check of Codex hasn't ended yet" } // i18n-ignore: for the log
        held.delete(key)
        log.info(`Codex's earlier check of ${userText(key)} has ended: the connection is no longer held`)
      }
      if (stopped) return QUITTING
      return await runCheck({ key, name: nameFor(key), job: null, instance: null, child: null, closed: true, escaped: null, work: Promise.resolve() }, o)
    } finally {
      running.delete(key)
    }
  })()
  live.add(run)
  void run.finally(() => live.delete(run))
  return run
}

type Request = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; method: string; params: unknown; timeoutMs: number }

/** A reserved check, run to its end: each step looks first whether Hive is quitting, before anything starts. */
async function runCheck(c: Check, o: Request): Promise<CheckAnswer> {
  let answer: CheckAnswer = { ok: false, error: "Codex's check didn't run" } // i18n-ignore: for the log
  let unwatch: (() => void) | null = null
  try {
    await codexCheckSeams.beforeStart?.()
    if (stopped) return QUITTING
    const h = host()
    if (!(await h.ensure())) return { ok: false, error: "Hive can't own Codex's check here (its process tracking is off)" } // i18n-ignore: for the log
    if (stopped) return QUITTING
    // A process of the check found outside its job: ended by the supervisor, unconfirmed (no journal to follow it by).
    unwatch = h.onUnowned((job, pid) => {
      if (job !== c.name) return
      c.escaped ??= pid
      log.warn(`Codex's check of ${userText(c.key)}: process ${pid} left its job and was ended unconfirmed: the connection is held until Hive restarts`)
    })
    const job = await LeaseJob.open(h, c.name, '')
    if ('problem' in job) return { ok: false, error: `its job couldn't be made: ${job.problem}` } // i18n-ignore: for the log
    c.job = job
    c.instance = h.instance
    // Quitting meanwhile: its job (empty) is ended below, nothing started in it.
    answer = stopped ? QUITTING : await askThroughLauncher(c, o)
  } catch (e) {
    answer = { ok: false, error: String((e as Error)?.message ?? e) }
  } finally {
    if (c.job || c.child) {
      const gone = await serial(c, () => endCheck(c))
      if (c.escaped !== null) {
        answer = ESCAPED
        held.set(c.key, c)
      } else if (!gone) {
        answer = { ok: false, error: "couldn't end Codex's check" } // i18n-ignore: for the log
        held.set(c.key, c)
        log.warn(`Codex's check of ${userText(c.key)} isn't confirmed ended: that connection is held until a later check confirms it`)
      }
    }
    unwatch?.()
  }
  return answer
}

/** Runs one piece of a check's work after the one before it ends (its end, a retry, the quit's): never two at once. */
function serial<T>(c: Check, fn: () => Promise<T>): Promise<T> {
  const next = c.work.then(fn, fn)
  c.work = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

/** Starts the launcher, puts it in the job, then runs Codex through it and asks it the one request. */
async function askThroughLauncher(c: Check, o: Request): Promise<CheckAnswer> {
  if (stopped) return QUITTING
  const { child, after, before } = startLauncher({ command: o.command, args: o.args }, { cwd: o.cwd, env: o.env })
  c.child = child
  c.closed = false
  child.once('close', () => (c.closed = true))
  let startError: Error | null = null
  child.on('error', (e) => (startError ??= e))
  for (const s of [child.stdin, child.stdout, child.stderr]) s?.on('error', () => undefined)
  child.stderr?.resume()
  const assigned = !!child.pid && (await c.job!.assign(child.pid, after, before))
  if (!assigned || startError) return { ok: false, error: startError ? `it didn't start: ${(startError as Error).message}` : "its launcher couldn't be put in its job" } // i18n-ignore: for the log
  await codexCheckSeams.afterAssign?.(c.job!)
  // Never told to run once Hive is quitting: its stdin ended at its end, it ends having run nothing.
  if (stopped) return QUITTING
  return new Promise<CheckAnswer>((resolveP) => {
    let buf = ''
    let over = false
    const done = (v: CheckAnswer): void => {
      if (over) return
      over = true
      clearTimeout(timer)
      aborts.delete(abort)
      resolveP(v)
    }
    // Quitting cuts the wait short; its end is the check's own (runCheck's finally).
    const abort = (): void => done(QUITTING)
    aborts.add(abort)
    const timer = setTimeout(() => done({ ok: false, error: `no answer in ${Math.round(o.timeoutMs / 1000)} s` }), o.timeoutMs) // i18n-ignore: for the log
    child.once('close', (code) => done({ ok: false, error: `it ended (exit ${code})` })) // i18n-ignore: for the log
    const send = (m: unknown): void => void child.stdin!.write(JSON.stringify(m) + '\n')
    child.stdout!.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m: any
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method: o.method, params: o.params })
        } else if (m.id === 2) done(m.error ? { ok: false, error: String(m.error?.message ?? 'an error') } : { ok: true, result: m.result ?? null }) // i18n-ignore: for the log
      }
    })
    // Told to run Codex only now (the launcher's go-ahead), then its first request.
    child.stdin!.write('go\n') // i18n-ignore: the launcher's go-ahead (queueJobs.ts), not text
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'hive', version: '1' } } })
  })
}

/** Resolves once the launcher has closed, or after `ms`: whether it closed. */
function launcherClosed(c: Check, ms: number): Promise<boolean> {
  if (!c.child || c.closed) return Promise.resolve(true)
  return new Promise((resolveP) => {
    const t = setTimeout(() => resolveP(c.closed), ms)
    c.child!.once('close', () => (clearTimeout(t), resolveP(true)))
  })
}

/**
 * Ends a check and confirms it: its stdin ended (Codex ends itself), then its job ended and seen empty by the supervisor
 * instance that opened it, the job still that supervisor's by its name (`exists`), and the launcher closed; then the job
 * let go. Else, once its job is let go or its supervisor has gone, confirmed only when no job by its name is left (kill
 * on close ended its members) and its launcher has closed. True only then.
 */
async function endCheck(c: Check): Promise<boolean> {
  codexCheckSeams.onEnd?.('in')
  try {
    try {
      c.child?.stdin?.end()
    } catch {
      // Already closed.
    }
    await launcherClosed(c, advanced.number('codex.appServer.closeSeconds') * 1000)
    const h = host()
    if (c.job && c.instance !== null && h.instance === c.instance) {
      const ended = await c.job.end()
      await codexCheckSeams.beforeConfirm?.()
      const ours = h.instance === c.instance && (await h.request('hasjob', c.name)) === 'exists' && h.instance === c.instance
      if (ended && ours && (await launcherClosed(c, END_MS))) {
        await c.job.close()
        c.job = null
        return true
      }
    }
    // Not confirmed by its own supervisor: let its job go if it is still this check's (closing it ends what is in it),
    // end a launcher that never joined it, and confirm no job by its name is left.
    if (c.job) {
      await c.job.close().catch(() => undefined)
      c.job = null
    }
    if (c.child && !c.closed) {
      c.child.kill()
      if (!(await launcherClosed(c, END_MS))) return false
    }
    if (!(await h.ensure())) return false
    return await leaseJobGone(h, c.name)
  } finally {
    codexCheckSeams.onEnd?.('out')
  }
}

/**
 * At quit (HI-1757): nothing starts from here (each step of a check under way looks first, its wait for an answer cut
 * short); the checks under way are awaited to their own end, then each held check's end is tried once more after
 * whatever of its work is under way (serial), bounded. What is left is ended by its job's close as Hive exits.
 */
export async function stopCodexChecks(): Promise<void> {
  stopped = true
  for (const abort of [...aborts]) abort()
  const ms = advanced.number('codex.appServer.closeSeconds') * 1000 + 15_000
  const bounded = (p: Promise<unknown>): Promise<unknown> => Promise.race([p, new Promise((res) => setTimeout(res, ms))])
  await bounded(Promise.allSettled([...live]))
  await bounded(Promise.allSettled([...held.values()].filter((c) => c.escaped === null).map((c) => serial(c, () => endCheck(c)).then((gone) => gone && held.get(c.key) === c && held.delete(c.key)))))
}

/** Tests only: forgets what this file keeps (holds, the quit) as a new Hive would start. */
export function resetCodexChecksForTests(): void {
  held.clear()
  running.clear()
  live.clear()
  aborts.clear()
  stopped = false
}
