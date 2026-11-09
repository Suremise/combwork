// The launcher's side of OpenCode's turns (HI-2760, design s7 to s22), run for real on Windows with the fake opencode
// (HI-2763, its 2.2.6 recordings) and a hook server of the test's own: the baseline is subscribed and posted before the TUI
// starts (and its failure fails the launch, the TUI never started); events go in order, projected; a dropped stream, a
// mutation between the last message page and the second watermark, an over-long frame and a hook server refusing a post
// each end in a settled snapshot, so the tracker (events.ts) ends with the session's true state, each prompt counted once.
import { spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { childEnv } = require('./e2e/runContext.cjs') as { childEnv: (vars?: Record<string, string>) => Record<string, string> }
const { LAUNCHER_ARGS, LAUNCHER_EXIT, LAUNCHER_SOURCE, launcherEnv, launcherSourcePath, serverInfoPath } = await import('../src/main/providers/opencode/launcher')
const { newSessionId } = await import('../src/main/providers/opencode/adapter')
const { applyEvent, applySnapshot, newTracker } = await import('../src/main/providers/opencode/events')
const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const FAKE = join(__dirname, 'e2e', 'fake-opencode', 'opencode.cmd')
const windows = process.platform === 'win32'

const children: ChildProcess[] = []
const servers: http.Server[] = []
afterAll(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill()
  for (const s of servers) s.close()
})

/** Polls until fn gives something truthy (a bound for a hung run, never how long it should take). */
async function until<T>(fn: () => T | Promise<T>, what: string, ms = 30000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A hook server standing in for Combwork's: it records each body, and answers as `status()` says. */
async function hookServer(status: () => number = () => 200) {
  const bodies: Record<string, any>[] = []
  const auth: string[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      auth.push(String(req.headers.authorization))
      const code = status()
      if (code === 200) bodies.push(JSON.parse(raw))
      res.writeHead(code)
      res.end('{}')
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook?run=r1`, bodies, auth }
}

interface Run {
  dir: string
  priv: string
  project: string
  env: Record<string, string>
  password: string
}

function setUp(o: { hookUrl: string; sessionId?: string; intent?: 'new' | 'resume'; home?: string; project?: string; serverUrl?: string }): Run {
  const dir = tempDir('cw-ocstream-')
  const home = o.home ?? join(dir, 'acct')
  const project = o.project ?? join(dir, 'project')
  const priv = join(dir, 'private')
  for (const d of [home, project, priv, join(dir, 'cfg')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(dir, 'cfg', 'service.json'), '{"disabled":true}')
  writeFileSync(join(dir, 'cfg', 'opencode.json'), JSON.stringify({ update: 'disable', model: 'probe/qwen3:8b', providers: { probe: { name: 'Probe', models: { 'qwen3:8b': { name: 'qwen3 8b' } } } }, policies: [{ action: 'mcp.use', resource: '*', effect: 'deny' }] }))
  writeFileSync(launcherSourcePath(priv), LAUNCHER_SOURCE)
  const password = 'pw-' + Math.random().toString(36).slice(2)
  const env = childEnv({
    OPENCODE_PASSWORD: password,
    OPENCODE_CONFIG_DIR: join(dir, 'cfg'),
    XDG_DATA_HOME: home,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    FAKE_OPENCODE_LOG: join(dir, 'fake.jsonl'),
    CW_HOOK_TOKEN: 'tok-' + Math.random().toString(36).slice(2),
    ...launcherEnv({ executable: FAKE, cwd: project, sessionId: o.sessionId ?? newSessionId(), intent: o.intent ?? 'new', tuiArgs: [], dirs: [project], privateDir: priv, owner: '', marks: join(home, 'combwork-sessions'), hookUrl: o.hookUrl, readyMs: 15000 })
  })
  return { dir, priv, project, env, password }
}

function launch(r: Run) {
  const child = spawn(POWERSHELL, LAUNCHER_ARGS, { env: r.env, cwd: r.project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(child)
  let out = ''
  child.stdout!.on('data', (d) => (out += d))
  child.stderr!.on('data', (d) => (out += d))
  const exit = new Promise<number | null>((done) => child.on('exit', (code) => done(code)))
  return { child, exit, output: () => out }
}

const infoOf = (r: Run) => {
  try {
    return JSON.parse(readFileSync(serverInfoPath(r.priv), 'utf8')) as { url: string; serverPid: number; sessionId: string; pid: number }
  } catch {
    return null
  }
}
const fakeLog = (r: Run) => (existsSync(r.env.FAKE_OPENCODE_LOG) ? readFileSync(r.env.FAKE_OPENCODE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

/** What Combwork's tracker makes of the bodies posted so far, as its hook path would: the prompts counted and the open turn. */
function tracked(bodies: Record<string, any>[]) {
  const t = newTracker()
  let prompts = 0
  const ends: string[] = []
  for (const b of bodies) {
    const got = b.hook_event_name === 'OpencodeSnapshot' ? applySnapshot(t, b.gen, b.snapshot) : applyEvent(t, b.gen, b.event)
    for (const h of got) {
      if (h.event.kind === 'prompt') prompts++
      if (h.event.kind === 'stop' || h.event.kind === 'interrupt' || h.event.kind === 'signIn') ends.push(h.event.kind)
    }
  }
  return { prompts, ends, open: t.open }
}

/** A prompt through the server, as the TUI submits one (an inbox item). */
async function prompt(r: Run, text: string) {
  const info = infoOf(r)!
  const auth = 'Basic ' + Buffer.from(`opencode:${r.password}`).toString('base64')
  await fetch(info.url + `/api/session/${info.sessionId}/prompt`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
}
const turnsEnded = (r: Run) => fakeLog(r).filter((e) => e.kind === 'turn-end').length

describe.runIf(windows)("the launcher follows OpenCode's session: baseline first, events in order, settled resyncs", () => {
  it('a baseline before the TUI (new: empty), then each event projected, in order, with the launch token; a prompt counted once and finished', async () => {
    const hook = await hookServer()
    const r = setUp({ hookUrl: '' })
    r.env.CW_OC_HOOK_URL = hook.url
    const l = launch(r)
    await until(() => infoOf(r), 'the server record')
    // The TUI started only after the baseline was posted.
    const first = await until(() => hook.bodies[0], 'the baseline')
    const tui = await until(() => fakeLog(r).find((e) => e.kind === 'tui'), 'the TUI')
    expect([first.hook_event_name, first.snapshot.baseline, first.snapshot.intent, first.snapshot.messages]).toEqual(['OpencodeSnapshot', true, 'new', []])
    expect(Date.parse(tui.at)).toBeGreaterThanOrEqual(0)
    expect(hook.auth.every((a) => a === `Bearer ${r.env.CW_HOOK_TOKEN}`)).toBe(true)
    await prompt(r, 'hello')
    await until(() => tracked(hook.bodies).ends.length === 1, 'the turn to end')
    const types = hook.bodies.slice(1).map((b) => b.event?.type)
    expect(types).toEqual(['session.inbox.enqueued', 'session.usage.updated', 'session.step.started', 'session.usage.updated', 'session.execution.succeeded'])
    expect(hook.bodies[1].event).toMatchObject({ inboxID: expect.stringMatching(/^msg_/), itemType: 'user', text: 'hello', seq: expect.any(Number) })
    // Usage as events.ts projects it (for HI-2762's live usage): cost and tokens, numbers only, no seq (2.2.6 gives none).
    expect(hook.bodies[2].event).toEqual({ type: 'session.usage.updated', cost: 0, tokens: { input: expect.any(Number), output: expect.any(Number), reasoning: expect.any(Number), cache: { read: expect.any(Number), write: expect.any(Number) } } })
    expect(tracked(hook.bodies)).toEqual({ prompts: 1, ends: ['stop'], open: null })
    l.child.kill()
    await l.exit
  }, 60000)

  it('the stream dropped mid-turn: the turn ends while disconnected, the settled snapshot after the reconnect ends it, the prompt counted once', async () => {
    const hook = await hookServer()
    const r = setUp({ hookUrl: '' })
    r.env.CW_OC_HOOK_URL = hook.url
    const l = launch(r)
    await until(() => hook.bodies[0], 'the baseline')
    await prompt(r, 'drop events')
    await until(() => turnsEnded(r) === 1, 'the fake turn to end')
    await until(() => hook.bodies.filter((b) => b.hook_event_name === 'OpencodeSnapshot').length >= 2, 'the resync snapshot')
    await until(() => tracked(hook.bodies).ends.length === 1, "the turn's end, through the snapshot")
    expect(tracked(hook.bodies)).toEqual({ prompts: 1, ends: ['stop'], open: null })
    const gens = hook.bodies.map((b) => b.gen)
    expect(gens).toEqual([...gens].sort((a, b) => a - b))
    l.child.kill()
    await l.exit
  }, 60000)

  it('a turn that ends between the last message page and the second watermark: that snapshot is never posted; the next, settled one is, each prompt counted once', async () => {
    const hook = await hookServer()
    const r = setUp({ hookUrl: '' })
    r.env.CW_OC_HOOK_URL = hook.url
    // The baseline reads the watermark twice (1, 2); the resync after the dropped stream reads it at 3 and 4: before the
    // 4th is answered, the fake runs a whole turn ("raced"), so that snapshot's two watermarks differ.
    r.env.FAKE_OPENCODE_RACE_ON_LOG = '4'
    const l = launch(r)
    await until(() => hook.bodies[0], 'the baseline')
    await until(() => infoOf(r), 'the server record')
    await prompt(r, 'drop events')
    await until(() => turnsEnded(r) >= 2, 'both turns to end')
    await until(() => tracked(hook.bodies).ends.length === 2, 'both ends, through settled snapshots')
    expect(tracked(hook.bodies)).toEqual({ prompts: 2, ends: ['stop', 'stop'], open: null })
    // Every snapshot posted was settled: the one taken across the race never was (its successor carries the raced turn).
    const snaps = hook.bodies.filter((b) => b.hook_event_name === 'OpencodeSnapshot')
    expect(snaps.length).toBeGreaterThanOrEqual(2)
    expect(snaps.at(-1)!.snapshot.messages.some((m: { type: string; text?: string }) => m.type === 'user' && m.text === 'raced')).toBe(true)
    l.child.kill()
    await l.exit
  }, 60000)

  it('an over-long frame, and a hook server refusing one post: each resyncs, and the state ends true', async () => {
    let refuse = false
    const hook = await hookServer(() => {
      if (!refuse) return 200
      refuse = false
      return 500
    })
    const r = setUp({ hookUrl: '' })
    r.env.CW_OC_HOOK_URL = hook.url
    const l = launch(r)
    await until(() => hook.bodies[0], 'the baseline')
    await until(() => infoOf(r), 'the server record')
    await prompt(r, 'long frame')
    await until(() => turnsEnded(r) === 1, 'the first turn to end')
    await until(() => tracked(hook.bodies).ends.length === 1, 'its end')
    const afterLong = hook.bodies.filter((b) => b.hook_event_name === 'OpencodeSnapshot').length
    expect(afterLong).toBeGreaterThanOrEqual(2)
    refuse = true
    await prompt(r, 'second')
    await until(() => turnsEnded(r) === 2, 'the second turn to end')
    await until(() => tracked(hook.bodies).ends.length === 2, 'its end, after the refused post').catch((e) => { throw new Error(e.message + ' ' + JSON.stringify(hook.bodies.map((b) => [b.gen, b.hook_event_name, b.event?.type ?? b.snapshot?.messages?.map((m: { type: string }) => m.type).join('/')]))) })
    expect(tracked(hook.bodies)).toEqual({ prompts: 2, ends: ['stop', 'stop'], open: null })
    expect(hook.bodies.filter((b) => b.hook_event_name === 'OpencodeSnapshot').length).toBeGreaterThan(afterLong)
    l.child.kill()
    await l.exit
  }, 60000)

  it("the baseline can't be posted (the hook server refuses): the launch fails, the TUI never starts, the server ends", async () => {
    const hook = await hookServer(() => 500)
    const r = setUp({ hookUrl: '' })
    r.env.CW_OC_HOOK_URL = hook.url
    const l = launch(r)
    expect(await l.exit).toBe(LAUNCHER_EXIT.baseline)
    expect(fakeLog(r).some((e) => e.kind === 'tui')).toBe(false)
    expect(l.output()).toContain("couldn't follow its session")
    const serve = fakeLog(r).find((e) => e.kind === 'listening')
    if (serve) await until(() => !alive(serve.pid), 'the server to end')
  }, 60000)

  it('a resumed session: its closed history in the baseline counts nothing; the next prompt counts once', async () => {
    const hook1 = await hookServer()
    const r1 = setUp({ hookUrl: '' })
    r1.env.CW_OC_HOOK_URL = hook1.url
    const a = launch(r1)
    await until(() => hook1.bodies[0], 'the first baseline')
    await prompt(r1, 'one')
    await until(() => tracked(hook1.bodies).ends.length === 1, 'the first turn')
    a.child.kill()
    await a.exit
    const info1 = infoOf(r1)!
    await until(() => !alive(info1.serverPid), 'the first server to end')
    const hook2 = await hookServer()
    const r2 = setUp({ hookUrl: '', sessionId: info1.sessionId, intent: 'resume', home: join(r1.dir, 'acct'), project: r1.project })
    r2.env.CW_OC_HOOK_URL = hook2.url
    r2.env.FAKE_OPENCODE_LOG = r1.env.FAKE_OPENCODE_LOG
    const b = launch(r2)
    const base = await until(() => hook2.bodies[0], 'the resumed baseline')
    // Its newest idle marker, where Combwork's knowledge starts: the closed history before it isn't read (HR2's round 1).
    expect([base.snapshot.baseline, base.snapshot.intent, base.snapshot.boundary, base.snapshot.messages.map((m: { type: string }) => m.type)]).toEqual([true, 'resume', 'known', ['idle']])
    expect(tracked(hook2.bodies).prompts).toBe(0)
    await until(() => infoOf(r2), 'the resumed server record')
    await prompt(r2, 'two')
    await until(() => tracked(hook2.bodies).ends.length === 1, 'the resumed turn')
    expect(tracked(hook2.bodies)).toEqual({ prompts: 1, ends: ['stop'], open: null })
    b.child.kill()
    await b.exit
  }, 90000)
})
