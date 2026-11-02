// Which board cards a session worked on: each card in Doing for an agent is added to its running session's record
// (sessions.json `cards`, in order, with the title it had then), so the Sessions tab can say "Worked on #5 …"; and each
// card it reviews (TaskCard.review), marked as reviewed, for "Reviewed #5 …".
import { basename } from 'path'
import { agentDoingCards, agentReviewCards } from '../shared/tasks'
import type { LiveSessionState, StoredText, TaskCard } from '../shared/types'
import { coalesced } from './coalesce'
import { createLogger } from './logger'
import { allTasks, commentAsHive, liveCardHeads } from './tasks'
import { workspaceFor, type WorkspaceService } from './workspace'

const log = createLogger('cards')

/**
 * Adds the agent's Doing cards, and those it reviews, to its session's record (only one Hive has recorded). `still`, asked
 * under the file's lock as the record is written: whether that session is still the agent's (a launch's own, #650).
 * `board`: the board as just read, when the caller has it.
 */
export async function recordCards(ws: WorkspaceService, projectPath: string, agentId: string, sessionId: string, still?: () => boolean, board?: TaskCard[]): Promise<void> {
  if (ws.isAssistantHome(projectPath)) return
  const all = board ?? (await liveCardHeads(ws))
  const project = basename(projectPath)
  const cards = [
    ...agentDoingCards(all, project, agentId).map((c) => ({ number: c.number, title: c.title })),
    ...agentReviewCards(all, project, agentId).map((c) => ({ number: c.number, title: c.title, review: true as const }))
  ]
  if (!cards.length) return
  // Worked on and reviewed are kept apart: an agent can review a card it once worked on.
  const has = (list: { number: number; review?: true }[] | undefined, c: { number: number; review?: true }): boolean => !!list?.some((h) => h.number === c.number && !!h.review === !!c.review)
  // Most board changes add nothing (a comment, another agent's card): check before taking the file's lock.
  const now = await ws.sessionRecord(projectPath, sessionId)
  if (!now || cards.every((c) => has(now.cards, c))) return
  await ws.mutateSessions(projectPath, (f) => {
    const rec = f.sessions.find((s) => s.id === sessionId)
    if (!rec || (still && !still())) return
    const had = rec.cards ?? []
    const add = cards.filter((c) => !has(had, c))
    if (add.length) rec.cards = [...had, ...add]
  })
}

/** Records the Doing cards of every running agent in that workspace, from one read of the board. */
export async function recordLiveCards(workspacePath: string, live: LiveSessionState[]): Promise<void> {
  const ws = workspaceFor(workspacePath)
  if (!ws?.path) return
  const running = live.filter((s) => s.sessionId && !s.settingUp && workspaceFor(s.projectPath) === ws)
  if (!running.length) return
  // The live cards' heads (HI-1690): a card's number, title, column, agent and reviewer are all a record needs.
  const all = await liveCardHeads(ws)
  for (const s of running) {
    await recordCards(ws, s.projectPath, s.agentId, s.sessionId!, undefined, all).catch((e) => log.warn(`Could not record the cards of session ${s.sessionId}`, e))
  }
}

/**
 * After the board changed (tasks-changed): records the Doing cards of every running agent in that workspace, one run at a
 * time (#1011): a change during a run gives one more run after it, with the sessions as they are then. Run for each
 * change, a batch of card changes under load piled up reads of the whole board until main ran out of memory (#988).
 */
export function recordLiveCardsSoon(workspacePath: string, live: () => LiveSessionState[]): Promise<void> {
  return coalesced(`live-cards:${workspacePath.toLowerCase()}`, () => recordLiveCards(workspacePath, live()).catch((e) => log.warn('Could not record the cards of running sessions', e)))
}

/** A comment from Hive on each card an agent of a project has in Doing (#606: its model changed after a safeguard stop). */
export async function commentOnDoingCards(ws: WorkspaceService, projectPath: string, agentId: string, said: string | StoredText): Promise<number[]> {
  if (ws.isAssistantHome(projectPath)) return []
  const project = basename(projectPath)
  const out: number[] = []
  // Each checked again under its lock: moved, reassigned or taken to another project meanwhile, it isn't the agent's now.
  for (const c of agentDoingCards(await allTasks(ws, { archived: false }), project, agentId)) if (await commentAsHive(c.number, said, ws, (card) => agentDoingCards([card], project, agentId).length === 1)) out.push(c.number)
  return out
}
