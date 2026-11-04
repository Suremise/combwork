// MCP servers added where they run (HI-2059), in the window. Add MCP Server from File (#550): a .json definition and a
// .zip of a server folder are added from the MCP view's button (the file picker stubbed), the dialog showing what each
// runs; each is added nowhere, with no questions; a name in use asks to replace it or choose another. Add to… in a
// server's view shows what it runs and ticks the projects it is added to: Save adds where ticked and removes where
// unticked. The MCP view searches and filters. A project's MCP tab lists only its added servers, each with Remove, and
// Add Server… picks one of the others (search, what it runs, Add); Copy to workspace adds a project's own server there.
// A new session gets only the servers added to its project (the fake Claude Code's --mcp-config); deleting one asks,
// saying where it is added. Screenshots in mcpfile-shots (the project tab and the picker in both themes). Throwaway
// profile, workspace and CLAUDE_CONFIG_DIR.
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
  const themed = async (name) => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate((th) => document.documentElement.setAttribute('data-theme', th), theme)
      await page.mouse.move(5, 5)
      await page.screenshot({ path: path.join(shots, `mcpfile-${name}-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  }
  const pick = (file) => app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }) }, file)
  const servers = () => inv('mcp:list')
  const server = async (name) => (await servers()).find((m) => m.name === name)
  const dialog = (title) => page.getByRole('dialog', { name: title })
  const addButton = page.getByRole('button', { name: 'Add MCP Server from File (.json or .zip)…' })
  // The server's row in the MCP view, by its whole name ("notes", not "notes-2").
  const row = (name) => page.locator('.pane-body .row', { has: page.locator('.label', { hasText: new RegExp(`^${name}\\s*$`) }) })

  // What is added to a project (HI-2059), as project.json has it.
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

  // --- A .json definition: the dialog shows what it runs, named after the file, and asks nothing else; added nowhere.
  await pick(path.join(dump, 'github.json'))
  await addButton.click()
  const add = dialog('Add MCP Server from File')
  check('the dialog opens', !!(await lib.until(async () => (await add.count()) === 1, HUNG_MS)))
  const said = await add.innerText()
  check('it shows the command it runs', said.includes('Runs: npx -y @modelcontextprotocol/server-github'), said)
  check('and its environment by name, a reference as itself', said.includes('Environment: GITHUB_TOKEN=${GITHUB_TOKEN}'), said)
  check('and says it is added to no project yet', /added to no project yet\. Add it where it should run/.test(said), said)
  check("the name is the file's", (await add.locator('input').inputValue()) === 'github')
  check('no question where to add it', (await add.locator('select').count()) === 0)
  await shot('1-json-dialog')
  await add.getByRole('button', { name: 'Add' }).click()
  check('it is added', !!(await lib.until(async () => !!(await server('github')), HUNG_MS)))
  check('added nowhere', JSON.stringify((await server('github'))?.projects) === '[]' && (await server('github'))?.assistant === false)
  check('in no project', !(projectMcp(proj).enabled ?? []).includes('github') && !(projectMcp(other).enabled ?? []).includes('github'), JSON.stringify([projectMcp(proj), projectMcp(other)]))
  check('its row says it is not added anywhere', !!(await lib.until(async () => (await where('github')) === 'Not added anywhere', HUNG_MS)), await where('github'))
  check('and has no switch', (await row('github').getByRole('switch').count()) === 0)
  const runs = page.getByLabel('What it runs')
  check("its view shows what it runs", !!(await lib.until(async () => (await runs.innerText().catch(() => '')).includes('Runs: npx -y @modelcontextprotocol/server-github'), HUNG_MS)))
  await shot('2-json-added')

  // --- A .zip of a server folder: unpacked to .hive/mcp/notes/, its definition from hive-mcp.json; added nowhere.
  await pick(path.join(dump, 'notes.zip'))
  await addButton.click()
  await lib.until(async () => (await add.count()) === 1, HUNG_MS)
  const zipSaid = await add.innerText()
  check('the zip shows what it runs', zipSaid.includes('Runs: node ${HIVE_MCP_DIR}/notes/server.js') && zipSaid.includes('NOTES_DIR (set)'), zipSaid)
  check('and that its file goes in a folder of its own', /with its file in a folder of its own/.test(zipSaid), zipSaid)
  await add.getByRole('button', { name: 'Add' }).click()
  check('the zip is added', !!(await lib.until(async () => !!(await server('notes')), HUNG_MS)))
  check('added nowhere', !!(await lib.until(async () => (await where('notes')) === 'Not added anywhere', HUNG_MS)) && !(projectMcp(proj).enabled ?? []).includes('notes'), await where('notes'))
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
  check('running its own folder', (await server('notes-2'))?.def?.args?.[0] === '${CW_MCP_DIR}/notes-2/server.js' && fs.existsSync(path.join(mcpDir, 'notes-2', 'server.js')))
  check('and the first is untouched', (await server('notes'))?.def?.args?.[0] === '${HIVE_MCP_DIR}/notes/server.js')

  // --- Add to… asks first, showing what it runs and the projects, ticked where it is added; Save adds and removes.
  const placesDialog = async (name) => {
    await row(name).click()
    await page.locator('[data-action="mcp-places"]').click()
    const d = dialog(`Add ${name} to…`)
    check(`Add to… for ${name} asks first`, !!(await lib.until(async () => (await d.count()) === 1, HUNG_MS)), JSON.stringify(await page.getByRole('dialog').allInnerTexts()))
    return d
  }
  const box = (d, project) => d.getByRole('group', { name: 'Projects to add it to' }).getByRole('checkbox', { name: project, exact: true })
  const save = (d) => d.getByRole('button', { name: 'Save', exact: true }).click()
  const addGithub = await placesDialog('github')
  check('showing what it runs', (await addGithub.innerText()).includes('Runs: npx -y @modelcontextprotocol/server-github'))
  check('no project ticked yet', !(await box(addGithub, 'demo').isChecked()) && !(await box(addGithub, 'other').isChecked()))
  await box(addGithub, 'demo').check()
  await shot('4-add-to')
  await save(addGithub)
  check('it is added to demo only', !!(await lib.until(async () => (projectMcp(proj).enabled ?? []).includes('github'), HUNG_MS)) && !(projectMcp(other).enabled ?? []).includes('github'), JSON.stringify([projectMcp(proj), projectMcp(other)]))
  check('its row says so', !!(await lib.until(async () => (await where('github')) === 'Added in demo', HUNG_MS)), await where('github'))

  // --- All projects ticks every project; unticking one removes it there.
  const addNotes = await placesDialog('notes')
  await addNotes.getByRole('button', { name: 'All projects', exact: true }).click()
  check('All projects ticks every project', (await box(addNotes, 'demo').isChecked()) && (await box(addNotes, 'other').isChecked()))
  await save(addNotes)
  check('notes is added in both', !!(await lib.until(async () => (await where('notes')) === 'Added in demo and other', HUNG_MS)), await where('notes'))
  const again = await placesDialog('notes')
  check('opened again: both ticked', (await box(again, 'demo').isChecked()) && (await box(again, 'other').isChecked()))
  await box(again, 'demo').uncheck()
  await save(again)
  check('unticked in demo: removed there, kept in other', !!(await lib.until(async () => (await where('notes')) === 'Added in other', HUNG_MS)) && !(projectMcp(proj).enabled ?? []).includes('notes') && (projectMcp(other).enabled ?? []).includes('notes'), JSON.stringify([projectMcp(proj), projectMcp(other)]))

  // --- Search and filter in the MCP view.
  const search = page.locator('.sidebar [data-mcp-search]')
  const listed = async () => (await page.locator('.pane-body .row .label').allInnerTexts()).map((t) => t.trim()).filter((t) => t !== 'hive')
  await search.fill('note')
  check('searching "note" lists notes and notes-2', !!(await lib.until(async () => JSON.stringify((await listed()).sort()) === '["notes","notes-2"]', HUNG_MS)), JSON.stringify(await listed()))
  await page.locator('.sidebar [data-mcp-filter]').selectOption('nowhere')
  check('…added nowhere: notes-2 only', !!(await lib.until(async () => JSON.stringify(await listed()) === '["notes-2"]', HUNG_MS)), JSON.stringify(await listed()))
  await shot('5-search')
  await search.fill('')
  await page.locator('.sidebar [data-mcp-filter]').selectOption('all')

  // --- A project's MCP tab lists only what it added: other has notes; Add Server… picks notes-2, Remove takes notes off.
  await page.keyboard.press('Control+Shift+E')
  await page.locator('.project-row', { hasText: 'other' }).click()
  await lib.openMoreTab(page, 'MCP')
  const tabRow = (name) => page.locator(`.toggle-item[data-mcp="${name}"]`)
  check("other's MCP tab lists only notes, with Remove and no switch", !!(await lib.until(async () => (await tabRow('notes').count()) === 1, HUNG_MS)) && (await tabRow('github').count()) === 0 && (await tabRow('notes-2').count()) === 0 && (await page.locator('.toggle-list').first().getByRole('switch').count()) === 0 && (await tabRow('notes').locator('[data-action="mcp-remove"]').count()) === 1)
  await themed('6-project-tab')
  await page.locator('[data-action="mcp-add"]').click()
  const picker = dialog('Add a server to other')
  const pickRow = (n) => picker.locator(`.mcp-picker-row[data-mcp="${n}"]`)
  check('Add Server… lists the servers not added to other', !!(await lib.until(async () => (await picker.locator('.mcp-picker-row').count()) === 2, HUNG_MS)) && (await pickRow('github').count()) === 1 && (await pickRow('notes-2').count()) === 1)
  await picker.locator('[data-mcp-search]').fill('2')
  check('…searching finds notes-2', !!(await lib.until(async () => (await picker.locator('.mcp-picker-row').count()) === 1, HUNG_MS)))
  await pickRow('notes-2').click()
  check('…chosen, it shows what it runs and the folder', !!(await lib.until(async () => (await picker.locator('[data-mcp-runs="notes-2"]').innerText().catch(() => '')).includes('Runs: node ${CW_MCP_DIR}/notes-2/server.js'), HUNG_MS)))
  await themed('7-picker')
  await picker.getByRole('button', { name: 'Add', exact: true }).click()
  check('…Add adds it to other, and only there', !!(await lib.until(async () => (await tabRow('notes-2').count()) === 1, HUNG_MS)) && (projectMcp(other).enabled ?? []).includes('notes-2') && !(projectMcp(proj).enabled ?? []).includes('notes-2'), JSON.stringify([projectMcp(proj), projectMcp(other)]))
  await tabRow('notes').locator('[data-action="mcp-remove"]').click()
  check('Remove takes notes off other at once', !!(await lib.until(async () => (await tabRow('notes').count()) === 0, HUNG_MS)) && !(projectMcp(other).enabled ?? []).includes('notes') && (await page.getByRole('dialog').count()) === 0, JSON.stringify(projectMcp(other)))
  check('…and it stays in the workspace', !!(await server('notes')))

  // --- Copy to workspace: a server other defines itself, shown first, is copied and added to other.
  const copy = page.locator('.toggle-item', { hasText: 'docs' }).getByRole('button', { name: 'Copy to workspace' })
  check("other's own server is offered to copy", !!(await lib.until(async () => (await copy.count()) === 1, HUNG_MS)))
  await copy.click()
  const copying = dialog('Copy docs to the workspace?')
  check('copying asks first', !!(await lib.until(async () => (await copying.count()) === 1, HUNG_MS)), JSON.stringify(await page.getByRole('dialog').allInnerTexts()))
  check('showing what it runs and where it is added', /Runs: node docs\.js/.test(await copying.innerText()) && /added to other straight away/.test(await copying.innerText()), await copying.innerText())
  await copying.getByRole('button', { name: 'Copy and Add' }).click()
  check('it is copied and added to other', !!(await lib.until(async () => (await tabRow('docs').count()) === 1, HUNG_MS)) && (projectMcp(other).enabled ?? []).includes('docs') && !(projectMcp(proj).enabled ?? []).includes('docs'), JSON.stringify([projectMcp(proj), projectMcp(other)]))

  // --- New sessions get the servers added to their project, and only those.
  const mcpOf = (cwd) =>
    lib.until(async () => {
      const lines = fs.existsSync(path.join(home, 'fake-launches.jsonl')) ? fs.readFileSync(path.join(home, 'fake-launches.jsonl'), 'utf8').trim().split('\n') : []
      const l = lines.map((x) => JSON.parse(x)).find((x) => x.opts?.['--mcp-config'] && x.cwd.toLowerCase() === cwd.toLowerCase())
      return l && fs.existsSync(l.opts['--mcp-config']) ? JSON.parse(fs.readFileSync(l.opts['--mcp-config'], 'utf8')).mcpServers : null
    }, 30000)
  const agent = await lib.addAgent(inv, proj, { name: 'User' })
  await inv('session:start', proj, { agentId: agent.id })
  const launched = await mcpOf(proj)
  check("demo's session gets github (added to demo)", !!launched?.github, JSON.stringify(Object.keys(launched ?? {})))
  check('and not notes, notes-2 or docs (not added to demo)', !launched?.notes && !launched?.['notes-2'] && !launched?.docs, JSON.stringify(Object.keys(launched ?? {})))
  const otherAgent = await lib.addAgent(inv, other, { name: 'Other' })
  await inv('session:start', other, { agentId: otherAgent.id })
  const launchedOther = await mcpOf(other)
  check("other's session gets notes-2 and docs, not github or notes", !!launchedOther?.['notes-2'] && !!launchedOther?.docs && !launchedOther?.github && !launchedOther?.notes, JSON.stringify(Object.keys(launchedOther ?? {})))
  check('running its code from the workspace', String(launchedOther?.['notes-2']?.args?.[0] ?? '').replace(/\\/g, '/').toLowerCase() === `${mcpDir.replace(/\\/g, '/')}/notes-2/server.js`.toLowerCase(), JSON.stringify(launchedOther?.['notes-2']))
  await inv('session:stop', proj, agent.id)
  await inv('session:stop', other, otherAgent.id)

  // --- Deleting a server asks, saying where it is added; it is removed there, its folder with it.
  await page.keyboard.press('Control+Shift+M')
  await row('notes-2').hover()
  await row('notes-2').getByRole('button', { name: 'Delete server', exact: true }).click()
  const deleting = dialog('Delete MCP server?')
  check('deleting asks, saying where it is added', !!(await lib.until(async () => (await deleting.count()) === 1, HUNG_MS)) && (await deleting.innerText()).includes('Added in other: deleting it removes it there too.'), await deleting.innerText().catch(() => ''))
  await deleting.getByRole('button', { name: 'Delete', exact: true }).click()
  check('deleting it moves its folder too', !!(await lib.until(async () => !fs.existsSync(path.join(mcpDir, 'notes-2')) && !fs.existsSync(path.join(mcpDir, 'notes-2.json')), HUNG_MS)))
  check('…and removes it from other', !!(await lib.until(async () => !(projectMcp(other).enabled ?? []).includes('notes-2'), HUNG_MS)), JSON.stringify(projectMcp(other)))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
