// Honest run states in the Progress panel (#549), on a fake Claude Code agent (fake-claude/) whose "shell:" step runs
// cw-progress as an agent's shell does (Combwork's shims: Electron as Node): a run waiting for a test slot shows what it
// waits for and how long it has waited, never a time left, with a still, hatched bar, and goes on with its steps when the
// wait ends; a run past its estimate says "finishing", never "0 s left"; a command interrupted by Ctrl+C (its exit code,
// a shell's 130) shows as stopped, not failed; a wrapper killed with its command (an agent stopping a preview server) shows as ended
// without a report once its process is gone, never "stopped reporting". Screenshots of the waiting and ended runs in both
// themes. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { suspensions } = require('./folderProcesses.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47868))
const userData = path.join(lib.WORK, 'progressstates-profile')
const ws = path.join(lib.WORK, 'progressstates-ws')
const claudeHome = path.join(lib.WORK, 'progressstates-claude-home')
const shots = path.join(lib.WORK, 'progressstates-shots')
const ctl = path.join(lib.WORK, 'progressstates-ctl')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms = 30000) => lib.until(fn, ms, 150)

;(async () => {
  for (const d of [userData, ws, shots, ctl]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [shots, ctl]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  const cenv = lib.fakeClaude(userData, claudeHome, [alpha])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), ...cenv, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const shells = () => {
    const f = path.join(claudeHome, 'fake-shell.jsonl')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }
  /** Has the agent start a command (as its shell would); resolves to a wait for what it recorded. */
  const startShell = async (id, cmd, ms = 60000) => {
    const before = shells().length
    // Idle, as the agent is after a command before (`finished`, not `ready`: that wait ran out, HI-2688).
    await lib.agentIdle(inv, id, 30000)
    const key = lib.ptyKey(alpha, id)
    // Taken once it works, or (a quick command) has already recorded it.
    await lib.sendPrompt(inv, key, `shell: ${cmd}`, { submitted: async () => shells().length > before || (await live(id))?.status === 'working' })
    return async () => {
      await until(() => shells().length > before, ms)
      return shells()[before]
    }
  }
  const runs = () => inv('progress:list')
  const newRun = async (known, match) => until(async () => (await runs()).find((r) => !known.includes(r.id) && match(r)), 60000)
  const shoot = async (name) => {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
  }

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  await inv('session:start', alpha, { agentId: builder.id })
  check('the agent starts', !!(await until(async () => (await live(builder.id))?.status === 'ready', 45000)))
  await page.locator('.xterm').first().click().catch(() => undefined)
  await page.keyboard.press('Control+Alt+P')
  const panel = page.locator('.progress-panel')
  check('the Progress panel opens', !!(await until(async () => (await panel.count()) === 1, HUNG_MS)))
  const rowOf = (id) => panel.locator(`.progress-run[data-run="${id}"]`)
  const textOf = async (id) => ((await rowOf(id).textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ')

  // --- Waiting for a test slot (the wrapper's row, as a test runner under cw-progress reports a wait): what it waits
  // for and how long, no time left, a hatched still bar; when the wait ends it goes on with its steps. The command waits
  // for the test's files, never for a time.
  const release = path.join(ctl, 'release')
  const end = path.join(ctl, 'end')
  const js = path.join(ctl, 'queued.cjs')
  fs.writeFileSync(
    js,
    `const fs = require('fs')
console.log('##cw-progress wait=waiting for a test slot: e2e: 137 suites in hb4')
const t = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)})) return
  clearInterval(t)
  console.log('##cw-progress wait=')
  console.log('##cw-progress step=1 total=2 name=first suite')
  const u = setInterval(() => fs.existsSync(${JSON.stringify(end)}) && process.exit(0), 100)
}, 100)
`
  )
  let known = (await runs()).map((r) => r.id)
  const queued = await startShell(builder.id, `cw-progress --title "Affected e2e" -- node "${js}"`)
  const q = await newRun(known, (r) => r.title === 'Affected e2e')
  check('a waiting run is reported waiting, with no estimate', !!q && q.waiting === 'waiting for a test slot: e2e: 137 suites in hb4' && q.estimateMs === null && q.state === 'running', JSON.stringify(q))
  check('its row says what it waits for and how long, never a time left', !!(await until(async () => /waiting for a test slot: e2e: 137 suites in hb4/.test(await textOf(q?.id)) && /waiting \d+ s/.test(await textOf(q?.id)), 10000)) && !/left/.test(await textOf(q?.id)), await textOf(q?.id))
  const bar = await rowOf(q?.id).locator('.progress-bar').evaluate((e) => ({ waiting: e.classList.contains('waiting'), moving: e.classList.contains('indeterminate'), value: e.getAttribute('aria-valuenow'), text: e.getAttribute('aria-valuetext') }))
  check('its bar looks waiting: hatched and still, no value', bar.waiting && !bar.moving && bar.value === null && bar.text === 'waiting', JSON.stringify(bar))
  await shoot('waiting')
  fs.writeFileSync(release, '')
  check('the wait ends: it goes on with its steps', !!(await until(async () => /1 of 2: first suite/.test(await textOf(q?.id)) && !/waiting/.test(await textOf(q?.id)), 15000)), await textOf(q?.id))
  check('…and Combwork has it waiting no more', !!(await until(async () => (await runs()).find((r) => r.id === q?.id)?.waiting === null, 5000)))
  fs.writeFileSync(end, '')
  const qEnd = await queued()
  check('…then it passes', qEnd?.code === 0 && !!(await until(async () => (await runs()).find((r) => r.id === q?.id)?.state === 'passed', 10000)), JSON.stringify(qEnd))

  // --- Past its estimate: "finishing", never "0 s left" (a script's run through the API, 2 s expected).
  const late = await api('POST', '/v1/progress', { title: 'Almost there', estimateMs: 2000 })
  check('a run with a short estimate starts', late.status === 200, JSON.stringify(late))
  const seen = []
  const finishing = await until(async () => {
    const t = await textOf(late.body?.id)
    seen.push(t)
    return /finishing/.test(t)
  }, 15000)
  check('past its estimate it says finishing', !!finishing, seen.at(-1))
  check('…and never "0 s left" on the way', seen.every((t) => !/\b0 s left/.test(t)), JSON.stringify(seen.filter((t) => /0 s left/.test(t))))
  await api('POST', `/v1/progress/${late.body?.id}/finish`, { ok: true })

  // --- Interrupted by Ctrl+C: stopped, not failed. Its command exits as a shell's does after Ctrl+C (130): with Windows'
  // STATUS_CONTROL_C_EXIT (the unit tests cover it), the .cmd shim's cmd asks "Terminate batch job (Y/N)?" and waits for
  // an answer this shell never gives, as cmd does for any batch file.
  known = (await runs()).map((r) => r.id)
  const ctrlcShell = await startShell(builder.id, `cw-progress --title "Interrupted build" -- node -e "process.exit(130)"`)
  const stopped = await until(async () => (await runs()).find((r) => !known.includes(r.id) && r.title === 'Interrupted build' && r.finishedAt !== null), 30000)
  check('a command ended by Ctrl+C shows as stopped, not failed', stopped?.state === 'stopped' && stopped.stopReason === 'interrupted', JSON.stringify(stopped))
  check('…its row says Stopped, with no warning or error mark', !!(await until(async () => /Stopped after/.test(await textOf(stopped?.id)), 5000)) && (await rowOf(stopped?.id).locator('.progress-fail, .progress-stale').count()) === 0, await textOf(stopped?.id))
  const ctrlc = await ctrlcShell()
  check('…its exit code passed through', ctrlc?.code === 130, JSON.stringify(ctrlc ?? null))

  // --- A wrapper killed with its command (an agent stopping a preview server it ran through cw-progress): once its
  // process is gone, the run has ended without a report, never "stopped reporting".
  known = (await runs()).map((r) => r.id)
  const server = await startShell(builder.id, `cw-progress --title "Preview server" -- node -e "setInterval(() => {}, 1000)"`)
  const srv = await newRun(known, (r) => r.title === 'Preview server')
  check('the server run reports its process', !!srv && Number.isInteger(srv.pid) && srv.pid > 0, JSON.stringify(srv))
  // Its identity while it is known to be the server (it runs until ended), for ending it as that process (#603).
  const [serverId] = srv?.pid ? lib.identify([srv.pid]) : []
  // What this checks is Combwork's side of a run whose wrapper never reports its end (wrapper.ts, runWrapped): the wrapper
  // must not run between its command's ending and its own. Ended one by one, children first, it outlived its command for
  // the moment between the two: it saw the command killed (exit code 4294967295, Kill's -1), rightly reported a failure
  // and exited before its own turn (HI-2284, under load). So it is suspended first (by its identity, #603) and sees
  // nothing until it is ended with the rest: a simulated stop of the whole tree at once, not a claim about every real
  // stop (one that ends the tree one by one may well be reported failed, correctly).
  // Tracked (suspensions), and released whatever happens: what is still suspended then is resumed, or ended by its
  // identity if it can't be, so the test never leaves its wrapper held.
  const held = suspensions()
  let ended = 0
  try {
    const frozen = serverId ? held.suspend([serverId]) : { done: [], failed: [] }
    check('the wrapper is held still first, so it sees nothing of its command ending', frozen.done.length === 1, JSON.stringify(frozen.failed))
    // Its tree, each process as it is now (never taskkill /T on a pid, #603).
    ended = serverId ? lib.endTreeExactly(serverId) : 0
  } finally {
    const left = held.release()
    if (left.failed.length || left.ended.length) console.log(`the wrapper's suspension released: ${JSON.stringify(left)}`)
  }
  check('its process tree is ended (as an agent stopping it does)', !!serverId && ended >= 1 && lib.stillSame([serverId]).length === 0, `${ended} ended`)
  await server()
  const gone = await until(async () => (await runs()).find((r) => r.id === srv?.id && r.finishedAt !== null), 45000)
  check('Combwork sees its process gone: ended without a report', gone?.state === 'stopped' && gone.stopReason === 'gone', JSON.stringify(gone))
  check('…never "stopped reporting" meanwhile, nor failed', gone?.staleReason === null && gone?.summary === null)
  check('…its row says so', !!(await until(async () => /Ended without a report after/.test(await textOf(srv?.id)), 5000)) && !/Stopped reporting/i.test(await textOf(srv?.id)), await textOf(srv?.id))
  await shoot('ended')
  // In the Runs tab (#1309), the stopped one is marked stopped (muted), not with a warning; a group of retries opened.
  await panel.locator('.progress-tab[data-tab="runs"]').click()
  await until(async () => (await panel.locator('.progress-tab-runs').count()) === 1, 5000)
  // Its card's runs (HI-1701) opened, then its group of retries.
  for (const head of await panel.locator('.progress-card-toggle[aria-expanded="false"]').all()) await head.click()
  for (const head of await panel.locator('.progress-group-head[aria-expanded="false"]').all()) await head.click()
  const recentIcon = await until(async () => (await panel.locator(`.progress-recent-item[data-run="${stopped?.id}"] .progress-recent .codicon`).first().getAttribute('class', { timeout: 500 }).catch(() => '')) || '', 5000)
  check('in the Runs tab, the interrupted run is marked stopped, not with a warning', /codicon-circle-slash/.test(recentIcon ?? ''), recentIcon)

  await app.close()
  console.log(failed ? `\n${failed} failed` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
