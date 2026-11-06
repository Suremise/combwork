// Documents by section (#817), through the real Agent API and cw-mcp.js: a project agent outlines and reads its own
// project's Markdown in the folder it works in (its worktree's copy), not another project's (403, as its sessions);
// the workspace token reads any project's (the project folder's copy) and shared notes (shared:<path>); a section by
// slug or text comes with its subsections; a repeated heading is ambiguous (409, listing both slugs) and an unknown one
// lists the closest (404); paths outside the project (.., a junction out of it), into .combwork or .git, or not Markdown are
// refused before anything is read. The agent runs the fake Claude Code. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
// Dev build only (#1580): it starts this checkout's Electron itself, and Alfie is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build), whose copy of the plan differs from the project folder's.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'docsections-profile')
const ws = path.join(lib.WORK, 'docsections-ws')
const ws2 = path.join(lib.WORK, 'docsections-ws2')
const claudeHome = path.join(lib.WORK, 'docsections-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const PORT = Number(lib.port(47936))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

const PLAN = (copy) => `# Plan (${copy})\n\nIntro.\n\n## Core contracts\n\nThe contracts.\n\n\`\`\`md\n# not a heading\n\`\`\`\n\n### Errors\n\nErrors.\n\n## Setup\n\nFirst.\n\n## Setup\n\nSecond.\n`

;(async () => {
  for (const d of [userData, ws, ws2, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  for (const p of [alpha, beta]) {
    fs.mkdirSync(path.join(p, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(p, 'docs', 'PLAN.md'), PLAN(path.basename(p)))
    fs.writeFileSync(path.join(p, 'notes.txt'), 'not markdown')
  }
  // A section copied with its explicit id (#1535): two headings carry #setup.
  fs.writeFileSync(path.join(alpha, 'docs', 'IDS.md'), '# Ids\n\n## Version Control <a id="git"></a>\n\nGit.\n\n## First <a id="setup"></a>\n\nOne.\n\n## Second <a id="setup"></a>\n\nTwo.\n')
  lib.gitProject(alpha)
  lib.gitProject(beta)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), beta.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1300, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)

    // An agent in a worktree of alpha: its copy of the plan differs from the project folder's.
    const agent = await lib.addAgent(inv, alpha, { name: 'Alfie', location: 'new-worktree' })
    const tree = (await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha').agents.find((a) => a.id === agent.id).worktree.path
    fs.writeFileSync(path.join(tree, 'docs', 'PLAN.md'), PLAN('worktree'))
    // A junction inside the worktree to beta: its files are outside the project.
    fs.symlinkSync(beta, path.join(tree, 'beta-link'), 'junction')
    // The fake Claude Code trusts the worktree too, so the agent starts without asking.
    fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), beta.toLowerCase(), tree.toLowerCase()]))
    const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
    await inv('session:start', alpha, { agentId: agent.id })
    check('the agent starts', !!(await lib.until(async () => (await live())?.status === 'ready', HUNG_MS)))

    // The agent's own token, from its launch (as boardscope.cjs reads it).
    const sessionId = (await live())?.sessionId
    const launchesFile = path.join(claudeHome, 'fake-launches.jsonl')
    const launches = () => {
      const text = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    }
    const launch = await lib.until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
    if (!launch) throw new Error("the agent's launch wasn't recorded: the rest needs its token")
    const mcpEnv = JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork.env
    const agentToken = JSON.parse(fs.readFileSync(mcpEnv.CW_API_TOKEN_FILE, 'utf8')).token
    const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const call = async (token, p) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { Authorization: `Bearer ${token}` } })
      const text = await res.text()
      return { status: res.status, body: (() => { try { return JSON.parse(text) } catch { return text } })() }
    }
    const q = (o) => new URLSearchParams(o).toString()
    const outline = (token, o) => call(token, `/v1/docs/outline?${q(o)}`)
    const section = (token, o) => call(token, `/v1/docs/section?${q(o)}`)

    // --- The agent: its own project's documents, in its worktree.
    let r = await outline(agentToken, { path: 'docs/PLAN.md' })
    check("the agent outlines its worktree's copy", r.status === 200 && r.body.headings[0].text === 'Plan (worktree)', JSON.stringify(r.body).slice(0, 300))
    check('…every heading outside the code fence, with unique slugs and sizes', r.status === 200 && r.body.headings.map((h) => h.slug).join(',') === 'plan-worktree,core-contracts,errors,setup,setup-1' && r.body.headings.every((h) => h.size > 0), JSON.stringify(r.body.headings))
    r = await section(agentToken, { path: 'docs/PLAN.md', heading: 'Core contracts' })
    check('a section by its text, with its subsection', r.status === 200 && r.body.content.startsWith('## Core contracts') && r.body.content.includes('### Errors') && !r.body.content.includes('## Setup'), JSON.stringify(r.body))
    r = await section(agentToken, { path: 'docs/PLAN.md', heading: 'setup' })
    check('a heading two sections share: ambiguous, both listed as #<slug>', r.status === 409 && r.body.error.includes('#setup (Setup, line 17), #setup-1 (Setup, line 21)') && r.body.matches?.length === 2, JSON.stringify(r.body))
    // Each slug listed reads its own section (#817 round 2): the first of the two as well.
    for (const m of r.body.matches ?? []) {
      const one = await section(agentToken, { path: 'docs/PLAN.md', heading: `#${m.slug}` })
      check(`…#${m.slug} reads that one`, one.status === 200 && one.body.heading.line === m.line && one.body.content.includes(m.line === 17 ? 'First.' : 'Second.'), JSON.stringify(one.body))
    }
    r = await section(agentToken, { path: 'docs/PLAN.md', heading: 'setup-1' })
    check('…and a numbered slug without # is the second', r.status === 200 && r.body.content.includes('Second.'), JSON.stringify(r.body))
    r = await section(agentToken, { path: 'docs/PLAN.md', heading: 'core contract' })
    check('an unknown heading: the closest, never an empty section', r.status === 404 && r.body.error.includes('Closest: #core-contracts') && r.body.closest?.[0]?.slug === 'core-contracts', JSON.stringify(r.body))
    // An explicit id (#1535) finds its heading in any form; one two headings carry is ambiguous in every form, never the first.
    for (const heading of ['#git', 'git', 'GIT']) {
      r = await section(agentToken, { path: 'docs/IDS.md', heading })
      check(`an explicit id finds its heading (${heading})`, r.status === 200 && r.body.content.startsWith('## Version Control'), JSON.stringify(r.body))
    }
    for (const heading of ['#setup', 'setup', 'SETUP', '#Setup']) {
      r = await section(agentToken, { path: 'docs/IDS.md', heading })
      check(`an id two headings carry: ambiguous (${heading}), both listed`, r.status === 409 && r.body.matches?.map((m) => m.text).join() === 'First,Second', JSON.stringify(r.body))
    }
    r = await outline(agentToken, { path: 'docs/PLAN.md', project: 'beta' })
    check("another project's documents: refused (403)", r.status === 403, JSON.stringify(r))

    // --- Paths refused before anything is read.
    for (const [what, p, status] of [
      ['outside the project (..)', '../beta/docs/PLAN.md', 400],
      ['through a junction out of it', 'beta-link/docs/PLAN.md', 400],
      ["in Combwork's own folder", '.combwork/project.json', 400],
      ["in git's", '.git/description.md', 400],
      ['not Markdown', 'notes.txt', 400],
      ['an absolute path', path.join(beta, 'docs', 'PLAN.md'), 400],
      ['missing', 'docs/GONE.md', 404]
    ]) {
      r = await outline(agentToken, { path: p })
      check(`a path ${what}: ${status}`, r.status === status, JSON.stringify(r))
    }

    // --- The workspace token: any project's (the project folder's copy), and shared notes.
    r = await outline(workspaceToken, { path: 'docs/PLAN.md', project: 'beta' })
    check("the workspace token reads another project's", r.status === 200 && r.body.headings[0].text === 'Plan (beta)', JSON.stringify(r.body).slice(0, 200))
    r = await outline(workspaceToken, { path: 'docs/PLAN.md', project: 'alpha' })
    check("…and the project folder's copy (not a worktree's)", r.status === 200 && r.body.headings[0].text === 'Plan (alpha)', JSON.stringify(r.body).slice(0, 200))
    r = await outline(workspaceToken, { path: 'docs/PLAN.md' })
    check('a project file with no project and no agent: project is required', r.status === 400 && /project is required/.test(r.body.error), JSON.stringify(r))
    // A junction inside the project into its .combwork (#817 round 2): refused by where it leads, not only by its name.
    fs.mkdirSync(path.join(alpha, '.combwork', 'private'), { recursive: true })
    fs.writeFileSync(path.join(alpha, '.combwork', 'private', 'SECRET.md'), '# Private\n\nCW SECRET\n')
    fs.symlinkSync(path.join(alpha, '.combwork', 'private'), path.join(alpha, 'alias'), 'junction')
    fs.symlinkSync(path.join(alpha, '.git'), path.join(alpha, 'git-alias'), 'junction')
    fs.writeFileSync(path.join(alpha, '.git', 'NOTE.md'), '# Git\n\nGIT SECRET\n')
    for (const p of ['alias/SECRET.md', 'git-alias/NOTE.md', '.combwork/private/SECRET.md']) {
      r = await section(workspaceToken, { path: p, heading: '#private', project: 'alpha' })
      check(`a path into .combwork or .git by another name (${p}): refused, nothing read`, r.status === 400 && !/(CW|GIT) SECRET/.test(JSON.stringify(r.body)), JSON.stringify(r))
    }
    const note = '# Design\n\n## Extraction lanes\n\nLanes.\n\n## Review\n\nReview.\n'
    await fetch(`http://127.0.0.1:${PORT}/v1/shared/file?path=${encodeURIComponent('plans/design.md')}`, { method: 'PUT', headers: { Authorization: `Bearer ${workspaceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: note }) })
    r = await section(agentToken, { path: 'shared:plans/design.md', heading: 'extraction-lanes' })
    check('a shared note, by slug (the agent too)', r.status === 200 && r.body.content === '## Extraction lanes\n\nLanes.', JSON.stringify(r.body))
    r = await outline(agentToken, { path: 'shared:../outside.md' })
    check('a shared path outside the notes: refused', r.status === 400, JSON.stringify(r))

    // --- Through cw-mcp.js, as the agent's tools: lean text.
    const tool = (name, args) => {
      const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], {
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
        env: lib.childEnv({ CW_API_URL: `http://127.0.0.1:${PORT}`, CW_WORKSPACE: ws, CW_API_TOKEN_FILE: lib.tokenFile(agentToken), CW_PROJECT: 'alpha', CW_AGENT_ID: agent.id }),
        timeout: 60000
      }).toString()
      const res = JSON.parse(out.split('\n')[0]).result
      return { text: res.content[0].text, isError: !!res.isError }
    }
    let t = tool('cw_doc_outline', { path: 'docs/PLAN.md' })
    check('cw_doc_outline: a line per heading with its [slug] and size', !t.isError && t.text.startsWith('docs/PLAN.md: 5 headings, ') && t.text.includes('\n  ## Core contracts [core-contracts] ') && t.text.endsWith('cw_read_section reads one as #<slug>.'), t.text)
    t = tool('cw_doc_outline', { path: 'docs/PLAN.md', depth: 1 })
    check('…depth=1: the top level only', !t.isError && !t.text.includes('Core contracts') && t.text.includes('# Plan (worktree)'), t.text)
    t = tool('cw_doc_outline', { path: 'docs/PLAN.md', from: 'project', depth: 1 })
    check('…from: "project": the project folder’s copy, not its worktree’s (#818)', !t.isError && t.text.includes('# Plan (alpha)'), t.text)
    t = tool('cw_read_section', { path: 'docs/PLAN.md' })
    check('cw_read_section with no heading: the whole document', !t.isError && t.text.startsWith('docs/PLAN.md (') && t.text.includes('## Setup'), t.text.slice(0, 200))
    t = tool('cw_read_section', { path: 'docs/PLAN.md', heading: 'errors' })
    check('cw_read_section: where it is, then its text', !t.isError && t.text.startsWith('docs/PLAN.md#errors (') && t.text.endsWith('### Errors\n\nErrors.'), t.text)
    t = tool('cw_read_section', { path: 'docs/IDS.md', heading: 'setup' })
    check('cw_read_section: an id two headings carry is an error listing both, never the first', t.isError && t.text.includes('#setup (First, line 7)') && t.text.includes('#setup-1 (Second, line 11)') && !t.text.includes('One.'), t.text)
    t = tool('cw_read_section', { path: 'shared:plans/design.md', heading: 'nothing like it' })
    check('…an unknown heading is an error naming the closest', t.isError && /Closest: /.test(t.text), t.text)

    // --- Two workspaces open (#817 round 2): an agent's and the Assistant's shared notes and projects are their own
    // workspace's, whatever the request names; the workspace token reads the other's when it names it.
    lib.gitProject(path.join(ws2, 'gamma'))
    fs.mkdirSync(path.join(ws2, 'gamma', 'docs'), { recursive: true })
    fs.writeFileSync(path.join(ws2, 'gamma', 'docs', 'PLAN.md'), '# Gamma\n\nGAMMA SECRET\n')
    const next = app.waitForEvent('window')
    await inv('window:new')
    const page2 = await next
    await page2.waitForLoadState('domcontentloaded')
    await lib.appReady(page2)
    await page2.evaluate((p) => window.combwork.invoke('workspace:open', p), ws2)
    const other = `${path.basename(ws2)}/gamma`
    const put = await fetch(`http://127.0.0.1:${PORT}/v1/shared/file?path=secret.md&workspace=${encodeURIComponent(path.basename(ws2))}`, { method: 'PUT', headers: { Authorization: `Bearer ${workspaceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '# Secret\n\n## Other workspace\n\nWS2 SECRET\n' }) })
    check('the second workspace has a note', put.status === 200, String(put.status))
    // The Assistant of the first workspace, with its own token.
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    await lib.until(async () => (await inv('session:live')).some((s) => s.agentId === 'assistant' && s.status === 'ready'), HUNG_MS)
    const asFile = path.join(userData, 'assistant-api', `${require('crypto').createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const assistantToken = (await lib.until(() => fs.existsSync(asFile) && JSON.parse(fs.readFileSync(asFile, 'utf8')).token, HUNG_MS)) || ''
    check("the Assistant's token", !!assistantToken)
    for (const [who, token] of [['an agent', agentToken], ['the Assistant', assistantToken]]) {
      for (const [what, fn] of [['outline', outline], ['section', section]]) {
        r = await fn(token, { path: 'shared:secret.md', project: other, heading: 'other-workspace' })
        check(`${who}: another workspace's shared note (${what}, project ${other}): not reached`, r.status === 404 && !JSON.stringify(r.body).includes('WS2 SECRET'), JSON.stringify(r))
        r = await fn(token, { path: 'docs/PLAN.md', project: other, heading: 'gamma' })
        check(`${who}: another workspace's project file (${what}): refused`, (r.status === 403 || r.status === 404) && !JSON.stringify(r.body).includes('GAMMA SECRET'), JSON.stringify(r))
      }
    }
    r = await section(workspaceToken, { path: 'shared:secret.md', heading: 'other-workspace' })
    check('the workspace token, with two workspaces open, must say which', r.status === 400 && /Several workspaces/.test(r.body.error), JSON.stringify(r))
    r = await call(workspaceToken, `/v1/docs/section?${q({ path: 'shared:secret.md', heading: 'other-workspace', workspace: path.basename(ws2) })}`)
    check('…and reads that workspace’s note when it names it', r.status === 200 && r.body.content.includes('WS2 SECRET'), JSON.stringify(r))
    r = await outline(workspaceToken, { path: 'docs/PLAN.md', project: other })
    check("…and its projects' files by <workspace>/<project>", r.status === 200 && r.body.headings[0].text === 'Gamma', JSON.stringify(r))
    await inv('session:stop', home)

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
