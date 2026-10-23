// Fresh starts at natural breaks (#1437, SPEC §16.10.4; #1086, #1088): Start Fresh (Idle Agents), and Hive's own nudge
// when a project's work has finished. The rules are shared/freshStarts.ts's.
//
// - **Start Fresh (Idle Agents)** gives each idle running agent of a project a new conversation (the old one stays in
//   the Sessions tab): `freshPlan` says who will and who won't, with why; `startFreshIfIdle` checks one again as it
//   starts it, so an agent that started work meanwhile is left as it is. Stopped agents stay stopped.
// - **The nudge**, "A good moment to start fresh", once per quiet spell, with the Assistant on or off: when a project's
//   last running lane ends verified (`lane-ended`), or, with no lane running, a card of it reaches Done, and its work has
//   finished (no agent busy, waiting, watching or with background tasks; no card in Review or Passed). A notice, as the
//   user's notification settings say, with Start Fresh (Idle Agents). Told once across windows and Hives: the board
//   keeps the last trigger told per project (`fresh_nudge:<project id>`), in the write that decides to tell it; and
//   once per spell in this Hive: not again until one of the project's agents has been busy since. Off switch: Settings →
//   Notifications, Suggest a fresh start when work finishes, and a project's own (Project Settings → Sessions).

import { basename, join } from 'path'
import { boardWrite, boardWriteOp } from './boardStore'
import { coalesced } from './coalesce'
import { config } from './config'
import { onHiveEvent } from './events'
import { folderFacts } from './agentFolders'
import { hiveError } from './hiveError'
import { listLanes } from './lanes'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { allTasks } from './tasks'
import { openWorkspaces, workspace, workspaceFor, type WorkspaceService } from './workspace'
import { leasesOf } from '../shared/agentFolders'
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

/**
 * Starts one agent fresh if it is still idle (checked again now): null when it was started fresh, else why not (it
 * started work, stopped, or took a lease meanwhile).
 */
export async function startFreshIfIdle(projectPath: string, agentId: string): Promise<FreshWhy | null> {
  const row = (await freshPlan(projectPath)).find((r) => r.agentId === agentId)
  if (!row) throw hiveError(M.notFound, { agent: agentId }, { kind: 'notFound' })
  if (row.why) return row.why
  await sessions.startFresh(projectPath, agentId)
  return null
}

/** Whether a project lets Hive suggest a fresh start: its own choice, else Settings → Notifications. */
async function suggestOn(projectPath: string): Promise<boolean> {
  const own = (await workspace.projectConfig(projectPath).catch(() => null))?.suggestFreshStart
  return own === 'on' ? true : own === 'off' ? false : config.settings.notifications.suggestFreshStart !== false
}

/** Projects told this quiet spell, in this Hive (by path, lower case): not told again until one of its agents was busy. */
const toldThisSpell = new Set<string>()
const BUSY = new Set(['starting', 'working', 'waiting', 'background', 'watching'])

/** Whether a project's work has finished now: its agents (workFinished) and its cards in Review or Passed. */
async function finishedNow(ws: WorkspaceService, projectPath: string): Promise<boolean> {
  const cfg = await ws.projectConfig(projectPath)
  const name = basename(projectPath).toLowerCase()
  const waiting = (await allTasks(ws)).filter((c) => !c.archived && (c.project ?? '').toLowerCase() === name && (c.column === 'review' || c.column === 'passed')).length
  return workFinished(projectAgents(cfg).map((a) => nowOf(projectPath, a.id)), waiting)
}

/** The nudge for a project, once per spell, if its switch is on and its work has finished; `trigger` names what ended. */
export async function considerNudge(ws: WorkspaceService, projectPath: string, trigger: string): Promise<boolean> {
  const key = projectPath.toLowerCase()
  if (toldThisSpell.has(key)) return false
  // Each decision not to suggest is logged, with why (what a test waits for before its next step).
  if (!(await suggestOn(projectPath))) {
    log.info(`No fresh-start suggestion in ${userText(basename(projectPath))} (${trigger}): turned off`)
    return false
  }
  if (!(await finishedNow(ws, projectPath))) {
    log.info(`No fresh-start suggestion in ${userText(basename(projectPath))} (${trigger}): its work hasn't finished`)
    return false
  }
  const id = (await ws.projectConfig(projectPath)).id ?? basename(projectPath)
  // Once across windows and Hives: the trigger told is kept with the board, decided in the write that keeps it.
  const first = await boardWrite(ws, async () =>
    boardWriteOp(ws, (db) => {
      const k = `fresh_nudge:${id}`
      const had = (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(k) as { value: string } | undefined)?.value // i18n-ignore: SQL
      if (had === trigger) return false
      db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, trigger) // i18n-ignore: SQL
      return true
    })
  ).catch(() => false)
  if (!first) return false
  toldThisSpell.add(key)
  log.info(`Suggested a fresh start in ${userText(basename(projectPath))} (${trigger})`)
  sessions.notice(projectPath, M.title, { m: M.body, values: { project: basename(projectPath) } }, { label: M.action, command: 'session.startFreshIdle', args: [projectPath] })
  return true
}

/** The cards known Done, per workspace (by path, lower case), so that only a card newly Done is a trigger. */
const doneSeen = new Map<string, Set<number>>()

/** A card newly Done in a project with no lane running: its trigger. A workspace's first look only learns what is Done. */
async function lookAtDone(ws: WorkspaceService): Promise<void> {
  if (!ws.path) return
  const k = ws.path.toLowerCase()
  const cards = await allTasks(ws)
  const done = cards.filter((c) => c.column === 'done' && !c.archived && c.project)
  const seen = doneSeen.get(k)
  doneSeen.set(k, new Set(done.map((c) => c.number)))
  if (!seen) return
  const running = (await listLanes(ws).catch(() => [])).filter((l) => l.state === 'active' || l.state === 'paused')
  for (const c of done) {
    if (seen.has(c.number)) continue
    if (running.some((l) => l.project.toLowerCase() === c.project!.toLowerCase())) continue
    await considerNudge(ws, join(ws.path, c.project!), `card:${c.number}`).catch((e) => log.warn('suggesting a fresh start', e))
  }
}

let started = false
/** Follows lanes ending, cards reaching Done and agents getting busy, for the nudge (index.ts, once). */
export function startFreshNudges(): void {
  if (started) return
  started = true
  onHiveEvent((e) => {
    if (e.type === 'session-status') {
      if (BUSY.has(e.state.status)) toldThisSpell.delete(e.state.projectPath.toLowerCase())
    } else if (e.type === 'lane-ended') {
      const ws = workspaceFor(e.workspacePath)
      if (!ws?.path) return
      void (async () => {
        // Its project's last running lane: no other lane of it still running.
        const others = (await listLanes(ws).catch(() => [])).filter((l) => l.id !== e.lane && (l.state === 'active' || l.state === 'paused') && l.project.toLowerCase() === e.project.toLowerCase())
        if (!others.length) await considerNudge(ws, join(ws.path!, e.project), `lane:${e.lane}`)
      })().catch((err) => log.warn('suggesting a fresh start', err))
    } else if (e.type === 'tasks-changed') {
      const ws = openWorkspaces().find((w) => w.path && w.path.toLowerCase() === e.workspacePath.toLowerCase())
      if (ws) void coalesced(`freshDone:${e.workspacePath.toLowerCase()}`, () => lookAtDone(ws)).catch((err) => log.warn('suggesting a fresh start', err))
    }
  })
}

/** For tests: forgets what was told and seen. */
export function resetFreshNudgesForTests(): void {
  toldThisSpell.clear()
  doneSeen.clear()
}
