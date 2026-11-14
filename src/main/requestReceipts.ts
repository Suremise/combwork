import { AsyncLocalStorage } from 'async_hooks'
import { createHash } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { boardRead, setBoardCommitHook } from './boardStore'
import type { WorkspaceService } from './workspace'

/**
 * HI-3195 (Darren's decision of 14 Nov, "ok (b)"; SPEC's Agent API, AGENT_API's request keys): a project agent's write sent with a request key
 * (`X-Combwork-Request`, which cw-mcp makes for each write tool call and sends again on its own retry) is applied once.
 * The write's own board transaction saves a durable "applied" marker for (launch, key) just before it commits (the board's
 * commit hook): the write and its marker commit together, or neither. A retry with the same key then gets "already
 * applied" with what the write produced (a created card's number), never a second write: after a lost reply, a crash or a
 * restart alike. The original reply isn't replayed (Darren's (b)); while Combwork runs, a retry of a request still in
 * flight waits for it and gets its reply. A write of several steps counts as applied at its first board commit.
 *
 * A key is bound to its exact request (its fingerprint: method, route, card and body); reused for another, it is refused
 * (`409 request.keyReused`), never answered with another write's outcome. Markers are kept 24 hours: a retry within that
 * window is never applied again.
 */

/** A request key: cw-mcp's (a UUID, or one with its write's index after it). */
export const REQUEST_KEY = /^[A-Za-z0-9_-]{16,64}$/
/** How long a marker is kept: a retry within this window is never applied again. */
export const RECEIPT_HOURS = 24
/** At most this many keyed requests in flight at once (each joined by its retries); past it, a new key waits its turn (503). */
export const IN_FLIGHT_MAX = 256
/** The longest a retry waits for the request in flight it joined before asking the table (a hung first try). */
export const JOIN_WAIT_MS = 120_000

/** A keyed request: its launch, key, fingerprint and route template, and the card its route names (if any). */
export interface KeyedRequest {
  run: string
  key: string
  fingerprint: string
  route: string
  /** The card its route names, as the request named it (its key, or #n). */
  card?: string
}

/** What a retry of an applied write is answered with. */
export interface Applied {
  replayed: true
  applied: true
  /** What the write produced: a created card's number (`card`), the card it was about. */
  produced: Record<string, unknown>
}

/** A request key reused for another request. */
export class KeyReused extends Error {
  constructor() {
    // agent-protocol: an internal error's tag, never said: servers.ts answers it with its refusal
    super('request key reused') // i18n-ignore: as above
  }
}
/** Too many keyed requests in flight: try again in a moment. */
export class KeysBusy extends Error {
  constructor() {
    // agent-protocol: as KeyReused's
    super('too many keyed requests in flight') // i18n-ignore: as KeyReused's
  }
}
/** Its key was taken by another request's commit meanwhile (another process, or a race past the in-flight map). */
class KeyTaken extends Error {}

/** The request's scope while its handler runs: what its first board commit records. */
interface Scope extends KeyedRequest {
  produced: Record<string, unknown>
  written: boolean
}
const scope = new AsyncLocalStorage<Scope>()

/** What the running keyed write produced (a created card's number), saved with its marker; nothing outside one. */
export function noteProduced(o: Record<string, unknown>): void {
  const s = scope.getStore()
  if (s && !s.written) Object.assign(s.produced, o)
}

/** The fingerprint of a request: its method, route template, resolved route values and its body as canonical JSON. */
export function fingerprintOf(method: string, route: string, params: readonly string[], body: unknown): string {
  return createHash('sha256').update(JSON.stringify([method, route, params, canonical(body)])).digest('hex')
}

/** A value with its objects' keys sorted, so the same body in another key order has the same fingerprint. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
  return v
}

// The marker, written in the board change that commits first while the request runs (its first durable write).
setBoardCommitHook((db: DatabaseSync, afterCommit) => {
  const s = scope.getStore()
  if (!s || s.written) return
  const at = new Date().toISOString()
  // Expired markers go first (a key past its 24 hours is free again).
  db.prepare('DELETE FROM request_receipts WHERE at < ?').run(new Date(Date.now() - RECEIPT_HOURS * 3_600_000).toISOString()) // i18n-ignore: SQL
  try {
    db.prepare('INSERT INTO request_receipts (run, key, fingerprint, route, produced, at) VALUES (?, ?, ?, ?, ?, ?)').run(s.run, s.key, s.fingerprint, s.route, JSON.stringify({ ...(s.card !== undefined ? { card: s.card } : {}), ...s.produced }), at) // i18n-ignore: SQL
  } catch (e) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String((e as Error)?.message))) throw new KeyTaken()
    throw e
  }
  afterCommit(() => void (s.written = true))
})

/** The marker of (run, key) on the board, unexpired, or null. */
function receipt(ws: WorkspaceService, run: string, key: string): { fingerprint: string; produced: Record<string, unknown> } | null {
  const row = boardRead(ws, (db) => db.prepare('SELECT fingerprint, produced, at FROM request_receipts WHERE run = ? AND key = ?').get(run, key)) as { fingerprint: string; produced: string | null; at: string } | undefined // i18n-ignore: SQL
  if (!row || Date.parse(row.at) < Date.now() - RECEIPT_HOURS * 3_600_000) return null
  let produced: Record<string, unknown> = {}
  try {
    produced = row.produced ? (JSON.parse(row.produced) as Record<string, unknown>) : {}
  } catch {
    produced = {}
  }
  return { fingerprint: row.fingerprint, produced }
}

/** The answer to a retry of a request whose marker is saved: "already applied", or refused for another request. */
function fromReceipt(r: { fingerprint: string; produced: Record<string, unknown> }, req: KeyedRequest): Applied {
  if (r.fingerprint !== req.fingerprint) throw new KeyReused()
  return { replayed: true, applied: true, produced: r.produced }
}

/** The keyed requests in flight, by launch and key: their fingerprint and outcome, for a retry to join. */
const inFlight = new Map<string, { fingerprint: string; outcome: Promise<unknown> }>()

/**
 * Runs `handler` once for a keyed request: a retry of one in flight joins it (its reply); one whose marker is saved is
 * answered `Applied`; otherwise the handler runs with its marker written in its first board commit. A key reused for
 * another request is refused (KeyReused); past IN_FLIGHT_MAX, a new key is refused for now (KeysBusy).
 */
export async function onceFor<T>(ws: WorkspaceService, req: KeyedRequest, handler: () => Promise<T>): Promise<T | Applied> {
  const id = `${req.run}\n${req.key}`
  const joined = inFlight.get(id)
  if (joined) {
    if (joined.fingerprint !== req.fingerprint) throw new KeyReused()
    const settled = await Promise.race([joined.outcome.then((v) => ({ v }), () => null), new Promise<null>((r) => setTimeout(() => r(null), JOIN_WAIT_MS).unref?.())])
    if (settled) return settled.v as T
    // Its first try failed, or hangs: what the table says (applied, or not, so it runs).
    const r = receipt(ws, req.run, req.key)
    if (r) return fromReceipt(r, req)
  }
  const saved = receipt(ws, req.run, req.key)
  if (saved) return fromReceipt(saved, req)
  if (inFlight.size >= IN_FLIGHT_MAX && !inFlight.has(id)) throw new KeysBusy()
  const outcome = scope.run({ ...req, produced: {}, written: false }, handler).catch((e: unknown) => {
    // Taken by another request's commit meanwhile (this one's change undone): answered as that one's applied write.
    if (e instanceof KeyTaken) {
      const r = receipt(ws, req.run, req.key)
      if (r) return fromReceipt(r, req)
    }
    throw e
  })
  const entry = { fingerprint: req.fingerprint, outcome }
  if (!inFlight.has(id)) inFlight.set(id, entry)
  try {
    return (await outcome) as T | Applied
  } finally {
    if (inFlight.get(id) === entry) inFlight.delete(id)
  }
}

/** For tests: the requests in flight now. */
export const inFlightForTests = (): number => inFlight.size
