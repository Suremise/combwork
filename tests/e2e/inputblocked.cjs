// An input that takes no keys (HI-2191), through a real lane and slot, on fake Claude Code agents (fake-claude/) with
// Claude Code's input box: B1, the lane's builder in slot-a, ends a turn with a dialog of its CLI's own Combwork doesn't know
// ("swallow"), drawn under its empty input box as Claude Code 2.1.314 draws its offer to teach auto mode, which takes
// the keys. Card 1 moved to Done by the user, its card event is typed into B1: its letter goes unanswered three times,
// so the agent waits for the user with why, once (the Assistant's lane watch wakes once), and nothing is given to it
// meanwhile: card 2 isn't placed, no delivery is made and called off, no key pressed in its pane. Try again while the
// dialog shows types one letter and says it still takes no keys; the user's Esc in its pane, which leaves the box empty
// and sends no hook, frees nothing by itself; Try again then sees the box take its key: what waited is typed, and the
// lane's slot places card 2 with B1 once, never made and called off while B1 is busy with that (HB3's re-give every
// second, HI-2191). Then (HI-3411) the same dialog drawn in its input box's place: card 2's event and card 3's hand-off
// are refused until Advanced's Input box hidden: wait passes, then B1 waits for the user (the lane watch told once more),
// and the user's Esc, which draws its box again, frees it by itself. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.step')

const at = (x) => path.join(lib.WORK, `inputblocked-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const alpha = path.join(ws, 'alpha')
const slotA = path.join(`${ws}.worktrees`, 'alpha', 'slot-a')
const PORT = Number(lib.port(47707))
const identity = { name: 'Combwork Slot Test', email: 'slots@example.com' }
const SWALLOW = 'Choose how long replies are kept?'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'a.txt': 'a\n', '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.git(alpha, ['branch', 'integration'])
  const env = lib.fakeClaude(userData, home, [alpha, ws, slotA])
  // Claude Code's input box (a rule, its prompt mark, a rule), which Combwork reads its input from.
  fs.writeFileSync(path.join(home, 'fake-input-box.txt'), '')
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  // The suite types into B1's pane as the user would: those aren't replies for the Assistant (lanewatch's reason).
  cfg.settings.assistant = { ...cfg.settings.assistant, tellReplies: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, CW_API_PORT: String(PORT), CW_TEST_TIPS: 'off' } })
  const { app, page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 250)
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'combworkMerges', folder: 'slots', target: 'integration', style: 'merge', preChecks: [], mergeChecks: [], identity, okBefore: { mode: 'never', labels: [] } } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    await lib.setMaxAgents(inv, 1)
    const liveIn = async (p, id) => (await inv('session:live')).find((s) => same(s.projectPath, p) && s.agentId === id) ?? null
    const live = (id) => liveIn(alpha, id)
    const idle = async (p, id) => ['ready', 'finished'].includes((await liveIn(p, id))?.status)
    const launches = () => {
      const f = path.join(home, 'fake-launches.jsonl')
      const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    }
    const tokenOf = async (id) => {
      const sessionId = await until(async () => (await live(id))?.sessionId, HUNG_MS)
      const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const server = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
      return server ? JSON.parse(fs.readFileSync(server.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    }
    const intent = async (token, n, name, body = {}) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${encodeURIComponent(`#${n}`)}/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const jsonl = (name) => {
      const f = path.join(home, name)
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    }
    /** What B1's CLI read (fake-input.jsonl), from `from` on. */
    const b1Reads = (from = '') => jsonl('fake-input.jsonl').filter((r) => r.agent === 'B1' && r.at >= from)
    /** The letters Combwork typed into B1's input to see it empty (CLEAR_PROBE). */
    /**
     * The letters Combwork typed into B1's input to see it empty (CLEAR_PROBE), as keys: one read can carry several (a
     * Backspace and the next letter), so its keys are counted, not its reads. Combwork's own lines are bracketed pastes (an
     * "x" in "inbox"), left out.
     */
    const probes = (from) => [...b1Reads(from).filter((r) => !r.data.includes('\x1b[200~')).map((r) => r.data).join('')].filter((k) => k === 'x').length
    const combworkLog = () => {
      const f = path.join(userData, 'logs', 'combwork.log')
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
    }
    let tb1 = null
    const placements = (n) => (combworkLog().match(new RegExp(`Giving ⁨?B1⁩? #${n} in`, 'g')) ?? []).length
    /** B1's deliveries called off (cancelled) so far. */
    const cancelled = async () => {
      const r = await fetch(`http://127.0.0.1:${PORT}/v1/projects/alpha/agents/B1/deliveries?limit=200`, { headers: { Authorization: `Bearer ${tb1}` } })
      return ((await r.json().catch(() => null))?.deliveries ?? []).filter((d) => d.state === 'cancelled').length
    }

    // The Assistant, watching every lane (lanewatch.cjs): its wakes are what a lane watch is told.
    const aHome = (await inv('workspace:refresh')).assistant.path
    fs.writeFileSync(path.join(home, 'fake-trusted.json'), JSON.stringify([alpha, ws, slotA, aHome].map((f) => f.toLowerCase())))
    await inv('session:start', aHome, { agentId: 'assistant' })
    await until(async () => ['ready', 'finished', 'waiting'].includes((await liveIn(aHome, 'assistant'))?.status), HUNG_MS)
    if ((await liveIn(aHome, 'assistant'))?.status === 'waiting') await inv('pty:write', lib.ptyKey(aHome, 'assistant'), '\r')
    check('the Assistant starts', !!(await until(() => idle(aHome, 'assistant'), HUNG_MS)))
    const assistantWakes = () => jsonl('fake-wakes.jsonl').filter((w) => !['B1', 'R1'].includes(w.agent)).map((w) => lib.unkey(w.text))

    const c1 = (await inv('tasks:create', { title: 'Done by hand', project: 'alpha' })).number
    const c2 = (await inv('tasks:create', { title: 'Blocked input', project: 'alpha' })).number
    const c2Key = (await inv('tasks:list')).find((c) => c.number === c2).key
    const c3 = (await inv('tasks:create', { title: 'Box hidden', project: 'alpha' })).number
    const c3Key = (await inv('tasks:list')).find((c) => c.number === c3).key
    // Input box hidden: wait (HI-3411), its least, so the second part needn't wait two minutes.
    await inv('advanced:set', 'cw.input.hiddenSeconds', 10)
    const started = await inv('lanes:start', alpha, { builder: b1.id, reviewer: r1.id, cards: [c1, c2, c3] })
    check('the lane is lent slot-a, and its agents start', started.slot === 'slot-a' && started.started.every((s) => s.how !== 'failed'), JSON.stringify(started))
    check('B1 runs in slot-a', !!(await until(async () => same((await live(b1.id))?.cwd, slotA) && (await idle(alpha, b1.id)), HUNG_MS)), JSON.stringify(await live(b1.id)))
    tb1 = await tokenOf(b1.id)
    const s1 = await intent(tb1, c1, 'start')
    check("card 1's start: built in slot-a", s1.status === 200 && same(s1.body?.data?.folder, slotA), JSON.stringify(s1.body))
    await until(() => idle(alpha, b1.id), HUNG_MS)
    await until(() => idle(aHome, 'assistant'), HUNG_MS)
    await lib.typeLine(inv, lib.ptyKey(aHome, 'assistant'), home, null, 'cw cw_wait_for_tasks {"lanes":["all"],"wake":true,"limitMinutes":360}', { live: () => liveIn(aHome, 'assistant') })
    check('the Assistant watches the lanes', !!(await until(async () => (await liveIn(aHome, 'assistant'))?.status === 'watching', HUNG_MS)))

    // ---- B1's turn ends on a dialog of its CLI's own, under its empty input box: it takes the keys.
    const b1Key = lib.ptyKey(alpha, b1.id)
    // Typed only once Combwork has nothing to type into B1 now or next: a delivery typed meanwhile would mix with it. From
    // then on, every letter Combwork types into B1 is a try at its input (a line Combwork typed after its turn may already be
    // the first to find it blocked).
    const before = new Date().toISOString()
    const wakesBefore = assistantWakes().length
    await lib.typeLine(inv, b1Key, home, 'B1', 'swallow', { ready: async () => lib.agentQuiet(PORT, 'alpha', await live(b1.id), tb1), strict: true, live: () => live(b1.id), hungMs: HUNG_MS })
    check('B1 ends its turn with the dialog under its input box', !!(await until(async () => ['ready', 'finished', 'waiting'].includes((await live(b1.id))?.status) && (await inv('pty:buffer', b1Key)).includes(SWALLOW), HUNG_MS)))
    // Card 1 moved to Done by the user: its card event is typed into B1 first, and the lane starts card 2 for it once it
    // is quiet.
    await inv('tasks:move', c1, 'done', { confirm: true, reason: 'Done by hand' })
    check('card 1 is Done by the user', (await inv('tasks:list')).find((c) => c.number === c1)?.column === 'done')

    // Its letter unanswered three times: B1 waits for the user with why.
    const blocked = await until(async () => {
      const s = await live(b1.id)
      return s?.status === 'waiting' && s.inputBlocked && s
    }, HUNG_MS)
    check('B1 waits for the user: something on its screen takes its keys', !!blocked && /taking its keys/.test(String(blocked.statusMessage)), JSON.stringify(blocked && { status: blocked.status, message: blocked.statusMessage }))
    // The fake reads its input late on a busy machine: its log of a key may come after Combwork gave up waiting for it.
    check('…after three letters typed and not answered', !!(await until(() => probes(before) >= 3, lib.timing('hang.ui'))) && probes(before) === 3, `${probes(before)}: ${JSON.stringify(b1Reads(before))}`)
    const header = lib.paneHeader(page, 'B1')
    check('…its pane says so, with Try again', !!(await until(async () => (await header.locator('.pane-status.input-blocked').count()) >= 1, HUNG_MS)) && (await header.locator('.pane-status.input-blocked button', { hasText: 'Try again' }).count()) === 1)
    const waitLine = () => assistantWakes().slice(wakesBefore).filter((t) => t.startsWith('[CW] B1 (alpha) is waiting for the user'))
    check("the Assistant's lane watch is woken: B1 waits for the user", !!(await until(() => waitLine().length > 0, HUNG_MS)), JSON.stringify(assistantWakes().slice(wakesBefore)))
    // What had been tried when it was blocked: whichever came first (card 1's event, or the lane's placement of card 2)
    // is the delivery that found it blocked.
    const cancelledAt = await cancelled()
    const placedAt = placements(c2)
    await page.screenshot({ path: at('blocked.png') })

    // In a narrow pane (its header under 300 px) the button goes, and Try again is in its ⋯ menu.
    await header.evaluate((el) => (el.style.width = '280px'))
    check('in a narrow pane there is no button beside its status', !!(await until(async () => (await header.locator('.pane-status.input-blocked button').count()) === 0, HUNG_MS)))
    const items = await lib.agentMenu(page, 'B1')
    check("…and its ⋯ menu has Try again", items.includes('Try again'), JSON.stringify(items))

    // While it is blocked: Try again (from that menu), the dialog still showing, types one letter, and says it still
    // takes no keys.
    const tryAt = new Date().toISOString()
    await lib.menuEntry(page, 'Try again').click()
    check('Try again with the dialog still showing: it still takes no keys', !!(await until(() => page.getByText('Its input still takes no keys').first().isVisible().catch(() => false), HUNG_MS)))
    check('…one letter typed for it, nothing more', !!(await until(() => probes(tryAt) >= 1, lib.timing('hang.ui'))) && probes(tryAt) === 1, JSON.stringify(b1Reads(tryAt)))
    await header.evaluate((el) => (el.style.width = ''))
    check('its pane wide again, the button is back', !!(await until(async () => (await header.locator('.pane-status.input-blocked button', { hasText: 'Try again' }).count()) === 1, HUNG_MS)))
    check('…B1 still waits for the user', (await live(b1.id))?.status === 'waiting' && !!(await live(b1.id))?.inputBlocked)
    // Nothing given meanwhile: card 2 isn't placed again, and no delivery is made and called off.
    check('while it is blocked, card 2 is not placed and no delivery is made and called off', placedAt <= 1 && placements(c2) === placedAt && (await cancelled()) === cancelledAt, JSON.stringify({ placements: [placedAt, placements(c2)], cancelled: [cancelledAt, await cancelled()] }))

    // The user's Esc puts the dialog off: its box is empty again, and no hook comes. Nothing frees it by itself.
    const escAt = new Date().toISOString()
    await inv('pty:write', b1Key, '\x1b')
    check('the dialog is put off in its pane', !!(await until(() => jsonl('fake-envsetup.jsonl').some((r) => r.agent === 'B1' && r.answer === 'later'), HUNG_MS)))
    check('…B1 is still blocked (its box empty, as when it was blocked, and no hook)', (await live(b1.id))?.status === 'waiting' && !!(await live(b1.id))?.inputBlocked, JSON.stringify(await live(b1.id)))
    check('…and nothing was typed into it since', b1Reads(escAt).every((r) => r.data === '\x1b'), JSON.stringify(b1Reads(escAt)))

    // Try again: its box takes the letter. B1 is free: what waited is typed, then card 2 is placed, once.
    const freeAt = new Date().toISOString()
    await header.locator('.pane-status.input-blocked button', { hasText: 'Try again' }).click()
    check('Try again after the user answered: B1 takes keys again', !!(await until(async () => !(await live(b1.id))?.inputBlocked, HUNG_MS)), JSON.stringify(await live(b1.id)))
    const given = () => b1Reads(freeAt).filter((r) => /\[CW\] New in your inbox/.test(r.data))
    check('…what waited is typed into it', !!(await until(() => given().length >= 1, HUNG_MS)), JSON.stringify(b1Reads(freeAt).map((r) => r.data.slice(0, 60))))
    check('…then the lane places card 2 with it, once', !!(await until(() => placements(c2) >= 1, HUNG_MS)) && !!(await until(() => b1Reads(freeAt).some((r) => r.data.includes(`(${c2Key})`)), HUNG_MS)) && placements(c2) === placedAt + 1, JSON.stringify({ placedAt, placements: placements(c2), reads: b1Reads(freeAt).map((r) => r.data.slice(0, 60)) }))
    check('no delivery was called off after it was blocked', (await cancelled()) === cancelledAt, JSON.stringify([cancelledAt, await cancelled()]))
    check("the lane watch was told once that B1 waits for the user", waitLine().length === 1, JSON.stringify(waitLine()))
    check('Combwork never answered the dialog', JSON.stringify(jsonl('fake-envsetup.jsonl').filter((r) => r.agent === 'B1').map((r) => r.answer)) === '["later"]', JSON.stringify(jsonl('fake-envsetup.jsonl')))
    check('the log says when it was blocked and freed', /took no key in 3 clears in a row/.test(combworkLog()) && /its input takes keys again \(Try again: its input took the key\)/.test(combworkLog()))

    // ---- HI-3411: B1's turn ends on that dialog drawn in its input box's place (the box off the screen). Card 2 moved to
    // Done by the user: its event, and the lane's hand-off of card 3, are refused for that until Advanced's Input box
    // hidden: wait (10 s here) has passed; then B1 waits for the user, the lane watch told once more, and nothing is typed
    // or handed off. The user's Esc draws its box again, which frees it by itself: what waited is typed, card 3 placed once.
    await until(async () => (await idle(alpha, b1.id)) && b1Reads(freeAt).some((r) => r.data.includes(`(${c2Key})`)), HUNG_MS)
    // Its lane watch ended with its wake: the Assistant watches the lanes again, as its wake tells it to.
    await until(() => idle(aHome, 'assistant'), HUNG_MS)
    await lib.typeLine(inv, lib.ptyKey(aHome, 'assistant'), home, null, 'cw cw_wait_for_tasks {"lanes":["all"],"wake":true,"limitMinutes":360}', { live: () => liveIn(aHome, 'assistant') })
    check('the Assistant watches the lanes again', !!(await until(async () => (await liveIn(aHome, 'assistant'))?.status === 'watching', HUNG_MS)))
    await lib.typeLine(inv, b1Key, home, 'B1', 'swallowhide', { ready: async () => lib.agentQuiet(PORT, 'alpha', await live(b1.id), tb1), strict: true, live: () => live(b1.id), hungMs: HUNG_MS })
    check("B1 ends its turn with the dialog in its input box's place", !!(await until(async () => (await idle(alpha, b1.id)) && (await inv('pty:buffer', b1Key)).slice(-800).includes(SWALLOW), HUNG_MS)))
    const placed3 = placements(c3)
    await inv('tasks:move', c2, 'done', { confirm: true, reason: 'Done by hand' })
    const hidden = await until(async () => {
      const s = await live(b1.id)
      return s?.status === 'waiting' && s.inputBlocked && s
    }, HUNG_MS)
    const blockedAt = new Date().toISOString()
    check('past the wait, B1 waits for the user: something on its screen takes its keys', !!hidden && /taking its keys/.test(String(hidden.statusMessage)), JSON.stringify(hidden && { status: hidden.status, message: hidden.statusMessage }))
    check("…the log says its box was off the screen, naming its screen's last rows", /its input box hasn't been on the screen for \d+ s \(its screen's last rows: "[^"]*Don't show again \| Enter to select/.test(combworkLog()))
    check("the Assistant's lane watch is told once more", !!(await until(() => waitLine().length >= 2, HUNG_MS)) && waitLine().length === 2, JSON.stringify(waitLine()))
    const cancelledHidden = await cancelled()
    // Hand-offs tried before the block (each refused, the report's loop) are bounded by the wait; none since.
    const placedBlocked = placements(c3)
    const escHidden = new Date().toISOString()
    await inv('pty:write', b1Key, '\x1b')
    check('the user puts the dialog off: B1 takes keys again by itself, its box drawn again', !!(await until(async () => !(await live(b1.id))?.inputBlocked, HUNG_MS)), JSON.stringify(await live(b1.id)))
    check('…nothing was typed into it while it was blocked', b1Reads(blockedAt).filter((r) => r.at < escHidden).length === 0, JSON.stringify(b1Reads(blockedAt)))
    check('…what waited is typed into it', !!(await until(() => b1Reads(escHidden).some((r) => /\[CW\] New in your inbox/.test(r.data)), HUNG_MS)), JSON.stringify(b1Reads(escHidden).map((r) => r.data.slice(0, 60))))
    check('…and the lane places card 3 with it, once', !!(await until(() => b1Reads(escHidden).some((r) => r.data.includes(`(${c3Key})`)), HUNG_MS)) && placements(c3) === placedBlocked + 1 && b1Reads(escHidden).filter((r) => r.data.includes(`(${c3Key})`)).length === 1, JSON.stringify({ placed3, placedBlocked, placements: placements(c3), reads: b1Reads(escHidden).map((r) => r.data.slice(0, 60)) }))
    check('no delivery was called off while it was blocked', (await cancelled()) === cancelledHidden, JSON.stringify([cancelledHidden, await cancelled()]))
    check('the log says its box is back', /its input takes keys again \(its input box is on the screen again\)/.test(combworkLog()))
  } catch (e) {
    check('the suite ran to the end', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})()
