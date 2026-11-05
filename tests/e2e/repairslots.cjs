// Repair a Moved Workspace on slots (#1447, SPEC §16.10.2), on fake Claude Code agents, the Assistant off: alpha (Pair
// with Combwork merges into integration, cards in slots) with B1's 0.9 worktree hb1 (adopted: carried), R1's own worktree
// hr1 (a retired home), a lane of B2's whose card started in slot-a, and a review copy copy-1. B1 has a conversation in
// hb1. The workspace and its worktrees folder are moved together; Combwork opens it there:
// - the plan names each by its slot, copy or home ("hb2 (carried, HB2)", "slot-a (B2, AL-1)", "copy-1", "R1's old
//   folder"), screenshots in light and dark;
// - Repair relinks them all: git lists them at their new folders, their rows follow, the card in slot-a follows its
//   folder (FolderMoved, never Gone: folder), B1's conversation in hb1 resumes there, and the lane carries on (B2's
//   card submitted, passed and merged).
// Dev build, throwaway profile, folders and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const at = (x) => path.join(lib.WORK, `repairslots-${x}`)
const userData = at('profile')
const home = at('claude-home')
const shots = at('shots')
const before = at('before')
const after = at('after')
const wsOf = (root) => path.join(root, 'ws')
const treesOf = (root) => path.join(root, 'ws.worktrees', 'alpha')
const PORT = Number(lib.port(47936))
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
  for (const d of [userData, home, shots, before, after]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  const alpha0 = path.join(wsOf(before), 'alpha')
  lib.gitProject(alpha0, { 'a.txt': 'a\n', '.gitignore': '.combwork/\n' })
  lib.git(alpha0, ['branch', '-M', 'main'])
  lib.git(alpha0, ['branch', 'integration'])
  // The identity its commits use, in its git config: G12 reads it from git each time (HI-2266, HI-2283).
  lib.git(alpha0, ['config', 'user.name', identity.name])
  lib.git(alpha0, ['config', 'user.email', identity.email])
  lib.git(alpha0, ['worktree', 'add', '-q', '-b', 'cw/hb1', path.join(treesOf(before), 'hb1'), 'integration'])
  lib.git(alpha0, ['worktree', 'add', '-q', '-b', 'cw/hr1', path.join(treesOf(before), 'hr1'), 'main'])
  fs.mkdirSync(path.join(alpha0, '.combwork'), { recursive: true })
  fs.writeFileSync(
    path.join(alpha0, '.combwork', 'project.json'),
    JSON.stringify({
      version: 2,
      platform: 'git',
      agents: [
        { id: 'b1', name: 'B1', provider: 'claude-code', workflowRole: 'builder', worktree: { path: path.join(treesOf(before), 'hb1'), branch: 'cw/hb1', base: 'integration' } },
        { id: 'r1', name: 'R1', provider: 'claude-code', workflowRole: 'reviewer', worktree: { path: path.join(treesOf(before), 'hr1'), branch: 'cw/hr1', base: 'main' } },
        { id: 'b2', name: 'B2', provider: 'claude-code', workflowRole: 'builder' }
      ]
    }, null, 2)
  )
  const folders = (root) => [wsOf(root), path.join(wsOf(root), 'alpha'), ...['hb1', 'hr1', 'slot-a', 'slot-b'].map((n) => path.join(treesOf(root), n))]
  const env = lib.fakeClaude(userData, home, [...folders(before), ...folders(after)])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let h = null
  const start = async (wsPath) => {
    h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' }, viewport: { width: 1500, height: 900 } })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(h.inv)
    await lib.openWorkspace(h.inv, h.page, wsPath)
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
  const themed = async (name) => {
    for (const theme of ['light', 'dark']) {
      await inv('settings:update', { appearance: { theme } })
      await until(() => h.page.evaluate((t) => document.documentElement.dataset.theme === t, theme), HUNG_MS)
      await h.page.screenshot({ path: path.join(shots, `repairslots-${name}-${theme}.png`) })
    }
  }

  try {
    // --- Before the move: the slots, a lane on slot-a, B1's conversation in hb1.
    await start(wsOf(before))
    const alpha = path.join(wsOf(before), 'alpha')
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'hiveMerges', folder: 'slots', target: 'integration', style: 'merge', preChecks: [], mergeChecks: [], identity, okBefore: { mode: 'never', labels: [] } } })
    const c1 = (await inv('tasks:create', { title: 'Moved along', project: 'alpha' })).number
    const key = (await card(c1)).key
    const hb1 = await until(async () => (await inv('slots:list', alpha)).find((s) => s.name === 'hb1' && s.lease?.kind === 'carried'), HUNG_MS)
    check('hb1 is B1’s carried slot', !!hb1, JSON.stringify(await inv('slots:list', alpha)))
    await inv('session:start', alpha, { agentId: 'b1' })
    const b1 = await until(async () => ((await idle(alpha, 'b1')) && same((await live(alpha, 'b1'))?.cwd, path.join(treesOf(before), 'hb1')) ? live(alpha, 'b1') : null), HUNG_MS)
    check('B1 has a conversation in hb1', !!b1, JSON.stringify(await live(alpha, 'b1')))
    const lane = await inv('lanes:start', alpha, { builder: 'b2', reviewer: 'r1', cards: [c1] })
    check('B2’s lane is lent slot-a', lane.slot === 'slot-a', JSON.stringify(lane))
    const slotA = path.join(treesOf(before), 'slot-a')
    await until(async () => same((await live(alpha, 'b2'))?.cwd, slotA) && (await idle(alpha, 'b2')), HUNG_MS)
    const tb2Before = await tokenOf(alpha, 'b2')
    // B2 in a turn (until a file the test never makes): its card's slot is prepared only once it is quiet, so the
    // preparation is still owed as Combwork closes, and runs after Repair (HI-1791: in slot-a's new folder).
    await lib.typeLine(inv, lib.ptyKey(alpha, 'b2'), home, null, 'holduntil repairslots-never', { live: () => live(alpha, 'b2') })
    check('…B2 in its turn', !!(await until(async () => (await live(alpha, 'b2'))?.status === 'working', HUNG_MS)))
    const s1 = await intent(tb2Before, c1, 'start')
    check(`${key} starts in slot-a`, s1.status === 200 && same(s1.body?.data?.folder, slotA), JSON.stringify(s1.body))
    check('…its preparation owed as Combwork closes (B2 busy)', !(await inv('tasks:facts', c1)).some((f) => f.kind === 'SlotPrepared') && (await live(alpha, 'b2'))?.status === 'working', JSON.stringify((await inv('tasks:facts', c1)).map((f) => f.kind)))
    await h.app.close()
    h = null
    // A review copy, as #1435's pool keeps one (its worktree, detached, and its row).
    const copy = path.join(treesOf(before), 'copies', 'copy-1')
    lib.git(alpha0, ['worktree', 'add', '-q', '--detach', copy])
    const id = JSON.parse(fs.readFileSync(path.join(alpha0, '.combwork', 'project.json'), 'utf8')).id
    const db = new DatabaseSync(path.join(wsOf(before), '.combwork', 'combwork.db'), { timeout: 5000 })
    try {
      const now = new Date().toISOString()
      db.prepare("INSERT INTO copies (project, name, folder, state, created_at, used_at) VALUES (?, 'copy-1', ?, 'free', ?, ?)").run(id, copy, now, now)
    } finally {
      db.close()
    }

    // --- The move: the workspace and its worktrees folder together.
    fs.mkdirSync(after, { recursive: true })
    fs.renameSync(wsOf(before), wsOf(after))
    fs.renameSync(path.join(before, 'ws.worktrees'), path.join(after, 'ws.worktrees'))
    await start(wsOf(after))
    const alpha2 = path.join(wsOf(after), 'alpha')
    const banner = h.page.locator('.moved-banner')
    check('the banner offers Repair…', !!(await until(async () => (await banner.count()) === 1, HUNG_MS)))
    await h.page.locator('.moved-banner button', { hasText: 'Repair…' }).click()
    const dialog = h.page.locator('.dialog', { has: h.page.locator('.move-repair') })
    const text = async () => (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ')
    check(
      'the plan names each by its slot, copy or home',
      !!(await until(async () => /hb1 \(carried, B1\)/.test(await text()) && new RegExp(`slot-a \\(B2, ${key}\\)`).test(await text()) && /copy-1/.test(await text()) && /R1.s old folder/.test(await text()), HUNG_MS)),
      await text()
    )
    check('…no agent’s worktree row for B1 or R1 (the migration took them over)', !/B1.s worktree|R1.s worktree/.test(await text()), await text())
    await themed('plan')
    await dialog.locator('button', { hasText: /^Repair$/ }).click()
    check('Repair finishes with nothing left', !!(await until(async () => /Repaired\./.test(await text()) && !/with problems/.test(await text()), HUNG_MS)), await text())
    await themed('report')
    await dialog.locator('button', { hasText: 'Close' }).click()
    const listed = git(alpha2, 'worktree', 'list', '--porcelain').toLowerCase().replace(/\//g, '\\')
    for (const n of ['hb1', 'hr1', 'slot-a', path.join('copies', 'copy-1')]) check(`git lists ${n} at its new folder`, listed.includes(path.join(treesOf(after), n).toLowerCase()), listed)
    const slots = await inv('slots:list', alpha2)
    check('…and the slots’ rows follow', ['hb1', 'slot-a'].every((n) => same(slots.find((s) => s.name === n)?.folder, path.join(treesOf(after), n))), JSON.stringify(slots))
    const facts = await inv('tasks:facts', c1)
    check(`${key}'s folder follows slot-a (FolderMoved), never Gone: folder`, facts.some((f) => f.kind === 'FolderMoved' && same(f.data?.to, path.join(treesOf(after), 'slot-a'))) && !facts.some((f) => f.kind === 'Gone' && f.data?.what === 'folder'), JSON.stringify(facts.map((f) => [f.kind, f.data?.what])))
    // The preparation owed from before the move, then B2's placement, after Repair (B2 not running: its conversation in
    // slot-a resumed there with the card, HI-1746).
    const kindsNow = async () => (await inv('tasks:facts', c1)).map((f) => f.kind)
    check(`…${key}'s slot prepared after Repair, and B2 placed there`, !!(await until(async () => {
      const k = await kindsNow()
      return k.filter((x) => x === 'SlotPrepared').length === 1 && k.filter((x) => x === 'BuilderPlaced').length === 1
    }, HUNG_MS)), JSON.stringify(await kindsNow()))
    // Fenced and logged at slot-a where it is now, never at the folder from before the move (HI-1791).
    const log = fs.readFileSync(path.join(userData, 'logs', 'combwork.log'), 'utf8')
    const preparing = log.slice(log.lastIndexOf('Repairing a move')).split(/\r?\n/).filter((l) => l.includes('preparing a slot'))
    check('…its preparation fenced slot-a at its new folder, never the old one (HI-1791)', preparing.length > 0 && preparing.every((l) => l.toLowerCase().includes(path.join(treesOf(after), 'slot-a').toLowerCase())), JSON.stringify(preparing))

    // B1's conversation in hb1 resumes there; the lane carries on.
    const rec = (await inv('session:list', alpha2)).find((s) => s.id === b1.sessionId)
    check('B1’s conversation is recorded in hb1’s new folder', same(rec?.cwd, path.join(treesOf(after), 'hb1')), JSON.stringify(rec))
    await inv('session:start', alpha2, { agentId: 'b1', resumeId: b1.sessionId })
    const b1Back = await until(async () => ((await idle(alpha2, 'b1')) ? live(alpha2, 'b1') : null), HUNG_MS)
    check('…and resumes there', same(b1Back?.cwd, path.join(treesOf(after), 'hb1')) && b1Back?.sessionId === b1.sessionId, JSON.stringify(b1Back))
    if (!(await live(alpha2, 'b2'))) await inv('session:start', alpha2, { agentId: 'b2' })
    const b2Back = await until(async () => ((await idle(alpha2, 'b2')) ? live(alpha2, 'b2') : null), HUNG_MS)
    check('B2 runs in slot-a’s new folder', same(b2Back?.cwd, path.join(treesOf(after), 'slot-a')), JSON.stringify(b2Back))
    const rev = commitIn(path.join(treesOf(after), 'slot-a'), { 'moved.txt': 'moved\n' }, 'Moved along')
    const tb2 = await tokenOf(alpha2, 'b2')
    if (!(await live(alpha2, 'r1'))) await inv('session:start', alpha2, { agentId: 'r1' })
    const tr1 = await tokenOf(alpha2, 'r1')
    const passed = (await intent(tb2, c1, 'submit', { summary: 'Moved along' })).status === 200 && (await intent(tr1, c1, 'start-review')).status === 200 && (await intent(tr1, c1, 'verdict', { pass: true, comment: 'Moved along: passed' })).status === 200
    check('the lane carries on: submitted, reviewed and passed', passed)
    check('…and merged by Combwork’s queue', !!(await until(async () => (await card(c1))?.column === 'done', HUNG_MS)) && isIn(alpha2, rev, 'integration'), (await card(c1))?.column)
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    if (h) await h.app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
