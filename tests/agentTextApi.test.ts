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

const base = tempDir('hive-agenttext-api-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { INTENT_ROUTES, apiErrorReply, connectionValuesArg, refuseOldFields } = await import('../src/main/servers')

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
