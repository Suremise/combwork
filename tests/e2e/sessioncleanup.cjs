// The Sessions tab's Clean Up… (#895): one dialog picks an age (24 hours, 7 days, 30 days) and Archive (the default) or
// Delete, says what goes, and sends it through the branch actions' session:bulk. Fixture sessions of several ages: Archive
// older than 7 days archives exactly the two old enough and skips a running old one, saying so; Delete older than 24
// hours deletes exactly the four old enough (archived ones too: Combwork's copies to the suite's trash), skips the running
// one, and leaves the CLI's own transcripts; with nothing old enough left, the dialog says so and its button is off.
// Fake Claude Code (fake-claude/) runs the running session, resumed from an old fixture (fake-title-untimed keeps its
// last activity old). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR; quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { sessionsOf, putSessions } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000
const TURN_MS = 20000

const userData = path.join(lib.WORK, 'sessioncleanup-profile')
const ws = path.join(lib.WORK, 'sessioncleanup-ws')
const claudeHome = path.join(lib.WORK, 'sessioncleanup-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

const HOUR = 3600_000
const id = (n) => `0c1ea400-2222-4333-8444-5555666${String(n).padStart(5, '0')}`
/** A Claude Code transcript last active `hoursAgo` (Combwork's backup of it, or the CLI's own). */
const claudeLines = (sid, hoursAgo, text) => {
  const at = new Date(Date.now() - hoursAgo * HOUR).toISOString()
  return (
    [
      { type: 'user', sessionId: sid, timestamp: at, message: { role: 'user', content: text } },
      { type: 'assistant', sessionId: sid, requestId: `r-${sid}`, timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 } } }
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  )
}
const old = new Date(Date.now() - 60 * 24 * HOUR)
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  // Written long ago: a transcript changed in the last few seconds counts as still being written.
  fs.utimesSync(file, old, old)
}
const backup = (sid, archived = false) => path.join(alpha, '.combwork', archived ? 'archive' : 'sessions', `${sid}.jsonl`)
// Combwork's copy, plain or compressed (#1110: an ended or archived session's is compressed).
const kept = (sid, archived = false) => fs.existsSync(backup(sid, archived)) || fs.existsSync(backup(sid, archived) + '.gz')
const cliFile = (sid) => path.join(claudeHome, 'projects', alpha.replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`)

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  const claudeEnv = lib.fakeClaude(userData, claudeHome, [alpha])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env: lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47879), ...claudeEnv }) })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    const claude = await lib.addAgent(inv, alpha, { name: 'Claude' })
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === claude.id)

    // --- Sessions last active 2 hours, 30 hours, 8 days and 40 days ago, an archived one of 40 days, and one of 10 days
    // that Claude resumes (running).
    const S = { fresh: id(1), day: id(2), week: id(3), month: id(4), archived: id(5), running: id(6) }
    const ages = { fresh: 2, day: 30, week: 24 * 8, month: 24 * 40, archived: 24 * 40, running: 24 * 10 }
    const names = { fresh: 'Fresh work', day: 'Day old', week: 'Week old', month: 'Month old', archived: 'Archived old', running: 'Running old' }
    // The records are in the workspace's database (#1061).
    const file = sessionsOf(alpha)
    for (const k of Object.keys(S)) {
      const at = new Date(Date.now() - ages[k] * HOUR).toISOString()
      file.sessions.push({ id: S[k], agent: 'claude-code', name: names[k], createdAt: at, lastActiveAt: at, archived: k === 'archived', agentId: claude.id, agentName: 'Claude', names: 2 })
      write(cliFile(S[k]), claudeLines(S[k], ages[k], `Work of ${names[k]}`))
      write(backup(S[k], k === 'archived'), claudeLines(S[k], ages[k], `Work of ${names[k]}`))
    }
    putSessions(alpha, file)
    const records = () => sessionsOf(alpha).sessions
    const record = (sid) => records().find((s) => s.id === sid)

    fs.writeFileSync(path.join(claudeHome, 'fake-title-untimed-Claude'), '')
    await inv('session:start', alpha, { agentId: claude.id, resumeId: S.running })
    await lib.until(async () => ['waiting', 'ready'].includes((await live())?.status), TURN_MS)
    if ((await live())?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, claude.id), '\r')
    check('Claude runs the old session', !!(await lib.until(async () => (await live())?.status === 'ready' && (await live())?.sessionId === S.running, TURN_MS)))
    const listed = async () => (await inv('session:list', alpha)).find((s) => s.id === S.running)
    const runningItem = await listed()
    check('…still last active 10 days ago', !!runningItem?.lastActivity && Date.now() - Date.parse(runningItem.lastActivity) > 9 * 24 * HOUR, JSON.stringify(runningItem?.lastActivity))

    await page.locator('.tab', { hasText: 'Sessions' }).click()
    const row = (name) => page.locator('.sessions-tree .session-row', { hasText: name })
    // The focused agent's branches start open.
    check('the sessions are listed', await lib.until(async () => (await row('Fresh work').count()) > 0, HUNG_MS))
    await row('Fresh work').first().click()
    await lib.until(async () => /Fresh work/.test(await page.locator('.transcript-toolbar strong').first().innerText().catch(() => '')), HUNG_MS)

    const dialog = page.locator('.dialog')
    const openCleanUp = async () => {
      await page.locator('[data-action="sessions-cleanup"]').click()
      await lib.until(async () => (await dialog.count()) > 0, HUNG_MS)
    }
    const dialogText = () => dialog.innerText().catch(() => '')
    const toast = (re) => page.locator('.toast').filter({ hasText: re })

    // --- Archive (the default) older than 7 days (the default age): the 8- and 40-day sessions; the running one is skipped.
    await openCleanUp()
    check('Clean Up opens with 7 days and Archive picked', (await dialog.locator('[data-age="week"] input').isChecked()) && (await dialog.locator('[data-cleanup="archive"] input').isChecked()))
    check('…and says what goes and what is left alone', await lib.until(async () => /2 sessions older than 7 days\./.test(await dialogText()) && /Left alone: 1 running\./.test(await dialogText()), HUNG_MS), await dialogText())
    await page.screenshot({ path: path.join(lib.WORK, 'sessioncleanup-1-archive.png') })
    await dialog.locator('.cleanup-go').click()
    const archivedToast = toast(/Archived 2 sessions/)
    check('the result says what was archived and skipped', await lib.until(async () => (await archivedToast.count()) > 0, HUNG_MS))
    const said = await archivedToast.first().innerText().catch(() => '')
    check('…1 skipped: running', /Archived 2 sessions; 1 skipped: 1 running/.test(said) && /Running old: running/.test(said), said)
    check('exactly the old ones are archived', await lib.until(() => record(S.week)?.archived === true && record(S.month)?.archived === true, HUNG_MS), JSON.stringify(records().map((s) => [s.name, s.archived])))
    check('…the newer ones and the running one are not', [S.fresh, S.day, S.running].every((s) => record(s)?.archived === false))
    check("…their transcripts kept in Combwork's archive", kept(S.week, true) && kept(S.month, true) && !kept(S.week))
    check('the running session still runs', (await live())?.sessionId === S.running)
    check('the archived ones leave the list', await lib.until(async () => (await row('Week old').count()) === 0 && (await row('Month old').count()) === 0, HUNG_MS))

    // --- Delete older than 24 hours: the 30-hour session and the three archived ones; the running one is skipped.
    await openCleanUp()
    await dialog.locator('[data-age="day"] input').check()
    await dialog.locator('[data-cleanup="delete"] input').check()
    check('Delete counts archived ones too, and says so', await lib.until(async () => /4 sessions older than 24 hours\. 3 of them are archived\./.test(await dialogText()) && /Left alone: 1 running\./.test(await dialogText()), HUNG_MS), await dialogText())
    await page.screenshot({ path: path.join(lib.WORK, 'sessioncleanup-2-delete.png') })
    await dialog.locator('.cleanup-go').click()
    const deletedToast = toast(/Deleted 4 sessions/)
    check('the result says what was deleted and skipped', await lib.until(async () => (await deletedToast.count()) > 0, HUNG_MS))
    const deletedSaid = await deletedToast.first().innerText().catch(() => '')
    check('…1 skipped: running', /Deleted 4 sessions; 1 skipped: 1 running/.test(deletedSaid), deletedSaid)
    check('exactly the old ones are gone from Combwork', await lib.until(() => [S.day, S.week, S.month, S.archived].every((s) => !record(s)), HUNG_MS), JSON.stringify(records().map((s) => s.name)))
    check('…the fresh and running ones stay', !!record(S.fresh) && !!record(S.running))
    check("…Combwork's copies in the suite's trash (#414)", lib.trashed(S.day).length === 1 && lib.trashed(S.archived).length === 1 && !kept(S.day) && !kept(S.archived, true))
    check("the CLI's own transcripts are untouched", Object.values(S).every((s) => fs.existsSync(cliFile(s))))
    check('the running session still runs', (await live())?.sessionId === S.running)

    // --- Nothing older than 30 days is left (the running one aside): the dialog says so, and its button is off.
    await openCleanUp()
    await dialog.locator('[data-age="month"] input').check()
    await dialog.locator('[data-cleanup="delete"] input').check()
    check('with nothing old enough, it says so', await lib.until(async () => /Nothing older than 30 days to delete\./.test(await dialogText()), HUNG_MS), await dialogText())
    check('…and its button is off', await dialog.locator('.cleanup-go').isDisabled())
    await page.keyboard.press('Escape')
    check('Escape closes it', await lib.until(async () => (await dialog.count()) === 0, HUNG_MS))
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
