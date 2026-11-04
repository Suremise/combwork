// Release Slot… on a held writer (#1506, SPEC §16.10.3 One writer): a slot whose writer's Hive has gone is the user's
// to release. B1 is lent slot-a (`slots:test`, as a card's start does) and started there, on the fake Claude Code:
// 1. While B1 runs there, and while what it left running is still followed, Release is refused ("still running in
//    this Hive"), and the slot isn't listed as held. Its leftover kept running (Keep Running): held by this Hive, and
//    the question from B1's ⋯ names the run and this Hive (its process, running); Release frees it.
// 2. B1 again, leaving a process running, and that Hive is ended from outside (its own process tree but that process,
//    by pid and start time, never by name), as a crash would: the next Hive, on the same profile, finds in the last
//    run's marker that B1's process still runs, so slot-a's writer (#12's lease still open) stays held, and B1's ⋯
//    offers Release Slot….
// 3. The Version Control tab's slot list shows slot-a held by B1's ended session with Release…, and so does Branches &
//    remotes' Worktrees list (HI-1886); its question names the run and the Hive that is gone, and lists the process
//    still running; Release ends it and frees the slot, and B1 starts there again.
// 4. (HI-1886) That Hive crashes with B1 running and nothing of it spared: the marker's list of B1's processes, all gone
//    now, proves nothing (what they started since isn't in it), so slot-a stays held and B1's own start is refused.
//    Released, B1 runs there again and Hive quits as the user quits it: the next Hive finds slot-a free, its run seen
//    ended, and B1 resumes there.
// Screenshots of both questions, light and dark. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1580): slot-a is lent through slots:test, which a packaged build refuses.
const lib = require('./lib.cjs')
const { processes, descendantsIn, endAsCrash } = require('./folderProcesses.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 45000

const at = (x) => path.join(lib.WORK, `slotrelease-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const shots = at('shots')
const alpha = path.join(ws, 'alpha')
const root = path.join(`${ws}.worktrees`, 'alpha')
// slotsessions' default too: run on its own (no runner's lane), never beside it.
const PORT = Number(lib.port(47817))
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/** Ends a test Hive from outside, as a crash would: its main process first, then all it started, each by pid and start time. */
async function endFromOutside(app, spare = []) {
  const proc = app.process()
  const gone = new Promise((r) => (proc.exitCode !== null ? r(true) : proc.once('exit', () => r(true))))
  const id = lib.identify([proc.pid])[0]
  const list = processes()
  const top = id && list.find((p) => p.pid === id.pid && Math.abs(p.started - id.started) <= 1)
  // `spare`: what an agent left running, which outlives the crash (as a detached process would).
  const ended = top ? endAsCrash(list, { pid: top.pid, started: top.started }, descendantsIn(list, top.pid).filter((p) => !spare.includes(p.pid))) : 0
  return ended > 0 && !!(await lib.until(() => gone, HUNG_MS))
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha)
  const env = lib.fakeClaude(userData, home, [alpha, ws, path.join(root, 'slot-a')])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let h = null
  const start = async () => {
    h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT) }, viewport: { width: 1400, height: 950 } })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(h.inv)
    await lib.openWorkspace(h.inv, h.page, ws)
  }
  const inv = (...a) => h.inv(...a)
  // Each wait passes its bound (HUNG_MS), as test:waits checks (#1576): a default here would hide it.
  const until = (fn, ms) => lib.until(fn, ms, 250)
  const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
  const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
  const slotA = async () => (await inv('slots:list', alpha)).find((s) => s.name === 'slot-a')
  const agentInfo = async (id) => (await inv('workspace:refresh')).projects.find((p) => same(p.path, alpha))?.agents.find((a) => a.id === id)
  const dialog = () => h.page.locator('.dialog', { hasText: 'Release B1' })
  /** The question in both themes (the window as it is, the dialog open). */
  const themed = async (name) => {
    for (const theme of ['light', 'dark']) {
      await h.page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await h.page.screenshot({ path: path.join(shots, `slotrelease-${name}-${theme}.png`) })
    }
  }
  /** B1's lingering node, by pid and start time: ended once its step is done, or at the end. */
  const kept = []

  try {
    await start()
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })

    // --- 1. B1 runs in slot-a: its writer is live, and Release is refused.
    const lent = await inv('slots:test', alpha, { op: 'lend', agent: b1.id, card: 12 })
    check('#12 is lent slot-a for B1', lent?.ok && lent.slot.name === 'slot-a', JSON.stringify(lent))
    await inv('session:start', alpha, { agentId: b1.id })
    const s1 = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check('B1 runs in slot-a', s1?.slot === 'slot-a', JSON.stringify(s1))
    const w1 = await inv('slots:heldWriter', alpha, 'slot-a')
    check('…its run is slot-a\'s writer, live in this Hive', w1?.agent === b1.id && w1.live === true && w1.hive.self === true, JSON.stringify(w1))
    check('…not listed as held', (await slotA())?.writer?.held === false && !(await agentInfo(b1.id))?.heldSlot)
    const releaseNow = (run) => inv('slots:releaseWriter', alpha, 'slot-a', run, false).then(() => 'released', (e) => String(e?.message ?? e))
    const refused = await releaseNow(w1.run)
    check('Release is refused while its run is live', /still running in this Combwork/.test(refused), refused)
    check('…and slot-a keeps its writer', (await slotA())?.writer?.agent === b1.id)

    // B1 leaves a process running and is stopped: while Hive follows it, still live; kept running, held by this Hive.
    const key = lib.ptyKey(alpha, b1.id)
    const lingerFile = path.join(home, 'fake-linger.jsonl')
    const lingering = () => (fs.existsSync(lingerFile) ? fs.readFileSync(lingerFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).pid) : [])
    await lib.sendPrompt(inv, key, 'linger 1', { submitted: async () => (await live(b1.id))?.status === 'working' || lingering().length > 0 })
    check('B1 leaves a process running', !!(await until(async () => lingering().length === 1 && (await idle(b1.id)), HUNG_MS)))
    kept.push(...lib.identify(lingering()))
    await inv('session:stop', alpha, b1.id)
    check('…stopped, its leftover listed', !!(await until(async () => !(await live(b1.id)) && (await inv('session:leftovers')).some((l) => l.agentId === b1.id), HUNG_MS)))
    const followed = await releaseNow(w1.run)
    check('Release is refused while Hive still follows what it left running', /still running in this Combwork/.test(followed), followed)
    await inv('session:settleLeftovers', alpha, b1.id, 'keep')
    const wSelf = await until(async () => {
      const w = await inv('slots:heldWriter', alpha, 'slot-a')
      return w && !w.live ? w : null
    }, HUNG_MS)
    check('kept running: slot-a held by this Hive, nothing listed of its processes', wSelf?.run === w1.run && wSelf.hive.self && wSelf.processes === null, JSON.stringify(wSelf))
    check("…B1's ⋯ offers Release Slot…", !!(await until(async () => (await agentInfo(b1.id))?.heldSlot === 'slot-a', HUNG_MS)) && (await lib.agentMenu(h.page, 'B1')).some((t) => t.startsWith('Release Slot…')))
    await lib.menuEntry(h.page, 'Release Slot…').click()
    await dialog().waitFor({ timeout: HUNG_MS })
    const saidSelf = await dialog().innerText()
    check('its question names the run and this Hive (its process, running)', saidSelf.includes(`(run ${w1.run})`) && saidSelf.includes(`in this Combwork (process ${w1.hive.pid}, running)`), saidSelf)
    await themed('self', dialog())
    await dialog().getByRole('button', { name: 'Release', exact: true }).click()
    await dialog().waitFor({ state: 'detached', timeout: HUNG_MS })
    check('Release frees it', !!(await until(async () => !(await slotA())?.writer, HUNG_MS)), JSON.stringify(await slotA()))
    lib.endExactly(kept.splice(0))

    // --- 2. B1 again, leaving a process running, and that Hive ends as a crash would: the next one lists slot-a's
    // writer as held, that process listed (it still runs).
    const markerFile = path.join(userData, 'running.json')
    const marked = (pid) => {
      try {
        return JSON.parse(fs.readFileSync(markerFile, 'utf8')).processes?.some((l) => l.agentId === b1.id && l.processes.some((p) => p.pid === pid)) === true
      } catch {
        return false
      }
    }
    /** B1 runs in slot-a and leaves a process running, listed in the running marker: its run and that process's pid. */
    const runAndLinger = async (what) => {
      await inv('session:start', alpha, { agentId: b1.id })
      const s = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
      const before = lingering()
      await lib.sendPrompt(inv, key, 'linger 1', { submitted: async () => (await live(b1.id))?.status === 'working' || lingering().length > before.length })
      const pid = await until(async () => ((await idle(b1.id)) ? lingering().find((p) => !before.includes(p)) : null), HUNG_MS)
      kept.push(...lib.identify(pid ? [pid] : []))
      check(`${what}: B1 runs in slot-a and leaves a process running, which the running marker lists`, s?.slot === 'slot-a' && !!pid && !!(await until(() => marked(pid), HUNG_MS)), JSON.stringify(s))
      return { run: s?.runId, pid }
    }
    const r2 = await runAndLinger('again')
    const w1b = await inv('slots:heldWriter', alpha, 'slot-a')
    check('…its new run the writer', w1b?.run === r2.run && w1b.run !== w1.run, JSON.stringify(w1b))
    w1.run = w1b.run
    check('the first Hive is ended from outside, the process B1 left still running', (await endFromOutside(h.app, [r2.pid])) && lib.identify([r2.pid]).length === 1)
    await start()
    const w2 = await until(async () => {
      const w = await inv('slots:heldWriter', alpha, 'slot-a')
      return w && w.hive.alive === false ? w : null
    }, HUNG_MS)
    check("the next Hive sees slot-a's writer held by a Hive that has gone, the process still running listed", w2?.run === w1.run && !w2.hive.self && w2.hive.pid === w1.hive.pid && !w2.live && w2.processes?.from === 'restart' && w2.processes.list.some((p) => p.pid === r2.pid), JSON.stringify(w2))
    check('…listed as held', !!(await until(async () => (await slotA())?.writer?.held === true, HUNG_MS)))
    check("…and B1's ⋯ offers Release Slot…", !!(await until(async () => (await agentInfo(b1.id))?.heldSlot === 'slot-a', HUNG_MS)) && (await lib.agentMenu(h.page, 'B1')).some((t) => t.startsWith('Release Slot…')))
    await h.page.keyboard.press('Escape')

    // --- 3. The Version Control tab: Worktrees and the slot list show it held, with Release…; the question; released.
    await h.page.getByText('alpha', { exact: true }).first().click()
    await h.page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await h.page.locator('[role="tab"][data-section="branches"]').click()
    const tree = h.page.locator('.git-worktree[data-slot="slot-a"]')
    check("Branches & remotes' Worktrees list shows slot-a held by B1's ended session, with Release…", !!(await until(async () => (await tree.locator(`[data-held="${b1.id}"]`).count()) === 1 && (await tree.locator('[data-action="release-held"]').count()) === 1, HUNG_MS)) && /Held by an ended session of agent B1/.test(await tree.innerText()), await tree.innerText().catch(() => ''))
    await h.page.screenshot({ path: path.join(shots, 'slotrelease-worktrees.png') })
    await h.page.locator('.git-sections [data-section="workflow"]').click()
    const section = h.page.locator('.workflow-form')
    await section.waitFor({ timeout: HUNG_MS })
    await section.locator('.workflow-option[data-option="folder"] select').selectOption('slots')
    const row = section.locator('.workflow-slots-table tr[data-slot="slot-a"]')
    check('the slot list shows slot-a held by B1\'s ended session', !!(await until(async () => (await row.locator(`[data-held="${b1.id}"]`).count()) === 1, HUNG_MS)) && /Held by an ended session of agent B1/.test(await row.innerText()), await row.innerText().catch(() => ''))
    await row.locator('[data-action="release-held"]').click()
    await dialog().waitFor({ timeout: HUNG_MS })
    const said = await dialog().innerText()
    check('its question names the run and the Hive that has gone, and lists the process still running', said.includes("Release B1's slot slot-a?") && said.includes(`(run ${w1.run}) in a Combwork that is no longer running (process ${w1.hive.pid})`) && said.includes(`(process ${r2.pid})`) && /Combwork lists 1 process/.test(said), said)
    await themed('gone', dialog())
    await dialog().getByRole('button', { name: 'Release', exact: true }).click()
    await dialog().waitFor({ state: 'detached', timeout: HUNG_MS })
    check('Release frees slot-a: no writer, still lent to #12', !!(await until(async () => {
      const s = await slotA()
      return s && !s.writer && s.lease?.card === 12
    }, HUNG_MS)), JSON.stringify(await slotA()))
    check("…the list and B1's ⋯ no longer offer it", !!(await until(async () => (await row.locator('[data-action="release-held"]').count()) === 0 && !(await agentInfo(b1.id))?.heldSlot, HUNG_MS)))
    await inv('session:start', alpha, { agentId: b1.id })
    const s3 = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check('B1 starts in slot-a again', s3?.slot === 'slot-a' && (await inv('slots:heldWriter', alpha, 'slot-a'))?.run === s3.runId, JSON.stringify(s3))
    check('…the process it had left ended by the release', !!(await until(() => lib.identify([r2.pid]).length === 0, HUNG_MS)))

    // --- 4. (HI-1886) A crash's list of processes never frees the slot; a quit's ended run does.
    const markedRun = (run) => {
      try {
        return JSON.parse(fs.readFileSync(markerFile, 'utf8')).processes?.some((l) => l.runId === run && l.processes.length > 0) === true
      } catch {
        return false
      }
    }
    check("…the running marker lists the launch's processes", !!(await until(() => markedRun(s3.runId), HUNG_MS)))
    check('the Hive is ended from outside with nothing of B1 left running', await endFromOutside(h.app))
    await start()
    check("the next Hive keeps slot-a held: the marker's list, all gone, doesn't prove what they started has", !!(await until(async () => (await slotA())?.writer?.held === true && (await inv('slots:heldWriter', alpha, 'slot-a'))?.run === s3.runId, HUNG_MS)), JSON.stringify(await slotA()))
    const ownRefused = await inv('session:start', alpha, { agentId: b1.id }).then(() => 'started', (e) => String(e?.message ?? e))
    check("…and B1's own start there is refused", /still has another session in it/.test(ownRefused), ownRefused)
    await inv('slots:releaseWriter', alpha, 'slot-a', s3.runId, false)
    await inv('session:start', alpha, { agentId: b1.id })
    const s4 = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check('released, B1 runs in slot-a again', s4?.slot === 'slot-a' && (await inv('slots:heldWriter', alpha, 'slot-a'))?.run === s4.runId, JSON.stringify(s4))
    await h.app.close()
    h = null
    await start()
    check('after a quit, the next Hive finds slot-a free: no writer, still lent to #12', !!(await until(async () => {
      const s = await slotA()
      return s && !s.writer && s.lease?.card === 12
    }, HUNG_MS)), JSON.stringify(await slotA()))
    await inv('session:start', alpha, { agentId: b1.id })
    const s5 = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check('B1 starts in slot-a', s5?.slot === 'slot-a', JSON.stringify(s5))
  } finally {
    await h?.app.close().catch(() => undefined)
    lib.endExactly(kept)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
