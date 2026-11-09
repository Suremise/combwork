// The launcher's recovery at its bounds (HI-2760, HR2's round 1), on its own C# (LAUNCHER_SOURCE, compiled as the
// bootstrap compiles it) driven by reflection against a stand-in OpenCode server and hook server of the test's own:
// - a settled snapshot publishes all or nothing: what was held while it was read, too much for the queue (items or bytes),
//   is dropped and held anew, never leaving the repair state broken, and the next repair works;
// - a baseline establishes where Combwork's knowledge starts: a resumed session's stops at its newest idle marker, and one
//   whose messages are bounded out (a message over the size bound, the page limit) fails the launch, nothing posted.
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { childEnv } = require('./e2e/runContext.cjs') as { childEnv: (vars?: Record<string, string>) => Record<string, string> }
const { LAUNCHER_SOURCE } = await import('../src/main/providers/opencode/launcher')
const { applySnapshot, newTracker } = await import('../src/main/providers/opencode/events')
const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const windows = process.platform === 'win32'

const servers: http.Server[] = []
afterAll(() => {
  for (const s of servers) s.close()
})

type Msg = { id: string; type: string; [k: string]: unknown }

/** OpenCode's server as the snapshot reads it (watermark 5, an idle session), its messages newest first, honouring limit and cursor; and the hook server. */
async function standIn(messages: (limit: number, cursor: string | null) => { data: Msg[]; next: string | null }, session = '{"data":{"time":{"busy":1,"idle":2},"outcome":"succeeded"}}') {
  const posts: Record<string, any>[] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        posts.push(JSON.parse(raw))
        res.end('{}')
      })
      return
    }
    res.setHeader('content-type', 'application/json')
    if (url.pathname.endsWith('/log')) return void res.end('data: {"type":"log.synced","seq":5}\n\n')
    if (url.pathname.endsWith('/permission')) return void res.end('{"data":[]}')
    if (url.pathname.endsWith('/message')) {
      const page = messages(Number(url.searchParams.get('limit') ?? 50), url.searchParams.get('cursor'))
      return void res.end(JSON.stringify({ data: page.data, cursor: page.next ? { next: page.next } : {} }))
    }
    res.end(session)
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, posts }
}

/** The launcher's CwStream compiled, given `body` (PowerShell using Take, Settle, Resync and State); each OUT line it writes, parsed. */
async function drive(url: string, intent: 'new' | 'resume', body: string): Promise<Record<string, any>[]> {
  const dir = tempDir('cw-ocbounds-')
  const source = join(dir, 'launcher.cs')
  writeFileSync(source, LAUNCHER_SOURCE)
  const script = join(dir, 'drive.ps1')
  writeFileSync(
    script,
    [
      'param([string]$url, [string]$source, [string]$intent)',
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -TypeDefinition ([IO.File]::ReadAllText($source)) -ReferencedAssemblies System.Web.Extensions',
      "[CwStream]::Url = $url; [CwStream]::Session = 'ses_probe'; [CwStream]::Auth = 'Basic probe'; [CwStream]::Intent = $intent; [CwStream]::HookUrl = $url + '/hook'; [CwStream]::HookToken = 'probe'",
      "$f = [Reflection.BindingFlags]'NonPublic,Public,Static'",
      "function Take([string]$json, [int]$n) { $m = [CwStream].GetMethod('Take', $f); for ($i = 0; $i -lt $n; $i++) { $null = $m.Invoke($null, @($json)) } }",
      "function Settle([bool]$baseline, [bool]$postNow) { return [CwStream].GetMethod('Settle', $f).Invoke($null, @($baseline, [DateTime]::UtcNow.AddSeconds(15), $postNow)) }",
      "function State([string]$name, $ok) { $q = [CwStream].GetField('queue', $f).GetValue($null); $h = [CwStream].GetField('held', $f).GetValue($null); $first = ''; if ($q.Count -gt 0) { $first = $q.Peek().Key.Substring(0, 40) }; $o = @{ name = $name; ok = $ok; queue = $q.Count; held = $(if ($null -eq $h) { -1 } else { $h.Count }); first = $first; problem = [CwStream]::LastProblem }; Write-Output ('OUT ' + (ConvertTo-Json $o -Compress)) }",
      body
    ].join('\r\n')
  )
  const out = await new Promise<string>((resolve, reject) => {
    const c = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, url, source, intent], { env: childEnv(), windowsHide: true })
    let text = ''
    c.stdout.on('data', (d) => (text += d))
    c.stderr.on('data', (d) => (text += d))
    c.on('error', reject)
    c.on('exit', (code) => (code === 0 ? resolve(text) : reject(new Error(`the driver exited ${code}: ${text.slice(-2000)}`))))
  })
  return out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('OUT '))
    .map((l) => JSON.parse(l.slice(4)))
}

const usage = '{"type":"session.usage.updated","data":{"sessionID":"ses_probe","cost":1,"tokens":{"input":1}}}'
const longPrompt = JSON.stringify({ type: 'session.inbox.enqueued', data: { sessionID: 'ses_probe', inboxID: 'msg_x', item: { type: 'user', payload: { text: 'p'.repeat(2000) } } } })
const pageOf = (all: Msg[]) => (limit: number, cursor: string | null) => {
  const from = cursor ? Number(cursor) : 0
  const data = all.slice(from, from + limit)
  return { data, next: from + limit < all.length ? String(from + limit) : null }
}

describe.runIf(windows)("the launcher's recovery at its bounds (its own C#, a stand-in server)", () => {
  it('a full held buffer (512 events) while a recovery snapshot is read: the snapshot alone published, held anew; the next repair publishes snapshot and events', async () => {
    const s = await standIn(pageOf([]))
    const out = await drive(s.url, 'new', [`Take '${usage}' 512`, "State 'first' (Settle $false $false)", '[CwStream]::Resync()', `Take '${usage}' 10`, "State 'second' (Settle $false $false)"].join('\r\n'))
    expect(out[0]).toMatchObject({ name: 'first', ok: true, queue: 1, held: -1, first: expect.stringContaining('OpencodeSnapshot'), problem: expect.stringMatching(/queue holds/) })
    expect(out[1]).toMatchObject({ name: 'second', ok: true, queue: 11, held: -1, first: expect.stringContaining('OpencodeSnapshot') })
  }, 60000)

  it('held events within the items bound but over the bytes bound: the same, all or nothing; 511 small ones fit beside the snapshot', async () => {
    const s = await standIn(pageOf([]))
    const out = await drive(s.url, 'new', [`Take '${longPrompt.replace(/'/g, "''")}' 500`, "State 'bytes' (Settle $false $false)", '[CwStream]::Resync()', `Take '${usage}' 511`, "State 'fits' (Settle $false $false)"].join('\r\n'))
    expect(out[0]).toMatchObject({ name: 'bytes', ok: true, queue: 1, held: -1, problem: expect.stringMatching(/queue holds/) })
    expect(out[1]).toMatchObject({ name: 'fits', ok: true, queue: 512, held: -1 })
  }, 60000)

  it("a resumed baseline whose newest message is over the size bound (no idle marker reached): the launch fails, nothing posted", async () => {
    const s = await standIn(pageOf([{ id: 'huge', type: 'assistant', content: 'x'.repeat(1048577) }, { id: 'u1', type: 'user' }]))
    const out = await drive(s.url, 'resume', "State 'huge' (Settle $true $true)")
    expect(out[0]).toMatchObject({ ok: false, problem: expect.stringMatching(/history couldn't be read within its bounds \(a message over the size bound\)/) })
    expect(s.posts).toEqual([])
  }, 60000)

  it('a resumed baseline with ten pages and no idle marker: the launch fails, nothing posted', async () => {
    const s = await standIn(pageOf(Array.from({ length: 600 }, (_, i) => ({ id: `a${i}`, type: 'assistant' }))))
    const out = await drive(s.url, 'resume', "State 'pages' (Settle $true $true)")
    expect(out[0]).toMatchObject({ ok: false, problem: expect.stringMatching(/within its bounds/) })
    expect(s.posts).toEqual([])
  }, 60000)

  it('a resumed baseline stops at its newest idle marker, never reading the history before it (a message there over the size bound included)', async () => {
    const s = await standIn(pageOf([{ id: 'idle9', type: 'idle', outcome: 'succeeded' }, { id: 'u9', type: 'user' }, { id: 'huge', type: 'assistant', content: 'x'.repeat(1048577) }]))
    const out = await drive(s.url, 'resume', "State 'idle' (Settle $true $true)")
    expect(out[0]).toMatchObject({ ok: true })
    expect(s.posts.map((p) => [p.snapshot.baseline, p.snapshot.intent, p.snapshot.boundary, p.snapshot.messages.map((m: Msg) => m.id)])).toEqual([[true, 'resume', 'known', ['idle9']]])
  }, 60000)

  it("a resumed session with an execution running: its baseline is that execution after the newest idle marker, which the tracker opens", async () => {
    const s = await standIn(pageOf([{ id: 'a2', type: 'assistant' }, { id: 'u2', type: 'user', text: 'go on' }, { id: 'idle1', type: 'idle', outcome: 'succeeded' }, { id: 'u1', type: 'user' }]), '{"data":{"time":{"busy":3,"idle":2}}}')
    await drive(s.url, 'resume', "State 'running' (Settle $true $true)")
    const snap = s.posts[0].snapshot
    expect([snap.boundary, snap.messages.map((m: Msg) => m.id)]).toEqual(['known', ['idle1', 'u2', 'a2']])
    const t = newTracker()
    const hooks = applySnapshot(t, s.posts[0].gen, snap)
    expect([t.open, hooks.map((h) => h.event.kind)]).toEqual(['u2', ['prompt']])
  }, 60000)
})
