// The reviewer pool (#1443, G17: Reviewers, a shared pool) on fake Claude Code agents, the Assistant off:
// 1. alpha (Each card in its own folder, the agent merges) from Combwork's Team 6 + pool template, trimmed to two builders
//    and its two pooled reviewers, and an either-role agent E1: Start Lane offers the reviewer pool, preselected; three
//    lanes start with it (B1's, B2's and E1's), only their builders starting. Submitted in order, B1's card goes to
//    R1 and B2's to R2 (oldest first, a different reviewer each, both started for the review in the project folder and
//    told); E1's, the third, waits until R1's verdict frees it, and never goes to E1; B2's next card waits while E1 is
//    building in a slot (its lane's lease), and goes to E1 once E1's card is Done and its lane's lease ended.
// 2. beta (Everyone in the project folder, Committed is done, two reviewers per card): one card reviewed by both pooled
//    reviewers in turn, each in a review copy at the submitted revision, then Done.
// 3. gamma (HI-2046, one reviewer per lane): a card started on its builder alone and submitted outside a lane goes to
//    the project's stopped reviewer, started for it and told, with no Assistant step; its verdict makes it Done.
// 4. delta (HI-2321): a pool lane's design checked by one reviewer and its revision by another (the first reviewing
//    another card meanwhile, which holds it; its watch doesn't, HI-2333): the first, out of the card's loop, isn't
//    flagged as not watching when it ends with no watch; the card's reviewer now is.
// 5. epsilon (HI-2333, the cli project's stall on rc.19): its one pooled reviewer, watching a card in its loop, is still
//    free: given the card's revised design and then its submission, each told once and read.
// 6. zeta (HI-2559, the cli project's stall on 5 Nov): its one pooled reviewer, its card held on its own question to
//    the user, is free for the other lane's card: given its waiting design and then its submission, each told once.
// Screenshots of Start Lane with the pool chosen and of the lane's row, in both themes; the builder's brief as text.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const at = (x) => path.join(lib.WORK, `reviewerpool-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const shots = at('shots')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const gamma = path.join(ws, 'gamma')
const delta = path.join(ws, 'delta')
const epsilon = path.join(ws, 'epsilon')
const zeta = path.join(ws, 'zeta')
const slotsRoot = path.join(`${ws}.worktrees`, 'alpha')
const PORT = Number(lib.port(47805))
const identity = { name: 'Hive Pool Test', email: 'pool@example.com' }
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const git = (dir, ...a) => lib.git(dir, a).trim()
const commitIn = (dir, files, message, trailer) => {
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text)
  lib.git(dir, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'add', '-A'])
  lib.git(dir, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '-qm', message, ...(trailer ? ['-m', `Hive-Card: ${trailer}`] : [])])
  return git(dir, 'rev-parse', 'HEAD')
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  for (const p of [alpha, beta, gamma, delta, epsilon, zeta]) {
    lib.gitProject(p, { 'a.txt': 'a\n', '.gitignore': '.combwork/\n' })
    lib.git(p, ['branch', '-M', 'main'])
    // The identity its commits use, in its git config: G12 reads it from git each time (HI-2266, HI-2283).
    lib.git(p, ['config', 'user.name', identity.name])
    lib.git(p, ['config', 'user.email', identity.email])
  }
  const env = lib.fakeClaude(userData, home, [alpha, beta, gamma, delta, epsilon, zeta, ws, ...['slot-a', 'slot-b', 'slot-c', 'slot-d'].map((s) => path.join(slotsRoot, s))])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off', HIVE_TEST_LOOP_GRACE_MS: '2000' } })
  const { app, page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    // alpha: Pair's review with the agent merging, cards in slots, and the reviewer pool (G17, set as the Assistant would).
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots', target: 'main', style: 'merge', preChecks: [], mergeChecks: [], identity, okBefore: { mode: 'never', labels: [] }, reviewerMode: 'pool' } })
    check("alpha's rules have the pool", (await inv('workflow:form', alpha))?.options?.reviewerMode === 'pool')

    // --- Combwork's Team 6 + pool, trimmed to two builders and its two reviewers; an either-role agent beside them.
    const plan = await inv('templates:plan', alpha, 'hive', 'team-6-pool.json')
    check('Team 6 + pool suggests the pool', plan.reviewerMode === 'pool', JSON.stringify(plan.reviewerMode))
    await inv('templates:load', alpha, 'hive', 'team-6-pool.json', plan.remove.map((a) => a.id))
    const agentsOf = async (p) => (await inv('workspace:refresh'))?.projects.find((x) => same(x.path, p))?.agents ?? []
    let agents = await agentsOf(alpha)
    const named = (re) => agents.filter((a) => re.test(a.name))
    for (const extra of named(/-B[3-6]$/)) await inv('agents:remove', alpha, extra.id, { deleteWorktree: false })
    const e1 = await lib.addAgent(inv, alpha, { name: 'E1', workflowRole: 'either' })
    agents = await agentsOf(alpha)
    const [b1, b2] = named(/-B[12]$/)
    const [r1, r2] = named(/-R[12]$/)
    check('two builders, two pooled reviewers and E1', !!b1 && !!b2 && !!r1 && !!r2 && agents.length === 5 && r1.workflowRole === 'reviewer' && r2.workflowRole === 'reviewer', JSON.stringify(agents.map((a) => [a.name, a.workflowRole])))
    const info = await inv('lanes:startInfo', alpha)
    check('Start Lane offers the pool: the agents whose role reviews', JSON.stringify((info.pool ?? []).map((a) => a.name)) === JSON.stringify([r1.name, r2.name, 'E1']), JSON.stringify(info))

    const live = async (p, id) => (await inv('session:live')).find((s) => same(s.projectPath, p) && s.agentId === id) ?? null
    const launches = () => {
      const f = path.join(home, 'fake-launches.jsonl')
      const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    }
    /** The agent's running session's Agent API token (its launch's). */
    const tokenOf = async (p, id) => {
      const sessionId = await until(async () => (await live(p, id))?.sessionId, HUNG_MS)
      const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
      return hive ? JSON.parse(fs.readFileSync(hive.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    }
    const intent = async (token, n, name, body = {}) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${encodeURIComponent(`#${n}`)}/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const deliveries = async (project, agent) => {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/v1/projects/${project}/agents/${encodeURIComponent(agent)}/deliveries?limit=10`, { headers: { Authorization: `Bearer ${workspaceToken}` } })).json()
      return (v.items ?? v.deliveries ?? []).map((d) => d.body ?? d.text ?? '')
    }
    /** An agent's deliveries in full (their text and state: `received` once it read it with cw_inbox). */
    const deliveryRows = async (project, agent) => {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/v1/projects/${project}/agents/${encodeURIComponent(agent)}/deliveries?limit=20`, { headers: { Authorization: `Bearer ${workspaceToken}` } })).json()
      return (v.items ?? v.deliveries ?? []).map((d) => ({ text: d.body ?? d.text ?? '', state: d.state }))
    }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const facts = (n) => inv('tasks:facts', n)
    const assigned = async (n) => (await facts(n)).filter((f) => f.kind === 'ReviewerAssigned').map((f) => f.data.reviewer)
    const factAt = async (n, kind) => (await facts(n)).findLast((f) => f.kind === kind)?.at ?? null
    const lane = async (id) => (await inv('lanes:list', { all: true })).find((l) => l.id === id)
    const slotOf = async (laneId) => (await inv('slots:list', alpha)).find((s) => s.lease?.lane === laneId)
    const create = async (p, title) => (await inv('tasks:create', { title, project: path.basename(p) })).number
    const idle = (p, id) => until(async () => ['ready', 'finished'].includes((await live(p, id))?.status), HUNG_MS)
    const shoot = async (name, target) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await target.screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }
    /** An agent's turn held until the test says so ("holduntil"): it isn't free meanwhile. */
    const hold = async (p, id, file) => {
      await idle(p, id)
      // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
      await lib.typeLine(inv, lib.ptyKey(p, id), home, null, `holduntil ${file}`, { live: () => live(p, id) })
      return until(async () => (await live(p, id))?.status === 'working', HUNG_MS)
    }

    const a = await create(alpha, 'Pool A')
    const b = await create(alpha, 'Pool B')
    const e = await create(alpha, 'Pool E')
    const d = await create(alpha, 'Pool D')

    // --- Start Lane from the window: the pool offered and chosen for an unpaired builder.
    await page.getByRole('button', { name: 'Task Board' }).click()
    const column = (label) => page.locator('.board-column', { has: page.locator('.board-column-header', { hasText: label }) })
    await until(async () => (await column('Todo').locator('.task-card').count()) >= 4, HUNG_MS)
    await column('Todo').locator('.task-card', { hasText: (await card(a)).key }).click({ button: 'right' })
    const item = (label) => page.locator('.menu[role="menu"] .menu-item', { hasText: label })
    await until(async () => (await item('Start Lane with It…').count()) === 1, HUNG_MS)
    await item('Start Lane with It…').click()
    const dialog = page.locator('.dialog', { hasText: 'Start Lane' })
    const reviewerChoice = () => dialog.locator('#lane-start-reviewer').inputValue().catch(() => '')
    check('Start Lane opens with the pool chosen', !!(await until(async () => (await dialog.count()) === 1 && (await reviewerChoice()) === '*pool', HUNG_MS)), await reviewerChoice())
    const poolLabel = await dialog.locator('#lane-start-reviewer option[value="*pool"]').textContent()
    check('…named with its reviewers', poolLabel === `The reviewer pool (${r1.name}, ${r2.name}, and E1)`, String(poolLabel))
    await dialog.locator('#lane-start-builder').selectOption(b1.id)
    await until(async () => (await reviewerChoice()) === '*pool', HUNG_MS)
    await shoot('startlane-pool', dialog)
    await dialog.getByRole('button', { name: 'Start Lane' }).click()
    check('the dialog closes', !!(await until(async () => (await dialog.count()) === 0, HUNG_MS)), await dialog.locator('.dialog-error, .error').innerText().catch(() => ''))
    const l1 = await until(async () => (await inv('lanes:list')).find((l) => l.builder.id === b1.id && l.state !== 'ended'), HUNG_MS)
    check("B1's lane is the pool's, with no reviewer of its own", !!l1 && l1.pool === true && l1.reviewer === null, JSON.stringify(l1))
    const brief = await until(async () => (await deliveries('alpha', b1.name)).find((x) => /builder of a lane/.test(x)), HUNG_MS)
    fs.writeFileSync(path.join(shots, 'brief-builder.txt'), brief ?? '')
    check("B1's brief: reviewed by the pool, naming its reviewers", !!brief && brief.includes(`reviewed by the pool (${r1.name}, ${r2.name} and E1)`), String(brief).slice(0, 500))
    check('…and only B1 started', !(await live(alpha, r1.id)) && !(await live(alpha, r2.id)) && !(await live(alpha, e1.id)))
    // B2's through the Agent API (HI-1581: the Assistant's cw_lane start with pool, here as a script): refused with a
    // reviewer of its own, then started as Start Lane's is, its builder alone.
    const lanesApi = async (body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/lanes`, { method: 'POST', headers: { Authorization: `Bearer ${workspaceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const withReviewer = await lanesApi({ project: 'alpha', builder: b2.name, reviewer: r1.name, pool: true, cards: [b, e] })
    check('a pool lane through the API with a reviewer of its own is refused (HI-1581)', withReviewer.status === 400 && /no reviewer of its own/.test(withReviewer.body?.error ?? ''), JSON.stringify(withReviewer))
    const viaApi = await lanesApi({ project: 'alpha', builder: b2.name, pool: true, cards: [b, e] })
    const l2 = viaApi.body?.lane
    check("…with pool: true, B2's lane is the pool's and B2 alone starts, in its slot (HI-1581)", viaApi.status === 200 && l2?.pool === true && l2?.reviewer === null && new RegExp(`Started ${b2.name} with the lane's brief, in slot-`).test(viaApi.body?.note ?? '') && !!(await until(() => live(alpha, b2.id), HUNG_MS)), JSON.stringify(viaApi))
    const l3 = (await inv('lanes:start', alpha, { builder: e1.id, reviewer: null, pool: true, cards: [d] })).lane
    check("B2's and E1's lanes start on the pool", l2.pool === true && l3.pool === true, JSON.stringify([l2, l3]))
    const panel = page.locator('.progress-panel')
    await page.locator('.progress-rail').click().catch(() => undefined)
    const row = panel.locator(`.progress-lane[data-lane="${l1.id}"]`)
    check("the lane's row names the pool", !!(await until(async () => new RegExp(`${b1.name} / pool`).test((await row.textContent().catch(() => '')) ?? ''), HUNG_MS)), await row.textContent().catch(() => ''))
    await shoot('lane-pool', row)

    /** A builder's card started in its lane's slot, committed there and submitted; the slot's folder. */
    const build = async (agent, laneId, n, file) => {
      const token = await tokenOf(alpha, agent.id)
      const s = await intent(token, n, 'start')
      const slot = await until(() => slotOf(laneId), HUNG_MS)
      const line = await until(async () => (await facts(n)).find((f) => f.kind === 'Started')?.data?.line, HUNG_MS)
      await until(() => git(slot.folder, 'branch', '--show-current') === line, HUNG_MS)
      commitIn(slot.folder, { [file]: `${file}\n` }, `${file} done`)
      const sub = await intent(token, n, 'submit', { summary: `${file}: ready` })
      return { ok: s.status === 200 && sub.status === 200 && !!(await until(async () => (await card(n))?.column === 'review', HUNG_MS)), line, slot, why: JSON.stringify({ s: s.body, sub: sub.body }) }
    }
    /** A builder merges its approved card into main and reports it: Done. */
    const merged = async (agent, n, line) => {
      git(alpha, '-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'merge', '-q', '--no-ff', '-m', `Merge ${line}`, line)
      const r = await intent(await tokenOf(alpha, agent.id), n, 'report-merge')
      return (r.status === 200 || r.body?.rule === 'move.notFromHere') && !!(await until(async () => (await card(n))?.column === 'done', HUNG_MS))
    }

    // --- 1. Submitted in order: A to R1, B to R2, each started for the review in the project folder and told.
    const ba = await build(b1, l1.id, a, 'a1.txt')
    check('B1 builds and submits A in its slot', ba.ok, ba.why)
    check('A goes to the first free reviewer', !!(await until(async () => JSON.stringify(await assigned(a)) === JSON.stringify([r1.id]), HUNG_MS)), JSON.stringify(await assigned(a)))
    const bb = await build(b2, l2.id, b, 'b1.txt')
    check('B2 builds and submits B', bb.ok, bb.why)
    check('B goes to the other reviewer', !!(await until(async () => JSON.stringify(await assigned(b)) === JSON.stringify([r2.id]), HUNG_MS)), JSON.stringify(await assigned(b)))
    for (const [r, n] of [[r1, a], [r2, b]]) {
      const s = await until(() => live(alpha, r.id), HUNG_MS)
      check(`${r.name} is started for the review, in the project folder`, !!s && same(s.cwd, alpha), JSON.stringify(s))
      const told = await until(async () => (await deliveries('alpha', r.name)).find((x) => x.includes('you review it from the pool')), HUNG_MS)
      check(`…and told of ${(await card(n)).key}, once`, !!told && told.includes((await card(n)).key) && (await deliveries('alpha', r.name)).filter((x) => x.includes('from the pool')).length === 1, JSON.stringify(await deliveries('alpha', r.name)))
    }
    const tr1 = await tokenOf(alpha, r1.id)
    const tr2 = await tokenOf(alpha, r2.id)

    // --- E1's card, the third: nobody free (R1 and R2 reviewing, E1 its builder), so it waits.
    const bd = await build(e1, l3.id, d, 'd1.txt')
    check('E1 builds and submits D', bd.ok, bd.why)
    check("D's lane waits for a reviewer", !!(await until(async () => (await lane(l3.id))?.status?.reason === 'reviewer', HUNG_MS)), JSON.stringify((await lane(l3.id))?.status))
    await idle(alpha, r1.id)
    const va = (await intent(tr1, a, 'start-review')).status === 200 && (await intent(tr1, a, 'verdict', { pass: true, comment: 'A: passed' })).status === 200
    check("R1 passes A", va)
    check("R1's verdict frees it: D goes to R1, never to E1", !!(await until(async () => JSON.stringify(await assigned(d)) === JSON.stringify([r1.id]), HUNG_MS)), JSON.stringify(await assigned(d)))
    check('…given once A had its verdict', (await factAt(d, 'ReviewerAssigned')) >= (await factAt(a, 'Verdict')))

    // --- B2's next card while E1 builds in a slot: R1 and R2 held in a turn, E1 leased: it waits. Once D is Done and
    // E1's lane's lease ends, it goes to E1.
    check('R2 is held in a turn', !!(await hold(alpha, r2.id, 'pool-r2-go')))
    check('R2 passes B', (await intent(tr2, b, 'start-review')).status === 200 && (await intent(tr2, b, 'verdict', { pass: true, comment: 'B: passed' })).status === 200)
    check('B2 merges B: Done', await merged(b2, b, bb.line))
    const be = await build(b2, l2.id, e, 'e1.txt')
    check('B2 builds and submits E, its next card', be.ok, be.why)
    check("E's lane waits for a reviewer", !!(await until(async () => (await lane(l2.id))?.status?.reason === 'reviewer', HUNG_MS)), JSON.stringify((await lane(l2.id))?.status))
    check('E1 holds its lane slot', !!(await slotOf(l3.id)))
    check('R1 is held in a turn', !!(await hold(alpha, r1.id, 'pool-r1-go')))
    check('R1 passes D', (await intent(tr1, d, 'start-review')).status === 200 && (await intent(tr1, d, 'verdict', { pass: true, comment: 'D: passed' })).status === 200)
    check('E1 merges D: Done', await merged(e1, d, bd.line))
    check("E1's lane ends and its slot's lease with it", !!(await until(async () => (await lane(l3.id))?.state === 'ended' && !(await slotOf(l3.id)), HUNG_MS)), JSON.stringify(await lane(l3.id)))
    check('E goes to E1 once it builds nothing', !!(await until(async () => JSON.stringify(await assigned(e)) === JSON.stringify([e1.id]), HUNG_MS)), JSON.stringify(await assigned(e)))
    check('…not before D was Done', (await factAt(e, 'ReviewerAssigned')) >= (await factAt(d, 'Integrated')))
    check('no reviewer got a card it built', JSON.stringify([await assigned(a), await assigned(b), await assigned(d)]) === JSON.stringify([[r1.id], [r2.id], [r1.id]]))
    for (const f of ['pool-r1-go', 'pool-r2-go']) fs.writeFileSync(path.join(home, f), '')

    // --- 2. beta: everyone in the project folder, Committed is done, two reviewers per card, the pool.
    await inv('workflow:setOptions', beta, { preset: null, options: { review: 'agent', noSelfReview: true, reviewers: 2, finish: 'committed', folder: 'project', preChecks: [], identity, okBefore: { mode: 'never', labels: [] }, reviewerMode: 'pool' } })
    const bb1 = await lib.addAgent(inv, beta, { name: 'BE-B1', workflowRole: 'builder' })
    const br1 = await lib.addAgent(inv, beta, { name: 'BE-R1', workflowRole: 'reviewer' })
    const br2 = await lib.addAgent(inv, beta, { name: 'BE-R2', workflowRole: 'reviewer' })
    const g = await create(beta, 'Pool G')
    const lb = await inv('lanes:start', beta, { builder: bb1.id, reviewer: null, pool: true, cards: [g] })
    check("beta's lane starts on the pool", lb.lane.pool === true && lb.started.length === 1, JSON.stringify(lb))
    const tb = await tokenOf(beta, bb1.id)
    const gs = await intent(tb, g, 'start')
    const revG = commitIn(beta, { 'g.txt': 'g\n' }, 'G done', (await card(g)).key)
    const gsub = await intent(tb, g, 'submit', { summary: 'G: ready', revision: revG })
    check('BE-B1 builds and submits G in the project folder', gs.status === 200 && gsub.status === 200 && !!(await until(async () => (await card(g))?.column === 'review', HUNG_MS)), JSON.stringify({ gs: gs.body, gsub: gsub.body }))
    // The builder moves on in the project folder; each reviewer reads G in a review copy at its revision.
    commitIn(beta, { 'later.txt': 'later\n' }, 'Later work')
    const review = async (r, n, pass) => {
      await until(async () => (await assigned(n)).includes(r.id), HUNG_MS)
      const token = await tokenOf(beta, r.id)
      await idle(beta, r.id)
      const s = await intent(token, n, 'start-review')
      const copy = (s.body?.data?.reviewCopy ?? '').match(/Review in (.+?) at /)?.[1] ?? null
      const atRev = !!copy && fs.existsSync(copy) && git(copy, 'rev-parse', 'HEAD') === revG
      const v = await intent(token, n, 'verdict', { pass, comment: `${r.name}: passed` })
      return { ok: s.status === 200 && v.status === 200, atRev, why: JSON.stringify({ s: s.body, v: v.body }) }
    }
    const first = await review(br1, g, true)
    check('BE-R1 is given G, reads it in a review copy at the submitted revision, and passes it', first.ok && first.atRev, first.why)
    check('…G waits for its second reviewer, another agent', !!(await until(async () => JSON.stringify(await assigned(g)) === JSON.stringify([br1.id, br2.id]), HUNG_MS)) && (await card(g))?.column === 'review', JSON.stringify(await assigned(g)))
    const second = await review(br2, g, true)
    check('BE-R2 reads it in a review copy too, and passes it', second.ok && second.atRev, second.why)
    check('G is Done (committed)', !!(await until(async () => (await card(g))?.column === 'done', HUNG_MS)), (await card(g))?.column)

    // --- 3. gamma (HI-2046): one reviewer per lane, but a card started on its builder alone, outside a lane. Submitted,
    // Combwork gives it to the project's stopped reviewer itself: started for the review and told, with no Assistant step.
    await inv('workflow:setOptions', gamma, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'committed', folder: 'project', preChecks: [], identity, okBefore: { mode: 'never', labels: [] } } })
    const gb1 = await lib.addAgent(inv, gamma, { name: 'GA-B1', workflowRole: 'builder' })
    const gr1 = await lib.addAgent(inv, gamma, { name: 'GA-R1', workflowRole: 'reviewer' })
    const k = await create(gamma, 'Loose K')
    await inv('session:start', gamma, { agentId: gb1.id })
    const tk = await tokenOf(gamma, gb1.id)
    const ks = await intent(tk, k, 'start')
    const revK = commitIn(gamma, { 'k.txt': 'k\n' }, 'K done', (await card(k)).key)
    const ksub = await intent(tk, k, 'submit', { summary: 'K: ready', revision: revK })
    check('GA-B1 builds and submits K outside a lane', ks.status === 200 && ksub.status === 200 && !(await card(k))?.lane && !!(await until(async () => (await card(k))?.column === 'review', HUNG_MS)), JSON.stringify({ ks: ks.body, ksub: ksub.body, lane: (await card(k))?.lane }))
    check('…no lane holds it', !(await inv('lanes:list')).some((l) => same(path.join(ws, l.project), gamma)))
    check('K goes to GA-R1, its reviewer', !!(await until(async () => JSON.stringify(await assigned(k)) === JSON.stringify([gr1.id]), HUNG_MS)), JSON.stringify(await assigned(k)))
    const gs1 = await until(() => live(gamma, gr1.id), HUNG_MS)
    check('GA-R1 is started for the review, in the project folder', !!gs1 && same(gs1.cwd, gamma), JSON.stringify(gs1))
    const toldK = await until(async () => (await deliveries('gamma', gr1.name)).find((x) => x.includes('outside a lane: you review it')), HUNG_MS)
    check(`…and told of ${(await card(k)).key}, once`, !!toldK && toldK.includes((await card(k)).key) && (await deliveries('gamma', gr1.name)).filter((x) => x.includes('outside a lane')).length === 1, JSON.stringify(await deliveries('gamma', gr1.name)))
    const tgr = await tokenOf(gamma, gr1.id)
    await idle(gamma, gr1.id)
    const kv = (await intent(tgr, k, 'start-review')).status === 200 && (await intent(tgr, k, 'verdict', { pass: true, comment: 'K: passed' })).status === 200
    check('GA-R1 reviews and passes K', kv)
    check('K is Done (committed), with no Assistant step', !!(await until(async () => (await card(k))?.column === 'done', HUNG_MS)) && !(await live(path.join(ws, '.combwork', 'assistant'), 'assistant')), (await card(k))?.column)

    // --- 4. delta (HI-2321, seen on HI-2320): a pool lane's design checked by one reviewer and its revision by another.
    // DE-R1 checks the design (gaps) while watching the card. Its watch doesn't hold it (HI-2333): DE-B2's card Y goes to
    // it, and reviewing Y does, so the pool gives the revision to DE-R2, who passes it and is then given the review.
    // DE-R1 passes Y, then, out of X's loop, ends with no watch: never flagged as not watching; DE-R2, its reviewer now,
    // ending with no watch on the card in Review, is.
    await inv('workflow:setOptions', delta, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'committed', folder: 'project', preChecks: [], identity, okBefore: { mode: 'never', labels: [] }, reviewerMode: 'pool' } })
    const db1 = await lib.addAgent(inv, delta, { name: 'DE-B1', workflowRole: 'builder' })
    const dr1 = await lib.addAgent(inv, delta, { name: 'DE-R1', workflowRole: 'reviewer' })
    const dr2 = await lib.addAgent(inv, delta, { name: 'DE-R2', workflowRole: 'reviewer' })
    const db2 = await lib.addAgent(inv, delta, { name: 'DE-B2', workflowRole: 'builder' })
    const x = await create(delta, 'Pool X')
    const y = await create(delta, 'Pool Y')
    const keyX = (await card(x)).key
    const ld = await inv('lanes:start', delta, { builder: db1.id, reviewer: null, pool: true, cards: [x] })
    const ldy = await inv('lanes:start', delta, { builder: db2.id, reviewer: null, pool: true, cards: [y] })
    check("delta's lanes start on the pool", ld.lane.pool === true && ldy.lane.pool === true, JSON.stringify([ld, ldy]))
    const tdb = await tokenOf(delta, db1.id)
    check('DE-B1 starts X', (await intent(tdb, x, 'start')).status === 200)
    const stalledOf = async (n) => (await (await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${n}`, { headers: { Authorization: `Bearer ${workspaceToken}` } })).json())?.stalled ?? null
    const designs = async () => (await facts(x)).filter((f) => f.kind === 'ReviewerAssigned' && f.data.design).map((f) => f.data.reviewer)
    const designId = async () => `${keyX}/s${(await facts(x)).findLast((f) => f.kind === 'LoopStep' && f.data.step === 'design').seq}`
    const s10 = await intent(tdb, x, 'loop-step', { step: 'design', text: 'X: the plan' })
    check('DE-B1 posts a design: the pool gives it to DE-R1', s10.status === 200 && !!(await until(async () => JSON.stringify(await designs()) === JSON.stringify([dr1.id]), HUNG_MS)), JSON.stringify({ s10: s10.body, given: await designs() }))
    const tdr1 = await tokenOf(delta, dr1.id)
    await idle(delta, dr1.id)
    // DE-R1 watches X (a loop's watch: it is in X's loop), then answers with gaps, still watching.
    await lib.typeLine(inv, lib.ptyKey(delta, dr1.id), home, null, `hive cw_wait_for_tasks ${JSON.stringify({ cards: [`#${x}`], changes: ['comment'], wake: true })}`, { live: () => live(delta, dr1.id) })
    check('DE-R1 watches X', !!(await until(async () => (await live(delta, dr1.id))?.status === 'watching', HUNG_MS)), JSON.stringify(await live(delta, dr1.id)))
    check('DE-R1 answers with gaps', (await intent(tdr1, x, 'loop-step', { step: 'gaps', design: await designId(), text: 'X: more, please' })).status === 200)
    // Its watch doesn't hold it (HI-2333): Y, submitted, goes to DE-R1 (running, so before the stopped DE-R2), which
    // starts reviewing it: that holds it.
    const tdb2 = await tokenOf(delta, db2.id)
    check('DE-B2 starts Y', (await intent(tdb2, y, 'start')).status === 200)
    const revY = commitIn(delta, { 'y.txt': 'y\n' }, 'Y done', (await card(y)).key)
    check('DE-B2 submits Y', (await intent(tdb2, y, 'submit', { summary: 'Y: ready', revision: revY })).status === 200 && !!(await until(async () => (await card(y))?.column === 'review', HUNG_MS)))
    check('Y goes to DE-R1, watching X (HI-2333)', !!(await until(async () => JSON.stringify(await assigned(y)) === JSON.stringify([dr1.id]), HUNG_MS)), JSON.stringify(await assigned(y)))
    check('DE-R1 starts reviewing Y', (await intent(tdr1, y, 'start-review')).status === 200)
    const s19 = await intent(tdb, x, 'loop-step', { step: 'design', text: 'X: the plan, revised' })
    check('DE-B1 posts its revision: DE-R1 is reviewing Y, so the pool gives it to DE-R2', s19.status === 200 && !!(await until(async () => JSON.stringify(await designs()) === JSON.stringify([dr1.id, dr2.id]), HUNG_MS)), JSON.stringify({ s19: s19.body, given: await designs() }))
    const tdr2 = await tokenOf(delta, dr2.id)
    await idle(delta, dr2.id)
    check('DE-R2 passes the revision', (await intent(tdr2, x, 'loop-step', { step: 'ok', design: await designId(), text: 'X: good' })).status === 200)
    // HI-2384: DE-R1's watch on X wakes it for these loop steps; read before r1Clear cancels that watch. Cancelled first,
    // the wake goes untold, and DE-R1's next watch of X counts them from its own last change (its gaps, HI-2302): it
    // fires at once, and DE-R1 ends with no watch where the suite waits for it watching.
    const toldStep = await until(async () => (await deliveryRows('delta', dr1.name)).some((w) => w.text.startsWith(`[CW] ${keyX} `) && w.text.includes('a card loop step') && ['received', 'acked'].includes(w.state)), HUNG_MS)
    check("…DE-R1's watch on X tells it, and it reads the wake", !!toldStep, JSON.stringify(await deliveryRows('delta', dr1.name)))
    check('DE-R1 passes Y: Done', (await intent(tdr1, y, 'verdict', { pass: true, comment: 'Y: passed' })).status === 200 && !!(await until(async () => (await card(y))?.column === 'done', HUNG_MS)), (await card(y))?.column)
    // DE-R1 ends with no card watch, as HR1 did on HI-2320: once its own grace check has run (loops:checks, counted
    // after its mark is made), it has no mark. Read again at each stage: it would flag DE-R1 for X in Doing, here.
    const r1Clear = async (stage) => {
      const before = await inv('loops:checks', delta, dr1.id)
      await inv('watch:cancel', delta, dr1.id)
      check(`DE-R1 is idle with no watch (${stage})`, !!(await until(async () => ['ready', 'finished'].includes((await live(delta, dr1.id))?.status) && !(await live(delta, dr1.id))?.watch, HUNG_MS)), JSON.stringify(await live(delta, dr1.id)))
      check(`…its grace check runs (${stage})`, !!(await until(async () => (await inv('loops:checks', delta, dr1.id)) > before, HUNG_MS)), String(await inv('loops:checks', delta, dr1.id)))
      check(`…and DE-R1, out of X's loop, isn't flagged as not watching it (${stage}; HI-2321)`, !(await live(delta, dr1.id))?.notWatching && !/DE-R1 isn't watching/.test(fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8')), JSON.stringify(await live(delta, dr1.id)))
    }
    await r1Clear('X in Doing, its revision checked by DE-R2')
    // Built and submitted: the review goes to DE-R2, the design's last answer (its preferred reviewer).
    const revX = commitIn(delta, { 'x.txt': 'x\n' }, 'X done', keyX)
    check('DE-B1 submits X', (await intent(tdb, x, 'submit', { summary: 'X: ready', revision: revX })).status === 200 && !!(await until(async () => (await card(x))?.column === 'review', HUNG_MS)))
    check('X goes to DE-R2', !!(await until(async () => JSON.stringify(await assigned(x)) === JSON.stringify([dr1.id, dr2.id, dr2.id]), HUNG_MS)), JSON.stringify(await assigned(x)))
    await idle(delta, dr2.id)
    check('DE-R2 starts its review', (await intent(tdr2, x, 'start-review')).status === 200)
    // DE-R2 watches X, then ends with no watch: X in Review is its move, so after the grace it is flagged.
    await lib.typeLine(inv, lib.ptyKey(delta, dr2.id), home, null, `hive cw_wait_for_tasks ${JSON.stringify({ cards: [`#${x}`], changes: ['verdict'], wake: true })}`, { live: () => live(delta, dr2.id) })
    check('DE-R2 watches X', !!(await until(async () => (await live(delta, dr2.id))?.status === 'watching', HUNG_MS)), JSON.stringify(await live(delta, dr2.id)))
    await inv('watch:cancel', delta, dr2.id)
    const r2Flag = await until(async () => JSON.stringify((await live(delta, dr2.id))?.notWatching) === JSON.stringify([x]), HUNG_MS)
    check("DE-R2, X's reviewer now, ending with no watch is flagged as not watching X", !!r2Flag, JSON.stringify(await live(delta, dr2.id)))
    // DE-R1 watches X again and ends with no watch, X in Review with DE-R2: its grace check runs and finds nothing of its.
    await idle(delta, dr1.id)
    await lib.typeLine(inv, lib.ptyKey(delta, dr1.id), home, null, `hive cw_wait_for_tasks ${JSON.stringify({ cards: [`#${x}`], changes: ['verdict'], wake: true })}`, { live: () => live(delta, dr1.id) })
    check('DE-R1 watches X again', !!(await until(async () => (await live(delta, dr1.id))?.status === 'watching', HUNG_MS)), JSON.stringify(await live(delta, dr1.id)))
    await r1Clear('X in Review with DE-R2')
    check('…and X\'s stall names DE-R2, not DE-R1', (lib.unkey(await stalledOf(x)) ?? '').startsWith("DE-R2 isn't watching"), String(await stalledOf(x)))

    // --- 5. epsilon (HI-2333, the cli project's stall on rc.19): one pooled reviewer, EP-R1, watching Z in its loop. It
    // is still free: Z's revised design and then Z's submission are given to it and typed at its prompt, each told once
    // and read (`received`: it read it with cw_inbox), with no other line for them from the watch or a loop wake.
    await inv('workflow:setOptions', epsilon, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'committed', folder: 'project', preChecks: [], identity, okBefore: { mode: 'never', labels: [] }, reviewerMode: 'pool' } })
    const eb1 = await lib.addAgent(inv, epsilon, { name: 'EP-B1', workflowRole: 'builder' })
    const er1 = await lib.addAgent(inv, epsilon, { name: 'EP-R1', workflowRole: 'reviewer' })
    const z = await create(epsilon, 'Pool Z')
    const keyZ = (await card(z)).key
    const le = await inv('lanes:start', epsilon, { builder: eb1.id, reviewer: null, pool: true, cards: [z] })
    check("epsilon's lane starts on the pool", le.lane.pool === true, JSON.stringify(le))
    const teb = await tokenOf(epsilon, eb1.id)
    check('EP-B1 starts Z', (await intent(teb, z, 'start')).status === 200)
    const designsZ = async () => (await facts(z)).filter((f) => f.kind === 'ReviewerAssigned' && f.data.design).map((f) => f.data.reviewer)
    const designZ = async () => `${keyZ}/s${(await facts(z)).findLast((f) => f.kind === 'LoopStep' && f.data.step === 'design').seq}`
    /**
     * The pool's lines to EP-R1 about this (a design's id, or Z in Review), each with whether it read it: not its watch's
     * own wake, whose latest comment may quote the same id.
     */
    const toldOf = async (what) => (await deliveryRows('epsilon', er1.name)).filter((dv) => dv.text.includes(what) && dv.text.includes('from the pool'))
    /** Given once and read: one line not refused (a refused try, the watch's wake going first, is cancelled), received. */
    const readOnce = (what) => until(async () => {
      const given = (await toldOf(what)).filter((dv) => dv.state !== 'cancelled')
      return given.length === 1 && ['received', 'acked'].includes(given[0].state)
    }, HUNG_MS)
    /** EP-R1 watches Z (a loop's watch), as card-loop's reviewer does: `watching` then. */
    const watchZ = async (changes) => {
      await idle(epsilon, er1.id)
      await lib.typeLine(inv, lib.ptyKey(epsilon, er1.id), home, null, `hive cw_wait_for_tasks ${JSON.stringify({ cards: [`#${z}`], changes, wake: true })}`, { live: () => live(epsilon, er1.id) })
      return until(async () => (await live(epsilon, er1.id))?.status === 'watching', HUNG_MS)
    }
    check('EP-B1 posts a design: the pool gives it to EP-R1', (await intent(teb, z, 'loop-step', { step: 'design', text: 'Z: the plan' })).status === 200 && !!(await until(async () => JSON.stringify(await designsZ()) === JSON.stringify([er1.id]), HUNG_MS)), JSON.stringify(await designsZ()))
    const z1 = await designZ()
    check('…started for it, told once, and it reads it', !!(await readOnce(z1)), JSON.stringify(await toldOf(z1)))
    const ter = await tokenOf(epsilon, er1.id)
    check('EP-R1 watches Z', !!(await watchZ(['comment'])), JSON.stringify(await live(epsilon, er1.id)))
    check('EP-R1 answers with gaps, still watching', (await intent(ter, z, 'loop-step', { step: 'gaps', design: z1, text: 'Z: more, please' })).status === 200 && (await live(epsilon, er1.id))?.status === 'watching', JSON.stringify(await live(epsilon, er1.id)))
    check('EP-B1 posts its revision: the pool gives it to EP-R1, watching (HI-2333)', (await intent(teb, z, 'loop-step', { step: 'design', text: 'Z: the plan, revised' })).status === 200 && !!(await until(async () => JSON.stringify(await designsZ()) === JSON.stringify([er1.id, er1.id]), HUNG_MS)), JSON.stringify(await designsZ()))
    const z2 = await designZ()
    check('…told of it once, typed at its prompt, and it reads it', !!(await readOnce(z2)), JSON.stringify(await toldOf(z2)))
    check('EP-R1 passes the revision (CL-8 s23 was refused: nobody had been given it)', (await intent(ter, z, 'loop-step', { step: 'ok', design: z2, text: 'Z: good' })).status === 200)
    // It watches Z again (for a verdict only: the submission's move and summary don't end it), and Z is submitted.
    check('EP-R1 watches Z again', !!(await watchZ(['verdict'])), JSON.stringify(await live(epsilon, er1.id)))
    const revZ = commitIn(epsilon, { 'z.txt': 'z\n' }, 'Z done', keyZ)
    check('EP-B1 submits Z', (await intent(teb, z, 'submit', { summary: 'Z: ready', revision: revZ })).status === 200 && !!(await until(async () => (await card(z))?.column === 'review', HUNG_MS)))
    check('Z goes to EP-R1, watching (HI-2333)', !!(await until(async () => JSON.stringify(await assigned(z)) === JSON.stringify([er1.id, er1.id, er1.id]), HUNG_MS)), JSON.stringify(await assigned(z)))
    check('…told once that it reviews Z from the pool, and it reads it', !!(await readOnce(`${keyZ} (EP-B1's card) is in Review: you review it from the pool`)), JSON.stringify(await deliveryRows('epsilon', er1.name)))
    check('…no other line tells it Z is in Review (its watch counts verdicts; a pool card has no loop wake for it)', (await deliveryRows('epsilon', er1.name)).filter((dv) => dv.state !== 'cancelled' && dv.text.includes(keyZ) && /is in Review/.test(dv.text)).length === 1, JSON.stringify(await deliveryRows('epsilon', er1.name)))
    // A try or two for each assignment (its design, its revision, its submission): its line refused while its own
    // watch's wake goes first (the revision's comment ends EP-R1's watch) is tried again once its state changes or by
    // the retry pass, never at once: refused lines retried at each status event logged ~20 tries for one (HI-2333).
    const tellings = (fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8').match(new RegExp(`Telling \\S*EP-R1\\S* of #${z} `, 'g')) ?? []).length
    check('…its three assignments told in at most two tries each (no pass looping on a refused line)', tellings >= 3 && tellings <= 6, String(tellings))
    await idle(epsilon, er1.id)
    check('EP-R1 reviews and passes Z: Done', (await intent(ter, z, 'start-review')).status === 200 && (await intent(ter, z, 'verdict', { pass: true, comment: 'Z: passed' })).status === 200 && !!(await until(async () => (await card(z))?.column === 'done', HUNG_MS)), (await card(z))?.column)

    // --- 6. zeta (HI-2559, the cli project's stall on 5 Nov): one pooled reviewer, ZE-R1, two pool lanes. Reviewing P,
    // it is busy: Q's design waits. It asks the user about P and watches P: the request (a board change, no pass asked
    // by the test) frees it, so Q's waiting design goes to it, and then Q's submission, each told once and read, while
    // P's question stays open and P stays ZE-R1's. The user answers; ZE-R1 passes both: Done.
    await inv('workflow:setOptions', zeta, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'committed', folder: 'project', preChecks: [], identity, okBefore: { mode: 'never', labels: [] }, reviewerMode: 'pool' } })
    const zb1 = await lib.addAgent(inv, zeta, { name: 'ZE-B1', workflowRole: 'builder' })
    const zb2 = await lib.addAgent(inv, zeta, { name: 'ZE-B2', workflowRole: 'builder' })
    const zr1 = await lib.addAgent(inv, zeta, { name: 'ZE-R1', workflowRole: 'reviewer' })
    const p = await create(zeta, 'Pool P')
    const q = await create(zeta, 'Pool Q')
    const keyP = (await card(p)).key
    const keyQ = (await card(q)).key
    const lp = await inv('lanes:start', zeta, { builder: zb1.id, reviewer: null, pool: true, cards: [p] })
    const lq = await inv('lanes:start', zeta, { builder: zb2.id, reviewer: null, pool: true, cards: [q] })
    check("zeta's two lanes start on the pool", lp.lane.pool === true && lq.lane.pool === true, JSON.stringify([lp, lq]))
    const tzb1 = await tokenOf(zeta, zb1.id)
    const tzb2 = await tokenOf(zeta, zb2.id)
    check('ZE-B1 starts P', (await intent(tzb1, p, 'start')).status === 200)
    const revP = commitIn(zeta, { 'p.txt': 'p\n' }, 'P done', keyP)
    check('ZE-B1 submits P', (await intent(tzb1, p, 'submit', { summary: 'P: ready', revision: revP })).status === 200 && !!(await until(async () => (await card(p))?.column === 'review', HUNG_MS)))
    check('P goes to ZE-R1', !!(await until(async () => JSON.stringify(await assigned(p)) === JSON.stringify([zr1.id]), HUNG_MS)), JSON.stringify(await assigned(p)))
    const zToldOf = async (what) => (await deliveryRows('zeta', zr1.name)).filter((dv) => dv.text.includes(what) && dv.text.includes('from the pool'))
    const zReadOnce = (what) => until(async () => {
      const given = (await zToldOf(what)).filter((dv) => dv.state !== 'cancelled')
      return given.length === 1 && ['received', 'acked'].includes(given[0].state)
    }, HUNG_MS)
    check('…told once, and it reads it', !!(await zReadOnce(`${keyP} (ZE-B1's card) is in Review`)), JSON.stringify(await zToldOf(keyP)))
    const tzr = await tokenOf(zeta, zr1.id)
    await idle(zeta, zr1.id)
    check('ZE-R1 starts reviewing P', (await intent(tzr, p, 'start-review')).status === 200)
    const designsQ = async () => (await facts(q)).filter((f) => f.kind === 'ReviewerAssigned' && f.data.design).map((f) => f.data.reviewer)
    check('ZE-B2 starts Q and posts a design', (await intent(tzb2, q, 'start')).status === 200 && (await intent(tzb2, q, 'loop-step', { step: 'design', text: 'Q: the plan' })).status === 200)
    const q1 = `${keyQ}/s${(await facts(q)).findLast((f) => f.kind === 'LoopStep' && f.data.step === 'design').seq}`
    // Busy with P (no question yet): the design waits, its lane waiting for a reviewer. (That nothing gives it while ZE-R1
    // is busy is the unit tests' control; here, what follows is what frees it.)
    check('…ZE-R1, reviewing P, is busy: the design waits for a reviewer', !!(await until(async () => (await lane(lq.lane.id))?.status?.reason === 'reviewer', HUNG_MS)) && JSON.stringify(await designsQ()) === '[]', JSON.stringify({ given: await designsQ(), status: (await lane(lq.lane.id))?.status }))
    // ZE-R1 asks the user about P, then watches P (as the cli's CR1 did).
    const askP = await intent(tzr, p, 'ask', { kind: 'decide', text: 'Do you accept the bounded "not reproduced" conclusion?' })
    const askReq = (await facts(p)).findLast((f) => f.kind === 'ApprovalRequested' && f.data.asker === zr1.id)?.data?.request
    check('ZE-R1 asks the user about P', askP.status === 200 && !!askReq, JSON.stringify(askP.body))
    await idle(zeta, zr1.id)
    await lib.typeLine(inv, lib.ptyKey(zeta, zr1.id), home, null, `hive cw_wait_for_tasks ${JSON.stringify({ cards: [`#${p}`], changes: ['comment', 'verdict'], wake: true })}`, { live: () => live(zeta, zr1.id) })
    check('ZE-R1 watches P', !!(await until(async () => (await live(zeta, zr1.id))?.status === 'watching', HUNG_MS)), JSON.stringify(await live(zeta, zr1.id)))
    check("Q's waiting design goes to ZE-R1, P held on its question (HI-2559)", !!(await until(async () => JSON.stringify(await designsQ()) === JSON.stringify([zr1.id]), HUNG_MS)), JSON.stringify(await designsQ()))
    check('…told of it once, and it reads it', !!(await zReadOnce(q1)), JSON.stringify(await zToldOf(q1)))
    await idle(zeta, zr1.id)
    check('ZE-R1 answers the design: ok', (await intent(tzr, q, 'loop-step', { step: 'ok', design: q1, text: 'Q: good' })).status === 200)
    await lib.typeLine(inv, lib.ptyKey(zeta, zr1.id), home, null, `hive cw_wait_for_tasks ${JSON.stringify({ cards: [`#${p}`], changes: ['comment', 'verdict'], wake: true })}`, { live: () => live(zeta, zr1.id) })
    check('ZE-R1 watches P again', !!(await until(async () => (await live(zeta, zr1.id))?.status === 'watching', HUNG_MS)), JSON.stringify(await live(zeta, zr1.id)))
    const revQ = commitIn(zeta, { 'q.txt': 'q\n' }, 'Q done', keyQ)
    check('ZE-B2 submits Q', (await intent(tzb2, q, 'submit', { summary: 'Q: ready', revision: revQ })).status === 200 && !!(await until(async () => (await card(q))?.column === 'review', HUNG_MS)))
    check('Q goes to ZE-R1, watching, P still held', !!(await until(async () => JSON.stringify(await assigned(q)) === JSON.stringify([zr1.id, zr1.id]), HUNG_MS)), JSON.stringify(await assigned(q)))
    check('…told once that it reviews Q from the pool, and it reads it', !!(await zReadOnce(`${keyQ} (ZE-B2's card) is in Review`)), JSON.stringify(await zToldOf(keyQ)))
    const factsP = await facts(p)
    const openAsk = (await inv('tasks:list')).find((c) => c.number === p)
    check("P's question is still open, and P still ZE-R1's: never released or given again", JSON.stringify(await assigned(p)) === JSON.stringify([zr1.id]) && !factsP.some((f) => f.kind === 'ReviewerReleased') && factsP.some((f) => f.kind === 'ApprovalRequested' && f.data.request === askReq) && !factsP.some((f) => f.kind === 'Approval'), JSON.stringify({ assigned: await assigned(p), forYou: openAsk?.forYou }))
    check('…and told of P once only', (await zToldOf(keyP)).filter((dv) => dv.state !== 'cancelled').length === 1, JSON.stringify(await zToldOf(keyP)))
    // The user answers; ZE-R1 passes P and Q: both Done.
    await inv('tasks:answer', p, askReq, { outcome: 'answered', reply: 'Yes' })
    await inv('watch:cancel', zeta, zr1.id)
    await idle(zeta, zr1.id)
    check('ZE-R1 passes P: Done', (await intent(tzr, p, 'verdict', { pass: true, comment: 'P: passed' })).status === 200 && !!(await until(async () => (await card(p))?.column === 'done', HUNG_MS)), (await card(p))?.column)
    check('ZE-R1 passes Q: Done', (await intent(tzr, q, 'start-review')).status === 200 && (await intent(tzr, q, 'verdict', { pass: true, comment: 'Q: passed' })).status === 200 && !!(await until(async () => (await card(q))?.column === 'done', HUNG_MS)), (await card(q))?.column)
  } catch (err) {
    check('no unexpected error', false, err.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`Screenshots: ${shots}`)
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
