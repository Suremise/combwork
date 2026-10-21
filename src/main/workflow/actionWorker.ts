// The durable actions' worker (SPEC §16.4.5, #1215): an action is written in the same transaction as the facts that cause
// it, so nothing outside happens for a change that rolled back; once a change commits, this runs the workspace's pending
// actions in the order written, and at start (a workspace opened) any a crash left pending. Each runs at most once in
// effect, however often it is run (a crash between its effect and its mark, two runs at once, another Hive's), in one of
// two ways (#1266):
// - **Delivered**: a handler that makes a delivery gives it the action's id, and the delivery's row (unique per action,
//   `deliveries.action`) is the record that it was made. The handler runs again until the action is marked, and finds
//   that row each time after the first: one delivery.
// - **Claimed**: every other kind (a notice, a kind with no handler) is marked done before its effect runs, by a
//   conditional update, so only the run that moved it from pending runs it: at most once (a notice lost to a crash
//   isn't shown twice).
//
// A run belongs to the workspace as it was when it began (HR4's #1215 round 1): once that workspace closes, or its window
// opens another, the run stops, checked after every wait and inside each board change, before the board is touched,
// so a closed board is never opened again for it nor another workspace's written.

import { boardFile, boardRead, boardReadOnly, boardWrite, boardWriteOp, onBoardCommitted } from '../boardStore'
import { createLogger } from '../logger'
import type { WorkspaceService } from '../workspace'
import { pendingActionsOf, type ActionRow } from './factStore'

const log = createLogger('workflow')

/** What an action of a kind does. Throwing marks it failed (it isn't tried again). */
export type ActionHandler = (action: ActionRow, ws: WorkspaceService) => Promise<void> | void

/**
 * How an action of a kind is kept to once (the top): `delivered`, its handler's delivery carries the action's id and a
 * run finds it made; `claimed`, it is marked done before it runs.
 */
export type ActionOnce = 'delivered' | 'claimed'

const handlers = new Map<string, { fn: ActionHandler; once: ActionOnce }>()

/** Registers what an action kind does (P4 on: wakes, notices, the queue's steps), and how it is kept to once. */
export function onAction(kind: string, fn: ActionHandler, once: ActionOnce = 'claimed'): void {
  handlers.set(kind, { fn, once })
}

/** For tests: forgets the registered handlers. */
export function clearActionHandlers(): void {
  handlers.clear()
}

/** A run's workspace as it began: whether it is still that one, open. */
interface RunOf {
  ws: WorkspaceService
  path: string
  life: AbortSignal
  alive: () => boolean
}

/**
 * Per workspace file, the run going on: whether another was asked for meanwhile, and the workspaces (windows) that asked
 * for it, each as it was when it asked. The run goes on in the newest of them still open: one whose window closed or
 * switched hands what is left to another that asked (HR4's #1215 round 2), never ending a request still wanted. One
 * requester per window and lifetime (#1240): asking again replaces its earlier request (made the newest), and requests
 * no longer alive are dropped as one comes in, so the list is at most the windows open on the file, however often
 * changes ask while a run goes on.
 */
const runs = new Map<string, { again: boolean; by: RunOf[]; done: Promise<void> }>()

/**
 * Runs the workspace's pending actions, in the order written: one run at a time per workspace file, and a run asked for
 * while one goes on runs again after it (a change that committed meanwhile may have written more), in a workspace still
 * open on that file. Resolves when no run is left; never throws (a failure is logged, and an action not marked stays
 * for the next run).
 */
export function runActions(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  if (!path) return Promise.resolve()
  const life = ws.lifetime
  const at: RunOf = { ws, path, life, alive: () => !life.aborted && ws.lifetime === life && ws.path === path }
  const key = boardFile(path).toLowerCase()
  const running = runs.get(key)
  if (running) {
    running.by = [...running.by.filter((x) => x.alive() && !(x.ws === ws && x.life === life)), at]
    running.again = true
    return running.done
  }
  const run = { again: false, by: [at], done: Promise.resolve() }
  run.done = (async () => {
    try {
      for (;;) {
        run.by = run.by.filter((x) => x.alive())
        const current = run.by.at(-1)
        if (!current) return
        run.again = false
        try {
          await drain(current)
        } catch (e) {
          // Its workspace closed or switched under it: another that asked goes on. Else a failure: logged, and the run ends.
          if (current.alive()) {
            log.warn('running the cards’ actions', e)
            return
          }
          continue
        }
        // Done in a workspace still open, nothing more asked for: the run ends. Stopped by a close or a switch, or asked again: once more.
        if (current.alive() && !run.again) return
      }
    } finally {
      runs.delete(key)
    }
  })()
  runs.set(key, run)
  return run.done
}

/** Whether a run of the actions is going on (on any workspace's file). */
export const actionsRunning = (): boolean => runs.size > 0

/** Resolves once no run of the actions is going on: what a change's actions started (its handlers' work) has run. */
export async function actionsSettled(): Promise<void> {
  while (runs.size) await Promise.allSettled([...runs.values()].map((r) => r.done))
}

/** For tests: how many requesters the run going on for a workspace's file holds (0: none going on). */
export function runRequesters(path: string): number {
  return runs.get(boardFile(path).toLowerCase())?.by.length ?? 0
}

/** A change of the run's board, only while its workspace is the one the run began in (checked again inside the lock). */
function change<T>(at: RunOf, fn: () => T): Promise<T | null> {
  if (!at.alive()) return Promise.resolve(null)
  return boardWrite(at.ws, async () => fn(), { alive: at.alive })
}

async function drain(at: RunOf): Promise<void> {
  const { ws } = at
  // A board that takes no writes (waiting for its upgrade, or a newer Hive's): nothing can be marked.
  if (!at.alive() || boardReadOnly(ws)) return
  const pending = boardRead(ws, (db) => pendingActionsOf(db))
  for (const a of pending) {
    if (!at.alive()) return
    const handler = handlers.get(a.kind)
    const claimed = !handler || handler.once === 'claimed'
    // Each action as it is now: another run (another Hive's, or ours) may have marked it meanwhile. A claimed one is
    // marked done here, by the run that finds it pending: only that run goes on with it.
    const mine = await change(at, () =>
      boardWriteOp(ws, (db) =>
        claimed
          ? Number(db.prepare("UPDATE card_actions SET state = 'done', attempts = attempts + 1 WHERE id = ? AND state = 'pending'").run(a.id).changes) > 0
          : !!db.prepare("SELECT 1 FROM card_actions WHERE id = ? AND state = 'pending'").get(a.id)
      )
    )
    // Closed or switched while the claim committed (a listener of that commit may close it): no handler runs for it.
    if (!at.alive()) return
    if (!mine || !handler) continue
    let failed = false
    try {
      await handler.fn(a, ws)
    } catch (e) {
      failed = true
      log.warn(`action ${a.id} (${a.kind}) of #${a.card} failed`, e)
    }
    // Closed or switched while the handler ran: a delivered one's mark waits for the next run there, which finds its
    // delivery made and makes none. A claimed one is already done (a failure is still recorded, when it can be).
    await change(at, () =>
      boardWriteOp(ws, (db) =>
        claimed
          ? failed && db.prepare("UPDATE card_actions SET state = 'failed' WHERE id = ? AND state = 'done'").run(a.id)
          : db.prepare("UPDATE card_actions SET state = ?, attempts = attempts + 1 WHERE id = ? AND state = 'pending'").run(failed ? 'failed' : 'done', a.id)
      )
    )
  }
}

/** After a change commits: its actions, if it wrote any (a look at the pending index, cheap when there are none). */
onBoardCommitted((ws) => {
  if (!ws.path) return
  let pending = false
  try {
    pending = boardRead(ws, (db) => !!db.prepare("SELECT 1 FROM card_actions WHERE state = 'pending' LIMIT 1").get())
  } catch {
    // A board without the facts step's tables (not upgraded): no actions.
    return
  }
  if (pending) void runActions(ws)
})
