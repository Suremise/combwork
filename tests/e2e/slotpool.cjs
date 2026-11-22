// The slot pool in the app (#1429, SPEC §16.10.1–16.10.2): a test Combwork's main process lends a Git project's slots
// (through the test copies' `slots:test` channel, as #1438's card start will), with a setup command:
// - two builders, two slots: slot-a and slot-b, each a worktree of the project's, their setup runs shown in the
//   Progress panel as "Combwork (slot slot-a)" / "Combwork (slot slot-b)" (slot-a's while it runs, screenshot);
// - slot-a released with an untracked file is dirty and isn't lent again: the next lend gets slot-b;
// - with one builder left and a day gone by, the idle removal removes only the clean slot (slot-b), never the dirty one.
// - HI-3464: with one builder, slot-a's folder deleted and a folder with a file made in its place: the next lend gets a
//   new slot, slot-a stays gone with Remove… in Slots and copies, which forgets it and leaves the folder as it is.
// - HI-3465: that slot released with a revert left under way (nothing uncommitted, git's sequencer left): told once,
//   shown in Slots and copies with `git revert --abort`, not lent; HI-3470: Open in Changes shows its panel, whose
//   Abort (confirmed) ends it, and it is lent again.
// - HI-3467: then released on its card's line with a stale index.lock: git refuses each detach; told once with git's
//   error and `git switch --detach`, shown in Slots and copies, not lent; the lock gone, it is lent again.
// - HI-3470: a merge left in conflict in the project folder (two files): Branches & remotes' banner opens Changes,
//   whose panel lists both with their buttons (Continue waiting); Use theirs settles one; Abort, confirmed, ends it.
// - HI-3502: a submodule at `third party/lib` merged into conflict: Use theirs stages their commit, its folder left at
//   mine, and the notice gives `git submodule update -- 'third party/lib'`.
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
/** HI-3470 (HR1's round 2): every notification dismissed by its own close button, so a screenshot shows what is under it. */
const clearPopups = async (page) => !!(await until(async () => {
  const close = page.locator('.popup-close')
  if ((await close.count()) === 0) return true
  await close.first().click().catch(() => undefined)
  return false
}, HUNG_MS))

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
    // HI-3470: ended from the window: Open in Changes shows slot-b with the panel, whose Abort (confirmed) runs git's.
    await opRow.locator('[data-action="open-operation"]').click()
    const opPanel = page.locator('.operation-panel[data-operation="revert"]')
    check("HI-3470: Open in Changes shows slot-b's panel, its unfinished revert with Continue, Skip and Abort", !!(await until(async () => (await opPanel.count()) === 1, HUNG_MS)) && /Unfinished git revert in slot-b/.test(await opPanel.innerText()) && (await opPanel.locator('[data-step]').count()) === 3, await opPanel.innerText().catch(() => ''))
    check('…its notifications dismissed for the screenshot', await clearPopups(page))
    await opPanel.screenshot({ path: path.join(fx.shots, 'slotpool-4b-operation-panel.png') })
    await opPanel.locator('[data-step="abort"]').click()
    const abortAsk = page.locator('.dialog', { hasText: 'Abort the git revert in slot-b?' })
    await abortAsk.waitFor({ timeout: HUNG_MS })
    await abortAsk.getByRole('button', { name: 'Abort', exact: true }).click()
    const gitDirB = g(['rev-parse', '--absolute-git-dir']).trim()
    check('…Abort ends it: the sequencer gone, the panel gone', !!(await until(async () => !fs.existsSync(path.join(gitDirB, 'sequencer')) && (await opPanel.count()) === 0, HUNG_MS)), await page.locator('.toast').allInnerTexts().then((t) => t.join(' | ')).catch(() => ''))
    // A lend refused `busy` while a process is still in the folder (git's own background maintenance after the abort, a
    // process listing not yet caught up): asked again until it isn't, bounded; any other answer is the check's.
    const lendQuiet = async (card) => {
      let last
      await until(async () => (last = await op({ op: 'lend', agent: b1.id, card })).ok || last.refusal?.why !== 'busy', HUNG_MS)
      return last
    }
    const freed = await lendQuiet(106)
    check('ended in its folder, slot-b is lent again', freed.ok && freed.slot.name === 'slot-b' && !(await slot('slot-b'))?.operation, JSON.stringify(freed))

    // --- HI-3467: released on its card's line with a stale index.lock (a git that crashed): git refuses each detach. The
    // first failure is only recorded; the second (the next lend's look) is told once, and shown; the lock gone, it is lent.
    g(['switch', '-q', '-c', 'cw/card-106'])
    const lock = path.join(g(['rev-parse', '--absolute-git-dir']).trim(), 'index.lock')
    fs.writeFileSync(lock, '')
    check('B1 releases slot-b with a stale index.lock', (await op({ op: 'release', lease: freed.lease.id, why: 'done' })) === true)
    // The release's own settle is its first look; the lend's (or the app's own pass after the release) the second. That
    // the first alone is never told is the unit test's (tests/slots.test.ts, HI-3467): here the order isn't the test's.
    const toldDetach = page.locator('.toast', { hasText: 'back to' })
    check('…not ready, so not lent', (await op({ op: 'lend', agent: b1.id, card: 107 })).refusal?.why === 'noSlot', JSON.stringify(await slot('slot-b')))
    check('…failing again, the user is told with git’s error and the way out', !!(await until(async () => (await toldDetach.count()) === 1, HUNG_MS)) && /index\.lock/.test(await toldDetach.innerText()) && (await toldDetach.innerText()).includes('git switch --detach'), await toldDetach.innerText().catch(() => ''))
    await toldDetach.screenshot({ path: path.join(fx.shots, 'slotpool-5-detach-notice.png') }).catch(() => {})
    // The list is read as the section opens: opened again, as HI-3465's step does.
    await page.locator('.git-sections [data-section="changes"]').click().catch(() => {})
    await page.locator('.git-sections [data-section="workflow"]').click()
    await form.waitFor({ timeout: HUNG_MS })
    await form.locator('.workflow-option[data-option="folder"] select').selectOption('slots')
    const detachRow = form.locator('.workflow-slots-table tr[data-slot="slot-b"]')
    check('Slots and copies shows slot-b can’t be moved back, with git’s error', !!(await until(async () => (await detachRow.locator('[data-operation="detach"]').count()) === 1, HUNG_MS)) && /Can.t be moved back to/.test(await detachRow.innerText()) && /index\.lock/.test(await detachRow.innerText()), await detachRow.innerText().catch(() => ''))
    await detachRow.screenshot({ path: path.join(fx.shots, 'slotpool-5-detach-failed.png') })
    // Told once is the unit test's, by count (a notice with the same id replaces the toast, so the window can't tell).
    check('…looked at again, still not lent', (await op({ op: 'lend', agent: b1.id, card: 107 })).refusal?.why === 'noSlot')
    fs.rmSync(lock)
    const unlocked = await lendQuiet(107)
    check('the lock gone, slot-b is detached at its next look and lent again, nothing shown', unlocked.ok && unlocked.slot.name === 'slot-b' && !(await slot('slot-b'))?.operation, JSON.stringify(unlocked))

    // --- HI-3470 (HR1's round 1): a merge left in conflict in the project folder, two files. Branches & remotes' banner
    // opens Changes with the panel listing both with their buttons; Use theirs settles one; Abort (confirmed) ends it.
    const ga = (args, ok = true) => {
      try {
        return lib.git(fx.alpha, ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
      } catch (e) {
        if (ok) throw e
        return null
      }
    }
    const edit = (text, message) => {
      for (const f of ['c1.txt', 'c2.txt']) fs.writeFileSync(path.join(fx.alpha, f), `${text}\n`)
      ga(['add', 'c1.txt', 'c2.txt'])
      ga(['commit', '-qm', message])
    }
    const mainHead = ga(['rev-parse', 'HEAD']).trim()
    ga(['switch', '-q', '-c', 'hi3470-side'])
    edit('side', 'side edits')
    ga(['switch', '-q', 'main'])
    edit('main', 'main edits')
    ga(['merge', '--no-edit', 'hi3470-side'], false)
    const gitDirA = ga(['rev-parse', '--absolute-git-dir']).trim()
    check('HI-3470: the project folder is mid-merge with two files in conflict', fs.existsSync(path.join(gitDirA, 'MERGE_HEAD')) && ga(['ls-files', '-u']).trim().split('\n').length === 4)
    await page.locator('.git-sections [data-section="branches"]').click()
    const banner = page.locator('.banner[data-git-state="merge"]')
    check("…Branches & remotes' banner says so, with Open in Changes", !!(await until(async () => (await banner.count()) === 1, HUNG_MS)), await banner.innerText().catch(() => ''))
    await banner.locator('[data-action="open-operation"]').click()
    const mergePanel = page.locator('.operation-panel[data-operation="merge"]')
    const conflictRows = mergePanel.locator('[data-conflict]')
    check('…the panel lists both files, each with Open, Use mine, Use theirs and Mark resolved; Continue waits for them', !!(await until(async () => (await conflictRows.count()) === 2, HUNG_MS)) && /Unfinished git merge in the project folder/.test(await mergePanel.innerText()) && (await mergePanel.locator('[data-conflict="c1.txt"] [data-pick]').count()) === 4 && (await mergePanel.locator('[data-step="continue"]').isDisabled()), await mergePanel.innerText().catch(() => ''))
    check('…its notifications dismissed for the screenshot', await clearPopups(page))
    await mergePanel.screenshot({ path: path.join(fx.shots, 'slotpool-6-conflicts.png') })
    await mergePanel.locator('[data-conflict="c1.txt"] [data-pick="theirs"]').click()
    check("…Use theirs settles c1.txt with the side branch's version", !!(await until(async () => (await conflictRows.count()) === 1, HUNG_MS)) && fs.readFileSync(path.join(fx.alpha, 'c1.txt'), 'utf8') === 'side\n', await mergePanel.innerText().catch(() => ''))
    await mergePanel.locator('[data-step="abort"]').click()
    const mergeAsk = page.locator('.dialog', { hasText: 'Abort the git merge in the project folder?' })
    await mergeAsk.waitFor({ timeout: HUNG_MS })
    await mergeAsk.getByRole('button', { name: 'Abort', exact: true }).click()
    check('…Abort ends the merge: the folder back at main, the panel gone', !!(await until(async () => !fs.existsSync(path.join(gitDirA, 'MERGE_HEAD')) && (await mergePanel.count()) === 0, HUNG_MS)) && ga(['rev-parse', 'HEAD']).trim() !== mainHead && ga(['status', '--porcelain']).trim() === '' && fs.readFileSync(path.join(fx.alpha, 'c1.txt'), 'utf8') === 'main\n', ga(['status', '--porcelain']))

    // --- HI-3502 (HR2's round 1): a submodule at a path with a space, moved to diverging commits on main and a branch,
    // merged into conflict. Use theirs stages their commit (the folder keeps mine checked out), and the notice says so
    // with `git submodule update`, its path quoted as one argument.
    const subSrc = path.join(fx.tools, 'hi3502-sub')
    lib.gitProject(subSrc, { 'f.txt': '1\n' })
    const gs = (args) => lib.git(subSrc, ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args]).trim()
    const subStart = gs(['rev-parse', 'HEAD'])
    fs.writeFileSync(path.join(subSrc, 'f.txt'), '2\n')
    gs(['commit', '-qam', 'sub main'])
    const subMain = gs(['rev-parse', 'HEAD'])
    gs(['switch', '-q', '-c', 'other', subStart])
    fs.writeFileSync(path.join(subSrc, 'g.txt'), '3\n')
    gs(['add', 'g.txt'])
    gs(['commit', '-qm', 'sub side'])
    const subSide = gs(['rev-parse', 'HEAD'])
    const libRel = 'third party/lib'
    const libDir = path.join(fx.alpha, 'third party', 'lib')
    ga(['-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', subSrc, libRel])
    const at = (c) => lib.git(libDir, ['checkout', '-q', c])
    at(subStart)
    ga(['add', '-A'])
    ga(['commit', '-qm', 'lib at start'])
    ga(['switch', '-q', '-c', 'hi3502-side'])
    at(subSide)
    ga(['add', '--', libRel])
    ga(['commit', '-qm', 'lib on side'])
    ga(['switch', '-q', 'main'])
    at(subMain)
    ga(['add', '--', libRel])
    ga(['commit', '-qm', 'lib on main'])
    ga(['merge', '--no-edit', 'hi3502-side'], false)
    check('HI-3502: the project folder is mid-merge with its submodule in conflict', fs.existsSync(path.join(gitDirA, 'MERGE_HEAD')) && ga(['ls-files', '-u']).includes('160000'), ga(['ls-files', '-u']))
    check('…its notifications dismissed', await clearPopups(page))
    await page.locator('.git-sections [data-section="branches"]').click()
    await banner.locator('[data-action="open-operation"]').click()
    const libRow = mergePanel.locator(`[data-conflict="${libRel}"]`)
    check('…the panel lists the submodule', !!(await until(async () => (await libRow.count()) === 1, HUNG_MS)), await mergePanel.innerText().catch(() => ''))
    await libRow.locator('[data-pick="theirs"]').click()
    const note = page.locator('.popup', { hasText: 'is a submodule' })
    const wantNote = `${libRel} is a submodule: its commit ${subSide.slice(0, 7)} is staged. Its folder is left as it is: to check that commit out there, run git submodule update -- '${libRel}'`
    // Read while it shows (a notice times out): its text, and a screenshot of it.
    let noteText = ''
    const noted = !!(await until(async () => {
      noteText = await note.first().innerText().catch(() => '')
      if (!noteText.includes(wantNote)) return false
      await note.first().screenshot({ path: path.join(fx.shots, 'slotpool-7-submodule-notice.png') }).catch(() => undefined)
      return true
    }, HUNG_MS))
    check('…Use theirs stages their commit, its folder left at mine; the notice gives the command, its path one quoted argument', noted && ga(['ls-files', '-s', '--', libRel]).split(/\s+/)[1] === subSide && lib.git(libDir, ['rev-parse', 'HEAD']).trim() === subMain, `${noteText} | staged ${ga(['ls-files', '-s', '--', libRel])}`)
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
