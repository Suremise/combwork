import { randomBytes } from 'crypto'
import { join } from 'path'
import { existsSync } from 'original-fs'
import { HIVE_DIR, projectAgents } from '../shared/defaults'
import { allDone, isFrozen, loopDefaults, keptLanes, laneView, listedLanes, readLanes, running, type LaneAgent, type LaneCardFacts, type LaneChange, type LaneRecord } from '../shared/lanes'
import type { HiveErrorKind, LaneCard, LaneInfo, TaskCard } from '../shared/types'
import { withValues, type Text } from '../shared/advanced'
import { msg } from '../shared/i18n'
import { HiveError } from './hiveError'
import { onHiveEvent } from './events'
import { readFile } from 'original-fs/promises'
import { renameRetrying, withFileLock } from './fsutil'
import { openTable, readTable, saveTable } from './storeTables'
import { boardOpen, boardWrite, cardPlacesNow, dbGeneration, onDbReplaced, upgradeWaiting } from './boardStore'
import { FactStore } from './workflow/factStore'
import { onAction } from './workflow/actionWorker'
import { foldCard, forYou } from '../shared/workflow/facts'
import { createDelivery, offerNow } from './deliveries'
import { isProjectId, projectIdNamed, projectNameOf, projectNow, savedProjectName } from '../shared/projectIds'
import { coalesced } from './coalesce'
import { createLogger, userText } from './logger'
import { getTask, inScope } from './tasks'
import { journalFact } from './journalService'
import { openWorkspaces, type WorkspaceService } from './workspace'
import { cardRef } from '../shared/projectKeys'
import { withCardNames } from './projectKeys'
import { roundLimitCards } from './workflow/cardWork'
import { rulesEnforced } from './workflow/recorder'

const log = createLogger('lanes')

/**
 * Lanes (#483): the card loops a workspace runs, kept in its `.hive/lanes.json` beside the board. The builder's card-loop
 * registers its lane (start), the reviewer's joins it by the builder's name, the Assistant can start one when it briefs
 * a pair. Hive follows the board for the rest: a lane is paused while its current card is blocked, ends when every card
 * is Done (or its builder ends it after the merge), and is abandoned when its builder or reviewer is removed.
 *
 * Bookkeeping, never a gate: nothing here refuses or holds up work on a card, and a loop with no lane runs as before.
 * Changes to a workspace's lanes happen under their lock, read and written whole. They are kept in the workspace database
 * (#1212: a row a lane in its typed tables, storeTables.ts), moved in from `.hive/lanes.json` the first time.
 */

/** The lanes' file before #1018 (moved in at the first open, then kept as a backup); its path is also the lanes' lock. */
const fileOf = (ws: WorkspaceService): string => join(ws.hiveDir, 'lanes.json')
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

const KINDS: Record<number, HiveErrorKind> = { 400: 'invalid', 403: 'forbidden', 404: 'notFound', 409: 'conflict' }

/**
 * A lane change Hive refuses (status: the HTTP status the Agent API answers with). Most come only from agents (hive_lane),
 * in English; one the window can meet too (Progress → Lanes: ending a lane) is text, in its language there (#850).
 */
export class LaneError extends HiveError {
  constructor(
    readonly status: number,
    message: string | Text
  ) {
    // An agent's refusal, English only: its words as they are, in every language.
    super(typeof message === 'string' ? { lines: [message] } : message, KINDS[status] ? { kind: KINDS[status] } : undefined)
  }
}

/** Refusals the window can meet (ending a lane from Progress → Lanes), in its language. */
const M = {
  noWorkspace: msg({ id: 'service.lanes.noWorkspace', defaultMessage: 'No workspace is open', description: "An error changing a workspace's lanes (card loops) while no workspace is open in the window." }),
  unknown: msg({ id: 'service.lanes.unknown', defaultMessage: 'Unknown lane {id}', description: 'An error: there is no lane (a card loop) with the id {id}, perhaps removed meanwhile.' })
}

/** Each lane's project id as it was read, so a lane whose project the workspace doesn't have now keeps it. */
const readIds = new WeakMap<LaneRecord, string>()

/**
 * A workspace's lanes; each names its project by its stable id too (#508): its project is the one that has the id now
 * (projectNow), and a lane saved before ids has its name only.
 */
async function read(ws: WorkspaceService): Promise<LaneRecord[]> {
  const gen = dbGeneration(ws.path!)
  const data = await savedLanes(ws)
  const raw = data && typeof data === 'object' && Array.isArray((data as { lanes?: unknown }).lanes) ? ((data as { lanes: unknown[] }).lanes as Record<string, unknown>[]) : []
  const seen = JSON.stringify(raw)
  // Listed now: the cards read against these lanes next see the same projects (a lane and its cards agree).
  const ids = await ws.projectIds({ fresh: true })
  const idOf = new Map<string, string>()
  for (const v of raw) {
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !isProjectId(v.projectId)) continue
    idOf.set(v.id, v.projectId)
    if (typeof v.project === 'string') v.project = projectNow(ids, v.project, v.projectId)
  }
  const lanes = readLanes(data)
  for (const l of lanes) if (idOf.has(l.id)) readIds.set(l, idOf.get(l.id)!)
  readGens.set(lanes, gen)
  readAs.set(lanes, seen)
  return lanes
}

/** The workspace database's generation each list was read in (#1207 round 2): written back only into that one. */
const readGens = new WeakMap<LaneRecord[], number>()

/**
 * The lanes each list was read from, as saved (HR6's #1270 round 4): written back only while the tables still hold
 * them, checked under the board's lock. The runtime writes the lanes too (a queued list applied at a card's start), so a
 * list read before that is never saved over it: the save is refused (StaleLane) and decided again from a fresh read.
 */
const readAs = new WeakMap<LaneRecord[], string>()

/** Workspaces whose lanes were opened (moved in from lanes.json, the first time) since Hive started. */
const opened = new Set<string>()
// The database replaced (the upgrade to 1.0, a restore): lanes.json is looked for again (its move may have waited).
onDbReplaced((workspacePath) => opened.delete(workspacePath.toLowerCase()))

/**
 * lanes.json from before #1018, read to move it in (#1018 round 1): null only when there is none. One that can't be read
 * now (Windows holding it, no permission) is an error, so nothing is marked moved and the next open tries again; one that
 * isn't JSON lanes is set aside (`lanes.json.damaged-<time>`, renamed, never deleted) and none are moved in, or, if it
 * can't be set aside, that is an error too and it is left as it is.
 */
export async function readLanesFile(file: string): Promise<{ docs: unknown[] } | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`Could not read the lanes (${(e as Error).message})`, { cause: e }) // i18n-ignore: a system error moving lanes.json in, logged; as the watches' and deliveries' own
  }
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    v = null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v) || ((v as { lanes?: unknown }).lanes !== undefined && !Array.isArray((v as { lanes?: unknown }).lanes))) {
    const to = `${file}.damaged-${Date.now()}`
    try {
      await renameRetrying(file, to)
    } catch (e) {
      throw new Error(`The lanes file is damaged and couldn't be set aside (${(e as Error).message}): it was left as it is`, { cause: e }) // i18n-ignore: as above
    }
    log.warn(`The lanes file was damaged: set aside as ${userText(to)}`)
    return { docs: [] }
  }
  return { docs: (v as { lanes?: unknown[] }).lanes ?? [] }
}

/**
 * The lanes as saved, in the form lanes.json had (`{ version, lanes }`): the workspace database's tables, after moving
 * the file in the first time (#1018, #1212). Read under the lanes' lock.
 */
async function savedLanes(ws: WorkspaceService): Promise<{ version: 1; lanes: Record<string, unknown>[] }> {
  const path = ws.path!
  const key = path.toLowerCase()
  const file = fileOf(ws)
  const data = opened.has(key)
    ? readTable(path, 'lanes')
    : await openTable(path, 'lanes', file, () => readLanesFile(file))
  // While the upgrade to 1.0 waits nothing was moved in: looked for again once it is upgraded.
  if (!upgradeWaiting(path)) opened.add(key)
  return { version: 1, lanes: data.docs as Record<string, unknown>[] }
}

/** The lanes as saved: each with its project's id beside its name (the id it had, for a project the workspace doesn't have now). */
/**
 * Told as soon as a workspace's lanes are written, before the settled `lanes-changed` event (300 ms later): a lane's
 * reviewer decides who a loop wake goes to, and a wake being typed checks that nothing changed meanwhile (#578 round 2:
 * one typed to a reviewer taken off the lane inside that window).
 */
const writtenListeners = new Set<() => void>()
export function onLanesWritten(fn: () => void): () => void {
  writtenListeners.add(fn)
  return () => writtenListeners.delete(fn)
}

async function write(ws: WorkspaceService, lanes: LaneRecord[], check?: () => void): Promise<void> {
  const ids = await ws.projectIds()
  const stamped = keptLanes(lanes, Date.now()).map((l) => {
    const saved = savedProjectName(l.project)
    const projectId = (saved === l.project ? projectIdNamed(ids, saved) : null) ?? readIds.get(l)
    const { id, project: _shown, ...rest } = l
    return { id, project: saved, ...(projectId ? { projectId } : {}), ...rest }
  })
  // Read from a database since replaced (the upgrade to 1.0, a restore): never written over the file as it is now.
  const gen = readGens.get(lanes)
  const seen = readAs.get(lanes)
  const path = ws.path!
  await saveTable(path, 'lanes', stamped, {}, () => {
    if (gen !== undefined && gen !== dbGeneration(path)) throw new Error("the workspace's database was replaced since these lanes were read: nothing was saved") // i18n-ignore: a save refused as a mistake's error, for the log
    // Another writer (the runtime, #1270) changed the lanes since they were read: nothing is saved over it.
    if (seen !== undefined && boardOpen(path) && JSON.stringify(readTable(path, 'lanes').docs) !== seen) throw new StaleRead('the lanes changed since they were read') // i18n-ignore: internal, caught and retried (never shown)
    // Under the board's lock, with nothing awaited before the save: what a decision read of the cards still holds.
    check?.()
  })
  for (const fn of writtenListeners) fn()
}

/**
 * Each lane names its project by id too (#508), once, when the workspace opens: those saved before ids whose name is a
 * project get its id, and those whose project was renamed since its name now (lanes.json, from before, is kept as the
 * database's import backup, #1018). Lanes under a name no project has are left as they are (Repair:
 * moveOrphanLanes). Changes nothing the second time. Returns how many lanes changed.
 */
export async function stampLaneProjects(ws: WorkspaceService): Promise<number> {
  if (!ws.path) return 0
  const file = fileOf(ws)
  const n = await readAgain(() => withFileLock(file, async () => {
    const before = await savedLanes(ws)
    if (!before.lanes.length) return 0
    const lanes = await read(ws)
    const ids = await ws.projectIds()
    const names = new Map(lanes.map((l) => [l.id, l.project]))
    const changing = (before.lanes as Record<string, unknown>[]).filter((v) => {
      if (!v || typeof v !== 'object' || typeof v.project !== 'string') return false
      if (isProjectId(v.projectId)) return names.get(v.id as string) !== v.project && !!projectNameOf(ids, v.projectId)
      return !!projectIdNamed(ids, v.project)
    }).length
    if (!changing) return 0
    await write(ws, lanes)
    return changing
  }))
  if (n) {
    log.info(`${n} lane(s) now name their project by its id`)
    changed(ws)
  }
  return n
}

/**
 * Repair (#508): lanes saved before ids under a project's old name go to the project they belong to now, with its id.
 * In lanes.json's lock, read again there; one with an id, or under another name now, is left as it is. Returns how many.
 */
export async function moveOrphanLanes(ws: WorkspaceService, m: { from: string; to: string }): Promise<number> {
  if (!ws.path) return 0
  const file = fileOf(ws)
  const n = await readAgain(() => withFileLock(file, async () => {
    const lanes = await read(ws)
    const moving = lanes.filter((l) => !readIds.has(l) && same(l.project, m.from))
    if (!moving.length) return 0
    for (const l of moving) {
      l.project = m.to
      l.updatedAt = now()
    }
    await write(ws, lanes)
    return moving.length
  }))
  if (n) {
    log.info(`Repair gave ${n} lane(s) of ${userText(m.from)} to ${userText(m.to)}`)
    changed(ws)
  }
  return n
}

/** The lanes saved before ids (#508), as Repair weighs whose they are: their project's name and their agents. */
export async function legacyLanes(ws: WorkspaceService): Promise<{ name: string; agents: string[] }[]> {
  return (await read(ws)).filter((l) => !readIds.has(l)).map((l) => ({ name: l.project, agents: [l.builder.id, ...(l.reviewer ? [l.reviewer.id] : [])] }))
}

/** Changes a workspace's lanes under its lock: fn changes the list it is given (or throws), and says whether it did. */
async function mutate<T>(ws: WorkspaceService, fn: (lanes: LaneRecord[], checks: (() => void)[]) => T | Promise<T>): Promise<T> {
  if (!ws.path) throw new LaneError(409, M.noWorkspace)
  const result = await readAgain(() => withFileLock(fileOf(ws), async () => {
    const lanes = await read(ws)
    const checks: (() => void)[] = []
    const r = await fn(lanes, checks)
    await write(ws, lanes, () => checks.forEach((c) => c()))
    return r
  }))
  changed(ws)
  return result
}

/**
 * Runs a read and its save again while the lanes changed between them (StaleRead: the runtime applied a queued list
 * meanwhile, #1270), a few times; fn starts from its own read each time, so it resets what it gathers.
 */
async function readAgain<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof StaleRead) || attempt >= 4) throw e
    }
  }
}

const now = (): string => new Date().toISOString()
const newId = (): string => `lane-${randomBytes(3).toString('hex')}`

/** A lane's start or end as a fact in the Assistant's journal (#1031): who, which cards, how it ended, its merge. */
function laneFact(ws: WorkspaceService, l: LaneRecord): void {
  const who = `${l.builder.name}${l.reviewer ? ` / ${l.reviewer.name}` : ''}`
  const cards = withCardNames(ws, () => l.cards.map(cardRef).join(', '))
  const what = l.state === 'active' ? 'started' : l.state === 'ended' ? (l.mergeCommit ? `ended, merged at ${l.mergeCommit}` : 'ended') : 'abandoned' // i18n-ignore: a journal fact (the Assistant's, English)
  journalFact(ws, {
    summary: `Lane ${l.name ? `"${l.name}" ` : ''}${what}: ${who}, ${cards}`, // i18n-ignore: a journal fact (the Assistant's, English)
    project: l.project,
    importance: l.mergeCommit ? 2 : 1,
    links: [...l.cards.map((n) => ({ type: 'card' as const, ref: String(n) })), ...(l.mergeCommit ? [{ type: 'commit' as const, ref: l.mergeCommit }] : [])].slice(0, 40),
    tags: ['lane']
  })
}

/**
 * Ends a lane: ended when all its cards are merged (or `merged` says so), else abandoned. `cards`: its cards as they read
 * just now, kept as it was left (#512), when they are still its list (a start may have changed it meanwhile).
 */
function close(l: LaneRecord, state: 'ended' | 'abandoned', cards: readonly LaneCard[] | undefined, mergeCommit?: string | null): void {
  l.state = state
  l.endedAt = l.updatedAt = now()
  if (mergeCommit) l.mergeCommit = mergeCommit
  if (cards && cards.length === l.cards.length && cards.every((c, i) => c.number === l.cards[i])) l.frozen = [...cards]
}

/** The lane cards as the board has them now, each read once, as the lane's project sees them. */
async function cardsOf(ws: WorkspaceService, lanes: readonly LaneRecord[]): Promise<Map<string, Map<number, TaskCard | null>>> {
  const reads = new Map<number, Promise<TaskCard | null>>()
  const out = new Map<string, Map<number, TaskCard | null>>()
  for (const l of lanes) {
    const m = new Map<number, TaskCard | null>()
    out.set(l.id, m)
    // An ended lane reads as it was left: nothing to read.
    if (isFrozen(l)) continue
    for (const n of l.cards) {
      let r = reads.get(n)
      if (!r) reads.set(n, (r = getTask(n, ws).catch(() => null)))
      const card = await r
      m.set(n, card && !card.archived && inScope(card, l.project) ? card : null)
    }
  }
  return out
}

/** Each project's agents' names now, by id (a renamed agent shows its new name). */
async function namesOf(ws: WorkspaceService, lanes: readonly LaneRecord[]): Promise<Map<string, Map<string, string> | null>> {
  const out = new Map<string, Map<string, string> | null>()
  for (const l of lanes) {
    const k = l.project.toLowerCase()
    if (out.has(k) || !ws.path) continue
    // A project not there by that name (renamed a moment ago, or gone) is unknown, not one without agents.
    const p = join(ws.path, l.project)
    const cfg = existsSync(join(p, HIVE_DIR, 'project.json')) ? await ws.projectConfig(p).catch(() => null) : null
    out.set(k, cfg ? new Map(projectAgents(cfg).map((a) => [a.id, a.name])) : null)
  }
  return out
}

/** The workflow service, loaded when first needed (it reaches tasks.ts, which reaches this module). */
const service = (): Promise<typeof import('./workflow/service')> => import('./workflow/service')

/** Whether workflow rules are enforced now (Settings → Advanced): off, a lane is bookkeeping, as before 1.0. */
async function enforced(): Promise<boolean> {
  return (await service()).workflowEnforced()
}
export const lanesEnforced = enforced

/**
 * What a running lane's status reads of its cards' facts (#1270): each card's fold, while workflow rules are enforced
 * (null otherwise, or for a lane whose facts can't be read now: it says only what the board says).
 */
async function factsOf(ws: WorkspaceService, lanes: readonly LaneRecord[]): Promise<Map<string, Map<number, LaneCardFacts> | null>> {
  const out = new Map<string, Map<number, LaneCardFacts> | null>()
  const on = await enforced()
  for (const l of lanes) {
    if (!on || !running(l) || !ws.path) {
      out.set(l.id, null)
      continue
    }
    try {
      const store = FactStore.forBoard(ws, { project: l.project, key: l.project })
      const m = new Map<number, LaneCardFacts>()
      for (const n of l.cards) {
        const s = foldCard(store.facts(n))
        m.set(n, { stage: s.stage, forYou: forYou(s).length > 0, stale: !!s.stale, rounds: s.rounds })
      }
      out.set(l.id, m)
    } catch (e) {
      log.warn(`reading lane ${l.id}'s cards' facts`, e)
      out.set(l.id, null)
    }
  }
  return out
}

/** Lanes as they read now. */
async function views(ws: WorkspaceService, lanes: readonly LaneRecord[]): Promise<LaneInfo[]> {
  const cards = await cardsOf(ws, lanes)
  const names = await namesOf(ws, lanes)
  const facts = await factsOf(ws, lanes)
  // The running lanes' cards waiting for the user at their round limit (§16.11.4): from their facts, while the rules
  // are enforced (turned off, nothing pauses a lane for a rule).
  const atLimit = ws.path && rulesEnforced() ? roundLimitCards(ws, lanes.filter((l) => !isFrozen(l)).flatMap((l) => l.cards)) : new Set<number>()
  return lanes.map((l) => laneView(l, cards.get(l.id)!, names.get(l.project.toLowerCase()) ?? undefined, facts.get(l.id), atLimit))
}

/** A decision about a lane made on a read its cards have since moved on from (#1270): not saved; the lanes are read again. */
class StaleLane extends Error {}
/** The lanes themselves changed since they were read (readAs): read again at once. */
class StaleRead extends StaleLane {}

/** Where a lane's cards are now, as the board has committed them: a card archived, gone or in another project is gone. */
function placesOf(ws: WorkspaceService, l: LaneRecord, cards: readonly number[] = l.cards): string[] {
  const places = cardPlacesNow(ws, cards)
  return cards.map((n) => {
    const c = places.get(n)
    return !c || c.archived || !same(c.project, l.project) ? 'gone' : c.column
  })
}

/** Checked under the board's lock (#1270): the lane's cards are still all Done (gone ones aside), else nothing is saved. */
const stillAllDone = (ws: WorkspaceService, l: LaneRecord, cards: readonly number[]) => (): void => {
  const places = placesOf(ws, l, cards)
  if (!(places.includes('done') && places.every((c) => c === 'done' || c === 'gone'))) throw new StaleLane(`lane ${l.id}: its cards moved on`) // i18n-ignore: internal, caught and retried (never shown)
}

/** Checked under the board's lock (#1270): none of the lane's cards is in flight now, else its queued list waits. */
const stillBetweenCards = (ws: WorkspaceService, l: LaneRecord, cards: readonly number[]) => (): void => {
  if (placesOf(ws, l, cards).some((c) => c === 'doing' || c === 'review' || c === 'passed')) throw new StaleLane(`lane ${l.id}: a card is in flight again`) // i18n-ignore: as above
}

/** A lane's card in flight: started, not Done (in Doing, Review or Passed), the first such in the lane's order; null: none. */
const inFlight = (v: LaneInfo): number | null => v.cards.find((c) => c.column === 'doing' || c.column === 'review' || c.column === 'passed')?.number ?? null

const sameList = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((n, i) => n === b[i])

/**
 * The ruleset in force for a project now, stored, for a lane starting (#1270, §16.11.1: its cards, Todo ones too, keep
 * it until the lane ends); undefined while workflow rules aren't enforced, or when it can't be read (then its cards use
 * the current one, as before).
 */
async function rulesetNow(ws: WorkspaceService, project: string): Promise<string | undefined> {
  if (!ws.path || !(await enforced())) return undefined
  try {
    const wf = await (await service()).workflowFor(ws, join(ws.path, project))
    return wf ? await boardWrite(ws, async () => wf.currentRuleset(true).id) : undefined
  } catch (e) {
    log.warn(`the ruleset for a lane of ${userText(project)}`, e)
    return undefined
  }
}

/**
 * What a lane that ended by its cards brought in (#1270, §16.8.2): each card's result revision from its `Integrated`
 * fact (null: Done with nothing merged, as under Not checked, or a card from before 1.0), and the last of them, the
 * lane's merge commit, never an agent's say-so.
 */
function resultsOf(ws: WorkspaceService, l: LaneRecord): { card: number; revision: string | null }[] {
  try {
    const store = FactStore.forBoard(ws, { project: l.project, key: l.project })
    return l.cards.map((n) => ({ card: n, revision: foldCard(store.facts(n)).integrated?.result ?? null }))
  } catch (e) {
    log.warn(`reading lane ${l.id}'s results`, e)
    return l.cards.map((n) => ({ card: n, revision: null }))
  }
}

/**
 * Ends a lane its cards finished (#1270): verified from the facts while rules are enforced, its merge commit the last
 * result; one given (`given`: the user's, the Assistant's or a script's, never an agent's) only when the facts name none.
 */
function endVerified(ws: WorkspaceService, l: LaneRecord, cards: readonly LaneCard[] | undefined, on: boolean, ended: EndedLane[], given: string | null = null): void {
  const results = resultsOf(ws, l)
  const last = [...results].reverse().find((r) => r.revision)?.revision ?? null
  close(l, 'ended', cards, on ? (last ?? given) : (given ?? l.mergeCommit))
  ended.push({ lane: l.id, project: l.project, results })
}

/** A lane that ended, for the verified lane-end event (#1270). */
interface EndedLane {
  lane: string
  project: string
  results: { card: number; revision: string | null }[]
}

/**
 * The verified lane-end event (#1270): once per lane, as it ends with its cards Done, with what each brought in. Code
 * that follows lanes listens for it (onHiveEvent); the Agent API's event stream carries it.
 */
function tellEnded(ws: WorkspaceService, ended: readonly EndedLane[]): void {
  if (!ws.path) return
  for (const e of ended) ws.emit({ type: 'lane-ended', workspacePath: ws.path, lane: e.lane, project: e.project, results: e.results })
}

/** The builder is told a queued list change applied (#1270): its lane's cards now, in order. */
async function tellListChanged(ws: WorkspaceService, l: LaneRecord): Promise<void> {
  if (!ws.path) return
  const projectPath = join(ws.path, l.project)
  const body = withCardNames(ws, () => `Your lane's card list changed, as queued: its cards are now ${l.cards.map(cardRef).join(', ')}. hive_lane next names your next card.`) // i18n-ignore: an agent's message (English)
  try {
    await createDelivery(projectPath, { agentId: l.builder.id, agentName: l.builder.name, kind: 'rebrief', from: { kind: 'hive', name: 'Hive' }, body, source: 'lane', ref: l.id }) // i18n-ignore: the sender's name and the message an agent reads (English)
    await offerNow(projectPath, l.builder.id)
  } catch (e) {
    log.warn(`telling lane ${l.id}'s builder its list changed`, e)
  }
}

/** A project agent of the lane's project, by id: its name now. */
async function agentIn(ws: WorkspaceService, project: string, id: string): Promise<LaneAgent | null> {
  if (!ws.path) return null
  const cfg = await ws.projectConfig(join(ws.path, project)).catch(() => null)
  const a = cfg ? projectAgents(cfg).find((x) => x.id === id) : undefined
  return a ? { id: a.id, name: a.name } : null
}

export interface StartLane {
  project: string
  /** The builder's and reviewer's agent ids (reviewer null: none yet; undefined: keep a running lane's). */
  builder: string
  reviewer?: string | null
  cards: number[]
  rounds?: number
  waitMinutes?: number
  name?: string | null
  /** Who starts it, as the board names them. */
  by: string
}

/**
 * Starts a lane for a builder, or updates its running one: one running lane per builder. A running lane that shares a
 * card with the new list is the same loop (resumed, or changed: a card added, the order changed) and is updated in
 * place, keeping its reviewer unless one is given. One that shares none ends and a new lane starts: ended when it has
 * no card left to do (every one Passed, Done or gone: it waits only for its merge), else abandoned.
 */
export async function startLane(ws: WorkspaceService, s: StartLane): Promise<LaneChange> {
  const builder = await agentIn(ws, s.project, s.builder)
  if (!builder) throw new LaneError(404, 'Unknown agent: the builder must be an agent of the project') // i18n-ignore: hive_lane's refusal, which only agents get
  const reviewer = s.reviewer ? await agentIn(ws, s.project, s.reviewer) : s.reviewer === undefined ? undefined : null
  if (s.reviewer && !reviewer) throw new LaneError(404, 'Unknown agent: the reviewer must be an agent of the project') // i18n-ignore: hive_lane's refusal, which only agents get
  if (reviewer && reviewer.id === builder.id) throw new LaneError(400, "A lane's builder can't be its reviewer") // i18n-ignore: hive_lane's refusal, which only agents get
  // Rounds and wait the start doesn't give: the project's, else the workspace's (#412).
  const project = ws.path ? await ws.projectConfig(join(ws.path, s.project)).catch(() => null) : null
  const defaults = loopDefaults(ws.config, project)
  const on = await enforced()
  const ruleset = await rulesetNow(ws, s.project)
  const ended: EndedLane[] = []
  let queuedAfter: number | null = null
  // One decision a save (HR6's #1270 round 2): a change applied at once is saved only while none of the lane's cards is
  // in flight, checked under the board's lock; a card started meanwhile makes it decide again, and queue it.
  const decide = () => mutate(ws, async (lanes, checks) => {
    queuedAfter = null
    ended.length = 0
    const was = lanes.find((l) => running(l) && same(l.project, s.project) && l.builder.id === builder.id)
    const t = now()
    // With rules on, any new list for the builder's running lane is an edit of that lane (HR6's #1270 round 1), so a card
    // in flight is never left behind; with them off, a list sharing no card is another loop, as before 1.0.
    if (was && (was.cards.some((n) => s.cards.includes(n)) || on)) {
      // Hive owns the list (#1270, §16.11.1): a change while a card is in flight is queued for the next card boundary,
      // never refused; between cards it applies now. With rules off, at once, as before.
      const flying = on && !sameList(was.cards, s.cards) ? inFlight((await views(ws, [was]))[0]) : null
      if (flying !== null) {
        queuedAfter = flying
        was.pending = [...s.cards]
      } else {
        if (on && !sameList(was.cards, s.cards)) checks.push(stillBetweenCards(ws, was, [...was.cards]))
        was.cards = s.cards
        delete was.pending
      }
      Object.assign(was, {
        builder,
        ...(reviewer !== undefined ? { reviewer } : {}),
        ...(s.rounds !== undefined ? { rounds: s.rounds } : {}),
        ...(s.waitMinutes !== undefined ? { waitMinutes: s.waitMinutes } : {}),
        ...(s.name !== undefined && s.name !== null ? { name: s.name } : {}),
        updatedAt: t
      })
      return { rec: was, did: 'updated' as const, replaced: null }
    }
    let replaced: LaneRecord | null = null
    if (was) {
      const v = (await views(ws, [was]))[0]
      if (v.current === null && allDone(v.cards)) endVerified(ws, was, v.cards, on, ended)
      else close(was, v.current === null ? 'ended' : 'abandoned', v.cards)
      replaced = was
    }
    const rec: LaneRecord = {
      id: newId(),
      project: s.project,
      name: s.name ?? null,
      builder,
      reviewer: reviewer ?? null,
      cards: s.cards,
      rounds: s.rounds ?? defaults.rounds,
      waitMinutes: s.waitMinutes ?? defaults.waitHours * 60,
      state: 'active',
      startedBy: s.by,
      startedAt: t,
      updatedAt: t,
      endedAt: null,
      mergeCommit: null,
      ...(ruleset ? { ruleset } : {})
    }
    lanes.push(rec)
    return { rec, did: 'started' as const, replaced }
  })
  let r: Awaited<ReturnType<typeof decide>> | null = null
  for (let attempt = 0; !r; attempt++) {
    queuedAfter = null
    ended.length = 0
    try {
      r = await decide()
    } catch (e) {
      // A card of the lane started between the read and the save: decided again from the board as it is now.
      if (!(e instanceof StaleLane) || attempt >= 4) throw e instanceof StaleLane ? new LaneError(409, 'The lane kept changing: try again') : e // i18n-ignore: hive_lane's refusal (agents)
    }
  }
  const [lane, replaced] = await views(ws, [r.rec, ...(r.replaced ? [r.replaced] : [])])
  log.info(`Lane ${r.rec.id} ${r.did} for ${userText(builder.name)} in ${userText(s.project)}: ${s.cards.map((n) => `#${n}`).join(', ')}`)
  if (r.replaced) laneFact(ws, r.replaced)
  if (r.did === 'started') laneFact(ws, r.rec)
  tellEnded(ws, ended)
  const note = queuedAfter !== null ? withCardNames(ws, () => `The list change is queued: it applies once ${cardRef(queuedAfter!)} is Done, and you are told then.`) : undefined // i18n-ignore: hive_lane's reply (agents)
  return { lane, did: r.did, replaced: replaced ?? null, ...(note ? { note } : {}) }
}

/**
 * A reviewer joins the builder's running lane: with `cards`, only one that shares a card with them (a builder's earlier
 * lane, its cards passed and waiting for the merge, is another loop). With no such lane yet (the reviewer started
 * first), one is started from `cards` as the builder's start would (ending that earlier lane), which the builder's own
 * start then updates.
 */
export async function joinLane(ws: WorkspaceService, j: { project: string; builder: string; reviewer: string; cards?: number[]; by: string }): Promise<LaneChange> {
  const reviewer = await agentIn(ws, j.project, j.reviewer)
  const builder = await agentIn(ws, j.project, j.builder)
  if (!reviewer || !builder) throw new LaneError(404, 'Unknown agent: the builder and reviewer must be agents of the project') // i18n-ignore: hive_lane's refusal, which only agents get
  if (reviewer.id === builder.id) throw new LaneError(400, "A lane's builder can't be its reviewer") // i18n-ignore: hive_lane's refusal, which only agents get
  const found = await mutate(ws, (lanes) => {
    const l = lanes.find((x) => running(x) && same(x.project, j.project) && x.builder.id === builder.id)
    if (!l || (j.cards?.length && !l.cards.some((n) => j.cards!.includes(n)))) return null
    l.reviewer = reviewer
    l.updatedAt = now()
    return l
  })
  if (found) {
    log.info(`${userText(reviewer.name)} joined lane ${found.id}`)
    return { lane: (await views(ws, [found]))[0], did: 'joined' }
  }
  if (!j.cards?.length) throw new LaneError(404, `${builder.name} has no lane running yet: give the cards too, and the lane starts with you as its reviewer`) // i18n-ignore: hive_lane's refusal, which only agents get
  const r = await startLane(ws, { project: j.project, builder: builder.id, reviewer: reviewer.id, cards: j.cards, by: j.by })
  return { ...r, did: 'joined', note: `${builder.name} hadn't registered it yet: its own start updates it.` } // i18n-ignore: hive_lane's reply (agents)
}

/**
 * Ends a lane (its builder after the merge, the Assistant, the user): ended, with the merge commit if given, unless
 * `abandoned`. `agent`: a project agent ending it, which must be its builder or reviewer.
 */
export async function endLane(ws: WorkspaceService, id: string, o: { abandoned?: boolean; mergeCommit?: string | null; project?: string; agent?: string }): Promise<LaneInfo> {
  let ended = false
  const on = await enforced()
  const verified: EndedLane[] = []
  const rec = await mutate(ws, async (lanes, checks) => {
    ended = false
    verified.length = 0
    const l = lanes.find((x) => x.id === id && (!o.project || same(x.project, o.project)))
    if (!l) throw new LaneError(404, withValues(M.unknown, { id }))
    if (o.agent && l.builder.id !== o.agent && l.reviewer?.id !== o.agent) throw new LaneError(403, "Only a lane's builder or reviewer ends it (or the user, or the Assistant)") // i18n-ignore: hive_lane's refusal, which only a project agent gets
    if (running(l)) {
      const v = (await views(ws, [l]))[0]
      // Hive owns the lane (#1270, §16.8.2): with rules enforced, an agent ends it only once its cards are all Done,
      // and only the user and the Assistant abandon it; its merge commit is the cards' facts', not the agent's say-so.
      if (on && o.agent && o.abandoned) throw new LaneError(403, 'Only the user or the Assistant abandons a lane: tell the user if it should stop') // i18n-ignore: hive_lane's refusal, which only a project agent gets
      if (on && o.agent && !allDone(v.cards)) throw new LaneError(409, withCardNames(ws, () => `The lane ends by itself once all its cards are Done: ${v.cards.filter((c) => c.column !== 'done' && c.column !== 'gone').map((c) => cardRef(c.number)).join(', ')} not yet`)) // i18n-ignore: hive_lane's refusal, which only a project agent gets
      // An agent's say-so isn't a merge (§16.8.2): the user's, the Assistant's or a script's is kept where facts name none.
      const given = on && o.agent ? null : (o.mergeCommit ?? null)
      if (!o.abandoned && allDone(v.cards)) {
        checks.push(stillAllDone(ws, l, [...l.cards]))
        endVerified(ws, l, v.cards, on, verified, given)
      }
      else close(l, o.abandoned ? 'abandoned' : 'ended', v.cards, given)
      ended = true
    } else if ((!on || !o.agent) && o.mergeCommit && !l.mergeCommit) {
      l.mergeCommit = o.mergeCommit
      ended = true
    }
    return l
  }).catch((e) => {
    // Its cards moved on between the read and the save (a card reopened): nothing was saved.
    throw e instanceof StaleLane ? new LaneError(409, 'Its cards moved on meanwhile: read the lane again') : e // i18n-ignore: hive_lane's refusal (agents)
  })
  log.info(`Lane ${id} ${rec.state}`)
  if (ended) laneFact(ws, rec)
  tellEnded(ws, verified)
  return (await views(ws, [rec]))[0]
}

/**
 * The next card of an agent's running lane (#1270, `hive_lane next`): the card to start, the one in flight to carry on,
 * or why the lane waits (a card passed but not merged: one card at a time, §16.11.2); none once every card is Done.
 */
export async function laneNext(ws: WorkspaceService, project: string, agentId: string): Promise<{ lane: LaneInfo; next: { card: number; title: string; carryOn: boolean } | null; waits: LaneInfo['status'] }> {
  const lane = await laneOf(ws, project, agentId)
  if (!lane) throw new LaneError(404, 'No running lane of yours: start one with hive_lane start, or ask the user') // i18n-ignore: hive_lane's refusal (agents)
  const open = lane.cards.filter((c) => c.column !== 'done' && c.column !== 'gone')
  const pauses = lane.state === 'paused' ? lane.status : null
  if (pauses) return { lane, next: null, waits: pauses }
  const flying = open.find((c) => c.column === 'doing' || c.column === 'review')
  if (flying) return { lane, next: { card: flying.number, title: flying.title, carryOn: true }, waits: lane.status }
  const todo = open.find((c) => c.column === 'todo')
  return { lane, next: todo ? { card: todo.number, title: todo.title, carryOn: false } : null, waits: lane.status }
}

/** The running lane of a project agent (as builder, else as reviewer), or null. */
export async function laneOf(ws: WorkspaceService, project: string, agentId: string): Promise<LaneInfo | null> {
  const lanes = (await read(ws)).filter((l) => running(l) && same(l.project, project))
  const l = lanes.find((x) => x.builder.id === agentId) ?? lanes.find((x) => x.reviewer?.id === agentId)
  return l ? (await views(ws, [l]))[0] : null
}

/** A workspace's lanes: those listed (running, or ended lately), or with `all` every one kept; `project` narrows them. */
export async function listLanes(ws: WorkspaceService, o: { project?: string | null; all?: boolean } = {}): Promise<LaneInfo[]> {
  if (!ws.path) return []
  const lanes = (await read(ws)).filter((l) => !o.project || same(l.project, o.project))
  return views(ws, o.all ? [...lanes].sort((a, b) => a.startedAt.localeCompare(b.startedAt)) : listedLanes(lanes, Date.now()))
}

/** One lane by id (`project`: only one of that project's). */
export async function getLane(ws: WorkspaceService, id: string, project?: string | null): Promise<LaneInfo> {
  const l = (await read(ws)).find((x) => x.id === id && (!project || same(x.project, project)))
  if (!l) throw new LaneError(404, withValues(M.unknown, { id }))
  return (await views(ws, [l]))[0]
}

/** An agent was removed from its project: its running lanes, as builder or reviewer, are abandoned. */
export async function laneAgentRemoved(ws: WorkspaceService, project: string, agentId: string): Promise<void> {
  if (!ws.path) return
  const has = (await read(ws)).some((l) => running(l) && same(l.project, project) && (l.builder.id === agentId || l.reviewer?.id === agentId))
  if (!has) return
  await mutate(ws, async (lanes) => {
    for (const l of lanes) if (running(l) && same(l.project, project) && (l.builder.id === agentId || l.reviewer?.id === agentId)) close(l, 'abandoned', (await views(ws, [l]))[0].cards)
  })
}

// ---------------------------------------------------------------------------
// Following the board: each change to a workspace's cards reads its lanes again, ends those whose cards are all Done,
// abandons those whose agent is gone, and tells the window when what it lists changed.
// ---------------------------------------------------------------------------

/** What each workspace's window was last told (by its path), so an unchanged list isn't sent again. */
const told = new Map<string, string>()
const timers = new Map<string, NodeJS.Timeout>()
/** A board change and the follow-up are read together: changes landing within this are one look. */
const SETTLE_MS = 300

/** A workspace's lanes changed: look again soon. */
function changed(ws: WorkspaceService): void {
  const k = ws.path?.toLowerCase()
  if (!k || timers.has(k)) return
  const t = setTimeout(() => {
    timers.delete(k)
    // One refresh at a time (#1011): a slow one isn't overlapped by the next.
    void coalesced(`lanes:${k}`, () => refresh(ws).catch((e) => log.warn('following the lanes', e)))
  }, SETTLE_MS)
  t.unref?.()
  timers.set(k, t)
}

/** Reads a workspace's lanes against the board, closes the finished ones, and tells its window what changed. */
export async function refresh(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  if (!path) return
  const lanes = await read(ws)
  const live = lanes.filter(running)
  if (live.length) {
    const vs = await views(ws, live)
    const names = await namesOf(ws, live)
    // A list change queued while a card was in flight applies at the card boundary (#1270): none in flight now.
    const boundary = live.filter((l, i) => l.pending && inFlight(vs[i]) === null)
    if (boundary.length) {
      const applied: LaneRecord[] = []
      const checks: (() => void)[] = []
      try {
        await withFileLock(fileOf(ws), async () => {
          const kept = await read(ws)
          for (const l of kept) {
            const was = boundary.find((b) => b.id === l.id)
            // As the decision read it: the same list, still queued (another change meanwhile is looked at afresh).
            if (!running(l) || !l.pending || !was || !sameList(l.cards, was.cards) || !sameList(l.pending, was.pending ?? [])) continue
            checks.push(stillBetweenCards(ws, l, [...l.cards]))
            // A lane keeps at least a card (lanes.ts keeps none without): a change to none leaves it as it was.
            if (l.pending.length) l.cards = l.pending
            delete l.pending
            l.updatedAt = now()
            applied.push(l)
          }
          await write(ws, kept, () => checks.forEach((c) => c()))
        })
      } catch (e) {
        if (!(e instanceof StaleLane)) throw e
        log.info(`a lane's queued list waits: ${e.message}`)
        changed(ws)
        return
      }
      for (const l of applied) {
        log.info(`Lane ${l.id}: its queued list change applied`)
        await tellListChanged(ws, l)
      }
      if (ws.path && same(ws.path, path)) return refresh(ws)
      return
    }
    const done = live.filter((l, i) => allDone(vs[i].cards))
    // An agent no longer in its project (removed while Hive was closed, or by hand): its lane is abandoned.
    const orphan = live.filter((l) => {
      const n = names.get(l.project.toLowerCase())
      return !!n && (!n.has(l.builder.id) || (!!l.reviewer && !n.has(l.reviewer.id)))
    })
    if (done.length || orphan.length) {
      const cardsNow = new Map(live.map((l, i) => [l.id, vs[i].cards]))
      const on = await enforced()
      const ended: EndedLane[] = []
      const closed: LaneRecord[] = []
      const checks: (() => void)[] = []
      try {
        await withFileLock(fileOf(ws), async () => {
          const kept = await read(ws)
          for (const l of kept) {
            if (!running(l)) continue
            const decided = done.find((d) => d.id === l.id)
            // Every card Done (#1270): the lane ends by itself, its results from the cards' facts, if its list is the
            // one the decision read and its cards are still all Done as it saves (else nothing is saved, and it is read
            // again: HR6's #1270 round 1, a card reopened meanwhile).
            if (decided && sameList(l.cards, decided.cards)) {
              checks.push(stillAllDone(ws, l, [...l.cards]))
              endVerified(ws, l, cardsNow.get(l.id), on, ended)
            } else if (orphan.some((d) => d.id === l.id)) close(l, 'abandoned', cardsNow.get(l.id))
            else continue
            closed.push(l)
          }
          await write(ws, kept, () => checks.forEach((c) => c()))
        })
      } catch (e) {
        if (!(e instanceof StaleLane)) throw e
        log.info(`a lane's end waits: ${e.message}`)
        changed(ws)
        return
      }
      for (const l of closed) laneFact(ws, l)
      tellEnded(ws, ended)
      if (ws.path && same(ws.path, path)) return refresh(ws)
      return
    }
  }
  if (!ws.path || !same(ws.path, path)) return
  const listed = await listLanes(ws)
  const text = JSON.stringify(listed)
  if (told.get(path.toLowerCase()) === text) return
  // Nothing listed before and nothing now (a workspace with no lanes): nothing to tell.
  if (!told.has(path.toLowerCase()) && !listed.length) {
    told.set(path.toLowerCase(), text)
    return
  }
  told.set(path.toLowerCase(), text)
  ws.emit({ type: 'lanes-changed', workspacePath: path, lanes: listed })
}

let started = false

/** Follows the boards of open workspaces for their lanes. Once, at startup. */
export function startLanes(): void {
  if (started) return
  started = true
  onHiveEvent((e) => {
    if (e.type !== 'tasks-changed') return
    const ws = openWorkspaces().find((w) => w.path && same(w.path, e.workspacePath))
    if (ws) changed(ws)
  })
  // The runtime's `endLaneIfDone` (a card Done, #1270): the lanes are read again, and one whose cards are all Done ends.
  onAction('endLaneIfDone', (_a, ws) => changed(ws), 'repeatable')
  // An ended lane leaves the list after an hour: looked at again each minute (only workspaces whose window was told some).
  const tick = setInterval(() => {
    for (const ws of openWorkspaces()) if (ws.path && told.get(ws.path.toLowerCase()) !== '[]' && told.has(ws.path.toLowerCase())) changed(ws)
  }, 60_000)
  tick.unref?.()
}
