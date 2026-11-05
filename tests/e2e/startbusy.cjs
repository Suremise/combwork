// Start and Resume look busy while a session starts (#1177): with session:start slowed (HIVE_TEST_SLOW_IPC, unpackaged
// builds only), from the click until the agent runs the button clicked shows a spinner and "Resuming…" or "Starting…",
// is disabled and aria-busy, and the other ways to start that agent are disabled too, elsewhere as well (the project
// header's Resume, the Sessions tab's); once it runs they are gone. In an agent's pane (its ended bar), the Sessions
// tab (also for a session no agent can run, while one is added for it), Start Without Setup and the Combwork Assistant's
// panel, in both themes (screenshots in the run's folder). The agents run the fake Claude Code (fake-claude/). Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
// Dev build only (#1580): session:start is slowed through HIVE_TEST_SLOW_IPC (a seam a packaged build ignores), and
// Tree is a 0.9 worktree agent (agents:testLegacy, refused by a packaged build) whose setup fails.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000
// How long session:start is held: long enough to see the busy state under load, not part of any check.
const SLOW_MS = 4000

const userData = path.join(lib.WORK, 'startbusy-profile')
const ws = path.join(lib.WORK, 'startbusy-ws')
const claudeHome = path.join(lib.WORK, 'startbusy-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  lib.enableProviders(userData)
  const env = lib.fakeClaude(userData, claudeHome, [alpha, ws])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const { app, page, inv } = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: lib.port(47911) }, viewport: { width: 1400, height: 850 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  try {
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const agent = await lib.soloAgent(inv, alpha)
    const liveOf = async (proj, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === id)
    let slowed = 0
    // Each time a new value, so its one slowed call counts afresh.
    const slowStart = () => app.evaluate((_, v) => void (process.env.HIVE_TEST_SLOW_IPC = v), `session:start=${SLOW_MS + ++slowed}*1`)
    const shots = []
    const shot = async (name) => {
      const file = path.join(lib.WORK, `startbusy-${name}.png`)
      await page.screenshot({ path: file })
      shots.push(file)
    }
    /** Says one prompt, so there is a conversation to resume. */
    const converse = async (proj, id) => {
      if (!(await lib.until(async () => (await liveOf(proj, id))?.status === 'ready', HUNG_MS))) return false
      await inv('pty:write', lib.ptyKey(proj, id), 'hello')
      await lib.sleep(300) // on purpose: the fake reads a typed line before its Enter, as a CLI does
      await inv('pty:write', lib.ptyKey(proj, id), '\r')
      return !!(await lib.until(async () => (await liveOf(proj, id))?.status === 'finished', HUNG_MS))
    }
    /** Runs, its start over: nothing busy (a worktree the fake doesn't trust shows its trust question, not ready). */
    const started = async (proj, id) => !!(await lib.until(async () => !!(await liveOf(proj, id)) && (await page.locator('[aria-busy="true"]').count()) === 0, HUNG_MS + SLOW_MS))
    /** Runs, its start over: the fake ready, nothing busy. */
    const runs = async (proj, id) => !!(await lib.until(async () => (await liveOf(proj, id))?.status === 'ready' && (await page.locator('[aria-busy="true"]').count()) === 0, HUNG_MS + SLOW_MS))
    const stop = async (proj, id) => {
      await inv('session:stop', proj, id)
      return !!(await lib.until(async () => !(await liveOf(proj, id)), HUNG_MS))
    }
    /** The button's busy state: its text, disabled, aria-busy and spinner. */
    const busyOf = (button) => button.evaluate((b) => ({ text: b.textContent.trim(), disabled: b.disabled, busy: b.getAttribute('aria-busy'), spin: !!b.querySelector('.codicon-loading.spin') }))
    const isBusy = (s, text) => s.text.includes(text) && s.disabled && s.busy === 'true' && s.spin

    await inv('session:start', alpha, { agentId: agent.id })
    check('the agent starts and answers', await converse(alpha, agent.id))
    check('and stops', await stop(alpha, agent.id))

    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      // --- An agent's pane: the ended bar's Resume.
      await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
      const bar = page.locator('.session-ended')
      const resume = bar.locator('.split-btn button.act-resume:not(.split-caret)')
      check(`${theme}: the ended bar shows Resume`, !!(await lib.until(async () => (await resume.count()) === 1, HUNG_MS)))
      await slowStart()
      await resume.click()
      const busy = await lib.until(async () => {
        const s = await busyOf(resume)
        return isBusy(s, 'Resuming…') && s
      }, HUNG_MS)
      check(`${theme}: Resume shows "Resuming…" with a spinner, disabled and aria-busy, from the click`, !!busy, JSON.stringify(await busyOf(resume).catch(() => null)))
      const others = await bar.locator('button').evaluateAll((bs) => bs.filter((b) => !b.disabled).map((b) => b.textContent.trim() || b.getAttribute('aria-label')))
      check(`${theme}: the ended bar's other buttons are disabled meanwhile`, others.length === 0, JSON.stringify(others))
      await shot(`pane-${theme}`)
      // Elsewhere too: the project header's Resume, and the Sessions tab's Resume of its session.
      const headerResume = page.locator('.project-header button.act-resume')
      check(`${theme}: the project header's Resume is disabled meanwhile`, (await headerResume.count()) === 1 && (await headerResume.isDisabled()))
      await page.locator('.tabs .tab', { hasText: 'Sessions' }).click()
      const crossResume = page.locator('.split-main button.act-resume:not(.split-caret)')
      check(`${theme}: the Sessions tab's Resume of that session is busy meanwhile`, !!(await lib.until(async () => (await crossResume.count()) === 1 && isBusy(await busyOf(crossResume), 'Resuming…'), HUNG_MS)), JSON.stringify(await busyOf(crossResume).catch(() => null)))
      await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
      check(`${theme}: the agent runs`, await runs(alpha, agent.id))
      check(`${theme}: and nothing says "Resuming…" any more`, (await page.getByText('Resuming…').count()) === 0)
      check(`${theme}: stopped again`, await stop(alpha, agent.id))

      // --- The Sessions tab: the selected session's Resume.
      await page.locator('.tabs .tab', { hasText: 'Sessions' }).click()
      const tabResume = page.locator('.split-main button.act-resume:not(.split-caret)')
      check(`${theme}: the Sessions tab shows the session's Resume`, !!(await lib.until(async () => (await tabResume.count()) === 1 && !(await tabResume.isDisabled()), HUNG_MS)))
      await slowStart()
      await tabResume.click()
      check(`${theme}: the Sessions tab's Resume shows "Resuming…", disabled and aria-busy`, !!(await lib.until(async () => isBusy(await busyOf(tabResume), 'Resuming…'), HUNG_MS)), JSON.stringify(await busyOf(tabResume).catch(() => null)))
      await shot(`sessions-${theme}`)
      check(`${theme}: the session resumes from the Sessions tab`, await runs(alpha, agent.id))
      check(`${theme}: stopped once more`, await stop(alpha, agent.id))
    }

    // --- A session no agent can run: Resume adds one, busy from the click through the agent's adding to its launch.
    await inv('agents:remove', alpha, agent.id, { deleteWorktree: false })
    check('the agent is removed', !!(await lib.until(async () => (await inv('workspace:refresh')).projects.find((x) => x.path.toLowerCase() === alpha.toLowerCase())?.agents.length === 0, HUNG_MS)))
    await page.locator('.tabs .tab', { hasText: 'Sessions' }).click()
    const orphanResume = page.locator('.split-main button.act-resume:not(.split-caret)')
    check('the Sessions tab offers its Resume', !!(await lib.until(async () => (await orphanResume.count()) === 1 && !(await orphanResume.isDisabled()), HUNG_MS)))
    await slowStart()
    await orphanResume.click()
    check('Resume of a session with no agent is busy from the click', !!(await lib.until(async () => isBusy(await busyOf(orphanResume), 'Resuming…'), HUNG_MS)), JSON.stringify(await busyOf(orphanResume).catch(() => null)))
    const added = await lib.until(async () => (await inv('workspace:refresh')).projects.find((x) => x.path.toLowerCase() === alpha.toLowerCase())?.agents[0], HUNG_MS)
    check('an agent is added for it', !!added)
    check('and Resume stays busy while that agent launches', !!added && isBusy(await busyOf(orphanResume), 'Resuming…'), JSON.stringify(await busyOf(orphanResume).catch(() => null)))
    await shot('sessions-no-agent')
    check('the added agent resumes it', !!added && (await runs(alpha, added.id)))
    if (added) check('and stops', await stop(alpha, added.id))

    // --- Start Without Setup: a worktree agent whose setup failed.
    await inv('project:updateConfig', alpha, { worktreeSetup: 'exit 1' })
    const tree = await lib.addAgent(inv, alpha, { name: 'Tree', location: 'new-worktree' })
    await inv('session:start', alpha, { agentId: tree.id })
    await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
    await lib.showAgent(page, 'Tree')
    const setupBar = page.locator('.session-ended', { hasText: 'Setup did not finish' })
    // By place: their labels change as they work.
    const retry = setupBar.locator('button').nth(0)
    const skip = setupBar.locator('button').nth(1)
    check('a failed setup offers Retry Setup and Start Without Setup', !!(await lib.until(async () => (await retry.textContent().catch(() => ''))?.includes('Retry Setup') && (await skip.textContent().catch(() => ''))?.includes('Start Without Setup'), HUNG_MS)))
    await slowStart()
    await skip.click()
    check('Start Without Setup shows "Starting…", disabled and aria-busy', !!(await lib.until(async () => isBusy(await busyOf(skip), 'Starting…'), HUNG_MS)), JSON.stringify(await busyOf(skip).catch(() => null)))
    const retryNow = await busyOf(retry)
    check('and Retry Setup is disabled, not busy', retryNow.disabled && retryNow.busy === null && !retryNow.spin, JSON.stringify(retryNow))
    await shot('skip-setup')
    check('the worktree agent starts without its setup', await started(alpha, tree.id))
    check('and stops', await stop(alpha, tree.id))

    // --- The Combwork Assistant's panel: Start, then Resume.
    const home = (await inv('workspace:refresh')).assistant.path
    await page.locator('.assistant-rail').click().catch(() => undefined)
    const panel = page.locator('.assistant-panel')
    const idleStart = panel.locator('.assistant-idle button.act-start')
    check("the Assistant's panel offers Start", !!(await lib.until(async () => (await idleStart.count()) === 1, HUNG_MS)))
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      const start = theme === 'dark' ? idleStart : panel.locator('.assistant-ended button.act-start')
      await slowStart()
      await start.click()
      check(`${theme}: the Assistant's Start shows "Starting…", disabled and aria-busy`, !!(await lib.until(async () => isBusy(await busyOf(start), 'Starting…'), HUNG_MS)), JSON.stringify(await busyOf(start).catch(() => null)))
      // Its header's icon-only Start (Resume once there is a conversation) is busy too.
      const headerButton = panel.locator('.assistant-header button.pane-btn.act-start, .assistant-header button.pane-btn.act-resume')
      check(`${theme}: and its header's button is busy too`, !!(await lib.until(async () => {
        const h = await busyOf(headerButton)
        return h.disabled && h.busy === 'true' && h.spin
      }, HUNG_MS)), JSON.stringify(await busyOf(headerButton).catch(() => null)))
      await shot(`assistant-start-${theme}`)
      check(`${theme}: the Assistant runs`, await runs(home, 'assistant'))
      check(`${theme}: it answers`, await converse(home, 'assistant'))
      check(`${theme}: the Assistant stops`, await stop(home, 'assistant'))
    }
    const endedResume = panel.locator('.assistant-ended button.act-resume')
    check("the Assistant's ended bar offers Resume", !!(await lib.until(async () => (await endedResume.count()) === 1, HUNG_MS)))
    await slowStart()
    await endedResume.click()
    check(`the Assistant's Resume shows "Resuming…", disabled and aria-busy`, !!(await lib.until(async () => isBusy(await busyOf(endedResume), 'Resuming…'), HUNG_MS)), JSON.stringify(await busyOf(endedResume).catch(() => null)))
    await shot('assistant-resume-light')
    check('the Assistant resumes', await runs(home, 'assistant'))
    await stop(home, 'assistant')
    const errors = await page.locator('.toast').allInnerTexts()
    check('no start or resume failed', !errors.some((t) => /Could not/.test(t)), JSON.stringify(errors))
    console.log(`Screenshots: ${shots.join(', ')}`)
  } catch (e) {
    check('no error', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `FAILED ${failed}` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
