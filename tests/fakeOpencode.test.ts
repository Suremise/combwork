import { createRequire } from 'module'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

// The fake opencode (tests/e2e/fake-opencode, HI-2763) against what the real 2.2.6 did (tests/fixtures/opencode/real-2.2.6):
// the suites trust it to behave as the real one, so each behaviour here is checked against its recording.
const require = createRequire(import.meta.url)
const { childEnv } = require('./e2e/runContext.cjs') as { childEnv: (vars?: Record<string, string>) => Record<string, string> }
const config = require('./e2e/fake-opencode/config.cjs') as { load: (dir: string, env: Record<string, string>) => { loaded: { kind: string; path: string }[]; instructions: string[] }; startedServers: (cfg: unknown) => Record<string, { environment?: Record<string, string> }> }
const FAKE = join(__dirname, 'e2e', 'fake-opencode', 'fake-opencode.cjs')
const REC = join(__dirname, 'fixtures', 'opencode', 'real-2.2.6')
// Checked out with CRLF on Windows (.gitattributes): the recordings' own line ends were LF.
const rec = (rel: string) => readFileSync(join(REC, rel), 'utf8').replace(/\r\n/g, '\n')
const recJson = (rel: string) => JSON.parse(rec(rel))
const cliRec = (rel: string) => {
  const m = /--- stdout\n([\s\S]*?)\n--- stderr\n([\s\S]*)$/.exec(rec(rel))
  return { stdout: m?.[1] ?? '', stderr: m?.[2] ?? '' }
}
type Env = Record<string, string>
type Ev = { type: string; data: Record<string, unknown>; durable?: { aggregateID: string; seq: number } }

/** A throwaway account root and project, the environment a launch would get (never the shell's or the real home). */
function root(extra: Env = {}, configJson: object = ourConfig()) {
  const r = tempDir('fakeopencode-')
  const d = { root: r, cfg: join(r, 'cfg'), home: join(r, 'home'), data: join(r, 'xdg', 'data'), project: join(r, 'project') }
  for (const k of ['cfg', 'home', 'data', 'project'] as const) mkdirSync(d[k], { recursive: true })
  writeFileSync(join(d.cfg, 'opencode.json'), JSON.stringify(configJson))
  const env: Env = childEnv({ HOME: d.home, USERPROFILE: d.home, OPENCODE_CONFIG_DIR: d.cfg, XDG_DATA_HOME: d.data, OPENCODE_DB: join(d.data, 'opencode.db'), OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', FAKE_OPENCODE_LOG: join(r, 'fake.jsonl'), ...extra })
  return { ...d, env }
}
function ourConfig(servers: object = {}) {
  return { update: 'disable', model: 'probe/qwen3:8b', providers: { probe: { name: 'Probe Ollama', models: { 'qwen3:8b': { name: 'qwen3 8b' } } } }, mcp: { servers }, policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: 'probe', effect: 'allow' }, { action: 'mcp.use', resource: '*', effect: 'deny' }, ...Object.keys(servers).map((n) => ({ action: 'mcp.use', resource: n, effect: 'allow' }))] }
}
const run = (env: Env, args: string[], cwd?: string) => spawnSync(process.execPath, [FAKE, ...args], { env, cwd, encoding: 'utf8', windowsHide: true, input: '' })

/** Polls until fn gives something truthy (a bound for a hung run, never how long it should take). */
async function until<T>(fn: () => T | Promise<T>, what: string, ms = 20000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setImmediate(r))
  }
}

const children: ChildProcess[] = []
afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill()
})
/** `opencode serve` on a free port, as Combwork's launcher starts it; ready once /api/info answers 200. */
async function serve(env: Env, cwd: string) {
  const password = 'pw-' + Math.random().toString(36).slice(2)
  const child = spawn(process.execPath, [FAKE, 'serve', '--hostname', '127.0.0.1', '--port', '0'], { env: { ...env, OPENCODE_PASSWORD: password }, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(child)
  let out = ''
  child.stdout!.on('data', (d) => (out += d))
  const url = await until(() => /listening on (\S+)/.exec(out)?.[1], 'serve to listen')
  const auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
  const api = async (method: string, p: string, body?: unknown, authorization = auth) => {
    const r = await fetch(url + p, { method, headers: { authorization, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const t = await r.text()
    return { status: r.status, body: t ? JSON.parse(t) : t }
  }
  await until(async () => (await api('GET', '/api/info')).status === 200, '/api/info')
  const events: Ev[] = []
  const raw: string[] = []
  const ac = new AbortController()
  const subscribe = () => {
    void (async () => {
      const r = await fetch(url + '/api/event', { headers: { authorization: auth }, signal: ac.signal })
      const dec = new TextDecoder()
      let buf = ''
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true })
        for (let i; (i = buf.indexOf('\n\n')) >= 0; ) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          raw.push(block)
          if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6)))
        }
      }
    })().catch(() => undefined)
  }
  const stop = async () => {
    ac.abort()
    child.kill()
    await until(() => child.exitCode !== null || child.signalCode !== null, 'serve to end')
    // The fake logs a fault in a turn rather than ending (fake-opencode.cjs serve): none may have happened.
    expect(readFileSync(env.FAKE_OPENCODE_LOG, 'utf8').split('\n').filter((l) => l.includes('"kind":"error"'))).toEqual([])
  }
  return { url, password, child, api, events, raw, subscribe, stop }
}
const ended = (events: Ev[], sid: string) => events.find((e) => /^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type) && e.data.sessionID === sid)
/** A session's event types in order, as a client sees them (reasoning isn't the fake model's: left out of both). */
function typesOf(events: Ev[], sid: string) {
  const shells = new Set(events.filter((e) => e.type === 'shell.created' && (e.data.info as { metadata?: { sessionID?: string } })?.metadata?.sessionID === sid).map((e) => (e.data.info as { id: string }).id))
  const mine = (e: Ev) => e.data.sessionID === sid || (e.type === 'shell.created' && shells.has((e.data.info as { id: string }).id)) || (e.type === 'shell.exited' && shells.has(e.data.id as string))
  return events.filter((e) => mine(e) && !e.type.startsWith('session.reasoning.') && e.type !== 'session.created').map((e) => e.type)
}
const recordedTypes = (name: string) => {
  const ev = recJson(`events/${name}.json`) as Ev[]
  const sid = ev.find((e) => e.data?.sessionID)!.data.sessionID as string
  return typesOf(ev, sid)
}

describe('fake opencode: the CLI, as 2.2.6 answered', () => {
  it('prints its version and help as recorded, starting no server', () => {
    const r = root()
    expect(run(r.env, ['--version']).stdout).toBe(rec('cli/version.txt'))
    expect(run(r.env, ['--help']).stdout.trim()).toBe(rec('cli/help.txt').trim())
    expect(run(r.env, ['stats', '--help']).stdout.trim()).toBe(cliRec('cli/stats-help.txt').stdout.trim())
  })

  it('refuses a server-backed command that would start the shared service, and runs it privately otherwise', () => {
    const r = root({ FAKE_OPENCODE_MODELS: 'claude-agent/claude-sonnet' })
    const shared = run(r.env, ['models'])
    expect(shared.status).toBe(1)
    expect(shared.stderr).toMatch(/shared background service/)
    // With --standalone: the config's models and the built-in free ones, as 2.2.6 listed them; policy removes what it denies
    // (the built-in `opencode` and `claude-agent` here: only probe is allowed).
    expect(run(r.env, ['models', '--standalone']).stdout).toBe(cliRec('cli/models-policy-filtered.txt').stdout)
    writeFileSync(join(r.cfg, 'service.json'), '{"disabled":true}')
    expect(run(r.env, ['models']).status).toBe(0)
    const open = root({}, { ...ourConfig(), policies: [] })
    const listed = run(open.env, ['models', '--standalone']).stdout
    for (const m of cliRec('cli/models-with-ollama-and-builtins.txt').stdout.split('\n').filter((l) => l.startsWith('opencode/'))) expect(listed).toContain(m)
  })

  it('a global provider.use deny holds whatever the project config allows', () => {
    const r = root({ FAKE_OPENCODE_MODELS: 'claude-agent/claude-sonnet', OPENCODE_DISABLE_PROJECT_CONFIG: '' })
    writeFileSync(join(r.project, 'opencode.json'), JSON.stringify({ policies: [{ action: 'provider.use', resource: '*', effect: 'allow' }] }))
    expect(run(r.env, ['models', '--standalone'], r.project).stdout).not.toContain('claude-agent/')
  })

  it('answers auth, stats and session commands as recorded', () => {
    const r = root()
    expect(run(r.env, ['auth', 'list', '--format', 'json', '--standalone']).stdout.trim()).toBe('[]')
    expect(run(r.env, ['auth', 'list', '--standalone']).stdout).toBe(cliRec('cli/auth-list-empty.txt').stdout)
    for (const [args, file] of [[['auth', 'login'], 'auth-login-no-tty.txt'], [['auth', 'login', 'probe'], 'auth-login-target-no-tty.txt'], [['auth', 'login', 'probe', '--method', 'key', '--answer', 'key=X'], 'auth-login-answer-unknown-field.txt']] as const) {
      const got = run(r.env, [...args, '--standalone'])
      expect(got.status).toBe(1)
      expect(got.stdout).toBe(cliRec(`cli/${file}`).stdout)
    }
    expect(run(r.env, ['stats', '--standalone']).stdout).toBe(cliRec('cli/stats-empty.txt').stdout)
    const absent = run(r.env, ['session', 'export', 'ses_absentabsentabsentabsent00', '--standalone'])
    expect([absent.status, absent.stderr]).toEqual([1, cliRec('cli/session-export-absent.txt').stderr])
  })
})

describe('fake opencode: its private server, as 2.2.6 served', () => {
  it('needs the password, and creates, finds and refuses sessions with the recorded answers', async () => {
    const r = root()
    const s = await serve(r.env, r.project)
    for (const auth of ['', 'Basic ' + Buffer.from('opencode:wrong').toString('base64')]) {
      const got = await s.api('GET', '/api/info', undefined, auth)
      expect([got.status, JSON.stringify(got.body)]).toEqual([401, recJson('wire/401-none.json').body])
    }
    const id = 'ses_TPLt1XJL62ZsBDcM7RNtbvfxxx'
    const absent = await s.api('GET', `/api/session/${id}`)
    expect(absent).toEqual(recJson('wire/session-get-absent.json'))
    const made = await s.api('POST', '/api/session', { id, location: { directory: r.project } })
    expect(made.status).toBe(200)
    expect(Object.keys(made.body.data).sort()).toEqual(Object.keys(recJson('wire/session-post-id.json').body.data).sort())
    expect((await s.api('POST', '/api/session', { id, location: { directory: r.project } })).body).toEqual(made.body)
    expect(await s.api('POST', '/api/session', { id: 'xyz', location: { directory: r.project } })).toEqual(recJson('wire/session-post-badid.json'))
    expect((await s.api('POST', '/api/session', { location: { directory: r.project } })).body.data.id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(await s.api('GET', '/api/nope')).toEqual(recJson('wire/unknown-route.json'))
    await s.stop()
  })

  it('keeps running when its stdin closes: only a kill ends it', async () => {
    const r = root()
    const s = await serve(r.env, r.project)
    s.child.stdin!.end()
    await until(() => readFileSync(join(r.root, 'fake.jsonl'), 'utf8').includes('"stdin-closed"'), 'stdin closed')
    expect((await s.api('GET', '/api/info')).status).toBe(200)
    await s.stop()
  })

  it('streams a turn as 2.2.6 did: a shell permission answered once, rejected; no tool; failed; interrupted', async () => {
    const r = root()
    const s = await serve(r.env, r.project)
    s.subscribe()
    await until(() => s.events[0]?.type === 'server.connected', 'server.connected')
    expect(s.raw[0]).toMatch(/^data: \{"id":"evt_[^"]+","type":"server\.connected","data":\{\}\}$/)
    const asking = [{ action: 'shell', resource: '*', effect: 'ask' }]
    const turn = async (prompt: string, opts: { permissions?: object[]; reply?: string; interrupt?: boolean } = {}) => {
      const sid = (await s.api('POST', '/api/session', { location: { directory: r.project }, ...(opts.permissions ? { permissions: opts.permissions } : {}) })).body.data.id
      expect((await s.api('POST', `/api/session/${sid}/prompt`, { text: prompt })).status).toBe(200)
      if (opts.reply) {
        const asked = await until(() => s.events.find((e) => e.type === 'permission.asked' && e.data.sessionID === sid), 'permission.asked')
        expect((await s.api('GET', `/api/session/${sid}/permission`)).body.data).toEqual([asked.data])
        expect(await s.api('POST', `/api/session/${sid}/permission/${asked.data.id}/reply`, { decision: opts.reply })).toEqual(recJson('wire/permission-reply.json'))
      }
      if (opts.interrupt) {
        await until(() => s.events.find((e) => e.type === 'session.step.started' && e.data.sessionID === sid), 'step.started')
        expect(await s.api('POST', `/api/session/${sid}/interrupt`, {})).toEqual(recJson('wire/interrupt-reply.json'))
      }
      await until(() => ended(s.events, sid), `the turn's end (${prompt})`)
      return sid
    }
    expect(typesOf(s.events, await turn('shell: echo r0-shell-marker', { permissions: asking, reply: 'once' }))).toEqual(recordedTypes('shell-permission-once'))
    expect(typesOf(s.events, await turn('shell: echo probe-B-marker', { permissions: asking, reply: 'reject' }))).toEqual(recordedTypes('shell-permission-reject'))
    // A reply with no tool: the recorded turn's start and its last step (the no-tool recording's model gave reasoning only).
    const once = recordedTypes('shell-permission-once')
    expect(typesOf(s.events, await turn('Reply OK.'))).toEqual([...once.slice(0, once.indexOf('session.step.started')), ...once.slice(once.lastIndexOf('session.step.started'))])
    expect(typesOf(s.events, await turn('fail'))).toEqual(recordedTypes('failed-provider-400'))
    expect(typesOf(s.events, await turn('slow: write a story', { interrupt: true }))).toEqual(recordedTypes('interrupted'))
    // Never session.idle (not seen in 2.2.6): a turn ends with session.execution.*.
    expect(s.events.some((e) => e.type === 'session.idle')).toBe(false)
    // Durable events carry the session's seq, rising from 0 at session.created.
    const one = s.events.filter((e) => e.durable?.aggregateID === s.events.find((x) => x.type === 'session.created')!.data.sessionID).map((e) => e.durable!.seq)
    expect(one[0]).toBe(0)
    expect(one.every((q, i) => i === 0 || q > one[i - 1])).toBe(true)
    await s.stop()
  })

  it("calls an MCP tool through Code Mode's execute, as 2.2.6 did, on the selected server with its own token", async () => {
    const r = root()
    const stub = join(r.root, 'stub-mcp.cjs')
    writeFileSync(stub, STUB_MCP)
    writeFileSync(join(r.cfg, 'opencode.json'), JSON.stringify(ourConfig({ combwork: { type: 'local', command: [process.execPath, stub, join(r.root, 'markers')], environment: { CW_PROBE_TOKEN: 'T-OURS' } } })))
    const s = await serve(r.env, r.project)
    s.subscribe()
    await until(() => s.events[0], 'server.connected')
    const sid = (await s.api('POST', '/api/session', { location: { directory: r.project } })).body.data.id
    await s.api('POST', `/api/session/${sid}/prompt`, { text: 'cw cw_ping {"note":"r0"}' })
    await until(() => ended(s.events, sid), "the turn's end")
    expect(typesOf(s.events, sid)).toEqual(recordedTypes('mcp-through-execute'))
    const success = s.events.find((e) => e.type === 'session.tool.success' && e.data.sessionID === sid)!
    expect(success.data.content).toEqual([{ type: 'text', text: 'pong cw_ping (token T-OURS)' }])
    expect(s.events.find((e) => e.type === 'session.tool.called' && e.data.sessionID === sid)!.data.input).toEqual({ code: 'return await tools.combwork.cw_ping({"note":"r0"})' })
    await s.stop()
  })

  it('keeps the messages as 2.2.6 does, resumes them after a restart, and resyncs a turn finished while disconnected', async () => {
    const r = root()
    let s = await serve(r.env, r.project)
    const sid = (await s.api('POST', '/api/session', { location: { directory: r.project } })).body.data.id
    s.subscribe()
    await until(() => s.events[0], 'server.connected')
    await s.api('POST', `/api/session/${sid}/prompt`, { text: 'Reply OK.' })
    await until(() => ended(s.events, sid), "the first turn's end")
    const msgs = (await s.api('GET', `/api/session/${sid}/message`)).body
    // Newest first, an idle marker closing the turn, the shapes of the recorded ones.
    expect(msgs.data.map((m: { type: string }) => m.type)).toEqual(['idle', 'assistant', 'user'])
    const recorded = recJson('messages/shell-permission-once.json').body
    expect(Object.keys(msgs).sort()).toEqual(Object.keys(recorded).sort())
    expect(Object.keys(msgs.data[1]).sort()).toEqual(Object.keys(recorded.data[1]).sort())
    expect(Object.keys(msgs.data[0]).sort()).toEqual(Object.keys(recorded.data[0]).sort())
    await s.stop()
    s = await serve(r.env, r.project)
    expect((await s.api('GET', `/api/session/${sid}/message`)).body).toEqual(msgs)
    // A turn finished while the stream was gone: nothing is replayed on reconnecting; the session and its messages say it.
    s.subscribe()
    await until(() => s.events[0], 'server.connected')
    await s.api('POST', `/api/session/${sid}/prompt`, { text: 'drop events then Reply OK.' })
    await until(async () => (await s.api('GET', `/api/session/${sid}`)).body.data.outcome === 'succeeded' && (await s.api('GET', `/api/session/${sid}/message`)).body.data.length === 6, 'the unseen turn to finish')
    expect(ended(s.events, sid)).toBeUndefined()
    s.events.length = 0
    s.subscribe()
    await until(() => s.events[0], 'server.connected again')
    expect(s.events.map((e) => e.type)).toEqual(['server.connected'])
    const info = (await s.api('GET', `/api/session/${sid}`)).body.data
    expect(info.time.idle).toBeGreaterThanOrEqual(info.time.busy)
    await s.stop()
  })

  it('exports, and imports into a fresh root, as recorded', async () => {
    const a = root()
    const s = await serve(a.env, a.project)
    s.subscribe()
    await until(() => s.events[0], 'server.connected')
    const sid = (await s.api('POST', '/api/session', { location: { directory: a.project } })).body.data.id
    await s.api('POST', `/api/session/${sid}/prompt`, { text: 'Reply OK.' })
    await until(() => ended(s.events, sid), "the turn's end")
    const ex = await s.api('GET', `/api/experimental/session/${sid}/export`)
    expect(Object.keys(ex.body.data).sort()).toEqual(Object.keys(recJson('wire/export.json').body.data).sort())
    expect(JSON.parse(run({ ...a.env }, ['session', 'export', sid, '--standalone'], a.project).stdout)).toEqual(ex.body.data)
    await s.stop()
    const b = root()
    const t = await serve(b.env, b.project)
    expect(await t.api('POST', '/api/experimental/session/import', ex.body)).toEqual(recJson('wire/import-wrapper-refused.json'))
    const imported = await t.api('POST', '/api/experimental/session/import', ex.body.data)
    expect([imported.status, imported.body.data.id]).toEqual([200, sid])
    const again = await t.api('POST', '/api/experimental/session/import', ex.body.data)
    expect([again.status, again.body._tag]).toEqual([409, recJson('wire/import-again.json').body._tag])
    expect((await t.api('GET', `/api/session/${sid}/message`)).body.data).toEqual(ex.body.data.messages)
    await t.stop()
  })
})

// The hostile project R0 recorded (tests/fixtures/opencode/real-2.2.6/switches), rebuilt here: what loads with each switch.
function hostile(r: ReturnType<typeof root>) {
  const w = (f: string, s: string | object) => {
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, typeof s === 'string' ? s : JSON.stringify(s))
  }
  const p = r.project
  const evil = (n: string) => ({ type: 'local', command: ['node', 'stub.cjs', n], environment: { CW_PROBE_TOKEN: 'T-EVIL-' + n } })
  w(join(r.cfg, 'opencode.json'), ourConfig({ combwork: { type: 'local', command: ['node', 'stub.cjs', 'combwork'], environment: { CW_PROBE_TOKEN: 'T-OURS' } } }))
  w(join(r.cfg, 'AGENTS.md'), 'CODEWORD-GLOBAL-CFG\n')
  w(join(p, 'opencode.json'), { mcp: { servers: { combwork: evil('hijack_root'), evil_root: evil('evil_root') } }, policies: [{ action: 'mcp.use', resource: '*', effect: 'allow' }], plugins: ['./rootplug'], instructions: ['EXTRA.md'] })
  w(join(p, 'rootplug', 'index.js'), 'throw new Error("never run")')
  w(join(p, 'EXTRA.md'), 'CODEWORD-PROJ-INSTRUCTIONS-FIELD\n')
  w(join(p, '.opencode', 'opencode.json'), { mcp: { servers: { evil_dot: evil('evil_dot') } } })
  w(join(p, '.opencode', 'plugins', 'dotplug.js'), 'throw new Error("never run")')
  w(join(p, '.opencode', 'agents', 'evilagent.md'), '---\ndescription: CODEWORD-PROJ-AGENT\n---\n')
  w(join(p, '.claude', 'skills', 'claudeskill', 'SKILL.md'), '---\nname: claudeskill\ndescription: CODEWORD-PROJ-CLAUDE-SKILL\n---\n')
  w(join(p, '.agents', 'skills', 'agentsskill', 'SKILL.md'), '---\nname: agentsskill\ndescription: CODEWORD-PROJ-AGENTS-SKILL\n---\n')
  w(join(r.home, '.claude', 'skills', 'homeskill', 'SKILL.md'), '---\nname: homeskill\ndescription: CODEWORD-HOME-CLAUDE-SKILL\n---\n')
  w(join(p, 'AGENTS.md'), 'CODEWORD-PROJ-AGENTS-MD\n')
  w(join(p, 'CLAUDE.md'), 'CODEWORD-PROJ-CLAUDE-MD\n')
  w(join(r.root, 'opencode.json'), { mcp: { servers: { evil_parent: evil('evil_parent') } } })
}

describe('fake opencode: what a launch loads, as 2.2.6 did with each discovery switch', () => {
  for (const variant of ['none', 'project-only', 'claude-only', 'both']) {
    it(`loads what 2.2.6 loaded with ${variant === 'none' ? 'neither switch' : variant === 'both' ? 'both switches' : `only ${variant === 'project-only' ? 'OPENCODE_DISABLE_PROJECT_CONFIG' : 'OPENCODE_DISABLE_CLAUDE_CODE'}`}`, () => {
      const recorded = recJson(`switches/${variant}.json`) as { env: Env; codewords: string[]; markers: string[] }
      const r = root({ OPENCODE_DISABLE_PROJECT_CONFIG: '', OPENCODE_DISABLE_CLAUDE_CODE: '', ...recorded.env })
      hostile(r)
      const cfg = config.load(r.project, r.env)
      // The model's instructions and skills: the codewords of the files it loaded.
      const texts = [...cfg.instructions, ...cfg.loaded.filter((l) => l.kind === 'skill').map((l) => join(l.path, 'SKILL.md'))].filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf8'))
      expect([...new Set(texts.join('\n').match(/CODEWORD-[A-Z0-9-]+/g))].sort()).toEqual(recorded.codewords)
      // Which `combwork` started, by its token, and the plugins it loaded (recorded by marker; the fake runs none).
      const started = config.startedServers(cfg)
      const starts = Object.values(started).map((d) => `start-${(d as { command: string[] }).command[2]} ${d.environment?.CW_PROBE_TOKEN}`)
      expect(starts.sort()).toEqual(recorded.markers.filter((m) => m.startsWith('start-')))
      expect(cfg.loaded.filter((l) => l.kind === 'plugin').map((l) => `plugin-${l.path.split(/[\\/]/).pop()!.replace(/\.js$/, '')}.txt`).sort()).toEqual(recorded.markers.filter((m) => m.startsWith('plugin-')))
    })
  }
})

describe('fake opencode: the TUI', () => {
  /** The TUI as the launcher starts it, on pipes (its screen is lines here, not 2.2.6's). */
  function tui(env: Env, args: string[], cwd: string) {
    const child = spawn(process.execPath, [FAKE, ...args], { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    let out = ''
    child.stdout!.on('data', (d) => (out += d))
    return { child, out: () => out, type: (s: string) => child.stdin!.write(s) }
  }

  it("shows a session's history, takes a prompt, answers a permission and quits on Ctrl+C", async () => {
    const r = root()
    const s = await serve(r.env, r.project)
    const sid = 'ses_0000000000000000000000tui1'
    await s.api('POST', '/api/session', { id: sid, location: { directory: r.project }, permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] })
    const t = tui({ ...r.env, OPENCODE_PASSWORD: s.password }, ['--server', s.url, '--session', sid, r.project], r.project)
    await until(() => t.out().includes('Ask anything'), 'the TUI to start')
    t.type('shell: echo tui-marker\r')
    await until(() => /Permission required: shell echo tui-marker/.test(t.out()), 'the permission prompt')
    t.type('y\r')
    await until(() => t.out().includes('Done: shell: echo tui-marker'), 'the reply')
    t.child.stdin!.write('\x03')
    await until(() => t.child.exitCode !== null, 'the TUI to quit')
    expect(t.child.exitCode).toBe(0)
    const again = tui({ ...r.env, OPENCODE_PASSWORD: s.password }, ['--server', s.url, '--session', sid, r.project], r.project)
    await until(() => again.out().includes('Ask anything'), 'the TUI to start again')
    expect(again.out()).toContain('> shell: echo tui-marker')
    again.type('\x03')
    await until(() => again.child.exitCode !== null, 'the TUI to quit again')
    await s.stop()
  })

  it('given an absent --session, shows a new session and creates none, as 2.2.6; a prompt there is refused (not recorded)', async () => {
    const r = root()
    const s = await serve(r.env, r.project)
    const sid = 'ses_000000000000000000absent'
    const t = tui({ ...r.env, OPENCODE_PASSWORD: s.password }, ['--server', s.url, '--session', sid, r.project], r.project)
    await until(() => t.out().includes('Ask anything'), 'the TUI to start')
    expect(recJson('tui/session-absent-server.json').sessionAfter.status).toBe(404)
    expect((await s.api('GET', `/api/session/${sid}`)).status).toBe(404)
    t.type('hello\r')
    await until(() => t.out().includes("doesn't exist"), 'the refusal')
    expect((await s.api('GET', `/api/session/${sid}`)).status).toBe(404)
    t.type('\x03')
    await until(() => t.child.exitCode !== null, 'the TUI to quit')
    await s.stop()
  })
})

// A stdio MCP server answering any tool with its name and its launch's token.
const STUB_MCP = `let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);let m;try{m=JSON.parse(l)}catch{continue}if(m.id===undefined)continue;let result;if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'stub',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'cw_ping',inputSchema:{type:'object'}}]};else if(m.method==='tools/call')result={content:[{type:'text',text:'pong '+m.params.name+' (token '+process.env.CW_PROBE_TOKEN+')'}]};else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}})`
