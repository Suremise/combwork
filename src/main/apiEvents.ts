import { basename, dirname, join, resolve as resolvePath } from 'path'
import type { CombworkEvent, LiveSessionState, ProgressRun } from '../shared/types'
import { activityFields, publicReason } from '../shared/assistantActivity'
import { cardRefText } from '../shared/progress'
import { agentField } from '../shared/advanced'

/**
 * What the Agent API's event stream (`GET /v1/events`) sends of Hive's events, and to whom (#620). Pure, so it is unit
 * tested. An event not listed here is the windows' own (toasts, settings, focus…) and never sent.
 *
 * Every payload is built field by field from an allowlist, never passed through, so a field added to an event later
 * stays inside Hive until it is added here. Nothing private goes out, to any token: no prompt, message, question or
 * reply text, no terminal or CLI output, no command line, no notice body, no setting's value. The workspace token and
 * viewer tokens get every event; a project agent's token (`agent`) only its own project's session, notice, progress,
 * merge-slot and agent events, and none of the Hive Assistant's actions.
 */
export const API_EVENTS = ['session-status', 'session-exit', 'workspace-changed', 'notes-changed', 'skills-changed', 'tasks-changed', 'lanes-changed', 'lane-ended', 'queue-changed', 'progress-changed', 'merge-slots-changed', 'notice', 'notice-resolved', 'assistant-activity', 'agent-added'] as const satisfies readonly CombworkEvent['type'][]

/** A project agent's scope: its workspace and project. */
export interface StreamScope {
  workspace: string
  projectPath: string
}

const same = (a: string, b: string): boolean => resolvePath(a).toLowerCase() === resolvePath(b).toLowerCase()

/** Leaves out what is undefined, so the payload has only the fields the state has. */
const defined = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/**
 * An agent's live state as the stream gives it: what it is doing and how it is set up, never what it was told or said.
 * Left out: its status message (the CLI's own words), a question's, a review's and a sign-in's text, the line Hive typed
 * that it hasn't taken, the messages queued for it (only who from and when), and Hive's internal launch details.
 */
export function publicSessionState(s: LiveSessionState): Record<string, unknown> {
  return defined({
    provider: s.provider,
    projectPath: s.projectPath,
    agentId: s.agentId,
    agentName: s.agentName,
    cwd: s.cwd,
    sessionId: s.sessionId,
    runId: s.runId,
    sessionName: s.sessionName,
    status: s.status,
    statusSince: s.statusSince,
    startedAt: s.startedAt,
    unseen: s.unseen,
    // Hive's own words: "Waiting for the merge slot (B4 is merging #305)".
    mergeSlot: s.mergeSlot,
    // Hive's own words too ("Waiting for #12 → Review"), with the cards, agents or lanes it waits on.
    watch: s.watch && defined({ cards: s.watch.cards, agents: s.watch.agents, lanes: s.watch.lanes, column: s.watch.column, changes: s.watch.changes, label: s.watch.label, since: s.watch.since, limitAt: s.watch.limitAt }),
    notWatching: s.notWatching,
    question: s.question && { since: s.question.since },
    reviewing: s.review ? true : undefined,
    signIn: s.signIn && { since: s.signIn.since },
    untakenLine: s.untakenLine && { since: s.untakenLine.since },
    // Its deliveries not received yet (#647): who from, when and their state, not what they say; and how many are overdue.
    inbox: s.inbox && { unread: s.inbox.unread.map((m) => ({ id: m.id, from: m.from, at: m.at, state: m.state })), overdue: s.inbox.overdue },
    permissionMode: s.permissionMode,
    modeSwitching: s.modeSwitching,
    planMode: s.planMode,
    modelName: s.modelName,
    modelId: s.modelId,
    effort: s.effort,
    costUsd: s.costUsd,
    costEstimated: s.costEstimated,
    contextWindow: s.contextWindow,
    backgroundTasks: s.backgroundTasks,
    settingUp: s.settingUp,
    lockedFiles: s.lockedFiles
  })
}

/** What a run whose title was made from its command line is called outside Hive (Darren's rule for #620). */
export const COMMAND_TITLE = 'a command'

/**
 * A progress run as the API gives it (GET /v1/progress and `progress-changed`): who runs what, how far, how long. Left
 * out: the command line (its arguments can hold a token or a prompt), the step's name, what it waits for, the summary
 * (a reporter's own text, which can quote output) and the log's path. Its title leaves Hive only when it was given on
 * purpose (hive-progress --title, a reporter's or script's own); one made from the command line never does, nor any
 * part of it: the run is "a command", with `titleFromCommand: true`.
 */
export function publicRun(r: ProgressRun): Record<string, unknown> {
  const fromCommand = titleFromCommand(r)
  return {
    id: r.id,
    workspacePath: r.workspacePath,
    projectPath: r.projectPath,
    agentId: r.agentId,
    agentName: r.agentName,
    provider: r.provider,
    source: r.source,
    title: fromCommand ? COMMAND_TITLE : r.title,
    titleFromCommand: fromCommand,
    total: r.total,
    step: r.step,
    estimateMs: r.estimateMs,
    expectedMs: r.expectedMs,
    state: r.state,
    staleReason: r.staleReason,
    stopReason: r.stopReason,
    waiting: r.waiting !== null,
    waitingSince: r.waitingSince,
    exitCode: r.exitCode,
    dismissed: r.dismissed,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt,
    finishedAt: r.finishedAt,
    // What it ran for (#1220), when it says: the card by its reference, the commits, the check's name (not its folder).
    ...(r.card ? { card: cardRefText(r.card) } : {}),
    ...(r.revision ? { revision: r.revision } : {}),
    ...(r.testedCheckout ? { testedCheckout: r.testedCheckout } : {}),
    ...(r.check ? { check: r.check } : {}),
    // How it counted as a check of its card (#1222), once it finished.
    ...(r.counts ? { counts: r.counts } : {})
  }
}

/**
 * Whether a run's title was made from its command line: its reporter says so (hive-progress without --title), or, for a
 * run that doesn't (an older hive-progress, a run kept from before this), the title begins as its command line does.
 * The title and the command are each cut to their own length, so they are compared as far as both go, never whole.
 */
function titleFromCommand(r: ProgressRun): boolean {
  if (r.titleFromCommand) return true
  if (!r.command) return false
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().replace(/…$/, '').trim()
  const title = norm(r.title)
  const command = norm(r.command)
  return !!title && (command.startsWith(title) || title.startsWith(command))
}

/** The payload an event-stream client gets for `event`, or null when it gets nothing. `agent`: null for the workspace and viewer tokens. */
export function apiEventFor(event: CombworkEvent, agent: StreamScope | null): Record<string, unknown> | null {
  const own = (projectPath: string | null): boolean => !agent || (projectPath !== null && same(projectPath, agent.projectPath))
  const ownWorkspace = (workspacePath: string): boolean => !agent || same(workspacePath, agent.workspace)
  switch (event.type) {
    // Another project's session events carry their session names, which can name their cards.
    case 'session-status':
      return own(event.state.projectPath) ? { type: event.type, state: publicSessionState(event.state) } : null
    // Whether it failed to start, not why (the CLI's last lines of output).
    case 'session-exit':
      return own(event.projectPath) ? { type: event.type, projectPath: event.projectPath, agentId: event.agentId, sessionId: event.sessionId, exitCode: event.exitCode, ...(event.failure ? { failedToStart: true } : {}) } : null
    // The other board and folder events carry no more than a path: read what changed with the routes.
    case 'workspace-changed':
      return { type: event.type, workspace: event.workspace?.path ?? null }
    case 'notes-changed':
    case 'skills-changed':
      return { type: event.type }
    case 'tasks-changed':
      return { type: event.type, workspacePath: event.workspacePath }
    // Its lanes (card titles) are read with GET /v1/lanes, a project agent's own.
    case 'lanes-changed':
      return { type: event.type, workspacePath: event.workspacePath }
    // A lane that ended with its cards Done (#1270): an agent's, its project's.
    case 'lane-ended':
      if (!ownWorkspace(event.workspacePath) || !own(join(event.workspacePath, event.project))) return null
      return { type: event.type, workspacePath: event.workspacePath, lane: event.lane, project: event.project, results: event.results }
    // A target's merge queue changed (#1353): read it with GET /v1/queue; an agent's, its project's.
    case 'queue-changed':
      if (!ownWorkspace(event.workspacePath) || !own(event.projectPath)) return null
      return { type: event.type, workspacePath: event.workspacePath, project: basename(event.projectPath), target: event.target }
    // The workspace's runs (publicRun), as GET /v1/progress gives them; an agent's, its project's.
    case 'progress-changed':
      if (!ownWorkspace(event.workspacePath)) return null
      return { type: event.type, workspacePath: event.workspacePath, runs: event.runs.filter((r) => !agent || own(r.projectPath)).map(publicRun) }
    // The slots held or waited for (`project` is the project's folder); an agent's, its project's.
    case 'merge-slots-changed':
      if (!ownWorkspace(event.workspacePath)) return null
      return {
        type: event.type,
        workspacePath: event.workspacePath,
        slots: event.slots
          .filter((s) => own(s.project))
          .map((s) => ({
            project: s.project,
            branch: s.branch,
            holder: s.holder && defined({ kind: s.holder.kind, agentId: s.holder.agentId, name: s.holder.name, cards: s.holder.cards, since: s.holder.since, until: s.holder.until, taken: s.holder.taken }),
            waiting: s.waiting.map((w) => ({ agentId: w.agentId, name: w.name, cards: w.cards, since: w.since }))
          }))
      }
    // What Hive told the user, without its body (an agent's last reply, its question), its title in English.
    case 'notice': {
      const n = event.notice
      if (!own(n.projectPath)) return null
      // Its title in the client's dialect (HI-2465: broadcast says each client's line in its scope), else its English.
      return { type: event.type, notice: { id: n.id, kind: n.kind, title: agentField(n.apiTitle ?? n.title, n.apiTitleText), projectPath: n.projectPath, ...(n.agentId ? { agentId: n.agentId } : {}) } }
    }
    case 'notice-resolved':
    case 'agent-added':
      return own(event.projectPath) ? { type: event.type, projectPath: event.projectPath, agentId: event.agentId } : null
    // The Assistant's actions are the workspace's, not a project's: its line without what it quotes (`brief`: a
    // prompt, a message, a setting's values), and its kind and targets (#763), for viewers that don't read the line.
    case 'assistant-activity': {
      if (agent) return null
      const a = event.action
      // Its home is <workspace>\.combwork\assistant.
      const workspacePath = dirname(dirname(event.projectPath))
      // A refusal's reason in Hive's own words (#763), never its error's text, which can quote what was sent.
      return { type: event.type, workspacePath, action: { id: a.id, at: a.at, text: a.brief ?? a.text, ok: a.ok, ...(a.ok ? {} : { error: a.reason ?? publicReason(undefined) }), ...activityFields(a) } }
    }
    default:
      return null
  }
}
