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

import { advanced } from '../advanced'
import { onHiveEvent } from '../events'
import { createLogger, userText } from '../logger'
import { coalesced } from '../coalesce'
import { isUnknown } from '../platform/types'
import { LINE_GATE } from '../../shared/workflow/facts'
import { FOR_YOU, workflowText } from '../../shared/workflow/texts'
import { openWorkspaces, type WorkspaceService } from '../workspace'
import type { LineBehind, Workflow } from './runtime'

const log = createLogger('workflow')

/** The Advanced switch (#1271): Hive moves an agent's branch after a squash merge (on), or asks the user every time. */
export const UPDATE_AGENT_BRANCH = 'hive.workflow.updateAgentBranch'

/** Whether an agent is in a turn (busy): set by main from its sessions; idle when unset (unit tests set it). */
let busy: (project: string, agent: string) => boolean = () => false
export function setAgentBusy(fn: ((project: string, agent: string) => boolean) | null): void {
  busy = fn ?? (() => false)
}

/** The lanes waiting while their builder's branch is brought up to date: lane id → the card that waits. */
const waiting = new Map<string, number>()
/** The lane a waiting card is, for lanes.ts's status ("waiting: bringing B1's branch up to date"). */
export const lineWaiting = (lane: string): number | null => waiting.get(lane) ?? null

const told = new Set<(ws: WorkspaceService) => void>()
/** Told when a lane starts or stops waiting here (lanes.ts reads its status again). */
export function onLineWaitChanged(fn: (ws: WorkspaceService) => void): () => void {
  told.add(fn)
  return () => told.delete(fn)
}

/** One pass over a workspace's running lanes: each next card's builder's line brought up to date where it is held up. */
export async function updateLines(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  if (!path) return
  const { workflowEnforced, workflowFor } = await import('./service')
  let moved = false
  const seen = new Set<string>()
  for (const project of await ws.listProjectPaths()) {
    const wf = workflowEnforced() ? await workflowFor(ws, project).catch(() => null) : null
    if (!wf) continue
    for (const id of wf.store.runningLanes()) {
      seen.add(id)
      try {
        const r = await laneLine(wf, project, id)
        if (r === null) {
          if (waiting.delete(id)) moved = true
        } else if (waiting.get(id) !== r) {
          waiting.set(id, r)
          moved = true
        }
      } catch (e) {
        log.warn(`bringing lane ${id}'s builder's branch up to date`, e)
      }
    }
  }
  // Lanes no longer running here (ended, or the rules turned off): not waiting.
  for (const id of [...waiting.keys()]) if (!seen.has(id) && waiting.delete(id)) moved = true
  if (moved && ws.path === path) for (const fn of told) fn(ws)
}

/** A lane's builder's line, between its cards: what was done, and the card that waits meanwhile (null: none waits here). */
async function laneLine(wf: Workflow, project: string, id: string): Promise<number | null> {
  const l = wf.lane(id)
  if (!l || l.ended) return null
  // The lane's next card: the first not Done, and only before it starts (between cards).
  const nextId = wf.laneNow(l).cards.find((c) => !wf.laneDone(c))
  if (nextId === undefined) return null
  const next = wf.store.card(nextId)
  const s = wf.state(next)
  if (s.stage !== 'todo') return null
  const b = await wf.lineBehind(next)
  if (!b) return null
  // Asked about this head already (and answered, or still open): an approval to move it once is all that goes on here.
  const asked = Object.values(s.made).filter((r) => r.gate === LINE_GATE && r.revision === b.head)
  const open = s.requests.some((r) => r.gate === LINE_GATE)
  const approved = asked.some((r) => s.approvals.some((a) => a.request === r.request && a.answer === 'approved'))
  if (open) return null
  if (!advanced.get(UPDATE_AGENT_BRANCH) && !approved) {
    if (!asked.length) await wf.askAboutLine(b, 'approve', text(FOR_YOU.lineAsk, b))
    return null
  }
  // A question about this head answered other than by an approval: the user has it in hand.
  if (asked.length && !approved) return null
  // 1. A safe moment: the builder idle, with no run going, and its worktree clean.
  if (busy(project, b.builder) || (wf.cfg.runsOf?.(b.builder) ?? []).length || b.dirty.length) return next.id
  // 2. Nothing on the branch that isn't in the target.
  const lost = await wf.lineWorkNotIn(b)
  if (isUnknown(lost)) return next.id
  if (lost.length) {
    await wf.askAboutLine(b, 'decide', text(FOR_YOU.lineWork, b, { commits: lost.join(', ') }))
    return null
  }
  // 3. Moved, recorded; or git's reason asked about.
  const r = await wf.moveLineOn(b)
  if (r === true) {
    log.info(`Moved ${userText(b.line ?? b.folder)} to ${userText(b.target)} after ${b.prev.key}'s squash merge, before ${b.next.key}`)
    return null
  }
  await wf.askAboutLine(b, 'decide', text(FOR_YOU.lineRefused, b, { reason: r }))
  return null
}

const text = (m: (typeof FOR_YOU)[keyof typeof FOR_YOU], b: LineBehind, more: Record<string, string> = {}) => workflowText(m, { line: b.line ?? b.folder, card: b.prev.key, next: b.next.key, target: b.target, ...more })

const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** A pass soon (once things settle), one at a time per workspace. */
function soon(ws: WorkspaceService): void {
  const k = ws.path?.toLowerCase()
  if (!k || timers.has(k)) return
  const t = setTimeout(() => {
    timers.delete(k)
    void coalesced(`lines:${k}`, () => updateLines(ws).catch((e) => log.warn('bringing builders\' branches up to date', e)))
  }, 1000)
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
