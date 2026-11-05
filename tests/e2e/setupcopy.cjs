// A Copy button beside every command Provider Setup shows (#1204, Darren's Store PowerShell fix): Codex found, with the
// warning about the Microsoft Store's PowerShell 7 and its detail (the symptom's error text, and the uninstall command
// before the winget one, #1512: each as code); Claude Code not installed, with its install note (the installer's command and folder). Each code span has
// its own Copy button; it copies exactly that command (a fake clipboard in the page: the real one is never touched) and
// says Copied for a moment. Sent to the window as main sends them, in the window's language (its catalogue's words):
// no CLI is run, installed or signed in. In German, the install note is the German one (#1404), its commands still
// copyable. Screenshots in both themes and in German. Throwaway profile; quiet.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'setupcopy-profile')
const WINGET = 'winget install --id Microsoft.PowerShell --source winget --installer-type wix'
const REMOVE = 'Get-AppxPackage Microsoft.PowerShell | Remove-AppxPackage'
const IRM = 'irm https://claude.ai/install.ps1 | iex'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** A message's words in a language, from its catalogue: what main sends the window (shownInstallInfo). */
const words = (lang, area, id) => {
  const v = JSON.parse(fs.readFileSync(path.join(lib.ROOT, 'locales', lang, `${area}.json`), 'utf8'))[id]
  return typeof v === 'string' ? v : v.defaultMessage
}
/** Codex found, signed in, with the Store PowerShell warning as main words it (storePwsh.ts). */
const codex = (lang) => ({
  provider: 'codex',
  found: true,
  checking: false,
  path: 'C:\\Users\\someone\\AppData\\Local\\Programs\\OpenAI\\Codex\\codex.exe',
  version: '0.163.0',
  source: 'PATH',
  latestVersion: null,
  updateAvailable: false,
  loggedIn: true,
  authMethod: 'ChatGPT',
  account: null,
  rejected: [],
  readiness: [
    {
      id: 'store-pwsh',
      level: 'warning',
      message: words(lang, 'providers', 'providers.codex.storePwsh.label'),
      detail: [words(lang, 'providers', 'providers.codex.storePwsh.warning'), words(lang, 'providers', 'providers.codex.storePwsh.symptom'), words(lang, 'providers', 'providers.codex.storePwsh.fix')]
    }
  ]
})
/** Claude Code not installed: its install note shows. */
const claude = { provider: 'claude-code', found: false, checking: false, path: null, version: null, source: null, latestVersion: null, updateAvailable: false, loggedIn: null, authMethod: null, account: null, rejected: [], readiness: [] }

async function openSetup(app, page, lang = 'en') {
  const sendEvent = (e) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), e)
  // Combwork has finished looking for the CLIs (launch waits for it): nothing it finds replaces the stand-ins.
  await sendEvent({ type: 'provider-install', provider: 'codex', info: codex(lang) })
  await sendEvent({ type: 'provider-install', provider: 'claude-code', info: claude })
  // A fake clipboard in the page: what a Copy button writes, never the machine's.
  await page.evaluate(() => {
    window.__copied = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async (t) => void window.__copied.push(t) } })
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', { type: 'menu-command', command: 'help.agentSetup', args: [] }))
  const setup = page.locator('.dialog', { has: page.locator('.setup-tab') })
  await lib.until(async () => (await setup.count()) === 1, HUNG_MS)
  return setup
}

;(async () => {
  fs.rmSync(userData, { recursive: true, force: true })
  lib.enableProviders(userData, ['claude-code', 'codex'])
  {
    const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1200, height: 860 } })
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    try {
      const setup = await openSetup(app, page)
      check('Provider Setup opens', (await setup.count()) === 1)
      await setup.locator('.setup-tab', { hasText: 'Codex' }).click()
      const winget = setup.locator(`.copy-code-btn[data-copy-code="${WINGET}"]`)
      check('the winget command has a Copy button beside it', !!(await lib.until(async () => (await winget.count()) === 1, HUNG_MS)))
      check('…and so has the error text, shown as code', (await setup.locator('.copy-code-btn[data-copy-code="CreateProcessAsUserW failed: 5"]').count()) === 1)
      // #1512: winget installs nothing while the Store's copy is there, so its uninstall comes first.
      const copies = await setup.locator('.copy-code-btn').evaluateAll((els) => els.map((e) => e.getAttribute('data-copy-code')))
      check('the uninstall command has its Copy button too, shown before the install', copies.includes(REMOVE) && copies.indexOf(REMOVE) < copies.indexOf(WINGET), JSON.stringify(copies))
      check('its tooltip names what it copies', (await winget.getAttribute('title')) === `Copy ${WINGET}`, await winget.getAttribute('title'))
      // `has` is relative to each .copy-code: the button by its own selector, not the dialog-scoped locator.
      const done = setup.locator('.copy-code', { has: page.locator(`.copy-code-btn[data-copy-code="${WINGET}"]`) }).locator('.copy-code-done')
      await winget.click()
      // Copied shows once the clipboard took it, for a moment: looked for as it shows, with its screenshot.
      const saidCopied = await lib.until(async () => (await done.innerText().catch(() => '')) === 'Copied', HUNG_MS)
      if (saidCopied) await page.screenshot({ path: path.join(lib.WORK, 'setupcopy-codex-dark.png') })
      check('…and says Copied for a moment', !!saidCopied)
      check('it copies exactly the command, nothing around it', !!(await lib.until(async () => JSON.stringify(await page.evaluate(() => window.__copied)) === JSON.stringify([WINGET]), HUNG_MS)), JSON.stringify(await page.evaluate(() => window.__copied)))
      check('Copied goes again', !!(await lib.until(async () => (await done.count()) === 0, HUNG_MS)))

      await setup.locator('.setup-tab', { hasText: 'Claude Code' }).click()
      const irm = setup.locator(`.copy-code-btn[data-copy-code="${IRM}"]`)
      check("Claude Code's install note: the installer's command and its folder each copyable", !!(await lib.until(async () => (await irm.count()) === 1, HUNG_MS)) && (await setup.locator('.copy-code-btn[data-copy-code="%USERPROFILE%\\\\.local\\\\bin"]').count()) === 1)
      await irm.click()
      check('…the installer command copies alone', !!(await lib.until(async () => (await page.evaluate(() => window.__copied.at(-1))) === IRM, HUNG_MS)))
      await inv('settings:update', { appearance: { theme: 'light' } })
      await lib.until(() => page.evaluate(() => document.documentElement.dataset.theme === 'light'), HUNG_MS)
      await page.screenshot({ path: path.join(lib.WORK, 'setupcopy-claude-light.png') })
      await setup.locator('.setup-tab', { hasText: 'Codex' }).click()
      await lib.until(async () => (await winget.count()) === 1, HUNG_MS)
      await page.screenshot({ path: path.join(lib.WORK, 'setupcopy-codex-light.png') })
      await inv('settings:update', { appearance: { theme: 'dark' } })
    } finally {
      await app.close()
    }
  }
  // In German: the install note is German (#1404), the button's name and Copied are translated; the command is as it is.
  {
    const { app, page } = await lib.launch({ userData, env: { HIVE_LANG: 'de' }, viewport: { width: 1200, height: 860 } })
    try {
      const setup = await openSetup(app, page, 'de')
      await setup.locator('.setup-tab', { hasText: 'Claude Code' }).click()
      const note = setup.locator('[data-install-note]')
      await lib.until(async () => (await note.count()) === 1, HUNG_MS)
      const noteText = await note.innerText()
      check("in German: Claude Code's install note is the German one", noteText.startsWith('Der Installer führt') && !noteText.includes('The installer runs'), noteText.slice(0, 80))
      const irm = setup.locator(`.copy-code-btn[data-copy-code="${IRM}"]`)
      await lib.until(async () => (await irm.count()) === 1, HUNG_MS)
      await irm.click()
      check('in German: the command copies as it is, and the button is named in German', !!(await lib.until(async () => (await page.evaluate(() => window.__copied.at(-1))) === IRM, HUNG_MS)) && (await irm.getAttribute('aria-label')) !== 'Copy', await irm.getAttribute('aria-label'))
      await page.screenshot({ path: path.join(lib.WORK, 'setupcopy-claude-de.png') })
      // Codex's Store PowerShell warning as main sends it in German, its command still copyable.
      await setup.locator('.setup-tab', { hasText: 'Codex' }).click()
      check("in German: the Store PowerShell warning's winget command keeps its Copy button", !!(await lib.until(async () => (await setup.locator(`.copy-code-btn[data-copy-code="${WINGET}"]`).count()) === 1, HUNG_MS)))
      await page.screenshot({ path: path.join(lib.WORK, 'setupcopy-codex-de.png') })
    } finally {
      await app.close()
    }
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
