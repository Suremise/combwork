// Provider Setup never stays locked once its task has ended, however it ended (HI-3466). With a stand-in Muse (fake-muse/:
// its sandbox setup screen, answered in its terminal; no sign-in, no network) whose sandbox needs setting up: Set up runs
// its task and locks the tabs and buttons while it runs; cancelled in the CLI (its process ends), they work again with no
// reopen; ended by the dialog's own Cancel (the dialog closes, its task is killed), the dialog opened again, for another
// provider too, is unlocked; a task that ends as it starts (before its terminal could watch it) unlocks too; and one
// that finishes says so and unlocks. Dev build, throwaway profile; quiet.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.ui')

const userData = path.join(lib.WORK, 'setuplock-profile')
const sandboxFile = path.join(lib.WORK, 'setuplock-sandbox-needs-setup.txt')
const atOnceFile = path.join(lib.WORK, 'setuplock-setup-at-once.txt')
const fakeLog = path.join(lib.WORK, 'setuplock-fake.jsonl')
const fake = path.join(__dirname, 'fake-muse', 'muse.cmd')
const KEY = 'task:muse:setup'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const setupRuns = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').split(/\r?\n/).filter((l) => l.includes('"sandboxSetup"')).length : 0)

;(async () => {
  for (const d of [userData]) fs.rmSync(d, { recursive: true, force: true })
  for (const f of [sandboxFile, atOnceFile, fakeLog]) fs.rmSync(f, { force: true })
  lib.enableProviders(userData, ['claude-code', 'muse'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.muse = { ...cfg.settings.providers.muse, executablePath: fake }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  fs.writeFileSync(sandboxFile, 'needs setting up\n')

  const env = { FAKE_MUSE_LOG: fakeLog, FAKE_MUSE_SANDBOX_FILE: sandboxFile, FAKE_MUSE_SETUP_AT_ONCE: atOnceFile }
  const { app, page, inv } = await lib.launch({ userData, env, viewport: { width: 1200, height: 860 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv, 'muse')
    const selected = await lib.until(async () => (await inv('provider:refresh', 'muse'))?.muse?.path ?? null, HUNG_MS)
    if (String(selected ?? '').toLowerCase() !== fake.toLowerCase()) {
      console.log(`FAIL stopped: Combwork selected ${selected ?? 'no muse'}, not the fake`)
      process.exitCode = 1
      return
    }
    const ready = await lib.until(async () => ((await inv('provider:refresh', 'muse'))?.muse?.readiness ?? []).some((r) => r.id === 'sandbox'), HUNG_MS)
    check("the fake Muse's sandbox needs setting up", !!ready)

    const sendEvent = (e) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('cw:event', ev), e)
    const setup = page.locator('.dialog', { has: page.locator('.setup-tab') })
    const open = async () => {
      await sendEvent({ type: 'menu-command', command: 'help.agentSetup', args: [] })
      await lib.until(async () => (await setup.count()) === 1, HUNG_MS)
    }
    const museTab = setup.locator('.setup-tab', { hasText: 'Muse' })
    const claudeTab = setup.locator('.setup-tab', { hasText: 'Claude Code' })
    const setUp = setup.locator('.setup-actions .btn', { hasText: 'Set up' })
    const terminal = setup.locator('.task-terminal')
    /** The tabs and the Set up button all usable: nothing locked. */
    const unlocked = async () => (await museTab.isEnabled()) && (await claudeTab.isEnabled()) && (await setUp.count()) === 1 && (await setUp.isEnabled())
    const ptyRunning = () => inv('pty:running', KEY)
    const startSetup = async () => {
      const runs = setupRuns()
      await setUp.click()
      return !!(await lib.until(async () => setupRuns() > runs && (await terminal.count()) === 1, HUNG_MS))
    }

    await open()
    await museTab.click()
    await lib.until(async () => (await setUp.count()) === 1, HUNG_MS)
    check('Provider Setup shows Muse with Set up, unlocked', await unlocked())

    // --- Cancelled in the CLI: its process ends, the dialog stays, unlocked with no reopen.
    check('Set up starts its task in a terminal', await startSetup())
    check('…and while it runs, the tabs and Set up are locked', !!(await lib.until(async () => (await claudeTab.isDisabled()) && (await setUp.isDisabled()), HUNG_MS)))
    await lib.until(async () => (await inv('pty:buffer', KEY).catch(() => '')).includes('[y/n]'), HUNG_MS)
    await inv('pty:write', KEY, 'n')
    check('cancelled in the CLI: its process ends', !!(await lib.until(async () => !(await ptyRunning()), HUNG_MS)))
    check('…and the dialog, still open, unlocks without a reopen', !!(await lib.until(unlocked, HUNG_MS)) && (await setup.count()) === 1)
    await claudeTab.click()
    check('…its tabs change again', !!(await lib.until(async () => (await claudeTab.getAttribute('class'))?.includes('selected'), HUNG_MS)))
    await museTab.click()
    await lib.until(async () => (await setUp.count()) === 1, HUNG_MS)

    // --- Ended by the dialog's own Cancel: the dialog closes and kills it; opened again (for another provider too), unlocked.
    check('Set up starts again', await startSetup())
    await lib.until(async () => (await setUp.isDisabled()), HUNG_MS)
    await setup.locator('.btn', { hasText: 'Cancel' }).click()
    check("the dialog's Cancel closes it and ends the task", !!(await lib.until(async () => (await setup.count()) === 0 && !(await ptyRunning()), HUNG_MS)))
    await sendEvent({ type: 'menu-command', command: 'help.agentSetup', args: ['claude-code'] })
    await lib.until(async () => (await setup.count()) === 1, HUNG_MS)
    check('opened again for another provider: its tabs work, no terminal left', !!(await lib.until(async () => (await museTab.isEnabled()) && (await terminal.count()) === 0, HUNG_MS)))
    await museTab.click()
    check('…and Set up works again', !!(await lib.until(unlocked, HUNG_MS)))

    // --- A task that ends as it starts, before its terminal could watch it: unlocked all the same.
    fs.writeFileSync(atOnceFile, 'cancel at once\n')
    const runs = setupRuns()
    await setUp.click()
    check('a task that ends as it starts ran', !!(await lib.until(async () => setupRuns() > runs && !(await ptyRunning()), HUNG_MS)))
    check('…and the dialog unlocks', !!(await lib.until(unlocked, HUNG_MS)))
    fs.rmSync(atOnceFile, { force: true })

    // --- Finished: it says so, and unlocks.
    check('Set up starts once more', await startSetup())
    await lib.until(async () => (await inv('pty:buffer', KEY).catch(() => '')).includes('[y/n]'), HUNG_MS)
    await inv('pty:write', KEY, 'y')
    const done = setup.locator('[data-finished="ok"]')
    check('finished: it says Muse is set up', !!(await lib.until(async () => (await done.count()) === 1, HUNG_MS)), await setup.innerText().catch(() => ''))
    check('…and its tabs work', !!(await lib.until(async () => (await museTab.isEnabled()) && (await claudeTab.isEnabled()), HUNG_MS)))
    await page.screenshot({ path: path.join(lib.WORK, 'setuplock-finished.png') })
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed || process.exitCode ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
