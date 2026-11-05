// Sessions on leases (#1434, S35; SPEC §16.10.2–16.10.3): a Git project's slots lent through the test copies'
// `slots:test` channel (as #1438's card start will), on the fake Claude Code:
// 1. B1's card #12 gets slot-a: B1's new conversation starts there, with CW_SLOT and CW_SLOT_PORT_BASE, bound to
//    the lease. The lease ends while B1 is in a turn: its session is stopped once the turn is over. #13's lease ends
//    while B1's next run there is still starting (its CLI asking to trust the folder): slot-a isn't lent meanwhile, and
//    is free once that run is idle and stopped.
// 2. slot-a free at that revision: Resume All resumes R1 (the project folder) and leaves B1, listing it with why ("its
//    slot is free. Resume it by hand to take it") and a Show that opens the Sessions tab on its conversation.
// 3. A new card (#14, B2) gets slot-a meanwhile: B1's Resume is refused with why ("now holds #14's work"), offering Read
//    Transcript and Start Fresh with a Handover; two launches for slot-a at once: B2's runs, B1's is refused.
// 4. A restart with #14's lease open: Resume All resumes B2 in slot-a, and lists B1 ("its slot now holds #14's work").
// 5. #14 ends and slot-a stays free: Resume All leaves B2, and B2's own Resume takes slot-a again under a new lease.
// 6. B1 keeps a dirty carried slot (hb1, #1441's adoption) and gets card #15 in slot-b: its new conversation starts in
//    slot-b, and its hb1 conversation is refused ("on #15 in slot-b: resume this after #15") until #15 ends, then resumes.
// Screenshots of the refusals and Resume All's list, light and dark. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
// Dev build only (#1580): its slots are lent through slots:test, which a packaged build refuses.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 45000

const userData = path.join(lib.WORK, 'slotsessions-profile')
const ws = path.join(lib.WORK, 'slotsessions-ws')
const home = path.join(lib.WORK, 'slotsessions-claude-home')
const shots = path.join(lib.WORK, 'slotsessions-shots')
const alpha = path.join(ws, 'alpha')
const root = path.join(`${ws}.worktrees`, 'alpha')
const PORT = Number(lib.port(47817))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha)
  const env = lib.fakeClaude(userData, home, [alpha, ws, ...['slot-a', 'slot-b', 'hb1'].map((s) => path.join(root, s))])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let h = null
  const start = async () => {
    h = await lib.launch({ userData, env: { ...env, CW_API_PORT: String(PORT) }, viewport: { width: 1400, height: 850 } })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(h.inv)
    await lib.openWorkspace(h.inv, h.page, ws)
  }
  const inv = (...a) => h.inv(...a)
  const until = (fn, ms) => lib.until(fn, ms, 250)
  const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
  const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
  const stopped = async (id) => !(await live(id))
  const say = async (id, text) => {
    await inv('pty:write', lib.ptyKey(alpha, id), text)
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(alpha, id), '\r')
  }
  const op = (o) => inv('slots:test', alpha, o)
  const slotList = () => inv('slots:list', alpha)
  const sessionOf = async (id) => (await inv('session:list', alpha)).find((s) => s.id === id)
  const agentInfo = async (id) => (await inv('workspace:refresh')).projects.find((p) => same(p.path, alpha))?.agents.find((a) => a.id === id)
  const stop = async (id) => {
    await inv('session:stop', alpha, id)
    return !!(await until(() => stopped(id), HUNG_MS))
  }
  const toastText = () => h.page.locator('.toast').allInnerTexts().then((t) => t.join('\n'))
  const themed = async (name, shoot) => {
    for (const theme of ['light', 'dark']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await h.page.evaluate(() => document.documentElement.dataset.theme ?? document.body.className)).includes(theme), HUNG_MS)
      await shoot(path.join(shots, `slotsessions-${name}-${theme}.png`))
    }
  }

  try {
    await start()
    await lib.fitWindow(h.app, h.page, { width: 1400, height: 850 })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const b2 = await lib.addAgent(inv, alpha, { name: 'B2', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    // The pool is the project's builders (#1438): a third, never started, so step 6 has slot-a, hb1 and slot-b.
    await lib.addAgent(inv, alpha, { name: 'B3', workflowRole: 'builder' })

    // #12 is a real card (HI-1661 round 1, finding 1): a card about the workspace takes a number first, so alpha's card's
    // key has other digits than its workspace number, and Start Fresh must name it by key (below).
    await inv('tasks:create', { title: 'About the workspace' })
    const inFlight = await inv('tasks:create', { title: 'Still in flight', project: 'alpha' })
    check("a card whose key's digits aren't its number", !!inFlight.key && !inFlight.key.endsWith(`-${inFlight.number}`), JSON.stringify({ key: inFlight.key, number: inFlight.number }))

    // --- 1. #12's lease on slot-a: B1's new conversation there, with its environment, bound; stopped at the lease's end.
    const l12 = await op({ op: 'lend', agent: b1.id, card: inFlight.number })
    const folderA = l12.slot?.folder
    check('#12 is lent slot-a for B1', l12.ok && l12.slot.name === 'slot-a' && same(folderA, path.join(root, 'slot-a')), JSON.stringify(l12))
    await inv('session:start', alpha, { agentId: b1.id })
    const s1 = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check("B1's new conversation starts in its card's slot", same(s1?.cwd, folderA) && s1?.slot === 'slot-a', JSON.stringify(s1))
    check('…the fake Claude Code was started there', same(lines(path.join(home, 'fake-launches.jsonl')).at(-1)?.cwd, folderA))
    await say(b1.id, 'shell: echo %CW_SLOT% %CW_SLOT_PORT_BASE%')
    const echoed = await until(() => lines(path.join(home, 'fake-shell.jsonl')).find((l) => l.agent === 'B1'), HUNG_MS)
    check('…with CW_SLOT and CW_SLOT_PORT_BASE', echoed?.stdout?.trim() === `slot-a ${l12.slot.portBase}`, JSON.stringify(echoed))
    const conv1 = s1.sessionId
    check('…its session recorded in slot-a, bound to #12\'s lease', !!(await until(async () => (await sessionOf(conv1))?.lease === l12.lease.id, HUNG_MS)) && (await sessionOf(conv1)).slot === 'slot-a' && !(await sessionOf(conv1)).hold, JSON.stringify(await sessionOf(conv1)))
    await until(() => idle(b1.id), HUNG_MS)
    await inv('session:start', alpha, { agentId: r1.id })
    const sr = await until(async () => ((await idle(r1.id)) ? live(r1.id) : null), HUNG_MS)
    check("R1 (a reviewer) starts in the project folder, never a slot", same(sr?.cwd, alpha) && !sr?.slot, JSON.stringify(sr))
    // Start Fresh (Idle Agents): R1 would start fresh, B1 is left, its slot's card named by key (cancelled here).
    await lib.agentsMenuRun(h.page, 'Start Fresh (Idle Agents)…')
    const question = h.page.locator('.modal, [role="dialog"]').filter({ hasText: 'B1:' }).first()
    check(`Start Fresh lists B1 with its slot's card by key: "${inFlight.key} is still in flight"`, !!(await until(async () => (await question.innerText().catch(() => '')).includes(`B1: ${inFlight.key} is still in flight`), HUNG_MS)) && !(await question.innerText()).includes(`#${inFlight.number}`), await question.innerText().catch(() => ''))
    await h.page.keyboard.press('Escape')
    await until(async () => (await question.count()) === 0, HUNG_MS)
    check('…R1 stopped', await stop(r1.id))
    await say(b1.id, 'holduntil lease-go')
    check('B1 is in a turn', !!(await until(async () => (await live(b1.id))?.status === 'working', HUNG_MS)))
    check("#12's lease ends (Done)", (await op({ op: 'release', lease: l12.lease.id, why: 'done' })) === true)
    check("…B1's session still runs while its turn goes on", (await live(b1.id))?.status === 'working')
    fs.writeFileSync(path.join(home, 'lease-go'), '')
    check('…and is stopped once the turn is over', !!(await until(() => stopped(b1.id), HUNG_MS)))
    check('slot-a is free and ready again', !!(await until(async () => (await slotList()).find((s) => s.name === 'slot-a' && s.state === 'ready' && !s.lease), HUNG_MS)))

    // --- 1b. #13's lease ends while B1's run there hasn't started its work yet (its CLI asking to trust the folder):
    // the slot stays that run's (not lent again) until it is idle and stopped, then is free.
    const l13 = await op({ op: 'lend', agent: b1.id, card: 13 })
    check('#13 is lent slot-a for B1 again', l13.ok && l13.slot.name === 'slot-a', JSON.stringify(l13))
    const trustFile = path.join(home, 'fake-trusted.json')
    fs.writeFileSync(trustFile, JSON.stringify(JSON.parse(fs.readFileSync(trustFile, 'utf8')).filter((f) => !same(f, folderA))))
    await inv('session:start', alpha, { agentId: b1.id })
    const asking = async () => /trust this folder/i.test(await inv('pty:buffer', lib.ptyKey(alpha, b1.id)).catch(() => ''))
    check('B1 is starting in slot-a, its CLI asking first', !!(await until(async () => (await asking()) && (await live(b1.id))?.slot === 'slot-a', HUNG_MS)))
    check('…slot-a is written by it', (await slotList()).find((s) => s.name === 'slot-a')?.writer?.agent === b1.id)
    await op({ op: 'release', lease: l13.lease.id, why: 'put back' })
    const lendNow = await op({ op: 'lend', agent: b2.id, card: 99, slot: 'slot-a' })
    check("#13 put back before B1's run is idle: slot-a isn't lent to anyone meanwhile", !lendNow.ok && !!(await live(b1.id)) && !!(await slotList()).find((s) => s.name === 'slot-a')?.writer, JSON.stringify(lendNow))
    await lib.acceptClaudeTrust(inv, alpha, b1.id, HUNG_MS)
    check('…once it is idle, it is stopped, and the slot is free and ready', !!(await until(async () => (await stopped(b1.id)) && !!(await slotList()).find((s) => s.name === 'slot-a' && !s.writer && !s.lease && s.state === 'ready'), HUNG_MS)))

    // --- 2. Resume All: R1 resumes, B1 is left and listed (its slot is free: only its own Resume takes it).
    const held1 = await until(async () => ((await agentInfo(b1.id))?.resume?.hold?.is === 'byHand' ? (await agentInfo(b1.id)).resume.hold : null), HUNG_MS)
    check("B1's conversation may resume only by hand", held1?.is === 'byHand' && held1.slot === 'slot-a', JSON.stringify(held1))
    const resumeAll = h.page.locator('button.act-resume.quiet')
    await until(async () => (await resumeAll.count()) === 1, HUNG_MS)
    await resumeAll.click()
    check('Resume All resumes R1', !!(await until(() => idle(r1.id), HUNG_MS)))
    const leftNote = h.page.locator('.toast', { hasText: 'B1: its slot is free. Resume it by hand to take it' }).first()
    check('…and leaves B1 stopped, listed with why', (await stopped(b1.id)) && !!(await until(async () => (await toastText()).includes('Resume All left one agent') && (await leftNote.count()) === 1, HUNG_MS)), await toastText())
    await themed('resume-all-left', (file) => leftNote.screenshot({ path: file }))
    await leftNote.locator('button', { hasText: 'Show B1' }).click()
    check("…its Show opens the Sessions tab on B1's conversation", !!(await until(async () => (await h.page.locator('text=Ran in B1').count()) > 0, HUNG_MS)))
    // Back to the agents' panes.
    await h.app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'menu-command', command: 'project.tab.session', args: [] })
    check('…slot-a still free', !(await slotList()).find((s) => s.name === 'slot-a')?.lease)

    // --- 3. A new card gets slot-a meanwhile: B1's conversation is refused with why; two launches for slot-a at once.
    const l14 = await op({ op: 'lend', agent: b2.id, card: 14 })
    check('#14 (B2) gets the free slot-a', l14.ok && l14.slot.name === 'slot-a', JSON.stringify(l14))
    const held2 = await until(async () => ((await sessionOf(conv1))?.hold?.is === 'reused' ? (await sessionOf(conv1)).hold : null), HUNG_MS)
    check("B1's conversation: its slot now holds #14's work", held2?.card === 14, JSON.stringify(held2))
    const refused = await inv('session:start', alpha, { agentId: b1.id, resumeId: conv1 }).then(
      () => null,
      (e) => String(e?.message ?? e)
    )
    check("…its Resume is refused, saying why", /slot \(slot-a\) now holds .*14.* work/.test(refused ?? ''), refused)
    // The pane's Resume: why, with what can be done instead.
    await lib.showAgent(h.page, 'B1')
    const header = h.page.locator('.pane-header-bar').filter({ has: h.page.locator('.agent-name', { hasText: /^B1$/ }) }).first()
    await header.locator('button.act-resume').first().click()
    const notice = h.page.locator('.toast', { hasText: "Can't resume here now" }).first()
    check('…the pane says why, offering Read Transcript and Start Fresh with a Handover', !!(await until(async () => (await notice.count()) === 1 && (await notice.innerText()).includes('Read Transcript') && (await notice.innerText()).includes('Start Fresh with a Handover'), HUNG_MS)), await toastText())
    await themed('refused-notice', (file) => notice.screenshot({ path: file }))
    await notice.locator('button', { hasText: 'Read Transcript' }).click()
    const fresh = h.page.locator('[data-action="start-fresh-handover"]')
    check('…Read Transcript opens it in the Sessions tab, where Resume says why and Start Fresh is offered', !!(await until(async () => (await fresh.count()) === 1, HUNG_MS)))
    await themed('refused-sessions-tab', (file) => h.page.screenshot({ path: file }))
    await h.page.keyboard.press('Escape')
    await inv('settings:update', { appearance: { theme: 'light' } })
    const [newB2, resumeB1] = await Promise.allSettled([inv('session:start', alpha, { agentId: b2.id }), inv('session:start', alpha, { agentId: b1.id, resumeId: conv1 })])
    check('two launches for slot-a at once: B2 (its lease) starts there, B1 is refused', newB2.status === 'fulfilled' && same(newB2.value.cwd, folderA) && resumeB1.status === 'rejected', JSON.stringify([newB2.status, resumeB1.reason?.message]))
    await until(() => idle(b2.id), HUNG_MS)
    const conv2 = (await live(b2.id))?.sessionId
    check("…B2's conversation bound to #14's lease", !!(await until(async () => (await sessionOf(conv2))?.lease === l14.lease.id, HUNG_MS)))

    // --- 4. A restart with #14's lease open: Resume All resumes B2 in slot-a and lists B1.
    await h.app.close()
    await start()
    const resumeAll2 = h.page.locator('button.act-resume.quiet')
    await until(async () => (await resumeAll2.count()) === 1, HUNG_MS)
    await resumeAll2.click()
    const back = await until(async () => ((await idle(b2.id)) ? live(b2.id) : null), HUNG_MS)
    check("after a restart, Resume All resumes B2's conversation in slot-a under #14's open lease", back?.sessionId === conv2 && same(back?.cwd, folderA) && back?.slot === 'slot-a', JSON.stringify(back))
    const reusedNote = h.page.locator('.toast', { hasText: "B1: its slot now holds #14's work" }).first()
    check("…and lists B1 with why: its slot now holds #14's work, with Show B1", !!(await until(async () => (await reusedNote.count()) === 1 && (await reusedNote.locator('button', { hasText: 'Show B1' }).count()) === 1, HUNG_MS)) && (await stopped(b1.id)), await toastText())
    await themed('resume-all-reused', (file) => reusedNote.screenshot({ path: file }))
    await inv('settings:update', { appearance: { theme: 'light' } })

    // --- 5. #14 ends, slot-a stays free: Resume All leaves B2; B2's own Resume takes slot-a under a new lease.
    await op({ op: 'release', lease: l14.lease.id, why: 'done' })
    check("#14's end stops B2's idle session", !!(await until(() => stopped(b2.id), HUNG_MS)))
    check("B2's conversation may resume only by hand (once its run has handed the slot back)", !!(await until(async () => (await agentInfo(b2.id))?.resume?.hold?.is === 'byHand', HUNG_MS)))
    await inv('session:start', alpha, { agentId: b2.id, resumeId: conv2, auto: true }).catch(() => undefined)
    check('…an automatic resume (Resume All, startup) leaves it', (await stopped(b2.id)) && !(await slotList()).find((s) => s.name === 'slot-a')?.lease)
    await inv('session:start', alpha, { agentId: b2.id, resumeId: conv2 })
    const took = await until(async () => ((await idle(b2.id)) ? live(b2.id) : null), HUNG_MS)
    const leaseA = (await slotList()).find((s) => s.name === 'slot-a')?.lease
    check("B2's own Resume takes the free slot-a again, under a new lease of its own", same(took?.cwd, folderA) && took?.sessionId === conv2 && leaseA?.agent === b2.id && leaseA?.kind === 'carried' && leaseA.id !== l14.lease.id, JSON.stringify(leaseA))
    check("…its conversation rebound to that lease", !!(await until(async () => (await sessionOf(conv2))?.lease === leaseA?.id, HUNG_MS)))

    // --- 6. A builder with a dirty carried slot and a card in another: the card's slot wins, the old one waits.
    const hb1 = path.join(root, 'hb1')
    lib.git(alpha, ['worktree', 'add', '-q', '-b', 'hive/hb1', hb1])
    const carried = await op({ op: 'carry', agent: b1.id, slot: 'hb1', folder: hb1 })
    check("B1's own worktree hb1 is adopted as its carried slot", carried?.kind === 'carried' && carried.agent === b1.id, JSON.stringify(carried))
    await inv('session:start', alpha, { agentId: b1.id })
    const inHb1 = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check("B1's new conversation (no card) starts in its carried slot", same(inHb1?.cwd, hb1) && inHb1?.slot === 'hb1', JSON.stringify(inHb1))
    const conv3 = inHb1.sessionId
    await until(async () => (await sessionOf(conv3))?.lease === carried.id, HUNG_MS)
    fs.writeFileSync(path.join(hb1, 'unfinished.txt'), 'work in progress\n')
    check('…B1 stopped, its slot left dirty', await stop(b1.id))
    const l15 = await op({ op: 'lend', agent: b1.id, card: 15 })
    check('#15 is lent B1 another slot (slot-b)', l15.ok && l15.slot.name === 'slot-b', JSON.stringify(l15))
    const after = await until(async () => ((await sessionOf(conv3))?.hold?.is === 'after' ? (await sessionOf(conv3)).hold : null), HUNG_MS)
    check("…B1's hb1 conversation waits for #15", after?.slot === 'slot-b' && after.card === 15, JSON.stringify(after))
    const waits = await inv('session:start', alpha, { agentId: b1.id, resumeId: conv3 }).then(
      () => null,
      (e) => String(e?.message ?? e)
    )
    check('…its Resume is refused: "B1 is on #15 in slot-b: resume this after #15"', /B1 is on .*15.* in slot-b: resume this after .*15/.test(waits ?? ''), waits)
    await inv('session:start', alpha, { agentId: b1.id })
    const inB = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check("…a new conversation goes to #15's slot-b", same(inB?.cwd, l15.slot.folder) && inB?.slot === 'slot-b', JSON.stringify(inB))
    check('…B1 stopped', await stop(b1.id))
    await op({ op: 'release', lease: l15.lease.id, why: 'put back' })
    check('#15 put back: the hb1 conversation may resume now', !!(await until(async () => !(await sessionOf(conv3))?.hold, HUNG_MS)))
    // One writer per slot (#1434): hb1's earlier run is its writer until its processes are seen ended (#1516: that can
    // take a poll of the process watcher, after the hold has cleared).
    check("…hb1's earlier run no longer its writer", !!(await until(async () => (await slotList()).find((s) => s.name === 'hb1')?.writer === null, HUNG_MS)), JSON.stringify((await slotList()).find((s) => s.name === 'hb1')))
    await inv('session:start', alpha, { agentId: b1.id, resumeId: conv3 })
    const resumed = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check('…and resumes in hb1, its files as they were', resumed?.sessionId === conv3 && same(resumed?.cwd, hb1) && fs.existsSync(path.join(hb1, 'unfinished.txt')), JSON.stringify(resumed))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h?.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
