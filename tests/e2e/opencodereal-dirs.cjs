// The real OpenCode (the pinned 2.2.6) and folders outside its own (HI-2772, #1439), through Combwork's production launch,
// under Darren's HI-2758 option A as opencodereal.cjs: no account, key, sign-in or cloud call; model turns only to the PC's
// local Ollama qwen3:8b through a logging proxy here; the project's own OpenCode config kept out (the default). Combwork's
// launch config asks external_directory for every folder outside the agent's own and allows a reviewer's review copies
// (HI-2775: 2.2.6's default rules, `* * allow` first, would let any agent reach any folder). Three agents, each in its own
// fresh session: a reviewer in Build reads a marker file in the copies folder (proved by its session record's read result
// for that turn) and writes a new file there (its bytes on disk), unasked; a reviewer in Plan, asked to write there,
// doesn't (its own edit deny: the file absent, and what it tried, from its record); a builder in Build, lent no copy, is
// asked for the copies folder (shown as waiting for the user, OpenCode's external_directory) and, rejected, writes nothing
// there. Any permission asked is recorded and rejected (Esc, 2.2.6's escapeKey), never approved. A turn is one by its own id (the
// turn ledger's) reaching its end; each attempt has its own files and marker, and a tool's result counts once the record
// has it ended for that turn. A step the model never tries in three prompts makes the run SKIPPED (inconclusive), not a
// pass (opencodeDirsProbe.cjs). The evidence goes to the suite's log and TRACE (scrubbed into
// tests/fixtures/opencode/real-2.2.6/probes/external-directory.json).
const lib = require('./lib.cjs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { processes } = require('./folderProcesses.cjs')
const { recordOf, readOf, writeOf, turnTools, ending } = require('./opencodeDirsProbe.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
// A real model turn on a local model: bounded, never how long it should take.
const TURN_MS = 240000
const TRIES = 3

const PINNED = path.join(process.env.LOCALAPPDATA || '', 'combwork-test', 'opencode-2.2.6', 'opencode.exe')
const PINNED_SHA256 = '98cb0aa854c7c015cf6febafa7afb872c359bfe5a823a526f3b4fd347a9e9677'
const OLLAMA = { host: '127.0.0.1', port: 11434 }
const MODEL = 'qwen3:8b'
const userData = path.join(lib.WORK, 'opencodedirs-profile')
const ws = path.join(lib.WORK, 'opencodedirs-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
// The steps the model never tried in its prompts: any makes the run SKIPPED, not passed (opencodeDirsProbe.cjs ending).
const inconclusive = []
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

// The user's own OpenCode folders (HI-2758's snapshot list, as opencodereal.cjs): never touched by a test.
const home = os.homedir()
const USER_PLACES = [path.join(home, '.config', 'opencode'), path.join(home, '.local', 'share', 'opencode'), path.join(home, '.local', 'state', 'opencode'), path.join(home, '.cache', 'opencode'), path.join(process.env.APPDATA || '', 'opencode'), path.join(process.env.LOCALAPPDATA || '', 'opencode'), path.join(process.env.ProgramData || 'C:\\ProgramData', 'opencode')]
const listing = (dir) => {
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
const snapshot = () => USER_PLACES.map((p) => [p, listing(p)])
const changes = (before, after) => before.flatMap(([p, list], i) => [...after[i][1].filter((x) => !list.includes(x)).map((x) => `+ ${path.join(p, x.split('|')[0])}`), ...list.filter((x) => !after[i][1].includes(x)).map((x) => `- ${path.join(p, x.split('|')[0])}`)])
const portOpen = (port) => new Promise((resolve) => {
  const s = require('net').connect(port, '127.0.0.1')
  s.on('connect', () => (s.destroy(), resolve(true)))
  s.on('error', () => resolve(false))
})
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

const TRACE = path.join(lib.WORK, 'opencodedirs-trace.json')
const trace = { build: { path: PINNED, sha256: PINNED_SHA256, version: null }, upstream: `${OLLAMA.host}:${OLLAMA.port}`, copies: null, launches: {}, asks: [], turns: [], results: {}, phases: [], requests: [] }
let phase = 'launch'
const enter = (name) => {
  phase = name
  trace.phases.push({ at: new Date().toISOString(), phase: name })
}
/** A logging proxy to the local Ollama (as opencodereal.cjs): each request's method, path, model and status, never a prompt. */
function proxy() {
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      let model = null
      try {
        model = JSON.parse(body.toString('utf8')).model ?? null
      } catch {}
      const entry = { at: new Date().toISOString(), phase, method: req.method, path: req.url, model, status: null }
      trace.requests.push(entry)
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
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => new Promise((c) => (srv.closeAllConnections?.(), srv.close(c))) })))
}


;(async () => {
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
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
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
  const opencodeLeft = () => processes().filter((p) => String(p.commandLine ?? '').toLowerCase().includes(PINNED.toLowerCase()))
  const fwd = (p) => p.replace(/\\/g, '/')
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    const { until } = lib
    const live = async (id) => (await inv('session:live')).find((s) => s.agentId === id && s.status !== 'stopped') ?? null

    const info = await until(async () => {
      const i = (await inv('provider:refresh', 'opencode'))?.opencode
      return i?.found ? i : null
    }, HUNG_MS)
    trace.build.version = info?.version ?? null
    check('the pinned OpenCode is selected, its version read', !!info && path.resolve(info.path).toLowerCase() === PINNED.toLowerCase() && info.version === '2.2.6', JSON.stringify(info && { path: info.path, version: info.version }))

    const account = await inv('connections:add', 'opencode', 'OpenCode · Local test')
    await inv('connections:setOn', account.id, true)
    const accountHome = path.join(userData, 'accounts', account.id)
    const conn = (await inv('connections:list')).connectionRows.find((c) => c.account === account.id) ?? (await inv('connection:add', account.id, { name: 'Test · OpenCode' }))
    const agents = {
      build: await lib.addAgent(inv, alpha, { name: 'Rb', provider: 'opencode', workflowRole: 'reviewer' }),
      plan: await lib.addAgent(inv, alpha, { name: 'Rp', provider: 'opencode', workflowRole: 'reviewer' }),
      builder: await lib.addAgent(inv, alpha, { name: 'Bd', provider: 'opencode', workflowRole: 'builder' })
    }
    for (const a of Object.values(agents)) await inv('agents:update', alpha, a.id, { connection: conn.id })
    await lib.setLaunch(inv, alpha, agents.plan.id, { permissionMode: 'plan' })

    // The copies folder Combwork lends reviewers (one fixed path), a probe folder in it.
    const copies = path.join(`${ws}.worktrees`, 'alpha', 'copies')
    const probe = path.join(copies, `probe-${crypto.randomBytes(3).toString('hex')}`)
    fs.mkdirSync(probe, { recursive: true })
    trace.copies = fwd(copies)

    const launchRoot = path.join(userData, 'launches')
    const configs = () => (fs.existsSync(launchRoot) ? fs.readdirSync(launchRoot).map((d) => path.join(launchRoot, d, 'opencode-config', 'opencode.json')).filter((f) => fs.existsSync(f)) : [])
    const sessionsMade = () => (fs.existsSync(path.join(accountHome, 'combwork-sessions')) ? fs.readdirSync(path.join(accountHome, 'combwork-sessions')).filter((f) => /^ses_\w+\.json$/.test(f)) : [])
    /** Starts an agent in a new session: its written config (the seam's restriction checked) and its session's id. */
    const start = async (label, agent) => {
      const knownCfg = new Set(configs())
      const knownSes = new Set(sessionsMade())
      enter(`${label}: launch`)
      await inv('session:start', alpha, { agentId: agent.id })
      const file = await until(async () => configs().find((f) => !knownCfg.has(f)) ?? null, HUNG_MS)
      const written = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
      const providerRules = (written?.policies ?? []).filter((p) => p.action === 'provider.use')
      const held = providerRules[0]?.resource === '*' && providerRules[0]?.effect === 'deny' && providerRules.filter((p) => p.effect === 'allow').every((p) => p.resource === seam.id) && written?.model === `${seam.id}/${MODEL}`
      trace.launches[label] = { defaultAgent: written?.default_agent ?? null, permissions: written?.permissions ?? null, providerPolicies: providerRules }
      check(`${label}: the launch config denies every provider but the local test one`, held, JSON.stringify(trace.launches[label]))
      // HI-2775: ask for every outside folder first, then the grants; the copies among them for a reviewer only.
      const rules = written?.permissions ?? []
      const copiesRule = rules.some((r) => r.action === 'external_directory' && r.effect === 'allow' && r.resource.toLowerCase() === `${fwd(copies)}/*`.toLowerCase())
      check(`${label}: …asks before an outside folder${agent === agents.builder ? ', the copies not allowed (no review copy)' : ', the review copies allowed'}`, rules[0]?.action === 'external_directory' && rules[0]?.resource === '*' && rules[0]?.effect === 'ask' && copiesRule === (agent !== agents.builder), JSON.stringify(rules))
      const sessionId = (await until(async () => sessionsMade().find((f) => !knownSes.has(f)) ?? null, HUNG_MS))?.replace(/\.json$/, '') ?? null
      const drawn = !!(await until(async () => (/ctrl\+p commands/.test(await screen(agent)) ? true : null), HUNG_MS))
      check(`${label}: its TUI is drawn in its pane`, drawn, (await screen(agent)).slice(-300))
      return held && drawn ? { written, sessionId } : null
    }
    const key = (agent) => lib.ptyKey(alpha, agent.id)
    const screen = async (agent) => lib.plainText((await inv('pty:buffer', key(agent)).catch(() => '')) ?? '')
    /**
     * One prompt, its own turn: done when the turn ledger names a turn other than the one before the prompt and that turn
     * is over (a fast turn needn't be seen running; an earlier turn's end can't count). Any permission it asks is
     * recorded and rejected (Esc).
     */
    const turn = async (label, agent, prompt) => {
      enter(label)
      const prior = (await live(agent.id))?.turn?.id ?? null
      const requests = trace.requests.length
      await lib.sendPrompt(inv, key(agent), prompt, { submitted: async () => trace.requests.length > requests, tries: 1, waitMs: HUNG_MS })
      const seen = new Set()
      const t = await until(async () => {
        const s = await live(agent.id)
        if (s?.status === 'waiting' && s.statusMessage && !seen.has(s.statusMessage)) {
          seen.add(s.statusMessage)
          trace.asks.push({ phase: label, message: s.statusMessage, answered: 'reject (Esc)' })
          await inv('pty:write', key(agent), '\x1b')
        }
        return s?.turn?.id && s.turn.id !== prior && s.turn.state === 'over' ? s.turn.id : null
      }, TURN_MS, 500)
      trace.turns.push({ phase: label, turn: t, prior })
      return t
    }
    /** Up to TRIES prompts, each with its own nonce (made by `attempt(n)`), until `tried(nonce)` says the model did it. */
    const attempts = async (label, agent, attempt, tried) => {
      for (let n = 1; n <= TRIES; n++) {
        const a = attempt(n)
        const t = await turn(`${label} ${n}`, agent, a.prompt)
        if (!t) {
          console.log(`INFO ${label} ${n}: no turn of its own ended within ${TURN_MS / 1000} s`)
          continue
        }
        if (await tried(a)) return a
      }
      return null
    }
    const stop = async (label, agent) => {
      enter(`${label}: stop`)
      await inv('session:stop', alpha, agent.id)
      check(`${label}: it stops`, !!(await until(async () => !(await live(agent.id)), HUNG_MS)))
    }
    /**
     * The record's tools for a nonce's turn once `ready` holds of them (the user message comes in before its tool results:
     * a tool that ended, never just the turn's start), within the bound; else what the record had.
     */
    const toolsFor = (sessionId, nonce, ready, ms = HUNG_MS) => turnTools(() => recordOf(accountHome, sessionId), nonce, ready, until, ms)
    // Each attempt waits for its own file's read or write to end (opencodeDirsProbe.cjs readOf, writeOf): another file's never counts.

    // --- 1. A reviewer in Build: reads a marker there (its record's read result), writes a new file (bytes on disk).
    const rb = await start('reviewer (Build)', agents.build)
    if (!rb) return
    check('reviewer (Build): in Build mode', rb.written.default_agent === 'build', String(rb.written.default_agent))
    const read = await attempts('reviewer (Build): read', agents.build, (n) => {
      const marker = `cw-marker-${crypto.randomBytes(4).toString('hex')}`
      const file = path.join(probe, `marker-${n}.txt`)
      fs.writeFileSync(file, `${marker}\n`)
      return { nonce: `marker-${n}.txt`, marker, file, prompt: `Use your read tool on the file ${fwd(file)} and reply with only its contents.` }
    }, async (a) => !!readOf(a.file)((await toolsFor(rb.sessionId, a.nonce, readOf(a.file))) ?? []))
    const write = await attempts('reviewer (Build): write', agents.build, (n) => {
      const marker = `cw-written-${crypto.randomBytes(4).toString('hex')}`
      const file = path.join(probe, `written-${n}.txt`)
      return { nonce: marker, marker, file, prompt: `Use your write tool to create the file ${fwd(file)} containing exactly this one line: ${marker}` }
    }, async (a) => fs.existsSync(a.file) && fs.readFileSync(a.file, 'utf8').includes(a.marker))
    await stop('reviewer (Build)', agents.build)
    // From the record as the stop left it: the read's result in the turn its prompt started.
    const readTools = read ? await toolsFor(rb.sessionId, read.nonce, readOf(read.file)) : null
    const markerRead = read ? readOf(read.file)(readTools ?? []) : null
    trace.results.read = read ? { file: path.basename(read.file), tools: readTools } : null
    if (read) check('reviewer (Build): read the marker in the copies folder, its record has the read with it for that turn, unasked', markerRead?.status === 'completed' && markerRead.result.includes(read.marker) && !trace.asks.some((a) => a.phase.startsWith('reviewer (Build): read')), JSON.stringify({ readTools, asks: trace.asks }))
    else {
      inconclusive.push("the Build reviewer's read")
      console.log(`INCONCLUSIVE reviewer (Build): no read of the marker in ${TRIES} prompts`)
    }
    trace.results.write = write ? { file: path.basename(write.file), bytes: fs.readFileSync(write.file, 'utf8'), tools: await toolsFor(rb.sessionId, write.marker, writeOf(write.file)) } : null
    if (write) check('reviewer (Build): wrote a new file in the copies folder, its bytes on disk, unasked', fs.readFileSync(write.file, 'utf8').trim() === write.marker && !trace.asks.some((a) => a.phase.startsWith('reviewer (Build): write')), JSON.stringify({ result: trace.results.write, asks: trace.asks }))
    else {
      inconclusive.push("the Build reviewer's write")
      console.log(`INCONCLUSIVE reviewer (Build): no file written in ${TRIES} prompts`)
    }

    // --- 2. A reviewer in Plan, a fresh session: asked to write there, it doesn't (its own edit deny).
    const rp = await start('reviewer (Plan)', agents.plan)
    if (!rp) return
    check('reviewer (Plan): in Plan mode', rp.written.default_agent === 'plan', String(rp.written.default_agent))
    const planFiles = []
    const planned = await attempts('reviewer (Plan): write', agents.plan, (n) => {
      const marker = `cw-plan-${crypto.randomBytes(4).toString('hex')}`
      const file = path.join(probe, `plan-${n}.txt`)
      planFiles.push(file)
      return { nonce: marker, marker, file, prompt: `Use your write tool to create the file ${fwd(file)} containing exactly this one line: ${marker}` }
    }, async (a) => !!writeOf(a.file)((await toolsFor(rp.sessionId, a.marker, writeOf(a.file))) ?? []))
    await stop('reviewer (Plan)', agents.plan)
    const planTools = planned ? await toolsFor(rp.sessionId, planned.marker, writeOf(planned.file)) : null
    trace.results.plan = { tried: planned ? planTools : null, filesWritten: planFiles.filter((f) => fs.existsSync(f)).map((f) => path.basename(f)) }
    check('reviewer (Plan): no file it was asked to write exists', planFiles.every((f) => !fs.existsSync(f)), JSON.stringify(trace.results.plan))
    if (planned) check('…its write was refused (an error result, not completed)', writeOf(planned.file)(planTools ?? [])?.status === 'error', JSON.stringify(planTools))
    else {
      inconclusive.push("the Plan reviewer's write")
      console.log(`INCONCLUSIVE reviewer (Plan): never called a write tool in ${TRIES} prompts (2.2.6's Plan may offer none): ${JSON.stringify(trace.results.plan)}`)
    }

    // --- 3. A builder in Build, lent no copy: asked for the copies folder (HI-2775), shown as waiting for the user, and,
    // rejected, writes nothing there.
    const bd = await start('builder (Build)', agents.builder)
    if (!bd) return
    const builderFiles = []
    const builderAsks = (n) => trace.asks.filter((a) => a.phase === `builder (Build): write ${n}`)
    const reached = await attempts('builder (Build): write', agents.builder, (n) => {
      const marker = `cw-builder-${crypto.randomBytes(4).toString('hex')}`
      const file = path.join(probe, `builder-${n}.txt`)
      builderFiles.push(file)
      return { n, nonce: marker, marker, file, prompt: `Use your write tool to create the file ${fwd(file)} containing exactly this one line: ${marker}` }
    }, async (a) => builderAsks(a.n).length > 0 || fs.existsSync(a.file))
    await stop('builder (Build)', agents.builder)
    trace.results.builder = { asks: reached ? builderAsks(reached.n) : [], filesWritten: builderFiles.filter((f) => fs.existsSync(f)).map((f) => path.basename(f)) }
    if (reached) {
      check('builder (Build): asked for the copies folder, waiting for the user (external_directory)', trace.results.builder.asks.some((a) => a.message.startsWith('external_directory') && a.message.toLowerCase().includes(fwd(probe).toLowerCase())), JSON.stringify(trace.results.builder))
      check('builder (Build): rejected, no file it was asked to write exists', trace.results.builder.filesWritten.length === 0, JSON.stringify(trace.results.builder))
    } else {
      inconclusive.push("the builder's write")
      console.log(`INCONCLUSIVE builder (Build): never tried to write in ${TRIES} prompts`)
    }
    check('every model request went to the local proxy for ' + MODEL, trace.requests.length > 0 && trace.requests.every((r) => r.path.startsWith('/v1/') && (r.model === null || r.model === MODEL)), JSON.stringify(trace.requests.slice(0, 5)))
    check("none of this test's opencode is left running", !!(await until(async () => (opencodeLeft().length ? null : true), HUNG_MS)), JSON.stringify(opencodeLeft().map((p) => p.pid)))
  } finally {
    enter('closed')
    await app.close().catch(() => undefined)
    await px.close()
    fs.writeFileSync(TRACE, JSON.stringify(trace, null, 2))
    console.log(`TRACE (also ${TRACE}):\n${JSON.stringify(trace, null, 2)}`)
  }
  const diff = changes(before, snapshot())
  check("the user's own OpenCode folders are as they were, and the machine-wide service's port too", diff.length === 0 && (await portOpen(28894)) === serviceBefore, diff.slice(0, 8).join('; '))
  const end = ending({ failed, inconclusive })
  console.log(end.line)
  process.exit(end.code)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
