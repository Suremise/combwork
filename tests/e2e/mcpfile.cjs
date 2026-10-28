// Add MCP Server from File (#550), in the window: a .json definition and a .zip of a server folder are added from the
// MCP view's button (the file picker stubbed), the dialog showing what each runs before it is added; it is added off
// in the workspace and in every project, with no questions (#1093); a name in use asks to replace it or choose another;
// turning one on in the workspace asks first, showing what it runs and which projects to turn it on in (the selected
// project, and those that had it on, ticked), and off keeps the projects' choices; a project's switch is its own choice,
// shown inactive ("Off in the workspace") while the workspace has the server off; and a new session gets only the
// servers on in the workspace and its project (the fake Claude Code's --mcp-config). Throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { zipSync, strToU8 } = require('fflate')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'mcpfile-profile')
const ws = path.join(lib.WORK, 'mcpfile-ws')
const proj = path.join(ws, 'demo')
const other = path.join(ws, 'other')
const dump = path.join(lib.WORK, 'mcpfile-dump')
const home = path.join(lib.WORK, 'mcpfile-claude-home')
const mcpDir = path.join(ws, '.hive', 'mcp')
const shots = path.join(lib.WORK, 'mcpfile-shots')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, dump, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  fs.mkdirSync(other, { recursive: true })
  // A server other defines in its own config, for Copy to workspace.
  fs.writeFileSync(path.join(other, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'node', args: ['docs.js'] } } }))
  fs.mkdirSync(dump, { recursive: true })
  fs.mkdirSync(shots, { recursive: true })
  fs.writeFileSync(path.join(dump, 'github.json'), JSON.stringify({ description: 'GitHub issues', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } }))
  const notes = { description: 'Notes', command: 'node', args: ['${HIVE_MCP_DIR}/notes/server.js'], env: { NOTES_DIR: 'C:\\notes' } }
  fs.writeFileSync(path.join(dump, 'notes.zip'), zipSync({ 'notes/hive-mcp.json': strToU8(JSON.stringify(notes)), 'notes/server.js': strToU8('// notes server') }))
  const env = lib.fakeClaude(userData, home, [proj, other])
  const { app, page, inv } = await lib.launch({ userData, env })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  const shot = (name) => page.screenshot({ path: path.join(shots, `mcpfile-${name}.png`) })
  const pick = (file) => app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }) }, file)
  const servers = () => inv('mcp:list')
  const server = async (name) => (await servers()).find((m) => m.name === name)
  const dialog = (title) => page.getByRole('dialog', { name: title })
  const addButton = page.getByRole('button', { name: 'Add MCP Server from File (.json or .zip)…' })
  // The server's row in the MCP view, by its whole name ("notes", not "notes-2").
  const row = (name) => page.locator('.pane-body .row', { has: page.locator('.label', { hasText: new RegExp(`^${name}\\s*$`) }) })

  // The project's own choices (#713), as project.json has them.
  const projectMcp = (p) => {
    const f = path.join(p, '.hive', 'project.json')
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')).mcp ?? {}) : {}
  }
  const where = (name) => row(name).locator('.mcp-where').innerText().catch(() => '')

  // demo is the selected project when servers are added.
  await lib.until(async () => (await page.locator('.project-row', { hasText: 'demo' }).count()) === 1, HUNG_MS)
  await page.locator('.project-row', { hasText: 'demo' }).click()
  await page.keyboard.press('Control+Shift+M')
  check('the MCP view has Add MCP Server from File', !!(await lib.until(async () => (await addButton.count()) === 1, HUNG_MS)))

  // --- A .json definition: the dialog shows what it runs, named after the file, and asks nothing else; added off.
  await pick(path.join(dump, 'github.json'))
  await addButton.click()
  const add = dialog('Add MCP Server from File')
  check('the dialog opens', !!(await lib.until(async () => (await add.count()) === 1, HUNG_MS)))
  const said = await add.innerText()
  check('it shows the command it runs', said.includes('Runs: npx -y @modelcontextprotocol/server-github'), said)
  check('and its environment by name, a reference as itself', said.includes('Environment: GITHUB_TOKEN=${GITHUB_TOKEN}'), said)
  check('and says it is added turned off', /turned off\. Turn it on in the MCP view/.test(said), said)
  check("the name is the file's", (await add.locator('input').inputValue()) === 'github')
  check('no question where to turn it on', (await add.locator('select').count()) === 0)
  await shot('1-json-dialog')
  await add.getByRole('button', { name: 'Add' }).click()
  check('it is added', !!(await lib.until(async () => !!(await server('github')), HUNG_MS)))
  check('off in the workspace', (await server('github'))?.globallyEnabled === false)
  check('and in every project', !(projectMcp(proj).enabled ?? []).includes('github') && !(projectMcp(other).enabled ?? []).includes('github'), JSON.stringify([projectMcp(proj), projectMcp(other)]))
  check('its row says it is off in the workspace', !!(await lib.until(async () => (await where('github')) === 'Off in the workspace', HUNG_MS)), await where('github'))
  check('its workspace switch is off', (await row('github').getByRole('switch').getAttribute('aria-checked')) === 'false')
  const runs = page.getByLabel('What it runs')
  check("its view shows what it runs", !!(await lib.until(async () => (await runs.innerText().catch(() => '')).includes('Runs: npx -y @modelcontextprotocol/server-github'), HUNG_MS)))
  await shot('2-json-added')

  // --- A .zip of a server folder: unpacked to .hive/mcp/notes/, its definition from hive-mcp.json; added off.
  await pick(path.join(dump, 'notes.zip'))
  await addButton.click()
  await lib.until(async () => (await add.count()) === 1, HUNG_MS)
  const zipSaid = await add.innerText()
  check('the zip shows what it runs', zipSaid.includes('Runs: node ${HIVE_MCP_DIR}/notes/server.js') && zipSaid.includes('NOTES_DIR (set)'), zipSaid)
  check('and that its file goes in a folder of its own', /with its file in a folder of its own/.test(zipSaid), zipSaid)
  await add.getByRole('button', { name: 'Add' }).click()
  check('the zip is added', !!(await lib.until(async () => !!(await server('notes')), HUNG_MS)))
  check('off in the workspace', !!(await lib.until(async () => (await where('notes')) === 'Off in the workspace', HUNG_MS)) && !(projectMcp(proj).enabled ?? []).includes('notes'), await where('notes'))
  check("its code is in .hive/mcp/notes", fs.existsSync(path.join(mcpDir, 'notes', 'server.js')))

  // --- The same name again: Replace or Choose Another Name; another name moves its folder references.
  await pick(path.join(dump, 'notes.zip'))
  await addButton.click()
  await lib.until(async () => (await add.count()) === 1, HUNG_MS)
  await add.getByRole('button', { name: 'Add' }).click()
  const clash = dialog('Replace notes?')
  check('a name in use asks', !!(await lib.until(async () => (await clash.count()) === 1, HUNG_MS)))
  await shot('3-clash')
  await clash.getByRole('button', { name: 'Choose Another Name' }).click()
  check('Choose Another Name asks for the name again', !!(await lib.until(async () => (await add.count()) === 1, HUNG_MS)))
  await add.locator('input').fill('notes-2')
  await add.getByRole('button', { name: 'Add' }).click()
  check('it is added under the new name', !!(await lib.until(async () => !!(await server('notes-2')), HUNG_MS)))
  check('running its own folder', (await server('notes-2'))?.def?.args?.[0] === '${HIVE_MCP_DIR}/notes-2/server.js' && fs.existsSync(path.join(mcpDir, 'notes-2', 'server.js')))
  check('and the first is untouched', (await server('notes'))?.def?.args?.[0] === '${HIVE_MCP_DIR}/notes/server.js')

  // --- Turning one on in the workspace asks first, showing what it runs and the projects, the selected one ticked.
  const enableDialog = async (name) => {
    await row(name).getByRole('switch').click()
    const d = dialog(`Turn on ${name}?`)
    check(`turning ${name} on asks first`, !!(await lib.until(async () => (await d.count()) === 1, HUNG_MS)), JSON.stringify(await page.getByRole('dialog').allInnerTexts()))
    return d
  }
  const ticked = (d, project) => d.getByRole('group', { name: 'Projects to turn it on in' }).getByRole('checkbox', { name: project, exact: true }).isChecked()
  const enableGithub = await enableDialog('github')
  check('showing what it runs', (await enableGithub.innerText()).includes('Runs: npx -y @modelcontextprotocol/server-github'))
  check('demo (selected) ticked, other not', (await ticked(enableGithub, 'demo')) && !(await ticked(enableGithub, 'other')))
  await shot('4-enable')
  await enableGithub.getByRole('button', { name: 'Turn On', exact: true }).click()
  check('it is on in the workspace', !!(await lib.until(async () => (await server('github'))?.globallyEnabled === true, HUNG_MS)))
  check('and in demo only', !!(await lib.until(async () => (projectMcp(proj).enabled ?? []).includes('github'), HUNG_MS)) && !(projectMcp(other).enabled ?? []).includes('github'), JSON.stringify([projectMcp(proj), projectMcp(other)]))
  check('its row says so', !!(await lib.until(async () => (await where('github')) === 'On in demo', HUNG_MS)), await where('github'))

  // --- All ticks every project; off keeps their choices, and on again shows them ticked.
  const enableNotes = await enableDialog('notes')
  await enableNotes.getByRole('button', { name: 'All projects', exact: true }).click()
  check('All ticks every project', (await ticked(enableNotes, 'demo')) && (await ticked(enableNotes, 'other')))
  await enableNotes.getByRole('button', { name: 'Turn On', exact: true }).click()
  check('notes is on in both', !!(await lib.until(async () => (await where('notes')) === 'On in demo and other', HUNG_MS)), await where('notes'))
  await row('notes').getByRole('switch').click()
  check('off at once, with no question', !!(await lib.until(async () => (await where('notes')) === 'Off in the workspace', HUNG_MS)), await where('notes'))
  check('the projects keep their choices', (projectMcp(proj).enabled ?? []).includes('notes') && (projectMcp(other).enabled ?? []).includes('notes'), JSON.stringify([projectMcp(proj), projectMcp(other)]))
  const again = await enableDialog('notes')
  check('on again: both ticked', (await ticked(again, 'demo')) && (await ticked(again, 'other')))
  await again.getByRole('button', { name: 'Turn On', exact: true }).click()
  check('notes is on in both again', !!(await lib.until(async () => (await where('notes')) === 'On in demo and other', HUNG_MS)), await where('notes'))

  // --- A project's MCP tab lists every server with its own switch: notes-2, off in the workspace, is turned on in
  // other with no question, and shown inactive there.
  await page.keyboard.press('Control+Shift+E')
  await page.locator('.project-row', { hasText: 'other' }).click()
  await lib.openMoreTab(page, 'MCP')
  const tabSwitch = (name) => page.getByRole('switch', { name: `${name} on in other`, exact: true })
  const tabRow = (name) => page.locator(`.toggle-item[data-mcp="${name}"]`)
  check("other's MCP tab lists every server", !!(await lib.until(async () => (await tabSwitch('github').count()) === 1 && (await tabSwitch('notes').count()) === 1 && (await tabSwitch('notes-2').count()) === 1, HUNG_MS)))
  check('github is off there, notes on', (await tabSwitch('github').getAttribute('aria-checked')) === 'false' && (await tabSwitch('notes').getAttribute('aria-checked')) === 'true')
  check('notes-2 says it is off in the workspace', (await tabRow('notes-2').innerText()).includes('Off in the workspace') && !(await tabRow('notes').innerText()).includes('Off in the workspace'))
  await tabSwitch('notes-2').click()
  check("other's switch for it turns on", !!(await lib.until(async () => (await tabSwitch('notes-2').getAttribute('aria-checked')) === 'true', HUNG_MS)))
  check('with no question', (await page.getByRole('dialog').count()) === 0)
  check("other's choice is kept, demo's not changed", (projectMcp(other).enabled ?? []).includes('notes-2') && !(projectMcp(proj).enabled ?? []).includes('notes-2'), JSON.stringify([projectMcp(proj), projectMcp(other)]))
  check('and it is still shown inactive', (await tabRow('notes-2').getAttribute('class')).includes('disabled') && (await tabRow('notes-2').getAttribute('data-gated')) === 'true')
  await shot('5-project-tab')

  // --- Copy to workspace: a server other defines itself, shown first, is copied on in the workspace and in other.
  const copy = page.locator('.toggle-item', { hasText: 'docs' }).getByRole('button', { name: 'Copy to workspace' })
  check("other's own server is offered to copy", !!(await lib.until(async () => (await copy.count()) === 1, HUNG_MS)))
  await copy.click()
  const copying = dialog('Copy docs to the workspace?')
  check('copying asks first', !!(await lib.until(async () => (await copying.count()) === 1, HUNG_MS)), JSON.stringify(await page.getByRole('dialog').allInnerTexts()))
  check('showing what it runs and where it goes on', /Runs: node docs\.js/.test(await copying.innerText()) && /turned on in other straight away/.test(await copying.innerText()), await copying.innerText())
  await copying.getByRole('button', { name: 'Copy and Turn On' }).click()
  check('it is copied, on in other', !!(await lib.until(async () => (await tabSwitch('docs').getAttribute('aria-checked').catch(() => null)) === 'true', HUNG_MS)) && !(projectMcp(proj).enabled ?? []).includes('docs'), JSON.stringify([projectMcp(proj), projectMcp(other)]))
  check('and on in the workspace', (await server('docs'))?.globallyEnabled === true)
  await shot('6-project-tab-on')

  // --- New sessions get the servers on in their project, and only those.
  const mcpOf = (cwd) =>
    lib.until(async () => {
      const lines = fs.existsSync(path.join(home, 'fake-launches.jsonl')) ? fs.readFileSync(path.join(home, 'fake-launches.jsonl'), 'utf8').trim().split('\n') : []
      const l = lines.map((x) => JSON.parse(x)).find((x) => x.opts?.['--mcp-config'] && x.cwd.toLowerCase() === cwd.toLowerCase())
      return l && fs.existsSync(l.opts['--mcp-config']) ? JSON.parse(fs.readFileSync(l.opts['--mcp-config'], 'utf8')).mcpServers : null
    }, 30000)
  const agent = await lib.addAgent(inv, proj, { name: 'User' })
  await inv('session:start', proj, { agentId: agent.id })
  const launched = await mcpOf(proj)
  check("demo's session gets github and notes (on in the workspace and demo)", !!launched?.github && !!launched?.notes, JSON.stringify(Object.keys(launched ?? {})))
  check('running its code from the workspace', String(launched?.notes?.args?.[0] ?? '').replace(/\\/g, '/').toLowerCase() === `${mcpDir.replace(/\\/g, '/')}/notes/server.js`.toLowerCase(), JSON.stringify(launched?.notes))
  check('and not notes-2 or docs (not on in demo)', !launched?.['notes-2'] && !launched?.docs)
  const otherAgent = await lib.addAgent(inv, other, { name: 'Other' })
  await inv('session:start', other, { agentId: otherAgent.id })
  const launchedOther = await mcpOf(other)
  check("other's session gets notes and docs, not github (off in other) or notes-2 (off in the workspace)", !!launchedOther?.notes && !launchedOther?.['notes-2'] && !!launchedOther?.docs && !launchedOther?.github, JSON.stringify(Object.keys(launchedOther ?? {})))
  await inv('session:stop', proj, agent.id)
  await inv('session:stop', other, otherAgent.id)

  // --- Deleting a server added from a .zip takes its folder too (to the test copy's trash).
  await inv('mcp:delete', 'notes-2')
  check("deleting it moves its folder too", !fs.existsSync(path.join(mcpDir, 'notes-2')) && !fs.existsSync(path.join(mcpDir, 'notes-2.json')))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
