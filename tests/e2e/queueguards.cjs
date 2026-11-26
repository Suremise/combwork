// Merge guards (HI-3284, SPEC §16.9.6): a project set to "Combwork merges" into `integration` (queueFixture.cjs) with no
// G9 checks; fake Claude Code agents acting by their own tokens.
// - Version Control → Workflow → Merge guards: a guard added in the editor, an invalid pattern shown as a problem before
//   saving, saved into the project's options; the example guard offered once Settings → General has a name;
// - a card adding a match comes back from the merge queue: the check "merge guards" with its diagnostics, the builder's
//   wake, and the card's comment naming the guard, the file and line, and the guard's message;
// - a card changing a file that already holds a match merges: only added lines count.
// Screenshots of the editor and the returned card, both themes. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47721))
const fx = q.queueProject('queueguards')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.step')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
const projectJson = () => JSON.parse(fs.readFileSync(path.join(fx.alpha, '.combwork', 'project.json'), 'utf8'))

;(async () => {
  q.prepare(fx)
  const h = await q.startCombwork(fx, { port: PORT })
  try {
    const { page, inv } = h
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1400, height: 900 })
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { mergeChecks: [], commands: {} }) })
    const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    const shoot = async (loc, name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.mouse.move(5, 5)
        await loc.screenshot({ path: path.join(fx.shots, `queueguards-${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    // --- The editor: Version Control → Workflow → Merge guards.
    await inv('settings:update', { general: { userName: 'Ann Lee' } })
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await lib.vcSection(page, 'workflow')
    const form = page.locator('.workflow-form')
    const row = form.locator('.workflow-option[data-option="mergeGuards"]')
    await lib.workflowTab(page, 'mergeGuards')
    check('Merge guards is a row of the Workflow section, none by default, saying it is not secret scanning', !!(await until(async () => (await row.count()) === 1 && /No merge guards/.test(await text(row)) && /isn’t secret scanning/.test(await text(row)), HUNG_MS)), await text(row))
    check('…the example guard offered with a name set in Settings → General', (await row.locator('[data-note="name-guard"]').count()) === 1)
    await row.getByRole('button', { name: 'Add Guard', exact: true }).click()
    const g = row.locator('.workflow-guard').first()
    await g.getByLabel('Name', { exact: true }).fill('No secrets')
    // What it already matches in the project (HI-3284's decision): a.txt's first line, as it is typed.
    await g.getByLabel('Pattern (regular expression)').fill('^one$')
    const matches = g.locator('.workflow-guard-matches')
    check('a guard being typed shows what it already matches in the project: how many lines, and where', !!(await until(async () => (await matches.getAttribute('data-matches').catch(() => null)) === '1' && /already matches 1 line in the project/.test(await text(matches)) && /a\.txt:1/.test(await text(matches)), HUNG_MS)), await text(g))
    await shoot(g, 'matches')
    await g.getByLabel('Pattern (regular expression)').fill('(secret')
    await g.getByLabel('What to do instead').fill('Take the secret out.')
    await g.getByLabel('What to do instead').press('Tab')
    check('an invalid pattern shows as a problem before saving, naming the guard', !!(await until(async () => /pattern of merge guard 1 isn’t a regular expression/.test(await text(row)), HUNG_MS)), await text(row))
    await g.getByLabel('Pattern (regular expression)').fill('secret')
    await g.getByLabel('Pattern (regular expression)').press('Tab')
    await g.getByLabel('Skip these paths (e.g. LICENSE, docs/**)').fill('LICENSE, *.{md,markdown}')
    await g.getByLabel('Skip these paths (e.g. LICENSE, docs/**)').press('Tab')
    check('…gone once it is one', !!(await until(async () => (await row.locator('[data-guard-problem]').count()) === 0, HUNG_MS)), await text(row))
    check('…which matches no line in the project now', !!(await until(async () => (await matches.getAttribute('data-matches').catch(() => null)) === '0', HUNG_MS)), await text(g))
    await shoot(row, 'editor')
    const dialog = page.locator('.dialog', { hasText: 'Save Workflow Options' })
    /** Saves the section, through its Save dialog when it asks; the guards as project.json then has them. */
    const save = async (expected) => {
      await until(async () => form.locator('[data-action="save"]').isEnabled(), HUNG_MS)
      await form.locator('[data-action="save"]').click()
      const want = JSON.stringify(expected)
      if (await until(async () => (await dialog.count()) > 0 || JSON.stringify(projectJson().workflow?.options?.mergeGuards) === want, HUNG_MS) && (await dialog.count()) > 0) {
        await dialog.getByRole('button', { name: 'Save', exact: true }).click()
        await dialog.waitFor({ state: 'detached', timeout: HUNG_MS })
      }
      return until(async () => (JSON.stringify(projectJson().workflow?.options?.mergeGuards) === want ? projectJson().workflow.options.mergeGuards : null), HUNG_MS)
    }
    const first = [{ name: 'No secrets', pattern: 'secret', skip: ['LICENSE', '*.{md,markdown}'], message: 'Take the secret out.' }]
    const saved = await save(first)
    check('saved as the project’s own: its name, pattern, skips (a brace glob kept whole) and message', JSON.stringify(saved) === JSON.stringify(first), JSON.stringify(projectJson().workflow?.options?.mergeGuards))
    // A brace glob round-trips through the editor (HR2's round 1, finding 2): shown back as typed, and kept whole when
    // another field is edited and saved.
    const skipBox = g.getByLabel('Skip these paths (e.g. LICENSE, docs/**)')
    check('…the brace glob shown back whole', !!(await until(async () => (await skipBox.inputValue()) === 'LICENSE, *.{md,markdown}', HUNG_MS)), await skipBox.inputValue())
    await g.getByLabel('Name', { exact: true }).fill('No secrets here')
    await g.getByLabel('Name', { exact: true }).press('Tab')
    const again = await save([{ ...first[0], name: 'No secrets here' }])
    check('…another field edited and saved: the brace glob still whole', JSON.stringify(again) === JSON.stringify([{ ...first[0], name: 'No secrets here' }]), JSON.stringify(projectJson().workflow?.options?.mergeGuards))
    await g.getByLabel('Name', { exact: true }).fill('No secrets')
    await g.getByLabel('Name', { exact: true }).press('Tab')
    await save(first)

    // --- A card adding a match comes back from the merge queue.
    const reviewer = await q.agent(fx, h, 'R1')
    check('the reviewer has its token', !!reviewer.token)
    const column = async (n) => (await h.card(n))?.column
    const red = await q.approve(fx, h, reviewer, 'Adds a secret', { 'src.txt': 'fine\nmy secret\n', 'note.md': 'a secret in notes\n' })
    check('a card is approved (start, submit, review, pass)', Object.values(red.steps).every((s) => s.status === 200), JSON.stringify(red.steps))
    const failure = await until(async () => (await h.facts(red.n)).find((f) => f.kind === 'IntegrationFailed') ?? null, HUNG_MS)
    const hits = failure?.data?.guards?.hits ?? []
    check('it comes back as the check "merge guards", the guard, file and line named (*.{md,markdown} skipped)', failure?.data?.reason === 'checks' && failure.data.check === 'merge guards' && hits.length === 1 && hits[0].guard === 'No secrets' && hits[0].file === 'src.txt' && hits[0].line === 2, JSON.stringify(failure?.data))
    check('…back to its builder', !!(await until(async () => (await column(red.n)) === 'doing', HUNG_MS)), String(await column(red.n)))
    const before = q.head(fx)
    check('…the target unmoved', before === lib.git(fx.alpha, ['rev-parse', 'main']).trim())
    const ran = (await h.facts(red.n)).filter((f) => f.kind === 'CheckRan' && f.data.name === 'merge guards')
    check('…recorded as the check "merge guards", failed, with the guards it checked', ran.length === 1 && ran[0].data.result === 'failed' && !!ran[0].data.guardsKey, JSON.stringify(ran.map((r) => r.data)))
    const comment = (await h.facts(red.n)).findLast((f) => f.kind === 'Commented' || f.kind === 'Comment')
    await q.showBoard(page)
    await q.openByTitle(page, red.n)
    const cardDialog = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    await until(async () => (await cardDialog.count()) === 1, HUNG_MS)
    const said = await until(async () => {
      const t = await text(cardDialog)
      return /a merge guard matched lines it adds\. “No secrets” matched 1 line, first in src\.txt:2: Take the secret out\./.test(t) ? t : null
    }, HUNG_MS)
    check('the card says which guard, where, and its message', !!said, comment ? JSON.stringify(comment.data) : await text(cardDialog))
    const said2 = cardDialog.locator('.task-comment').filter({ hasText: 'No secrets' }).last()
    await said2.scrollIntoViewIfNeeded()
    await shoot(said2, 'returned')
    await page.keyboard.press('Escape')
    await until(async () => (await cardDialog.count()) === 0, HUNG_MS)

    // --- A card changing a file that already holds a match merges: only added lines count.
    q.commitOn(fx, 'integration', { 'old.txt': 'an old secret\nline\n' }, 'an old match')
    const ok = await q.approve(fx, h, reviewer, 'Touches the old match', { 'old.txt': 'an old secret\nline\nanother line\n' })
    check('a card is approved (start, submit, review, pass)', Object.values(ok.steps).every((s) => s.status === 200), JSON.stringify(ok.steps))
    check('…a file that already holds a match changed, nothing matching added: merged, Done', !!(await until(async () => (await column(ok.n)) === 'done', HUNG_MS)), JSON.stringify(await h.kinds(ok.n)))
    const passed = (await h.facts(ok.n)).filter((f) => f.kind === 'CheckRan' && f.data.name === 'merge guards')
    check('…its check "merge guards" passed', passed.length === 1 && passed[0].data.result === 'passed', JSON.stringify(passed.map((r) => r.data)))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
