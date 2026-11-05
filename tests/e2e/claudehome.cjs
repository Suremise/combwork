// Combwork's hooks with the real Claude Code, in a Claude Code home of the suite's own (#345): never the user's sign-in or
// config. The home is new each run, under the suite's folder, with first-run onboarding done and a made-up API key
// approved (Claude Code's own fields in its .claude.json), so Claude Code starts at its prompt with no sign-in, and the
// key is never used: no prompt is sent, so nothing reaches Anthropic and no tokens are spent. Checks: SessionStart (a
// command hook, curl reading its header from the launch's auth file) and the status line (the same) reach Combwork; the
// launch's settings, MCP config and auth file are in its private folder in Combwork's user data and no project file holds
// the token; when the session ends, the folder goes and its token is refused.
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { randomBytes } = require('crypto')
const lib = require('./lib.cjs')

const userData = path.join(lib.WORK, 'claudehome-profile')
// Outside the repository, so its CLAUDE.md doesn't apply to the test session (#174).
const ws = path.join(lib.WORK, 'claudehome-ws')
const proj = path.join(ws, 'demo')
const home = path.join(lib.WORK, 'claudehome-claude-home')
// Made up: shaped like an API key, valid for nothing.
const apiKey = `sk-ant-api03-cwtest-${randomBytes(24).toString('hex')}`
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Every file under a folder whose content holds `text`. */
function filesHolding(dir, text) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...filesHolding(p, text))
    else if (e.isFile() && fs.readFileSync(p, 'utf8').includes(text)) out.push(p)
  }
  return out
}

;(async () => {
  for (const d of [userData, ws, home]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(proj, { 'README.md': '# Demo\n' })
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] } }))
  // Said in the log, so the run shows which Claude Code home the session used.
  console.log(`Claude Code home: ${home} (CLAUDE_CONFIG_DIR, the suite's own; a made-up API key, no sign-in)`)
  lib.enableProviders(userData)
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47889), CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: apiKey })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  check("the test Combwork's sessions get the suite's own home", (await app.evaluate(() => process.env.CLAUDE_CONFIG_DIR)) === home)
  const cli = (await inv('provider:info'))['claude-code']
  console.log(`(the real Claude Code: ${cli?.path} ${cli?.version})`)
  check('the real Claude Code runs, not the fake', !!cli?.path && !/fake-claude/i.test(cli.path), cli?.path)
  const agent = await lib.addAgent(inv, proj, { model: 'haiku' })
  const key = lib.ptyKey(proj, agent.id)
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === agent.id)

  await inv('session:start', proj, { agentId: agent.id })
  await lib.cliStep('SessionStart reaches Combwork', { session: key }, async () => {
    await lib.acceptClaudeTrust(inv, proj, agent.id, 30000)
    // Claude Code has no ready output Combwork reads: only its SessionStart hook makes the agent ready.
    const ok = !!(await lib.until(async () => (await live())?.status === 'ready', 60000, 400))
    check('SessionStart, a curl command reading its header from the auth file, reached Combwork (the agent is ready)', ok, `${(await live())?.status}: ${lib.plainText(await inv('pty:buffer', key).catch(() => '')).slice(-300)}`)
  })
  const run = (await live())?.runId
  const dir = run ? lib.launchDir(userData, run) : ''
  const settingsFile = path.join(dir, 'settings.json')
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : null
  const authFile = path.join(dir, 'hook-auth.txt')
  const token = fs.existsSync(authFile) ? /Bearer ([0-9a-f]+)/.exec(fs.readFileSync(authFile, 'utf8'))?.[1] : null
  check("its settings, MCP config and auth file are in the launch's private folder in Combwork's user data", !!settings && !!token && fs.existsSync(path.join(dir, 'mcp.json')), dir)
  check('SessionStart and the status line read the header from that file', [settings?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command, settings?.statusLine?.command].every((c) => typeof c === 'string' && c.includes(`-H "@${authFile.split('\\').join('/')}"`) && !c.includes('Bearer')), JSON.stringify(settings?.statusLine))
  check("no file in the project holds the session's token", !!token && filesHolding(proj, token).length === 0, token ? filesHolding(proj, token).join(', ') : 'no token')

  await lib.cliStep('the status line reaches Combwork', { session: key }, async () => {
    // The status line runs as Claude Code draws its prompt, before any request: Combwork learns the model (and the context
    // window) from it alone here, since no turn has written a transcript.
    // The context window comes only from the status line (a transcript doesn't carry it).
    const ok = await lib.until(async () => !!(await live())?.modelName && !!(await live())?.contextWindow, 30000, 500)
    const l = await live()
    // No turn yet: what Combwork knows of the model came from the status line. Claude Code may already have written a
    // transcript of its startup (the SessionStart hook's result, the title, the mode: no model), sooner or later than
    // the status line runs (#477), so the check is that no transcript holds a reply, not that there is no file.
    const projects = path.join(home, 'projects')
    const transcripts = fs.existsSync(projects) ? fs.readdirSync(projects, { recursive: true }).filter((f) => String(f).endsWith('.jsonl')) : []
    const turns = transcripts.filter((f) => fs.readFileSync(path.join(projects, f), 'utf8').split('\n').some((line) => /"type":"assistant"|"model":/.test(line)))
    check('the status line, the same curl command, reached Combwork (the model it reports, with no turn in a transcript yet)', !!ok && turns.length === 0, JSON.stringify({ model: l?.modelName, contextWindow: l?.contextWindow, transcripts, turns }))
    console.log(`(reported by the status line: ${JSON.stringify({ model: l?.modelName, modelId: l?.modelId, contextWindow: l?.contextWindow, effort: l?.effort })}; transcripts of the startup so far: ${transcripts.length})`)
  })

  // The session ends: its private folder goes, and its token is refused.
  const hook = run ? lib.launchHook(userData, run) : null
  await inv('session:stop', proj, agent.id)
  await lib.until(async () => !(await live()), 20000)
  check("the launch's private folder goes when it ends", !!(await lib.until(() => !fs.existsSync(dir), 5000)), dir)
  const status = hook ? (await fetch(hook.url, { method: 'POST', headers: { Authorization: `Bearer ${hook.token}`, 'Content-Type': 'application/json' }, body: '{"hook_event_name":"Notification"}' })).status : 0
  check("the ended session's token is refused", status === 401, String(status))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
