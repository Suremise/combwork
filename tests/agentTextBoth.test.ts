// The window's messages agents also read (dialects, HI-2065; card 5b, HI-2440): one descriptor for both audiences. With
// no dialect chain, everything agents get is byte for byte what it was (the error reply, refusals, card history and
// Combwork's comments, fields kept beside their text as data); with one, agents read its override and the window never does.
// Also: the agent branch of `forAgents` as agent messages, and the catalogue's `audience: "both"` entries round-tripping
// through the dialect service's schema check into agentText.
import { join } from 'path'
import { mkdirSync } from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { setChainResolver, type DialectChain } from '../src/shared/agentText'
import { inRequestScope } from '../src/shared/agentText/asyncScope'
import { canaryTexts } from '../src/shared/agentText/canary'
import { parseIcu, placeholdersOf, type Part } from '../src/shared/agentText/icu'
import { agentField, agentText, englishText, forAgents, saidText, shownText, withValues, type TextPart } from '../src/shared/advanced'
import { msg, type Msg } from '../src/shared/i18n'
import { HISTORY, storedForAgents, storedLineText, storedText } from '../src/shared/taskHistory'
import { REFUSALS, refusal, refusalBody, type RuleId } from '../src/shared/workflow/refusals'
import { providerMessage } from '../src/shared/providers'
import { agentTextSchema, checkTexts } from '../src/main/dialects'
// @ts-expect-error: a plain .mjs module without types
import { readCatalogue } from '../scripts/agentTextExtract.mjs'

const base = tempDir('hive-agenttext-both-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { apiErrorReply, entryForAgents, metricsForAgents } = await import('../src/main/servers')
const { agentEnglish, columnError, unknownTask } = await import('../src/main/tasks')
const { agentBusyError } = await import('../src/main/taskStart')
const { HiveError } = await import('../src/main/hiveError')

const ROOT = join(__dirname, '..')
const catalogue = readCatalogue(ROOT) as Record<string, { text: string; note?: string; audience?: string }>
const BOTH = Object.entries(catalogue).filter(([, m]) => m.audience === 'both')
const chainOf = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })
/** A chain in every scope but the Default, as the dialects service resolves one (6b). */
const using = (texts: Record<string, string>): void => setChainResolver(() => chainOf(texts))
const canary = (): void => using(canaryTexts(catalogue))
const AGENT = { projectPath: join(base, 'project'), agentId: 'a-1' }
/** In an agent's request, as the Agent API runs one. */
const asAgent = <T>(fn: () => T): T => inRequestScope(AGENT, fn)

afterEach(() => setChainResolver(null))

/** Values for a message: each select's options and one it hasn't, plurals at 0, 1 and 1234, a plain value. */
function samples(text: string): Record<string, string | number>[] {
  const selects: Record<string, string[]> = Object.create(null)
  const walk = (parts: Part[]): void => {
    for (const p of parts as { type: number; value?: string; options?: Record<string, { value: Part[] }> }[]) {
      if (p.type === 5 && p.value) selects[p.value] = [...new Set([...(selects[p.value] ?? []), ...Object.keys(p.options ?? {}).filter((k) => k !== 'other'), 'unlisted'])]
      for (const o of Object.values(p.options ?? {})) walk(o.value)
    }
  }
  walk(parseIcu(text))
  let out: Record<string, string | number>[] = [{}]
  for (const [name, kind] of Object.entries(placeholdersOf(parseIcu(text)))) {
    const vals: (string | number)[] = kind === 'select' ? selects[name].slice(0, 4) : kind === 'plain' ? ['VALUE'] : [0, 1, 1234]
    out = out.flatMap((v) => vals.map((x) => ({ ...v, [name]: x }))).slice(0, 40)
  }
  return out
}
const descriptor = (id: string): Msg => ({ id, defaultMessage: catalogue[id].text }) as Msg

describe('agentText: the window messages agents read', () => {
  it('lists them in the catalogue by their UI ids, with audience both; their schema loads in the dialect service', () => {
    expect(BOTH.length).toBeGreaterThan(900)
    for (const id of ['tasks.error.archived', 'tasks.history.moved', 'agents.claude.safeguardHelp', 'workflow.refused.submit.empty.message']) expect(catalogue[id]?.audience, id).toBe('both')
    const schema = agentTextSchema()
    for (const [id] of BOTH) expect(schema[id], id).toBeDefined()
  })

  it('say each one exactly as englishText does with no chain, and with a chain that overrides nothing', () => {
    const check = (): void => {
      for (const [id, m] of BOTH) for (const v of samples(m.text)) expect(asAgent(() => agentText(withValues(descriptor(id), v))), id).toBe(englishText(withValues(descriptor(id), v)))
    }
    check()
    using({})
    check()
  })

  it("say a chain's override for agents, inside its markers; the window's text never has one", () => {
    canary()
    for (const [id, m] of BOTH.slice(0, 300)) {
      const v = samples(m.text)[0]
      const said = asAgent(() => agentText(withValues(descriptor(id), v)))
      expect(said, id).toMatch(new RegExp(`^⟦${id.replace(/\./g, '\\.')}⟧[\\s\\S]*⟦/⟧$`))
      expect(asAgent(() => shownText(withValues(descriptor(id), v))), id).not.toContain('⟦')
    }
  })

  it("an override that doesn't format falls back to the English", () => {
    using({ 'tasks.history.moved': 'Moved {nope, plural, }' })
    expect(asAgent(() => agentText(withValues(HISTORY.moved, { column: 'done' })))).toBe('Moved to Done')
  })
})

describe("forAgents: agents' own words as agent messages", () => {
  it('englishText says the agent branch in the Default, shownText the window branch, agentText the agent branch in the chain', () => {
    const e = unknownTask(12) as InstanceType<typeof HiveError>
    expect(englishText(e.text)).toBe('Unknown task #12')
    expect(shownText(e.text)).not.toBe('Unknown task #12')
    using({ 'board.agent.unknownTask': 'No card #{n} here' })
    expect(asAgent(() => agentText(e.text))).toBe('No card #12 here')
    expect(asAgent(() => shownText(e.text))).toBe(shownText(e.text))
    expect(asAgent(() => englishText(e.text))).toBe('Unknown task #12')
  })

  it("a HiveError made inside an agent's scope keeps its message the Default's English; the API's reply is the override", () => {
    using({ 'board.agent.unknownTask': 'No card #{n} here' })
    const e = asAgent(() => unknownTask(4096)) as Error
    expect(e.message).toBe('Unknown task #4096')
    expect(asAgent(() => apiErrorReply(e))).toEqual({ status: 404, body: { error: 'No card #4096 here' } })
    setChainResolver(null)
    expect(apiErrorReply(e)).toEqual({ status: 404, body: { error: 'Unknown task #4096' } })
  })

  it('agentBusyError says what the Agent API always said, for each status and one it has no words for', () => {
    const tail = ". Start the task once it's idle, or give it to another agent."
    const want: Record<string, string> = {
      working: 'is working',
      starting: 'is starting',
      waiting: 'is waiting for the user',
      background: 'is waiting on background tasks it started',
      watching: 'is waiting on cards (a card watch): it takes no other work until it is woken, or the watch is cancelled (Cancel in its header)',
      constructor: 'is waiting on cards (a card watch): it takes no other work until it is woken, or the watch is cancelled (Cancel in its header)'
    }
    for (const [status, words] of Object.entries(want)) {
      const e = agentBusyError('HB1', status)
      expect(e.message, status).toBe(`HB1 ${words}${tail}`)
      expect(asAgent(() => apiErrorReply(e)).body.error, status).toBe(`HB1 ${words}${tail}`)
    }
  })

  it("columnError: agents' column names, through the window message's own id", () => {
    const m = msg({ id: 'tasks.test.column', defaultMessage: 'Not in {column, select, doing {Active} passed {Approved} other {{column}}}', description: 'test' })
    const e = columnError(m, { column: 'doing' })
    expect(e.message).toBe('Not in Doing')
    expect(shownText(e.text)).toBe('Not in Active')
    using({ 'tasks.test.column': 'Card not in {column}' })
    expect(asAgent(() => apiErrorReply(e)).body.error).toBe('Card not in Doing')
  })

  it('text kept in the shape before HI-2440 ({ shown, english }, a notice body) still says its English to agents', () => {
    const old = { shown: 'window words', english: 'Agents read this.' } as TextPart
    expect(englishText(old)).toBe('Agents read this.')
    expect(shownText(old)).toBe('window words')
    using({})
    expect(asAgent(() => agentText(old))).toBe('Agents read this.')
  })

  it('a split branch is overridable as data too (saidText): Default, then an override', () => {
    const t: TextPart = forAgents('window words', saidText({ id: 'board.agent.needsTitle', text: 'A task needs a title.' }))
    expect(englishText(t)).toBe('A task needs a title.')
    expect(shownText(t)).toBe('window words')
    using({ 'board.agent.needsTitle': 'Give it a title.' })
    expect(asAgent(() => agentText(t))).toBe('Give it a title.')
  })
})

describe('refusalBody: the three sentences in the reader’s chain', () => {
  const rules = Object.keys(REFUSALS) as RuleId[]
  const valuesFor = (rule: RuleId): Record<string, string | number>[] => {
    const t = REFUSALS[rule]
    return samples([t.message, t.next, t.change].filter(Boolean).map((m) => (m as Msg).defaultMessage).join(' ')).slice(0, 6)
  }

  it('with no chain, and with one that overrides nothing, says what the refusal was made with, byte for byte', () => {
    for (const rule of rules)
      for (const v of valuesFor(rule)) {
        const r = refusal(rule, v)
        const stored = { refused: true, rule, message: r.message, next: r.next, ...(r.change ? { change: r.change } : {}), override: r.override }
        expect(JSON.stringify(asAgent(() => refusalBody(r))), rule).toBe(JSON.stringify(stored))
        using({})
        expect(JSON.stringify(asAgent(() => refusalBody(r))), rule).toBe(JSON.stringify(stored))
        setChainResolver(null)
      }
  })

  it("says each sentence's override for an agent; a refusal made before keeps working", () => {
    canary()
    const r = refusal('submit.empty', { card: 'HI-1', changes: 'none' })
    const body = asAgent(() => refusalBody(r))
    expect(body.message).toMatch(/^⟦workflow\.refused\.submit\.empty\.message⟧/)
    expect(body.next).toMatch(/^⟦workflow\.refused\.submit\.empty\.next⟧/)
    expect(r.message).not.toContain('⟦')
  })
})

describe('card history and Combwork’s comments, said when read', () => {
  const said = (s: ReturnType<typeof storedText>): string => storedLineText(s, agentEnglish, (id) => providerMessage(id))!

  it('every history line reads as stored with no chain, and the entry keeps its fields in order', () => {
    for (const m of Object.values(HISTORY))
      for (const v of samples(m.defaultMessage).slice(0, 8)) {
        const s = { id: m.id, values: v }
        const what = said(s)
        const entry = { at: '2026-11-03T10:00:00.000Z', by: 'HB1', what, whatText: s, id: 'e1' }
        expect(JSON.stringify(asAgent(() => entryForAgents(entry))), m.id).toBe(JSON.stringify({ at: entry.at, by: entry.by, what }))
        using({})
        expect(asAgent(() => storedForAgents(what, s)), m.id).toBe(what)
        setChainResolver(null)
      }
  })

  it("says a line in the reader's chain where it overrides the line's message, a nested one too", () => {
    using({ 'tasks.history.moved': 'Now in {column}', 'agents.claude.safeguardHelp': 'Use /model to switch back.' })
    const moved = storedText(HISTORY.moved, { column: 'review' })
    expect(asAgent(() => storedForAgents(said(moved), moved))).toBe('Now in Review')
    setChainResolver(null)
    const stop = { id: HISTORY.safeguardStop.id, values: { agent: 'HB1', stops: 0, model: 'none', time: '', to: 'opus', from: 'sonnet', since: '15:00', state: 'none', hasTools: 'no', tools: '', hasHelp: 'yes', help: { id: 'agents.claude.safeguardHelp' } } }
    const english = said(stop)
    using({ 'agents.claude.safeguardHelp': 'Use /model to switch back.' })
    expect(asAgent(() => storedForAgents(english, stop))).toBe(english.replace(/In its terminal:.*$/, 'Use /model to switch back.'))
  })

  it("says an override for a known id whatever wording its English was stored in; with none, as stored", () => {
    const moved = storedText(HISTORY.moved, { column: 'review' })
    expect(asAgent(() => storedForAgents('Moved into Review', moved))).toBe('Moved into Review')
    using({ 'tasks.history.moved': 'DIALECT ARRIVAL {column}' })
    expect(asAgent(() => storedForAgents('Moved into Review', moved))).toBe('DIALECT ARRIVAL Review')
    expect(asAgent(() => entryForAgents({ at: 'x', by: 'HB1', what: 'Moved into Review', whatText: moved, id: 'e' }))).toEqual({ at: 'x', by: 'HB1', what: 'DIALECT ARRIVAL Review' })
  })

  it('keeps as stored: a line with no message (before #845), and an id this Combwork does not know', () => {
    using({ 'tasks.history.moved': 'Now in {column}' })
    expect(asAgent(() => entryForAgents({ at: 'x', by: 'HB1', what: 'Moved to Review' }))).toEqual({ at: 'x', by: 'HB1', what: 'Moved to Review' })
    expect(asAgent(() => storedForAgents('From a newer Combwork', { id: 'tasks.history.fromTheFuture', values: { column: 'review' } }))).toBe('From a newer Combwork')
  })

  it("the queue's return comment (HI-2087), as written and stored: its agents' English said again in the reader's chain, through a card read and a wake", async () => {
    const { returnedComment } = await import('../src/main/workflow/queueState')
    const { cardChange } = await import('../src/shared/watch')
    const failure = { entry: 'q-1', revision: 'abc1234', target: 'main', reason: 'conflict' as const, transient: false, files: ['a.ts'], log: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') }
    const written = returnedComment('HI-1', failure)
    // What commentAsHive keeps: the English and the window's message as they are, through the card file's JSON.
    const comment = { at: '2026-11-03T10:00:01.000Z', by: 'Combwork', text: written.text, hiveText: JSON.parse(JSON.stringify(written.shown)), id: 'c1' }
    const card = { number: 1, column: 'doing', history: [{ at: '2026-11-03T10:00:00.000Z', by: 'Combwork', what: 'Moved to Doing' }], comments: [comment] }
    expect(written.text).toMatch(/^HI-1 came back from the merge queue: a conflict with main in a\.ts\./)
    expect(written.text).toContain('line 39')
    // Its data keeps only the log lines the comment quotes.
    expect(JSON.stringify(written.shown).length).toBeLessThan(800)
    const window = shownText(withValues(HISTORY.queueReturned, written.shown.values as never))
    const wake = JSON.stringify(asAgent(() => cardChange(1, card as never, ['comment'])))
    // No chain, or one that changes none of its texts: exactly as stored.
    expect(asAgent(() => entryForAgents(comment)).text).toBe(written.text)
    using({ 'tasks.history.moved': 'Now in {column}' })
    expect(asAgent(() => entryForAgents(comment)).text).toBe(written.text)
    expect(JSON.stringify(asAgent(() => cardChange(1, card as never, ['comment'])))).toBe(wake)
    // An override of its agent message: said in the reader's chain, the rest of it (files, last lines, next step) kept.
    using({ 'queue.returned.lead': 'DIALECT QUEUE {subject} {cameBack} {failure}' })
    const read = asAgent(() => entryForAgents(comment)).text
    expect(read).toMatch(/^DIALECT QUEUE HI-1 came back from the merge queue a conflict with main in a\.ts/)
    expect(read).toContain('line 39')
    expect(asAgent(() => cardChange(1, card as never, ['comment'])).comment?.firstLine).toMatch(/^DIALECT QUEUE HI-1/)
    // The window's text of it doesn't change.
    expect(asAgent(() => shownText(withValues(HISTORY.queueReturned, written.shown.values as never)))).toBe(window)
    // A return comment written before its data was kept can't be said again: as stored.
    const { agent: _agent, ...legacy } = comment.hiveText
    expect(asAgent(() => storedForAgents(written.text, legacy))).toBe(written.text)
  })

  it("says a nested id's override through entryForAgents, and a wake quotes Combwork's comment in the reader's chain", async () => {
    const { cardChange } = await import('../src/shared/watch')
    const stop = { id: HISTORY.safeguardStop.id, values: { agent: 'HB1', stops: 0, model: 'none', time: '', to: 'opus', from: 'sonnet', since: '15:00', state: 'none', hasTools: 'no', tools: '', hasHelp: 'yes', help: { id: 'agents.claude.safeguardHelp' } } }
    const english = said(stop)
    const card = { number: 7, column: 'doing', history: [{ at: '2026-11-03T10:00:00.000Z', by: 'Combwork', what: 'Moved to Doing' }], comments: [{ at: '2026-11-03T10:00:01.000Z', by: 'Combwork', text: english, hiveText: stop, id: 'c1' }] }
    const before = JSON.stringify(asAgent(() => cardChange(7, card as never, ['comment'])))
    using({ 'agents.claude.safeguardHelp': 'Use /model to switch back.' })
    expect(asAgent(() => entryForAgents(card.comments[0])).text).toBe(english.replace(/In its terminal:.*$/, 'Use /model to switch back.'))
    expect(asAgent(() => cardChange(7, card as never, ['comment'])).comment?.firstLine).toContain('Use /model to switch back.')
    setChainResolver(null)
    expect(JSON.stringify(asAgent(() => cardChange(7, card as never, ['comment'])))).toBe(before)
  })
})

describe('agentField: an English field beside its text as data', () => {
  const t = msg({ id: 'session.test.status', defaultMessage: 'Waiting for the user', description: 'test' })
  it("is the field as it is with no chain; with one, its override when the English is that text's", () => {
    expect(asAgent(() => agentField('Waiting for the user', t))).toBe('Waiting for the user')
    using({ 'session.test.status': 'Asks the user' })
    expect(asAgent(() => agentField('Waiting for the user', t))).toBe('Asks the user')
    expect(asAgent(() => agentField("Claude's own words", t))).toBe("Claude's own words")
    expect(asAgent(() => agentField(undefined, t))).toBeUndefined()
  })

  it("metricsForAgents says each item so, and leaves the window's text behind in the same field order", () => {
    const report = { a: 1, notMeasured: ['Waiting for the user'], notMeasuredText: [t], providersNote: 'x', providersNoteText: 'x', filters: { own: false, notFiltered: ['Waiting for the user'], notFilteredText: [t] } }
    expect(JSON.stringify(metricsForAgents(report))).toBe(JSON.stringify({ a: 1, notMeasured: ['Waiting for the user'], providersNote: 'x', filters: { own: false, notFiltered: ['Waiting for the user'] } }))
    using({ 'session.test.status': 'Asks the user' })
    expect(asAgent(() => metricsForAgents(report))).toEqual({ a: 1, notMeasured: ['Asks the user'], providersNote: 'x', filters: { own: false, notFiltered: ['Asks the user'] } })
  })
})

describe('a dialect override of a shared UI id, end to end', () => {
  it('passes the schema check of the generated schema and reaches agents through the error reply; the window stays', () => {
    const schema = agentTextSchema()
    const { texts, outdated } = checkTexts({ texts: { 'tasks.error.archived': { text: 'Card {card} is archived: bring it back first.' }, 'tasks.error.unknownColumn': { text: 'missing its placeholders' } } }, schema)
    expect(Object.keys(texts)).toEqual(['tasks.error.archived'])
    expect(outdated.map((o) => o.id)).toEqual(['tasks.error.unknownColumn'])
    using(texts)
    const m = descriptor('tasks.error.archived')
    const e = new HiveError(withValues(m, { card: 'HI-9' }))
    expect(asAgent(() => apiErrorReply(e)).body.error).toBe('Card HI-9 is archived: bring it back first.')
    expect(asAgent(() => shownText(e.text))).toBe(englishText(e.text))
    expect(e.message).toBe(englishText(e.text))
  })
})
