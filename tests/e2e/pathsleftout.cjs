// Without version control, the user's submit shows what a card's paths leave out (HI-2352, SPEC §16.3.3). In a None
// project under Pair, a started card declares a.txt; a.txt and b.txt change. Dragging it from Active to Review first
// asks "Include files …'s paths leave out?", listing b.txt, nothing recorded; Cancel leaves it in Active; Include It,
// then Cancel on the rules question that follows (its quick check hasn't run), leaves it too; Include It, then Move
// Anyway, submits it with paths a.txt and b.txt, and its Work section shows both files changed. A second card's Leave It
// Out submits only a.txt. Under Solo, the drag to Done is a move, not a submission, so nothing asks. Screenshots of the
// question in both themes, the submitted card's files, and Solo's board. Dev build, fake Claude Code, throwaway profile.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47708))
const fx = q.queueProject('pathsleftout')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const waitHung = (fn) => lib.until(fn, HUNG_MS, 200)

;(async () => {
  q.prepare(fx)
  // Two plain folders (no version control): Pair's and Solo's.
  const pair = path.join(fx.ws, 'nopair')
  const solo = path.join(fx.ws, 'nosolo')
  for (const dir of [pair, solo]) {
    fs.mkdirSync(path.join(dir, '.combwork'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n')
    fs.writeFileSync(path.join(dir, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  }
  const h = await q.startHive(fx, { port: PORT })
  const { page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1500, height: 900 })
    await inv('workspace:refresh')
    for (const [dir, id] of [[pair, 'pair'], [solo, 'solo']]) {
      const options = (await inv('workflow:form', dir)).presets.find((p) => p.id === id)?.options
      // Pair's quick check, given a command: not run, so the drag's submit also asks the rule it skips.
      await inv('workflow:setOptions', dir, { preset: id, options: id === 'pair' ? { ...options, preChecks: ['quick'], commands: { ...options?.commands, quick: `"${fx.tool}"` } } : options })
    }
    const stages = (await inv('workflow:stages', pair))?.stages.map((x) => x.id) ?? []
    check('nopair is None under Pair (a Review stage); nosolo under Solo (none)', stages.includes('review') && !(await inv('workflow:stages', solo))?.stages.some((x) => x.id === 'review'), JSON.stringify(stages))
    const pb = await q.agent(fx, h, 'PB', { project: pair })
    const sb = await q.agent(fx, h, 'SB', { project: solo })
    check('the builders have their tokens', !!(pb.token && sb.token))

    const facts = async (n) => h.facts(n)
    const submitted = async (n) => (await facts(n)).findLast((f) => f.kind === 'Submitted')?.data ?? null
    /** A card started by `who`, declaring a.txt; then a.txt and b.txt change (b.txt is in no card's paths). */
    const startedCard = async (who, project, title) => {
      const n = (await inv('tasks:create', { title, project: path.basename(project) })).number
      const s = await q.intent(h, who, n, 'start')
      const d = await q.intent(h, who, n, 'declare-paths', { paths: ['a.txt'] })
      fs.writeFileSync(path.join(project, 'a.txt'), `a, ${title}\n`)
      fs.writeFileSync(path.join(project, 'b.txt'), `b, ${title}\n`)
      check(`${title}: started, a.txt declared`, s.status === 200 && d.status === 200, JSON.stringify([s.body, d.body]))
      return n
    }

    await page.getByRole('button', { name: 'Task Board' }).click()
    const column = (label) => page.locator('.board-column', { has: page.locator('.board-column-label', { hasText: label }) })
    const tile = (n) => page.locator(`.task-card[data-task="${n}"]`)
    const shownIn = (n) => tile(n).evaluate((e) => e.closest('.board-column')?.getAttribute('data-column') ?? null).catch(() => null)
    // Dragged only once the window shows the card where it is (#1505).
    const drag = async (n, label) => {
      await waitHung(async () => (await shownIn(n)) === (await h.card(n))?.column)
      await tile(n).dragTo(column(label).locator('.board-column-body'))
    }
    const leftOut = page.locator('.dialog', { hasText: 'paths leave out?' })
    const rules = page.locator('.dialog', { hasText: 'anyway?' })
    const themes = async (name, target) => {
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await target.screenshot({ path: path.join(fx.shots, `pathsleftout-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const shown = async (loc) => !!(await waitHung(async () => (await loc.count()) === 1))
    const gone = async (loc) => !!(await waitHung(async () => (await loc.count()) === 0))

    // ===== Pair: asks first, nothing recorded; Cancel leaves it.
    const a = await startedCard(pb, pair, 'Include the notes')
    const key = (await h.card(a)).key
    const before = (await facts(a)).length
    await drag(a, 'Review')
    check('a drag to Review asks what its paths leave out', await shown(leftOut))
    const text = (await leftOut.innerText().catch(() => '')).replace(/\s+/g, ' ')
    check('…naming the card, b.txt, its paths and that a file may be another card’s', text.includes(`Include files ${key}'s paths leave out?`) && text.includes('This file changed since') && text.includes('b.txt') && text.includes('Its paths: a.txt.') && text.includes("may be another card's work or your own") && text.includes('Include It') && text.includes('Leave It Out'), text)
    check('…nothing recorded while it asks', (await facts(a)).length === before && (await h.card(a)).column === 'doing')
    await themes('ask', leftOut)
    await leftOut.getByRole('button', { name: 'Cancel' }).click()
    check('Cancel: the card stays in Active, nothing recorded', (await gone(leftOut)) && (await facts(a)).length === before && !!(await waitHung(async () => (await shownIn(a)) === 'doing')))

    // Include It, then the rules question (its quick check hasn't run): Cancel there leaves it too.
    await drag(a, 'Review')
    await shown(leftOut)
    await leftOut.getByRole('button', { name: 'Include It' }).click()
    check('Include It: then the rules the move skips are asked', await shown(rules), await page.locator('.dialog').innerText().catch(() => ''))
    await rules.getByRole('button', { name: 'Cancel' }).click()
    check('…Cancel there: still in Active, nothing recorded, no paths changed', (await gone(rules)) && (await facts(a)).length === before && (await h.card(a)).column === 'doing')

    // Include It, then Move Anyway: submitted with a.txt and b.txt.
    await drag(a, 'Review')
    await shown(leftOut)
    await leftOut.getByRole('button', { name: 'Include It' }).click()
    await shown(rules)
    await rules.getByRole('button', { name: 'Move Anyway' }).click()
    check('Include It, Move Anyway: the card is in Review', !!(await waitHung(async () => (await h.card(a))?.column === 'review')))
    const subA = await submitted(a)
    check('…submitted with paths a.txt and b.txt, both its change', JSON.stringify(subA?.paths) === JSON.stringify(['a.txt', 'b.txt']) && JSON.stringify((subA?.files ?? []).map((f) => f.path).sort()) === JSON.stringify(['a.txt', 'b.txt']), JSON.stringify(subA))
    // The card dialog's Work section shows what was submitted: both files.
    await tile(a).click()
    const dlg = lib.cardDialog(page, key)
    await shown(dlg)
    const work = dlg.locator('.card-work[data-work="recorded"]')
    const filesBtn = work.locator('.card-work-rev').first().getByRole('button', { name: '2 files changed' })
    check('its Work section says 2 files changed', await shown(filesBtn), await work.innerText().catch(() => ''))
    await filesBtn.click()
    check('…and lists a.txt and b.txt', !!(await waitHung(async () => { const t = await work.locator('.card-work-files').innerText().catch(() => ''); return t.includes('a.txt') && t.includes('b.txt') })))
    await work.scrollIntoViewIfNeeded()
    await themes('included-files', dlg)
    await page.keyboard.press('Escape')
    await gone(dlg)

    // ===== Leave It Out: only a.txt.
    const b = await startedCard(pb, pair, 'Leave the rest')
    await drag(b, 'Review')
    await shown(leftOut)
    await leftOut.getByRole('button', { name: 'Leave It Out' }).click()
    await shown(rules)
    await rules.getByRole('button', { name: 'Move Anyway' }).click()
    check('Leave It Out, Move Anyway: the card is in Review', !!(await waitHung(async () => (await h.card(b))?.column === 'review')))
    const subB = await submitted(b)
    check('…submitted with its paths as they were, a.txt only', JSON.stringify(subB?.paths) === JSON.stringify(['a.txt']) && JSON.stringify((subB?.files ?? []).map((f) => f.path)) === JSON.stringify(['a.txt']), JSON.stringify(subB))
    await tile(b).click()
    const dlgB = lib.cardDialog(page, (await h.card(b)).key)
    await shown(dlgB)
    const workB = dlgB.locator('.card-work[data-work="recorded"]')
    const oneFile = workB.locator('.card-work-rev').first().getByRole('button', { name: '1 file changed' })
    check('…its Work section says 1 file changed: a.txt, not b.txt', (await shown(oneFile)) && !!(await (async () => { await oneFile.click(); return waitHung(async () => { const t = await workB.locator('.card-work-files').innerText().catch(() => ''); return t.includes('a.txt') && !t.includes('b.txt') }) })()), await workB.innerText().catch(() => ''))
    await workB.scrollIntoViewIfNeeded()
    await themes('left-out-files', dlgB)
    await page.keyboard.press('Escape')
    await gone(dlgB)

    // ===== Solo: the drag to Done is a move, not a submission: nothing asks.
    const s = await startedCard(sb, solo, 'Solo notes')
    await drag(s, 'Done')
    check('Solo: a drag to Done asks nothing and the card is Done', !!(await waitHung(async () => (await h.card(s))?.column === 'done')) && (await leftOut.count()) === 0)
    check('…no submission recorded', !(await facts(s)).some((f) => f.kind === 'Submitted'))
    await themes('solo-board', page.locator('.board'))
  } catch (e) {
    check('the run finished', false, e?.stack ?? String(e))
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
