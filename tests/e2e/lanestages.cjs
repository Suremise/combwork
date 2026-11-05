// The Progress panel's P6 changes (#1421, SPEC §16.13's P6 line), on fake Claude Code agents acting by their own tokens,
// the Assistant off: a "Combwork merges" project (queueFixture.cjs's, its user's OK for cards labelled ui) whose lane has a
// card in Review, one Approved (waiting for your OK) and one Merging (its merge check held): each segment's hover and
// accessible name say its stage, in its category's colour, with the divider on Approved and Merging; the legend on the
// Lanes bar by hover and by keyboard (Esc closes it), with a rename; a Solo project's lanes left out of Pulse until one
// runs (the Lanes tab keeps them); the lane header's link to the project's Version Control tab (Workflow) and the queue
// card's (Merge queue). S19: the options changed mid-lane: the lanes and their cards show old rules, a lane's next card
// started after the change keeps the lane's ruleset, Apply to cards in flight clears one card's mark, a rename sets
// nothing, a switch to Solo (other stages) leaves the old-rules lanes their own stages in hovers and the legend, the lane ends and its mark goes, a new lane uses the new options, and with the rules not enforced the marks
// still show and say so. Screenshots in both themes, in English and Japanese. Dev build, throwaway profile, workspace
// and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47814))
const fx = q.queueProject('lanestages')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const waitHung = (fn) => lib.until(fn, HUNG_MS, 150)
const beta = path.join(fx.ws, 'beta')

;(async () => {
  q.prepare(fx)
  lib.gitProject(beta)
  let h = await q.startHive(fx, { port: PORT, keepOptions: true })
  try {
    const { inv } = h
    let page = h.page
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1500, height: 950 })
    // Pair-like, Combwork merges into integration, your OK for cards labelled ui (so one waits in Approved).
    const options = q.queueOptions(fx, { okBefore: { mode: 'labels', labels: ['ui'] } })
    await inv('workflow:setOptions', fx.alpha, { preset: 'pair', options })
    // Solo, its Maximum agents raised to 2 as a user would (HI-2091): beta's two lanes below each add an agent.
    const soloOptions = (await inv('workflow:form', beta)).presets.find((p) => p.id === 'solo')?.options
    await inv('workflow:setOptions', beta, { preset: 'solo', options: { ...soloOptions, maxAgents: 2 } })
    const workspaceToken = JSON.parse(fs.readFileSync(path.join(fx.userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${workspaceToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const startLane = async (project, builder, reviewer, name, cards) => {
      const r = await api('POST', '/v1/lanes', { project, builder, reviewer, name, cards })
      if (r.status !== 200) check(`the lane of ${builder} starts`, false, JSON.stringify(r))
      return r.body?.lane?.id
    }
    const laneNow = async (id) => (await inv('lanes:list')).find((l) => l.id === id)
    const badge = async (n) => (await inv('tasks:workBadges')).find((b) => b.card === n)
    const commitIn = (folder, file, title) => {
      fs.writeFileSync(path.join(folder, file), `${title}\n`)
      lib.git(folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
      lib.git(folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', title])
    }

    // --- A card in each of Review, Approved and Merging, worked outside a lane, then a lane recorded over them.
    const r1 = await q.agent(fx, h, 'R1')
    q.steer(fx, 'wait')
    const m = await q.approve(fx, h, r1, 'Merging card', { 'm.txt': 'm\n' })
    check('Merging: the queue tests its merge (its check held)', !!(await waitHung(() => fs.existsSync(fx.started))) && m.steps.verdict.status === 200, JSON.stringify(m.steps))
    check('…its stage is Merging', !!(await waitHung(async () => (await badge(m.n))?.stage === 'merging')), JSON.stringify(await badge(m.n)))
    const ba = await q.agent(fx, h, 'BA')
    const a = (await inv('tasks:create', { title: 'Approved card', project: 'alpha', labels: ['ui'] })).number
    await q.startCard(fx, h, ba, a)
    commitIn(ba.folder, 'a.txt', 'Approved card')
    await q.intent(h, ba, a, 'submit', { summary: 'ready' })
    await q.intent(h, r1, a, 'start-review')
    const av = await q.intent(h, r1, a, 'verdict', { pass: true, comment: 'passed' })
    check('Approved: passed, waiting for your OK (labelled ui)', av.status === 200 && !!(await waitHung(async () => (await badge(a))?.stage === 'approved')), JSON.stringify(av.body))
    const br = await q.agent(fx, h, 'BR')
    const r = (await inv('tasks:create', { title: 'Review card', project: 'alpha' })).number
    await q.startCard(fx, h, br, r)
    commitIn(br.folder, 'r.txt', 'Review card')
    const rs = await q.intent(h, br, r, 'submit', { summary: 'ready' })
    check('Review: submitted', rs.status === 200 && !!(await waitHung(async () => (await badge(r))?.stage === 'review')), JSON.stringify(rs.body))
    const l1 = await startLane('alpha', `B${m.n}`, 'R1', 'stages', [m.n, a, r])
    // A second lane, its card still to do: started before the options change, it keeps the ruleset of then.
    const bx = await q.agent(fx, h, 'BX')
    const nx = (await inv('tasks:create', { title: 'Next card', project: 'alpha' })).number
    // Held (blocked) until the options change: BX idle, Combwork would start it at once (HI-2029), before the change.
    await inv('tasks:update', nx, { blocked: 'Held until the options change' })
    const l2 = await startLane('alpha', 'BX', 'R1', 'next', [nx])
    check('the lanes are recorded with their rulesets, no old rules yet', !!l1 && !!l2 && (await laneNow(l1))?.oldRules === false && (await laneNow(l2))?.oldRules === false, JSON.stringify(await inv('lanes:list')))

    // --- The window: the Progress panel's Pulse.
    await page.getByText('alpha', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Task Board' }).click()
    const panel = page.locator('.progress-panel')
    if (!(await panel.count())) await page.locator('.progress-rail').click()
    await waitHung(async () => (await panel.count()) === 1)
    const showTab = async (name) => {
      await panel.locator(`.progress-tab[data-tab="${name}"]`).click()
      await waitHung(async () => (await panel.locator(`.progress-tab-${name}`).count()) === 1)
    }
    await showTab('pulse')
    const row = (id) => panel.locator(`.progress-lane[data-lane="${id}"]`)
    const seg = (n) => panel.locator(`.lane-seg[data-card="${n}"]`).first()
    const label = async (n) => (await seg(n).getAttribute('aria-label').catch(() => '')) ?? ''
    // The page's tooltip (the page is another after the restart in Japanese).
    const tips = () => page.locator('.tip')
    const tipText = async () => ((await tips().first().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    const order = () => panel.locator('.progress-lane').evaluateAll((els) => els.map((e) => e.getAttribute('data-lane')))
    /**
     * Hovers `target` until its own tooltip shows `want` (a tooltip shows after its delay). A row that moves after the
     * pointer lands (a lane's row arriving above it: running lanes are newest first) leaves the pointer over another
     * segment, whose tooltip is rightly that one's (HI-2377): then it hovers the target again where it is now.
     */
    const hover = async (target, want) => {
      let other = null
      const shown = await waitHung(async () => {
        await page.mouse.move(5, 5)
        if (!(await lib.until(async () => (await tips().count()) === 0, 5000))) return false
        await target.hover()
        const t = await lib.until(async () => (await tips().count()) > 0 && (await tipText()), 5000)
        if (t && want(t)) return true
        if (t && other === null) other = { tip: t, rows: await order() }
        return false
      })
      if (other) console.log(`INFO hovered again: the tooltip first read was another's (${JSON.stringify(other)})`)
      return shown
    }
    // Both lanes' rows shown before any hover, so neither moves the other's under the pointer (HI-2377).
    check('the lane shows in Pulse', !!(await waitHung(async () => (await row(l1).count()) === 1 && (await row(l2).count()) === 1 && /Merging/.test(await label(m.n)))), await panel.innerText())
    const cls = async (n) => (await seg(n).getAttribute('class')) ?? ''
    check("segments in their category's colour: Merging and Approved green (passed), Review amber", (await cls(m.n)).includes('passed') && (await cls(a)).includes('passed') && (await cls(r)).includes('review'), JSON.stringify([await cls(m.n), await cls(a), await cls(r)]))
    check('accessible names say the stage: Merging, Approved, Review', /· Merging/.test(await label(m.n)) && /· Approved/.test(await label(a)) && /· Review/.test(await label(r)), JSON.stringify([await label(m.n), await label(a), await label(r)]))
    check("the Merging segment's hover: Approved | Merging, the card's own (Merging) marked", !!(await hover(seg(m.n), (t) => t.includes('Merging card') && t.includes('Approved'))) && (await page.locator('.tip .lane-seg-stage.own').innerText()) === 'Merging' && (await page.locator('.tip .lane-stage-divider').count()) === 1, await tipText())
    check("the Approved segment's hover: the divider, Approved its own", !!(await hover(seg(a), (t) => t.includes('Approved card'))) && (await page.locator('.tip .lane-seg-stage.own').innerText()) === 'Approved' && (await page.locator('.tip .lane-seg-stages').count()) === 1, await tipText())
    check("the Review segment's hover: no divider (one stage in its category)", !!(await hover(seg(r), (t) => t.includes('Review card'))) && (await page.locator('.tip .lane-seg-stages').count()) === 0, await tipText())
    const shoot = async (name, show) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await waitHung(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
        if (show) await show()
        await page.screenshot({ path: path.join(fx.shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }
    await shoot('1-approved-hover', () => hover(seg(a), (t) => t.includes('Approved card')))

    // --- The legend: on the Lanes bar's hover, and by keyboard (Esc closes it).
    const bar = panel.locator('.progress-lanes-bar')
    const legend = page.locator('.tip .lanes-legend')
    const legendRow = (c) => page.locator(`.tip .lanes-legend-row[data-category="${c}"]`)
    check("the legend on the Lanes bar's hover: the categories, Approved with Approved and Merging", !!(await hover(bar, (t) => t.includes('Each colour is a category'))) && JSON.stringify(await legendRow('passed').locator('.lanes-legend-stage').allInnerTexts()) === '["Approved","Merging"]' && (await legendRow('passed').locator('.lane-seg.passed').count()) === 1, await tipText())
    // Its swatches stand still, Active's stripes included (#1629: they move on a ::before the legend stops).
    const swatches = await page.locator('.tip .lanes-legend-swatch').evaluateAll((els) => els.map((e) => [e.classList.contains('doing'), getComputedStyle(e, '::before').animationName]))
    check("…its swatches stand still, Active's stripes included", swatches.some(([doing]) => doing) && swatches.every(([, anim]) => anim === 'none'), JSON.stringify(swatches))
    await shoot('2-legend', () => hover(bar, (t) => t.includes('Each colour is a category')))
    await page.mouse.move(5, 5)
    await waitHung(async () => (await tips().count()) === 0)
    // Focused from the keyboard (a key first, so the focus is :focus-visible).
    await page.keyboard.press('Shift')
    await bar.focus()
    check('the legend by keyboard: focusing the bar shows it', !!(await waitHung(async () => (await legend.count()) === 1)))
    await page.keyboard.press('Escape')
    check('…Esc closes it', !!(await waitHung(async () => (await legend.count()) === 0)))
    const described = await bar.evaluate((el) => document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent ?? '')
    check("…screen readers get it as the bar's description", /Approved: Approved and Merging/.test(described), described)

    // --- S19: the options changed mid-lane.
    const changed = { ...options, okBefore: { mode: 'labels', labels: ['ui', 'design'] } }
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: changed })
    check('after the change: both lanes show old rules', !!(await waitHung(async () => (await laneNow(l1))?.oldRules === true && (await laneNow(l2))?.oldRules === true)), JSON.stringify((await inv('lanes:list')).map((l) => [l.id, l.oldRules])))
    check('…and the cards in flight; a card in Todo never', !!(await waitHung(async () => (await badge(m.n))?.oldRules && (await badge(a))?.oldRules && (await badge(r))?.oldRules)) && (await badge(nx))?.oldRules === false, JSON.stringify(await Promise.all([m.n, a, r, nx].map(badge)).then((x) => x.map((b) => b?.oldRules))))
    const tag = (id) => row(id).locator('.progress-lane-state.old-rules')
    check("the lane's row shows its old rules mark, its accessible name saying what it means", !!(await waitHung(async () => (await tag(l1).count()) === 1)) && /keeps them until it ends/.test((await tag(l1).getAttribute('aria-label')) ?? ''), await row(l1).innerText())
    check("…its hover says so", !!(await hover(tag(l1), (t) => t.includes('New lanes and cards use the new options'))), await tipText())
    check("a card's segment says old rules in its accessible name and hover", !!(await waitHung(async () => /Old rules: this card started/.test(await label(r)))) && (await seg(r).getAttribute('data-old-rules')) !== null && !!(await hover(seg(r), (t) => t.includes('Old rules'))), await label(r))
    await shoot('3-old-rules', () => hover(tag(l1), (t) => t.includes('New lanes and cards')))

    // The lane's next card, started after the change, keeps the lane's ruleset (§16.5.4): the one in force before it, as
    // the cards started then have.
    // Unblocked, Combwork starts it on BX, its lane's builder (HI-2029), and the lanes' rows reorder. HI-2052: with the tag's
    // tooltip up and the mouse still, its tag moves from under the mouse; the tooltip closes once the mouse moves, and the
    // next hover's tooltip is the only one.
    check("…the tag's tooltip up before the rows reorder", !!(await hover(tag(l1), (t) => t.includes('New lanes and cards'))), await tipText())
    const at = await tag(l1).boundingBox()
    await inv('tasks:update', nx, { blocked: null })
    check('the rows reorder: the tag moves from under the still mouse', !!(await waitHung(async () => {
      const now = await tag(l1).boundingBox()
      return !!now && !!at && Math.abs(now.y - at.y) > 2
    })), JSON.stringify({ at, now: await tag(l1).boundingBox() }))
    await page.mouse.move(5, 5)
    check('…and its tooltip closes once the mouse moves (HI-2052)', !!(await waitHung(async () => (await tips().count()) === 0)), await tipText())
    check('…the next hover shows one tooltip, its own', !!(await hover(bar, (t) => t.includes('Each colour is a category'))) && (await tips().count()) === 1, String(await tips().count()))
    await page.mouse.move(5, 5)
    await waitHung(async () => (await tips().count()) === 0)
    const started = await waitHung(async () => (await h.facts(nx)).find((x) => x.kind === 'Started') ?? null)
    // Its slot prepared (BX placed there), the work committed in it.
    if (started?.data?.folder && (await waitHung(async () => (await h.facts(nx)).some((x) => x.kind === 'BuilderPlaced')))) commitIn(started.data.folder, 'nx.txt', 'Next card')
    check("the lane's next card, started after the change, keeps the lane's ruleset: old rules", started?.actor === 'combwork' && started?.data?.builder === bx.id && !!started?.ruleset && started.ruleset === (await h.facts(m.n)).find((x) => x.kind === 'Started')?.ruleset && !!(await waitHung(async () => (await badge(nx))?.oldRules === true)), JSON.stringify({ started }))

    // Apply to cards in flight clears one card's mark (another change, given to the Review card).
    const third = { ...changed, okBefore: { mode: 'labels', labels: ['ui', 'design', 'docs'] } }
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: third }, { applyTo: [r] })
    check('Apply to cards in flight: the Review card loses its mark; the others keep theirs', !!(await waitHung(async () => (await badge(r))?.oldRules === false)) && (await badge(a))?.oldRules === true && (await badge(nx))?.oldRules === true, JSON.stringify(await Promise.all([m.n, a, r, nx].map(badge)).then((x) => x.map((b) => b?.oldRules))))
    check("…its segment says so no more", !!(await waitHung(async () => !/Old rules/.test(await label(r)))), await label(r))

    // A rename sets nothing (names aren't in the ruleset), and shows at once: in the segment and the legend.
    const before = (await inv('lanes:list')).map((l) => [l.id, l.oldRules])
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: { ...third, stageNames: { approved: 'Ready' } } })
    check('a rename: the Approved card is shown as Ready', !!(await waitHung(async () => /· Ready/.test(await label(a)))), await label(a))
    check('…no old rules set by it: the Review card still has none, the lanes as they were', (await badge(r))?.oldRules === false && JSON.stringify((await inv('lanes:list')).map((l) => [l.id, l.oldRules])) === JSON.stringify(before), JSON.stringify((await inv('lanes:list')).map((l) => [l.id, l.oldRules])))
    check('…the legend lists the rename', !!(await hover(bar, (t) => t.includes('Ready'))), await tipText())

    // A change of the stages themselves (Solo: no review, nothing merging; HR4's round 1): the lanes and cards under old
    // rules keep their own stages, by the names now.
    const solo = (await inv('workflow:form', fx.alpha)).presets.find((p) => p.id === 'solo')?.options
    await inv('workflow:setOptions', fx.alpha, { preset: 'solo', options: { ...solo, stageNames: { approved: 'Ready' } } })
    check('Solo saved: the project now produces no Approved or Merging', !!(await waitHung(async () => !(await inv('workflow:stages', fx.alpha)).stages.some((x) => x.id === 'merging' || x.id === 'approved'))), JSON.stringify(await inv('workflow:stages', fx.alpha)))
    check('…the lanes keep their own stages (Merging among them)', ((await laneNow(l1))?.stages ?? []).includes('merging') && ((await badge(m.n))?.stages ?? []).includes('merging'), JSON.stringify({ lane: (await laneNow(l1))?.stages, card: (await badge(m.n))?.stages }))
    check("the Merging card's hover keeps Ready | Merging, its own marked", !!(await hover(seg(m.n), (t) => t.includes('Merging card') && t.includes('Ready'))) && (await page.locator('.tip .lane-seg-stage.own').innerText()) === 'Merging' && (await page.locator('.tip .lane-stage-divider').count()) === 1, await tipText())
    check('…and the legend keeps Ready and Merging (an old-rules lane has them)', !!(await hover(bar, (t) => t.includes('Each colour is a category'))) && JSON.stringify(await legendRow('passed').locator('.lanes-legend-stage').allInnerTexts()) === '["Ready","Merging"]', await tipText())
    await shoot('3b-old-rules-solo', () => hover(seg(m.n), (t) => t.includes('Merging card')))

    // The lane ends: its mark goes. A new lane uses the new options.
    const ended = await api('POST', `/v1/lanes/${l1}/end`, { abandoned: true })
    check('the lane ends: its mark goes', ended.status === 200 && !!(await waitHung(async () => (await laneNow(l1))?.oldRules === false && (await tag(l1).count()) === 0)), JSON.stringify(ended))
    const fresh = (await inv('tasks:create', { title: 'Fresh card', project: 'alpha' })).number
    const l3 = await startLane('alpha', `B${m.n}`, 'R1', 'fresh', [fresh])
    check('a new lane uses the new options: no old rules', !!l3 && (await laneNow(l3))?.oldRules === false && !!(await waitHung(async () => (await row(l3).count()) === 1)) && (await tag(l3).count()) === 0, JSON.stringify(await laneNow(l3)))

    // With the rules not enforced, the marks still show (they are facts) and say so.
    await inv('advanced:set', 'cw.workflow.enforce', false)
    check('rules not enforced: the old rules mark still shows, saying they aren’t enforced', !!(await waitHung(async () => (await tag(l2).count()) === 1 && /aren’t enforced now/.test((await tag(l2).getAttribute('aria-label')) ?? ''))), await row(l2).innerText())
    check('…and the card’s line says so too', !!(await waitHung(async () => /Workflow rules aren’t enforced now/.test(await label(nx)))), await label(nx))
    await inv('advanced:set', 'cw.workflow.enforce', true)

    // --- Links: the lane header's project opens its Version Control tab at Workflow; the queue card at Merge queue.
    const link = row(l2).locator('.progress-lane-project')
    check("the lane header names its project, with its accessible name", (await link.innerText()) === 'alpha' && /open its workflow in Version Control/.test((await link.getAttribute('aria-label')) ?? ''), await row(l2).innerText())
    await link.click()
    const section = (id) => page.locator(`[role="tab"][data-section="${id}"][aria-selected="true"]`)
    check("…a click opens alpha's Version Control tab at Workflow", !!(await waitHung(async () => (await section('workflow').count()) === 1)))
    await page.getByRole('button', { name: 'Task Board' }).click()
    await showTab('merges')
    const queueLink = panel.locator('.progress-queue-link').first()
    await waitHung(async () => (await queueLink.count()) === 1)
    await queueLink.click()
    check('the Merges tab’s queue card opens the Merge queue section', !!(await waitHung(async () => (await section('queue').count()) === 1)))
    await page.getByRole('button', { name: 'Task Board' }).click()
    await showTab('pulse')

    // --- Solo: Pulse shows no lanes of beta (preset Solo) unless one runs; the Lanes tab keeps them.
    for (const name of ['S1', 'S2']) await lib.addAgent(inv, beta, { name })
    const bc = (await inv('tasks:create', { title: 'Solo card', project: 'beta' })).number
    const s1 = await startLane('beta', 'S1', null, 'solo', [bc])
    await api('POST', `/v1/lanes/${s1}/end`, { abandoned: true })
    await waitHung(async () => (await laneNow(s1))?.state === 'abandoned')
    check("Solo: Pulse leaves out beta's ended lane", !!(await waitHung(async () => (await row(l3).count()) === 1 && (await row(s1).count()) === 0)), await panel.innerText())
    await showTab('lanes')
    check('…the Lanes tab keeps it', !!(await waitHung(async () => (await row(s1).count()) === 1)))
    check('…the Lanes tab has the legend too', !!(await hover(panel.locator('.progress-lanes-legend'), (t) => t.includes('Each colour is a category'))), await tipText())
    await showTab('pulse')
    const bc2 = (await inv('tasks:create', { title: 'Solo again', project: 'beta' })).number
    const s2 = await startLane('beta', 'S2', null, 'solo running', [bc2])
    check('…a running lane of beta shows in Pulse', !!(await waitHung(async () => (await row(s2).count()) === 1)) && (await row(s1).count()) === 0, await panel.innerText())

    // --- Japanese (a long locale): Combwork started again in it, the same lanes.
    fs.writeFileSync(fx.go, 'go')
    await h.app.close()
    // The lanes' agents were working: Combwork offers to resume them (its restart record), in a notice over Pulse's bar and
    // marks, perhaps more than one as each is decided (HI-1792: the hovers below timed out under it). Answered Don't
    // Resume until the record is gone (nothing left to offer) and no offer shows.
    const restartRecord = path.join(fx.userData, 'restart.json')
    const offered = fs.existsSync(restartRecord)
    h = await q.startHive(fx, { port: PORT, keepOptions: true, env: { CW_LANG: 'ja' } })
    page = h.page
    page.on('pageerror', (e) => check('no page errors (ja)', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1500, height: 950 })
    if (offered) {
      const jaMain = JSON.parse(fs.readFileSync(path.join(lib.ROOT, 'locales', 'ja', 'main.json'), 'utf8'))
      const dontResume = page.locator('.toast').getByRole('button', { name: jaMain['main.restart.dismiss'], exact: true })
      const answered = await waitHung(async () => {
        if (await dontResume.count()) await dontResume.first().click().catch(() => undefined)
        return !fs.existsSync(restartRecord) && (await dontResume.count()) === 0
      })
      // Its outcome then shows for the usual time, counted only while the window is focused (Popups.tsx), and a test
      // window never is: closed with its × as the user would (HI-2370).
      const outcome = page.locator('.toast.resolved .popup-close')
      const closed = await waitHung(async () => {
        if (await outcome.count()) await outcome.first().click().catch(() => undefined)
        return (await outcome.count()) === 0
      })
      check("ja: the offer to resume the lanes' agents answered Don't Resume, and gone", !!answered && !!closed, String(fs.existsSync(restartRecord)))
    }
    await page.getByText('alpha', { exact: true }).first().click()
    const panelJa = page.locator('.progress-panel')
    if (!(await panelJa.count())) await page.locator('.progress-rail').click()
    await waitHung(async () => (await panelJa.count()) === 1)
    await panelJa.locator('.progress-tab[data-tab="pulse"]').click()
    const rowJa = await waitHung(async () => (await panelJa.locator(`.progress-lane[data-lane="${l2}"]`).count()) === 1)
    if (!rowJa) await page.screenshot({ path: path.join(fx.shots, 'ja-no-lane.png') })
    const tagJa = panelJa.locator(`.progress-lane[data-lane="${l2}"] .progress-lane-state.old-rules`)
    check('ja: the old rules mark in Japanese', !!(await waitHung(async () => (await tagJa.innerText().catch(() => '')) === '旧ルール')), await panelJa.innerText().catch(() => ''))
    const barJa = panelJa.locator('.progress-lanes-bar')
    check('ja: the legend in Japanese', !!(await hover(barJa, (t) => t.includes('各色はカテゴリ'))), await tipText())
    const shootJa = async (name, show) => {
      for (const theme of ['dark', 'light']) {
        await h.inv('settings:update', { appearance: { theme } })
        await waitHung(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
        await show()
        await page.screenshot({ path: path.join(fx.shots, `${name}-${theme}.png`) })
      }
    }
    await shootJa('4-ja-legend', () => hover(barJa, (t) => t.includes('各色はカテゴリ')))
    await shootJa('5-ja-old-rules', () => hover(tagJa, (t) => t.includes('旧ルール')))

    // --- pt-BR (#1496): its Todo column is "A\u00a0fazer", its stage "A fazer"; the legend names it once, no stage under it.
    const ptDir = path.join(lib.ROOT, 'locales', 'pt-BR')
    const pt = Object.assign({}, ...fs.readdirSync(ptDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(ptDir, f), 'utf8'))))
    const base = (await h.inv('app:info')).language
    await h.app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language: { ...base, code: 'pt-BR', locale: 'pt-BR', messages: pt } })
    const ptTitle = pt['board.lanes.legendTitle']
    check('pt-BR: the legend in Portuguese', !!(await hover(barJa, (t) => t.includes(ptTitle))), await tipText())
    const todoRow = page.locator('.tip .lanes-legend-row[data-category="todo"]')
    check('pt-BR: the legend\'s Todo row reads "A fazer" once, no stage under it', ((await todoRow.locator('.lanes-legend-name').innerText()).replace(/\s/g, ' ') === 'A fazer') && (await todoRow.locator('.lanes-legend-stage').count()) === 0, await todoRow.innerText().catch(() => ''))
    const single = await page.locator('.tip .lanes-legend-row').evaluateAll((rows) => rows.filter((el) => el.querySelectorAll('.lanes-legend-stage').length === 1).map((el) => el.innerText))
    check('pt-BR: no legend row lists a single stage (its own name again)', single.length === 0, JSON.stringify(single))
    await shootJa('6-pt-BR-legend', () => hover(barJa, (t) => t.includes(ptTitle)))
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
