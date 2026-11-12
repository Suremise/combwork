// A switch between Git and jj (HI-2799, J6; SPEC §16.6.5): the repository's, stricter than §16.6.5's "from the next card".
// Every project of the workspace on the repository whose choice is Git or jj (and the one switched, None → jj too) moves
// together, named in the warning; nothing may still run on the repository (lanes, cards in flight, the merge queue, slot
// and copy leases); to jj, the repository must use nothing jj doesn't support and jj must confirm it; back to Git, jj's
// state must be one Git can take (exported, unconflicted). The design is HI-2799/s11 to s26.
//
// The guarantee (s17 to s26): the platform fence (platform/platformFence.ts), rows in the workspace database every
// admission reads in its own write transaction. In lock order (the store's repository lock, then the workflow writes, then
// each project.json's own lock):
//   A   one write: the fence `switching`, each member's before and after, the members' rows. From its commit on, every
//       admission of a member (and of any Git or jj project on the store) is refused, so what the drain reads next is
//       final: an admission is either committed before A (the drain sees it) or refused.
//   the drain, read after A: anything still running rolls the fence back, nothing written, and refuses.
//   each member's project.json written.
//   B   one write: the fence `settled`, each member's current choice the one its disk shows.
// A failure between A and B is settled in the switch's own `finally`, still under the lock, from what each member's disk
// shows (reconcile); recovery (`recoverFences`) does the same for a switch whose owner is gone, under the same lock.

import { createHash, randomUUID } from 'crypto'
import { lstat } from 'original-fs/promises'
import { basename, dirname, join } from 'path'
import { listLanes, rawLanes } from '../lanes'
import { createLogger, userText } from '../logger'
import { CombworkError, combworkError } from '../combworkError'
import { foundKey, platformIdOf, projectPlatform } from '../platform/registry'
import { needsRepository, PLATFORMS, type PlatformId } from '../../shared/platform/descriptors'
import { drainEmpty, PLATFORM_NAME, SWITCH_REFUSED, switchRefusalText, type FallbackProblem, type GateCheck, type StoreSwitch, type SwitchDrain, type SwitchRefusal } from '../../shared/platform/switching'
import { setKept } from '../../shared/workflow/projectWorkflow'
import { withValues } from '../../shared/advanced'
import type { ProjectConfig } from '../../shared/types'
import { onAfterRefresh, openWorkspaces, type WorkspaceService } from '../workspace'
import { cardsInFlight } from './optionsForm'
import { workflowFor } from './service'
import { queueChanged } from './queueHost'
import { workflowChanged } from './rulesets'
import { workflowWrite } from './writes'
import { withFolderRepoLocks } from '../platform/repoPorts'
import { commonGitDir } from '../repoLock'
import { boundaryOf } from '../platform/repoBoundary'
import { gitAbove, jjOf } from '../vcsDetect'
import { readKeptJson } from '../fsutil'
import { boardRead, boardWrite, boardWriteOp } from '../boardStore'
import { SlotStore } from '../slots'
import { CopyStore } from '../copies'
import { boardConn, holder } from '../slotsApp'
import { tell } from '../notify'
import { fmt, msg, tr } from '../../shared/i18n'
import { assessJj, REPO_GATES } from '../platform/jjCompat'
import { BOOKMARK_TEMPLATE, gitBranches, parseBookmarkRows, pinnedContextOf } from '../platform/jjViews'
import { isJjUnknown, JjReads } from '../platform/jjReads'
import { jjRunner, type JjRunner } from '../platform/jjRunner'
import { beginSwitch, type BeginMember, dropMember, FENCE_KEY, fenceOrNull, membershipOf, participates, mapStore, readFence, reconcile, settle, storeKey, type Fence, type FenceOwner, type Meta, type Snap } from '../platform/platformFence'
import { metaOf, projectIdOf } from '../platform/fenceAdmit'

const log = createLogger('workflow')

/** The switches this process is making now, by owner token: recovery never settles one of them. */
const ACTIVE = new Set<string>()

/**
 * The repository a project's detection names, or none: a Git project's store (its common git dir); a jj project's, colocated
 * or not (HI-2896), the Git store its `.jj` names, read from its files as J0 reads them (a colocated pair's is the same
 * `.git`, so both name one store). A jj repository inside a Git working tree, or one whose files can't be read, is none.
 */
async function storeOf(path: string): Promise<string | 'none'> {
  const s = await storeRead(path)
  return s === 'unknown' ? 'none' : s
}

/**
 * HI-3071: as `storeOf`, but a read that failed (git couldn't be run or answered an error, jj's files couldn't be read)
 * is `unknown`, never `none`: one refresh that can't read the repository says nothing about where the project is.
 */
async function storeRead(path: string): Promise<string | 'none' | 'unknown'> {
  const d = projectPlatform(path, 'none').detected
  if (d.platform === 'jj' && d.root && !d.jj?.colocated) {
    if (d.jj?.inGit) return 'none'
    const b = await boundaryOf(d.root)
    return 'jj' in b ? storeKey(b.jj.store) : 'unknown' in b ? 'unknown' : 'none'
  }
  const root = d.platform === 'git' || d.platform === 'jj' ? d.root : null
  if (!root) return 'none'
  const s = await commonGitDir(root).catch(() => null)
  // A store whose folder isn't a git folder (a `.git` file naming a missing one, read textually: HR1's round 1) proves
  // nothing about where the project is: unknown, never another repository.
  return s && (await gitDirThere(s)) ? storeKey(s) : 'unknown'
}

/** Whether a common git dir is there as one: a folder holding HEAD and objects (read; any failure counts as not). */
async function gitDirThere(dir: string): Promise<boolean> {
  const [head, objects] = await Promise.all([lstat(join(dir, 'HEAD')).catch(() => null), lstat(join(dir, 'objects')).catch(() => null)])
  return !!head && !!objects?.isDirectory()
}

/** What a project's project.json holds of what a switch changes (its platform as in force). */
const snapOf = (cfg: ProjectConfig, path: string): Snap => ({
  platform: platformIdOf(path, cfg.platform),
  ...(typeof cfg.platformFound === 'string' ? { platformFound: cfg.platformFound } : {}),
  ...(cfg.workflow !== undefined ? { workflow: JSON.parse(JSON.stringify(cfg.workflow)) as unknown } : {})
})

/** A project's snapshot read from its disk (recovery's), or null when unreadable. */
async function diskSnap(path: string): Promise<Snap | null> {
  const cfg = await readKeptJson<ProjectConfig | null>(join(path, '.combwork', 'project.json'), null).catch(() => null)
  return cfg ? snapOf(cfg, path) : null
}

interface Member {
  id: string
  path: string
  name: string
  from: PlatformId
}

interface Group {
  store: string
  members: Member[]
  /**
   * HI-3070: the other projects of this workspace on the repository whose choice is None (not switched, never members),
   * whose work still running under Git or jj (a card started under it and not done, its slot or copy leases, its merge
   * queue) counts in the drain: the switch waits for it as for the members'.
   */
  bystanders: Member[]
  token: string
}

/**
 * The group a switch of `path` moves (s20): every project of this workspace on its repository whose choice is Git or jj,
 * plus the project itself; its token hashes what the warning shows (each member, its choice and options, the fence's
 * generation and the store), so a member joining or changing after it refuses the switch.
 */
async function groupOf(ws: WorkspaceService, path: string): Promise<Group | null> {
  const store = await storeOf(path)
  if (store === 'none') return null
  const projects = ws.info()?.projects ?? []
  const members: (Member & { snap: Snap })[] = []
  const bystanders: Member[] = []
  for (const p of projects) {
    const isSelf = p.path.toLowerCase() === path.toLowerCase()
    const cfg = await ws.projectConfig(p.path).catch(() => null)
    if (!cfg) continue
    const from = platformIdOf(p.path, cfg.platform)
    if (!isSelf) {
      // HI-3071: a project read as on another repository is outside the group; one whose repository can't be read now,
      // or reads as none (its `.git` away a moment: HR1's round 1), stays in it while it is a member of this store's
      // fence, as `mapStores` keeps it one (never left undrained by one failed read). Its membership itself unreadable:
      // the switch is refused (`switching`), never decided without it.
      const s = await storeRead(p.path)
      const id = projectIdOf(cfg, p.path)
      if (s === 'unknown' || s === 'none' ? memberStoreOf(ws, id) !== store : s !== store) continue
    }
    if (!isSelf && from === 'none') {
      bystanders.push({ id: projectIdOf(cfg, p.path), path: p.path, name: p.name, from })
      continue
    }
    members.push({ id: projectIdOf(cfg, p.path), path: p.path, name: p.name, from, snap: snapOf(cfg, p.path) })
  }
  members.sort((a, b) => a.id.localeCompare(b.id))
  const gen = boardRead(ws, (db) => {
    const f = readFence(metaOf(db), store)
    return f && typeof f === 'object' ? f.generation : 0
  })
  const token = createHash('sha256')
    .update(JSON.stringify([store, gen, members.map((m) => [m.id, m.path.toLowerCase(), m.from, createHash('sha256').update(JSON.stringify(m.snap)).digest('hex')])]))
    .digest('hex')
    .slice(0, 32)
  return { store, members: members.map(({ snap: _s, ...m }) => m), bystanders, token }
}

/** Another open workspace with a project on the store: its admissions can't be fenced from here (s17). */
async function otherWorkspaceOn(ws: WorkspaceService, store: string): Promise<string | null> {
  for (const other of openWorkspaces()) {
    // The same workspace (a window's service and the one IPC hands over are the same folder): never "another".
    if (other === ws || !other.path || (ws.path && other.path.toLowerCase() === ws.path.toLowerCase())) continue
    for (const p of other.info()?.projects ?? []) if ((await storeOf(p.path)) === store) return basename(other.path)
  }
  return null
}

/**
 * What still runs on the group's repository (none of it changed by a switch). HI-3069: and each slot kept for a card
 * (put back with its committed work) that isn't of the platform switched `to`: it could never be lent back after the
 * switch, so the switch waits until its card has finished. One already of `to` is left out, so switching back to the
 * platform it was made under is never refused for it.
 */
async function drainOf(ws: WorkspaceService, members: readonly Member[], to: PlatformId, bystanders: readonly Member[] = []): Promise<SwitchDrain> {
  const d: SwitchDrain = { lanes: [], cards: [], queue: [], slots: [], copies: [], kept: [] }
  for (const m of bystanders) await bystanderDrain(ws, m, to, d)
  for (const m of members) {
    for (const l of await listLanes(ws, { project: m.name })) if (l.state === 'active' || l.state === 'paused') d.lanes.push({ project: m.name, id: l.id, name: l.name, builder: l.builder.name })
    for (const c of await cardsInFlight(ws, { path: m.path, name: m.name })) d.cards.push({ project: m.name, number: c.number, title: c.title })
    const wf = await workflowFor(ws, m.path).catch(() => null)
    if (wf?.store.cards().some((c) => {
      const s = wf.state(c)
      return !!s.started && s.stage !== 'todo' && s.stage !== 'done' && wf.rulesetOf(c, s).options.finish === 'combworkMerges'
    })) d.queue.push(m.name)
    for (const l of new SlotStore(boardConn(ws), m.id).openLeases()) d.slots.push({ project: m.name, slot: l.slot, agent: l.agent })
    for (const l of new CopyStore(boardConn(ws), m.id).unfreed()) d.copies.push({ project: m.name, copy: l.copy, kind: l.kind })
    for (const k of new SlotStore(boardConn(ws), m.id).keptSlots()) if (k.platform !== to) d.kept.push({ project: m.name, slot: k.slot, card: k.card })
  }
  return d
}

/**
 * HI-3070: a project on None beside the group (a bystander) adds only its work under Git or jj: its cards in flight
 * started under a repository's rules (`Started` compiled with Git or jj: a card started under None never touches the
 * repository), its merge queue's work, its open slot leases, unfreed copies and slots kept across platforms, and its
 * running lanes whose recorded ruleset needs a repository (HR2's round 1: a Git lane keeps Git's rules for its cards,
 * Todo ones too, so one before its first card starts holds repository work no started card shows; a ruleset that can't
 * be read counts as one); never a lane recorded under None.
 */
async function bystanderDrain(ws: WorkspaceService, m: Member, to: PlatformId, d: SwitchDrain): Promise<void> {
  const wf = await workflowFor(ws, m.path).catch(() => null)
  for (const l of await rawLanes(ws)) {
    if (l.state !== 'active' || l.project.toLowerCase() !== m.name.toLowerCase()) continue
    let repo = true
    try {
      repo = !l.ruleset || !wf ? !!l.ruleset : needsRepository(wf.store.ruleset(l.ruleset).options.platform)
    } catch {
      repo = true
    }
    if (repo) d.lanes.push({ project: m.name, id: l.id, name: l.name, builder: l.builder.name })
  }
  if (wf) {
    const repoCards = new Set(
      wf.store
        .cards()
        .filter((c) => {
          const s = wf.state(c)
          return !!s.started && s.stage !== 'todo' && s.stage !== 'done' && needsRepository(wf.rulesetOf(c, s).options.platform)
        })
        .map((c) => c.id)
    )
    for (const c of await cardsInFlight(ws, { path: m.path, name: m.name })) if (repoCards.has(c.number)) d.cards.push({ project: m.name, number: c.number, title: c.title })
    if (wf.store.cards().some((c) => {
      const s = wf.state(c)
      return !!s.started && s.stage !== 'todo' && s.stage !== 'done' && wf.rulesetOf(c, s).options.finish === 'combworkMerges'
    })) d.queue.push(m.name)
  }
  for (const l of new SlotStore(boardConn(ws), m.id).openLeases()) d.slots.push({ project: m.name, slot: l.slot, agent: l.agent })
  for (const l of new CopyStore(boardConn(ws), m.id).unfreed()) d.copies.push({ project: m.name, copy: l.copy, kind: l.kind })
  for (const k of new SlotStore(boardConn(ws), m.id).keptSlots()) if (k.platform !== to) d.kept.push({ project: m.name, slot: k.slot, card: k.card })
}

/** jj itself confirms the repository on exactly this store, colocated or not (HI-2896), with the tested jj (s11 §3c). */
async function jjReady(path: string, store: string): Promise<SwitchRefusal | null> {
  // Confirmed pinned at the single head (never a merge of diverged ones), the heads read again after.
  const d = await pinnedContextOf(path)
  if ('none' in d) return { why: 'noJj' } // i18n-ignore: a code, never shown as text
  if ('jjUnknown' in d) return d.jjUnknown === 'tool' ? { why: 'jjTool', state: jjRunner.readinessNow().state } : { why: 'jjUnknown', code: d.jjUnknown } // i18n-ignore: a code, never shown as text
  if (storeKey(d.ctx.store) !== store) return { why: 'jjUnknown', code: 'disagrees' } // i18n-ignore: a code, never shown as text
  return null
}

/**
 * A non-colocated repository's slots folder (`<workspace>.worktrees\<project>`) inside a Git working tree (HI-2896): its
 * slots and copies would be too, and a git command run in one would reach that tree. Null when it isn't (or colocated).
 */
function slotsInGit(ws: WorkspaceService, path: string): SwitchRefusal | null {
  const d = projectPlatform(path, 'none').detected
  if (d.platform !== 'jj' || d.jj?.colocated || !ws.path) return null
  const git = gitAbove(join(ws.worktreesRoot, basename(path), 'slot'))
  return git ? { why: 'jjInGit', root: git } : null // i18n-ignore: a code, never shown as text
}

/** To jj: each repository gate's finding, and jj's own limits (always). */
async function gatesOf(path: string, store: string): Promise<GateCheck[]> {
  const root = projectPlatform(path, 'none').detected.root ?? path
  // Not colocated (HI-2896): Git is asked of the store inside .jj, and the tracked files are jj's (assessJj's `separate`).
  const b = await boundaryOf(root)
  if ('unknown' in b) return REPO_GATES.map((g): GateCheck => ({ gate: g, unknown: `jj: ${b.unknown}` })) // i18n-ignore: what was found, shown as data beside its message
  const a = 'jj' in b ? await assessJj(root, b.jj.store, undefined, { separate: { jjRepo: b.jj.jjRepo } }) : await assessJj(root, store)
  return REPO_GATES.map((g): GateCheck => {
    const f = a[g]
    return 'clear' in f ? { gate: g, clear: true } : 'uses' in f ? { gate: g, uses: f.uses, ...(f.autocrlf ? { autocrlf: true as const } : {}) } : { gate: g, unknown: f.unknown }
  })
}

/**
 * A member other than the one asked whose folder holds no jj workspace (HI-3034): a `git worktree` of the repository, or
 * one nested inside its jj workspace (HI-2976), which jj doesn't know. Made a jj project by the group's switch, it would
 * be one with no jj repository, so the switch is refused naming it. Null when every member is a jj workspace.
 */
function memberWithoutJj(path: string, members: readonly Member[]): SwitchRefusal | null {
  const m = members.find((x) => x.path.toLowerCase() !== path.toLowerCase() && !jjOf(x.path))
  return m ? { why: 'memberNoJj', project: m.name } : null // i18n-ignore: a code, never shown as text
}

/**
 * The folder whose jj repository a switch back to Git checks (HI-3034): the asked project's own when it is a jj
 * workspace, else a member's that is, else the working tree beside the repository's Git folder when it has a `.jj` (the
 * asked project a `git worktree` of a colocated repository that isn't itself a project). The asked folder when none has
 * one: the repository's `.jj` is gone (HI-2975), and nothing is left to check.
 */
async function jjSideOf(path: string, members: readonly Member[]): Promise<string> {
  if (jjOf(path)) return path
  const member = members.find((m) => jjOf(m.path))
  if (member) return member.path
  const gitDir = await commonGitDir(path).catch(() => null)
  return gitDir && jjOf(dirname(gitDir))?.colocated ? dirname(gitDir) : path
}

const UNSUPPORTED = PLATFORMS.jj.gates.filter((g) => !(REPO_GATES as readonly string[]).includes(g))

/**
 * Back to Git (s11 §3): one operation head, no conflicted local bookmark, every local bookmark exported (its `@git` and
 * Git's branch both its commit), no conflicted commit among the bookmarks' history. Read pinned.
 */
export async function fallbackOf(path: string, runner: JjRunner = jjRunner): Promise<FallbackProblem[]> {
  // Confirmed pinned at the single head (never a merge of diverged ones), the heads read again after.
  const d = await pinnedContextOf(path, runner)
  if ('jjUnknown' in d && d.jjUnknown === 'heads') return [{ code: 'heads', n: Number(d.detail) || 0 }]
  // No jj repository (its .jj gone, HI-2975): nothing to export and nothing that can conflict, so Git is ready as it is.
  if ('none' in d) return []
  if (!('ctx' in d)) return [{ code: 'unknown', detail: d.jjUnknown }]
  const c = d.ctx
  const reads = new JjReads({ folder: c.root, jjRepo: c.jjRepo }, runner)
  const r = await reads.pinned(async (op) => {
    const out = await reads.run(op, ['bookmark', 'list', '--all-remotes', '-T', BOOKMARK_TEMPLATE])
    if (isJjUnknown(out)) return out
    const rows = parseBookmarkRows(out)
    if (!rows) return { jjUnknown: 'malformed' as const, detail: 'bookmarkList' } // i18n-ignore: a code or SQL, never shown as text
    const conflicted = await reads.run(op, ['log', '--no-graph', '-r', 'conflicts() & ::bookmarks()', '-n', '5', '-T', 'commit_id ++ "\\n"'])
    if (isJjUnknown(conflicted)) return conflicted
    return { rows, conflicted: conflicted.split('\n').filter(Boolean) }
  })
  if (isJjUnknown(r)) return [{ code: 'unknown', detail: `${r.jjUnknown}${r.detail ? `: ${r.detail}` : ''}`.slice(0, 300) }]
  const out: FallbackProblem[] = []
  const git = await gitBranches(c.store)
  if (!git) return [{ code: 'unknown', detail: 'gitRefs' }] // i18n-ignore: a code or SQL, never shown as text
  const tracked = new Map(r.value.rows.filter((b) => b.remote === 'git').map((b) => [b.name, b.commit]))
  for (const b of r.value.rows) {
    if (b.remote !== null) continue
    if (b.conflict) out.push({ code: 'conflictedBookmark', name: b.name })
    else if (b.commit && (tracked.get(b.name) !== b.commit || git.get(b.name) !== b.commit)) out.push({ code: 'notExported', name: b.name })
  }
  for (const commit of r.value.conflicted) out.push({ code: 'conflictedCommit', commit })
  return out
}

/**
 * HI-3072: the version control the repository of `path` runs now, when its fence's members (settled) use one other than
 * `to` (a Git worktree project going back to Git on a repository its other projects switched to jj): a project there
 * using `to` would mix the two, and the fence refuses its every admission. Null when there's no such fence, or it
 * uses `to`, or isn't settled (a switch under way refuses on its own).
 */
export async function storeRunsOther(ws: WorkspaceService, path: string, to: PlatformId): Promise<PlatformId | null> {
  const store = await storeOf(path)
  if (store === 'none') return null
  const f = boardRead(ws, (db) => readFence(metaOf(db), store))
  if (!f || typeof f !== 'object' || f.state !== 'settled') return null
  const used = new Set(Object.values(f.members).map((m) => m.current.platform).filter((p) => needsRepository(p)))
  return used.size && !used.has(to) ? [...used][0] : null
}

/** A store-wide switch's warning and its refusal, read without changing anything (the dialog's, and the switch's own). */
export async function checkStoreSwitch(ws: WorkspaceService, path: string, to: PlatformId): Promise<{ refused: SwitchRefusal | null; store: StoreSwitch }> {
  const g = await groupOf(ws, path)
  const none: StoreSwitch = { group: [], token: '', drain: { lanes: [], cards: [], queue: [], slots: [], copies: [], kept: [] } }
  if (!g) return { refused: { why: to === 'jj' ? 'noJj' : 'noGit' }, store: none } // i18n-ignore: a code or SQL, never shown as text
  const store: StoreSwitch = { group: g.members.map((m) => ({ path: m.path, name: m.name, from: m.from })), token: g.token, drain: await drainOf(ws, g.members, to, g.bystanders) }
  let refused: SwitchRefusal | null = null
  const other = await otherWorkspaceOn(ws, g.store)
  if (other) refused = { why: 'otherWorkspace', workspace: other } // i18n-ignore: a code or SQL, never shown as text
  if (to === 'jj') {
    refused ??= slotsInGit(ws, path)
    refused ??= memberWithoutJj(path, g.members)
    refused ??= await (storeSwitchSeams.repo?.ready ?? jjReady)(path, g.store)
    store.gates = await (storeSwitchSeams.repo?.gates ?? gatesOf)(path, g.store)
    store.unsupported = UNSUPPORTED
    if (!refused && store.gates.some((x) => !('clear' in x))) refused = { why: 'gates' } // i18n-ignore: a code or SQL, never shown as text
  } else {
    // The repository's jj state, whichever member asks (HI-3034): a member with no .jj of its own reads none.
    store.fallback = await (storeSwitchSeams.repo?.fallback ?? fallbackOf)(await jjSideOf(path, g.members))
    // jj missing or not the tested version (HI-2975): the repository's readiness can't be checked, so the switch is
    // refused saying the way out (install the tested jj, or remove .jj once done with it), not as a list's `unknown`.
    if (!refused && store.fallback.some((f) => f.code === 'unknown' && /^tool(:|$)/.test(f.detail))) refused = { why: 'jjToolBack', state: jjRunner.readinessNow().state } // i18n-ignore: a code or SQL, never shown as text
    if (!refused && store.fallback.length) refused = { why: 'fallback' } // i18n-ignore: a code or SQL, never shown as text
  }
  if (!refused && !drainEmpty(store.drain)) refused = { why: 'drain' } // i18n-ignore: a code or SQL, never shown as text
  // A switch of the store under way (or its fence unreadable: fail closed).
  const fence = boardRead(ws, (db) => readFence(metaOf(db), g.store))
  if (!refused && fence !== null && (typeof fence !== 'object' || fence.state === 'switching')) refused = { why: 'switching' } // i18n-ignore: a code or SQL, never shown as text
  return { refused, store }
}

const refusalError = (r: SwitchRefusal): CombworkError => {
  const t = switchRefusalText(r)
  // agent-text: switchRefusalText
  return new CombworkError(t.values ? withValues(t.m, t.values) : t.m, { kind: 'conflict' })
}

/** Runs one fence write in the workspace database. */
const fenceWrite = <T>(ws: WorkspaceService, fn: (meta: Meta) => T): Promise<T> => boardWrite(ws, async () => boardWriteOp(ws, (db) => fn(metaOf(db))))

/** Seams for the tests' pauses (s17's deterministic two-project tests): awaited at each named point when set. */
export const storeSwitchSeams: {
  at?: (point: 'afterBegin' | 'afterDrain' | 'afterWrite' | 'beforeSettle', o: { members: readonly string[]; generation: number }) => Promise<void> | void
  write?: (path: string, partial: Partial<ProjectConfig>) => Promise<void>
  /** The repository's own checks (jj's confirmation, the gates, the fallback), stood in for by the fence's tests; the real-jj tests run them. */
  repo?: { ready?: (path: string, store: string) => Promise<SwitchRefusal | null>; gates?: (path: string, store: string) => Promise<GateCheck[]>; fallback?: (path: string) => Promise<FallbackProblem[]> }
  /** HI-3073: the processes' probe (this process's id and start, whether one is still running), slots' own by default. */
  processes?: { self?: () => Promise<{ pid: number; started: number }>; alive?: (pid: number, started: number) => Promise<boolean | null> }
} = {}

/**
 * Switches the repository of `path` between Git and jj (or a None project to jj, with its group), as the warning showed:
 * `expected` the project's platform shown, `token` the group shown. Under the store's repository lock throughout.
 */
export async function storeSwitch(ws: WorkspaceService, path: string, from: PlatformId, to: PlatformId, o: { token?: unknown; guard?: (current: PlatformId) => void } = {}): Promise<{ from: PlatformId; to: PlatformId }> {
  const g0 = await groupOf(ws, path)
  if (!g0) throw refusalError({ why: to === 'jj' ? 'noJj' : 'noGit' }) // i18n-ignore: a code or SQL, never shown as text
  const paths = g0.members.map((m) => m.path)
  return withFolderRepoLocks(paths, () => workflowWrite(() => switchLocked(ws, path, from, to, o)), { quiet: true, project: path })
}

async function switchLocked(ws: WorkspaceService, path: string, from: PlatformId, to: PlatformId, o: { token?: unknown; guard?: (current: PlatformId) => void }): Promise<{ from: PlatformId; to: PlatformId }> {
  // A dead owner's switch of this store is settled first, under this same lock (s20 §2).
  const g = await groupOf(ws, path)
  if (!g) throw refusalError({ why: to === 'jj' ? 'noJj' : 'noGit' }) // i18n-ignore: a code or SQL, never shown as text
  await recoverStore(ws, g.store)
  const self = g.members.find((m) => m.path.toLowerCase() === path.toLowerCase())!
  if (self.from !== from) throw combworkError(SWITCH_REFUSED.changed, { platform: PLATFORM_NAME[self.from] }, { kind: 'conflict' })
  o.guard?.(self.from)
  if (typeof o.token !== 'string' || o.token !== g.token) throw refusalError({ why: 'groupChanged' }) // i18n-ignore: a code or SQL, never shown as text
  const check = await checkStoreSwitch(ws, path, to)
  if (check.refused) throw refusalError(check.refused)
  // Each member's before and after, as its project.json holds them now (no other workflow write runs meanwhile).
  const begin: BeginMember[] = []
  for (const m of g.members) {
    const cfg = await ws.projectConfig(m.path)
    const before = snapOf(cfg, m.path)
    const mDetected = projectPlatform(m.path, to).detected
    const after: Snap = { platform: to, platformFound: foundKey(mDetected), ...(before.workflow !== undefined ? { workflow: JSON.parse(JSON.stringify(setKept(cfg.workflow!, to))) as unknown } : {}) }
    begin.push({ id: m.id, path: m.path, before, after })
  }
  const owner = await fenceOwner(ws)
  ACTIVE.add(owner.token)
  let fence: Fence | null = null
  try {
    fence = await fenceWrite(ws, (meta) => beginSwitch(meta, g.store, begin, owner))
    if (!fence) throw refusalError({ why: 'switching' }) // i18n-ignore: a code or SQL, never shown as text
    const ids = begin.map((m) => m.id)
    await storeSwitchSeams.at?.('afterBegin', { members: ids, generation: fence.generation })
    // Nothing more can be admitted on the store: what runs now is final (s17). Anything still running: back, nothing written.
    const drain = await drainOf(ws, g.members, to, g.bystanders)
    await storeSwitchSeams.at?.('afterDrain', { members: ids, generation: fence.generation })
    if (!drainEmpty(drain)) {
      await fenceWrite(ws, (meta) => settle(meta, g.store, fence!.generation, Object.fromEntries(begin.map((m) => [m.id, m.before]))))
      fence = null
      throw refusalError({ why: 'drain' }) // i18n-ignore: a code or SQL, never shown as text
    }
    for (const m of begin) {
      const partial: Partial<ProjectConfig> = { platform: m.after.platform, platformFound: m.after.platformFound, ...(m.after.workflow !== undefined ? { workflow: m.after.workflow as ProjectConfig['workflow'] } : {}) }
      if (storeSwitchSeams.write) await storeSwitchSeams.write(m.path, partial)
      else await ws.mutateProjectConfig(m.path, () => partial, { existing: true })
    }
    await storeSwitchSeams.at?.('afterWrite', { members: ids, generation: fence.generation })
    await storeSwitchSeams.at?.('beforeSettle', { members: ids, generation: fence.generation })
    const settled = await fenceWrite(ws, (meta) => settle(meta, g.store, fence!.generation, Object.fromEntries(begin.map((m) => [m.id, m.after]))))
    if (!settled) throw new Error('the platform fence moved during its own switch') // i18n-ignore: an internal error, for the log
    fence = null
  } finally {
    // Failed between A and B: settled from what each member's disk shows, still under the lock (s20 §2, s23 §1).
    if (fence) await settleFromDisk(ws, g.store, fence.generation).catch((e) => log.warn(`settling the platform fence of ${userText(g.store)} after a failed switch`, e))
    ACTIVE.delete(owner.token)
  }
  log.info(`${g.members.map((m) => userText(m.name)).join(', ')} switched their version control from ${from} to ${to} (the repository's)`)
  await ws.refresh().catch((e) => log.warn('refreshing after a switch of version control', e))
  for (const m of g.members) {
    workflowChanged(ws, m.path)
    queueChanged(ws, m.path, '')
  }
  return { from, to }
}

/**
 * Settles a store's switching fence from its members' disks (s23 §1, s26): forward when every member shows its after,
 * else each member showing its after written back to its before (read back), the rest untouched; stuck (left switching,
 * fail closed, said in the log and a notice) when any member shows neither or can't be read. The caller holds the store's
 * repository lock and the workflow writes.
 */
async function settleFromDisk(ws: WorkspaceService, store: string, generation: number): Promise<'forward' | 'back' | 'stuck' | 'none'> {
  const f = boardRead(ws, (db) => fenceOrNull(metaOf(db), store))
  if (!f || f.state !== 'switching' || f.generation !== generation) return 'none'
  const disk: Record<string, Snap | null> = {}
  for (const [id, m] of Object.entries(f.members)) if (participates(f, m)) disk[id] = await diskSnap(m.path)
  const r = reconcile(f, disk)
  if ('stuck' in r) {
    log.warn(`The platform switch of ${userText(store)} can't be settled: ${r.stuck.map((id) => userText(id)).join(', ')} changed by hand meanwhile or unreadable; their work stays refused until they show their before or after`)
    tellStuck(ws, store, f, r.stuck)
    return 'stuck'
  }
  if ('back' in r) {
    for (const id of r.back) {
      const m = f.members[id]
      const b = m.attempt!.before
      await ws.mutateProjectConfig(m.path, (cfg) => ({ platform: b.platform, platformFound: b.platformFound, ...(b.workflow !== undefined ? { workflow: b.workflow as ProjectConfig['workflow'] } : cfg.workflow !== undefined ? { workflow: undefined } : {}) }), { existing: true })
      const now = await diskSnap(m.path)
      if (!now || JSON.stringify(now) !== JSON.stringify(b)) {
        log.warn(`Rolling back the platform switch of ${userText(store)}: ${userText(m.path)} doesn't read back as before; its work stays refused`)
        tellStuck(ws, store, f, [id])
        return 'stuck'
      }
    }
  }
  const currents = Object.fromEntries(Object.entries(f.members).filter(([, m]) => participates(f, m)).map(([id, m]) => [id, 'forward' in r ? m.attempt!.after : m.attempt!.before]))
  await fenceWrite(ws, (meta) => settle(meta, store, generation, currents))
  return 'forward' in r ? 'forward' : 'back'
}

/** A switch's owner: this process, by its id and (HI-3073) its start time, as slots record their holders'. */
async function fenceOwner(ws: WorkspaceService): Promise<FenceOwner> {
  const self = await (storeSwitchSeams.processes?.self ?? holder.self)().catch(() => ({ pid: process.pid, started: 0 }))
  return { token: randomUUID(), pid: process.pid, profile: ws.path ?? '', ...(self.started > 0 ? { started: self.started } : {}) }
}

/**
 * Whether a fence's owner may still be switching: this process's own switch, or another process still alive. HI-3073:
 * one recorded with its start time is that process only while a process with its id started then is running (a pid
 * the system gave another program since isn't it); a probe that can't tell counts as alive (fail closed). One
 * recorded before that (no start time): its id alone, as before.
 */
async function ownerLive(f: Fence): Promise<boolean> {
  const o = f.owner
  if (!o) return false
  if (ACTIVE.has(o.token)) return true
  if (o.pid === process.pid) return false
  if (o.started !== undefined) {
    const alive = await (storeSwitchSeams.processes?.alive ?? holder.alive)(o.pid, o.started).catch(() => null)
    return alive !== false
  }
  try {
    process.kill(o.pid, 0)
    return true
  } catch {
    return false
  }
}

/** The stuck switches already told to the user, by workspace, store and generation (once each). */
const toldStuck = new Set<string>()

const STUCK = {
  title: msg({ id: 'git.vc.store.stuckTitle', defaultMessage: 'A version control switch couldn’t be finished', description: 'HI-3073: a notice’s title. A switch between Git and jj was cut short (Combwork closed or crashed during it), and Combwork couldn’t settle it from the projects’ files, so the repository stays switching.' }),
  message: msg({ id: 'git.vc.store.stuck', defaultMessage: 'Combwork stopped while switching {projects} between Git and jj, and can’t tell from their settings which way to finish: {changed} changed or can’t be read. Until they show their version control from before or after the switch, nothing starts on their repository.', description: 'HI-3073: a notice’s message. {projects} names the projects that were switching; {changed}, those whose project settings were changed by hand meanwhile or can’t be read. Keep Git and jj.' })
}

/** HI-3073: a switch recovery left stuck, said once in a notice (beside the log), naming its projects. */
function tellStuck(ws: WorkspaceService, store: string, f: Fence, stuck: readonly string[]): void {
  // Per workspace too (HR1's round 1): each workspace's board keeps its own fences and generations, so two on the same
  // repository at generation 1 are two switches, each said in its own workspace.
  const key = `${(ws.path ?? '').toLowerCase()} ${store} ${f.generation}`
  if (toldStuck.has(key)) return
  toldStuck.add(key)
  const name = (id: string): string => ws.info()?.projects.find((p) => p.path.toLowerCase() === f.members[id]?.path.toLowerCase())?.name ?? basename(f.members[id]?.path ?? id)
  const parts = Object.entries(f.members).filter(([, m]) => participates(f, m)).map(([id]) => id)
  const first = parts.map((id) => f.members[id]?.path).find(Boolean) ?? null
  tell({ kind: 'warning', level: 'error', title: tr(STUCK.title), message: tr(STUCK.message, { projects: fmt.list(parts.map(name)), changed: fmt.list(stuck.map(name)) }), apiTitle: STUCK.title.defaultMessage, projectPath: first, id: `platform-stuck:${store}` })
}

/** Recovery of one store (s20 §2): its switching fence settled from the disks, unless its owner is live. Caller holds the lock. */
async function recoverStore(ws: WorkspaceService, store: string): Promise<void> {
  const f = boardRead(ws, (db) => readFence(metaOf(db), store))
  if (!f || typeof f !== 'object' || f.state !== 'switching' || (await ownerLive(f))) return
  await settleFromDisk(ws, store, f.generation)
}

/**
 * Recovery of every switching fence in the workspace whose owner is gone (at a refresh and before a switch): each under
 * its store's repository lock and the workflow writes, the fence read again there. A live owner's is never touched.
 */
export async function recoverFences(ws: WorkspaceService): Promise<void> {
  const rows = boardRead(ws, (db) => db.prepare("SELECT key, value FROM board_meta WHERE key LIKE 'platform\\_fence:%' ESCAPE '\\'").all() as { key: string; value: string }[]) // i18n-ignore: a code or SQL, never shown as text
  for (const row of rows) {
    const store = row.key.slice('platform_fence:'.length)
    const f = boardRead(ws, (db) => readFence(metaOf(db), store))
    if (!f || typeof f !== 'object' || f.state !== 'switching' || (await ownerLive(f))) continue
    const paths = Object.values(f.members).map((m) => m.path)
    await withFolderRepoLocks(paths, () => workflowWrite(() => recoverStore(ws, store)), { quiet: true }).catch((e) => log.warn(`recovering the platform switch of ${userText(store)}`, e))
  }
}

/**
 * The fence store of a project that is a member of one (HI-2974), null when it is in none. An unreadable member row or
 * fence refuses (`switching`: fail closed), never falls through to an unfenced switch.
 */
export function memberStoreOf(ws: WorkspaceService, id: string): string | null {
  const m = boardRead(ws, (db) => membershipOf(metaOf(db), id))
  if (m === 'unreadable') throw refusalError({ why: 'switching' }) // i18n-ignore: a code or SQL, never shown as text
  return m?.store ?? null
}

/**
 * A fence member's switch to a platform that needs no repository (None, HI-2974): its warning's refusal, read without
 * changing anything. Null when the project is in no fence (its switch is its own, undrained, its cards on their old rules).
 * Refused while anything runs in the project (`memberDrain`, its drain listed) or its store is switching.
 */
export async function checkMemberSwitch(ws: WorkspaceService, path: string, name: string, from: PlatformId): Promise<{ refused: SwitchRefusal | null; store?: StoreSwitch } | null> {
  const cfg = await ws.projectConfig(path)
  const id = projectIdOf(cfg, path)
  let store: string | null
  try {
    store = memberStoreOf(ws, id)
  } catch {
    return { refused: { why: 'switching' } } // i18n-ignore: a code or SQL, never shown as text
  }
  if (!store) return null
  const fence = boardRead(ws, (db) => readFence(metaOf(db), store))
  if (fence === null || typeof fence !== 'object' || fence.state === 'switching') return { refused: { why: 'switching' } } // i18n-ignore: a code or SQL, never shown as text
  const drain = await drainOf(ws, [{ id, path, name, from }], 'none')
  if (drainEmpty(drain)) return { refused: null }
  return { refused: { why: 'memberDrain' }, store: { group: [], token: '', drain } } // i18n-ignore: a code or SQL, never shown as text
}

/**
 * A fence member's switch to None (HI-2974), through its fence as a group of one: begun (its admissions refused from
 * here), drained (anything running in the project settles it back and refuses, `memberDrain`), written, settled. The
 * other members take no part and keep their current choice. The caller holds the project's repository lock and the
 * workflow writes (`setPlatform`); `check` re-reads the project's platform and the caller's authority under them.
 */
export async function memberSwitch(ws: WorkspaceService, path: string, name: string, store: string, to: PlatformId, check: (from: PlatformId) => void): Promise<{ from: PlatformId; to: PlatformId }> {
  await recoverStore(ws, store)
  const cfg = await ws.projectConfig(path)
  const id = projectIdOf(cfg, path)
  // Still this store's member, read again after recovery (a malformed row refuses).
  if (memberStoreOf(ws, id) !== store) throw refusalError({ why: 'groupChanged' }) // i18n-ignore: a code or SQL, never shown as text
  const now = projectPlatform(path, cfg.platform)
  const from = now.id
  check(from)
  if (from === to) return { from, to }
  const before = snapOf(cfg, path)
  const after: Snap = { platform: to, platformFound: foundKey(now.detected), ...(cfg.workflow !== undefined ? { workflow: JSON.parse(JSON.stringify(setKept(cfg.workflow, to))) as unknown } : {}) }
  const owner = await fenceOwner(ws)
  ACTIVE.add(owner.token)
  let fence: Fence | null = null
  try {
    fence = await fenceWrite(ws, (meta) => beginSwitch(meta, store, [{ id, path, before, after }], owner))
    if (!fence) throw refusalError({ why: 'switching' }) // i18n-ignore: a code or SQL, never shown as text
    await storeSwitchSeams.at?.('afterBegin', { members: [id], generation: fence.generation })
    // Nothing more can be admitted for the project: what runs now is final. Anything still running: back, nothing written.
    const drain = await drainOf(ws, [{ id, path, name, from }], to)
    await storeSwitchSeams.at?.('afterDrain', { members: [id], generation: fence.generation })
    if (!drainEmpty(drain)) {
      await fenceWrite(ws, (meta) => settle(meta, store, fence!.generation, { [id]: before }))
      fence = null
      throw refusalError({ why: 'memberDrain' }) // i18n-ignore: a code or SQL, never shown as text
    }
    const partial: Partial<ProjectConfig> = { platform: after.platform, platformFound: after.platformFound, ...(after.workflow !== undefined ? { workflow: after.workflow as ProjectConfig['workflow'] } : {}) }
    // The platform shown and the caller's authority checked again at the write itself (HR2's HI-2974 round 1): the
    // begin and the drain awaited since, and the Assistant's Control may have been revoked meanwhile.
    const recheck = (c: ProjectConfig): void => check(projectPlatform(path, c.platform).id)
    if (storeSwitchSeams.write) {
      recheck(await ws.projectConfig(path))
      await storeSwitchSeams.write(path, partial)
    } else
      await ws.mutateProjectConfig(
        path,
        (c) => {
          recheck(c)
          return partial
        },
        { existing: true }
      )
    await storeSwitchSeams.at?.('afterWrite', { members: [id], generation: fence.generation })
    await storeSwitchSeams.at?.('beforeSettle', { members: [id], generation: fence.generation })
    const settled = await fenceWrite(ws, (meta) => settle(meta, store, fence!.generation, { [id]: after }))
    if (!settled) throw new Error('the platform fence moved during its own switch') // i18n-ignore: an internal error, for the log
    fence = null
  } finally {
    if (fence) await settleFromDisk(ws, store, fence.generation).catch((e) => log.warn(`settling the platform fence of ${userText(store)} after a failed switch`, e))
    ACTIVE.delete(owner.token)
  }
  return { from, to }
}

/**
 * A fence member's own switch outside the repository's (jj → None, Git → None: s23 §2's "every later change of a member"):
 * its `current` set to what its project.json shows now, in one fence write, so its admissions are held to its new
 * choice. A project in no fence: nothing.
 */
export async function noteMemberChoice(ws: WorkspaceService, path: string): Promise<void> {
  const cfg = await ws.projectConfig(path)
  const id = projectIdOf(cfg, path)
  const snap = snapOf(cfg, path)
  await fenceWrite(ws, (meta) => {
    const m = meta.get(`platform_member:${id}`)
    const store = m ? (JSON.parse(m) as { store?: string }).store : undefined
    if (!store) return
    const f = fenceOrNull(meta, store)
    if (!f || !f.members[id]) return
    meta.set(FENCE_KEY(store), JSON.stringify({ ...f, members: { ...f.members, [id]: { ...f.members[id], current: snap } } } satisfies Fence))
  })
}

/** Each workspace's last map and recovery, chained: one at a time, a refresh during one waits for it. */
const after = new WeakMap<WorkspaceService, Promise<void>>()
onAfterRefresh((ws) => {
  const run = (after.get(ws) ?? Promise.resolve()).then(() => mapStores(ws)).then(() => recoverFences(ws)).catch((e) => log.warn('the platform fence after a refresh', e))
  after.set(ws, run)
})

/**
 * A refresh's store map (s20 §3): each project's repository as detected, written only when it changed; and a fence's
 * former members taken out of it (HR2's HI-2799 round 1) once they're on another repository, none, or no longer a
 * project of this workspace, never while they take part in a switch under way.
 */
export async function mapStores(ws: WorkspaceService): Promise<void> {
  const read: [string, string | 'none' | 'unknown'][] = []
  for (const p of ws.info()?.projects ?? []) {
    const cfg = await ws.projectConfig(p.path).catch(() => null)
    read.push([projectIdOf(cfg, p.path), await storeRead(p.path)])
  }
  // HI-3071: a project whose repository couldn't be read keeps its mapping and its membership as they are.
  const rows = read.filter((r): r is [string, string | 'none'] => r[1] !== 'unknown')
  const inWorkspace = new Set(read.map(([id]) => id))
  const live = new Map(rows.map(([id, s]) => [id, s === 'none' ? 'none' : storeKey(s)]))
  const { changed, left } = boardRead(ws, (db) => {
    const meta = metaOf(db)
    const members = db.prepare("SELECT key, value FROM board_meta WHERE key LIKE 'platform\\_member:%' ESCAPE '\\'").all() as { key: string; value: string }[] // i18n-ignore: SQL
    const gone = members.filter((r) => {
      const id = r.key.slice('platform_member:'.length)
      const store = (() => {
        try {
          return (JSON.parse(r.value) as { store?: unknown }).store
        } catch {
          return null
        }
      })()
      // Left only when it really has: no longer in the workspace, or its repository read as another store. Read as no
      // repository (a `.git` moved away a moment, say) or not read at all, it stays a member (HI-3071).
      if (!inWorkspace.has(id)) return true
      const now = live.get(id)
      return now !== undefined && now !== 'none' && now !== store
    }).map((r) => r.key.slice('platform_member:'.length))
    return { changed: rows.some(([id, s]) => meta.get(`platform_store:${id}`) !== (s === 'none' ? 'none' : storeKey(s))), left: gone }
  })
  if (changed || left.length) await fenceWrite(ws, (meta) => {
    rows.forEach(([id, s]) => mapStore(meta, id, s))
    for (const id of left) dropMember(meta, id)
  })
}
