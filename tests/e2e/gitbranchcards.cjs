// Branches next to their cards (#1424, SPEC §16.20's Git support), on fake Claude Code agents acting by their own tokens,
// the Assistant off, a temp Git project where Hive merges into integration (queueFixture.cjs's): in Version Control →
// Branches & remotes, a card started in an agent's worktree shows on its branch's row (and the worktree's) with its key
// and Active; submitted, Review and the revision under review, the same as its Work section's; merged by the queue, Done
// and merged with Integrated's revision; a no-code card's builder's branch has no card; a branch no card works on is as
// before; a worktree names its agent's card even with another branch checked out; the card's key opens the card. Screenshots in both themes. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
// Dev build only, 0.9 worktrees on purpose (#1578): B1 and B2 are 0.9 worktree agents (agents:testLegacy, refused by a
// packaged build), as a lane carried over the upgrade has; cards on slots beside their branches are p6lane's.
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
    // A swatch, not a lane: its stripes stand still (#1629: they move on a ::before the swatch stops).
    const swatchMoves = await chip(line).locator('.lane-seg.doing').evaluate((e) => getComputedStyle(e, '::before').animationName)
    check('…and stand still', swatchMoves === 'none', swatchMoves)
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
    // Its row is the busiest (worktree, card, Review, under review), yet its time and actions stay whole, in the same
    // place as every other row's, its middle giving way with "…" (HI-1897); at a narrow width too.
    const rowsFit = () =>
      page.locator('.git-rows', { has: page.locator('.git-row.git-branch') }).first().evaluate((list) => {
        const rows = [...list.querySelectorAll('.git-row.git-branch:not(.remote)')]
        const box = (e) => e.getBoundingClientRect()
        const out = rows.map((r) => {
          const rb = box(r)
          const tail = r.querySelector('.git-row-tail')
          const parts = [...(tail?.querySelectorAll('button, .git-meta') ?? [])].map(box)
          const sw = tail?.lastElementChild ? box(tail.lastElementChild) : null
          return { name: r.dataset.branch, whole: !!tail && parts.every((b) => b.left >= rb.left - 0.5 && b.right <= rb.right + 0.5), switchRight: sw ? Math.round(sw.right) : null, infoCut: (() => { const i = r.querySelector('.git-branch-info'); return !!i && i.scrollWidth > i.clientWidth + 1 })() }
        })
        return { rows: out.length, whole: out.every((o) => o.whole), lined: new Set(out.map((o) => o.switchRight)).size === 1, cut: out.filter((o) => o.infoCut).map((o) => o.name) }
      })
    const fits = async (cutRow) => { const f = await rowsFit(); return f.rows > 2 && f.whole && f.lined && (!cutRow || f.cut.includes(cutRow)) }
    check('every row’s time and actions whole and lined up, the busy row’s included', !!(await waitHung(() => fits(null))), JSON.stringify(await rowsFit()))
    await lib.fitWindow(h.app, page, { width: 900, height: 820 })
    check('…at a narrow width too, the busy row’s middle cut with … rather than its buttons', !!(await waitHung(() => fits(line))), JSON.stringify(await rowsFit()))
    check('…its middle’s whole text in its tooltip', !!(await (async () => { await row(line).locator('.git-branch-info').dispatchEvent('mouseover'); return waitHung(async () => (await row(line).locator('.git-branch-info').getAttribute('title') ?? '').includes(`under review: ${revision.slice(0, 7)}`)) })()), await row(line).locator('.git-branch-info').getAttribute('title'))
    await shoot('2-review-narrow')
    await lib.fitWindow(h.app, page, { width: 1400, height: 900 })

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

    // --- A worktree names its agent's card, whatever its folder has checked out (HR4's round 1): B1 starts another
    // card, then something outside Hive checks out feature/plain in B1's worktree.
    const n2 = (await inv('tasks:create', { title: 'Next on B1', project: 'alpha' })).number
    const key2 = (await h.card(n2)).key
    const s2 = await q.intent(h, b1, n2, 'start')
    check('B1 starts its next card', s2.status === 200, JSON.stringify(s2.body))
    lib.git(b1.folder, ['checkout', '-q', 'feature/plain'])
    await page.locator('[data-action="reload-branches"]').click()
    const b1Worktree = page.locator('.git-worktree').filter({ hasText: "B1's worktree" })
    check("the worktree names its agent's card even on another branch", !!(await waitHung(async () => (await b1Worktree.locator(`[data-branch-card="${n2}"]`).count()) === 1 && (await text(b1Worktree)).includes('feature/plain'))), await text(b1Worktree))
    check('…while that branch’s own row, a line no card works on, shows none', (await row('feature/plain').locator('[data-branch-card]').count()) === 0, await text(row('feature/plain')))
    check("…and B1's own branch still shows the card whose line it is", (await row(line).locator(`[data-branch-card="${n2}"]`).count()) === 1 && (await text(row(line))).includes(key2), await text(row(line)))
    lib.git(b1.folder, ['checkout', '-q', line])

    // --- The card's key opens the card.
    await row(line).locator(`[data-branch-card="${n2}"] .git-branch-card-key`).click()
    check("the card's key opens it", !!(await waitHung(async () => (await page.locator('.dialog[role="dialog"] .task-title-input').first().inputValue().catch(() => '')) === 'Next on B1')))
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
