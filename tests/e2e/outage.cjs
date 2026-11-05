// Resuming an agent after its connection drops (HI-1612). The fake Claude Code ends a turn as Claude Code 2.1.312 does
// when its API can't be reached ("netdown": the ECONNREFUSED message, StopFailure server_error). With Settings →
// Advanced → Resume agents after a connection drops on, the agent shows "Waiting for the connection…" and a Progress
// run while a stand-in for its API host (cw.outage.checkUrl.claude-code) drops every connection; once the stand-in
// answers, its conversation gets the note once, it carries on, and the run ends resumed. With the switch off, the same
// failed turn is left as it was: no wait, no run, no note. Quiet test build, throwaway profile, workspace and test home.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const net = require('net')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'outage-profile')
const ws = path.join(lib.WORK, 'outage-ws')
const claudeHome = path.join(lib.WORK, 'outage-claude-home')
const alpha = path.join(ws, 'alpha')
const shots = path.join(lib.WORK, 'outage-shots')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/**
 * The stand-in for the API host: a TCP server that, while down, drops every connection as it comes (the check fails),
 * and once up answers each with an HTTP 204 (any answer counts). Counts the connections it was given.
 */
function standIn() {
  const s = { up: false, hits: 0, server: null, port: 0 }
  s.server = net.createServer((sock) => {
    s.hits++
    sock.on('error', () => undefined)
    if (!s.up) return sock.destroy()
    sock.once('data', () => sock.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n'))
  })
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => resolve(Object.assign(s, { port: s.server.address().port }))))
}

;(async () => {
  for (const d of [userData, ws, claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [alpha, shots]) fs.mkdirSync(d, { recursive: true })
  const host = await standIn()
  const claude = lib.fakeClaude(userData, claudeHome, [alpha])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // On, checking the stand-in every second or two (the defaults: 30 s, backing off to 5 min).
  const values = { 'cw.outage.resume': true, 'cw.outage.checkFirstSeconds': 1, 'cw.outage.checkMostSeconds': 2, 'cw.outage.checkUrl.claude-code': `http://127.0.0.1:${host.port}/` }
  fs.writeFileSync(path.join(userData, 'advanced.json'), JSON.stringify({ format: 1, values }, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47921), ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1300, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const ada = await lib.addAgent(inv, alpha, { name: 'Ada' })
    const key = lib.ptyKey(alpha, ada.id)
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === ada.id) ?? null
    await inv('session:start', alpha, { agentId: ada.id })
    check('the agent starts', !!(await lib.until(async () => (await live())?.status === 'ready', HUNG_MS)))
    await page.getByText('alpha', { exact: true }).first().click()
    const wakes = () => (fs.existsSync(path.join(claudeHome, 'fake-wakes.jsonl')) ? fs.readFileSync(path.join(claudeHome, 'fake-wakes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    const notes = () => wakes().filter((w) => /The connection dropped at .* and came back at .*: check what was cut off, rerun it, and carry on\./.test(w.text))
    const runs = async () => (await inv('progress:list')).filter((r) => /waiting for the connection/.test(r.title))
    const failTurn = async (n) => {
      const before = (await live())?.failedTurn?.since ?? null
      await lib.sendPrompt(inv, key, `netdown ${n}`, { submitted: async () => !!(await live())?.failedTurn && (await live()).failedTurn.since !== before })
    }

    // --- On: the turn ends on ECONNREFUSED, and Combwork waits while the stand-in drops each check.
    await failTurn(1)
    const waiting = await lib.until(async () => ((await live())?.statusMessage === 'Waiting for the connection…' ? await live() : null), HUNG_MS)
    check('the agent shows "Waiting for the connection…"', !!waiting, JSON.stringify(await live()))
    check('its failed turn keeps the CLI\'s words', /ECONNREFUSED/.test(waiting?.failedTurn?.message ?? ''), JSON.stringify(waiting?.failedTurn))
    const run = await lib.until(async () => (await runs()).find((r) => !r.finishedAt) ?? null, HUNG_MS)
    check('a Progress run says it waits for the connection', !!run && run.title === 'alpha: waiting for the connection' && /connection/.test(run.waiting ?? ''), JSON.stringify(run))
    check('the pane header shows the wait', !!(await lib.until(async () => ((await page.locator('.pane-header-bar', { hasText: 'Waiting for the connection…' }).count()) > 0 ? true : null), HUNG_MS)))
    // Two checks found the host down (each tries IPv4 and IPv6: two connections): nothing given meanwhile.
    check('it checks the host, and finds it down', !!(await lib.until(async () => (host.hits >= 4 ? true : null), HUNG_MS)), String(host.hits))
    check('no note while it is down', notes().length === 0, JSON.stringify(wakes()))
    await page.screenshot({ path: path.join(shots, 'outage-1-waiting.png') })
    // The Progress panel, opened from its rail: the wait's run in it.
    await page.locator('.progress-rail').click()
    check('the Progress panel lists the wait', !!(await lib.until(async () => ((await page.getByText('alpha: waiting for the connection').count()) > 0 ? true : null), HUNG_MS)))
    await page.screenshot({ path: path.join(shots, 'outage-2-waiting-progress.png') })

    // --- The host answers: one note, the agent carries on, and the run ends resumed.
    host.up = true
    check('once the host answers, the agent is given the note', !!(await lib.until(async () => (notes().length ? true : null), HUNG_MS)), JSON.stringify(wakes()))
    check('…and carries on to the end of a good turn', !!(await lib.until(async () => {
      const s = await live()
      return s?.status === 'finished' && !s.failedTurn ? true : null
    }, HUNG_MS)), JSON.stringify(await live()))
    const ended = await lib.until(async () => (await runs()).find((r) => r.id === run?.id && r.finishedAt) ?? null, HUNG_MS)
    check('the Progress run ends resumed', !!ended && ended.state === 'passed' && /^Resumed: the connection dropped at .+ and came back at .+\.$/.test(ended.summary ?? ''), JSON.stringify(ended))
    check('the status no longer says it waits', (await live())?.statusMessage !== 'Waiting for the connection…', (await live())?.statusMessage)
    // Its next turn is under way or over: a note given twice would be logged by now; one is.
    check('the note was given once', notes().length === 1, JSON.stringify(notes()))
    await page.screenshot({ path: path.join(shots, 'outage-3-resumed.png') })

    // --- Off: the same failed turn is left for the user, as before.
    await inv('advanced:set', 'cw.outage.resume', false)
    host.up = false
    const hitsBefore = host.hits
    await failTurn(2)
    const left = await lib.until(async () => {
      const s = await live()
      return s?.failedTurn && /ECONNREFUSED/.test(s.statusMessage ?? '') ? s : null
    }, HUNG_MS)
    // A wait starts as the failed turn is reported (its status set in the same step), so the CLI's words shown mean none did.
    check('with the switch off, the agent shows the CLI\'s words, not a wait', !!left, JSON.stringify(await live()))
    check('no Progress run is open', !(await runs()).some((r) => !r.finishedAt), JSON.stringify(await runs()))
    check('no check of the host, no further note', host.hits === hitsBefore && notes().length === 1, JSON.stringify({ hits: host.hits - hitsBefore, notes: notes().length }))
  } finally {
    await app.close()
    host.server.close()
  }
  if (failed) process.exitCode = 1
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
