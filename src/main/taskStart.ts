import { basename, join } from 'path'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import type { DeliverySender } from '../shared/deliveries'
import { projectAgents } from '../shared/defaults'
import { deliverNow, launchWith, NotGiven } from './deliveries'
import { msg } from '../shared/i18n'
import { rawTaskPrompt, taskPrompt } from '../shared/tasks'
import type { TaskCard, TaskStartTarget } from '../shared/types'
import { emit } from './events'
import { addAgent, removeAgent } from './projectAgents'
import { sessions } from './sessions'
import { HiveError, hiveError, errorText } from './hiveError'
import { RAW_CARD_START, forAgents, saidText, withValues } from '../shared/advanced'
import { agentMsg } from '../shared/agentText'
import { advanced } from './advanced'
import { columnError, getTask, setContextProblems, UNKNOWN_AGENT, updateTask, type TaskActor } from './tasks'
import { createLogger, userText } from './logger'
import { workspace, workspaceOf } from './workspace'
import { cardAttachments } from './cardAttachments'
import { checkDocRef, type DocRefCheck } from './docSections'
import { expectStartPrompt, placementDue, startedOutsideSlots } from './slotCards'
import { startBegun, startEnded } from './agentStarts'
import type { ContextLine } from '../shared/tasks'
import { cardRef } from '../shared/projectKeys'
import { laneBuilds } from '../shared/lanes'
import { rawLanes } from './lanes'

const log = createLogger('tasks')

/** The statuses in which an agent can't be given a card: its refusal's `{status}`, each in its own words. */
const BUSY_STATUSES = new Set(['working', 'starting', 'waiting', 'background', 'watching'])
/** A Start refused because the agent is busy (#846): its status chooses the words. */
const AGENT_BUSY = msg({ id: 'tasks.start.agentBusy', defaultMessage: "{agent} {status, select, working {is working} starting {is starting} waiting {is waiting for the user} background {is waiting on background tasks it started} other {is waiting on cards (a card watch): it takes no other work until it is woken, or the watch is cancelled (Cancel in its header)}}. Start the card once it's idle, or give it to another agent.", description: "An error: a card can't be started with the agent {agent} (its name) now, because of what it is doing ({status}, select: working, starting, waiting for the user, waiting on background tasks it started, or waiting on cards in a card watch; translate each). Cancel is the button in the agent's header." })

/**
 * What agents read for AGENT_BUSY: the words the Agent API always gave (#910), where the window says card. An agent
 * message (dialects, HI-2440), the agent branch of `forAgents`.
 */
const BUSY_FOR_AGENTS = agentMsg({
  id: 'board.agent.agentBusy',
  text: "{agent} {status, select, working {is working} starting {is starting} waiting {is waiting for the user} background {is waiting on background tasks it started} other {is waiting on cards (a card watch): it takes no other work until it is woken, or the watch is cancelled (Cancel in its header)}}. Start the task once it's idle, or give it to another agent.",
  note: '#910: the words the Agent API always gave (the window says card). status: what the agent is doing (working, starting, waiting, background; other: a card watch).'
})

/** A Start refused because the agent is busy: the window's words, and the agents' as they always were. */
export function agentBusyError(agent: string, status: string): HiveError {
  return new HiveError(forAgents(withValues(AGENT_BUSY, { agent, status }), saidText(BUSY_FOR_AGENTS, { agent, status: BUSY_STATUSES.has(status) && status !== 'watching' ? status : 'other' })), { kind: 'conflict' })
}

/** A Start undone because the card's start got no slot where its project builds in slots (HI-1966). */
const NO_SLOT = msg({ id: 'tasks.start.noSlot', defaultMessage: "{card} wasn't started: its project builds each card in a slot, and {active, select, yes {its start has none} other {this start got none}}, so its agent would have worked in the project folder. {active, select, yes {Put it back to Todo, then start it again.} other {The card is back where it was: start it again.}}", description: "An error: a Start of the card {card} (its key, such as HI-12) was refused. The card's project has each card built in a slot (a working folder of its own), but the card's start has no slot, so the agent would have worked in the project's own folder instead. {active} (select): yes, the card was already Active (in work) with no slot, and must be put back to Todo and started again; other, this start was undone and the card moved back to its column. Translate both." })

/**
 * A start's own condition, checked where its move is written (in its transaction, under the board's lock): it throws to
 * refuse the start, nothing assigned, written or delivered (HI-1990: the lane that asked for it still there, its card
 * still its next).
 */
export type StartGuard = (now: TaskCard) => void

/** Cards being started now ("<workspace>#<n>"): a second Start of the same card is refused, not run twice. */
const starting = new Set<string>()

/**
 * Agents being given a card now ("<project>|<agent id>"), from the first look at them until shortly after the prompt
 * went in (before its hook says the agent is working): a second Start for the same agent, of another card, is refused
 * rather than typed into the first one's work.
 */
const busyAgents = new Set<string>()
/** How long an agent stays reserved after its prompt went in, for its status to catch up. */
const SETTLE_MS = 5000

/** A Start's note is typed into the agent's terminal with the card. */
const MAX_NOTE = 4000

/**
 * Start on a card: gives it to an agent of its project (one that is stopped or idle, or a new one, in the project
 * folder or a new worktree) with the card as its prompt, and puts the card in Doing. A card in Review or Done is
 * started again for more work (it goes back to Review when that is done). The card is taken first, checked under
 * its lock (not archived or moved to Done meanwhile), so the prompt is the card as it now is; if the agent then
 * can't be started, the card goes back where it was and a new agent is removed again. note: what to do now (such as
 * "address the latest review comment"), added to the prompt.
 */
/**
 * Starts card `n` on an agent (or a new one). `commit`: a revocable caller's authority (HI-2420, the Assistant's guard),
 * checked again where the card is taken (as it is saved), and before the task is typed in or its agent launched: once
 * it no longer holds, the start is undone as one that fails (the card back where it was, a new agent removed).
 */
export async function startTask(n: number, target: TaskStartTarget, actor: TaskActor, note?: string, reason?: string, guard?: StartGuard, commit?: () => void): Promise<{ card: TaskCard; agentId: string; agentName: string; added: boolean; run?: string }> {
  if (note && note.length > MAX_NOTE) throw hiveError(msg({ id: 'tasks.start.noteTooLong', defaultMessage: 'The note is too long (at most {max, number} characters).', description: 'An error: the note given with a Start (what the agent should do now) is longer than it may be ({max}, a number of characters).' }), { max: MAX_NOTE }, { kind: 'invalid' })
  const key = `${(workspace.path ?? '').toLowerCase()}#${n}`
  if (starting.has(key)) throw hiveError(msg({ id: 'tasks.start.alreadyStarting', defaultMessage: '{card} is already being started.', description: 'An error: card {card} (its key, such as HI-12) is being started already; a second Start of it is refused.' }), { card: cardRef(n) }, { kind: 'conflict' })
  starting.add(key)
  try {
    return await startReserved(n, target, actor, note?.trim() || undefined, reason?.trim() || undefined, guard, commit)
  } finally {
    starting.delete(key)
  }
}

/**
 * Whether the agent can be given a card now: stopped (it is started with it) or idle (the prompt is typed in), and
 * for a Start that isn't the user's, not where the user has just typed. Checked when the Start begins and again just
 * before the prompt goes in, since the agent may have started work meanwhile.
 */
function availability(p: string, agentId: string, agentName: string, actor: TaskActor): { live: boolean } {
  const st = sessions.liveFor(p, agentId)
  if (st && BUSY_STATUSES.has(st.status)) throw agentBusyError(agentName, st.status)
  if (st && actor.kind !== 'user' && sessions.userMayBeTyping(p, agentId)) throw hiveError(msg({ id: 'tasks.start.userTyping', defaultMessage: "The user has just typed in {agent}'s terminal and may still be writing there. Ask the user first.", description: "An error: an agent or the Assistant tried to give a card to the agent {agent} (its name), but the user has just typed in that agent's terminal." }), { agent: agentName }, { kind: 'conflict' })
  return { live: !!st }
}

/** Who a Start's task is from (#649): the Assistant's launch (its permission worked out again at every step), an agent, or the user. */
function senderOf(actor: TaskActor): DeliverySender {
  if (actor.kind === 'assistant') return { kind: 'assistant', name: 'the Assistant', workspace: workspace.path!, launch: sessions.liveFor(workspace.assistantHome, ASSISTANT_AGENT_ID)?.runId ?? '' } // i18n-ignore: who a delivery is from, as agents read it
  if (actor.kind === 'agent') return { kind: 'hive', name: actor.name }
  return { kind: 'user', name: 'the user' } // i18n-ignore: who a delivery is from, as agents read it
}

function startable(card: TaskCard): void {
  if (card.archived) throw hiveError(msg({ id: 'tasks.start.archived', defaultMessage: '{card} is archived. Bring it back first.', description: 'An error: card {card} (its key, such as HI-12) is archived, so it cannot be started; bring it back onto the board first.' }), { card: cardRef(card.number) }, { kind: 'conflict' })
  if (!card.project) throw hiveError(msg({ id: 'tasks.start.noProject', defaultMessage: '{card} has no project. Give it one first: the agent works in that project.', description: 'An error: card {card} (its key, such as HI-12) belongs to no project (only the workspace), so no agent can start it; give it a project first.' }), { card: cardRef(card.number) }, { kind: 'invalid' })
}

async function startReserved(n: number, target: TaskStartTarget, actor: TaskActor, note: string | undefined, reason: string | undefined, guard?: StartGuard, commit?: () => void): Promise<{ card: TaskCard; agentId: string; agentName: string; added: boolean; run?: string }> {
  const before = await getTask(n)
  startable(before)
  const p = workspace.assertProject(join(workspace.path!, before.project))

  let agentId: string
  let agentName: string
  let reserved: string | null = null
  if (target.kind === 'agent') {
    const a = projectAgents(await workspace.projectConfig(p)).find((x) => x.id === target.agentId || x.name.toLowerCase() === target.agentId.toLowerCase())
    if (!a) throw hiveError(UNKNOWN_AGENT, { agent: target.agentId, project: before.project }, { kind: 'notFound' })
    agentId = a.id
    agentName = a.name
    availability(p, a.id, a.name, actor)
    const agentKey = `${p.toLowerCase()}|${a.id}`
    if (busyAgents.has(agentKey)) throw hiveError(msg({ id: 'tasks.start.beingGiven', defaultMessage: "{agent} is being given another card. Start this one once it's idle, or give it to another agent.", description: 'An error: the agent {agent} (its name) is being given another card right now, so this one cannot be started with it.' }), { agent: a.name }, { kind: 'conflict' })
    busyAgents.add(agentKey)
    reserved = agentKey
  } else {
    // 1.0 (#1451): a new agent gets no worktree of its own. Asking for one (the board's start, until #1442) is passed on so
    // addAgent refuses it with its note, never ignored.
    // The user's own Start goes past Maximum agents; an agent's or the Assistant's keeps to it (HI-2001).
    const def = await addAgent(p, { name: target.name, location: target.worktree ? 'new-worktree' : 'project', ...(target.connection ? { connection: target.connection } : {}) }, actor.kind === 'user' ? 'user' : 'agent')
    agentId = def.id
    agentName = def.name
  }
  // The agent is starting from here (HI-1976): not stalled while its card is given, nor, where its card starts in a slot,
  // until the slot's placement has given it (that takes this hold over); a new Start's agent has no earlier failure.
  const hold = `#${n}`
  startBegun(p, agentId, hold, { fresh: true })
  let typed = false
  let slotted = false
  try {
    const { typed: t, slotted: s, ...result } = await giveCard(n, before, p, agentId, agentName, target.kind !== 'agent', actor, note, reason, guard, commit)
    typed = t
    slotted = s
    return result
  } finally {
    if (!slotted) startEnded(p, agentId, hold)
    // A prompt typed into a running agent: kept a moment, until the agent's own status says it's working (an agent
    // started with the card is "starting" at once).
    if (reserved) {
      const k = reserved
      if (typed) setTimeout(() => busyAgents.delete(k), SETTLE_MS).unref?.()
      else busyAgents.delete(k)
    }
  }
}

async function giveCard(
  n: number,
  before: TaskCard,
  p: string,
  agentId: string,
  agentName: string,
  added: boolean,
  actor: TaskActor,
  note: string | undefined,
  reason?: string,
  guard?: StartGuard,
  commit?: () => void
): Promise<{ card: TaskCard; agentId: string; agentName: string; added: boolean; typed: boolean; slotted: boolean }> {
  const undoAgent = async (): Promise<void> => {
    if (added) await removeAgent(p, agentId, { deleteWorktree: true }).catch((e) => log.warn(`Could not remove ${userText(agentName)} after #${n} didn't start`, e))
  }

  // A start in a slot (#1438) gives the card to the agent there once its line is made: this Start's prompt goes to that.
  const toSlot = expectStartPrompt(p, n)
  let slotted = false
  // Taken first, on the card as it is now: it must still be startable, and in the project, column and with the agent
  // this Start read. Anything else is a newer decision (moved, reassigned, put in Done) and stays.
  let card: TaskCard
  try {
    // The user's reason for a start that skips rules (#1275: the window asked first), kept with its Override.
    card = await updateTask(n, { agent: agentId, ...(before.column === 'doing' ? {} : { column: 'doing' as const }), ...(reason && actor.kind === 'user' ? { override: { reason } } : {}) }, actor, {
      check: (now) => {
        startable(now)
        // What the start's caller said must still hold, where the start is written (HI-1990: Hive's start of a lane's next card).
        guard?.(now)
        if (now.project.toLowerCase() !== before.project.toLowerCase()) {
          throw now.project
            ? hiveError(msg({ id: 'tasks.start.movedProject', defaultMessage: '{card} moved to {project} meanwhile. Start it again.', description: 'An error: while card {card} (its key, such as HI-12) was being started, it was moved to the project {project} (a folder name).' }), { card: cardRef(n), project: now.project }, { kind: 'conflict' })
            : hiveError(msg({ id: 'tasks.start.movedWorkspace', defaultMessage: '{card} moved to the workspace meanwhile. Start it again.', description: 'An error: while card {card} (its key, such as HI-12) was being started, it was taken out of its project, to the whole workspace.' }), { card: cardRef(n) }, { kind: 'conflict' })
        }
        if (now.column === 'done' && before.column !== 'done') throw hiveError(msg({ id: 'tasks.start.movedDone', defaultMessage: '{card} was moved to Done meanwhile. Start it again if there is more to do.', description: 'An error: while card {card} (its key, such as HI-12) was being started, it was moved to Done (a board column).' }), { card: cardRef(n) }, { kind: 'conflict' })
        if (now.column !== before.column) throw columnError(msg({ id: 'tasks.start.movedColumn', defaultMessage: "{card} was moved to {column, select, hold {On Hold} todo {Todo} doing {Active} review {Review} passed {Approved} done {Done} other {{column}}} meanwhile. Start it again if it's still to do.", description: 'An error: while card {card} (its key, such as HI-12) was being started, it was moved to the column {column} (select: a board column; translate each).' }), { card: cardRef(n), column: now.column })
        if (now.agent !== before.agent) throw hiveError(msg({ id: 'tasks.start.reassigned', defaultMessage: "{card} was given to {who, select, another {another agent} other {nobody}} meanwhile. Start it again if it's still to do.", description: 'An error: while card {card} (its key, such as HI-12) was being started, it was given to another agent, or taken from its agent ({who}, select: translate each).' }), { card: cardRef(n), who: now.agent ? 'another' : 'nobody' }, { kind: 'conflict' })
      },
      // The caller's authority, as the card is saved (HI-2420).
      ...(commit ? { commit } : {})
    })
  } catch (e) {
    toSlot(null)
    await undoAgent()
    throw e
  }

  // Back where it was (to nobody if its earlier agent has gone), but only while the card is still as this Start
  // left it: a later decision (moved to Done or Review, another project, another agent) stays.
  const back = (agent: string | null): Promise<TaskCard> =>
    updateTask(n, { agent, column: before.column }, actor, {
      check: (now) => {
        if (now.agent !== agentId || now.column !== card.column || now.project !== card.project || now.archived) throw new Error('changed meanwhile') // i18n-ignore: never shown (the card stays as it is)
      }
    })
  let live = false
  // The launch this start made, when it started the agent (#1282: undo stops only that one).
  let run: string | undefined
  try {
    // Its doc sections to read first (#818), with their sizes: in the project's folder or the shared notes, never the
    // agent's own folder (the references are the project's; the agent reads them where it works).
    // What didn't resolve now shows on the card too (#819), cleared when all did: written only if the card still has the
    // list and project that were checked (under the board's lock). If not, the card changed while this Start checked it
    // (its Read first edited, or moved to another project): the Start stops, as one that finds its card changed does,
    // giving the agent nothing and leaving the newer card as it is, to be started again.
    const refs = card.context ?? []
    const context = refs.length ? await contextLines(p, refs) : undefined
    // The card as this Start took it, compared again once the (slow) check is done: its Read first, project, agent and
    // column, not archived and still there. A failed check or write isn't taken for the card being unchanged.
    if (context) {
      const current = await setContextProblems(n, context.flatMap((l) => (l.problem ? [l.problem] : [])), { context: refs, project: card.project, agent: agentId, column: card.column })
      if (!current) throw hiveError(msg({ id: 'tasks.start.changed', defaultMessage: '{card} changed while it was being started (archived, moved, given to another agent, or its Read first edited): start it again if it should still go.', description: "An error: the card {card} (its key, such as HI-12) was changed while Combwork was starting it (archived, moved to another column or project, given to another agent, deleted, or its Read first doc sections edited), so it wasn't given to the agent. Read first is the card's field: keep its name as the card dialog shows it." }), { card: cardRef(n) }, { kind: 'conflict' })
    }
    // A start that got no slot where its project builds in slots (HI-1966) is undone, never its agent launched in the project
    // folder; the user's Start across the rules (with its reason) starts where the agent is, as they chose.
    // Already Active with no slot (HR2's round 1: a start from before this fix, given again) is refused the same way.
    if (!(reason && actor.kind === 'user') && (await startedOutsideSlots(workspaceOf(p), p, n))) throw hiveError(NO_SLOT, { card: cardRef(n), active: before.column === 'doing' ? 'yes' : 'no' }, { kind: 'conflict' })
    const inLane = laneBuilds(await rawLanes(workspaceOf(p)), basename(p), agentId, n)
    const prompt = advanced.get<boolean>(RAW_CARD_START) ? rawTaskPrompt(card, note) : taskPrompt(card, !!sessions.hiveMcp(p), { from: before.column, note, context, attachments: await cardAttachments(workspace, n), inLane })
    // Started in a slot (#1438): Hive gives it to the agent there once the slot is ready (a new conversation where the
    // agent isn't running there), so nothing is typed where it is now. Only while that placement is still to come: a card
    // back from Review for more work keeps its placed cycle, so it is given here like any other (HI-1953).
    if (before.column !== 'doing' && (await placementDue(workspaceOf(p), p, n))) {
      // The caller's authority, after the last await before the card is handed to its slot (HI-2420).
      commit?.()
      slotted = true
      toSlot(prompt)
      if (added && actor.kind !== 'user') emit({ type: 'agent-added', projectPath: p, agentId })
      return { card, agentId, agentName, added, typed: false, slotted: true }
    }
    // Again now: the agent may have started work, or the user typed in it, while the card was taken.
    live = availability(p, agentId, agentName, actor).live
    // And the caller's authority (HI-2420), as here and while the task is typed in (`holds`) or its agent spawned (`allowed`).
    commit?.()
    // A task delivery (#649), given now or not at all: typed into a running agent (and while it is typed, an agent that
    // starts work or that the user types in meanwhile doesn't get the rest), or the prompt it is started with.
    const nd = { agentId, agentName, kind: 'task' as const, from: senderOf(actor), card: n, body: prompt, need: 'free' as const }
    const holds = (): boolean => {
      try {
        commit?.()
        return availability(p, agentId, agentName, actor).live
      } catch {
        return false
      }
    }
    if (live)
      await deliverNow(p, { ...nd, conversation: sessions.liveFor(p, agentId)?.sessionId || null }, holds).catch((e: Error) => {
        throw e instanceof NotGiven ? hiveError(msg({ id: 'tasks.start.notGiven', defaultMessage: "{agent} wasn't given {card}: {why}.", description: "An error: the card {card} (its key, such as HI-12) could not be typed into the terminal of the agent {agent} (its name); {why} says why." }), { agent: agentName, card: cardRef(n), why: errorText(e) }, { cause: e, kind: 'conflict' }) : e
      })
    else run = (await launchWith(p, nd, (line) => sessions.start(p, { agentId, prompt: line, ...(commit ? { allowed: commit } : {}) }))).launched?.runId
  } catch (e) {
    if (!slotted) toSlot(null)
    await back(before.agent)
      .catch(() => back(null))
      .catch(() => undefined)
    await undoAgent()
    throw e
  }
  toSlot(null)
  // The view stays where the user has it; the new agent is marked for them.
  if (added && actor.kind !== 'user') emit({ type: 'agent-added', projectPath: p, agentId })
  return { card, agentId, agentName, added, typed: live, slotted: false, ...(run ? { run } : {}) }
}

/** A card's context references (#818) with each section's size, or why it doesn't resolve now (#819). */
async function contextLines(projectPath: string, refs: string[]): Promise<ContextLine[]> {
  const shared = workspaceOf(projectPath).sharedDir
  return Promise.all(refs.map(async (ref): Promise<ContextLine> => {
    const r = await checkDocRef(projectPath, shared, ref).catch((): DocRefCheck => ({ ref, problem: 'notFound' }))
    return 'size' in r ? { ref, size: r.size } : { ref, problem: { ref, problem: r.problem, ...(r.closest?.length ? { closest: r.closest } : {}) } }
  }))
}
