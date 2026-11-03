// The canary dialect (dialects, HI-2065; HI-2438, card 5) over the Assistant's state view and its activity texts: every
// word they say comes through the catalogue, and every startView.* and activity.* id shows in some output.
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'path'
import { inDefaultDialect, say, setProcessChain, type DialectChain } from '../src/shared/agentText'
import { canaryProblems, canaryTexts } from '../src/shared/agentText/canary'
import { formatIcu } from '../src/shared/agentText/icu'
import { startView, type StartViewInput, type ViewCard, type ViewEntry } from '../src/shared/startView'
import { finalWhys, publicReason, UNDO_FINAL, UNDO_FINAL_MSG } from '../src/shared/assistantActivity'
// @ts-expect-error: a plain .mjs module without types
import { readCatalogue } from '../scripts/agentTextExtract.mjs'

const ROOT = join(__dirname, '..')
const catalogue = readCatalogue(ROOT) as Record<string, { text: string }>
const ids = new Set(Object.keys(catalogue))
const chain = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })

afterEach(() => setProcessChain(null))

const empty = (over: Partial<StartViewInput> = {}): StartViewInput => ({ now: new Date('2026-10-18T12:00:00Z'), source: 'startup', counts: [], active: [], blocked: [], lanes: [], agents: [], journal: { decisions: [], incidents: [], onCards: [], digestDue: null }, ...over })
const card = (n: number, over: Partial<ViewCard> = {}): ViewCard => ({ number: n, title: `Title${n}`, column: 'doing', project: 'alpha', agent: 'B1', reviewer: null, blocked: null, ...over })
const entry = (id: number, over: Partial<ViewEntry> = {}): ViewEntry => ({ id, at: '2026-10-15T09:00:00Z', kind: 'decision', project: 'alpha', summary: `Summary${id}`, importance: 1, ...over })

/** The view over its variants, with the values the test put in it (names, titles, kinds, states: not Hive's words). */
function views(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  for (const source of ['startup', 'resume', 'compact', null]) out.push({ name: `empty ${source}`, text: startView(empty({ source })) })
  const full = (n: number): StartViewInput =>
    empty({
      counts: [
        { project: 'alpha', columns: { doing: 1, review: 2, passed: 1, todo: 4 } },
        { project: 'beta', columns: {} }
      ],
      active: Array.from({ length: n }, (_, i) => card(100 + i, { column: i % 2 ? 'review' : 'doing', agent: i % 3 ? 'B2' : null, reviewer: i % 2 ? 'R1' : null })),
      blocked: Array.from({ length: n }, (_, i) => card(200 + i, { column: ['todo', 'hold', 'doing', 'review', 'passed', 'done'][i % 6], agent: i % 2 ? null : 'B3', blocked: `Reason${i}` })),
      lanes: Array.from({ length: n }, (_, i) => ({ project: 'alpha', builder: `B${i}`, reviewer: i % 2 ? 'R1' : null, current: i % 3 ? 12 + i : null, state: ['active', 'paused', 'waiting'][i % 3], pausedOn: i % 3 === 1 ? 40 : null })),
      agents: Array.from({ length: n }, (_, i) => ({ project: 'alpha', name: `A${i}`, status: ['working', 'waiting', 'signin', 'idle'][i % 4], asking: i % 2 ? 'Asking' : null })),
      journal: { decisions: Array.from({ length: n }, (_, i) => entry(i, { importance: i % 3 })), incidents: Array.from({ length: n }, (_, i) => entry(50 + i, { kind: 'incident' })), onCards: Array.from({ length: n }, (_, i) => entry(80 + i, { kind: 'plan' })), digestDue: '2026-W41' }
    })
  for (const n of [1, 4, 12, 40]) out.push({ name: `full ${n}`, text: startView(full(n)) })
  // A crowded view: sections past their caps (board, agents) and past the budget (the journal's), each saying the rest.
  const long = (i: number): ViewEntry['summary'] => `Summary${i} ${'1'.repeat(150)}`
  out.push({
    name: 'crowded',
    text: startView({
      ...full(40),
      counts: Array.from({ length: 30 }, (_, i) => ({ project: `A${i}`, columns: { todo: 1 } })),
      agents: Array.from({ length: 30 }, (_, i) => ({ project: `A${i}`, name: `B${i}`, status: 'working' })),
      journal: { decisions: Array.from({ length: 60 }, (_, i) => entry(i, { summary: long(i) })), incidents: [], onCards: Array.from({ length: 60 }, (_, i) => entry(100 + i, { kind: 'plan', summary: long(i) })), digestDue: null }
    })
  })
  out.push({ name: 'all on hold', text: startView(empty({ blocked: Array.from({ length: 20 }, (_, i) => card(300 + i, { column: 'hold', blocked: 'Later' })) })) })
  return out
}
const VALUES = ['[Hive]', 'alpha', 'beta', 'Asking', 'Later', 'decision', 'incident', 'plan', 'working', 'waiting', 'signin', 'idle', 'active', 'paused', ...Array.from({ length: 400 }, (_, i) => [`Title${i}`, `Summary${i}`, `Reason${i}`, `B${i}`, `A${i}`]).flat(), 'B1', 'B2', 'B3', 'R1']

describe('the canary dialect over the state view and the activity texts (card 5)', () => {
  it('finds every word of them in the catalogue, and every startView and activity id in some output', () => {
    setProcessChain(chain(canaryTexts(catalogue)))
    const seen = new Set<string>()
    const texts = [...views(), ...Object.entries(UNDO_FINAL_MSG).map(([why, m]) => ({ name: `undo ${why}`, text: say(m) }))]
    for (const { name, text } of texts) {
      expect(canaryProblems(text, ids, VALUES), name).toEqual([])
      for (const m of text.matchAll(/⟦([^/⟧][^⟧]*)⟧/g)) seen.add(m[1])
    }
    // The workspace's own cards' "(workspace)" is said in main/startView.ts as it gathers the board (its tests).
    const unreached = [...ids].filter((id) => (id.startsWith('startView.') || id.startsWith('activity.undo.')) && !seen.has(id))
    expect(unreached).toEqual(['startView.workspaceCard'])
  })

  it("keeps what is stored in the Default's English: the public reason, and the undo whys finalWhys reads back", () => {
    setProcessChain(chain(canaryTexts(catalogue)))
    expect([400, 403, 404, 409, 500, undefined].map(publicReason)).toEqual(['The request was invalid', 'Not allowed', 'Not found', 'Not possible now', 'Failed', 'Failed'])
    for (const [why, m] of Object.entries(UNDO_FINAL_MSG)) {
      expect(UNDO_FINAL[why as keyof typeof UNDO_FINAL], why).toBe(inDefaultDialect(() => say(m)))
      expect(formatIcu(m.text), why).toBe(m.text)
      expect(finalWhys(UNDO_FINAL[why as keyof typeof UNDO_FINAL])).toEqual([why])
    }
  })
})
