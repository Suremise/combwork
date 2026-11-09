// The real OpenCode (the pinned 2.2.6) given a folder outside its own (HI-2772, #1439), through Combwork's production launch,
// under Darren's HI-2758 option A as opencodereal.cjs: no account, key, sign-in or cloud call; model turns only to the PC's
// local Ollama qwen3:8b through a logging proxy here; the project's own OpenCode config kept out (the default). Two agents
// in Build mode (never Approve all), each in a fresh session: a reviewer, whose launch is granted the project's review
// copies folder (its private config's external_directory rule), reads a marker file there and writes a sibling file, the
// bytes checked on disk; a builder, granted nothing, asked to overwrite a file there, is asked for external_directory,
// which is rejected (Esc, 2.2.6's escapeKey), and the file stays as it was. An ask that isn't external_directory (an edit's,
// the mode's own) is answered once (Enter) and recorded apart. A model that never tries the tool in three prompts is
// INCONCLUSIVE, not a pass. The evidence (the build, the rules each launch wrote, the asks, the files, each model request)
// goes to the suite's log and TRACE.
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
const TRIES = 3

const PINNED = path.join(process.env.LOCALAPPDATA || '', 'combwork-test', 'opencode-2.2.6', 'opencode.exe')
const PINNED_SHA256 = '98cb0aa854c7c015cf6febafa7afb872c359bfe5a823a526f3b4fd347a9e9677'
const OLLAMA = { host: '127.0.0.1', port: 11434 }
const MODEL = 'qwen3:8b'
const userData = path.join(lib.WORK, 'opencodedirs-profile')
const ws = path.join(lib.WORK, 'opencodedirs-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
let inconclusive = 0
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
const trace = { build: { path: PINNED, sha256: PINNED_SHA256, version: null }, upstream: `${OLLAMA.host}:${OLLAMA.port}`, launches: {}, asks: [], results: {}, phases: [], requests: [] }
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
    const conn = (await inv('connections:list')).connectionRows.find((c) => c.account === account.id) ?? (await inv('connection:add', account.id, { name: 'Test · OpenCode' }))
    const reviewer = await lib.addAgent(inv, alpha, { name: 'Rv', provider: 'opencode', workflowRole: 'reviewer' })
    const builder = await lib.addAgent(inv, alpha, { name: 'Bd', provider: 'opencode', workflowRole: 'builder' })
    for (const a of [reviewer, builder]) await inv('agents:update', alpha, a.id, { connection: conn.id })

    /** The newest launch's written opencode.json, after `since` launches. */
    const launchRoot = path.join(userData, 'launches')
    const configs = () => (fs.existsSync(launchRoot) ? fs.readdirSync(launchRoot).map((d) => path.join(launchRoot, d, 'opencode-config', 'opencode.json')).filter((f) => fs.existsSync(f)) : [])
    /** Starts an agent, and returns its launch's written config once there, the seam's restriction checked (option A). */
    const start = async (agent, label) => {
      const known = new Set(configs())
      enter(`${label}: launch`)
      await inv('session:start', alpha, { agentId: agent.id })
      const file = await until(async () => configs().find((f) => !known.has(f)) ?? null, HUNG_MS)
      const written = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
      const providerRules = (written?.policies ?? []).filter((p) => p.action === 'provider.use')
      const held = providerRules[0]?.resource === '*' && providerRules[0]?.effect === 'deny' && providerRules.filter((p) => p.effect === 'allow').every((p) => p.resource === seam.id) && written?.model === `${seam.id}/${MODEL}`
      trace.launches[label] = { permissions: written?.permissions ?? null, defaultAgent: written?.default_agent ?? null, providerPolicies: providerRules }
      check(`${label}: the launch config denies every provider but the local test one`, held, JSON.stringify(trace.launches[label]))
      return held ? written : null
    }
    const key = (agent) => lib.ptyKey(alpha, agent.id)
    const screen = async (agent) => lib.plainText((await inv('pty:buffer', key(agent)).catch(() => '')) ?? '')
    const drawn = async (agent) => !!(await until(async () => (/ctrl\+p commands/.test(await screen(agent)) ? true : null), HUNG_MS))
    /**
     * One prompt, then until `done()` or the turn ends: each ask it raises recorded; an external_directory ask answered
     * as `onExternal` says (Esc rejects), any other ask (an edit's: the mode's own) answered once (Enter).
     */
    const turn = async (agent, label, prompt, { done, onExternal }) => {
      enter(label)
      const requests = trace.requests.length
      await lib.sendPrompt(inv, key(agent), prompt, { submitted: async () => trace.requests.length > requests, tries: 1, waitMs: HUNG_MS })
      const answered = new Set()
      const result = await until(async () => {
        if (await done()) return { done: true }
        const s = await live(agent.id)
        if (s?.status === 'waiting' && s.statusMessage && !answered.has(s.statusMessage)) {
          answered.add(s.statusMessage)
          const external = /^external_directory\b/.test(s.statusMessage)
          trace.asks.push({ phase: label, message: s.statusMessage, answered: external ? onExternal : 'once (Enter)' })
          await inv('pty:write', key(agent), external && onExternal === 'reject' ? '\x1b' : '\r')
          if (external && onExternal === 'reject') return { done: false, rejected: true }
        }
        if (s?.status === 'finished' && trace.requests.length > requests) return { done: await done() }
        return null
      }, TURN_MS, 500)
      return result ?? { done: false }
    }

    // --- Review copies: the project's copies folder, a probe folder in it with a marker file.
    const reviewerCfg = await start(reviewer, 'reviewer')
    if (!reviewerCfg) {
      console.log('FAIL stopped before any prompt: the launch config would let OpenCode reach other providers (option A)')
      failed++
      return
    }
    const grant = (reviewerCfg.permissions ?? []).find((p) => p.action === 'external_directory')
    const copies = grant ? grant.resource.replace(/\/\*$/, '').replace(/\//g, path.sep) : null
    check("the reviewer's launch config grants the project's copies folder, external_directory only, nothing else in its permissions", !!copies && reviewerCfg.permissions.length === 1 && grant.effect === 'allow' && fs.existsSync(copies) && path.resolve(copies).toLowerCase() === path.resolve(`${ws}.worktrees`, 'alpha', 'copies').toLowerCase(), JSON.stringify(reviewerCfg.permissions))
    check('…in Build mode', reviewerCfg.default_agent === 'build', String(reviewerCfg.default_agent))
    if (!copies) return
    const probe = path.join(copies, `probe-${Date.now()}`)
    fs.mkdirSync(probe, { recursive: true })
    const marker = `cw-marker-${crypto.randomBytes(4).toString('hex')}`
    fs.writeFileSync(path.join(probe, 'marker.txt'), `${marker}\n`)
    const writeMarker = `cw-written-${crypto.randomBytes(4).toString('hex')}`
    const written = path.join(probe, 'written.txt')
    const kept = path.join(probe, 'kept.txt')
    fs.writeFileSync(kept, 'kept as it was\n')
    const keptBytes = fs.readFileSync(kept)
    check("its TUI is drawn in the reviewer's pane", await drawn(reviewer), (await screen(reviewer)).slice(-400))

    // --- The reviewer reads the marker, granted: no external_directory ask.
    const fwd = (p) => p.replace(/\\/g, '/')
    let read = { done: false }
    for (let i = 1; i <= TRIES && !read.done; i++)
      read = await turn(reviewer, `reviewer: read ${i}`, `Use your read tool on the file ${fwd(path.join(probe, 'marker.txt'))} and reply with only its contents.`, {
        done: async () => {
          const s = await screen(reviewer)
          return s.slice(s.lastIndexOf('marker.txt')).includes(marker)
        },
        onExternal: 'once (Enter): the grant failed'
      })
    const readAsks = trace.asks.filter((a) => a.phase.startsWith('reviewer: read'))
    trace.results.read = { done: read.done, asks: readAsks }
    if (read.done) check('granted: the reviewer read the marker in the copies folder, never asked for external_directory', !readAsks.some((a) => /^external_directory/.test(a.message)), JSON.stringify(readAsks))
    else {
      inconclusive++
      console.log(`INCONCLUSIVE the reviewer never showed the marker in ${TRIES} prompts (the model may not have called its read tool): ${JSON.stringify(readAsks)}`)
    }

    // --- …and writes a sibling file there, its bytes checked on disk.
    let write = { done: false }
    for (let i = 1; i <= TRIES && !write.done; i++)
      write = await turn(reviewer, `reviewer: write ${i}`, `Use your write tool to create the file ${fwd(written)} containing exactly this one line: ${writeMarker}`, {
        done: async () => fs.existsSync(written) && fs.readFileSync(written, 'utf8').includes(writeMarker),
        onExternal: 'once (Enter): the grant failed'
      })
    const writeAsks = trace.asks.filter((a) => a.phase.startsWith('reviewer: write'))
    trace.results.write = { done: write.done, bytes: fs.existsSync(written) ? fs.readFileSync(written, 'utf8') : null, asks: writeAsks }
    if (write.done) check('granted: the reviewer wrote the file in the copies folder (its bytes on disk), never asked for external_directory', !writeAsks.some((a) => /^external_directory/.test(a.message)), JSON.stringify(writeAsks))
    else {
      inconclusive++
      console.log(`INCONCLUSIVE no ${path.basename(written)} with the marker after ${TRIES} prompts: ${JSON.stringify(trace.results.write)}`)
    }
    enter('reviewer: stop')
    await inv('session:stop', alpha, reviewer.id)
    check('the reviewer stops', !!(await until(async () => !(await live(reviewer.id)), HUNG_MS)))

    // --- The builder, granted nothing, in a fresh session: asked for external_directory, rejected, the file kept.
    const builderCfg = await start(builder, 'builder')
    if (!builderCfg) return
    check("the builder's launch config grants no folder (no permissions)", !('permissions' in builderCfg), JSON.stringify(builderCfg.permissions))
    check("its TUI is drawn in the builder's pane", await drawn(builder), (await screen(builder)).slice(-400))
    let asked = { done: false }
    for (let i = 1; i <= TRIES && !asked.rejected; i++)
      asked = await turn(builder, `builder: write ${i}`, `Use your write tool to replace the contents of the file ${fwd(kept)} with exactly: overwritten`, { done: async () => false, onExternal: 'reject' })
    const builderAsks = trace.asks.filter((a) => a.phase.startsWith('builder:'))
    trace.results.contrast = { asks: builderAsks, keptUnchanged: fs.readFileSync(kept).equals(keptBytes) }
    if (asked.rejected) {
      check('not granted: the builder was asked for external_directory, for the copies folder', builderAsks.some((a) => a.message.startsWith('external_directory') && a.message.toLowerCase().includes(fwd(probe).toLowerCase())), JSON.stringify(builderAsks))
      const after = await until(async () => ((await live(builder.id))?.status !== 'waiting' ? true : null), HUNG_MS)
      check('…rejected (Esc), it asks no more and the file is as it was', !!after && fs.readFileSync(kept).equals(keptBytes), JSON.stringify(trace.results.contrast))
    } else {
      inconclusive++
      console.log(`INCONCLUSIVE the builder raised no external_directory ask in ${TRIES} prompts: ${JSON.stringify(builderAsks)}`)
      check('…and the file is as it was', fs.readFileSync(kept).equals(keptBytes))
    }
    enter('builder: stop')
    await inv('session:stop', alpha, builder.id)
    await until(async () => !(await live(builder.id)), HUNG_MS)
    check('every model request went to the local proxy for ' + MODEL, trace.requests.length > 0 && trace.requests.every((r) => r.path.startsWith('/v1/') && (r.model === null || r.model === MODEL)), JSON.stringify(trace.requests.slice(0, 5)))
    check('none of this test\'s opencode is left running', !!(await until(async () => (opencodeLeft().length ? null : true), HUNG_MS)), JSON.stringify(opencodeLeft().map((p) => p.pid)))
  } finally {
    enter('closed')
    await app.close().catch(() => undefined)
    await px.close()
    fs.writeFileSync(TRACE, JSON.stringify(trace, null, 2))
    console.log(`TRACE (also ${TRACE}):\n${JSON.stringify(trace, null, 2)}`)
  }
  const diff = changes(before, snapshot())
  check("the user's own OpenCode folders are as they were, and the machine-wide service's port too", diff.length === 0 && (await portOpen(28894)) === serviceBefore, diff.slice(0, 8).join('; '))
  console.log(failed ? `${failed} check(s) failed` : inconclusive ? `all checks passed, ${inconclusive} INCONCLUSIVE` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
