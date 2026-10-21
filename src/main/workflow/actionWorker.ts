// The durable actions' worker (SPEC §16.4.5, #1215): an action is written in the same transaction as the facts that cause
// it, so nothing outside happens for a change that rolled back; once a change commits, this runs the workspace's pending
// actions in the order written, and at start (a workspace opened) any a crash left pending. However often an action is
// run (a crash between its effect and its mark, a close, two runs at once, another Hive's), its effect is kept to once
// in one of three ways (#1266, SPEC §16.4.5):
// - **Delivered**: a handler that makes a delivery gives it the action's id, and the delivery's row (unique per action,
//   `deliveries.action`) is the record that it was made. The handler runs again until the action is marked, and finds
//   that row each time after the first: one delivery, never lost.
// - **Repeatable**: an effect that leaves nothing to find (a notice shown). One Hive at a time runs it: its lease
//   (`lease_owner`, this process's id, and `lease_until`), taken by a conditional update only one writer wins, while it
//   is unleased, its lease has passed (its Hive ended), or it is this process's and no run here is on it. The handler
//   counts its dispatch (`dispatch()`: `attempts`, under the lease) just before the effect: a dispatch not followed by
//   its mark is uncertain (shown, or not). The action stays pending until marked, so a crash or a close before the effect
//   never loses it (its next run, after the lease, dispatches it), one after it repeats it at most once (never past two
//   uncertain dispatches), and two Hives at once never both run it.
// - **Claimed**: a kind with no effect here (no handler: the queue's and slots' steps until P5 and P7) is marked done by
//   a conditional update, by the one run that finds it pending.
//
// A run belongs to the workspace as it was when it began (HR4's #1215 round 1): once that workspace closes, or its window
// opens another, the run stops, checked after every wait and inside each board change, before the board is touched,
// so a closed board is never opened again for it nor another workspace's written.

import { randomUUID } from 'crypto'
import { boardFile, boardRead, boardReadOnly, boardWrite, boardWriteOp, onBoardCommitted } from '../boardStore'
import { createLogger } from '../logger'
import type { WorkspaceService } from '../workspace'
import type { DatabaseSync } from 'node:sqlite'
import { pendingActionsOf, type ActionRow } from './factStore'

const log = createLogger('workflow')

/**
 * What an action of a kind does. Throwing marks it failed (it isn't tried again). A repeatable one calls `dispatch()`
 * just before its effect, and has none when it says false (its lease is gone, or its workspace).
 */
export type ActionHandler = (action: ActionRow, ws: WorkspaceService, ctx: { dispatch: () => Promise<boolean> }) => Promise<void> | void

/**
 * How an action of a kind is kept to once (the top): `delivered`, its handler's delivery carries the action's id and a
 * run finds it made; `repeatable`, tried at most twice, never lost; `claimed`, marked done before it runs.
 */
export type ActionOnce = 'delivered' | 'repeatable' | 'claimed'

/** How many uncertain dispatches a repeatable action has at most: once, and once more after a crash that may have come after it. */
const MAX_TRIES = 2
/** How long a repeatable action's lease holds: past it, the Hive that took it is taken to have ended. */
const LEASE_MS = 2 * 60_000
/** This process's id on the leases it takes (`owner` for tests: another Hive's). */
let OWNER: string = randomUUID()
/** Repeatable actions a run of this process is on now: never taken again here meanwhile. */
const handling = new Set<number>()
/** For tests: this worker as another process (its own id), as two Hives on one board are. */
export function setWorkerOwnerForTests(owner: string): void {
  OWNER = owner
}

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
    const once: ActionOnce = handler?.once ?? 'claimed'
    // A repeatable one another Hive holds (tried again when its lease passes), or a run here is on: left, with no board
    // change (each one would start another run).
    if (once === 'repeatable' && !boardRead(ws, (db) => free(db, ws, a.id))) continue
    // Each action as it is now: another run (another Hive's, or ours) may have marked it meanwhile. A claimed one is
    // marked done here, by the run that finds it pending; a repeatable one is leased here, by the one run that wins its
    // lease (one with two uncertain dispatches already is done: never a third); only that run goes on with it.
    const mine = await change(at, () => boardWriteOp(ws, (db) => take(db, ws, a.id, once)))
    // Closed or switched while the claim committed (a listener of that commit may close it): no handler runs for it.
    if (!at.alive()) return
    if (!mine || !handler) continue
    if (once === 'repeatable') handling.add(a.id)
    let failed = false
    try {
      // A repeatable one's dispatch: counted under its lease just before its effect (uncertain until it is marked).
      const dispatch = async (): Promise<boolean> =>
        once !== 'repeatable' || (!!(await change(at, () => boardWriteOp(ws, (db) => Number(db.prepare("UPDATE card_actions SET attempts = attempts + 1 WHERE id = ? AND state = 'pending' AND lease_owner = ? AND lease_until > ?").run(a.id, OWNER, new Date().toISOString()).changes) > 0))) && at.alive()) // i18n-ignore: SQL
      await handler.fn(a, ws, { dispatch })
    } catch (e) {
      failed = true
      log.warn(`action ${a.id} (${a.kind}) of #${a.card} failed`, e)
    } finally {
      handling.delete(a.id)
    }
    // Closed or switched while the handler ran: its mark waits for the next run there, which finds a delivered one's
    // delivery made, and runs a repeatable one again (its dispatch, if it was counted, uncertain). A claimed one is
    // already done (a failure is still recorded, when it can be).
    await change(at, () =>
      boardWriteOp(ws, (db) => {
        if (once === 'claimed') return failed && db.prepare("UPDATE card_actions SET state = 'failed' WHERE id = ? AND state = 'done'").run(a.id) // i18n-ignore: SQL
        if (once === 'delivered') return db.prepare("UPDATE card_actions SET state = ?, attempts = attempts + 1 WHERE id = ? AND state = 'pending'").run(failed ? 'failed' : 'done', a.id) // i18n-ignore: SQL
        return db.prepare("UPDATE card_actions SET state = ?, lease_owner = NULL, lease_until = NULL WHERE id = ? AND state = 'pending' AND lease_owner = ?").run(failed ? 'failed' : 'done', a.id, OWNER) // i18n-ignore: SQL
      })
    )
  }
}

/**
 * Takes an action for this run, in its board change (the board's lock: one writer at a time): a claimed one marked done;
 * a delivered one while it is pending; a repeatable one by its lease (the top), the lease another Hive holds tried again
 * once it has passed. False: not this run's.
 */
function take(db: DatabaseSync, ws: WorkspaceService, id: number, once: ActionOnce): boolean {
  if (once === 'claimed') return Number(db.prepare("UPDATE card_actions SET state = 'done', attempts = attempts + 1 WHERE id = ? AND state = 'pending'").run(id).changes) > 0 // i18n-ignore: SQL
  const row = db.prepare("SELECT attempts, lease_owner, lease_until FROM card_actions WHERE id = ? AND state = 'pending'").get(id) as { attempts: number; lease_owner: string | null; lease_until: string | null } | undefined // i18n-ignore: SQL
  if (!row) return false
  if (once === 'delivered') return true
  const now = Date.now()
  const until = row.lease_until ? Date.parse(row.lease_until) : 0
  const held = !!row.lease_owner && until > now
  if (held && row.lease_owner !== OWNER) {
    retryAt(ws, until)
    return false
  }
  if (held && handling.has(id)) return false
  if (row.attempts >= MAX_TRIES) {
    db.prepare("UPDATE card_actions SET state = 'done', lease_owner = NULL, lease_until = NULL WHERE id = ? AND state = 'pending'").run(id) // i18n-ignore: SQL
    return false
  }
  // Only the writer that finds the lease as read takes it.
  const took = db.prepare("UPDATE card_actions SET lease_owner = ?, lease_until = ? WHERE id = ? AND state = 'pending' AND lease_owner IS ? AND lease_until IS ?").run(OWNER, new Date(now + LEASE_MS).toISOString(), id, row.lease_owner, row.lease_until) // i18n-ignore: SQL
  return Number(took.changes) > 0
}

/** Whether a repeatable action may be leased here now: not held by another Hive (its retry timed), nor run here already. */
function free(db: DatabaseSync, ws: WorkspaceService, id: number): boolean {
  if (handling.has(id)) return false
  const row = db.prepare('SELECT lease_owner, lease_until FROM card_actions WHERE id = ?').get(id) as { lease_owner: string | null; lease_until: string | null } | undefined // i18n-ignore: SQL
  const until = row?.lease_until ? Date.parse(row.lease_until) : 0
  if (row?.lease_owner && row.lease_owner !== OWNER && until > Date.now()) {
    retryAt(ws, until)
    return false
  }
  return true
}

/** Per workspace file, a run asked for when another Hive's lease passes (one at a time: the earliest). */
const retries = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>()
function retryAt(ws: WorkspaceService, at: number): void {
  if (!ws.path) return
  const key = boardFile(ws.path).toLowerCase()
  const had = retries.get(key)
  if (had && had.at <= at) return
  if (had) clearTimeout(had.timer)
  const timer = setTimeout(() => {
    retries.delete(key)
    void runActions(ws)
  }, Math.max(0, at - Date.now()) + 50)
  timer.unref?.()
  retries.set(key, { at, timer })
}

/**
 * The pending actions this process could take now (a look at the pending index, cheap when there are none): not one
 * another Hive's lease holds (its retry is timed), nor one a run here is on. So a run's own board changes (a mark, a
 * dispatch) never start another run for nothing.
 */
function takeable(db: DatabaseSync): boolean {
  const rows = db.prepare("SELECT id FROM card_actions WHERE state = 'pending' AND (lease_owner IS NULL OR lease_owner = ? OR lease_until <= ?)").all(OWNER, new Date().toISOString()) as { id: number }[] // i18n-ignore: SQL
  return rows.some((r) => !handling.has(r.id))
}

/** After a change commits: its actions, if it wrote any this process could take. */
onBoardCommitted((ws) => {
  if (!ws.path) return
  let pending = false
  try {
    pending = boardRead(ws, (db) => takeable(db))
  } catch {
    // A board without the facts step's tables (not upgraded): no actions.
    return
  }
  if (pending) void runActions(ws)
})
