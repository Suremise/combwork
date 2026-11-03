import type { AgentBranchStatus, LiveSessionState, ProjectInfo } from './types'
import type { StartFailure } from './startFailure'
import { providerDescriptor } from './providers'
import { fmt, msg, tr } from './i18n'

/**
 * The attention inbox: the agents that need you (waiting in their pane at a prompt or for input, for a sign-in, with a
 * question pending, stopped by an error, on another model after a safeguard stop (#606), or failed to start), oldest
 * first; apart from them (#1632: never counted as a need), those finished since you last had their pane on screen; and
 * below them worktree agents with work to review (not counted). One list for the status bar's popover, the tray menu,
 * the Projects badge and the project list's counts.
 */
export interface InboxItem {
  projectPath: string
  projectName: string
  agentId: string
  agentName: string
  /** The Hive Assistant's agent: it opens the Assistant's panel. */
  assistant: boolean
  /** safeguard: its model changed after its CLI's safety classifier stopped a response, not looked at since (#606). */
  kind: 'waiting' | 'signin' | 'question' | 'error' | 'safeguard' | 'finished' | 'failed' | 'review'
  /** When it got to this state (ISO), '' when not known. */
  since: string
  message?: string
  /** safeguard: the models it moved between (their names), worded when shown. */
  switched?: { from: string; to: string }
  /** A worktree agent's unmerged work. */
  branch?: AgentBranchStatus
}

export interface Inbox {
  needYou: InboxItem[]
  /** Finished since you last looked (#1632): told quietly, not as a need. */
  finished: InboxItem[]
  toReview: InboxItem[]
}

/**
 * A person is asked something: the agent waits for an answer, or has a question pending beside its work. What the
 * header, inbox, taskbar flash, chime and notifications all go by.
 */
export function asksYou(live: Pick<LiveSessionState, 'status' | 'question'> | null | undefined): boolean {
  return !!live && (live.status === 'waiting' || live.status === 'signin' || !!live.question)
}

/** Finished and not looked at since (#1632: told apart from what needs you). */
export function finishedUnseen(live: Pick<LiveSessionState, 'status' | 'unseen'> | null | undefined): boolean {
  return !!live && live.status === 'finished' && live.unseen
}

/** Unmerged commits or uncommitted files on a worktree agent's branch. */
export function hasWork(b: AgentBranchStatus | null | undefined): b is AgentBranchStatus {
  return !!b && (b.ahead > 0 || b.dirty > 0)
}

/** Not doing anything (stopped, ready or finished), so its work can be reviewed. */
const idle = (live: LiveSessionState | null): boolean => !live || live.status === 'ready' || live.status === 'finished' || live.status === 'stopped'

/** Oldest first; unknown times last. */
const byAge = (a: InboxItem, b: InboxItem): number => (a.since || '￿').localeCompare(b.since || '￿')

/** The Hive Assistant's name where an inbox row names its project. */
const ASSISTANT_NAME = msg({ id: 'board.inbox.assistant', defaultMessage: 'Assistant', description: "The Hive Assistant, named in the attention inbox (status bar popover, tray menu) where a project name goes. Hive is the app's name: keep it." })

/**
 * An inbox row's project as the window shows it, worded when shown (#798): the Assistant's name follows a change of
 * language even in an inbox built before it (projectName is worded when built, for the tray).
 */
export const inboxName = (i: InboxItem): string => (i.assistant ? tr(ASSISTANT_NAME) : i.projectName)

/** `failureOf`: why an agent's last launch failed to start, where the caller knows (the window does; the tray doesn't). */
export function inbox(
  projects: readonly ProjectInfo[],
  assistant: ProjectInfo | null | undefined,
  branchOf: (projectPath: string, agentId: string) => AgentBranchStatus | null | undefined,
  failureOf?: (projectPath: string, agentId: string) => Pick<StartFailure, 'reason' | 'at'> | undefined
): Inbox {
  const needYou: InboxItem[] = []
  const finished: InboxItem[] = []
  const toReview: InboxItem[] = []
  const hosts = assistant ? [...projects, assistant] : projects
  for (const p of hosts) {
    const isAssistant = p === assistant
    for (const a of p.agents) {
      const live = a.live
      // Its 0.9 worktree's work not merged yet, while it still works there (#1442).
      const branch = a.place.is === 'legacy' ? branchOf(p.path, a.id) : null
      const item = (kind: InboxItem['kind']): InboxItem => ({
        projectPath: p.path,
        projectName: isAssistant ? tr(ASSISTANT_NAME) : p.name,
        agentId: a.id,
        agentName: a.name,
        assistant: isAssistant,
        kind,
        since: live?.statusSince ?? '',
        ...(live?.statusMessage ? { message: live.statusMessage } : {}),
        ...(hasWork(branch) ? { branch } : {})
      })
      const failure = live ? undefined : failureOf?.(p.path, a.id)
      if (failure) needYou.push({ ...item('failed'), since: failure.at, message: failure.reason.split('\n')[0] })
      else if (live?.status === 'waiting') needYou.push(item('waiting'))
      else if (live?.status === 'signin') needYou.push(item('signin'))
      else if (live?.question) needYou.push({ ...item('question'), since: live.question.since, ...(live.question.text ? { message: live.question.text } : {}) })
      else if (live?.safeguard?.switched && live.safeguard.unseen) {
        const label = providerDescriptor(live.provider).modelLabel
        needYou.push({ ...item('safeguard'), since: live.safeguard.switched.at, switched: { from: label(live.safeguard.switched.from), to: label(live.safeguard.switched.to) } })
      }
      // Stopped by an error (#1632: its turn ended on an API connection error, say): it does nothing until someone
      // looks, and leaves once its next turn starts.
      else if (live?.failedTurn) {
        // The CLI's words, or none (Hive's own status message isn't them: the row then says only that it stopped).
        const { message: _status, ...plain } = item('error')
        needYou.push({ ...plain, since: live.failedTurn.since, ...(live.failedTurn.message ? { message: live.failedTurn.message } : {}) })
      }
      else if (live?.status === 'error') needYou.push(item('error'))
      else if (finishedUnseen(live)) finished.push(item('finished'))
      else if (hasWork(branch) && idle(live)) toReview.push(item('review'))
    }
  }
  return { needYou: needYou.sort(byAge), finished: finished.sort(byAge), toReview: toReview.sort(byAge) }
}

/**
 * Several inboxes' items (one inbox per window) as one list, oldest first across them all, each kept with its owner
 * (the window to show it in), and cut to `limit`: the tray menu. Equal times keep the windows' order.
 */
export function firstAcross<O>(parts: readonly { owner: O; items: readonly InboxItem[] }[], limit: number): { shown: { owner: O; item: InboxItem }[]; total: number } {
  const all = parts.flatMap(({ owner, items }) => items.map((item) => ({ owner, item }))).sort((x, y) => byAge(x.item, y.item))
  return { shown: all.slice(0, limit), total: all.length }
}

/** "3 files, +120 −40 · 2 commits, 1 uncommitted file", in the language Hive shows. */
export function branchSummary(b: AgentBranchStatus): string {
  const parts: string[] = []
  if (b.diff && b.diff.files) parts.push(tr(msg({ id: 'board.inbox.diff', defaultMessage: '{files, plural, one {# file} other {# files}}, +{insertions} −{deletions}', description: "A worktree agent's unmerged changes, in the attention inbox: how many files differ from its base branch, and the lines added (+) and removed (−)." }), { files: b.diff.files, insertions: fmt.number(b.diff.insertions), deletions: fmt.number(b.diff.deletions) }))
  const counts: string[] = []
  if (b.ahead) counts.push(tr(msg({ id: 'board.inbox.commits', defaultMessage: '{n, plural, one {# commit} other {# commits}}', description: "A worktree agent's unmerged commits, in the attention inbox (\"2 commits\")." }), { n: b.ahead }))
  if (b.dirty) counts.push(tr(msg({ id: 'board.inbox.uncommitted', defaultMessage: '{n, plural, one {# uncommitted file} other {# uncommitted files}}', description: "A worktree agent's files with changes not committed yet, in the attention inbox (\"1 uncommitted file\")." }), { n: b.dirty }))
  if (counts.length) parts.push(fmt.list(counts, 'unit'))
  return parts.join(' · ')
}

/** "Needs input: <its question>", "Needs sign-in", "Asks: <its question>", "Stopped by an error: <it>", "After a safeguard stop: <model>", "Couldn't start: <why>", "Finished", "To review" */
export function inboxStateText(i: InboxItem): string {
  if (i.kind === 'signin') return tr(msg({ id: 'board.inbox.signin', defaultMessage: 'Needs sign-in', description: "An agent in the attention inbox waits for the user to sign in to its CLI (its sign-in was refused or has expired)." }))
  if (i.kind === 'error') return i.message ? tr(msg({ id: 'board.inbox.errorWhat', defaultMessage: 'Stopped by an error: {message}', description: "An agent in the attention inbox stopped because of an error (an API connection error, say) and waits for the user; {message} is what its CLI said (its own words)." }), { message: i.message }) : tr(msg({ id: 'board.inbox.error', defaultMessage: 'Stopped by an error', description: 'An agent in the attention inbox stopped because of an error and waits for the user.' }))
  if (i.kind === 'waiting') return i.message ? tr(msg({ id: 'board.inbox.needsInputWhat', defaultMessage: 'Needs input: {message}', description: "An agent in the attention inbox waits for the user's answer; {message} is what its CLI shows (its own words)." }), { message: i.message }) : tr(msg({ id: 'board.inbox.needsInput', defaultMessage: 'Needs input', description: "An agent in the attention inbox waits for the user's answer." }))
  if (i.kind === 'question') return i.message ? tr(msg({ id: 'board.inbox.asksWhat', defaultMessage: 'Asks: {message}', description: "An agent in the attention inbox has asked the user a question ({message}, in the agent's own words)." }), { message: i.message }) : tr(msg({ id: 'board.inbox.asks', defaultMessage: 'Asks you something', description: 'An agent in the attention inbox has asked the user a question.' }))
  if (i.kind === 'failed') return i.message ? tr(msg({ id: 'board.inbox.failedWhy', defaultMessage: "Couldn't start: {message}", description: "An agent in the attention inbox failed to start; {message} is why (an error's first line)." }), { message: i.message }) : tr(msg({ id: 'board.inbox.failed', defaultMessage: "Couldn't start", description: 'An agent in the attention inbox failed to start.' }))
  if (i.kind === 'safeguard') return i.switched ? tr(msg({ id: 'board.inbox.safeguardSwitched', defaultMessage: 'After a safeguard stop: Now runs on {to} instead of {from}', description: "An agent in the attention inbox whose CLI's safety classifier stopped a response, so it moved to another model: {to} and {from} are the models' names." }), i.switched) : tr(msg({ id: 'board.inbox.safeguard', defaultMessage: 'After a safeguard stop', description: "An agent in the attention inbox whose CLI's safety classifier stopped a response." }))
  return i.kind === 'finished' ? tr(msg({ id: 'board.inbox.finished', defaultMessage: 'Finished', description: 'An agent in the attention inbox finished its turn and the user has not looked at it since.' })) : tr(msg({ id: 'board.inbox.toReview', defaultMessage: 'To review', description: 'A worktree agent in the attention inbox has unmerged work for the user to review.' }))
}
