// Codex's app server, asked one thing by Hive (HI-1757: a connection's sign-in check, a launch's hook check), owned from
// before it runs until it is confirmed gone, with the merge queue's machinery as it is (#1360: workflow/queueJobs.ts and
// workflow/launcher.ts, on Hive's process supervisor): a named, kill-on-close job with its journal; a launcher put in it
// before it is told to run Codex; the job ended and seen empty by the same supervisor that opened it (its instance and
// the job by name, asked again across every await), else recovered as a takeover recovers a lease (the job gone by name,
// its sealed journal read, what it names ended exactly and confirmed gone). Until then the check's connection is held:
// no other check, sign-in or removal of it, across a restart too (a marker per check, written before its job).
//
// A failed end is a failed check, never the answer the server gave (HR6's round 2 finding 1, the Assistant's design call).

import { randomBytes } from 'crypto'
import { app } from 'electron'
import { basename, join } from 'path'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'original-fs/promises'
import type { ChildProcess } from 'child_process'
import { processSupervisor } from './agentProcesses'
import { advanced } from './advanced'
import { createLogger, userText } from './logger'
import type { JobHost } from './processSupervisor'
import { LeaseJob, clearJournal, endLeaseJob, journalOf, journalPath, leaseJobGone, retireSeal, sealJournal } from './workflow/queueJobs'
import { startLauncher } from './workflow/launcher'
import { defaultProbe, endJournalled, type ProcessProbe } from './workflow/queueProcs'

const log = createLogger('codex')

/** A request's answer: its result, or why there is none (a failed check). */
export type CheckAnswer = { ok: true; result: any } | { ok: false; error: string }

/** How long a launcher Hive gave up gets to close, and a journal's processes to be seen gone. */
const END_MS = 10_000
/** How soon a held check is tried again: every 5 s for its first minute, then every 30 s. */
const RETRY_FIRST_MS = 5_000
const RETRY_LATER_MS = 30_000

/** Tests only: another supervisor, folder or probe, and a step between the end and its confirmation. */
export const codexCheckSeams: { host?: JobHost; root?: string; probe?: ProcessProbe; afterAssign?: (job: LeaseJob) => Promise<void>; beforeConfirm?: () => Promise<void> } = {}

const host = (): JobHost => codexCheckSeams.host ?? processSupervisor()
const probe = (): ProcessProbe => codexCheckSeams.probe ?? defaultProbe()
/** The checks' markers and journals, in Hive's profile. */
const root = (): string => codexCheckSeams.root ?? join(process.env.HIVE_USER_DATA || app.getPath('userData'), 'codex-checks')

/** A check: its connection (the key), its home, its job's name, and while its job is Hive's, the job and its supervisor's instance. */
interface Check {
  key: string
  name: string
  job: LeaseJob | null
  instance: number | null
  /** The launcher, until it has closed. */
  child: ChildProcess | null
  closed: boolean
  timer: NodeJS.Timeout | null
  trying: boolean
  since: number
}

/** Connections (keys) with a check under way. */
const running = new Set<string>()
/** Checks not confirmed gone, by connection: held. */
const held = new Map<string, Check>()
/** Why every Codex connection is held (a marker that couldn't be read, the folder unreadable), or null. */
let heldAll: string | null = null
let stopped = false

/** A home's key: a connection's folder by its id (its name in the accounts folder), else the folder itself. */
const keyOf = (home: string | undefined): string => (home ? basename(home).toLowerCase() : '~')
const markerOf = (name: string): string => join(root(), `${name}.check`)
/** A check's job name: its connection, then a random part (`HiveCheck-<key>-<hex>`). */
const nameFor = (key: string): string => `HiveCheck-${key.replace(/[^a-z0-9-]/gi, '_')}-${randomBytes(6).toString('hex')}`
/** The connection a job name, marker or journal part names; null when it names none. */
function keyOfName(file: string): string | null {
  const m = /^HiveCheck-(.+)-[0-9a-f]{12}(?:\.|$)/.exec(file)
  return m ? m[1].toLowerCase() : null
}

/** Whether a connection's folder is held: a check of it under way, or one not confirmed gone (HI-1757). */
export function codexCheckHeld(home: string): boolean {
  const k = keyOf(home)
  return heldAll !== null || running.has(k) || held.has(k)
}

/**
 * One request to Codex's app server (`command`/`args` as spawned, `env` the connection's): owned from before it runs to
 * its confirmed end. Refused at once while its connection is held. A cleanup not confirmed is a failed check, its
 * connection held until it is (retried; restored at the next start).
 */
export async function ownedAppServerRequest(o: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; method: string; params: unknown; timeoutMs: number }): Promise<CheckAnswer> {
  const key = keyOf(o.env.CODEX_HOME)
  // Reserved before anything is awaited: no second check, sign-in or removal can start meanwhile.
  if (heldAll) return { ok: false, error: heldAll }
  if (running.has(key) || held.has(key)) return { ok: false, error: "a check of this connection is already running, or its last one hasn't ended yet" } // i18n-ignore: for the log
  if (stopped) return { ok: false, error: 'Hive is quitting' } // i18n-ignore: for the log
  running.add(key)
  const c: Check = { key, name: nameFor(key), job: null, instance: null, child: null, closed: true, timer: null, trying: false, since: Date.now() }
  let answer: CheckAnswer = { ok: false, error: "Codex's check didn't run" } // i18n-ignore: for the log
  let ran = false
  try {
    const h = host()
    if (!(await h.ensure())) return { ok: false, error: "Hive can't own Codex's check here (its process tracking is off)" } // i18n-ignore: for the log
    // The marker first: a check whose connection a restart couldn't name again never runs.
    try {
      await writeMarker(c, o.env.CODEX_HOME ?? '')
    } catch (e) {
      return { ok: false, error: `its record couldn't be written: ${(e as Error).message}` } // i18n-ignore: for the log
    }
    ran = true
    const job = await LeaseJob.open(h, c.name, await journalPath(root(), c.name, root()))
    if ('problem' in job) {
      await releaseCheck(c)
      ran = false
      return { ok: false, error: `its job couldn't be made: ${job.problem}` } // i18n-ignore: for the log
    }
    c.job = job
    c.instance = h.instance
    answer = await askThroughLauncher(c, o)
  } catch (e) {
    answer = { ok: false, error: String((e as Error)?.message ?? e) }
  } finally {
    if (ran) {
      const gone = await endCheck(c)
      if (!gone) {
        answer = { ok: false, error: "couldn't end Codex's check" } // i18n-ignore: for the log
        hold(c)
      }
    }
    running.delete(key)
  }
  return answer
}

/** Starts the launcher, puts it in the job, then runs Codex through it and asks it the one request. */
async function askThroughLauncher(c: Check, o: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; method: string; params: unknown; timeoutMs: number }): Promise<CheckAnswer> {
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
  return new Promise<CheckAnswer>((resolveP) => {
    let buf = ''
    let over = false
    const done = (v: CheckAnswer): void => {
      if (over) return
      over = true
      clearTimeout(timer)
      resolveP(v)
    }
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
 * Ends a check and confirms it gone: its stdin ended (Codex ends itself), then its job ended and seen empty by the
 * supervisor instance that opened it, the job still that supervisor's by its name, and the launcher closed; else the
 * recovery a takeover makes. True only then, its records cleared; false keeps it.
 */
async function endCheck(c: Check): Promise<boolean> {
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
      return finishJournal(c)
    }
  }
  return recover(c)
}

/**
 * A check whose end its own supervisor couldn't confirm (it ended, was replaced, or the job no longer answers as its):
 * released only once no job by its name is left (closed: kill on close ended what was in it), and its journal, sealed,
 * reads empty or names only processes ended exactly and seen gone. Anything else keeps it.
 */
async function recover(c: Check): Promise<boolean> {
  const h = host()
  // Its job let go first if it is still this check's (closing it ends what is in it: kill on close); on another
  // supervisor the name is unknown and nothing happens.
  if (c.job) {
    await c.job.close().catch(() => undefined)
    c.job = null
  }
  // A launcher outside every job (never assigned) is Hive's own child: ended, and seen closed.
  if (c.child && !c.closed) {
    c.child.kill()
    if (!(await launcherClosed(c, END_MS))) return false
  }
  if (!(await h.ensure())) return false
  if (!(await leaseJobGone(h, c.name))) {
    if (!(await endLeaseJob(h, c.name))) return false
    if (!(await leaseJobGone(h, c.name))) return false
  }
  return finishJournal(c)
}

/** Seals, reads and settles a check's journal, then clears its records: true once all of it is done. */
async function finishJournal(c: Check): Promise<boolean> {
  const r = root()
  if (!(await sealJournal(r, c.name, r))) return false
  const read = await journalOf(r, c.name, r)
  if (read.state === 'unknown') {
    log.warn(`Codex's check ${c.name}: its journal can't be read (${userText(read.why)}): its connection stays held`)
    return false
  }
  if (read.state === 'read' && !(await endJournalled(probe(), read.entries, END_MS))) return false
  await clearJournal(r, c.name, r)
  await retireSeal(r, c.name, r, (lease) => leaseJobGone(host(), lease)).catch(() => false)
  await releaseCheck(c)
  return true
}

async function writeMarker(c: Check, home: string): Promise<void> {
  await mkdir(root(), { recursive: true })
  const file = markerOf(c.name)
  await writeFile(`${file}.tmp`, JSON.stringify({ connection: c.key, home, name: c.name, at: new Date().toISOString() }))
  await rename(`${file}.tmp`, file)
}

/** A check's records gone, its hold released. */
async function releaseCheck(c: Check): Promise<void> {
  await rm(markerOf(c.name), { force: true })
  if (held.get(c.key) === c) held.delete(c.key)
  if (c.timer) clearTimeout(c.timer)
  c.timer = null
}

/** Keeps a check not confirmed gone, its connection held, tried again (never two tries at once). */
function hold(c: Check): void {
  held.set(c.key, c)
  log.warn(`Codex's check of ${userText(c.key)} isn't confirmed ended: that connection is held until it is`)
  schedule(c)
}

function schedule(c: Check): void {
  if (stopped || c.timer) return
  const wait = Date.now() - c.since < 60_000 ? RETRY_FIRST_MS : RETRY_LATER_MS
  c.timer = setTimeout(() => {
    c.timer = null
    void tryAgain(c)
  }, wait)
}

async function tryAgain(c: Check): Promise<void> {
  if (c.trying || stopped || held.get(c.key) !== c) return
  c.trying = true
  try {
    if (await endCheck(c)) log.info(`Codex's check of ${userText(c.key)} has ended: the connection is no longer held`)
  } catch (e) {
    log.warn(`trying again to end Codex's check of ${userText(c.key)}`, e)
  } finally {
    c.trying = false
  }
  if (held.get(c.key) === c) schedule(c)
}

/**
 * At start, before connections are used (HI-1757): every check an earlier run left (its marker, or a journal of one)
 * holds its connection; a name or folder that can't be read holds every Codex connection. Recovery then runs in the
 * background, releasing each once confirmed.
 */
export async function restoreCodexCheckHolds(): Promise<void> {
  let names: string[]
  try {
    names = await readdir(root())
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    heldAll = `Codex's earlier checks can't be read (${(e as Error).message})` // i18n-ignore: for the log
    log.warn(`${heldAll}: every Codex connection is held`)
    return
  }
  const byName = new Map<string, string>()
  for (const n of names) {
    if (n.endsWith('.tmp')) continue
    const name = n.replace(/\.(check|followed)$/, '').replace(/\.sealed-\d+$/, '')
    const key = keyOfName(name)
    if (!key) {
      heldAll = `an earlier check of Codex may still be running (${n})` // i18n-ignore: for the log
      log.warn(`${heldAll}: every Codex connection is held`)
      continue
    }
    if (n.endsWith('.check')) {
      try {
        const m = JSON.parse(await readFile(join(root(), n), 'utf8')) as { connection?: unknown }
        if (typeof m.connection === 'string' && m.connection.toLowerCase() !== key) throw new Error('its connection differs from its name') // i18n-ignore: for the log
      } catch (e) {
        log.warn(`Codex's check record ${n} is damaged (${(e as Error).message}): held by its name's connection`)
      }
    }
    byName.set(name, key)
  }
  for (const [name, key] of byName) {
    if (held.has(key)) continue
    held.set(key, { key, name, job: null, instance: null, child: null, closed: true, timer: null, trying: false, since: Date.now() })
  }
  if (byName.size) log.info(`${byName.size} earlier Codex check(s) to settle: their connections are held until they are`)
  for (const c of held.values()) schedule(c)
}

/** At quit (HI-1757): no more tries; each held check's job tried once more, its marker kept unless its end is confirmed. */
export async function stopCodexChecks(): Promise<void> {
  stopped = true
  const all = [...held.values()]
  for (const c of all) if (c.timer) clearTimeout(c.timer)
  await Promise.all(all.map((c) => endCheck(c).catch(() => false)))
}

/** Tests only: forgets what this file keeps (holds, the stop) as a new Hive would start. */
export function resetCodexChecksForTests(): void {
  for (const c of held.values()) if (c.timer) clearTimeout(c.timer)
  held.clear()
  running.clear()
  heldAll = null
  stopped = false
}
