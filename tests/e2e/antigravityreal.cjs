// The real Antigravity CLI (agy) through Combwork (HI-2548; Darren's (b), 7 Nov: a launch and one tiny prompt a run): the
// installed agy as Combwork's detection selects it, its version for tested-clis, signed in with the PC's one sign-in
// (Credential Manager's: read by agy, never changed here), run in this test copy's own profiles (the check profile and the
// agent's, under its test data; never the user's ~\.gemini, which lib.cjs lists before and after) with its updates off.
// The check profile is marked past agy's first-run screens as Set up leaves it, from the probe profile Darren onboarded
// (only that they are done, never its installation id). One agent, one launch: its private profile (Combwork's MCP
// servers, hooks and rules file), ready once its status line says idle, Combwork's tools connected, then one prompt on
// the cheapest model at low effort ("Reply with just: OK"): a turn admitted from agy's own hooks and its prompt read from
// its transcript, the reply in the conversation view, its usage counted, the agent ready again; then it stops, and no agy
// of this test is left running. The user's agy folders and the PC's credential names are the same afterwards.
const lib = require('./lib.cjs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { processes } = require('./folderProcesses.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
// A real model turn: bounded, never how long it should take.
const TURN_MS = 180000

const userData = path.join(lib.WORK, 'antigravityreal-profile')
const ws = path.join(lib.WORK, 'antigravityreal-ws')
const alpha = path.join(ws, 'alpha')
// The probe profile Darren onboarded and signed in (HI-2547's runs): only its onboarding markers are copied.
const PROBE = path.join(process.env.LOCALAPPDATA || '', 'combwork-test', 'agy-probe')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()

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
      else {
        try {
          const s = fs.statSync(p)
          out.push(`${path.relative(dir, p)}|${s.size}|${s.mtimeMs}`)
        } catch {}
      }
    }
  }
  walk(dir)
  return out.sort()
}
/** The PC's credential names (cmdkey /list: targets only, never a secret), those of Google's or agy's. */
function credentialNames() {
  const r = spawnSync('cmdkey', ['/list'], { encoding: 'utf8', windowsHide: true, env: lib.baseEnv() })
  return String(r.stdout ?? '').split(/\r?\n/).filter((l) => /Target:/i.test(l) && /agy|antigravity|google|gemini/i.test(l)).map((l) => l.trim()).sort()
}
const USER_PLACES = [path.join(os.homedir(), '.gemini'), path.join(process.env.LOCALAPPDATA || '', 'agy'), path.join(process.env.LOCALAPPDATA || '', 'Antigravity')]
const snapshot = () => ({ places: USER_PLACES.map((p) => [p, listing(p)]), credentials: credentialNames() })
function changes(before, after) {
  const out = []
  for (const [i, [p, list]] of before.places.entries()) {
    const now = after.places[i][1]
    const a = new Set(list)
    const b = new Set(now)
    out.push(...now.filter((x) => !a.has(x)).map((x) => `+ ${path.join(p, x.split('|')[0])}`), ...list.filter((x) => !b.has(x)).map((x) => `- ${path.join(p, x.split('|')[0])}`))
  }
  if (before.credentials.join() !== after.credentials.join()) out.push(`credentials: ${before.credentials.join(', ')} → ${after.credentials.join(', ')}`)
  return out
}

;(async () => {
  const before = snapshot()
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'README.md': '# alpha\n' })
  lib.enableProviders(userData, ['claude-code', 'antigravity'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // Past agy's first-run screens, as Set up leaves the check profile: the probe profile's markers, never its installation id.
  const probeCache = path.join(PROBE, '.gemini', 'antigravity-cli', 'cache', 'onboarding.json')
  if (!fs.existsSync(probeCache)) {
    console.log(`SKIP environment: no onboarded agy profile at ${PROBE} (Darren onboards it once by hand; tests/e2e/README.md)`)
    process.exit(0)
  }
  const check0 = path.join(userData, 'antigravity', 'check', '.gemini', 'antigravity-cli')
  fs.mkdirSync(path.join(check0, 'cache'), { recursive: true })
  fs.copyFileSync(probeCache, path.join(check0, 'cache', 'onboarding.json'))
  const state = path.join(PROBE, '.gemini', 'antigravity-cli', 'jetski_state.pbtxt')
  const block = fs.existsSync(state) ? /^post_onboarding: \{\r?\n(?:[ \t][^\r\n]*\r?\n)*\}/m.exec(fs.readFileSync(state, 'utf8'))?.[0] : null
  if (block) fs.writeFileSync(path.join(check0, 'jetski_state.pbtxt'), `${block}\n`)

  const { app, inv, page } = await lib.launch({ userData, env: { CW_API_PORT: lib.port(47904) } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  const { until } = lib
  const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id)

  // --- The installed agy as Combwork selects it, and the PC's sign-in.
  const info = await until(async () => {
    const i = (await inv('provider:refresh', 'antigravity'))?.antigravity
    return i?.found && i.loggedIn !== null ? i : null
  }, HUNG_MS)
  check('the installed agy is found, its version read', !!info?.found && /^\d+\.\d+\.\d+/.test(info.version ?? ''), JSON.stringify(info && { path: info.path, version: info.version }))
  if (info?.loggedIn !== true) {
    console.log(`SKIP environment: agy isn't signed in on this PC (${info?.loggedIn === false ? 'signed out' : 'unknown'}): Darren signs it in by hand, never a test`)
    await app.close()
    process.exit(failed ? 1 : 0)
  }
  check('…signed in with the PC’s sign-in', info.loggedIn === true)
  check('…and past its first-run setup (as Set up leaves it)', !JSON.stringify(await inv('provider:refresh', 'antigravity')).includes('one-time setup'))

  // --- One agent on the cheapest model at low effort.
  const gem = await lib.addAgent(inv, alpha, { name: 'Gem', provider: 'antigravity', model: 'gemini-3.8-flash-low', effort: 'low' })
  const mark = lib.combworkLogLines(userData).length
  await inv('session:start', alpha, { agentId: gem.id })
  // agy 1.5.0 names a new conversation only with its first prompt (its status line's conversation_id is "" until then):
  // started with none, the agent is ready once its status line says idle (HI-2548).
  const ready = await until(async () => ((await live(gem.id))?.status === 'ready' ? await live(gem.id) : null), HUNG_MS)
  check('the session starts, ready once its status line says idle, its conversation not named before a prompt', !!ready && !ready.sessionId, JSON.stringify(ready && { status: ready.status, sessionId: ready.sessionId }))
  const profile = path.join(userData, 'antigravity', 'profiles', gem.id)
  const mcp = JSON.parse(fs.readFileSync(path.join(profile, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers ?? {}
  check("…in its private profile, with Combwork's MCP servers, hooks and rules file", 'combwork' in mcp && fs.existsSync(path.join(profile, '.gemini', 'config', 'hooks.json')) && /cw_inbox/.test(fs.readFileSync(path.join(profile, '.gemini', 'GEMINI.md'), 'utf8')), JSON.stringify(Object.keys(mcp)))
  check("…Combwork's tools connected", !!(await until(async () => lib.combworkToolsConnected(userData, gem.id, mark), HUNG_MS)))
  const key = lib.ptyKey(alpha, gem.id)
  const screen = lib.plainText((await inv('pty:buffer', key).catch(() => '')) ?? '')
  check('…asking no trust question and showing no first-run screen', !/trust this folder|terms of service|colou?r scheme/i.test(screen), screen.slice(-300))

  // --- One prompt (Darren's (b)): a turn from agy's hooks, the reply in the transcript, its usage. Typed once only, whatever
  // Combwork shows (HI-2548's first run: its hooks failing, the turn went unseen and a second attempt sent it again).
  const prompt = 'Reply with just: OK'
  const taken = await lib.sendPrompt(inv, key, prompt, { submitted: async () => (await live(gem.id))?.status === 'working' || !!(await live(gem.id))?.turn?.id, tries: 1, waitMs: HUNG_MS })
  check('the prompt starts a turn (agy sends no prompt hook: its invocation zero and its transcript)', taken > 0, (await live(gem.id))?.status)
  const conv = await until(async () => (await live(gem.id))?.sessionId || null, HUNG_MS)
  check('…its conversation named with it (agy names it with its first prompt; Combwork takes it from its first hook)', /^[0-9a-f-]{36}$/.test(conv ?? ''), String(conv))
  const items = await until(async () => {
    const t = (await inv('transcript:read', alpha, conv).catch(() => null))?.items ?? []
    return t.some((i) => i.kind === 'assistant') && (await live(gem.id))?.status !== 'working' ? t : null
  }, TURN_MS)
  check('…its prompt (without what agy adds) and a reply in the conversation view', !!items && items[0]?.kind === 'user' && items[0].text === prompt && items.some((i) => i.kind === 'assistant' && /\bok\b/i.test(i.text ?? '')), JSON.stringify(items?.map((i) => `${i.kind} ${String(i.text ?? i.tool?.name ?? '').slice(0, 60)}`)))
  check('…the agent ready again once it ends', ['finished', 'idle'].includes((await live(gem.id))?.status), (await live(gem.id))?.status)
  const used = await until(async () => {
    const u = await inv('session:usage', alpha, conv).catch(() => null)
    return u?.requests >= 1 ? u : null
  }, HUNG_MS)
  check('…its usage: the requests and their tokens, one prompt, no cost', !!used && used.inputTokens > 0 && used.outputTokens > 0 && used.userMessages === 1 && used.costUsd === null, JSON.stringify(used && { requests: used.requests, input: used.inputTokens, cache: used.cacheReadTokens, output: used.outputTokens, model: used.model }))
  const details = await live(gem.id)
  check("…the status line's model and effort", !!details?.modelName && details.effort === 'low', JSON.stringify({ model: details?.modelName, effort: details?.effort }))

  // --- It stops, leaving no agy of this test running.
  await inv('session:stop', alpha, gem.id)
  check('it stops', !!(await until(async () => !(await live(gem.id)), HUNG_MS)))
  // agy's own processes of this test: those whose command line names this test copy's data (its --settings file).
  const agyLeft = () => processes().filter((p) => /\bagy(\.exe)?\b/i.test(p.commandLine) && p.commandLine.toLowerCase().includes(userData.toLowerCase()))
  const left = await until(async () => (agyLeft().length ? null : true), HUNG_MS)
  check('…and no agy of this test is left running', !!left, JSON.stringify(agyLeft().map((p) => p.pid)))
  await app.close()

  const diff = changes(before, snapshot())
  check("the user's own agy folders and the PC's credential names are as they were", diff.length === 0, diff.slice(0, 8).join('; '))
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
