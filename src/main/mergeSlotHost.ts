import { app } from 'electron'
import { basename, join, resolve } from 'path'
import { appendFileSync, existsSync } from 'original-fs'
import { readFile } from 'original-fs/promises'
import type { MergeSlotInfo } from '../shared/types'
import { emit, toast } from './events'
import { hashText, withFileLock, writeTextAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { MergeSlots, parseSlotRecords, type ClaimResult, type ReleaseResult, type SlotAgent, type SlotRecord } from './mergeSlots'
import { setUserMergeSlot } from './projectAgents'
import { progress } from './progressService'
import { sessions } from './sessions'
import { workspace, workspaceFor, workspaceOf, type WorkspaceService } from './workspace'
import { keepBeforeIds } from './beforeIds'
import { rebase, samePath } from '../shared/movePaths'
import { NO_PROJECT_IDS, type ProjectIdIndex } from '../shared/projectIds'
import { devConsole, hiveSourceId, sessionSourceId } from './devConsole'
import { hiveName, safeWord } from '../shared/devConsole'
import { addLeftMerge } from './lastRun'
import { cardNamesOf } from './projectKeys'
import { fmt, msg, tr } from '../shared/i18n'
import { cardRef } from '../shared/projectKeys'
import { CW_DIR } from '../shared/defaults'
import { LEGACY_HIVE_DIR } from '../shared/hiveFolderMove'
import { movedPath } from './combworkMove'

const M = {
  leftTitle: msg({ id: 'main.mergeSlot.leftTitle', defaultMessage: '{agent} was merging when Combwork closed', description: "A notice's title as a workspace opens: the agent {agent} (its name) held the merge slot when Combwork last closed, so its merge may be half done." }),
  leftBody: msg({ id: 'main.mergeSlot.leftBody', defaultMessage: 'It held the merge slot for {branch}{hasCards, select, yes { ({cards})} other {}}. Check {folder} for a merge left half done (git status there) before the next merge.', description: "The notice that an agent was merging when Combwork closed: {branch} is the branch it held the slot for, {cards} the cards it named (\"#7, #9\"; shown when {hasCards} is yes), {folder} where the merge was. 'git status' is a command: keep it." }),
  leftBodyGone: msg({ id: 'main.mergeSlot.leftBodyGone', defaultMessage: "It held the merge slot for {branch}{hasCards, select, yes { ({cards})} other {}} in {project}, a project this workspace no longer has (its folder is another project's now, or gone). Check {folder} for a merge left half done (git status there) before the next merge.", description: "The notice that an agent was merging when Combwork closed, in a project ({project}, its name) the workspace no longer has: {branch} is the branch it held the slot for, {cards} the cards it named (\"#7, #9\"; shown when {hasCards} is yes), {folder} where the merge was. 'git status' is a command: keep it." })
}

const log = createLogger('mergeSlots')

/**
 * The app's merge slots (#350), wired to sessions (a launch's end releases its hold; status notes), Progress (a holder
 * still reporting keeps its hold), the windows (`merge-slots-changed`) and a small record per workspace in the app's
 * data (this machine's state, never the workspace's committed `.combwork`), so a hold Hive closed under is reported when
 * the workspace opens again.
 */
export const mergeSlots = new MergeSlots({
  now: () => Date.now(),
  running: (a) => sessions.liveFor(a.projectPath, a.agentId)?.runId === a.runId,
  progressAt: (a) => progress.openRunOf(a.projectPath, a.agentId)?.updatedAt ?? null,
  changed: (projectPath) => changed(projectPath),
  note: (a, text, about) => sessions.setMergeSlotNote(a.projectPath, a.agentId, a.runId, text, about),
  warn: (projectPath, title, message) => toast('warning', title, message, undefined, projectPath),
  // Test builds can shorten a hold, to see one run out (CW_TEST_MERGE_HOLD_MS; never in an installed Hive).
  ...(!app.isPackaged && Number(process.env.CW_TEST_MERGE_HOLD_MS) > 0 ? { holdMs: Number(process.env.CW_TEST_MERGE_HOLD_MS) } : {})
})

/** A workspace's record of its agents' holds. */
const recordFile = (workspacePath: string): string => join(app.getPath('userData'), 'merge-slots', `${hashText(workspacePath.toLowerCase())}.json`)

/** A workspace's slots (each of its projects'), for its window and the Agent API. */
export function workspaceSlots(workspacePath: string): MergeSlotInfo[] {
  return mergeSlots.list(workspacePath)
}

/** The workspace a project belongs to, or null when none open has it. */
function workspacePathOf(projectPath: string): string | null {
  try {
    return workspaceOf(projectPath).path
  } catch {
    return null
  }
}

function changed(projectPath: string): void {
  const ws = workspacePathOf(projectPath)
  if (!ws) return
  emit({ type: 'merge-slots-changed', workspacePath: ws, slots: workspaceSlots(ws) })
  void save(ws).catch((e) => log.warn('saving the merge slots', e))
  testLog(ws)
  // The developer console (#636): who holds the project's slots and who waits, as they change.
  devConsole.capture([hiveSourceId(ws)], () => {
    const slots = workspaceSlots(ws).filter((s) => s.project.toLowerCase() === basename(projectPath).toLowerCase())
    const made = slots.map((s) => ({ branch: s.branch, holder: s.holder && { agentId: s.holder.agentId ?? null, name: s.holder.name, cards: s.holder.cards }, waiting: s.waiting.map((w) => w.name) }))
    const line = slots.slice(0, 5).map((s) => `${safeWord(s.branch)}: ${s.holder ? `held by ${hiveName(s.holder.name)}` : 'free'}${s.waiting.length ? `, ${s.waiting.length} waiting` : ''}`).join('; ') // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
    return { kind: 'merge-slot', name: 'slots changed', raw: { project: basename(projectPath) }, made, safe: { raw: { project: true }, made: { branch: true, holder: { agentId: true, name: true }, waiting: true } }, summary: `merge slot ${hiveName(basename(projectPath))} → ${line || 'free'}` } // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
  })
}

/**
 * Test builds only (CW_TEST_MERGE_SLOT_LOG, never in an installed Hive): each change to a workspace's slots, a JSON
 * line with its time, so a scenario sees who held a slot and who waited when, not only the claims made (#374).
 */
function testLog(workspacePath: string): void {
  const slots = workspaceSlots(workspacePath).map((s) => ({ project: s.project, branch: s.branch, holder: s.holder && { agentId: s.holder.agentId ?? null, name: s.holder.name, cards: s.holder.cards, taken: s.holder.taken }, waiting: s.waiting.map((w) => w.name) }))
  writeTestLog({ at: new Date().toISOString(), slots })
}

/**
 * An agent's claim or release as it ended, with the branch it resolved to (a call naming none takes the project folder's)
 * and what it did: held or in line; released, left the line, or nothing to release. Test builds log it (the same log,
 * #374), so a scenario tells the agent's own release from a hold that ended otherwise (its session's end, the user); the
 * developer console shows it (#636).
 */
export function slotTestEvent(agent: SlotAgent, projectPath: string, branch: string, result: ClaimResult | ReleaseResult): void {
  const outcome = 'held' in result ? (result.held ? 'held' : 'in line') : 'released' in result ? 'released' : 'left' in result ? 'left' : 'none' // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
  const ws = workspacePathOf(projectPath)
  const event = 'held' in result ? 'claim' : 'release'
  devConsole.capture([ws && hiveSourceId(ws), sessionSourceId(projectPath, agent.agentId)], () => ({ kind: 'merge-slot', name: event, raw: { project: basename(projectPath), branch, agent: agent.agentName }, made: { outcome }, safe: { raw: { project: true, branch: true, agent: true }, made: { outcome: true } }, summary: `merge slot ${event} by ${hiveName(agent.agentName)} on ${safeWord(branch)} → ${outcome}` })) // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
  writeTestLog({ at: new Date().toISOString(), event: 'held' in result ? 'claim' : 'release', project: projectPath, branch, agentId: agent.agentId, agent: agent.agentName, outcome })
}

function writeTestLog(line: object): void {
  const file = !app.isPackaged ? process.env.CW_TEST_MERGE_SLOT_LOG : undefined
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify(line) + '\n')
  } catch {
    // A test log that can't be written changes nothing.
  }
}

/** The record of this workspace's agents' holds, rewritten whole under its lock as it changes. */
async function save(workspacePath: string): Promise<void> {
  const file = recordFile(workspacePath)
  await withFileLock(file, async () => {
    await writeTextAtomic(file, JSON.stringify({ version: 1, holds: heldIn(workspacePath) }, null, 2) + '\n')
  })
}

/** This workspace's agents' holds, each with its project's stable id (#508), so one told after a rename names the project now. */
function heldIn(workspacePath: string): SlotRecord[] {
  return mergeSlots.heldByAgents().flatMap((h) => {
    let ws: ReturnType<typeof workspaceOf>
    try {
      ws = workspaceOf(h.projectPath)
    } catch {
      return []
    }
    if (ws.path?.toLowerCase() !== workspacePath.toLowerCase()) return []
    const projectId = ws.projectIdsNow().byPath.get(h.projectPath.toLowerCase())
    // Where its agent merges (#984): its worktree, or the main checkout.
    const cwd = sessions.liveFor(h.projectPath, h.agentId)?.cwd
    return [{ ...h, ...(projectId ? { projectId } : {}), ...(cwd ? { cwd } : {}) }]
  })
}

/**
 * Where a hold Hive closed under belongs now (#508): its project's folder by its id (renamed or moved since, the whole
 * workspace too); one saved before ids, at its folder (under the workspace's folder now, if the workspace moved), or at
 * the project last opened there (project.json's lastPath, #146) when exactly one was. Null when it can't be known: its
 * project is gone, or another project has its folder (never told as that one's).
 */
async function placeHold(ws: WorkspaceService, ids: ProjectIdIndex, from: string | null, h: SlotRecord): Promise<string | null> {
  const now = h.projectId ? ids.byId.get(h.projectId) : undefined
  if (now) return now
  const moved = (p: string): string => (from && ws.path ? (rebase(p, from, ws.path) ?? p) : p)
  const at = moved(h.projectPath)
  const here = ids.byPath.get(resolve(at).toLowerCase())
  if (here) return h.projectId ? null : at
  if (h.projectId) return null
  const was: string[] = []
  for (const p of ids.byId.values()) {
    const last = (await ws.projectConfig(p).catch(() => null))?.lastPath
    if (last && samePath(moved(last), at)) was.push(p)
  }
  return was.length === 1 ? was[0] : null
}

/** Holds that couldn't be placed (#508), kept beside the record (the latest few) rather than lost once they're told. */
const MAX_UNPLACED = 50
async function keepUnplaced(file: string, holds: SlotRecord[]): Promise<void> {
  const kept = `${file.replace(/\.json$/, '')}.unplaced.json`
  const had = parseSlotRecords((await readFile(kept, 'utf8').catch(() => null)) ?? '')
  await writeTextAtomic(kept, JSON.stringify({ version: 1, holds: [...had, ...holds].slice(-MAX_UNPLACED) }, null, 2) + '\n')
}

/** The record's holds that Hive no longer has, taken from it: kept as it was beside it first (once) when any is placed elsewhere. */
async function orphansIn(file: string, workspacePath: string | null, place: (h: SlotRecord) => Promise<string | null>): Promise<{ hold: SlotRecord; at: string | null }[]> {
  return withFileLock(file, async () => {
    const raw = await readFile(file, 'utf8').catch(() => null)
    if (raw === null) return []
    const live = new Set(mergeSlots.heldByAgents().map((h) => `${h.projectPath.toLowerCase()}#${h.branch}#${h.runId}`))
    const orphans = parseSlotRecords(raw).filter((h) => !live.has(`${h.projectPath.toLowerCase()}#${h.branch}#${h.runId}`))
    const placed = await Promise.all(orphans.map(async (hold) => ({ hold, at: await place(hold) })))
    if (placed.some((p) => !p.at || !samePath(p.at, p.hold.projectPath)) || !workspacePath) await keepBeforeIds(file)
    const unplaced = placed.filter((p) => !p.at).map((p) => p.hold)
    if (unplaced.length) await keepUnplaced(file, unplaced)
    await writeTextAtomic(file, JSON.stringify({ version: 1, holds: workspacePath ? heldIn(workspacePath) : [] }, null, 2) + '\n')
    return placed
  })
}

/**
 * Tests only (unpackaged builds): CW_TEST_HOLD_MERGE_RECOVERY=<file> holds the recovery until that file exists, so a
 * suite can show what waits for it (#984: the notice that Hive closed unexpectedly).
 */
async function testHold(): Promise<void> {
  const file = !app.isPackaged ? process.env.CW_TEST_HOLD_MERGE_RECOVERY : undefined
  if (!file) return
  log.info('Merge slot recovery held until the test releases it')
  while (!existsSync(file)) await new Promise((r) => setTimeout(r, 100))
}

/**
 * A workspace opened: holds its record has that Hive no longer has (it closed or crashed while an agent held the slot)
 * are told to the user, since that merge may be half done, and dropped from the record. Each is told in its project
 * now (#508), and so are the holds recorded where the workspace was before it moved (its record is by its folder) when
 * nothing is there now; one whose project can't be known is told in the workspace, and kept beside the record.
 */
export async function recoverMergeSlots(workspacePath: string): Promise<void> {
  await testHold()
  const ws = workspaceFor(workspacePath)
  const ids = (await ws?.projectIds({ fresh: true })) ?? NO_PROJECT_IDS
  const last = ws?.movedFrom
  const from = last && !existsSync(join(last, CW_DIR)) && !existsSync(join(last, LEGACY_HIVE_DIR)) && !workspaceFor(last) ? last : null
  const place = (h: SlotRecord): Promise<string | null> => (ws ? placeHold(ws, ids, from, h) : Promise.resolve(h.projectPath))
  const gone = [...(await orphansIn(recordFile(workspacePath), workspacePath, place)), ...(from ? await orphansIn(recordFile(from), null, place) : [])]
  // Each hold's cards as this workspace names them (HI-1661: by key); this runs outside any workspace's work.
  const named = ws ? cardNamesOf(ws) : cardRef
  for (const { hold: h, at } of gone) {
    log.info(`Merge slot: Combwork closed while ${userText(h.agentName)} held it for ${userText(h.branch)}`)
    // The folder the merge was in (#984): the agent's own (its worktree), else the project's main checkout.
    // A folder inside a .hive that moved to .combwork since (HI-2462) is named where it is now.
    const folder = (h.cwd ? await movedPath(workspacePath, h.cwd) : null) ?? h.cwd ?? at ?? h.projectPath
    // After an unexpected close, told in that notice (lastRun.ts).
    if (at && addLeftMerge({ agentName: h.agentName, branch: h.branch, cards: h.cards, cardNames: h.cards.map(named), folder })) continue
    const values = { branch: h.branch, hasCards: h.cards.length ? 'yes' : 'no', cards: fmt.list(h.cards.map(named), 'unit'), folder }
    const body = at ? tr(M.leftBody, values) : tr(M.leftBodyGone, { ...values, project: basename(h.projectPath) })
    toast('warning', tr(M.leftTitle, { agent: h.agentName }), body, undefined, at ?? workspacePath)
  }
}

let started = false

/** Releases holds with their launches, and has the Merge dialog's merges hold the slot. Once, at startup (a workspace's record is recovered as it opens: ipc.ts). */
export function startMergeSlots(): void {
  if (started) return
  started = true
  sessions.onLaunchEnded.add((projectPath, agentId, runId) => mergeSlots.sessionEnded(projectPath, agentId, runId))
  // The Merge dialog's merges hold the slot too.
  setUserMergeSlot((projectPath, branch, run) => mergeSlots.asUser(projectPath, branch, run))
}

/** The branch a project folder is on: what Hive's Merge dialog merges into, and the slot a claim names by default. */
export async function currentBranch(projectPath: string): Promise<string | null> {
  return workspace.branch(projectPath)
}
