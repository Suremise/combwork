// Provider Setup with a very long CLI path (#821): a user's WinGet path (…\WinGet\Packages\GitHub.Copilot_Microsoft.Winget.
// Source_8wekyb3d8bbwe\…) has no place to break, so it widened the status row and pushed Sign in off the dialog. Each
// provider's tab gets a found CLI at such a path that isn't signed in (sent to the window as main sends it: no CLI is
// run or signed in), at the window's smallest size, where the wide dialog is narrowest. On every tab, in both themes:
// the path wraps inside the row (the full path in its tooltip), the dialog doesn't scroll sideways, and Sign in and the
// tested line are inside it. Screenshots in setuplayout-shots. Throwaway profile; quiet.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'setuplayout-profile')
const shots = path.join(lib.WORK, 'setuplayout-shots')
const PROVIDERS = [
  { id: 'claude-code', name: 'Claude Code', exe: 'claude.exe' },
  { id: 'codex', name: 'Codex', exe: 'codex.exe' },
  { id: 'copilot', name: 'GitHub Copilot', exe: 'copilot.exe' }
]
// As WinGet names a package's folder, and longer: backslashes are no place to break a line.
const longPath = (exe) => `C:\\Users\\someone.with.a.long.name\\AppData\\Local\\Microsoft\\WinGet\\Packages\\GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe\\Versions\\1.0.97\\${'nested'.repeat(8)}\\${exe}`
// The window's smallest size (index.ts minWidth): the wide dialog is at its narrowest.
const SMALLEST = { width: 900, height: 700 }
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** A CLI found at a long path, not signed in, newer than the version Combwork was tested with. */
function stubInfo(p) {
  return {
    provider: p.id,
    found: true,
    checking: false,
    path: longPath(p.exe),
    version: '1.0.97',
    source: 'PATH',
    latestVersion: null,
    updateAvailable: false,
    loggedIn: false,
    authMethod: null,
    account: null,
    rejected: [],
    tested: { version: '1.0.90', testedAt: '2026-10-01', installed: 'newer' },
    readiness: [{ id: 'not-signed-in', level: 'error', message: `${p.name} is not signed in.`, action: { label: 'Sign in', task: 'login' }, detail: [`**Sign in** runs the ${p.name} login in a terminal.`] }]
  }
}

;(async () => {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.enableProviders(userData, PROVIDERS.map((p) => p.id))
  const { app, page, inv } = await lib.launch({ userData, viewport: SMALLEST })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  try {
    // Combwork has finished looking for the CLIs (launch waits for it): nothing it finds replaces the stand-ins below.
    const sendEvent = (e) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), e)
    for (const p of PROVIDERS) await sendEvent({ type: 'provider-install', provider: p.id, info: stubInfo(p) })

    await page.keyboard.press('Control+Shift+P')
    check('the command palette opens', !!(await lib.until(async () => (await page.locator('.palette input').count()) === 1, HUNG_MS)))
    await page.locator('.palette input').fill('Provider Setup')
    await lib.until(async () => (await page.locator('.palette-list', { hasText: 'Provider Setup' }).count()) === 1, HUNG_MS)
    await page.keyboard.press('Enter')
    const setup = page.locator('.dialog', { hasText: 'Provider Setup' })
    check('Provider Setup opens', !!(await lib.until(async () => (await setup.count()) === 1, HUNG_MS)))

    const theme = async (t) => {
      await inv('settings:update', { appearance: { theme: t } })
      return !!(await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === t, HUNG_MS))
    }
    for (const p of PROVIDERS) {
      await setup.locator('.setup-tab', { hasText: p.name }).click()
      const row = setup.locator('.setup-status', { hasText: `${p.name} 1.0.97` })
      check(`${p.name}: its tab shows the CLI at the long path`, !!(await lib.until(async () => (await row.locator('.setup-path').textContent().catch(() => '')) === longPath(p.exe), HUNG_MS)))
      check(`${p.name}: the full path is in its tooltip`, (await row.locator('.setup-path').getAttribute('title')) === longPath(p.exe))
      for (const t of ['dark', 'light']) {
        check(`${p.name} (${t}): the theme applies`, await theme(t))
        const m = await page.evaluate(() => {
          const dialog = document.querySelector('.dialog')
          const body = dialog?.querySelector('.dialog-body')
          const status = dialog?.querySelector('.setup-status')
          const box = (el) => {
            const r = el?.getBoundingClientRect()
            return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width } : null
          }
          const signIn = [...(status?.querySelectorAll('.setup-actions button') ?? [])].find((b) => b.textContent?.trim() === 'Sign in')
          return {
            dialog: box(dialog),
            body: body ? { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth } : null,
            row: box(status),
            path: box(status?.querySelector('.setup-path')),
            tested: box(status?.querySelector('.setup-tested')),
            signIn: box(signIn),
            window: window.innerWidth
          }
        })
        const inside = (b) => !!b && !!m.row && b.width > 0 && b.left >= m.row.left - 0.5 && b.right <= m.row.right + 0.5
        check(`${p.name} (${t}): the dialog is at its narrowest and inside the window`, !!m.dialog && m.dialog.width <= 760.5 && m.dialog.right <= m.window, JSON.stringify(m))
        check(`${p.name} (${t}): the dialog doesn't scroll sideways`, !!m.body && m.body.scrollWidth <= m.body.clientWidth, JSON.stringify(m.body))
        check(`${p.name} (${t}): the status row stays inside the dialog`, !!m.row && m.row.right <= m.dialog.right, JSON.stringify(m))
        check(`${p.name} (${t}): the path wraps inside the row`, inside(m.path) && m.path.bottom - m.path.top > 20, JSON.stringify(m.path))
        check(`${p.name} (${t}): the tested line is inside the row`, inside(m.tested), JSON.stringify(m.tested))
        check(`${p.name} (${t}): Sign in is in sight, inside the row`, inside(m.signIn) && (await row.getByRole('button', { name: 'Sign in' }).isVisible()), JSON.stringify(m))
        await page.screenshot({ path: path.join(shots, `${p.id}-${t}.png`) })
      }
    }
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
