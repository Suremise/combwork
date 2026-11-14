// The Merge dialog for merges outside cards, and Branches & remotes on slots (#1450, OP-13; SPEC §16.10.2), on a temp
// Git project whose builders merge their own work into main (queueFixture.cjs's, "the agent merges"), the Assistant off:
// - a slot lent to B1 (the test copies' `slots:test`, as #1438's card start will) with a line checked out in it:
//   Branches & remotes names the slot on the line's row and the slot's lease on its Worktrees row; ⑂ opens Merge a
//   branch on it, which merges it into main (screenshots in both themes);
// - a card started by B2 in its own worktree (fake Claude Code, by its token) and submitted, in Review: its line in the
//   dialog says it is that card's work, with a link to the card, and Merge asks first; once confirmed the merge is
//   observed (HI-2709: an InTarget mark) and the card stays in Review, its review still to decide.
// - both dialogs start from the project's merge style (HI-1765): Squash when it squashes, a merge commit when it
//   merges or rebases, and a choice made before the style is read (held by CW_TEST_SLOW_IPC) stays.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1578): slot-a is lent through slots:test, and B2 is a 0.9 worktree agent on purpose (the Merge
// dialog on an agent's branch); a packaged build refuses both test channels.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47862))
const fx = q.queueProject('mergedialogslots')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 150)
const git = (cwd, args) => lib.git(cwd, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, ...args])

;(async () => {
  q.prepare(fx)
  const h = await q.startCombwork(fx, { port: PORT, keepOptions: true })
  const { page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1500, height: 950 })
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { finish: 'agentMerges', target: 'main' }) })
    const text = async (l) => ((await l.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    const shoot = async (target, name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.mouse.move(5, 5)
        await target.screenshot({ path: path.join(fx.shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    // --- slot-a lent to B1, a line in it with a commit main hasn't got.
    const b1 = await lib.addAgent(inv, fx.alpha, { name: 'B1' })
    const lent = await inv('slots:test', fx.alpha, { op: 'lend', agent: b1.id, card: 101 })
    check('slot-a is lent to B1', lent.ok && lent.slot.name === 'slot-a', JSON.stringify(lent))
    const slotLine = 'cw/AL/AL-101-slot-work'
    git(lent.slot.folder, ['checkout', '-q', '-b', slotLine])
    fs.writeFileSync(path.join(lent.slot.folder, 's.txt'), 'slot work\n')
    git(lent.slot.folder, ['add', '-A'])
    git(lent.slot.folder, ['commit', '-qm', 'Slot work'])

    // --- Version Control → Branches & remotes.
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('[role="tab"][data-section="branches"]').click()
    const row = (b) => page.locator(`.git-branch[data-branch="${b}"]`)
    check("the line's row names its slot", !!(await until(async () => (await row(slotLine).locator('[data-slot="slot-a"]').count()) === 1, HUNG_MS)) && (await text(row(slotLine).locator('[data-slot]'))) === 'slot-a', await text(row(slotLine)))
    check("…its hover, the slot's lease", (await row(slotLine).locator('[data-slot]').getAttribute('title')) === 'slot-a: B1 on #101')
    const wtRow = page.locator('.git-worktree[data-slot="slot-a"]')
    check("the slot's Worktrees row names its lease", !!(await until(async () => (await text(wtRow)).includes('slot-a: B1 on #101'), HUNG_MS)), await text(wtRow))
    await shoot(page, '1-branches-slots')

    // --- The dialogs start from the project's own merge style (HI-1765): squash, or a merge commit for merge, rebase.
    const setStyle = (style) => inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { finish: 'agentMerges', target: 'main', style }) })
    // The style a dialog shows once it has read the project's (null until then).
    const styleShown = async (d) => ((await d.locator('.choice-list[data-merge-style="read"]').count()) === 1 ? ((await d.locator('.choice-list input[type="radio"]').nth(1).isChecked()) ? 'squash' : 'merge') : null)
    const dialog = page.locator('.dialog', { has: page.locator('[data-branch-merge]') })
    await setStyle('squash')
    await row(slotLine).locator('[data-action="merge-branch"]').click()
    check('Merge a branch starts on Squash for a project that squashes', !!(await until(async () => (await styleShown(dialog)) === 'squash', HUNG_MS)), String(await styleShown(dialog)))
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await dialog.count()) === 0, HUNG_MS)
    // The project's style read late: Merge chosen before it arrives stays chosen.
    await h.app.evaluate(() => {
      process.env.CW_TEST_SLOW_IPC = 'workflow:form=2000*1'
    })
    await row(slotLine).locator('[data-action="merge-branch"]').click()
    await until(async () => (await dialog.locator('.choice-list[data-merge-style="reading"]').count()) === 1, HUNG_MS)
    await dialog.locator('.choice-list label.choice').first().click()
    check('…and Merge chosen before the style is read stays chosen', !!(await until(async () => (await styleShown(dialog)) !== null, HUNG_MS)) && (await styleShown(dialog)) === 'merge', String(await styleShown(dialog)))
    await h.app.evaluate(() => {
      delete process.env.CW_TEST_SLOW_IPC
    })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await dialog.count()) === 0, HUNG_MS)
    await setStyle('rebase')

    // --- Merge a branch on the slot's line: into main.
    await row(slotLine).locator('[data-action="merge-branch"]').click()
    check('…a merge commit for a project that rebases', !!(await until(async () => (await styleShown(dialog)) === 'merge', HUNG_MS)), String(await styleShown(dialog)))
    await setStyle('merge')
    check('⑂ opens Merge a branch on that line, into main', !!(await until(async () => (await dialog.locator('select[data-pick="branch"]').inputValue().catch(() => '')) === slotLine, HUNG_MS)) && (await dialog.locator('select[data-pick="target"]').inputValue()) === 'main', await text(dialog))
    check('…listed under "Cards\' lines", with its slot', (await dialog.locator('optgroup[label="Cards\' lines"] option', { hasText: `${slotLine} (in slot-a)` }).count()) === 1)
    check('…"Merges 1 commit from … into main"', !!(await until(async () => (await text(dialog)).includes(`Merges 1 commit from ${slotLine} into main.`), HUNG_MS)), await text(dialog))
    await shoot(dialog, '2-merge-slot-line')
    await dialog.locator('[data-action="merge"]').click()
    check("the slot's line is merged into main", !!(await until(async () => (await dialog.count()) === 0 && fs.existsSync(path.join(fx.alpha, 's.txt')), HUNG_MS)) && lib.git(fx.alpha, ['log', '-1', '--format=%s', 'main']).trim() === `Merge ${slotLine}`, lib.git(fx.alpha, ['log', '-3', '--oneline', 'main']))

    // --- HI-3030: into a branch checked out nowhere (release). With signing on and a signer that can't run (repo-local:
    // nothing of the user's), refused saying why, release unmoved; signing off and a commit-msg hook: merged, the hook run,
    // no temporary folder left. Both settings undone after.
    const sh = (args) => lib.git(fx.alpha, args).trim()
    git(fx.alpha, ['branch', 'release', 'main'])
    fs.writeFileSync(path.join(lent.slot.folder, 's2.txt'), 'more slot work\n')
    git(lent.slot.folder, ['add', '-A'])
    git(lent.slot.folder, ['commit', '-qm', 'More slot work'])
    const releaseWas = sh(['rev-parse', 'release'])
    const worktreesWere = sh(['worktree', 'list', '--porcelain']).split(/\r?\n/).filter((l) => l.startsWith('worktree ')).join('|')
    git(fx.alpha, ['config', 'commit.gpgsign', 'true'])
    git(fx.alpha, ['config', 'gpg.program', path.join(fx.tools, 'no-such-signer.exe')])
    const openInto = async (target) => {
      await row(slotLine).locator('[data-action="merge-branch"]').click()
      await until(async () => (await dialog.locator('select[data-pick="branch"]').inputValue().catch(() => '')) === slotLine, HUNG_MS)
      await dialog.locator('select[data-pick="target"]').selectOption(target)
      return !!(await until(async () => (await text(dialog)).includes(`into ${target}`), HUNG_MS))
    }
    check('HI-3030: the dialog on the line, into release (checked out nowhere)', await openInto('release'), await text(dialog))
    await dialog.locator('[data-action="merge"]').click()
    check('…signing on, the signer unable to run: refused saying why, release unmoved', !!(await until(async () => /Nothing was merged: .*(sign|gpg)/is.test(await text(dialog)), HUNG_MS)) && sh(['rev-parse', 'release']) === releaseWas, await text(dialog))
    check('…HI-3109: and says the hooks ran in a temporary checkout of release, and where to merge instead', /they ran in a temporary checkout of release, which has none of the project folder's untracked files \(node_modules, say\)\. Check out release in the project folder and merge there/.test(await text(dialog)), await text(dialog))
    await shoot(dialog, '2b-merge-elsewhere-unsigned-refused')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await dialog.count()) === 0, HUNG_MS)
    git(fx.alpha, ['config', '--unset', 'commit.gpgsign'])
    git(fx.alpha, ['config', '--unset', 'gpg.program'])
    const hooks = path.join(fx.tools, 'hi3030-hooks')
    fs.mkdirSync(hooks, { recursive: true })
    fs.writeFileSync(path.join(hooks, 'commit-msg'), '#!/bin/sh\necho "Hooked: yes" >> "$1"\n')
    // HI-3109: and a post-checkout hook that fails in a fresh checkout: no refusal, and no folder left.
    fs.writeFileSync(path.join(hooks, 'post-checkout'), '#!/bin/sh\necho "post-checkout: node_modules missing" >&2\nexit 1\n')
    git(fx.alpha, ['config', 'core.hooksPath', hooks.replace(/\\/g, '/')])
    await openInto('release')
    await dialog.locator('[data-action="merge"]').click()
    const merged = await until(async () => (await dialog.count()) === 0 && sh(['rev-parse', 'release']) !== releaseWas, HUNG_MS)
    check("…then merged into release by git merge (HI-3109: its post-checkout hook failing too): two parents, the repository's commit-msg hook run", !!merged && sh(['log', '-1', '--format=%P', 'release']).split(' ').length === 2 && sh(['log', '-1', '--format=%B', 'release']).includes('Hooked: yes'), sh(['log', '-1', '--format=%H %P%n%B', 'release']))
    check('…the project folder untouched, no temporary worktree left', sh(['rev-parse', '--abbrev-ref', 'HEAD']) === 'main' && sh(['worktree', 'list', '--porcelain']).split(/\r?\n/).filter((l) => l.startsWith('worktree ')).join('|') === worktreesWere, sh(['worktree', 'list']))
    await shoot(page, '2c-merged-elsewhere')
    git(fx.alpha, ['config', '--unset', 'core.hooksPath'])

    // --- A card in Review: its line is its work; merged here only after asking, then marked as in main (HI-2709).
    const b2 = await q.agent(fx, h, 'B2', { worktree: true })
    const n = (await inv('tasks:create', { title: 'Card in review', project: 'alpha' })).number
    const key = (await h.card(n)).key
    const started = await q.intent(h, b2, n, 'start')
    const line = started.body?.data?.line
    check('the card starts on its line', started.status === 200 && !!line, JSON.stringify(started.body))
    fs.writeFileSync(path.join(b2.folder, 'c.txt'), 'card work\n')
    git(b2.folder, ['add', '-A'])
    git(b2.folder, ['commit', '-qm', 'Card work'])
    const sub = await q.intent(h, b2, n, 'submit', { summary: 'ready' })
    check('submitted: in Review', sub.status === 200 && !!(await until(async () => (await h.card(n))?.column === 'review', HUNG_MS)), JSON.stringify(sub.body))
    await until(async () => (await row(line).count()) === 1, HUNG_MS)
    await row(line).locator('[data-action="merge-branch"]').click()
    const note = dialog.locator(`[data-line-card="${n}"]`)
    check(`the dialog says the line is ${key}'s work, with a link to it`, !!(await until(async () => (await note.count()) === 1, HUNG_MS)) && (await text(note)).includes(`This is ${key}'s work: merge it through its card.`) && (await note.locator(`[data-open-card="${n}"]`).count()) === 1, await text(dialog))
    await until(async () => (await text(dialog)).includes('Merges 1 commit'), HUNG_MS)
    await shoot(dialog, '3-card-line')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await dialog.count()) === 0, HUNG_MS)

    // --- Every other route asks too (HR3's round 1 finding 2): main refuses the card's line unconfirmed, and the older
    // Merge dialog (B2's worktree, from Changes) says whose work it is and asks first.
    const cardWork = new RegExp(`is ${key}'s work`)
    const refusal = (p) => p.then(
      () => null,
      (e) => String(e?.message ?? e)
    )
    const agentRefused = await refusal(inv('agents:merge', fx.alpha, b2.id, { squash: false, message: 'x', cleanup: false }))
    check("agents:merge refuses the card's line unconfirmed", !!agentRefused && cardWork.test(agentRefused), agentRefused)
    await page.locator('[role="tab"][data-section="changes"]').click()
    const picker = page.locator('.split-list .root-select')
    await until(async () => (await picker.count()) === 1, HUNG_MS)
    await picker.selectOption(b2.id)
    const mergeAgent = page.locator('[data-action="merge-agent"]')
    await until(async () => (await mergeAgent.count()) === 1 && (await mergeAgent.isEnabled()), HUNG_MS)
    await setStyle('squash')
    await mergeAgent.click()
    const older = page.locator('.dialog', { has: page.locator(`[data-line-card="${n}"]`) })
    check(`the older Merge dialog says the line is ${key}'s work`, !!(await until(async () => (await older.count()) === 1, HUNG_MS)), await text(page.locator('.dialog').last()))
    check('…starting on Squash for a project that squashes (HI-1765)', !!(await until(async () => (await styleShown(older)) === 'squash', HUNG_MS)), String(await styleShown(older)))
    await shoot(older, '3b-older-squash')
    await older.locator('.choice-list label.choice').first().click()
    await setStyle('merge')
    await until(async () => (await older.locator('[data-action="merge"]').isEnabled().catch(() => false)), HUNG_MS)
    await older.locator('[data-action="merge"]').click()
    const ask = page.locator('.dialog', { hasText: `Merge ${key}'s work outside its card?` })
    check('…and Merge asks first', !!(await until(async () => (await ask.count()) === 1, HUNG_MS)), await text(page.locator('.dialog').last()))
    await ask.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await ask.count()) === 0, HUNG_MS)
    check('…cancelled, nothing is merged', !fs.existsSync(path.join(fx.alpha, 'c.txt')))
    await older.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await older.count()) === 0, HUNG_MS)

    // --- B2 removed, its worktree kept, carried into the slots and given up: Unused Worktrees lists it as a slot row
    // with the card's line; main refuses its merge unconfirmed, and its Open → Merge opens Merge a branch, which asks.
    await inv('session:stop', fx.alpha, b2.id)
    await until(async () => !(await inv('session:live')).some((s) => s.agentId === b2.id), HUNG_MS)
    await inv('agents:remove', fx.alpha, b2.id, { deleteWorktree: false })
    check('the card stays in Review without its builder', (await h.card(n))?.column === 'review')
    const carried = await inv('slots:test', fx.alpha, { op: 'carry', agent: b2.id, slot: 'slot-z', folder: b2.folder })
    check("B2's old worktree is carried as slot-z", !!carried, JSON.stringify(carried))
    await inv('slots:test', fx.alpha, { op: 'release', lease: carried.id, why: 'given up' })
    const unusedRefused = await refusal(inv('worktrees:mergeUnused', fx.alpha, b2.folder, { squash: false, message: 'x', cleanup: false }))
    check("worktrees:mergeUnused refuses the card's line unconfirmed", !!unusedRefused && cardWork.test(unusedRefused), unusedRefused)
    await picker.selectOption('unused')
    // Carried and given up by the test channel, which tells the window nothing: read the list again, as its ⟳ does.
    const again = page.locator('.split-list .pane-header .icon-btn').first()
    await until(async () => (await again.isEnabled().catch(() => false)), HUNG_MS)
    await again.click()
    const zrow = page.locator('.unused-wt[data-slot="slot-z"]')
    check('slot-z is listed, given up, with its line', !!(await until(async () => (await zrow.locator('[data-unused-kind="carried"]').count()) === 1, HUNG_MS)) && (await text(zrow)).includes(line), await text(zrow))
    await zrow.getByRole('button', { name: 'Open' }).click()
    const mergeUnusedButton = page.locator('[data-action="merge-unused"]')
    await until(async () => (await mergeUnusedButton.count()) === 1, HUNG_MS)
    await mergeUnusedButton.click()
    check('Open → Merge opens Merge a branch on its line, saying whose work it is', !!(await until(async () => (await dialog.locator('select[data-pick="branch"]').inputValue().catch(() => '')) === line && (await note.count()) === 1, HUNG_MS)), await text(dialog))
    await until(async () => (await text(dialog)).includes('Merges 1 commit'), HUNG_MS)
    await dialog.locator('[data-action="merge"]').click()
    check('Merge asks first', !!(await until(async () => (await ask.count()) === 1, HUNG_MS)), await text(page.locator('.dialog').last()))
    await shoot(ask, '4-card-confirm')
    await ask.getByRole('button', { name: 'Merge Here' }).click()
    check("the card's line is merged into main", !!(await until(async () => fs.existsSync(path.join(fx.alpha, 'c.txt')), HUNG_MS)))
    // HI-2709: a merge outside its review never closes a card in Review: it is marked, and its review still decides.
    const inMain = await until(async () => (await h.facts(n)).find((f) => f.kind === 'InTarget' && f.data.target === 'main'), HUNG_MS)
    check('…observed: marked as already in main (InTarget), no Integrated', !!inMain && !(await h.facts(n)).some((f) => f.kind === 'Integrated'), JSON.stringify((await h.facts(n)).map((f) => f.kind)))
    check('…and the card stays in Review', (await h.card(n))?.column === 'review', (await h.card(n))?.column)
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
