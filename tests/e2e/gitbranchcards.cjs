// Branches next to their cards (#1424, SPEC §16.20's Git support), on fake Claude Code agents acting by their own tokens,
// the Assistant off, a temp Git project where Hive merges into integration (queueFixture.cjs's): in Version Control →
// Branches & remotes, a card started in an agent's worktree shows on its branch's row (and the worktree's) with its key
// and Active; submitted, Review and the revision under review, the same as its Work section's; merged by the queue, Done
// and merged with Integrated's revision; a no-code card's builder's branch has no card; a branch no card works on is as
// before; the card's key opens the card. Screenshots in both themes. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47815))
const fx = q.queueProject('gitbranchcards')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const waitHung = (fn) => lib.until(fn, HUNG_MS, 150)

;(async () => {
  q.prepare(fx)
  // A branch no card works on.
  lib.git(fx.alpha, ['branch', 'feature/plain'])
  const h = await q.startHive(fx, { port: PORT })
  const { page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1500, height: 950 })
    const r1 = await q.agent(fx, h, 'R1')
    const b1 = await q.agent(fx, h, 'B1', { worktree: true })
    const b2 = await q.agent(fx, h, 'B2', { worktree: true })
    const n = (await inv('tasks:create', { title: 'Branch card', project: 'alpha' })).number
    const key = (await h.card(n)).key
    const started = await q.intent(h, b1, n, 'start')
    const line = started.body?.data?.line
    check('the card starts in B1’s worktree, on its branch', started.status === 200 && !!line, JSON.stringify(started.body))

    // --- Version Control → Branches & remotes.
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('[role="tab"][data-section="branches"]').click()
    const row = (b) => page.locator(`.git-branch[data-branch="${b}"]`)
    const chip = (b) => row(b).locator(`[data-branch-card="${n}"]`)
    const worktreeChip = page.locator(`.git-worktree [data-branch-card="${n}"]`)
    const text = async (l) => ((await l.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    check("Active: the branch's row shows the card's key and its stage", !!(await waitHung(async () => (await chip(line).getAttribute('data-stage').catch(() => null)) === 'active' && (await text(chip(line))).includes(key) && (await text(chip(line))).includes('Active'))), await text(row(line)))
    check("…in the stage's category colour (Active's stripes)", (await chip(line).locator('.lane-seg.doing').count()) === 1)
    check("…the agent's worktree badge stays", (await row(line).locator('[data-worktree]').innerText()) === "B1's worktree", await text(row(line)))
    check('…and the worktree names its card the same way', !!(await waitHung(async () => (await worktreeChip.count()) === 1 && (await text(worktreeChip)).includes(key))), await text(page.locator('.git-worktree').first()))
    const shoot = async (name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await waitHung(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
        await page.mouse.move(5, 5)
        await page.screenshot({ path: path.join(fx.shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }
    await shoot('1-active')

    // --- Submitted: Review, with the revision under review (as its Work section has it).
    fs.writeFileSync(path.join(b1.folder, 'b.txt'), 'b\n')
    lib.git(b1.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
    lib.git(b1.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', 'Branch card'])
    const revision = lib.git(b1.folder, ['rev-parse', 'HEAD']).trim()
    const sub = await q.intent(h, b1, n, 'submit', { summary: 'ready' })
    check('submitted', sub.status === 200, JSON.stringify(sub.body))
    const work = await inv('tasks:work', n)
    check("Review: the row says under review and the revision, the same as the card's Work section", !!(await waitHung(async () => (await chip(line).getAttribute('data-stage')) === 'review' && (await chip(line).locator('[data-under-review]').getAttribute('data-under-review')) === revision)) && work?.revisions?.at(-1)?.revision === revision && (await text(chip(line))).includes(`under review: ${revision.slice(0, 7)}`), await text(chip(line)))
    check('…its copy button holds the whole revision', (await chip(line).locator('[data-copy-revision]').getAttribute('data-copy-revision')) === revision)
    await shoot('2-review')

    // --- Passed and merged by the queue: Done, merged as Integrated's revision.
    await q.intent(h, r1, n, 'start-review')
    const passed = await q.intent(h, r1, n, 'verdict', { pass: true, comment: 'passed' })
    check('passed', passed.status === 200, JSON.stringify(passed.body))
    const done = await waitHung(async () => (await h.card(n))?.column === 'done')
    const integrated = (await h.facts(n)).filter((x) => x.kind === 'Integrated').at(-1)
    check('merged by the queue: Done', !!done && !!integrated?.data?.result, JSON.stringify(await h.kinds(n)))
    check("Done: the row says merged, with the merge's revision", !!(await waitHung(async () => (await chip(line).getAttribute('data-stage')) === 'done' && (await chip(line).locator('[data-merged]').getAttribute('data-merged')) === integrated?.data?.result)) && (await text(chip(line))).includes(`merged: ${String(integrated?.data?.result).slice(0, 7)}`), await text(chip(line)))
    await shoot('3-merged')

    // --- A no-code card: its builder's branch has no card. A branch no card works on: as today.
    const nc = (await inv('tasks:create', { title: 'No-code card', project: 'alpha', kind: 'no-code' })).number
    const ncStart = await q.intent(h, b2, nc, 'start')
    check('a no-code card starts', ncStart.status === 200, JSON.stringify(ncStart.body))
    const b2branch = lib.git(b2.folder, ['branch', '--show-current']).trim()
    await waitHung(async () => (await inv('tasks:workBadges')).some((b) => b.card === nc && b.stage === 'active'))
    check("…its builder's branch shows no card", (await row(b2branch).count()) === 1 && (await row(b2branch).locator('[data-branch-card]').count()) === 0, await text(row(b2branch)))
    check('a branch no card works on shows as before: no card', (await row('feature/plain').count()) === 1 && (await row('feature/plain').locator('[data-branch-card]').count()) === 0, await text(row('feature/plain')))

    // --- The card's key opens the card.
    await chip(line).locator('.git-branch-card-key').click()
    check("the card's key opens it", !!(await waitHung(async () => (await page.locator('.dialog[role="dialog"] .task-title-input').first().inputValue().catch(() => '')) === 'Branch card')))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => undefined)
  }
  console.log(`screenshots: ${fx.shots}`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
