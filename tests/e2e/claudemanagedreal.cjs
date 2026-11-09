// The admin snippet's transport on the real Claude Code (HI-2777), no inference: a stub server of the suite's own stands
// for Combwork and answers UserPromptSubmit with a block, so Claude Code stops before any model call. Combwork's hook
// handlers (built from src/shared/claudeHookHandlers.ts, the generator Combwork's launch hooks and the snippet both come
// from; tests/claudeManagedHooks.test.ts holds the adapter's to it) go in two settings scopes: the project's
// .claude/settings.json and a --settings file. It shows, with the real CLI:
// 1. identical handlers in two files run once (Claude Code's own dedup): one SessionStart, one UserPromptSubmit;
// 2. the SessionStart command (encoded PowerShell, through the shell Claude Code picks) forwards stdin byte for byte
//    (non-ASCII prompt and folder) with the header from the auth file, a Unicode path;
// 3. the HTTP hook carries $CW_HOOK_TOKEN from the environment to the fixed URL;
// 4. a hook timeout changed in one file: the handlers differ, so both run (two of each, Combwork's fallback's case);
// 5. a session without Combwork's variables: the SessionStart command sends nothing.
// It proves nothing about how an organisation's remote settings rank. Runs in the Claude Code test home
// (CLAUDE_TEST_HOME, claudeHome: 'test'); the status line isn't covered (claude -p has none: claudeManagedHooks.test.ts
// runs that command through both shells).
const lib = require('./lib.cjs')
const { CLAUDE_TEST_HOME } = require('./runContext.cjs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 90000

const work = path.join(lib.WORK, 'claudemanagedreal')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  const exe = [path.join(os.homedir(), '.local', 'bin', 'claude.exe')].find((f) => fs.existsSync(f)) ?? 'claude'
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  // The generator, from the source of this revision.
  const gen = path.join(work, 'claudeHookHandlers.cjs')
  require('esbuild').buildSync({ entryPoints: [path.join(lib.ROOT, 'src', 'shared', 'claudeHookHandlers.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: gen, logLevel: 'warning' })
  const { claudeHookHandlers, fixedHookUrl } = require(gen)

  // The stub: records each call; blocks the prompt, so no inference.
  const got = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let event = '?'
      try {
        event = JSON.parse(body).hook_event_name
      } catch {
        // not JSON: recorded as it came
      }
      got.push({ url: req.url, auth: req.headers.authorization ?? '', event, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(event === 'UserPromptSubmit' ? JSON.stringify({ decision: 'block', reason: 'claudemanagedreal: blocked before inference' }) : '{}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const auth = path.join(work, 'Jöhn Dœ 日本', 'hook-auth.txt')
    fs.mkdirSync(path.dirname(auth), { recursive: true })
    fs.writeFileSync(auth, 'Authorization: Bearer synthetic-claudemanagedreal\n')
    const project = path.join(work, 'projét 日本')
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true })
    const T = { hook: 5, preToolUse: 10 }
    const settingsFile = path.join(work, 'launch-settings.json')
    const prompt = 'probe ünï 日本: reply with nothing'
    /** One claude -p run with these handlers in the project's settings and the --settings file; what the stub got. */
    const runOnce = async (projectHooks, cliHooks, env) => {
      got.length = 0
      fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: projectHooks }))
      fs.writeFileSync(settingsFile, JSON.stringify({ hooks: cliHooks }))
      const child = spawn(exe, ['-p', prompt, '--settings', settingsFile, '--setting-sources', 'project'], { cwd: project, env: lib.childEnv({ CLAUDE_CONFIG_DIR: CLAUDE_TEST_HOME, ...env }), windowsHide: true })
      let out = ''
      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (out += c))
      const code = await new Promise((resolve) => {
        const t = setTimeout(() => child.kill(), HUNG_MS)
        child.on('close', (c) => {
          clearTimeout(t)
          resolve(c)
        })
      })
      return { code, out, calls: [...got] }
    }
    const env = { CW_HOOK_TOKEN: 'synthetic-claudemanagedreal', CW_HOOK_URL: fixedHookUrl(port), CW_HOOK_AUTH_FILE: auth }
    const count = (calls, ev) => calls.filter((c) => c.event === ev).length
    const handlers = claudeHookHandlers([fixedHookUrl(port)], T)

    // ---- 1–3: identical handlers in two scopes.
    const a = await runOnce(handlers, handlers, env)
    check('1: the prompt is blocked before inference', /blocked before inference/.test(a.out) || count(a.calls, 'Stop') === 0, a.out.slice(-400))
    check('1: identical handlers in two files run once (one SessionStart, one UserPromptSubmit)', count(a.calls, 'SessionStart') === 1 && count(a.calls, 'UserPromptSubmit') === 1, JSON.stringify(a.calls.map((c) => c.event)))
    const start = a.calls.find((c) => c.event === 'SessionStart')
    check('2: SessionStart came through the encoded command, its header from the auth file in a Unicode folder', start?.auth === 'Bearer synthetic-claudemanagedreal' && start?.url === '/hook', JSON.stringify(start && { url: start.url, auth: start.auth }))
    check("2: …its JSON byte for byte (the project's non-ASCII folder)", !!start && JSON.parse(start.body).cwd === project, start?.body?.slice(0, 300))
    const ups = a.calls.find((c) => c.event === 'UserPromptSubmit')
    check('3: the HTTP hook carried $CW_HOOK_TOKEN to the fixed URL, with the prompt intact', ups?.auth === 'Bearer synthetic-claudemanagedreal' && ups?.url === '/hook' && JSON.parse(ups.body).prompt === prompt, JSON.stringify(ups && { url: ups.url, auth: ups.auth }))

    // ---- 4: a timeout changed in one file: both run.
    const b = await runOnce(handlers, claudeHookHandlers([fixedHookUrl(port)], { hook: 7, preToolUse: 10 }), env)
    check('4: differing handlers both run (two SessionStarts, two UserPromptSubmits)', count(b.calls, 'SessionStart') === 2 && count(b.calls, 'UserPromptSubmit') === 2, JSON.stringify(b.calls.map((c) => c.event)))

    // ---- 5: no Combwork variables: SessionStart's command sends nothing (HTTP hooks still post, with no token).
    const c = await runOnce(handlers, handlers, { CW_HOOK_TOKEN: '', CW_HOOK_URL: '', CW_HOOK_AUTH_FILE: '' })
    check("5: without Combwork's variables the SessionStart command sends nothing", count(c.calls, 'SessionStart') === 0, JSON.stringify(c.calls.map((x) => x.event)))
    check('5: …and the HTTP hook carries no token', c.calls.filter((x) => x.event === 'UserPromptSubmit').every((x) => x.auth.trim() === 'Bearer' || x.auth === ''), JSON.stringify(c.calls.map((x) => x.auth)))
  } catch (e) {
    check('the suite ran to its end', false, e?.stack ?? String(e))
  } finally {
    server.close()
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
})()
