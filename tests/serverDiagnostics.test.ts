// A server connection's diagnostics (HI-2683, design s7 and s11): its model's context as the server reports it, and the
// structured tool-call test. The judgements are evidence only (a failure named from what was seen, else unexpected); the
// checks run against fake servers here, with their identity, cancellation and key handling: a change between the tool
// test's steps sends no second request, the key goes to its own origin only and is never in a result. Dummy keys only;
// no CLI runs, nothing signs in, and no real server is asked.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-serverdiag-')
const home = join(base, 'claude-home')
const userHome = join(base, 'user-profile')
const profile = join(base, 'profile')
process.env.CW_USER_DATA = profile
process.env.CLAUDE_CONFIG_DIR = home
delete process.env.CW_TEST_CLI_HOME_CONNECTION
;(electron.app as unknown as { getPath: (n: string) => string }).getPath = (n: string) => (n === 'home' ? userHome : profile)
vi.mock('../src/main/ptyHost', async (original) => ({ ...(await original<object>()), spawnPty: () => undefined }))

const accounts = await import('../src/main/accounts')
const servers = await import('../src/main/serverConnections')
const diag = await import('../src/main/serverDiagnostics')
const { config } = await import('../src/main/config')
const { advanced } = await import('../src/main/advanced')
const { provider } = await import('../src/main/providers')
const { providerService } = await import('../src/main/providerService')
const { createWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const shared = await import('../src/shared/serverDiagnostics')
const { cleanModels, mergeListed } = await import('../src/shared/serverConnection')

const KEY = 'Zq!7#mP2&vL9^tR4~wX8'
const KEY2 = 'Hn%3*bQ6(kD1)yU5+eW2'
const PROPS = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'servers', 'llamacpp-props-b11608.json'), 'utf8'))
const wsPath = join(base, 'ws')
let w: ReturnType<typeof createWorkspaceService>
const here = <T>(fn: () => T): T => inWorkspace(w, fn)

beforeAll(async () => {
  advanced.load(profile)
  mkdirSync(join(home, 'projects'), { recursive: true })
  mkdirSync(join(userHome, '.claude'), { recursive: true })
  mkdirSync(join(wsPath, 'alpha', '.combwork'), { recursive: true })
  writeFileSync(join(wsPath, 'alpha', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One' }] }))
  config.settings.providers['claude-code'].enabled = true
  providerService.info = ((id: string) => ({ provider: id, found: true, path: 'claude.exe' })) as never
  vi.spyOn(provider('claude-code'), 'accountStatus').mockImplementation(async () => ({ ok: true, loggedIn: false }))
  w = createWorkspaceService()
  await w.open(wsPath)
})
const opened: Server[] = []
afterEach(async () => {
  for (const s of opened.splice(0)) s.close()
  for (const a of [...(config.get().accounts ?? [])]) await accounts.removeAccount(a.id).catch(() => undefined)
  config.update((c) => {
    c.accounts = []
    c.connections = []
  })
})
afterAll(async () => {
  await w.close().catch(() => undefined)
})

/** A fake server: each request recorded (method, path, its Authorization, its body), answered by `handle`. */
async function fake(handle: (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>): Promise<{ url: string; seen: { method: string; path: string; auth?: string; body: string }[] }> {
  const seen: { method: string; path: string; auth?: string; body: string }[] = []
  const s = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body })
      void handle(req, body, res)
    })
  })
  opened.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, seen }
}
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
/** A server connection on `baseUrl` with one model (`m1`), optionally a key. */
const connect = (baseUrl: string, o: { key?: string; preset?: string; models?: { id: string }[] } = {}) =>
  here(() => servers.addServerConnection({ cli: 'claude-code', name: 'Local', baseUrl, models: o.models ?? [{ id: 'm1' }], modelsFrom: 'typed', ...(o.preset ? { preset: o.preset } : {}), ...(o.key ? { key: o.key } : {}) }))

/** A Messages reply. */
const message = (content: unknown[], stop_reason: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm1', content, stop_reason })
const call = (input: unknown, name = shared.TEST_TOOL, id = 'tu_1') => ({ type: 'tool_use', id, name, input })
/** The result's code, as step 2's request carries it (the fake answers with it, as a model that used it would). */
const codeIn = (body: string): string => /station code (\d+)/.exec(body)?.[1] ?? 'none'

describe('what a server reports of a context', () => {
  it("llama.cpp's /props (HI-2552's capture): its allocated context and its template's tool support", () => {
    expect(shared.llamaProps(PROPS)).toEqual({ nCtx: 65536, templateTools: 'supported' })
    const caps = (c: unknown) => shared.llamaProps({ ...PROPS, chat_template_caps: c })?.templateTools
    // Missing, both false, one false and one missing, the two disagreeing: never taken as "--jinja is off".
    expect([caps(undefined), caps({ supports_tools: false, supports_tool_calls: false }), caps({ supports_tools: false }), caps({ supports_tools: true, supports_tool_calls: false })]).toEqual(['notReported', 'unsupported', 'unsupported', 'inconsistent'])
    // Not llama.cpp's shape; an n_ctx that isn't a context: not reported.
    expect(shared.llamaProps({ models: [] })).toBeNull()
    expect(shared.llamaProps({ default_generation_settings: { n_ctx: -1 } })).toEqual({ nCtx: null, templateTools: 'notReported' })
    expect(shared.llamaTrained({ data: [{ id: 'm1', meta: { n_ctx_train: 262144 } }] }, 'm1')).toBe(262144)
  })

  it("Ollama's /api/ps (loaded or not) and /api/show (trained size, a Modelfile's num_ctx)", () => {
    expect(shared.ollamaPs({ models: [{ name: 'devstral:24b', model: 'devstral:24b', context_length: 8192 }] }, 'devstral:24b')).toEqual({ loaded: true, contextLength: 8192 })
    expect(shared.ollamaPs({ models: [] }, 'devstral:24b')).toEqual({ loaded: false, contextLength: null })
    expect(shared.ollamaShow({ model_info: { 'general.architecture': 'mistral3', 'mistral3.context_length': 131072 }, parameters: 'stop "[INST]"\nnum_ctx 65536' })).toEqual({ trained: 131072, numCtx: 65536 })
    expect(shared.ollamaShow({ model_info: {}, parameters: 'stop "x"' })).toEqual({ trained: null, numCtx: null })
  })

  it('the context the user gives a model is theirs: kept through a listing, cleaned, never a reported value', () => {
    expect(cleanModels([{ id: 'm1', context: 65536 }, { id: 'm2', context: -3 } as never, { id: 'm3', context: 1.5 } as never])).toEqual([{ id: 'm1', context: 65536 }, { id: 'm2' }, { id: 'm3' }])
    expect(mergeListed([{ id: 'm1', context: 32768 }], ['m1', 'm2']).models).toEqual([{ id: 'm1', context: 32768 }, { id: 'm2' }])
  })
})

describe('the tool-call test, judged from evidence only', () => {
  const ok = (body: unknown, status = 200) => ({ status, text: JSON.stringify(body) })
  const one = (body: unknown, status = 200) => shared.judgeStep1(ok(body, status))
  const why = (j: ReturnType<typeof shared.judgeStep1>) => (j.ok ? 'ok' : j.why)

  it('step 1 passes only for one call of the offered tool with the city asked about', () => {
    expect(one(message([call({ city: 'Reykjavik' })], 'tool_use'))).toEqual({ ok: true, toolUse: { id: 'tu_1', input: { city: 'Reykjavik' } } })
    expect(why(one(message([{ type: 'text', text: 'Let me check.' }, call({ city: 'reykjavík, Iceland' })], 'tool_use')))).toBe('ok')
    expect(why(one(message([call({ city: 'Reykjavik' }, 'get_time')], 'tool_use')))).toBe('wrongTool')
    expect(why(one(message([call({ city: 'Reykjavik' }), call({ city: 'Oslo' }, shared.TEST_TOOL, 'tu_2')], 'tool_use')))).toBe('extraCalls')
    expect(why(one(message([call({ town: 'Reykjavik' })], 'tool_use')))).toBe('invalidArguments')
    // Valid for the schema, but not what was asked.
    expect(why(one(message([call({ city: 'Oslo' })], 'tool_use')))).toBe('wrongArgument')
  })

  it('no call: tool-shaped text, a plain answer, thinking that used the budget, or an unknown shape', () => {
    expect(why(one(message([{ type: 'text', text: '<tool_call>\n<function=get_weather>' }], 'end_turn')))).toBe('toolText')
    expect(why(one(message([{ type: 'text', text: 'ListFiles.create{"name": "get_weather", "city": "Reykjavik"}' }], 'end_turn')))).toBe('toolText')
    expect(why(one(message([{ type: 'text', text: 'It is cold there.' }], 'end_turn')))).toBe('noToolCall')
    expect(why(one(message([{ type: 'thinking', thinking: 'Hmm…' }], 'max_tokens')))).toBe('thinkingBudget')
    expect(why(one(message([], 'end_turn')))).toBe('unexpected')
    expect(why(shared.judgeStep1({ status: 200, text: '<html>' }))).toBe('protocol')
  })

  it("a server's error is named only when it says so; otherwise unexpected, with what was seen", () => {
    const err = (status: number, errorText = '') => why(shared.judgeStep1({ status, errorText }))
    expect([err(404), err(405), err(401), err(403)]).toEqual(['endpoint', 'endpoint', 'refused', 'forbidden'])
    expect(err(404, '{"error":{"message":"model \'m9\' not found"}}')).toBe('modelRejected')
    expect(err(400, '{"error":"the request exceeds the available context size (8192 tokens)"}')).toBe('promptTooLarge')
    expect(err(400, '{"error":"tools param requires --jinja flag"}')).toBe('toolsUnsupported')
    expect(err(500, '{"error":"boom"}')).toBe('unexpected')
    const j = shared.judgeStep1({ status: 500, errorText: 'boom' })
    expect(j.ok ? null : j.seen).toEqual({ status: 500 })
  })

  it('step 2 passes only for a finished answer that used the result (its code), with no further call', () => {
    const two = (body: unknown) => shared.judgeStep2({ status: 200, text: JSON.stringify(body) }, '48213')
    const w2 = (j: ReturnType<typeof shared.judgeStep2>) => (j.ok ? 'ok' : j.why)
    expect(w2(two(message([{ type: 'text', text: 'It is -7.3 °C with light snow (station code 48213).' }], 'end_turn')))).toBe('ok')
    expect(w2(two(message([{ type: 'text', text: 'It is cold.' }], 'end_turn')))).toBe('resultIgnored')
    expect(w2(two(message([call({ city: 'Reykjavik' })], 'tool_use')))).toBe('resultIgnored')
    // Partial text holding the code is no completed round trip; nor is another stop.
    expect(w2(two(message([{ type: 'text', text: 'Station code 48213 and' }], 'max_tokens')))).toBe('incomplete')
    expect(w2(two(message([{ type: 'text', text: 'Code 48213.' }], 'stop_sequence')))).toBe('unexpected')
    expect(w2(two(message([{ type: 'thinking', thinking: '…' }], 'max_tokens')))).toBe('thinkingBudget')
  })

  it("the result's code is nowhere in the prompt", () => {
    const r = shared.testResult(() => 0.5)
    expect(JSON.stringify(shared.step1Body('m1'))).not.toContain(r.code)
    expect(r.text).toContain(r.code)
  })
})

describe('the checks, against fake servers', () => {
  it("llama.cpp: kind, allocated and trained context, template tools; the key to its own origin only, and in no result", async () => {
    const s = await fake((req, _b, res) => (req.url === '/props' ? json(res, 200, PROPS) : req.url === '/v1/models' ? json(res, 200, { data: [{ id: 'm1', meta: { n_ctx_train: 262144 } }] }) : json(res, 404, {})))
    const a = await connect(s.url, { key: KEY })
    const r = await here(() => diag.readServerContext(a.id, 'm1', 'r1'))
    expect(r).toMatchObject({ ok: true, context: { kind: 'llamacpp', templateTools: 'supported', allocated: { tokens: 65536, source: 'llamacpp.props' }, trained: { tokens: 262144, source: 'llamacpp.models' } } })
    expect(s.seen.every((x) => x.auth === `Bearer ${KEY}`)).toBe(true)
    expect(JSON.stringify(r)).not.toContain(KEY)
    expect(JSON.stringify(diag.lastServerCheck(a.id, 'm1'))).not.toContain(KEY)
  })

  it('Ollama (its preset asks it first): loaded with its allocation, trained size and num_ctx', async () => {
    const s = await fake((req, body, res) => {
      if (req.url === '/api/ps') return json(res, 200, { models: [{ name: 'm1', model: 'm1', context_length: 8192 }] })
      if (req.url === '/api/show' && JSON.parse(body).model === 'm1') return json(res, 200, { model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }, parameters: 'num_ctx 8192' })
      json(res, 404, {})
    })
    const a = await connect(s.url, { preset: 'ollama' })
    const r = await here(() => diag.readServerContext(a.id, 'm1', 'r1'))
    expect(r).toMatchObject({ ok: true, context: { kind: 'ollama', loaded: true, allocated: { tokens: 8192 }, trained: { tokens: 40960 }, configured: { tokens: 8192, source: 'ollama.numCtx' } } })
    expect(s.seen[0].path).toBe('/api/ps')
  })

  it("a base URL with a path (a gateway) asks no root path of the server: its context isn't reported", async () => {
    const s = await fake((_r, _b, res) => json(res, 200, PROPS))
    const a = await connect(`${s.url}/gw/anthropic`)
    expect(await here(() => diag.readServerContext(a.id, 'm1', 'r1'))).toMatchObject({ ok: true, context: { kind: 'generic', prefixed: true } })
    expect(s.seen).toEqual([])
  })

  it("passes a full round trip, at <base URL>/v1/messages as Claude Code builds it (a gateway's path kept)", async () => {
    const s = await fake((req, body, res) => {
      if (req.url !== '/gw/anthropic/v1/messages') return json(res, 404, {})
      const b = JSON.parse(body)
      if (b.messages.length === 1) return json(res, 200, message([call({ city: 'Reykjavik' })], 'tool_use'))
      json(res, 200, message([{ type: 'text', text: `It is -7.3 °C (station code ${codeIn(body)}).` }], 'end_turn'))
    })
    const a = await connect(`${s.url}/gw/anthropic`, { key: KEY })
    const r = await here(() => diag.testServerTools(a.id, 'm1', 't1'))
    expect(r).toMatchObject({ ok: true })
    expect(s.seen.map((x) => x.path)).toEqual(['/gw/anthropic/v1/messages', '/gw/anthropic/v1/messages'])
    expect(s.seen.every((x) => x.auth === `Bearer ${KEY}`)).toBe(true)
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('names step 1\'s failure and never sends step 2; the server\'s text is in no result', async () => {
    const s = await fake((_r, _b, res) => json(res, 400, { error: 'the request exceeds the available context size, SECRET-SERVER-TEXT' }))
    const a = await connect(s.url)
    const r = await here(() => diag.testServerTools(a.id, 'm1', 't1'))
    expect(r).toMatchObject({ ok: false, why: 'promptTooLarge', step: 1, seen: { status: 400 } })
    expect(s.seen.length).toBe(1)
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })

  it('a change while step 1 is answered (the key replaced, the model edited, the connection removed): stale, and step 2 is never sent', async () => {
    for (const change of ['key', 'model', 'remove'] as const) {
      let release: () => void = () => undefined
      const gate = new Promise<void>((r) => (release = r))
      const s = await fake(async (_r, _b, res) => {
        await gate
        json(res, 200, message([call({ city: 'Reykjavik' })], 'tool_use'))
      })
      const a = await connect(s.url, { key: KEY })
      const test = here(() => diag.testServerTools(a.id, 'm1', `t-${change}`))
      await vi.waitFor(() => expect(s.seen.length).toBe(1), { timeout: 10_000 })
      if (change === 'key') await here(() => servers.setServerKey(a.id, KEY2))
      if (change === 'model') await here(() => servers.editServerConnection(a.id, { models: [{ id: 'm2' }] }))
      if (change === 'remove') await here(() => accounts.removeAccount(a.id))
      release()
      expect(await test, change).toMatchObject({ ok: false, why: 'stale' })
      expect(s.seen.length, change).toBe(1)
    }
  })

  it('a newer check replaces an older one; cancelling the older one by its id leaves the newer running', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const s = await fake(async (req, body, res) => {
      await gate
      if (JSON.parse(body).messages.length === 1) return json(res, 200, message([call({ city: 'Reykjavik' })], 'tool_use'))
      json(res, 200, message([{ type: 'text', text: `Code ${codeIn(body)}.` }], 'end_turn'))
    })
    const a = await connect(s.url)
    const older = here(() => diag.testServerTools(a.id, 'm1', 'old'))
    await vi.waitFor(() => expect(s.seen.length).toBe(1), { timeout: 10_000 })
    const newer = here(() => diag.testServerTools(a.id, 'm1', 'new'))
    expect(await older).toMatchObject({ ok: false, why: 'stale' })
    diag.cancelServerChecks(a.id, 'm1', 'old')
    release()
    expect(await newer).toMatchObject({ ok: true })
  })

  it('cancelled (its dialog closed): stale, nothing more sent', async () => {
    const s = await fake(() => undefined)
    const a = await connect(s.url)
    const test = here(() => diag.testServerTools(a.id, 'm1', 'c1'))
    await vi.waitFor(() => expect(s.seen.length).toBe(1), { timeout: 10_000 })
    diag.cancelServerChecks(a.id, 'm1', 'c1')
    expect(await test).toMatchObject({ ok: false, why: 'stale' })
  })

  it('a redirect is never followed, an oversized reply never read, and too many checks at once are refused', async () => {
    const s = await fake((req, _b, res) => {
      if (req.url === '/v1/messages') {
        res.writeHead(307, { Location: 'http://example.invalid/' })
        res.end()
        return
      }
      json(res, 200, { pad: 'x'.repeat(2 * 1024 * 1024) })
    })
    const a = await connect(s.url, { models: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }, { id: 'm5' }] })
    expect(await here(() => diag.testServerTools(a.id, 'm1', 'x'))).toMatchObject({ ok: false, why: 'unexpected', seen: { status: 307 } })
    expect(s.seen.length).toBe(1)
    // Over the cap: not this API's reply (its text never read).
    const big = await fake((_r, _b, res) => json(res, 200, { pad: 'x'.repeat(2 * 1024 * 1024) }))
    const b = await connect(big.url)
    expect(await here(() => diag.testServerTools(b.id, 'm1', 'y'))).toMatchObject({ ok: false, why: 'protocol' })
    // CHECKS_MAX hung checks, then one more: busy.
    const hung = await fake(() => undefined)
    const c = await connect(hung.url, { models: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }, { id: 'm5' }] })
    const running = ['m1', 'm2', 'm3', 'm4'].map((m) => here(() => diag.testServerTools(c.id, m, `h-${m}`)))
    await vi.waitFor(() => expect(hung.seen.length).toBe(diag.CHECKS_MAX), { timeout: 10_000 })
    expect(await here(() => diag.testServerTools(c.id, 'm5', 'h-m5'))).toMatchObject({ ok: false, why: 'busy' })
    diag.cancelServerChecks(c.id)
    await Promise.all(running)
  })
})
