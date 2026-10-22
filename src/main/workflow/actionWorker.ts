// The durable actions' worker (SPEC §16.4.5, #1215): an action is written in the same transaction as the facts that cause
// it, so nothing outside happens for a change that rolled back; once a change commits, this runs the workspace's pending
// actions in the order written, and at start (a workspace opened) any a crash left pending. However often an action is
// run (a crash between its effect and its mark, a close, two runs at once, another Hive's), its effect is kept to once
// in one of three ways (#1266, SPEC §16.4.5):
// - **Delivered**: a handler that makes a delivery gives it the action's id, and the delivery's row (unique per action,
//   `deliveries.action`) is the record that it was made. The handler runs again until the action is marked, and finds
//   that row each time after the first: one delivery, never lost.
// - **Repeatable**: an effect that leaves nothing to find (a notice shown: best effort, its durable record being the
//   action itself and what the window shows of its source, SPEC §16.4.5). One claim at a time runs it: its lease, a
//   token unique to the claim (`lease_owner`, `<process>/<uuid>`) and an expiry (`lease_until`), taken by a conditional
//   update only one writer wins (while the action is unleased, its lease has passed, or it is an ended run's of this
//   process), and renewed while the handler runs. The handler's effect goes through `dispatch(effect)`: under the claim's
//   token, while the lease holds, `attempts` is counted, and once that commits the effect runs at once (synchronously,
//   nothing awaited between): an uncertain dispatch until the action is marked. A dispatch refused (the lease lost or
//   expired, the workspace gone) leaves the action pending, never done without its effect; completion and release are
//   fenced by the token. So a crash or a close before the effect never loses it, one after it repeats it at most once
//   (never past two uncertain dispatches), and two claims never both run it.
// - **Claimed**: a kind with no effect here (no handler: the queue's and slots' steps until P5 and P7) is marked done by
//   a conditional update, by the one run that finds it pending.
//
// A run belongs to the workspace as it was when it began (HR4's #1215 round 1): once that workspace closes, or its window
// opens another, the run stops, checked after every wait and inside each board change, before the board is touched,
// so a closed board is never opened again for it nor another workspace's written.

import { randomUUID } from 'crypto'
import { boardFile, boardRead, boardReadOnly, boardWrite, boardWriteOp, dbGeneration, onBoardCommitted } from '../boardStore'
import { createLogger } from '../logger'
import type { WorkspaceService } from '../workspace'
import type { DatabaseSync } from 'node:sqlite'
import { pendingActionsOf, withoutWriteFence, type ActionRow } from './factStore'

const log = createLogger('workflow')

/**
 * What an action of a kind does. Throwing marks it failed (it isn't tried again). A repeatable one gives its effect to
 * `dispatch`, which runs it (synchronously, once its dispatch is counted under a lease that holds) and says whether it
 * did; one refused leaves the action pending, retried.
 */
export type ActionHandler = (action: ActionRow, ws: WorkspaceService, ctx: { dispatch: (effect: () => void) => Promise<boolean> }) => Promise<void> | void

/**
 * How an action of a kind is kept to once (the top): `delivered`, its handler's delivery carries the action's id and a
 * run finds it made; `repeatable`, tried at most twice, never lost; `claimed`, marked done before it runs.
 */
export type ActionOnce = 'delivered' | 'repeatable' | 'claimed'

/** How many uncertain dispatches a repeatable action has at most: once, and once more after a crash that may have come after it. */
const MAX_TRIES = 2
/** How long a repeatable action's lease holds unless renewed: past it, the claim that took it is taken to have ended. */
let LEASE_MS = 2 * 60_000
/** This process's part of its claims' tokens (`<process>/<uuid>`): a claim of an ended run here is taken again at once. */
const PROCESS = randomUUID()
/**
 * Repeatable actions a run of this process is on now, with their claims' tokens: never taken again here meanwhile. Keyed
 * by actionKey: an action's id is its workspace database's own (each numbers from 1), so two open workspaces' actions
 * with one id are two actions (HR1's #1266 round 4).
 */
const handling = new Map<string, string>()
/** An action of a workspace's database, as this process's maps key it: the board's file, its generation, the id. */
const actionKey = (ws: WorkspaceService, id: number): string => `${ws.path ? boardFile(ws.path).toLowerCase() : ''}#${ws.path ? dbGeneration(ws.path) : 0}#${id}`
/** For tests: the lease's length (null: two minutes), to test its renewal and expiry without waiting minutes. */
export function setLeaseMsForTests(ms: number | null): void {
  LEASE_MS = ms ?? 2 * 60_000
}
const ours = (token: string | null): boolean => !!token && token.startsWith(`${PROCESS}/`)
/** How long a repeatable action whose dispatch was refused waits before it is taken again here (no run spins on it). */
const RETRY_MS = 1000
/** Refused repeatable actions, until when they wait (a few at most: each one leaves it once its time has passed). */
const cooling = new Map<string, number>()
const coolingNow = (key: string): number | null => {
  const until = cooling.get(key)
  if (until === undefined) return null
  if (until > Date.now()) return until
  cooling.delete(key)
  return null
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
  // Its own course, outside any write fence of the change that set it going (a merge queue's: #1348).
  run.done = withoutWriteFence(async () => {
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
  })
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
    // A repeatable one another claim holds (tried again when its lease passes), or a run here is on: left, with no board
    // change (each one would start another run).
    if (once === 'repeatable' && !boardRead(ws, (db) => free(db, ws, a.id))) continue
    // Each action as it is now: another run (another Hive's, or ours) may have marked it meanwhile. A claimed one is
    // marked done here, by the run that finds it pending; a repeatable one is leased here, by the one claim that wins its
    // lease (one with two uncertain dispatches already is done: never a third); only that run goes on with it.
    const token = once === 'repeatable' ? `${PROCESS}/${randomUUID()}` : ''
    const mine = await change(at, () => boardWriteOp(ws, (db) => take(db, ws, a.id, once, token)))
    // Closed or switched while the claim committed (a listener of that commit may close it): no handler runs for it.
    if (!at.alive()) return
    if (!mine || !handler) continue
    if (once === 'repeatable') await runLeased(at, a, handler.fn, token)
    else await runOnce(at, a, handler.fn, once)
  }
}

/** A delivered or claimed action's handler, then its mark (a delivered one's waits for the next run if it can't be made). */
async function runOnce(at: RunOf, a: ActionRow, fn: ActionHandler, once: ActionOnce): Promise<void> {
  const { ws } = at
  let failed = false
  try {
    await fn(a, ws, { dispatch: async (effect) => (effect(), true) })
  } catch (e) {
    failed = true
    log.warn(`action ${a.id} (${a.kind}) of #${a.card} failed`, e)
  }
  // Closed or switched while the handler ran: its mark waits for the next run there, which finds a delivered one's
  // delivery made. A claimed one is already done (a failure is still recorded, when it can be).
  await change(at, () =>
    boardWriteOp(ws, (db) =>
      once === 'claimed'
        ? failed && db.prepare("UPDATE card_actions SET state = 'failed' WHERE id = ? AND state = 'done'").run(a.id) // i18n-ignore: SQL
        : db.prepare("UPDATE card_actions SET state = ?, attempts = attempts + 1 WHERE id = ? AND state = 'pending'").run(failed ? 'failed' : 'done', a.id) // i18n-ignore: SQL
    )
  )
}

/**
 * A repeatable action's handler under its claim (`token`): the lease renewed while it runs, its effect dispatched under
 * the token while the lease holds, and the action marked by the token only for an outcome that counts (dispatched, or
 * nothing to do); one whose dispatch was refused stays pending, its lease released, and runs again.
 */
async function runLeased(at: RunOf, a: ActionRow, fn: ActionHandler, token: string): Promise<void> {
  const { ws } = at
  const key = actionKey(ws, a.id)
  handling.set(key, token)
  const renew = (): Promise<unknown> => change(at, () => boardWriteOp(ws, (db) => db.prepare("UPDATE card_actions SET lease_until = ? WHERE id = ? AND state = 'pending' AND lease_owner = ? AND lease_until > ?").run(new Date(Date.now() + LEASE_MS).toISOString(), a.id, token, new Date().toISOString()))) // i18n-ignore: SQL
  const renewing = setInterval(() => void renew().catch((e) => log.warn(`renewing the lease of action ${a.id}`, e)), Math.max(10, Math.floor(LEASE_MS / 3)))
  renewing.unref?.()
  let refused = false
  let failed = false
  const dispatch = async (effect: () => void): Promise<boolean> => {
    // Counted under this claim, while its lease holds; the effect runs once that commits, with nothing awaited between.
    const counted = await change(at, () => boardWriteOp(ws, (db) => Number(db.prepare("UPDATE card_actions SET attempts = attempts + 1, lease_until = ? WHERE id = ? AND state = 'pending' AND lease_owner = ? AND lease_until > ?").run(new Date(Date.now() + LEASE_MS).toISOString(), a.id, token, new Date().toISOString()).changes) > 0)) // i18n-ignore: SQL
    if (!counted || !at.alive()) {
      refused = true
      return false
    }
    effect()
    return true
  }
  try {
    await fn(a, ws, { dispatch })
  } catch (e) {
    failed = true
    log.warn(`action ${a.id} (${a.kind}) of #${a.card} failed`, e)
  } finally {
    clearInterval(renewing)
    handling.delete(key)
  }
  // Fenced by the token: a claim whose lease another has taken since marks nothing. Refused: released, pending, run again.
  await change(at, () =>
    boardWriteOp(ws, (db) =>
      refused && !failed
        ? db.prepare("UPDATE card_actions SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND state = 'pending' AND lease_owner = ?").run(a.id, token) // i18n-ignore: SQL
        : db.prepare("UPDATE card_actions SET state = ?, lease_owner = NULL, lease_until = NULL WHERE id = ? AND state = 'pending' AND lease_owner = ?").run(failed ? 'failed' : 'done', a.id, token) // i18n-ignore: SQL
    )
  )
  // Taken again here only after a pause, by its own timer: its release's commit starts no run that would refuse it again.
  if (refused && !failed) {
    cooling.set(key, Date.now() + RETRY_MS)
    if (at.alive()) retryAt(ws, Date.now() + RETRY_MS)
  }
}

/**
 * Takes an action for this run, in its board change (the board's lock: one writer at a time): a claimed one marked done;
 * a delivered one while it is pending; a repeatable one by its lease (the top), with this claim's token. False: not this run's.
 */
function take(db: DatabaseSync, ws: WorkspaceService, id: number, once: ActionOnce, token: string): boolean {
  if (once === 'claimed') return Number(db.prepare("UPDATE card_actions SET state = 'done', attempts = attempts + 1 WHERE id = ? AND state = 'pending'").run(id).changes) > 0 // i18n-ignore: SQL
  const row = db.prepare("SELECT attempts, lease_owner, lease_until FROM card_actions WHERE id = ? AND state = 'pending'").get(id) as { attempts: number; lease_owner: string | null; lease_until: string | null } | undefined // i18n-ignore: SQL
  if (!row) return false
  if (once === 'delivered') return true
  if (!free(db, ws, id)) return false
  if (row.attempts >= MAX_TRIES) {
    db.prepare("UPDATE card_actions SET state = 'done', lease_owner = NULL, lease_until = NULL WHERE id = ? AND state = 'pending'").run(id) // i18n-ignore: SQL
    return false
  }
  // Only the writer that finds the lease as read takes it.
  const took = db.prepare("UPDATE card_actions SET lease_owner = ?, lease_until = ? WHERE id = ? AND state = 'pending' AND lease_owner IS ? AND lease_until IS ?").run(token, new Date(Date.now() + LEASE_MS).toISOString(), id, row.lease_owner, row.lease_until) // i18n-ignore: SQL
  return Number(took.changes) > 0
}

/**
 * Whether a repeatable action may be leased here now: no run here on it, and its lease free, passed, or an ended run's
 * of this process (one another claim holds is tried again when its lease passes).
 */
function free(db: DatabaseSync, ws: WorkspaceService, id: number): boolean {
  const key = actionKey(ws, id)
  if (handling.has(key) || coolingNow(key) !== null) return false
  const row = db.prepare('SELECT lease_owner, lease_until FROM card_actions WHERE id = ?').get(id) as { lease_owner: string | null; lease_until: string | null } | undefined // i18n-ignore: SQL
  const until = row?.lease_until ? Date.parse(row.lease_until) : 0
  if (row?.lease_owner && !ours(row.lease_owner) && until > Date.now()) {
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
function takeable(db: DatabaseSync, ws: WorkspaceService): boolean {
  const rows = db.prepare("SELECT id, lease_owner FROM card_actions WHERE state = 'pending' AND (lease_owner IS NULL OR lease_owner LIKE ? OR lease_until <= ?)").all(`${PROCESS}/%`, new Date().toISOString()) as { id: number }[] // i18n-ignore: SQL
  return rows.some((r) => !handling.has(actionKey(ws, r.id)) && coolingNow(actionKey(ws, r.id)) === null)
}

/** After a change commits: its actions, if it wrote any this process could take. */
onBoardCommitted((ws) => {
  if (!ws.path) return
  let pending = false
  try {
    pending = boardRead(ws, (db) => takeable(db, ws))
  } catch {
    // A board without the facts step's tables (not upgraded): no actions.
    return
  }
  if (pending) void runActions(ws)
})
