// 0.9.3's agent field after the type's removal (#1452, SPEC §16.10.3 Built [#1452]), on fake Claude Code agents. A Git
// project's project.json as 0.9.3 left it: B1 and B2 with their own worktrees (`worktree`, B2's setup still to run,
// `needsSetup`), R1 in the project folder.
// 1. It opens, and the upgrade (#1441) makes each worktree a slot carried by its agent: B1 starts there, and its pane
//    says "carried: hb1".
// 2. Renaming B1 and changing its model in Agent Settings, reordering the agents and saving B2's settings: the stored
//    `worktree` (and B2's `needsSetup`) are byte-identical in project.json, so a return to 0.9.3 finds them.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 45000

const at = (x) => path.join(lib.WORK, `legacyworktree-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const alpha = path.join(ws, 'alpha')
const root = path.join(`${ws}.worktrees`, 'alpha')
const hb1 = path.join(root, 'hb1')
const hb2 = path.join(root, 'hb2')
const file = path.join(alpha, '.combwork', 'project.json')
const PORT = Number(lib.port(47807))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
/** The agents as project.json stores them now. */
const stored = () => JSON.parse(fs.readFileSync(file, 'utf8')).agents
/** 0.9.3's fields of each agent, as written (the bytes JSON gives them). */
const legacyBytes = () => Object.fromEntries(stored().map((a) => [a.id, JSON.stringify({ worktree: a.worktree, needsSetup: a.needsSetup })]))

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'a.txt': 'a\n', '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.git(alpha, ['worktree', 'add', '-q', '-b', 'cw/hb1', hb1, 'main'])
  lib.git(alpha, ['worktree', 'add', '-q', '-b', 'cw/hb2', hb2, 'main'])
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  // As 0.9.3 wrote it (its field order too).
  const agents = [
    { id: 'b1', name: 'B1', provider: 'claude-code', worktree: { path: hb1, branch: 'cw/hb1', base: 'main' }, workflowRole: 'builder' },
    { id: 'b2', name: 'B2', provider: 'claude-code', worktree: { path: hb2, branch: 'cw/hb2', base: 'main' }, needsSetup: true, workflowRole: 'builder' },
    { id: 'r1', name: 'R1', provider: 'claude-code', workflowRole: 'reviewer' }
  ]
  fs.writeFileSync(file, JSON.stringify({ version: 2, platform: 'git', agents }, null, 2))
  const before = legacyBytes()
  // Each agent's fields as they were (in any order of the agents).
  const sameLegacy = () => { const now = legacyBytes(); return Object.keys(before).every((id) => now[id] === before[id]) }
  const env = lib.fakeClaude(userData, home, [alpha, ws, hb1, hb2])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let h = null
  try {
    h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' }, viewport: { width: 1400, height: 850 } })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    const { inv, page } = h
    const until = (fn, ms) => lib.until(fn, ms, 250)
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    await lib.fitWindow(h.app, page, { width: 1400, height: 850 })
    const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    const agentInfo = async (id) => (await inv('workspace:refresh')).projects.find((p) => same(p.path, alpha))?.agents.find((a) => a.id === id)

    // --- 1. Opened and upgraded: each worktree a slot carried by its agent.
    const slots = await until(async () => {
      const list = await inv('slots:list', alpha)
      return ['hb1', 'hb2'].every((n) => list.find((s) => s.name === n)?.lease?.kind === 'carried') ? list : null
    }, HUNG_MS)
    check("the upgrade makes B1's and B2's worktrees slots carried by them", !!slots && slots.find((s) => s.name === 'hb1').lease.agent === 'b1' && slots.find((s) => s.name === 'hb2').lease.agent === 'b2', JSON.stringify(await inv('slots:list', alpha)))
    check('…and leaves 0.9.3\'s fields as they were', sameLegacy(), JSON.stringify(legacyBytes()))
    await inv('session:start', alpha, { agentId: 'b1' })
    const s1 = await until(async () => ((await idle('b1')) ? live('b1') : null), HUNG_MS)
    check('B1 works from its carried slot', same(s1?.cwd, hb1) && s1?.slot === 'hb1', JSON.stringify(s1))
    check('…its pane says "carried: hb1"', !!(await until(async () => (await lib.paneHeader(page, 'B1').locator('.agent-place').innerText().catch(() => '')) === 'carried: hb1', HUNG_MS)), JSON.stringify((await agentInfo('b1'))?.place))

    // --- 2. Agent Settings: B1 renamed, saved (its model is its connection's since HI-2108: none of its own).
    await lib.agentMenu(page, 'B1')
    await page.locator('.menu-item', { hasText: 'Agent Settings…' }).click()
    const dialog = page.locator('.dialog', { hasText: 'B1 settings' })
    check('Agent Settings opens', !!(await until(async () => (await dialog.count()) === 1, HUNG_MS)))
    await dialog.locator('input.input').first().fill('B1 renamed')
    await dialog.locator('button.primary', { hasText: 'Save' }).click()
    const b1 = await until(async () => {
      const a = stored().find((x) => x.id === 'b1')
      return a.name === 'B1 renamed' ? a : null
    }, HUNG_MS)
    check('Agent Settings saved B1\'s new name', !!b1, JSON.stringify(stored().find((x) => x.id === 'b1')))
    check("…and its stored worktree is byte-identical", legacyBytes().b1 === before.b1, legacyBytes().b1)

    // The agents reordered (a whole list written), and B2's settings saved with nothing changed.
    await inv('agents:move', alpha, 'r1', 0)
    check('…reordered', !!(await until(() => stored()[0].id === 'r1', HUNG_MS)), JSON.stringify(stored().map((a) => a.id)))
    // B2 moved to a connection with another model (HI-2122: the model is its connection's).
    await lib.setLaunch(inv, alpha, 'b2', { model: 'opus' })
    const modelOfB2 = () => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).connections?.find((c) => c.id === stored().find((a) => a.id === 'b2').connection)?.model
    check("…B2's model saved, on its connection", !!(await until(() => modelOfB2() === 'opus', HUNG_MS)), String(modelOfB2()))
    check("after every save, both agents' 0.9.3 fields are byte-identical (B2's needsSetup too)", sameLegacy(), `${JSON.stringify(before)} → ${JSON.stringify(legacyBytes())}`)
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h?.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
