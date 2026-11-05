// Restart session: start a session, type nothing, change a setting that needs a restart (effort), click "Restart
// session": the session comes back with the new setting, resuming the same conversation. The agent runs the fake
// Claude Code (fake-claude/, #195), whose launches show what Combwork started it with; that the real Claude Code takes the
// relaunch is claude-real's.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const scratch = lib.WORK
const userData = path.join(scratch, 'restart-profile')
const ws = path.join(scratch, 'restart-ws')
const shots = path.join(scratch, 'restart-shots')
const claudeHome = path.join(scratch, 'restart-claude-home')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
fs.mkdirSync(shots, { recursive: true })
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const launches = () => fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

;(async () => {
  const claude = lib.fakeClaude(userData, claudeHome, [path.join(ws, 'demo')])
  const env = lib.hiveEnv({ CW_USER_DATA: userData, ...claude })
  const app = await _electron.launch({
    executablePath: lib.ELECTRON,
    args: [lib.ROOT],
    cwd: lib.ROOT,
    env
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])

  await lib.openWorkspace(inv, page, ws)
  const proj = path.join(ws, 'demo')
  await page.getByText('demo', { exact: true }).first().click()
  const agent = await lib.soloAgent(inv, proj)
  await inv('workspace:refresh')
  const st = await inv('session:start', proj, { name: 'restart test', agentId: agent.id })
  await lib.acceptClaudeTrust(inv, proj, agent.id)
  // Up and ready (SessionStart arrived).
  check('the session starts', !!(await lib.until(async () => (await inv('session:live')).some((l) => l.status === 'ready'), 30000)))
  await page.screenshot({ path: path.join(shots, '1-started.png') })

  // The agent's own effort (a project's isn't read for a CLI with connections, HI-1774).
  await lib.setLaunch(inv, proj, agent.id, { effort: 'low' })
  await inv('workspace:refresh')
  check('a changed effort offers Restart session', !!(await lib.until(async () => (await page.getByRole('button', { name: 'Restart session' }).count()) > 0, 10000)))
  await page.screenshot({ path: path.join(shots, '2-banner.png') })
  await page.getByRole('button', { name: 'Restart session' }).click()
  // Restarted: the banner gone and the session ready again.
  // Ready again from the relaunch: the fake launched a second time.
  const restarted = !!(await lib.until(async () => launches().length === 2 && (await page.getByRole('button', { name: 'Restart session' }).count()) === 0 && (await inv('session:live')).some((l) => l.status === 'ready'), 30000))
  check('after Restart session it is ready again, the offer gone', restarted)
  // What happened instead (#218): the fake's launches, the sessions and Combwork's log of them.
  if (!restarted) {
    const log = fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8').split('\n').filter((l) => /\[(pty|sessions)\]/.test(l))
    console.log(`(launches: ${launches().length}; live: ${JSON.stringify((await inv('session:live')).map((l) => ({ status: l.status, id: l.sessionId })))}; banner: ${await page.getByRole('button', { name: 'Restart session' }).count()}; dialogs: ${JSON.stringify(await page.locator('.dialog').allInnerTexts())})`)
    await page.screenshot({ path: path.join(shots, '3-restart-failed.png') })
    for (const l of log.slice(-12)) console.log(`(hive.log) ${l.slice(0, 300)}`)
  }
  await page.screenshot({ path: path.join(shots, '3-after-restart.png') })

  const live = await inv('session:live')
  const list = await inv('session:list', proj)
  const [first, second] = launches()
  check('the first launch had no effort set', !first?.opts['--effort'], JSON.stringify(first?.opts))
  check('the relaunch has the new effort', second?.opts['--effort'] === 'low', JSON.stringify(second?.opts))
  check('…and resumes the same conversation', second?.opts['--resume'] === st.sessionId && live.length === 1 && live[0].sessionId === st.sessionId, JSON.stringify({ resume: second?.opts['--resume'], live: live.map((l) => l.sessionId) }))
  check('one conversation in the list, still named', list.length === 1 && list[0].id === st.sessionId && /restart test/.test(list[0].name ?? ''), JSON.stringify(list.map((s) => ({ id: s.id, name: s.name }))))

  // Restart session while Combwork is slow to save the stopped session (#218): under load, main writes the session's record
  // before it tells the window the session stopped, and Restart session used to ask to stop a session already stopped
  // ("…already has a running session"). Here the workspace's database, where the record is (#1061), is held in a write
  // transaction by another process for a few seconds (less than its busy timeout) while it restarts, so its save waits:
  // the relaunch must still come, with no question.
  // The agent's own effort (a project's isn't read for a CLI with connections, HI-1774).
  await lib.setLaunch(inv, proj, agent.id, { effort: 'high' })
  await inv('workspace:refresh')
  check('another changed effort offers Restart session', !!(await lib.until(async () => (await page.getByRole('button', { name: 'Restart session' }).count()) > 0, 10000)))
  const dbFile = path.join(ws, '.combwork', 'hive.db')
  const hold = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(dbFile)}, { timeout: 5000 }); db.exec('BEGIN IMMEDIATE'); console.log('held'); setTimeout(() => { db.exec('COMMIT'); db.close() }, 3000)`
  const holder = require('child_process').spawn(process.execPath, ['-e', hold], { env: lib.baseEnv() })
  const released = new Promise((r) => holder.once('exit', r))
  let heldOut = ''
  holder.stdout.on('data', (d) => (heldOut += d))
  check('(the database is held)', !!(await lib.until(() => heldOut.includes('held'), 15000)))
  await page.getByRole('button', { name: 'Restart session' }).click()
  const again = !!(await lib.until(async () => launches().length === 3 && (await inv('session:live')).some((l) => l.status === 'ready'), 30000))
  const asked = await page.locator('.dialog').allInnerTexts()
  check('Restart session relaunches while the stopped session is still being saved, asking nothing', again && !asked.length, JSON.stringify({ launches: launches().length, dialogs: asked }))
  check('…with the newer effort, the same conversation', launches()[2]?.opts['--effort'] === 'high' && launches()[2]?.opts['--resume'] === st.sessionId, JSON.stringify(launches()[2]?.opts))
  await Promise.race([released, lib.sleep(10000)])

  await inv('session:stop', proj)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.stack ?? e)
  process.exit(1)
})
