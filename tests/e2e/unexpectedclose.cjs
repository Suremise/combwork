// Combwork closing unexpectedly (#984): while it runs, Combwork keeps a marker in its profile listing its running agents. A
// test copy ended from outside (by its own pid and start time, lib.identify, never by name) leaves it, and the next
// start says so: when it was last seen, which agents were running where, Nothing was resumed, with Resume All (which
// resumes the agent into its conversation) and Show Overview; nothing resumes on its own. The Assistant is told, and
// Copy Diagnostics says so. A normal quit removes the marker and the next start says nothing. With Settings → Sessions
// → Resume agents after an unexpected close on, the agent is resumed and the notice says so. The fake Claude Code runs
// the agent. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000
const START_MS = 30000

const userData = path.join(lib.WORK, 'unexpectedclose-profile')
const claudeHome = path.join(lib.WORK, 'unexpectedclose-claude-home')
const ws = path.join(lib.WORK, 'unexpectedclose-ws')
const proj = path.join(ws, 'alpha')
const markerFile = path.join(userData, 'running.json')
const logFile = path.join(userData, 'logs', 'combwork.log')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const marker = () => {
  try {
    return JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  } catch {
    return null
  }
}
const logText = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
/** The log since the last start: this run's lines. */
const thisRun = () => {
  const text = logText()
  const at = Math.max(-1, ...[...text.matchAll(/\] Combwork \S+ starting \(/g)].map((m) => m.index))
  return at < 0 ? '' : text.slice(text.lastIndexOf('\n', at) + 1)
}
/**
 * This run's warnings and errors: why a start didn't reopen its workspace, say (HI-2179: an open that failed showed
 * only later, as a workspace with no Assistant).
 */
const why = () => thisRun().split('\n').filter((l) => /\[(WARN|ERROR)\]/.test(l)).slice(0, 12).join('\n')
const pad = (n) => String(n).padStart(2, '0')
/** The time as the notice shows it (24-hour, the default), in this machine's time zone. */
const shownTime = (iso) => {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Playwright loses its connection to a copy ended from outside: not this suite's failure.
process.on('uncaughtException', (e) => {
  if (/Target page, context or browser has been closed|has been closed|Target crashed|ECONNRESET|EPIPE/.test(String(e?.message))) return
  console.error(e)
  process.exit(1)
})

const identities = []
let claudeEnv = null

/** Starts a copy of Combwork on the profile, with its workspace restored. */
async function start(extra = {}) {
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, ...claudeEnv, ...extra })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  identities.push(...lib.identify([app.process().pid]))
  const page = await app.firstWindow()
  await lib.fitWindow(app, page, { width: 1300, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  return { app, page, inv }
}

/** Ends the copy from outside, as a crash or a kill would: its own process (by pid and start time) and what it started. */
async function endFromOutside(app) {
  const proc = app.process()
  const gone = new Promise((r) => (proc.exitCode !== null ? r(true) : proc.once('exit', () => r(true))))
  const id = identities.find((i) => i.pid === proc.pid)
  const ended = id ? lib.endTreeExactly(id) : 0
  const exited = await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), HUNG_MS))])
  return ended > 0 && exited
}

/** The notice's text in the window, once it is shown. */
const notice = (page) => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).find((t) => t.includes('Combwork closed unexpectedly')) ?? '')
const liveAgent = async (inv, agentId) => (await inv('session:live')).find((l) => l.agentId === agentId)

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  claudeEnv = lib.fakeClaude(userData, claudeHome, [proj])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  let current = null
  try {
    // --- 1. A run with an agent working, ended from outside.
    let agent
    let sessionId
    {
      current = await start()
      const { app, page, inv } = current
      check('a first start finds no earlier run', /The last run quit normally/.test(await inv('app:diagnostics')))
      check('the running Combwork keeps its marker', !!(await lib.until(() => marker()?.pid > 0, HUNG_MS)), JSON.stringify(marker()))
      await lib.openWorkspace(inv, page, ws)
      await page.getByText('alpha', { exact: true }).first().click()
      agent = await lib.soloAgent(inv, proj, { name: 'Steady' })
      await inv('session:start', proj, { agentId: agent.id })
      await lib.acceptClaudeTrust(inv, proj, agent.id)
      const live = await lib.until(async () => {
        const l = await liveAgent(inv, agent.id)
        return l?.status === 'ready' && l.sessionId ? l : null
      }, START_MS)
      sessionId = live?.sessionId
      check('the agent runs, in a conversation', !!sessionId)
      check('…and the marker lists it, in its project and conversation', !!(await lib.until(() => marker()?.agents?.some((a) => a.agentId === agent.id && a.project === 'alpha' && a.sessionId === sessionId), HUNG_MS)), JSON.stringify(marker()?.agents))
      // The window's workspace is remembered as it opens (config.json), so the next start opens it again.
      check('…and the window remembers its workspace, to reopen it', !!(await lib.until(() => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).windows?.some((w) => w.workspace?.toLowerCase() === ws.toLowerCase()), HUNG_MS)))
      check('the copy is ended from outside', await endFromOutside(app))
      current = null
    }
    const left = marker()
    check('the marker is still there', !!left?.lastSeen)
    // The run held the merge slot as it went (its record, as mergeSlotHost writes it: by the workspace's path).
    const slots = path.join(userData, 'merge-slots')
    fs.mkdirSync(slots, { recursive: true })
    const hold = { projectPath: proj, branch: 'main', agentId: agent.id, agentName: 'Steady', runId: 'run-before', cards: [7], since: Date.now() - 60_000, until: Date.now() + 3_000_000, cwd: proj }
    fs.writeFileSync(path.join(slots, `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`), JSON.stringify({ version: 1, holds: [hold] }))

    // --- 2. The next start: the notice, nothing resumed; Resume All resumes it.
    {
      // The merge slot recovery is held (as on a slow start, many projects) until the window is up and the notice waits.
      const release = path.join(lib.WORK, 'unexpectedclose-release-recovery')
      fs.rmSync(release, { force: true })
      current = await start({ HIVE_TEST_HOLD_MERGE_RECOVERY: release })
      const { page, inv } = current
      check('with the recovery held, the notice waits for it (the window is up)', !!(await lib.until(() => /The notice waits for \d+ startup step/.test(thisRun()) && /Merge slot recovery held/.test(thisRun()), HUNG_MS)), why())
      check('…and is not shown meanwhile',(await notice(page)) === '')
      fs.writeFileSync(release, '')
      const text = await lib.until(() => notice(page), HUNG_MS)
      check('the next start says Combwork closed unexpectedly, when it was last seen', !!text && text.includes(`Combwork was last seen on`) && text.includes(` at ${shownTime(left.lastSeen)}.`), text)
      check('…which agent was running where, and that nothing was resumed', /One agent was running in alpha\. Nothing was resumed\./.test(text), text)
      check('…with Resume All and Show Overview', /Resume All/.test(text) && /Show Overview/.test(text), text)
      check('…and the merge left half done, with the folder it was in', text.includes(`Steady was merging main (#7): check ${proj} for a merge left half done (git status there)`), text)
      await page.screenshot({ path: path.join(lib.WORK, 'unexpectedclose-notice.png') })
      check('…told in that notice, not one of its own', (await page.evaluate(() => [...document.querySelectorAll('.toast')].filter((t) => t.innerText.includes('was merging when Combwork closed')).length)) === 0)
      const home = (await inv('workspace:refresh'))?.assistant?.path
      const told = () => {
        try {
          return require('./storeDocs.cjs').deliveriesOf(home).find((r) => r.agentId === 'assistant' && r.from?.kind === 'hive' && /Combwork closed unexpectedly: last seen/.test(r.body))
        } catch {
          return null
        }
      }
      const line = home ? await lib.until(told, HUNG_MS) : null
      check("the Assistant finds it in its inbox for its next start, with the agents and that nothing was resumed", !!line && /Steady \(alpha\)/.test(line.body) && /Nothing was resumed/.test(line.body), JSON.stringify(line ?? home))
      check('nothing resumed on its own', !(await liveAgent(inv, agent.id)))
      check('combwork.log says so, with the time', thisRun().includes(`ended without quitting: last seen ${left.lastSeen}`), thisRun().split('\n').slice(0, 8).join(' | '))
      check('Copy Diagnostics says the last run ended without quitting', /The last run ended without quitting: last seen [^;]+; 1 agent\(s\) were running/.test(await inv('app:diagnostics')))
      check('this run has its own marker', !!(await lib.until(() => marker()?.startedAt && marker().startedAt !== left.startedAt, HUNG_MS)))
      await page.locator('.toast', { hasText: 'Combwork closed unexpectedly' }).getByRole('button', { name: 'Resume All' }).click()
      const back = await lib.until(async () => {
        const l = await liveAgent(inv, agent.id)
        return l?.status === 'ready' ? l : null
      }, START_MS)
      check('Resume All resumes the agent, into its conversation', back?.sessionId === sessionId, JSON.stringify(back && { sessionId: back.sessionId, status: back.status }))

      // --- 3. A normal quit: the marker goes, and the next start says nothing.
      const quitting = await lib.quitWatch(current.app)
      await inv('app:quit').catch(() => undefined)
      check('a normal quit ends the copy', await quitting.gone(HUNG_MS))
      check('…and removes the marker', !fs.existsSync(markerFile))
      check('…saying why in combwork.log', /Removed the running marker: Combwork is quitting/.test(thisRun()))
      current = null
    }
    {
      current = await start()
      const { inv } = current
      check('after a normal quit, the next start finds nothing', /The last run quit normally/.test(await inv('app:diagnostics')) && !/ended without quitting/.test(thisRun()))
      check('…and shows no notice', (await notice(current.page)) === '')

      // --- 4. With Resume agents after an unexpected close on: resumed, and the notice says so.
      await inv('settings:update', { sessions: { resumeAfterUnexpectedClose: true } })
      // The agent wasn't resumed in this run: it starts afresh into its conversation, which the marker then lists.
      await inv('session:start', proj, { agentId: agent.id, resumeId: sessionId })
      check('the agent runs again', !!(await lib.until(async () => (await liveAgent(inv, agent.id))?.status === 'ready', START_MS)))
      check('…listed in the marker', !!(await lib.until(() => marker()?.agents?.some((a) => a.agentId === agent.id && a.sessionId === sessionId), HUNG_MS)))
      check('the copy is ended from outside again', await endFromOutside(current.app))
      current = null
    }
    {
      current = await start()
      const { page, inv } = current
      const text = await lib.until(() => notice(page), START_MS)
      check('with the setting on, the notice says the agent was resumed', /One agent was running in alpha\. One was resumed, as Settings → Sessions says\./.test(text), `${text}\n${why()}`)
      check('…without Resume All', !/Resume All/.test(text), text)
      check('…and the agent runs, in its conversation', !!(await lib.until(async () => (await liveAgent(inv, agent.id))?.sessionId === sessionId, START_MS)))
      await page.screenshot({ path: path.join(lib.WORK, 'unexpectedclose-resumed.png') })
      const quitting = await lib.quitWatch(current.app)
      await inv('app:quit').catch(() => undefined)
      check('the test copy quits', await quitting.gone(HUNG_MS))
      current = null
    }
  } catch (e) {
    check('no unexpected error', false, e?.stack ?? String(e))
  } finally {
    if (current) await current.app.close().catch(() => undefined)
    // Anything left of a copy this suite started, by its own pid and start time only.
    for (const id of identities) lib.endTreeExactly(id)
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})()
