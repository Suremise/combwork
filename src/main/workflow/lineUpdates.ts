// An agent's worktree between a lane's cards (SPEC §16.19.2, #1271). Before P7 a builder's own worktree stands in for a
// slot, its branch carrying on from card to card. After a card of it is squashed into its target, the branch isn't in
// the target, so the next card's change would include the squashed work: the runtime refuses that card's start
// (`lane.lineBehind`), and this brings the branch up to date before it, in order:
// 1. Wait for a safe moment: the builder isn't in a turn and has no run going, and the worktree is clean (the lane shows
//    "waiting: bringing B1's branch up to date").
// 2. Check what would be lost: everything on the branch since the card's base must be in the target by the squash's
//    replay; anything else (a commit made after approval) is asked of the user (For you, Decide) and nothing moves.
// 3. Move it (`git reset --keep`, through the platform), recorded as a `LineMoved` on the card just Done, the builder
//    told; git's refusal is asked of the user with its reason, nothing else tried.
// With Settings → Advanced → Bring an agent's branch up to date after a squash merge off, the user is asked every time
// (approve: Hive does it once). With workflow rules off, nothing happens here at all (as before 1.0).
//
// Each question is asked once for the branch's head (bound to it), so a branch nobody touches is never asked about twice.
// Looked at after board changes and when an agent goes idle (its session's status), per open workspace, one pass at a time.

import { AsyncResource } from 'async_hooks'
import { advanced } from '../advanced'
import { boardWaits } from '../boardStore'
import { onHiveEvent } from '../events'
import { createLogger, userText } from '../logger'
import { coalesced } from '../coalesce'
import { gitStep } from '../platform/git'
import { isUnknown } from '../platform/types'
import { LINE_GATE } from '../../shared/workflow/facts'
import { FOR_YOU, workflowText } from '../../shared/workflow/texts'
import { openWorkspaces, type WorkspaceService } from '../workspace'
import { factHeadsOf } from './cardWork'
import type { LineBehind, Workflow } from './runtime'

const log = createLogger('workflow')

/** The Advanced switch (#1271): Hive moves an agent's branch after a squash merge (on), or asks the user every time. */
export const UPDATE_AGENT_BRANCH = 'hive.workflow.updateAgentBranch'

/** Whether an agent is in a turn (busy): set by main from its sessions; idle when unset (unit tests set it). */
let busy: (project: string, agent: string) => boolean = () => false
export function setAgentBusy(fn: ((project: string, agent: string) => boolean) | null): void {
  busy = fn ?? (() => false)
}
/** Whether an agent is in a turn now (setAgentBusy's): a lease's end waits for it too (#1434). */
export const agentBusy = (project: string, agent: string): boolean => busy(project, agent)

/**
 * The lanes waiting while their builder's branch is brought up to date, per workspace (its board's path, lower case;
 * HR2's #1271 round 1): lane id → the card that waits. A workspace closed is forgotten at the next pass.
 */
const waiting = new Map<string, Map<string, number>>()
const keyOf = (ws: WorkspaceService): string | null => ws.path?.toLowerCase() ?? null
/** The card a workspace's lane waits with, for lanes.ts's status ("waiting: bringing the builder's branch up to date"). */
export const lineWaiting = (ws: WorkspaceService, lane: string): number | null => {
  const k = keyOf(ws)
  return k ? (waiting.get(k)?.get(lane) ?? null) : null
}

const told = new Set<(ws: WorkspaceService) => void>()
/** Told when a lane starts or stops waiting here (lanes.ts reads its status again). */
export function onLineWaitChanged(fn: (ws: WorkspaceService) => void): () => void {
  told.add(fn)
  return () => told.delete(fn)
}

/** One pass over a workspace's running lanes: each next card's builder's line brought up to date where it is held up. */
export async function updateLines(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  // A board waiting for its upgrade to 1.0 has no lanes table yet (HI-1694): its upgrade brings the next pass.
  if (!path || boardWaits(ws)) return
  const key = path.toLowerCase()
  // The workspace as the pass began: closed, or its window switched to another, it stops (checked before every move).
  const life = ws.lifetime
  const alive = (): boolean => !life.aborted && ws.lifetime === life && ws.path === path
  const { workflowEnforced, workflowFor } = await import('./service')
  // Workspaces no longer open: forgotten.
  const open = new Set(openWorkspaces().map((w) => keyOf(w)))
  for (const k of [...waiting.keys()]) if (!open.has(k)) waiting.delete(k)
  const mine = waiting.get(key) ?? new Map<string, number>()
  let moved = false
  const seen = new Set<string>()
  for (const project of await ws.listProjectPaths()) {
    const wf = workflowEnforced() && alive() ? await workflowFor(ws, project).catch(() => null) : null
    if (!wf) continue
    // Whether each running lane's card is Done, kept by its facts' head and stage (HI-1780: each board change looks at
    // every running lane's cards up to its next one, each folded again before).
    const lanes = wf.store.runningLanes()
    const heads = factHeadsOf(
      ws,
      lanes.flatMap((id) => {
        const l = wf.lane(id)
        return l && !l.ended ? wf.laneNow(l).cards : []
      })
    )
    const kept = keptDone(ws)
    const done = (n: number): boolean => {
      const at = `${heads.get(n) ?? ''}\n${wf.store.card(n).stage ?? ''}`
      const was = kept.get(n)
      if (was?.at === at) return was.done
      const d = wf.laneDone(n)
      kept.set(n, { at, done: d })
      return d
    }
    for (const id of lanes) {
      seen.add(id)
      try {
        // Each lane's look one git step (#1376).
        const r = await gitStep(() => laneLine(wf, project, id, () => alive() && workflowEnforced(), done))
        if (r === null) {
          if (mine.delete(id)) moved = true
        } else if (mine.get(id) !== r) {
          mine.set(id, r)
          moved = true
        }
      } catch (e) {
        log.warn(`bringing lane ${id}'s builder's branch up to date`, e)
      }
    }
  }
  // Lanes no longer running here (ended, or the rules turned off): not waiting.
  for (const id of [...mine.keys()]) if (!seen.has(id) && mine.delete(id)) moved = true
  if (mine.size) waiting.set(key, mine)
  else waiting.delete(key)
  if (moved && alive()) for (const fn of told) fn(ws)
}

/** Each workspace's lane cards' Done, by card, with the facts' head and stage it was folded from; opened again, afresh. */
const doneOf = new WeakMap<WorkspaceService, { path: string | null; life: unknown; cards: Map<number, { at: string; done: boolean }> }>()
function keptDone(ws: WorkspaceService): Map<number, { at: string; done: boolean }> {
  let c = doneOf.get(ws)
  if (!c || c.path !== ws.path || c.life !== ws.lifetime) doneOf.set(ws, (c = { path: ws.path, life: ws.lifetime, cards: new Map() }))
  return c.cards
}

/** A lane's builder's line, between its cards: what was done, and the card that waits meanwhile (null: none waits here). */
async function laneLine(wf: Workflow, project: string, id: string, on: () => boolean, done: (n: number) => boolean = (n) => wf.laneDone(n)): Promise<number | null> {
  const l = wf.lane(id)
  if (!l || l.ended) return null
  // The lane's next card: the first not Done and not another agent's (HI-1821), and only before it starts (between cards).
  const nextId = wf.laneNow(l).cards.find((c) => !done(c) && wf.laneOwn(id, c))
  if (nextId === undefined) return null
  const next = wf.store.card(nextId)
  const s = wf.state(next)
  if (s.stage !== 'todo') return null
  const b = await wf.lineBehind(next)
  if (!b) return null
  // Asked about this head already (and answered, or still open): an approval to move it once is all that goes on here.
  // (A question about a move that didn't finish is that move's, not this head's: answered, it doesn't stop the next one.)
  const unfinishedAsk = (r: { requestText?: { id: string } }): boolean => r.requestText?.id === FOR_YOU.lineUnfinished.id
  const made = Object.values(s.made).filter((r) => r.gate === LINE_GATE && r.revision === b.head)
  const asked = made.filter((r) => !unfinishedAsk(r))
  const open = s.requests.some((r) => r.gate === LINE_GATE)
  const approved = asked.some((r) => s.approvals.some((a) => a.request === r.request && a.answer === 'approved'))
  // A move begun with no outcome recorded (HR2's rounds 3 and 4): done after all once the line is at its target and
  // clean, not made once it is back where it began and clean (each recorded now); else asked of the user once, the
  // next card held meanwhile. A head alone proves nothing of the files and index: clean is checked too.
  if (b.unfinished) {
    if (b.head === b.unfinished.to && !b.dirty.length) {
      await wf.lineMovedRecord(b, b.unfinished.from, b.unfinished.to)
      return null
    }
    if (b.head === b.unfinished.from && !b.dirty.length) {
      await wf.lineMoveUndoneRecord(b, b.head)
      return null
    }
    if (!made.some(unfinishedAsk) && !open) await wf.askAboutLine(b, 'decide', text(FOR_YOU.lineUnfinished, b, { to: b.unfinished.to.slice(0, 7) }))
    return null
  }
  if (open) return null
  if (advanced.get(UPDATE_AGENT_BRANCH) !== true && !approved) {
    if (!asked.length) await wf.askAboutLine(b, 'approve', text(FOR_YOU.lineAsk, b))
    return null
  }
  // A question about this head answered other than by an approval: the user has it in hand.
  if (asked.length && !approved) return null
  // 1. A safe moment: the builder idle, with no run going, and its worktree clean.
  const safe = (): boolean => !busy(project, b.builder) && !(wf.cfg.runsOf?.(b.builder) ?? []).length
  if (!safe() || b.dirty.length) return next.id
  // 2. Nothing on the branch that isn't in the target.
  const lost = await wf.lineWorkNotIn(b)
  if (isUnknown(lost)) return next.id
  if (lost.length) {
    await wf.askAboutLine(b, 'decide', text(FOR_YOU.lineWork, b, { commits: lost.join(', ') }))
    return null
  }
  // 3. Moved, recorded; or git's reason asked about. Everything checked above is checked again just before the move (the
  // reads since took time): still on, still allowed, still safe; the line itself (its head, the target's, clean) by
  // moveLineOn, the move conditional on that head. Anything changed: nothing moves, and the lane waits for the next pass.
  // A move that failed part way and couldn't be put back throws (LineMoveBroken): its LineMoving holds the next card, and
  // the next pass settles it (above).
  const r = await wf.moveLineOn(b, () => on() && (advanced.get(UPDATE_AGENT_BRANCH) === true || approved) && safe())
  if (r === null) return next.id
  if (r === true) {
    log.info(`Moved ${userText(b.line ?? b.folder)} to ${userText(b.target)} after ${b.prev.key}'s squash merge, before ${b.next.key}`)
    return null
  }
  await wf.askAboutLine(b, 'decide', text(FOR_YOU.lineRefused, b, { reason: r }))
  return null
}

const text = (m: (typeof FOR_YOU)[keyof typeof FOR_YOU], b: LineBehind, more: Record<string, string> = {}) => workflowText(m, { line: b.line ?? b.folder, card: b.prev.key, next: b.next.key, target: b.target, ...more })

const timers = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * Where passes are scheduled from: made as this module loads, with no caller's async context (#1287). A pass scheduled
 * from inside a change (a board event an intent's write fires) would otherwise carry that change's context into its
 * own writes: the intent's `alongside` hook ran in them, writing that card's 0.9 fields from another card's stage.
 */
const root = new AsyncResource('lineUpdates')
/**
 * A pass soon (once things settle), one at a time per workspace. None for a workspace whose board waits for its upgrade
 * to 1.0 (HI-1694): its lanes aren't in their table yet ("no such table: lanes", seen on every agent's change in another
 * window); the upgrade's own board change brings the next pass.
 */
function soon(ws: WorkspaceService): void {
  const k = ws.path?.toLowerCase()
  if (!k || timers.has(k) || boardWaits(ws)) return
  const t = root.runInAsyncScope(() =>
    setTimeout(() => {
      timers.delete(k)
      if (boardWaits(ws)) return
      void coalesced(`lines:${k}`, () => updateLines(ws).catch((e) => log.warn('bringing builders\' branches up to date', e)))
    }, 1000)
  )
  t.unref?.()
  timers.set(k, t)
}

let started = false
/** Looks at the open workspaces' lanes after board changes and when an agent's session changes status. Once, at startup. */
export function startLineUpdates(): void {
  if (started) return
  started = true
  onHiveEvent((e) => {
    if (e.type === 'tasks-changed') {
      const ws = openWorkspaces().find((w) => w.path && w.path.toLowerCase() === e.workspacePath.toLowerCase())
      if (ws) soon(ws)
    } else if (e.type === 'session-status') for (const ws of openWorkspaces()) soon(ws)
  })
}

/** For tests: forgets what waits. */
export function resetLineUpdates(): void {
  waiting.clear()
}
