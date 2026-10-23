// Fresh starts at natural breaks (#1437, SPEC §16.10.4; #1086, #1088): Start Fresh (Idle Agents), and Hive's own nudge
// when a project's work has finished. The rules are shared/freshStarts.ts's.
//
// - **Start Fresh (Idle Agents)** gives each idle running agent of a project a new conversation (the old one stays in
//   the Sessions tab): `freshPlan` says who will and who won't, with why; `startFreshIfIdle` checks one again just
//   before it stops it, with no wait between the check and the stop (its session, Hive typing into it, and its slot's
//   lease as the board has it then), so an agent that started work or took a lease meanwhile is left as it is. Stopped
//   agents stay stopped.
// - **The nudge**, "A good moment to start fresh", once per quiet spell, with the Assistant on or off: when a project's
//   last running lane ends verified (`lane-ended`), or, with no lane running, a card of it reaches Done, and its work has
//   finished (no agent busy, waiting, watching or with background tasks; no card in Review or Passed). A notice, as the
//   user's notification settings say, with Start Fresh (Idle Agents).
//   - Once per spell, across windows and Hives: the board keeps the spell's mark (`fresh_nudge:<project id>`), claimed in
//     one write that also checks again that the work has finished. One of the project's agents getting busy ends the
//     spell: the mark goes, in the first board write after it (the claim's or the reset's; `spellEnded`), never by
//     comparing times.
//   - A completion is kept, one per project, from before it is checked: one seen while the work hasn't finished yet
//     (the agent marks its last card Done from inside its turn) is considered again as the project's agents go quiet,
//     until it is told, a lane of the project runs again, or the switch is off.
//   Off switch: Settings → Notifications, Suggest a fresh start when work finishes, and a project's own (Project
//   Settings → Sessions).

import { basename, join } from 'path'
import { folderFacts, slotsIn } from './agentFolders'
import { boardRead, boardWrite, boardWriteOp } from './boardStore'
import { coalesced } from './coalesce'
import { config } from './config'
import { onHiveEvent } from './events'
import { hiveError } from './hiveError'
import { listLanes } from './lanes'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { allTasks } from './tasks'
import { openWorkspaces, workspace, workspaceFor, workspaceOf, type WorkspaceService } from './workspace'
import { leasesOf, type FolderSlot } from '../shared/agentFolders'
import { projectAgents } from '../shared/defaults'
import { freshWhy, workFinished, type FreshNow, type FreshRow, type FreshWhy } from '../shared/freshStarts'
import { msg } from '../shared/i18n'

const log = createLogger('sessions')

const M = {
  title: msg({ id: 'main.freshStart.title', defaultMessage: 'A good moment to start fresh', description: "A notification's title (#1437): a project's work has finished (its lane ended, or its card is done, and no agent is busy), so its agents could start fresh conversations, which costs less than carrying on long ones." }),
  body: msg({ id: 'main.freshStart.body', defaultMessage: "{project}'s work has finished: its idle agents can start new conversations. The old ones are kept.", description: "The body of the notification that a project's work has finished (#1437), above its button Start Fresh (Idle Agents). {project} is the project's name. The old conversations stay in the Sessions tab." }),
  action: msg({ id: 'main.freshStart.action', defaultMessage: 'Start Fresh (Idle Agents)', description: "The button of the notification that a project's work has finished (#1437): opens Start Fresh (Idle Agents) for the project, which asks first." }),
  notFound: msg({ id: 'main.freshStart.notFound', defaultMessage: 'No agent {agent} in this project.', description: 'Start Fresh for one agent is refused: the agent named ({agent}, its id) is not in the project.' })
}

const nowOf = (projectPath: string, agentId: string): FreshNow | null => {
  const n = sessions.agentNow(projectPath, agentId)
  return n ? { status: n.status, pending: n.pending, backgroundTasks: n.backgroundTasks } : null
}

/** Each of a project's agents, and whether Start Fresh (Idle Agents) gives it a new conversation now (why not, if not). */
export async function freshPlan(projectPath: string): Promise<FreshRow[]> {
  projectPath = workspace.assertProject(projectPath)
  const [cfg, facts] = await Promise.all([workspace.projectConfig(projectPath), folderFacts(projectPath)])
  return projectAgents(cfg).map((a) => {
    const lease = leasesOf(facts, a.id).dispatch
    const why = freshWhy(nowOf(projectPath, a.id), lease)
    return { agentId: a.id, name: a.name, why, ...(why === 'lease' ? { card: lease!.card } : {}) }
  })
}

/** Why an agent isn't idle now, read with no wait: its session, and its slot's lease as the board has it. */
function whyNotNow(ws: WorkspaceService, projectPath: string, project: string, agentId: string): FreshWhy | null {
  let slots: FolderSlot[] = []
  try {
    slots = boardRead(ws, (db) => slotsIn(db, project))
  } catch {
    // A board still 0.9's, or none open: no slots.
  }
  return freshWhy(nowOf(projectPath, agentId), leasesOf({ projectPath, migrated: false, homes: [], slots }, agentId).dispatch)
}

/**
 * Starts one agent fresh if it is still idle: null when it was started fresh, else why not (it started work, stopped,
 * or took a lease meanwhile). The last check is made just before the stop, with no wait between them (sessions.ts).
 */
export async function startFreshIfIdle(projectPath: string, agentId: string): Promise<FreshWhy | null> {
  const row = (await freshPlan(projectPath)).find((r) => r.agentId === agentId)
  if (!row) throw hiveError(M.notFound, { agent: agentId }, { kind: 'notFound' })
  if (row.why) return row.why
  const ws = workspaceOf(projectPath)
  const project = (await ws.projectConfig(projectPath)).id ?? basename(projectPath)
  return sessions.startFresh(projectPath, agentId, () => whyNotNow(ws, projectPath, project, agentId))
}

/** Whether a project lets Hive suggest a fresh start: its own choice, else Settings → Notifications. */
async function suggestOn(projectPath: string): Promise<boolean> {
  const own = (await workspace.projectConfig(projectPath).catch(() => null))?.suggestFreshStart
  return own === 'on' ? true : own === 'off' ? false : config.settings.notifications.suggestFreshStart !== false
}

const BUSY = new Set(['starting', 'working', 'waiting', 'background', 'watching'])

/**
 * A completion not told yet, per project (by path, lower case): kept from before its check, so a quiet moment while it
 * is being checked isn't missed (it is considered again then), and gone once it is told or isn't to be.
 */
type Pending = { ws: WorkspaceService; projectPath: string; trigger: string }
const pending = new Map<string, Pending>()
/**
 * Projects (by path, lower case) one of whose agents got busy since their spell's mark was last removed: set at the
 * event, and taken (the mark removed with it) only inside a board write, by the claim or the reset, whichever writes
 * first. So the order is the events' and writes' own: a reset coming late for an earlier busy moment finds it taken
 * and leaves the next spell's mark alone.
 */
const spellEnded = new Set<string>()

/** Whether a project's agents are all quiet now (workFinished), read with no wait. */
function agentsQuiet(projectPath: string, agentIds: readonly string[]): boolean {
  return workFinished(agentIds.map((id) => nowOf(projectPath, id)), 0)
}

type Told = 'told' | 'already' | 'unfinished'

/** The nudge for a project, once per spell, if its switch is on and its work has finished; `trigger` names what ended. */
export async function considerNudge(ws: WorkspaceService, projectPath: string, trigger: string): Promise<boolean> {
  const key = projectPath.toLowerCase()
  const name = basename(projectPath)
  // Kept before the first wait: a project going quiet from now on considers it again (a later completion replaces it).
  const mine: Pending = { ws, projectPath, trigger }
  pending.set(key, mine)
  const drop = (): void => void (pending.get(key) === mine && pending.delete(key))
  // Each decision not to suggest is logged, with why (what a test waits for before its next step).
  const not = (why: string): false => {
    log.info(`No fresh-start suggestion in ${userText(name)} (${trigger}): ${why}`)
    return false
  }
  if (!(await suggestOn(projectPath))) {
    drop()
    return not('turned off') // i18n-ignore: the log
  }
  // A lane of the project running again: its own end is the next natural break.
  if ((await listLanes(ws).catch(() => [])).some((l) => (l.state === 'active' || l.state === 'paused') && l.project.toLowerCase() === name.toLowerCase())) {
    drop()
    return not('a lane of it is running') // i18n-ignore: the log
  }
  const cfg = await ws.projectConfig(projectPath)
  const agents = projectAgents(cfg).map((a) => a.id)
  const id = cfg.id ?? name
  // Claimed in one write, which checks the work again as it is then (its agents, and its cards in Review or Passed): two
  // triggers at once, or two windows or Hives, tell it once; a record already there is this spell's.
  const told = await boardWrite(ws, async () =>
    boardWriteOp(ws, (db): Told => {
      const waiting = (db.prepare("SELECT count(*) AS n FROM cards WHERE archived = 0 AND col IN ('review', 'passed') AND lower(coalesce(project, '')) = ?").get(name.toLowerCase()) as { n: number }).n // i18n-ignore: SQL
      if (waiting > 0 || !agentsQuiet(projectPath, agents)) return 'unfinished'
      const k = `fresh_nudge:${id}`
      // An agent was busy since the mark: that spell has ended (its reset, if still to come, then has nothing to do).
      if (spellEnded.delete(key)) db.prepare('DELETE FROM board_meta WHERE key = ?').run(k) // i18n-ignore: SQL
      if (db.prepare('SELECT 1 FROM board_meta WHERE key = ?').get(k)) return 'already' // i18n-ignore: SQL
      db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?)').run(k, JSON.stringify({ trigger })) // i18n-ignore: SQL
      return 'told'
    })
  ).catch((e) => {
    log.warn('suggesting a fresh start', e)
    return null
  })
  // Unfinished: still kept, for the project's next quiet moment.
  if (told === 'unfinished') return not("its work hasn't finished") // i18n-ignore: the log
  drop()
  if (told !== 'told') return told === 'already' ? not('suggested already since its agents were last busy') : false // i18n-ignore: the log
  log.info(`Suggested a fresh start in ${userText(name)} (${trigger})`)
  sessions.notice(projectPath, M.title, { m: M.body, values: { project: name } }, { label: M.action, command: 'session.startFreshIdle', args: [projectPath] })
  return true
}

/**
 * One of a project's agents got busy: its spell ends, and the mark on the board goes (whichever Hive made it), unless a
 * claim has taken that busy moment already (and removed the mark itself).
 */
async function endSpell(projectPath: string): Promise<void> {
  const key = projectPath.toLowerCase()
  if (!spellEnded.has(key)) return
  const ws = workspaceOf(projectPath)
  const k = `fresh_nudge:${(await ws.projectConfig(projectPath)).id ?? basename(projectPath)}`
  await boardWrite(ws, async () =>
    boardWriteOp(ws, (db) => {
      if (spellEnded.delete(key)) db.prepare('DELETE FROM board_meta WHERE key = ?').run(k) // i18n-ignore: SQL
    })
  )
}

/** The cards known Done, per workspace (by path, lower case), so that only a card newly Done is a trigger. */
const doneSeen = new Map<string, Set<number>>()

/** A card newly Done in a project: its trigger. A workspace's first look only learns what is Done. */
async function lookAtDone(ws: WorkspaceService): Promise<void> {
  if (!ws.path) return
  const k = ws.path.toLowerCase()
  const cards = await allTasks(ws)
  const done = cards.filter((c) => c.column === 'done' && !c.archived && c.project)
  const seen = doneSeen.get(k)
  doneSeen.set(k, new Set(done.map((c) => c.number)))
  if (!seen) return
  for (const c of done) {
    if (seen.has(c.number)) continue
    await considerNudge(ws, join(ws.path, c.project!), `card:${c.number}`).catch((e) => log.warn('suggesting a fresh start', e))
  }
}

let started = false
/** Follows lanes ending, cards reaching Done and agents getting busy or quiet, for the nudge (index.ts, once). */
export function startFreshNudges(): void {
  if (started) return
  started = true
  onHiveEvent((e) => {
    if (e.type === 'session-status') {
      const key = e.state.projectPath.toLowerCase()
      // Each run reads the latest (a run asked for meanwhile runs once more, after it).
      if (BUSY.has(e.state.status)) {
        spellEnded.add(key)
        void coalesced(`freshSpell:${key}`, () => endSpell(e.state.projectPath)).catch((err) => log.warn('ending a fresh-start spell', err))
        return
      }
      // Quiet again: a completion kept for this project is considered now.
      if (pending.has(key))
        void coalesced(`freshPending:${key}`, async () => {
          const p = pending.get(key)
          if (p) await considerNudge(p.ws, p.projectPath, p.trigger)
        }).catch((err) => log.warn('suggesting a fresh start', err))
    } else if (e.type === 'lane-ended') {
      const ws = workspaceFor(e.workspacePath)
      if (!ws?.path) return
      void considerNudge(ws, join(ws.path, e.project), `lane:${e.lane}`).catch((err) => log.warn('suggesting a fresh start', err))
    } else if (e.type === 'tasks-changed') {
      const ws = openWorkspaces().find((w) => w.path && w.path.toLowerCase() === e.workspacePath.toLowerCase())
      if (ws) void coalesced(`freshDone:${e.workspacePath.toLowerCase()}`, () => lookAtDone(ws)).catch((err) => log.warn('suggesting a fresh start', err))
    }
  })
}

/** For tests: forgets what this Hive was told and saw (the board keeps its records). */
export function resetFreshNudgesForTests(): void {
  pending.clear()
  spellEnded.clear()
  doneSeen.clear()
}
