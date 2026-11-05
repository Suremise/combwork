// Multiple agents per project: add agents (project folder + new worktree), setup command, sessions in
// both, layouts, file locks (synthetic PreToolUse hook calls), Changes for a worktree, merge (clean and
// conflicting), remove. Throwaway profile, throwaway git project in the work folder.
// The agents run the fake Claude Code (fake-claude/, #195), never sent a prompt; that a real Claude Code session
// starts in a worktree is claude-real's. Clipboard untouched.
// Dev build only (#1580): it starts this checkout's Electron itself, and Reviewer is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build): adding one is part of what it tests.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
const { sessionsOf } = require('./storeDocs.cjs')
const scratch = lib.WORK, userData = path.join(scratch, 'agents-profile')
// Outside the repository, so its CLAUDE.md (which imports AGENTS.md) doesn't apply to the test sessions (#174).
const ws = path.join(scratch, 'agents-ws')
const wtRoot = `${ws}.worktrees`
// The worktree's setup command quotes a path with a space (#1454: node-pty passed its quotes to cmd as \", so it failed).
const setupDir = path.join(scratch, 'agents setup')
for (const d of [userData, ws, wtRoot, setupDir]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(setupDir, { recursive: true })
const setupScript = path.join(setupDir, 'setup.cjs')
fs.writeFileSync(setupScript, "console.log('HIVE-SETUP-RAN ' + JSON.stringify(process.argv.slice(2)))\n")
const proj = path.join(ws, 'demo')
fs.mkdirSync(proj, { recursive: true })
// Git in the test repository, waiting out the Combwork under test's own git (lib.git, #199).
const g = (cmd, cwd = proj) => lib.git(cwd, cmd)
g('init -q -b main')
g('config user.email test@example.com')
g('config user.name Test')
fs.writeFileSync(path.join(proj, 'README.md'), '# Demo\n\nline one\n')
fs.writeFileSync(path.join(proj, 'app.txt'), 'shared file\n')
fs.writeFileSync(path.join(proj, '.gitignore'), '.env\nnode_modules/\n')
fs.writeFileSync(path.join(proj, '.env'), 'SECRET=local\n')
g('add -A')
g('commit -q -m init')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }
const shot = (page, n) => page.screenshot({ path: path.join(scratch, `agents-${n}.png`) })

;(async () => {
  // The fake trusts the project and the worktree Combwork makes for the Reviewer below.
  const claude = lib.fakeClaude(userData, path.join(scratch, 'agents-claude-home'), [proj, path.join(wtRoot, 'demo', 'reviewer')])
  const env = lib.combworkEnv({ CW_USER_DATA: userData, ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await lib.fitWindow(app, page, { width: 1600, height: 950 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  const project = async () => (await inv('workspace:refresh')).projects.find((p) => p.name === 'demo')
  await inv('workspace:open', ws); await sleep(800)
  await page.getByText('demo', { exact: true }).first().click(); await sleep(500)
  await inv('project:updateConfig', proj, { worktreeSetup: `"${process.execPath}" "${setupScript}" "two words"` })

  // --- Agent 1 alone (added: projects start with none): the strip shows, with Add Agent
  const a1 = await lib.addAgent(inv, proj)
  await project(); await sleep(500)
  check('its pane shows Agent 1', await page.locator('.pane-header-bar .agent-name', { hasText: /^Agent 1$/ }).count() === 1)
  await shot(page, '1-single')

  // --- Add Agent 2 in the project folder and Agent 3 in a new worktree
  const a2 = await inv('agents:add', proj, { location: 'project' })
  check('Agent 2 added', a2.name === 'Agent 2' && !a2.worktree, JSON.stringify(a2))
  const a3 = await inv('agents:testLegacy', proj, { location: 'new-worktree', name: 'Reviewer', model: 'sonnet' })
  check('worktree agent added', !!a3.worktree && a3.worktree.branch === 'cw/agents-ws/demo/reviewer', JSON.stringify(a3.worktree))
  const wtPath = a3.worktree.path
  check('worktree next to the workspace', path.resolve(wtPath).toLowerCase() === path.resolve(wtRoot, 'demo', 'reviewer').toLowerCase(), wtPath)
  check('.env copied into worktree', fs.existsSync(path.join(wtPath, '.env')))
  check('branch exists', g('branch --list cw/agents-ws/demo/reviewer').includes('cw/agents-ws/demo/reviewer'))
  check('needs setup', a3.needsSetup === true)
  const gi = await inv('agents:gitInfo', proj)
  check('gitInfo lists the worktree as used', gi.worktrees.some((w) => w.used && w.branch === 'cw/agents-ws/demo/reviewer'), JSON.stringify(gi.worktrees))
  let p = await project()
  check('project has 3 agents', p.agents.length === 3, p.agents.map((a) => a.name).join(','))
  const dup = await inv('agents:add', proj, { location: 'project', name: 'agent 2' }).then(() => 'ok', (e) => e.message)
  check('duplicate name refused', /already an agent/.test(dup), dup)

  // --- Start Agent 1 and Agent 3 (setup first). No prompts are sent.
  await inv('session:start', proj, { agentId: a1.id })
  await lib.acceptClaudeTrust(inv, proj, a1.id)
  await inv('session:start', proj, { agentId: a3.id })
  // The worktree's setup command runs first, in the agent's terminal.
  const buf3 = (await lib.until(async () => {
    const b = await inv('pty:buffer', `session:${proj.toLowerCase()}#${a3.id}`)
    return b.includes('HIVE-SETUP-RAN') ? b : null
  }, 20000)) ?? (await inv('pty:buffer', `session:${proj.toLowerCase()}#${a3.id}`))
  check('setup command ran in the agent terminal', buf3.includes('HIVE-SETUP-RAN'))
  // Its quoted path with a space and its quoted argument reached the program as typed (#1454).
  const flat3 = lib.plainText(buf3).replace(/[ ]+/g, '')
  check('setup command with a quoted path ran as typed', flat3.includes('HIVE-SETUP-RAN["twowords"]'), flat3.slice(flat3.indexOf('HIVE-SETUP-RAN'), flat3.indexOf('HIVE-SETUP-RAN') + 60))
  await lib.acceptClaudeTrust(inv, proj, a3.id, 25000)
  // Both sessions up (past starting: the CLI's SessionStart arrived).
  const up = (ids) => lib.until(async () => {
    const all = await inv('session:live')
    return ids.every((id) => all.some((l) => l.agentId === id && l.status !== 'starting'))
  }, 30000)
  await up([a1.id, a3.id])
  let live = await inv('session:live')
  const l1 = live.find((l) => l.agentId === a1.id), l3 = live.find((l) => l.agentId === a3.id)
  check('two sessions live', !!l1 && !!l3, live.map((l) => `${l.agentId}:${l.status}`).join(' '))
  check('worktree session runs in the worktree', l3 && path.resolve(l3.cwd).toLowerCase() === path.resolve(wtPath).toLowerCase(), l3?.cwd)
  p = await project()
  check('setup cleared', !p.agents.find((a) => a.id === a3.id).needsSetup)
  check('launch folders per agent', fs.existsSync(path.join(proj, '.combwork', `launch-${a1.id}`, 'plugin')) && fs.existsSync(path.join(proj, '.combwork', `launch-${a3.id}`, 'plugin')))
  // Settings and MCP config in each launch's private folder, in Combwork's user data, not the project (#345).
  check("each launch's settings outside the project", fs.existsSync(path.join(lib.launchDir(userData, l1.runId), 'settings.json')) && fs.existsSync(path.join(lib.launchDir(userData, l3.runId), 'settings.json')) && !fs.existsSync(path.join(proj, '.combwork', `launch-${a1.id}`, 'settings.json')))
  const argsOk = fs.readFileSync(path.join(lib.launchDir(userData, l3.runId), 'settings.json'), 'utf8').includes('PreToolUse')
  check('PreToolUse hook registered', argsOk)

  // --- Layouts
  await inv('project:updateConfig', proj, { layout: 'columns2' }); await inv('workspace:refresh'); await lib.until(async () => (await page.locator('.pane-header-bar').count()) === 2, 10000)
  check('two pane headers', await page.locator('.pane-header-bar').count() === 2)
  await shot(page, '2-columns2')
  await inv('project:updateConfig', proj, { layout: 'grid' }); await inv('workspace:refresh'); await lib.until(async () => (await page.locator('.pane-header-bar').count()) === 3 && (await page.getByText('Drop an agent here').count()) === 1, 10000)
  check('grid: 3 headers + an empty cell to drop an agent on (#762)', (await page.locator('.pane-header-bar').count()) === 3 && (await page.getByText('Drop an agent here').count()) === 1)
  await shot(page, '3-grid')
  await inv('project:updateConfig', proj, { layout: 'columns3' }); await inv('workspace:refresh'); await lib.until(async () => (await page.locator('.pane-header-bar').count()) === 3, 10000)
  await shot(page, '4-columns3')
  const visibleTerms = await page.locator('.terminal-host:not(.hidden)').count()
  check('two running terminals visible in 3 columns', visibleTerms === 2, String(visibleTerms))
  // Terminals sit in their own panes (not stacked in the first one)
  const rects = await page.evaluate(() => [...document.querySelectorAll('.terminal-host:not(.hidden)')].map((e) => Math.round(e.getBoundingClientRect().left)))
  check('terminals in separate panes', new Set(rects).size === rects.length && rects.length >= 2, JSON.stringify(rects))
  // Clicking a pane header focuses that agent
  await page.locator('.pane-header-bar', { hasText: 'Reviewer' }).locator('.agent-name').click(); await sleep(300)
  check('its pane header shows it focused', (await page.locator('.pane-header-bar.focused .agent-name').innerText()).includes('Reviewer'))

  // --- File locks via synthetic PreToolUse calls
  // Each launch's hooks carry its own run id and token (#345): a hook goes as the agent whose session it names.
  const hooks = {}
  const post = (h, body) => fetch(h.url, { method: 'POST', headers: { Authorization: `Bearer ${h.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const hook = (body) => post(hooks[body.session_id], body).then((r) => r.json())
  // Agent 2 must run to share the folder with Agent 1.
  await inv('session:start', proj, { agentId: a2.id })
  await lib.acceptClaudeTrust(inv, proj, a2.id)
  await up([a2.id])
  live = await inv('session:live')
  const l2 = live.find((l) => l.agentId === a2.id)
  check('Agent 2 live', !!l2)
  for (const l of [l1, l2, l3]) hooks[l.sessionId] = lib.launchHook(userData, l.runId)
  check("each launch's hook URL and token found, a token of its own", Object.values(hooks).every(Boolean) && new Set(Object.values(hooks).map((h) => h?.token)).size === 3)
  // Another launch's token, or none, isn't taken (#345).
  const [h1, h2] = [hooks[l1.sessionId], hooks[l2.sessionId]]
  check("another launch's token is refused", (await post({ url: h1.url, token: h2.token }, { session_id: l1.sessionId, hook_event_name: 'Notification' })).status === 401)
  check('a call naming no launch is refused', (await post({ url: h1.url.replace(/\?.*/, ''), token: h1.token }, { session_id: l1.sessionId, hook_event_name: 'Notification' })).status === 401)
  // Combwork's log says so, once each (#711): a hook a CLI sent but Combwork refused leaves a trace on Combwork's side.
  const combworkLog = () => fs.readFileSync(path.join(userData, 'logs', 'combwork.log'), 'utf8')
  const refusedLines = () => combworkLog().split('\n').filter((x) => x.includes('Refused a hook call'))
  check("Combwork's log tells of each refused hook call, and why", !!(await lib.until(() => refusedLines().some((x) => x.includes(`run ${l1.runId}: its token didn't match`)) && refusedLines().some((x) => x.includes('named no launch')), 10000)), refusedLines().join(' | '))
  const file = path.join(proj, 'app.txt')
  const pre = (sid, f = file, tool = 'Edit') => hook({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: f }, cwd: proj })
  let r = await pre(l1.sessionId)
  check('first edit allowed', !r.hookSpecificOutput, JSON.stringify(r))
  r = await pre(l2.sessionId)
  check('second agent blocked', r.hookSpecificOutput?.permissionDecision === 'deny' && /Agent 1 is editing app\.txt/.test(r.hookSpecificOutput.permissionDecisionReason), JSON.stringify(r))
  r = await pre(l1.sessionId)
  check('holder still allowed', !r.hookSpecificOutput)
  r = await pre(l2.sessionId, path.join(proj, 'README.md'))
  check('other file allowed', !r.hookSpecificOutput)
  r = await pre(l3.sessionId, path.join(wtPath, 'app.txt'))
  check('worktree copy of the file allowed', !r.hookSpecificOutput)
  r = await hook({ session_id: l2.sessionId, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo' }, cwd: proj })
  check('non-edit tools ignored', !r.hookSpecificOutput)
  await sleep(400)
  p = await project()
  check('locked files published', JSON.stringify(p.agents.find((a) => a.id === a1.id).live.lockedFiles) === '["app.txt"]', JSON.stringify(p.agents.find((a) => a.id === a1.id).live.lockedFiles))
  // File locks is the project's workflow option (HI-1766).
  await lib.setOwnOptions(inv, proj, { fileLocks: 'ask' }); await inv('workspace:refresh')
  r = await pre(l2.sessionId)
  check('ask mode asks', r.hookSpecificOutput?.permissionDecision === 'ask')
  await lib.setOwnOptions(inv, proj, { fileLocks: 'warn' }); await inv('workspace:refresh')
  r = await pre(l2.sessionId)
  check('warn mode adds context', !!r.hookSpecificOutput?.additionalContext && !r.hookSpecificOutput.permissionDecision)
  await lib.setOwnOptions(inv, proj, { fileLocks: undefined }); await inv('workspace:refresh')
  // Agent 1's turn ends: its claims are released
  await hook({ session_id: l1.sessionId, hook_event_name: 'Stop' }); await sleep(300)
  r = await pre(l2.sessionId)
  check('released after Stop; Agent 2 claims it', !r.hookSpecificOutput)
  r = await pre(l1.sessionId)
  check('now Agent 1 is blocked', r.hookSpecificOutput?.permissionDecision === 'deny' && /Agent 2 is editing/.test(r.hookSpecificOutput.permissionDecisionReason))
  await shot(page, '5-locks')

  // --- A new conversation started in the CLI (/clear, /new): its first prompt carries another session id
  // for the same launch, and Combwork moves the agent to it.
  const before = (await inv('session:live')).find((l) => l.agentId === a1.id).sessionId
  const newId = '33333333-4444-4555-8666-777777777777'
  await post(hooks[before], { session_id: newId, hook_event_name: 'UserPromptSubmit', cwd: proj })
  await sleep(800)
  const moved = (await inv('session:live')).find((l) => l.agentId === a1.id)
  check('follows a new conversation started in the CLI', moved.sessionId === newId && before !== newId, `${before} → ${moved.sessionId}`)
  const recs = sessionsOf(proj).sessions
  check('the new conversation is recorded for the agent', recs.some((s) => s.id === newId && s.agentId === a1.id), JSON.stringify(recs.map((s) => [s.id.slice(0, 8), s.agentId])))
  check('the old one stays in the list', recs.some((s) => s.id === before))

  // --- Changes tab for the worktree + merge
  fs.writeFileSync(path.join(wtPath, 'review.md'), '# Review notes\n')
  g('add -A', wtPath); g('commit -q -m "review notes"', wtPath)
  fs.appendFileSync(path.join(wtPath, 'README.md'), 'uncommitted line\n')
  const cs = await inv('git:status', wtPath, 'main')
  check('worktree changes since base', cs.files.some((f) => f.path === 'review.md') && cs.files.some((f) => f.path === 'README.md'), cs.files.map((f) => f.path + ':' + f.status).join(' '))
  const d = await inv('git:diff', wtPath, 'review.md', 'main')
  check('diff against base', d.original === '' && d.modified.includes('Review notes'))
  await page.locator('.tabs .tab', { hasText: 'Version Control' }).click(); await lib.until(async () => (await page.locator('.root-select').count()) > 0, 10000)
  await page.locator('.root-select').first().selectOption(a3.id); await lib.until(async () => (await page.getByText('review.md').count()) > 0, 10000)
  check('Changes tab shows worktree files', await page.getByText('review.md').count() > 0)
  await shot(page, '6-changes')
  const list = await inv('session:list', proj)
  check('worktree session recorded with cwd', list.some((s) => s.agentId === a3.id && s.cwd && s.branch === 'cw/agents-ws/demo/reviewer'), JSON.stringify(list.map((s) => [s.agentId, s.branch])))
  const bs = await inv('agents:branchStatus', proj, a3.id)
  check('branch status', bs.ahead === 1 && bs.dirty === 1 && bs.into === 'main', JSON.stringify(bs))
  // Conflict: change README.md on main too
  fs.writeFileSync(path.join(proj, 'README.md'), '# Demo\n\nline one changed on main\n')
  g('commit -q -am "main change"')
  fs.writeFileSync(path.join(wtPath, 'README.md'), '# Demo\n\nline one changed by reviewer\n')
  const mainHead = g('rev-parse HEAD').trim()
  // Uncommitted files aren't merged (#1347): refused, counted, nothing committed for the agent.
  const dirty = await inv('agents:merge', proj, a3.id, { squash: true, message: 'Reviewer work', cleanup: false })
  check('a dirty worktree is refused, its files counted', !dirty.ok && dirty.uncommitted === 1 && g('status --porcelain', wtPath).includes('README.md'), JSON.stringify(dirty))
  g('add -A', wtPath); g('commit -q -m "reviewer readme"', wtPath)
  const conflict =await inv('agents:merge', proj, a3.id, { squash: true, message: 'Reviewer work', cleanup: false })
  check('conflict reported', !conflict.ok && conflict.conflicts?.includes('README.md'), JSON.stringify(conflict))
  check('main untouched after conflict', g('rev-parse HEAD').trim() === mainHead && g('status --porcelain').trim() === '')
  // Resolve on the branch by taking main's version, then merge cleanly
  fs.writeFileSync(path.join(wtPath, 'README.md'), '# Demo\n\nline one changed on main\n')
  g('add -A', wtPath); g('commit -q -m "take main readme"', wtPath)
  g('merge -q main -m sync', wtPath)
  await inv('session:stop', proj, a3.id)
  // Merge only once its session has ended (a working agent's branch isn't merged).
  await lib.until(async () => !(await inv('session:live')).some((l) => l.agentId === a3.id), 20000)
  const merged = await inv('agents:merge', proj, a3.id, { squash: true, message: 'Reviewer work', cleanup: true })
  check('squash merge ok and cleaned up', merged.ok && merged.cleanedUp, JSON.stringify(merged))
  check('merge commit on main', g('log -1 --format=%s').trim() === 'Reviewer work' && fs.existsSync(path.join(proj, 'review.md')))
  check('worktree removed', !fs.existsSync(wtPath))
  check('branch deleted', !g('branch --list cw/agents-ws/demo/reviewer').includes('cw/agents-ws/demo/reviewer'))
  p = await project()
  check('agent removed', p.agents.length === 2)


  // --- Remove Agent 2 (must be stopped first)
  const refused = await inv('agents:remove', proj, a2.id, { deleteWorktree: false }).then(() => 'ok', (e) => e.message)
  check('remove refused while running', /Stop the agent/.test(refused))
  await inv('session:stop', proj)
  await lib.until(async () => (await inv('session:live')).length === 0, 20000)
  check('stop without agent stops all', (await inv('session:live')).length === 0)
  await inv('agents:remove', proj, a2.id, { deleteWorktree: false })
  p = await project()
  check('back to one agent', p.agents.length === 1)
  await page.locator('.tabs .tab', { hasText: 'Session' }).first().click(); await sleep(800)
  await shot(page, '7-after')

  console.log(`${pass}/${pass + fail} passed`)
  await app.close()
  // No delete of its folders here (#324): the runner gives the suite a new folder and removes it when it passes; a run
  // on its own empties them when it starts. Right after app.close() the CLI it stopped can still hold one, and a
  // failed delete here failed a suite whose checks had all passed.
})().catch(async (e) => { console.error(e); process.exit(1) })
