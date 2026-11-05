// Which skills and guidance each session gets, for each provider: project agents get the workspace's skills for agents
// (work-on-card, review-agent-work…) and Combwork's session contract; the Assistant gets the skills for it
// (coordinate-agents…) and its role, never the agents'. Codex agents get copies in their folder (.agents/skills/cw-*,
// marked, out of git), the Assistant's in the workspace folder; a changed skill reaches the next launch, swapped in
// whole; a folder of the user's with the same name is left alone. #1431: a session in a folder of its own (an agent's
// worktree, as a slot is) gets the copies there, removed once it stops (Slots only); the project folder keeps its own
// unless Everywhere; a skill switched off isn't copied, in Claude Code's plugin or named. Codex and Copilot share the
// copies' code (syncAgentsSkills), so the fake Codex runs it. Runs the fake Claude Code and fake Codex. Dev build,
// throwaway profile, workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
// Dev build only (#1580): it starts this checkout's Electron itself, and Treva is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build), for a folder of Combwork's other than the project's.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'skilldelivery-profile')
const ws = path.join(lib.WORK, 'skilldelivery-ws')
const claudeHome = path.join(lib.WORK, 'skilldelivery-claude-home')
const codexHome = path.join(lib.WORK, 'skilldelivery-codex-home')
const proj = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const AGENT_ONLY = ['work-on-card', 'review-agent-work', 'merge-ready']
const ASSISTANT_ONLY = ['coordinate-agents']
// HI-2012 (022a921c8) made use-cw-api's audience all.
const BOTH = ['handover', 'pick-up', 'split-work', 'workspace-note', 'use-cw-api']

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  // The workspace is a repository too (shared with a team), with the project a repository of its own inside it.
  fs.mkdirSync(ws, { recursive: true })
  require('child_process').execFileSync('git', ['init', '-q', ws], { env: lib.gitEnv() })
  lib.gitProject(proj)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([proj.toLowerCase(), ws.toLowerCase()]))
  // A folder of the user's where Combwork would put its copy of handover for Codex: never touched.
  fs.mkdirSync(path.join(proj, '.agents', 'skills', 'cw-handover'), { recursive: true })
  fs.writeFileSync(path.join(proj, '.agents', 'skills', 'cw-handover', 'SKILL.md'), '---\nname: my-handover\ndescription: Mine.\n---\nMY OWN\n')
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  cfg.settings.assistant = { ...cfg.settings.assistant, provider: 'codex' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47903), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  await lib.waitForProvider(inv, 'codex')
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
  const ready = (p, id) => until(async () => {
    const s = await live(p, id)
    if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(p, id), '\r')
    return ['ready', 'finished'].includes(s?.status)
  }, HUNG_MS)
  const copies = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('cw-')).map((f) => f.slice(3)).sort() : [])
  const codexLaunch = (cwd) => fs.readFileSync(path.join(codexHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.cwd.toLowerCase() === cwd.toLowerCase() && !['--version', 'login', 'app-server'].includes(l.args[0])).at(-1)
  const developer = (launch) => {
    const i = launch?.args.findIndex((a) => a.startsWith('developer_instructions=')) ?? -1
    return i >= 0 ? launch.args[i] : ''
  }

  // --- A Claude Code agent and a Codex agent in the project folder.
  const claude = await lib.addAgent(inv, proj, { name: 'Clara' })
  const codex = await lib.addAgent(inv, proj, { name: 'Cody', provider: 'codex' })
  await inv('session:start', proj, { agentId: claude.id })
  await inv('session:start', proj, { agentId: codex.id })
  check('both agents start', !!(await ready(proj, claude.id)) && !!(await ready(proj, codex.id)))
  const plugin = path.join(proj, '.combwork', `launch-${claude.id}`, 'plugin', 'skills')
  const claudeSkills = fs.readdirSync(plugin).sort()
  check('Claude Code: the skills for agents, in its own launch folder', [...AGENT_ONLY, ...BOTH].every((n) => claudeSkills.includes(n)) && !ASSISTANT_ONLY.some((n) => claudeSkills.includes(n)), claudeSkills.join(','))
  const codexDir = path.join(proj, '.agents', 'skills')
  const codexSkills = copies(codexDir)
  check('Codex: the same skills as cw-<name> copies in its folder', [...AGENT_ONLY, ...BOTH.filter((n) => n !== 'handover')].every((n) => codexSkills.includes(n)) && !ASSISTANT_ONLY.some((n) => codexSkills.includes(n)), codexSkills.join(','))
  check("…each marked as Combwork's", fs.existsSync(path.join(codexDir, 'cw-work-on-card', '.hive-copy')))
  check("a folder of the user's with a copy's name is left as it is", fs.readFileSync(path.join(codexDir, 'cw-handover', 'SKILL.md'), 'utf8').includes('MY OWN') && !fs.existsSync(path.join(codexDir, 'cw-handover', '.hive-copy')))
  check("Combwork's copies are kept out of git", fs.readFileSync(path.join(proj, '.git', 'info', 'exclude'), 'utf8').includes('/.agents/skills/cw-*/'))
  const told = developer(codexLaunch(proj))
  check('Codex is told the session contract: the board skills and their boundaries', /work-on-card skill/.test(told) && /review-agent-work/.test(told) && /Board rules\b.*\bcw_report_merge\b.*Never take a card out of On Hold unasked/.test(told) && !/coordinate-agents/.test(told), told.slice(0, 300))
  const status = await inv('workspace:refresh').then((w) => w.projects.find((p) => p.name === 'alpha').agents.find((a) => a.id === codex.id).live)
  check('the agent records what it launched with', /^[0-9a-f]{16}$/.test(status?.launched?.guidance ?? '') && !!status.launched.skills['work-on-card'], JSON.stringify(status?.launched))
  // What was delivered, not what was asked for: the user's own cw-handover kept Combwork's handover out.
  check("…and not a skill a folder of the user's kept out, saying why", !('handover' in (status?.launched?.skills ?? {})) && /folder of the user's/.test(status?.launched?.problems?.handover ?? ''), JSON.stringify(status?.launched))
  const agentNow = async () => (await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha').agents.find((a) => a.id === codex.id)
  check("…which doesn't make it look in need of a restart (a restart can't change it)", (await agentNow())?.restartNeeded === false)

  // --- A changed skill reaches the next launch, swapped in whole, and the agent is told to restart.
  const src = path.join(ws, '.combwork', 'skills', 'work-on-card', 'SKILL.md')
  fs.appendFileSync(src, '\nEDITED FOR THIS TEST\n')
  fs.mkdirSync(path.join(ws, '.combwork', 'skills', 'work-on-card', 'references'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.combwork', 'skills', 'work-on-card', 'references', 'board.md'), 'A reference.\n')
  // HI-2268: the window shows it by itself (the skills folder's watch refreshes it), before anything here refreshes it.
  const banner = page.locator('.banner.warn', { hasText: 'changed since' })
  check("the window's restart banner shows for the edited skill, with no refresh asked for", !!(await until(async () => (await banner.count()) === 1, HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'skilldelivery-restart-banner.png') })
  check('a running agent is marked to restart for it', !!(await until(async () => (await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha').agents.find((a) => a.id === codex.id)?.restartNeeded, 10000)))
  // Its Restart session restarts the agent it is shown for (the focused one), which then has the new version: it's gone.
  const runs = async () => Object.fromEntries((await inv('session:live')).filter((x) => x.projectPath.toLowerCase() === proj.toLowerCase()).map((x) => [x.agentId, x.runId]))
  const runsBefore = await runs()
  await banner.getByRole('button', { name: 'Restart session', exact: true }).click()
  const restarted = await until(async () => {
    const now = await runs()
    return [claude.id, codex.id].find((id) => now[id] && now[id] !== runsBefore[id])
  }, HUNG_MS)
  check("…the banner's Restart session restarts the agent it is shown for", !!restarted, JSON.stringify(runsBefore))
  if (restarted) await ready(proj, restarted)
  const settledAgent = async () => (await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha').agents.find((a) => a.id === restarted)
  check('…which, restarted with the new version, needs no restart: the banner is gone', !!restarted && !!(await until(async () => (await settledAgent())?.restartNeeded === false && (await banner.count()) === 0, HUNG_MS)), JSON.stringify({ restartNeeded: (await settledAgent())?.restartNeeded, banners: await banner.count() }))
  await inv('session:stop', proj, codex.id)
  await until(async () => !(await live(proj, codex.id)), HUNG_MS)
  await inv('session:start', proj, { agentId: codex.id })
  await ready(proj, codex.id)
  const copy = path.join(codexDir, 'cw-work-on-card')
  check('the next launch has the new version, with its references', fs.readFileSync(path.join(copy, 'SKILL.md'), 'utf8').includes('EDITED FOR THIS TEST') && fs.existsSync(path.join(copy, 'references', 'board.md')) && fs.existsSync(path.join(copy, '.hive-copy')))
  check('…and no half-made copies are left beside it', !fs.readdirSync(codexDir).some((f) => f.startsWith('.')), fs.readdirSync(codexDir).join(','))

  // --- The Assistant on Codex: its skills in the workspace folder, where it works, and its role in its instructions.
  // The fake Codex is a .cmd launcher, as npm's codex.cmd is: Combwork starts its node and script directly, since the
  // Assistant's command line (hooks, instructions, the hive server) is longer than cmd.exe's 8,191 characters.
  const home = (await inv('workspace:refresh')).assistant.path
  await inv('session:start', home, { agentId: 'assistant' })
  check('the Assistant starts on Codex through its .cmd launcher', !!(await ready(home, 'assistant')))
  const assistantLaunch = codexLaunch(ws)
  const assistantTold = developer(assistantLaunch)
  check("its command line is longer than cmd.exe's limit, so it didn't go through cmd.exe", assistantLaunch?.args.join(' ').length > 8191, String(assistantLaunch?.args.join(' ').length))
  check("it's told its control level and to use coordinate-agents, and not the agents' card rules", /Control agents and create projects/.test(assistantTold) && /coordinate-agents skill/.test(assistantTold) && !/work-on-card/.test(assistantTold), assistantTold.slice(0, 300))
  const wsSkills = path.join(ws, '.agents', 'skills')
  const wsCopies = copies(wsSkills)
  check('the Assistant gets the skills for it, in the workspace folder', [...ASSISTANT_ONLY, ...BOTH].every((n) => wsCopies.includes(n)) && !AGENT_ONLY.some((n) => wsCopies.includes(n)), wsCopies.join(','))
  check("…kept out of the workspace's git too", fs.readFileSync(path.join(ws, '.git', 'info', 'exclude'), 'utf8').includes('/.agents/skills/cw-*/'))

  await inv('session:stop', home, 'assistant').catch(() => undefined)

  // --- #1431: copies per folder, removed safely once no agent works there (Settings → Advanced), and a choice of skills.
  const stopped = async (p, id) => {
    await inv('session:stop', p, id)
    return !!(await until(async () => !(await live(p, id)), HUNG_MS))
  }
  // Copies go only once no agent of Combwork's works in the folder: Clara's session in the project folder is stopped first.
  check('the Claude Code agent stops', await stopped(proj, claude.id))
  // A folder of Combwork's other than the project folder (a slot; today an agent's worktree), with a skill of the user's in it.
  const tree = await lib.addAgent(inv, proj, { name: 'Treva', provider: 'codex', location: 'new-worktree' })
  const treeDir = (await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha').agents.find((a) => a.id === tree.id).worktree.path
  const treeSkills = path.join(treeDir, '.agents', 'skills')
  fs.mkdirSync(path.join(treeSkills, 'mine'), { recursive: true })
  fs.writeFileSync(path.join(treeSkills, 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine.\n---\nMY OWN\n')
  await inv('session:start', proj, { agentId: tree.id })
  check('a session in a folder of its own gets the copies there', !!(await ready(proj, tree.id)) && copies(treeSkills).includes('work-on-card'), copies(treeSkills).join(','))
  check('…and they are gone once it stops (Slots only, the default)', (await stopped(proj, tree.id)) && !!(await until(async () => copies(treeSkills).length === 0, HUNG_MS)), copies(treeSkills).join(','))
  check("…leaving the user's own skill there", fs.readFileSync(path.join(treeSkills, 'mine', 'SKILL.md'), 'utf8').includes('MY OWN'))
  check('the project folder keeps its copies when its agent stops', (await stopped(proj, codex.id)) && copies(codexDir).includes('work-on-card'), copies(codexDir).join(','))

  // Everywhere: the project folder's go too, and the user's folder named like a copy stays.
  await inv('advanced:set', 'cw.skills.removeIdleCopies', 'everywhere')
  await inv('session:start', proj, { agentId: codex.id })
  await ready(proj, codex.id)
  check('Everywhere: the project folder loses them too once its last agent stops', (await stopped(proj, codex.id)) && !!(await until(async () => copies(codexDir).join(',') === 'handover', HUNG_MS)), copies(codexDir).join(','))
  check("…but never the user's folder named like a copy", fs.readFileSync(path.join(codexDir, 'cw-handover', 'SKILL.md'), 'utf8').includes('MY OWN'))
  await inv('advanced:set', 'cw.skills.removeIdleCopies', null)

  // A skill switched off for the project isn't delivered at the next launch: not copied, not in Claude Code's plugin, not
  // named in the guidance. Its copy stays while another agent of Combwork's works in the folder (it may be reading it), and
  // goes at a launch with the folder to itself.
  const other = await lib.addAgent(inv, proj, { name: 'Sena', provider: 'codex' })
  await inv('session:start', proj, { agentId: other.id })
  check('another agent in the project folder gets every skill', !!(await ready(proj, other.id)) && copies(codexDir).includes('card-loop'), copies(codexDir).join(','))
  await inv('skills:setDelivered', proj, 'card-loop', false)
  await inv('session:start', proj, { agentId: codex.id })
  await ready(proj, codex.id)
  check("a skill switched off isn't named in the next launch's guidance", /work-on-card skill/.test(developer(codexLaunch(proj))) && !/card-loop/.test(developer(codexLaunch(proj))))
  check('…and its copy stays while the other agent there still runs', !!(await live(proj, other.id)) && fs.existsSync(path.join(codexDir, 'cw-card-loop', 'SKILL.md')), copies(codexDir).join(','))
  check('the other agent stops', await stopped(proj, other.id))
  check('the agent stops', await stopped(proj, codex.id))
  await inv('session:start', proj, { agentId: codex.id })
  await ready(proj, codex.id)
  check('a launch with the folder to itself no longer has it copied', copies(codexDir).includes('work-on-card') && !copies(codexDir).includes('card-loop'), copies(codexDir).join(','))
  await inv('session:start', proj, { agentId: claude.id })
  await ready(proj, claude.id)
  const pluginNow = fs.readdirSync(plugin)
  check("…nor in Claude Code's launch plugin", pluginNow.includes('work-on-card') && !pluginNow.includes('card-loop'), pluginNow.join(','))
  await page.screenshot({ path: path.join(lib.WORK, 'skilldelivery-advanced.png') })

  for (const id of [claude.id, codex.id]) await inv('session:stop', proj, id).catch(() => undefined)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
