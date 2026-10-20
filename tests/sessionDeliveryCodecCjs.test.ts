// The suites' copy of the sessions' and deliveries' codec (tests/e2e/sessionDeliveryCodec.cjs, plain JS) agrees with Hive's
// (src/main/schema/sessionDeliveryCodec.ts, #1211): the same field maps, and each one's rows read by the other as they were written.
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'
import * as ts from '../src/main/schema/sessionDeliveryCodec'

const cjs = createRequire(import.meta.url)('./e2e/sessionDeliveryCodec.cjs') as typeof ts & { STORE_FIELDS: typeof ts.STORE_FIELDS }

const at = '2026-10-20T10:00:00.000Z'
const sessions: Record<string, unknown>[] = [
  { id: 's1', agent: 'claude-code', name: 'n', createdAt: at, lastActiveAt: at, archived: false, agentId: 'a1', cards: [{ number: 5, title: 'Five' }, { number: 6, title: 'Six', review: true }], sub: { parentId: null, kind: 'guardian review' }, keptUsage: { inputTokens: 1 }, titleAtRename: null },
  { id: 's2', agent: 'codex', createdAt: at, lastActiveAt: at, archived: 'yes', unknown: [1], name: 'lone \ud800' },
  { id: 's3', agent: 'codex', name: 'n', createdAt: at, lastActiveAt: at, archived: true, cards: [{ number: 'x', title: 't' }], sub: { parentId: 2, kind: 'k' } }
]
const kept: Record<string, unknown>[] = [{ id: 'g', provider: 'codex', name: 'gone', usage: { n: 1 }, cwd: 'D:\\w' }, { id: 'h', usage: null }]
const deliveries: Record<string, unknown>[] = [
  { id: 'm1', seq: 1, agentId: 'a1', conversation: null, kind: 'task', from: { kind: 'hive', name: 'Hive' }, body: 'b', state: 'queued', created: at, expires: at, meta: { a: 1 }, offers: 2 },
  { id: 'm2', seq: 2, agentId: 'a1', conversation: 'c', kind: 'message', from: { kind: 'assistant', name: 'Assistant' }, body: 'b', state: 'acked', created: at, expires: at, acked: at, offers: 'two', newer: true }
]

describe("the suites' codec agrees with Hive's", () => {
  it('has the same field maps', () => {
    expect(cjs.STORE_FIELDS).toEqual(ts.STORE_FIELDS)
  })

  it('writes the same rows, and each reads the other back', () => {
    for (const rec of sessions) {
      const a = ts.sessionToRows('p1', 3, rec)
      expect(cjs.sessionToRows('p1', 3, rec)).toEqual(a)
      expect(cjs.sessionFromRows(a!.row, a!.cards)).toEqual(ts.sessionFromRows(a!.row, a!.cards))
      expect(ts.sessionFromRows(a!.row, a!.cards)).toEqual(JSON.parse(JSON.stringify(rec)))
    }
    for (const k of kept) {
      const a = ts.keptUsageToRow('p1', 0, k)
      expect(cjs.keptUsageToRow('p1', 0, k)).toEqual(a)
      expect(cjs.keptUsageFromRow(a!)).toEqual(ts.keptUsageFromRow(a!))
      expect(ts.keptUsageFromRow(a!)).toEqual(k)
    }
    for (const d of deliveries) {
      const a = ts.deliveryToRow('p1', d)
      expect(cjs.deliveryToRow('p1', d)).toEqual(a)
      expect(cjs.deliveryFromRow(a!)).toEqual(ts.deliveryFromRow(a!))
      expect(ts.deliveryFromRow(a!)).toEqual(d)
    }
  })
})
