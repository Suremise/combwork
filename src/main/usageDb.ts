import type { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import { CW_DIR } from '../shared/defaults'
import type { CompactionEvent, ProviderId } from '../shared/types'
import type { BaselineDay, LedgerRow, UsageSummary } from '../shared/usageLedger'
import type { UsageRow, UsageTimeline } from '../shared/usageTimeline'
import { transaction, type Migration } from './db'

/**
 * The usage history's database (#1106): `.combwork/usage.db`, beside the workspace's `combwork.db`, under each session host's
 * scope (a project's id, `assistant` for the Assistant), as its session records are (#1061). Its own file (Darren, 20
 * Oct), so the usage worker's commits never wait on a board change held across awaits, never look like another
 * process's change to the board's poll, and an older Hive still opens `combwork.db` for writing. Only the usage worker opens
 * it (usageWorker.ts): it writes, and answers main's queries. No Electron here: the worker can't load it.
 *
 * Real tables, each value a typed column (Darren, 20 Oct: "proper tables, not JSON in a database"); the parser's saved
 * state is the one blob (a parser's own fields, taken up as they were):
 * - `usage_sessions`: a row a session. `source`: read from its `transcript`, a `kept` usage imported from before, or an
 *   `external` session (started outside Hive: kept for the Sessions list, never counted in totals). Who it was (provider,
 *   agent, name, folder); where it was read (`path`, the size and modified time read, the offset read to); the parser's
 *   saved state (`state` at `state_offset`, its shape and the Hive version that saved it); the holds its card rows were
 *   shared out by (`holds_key`); and what isn't a sum of its rows (title, model, CLI version, context, activity…).
 * - `usage_rows`: its rows (shared/usageLedger.ts LedgerRow), keyed by session, day, model, card and role; what every
 *   usage view adds up.
 * - `usage_compactions`, `usage_safeguards`: its compactions in order, and its safeguard stops by model and the stops
 *   it may have asked about by turn (#606).
 * - `usage_timeline`, `usage_charges`: its use over time (shared/usageTimeline.ts: a row a second or step, with the
 *   charge covering it and its model) and the provider's charges, for spans of time no card row has (a lane's cost) and
 *   to share a session's cards out again when their holds change.
 * - `usage_baseline`: what was counted for a session before, by day (a kept usage imported from before the history, or
 *   what its rows had when a later read didn't match them): its rows never go below it (shared/usageLedger.ts
 *   applyBaseline), so nothing once counted is lost to a snapshot that counted less of something.
 * - `usage_meta`: per scope, or '' for the workspace (the backfill's record).
 */

export const USAGE_FILE = 'usage.db'
export const usageFile = (workspacePath: string): string => join(workspacePath, CW_DIR, USAGE_FILE)

export const USAGE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'usage',
    up: (db) =>
      db.exec(`
        CREATE TABLE usage_sessions (
          scope          TEXT NOT NULL,
          session        TEXT NOT NULL,
          provider       TEXT NOT NULL,
          agent_id       TEXT,
          agent_name     TEXT,
          name           TEXT,
          cwd            TEXT,
          source         TEXT NOT NULL,
          path           TEXT,
          size           INTEGER NOT NULL DEFAULT 0,
          mtime          REAL NOT NULL DEFAULT 0,
          offset         INTEGER NOT NULL DEFAULT 0,
          state          BLOB,
          state_offset   INTEGER,
          state_shape    TEXT,
          state_version  TEXT,
          state_check    TEXT,
          state_at       TEXT,
          holds_key      TEXT,
          title          TEXT,
          custom_title   TEXT,
          model          TEXT,
          cli_version    TEXT,
          reasoning_tokens INTEGER NOT NULL DEFAULT 0,
          context_tokens INTEGER NOT NULL DEFAULT 0,
          context_input_tokens INTEGER,
          last_output_tokens INTEGER,
          context_window INTEGER,
          cache_ttl_seconds INTEGER NOT NULL DEFAULT 0,
          first_activity TEXT,
          last_activity  TEXT,
          user_messages  INTEGER NOT NULL DEFAULT 0,
          last_prompt    TEXT,
          premium_requests REAL,
          timeline_step  INTEGER,
          updated_at     TEXT NOT NULL,
          PRIMARY KEY (scope, session)
        ) STRICT;
        CREATE TABLE usage_rows (
          scope          TEXT NOT NULL,
          session        TEXT NOT NULL,
          day            TEXT NOT NULL,
          model          TEXT NOT NULL,
          card           INTEGER NOT NULL,
          role           TEXT NOT NULL,
          input          INTEGER NOT NULL,
          output         INTEGER NOT NULL,
          cache_write    INTEGER NOT NULL,
          cache_read     INTEGER NOT NULL,
          requests       INTEGER NOT NULL,
          prompts        INTEGER NOT NULL,
          compactions    INTEGER NOT NULL,
          fixed_usd      REAL NOT NULL,
          fixed_estimated INTEGER NOT NULL,
          covered_input  INTEGER NOT NULL,
          covered_output INTEGER NOT NULL,
          covered_cache_write INTEGER NOT NULL,
          covered_cache_read  INTEGER NOT NULL,
          tokens_unknown INTEGER NOT NULL,
          shared         INTEGER NOT NULL,
          PRIMARY KEY (scope, session, day, model, card, role)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX usage_rows_day ON usage_rows(scope, day);
        CREATE INDEX usage_rows_card ON usage_rows(card) WHERE card > 0;
        CREATE TABLE usage_compactions (
          scope          TEXT NOT NULL,
          session        TEXT NOT NULL,
          seq            INTEGER NOT NULL,
          at             TEXT NOT NULL,
          trigger_kind   TEXT NOT NULL,
          pre_tokens     INTEGER NOT NULL,
          post_tokens    INTEGER NOT NULL,
          last_input_tokens  INTEGER,
          last_output_tokens INTEGER,
          PRIMARY KEY (scope, session, seq)
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE usage_safeguards (
          scope          TEXT NOT NULL,
          session        TEXT NOT NULL,
          kind           TEXT NOT NULL,
          key            TEXT NOT NULL,
          count          INTEGER NOT NULL,
          PRIMARY KEY (scope, session, kind, key)
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE usage_timeline (
          scope          TEXT NOT NULL,
          session        TEXT NOT NULL,
          seq            INTEGER NOT NULL,
          start          INTEGER NOT NULL,
          input          INTEGER NOT NULL,
          output         INTEGER NOT NULL,
          cache_write    INTEGER NOT NULL,
          cache_read     INTEGER NOT NULL,
          requests       INTEGER NOT NULL,
          charge         INTEGER NOT NULL,
          flags          INTEGER NOT NULL,
          model          TEXT NOT NULL,
          PRIMARY KEY (scope, session, seq)
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE usage_charges (
          scope          TEXT NOT NULL,
          session        TEXT NOT NULL,
          seq            INTEGER NOT NULL,
          usd            REAL NOT NULL,
          PRIMARY KEY (scope, session, seq)
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE usage_baseline (
          scope          TEXT NOT NULL,
          session        TEXT NOT NULL,
          day            TEXT NOT NULL,
          model          TEXT NOT NULL,
          input          INTEGER NOT NULL,
          output         INTEGER NOT NULL,
          cache_write    INTEGER NOT NULL,
          cache_read     INTEGER NOT NULL,
          requests       INTEGER NOT NULL,
          prompts        INTEGER NOT NULL,
          compactions    INTEGER NOT NULL,
          cost_usd       REAL,
          cost_estimated INTEGER NOT NULL,
          covered_input  INTEGER NOT NULL,
          covered_output INTEGER NOT NULL,
          covered_cache_write INTEGER NOT NULL,
          covered_cache_read  INTEGER NOT NULL,
          PRIMARY KEY (scope, session, day)
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE usage_meta (
          scope TEXT NOT NULL,
          key   TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (scope, key)
        ) STRICT, WITHOUT ROWID;
      `)
  },
  {
    version: 2,
    name: 'usage-reports-ignored',
    // A session that ran on a server connection (HI-1772): its CLI's cost reports never counted. Set once, never cleared.
    up: (db) => db.exec('ALTER TABLE usage_sessions ADD COLUMN reports_ignored INTEGER NOT NULL DEFAULT 0') // i18n-ignore: SQL
  },
  {
    version: 3,
    name: 'usage-cost-free',
    // Free (HI-1772, Darren 27 Oct): a session that ran only on servers on this PC. Each set once, never cleared:
    // server_local (a run on one), not_local (a run anywhere else, which wins for good).
    up: (db) => db.exec('ALTER TABLE usage_sessions ADD COLUMN server_local INTEGER NOT NULL DEFAULT 0; ALTER TABLE usage_sessions ADD COLUMN not_local INTEGER NOT NULL DEFAULT 0') // i18n-ignore: SQL
  }
]

/** The tables a session has rows in besides usage_sessions (each cleared and written with it). */
const CHILD_TABLES = ['usage_rows', 'usage_compactions', 'usage_safeguards', 'usage_timeline', 'usage_charges'] as const
/** A session's tables a write replaces only when it brings them (kept across reads of its file). */
const BASELINE = 'usage_baseline'

/** Where a session was read: what an ingest compares the file with, and the state it takes up. */
export interface Cursor {
  path: string | null
  size: number
  mtime: number
  offset: number
  state: Uint8Array | null
  stateOffset: number | null
  stateShape: string | null
  stateVersion: string | null
  /** The bytes just before `stateOffset`, as a hash: a state is taken up only while the file still has them there. */
  stateCheck: string | null
  stateAt: string | null
  /** Its rows' requests and tokens, added up: an ingest never makes them fewer (usage history is only added to). */
  requests: number
  tokens: number
  source: string
  /** The holds its rows were shared out by (null: none recorded). */
  holdsKey: string | null
  /** Its CLI's cost reports aren't counted (HI-1772: it ran on a server connection): set once, never cleared. */
  reportsIgnored: boolean
  /** A run of it was on a server on this PC; one was anywhere else (HI-1772): each set once, never cleared. */
  serverLocal: boolean
  notLocal: boolean
}

export function cursorOf(db: DatabaseSync, scope: string, session: string): Cursor | null {
  const s = db.prepare('SELECT path, size, mtime, offset, state, state_offset, state_shape, state_version, state_check, state_at, source, holds_key, reports_ignored, server_local, not_local FROM usage_sessions WHERE scope = ? AND session = ?').get(scope, session) as Record<string, unknown> | undefined // i18n-ignore: SQL
  if (!s) return null
  const sums = db.prepare('SELECT coalesce(sum(requests), 0) AS q, coalesce(sum(input + output + cache_write + cache_read), 0) AS t FROM usage_rows WHERE scope = ? AND session = ?').get(scope, session) as { q: number; t: number } // i18n-ignore: SQL
  return {
    path: (s.path as string | null) ?? null,
    size: s.size as number,
    mtime: s.mtime as number,
    offset: s.offset as number,
    state: (s.state as Uint8Array | null) ?? null,
    stateOffset: (s.state_offset as number | null) ?? null,
    stateShape: (s.state_shape as string | null) ?? null,
    stateVersion: (s.state_version as string | null) ?? null,
    stateCheck: (s.state_check as string | null) ?? null,
    stateAt: (s.state_at as string | null) ?? null,
    requests: sums.q,
    tokens: sums.t,
    source: s.source as string,
    holdsKey: (s.holds_key as string | null) ?? null,
    reportsIgnored: s.reports_ignored === 1,
    serverLocal: s.server_local === 1,
    notLocal: s.not_local === 1
  }
}

/** A session's locality facts set (HI-1772): each only ever set, never cleared; nothing else of it changed. */
export function markLocality(db: DatabaseSync, scope: string, session: string, o: { serverLocal: boolean; notLocal: boolean }): void {
  if (o.serverLocal) db.prepare('UPDATE usage_sessions SET server_local = 1 WHERE scope = ? AND session = ?').run(scope, session) // i18n-ignore: SQL
  if (o.notLocal) db.prepare('UPDATE usage_sessions SET not_local = 1 WHERE scope = ? AND session = ?').run(scope, session) // i18n-ignore: SQL
}

/** Who a session was, as its record has it. */
export interface SessionMeta {
  scope: string
  session: string
  provider: ProviderId
  agentId?: string
  agentName?: string
  name?: string
  cwd?: string
}

/** What an ingest records of a session: its file and how far it was read, the parser's state when saved, and what it used. */
export interface SessionWrite extends SessionMeta {
  source: 'transcript' | 'kept' | 'external'
  path: string | null
  size: number
  mtime: number
  offset: number
  /**
   * The parser's state to keep; null keeps the one saved, `clear` lets it go (a read from the start, or of another file:
   * a state is only ever taken up for the file and the bytes it was made from).
   */
  state: { data: Uint8Array; offset: number; shape: string; version: string; check: string } | null | 'clear'
  /** The holds its rows were shared out by. */
  holdsKey: string | null
  summary: UsageSummary
  timeline: UsageTimeline | null
  rows: LedgerRow[]
  /** Its baseline, when it changed (null: as it is). */
  baseline: BaselineDay[] | null
  /** Written without its CLI's cost reports (HI-1772): the session is marked so for good. */
  reportsIgnored?: boolean
  /** A run on a server on this PC, or anywhere else (HI-1772): each marks the session for good. */
  serverLocal?: boolean
  notLocal?: boolean
}

/**
 * Records a session: everything it has in the history replaced by this, in one transaction. `expect`: the offset and
 * file it was read from as found then (null: not recorded yet); when another writer (another Hive on this workspace)
 * recorded it meanwhile, nothing is written and it says so (false), so a reader that started from an older point never
 * writes over a newer one.
 */
export function writeSession(db: DatabaseSync, w: SessionWrite, expect: { offset: number; path: string | null } | null): boolean {
  return transaction(db, () => {
    const now = db.prepare('SELECT offset, path FROM usage_sessions WHERE scope = ? AND session = ?').get(w.scope, w.session) as { offset: number; path: string | null } | undefined // i18n-ignore: SQL
    if (expect ? !now || now.offset !== expect.offset || now.path !== expect.path : !!now) return false
    for (const t of CHILD_TABLES) db.prepare(`DELETE FROM ${t} WHERE scope = ? AND session = ?`).run(w.scope, w.session) // i18n-ignore: SQL
    putRows(db, w.scope, w.session, w.rows)
    putSummary(db, w.scope, w.session, w.summary)
    if (w.timeline) putTimeline(db, w.scope, w.session, w.timeline)
    if (w.baseline) putBaseline(db, w.scope, w.session, w.baseline)
    const s = w.summary
    const at = new Date().toISOString()
    db.prepare(
      // i18n-ignore: SQL
      `INSERT INTO usage_sessions (scope, session, provider, agent_id, agent_name, name, cwd, source, path, size, mtime, offset, holds_key, title, custom_title, model, cli_version, reasoning_tokens,
         context_tokens, context_input_tokens, last_output_tokens, context_window, cache_ttl_seconds, first_activity, last_activity, user_messages, last_prompt, premium_requests, timeline_step, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, session) DO UPDATE SET provider = excluded.provider, agent_id = excluded.agent_id, agent_name = excluded.agent_name, name = excluded.name, cwd = excluded.cwd,
         source = excluded.source, path = excluded.path, size = excluded.size, mtime = excluded.mtime, offset = excluded.offset, holds_key = excluded.holds_key, title = excluded.title,
         custom_title = excluded.custom_title, model = excluded.model, cli_version = excluded.cli_version, reasoning_tokens = excluded.reasoning_tokens, context_tokens = excluded.context_tokens,
         context_input_tokens = excluded.context_input_tokens, last_output_tokens = excluded.last_output_tokens, context_window = excluded.context_window,
         cache_ttl_seconds = excluded.cache_ttl_seconds, first_activity = excluded.first_activity, last_activity = excluded.last_activity, user_messages = excluded.user_messages,
         last_prompt = excluded.last_prompt, premium_requests = excluded.premium_requests, timeline_step = excluded.timeline_step, updated_at = excluded.updated_at`
    ).run(
      w.scope, w.session, w.provider, w.agentId ?? null, w.agentName ?? null, w.name ?? null, w.cwd ?? null, w.source, w.path, w.size, w.mtime, w.offset, w.holdsKey,
      s.title, s.customTitle ?? null, s.model, s.cliVersion, s.reasoningTokens ?? 0, s.contextTokens ?? 0, s.contextInputTokens ?? null, s.lastOutputTokens ?? null, s.contextWindow ?? null,
      s.cacheTtlSeconds ?? 0, s.firstActivity, s.lastActivity, s.userMessages ?? 0, s.lastPrompt, premiumOf(s), w.timeline ? w.timeline.step : null, at
    )
    // One way (HI-1772): a write that ignores the CLI's cost reports marks the session so; none ever unmarks it.
    if (w.reportsIgnored) db.prepare('UPDATE usage_sessions SET reports_ignored = 1 WHERE scope = ? AND session = ?').run(w.scope, w.session) // i18n-ignore: SQL
    if (w.serverLocal) db.prepare('UPDATE usage_sessions SET server_local = 1 WHERE scope = ? AND session = ?').run(w.scope, w.session) // i18n-ignore: SQL
    if (w.notLocal) db.prepare('UPDATE usage_sessions SET not_local = 1 WHERE scope = ? AND session = ?').run(w.scope, w.session) // i18n-ignore: SQL
    if (w.state === 'clear') clearState(db, w.scope, w.session)
    else if (w.state) db.prepare('UPDATE usage_sessions SET state = ?, state_offset = ?, state_shape = ?, state_version = ?, state_check = ?, state_at = ? WHERE scope = ? AND session = ?').run(w.state.data, w.state.offset, w.state.shape, w.state.version, w.state.check, at, w.scope, w.session) // i18n-ignore: SQL
    return true
  })
}

/** Copilot's running count of premium requests (#454), kept beside the summary's fields when the CLI gives one. */
const premiumOf = (s: UsageSummary): number | null => {
  const p = (s as { premiumRequests?: unknown }).premiumRequests
  return typeof p === 'number' && Number.isFinite(p) ? p : null
}

function putRows(db: DatabaseSync, scope: string, session: string, rows: LedgerRow[]): void {
  const put = db.prepare('INSERT INTO usage_rows (scope, session, day, model, card, role, input, output, cache_write, cache_read, requests, prompts, compactions, fixed_usd, fixed_estimated, covered_input, covered_output, covered_cache_write, covered_cache_read, tokens_unknown, shared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)') // i18n-ignore: SQL
  for (const r of rows) put.run(scope, session, r.day, r.model, r.card, r.role, r.inputTokens, r.outputTokens, r.cacheWriteTokens, r.cacheReadTokens, r.requests, r.prompts, r.compactions, r.fixedUsd, r.fixedEstimated ? 1 : 0, r.covered.inputTokens, r.covered.outputTokens, r.covered.cacheWriteTokens, r.covered.cacheReadTokens, r.tokensUnknown, r.shared ? 1 : 0)
}

/** A summary's lists: its compactions in order, its safeguard stops by model and those it may have asked about by turn. */
function putSummary(db: DatabaseSync, scope: string, session: string, s: UsageSummary): void {
  const comp = db.prepare('INSERT INTO usage_compactions (scope, session, seq, at, trigger_kind, pre_tokens, post_tokens, last_input_tokens, last_output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)') // i18n-ignore: SQL
  s.compactions.forEach((c, i) => comp.run(scope, session, i, c.timestamp ?? '', c.trigger ?? 'unknown', c.preTokens ?? 0, c.postTokens ?? 0, c.lastInputTokens ?? null, c.lastOutputTokens ?? null))
  const guard = db.prepare('INSERT INTO usage_safeguards (scope, session, kind, key, count) VALUES (?, ?, ?, ?, ?)') // i18n-ignore: SQL
  for (const [model, n] of Object.entries(s.safeguards ?? {})) guard.run(scope, session, 'stops', model, n)
  for (const [turn, n] of Object.entries(s.safeguardsAsked ?? {})) guard.run(scope, session, 'asked', turn, n)
}

/** A timeline's rows (each with its model's name, '' for the session's) and its charges, in order. */
function putTimeline(db: DatabaseSync, scope: string, session: string, t: UsageTimeline): void {
  const row = db.prepare('INSERT INTO usage_timeline (scope, session, seq, start, input, output, cache_write, cache_read, requests, charge, flags, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)') // i18n-ignore: SQL
  t.rows.forEach((r, i) => row.run(scope, session, i, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], (r[8] !== undefined && r[8] >= 0 ? t.models?.[r[8]] : undefined) ?? ''))
  const charge = db.prepare('INSERT INTO usage_charges (scope, session, seq, usd) VALUES (?, ?, ?, ?)') // i18n-ignore: SQL
  t.reports.forEach((usd, i) => charge.run(scope, session, i, usd))
}

/** A session's baseline replaced. */
function putBaseline(db: DatabaseSync, scope: string, session: string, days: BaselineDay[]): void {
  db.prepare(`DELETE FROM ${BASELINE} WHERE scope = ? AND session = ?`).run(scope, session) // i18n-ignore: SQL
  const put = db.prepare(`INSERT INTO ${BASELINE} (scope, session, day, model, input, output, cache_write, cache_read, requests, prompts, compactions, cost_usd, cost_estimated, covered_input, covered_output, covered_cache_write, covered_cache_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`) // i18n-ignore: SQL
  for (const d of days) put.run(scope, session, d.day, d.model, d.inputTokens, d.outputTokens, d.cacheWriteTokens, d.cacheReadTokens, d.requests, d.prompts, d.compactions, d.costUsd, d.costEstimated ? 1 : 0, d.covered.inputTokens, d.covered.outputTokens, d.covered.cacheWriteTokens, d.covered.cacheReadTokens)
}

/** A session's baseline (none: []). */
export function baselineOf(db: DatabaseSync, scope: string, session: string): BaselineDay[] {
  return (db.prepare(`SELECT * FROM ${BASELINE} WHERE scope = ? AND session = ? ORDER BY day`).all(scope, session) as Rec[]).map((r) => ({ // i18n-ignore: SQL
    day: r.day as string,
    model: r.model as string,
    inputTokens: r.input as number,
    outputTokens: r.output as number,
    cacheWriteTokens: r.cache_write as number,
    cacheReadTokens: r.cache_read as number,
    requests: r.requests as number,
    prompts: r.prompts as number,
    compactions: r.compactions as number,
    costUsd: (r.cost_usd as number | null) ?? null,
    costEstimated: r.cost_estimated === 1,
    covered: { inputTokens: r.covered_input as number, outputTokens: r.covered_output as number, cacheWriteTokens: r.covered_cache_write as number, cacheReadTokens: r.covered_cache_read as number }
  }))
}

/**
 * Notes a session's file as read with nothing it keeps (its size and time), so the next tick doesn't read it again; the
 * parser's state, made from what it read before, goes (it would be taken up for this file's bytes).
 */
export function touchSession(db: DatabaseSync, scope: string, session: string, path: string, size: number, mtime: number): void {
  transaction(db, () => {
    db.prepare('UPDATE usage_sessions SET path = ?, size = ?, mtime = ? WHERE scope = ? AND session = ?').run(path, size, mtime, scope, session) // i18n-ignore: SQL
    clearState(db, scope, session)
  })
}

/** A session's saved parser state let go. */
function clearState(db: DatabaseSync, scope: string, session: string): void {
  db.prepare('UPDATE usage_sessions SET state = NULL, state_offset = NULL, state_shape = NULL, state_version = NULL, state_check = NULL, state_at = NULL WHERE scope = ? AND session = ?').run(scope, session) // i18n-ignore: SQL
}

/** A session's rows replaced (its holds changed, or its baseline), with the holds they were made by; everything else as it was. */
export function replaceRows(db: DatabaseSync, scope: string, session: string, rows: LedgerRow[], holdsKey: string | null, baseline: BaselineDay[] | null = null): void {
  transaction(db, () => {
    db.prepare('DELETE FROM usage_rows WHERE scope = ? AND session = ?').run(scope, session) // i18n-ignore: SQL
    putRows(db, scope, session, rows)
    if (baseline) putBaseline(db, scope, session, baseline)
    db.prepare('UPDATE usage_sessions SET holds_key = ? WHERE scope = ? AND session = ?').run(holdsKey, scope, session) // i18n-ignore: SQL
  })
}

/**
 * A session's who (agent, name, folder) brought up to date, its usage as it was: a record renamed, an agent renamed, a
 * session started outside Hive adopted (its source then `transcript`). Written only when it changed.
 */
export function updateMeta(db: DatabaseSync, m: SessionMeta, source: 'transcript' | 'external'): void {
  const v = [m.agentId ?? null, m.agentName ?? null, m.name ?? null, m.cwd ?? null]
  // An external session stays one only while no record has it: a record's job makes it Hive's.
  const src = source === 'transcript' ? "CASE WHEN source = 'external' THEN 'transcript' ELSE source END" : 'source' // i18n-ignore: SQL
  db.prepare(`UPDATE usage_sessions SET agent_id = ?, agent_name = ?, name = ?, cwd = ?, source = ${src} WHERE scope = ? AND session = ? AND (agent_id IS NOT ? OR agent_name IS NOT ? OR name IS NOT ? OR cwd IS NOT ? OR source <> ${src})`).run(...v, m.scope, m.session, ...v) // i18n-ignore: SQL
}

export function getMeta(db: DatabaseSync, scope: string, key: string): string | null {
  return ((db.prepare('SELECT value FROM usage_meta WHERE scope = ? AND key = ?').get(scope, key) as { value: string } | undefined)?.value ?? null) // i18n-ignore: SQL
}

export function setMeta(db: DatabaseSync, scope: string, key: string, value: string): void {
  db.prepare('INSERT INTO usage_meta (scope, key, value) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value').run(scope, key, value) // i18n-ignore: SQL
}

// ---------------------------------------------------------------------------
// Reads (main's queries, answered by the worker).
// ---------------------------------------------------------------------------

/** A session as the history has it: who, its summary and its rows (not priced: main prices them with its settings). */
export interface StoredSession extends SessionMeta {
  source: string
  /** The file it was last read from, and its size and modified time then. */
  path: string | null
  size: number
  mtime: number
  summary: UsageSummary
  rows: LedgerRow[]
}

type Rec = Record<string, unknown>

const rowOf = (r: Rec): LedgerRow => ({
  day: r.day as string,
  model: r.model as string,
  card: r.card as number,
  role: r.role as LedgerRow['role'],
  inputTokens: r.input as number,
  outputTokens: r.output as number,
  cacheWriteTokens: r.cache_write as number,
  cacheReadTokens: r.cache_read as number,
  requests: r.requests as number,
  prompts: r.prompts as number,
  compactions: r.compactions as number,
  fixedUsd: r.fixed_usd as number,
  fixedEstimated: r.fixed_estimated === 1,
  covered: { inputTokens: r.covered_input as number, outputTokens: r.covered_output as number, cacheWriteTokens: r.covered_cache_write as number, cacheReadTokens: r.covered_cache_read as number },
  tokensUnknown: r.tokens_unknown as number,
  shared: r.shared === 1
})

const metaOf = (s: Rec): SessionMeta => ({
  scope: s.scope as string,
  session: s.session as string,
  provider: s.provider as ProviderId,
  ...(s.agent_id ? { agentId: s.agent_id as string } : {}),
  ...(s.agent_name ? { agentName: s.agent_name as string } : {}),
  ...(s.name ? { name: s.name as string } : {}),
  ...(s.cwd ? { cwd: s.cwd as string } : {})
})

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ')
const keyOf = (r: Rec): string => `${r.scope as string}\0${r.session as string}`

/** Rows of a table for some scopes (all: null) or one session, grouped by session in their order. */
function grouped<T>(db: DatabaseSync, table: string, where: { scopes: string[] | null } | { scope: string; session: string } | { scope: string; sessions: string[] }, order: string, map: (r: Rec) => T): Map<string, T[]> {
  const [sql, args] =
    'sessions' in where
      ? [`WHERE scope = ? AND session IN (${placeholders(where.sessions.length)})`, [where.scope, ...where.sessions]] // i18n-ignore: SQL
      : 'session' in where
        ? [`WHERE scope = ? AND session = ?`, [where.scope, where.session]] // i18n-ignore: SQL
        : where.scopes
          ? [`WHERE scope IN (${placeholders(where.scopes.length)})`, where.scopes] // i18n-ignore: SQL
          : ['', []]
  const out = new Map<string, T[]>()
  for (const r of db.prepare(`SELECT * FROM ${table} ${sql} ORDER BY scope, session, ${order}`).all(...args) as Rec[]) { // i18n-ignore: SQL
    const k = keyOf(r)
    const list = out.get(k)
    if (list) list.push(map(r))
    else out.set(k, [map(r)])
  }
  return out
}

const compactionOf = (r: Rec): CompactionEvent => ({
  timestamp: r.at as string,
  trigger: r.trigger_kind as string,
  preTokens: r.pre_tokens as number,
  postTokens: r.post_tokens as number,
  ...(r.last_input_tokens !== null ? { lastInputTokens: r.last_input_tokens as number, lastOutputTokens: (r.last_output_tokens as number | null) ?? 0 } : {})
})

/** A session's summary from its columns and its lists. */
function summaryOf(s: Rec, compactions: CompactionEvent[], guards: Rec[]): UsageSummary {
  const stops = Object.fromEntries(guards.filter((g) => g.kind === 'stops').map((g) => [g.key as string, g.count as number]))
  const asked = Object.fromEntries(guards.filter((g) => g.kind === 'asked').map((g) => [g.key as string, g.count as number]))
  const premium = s.premium_requests as number | null
  return {
    provider: s.provider as ProviderId,
    sessionId: s.session as string,
    title: (s.title as string | null) ?? null,
    customTitle: (s.custom_title as string | null) ?? null,
    model: (s.model as string | null) ?? null,
    cliVersion: (s.cli_version as string | null) ?? null,
    reasoningTokens: s.reasoning_tokens as number,
    contextTokens: s.context_tokens as number,
    ...(s.context_input_tokens !== null ? { contextInputTokens: s.context_input_tokens as number } : {}),
    ...(s.last_output_tokens !== null ? { lastOutputTokens: s.last_output_tokens as number } : {}),
    contextWindow: (s.context_window as number | null) ?? null,
    compactions,
    cacheTtlSeconds: s.cache_ttl_seconds as number,
    firstActivity: (s.first_activity as string | null) ?? null,
    lastActivity: (s.last_activity as string | null) ?? null,
    userMessages: s.user_messages as number,
    lastPrompt: (s.last_prompt as string | null) ?? null,
    ...(Object.keys(stops).length ? { safeguards: stops } : {}),
    ...(Object.keys(asked).length ? { safeguardsAsked: asked } : {}),
    ...(premium !== null ? { premiumRequests: premium } : {}),
    // Free (HI-1772): it ran only on servers on this PC.
    ...(s.server_local === 1 && s.not_local !== 1 ? { costFree: true as const } : {})
  } as UsageSummary
}

/** A session's timeline from its rows and charges (null: none kept). */
function timelineOf(step: number | null, rows: Rec[], charges: number[]): UsageTimeline | null {
  if (step === null) return null
  const models: string[] = []
  const out = rows.map((r): UsageRow => {
    const name = r.model as string
    const row: UsageRow = [r.start as number, r.input as number, r.output as number, r.cache_write as number, r.cache_read as number, r.requests as number, r.charge as number, r.flags as number]
    if (name) row[8] = models.includes(name) ? models.indexOf(name) : models.push(name) - 1
    return row
  })
  return { step, rows: out, reports: charges, ...(models.length ? { models } : {}) }
}

/** The sessions of some scopes (all of them: null), with their rows. */
export function storedSessions(db: DatabaseSync, scopes: string[] | null): StoredSession[] {
  if (scopes && !scopes.length) return []
  const where = { scopes }
  const rows = grouped(db, 'usage_rows', where, 'day, model, card, role', rowOf)
  const compactions = grouped(db, 'usage_compactions', where, 'seq', compactionOf)
  const guards = grouped(db, 'usage_safeguards', where, 'kind, key', (r) => r)
  const sql = scopes ? `WHERE scope IN (${placeholders(scopes.length)})` : '' // i18n-ignore: SQL
  return (db.prepare(`SELECT * FROM usage_sessions ${sql}`).all(...(scopes ?? [])) as Rec[]).map((s) => { // i18n-ignore: SQL
    const k = keyOf(s)
    return { ...metaOf(s), source: s.source as string, path: (s.path as string | null) ?? null, size: s.size as number, mtime: s.mtime as number, summary: summaryOf(s, compactions.get(k) ?? [], guards.get(k) ?? []), rows: rows.get(k) ?? [] }
  })
}

/** What a session's rows are made again from when its cards' holds change: its summary, timeline and rows as stored. */
export function storedSession(db: DatabaseSync, scope: string, session: string): { summary: UsageSummary; timeline: UsageTimeline | null; rows: LedgerRow[] } | null {
  const s = db.prepare('SELECT * FROM usage_sessions WHERE scope = ? AND session = ?').get(scope, session) as Rec | undefined // i18n-ignore: SQL
  if (!s) return null
  const where = { scope, session }
  const k = keyOf(s)
  const timeline = timelineOf((s.timeline_step as number | null) ?? null, grouped(db, 'usage_timeline', where, 'seq', (r) => r).get(k) ?? [], grouped(db, 'usage_charges', where, 'seq', (r) => r.usd as number).get(k) ?? [])
  return { summary: summaryOf(s, grouped(db, 'usage_compactions', where, 'seq', compactionOf).get(k) ?? [], grouped(db, 'usage_safeguards', where, 'kind, key', (r) => r).get(k) ?? []), timeline, rows: grouped(db, 'usage_rows', where, 'day, model, card, role', rowOf).get(k) ?? [] }
}

/** The rows on some cards (role and card kept), with whose session each is. */
export function cardRows(db: DatabaseSync, cards: number[]): (SessionMeta & { row: LedgerRow })[] {
  if (!cards.length) return []
  const rows = db.prepare(`SELECT r.*, s.provider, s.agent_id, s.agent_name, s.name, s.cwd FROM usage_rows r JOIN usage_sessions s ON s.scope = r.scope AND s.session = r.session WHERE r.card IN (${placeholders(cards.length)})`).all(...cards) as Rec[] // i18n-ignore: SQL
  return rows.map((r) => ({ ...metaOf(r), row: rowOf(r) }))
}

/**
 * Sessions of a scope with their timelines (for spans of time no card has: a lane's), who each was and its summary; only
 * those named in `sessions` when given (HI-1906: a card's, by its ledger rows, not every session of the scope).
 */
export function storedTimelines(db: DatabaseSync, scope: string, sessions?: string[]): (SessionMeta & { summary: UsageSummary; timeline: UsageTimeline | null; firstActivity: string | null; lastActivity: string | null })[] {
  if (sessions && !sessions.length) return []
  const where = sessions ? { scope, sessions } : { scopes: [scope] }
  const rows = grouped(db, 'usage_timeline', where, 'seq', (r) => r)
  const charges = grouped(db, 'usage_charges', where, 'seq', (r) => r.usd as number)
  const compactions = grouped(db, 'usage_compactions', where, 'seq', compactionOf)
  const guards = grouped(db, 'usage_safeguards', where, 'kind, key', (r) => r)
  const list = sessions ? db.prepare(`SELECT * FROM usage_sessions WHERE scope = ? AND session IN (${placeholders(sessions.length)})`).all(scope, ...sessions) : db.prepare('SELECT * FROM usage_sessions WHERE scope = ?').all(scope) // i18n-ignore: SQL
  return (list as Rec[]).map((s) => {
    const k = keyOf(s)
    const summary = summaryOf(s, compactions.get(k) ?? [], guards.get(k) ?? [])
    return { ...metaOf(s), summary, timeline: timelineOf((s.timeline_step as number | null) ?? null, rows.get(k) ?? [], charges.get(k) ?? []), firstActivity: summary.firstActivity, lastActivity: summary.lastActivity }
  })
}

// ---------------------------------------------------------------------------
// The roll-up of old sessions' timelines (HI-1648), and the space it frees given back.
// ---------------------------------------------------------------------------

/**
 * The sessions whose timeline is finer than `step` and whose last activity is before `before` (an ISO time), oldest
 * first, at most `limit`: what a roll-up merges into `step`s. A session with no last activity, or one that isn't a time,
 * is left alone (when it ran can't be told).
 */
export function rollUpCandidates(db: DatabaseSync, before: string, step: number, limit: number): { scope: string; session: string }[] {
  return db.prepare('SELECT scope, session FROM usage_sessions WHERE timeline_step IS NOT NULL AND timeline_step < ? AND julianday(last_activity) < julianday(?) ORDER BY julianday(last_activity) LIMIT ?').all(step, before, limit) as { scope: string; session: string }[] // i18n-ignore: SQL
}

/**
 * One session's timeline merged into steps of `step` (`merge`: shared/usageTimeline.ts coarsenTimeline), in a
 * transaction of its own, so a close midway leaves it rolled up or as it was. Checked again inside it, as the session is
 * then: still finer than `step` and last active before `before` (a resumed session is left alone). Its rows before and
 * after; null when it was left alone.
 */
export function rollUpSession(db: DatabaseSync, scope: string, session: string, before: string, step: number, merge: (t: UsageTimeline) => UsageTimeline): { rows: number; merged: number } | null {
  return transaction(db, () => {
    // Old as rollUpCandidates tells it (julianday), so a session it picks is never refused here for how its time is written.
    const s = db.prepare('SELECT timeline_step, coalesce(julianday(last_activity) < julianday(?), 0) AS old FROM usage_sessions WHERE scope = ? AND session = ?').get(before, scope, session) as { timeline_step: number | null; old: number } | undefined // i18n-ignore: SQL
    if (!s || s.timeline_step === null || s.timeline_step >= step || !s.old) return null
    const where = { scope, session }
    const k = `${scope}\0${session}`
    const t = timelineOf(s.timeline_step, grouped(db, 'usage_timeline', where, 'seq', (r) => r).get(k) ?? [], grouped(db, 'usage_charges', where, 'seq', (r) => r.usd as number).get(k) ?? [])
    if (!t) return null
    const merged = merge(t)
    db.prepare('DELETE FROM usage_timeline WHERE scope = ? AND session = ?').run(scope, session) // i18n-ignore: SQL
    db.prepare('DELETE FROM usage_charges WHERE scope = ? AND session = ?').run(scope, session) // i18n-ignore: SQL
    putTimeline(db, scope, session, merged)
    db.prepare('UPDATE usage_sessions SET timeline_step = ? WHERE scope = ? AND session = ?').run(merged.step, scope, session) // i18n-ignore: SQL
    return { rows: t.rows.length, merged: merged.rows.length }
  })
}

/** The file's size in pages and bytes, and its free pages. */
export function fileSpace(db: DatabaseSync): { pages: number; free: number; pageSize: number } {
  const pages = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count // i18n-ignore: SQL
  const free = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count // i18n-ignore: SQL
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size // i18n-ignore: SQL
  return { pages, free, pageSize }
}

/** Whether the file gives its free pages back as it is told to (auto_vacuum incremental). */
export const vacuumsIncrementally = (db: DatabaseSync): boolean => (db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum === 2 // i18n-ignore: SQL

/**
 * Gives the file's free pages back to the disk (HI-1648). A file made before this, with auto_vacuum off, is vacuumed
 * whole once, which turns it to incremental (the whole file written again: once); after that only its free pages go.
 * Then the WAL is checkpointed, truncating it, so the file shrinks now rather than when Hive closes it. Whether it was
 * the whole vacuum.
 */
export function giveSpaceBack(db: DatabaseSync): boolean {
  if (db.isTransaction) throw new Error('giveSpaceBack inside a transaction') // i18n-ignore: a mistake in Hive's code, logged
  const whole = !vacuumsIncrementally(db)
  if (whole) db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM')
  else db.exec('PRAGMA incremental_vacuum')
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return whole
}

/** A session of a scope as a sweep and the card attribution see it: where it was read, whose it was, the holds its rows were shared out by. */
export interface SessionId {
  session: string
  source: string
  path: string | null
  size: number
  mtime: number
  agentId: string | null
  agentName: string | null
  holdsKey: string | null
}

/** Which sessions of a scope the history has. */
export function sessionIds(db: DatabaseSync, scope: string): SessionId[] {
  return (db.prepare('SELECT session, source, path, size, mtime, agent_id, agent_name, holds_key FROM usage_sessions WHERE scope = ?').all(scope) as Rec[]).map((r) => ({ // i18n-ignore: SQL
    session: r.session as string,
    source: r.source as string,
    path: (r.path as string | null) ?? null,
    size: r.size as number,
    mtime: r.mtime as number,
    agentId: (r.agent_id as string | null) ?? null,
    agentName: (r.agent_name as string | null) ?? null,
    holdsKey: (r.holds_key as string | null) ?? null
  }))
}
