// Strict, G8 (#1352, SPEC §16.9.1 step 3; S55's strict part): a project set to "Hive merges" into `integration` (checked
// out in no folder) with Work is up to date with its target branch before it merges on, fake Claude Code agents acting
// by their own tokens (one builder in the project folder, building each card on the slot its start lends, as 1.0 does:
// #1573; one reviewer), the Assistant off.
// - The form offers G8 beside G9 when Hive merges (screenshots of its row, both themes), and saves it.
// - The target moves after the review passed: the queue brings the reviewed revision up to date on its own ref
//   (`Updated`, carried), merges it, and the card's slot is untouched (its HEAD and status).
// - A conflict with the moved target: back to the builder (notUpToDate) with the file, its slot untouched; the
//   builder brings its line up to date there, submits, the review passes, and it merges with no update.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47851))
const fx = q.queueProject('mergestrict')
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// Every wait here is bounded only against a hang (#570).
const waitHung = (fn) => lib.until(fn, HUNG_MS, 200)
const f = q.folderHelpers(fx)
/** Whether `a` is in `b`'s history (git's merge-base --is-ancestor; lib.git throws on its "no"). */
const ancestor = (a, b) => {
  try {
    lib.git(fx.alpha, ['merge-base', '--is-ancestor', a, b])
    return true
  } catch {
    return false
  }
}
const who = ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`]

;(async () => {
  q.prepare(fx)
  const h = await q.startHive(fx, { port: PORT, keepOptions: true })
  try {
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx) })
    const column = async (n) => (await h.card(n))?.column
    const facts = async (n, kind) => (await h.facts(n)).filter((x) => x.kind === kind)

    // --- The form: G8 beside G9 while Hive merges; saved through the form.
    await h.page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await h.page.locator('.git-sections [data-section="workflow"]').click()
    const section = h.page.locator('.workflow-form')
    const row = section.locator('.workflow-option[data-option="strict"]')
    check('Version Control → Workflow offers G8 while Combwork merges', !!(await waitHung(async () => (await row.count()) === 1)) && (await row.innerText()).includes('Work is up to date with its target branch before it merges'), await section.innerText().catch(() => ''))
    await row.scrollIntoViewIfNeeded()
    await row.locator('[role="switch"], input[type="checkbox"]').first().click()
    await section.getByRole('button', { name: 'Save…' }).click()
    const dialog = h.page.locator('.dialog', { hasText: 'Save Workflow Options' })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.waitFor({ state: 'detached', timeout: HUNG_MS })
    const saved = await waitHung(async () => (await h.inv('workflow:form', fx.alpha)).own.strict === true)
    check('…saved: the project is strict', !!saved, JSON.stringify((await h.inv('workflow:form', fx.alpha)).own))
    const strictRow = section.locator('.workflow-option[data-option="strict"]')
    await strictRow.scrollIntoViewIfNeeded()
    await f.themes(h.page, strictRow, 'mergestrict-g8')
    await h.page.keyboard.press('Escape')

    const reviewer = await q.agent(fx, h, 'R1')
    check('the reviewer has its token', !!reviewer.token)
    const builder = await q.agent(fx, h, 'B1')

    /** A card built on the slot its start lends and submitted; the target moved (`move`) before its review passes. */
    const build = async (title, files, move) => {
      const n = (await h.inv('tasks:create', { title, project: 'alpha' })).number
      const steps = { start: await q.startCard(fx, h, builder, n) }
      const folder = builder.folder
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), text)
      lib.git(folder, [...who, 'add', '-A'])
      lib.git(folder, [...who, 'commit', '-qm', title])
      const revision = lib.git(folder, ['rev-parse', 'HEAD']).trim()
      steps.submit = await q.intent(h, builder, n, 'submit', { summary: `${title}: ready` })
      const moved = move()
      const worktree = { head: revision, status: lib.git(folder, ['status', '--porcelain']).trim() }
      steps.review = await q.intent(h, reviewer, n, 'start-review')
      steps.verdict = await q.intent(h, reviewer, n, 'verdict', { pass: true, comment: `${title}: passed` })
      return { n, builder, folder, revision, moved, worktree, steps }
    }
    const untouched = (b) => lib.git(b.folder, ['rev-parse', 'HEAD']).trim() === b.worktree.head && lib.git(b.folder, ['status', '--porcelain']).trim() === b.worktree.status

    // --- S55 (strict): the target moved after the pass; updated on the queue's own ref, merged; the slot untouched.
    q.steer(fx, 'pass')
    const one = await build('One', { 'one.txt': 'one\n' }, () => q.commitOn(fx, 'integration', { 'meanwhile.txt': 'meanwhile\n' }, 'the target moves'))
    check('the card is approved (start, submit, review, pass)', Object.values(one.steps).every((s) => s.status === 200), JSON.stringify(one.steps))
    check('S55: merged: Done', !!(await waitHung(async () => (await column(one.n)) === 'done')), JSON.stringify(await h.kinds(one.n)))
    const [up] = await facts(one.n, 'Updated')
    check('…brought up to date by the queue: Updated, carried, from the reviewed revision', up?.data?.carried === true && up.data.from === one.revision && up.data.how === 'mergedTarget', JSON.stringify(up))
    check('…the update contains the moved target, and the merge brought it in, naming both revisions', ancestor(one.moved, up?.data?.to ?? one.revision) && lib.git(fx.alpha, ['log', '-1', '--format=%B', 'integration']).includes(`Hive-Updated: ${up?.data?.to}`) && lib.git(fx.alpha, ['log', '-1', '--format=%B', 'integration']).includes(`Hive-Revision: ${one.revision}`))
    check("…the card's slot untouched: its HEAD and status as they were, its branch at the reviewed revision", untouched(one) && lib.git(fx.alpha, ['rev-parse', `refs/heads/${(await h.facts(one.n)).find((x) => x.kind === 'Started')?.data?.line}`]).trim() === one.revision)
    const key1 = (await h.card(one.n)).key
    check("…its entry's update ref dropped with the outcome", !!(await waitHung(() => !lib.git(fx.alpha, ['for-each-ref', '--format=%(refname)', 'refs/hive/queue/']).includes(`${key1}-e`))))

    // --- A conflict with the moved target: returned (notUpToDate) with the file; the builder resumes in its slot.
    const two = await build('Two', { 'a.txt': 'one\ntwo by the builder\nthree\n' }, () => q.commitOn(fx, 'integration', { 'a.txt': 'one\nTWO by someone\nthree\n' }, 'someone changes a.txt'))
    const atTwo = q.head(fx)
    const failure = await waitHung(async () => (await facts(two.n, 'IntegrationFailed'))[0])
    check('a conflict with the moved target returns it: notUpToDate, naming a.txt, back in Doing', failure?.data?.reason === 'notUpToDate' && JSON.stringify(failure.data.files) === '["a.txt"]' && (await column(two.n)) === 'doing', JSON.stringify(failure))
    check("…nothing merged, the card's slot untouched", q.head(fx) === atTwo && untouched(two) && (await facts(two.n, 'Updated')).length === 0)
    // HI-1181 round 1: strict's conflict shows its hunks too (it isn't up to date, not a conflict, as its reason), the
    // card's side first (strict merges the target into it).
    await q.showBoard(h.page)
    await q.openByTitle(h.page, two.n)
    const twoDialog = h.page.locator('.dialog').filter({ has: h.page.locator('.task-title-input') })
    await twoDialog.waitFor({ timeout: HUNG_MS })
    const fileRow = twoDialog.locator('[data-conflict-file="a.txt"]')
    check("…its Work section lists a.txt with its one conflict", !!(await waitHung(async () => /a\.txt\s+1 conflict/.test(await fileRow.innerText().catch(() => '')))), await twoDialog.innerText().catch(() => ''))
    await fileRow.locator('button').click()
    const twoKey = (await h.card(two.n)).key
    const ordered = (t) => {
      const at = [twoKey, 'two by the builder', 'integration', 'TWO by someone'].map((x) => t.indexOf(x))
      return at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1]))
    }
    check('…unfolded: the card’s side first, then integration’s', !!(await waitHung(async () => ordered(await fileRow.locator('.card-work-hunk-text').innerText().catch(() => '')))), await fileRow.innerText().catch(() => ''))
    await h.page.keyboard.press('Escape')
    // The builder brings its line up to date in its card's slot (its side of the conflict kept), and submits again.
    lib.git(two.folder, [...who, 'merge', '-q', '-X', 'ours', '-m', 'integration in', 'integration'])
    const again = await q.intent(h, two.builder, two.n, 'submit', { summary: 'Two: up to date' })
    const review = await q.intent(h, reviewer, two.n, 'start-review')
    const verdict = await q.intent(h, reviewer, two.n, 'verdict', { pass: true, comment: 'Two: passed again' })
    check('…the builder resumes cleanly: submits its merged line, the review passes', [again, review, verdict].every((s) => s.status === 200), JSON.stringify([again.body, review.body, verdict.body]))
    check('…and it merges with no update (already up to date)', !!(await waitHung(async () => (await column(two.n)) === 'done')) && (await facts(two.n, 'Updated')).length === 0 && lib.git(fx.alpha, ['show', 'integration:a.txt']).replace(/\r\n/g, '\n') === 'one\ntwo by the builder\nthree\n', JSON.stringify(await h.kinds(two.n)))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(`screenshots: ${fx.shots}`)
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
