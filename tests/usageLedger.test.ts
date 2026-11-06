// The usage history's rows (#1106): a parser's state taken up later gives the same usage as reading the whole transcript;
// a session's rows add up to its days and price as its usage always did; a card's rows are its share of the session.
import { readFileSync } from 'fs'
import { join } from 'path'
import { serialize } from 'v8'
import { brotliDecompressSync } from 'zlib'
import { describe, expect, it } from 'vitest'
import { newUsageParser, parserShape, restoreParser, saveParser } from '../src/main/usageParsers'
import { copilotEventsPath } from '../src/main/providers/copilot/events'
import { cardHoldsKey, holdIndex, holdIsSessions, holdsOfCard, keptRows, ledgerRows, rowCost, rowsPart, sessionHolds, summaryOf, usageFromRows, type LedgerRow, type SessionHold, type SessionWho } from '../src/shared/usageLedger'
import { priceUsage } from '../src/shared/usageDays'
import { mergeSpans, sliceSession, sharedSpans } from '../src/shared/cardCosts'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { AppSettings, ProviderId, SessionUsage, TaskCard } from '../src/shared/types'

const T0 = Date.parse('2026-10-12T10:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

/** A Claude Code transcript: a prompt, `n` requests a minute apart, a cost report every 4, a compaction halfway. */
function claude(n: number): string {
  const lines: unknown[] = [{ type: 'user', timestamp: at(0), message: { role: 'user', content: 'Plan it' }, version: '2.1.300' }]
  let total = 0
  for (let i = 0; i < n; i++) {
    lines.push({ type: 'assistant', requestId: `r${i}`, timestamp: at(60 * i + 5), message: { model: 'claude-opus-5-5', usage: { input_tokens: 10 + i, cache_read_input_tokens: 5000 + 100 * i, cache_creation_input_tokens: 200, output_tokens: 300 + i } } })
    if (i === Math.floor(n / 2)) lines.push({ type: 'system', subtype: 'compact_boundary', timestamp: at(60 * i + 30), compactMetadata: { trigger: 'auto', preTokens: 150000, postTokens: 20000 } })
    if (i % 4 === 3) lines.push({ type: 'cost-state', timestamp: at(60 * i + 40), totalCostUSD: (total += 0.25) })
    if (i % 5 === 4) lines.push({ type: 'user', timestamp: at(60 * i + 50), message: { role: 'user', content: `More ${i}` } })
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

const COPILOT_HOME = join(__dirname, 'fixtures', 'copilot')
const CASES: { name: string; provider: ProviderId; id: string; text: string }[] = [
  { name: 'Claude Code', provider: 'claude-code', id: 'c1', text: claude(30) },
  { name: 'Codex', provider: 'codex', id: '01a0f107-1b16-7a81-a829-4af49e744373', text: readFileSync(join(__dirname, 'fixtures', 'codex-0.159.jsonl'), 'utf8') },
  { name: 'Copilot (credits)', provider: 'copilot', id: '5cb5a219-ee72-49a3-b871-cc0c05d27269', text: readFileSync(copilotEventsPath(COPILOT_HOME, '5cb5a219-ee72-49a3-b871-cc0c05d27269'), 'utf8') },
  { name: 'Copilot (exit and resume)', provider: 'copilot', id: '0cb916db-26aa-40f2-86b5-1ba81b225fd2', text: readFileSync(copilotEventsPath(COPILOT_HOME, '0cb916db-26aa-40f2-86b5-1ba81b225fd2'), 'utf8') }
]

const whole = (c: (typeof CASES)[number]): SessionUsage => {
  const p = newUsageParser(c.provider, c.id)!
  p.feed(c.text)
  return p.result()
}

/** Prices for the fixtures' models that have none shipped, so every case has an estimate to compare. */
const SETTINGS: Pick<AppSettings, 'providers'> = {
  providers: {
    ...DEFAULT_SETTINGS.providers,
    copilot: { ...DEFAULT_SETTINGS.providers.copilot, prices: { 'gpt-4.1': { input: 10, cachedInput: 1, output: 20 }, 'mai-code-1.1-flash': { input: 100, cachedInput: 100, output: 100 } } }
  }
}

describe("a parser's saved state", () => {
  for (const c of CASES) {
    it(`${c.name}: taken up at any line, it reads the rest to the same usage as reading it all`, () => {
      const lines = c.text.split('\n')
      const expected = whole(c)
      for (const cut of [1, Math.floor(lines.length / 3), Math.floor(lines.length / 2), lines.length - 2]) {
        const a = newUsageParser(c.provider, c.id)!
        a.feed(lines.slice(0, cut).join('\n') + '\n')
        const b = restoreParser(c.provider, c.id, saveParser(a), parserShape(a))
        expect(b).not.toBeNull()
        b!.feed(lines.slice(cut).join('\n'))
        expect(b!.result()).toEqual(expected)
      }
    })
  }

  it("isn't taken up by a parser of another shape, or when it can't be read", () => {
    const a = newUsageParser('claude-code', 'c1')!
    a.feed(claude(3))
    expect(restoreParser('claude-code', 'c1', saveParser(a), parserShape(a) + ',extra')).toBeNull()
    expect(restoreParser('claude-code', 'c1', new Uint8Array([1, 2, 3]), parserShape(a))).toBeNull()
    // Another provider's state: not its shape.
    expect(restoreParser('codex', 'c1', saveParser(a), parserShape(a))).toBeNull()
    // Saved uncompressed, as before HI-1912: its shape had no format, so it's read afresh.
    const own = Object.getOwnPropertySymbols(a).map((s) => (a as unknown as Record<symbol, object>)[s])[0]
    expect(restoreParser('claude-code', 'c1', serialize(own), parserShape(a).replace(/^[^;]*;/, ''))).toBeNull()
  })

  it("is small for a long session: a request's tokens, not its usage block as written (HI-1912)", () => {
    // Claude Code's usage block as it writes it now (Oct 2026), most of it fields the parser doesn't read.
    const block = (i: number) => ({ input_tokens: 2, cache_creation_input_tokens: 13783 + i, cache_read_input_tokens: 29539 + i, output_tokens: 180 + i, output_tokens_details: { thinking_tokens: 62 }, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: 'standard', cache_creation: { ephemeral_1h_input_tokens: 13783 + i, ephemeral_5m_input_tokens: 0 }, inference_geo: 'global', iterations: [{ input_tokens: 2, output_tokens: 180 + i, cache_read_input_tokens: 29539 + i, cache_creation_input_tokens: 13783 + i, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 13783 + i }, type: 'message' }], speed: 'standard', fallback_credit: null })
    const n = 2000
    const lines = Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'assistant', requestId: `req_011CgC69q7QPG5ogvMf${String(i).padStart(5, '0')}`, timestamp: at(30 * i), message: { model: 'claude-opus-5-5', usage: block(i) } }))
    const a = newUsageParser('claude-code', 'c1')!
    a.feed(lines.join('\n') + '\n')
    const state = saveParser(a)
    // Uncompressed, about 900 bytes a request with the whole block kept, 215 with its tokens; compressed, about 12. The
    // largest of a workspace's states was 3.4 MB, for a session of 4,693 requests.
    expect(brotliDecompressSync(state).length / n).toBeLessThan(300)
    expect(state.length / n).toBeLessThan(60)
    const b = restoreParser('claude-code', 'c1', state, parserShape(a))!
    expect(b.result()).toEqual(a.result())
    expect(b.result().cacheTtlSeconds).toBe(3600)
  })
})

const sumDay = (rows: LedgerRow[], day: string) =>
  rows
    .filter((r) => r.day === day)
    .reduce((t, r) => ({ input: t.input + r.inputTokens, output: t.output + r.outputTokens, write: t.write + r.cacheWriteTokens, read: t.read + r.cacheReadTokens, requests: t.requests + r.requests, prompts: t.prompts + r.prompts, compactions: t.compactions + r.compactions }), { input: 0, output: 0, write: 0, read: 0, requests: 0, prompts: 0, compactions: 0 })

describe("a session's rows", () => {
  for (const c of CASES) {
    it(`${c.name}: add up to each day the parser counted, and price as its usage always did`, () => {
      const raw = whole(c)
      const rows = ledgerRows(raw, [], SETTINGS)
      for (const [day, d] of Object.entries(raw.days ?? {})) {
        expect(sumDay(rows, day)).toEqual({ input: d.inputTokens, output: d.outputTokens, write: d.cacheWriteTokens, read: d.cacheReadTokens, requests: d.requests, prompts: d.prompts, compactions: d.compactions })
      }
      const before = priceUsage(raw, SETTINGS)
      const after = usageFromRows(summaryOf(raw), rows, SETTINGS)
      for (const k of ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'requests', 'userMessages', 'model', 'firstActivity', 'lastActivity'] as const) expect(after[k]).toEqual(before[k])
      expect(after.compactions.length).toBe(before.compactions.length)
      if (before.costUsd === null) expect(after.costUsd).toBeNull()
      else expect(after.costUsd).toBeCloseTo(before.costUsd, 6)
      for (const [day, d] of Object.entries(before.days ?? {})) {
        if (d.costUsd === null) continue
        expect(after.days?.[day].costUsd).toBeCloseTo(d.costUsd, 6)
      }
    })
  }

  it('price with the prices of the time: a change of price or of the cost source needs nothing more', () => {
    const raw = whole(CASES[0])
    const rows = ledgerRows(raw, [], SETTINGS)
    const mine = { providers: { ...SETTINGS.providers, 'claude-code': { ...SETTINGS.providers['claude-code'], costSource: 'prices' as const, prices: { 'claude-opus-5-5': { input: 1_000_000, cachedInput: 0, cacheWrite: 0, output: 0 } } } } }
    const priced = usageFromRows(summaryOf(raw), rows, mine)
    // Every input token at $1 each: the CLI's reports set aside for the user's own prices (#436).
    expect(priced.costUsd).toBeCloseTo(raw.inputTokens, 6)
    expect(priced.costEstimated).toBe(true)
    expect(priced.costUsd).toBeCloseTo(priceUsage(raw, mine).costUsd!, 6)
  })

  it("a card's rows are its share while its agent held it: the day still adds up, and the cost matches slicing the timeline", () => {
    const raw = whole(CASES[0])
    // Held from the 8th to the 20th request's minute, and the 14th to the 20th shared with another card.
    const spans: [number, number][] = [[T0 + 8 * 60_000, T0 + 20 * 60_000]]
    const other: [number, number][] = [[T0 + 14 * 60_000, T0 + 25 * 60_000]]
    const holds: SessionHold[] = [{ card: 7, role: 'build', parts: [...sharedSpans(spans, [other]).entries()] }, { card: 9, role: 'review', parts: [...sharedSpans(other, [spans]).entries()] }]
    const rows = ledgerRows(raw, holds, SETTINGS)
    for (const [day, d] of Object.entries(raw.days ?? {})) expect(sumDay(rows, day).output).toBe(d.outputTokens)
    const seven = rows.filter((r) => r.card === 7)
    expect(seven.length).toBeGreaterThan(0)
    expect(seven.every((r) => r.role === 'build')).toBe(true)
    const part = rowsPart(seven, 'claude-code', SETTINGS)!
    const slice = { usage: raw, timeline: raw.timeline!, from: T0, to: T0 + 3600_000 }
    const alone = sliceSession(slice, [[T0 + 8 * 60_000, T0 + 14 * 60_000]], SETTINGS)!
    const shared = sliceSession(slice, [[T0 + 14 * 60_000, T0 + 20 * 60_000]], SETTINGS)!
    expect(part.outputTokens).toBe(Math.round(alone.outputTokens + shared.outputTokens / 2))
    expect(part.cost).toBeCloseTo(alone.cost + shared.cost / 2, 2)
    expect(part.tokensEstimated).toBe(true)
  })

  it("a kept usage keeps its cost as priced then, and is unknown on a card its agent held while it ran", () => {
    const kept = priceUsage(whole(CASES[0]), SETTINGS)
    const holds: SessionHold[] = [{ card: 3, role: 'build', parts: [[1, [[T0 + 60_000, T0 + 120_000]]]] }, { card: 4, role: 'build', parts: [[1, [[T0 - 10 * 86_400_000, T0 - 9 * 86_400_000]]]] }]
    const rows = keptRows(kept, holds)
    const u = usageFromRows(summaryOf(kept), rows, SETTINGS)
    expect(u.outputTokens).toBe(kept.outputTokens)
    expect(u.costUsd).toBeCloseTo(kept.costUsd!, 6)
    // Prices changing later don't change it (as kept usage never did).
    expect(usageFromRows(summaryOf(kept), rows, { providers: { ...SETTINGS.providers, 'claude-code': { ...SETTINGS.providers['claude-code'], prices: {} } } }).costUsd).toBeCloseTo(kept.costUsd!, 6)
    const onCard = rows.filter((r) => r.card === 3)
    expect(onCard).toHaveLength(1)
    expect(rowsPart(onCard, 'claude-code', SETTINGS)).toMatchObject({ priced: 0, unpriced: 1, tokensUnknown: 1 })
    expect(rows.some((r) => r.card === 4)).toBe(false)
  })

  it("shares out whole tokens and requests that add up to the day: a request shared by cards is still one", () => {
    const when = new Date(T0).toISOString()
    for (const [cards, input, output, requests] of [[2, 1, 1, 1], [3, 7, 5, 1], [2, 3, 1, 3], [4, 1001, 333, 7]] as const) {
      const p = newUsageParser('claude-code', 'r')!
      p.feed(Array.from({ length: requests }, (_, i) => JSON.stringify({ type: 'assistant', requestId: `q${i}`, timestamp: when, message: { model: i % 2 ? 'claude-sonnet-5-5' : 'claude-opus-5-5', usage: { input_tokens: i === 0 ? input - (requests - 1) : 1, output_tokens: i === 0 ? output - (requests - 1) : 1 } } })).join('\n') + '\n')
      const raw = p.result()
      // The same second held by `cards` cards at once (1/k each), each in a role.
      const holds: SessionHold[] = Array.from({ length: cards }, (_, i) => ({ card: i + 1, role: i % 2 ? 'review' : 'build', parts: [[cards, [[T0 - 1000, T0 + 2000]]]] }))
      const rows = ledgerRows(raw, holds, SETTINGS)
      const u = usageFromRows(summaryOf(raw), rows, SETTINGS)
      expect([u.inputTokens, u.outputTokens, u.requests]).toEqual([input, output, requests])
      expect(rows.every((r) => Number.isInteger(r.inputTokens) && Number.isInteger(r.outputTokens) && Number.isInteger(r.requests))).toBe(true)
    }
  })

  it('a row with no price is unknown, never $0', () => {
    const raw = { ...whole(CASES[0]), model: 'claude-unknown-9', costReports: undefined, timeline: undefined }
    const rows = ledgerRows(raw, [], SETTINGS)
    expect(rows.every((r) => rowCost(r, 'claude-code', SETTINGS).usd === null || r.inputTokens + r.outputTokens === 0)).toBe(true)
    expect(usageFromRows(summaryOf(raw), rows, SETTINGS).costUsd).toBeNull()
  })
})

const card = (number: number, held: TaskCard['held']): TaskCard => ({ number, title: `#${number}`, description: '', project: 'demo', agent: null, column: 'done', order: 1, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: at(0), createdBy: 'You', updatedAt: at(0), held })

describe('the cards a session held', () => {
  it("are its agent's holds by id, each role apart, shared while it held several", () => {
    const cards = [
      card(1, [{ agent: 'a1', name: 'HB1', role: 'build', from: at(0), to: at(600) }]),
      card(2, [{ agent: 'a1', name: 'HB1', role: 'build', from: at(300), to: at(900) }, { agent: 'a2', name: 'HR1', role: 'review', from: at(900), to: at(1200) }]),
      card(3, [{ agent: 'a2', name: 'HR1', role: 'review', from: at(0), to: at(60) }])
    ]
    const holds = sessionHolds(cards, { agentId: 'a1' }, () => [], T0 + 10_000_000)
    expect(holds.map((h) => [h.card, h.role])).toEqual([[1, 'build'], [2, 'build']])
    const one = holds.find((h) => h.card === 1)!
    expect(Object.fromEntries(one.parts.map(([k, s]) => [k, s]))).toEqual({ 1: [[T0, T0 + 300_000]], 2: [[T0 + 300_000, T0 + 600_000]] })
  })

  it("from history, by name: the agents named so now, or a record's own name", () => {
    const cards = [card(5, [{ name: 'HB2', role: 'build', from: at(0), to: at(60) }])]
    expect(sessionHolds(cards, { agentId: 'a7' }, (n) => (n === 'HB2' ? ['a7'] : []), T0)).toHaveLength(1)
    expect(sessionHolds(cards, { agentId: 'a8' }, (n) => (n === 'HB2' ? ['a7'] : []), T0)).toHaveLength(0)
    expect(sessionHolds(cards, { agentName: 'hb2' }, () => [], T0)).toHaveLength(1)
  })

  it('are the same from a hold index, read once for every session, as from the cards (HI-1748)', () => {
    // sessionHolds as it was before HI-1748, working every card's holds out again for each session.
    const ms = (iso: string | undefined | null, fallback: number): number => (iso && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : fallback)
    const before = (cards: TaskCard[], s: SessionWho, named: (name: string) => string[], now: number): SessionHold[] => {
      const byName = new Map<string, Map<number, [number, number][]>>()
      for (const c of cards) {
        for (const h of holdsOfCard(c)) {
          const m = byName.get(h.name.toLowerCase()) ?? new Map<number, [number, number][]>()
          m.set(c.number, [...(m.get(c.number) ?? []), [ms(h.from, now), ms(h.to, now)]])
          byName.set(h.name.toLowerCase(), m)
        }
      }
      for (const m of byName.values()) for (const [n, spans] of m) m.set(n, mergeSpans(spans))
      const out: SessionHold[] = []
      for (const c of cards) {
        const groups = new Map<string, { role: 'build' | 'review'; name: string; spans: [number, number][] }>()
        for (const h of holdsOfCard(c)) {
          if (!holdIsSessions(h, s, named)) continue
          const g = groups.get(h.role) ?? { role: h.role, name: h.name, spans: [] }
          g.spans.push([ms(h.from, now), ms(h.to, now)])
          groups.set(h.role, g)
        }
        for (const g of groups.values()) {
          const spans = mergeSpans(g.spans)
          if (!spans.length) continue
          const others = [...(byName.get(g.name.toLowerCase())?.entries() ?? [])].filter(([n]) => n !== c.number).map(([, sp]) => sp)
          out.push({ card: c.number, role: g.role, parts: [...sharedSpans(spans, others).entries()] })
        }
      }
      return out
    }
    let seed = 1748
    const rand = (n: number): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n
    const names = ['HB1', 'hb1', 'HR1', 'HB2', 'Agent 3']
    const ids = ['a1', 'a2', undefined]
    for (let board = 0; board < 20; board++) {
      const cards = Array.from({ length: 30 }, (_, i) =>
        card(
          i + 1,
          Array.from({ length: rand(4) }, () => {
            const from = rand(10) === 0 ? 'not a time' : at(rand(3600))
            // An open hold has no end.
            const to = rand(5) === 0 ? undefined : at(rand(3600))
            const agent = ids[rand(ids.length)]
            return { ...(agent ? { agent } : {}), name: names[rand(names.length)], role: rand(2) ? ('build' as const) : ('review' as const), from, ...(to ? { to } : {}) }
          })
        )
      )
      const named = (n: string): string[] => (n.toLowerCase() === 'hb1' ? ['a1'] : n === 'HR1' ? ['a2'] : [])
      const index = holdIndex(cards)
      for (const who of [{ agentId: 'a1' }, { agentId: 'a2' }, { agentName: 'hb2' }, { agentName: 'Agent 3' }, {}]) {
        for (const now of [T0 + 1800_000, Number.MAX_SAFE_INTEGER]) {
          const want = before(cards, who, named, now)
          expect(sessionHolds(index, who, named, now)).toEqual(want)
          expect(sessionHolds(cards, who, named, now)).toEqual(want)
        }
      }
    }
  })

  it("a card's holds key is the same for another read of it whose holds didn't change, and differs when they did (HI-1887)", () => {
    const holds: TaskCard['held'] = [{ agent: 'a1', name: 'HB1', role: 'build', from: at(0) }]
    const key = cardHoldsKey(card(4, holds))
    // Read again after a comment: another object, other fields changed, the same holds.
    expect(cardHoldsKey({ ...card(4, structuredClone(holds)), comments: [{ at: at(5), by: 'HB1', text: 'note' }] } as TaskCard)).toBe(key)
    expect(cardHoldsKey(card(4, [{ ...holds[0], to: at(60) }]))).not.toBe(key)
    expect(cardHoldsKey(card(4, [{ ...holds[0], role: 'review' }]))).not.toBe(key)
    expect(cardHoldsKey(card(5, holds))).not.toBe(key)
  })
})
