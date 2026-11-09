// The OpenCode launcher's lifetime and session protocol (HI-2759, design s13 to s16), run for real on Windows: the private
// server and everything it starts end when the launcher dies however it dies (forced, before or after the server is
// ready), when the Combwork that launched it dies while the launcher lives, and the launcher refuses an owner that isn't
// that exact process. New sessions are created (GET 404, then POST), a resume only looks (GET), an id clash or a missing
// resumed session fails. A stand-in server (written here) controls timing; the fake opencode (HI-2763) runs the protocol.
import { spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { connect } from 'net'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { childEnv } = require('./e2e/runContext.cjs') as { childEnv: (vars?: Record<string, string>) => Record<string, string> }
const { endTreeExactly, identify, processes } = require('./e2e/folderProcesses.cjs') as { endTreeExactly: (root: { pid: number; started: number }, list: unknown) => number; identify: (pids: number[]) => { pid: number; started: number }[]; processes: () => unknown }
const { LAUNCHER_ARGS, LAUNCHER_EXIT, LAUNCHER_SOURCE, launcherEnv, launcherSourcePath, processToken, serverInfoPath, serverLogPath, sessionMark } = await import('../src/main/providers/opencode/launcher')
const { newSessionId } = await import('../src/main/providers/opencode/adapter')
const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const FAKE = join(__dirname, 'e2e', 'fake-opencode', 'opencode.cmd')
const windows = process.platform === 'win32'

/**
 * A stand-in for `opencode`: `serve --port N` starts a grandchild, waits CW_STANDIN_DELAY ms, then answers /api/info and
 * the session routes (Basic auth checked), ignoring its stdin's end as 2.2.6 does; it records its pid, its grandchild's
 * and its port. Anything else is the TUI: it says so and waits.
 */
const STANDIN = `
const http = require('http'), fs = require('fs'), cp = require('child_process')
const a = process.argv.slice(2)
const rec = process.env.CW_STANDIN_REC
if (a[0] === 'serve') {
  const port = Number(a[a.indexOf('--port') + 1])
  const kid = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  fs.writeFileSync(rec, JSON.stringify({ serve: process.pid, kid: kid.pid, port }))
  process.stdin.on('end', () => {}); process.stdin.resume()
  const auth = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64')
  const sessions = new Set((process.env.CW_STANDIN_SESSIONS || '').split(',').filter(Boolean))
  setTimeout(() => http.createServer((q, r) => {
    if (q.headers.authorization !== auth) { r.writeHead(401); return r.end() }
    let body = ''; q.on('data', (c) => (body += c)); q.on('end', () => {
      const m = /^\\/api\\/session\\/(.+)$/.exec(q.url)
      if (q.url === '/api/info') { r.writeHead(200); return r.end('{}') }
      if (m && q.method === 'GET') { const id = decodeURIComponent(m[1]); if (!sessions.has(id)) { r.writeHead(404); return r.end('{}') } r.writeHead(200); return r.end(JSON.stringify({ data: { id, location: { directory: process.env.CW_STANDIN_DIR } } })) }
      if (q.url === '/api/session' && q.method === 'POST') { const b = JSON.parse(body); sessions.add(b.id); r.writeHead(200); return r.end(JSON.stringify({ data: { id: b.id, location: b.location } })) }
      r.writeHead(404); r.end()
    })
  }).listen(port, '127.0.0.1'), Number(process.env.CW_STANDIN_DELAY || 0))
} else {
  fs.appendFileSync(rec + '.tui', JSON.stringify(a) + '\\n')
  console.log('TUI ' + a.join(' '))
  setInterval(() => {}, 1000)
}
`

const children: ChildProcess[] = []
/** Processes the tests started without a handle to them (a launcher a stand-in started): by identity, taken while known ours. */
const identities: { pid: number; started: number }[] = []
afterAll(() => {
  // Through the handles held (#603), then by identity, each only while still that process.
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill()
  const now = processes()
  for (const id of identities) endTreeExactly(id, now)
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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
const portFree = (port: number): Promise<boolean> =>
  new Promise((done) => {
    const s = connect(port, '127.0.0.1')
    s.once('connect', () => (s.destroy(), done(false)))
    s.once('error', () => done(true))
  })

interface Run {
  dir: string
  home: string
  project: string
  priv: string
  rec: string
  env: Record<string, string>
}

/** A launch's folders and environment, with the stand-in (or the fake) as its opencode. */
function setUp(o: { exe?: 'standin' | 'fake'; intent?: 'new' | 'resume'; sessionId?: string; owner?: string; delay?: number; sessions?: string[]; home?: string; project?: string; binDir?: string; tuiArgs?: string[] } = {}): Run {
  const dir = tempDir('cw-oclauncher-')
  const home = o.home ?? join(dir, 'acct')
  const project = o.project ?? join(dir, 'project')
  const priv = join(dir, 'private')
  for (const d of [home, project, priv, join(dir, 'cfg')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(dir, 'cfg', 'service.json'), '{"disabled":true}')
  writeFileSync(join(dir, 'cfg', 'opencode.json'), JSON.stringify({ update: 'disable', policies: [{ action: 'mcp.use', resource: '*', effect: 'deny' }] }))
  // The stand-in's .cmd (not a bare Node launcher: it names node by its path, so it goes through cmd.exe), in a folder
  // of the test's choosing (one with a space and an ampersand, say).
  const bin = o.binDir ? join(dir, o.binDir) : dir
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'standin.cjs'), STANDIN)
  writeFileSync(join(bin, 'opencode.cmd'), `@"${process.execPath}" "%~dp0standin.cjs" %*\r\n`)
  writeFileSync(launcherSourcePath(priv), LAUNCHER_SOURCE)
  const rec = join(dir, 'standin.json')
  const sessionId = o.sessionId ?? newSessionId()
  const env = childEnv({
    OPENCODE_PASSWORD: 'pw-' + Math.random().toString(36).slice(2),
    OPENCODE_CONFIG_DIR: join(dir, 'cfg'),
    XDG_DATA_HOME: home,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    FAKE_OPENCODE_LOG: join(dir, 'fake.jsonl'),
    CW_STANDIN_REC: rec,
    CW_STANDIN_DELAY: String(o.delay ?? 0),
    CW_STANDIN_DIR: project,
    CW_STANDIN_SESSIONS: (o.sessions ?? []).join(','),
    ...launcherEnv({ executable: o.exe === 'fake' ? FAKE : join(bin, 'opencode.cmd'), cwd: project, sessionId, intent: o.intent ?? 'new', tuiArgs: o.tuiArgs ?? [], dirs: [project], privateDir: priv, owner: o.owner ?? '', marks: join(home, 'combwork-sessions'), readyMs: 30000 })
  })
  return { dir, home, project, priv, rec, env }
}

function launch(r: Run): { child: ChildProcess; exit: Promise<number | null>; output: () => string } {
  const child = spawn(POWERSHELL, LAUNCHER_ARGS, { env: r.env, cwd: r.project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(child)
  let out = ''
  child.stdout!.on('data', (d) => (out += d))
  child.stderr!.on('data', (d) => (out += d))
  const exit = new Promise<number | null>((done) => child.on('exit', (code) => done(code)))
  return { child, exit, output: () => out }
}

const standin = (r: Run): { serve: number; kid: number; port: number } | null => (existsSync(r.rec) ? JSON.parse(readFileSync(r.rec, 'utf8')) : null)
const infoOf = (r: Run): { url: string; port: number; serverPid: number; sessionId: string; pid: number } | null => {
  try {
    return JSON.parse(readFileSync(serverInfoPath(r.priv), 'utf8'))
  } catch {
    return null
  }
}

/**
 * A stand-in for Combwork's main process, which starts the launcher naming itself the owner (its identity read as main
 * reads its own at start). It is a PowerShell, not Node: Node puts every child in a job of its own that ends them when it
 * ends (libuv), so a Node stand-in's launcher would be killed with it and its owner watch never tested. Killed alone (its
 * handle held), the launcher it started lives on.
 */
async function ownerStandIn(r: Run): Promise<{ main: ChildProcess; launcherPid: number }> {
  const go = join(r.dir, 'go')
  const ps = [
    `while (-not [IO.File]::Exists('${go}')) { Start-Sleep -Milliseconds 50 }`,
    `$env:CW_OC_OWNER = [IO.File]::ReadAllText('${go}')`,
    `$s = [Diagnostics.ProcessStartInfo]::new('${POWERSHELL}', '${LAUNCHER_ARGS.join(' ')}')`,
    '$s.UseShellExecute = $false; $s.CreateNoWindow = $true',
    '$p = [Diagnostics.Process]::Start($s)',
    `[IO.File]::WriteAllText('${go}.pid', [string]$p.Id)`,
    'while ($true) { Start-Sleep -Seconds 1 }'
  ].join('\n')
  const main = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { env: r.env, stdio: 'ignore', windowsHide: true })
  children.push(main)
  writeFileSync(go, await until(() => processToken(main.pid!), "the stand-in's identity"))
  const launcherPid = Number(await until(() => (existsSync(go + '.pid') ? readFileSync(go + '.pid', 'utf8') : ''), 'the launcher'))
  identities.push(...identify([launcherPid]))
  return { main, launcherPid }
}

/** The server, its grandchild and its port, all gone. */
async function allGone(s: { serve: number; kid: number; port: number }): Promise<void> {
  await until(() => !alive(s.serve) && !alive(s.kid), 'the server and its child to end')
  await until(() => portFree(s.port), "the server's port to be free")
}

describe.runIf(windows)('the launcher owns the server (design s13: a kill-on-close job of its own)', () => {
  it('a new session: GET 404, POST, its record in the account, the TUI given --server and --session; the launcher forced dead ends the server and its child', async () => {
    const r = setUp()
    const l = launch(r)
    const info = await until(() => infoOf(r), 'the server record')
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(existsSync(sessionMark(r.home, info.sessionId))).toBe(true)
    const tui = await until(() => (existsSync(r.rec + '.tui') ? readFileSync(r.rec + '.tui', 'utf8') : ''), 'the TUI')
    expect(JSON.parse(tui.trim())).toEqual(['--server', info.url, '--session', info.sessionId, r.project])
    // The record never holds the password.
    expect(readFileSync(serverInfoPath(r.priv), 'utf8')).not.toContain(r.env.OPENCODE_PASSWORD)
    const s = standin(r)!
    // Forced (TerminateProcess) through the handle held: no handler of the launcher runs.
    l.child.kill()
    await l.exit
    await allGone(s)
  }, 60000)

  it('forced dead before the server answers: nothing it started is left', async () => {
    const r = setUp({ delay: 60000 })
    const l = launch(r)
    const s = await until(() => standin(r), 'the server to start')
    expect(infoOf(r)).toBeNull()
    l.child.kill()
    await l.exit
    await allGone(s)
  }, 60000)

  it('the Combwork that launched it dies while the launcher lives: the server and its child still end', async () => {
    const r2 = setUp()
    const o = await ownerStandIn(r2)
    await until(() => infoOf(r2), 'the server record')
    const s = standin(r2)!
    expect(alive(o.launcherPid) && alive(s.serve)).toBe(true)
    o.main.kill()
    await allGone(s)
    await until(() => !alive(o.launcherPid), 'the launcher to end')
    expect(readFileSync(serverLogPath(r2.priv), 'utf8')).toContain('Combwork ended')
  }, 90000)

  it('the Combwork that launched it dies before its server answers, the launcher alive: it stops at once, the server and its child end, nothing is created', async () => {
    // As the test above, with a server that would take a minute to answer: the launcher must not wait it out.
    const r2 = setUp({ delay: 60000 })
    const o = await ownerStandIn(r2)
    const s = await until(() => standin(r2), 'the server to start')
    expect(alive(o.launcherPid) && alive(s.serve) && infoOf(r2) === null).toBe(true)
    const killed = Date.now()
    o.main.kill()
    // Bounded well below the server's 60 s and the launch's 30 s wait: the launcher sees its owner go within a poll.
    await until(() => !alive(o.launcherPid) && !alive(s.serve) && !alive(s.kid), 'the launcher, server and child to end', 15000)
    expect(Date.now() - killed).toBeLessThan(15000)
    await until(() => portFree(s.port), "the server's port to be free")
    expect(infoOf(r2)).toBeNull()
    expect(existsSync(r2.rec + '.tui')).toBe(false)
    expect(readFileSync(serverLogPath(r2.priv), 'utf8')).toContain('Combwork ended while')
  }, 90000)

  it("a .cmd opencode in a folder with a space and an ampersand, a project folder with them too, and arguments with cmd.exe's characters: each passed whole", async () => {
    const odd = ['--log-level', 'a & b | c > d < e ^ f', '100%PATH%', 'q"uote', '(x);y=z!']
    const r = setUp({ binDir: 'R&D tools', project: join(tempDir('cw-oclauncher-'), 'pro&ject (1) 50%'), tuiArgs: odd })
    const l = launch(r)
    const info = await until(() => infoOf(r), 'the server record')
    const tui = await until(() => (existsSync(r.rec + '.tui') ? readFileSync(r.rec + '.tui', 'utf8') : ''), 'the TUI')
    expect(JSON.parse(tui.trim())).toEqual(['--server', info.url, '--session', info.sessionId, ...odd, r.project])
    const s = standin(r)!
    l.child.kill()
    await l.exit
    await allGone(s)
  }, 60000)

  it('an owner that is not that exact process is refused, and no server starts: a creation time a tick off, or an old one', async () => {
    const real = await until(() => processToken(process.pid), 'this process\'s identity')
    const [pid, created] = real.split(':')
    for (const owner of [`${pid}:${BigInt(created) + 1n}`, `${pid}:${BigInt(created) - 10_000_000_000n}`, `${pid}:abc`]) {
      const r = setUp({ owner })
      const l = launch(r)
      expect(await l.exit, owner).toBe(LAUNCHER_EXIT.owner)
      expect(standin(r), owner).toBeNull()
      expect(l.output()).toContain("OpenCode didn't start")
    }
  }, 60000)

  it('this process as its owner, exactly: it starts', async () => {
    const r = setUp({ owner: await until(() => processToken(process.pid), "this process's identity") })
    const l = launch(r)
    expect((await until(() => infoOf(r), 'the server record')).pid).toBe(l.child.pid)
    const s = standin(r)!
    l.child.kill()
    await l.exit
    await allGone(s)
  }, 60000)
})

describe.runIf(windows)('the session protocol (design s10)', () => {
  it('new with an id the account already has: an id clash, never adopted', async () => {
    const id = newSessionId()
    const r = setUp({ sessionId: id, sessions: [id] })
    const l = launch(r)
    expect(await l.exit).toBe(LAUNCHER_EXIT.sessionClash)
    await allGone(standin(r)!)
    expect(existsSync(r.rec + '.tui')).toBe(false)
  }, 60000)

  it('resume of a session the account lacks: fails as missing, creating nothing; of one in another folder: refused', async () => {
    const r = setUp({ intent: 'resume' })
    const l = launch(r)
    expect(await l.exit).toBe(LAUNCHER_EXIT.sessionMissing)
    await allGone(standin(r)!)
    expect(existsSync(r.rec + '.tui')).toBe(false)
    const id = newSessionId()
    const other = setUp({ intent: 'resume', sessionId: id, sessions: [id] })
    other.env.CW_STANDIN_DIR = join(other.dir, 'elsewhere')
    const o = launch(other)
    expect(await o.exit).toBe(LAUNCHER_EXIT.sessionMismatch)
  }, 60000)

  it('with the fake opencode 2.2.6: a new session, then resumed by GET alone in the same account', async () => {
    const first = setUp({ exe: 'fake' })
    const a = launch(first)
    const info = await until(() => infoOf(first), 'the server record')
    a.child.kill()
    await a.exit
    await until(() => !alive(info.serverPid), 'the server to end')
    const second = setUp({ exe: 'fake', intent: 'resume', sessionId: info.sessionId, home: first.home, project: first.project })
    second.env.FAKE_OPENCODE_LOG = first.env.FAKE_OPENCODE_LOG
    const b = launch(second)
    const again = await until(() => infoOf(second), 'the resumed server record')
    expect(again.sessionId).toBe(info.sessionId)
    const log = readFileSync(first.env.FAKE_OPENCODE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const posts = log.filter((e) => e.kind === 'http' && e.method === 'POST' && String(e.path ?? e.url ?? '').endsWith('/api/session'))
    expect(posts.length).toBe(1)
    b.child.kill()
    await b.exit
    await until(() => !alive(again.serverPid), 'the resumed server to end')
  }, 90000)
})
