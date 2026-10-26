// One workspace operation at a time per window (HI-1694, HR2's round 1 finding). A window's open claims it where the open
// begins to change it, after any folder picker or agents' stop: a request that outlasted one of those, or a second open,
// or a close, while another holds the window is refused, saying why; the window keeps the open it was doing, and the
// opening view shows it until it is done. The open is held part way (main's mkdir in its .hive folder waits), and the
// folder picker is a stand-in that answers when the suite says. Dev build, throwaway profile and workspaces.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'openguard-profile')
const [wsA, wsB] = ['openguard-alpha', 'openguard-beta'].map((n) => path.join(lib.WORK, n))
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, wsA, wsB]) fs.rmSync(d, { recursive: true, force: true })
  for (const w of [wsA, wsB]) fs.mkdirSync(path.join(w, 'app'), { recursive: true })
  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: lib.port(47797) } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  try {
    // A folder picker that answers when the suite says, and the open of A held at its first folder made in A.
    await app.evaluate(({ dialog }, a) => {
      const fsp = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('original-fs/promises')
      const mkdir = fsp.mkdir
      global.__guard = {}
      dialog.showOpenDialog = () => new Promise((resolve) => (global.__guard.picker = resolve))
      fsp.mkdir = async (...args) => {
        if (String(args[0]).toLowerCase().startsWith(a.toLowerCase()) && !global.__guard.held) {
          global.__guard.held = true
          await new Promise((r) => (global.__guard.release = r))
        }
        return mkdir(...args)
      }
    }, wsA)
    /** Starts an IPC call in the window, its outcome kept under `key` (ok, or its error's text). */
    const start = (key, ch, ...args) => page.evaluate(([k, c, a]) => {
      window.__guard = window.__guard ?? {}
      window.hive.invoke(c, ...a).then(() => (window.__guard[k] = { ok: true }), (e) => (window.__guard[k] = { error: String(e) }))
    }, [key, ch, args])
    const outcome = (key) => page.evaluate((k) => window.__guard?.[k] ?? null, key)

    // A pathless open waits in its folder picker; then A's open starts and is held part way.
    await start('picker', 'workspace:open')
    check('the pathless open waits in its folder picker', !!(await lib.until(() => app.evaluate(() => !!global.__guard.picker), HUNG_MS)))
    await start('a', 'workspace:open', wsA)
    check("A's open is under way, held part way", !!(await lib.until(() => app.evaluate(() => !!global.__guard.held), HUNG_MS)))
    check('…and the window shows it opening', !!(await lib.until(async () => /Opening openguard-alpha/.test(await page.locator('.workspace-opening').innerText().catch(() => '')), HUNG_MS)))

    // Meanwhile: the picker answers B; a second open; a new workspace; a close. Each is refused, saying why.
    await app.evaluate((_, b) => global.__guard.picker({ canceled: false, filePaths: [b] }), wsB)
    const refused = async (key) => {
      const r = await lib.until(() => outcome(key), HUNG_MS)
      return r && r.error && /openguard-alpha is still opening/.test(r.error) ? r : null
    }
    check('the picker, answered meanwhile, is refused: A is still opening', !!(await refused('picker')), JSON.stringify(await outcome('picker')))
    await start('second', 'workspace:open', wsB)
    check('a second open is refused', !!(await refused('second')), JSON.stringify(await outcome('second')))
    await start('close', 'workspace:close')
    check('a close is refused', !!(await refused('close')), JSON.stringify(await outcome('close')))
    await page.screenshot({ path: path.join(lib.WORK, 'openguard-held.png') })

    // A's open goes on: the window shows A, and the view goes.
    await app.evaluate(() => global.__guard.release())
    check("A's open finishes", (await lib.until(() => outcome('a'), HUNG_MS))?.ok === true, JSON.stringify(await outcome('a')))
    const info = await inv('workspace:get')
    check('the window shows A, never B', !!info && path.resolve(info.path).toLowerCase() === path.resolve(wsA).toLowerCase(), info?.path ?? 'none')
    check('the opening view goes', !!(await lib.until(async () => (await page.locator('.workspace-opening').count()) === 0, HUNG_MS)))
    // Free again: B opens now.
    await lib.openWorkspace(inv, page, wsB)
    check('once it is done, another open goes ahead', path.resolve((await inv('workspace:get')).path).toLowerCase() === path.resolve(wsB).toLowerCase())
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await app.evaluate(() => global.__guard?.release?.()).catch(() => undefined)
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
