// The Progress panel in P7 (#1446) on fake Claude Code agents, the Assistant off: alpha with each card in its own folder
// (the agent merges), the reviewer pool and one slot (Maximum agents: 1), the slots' setup a script:
// 1. a lane from the window with the pool gets slot-a: its setup runs as "Hive (slot slot-a)", its own entry in the Runs
//    tab's Agent filter; the lane's row reads "B1 / pool · slot-a", and its hover names slot-a, ready, and the card's line;
// 2. the pool's reviewer R1 runs the card's check in its review copy: the run's row reads "AL-1 · <revision> · in copy-1";
//    its details name the copy and the folder it ran in;
// 3. R1 fails the card: the lane's hover names R1's verdict;
// 4. a second lane with no slot free says "waiting for a slot", and its reason opens Branches & remotes.
// Screenshots of the lane's hover and the Runs tab in light and dark, in English and Japanese. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { createIntl } = require('@formatjs/intl')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const at = (x) => path.join(lib.WORK, `lanesslots-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const tools = at('tools')
const shots = at('shots')
const alpha = path.join(ws, 'alpha')
const slotA = path.join(`${ws}.worktrees`, 'alpha', 'slot-a')
const PORT = Number(lib.port(47806))
const identity = { name: 'Combwork Lanes Test', email: 'lanes@example.com' }
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const git = (dir, ...a) => lib.git(dir, a).trim()
const commitIn = (dir, files, message) => {
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text)
  lib.git(dir, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'add', '-A'])
  lib.git(dir, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '-qm', message])
  return git(dir, 'rev-parse', 'HEAD')
}
const lines = (file) => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean)
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, tools, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [tools, shots]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha, { 'a.txt': 'a\n', '.gitignore': '.hive/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  // The identity its commits use, in its git config: G12 reads it from git each time (HI-2266, HI-2283).
  lib.git(alpha, ['config', 'user.name', identity.name])
  lib.git(alpha, ['config', 'user.email', identity.email])
  // The slots' setup (its run is Hive's), and the check the reviewer runs: each records where it ran.
  const setupLog = path.join(tools, 'setup.log')
  const setup = path.join(tools, 'setup.js')
  fs.writeFileSync(setup, `require('fs').appendFileSync(${JSON.stringify(setupLog)}, process.env.CW_SLOT + '\\n')\n`)
  const checkLog = path.join(tools, 'check.log')
  const checkJs = path.join(tools, 'check.js')
  fs.writeFileSync(checkJs, `require('fs').appendFileSync(${JSON.stringify(checkLog)}, process.cwd() + '\\n')\n`)
  const env = lib.fakeClaude(userData, home, [alpha, ws, slotA])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' } })
  const { app, page, inv } = h
  // For the Japanese screenshots, taken in a second start of the same profile (tests run in English, #767).
  let laneId = null
  let runId = null
  void runId
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots', target: 'main', style: 'merge', preChecks: [], mergeChecks: [], identity, okBefore: { mode: 'never', labels: [] }, reviewerMode: 'pool', commands: { quick: `node "${checkJs}"` } } })
    await inv('project:updateConfig', alpha, { slots: { setup: `node "${setup}"` } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const b2 = await lib.addAgent(inv, alpha, { name: 'B2', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    // One slot for the project (its pool is its builders, at most its Maximum agents: HI-2001): a second lane waits for it.
    await lib.setMaxAgents(inv, 1)
    const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
    const launches = () => lines(path.join(home, 'fake-launches.jsonl')).map((l) => JSON.parse(l))
    const tokenOf = async (id) => {
      const sessionId = await until(async () => (await live(id))?.sessionId, HUNG_MS)
      const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
      return hive ? JSON.parse(fs.readFileSync(hive.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    }
    const intent = async (token, n, name, body = {}) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${encodeURIComponent(`#${n}`)}/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const facts = (n) => inv('tasks:facts', n)
    const create = async (title) => (await inv('tasks:create', { title, project: 'alpha' })).number
    const c1 = await create('Slot row')
    const c3 = await create('Second lane')
    const key1 = (await card(c1)).key

    // --- 1. A lane with the pool, lent slot-a: its setup is Hive's run, "Hive (slot slot-a)".
    const first = await inv('lanes:start', alpha, { builder: b1.id, reviewer: null, pool: true, cards: [c1] })
    check('the lane is lent slot-a', first.slot === 'slot-a', JSON.stringify(first))
    const warm = await until(async () => (await inv('progress:snapshot')).runs.find((r) => r.defaultName === 'slot' && r.slot === 'slot-a'), HUNG_MS)
    check("slot-a's setup is a run of Combwork's for slot-a", !!warm && warm.source === 'hive', JSON.stringify(warm))
    await page.locator('.progress-rail').click().catch(() => undefined)
    const panel = page.locator('.progress-panel')
    await until(async () => (await panel.count()) === 1, HUNG_MS)
    const tab = (t) => panel.locator(`.progress-tab[data-tab="${t}"]`)
    await tab('runs').click()
    const agentFilter = panel.locator('select[aria-label="Agent"]')
    const agentChoices = async () => agentFilter.locator('option').allInnerTexts().catch(() => [])

    await tab('lanes').click()
    const row = panel.locator(`.progress-lane[data-lane="${first.lane.id}"]`)
    const top = row.locator('.progress-lane-top')
    const topText = async () => ((await top.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    check('the lane row reads "B1 / pool · slot-a"', !!(await until(async () => (await topText()).includes('B1 / pool· slot-a') || (await topText()).includes('B1 / pool · slot-a'), HUNG_MS)), await topText())

    // B1 starts the card: its line is made in slot-a; the row's hover names the slot, ready, on that line.
    const tb1 = await tokenOf(b1.id)
    check("B1 starts the card in slot-a", (await intent(tb1, c1, 'start')).status === 200)
    const line = await until(async () => (await facts(c1)).find((f) => f.kind === 'Started')?.data?.line, HUNG_MS)
    await until(() => git(slotA, 'branch', '--show-current') === line, HUNG_MS)
    const rev = commitIn(slotA, { 'one.txt': 'one\n' }, 'Slot row')
    check('B1 submits it', (await intent(tb1, c1, 'submit', { summary: 'Slot row: ready' })).status === 200)
    const tip = page.locator('.tip', { has: page.locator('[data-testid="lane-slot"]') })
    const hoverTop = async (has) => {
      await page.mouse.move(0, 0)
      await top.hover({ position: { x: 20, y: 6 } })
      return until(async () => {
        const t = await tip.innerText().catch(() => '')
        if (has(t)) return t
        await top.hover({ position: { x: 20, y: 6 } })
        return null
      }, HUNG_MS)
    }
    const slotTip = await hoverTop((t) => t.includes('slot-a ready · lent to the lane since') && t.includes(`On ${line}`))
    check("the row's hover names slot-a, ready, lent to the lane, and the card's line", !!slotTip, await tip.innerText().catch(() => ''))

    // --- 2. The pool gives the card to R1; R1 runs the check in its review copy.
    const assigned = await until(async () => (await facts(c1)).find((f) => f.kind === 'ReviewerAssigned')?.data?.reviewer, HUNG_MS)
    check('the pool gives the card to R1', assigned === r1.id, String(assigned))
    const tr1 = await tokenOf(r1.id)
    let started = await intent(tr1, c1, 'start-review')
    // Under load the copy's setup can outlast start review's first wait: it answers "Waiting for a review copy" and Hive
    // tells R1 later (HI-1955). Once copy-1 is leased to R1 for the card, starting again answers with its folder.
    if ((started.body?.data?.reviewCopy ?? '').startsWith('Waiting for a review copy')) {
      await until(async () => (await inv('copies:list', alpha)).some((c) => c.name === 'copy-1' && c.state === 'leased' && c.lease?.kind === 'review' && c.lease.card === c1 && c.lease.agent === r1.id && !c.lease.returned), HUNG_MS)
      started = await intent(tr1, c1, 'start-review')
    }
    const copy = (started.body?.data?.reviewCopy ?? '').match(/Review in (.+?) at /)?.[1] ?? null
    check('R1 reviews in copy-1', started.status === 200 && !!copy && copy.endsWith('copy-1'), JSON.stringify(started.body))
    await until(async () => ['ready', 'finished'].includes((await live(r1.id))?.status), HUNG_MS)
    // Typed again if a wake of Hive's disturbed it (lib.typeLine, #1560).
    await lib.typeLine(inv, lib.ptyKey(alpha, r1.id), home, null, `shell: cd /d "${copy}" && hive-progress --check quick`, { live: () => live(r1.id) })
    const checkRun = await until(async () => (await inv('progress:snapshot')).runs.find((r) => r.check === 'quick' && r.card === c1 && r.copy === 'copy-1' && r.state !== 'running'), HUNG_MS)
    check("the check ran in copy-1, linked to the card and its revision", !!checkRun && checkRun.revision === rev && same(lines(checkLog).at(-1), copy), JSON.stringify({ checkRun, ran: lines(checkLog) }))
    await tab('runs').click()
    // HI-1710: copy-1's set-up run is R1's (its lease held the copy), never "Hive (copy copy-1)".
    const copyWarm = (await inv('progress:snapshot')).runs.find((r) => r.source === 'hive' && r.copy === 'copy-1')
    check("copy-1's set-up run is credited to R1, in copy-1", !!copyWarm && copyWarm.agentId === r1.id && copyWarm.agentName === 'R1' && !copyWarm.defaultName, JSON.stringify(copyWarm))
    check('the Runs tab’s Agent filter has "Combwork (slot slot-a)" and R1 once, and no "Combwork (copy …)"', !!(await until(async () => {
        const choices = await agentChoices()
        return ['Combwork (slot slot-a)', 'R1'].every((x) => choices.includes(x)) && choices.filter((x) => x === 'R1').length === 1 && !choices.some((x) => x.startsWith('Combwork (copy'))
      }, HUNG_MS)), JSON.stringify(await agentChoices()))
    const runRow = panel.locator(`.progress-tab-runs [data-run="${checkRun?.id}"]`)
    // In its card's runs (HI-1701), opened: closed once they all passed. What it ran for and where is in its hover.
    await until(async () => {
      if ((await runRow.count()) === 1) return true
      for (const t of await panel.locator('.progress-tab-runs .progress-card-toggle[aria-expanded="false"], .progress-tab-runs .progress-group-head[aria-expanded="false"]').all()) await t.click().catch(() => undefined)
      return false
    }, HUNG_MS)
    const forLine = `${key1} · ${rev.slice(0, 7)} · in copy-1`
    const forTip = await lib.hoverTip(page, runRow.locator('.progress-recent > .tip-wrap').first(), (t) => t.includes(forLine), HUNG_MS)
    check(`its hover reads "${forLine}"`, forTip.includes(forLine), forTip)
    await page.mouse.move(5, 5)
    await runRow.locator('.progress-recent').click()
    const details = runRow.locator('.progress-details')
    const detailsText = async () => ((await details.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    check('…its details name the copy and the folder it ran in', !!(await until(async () => (await detailsText()).includes('Copycopy-1') && (await detailsText()).includes(copy), HUNG_MS)), await detailsText())
    runId = checkRun?.id ?? null
    await shoot('runs', panel)

    // HI-1710: Branches & remotes lists copy-1 as Hive's, in its group, saying R1 reviews the card there; never unused.
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('[role="tab"][data-section="branches"]').click()
    const copyRow = page.locator('.git-worktree[data-hive="copy"]')
    const copyLine = `copy-1: R1 reviewing ${key1} at ${rev.slice(0, 7)}`
    check(`Branches & remotes lists copy-1 under "Review copies (Combwork’s)": "${copyLine}"`, !!(await until(async () => (await page.locator('[data-worktrees="copies"]').count()) === 1 && ((await copyRow.textContent().catch(() => '')) ?? '').includes(copyLine), HUNG_MS)), await copyRow.allInnerTexts().catch(() => []))
    check('…with no button, and not among the worktrees', (await copyRow.locator('button').count()) === 0 && (await page.locator('.git-worktree:not([data-hive])', { hasText: 'copy-1' }).count()) === 0)
    await shoot('branches-copies', page.locator('.git-branches'))

    // --- 3. R1 fails it: the lane's hover names R1's verdict.
    check('R1 fails it', (await intent(tr1, c1, 'verdict', { pass: false, comment: 'Slot row: one thing to fix' })).status === 200)
    await tab('lanes').click()
    const poolTip = await hoverTop((t) => t.includes('Last verdict: R1, failed'))
    check("the lane's hover names the reviewer of the last verdict", !!poolTip, await tip.innerText().catch(() => ''))
    laneId = first.lane.id
    await shoot('lane-hover', null, () => hoverTop((t) => t.includes('Last verdict')))

    // --- 4. A second lane, no slot free: "waiting for a slot", its reason a link to Branches & remotes.
    const second = await inv('lanes:start', alpha, { builder: b2.id, reviewer: null, pool: true, cards: [c3] })
    check('a second lane waits for a slot', !!second.waitingForSlot, JSON.stringify(second))
    const why = panel.locator(`.progress-lane[data-lane="${second.lane.id}"] .progress-lane-why`)
    check('…its row says "waiting for a slot"', !!(await until(async () => ((await why.textContent().catch(() => '')) ?? '') === 'waiting for a slot', HUNG_MS)), await why.textContent().catch(() => ''))
    await why.click()
    check('…which opens Branches & remotes, slot-a listed', !!(await until(async () => (await page.locator('button[role="tab"][data-section="branches"][aria-selected="true"]').count()) === 1 && (await page.locator('[data-slot="slot-a"]').count()) > 0, HUNG_MS)))
    // R1's verdict handed copy-1 back: read again once it is, it is idle in the pool.
    const handedBack = await until(async () => (await inv('copies:list', alpha)).find((c) => c.name === 'copy-1' && (!c.lease || c.lease.returned)), HUNG_MS)
    check('…R1’s verdict hands copy-1 back', !!handedBack, JSON.stringify(await inv('copies:list', alpha)))
    const reread = page.locator('[data-action="reload-branches"]')
    await until(async () => !(await reread.locator('.spin, [class*="spin"]').count()), HUNG_MS)
    await reread.click()
    check('…copy-1, read again, idle in the pool', !!(await until(async () => ((await page.locator('.git-worktree[data-hive="copy"]').textContent().catch(() => '')) ?? '').includes('copy-1: idle in the pool'), HUNG_MS)), await page.locator('.git-worktree[data-hive="copy"]').allInnerTexts().catch(() => []))
    await shoot('branches-idle', page.locator('.git-branches'))

    /** Screenshots in both themes (English): `target` (null: the window, its hover made again by `show`). */
    async function shoot(name, target, show) {
      await shots2(page, inv, 'en', name, target, show)
    }
  } catch (err) {
    check('no unexpected error', false, err.stack)
  } finally {
    await app.close().catch(() => undefined)
  }

  // --- The same in Japanese: the profile started again with HIVE_LANG=ja; the lane's hover and the copy's run.
  if (laneId && runId && !failed) {
    // B1 was in a running lane as the first start quit, so the quit recorded it to resume (restart.json in the profile)
    // and this start would offer it: that toast, shown or not depending on the reload, covered the lane row (HI-1955).
    // Resuming isn't this pass's subject: it starts with nothing to resume.
    fs.rmSync(path.join(userData, 'restart.json'), { force: true })
    const ja = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off', HIVE_LANG: 'ja' } })
    try {
      ja.page.on('pageerror', (e) => check('no page errors (ja)', false, e.message))
      await lib.openWorkspace(ja.inv, ja.page, ws)
      // The window asked for its runs before the workspace was open: shown again, it reads the runs kept from the first start.
      await ja.page.reload()
      await lib.appReady(ja.page)
      const until = (fn, ms) => lib.until(fn, ms, 250)
      // The Japanese texts from the catalogue, not literals (#1597: a translation fix broke "copy-1 内"): `jaPieces` gives a
      // message formatted with `values`, split around those passed as null (a name or date the hover fills in).
      const jaDir = path.join(lib.ROOT, 'locales', 'ja')
      const jaIntl = createIntl({ locale: 'ja', messages: Object.assign({}, ...fs.readdirSync(jaDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(jaDir, f), 'utf8')))) })
      const jaPieces = (id, values) => jaIntl.formatMessage({ id }, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v ?? '\u0000']))).split('\u0000').filter(Boolean)
      await ja.page.locator('.progress-rail').click().catch(() => undefined)
      const panel = ja.page.locator('.progress-panel')
      await until(async () => (await panel.count()) === 1, HUNG_MS)
      await panel.locator('.progress-tab[data-tab="lanes"]').click()
      const top = panel.locator(`.progress-lane[data-lane="${laneId}"] .progress-lane-top`)
      // Its slot ready and the pool's last verdict, in Japanese.
      const wantPieces = [...jaPieces('board.lanes.slotTip', { state: 'ready', carried: 'no', since: null }), ...jaPieces('board.lanes.poolLastVerdict', { name: 'R1', pass: 'no' })]
      const want = (t) => wantPieces.every((p) => t.includes(p))
      const hover = async () => want(await lib.hoverTip(ja.page, top, want, HUNG_MS))
      check('ja: the lane’s hover shows its slot and the pool’s last verdict', await hover(), JSON.stringify(wantPieces))
      await shots2(ja.page, ja.inv, 'ja', 'lane-hover', null, hover)
      await panel.locator('.progress-tab[data-tab="runs"]').click()
      // Its copy's check, kept from the first start.
      // In its card's runs (HI-1701), opened; "in copy-1" in its hover.
      const row = panel.locator(`.progress-tab-runs .progress-recent-item[data-run="${runId}"]`)
      const listed = await until(async () => {
        if ((await row.count()) === 1) return true
        for (const t of await panel.locator('.progress-tab-runs .progress-card-toggle[aria-expanded="false"], .progress-tab-runs .progress-group-head[aria-expanded="false"]').all()) await t.click().catch(() => undefined)
        return false
      }, HUNG_MS)
      const inCopy = jaPieces('board.progress.inCopy', { copy: 'copy-1' }).join('')
      const jaTip = listed ? await lib.hoverTip(ja.page, row.locator('.progress-recent > .tip-wrap').first(), (t) => t.includes(inCopy), HUNG_MS) : ''
      check('ja: the copy’s run is listed, "in copy-1" in Japanese in its hover', !!listed && jaTip.includes(inCopy), JSON.stringify({ tip: jaTip, shown: await panel.locator('.progress-runs-body').innerText().catch(() => ''), kept: (await ja.inv('progress:snapshot')).runs.map((r) => [r.title, r.copy, r.state]) }))
      await ja.page.mouse.move(5, 5)
      await row.locator('.progress-recent').click()
      await shots2(ja.page, ja.inv, 'ja', 'runs', panel)
    } catch (err) {
      check('no unexpected error (ja)', false, err.stack)
    } finally {
      await ja.app.close().catch(() => undefined)
    }
  }

  /** Screenshots of `target` (null: the window) in both themes, `show` making its hover again after each repaint. */
  async function shots2(pg, invoke, lang, name, target, show) {
    for (const theme of ['dark', 'light']) {
      await invoke('settings:update', { appearance: { theme } })
      await lib.until(async () => (await pg.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS, 250)
      if (show) await show()
      await (target ?? pg).screenshot({ path: path.join(shots, `${name}-${lang}-${theme}.png`) })
    }
    await invoke('settings:update', { appearance: { theme: 'dark' } })
  }
  console.log(`Screenshots: ${shots}`)
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
