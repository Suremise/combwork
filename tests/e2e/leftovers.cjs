// Processes left running when it stops (#507). The fake Claude Code's "linger N" leaves N detached, hidden
// node processes behind, each started through one that has exited (as a preview server started through a shell is).
// Ask (the default): stopping the agent lists them (session:leftovers), its pane's ⋯ (#977) has an amber badge and an
// entry "N left running", and a notification offers to end them; End in that entry's menu ends exactly those, Keep Running stops listing them and leaves
// them running. End them (the setting): ended as the agent stops, nothing listed. Quitting with some listed asks
// (the native dialog, stubbed) and ends them. A process started in the project folder by someone else is never ended.
// Fake Claude Code; dev build, throwaway profile and workspace, quiet.
const lib = require('./lib.cjs')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const base = path.join(lib.WORK, 'leftovers')
const userData = path.join(base, 'profile')
const home = path.join(base, 'claude-home')
const ws = path.join(base, 'ws')
const proj = path.join(ws, 'site')
const lingerFile = path.join(home, 'fake-linger.jsonl')
const shots = lib.WORK
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// Each process the suite starts or is left, by its identity (pid and start time) as soon as its pid is known: a check or
// the clean-up never takes a process that got the pid after it ended (#603: a remembered pid killed here could have been
// a concurrent run's Vitest worker, which then exits with code 1).
const ids = new Map()
const remember = (pids) => {
  for (const id of lib.identify(pids.filter((p) => !ids.has(p)))) ids.set(id.pid, id)
  return pids
}
const alive = (pid) => ids.has(pid) && lib.stillSame([ids.get(pid)]).length === 1
const lingering = () => (fs.existsSync(lingerFile) ? fs.readFileSync(lingerFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).pid) : [])

;(async () => {
  fs.rmSync(base, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  const env = lib.fakeClaude(userData, home, [proj])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.sessions = { ...cfg.settings.sessions, confirmStop: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // Someone else's process with the project folder as its working folder: never the agent's. It runs until the suite
  // ends it (endExactly, below), not for a set time: one that lived 120 s had ended before a 213 s run under load checked
  // that it outlives Combwork (#708). It ends itself only once this suite's process is gone (or after an hour), so a suite
  // killed part-way leaves nothing running.
  const strangerCode = `const suite = ${process.pid}; setInterval(() => { try { process.kill(suite, 0) } catch { process.exit(0) } }, 1000); setTimeout(() => process.exit(0), 3600000)`
  const stranger = spawn(process.execPath, ['-e', strangerCode], { cwd: proj, detached: true, stdio: 'ignore', windowsHide: true, env: lib.childEnv() })
  stranger.unref()
  remember([stranger.pid])
  const strangerAt = Date.now()

  const { app, page, inv } = await lib.launch({ userData, env: { ...env, CW_API_PORT: lib.port(47882), CW_TEST_ASK_LEFTOVERS: '1' } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  try {
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const agent = await lib.soloAgent(inv, proj, { name: 'Website' })
    const key = lib.ptyKey(proj, agent.id)
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === agent.id)
    const listed = async () => (await inv('session:leftovers')).find((l) => l.agentId === agent.id)

    /** Starts the agent, has it leave n processes running, and stops it: the new pids. */
    const leaveRunning = async (n) => {
      const before = lingering()
      await inv('session:start', proj, { agentId: agent.id })
      await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), 30000)
      await lib.sendPrompt(inv, key, `linger ${n}`, { submitted: async () => lingering().length >= before.length + n })
      await lib.until(async () => (await live())?.status === 'finished', 20000)
      const pids = lingering().slice(before.length)
      remember(pids)
      await inv('session:stop', proj, agent.id)
      await lib.until(async () => !(await live()), 15000)
      return pids
    }
    await page.getByText('site', { exact: true }).first().click()

    // The first launch (the job host not started yet), whose CLI leaves a process the moment it runs: still the launch's.
    const atStart = path.join(home, 'fake-linger-at-start.txt')
    fs.writeFileSync(atStart, '1')
    await inv('session:start', proj, { agentId: agent.id })
    await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), 30000)
    fs.rmSync(atStart)
    await lib.until(() => lingering().length >= 1, 10000)
    const early = lingering()
    remember(early)
    await inv('session:stop', proj, agent.id)
    await lib.until(async () => !(await live()), 15000)
    const earlyListed = await lib.until(async () => (await listed())?.processes.length === early.length && (await listed()), 15000)
    check('a process the CLI started the moment it ran, on the first launch, is listed', early.length === 1 && !!earlyListed && earlyListed.processes[0].pid === early[0], JSON.stringify({ early, earlyListed }))
    check('ended through the API, it is gone', (await inv('session:settleLeftovers', proj, agent.id, 'end')) === 1 && (await lib.until(() => early.every((p) => !alive(p)), 10000)))
    // Its notice's offer goes with them (HI-2320, HI-2372): it loses its buttons and says they have ended. The entry
    // itself stays its time to be read (Popups.tsx), and a test window is never focused, so it isn't waited out.
    const earlyToast = page.locator('.toast', { hasText: 'left 1 process running' })
    check(
      'and so is the notification offering to end it',
      await lib.until(async () => (await earlyToast.locator('button', { hasText: /End Them|Keep Running/ }).count()) === 0 && (await earlyToast.filter({ hasText: 'They have ended' }).count()) > 0, 5000),
      JSON.stringify(await earlyToast.allInnerTexts().catch(() => []))
    )

    // Ask: listed, shown in the pane header and a notification; End ends exactly them.
    const two = await leaveRunning(2)
    // The notification is a toast for 15 s from the stop, then only in the Notifications panel (without its buttons):
    // looked for from now, beside the checks below, not after them, which can take longer than that under load (#673).
    const toast = page.locator('.toast', { hasText: 'left 2 processes running' })
    const offered = lib.until(async () => (await toast.locator('button', { hasText: 'End Them' }).count()) > 0, 30000).catch(() => false)
    check('the agent left two processes running as it stopped', two.length === 2 && two.every(alive), JSON.stringify(two))
    const found = await lib.until(async () => {
      const l = await listed()
      return l?.processes.length === 2 && l
    }, 15000)
    check('Combwork lists the two it left, by pid, as node processes', !!found && two.every((p) => found.processes.some((x) => x.pid === p)) && found.processes.every((x) => x.label.startsWith('node ')), JSON.stringify(found))
    check("the stranger's process isn't listed", !!found && !found.processes.some((x) => x.pid === stranger.pid))
    // Its pane's ⋯ (#977): an amber badge, "2 left running" in its name's description, and an entry whose menu ends them.
    const more = page.locator('.pane-header-bar .pane-more').first()
    const said = async () => (await more.getAttribute('aria-description').catch(() => null)) ?? ''
    const chip = page.locator('.pane-header-bar .pane-more-badge.warn')
    const openLeftovers = async (n) => {
      await more.click()
      await page.locator('.menu .menu-item', { hasText: `${n} left running` }).click()
    }
    check("the pane's ⋯ shows \"2 left running\", with an amber badge", !!(await lib.until(async () => /2 left running/.test(await said()) && (await chip.count()) === 1, 10000)), await said())
    check('a notification offers to end them', !!(await offered))
    await page.screenshot({ path: path.join(shots, 'leftovers-header.png') })
    await openLeftovers(2)
    await page.getByText('End All 2', { exact: true }).click()
    check('End ends both', await lib.until(() => two.every((p) => !alive(p)), 10000))
    check('and they are no longer listed or shown', (await lib.until(async () => !(await listed()) && (await chip.count()) === 0, 10000)) === true)
    check("the stranger's process still runs", alive(stranger.pid))

    // Keep Running: no longer listed, still running.
    const one = await leaveRunning(1)
    await lib.until(async () => (await listed())?.processes.length === 1, 15000)
    const kept = await inv('session:settleLeftovers', proj, agent.id, 'keep')
    check('Keep Running stops listing it and leaves it running', kept === 1 && !(await listed()) && one.every(alive), JSON.stringify({ kept, one }))
    lib.endExactly(one.map((p) => ids.get(p)).filter(Boolean))

    // End them (the setting): ended as the agent stops, never listed.
    await inv('settings:update', { agents: { leftoverProcesses: 'end' } })
    const auto = await leaveRunning(1)
    check('with End them set, they are ended as the agent stops', await lib.until(() => auto.every((p) => !alive(p)), 15000), JSON.stringify(auto))
    check('and nothing is listed', !(await listed()))

    // End them, but Windows refuses (CW_TEST_JOB_KILL_FAILS): still listed and offered, and End from the ⋯ works.
    await app.evaluate(() => (process.env.CW_TEST_JOB_KILL_FAILS = '1'))
    const refused = await leaveRunning(1)
    const offer = page.locator('.toast', { hasText: "couldn't end it by itself" })
    check("a refused End leaves it listed, offered, and says Combwork couldn't end it", (await lib.until(async () => (await listed())?.processes.length === 1, 15000)) && (await offer.first().waitFor({ timeout: 10000 }).then(() => true, () => false)) && refused.every(alive))
    await app.evaluate(() => delete process.env.CW_TEST_JOB_KILL_FAILS)
    await openLeftovers(1)
    await page.getByText('End It', { exact: true }).click()
    check('trying again from the ⋯ ends it', (await lib.until(() => refused.every((p) => !alive(p)), 10000)) && (await lib.until(async () => !(await listed()), 10000)))

    // Quitting with some listed asks, and ends them on End Them.
    await inv('settings:update', { agents: { leftoverProcesses: 'ask' } })
    const atQuit = await leaveRunning(1)
    await lib.until(async () => (await listed())?.processes.length === 1, 15000)
    const asked = path.join(base, 'quit-asked.json')
    await app.evaluate(({ dialog }, f) => {
      dialog.showMessageBox = async (_w, opts) => {
        process.mainModule.require('fs').writeFileSync(f, JSON.stringify({ message: opts.message, detail: opts.detail, buttons: opts.buttons }))
        return { response: 0, checkboxChecked: false }
      }
    }, asked)
    await app.close()
    const q = fs.existsSync(asked) ? JSON.parse(fs.readFileSync(asked, 'utf8')) : null
    check('quitting asks about what the agent left running', !!q && /left 1 process running/.test(q.message) && /site · Website: node /.test(q.detail) && q.buttons[0] === 'End Them', JSON.stringify(q))
    check('and End Them ends it', await lib.until(() => atQuit.every((p) => !alive(p)), 10000))
    check("the stranger's process outlives Combwork", alive(stranger.pid), `checked ${Math.round((Date.now() - strangerAt) / 1000)} s after it started`)
  } finally {
    await app.close().catch(() => undefined)
    lib.endExactly([...ids.values()])
  }

  // A PC where the process tracker never gets going (CW_TEST_PROCESS_TRACKER=silent: its helper starts but never says it is ready; given up on after CW_TEST_TRACKER_WAIT_MS): agents start
  // all the same, untracked, and Combwork says so once; Diagnostics says why.
  const second = await lib.launch({ userData, env: { ...env, CW_API_PORT: lib.port(47882), CW_TEST_PROCESS_TRACKER: 'silent', CW_TEST_TRACKER_WAIT_MS: '3000' } })
  try {
    const { page: p2, inv: inv2 } = second
    await lib.openWorkspace(inv2, p2, ws)
    await lib.waitForProvider(inv2)
    const agentId = (await lib.soloAgent(inv2, proj, { name: 'Website' })).id
    const live2 = async () => (await inv2('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === agentId)
    for (let round = 0; round < 2; round++) {
      await inv2('session:start', proj, { agentId })
      check(`untracked, the agent still starts (launch ${round + 1})`, await lib.until(async () => ['ready', 'finished'].includes((await live2())?.status), 30000))
      await inv2('session:stop', proj, agentId)
      await lib.until(async () => !(await live2()), 15000)
    }
    const notice = p2.locator('.toast', { hasText: "Combwork can't keep track of agents' processes" })
    check('Combwork says once that it can’t track agents’ processes', (await notice.first().waitFor({ timeout: 5000 }).then(() => notice.count(), () => 0)) === 1)
    const diag = await inv2('app:diagnostics')
    check('Diagnostics says why', /Agents' processes: not tracked: The PowerShell helper of Combwork's process tracker didn't start within 3 seconds/.test(diag), diag.split('\n').find((l) => l.includes("Agents' processes")))
  } finally {
    await second.app.close().catch(() => undefined)
    lib.endExactly([...ids.values()])
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  lib.endExactly([...ids.values()])
  process.exit(1)
})
