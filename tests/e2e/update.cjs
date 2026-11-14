// Combwork's updater against a local fake release feed (generic provider): automatic check + download,
// status bar states, update dialog, manual download, skip, auto-check off, errors, dev-build
// disabled state, Restart and Update through the quit flow (test mode never installs anything). #1647: what an install
// would replace is a stand-in installed copy (CW_TEST_RESOURCES, fakeInstall.cjs): an older one is replaced, a local
// build of the same version never (Restart and Update says so), a local build is offered a release of its own version
// (Open Release Page) and Settings → Updates names it, and the install on quit comes only from a quit that goes ahead.
// Throwaway profiles; the download cache is %LOCALAPPDATA%\combwork-test-updater (deleted before/after), or
// combwork-test-updater-<k> for a runner in e2e lane k (lanes.mjs), so runners at once don't share it.
const lib = require('./lib.cjs')
const { fakeInstall } = require('./fakeInstall.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto')
const scratch = lib.WORK
const lane = /[\\/]lanes[\\/](\d+)[\\/]update(?:-\d+)?$/.exec(scratch)?.[1]
const cacheName = lane ? `combwork-test-updater-${lane}` : 'combwork-test-updater'
const cache = path.join(process.env.LOCALAPPDATA, cacheName)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }

// --- fake release server
let release = null // { version, file: Buffer, notes }
let downloads = 0
// A download the test holds half way (#729): the server waits for it before sending the rest, so the test sees the
// progress whatever the machine's speed (a 3 s download could finish between two looks under load).
let holdDownload = null
const deferred = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}
const server = http.createServer(async (req, res) => {
  if (!release) { res.writeHead(404); return res.end('Not Found') }
  const name = `Combwork-Setup-${release.version}.exe`
  if (req.url.startsWith('/latest.yml')) {
    const sha512 = crypto.createHash('sha512').update(release.file).digest('base64')
    res.writeHead(200, { 'Content-Type': 'text/yaml' })
    return res.end(`version: ${release.version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${release.file.length}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '2026-09-30T10:00:00.000Z'\nreleaseNotes: |\n${release.notes.split('\n').map((l) => '  ' + l).join('\n')}\n`)
  }
  if (req.url === `/${name}`) {
    downloads++
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': release.file.length })
    // Slow enough to see progress.
    for (let i = 0; i < release.file.length; i += 256 * 1024) {
      if (holdDownload && i >= release.file.length / 2) {
        await holdDownload.promise
        holdDownload = null
      }
      res.write(release.file.subarray(i, i + 256 * 1024))
      await sleep(130)
    }
    return res.end()
  }
  res.writeHead(404); res.end('Not Found')
})

async function launch(profile, extraEnv = {}) {
  const env = lib.combworkEnv({ CW_USER_DATA: path.join(scratch, profile), CW_UPDATE_CACHE: cacheName, ...extraEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  await page.keyboard.press('Escape') // first-run setup dialog, if any
  return { app, page, inv: (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a]) }
}
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(250) } return false }
const statusText = (page) => page.locator('.statusbar .status-item').last().innerText()
/** Whether the app's process has exited, waited for (#1647): set up before what makes it quit. */
const exits = (a) => {
  let gone = false
  a.process().once('exit', () => (gone = true))
  return () => lib.until(async () => gone, HUNG_MS)
}
/**
 * Sets the fake agent working until the test lets it go (HI-3167, HR1's round 1): its turn holds until `hold` is made in
 * its home (holduntil, released by `letGo`), so no step after it races the turn's end. Waited for.
 */
const busy = async (inv, proj, agent, hold) => {
  const status = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)?.status
  const working = async () => (await status()) === 'working'
  await lib.sendPrompt(inv, lib.ptyKey(proj, agent.id), `please work 1 holduntil ${hold}`, { submitted: working, ready: async () => (await status()) === 'ready' })
  return lib.until(working, HUNG_MS)
}
/** Lets a held turn end (busy's `hold`), in the fake's home. */
const letGo = (home, hold) => fs.writeFileSync(path.join(home, hold), '')
const log = (profile) => { try { return fs.readFileSync(path.join(scratch, profile, 'logs', 'combwork.log'), 'utf8') } catch { return '' } }

;(async () => {
  for (const d of ['upd-a', 'upd-b', 'upd-c', 'upd-d', 'upd-e', 'upd-f', 'upd-g', 'upd-g-ws', 'upd-g-claude', 'upd-h', 'upd-h-ws', 'upd-h-claude', 'res-older', 'res-local', 'res-same']) fs.rmSync(path.join(scratch, d), { recursive: true, force: true })
  // The installed copy an install would replace (#1647): an older release, unless a case says otherwise.
  const older = fakeInstall(path.join(scratch, 'res-older'), { version: '9.1.0' })
  fs.rmSync(cache, { recursive: true, force: true })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const feed = `http://127.0.0.1:${server.address().port}/`
  release = { version: '9.1.1', file: crypto.randomBytes(6 * 1024 * 1024), notes: "## What's new\n\n- Faster **everything**\n- A new thing" }

  // 1. Defaults: automatic check finds 9.1.1 and downloads it, held half way until its progress has been seen.
  holdDownload = deferred()
  let { app, page, inv } = await launch('upd-a', { CW_UPDATE_FEED: feed, CW_UPDATE_DELAY: '1500', CW_TEST_RESOURCES: older })
  const sawDownloading = await waitFor(async () => /Downloading Combwork 9.1.1/.test(await statusText(page)), HUNG_MS)
  check('status bar shows the download', sawDownloading)
  await page.screenshot({ path: path.join(scratch, 'upd-1-downloading.png') })
  let maxPct = 0
  const sawProgress = await waitFor(async () => {
    const s = await inv('update:state')
    if (s.status === 'downloading') maxPct = Math.max(maxPct, s.progress?.percent ?? 0)
    return maxPct > 10
  }, HUNG_MS)
  holdDownload?.resolve()
  check('progress reported while downloading', sawProgress && maxPct <= 100, `max ${Math.round(maxPct)}%`)
  const ready = await waitFor(async () => (await inv('update:state')).status === 'ready', HUNG_MS)
  check('update downloaded and verified', ready && downloads === 1, `downloads ${downloads}`)
  check('status bar: restart to update', await waitFor(async () => /Restart to update to 9.1.1/.test(await statusText(page)), HUNG_MS), await statusText(page))
  check('toast offers Restart and Update', await waitFor(async () => (await page.locator('.toast', { hasText: 'Combwork 9.1.1 is ready' }).count()) === 1, HUNG_MS))
  check('install mode auto logged', /install auto/.test(log('upd-a')))
  await page.locator('.statusbar .update-item').click(); await sleep(500)
  const dlg = page.locator('.dialog', { hasText: 'Update Ready' })
  check('dialog shows version and notes', (await dlg.innerText()).includes('Combwork 9.1.1 is ready to install') && (await dlg.locator('.update-notes strong').innerText()) === 'everything')
  check('dialog has Restart and Update', await dlg.locator('button', { hasText: 'Restart and Update' }).count() === 1)
  await page.screenshot({ path: path.join(scratch, 'upd-2-ready.png') })
  await dlg.locator('button', { hasText: 'Later' }).click(); await sleep(300)
  // Tray and palette commands exist
  // About shows the status row
  await page.evaluate(() => window.combwork.invoke('app:info'))
  // Restart and Update goes through the quit flow; test mode quits without installing.
  const closed = new Promise((r) => app.process().once('exit', r))
  await inv('update:install')
  await Promise.race([closed, sleep(10000)])
  // HI-3167: asks nothing more (no agent working), and the installer would be shown, never silent.
  check('Restart and Update quits (test mode: no install), the installer shown', /Test mode: would install 9.1.1 \(Restart and Update\), the installer shown/.test(log('upd-a')))

  // 2. Manual download, and install mode manual.
  fs.mkdirSync(path.join(scratch, 'upd-b'), { recursive: true })
  fs.writeFileSync(path.join(scratch, 'upd-b', 'config.json'), JSON.stringify({ version: 1, settings: { updates: { downloadAutomatically: false, install: 'manual' } } }))
  fs.rmSync(cache, { recursive: true, force: true }); downloads = 0
  ;({ app, page, inv } = await launch('upd-b', { CW_UPDATE_FEED: feed, CW_UPDATE_DELAY: '1500' }))
  await waitFor(async () => (await inv('update:state')).status === 'available')
  await lib.sleep(1500) // A fixed wait on purpose: this checks that nothing downloads by itself (the feed answers after 1.5 s), which no condition can show.
  check('not downloaded automatically', (await inv('update:state')).status === 'available' && downloads === 0)
  check('status bar: available', /Combwork 9.1.1 available/.test(await statusText(page)), await statusText(page))
  check('install mode manual logged', /download manual, install manual/.test(log('upd-b')))
  await page.locator('.statusbar .update-item').click(); await sleep(400)
  await page.screenshot({ path: path.join(scratch, 'upd-3-available.png') })
  await page.locator('.dialog button', { hasText: 'Download' }).click()
  check('Download from the dialog', await waitFor(async () => (await inv('update:state')).status === 'ready', 30000) && downloads === 1)
  await page.keyboard.press('Escape')
  // Skip: a newer version, found by a manual check, skipped; the next automatic check ignores it.
  release = { ...release, version: '9.1.2', notes: '- Even more' }
  await app.close()
  ;({ app, page, inv } = await launch('upd-b', { CW_UPDATE_FEED: feed, CW_UPDATE_DELAY: '600000' }))
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.combwork.invoke('update:check'))
  let st = await inv('update:state')
  check('manual check finds 9.1.2', st.status === 'available' && st.version === '9.1.2', JSON.stringify({ s: st.status, v: st.version }))
  await inv('update:skip', '9.1.2')
  st = await inv('update:state')
  check('skip hides it', st.status === 'up-to-date' && st.skipped === true)
  await app.close()
  ;({ app, page, inv } = await launch('upd-b', { CW_UPDATE_FEED: feed, CW_UPDATE_DELAY: '1000' }))
  await waitFor(async () => ['up-to-date', 'available'].includes((await inv('update:state')).status))
  st = await inv('update:state')
  check('automatic check ignores the skipped version', st.status === 'up-to-date' && st.skipped === true, st.status)
  check('status bar plain', /^\s*Combwork Dev \d+\.\d+\.\d+/.test(await statusText(page)), await statusText(page))
  // Manual check still offers it (marked skipped)
  st = await inv('update:check')
  check('manual check still shows a skipped version', st.status === 'available' && st.skipped === true)
  await app.close()

  // 3. Automatic checks off: nothing happens at startup; manual check works.
  fs.mkdirSync(path.join(scratch, 'upd-c'), { recursive: true })
  fs.writeFileSync(path.join(scratch, 'upd-c', 'config.json'), JSON.stringify({ version: 1, settings: { updates: { checkAutomatically: false } } }))
  ;({ app, page, inv } = await launch('upd-c', { CW_UPDATE_FEED: feed, CW_UPDATE_DELAY: '1000' }))
  await lib.sleep(3000) // A fixed wait on purpose: this checks that no check starts by itself, which no condition can show.
  check('no automatic check when off', (await inv('update:state')).status === 'idle')
  // Settings → Updates renders
  await page.keyboard.press('Control+,'); await sleep(600)
  await page.locator('.settings-nav .row', { hasText: 'Updates' }).click(); await sleep(400)
  const settingsText = await page.locator('.settings').innerText()
  check('Settings → Updates has the four options', ['Check for updates automatically', 'Download updates automatically', 'Install updates', 'Include pre-releases'].every((t) => settingsText.includes(t)))
  await page.screenshot({ path: path.join(scratch, 'upd-4-settings.png') })
  // 4. Errors: no release published (404).
  release = null
  await page.locator('.settings button', { hasText: 'Check Now' }).click(); await lib.until(async () => (await inv('update:state')).status === 'error', 10000)
  st = await inv('update:state')
  check('404 → "no release published yet"', st.status === 'error' && /No release of Combwork has been published yet/.test(st.error), st.error)
  check('error dialog shown', await page.locator('.dialog', { hasText: 'No release of Combwork has been published yet' }).count() === 1)
  await page.screenshot({ path: path.join(scratch, 'upd-5-error.png') })
  await app.close()

  // 5. A dev build without a feed: updates disabled.
  ;({ app, page, inv } = await launch('upd-d'))
  st = await inv('update:state')
  check('dev build: disabled', st.status === 'disabled' && /installed app/.test(st.error))
  await page.keyboard.press('F1'); await sleep(400)
  await page.locator('.split-list .row', { hasText: 'About Combwork' }).click()
  check('About shows the update status', await waitFor(async () => /installed app/.test(await page.locator('.about-update').innerText().catch(() => '')), HUNG_MS))
  await page.screenshot({ path: path.join(scratch, 'upd-6-about.png') })
  await app.close()

  // 6. #1647: the installed copy a local build of 9.1.1: the downloaded 9.1.1 is never installed over it.
  release = { version: '9.1.1', file: crypto.randomBytes(2 * 1024 * 1024), notes: 'Same version' }
  const sameLocal = fakeInstall(path.join(scratch, 'res-local'), { version: '9.1.1', identity: { version: '9.1.1', commit: 'abc1234def', local: true } })
  ;({ app, page, inv } = await launch('upd-e', { CW_UPDATE_FEED: feed, CW_UPDATE_DELAY: '1000', CW_TEST_RESOURCES: sameLocal }))
  check('#1647: the release is downloaded', await waitFor(async () => (await inv('update:state')).status === 'ready', HUNG_MS))
  await inv('update:install')
  check('#1647: Restart and Update over a local build of its version: not installed, and said so', await waitFor(async () => (await page.locator('.toast', { hasText: "Combwork 9.1.1 wasn't installed" }).count()) === 1, HUNG_MS) && (await inv('update:state')).notInstalled === 'notNewer')
  check('#1647: …and Combwork is still running', (await inv('update:state')).status === 'ready' && !/would install/.test(log('upd-e')))
  await page.screenshot({ path: path.join(scratch, 'upd-7-not-installed.png') })
  const exitedE = exits(app)
  await inv('app:quit')
  await exitedE()
  check('#1647: its quit (install automatic) installs nothing', /Not installing 9.1.1/.test(log('upd-e')) && !/would install/.test(log('upd-e')))

  // 7. #1647: running a local build, a release of its own version is offered (its page), and Settings names the build.
  const own = JSON.parse(fs.readFileSync(path.join(lib.ROOT, 'package.json'), 'utf8')).version
  release = { version: own, file: crypto.randomBytes(1024 * 1024), notes: 'Same as the local build' }
  const sameRunning = fakeInstall(path.join(scratch, 'res-same'), { version: own, identity: { version: own, commit: 'abc1234def', local: true } })
  const downloadsBefore = downloads
  ;({ app, page, inv } = await launch('upd-f', { CW_UPDATE_FEED: feed, CW_UPDATE_DELAY: '1000', CW_TEST_RESOURCES: sameRunning }))
  check(`#1647: a published ${own} offered to the local ${own}, never downloaded`, await waitFor(async () => (await inv('update:state')).published === own, HUNG_MS) && downloads === downloadsBefore)
  const offer = page.locator('.toast', { hasText: `A published Combwork ${own} is available` })
  check('#1647: …by a notice whose button opens its release page', await waitFor(async () => (await offer.count()) === 1, HUNG_MS) && (await offer.locator('button', { hasText: 'Open Release Page' }).count()) === 1)
  await page.keyboard.press('Control+,')
  // The click waits for Settings' navigation to be there (Playwright's own wait, bounded).
  await page.locator('.settings-nav .row', { hasText: 'Updates' }).click({ timeout: HUNG_MS })
  check('#1647: Settings → Updates says it is a local build, with its commit', await waitFor(async () => (await page.locator('.settings').innerText()).includes(`Local build ${own} (abc1234)`), HUNG_MS))
  await page.screenshot({ path: path.join(scratch, 'upd-8-local-build.png') })
  await app.close()

  // 8. #1647: install on quit comes from a quit that goes ahead: cancelled (an agent running, Confirm on quit: always),
  // nothing; then quit, and it would install (test mode).
  release = { version: '9.1.1', file: crypto.randomBytes(2 * 1024 * 1024), notes: 'On quit' }
  const gProfile = path.join(scratch, 'upd-g')
  const gWs = path.join(scratch, 'upd-g-ws')
  fs.mkdirSync(path.join(gWs, 'alpha'), { recursive: true })
  fs.mkdirSync(gProfile, { recursive: true })
  fs.writeFileSync(path.join(gProfile, 'config.json'), JSON.stringify({ version: 1, settings: { general: { confirmOnQuit: 'always' } } }))
  const claude = lib.fakeClaude(gProfile, path.join(scratch, 'upd-g-claude'), [path.join(gWs, 'alpha')])
  ;({ app, page, inv } = await launch('upd-g', { CW_UPDATE_FEED: feed, CW_UPDATE_DELAY: '1000', CW_TEST_RESOURCES: older, ...claude }))
  await lib.openWorkspace(inv, page, gWs)
  await lib.waitForProvider(inv)
  const agent = await lib.addAgent(inv, path.join(gWs, 'alpha'))
  await inv('session:start', path.join(gWs, 'alpha'), { agentId: agent.id })
  await lib.acceptClaudeTrust(inv, path.join(gWs, 'alpha'), agent.id)
  check('#1647: downloaded, an agent running', await waitFor(async () => (await inv('update:state')).status === 'ready' && (await inv('session:live')).length === 1, HUNG_MS))
  // HI-2425: the notice's Restart and Update, then Cancel in the quit dialog: its entry keeps the button and never says
  // Installing.
  const readyRow = () => page.evaluate(() => window.__cwBell?.().find((t) => t.title === 'Combwork 9.1.1 is ready') ?? null)
  check('HI-2425: the ready notice is in the bell, with Restart and Update', !!(await lib.until(async () => (await readyRow())?.actions.includes('Restart and Update'), HUNG_MS)))
  await inv('update:install', '9.1.1')
  check('HI-2425: Restart and Update asks first (an agent is running)', await waitFor(async () => (await page.locator('.dialog', { hasText: 'Quit Combwork?' }).count()) === 1, HUNG_MS))
  await page.locator('.dialog button', { hasText: 'Cancel' }).click()
  await waitFor(async () => (await inv('app:quitState')).request === null, HUNG_MS)
  const afterCancel = await readyRow()
  check('HI-2425: cancelled, its notice keeps Restart and Update and says nothing of installing', !!afterCancel && afterCancel.resolved === null && afterCancel.actions.includes('Restart and Update'), JSON.stringify(afterCancel))
  await inv('app:quit')
  check('#1647: quitting asks first (an agent is running)', await waitFor(async () => (await page.locator('.dialog', { hasText: 'Quit Combwork?' }).count()) === 1, HUNG_MS))
  await page.locator('.dialog button', { hasText: 'Cancel' }).click()
  check('#1647: a cancelled quit installs nothing, and Combwork goes on', await waitFor(async () => (await inv('app:quitState')).request === null, HUNG_MS) && !/would install/.test(log('upd-g')) && (await inv('session:live')).length === 1)
  // HI-2427: Restart and Update while an ordinary quit's dialog waits only brings that dialog forward; Cancel there
  // leaves no install or restart for the next quit, the one below that goes ahead (it installs on quit, never "and
  // restart").
  await inv('app:quit')
  await waitFor(async () => (await page.locator('.dialog', { hasText: 'Quit Combwork?' }).count()) === 1, HUNG_MS)
  await inv('update:install', '9.1.1')
  check('HI-2427: Restart and Update during an open quit dialog asks nothing more', await waitFor(async () => /Restart and Update while a question is open/.test(log('upd-g')), HUNG_MS) && (await page.locator('.dialog', { hasText: 'Quit Combwork?' }).count()) === 1)
  await page.locator('.dialog button', { hasText: 'Cancel' }).click()
  check('HI-2427: cancelled, nothing installs and Combwork goes on', await waitFor(async () => (await inv('app:quitState')).request === null, HUNG_MS) && !/would install/.test(log('upd-g')) && (await inv('session:live')).length === 1)
  // HI-3167: the quit that goes ahead asks about the update in its dialog, beside the agents (Install now chosen to begin
  // with); Install now is kept through Quit when the agent finishes, then installs it over the older copy (test mode: none).
  check('HI-3167: the agent is set working, held', await busy(inv, path.join(gWs, 'alpha'), agent, 'upd-g-go'))
  const exitedG = exits(app)
  await inv('app:quit')
  const gDialog = page.locator('.dialog', { hasText: 'Quit Combwork?' })
  await waitFor(async () => (await gDialog.count()) === 1, HUNG_MS)
  check('HI-3167: the quit dialog offers the update, beside the agents, Install now chosen', await waitFor(async () => (await gDialog.locator('.quit-update').innerText().catch(() => '')).includes('Combwork 9.1.1 is ready to install.'), HUNG_MS) && (await gDialog.locator('.quit-update-choice button.active').innerText()).includes('Install now') && (await gDialog.locator('.quit-agents').isVisible()))
  check('HI-3167: …and says not to shut down until the installer says it has finished', (await gDialog.locator('.quit-update').innerText()).includes("Don't shut down or restart the PC until the installer says it has finished"))
  await page.screenshot({ path: path.join(scratch, 'upd-9-quit-update.png') })
  await gDialog.locator('button', { hasText: 'Quit when' }).click()
  check('HI-3167: the quit waits for the agent, Install now chosen', await waitFor(async () => (await inv('app:quitState')).pending === true, HUNG_MS) && /Install now chosen for 9\.1\.1/.test(log('upd-g')) && !/would install/.test(log('upd-g')))
  letGo(path.join(scratch, 'upd-g-claude'), 'upd-g-go')
  await exitedG()
  check('#1647, HI-3167: Install now, kept through Quit when the agent finishes, installs it over the older copy (test mode: no install)', /Test mode: would install 9.1.1 \(Install now\), the installer shown/.test(log('upd-g')), log('upd-g').split('\n').filter((l) => /updates\]|exit\]/.test(l)).slice(-5).join(' | '))

  // 9. HI-3167: an update ready only after the quit was asked for (Quit when the agent finishes) was never offered, so it
  // isn't installed; the next start asks, with no agent running: Next time installs nothing, Install now installs it.
  const hProfile = path.join(scratch, 'upd-h')
  const hWs = path.join(scratch, 'upd-h-ws')
  fs.mkdirSync(path.join(hWs, 'alpha'), { recursive: true })
  fs.mkdirSync(hProfile, { recursive: true })
  const hClaude = lib.fakeClaude(hProfile, path.join(scratch, 'upd-h-claude'), [path.join(hWs, 'alpha')])
  ;({ app, page, inv } = await launch('upd-h', { CW_UPDATE_FEED: feed, CW_UPDATE_DELAY: '600000', CW_TEST_RESOURCES: older, ...hClaude }))
  await lib.openWorkspace(inv, page, hWs)
  await lib.waitForProvider(inv)
  const hAgent = await lib.addAgent(inv, path.join(hWs, 'alpha'))
  await inv('session:start', path.join(hWs, 'alpha'), { agentId: hAgent.id })
  await lib.acceptClaudeTrust(inv, path.join(hWs, 'alpha'), hAgent.id)
  const hHome = path.join(scratch, 'upd-h-claude')
  check('HI-3167: no update yet, the agent working, held', (await inv('update:state')).status !== 'ready' && (await busy(inv, path.join(hWs, 'alpha'), hAgent, 'upd-h-go')))
  const exitedH = exits(app)
  await inv('app:quit')
  const hDialog = page.locator('.dialog', { hasText: 'Quit Combwork?' })
  check('HI-3167: the quit dialog has no update to offer', (await waitFor(async () => (await hDialog.count()) === 1, HUNG_MS)) && (await hDialog.locator('.quit-update').count()) === 0)
  await hDialog.locator('button', { hasText: 'Quit when' }).click()
  check('HI-3167: the quit waits for the agent', await waitFor(async () => (await inv('app:quitState')).pending === true, HUNG_MS))
  await inv('update:check')
  check('HI-3167: the update downloaded while the quit waits', await waitFor(async () => (await inv('update:state').catch(() => null))?.status === 'ready', HUNG_MS) && (await inv('app:quitState')).pending === true)
  letGo(hHome, 'upd-h-go')
  await exitedH()
  check('HI-3167: …and the quit, never asked about it, installs nothing', !/would install/.test(log('upd-h')) && /Leaving by app\.quit/.test(log('upd-h')), log('upd-h').split('\n').filter((l) => /updates\]|exit\]/.test(l)).slice(-5).join(' | '))
  for (const answer of ['Next time', 'Install now']) {
    ;({ app, page, inv } = await launch('upd-h', { CW_UPDATE_FEED: feed, CW_UPDATE_DELAY: '1000', CW_TEST_RESOURCES: older, ...hClaude }))
    await waitFor(async () => (await inv('update:state')).status === 'ready', HUNG_MS)
    const before = log('upd-h').length
    const exited = exits(app)
    await inv('app:quit')
    const d = page.locator('.dialog', { hasText: 'Quit Combwork?' })
    check(`HI-3167 (${answer}): with no agent running, the quit still asks, about the update alone`, (await waitFor(async () => (await d.locator('.quit-update').count()) === 1, HUNG_MS)) && !(await d.locator('.quit-agents').isVisible()))
    await d.locator('.quit-update-choice button', { hasText: answer }).click()
    if (answer === 'Next time') check('HI-3167: Next time says it stays downloaded and is asked again', (await d.locator('.quit-update').innerText()).includes('asks again the next time you quit'))
    await page.screenshot({ path: path.join(scratch, `upd-10-${answer === 'Next time' ? 'later' : 'now'}.png`) })
    await d.locator('button.btn.primary').click()
    await exited()
    const said = log('upd-h').slice(before)
    check(`HI-3167 (${answer}): ${answer === 'Next time' ? 'quits without installing' : 'installs it, the installer shown (test mode: no install)'}`, answer === 'Next time' ? !/would install/.test(said) : /Test mode: would install 9.1.1 \(Install now\), the installer shown/.test(said), said.split('\n').filter((l) => /updates\]|exit\]/.test(l)).slice(-4).join(' | '))
  }

  // 10. HI-3167 (HR1's round 1): Close this window only takes back a pending quit's Install now. Two windows; Install now and
  // Quit when the agent finishes; the first window shown again with a file left unsaved; the turn ends, and the quit's last
  // look at unsaved files asks there: Close this window only. The quit then goes ahead, and installs nothing.
  {
    ;({ app, page, inv } = await launch('upd-h', { CW_UPDATE_FEED: feed, CW_UPDATE_DELAY: '1000', CW_TEST_RESOURCES: older, ...hClaude }))
    await waitFor(async () => (await inv('update:state')).status === 'ready', HUNG_MS)
    await inv('session:start', path.join(hWs, 'alpha'), { agentId: hAgent.id })
    check('HI-3167 (window only): the agent working, held', await busy(inv, path.join(hWs, 'alpha'), hAgent, 'upd-h-window-go'))
    const second = app.waitForEvent('window', { timeout: HUNG_MS })
    await inv('window:new')
    await second
    check('HI-3167 (window only): two windows open', await waitFor(async () => (await inv('window:count')) === 2, HUNG_MS))
    const before = log('upd-h').length
    const exitedW = exits(app)
    await inv('app:quit')
    // The quit dialog is the window last used's: either one.
    const asking = async () => {
      for (const p of app.windows()) if ((await p.locator('.dialog', { hasText: 'Quit Combwork' }).count().catch(() => 0)) === 1) return p
      return null
    }
    const shownIn = await lib.until(asking, HUNG_MS)
    const first = shownIn?.locator('.dialog', { hasText: 'Quit Combwork' })
    check('HI-3167 (window only): the quit offers the update, Install now chosen', !!first && (await first.locator('.quit-update-choice button.active').innerText()).includes('Install now'))
    await first?.locator('button', { hasText: 'Quit when' }).click()
    check('HI-3167 (window only): the quit waits, with Install now', await waitFor(async () => (await inv('app:quitState')).pending === true, HUNG_MS) && /Install now chosen for 9\.1\.1/.test(log('upd-h').slice(before)))
    // The workspace's window shown again (as the tray's Show Combwork does; a test copy never takes the focus), and a file left
    // unsaved there, as its page reports one.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => /upd-h-ws/.test(w.getTitle()))?.showInactive())
    await inv('files:setUnsaved', [path.join(hWs, 'alpha', 'notes.md')])
    letGo(hHome, 'upd-h-window-go')
    const only = page.locator('.dialog button', { hasText: 'Close this window only' })
    check('HI-3167 (window only): the turn ends, and the last look at unsaved files offers Close this window only', await waitFor(async () => (await only.count()) === 1, HUNG_MS))
    await only.click()
    await exitedW()
    const said = log('upd-h').slice(before)
    check('HI-3167 (window only): the quit goes ahead and installs nothing', !/would install/.test(said) && /Leaving by app\.quit/.test(said), said.split('\n').filter((l) => /updates\]|exit\]/.test(l)).slice(-4).join(' | '))
  }

  server.close()
  // The download cache is outside combwork-test (no housekeeping there), so it goes, but never at the cost of a suite whose
  // checks passed (#324): lib.tidyUp retries a held file a few times, then leaves it for the next run's clear.
  lib.tidyUp(cache)
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); lib.tidyUp(cache); process.exit(1) })
