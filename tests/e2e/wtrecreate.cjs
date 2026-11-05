// A worktree agent whose folder is gone (#146), outside any move. Starting it directly says what to do; from its
// pane, Start offers to recreate the worktree on its branch (still in the repository): made again with its commits, the
// project's setup command run first, and the agent starts. With the branch gone too, Start offers a new worktree on it
// (or removing the link) and makes it from the base. Removing the link leaves an agent in the project folder. With
// two worktrees missing, recreating one is refused rather than pruning the other's link. A recorded place that can't be
// used (a drive that isn't there): made at the agent's default place, its session following it. Dev build, throwaway profile
// and workspace, the fake Claude Code; quiet.
// Dev build only (#1580): it starts this checkout's Electron itself, and its agents are 0.9 worktree agents
// (agents:testLegacy, refused by a packaged build): recreating a 0.9 worktree is what it tests.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { sessionsOf, putSessions } = require('./storeDocs.cjs')

const userData = path.join(lib.WORK, 'wtrecreate-profile')
const ws = path.join(lib.WORK, 'wtrecreate-ws')
const proj = path.join(ws, 'gamma')
const wtRoot = path.join(`${ws}.worktrees`, 'gamma')
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const git = (cwd, args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, env: lib.gitEnv(), encoding: 'utf8' })
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(proj)
  const claude = lib.fakeClaude(userData, path.join(lib.WORK, 'wtrecreate-claude-home'), [path.join(wtRoot, 'keeper'), path.join(wtRoot, 'gone')])
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47938), ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1600, height: 950 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await inv('project:updateConfig', proj, { worktreeSetup: 'echo HIVE-SETUP-RAN' })
  const add = (name) => inv('agents:testLegacy', proj, { location: 'new-worktree', name })
  const keeper = await add('Keeper')
  const gone = await add('Gone')
  const p1 = await add('Pair One')
  const p2 = await add('Pair Two')
  const dropped = await add('Dropped')
  const mover = await add('Mover')
  await page.getByText('gamma', { exact: true }).first().click()
  // Work on Keeper's branch, committed in its worktree.
  fs.writeFileSync(path.join(keeper.worktree.path, 'work.txt'), 'kept\n')
  git(keeper.worktree.path, ['add', 'work.txt'])
  git(keeper.worktree.path, ['commit', '-qm', 'keeper work'])
  const agentNow = async (id) => (await inv('workspace:refresh')).projects.find((p) => p.name === 'gamma').agents.find((a) => a.id === id)
  const live = async (id) => (await inv('session:live')).find((s) => s.agentId === id)
  const pane = (name) => page.locator('.agent-pane', { has: page.locator('.pane-header-bar .agent-name', { hasText: name }) })

  // --- Keeper: folder deleted, branch kept.
  fs.rmSync(keeper.worktree.path, { recursive: true, force: true })
  const direct = await inv('session:start', proj, { agentId: keeper.id }).then(() => '', (e) => String(e.message ?? e))
  check('a direct start says the folder is missing and how to recreate it', /worktree folder is missing.*recreate the worktree on its branch/.test(direct), direct)
  const info = await inv('agents:missingWorktree', proj, keeper.id)
  check('…its branch is still there', info?.branchExists === true && info.branch === keeper.worktree.branch, JSON.stringify(info))
  await pane('Keeper').locator('.pane-placeholder .btn.act-start', { hasText: 'New Session' }).click()
  const recreate = page.getByRole('button', { name: 'Recreate and Start' })
  check('Start asks to recreate the worktree', !!(await lib.until(async () => (await recreate.count()) === 1, 10000)))
  await page.screenshot({ path: path.join(lib.WORK, 'wtrecreate-1-confirm.png') })
  await recreate.click()
  check('…the agent starts', !!(await lib.until(async () => !!(await live(keeper.id)), 20000)))
  const buf = (await lib.until(async () => {
    const b = await inv('pty:buffer', lib.ptyKey(proj, keeper.id))
    return b.includes('HIVE-SETUP-RAN') ? b : null
  }, 20000)) ?? ''
  check('…after the setup command ran, as for a new worktree', buf.includes('HIVE-SETUP-RAN'))
  await lib.acceptClaudeTrust(inv, proj, keeper.id, 20000)
  check('…in the worktree made again at its place, on its branch, with its commit', fs.existsSync(path.join(keeper.worktree.path, 'work.txt')) && git(keeper.worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === keeper.worktree.branch && git(keeper.worktree.path, ['log', '--oneline']).includes('keeper work'))
  check('…its session runs there', same((await live(keeper.id))?.cwd, keeper.worktree.path), (await live(keeper.id))?.cwd)
  await inv('session:stop', proj, keeper.id)
  await lib.until(async () => !(await live(keeper.id)), 10000)

  // --- Gone: folder and branch deleted.
  fs.rmSync(gone.worktree.path, { recursive: true, force: true })
  git(proj, ['worktree', 'prune'])
  git(proj, ['branch', '-D', gone.worktree.branch])
  check('with the branch gone too, it says so', (await inv('agents:missingWorktree', proj, gone.id))?.branchExists === false)
  await pane('Gone').locator('.pane-placeholder .btn.act-start', { hasText: 'New Session' }).click()
  const create = page.getByRole('button', { name: 'Create a New Worktree' })
  check('Start offers a new worktree, or removing the link', !!(await lib.until(async () => (await create.count()) === 1, 10000)) && (await page.getByRole('button', { name: 'Remove the Worktree Link' }).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'wtrecreate-2-gone.png') })
  await create.click()
  check('…the agent starts in a new worktree on its branch', !!(await lib.until(async () => !!(await live(gone.id)), 20000)) && fs.existsSync(gone.worktree.path) && git(gone.worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === gone.worktree.branch)
  await lib.acceptClaudeTrust(inv, proj, gone.id, 20000).catch(() => undefined)
  await inv('session:stop', proj, gone.id)
  await lib.until(async () => !(await live(gone.id)), 10000)

  // --- Two missing at once: recreating one would prune the other's link, so it is refused.
  fs.rmSync(p1.worktree.path, { recursive: true, force: true })
  fs.rmSync(p2.worktree.path, { recursive: true, force: true })
  const refused = await inv('agents:recreateWorktree', proj, p1.id).then(() => '', (e) => String(e.message ?? e))
  check('with two worktrees missing, recreating one is refused, naming the other', /would also drop git.s link to .*pair-two/i.test(refused), refused)
  check('…and git still has the other’s link', git(proj, ['worktree', 'list', '--porcelain']).toLowerCase().includes('pair-two'))

  // --- Mover: recorded on a drive that isn't there, so it is made at the agent's default place instead; its session
  // follows it there (the move kept with the new path until it has).
  const noDrive = ['Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y'].map((l) => `${l}:\\`).find((d) => !fs.existsSync(d))
  if (noDrive) {
    fs.rmSync(mover.worktree.path, { recursive: true, force: true })
    git(proj, ['worktree', 'prune'])
    const away = path.join(noDrive, 'combwork-test-missing', 'mover')
    const cfgFile = path.join(proj, '.combwork', 'project.json')
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    cfg.agents.find((a) => a.id === mover.id).worktree.path = away
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
    // The records are in the workspace's database (#1061).
    const sess = sessionsOf(proj)
    const now = new Date().toISOString()
    sess.sessions.push({ id: '11111111-2222-4333-8444-555555555555', agent: 'claude-code', name: 'Before', createdAt: now, lastActiveAt: now, archived: false, agentId: mover.id, cwd: away })
    putSessions(proj, sess)
    const def = await inv('agents:recreateWorktree', proj, mover.id)
    check('a place that can’t be used: made at the agent’s default worktree place', same(def.worktree?.path, mover.worktree.path) && fs.existsSync(path.join(mover.worktree.path, '.git')), JSON.stringify(def.worktree))
    check('…its session follows it there', sessionsOf(proj).sessions.some((x) => x.agentId === mover.id && same(x.cwd, mover.worktree.path)))
    check('…and nothing is left pending', !JSON.parse(fs.readFileSync(cfgFile, 'utf8')).pendingCopies)
  } else console.log('SKIP the unusable-place case: every drive letter Q–Y exists here')

  // --- Dropped: the link removed instead.
  fs.rmSync(dropped.worktree.path, { recursive: true, force: true })
  await inv('agents:unlinkWorktree', proj, dropped.id)
  check('Remove the worktree link: the agent works in the project folder', !(await agentNow(dropped.id)).worktree)

  await app.close()
  if (failed) console.log(`${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
