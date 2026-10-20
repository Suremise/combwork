// The durable actions' worker (SPEC §16.4.5, #1215): an action is written in the same transaction as the facts that cause
// it, so nothing outside happens for a change that rolled back; once a change commits, this runs the workspace's pending
// actions in the order written, and at start (a workspace opened) any a crash left pending. Each action's delivery is
// recorded once before its effect runs (`card_actions.delivered`), so an action run twice (a crash between its effect
// and its mark, two runs at once) delivers once. P3 has no effects yet: nothing wakes, notifies or merges; the kinds
// P4 on adds register a handler here. A kind with none is marked done, its delivery recorded, as the no-op it is in P3.

import { boardFile, boardReadOnly, boardWrite, onBoardCommitted, workspaceDb } from '../boardStore'
import { createLogger } from '../logger'
import type { WorkspaceService } from '../workspace'
import { deliverOnce, pendingActionsOf, type ActionRow } from './factStore'

const log = createLogger('workflow')

/** What an action of a kind does, once its delivery is recorded. Throwing marks it failed (it isn't tried again). */
export type ActionHandler = (action: ActionRow, ws: WorkspaceService) => Promise<void> | void

const handlers = new Map<string, ActionHandler>()

/** Registers what an action kind does (P4 on: wakes, notices, the queue's steps). */
export function onAction(kind: string, fn: ActionHandler): void {
  handlers.set(kind, fn)
}

/** For tests: forgets the registered handlers. */
export function clearActionHandlers(): void {
  handlers.clear()
}

/** Per workspace file: the run going on, and whether another was asked for meanwhile. */
const runs = new Map<string, { again: boolean; done: Promise<void> }>()

/**
 * Runs the workspace's pending actions, in the order written: one run at a time per workspace, and a run asked for while
 * one goes on runs again after it (a change that committed meanwhile may have written more). Resolves when no run is
 * left; never throws (a failure is logged, and the action stays for the next run when it wasn't marked).
 */
export function runActions(ws: WorkspaceService): Promise<void> {
  if (!ws.path) return Promise.resolve()
  const key = boardFile(ws.path).toLowerCase()
  const running = runs.get(key)
  if (running) {
    running.again = true
    return running.done
  }
  const run = { again: false, done: Promise.resolve() }
  run.done = (async () => {
    try {
      do {
        run.again = false
        await drain(ws)
      } while (run.again)
    } catch (e) {
      log.warn('running the cards’ actions', e)
    } finally {
      runs.delete(key)
    }
  })()
  runs.set(key, run)
  return run.done
}

async function drain(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  // A board that takes no writes (waiting for its upgrade, or a newer Hive's): nothing can be marked.
  if (!path || boardReadOnly(ws)) return
  // Each action read again as it is now: another Hive's run, or ours, may have marked it meanwhile.
  for (const a of pendingActionsOf(workspaceDb(path).reader)) {
    if (ws.path !== path) return
    const handler = handlers.get(a.kind)
    let state: ActionRow['state'] = 'done'
    const first = await boardWrite(ws, async () => {
      const db = workspaceDb(path).writer
      const still = db.prepare("SELECT 1 FROM card_actions WHERE id = ? AND state = 'pending'").get(a.id)
      return still ? deliverOnce(db, { action: a.id, kind: a.kind, target: '', payload: a.payload }) : null
    })
    // Marked by another run meanwhile: nothing to do.
    if (first === null) continue
    if (first && handler) {
      try {
        await handler(a, ws)
      } catch (e) {
        state = 'failed'
        log.warn(`action ${a.id} (${a.kind}) of #${a.card} failed`, e)
      }
    }
    await boardWrite(ws, async () => {
      workspaceDb(path).writer.prepare("UPDATE card_actions SET state = ?, attempts = attempts + 1 WHERE id = ? AND state = 'pending'").run(state, a.id)
    })
  }
}

/** After a change commits: its actions, if it wrote any (a look at the pending index, cheap when there are none). */
onBoardCommitted((ws) => {
  if (!ws.path) return
  let pending = false
  try {
    pending = !!workspaceDb(ws.path).reader.prepare("SELECT 1 FROM card_actions WHERE state = 'pending' LIMIT 1").get()
  } catch {
    // A board without the facts step's tables (not upgraded): no actions.
    return
  }
  if (pending) void runActions(ws)
})
