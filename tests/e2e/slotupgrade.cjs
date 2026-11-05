// S56, agents' worktrees become slots at the upgrade (#1441, SPEC §16.10.8), on fake Claude Code agents, the Assistant
// off; alpha is a 6×6 team (#1448: B1–B6 each in a worktree of its own, R2 too, the other reviewers in the folder).
// The workspace is made as 0.9 left it: each builder's own worktree in project.json, the slots' migration held off
// for the first start (HIVE_TEST_SLOT_MIGRATION=off, unpackaged only), so the dev build runs it as 0.9 did:
// 1. "0.9 day": alpha (Pair with Combwork merges into integration, cards in slots) runs a lane of two cards on B1, whose
//    worktree hb1 is where it works and where card 1 starts; the solo project's agent Me works in its worktree, no cards.
// 2. The upgrade (the next start, migrated): hb1 is a slot carried by B1 for the lane, me one carried by Me for nothing.
//    The lane finishes there: card 1 submitted, reviewed and merged, card 2 started in hb1 too (the stand-in path), and
//    merged; the lane ends, B1 is stopped, its carried lease ends, and hb1, free, is renamed slot-a with Repair's steps:
//    B1's last conversation recorded there, and resumed there (B1's own again). B1's next lane takes slot-a over, and
//    its card gets a per-card line.
//    Me's first card takes its slot over (clean, merged): built in its worktree, its conversation going on.
// 3. A restart: Resume All resumes Me in its worktree, on its card's lease.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const at = (x) => path.join(lib.WORK, `slotupgrade-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const alpha = path.join(ws, 'alpha')
const solo = path.join(ws, 'solo')
const root = path.join(`${ws}.worktrees`, 'alpha')
const hb1 = path.join(root, 'hb1')
const slotA = path.join(root, 'slot-a')
const slotB = path.join(root, 'slot-b')
const meTree = path.join(`${ws}.worktrees`, 'solo', 'me')
// The rest of a 6×6 team as 0.9 left it (#1448): B2–B6 each in a worktree of its own, R2 too (a reviewer's own, which
// becomes a retired home), R3–R6 in the project folder.
const others = [2, 3, 4, 5, 6].map((n) => ({ n, tree: path.join(root, `hb${n}`) }))
const hr2 = path.join(root, 'hr2')
const PORT = Number(lib.port(47937))
const identity = { name: 'Hive Slot Test', email: 'slots@example.com' }
let failed = 0
const check = (name, ok, extra = '') => {
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
const isIn = (dir, rev, ref) => {
  try {
    lib.git(dir, ['merge-base', '--is-ancestor', rev, ref])
    return true
  } catch {
    return false
  }
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  // 0.9's layout: alpha with B1's worktree hb1 (on hive/hb1, from integration), R1 in the project folder; solo with Me's.
  lib.gitProject(alpha, { 'a.txt': 'a\n', '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.git(alpha, ['branch', 'integration'])
  // The identity its commits use, in its git config: G12 reads it from git each time (HI-2266, HI-2283).
  lib.git(alpha, ['config', 'user.name', identity.name])
  lib.git(alpha, ['config', 'user.email', identity.email])
  lib.git(alpha, ['worktree', 'add', '-q', '-b', 'hive/hb1', hb1, 'integration'])
  for (const o of others) lib.git(alpha, ['worktree', 'add', '-q', '-b', `hive/hb${o.n}`, o.tree, 'integration'])
  lib.git(alpha, ['worktree', 'add', '-q', '-b', 'hive/hr2', hr2, 'integration'])
  lib.gitProject(solo, { 's.txt': 's\n', '.gitignore': '.combwork/\n' })
  lib.git(solo, ['branch', '-M', 'main'])
  lib.git(solo, ['worktree', 'add', '-q', '-b', 'hive/me', meTree, 'main'])
  const agents = {
    [alpha]: [
      { id: 'b1', name: 'B1', provider: 'claude-code', workflowRole: 'builder', worktree: { path: hb1, branch: 'hive/hb1', base: 'integration' } },
      { id: 'r1', name: 'R1', provider: 'claude-code', workflowRole: 'reviewer' },
      ...others.map((o) => ({ id: `b${o.n}`, name: `B${o.n}`, provider: 'claude-code', workflowRole: 'builder', worktree: { path: o.tree, branch: `hive/hb${o.n}`, base: 'integration' } })),
      { id: 'r2', name: 'R2', provider: 'claude-code', workflowRole: 'reviewer', worktree: { path: hr2, branch: 'hive/hr2', base: 'integration' } },
      ...[3, 4, 5, 6].map((n) => ({ id: `r${n}`, name: `R${n}`, provider: 'claude-code', workflowRole: 'reviewer' }))
    ],
    [solo]: [{ id: 'me', name: 'Me', provider: 'claude-code', worktree: { path: meTree, branch: 'hive/me', base: 'main' } }]
  }
  for (const [p, list] of Object.entries(agents)) {
    fs.mkdirSync(path.join(p, '.combwork'), { recursive: true })
    fs.writeFileSync(path.join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: list }, null, 2))
  }
  const env = lib.fakeClaude(userData, home, [alpha, solo, ws, hb1, slotA, slotB, meTree, hr2, ...others.map((o) => o.tree)])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let h = null
  const start = async (extra = {}) => {
    h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off', ...extra } })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(h.inv)
    await lib.openWorkspace(h.inv, h.page, ws)
  }
  const close = async () => {
    await h.app.close().catch(() => undefined)
    h = null
  }
  const inv = (...a) => h.inv(...a)
  const until = (fn, ms) => lib.until(fn, ms, 250)
  const live = async (p, id) => (await inv('session:live')).find((s) => same(s.projectPath, p) && s.agentId === id) ?? null
  const idle = async (p, id) => ['ready', 'finished'].includes((await live(p, id))?.status)
  const launches = () => {
    const f = path.join(home, 'fake-launches.jsonl')
    const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
    return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  }
  /** The agent's running session's Agent API token (its latest launch's: a resumed conversation keeps its id). */
  const tokenOf = async (p, id) => {
    const sessionId = await until(async () => (await live(p, id))?.sessionId, HUNG_MS)
    const launch = await until(() => launches().filter((l) => l.sessionId === sessionId && l.opts['--mcp-config'] && fs.existsSync(l.opts['--mcp-config'])).at(-1), HUNG_MS)
    const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
    return hive ? JSON.parse(fs.readFileSync(hive.env.CW_API_TOKEN_FILE, 'utf8')).token : null
  }
  const intent = async (token, n, name, body = {}) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${encodeURIComponent(`#${n}`)}/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
  const lane = async (id) => (await inv('lanes:list', { all: true })).find((l) => l.id === id)
  const slots = (p) => inv('slots:list', p)
  const branchIn = (dir) => git(dir, 'branch', '--show-current')
  const agentInfo = async (p, id) => (await inv('workspace:refresh')).projects.find((x) => same(x.path, p))?.agents.find((a) => a.id === id)
  const sessionOf = async (p, id) => (await inv('session:list', p)).find((s) => s.id === id)
  /** Resume All for one agent, as the window does it: its conversation offered with no hold, resumed (auto). */
  const resumeAllFor = async (p, id) => {
    const r = await until(async () => (await agentInfo(p, id))?.resume, HUNG_MS)
    if (!r || r.hold) return { offered: false, why: JSON.stringify(r) }
    await inv('session:start', p, { resumeId: r.id, name: r.name, agentId: id, auto: true })
    return { offered: true, id: r.id }
  }
  const pass = async (tb, tr, n, summary) => (await intent(tb, n, 'submit', { summary })).status === 200 && (await intent(tr, n, 'start-review')).status === 200 && (await intent(tr, n, 'verdict', { pass: true, comment: `${summary}: passed` })).status === 200

  try {
    // --- 1. "0.9 day": the dev build with the slots' migration held off.
    await start({ HIVE_TEST_SLOT_MIGRATION: 'off' })
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'hiveMerges', folder: 'slots', target: 'integration', style: 'merge', preChecks: [], mergeChecks: [], identity, okBefore: { mode: 'never', labels: [] } } })
    await inv('workflow:setOptions', solo, { preset: null, options: { review: 'none', finish: 'notChecked', folder: 'slots' } })
    const create = async (title, project) => (await inv('tasks:create', { title, project })).number
    const c1 = await create('Old one', 'alpha')
    const c2 = await create('Old two', 'alpha')
    const c3 = await create('New three', 'alpha')
    const cMe = await create('Mine', 'solo')
    const key = (await card(c3)).key.split('-')[0]
    const started = await inv('lanes:start', alpha, { builder: 'b1', reviewer: 'r1', cards: [c1, c2] })
    check("0.9 day: the lane starts on B1's worktree, no slot lent", !started.slot && started.started.every((s) => s.how !== 'failed'), JSON.stringify(started))
    const b1Old = await until(async () => ((await idle(alpha, 'b1')) && same((await live(alpha, 'b1'))?.cwd, hb1) ? live(alpha, 'b1') : null), HUNG_MS)
    check('…B1 runs in hb1', !!b1Old, JSON.stringify(await live(alpha, 'b1')))
    const tb1 = await tokenOf(alpha, 'b1')
    const s1 = await intent(tb1, c1, 'start')
    check('…card 1 starts in hb1', s1.status === 200 && same(s1.body?.data?.folder, hb1), JSON.stringify(s1.body))
    commitIn(hb1, { 'one.txt': 'one\n' }, 'Old one')
    await inv('session:start', solo, { agentId: 'me' })
    const meOld = await until(async () => ((await idle(solo, 'me')) ? live(solo, 'me') : null), HUNG_MS)
    check('…Me runs in its worktree', same(meOld?.cwd, meTree), JSON.stringify(meOld))
    check('…no slots yet', (await slots(alpha)).length === 0 && (await slots(solo)).length === 0)
    await close()

    // --- 2. The upgrade: the next start migrates.
    await start()
    const adopted = await until(async () => {
      const a = (await slots(alpha)).find((s) => s.name === 'hb1')
      return a?.lease ? a : null
    }, HUNG_MS)
    check('hb1 is a slot, carried by B1', adopted?.lease?.kind === 'carried' && adopted.lease.agent === 'b1' && same(adopted.folder, hb1), JSON.stringify(adopted))
    const mine = (await slots(solo)).find((s) => s.name === 'me')
    const team = await slots(alpha)
    check("the 6×6 team's other builders' worktrees are slots, each carried by its builder", others.every((o) => team.some((s) => same(s.folder, o.tree) && s.lease?.kind === 'carried' && s.lease.agent === `b${o.n}`)), JSON.stringify(team.map((s) => [s.name, s.lease?.agent])))
    check("…R2's own worktree is kept, a retired home, not a slot", fs.existsSync(hr2) && !team.some((s) => same(s.folder, hr2)), JSON.stringify(team.map((s) => s.folder)))
    check("Me's worktree is a slot carried by Me", mine?.lease?.kind === 'carried' && mine.lease.agent === 'me', JSON.stringify(await slots(solo)))
    const b1Rec = await sessionOf(alpha, b1Old.sessionId)
    check("B1's 0.9 conversation is bound to its carried lease", !!adopted?.lease?.id && b1Rec?.lease === adopted.lease.id, JSON.stringify(b1Rec))
    // The lane's agents and Me, resumed (Resume All).
    const resumeAll = h.page.locator('button.act-resume.quiet')
    await until(async () => (await resumeAll.count()) === 1, HUNG_MS)
    await resumeAll.click()
    const b1Now = await until(async () => ((await idle(alpha, 'b1')) ? live(alpha, 'b1') : null), HUNG_MS)
    check('Resume All resumes B1 in hb1, the same conversation', same(b1Now?.cwd, hb1) && b1Now?.sessionId === b1Old.sessionId, JSON.stringify(b1Now))
    const meOffer = await resumeAllFor(solo, 'me')
    check("Resume All offers Me's conversation (no hold)", meOffer.offered && meOffer.id === meOld.sessionId, meOffer.why)
    const meNow = await until(async () => ((await idle(solo, 'me')) ? live(solo, 'me') : null), HUNG_MS)
    check('…and Me in its worktree', same(meNow?.cwd, meTree) && meNow?.sessionId === meOld.sessionId, JSON.stringify(meNow ?? (await agentInfo(solo, 'me'))?.resume))

    // The lane finishes on hb1.
    const tb1b = await tokenOf(alpha, 'b1')
    if (!(await live(alpha, 'r1'))) await inv('session:start', alpha, { agentId: 'r1' })
    const tr1 = await tokenOf(alpha, 'r1')
    check('card 1 submitted, reviewed and passed', await pass(tb1b, tr1, c1, 'Old one'))
    check("…merged by Combwork's queue: Done", !!(await until(async () => (await card(c1))?.column === 'done', HUNG_MS)) && isIn(alpha, git(hb1, 'rev-parse', 'HEAD'), 'integration'), (await card(c1))?.column)
    const s2 = await intent(tb1b, c2, 'start')
    check('card 2 starts in hb1 too (the lane goes on there)', s2.status === 200 && same(s2.body?.data?.folder, hb1), JSON.stringify(s2.body))
    check('…on its own branch, no per-card line', branchIn(hb1) === 'hive/hb1')
    const rev2 = commitIn(hb1, { 'two.txt': 'two\n' }, 'Old two')
    check('card 2 submitted, reviewed and passed', await pass(tb1b, tr1, c2, 'Old two'))
    check('…merged: the lane ends', !!(await until(async () => (await card(c2))?.column === 'done' && !!(await lane(started.lane.id))?.endedAt, HUNG_MS)) && isIn(alpha, rev2, 'integration'))
    check("B1's carried lease ends with the lane, and B1 is stopped", !!(await until(async () => !(await live(alpha, 'b1')) && !(await slots(alpha)).some((s) => s.lease?.agent === 'b1'), HUNG_MS)))

    // hb1, free, renamed slot-a with Repair's steps; B1's last conversation goes with it.
    const renamed = await until(async () => (await slots(alpha)).find((s) => s.name === 'slot-a'), HUNG_MS)
    check('hb1 is renamed slot-a once free', !!renamed && same(renamed.folder, slotA) && !fs.existsSync(hb1) && !(await slots(alpha)).some((s) => s.name === 'hb1'), JSON.stringify(await slots(alpha)))
    check("…git lists it there, on B1's branch", git(alpha, 'worktree', 'list', '--porcelain').toLowerCase().includes(slotA.toLowerCase().replace(/\\/g, '/')) && branchIn(slotA) === 'hive/hb1')
    const moved = await sessionOf(alpha, b1Old.sessionId)
    check("…B1's conversation recorded in slot-a", same(moved?.cwd, slotA), JSON.stringify(moved))
    await inv('session:start', alpha, { agentId: 'b1', resumeId: b1Old.sessionId })
    const b1There = await until(async () => ((await idle(alpha, 'b1')) ? live(alpha, 'b1') : null), HUNG_MS)
    check('…and resumes there, the same conversation', same(b1There?.cwd, slotA) && b1There?.sessionId === b1Old.sessionId, JSON.stringify(b1There))
    await inv('session:stop', alpha, 'b1')
    await until(async () => !(await live(alpha, 'b1')), HUNG_MS)
    // Its Resume took slot-a (B1's again, carried, kept for nothing); stopped, its writer released.
    check("…slot-a is B1's own again", !!(await until(async () => (await slots(alpha)).some((s) => s.name === 'slot-a' && s.lease?.kind === 'carried' && s.lease.agent === 'b1' && !s.writer), HUNG_MS)), JSON.stringify(await slots(alpha)))

    // The next lane: B1's own slot handed over to it (clean, merged into the target), and per-card lines.
    const next = await inv('lanes:start', alpha, { builder: 'b1', reviewer: 'r1', cards: [c3] })
    check("the next lane takes B1's slot-a over", next.slot === 'slot-a' && (await slots(alpha)).find((s) => s.name === 'slot-a')?.lease?.lane === next.lane?.id, JSON.stringify(next))
    const folder = path.join(root, next.slot ?? 'none')
    await until(async () => same((await live(alpha, 'b1'))?.cwd, folder) && (await idle(alpha, 'b1')), HUNG_MS)
    const s3 = await intent(await tokenOf(alpha, 'b1'), c3, 'start')
    check(`…card 3 is built there on its own line hive/${key}/${key}-${c3}-new-three`, s3.status === 200 && same(s3.body?.data?.folder, folder) && !!(await until(() => branchIn(folder) === `hive/${key}/${key}-${c3}-new-three`, HUNG_MS)), JSON.stringify(s3.body))

    // Me's first card under slots: the handoff, its conversation going on.
    const tMe = await tokenOf(solo, 'me')
    const sMe = await intent(tMe, cMe, 'start')
    check("Me's first card is built in its own worktree", sMe.status === 200 && same(sMe.body?.data?.folder, meTree), JSON.stringify(sMe.body))
    const handed = await until(async () => (await slots(solo)).find((s) => s.name === 'me' && s.lease?.kind === 'card'), HUNG_MS)
    check('…its slot handed over to the card', handed?.lease?.card === cMe && handed.lease.agent === 'me', JSON.stringify(await slots(solo)))
    check('…the same conversation going on', (await live(solo, 'me'))?.sessionId === meOld.sessionId && (await sessionOf(solo, meOld.sessionId))?.lease === handed?.lease?.id)
    // Combwork gives Me the card there once Me is quiet (slotCards.ts's placement, recorded as BuilderPlaced after the start's
    // reply). Waited for before the close: one cut short is owed at the restart, where Combwork starts Me itself with the
    // card's prompt and races Resume All (HI-1732).
    const placed = await until(async () => (await inv('tasks:facts', cMe)).find((f) => f.kind === 'BuilderPlaced'), HUNG_MS)
    check('…Combwork gives Me the card there, typed into that conversation', placed?.data?.how === 'typed' && (await live(solo, 'me'))?.sessionId === meOld.sessionId, JSON.stringify(placed))
    await close()

    // --- 3. A restart: Resume All resumes Me there, on its card's lease.
    await start()
    const meOffer3 = await resumeAllFor(solo, 'me')
    check("after a restart, Resume All offers Me's conversation (no hold)", meOffer3.offered && meOffer3.id === meOld.sessionId, meOffer3.why)
    const meAfter = await until(async () => ((await idle(solo, 'me')) ? live(solo, 'me') : null), HUNG_MS)
    check('after a restart, Resume All resumes Me in its worktree, the same conversation', same(meAfter?.cwd, meTree) && meAfter?.sessionId === meOld.sessionId, JSON.stringify(meAfter))
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    if (h) await h.app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
