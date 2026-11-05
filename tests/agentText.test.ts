// Agent text (dialects, HI-2065; plans/2026-11-03-dialects-design.md, sections 2 and 6): the ICU formatter cw-mcp.js
// can load, say() and its chains (scopes, the resolver hook, the process's dialect file), and the canary dialect over the
// session contract, the first area extracted (card 1). Later extraction cards add their builders to the canary here.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tempDir } from './tempDir'
import { agentList, agentMsg, currentChain, inDefaultDialect, inDialectOf, say, setAgentTextProblemReporter, setChainResolver, setProcessChain, type DialectChain } from '../src/shared/agentText'
import { inRequestScope } from '../src/shared/agentText/asyncScope'
import { formatIcu, IcuError, parseIcu, placeholdersOf, type Part } from '../src/shared/agentText/icu'
import { chainFromFile, loadProcessDialect } from '../src/shared/agentText/processDialect'
import { canaryProblems, canaryTexts } from '../src/shared/agentText/canary'
import { boardSkillsLine, controlRules, combworkInstructions, journalRule, withLatestHandover } from '../src/shared/combworkGuidance'
import { deliveredNotes } from '../src/shared/workspaceNotes'
import { instructionsStarter } from '../src/shared/projectTabs'
import { shareInstructions } from '../src/shared/instructions'
import { launchRecord, skillRevisions } from '../src/main/guidance'
import * as skills from '../src/main/skills'
import * as revisions from '../src/main/revisions'
import { createWorkspaceService, disposeWorkspaceService, inWorkspace } from '../src/main/workspace'
import { cardPart, cardWakeLine, laneNextWords, limitLine, LOOP_WAKE_KINDS, loopStepWords, loopWakeLine, readCondition, releasedLine, wakeLine, wakeLines, watchLabel, withLanesTail, type CardChange, type Released, type ReviewWhere } from '../src/shared/watch'
import { inboxNotice, isDoorbell, unwatchedLanesNotice, type NoticeItem } from '../src/shared/doorbell'
import { ackText, inboxItems, inboxText, offerLine, type DeliveryRecord } from '../src/shared/deliveries'
import { relayLine } from '../src/main/answerRelay'
import { decisionLine } from '../src/main/decisionWakes'
import { cardDecisions } from '../src/main/decisionNotices'
import { laneLimitLine, laneWakeLine, laneWatchLabel, readLaneCards, readLaneCondition } from '../src/shared/laneWatch'
import { agentLimitLine, agentWatchLabel, replyPart } from '../src/shared/agentWatch'
import { usageLimitLine, usageWakeLine, usageWatchLabel } from '../src/shared/usageWatch'
import { restartingLine, resumeNote as restartResumeNote } from '../src/shared/restartResume'
import { resumeNote as outageResumeNote } from '../src/main/outageCore'
import { teamPauseLine } from '../src/shared/teamPause'
// @ts-expect-error: a plain .mjs module without types
import { extractAgentMessages, extractDrift, messageProblems, readCatalogue } from '../scripts/agentTextExtract.mjs'

const ROOT = join(__dirname, '..')
type Catalogue = Record<string, { text: string; note?: string }>
const catalogue = readCatalogue(ROOT) as Catalogue
const schema = (area: string): Record<string, { placeholders: Record<string, string> }> => JSON.parse(readFileSync(join(ROOT, 'agent-text', 'schema', `${area}.json`), 'utf8'))
const chain = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })

afterEach(() => {
  setProcessChain(null)
  setChainResolver(null)
  setAgentTextProblemReporter(() => undefined)
})

describe('the agent text ICU formatter (FormatJS, tags off)', () => {
  /** Sample values for a message: every select option and one it hasn't, plain text, and numbers at 0, 1, 2 and 1,200. */
  function samples(text: string): Record<string, string | number>[] {
    const selects: Record<string, string[]> = Object.create(null)
    const walk = (parts: Part[]): void => {
      for (const p of parts as { type: number; value?: string; options?: Record<string, { value: Part[] }> }[]) {
        if (p.type === 5 && p.value) selects[p.value] = [...new Set([...(selects[p.value] ?? []), ...Object.keys(p.options ?? {}), 'unlisted'])]
        for (const o of Object.values(p.options ?? {})) walk(o.value)
      }
    }
    walk(parseIcu(text))
    let out: Record<string, string | number>[] = [{}]
    for (const [name, kind] of Object.entries(placeholdersOf(parseIcu(text)))) {
      const vals: (string | number)[] = kind === 'select' ? selects[name] : kind === 'plain' ? ['Żółw "x" {y}'] : [0, 1, 2, 1200]
      out = out.flatMap((v) => vals.map((x) => ({ ...v, [name]: x })))
    }
    return out
  }

  it('formats every message of the catalogue, with every select option and some plurals', () => {
    expect(Object.keys(catalogue).length).toBeGreaterThan(40)
    for (const [id, m] of Object.entries(catalogue)) for (const values of samples(m.text)) expect(() => formatIcu(m.text, values), `${id} ${JSON.stringify(values)}`).not.toThrow()
    expect(formatIcu("Combwork's {n, plural, one {# card} other {# cards}} '{'x'}' <command>", { n: 1200 })).toBe("Combwork's 1,200 cards {x} <command>")
  })

  // HI-2433 round 2: a value named like an Object property is a value with no option of its own, so other.
  it("picks other for a select value named like an Object property, and keeps an option of that name its own", () => {
    for (const x of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) expect(formatIcu('{x, select, a {A} other {fallback}}', { x }), x).toBe('fallback')
    expect(formatIcu('{x, select, constructor {C} other {O}}', { x: 'constructor' })).toBe('C')
    expect(formatIcu('{n, plural, =0 {none} one {#} other {# more}}', { n: 0 })).toBe('none')
  })

  it("refuses text that isn't ICU, and a value it needs that is missing", () => {
    for (const bad of ['{open', '{x, plural, one {a}}', '{x, select, a {b} other {c}', '{, select, other {x}}', '{x, select, a {1} a {2} other {3}}']) expect(() => parseIcu(bad), bad).toThrow(IcuError)
    expect(() => formatIcu('Hello {name}')).toThrow(IcuError)
  })

  it('reads one grammar with the extractor: what one accepts, the other does', () => {
    const corpus = ['{n, number, percent}', '{d, date}', '{n, selectordinal, one {#st} other {#th}}', '<b>bold</b> {x}', 'close} and }}', "'{'", "it's {x}'s", '{x, select, constructor {C} other {O}}', '{a b}', '{x, select}', '{x, select, a {1}}', '{open', '{x-y}', '{n, plural, =1.5 {x} other {y}}']
    for (const text of corpus) {
      const extractor = (messageProblems({ 'probe.text': { text } }) as string[]).length === 0
      let runtime = true
      try {
        parseIcu(text)
      } catch {
        runtime = false
      }
      expect(runtime, `${text}: the extractor ${extractor ? 'accepts' : 'refuses'} it`).toBe(extractor)
    }
  })

  it("lists a message's placeholders with their kinds, nested ones too, whatever their names", () => {
    expect(placeholdersOf(parseIcu('{a} {n, plural, one {# {b}} other {{kind, select, x {y} other {{c, number}}}}}'))).toEqual({ a: 'plain', n: 'plural', b: 'plain', kind: 'select', c: 'number' })
    expect({ ...placeholdersOf(parseIcu('{constructor} {toString, select, other {{__proto__}}}')) }).toEqual({ constructor: 'plain', toString: 'select', ['__proto__']: 'plain' })
  })
})

describe('say', () => {
  const M = agentMsg({ id: 'test.thing.case', text: 'Hello {name}, {n, plural, one {# card} other {# cards}}.', note: 'a test' })

  it("says the code's English with no chain, and a chain's override where it has one", () => {
    expect(say(M, { name: 'Ann', n: 2 })).toBe('Hello Ann, 2 cards.')
    setProcessChain(chain({ 'test.thing.case': 'Hi {name} ({n, plural, one {one} other {#}})' }))
    expect(say(M, { name: 'Ann', n: 1 })).toBe('Hi Ann (one)')
    expect(inDefaultDialect(() => say(M, { name: 'Ann', n: 1 }))).toBe('Hello Ann, 1 card.')
  })

  it("falls back to the code's English when an override doesn't format, reporting it once", () => {
    const problems: string[] = []
    setAgentTextProblemReporter((t) => problems.push(t))
    setProcessChain(chain({ 'test.thing.case': 'Hi {nom}' }))
    expect(say(M, { name: 'Ann', n: 1 })).toBe('Hello Ann, 1 card.')
    expect(say(M, { name: 'Bo', n: 1 })).toBe('Hello Bo, 1 card.')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/test\.thing\.case: its override doesn't format \(.*"nom".*\)/)
  })

  it("resolves a scope's chain with the registered resolver, and the Default until one is registered", async () => {
    const alpha = { projectPath: 'C:\\ws\\alpha', agentId: 'a1' }
    // No resolver yet (until the dialects service registers one): every scope is the Default, the process's chain too.
    setProcessChain(chain({ 'test.thing.case': 'process' }))
    expect(inDialectOf(alpha, () => say(M, { name: 'x', n: 1 }))).toBe('Hello x, 1 card.')
    const asked: unknown[] = []
    setChainResolver((scope) => {
      asked.push(scope)
      return scope.kind === 'session' ? chain({ 'test.thing.case': `for ${scope.session.agentId}` }) : chain({ 'test.thing.case': 'for the API' })
    })
    // A scope holds through awaits (main's AsyncLocalStorage, installed by asyncScope.ts).
    const said = await inDialectOf(alpha, async () => {
      // A turn of the event loop on purpose, not a wait for anything: the scope must hold across a real async hop.
      await new Promise((r) => setImmediate(r))
      return say(M, { name: 'x', n: 1 })
    })
    expect(said).toBe('for a1')
    expect(await inRequestScope(null, async () => say(M, { name: 'x', n: 1 }))).toBe('for the API')
    expect(inRequestScope({ projectPath: 'C:\\ws\\.combwork\\assistant', agentId: 'assistant' }, () => say(M, { name: 'x', n: 1 }))).toBe('for assistant')
    expect(asked).toEqual([{ kind: 'session', session: alpha }, { kind: 'api' }, { kind: 'session', session: { projectPath: 'C:\\ws\\.combwork\\assistant', agentId: 'assistant' } }])
    // Outside a scope: the process's chain (hive-mcp.js), else the Default.
    expect(say(M, { name: 'x', n: 1 })).toBe('process')
    expect(currentChain()?.texts['test.thing.case']).toBe('process')
  })

  it('joins a list as agent text does: no serial comma', () => {
    expect([[], ['a'], ['a', 'b'], ['a', 'b', 'c']].map((l) => agentList(l))).toEqual(['', 'a', 'a and b', 'a, b and c'])
  })
})

describe("hive-mcp.js and hive-progress.js's dialect file", () => {
  it('reads the overrides from CW_DIALECT_FILE, and speaks the Default without one or with one it cannot read', () => {
    const dir = tempDir('agent-text-dialect-')
    const file = join(dir, 'dialect.json')
    writeFileSync(file, JSON.stringify({ texts: { 'contract.docs.outline': 'Read big docs by section.', bad: 3 }, files: ['claude-code/cli.json'] }))
    const loaded = loadProcessDialect({ CW_DIALECT_FILE: file, CW_DIALECT: 'abc123' })
    expect(loaded).toEqual({ texts: { 'contract.docs.outline': 'Read big docs by section.' }, files: ['claude-code/cli.json'], hash: 'abc123' })
    expect(combworkInstructions('web').split('\n')[2]).toBe('Read big docs by section.')
    expect(loadProcessDialect({ CW_DIALECT_FILE: join(dir, 'missing.json') })).toBeNull()
    expect(combworkInstructions('web').split('\n')[2]).toMatch(/^Markdown over about 20 KB/)
    expect(loadProcessDialect({})).toBeNull()
    for (const raw of ['not json', '[]', '{"texts": []}', '{"files": []}']) expect(chainFromFile(raw), raw).toBeNull()
  })

  it('is loaded by each script first, before any text is said', () => {
    for (const entry of ['src/main/mcp/cw-mcp.ts', 'src/main/progressReporters/cw-progress.ts']) {
      const imports = [...readFileSync(join(ROOT, entry), 'utf8').matchAll(/^import\s.*$/gm)].map((m) => m[0])
      expect(imports[0], entry).toBe("import '../../shared/agentText/processDialect'")
    }
  })
})

describe('the catalogue', () => {
  it("is up to date with the code, and its schema is each message's placeholders", () => {
    expect(extractDrift(ROOT)).toEqual([])
    const messages = extractAgentMessages(ROOT) as Catalogue
    expect(messages).toEqual(catalogue)
    for (const [id, m] of Object.entries(messages)) expect(schema(id.split('.')[0])[id].placeholders, id).toEqual(placeholdersOf(parseIcu(m.text)))
  })
})

describe('the canary dialect over the session contract (card 1)', () => {
  const ids = new Set(Object.keys(catalogue))
  const SKILLS = ['work-on-card', 'review-agent-work', 'card-loop', 'generalist', 'handover', 'pick-up', 'workspace-note', 'merge-ready', 'split-work', 'use-cw-api']
  /** Every variant of the contract's text, each with the values a test passed in it (names, paths). */
  function contractTexts(): { name: string; text: string; values: string[] }[] {
    const out: { name: string; text: string; values: string[] }[] = []
    for (let mask = 0; mask < 1 << SKILLS.length; mask += 37) out.push({ name: `board ${mask}`, text: boardSkillsLine(new Set(SKILLS.filter((_, i) => mask & (1 << i)))), values: [] })
    for (const role of ['agent', 'assistant'] as const)
      for (const progress of [true, false])
        for (const journal of [null, [], ['decision', 'plan']]) out.push({ name: `${role} ${progress} ${JSON.stringify(journal)}`, text: combworkInstructions('webapp', role, progress, undefined, journal), values: ['webapp', 'decision', 'plan'] })
    out.push({ name: 'no project', text: combworkInstructions(''), values: [] })
    for (const level of ['look', 'agents', 'projects'] as const) for (const cs of [true, false]) out.push({ name: `control ${level} ${cs}`, text: controlRules(level, cs), values: [] })
    out.push({ name: 'journal', text: journalRule([]), values: [] })
    out.push({ name: 'handover', text: withLatestHandover('', 'handovers/2026-10-03-web.md'), values: ['handovers/2026-10-03-web.md'] })
    out.push({ name: 'notes', text: deliveredNotes('MACHINE NOTE').text, values: ['MACHINE NOTE', 'Workspace notes'] })
    out.push({ name: 'notes cut', text: deliveredNotes('MACHINE NOTE\n'.repeat(500), 600).text, values: ['MACHINE NOTE', 'Workspace notes'] })
    out.push({ name: 'starter', text: instructionsStarter('webapp', 'Codex'), values: ['webapp', 'Codex'] })
    out.push({ name: 'shared starter', text: shareInstructions([{ provider: 'claude-code', file: 'CLAUDE.md', content: null, importLine: '@AGENTS.md' }], null, 'webapp')['AGENTS.md'], values: ['webapp'] })
    return out
  }

  it('finds every word of it in the catalogue, and every catalogued text of it in some variant', () => {
    setProcessChain(chain(canaryTexts(catalogue)))
    const seen = new Set<string>()
    for (const { name, text, values } of contractTexts()) {
      expect(canaryProblems(text, ids, values), name).toEqual([])
      for (const m of text.matchAll(/⟦([^/⟧][^⟧]*)⟧/g)) seen.add(m[1])
    }
    // The canary covers the strings card 1 extracted: each contract id shows in what agents get. (Those the Agent API's
    // skill status and launch record say are its unit tests', below.)
    const said = [...ids].filter((id) => id.startsWith('contract.') && !id.startsWith('contract.skill.'))
    expect(said.filter((id) => !seen.has(id))).toEqual([])
  })

  it('finds text glued on in code: the check fails where a word bypasses the catalogue', () => {
    setProcessChain(chain(canaryTexts(catalogue)))
    expect(canaryProblems(`${combworkInstructions('webapp')}\nAlso, be nice.`, ids, ['webapp'])).toEqual([expect.stringMatching(/^text outside the catalogue: Also, be, nice/)])
    expect(canaryProblems('⟦no.such.id⟧x⟦/⟧', ids)).toEqual(["markers naming ids the schema hasn't: no.such.id"])
    expect(canaryProblems('⟦contract.docs.outline⟧x', ids)).toEqual(['unbalanced markers'])
  })
})

describe('the canary dialect over wakes, doorbells and the inbox (card 4, HI-2437)', () => {
  const ids = new Set(Object.keys(catalogue))
  /** Protocol, outside the catalogue: Combwork's fixed prefixes, and the user's name when they set none. */
  const PROTOCOL = ['[CW]', 'New in your inbox:', 'User']
  const NAMES = ['Codex', 'Claudette', 'Reviewer', 'Builder', 'Sam', 'Fix the parser', 'needs logs', 'Round one failed', 'design text', 'waiting on the API']
  type Said = { name: string; text: string; values?: string[] }
  const change = (n: number, over: Partial<CardChange> = {}): CardChange => ({ number: n, column: 'review', changes: ['column'], by: 'Codex', comment: null, ...over })
  const commented = (n: number, text = 'Round one failed', over: Partial<CardChange> = {}): CardChange => change(n, { comment: { by: 'Codex', firstLine: text }, ...over })

  /** Every kind of wake line watch.ts makes, and the doorbell's notices, with what fills them. */
  function wakeTexts(): Said[] {
    const out: Said[] = []
    const add = (name: string, text: string, values: string[] = []): void => void out.push({ name, text, values })
    // A card watch's line: each part of where a card is.
    add('plain', wakeLine(change(1)))
    add('comment, more', wakeLine(commented(1), 2))
    add('owner, passed', wakeLine(change(1, { column: 'passed', changes: ['verdict'], about: { owner: 'Claudette', verdict: { passed: true, by: 'Codex' } } })))
    add('failed, returned', wakeLine(change(1, { changes: ['column'], about: { owner: null, verdict: { passed: false, by: 'Codex' }, returned: 2 } })))
    add('blocked, handoffs', wakeLine(change(1, { changes: ['blocked', 'request', 'decision', 'step'], blocked: 'waiting on the API' })))
    add('archived', wakeLine(change(1, { changes: 'gone', column: 'gone', archived: true })))
    add('gone', wakeLine(change(1, { changes: 'gone', column: 'gone' })))
    add('long comment', wakeLine(commented(1, 'needs logs '.repeat(200))))
    // Several cards, as each gives way to fit.
    add('many', wakeLines([commented(1), change(2, { changes: ['blocked'], blocked: 'waiting on the API' })]))
    add('part, no reason', cardPart(change(1, { changes: ['blocked'], blocked: 'waiting on the API' }), 0))
    add('resubmitted', cardPart(change(1, { about: { owner: null, verdict: null, resubmitted: 'x' } }), 0))
    const flags = (n: number): CardChange => change(n, { changes: ['blocked', 'request', 'decision', 'step'], blocked: 'waiting on the API', about: { owner: 'Claudette', verdict: { passed: n % 2 === 0, by: 'Codex' } } })
    // Lines that give way to fit, at each size (the canary's markers lengthen them, so each shape is reached at some size).
    const others = [change(30, { changes: 'gone', column: 'gone', archived: true }), change(31, { changes: 'gone', column: 'gone' }), change(32, { about: { owner: null, verdict: null, returned: 3 } })]
    for (let n = 2; n <= 60; n++) add(`many ${n}`, wakeLines(Array.from({ length: n }, (_, i) => flags(i + 1))))
    for (let n = 0; n <= 6; n++) add(`many gone ${n}`, wakeLines([...Array.from({ length: n }, (_, i) => flags(i + 1)), ...others]))
    add('numbers, more', wakeLines(Array.from({ length: 200 }, (_, i) => flags(i + 1))))
    // Loop wakes, each kind, and a lane's next card.
    for (const kind of LOOP_WAKE_KINDS) add(`loop ${kind}`, loopWakeLine(commented(1), kind, 'needs logs'))
    for (const next of ['paused', 'last', ...(['combworkStarts', 'start', 'started', 'waits'] as const).map((is) => ({ card: 9, title: 'Fix the parser', is }))] as const) add(`next ${JSON.stringify(next)}`, loopWakeLine(change(1, { column: 'done' }), 'done', undefined, laneNextWords(next)))
    for (const step of ['design', 'followUp', 'proceed', 'ok', 'gaps']) for (const of of ['design', 'followUp']) add(`step ${step} ${of}`, loopWakeLine(change(1), 'step', loopStepWords(step, 'design text', 'd1', of)), ['d1'])
    // The Assistant's card wake with the user's replies, and cards that left a watch.
    const replies = [{ agentName: 'Sam', cards: [1, 2], text: 'needs logs' }]
    add('replies', cardWakeLine([], replies, [], 'User').line)
    add('replies, changes', cardWakeLine([commented(3)], replies, [{ number: 4, why: 'reassigned', detail: 'Sam' }], 'User').line)
    for (let n = 1; n <= 40; n++) add(`replies ${n}`, cardWakeLine(Array.from({ length: n }, (_, i) => flags(i + 1)), replies, [{ number: 50, why: 'done', detail: null }], 'User').line)
    add('replies, too many', cardWakeLine([], Array.from({ length: 200 }, (_, i) => ({ agentName: `Sam${'x'.repeat(30)}${i}`, cards: [i + 1], text: 'needs logs' })), [], 'User').line, ['Sam', 'x'])
    const released: Released[] = [
      { number: 1, why: 'reassigned', detail: 'Sam' },
      { number: 2, why: 'reassigned', detail: null },
      { number: 3, why: 'reviewer', detail: 'Reviewer' },
      { number: 4, why: 'reviewer', detail: null },
      { number: 5, why: 'blocked', detail: 'waiting on the API' },
      { number: 6, why: 'done', detail: null },
      { number: 7, why: 'laneEnded', detail: 'abandoned' },
      { number: 8, why: 'laneEnded', detail: null }
    ]
    for (const r of released) add(`released ${r.why} ${r.detail}`, releasedLine([r]))
    add('released', releasedLine(released))
    add('released, two', releasedLine(released.slice(0, 2)))
    add('released, too many', releasedLine(Array.from({ length: 60 }, (_, i) => ({ number: i + 1, why: 'blocked', detail: 'waiting on the API '.repeat(10) }))))
    add('released, over, too many', releasedLine(Array.from({ length: 60 }, (_, i) => ({ number: i + 1, why: 'laneEnded', detail: null }))))
    // A watch's limit passing: each place a card can be, and each step.
    const where: ReviewWhere[] = [
      { number: 11, state: 'reviewing', reviewer: 'Reviewer' },
      { number: 12, state: 'assigned', reviewer: 'Reviewer' },
      { number: 13, state: 'pool' },
      { number: 14, state: 'review' },
      { number: 15, state: 'waits', on: [16] },
      { number: 16, state: 'working', reviewer: 'Builder' }
    ]
    add('limit', limitLine({ cards: [1, 11, 12, 13, 14, 15, 16, 20], changes: ['column'] }, 90, [released[0]], where))
    add('limit, minutes', limitLine({ cards: [20], changes: ['column'] }, 30))
    add('limit, one each', limitLine({ cards: [11, 15], changes: ['column'] }, 30, [], [where[0], where[4]]))
    for (const w of where) add(`limit ${w.state}`, limitLine({ cards: [w.number, 30], changes: ['column'] }, 30, [released[1]], [w]))
    for (let n = 1; n <= 12; n++) add(`limit short ${n}`, limitLine({ cards: Array.from({ length: n * 2 }, (_, i) => i + 9), changes: ['column'] }, 30, [], Array.from({ length: n * 2 }, (_, i) => ({ number: i + 9, ...(i % 2 ? { state: 'waits' as const, on: [99] } : { state: 'assigned' as const, reviewer: 'Reviewer' }) }))))
    add('limit, short', limitLine({ cards: Array.from({ length: 20 }, (_, i) => i + 1), changes: ['column'] }, 30, released, Array.from({ length: 12 }, (_, i) => ({ number: i + 9, state: 'assigned', reviewer: 'Reviewer'.repeat(5) }))), ['Reviewer'])
    add('limit, too long', limitLine({ cards: Array.from({ length: 20 }, (_, i) => i + 1), changes: ['column'] }, 30, Array.from({ length: 60 }, (_, i) => ({ number: i + 1, why: 'blocked', detail: 'waiting on the API '.repeat(10) }))))
    add('label', watchLabel({ cards: [1, 2] }))
    add('label, column', watchLabel({ cards: [1], column: 'review' }))
    for (const args of [{}, { cards: Array.from({ length: 30 }, (_, i) => i + 1) }, { cards: [1], column: 'x' }, { cards: [1], changes: ['x'] }, { cards: [1], column: 'review', changes: ['comment'] }, { cards: [1], fresh: 'x' }, { cards: [1], fresh: true }]) {
      const r = readCondition(args)
      if (typeof r === 'string') add(`condition ${JSON.stringify(args)}`, r, ['column', 'comment', 'verdict', 'agent', 'hold', 'todo', 'doing', 'review', 'passed', 'done'])
    }
    add('lanes tail', withLanesTail(wakeLine(change(1))))
    // The doorbell and the inbox's notices.
    const kinds = ['task', 'handover', 'answer', 'rebrief', 'card-event', 'control'] as const
    const items = (n: number, ack = true): NoticeItem[] => Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, kind: ack ? kinds[i % kinds.length] : 'card-event', ...(i % 2 ? { card: i + 1 } : {}) }))
    const ms = Array.from({ length: 40 }, (_, i) => `m${i + 1}`)
    for (const at of ['checkpoint', 'drain', 'doorbell'] as const) {
      add(`notice ${at} one`, inboxNotice(at, items(1)), ms)
      add(`notice ${at} many`, inboxNotice(at, items(30)), ms)
      add(`notice ${at} events`, inboxNotice(at, items(2, false)), ms)
      add(`notice ${at} event`, inboxNotice(at, items(1, false)), ms)
    }
    add('lanes', unwatchedLanesNotice(['HB1', 'HB2']), ['HB1', 'HB2'])
    add('lanes, more', unwatchedLanesNotice(Array.from({ length: 14 }, (_, i) => `HB${i}`)), Array.from({ length: 14 }, (_, i) => `HB${i}`))
    add('lanes, nameless', unwatchedLanesNotice(['🐝']))
    add('lanes, nameless two', unwatchedLanesNotice(['🐝', '🐝🐝']))
    return out
  }

  /** What a builder said, in the canary chain: no word outside the catalogue, and the ids it said. */
  function check(texts: Said[]): Set<string> {
    const seen = new Set<string>()
    for (const { name, text, values } of texts) {
      expect(canaryProblems(text, ids, [...PROTOCOL, ...NAMES, ...(values ?? [])]), name).toEqual([])
      for (const m of text.matchAll(/⟦([^/⟧][^⟧]*)⟧/g)) seen.add(m[1])
    }
    return seen
  }

  it("finds every word of watch.ts's wakes and the doorbell in the catalogue, and says each of their texts", () => {
    setProcessChain(chain(canaryTexts(catalogue)))
    const seen = check(wakeTexts())
    // Each text watch.ts and doorbell.ts declare shows in some wake. (wake.many.count is the last resort for a line no
    // card's key fits in, past any watch's size.)
    const own = [...ids].filter((id) => id.startsWith('doorbell.') || WATCH_IDS.has(id))
    expect(own.filter((id) => !seen.has(id) && id !== 'wake.many.count')).toEqual([])
  })

  it('prints counts as the code did, with no thousands separators (no ICU #)', () => {
    const events = (n: number): NoticeItem[] => Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, kind: 'card-event' }))
    expect(inboxNotice('doorbell', events(1500))).toMatch(/^\[CW\] New in your inbox: 1500 card events \(m1, /)
    expect(unwatchedLanesNotice(Array.from({ length: 1200 }, () => '🐝'))).toContain('(1200 lanes)')
    expect(wakeLine(change(1), 1200)).toContain(' (and 1200 more watched cards changed)')
  })

  it('says a wake in the dialect of the session it is for', () => {
    setChainResolver((scope) => (scope.kind === 'session' && scope.session.agentId === 'a2' ? chain({ 'wake.card.ended': '. Watch over.', 'doorbell.notice.doorbell': '{what}: read {n, plural, one {it} other {them}}.' }) : null))
    const line = (agentId: string): string => inDialectOf({ projectPath: 'C:/ws/p', agentId }, () => wakeLine(change(1)))
    expect(line('a1')).toBe('[CW] #1 is in Review. Your card watch has ended: carry on (cw_read_task with latestComment for the comment in full).')
    expect(line('a2')).toBe('[CW] #1 is in Review. Watch over.')
    // The doorbell's fixed opening stays, so isDoorbell still finds it.
    const bell = inDialectOf({ projectPath: 'C:/ws/p', agentId: 'a2' }, () => inboxNotice('doorbell', [{ id: 'm1', kind: 'task' }]))
    expect(bell).toBe('[CW] New in your inbox: 1 task (m1): read it.')
    expect(isDoorbell(bell)).toBe(true)
  })
})

describe("the canary dialect over the inbox's, lane, agent and usage watches' and Combwork's notices' builders (card 4)", () => {
  const ids = new Set(Object.keys(catalogue))
  const PROTOCOL = ['[CW]', 'New in your inbox:', 'User']
  const VALUES = ['HB1', 'HB2', 'alpha', 'Ship it', 'Yes', 'hello', 'Anthropic', 'greet', 'l-1', '1.0.0', '1.0.1', 'UTC', 'nope', 'x']
  const ms = Array.from({ length: 30 }, (_, i) => `m${i + 1}`)
  const record = (n: number, over: Partial<DeliveryRecord> = {}): DeliveryRecord => ({ id: `m${n}`, seq: n, agentId: 'a1', conversation: null, kind: 'card-event', from: { kind: 'combwork', name: 'Combwork' }, card: 7, body: 'hello', state: 'offered', created: '2026-11-03T10:00:00.000Z', expires: '2026-11-04T10:00:00.000Z', ...over })
  const agent = { projectPath: 'C:/ws/alpha', agentId: 'b1', name: 'HB1', project: 'alpha' }

  function texts(): { name: string; text: string; values?: string[] }[] {
    const out: { name: string; text: string; values?: string[] }[] = []
    const add = (name: string, text: string | null | undefined, values: string[] = []): void => void out.push({ name, text: text ?? '', values })
    // The inbox (shared/deliveries.ts) and the user's answers relayed to the Assistant (answerRelay.ts).
    add('offer', offerLine([record(1), record(2, { kind: 'task', again: 'Combwork restarted while offering it' })], 'Waiting for #12'), ['Combwork restarted while offering it'])
    add('offer, no watch', offerLine([record(1)], null))
    add('inbox', inboxText(inboxItems([record(1), record(2), record(3, { kind: 'task', card: 9 })]), ['m1']), ['Combwork'])
    add('inbox, empty', inboxText([], ['m3']))
    add('ack', ackText(['m1'], ['m9'], ['m2'], true))
    add('ack, unread', ackText([], [], ['m2', 'm3']))
    for (const outcome of ['approved', 'declined', 'answered'] as const)
      for (const need of ['done', null] as const) add(`relay ${outcome} ${need}`, relayLine({ card: 12, key: '#12', project: 'alpha', asker: 'a1', askerName: 'HB1', request: 'r1', question: 'Ship it', outcome, ...(outcome !== 'declined' ? { reply: 'Yes', ...(outcome === 'approved' ? { decision: 'Yes' } : {}) } : {}), need }))
    // Decisions (decisionWakes.ts, decisionNotices.ts).
    add('decisions', decisionLine(new Map([[7, { count: 1 }], [9, { count: 3 }]]), new Set([7])))
    add('decision', decisionLine(new Map([[7, { count: 2 }]])))
    add('decision notice', cardDecisions(7, 2))
    // Lane, agent and usage watches.
    add('lane label', laneWatchLabel({ ids: 'all', events: [] }, [4], [{ name: 'HB2' }]))
    add('lane label, ids', laneWatchLabel({ ids: ['l-1'], events: [] }))
    add('lane label, named', laneWatchLabel({ ids: ['l-1'], events: [] }, [], [], { 'l-1': { name: 'greetings', builder: 'HB2', twin: true } }), ['greetings'])
    add('lane limit', laneLimitLine({ ids: ['l-1', 'l-2'], events: [] }, 90, [4], [{ name: 'HB2' }]), ['l-2'])
    add('lane waits', laneWakeLine([], { cards: [], waits: [{ name: 'HB1', project: 'alpha', card: 12, what: 'Ship it' }, { name: 'HB2', project: 'alpha', card: null, what: null }], watching: true, following: true }))
    add('lane cards', readLaneCards({ cards: 'x' }) as string)
    add('lane changes', readLaneCards({ changes: ['nope'] }) as string, ['column', 'comment', 'verdict', 'agent'])
    add('lane lanes', readLaneCondition({ lanes: 5 }) as string)
    add('lane events', readLaneCondition({ lanes: 'all', events: ['nope'] }) as string, ['failed', 'passed', 'blocked', 'unblocked', 'reblocked', 'stalled', 'moved', 'merge-due', 'ended', 'abandoned', 'waiting', 'paused-merge', 'paused-user'])
    add('agent label', agentWatchLabel({ agents: [agent], ignoreBackground: false }))
    add('agent limit', agentLimitLine({ agents: [agent], ignoreBackground: false }, 45))
    add('agent reply', replyPart('HB1', '(alpha)', 'hello'))
    const usage = [{ account: 'a', name: 'Anthropic', percent: 98, limit: 'weekly' as const }]
    add('usage label', usageWatchLabel(usage))
    add('usage wake', usageWakeLine(['Anthropic']))
    add('usage limit', usageLimitLine(usage, 60))
    // Combwork's notices: restarts, outages, a team pause.
    add('restarting', restartingLine())
    add('resumed', restartResumeNote({ from: '1.0.0', at: '2026-11-03T10:00:00Z', status: 'watching', card: { label: '#12', round: 2 }, lane: { id: 'l-1', name: 'greet', role: 'builder' } }, '1.0.1', 'update'))
    add('resumed, quit', restartResumeNote({ from: '1.0.0', at: '2026-11-03T10:00:00Z', status: 'working' }, '1.0.0', 'quit'))
    add('outage', outageResumeNote(Date.parse('2026-10-25T11:47:00Z'), Date.parse('2026-10-25T11:57:00Z')))
    add('team pause', teamPauseLine())
    return out
  }

  it('finds every word of them in the catalogue', () => {
    setProcessChain(chain(canaryTexts(catalogue)))
    for (const { name, text, values } of texts()) {
      expect(text, name).not.toBe('')
      expect(canaryProblems(text, ids, [...PROTOCOL, ...VALUES, ...ms, ...(values ?? [])]), name).toEqual([])
    }
  })
})

/** The ids watch.ts declares (its wake lines' W). */
const WATCH_IDS = new Set([...readFileSync(join(ROOT, 'src', 'shared', 'watch.ts'), 'utf8').matchAll(/agentMsg\(\{ id: '([^']+)'/g)].map((m) => m[1]))

describe('the skill status lines in guidance.ts', () => {
  // HI-2433 round 1: callers asking at once share one scan, which must hold no text; each caller says its skills'
  // problems in its own dialect. A, then B and C while A's scan is held: B and C share the next scan.
  it("say a shared scan's problems in each caller's own dialect", async () => {
    const w = createWorkspaceService()
    let release = (): void => undefined
    let reached = (): void => undefined
    const held = new Promise<void>((r) => (release = r))
    const reading = new Promise<void>((r) => (reached = r))
    let scans = 0
    vi.spyOn(skills, 'combworkSkills').mockImplementation(async () => {
      if (scans++ === 0) {
        reached()
        await held
      }
      return [{ name: 'broken', path: 'C:/missing', problem: 'bad header' }] as never
    })
    vi.spyOn(revisions, 'revisionOf').mockResolvedValue('r1')
    setChainResolver((scope) => chain({ 'contract.skill.nobody': scope.kind === 'session' ? `${scope.session.agentId}: {why}` : 'api: {why}' }))
    const call = (id: string): Promise<{ problem?: string }[]> => inWorkspace(w, () => inDialectOf({ projectPath: 'C:/ws/p', agentId: id }, () => skillRevisions()))
    try {
      const a = call('A')
      await reading
      const [b, c] = [call('B'), call('C')]
      release()
      expect((await Promise.all([a, b, c])).map((r) => r[0].problem)).toEqual(['A: bad header', 'B: bad header', 'C: bad header'])
      expect(scans).toBe(2)
    } finally {
      vi.restoreAllMocks()
      await disposeWorkspaceService(w)
    }
  })

  it("keep a launch record's problem in the Default: it is stored, and any caller reads it", () => {
    setProcessChain(chain(canaryTexts(catalogue)))
    setChainResolver(() => chain(canaryTexts(catalogue)))
    expect(inDialectOf({ projectPath: 'C:/ws/p', agentId: 'a1' }, () => launchRecord({ a: 'r1' }, {}).problems)).toEqual({ a: 'it was not delivered' })
    expect(launchRecord({ a: 'r1' }, {}).problems).toEqual({ a: 'it was not delivered' })
  })
})
