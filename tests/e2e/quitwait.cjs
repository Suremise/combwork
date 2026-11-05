// Quit when agents finish, with an agent working: Combwork hides its window and waits, quits once the agent finishes,
// and Cancel Pending Quit keeps it running. Also: while an agent works, Combwork keeps the PC awake (when plugged in,
// by default) and says so in the status bar, and stops once it finishes or the setting is Never. The agent is the fake Claude Code (fake-claude/), kept busy with
// "work N" (N seconds), so no real session or sign-in. Dev build, throwaway profiles, workspaces and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000
// The longest a quit waits for the agent's turn to end ("work 8"), and Combwork to close after it: a bound for a hung run.
const QUIT_HUNG_MS = 60000

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

async function launch(name) {
  const userData = path.join(lib.WORK, `quitwait-${name}-profile`)
  const ws = path.join(lib.WORK, `quitwait-${name}-ws`)
  const claudeHome = path.join(lib.WORK, `quitwait-${name}-claude-home`)
  const alpha = path.join(ws, 'alpha')
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(alpha, { recursive: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'working', closeToTray: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(name === 'wait' ? 47899 : 47900), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 800 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const agent = await lib.addAgent(inv, alpha, { name: 'Busy' })
  const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
  await inv('session:start', alpha, { agentId: agent.id })
  const ready = await until(async () => (await live())?.status === 'ready', 20000)
  return { app, page, inv, alpha, agent, live, ready, userData }
}

const until = async (fn, ms = 10000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
  return v
}
const exited = (app, ms) => app.waitForEvent('close', { timeout: ms }).then(() => true, () => false)
const visible = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible())).catch(() => false)

/** Sets the agent working for `secs` seconds. */
async function keepBusy(inv, alpha, agent, live, secs) {
  const key = lib.ptyKey(alpha, agent.id)
  await inv('pty:write', key, `please work ${secs}`)
  await lib.sleep(200)
  await inv('pty:write', key, '\r')
  return until(async () => (await live())?.status === 'working', 5000)
}

;(async () => {
  // --- Quit when agents finish: hidden while it works, quits when it finishes.
  {
    const { app, page, inv, alpha, agent, live, ready } = await launch('wait')
    check('the agent starts', !!ready)
    check('it is working', !!(await keepBusy(inv, alpha, agent, live, 8)))
    await page.evaluate(() => window.combwork.invoke('app:quit'))
    const dialog = page.locator('.dialog', { hasText: 'Quit Combwork?' })
    check('Quit asks, since an agent is working', !!(await until(async () => (await dialog.count()) === 1, 5000)))
    const waitButton = dialog.locator('button', { hasText: 'Quit when' })
    check('and offers to quit when it finishes', (await waitButton.count()) === 1)
    await page.screenshot({ path: path.join(lib.WORK, 'quitwait-1-dialog.png') })
    // The agent's turn ends, then Combwork closes: each waited for as it comes, bounded for a hung run, with when each came
    // logged (#679: once under load it hadn't closed within 30 s of the click, with no sign of which step was late). The
    // close is listened for from before the click, so one between two looks is still seen.
    let closedAt = null
    void app.waitForEvent('close', { timeout: 0 }).then(() => (closedAt = Date.now()), () => undefined)
    const t0 = Date.now()
    await waitButton.click()
    check('the window hides', !!(await until(async () => !(await visible(app)), 5000)))
    const state = await inv('app:quitState').catch(() => null)
    check('a quit is pending (the tray shows it), with one agent working', state?.pending === true && state?.working === 1, JSON.stringify(state))
    await lib.sleep(2000) // A fixed wait on purpose: this checks that Combwork does NOT quit while the agent works.
    check("it doesn't quit while the agent works", (await live().catch(() => null))?.status === 'working')
    // The turn's end: Combwork seen with the agent no longer working, or, once Combwork has closed (no more looks), the fake's
    // reply in its conversation, which it writes as the turn ends; a call that fails says nothing either way.
    const replyAt = () => {
      const dir = path.join(lib.WORK, 'quitwait-wait-claude-home', 'projects')
      const lines = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.jsonl')).flatMap((f) => fs.readFileSync(path.join(dir, String(f)), 'utf8').split('\n')) : []
      const reply = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).findLast((e) => e?.type === 'assistant' && (e.message?.content?.[0]?.text ?? '').startsWith('Done: please work 8'))
      return reply ? Date.parse(reply.timestamp) : null
    }
    let lastSeen = null
    // { at, by }: seen in Combwork (then before it closed, as Combwork answered), or read from the conversation once it had.
    const turnOver = await until(async () => {
      const at = Date.now()
      const s = await live().catch(() => null)
      if (s) {
        lastSeen = { status: s.status, quit: await inv('app:quitState').catch(() => null) }
        return s.status !== 'working' ? { at, by: 'Combwork' } : null
      }
      const replied = closedAt ? replyAt() : null
      return replied ? { at: replied, by: 'its conversation' } : null
    }, QUIT_HUNG_MS)
    check("the agent's turn ends", !!turnOver, JSON.stringify(lastSeen))
    const closed = !!turnOver && !!(await until(() => closedAt, QUIT_HUNG_MS))
    if (!closed) await app.close().catch(() => undefined)
    console.log(`  (the agent's turn was over ${turnOver ? `${turnOver.at - t0} ms after the click (seen by ${turnOver.by})` : '?'}; Combwork closed ${closedAt ? closedAt - t0 : '?'} ms after the click; last seen ${JSON.stringify(lastSeen)})`)
    check('it quits once the agent finishes', closed, JSON.stringify(lastSeen))
    check('not before the agent was done', closed && (turnOver.by === 'Combwork' || closedAt >= turnOver.at), `turn over ${turnOver ? turnOver.at - t0 : '?'} ms (by ${turnOver?.by}), closed ${closedAt ? closedAt - t0 : '?'} ms after the click`)
  }

  // --- Cancel Pending Quit: Combwork keeps running after the agent finishes.
  {
    const { app, page, inv, alpha, agent, live, ready } = await launch('cancel')
    check('the second agent starts', !!ready)
    const onBattery = await app.evaluate(({ powerMonitor }) => powerMonitor.isOnBatteryPower())
    const awakeItem = page.locator('.status-item.keep-awake')
    check('nothing keeps the PC awake while it is idle', (await inv('app:keepAwake')) === 0 && (await awakeItem.count()) === 0)
    check('it is working', !!(await keepBusy(inv, alpha, agent, live, 4)))
    if (onBattery) console.log('(on battery: the PC is not kept awake by default, so those checks are skipped)')
    else {
      check('while it works, the PC is kept awake', !!(await until(async () => (await inv('app:keepAwake')) === 1, HUNG_MS)))
      check('and the status bar says so', !!(await until(async () => /Keeping the PC awake: 1 agent working/.test(await awakeItem.innerText().catch(() => '')), HUNG_MS)))
      await page.screenshot({ path: path.join(lib.WORK, 'quitwait-2-awake.png') })
    }
    await page.evaluate(() => window.combwork.invoke('app:quit'))
    const dialog = page.locator('.dialog', { hasText: 'Quit Combwork?' })
    await until(async () => (await dialog.count()) === 1, 5000)
    await dialog.locator('button', { hasText: 'Quit when' }).click()
    check('a quit is pending', !!(await until(async () => (await inv('app:quitState')).pending === true, 5000)))
    await inv('app:cancelPendingQuit')
    check('Cancel Pending Quit clears it', (await inv('app:quitState')).pending === false)
    const closing = exited(app, 9000)
    check('the agent finishes', !!(await until(async () => (await live())?.status === 'finished', 10000)))
    check('and Combwork is still running', !(await closing))
    check('once it has finished, the PC may sleep again', (await inv('app:keepAwake')) === 0 && (await page.locator('.status-item.keep-awake').count()) === 0)
    // Never: not even while it works.
    await inv('settings:update', { general: { keepAwake: 'never' } })
    await keepBusy(inv, alpha, agent, live, 3)
    await lib.sleep(500)
    check("set to Never, a working agent doesn't keep it awake", (await live())?.status === 'working' && (await inv('app:keepAwake')) === 0)
    await until(async () => (await live())?.status === 'finished', 8000)
    await inv('session:stop', alpha, agent.id).catch(() => undefined)
    await inv('settings:update', { general: { confirmOnQuit: 'never' } }).catch(() => undefined)
    await app.close().catch(() => undefined)
  }

  // --- HI-2336: Combwork reopened during the wait, a file edited and left unsaved. Quit Now, and the agent finishing, ask about
  // it (save or discard) rather than quit and lose it; Cancel there keeps Combwork running.
  {
    const { app, page, inv, alpha, agent, live, ready, userData } = await launch('reopen')
    const reentries = () => (fs.existsSync(path.join(userData, 'logs', 'hive.log')) ? fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8').split('\n').filter((l) => l.includes('final look at unsaved files is already asking')).length : 0)
    check('reopen: the agent starts', !!ready)
    const dialog = page.locator('.dialog', { hasText: 'Quit Combwork?' })
    const waitToQuit = async (secs) => {
      check('reopen: it is working', !!(await keepBusy(inv, alpha, agent, live, secs)))
      await page.evaluate(() => window.combwork.invoke('app:quit'))
      await until(async () => (await dialog.count()) === 1, 5000)
      await dialog.locator('button', { hasText: 'Quit when' }).click()
      check('reopen: a quit is pending, the window hidden', !!(await until(async () => (await inv('app:quitState')).pending === true && !(await visible(app)), 5000)))
      // Shown again from the tray (as Show Combwork does; a test copy never takes the focus), and a file left unsaved there,
      // as its page reports one.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
      await inv('files:setUnsaved', [path.join(alpha, 'notes.md')])
    }
    await waitToQuit(30)
    // Quit Now while it waits: the dialog, listing the file, and Combwork still running.
    const closing = exited(app, 4000)
    void page.evaluate(() => window.combwork.invoke('app:quit')).catch(() => undefined)
    check('Quit Now during the wait asks about the file edited since, rather than quit', !!(await until(async () => (await dialog.count()) === 1 && /1 file has unsaved changes/.test(await dialog.innerText()), 5000)) && !(await closing))
    await page.screenshot({ path: path.join(lib.WORK, 'quitwait-3-reopened-unsaved.png') })
    await dialog.locator('button', { hasText: 'Cancel' }).click()
    check('Cancel there keeps Combwork running and cancels the pending quit', !!(await until(async () => (await inv('app:quitState')).pending === false, 5000)) && (await dialog.count()) === 0)
    await until(async () => (await live())?.status === 'finished', QUIT_HUNG_MS)
    // Again, and this time the agent finishes during the wait: it asks too; Save and quit then quits.
    await waitToQuit(4)
    let closedAt = null
    void app.waitForEvent('close', { timeout: 0 }).then(() => (closedAt = Date.now()), () => undefined)
    check('the agent finishing asks about the file edited since, rather than quit', !!(await until(async () => (await dialog.count()) === 1 && /1 file has unsaved changes/.test(await dialog.innerText()), QUIT_HUNG_MS)) && !closedAt)
    // A second request while it asks (Quit, which means "now" while a quit waits, as a session event's check does): Combwork
    // says it brought the open dialog forward rather than ask again; then still one dialog, and still running.
    const before = reentries()
    void page.evaluate(() => window.combwork.invoke('app:quit')).catch(() => undefined)
    check('a second request while it asks is taken by the dialog already open', !!(await until(() => reentries() > before, HUNG_MS)))
    check('…once, and still running', (await page.locator('.dialog', { hasText: 'Quit Combwork?' }).count()) === 1 && !closedAt)
    await dialog.locator('button.primary, button.danger').last().click()
    check('Save and quit then quits', !!(await until(() => closedAt, QUIT_HUNG_MS)))
    if (!closedAt) await app.close().catch(() => undefined)
  }

  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
