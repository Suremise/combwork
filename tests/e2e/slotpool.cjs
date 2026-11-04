// The slot pool in the app (#1429, SPEC §16.10.1–16.10.2): a test Hive's main process lends a Git project's slots
// (through the test copies' `slots:test` channel, as #1438's card start will), with a setup command:
// - two builders, two slots: slot-a and slot-b, each a worktree of the project's, their setup runs shown in the
//   Progress panel as "Combwork (slot slot-a)" / "Combwork (slot slot-b)" (slot-a's while it runs, screenshot);
// - slot-a released with an untracked file is dirty and isn't lent again: the next lend gets slot-b;
// - with one builder left and a day gone by, the idle removal removes only the clean slot (slot-b), never the dirty one.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR (no agent is started).
// Dev build only (#1578): its slots are lent and released through slots:test, which a packaged build refuses.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47856))
const fx = q.queueProject('slotpool')
const HUNG_MS = 60000
const DAY_MS = 24 * 60 * 60 * 1000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

;(async () => {
  q.prepare(fx)
  // warm/ is where the setup writes (git-ignored, so a slot it ran in stays clean).
  fs.writeFileSync(path.join(fx.alpha, '.gitignore'), '.combwork/\nwarm/\n')
  lib.git(fx.alpha, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'ignore warm'])
  const go = path.join(fx.tools, 'slot-go.txt')
  const setup = path.join(fx.tools, 'setup.js')
  // The setup: writes the slot's name and port block, then waits for the test's go-ahead (bounded against a hang).
  fs.writeFileSync(setup, ["const fs = require('fs')", "fs.mkdirSync('warm', { recursive: true })", "fs.writeFileSync('warm/env.txt', process.env.CW_SLOT + ' ' + process.env.CW_SLOT_PORT_BASE)", `const go = ${JSON.stringify(go)}, t = Date.now()`, 'const tick = () => (fs.existsSync(go) ? process.exit(0) : Date.now() - t > 120000 ? process.exit(3) : setTimeout(tick, 100))', 'tick()', ''].join('\n'))
  const h = await q.startHive(fx, { port: PORT, keepOptions: true })
  try {
    const { page, inv } = h
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1400, height: 850 })
    await inv('project:updateConfig', fx.alpha, { slots: { setup: `node "${setup}"` } })
    const b1 = await lib.addAgent(inv, fx.alpha, { name: 'B1' })
    const b2 = await lib.addAgent(inv, fx.alpha, { name: 'B2' })
    const slots = () => inv('slots:list', fx.alpha)
    const slot = async (name) => (await slots()).find((s) => s.name === name)
    const op = (o) => inv('slots:test', fx.alpha, o)

    // --- slot-a: lent to B1 for card 101, its setup a run of Hive's while it runs.
    const panel = page.locator('.progress-panel')
    await page.locator('.progress-rail').click()
    check('the Progress panel opens', !!(await until(async () => (await panel.count()) === 1, HUNG_MS)))
    const lendA = op({ op: 'lend', agent: b1.id, card: 101 })
    const runOf = async (name) => (await inv('progress:snapshot')).runs.find((r) => r.source === 'hive' && r.slot === name)
    const runA = await until(() => runOf('slot-a'), HUNG_MS)
    check("slot-a's setup is a run of Hive's, attributed to the slot", runA?.agentName === 'Combwork (slot slot-a)' && runA.defaultName === 'slot' && runA.state === 'running', JSON.stringify(runA))
    await panel.locator('.progress-tab[data-tab="runs"]').click()
    const rowA = panel.locator(`.progress-tab-runs [data-run="${runA?.id}"]`)
    check('…shown in Runs as "Combwork (slot slot-a)"', !!(await until(async () => (await rowA.count()) === 1 && (await rowA.innerText()).includes('Combwork (slot slot-a)'), HUNG_MS)), await panel.innerText().catch(() => ''))
    await page.mouse.move(5, 5)
    await panel.screenshot({ path: path.join(fx.shots, 'slotpool-1-warming.png') })
    fs.writeFileSync(go, 'go')
    const a = await lendA
    check('B1 is lent slot-a', a.ok && a.slot.name === 'slot-a' && a.lease.agent === b1.id && a.lease.card === 101, JSON.stringify(a))
    const folderA = a.slot?.folder
    check("…a worktree of the project's, set up with its name and ports", !!folderA && fs.readFileSync(path.join(folderA, 'warm', 'env.txt'), 'utf8') === 'slot-a 41000' && lib.git(fx.alpha, ['worktree', 'list']).toLowerCase().includes(path.basename(folderA)))
    check('…its run ended passed', (await until(async () => (await runOf('slot-a'))?.state === 'passed', HUNG_MS)) === true)

    // --- slot-b: lent to B2.
    const b = await op({ op: 'lend', agent: b2.id, card: 102 })
    check('B2 is lent slot-b', b.ok && b.slot.name === 'slot-b', JSON.stringify(b))
    // Ended at once (its go-ahead is there already): under Recent, by its slot's name.
    // In its card's runs (HI-1701), opened: closed once they all passed.
    const openRuns = async () => {
      for (const t of await panel.locator('.progress-tab-runs .progress-card-toggle[aria-expanded="false"]').all()) await t.click().catch(() => undefined)
    }
    check('…its setup shown as "Combwork (slot slot-b)"', !!(await until(async () => {
      await openRuns()
      return (await runOf('slot-b'))?.state === 'passed' && (await panel.locator('.progress-tab-runs').innerText()).includes('Combwork (slot slot-b)')
    }, HUNG_MS)), await panel.innerText().catch(() => ''))
    await panel.screenshot({ path: path.join(fx.shots, 'slotpool-2-two-slots.png') })
    check('a third card has no slot: the pool is two', (await op({ op: 'lend', agent: 'someone', card: 103 })).refusal?.why === 'noSlot')

    // --- slot-a released dirty: not lent again; slot-b released clean, and lent next.
    fs.writeFileSync(path.join(folderA, 'left.txt'), 'untracked\n')
    check('slot-a released', (await op({ op: 'release', lease: a.lease.id, why: 'done' })) === true)
    check('…left with an untracked file, it is dirty', (await slot('slot-a'))?.state === 'dirty', JSON.stringify(await slot('slot-a')))
    check('slot-b released clean, ready', (await op({ op: 'release', lease: b.lease.id, why: 'done' })) === true && (await slot('slot-b'))?.state === 'ready')
    const next = await op({ op: 'lend', agent: b1.id, card: 104 })
    check("the next lend gets slot-b, not the dirty slot-a", next.ok && next.slot.name === 'slot-b', JSON.stringify(next))
    await op({ op: 'release', lease: next.lease.id, why: 'done' })

    // --- One builder left, a day later: the idle removal takes only the clean slot.
    await inv('agents:remove', fx.alpha, b2.id, { deleteWorktree: false })
    const removed = await op({ op: 'tidy', at: Date.now() + DAY_MS + 60_000 })
    check('the idle removal removes slot-b only', JSON.stringify(removed) === JSON.stringify(['slot-b']), JSON.stringify(removed))
    check("…slot-b's folder is gone, and git doesn't list it", !fs.existsSync(next.slot.folder) && !lib.git(fx.alpha, ['worktree', 'list']).toLowerCase().includes('slot-b'))
    check('…the dirty slot-a stays, with its file', (await slot('slot-a'))?.state === 'dirty' && fs.existsSync(path.join(folderA, 'left.txt')))
    check('the pool lists slot-a only', JSON.stringify((await slots()).map((s) => s.name)) === JSON.stringify(['slot-a']))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
