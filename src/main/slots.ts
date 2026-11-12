// A project's slot pool (#1429, SPEC §16.10.1–16.10.2): the worktrees Combwork lends to a card or a lane (a dispatch lease)
// and gets back when it ends, kept ready between loans. Slots and leases are typed rows of combwork.db (schema/v1_0.ts,
// SLOTS_STEP): at most one open lease per slot, and one open dispatch lease and one carried lease per agent, by partial
// unique indexes, so two Combworks (or processes) lending at once can't both get one slot, however their code races; the
// second is refused ("slot-b is in use by HI-B1 for AM-12").
//
// Operations. Whatever changes a slot outside one write (warming it for a lease, removing it) is an operation that owns
// the slot (`op` on its row) from the write that starts it to the write that ends it: its token, kind and holder process
// (pid and start). Every write it makes is fenced on its token (OpLost otherwise: it stops, writing nothing more and
// touching nothing on disk), and nothing else starts an operation, lends, adopts or removes the slot while it is held.
// Another Combwork (or this one, for a token it no longer runs: a workspace closed and opened again) takes an operation
// over only once its holder process is gone, and only after settling its job: a command an operation runs is recorded
// (`job`, its job on the process supervisor) before it starts and cleared only once its processes are seen ended; until
// then the slot isn't lent, also after the operation ended (a job that couldn't be emptied), and `refresh` settles it
// again. A warming taken over is failed (its lease ended `interrupted`, the slot not ready: never reported ready);
// a removal taken over is looked at again (ready, dirty or gone).
//
// - Lending reserves a ready slot (the builder's last, then the most recently used) with its lease and a warming
//   operation in one write, or a new one (`slot-a`, `slot-b`…: skipping names in use, folders on disk such as the merge
//   queue's, and `copies`) while the pool is under its size (the builders, at most the agent cap). It is handed over only
//   once the operation has looked at it again (a free slot may have changed since it was released: dirty, a session or
//   a process in it; then it is marked so and another is tried), made it if new (a detached worktree at the target's
//   head, the project's copied files, its setup as one of Combwork's runs, "Combwork (slot slot-b)"), recreated it if gone, and
//   installed again when its lock files changed. A failed setup leaves it not ready, with the run's log: lending skips
//   it. The same card asking again gets its lease only once the slot is ready (`warming` while another Combwork warms it).
// - A carried lease (#1441: an agent's migrated worktree) protects its slot: never lent to anyone else, nor cleaned up,
//   while it is open, even while its agent holds a dispatch lease elsewhere. Adopting one is refused while the slot has
//   an operation or a job, or when its recorded folder is another.
// - Releasing ends the lease; the slot is looked at once no operation holds it: `dirty` (uncommitted or untracked files
//   that aren't ignored, not lent until clean), `gone`, or `ready`. A leased slot gone from disk is marked `gone`.
// - Removal (the one way a slot goes) is an operation: guarded (never with a session or a process in it, the latter
//   proved by renaming its folder aside and back, an open lease, a queue entry in flight for a card it held,
//   uncommitted or untracked files, or a head the target doesn't contain: §16.3.2, squash merges included), the archive
//   command first (its failure, or processes it left that couldn't be ended, keep the slot), the guards again, a fenced
//   check that it still holds the slot, then git's own removal, never forced. Idle slots beyond the pool's size go so
//   (`tidy`, Settings → Advanced, Remove idle slots after a day).
//
// What a lease means for where an agent works (launch, resume, one writer per slot) is #1434's folder contract
// (agentFolders.ts), and lending for a card's start is #1438's: this module only keeps the pool.

import { createHash, randomBytes } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { admitOrThrow } from './platform/fenceAdmit'
import { existsSync } from 'original-fs'
import { mkdir, readdir, readFile, rename } from 'original-fs/promises'
import { dirname, join } from 'path'
import { BOARD_MIGRATIONS } from './boardStore'
import { openDb } from './db'
import { samePlace } from './fsutil'
import { withFolderRepoLocks } from './platform/repoPorts'
import { createLogger, userText } from './logger'
import { lineHistory } from './platform/historyPorts'
import { isUnknown, type Maybe } from './platform/types'
import type { FenceDb, WorkspaceFence, WorkspaceFiles, WorkspaceFilesStep, WorkspaceIdentity, WorkspaceJournal, WorkspacePlatform, WorkspacePort, WorkspaceStep } from './platform/workspacePort'
import { slotWorkspaces, workspacePortOf } from './platform/workspacePorts'
import { JJ_REFUSED } from './platform/jjWorkspacePort'
import { isJjLineKey } from './platform/jjSlotPrep'
import { isPlatformId } from '../shared/platform/descriptors'
import { agentMsg, inDefaultDialect, say, type AgentMsg, type AgentValues } from '../shared/agentText'
import { idleKey } from '../shared/laneBar'
import { cardRef } from '../shared/projectKeys'
import type { AppSettings, ProjectConfig, SlotRecovery, WorkspaceConfig } from '../shared/types'

/** A stale jj slot's recovery (HI-2866): what it did (HI-2996), or why it was refused (a protocol code). */
export type RecoverOutcome = { ok: true; recovered?: SlotRecovery } | { ok: false; why: string }
import { slotCopyOf, type SlotLevels } from '../shared/slotDefaults'
import { COPY_PREFIX } from './providers/common'

const log = createLogger('slots')

/** Ports each slot gets (CW_SLOT_PORT_BASE and the 9 after it), and where a project's blocks start. */
export const SLOT_PORTS = 10
export const PORT_FLOOR = 41000
/** How long a ready slot beyond the pool's size stays unused before `tidy` removes it. */
export const IDLE_MS = 24 * 60 * 60 * 1000
/** Lock files whose contents decide whether a slot's dependencies are installed again. */
const LOCK_FILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']
/** Folder names in a project's worktrees folder a slot never takes: #1435's review and check copies. */
const RESERVED = new Set(['copies'])
/** What a warming taken over from a holder that is gone leaves as its error (never ready): stored, so said in the Default. */
export const INTERRUPTED = agentMsg({ id: 'slot.error.interrupted', text: 'its setup was interrupted', note: "A slot's setup error, kept on the slot, when the setup was taken over from a Combwork that is gone (#1429). Read by agents and in the log." })
/** Why nothing is lent or made while the project's Delete holds its slots (#1447). */
export const DELETING = agentMsg({ id: 'slot.error.deleting', text: 'the project is being deleted', note: 'Why a slot isn\'t ready: the project\'s Delete holds its slots (#1447). The end of slot.refusal.notReady ("… isn\'t ready (…)").' })

/** Text kept on a slot, a lease or a card for any reader (dialects, HI-2065): said in the Default. */
const sayStored = (m: AgentMsg, values?: AgentValues): string => inDefaultDialect(() => say(m, values))

/** The slot pool's agent text (dialects, HI-2447): refusals, waits and the errors kept on a slot. */
const T = {
  lane: agentMsg({ id: 'slot.refusal.lane', text: 'lane {lane}', note: 'What a slot is lent for when it is a lane, not a card: the end of slot.refusal.inUse and slot.refusal.agentLeased.' }),
  aSlot: agentMsg({ id: 'slot.refusal.aSlot', text: 'a slot', note: 'The slot named in slot.refusal.notReady when the start named none and the project is being deleted ("a slot isn\'t ready (the project is being deleted)").' }),
  noSlot: agentMsg({ id: 'slot.refusal.noSlot', text: "no slot free: the pool's {size} {count, plural, =1 {slot is} other {slots are}} in use", note: "A start's wait: every slot of the pool is lent. {size} is the pool's size as digits; {count} the same number, choosing the plural." }),
  inUse: agentMsg({ id: 'slot.refusal.inUse', text: '{slot} is in use by {agent} for {what}', note: "A start's wait: the slot named is lent to another agent. {what} is the card's key or slot.refusal.lane." }),
  agentLeased: agentMsg({ id: 'slot.refusal.agentLeased', text: 'this agent already builds in {slot} for {what}', note: 'A start refused: one agent, one slot (HI-1762). {what} is the card\'s key or slot.refusal.lane.' }),
  warming: agentMsg({ id: 'slot.refusal.warming', text: '{slot} is being set up', note: "A start's wait: the slot's setup is running." }),
  kept: agentMsg({ id: 'slot.refusal.kept', text: "{slot} holds this card's committed work from before it was put back, kept for it there: it gets that slot back, never a fresh one ({why})", note: "HI-2995: a jj card's start refused while its own earlier work is kept in a slot that can't be lent back to it now. {why} is slot.kept.*." }),
  keptBusy: agentMsg({ id: 'slot.kept.busy', text: 'something works in it now', note: 'HI-2995: why a kept slot (slot.refusal.kept) is not lent back now: an operation, a session or a process holds it.' }),
  keptStale: agentMsg({ id: 'slot.kept.stale', text: "its binding isn't this card's at the folder's generation any more: recover or remove the slot", note: "HI-2995: why a kept slot (slot.refusal.kept) can't be lent back: jj's record of the slot no longer names the card." }),
  keptGone: agentMsg({ id: 'slot.kept.gone', text: 'its folder is gone', note: "HI-2995: why a kept slot (slot.refusal.kept) can't be lent back: its folder was deleted." }),
  keptOther: agentMsg({ id: 'slot.kept.other', text: 'another slot was asked for', note: 'HI-2995: why a kept slot (slot.refusal.kept) is not the one lent: the start named another slot.' }),
  busy: agentMsg({ id: 'slot.refusal.busy', text: "{held, select, session {{slot} still has a session in it} process {{slot} still has a process running in it (a file or a folder in it open)} broker {{slot} still has a process running in it (a file or a folder in it open): Windows Sandbox's broker ({name}) is working in it{idle, select, yes {, with no Sandbox running} no {, with a Sandbox running} other {}}} other {{slot} has a session or a process in it}}", note: "A start's wait: something still runs in a free slot, so it isn't lent (HI-2466: held, what: a session, a process, or not known). broker (HI-2467): Windows Sandbox's broker ({name}: its process name, such as WindowsSandboxServer) has the slot as its current folder; idle: yes, no Sandbox runs; no, one does; other, not known. Combwork tries again until it is free." }),
  notReady: agentMsg({ id: 'slot.refusal.notReady', text: "{slot} isn't ready ({why})", note: "A start's wait or refusal: the slot isn't ready. {why} is its setup's error, else its state." }),
  setupFailed: agentMsg({ id: 'slot.refusal.setupFailed', text: "{slot}'s setup failed: {error}", note: "A start refused: the slot's setup failed. {error} is why (one of slot.error.*, git's or the command's)." }),
  opLost: agentMsg({ id: 'slot.error.opLost', text: 'the operation no longer holds {slot}', note: "An operation on a slot stopped because another took the slot over (#1429). Caught by the pool; in the log if it ever escapes." }),
  takeoverGone: agentMsg({ id: 'slot.takeover.gone', text: 'is gone', note: "Why the slot a builder's own run still writes in can't be taken over by its start (HI-1787): the end of slot.start.ownSlotWaits after the slot's name." }),
  takeoverBusy: agentMsg({ id: 'slot.takeover.busy', text: 'is being set up or changed', note: 'As slot.takeover.gone: an operation holds the slot.' }),
  takeoverJob: agentMsg({ id: 'slot.takeover.job', text: 'has a command of its own running', note: 'As slot.takeover.gone: a command of the slot\'s (its setup, an archive) runs.' }),
  takeoverSetupFailed: agentMsg({ id: 'slot.takeover.setupFailed', text: "couldn't be set up", note: 'As slot.takeover.gone: its setup failed.' }),
  takeoverNotReady: agentMsg({ id: 'slot.takeover.notReady', text: "isn't ready ({state})", note: "As slot.takeover.gone: the slot isn't lent. {state} is its state's id (ready, dirty…)." }),
  takeoverLent: agentMsg({ id: 'slot.takeover.lent', text: 'is lent again', note: 'As slot.takeover.gone: another lease has it.' }),
  takeoverOtherRun: agentMsg({ id: 'slot.takeover.otherRun', text: 'has another run in it now', note: 'As slot.takeover.gone: another run writes there now.' }),
  takeoverOtherCombwork: agentMsg({ id: 'slot.takeover.otherCombwork', text: "is held by another Combwork's run", note: 'As slot.takeover.gone: a run of another Combwork (another profile) holds it.' }),
  takeoverHolds: agentMsg({ id: 'slot.takeover.holdsLease', text: "can't be taken over while its agent holds another lease", note: 'As slot.takeover.gone: one agent, one slot (HI-1762).' }),
  closed: agentMsg({ id: 'slot.error.closed', text: 'the workspace closed', note: "A slot's setup or preparation stopped: its workspace closed. Kept on the slot as its error." }),
  notListed: agentMsg({ id: 'slot.error.notListed', text: 'its folder is there but git does not list it as a worktree', note: "A slot's setup error: its folder exists but isn't a worktree git knows, so Combwork leaves it alone." }),
  gitRead: agentMsg({ id: 'slot.error.gitRead', text: "git couldn't read {what}", note: "A slot's setup or preparation error: git couldn't read a branch or HEAD. {what} is the branch's name, or HEAD." }),
  identityUnread: agentMsg({ id: 'slot.error.identityUnread', text: "its workspace's identity couldn't be read", note: "A slot's setup error (HI-2795): a jj workspace was made but its store, name or folder ids couldn't be read, so Combwork won't use or remove it." }),
  worktreeAdd: agentMsg({ id: 'slot.error.worktreeAdd', text: 'git worktree add: {error}', note: "A slot's setup error: `git worktree add` failed. {error} is git's first line, else failed." }),
  setupNotEnded: agentMsg({ id: 'slot.error.setupNotEnded', text: 'processes its setup started could not be ended', note: "A slot's setup error: its setup command ended, but processes it started are still running." }),
  setupTimedOut: agentMsg({ id: 'slot.error.setupTimedOut', text: 'its setup ran out of time', note: "A slot's setup error: its setup command reached its time limit (Settings → Advanced)." }),
  setupNoStart: agentMsg({ id: 'slot.error.setupNoStart', text: "its setup couldn't start: {command}", note: "A slot's setup error: its setup command couldn't be started. {command} is the command." }),
  setupExit: agentMsg({ id: 'slot.error.setupExit', text: 'its setup exited with code {code}', note: "A slot's setup error: its setup command failed. {code} is its exit code." }),
  leaseEnded: agentMsg({ id: 'slot.prepare.leaseEnded', text: 'its lease has ended', note: "Why a slot couldn't be prepared for its card: the lease it was lent under ended." }),
  prepareBusy: agentMsg({ id: 'slot.prepare.busy', text: '{slot} is busy: being set up, a command of its still running, or another session in it', note: "Why a slot's preparation for its card waits (#1438): something else has the slot now." }),
  branchUnread: agentMsg({ id: 'slot.prepare.branchUnread', text: "git couldn't read {slot}'s branch", note: "Why a slot couldn't be prepared for its card: git couldn't read the branch it is on." }),
  filesUnread: agentMsg({ id: 'slot.prepare.filesUnread', text: "git couldn't read {slot}'s files", note: "Why a slot couldn't be prepared for its card: git couldn't say whether it has changes." }),
  stale: agentMsg({ id: 'slot.prepare.stale', text: '{slot} is stale: another jj workspace rewrote its working copy. The user can recover it with Recover… under Slots and copies', note: "Why a jj slot couldn't be prepared for its card (HI-2913): another workspace rewrote its working-copy commit (a rebase of the card's commit, say), so its files are behind; recovering it is the user's action." }),
  uncommitted: agentMsg({ id: 'slot.prepare.uncommitted', text: "{slot} has changes that aren't committed", note: "Why a slot couldn't be prepared for its card: switching its branch would lose changes." }),
  switchFailed: agentMsg({ id: 'slot.prepare.switchFailed', text: 'git switch: {error}', note: "Why a slot couldn't be prepared for its card: `git switch` failed. {error} is git's first line, else failed." }),
  prepareTakenOver: agentMsg({ id: 'slot.prepare.takenOver', text: "{slot}'s preparation was taken over", note: "Why a slot's preparation for its card waits: another operation took the slot over (#1429)." }),
  archiveNotEnded: agentMsg({ id: 'slot.archive.notEnded', text: 'processes it started could not be ended', note: "Why a slot is kept, not removed: its archive command ended, but processes it started still run." }),
  archiveTimedOut: agentMsg({ id: 'slot.archive.timedOut', text: 'ran out of time', note: "Why a slot is kept, not removed: its archive command reached its time limit." }),
  archiveNoStart: agentMsg({ id: 'slot.archive.noStart', text: "couldn't start", note: "Why a slot is kept, not removed: its archive command couldn't be started." }),
  archiveExit: agentMsg({ id: 'slot.archive.exit', text: 'exited with code {code}', note: "Why a slot is kept, not removed: its archive command failed. {code} is its exit code." }),
  removeFailed: agentMsg({ id: 'slot.remove.failed', text: 'git worktree remove failed', note: "Why a slot is kept, not removed: `git worktree remove` refused and said nothing." }),
  noTarget: agentMsg({ id: 'slot.check.noTarget', text: 'no target branch', note: "Why Combwork can't tell whether a slot's work is merged: the project has no default branch." }),
  noBranch: agentMsg({ id: 'slot.check.noBranch', text: 'no {target}', note: "Why Combwork can't tell whether a slot's work is merged: its target branch doesn't exist. {target} is its name." }),
  noBase: agentMsg({ id: 'slot.check.noBase', text: 'no merge base with {target}', note: "Why Combwork can't tell whether a slot's work is merged: it shares no history with its target branch." })
}

export type SlotState = 'creating' | 'ready' | 'lent' | 'dirty' | 'gone' | 'removing'
export type LeaseKind = 'card' | 'lane' | 'carried'
export type OpKind = 'warm' | 'remove'

/** The operation that owns a slot now: its token, kind, the lease it warms for, and its holder process. */
export interface SlotOp {
  token: string
  kind: OpKind
  lease: string | null
  pid: number
  started: number
}

export interface Slot {
  /** The project's id (project.json's `id`): stable through renames. */
  project: string
  name: string
  folder: string
  state: SlotState
  portBase: number
  /**
   * The branch its last card's or lane's start named (SlotPool.serves, HI-2185), else the one it was made from: where its
   * lines merge, so a clean one waits detached at its head, and its clean-up checks its head is in it.
   */
  target: string | null
  /** Its last install's revision and lock files' hash (null: no lock file then). */
  installRev: string | null
  installHash: string | null
  /** Its last setup or install failed: why (in English, for the log and agents) and the run's log. Not lent meanwhile. */
  warmError: string | null
  warmLog: string | null
  createdAt: string
  usedAt: string
  op: SlotOp | null
  /** A command's job whose processes aren't known to have ended: the slot isn't lent while it is set. */
  job: string | null
  /**
   * The session that writes in it now (#1434, agentFolders.ts): its run, the lease and agent it started under, and its
   * Combwork (pid and start). Reserved in the write that lets it start, cleared once it has exited: while it is set the slot
   * isn't lent, adopted, taken by hand or removed, and its lease's end waits for it to drain.
   */
  writer: SlotWriter | null
  /**
   * The platform whose workspace it is (HI-2795: 'git' for every slot before, and Git's port's), so it settles, is
   * released and removed by that platform's port, and is lent only by a pool of that platform (R2.6). Absent: Git.
   */
  platform?: WorkspacePlatform
  /** Its workspace's identity where its platform records one (jj: store, name, creation generation); null for Git. */
  identity?: WorkspaceIdentity | null
}

/** A slot's writer (Slot.writer). */
export interface SlotWriter {
  run: string
  lease: string
  agent: string
  pid: number
  started: number
}

/** What settled a gone Combwork's writer (agentFolders.ts' GoneEvidence), or false: not settled. */
export type GoneSettled = false | { readonly run: string; readonly helper: string | null }

export interface SlotLease {
  id: string
  project: string
  slot: string
  kind: LeaseKind
  card: number | null
  lane: string | null
  /** The builder agent's id. */
  agent: string
  from: string
  to: string | null
  why: string | null
  /** The slot's head when it ended (#1434): its conversations may resume by hand while the slot is free and still there. */
  endRev: string | null
}

/** Why a lend was refused (#1438 turns `noSlot` and `warming` into "waiting for a slot"). */
export type SlotRefusal =
  | { why: 'noSlot'; size: number }
  | { why: 'inUse'; slot: string; agent: string; card: number | null; lane: string | null }
  | { why: 'agentLeased'; slot: string; card: number | null; lane: string | null }
  | { why: 'warming'; slot: string }
  /**
   * HI-2466: what holds it, where the lend looked (a session in it, else a process: a file or folder in it open). HI-2467:
   * `broker` when Windows' own broker is seen working in it (`broker`: its name, and whether a Sandbox runs, null unknown).
   */
  | { why: 'busy'; slot: string; held?: SlotHeld; broker?: SlotBroker }
  | { why: 'notReady'; slot: string; state: SlotState; error: string | null }
  | { why: 'setupFailed'; slot: string; error: string; log: string | null }

/**
 * What holds a free slot so it can't be lent now (HI-2466): a session running in it, or another process; `broker`
 * (HI-2467): a process, and one of them is Windows' own broker, seen working in it (systemBrokers.ts).
 */
export type SlotHeld = 'session' | 'process' | 'broker'

/** The broker seen working in a held slot (HI-2467): its executable's name, and whether a Sandbox runs (null: not known). */
export interface SlotBroker {
  name: string
  idle: boolean | null
}

/** A held slot's refusal as a lend says it (HI-2467): a broker named where one is seen working in it, else a process. */
export async function processHeld(slot: string, folder: string, brokerIn: ((folder: string) => Promise<SlotBroker | null>) | undefined): Promise<Extract<SlotRefusal, { why: 'busy' }>> {
  const broker = brokerIn ? await brokerIn(folder).catch(() => null) : null
  return broker?.name ? { why: 'busy', slot, held: 'broker', broker } : { why: 'busy', slot, held: 'process' } // i18n-ignore: a refusal's codes (refusalText words them)
}

export type LendResult = { ok: true; lease: SlotLease; slot: Slot } | { ok: false; refusal: SlotRefusal }

/** What a card's preparation came to (#1438): done at a revision, not now (tried again), or not possible (why). */
/** `stale` (HI-2913): the error is a stale jj workspace's, which the user's Recover… mends. */
export type PrepareResult = { ok: true; revision: string } | { retry: string } | { error: string; logPath?: string | null; stale?: true }

/** Why a slot was kept rather than removed (its guards, §16.6.4 data safety). */
export type SlotKept =
  | { why: 'leased'; agent: string }
  | { why: 'session'; detail: string }
  | { why: 'process' }
  | { why: 'inFlight'; card: number }
  | { why: 'dirty'; files: number }
  | { why: 'unmerged'; target: string }
  | { why: 'cantCheck'; detail: string }
  | { why: 'archiveFailed'; error: string; log: string | null }
  | { why: 'busy'; state: SlotState }
  | { why: 'gitRefused'; detail: string }
  /** Combwork's skill copies removed first (#1500), `.agents/skills` still holds a `cw-*` folder: an edited copy, or the user's own. */
  | { why: 'editedSkillCopy'; copies: string[] }

/** A refusal in English, for agents and the log (the window words its own from the same fields). */
export function refusalText(r: SlotRefusal, name: (agent: string) => string = (a) => a, card: (n: number) => string = cardRef): string {
  const what = (c: number | null, l: string | null): string => (c !== null ? card(c) : say(T.lane, { lane: String(l) }))
  switch (r.why) {
    case 'noSlot':
      return say(T.noSlot, { size: String(r.size), count: r.size })
    case 'inUse':
      return say(T.inUse, { slot: r.slot, agent: name(r.agent), what: what(r.card, r.lane) })
    case 'agentLeased':
      return say(T.agentLeased, { slot: r.slot, what: what(r.card, r.lane) })
    case 'warming':
      return say(T.warming, { slot: r.slot })
    case 'busy':
      return say(T.busy, { slot: r.slot, held: r.held ?? 'other', name: r.broker?.name ?? '', idle: idleKey(r.broker?.idle) }) // i18n-ignore: select keys
    case 'notReady':
      return say(T.notReady, { slot: r.slot, why: r.error ?? r.state })
    case 'setupFailed':
      return say(T.setupFailed, { slot: r.slot, error: r.error })
  }
}

/** A slot's environment for its sessions and runs: its name and its block of SLOT_PORTS ports. */
export function slotEnv(slot: Pick<Slot, 'name' | 'portBase'>): Record<string, string> {
  return { CW_SLOT: slot.name, CW_SLOT_PORT_BASE: String(slot.portBase) }
}

/** The nth generic slot name (0: slot-a … 25: slot-z, 26: slot-aa…). */
export function slotName(n: number): string {
  let s = ''
  for (let k = n + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s
  return `slot-${s}`
}

/** The first generic name free: not a slot of the project's, not a folder in its worktrees folder, not reserved. */
export function nextSlotName(taken: ReadonlySet<string>, root: string): string {
  for (let n = 0; ; n++) {
    const name = slotName(n)
    if (!taken.has(name) && !RESERVED.has(name) && !existsSync(join(root, name))) return name
  }
}

/** The hash of a folder's lock files (names and contents), or null when it has none. */
export async function lockHash(folder: string): Promise<string | null> {
  const h = createHash('sha256')
  let any = false
  for (const f of LOCK_FILES) {
    const data = await readFile(join(folder, f)).catch(() => null)
    if (!data) continue
    any = true
    h.update(`${f}\0${data.length}\0`).update(data)
  }
  return any ? h.digest('hex') : null
}

/**
 * A project's slot options now: project.json's `slots`, else its setup from before 1.0 (`worktreeSetup`); its copy as it
 * inherits (shared/slotDefaults.ts: the project's, its workspace's, Combwork's, the default; HI-1765), `levels` those above.
 */
export function slotOptionsOf(cfg: Pick<ProjectConfig, 'slots' | 'worktreeSetup' | 'worktreeCopy'>, levels: SlotLevels): SlotOptionsNow {
  return {
    setup: cfg.slots?.setup ?? cfg.worktreeSetup ?? '',
    archive: cfg.slots?.archive ?? '',
    copy: slotCopyOf(cfg, levels).value,
    gitFiles: cfg.slots?.gitFiles !== false
  }
}

/** The slot defaults above a workspace's projects (HI-1765): Combwork's (`settings`), and that workspace's own, as they are now. */
export const slotLevelsOf = (settings: Pick<AppSettings, 'slotDefaults'>, ws: { config: WorkspaceConfig }): SlotLevels => ({ global: settings.slotDefaults, workspace: ws.config.slotDefaults })

// --- The store.

/** The database a pool's store reads and writes: the board's in the app, a file's own in tests and other processes. */
export interface SlotConn {
  read<T>(fn: (db: DatabaseSync) => T): T
  /** One transaction (the app's boardWrite): the second of two at once waits for the first. */
  write<T>(fn: (db: DatabaseSync) => T): Promise<T>
  close(): void
}

/** A connection of its own to a workspace database's file (another process; tests): each write BEGIN IMMEDIATE. */
export function fileSlotConn(file: string): SlotConn {
  const db = openDb(file, { migrations: BOARD_MIGRATIONS, appVersion: 'slots' })
  const tx = <T>(begin: string, fn: (d: DatabaseSync) => T): T => {
    db.writer.exec(begin)
    try {
      const out = fn(db.writer)
      db.writer.exec('COMMIT')
      return out
    } catch (e) {
      if (db.writer.isTransaction) db.writer.exec('ROLLBACK')
      throw e
    }
  }
  return {
    read: (fn) => tx('BEGIN', fn),
    write: (fn) => Promise.resolve().then(() => tx('BEGIN IMMEDIATE', fn)),
    close: () => db.close()
  }
}

/** An operation no longer holds its slot (another took it over, or it ended): it stops, writing nothing more. */
export class OpLost extends Error {
  constructor(readonly slot: string) {
    super(say(T.opLost, { slot }))
  }
}

type Row = Record<string, string | number | null>
const slotOfRow = (r: Row): Slot => ({
  project: r.project as string,
  name: r.name as string,
  folder: r.folder as string,
  state: r.state as SlotState,
  portBase: r.port_base as number,
  target: (r.target as string | null) ?? null,
  installRev: (r.install_rev as string | null) ?? null,
  installHash: (r.install_hash as string | null) ?? null,
  warmError: (r.warm_error as string | null) ?? null,
  warmLog: (r.warm_log as string | null) ?? null,
  createdAt: r.created_at as string,
  usedAt: r.used_at as string,
  op: r.op ? { token: r.op as string, kind: r.op_kind as OpKind, lease: (r.op_lease as string | null) ?? null, pid: (r.op_pid as number) ?? 0, started: (r.op_started as number) ?? 0 } : null,
  job: (r.job as string | null) ?? null,
  writer: r.writer_run ? { run: r.writer_run as string, lease: r.writer_lease as string, agent: r.writer_agent as string, pid: (r.writer_pid as number) ?? 0, started: (r.writer_started as number) ?? 0 } : null,
  platform: (r.platform as WorkspacePlatform | undefined) ?? 'git',
  identity: r.store && r.workspace && r.generation ? { store: r.store as string, workspace: r.workspace as string, generation: r.generation as string } : null
})
const leaseOfRow = (r: Row): SlotLease => ({
  id: r.id as string,
  project: r.project as string,
  slot: r.slot as string,
  kind: r.kind as LeaseKind,
  card: (r.card as number | null) ?? null,
  lane: (r.lane as string | null) ?? null,
  agent: r.agent as string,
  from: r.from_at as string,
  to: (r.ended_at as string | null) ?? null,
  why: (r.why as string | null) ?? null,
  endRev: (r.end_rev as string | null) ?? null
})

/** Which unique index a failed insert hit: a slot's open lease, an agent's, or a slot's name or folder. */
function constraintOf(e: unknown): 'slot' | 'agent' | 'name' | null {
  const m = e instanceof Error ? e.message : ''
  if (!/UNIQUE constraint failed/i.test(m)) return null
  if (/slot_leases\.slot/.test(m)) return 'slot'
  if (/slot_leases\.agent/.test(m)) return 'agent'
  if (/slots\./.test(m)) return 'name'
  return null
}

/** The process an operation's holder is: its pid and start. */
export interface Holder {
  pid: number
  started: number
}

/** Fields an operation's last write may set. */
type SlotFields = Partial<Pick<Slot, 'installRev' | 'installHash' | 'warmError' | 'warmLog' | 'target'>>
const COLUMN = { installRev: 'install_rev', installHash: 'install_hash', warmError: 'warm_error', warmLog: 'warm_log', target: 'target' } as const

/** A slot free to start an operation on: no operation, no job unsettled, no open lease. */
// agent-protocol: SQL
const FREE = 'op IS NULL AND job IS NULL AND writer_run IS NULL AND NOT EXISTS (SELECT 1 FROM slot_leases l WHERE l.project = slots.project AND l.slot = slots.name AND l.ended_at IS NULL)'

/** One project's slots and leases (its id), on a connection. Reads are one snapshot each; writes one transaction each. */
export class SlotStore {
  constructor(
    readonly conn: SlotConn,
    readonly project: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  private iso(): string {
    return this.now().toISOString()
  }

  slots(): Slot[] {
    return this.conn.read((db) => (db.prepare('SELECT * FROM slots WHERE project = ? ORDER BY name').all(this.project) as Row[]).map(slotOfRow))
  }

  slot(name: string): Slot | null {
    return this.conn.read((db) => this.slotIn(db, name))
  }

  private slotIn(db: DatabaseSync, name: string): Slot | null {
    const r = db.prepare('SELECT * FROM slots WHERE project = ? AND name = ?').get(this.project, name) as Row | undefined
    return r ? slotOfRow(r) : null
  }

  /** A slot's open lease, if any. */
  openLease(slot: string): SlotLease | null {
    return this.conn.read((db) => openLeaseIn(db, this.project, slot))
  }

  lease(id: string): SlotLease | null {
    return this.conn.read((db) => {
      const r = db.prepare('SELECT * FROM slot_leases WHERE id = ? AND project = ?').get(id, this.project) as Row | undefined
      return r ? leaseOfRow(r) : null
    })
  }

  /** The open lease of a card or a lane. */
  leaseOf(of: { card: number } | { lane: string }): SlotLease | null {
    return this.conn.read((db) => {
      const r = ('card' in of ? db.prepare('SELECT * FROM slot_leases WHERE card = ? AND ended_at IS NULL').get(of.card) : db.prepare('SELECT * FROM slot_leases WHERE lane = ? AND ended_at IS NULL').get(of.lane)) as Row | undefined
      return r && (r.project as string).toLowerCase() === this.project.toLowerCase() ? leaseOfRow(r) : null
    })
  }

  /** The project's open leases. */
  openLeases(): SlotLease[] {
    return this.conn.read((db) => (db.prepare('SELECT * FROM slot_leases WHERE project = ? AND ended_at IS NULL').all(this.project) as Row[]).map(leaseOfRow))
  }

  /** Leases of cards and lanes ended since `iso` (#1438: their merged lines are deleted once Done). */
  endedSince(iso: string): SlotLease[] {
    return this.conn.read((db) => (db.prepare('SELECT * FROM slot_leases WHERE project = ? AND ended_at IS NOT NULL AND ended_at >= ?').all(this.project, iso) as Row[]).map(leaseOfRow))
  }

  /** An agent's open leases: its dispatch lease and its carried lease, each at most one. */
  leasesOf(agent: string): SlotLease[] {
    return this.conn.read((db) => (db.prepare('SELECT * FROM slot_leases WHERE project = ? AND agent = ? AND ended_at IS NULL').all(this.project, agent) as Row[]).map(leaseOfRow))
  }

  /** The cards a slot was ever leased for, newest first (a queue entry in flight for one keeps it). */
  cardsOf(slot: string): number[] {
    return this.conn.read((db) => (db.prepare('SELECT card FROM slot_leases WHERE project = ? AND slot = ? AND card IS NOT NULL ORDER BY from_at DESC').all(this.project, slot) as { card: number }[]).map((r) => r.card))
  }

  /**
   * Reserves a slot for a lease in one write, with a warming operation (`token`, held by `holder`) on it: the one
   * named, else a ready, free one not in `skip` (the builder's last, then the most recently used), else a new one
   * (`creating`, its name and ports taken) while the project has fewer than `size`. The lease's row is in the same write,
   * so the indexes refuse a second open lease on the slot or for the agent. The same card or lane asking again gets its
   * lease and slot as they are (`again`): the caller checks it is ready.
   */
  async take(req: LeaseRequest, o: { size: number; root: string; target: string | null; token: string; holder: Holder; skip?: ReadonlySet<string>; platform?: WorkspacePlatform }): Promise<{ ok: true; lease: SlotLease; slot: Slot; fresh: boolean; again?: boolean; reclaim?: boolean } | { ok: false; refusal: SlotRefusal }> {
    try {
      return await this.conn.write((db) => {
        const at = this.iso()
        // The project being deleted (#1447): nothing lent or made until its reservation ends.
        if (deletingIn(db, this.project)) return { ok: false as const, refusal: { why: 'notReady' as const, slot: req.slot ?? say(T.aSlot), state: 'removing' as const, error: say(DELETING) } }
        // The platform fence (HI-2799): a lease is an admission on the project's repository, refused while it switches.
        admitOrThrow(db, this.project, o.platform ?? 'git')
        const mine = this.dispatchOf(db, req.agent)
        if (mine) {
          if ((req.card !== undefined && mine.card === req.card) || (req.lane !== undefined && mine.lane === req.lane)) return { ok: true as const, lease: mine, slot: this.slotIn(db, mine.slot)!, fresh: false, again: true }
          return { ok: false as const, refusal: { why: 'agentLeased' as const, slot: mine.slot, card: mine.card, lane: mine.lane } }
        }
        const held = req.card !== undefined ? (db.prepare('SELECT * FROM slot_leases WHERE card = ? AND ended_at IS NULL').get(req.card) as Row | undefined) : (db.prepare('SELECT * FROM slot_leases WHERE lane = ? AND ended_at IS NULL').get(req.lane!) as Row | undefined)
        if (held) return { ok: false as const, refusal: { why: 'inUse' as const, slot: held.slot as string, agent: held.agent as string, card: (held.card as number | null) ?? null, lane: (held.lane as string | null) ?? null } }
        const all = (db.prepare('SELECT * FROM slots WHERE project = ? ORDER BY name').all(this.project) as Row[]).map(slotOfRow)
        // HI-2995: a slot kept for this card (put back with its committed work) is the one it gets back, in this write,
        // only while it is still exactly as kept (dirty, the generation recorded, nothing in it), and never a fresh one
        // instead: its work would start again elsewhere without it.
        const kept = req.card !== undefined ? this.keptFor(db, req.card, all) : null
        if (kept) {
          const refuse = (why: AgentMsg) => ({ ok: false as const, refusal: { why: 'notReady' as const, slot: kept.slot.name, state: kept.slot.state, error: say(T.kept, { slot: kept.slot.name, why: say(why) }) } })
          if (req.slot && req.slot.toLowerCase() !== kept.slot.name.toLowerCase()) return refuse(T.keptOther)
          const k = kept.slot
          const skipped = !!o.skip?.has(k.name)
          const same = k.identity?.generation === kept.held.generation
          const free = (k.platform ?? 'git') === (o.platform ?? 'git') && k.state === 'dirty' && same && !k.op && !k.job && !k.writer && !openLeaseIn(db, this.project, k.name) && !db.prepare('SELECT 1 FROM board_meta WHERE key = ?').get(asideKey(this.project, k.name)) && !skipped
          if (!free) return refuse(same || skipped ? T.keptBusy : T.keptStale)
          const kid = `l-${randomBytes(6).toString('hex')}`
          const took = db.prepare(`UPDATE slots SET op = ?, op_kind = 'warm', op_lease = ?, op_pid = ?, op_started = ?, used_at = ? WHERE project = ? AND name = ? AND state = 'dirty' AND generation = ? AND ${FREE}`).run(o.token, kid, o.holder.pid, o.holder.started, at, this.project, k.name, kept.held.generation)
          if (Number(took.changes) !== 1) return refuse(T.keptBusy)
          const lease = this.insertLease(db, kid, k.name, 'card', req, at)
          return { ok: true as const, lease, slot: this.slotIn(db, k.name)!, fresh: false, reclaim: true }
        }
        // Only a slot of this pool's platform (HI-2795, R2.6): a Git slot finishes under Git, never lent from a jj pool.
        const usable = (s: Slot): boolean => (s.platform ?? 'git') === (o.platform ?? 'git') && this.freeIn(db, s)
        let slot: Slot | undefined
        let fresh = false
        // Names reserved by renames under way (#1441): never made by a lend, asked for by name or not.
        const reserved = this.reservedIn(db)
        if (req.slot) {
          if (reserved.has(req.slot.toLowerCase())) return { ok: false as const, refusal: { why: 'notReady' as const, slot: req.slot, state: 'removing' as const, error: null } }
          slot = all.find((s) => s.name.toLowerCase() === req.slot!.toLowerCase())
          const open = slot ? openLeaseIn(db, this.project, slot.name) : null
          if (open) return { ok: false as const, refusal: { why: 'inUse' as const, slot: open.slot, agent: open.agent, card: open.card, lane: open.lane } }
          if (slot && slot.op) return { ok: false as const, refusal: { why: 'warming' as const, slot: slot.name } }
          if (slot && !usable(slot)) return { ok: false as const, refusal: { why: 'notReady' as const, slot: slot.name, state: slot.state, error: slot.warmError } }
        } else {
          const free = all.filter((s) => usable(s) && !o.skip?.has(s.name))
          const last = (s: Slot): string | null => (db.prepare('SELECT agent FROM slot_leases WHERE project = ? AND slot = ? ORDER BY from_at DESC LIMIT 1').get(this.project, s.name) as { agent: string } | undefined)?.agent ?? null
          slot = free.find((s) => last(s) === req.agent) ?? free.sort((a, b) => b.usedAt.localeCompare(a.usedAt))[0]
        }
        const id = `l-${randomBytes(6).toString('hex')}`
        let name: string
        if (!slot) {
          // HI-2936: the size counts this platform's slots alone: another's left by a switch is never lent, so never fills it.
          if (all.filter((s) => (s.platform ?? 'git') === (o.platform ?? 'git')).length >= o.size) return { ok: false as const, refusal: { why: 'noSlot' as const, size: o.size } }
          name = req.slot ?? nextSlotName(new Set([...all.map((s) => s.name.toLowerCase()), ...reserved]), o.root)
          db.prepare("INSERT INTO slots (project, name, folder, state, port_base, target, created_at, used_at, op, op_kind, op_lease, op_pid, op_started) VALUES (?, ?, ?, 'creating', ?, ?, ?, ?, ?, 'warm', ?, ?, ?)").run(this.project, name, join(o.root, name), freePort(all), o.target, at, at, o.token, id, o.holder.pid, o.holder.started)
          // Another platform than Git's (HI-2795): its row says so from the write that reserves it, before anything is made.
          if ((o.platform ?? 'git') !== 'git') db.prepare('UPDATE slots SET platform = ? WHERE project = ? AND name = ?').run(o.platform!, this.project, name)
          db.prepare('DELETE FROM board_meta WHERE key = ?').run(asideKey(this.project, name)) // a new row: no earlier slot's set-aside (HI-2680)
          fresh = true
        } else {
          name = slot.name
          // Only from what this write read: free, still the state it had.
          const took = db.prepare(`UPDATE slots SET op = ?, op_kind = 'warm', op_lease = ?, op_pid = ?, op_started = ?, used_at = ? WHERE project = ? AND name = ? AND state = 'ready' AND ${FREE}`).run(o.token, id, o.holder.pid, o.holder.started, at, this.project, name)
          if (Number(took.changes) !== 1) return { ok: false as const, refusal: { why: 'notReady' as const, slot: name, state: slot.state, error: slot.warmError } }
        }
        const lease = this.insertLease(db, id, name, req.card !== undefined ? 'card' : 'lane', req, at)
        return { ok: true as const, lease, slot: this.slotIn(db, name)!, fresh }
      })
    } catch (e) {
      // The indexes are the last word (another process on the same file): refused, not thrown.
      const hit = constraintOf(e)
      if (hit === 'slot' && req.slot) {
        const open = this.openLease(req.slot)
        if (open) return { ok: false, refusal: { why: 'inUse', slot: open.slot, agent: open.agent, card: open.card, lane: open.lane } }
      }
      if (hit === 'agent') {
        const mine = this.leasesOf(req.agent).find((l) => l.kind !== 'carried')
        if (mine) return { ok: false, refusal: { why: 'agentLeased', slot: mine.slot, card: mine.card, lane: mine.lane } }
      }
      if (hit) return { ok: false, refusal: { why: 'noSlot', size: o.size } }
      throw e
    }
  }

  /**
   * A slot free for a lease, its platform aside (HI-2886: `take` lends only these, and only these no longer use the target
   * they recorded): ready, no failed setup, no operation, job or writer, no open lease of any kind, not set aside.
   */
  /** The slot kept for a card (HI-2995, `heldKey`), as this write reads it; null with none (a record of no slot: none). */
  private keptFor(db: DatabaseSync, card: number, all: Slot[]): { slot: Slot; held: SlotKeptFor } | null {
    const prefix = heldKey(this.project, '')
    const rows = db.prepare('SELECT key, value FROM board_meta WHERE key >= ? AND key < ?').all(prefix, `${prefix.slice(0, -1)};`) as { key: string; value: string }[] // agent-protocol: SQL
    for (const r of rows) {
      let held: SlotKeptFor | null = null
      try {
        held = heldOf(JSON.parse(r.value))
      } catch {
        held = null
      }
      const slot = held?.card === card ? all.find((s) => s.name === r.key.slice(prefix.length)) : undefined
      if (slot && held) return { slot, held }
    }
    return null
  }

  /** The card a slot is kept for (HI-2995), or null. */
  keptCard(name: string): number | null {
    return this.conn.read((db) => {
      const r = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(heldKey(this.project, name)) as { value: string } | undefined // agent-protocol: SQL
      try {
        return r ? (heldOf(JSON.parse(r.value))?.card ?? null) : null
      } catch {
        return null
      }
    })
  }

  private freeIn(db: DatabaseSync, s: Slot): boolean {
    return s.state === 'ready' && !s.warmError && !s.op && !s.job && !s.writer && !openLeaseIn(db, this.project, s.name) && !db.prepare('SELECT 1 FROM board_meta WHERE key = ?').get(asideKey(this.project, s.name))
  }

  /**
   * The slots that use the target they record (HI-2886), on one snapshot: every slot recording one but a free one
   * (`freeIn`), whose recorded target is only the last its lease served. Inside a board write, that write's own state.
   */
  targetsInUse(): { name: string; target: string }[] {
    return this.conn.read((db) => this.slotsIn(db).flatMap((s) => (s.target && !this.freeIn(db, s) ? [{ name: s.name, target: s.target }] : [])))
  }

  private dispatchOf(db: DatabaseSync, agent: string): SlotLease | null {
    const r = db.prepare("SELECT * FROM slot_leases WHERE project = ? AND agent = ? AND ended_at IS NULL AND kind <> 'carried'").get(this.project, agent) as Row | undefined
    return r ? leaseOfRow(r) : null
  }

  private insertLease(db: DatabaseSync, id: string, slot: string, kind: LeaseKind, req: { agent: string; card?: number; lane?: string }, at: string): SlotLease {
    db.prepare('INSERT INTO slot_leases (id, project, slot, kind, card, lane, agent, from_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, this.project, slot, kind, kind === 'card' ? req.card! : null, kind === 'lane' ? req.lane! : null, req.agent, at)
    return { id, project: this.project, slot, kind, card: kind === 'card' ? req.card! : null, lane: kind === 'lane' ? req.lane! : null, agent: req.agent, from: at, to: null, why: null, endRev: null }
  }

  /**
   * A carried lease (#1441): an agent's own worktree adopted in place as a slot under its folder's name, protected while
   * the lease is open. The slot's row is made if it has none. Refused (null) when the slot has an operation or a job, is
   * being removed, has a writer, or is recorded at another folder, or the slot or the agent has an open lease.
   */
  async carry(agent: string, slot: { name: string; folder: string; target: string | null }): Promise<SlotLease | null> {
    try {
      return await this.conn.write((db) => this.carryIn(db, agent, slot))
    } catch (e) {
      if (constraintOf(e)) return null
      throw e
    }
  }

  /**
   * `carry` inside a write of the caller's (#1434: the user's Resume taking a free slot, with the rest of its write). A
   * unique index refusing it throws, undoing that whole write.
   */
  carryIn(db: DatabaseSync, agent: string, slot: { name: string; folder: string; target: string | null }): SlotLease | null {
    const at = this.iso()
    const had = this.slotIn(db, slot.name)
    if (deletingIn(db, this.project)) return null
    if (!had && (this.reservedIn(db).has(slot.name.toLowerCase()) || this.renamesIn(db).some((r) => samePlace(r.intent.to, slot.folder)))) return null
    if (!had) {
      db.prepare("INSERT INTO slots (project, name, folder, state, port_base, target, created_at, used_at) VALUES (?, ?, ?, 'lent', ?, ?, ?, ?)").run(this.project, slot.name, slot.folder, freePort(this.slotsIn(db)), slot.target, at, at)
      db.prepare('DELETE FROM board_meta WHERE key = ?').run(asideKey(this.project, slot.name)) // a new row: no earlier slot's set-aside (HI-2680)
    } else {
      if (!samePlace(had.folder, slot.folder)) return null
      // Set aside by a retarget (HI-2680): never lent again until it is removed.
      if (db.prepare('SELECT 1 FROM board_meta WHERE key = ?').get(asideKey(this.project, slot.name))) return null
      const took = db.prepare(`UPDATE slots SET state = 'lent', used_at = ? WHERE project = ? AND name = ? AND state <> 'removing' AND ${FREE}`).run(at, this.project, slot.name)
      if (Number(took.changes) !== 1) return null
    }
    return this.insertLease(db, `l-${randomBytes(6).toString('hex')}`, slot.name, 'carried', { agent }, at)
  }

  /**
   * A carried lease handed off to a card or lane of its agent's on the same slot (#1441, SPEC §16.10.8), in one write:
   * the carried lease ended (`handedOff`), a dispatch lease begun on the slot, the slot's writer (the agent's running
   * session there) moved to it, and `also` (the caller's rebinding of the carried lease's sessions, #1434's
   * `rebindSession`) in the same write, so all of it lands or none. Null when it can't be now: the carried lease not open
   * or another agent's, the slot under an operation or a job, or another agent writing there; an index refusing it (the
   * agent leased meanwhile) too. `check` (the caller's, HI-1741: the slot's checkout as it decided on it) runs in the
   * write once the rest holds, given the slot as it is then: false refuses it, nothing written.
   */
  async handOff(carried: string, req: { card?: number; lane?: string; agent: string }, also?: (db: DatabaseSync, lease: SlotLease) => void, check?: (slot: Slot) => boolean): Promise<SlotLease | null> {
    if ((req.card === undefined) === (req.lane === undefined)) throw new Error('a lease is for a card or a lane') // agent-protocol: a programming error (its caller's), never an agent's or the user's
    try {
      return await this.conn.write((db) => {
        const r = db.prepare("SELECT * FROM slot_leases WHERE id = ? AND project = ? AND ended_at IS NULL AND kind = 'carried'").get(carried, this.project) as Row | undefined
        if (!r || r.agent !== req.agent) return null
        const s = this.slotIn(db, r.slot as string)
        if (!s || s.op || s.job || s.state === 'removing' || (s.writer && s.writer.agent !== req.agent)) return null
        if (check && !check(s)) return null
        const at = this.iso()
        db.prepare("UPDATE slot_leases SET ended_at = ?, why = 'handedOff' WHERE id = ?").run(at, carried)
        const lease = this.insertLease(db, `l-${randomBytes(6).toString('hex')}`, s.name, req.card !== undefined ? 'card' : 'lane', req, at)
        if (s.writer) db.prepare('UPDATE slots SET writer_lease = ? WHERE project = ? AND name = ? AND writer_run = ?').run(lease.id, this.project, s.name, s.writer.run)
        db.prepare('UPDATE slots SET used_at = ? WHERE project = ? AND name = ?').run(at, this.project, s.name)
        also?.(db, lease)
        return lease
      })
    } catch (e) {
      if (constraintOf(e)) return null
      throw e
    }
  }

  /**
   * The slot an agent's own run still writes in, its lease ended (HI-1762: HB5's lane ended, its session still in its
   * turn in slot-a, and its next lane's start found no slot free), taken over by its next card or lane in one write: only
   * while the slot has no open lease, operation or job, is lent with no warm error, its writer is that agent's run `run`
   * held by this Combwork (`holder`), and the agent holds no other dispatch lease. The lease begins on the slot, the writer
   * moves to it (the old lease's end then no longer owns the run: it stops nothing), and `also` (the caller's rebinding of
   * the run's conversations) runs in the same write. Null when it can't be now; nothing written.
   */
  async takeWrittenSlot(slot: string, req: { card?: number; lane?: string; agent: string }, run: string, holder: { pid: number; started: number }, also?: (db: DatabaseSync, lease: SlotLease, was: string) => void): Promise<SlotLease | null> {
    if ((req.card === undefined) === (req.lane === undefined)) throw new Error('a lease is for a card or a lane') // agent-protocol: a programming error (its caller's), never an agent's or the user's
    try {
      return await this.conn.write((db) => {
        if (this.writtenNotTakeableIn(db, slot, req.agent, run, holder)) return null
        const s = this.slotIn(db, slot)!
        const w = s.writer!
        const at = this.iso()
        const lease = this.insertLease(db, `l-${randomBytes(6).toString('hex')}`, s.name, req.card !== undefined ? 'card' : 'lane', req, at)
        db.prepare('UPDATE slots SET writer_lease = ?, used_at = ? WHERE project = ? AND name = ? AND writer_run = ?').run(lease.id, at, this.project, s.name, run)
        also?.(db, lease, w.lease)
        return lease
      })
    } catch (e) {
      if (constraintOf(e)) return null
      throw e
    }
  }

  /**
   * A start's target recorded on the slot its lease holds (HI-2185, SlotPool.serves): only while that lease is open and
   * its agent's, so a lease ended or replaced meanwhile changes nothing (the slot's open lease is unique: an open one is
   * its holder). Whether it was recorded.
   */
  async serves(lease: string, agent: string, target: string): Promise<boolean> {
    return this.conn.write((db) => {
      const r = db.prepare('SELECT slot FROM slot_leases WHERE id = ? AND project = ? AND agent = ? AND ended_at IS NULL').get(lease, this.project, agent) as { slot: string } | undefined
      if (!r) return false
      db.prepare('UPDATE slots SET target = ? WHERE project = ? AND name = ?').run(target, this.project, r.slot)
      return true
    })
  }

  /**
   * Why takeWrittenSlot wouldn't take the slot now, in words for the start's wait (agent-facing), or null when it would:
   * the same conditions, read without writing (HI-1787: a dry start advertised a slot another Combwork's run held, which the
   * real start then refused).
   */
  writtenNotTakeable(slot: string, agent: string, run: string, holder: { pid: number; started: number }): string | null {
    return this.conn.read((db) => this.writtenNotTakeableIn(db, slot, agent, run, holder))
  }

  private writtenNotTakeableIn(db: DatabaseSync, slot: string, agent: string, run: string, holder: { pid: number; started: number }): string | null {
    const s = this.slotIn(db, slot)
    if (!s) return say(T.takeoverGone)
    if (s.op) return say(T.takeoverBusy)
    if (s.job) return say(T.takeoverJob)
    if (s.warmError) return say(T.takeoverSetupFailed)
    if (s.state !== 'lent') return say(T.takeoverNotReady, { state: s.state })
    if (openLeaseIn(db, this.project, s.name)) return say(T.takeoverLent)
    const w = s.writer
    if (!w || w.agent !== agent || w.run !== run) return say(T.takeoverOtherRun)
    if (w.pid !== holder.pid || w.started !== holder.started) return say(T.takeoverOtherCombwork)
    if (this.dispatchOf(db, agent)) return say(T.takeoverHolds)
    return null
  }

  /**
   * A rename begun (#1441): in one write, the slot taken by a `remove`-kind operation (as `startRemoval`, only while it is
   * free and in state `from`) and its destination reserved: the next generic name no slot of the project has, no other
   * rename's intent has reserved, and whose folder under `root` is absent, recorded as the operation's intent (board_meta
   * `slot_rename:<project>:<slot>`). Two renames, of two slots or in two Combworks, so never share a destination. Null when
   * the slot isn't free now.
   */
  async startRename(name: string, from: SlotState, token: string, holder: Holder, root: string, tree: string): Promise<RenameIntent | null> {
    return this.conn.write((db) => {
      // Set aside by a retarget (HI-2680, HR2's round 2): keeps its name, so nothing it records is lost under another.
      if (db.prepare('SELECT 1 FROM board_meta WHERE key = ?').get(asideKey(this.project, name))) return null
      if (Number(db.prepare(`UPDATE slots SET state = 'removing', op = ?, op_kind = 'remove', op_lease = NULL, op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND state = ? AND state <> 'removing' AND ${FREE}`).run(token, holder.pid, holder.started, this.project, name, from).changes) !== 1) return null
      const taken = new Set(this.slotsIn(db).map((x) => x.name.toLowerCase()))
      for (const r of this.renamesIn(db)) taken.add(r.intent.toName.toLowerCase())
      let n = 0
      while (taken.has(slotName(n)) || RESERVED.has(slotName(n)) || existsSync(join(root, slotName(n)))) n++
      const intent: RenameIntent = { from: this.slotIn(db, name)!.folder, toName: slotName(n), to: join(root, slotName(n)), was: from, tree }
      db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(renameKey(this.project, name), JSON.stringify(intent))
      return intent
    })
  }

  /** The renames under way in the project (their intents, by slot), as recorded. */
  renames(): { slot: string; intent: RenameIntent }[] {
    return this.conn.read((db) => this.renamesIn(db))
  }

  private renamesIn(db: DatabaseSync): { slot: string; intent: RenameIntent }[] {
    const prefix = renameKey(this.project, '')
    const rows = db.prepare('SELECT key, value FROM board_meta WHERE key LIKE ?').all(`${prefix}%`) as { key: string; value: string }[]
    return rows.flatMap((r) => {
      const i = intentOf(r.value)
      return i ? [{ slot: r.key.slice(prefix.length), intent: i }] : []
    })
  }

  /** The names reserved by renames under way, lower-cased (#1441): `take` and `carryIn` never make a slot of one. */
  private reservedIn(db: DatabaseSync): Set<string> {
    return new Set(this.renamesIn(db).map((r) => r.intent.toName.toLowerCase()))
  }

  /** A slot's rename intent, if one is recorded. */
  renameOf(name: string): RenameIntent | null {
    return this.renames().find((r) => r.slot.toLowerCase() === name.toLowerCase())?.intent ?? null
  }

  /**
   * A rename done, by its operation (`token`), in one fenced write: the row and its leases' history renamed to the
   * reserved name and folder, the operation cleared, the slot as it was, and the intent deleted.
   */
  async finishRename(name: string, token: string, intent: RenameIntent): Promise<void> {
    await this.fenced(name, token, (db) => {
      // The row and its leases renamed together: the leases' key checked at the write's end, once both are.
      db.exec('PRAGMA defer_foreign_keys = ON')
      db.prepare('UPDATE slots SET name = ?, folder = ?, state = ?, op = NULL, op_kind = NULL, op_lease = NULL, op_pid = NULL, op_started = NULL WHERE project = ? AND name = ?').run(intent.toName, intent.to, intent.was, this.project, name)
      db.prepare('UPDATE slot_leases SET slot = ? WHERE project = ? AND slot = ?').run(intent.toName, this.project, name)
      db.prepare('DELETE FROM board_meta WHERE key = ?').run(renameKey(this.project, name))
      // A set-aside (HI-2680) follows the slot to its new name, in the same write (none is renamed: belt and braces).
      db.prepare('UPDATE board_meta SET key = ? WHERE key = ?').run(asideKey(this.project, intent.toName), asideKey(this.project, name))
    })
  }

  /** A rename given up, by its operation, in one fenced write: the slot as it was, the operation cleared, the intent deleted. */
  async abandonRename(name: string, token: string, intent: RenameIntent): Promise<void> {
    await this.fenced(name, token, (db) => {
      this.setIn(db, name, intent.was, {}, { op: null })
      db.prepare('DELETE FROM board_meta WHERE key = ?').run(renameKey(this.project, name))
    })
  }

  /**
   * Intents no operation owns (none can be made so: an intent is written and deleted with its operation, in the same
   * writes), cleared. How many.
   */
  async clearOrphanRenames(): Promise<number> {
    return this.conn.write((db) => {
      let n = 0
      for (const r of this.renamesIn(db)) {
        const s = this.slotIn(db, r.slot)
        if (s?.op?.kind === 'remove') continue
        db.prepare('DELETE FROM board_meta WHERE key = ?').run(renameKey(this.project, r.slot))
        n++
      }
      return n
    })
  }

  private slotsIn(db: DatabaseSync): Slot[] {
    return (db.prepare('SELECT * FROM slots WHERE project = ?').all(this.project) as Row[]).map(slotOfRow)
  }

  /** Ends an open lease: the lease as ended, or null when it wasn't open. The slot is looked at by the pool. */
  async end(lease: string, why: string, check?: () => boolean): Promise<SlotLease | null> {
    return this.conn.write((db) => {
      const r = db.prepare('SELECT * FROM slot_leases WHERE id = ? AND project = ? AND ended_at IS NULL').get(lease, this.project) as Row | undefined
      // The caller's condition, decided in this write (#1438: the card's cycle as the board has it now).
      if (!r || (check && !check())) return null
      const at = this.iso()
      db.prepare('UPDATE slot_leases SET ended_at = ?, why = ? WHERE id = ?').run(at, why, lease)
      db.prepare('UPDATE slots SET used_at = ? WHERE project = ? AND name = ?').run(at, this.project, r.slot)
      return { ...leaseOfRow(r), to: at, why }
    })
  }

  /**
   * An ended lease's last revision (#1434): the slot's head once nothing of the lease writes there any more (its lease
   * ended and its writer gone), where its conversations may resume by hand. Only while it is still the slot's newest
   * lease, ended, with no writer on the slot and none recorded yet: a slot lent again since keeps its own. Whether it was.
   */
  async finalizeEndRev(lease: string, rev: string): Promise<boolean> {
    return this.conn.write(
      (db) =>
        Number(
          db
            .prepare(
              'UPDATE slot_leases SET end_rev = ? WHERE id = ? AND project = ? AND ended_at IS NOT NULL AND end_rev IS NULL AND id = (SELECT l.id FROM slot_leases l WHERE l.project = slot_leases.project AND l.slot = slot_leases.slot ORDER BY l.from_at DESC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM slots s WHERE s.project = slot_leases.project AND s.name = slot_leases.slot AND s.writer_run IS NOT NULL)'
            )
            .run(rev, lease, this.project).changes
        ) === 1
    )
  }

  /** A run's writer cleared in every slot still naming it (one write): the slots it was cleared in. */
  async clearWriterRun(run: string): Promise<string[]> {
    return this.conn.write((db) => {
      const names = (db.prepare('SELECT name FROM slots WHERE project = ? AND writer_run = ?').all(this.project, run) as { name: string }[]).map((r) => r.name)
      db.prepare('UPDATE slots SET writer_run = NULL, writer_lease = NULL, writer_agent = NULL, writer_pid = NULL, writer_started = NULL WHERE project = ? AND writer_run = ?').run(this.project, run)
      return names
    })
  }

  /**
   * A writer whose run has ended (or whose Combwork is gone) cleared, only while it is still that run. Whether it was.
   * `guard` runs in the write first (#1561: the Assistant's Control and session, still allowing it): a throw changes nothing.
   */
  async clearWriter(name: string, run: string, guard?: () => void): Promise<boolean> {
    return this.conn.write((db) => (guard?.(), Number(db.prepare('UPDATE slots SET writer_run = NULL, writer_lease = NULL, writer_agent = NULL, writer_pid = NULL, writer_started = NULL WHERE project = ? AND name = ? AND writer_run = ?').run(this.project, name, run).changes) === 1))
  }

  /** A slot's newest lease, open or ended (#1434: whose work it holds). */
  lastLease(slot: string): SlotLease | null {
    return this.conn.read((db) => {
      const r = db.prepare('SELECT * FROM slot_leases WHERE project = ? AND slot = ? ORDER BY from_at DESC LIMIT 1').get(this.project, slot) as Row | undefined
      return r ? leaseOfRow(r) : null
    })
  }

  /**
   * Whether a carried lease is one the agent's Resume took (#1434: a free slot of the pool, on a card's or lane's line), not
   * an adopted worktree's (#1441: on the agent's 0.9 branch). Its slot had a card's or lane's lease since it was made and
   * before it (the same millisecond counts); an adopted worktree's carried lease is the first its slot had (the adoption
   * makes the slot), and history under the same name from before the slot was made doesn't count. Unknown: false (the
   * adopted worktree's stricter rule).
   */
  resumedCarry(lease: SlotLease): boolean {
    if (lease.kind !== 'carried') return false
    return this.conn.read((db) => !!db.prepare("SELECT 1 FROM slot_leases l JOIN slots s ON s.project = l.project AND s.name = l.slot WHERE l.project = ? AND l.slot = ? AND l.kind IN ('card', 'lane') AND l.from_at >= s.created_at AND l.from_at <= ? AND l.id <> ? LIMIT 1").get(this.project, lease.slot, lease.from, lease.id))
  }

  /**
   * Starts a removal on a slot in one write: only while it is free (no operation, job or open lease) and still in the
   * state it was read in. Whether it started.
   */
  async startRemoval(name: string, from: SlotState, token: string, holder: Holder): Promise<boolean> {
    return this.conn.write((db) => Number(db.prepare(`UPDATE slots SET state = 'removing', op = ?, op_kind = 'remove', op_lease = NULL, op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND state = ? AND state <> 'removing' AND ${FREE}`).run(token, holder.pid, holder.started, this.project, name, from).changes) === 1)
  }

  /** A multi-step change's journal (HI-2795, WorkspaceJournal): a board_meta row by key, JSON, read and written whole. */
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
      clear: () => this.conn.write((db) => void db.prepare('DELETE FROM board_meta WHERE key = ?').run(key)),
      update: (fn) =>
        this.conn.write((db) => {
          const r = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined
          let current: unknown = null
          try {
            current = r ? (JSON.parse(r.value) as unknown) : null
          } catch {
            current = { unreadable: true }
          }
          const next = fn(current)
          if (next === undefined) return false
          db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(next))
          return true
        })
    }
  }

  /**
   * One write of an operation: only while it still holds the slot (its token), else OpLost and nothing written. `fn`
   * gets the slot as it is in this write.
   */
  async fenced<T>(name: string, token: string, fn: (db: DatabaseSync, s: Slot) => T): Promise<T> {
    return this.conn.write((db) => {
      const s = this.slotIn(db, name)
      if (!s || s.op?.token !== token) throw new OpLost(name)
      return fn(db, s)
    })
  }

  /** In a fenced write: the slot's state and fields set. */
  setIn(db: DatabaseSync, name: string, state: SlotState, fields: SlotFields = {}, also: { op?: null; job?: string | null } = {}): void {
    const sets = ['state = ?', ...Object.keys(fields).map((k) => `${COLUMN[k as keyof typeof COLUMN]} = ?`)]
    const args: (string | null)[] = [state, ...Object.values(fields).map((v) => v ?? null)]
    if (also.op === null) sets.push('op = NULL, op_kind = NULL, op_lease = NULL, op_pid = NULL, op_started = NULL')
    if (also.job !== undefined) {
      sets.push('job = ?')
      args.push(also.job)
    }
    db.prepare(`UPDATE slots SET ${sets.join(', ')} WHERE project = ? AND name = ?`).run(...args, this.project, name)
  }

  /** In a write: ends a lease if it is open (an operation's own). */
  endIn(db: DatabaseSync, lease: string, why: string): void {
    db.prepare('UPDATE slot_leases SET ended_at = ?, why = ? WHERE id = ? AND ended_at IS NULL').run(this.iso(), why, lease)
  }

  /** Whether a lease is open (in a write). */
  openIn(db: DatabaseSync, lease: string): boolean {
    return !!db.prepare('SELECT 1 FROM slot_leases WHERE id = ? AND ended_at IS NULL').get(lease)
  }

  /**
   * Starts a card's preparation on its lease's slot (#1438), as a warming of that lease: only while the slot is lent
   * under it, with no operation or job, and no session writing there but the lease's own. Whether it started.
   */
  async startPrepare(name: string, lease: string, token: string, holder: Holder): Promise<boolean> {
    return this.conn.write(
      (db) =>
        Number(
          db
            .prepare("UPDATE slots SET op = ?, op_kind = 'warm', op_lease = ?, op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND state = 'lent' AND op IS NULL AND job IS NULL AND (writer_run IS NULL OR writer_lease = ?) AND EXISTS (SELECT 1 FROM slot_leases l WHERE l.id = ? AND l.project = slots.project AND l.slot = slots.name AND l.ended_at IS NULL)")
            .run(token, lease, holder.pid, holder.started, this.project, name, lease, lease).changes
        ) === 1
    )
  }

  /** Takes over an operation whose holder is gone: only while `was` still holds it. Whether it was taken. */
  async takeOver(name: string, was: string, token: string, holder: Holder): Promise<boolean> {
    return this.conn.write((db) => Number(db.prepare('UPDATE slots SET op = ?, op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND op = ?').run(token, holder.pid, holder.started, this.project, name, was).changes) === 1)
  }

  /**
   * A free slot's settle begun (HI-2170): a warm-kind operation with no lease (no lend's warming has none), taken only
   * while the slot is free and still in state `from` at `folder`. Whether it was.
   */
  async beginSettle(name: string, from: SlotState, folder: string, token: string, holder: Holder): Promise<boolean> {
    return this.conn.write((db) => Number(db.prepare(`UPDATE slots SET op = ?, op_kind = 'warm', op_lease = NULL, op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND state = ? AND folder = ? AND ${FREE}`).run(token, holder.pid, holder.started, this.project, name, from, folder).changes) === 1)
  }

  /**
   * A held slot's recovery begun (HI-2913): a warm-kind operation of `lease`, taken in one write only while the slot is
   * lent under exactly that open lease at `folder`, with no operation, job or writer. A preparation can't start under it
   * (startPrepare needs the slot free of operations), and one already running keeps it from being taken. Taken over from a
   * holder that is gone, it is a lent slot's warming: its lease kept, the slot as it is. Whether it was taken.
   */
  async beginRecover(name: string, lease: string, folder: string, token: string, holder: Holder): Promise<boolean> {
    return this.conn.write(
      (db) =>
        Number(
          db
            .prepare("UPDATE slots SET op = ?, op_kind = 'warm', op_lease = ?, op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND state = 'lent' AND folder = ? AND op IS NULL AND job IS NULL AND writer_run IS NULL AND EXISTS (SELECT 1 FROM slot_leases l WHERE l.id = ? AND l.project = slots.project AND l.slot = slots.name AND l.ended_at IS NULL)")
            .run(token, lease, holder.pid, holder.started, this.project, name, folder, lease).changes
        ) === 1
    )
  }

  /**
   * A slot's folder moved by Repair (#1447): its row follows it (`folder`), only while no operation or job holds it. With
   * `gone` (a free slot whose folder wasn't found): marked gone at its place in the moved pool, so its next lease makes
   * it again there, only while it is free. Whether it was.
   */
  async relocate(name: string, folder: string, o: { gone?: boolean } = {}): Promise<boolean> {
    return this.conn.write((db) =>
      o.gone
        ? Number(db.prepare(`UPDATE slots SET folder = ?, state = 'gone' WHERE project = ? AND name = ? AND state <> 'removing' AND ${FREE}`).run(folder, this.project, name).changes) === 1
        : Number(db.prepare('UPDATE slots SET folder = ? WHERE project = ? AND name = ? AND op IS NULL AND job IS NULL').run(folder, this.project, name).changes) === 1
    )
  }

  /** A warming operation taken on a leased slot, only while none holds it (tests). Whether it was. */
  async startWarm(name: string, lease: string, token: string, holder: Holder): Promise<boolean> {
    return this.conn.write((db) => Number(db.prepare("UPDATE slots SET op = ?, op_kind = 'warm', op_lease = ?, op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND op IS NULL AND job IS NULL").run(token, lease, holder.pid, holder.started, this.project, name).changes) === 1)
  }

  /**
   * A gone leased slot's recreation begun (#1447, Repair's Recreate; HR1's round 1): in one write, a warm-kind operation
   * taken only while the row is as the plan saw it (that open lease, that folder, no operation, job or writer) and `to`
   * is no other slot's folder nor reserved by a rename, and its intent recorded (board_meta `slot_recreate:`), so a
   * recovery finishes or puts back the recreation, never ending the lease as a lend's interrupted warming would. Null: the
   * slot changed since (another Combwork relinked or reassigned it, a resume claimed it).
   */
  async startRecreate(name: string, expect: { lease: string; folder: string }, token: string, holder: Holder, to: string, line: string): Promise<RecreateIntent | null> {
    return this.conn.write((db) => {
      const s = this.slotIn(db, name)
      if (!s || s.op || s.job || s.writer || !samePlace(s.folder, expect.folder)) return null
      if (openLeaseIn(db, this.project, name)?.id !== expect.lease) return null
      if (this.slotsIn(db).some((x) => x.name.toLowerCase() !== name.toLowerCase() && samePlace(x.folder, to))) return null
      if (this.renamesIn(db).some((r) => samePlace(r.intent.to, to))) return null
      if (Number(db.prepare("UPDATE slots SET op = ?, op_kind = 'warm', op_lease = ?, op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND op IS NULL").run(token, expect.lease, holder.pid, holder.started, this.project, name).changes) !== 1) return null
      const intent: RecreateIntent = { lease: expect.lease, from: s.folder, to, line, was: s.state }
      db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(recreateKey(this.project, name), JSON.stringify(intent))
      return intent
    })
  }

  /** A slot's recreate intent, if one is recorded. */
  recreateOf(name: string): RecreateIntent | null {
    return this.conn.read((db) => {
      const v = (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(recreateKey(this.project, name)) as { value: string } | undefined)?.value
      return v ? recreateIntentOf(v) : null
    })
  }

  /**
   * A recreation ended by its operation, in one fenced write: made (the row at `to`, lent) or not (the row as it was),
   * the operation and the intent cleared; its lease kept either way.
   */
  async endRecreate(name: string, token: string, intent: RecreateIntent, made: boolean): Promise<void> {
    await this.fenced(name, token, (db) => {
      if (made) db.prepare('UPDATE slots SET folder = ? WHERE project = ? AND name = ?').run(intent.to, this.project, name)
      this.setIn(db, name, made ? 'lent' : intent.was, {}, { op: null })
      db.prepare('DELETE FROM board_meta WHERE key = ?').run(recreateKey(this.project, name))
    })
  }

  /**
   * HI-2680: a free slot reserved for its move onto another target, in one write, only as the preview saw it: ready, free
   * (no operation, job, writer or lease), at the same folder, with the same recorded target; its intent recorded with it.
   */
  async startRetarget(name: string, expect: { folder: string; target: string | null }, token: string, holder: Holder, intent: Omit<RetargetIntent, 'stage'>): Promise<boolean> {
    return this.conn.write((db) => {
      const s = this.slotIn(db, name)
      if (!s || s.state !== 'ready' || s.op || s.job || s.writer || !samePlace(s.folder, expect.folder) || (s.target ?? null) !== expect.target) return false
      if (openLeaseIn(db, this.project, name)) return false
      if (Number(db.prepare(`UPDATE slots SET op = ?, op_kind = 'warm', op_lease = NULL, op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND state = 'ready' AND ${FREE}`).run(token, holder.pid, holder.started, this.project, name).changes) !== 1) return false
      db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(retargetKey(this.project, name), JSON.stringify({ ...intent, stage: 'reserved' } satisfies RetargetIntent))
      return true
    })
  }

  /** A slot's retarget intent, if one is recorded (HI-2680). */
  retargetOf(name: string): RetargetIntent | null {
    return this.conn.read((db) => {
      const v = (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(retargetKey(this.project, name)) as { value: string } | undefined)?.value
      return v ? retargetIntentOf(v) : null
    })
  }

  /** HI-2680: its folder moved and checked: recorded before the slot is, by its operation (`token`). */
  async retargetSwitched(name: string, token: string): Promise<void> {
    await this.fenced(name, token, (db) => {
      const v = (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(retargetKey(this.project, name)) as { value: string } | undefined)?.value
      const i = v ? retargetIntentOf(v) : null
      if (i) db.prepare('UPDATE board_meta SET value = ? WHERE key = ?').run(JSON.stringify({ ...i, stage: 'switched' } satisfies RetargetIntent), retargetKey(this.project, name))
    })
  }

  /**
   * HI-2680: a retarget ended by its operation, in one fenced write: `ready` on `target` (the new one, or back on the
   * recorded one), or set aside (`dirty`: never lent; `gone`); the operation and the intent cleared.
   */
  async endRetarget(name: string, token: string, end: { state: 'ready'; target: string | null } | { state: 'dirty' | 'gone'; aside: SlotAside }): Promise<void> {
    await this.fenced(name, token, (db) => {
      if (end.state === 'ready') db.prepare('UPDATE slots SET target = ? WHERE project = ? AND name = ?').run(end.target, this.project, name)
      // Set aside (HR1's HI-2680 round 1, finding 1): kept with why, so no later look makes it ready again; only its removal clears it.
      else db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(asideKey(this.project, name), JSON.stringify(end.aside))
      this.setIn(db, name, end.state, {}, { op: null })
      db.prepare('DELETE FROM board_meta WHERE key = ?').run(retargetKey(this.project, name))
    })
  }

  /** Why a slot was set aside by a retarget (HI-2680), while it is: never lent or made ready again until it is removed. */
  asideOf(name: string): SlotAside | null {
    return this.conn.read((db) => {
      const v = (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(asideKey(this.project, name)) as { value: string } | undefined)?.value
      if (!v) return null
      try {
        return JSON.parse(v) as SlotAside
      } catch {
        return { to: '', seen: 'unreadable', at: '' }
      }
    })
  }

  /** A leased slot's folder is gone: marked so (its holder's sessions are refused, #1434). */
  async markGone(name: string): Promise<void> {
    await this.conn.write((db) => db.prepare("UPDATE slots SET state = 'gone' WHERE project = ? AND name = ? AND state = 'lent' AND op IS NULL").run(this.project, name))
  }

  /** A job left by an ended operation, settled since: cleared, only while no operation holds the slot. */
  async jobSettled(name: string, job: string): Promise<void> {
    await this.conn.write((db) => db.prepare('UPDATE slots SET job = NULL WHERE project = ? AND name = ? AND job = ? AND op IS NULL').run(this.project, name, job))
  }
}

function openLeaseIn(db: DatabaseSync, project: string, slot: string): SlotLease | null {
  const r = db.prepare('SELECT * FROM slot_leases WHERE project = ? AND slot = ? AND ended_at IS NULL').get(project, slot) as Row | undefined
  return r ? leaseOfRow(r) : null
}

/** The lowest port block no slot of the project has. */
function freePort(all: Pick<Slot, 'portBase'>[]): number {
  const ports = new Set(all.map((s) => s.portBase))
  let p = PORT_FLOOR
  while (ports.has(p)) p += SLOT_PORTS
  return p
}

// --- The pool.

/** What a lend asks for: a card or a lane (one of them), its builder, and optionally the slot it wants. */
export interface LeaseRequest {
  card?: number
  lane?: string
  agent: string
  slot?: string
}

/** One of Combwork's runs for a slot: its setup, an install, its archive command, in the job recorded for it. */
export interface SlotRun {
  /** The slot's name (or the copy's, with `of: 'copy'`: #1435's copies run theirs the same way). */
  slot: string
  of?: 'copy'
  /** A copy's: the agent (its id) whose lease holds it as the run starts, which the run is credited to (HI-1710). */
  holder?: string | null
  what: 'setup' | 'install' | 'archive' | 'gitFiles'
  /** The command line (a `gitFiles` run's: its title, the git commands it may run). */
  command: string
  /** HI-1182: the submodules-and-LFS step (the platform's, its tool run with no shell in the run's job) instead of `command`. */
  files?: { step: WorkspaceFilesStep; tool: Pick<WorkspaceFiles, 'prepare' | 'exec'> }
  folder: string
  env: Record<string, string>
  /** Its job's name on the process supervisor, recorded on the slot before the run starts. */
  job: string
  /** Aborted as the workspace closes: the run's processes are ended. */
  signal: AbortSignal
}

export interface SlotRunEnd {
  ok: boolean
  exitCode: number | null
  timedOut?: boolean
  spawnError?: boolean
  /** Why it couldn't start, in English (no process supervisor). */
  error?: string
  logPath: string | null
  /** Its job's processes are all seen ended (false: some may run on; the job stays recorded). */
  settled: boolean
}

/** Runs a slot's command as one of Combwork's runs ("Combwork (slot slot-b)"), to its end, in its job; never throws. */
export type SlotRunner = (r: SlotRun) => Promise<SlotRunEnd>

/** A project's slot options as they apply now: project.json's `slots`, else today's worktree settings. */
export interface SlotOptionsNow {
  setup: string
  archive: string
  copy: string
  /** HI-1182: false turns off setting up submodules and Git LFS in slots and copies where used (Version Control → Slots and copies; left out: on). */
  gitFiles?: boolean
}

/**
 * This process as an operations' holder: its identity, whether another holder's process still runs, and the tokens of
 * the operations it runs now (one of its own not among them was left by a workspace closed meanwhile: taken over too).
 * One per process in the app.
 */
export interface OpHolder {
  self(): Promise<Holder>
  /** Whether that process still runs; null when it can't be told (then it is taken to). */
  alive(pid: number, started: number): Promise<boolean | null>
  live: Set<string>
}

export interface PoolDeps {
  store: SlotStore
  /** How its slots' folders are made, inspected, prepared and removed (HI-2786's R4); unset: `slotWorkspaces()`, Git's worktrees. */
  workspaces?: WorkspacePort
  /**
   * The port its new slots are made with, by its project's platform now (HI-2866: the app's, so a project switched between
   * Git and jj lends the new platform's), when `workspaces` isn't set; `refreshPorts` reads the platform again first.
   */
  workspacesFor?: () => WorkspacePort
  refreshPorts?: () => Promise<void>
  /** The project's folder (its repository). */
  project: string
  /** Where its slots go: `<workspace>.worktrees/<project>` (worktreesRoot). */
  root: string
  options: () => Promise<SlotOptionsNow>
  /** How many builders the project has (setBuilderCount's, for this project). */
  builders: () => number | Promise<number>
  /** The project's Maximum agents (its workflow, HI-2001; before, Settings → Advanced's Agents per project). */
  cap: () => number
  runner: SlotRunner
  /** Ends a recorded job and what it followed: true once none of its processes runs. */
  settle: (job: string) => Promise<boolean>
  holder: OpHolder
  /** A session running in a folder: what it is (for the log), or null. */
  sessionIn?: (folder: string) => string | null
  /** Windows' brokers seen working in a held folder now (HI-2467: agentProcesses' brokerWorkingIn), or null: only names what holds it. */
  brokerIn?: (folder: string) => Promise<SlotBroker | null>
  /** Whether a card has a merge queue entry in flight. */
  inFlight?: (card: number) => boolean | Promise<boolean>
  /** Settings → Advanced, Remove idle slots after a day. */
  removeIdle?: () => boolean
  /** The owed pass's wake (HI-2906): a timer by default; tests give a scheduler they fire themselves. */
  later?: (fn: () => void, ms: number) => { cancel(): void }
  /** A lease ended (#1434): its builder's session in the slot (the slot's writer) is stopped once its turn ends. */
  ended?: (lease: SlotLease, slot: Slot) => void
  /**
   * Whether a writer's run is over and its processes are known to have ended (#1434): only then does a refresh clear it
   * (a release that couldn't be written). A writer of a Combwork that is gone is cleared only as `writerGone` says.
   */
  writerOver?: (w: SlotWriter) => boolean | Promise<boolean>
  /** Told once a refresh has cleared such a writer (HI-2303): its run's records go. */
  overCleared?: (run: string) => void
  /**
   * Whether a writer of a Combwork that has gone is settled (HI-1886): its run's processes were seen to end (kept in Combwork's
   * profile, or by its keeper, HI-2055). Otherwise it stays held until the user releases the slot. `settles` gives what
   * settled it (false: not settled), which only that attempt's clear carries: `still`, checked inside the clear's write,
   * throws when it no longer holds (a revoked helper); `cleared`, told once a refresh has cleared it, is given it too.
   */
  writerGone?: { settles: (w: SlotWriter, slot: string) => GoneSettled | Promise<GoneSettled>; cleared: (run: string, evidence: Exclude<GoneSettled, false>) => void; still?: (evidence: Exclude<GoneSettled, false>) => () => void }
  /** Removes Combwork's own unchanged skill copies from a folder (skillCopies.ts removeCopiesIn), before a slot goes (#1500). */
  removeSkillCopies?: (folder: string) => Promise<unknown>
  /** A rename's steps (#1441); none: slots aren't renamed. */
  renamer?: SlotRenamer
  /** A free slot's settle changed its state (HI-2170): what it is now. A finished card's slot question is looked at again. */
  looked?: (slot: string, state: SlotState) => void
  now?: () => number
}

/** The builder count a pool sizes by, per project folder: the project's agents unless given (#1438 wires the roles). */
let builderCount: ((projectPath: string) => number | Promise<number>) | null = null
export function setBuilderCount(fn: ((projectPath: string) => number | Promise<number>) | null): void {
  builderCount = fn
}
export const builderCountOf = (projectPath: string, fallback: () => number | Promise<number>): number | Promise<number> => (builderCount ? builderCount(projectPath) : fallback())

const newToken = (): string => `o-${randomBytes(8).toString('hex')}`

/**
 * A rename's intent (#1441), written with its operation: where the slot's folder was, the name and folder reserved for
 * it, and the state it goes back to (or keeps) once done or given up.
 */
export interface RenameIntent {
  from: string
  toName: string
  to: string
  was: SlotState
  /** The worktree's identity (its git administrative folder, `SlotRenamer.identity`): only that worktree is moved. */
  tree: string
}
/** A gone leased slot's recreation (#1447): its lease, where its folder was and is made, its line, and its state before. */
export interface RecreateIntent {
  lease: string
  from: string
  to: string
  line: string
  was: SlotState
}
/** board_meta: a slot's recreate intent. */
export const recreateKey = (project: string, slot: string): string => `slot_recreate:${project}:${slot}`

/**
 * A free slot's move onto another target (HI-2680: Work merges into moved on), recorded with its operation so a crash
 * part way is settled from the folder: its head and recorded target as the preview saw them (`from`: null for none), the
 * finished branch they were checked against (`baseline`), the new target and its head then, and how far it got
 * (`switched`: its folder was moved to `toHead` and checked, even when that was already its head).
 */
export interface RetargetIntent {
  oldHead: string
  from: string | null
  baseline: string
  to: string
  toHead: string
  stage: 'reserved' | 'switched'
}
export const retargetKey = (project: string, slot: string): string => `slot_retarget:${project}:${slot}`
/** A slot a retarget set aside (HI-2680): the target it was moving to, what its folder was found as, and when. */
export interface SlotAside {
  to: string
  seen: string
  at: string
}
export const asideKey = (project: string, slot: string): string => `slot_aside:${project}:${slot}`
/** A stale jj slot's recovery journal (HI-2866), kept by the slot's name: forgotten with its row (HI-2979). */
export const recoverKey = (project: string, slot: string): string => `slot_jjrecover:${project}:${slot}`
/**
 * A slot kept for a card (HI-2995): its card lease ended with that card's committed work in it, not in the target yet
 * (jj: the slot's working copy is the only place it is). `{ card, generation }`, written with the slot's `dirty` state;
 * its card's next lend takes it back, no one else's; forgotten once the slot is ready again or removed.
 */
export const heldKey = (project: string, slot: string): string => `slot_heldfor:${project}:${slot}`
export interface SlotKeptFor {
  card: number
  generation: string
}
function heldOf(v: unknown): SlotKeptFor | null {
  const h = v as Partial<SlotKeptFor> | null
  return h && typeof h.card === 'number' && Number.isInteger(h.card) && typeof h.generation === 'string' ? { card: h.card, generation: h.generation } : null
}
function retargetIntentOf(v: string): RetargetIntent | null {
  try {
    const i = JSON.parse(v) as Partial<RetargetIntent>
    return typeof i.oldHead === 'string' && (i.from === null || typeof i.from === 'string') && typeof i.baseline === 'string' && typeof i.to === 'string' && typeof i.toHead === 'string' && (i.stage === 'reserved' || i.stage === 'switched') ? (i as RetargetIntent) : null
  } catch {
    return null
  }
}

/** What a slot's retarget ended as (HI-2680): moved to its new target, back as it was, or set aside (dirty or gone). */
export type RetargetEnd = { kind: 'moved' } | { kind: 'kept'; why: 'changed' | 'busy' | 'dirty' | 'moved' | 'unmerged' | 'refused' | 'cantCheck' | 'failed'; detail?: string } | { kind: 'setAside'; state: 'dirty' | 'gone'; detail?: string }
function recreateIntentOf(v: string): RecreateIntent | null {
  try {
    const i = JSON.parse(v) as Partial<RecreateIntent>
    return typeof i.lease === 'string' && typeof i.from === 'string' && typeof i.to === 'string' && typeof i.line === 'string' && typeof i.was === 'string' ? (i as RecreateIntent) : null
  } catch {
    return null
  }
}

/**
 * Delete's reservation of a project's slots and copies (#1447, HR1's round 2), written in one write with its token as
 * the operation of every row it names (their states unchanged): no claim begins on them, and no slot or copy of the
 * project is made, until it ends, finished (the rows deleted), released (their operations cleared), or released by a
 * refresh once its holder is gone.
 */
export interface DeleteReservation {
  token: string
  pid: number
  started: number
  at: string
  slots: string[]
  copies: string[]
}
/** board_meta: a project's Delete reservation. */
export const deleteKey = (project: string): string => `project_delete:${project}`
/** The project's Delete reservation, if one is recorded (a damaged one still counts, with no holder: released at the next refresh). */
export function deletingIn(db: DatabaseSync, project: string): DeleteReservation | null {
  const r = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(deleteKey(project)) as { value: string } | undefined
  if (!r) return null
  try {
    const d = JSON.parse(r.value) as Partial<DeleteReservation>
    if (typeof d.token === 'string' && typeof d.pid === 'number' && typeof d.started === 'number' && Array.isArray(d.slots) && Array.isArray(d.copies)) return d as DeleteReservation
  } catch {
    // Damaged: below.
  }
  return { token: '', pid: 0, started: 0, at: '', slots: [], copies: [] }
}
/** Ends a Delete's reservation (its token), inside a write: the operations it set cleared, its key deleted, nothing else changed. */
export function releaseDeleteIn(db: DatabaseSync, project: string, token: string): void {
  db.prepare('UPDATE slots SET op = NULL, op_kind = NULL, op_lease = NULL, op_pid = NULL, op_started = NULL WHERE project = ? AND op = ?').run(project, token)
  db.prepare('UPDATE copies SET op = NULL, op_kind = NULL, op_pid = NULL, op_started = NULL WHERE project = ? AND op = ?').run(project, token)
  if (deletingIn(db, project)?.token === token) db.prepare('DELETE FROM board_meta WHERE key = ?').run(deleteKey(project))
}

/** board_meta: a slot's rename intent. */
export const renameKey = (project: string, slot: string): string => `slot_rename:${project}:${slot}`
function intentOf(v: string): RenameIntent | null {
  try {
    const i = JSON.parse(v) as Partial<RenameIntent>
    return typeof i.from === 'string' && typeof i.toName === 'string' && typeof i.to === 'string' && typeof i.was === 'string' && typeof i.tree === 'string' ? (i as RenameIntent) : null
  } catch {
    return null
  }
}

/**
 * A rename's steps (#1441: an adopted worktree renamed to a generic name), the app's: Repair's helpers
 * (workspaceMove.ts' `worktreeRenamer`). `who` is the slot's last agent, for the log and the CLIs' records.
 */
export interface SlotRenamer {
  /** A worktree's identity, stable through git's moves (its administrative folder); null when it isn't one git knows. */
  identity(folder: string): Promise<string | null>
  /** Before git's move: each CLI's per-folder data copied for the new path; false when any of it couldn't be. */
  copy(from: string, to: string, who: string): Promise<boolean>
  /** Git's move of the worktree `tree`; true only when that worktree is then at exactly `to` (else moved back). */
  move(from: string, to: string, tree: string): Promise<boolean>
  /** After it: cards' work and sessions' recorded folder follow, only while `tree` is at `to`. Throws when one can't. */
  follow(from: string, to: string, tree: string): Promise<void>
  /**
   * Puts back what `follow` and `move` did to `tree` (never another worktree's), from wherever git lists it (inside
   * another worktree, a move cut short): true once it is at `from` again.
   */
  back(from: string, to: string, tree: string): Promise<boolean>
  /** Where the worktree `tree` is now: at `from`, at `to`, somewhere else git lists it, or unknown (git couldn't say, or doesn't list it: null). */
  where(from: string, to: string, tree: string): Promise<'from' | 'to' | 'elsewhere' | null>
}
/**
 * The `cw-*` entries in a folder's `.agents/skills` (where Combwork puts its skill copies; git-ignored, so the guards
 * don't count them), by name: folders, and links or anything else with that name too (never followed). None only when
 * the skills folder is proved absent; any other error reading it throws, so the slot is kept (cantCheck) rather than
 * removed unseen. Any other folder there (one under the old name included, after the names upgrade: HI-2594) isn't ignored, and
 * keeps the slot as an untracked file does.
 */
async function combworkSkillFolders(folder: string): Promise<string[]> {
  const entries = await readdir(join(folder, '.agents', 'skills'), { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return []
    throw e
  })
  return entries.filter((e) => e.name.toLowerCase().startsWith(COPY_PREFIX)).map((e) => e.name)
}
const newJob = (): string => `slot-${randomBytes(6).toString('hex')}`

/** The longest pause between two owed passes (HI-2906/s101), as a held lane slot's (HI-2466). */
const OWED_PASS_MAX_MS = 30_000

/** board_meta: a slot that owes a settle (HI-2906/s101), by its project's id. */
export const owedKey = (project: string, slot: string): string => `slot_settle_owed:${project}:${slot}`

/** The default scheduler of the owed pass's wake: an unref'd timer. */
const laterBy = (fn: () => void, ms: number): { cancel(): void } => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return { cancel: () => clearTimeout(t) }
}

/** What one settle attempt's fences saw (HI-2906): whether any of them found the folder no longer quiet. */
interface QuietLatch {
  lostQuiet: boolean
  /** What its first refusal saw (for the log), where it was read. */
  why?: string
}

/** A fence whose refusals (a false `still`, an unheld `commit`) set the attempt's latch before they are answered. */
function latched(fence: WorkspaceFence, latch: QuietLatch | undefined): WorkspaceFence {
  if (!latch) return fence
  const commit = fence.commit
  return {
    still: async () => {
      const ok = await fence.still()
      if (!ok) latch.lostQuiet = true
      return ok
    },
    ...(commit
      ? {
          commit: async <T>(fn: (db: FenceDb) => T) => {
            const r = await commit<T>(fn)
            if (!r.held) latch.lostQuiet = true
            return r
          }
        }
      : {})
  }
}

export class SlotPool {
  private readonly store: SlotStore
  /** The operations this pool runs now, awaited as it closes. */
  private readonly running = new Set<Promise<unknown>>()
  /** Why a kept slot's last take-back by its card was refused (HI-2995), for that refusal's words. */
  private readonly keptWhy = new Map<string, AgentMsg>()
  private readonly life = new AbortController()

  constructor(readonly deps: PoolDeps) {
    this.store = deps.store
  }

  /** The workspace lifecycle port its slots are made and inspected with (SPEC §16.3.6 Port 2): the deps', else the slots' platform's. */
  private get port(): WorkspacePort {
    return this.deps.workspaces ?? this.deps.workspacesFor?.() ?? slotWorkspaces()
  }

  /**
   * A slot's own port (HI-2795): the pool's for a slot of the pool's platform, else its platform's (a Git slot in a pool
   * made with jj's port settles, is released and removed by Git, R2.6). Throws for one with no port here: the callers
   * keep it (cantCheck), never act on it with another platform's commands.
   */
  private portOf(s: Pick<Slot, 'platform'>): WorkspacePort {
    const p = s.platform ?? 'git'
    if (p === this.port.platform) return this.port
    const own = isPlatformId(p) ? workspacePortOf(p) : null
    // agent-protocol: a programming error, never an agent's or the user's
    if (!own) throw new Error(`No workspace port for slot platform ${p}`) // i18n-ignore: an internal error, for the log
    return own
  }

  /** Whether a slot has its port here (HI-2936: a leftover of a platform switched from, its port not registered). */
  private hasPort(s: Pick<Slot, 'platform'>): boolean {
    const p = s.platform ?? 'git'
    return p === this.port.platform || (isPlatformId(p) && !!workspacePortOf(p))
  }

  /** Whether a slot is of the pool's platform: the only ones it lends, and those its size counts (HI-2936). */
  private ownPlatform(s: Pick<Slot, 'platform'>): boolean {
    return (s.platform ?? 'git') === this.port.platform
  }

  /**
   * What's in a slot's folder, read by the holder of its operation (`token`): the port's explicit record where it has
   * one (jj: a snapshot, which only the holder may take, HI-2795), else `dirty` (Git, its git command unchanged).
   */
  private async dirtyOwned(s: Slot, token: string, latch?: QuietLatch): Promise<Maybe<string[]>> {
    const port = this.portOf(s)
    if (!port.record) return port.dirty(s.folder)
    // A record is a write in the folder (HR1, HI-2795 round 1): only once nothing else writes there, proved right before
    // it: the operation still holds the slot with no writer or job on it, no session in it, and no process in it.
    const busy = { unknown: true as const, what: s.folder, detail: 'busy' } // i18n-ignore: a protocol detail, never shown
    const why = await this.notQuiet(s, token)
    if (why) {
      if (latch) {
        latch.lostQuiet = true
        latch.why ??= why
      }
      return busy
    }
    const fence: WorkspaceFence = latched({ still: () => this.quietFor(s, token) }, latch)
    const r = await port.record(s.folder, fence, s.identity ?? null)
    // The record refused because its fence lost quiet during it (HI-2906): busy, not dirty.
    return isUnknown(r) && latch?.lostQuiet ? busy : r
  }

  /**
   * A jj write's fence for this operation (HI-2866): `still` is quietFor; `commit` runs a final record (the binding's
   * publication) in the store's own transaction, only while the row there is still this operation's (the token), with
   * no writer or job, and (for a lease's write) the lease still open: one commit with the record, so an owner cancelled
   * or replaced while the write waited for the database publishes nothing (HR1's round 2).
   */
  private ownedFence(s: Slot, token: string, lease: string | null): WorkspaceFence {
    return {
      still: () => this.quietFor(s, token),
      commit: async <T>(fn: (db: FenceDb) => T): Promise<{ held: true; value: T } | { held: false }> => {
        try {
          return await this.store.fenced(s.name, token, (db, now) => {
            if (now.writer || now.job) return { held: false as const }
            if (lease !== null) {
              const open = db.prepare('SELECT 1 AS one FROM slot_leases WHERE id = ? AND project = ? AND ended_at IS NULL').get(lease, this.store.project)
              if (!open || now.op?.lease !== lease) return { held: false as const }
            }
            return { held: true as const, value: fn(db) }
          })
        } catch (e) {
          if (e instanceof OpLost) return { held: false }
          throw e
        }
      }
    }
  }

  /** Nothing but this operation (`token`) in a slot: no writer, no job, no session, no process (the rename probe). */
  private async quietFor(s: Slot, token: string): Promise<boolean> {
    return (await this.notQuiet(s, token)) === null
  }

  /** What keeps a slot from being quiet for this operation (quietFor's answer, for the log): null when it is. English. */
  private async notQuiet(s: Slot, token: string): Promise<string | null> {
    const held = await this.store.fenced(s.name, token, (_db, now) => (now.writer ? 'writer' : now.job ? 'job' : null)).catch(() => 'operation lost') // agent-protocol: a log line's detail, never sent to an agent
    if (held) return held
    const session = this.deps.sessionIn?.(s.folder)
    if (session) return `session ${session}` // agent-protocol: a log line's detail, never sent to an agent
    return (await quiet(s.folder)) ? null : 'the folder is in use' // agent-protocol: a log line's detail, never sent to an agent
  }

  /** A slot's removal journal (HI-2795: a jj removal's phases, so an interrupted one resumes), board_meta by key. */
  /**
   * A slot's row deleted, with everything kept by its name (HI-2979): its rename's aside, its recovery's journal, and
   * what its platform keeps by its workspace (jj's binding pointer and preparation journals), in the caller's write.
   */
  private forgetIn(db: FenceDb, s: Slot, port: WorkspacePort): void {
    db.prepare('DELETE FROM slots WHERE project = ? AND name = ?').run(this.store.project, s.name)
    db.prepare('DELETE FROM board_meta WHERE key = ?').run(asideKey(this.store.project, s.name))
    db.prepare('DELETE FROM board_meta WHERE key = ?').run(recoverKey(this.store.project, s.name))
    db.prepare('DELETE FROM board_meta WHERE key = ?').run(heldKey(this.store.project, s.name))
    if (s.identity) port.forgetIn?.(db, s.identity)
  }

  private removalJournal(name: string): WorkspaceJournal {
    return this.store.journal(`slot_wsremove:${this.store.project}:${name}`)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The pool's size: the builders, at least one, at most the cap. */
  async size(): Promise<number> {
    return Math.max(1, Math.min(this.deps.cap(), await this.deps.builders()))
  }

  slots(): Slot[] {
    return this.store.slots()
  }

  /** The card a slot is kept for (HI-2995), or null. */
  keptCard(name: string): number | null {
    return this.store.keptCard(name)
  }

  slotOf(lease: SlotLease | string): Slot | null {
    const l = typeof lease === 'string' ? this.store.lease(lease) : lease
    return l ? this.store.slot(l.slot) : null
  }

  leaseOf(of: { card: number } | { lane: string }): SlotLease | null {
    return this.store.leaseOf(of)
  }

  lease(id: string): SlotLease | null {
    return this.store.lease(id)
  }

  leasesOf(agent: string): SlotLease[] {
    return this.store.leasesOf(agent)
  }

  openLeases(): SlotLease[] {
    return this.store.openLeases()
  }

  endedSince(iso: string): SlotLease[] {
    return this.store.endedSince(iso)
  }

  openLease(slot: string): SlotLease | null {
    return this.store.openLease(slot)
  }

  /** Runs an operation as this pool's: its token among the holder's live ones while it runs, awaited by `close`. */
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

  /**
   * A start's claim of a slot's writer (#1434), tracked as this pool's work as an operation is: `close` awaits it until
   * the start has either spawned its process (which its session's exit then releases) or released the writer. Null
   * once the pool is closing: no claim is made then.
   */
  trackWriter(): { done: () => void } | null {
    if (this.closed) return null
    let done!: () => void
    const p = new Promise<void>((r) => (done = r))
    this.running.add(p)
    void p.then(() => this.running.delete(p))
    let once = false
    return {
      done: () => {
        if (once) return
        once = true
        done()
      }
    }
  }

  /** The workspace closes: running commands are ended (their runs' signal), and the operations awaited. */
  async close(): Promise<void> {
    this.life.abort()
    await Promise.allSettled([...this.running])
  }

  get closed(): boolean {
    return this.life.signal.aborted
  }

  /**
   * Lends a slot to a card or a lane for its builder: a ready one looked at again, else a new one while the pool is
   * under its size, warmed before it is given. Refused, with why, when none is free, the slot asked for is in use, the
   * agent already builds in another, the card's slot is being set up, or a new slot's setup failed (its lease then ended
   * `setupFailed`). None lent with a free one passed over as held (a session or a process in it): `busy`, naming it
   * (HI-2466), not `noSlot`.
   */
  async lend(req: LeaseRequest, o: { target?: string; install?: boolean } = {}): Promise<LendResult> {
    if ((req.card === undefined) === (req.lane === undefined)) throw new Error('a lease is for a card or a lane') // agent-protocol: a programming error (its caller's), never an agent's or the user's
    if (this.closed) return { ok: false, refusal: { why: 'noSlot', size: 0 } }
    // The project's platform read again first (HI-2866): a lending is made with the platform in force now.
    await this.deps.refreshPorts?.()
    await this.refresh()
    const target = o.target ?? (await this.defaultTarget())
    const holder = await this.deps.holder.self()
    const skip = new Set<string>()
    // A free slot passed over because something holds it (HI-2466): said, rather than "every slot in use", when no
    // other can be lent, so its caller knows the wait ends once that is gone (and looks again).
    let held: SlotRefusal | null = null
    const size = await this.size()
    for (;;) {
      const token = newToken()
      // The operation is this pool's (its token live, its work awaited by close) from before the write that reserves the
      // slot: a refresh meanwhile never takes a reservation just committed for one whose holder is gone.
      const out = await this.op(token, async (): Promise<LendResult | 'skip'> => {
        const taken = await this.store.take(req, { size, root: this.deps.root, target, token, holder, skip, ...(this.port.platform !== 'git' ? { platform: this.port.platform } : {}) })
        if (!taken.ok) return held && taken.refusal.why === 'noSlot' ? { ok: false, refusal: held } : taken
        if (taken.again) {
          // Its lease already: handed over only once the slot is ready (another Combwork may be warming it).
          const s = taken.slot
          if (s.op) return { ok: false, refusal: { why: 'warming', slot: s.name } }
          if (s.state !== 'lent' || s.job || s.warmError) return { ok: false, refusal: { why: 'notReady', slot: s.name, state: s.state, error: s.warmError } }
          return { ok: true, lease: taken.lease, slot: s }
        }
        const done = await this.warm(taken.slot, taken.lease, token, taken.fresh, target, o.install !== false, !!taken.reclaim)
        // A kept slot taken back (HI-2995): lent, or refused naming it, never another slot instead.
        if (taken.reclaim && done !== 'ready') return { ok: false, refusal: done !== 'skip' ? done : { why: 'notReady', slot: taken.slot.name, state: this.store.slot(taken.slot.name)?.state ?? 'dirty', error: say(T.kept, { slot: taken.slot.name, why: say(this.keptWhy.get(taken.slot.name) ?? T.keptBusy) }) } }
        if (done === 'ready') return { ok: true, lease: this.store.lease(taken.lease.id)!, slot: this.store.slot(taken.slot.name)! }
        if (done !== 'skip' && done.why !== 'busy') return { ok: false, refusal: done }
        skip.add(taken.slot.name)
        if (done !== 'skip') held ??= done
        // The slot asked for by name, passed over: refused once, never reserved again and again.
        return req.slot ? { ok: false, refusal: done !== 'skip' ? done : { why: 'busy', slot: taken.slot.name } } : 'skip'
      })
      if (out !== 'skip') return out
    }
  }

  /**
   * The slot a card's or lane's start chose now serves its target (HI-2185): recorded on the slot while `lease`, the one
   * chosen, is still open and `agent`'s, so a released slot waits detached at that line's head and its clean-up checks
   * against it. One place for every way a start gets its slot (lent, handed over, taken over, already held). False: the
   * lease ended or isn't the agent's, nothing written.
   */
  serves(lease: string, agent: string, target: string): Promise<boolean> {
    return this.store.serves(lease, agent, target)
  }

  /** A carried lease handed off to a card or lane of its agent's (#1441), `also` in the same write (SlotStore.handOff). */
  handOff(carried: string, req: { card?: number; lane?: string; agent: string }, also?: (db: DatabaseSync, lease: SlotLease) => void, check?: (slot: Slot) => boolean): Promise<SlotLease | null> {
    return this.store.handOff(carried, req, also, check)
  }

  /** The slot an agent's own run still writes in, taken over by its next card or lane (HI-1762, SlotStore.takeWrittenSlot), held by this Combwork. */
  async takeWrittenSlot(slot: string, req: { card?: number; lane?: string; agent: string }, run: string, also?: (db: DatabaseSync, lease: SlotLease, was: string) => void): Promise<SlotLease | null> {
    return this.store.takeWrittenSlot(slot, req, run, await this.deps.holder.self(), also)
  }

  /** Why takeWrittenSlot wouldn't take it now (SlotStore.writtenNotTakeable), held by this Combwork; null: it would. */
  async writtenNotTakeable(slot: string, agent: string, run: string): Promise<string | null> {
    return this.store.writtenNotTakeable(slot, agent, run, await this.deps.holder.self())
  }

  lastLease(name: string): SlotLease | null {
    return this.store.lastLease(name)
  }

  /** Whether a carried lease is one the agent's Resume took, not an adopted worktree's (SlotStore.resumedCarry). */
  resumedCarry(lease: SlotLease): boolean {
    return this.store.resumedCarry(lease)
  }

  /** The renames under way (#1441), and intents no operation owns cleared (SlotStore's). */
  renames(): { slot: string; intent: RenameIntent }[] {
    return this.store.renames()
  }

  clearOrphanRenames(): Promise<number> {
    return this.store.clearOrphanRenames()
  }

  /** Where a slot of a name has its folder. */
  folderFor(name: string): string {
    return join(this.deps.root, name)
  }

  /** A carried lease for an agent's adopted worktree (#1441); null when it can't be adopted now (see SlotStore.carry). */
  carry(agent: string, slot: { name: string; folder: string; target?: string | null }): Promise<SlotLease | null> {
    return this.store.carry(agent, { ...slot, target: slot.target ?? null })
  }

  /**
   * Ends a lease and looks at its slot once no operation holds it. Whether it was ended. `check`: the caller's condition,
   * decided in the write that ends it (false: it stays open).
   */
  async release(lease: string, why: string, check?: () => boolean): Promise<boolean> {
    const ended = await this.store.end(lease, why, check)
    if (!ended) return false
    const slot = this.store.slot(ended.slot)
    // Its writer (the builder's session there) drains, and is stopped once its turn is over (#1434).
    if (slot) this.deps.ended?.(ended, slot)
    await this.drained(ended.slot)
    return true
  }

  /**
   * After a lease's end or its writer's exit (#1434): with no writer left, the ended lease's last revision recorded
   * (the slot's head now: nothing of it writes there any more) and the slot looked at. While a writer drains, nothing.
   */
  async drained(name: string): Promise<void> {
    const s = this.store.slot(name)
    if (!s || s.writer) return
    const last = this.store.lastLease(name)
    if (last?.to && !last.endRev && this.hasPort(s) && (await folderThere(s.folder))) {
      const rev = await this.portOf(s).head(s.folder)
      if (!isUnknown(rev)) await this.store.finalizeEndRev(last.id, rev)
    }
    await this.settle(name)
  }

  /**
   * A slot no operation, lease or writer holds, looked at: ready, dirty or gone. Otherwise left to its holder. The look
   * and its detach are a settle operation (HI-2170: a warm-kind one with no lease), taken in one write while the slot is
   * free and as it was read, so another look of it (this pool's or another Combwork's, a finished card's slot question)
   * sees it busy while its files may change, and one settle runs at a time. `looked` is told when its state changed.
   */
  private async settle(name: string): Promise<boolean> {
    const seen = this.store.slot(name)
    if (this.closed || !seen || seen.op || seen.writer || this.store.openLease(name)) return false
    if (seen.state === 'creating' || seen.state === 'removing') return false
    // HI-2936: a slot whose platform has no port here is kept as it is, never looked at with another platform's commands.
    if (!this.hasPort(seen)) return false
    // Set aside by a retarget (HI-2680): stays as it is, whatever its folder now looks like, until it is removed.
    if (this.store.asideOf(name)) return false
    const token = newToken()
    let s: Slot = seen
    let to: SlotState = seen.state
    let began = false
    // HI-2906 (design s101): its look or its detach couldn't run while something still left the folder, known from what
    // this attempt's own fences saw (the latch), never from a later check. The slot then owes a settle: recorded in this
    // attempt's fenced end write, with its row, and run by the pool's owed pass.
    let busyDetach = false
    // HI-2995: kept for its card (its detach refused as the card's own work, after a card lease), or ready again (forgotten).
    let held: SlotKeptFor | 'forget' | null = null
    // What the end write does to the slot's owed record: set (busy), cleared (decided), or left (the look couldn't say).
    const end: { owed: 'set' | 'clear' | 'keep' } = { owed: 'keep' }
    const latch: QuietLatch = { lostQuiet: false }
    try {
      // Tracked (awaited by close, its token live) from before its first wait, so a close never misses it and no look of
      // a pool takes its row, once written, for an abandoned one (HR2's HI-2170 round 1, finding 1).
      await this.op(token, async () => {
        const holder = await this.deps.holder.self()
        if (this.closed) return
        // Taken only of the slot as it was read, at the same folder (a Repair's relocation meanwhile: not this one's, the
        // next look's; finding 2), and used as the reservation has it from then on.
        if (!(await this.store.beginSettle(name, seen.state, seen.folder, token, holder))) return
        began = true
        s = this.store.slot(name) ?? seen
        try {
          const now = await this.looks(s, token, latch)
          // Clean, it waits for its next card detached at the target's head (HI-2014, HI-1986), before it is ready to lend:
          // its card's line is no longer checked out (committed work stays on that line), so a merged one can be deleted.
          // Not detached (git couldn't read or switch it: an index lock, say): not ready yet either, so the next look tries
          // again (HR2's HI-2014 round 1, finding 4), never a ready slot left on its card's line.
          // Git couldn't list the worktrees (HI-2810): the slot as it was, the next look tries again.
          const detached = now === 'ready' && s.state !== 'ready' ? await this.detach(s, token, latch) : null
          const last = detached === 'kept' ? this.store.lastLease(s.name) : null
          if (now === 'busy') busyDetach = true
          else if (detached === 'kept' && last?.kind === 'card' && last.card !== null && s.identity) {
            // The card's own committed work, not in the target (HI-2995): kept for it, never lent with no lease.
            to = 'dirty'
            held = { card: last.card, generation: s.identity.generation }
            log.info(`${userText(s.name)} is kept for #${last.card}: its committed work isn't in ${userText(s.target ?? '')} yet`)
          } else if (detached !== null && detached !== 'ok') {
            // A refusal for good (the work not in the target, the target moved) waits for the next refresh or event; one
            // while the folder wasn't quiet yet (its builder's session or a process still leaving it: jj's owned move is
            // fenced by quiet) is asked again soon, as nothing else may say when it has gone (HI-2906).
            busyDetach = latch.lostQuiet
            // For the log only (the latch decided): what is in the way now, read after the refusal.
            if (busyDetach && !latch.why) latch.why = `the detach's fence; now: ${(await this.notQuiet(s, token)) ?? 'quiet'}` // agent-protocol: a log line's detail, never sent to an agent
          } else if (now !== null) {
            to = now
            if (now === 'ready') held = 'forget'
            // Its card's own work with an edit not committed yet beside it (HR1's round 1): left dirty, so no detach is
            // asked; kept for that card all the same while the slot's binding is still that card's (read through the
            // port), so its next start gets the slot, its commits and its edit back. Anyone else's or unknown: as before.
            else if (now === 'dirty') {
              const lastLease = this.store.lastLease(s.name)
              const port = this.portOf(s)
              if (lastLease?.kind === 'card' && lastLease.card !== null && s.identity && port.heldFor && (await port.heldFor(s.folder, s.identity, lastLease.card))) {
                held = { card: lastLease.card, generation: s.identity.generation }
                log.info(`${userText(s.name)} is kept for #${lastLease.card}: its work, an edit not committed yet included, is still in it`)
              }
            }
          }
          // Busy: owed. Decided (ready, dirty, gone, or a refusal for good, which waits for the next event): not owed. The
          // listing failed (null): as it was.
          end.owed = busyDetach ? 'set' : now === null ? 'keep' : 'clear'
        } finally {
          // Its operation ends with what it found, or the slot as it was (a failure: the next look tries again), and its
          // owed record with it, in one transaction: lost meanwhile (taken over), neither is written.
          let wrote = false
          await this.store
            .fenced(name, token, (db) => {
              this.store.setIn(db, name, to, {}, { op: null })
              if (held === 'forget') db.prepare('DELETE FROM board_meta WHERE key = ?').run(heldKey(this.store.project, name)) // agent-protocol: SQL
              else if (held) db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(heldKey(this.store.project, name), JSON.stringify(held)) // agent-protocol: SQL
              if (end.owed === 'set') db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(owedKey(this.store.project, name), JSON.stringify({ why: latch.why ?? 'busy', since: Date.now() })) // agent-protocol: SQL
              else if (end.owed === 'clear') db.prepare('DELETE FROM board_meta WHERE key = ?').run(owedKey(this.store.project, name)) // agent-protocol: SQL
              wrote = true
            })
            .catch((e) => {
              if (!(e instanceof OpLost)) throw e
              // Taken over meanwhile: what it found isn't the slot's, its new holder's look is.
              to = s.state
            })
          if (!wrote) end.owed = 'keep'
        }
      })
    } finally {
      // After its row's write, only a change: a pass that settles slots asks for itself again, so a slot that stays dirty
      // mustn't loop it.
      if (began && to !== s.state) this.deps.looked?.(name, to)
      // Owed now: the pool's owed pass is asked for (after its pause), after this settle's fenced end. While a pass runs,
      // its own end reads the records (with no await since its last settle) and asks, with its pause grown.
      if (end.owed === 'set') {
        log.info(`${userText(name)} isn't quiet yet (${latch.why ?? 'busy'}): it owes a settle, looked at again by the pool`)
        if (!this.owedRunning) this.wakeOwed()
      }
    }
    return began
  }

  /** The owed pass running now (at most one), and whether another was asked for while it ran (HI-2906). */
  private owedRunning: Promise<void> | null = null
  private owedAgain = false
  /** The one pending wake of the owed pass, and how many passes in a row have found a slot still owed (its pause). */
  private owedWake: { cancel(): void } | null = null
  private owedTries = 0
  private owedOwned = false

  /** The slots of this project that owe a settle (HI-2906), by name. */
  owedSlots(): string[] {
    const prefix = owedKey(this.store.project, '')
    return this.store.conn.read((db) => (db.prepare('SELECT key FROM board_meta WHERE substr(key, 1, ?) = ?').all(prefix.length, prefix) as { key: string }[]).map((r) => r.key.slice(prefix.length))) // agent-protocol: SQL
  }

  /** A slot's owed record (tests, the log): why and since when, or null. */
  owedOf(name: string): { why: string; since: number } | null {
    const v = this.store.conn.read((db) => db.prepare('SELECT value FROM board_meta WHERE key = ?').get(owedKey(this.store.project, name)) as { value: string } | undefined) // agent-protocol: SQL
    try {
      return v ? (JSON.parse(v.value) as { why: string; since: number }) : null
    } catch {
      return { why: 'unreadable', since: 0 } // agent-protocol: a log detail
    }
  }

  /** Whether a wake of the owed pass is pending (tests). */
  owedWakePending(): boolean {
    return !!this.owedWake
  }

  /**
   * The owed pass asked for after its pause (1 s, doubling with each pass that still finds a slot owed, at most
   * OWED_PASS_MAX_MS), unless one is pending or the pool is closed. A wake owns nothing: the records stay until a settle
   * decides them, so a wake cancelled, or a pass that finds a slot taken, loses nothing (HI-2906/s101).
   */
  private wakeOwed(): void {
    if (this.closed || this.owedWake) return
    if (!this.owedOwned) {
      // One listener for the pool: its close cancels the pending wake (the running pass is in `running`, awaited).
      this.owedOwned = true
      this.life.signal.addEventListener('abort', () => {
        this.owedWake?.cancel()
        this.owedWake = null
      }, { once: true })
    }
    const ms = Math.min(OWED_PASS_MAX_MS, 1000 * 2 ** this.owedTries)
    const later = this.deps.later ?? laterBy
    this.owedWake = later(() => {
      this.owedWake = null
      void this.owedPass().catch((e) => log.warn('looking at slots that owe a settle', e))
    }, ms)
  }

  /**
   * The owed pass (HI-2906/s101): each slot of this project that owes a settle, settled in turn (the ordinary settle, which
   * re-reads everything under the slot's operation and decides its record in its fenced end). One at a time: asked for
   * while one runs, it runs again once that ends. Records for slots no longer in the pool go. Afterwards, while any slot
   * still owes one, the next pass is asked for (its pause growing); none, the pause starts again from 1 s.
   */
  owedPass(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.owedRunning) {
      this.owedAgain = true
      return this.owedRunning
    }
    const run = (async () => {
      do {
        this.owedAgain = false
        for (const name of this.owedSlots()) {
          if (this.closed) return
          if (!this.store.slot(name)) {
            // A slot removed since: its record can't keep the pass alive. Its absence proved again in the delete itself, so a
            // slot of that name made meanwhile (and its fresh record) keeps it (HR1's round 4).
            await this.store.conn.write((db) => void db.prepare('DELETE FROM board_meta WHERE key = ? AND NOT EXISTS (SELECT 1 FROM slots WHERE project = ? AND name = ?)').run(owedKey(this.store.project, name), this.store.project, name)) // agent-protocol: SQL
            continue
          }
          await this.settle(name)
        }
      } while (this.owedAgain && !this.closed)
    })()
    const tracked = run.finally(() => {
      this.running.delete(tracked)
      if (this.owedRunning === tracked) this.owedRunning = null
      if (this.closed) return
      // Decided right here, with no await since the pass's last settle: a slot still owed (busy again, or taken by another
      // settle meanwhile, whose own end asks too) asks for the next pass.
      // HI-2936: one whose platform has no port here waits for a refresh once it has (its settle keeps it till then).
      if (this.owedSlots().some((n) => { const s = this.store.slot(n); return !s || this.hasPort(s) })) {
        this.owedTries++
        this.wakeOwed()
      } else this.owedTries = 0
    })
    this.running.add(tracked)
    this.owedRunning = tracked
    return tracked
  }

  /**
   * A stale jj slot's recovery (HI-2866, J2's `recoverStale`): the user's explicit action, never the pool's clean-up. Run
   * under a settle-kind operation of the slot (taken only while it is free and as it was read, as a look is), with that
   * operation's quiescence as its fence and its own journal, so an interrupted recovery resumes on the next try. `run`
   * is the caller's (the app's: J2's recovery with its dependencies). A slot of another platform, busy, or not stale is
   * refused with why; a recovered slot rejoins the pool only through its next look and preparation's check.
   *
   * `held` (HI-2913): a slot its card's or lane's lease still holds, let through only for that lease (`lease`) while its
   * card's cycle there failed its preparation (the caller's: `refresh` reads it afresh, slowly; `now` answers from what is
   * stored, synchronously, inside the proof's transaction), proved after the claim and again before each of the recovery's
   * writes (`still` below: the slow reads, then one final proof after them). Claimed with
   * `beginRecover`, never by relaxing a free slot's settle; the lease ending, being replaced or the cycle moving on stops
   * the recovery at its next write (its journal resumes it on the next Recover…).
   */
  async recoverStale(name: string, run: (s: Slot, fence: WorkspaceFence, journal: WorkspaceJournal, quietNow: () => Promise<boolean>) => Promise<RecoverOutcome>, held?: { lease: string; refresh: () => Promise<boolean>; now: () => boolean }): Promise<RecoverOutcome> {
    const seen = this.store.slot(name)
    if (this.closed || !seen) return { ok: false, why: 'noSlot' } // i18n-ignore: a protocol code
    if ((seen.platform ?? 'git') !== 'jj' || !seen.identity) return { ok: false, why: 'notJj' } // i18n-ignore: a protocol code
    const open = this.store.openLease(name)
    // What holds it, for the log (HI-2913: a refused Recover… says why there); the answer stays `busy`.
    const holds = seen.op ? `operation ${seen.op.kind}` : seen.writer ? `writer ${seen.writer.run}` : (held ? open?.id !== held.lease : !!open) ? `lease ${open?.id ?? 'none'}` : seen.state === 'creating' || seen.state === 'removing' ? seen.state : null // agent-protocol: a log line's detail, never sent to an agent
    if (holds) {
      log.info(`Slot ${userText(name)}'s recovery refused: ${holds}`)
      return { ok: false, why: 'busy' } // i18n-ignore: a protocol code
    }
    const token = newToken()
    let out: RecoverOutcome = { ok: false, why: 'busy' } // i18n-ignore: a protocol code
    await this.op(token, async () => {
      const holder = await this.deps.holder.self()
      if (this.closed) return
      if (!(await (held ? this.store.beginRecover(name, held.lease, seen.folder, token, holder) : this.store.beginSettle(name, seen.state, seen.folder, token, holder)))) return void log.info(`Slot ${userText(name)}'s recovery refused: it changed before it could be claimed`)
      try {
        const s = this.store.slot(name) ?? seen
        // Each refusal said in the log once (the recovery stops at it): what was in the folder, or what changed.
        const stop = (why: string): false => (log.info(`Slot ${userText(name)}'s recovery stopped: ${why}`), false)
        // A held slot's proof (HR1's HI-2913 round 1): the slow reads first (the caller's eligibility, read afresh; the
        // folder's quiet, its rename probe last), then, after the last of them, one write that finds the operation still
        // this one's under the same open lease with no writer or job, the cycle still failed and unprepared (`now`, read in
        // that same transaction), and no session in the folder read right after it: nothing observed before an await
        // stands in for the answer.
        const still = async (): Promise<boolean> => {
          if (held && !(await held.refresh())) return stop("its card's failed preparation changed") // agent-protocol: a log line's detail, never sent to an agent
          const why = await this.notQuiet(s, token)
          if (why) return stop(why)
          if (!held) return true
          const proof = await this.store.fenced(name, token, (db, now) => (now.writer ? 'a writer came in' : now.job ? 'a job came in' : now.op?.lease !== held.lease || !this.store.openIn(db, held.lease) ? 'its lease ended or changed' : !held.now() ? "its card's failed preparation changed" : null)).catch(() => 'its operation was taken over') // agent-protocol: a log line's detail, never sent to an agent
          if (proof) return stop(proof)
          const session = this.deps.sessionIn?.(s.folder)
          return session ? stop(`session ${session}`) : true // agent-protocol: a log line's detail, never sent to an agent
        }
        if (held && !(await still())) return
        const fence: WorkspaceFence = { still }
        out = await run(s, fence, this.store.journal(recoverKey(this.store.project, name)), still)
      } finally {
        await this.store.fenced(name, token, (db) => this.store.setIn(db, name, seen.state, {}, { op: null })).catch((e) => {
          if (!(e instanceof OpLost)) throw e
        })
      }
    })
    return out
  }

  /**
   * A clean slot on a line, switched to its target's head, detached. Only after a card's or a lane's lease: an adopted
   * worktree (a carried lease, #1441) stays on its agent's own line. False when it should be and isn't (unread, or the
   * switch failed); `kept` when the port refused it as the slot's own work not in the target yet (HI-2995); `ok` when
   * it is, or needn't be.
   */
  private async detach(s: Slot, token?: string, latch?: QuietLatch): Promise<'ok' | 'kept' | 'failed'> {
    const last = this.store.lastLease(s.name)
    if (!s.target || !last || (last.kind !== 'card' && last.kind !== 'lane')) return 'ok'
    const port = this.portOf(s)
    const h = await port.heads(s.folder, s.target)
    if (isUnknown(h.line)) return 'failed'
    if (!h.line) return 'ok'
    if (isUnknown(h.target) || !h.target) return 'failed'
    // jj's (HI-2866): an owned write settling exactly the card's binding (the line it answered), fenced by this operation
    // with the folder quiet, the target read again right before it. Git ignores the options.
    const owned = port.platform === 'jj' ? { identity: s.identity ?? null, fence: latched(token ? this.ownedFence(s, token, null) : { still: () => false }, latch), settles: h.line, target: s.target } : {}
    const r = await port.detach(s.folder, h.target, owned)
    if (!r.ok) {
      log.warn(`detaching ${userText(s.name)} at ${userText(s.target)}: ${userText(r.err.trim())}`)
      return r.kept ? 'kept' : 'failed'
    }
    log.info(`${userText(s.name)} detached at ${userText(s.target)} (it was on ${userText(h.line)})`)
    return 'ok'
  }

  /**
   * What a slot is on disk now: gone (no folder, or git doesn't list it), dirty, or ready; null when git can't list its
   * worktrees (HI-2810, SPEC §16.3.6 R2.1: unknown is never gone, nor ready), so the caller keeps the slot as it is.
   */
  private async look(s: Slot, token: string): Promise<SlotState | null> {
    const l = await this.looks(s, token)
    return l === 'busy' ? 'dirty' : l
  }

  /**
   * As `look`, but `busy` when its check couldn't run because something still worked in the folder (HI-2906: jj's record
   * is fenced by quiet), so the settle leaves the slot as it was and looks again soon, never marking it dirty for that.
   */
  private async looks(s: Slot, token: string, latch?: QuietLatch): Promise<SlotState | 'busy' | null> {
    const there = await this.present(s)
    if (there === null) return null
    if (!there) return 'gone'
    const d = await this.dirtyOwned(s, token, latch)
    if (isUnknown(d) && d.detail === 'busy') return 'busy'
    return isUnknown(d) || d.length ? 'dirty' : 'ready'
  }

  /** Whether a slot is there: its folder, and git lists it; null when git's listing fails (#734: never an empty one). */
  private async present(s: Slot): Promise<boolean | null> {
    if (!(await folderThere(s.folder))) return false
    if (!this.hasPort(s)) return null
    const listed = await this.portOf(s).list(this.deps.project).catch(() => null)
    return listed ? listed.some((l) => samePlace(l.path, s.folder)) : null
  }

  /** Whether an operation's holder is gone: another process that ended, or this one, no longer running that token. */
  private async holderGone(op: SlotOp): Promise<boolean> {
    const me = await this.deps.holder.self()
    if (op.pid === me.pid && op.started === me.started) return !this.deps.holder.live.has(op.token)
    return (await this.deps.holder.alive(op.pid, op.started)) === false
  }

  /**
   * A Delete's reservation of the project's slots and copies whose holder is gone (#1447: its Combwork ended mid-Delete):
   * released whole in one write, the rows as they were (a folder already in the Recycle Bin is then seen gone).
   */
  private async releaseStaleDelete(): Promise<void> {
    const project = this.store.project
    const d = this.store.conn.read((db) => deletingIn(db, project))
    if (!d || (d.token && !(await this.holderGone({ token: d.token, kind: 'remove', lease: null, pid: d.pid, started: d.started })))) return
    await this.store.conn.write((db) => {
      if (deletingIn(db, project)?.token === d.token) releaseDeleteIn(db, project, d.token)
    })
    log.warn(`Released a Delete's hold on the project's slots and copies: process ${d.pid}, which held it, is gone`)
  }

  /**
   * A slot's writer of a Combwork that has gone, settled by what was kept of its run (HI-1886): cleared and drained when
   * `writerGone` says so. True when it was settled.
   */
  private async settleGone(s: Slot): Promise<boolean> {
    const w = s.writer
    if (!w || !this.deps.writerGone) return false
    const evidence = await this.deps.writerGone.settles(w, s.name)
    if (!evidence) return false
    let clear: boolean
    try {
      clear = await this.store.clearWriter(s.name, w.run, this.deps.writerGone.still?.(evidence))
    } catch {
      // What settled it no longer holds (HI-2055): it stays held.
      return false
    }
    if (clear) {
      this.deps.writerGone.cleared(w.run, evidence)
      await this.drained(s.name)
    }
    return true
  }

  /** The slots' writers of Combworks that have gone, settled where they may be (HI-1886): as the pool is made, and hourly. */
  async settleGoneWriters(): Promise<void> {
    for (const s of this.store.slots()) {
      if (this.closed) return
      await this.settleGone(s)
    }
  }

  /**
   * Brings the rows in step with what runs and what is on disk: an operation whose holder is gone is taken over and
   * recovered, a job left unsettled is settled again, an unleased slot left `lent` or `dirty` is looked at, a leased one
   * whose folder is gone is marked `gone`.
   */
  async refresh(): Promise<void> {
    await this.releaseStaleDelete()
    for (const s of this.store.slots()) {
      if (this.closed) return
      // A writer whose run is over, its processes known to have ended, but not cleared (its release couldn't be written).
      if (s.writer && (await this.deps.writerOver?.(s.writer))) {
        if (await this.store.clearWriter(s.name, s.writer.run)) {
          this.deps.overCleared?.(s.writer.run)
          await this.drained(s.name)
        }
        continue
      }
      if (await this.settleGone(s)) continue
      if (s.op) {
        if (await this.holderGone(s.op)) await this.recover(s)
        continue
      }
      if (s.job) {
        if (await this.deps.settle(s.job)) await this.store.jobSettled(s.name, s.job)
        else continue
      }
      if (this.store.openLease(s.name)) {
        // Gone only when git says so (HI-2810: a failed listing leaves it lent, looked at again by the next refresh).
        if (s.state === 'lent' && (await this.present(s)) === false) await this.store.markGone(s.name)
        continue
      }
      if (s.state === 'lent' || s.state === 'dirty' || s.state === 'gone') await this.settle(s.name)
    }
    // And the slots that owe a settle (HI-2906): the owed pass, which runs one at a time.
    if (!this.closed) await this.owedPass()
  }

  /**
   * HI-2680: moves a free slot onto another target, as the confirmed preview saw it (`expect`: its folder, its recorded
   * target, its head; `baseline`: the finished branch it was checked against). Reserved in the pool's write; under the
   * repository's lock, outside any database write, the folder checked (there, clean, at the head seen, in the baseline),
   * `still()` asked (the caller's authority, the project's target still `to`), then detached at `to`'s head and checked;
   * then classified from the folder against its intent and finished by its operation. Every exit is classified the same way.
   */
  async retarget(name: string, expect: { folder: string; target: string | null; head: string }, baseline: string, to: string, still: () => boolean | Promise<boolean>): Promise<RetargetEnd> {
    const toHead = await this.port.lineHead(this.deps.project, to)
    if (isUnknown(toHead) || !toHead) return { kind: 'kept', why: 'cantCheck', detail: `can't read ${to}` } // agent-protocol: a reason's detail for the log and the result, as git's are (English)
    const token = newToken()
    return this.op(token, async (): Promise<RetargetEnd> => {
      const intent = { oldHead: expect.head, from: expect.target, baseline, to, toHead }
      if (!(await this.store.startRetarget(name, { folder: expect.folder, target: expect.target }, token, await this.deps.holder.self(), intent))) return { kind: 'kept', why: 'changed' }
      let why: Extract<RetargetEnd, { kind: 'kept' }>['why'] | null = null
      let detail: string | undefined
      // A failure part way (git, the store, the caller's check; HR1's round 1, finding 3): settled from the folder as any exit.
      const failed = (e: unknown): void => void ((why = 'failed'), (detail = e instanceof Error ? e.message : String(e)))
      await withFolderRepoLocks([this.deps.project], async () => {
        const pre = await this.retargetable(expect.folder, expect.head, baseline)
        if (pre) return void ((why = pre.why), (detail = pre.detail))
        if (!(await still())) return void (why = 'refused')
        if (expect.head !== toHead) {
          const sw = await this.port.detach(expect.folder, toHead, { quiet: true })
          if (!sw.ok) return void ((why = 'cantCheck'), (detail = this.port.errorLine(sw.err)))
        }
        const head = await this.port.head(expect.folder)
        const d = await this.port.dirty(expect.folder)
        if (isUnknown(head) || head !== toHead || isUnknown(d) || d.length) return
        await this.store.retargetSwitched(name, token)
      }, { quiet: true, project: this.deps.project }).catch(failed)
      // Its settle failing too: the intent and the operation stay recorded, so the next refresh, finding this operation
      // over (its token no longer live), takes it over and settles it from the folder (`recover`); never lent meanwhile.
      const end = await this.settleRetarget(name, token).catch((e: unknown): RetargetEnd => {
        log.warn(`Slot ${userText(name)}'s retarget to ${userText(to)} couldn't be settled, left for the next look: ${userText(e instanceof Error ? e.message : String(e))}`)
        return { kind: 'kept', why: 'failed', detail: e instanceof Error ? e.message : String(e) }
      })
      if (end.kind === 'moved' || end.kind === 'setAside' || (end.kind === 'kept' && end.why === 'failed')) return end
      return why ? { kind: 'kept', why, ...(detail ? { detail } : {}) } : end
    })
  }

  /** Whether a free slot's folder can move (HI-2680): there, clean (tracked and untracked), at `head`, and in `baseline`. */
  private async retargetable(folder: string, head: string, baseline: string): Promise<{ why: 'dirty' | 'moved' | 'unmerged' | 'cantCheck'; detail?: string } | null> {
    if (!(await folderThere(folder))) return { why: 'cantCheck', detail: 'its folder is gone' } // agent-protocol: a reason's detail for the log and the result, as git's are (English)
    const d = await this.port.dirty(folder)
    if (isUnknown(d)) return { why: 'cantCheck', detail: d.what }
    if (d.length) return { why: 'dirty' }
    const h = await this.port.head(folder)
    if (isUnknown(h)) return { why: 'cantCheck', detail: h.what }
    if (h !== head) return { why: 'moved' }
    const b = await this.port.lineHead(this.deps.project, baseline)
    if (isUnknown(b) || !b) return { why: 'cantCheck', detail: `can't read ${baseline}` } // agent-protocol: a reason's detail for the log and the result, as git's are (English)
    const inIt = h === b || (await lineHistory().isAncestor(this.deps.project, h, b))
    if (isUnknown(inIt)) return { why: 'cantCheck', detail: inIt.what }
    return inIt ? null : { why: 'unmerged' }
  }

  /**
   * HI-2680: a retarget settled from its folder against its intent, by its operation (`token`), under the repository's
   * lock: clean at the new head once switched (or there and never at the old one) → `ready` on the new target; clean at
   * its old head, not switched → back on its recorded target (none stays none); the folder gone → `gone`; anything else
   * (changes, another head, unreadable) → `dirty`, never lent. A switch already made is never undone.
   */
  private async settleRetarget(name: string, token: string): Promise<RetargetEnd> {
    const i = this.store.retargetOf(name)
    const s = this.store.slot(name)
    if (!i || !s) return { kind: 'kept', why: 'changed' }
    const seen = await withFolderRepoLocks([this.deps.project], async () => {
      if (!(await folderThere(s.folder))) return 'gone' as const
      const d = await this.port.dirty(s.folder)
      const h = await this.port.head(s.folder)
      if (isUnknown(d) || isUnknown(h)) return 'unreadable' as const
      if (d.length) return 'dirty' as const
      if (h === i.toHead && (i.stage === 'switched' || h !== i.oldHead)) return 'to' as const
      if (h === i.oldHead) return 'from' as const
      return 'other' as const
    }, { quiet: true, project: this.deps.project })
    if (seen === 'to') {
      await this.store.endRetarget(name, token, { state: 'ready', target: i.to })
      return { kind: 'moved' }
    }
    if (seen === 'from') {
      await this.store.endRetarget(name, token, { state: 'ready', target: i.from })
      return { kind: 'kept', why: 'changed' }
    }
    const state = seen === 'gone' ? 'gone' : 'dirty'
    log.warn(`Slot ${userText(name)}'s retarget to ${userText(i.to)} ended ${seen}: set aside (${state}) until it is removed`)
    await this.store.endRetarget(name, token, { state, aside: { to: i.to, seen, at: new Date(this.now()).toISOString() } })
    return { kind: 'setAside', state, detail: seen }
  }

  /**
   * Takes over an operation whose holder is gone: its job settled first (refused, and left to the next refresh, while
   * that fails); a warming is failed (its lease ended `interrupted`, the slot not ready), a removal is looked at again.
   */
  private async recover(s: Slot): Promise<void> {
    const was = s.op!
    // A Delete's (#1447): never taken over row by row, only released whole (`releaseStaleDelete`).
    if (this.store.conn.read((db) => deletingIn(db, this.store.project))?.token === was.token) return
    const token = newToken()
    await this.op(token, async () => {
      // Eligible still, as the row is now (the holder looked at again), right before the write that takes it over.
      const now = this.store.slot(s.name)
      if (!now?.op || now.op.token !== was.token || !(await this.holderGone(now.op))) return
      if (!(await this.store.takeOver(s.name, was.token, token, await this.deps.holder.self()))) return
      log.warn(`Taking over slot ${userText(s.name)}'s ${was.kind} from process ${was.pid}, which is gone`)
      try {
        // Its processes may still run: then its job stays recorded (the slot out of the pool) until they are seen ended.
        const settled = !s.job || (await this.deps.settle(s.job))
        if (!settled) log.warn(`Slot ${userText(s.name)}'s job ${s.job} couldn't be emptied: it stays out of the pool`)
        const job = settled ? { job: null } : {}
        // A move onto another target (HI-2680, its intent recorded with it): settled from its folder, as it ends: before a settle cut short, which is a warm with no lease too.
        if (was.kind === 'warm' && this.store.retargetOf(s.name)) {
          await this.settleRetarget(s.name, token)
          return
        }
        // A settle cut short (HI-2170, a warm with no lease): the slot as it was, looked at again by the next refresh.
        if (was.kind === 'warm' && was.lease === null) {
          await this.store.fenced(s.name, token, (db) => this.store.setIn(db, s.name, s.state, {}, { op: null, ...job }))
          return
        }
        // A gone slot's recreation (#1447, its intent recorded with it): finished if git lists it on its line, else put
        // back as it was; its lease kept either way (never ended as an interrupted warming).
        const recreating = was.kind === 'warm' ? this.store.recreateOf(s.name) : null
        if (recreating) {
          const made = await this.madeOn(recreating)
          // Git can't say: left as it is (its operation now this Combwork's, looked at again at the next refresh).
          if (made === null) return void log.warn(`Slot ${userText(s.name)}'s recreation, cut short: git can't say whether it was made; left for the next look`)
          await this.store.endRecreate(s.name, token, recreating, made)
          return
        }
        // A card's preparation (#1438: a warming of a slot already lent): its lease stays, the slot as it is.
        if (was.kind === 'warm' && s.state === 'lent') {
          await this.store.fenced(s.name, token, (db) => this.store.setIn(db, s.name, 'lent', {}, { op: null, ...job }))
          return
        }
        if (was.kind === 'warm') {
          await this.store.fenced(s.name, token, (db) => {
            if (was.lease) this.store.endIn(db, was.lease, 'interrupted')
            this.store.setIn(db, s.name, 'creating', { warmError: sayStored(INTERRUPTED) }, { op: null, ...job })
          })
          return
        }
        // A rename's (#1441, its intent recorded with it): finished or given up from where git lists the worktree.
        const intent = was.kind === 'remove' ? this.store.renameOf(s.name) : null
        if (intent && this.deps.renamer) {
          const at = await this.deps.renamer.where(intent.from, intent.to, intent.tree)
          if (at === null) return void log.warn(`Slot ${userText(s.name)}'s rename, cut short: git can't say where it is; left for the next look`)
          // Not moved yet: given up (renamed again by a later pass, if still free); moved: finished, or put back; somewhere
          // else (git moved it inside another worktree, and Combwork stopped before putting it back): put back, then given up.
          if (at === 'from') await this.store.abandonRename(s.name, token, intent)
          else if (at === 'to') await this.carryOut(s.name, token, intent, 'to', () => true)
          else if (await this.deps.renamer.back(intent.from, intent.to, intent.tree).catch(() => false)) await this.store.abandonRename(s.name, token, intent)
          else log.warn(`Slot ${userText(s.name)}'s worktree couldn't be put back from where git moved it: it stays out of the pool until it is`)
          return
        }
        // A removal with a journal cut short (HI-2795: jj's forget, then the trash): resumed from its phase. Removed, or
        // kept dirty (never lent) with its journal, never looked at as if nothing had happened.
        const journal = was.kind === 'remove' ? this.removalJournal(s.name) : null
        if (journal?.read()) {
          const port = this.portOf(s)
          const r = await port.remove(this.deps.project, s.folder, { identity: s.identity ?? null, journal, fence: { still: () => this.store.fenced(s.name, token, () => true).catch(() => false) } })
          if (r.ok) {
            await this.store.fenced(s.name, token, (db) => this.forgetIn(db, s, port))
            log.info(`Removed slot ${userText(s.name)} (${userText(s.folder)}), resuming a removal cut short`)
          } else {
            log.warn(`Slot ${userText(s.name)}'s removal, cut short, couldn't be finished: ${userText(r.err)}; kept`)
            await this.store.fenced(s.name, token, (db) => this.store.setIn(db, s.name, 'dirty', {}, { op: null, ...job }))
          }
          return
        }
        // Git couldn't list the worktrees (HI-2810): the slot as it was.
        const to = (await this.look(s, token)) ?? s.state
        await this.store.fenced(s.name, token, (db) => this.store.setIn(db, s.name, to, {}, { op: null, ...job }))
      } catch (e) {
        if (!(e instanceof OpLost)) throw e
      }
    })
  }

  private async defaultTarget(): Promise<string | null> {
    const t = await this.port.defaultLine(this.deps.project)
    return isUnknown(t) ? null : t
  }

  /**
   * Runs a command of an operation's in a job recorded on the slot first, the job cleared once its processes are seen
   * ended (else it stays: the slot isn't lent until `refresh` settles it). The run's end, settled or not.
   */
  private async run(name: string, token: string, r: Omit<SlotRun, 'job' | 'signal'>): Promise<SlotRunEnd> {
    const job = newJob()
    await this.store.fenced(name, token, (db) => db.prepare('UPDATE slots SET job = ? WHERE project = ? AND name = ?').run(job, this.store.project, name))
    const end = await this.deps.runner({ ...r, job, signal: this.life.signal })
    if (end.settled) await this.store.fenced(name, token, (db) => db.prepare('UPDATE slots SET job = NULL WHERE project = ? AND name = ? AND job = ?').run(this.store.project, name, job))
    return end
  }

  /**
   * The warming operation of a lease (`token` holds the slot): a free slot looked at again (dirty: marked and `skip`ped;
   * a session or a process in it: `busy`, saying which, HI-2466; either way its lease ended), made if new or gone,
   * installed again if its lock files changed; then
   * `ready` (the slot `lent`, or looked at if the lease ended meanwhile). A failure leaves the slot not ready with why,
   * its lease ended `setupFailed`; an operation taken over meanwhile stops (`warming`).
   */
  private async warm(slot: Slot, lease: SlotLease, token: string, fresh: boolean, target: string | null, install = true, reclaim = false): Promise<'ready' | 'skip' | SlotRefusal> {
    const name = slot.name
    this.keptWhy.delete(name)
    const fail = async (error: string, logPath: string | null = null): Promise<SlotRefusal> => {
      log.warn(`Slot ${userText(name)} of ${userText(this.deps.project)} isn't ready: ${userText(error)}`)
      await this.store.fenced(name, token, (db) => {
        this.store.endIn(db, lease.id, 'setupFailed')
        this.store.setIn(db, name, 'creating', { warmError: error, warmLog: logPath }, { op: null })
      })
      return { why: 'setupFailed', slot: name, error, log: logPath }
    }
    /** Not this time: marked, its lease ended, another slot tried. */
    const pass = async (state: SlotState, why: string): Promise<'skip'> => {
      await this.store.fenced(name, token, (db) => {
        this.store.endIn(db, lease.id, why)
        this.store.setIn(db, name, state, {}, { op: null })
      })
      return 'skip'
    }
    try {
      // The workspace closed between the reservation and now: nothing on disk changes. A new slot is left not ready
      // (nothing made: `tidy` forgets it), an existing one goes back as it was.
      if (this.closed) return fresh ? await fail(sayStored(T.closed)) : await this.unreserve(name, lease, token, slot.state)
      let made = fresh
      if (!made) {
        const there = await this.present(slot)
        // Git can't list the worktrees (HI-2810): nothing pruned or made, the slot as it was, another one tried.
        if (there === null) return await pass(slot.state, 'cantList')
        // A kept slot's folder gone (HI-2995): never made again in its place (its binding, the card's, would go with it).
        if (!there && reclaim) {
          this.keptWhy.set(name, T.keptGone)
          return await pass('gone', 'gone')
        }
        if (!there) {
          // Gone from disk while free: made again where it was (git's stale entry pruned first).
          if (await folderThere(slot.folder)) return await fail(sayStored(T.notListed))
          await this.store.fenced(name, token, () => undefined)
          await this.port.prune(this.deps.project)
          made = true
        } else {
          // Free since its last lease: what is in it now, not what was there then. A port that records (jj: a write in
          // the folder, HR1's HI-2795 round 1) is asked only once nothing holds the slot; Git's read stays first, as before.
          const held = async (): Promise<SlotRefusal | null> => {
            const session = !!this.deps.sessionIn?.(slot.folder)
            if (!session && (await quiet(slot.folder))) return null
            await pass(reclaim ? 'dirty' : 'ready', 'busy')
            return session ? { why: 'busy', slot: name, held: 'session' } : await processHeld(name, slot.folder, this.deps.brokerIn)
          }
          const records = !!this.portOf(slot).record
          if (records) {
            const busy = await held()
            if (busy) return busy
          }
          // Taken back by its card (HI-2995): its binding still that card's at the folder's generation, read through the
          // port under this operation, before anything else; anything else keeps it as it was, refused, never lent as
          // free. What is in it then is that card's own (its commits, and an edit not committed yet: HR1's round 1), so
          // it isn't refused as unclean: the card's preparation carries it (HI-2981).
          if (reclaim && !(lease.card !== null && (await this.portOf(slot).heldFor?.(slot.folder, slot.identity ?? null, lease.card)))) {
            this.keptWhy.set(name, T.keptStale)
            return await pass('dirty', 'keptStale')
          }
          const d = reclaim ? [] : await this.dirtyOwned(slot, token)
          if (isUnknown(d) || d.length) return await pass('dirty', 'notClean')
          // Held (a session in it, or a process: a file or folder in it open): passed over, saying what holds it.
          if (!records) {
            const busy = await held()
            if (busy) return busy
          }
        }
      }
      if (this.closed) return await fail(sayStored(T.closed))
      const opts = await this.deps.options()
      // Still this operation's, right before the worktree is made or anything is copied into it.
      await this.store.fenced(name, token, () => undefined)
      if (made) {
        const at = target ? await this.port.lineHead(this.deps.project, target) : await this.port.head(this.deps.project)
        if (isUnknown(at) || !at) return await fail(sayStored(T.gitRead, { what: target ?? 'HEAD' }))
        const r = await this.port.create(this.deps.project, slot.folder, at, { skipSmudge: this.gitFilesOn(opts) })
        if (!r.ok) return await fail(sayStored(T.worktreeAdd, { error: this.port.errorLine(r.err) || 'failed' }))
        // Its identity where the platform records one (HI-2795: jj's store, name, creation generation), in a fenced write.
        if (this.port.identity) {
          const id = await this.port.identity(slot.folder)
          if (!id) return await fail(sayStored(T.identityUnread))
          // A workspace made under a name a removed one had (HI-2979): whatever was kept by that name is an older
          // generation's (a slot removed before its records were, or its folder deleted), forgotten in the same write.
          await this.store.fenced(name, token, (db) => {
            db.prepare('UPDATE slots SET store = ?, workspace = ?, generation = ? WHERE project = ? AND name = ?').run(id.store, id.workspace, id.generation, this.store.project, name)
            db.prepare('DELETE FROM board_meta WHERE key = ?').run(recoverKey(this.store.project, name))
            db.prepare('DELETE FROM board_meta WHERE key = ?').run(heldKey(this.store.project, name))
            this.port.forgetIn?.(db, id)
          })
        }
        log.info(`Made slot ${userText(name)} at ${at.slice(0, 7)} in ${userText(slot.folder)}`)
        if (opts.copy.trim()) await this.port.copyIgnored(this.deps.project, slot.folder, opts.copy).catch((e) => log.warn(`Could not copy files into slot ${userText(name)}`, e))
        // HI-1182: its submodules and LFS files, before its setup (a slot reused is set up again as its card is prepared).
        const files = await this.gitFiles(name, token, slot, opts)
        if (files) return await fail(files.error, files.logPath)
      }
      const hash = await lockHash(slot.folder)
      // An existing slot is installed again only when asked (#1438: with G15 off nothing is installed for a card).
      const needed = made || (install && hash !== null && hash !== slot.installHash)
      if (needed) {
        const failed = await this.install(name, token, slot, made ? 'setup' : 'install', opts.setup, hash)
        if (failed) return await fail(failed.error, failed.logPath)
      }
      const rev = await this.port.head(slot.folder)
      const fields: SlotFields = { warmError: null, warmLog: null, ...(needed ? { installRev: isUnknown(rev) ? null : rev, installHash: hash } : {}), ...(made && target ? { target } : {}) }
      // Released meanwhile: the slot as it is now, not lent.
      // Unknown (git couldn't list the worktrees, HI-2810): not ready, looked at again by the next refresh.
      const after = this.store.lease(lease.id)?.to ? ((await this.look(this.store.slot(name) ?? slot, token)) ?? 'dirty') : 'lent'
      await this.store.fenced(name, token, (db) => this.store.setIn(db, name, this.store.openIn(db, lease.id) ? 'lent' : after === 'lent' ? 'ready' : after, fields, { op: null }))
      return 'ready'
    } catch (e) {
      if (e instanceof OpLost) return { why: 'warming', slot: name }
      // Anything else: the slot left not ready, never half made and lent.
      return fail(e instanceof Error ? e.message : String(e)).catch(() => ({ why: 'warming' as const, slot: name }))
    }
  }

  /** HI-1182: whether Combwork's checkouts of this pool's folders leave LFS files for the step (the setting on, a platform that has it). */
  private gitFilesOn(opts: SlotOptionsNow): boolean {
    return opts.gitFiles !== false && !!this.port.files
  }

  /**
   * HI-1182: a slot's submodules and LFS files set up (platform/gitFiles.ts), as a run of the slot's, when the setting is
   * on and the folder uses either at its revision (read first: a folder that uses neither runs nothing). Idempotent, so
   * run before every ready: why it failed (an unreadable use too, never taken for "unused"), or null.
   */
  private async gitFiles(name: string, token: string, slot: Slot, opts: SlotOptionsNow, known = false): Promise<{ error: string; logPath: string | null } | null> {
    if (!this.gitFilesOn(opts)) return null
    const files = this.port.files!
    const need = known || (await files.needed(slot.folder, false))
    if (typeof need === 'object') return { error: need.error, logPath: null }
    if (!need) return null
    const end = await this.run(name, token, { slot: name, what: 'gitFiles', command: files.title, folder: slot.folder, env: slotEnv(slot), files: { step: { folder: slot.folder, project: this.deps.project, disposable: false }, tool: files } })
    if (!end.settled) return { error: sayStored(T.setupNotEnded), logPath: end.logPath }
    if (!end.ok) return { error: end.error ?? (end.timedOut ? sayStored(T.setupTimedOut) : end.spawnError ? sayStored(T.setupNoStart, { command: files.title }) : sayStored(T.setupExit, { code: String(end.exitCode) })), logPath: end.logPath }
    return null
  }

  /** A slot's setup or install run (the project's setup, else `npm ci` for a package lock): why it failed, or null. */
  private async install(name: string, token: string, slot: Slot, what: 'setup' | 'install', setup: string, hash: string | null): Promise<{ error: string; logPath: string | null } | null> {
    // agent-protocol: the command run, not wording
    const command = setup.trim() || (hash !== null && existsSync(join(slot.folder, 'package-lock.json')) ? 'npm ci' : '')
    if (!command) return null
    const end = await this.run(name, token, { slot: name, what, command, folder: slot.folder, env: slotEnv(slot) })
    if (!end.settled) return { error: sayStored(T.setupNotEnded), logPath: end.logPath }
    if (!end.ok) return { error: end.error ?? (end.timedOut ? sayStored(T.setupTimedOut) : end.spawnError ? sayStored(T.setupNoStart, { command }) : sayStored(T.setupExit, { code: String(end.exitCode) })), logPath: end.logPath }
    return null
  }

  /**
   * Prepares a lent slot for its card (#1438, SPEC §16.10.1): the card's line checked out, made from `base` (the target's
   * head) or the line it already has (a card started again), and with `install` (G15, Slots are brought up to date)
   * its dependencies installed again when its lock files differ from its last install's. A warming operation of the
   * lease while it runs (#1429's: fenced by its token, taken over once its holder is gone), so nothing lends, removes or
   * starts a session in the slot meanwhile; only on the lease's own slot, with no session writing there but the lease's
   * own. `ready` is the caller's last word right before the slot's files change (its card still current, its builder
   * quiet): a reason, and nothing changes. A slot already on the line is prepared (a repeat changes nothing). `retry`:
   * not now (busy, or not ready); `error`: it can't be (changes not committed, git or the install failed).
   */
  async prepare(leaseId: string, p: { line: string; base: string; install: boolean; target?: string; ready?: () => Promise<string | null>; around?: <T>(fn: () => Promise<T>) => Promise<T> }): Promise<PrepareResult> {
    const lease = this.store.lease(leaseId)
    if (!lease || lease.to) return { error: sayStored(T.leaseEnded) }
    const name = lease.slot
    const token = newToken()
    return this.op(token, async (): Promise<PrepareResult> => {
      if (!(await this.store.startPrepare(name, leaseId, token, await this.deps.holder.self()))) return { retry: sayStored(T.prepareBusy, { slot: name }) }
      const end = async (fields: SlotFields = {}): Promise<void> => {
        await this.store.fenced(name, token, (db, s) => this.store.setIn(db, name, s.state, fields, { op: null }))
      }
      try {
        const slot = this.store.slot(name)!
        const on = await this.port.line(slot.folder)
        if (isUnknown(on)) {
          await end()
          return { error: sayStored(T.branchUnread, { slot: name }) }
        }
        const there = on === p.line
        // The same card started again in its own slot (HI-2981: jj gives each start a new key): what is in the folder is
        // that card's own uncommitted work, kept as on Git's same branch, never refused as another's.
        const carried = !there && !!(await this.port.carries?.(slot.folder, p.line, p.base, { identity: slot.identity ?? null, ...(p.target ? { target: p.target } : {}) }))
        if (!there && !carried) {
          // Its holder's record where the port has one (jj, HI-2866: a read can't see unrecorded edits); Git's dirty as before.
          const d = await this.dirtyOwned(slot, token)
          if (isUnknown(d) || d.length) {
            await end()
            // A stale jj workspace (HI-2913) said as itself, with its way out; else Git's words as before.
            if (isUnknown(d) && d.detail === JJ_REFUSED.stale) return { error: sayStored(T.stale, { slot: name }), stale: true }
            // Something still in the folder when jj's record was asked (HI-2913: a session or process): not now, never a failure.
            if (isUnknown(d) && (d.detail === 'busy' || d.detail === JJ_REFUSED.fence)) return { retry: sayStored(T.prepareBusy, { slot: name }) }
            return { error: isUnknown(d) ? sayStored(T.filesUnread, { slot: name }) : sayStored(T.uncommitted, { slot: name }) }
          }
        }
        const had = there ? null : await this.port.lineHead(slot.folder, p.line)
        if (isUnknown(had)) {
          await end()
          return { error: sayStored(T.gitRead, { what: p.line }) }
        }
        const hash = p.install ? await lockHash(slot.folder) : null
        // HI-1182: its submodules and LFS set up before every ready while the setting is on (a step that failed or was
        // ended before, the setting turned on since, a line already there all get it), read where the folder is now.
        const opts = await this.deps.options()
        const filesOn = this.gitFilesOn(opts)
        const filesNeed = async (): Promise<boolean | { error: string }> => (filesOn ? this.port.files!.needed(slot.folder, false) : false)
        let files = there ? await filesNeed() : false
        if (typeof files === 'object') {
          await end()
          return { error: files.error }
        }
        if (there && !files && !(p.install && hash !== null && hash !== slot.installHash)) {
          await end()
          return { ok: true, revision: await this.headOf(slot.folder) }
        }
        // The caller's last word (its card current, the rules on, its builder quiet) and still this operation's, right
        // before the slot's files change: inside the caller's guard (the app's: the repository's lock, as merges and branch
        // deletions take it), after any wait for it, so nothing waited on stands in for a check made before it.
        const last = async (): Promise<string | null> => {
          const notYet = (await p.ready?.()) ?? null
          if (!notYet) await this.store.fenced(name, token, () => undefined)
          return notYet
        }
        if (!there) {
          const sw = async (): Promise<{ notYet: string } | WorkspaceStep> => {
            const notYet = await last()
            if (notYet) return { notYet }
            // jj's preparation is an owned write (HI-2866): the row's identity, this operation's fence with the folder quiet,
            // the lease and the card's target. Git ignores them.
            const owned = this.port.platform === 'jj' ? { identity: slot.identity ?? null, fence: this.ownedFence(slot, token, leaseId), lease: leaseId, ...(p.target ? { target: p.target } : {}) } : {}
            return this.port.prepare(slot.folder, p.line, had ? null : p.base, { skipSmudge: filesOn, ...owned })
          }
          const r = await (p.around ? p.around(sw) : sw())
          if ('notYet' in r) {
            await end()
            return { retry: r.notYet }
          }
          if (!r.ok) {
            await end()
            // jj's (HI-2913): quiet lost during its owned write, or a result to decide on the next pass, is a wait; a stale
            // workspace found there is said as itself.
            const err = r.err.trim()
            if (this.port.platform === 'jj' && (err === JJ_REFUSED.fence || err === JJ_REFUSED.uncertain)) return { retry: sayStored(T.prepareBusy, { slot: name }) }
            if (this.port.platform === 'jj' && err === JJ_REFUSED.stale) return { error: sayStored(T.stale, { slot: name }), stale: true }
            return { error: sayStored(T.switchFailed, { error: err.split(/\r?\n/)[0] || 'failed' }) }
          }
          log.info(`Slot ${userText(name)} is on ${userText(p.line)} for lease ${leaseId}`)
          files = await filesNeed()
          if (typeof files === 'object') {
            await end()
            return { error: files.error }
          }
        }
        if (files) {
          // It changes the slot's files too: the same last word first.
          const notYet = await last()
          if (notYet) {
            await end()
            return { retry: notYet }
          }
          const failed = await this.gitFiles(name, token, slot, opts, true)
          if (failed) {
            await end({ warmLog: failed.logPath })
            return { error: failed.error, ...(failed.logPath ? { logPath: failed.logPath } : {}) }
          }
        }
        const now = p.install ? await lockHash(slot.folder) : null
        if (p.install && now !== null && now !== slot.installHash) {
          // An install changes the slot's files too: the same last word first.
          const notYet = await last()
          if (notYet) {
            await end()
            return { retry: notYet }
          }
          const failed = await this.install(name, token, slot, 'install', opts.setup, now)
          if (failed) {
            await end({ warmLog: failed.logPath })
            return { error: failed.error, logPath: failed.logPath }
          }
          const rev = await this.headOf(slot.folder)
          await end({ installRev: rev || null, installHash: now })
          return { ok: true, revision: rev }
        }
        await end()
        return { ok: true, revision: await this.headOf(slot.folder) }
      } catch (e) {
        if (e instanceof OpLost) return { retry: sayStored(T.prepareTakenOver, { slot: name }) }
        await end().catch(() => undefined)
        return { error: e instanceof Error ? e.message : String(e) }
      }
    })
  }

  private async headOf(folder: string): Promise<string> {
    const h = await this.port.head(folder)
    return isUnknown(h) ? '' : h
  }

  /** A reservation given back untouched (the workspace closed before anything was done): its lease ended, the slot as it was. */
  private async unreserve(name: string, lease: SlotLease, token: string, state: SlotState): Promise<SlotRefusal> {
    await this.store.fenced(name, token, (db) => {
      this.store.endIn(db, lease.id, 'closed')
      this.store.setIn(db, name, state, {}, { op: null })
    })
    return { why: 'notReady', slot: name, state, error: sayStored(T.closed) }
  }

  /**
   * A leased slot whose folder is gone, made again on its line (#1447, Repair's Recreate), its lease kept: its operation
   * and intent taken only while the row is as the plan saw it (`expect`: the lease and the folder; no other holder or
   * writer), then, inside the operation, `from` must still be absent and `to` too; git's stale registration pruned only
   * when the prune would drop nothing else (`prunable`), `git worktree add <to> <line>`, and the result checked (git lists
   * a worktree at `to` on `line`) before the fenced write that ends it. Null once made, else why not (English, logged).
   */
  async recreateGone(name: string, expect: { lease: string; folder: string }, to: string, line: string, prunable: () => Promise<string[]>): Promise<string | null> {
    const token = newToken()
    return this.op(token, async () => {
      const intent = await this.store.startRecreate(name, expect, token, await this.deps.holder.self(), to, line)
      if (!intent) return 'it changed since Repair looked (relinked, lent or resumed meanwhile)' // agent-protocol: the log's reason (Repair logs it), never an agent's
      let added = false
      try {
        const giveUp = async (why: string): Promise<string> => (await this.store.endRecreate(name, token, intent, false), why)
        if ((await folderThere(intent.from)) && !samePlace(intent.from, intent.to)) return await giveUp('its folder is there again') // agent-protocol: the log's reason (Repair logs it), never an agent's
        if (existsSync(intent.to)) return await giveUp(`${intent.to} is already there`) // agent-protocol: the log's reason (Repair logs it), never an agent's
        const others = (await prunable()).filter((p) => !samePlace(p, intent.from))
        if (others.length) return await giveUp(`git's prune would also forget ${others.join(', ')}`) // agent-protocol: the log's reason (Repair logs it), never an agent's
        await this.port.prune(this.deps.project)
        await mkdir(dirname(intent.to), { recursive: true })
        const r = await this.port.attach(this.deps.project, intent.to, intent.line)
        if (!r.ok) return await giveUp(r.err.trim() || 'git worktree add failed') // agent-protocol: the log's reason (Repair logs it), never an agent's
        // From here git may have made it (HR1's round 2): its operation and intent stay unless this records the result,
        // so a recovery (this Combwork's next look, its token no longer running) finishes it from what git says.
        added = true
        const made = await this.madeOn(intent)
        if (made !== true) return `git ${made === null ? "couldn't say whether" : "doesn't list"} ${intent.to} on ${intent.line}: Combwork looks again` // agent-protocol: the log's reason (Repair logs it), never an agent's
        await this.store.endRecreate(name, token, intent, true)
        log.info(`Slot ${userText(name)} made again at ${userText(intent.to)} on ${userText(intent.line)}`)
        return null
      } catch (e) {
        if (e instanceof OpLost) return 'its operation was taken over' // agent-protocol: the log's reason (Repair logs it), never an agent's
        if (!added) await this.store.endRecreate(name, token, intent, false).catch(() => undefined)
        return e instanceof Error ? e.message : String(e)
      }
    })
  }

  /** Whether git lists a worktree at a recreation's `to`, on its line; null when git can't say (never taken for no). */
  private async madeOn(intent: RecreateIntent): Promise<boolean | null> {
    // A listing that fails is unknown, never an empty one (HI-2810, #734).
    const listed = await this.port.list(this.deps.project).catch(() => null)
    if (!listed) return null
    if (!listed.some((w) => samePlace(w.path, intent.to))) return false
    const on = await this.port.shownLine(intent.to)
    if (on === null) return null
    return on.toLowerCase() === intent.line.toLowerCase()
  }

  /**
   * A free slot renamed (#1441: an adopted worktree given a generic name once nothing holds it), owned by its operation
   * from the write that reserves its destination (`startRename`) to the write that finishes or gives it up. Its steps
   * (`deps.renamer`): the CLIs' data copied first (any of it failing: no rename, nothing moved), git's move (checked
   * where git lists it), cards and sessions following; a step failing after the move puts back what was done. A rename
   * cut short is the next holder's (`recover`, once this one is gone). `allowed` is asked again before the copy and the
   * move (the switch, the rules). The new name, or null.
   */
  async rename(name: string, allowed: () => boolean = () => true): Promise<string | null> {
    const s = this.store.slot(name)
    if (!this.deps.renamer || !s || s.state === 'removing') return null
    const token = newToken()
    return this.op(token, async () => {
      const tree = await this.deps.renamer!.identity(s.folder).catch(() => null)
      if (!tree) return log.info(`Slot ${userText(name)} keeps its name: its folder isn't a worktree git knows`), null
      const intent = await this.store.startRename(name, s.state, token, await this.deps.holder.self(), this.deps.root, tree)
      if (!intent) return null
      return this.carryOut(name, token, intent, 'from', allowed)
    })
  }

  /** A rename's steps from where it is (`at`: git's worktree still at `from`, or already at `to`), then its end. */
  private async carryOut(name: string, token: string, intent: RenameIntent, at: 'from' | 'to', allowed: () => boolean): Promise<string | null> {
    const r = this.deps.renamer!
    const who = this.store.lastLease(name)?.agent ?? name
    const ok = async (step: () => Promise<boolean>): Promise<boolean> => step().catch((e) => (log.warn(`Renaming slot ${userText(name)} to ${userText(intent.toName)}`, e), false))
    const giveUp = async (why: string): Promise<null> => {
      log.info(`Slot ${userText(name)} keeps its name: ${why}`)
      await this.store.abandonRename(name, token, intent).catch((e) => {
        if (!(e instanceof OpLost)) throw e
      })
      return null
    }
    try {
      if (at === 'from') {
        // agent-protocol: giveUp's reasons are the log's (it logs them), never an agent's
        if (!allowed()) return await giveUp('renaming is off')
        // agent-protocol: the log's reason, as above
        if (!(await ok(() => r.copy(intent.from, intent.to, who)))) return await giveUp("its conversations' data couldn't follow")
        // agent-protocol: the log's reason, as above
        if (!allowed()) return await giveUp('renaming is off')
        if (!(await ok(() => r.move(intent.from, intent.to, intent.tree)))) {
          // Not moved, or not where reserved: put back where git can; else the operation and intent stay for recovery.
          if ((await r.where(intent.from, intent.to, intent.tree)) === 'from' || (await ok(() => r.back(intent.from, intent.to, intent.tree)))) return await giveUp("git couldn't move it") // agent-protocol: the log's reason (giveUp logs it)
          log.warn(`Slot ${userText(name)}'s rename couldn't be put back: it stays out of the pool until it is`)
          return null
        }
      } else if (!(await ok(() => r.copy(intent.from, intent.to, who)))) {
        if (await ok(() => r.back(intent.from, intent.to, intent.tree))) return await giveUp("its conversations' data couldn't follow") // agent-protocol: the log's reason (giveUp logs it)
        return null
      }
      const followed = await ok(async () => (await r.follow(intent.from, intent.to, intent.tree), true))
      if (!followed) {
        if (await ok(() => r.back(intent.from, intent.to, intent.tree))) return await giveUp("its cards or sessions couldn't follow") // agent-protocol: the log's reason (giveUp logs it)
        log.warn(`Slot ${userText(name)}'s rename couldn't be put back: it stays out of the pool until it is`)
        return null
      }
      await this.store.finishRename(name, token, intent)
      log.info(`Slot ${userText(name)} renamed ${userText(intent.toName)} (${userText(intent.to)})`)
      return intent.toName
    } catch (e) {
      if (e instanceof OpLost) return null
      throw e
    }
  }

  /**
   * Removes a slot, guarded (§16.6.4: no switch): kept, with why, while it has an open lease (carried included), an
   * operation or an unsettled job, a session or a process in it, a queue entry in flight for a card it held,
   * uncommitted or untracked files that aren't ignored, or a head its target doesn't contain; and when its archive
   * command fails or leaves processes that can't be ended. Null once removed.
   */
  async remove(name: string): Promise<SlotKept | null> {
    let s = this.store.slot(name)
    if (!s) return null
    if (s.op && (await this.holderGone(s.op))) {
      await this.recover(s)
      s = this.store.slot(name)
      if (!s) return null
    }
    const open = this.store.openLease(name)
    if (open) return { why: 'leased', agent: open.agent }
    if (s.op || s.job) return { why: 'busy', state: s.state }
    const token = newToken()
    const from = s.state
    const slot = s
    return this.op(token, async () => {
      // Taken out of the pool first, in a write that sees it free and as read: nothing lends or adopts it meanwhile.
      if (!(await this.store.startRemoval(name, from, token, await this.deps.holder.self()))) {
        const now = this.store.openLease(name)
        return now ? { why: 'leased', agent: now.agent } : { why: 'busy', state: this.store.slot(name)?.state ?? from }
      }
      const keep = async (kept: SlotKept): Promise<SlotKept> => {
        log.info(`Kept slot ${userText(name)} of ${userText(this.deps.project)}: ${kept.why}`)
        await this.store.fenced(name, token, (db) => this.store.setIn(db, name, from, {}, { op: null })).catch((e) => {
          if (!(e instanceof OpLost)) throw e
        })
        return kept
      }
      try {
        // A removal part done before (HI-2795: its journal says forgotten): its guards passed then, and the workspace
        // the guards would read is gone from its store; the port resumes it from its phase, checking the folder's
        // identity before anything is trashed.
        const resuming = !!this.removalJournal(name).read()
        let kept = resuming ? null : await this.guard(slot, true, token)
        if (kept) return await keep(kept)
        const port = this.portOf(slot)
        /** The platform's removal: Git's `worktree remove`; a journalled one (jj) with its identity, fenced. */
        const removeIt = async (): Promise<SlotKept | null> => {
          const r = port.identity ? await port.remove(this.deps.project, slot.folder, { identity: slot.identity ?? null, journal: this.removalJournal(name), fence: { still: () => this.store.fenced(name, token, () => true).catch(() => false) } }) : await port.remove(this.deps.project, slot.folder)
          if (r.ok) return null
          const refused: SlotKept = { why: 'gitRefused', detail: r.err.trim().split(/\r?\n/)[0] || sayStored(T.removeFailed) }
          // A removal part done (HI-2795: forgotten, not yet trashed) keeps its journal and the slot out of the pool.
          if (!this.removalJournal(name).read()) return await keep(refused)
          await this.store.fenced(name, token, (db) => this.store.setIn(db, name, 'dirty', {}, { op: null })).catch((e) => {
            if (!(e instanceof OpLost)) throw e
          })
          return refused
        }
        if (resuming) {
          const r = await removeIt()
          if (r) return r
        } else if (await folderThere(slot.folder)) {
          const opts = await this.deps.options()
          if (opts.archive.trim()) {
            const end = await this.run(name, token, { slot: name, what: 'archive', command: opts.archive.trim(), folder: slot.folder, env: slotEnv(slot) })
            if (!end.settled) return await keep({ why: 'archiveFailed', error: sayStored(T.archiveNotEnded), log: end.logPath })
            if (!end.ok) return await keep({ why: 'archiveFailed', error: end.error ?? (end.timedOut ? sayStored(T.archiveTimedOut) : end.spawnError ? sayStored(T.archiveNoStart) : sayStored(T.archiveExit, { code: String(end.exitCode) })), log: end.logPath })
          }
          // The archive command may have left files or processes: the guards again.
          kept = await this.guard(slot, true, token)
          if (kept) return await keep(kept)
          // Combwork's skill copies are git-ignored, so the guards don't count them (#1500): its own unchanged ones go first,
          // and a `cw-*` folder left (an edited copy, or the user's own) keeps the slot.
          await this.deps.removeSkillCopies?.(slot.folder)
          const copies = await combworkSkillFolders(slot.folder)
          if (copies.length) return await keep({ why: 'editedSkillCopy', copies })
          // Still ours, nothing leased meanwhile, right before the one step that can't be undone.
          if (!(await this.store.fenced(name, token, (db, now) => !openLeaseIn(db, this.store.project, name) && !now.job))) return await keep({ why: 'busy', state: from })
          const r = await removeIt()
          if (r) return r
        } else await port.prune(this.deps.project)
        await this.store.fenced(name, token, (db) => this.forgetIn(db, slot, port))
        log.info(`Removed slot ${userText(name)} (${userText(slot.folder)})`)
        return null
      } catch (e) {
        if (e instanceof OpLost) return { why: 'busy', state: this.store.slot(name)?.state ?? from }
        const kept: SlotKept = { why: 'cantCheck', detail: e instanceof Error ? e.message : String(e) }
        // A removal part done (HI-2795) stays out of the pool with its journal, whatever stopped it.
        if (this.removalJournal(name).read()) {
          await this.store.fenced(name, token, (db) => this.store.setIn(db, name, 'dirty', {}, { op: null })).catch(() => undefined)
          return kept
        }
        return keep(kept)
      }
    })
  }

  /**
   * What would keep a slot if it were removed now (#1450, Unused Worktrees' rows): its lease, an operation, then the
   * removal's guards, without the rename probe (a listing doesn't touch the folder; the removal probes it). Null: it
   * would go.
   */
  async check(name: string): Promise<SlotKept | null> {
    const s = this.store.slot(name)
    if (!s) return null
    const open = this.store.openLease(name)
    if (open) return { why: 'leased', agent: open.agent }
    if (s.op || s.job || s.writer) return { why: 'busy', state: s.state }
    return this.guard(s, false)
  }

  /**
   * What would keep a slot from its project's removal (#1447): an operation, a job or a writer, then the removal's guards;
   * its lease aside (the removal ends a lease only when nothing would be kept). `probe`: also prove no process holds it.
   */
  async keepsFromRemoval(name: string, probe = false): Promise<SlotKept | null> {
    const s = this.store.slot(name)
    if (!s) return null
    if (s.op || s.job || s.writer) return { why: 'busy', state: s.state }
    return this.guard(s, probe)
  }

  /** The guards a removal checks, in order; null when nothing holds the slot. `probe`: also prove no process holds it. */
  private async guard(s: Slot, probe = true, token?: string): Promise<SlotKept | null> {
    const session = this.deps.sessionIn?.(s.folder)
    if (session) return { why: 'session', detail: session }
    for (const card of this.store.cardsOf(s.name)) if (await this.deps.inFlight?.(card)) return { why: 'inFlight', card }
    if (!(await folderThere(s.folder))) return null
    if (probe && !(await quiet(s.folder))) return { why: 'process' }
    // Its holder's record (HI-2795) where it holds the slot (a removal's operation); a listing's read otherwise.
    const port = this.portOf(s)
    const d = token ? await this.dirtyOwned(s, token) : await port.dirty(s.folder)
    if (isUnknown(d)) return { why: 'cantCheck', detail: d.what }
    if (d.length) return { why: 'dirty', files: d.length }
    const head = await port.head(s.folder)
    if (isUnknown(head)) return { why: 'cantCheck', detail: head.what }
    let target = s.target ?? (await this.defaultTarget())
    if (!target) return { why: 'cantCheck', detail: sayStored(T.noTarget) }
    let t = await port.lineHead(this.deps.project, target)
    // HI-2928: a free slot's own target deleted since it waited there (gone, not unreadable): it is checked against the
    // default target instead, so work in it that isn't there still keeps it (unmerged), and a slot with none is freed.
    // Never for a preparation's key (a jj slot's), which has no head by design (HI-2866): only a deleted line.
    if (t === null && s.target && !isJjLineKey(s.target) && !this.store.openLease(s.name)) {
      const def = await this.defaultTarget()
      if (def && def !== s.target) {
        target = def
        t = await port.lineHead(this.deps.project, def)
      }
    }
    if (isUnknown(t) || !t) return { why: 'cantCheck', detail: sayStored(T.noBranch, { target }) }
    if (t === head) return null
    // A jj slot's commits are its store's (HI-2866): §16.3.2's test asked of that Git store (a non-colocated project folder
    // has no Git of its own); a Git slot's of the project, as before.
    const repo = port.platform === 'jj' && s.identity?.store ? s.identity.store : this.deps.project
    const base = await lineHistory().mergeBase(repo, t, head)
    if (isUnknown(base) || !base) return { why: 'cantCheck', detail: sayStored(T.noBase, { target }) }
    const c = await lineHistory().contains(repo, target, { base, revision: head }, t)
    if (isUnknown(c)) return { why: 'cantCheck', detail: c.what }
    return c ? null : { why: 'unmerged', target }
  }

  /**
   * Removes the pool's idle slots: ready ones beyond its size, unused for IDLE_MS, oldest first (Settings → Advanced,
   * Remove idle slots after a day), and slots whose setup failed; `at` the time it counts from (tests). The slots removed.
   */
  async tidy(at: number = this.now()): Promise<string[]> {
    if (this.deps.removeIdle && !this.deps.removeIdle()) return []
    await this.refresh()
    const size = await this.size()
    const all = this.store.slots()
    const removed: string[] = []
    const free = (s: Slot): boolean => !s.op && !s.job && !this.store.openLease(s.name)
    for (const s of all.filter((x) => x.state === 'creating' && x.warmError && free(x))) if (!(await this.remove(s.name))) removed.push(s.name)
    // HI-2936: another platform's slots, left by a switch of the project's, are never lent again: each removed once idle
    // (by its own port, the removal's guards kept), and none counted against this platform's size.
    const other = all.filter((s) => !this.ownPlatform(s) && !removed.includes(s.name))
    for (const s of other.filter((x) => (x.state === 'ready' || x.state === 'dirty' || x.state === 'gone') && free(x) && at - Date.parse(x.usedAt) >= IDLE_MS && this.hasPort(x))) if (!(await this.remove(s.name))) removed.push(s.name)
    const own = all.filter((s) => this.ownPlatform(s))
    let over = own.filter((s) => !removed.includes(s.name)).length - size
    const idle = own.filter((s) => s.state === 'ready' && free(s) && at - Date.parse(s.usedAt) >= IDLE_MS).sort((a, b) => a.usedAt.localeCompare(b.usedAt))
    for (const s of idle) {
      if (over <= 0) break
      if (!(await this.remove(s.name))) {
        removed.push(s.name)
        over--
      }
    }
    return removed
  }
}

/**
 * Whether no process holds a folder (its working folder, or a file open in it): Windows refuses to rename a folder then.
 * Renamed aside and back at once; a folder that can't be put back is retried, and left aside (and logged) only if that
 * keeps failing, which nothing holding it can cause (it couldn't have been renamed).
 *
 * One check per folder at a time (HI-1753): a caller while one runs waits for its answer and shares it. Windows renames
 * a folder through a handle opened by its path, so two checks that opened it before either renamed it both "succeed":
 * the second moves it on from the first's aside name to its own, and the first can't put it back (ENOENT, logged five
 * times on 26 Oct when several isolated checks' leases each looked at the pool's returning copies at once).
 */
export function quiet(folder: string): Promise<boolean> {
  const key = folder.toLowerCase()
  const going = quieting.get(key)
  if (going) return going
  const check = quietOnce(folder).finally(() => quieting.delete(key))
  quieting.set(key, check)
  return check
}

/** The quiet checks under way, by folder (lower-cased). */
const quieting = new Map<string, Promise<boolean>>()

/**
 * Whether a slot's or copy's folder is there, read once no quiet check of it is under way (HI-1753, HR2's round 1): a
 * check has it renamed aside for a moment, so a plain existsSync then reads a folder in use as gone (a returning copy
 * freed, a free one marked gone or made again) while the check still has it. A check only renames while it is in
 * `quieting`, and the look is in the same tick as finding none, so it never sees one mid-check.
 */
export async function folderThere(folder: string): Promise<boolean> {
  const key = folder.toLowerCase()
  for (let going = quieting.get(key); going; going = quieting.get(key)) {
    waiting++
    await going.catch(() => false).finally(() => waiting--)
  }
  return existsSync(folder)
}

// Callers of folderThere waiting for a quiet check now.
let waiting = 0

/** How many callers of folderThere wait for a quiet check now (tests). */
export const folderWaiting = (): number => waiting

async function quietOnce(folder: string): Promise<boolean> {
  const aside = `${folder}.cw-quiet-${randomBytes(3).toString('hex')}`
  try {
    await rename(folder, aside)
  } catch {
    return false
  }
  for (let i = 0; ; i++) {
    try {
      await rename(aside, folder)
      return true
    } catch (e) {
      if (i >= 20) {
        log.error(`Could not put slot folder ${userText(folder)} back from ${userText(aside)}`, e)
        return false
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}
