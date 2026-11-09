// The OpenCode state view's delivery (HI-2771): Combwork's one instruction entry, put and removed through the launch's own
// server (its record, its password), against the fake opencode modelled on 2.2.6's routes
// (tests/fixtures/opencode/real-2.2.6/wire/instruction-entries.json); what it says it did, never more than it knows.
import { spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { childEnv } = require('./e2e/runContext.cjs') as { childEnv: (vars?: Record<string, string>) => Record<string, string> }
const { CONTEXT_KEY, CONTEXT_MAX_BYTES, contextTrigger, deliverContext, trackContextRun, untrackContextRun } = await import('../src/main/providers/opencode/context')
const { serverInfoPath } = await import('../src/main/providers/opencode/launcher')
const FAKE = join(__dirname, 'e2e', 'fake-opencode', 'fake-opencode.cjs')
const REC = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'opencode', 'real-2.2.6', 'wire', 'instruction-entries.json'), 'utf8'))

const children: ChildProcess[] = []
afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill()
})

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

/** The fake's private server, a session on it, and the launch's record and run as Combwork's would be. */
async function launch(extra: Record<string, string> = {}) {
  const dir = tempDir('cw-occontext-')
  for (const d of ['cfg', 'data', 'project', 'private']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, 'cfg', 'opencode.json'), JSON.stringify({ update: 'disable', policies: [] }))
  writeFileSync(join(dir, 'cfg', 'service.json'), '{"disabled":true}')
  const password = 'pw-' + Math.random().toString(36).slice(2)
  const log = join(dir, 'fake.jsonl')
  const env = childEnv({ OPENCODE_CONFIG_DIR: join(dir, 'cfg'), XDG_DATA_HOME: join(dir, 'data'), OPENCODE_DB: join(dir, 'data', 'opencode.db'), OPENCODE_PASSWORD: password, FAKE_OPENCODE_LOG: log, ...extra })
  const child = spawn(process.execPath, [FAKE, 'serve', '--hostname', '127.0.0.1', '--port', '0'], { env, cwd: join(dir, 'project'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(child)
  let out = ''
  child.stdout!.on('data', (d) => (out += d))
  const url = await until(() => /listening on (\S+)/.exec(out)?.[1], 'serve')
  const auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(url + p, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const t = await r.text()
    return { status: r.status, body: t ? JSON.parse(t) : null }
  }
  await until(async () => (await api('GET', '/api/info')).status === 200, '/api/info')
  const sid = (await api('POST', '/api/session', { location: { directory: join(dir, 'project') } })).body.data.id as string
  const priv = join(dir, 'private')
  writeFileSync(serverInfoPath(priv), JSON.stringify({ url, port: Number(url.split(':').pop()), serverPid: child.pid, sessionId: sid, pid: process.pid }))
  const runId = `run-${Math.random()}`
  trackContextRun(runId, priv, password, sid)
  const entries = async () => (await api('GET', `/api/experimental/session/${sid}/instructions/entries`)).body.data as { key: string; value: unknown }[]
  const logged = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'instruction-entry')
  return { dir, priv, url, sid, runId, api, entries, logged, stop: () => child.kill() }
}
const signal = () => new AbortController().signal

describe('the OpenCode state view in its session (HI-2771)', () => {
  it('puts it as Combwork\'s one entry, a new value superseding the old; removes only that entry, leaving any other', async () => {
    const l = await launch()
    expect(await deliverContext(l.runId, l.sid, '[CW] view one', signal())).toBe('put')
    expect(await deliverContext(l.runId, l.sid, '[CW] view two', signal())).toBe('put')
    await l.api('PUT', `/api/experimental/session/${l.sid}/instructions/entries/someone.else`, { value: 'theirs' })
    expect(await l.entries()).toEqual([{ key: CONTEXT_KEY, value: '[CW] view two' }, { key: 'someone.else', value: 'theirs' }])
    expect(await deliverContext(l.runId, l.sid, null, signal())).toBe('removed')
    expect(await l.entries()).toEqual([{ key: 'someone.else', value: 'theirs' }])
    // None there: removed is still what it is.
    expect(await deliverContext(l.runId, l.sid, null, signal())).toBe('removed')
    l.stop()
  }, 60000)

  it('a view over the limit (its body\'s UTF-8 bytes) is never sent, nor trimmed: Combwork\'s entry is removed instead', async () => {
    const l = await launch()
    await deliverContext(l.runId, l.sid, '[CW] old view', signal())
    expect(await deliverContext(l.runId, l.sid, 'é'.repeat(CONTEXT_MAX_BYTES / 2), signal())).toBe('tooLarge')
    expect(await l.entries()).toEqual([])
    expect(l.logged().filter((e) => e.method === 'PUT').map((e) => e.status)).toEqual([204])
    l.stop()
  }, 60000)

  it('only for its own run and session, on a loopback server named by the launch\'s own record; refused or cut off, never a success', async () => {
    const l = await launch()
    expect(await deliverContext(l.runId, 'ses_other', '[CW] view', signal())).toBe('notSent')
    expect(await deliverContext('run-unknown', l.sid, '[CW] view', signal())).toBe('notSent')
    const gone = new AbortController()
    gone.abort()
    expect(await deliverContext(l.runId, l.sid, '[CW] view', gone.signal)).toBe('notSent')
    writeFileSync(serverInfoPath(l.priv), JSON.stringify({ url: l.url.replace('127.0.0.1', 'example.com'), sessionId: l.sid }))
    expect(await deliverContext(l.runId, l.sid, '[CW] view', signal())).toBe('notSent')
    writeFileSync(serverInfoPath(l.priv), JSON.stringify({ url: l.url, sessionId: 'ses_someone_else' }))
    expect(await deliverContext(l.runId, l.sid, '[CW] view', signal())).toBe('notSent')
    untrackContextRun(l.runId)
    expect(await deliverContext(l.runId, l.sid, '[CW] view', signal())).toBe('notSent')
    expect(l.logged()).toEqual([])
    l.stop()
    const refused = await launch({ FAKE_OPENCODE_ENTRY_REFUSE: '1' })
    expect(await deliverContext(refused.runId, refused.sid, '[CW] view', signal())).toBe('refused')
    expect(await refused.entries()).toEqual([])
    refused.stop()
    const hung = await launch({ FAKE_OPENCODE_ENTRY_HANG: '1' })
    const cut = new AbortController()
    const out = deliverContext(hung.runId, hung.sid, '[CW] view', cut.signal)
    await until(() => hung.logged().some((e) => e.status === 'hung'), 'the request to reach the server')
    cut.abort()
    expect(await out).toBe('uncertain')
    hung.stop()
  }, 90000)

  it('its triggers: the launch\'s baseline snapshot, and a compaction\'s end by its event\'s identity', () => {
    expect(contextTrigger({ hook_event_name: 'OpencodeSnapshot', snapshot: {} })).toEqual({ source: 'start' })
    expect(contextTrigger({ hook_event_name: 'OpencodeEvent', event: { type: 'session.compaction.ended', id: 'evt_1' } })).toEqual({ source: 'compact', id: 'evt_1' })
    expect(contextTrigger({ hook_event_name: 'OpencodeEvent', event: { type: 'session.compaction.ended', seq: 7 } })).toEqual({ source: 'compact', id: 'seq:7' })
    for (const b of [{ hook_event_name: 'OpencodeEvent', event: { type: 'session.compaction.started', id: 'x' } }, { hook_event_name: 'OpencodeEvent', event: { type: 'session.compaction.ended' } }, { hook_event_name: 'SessionStart' }]) expect(contextTrigger(b)).toBeNull()
  })

  it('the fake answers as 2.2.6 did (the recording)', async () => {
    const l = await launch()
    for (const k of ['put', 'list', 'badKey', 'noValue', 'putTooLarge', 'delete', 'deleteAbsent', 'missingSession']) {
      const c = REC[k] as { request: { method: string; path: string; body?: unknown }; status: number; body?: unknown }
      const path = c.request.path.replace('<session>', l.sid)
      // The recording names the 270,000-character value rather than holding it.
      const body = k === 'putTooLarge' ? { value: 'x'.repeat(270000) } : c.request.body
      const r = await l.api(c.request.method, path, body)
      expect(r.status, k).toBe(c.status)
      if (c.body !== undefined) expect(r.body, k).toEqual(c.body)
    }
    l.stop()
  }, 60000)
})
