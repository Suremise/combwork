// A card's Read first references (#818): doc sections by file and heading, set through the Agent API, the hive tools and
// the card dialog, checked (a Markdown file with an optional #slug, never a line number), recorded in the card's
// history, shown in the dialog as links that open each section in Combwork's viewer (Open in Files at its heading), and given
// to the agent in its start prompt with each section's size, not the sections themselves. References that don't resolve
// (#819) are flagged on the card's tile and in its dialog with the closest headings, whether saved so or broken by a
// change before the start, and named in the prompt. The agent is the fake Claude Code. Pictured in both themes. Dev
// build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1580): it starts this checkout's Electron itself, and Tree is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build), whose copy of a file differs from the project's.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'cardcontext-profile')
const ws = path.join(lib.WORK, 'cardcontext-ws')
const claudeHome = path.join(lib.WORK, 'cardcontext-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47937))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

const PLAN = '# Plan\n\nIntro.\n\n## Setup\n\nInstall the tools, then run SETUP-MARKER.\n\n## Release\n\nShip it.\n'
const NOTES = '# Notes\n\n## Open questions\n\nWhich QUESTION-MARKER first?\n'

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(path.join(alpha, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(alpha, 'docs', 'PLAN.md'), PLAN)
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      const text = await res.text()
      return { status: res.status, body: (() => { try { return JSON.parse(text) } catch { return text } })() }
    }
    await api('PUT', `/v1/shared/file?path=${encodeURIComponent('plans/notes.md')}`, { content: NOTES })
    const refs = ['docs/PLAN.md#setup', 'shared:plans/notes.md#open-questions']

    // --- The Agent API: set, checked, shown, replaced, cleared.
    let r = await api('POST', '/v1/tasks', { title: 'Build the setup', description: 'Do it.', project: 'alpha', context: refs })
    const n = r.body.number
    check('a card is created with its references', r.status === 200 && JSON.stringify(r.body.context) === JSON.stringify(refs), JSON.stringify(r.body))
    for (const [what, bad] of [
      ['a line number', 'docs/PLAN.md#L12'],
      ['not Markdown', 'src/app.ts#setup'],
      ['not a list', 'docs/PLAN.md']
    ]) {
      r = await api('PATCH', `/v1/tasks/${n}`, { context: what === 'not a list' ? bad : [bad] })
      check(`a reference that is ${what}: refused (400)`, r.status === 400, JSON.stringify(r))
    }
    r = await api('PATCH', `/v1/tasks/${n}`, { context: Array.from({ length: 11 }, (_, i) => `docs/D${i}.md`) })
    check('more than ten: refused', r.status === 400 && /up to 10/.test(r.body.error), JSON.stringify(r))
    r = await api('GET', `/v1/tasks/${n}`)
    check('…the card keeps what it had', JSON.stringify(r.body.context) === JSON.stringify(refs), JSON.stringify(r.body.context))
    r = await api('PATCH', `/v1/tasks/${n}`, { context: [] })
    check('[] clears them, said in its history', r.status === 200 && r.body.context === undefined && r.body.history.some((h) => /Removed the doc sections to read first/.test(JSON.stringify(h))), JSON.stringify(r.body).slice(0, 400))
    // Through the hive tools, as an agent sets them.
    const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cw_update_task', arguments: { number: n, context: refs } } }) + '\n',
      env: lib.childEnv({ CW_API_URL: `http://127.0.0.1:${PORT}`, CW_WORKSPACE: ws, CW_API_TOKEN_FILE: lib.tokenFile(token), CW_PROJECT: 'alpha' }),
      timeout: 60000
    }).toString()
    const said = JSON.parse(out.split('\n')[0]).result.content[0].text
    check('cw_update_task sets them, its reply says so', said.includes(`Read first: ${refs.join(', ')}`), said)
    r = await api('GET', `/v1/tasks/${n}`)
    check('…and the card has them again', JSON.stringify(r.body.context) === JSON.stringify(refs), JSON.stringify(r.body.context))

    // --- The card dialog: the references, each a link to its section.
    await page.keyboard.press('Control+Shift+J')
    const tile = page.locator('.task-card', { hasText: 'Build the setup' })
    await lib.until(async () => (await tile.count()) === 1, HUNG_MS)
    await tile.click()
    const dialog = page.locator('.dialog[role="dialog"]').first()
    const box = dialog.locator('.task-context textarea')
    check('the dialog shows its Read first, one a line', !!(await lib.until(async () => (await box.inputValue().catch(() => '')) === refs.join('\n'), HUNG_MS)), await box.inputValue().catch(() => ''))
    const links = dialog.locator('.task-context-links .link-button')
    check('…each a link', (await links.allInnerTexts()).join('|') === refs.join('|'), JSON.stringify(await links.allInnerTexts()))
    const theme = async (t) => {
      await inv('settings:update', { appearance: { theme: t } })
      await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme ?? document.body.className)).includes(t), HUNG_MS)
    }
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.screenshot({ path: path.join(lib.WORK, `cardcontext-1-dialog-${t}.png`) })
    }
    await links.first().click()
    const viewer = page.locator('.dialog[role="dialog"]', { hasText: 'docs/PLAN.md#setup' }).last()
    check('a link opens its section in the viewer, and only that section', !!(await lib.until(async () => (await viewer.locator('.doc-ref-section').innerText().catch(() => '')).includes('SETUP-MARKER'), HUNG_MS)) && !(await viewer.innerText()).includes('Ship it'), await viewer.innerText().catch(() => ''))
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.screenshot({ path: path.join(lib.WORK, `cardcontext-2-viewer-${t}.png`) })
    }
    await viewer.getByRole('button', { name: 'Close', exact: true }).click()
    await lib.until(async () => (await page.locator('.doc-ref-section').count()) === 0, HUNG_MS)
    await links.nth(1).click()
    const noteViewer = page.locator('.dialog[role="dialog"]', { hasText: 'shared:plans/notes.md#open-questions' }).last()
    check('…a shared note too', !!(await lib.until(async () => (await noteViewer.locator('.doc-ref-section').innerText().catch(() => '')).includes('QUESTION-MARKER'), HUNG_MS)), await noteViewer.innerText().catch(() => ''))
    await noteViewer.getByRole('button', { name: 'Close', exact: true }).click()
    await lib.until(async () => (await page.locator('.doc-ref-section').count()) === 0, HUNG_MS)

    // --- Open in Files / Open in Shared Notes (#818 round 2): the card closes too, so the file or note is usable.
    const dialogs = () => page.locator('.dialog[role="dialog"]').count()
    const openCard = async () => {
      await page.keyboard.press('Control+Shift+J')
      await lib.until(async () => (await tile.count()) === 1, HUNG_MS)
      await tile.click()
      await lib.until(async () => (await box.count()) === 1, HUNG_MS)
    }
    const viewAndOpen = async (k, button) => {
      await links.nth(k).click()
      const v = page.locator('.dialog[role="dialog"]').filter({ has: page.locator('.doc-ref-section') }).last()
      await lib.until(async () => (await v.locator('.doc-ref-section').count()) === 1, HUNG_MS)
      await v.getByRole('button', { name: button, exact: true }).click()
    }
    await viewAndOpen(0, 'Open in Files')
    const selectedRow = () => page.locator('.file-row.selected').getAttribute('data-rel').catch(() => null)
    check('Open in Files: no dialog left over the Files tab, the file selected at its heading', !!(await lib.until(async () => (await dialogs()) === 0 && (await selectedRow()) === 'docs/PLAN.md' && (await page.locator('.monaco .active-line-number').first().innerText().catch(() => '')) === '5', HUNG_MS)), `${await dialogs()} dialogs, ${await selectedRow()}`)
    await openCard()
    await viewAndOpen(1, 'Open in Shared Notes')
    check('Open in Shared Notes: no dialog left, the note shown', !!(await lib.until(async () => (await dialogs()) === 0 && (await page.getByText('QUESTION-MARKER').count()) > 0, HUNG_MS)), `${await dialogs()} dialogs`)
    // An edited card asks first: Keep Editing keeps the card and its edit and goes nowhere; Discard goes.
    await openCard()
    await box.fill([...refs, 'docs/PLAN.md#release-notes-draft'].join('\n'))
    await viewAndOpen(0, 'Open in Files')
    const keep = page.getByRole('button', { name: 'Keep Editing' })
    check('an edited card asks before it closes', !!(await lib.until(async () => (await keep.count()) === 1, HUNG_MS)))
    await keep.click()
    // The Files tab stays mounted from the step before: nothing opened is the card still up over the board, the tree hidden.
    check('…Keep Editing: the card stays with its edit, nothing opened', !!(await lib.until(async () => (await box.inputValue().catch(() => '')).endsWith('release-notes-draft') && (await dialogs()) === 1, HUNG_MS)) && !(await page.locator('.file-tree').isVisible().catch(() => false)), `${await box.inputValue().catch(() => '')} / ${await dialogs()} dialogs / tree ${await page.locator('.file-tree').isVisible().catch(() => false)}`)
    await viewAndOpen(0, 'Open in Files')
    await page.getByRole('button', { name: 'Discard' }).click()
    check('…Discard: the card closes and the file opens', !!(await lib.until(async () => (await dialogs()) === 0 && (await selectedRow()) === 'docs/PLAN.md', HUNG_MS)))
    r = await api('GET', `/v1/tasks/${n}`)
    check('…and the discarded edit was not saved', JSON.stringify(r.body.context) === JSON.stringify(refs), JSON.stringify(r.body.context))
    await openCard()

    // Edited in the dialog: a third reference, saved.
    await box.fill([...refs, 'docs/PLAN.md#release'].join('\n'))
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    r = await lib.until(async () => {
      const c = await api('GET', `/v1/tasks/${n}`)
      return c.body.context?.length === 3 ? c : null
    }, HUNG_MS)
    check('Save in the dialog keeps the edited list', JSON.stringify(r?.body.context) === JSON.stringify([...refs, 'docs/PLAN.md#release']), JSON.stringify(r?.body.context))
    // A reference that leads nowhere opens a viewer that says why.
    await tile.click()
    await lib.until(async () => (await dialog.count()) === 1, HUNG_MS)
    await box.fill('docs/PLAN.md#nowhere')
    await dialog.locator('.task-context-links .link-button').first().click()
    const broken = page.locator('.dialog[role="dialog"]', { hasText: 'docs/PLAN.md#nowhere' }).last()
    check("a reference whose heading isn't there: the viewer says so, with the closest", !!(await lib.until(async () => /That heading isn't in the file\. Closest headings: /.test(await broken.innerText().catch(() => '')), HUNG_MS)), await broken.innerText().catch(() => ''))
    await broken.getByRole('button', { name: 'Close', exact: true }).click()
    await page.keyboard.press('Escape')
    const discard = page.getByRole('button', { name: 'Discard' })
    // Escape either closes the dialog or asks to discard the edit: wait for whichever comes.
    await lib.until(async () => (await discard.count()) > 0 || (await dialog.count()) === 0, HUNG_MS)
    if ((await discard.count()) > 0) await discard.click()
    await lib.until(async () => (await dialog.count()) === 0, HUNG_MS)

    // --- Started on an agent: its prompt lists them with their sizes, not their text.
    const agent = await lib.addAgent(inv, alpha, { name: 'Builder' })
    await inv('tasks:start', n, { kind: 'agent', agentId: agent.id })
    const transcript = () => {
      const dir = path.join(claudeHome, 'projects')
      if (!fs.existsSync(dir)) return ''
      return fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(dir, String(f)), 'utf8')).join('\n')
    }
    const got = await lib.until(() => (/Read these first: docs\/PLAN\.md#setup \(\d+ characters\), shared:plans\/notes\.md#open-questions \(\d+ characters\), docs\/PLAN\.md#release \(\d+ characters\)\. cw_read_section reads each as the card has it \(path: the file; heading: # and the slug after it, none for a whole file; from: \\"project\\"\)/.test(transcript()) ? transcript() : null), HUNG_MS)
    check("the start prompt lists them with each section's size, read from the project's copy", !!got, transcript().slice(-800))
    check('…not the sections themselves', !!got && !got.includes('SETUP-MARKER') && !got.includes('QUESTION-MARKER'))
    await inv('session:stop', alpha)

    // --- A worktree agent (#818 round 2): its copy differs; the card's references read from the project's copy, as the
    // card was briefed, through the read the prompt names (from: "project"), a whole file too.
    const tree = await lib.addAgent(inv, alpha, { name: 'Tree', location: 'new-worktree' })
    const treePath = (await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha').agents.find((a) => a.id === tree.id).worktree.path
    fs.writeFileSync(path.join(treePath, 'docs', 'PLAN.md'), '# Plan\n\n## Setup\n\nWORKTREE-COPY.\n')
    fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), treePath.toLowerCase()]))
    const n2 = (await api('POST', '/v1/tasks', { title: 'Tree work', project: 'alpha', context: ['docs/PLAN.md#setup', 'docs/PLAN.md'] })).body.number
    await inv('tasks:start', n2, { kind: 'agent', agentId: tree.id })
    const liveTree = async () => (await inv('session:live')).find((s) => s.agentId === tree.id)
    await lib.until(async () => !!(await liveTree())?.sessionId, HUNG_MS)
    const sessionId = (await liveTree()).sessionId
    const launchesFile = path.join(claudeHome, 'fake-launches.jsonl')
    const launch = await lib.until(() => {
      const text = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.sessionId === sessionId && l.opts['--mcp-config'])
    }, HUNG_MS)
    const treeToken = JSON.parse(fs.readFileSync(JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork.env.CW_API_TOKEN_FILE, 'utf8')).token
    const asTree = async (p) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { Authorization: `Bearer ${treeToken}` } })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    r = await asTree(`/v1/docs/section?path=docs%2FPLAN.md&heading=%23setup&from=project`)
    check("the worktree agent reads the card's section from the project's copy, as the card shows it", r.status === 200 && r.body.content.includes('SETUP-MARKER'), JSON.stringify(r))
    r = await asTree(`/v1/docs/section?path=docs%2FPLAN.md&from=project`)
    check('…a whole-file reference too (no heading: the whole document)', r.status === 200 && r.body.content === PLAN && r.body.size === PLAN.length, JSON.stringify(r).slice(0, 200))
    r = await asTree(`/v1/docs/section?path=docs%2FPLAN.md&heading=%23setup`)
    check('…while its own reads stay in its worktree', r.status === 200 && r.body.content.includes('WORKTREE-COPY'), JSON.stringify(r))
    await inv('session:stop', alpha)
    await lib.until(async () => (await inv('session:live')).length === 0, HUNG_MS)

    // --- #819: references that don't resolve are flagged, saved or at the start, and named in the prompt.
    r = await api('POST', '/v1/tasks', { title: 'Check the refs', project: 'alpha', context: ['docs/PLAN.md#nowhere', 'docs/PLAN.md#setup'] })
    const n3 = r.body.number
    check('saved with a heading that isn’t there: flagged on the card, with the closest', JSON.stringify(r.body.contextProblems?.map((p) => [p.ref, p.problem])) === '[["docs/PLAN.md#nowhere","noHeading"]]' && r.body.contextProblems[0].closest?.length > 0, JSON.stringify(r.body.contextProblems))
    await page.keyboard.press('Control+Shift+J')
    const tile3 = page.locator('.task-card', { hasText: 'Check the refs' })
    const warn = tile3.locator('.task-context-broken')
    check('the tile shows it, naming the reference', !!(await lib.until(async () => (await warn.innerText().catch(() => '')).includes('Read first no longer resolves: docs/PLAN.md#nowhere'), HUNG_MS)), await tile3.innerText().catch(() => ''))
    await tile3.click()
    const problemsBox = page.locator('.task-context-problems')
    check('the dialog lists it with why and the closest headings', !!(await lib.until(async () => /docs\/PLAN\.md#nowhere: That heading isn't in the file\. Closest headings: #/.test(await problemsBox.innerText().catch(() => '')), HUNG_MS)), await problemsBox.innerText().catch(() => ''))
    check('…and strikes its link through', (await page.locator('.task-context-links .link-button.broken').allInnerTexts()).join('|') === 'docs/PLAN.md#nowhere')
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.screenshot({ path: path.join(lib.WORK, `cardcontext-3-broken-dialog-${t}.png`) })
    }
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.dialog[role="dialog"]').count()) === 0, HUNG_MS)
    for (const t of ['dark', 'light']) {
      await theme(t)
      await tile3.screenshot({ path: path.join(lib.WORK, `cardcontext-4-broken-tile-${t}.png`) })
    }
    // The heading renamed since: the start finds it, records it on the card and names both in the prompt.
    fs.writeFileSync(path.join(alpha, 'docs', 'PLAN.md'), PLAN.replace('## Setup', '## Set up'))
    await inv('tasks:start', n3, { kind: 'agent', agentId: agent.id })
    const named = await lib.until(() => (/These references no longer resolve: docs\/PLAN\.md#nowhere \(no such heading; closest: [^)]*\); docs\/PLAN\.md#setup \(no such heading; closest: #set-up[^)]*\)\. Ask the user which section is meant, or read the closest\./.test(transcript()) ? true : null), HUNG_MS)
    check('a heading renamed before the start: the prompt names it, why and the closest, never silently nothing', !!named, transcript().slice(-600))
    r = await lib.until(async () => {
      const c = await api('GET', `/v1/tasks/${n3}`)
      return c.body.contextProblems?.length === 2 ? c : null
    }, HUNG_MS)
    check('…and the card has both flagged now', !!r && r.body.contextProblems[1].ref === 'docs/PLAN.md#setup' && r.body.contextProblems[1].closest[0] === 'set-up', JSON.stringify(r?.body.contextProblems))
    fs.writeFileSync(path.join(alpha, 'docs', 'PLAN.md'), PLAN)

    // A worktree agent with only references that don't resolve (#819 round 2): the prompt still says to read the closest
    // from the project's copy, where the closest headings were found; its worktree's copy differs.
    await inv('session:stop', alpha)
    await lib.until(async () => (await inv('session:live')).length === 0, HUNG_MS)
    const n4 = (await api('POST', '/v1/tasks', { title: 'Only broken refs', project: 'alpha', context: ['docs/PLAN.md#setupp'] })).body.number
    await inv('tasks:start', n4, { kind: 'agent', agentId: tree.id })
    const closestRead = await lib.until(() => (/This reference no longer resolves: docs\/PLAN\.md#setupp \(no such heading; closest: #setup[^)]*\)\. Ask the user which section is meant, or read the closest\. cw_read_section reads the closest as the card has it \(path: the file; heading: # and the slug; from: \\"project\\"\)\./.test(transcript()) ? true : null), HUNG_MS)
    check('only broken references, a worktree agent: the prompt says to read the closest from the project’s copy', !!closestRead, transcript().slice(-700))
    const tree2 = (await inv('session:live')).find((s) => s.agentId === tree.id)
    const launch2 = await lib.until(() => {
      const text = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.sessionId === tree2?.sessionId && l.opts['--mcp-config'])
    }, HUNG_MS)
    const tree2Token = JSON.parse(fs.readFileSync(JSON.parse(fs.readFileSync(launch2.opts['--mcp-config'], 'utf8')).mcpServers.combwork.env.CW_API_TOKEN_FILE, 'utf8')).token
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/docs/section?path=docs%2FPLAN.md&heading=%23setup&from=project`, { headers: { Authorization: `Bearer ${tree2Token}` } })
    const closest = await res.json().catch(() => null)
    check('…and that read gives the project’s section, not the worktree’s', res.status === 200 && closest?.content.includes('SETUP-MARKER') && !closest.content.includes('WORKTREE-COPY'), JSON.stringify(closest))

    await inv('session:stop', alpha)
    await lib.until(async () => (await inv('session:live')).length === 0, HUNG_MS)
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
