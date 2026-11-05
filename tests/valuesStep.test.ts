// HI-2598: the board's step of the names upgrade for stored values (BOARD_MIGRATIONS version 26, schema/valuesStep.ts).
// What 1.0 and the 1.1 release candidates stored under Hive's names takes Combwork's once: a fact's actor and codes, an
// action's `by`, the rulesets compiled from `hiveMerges` (their ids recomputed, their facts and lane runs repointed), a
// lane's builder, a history line's `by`, a card's creator, Combwork's own deliveries and fired lines, a metrics series'
// tool, a merge choice, the Assistant's changes. A board converted already, or made by 1.1, changes nothing.
import { join } from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { WAKE_MAX_BYTES } from '../src/shared/watch'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { openDb, type Db } from '../src/main/db'
import { BOARD_MIGRATIONS } from '../src/main/boardStore'
import { mergeMcpSeries, upgradedSettingId, upgradeValues, VALUES_STEP } from '../src/main/schema/valuesStep'
import { renamedNote } from '../src/main/storedNames'
import { canonical, mustCompile, REVIEW_SKIPPED, skipReviewOf, stableHash, type Ruleset } from '../src/shared/workflow/compile'
import { preset, type WorkflowOptions } from '../src/shared/workflow/options'
import { LATENCY_BOUNDS_MS } from '../src/shared/metrics'

const base = tempDir('values-step-')
let n = 0

/** A board at version 25 (before the step), given rows, then opened with every step. */
function board(fill: (db: DatabaseSync) => void): { file: string; db: Db } {
  const file = join(base, `board${++n}.db`)
  const before = openDb(file, { migrations: BOARD_MIGRATIONS.filter((m) => m.version < 26), appVersion: '1.0.0', approve: () => true })
  fill(before.writer)
  before.close()
  return { file, db: openDb(file, { migrations: BOARD_MIGRATIONS, appVersion: '1.1.0', approve: () => true }) }
}

const NOW = '2026-10-01T00:00:00.000Z'
const card = (db: DatabaseSync, num: number, createdBy = 'You'): void => {
  db.prepare('INSERT INTO cards (number, title, description, project, col, ord, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(num, `Card ${num}`, 'Hive wrote this', 'webapp', 'doing', num, NOW, createdBy, NOW)
}
const fact = (db: DatabaseSync, c: number, seq: number, kind: string, actor: string, data: unknown, ruleset: string | null = null): void => {
  db.prepare("INSERT INTO card_facts (card, seq, kind, at, actor, source, ruleset, data) VALUES (?, ?, ?, ?, ?, 'recorded', ?, ?)").run(c, seq, kind, NOW, actor, ruleset, JSON.stringify(data))
}
const all = (db: DatabaseSync, sql: string, ...args: (string | number)[]): Record<string, unknown>[] => db.prepare(sql).all(...args) as Record<string, unknown>[]
const one = (db: DatabaseSync, sql: string, ...args: (string | number)[]): Record<string, unknown> => db.prepare(sql).get(...args) as Record<string, unknown>
const json = (v: unknown): Record<string, unknown> => JSON.parse(String(v)) as Record<string, unknown>
/** Every row of the tables the step touches, to say nothing changed. */
const snapshot = (db: DatabaseSync): string =>
  ['card_facts', 'card_actions', 'rulesets', 'lanes', 'lane_runs', 'card_history', 'cards', 'deliveries', 'watches', 'metrics_series', 'metrics_buckets', 'board_meta', 'assistant_changes', 'assistant_change_values']
    .map((t) => JSON.stringify(all(db, `SELECT * FROM ${t} ORDER BY 1, 2`)))
    .join('\n')

/** The options Combwork merges under (its own value now), compiled; and the ruleset 1.0 stored for them (`hiveMerges`). */
const OPTIONS: WorkflowOptions = { ...preset('git', 'pair'), finish: 'combworkMerges' }
const NEW_RULES = mustCompile(OPTIONS)
const NEW_SKIPPED = skipReviewOf(NEW_RULES)
function asStored(r: Ruleset, id?: (body: Omit<Ruleset, 'id'>) => string): Ruleset {
  const { id: _id, ...body } = { ...r, options: { ...r.options, finish: 'hiveMerges' } } as unknown as Ruleset
  return { id: id ? id(body) : stableHash(canonical(body)), ...body }
}
const OLD_RULES = asStored(NEW_RULES)
const OLD_SKIPPED = asStored(NEW_SKIPPED, () => OLD_RULES.id + REVIEW_SKIPPED)

const timed = (count: number, ms: number): Record<string, unknown> => ({ count, totalMs: ms, maxMs: ms, histogram: LATENCY_BOUNDS_MS.map(() => 0).concat(0).map((_, i) => (i === 0 ? count : 0)) })
const series = (tool: string, count: number, ms: number, chars: number): Record<string, unknown> => ({ tool, role: 'agent', mode: 'compact', outcome: 'ok', ...timed(count, ms), chars, bytes: chars * 2 })

function fill10(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON')
  card(db, 1, 'Hive')
  card(db, 2)
  for (const r of [OLD_RULES, OLD_SKIPPED]) db.prepare('INSERT INTO rulesets (id, data) VALUES (?, ?)').run(r.id, JSON.stringify(r))
  fact(db, 1, 1, 'Started', 'hive', { cycle: 1 }, OLD_RULES.id)
  fact(db, 1, 2, 'Integrated', 'hive', { entry: 'e1', revision: 'r', target: 'main', result: 'x', method: 'merge', by: 'hive' }, OLD_RULES.id)
  fact(db, 1, 3, 'Refused', 'agent:Agent 1', { move: 'integrate', rule: 'merge.hiveMerges', message: 'Hive merges this', next: '' }, OLD_SKIPPED.id)
  fact(db, 1, 4, 'CheckRan', 'hive', { name: 'tests', command: 'npm test', revision: 'r', tested: 'r', result: 'passed', run: 'p1', durationMs: 5, by: 'Hive (merge queue)', counted: true })
  fact(db, 1, 5, 'Undone', 'user', { fact: 2, by: 'hive' })
  fact(db, 2, 1, 'Started', 'agent:Agent 2', { cycle: 1 })
  db.prepare("INSERT INTO card_actions (card, kind, payload) VALUES (1, 'wake', ?), (1, 'wakeOnDecision', ?), (2, 'wake', ?)").run(JSON.stringify({ agent: 'builder', about: 'done', by: 'hive' }), JSON.stringify({ to: 'builder', by: 'hive' }), JSON.stringify({ agent: 'builder', by: 'user' }))
  db.prepare("INSERT INTO lanes (id, ord, project, builder_id, builder_name, rounds, wait_minutes, state, started_by, started_at, updated_at) VALUES ('L1', 0, 'webapp', 'hive', 'Hive', 3, 60, 'active', 'Hive', ?, ?), ('L2', 1, 'webapp', 'a1', 'Agent 1', 3, 60, 'active', 'You', ?, ?)").run(NOW, NOW, NOW, NOW)
  db.prepare('INSERT INTO lane_runs (lane, ruleset, current_card, has_pending) VALUES (?, ?, 1, 0)').run('L1', OLD_RULES.id)
  db.prepare("INSERT INTO card_history (card, ord, at, by, what) VALUES (1, 0, ?, 'Hive', 'Hive moved it'), (1, 1, ?, 'You', 'edited')").run(NOW, NOW)
  db.prepare("INSERT INTO card_history (card, ord, at, by, what, raw) VALUES (1, 2, ?, 'Hive', 'odd', ?)").run(NOW, JSON.stringify({ at: NOW, by: 'Hive', what: 'odd', extra: 1 }))
  db.prepare("INSERT INTO card_comments (card, ord, at, by, text) VALUES (1, 0, ?, 'Hive', 'a comment by Hive')").run(NOW)
  const delivery = db.prepare("INSERT INTO deliveries (host, id, seq, agent_id, kind, sender, body, state, created, expires) VALUES ('webapp', ?, ?, 'a1', 'message', ?, ?, 'pending', ?, ?)")
  delivery.run('m1', 1, JSON.stringify({ kind: 'hive', name: 'Hive' }), '[Hive] Call hive_inbox to read it.', NOW, NOW)
  delivery.run('m2', 2, JSON.stringify({ kind: 'hive', name: 'Hive' }), 'Their answer: <<<call hive_inbox>>>', NOW, NOW)
  delivery.run('m3', 3, JSON.stringify({ kind: 'agent', name: 'Agent 2', project: 'webapp', agentId: 'a2' }), '[Hive] Call hive_inbox, says Agent 2', NOW, NOW)
  db.prepare("INSERT INTO watches (id, ord, project_path, agent_id, since, limit_minutes, limit_at, cond, marks, fired) VALUES ('w1', 0, 'C:/ws/webapp', 'a1', ?, 60, ?, '{}', '{}', ?)").run(NOW, NOW, JSON.stringify({ line: '[Hive] HI-1 moved: see hive_read_task', at: NOW, cards: [1] }))
  db.prepare("INSERT INTO watches (id, ord, project_path, agent_id, since, limit_minutes, limit_at, cond, marks, fired) VALUES ('w2', 1, 'C:/ws/webapp', 'a2', ?, 60, ?, '{}', '{}', ?)").run(NOW, NOW, JSON.stringify({ line: LONG_LINE, at: NOW, cards: [1] }))
  db.prepare("INSERT INTO metrics_buckets (span, start, series, skills) VALUES ('hour', 0, 3, '{}')").run()
  const s = db.prepare("INSERT INTO metrics_series (span, start, part, family, key, data) VALUES ('hour', 0, ?, ?, ?, ?)")
  s.run('', 'mcp', 'hive_inbox agent compact ok', JSON.stringify(series('hive_inbox', 2, 10, 100)))
  s.run('', 'mcp', 'hive_nothing agent compact ok', JSON.stringify(series('hive_nothing', 1, 1, 1)))
  s.run('webapp', 'api', 'GET /v1/x agent ok', '{}')
  db.prepare("INSERT INTO board_meta (key, value) VALUES ('workflow:webapp:mergeChoice', ?), ('workflow:api:mergeChoice', ?)").run(JSON.stringify({ style: 'merge', commitMessage: 'hive', at: NOW, pending: false }), JSON.stringify({ style: 'squash', commitMessage: 'conventional', at: NOW, pending: false }))
  const change = db.prepare("INSERT INTO assistant_changes (id, grp, grp_at, at, kind, act, what, project, target) VALUES (?, 'g', ?, ?, ?, 'x', 'Hive changed it', 'webapp', ?)")
  change.run('c1', NOW, NOW, 'setting', 'agentApi.provideHiveMcp')
  change.run('c2', NOW, NOW, 'setting', 'advanced.hive.showDeveloperFeatures')
  change.run('c3', NOW, NOW, 'setting', 'workspace.advanced.claude-code.override.preApproveHiveTools')
  change.run('c4', NOW, NOW, 'setting', 'workflow.git.finish')
  change.run('c5', NOW, NOW, 'agent', null)
  const value = db.prepare("INSERT INTO assistant_change_values (change, field, side, ord, path, type, text) VALUES (?, ?, ?, ?, ?, 'text', ?)")
  value.run('c4', 'value', 'old', 0, '', 'hiveMerges')
  value.run('c4', 'value', 'new', 0, '', 'agentMerges')
  value.run('c5', 'workflow', 'old', 1, 'finish', 'hiveMerges')
  value.run('c5', 'workflow', 'old', 2, 'commitMessage', 'hive')
  value.run('c5', 'workflow', 'old', 3, 'title', 'hive')
}

/** A fired line just under the cap a watch's line is read with: the note would take it over, so it is left out. */
const LONG_LINE = `[Hive] see hive_read_task ${'x'.repeat(WAKE_MAX_BYTES - 40)}`

describe("the board's values step", () => {
  it('is version 26, the 1.0 group\'s last', () => {
    const step = BOARD_MIGRATIONS.find((m) => m.version === 26)
    expect(step?.name).toBe(VALUES_STEP.name)
    expect(step?.group).toBe(BOARD_MIGRATIONS.find((m) => m.version === 25)?.group)
    expect(Math.max(...BOARD_MIGRATIONS.map((m) => m.version))).toBe(26)
  })

  it('on a fresh board, changes nothing', () => {
    const file = join(base, `fresh${++n}.db`)
    const db = openDb(file, { migrations: BOARD_MIGRATIONS, appVersion: '1.1.0', approve: () => true })
    expect(upgradeValues(db.writer)).toEqual({})
    db.close()
  })

  it("a 1.0 board's every old value takes its new one", () => {
    const { db } = board(fill10)
    const w = db.writer
    // Facts: actors, a merge's and an undo's by, a refusal's rule, a check run's name.
    expect(all(w, "SELECT actor FROM card_facts WHERE card = 1 ORDER BY seq").map((r) => r.actor)).toEqual(['combwork', 'combwork', 'agent:Agent 1', 'combwork', 'user'])
    const data = (seq: number): Record<string, unknown> => json(one(w, 'SELECT data FROM card_facts WHERE card = 1 AND seq = ?', seq).data)
    expect(data(2).by).toBe('combwork')
    expect(data(3)).toEqual({ move: 'integrate', rule: 'merge.combworkMerges', message: 'Hive merges this', next: '' })
    expect(data(4).by).toBe('Combwork (merge queue)')
    expect(data(5).by).toBe('combwork')
    // Actions.
    expect(all(w, 'SELECT payload FROM card_actions ORDER BY id').map((r) => json(r.payload).by)).toEqual(['combwork', 'combwork', 'user'])
    // Lanes, history, creators.
    expect(one(w, "SELECT builder_id, builder_name, started_by FROM lanes WHERE id = 'L1'")).toEqual({ builder_id: 'combwork', builder_name: 'Combwork', started_by: 'Combwork' })
    expect(one(w, "SELECT builder_id, builder_name, started_by FROM lanes WHERE id = 'L2'")).toEqual({ builder_id: 'a1', builder_name: 'Agent 1', started_by: 'You' })
    expect(all(w, 'SELECT by, what FROM card_history WHERE card = 1 ORDER BY ord')).toEqual([{ by: 'Combwork', what: 'Hive moved it' }, { by: 'You', what: 'edited' }, { by: 'Combwork', what: 'odd' }])
    expect(json(one(w, 'SELECT raw FROM card_history WHERE card = 1 AND ord = 2').raw)).toEqual({ at: NOW, by: 'Combwork', what: 'odd', extra: 1 })
    expect(all(w, 'SELECT created_by, description FROM cards ORDER BY number')).toEqual([{ created_by: 'Combwork', description: 'Hive wrote this' }, { created_by: 'You', description: 'Hive wrote this' }])
    // A comment is prose: its `by` is left.
    // A comment's author takes Combwork's name; its text is kept as written.
    expect(one(w, 'SELECT by, text FROM card_comments WHERE card = 1')).toEqual({ by: 'Combwork', text: 'a comment by Hive' })
    // Deliveries: Combwork's own sender and text; another's untouched; text quoted kept.
    const d = (id: string): Record<string, unknown> => one(w, 'SELECT sender, body FROM deliveries WHERE id = ?', id)
    expect(json(d('m1').sender)).toEqual({ kind: 'combwork', name: 'Combwork' })
    expect(d('m1').body).toBe(`[CW] Call hive_inbox to read it. ${renamedNote()}`)
    expect(json(d('m2').sender)).toEqual({ kind: 'combwork', name: 'Combwork' })
    expect(d('m2').body).toBe('Their answer: <<<call hive_inbox>>>')
    expect(d('m3')).toEqual({ sender: JSON.stringify({ kind: 'agent', name: 'Agent 2', project: 'webapp', agentId: 'a2' }), body: '[Hive] Call hive_inbox, says Agent 2' })
    // A watch's fired line.
    expect(json(one(w, "SELECT fired FROM watches WHERE id = 'w2'").fired).line).toBe(`[CW] ${LONG_LINE.slice(7)}`)
    expect(json(one(w, "SELECT fired FROM watches WHERE id = 'w1'").fired)).toEqual({ line: `[CW] HI-1 moved: see hive_read_task ${renamedNote()}`, at: NOW, cards: [1] })
    // Metrics: a known tool renamed (key and tool), one that isn't a tool kept.
    expect(all(w, "SELECT part, family, key FROM metrics_series ORDER BY part, family, key")).toEqual([
      { part: '', family: 'mcp', key: 'cw_inbox agent compact ok' },
      { part: '', family: 'mcp', key: 'hive_nothing agent compact ok' },
      { part: 'webapp', family: 'api', key: 'GET /v1/x agent ok' }
    ])
    expect(json(one(w, "SELECT data FROM metrics_series WHERE key = 'cw_inbox agent compact ok'").data)).toEqual(series('cw_inbox', 2, 10, 100))
    // The merge choice.
    expect(json(one(w, "SELECT value FROM board_meta WHERE key = 'workflow:webapp:mergeChoice'").value).commitMessage).toBe('combwork')
    expect(json(one(w, "SELECT value FROM board_meta WHERE key = 'workflow:api:mergeChoice'").value).commitMessage).toBe('conventional')
    // The Assistant's changes: setting ids, option values (not another member that happens to be 'hive'), lines kept.
    expect(all(w, 'SELECT id, target, what FROM assistant_changes ORDER BY id')).toEqual([
      { id: 'c1', target: 'agentApi.provideCombworkMcp', what: 'Hive changed it' },
      { id: 'c2', target: 'advanced.cw.showDeveloperFeatures', what: 'Hive changed it' },
      { id: 'c3', target: 'workspace.advanced.claude-code.override.preApproveCombworkTools', what: 'Hive changed it' },
      { id: 'c4', target: 'workflow.git.finish', what: 'Hive changed it' },
      { id: 'c5', target: null, what: 'Hive changed it' }
    ])
    expect(all(w, 'SELECT change, side, path, text FROM assistant_change_values ORDER BY change, side, ord')).toEqual([
      { change: 'c4', side: 'new', path: '', text: 'agentMerges' },
      { change: 'c4', side: 'old', path: '', text: 'combworkMerges' },
      { change: 'c5', side: 'old', path: 'finish', text: 'combworkMerges' },
      { change: 'c5', side: 'old', path: 'commitMessage', text: 'combwork' },
      { change: 'c5', side: 'old', path: 'title', text: 'hive' }
    ])
    db.close()
  })

  it("rehashes a ruleset compiled from hiveMerges to the id compile() gives now, its skipped one's too, and repoints what names them", () => {
    const { db } = board(fill10)
    const w = db.writer
    // As compile() and skipReviewOf() make them today, from the converted options.
    expect(OLD_RULES.id).not.toBe(NEW_RULES.id)
    const rows = all(w, 'SELECT id, data FROM rulesets ORDER BY id')
    expect(rows.map((r) => r.id).sort()).toEqual([NEW_RULES.id, NEW_SKIPPED.id].sort())
    expect(NEW_SKIPPED.id).toBe(NEW_RULES.id + REVIEW_SKIPPED)
    for (const r of rows) expect(canonical(json(r.data))).toBe(canonical(r.id === NEW_RULES.id ? NEW_RULES : NEW_SKIPPED))
    expect(all(w, 'SELECT DISTINCT ruleset FROM card_facts WHERE ruleset IS NOT NULL ORDER BY ruleset').map((r) => r.ruleset)).toEqual([NEW_RULES.id, NEW_SKIPPED.id].sort())
    expect(one(w, "SELECT ruleset FROM lane_runs WHERE lane = 'L1'").ruleset).toBe(NEW_RULES.id)
    expect(all(w, 'PRAGMA foreign_key_check')).toEqual([])
    db.close()
  })

  it('a ruleset compiled already from the new value is kept, the old one folded into it', () => {
    const { db } = board((d) => {
      fill10(d)
      d.prepare('INSERT INTO rulesets (id, data) VALUES (?, ?)').run(NEW_RULES.id, JSON.stringify(NEW_RULES))
      fact(d, 2, 2, 'Moved', 'combwork', { from: 'todo', to: 'active' }, NEW_RULES.id)
    })
    expect(all(db.writer, 'SELECT id FROM rulesets ORDER BY id').map((r) => r.id)).toEqual([NEW_RULES.id, NEW_SKIPPED.id].sort())
    expect(all(db.writer, 'PRAGMA foreign_key_check')).toEqual([])
    db.close()
  })

  it("an RC2 board, partly converted: what is new stays, a series recorded under both names is one", () => {
    const { db } = board((d) => {
      fill10(d)
      d.prepare("UPDATE lanes SET builder_id = 'combwork', builder_name = 'Combwork' WHERE id = 'L1'").run()
      d.prepare("INSERT INTO deliveries (host, id, seq, agent_id, kind, sender, body, state, created, expires) VALUES ('webapp', 'm4', 4, 'a1', 'message', ?, ?, 'pending', ?, ?)").run(JSON.stringify({ kind: 'combwork', name: 'Combwork' }), '[CW] Done. Call cw_inbox.', NOW, NOW)
      d.prepare("INSERT INTO metrics_series (span, start, part, family, key, data) VALUES ('hour', 0, '', 'mcp', 'cw_inbox agent compact ok', ?)").run(JSON.stringify(series('cw_inbox', 3, 20, 7)))
    })
    const w = db.writer
    expect(one(w, "SELECT builder_id, builder_name, started_by FROM lanes WHERE id = 'L1'")).toEqual({ builder_id: 'combwork', builder_name: 'Combwork', started_by: 'Combwork' })
    expect(one(w, "SELECT body FROM deliveries WHERE id = 'm4'").body).toBe('[CW] Done. Call cw_inbox.')
    const merged = all(w, "SELECT key, data FROM metrics_series WHERE key LIKE '%inbox%'")
    expect(merged.map((r) => r.key)).toEqual(['cw_inbox agent compact ok'])
    const m = json(merged[0].data)
    expect(m).toMatchObject({ tool: 'cw_inbox', count: 5, totalMs: 30, maxMs: 20, chars: 107, bytes: 214 })
    expect((m.histogram as number[])[0]).toBe(5)
    expect(one(w, "SELECT series FROM metrics_buckets WHERE span = 'hour' AND start = 0").series).toBe(2)
    db.close()
  })

  it('run again, changes nothing (the note is added once)', () => {
    const { db } = board(fill10)
    const w = db.writer
    const before = snapshot(w)
    expect(upgradeValues(w)).toEqual({})
    expect(snapshot(w)).toBe(before)
    expect(String(one(w, "SELECT body FROM deliveries WHERE id = 'm1'").body).split(renamedNote()).length).toBe(2)
    db.close()
  })
})

describe('its pieces', () => {
  it("merges two series as metrics.ts adds a saved one", () => {
    expect(mergeMcpSeries(series('cw_x', 1, 4, 3), series('hive_x', 2, 9, 5))).toEqual({ ...series('cw_x', 3, 13, 8), maxMs: 9, histogram: (series('cw_x', 3, 0, 0).histogram as number[]) })
    expect(mergeMcpSeries({ bad: true }, series('cw_x', 1, 1, 1))).toEqual(series('cw_x', 1, 1, 1))
  })

  it("maps settings' ids, leaving others", () => {
    expect(upgradedSettingId('agentApi.provideHiveMcp')).toBe('agentApi.provideCombworkMcp')
    expect(upgradedSettingId('advanced.codex.override.preApproveHiveTools')).toBe('advanced.codex.override.preApproveCombworkTools')
    expect(upgradedSettingId('advanced.cw.showDeveloperFeatures')).toBe('advanced.cw.showDeveloperFeatures')
    expect(upgradedSettingId('general.theme')).toBe('general.theme')
  })
})
