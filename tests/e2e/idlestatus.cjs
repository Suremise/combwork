// An idle agent stays idle through what Claude Code does by itself (#612): a compaction while idle (shown as
// "Compacting the conversation…", then idle again) and a recap (no change); and an agent whose turn's end never reached
// Combwork (its Stop lost, as HB3's was) is idle again once Claude Code says it is waiting for input (its idle_prompt
// notification), the log saying what Combwork saw. Each time it takes a new task (cw_prompt_agent refused "is working"
// before). The agent runs the fake Claude Code (fake-claude/), so nothing signs in or spends tokens. Dev build,
// throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'idle-profile')
const ws = path.join(lib.WORK, 'idle-ws')
const claudeHome = path.join(lib.WORK, 'idle-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47869))
const API = `http://127.0.0.1:${PORT}`
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.agentApi = { enabled: true, port: Number(PORT), provideHiveMcp: true, allowSessionInput: true }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // Claude Code's idle notification, half a second after each turn instead of a minute.
  fs.writeFileSync(path.join(claudeHome, 'fake-idle-notify.txt'), '500')
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: PORT, CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (p, agentId) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === agentId)
  const until = async (fn, ms) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  // Giving agents tasks is the Assistant's: start it (also the fake) and use its token.
  const home = (await inv('workspace:refresh')).assistant.path
  await inv('session:start', home, { agentId: 'assistant' })
  await until(async () => (await live(home, 'assistant'))?.status === 'waiting', HUNG_MS)
  await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
  await until(async () => (await live(home, 'assistant'))?.status === 'ready', HUNG_MS)
  const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
  const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token
  const api = async (method, p, body) => {
    const res = await fetch(API + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const made = (name) => fs.writeFileSync(path.join(claudeHome, name), '')
  const taken = (name) => !fs.existsSync(path.join(claudeHome, name))
  const transcriptHas = (st, text) => {
    const dir = path.join(claudeHome, 'projects')
    return fs.readdirSync(dir).some((d) => {
      const f = path.join(dir, d, `${st.sessionId}.jsonl`)
      return fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(text)
    })
  }
  /** Gives it a task as cw_prompt_agent does, and waits for its turn to end. */
  const task = async (text) => {
    const given = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text })
    if (given.status === 200) await api('POST', '/v1/agents/wait', { agents: [{ project: 'alpha', agent: 'Tester' }], timeoutSeconds: 30 })
    return given
  }

  await page.getByText('alpha', { exact: true }).first().click()
  const added = await api('POST', '/v1/projects/alpha/agents', { name: 'Tester', prompt: 'work 1' })
  const id = added.body?.agent?.id
  check('the agent finishes its first task', !!(await until(async () => (await live(alpha, id))?.status === 'finished', HUNG_MS)), JSON.stringify(added.body))

  // An idle compaction: Compacting while it runs, idle again after.
  made('fake-idle-compact-Tester')
  const compacting = await until(async () => {
    const s = await live(alpha, id)
    return s?.status === 'working' && /Compacting/.test(s.statusMessage ?? '') && s
  }, HUNG_MS)
  // The pane follows main's state shortly after, not with it (the window shows agents' states in batches, HI-1806); the
  // compaction lasts until the test ends it below.
  let pane = ''
  await until(async () => /Compacting/.test((pane = await page.locator('.pane-status').first().innerText().catch(() => ''))), HUNG_MS)
  check('an idle compaction shows as compacting', !!compacting && /Compacting/.test(pane), `${JSON.stringify(compacting)} · pane: ${pane}`)
  made('fake-idle-compact-done-Tester')
  const after = await until(async () => {
    const s = await live(alpha, id)
    return taken('fake-idle-compact-done-Tester') && transcriptHas(s, 'Compacted while idle') && s.status === 'ready' && s
  }, HUNG_MS)
  check('it is idle again once the compaction is over', after?.status === 'ready' && !after.statusMessage, JSON.stringify(after && { status: after.status, message: after.statusMessage }))
  check('and takes a task', (await task('work 1')).status === 200)

  // A recap: Claude Code writes it by itself, and sends no hook of Combwork's.
  made('fake-recap-Tester')
  const recapped = await until(async () => {
    const s = await live(alpha, id)
    return taken('fake-recap-Tester') && transcriptHas(s, 'away_summary') && s
  }, HUNG_MS)
  check('a recap leaves it idle', recapped?.status === 'finished', JSON.stringify(recapped && { status: recapped.status, message: recapped.statusMessage }))
  check('and it takes a task', (await task('work 1')).status === 200)

  // A turn whose Stop never reaches Combwork: working, until Claude Code says it is waiting for input.
  const lost = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'work 1 loststop' })
  check('a task whose turn end Combwork misses', lost.status === 200, JSON.stringify(lost.body))
  const idleAgain = await until(async () => {
    const s = await live(alpha, id)
    return transcriptHas(s, 'Done: work 1 loststop') && s.status === 'ready' && s
  }, HUNG_MS)
  check("it is idle again once Claude Code says it's waiting for input", idleAgain?.status === 'ready', JSON.stringify(idleAgain && { status: idleAgain.status }))
  const logFile = path.join(userData, 'logs', 'hive.log')
  const said = await until(() => fs.existsSync(logFile) && /idle at its prompt while Combwork showed it working; idle again \(hooks before: .*prompt/.test(fs.readFileSync(logFile, 'utf8')), HUNG_MS)
  check('the log says what Combwork saw before', !!said)
  check('and it takes a task', (await task('work 1')).status === 200)
  const done = await live(alpha, id)
  check('which it finishes', done?.status === 'finished', done?.status)

  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
