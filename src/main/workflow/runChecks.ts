// Runs as checks (#1222, SPEC §16.13): a progress run that names a card (and, on Git, what was checked out) brackets its
// command: what Hive reads when it starts (before hive-progress runs the command) and when it finishes. Its end writes
// `CheckRan` in the card's facts, counted only if every rule holds, else with why not:
// - it was started as a check (`--check`: the project's command for that name ran), or its command is exactly a
//   configured one (`notCheck`);
// - Git: what it ran on contains the card's revision: is it, for a card with its own line or no facts yet; has it as an
//   ancestor in a shared folder (`notContained`); the folder clean at the start and the end (`dirty`) and at the same
//   checkout (`moved`);
// - nothing changed in between: the watcher's write log (platform/observe.ts) saw no write to a file git doesn't
//   ignore, no HEAD reflog entry, no agent's edit hook in the folder (`changed`); a folder the watcher has no complete
//   record of falls back to stat snapshots of its tracked files and the reflog, taken at the start and the end;
// - None: the card's declared paths hash to the same revision at the start and the end (`revisionChanged`), and no
//   deliverable was written in between (`changed`).
// Nothing gates on it in P3: the card's facts and the run's details say it.

import { join } from 'path'
import { boardWrite, hasCard } from '../boardStore'
import { git } from '../git'
import { getTask } from '../tasks'
import type { WorkspaceService } from '../workspace'
import { projectPlatform } from '../platform/registry'
import * as G from '../platform/git'
import { NoneAdapter } from '../platform/none'
import { observer as appObserver, type FolderChanges } from '../platform/observe'
import { isUnknown, type Maybe } from '../platform/types'
import { snapshot } from './checks'
import { cardFacts } from './cardWork'
import { FactStore } from './factStore'
import { folderHead, LINK_TTL_MS, type RunLink } from './runLink'
import type { ProgressRun, ProjectConfig } from '../../shared/types'
import type { PlatformId } from '../../shared/platform/descriptors'
import { agentActor, foldCard, type Actor, type CheckRanData, type Fact } from '../../shared/workflow/facts'

/** What a run is for, as Hive knows it when the run starts. */
export interface CheckRunFor {
  card: number
  /** The folder it runs in (Git), or the project's (None). */
  folder: string
  /** The card's project's folder (its repository, for ancestry). */
  project: string
  platform: PlatformId
  /** Git: what was checked out when it started, read by Hive (runLink), and the revision it names (the same). */
  tested: string | null
  /** The check it was started as (`--check`), or null. */
  check: string | null
  /** Its command line, as its reporter said at its finish (a run without `--check` counts only if it is exactly a configured one). */
  command: string | null
  /** The project's configured check commands, by name. */
  commands: Record<string, string>
  /** The card's facts (its revision in a shared folder: its newest attributed commit). */
  facts: readonly Fact[]
  /** None: the card's declared paths. */
  paths: string[]
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
  /** The stat snapshot: what decides where the watcher's record of the run isn't complete. */
  snapshot: string
  /** None: the card's paths' revision. */
  revision: string | null
}

/** Git's tracked files and git dir, for a stat snapshot. */
async function tracked(folder: string): Promise<{ files: string[]; gitDir: string | null }> {
  const ls = await git(folder, ['ls-files', '-z'])
  const gd = await git(folder, ['rev-parse', '--absolute-git-dir'])
  return { files: ls.ok ? ls.out.split('\0').filter(Boolean) : [], gitDir: gd.ok ? gd.out.trim() : null }
}

/** A list read, or none where it couldn't be. */
const known = (l: Maybe<string[]>): string[] => (isUnknown(l) ? [] : l)

/** None's revision of the card's paths, and its hasher (for the deliverables). */
function noneOf(r: CheckRunFor): NoneAdapter {
  return new NoneAdapter(r.project)
}

/** Reads what a run is checked against, before its command starts. */
export async function checkStart(r: CheckRunFor, log: WriteLog = appObserver, now: () => number = Date.now): Promise<CheckStart> {
  // What was written before it started is in the write log first (its events come in after their writes); then the
  // start is taken before the rest is read: a write meanwhile counts against the run (the safe side).
  await log.settled(r.folder)
  const t0 = now()
  if (r.platform === 'none') {
    const none = noneOf(r)
    const rev = none.revision(r.paths)
    return { t0, dirty: null, snapshot: await snapshot(r.project, known(none.deliverables()), null), revision: isUnknown(rev) ? null : rev.revision }
  }
  const t = await tracked(r.folder)
  const snap = await snapshot(r.folder, t.files, t.gitDir)
  return { t0, dirty: await G.dirty(r.folder), snapshot: snap, revision: null }
}

/** The card's revision on Git: in a shared folder, its newest attributed commit (else its base); else what the run tested. */
function cardRevision(r: CheckRunFor): string | null {
  const s = foldCard(r.facts)
  if (s.started && s.started.folder === 'project' && s.cycle) return s.attributed.at(-1) ?? s.started.base ?? r.tested
  return r.tested
}

/** The configured check a run's command is exactly, if any. */
function checkByCommand(r: CheckRunFor): string | null {
  const command = r.command?.trim()
  return command ? (Object.entries(r.commands).find(([, c]) => c === command)?.[0] ?? null) : null
}

/** The `CheckRan` a finished run writes: counted, or not and why. */
export async function checkEnd(r: CheckRunFor, start: CheckStart, end: { at: number; result: CheckRanData['result']; run: string; by: string; title: string }, log: WriteLog = appObserver): Promise<CheckRanData> {
  const named = r.check ?? checkByCommand(r)
  const base = { name: named ?? end.title, command: (named && r.commands[named]) || r.command || '', run: end.run, durationMs: Math.max(0, end.at - start.t0), by: end.by, result: end.result }
  let whyNot: CheckRanData['whyNot']
  if (r.platform === 'none') {
    const none = noneOf(r)
    const after = none.revision(r.paths)
    const seen = await log.changedBetween(r.folder, start.t0, end.at, (written) => written.filter((f) => none.isDeliverable(f)))
    const snapB = isUnknown(seen) ? await snapshot(r.project, known(none.deliverables()), null) : null
    const tested = isUnknown(after) ? '' : after.revision
    if (!named) whyNot = 'notCheck'
    else if (start.revision === null || isUnknown(after) || start.revision !== after.revision) whyNot = 'revisionChanged'
    else if (isUnknown(seen) ? start.snapshot !== snapB : seen.changed) whyNot = 'changed'
    return { ...base, revision: start.revision ?? '', tested, counted: !whyNot, ...(whyNot ? { whyNot } : {}) }
  }
  const tested = r.tested ?? ''
  const revision = cardRevision(r) ?? tested
  const seen = await log.changedBetween(r.folder, start.t0, end.at)
  let snapB: string | null = null
  if (isUnknown(seen)) {
    const t = await tracked(r.folder)
    snapB = await snapshot(r.folder, t.files, t.gitDir)
  }
  const dirtyB = await G.dirty(r.folder)
  const headB = await folderHead(r.folder)
  const contained = !!tested && (revision === tested || (await G.isAncestor(r.project, revision, tested)) === true)
  const isDirty = (d: Maybe<string[]> | null): boolean => d === null || isUnknown(d) || d.length > 0
  if (!named) whyNot = 'notCheck'
  else if (!contained) whyNot = 'notContained'
  else if (isDirty(start.dirty) || isDirty(dirtyB)) whyNot = 'dirty'
  else if (headB !== tested) whyNot = 'moved'
  else if (isUnknown(seen) ? start.snapshot !== snapB : seen.changed) whyNot = 'changed'
  return { ...base, revision, tested, counted: !whyNot, ...(whyNot ? { whyNot } : {}) }
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
  const cfg = (await ws.projectConfig(project).catch(() => null)) as (ProjectConfig & { workflow?: { options?: { commands?: Record<string, unknown> } } }) | null
  const platform = projectPlatform(project, cfg?.platform).id
  if (platform === 'git' && (!link.folder || !link.testedCheckout)) return null
  const commands = Object.fromEntries(Object.entries(cfg?.workflow?.options?.commands ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1].trim()).map(([k, v]) => [k, v.trim()]))
  const paths = platform === 'none' ? (FactStore.forBoard(ws, { project: c.project, key: c.project }).card(link.card).paths ?? []) : []
  const f: CheckRunFor = { card: link.card, folder: platform === 'none' ? project : link.folder!, project, platform, tested: link.testedCheckout, check: link.check?.name ?? null, command: null, commands, facts: got.facts, paths }
  return { ws, workspacePath, project: c.project, for: f, start: await checkStart(f) }
}

/** The run a bracket is for has started. */
export function bracketStarted(runId: string, b: Bracket): void {
  while (open.size >= MAX_OPEN) open.delete(open.keys().next().value!)
  open.set(runId, b)
}

/**
 * A run finished: its `CheckRan`, written in its card's facts inside a board change, or null when it wasn't bracketed,
 * didn't end with a result, or its workspace or card has gone meanwhile.
 */
export async function bracketFinished(run: ProgressRun): Promise<CheckRanData | null> {
  const b = open.get(run.id)
  open.delete(run.id)
  if (!b || run.finishedAt === null || (run.state !== 'passed' && run.state !== 'failed' && run.state !== 'stopped')) return null
  // Its command as its reporter said (hive-progress: the check's command, or its command line).
  const data = await checkEnd({ ...b.for, command: run.command }, b.start, { at: run.finishedAt, result: run.state, run: run.id, by: run.agentName, title: run.title })
  if (b.ws.path !== b.workspacePath) return null
  const actor: Actor = run.source === 'agent' && run.agentId ? agentActor(run.agentId) : run.source === 'assistant' ? 'assistant' : 'outside'
  const facts = FactStore.forBoard(b.ws, { project: b.project, key: b.project })
  await boardWrite(b.ws, async () => {
    if (!hasCard(b.ws, b.for.card)) return
    facts.tx((tx) => tx.append(b.for.card, { kind: 'CheckRan', actor, source: 'recorded', data }))
  })
  return data
}

/** Brackets read at resolve (before hive-progress starts the command), by the link it gave out, until their start. */
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
