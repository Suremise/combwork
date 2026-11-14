// The Agent API's and sessions' agent text (dialects, HI-2065; card 3b, HI-2436): every message of apiText.ts and
// sessionText.ts said through the canary dialect comes out wholly inside its markers (nothing glued on in code), the
// request scope servers.ts opens takes its chain, and the errors servers.ts makes are said through the catalogue there,
// and byte for byte the English they were before with no dialect.
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { say, setChainResolver, type AgentMsg, type DialectChain } from '../src/shared/agentText'
import { inRequestScope } from '../src/shared/agentText/asyncScope'
import { canaryProblems, canaryTexts } from '../src/shared/agentText/canary'
import { parseIcu, placeholdersOf, type Part } from '../src/shared/agentText/icu'
// @ts-expect-error: a plain .mjs module without types
import { readCatalogue } from '../scripts/agentTextExtract.mjs'
import { API } from '../src/main/apiText'
import { SESSION } from '../src/main/sessionText'

const base = tempDir('cw-agenttext-api-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { INTENT_ROUTES, apiErrorReply, apiTextTestHooks, connectionValuesArg, refuseOldFields } = await import('../src/main/servers')

const ROOT = join(__dirname, '..')
const traverse = ((traverseModule as unknown as { default?: unknown }).default ?? traverseModule) as (ast: unknown, visitors: Record<string, (p: never) => void>) => void
const catalogue = readCatalogue(ROOT) as Record<string, { text: string }>
const ids = new Set(Object.keys(catalogue))
const canary: DialectChain = { texts: canaryTexts(catalogue), files: ['canary.json'], hash: 'canary' }
/** The canary in every scope but the Default, as the dialects service will resolve one (6b). */
const withCanary = (): void => setChainResolver(() => canary)

afterEach(() => setChainResolver(null))

/** Every message in a table of them (nested by group). */
function messagesOf(table: object): AgentMsg[] {
  return Object.values(table).flatMap((v: unknown) => (v && typeof v === 'object' && 'id' in v && 'text' in v ? [v as AgentMsg] : messagesOf(v as object)))
}

/** Values for a message: a plain value the test knows, each select's options and one it hasn't, plurals at 0, 1 and 2. */
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
    const vals: (string | number)[] = kind === 'select' ? selects[name] : kind === 'plain' ? ['VALUE'] : [0, 1, 2]
    out = out.flatMap((v) => vals.map((x) => ({ ...v, [name]: x })))
  }
  return out
}

const API_MESSAGES = messagesOf(API)
const SESSION_MESSAGES = messagesOf(SESSION)

describe("the Agent API's and sessions' agent text (card 3b)", () => {
  it('declares its messages under api.* and session.*, each in the catalogue with its text', () => {
    expect(API_MESSAGES.length).toBeGreaterThan(350)
    for (const m of API_MESSAGES) expect(m.id, m.id).toMatch(/^api\./)
    for (const m of SESSION_MESSAGES) expect(m.id, m.id).toMatch(/^session\./)
    for (const m of [...API_MESSAGES, ...SESSION_MESSAGES]) expect(catalogue[m.id]?.text, m.id).toBe(m.text)
    expect(new Set(API_MESSAGES.map((m) => m.id)).size).toBe(API_MESSAGES.length)
  })

  it('says every one of them through the canary in a request scope, nothing outside its markers', () => {
    withCanary()
    for (const m of [...API_MESSAGES, ...SESSION_MESSAGES])
      for (const values of samples(m.text)) {
        const text = inRequestScope(null, () => say(m, values))
        expect(text.startsWith(`⟦${m.id}⟧`), `${m.id} ${JSON.stringify(values)}`).toBe(true)
        expect(canaryProblems(text, ids, ['VALUE']), `${m.id} ${JSON.stringify(values)}`).toEqual([])
      }
  })

  it('prints every count as written, never through a plural\'s #, which groups four digits (HR2\'s round 1)', () => {
    // A plural chooses the words; the number is a plain value beside it, as the base's template printed it (1000, not 1,000).
    for (const m of [...API_MESSAGES, ...SESSION_MESSAGES]) {
      const pound = (parts: Part[]): boolean => (parts as { type: number; options?: Record<string, { value: Part[] }> }[]).some((p) => p.type === 7 || Object.values(p.options ?? {}).some((o) => pound(o.value)))
      expect(pound(parseIcu(m.text)), m.id).toBe(false)
    }
    // The base's templates at four and five digits.
    for (const n of [1, 2, 1000, 12345]) {
      const s = n === 1 ? '' : 's'
      expect(say(API.change.reorderTasks, { count: n, total: String(n), column: 'Todo' })).toBe(`put ${n} card${s} in order in Todo`)
      expect(say(API.done.undid, { undone: String(n), count: n, total: String(n), skipped: n, skippedTotal: String(n) })).toBe(`Undid ${n} of ${n} change${s} of its own (${n} field${s} left: changed since or gone)`)
      expect(say(API.done.cancelledMessages, { agent: 'a', project: 'p', n, total: String(n) })).toBe(`Cancelled ${n === 1 ? 'the message' : `${n} messages`} waiting for a in p`)
      expect(say(API.done.freshRetried, { lane: 'L1', retried: n, total: String(n) })).toBe(`Lane L1: ${n} new conversation${n > 1 ? 's' : ''} tried again`)
      expect(say(API.done.connectionsChosen, { project: 'p', changed: '2', skipped: n, skippedTotal: String(n) })).toBe(`Chose connections in p: 2 agents changed, ${n} skipped`)
      // HI-3151: HI-3126's commits of the local branch its remote lacks.
      expect(say(API.done.forwardUpToDate, { from: 'dev', to: 'main', ahead: n, aheadTotal: String(n) })).toBe(`main has everything of dev already: nothing queued. ${n} commit${s} of the local dev ${n === 1 ? "isn't" : "aren't"} on its remote, so ${n === 1 ? 'it' : 'they'} ${n === 1 ? "wasn't" : "weren't"} brought in: publish ${n === 1 ? 'it' : 'them'} first if ${n === 1 ? 'it' : 'they'} should be`)
      expect(say(API.agent.promptBackground, { agent: 'a', tasks: n, total: String(n) })).toMatch(new RegExp(`^a is waiting on ${n} background task${s} it started`))
    }
  })

  it("the refusals of a request's parts are said through the canary, and are the English they were with none", async () => {
    const { isolatedFor, lanePlacement, notifyTarget, readUsageWatch } = apiTextTestHooks
    const ws = {} as Parameters<typeof isolatedFor>[0]
    const script = { source: 'api' } as Parameters<typeof isolatedFor>[1]
    const agent = { source: 'agent', projectPath: join(base, 'p') } as Parameters<typeof isolatedFor>[1]
    const link = (l: object): Parameters<typeof isolatedFor>[2] => l as Parameters<typeof isolatedFor>[2]
    const cases: [() => Promise<unknown> | unknown, string, string][] = [
      [() => notifyTarget([]), 'api.notify.targetArg', 'target is { agent, project? } or { card }'],
      [() => notifyTarget({ agent: 'a', card: 3 }), 'api.notify.targetBoth', 'target is an agent or a card, not both'],
      [() => isolatedFor(ws, script, link({ check: 'lint', card: 1, revision: 'abc' })), 'api.check.isolatedAgentsOnly', "--isolated runs an agent's check in a copy of its own: run it in an agent's session"],
      [() => isolatedFor(ws, agent, link({ check: null, card: 1, revision: 'abc' })), 'api.check.isolatedNeedsCheck', '--isolated runs a check in a copy of its own: use it with --check <name>'],
      [() => isolatedFor(ws, agent, link({ check: 'lint', card: null, revision: null })), 'api.check.isolatedNeedsCard', "--isolated runs a check at its card's revision: name the card (--card), or work on one in Doing"],
      [() => lanePlacement({ builder: 'HB1', colour: 'red' }, {}), 'api.card.laneArgField', 'lane takes builder, reviewer, brief, name and position, not colour'],
      [() => readUsageWatch([], {} as Parameters<typeof readUsageWatch>[1]), 'api.watch.usageShape', 'usage must be a list of { account, percent, limit? }, limit weekly, fiveHour or any']
    ]
    const errorOf = async (fn: () => Promise<unknown> | unknown, session: Parameters<typeof inRequestScope>[0]): Promise<string> => {
      try {
        await inRequestScope(session, async () => await fn())
      } catch (e) {
        return String((apiErrorReply(e).body as { error: string }).error)
      }
      return '(no refusal)'
    }
    for (const [fn, , english] of cases) expect(await errorOf(fn, null)).toBe(english)
    withCanary()
    for (const session of [null, { projectPath: join(base, 'p'), agentId: 'a1' }])
      for (const [fn, id] of cases) {
        const error = await errorOf(fn, session)
        expect(error.startsWith(`⟦${id}⟧`), `${id}: ${error}`).toBe(true)
        expect(canaryProblems(error, ids, ['colour']), id).toEqual([])
      }
  })

  it("servers.ts gives no error a literal message, whatever the guard's prose heuristic reads as prose (HR2's round 1)", () => {
    const code = readFileSync(join(ROOT, 'src', 'main', 'servers.ts'), 'utf8')
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] })
    const literal = (n: { type: string } | undefined | null): boolean => !!n && (n.type === 'StringLiteral' || n.type === 'TemplateLiteral')
    const found: string[] = []
    traverse(ast, {
      NewExpression(p: { node: { callee: { type: string; name?: string }; arguments: { type: string; loc?: { start: { line: number } } }[] } }) {
        const { callee, arguments: args } = p.node
        // HttpError(status, message, extra) and SettingRefused(status, message): the message is the second argument.
        if (callee.type === 'Identifier' && (callee.name === 'HttpError' || callee.name === 'SettingRefused') && literal(args[1])) found.push(`${callee.name} at line ${args[1].loc?.start.line}`)
      },
      ObjectProperty(p: { node: { key: { type: string; name?: string }; value: { type: string; loc?: { start: { line: number } } } }; parentPath: { parentPath: { node: { type: string; callee?: { type: string; name?: string } } } } }) {
        // send(res, status, { error: '…' }): an error reply's body.
        const call = p.parentPath.parentPath.node
        if (p.node.key.type === 'Identifier' && p.node.key.name === 'error' && call.type === 'CallExpression' && call.callee?.type === 'Identifier' && call.callee.name === 'send' && literal(p.node.value)) found.push(`send's error at line ${p.node.value.loc?.start.line}`)
      }
    })
    // The hook server's replies to a CLI's hooks (not an agent's): marked agent-protocol beside them.
    const protocolLines = new Set(code.split(/\r?\n/).flatMap((l, i) => (/agent-protocol: the hook server/.test(l) ? [`line ${i + 2}`] : [])))
    expect(found.filter((f) => !protocolLines.has(f.replace(/^.* at /, '')))).toEqual([])
  })

  it("the errors servers.ts makes are said in the request's chain, and are the English they were with none", () => {
    const old = (): void => refuseOldFields({ model: 'opus' }, undefined)
    const context = (): unknown => connectionValuesArg({ context200k: 'maybe' })
    const pass = (): unknown => INTENT_ROUTES.verdict({ pass: 'maybe' })
    // No dialect: the code's English, as before the extraction.
    expect(old).toThrow(/^An agent no longer takes model: it runs on a connection, which holds its model, effort, context and mode, and its CLI follows from it\./)
    expect(context).toThrow('context200k is "on", or "off" (or "") for the model\'s 1M.')
    expect(pass).toThrow('pass is true or false.')
    // The canary, in a script's scope and an agent's: every word through the catalogue.
    withCanary()
    for (const session of [null, { projectPath: join(base, 'p'), agentId: 'a1' }])
      for (const [fn, id] of [
        [old, 'api.connection.oldFields'],
        [context, 'api.connection.context200k'],
        [pass, 'api.intent.passArg']
      ] as const) {
        let error = ''
        try {
          inRequestScope(session, fn)
        } catch (e) {
          error = String((apiErrorReply(e).body as { error: string }).error)
        }
        expect(error.startsWith(`⟦${id}⟧`), `${id}: ${error}`).toBe(true)
        expect(canaryProblems(error, ids, ['model']), id).toEqual([])
      }
  })
})
