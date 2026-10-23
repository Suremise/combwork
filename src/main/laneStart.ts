import { basename } from 'path'
import { projectAgents } from '../shared/defaults'
import { msg } from '../shared/i18n'
import { laneBrief, type LaneRole } from '../shared/laneBrief'
import { loopDefaults } from '../shared/lanes'
import { cardLabel } from '../shared/projectKeys'
import type { LaneInfo, LaneStartRequest, LaneStartResult } from '../shared/types'
import { launchWith } from './deliveries'
import { legacyWorktree, slotsMigrated } from './agentFolders'
import { lendLane } from './slotCards'
import { agentWorkflowRole, buildsWork } from '../shared/workflow/roles'
import { hiveError } from './hiveError'
import { startLane } from './lanes'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { getTask } from './tasks'
import { resolvedOf } from './workflow/rulesets'
import { workflowEnforced } from './workflow/service'
import type { WorkspaceService } from './workspace'

const log = createLogger('lanes')

/**
 * A lane started from the window (#1280, SPEC §16.11.3): Start lane… records the lane (the one lane record, #1270) and
 * starts its builder and its reviewer, each in a fresh conversation with the generated brief (laneBrief) as its first
 * prompt: an agent that isn't running is started with it, an idle one ends its conversation (kept in its Sessions tab)
 * and starts a new one. Nothing is typed into a CLI, so no slash command ever is. An agent busy now is refused before
 * anything is recorded: the window offers to wait for it (Start lane… waits until both are idle, then starts).
 */

/** The statuses an agent can't start a lane from now. */
const BUSY = new Set(['working', 'starting', 'waiting', 'background', 'watching', 'signin'])

const M = {
  noCards: msg({ id: 'service.laneStart.noCards', defaultMessage: 'Choose the cards for the lane.', description: 'An error starting a lane (a builder and a reviewer working through cards in turn) from the window: no card was chosen.' }),
  notTheProjects: msg({ id: 'service.laneStart.notTheProjects', defaultMessage: "{card} isn't one of {project}'s cards, or it is archived.", description: "An error starting a lane from the window: a card chosen ({card}, its key) isn't this project's ({project}), or is archived." }),
  done: msg({ id: 'service.laneStart.done', defaultMessage: '{card} is Done already.', description: 'An error starting a lane from the window: a card chosen ({card}, its key) is already Done.' }),
  unknownAgent: msg({ id: 'service.laneStart.unknownAgent', defaultMessage: "{agent} isn't one of {project}'s agents.", description: "An error starting a lane from the window: the builder or reviewer chosen ({agent}) isn't an agent of the project ({project})." }),
  sameAgent: msg({ id: 'service.laneStart.sameAgent', defaultMessage: "The builder can't be its own reviewer.", description: 'An error starting a lane from the window: the same agent was chosen as builder and reviewer.' }),
  needsReviewer: msg({ id: 'service.laneStart.needsReviewer', defaultMessage: "{project}'s rules have a reviewer agent review each card: choose a reviewer.", description: "An error starting a lane from the window: the project's workflow options have a reviewer agent review the work, and no reviewer was chosen." }),
  busy: msg({ id: 'service.laneStart.busy', defaultMessage: "{agent} {status, select, working {is working} starting {is starting} waiting {is waiting for your answer} background {is waiting on background tasks it started} signin {needs you to sign in again} other {is waiting on cards (a card watch)}}. Start the lane once it's idle, or choose another agent.", description: "An error starting a lane from the window: the agent {agent} can't start in a new conversation now, because of what it is doing ({status}; keep the select keys). The window offers to wait until it's idle." }),
  starting: msg({ id: 'service.laneStart.starting', defaultMessage: "{agent}'s lane is being started already.", description: 'An error starting a lane from the window: one with the same builder ({agent}) is being started right now.' })
}

/** Builders whose lane is being started (a second Start meanwhile is refused). */
const starting = new Set<string>()

export async function startLaneFromWindow(ws: WorkspaceService, projectPath: string, req: LaneStartRequest): Promise<LaneStartResult> {
  const project = basename(projectPath)
  const cfg = await ws.projectConfig(projectPath)
  const agents = projectAgents(cfg)
  const agentOf = (id: string) => {
    const a = agents.find((x) => x.id === id)
    if (!a) throw hiveError(M.unknownAgent, { agent: id, project }, { kind: 'notFound' })
    return a
  }
  const builder = agentOf(req.builder)
  const reviewer = req.reviewer ? agentOf(req.reviewer) : null
  if (reviewer && reviewer.id === builder.id) throw hiveError(M.sameAgent, undefined, { kind: 'invalid' })
  if (!req.cards.length) throw hiveError(M.noCards, undefined, { kind: 'invalid' })
  const cards: { number: number; key: string; title: string }[] = []
  for (const n of req.cards) {
    const c = await getTask(n).catch(() => null)
    if (!c || c.archived || c.project.toLowerCase() !== project.toLowerCase()) throw hiveError(M.notTheProjects, { card: c ? cardLabel(c) : `#${n}`, project }, { kind: 'invalid' })
    if (c.column === 'done') throw hiveError(M.done, { card: cardLabel(c) }, { kind: 'conflict' })
    cards.push({ number: c.number, key: cardLabel(c), title: c.title })
  }
  // What the project's rules ask (none while they are off): a reviewer agent's review needs a reviewer.
  const platform = ws.info()?.projects.find((p) => p.path.toLowerCase() === projectPath.toLowerCase())?.platform?.id
  const options = workflowEnforced() && platform ? resolvedOf(ws, projectPath, platform, cfg).options : null
  if (options && !reviewer && (options.review === 'agent' || options.review === 'agentThenYou')) throw hiveError(M.needsReviewer, { project }, { kind: 'invalid' })
  // Both free now, checked before anything is recorded (again by each start below).
  for (const a of [builder, reviewer]) {
    const st = a ? sessions.liveFor(projectPath, a.id) : null
    if (a && st && BUSY.has(st.status)) throw hiveError(M.busy, { agent: a.name, status: st.status }, { kind: 'conflict' })
  }
  const key = `${projectPath.toLowerCase()}|${builder.id}`
  if (starting.has(key)) throw hiveError(M.starting, { agent: builder.name }, { kind: 'conflict' })
  starting.add(key)
  try {
    const rounds = loopDefaults(ws.config, cfg).rounds
    // Where the builder works (#1438): a slot of the lane's (G11 = slots, a builder whose 0.9 worktree isn't its folder
    // any more, #1434's legacyWorktree), else its 0.9 worktree or the project folder, as before.
    const legacy = (await slotsMigrated(projectPath)) ? null : legacyWorktree(builder)
    const inSlots = options?.folder === 'slots' && buildsWork(agentWorkflowRole(builder)) && !legacy
    const input = (slot: string | null) => ({ project, cards: cards.map(({ key: k, title }) => ({ key: k, title })), builder: { name: builder.name, folder: legacy?.path ?? null, branch: legacy?.branch ?? null, slot }, reviewer: reviewer ? { name: reviewer.name } : null, options, rounds, note: req.note ?? '' })
    const recorded = await startLane(ws, { project, builder: builder.id, reviewer: reviewer?.id ?? null, cards: cards.map((c) => c.number), name: req.name?.trim() || null, by: 'the user' }) // i18n-ignore: who started it, as the lane records it (agents read it)
    const startAgents = async (slot: string | null): Promise<LaneStartResult['started']> => {
      const started: LaneStartResult['started'] = []
      for (const [a, role] of [[builder, 'builder'], ...(reviewer ? [[reviewer, 'reviewer']] : [])] as [typeof builder, LaneRole][]) {
        const brief = laneBrief(input(slot), role)
        let how: 'fresh' | 'started' = 'started'
        try {
          // Still the project's agent, read again after the awaits above.
          if (!projectAgents(await ws.projectConfig(projectPath)).some((x) => x.id === a.id)) throw hiveError(M.unknownAgent, { agent: a.name, project }, { kind: 'notFound' })
          // Free where it is launched (HR6's #1280 round 1): checked with no await before its conversation is replaced
          // (newConversation's `allowed` runs just before it stops the agent), so one that started work meanwhile keeps
          // it: it is reported as not started, and the lane stays.
          const free = (): void => {
            const st = sessions.liveFor(projectPath, a.id)
            if (st && BUSY.has(st.status)) throw hiveError(M.busy, { agent: a.name, status: st.status }, { kind: 'conflict' })
          }
          await launchWith(projectPath, { agentId: a.id, agentName: a.name, kind: 'task', from: { kind: 'user', name: 'the user' }, body: brief }, (line) => { // i18n-ignore: who the brief is from, as agents read it
            free()
            if (!sessions.liveFor(projectPath, a.id)) return sessions.start(projectPath, { agentId: a.id, prompt: line })
            how = 'fresh'
            // Its first call is just before the agent is stopped; later ones (as the new conversation starts) aren't ours.
            let first = true
            return sessions.newConversation(projectPath, a.id, line, () => {
              if (first) free()
              first = false
            })
          })
          started.push({ agentId: a.id, name: a.name, role, how })
        } catch (e) {
          // The lane is recorded: the user can start the agent themselves, or end the lane from its row.
          log.warn(`starting ${userText(a.name)} for lane ${recorded.lane.id}`, e)
          started.push({ agentId: a.id, name: a.name, role, how: 'failed', why: (e as Error).message })
        }
      }
      return started
    }
    if (inSlots) {
      // Its slot, lent before its agents start and kept for the whole lane (§16.10.2). None free: the lane is recorded and
      // waits ("waiting for a slot"); its agents start once a lease's end frees one.
      const got = await lendLane(ws, projectPath, recorded.lane.id, builder.id, async (slot) => void (await startAgents(slot)))
      if ('waiting' in got) return { lane: recorded.lane as LaneInfo, started: [], waitingForSlot: got.waiting }
      return { lane: recorded.lane as LaneInfo, started: await startAgents(got.slot), slot: got.slot }
    }
    return { lane: recorded.lane as LaneInfo, started: await startAgents(null) }
  } finally {
    starting.delete(key)
  }
}
