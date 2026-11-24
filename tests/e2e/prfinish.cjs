// The pull request finish (HI-3552) in the window: Version Control → Workflow offers Who merges → A pull request in the
// Merging tab (Merge style hidden) and Open pull requests as drafts in the GitHub tab; a card the fake agents approve
// goes to PR open with its pull request's number as a link on its tile, and its dialog shows GitHub's checks and review;
// merged on GitHub, reading it (as the dialog does) moves the card to Done. GitHub is a fake gh (CW_TEST_GH) answering
// for github.com/acme/app: it lists a pull request already open for the card's branch, so Combwork records it rather
// than pushing (the remote is a github.com address only, never reached: no network). What a push and a create do, and
// every failure, is tests/workflow/prFinish.test.ts's. Dev build, throwaway profile and workspace, the fake agents.
// NOT RUN on a packaged build (CW_TEST_GH is a dev seam).
const lib = require('./lib.cjs')
const q = require('./queueFixture.cjs')
const fs = require('fs')
const path = require('path')
const { HUNG_MS } = q

const fx = q.queueProject('prfinish')
const ghDir = path.join(fx.tools, 'gh')
const callLog = path.join(ghDir, 'calls.jsonl')
const mergedFlag = path.join(ghDir, 'merged')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

/** The fake gh: acme/app's pull request #12 for whatever branch is asked, open (a draft) until `merged` exists. */
function writeFakeGh() {
  fs.mkdirSync(ghDir, { recursive: true })
  fs.writeFileSync(
    path.join(ghDir, 'gh.cjs'),
    `const fs = require('fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ args, token: Object.keys(process.env).some((k) => /TOKEN/i.test(k)) }) + '\\n')
if (args[0] === '--version') { process.stdout.write('gh version 2.83.0\\n'); process.exit(0) }
if (args[0] === 'auth') { const h = args[args.indexOf('--hostname') + 1]; process.stdout.write(JSON.stringify({ hosts: { [h]: [{ state: 'success', active: true, login: 'mona' }] } })); process.exit(0) }
const repo = args[args.indexOf('-R') + 1]
if (repo !== 'github.com/acme/app') { process.stderr.write('wrong repository: ' + repo); process.exit(1) }
const url = 'https://github.com/acme/app/pull/12'
const merged = fs.existsSync(${JSON.stringify(mergedFlag)})
if (args[0] === 'pr' && args[1] === 'list') {
  const head = args[args.indexOf('--head') + 1], base = args[args.indexOf('--base') + 1]
  process.stdout.write(JSON.stringify([{ number: 12, url, createdAt: new Date().toISOString(), headRefName: head, baseRefName: base, isCrossRepository: false, isDraft: true }]))
} else if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ number: 12, url, state: merged ? 'MERGED' : 'OPEN', isDraft: true, reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }], headRefOid: 'a'.repeat(40), mergeCommit: merged ? { oid: 'b'.repeat(40) } : null, mergedAt: null, closedAt: null }))
} else { process.stderr.write('unexpected: ' + args.join(' ')); process.exit(1) }
`
  )
  fs.writeFileSync(path.join(ghDir, 'gh.cmd'), '@node "%~dp0gh.cjs" %*\r\n')
  fs.writeFileSync(callLog, '')
}
const calls = () => fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

;(async () => {
  q.prepare(fx)
  writeFakeGh()
  // The project's GitHub link: origin a github.com address only (nothing is fetched or pushed in this suite).
  lib.git(fx.alpha, ['remote', 'add', 'origin', 'https://github.com/acme/app.git'])
  const port = Number(lib.port(47939))
  const env = lib.withPathFirst({ CW_TEST_GH: path.join(ghDir, 'gh.cmd'), GH_TOKEN: 'ghp_never_given' }, [path.dirname(process.execPath)])
  const h = await q.startCombwork(fx, { port, env })
  const { page, inv } = h
  const shoot = async (name, loc) => {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      await page.mouse.move(5, 5)
      await loc.screenshot({ path: path.join(fx.shots, `prfinish-${name}-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
  }
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { finish: 'pullRequest', target: 'main', mergeChecks: [] }) })

    // --- The options: Who merges → A pull request (Merge style hidden), and the GitHub tab's draft switch.
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('.git-sections [data-section="workflow"]').click()
    const form = page.locator('.workflow-form')
    await lib.workflowTab(form, 'merging')
    const finish = form.locator('[data-option="finish"] select')
    check('Who merges offers and shows A pull request', !!(await until(async () => (await finish.count()) === 1 && (await finish.inputValue()) === 'pullRequest', HUNG_MS)) && (await finish.locator('option[value="pullRequest"]').textContent()) === 'A pull request')
    check('…and hides Merge style', (await form.locator('[data-option="style"]').count()) === 0)
    await shoot('1-finish', form)
    await lib.workflowTab(form, 'github')
    const draft = form.locator('[data-option="prDraft"]')
    check('the GitHub tab has Open pull requests as drafts, on', !!(await until(async () => (await draft.count()) === 1, HUNG_MS)) && /Open pull requests as drafts/.test(await draft.innerText()) && (await draft.locator('input[type="checkbox"], [role="switch"]').first().isChecked().catch(() => null)) !== false)
    await shoot('2-draft', form)

    // --- A card approved by the fake agents goes to PR open, its pull request found already open (nothing pushed).
    const reviewer = await q.agent(fx, h, 'R1')
    const { n } = await q.approve(fx, h, reviewer, 'Fix the parser', { 'parser.txt': 'fixed\n' })
    check('approved, it is in PR open with its pull request recorded', !!(await until(async () => (await h.kinds(n)).includes('PrOpened') && (await inv('tasks:workBadges')).find((b) => b.card === n)?.stage === 'prOpen', HUNG_MS)), JSON.stringify(await h.kinds(n)))
    check('…gh named the repository on every call, and was given no token', calls().filter((c) => c.args[0] === 'pr').every((c) => c.args.includes('-R') && c.args.includes('github.com/acme/app')) && calls().every((c) => !c.token), JSON.stringify(calls()))
    await q.showBoard(page)
    const tile = page.locator(`.task-card[data-task="${n}"]`)
    const line = tile.locator('.task-pr[data-pr="12"]')
    check('its tile shows PR #12 as a link, a draft', !!(await until(async () => (await line.count()) === 1, HUNG_MS)) && /PR #12/.test(await line.innerText()) && /Draft/.test(await line.innerText()), await tile.innerText().catch(() => ''))
    await shoot('3-tile', tile)

    // --- Its dialog: GitHub's state read now.
    await q.openByTitle(page, n)
    const d = lib.cardDialog(page, await lib.cardLabel(inv, n))
    const pr = d.locator('.card-pr')
    check('its dialog reads GitHub: checks and review', !!(await until(async () => (await pr.getAttribute('data-pr-state').catch(() => null)) === 'open', HUNG_MS)) && /Checks: 1 passed, 1 failed, 1 running/.test(await pr.innerText()) && /Changes requested on GitHub/.test(await pr.innerText()), await pr.innerText().catch(() => ''))
    check('…and commits pushed to it outside Combwork', (await pr.locator('[data-pr-outside]').count()) === 1)
    await shoot('4-dialog', pr)
    await page.keyboard.press('Escape')

    // --- Merged on GitHub: read again, the card is Done with GitHub's merge commit.
    fs.writeFileSync(mergedFlag, '')
    await inv('tasks:prStatus', n)
    const integrated = async () => (await h.facts(n)).find((f) => f.kind === 'Integrated')?.data
    check('merged on GitHub, it is Done with the merge commit recorded', !!(await until(async () => (await integrated())?.result === 'b'.repeat(40) && (await h.card(n))?.column === 'done', HUNG_MS)), JSON.stringify(await integrated()))
  } catch (e) {
    check('the suite ran to the end', false, e.stack ?? String(e))
    await page.screenshot({ path: path.join(fx.shots, 'prfinish-failed.png') }).catch(() => {})
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
