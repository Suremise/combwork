import { app } from 'electron'
import { basename } from 'path'
import { tasksWillWake } from '../shared/providers'
import type { LiveSessionState, TaskCard } from '../shared/types'
import { onHiveEvent } from './events'
import { coalesced } from './coalesce'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { liveCardHeads } from './tasks'
import { workspaceOf } from './workspace'

const log = createLogger('loops')

/**
 * Agents in a card loop left with no card watch (#376). An agent that has watched cards in this run of Hive is in a
 * loop; if its turn ends with no live watch while a card it was looping on is still in play, nothing will wake it when
 * that card changes, and its lane stalls (7 Oct: a wake typed into a Codex reviewer was never submitted, and it sat
 * "finished" for hours while the builder waited on it). After a short grace (a wake being taken, a watch being started)
 * those cards are marked on the agent (`notWatching`), so they show as stalled ("R6 isn't watching #333"), and the user
 * is told once. Its cards in play: the ones it last watched, in Doing or Review, and any in Review it is the agent or
 * reviewer of. The Hive Assistant isn't checked: it watches cards as it likes.
 */

/** How long an agent in a loop may sit with no watch before its cards are flagged. */
const GRACE_MS = 45_000
/** Agents remembered as in a loop; the oldest go first. */
const MAX_LOOPS = 500

interface Loop {
  projectPath: string
  agentId: string
  /** The cards of its latest watch. */
  cards: number[]
  timer?: ReturnType<typeof setTimeout>
  /** What the user was last told about (cards, and the idle spell it was in), so each spell is told once. */
  told?: string
}

const loops = new Map<string, Loop>()
const keyOf = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

/** Unpackaged test builds can shorten the grace (HIVE_TEST_LOOP_GRACE_MS). */
function graceMs(): number {
  const v = !app.isPackaged ? Number(process.env.HIVE_TEST_LOOP_GRACE_MS) : NaN
  return Number.isFinite(v) && v >= 0 ? v : GRACE_MS
}

/** An agent started a card watch: it is in a loop, on these cards. */
export function noteLoopWatch(projectPath: string, agentId: string, cards: number[]): void {
  if (workspaceOf(projectPath).isAssistantHome(projectPath)) return
  const k = keyOf(projectPath, agentId)
  const was = loops.get(k)
  if (was?.timer) clearTimeout(was.timer)
  loops.delete(k)
  loops.set(k, { projectPath, agentId, cards: [...cards], told: was?.told })
  while (loops.size > MAX_LOOPS) {
    const oldest = loops.values().next().value!
    if (oldest.timer) clearTimeout(oldest.timer)
    loops.delete(keyOf(oldest.projectPath, oldest.agentId))
  }
}

/**
 * Idle with no watch: its turn has ended and nothing is set to wake it. Background tasks still running will, where its
 * CLI is woken by them (#521: a builder that ended its turn while its e2e run went on was shown as not watching), so it
 * isn't flagged until they end; a CLI that isn't woken by them (Codex) is flagged as before.
 */
export const unwatched = (st: Pick<LiveSessionState, 'status' | 'watch' | 'backgroundTasks' | 'provider'> | null): boolean => !!st && (st.status === 'ready' || st.status === 'finished') && !st.watch && !tasksWillWake(st)

/** A session's status changed: an agent in a loop that went idle with no watch is checked after the grace. */
function statusChanged(st: LiveSessionState): void {
  const loop = loops.get(keyOf(st.projectPath, st.agentId))
  if (!loop) return
  if (!unwatched(st)) {
    if (loop.timer) clearTimeout(loop.timer)
    loop.timer = undefined
    return
  }
  if (loop.timer || st.notWatching) return
  loop.timer = setTimeout(() => {
    loop.timer = undefined
    void check(loop).catch((e) => log.warn('checking a card loop', e))
  }, graceMs())
  loop.timer.unref?.()
}

/**
 * Its cards still in play, among its own project's (a card moved to another project isn't its any more): the ones it
 * last watched in Doing or Review, and those in Review it is the agent or reviewer of.
 */
export function cardsInPlay(cards: readonly TaskCard[], project: string, agentId: string, watched: readonly number[]): number[] {
  const ours = (c: TaskCard): boolean => c.project.toLowerCase() === project.toLowerCase()
  const mine = (c: TaskCard): boolean => c.agent === agentId || c.review?.agent === agentId
  return cards
    .filter((c) => !c.archived && ours(c) && ((watched.includes(c.number) && (c.column === 'doing' || c.column === 'review')) || (c.column === 'review' && mine(c))))
    .map((c) => c.number)
    .sort((a, b) => a - b)
}

/**
 * The board changed: a mark already made is worked out again, so a card that moved on (Passed, Done, another project,
 * archived) stops showing as stalled, and one that came into play while it still waits with no watch shows. Told once
 * per idle spell, as before.
 */
async function recheck(loop: Loop): Promise<void> {
  const st = sessions.liveFor(loop.projectPath, loop.agentId)
  if (!st?.notWatching || loops.get(keyOf(loop.projectPath, loop.agentId)) !== loop) return
  const inPlay = cardsInPlay(await liveCardHeads(workspaceOf(loop.projectPath)), basename(loop.projectPath), loop.agentId, loop.cards)
  const now = sessions.liveFor(loop.projectPath, loop.agentId)
  if (!now?.notWatching || loops.get(keyOf(loop.projectPath, loop.agentId)) !== loop) return
  sessions.setNotWatching(loop.projectPath, loop.agentId, inPlay.length ? inPlay : null)
}

async function check(loop: Loop): Promise<void> {
  const st = sessions.liveFor(loop.projectPath, loop.agentId)
  if (!unwatched(st) || loops.get(keyOf(loop.projectPath, loop.agentId)) !== loop) return
  const ws = workspaceOf(loop.projectPath)
  const inPlay = cardsInPlay(await liveCardHeads(ws), basename(loop.projectPath), loop.agentId, loop.cards)
  // Read again after the wait: it may have started working or watching meanwhile.
  const now = sessions.liveFor(loop.projectPath, loop.agentId)
  if (!unwatched(now) || loops.get(keyOf(loop.projectPath, loop.agentId)) !== loop) return
  if (!inPlay.length) return
  sessions.setNotWatching(loop.projectPath, loop.agentId, inPlay)
  const told = `${inPlay.join(',')}@${now!.statusSince ?? ''}`
  if (loop.told === told) return
  loop.told = told
  const which = inPlay.map((n) => `#${n}`).join(', ')
  // #777: it did watch, and its watch's wake waits untaken in its prompt (its CLI didn't take the line Hive typed): its
  // cards are stalled for that (cardStall says so), and the user was told of the untaken line already, once.
  if (now!.untakenLine) {
    log.info(`${userText(now!.agentName ?? loop.agentId)} hasn't taken the wake Hive typed for ${which}: it waits in its prompt`)
    return
  }
  log.info(`${userText(now!.agentName ?? loop.agentId)} isn't watching ${which}: its turn ended without a card watch`)
  sessions.notifyNotWatching(loop.projectPath, loop.agentId, inPlay)
}

let started = false

/** Follows session statuses for agents in card loops. Once, at startup. */
export function initLoopCheck(): void {
  if (started) return
  started = true
  onHiveEvent((e) => {
    if (e.type === 'session-status') statusChanged(e.state)
    else if (e.type === 'tasks-changed') {
      for (const loop of loops.values()) {
        if (workspaceOf(loop.projectPath).path?.toLowerCase() !== e.workspacePath.toLowerCase()) continue
        // One check at a time per loop (#1011): a batch of card changes told each one.
        void coalesced(`loop-check:${keyOf(loop.projectPath, loop.agentId)}`, () => recheck(loop).catch((err) => log.warn('checking a card loop', err)))
      }
    }
  })
}
