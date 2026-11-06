// Dialects (HI-2065), card 3c (HI-2447): the slot and copy pools', the template routes' and the token files' agent text.
// In the Default it reads exactly as the code's English did (each branch, and four-digit counts printed as digits, never
// grouped); under the canary every word of it comes through the catalogue; and none of these files has a literal error
// or refusal left, whatever the guard's prose heuristic says (HI-2436's lesson).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { say, setProcessChain, type DialectChain } from '../src/shared/agentText'
import { canaryProblems, canaryTexts } from '../src/shared/agentText/canary'
// @ts-expect-error: a plain .mjs module without types
import { readCatalogue } from '../scripts/agentTextExtract.mjs'
// @ts-expect-error: a plain .mjs module without types
import { isSql } from '../scripts/agentTextGuard.mjs'

vi.mock('../src/main/sessions', () => ({ sessions: { runNow: () => null, stop: () => undefined, runLive: () => true, liveStates: () => [], turnOpen: () => false, lineWaiting: () => false, liveFor: () => null, grantedDirs: () => [] } }))

const { refusalText } = await import('../src/main/slots')
const { copyRefusalText } = await import('../src/main/copies')
const { copiesInUseText, copyWaitStall, reviewCopyText } = await import('../src/main/reviewCopies')
const { laneEndNote } = await import('../src/main/slotsApp')
const { namesFromKeys } = await import('../src/main/templateApi')
const { templateLimitText } = await import('../src/shared/templates')

const traverse = (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule
const ROOT = join(__dirname, '..')
type Catalogue = Record<string, { text: string; note?: string }>
const catalogue = readCatalogue(ROOT) as Catalogue
const ids = new Set(Object.keys(catalogue))
const AREAS = ['slot.', 'copy.', 'template.', 'token.']
const mine = [...ids].filter((id) => AREAS.some((a) => id.startsWith(a)))
const chain = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })
const canary = (): void => setProcessChain(chain(canaryTexts(catalogue)))
/** A message of the catalogue said as the code says it (its descriptors aren't all exported). */
const said = (id: string, values?: Record<string, string | number>): string => say({ id, text: catalogue[id].text }, values)
const refusalOf = (f: () => unknown): string => {
  try {
    f()
  } catch (e) {
    return (e as Error).message
  }
  return '(not refused)'
}

afterEach(() => setProcessChain(null))

const card = (n: number): string => `HI-${n}`
const name = (a: string): string => `<${a}>`
type Refusal = Parameters<typeof refusalText>[0]
const REFUSALS: { r: Refusal; was: string; values: string[] }[] = [
  { r: { why: 'noSlot', size: 1 }, was: "no slot free: the pool's 1 slot is in use", values: ['1'] },
  { r: { why: 'noSlot', size: 0 }, was: "no slot free: the pool's 0 slots are in use", values: ['0'] },
  { r: { why: 'noSlot', size: 1000 }, was: "no slot free: the pool's 1000 slots are in use", values: ['1000'] },
  { r: { why: 'inUse', slot: 'slot-a', agent: 'b1', card: 7, lane: null }, was: 'slot-a is in use by <b1> for HI-7', values: ['slot-a', '<b1>', 'HI-7'] },
  { r: { why: 'inUse', slot: 'slot-a', agent: 'b1', card: null, lane: 'lane-9' }, was: 'slot-a is in use by <b1> for lane lane-9', values: ['slot-a', '<b1>', 'lane-9'] },
  { r: { why: 'agentLeased', slot: 'slot-b', card: 1000, lane: null }, was: 'this agent already builds in slot-b for HI-1000', values: ['slot-b', 'HI-1000'] },
  { r: { why: 'agentLeased', slot: 'slot-b', card: null, lane: 'L' }, was: 'this agent already builds in slot-b for lane L', values: ['slot-b'] },
  { r: { why: 'warming', slot: 'slot-c' }, was: 'slot-c is being set up', values: ['slot-c'] },
  { r: { why: 'busy', slot: 'slot-c' }, was: 'slot-c has a session or a process in it', values: ['slot-c'] },
  { r: { why: 'notReady', slot: 'slot-d', state: 'dirty' }, was: "slot-d isn't ready (dirty)", values: ['slot-d', 'dirty'] },
  { r: { why: 'notReady', slot: 'slot-d', state: 'removing', error: 'boom' }, was: "slot-d isn't ready (boom)", values: ['slot-d', 'boom'] },
  { r: { why: 'setupFailed', slot: 'slot-e', error: 'npm ci exited', log: null }, was: "slot-e's setup failed: npm ci exited", values: ['slot-e', 'npm ci exited'] }
] as never
type CopyRefusal = Parameters<typeof copyRefusalText>[0]
const COPY_REFUSALS: { r: CopyRefusal; was: string; values: string[] }[] = [
  { r: { why: 'noCopy', size: 1 }, was: "no check copy free: the pool's 1 copy is in use", values: ['1'] },
  { r: { why: 'noCopy', size: 1000 }, was: "no check copy free: the pool's 1000 copies are in use", values: ['1000'] },
  { r: { why: 'returned', copy: 'copy-1' }, was: 'its lease of copy-1 was returned while the copy was being set up', values: ['copy-1'] },
  { r: { why: 'stillInUse', copy: 'copy-2', by: 'R1' }, was: 'copy-2 is still in use by R1', values: ['copy-2', 'R1'] },
  { r: { why: 'off' }, was: 'review copies are off (Settings → Advanced, Reviewers review in review copies)', values: [] },
  { r: { why: 'setupFailed', copy: 'copy-3', error: 'x', log: null }, was: "copy-3's setup failed: x", values: ['copy-3', 'x'] }
] as never
const NOW = Date.parse('2026-11-03T12:00:00Z')
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString()
type Held = Parameters<typeof copiesInUseText>[0]
const lent = (n: number, extra: Partial<Held[number]> = {}): Held[number] => ({ copy: `copy-${n}`, kind: 'review', card: n, from: ago(60 - n), returned: null, by: null, ...extra })
const IN_USE: { held: Held; was: string; values: string[] }[] = [
  { held: [lent(1), lent(2, { returned: ago(3), by: 'its run' })], was: "the pool's 2 copies are in use; copy-2, returned 3 min ago, is held back by its run", values: ['2', 'copy-2', '3', 'its run'] },
  { held: [lent(1, { returned: ago(1000) })], was: "the pool's 1 copy is in use; copy-1, returned 1000 min ago, is being freed", values: ['1', 'copy-1', '1000'] },
  { held: Array.from({ length: 1000 }, (_, i) => lent(i + 1, { from: ago(2000 - i) })), was: "the pool's 1000 copies are in use; the longest lent, copy-1, for 2000 min (a review of HI-1)", values: ['1000', 'copy-1', '2000', 'review', 'HI-1'] },
  { held: [], was: "the pool's 0 copies are in use", values: ['0'] }
]
type Answer = Parameters<typeof reviewCopyText>[0]
const ANSWERS: { a: Answer; card?: string; was: string; values: string[] }[] = [
  { a: { is: 'ready', copy: 'copy-1', folder: 'C:/w/copies/copy-1', revision: '0123456789abcdef' }, was: 'Review in C:/w/copies/copy-1 at 0123456789ab: read and run commands there, with it as their working directory; your session stays where it is.', values: ['C:/w/copies/copy-1', '0123456789ab'] },
  { a: { is: 'ready', copy: 'copy-1', folder: 'C:/w/copies/copy-1', revision: '0123456789abcdef' }, card: 'HI-12', was: "HI-12's review copy is ready. Review in C:/w/copies/copy-1 at 0123456789ab: read and run commands there, with it as their working directory; your session stays where it is.", values: ['HI-12', 'C:/w/copies/copy-1', '0123456789ab'] },
  { a: { is: 'waiting', why: 'w' }, was: 'Waiting for a review copy (w): Combwork tells you when one is ready, with its folder. Meanwhile git can show the submission from where you are.', values: ['w'] },
  { a: { is: 'none', why: 'n' }, was: "No review copy (n): review the builder's work read-only from where you are.", values: ['n'] }
] as never
const merged = 'aaa9a0c3c180fc41a6298d7a19f17a1f9239b3f5'
const NOTES: { args: Parameters<typeof laneEndNote>; was: string; values: string[] }[] = [
  { args: ['Off main', false, [{ key: 'HI-1', merged }, { key: 'HI-2', merged: null }]], was: "Lane Off main is finished: HI-1 merged at aaa9a0c3c180; HI-2 not merged. Your session ends once this turn does; Combwork resumes it for your next lane. Close the lane's work in your reply, then end your turn.", values: ['Off main', 'HI-1', 'aaa9a0c3c180', 'HI-2'] },
  { args: ['x', true, [{ key: 'HI-3', merged: null }]], was: "Lane x was abandoned: HI-3 not merged. Your session ends once this turn does; Combwork resumes it for your next lane. Close the lane's work in your reply, then end your turn.", values: ['x', 'HI-3'] },
  { args: ['y', false, []], was: "Lane y is finished. Your session ends once this turn does; Combwork resumes it for your next lane. Close the lane's work in your reply, then end your turn.", values: ['y'] },
  { args: ['z', true, Array.from({ length: 21 }, (_, i) => ({ key: `K${i}`, merged: null }))], was: `Lane z was abandoned: ${Array.from({ length: 20 }, (_, i) => `K${i} not merged`).join('; ')}; and 1 more. Your session ends once this turn does; Combwork resumes it for your next lane. Close the lane's work in your reply, then end your turn.`, values: ['z', ...Array.from({ length: 20 }, (_, i) => `K${i}`).reverse(), '1'] }
]
const RAW = ['Builder', 'Reviewer', 'Reviewer']
const EXPANDED = ['AL-B1', 'AL-R1', 'AL-R2']
const NAMES: { given: unknown; was: string; values: string[] }[] = [
  { given: [], was: "names is an object: an agent's place or name → its new name. Its agents: 1 (AL-B1), 2 (AL-R1), 3 (AL-R2).", values: ['1 (AL-B1), 2 (AL-R1), 3 (AL-R2)'] },
  { given: { 1: 7 }, was: "names.1 is not text: give each agent's new name as a string.", values: ['1'] },
  { given: { 1000: 'x' }, was: 'names: 1000 is out of range: the template has 3 agents (1 (AL-B1), 2 (AL-R1), 3 (AL-R2)).', values: ['1000', '3', '1 (AL-B1), 2 (AL-R1), 3 (AL-R2)'] },
  { given: { nobody: 'x' }, was: 'names: no agent "nobody" in the template. Its agents: 1 (AL-B1), 2 (AL-R1), 3 (AL-R2).', values: ['nobody', '1 (AL-B1), 2 (AL-R1), 3 (AL-R2)'] },
  { given: { reviewer: 'x' }, was: 'names: "reviewer" is 2 of its agents: name each by its place or name (2 (AL-R1), 3 (AL-R2)).', values: ['reviewer', '2', '2 (AL-R1), 3 (AL-R2)'] },
  { given: { 1: 'x', builder: 'y' }, was: 'names: "1" and "builder" both name agent 1 (AL-B1): give it one name.', values: ['1', 'builder', 'AL-B1'] }
]

describe('in the Default, the text reads as the code wrote it', () => {
  it('a slot or copy refused, and why reviewers wait', () => {
    expect(REFUSALS.map((x) => refusalText(x.r, name, card))).toEqual(REFUSALS.map((x) => x.was))
    expect(COPY_REFUSALS.map((x) => copyRefusalText(x.r))).toEqual(COPY_REFUSALS.map((x) => x.was))
    expect(IN_USE.map((x) => copiesInUseText(x.held, card, NOW))).toEqual(IN_USE.map((x) => x.was))
    expect(ANSWERS.map((x) => reviewCopyText(x.a, x.card))).toEqual(ANSWERS.map((x) => x.was))
    const waits = [{ card: 12, name: 'R2', since: NOW - 1000 * 60_000, why: 'w' }] as Parameters<typeof copyWaitStall>[1]
    expect(copyWaitStall({ number: 12, key: 'HI-12', column: 'review' }, waits, NOW)).toBe("HI-12's review by R2 has waited 1000 min for a review copy: w.")
    expect(copyWaitStall({ number: 12, column: 'review' }, waits, NOW)).toBe("#12's review by R2 has waited 1000 min for a review copy: w.")
  })

  it("a lane's end, a template's names and its limit", () => {
    expect(NOTES.map((n) => laneEndNote(...n.args))).toEqual(NOTES.map((n) => n.was))
    expect(NAMES.map((n) => refusalOf(() => namesFromKeys(RAW, EXPANDED, n.given)))).toEqual(NAMES.map((n) => n.was))
    expect(templateLimitText(1000, 20)).toBe("It has 1000 agents, and this project's workflow allows 20 (Maximum agents, the user's team size, in Version Control → Workflow). The user can load it themselves, or raise Maximum agents first.")
  })

  it("each branch of the messages that aren't exported, against the template they replace", () => {
    // slotRelease.ts, templateApi.ts: the old templates, restated, over each branch.
    for (const slots of [[], ['slot-a'], ['slot-a', 'slot-b']]) expect(said('slot.release.noSlot', { slot: 'x', listed: slots.length ? 'yes' : 'no', slots: slots.join(', ') })).toBe(`No slot x in this project${slots.length ? ` (its slots: ${slots.join(', ')})` : ''}.`)
    expect(said('slot.release.confirm', { slot: 'slot-a' })).toBe('Releasing slot-a\'s writer needs confirm: { slot: "slot-a", run: "<its run>" }, the slot and run the user agreed to release (list shows them).')
    for (const scope of ['', 'combwork']) for (const from of ['', 'Web']) expect(said('template.find.none', { template: 't', scoped: scope ? 'yes' : 'no', scope, fromProject: from ? 'yes' : 'no', from })).toBe(`No template "t"${scope ? ` in the ${scope} scope` : ''}${from ? ` kept in ${from}` : ''}: list gives them.`)
    for (const bad of [['x'], ['x', 'y'], Array.from({ length: 1000 }, (_, i) => `k${i}`)]) expect(said('template.connections.bad', { keys: bad.join(', '), count: bad.length, roles: 'builder, reviewer', agents: '1 (A)' })).toBe(`connections: ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not "*", a role (builder, reviewer) or one of its agents: 1 (A).`)
    expect(said('template.taken.refused', { taken: [said('template.taken.one', { name: 'B1', project: 'web', suggestion: 'AL-B1' }), said('template.taken.one', { name: 'R1', project: 'api', suggestion: 'AL-R1' })].join('; ') })).toBe('"B1" is web\'s agent: try "AL-B1"; "R1" is api\'s agent: try "AL-R1". Agent names are unique across the workspace: give each a free name in names. Nothing was changed.')
  })
})

describe('the canary dialect over them', () => {
  it('finds every word in the catalogue', () => {
    canary()
    const seen = new Set<string>()
    const check = (what: string, text: string, values: string[]): void => {
      expect(canaryProblems(text, ids, values), what).toEqual([])
      for (const m of text.matchAll(/⟦([^/⟧][^⟧]*)⟧/g)) seen.add(m[1])
    }
    for (const x of REFUSALS) check(x.was, refusalText(x.r, name, card), x.values)
    for (const x of COPY_REFUSALS) check(x.was, copyRefusalText(x.r), x.values)
    for (const x of IN_USE) check(x.was, copiesInUseText(x.held, card, NOW), x.values)
    for (const x of ANSWERS) check(x.was, reviewCopyText(x.a, x.card), x.values)
    for (const n of NOTES) check(n.was, laneEndNote(...n.args), n.values)
    for (const n of NAMES) check(n.was, refusalOf(() => namesFromKeys(RAW, EXPANDED, n.given)), n.values)
    check('limit', templateLimitText(1000, 20), ['1000', '20'])
    expect(seen.size).toBeGreaterThan(30)
  })

  it('says every message of these areas, in each branch, with nothing outside its markers', () => {
    canary()
    expect(mine.length).toBeGreaterThan(140)
    const SELECTS: Record<string, string[]> = { listed: ['yes', 'no'], scoped: ['yes', 'no'], fromProject: ['yes', 'no'], held: ['yes', 'no'], named: ['yes', 'no'], abandoned: ['yes', 'no'] }
    const schema = Object.assign({}, ...AREAS.map((a) => JSON.parse(readFileSync(join(ROOT, `agent-text/schema/${a.slice(0, -1)}.json`), 'utf8')))) as Record<string, { placeholders: Record<string, string> }>
    for (const id of mine) {
      const kinds = schema[id].placeholders
      const variants: Record<string, string | number>[] = [{}]
      for (const p of Object.keys(kinds)) {
        const options: (string | number)[] = kinds[p] === 'select' ? (SELECTS[p] ?? ['yes', 'no']) : kinds[p] === 'plural' || kinds[p] === 'number' ? [0, 1, 2, 1000] : [`«${p}»`]
        variants.splice(0, variants.length, ...variants.flatMap((v) => options.map((o) => ({ ...v, [p]: o }))))
      }
      for (const v of variants) {
        const values = Object.values(v).map(String)
        expect(canaryProblems(said(id, v), ids, values), `${id} ${JSON.stringify(v)}`).toEqual([])
      }
    }
  })
})

/** The files this card emptied, and where a literal there would be agent text whatever its words look like. */
const FILES = ['src/main/slots.ts', 'src/main/slotCards.ts', 'src/main/slotRelease.ts', 'src/main/slotsApp.ts', 'src/main/copies.ts', 'src/main/copiesApp.ts', 'src/main/reviewCopies.ts', 'src/main/templateApi.ts', 'src/main/agentTokens.ts', 'src/main/hookTokens.ts', 'src/shared/templates.ts', 'src/shared/templateConnections.ts']
const TEXT_KEYS = /^(error|why|wait|waiting|refused|retry|failed|detail|notSaved|note|body|by|text|reason)$/
const CALLS = /^(refused|Error|SlotReleaseRefused|CombworkError|OpLost|fail|keep|giveUp|pass)$/

describe('no literal agent text left in these files', () => {
  it('has no words in an error, a refusal or a field agents read, but what agent-protocol marks', () => {
    const found: string[] = []
    for (const f of FILES) {
      const code = readFileSync(join(ROOT, f), 'utf8')
      const lines = code.split(/\r?\n/)
      const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] })
      // agent-protocol, or (in a file the i18n guard reads) an i18n-ignore whose reason is the log's or a test's.
      const marked = (line: number): boolean => /agent-protocol:|i18n-ignore:.*\b(log|test)\b/.test(lines[line - 1] ?? '') || /^\s*\/\/ agent-protocol:/.test(lines[line - 2] ?? '')
      // The descriptors: their text is the catalogue's.
      const descriptors: [number, number][] = []
      traverse(ast, {
        CallExpression: (p) => {
          if (p.node.callee.type === 'Identifier' && p.node.callee.name === 'agentMsg') descriptors.push([p.node.start ?? 0, p.node.end ?? 0])
        }
      })
      const look = (p: { node: { start?: number | null; loc?: { start: { line: number } } | null }; parentPath: unknown }, text: string): void => {
        if (!/[A-Za-z]{2,} [A-Za-z(]/.test(text) || isSql(text)) return
        if (descriptors.some(([a, b]) => (p.node.start ?? -1) >= a && (p.node.start ?? -1) < b)) return
        const line = p.node.loc?.start.line ?? 0
        if (marked(line)) return
        // Up to the first call, property or throw: is it one agents read?
        for (let q = p.parentPath as { node: { type: string; key?: { name?: string }; callee?: { name?: string; property?: { name?: string } } }; parentPath: unknown } | null; q; q = q.parentPath as never) {
          const n = q.node
          if (n.type === 'ThrowStatement') return void found.push(`${f}:${line} throw ${text}`)
          if (n.type === 'ObjectProperty') return void (TEXT_KEYS.test(n.key?.name ?? '') && found.push(`${f}:${line} ${n.key?.name}: ${text}`))
          if (n.type === 'CallExpression' || n.type === 'NewExpression') {
            const callee = n.callee?.name ?? n.callee?.property?.name ?? ''
            return void (CALLS.test(callee) && found.push(`${f}:${line} ${callee}(${text})`))
          }
          if (/Function|Statement$|Declaration$/.test(n.type) && n.type !== 'ReturnStatement') return
        }
      }
      traverse(ast, {
        StringLiteral: (p) => look(p as never, p.node.value),
        TemplateLiteral: (p) => look(p as never, p.node.quasis.map((q) => q.value.cooked).join('{}'))
      })
    }
    expect(found).toEqual([])
  })
})
