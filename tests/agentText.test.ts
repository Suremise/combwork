// Agent text (dialects, HI-2065; plans/2026-11-03-dialects-design.md, sections 2 and 6): the ICU formatter hive-mcp.js
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
import { boardSkillsLine, controlRules, hiveInstructions, journalRule, withLatestHandover } from '../src/shared/hiveGuidance'
import { deliveredNotes } from '../src/shared/workspaceNotes'
import { instructionsStarter } from '../src/shared/projectTabs'
import { shareInstructions } from '../src/shared/instructions'
import { launchRecord, skillRevisions } from '../src/main/guidance'
import * as skills from '../src/main/skills'
import * as revisions from '../src/main/revisions'
import { createWorkspaceService, disposeWorkspaceService, inWorkspace } from '../src/main/workspace'
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
    expect(formatIcu("Hive's {n, plural, one {# card} other {# cards}} '{'x'}' <command>", { n: 1200 })).toBe("Hive's 1,200 cards {x} <command>")
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
    expect(inRequestScope({ projectPath: 'C:\\ws\\.hive\\assistant', agentId: 'assistant' }, () => say(M, { name: 'x', n: 1 }))).toBe('for assistant')
    expect(asked).toEqual([{ kind: 'session', session: alpha }, { kind: 'api' }, { kind: 'session', session: { projectPath: 'C:\\ws\\.hive\\assistant', agentId: 'assistant' } }])
    // Outside a scope: the process's chain (hive-mcp.js), else the Default.
    expect(say(M, { name: 'x', n: 1 })).toBe('process')
    expect(currentChain()?.texts['test.thing.case']).toBe('process')
  })

  it('joins a list as agent text does: no serial comma', () => {
    expect([[], ['a'], ['a', 'b'], ['a', 'b', 'c']].map((l) => agentList(l))).toEqual(['', 'a', 'a and b', 'a, b and c'])
  })
})

describe("hive-mcp.js and hive-progress.js's dialect file", () => {
  it('reads the overrides from HIVE_DIALECT_FILE, and speaks the Default without one or with one it cannot read', () => {
    const dir = tempDir('agent-text-dialect-')
    const file = join(dir, 'dialect.json')
    writeFileSync(file, JSON.stringify({ texts: { 'contract.docs.outline': 'Read big docs by section.', bad: 3 }, files: ['claude-code/cli.json'] }))
    const loaded = loadProcessDialect({ HIVE_DIALECT_FILE: file, HIVE_DIALECT: 'abc123' })
    expect(loaded).toEqual({ texts: { 'contract.docs.outline': 'Read big docs by section.' }, files: ['claude-code/cli.json'], hash: 'abc123' })
    expect(hiveInstructions('web').split('\n')[2]).toBe('Read big docs by section.')
    expect(loadProcessDialect({ HIVE_DIALECT_FILE: join(dir, 'missing.json') })).toBeNull()
    expect(hiveInstructions('web').split('\n')[2]).toMatch(/^Markdown over about 20 KB/)
    expect(loadProcessDialect({})).toBeNull()
    for (const raw of ['not json', '[]', '{"texts": []}', '{"files": []}']) expect(chainFromFile(raw), raw).toBeNull()
  })

  it('is loaded by each script first, before any text is said', () => {
    for (const entry of ['src/main/mcp/hive-mcp.ts', 'src/main/progressReporters/hive-progress.ts']) {
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
  const SKILLS = ['work-on-card', 'review-agent-work', 'card-loop', 'generalist', 'handover', 'pick-up', 'workspace-note', 'merge-ready', 'split-work', 'use-hive-api']
  /** Every variant of the contract's text, each with the values a test passed in it (names, paths). */
  function contractTexts(): { name: string; text: string; values: string[] }[] {
    const out: { name: string; text: string; values: string[] }[] = []
    for (let mask = 0; mask < 1 << SKILLS.length; mask += 37) out.push({ name: `board ${mask}`, text: boardSkillsLine(new Set(SKILLS.filter((_, i) => mask & (1 << i)))), values: [] })
    for (const role of ['agent', 'assistant'] as const)
      for (const progress of [true, false])
        for (const journal of [null, [], ['decision', 'plan']]) out.push({ name: `${role} ${progress} ${JSON.stringify(journal)}`, text: hiveInstructions('webapp', role, progress, undefined, journal), values: ['webapp', 'decision', 'plan'] })
    out.push({ name: 'no project', text: hiveInstructions(''), values: [] })
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
    expect(canaryProblems(`${hiveInstructions('webapp')}\nAlso, be nice.`, ids, ['webapp'])).toEqual([expect.stringMatching(/^text outside the catalogue: Also, be, nice/)])
    expect(canaryProblems('⟦no.such.id⟧x⟦/⟧', ids)).toEqual(["markers naming ids the schema hasn't: no.such.id"])
    expect(canaryProblems('⟦contract.docs.outline⟧x', ids)).toEqual(['unbalanced markers'])
  })
})

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
    vi.spyOn(skills, 'hiveSkills').mockImplementation(async () => {
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
