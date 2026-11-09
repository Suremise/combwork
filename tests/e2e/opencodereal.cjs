// The real OpenCode (the pinned 2.2.6) through Combwork (HI-2763), under Darren's HI-2758 option A: no account, key, sign-in
// or cloud call; model turns only to the PC's local Ollama qwen3:8b, through a logging proxy here, so every request the
// model got is on record. The pinned build (opencode-windows-x64.zip of v2.2.6, its opencode.exe's SHA-256 checked) as
// Combwork selects it, run in this test copy's own profile (its account's roots and launch config in the test data; the
// user's OpenCode folders are listed before and after). A test seam restricts what the launch config allows
// (CW_TEST_OPENCODE_PROVIDER, the Assistant's and HR1's choice on HI-2763: every provider denied but the named local
// one, the rest of the launch recipe as in production), and the suite checks that the written config holds it before it
// types anything: else it stops there. One agent, one launch: the TUI drawn in its pane, one prompt ("Reply with just:
// OK") answered there, its requests all to the proxy for qwen3:8b; stopped, no opencode of this test left and the
// machine-wide service's port as it was; started again, the same session resumed with its history. Its connection's
// effort (HI-2767) is the model's variant: low for the typed prompt (its requests carry reasoning_effort low, and the
// session's model has variant low), high on the resume (set on the session with no model request).
const lib = require('./lib.cjs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { processes } = require('./folderProcesses.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
// A real model turn on a local model: bounded, never how long it should take.
const TURN_MS = 240000

const PINNED = path.join(process.env.LOCALAPPDATA || '', 'combwork-test', 'opencode-2.2.6', 'opencode.exe')
const PINNED_SHA256 = '98cb0aa854c7c015cf6febafa7afb872c359bfe5a823a526f3b4fd347a9e9677'
const OLLAMA = { host: '127.0.0.1', port: 11434 }
const MODEL = 'qwen3:8b'
const userData = path.join(lib.WORK, 'opencodereal-profile')
const ws = path.join(lib.WORK, 'opencodereal-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Names, sizes and times under a folder (never its contents). */
function listing(dir) {
  const out = []
  const walk = (d) => {
    let names = []
    try {
      names = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of names) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else
        try {
          const s = fs.statSync(p)
          out.push(`${path.relative(dir, p)}|${s.size}|${s.mtimeMs}`)
        } catch {}
    }
  }
  walk(dir)
  return out.sort()
}
// The user's own OpenCode folders (HI-2758's snapshot list): never touched by a test.
const home = os.homedir()
const USER_PLACES = [path.join(home, '.config', 'opencode'), path.join(home, '.local', 'share', 'opencode'), path.join(home, '.local', 'state', 'opencode'), path.join(home, '.cache', 'opencode'), path.join(process.env.APPDATA || '', 'opencode'), path.join(process.env.LOCALAPPDATA || '', 'opencode'), path.join(process.env.ProgramData || 'C:\\ProgramData', 'opencode')]
const snapshot = () => USER_PLACES.map((p) => [p, listing(p)])
const changes = (before, after) => before.flatMap(([p, list], i) => {
  const now = after[i][1]
  return [...now.filter((x) => !list.includes(x)).map((x) => `+ ${path.join(p, x.split('|')[0])}`), ...list.filter((x) => !now.includes(x)).map((x) => `- ${path.join(p, x.split('|')[0])}`)]
})
const portOpen = (port) => new Promise((resolve) => {
  const s = require('net').connect(port, '127.0.0.1')
  s.on('connect', () => (s.destroy(), resolve(true)))
  s.on('error', () => resolve(false))
})
/** The local Ollama's models, or null when it doesn't answer. */
const ollamaModels = () => new Promise((resolve) => {
  const req = http.get({ ...OLLAMA, path: '/api/tags', timeout: 5000 }, (res) => {
    let b = ''
    res.on('data', (d) => (b += d))
    res.on('end', () => {
      try {
        resolve(JSON.parse(b).models.map((m) => m.name))
      } catch {
        resolve(null)
      }
    })
  })
  req.on('error', () => resolve(null))
  req.on('timeout', () => (req.destroy(), resolve(null)))
})
// The run's evidence (HR1 on HI-2763 round 1): the lifecycle's phases, the restriction the launch config held, and each
// request the model got (sanitized: its method, path, model, the upstream it went to and its answer's status, never a
// prompt or a header). Written to the suite's log at the end, and to TRACE (kept with --keep-files).
const TRACE = path.join(lib.WORK, 'opencodereal-trace.json')
const trace = { build: { path: PINNED, sha256: PINNED_SHA256 }, upstream: `${OLLAMA.host}:${OLLAMA.port}`, restriction: null, phases: [], requests: [] }
let phase = 'launch'
const enter = (name) => {
  phase = name
  trace.phases.push({ at: new Date().toISOString(), phase: name })
}

/** A logging proxy to the local Ollama: each request's method, path and model kept (HI-2758's proxy.cjs), in `trace`. */
function proxy() {
  const seen = trace.requests
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      let model = null
      let effort = null
      try {
        const j = JSON.parse(body.toString('utf8'))
        model = j.model ?? null
        effort = j.reasoning_effort ?? null
      } catch {}
      const entry = { at: new Date().toISOString(), phase, method: req.method, path: req.url, model, reasoning_effort: effort, upstream: trace.upstream, status: null }
      seen.push(entry)
      const headers = { ...req.headers, host: `${OLLAMA.host}:${OLLAMA.port}` }
      delete headers.authorization
      const up = http.request({ ...OLLAMA, method: req.method, path: req.url, headers }, (ur) => {
        entry.status = ur.statusCode
        res.writeHead(ur.statusCode, ur.headers)
        ur.pipe(res)
      })
      up.on('error', (e) => {
        entry.status = 502
        res.writeHead(502)
        res.end(String(e))
      })
      up.end(body)
    })
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, seen, close: () => new Promise((c) => (srv.closeAllConnections?.(), srv.close(c))) })))
}

;(async () => {
  // --- What it needs: the pinned build, and the local Ollama with its model.
  if (!fs.existsSync(PINNED) || crypto.createHash('sha256').update(fs.readFileSync(PINNED)).digest('hex') !== PINNED_SHA256) {
    console.log(`SKIP environment: the pinned OpenCode 2.2.6 isn't at ${PINNED}, or isn't the release's build (tests/e2e/README.md)`)
    process.exit(0)
  }
  const models = await ollamaModels()
  if (!models?.includes(MODEL)) {
    console.log(`SKIP environment: no local Ollama with ${MODEL} at ${OLLAMA.host}:${OLLAMA.port} (${models ? models.join(', ') || 'no models' : 'not answering'}): Darren pulls it by hand`)
    process.exit(0)
  }
  const before = snapshot()
  const serviceBefore = await portOpen(28894)
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'README.md': '# alpha\n' })
  lib.enableProviders(userData, ['claude-code', 'opencode'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.opencode = { ...cfg.settings.providers.opencode, executablePath: PINNED }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const px = await proxy()
  const seam = { id: 'cwtest', baseURL: `http://127.0.0.1:${px.port}/v1`, model: MODEL }
  const { app, inv, page } = await lib.launch({ userData, env: { CW_API_PORT: lib.port(47905), CW_TEST_OPENCODE_PROVIDER: JSON.stringify(seam), CW_TEST_CLI_HOME_CONNECTION: '0' } })
  // This test's opencode processes: the pinned build's (no other suite or agent runs it).
  const opencodeLeft = () => processes().filter((p) => String(p.commandLine ?? '').toLowerCase().includes(PINNED.toLowerCase()))
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    const { until } = lib
    const live = async (id) => (await inv('session:live')).find((s) => s.agentId === id && s.status !== 'stopped') ?? null

    // --- The pinned build as Combwork selects it.
    const info = await until(async () => {
      const i = (await inv('provider:refresh', 'opencode'))?.opencode
      return i?.found ? i : null
    }, HUNG_MS)
    check('the pinned OpenCode is selected, its version read', !!info && path.resolve(info.path).toLowerCase() === PINNED.toLowerCase() && info.version === '2.2.6', JSON.stringify(info && { path: info.path, version: info.version }))

    // --- One agent on an OpenCode account.
    const account = await inv('connections:add', 'opencode', 'OpenCode · Local test')
    await inv('connections:setOn', account.id, true)
    const agent = await lib.addAgent(inv, alpha, { name: 'Oc', provider: 'opencode' })
    const conn = (await inv('connections:list')).connectionRows.find((c) => c.account === account.id) ?? (await inv('connection:add', account.id, { name: 'Test · OpenCode' }))
    await inv('agents:update', alpha, agent.id, { connection: conn.id })
    const accountHome = path.join(userData, 'accounts', account.id)
    // Its effort (HI-2767): low, a variant 2.2.6 lists for the test provider's model, as the catalogue read it.
    const variants = await until(async () => (await inv('provider:refresh', 'opencode'))?.opencode?.catalog?.models?.find((m) => m.value === `${seam.id}/${MODEL}`)?.efforts ?? null, HUNG_MS)
    check("the catalogue has the test model's variants from 2.2.6 (low, medium, high)", JSON.stringify(variants) === '["low","medium","high"]', JSON.stringify(variants))
    await lib.setLaunch(inv, alpha, agent.id, { model: `${seam.id}/${MODEL}`, effort: 'low' })
    /** The session's model as Combwork's record of it has it (its mirror of the server's session). */
    const recordedModel = (sid) => {
      const f = path.join(accountHome, 'combwork-sessions', `${sid}.jsonl`)
      if (!sid || !fs.existsSync(f)) return null
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        try {
          const x = JSON.parse(l)
          if (x.type === 'combwork.session') return x.info?.model ?? null
        } catch {}
      }
      return null
    }
    enter('launch')
    await inv('session:start', alpha, { agentId: agent.id })

    // --- The written launch config holds the seam's restriction, or nothing is typed (option A: no cloud call).
    const launchConfig = await until(async () => {
      const root = path.join(userData, 'launches')
      const files = fs.existsSync(root) ? fs.readdirSync(root).map((d) => path.join(root, d, 'opencode-config', 'opencode.json')).filter((f) => fs.existsSync(f)) : []
      return files.length ? JSON.parse(fs.readFileSync(files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0], 'utf8')) : null
    }, HUNG_MS)
    const policies = launchConfig?.policies ?? []
    const providerRules = policies.filter((p) => p.action === 'provider.use')
    trace.restriction = launchConfig && { providers: Object.fromEntries(Object.entries(launchConfig.providers ?? {}).map(([id, p]) => [id, { baseURL: p?.settings?.baseURL ?? null, models: Object.keys(p?.models ?? {}) }])), model: launchConfig.model ?? null, providerPolicies: providerRules, discoverySwitchesInConfig: 'env (OPENCODE_DISABLE_PROJECT_CONFIG, OPENCODE_DISABLE_CLAUDE_CODE): unchanged by the seam' }
    const held = providerRules[0]?.resource === '*' && providerRules[0]?.effect === 'deny' && providerRules.filter((p) => p.effect === 'allow').every((p) => p.resource === seam.id) && Object.keys(launchConfig?.providers ?? {}).join() === seam.id && launchConfig?.model === `${seam.id}/${MODEL}`
    check('the launch config denies every provider but the local test one, its model that one', held, JSON.stringify({ providers: Object.keys(launchConfig?.providers ?? {}), model: launchConfig?.model, providerRules }))
    if (!held) {
      console.log('FAIL stopped before any prompt: the launch config would let OpenCode reach other providers (option A)')
      failed++
      return
    }
    const key = lib.ptyKey(alpha, agent.id)
    const screen = async () => lib.plainText((await inv('pty:buffer', key).catch(() => '')) ?? '')
    // 2.2.6's screen: its footer (`ctrl+p commands`, as R0's tui/session-absent-server.json) and the agent's model by name.
    check("its TUI is drawn in the pane, on the test provider's model", !!(await until(async () => (/ctrl\+p commands/.test(await screen()) && /qwen3:8b Combwork test/.test(await screen()) ? true : null), HUNG_MS)), (await screen()).slice(-400))
    check('…and the machine-wide service never started', (await portOpen(28894)) === serviceBefore)

    // --- One prompt, answered in the pane; every request to the proxy, for the local model.
    const prompt = 'Reply with just: OK'
    enter('prompt')
    const taken = await lib.sendPrompt(inv, key, prompt, { submitted: async () => px.seen.length > 0, tries: 1, waitMs: HUNG_MS })
    check('the prompt reaches the model, through the proxy', taken > 0 && px.seen.length > 0, JSON.stringify(px.seen))
    const answered = await until(async () => {
      const s = await screen()
      const after = s.slice(s.lastIndexOf(prompt) + prompt.length)
      return /\bOK\b/.test(after) ? s : null
    }, TURN_MS)
    check('…its reply is shown in the pane', !!answered, (await screen()).slice(-600))
    check(`…every model request went to the local proxy for ${MODEL}`, px.seen.length > 0 && px.seen.every((r) => r.path.startsWith('/v1/') && (r.model === null || r.model === MODEL)), JSON.stringify(px.seen))
    const asked = px.seen.filter((r) => r.phase === 'prompt' && r.reasoning_effort !== null)
    check('…the typed prompt\'s requests carry its effort: reasoning_effort low (HI-2767)', asked.length > 0 && asked.every((r) => r.reasoning_effort === 'low'), JSON.stringify(px.seen.map((r) => [r.phase, r.reasoning_effort])))
    const sessionFiles = fs.existsSync(path.join(accountHome, 'combwork-sessions')) ? fs.readdirSync(path.join(accountHome, 'combwork-sessions')) : []
    const sessionId = sessionFiles.map((f) => f.replace(/\.json$/, '')).find((f) => f.startsWith('ses_')) ?? null
    check("…its session recorded in the account (Combwork picked its id)", !!sessionId, JSON.stringify(sessionFiles))

    // --- Stopped: nothing of this test left running.
    enter('stop')
    await inv('session:stop', alpha, agent.id)
    check('it stops', !!(await until(async () => !(await live(agent.id)), HUNG_MS)))
    const low = await until(async () => recordedModel(sessionId)?.variant ?? null, HUNG_MS)
    check("…its session's model as Combwork recorded it: the test model, variant low", low === 'low' && recordedModel(sessionId)?.id === MODEL, JSON.stringify(recordedModel(sessionId)))
    check('…and no opencode of this test is left running', !!(await until(async () => (opencodeLeft().length ? null : true), HUNG_MS)), JSON.stringify(opencodeLeft().map((p) => p.pid)))

    // --- Started again: the same session, its history in the pane.
    const requests = px.seen.length
    await lib.setLaunch(inv, alpha, agent.id, { model: `${seam.id}/${MODEL}`, effort: 'high' })
    enter('resume')
    await inv('session:start', alpha, { agentId: agent.id, resumeId: sessionId })
    check('started again, the session is resumed with its history', !!(await until(async () => ((await screen()).includes(prompt) ? true : null), HUNG_MS)), (await screen()).slice(-600))
    check('…with no model request of its own', px.seen.length === requests, JSON.stringify(px.seen.slice(requests)))
    enter('stop again')
    await inv('session:stop', alpha, agent.id)
    await until(async () => !(await live(agent.id)), HUNG_MS)
    check('…and stopped again, none left running', !!(await until(async () => (opencodeLeft().length ? null : true), HUNG_MS)))
    const high = await until(async () => (recordedModel(sessionId)?.variant === 'high' ? 'high' : null), HUNG_MS)
    check('…its effort changed to high meanwhile, set on the resumed session with no model request (HI-2767)', high === 'high' && px.seen.length === requests, JSON.stringify({ model: recordedModel(sessionId), requests: px.seen.slice(requests) }))
  } finally {
    enter('closed')
    await app.close().catch(() => undefined)
    await px.close()
    // The evidence, whatever happened: in the log (always kept with the run) and in TRACE.
    fs.writeFileSync(TRACE, JSON.stringify(trace, null, 2))
    console.log(`TRACE (also ${TRACE}):\n${JSON.stringify(trace, null, 2)}`)
  }
  const diff = changes(before, snapshot())
  check("the user's own OpenCode folders are as they were, and the machine-wide service's port too", diff.length === 0 && (await portOpen(28894)) === serviceBefore, diff.slice(0, 8).join('; '))
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
