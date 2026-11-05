// A stopped agent's pane looks stopped (HI-1881): stopped from its pane, its terminal is dimmed (its scrollback still
// selected and copied), its bar says "Stopped · {time} · stopped by you" with Resume and New Session, and its header and
// its tile (Tiles) say "Stopped · {time}". Resume takes the stopped look away from the accepted click (the start held a
// moment, so the window between is seen), before the session runs. A lane's end's quit says "its lane ended", the CLI
// crashing "its CLI exited with code 1", and a failed start keeps its failed bar. Screenshots in both themes, Panes and
// Tiles. The fake Claude Code; throwaway profile and workspace. Dev build only: a lane's end's quit is the test copies'
// slots:test channel, and the held and refused starts their IPC test seams, which a packaged Combwork refuses.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const scratch = lib.WORK
const userData = path.join(scratch, 'stoppedpane-profile')
const ws = path.join(scratch, 'stoppedpane-ws')
const proj = path.join(ws, 'demo')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(proj)
  const claude = lib.fakeClaude(userData, path.join(scratch, 'stoppedpane-claude-home'), [proj])
  const env = lib.hiveEnv({ CW_USER_DATA: userData, ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1300, height: 860 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('demo', { exact: true }).first().click()
    const agent = await lib.soloAgent(inv, proj)
    await inv('workspace:refresh')
    const key = lib.ptyKey(proj, agent.id)
    const live = async () => (await inv('session:live')).find((l) => l.agentId === agent.id) ?? null
    const start = async () => {
      await inv('session:start', proj, { agentId: agent.id })
      await lib.acceptClaudeTrust(inv, proj, agent.id)
      return !!(await lib.until(async () => (await live())?.status === 'ready', HUNG_MS))
    }
    check('the session starts', await start())
    const bar = page.locator('.agent-pane .session-ended')
    const host = page.locator('.terminal-host:not(.hidden)')
    const header = lib.paneHeader(page, agent.name)
    const status = header.locator('.pane-status')
    const text = async (l) => (await l.innerText().catch(() => '')).trim()
    const shots = async (name) => {
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.screenshot({ path: path.join(scratch, `stoppedpane-${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }
    check('running: no stopped bar, its terminal not dimmed, its header not stopped', (await bar.count()) === 0 && (await host.evaluate((h) => h.classList.contains('dimmed'))) === false && !/Stopped/.test(await text(status)))

    // --- Stopped from its pane: dimmed, the bar says when and why, the header too.
    await header.getByRole('button', { name: /^Stop/ }).first().click()
    // Its question first (Settings → Sessions → Confirm before stopping, on by default).
    const ask = page.locator('.dialog', { hasText: 'Stop session?' })
    await ask.waitFor({ timeout: HUNG_MS })
    await ask.getByRole('button', { name: 'Stop', exact: true }).click()
    const STOPPED_BY_YOU = /^Stopped · \S.* · stopped by you$/
    check('stopped by you: the bar says when and why', !!(await lib.until(async () => STOPPED_BY_YOU.test(await text(bar.locator('.grow'))) && (await bar.getAttribute('data-stopped')) === 'you', HUNG_MS)), await text(bar))
    check('…with Resume and New Session on it', (await bar.getByRole('button', { name: /Resume/ }).count()) === 1 && (await bar.getByRole('button', { name: 'New Session' }).count()) === 1)
    check('…its terminal dimmed', !!(await lib.until(() => host.evaluate((h) => h.classList.contains('dimmed') && Number(getComputedStyle(h.querySelector('.terminal-mount')).opacity) < 0.8), HUNG_MS)))
    check('…its header says Stopped · {time}', /^Stopped · \S+/.test(await text(status)) && (await status.getAttribute('data-stopped')) === 'you', await text(status))
    // Its own mark grey, not the idle ring's colour (the Assistant's screenshot review): still idle, as it counts.
    const headerMark = header.locator('.state-mark').first()
    const grey = (mark) => mark.evaluate((m) => m.classList.contains('stopped') && m.classList.contains('idle') && getComputedStyle(m).borderTopColor === getComputedStyle(document.querySelector('.pane-status.stopped'), '::before').backgroundColor).catch(() => false)
    check('…its own mark in its header grey (still idle)', !!(await lib.until(() => grey(headerMark), HUNG_MS)), await headerMark.getAttribute('class'))
    // The session toolbar's chip counts it as the project header does (HI-1908): stopped, not idle, both marks grey.
    const chip = page.locator('.summary-chip')
    const projectBadge = page.locator('.project-header .project-state')
    const counted = async () => (await text(chip.locator('.summary-chip-text'))) === '1 stopped' && (await text(projectBadge.locator('.badge-text'))) === '1 stopped' && (await chip.locator('.state-mark.stopped').count()) === 1 && (await projectBadge.locator('.state-mark.stopped').count()) === 1
    check('the chip says 1 stopped, as the project header does, both marks grey', !!(await lib.until(counted, HUNG_MS)), JSON.stringify([await text(chip), await text(projectBadge)]))
    // Its scrollback is still selected and copied (a page clipboard: never the real one).
    await page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async (t) => { window.__copied = t } } }) })
    const box = await host.boundingBox()
    await page.mouse.move(box.x + 14, box.y + 12)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.6, box.y + 60, { steps: 8 })
    await page.mouse.up()
    const selection = () => page.evaluate((k) => window.__hiveTerminalSelection?.(k) ?? '', key)
    check('…its scrollback still selected', !!(await lib.until(async () => (await selection()).trim().length > 0, HUNG_MS)), JSON.stringify(await selection()))
    // Right-click copies a selection in every pane (and clears it): the text selected, as it was.
    const selected = await selection()
    await page.mouse.click(box.x + box.width * 0.3, box.y + 30, { button: 'right' })
    check('…and copied', !!(await lib.until(async () => (await page.evaluate(() => window.__copied)) === selected, HUNG_MS)), JSON.stringify(await page.evaluate(() => window.__copied)))
    await shots('panes')
    // Its tile in Tiles says it too.
    await page.locator('.view-switch [data-view="tiles"]').click()
    const tileStatus = page.locator(`.agent-tile[data-agent="${agent.id}"] .tile-status`)
    check('its tile says Stopped · {time}', !!(await lib.until(async () => /^Stopped · \S+/.test(await text(tileStatus)), HUNG_MS)), await text(tileStatus))
    const tileMark = page.locator(`.agent-tile[data-agent="${agent.id}"] .state-mark`).first()
    check('…its mark there grey too', !!(await lib.until(() => tileMark.evaluate((m) => m.classList.contains('stopped') && m.classList.contains('idle')), HUNG_MS)), await tileMark.getAttribute('class'))
    check('…and in Tiles the chip says 1 stopped too', !!(await lib.until(counted, HUNG_MS)), await text(chip))
    await shots('tiles')
    await page.locator('.view-switch [data-view="panes"]').click()
    await lib.until(async () => (await bar.count()) === 1, HUNG_MS)

    // --- Resume: the stopped look goes from the accepted click, before the session runs (its start held a moment).
    await app.evaluate(() => { process.env.CW_TEST_SLOW_IPC = 'session:start=2500*1,session:resume=2500*1' })
    await bar.getByRole('button', { name: /Resume/ }).click()
    const notStopped = async () => (await host.evaluate((h) => h.classList.contains('dimmed'))) === false && !/Stopped/.test(await text(status)) && (await page.locator('.agent-pane .session-ended.stopped').count()) === 0 && (await header.locator('.state-mark.stopped').count()) === 0
    check('Resume: at once, no dimming, no Stopped label or bar, while it starts', !!(await lib.until(async () => !(await live()) && (await notStopped()), HUNG_MS)), JSON.stringify([await text(status), await text(bar)]))
    await app.evaluate(() => { delete process.env.CW_TEST_SLOW_IPC })
    await lib.acceptClaudeTrust(inv, proj, agent.id).catch(() => {})
    check('…then it runs, still not stopped', !!(await lib.until(async () => (await live())?.status === 'ready' && (await notStopped()), HUNG_MS)))
    check('…the chip no longer says stopped, its mark not grey', !!(await lib.until(async () => !/stopped/.test(await text(chip)) && (await chip.locator('.state-mark.stopped').count()) === 0, HUNG_MS)), await text(chip))

    // --- A lane's end's quit: "its lane ended".
    await inv('slots:test', proj, { op: 'quit', agent: agent.id })
    check('a lane end: "its lane ended"', !!(await lib.until(async () => (await text(bar.locator('.grow'))).endsWith('· its lane ended') && (await bar.getAttribute('data-stopped')) === 'lane', HUNG_MS)), await text(bar))

    // --- Its CLI crashing by itself: "its CLI exited with code 1".
    check('started again', await start())
    await inv('pty:write', key, '/crash\r')
    check('a crash: "its CLI exited with code 1"', !!(await lib.until(async () => (await text(bar.locator('.grow'))).endsWith('· its CLI exited with code 1') && (await bar.getAttribute('data-stopped')) === 'crashed', HUNG_MS)), await text(bar))
    await shots('crashed')

    // --- A start refused by Combwork: the starting look ends with it, and the stopped one is back as it was.
    await app.evaluate(() => { process.env.CW_TEST_FAIL_IPC = 'session:start*1' })
    await bar.getByRole('button', { name: 'New Session' }).click()
    check('a refused start: stopped again, its bar and dimming back', !!(await lib.until(async () => (await text(bar.locator('.grow'))).endsWith('· its CLI exited with code 1') && (await host.evaluate((h) => h.classList.contains('dimmed'))) && (await bar.getByRole('button', { name: 'New Session' }).isEnabled()), HUNG_MS)), await text(bar))
    await app.evaluate(() => { delete process.env.CW_TEST_FAIL_IPC })

    // --- A launch that fails (the fake's --model fail-start): its failed bar, never Stopped, not dimmed.
    await lib.setLaunch(inv, proj, agent.id, { model: 'fail-start' })
    await bar.getByRole('button', { name: 'New Session' }).click()
    const failedBar = page.locator('.agent-pane .session-ended.start-failed')
    check('a failed start: its failed bar, not the stopped one, its terminal not dimmed', !!(await lib.until(async () => (await failedBar.count()) === 1 && (await page.locator('.agent-pane .session-ended.stopped').count()) === 0 && (await host.evaluate((h) => h.classList.contains('dimmed'))) === false && !/Stopped/.test(await text(status)), HUNG_MS)), JSON.stringify([await text(bar), await text(status)]))
    await lib.setLaunch(inv, proj, agent.id, { model: '' })
  } catch (e) {
    check('the suite ran to the end', false, e.stack ?? String(e))
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})()
