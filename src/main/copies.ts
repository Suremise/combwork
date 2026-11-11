// A project's review and check copies (#1435, SPEC §16.10.5, §16.13): a small warm pool of detached worktrees in one
// fixed folder per project (`<Workspace>.worktrees/<Project>/copies/copy-N`, so a reviewer's launch grant never
// changes), each leased to one reviewer for one submission (#1439) or to one isolated check run (`cw-progress --check
// <name> --isolated`), reset to the exact revision first. Rows of combwork.db (schema/v1_0.ts, COPIES_STEP): at most one
// lease per copy that isn't freed (a partial unique index).
//
// - Leasing (`leaseCopy`) reserves a free copy (the most recently used), or a new one while the pool is under its size
//   (the larger of 2 and the agents that review plus one, OP-32, or the project's own), with its lease and an operation
//   in one write. The operation then makes it if new (a detached worktree, the project's copied files, its setup as one
//   of Combwork's runs, credited to the lease's agent: HI-1710), recreates it if gone, resets it to the revision (`git checkout --detach
//   --force`, then `git clean` of what isn't ignored) and installs again when its lock files changed; then the copy is
//   `leased`. With none free it refuses `noCopy` (the callers' "waiting for a check copy"), or `stillInUse` once a
//   returning copy has been held back past Settings → Advanced's bound.
// - Returning (`returnCopy`: a verdict, a review given up, the run's end) makes it `returning`, never free at once. The
//   quiescence barrier frees it only when, in this order: no Progress run with its folder in the copy is running; its
//   lease's job (an isolated run's processes) is settled (ended and seen gone, its journal sealed: slotJobs.ts); a
//   review's holder agent isn't in a turn and has no background tasks (or has stopped; a check's isn't waited for, its
//   processes all in its job: HI-1764); and a rename of its folder aside and back proves no process has it open. Until
//   then it stays returning, tried again within seconds of its return (`soon`), then on every lease and refresh.
// - Restart and crash: a lease whose holder Combwork is gone, or (this Combwork's) whose run is over, is returned and goes
//   through the same barrier: a copy is never taken for quiet because Combwork restarted. Operations (leasing, removal) own a
//   copy as slots' do (slots.ts): token-fenced writes, taken over only once their holder process is gone.
// - Clean-up (`remove`): never with a lease not freed, an operation or a job, a run or a process in it; copies hold no
//   work of anyone's (detached, at a revision), so git removes them forced. Copies beyond the size unused for a day go
//   (`tidy`).

import { randomBytes } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { admitOrThrow } from './platform/fenceAdmit'
import { existsSync } from 'original-fs'
import { mkdir } from 'original-fs/promises'
import { basename, join, resolve } from 'path'
import { placeMatcher, samePlace } from './fsutil'
import { agentMsg, inDefaultDialect, say, sayWithId, type AgentMsg, type AgentValues, type Said } from '../shared/agentText'
import { createLogger, userText } from './logger'
import { deletingIn, folderThere, IDLE_MS, lockHash, OpLost, quiet, releaseDeleteIn, type Holder, type OpHolder, type SlotConn, type SlotOptionsNow, type SlotRun, type SlotRunner, type SlotRunEnd } from './slots'
import { slotWorkspaces, workspacePortOf } from './platform/workspacePorts'
import { isUnknown } from './platform/types'
import type { WorkspaceFence, WorkspaceIdentity, WorkspaceJournal, WorkspacePlatform, WorkspacePort } from './platform/workspacePort'
import { isPlatformId } from '../shared/platform/descriptors'

const log = createLogger('copies')

/**
 * The workspace lifecycle port copies are made, reset and removed with (SPEC §16.3.6 Port 2, HI-2789's R5), unless the
 * pool is given another (HI-2795: jj's, by injection only).
 */
const defaultPort = slotWorkspaces

/** The folder a project's copies are in, under its worktrees folder: fixed, so a reviewer's grant never changes. */
export const COPIES_DIR = 'copies'
/** What a lease's operation taken over from a gone holder leaves as the copy's error: stored, so said in the Default. */
export const INTERRUPTED = agentMsg({ id: 'copy.error.interrupted', text: 'its reset was interrupted', note: "A check or review copy's error, kept on the copy, when its reset was taken over from a Combwork that is gone (#1435)." })

/** Text kept on a copy, a lease or a request for any reader (dialects, HI-2065): said in the Default. */
const sayStored = (m: AgentMsg, values?: AgentValues): string => inDefaultDialect(() => say(m, values))

/** The copies pool's agent text (dialects, HI-2447): refusals, what holds a copy back, and the errors kept on a copy. */
export const COPY_TEXT = {
  noCopy: agentMsg({ id: 'copy.refusal.noCopy', text: "no check copy free: the pool's {size} {count, plural, =1 {copy is} other {copies are}} in use", note: "Why no check or review copy was lent (#1435): every copy is in use. {size} is the pool's size as digits; {count} the same number, choosing the plural." }),
  returned: agentMsg({ id: 'copy.refusal.returned', text: 'its lease of {copy} was returned while the copy was being set up', note: 'Why a copy was not lent: the lease was given back during its setup.' }),
  stillInUse: agentMsg({ id: 'copy.refusal.stillInUse', text: '{copy} is still in use by {by}', note: 'Why a copy was not lent: the copy is still held. {by} says by what (copy.held.*, a run, an agent).' }),
  off: agentMsg({ id: 'copy.refusal.off', text: 'review copies are off (Settings → Advanced, Reviewers review in review copies)', note: 'Why a reviewer gets no review copy: the advanced setting is off. Names the setting as the window shows it.' }),
  setupFailed: agentMsg({ id: 'copy.refusal.setupFailed', text: "{copy}'s setup failed: {error}", note: "Why a copy was not lent: its setup failed. {error} is why (copy.error.*, git's or the command's)." }),
  closed: agentMsg({ id: 'copy.error.closed', text: 'the workspace closed', note: "Why a copy wasn't set up, or an isolated check's copy wasn't leased: its workspace closed." }),
  identityUnread: agentMsg({ id: 'copy.error.identityUnread', text: "its workspace's identity couldn't be read", note: "A copy's setup error (HI-2795): a jj workspace was made but its store, name or folder ids couldn't be read, so Combwork won't use it." }),
  notExact: agentMsg({ id: 'copy.error.notExact', text: "it isn't exactly the revision asked for", note: "A copy's setup error (HI-2795): the jj copy, checked right before it is handed over, isn't exactly the revision (other files, another parent, stale or divergent)." }),
  removalCutShort: agentMsg({ id: 'copy.error.removalCutShort', text: 'its removal was cut short and is finished by the next clean-up', note: "A copy's error, kept on the copy (HI-2795): a jj copy's removal stopped part way (its workspace forgotten, its folder not yet in the Recycle Bin), so it isn't lent until the next clean-up finishes it." }),
  notListed: agentMsg({ id: 'copy.error.notListed', text: 'its folder is there but git does not list it as a worktree', note: "A copy's error: its folder exists but isn't a worktree git knows, so Combwork leaves it alone." }),
  worktreeAdd: agentMsg({ id: 'copy.error.worktreeAdd', text: 'git worktree add: {error}', note: "A copy's setup error: `git worktree add` failed. {error} is git's first line, else failed." }),
  checkout: agentMsg({ id: 'copy.error.checkout', text: 'git checkout: {error}', note: "A copy's reset error: `git checkout` of the revision failed. {error} is git's first line, else failed." }),
  clean: agentMsg({ id: 'copy.error.clean', text: 'git clean: {error}', note: "A copy's reset error: `git clean` failed. {error} is git's first line, else failed." }),
  setupNotEnded: agentMsg({ id: 'copy.error.setupNotEnded', text: 'processes its setup started could not be ended', note: "A copy's setup error: its setup command ended, but processes it started are still running." }),
  setupTimedOut: agentMsg({ id: 'copy.error.setupTimedOut', text: 'its setup ran out of time', note: "A copy's setup error: its setup command reached its time limit." }),
  setupNoStart: agentMsg({ id: 'copy.error.setupNoStart', text: "its setup couldn't start: {command}", note: "A copy's setup error: its setup command couldn't be started. {command} is the command." }),
  setupExit: agentMsg({ id: 'copy.error.setupExit', text: 'its setup exited with code {code}', note: "A copy's setup error: its setup command failed. {code} is its exit code." }),
  heldJob: agentMsg({ id: 'copy.held.job', text: "its run's processes ({job})", note: 'What holds a returned copy back from being freed: processes of the run that had it. {job} is their job\'s id. The end of copy.refusal.stillInUse and of "held back by …".' }),
  heldProcess: agentMsg({ id: 'copy.held.process', text: 'a process with a file or folder open in it', note: 'What holds a copy back from being freed or removed: a process has something open in its folder.' }),
  notLeased: agentMsg({ id: 'copy.isolated.notLeased', text: 'no check copy could be leased: {error}', note: "cw-progress --isolated's refusal: leasing its check copy failed. {error} is why." }),
  waitCopy: agentMsg({ id: 'copy.isolated.waitCopy', text: 'a check copy', note: 'What cw-progress --isolated waits for ("waiting for a check copy"): none is free yet.' }),
  waitSetup: agentMsg({ id: 'copy.isolated.waitSetup', text: 'a check copy to be set up', note: 'What cw-progress --isolated waits for: its check copy is being set up.' })
}
const T = COPY_TEXT
/** The waits before a copy held back as it was returned is tried again (CopyPool.soon): about 16 s in all. */
export const RETRY_MS = [500, 1000, 2000, 4000, 8000]

export type CopyState = 'creating' | 'free' | 'leased' | 'returning' | 'dirty' | 'gone'
export type CopyKind = 'review' | 'check'
type OpKind = 'lease' | 'remove' | 'recover'

export interface Copy {
  project: string
  name: string
  folder: string
  state: CopyState
  /** The revision it was last reset to. */
  revision: string | null
  installHash: string | null
  warmError: string | null
  warmLog: string | null
  createdAt: string
  usedAt: string
  op: { token: string; kind: OpKind; pid: number; started: number } | null
  job: string | null
  /** The platform whose workspace it is (HI-2795; absent: Git), and its identity where that platform records one (jj). */
  platform?: WorkspacePlatform
  identity?: WorkspaceIdentity | null
}

export interface CopyLease {
  id: string
  project: string
  copy: string
  kind: CopyKind
  card: number
  revision: string
  /** Its submission (a review) or run (a check: its link until the run starts). */
  ref: string | null
  /** The agent holding it (a reviewer, the agent running the check). */
  agent: string | null
  /** The Combwork that leased it: its profile, pid and start. */
  profile: string
  pid: number
  started: number
  /** The supervisor job its run's processes are in (an isolated check). */
  job: string | null
  from: string
  returned: string | null
  why: string | null
  freed: string | null
  /**
   * A jj copy's verification after its quiescence barrier (HI-2795): true, it was exactly its revision once every consumer
   * had ended; false, it wasn't; null, not verified (every Git lease, and a jj lease not freed yet). jj's credit needs true.
   */
  intact?: boolean | null
}

export type CopyRefusal =
  | { why: 'noCopy'; size: number }
  | { why: 'returned'; copy: string }
  | { why: 'stillInUse'; copy: string; by: string }
  | { why: 'off' }
  | { why: 'setupFailed'; copy: string; error: string; log: string | null }

export type CopyLeaseResult = { ok: true; lease: CopyLease; copy: Copy } | { ok: false; refusal: CopyRefusal }

/** What holds a returning copy back from being freed (the barrier's conditions, in order). */
export type CopyHeld = { why: 'run'; by: string } | { why: 'job'; by: string } | { why: 'holder'; by: string } | { why: 'process'; by: string }

/** A refusal in English, for agents and the log. */
export function copyRefusalText(r: CopyRefusal): string {
  switch (r.why) {
    case 'noCopy':
      return say(T.noCopy, { size: String(r.size), count: r.size })
    case 'returned':
      return say(T.returned, { copy: r.copy })
    case 'stillInUse':
      return say(T.stillInUse, { copy: r.copy, by: r.by })
    case 'off':
      return say(T.off)
    case 'setupFailed':
      return say(T.setupFailed, { copy: r.copy, error: r.error })
  }
}

/** The nth copy's name (copy-1, copy-2…). */
export const copyName = (n: number): string => `copy-${n}`

/** The pool's size (OP-32): the larger of 2 and the agents that review plus one, unless the project sets its own. */
export function copyPoolSize(reviewers: number, own?: number | null): number {
  return own && Number.isInteger(own) && own > 0 ? own : Math.max(2, reviewers + 1)
}

/** A project's copies folder (`<Workspace>.worktrees/<Project>/copies`): what a reviewer's launch is granted. */
export const copiesDirOf = (worktreesRoot: string, projectPath: string): string => join(worktreesRoot, basename(projectPath), COPIES_DIR)

/**
 * Whether a launch is granted the project's copies folder (#1439, SPEC §16.10.5 Access): its CLI can be given folders
 * (`extraDirs`), review copies are on, and its agent reviews (a reviewer, or either) in the project folder, where its
 * sessions are when it reviews (#1434). Either building in its slot isn't: when it next reviews, it is in the project
 * folder again. Never the Assistant.
 */
export function grantsCopies(g: { capable: boolean; on: boolean; reviews: boolean; inProjectFolder: boolean; assistant: boolean }): boolean {
  return g.capable && g.on && g.reviews && g.inProjectFolder && !g.assistant
}

type Row = Record<string, string | number | null>
const copyOfRow = (r: Row): Copy => ({
  project: r.project as string,
  name: r.name as string,
  folder: r.folder as string,
  state: r.state as CopyState,
  revision: (r.revision as string | null) ?? null,
  installHash: (r.install_hash as string | null) ?? null,
  warmError: (r.warm_error as string | null) ?? null,
  warmLog: (r.warm_log as string | null) ?? null,
  createdAt: r.created_at as string,
  usedAt: r.used_at as string,
  op: r.op ? { token: r.op as string, kind: r.op_kind as OpKind, pid: (r.op_pid as number) ?? 0, started: (r.op_started as number) ?? 0 } : null,
  job: (r.job as string | null) ?? null,
  platform: (r.platform as WorkspacePlatform | undefined) ?? 'git',
  identity: r.store && r.workspace && r.generation ? { store: r.store as string, workspace: r.workspace as string, generation: r.generation as string } : null
})
const leaseOfRow = (r: Row): CopyLease => ({
  id: r.id as string,
  project: r.project as string,
  copy: r.copy as string,
  kind: r.kind as CopyKind,
  card: r.card as number,
  revision: r.revision as string,
  ref: (r.ref as string | null) ?? null,
  agent: (r.agent as string | null) ?? null,
  profile: r.profile as string,
  pid: r.pid as number,
  started: r.started as number,
  job: (r.job as string | null) ?? null,
  from: r.from_at as string,
  returned: (r.returned_at as string | null) ?? null,
  why: (r.why as string | null) ?? null,
  freed: (r.freed_at as string | null) ?? null,
  intact: r.intact === undefined || r.intact === null ? null : r.intact === 1
})

/** No operation, no job, no lease that isn't freed. */
// agent-protocol: SQL
const FREE = 'op IS NULL AND job IS NULL AND NOT EXISTS (SELECT 1 FROM copy_leases l WHERE l.project = copies.project AND l.copy = copies.name AND l.freed_at IS NULL)'

/** What a lease asks for. */
export interface CopyRequest {
  kind: CopyKind
  card: number
  revision: string
  ref?: string | null
  agent?: string | null
}

/** One project's copies and leases (its id), on a connection (the board's in the app). */
export class CopyStore {
  constructor(
    readonly conn: SlotConn,
    readonly project: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  iso(): string {
    return this.now().toISOString()
  }

  copies(): Copy[] {
    return this.conn.read((db) => (db.prepare('SELECT * FROM copies WHERE project = ? ORDER BY name').all(this.project) as Row[]).map(copyOfRow))
  }

  copy(name: string): Copy | null {
    return this.conn.read((db) => this.copyIn(db, name))
  }

  copyIn(db: DatabaseSync, name: string): Copy | null {
    const r = db.prepare('SELECT * FROM copies WHERE project = ? AND name = ?').get(this.project, name) as Row | undefined
    return r ? copyOfRow(r) : null
  }

  lease(id: string): CopyLease | null {
    return this.conn.read((db) => {
      const r = db.prepare('SELECT * FROM copy_leases WHERE id = ? AND project = ?').get(id, this.project) as Row | undefined
      return r ? leaseOfRow(r) : null
    })
  }

  /** The lease a run or a review (its ref) holds, if any. */
  leaseByRef(ref: string): CopyLease | null {
    return this.conn.read((db) => {
      const r = db.prepare('SELECT * FROM copy_leases WHERE ref = ? AND project = ?').get(ref, this.project) as Row | undefined
      return r ? leaseOfRow(r) : null
    })
  }

  /** The leases not freed yet (open or returning). */
  unfreed(): CopyLease[] {
    return this.conn.read((db) => (db.prepare('SELECT * FROM copy_leases WHERE project = ? AND freed_at IS NULL').all(this.project) as Row[]).map(leaseOfRow))
  }

  /** A copy's lease not freed yet, if any. */
  leaseOn(copy: string): CopyLease | null {
    return this.conn.read((db) => {
      const r = db.prepare('SELECT * FROM copy_leases WHERE project = ? AND copy = ? AND freed_at IS NULL').get(this.project, copy) as Row | undefined
      return r ? leaseOfRow(r) : null
    })
  }

  /**
   * Reserves a copy for a lease in one write, with a lease operation (`token`) on it: a free one (not in `skip`, the most
   * recently used), else a new `copy-N` (the lowest number free) while the project has fewer than `size`. The lease's
   * row is in the same write; the index refuses a second lease not freed on the copy.
   */
  async take(req: CopyRequest, o: { size: number; dir: string; token: string; holder: Holder; profile: string; skip?: ReadonlySet<string>; platform?: WorkspacePlatform }): Promise<{ ok: true; lease: CopyLease; copy: Copy; fresh: boolean } | { ok: false; size: number }> {
    try {
      return await this.conn.write((db) => {
        const at = this.iso()
        // The project being deleted (#1447): no copy leased or made until its reservation ends.
        if (deletingIn(db, this.project)) return { ok: false as const, size: 0 }
        // The platform fence (HI-2799): a copy's lease is an admission on the project's repository, refused while it switches.
        admitOrThrow(db, this.project, o.platform ?? 'git')
        const all = (db.prepare('SELECT * FROM copies WHERE project = ? ORDER BY name').all(this.project) as Row[]).map(copyOfRow)
        const leased = (c: Copy): boolean => !!db.prepare('SELECT 1 FROM copy_leases WHERE project = ? AND copy = ? AND freed_at IS NULL').get(this.project, c.name)
        // Only a copy of this pool's platform (HI-2795, R2.6): a Git copy is never reused by a jj pool.
        const free = all.filter((c) => (c.platform ?? 'git') === (o.platform ?? 'git') && (c.state === 'free' || c.state === 'dirty' || c.state === 'gone') && !c.warmError && !c.op && !c.job && !leased(c) && !o.skip?.has(c.name))
        let copy = free.sort((a, b) => b.usedAt.localeCompare(a.usedAt))[0]
        let fresh = false
        if (!copy) {
          // HI-2936: the size counts this platform's copies alone: another's left by a switch is never reused, so never fills it.
          if (all.filter((c) => (c.platform ?? 'git') === (o.platform ?? 'git')).length >= o.size) return { ok: false as const, size: o.size }
          const names = new Set(all.map((c) => c.name.toLowerCase()))
          let n = 1
          while (names.has(copyName(n)) || existsSync(join(o.dir, copyName(n)))) n++
          const name = copyName(n)
          db.prepare("INSERT INTO copies (project, name, folder, state, created_at, used_at, op, op_kind, op_pid, op_started) VALUES (?, ?, ?, 'creating', ?, ?, ?, 'lease', ?, ?)").run(this.project, name, join(o.dir, name), at, at, o.token, o.holder.pid, o.holder.started)
          if ((o.platform ?? 'git') !== 'git') db.prepare('UPDATE copies SET platform = ? WHERE project = ? AND name = ?').run(o.platform!, this.project, name)
          copy = this.copyIn(db, name)!
          fresh = true
        } else {
          const took = db.prepare(`UPDATE copies SET op = ?, op_kind = 'lease', op_pid = ?, op_started = ?, used_at = ? WHERE project = ? AND name = ? AND state = ? AND ${FREE}`).run(o.token, o.holder.pid, o.holder.started, at, this.project, copy.name, copy.state)
          if (Number(took.changes) !== 1) return { ok: false as const, size: o.size }
        }
        const id = `c-${randomBytes(6).toString('hex')}`
        db.prepare('INSERT INTO copy_leases (id, project, copy, kind, card, revision, ref, agent, profile, pid, started, from_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, this.project, copy.name, req.kind, req.card, req.revision, req.ref ?? null, req.agent ?? null, o.profile, o.holder.pid, o.holder.started, at)
        const lease = leaseOfRow(db.prepare('SELECT * FROM copy_leases WHERE id = ?').get(id) as Row)
        return { ok: true as const, lease, copy: this.copyIn(db, copy.name)!, fresh }
      })
    } catch (e) {
      if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) return { ok: false, size: o.size }
      throw e
    }
  }

  /** One write of an operation: only while it still holds the copy (its token), else OpLost and nothing written. */
  async fenced<T>(name: string, token: string, fn: (db: DatabaseSync, c: Copy) => T): Promise<T> {
    return this.conn.write((db) => {
      const c = this.copyIn(db, name)
      if (!c || c.op?.token !== token) throw new OpLost(name)
      return fn(db, c)
    })
  }

  /** In a write: a copy's state and fields, and its operation ended (`op: null`) or its job set. */
  setIn(db: DatabaseSync, name: string, state: CopyState, fields: Partial<Pick<Copy, 'revision' | 'installHash' | 'warmError' | 'warmLog'>> = {}, also: { op?: null; job?: string | null } = {}): void {
    const col = { revision: 'revision', installHash: 'install_hash', warmError: 'warm_error', warmLog: 'warm_log' } as const
    const sets = ['state = ?', ...Object.keys(fields).map((k) => `${col[k as keyof typeof col]} = ?`)]
    const args: (string | null)[] = [state, ...Object.values(fields).map((v) => v ?? null)]
    if (also.op === null) sets.push('op = NULL, op_kind = NULL, op_pid = NULL, op_started = NULL')
    if (also.job !== undefined) {
      sets.push('job = ?')
      args.push(also.job)
    }
    db.prepare(`UPDATE copies SET ${sets.join(', ')} WHERE project = ? AND name = ?`).run(...args, this.project, name)
  }

  /** In a write: a lease given up before it was used (its copy's reset failed): returned and freed at once. */
  dropIn(db: DatabaseSync, lease: string, why: string): void {
    const at = this.iso()
    db.prepare('UPDATE copy_leases SET returned_at = coalesce(returned_at, ?), why = coalesce(why, ?), freed_at = ? WHERE id = ? AND freed_at IS NULL').run(at, why, at, lease)
  }

  /** Starts an operation (removal) on a copy free of everything, still in the state it was read in. */
  async startOp(name: string, kind: OpKind, from: CopyState, token: string, holder: Holder): Promise<boolean> {
    return this.conn.write((db) => Number(db.prepare(`UPDATE copies SET op = ?, op_kind = ?, op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND state = ? AND ${FREE}`).run(token, kind, holder.pid, holder.started, this.project, name, from).changes) === 1)
  }

  /**
   * Takes over an operation whose holder is gone: only while `was` still holds it. Its kind stays (a lease's reset, a
   * removal), so a taker that is itself interrupted leaves the same recovery for the next one (HR1's #1435 round 1).
   */
  async takeOver(name: string, was: string, token: string, holder: Holder): Promise<boolean> {
    return this.conn.write((db) => Number(db.prepare('UPDATE copies SET op = ?, op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND op = ?').run(token, holder.pid, holder.started, this.project, name, was).changes) === 1)
  }

  /** Returns a lease (its review or run is over): the copy `returning`. The lease as returned, or null when it was already. */
  async returnLease(id: string, why: string): Promise<CopyLease | null> {
    return this.conn.write((db) => {
      const r = db.prepare('SELECT * FROM copy_leases WHERE id = ? AND project = ? AND returned_at IS NULL AND freed_at IS NULL').get(id, this.project) as Row | undefined
      if (!r) return null
      const at = this.iso()
      db.prepare('UPDATE copy_leases SET returned_at = ?, why = ? WHERE id = ?').run(at, why, id)
      db.prepare("UPDATE copies SET state = 'returning', used_at = ? WHERE project = ? AND name = ? AND state = 'leased'").run(at, this.project, r.copy)
      return { ...leaseOfRow(r), returned: at, why }
    })
  }

  /** Frees a returned lease (the barrier passed): only that lease, still returned, its copy still returning with no operation. */
  async free(lease: string, copy: string): Promise<boolean> {
    return this.conn.write((db) => {
      const ok = db.prepare("SELECT 1 FROM copies c JOIN copy_leases l ON l.project = c.project AND l.copy = c.name WHERE c.project = ? AND c.name = ? AND c.state = 'returning' AND c.op IS NULL AND l.id = ? AND l.returned_at IS NOT NULL AND l.freed_at IS NULL").get(this.project, copy, lease)
      if (!ok) return false
      const at = this.iso()
      db.prepare('UPDATE copy_leases SET freed_at = ?, job = NULL WHERE id = ?').run(at, lease)
      db.prepare("UPDATE copies SET state = 'free', used_at = ? WHERE project = ? AND name = ?").run(at, this.project, copy)
      return true
    })
  }

  /**
   * Frees a returned lease after its verification (HI-2795: a jj copy, its `recover` operation `token`): the result
   * stored on the lease and the copy freed in the same write, so nothing can lend, reset or reuse it before it is.
   */
  async freeVerified(lease: string, copy: string, token: string, intact: boolean): Promise<boolean> {
    return this.conn.write((db) => {
      const ok = db.prepare("SELECT 1 FROM copies c JOIN copy_leases l ON l.project = c.project AND l.copy = c.name WHERE c.project = ? AND c.name = ? AND c.state = 'returning' AND c.op = ? AND l.id = ? AND l.returned_at IS NOT NULL AND l.freed_at IS NULL").get(this.project, copy, token, lease)
      if (!ok) return false
      const at = this.iso()
      db.prepare('UPDATE copy_leases SET freed_at = ?, job = NULL, intact = ? WHERE id = ?').run(at, intact ? 1 : 0, lease)
      db.prepare("UPDATE copies SET state = 'free', used_at = ?, op = NULL, op_kind = NULL, op_pid = NULL, op_started = NULL WHERE project = ? AND name = ?").run(at, this.project, copy)
      return true
    })
  }

  /** A returning copy's verification operation started (HI-2795): only while it is returning with nothing else on it. */
  async startVerify(copy: string, token: string, holder: Holder): Promise<boolean> {
    return this.conn.write((db) => Number(db.prepare("UPDATE copies SET op = ?, op_kind = 'recover', op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND state = 'returning' AND op IS NULL AND job IS NULL").run(token, holder.pid, holder.started, this.project, copy).changes) === 1)
  }

  /** A copy's workspace identity recorded (HI-2795), in its operation's write. */
  async setIdentity(name: string, token: string, id: WorkspaceIdentity): Promise<void> {
    await this.fenced(name, token, (db) => db.prepare('UPDATE copies SET store = ?, workspace = ?, generation = ? WHERE project = ? AND name = ?').run(id.store, id.workspace, id.generation, this.project, name))
  }

  /** A multi-step change's journal (HI-2795: a jj copy's removal), a board_meta row by key. */
  journal(key: string): WorkspaceJournal {
    return {
      read: () =>
        this.conn.read((db) => {
          const r = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined
          if (!r) return null
          try {
            return JSON.parse(r.value) as unknown
          } catch {
            return { unreadable: true }
          }
        }),
      write: (v) => this.conn.write((db) => void db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(v))),
      clear: () => this.conn.write((db) => void db.prepare('DELETE FROM board_meta WHERE key = ?').run(key))
    }
  }

  /** A lease's job (its isolated run's processes), set before anything is put in it. */
  async setLeaseJob(lease: string, job: string): Promise<boolean> {
    return this.conn.write((db) => Number(db.prepare('UPDATE copy_leases SET job = ? WHERE id = ? AND project = ? AND returned_at IS NULL').run(job, lease, this.project).changes) === 1)
  }

  /** A check lease's run, once it starts (its ref was the link resolve gave out). */
  async setRef(lease: string, ref: string): Promise<void> {
    await this.conn.write((db) => db.prepare('UPDATE copy_leases SET ref = ? WHERE id = ? AND project = ?').run(ref, lease, this.project))
  }

  /** A free copy whose folder is gone: marked so (it is made again at its next lease). */
  /**
   * A copy's folder moved by Repair (#1447): its row follows it, only while no operation or job holds it; with `gone` (not
   * found), marked gone at its place in the moved pool, so its next lease makes it again there. Whether it was.
   */
  async relocate(name: string, folder: string, o: { gone?: boolean } = {}): Promise<boolean> {
    return this.conn.write((db) => Number(db.prepare(`UPDATE copies SET folder = ?${o.gone ? ", state = 'gone'" : ''} WHERE project = ? AND name = ? AND op IS NULL AND job IS NULL`).run(folder, this.project, name).changes) === 1)
  }

  async markGone(name: string): Promise<void> {
    await this.conn.write((db) => db.prepare(`UPDATE copies SET state = 'gone' WHERE project = ? AND name = ? AND state = 'free' AND ${FREE}`).run(this.project, name))
  }

  /** A copy-level job (a warming's) settled since: cleared, only while no operation holds the copy. */
  async jobSettled(name: string, job: string): Promise<void> {
    await this.conn.write((db) => db.prepare('UPDATE copies SET job = NULL WHERE project = ? AND name = ? AND job = ? AND op IS NULL').run(this.project, name, job))
  }
}

export interface CopyPoolDeps {
  store: CopyStore
  /** The project's folder (its repository). */
  project: string
  /** The project's copies folder (`<worktrees>/<project>/copies`). */
  dir: string
  options: () => Promise<SlotOptionsNow>
  /** The pool's size now (copyPoolSize of the project's reviewers, or its own). */
  size: () => number | Promise<number>
  runner: SlotRunner
  settle: (job: string) => Promise<boolean>
  holder: OpHolder
  /** This Combwork's profile, recorded on its leases. */
  profile: string
  /** A Progress run running with its folder in the copy: its title (for "still in use by"), or null. */
  runIn: (folder: string) => string | null
  /** The holder agent in a turn or with background tasks running: its name, or null (idle, stopped, gone). */
  holderBusy: (agent: string) => string | null
  /** Whether a lease's review or run is over (a check's run ended, its link never started), as this Combwork knows; null: can't tell. */
  leaseOver: (lease: CopyLease) => boolean | null | Promise<boolean | null>
  /** Settings → Advanced, Reviewers review in review copies. */
  reviewOn: () => boolean
  /** How long a returning copy is held back before it shows as still in use (Settings → Advanced). */
  quietWaitMs: () => number
  /** How its copies are made, reset, verified and removed (HI-2795); unset: Git's worktrees. */
  workspaces?: WorkspacePort
  /** The port its new copies are made with, by its project's platform now (HI-2866: the app's), when `workspaces` isn't set. */
  workspacesFor?: () => WorkspacePort
  /** Reads the project's platform again before a lending (HI-2866). */
  refreshPorts?: () => Promise<void>
  now?: () => number
}

const newToken = (): string => `o-${randomBytes(8).toString('hex')}`
const newJob = (): string => `copy-${randomBytes(6).toString('hex')}`

export class CopyPool {
  private readonly store: CopyStore
  private readonly running = new Set<Promise<unknown>>()
  private readonly life = new AbortController()

  constructor(readonly deps: CopyPoolDeps) {
    this.store = deps.store
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The pool's port: the deps', else Git's (HI-2795). */
  private get port(): WorkspacePort {
    return this.deps.workspaces ?? this.deps.workspacesFor?.() ?? defaultPort()
  }

  /** A copy's own port: the pool's for its platform, else its platform's (a Git copy in a jj pool is removed by Git). */
  private portOf(c: Pick<Copy, 'platform'>): WorkspacePort {
    const p = c.platform ?? 'git'
    if (p === this.port.platform) return this.port
    const own = isPlatformId(p) ? workspacePortOf(p) : null
    // agent-protocol: a programming error, never an agent's or the user's
    if (!own) throw new Error(`No workspace port for copy platform ${p}`) // i18n-ignore: an internal error, for the log
    return own
  }

  /** Whether a copy has its port here (HI-2936: a leftover of a platform switched from, its port not registered). */
  private hasPort(c: Pick<Copy, 'platform'>): boolean {
    const p = c.platform ?? 'git'
    return p === this.port.platform || (isPlatformId(p) && !!workspacePortOf(p))
  }

  private fenceOf(name: string, token: string): WorkspaceFence {
    return { still: () => this.store.fenced(name, token, () => true).catch(() => false) }
  }

  private removalJournal(name: string): WorkspaceJournal {
    return this.store.journal(`copy_wsremove:${this.store.project}:${name}`)
  }

  /**
   * A jj copy disposed of (HI-2795/s21 §3: stale, divergent, or not exactly its revision): forgotten and its folder to
   * the Recycle Bin, journalled, with no snapshot and nothing abandoned. True once gone; false keeps the copy out of
   * the pool (its journal kept).
   */
  private async dispose(c: Copy, token: string): Promise<boolean> {
    const r = await this.portOf(c).remove(this.deps.project, c.folder, { force: true, identity: c.identity ?? null, journal: this.removalJournal(c.name), fence: this.fenceOf(c.name, token) })
    if (!r.ok) log.warn(`Copy ${userText(c.name)} couldn't be disposed of: ${userText(r.err)}`)
    return r.ok
  }

  get closed(): boolean {
    return this.life.signal.aborted
  }

  copies(): Copy[] {
    return this.store.copies()
  }

  lease(id: string): CopyLease | null {
    return this.store.lease(id)
  }

  leaseByRef(ref: string): CopyLease | null {
    return this.store.leaseByRef(ref)
  }

  /** The leases not freed yet (returning ones too). */
  unfreed(): CopyLease[] {
    return this.store.unfreed()
  }

  /**
   * The copy a folder is in (its own folder or inside it), with its lease not freed, if any. By spelling first, then by
   * real location with `folder` resolved once (HI-1887: every Progress run's resolve asks, and most folders are no copy).
   */
  at(folder: string): { copy: Copy; lease: CopyLease | null } | null {
    const copies = this.store.copies()
    const spelt = resolve(folder).toLowerCase()
    const same = placeMatcher(folder)
    const copy = copies.find((c) => resolve(c.folder).toLowerCase() === spelt || folder.toLowerCase().startsWith(`${c.folder.toLowerCase()}\\`) || folder.toLowerCase().startsWith(`${c.folder.toLowerCase()}/`)) ?? copies.find((c) => same(c.folder))
    return copy ? { copy, lease: this.store.leaseOn(copy.name) } : null
  }

  /** Runs an operation as this pool's: its token live from before its first write, its work awaited by `close`. */
  private async op<T>(token: string, fn: () => Promise<T>): Promise<T> {
    this.deps.holder.live.add(token)
    const p = fn()
    this.running.add(p)
    try {
      return await p
    } finally {
      this.running.delete(p)
      this.deps.holder.live.delete(token)
    }
  }

  async close(): Promise<void> {
    this.life.abort()
    for (const t of this.retrying.values()) clearTimeout(t)
    this.retrying.clear()
    await Promise.allSettled([...this.running])
  }

  private async holderGone(pid: number, started: number, token?: string): Promise<boolean> {
    const me = await this.deps.holder.self()
    if (pid === me.pid && started === me.started) return token !== undefined && !this.deps.holder.live.has(token)
    return (await this.deps.holder.alive(pid, started)) === false
  }

  /**
   * Leases a copy at a revision: free ones looked at, a new one while under the pool's size, reset and installed before
   * it is given. Refused `off` (a review with review copies off), `noCopy`, `stillInUse` (a returning copy held back
   * past the bound: who holds it) or `setupFailed`.
   */
  async leaseCopy(req: CopyRequest): Promise<CopyLeaseResult> {
    if (req.kind === 'review' && !this.deps.reviewOn()) return { ok: false, refusal: { why: 'off' } }
    if (this.closed) return { ok: false, refusal: { why: 'noCopy', size: 0 } }
    await this.deps.refreshPorts?.()
    await this.refresh()
    const holder = await this.deps.holder.self()
    const size = await this.deps.size()
    const skip = new Set<string>()
    for (;;) {
      const token = newToken()
      const out = await this.op(token, async (): Promise<CopyLeaseResult | 'skip'> => {
        const taken = await this.store.take(req, { size, dir: this.deps.dir, token, holder, profile: this.deps.profile, skip, ...(this.port.platform !== 'git' ? { platform: this.port.platform } : {}) })
        if (!taken.ok) return { ok: false, refusal: this.heldTooLong() ?? { why: 'noCopy', size: taken.size } }
        const done = await this.reset(taken.copy, taken.lease, token, taken.fresh)
        if (done === 'ready') return { ok: true, lease: this.store.lease(taken.lease.id)!, copy: this.store.copy(taken.copy.name)! }
        // Returned while it was being set up (cancelled, expired): returning, freed only through the barrier.
        if (done === 'returned') {
          await this.tryFree(taken.copy.name)
          return { ok: false, refusal: { why: 'returned', copy: taken.copy.name } }
        }
        if (done === 'skip') {
          skip.add(taken.copy.name)
          return 'skip'
        }
        return { ok: false, refusal: done }
      })
      if (out !== 'skip') return out
    }
  }

  /** A returning copy held back past the bound, and by what: the first, as "still in use". */
  private heldTooLong(): CopyRefusal | null {
    const bound = this.deps.quietWaitMs()
    for (const l of this.store.unfreed()) {
      if (!l.returned || this.now() - Date.parse(l.returned) < bound) continue
      const by = this.held.get(l.id)
      if (by) return { why: 'stillInUse', copy: l.copy, by: by.by }
    }
    return null
  }

  /** What last held each returning lease back (the barrier's last look). */
  private readonly held = new Map<string, CopyHeld>()

  /**
   * The lease operation (`token` holds the copy): made if new or gone, reset to the revision, installed again if its
   * lock files changed; then `leased`. A failure leaves it not ready with why (its lease dropped); a free copy whose
   * folder git doesn't list is passed over (marked gone); an operation taken over meanwhile stops.
   */
  private async reset(copy: Copy, lease: CopyLease, token: string, fresh: boolean): Promise<'ready' | 'skip' | 'returned' | CopyRefusal> {
    const name = copy.name
    const fail = async (error: string, logPath: string | null = null): Promise<CopyRefusal> => {
      log.warn(`Copy ${userText(name)} of ${userText(this.deps.project)} isn't ready: ${userText(error)}`)
      await this.store.fenced(name, token, (db) => {
        this.store.dropIn(db, lease.id, 'setupFailed')
        this.store.setIn(db, name, 'creating', { warmError: error, warmLog: logPath }, { op: null })
      })
      return { why: 'setupFailed', copy: name, error, log: logPath }
    }
    try {
      if (this.closed) {
        if (fresh) return await fail(sayStored(T.closed))
        await this.store.fenced(name, token, (db) => {
          this.store.dropIn(db, lease.id, 'closed')
          this.store.setIn(db, name, copy.state, {}, { op: null })
        })
        return { why: 'noCopy', size: 0 }
      }
      const opts = await this.deps.options()
      // HI-1182: with the setting on, Combwork's checkouts here leave LFS files for the step below.
      const filesOn = opts.gitFiles !== false && !!this.port.files
      let made = fresh || copy.state === 'gone' || !(await folderThere(copy.folder))
      const listed = made ? true : await this.listed(copy.folder)
      // Git can't list the worktrees (HI-2810): passed over as it was, its lease dropped, looked at again next time.
      if (listed === null) {
        await this.store.fenced(name, token, (db) => {
          this.store.dropIn(db, lease.id, 'cantList')
          this.store.setIn(db, name, copy.state, {}, { op: null })
        })
        return 'skip'
      }
      if (!listed) {
        await this.store.fenced(name, token, (db) => {
          this.store.dropIn(db, lease.id, 'gone')
          this.store.setIn(db, name, 'creating', { warmError: sayStored(T.notListed) }, { op: null })
        })
        return 'skip'
      }
      // Free since it was freed, not since now: a run or a process may have come into it since. Passed over (it stays as it
      // was, its lease dropped) while anything is in it; never reset under it.
      if (!made && (this.deps.runIn(copy.folder) || !(await quiet(copy.folder)))) {
        await this.store.fenced(name, token, (db) => {
          this.store.dropIn(db, lease.id, 'busy')
          this.store.setIn(db, name, copy.state, {}, { op: null })
        })
        return 'skip'
      }
      // Still this operation's, right before anything on disk changes.
      await this.store.fenced(name, token, () => undefined)
      const port = this.port
      if (!made && port.identity) {
        // A jj copy (HI-2795/s21 §3): reset only when healthy; stale, divergent or not this copy any more, disposed of and
        // made again, never reset or updated.
        // Owned (HR1, round 1): reset only as the copy recorded (its identity) by this operation (its fence); a replacement
        // or a lost operation is refused untouched, and dispose refuses a replacement too (its generation).
        const at = await port.resetTo(copy.folder, lease.revision, { identity: copy.identity ?? null, fence: this.fenceOf(name, token), skipSmudge: filesOn })
        if (!at.ok) {
          if (!(await this.dispose(copy, token))) return await fail(sayStored(T.checkout, { error: port.errorLine(at.err) || 'failed' }))
          made = true
        }
      }
      if (made) {
        await mkdir(this.deps.dir, { recursive: true })
        await port.prune(this.deps.project)
        const r = await port.create(this.deps.project, copy.folder, lease.revision, { skipSmudge: filesOn })
        if (!r.ok) return await fail(sayStored(T.worktreeAdd, { error: port.errorLine(r.err) || 'failed' }))
        if (port.identity) {
          const id = await port.identity(copy.folder)
          if (!id) return await fail(sayStored(T.identityUnread))
          await this.store.setIdentity(name, token, id)
        }
        if (opts.copy.trim()) await port.copyIgnored(this.deps.project, copy.folder, opts.copy).catch((e) => log.warn(`Could not copy files into ${userText(name)}`, e))
      } else if (!port.identity) {
        // The exact revision, and nothing else: tracked changes dropped, what isn't ignored removed (dependencies stay).
        const at = await port.resetTo(copy.folder, lease.revision, { skipSmudge: filesOn })
        if (!at.ok) return await fail(sayStored(at.failed === 'checkout' ? T.checkout : T.clean, { error: port.errorLine(at.err) || 'failed' }))
      }
      // HI-1182: its submodules and LFS files at exactly this revision, after every make or reset and before its setup (a
      // removed submodule's folder this copy cloned goes too); a folder that uses neither runs nothing.
      if (filesOn) {
        const files = port.files!
        const need = await files.needed(copy.folder, true)
        if (typeof need === 'object') return await fail(need.error)
        if (need) {
          const end = await this.run(name, token, { slot: name, of: 'copy', holder: lease.agent, what: 'gitFiles', command: files.title, folder: copy.folder, env: {}, files: { step: { folder: copy.folder, project: this.deps.project, disposable: true }, tool: files } })
          if (!end.settled) return await fail(sayStored(T.setupNotEnded), end.logPath)
          if (!end.ok) return await fail(end.error ?? (end.timedOut ? sayStored(T.setupTimedOut) : sayStored(T.setupExit, { code: String(end.exitCode) })), end.logPath)
        }
      }
      const hash = await lockHash(copy.folder)
      const needed = made || (hash !== null && hash !== copy.installHash)
      let fields: Partial<Pick<Copy, 'revision' | 'installHash' | 'warmError' | 'warmLog'>> = { revision: lease.revision, warmError: null, warmLog: null }
      if (needed) {
        // agent-protocol: the command run, not wording
        const command = opts.setup.trim() || (hash !== null && existsSync(join(copy.folder, 'package-lock.json')) ? 'npm ci' : '')
        if (command) {
          const end = await this.run(name, token, { slot: name, of: 'copy', holder: lease.agent, what: made ? 'setup' : 'install', command, folder: copy.folder, env: {} })
          if (!end.settled) return await fail(sayStored(T.setupNotEnded), end.logPath)
          if (!end.ok) return await fail(end.error ?? (end.timedOut ? sayStored(T.setupTimedOut) : end.spawnError ? sayStored(T.setupNoStart, { command }) : sayStored(T.setupExit, { code: String(end.exitCode) })), end.logPath)
        }
        fields = { ...fields, installHash: hash }
      }
      // Before the run (HI-2795/s21 §3): a jj copy handed over only exactly at its revision, recorded and read at one operation.
      if (port.copyIntact) {
        const now = this.store.copy(name) ?? copy
        const ok = await port.copyIntact(copy.folder, lease.revision, this.fenceOf(name, token), now.identity ?? null)
        if (ok !== true) return await fail(isUnknown(ok) ? sayStored(T.checkout, { error: ok.detail ?? ok.what }) : sayStored(T.notExact))
      }
      // The lease as it is now, in the write that ends the operation: returned meanwhile, the copy is returning, not lent.
      return await this.store.fenced(name, token, (db) => {
        const open = !!db.prepare('SELECT 1 FROM copy_leases WHERE id = ? AND returned_at IS NULL AND freed_at IS NULL').get(lease.id)
        this.store.setIn(db, name, open ? 'leased' : 'returning', fields, { op: null })
        return open ? ('ready' as const) : ('returned' as const)
      })
    } catch (e) {
      if (e instanceof OpLost) return { why: 'noCopy', size: 0 }
      return fail(e instanceof Error ? e.message : String(e)).catch(() => ({ why: 'noCopy' as const, size: 0 }))
    }
  }

  /** Whether the platform lists a workspace at `folder`; null when its listing fails (HI-2810, #734: unknown, never an empty one). */
  private async listed(folder: string): Promise<boolean | null> {
    const l = await this.port.list(this.deps.project).catch(() => null)
    return l ? l.some((w) => samePlace(w.path, folder)) : null
  }

  /** A command of an operation's, in a job recorded on the copy first and cleared once settled (as slots' runs). */
  private async run(name: string, token: string, r: { slot: string; of: 'copy'; holder: string | null; what: 'setup' | 'install' | 'gitFiles'; command: string; folder: string; env: Record<string, string>; files?: SlotRun['files'] }): Promise<SlotRunEnd> {
    const job = newJob()
    await this.store.fenced(name, token, (db) => db.prepare('UPDATE copies SET job = ? WHERE project = ? AND name = ?').run(job, this.store.project, name))
    const end = await this.deps.runner({ ...r, job, signal: this.life.signal })
    if (end.settled) await this.store.fenced(name, token, (db) => db.prepare('UPDATE copies SET job = NULL WHERE project = ? AND name = ? AND job = ?').run(this.store.project, name, job))
    return end
  }

  /** Records the job an isolated run's processes are put in, before any is. False when the lease is returned already. */
  setLeaseJob(lease: string): Promise<string | null> {
    const job = `copy-${lease}`
    return this.store.setLeaseJob(lease, job).then((ok) => (ok ? job : null))
  }

  /** A check lease's run, once it starts. */
  setRef(lease: string, ref: string): Promise<void> {
    return this.store.setRef(lease, ref)
  }

  /**
   * Returns a lease (a verdict, a review given up, the run's end, its holder's session ended): the copy `returning`,
   * then freed only through the barrier (tried at once, and again on every refresh). Whether it was open.
   */
  async returnCopy(lease: string, why: string): Promise<boolean> {
    const l = await this.store.returnLease(lease, why)
    if (!l) return false
    if (await this.tryFree(l.copy)) this.soon(l.copy)
    return true
  }

  /** The copies being tried again soon (soon), with their timers. */
  private readonly retrying = new Map<string, NodeJS.Timeout>()

  /**
   * A returned copy held back as it was returned (its run's processes still ending, a handle not let go yet): tried again
   * after RETRY_MS, then each wait twice the last, until freed or no longer returning; the pools' looks (every 30 s) go on
   * after (HI-1764: freed within seconds of its run ending, not at the next look).
   */
  private soon(name: string, at = 0): void {
    if (this.closed || at >= RETRY_MS.length || this.retrying.has(name)) return
    const t = setTimeout(() => {
      this.retrying.delete(name)
      if (this.closed) return
      const p = this.tryFree(name).then(
        (held) => {
          if (held) this.soon(name, at + 1)
        },
        (e) => log.warn(`freeing ${userText(name)}`, e)
      )
      this.running.add(p)
      void p.finally(() => this.running.delete(p))
    }, RETRY_MS[at])
    t.unref?.()
    this.retrying.set(name, t)
  }

  /** The copies not free now, for a wait's reply: each lease not freed, since when, and what last held a returning one back. */
  inUse(): { copy: string; kind: CopyKind; card: number; from: string; returned: string | null; by: string | null }[] {
    return this.store.unfreed().map((l) => ({ copy: l.copy, kind: l.kind, card: l.card, from: l.from, returned: l.returned, by: l.returned ? (this.held.get(l.id)?.by ?? null) : null }))
  }

  /**
   * The quiescence barrier for a returning copy: freed only when, in order, no run is in it, its lease's job is settled,
   * (a review's) its holder is idle, and no process holds its folder. What holds it back, or null once freed (or nothing
   * to free). A check's holder isn't waited for (HI-1764): every process of its run is in its job, so a builder busy with
   * its card (as one in a card loop always is) kept each check copy it had used, and reviewers got none.
   */
  async tryFree(name: string): Promise<CopyHeld | null> {
    const c = this.store.copy(name)
    const l = this.store.leaseOn(name)
    if (!c || !l || !l.returned || c.state !== 'returning' || c.op) return null
    const hold = (h: CopyHeld): CopyHeld => (this.held.set(l.id, h), h)
    const run = this.deps.runIn(c.folder)
    if (run) return hold({ why: 'run', by: run })
    if (l.job && !(await this.deps.settle(l.job))) return hold({ why: 'job', by: sayStored(T.heldJob, { job: l.job }) })
    if (l.agent && l.kind === 'review') {
      const busy = this.deps.holderBusy(l.agent)
      if (busy) return hold({ why: 'holder', by: busy })
    }
    if ((await folderThere(c.folder)) && !(await quiet(c.folder))) return hold({ why: 'process', by: sayStored(T.heldProcess) })
    const port = this.portOf(c)
    if (port.copyIntact) {
      // HI-2795/s21 §3: every consumer ended, its result taken against the files now, under a verification operation; the
      // result and the copy's freeing in one write, so no credit or reuse can race it.
      const token = newToken()
      await this.op(token, async () => {
        if (!(await this.store.startVerify(name, token, await this.deps.holder.self()))) return
        try {
          const ok = await port.copyIntact!(c.folder, l.revision, this.fenceOf(name, token), c.identity ?? null)
          if (await this.store.freeVerified(l.id, name, token, ok === true)) this.held.delete(l.id)
        } catch (e) {
          if (!(e instanceof OpLost)) throw e
        }
      })
      return null
    }
    if (await this.store.free(l.id, name)) this.held.delete(l.id)
    return null
  }

  /**
   * Brings the rows in step: an operation whose holder is gone taken over (a lease's reset failed: never ready; a
   * removal looked at again), a copy-level job settled, a lease whose Combwork is gone or (this Combwork's) whose review or run
   * is over returned, returning copies tried through the barrier, a free copy whose folder is gone marked gone.
   */
  async refresh(): Promise<void> {
    await this.releaseStaleDelete()
    for (const c of this.store.copies()) {
      if (this.closed) return
      if (c.op) {
        if (await this.holderGone(c.op.pid, c.op.started, c.op.token)) await this.recover(c)
        continue
      }
      if (c.job && (await this.deps.settle(c.job))) await this.store.jobSettled(c.name, c.job)
    }
    const me = await this.deps.holder.self()
    for (const l of this.store.unfreed()) {
      if (l.returned) continue
      const mine = l.pid === me.pid && l.started === me.started
      const over = mine ? await this.deps.leaseOver(l) : (await this.deps.holder.alive(l.pid, l.started)) === false
      if (over === true) await this.store.returnLease(l.id, mine ? 'over' : 'combworkGone')
    }
    for (const c of this.store.copies()) {
      // HI-2936: one whose platform has no port here is kept as it is until it has one.
      if (c.state === 'returning' && this.hasPort(c)) await this.tryFree(c.name)
      else if (c.state === 'free' && !(await folderThere(c.folder))) await this.store.markGone(c.name)
    }
  }

  /** A Delete's reservation whose holder is gone (#1447), as the slots' pool releases it: whole, in one write. */
  private async releaseStaleDelete(): Promise<void> {
    const project = this.store.project
    const d = this.store.conn.read((db) => deletingIn(db, project))
    if (!d || (d.token && !(await this.holderGone(d.pid, d.started, d.token)))) return
    await this.store.conn.write((db) => {
      if (deletingIn(db, project)?.token === d.token) releaseDeleteIn(db, project, d.token)
    })
    log.warn(`Released a Delete's hold on the project's slots and copies: process ${d.pid}, which held it, is gone`)
  }

  /** Takes over an operation whose holder is gone, from inside an operation of this pool's (eligibility re-checked there). */
  private async recover(c: Copy): Promise<void> {
    const was = c.op!
    // A Delete's (#1447): never taken over copy by copy, only released whole (`releaseStaleDelete`).
    if (this.store.conn.read((db) => deletingIn(db, this.store.project))?.token === was.token) return
    const token = newToken()
    await this.op(token, async () => {
      const now = this.store.copy(c.name)
      if (!now?.op || now.op.token !== was.token || !(await this.holderGone(now.op.pid, now.op.started, now.op.token))) return
      if (!(await this.store.takeOver(c.name, was.token, token, await this.deps.holder.self()))) return
      log.warn(`Taking over copy ${userText(c.name)}'s ${was.kind} from process ${was.pid}, which is gone`)
      try {
        const settled = !c.job || (await this.deps.settle(c.job))
        const job = settled ? { job: null } : {}
        // A verification cut short (HI-2795): back to returning, not freed, its lease's result still null; verified again.
        if (was.kind === 'recover') {
          await this.store.fenced(c.name, token, (db) => this.store.setIn(db, c.name, 'returning', {}, { op: null, ...job }))
          return
        }
        if (was.kind === 'lease') {
          await this.store.fenced(c.name, token, (db) => {
            const l = db.prepare('SELECT id FROM copy_leases WHERE project = ? AND copy = ? AND freed_at IS NULL').get(this.store.project, c.name) as { id: string } | undefined
            if (l) this.store.dropIn(db, l.id, 'interrupted')
            this.store.setIn(db, c.name, 'creating', { warmError: sayStored(INTERRUPTED) }, { op: null, ...job })
          })
          return
        }
        const to: CopyState = (await folderThere(c.folder)) ? 'free' : 'gone'
        await this.store.fenced(c.name, token, (db) => this.store.setIn(db, c.name, to, {}, { op: null, ...job }))
      } catch (e) {
        if (!(e instanceof OpLost)) throw e
      }
    })
  }

  /** Removes a copy, guarded: kept (why) with a lease not freed, an operation or job, a run or a process in it. Null once removed. */
  async remove(name: string): Promise<CopyHeld | { why: 'leased' | 'busy' } | null> {
    const c = this.store.copy(name)
    if (!c) return null
    if (this.store.leaseOn(name)) return { why: 'leased' }
    if (c.op || c.job) return { why: 'busy' }
    const token = newToken()
    return this.op(token, async () => {
      if (!(await this.store.startOp(name, 'remove', c.state, token, await this.deps.holder.self()))) return { why: 'busy' as const }
      const keep = async <T>(k: T): Promise<T> => {
        await this.store.fenced(name, token, (db) => this.store.setIn(db, name, c.state, {}, { op: null })).catch((e) => {
          if (!(e instanceof OpLost)) throw e
        })
        return k
      }
      try {
        const run = this.deps.runIn(c.folder)
        if (run) return await keep({ why: 'run' as const, by: run })
        if (await folderThere(c.folder)) {
          if (!(await quiet(c.folder))) return await keep({ why: 'process' as const, by: sayStored(T.heldProcess) })
          await this.store.fenced(name, token, () => undefined)
          // A copy holds nobody's work (detached at a revision): its build outputs go with it. A jj copy (HI-2795): forgotten
          // and trashed, journalled; a removal part done keeps the copy out of the pool, never lent, until it's finished.
          const port = this.portOf(c)
          const r = port.identity ? await port.remove(this.deps.project, c.folder, { force: true, identity: c.identity ?? null, journal: this.removalJournal(name), fence: this.fenceOf(name, token) }) : await port.remove(this.deps.project, c.folder, { force: true })
          if (!r.ok && port.identity && this.removalJournal(name).read()) {
            await this.store.fenced(name, token, (db) => this.store.setIn(db, name, 'creating', { warmError: sayStored(T.removalCutShort) }, { op: null })).catch((e) => {
              if (!(e instanceof OpLost)) throw e
            })
            return { why: 'busy' as const }
          }
          if (!r.ok) return await keep({ why: 'busy' as const })
        } else if (this.portOf(c).identity && this.removalJournal(name).read()) {
          // Forgotten and trashed before a stop (HI-2795): only its journal left.
          await this.removalJournal(name).clear()
        } else await this.portOf(c).prune(this.deps.project)
        await this.store.fenced(name, token, (db) => db.prepare('DELETE FROM copies WHERE project = ? AND name = ?').run(this.store.project, name))
        log.info(`Removed copy ${userText(name)} (${userText(c.folder)})`)
        return null
      } catch (e) {
        if (e instanceof OpLost) return { why: 'busy' as const }
        log.warn(`Removing copy ${userText(name)}`, e)
        return keep({ why: 'busy' as const })
      }
    })
  }

  /** Removes copies beyond the pool's size unused for a day (oldest first), and copies whose setup failed. */
  async tidy(at: number = this.now(), removeIdle = true): Promise<string[]> {
    if (!removeIdle) return []
    await this.refresh()
    const size = await this.deps.size()
    const all = this.store.copies()
    const removed: string[] = []
    const free = (c: Copy): boolean => !c.op && !c.job && !this.store.leaseOn(c.name)
    for (const c of all.filter((x) => x.state === 'creating' && x.warmError && free(x))) if (!(await this.remove(c.name))) removed.push(c.name)
    // HI-2936: another platform's copies, left by a switch of the project's, are never reused: each removed once idle (by
    // its own port), and none counted against this platform's size.
    const mine = (c: Copy): boolean => (c.platform ?? 'git') === this.port.platform
    for (const c of all.filter((x) => !mine(x) && !removed.includes(x.name) && (x.state === 'free' || x.state === 'gone') && free(x) && at - Date.parse(x.usedAt) >= IDLE_MS && this.hasPort(x))) if (!(await this.remove(c.name))) removed.push(c.name)
    const own = all.filter(mine)
    let over = own.filter((c) => !removed.includes(c.name)).length - size
    for (const c of own.filter((x) => (x.state === 'free' || x.state === 'gone') && free(x) && at - Date.parse(x.usedAt) >= IDLE_MS).sort((a, b) => a.usedAt.localeCompare(b.usedAt))) {
      if (over <= 0) break
      if (!(await this.remove(c.name))) {
        removed.push(c.name)
        over--
      }
    }
    return removed
  }
}

// --- Isolated runs' copies, asked for apart from the request that asks.

/** A request's answer: the leased copy, `wait` (none free yet: asked again later), or why not. */
export type RequestAnswer<T> = T | { wait: string } | { refused: Said }

/** A copy being leased for an isolated run (#1435): whose, for what, its answer once there, and when it was last asked about. */
interface Pending<T> {
  owner: string
  project: string
  asks: string
  result: RequestAnswer<T> | null
  polled: number
  /**
   * Out of the map (#1499): evicted, abandoned, or its workspace closed. Its lease, when one comes, is given back then
   * (`returned`: once), so a set-up that finishes after its request was dropped never keeps a copy nobody can find.
   */
  gone?: boolean
  returned?: boolean
  /** Stops following its workspace's closing. */
  unlisten?: () => void
}

/** Requests at most at once (the oldest go, a copy of theirs given back). */
const MAX_REQUESTS = 100
/** A copy leased for a request nobody asked about for this long is given back (cw-progress gone, or given up). */
export const ABANDON_MS = 60_000
/** How long the first ask waits for its answer before saying to wait (the rest comes by asking again). */
export const FIRST_WAIT_MS = 2000

/**
 * Isolated runs' copies leased and set up apart from the Agent API's request that asks for them (HR1's #1435 round 1: a
 * first setup takes minutes, longer than any request may): the first ask starts the lease and answers within
 * FIRST_WAIT_MS, with the copy or `wait` and a ticket; asked again with the ticket (cw-progress asks every 2 s), the
 * copy once ready. A ticket is its asker's alone and for what it asked (another's, or for something else, starts anew).
 * A copy nobody collects within ABANDON_MS of the last ask is given back (`abandon`, on each look).
 */
export class IsolatedRequests<T extends { lease: CopyLease }> {
  private readonly pending = new Map<string, Pending<T>>()

  constructor(
    private readonly giveBack: (project: string, lease: CopyLease) => void,
    private readonly now: () => number = Date.now,
    private readonly firstWaitMs = FIRST_WAIT_MS
  ) {}

  get size(): number {
    return this.pending.size
  }

  /** `life`: the asking workspace's lifetime; its closing drops the request (its copy given back once it has one). */
  async ask(owner: string, project: string, asks: string, lease: () => Promise<RequestAnswer<T>>, ticket?: string, life?: AbortSignal): Promise<T | { wait: string; ticket: string } | { refused: Said }> {
    const known = ticket ? this.pending.get(ticket) : undefined
    let t = known && known.owner === owner && known.asks === asks ? ticket! : null
    if (!t) {
      if (life?.aborted) return { refused: sayWithId(T.closed) }
      while (this.pending.size >= MAX_REQUESTS) this.drop(this.pending.keys().next().value!)
      const id = `t-${randomBytes(8).toString('hex')}`
      t = id
      const p: Pending<T> = { owner, project, asks, result: null, polled: this.now() }
      this.pending.set(id, p)
      if (life) {
        const closed = (): void => this.drop(id)
        life.addEventListener('abort', closed, { once: true })
        p.unlisten = () => life.removeEventListener('abort', closed)
      }
      const leasing = lease().then(
        (got) => this.settled(p, got),
        (e: Error) => this.settled(p, { refused: { said: sayStored(T.notLeased, { error: e.message }), id: T.notLeased.id } })
      )
      let timer: NodeJS.Timeout | undefined
      await Promise.race([leasing, new Promise<void>((res) => (timer = setTimeout(res, this.firstWaitMs)))])
      clearTimeout(timer)
    }
    const p = this.pending.get(t)
    if (!p) return { wait: say(T.waitCopy), ticket: '' }
    p.polled = this.now()
    if (!p.result) return { wait: say(T.waitSetup), ticket: t }
    this.pending.delete(t)
    p.unlisten?.()
    // None free yet: the next ask starts anew (no ticket).
    if ('wait' in p.result) return { wait: p.result.wait, ticket: '' }
    return p.result
  }

  /** Gives back the copies nobody asked about for ABANDON_MS (a set-up still under way is left to finish first). */
  abandon(): void {
    for (const [t, p] of [...this.pending]) if (p.result && this.now() - p.polled > ABANDON_MS) this.drop(t)
  }

  /** A request's set-up has finished: kept for its next ask, or, dropped meanwhile, its copy given back. */
  private settled(p: Pending<T>, got: RequestAnswer<T>): void {
    p.result = got
    if (p.gone) this.giveBackOnce(p)
  }

  /** Drops a request: its copy given back now if it has one, else when its set-up finishes (settled). */
  private drop(ticket: string): void {
    const p = this.pending.get(ticket)
    if (!p) return
    this.pending.delete(ticket)
    p.unlisten?.()
    p.gone = true
    this.giveBackOnce(p)
  }

  private giveBackOnce(p: Pending<T>): void {
    if (p.returned || !p.result || !('lease' in p.result)) return
    p.returned = true
    this.giveBack(p.project, (p.result as T).lease)
  }
}
