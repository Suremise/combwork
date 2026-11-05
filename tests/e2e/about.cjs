// About dialog licence links, the License / Third-Party Notices docs pages, and Help → Copy Diagnostics (redacted preview, copied to a fake clipboard). Throwaway profile.
// Also the Node Electron bundles, the packaged app's too (the same electron.exe): 24.22.1 or later, CVE-2026-111497's fix (HI-1503).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
const scratch = lib.WORK, userData = path.join(scratch, 'about-profile')
fs.rmSync(userData, { recursive: true, force: true })
// A log as after an upgrade: a run of 0.3.1 (which didn't mark the user's text) with a card title in it, then a run
// that marks, with a secret and the home folder in it. Copy Diagnostics takes all three out.
fs.mkdirSync(path.join(userData, 'logs'), { recursive: true })
fs.writeFileSync(path.join(userData, 'logs', 'hive.log'), [
  '2026-10-01T09:00:00.000Z [INFO] [main] Hive 0.3.1 starting (Electron 44.5.1)',
  '2026-10-01T09:01:00.000Z [INFO] [tasks] #1 created by You: Legacy confidential takeover notes',
  '2026-10-02T09:00:00.000Z [INFO] [main] Hive 0.3.1 starting (Electron 44.5.1; your text marked)',
  `2026-10-02T09:00:01.000Z [INFO] [test] token=SECRETVALUE123 at ${path.join(require('os').homedir(), 'x')}`,
  ''
].join('\n'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }
// The longest a check waits for its condition: a bound for a hung run, never how long the step should take.
const HUNG_MS = 10000
/** Whether fn() comes true (checked until it does, up to HUNG_MS). */
const becomes = async (fn) => !!(await lib.until(fn, HUNG_MS))
;(async () => {
  const env = lib.hiveEnv({ CW_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 850 })
  await lib.appReady(page)
  // Node2Shell (CVE-2026-111497, Node's Brotli decoder): fixed in 24.22.1, so a downgrade of Electron fails here (HI-1503).
  const node = await app.evaluate(() => process.versions.node)
  const atLeast = (v, min) => {
    const [a, b] = [v, min].map((x) => x.split('.').map(Number))
    const i = a.findIndex((n, k) => n !== b[k])
    return i < 0 || a[i] > b[i]
  }
  check('Electron bundles Node 24.22.1 or later (CVE-2026-111497)', atLeast(node, '24.22.1'), node)
  // Setup dialog may show on a fresh profile; close any modal first.
  await page.keyboard.press('Escape'); await sleep(300)
  await page.evaluate(() => window.combwork.invoke('app:info')) // warm
  await page.keyboard.press('F1')
  await page.locator('.split-list .row', { hasText: 'About Combwork' }).click()
  check('About shows MIT link', await becomes(() => page.locator('.about-licence a', { hasText: 'MIT License' }).isVisible()))
  await page.screenshot({ path: path.join(scratch, 'about-1.png') })
  await page.locator('.about-licence a', { hasText: 'MIT License' }).click()
  const pageText = () => page.locator('.scroll-page').innerText({ timeout: 1000 }).catch(() => '')
  check('License page opens', await becomes(async () => (await pageText()).includes('Permission is hereby granted')))
  await page.locator('.scroll-page a', { hasText: 'third-party notices' }).click()
  const notices = (t) => t.includes('Third-party notices') && t.includes('monaco-editor') && t.includes('@xterm/xterm')
  check('Notices page opens via link', await becomes(async () => notices(await pageText())))
  await page.screenshot({ path: path.join(scratch, 'about-2-notices.png') })
  // Not clicked: it would open the file in the real browser. The file it opens is next to electron.exe.
  check('Chromium licence file exists next to the exe', fs.existsSync(path.join(lib.ROOT, 'node_modules/electron/dist/LICENSES.chromium.html')))
  // --- Help → Copy Diagnostics: a redacted preview, copied as shown (a fake clipboard in the page).
  await page.keyboard.press('Escape'); await sleep(300)
  await page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async (t) => { window.__copied = t } } }) })
  await page.locator('.menubar .menubar-item', { hasText: 'Help' }).click()
  await sleep(300)
  await page.getByText('Copy Diagnostics…', { exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Copy Diagnostics' })
  const preview = dialog.locator('.diagnostics-preview')
  let shown = ''
  for (let i = 0; i < 50 && !/### Log/.test(shown); i++) { await sleep(200); shown = await preview.innerText().catch(() => '') }
  check('Copy Diagnostics shows a preview', /## Combwork diagnostics/.test(shown) && /### Coding agents/.test(shown) && /### Counts/.test(shown) && /### Log \(last 50 lines\)/.test(shown), shown.slice(0, 200))
  check('headed Combwork, with the running version labelled Combwork', /^## Combwork diagnostics\n\n- \*\*Combwork\*\* \d+\.\d+\.\d+\S* \(/.test(shown) && !/\*\*Hive\*\*/.test(shown), shown.slice(0, 200))
  check('with the secret and home folder taken out', !shown.includes('SECRETVALUE123') && shown.includes('token=<redacted>') && !shown.toLowerCase().includes(require('os').homedir().toLowerCase()))
  check("and the older version's card title", !shown.includes('takeover') && shown.includes('[tasks] <message left out: logged by an older version of Combwork>'))
  await page.screenshot({ path: path.join(scratch, 'about-3-diagnostics.png') })
  await dialog.getByRole('button', { name: 'Copy' }).click()
  check('Copy copies exactly what was shown', await becomes(async () => ((await page.evaluate(() => window.__copied)) || '').trim() === shown.trim()))
  check('and closes the dialog', await becomes(async () => (await dialog.count()) === 0))
  check('Codex reports its Windows sandbox', /- \*\*Codex\*\*[^]*?\n {2}- Windows sandbox: (not set up|default \(admin\)|non-admin|not used on this system|[\w-]+)\n/.test(shown), shown.slice(shown.indexOf('**Codex**'), shown.indexOf('**Codex**') + 300))

  // Review finding: card text and the workspaces opened before stayed in the log. A card in one workspace,
  // then another workspace: neither the card's title nor the first workspace's names may be in the report.
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  const secretWs = path.join(scratch, 'about-ConfidentialWorkspace'), otherWs = path.join(scratch, 'about-OtherWorkspace')
  for (const d of [secretWs, otherWs]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(path.join(secretWs, 'PrivateProject'))
  fs.mkdirSync(path.join(otherWs, 'demo'), { recursive: true })
  const openWs = async (ws) => { await inv('workspace:open', ws); await lib.until(async () => page.evaluate((n) => document.title.includes(n), path.basename(ws)), 20000) }
  // The other workspace opened once first: a workspace's first open logs its setting up (its board's schema steps, the
  // bundled skills and modes added), which pushed the card's line out of the report's last 50 (HI-1815).
  await openWs(otherWs)
  await openWs(secretWs)
  await inv('tasks:create', { title: 'Confidential customer merger notes', project: 'PrivateProject' })
  await openWs(otherWs)
  const log = fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8')
  check('the log has the card and the first workspace', log.includes('Confidential customer merger notes') && log.includes('PrivateProject'))
  const report = await inv('app:diagnostics')
  const reportLog = report.slice(report.indexOf('### Log'))
  // What follows is checked on the lines that named them: the report's log reaches back to the card's line.
  check("the report's log reaches back to the card being created", /created by <text>: <text>/.test(reportLog), reportLog)
  console.log(`INFO the card's line is ${reportLog.split('\n').reverse().findIndex((l) => /created by <text>/.test(l))} lines from the end of the report's log (of 50)`)
  check('the report has neither', !/Confidential|merger|PrivateProject/i.test(report), report.split('\n').filter((l) => /Confidential|merger|PrivateProject/i.test(l)).join(' | '))
  check('and says where they were', /Opened workspace <(path|workspace)>/.test(reportLog), reportLog)
  await app.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
