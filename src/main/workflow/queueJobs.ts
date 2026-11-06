// The merge queue runner's process ownership (#1360): a Windows job object per lease, on Combwork's process supervisor
// (processSupervisor.ts, shared with agents' launches), which owns every process the runner starts for the whole life
// of its tree (a shell's detached server too), and a launcher that is in the job, and recorded, before the command it
// runs exists.
//
// The job is named after the lease (`Local\CombworkQueue-<lease>`) and kill on close: the supervisor is a child of Combwork,
// which Windows ends with Combwork, and once its handle goes every process in the job ends too, by the operating system's
// guarantee; nothing in it may break away. What escapes it anyway (a packaged app's process, such as the Store's
// PowerShell, starts its children outside every job) is adopted into it, or followed by the supervisor (#543, #659,
// #678); each process it follows is first written to the lease's journal (journalPath), flushed through to the disk,
// and one it can't write down is ended at once ("unowned": the runner pauses): a followed process isn't in the job, so
// the job closing doesn't end it, and the journal is how the next runner finds it after a crash. Another Combwork taking a
// dead runner's lease over opens its job by name while anything still holds it (a supervisor that outlived its Combwork),
// ends what is in it and sees it empty, and ends what the journal names.
//
// A command starts through the launcher (Node: Combwork's own executable as Node, or Node itself in tests), started
// detached (outside Combwork's own job, whose children break away silently) and waiting on its input: it is put in the job
// and recorded, and only then told to run the command. A launcher whose input closes first (Combwork gone, or the record
// not written) exits without running anything.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat } from 'original-fs/promises'
import { JobHost } from '../processSupervisor'
import { createLogger } from '../logger'

const log = createLogger('queue')

/** How long a job's end waits to see it empty. */
const END_MS = 15_000

/**
 * Tests only (`linger`): a supervisor that outlives its Combwork, as one whose Combwork's job didn't end it would. A detached
 * Node relay (PowerShell started detached gets no console, and reads nothing) starts it and passes its input on, but
 * never closes it: so it stays when its Combwork has gone, until it is ended. The relay ends with it.
 */
const RELAY = `
// A process of its own, not Combwork's: its exit isn't one of Combwork's ways out (exitBy).
const end = process.exit.bind(process)
const p = require('child_process').spawn(process.argv[1], process.argv.slice(2), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
process.stdin.on('data', (d) => p.stdin.write(d))
process.stdin.on('error', () => {})
p.stdout.on('data', (d) => { try { process.stdout.write(d) } catch {} })
process.stdout.on('error', () => {})
p.on('exit', () => end(0))
`


/** A host of the queue's own (unit tests, a Combwork with no agents' host given): one per process, made on first use. */
let own: JobHost | null = null

/**
 * The process supervisor a runner uses: the one given (the app passes agents', so one PowerShell serves both), else
 * the queue's own. `linger` (tests): a new one that outlives this process (RELAY).
 */
export function queueHost(opts: { linger?: boolean } = {}): JobHost {
  if (!opts.linger && own) return own
  const host = new JobHost({
    waitMs: () => 60_000,
    testMode: () => '',
    log,
    onJoined: () => undefined,
    onLost: (why) => log.warn(`the merge queue's process supervisor ended (${why}): its jobs closed, ending what was in them`),
    onFailed: (f) => log.warn(`the merge queue's process supervisor couldn't start (${f.kind})`),
    testRequests: true,
    ...(opts.linger ? { launch: (file: string, args: string[]) => spawn(process.execPath, ['-e', RELAY, file, ...args], { windowsHide: true, stdio: 'pipe', cwd: tmpdir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true }) as ChildProcessWithoutNullStreams } : {})
  })
  if (!opts.linger) own = host
  return host
}

/** A lease's job on a supervisor. */
export class LeaseJob {
  private constructor(
    readonly host: JobHost,
    readonly lease: string
  ) {}

  /**
   * Makes the lease's job (named, kill on close) on a supervisor, with its journal (journalPath); `{ problem }` when it
   * can't (the host can't start, the name taken).
   */
  static async open(host: JobHost, lease: string, journal: string): Promise<LeaseJob | { problem: string }> {
    const r = await host.request('open', lease, Buffer.from(journal, 'utf8').toString('base64url'))
    return r === 'ok' ? new LeaseJob(host, lease) : { problem: typeof r === 'string' ? r : 'the process supervisor did not answer' } // i18n-ignore: a reason, logged
  }

  /** Puts a waiting launcher in the job, only while it is the process that started between the two readings (Unix ms). */
  async assign(pid: number, after: number, before: number): Promise<boolean> {
    return (await this.host.request('assign', this.lease, pid, after, before)) === 'ok'
  }

  /** Ends every process in the job and the ones it follows, and waits until none runs: true once none does. */
  async end(): Promise<boolean> {
    if ((await this.host.request('kill', this.lease)) === null) return false
    const until = Date.now() + END_MS
    for (;;) {
      const empty = await this.host.request('empty', this.lease)
      if (empty === true) return true
      if (empty === null || Date.now() > until) return false
      await new Promise((res) => setTimeout(res, 200))
    }
  }

  /** Lets the job go (its handle closed: anything left in it ends, kill on close). */
  async close(): Promise<void> {
    await this.host.request('forget', this.lease)
  }

  /** Tests only: the supervisor follows a process for the job, as it does a packaged app's (agents' Take). */
  follow(pid: number): Promise<unknown> {
    return this.host.request('follow', this.lease, pid)
  }
}

/** Another lease's job, by its name: ended and seen empty, or gone (closed, so the system ended what was in it). */
export async function endLeaseJob(host: JobHost, lease: string): Promise<boolean> {
  const r = await host.request('endnamed', lease)
  return r === 'ended' || r === 'nojob'
}

/**
 * Whether a lease's job is definitely gone (HI-1723): no job by its name, so no process holds it. A journal's only
 * writer is the supervisor that opened the lease's job (`open` gives it the path, `forget` takes it back, both in its
 * turn) and holds it while it may write; lease names are random and never opened twice. So with the job gone nothing
 * can write the journal again. Asked read-only (`hasjob`): nothing in a job is ended. False when it exists, or that
 * can't be told (no supervisor, no answer, access denied).
 */
export async function leaseJobGone(host: JobHost, lease: string): Promise<boolean> {
  return (await host.request('hasjob', lease)) === 'nojob'
}

/** A FILETIME (the supervisor's start times) in Unix ms. */
export const fileTimeMs = (created: string): number => Number((BigInt(created) - 116444736000000000n) / 10000n)

/**
 * A lease's journal (#1360): the file its job's supervisor writes each process it follows to, durably, before it
 * follows it (CombworkJobs.Journal), so another Combwork can end those after a crash. In the project's worktrees folder (or
 * `dir`, tests), made ready here.
 *
 * Sealing it (sealJournal) closes it to writers for good: what it held is moved aside (`<lease>.sealed-<n>`), and a
 * folder takes its name, so a supervisor that outlived its Combwork and finds something more to follow can't write it down,
 * and so ends it itself instead (its fail-closed rule): no entry can arrive after the last read (HR4's design review of
 * round 5). What is moved aside stays until a settle has ended what it names; the seal stays until the lease's job is
 * gone, nothing holding it to write there (retireSeal, HI-1723).
 */
export async function journalPath(root: string, lease: string, dir?: string): Promise<string> {
  const folder = dir ?? join(root, JOURNALS)
  await mkdir(folder, { recursive: true }).catch(() => undefined)
  return join(folder, `${lease}.followed`)
}

const JOURNALS = '.queue-journals'
const journalsOf = (root: string, dir?: string): string => dir ?? join(root, JOURNALS)

/** A process a journal names: its id and start (Unix ms). */
export type Journalled = { pid: number; started: number }

/**
 * What a lease's journal says, its moved-aside parts included: `absent` (none was written: nothing was followed),
 * `read` (every line a process; `sealed`: closed to writers), or `unknown` (a part couldn't be read, or a line isn't a
 * process: damaged or cut short). Unknown is never taken for empty: what it may name can't be ruled out, so its duty
 * stays and the queue pauses (HR4's round 4 finding 1).
 */
export type JournalState = { state: 'absent' } | { state: 'read'; entries: Journalled[]; sealed: boolean } | { state: 'unknown'; why: string }

/** A lease's journal, as it is now (JournalState). */
export async function journalOf(root: string, lease: string, dir?: string): Promise<JournalState> {
  const folder = journalsOf(root, dir)
  const main = join(folder, `${lease}.followed`)
  let names: string[]
  try {
    names = await readdir(folder)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'unknown', why: (e as Error).message }
  }
  const parts = names.filter((n) => n.startsWith(`${lease}.sealed-`)).map((n) => join(folder, n))
  let sealed = false
  if (names.includes(`${lease}.followed`)) {
    try {
      if ((await stat(main)).isDirectory()) sealed = true
      else parts.push(main)
    } catch (e) {
      return { state: 'unknown', why: (e as Error).message }
    }
  }
  if (!parts.length && !sealed) return { state: 'absent' }
  const entries: Journalled[] = []
  for (const part of parts) {
    let text: string
    try {
      text = await readFile(part, 'utf8')
    } catch (e) {
      return { state: 'unknown', why: (e as Error).message }
    }
    const records = parseJournal(text)
    if ('why' in records) return { state: 'unknown', why: records.why }
    entries.push(...records)
  }
  return { state: 'read', entries, sealed }
}

/** FILETIME bounds of a process the journal may name: started after 1970 began, and no later than a day from now. */
const FILETIME_1970 = 116444736000000000n
const filetimeNow = (): bigint => BigInt(Date.now() + 86_400_000) * 10000n + FILETIME_1970

/**
 * A journal's text as whole records (CombworkJobs.Journal writes each as "pid:created:check\n"), or why it isn't one
 * (HR4's round 5 finding): every record must end with its newline (an unterminated tail is a torn append), have all
 * three fields, a pid Windows could give (1 to 2^32 - 1), a start (FILETIME) between 1970 and a day from now, and the
 * check the supervisor wrote ((pid + created) mod 1000003), so a record cut short or damaged is never read as another,
 * plausible one.
 */
export function parseJournal(text: string): Journalled[] | { why: string } {
  if (text && !text.endsWith('\n')) return { why: 'its last record is cut short' } // i18n-ignore: a reason, logged
  const out: Journalled[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line) continue
    const m = /^(\d{1,10}):(\d{1,20}):(\d{1,7})$/.exec(line)
    if (!m) return { why: `a record that isn't one: ${line.slice(0, 40)}` } // i18n-ignore: a reason, logged
    const pid = BigInt(m[1])
    const created = BigInt(m[2])
    if (pid < 1n || pid > 0xffffffffn) return { why: `a pid out of range: ${m[1]}` } // i18n-ignore: a reason, logged
    if (created <= FILETIME_1970 || created > filetimeNow()) return { why: `a start time out of range: ${m[2]}` } // i18n-ignore: a reason, logged
    if ((pid + created) % 1000003n !== BigInt(m[3])) return { why: `a record whose check doesn't match: ${line.slice(0, 40)}` } // i18n-ignore: a reason, logged
    out.push({ pid: Number(pid), started: fileTimeMs(m[2]) })
  }
  return out
}

/**
 * Seals a lease's journal (closed to writers for good): what it holds moved aside, then a folder made in its place. A
 * file that appears again meanwhile (a write between the two) is moved aside too. Whether it is sealed.
 */
export async function sealJournal(root: string, lease: string, dir?: string): Promise<boolean> {
  const folder = journalsOf(root, dir)
  const main = join(folder, `${lease}.followed`)
  await mkdir(folder, { recursive: true }).catch(() => undefined)
  for (let n = 0; n < 5; n++) {
    try {
      if ((await stat(main)).isDirectory()) return true
      await rename(main, join(folder, `${lease}.sealed-${Date.now()}-${n}`))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
    try {
      await mkdir(main)
      return true
    } catch (e) {
      // EEXIST: a file again (a write between the move and the folder): moved aside in the next turn.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false
    }
  }
  return false
}

/**
 * Removes a lease's journal, once what it names is seen gone: its moved-aside parts, and the journal itself unless it
 * is sealed (the seal stays: a supervisor that outlived its Combwork may still try to write there, until retireSeal finds
 * its job gone).
 */
export async function clearJournal(root: string, lease: string, dir?: string): Promise<void> {
  const folder = journalsOf(root, dir)
  const names = await readdir(folder).catch(() => [] as string[])
  for (const n of names) if (n.startsWith(`${lease}.sealed-`)) await rm(join(folder, n), { force: true }).catch(() => undefined)
  const main = join(folder, `${lease}.followed`)
  const isFile = await stat(main).then((st) => st.isFile(), () => false)
  if (isFile) await rm(main, { force: true }).catch(() => undefined)
}

/**
 * Removes a lease's seal once nothing can write its journal again (HI-1723: one empty folder per job, never removed,
 * piled up): only a sealed journal already cleared (a real folder, no moved-aside part left: a settle's evidence), and
 * only when `gone` says its job definitely is (leaseJobGone). Fail-closed: a listing or a look that fails, a part, a
 * link (the journals folder or the seal: never followed), anything in the folder, or a job that may still be held keeps
 * it. Looked at again just before it goes. Whether it was removed.
 */
export async function retireSeal(root: string, lease: string, dir: string | undefined, gone: (lease: string) => Promise<boolean>): Promise<boolean> {
  const folder = journalsOf(root, dir)
  return (await listed(folder)) ? retireIn(folder, lease, gone) : false
}

/**
 * Removes every seal in a journals folder whose job is gone (retireSeal), one lease after another: one listing, then
 * each its own awaited checks (async file calls and the supervisor's requests: main's thread is never held). How many.
 */
export async function sweepSeals(root: string, dir: string | undefined, gone: (lease: string) => Promise<boolean>): Promise<number> {
  const folder = journalsOf(root, dir)
  const names = await listed(folder)
  if (!names) return 0
  let removed = 0
  for (const n of names) {
    if (!n.endsWith('.followed')) continue
    if (await retireIn(folder, n.slice(0, -'.followed'.length), gone)) removed++
  }
  return removed
}

/** A journals folder's names, only when it is a real folder (not a link) that can be read; null otherwise. */
async function listed(folder: string): Promise<string[] | null> {
  const real = await lstat(folder).then((st) => st.isDirectory() && !st.isSymbolicLink(), () => false)
  return real ? readdir(folder).catch(() => null) : null
}

/** A cleared seal (a real, empty folder in place of the journal, no part beside it), as it is now. */
async function cleared(folder: string, lease: string): Promise<boolean> {
  const names = await listed(folder)
  if (!names || !names.includes(`${lease}.followed`) || names.some((n) => n.startsWith(`${lease}.sealed-`))) return false
  const main = join(folder, `${lease}.followed`)
  if (!(await lstat(main).then((st) => st.isDirectory() && !st.isSymbolicLink(), () => false))) return false
  return readdir(main).then((inside) => inside.length === 0, () => false)
}

async function retireIn(folder: string, lease: string, gone: (lease: string) => Promise<boolean>): Promise<boolean> {
  if (!(await cleared(folder, lease))) return false
  if (!(await gone(lease).catch(() => false))) return false
  // Again, after the wait for the answer; then not recursive: a folder with anything in it stays.
  if (!(await cleared(folder, lease))) return false
  return rmdir(join(folder, `${lease}.followed`)).then(() => true, () => false)
}

// The launcher (run by Node, waiting for its go-ahead) is launcher.ts's, shared with cw-progress's isolated checks (#1435).
export { launcherNotStarted, launcherSignalled, SIGNALLED, startLauncher } from './launcher'
