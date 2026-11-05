import type { DatabaseSync } from 'node:sqlite'
import { baseRulesetId, canonical, REVIEW_SKIPPED, stableHash } from '../../shared/workflow/compile'
import { mergeTimed, type Timed } from '../../shared/metrics'
import { DELIVERY_BODY_MAX_CHARS } from '../../shared/deliveries'
import { WAKE_MAX_BYTES } from '../../shared/watch'
import { NEW_ID, NEW_NAME, OLD_ID, OLD_NAME, optionValue, ruleId, upgradedAdvancedId, upgradedOptions, upgradedOwnText, upgradedRunName, upgradedToolName } from '../storedNames'

/**
 * The board's step of the names upgrade for stored values (HI-2598, its design HI-2598/s9 §2; boardStore.ts
 * BOARD_MIGRATIONS version 26): what 1.0 and the 1.1 release candidates stored under Hive's names in combwork.db takes
 * Combwork's, once, in the migration's transaction. Only what is still old changes: on a board converted already, or
 * made by 1.1, it changes nothing. Identities and codes only (a fact's actor, a merge's `by`, a refusal's rule, the
 * workflow options' values and the rulesets compiled from them, a lane's builder and starter, a history line's `by`, a
 * card's creator, a delivery's sender, a metrics series' tool, the Assistant's changes' setting ids and option values),
 * and Combwork's own stored lines (a delivery it sent, a watch's fired line) through upgradedOwnText, which keeps every
 * word. Never prose: a history line's text, a comment, a description.
 */
export const VALUES_STEP = { name: 'names: values', up: upgradeValues } as const

/** What the step changed, by table (for the log and the tests). */
export type ValuesChanged = Record<string, number>

type Row = Record<string, unknown>

const parse = (text: unknown): Row | null => {
  if (typeof text !== 'string') return null
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null
  } catch {
    return null
  }
}

/** The separator of a stored value's member path in assistant_change_values (assistantChanges.ts). */
const PATH_SEP = '\u001f'

/** The step: every conversion, each only where a table has its old value. */
export function upgradeValues(db: DatabaseSync): ValuesChanged {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)) // i18n-ignore: SQL
  const has = (...names: string[]): boolean => names.every((n) => tables.has(n))
  const out: ValuesChanged = {}
  const count = (what: string, n: number | bigint): void => {
    if (Number(n)) out[what] = (out[what] ?? 0) + Number(n)
  }

  if (has('card_facts')) {
    count('card_facts.actor', db.prepare('UPDATE card_facts SET actor = ? WHERE actor = ?').run(NEW_ID, OLD_ID).changes) // i18n-ignore: SQL
    const setData = db.prepare('UPDATE card_facts SET data = ? WHERE rowid = ?') // i18n-ignore: SQL
    const each = (sql: string, args: string[], change: (d: Row) => boolean, what: string): void => {
      for (const r of db.prepare(sql).all(...args) as { id: number; data: string }[]) {
        const d = parse(r.data)
        if (d && change(d)) count(what, setData.run(JSON.stringify(d), r.id).changes)
      }
    }
    // A merge's and an undo's `by` (an Actor), a refusal's rule, a check run's name ("Hive (merge queue)").
    const byOld = "SELECT rowid AS id, data FROM card_facts WHERE kind IN ('Integrated', 'Undone') AND json_valid(data) AND json_extract(data, '$.by') = ?" // i18n-ignore: SQL
    const refused = "SELECT rowid AS id, data FROM card_facts WHERE kind = 'Refused' AND json_valid(data) AND json_type(data, '$.rule') = 'text'" // i18n-ignore: SQL
    const checks = "SELECT rowid AS id, data FROM card_facts WHERE kind = 'CheckRan' AND json_valid(data) AND json_extract(data, '$.by') LIKE 'Hive (%'" // i18n-ignore: SQL
    each(byOld, [OLD_ID], (d) => ((d.by = NEW_ID), true), 'card_facts.by')
    each(refused, [], (d) => {
      const to = ruleId(d.rule)
      return to !== d.rule && ((d.rule = to), true)
    }, 'card_facts.rule')
    each(checks, [], (d) => {
      const to = upgradedRunName(d.by)
      return to !== d.by && ((d.by = to), true)
    }, 'card_facts.checkBy')
  }

  if (has('card_actions')) {
    // A wake's and a decision's wake's `by` (who made the change: an Actor); an `actor` likewise, should one have it.
    const set = db.prepare('UPDATE card_actions SET payload = ? WHERE id = ?') // i18n-ignore: SQL
    for (const r of db.prepare("SELECT id, payload FROM card_actions WHERE json_valid(payload) AND (json_extract(payload, '$.by') = ? OR json_extract(payload, '$.actor') = ?)").all(OLD_ID, OLD_ID) as { id: number; payload: string }[]) { // i18n-ignore: SQL
      const p = parse(r.payload)
      if (!p) continue
      if (p.by === OLD_ID) p.by = NEW_ID
      if (p.actor === OLD_ID) p.actor = NEW_ID
      count('card_actions', set.run(JSON.stringify(p), r.id).changes)
    }
  }

  if (has('rulesets')) count('rulesets', upgradeRulesets(db, has))

  if (has('lanes')) {
    count('lanes.builder_id', db.prepare('UPDATE lanes SET builder_id = ? WHERE builder_id = ?').run(NEW_ID, OLD_ID).changes) // i18n-ignore: SQL
    count('lanes.builder_name', db.prepare('UPDATE lanes SET builder_name = ? WHERE builder_name = ?').run(NEW_NAME, OLD_NAME).changes) // i18n-ignore: SQL
    count('lanes.started_by', db.prepare('UPDATE lanes SET started_by = ? WHERE started_by = ?').run(NEW_NAME, OLD_NAME).changes) // i18n-ignore: SQL
  }

  if (has('card_comments')) {
    // A comment's author's name, never its text; `raw` holds the whole entry for one not of Combwork's form.
    count('card_comments.by', db.prepare('UPDATE card_comments SET by = ? WHERE by = ?').run(NEW_NAME, OLD_NAME).changes) // i18n-ignore: SQL
    count('card_comments.raw', db.prepare("UPDATE card_comments SET raw = json_set(raw, '$.by', ?) WHERE raw IS NOT NULL AND json_valid(raw) AND json_type(raw) = 'object' AND json_extract(raw, '$.by') = ?").run(NEW_NAME, OLD_NAME).changes) // i18n-ignore: SQL
  }
  if (has('card_history')) {
    count('card_history.by', db.prepare('UPDATE card_history SET by = ? WHERE by = ?').run(NEW_NAME, OLD_NAME).changes) // i18n-ignore: SQL
    // A line not of Combwork's form keeps its JSON whole in `raw`, which is what is read: its `by` too.
    count('card_history.raw', db.prepare("UPDATE card_history SET raw = json_set(raw, '$.by', ?) WHERE raw IS NOT NULL AND json_valid(raw) AND json_type(raw) = 'object' AND json_extract(raw, '$.by') = ?").run(NEW_NAME, OLD_NAME).changes) // i18n-ignore: SQL
  }
  if (has('cards')) {
    const cols = (db.prepare("SELECT name FROM pragma_table_info('cards')").all() as { name: string }[]).map((c) => c.name) // i18n-ignore: SQL
    if (cols.includes('created_by')) count('cards.created_by', db.prepare('UPDATE cards SET created_by = ? WHERE created_by = ?').run(NEW_NAME, OLD_NAME).changes) // i18n-ignore: SQL
  }

  if (has('deliveries')) {
    // Combwork's own: its sender, and its text as upgradedOwnText has it (a sender's of another kind is never touched).
    const set = db.prepare('UPDATE deliveries SET sender = ?, body = ? WHERE host = ? AND id = ?') // i18n-ignore: SQL
    for (const r of db.prepare("SELECT host, id, sender, body FROM deliveries WHERE json_valid(sender) AND json_extract(sender, '$.kind') IN (?, ?)").all(OLD_ID, NEW_ID) as { host: string; id: string; sender: string; body: string }[]) { // i18n-ignore: SQL
      const s = parse(r.sender)
      if (!s) continue
      const old = s.kind === OLD_ID || s.name === OLD_NAME
      if (old) Object.assign(s, { kind: NEW_ID, name: s.name === OLD_NAME || s.kind === OLD_ID ? NEW_NAME : s.name })
      const body = upgradedOwnText(r.body, (t) => t.length <= DELIVERY_BODY_MAX_CHARS)
      if (old || body !== null) count('deliveries', set.run(old ? JSON.stringify(s) : r.sender, body ?? r.body, r.host, r.id).changes)
    }
  }

  if (has('watches')) {
    const set = db.prepare('UPDATE watches SET fired = ? WHERE id = ?') // i18n-ignore: SQL
    for (const r of db.prepare("SELECT id, fired FROM watches WHERE fired IS NOT NULL AND json_valid(fired) AND json_type(fired, '$.line') = 'text'").all() as { id: string; fired: string }[]) { // i18n-ignore: SQL
      const f = parse(r.fired)
      const line = f && typeof f.line === 'string' ? upgradedOwnText(f.line, (t) => Buffer.byteLength(JSON.stringify(t)) <= WAKE_MAX_BYTES) : null
      if (f && line !== null) count('watches.fired', set.run(JSON.stringify({ ...f, line }), r.id).changes)
    }
  }

  if (has('metrics_series')) count('metrics_series', upgradeMetrics(db, has('metrics_buckets')))

  if (has('board_meta')) {
    // A project's merge choice (HI-1697): its commit message.
    const set = db.prepare('UPDATE board_meta SET value = ? WHERE key = ?') // i18n-ignore: SQL
    for (const r of db.prepare("SELECT key, value FROM board_meta WHERE key LIKE 'workflow:%:mergeChoice'").all() as { key: string; value: string }[]) { // i18n-ignore: SQL
      const v = parse(r.value)
      if (!v) continue
      const to = optionValue.commitMessage(v.commitMessage)
      if (to !== v.commitMessage) count('board_meta', set.run(JSON.stringify({ ...v, commitMessage: to }), r.key).changes)
    }
  }

  if (has('assistant_changes', 'assistant_change_values')) count('assistant_changes', upgradeAssistantChanges(db))
  return out
}

/**
 * Each ruleset compiled from an old option value (who merges, `hiveMerges`) stored again under its id now: its body
 * (all but `id`, as compile.ts hashes it) with the option converted, hashed as compile() hashes it; one with review
 * skipped keeps its base's new id with its mark (skipReviewOf). The facts and lane runs that name the old id name the
 * new one, then the old row goes (card_facts.ruleset references it). Its stages and guards stay as they were compiled.
 */
function upgradeRulesets(db: DatabaseSync, has: (...names: string[]) => boolean): number {
  const rows = db.prepare('SELECT id, data FROM rulesets').all() as { id: string; data: string }[] // i18n-ignore: SQL
  const moved = new Map<string, string>()
  const converted: { old: string; id: string; data: Row }[] = []
  // Bases first: a skipped ruleset's id is its base's, marked.
  const ordered = [...rows.filter((r) => !r.id.endsWith(REVIEW_SKIPPED)), ...rows.filter((r) => r.id.endsWith(REVIEW_SKIPPED))]
  for (const r of ordered) {
    const data = parse(r.data)
    const options = data ? upgradedOptions(data.options as Record<string, unknown> | null) : null
    if (!data || !options) continue
    const { id: _id, ...body }: Row = { ...data, options }
    const skipped = r.id.endsWith(REVIEW_SKIPPED)
    // A skipped ruleset whose base isn't kept (never the case: the runtime stores both) keeps its id, its body converted.
    const id = skipped ? (moved.has(baseRulesetId(r.id)) ? moved.get(baseRulesetId(r.id))! + REVIEW_SKIPPED : r.id) : stableHash(canonical(body))
    if (!skipped) moved.set(r.id, id)
    converted.push({ old: r.id, id, data: { ...data, id, options } })
  }
  if (!converted.length) return 0
  const insert = db.prepare('INSERT OR IGNORE INTO rulesets (id, data) VALUES (?, ?)') // i18n-ignore: SQL
  const update = db.prepare('UPDATE rulesets SET data = ? WHERE id = ?') // i18n-ignore: SQL
  const remove = db.prepare('DELETE FROM rulesets WHERE id = ?') // i18n-ignore: SQL
  const refs = [has('card_facts') ? 'card_facts' : null, has('lane_runs') ? 'lane_runs' : null, has('workflow_lanes') ? 'workflow_lanes' : null].filter((t): t is string => !!t)
  const repoint = refs.map((t) => db.prepare(`UPDATE ${t} SET ruleset = ? WHERE ruleset = ?`)) // i18n-ignore: SQL
  for (const c of converted) {
    if (c.id === c.old) {
      update.run(JSON.stringify(c.data), c.old)
      continue
    }
    insert.run(c.id, JSON.stringify(c.data))
    for (const s of repoint) s.run(c.id, c.old)
    remove.run(c.old)
  }
  return converted.length
}

type McpData = Timed & { tool?: unknown; chars?: unknown; bytes?: unknown }

const isTimed = (d: Row | null): d is Row & McpData => !!d && typeof d.count === 'number' && typeof d.totalMs === 'number' && typeof d.maxMs === 'number' && Array.isArray(d.histogram)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Two stored series of a tool's calls as one, as metrics.ts adds a saved series to one it has (readPart): the timings
 * by mergeTimed, characters and bytes summed. `into` is the one kept (its labels). Pure.
 */
export function mergeMcpSeries(into: Row, from: Row): Row {
  if (!isTimed(into)) return from
  if (!isTimed(from)) return into
  const t: Timed = { count: into.count, totalMs: into.totalMs, maxMs: into.maxMs, histogram: [...into.histogram] }
  mergeTimed(t, from)
  return { ...into, ...t, chars: num(into.chars) + num(from.chars), bytes: num(into.bytes) + num(from.bytes) }
}

/**
 * A tool's series kept under its name before HI-2463 (`hive_<tool> <role> <mode> <outcome>`) under its `cw_` name: its
 * key and its `tool`. Where the bucket has the new key already (an RC that recorded both), the two are one series.
 */
function upgradeMetrics(db: DatabaseSync, buckets: boolean): number {
  const rows = db.prepare("SELECT span, start, part, key, data FROM metrics_series WHERE family = 'mcp' AND key LIKE 'hive\\_%' ESCAPE '\\'").all() as { span: string; start: number; part: string; key: string; data: string }[] // i18n-ignore: SQL
  const get = db.prepare("SELECT data FROM metrics_series WHERE span = ? AND start = ? AND part = ? AND family = 'mcp' AND key = ?") // i18n-ignore: SQL
  const rekey = db.prepare("UPDATE metrics_series SET key = ?, data = ? WHERE span = ? AND start = ? AND part = ? AND family = 'mcp' AND key = ?") // i18n-ignore: SQL
  const setData = db.prepare("UPDATE metrics_series SET data = ? WHERE span = ? AND start = ? AND part = ? AND family = 'mcp' AND key = ?") // i18n-ignore: SQL
  const remove = db.prepare("DELETE FROM metrics_series WHERE span = ? AND start = ? AND part = ? AND family = 'mcp' AND key = ?") // i18n-ignore: SQL
  const fewer = buckets ? db.prepare('UPDATE metrics_buckets SET series = MAX(series - 1, 0) WHERE span = ? AND start = ?') : null // i18n-ignore: SQL
  let n = 0
  for (const r of rows) {
    const [tool, ...rest] = r.key.split(' ')
    const to = upgradedToolName(tool)
    if (to === tool) continue
    const key = [to, ...rest].join(' ')
    const data = parse(r.data) ?? {}
    if (data.tool === tool) data.tool = to
    const had = get.get(r.span, r.start, r.part, key) as { data: string } | undefined
    if (had) {
      setData.run(JSON.stringify(mergeMcpSeries(parse(had.data) ?? {}, data)), r.span, r.start, r.part, key)
      remove.run(r.span, r.start, r.part, r.key)
      fewer?.run(r.span, r.start)
    } else rekey.run(key, JSON.stringify(data), r.span, r.start, r.part, r.key)
    n++
  }
  return n
}

/** A setting's id as the settings catalog has it now: Combwork's server switch, an advanced setting's (and a workspace's own). */
export function upgradedSettingId(id: string): string {
  if (id === 'agentApi.provideHiveMcp') return 'agentApi.provideCombworkMcp'
  for (const prefix of ['advanced.', 'workspace.advanced.']) if (id.startsWith(prefix)) return prefix + upgradedAdvancedId(id.slice(prefix.length))
  return id
}

/**
 * The Assistant's recorded changes (#1282), so an undo finds and writes a current value: a setting change's target (its
 * setting id), and a stored workflow option's value (who merges, the commit message) wherever a change keeps one: a
 * setting's own value (`workflow.git.finish`…, path ''), or a member of an object (a template load's `workflow`, path
 * …␟finish). Their lines (`what`) are prose, kept as written.
 */
function upgradeAssistantChanges(db: DatabaseSync): number {
  let n = 0
  const setTarget = db.prepare('UPDATE assistant_changes SET target = ? WHERE id = ?') // i18n-ignore: SQL
  const targets = new Map<string, string>()
  for (const r of db.prepare("SELECT id, target FROM assistant_changes WHERE kind = 'setting' AND target IS NOT NULL").all() as { id: string; target: string }[]) { // i18n-ignore: SQL
    const to = upgradedSettingId(r.target)
    if (to !== r.target) n += Number(setTarget.run(to, r.id).changes)
    targets.set(r.id, to)
  }
  const setText = db.prepare('UPDATE assistant_change_values SET text = ? WHERE change = ? AND field = ? AND side = ? AND ord = ?') // i18n-ignore: SQL
  const rows = db.prepare("SELECT change, field, side, ord, path, text FROM assistant_change_values WHERE type = 'text' AND text IN ('hive', 'hiveMerges')").all() as { change: string; field: string; side: string; ord: number; path: string; text: string }[] // i18n-ignore: SQL
  for (const r of rows) {
    const option = r.path === '' ? (r.field === 'value' ? targets.get(r.change)?.split('.').at(-1) : undefined) : r.path.split(PATH_SEP).at(-1)
    if (option !== 'finish' && option !== 'commitMessage') continue
    const to = optionValue[option](r.text)
    if (to !== r.text) n += Number(setText.run(to as string, r.change, r.field, r.side, r.ord).changes)
  }
  return n
}
