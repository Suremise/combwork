// Muse Code 1.4.20's real binary, checked inside a disposable Windows Sandbox (HI-3202; the README beside this says how).
// Nothing of Muse's runs on the host: its first screen there asks for administrator rights. Offline (the Sandbox's
// network off), headless (`muse exec --provider echo --disable-sandbox`), stdin closed: nothing is typed or answered.
// The launch is Combwork's own: stage.mjs bundles this file with src/main/providers/muse (launch.ts, home.ts) and the
// advanced values, so the Sandbox runs the very arguments, hooks, MCP values and environment a session gets.
// Results: C:\out\report.json, with each run's arguments and output, the hook stub's log and the MCP stub's logs.
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import http from 'http'
import fs from 'fs'
import path from 'path'
import type { McpServerDef } from '../../../src/shared/types'
import type { MuseArgsInput } from '../../../src/main/providers/muse/launch'
import { startContext, museHooks, museArgs, launchServers, hookPath } from '../../../src/main/providers/muse/launch'
import { museEnv } from '../../../src/main/providers/muse/home'
import { ADVANCED } from '../../../src/shared/providers/muse/advanced'
// Bundled by stage.mjs, with the tests' timing.json staged beside run.cjs for it to read (HI-3393).
import { timing } from '../../timing.cjs'

const HERE = __dirname
const MUSE = path.join(HERE, 'muse.exe')
const SHA = '2d223f7f992f02c313225ed47adf3dda24e7361b6b8389f2c19f7c12f026618a'
/** A dry run (stage.mjs --dry <folder>, on the host): every launch is built and saved, Muse never started. */
const DRY = process.env.MUSE_REAL_DRY ?? ''
const OUT = DRY ? path.join(DRY, 'out') : 'C:\\out'
const WORK = DRY ? path.join(DRY, 'work') : 'C:\\work'
const RUN_MS = timing('sandbox.museRunMs')

interface Check {
  name: string
  ok: boolean
  detail: string
}
const checks: Check[] = []
const check = (name: string, ok: boolean, detail = ''): void => {
  checks.push({ name, ok, detail: detail.slice(0, 2000) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` -- ${detail.slice(0, 300)}` : ''}`)
}

const walk = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [])
/** A session log's events (session.jsonl, its children unpacked). */
function events(file: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const j = JSON.parse(l)
    for (const r of j.children ? j.children.map((c: { record_json: string }) => JSON.parse(c.record_json)) : [j]) if (r?.payload?.event) out.push(r.payload.event)
  }
  return out
}
const hookContext = (file: string): string[] => events(file).filter((e) => e.kind === 'context_block_updated' && e.source === 'runtime_hook').map((e) => String(e.text))

interface Ran {
  code: number | null
  out: string
  err: string
}
function run(args: string[], cwd: string, env: Record<string, string>, name: string): Promise<Ran> {
  fs.writeFileSync(path.join(OUT, `${name}-args.json`), JSON.stringify(args, null, 2))
  if (DRY) return Promise.resolve({ code: null, out: '', err: 'dry' })
  return new Promise((done) => {
    const p = spawn(MUSE, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    // The TUI (a resume) never ends by itself: ended once it has had its time, its screen kept.
    const t = setTimeout(() => p.kill(), RUN_MS)
    p.on('close', (code) => {
      clearTimeout(t)
      fs.writeFileSync(path.join(OUT, `${name}-output.txt`), `exit ${code}\n--- stdout\n${out}\n--- stderr\n${err}\n`)
      done({ code, out, err })
    })
  })
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true })
  const sha = DRY ? 'dry' : createHash('sha256').update(fs.readFileSync(MUSE)).digest('hex')
  check('the pinned muse.exe 1.4.20', DRY !== '' || sha === SHA, sha)
  if (!DRY && sha !== SHA) return

  const home = path.join(WORK, 'home')
  const proj = path.join(WORK, 'proj')
  const priv = path.join(WORK, 'launch')
  for (const d of [home, proj, priv, path.join(proj, '.agents', 'skills', 'cw-muse-probe')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(proj, '.git'), 'gitdir: nowhere\n')
  fs.writeFileSync(path.join(proj, '.agents', 'skills', 'cw-muse-probe', 'SKILL.md'), '---\nname: cw-muse-probe\ndescription: MUSE-REAL-SKILL-MARKER a skill Combwork delivers.\n---\nNothing to do.\n')
  const authFile = path.join(priv, 'hook-auth.txt')
  fs.writeFileSync(authFile, 'Authorization: Bearer sandbox-token\n')

  // Combwork's hook server, as a stub: each hook's JSON, its Authorization header and its URL.
  const hookLog: { auth?: string; url?: string; body: Record<string, unknown> }[] = []
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(b)
      } catch {
        body = { unparsed: b.slice(0, 200) }
      }
      hookLog.push({ auth: req.headers.authorization, url: req.url, body })
      fs.appendFileSync(path.join(OUT, 'hooks.jsonl'), JSON.stringify(hookLog.at(-1)) + '\n')
      res.setHeader('Content-Type', 'application/json')
      res.end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const hookUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/hooks/muse?agent=a1&launch=L1`

    const base: Record<string, string> = {}
    for (const k of ['SystemRoot', 'windir', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA']) if (process.env[k]) base[k] = process.env[k]!
    base.META_API_KEY = 'must-be-stripped'
    const noShortNames = async (): Promise<string | null> => null

    /** A launch as Combwork builds it (adapter.ts's prepareLaunch and buildCommand, without the app around them). */
    async function launch(name: string, guidance: string, opts: { resume?: string; prompt?: string; exec?: boolean; sessionId?: string } = {}): Promise<Ran & { args: string[]; env: Record<string, string> }> {
      const full = path.join(priv, `${name}-guidance-full.md`)
      const sc = startContext(guidance, 16384, full)
      const startFile = path.join(priv, `${name}-guidance.md`)
      fs.writeFileSync(startFile, sc.printed)
      if (sc.full) fs.writeFileSync(full, sc.full)
      const gp = await hookPath(startFile, noShortNames)
      const ap = await hookPath(authFile, noShortNames)
      if (!gp || !ap) throw new Error('a path cmd cannot take unquoted')
      const tools: McpServerDef = { command: process.execPath, args: [path.join(HERE, 'mcp.cjs'), 'combwork', path.join(OUT, `${name}-mcp.log`)], env: { CW_PROBE: 'literal-value-made-a-var' } }
      const servers = launchServers({ combwork: tools }, new Set(), base)
      const ctx = { executable: MUSE, resume: !!opts.resume, sessionId: opts.resume ?? '', model: undefined, effort: undefined, permissionMode: '', extraArgs: ['--provider', 'echo', '--disable-sandbox', '-c', 'telemetry.enabled=false'], initialPrompt: opts.prompt } as unknown as MuseArgsInput['ctx']
      const args = museArgs({ ctx, hooks: museHooks(hookUrl, ap, gp, 10), servers: servers.pass, keepPersonalOut: true })
      const env = { ...museEnv(base, home, true), ...servers.vars }
      // `exec --session-id <id>` before the prompt: a resumed session given a prompt, headless.
      const shaped = opts.exec ? ['exec', ...(opts.sessionId ? insertBefore(args, '--', ['--session-id', opts.sessionId]) : args)] : args
      return { ...(await run(shaped, proj, env, name)), args: shaped, env }
    }
    const insertBefore = (args: string[], mark: string, add: string[]): string[] => {
      const i = args.indexOf(mark)
      return i < 0 ? [...args, ...add] : [...args.slice(0, i), ...add, ...args.slice(i)]
    }
    const sessionFile = (id: string): string | undefined => walk(path.join(home, 'muse', 'sessions')).find((f) => f.endsWith(path.join(id, 'session.jsonl')))

    // 1. A new session: Combwork's launch shape, its hooks through cmd, its guidance, its tools and its skill.
    const GUIDE = 'MUSE-REAL-GUIDANCE-MARKER call cw_inbox first. héllo — ünïcode ✓\n'
    const a = await launch('new', GUIDE, { prompt: 'hello from the sandbox', exec: true })
    if (DRY) return
    check("exec runs Combwork's launch to its end (exit 0)", a.code === 0, `${a.code} ${a.err.slice(-600)}`)
    check('…no token in its arguments, no account variable in its environment', !a.args.join(' ').includes('sandbox-token') && !('META_API_KEY' in a.env))
    const seen = hookLog.map((h) => h.body.hook_event_name)
    check('…its hooks reach the hook server through cmd (SessionStart, UserPromptSubmit, Stop)', ['SessionStart', 'UserPromptSubmit', 'Stop'].every((e) => seen.includes(e)), seen.join(', '))
    check("…each with the launch's token from its auth file and the URL's query intact", hookLog.length > 0 && hookLog.every((h) => h.auth === 'Bearer sandbox-token' && h.url === '/hooks/muse?agent=a1&launch=L1'), JSON.stringify(hookLog.map((h) => [h.auth, h.url])))
    const sid = String(hookLog.find((h) => h.body.hook_event_name === 'SessionStart')?.body.session_id ?? '')
    check('…SessionStart names the session', /^[0-9a-f]{8}-/.test(sid), sid)
    const file = sessionFile(sid)
    check('…its session log is in the test home', !!file, String(file))
    check("…Combwork's guidance is its start context, multibyte text kept", !!file && hookContext(file).includes(GUIDE.trimEnd()), JSON.stringify(file ? hookContext(file).map((t) => t.slice(0, 80)) : []))
    // The skills catalogue's text is in the model's input (exec records only a diagnostic for its block).
    const log = file ? fs.readFileSync(file, 'utf8') : ''
    check('…the skill Combwork delivers is offered as a project skill', log.includes('<skill id=\\"cw-muse-probe\\" scope=\\"project\\" path=\\".agents/skills/cw-muse-probe/SKILL.md\\">'), String(log.match(/<skill id=\\"cw-[^>]*>/)?.[0]))
    const mcpLog = fs.existsSync(path.join(OUT, 'new-mcp.log')) ? fs.readFileSync(path.join(OUT, 'new-mcp.log'), 'utf8') : ''
    check("…Combwork's tools server starts with its literal env passed as a ${VAR} Muse resolves, and is listed", /started CW_PROBE=literal-value-made-a-var/.test(mcpLog) && /<- tools\/list/.test(mcpLog), mcpLog.slice(0, 600))
    check('…the echo reply', /echo: hello from the sandbox/.test(a.out), a.out.slice(-400))

    // 2. Resumed as Combwork resumes it (`resume <id>`, no prompt): no hook before a prompt, its input box drawn, which
    // muse.ready.input must find (Combwork then types the resume's prompt). Ended after RUN_MS: nothing typed.
    if (sid) {
      const before = hookLog.length
      const r = await launch('resume', GUIDE, { resume: sid })
      const ready = ADVANCED.find((d) => d.id === 'muse.ready.input')
      const pattern = ready && 'default' in ready ? new RegExp(String(ready.default)) : null
      const screen = r.out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\s+/g, ' ')
      check('resume <id> resumes that session and runs no hook before a prompt', screen.includes(`resumed session ${sid}`) && hookLog.length === before, `${JSON.stringify(hookLog.slice(before).map((h) => h.body.hook_event_name))} ${screen.slice(0, 300)}`)
      check('…its input box shows, as muse.ready.input reads it (Combwork takes it as ready)', !!pattern && pattern.test(screen), screen.slice(-400))
      // 3. That session given a prompt (headless, `exec --session-id`): SessionStart, then the guidance again, with it.
      const before3 = hookLog.length
      const g = await launch('resumed-prompt', GUIDE, { prompt: 'after resume', exec: true, sessionId: sid })
      const after = hookLog.slice(before3).map((h) => h.body)
      check('…given a prompt, SessionStart then UserPromptSubmit for the same session, the guidance given again', g.code === 0 && after[0]?.hook_event_name === 'SessionStart' && after[0]?.session_id === sid && after.some((b) => b.hook_event_name === 'UserPromptSubmit') && hookContext(file!).filter((t) => t === GUIDE.trimEnd()).length >= 2, `${g.code} ${JSON.stringify(after.map((b) => [b.hook_event_name, b.session_id, b.source]))}`)
    }

    // 4. The start context's limit: a guidance too long for it is a pointer to its file, kept whole.
    const long = 'MUSE-REAL-LONG ' + 'é'.repeat(10000) + '\n'
    const before4 = hookLog.length
    const c = await launch('long', long, { prompt: 'long guidance', exec: true })
    const lid = String(hookLog.slice(before4).find((h) => h.body.hook_event_name === 'SessionStart')?.body.session_id ?? '')
    const lf = sessionFile(lid)
    const lctx = lf ? hookContext(lf) : []
    check('a guidance over 16,384 bytes is a pointer to the file holding it whole, kept as start context', c.code === 0 && lctx.some((t) => t.includes(path.join(priv, 'long-guidance-full.md'))), `${c.code} ${JSON.stringify(lctx.map((t) => t.slice(0, 160)))}`)
  } finally {
    server.close()
  }
}

main()
  .catch((e) => check('the harness ran', false, String(e?.stack ?? e)))
  .finally(() => {
    const passed = checks.every((x) => x.ok)
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ cli: '1.4.20', sha256: SHA, dry: !!DRY, finished: new Date().toISOString(), passed, checks }, null, 2))
    console.log(DRY ? `dry: launches saved in ${OUT}` : passed ? 'all checks passed' : 'some checks failed')
    process.exitCode = passed || DRY ? 0 : 1
  })
