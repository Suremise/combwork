// Runs as checks (#1222, SPEC §16.13): a progress run that names a card (and, on Git, what was checked out) brackets its
// command: what Combwork reads when it starts (before cw-progress runs the command) and when it finishes. Its end writes
// `CheckRan` in the card's facts, counted only if every rule holds, else with why not:
// - it was started as a check (`--check`) and reported the command configured for it when it was resolved, or its
//   command is exactly a configured one (`notCheck`);
// - Git: what it ran on contains the card's revision, read from where the card works: is it, for a card on its own line
//   (its folder's head); has it as an ancestor in a shared folder (its newest attributed commit); a card with no start
//   in its facts yet is checked on the run's own checkout (`notContained`); the folder clean at the start and the end
//   (`dirty`) and at the same checkout (`moved`);
// - nothing changed in between: the watcher's write log (platform/observe.ts) saw no write to a file git doesn't
//   ignore, no HEAD reflog entry, no agent's edit hook in the folder (`changed`); a folder the watcher has no complete
//   record of falls back to stat snapshots of its tracked files and the reflog, taken at the start and the end;
// - None: the card's declared paths, as declared at the start and again at the end, hash to the same revision
//   (`revisionChanged`), and no deliverable (the options' exclusions left out) was written in between (`changed`).
// Nothing gates on it in P3: the card's facts and the run's details say it.

import { join, resolve } from 'path'
import { boardWrite, cardDoc, hasCard, inBoardWrite } from '../boardStore'
import { git } from '../git'
import { getTask } from '../tasks'
import type { WorkspaceService } from '../workspace'
import { platformIdOf } from '../platform/registry'
import * as G from '../platform/git'
import { NoneAdapter } from '../platform/none'
import { readCheckPoint } from '../noneBaseline'
import { observer as appObserver, type FolderChanges } from '../platform/observe'
import { isUnknown, type Maybe } from '../platform/types'
import { blocks, snapshot } from './checks'
import { cardFacts } from './cardWork'
import { FactStore } from './factStore'
import { folderHead, LINK_TTL_MS, type RunLink } from './runLink'
import { workflowFor } from './service'
import type { RunRevision } from '../platform/adapter'
import type { ProgressRun, ProjectConfig } from '../../shared/types'
import type { PlatformId } from '../../shared/platform/descriptors'
import { agentActor, CHANGES_KEPT, foldCard, type Actor, type CheckRanData, type Fact } from '../../shared/workflow/facts'
import { allOff } from '../../shared/workflow/options'

/** What a run is for, as Combwork knows it when the run starts. */
export interface CheckRunFor {
  card: number
  /** The folder it runs in (Git), or the project's (None). */
  folder: string
  /** The card's project's folder (its repository, for ancestry). */
  project: string
  platform: PlatformId
  /** Git: what was checked out when it started, read by Combwork (runLink), and the revision it names (the same). */
  tested: string | null
  /** The check it was started as (`--check`), or null. */
  check: string | null
  /** That check's configured command when it was resolved: the command its run must report to count (#1222 round 2). */
  checkCommand: string | null
  /** Its command line, as its reporter said at its finish (a run without `--check` counts only if it is exactly a configured one). */
  command: string | null
  /** The project's configured check commands, by name. */
  commands: Record<string, string>
  /** The card's facts (where it works: its own line's folder, or a shared folder's attributed commits). */
  facts: readonly Fact[]
  /** None: the card's declared paths, and the folders left out of the deliverables (the options' `excluded`). */
  paths: string[]
  excluded: string[]
  /** Run with `--isolated` in a check copy of its own (#1435): its CheckRan says so. */
  isolated?: boolean
}

/** What the watcher answers (the app's observer; a test's own). */
export interface WriteLog {
  changedBetween(folder: string, t0: number, t1: number, counts?: (paths: string[]) => string[]): Promise<Maybe<FolderChanges>>
  settled(folder: string): Promise<void>
}

/** What was read when the run started. */
export interface CheckStart {
  t0: number
  /** Git: the folder's uncommitted changes. */
  dirty: Maybe<string[]> | null
  /**
   * The stat snapshot: what decides where the watcher's record of the run isn't complete. None: null where it couldn't
   * be read (HI-2358: its walk unreadable, or no answer from its worker), which never matches another.
   */
  snapshot: string | null
  /** The card's revision: None, its paths' hash; Git, read from where the card works (`cardRevisionNow`). */
  revision: string | null
  /** Git: how the tested checkout must hold it: be it (its own line), or have it as an ancestor (a shared folder). */
  containment: 'equal' | 'ancestor'
  /** None: the declared paths the revision was taken of. */
  paths: string[]
}

/** Git's tracked files and git dir, for a stat snapshot. */
async function tracked(folder: string): Promise<{ files: string[]; gitDir: string | null }> {
  const ls = await git(folder, ['ls-files', '-z'])
  const gd = await git(folder, ['rev-parse', '--absolute-git-dir'])
  return { files: ls.ok ? ls.out.split('\0').filter(Boolean) : [], gitDir: gd.ok ? gd.out.trim() : null }
}

/** A list read, or none where it couldn't be. */
const known = (l: Maybe<string[]>): string[] => (isUnknown(l) ? [] : l)
const listed = (l: Maybe<string[]> | null): string[] => (l === null ? [] : known(l))
/** The paths a CheckRan keeps of what stopped it counting: each once, at most CHANGES_KEPT. */
const kept = (paths: string[]): string[] => [...new Set(paths)].slice(0, CHANGES_KEPT)

/** None's hasher of the project, its configured exclusions left out of the deliverables. */
function noneOf(r: CheckRunFor): NoneAdapter {
  return new NoneAdapter(r.project, r.excluded)
}

/**
 * A None check's point, read off main's thread (HI-2358): its declared paths' revision on a fresh adapter (cold
 * hashes: the whole project for a card declaring `.`) and, when `snapshot`, every deliverable's stat line. Nothing
 * where no answer came: a null revision and snapshot, so the run doesn't count.
 */
async function nonePoint(r: CheckRunFor, paths: readonly string[], withSnapshot: boolean): Promise<{ revision: string | null; snapshot: string | null }> {
  const none = noneOf(r)
  const p = await readCheckPoint({ project: r.project, excluded: none.excludedNames, caseless: none.caseless, paths, snapshot: withSnapshot })
  return { revision: p?.revision ?? null, snapshot: p?.snapshot ?? null }
}

/**
 * The card's revision on Git, read when the run starts, independently of what the run tested (HR5's #1222 round 1):
 * - a card on its own line (started in a folder of its own): its folder's head, which the tested checkout must be;
 * - a card in a shared folder (`project`): its newest attributed commit, else its base, which the checkout must contain;
 * - a card with no start in its facts (from before the runtime records one): the run's own checkout, so only that it
 *   was clean and unchanged is checked.
 */
async function cardRevisionNow(r: CheckRunFor): Promise<{ revision: string | null; containment: 'equal' | 'ancestor' }> {
  const s = foldCard(r.facts)
  if (!s.started || !s.cycle) return { revision: r.tested, containment: 'equal' }
  if (s.started.folder === 'project') return { revision: s.attributed.at(-1) ?? s.started.base, containment: 'ancestor' }
  return { revision: await folderHead(s.started.folder), containment: 'equal' }
}

/** Reads what a run is checked against, before its command starts. */
export async function checkStart(r: CheckRunFor, log: WriteLog = appObserver, now: () => number = Date.now): Promise<CheckStart> {
  // What was written before it started is in the write log first (its events come in after their writes); then the
  // start is taken before the rest is read: a write meanwhile counts against the run (the safe side).
  await log.settled(r.folder)
  const t0 = now()
  if (r.platform === 'none') {
    // Read before the command starts (its caller awaits this), after t0: a write while it is read counts against it.
    const p = await nonePoint(r, r.paths, true)
    return { t0, dirty: null, snapshot: p.snapshot, revision: p.revision, containment: 'equal', paths: [...r.paths] }
  }
  const t = await tracked(r.folder)
  const snap = await snapshot(r.folder, t.files, t.gitDir)
  const dirty = await G.dirty(r.folder)
  return { t0, dirty, snapshot: snap, ...(await cardRevisionNow(r)), paths: [] }
}

/**
 * Which check a run was, and whether it ran that check's command: started as one (`--check`), it must report the
 * command configured for it when it was resolved, never another (a start through the Agent API names both); else its
 * command must be exactly a configured one. The command it reported is what's recorded.
 */
function whichCheck(r: CheckRunFor): { name: string | null; ran: boolean } {
  const command = r.command?.trim() || null
  // A focused test's check (HI-1367) runs the reviewer's own command, recorded as run: any command counts.
  if (r.check && r.checkCommand === '') return { name: r.check, ran: command !== null }
  if (r.check) return { name: r.check, ran: command !== null && command === r.checkCommand?.trim() }
  const name = command ? (Object.entries(r.commands).find(([, c]) => c === command)?.[0] ?? null) : null
  return { name, ran: name !== null }
}

/**
 * The `CheckRan` a finished run writes: counted, or not and why. `endPaths`: None's declared paths when it finished
 * (read again then): a list changed meanwhile is a new revision.
 */
export async function checkEnd(r: CheckRunFor, start: CheckStart, end: { at: number; result: CheckRanData['result']; run: string; by: string; title: string; endPaths?: string[] }, log: WriteLog = appObserver): Promise<CheckRanData> {
  const check = whichCheck(r)
  const base = { name: check.name ?? end.title, command: r.command?.trim() ?? '', run: end.run, durationMs: Math.max(0, end.at - start.t0), by: end.by, result: end.result, ...(r.isolated ? { isolated: true } : {}) }
  let whyNot: CheckRanData['whyNot']
  if (r.platform === 'none') {
    const none = noneOf(r)
    const paths = end.endPaths ?? start.paths
    // The watcher's record first; then the point, off main's thread (HI-2358), its snapshot only where that record isn't
    // complete. Nothing read, or unreadable, never counts: a null revision or snapshot matches nothing.
    const seen = await log.changedBetween(r.folder, start.t0, end.at, (written) => written.filter((f) => none.isDeliverable(f)))
    const p = await nonePoint(r, paths, isUnknown(seen))
    const tested = p.revision ?? ''
    const samePaths = JSON.stringify([...paths].sort()) === JSON.stringify([...start.paths].sort())
    if (!check.ran) whyNot = 'notCheck'
    else if (start.revision === null || p.revision === null || !samePaths || start.revision !== p.revision) whyNot = 'revisionChanged'
    else if (isUnknown(seen) ? start.snapshot === null || p.snapshot === null || start.snapshot !== p.snapshot : seen.changed) whyNot = 'changed'
    const changes = whyNot === 'changed' && !isUnknown(seen) ? kept(seen.paths) : []
    return { ...base, revision: start.revision ?? '', tested, counted: !whyNot, ...(whyNot ? { whyNot } : {}), ...(changes.length ? { changes } : {}) }
  }
  const tested = r.tested ?? ''
  const revision = start.revision
  const seen = await log.changedBetween(r.folder, start.t0, end.at)
  let snapB: string | null = null
  if (isUnknown(seen)) {
    const t = await tracked(r.folder)
    snapB = await snapshot(r.folder, t.files, t.gitDir)
  }
  const dirtyB = await G.dirty(r.folder)
  const headB = await folderHead(r.folder)
  const contained = !!tested && !!revision && (revision === tested || (start.containment === 'ancestor' && (await G.isAncestor(r.project, revision, tested)) === true))
  const isDirty = (d: Maybe<string[]> | null): boolean => d === null || isUnknown(d) || d.length > 0
  if (!check.ran) whyNot = 'notCheck'
  else if (!contained) whyNot = 'notContained'
  else if (isDirty(start.dirty) || isDirty(dirtyB)) whyNot = 'dirty'
  else if (headB !== tested) whyNot = 'moved'
  else if (isUnknown(seen) ? start.snapshot !== snapB : seen.changed) whyNot = 'changed'
  // What stopped it counting, where it is known (#1654): what the watcher saw written, or the uncommitted files.
  const changes = whyNot === 'changed' && !isUnknown(seen) ? kept(seen.paths) : whyNot === 'dirty' ? kept([...listed(start.dirty), ...listed(dirtyB)]) : []
  return { ...base, revision: revision ?? '', tested, counted: !whyNot, ...(whyNot ? { whyNot } : {}), ...(changes.length ? { changes } : {}) }
}

// --- In the app: the runs being bracketed, from their start (servers.ts' POST /v1/progress) to their finish.

/** A run being bracketed: its workspace, what it is for and what its start read. */
export interface Bracket {
  ws: WorkspaceService
  workspacePath: string
  /** The card's project on the board (its folder's name). */
  project: string
  for: CheckRunFor
  start: CheckStart
}

/** Runs bracketed at most at once: past it, the oldest go (a run that never finishes leaves its bracket). */
const MAX_OPEN = 200
const open = new Map<string, Bracket>()

/**
 * What a run starting now for a card is checked against, read before its command starts; null when it names no card,
 * is for a card about the workspace, or names no checkout on Git (nothing to count it for), or the board has no facts.
 */
export async function bracketFor(ws: WorkspaceService, link: RunLink): Promise<Bracket | null> {
  const workspacePath = ws.path
  if (!workspacePath || link.card === null) return null
  const got = cardFacts(ws, link.card)
  if (!got) return null
  const c = await getTask(link.card, ws).catch(() => null)
  if (!c || c.archived || !c.project) return null
  const project = join(workspacePath, c.project)
  const cfg = (await ws.projectConfig(project).catch(() => null)) as (ProjectConfig & { workflow?: { options?: { commands?: Record<string, unknown>; excluded?: unknown } } }) | null
  const platform = platformIdOf(project, cfg?.platform)
  if (platform === 'git' && (!link.folder || !link.testedCheckout)) return null
  const options = cfg?.workflow?.options
  const commands = Object.fromEntries(Object.entries(options?.commands ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1].trim()).map(([k, v]) => [k, v.trim()]))
  // The options' exclusions, else the defaults (node_modules, .venv), until #1218 resolves the options with defaults.
  const excluded = Array.isArray(options?.excluded) && options.excluded.every((x) => typeof x === 'string') ? (options.excluded as string[]) : allOff('none').excluded
  const f: CheckRunFor = { card: link.card, folder: platform === 'none' ? project : link.folder!, project, platform, tested: link.testedCheckout, check: link.check?.name ?? null, checkCommand: link.check?.command ?? null, command: null, commands, facts: got.facts, paths: platform === 'none' ? declaredPaths(ws, c.project, link.card) : [], excluded, ...(link.isolated ? { isolated: true } : {}) }
  return { ws, workspacePath, project: c.project, for: f, start: await checkStart(f) }
}

/**
 * A run's revisions for a card, through the adapter of the platform its ruleset names (#1233, runLink's `cardRun`), or
 * null for a card with no start in its facts (from before 1.0, not started; archived or gone), whose run reads its
 * folder with git.
 */
export async function cardRunRevision(ws: WorkspaceService, n: number, folder: string | null, named: string | null): Promise<RunRevision | null> {
  const workspacePath = ws.path
  const got = workspacePath ? cardFacts(ws, n) : null
  const s = got ? foldCard(got.facts) : null
  if (!workspacePath || !s?.started) return null
  const c = await getTask(n, ws).catch(() => null)
  if (!c || c.archived || !c.project) return null
  // The project's runtime (#1263), read only here: no write, so no lock and no actions. None: not one of the
  // workspace's projects with a platform (or the workspace closed meanwhile), whose run reads its folder with git.
  const wf = await workflowFor(ws, join(workspacePath, c.project)).catch(() => null)
  if (!wf) return null
  const card = wf.store.card(n)
  return wf.platformOf(card, s).runRevision(card, s, folder, named)
}

/** None's declared paths of a card, as the board has them now. */
const declaredPaths = (ws: WorkspaceService, project: string, card: number): string[] => FactStore.forBoard(ws, { project, key: project }).card(card).paths ?? []

/** The bracket's card as the board has it now, if it is still there and still its project's. */
function cardOf(b: Bracket): boolean {
  const doc = hasCard(b.ws, b.for.card) ? cardDoc(b.ws, b.for.card) : null
  return !!doc && doc.archived !== true && doc.project === b.project
}

/** The run a bracket is for has started. */
export function bracketStarted(runId: string, b: Bracket): void {
  while (open.size >= MAX_OPEN) open.delete(open.keys().next().value!)
  open.set(runId, b)
}

/** A run's record as a check: its `CheckRan`, its platform, and whether it blocks review (#1279). */
export type Recorded = CheckRanData & { platform: PlatformId; blocks?: 'review' }

/**
 * Each project's check records still being written, by workspace and project folder (#1651): a submit right after
 * cw-progress exits waits for them (`checksSettled`), since a run's end reads the folder (the watcher settling, git)
 * before its `CheckRan` is written, and a passed check counts for its commit as soon as its run has finished.
 */
const recording = new WeakMap<WorkspaceService, Map<string, Set<Promise<unknown>>>>()
const projectKey = (p: string): string => resolve(p).toLowerCase()

/** The check records still being written for a project. Inside a write to its board they can't be waited for (they wait for it). */
export async function checksSettled(ws: WorkspaceService, projectPath: string): Promise<void> {
  if (ws.path && inBoardWrite(ws.path)) return
  const going = recording.get(ws)?.get(projectKey(projectPath))
  if (going?.size) await Promise.allSettled([...going])
}

/**
 * A run finished: its `CheckRan`, written in its card's facts inside a board change, or null when it wasn't bracketed,
 * didn't end with a result, or its workspace or card has gone meanwhile. Its project's submits wait for it meanwhile.
 */
export function bracketFinished(run: ProgressRun): Promise<Recorded | null> {
  const b = open.get(run.id)
  open.delete(run.id)
  if (!b) return Promise.resolve(null)
  let byProject = recording.get(b.ws)
  if (!byProject) recording.set(b.ws, (byProject = new Map()))
  const k = projectKey(b.for.project)
  const going = byProject.get(k) ?? new Set()
  byProject.set(k, going)
  const work = record(run, b)
  going.add(work)
  void work.catch(() => undefined).then(() => {
    going.delete(work)
    if (!going.size && byProject.get(k) === going) byProject.delete(k)
  })
  return work
}

async function record(run: ProgressRun, b: Bracket): Promise<Recorded | null> {
  if (run.finishedAt === null || (run.state !== 'passed' && run.state !== 'failed' && run.state !== 'stopped')) return null
  if (b.ws.path !== b.workspacePath || !cardOf(b)) return null
  // Its command as its reporter said (cw-progress: the check's command, or its command line); None's declared paths
  // as they are now: a list changed during the run is a new revision.
  const endPaths = b.for.platform === 'none' ? declaredPaths(b.ws, b.project, b.for.card) : undefined
  const ended = await checkEnd({ ...b.for, command: run.command }, b.start, { at: run.finishedAt, result: run.state, run: run.id, by: run.agentName, title: run.title, endPaths })
  // Who ran it, by id (HI-1367): the merge queue takes a focused test's proof only from its card's reviewer.
  const data = run.source === 'agent' && run.agentId ? { ...ended, agent: run.agentId } : ended
  if (b.ws.path !== b.workspacePath) return null
  const actor: Actor = run.source === 'agent' && run.agentId ? agentActor(run.agentId) : run.source === 'assistant' ? 'assistant' : 'outside'
  const facts = FactStore.forBoard(b.ws, { project: b.project, key: b.project })
  // Written only while the card is still there, its project's, and (None) its declaration the one the end read.
  const written = await boardWrite(b.ws, async () => {
    if (!cardOf(b)) return false
    if (endPaths && JSON.stringify(declaredPaths(b.ws, b.project, b.for.card)) !== JSON.stringify(endPaths)) return false
    facts.tx((tx) => tx.append(b.for.card, { kind: 'CheckRan', actor, source: 'recorded', data }))
    return true
  })
  if (!written) return null
  // A failed check its card's rules require before Review (#1279): its row says it blocks review, until seen.
  const wf = data.result !== 'passed' && b.ws.path ? await workflowFor(b.ws, join(b.ws.path, b.project)).catch(() => null) : null
  const gate = wf ? await boardWrite(b.ws, async () => (cardOf(b) ? blocks(wf, facts.card(b.for.card), data) : null)).catch(() => null) : null
  return { ...data, platform: b.for.platform, ...(gate ? { blocks: gate } : {}) }
}

/** Brackets read at resolve (before cw-progress starts the command), by the link it gave out, until their start. */
const resolved = new Map<string, { b: Bracket; at: number }>()

/** A bracket read when resolve gave out `linkId`: its start takes it (`takeResolved`) within LINK_TTL_MS. */
export function bracketResolved(linkId: string, b: Bracket, now = Date.now()): void {
  for (const [id, e] of resolved) if (e.at < now - LINK_TTL_MS) resolved.delete(id)
  while (resolved.size >= MAX_OPEN) resolved.delete(resolved.keys().next().value!)
  resolved.set(linkId, { b, at: now })
}

/** The bracket read at resolve for a link its start passed back (only after the link itself was taken, by its owner). */
export function takeResolved(linkId: unknown): Bracket | null {
  if (typeof linkId !== 'string') return null
  const e = resolved.get(linkId)
  resolved.delete(linkId)
  return e?.b ?? null
}
