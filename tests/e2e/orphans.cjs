// What an agent's command leaves running while the agent keeps running (HI-2111). A fake Claude Code agent, HB2, runs
// "linger 1": a short-lived node starts a detached, hidden node and exits, so the one left (fake-claude's linger.cjs)
// has no living parent, as a server started with `&` from a shell that has ended has. Shortened for the test
// (CW_TEST_ORPHAN_MS, CW_TEST_ORPHAN_POLL_MS), its ten minutes are seconds: Activity marks it as left running, with
// its CPU time and End It; one notice says so, clicking to HB2; HB2 is told once, at its next tool call; Pause the team
// names it as not parked; End It, behind Activity's question, ends exactly it. A second window, showing another workspace
// and opened last (so the window focused last), gets no notice of it: the notice goes to the orphan's own window. Screenshots of the row and the notice,
// dark and light. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR; the window stays quiet (lib.launch).
// Only the process the fake agent started here is ended, by its recorded identity.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const at = (x) => path.join(lib.WORK, `orphans-${x}`)
const userData = at('profile')
const ws = at('ws')
const claudeHome = at('claude-home')
const alpha = path.join(ws, 'alpha')
const wsB = at('wsB')
const shots = at('shots')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lingerFile = path.join(claudeHome, 'fake-linger.jsonl')
const lingering = () => (fs.existsSync(lingerFile) ? fs.readFileSync(lingerFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).pid) : [])
const noticesFile = path.join(claudeHome, 'fake-notices.jsonl')
const notices = () => (fs.existsSync(noticesFile) ? fs.readFileSync(noticesFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const ids = new Map()
const alive = (pid) => ids.has(pid) && lib.stillSame([ids.get(pid)]).length === 1

;(async () => {
  for (const d of [userData, ws, wsB, claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(path.join(wsB, 'beta'))
  const env = lib.fakeClaude(userData, claudeHome, [alpha, ws, wsB])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.sessions = { ...cfg.settings.sessions, confirmStop: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, CW_TEST_TIPS: 'off', CW_TEST_ORPHAN_MS: '4000', CW_TEST_ORPHAN_POLL_MS: '1000' }, viewport: { width: 1400, height: 850 } })
  const { app, page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 250)
    // Every notice that reaches the window, kept: a toast goes from the screen after a while.
    await page.evaluate(() => {
      window.__toasts = []
      window.hive.onEvent((e) => {
        if (e.type === 'toast') window.__toasts.push(e.toast)
      })
    })
    const toasts = () => page.evaluate(() => window.__toasts)

    // --- Window B, another workspace, opened last: the window focused last, where a notice with no window of its own goes.
    const next = app.waitForEvent('window')
    await inv('window:new')
    const pageB = await next
    await pageB.waitForLoadState('domcontentloaded')
    await lib.appReady(pageB)
    pageB.on('pageerror', (e) => check('no page errors (B)', false, e.message))
    const invB = (ch, ...a) => pageB.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await invB('workspace:open', wsB)
    await until(async () => (await invB('workspace:get'))?.path?.toLowerCase() === wsB.toLowerCase())
    await pageB.evaluate(() => {
      window.__toasts = []
      window.hive.onEvent((e) => {
        if (e.type === 'toast') window.__toasts.push(e.toast)
      })
    })

    // --- HB2 runs, and its command leaves a process running whose starter has exited.
    const hb2 = await lib.addAgent(inv, alpha, { name: 'HB2' })
    const liveOf = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === hb2.id)
    await inv('session:start', alpha, { agentId: hb2.id })
    await until(async () => ['ready', 'finished'].includes((await liveOf())?.status))
    await lib.sendPrompt(inv, lib.ptyKey(alpha, hb2.id), 'linger 1', { submitted: async () => lingering().length > 0 })
    await until(async () => (await liveOf())?.status === 'finished')
    const pid = lingering()[0]
    for (const id of lib.identify([pid])) ids.set(id.pid, id)
    check('its command left a process running, its starter gone', !!pid && alive(pid), String(pid))

    // --- Shown once past its (shortened) bound: Activity's process is marked, with its CPU time.
    const shownNow = async () => (await inv('activity:now', alpha)).launches.filter((l) => l.agentId === hb2.id).flatMap((l) => l.processes).find((p) => p.pid === pid && p.orphan)
    const shown = await until(shownNow)
    check('Activity lists it as left running, with its CPU time', !!shown && typeof shown.orphan.cpuMs === 'number' && !!shown.created, JSON.stringify(shown))
    const ofPid = (list) => list.filter((t) => t.target?.kind === 'agent' && t.message?.includes(String(pid)))
    const mine = async () => ofPid(await toasts())
    const toast = (await until(async () => (await mine())[0] ?? null)) ?? null
    check('a notice says HB2 left it running, clicking to HB2', !!toast && /^HB2 left .*linger.* running for /.test(toast.title) && toast.target?.kind === 'agent' && toast.target.agentId === hb2.id, JSON.stringify(toast))
    check("…in its own window only: window B, focused last, gets none", ofPid(await pageB.evaluate(() => window.__toasts)).length === 0, JSON.stringify(await pageB.evaluate(() => window.__toasts)))
    const toastEl = page.locator('.toast', { hasText: 'HB2 left' }).first()
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
      await toastEl.screenshot({ path: path.join(shots, `notice-${theme}.png`) }).catch((e) => console.log(`screenshot: ${e.message}`))
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })

    // --- The Activity tab: its row says so; its details have End It.
    await page.locator('.tab', { hasText: 'Activity' }).click()
    const row = page.locator('.activity-row.act-orphan', { hasText: 'linger' })
    const refresh = () => page.locator('.activity-head').getByRole('button', { name: 'Refresh', exact: true }).click()
    const rowShown = await until(async () => {
      if ((await row.count()) > 0) return true
      await refresh()
      return false
    })
    check('the Activity tab shows its row: Left running, how long, its CPU time', !!rowShown && /Left running · process \d+ · running .+ · CPU /.test(await row.first().innerText()), await row.first().innerText().catch(() => ''))
    const list = page.locator('.activity-list')
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
      await list.screenshot({ path: path.join(shots, `activity-${theme}.png`) }).catch((e) => console.log(`screenshot: ${e.message}`))
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })

    // --- HB2 is told once, at its next tool call.
    const toldOf = () => notices().filter((n) => n.text.includes(`pid ${pid} `))
    await lib.sendPrompt(inv, lib.ptyKey(alpha, hb2.id), 'checkpoint', { submitted: async () => (await liveOf())?.status === 'working' || toldOf().length > 0 })
    check('HB2 is told at its next tool call, with the pid and its command', !!(await until(async () => toldOf().length > 0)) && /linger/.test(toldOf()[0].text), JSON.stringify(notices()))
    await until(async () => (await liveOf())?.status === 'finished')
    const before = notices().length
    await lib.sendPrompt(inv, lib.ptyKey(alpha, hb2.id), 'checkpoint then checkpoint', { submitted: async () => (await liveOf())?.status === 'working' })
    await until(async () => (await liveOf())?.status === 'finished')
    check('…once: not again at its next tool calls', toldOf().length === 1, JSON.stringify(notices().slice(before)))
    check('…and one notice in all, look after look', (await mine()).length === 1, JSON.stringify(await mine()))

    // --- Pause the team: it is named, not parked.
    await inv('team:pause')
    const items = async () => (await inv('team:state')).workspaces.find((w) => w.workspacePath.toLowerCase() === ws.toLowerCase())?.items ?? []
    const named = await until(async () => (await items()).find((i) => i.kind === 'process' && i.process?.pid === pid && i.agentId === hb2.id))
    check('Pause the team names it, not parked', !!named && (await inv('team:state')).allParked === false && /linger/.test(named.label ?? ''), JSON.stringify(await items()))

    // --- End It from Activity, behind its question: exactly that process ends; HB2 still runs.
    await row.first().click()
    const details = page.locator('.activity-details')
    const endIt = details.getByRole('button', { name: 'End It…' })
    check('its details say Left running, with CPU time and End It', !!(await until(async () => (await endIt.count()) === 1)) && /Left running/.test(await details.innerText()) && /CPU time/.test(await details.innerText()), await details.innerText().catch(() => ''))
    await endIt.click()
    await page.getByRole('button', { name: 'End It', exact: true }).last().click()
    check('confirmed, it ends', !!(await until(async () => !alive(pid))), String(pid))
    check('…and HB2 still runs', !!(await liveOf()))
    check('…and Pause the team no longer names it', !!(await until(async () => !(await items()).some((i) => i.process?.pid === pid))), JSON.stringify(await items()))
    await inv('team:resume')
  } catch (err) {
    check('no unexpected error', false, err.stack)
  } finally {
    await app.close().catch(() => undefined)
    lib.endExactly([...ids.values()])
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
