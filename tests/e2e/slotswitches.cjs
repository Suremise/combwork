// P7's default-on switches turned off, in the app (#1563, tests/workflow/README.md's P7 table; slotcards and slotupgrade
// have them on): Pair with Hive merges, each card in its own folder, fake Claude Code agents, a temp Git project whose
// package-lock.json card 1 changes, the slots' setup a script that records each install:
// - Slots are brought up to date before each card (G15) off: a lane of two cards in slot-a; card 2 starts there from
//   the new target, and nothing is installed for it (slot-a's setup ran once, as it was made);
// - Delete a card's branch once it's merged off (Settings → Advanced): card 1's merged line is kept as slot-a moves on;
// - Rename adopted worktrees to slot names off: an adopted worktree (hb2), free all along, keeps its name;
// - both turned on, the next pass deletes card 1's line (LineDeleted) and renames hb2 to a slot name.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1580): hb2 is carried and released through slots:test, which a packaged build refuses.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const at = (x) => path.join(lib.WORK, `slotswitches-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const tools = at('tools')
const alpha = path.join(ws, 'alpha')
const root = path.join(`${ws}.worktrees`, 'alpha')
const slotA = path.join(root, 'slot-a')
const hb2 = path.join(root, 'hb2')
const setupLog = path.join(tools, 'setup.log')
const PORT = Number(lib.port(47811))
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
const installs = () => (fs.existsSync(setupLog) ? fs.readFileSync(setupLog, 'utf8').trim().split('\n').filter((l) => l.startsWith('slot-')) : [])

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, tools]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(tools, { recursive: true })
  lib.gitProject(alpha, { 'a.txt': 'a\n', 'package-lock.json': '{"v":1}\n', '.gitignore': '.hive/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.git(alpha, ['branch', 'integration'])
  // The identity its commits use, in its git config: G12 reads it from git each time (HI-2266, HI-2283).
  lib.git(alpha, ['config', 'user.name', identity.name])
  lib.git(alpha, ['config', 'user.email', identity.email])
  const setup = path.join(tools, 'setup.js')
  fs.writeFileSync(setup, `require('fs').appendFileSync(${JSON.stringify(setupLog)}, process.env.CW_SLOT + ' ' + require('fs').readFileSync('package-lock.json', 'utf8').trim() + '\\n')\n`)
  const env = lib.fakeClaude(userData, home, [alpha, ws, slotA])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' } })
  const { app, page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    // Pair with Hive merges into integration (checked out nowhere), cards in slots, G15 off.
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'hiveMerges', folder: 'slots', target: 'integration', style: 'merge', preChecks: [], mergeChecks: [], identity, okBefore: { mode: 'never', labels: [] }, slotsUpToDate: false } })
    check('G15 (Slots are brought up to date before each card) is off', (await inv('workflow:form', alpha))?.options?.slotsUpToDate === false, JSON.stringify((await inv('workflow:form', alpha))?.options))
    await inv('advanced:set', 'hive.slots.deleteMergedLines', false)
    await inv('advanced:set', 'hive.slots.renameAdopted', false)
    await inv('project:updateConfig', alpha, { slots: { setup: `node "${setup}"` } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
    const launches = () => {
      const f = path.join(home, 'fake-launches.jsonl')
      const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    }
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
    const kinds = async (n) => (await inv('tasks:facts', n)).map((f) => f.kind)
    const slots = () => inv('slots:list', alpha)
    const branchIn = (dir) => git(dir, 'branch', '--show-current')
    const hasLine = (line) => {
      try {
        git(alpha, 'rev-parse', '--verify', '-q', `refs/heads/${line}`)
        return true
      } catch {
        return false
      }
    }
    const create = async (title) => (await inv('tasks:create', { title, project: 'alpha' })).number
    const c1 = await create('Switch one')
    const c2 = await create('Switch two')
    const key = (await card(c1)).key.split('-')[0]
    const line = (n, slug) => `hive/${key}/${key}-${n}-${slug}`

    // --- A lane of two cards in slot-a.
    const started = await inv('lanes:start', alpha, { builder: b1.id, reviewer: r1.id, cards: [c1, c2] })
    check('the lane is lent slot-a, and both agents start', started.slot === 'slot-a' && started.started.every((s) => s.how !== 'failed'), JSON.stringify(started))
    check("slot-a's setup ran as it was made", !!(await until(() => installs().length === 1, HUNG_MS)) && installs()[0] === 'slot-a {"v":1}', JSON.stringify(installs()))
    // An adopted worktree (as the upgrade carries an agent's own), free from here on.
    lib.git(alpha, ['worktree', 'add', '-q', '-b', 'hive/hb2', hb2, 'integration'])
    const carried = await inv('slots:test', alpha, { op: 'carry', agent: 'someone', slot: 'hb2', folder: hb2 })
    check('hb2 is adopted as a slot', !!carried?.id && (await inv('slots:test', alpha, { op: 'release', lease: carried.id, why: 'done' })) === true, JSON.stringify(carried))
    check('…and free, ready, under its own name', !!(await until(async () => (await slots()).some((s) => s.name === 'hb2' && s.state === 'ready' && !s.lease), HUNG_MS)), JSON.stringify(await slots()))

    await until(async () => same((await live(b1.id))?.cwd, slotA), HUNG_MS)
    const tb1 = await tokenOf(b1.id)
    const tr1 = await tokenOf(r1.id)
    const s1 = await intent(tb1, c1, 'start')
    check("card 1 starts in slot-a, on its line", s1.status === 200 && same(s1.body?.data?.folder, slotA) && !!(await until(() => branchIn(slotA) === line(c1, 'switch-one'), HUNG_MS)), JSON.stringify(s1.body))
    commitIn(slotA, { 'one.txt': 'one\n', 'package-lock.json': '{"v":2}\n' }, 'Switch one')
    check('B1 submits card 1; R1 passes it', (await intent(tb1, c1, 'submit', { summary: 'Switch one: ready' })).status === 200 && (await intent(tr1, c1, 'start-review')).status === 200 && (await intent(tr1, c1, 'verdict', { pass: true, comment: 'Switch one: passed' })).status === 200)
    check("Hive's queue merges card 1: Done", !!(await until(async () => (await card(c1))?.column === 'done', HUNG_MS)), (await card(c1))?.column)

    // --- Card 2 in slot-a: G15 off, nothing installed; card 1's merged line kept.
    const s2 = await intent(tb1, c2, 'start')
    const base2 = git(alpha, 'rev-parse', 'integration')
    check("card 2 starts in slot-a from the target as it is now (card 1 in it)", s2.status === 200 && !!(await until(async () => branchIn(slotA) === line(c2, 'switch-two') && (await kinds(c2)).includes('SlotPrepared'), HUNG_MS)) && git(slotA, 'rev-parse', 'HEAD') === base2, JSON.stringify({ s2: s2.body, branch: branchIn(slotA), facts: await kinds(c2) }))
    check('G15 off: nothing installed for card 2, though the lock file changed', JSON.stringify(installs()) === JSON.stringify(['slot-a {"v":1}']), JSON.stringify(installs()))
    check("Delete a card's branch once it's merged off: card 1's merged line is kept", hasLine(line(c1, 'switch-one')) && !(await kinds(c1)).some((k) => k === 'LineDeleted' || k === 'LineDeleting'), JSON.stringify(await kinds(c1)))
    check('Rename adopted worktrees off: hb2, free, keeps its name and folder', (await slots()).some((s) => s.name === 'hb2' && same(s.folder, hb2)) && fs.existsSync(hb2), JSON.stringify(await slots()))

    // --- Both on: the next pass (a board change) deletes the line and renames hb2.
    await inv('advanced:set', 'hive.slots.deleteMergedLines', true)
    await inv('advanced:set', 'hive.slots.renameAdopted', true)
    await create('Switch three')
    check("turned on, card 1's merged line is deleted, and noted on card 1", !!(await until(async () => !hasLine(line(c1, 'switch-one')) && (await kinds(c1)).includes('LineDeleted'), HUNG_MS)), JSON.stringify(await kinds(c1)))
    check("…card 2's line, checked out in slot-a, is kept", hasLine(line(c2, 'switch-two')))
    const renamed = await until(async () => (await slots()).find((s) => /^slot-[b-z]$/.test(s.name)), HUNG_MS)
    check('…and hb2 is renamed to a slot name, its folder moved', !!renamed && !(await slots()).some((s) => s.name === 'hb2') && !fs.existsSync(hb2) && same(renamed.folder, path.join(root, renamed.name)), JSON.stringify(await slots()))
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
