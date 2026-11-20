// The slot pool in the app (#1429, SPEC §16.10.1–16.10.2): a test Combwork's main process lends a Git project's slots
// (through the test copies' `slots:test` channel, as #1438's card start will), with a setup command:
// - two builders, two slots: slot-a and slot-b, each a worktree of the project's, their setup runs shown in the
//   Progress panel as "Combwork (slot slot-a)" / "Combwork (slot slot-b)" (slot-a's while it runs, screenshot);
// - slot-a released with an untracked file is dirty and isn't lent again: the next lend gets slot-b;
// - with one builder left and a day gone by, the idle removal removes only the clean slot (slot-b), never the dirty one.
// - HI-3464: with one builder, slot-a's folder deleted and a folder with a file made in its place: the next lend gets a
//   new slot, slot-a stays gone with Remove… in Slots and copies, which forgets it and leaves the folder as it is.
// - HI-3465: that slot released with a revert left under way (nothing uncommitted, git's sequencer left): told once,
//   shown in Slots and copies with `git revert --abort`, not lent; ended there, it is lent again.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR (no agent is started).
// Dev build only (#1578): its slots are lent and released through slots:test, which a packaged build refuses.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47856))
const fx = q.queueProject('slotpool')
const HUNG_MS = lib.timing('hang.step')
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
  const h = await q.startCombwork(fx, { port: PORT, keepOptions: true })
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

    // --- slot-a: lent to B1 for card 101, its setup a run of Combwork's while it runs.
    const panel = page.locator('.progress-panel')
    await page.locator('.progress-rail').click()
    check('the Progress panel opens', !!(await until(async () => (await panel.count()) === 1, HUNG_MS)))
    const lendA = op({ op: 'lend', agent: b1.id, card: 101 })
    const runOf = async (name) => (await inv('progress:snapshot')).runs.find((r) => r.source === 'combwork' && r.slot === name)
    const runA = await until(() => runOf('slot-a'), HUNG_MS)
    check("slot-a's setup is a run of Combwork's, attributed to the slot", runA?.agentName === 'Combwork (slot slot-a)' && runA.defaultName === 'slot' && runA.state === 'running', JSON.stringify(runA))
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

    // --- HI-3464: a pool of one whose free slot's folder was deleted, a folder with the user's file made in its place.
    fs.rmSync(folderA, { recursive: true, force: true })
    fs.mkdirSync(folderA)
    fs.writeFileSync(path.join(folderA, 'mine.txt'), 'mine\n')
    const after = await op({ op: 'lend', agent: b1.id, card: 105 })
    check("the next start isn't blocked: a new slot is lent in slot-a's stead", after.ok && after.slot.name !== 'slot-a', JSON.stringify(after))
    check("…slot-a stays, gone, offering Remove…; the folder in its place untouched", !!(await until(async () => (await slot('slot-a'))?.goneFree === true, HUNG_MS)) && fs.readFileSync(path.join(folderA, 'mine.txt'), 'utf8') === 'mine\n', JSON.stringify(await slot('slot-a')))
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('.git-sections [data-section="workflow"]').click()
    const form = page.locator('.workflow-form')
    await form.waitFor({ timeout: HUNG_MS })
    await form.locator('.workflow-option[data-option="folder"] select').selectOption('slots')
    const goneRow = form.locator('.workflow-slots-table tr[data-slot="slot-a"]')
    check("Slots and copies shows slot-a's Remove…", !!(await until(async () => (await goneRow.locator('[data-action="remove-gone"]').count()) === 1, HUNG_MS)), await goneRow.innerText().catch(() => ''))
    await goneRow.locator('[data-action="remove-gone"]').click()
    const ask = page.locator('.dialog', { hasText: 'Remove slot-a?' })
    await ask.waitFor({ timeout: HUNG_MS })
    check('…its question says nothing is deleted', (await ask.innerText()).includes('Nothing is deleted'), await ask.innerText())
    await ask.screenshot({ path: path.join(fx.shots, 'slotpool-3-remove-gone.png') })
    await ask.getByRole('button', { name: 'Remove', exact: true }).click()
    check('…removed: the list no longer has it, and the folder and its file are still there', !!(await until(async () => (await goneRow.count()) === 0 && !(await slot('slot-a')), HUNG_MS)) && fs.readFileSync(path.join(folderA, 'mine.txt'), 'utf8') === 'mine\n')

    // --- HI-3465: B1's card ends with a revert of two commits left under way in its slot (the first's conflict committed
    // by hand: nothing uncommitted, git's sequencer left), as reported: never detached, told once, shown, freed by --abort.
    const folderB = after.slot.folder
    const g = (args, ok = true) => {
      try {
        return lib.git(folderB, ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
      } catch (e) {
        if (ok) throw e
        return null
      }
    }
    for (const [i, text] of [[1, 'one'], [2, 'two']]) {
      fs.writeFileSync(path.join(folderB, 'r.txt'), `${text}\n`)
      g(['add', 'r.txt'])
      g(['commit', '-qm', `c${i}`])
    }
    fs.writeFileSync(path.join(folderB, 's.txt'), 's\n')
    g(['add', 's.txt'])
    g(['commit', '-qm', 'c3'])
    g(['revert', '--no-edit', 'HEAD~2', 'HEAD'], false)
    g(['rm', '-q', 'r.txt'])
    g(['commit', '-q', '--no-edit'])
    check('the slot is left mid-revert with nothing uncommitted', g(['status', '--porcelain']).trim() === '' && fs.existsSync(path.join(g(['rev-parse', '--absolute-git-dir']).trim(), 'sequencer')))
    check('B1 releases slot-b', (await op({ op: 'release', lease: after.lease.id, why: 'done' })) === true)
    check('…its unfinished revert recorded, the slot not ready', !!(await until(async () => (await slot('slot-b'))?.operation?.what === 'revert', HUNG_MS)) && (await slot('slot-b'))?.state === 'dirty', JSON.stringify(await slot('slot-b')))
    const told = page.locator('.toast', { hasText: 'slot-b has an unfinished git revert' })
    check('…the user is told, naming the way out', !!(await until(async () => (await told.count()) === 1, HUNG_MS)) && (await told.innerText()).includes('git revert --abort'), await told.innerText().catch(() => ''))
    check('…and it is not lent: the pool of one has no slot', (await op({ op: 'lend', agent: b1.id, card: 106 })).refusal?.why === 'noSlot')
    await page.locator('.git-sections [data-section="changes"]').click().catch(() => {})
    await page.locator('.git-sections [data-section="workflow"]').click()
    await form.waitFor({ timeout: HUNG_MS })
    await form.locator('.workflow-option[data-option="folder"] select').selectOption('slots')
    const opRow = form.locator('.workflow-slots-table tr[data-slot="slot-b"]')
    check('Slots and copies shows slot-b as an unfinished git revert, with the command that ends it', !!(await until(async () => (await opRow.locator('[data-operation="revert"]').count()) === 1, HUNG_MS)) && /Unfinished git revert/.test(await opRow.innerText()) && (await opRow.innerText()).includes('git revert --abort'), await opRow.innerText().catch(() => ''))
    await opRow.screenshot({ path: path.join(fx.shots, 'slotpool-4-operation.png') })
    g(['revert', '--abort'])
    const freed = await op({ op: 'lend', agent: b1.id, card: 106 })
    check('ended in its folder, slot-b is lent again', freed.ok && freed.slot.name === 'slot-b' && !(await slot('slot-b'))?.operation, JSON.stringify(freed))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
