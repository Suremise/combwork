// Combwork's tool replies stay lean: every Combwork MCP tool (through out/main/cw-mcp.js, as an agent and as the
// Assistant) and the Agent API routes behind them, against a busy workspace (four projects, ~75 cards with long
// descriptions and comments, handovers, notes, running agents). Checks what the replies say and that each stays
// within its size; prints every reply's size in characters and writes the sizes and texts to replysize.json and
// replysize-texts.json in the e2e folder. The Agent API's own replies are checked to be unchanged. Agents run the fake Claude Code. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { execFileSync } = require('child_process')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
// A loaded machine took longer than 15 s for an agent's turn (#724).
const HUNG_MS = 60000

const userData = path.join(lib.WORK, 'replysize-profile')
const ws = path.join(lib.WORK, 'replysize-ws')
const claudeHome = path.join(lib.WORK, 'replysize-claude-home')
const PORT = Number(lib.port(47899))
const API = `http://127.0.0.1:${PORT}`
const PROJECTS = ['alpha', 'beta', 'gamma', 'delta']
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Text like a real card's description: a few markdown sections, about `n` characters. */
const prose = (seed, n) => {
  const words = 'the agent should check the settings view and make sure each value is kept when the window reloads then update the tests and the user guide so the behaviour is described clearly including edge cases like an empty field a negative number or a value pasted with spaces'.split(' ')
  let out = `## Why\nCard ${seed}: `
  for (let i = 0; out.length < n; i++) out += (i % 40 === 39 ? '.\n\n## What\n- ' : words[(i * 7 + seed) % words.length] + ' ')
  return out
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  for (const p of PROJECTS) lib.gitProject(path.join(ws, p))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), ...PROJECTS.map((p) => path.join(ws, p).toLowerCase())]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true, allowSessionInput: true, devConsole: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  // Once (4 Oct 2026) the page closed during a workspace switch, with nothing in Combwork's log: say what happened, if again.
  page.on('crash', () => console.log(`PAGE CRASHED ${new Date().toISOString()}`))
  page.on('close', () => console.log(`PAGE CLOSED ${new Date().toISOString()}`))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.on('close', () => console.log(`CW WINDOW CLOSING ${new Date().toISOString()}`)))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 15000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, p, body, bearer = apiToken) => {
    const res = await fetch(API + p, { method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await res.text()
    return { status: res.status, text, body: (() => { try { return JSON.parse(text) } catch { return null } })() }
  }
  for (const p of PROJECTS) await inv('project:setActive', path.join(ws, p), true).catch(() => undefined)

  // Agents: two in alpha (one running a few turns), one in beta.
  const alpha = path.join(ws, 'alpha')
  // The suite's own untracked files in alpha (attachments, a long doc) are left out of git from the start (HI-2960):
  // untracked, they'd make every start and lane start warn that master's folder has uncommitted changes (HI-2944), and
  // a card's clean check refuse.
  const exclude = path.join(alpha, '.git', 'info', 'exclude')
  fs.mkdirSync(path.dirname(exclude), { recursive: true })
  fs.appendFileSync(exclude, '\nattach-src/\ndocs/\n')
  // Each builds and reviews the other's lanes (HI-2664: a lane part only for a role that does it).
  const coder = await lib.addAgent(inv, alpha, { name: 'Coder', workflowRole: 'either' })
  await lib.addAgent(inv, alpha, { name: 'Tester', workflowRole: 'either' })
  await lib.addAgent(inv, path.join(ws, 'beta'), { name: 'Builder' })
  const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
  /**
   * A workflow change restarts alpha's running agents whose tools it changes (HI-2694), with a new token each: before a
   * call with an agent's own token, each is running again on the list it would launch with now (asked: 'same').
   */
  const toolsSettled = async () => {
    for (const s of (await inv('session:live')).filter((x) => x.projectPath.toLowerCase() === alpha.toLowerCase() && x.status !== 'stopped')) {
      const ok = await until(async () => (await inv('session:restartForTools', alpha, s.agentId, 'ifIdle')) === 'same' && ['ready', 'finished', 'watching'].includes((await live(alpha, s.agentId))?.status), HUNG_MS)
      check(`a workflow change: ${s.agentId} running on its tools now`, !!ok, JSON.stringify(await live(alpha, s.agentId)))
    }
  }
  await inv('session:start', alpha, { agentId: coder.id })
  await until(async () => (await live(alpha, coder.id))?.status === 'ready', HUNG_MS)
  for (let i = 1; i <= 4; i++) {
    await inv('pty:write', lib.ptyKey(alpha, coder.id), `turn ${i}`)
    await lib.sleep(200)
    await inv('pty:write', lib.ptyKey(alpha, coder.id), '\r')
    await until(async () => String(await inv('pty:buffer', lib.ptyKey(alpha, coder.id))).includes(`Done: turn ${i}`), HUNG_MS)
  }

  // The board: 50 in Todo, 6 in Doing, 10 in Review, 10 in Done; long descriptions, three comments each, some history.
  const cols = [...Array(50).fill('todo'), ...Array(6).fill('doing'), ...Array(10).fill('review'), ...Array(10).fill('done')]
  const numbers = []
  for (let i = 0; i < cols.length; i++) {
    const r = await api('POST', '/v1/tasks', { title: `Card ${i + 1}: ${prose(i, 60).split('\n')[1].slice(0, 50)}`, description: prose(i, 1800), project: PROJECTS[i % 4], labels: i % 3 ? ['bug'] : ['feature', 'polish'] })
    numbers.push(r.body.number)
    for (let c = 0; c < 3; c++) await api('POST', `/v1/tasks/${r.body.number}/comments`, { text: prose(i * 10 + c, 400) })
    if (cols[i] !== 'todo') await inv('tasks:update', r.body.number, { column: cols[i] }).catch(() => api('PATCH', `/v1/tasks/${r.body.number}`, { column: cols[i] }))
  }
  check(`seeded ${numbers.length} cards`, numbers.length === cols.length)
  // Handovers and notes.
  for (let i = 0; i < 6; i++) await api('POST', '/v1/shared/handovers', { title: `Handover ${i}`, content: prose(100 + i, 3500), project: PROJECTS[i % 4] })
  for (let i = 0; i < 8; i++) await api('PUT', `/v1/shared/file?path=${encodeURIComponent(`notes/note-${i}.md`)}`, { content: prose(200 + i, 2500) })

  // The Assistant: its own token, for its tools.
  const home = (await inv('workspace:refresh')).assistant.path
  await inv('session:start', home, { agentId: 'assistant' })
  await until(async () => (await live(home, 'assistant'))?.status === 'ready', HUNG_MS)
  const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)

  /**
   * The coder's own Agent API token, as its latest launch was given it (the fake CLI logs its launches, each with its
   * agent's name: other agents of alpha start later, HI-1933).
   */
  const coderOwnToken = () => fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).reverse().find((l) => l.token && l.env.CW_AGENT === coder.name && l.cwd.toLowerCase() === alpha.toLowerCase())?.token
  /**
   * One Combwork tool call through cw-mcp.js: the text the agent gets (role 'assistant+settings': with Change settings on;
   * 'own': with the coder's own token, as the agent calls it, where the caller matters: its own lane starts nobody, HI-1933).
   */
  const tool = (name, args, role = 'agent') => {
    const extra = { CW_DEV_CONSOLE: '1', ...(role.startsWith('assistant') ? { CW_ROLE: 'assistant', CW_ASSISTANT_CONTROL: 'projects', CW_ASSISTANT_SETTINGS: role === 'assistant+settings' ? '1' : '0', CW_JOURNAL: '1', CW_API_TOKEN_FILE: asTokenFile, CW_API_TOKEN: '', CW_PROJECT: '' } : role === 'own' ? { CW_API_TOKEN_FILE: lib.tokenFile(coderOwnToken()), CW_PROJECT: 'alpha', CW_AGENT_ID: coder.id } : { CW_API_TOKEN_FILE: path.join(userData, 'agent-api.json'), CW_PROJECT: 'alpha', CW_AGENT_ID: coder.id }) }
    const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
      env: lib.childEnv({ CW_API_URL: API, CW_WORKSPACE: ws, ...extra }),
      timeout: 60000
    }).toString()
    const r = JSON.parse(out.split('\n')[0]).result
    return { text: r.content[0].text, isError: !!r.isError }
  }
  /**
   * The tools a role is offered, as the CLI lists them ('assistant+settings': with Change settings on, every one of its own);
   * `side`, a project agent's side of the workflow (HI-2664: CW_SIDE, builder, reviewer or both); `hidden`, the tools its
   * project's workflow left out of its launch (HI-2694: CW_WORKFLOW_HIDDEN, comma-separated).
   */
  const toolList = (role = 'agent', side = undefined, hidden = undefined) => {
    const extra = { CW_DEV_CONSOLE: '1', ...(side ? { CW_SIDE: side } : {}), ...(hidden ? { CW_WORKFLOW_HIDDEN: hidden } : {}), ...(role.startsWith('assistant') ? { CW_ROLE: 'assistant', CW_ASSISTANT_CONTROL: 'projects', CW_ASSISTANT_SETTINGS: role === 'assistant+settings' ? '1' : '0', CW_JOURNAL: role === 'assistant-nojournal' ? '0' : '1', CW_API_TOKEN_FILE: asTokenFile, CW_API_TOKEN: '', CW_PROJECT: '' } : { CW_API_TOKEN_FILE: path.join(userData, 'agent-api.json'), CW_PROJECT: 'alpha', CW_AGENT_ID: coder.id }) }
    const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n',
      env: lib.childEnv({ CW_API_URL: API, CW_WORKSPACE: ws, ...extra }),
      timeout: 60000
    }).toString()
    return JSON.parse(out.split('\n')[0]).result.tools
  }
  /** A tool's description as the agent (or the Assistant) is given it. */
  const toolDescription = (name, role = 'agent') => toolList(role).find((t) => t.name === name)?.description ?? ''
  // The tools' descriptions stay short (HI-2012): every description and parameter description, at any depth of its
  // schema, and each role's total, within toolLimits.cjs. The Assistant is measured with Change settings on (all its own);
  // cw_console (offered only with the developer console on, as here) is checked but left out of the totals.
  {
    const limits = require('./toolLimits.cjs')
    const paramTexts = (schema) => {
      const found = []
      const walk = (o, at) => {
        if (!o || typeof o !== 'object') return
        if (typeof o.description === 'string') found.push([at, o.description])
        // A parameter named description (cw_create_task's) is walked; only the text itself isn't.
        for (const [k, v] of Object.entries(o)) if (typeof v === 'object') walk(v, `${at}.${k}`)
      }
      walk(schema?.properties, 'properties')
      return found
    }
    for (const [role, list] of [['agent', 'agent'], ['assistant', 'assistant+settings']]) {
      const over = []
      let total = 0
      const tools = toolList(list)
      // The whole list as the CLI gets it, in bytes (HI-2553), cw_console left out as in the totals below.
      const listBytes = Buffer.byteLength(JSON.stringify(tools.filter((t) => t.name !== 'cw_console')), 'utf8')
      console.log(`tool list (${role}): ${listBytes} bytes`)
      check(`tool list (${role}): ${listBytes} bytes, within ${limits.listBytes[role]} (raise it only on purpose: toolLimits.cjs)`, listBytes <= limits.listBytes[role])
      for (const t of tools) {
        const ex = limits.exceptions[t.name] ?? {}
        const descMax = ex.description ?? limits.description
        const paramMax = ex.parameter ?? limits.parameter
        const counted = t.name !== 'cw_console'
        if (counted) total += t.description.length
        if (t.description.length > descMax) over.push(`${t.name} ${t.description.length}/${descMax}`)
        for (const [at, d] of paramTexts(t.inputSchema)) {
          if (counted) total += d.length
          if (d.length > paramMax) over.push(`${t.name} ${at} ${d.length}/${paramMax}`)
        }
      }
      console.log(`tool descriptions (${role}): ${total} characters`)
      check(`tool descriptions (${role}): each within ${limits.description}, each parameter's within ${limits.parameter}`, over.length === 0, over.join('; '))
      check(`tool descriptions (${role}): ${total} characters in all, within ${limits.total[role]}`, total <= limits.total[role])
    }
  }
  // HI-2664: a builder is offered no reviewer's moves and a reviewer no builder's, both sides everything; the Assistant none
  // of a worker's (it keeps cw_ask_user, its own cw_release_slot, and moves a card with cw_update_task).
  {
    const names = (list) => list.map((t) => t.name)
    const all = names(toolList('agent'))
    const builder = names(toolList('agent', 'builder'))
    const reviewer = names(toolList('agent', 'reviewer'))
    check('tools by side: a builder is offered no reviewer moves, and keeps its own', !builder.some((n) => ['cw_start_review', 'cw_verdict', 'cw_request_builder', 'cw_focused_skip'].includes(n)) && builder.includes('cw_submit') && builder.includes('cw_loop_step'), builder.join(' '))
    check('…a reviewer no builder moves, and keeps its own', !reviewer.some((n) => ['cw_start_card', 'cw_submit', 'cw_put_back', 'cw_merge_slot', 'cw_report_merge'].includes(n)) && reviewer.includes('cw_verdict') && reviewer.includes('cw_lane') && reviewer.includes('cw_loop_step'), reviewer.join(' '))
    check('…both sides, and no side given, everything an agent has', names(toolList('agent', 'both')).length === all.length && all.includes('cw_verdict') && all.includes('cw_submit'))
    // HI-2694: the tools a project's workflow makes unusable are left out too (Solo: no review, Committed is done), and
    // only those; each side's list measured with and without them.
    const SOLO = 'cw_focused_skip,cw_report_merge,cw_start_review,cw_verdict'
    for (const side of ['both', 'builder', 'reviewer']) {
      const full = toolList('agent', side).filter((t) => t.name !== 'cw_console')
      const solo = toolList('agent', side, SOLO).filter((t) => t.name !== 'cw_console')
      console.log(`tool list (${side}, Solo): ${solo.length} tools, ${Buffer.byteLength(JSON.stringify(solo), 'utf8')} bytes (with every workflow tool: ${full.length}, ${Buffer.byteLength(JSON.stringify(full), 'utf8')})`)
      check(`tools by workflow (${side}): Solo leaves out exactly its four, where the side has them`, names(full).filter((n) => !names(solo).includes(n)).join(',') === names(full).filter((n) => SOLO.split(',').includes(n)).join(','), names(solo).join(' '))
    }
    const assistantNames = names(toolList('assistant+settings'))
    check("the Assistant: none of a worker's tools; cw_ask_user, cw_release_slot and cw_update_task kept", !assistantNames.some((n) => ['cw_submit', 'cw_verdict', 'cw_start_review', 'cw_loop_step', 'cw_put_back', 'cw_request_builder', 'cw_declare_paths', 'cw_focused_skip', 'cw_report_merge', 'cw_cannot_within_rules'].includes(n)) && ['cw_ask_user', 'cw_release_slot', 'cw_update_task'].every((n) => assistantNames.includes(n)), assistantNames.join(' '))
  }
  const sizes = {}
  const texts = {}
  // The checkout's path (in the fake CLI's path the settings list) counts as this token, so a reply measures the same
  // from any checkout or review copy, however long its path (#1586).
  const CHECKOUT = '<checkout>'
  const sized = (text) => text.replaceAll(lib.ROOT, CHECKOUT)
  /** Records a reply's size (the checkout's path as `CHECKOUT`); with `max`, checks it worked and stays within it. Returns the reply as it is. */
  const measure = (label, r, max) => {
    const text = typeof r === 'string' ? r : r.text
    const size = sized(text).length
    sizes[label] = size
    texts[label] = text
    console.log(`${String(size).padStart(8)}  ${label}${r.isError ? `  (error: ${text.slice(0, 120)})` : ''}`)
    if (max !== undefined) check(`${label}: at most ${max.toLocaleString('en')} characters`, !r.isError && size <= max, `${size}: ${text.slice(0, 200)}`)
    return text
  }
  const todo = numbers.slice(0, 50)
  const target = numbers[3]
  // Each card's name as replies give it (HI-1661: its key alone); its cards are in several projects, so read from the board.
  const keyOf = new Map((await inv('tasks:list')).map((c) => [c.number, c.key || `#${c.number}`]))
  const K = (n) => keyOf.get(n) ?? `#${n}`

  console.log('\n--- Combwork tools (as an agent)')
  const projects = measure('cw_list_projects', tool('cw_list_projects', {}), 1000)
  check('projects: a line each, with their agents and their roles in the workflow (#1430)', /^alpha \(on, \w+\): Coder \[claude-code, either\] idle; Tester \[claude-code, either\] stopped$/m.test(projects), projects)
  // About 3,030 characters: each Claude Code agent's connection fields (HI-1771), there for everyone since HI-1774.
  // Each agent row names its connection (HI-2108: every agent has one, its id and name).
  measure('cw_project_status', tool('cw_project_status', {}), 3300)
  const usage = measure('cw_session_usage', tool('cw_session_usage', {}), 1500)
  check('usage leaves out its days unless asked', !usage.includes('"days"') && tool('cw_session_usage', { days: true }).text.includes('"days"'))
  const notes = measure('cw_list_shared_notes', tool('cw_list_shared_notes', {}), 1500)
  check('notes: one path a line', /^notes\/note-1\.md \(\d{4}-\d\d-\d\d\)$/m.test(notes), notes)
  const note = measure('cw_read_shared_note', tool('cw_read_shared_note', { path: 'notes/note-1.md' }))
  check('a note reads as its text, with its revision', /^notes\/note-1\.md \(revision [0-9a-f]{12}\)\n\n## Why\n/.test(note), note.slice(0, 80))
  // Documents by section (#817): a long plan (~70k characters: 8 parts of 5 sections), as a shared note and a project file.
  const longDoc = `# Long plan\n\n${Array.from({ length: 8 }, (_, p) => `## Part ${p + 1}\n\n${Array.from({ length: 5 }, (__, s) => `### Section ${p + 1}.${s + 1}\n\n${prose(600 + p * 5 + s, 1700).replaceAll('## ', '')}\n`).join('\n')}`).join('\n')}`
  await api('PUT', `/v1/shared/file?path=${encodeURIComponent('plans/long.md')}`, { content: longDoc })
  fs.mkdirSync(path.join(alpha, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(alpha, 'docs', 'LONG.md'), longDoc)
  const outlined = measure('cw_doc_outline', tool('cw_doc_outline', { path: 'shared:plans/long.md' }), 3000)
  check('an outline: a line per heading with its slug and size', outlined.includes('\n    ### Section 3.2 [section-32] 1.') && outlined.length < longDoc.length / 20, outlined.slice(0, 300))
  measure('cw_doc_outline (project file, depth 2)', tool('cw_doc_outline', { path: 'docs/LONG.md', depth: 2 }), 800)
  const sectionRead = measure('cw_read_section', tool('cw_read_section', { path: 'docs/LONG.md', heading: 'section-32' }), 2200)
  check('a section: its own text only', sectionRead.startsWith('docs/LONG.md#section-32 (') && !sectionRead.includes('### Section 3.3'), sectionRead.slice(0, 200))
  const partial = measure('cw_read_section (long: its subsections)', tool('cw_read_section', { path: 'shared:plans/long.md', heading: 'Long plan' }), 1500)
  check('a section over 30,000 characters: its outline instead', partial.includes('## Part 8 [part-8]') && partial.endsWith('or this whole section with full=true.'), partial.slice(0, 300))
  const unknown = tool('cw_read_section', { path: 'docs/LONG.md', heading: 'part nine' })
  measure('cw_read_section (unknown)', unknown)
  check('an unknown section: an error naming the closest, short', unknown.isError && unknown.text.includes('Closest: ') && unknown.text.length <= 400, unknown.text)
  check('writing a note confirms it', /^Wrote notes\/new\.md \([\d,]+ characters, revision [0-9a-f]{12}\)\.$/.test(measure('cw_write_shared_note', tool('cw_write_shared_note', { path: 'notes/new.md', content: prose(300, 2500) }), 200)), texts.cw_write_shared_note)
  const written = texts.cw_write_shared_note.match(/revision ([0-9a-f]{12})/)?.[1]
  measure('cw_write_shared_note (append)', tool('cw_write_shared_note', { path: 'notes/new.md', content: prose(301, 500), append: true }), 200)
  // A rewrite naming the revision before that append is refused, with the current one.
  const stale = tool('cw_write_shared_note', { path: 'notes/new.md', content: 'lost?', expectedRevision: written })
  measure('cw_write_shared_note (conflict)', stale)
  check('a stale revision is refused with the current one, in a few lines', stale.isError && /expectedRevision [0-9a-f]{12}/.test(stale.text) && stale.text.length <= 300, stale.text)
  // A revision given but empty or not a string is refused, never taken as "unguarded" (only leaving it out is).
  const noteNow = async () => (await api('GET', '/v1/shared/file?path=notes%2Fnew.md')).body
  const noteBefore = await noteNow()
  const bad = []
  for (const v of ['', false, 0, null]) {
    const r = tool('cw_write_shared_note', { path: 'notes/new.md', content: 'unguarded?', expectedRevision: v })
    if (!r.isError || !/expectedRevision must be/.test(r.text)) bad.push(`tool ${JSON.stringify(v)}: ${r.text}`)
  }
  for (const v of ['', null, 7]) {
    const r = await api('PUT', '/v1/shared/file?path=notes%2Fnew.md', { content: 'unguarded?', expectedRevision: v })
    if (r.status !== 400) bad.push(`API ${JSON.stringify(v)}: ${r.status} ${r.text}`)
  }
  const noteAfter = await noteNow()
  check('an empty or invalid revision is refused and changes nothing (tool and API)', !bad.length && noteAfter.content === noteBefore.content && noteAfter.revision === noteBefore.revision, bad.join('; ') || 'the note changed')
  const fresh = await api('PUT', '/v1/shared/file?path=notes%2Fnew.md', { content: `${noteBefore.content}\nmore`, expectedRevision: noteBefore.revision })
  check('the current revision writes, and the API gives the new one', fresh.status === 200 && fresh.body.revision !== noteBefore.revision && (await noteNow()).revision === fresh.body.revision, fresh.text)
  measure('cw_read_latest_handover', tool('cw_read_latest_handover', {}))
  check('a handover is saved and named', /^Handover saved as handovers\/.+\.md\.$/.test(measure('cw_create_handover', tool('cw_create_handover', { title: 'Measured', content: prose(400, 3500) }), 300)), texts.cw_create_handover)
  measure('cw_notify', tool('cw_notify', { title: 'Hello', message: 'Measuring' }), 100)
  // With a target (HI-1961): the reply says what a click opens, the agent as the project names it.
  check('a notice with a target says what a click opens', measure('cw_notify (target)', tool('cw_notify', { title: 'Tester waits', target: { agent: 'tester' } }), 100) === 'Notification shown; a click opens Tester.', texts['cw_notify (target)'])
  // The Assistant's inbox (#647; these calls use the workspace token, not an agent's): nothing new; an ack of an id that isn't its own says so, and nothing about it.
  check('the inbox with nothing new says so', measure('cw_inbox', tool('cw_inbox', {}, 'assistant'), 200) === 'Nothing new.', texts.cw_inbox)
  check("an ack of an id that isn't its own", measure('cw_inbox (ack)', tool('cw_inbox', { ack: ['m99'] }, 'assistant'), 100) === 'Nothing acked. Not in your inbox: m99.', texts['cw_inbox (ack)'])
  // A card's line: its key alone (#1219, HI-1661: "AL-12 …"), or its number for a card with no key.
  const CARD = '([A-Z]{2,4}-\\d+|#\\d+)'
  const isCardLine = (l) => new RegExp(`^${CARD} `).test(l)
  const all = measure('cw_list_tasks (all)', tool('cw_list_tasks', {}), 76 * 200)
  check('the board: a line a card, no descriptions', all.split('\n').filter(isCardLine).length === 76 && !all.includes('## Why'), all.slice(0, 300))
  const todoList = measure('cw_list_tasks (todo)', tool('cw_list_tasks', { column: 'todo' }), 50 * 200)
  check('Todo is listed top first', todoList.startsWith('Todo (50, top first):\n') && isCardLine(todoList.split('\n')[1]), todoList.slice(0, 80))
  measure('cw_list_tasks (alpha)', tool('cw_list_tasks', { project: 'alpha' }), 25 * 200)
  // HI-2568: the full listing leaves every card's history out (historyEntries counts it), so it doesn't grow with the
  // board's changes. The Review cards get 30 history entries each first, so a listing that gave them back would show.
  const reviewCards = numbers.slice(56, 66)
  for (let i = 0; i < 15; i++) {
    await api('POST', '/v1/tasks/batch', { numbers: reviewCards, addLabels: ['churn'] })
    await api('POST', '/v1/tasks/batch', { numbers: reviewCards, removeLabels: ['churn'] })
  }
  const oneByOne = new Map()
  for (const n of reviewCards) oneByOne.set(n, (await api('GET', `/v1/tasks/${n}`)).body)
  check('each Review card has a long history now', [...oneByOne.values()].every((c) => c.history.length >= 31), JSON.stringify([...oneByOne.values()].map((c) => c.history.length)))
  const full = measure('cw_list_tasks (details, review)', tool('cw_list_tasks', { column: 'review', details: true }), 10 * 5000)
  const fullCards = JSON.parse(full)
  const sameAsRead = (c) => {
    const one = oneByOne.get(c.number)
    return one && c.historyEntries === one.history.length && c.description === one.description && JSON.stringify(c.comments) === JSON.stringify(one.comments) && JSON.stringify(c.decisions) === JSON.stringify(one.decisions) && JSON.stringify(c.forYou) === JSON.stringify(one.forYou)
  }
  check('details=true lists cards in full, without their history', fullCards.length === 10 && fullCards.every((c) => !('history' in c) && c.description.length > 1000 && c.comments.length === 3 && sameAsRead(c)), JSON.stringify(fullCards.map((c) => [c.number, Object.keys(c).includes('history'), c.historyEntries])))
  const apiLean = await api('GET', '/v1/tasks?column=review')
  const apiWhole = await api('GET', '/v1/tasks?column=review&history=true')
  check('API: GET /v1/tasks gives whole cards without history, historyEntries counting it', apiLean.body.length === 10 && apiLean.body.every((c) => !('history' in c) && sameAsRead(c)), JSON.stringify(apiLean.body.map((c) => c.historyEntries)))
  check('API: ?history=true gives every history back', apiWhole.body.length === 10 && apiWhole.body.every((c) => JSON.stringify(c.history) === JSON.stringify(oneByOne.get(c.number)?.history) && !('historyEntries' in c)), JSON.stringify(apiWhole.body.map((c) => c.history?.length)))
  sizes['GET /v1/tasks?column=review'] = apiLean.text.length
  sizes['GET /v1/tasks?column=review&history=true'] = apiWhole.text.length
  console.log(`${String(apiLean.text.length).padStart(8)}  GET /v1/tasks?column=review\n${String(apiWhole.text.length).padStart(8)}  GET /v1/tasks?column=review&history=true`)
  check('…and the lean listing is smaller by at least its histories (10 cards × 30 entries)', apiLean.text.length + 10 * 30 * 40 <= apiWhole.text.length, `${apiLean.text.length} vs ${apiWhole.text.length}`)
  const read = JSON.parse(measure('cw_read_task', tool('cw_read_task', { number: target })))
  check('a read has the description and comments, not the history', read.description.length > 1000 && read.comments.length === 3 && !('history' in read) && read.historyEntries >= 1, Object.keys(read).join(','))
  check('history=true adds it', JSON.parse(tool('cw_read_task', { number: target, history: true }).text).history.length >= 1)
  // HI-2276: a code card whose rules name checks before review lists them (data) and a fixed hint to run one; none without.
  check('no checks where the rules name none', !('checks' in read) && !('checksHint' in read), read.checks)
  {
    const rules = await inv('workflow:form', alpha)
    await inv('workflow:setOptions', alpha, { preset: rules.preset, options: { ...rules.own, preChecks: ['quick'], commands: { ...rules.own.commands, quick: 'node check.js' } } })
    await toolsSettled()
    try {
      const checked = JSON.parse(tool('cw_read_task', { number: todo[0] }).text)
      measure('cw_read_task (checks fields)', JSON.stringify({ checks: checked.checks, checksHint: checked.checksHint }), 200)
      check('…and its checks where they name one: the names as data, a hint with <name>', JSON.stringify(checked.checks) === '["quick"]' && /^before review: cw-progress --check <name> --card "[A-Z]+-\d+".*Budget, other checks: project notes; work-on-card$/.test(checked.checksHint ?? ''), JSON.stringify([checked.checks, checked.checksHint]))
    } finally {
      await inv('workflow:setOptions', alpha, { preset: rules.preset, options: rules.own })
      await toolsSettled()
    }
  }
  const latest = JSON.parse(measure('cw_read_task (latestComment)', tool('cw_read_task', { number: target, latestComment: true }), 1500))
  check('latestComment=true: the newest comment only', latest.number === target && latest.comment?.text === read.comments.at(-1).text && JSON.stringify(Object.keys(latest)) === '["number","comment"]', JSON.stringify(latest).slice(0, 200))
  // Summaries (#532): each comment as its first line, with the whole comment's length when there is more.
  const summary = JSON.parse(measure('cw_read_task (latestComment, summary)', tool('cw_read_task', { number: target, latestComment: true, summary: true }), 500))
  const fullLatest = read.comments.at(-1).text
  check('summary=true: the latest comment as its first line, with its whole length', summary.comment?.text === fullLatest.split('\n').map((l) => l.trim()).find(Boolean).slice(0, 300) && (summary.comment.text === fullLatest.trim() || summary.comment.length === fullLatest.length), JSON.stringify(summary).slice(0, 300))
  const allSummary = JSON.parse(tool('cw_read_task', { number: target, summary: true }).text)
  check('…and every comment of a card read with it', allSummary.comments.length === read.comments.length && allSummary.comments.every((x, i) => x.text.length <= 300 && read.comments[i].text.includes(x.text.replace(/…$/, '').slice(0, 20))), JSON.stringify(allSummary.comments).slice(0, 300))
  // A card's attachment read through Combwork (HI-1751): a page of its text (64 KB at most) with a short line before it, the
  // next page from the offset it names; an image by its path alone.
  const attachSrc = path.join(ws, 'alpha', 'attach-src')
  fs.mkdirSync(attachSrc, { recursive: true })
  const bigText = 'a measured line of results, ✓ and €\n'.repeat(3000)
  fs.writeFileSync(path.join(attachSrc, 'results.txt'), bigText)
  fs.writeFileSync(path.join(attachSrc, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  tool('cw_update_task', { number: target, attachments: [path.join(attachSrc, 'results.txt'), path.join(attachSrc, 'shot.png')] })
  const firstPage = measure('cw_read_attachment (a page of text)', tool('cw_read_attachment', { card: target, name: 'results.txt' }), 64 * 1024 + 200)
  const nextAt = Number(/more from offset (\d+)/.exec(firstPage)?.[1])
  check('…a line saying which bytes, then the text; the next page from the offset it names', /^results\.txt \(bytes 0–\d[\d,]* of [\d,]+ bytes; more from offset \d+\)\n\n/.test(firstPage) && nextAt > 0, firstPage.slice(0, 200))
  const rest = measure('cw_read_attachment (its last page)', tool('cw_read_attachment', { card: target, name: 'results.txt', offset: nextAt }), 64 * 1024 + 200)
  check('…the pages joined are the file', firstPage.slice(firstPage.indexOf('\n\n') + 2) + rest.slice(rest.indexOf('\n\n') + 2) === bigText && !/more from offset/.test(rest), rest.slice(0, 200))
  const image = measure('cw_read_attachment (an image)', tool('cw_read_attachment', { card: target, name: 'shot.png' }), 400)
  check('…an image: its path, to open with the CLI', /^shot\.png: an image \(8 bytes\)\. Open it with your own file reading: .*shot\.png$/.test(image), image)
  // A card with many attachments (HI-2402, as CL-8's 30): a narrowed read keeps only those of the comments it returns in
  // full, counting the rest; a full read and attachments=true keep them all.
  {
    const many = todo[25]
    const evidence = path.join(attachSrc, 'many')
    fs.mkdirSync(evidence, { recursive: true })
    const file = (name) => {
      fs.writeFileSync(path.join(evidence, name), `evidence ${name}\n`)
      return path.join(evidence, name)
    }
    for (let round = 0; round < 3; round++) tool('cw_update_task', { number: many, comment: `Round ${round + 1}: evidence.`, attachments: Array.from({ length: 10 }, (_x, i) => file(`run-${round}-${i}.log`)) })
    tool('cw_update_task', { number: many, comment: 'Round 4: the last run.', attachments: [file('last-run.log')] })
    const whole = JSON.parse(measure('cw_read_task (31 attachments)', tool('cw_read_task', { number: many })))
    check('…a full read: every attachment, none counted out', whole.attachments?.length === 31 && !('attachmentsOmitted' in whole), JSON.stringify({ n: whole.attachments?.length, omitted: whole.attachmentsOmitted }))
    const last = JSON.parse(measure('cw_read_task (latestComment, 31 attachments)', tool('cw_read_task', { number: many, latestComment: true }), 900))
    check("…latestComment: only its own comment's attachment, its link as the path, the other 30 counted", last.attachments?.length === 1 && last.attachments[0].name === 'last-run.log' && last.attachments[0].from.startsWith('comment by ') && last.attachmentsOmitted === 30 && last.comment.text.includes(last.attachments[0].path) && !last.comment.text.includes('attachment:'), JSON.stringify(last).slice(0, 400))
    const lastAll = JSON.parse(tool('cw_read_task', { number: many, latestComment: true, attachments: true }).text)
    check('…with attachments: true, all 31, each from its comment', lastAll.attachments?.length === 31 && !('attachmentsOmitted' in lastAll) && lastAll.attachments.every((a) => a.from.startsWith('comment by ')), JSON.stringify({ n: lastAll.attachments?.length, from: lastAll.attachments?.map((a) => a.from).filter((f) => !f.startsWith('comment by ')) }))
    const two = JSON.parse(measure('cw_read_task (comments: 2, 31 attachments)', tool('cw_read_task', { number: many, comments: 2 })))
    check("…comments: 2: the two comments' 11, the other 20 counted", two.attachments?.length === 11 && two.attachmentsOmitted === 20 && two.attachments.every((a) => /^(last-run|run-2-\d)\.log$/.test(a.name)), JSON.stringify({ n: two.attachments?.length, omitted: two.attachmentsOmitted }))
    // HI-2412: comments: 0 is none of them, every one counted, not a full read.
    const none = JSON.parse(tool('cw_read_task', { number: many, comments: 0 }).text)
    check('…comments: 0: no comments and none of their attachments, all counted', none.comments?.length === 0 && none.commentsOmitted === whole.comments.length && !('attachments' in none) && none.attachmentsOmitted === 31, JSON.stringify({ n: none.comments?.length, omitted: none.commentsOmitted, attachments: none.attachments?.length, attachmentsOmitted: none.attachmentsOmitted }))
    const gist = JSON.parse(measure('cw_read_task (summary, 31 attachments)', tool('cw_read_task', { number: many, summary: true })))
    check('…summary: none (its comments are their first lines), all 31 counted', !('attachments' in gist) && gist.attachmentsOmitted === 31, JSON.stringify({ n: gist.attachments?.length, omitted: gist.attachmentsOmitted }))
    check('…and the narrowed read is the smaller by far', sizes['cw_read_task (latestComment, 31 attachments)'] * 4 < sizes['cw_read_task (31 attachments)'], JSON.stringify(sizes))
  }
  const created = measure('cw_create_task', tool('cw_create_task', { title: 'Measured card', description: prose(500, 1800), labels: ['bug'] }), 400)
  check('a new card: its key, number and place', new RegExp(`^${CARD} created in Todo \\(51st of 51\\) for alpha: Measured card$`).test(created) && /^[A-Z]{2,4}-\d+ /.test(created), created)
  const commented = measure('cw_update_task (comment)', tool('cw_update_task', { number: target, comment: 'Looked at it.' }), 400)
  check('a comment is confirmed with where the card is', new RegExp(`^(${lib.KEYED.source}|#${target}) .+: Commented\\. Now in Todo \\(\\d+\\w\\w of 51\\), \\w+\\.$`).test(commented), commented)
  const top = measure('cw_update_task (to top)', tool('cw_update_task', { number: target, position: 'top' }), 400)
  check('a move says where to', /: Moved to the top of Todo\. Now in Todo \(1st of 51\), \w+\.$/.test(top), top)
  const review = measure('cw_update_task (to review)', tool('cw_update_task', { number: target, column: 'review', comment: 'Done: see the branch.' }), 400)
  check('a move to Review and a comment, both said', /: Moved to Review; Commented\. Now in Review \(11th of 11\)/.test(review), review)
  const reordered = measure('cw_reorder_tasks (3 cards)', tool('cw_reorder_tasks', { column: 'todo', cards: [todo[10], todo[5], todo[7]] }), 300)
  check('a reorder confirms the new top, its cards by key (#1219)', reordered === `Todo now starts ${K(todo[10])}, ${K(todo[5])}, ${K(todo[7])}; its other 47 cards keep their order below.` && lib.KEYED.test(reordered), reordered)
  const batched = measure('cw_update_tasks (3 cards)', tool('cw_update_tasks', { numbers: [todo[20], todo[21], todo[22]], labels: ['perf'] }), 400)
  const batchLines = batched.split('\n')
  check('a batch confirms each card and its change', batchLines[0] === '3 cards changed:' && batchLines.length === 4 && batchLines.slice(1).every((l) => /^([A-Z]{2,4}-\d+|#\d+) .+: Labels: perf\. Now in Todo \(\d+\w+ of \d+\)(, [^,]+)?\.$/.test(l)), batched)
  // #1131: tagging says only the label added, not each card's labels.
  const tagged = measure('cw_update_tasks (3 cards, addLabels)', tool('cw_update_tasks', { numbers: [todo[20], todo[21], todo[22]], addLabels: ['0.9.4'] }), 400)
  const tagLines = tagged.split('\n')
  check('tagging says only the label added', tagLines[0] === '3 cards changed:' && tagLines.length === 4 && tagLines.slice(1).every((l) => /^([A-Z]{2,4}-\d+|#\d+) .+: Labels: added 0\.9\.4\. Now in Todo \(\d+\w+ of \d+\)(, [^,]+)?\.$/.test(l)), tagged)
  // Lanes (#483): a start, a join (a lane made for a builder that hasn't registered yet), the listing and an end. The
  // start, join and listing with the coder's own token, as a card loop calls them (HI-1933: with the workspace's, the
  // start is a script's, which since HI-1900 starts the lane's stopped agents and says so); the end (an abandon, the
  // user's or the Assistant's) with the workspace's. Coder waits on another card while the lane runs (HI-2082): Combwork
  // starts a lane's first card on its builder once it next looks at the board (HI-2029), and a look the moves above set
  // off could land before the end and give Coder a turn of its own; a builder waiting on other work is never given one.
  // Alpha's last card in Todo, which nothing here changes (a change would wake it).
  const untouched = todo.findLast((n, i) => i > 41 && K(n).startsWith('AL-'))
  const otherWork = tool('cw_wait_for_tasks', { cards: [`#${untouched}`], wake: true }, 'own').text
  check('Coder waits on another card while the lane runs', !!(await until(async () => (await live(alpha, coder.id))?.status === 'watching', HUNG_MS)), `${(await live(alpha, coder.id))?.status}: ${otherWork}`)
  const laneStarted = measure('cw_lane (start)', tool('cw_lane', { action: 'start', cards: [todo[0], todo[1], todo[2]], reviewer: 'Tester', rounds: 10, waitMinutes: 360, name: 'measured lane' }, 'own'), 400)
  check('a lane start: its pair, state, cards (by key, #1219) and id', /^Lane started: Coder \/ Tester \(alpha\) measured lane: active, on [A-Z]{2,4}-\d+; .+; rounds 10, wait 6 h\. lane-[0-9a-f]+$/.test(laneStarted), laneStarted)
  const laneId = laneStarted.match(/lane-[0-9a-f]+$/)?.[0]
  measure('cw_lane (join)', tool('cw_lane', { action: 'join', builder: 'Tester', cards: [todo[3]] }, 'own'), 400)
  const laneList = measure('cw_lane (list)', tool('cw_lane', { action: 'list' }, 'own'), 600)
  check('lanes listed a line each', laneList.split('\n').length === 2 && laneList.includes(laneId), laneList)
  // HI-2167: a new card placed on the builder's own lane as it is made: the card, then the lane's change, by key; another
  // builder's lane is refused before any card is made.
  const placed = measure('cw_create_task (on a lane)', tool('cw_create_task', { title: 'Placed card', description: prose(702, 300), lane: 'Coder' }, 'own'), 700)
  const placedKey = /^([A-Z]{2,4}-\d+) created in Todo/.exec(placed)?.[1]
  check('a card made on a lane: its key, then the lane updated with it', !!placedKey && placed.split('\n').length === 2 && placed.split('\n')[1].startsWith('Lane updated: Coder / Tester (alpha) measured lane: ') && placed.split('\n')[1].includes(placedKey), placed)
  const elsewhere = tool('cw_create_task', { title: 'Not placed', lane: 'Tester' }, 'own')
  check("…another builder's lane: refused, no card made", elsewhere.isError && /its own lane only/.test(elsewhere.text) && !(await inv('tasks:list')).some((c) => c.title === 'Not placed'), elsewhere.text)
  // The placed card goes again, so the board's counts below stay.
  const placedCard = (await inv('tasks:list')).find((c) => c.title === 'Placed card')
  if (placedCard) await inv('tasks:delete', placedCard.number)
  check('a lane ended', measure('cw_lane (end)', tool('cw_lane', { action: 'end', lane: laneId, abandoned: true }), 400).startsWith('Lane abandoned: '), texts['cw_lane (end)'])
  tool('cw_wait_for_tasks', { cancel: true }, 'own')
  check('…and no longer waits once it has ended', !!(await until(async () => ['ready', 'finished'].includes((await live(alpha, coder.id))?.status), HUNG_MS)), (await live(alpha, coder.id))?.status)
  // The merge queue (#1353): alpha's workflow doesn't have Combwork merge, so it has none, said in a line.
  check('cw_queue (list): no queue, in a line', measure('cw_queue (list)', tool('cw_queue', { action: 'list' }), 200).startsWith('No merge queue in alpha: '), texts['cw_queue (list)'])
  const skillList = measure('cw_list_skills', tool('cw_list_skills', {}), 4000)
  check('skills: a line each, who they are for, no folders', /^work-on-card \(Combwork, for agents\): /m.test(skillList) && !skillList.includes(ws), skillList.slice(0, 300))
  // Who each listing is about: an agent's lists what its project's agents get (not the Assistant's skills); the
  // Assistant's lists them all with who gets each, and with a project what that project's agents get.
  for (const [name, audience] of [['for-assistant', 'assistant'], ['for-both', 'all'], ['for-default', null]]) {
    fs.mkdirSync(path.join(ws, '.combwork', 'skills', name), { recursive: true })
    fs.writeFileSync(path.join(ws, '.combwork', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill.\n${audience ? `metadata:\n  audience: ${audience}\n` : ''}---\n`)
  }
  const has = (list, re) => new RegExp(re, 'm').test(list)
  const agentSkills = tool('cw_list_skills', {}).text
  check("skills (agent): its project's agents' skills, without the Assistant's", has(agentSkills, '^for-default \\(Combwork, for agents\\)') && has(agentSkills, '^for-both \\(Combwork, for agents and the Assistant\\)') && !has(agentSkills, '^for-assistant ') && !has(agentSkills, '^coordinate-agents '), agentSkills.slice(0, 400))
  const allSkills = tool('cw_list_skills', {}, 'assistant').text
  check("skills (Assistant): every Combwork skill with who gets it", has(allSkills, '^for-assistant \\(Combwork, for the Assistant\\)') && has(allSkills, '^coordinate-agents \\(Combwork, for the Assistant\\)') && has(allSkills, '^for-both \\(Combwork, for agents and the Assistant\\)') && has(allSkills, '^for-default \\(Combwork, for agents\\)'), allSkills.slice(0, 400))
  const projectSkills = tool('cw_list_skills', { project: 'alpha' }, 'assistant').text
  check("skills (Assistant, a project): what that project's agents get", !has(projectSkills, '^for-assistant ') && has(projectSkills, '^for-both ') && has(projectSkills, '^for-default '), projectSkills.slice(0, 400))
  check('skills: the descriptions say a listing, not what a session loaded', /not of what a running session loaded/.test(toolDescription('cw_list_skills')) && /for agents \(not those for the Assistant alone\)/.test(toolDescription('cw_list_skills')) && /user and plugin skills/.test(toolDescription('cw_list_skills', 'assistant')))
  for (const name of ['for-assistant', 'for-both', 'for-default']) fs.rmSync(path.join(ws, '.combwork', 'skills', name), { recursive: true, force: true })
  // A long card's latest feedback without its whole thread; the board a page at a time.
  const newest = JSON.parse(measure('cw_read_task (comments: 2)', tool('cw_read_task', { number: target, comments: 2 })))
  check('comments=2: the description and the newest two, with a count of the rest', newest.description.length > 1000 && newest.comments.length === 2 && newest.commentsOmitted === read.comments.length + 2 - 2 && newest.comments.at(-1).text === 'Done: see the branch.', JSON.stringify({ n: newest.comments?.length, omitted: newest.commentsOmitted }))
  // A card past the 500 comments it keeps (HI-2641): its oldest archived, counted on its read, read a page at a time
  // through the route and cw_read_task's archived; past 100 comments a read suggests a split. Deleted after, so the
  // Todo counts below stay.
  {
    const long = (await api('POST', '/v1/tasks', { title: 'A long thread', project: 'alpha' })).body.number
    const say = async (from, to) => {
      for (let i = from; i < to; i++) await api('POST', `/v1/tasks/${long}/comments`, { text: `c${i}` })
    }
    const readIt = async (q = '') => (await api('GET', `/v1/tasks/${long}${q}`)).body
    await say(0, 100)
    const at100 = await readIt()
    check('100 comments: no split hint, nothing archived', !('hint' in at100) && !('commentsArchived' in at100) && !('commentsMayHaveBeenLost' in at100), JSON.stringify({ hint: at100.hint, archived: at100.commentsArchived }))
    await say(100, 101)
    const at101 = await readIt()
    check('101 comments: a line suggesting a split, naming how many', /^101 comments: .*splitting/.test(at101.hint ?? ''), String(at101.hint))
    // 620 in all: the card keeps 500, 120 archived.
    await say(101, 620)
    const at620 = await readIt()
    check('620 comments: the card keeps the newest 500, and counts the 120 archived', at620.comments.length === 500 && at620.comments[0].text === 'c120' && at620.commentsArchived === 120 && (at620.hint ?? '').startsWith('620 comments'), JSON.stringify({ n: at620.comments.length, first: at620.comments[0]?.text, archived: at620.commentsArchived, hint: at620.hint }))
    const narrowed = await readIt('?comments=2&history=false')
    check('…a narrowed read counts them too', narrowed.comments.length === 2 && narrowed.commentsOmitted === 498 && narrowed.commentsArchived === 120 && (narrowed.hint ?? '').startsWith('620 comments'), JSON.stringify({ n: narrowed.comments.length, omitted: narrowed.commentsOmitted, archived: narrowed.commentsArchived }))
    const archivePage = async (q) => api('GET', `/v1/tasks/${long}/comments/archived${q}`)
    const textsOf = (r) => r.body.comments.map((c) => c.text)
    const first = await archivePage('')
    check('the archive: 50 by default, oldest first, with the next offset', first.status === 200 && first.body.total === 120 && first.body.offset === 0 && first.body.comments.length === 50 && textsOf(first)[0] === 'c0' && textsOf(first)[49] === 'c49' && first.body.next === 50 && !('id' in first.body.comments[0]), JSON.stringify({ ...first.body, comments: textsOf(first).slice(0, 3) }))
    const capped = await archivePage('?offset=10&limit=500')
    check('…at most 100 a page', capped.body.comments.length === 100 && textsOf(capped)[0] === 'c10' && capped.body.next === 110, JSON.stringify({ n: capped.body.comments.length, next: capped.body.next }))
    const last = await archivePage('?offset=110')
    check('…the last page has no next', last.body.comments.length === 10 && textsOf(last)[9] === 'c119' && !('next' in last.body), JSON.stringify({ n: last.body.comments.length, next: last.body.next }))
    const badOffset = await archivePage('?offset=-1')
    const badLimit = await archivePage('?limit=0')
    check('…an offset below 0 or a limit below 1 is refused (400)', badOffset.status === 400 && /offset must be a whole number from 0/.test(badOffset.body?.error) && badLimit.status === 400 && /limit must be a whole number from 1/.test(badLimit.body?.error), JSON.stringify({ badOffset, badLimit }))
    // cw_read_task's archived: the archive's route, from its offset.
    const viaTool = JSON.parse(measure('cw_read_task (archived)', tool('cw_read_task', { number: long, archived: 0 }), 8000))
    check('cw_read_task archived: 0 reads the archive from its oldest', viaTool.total === 120 && viaTool.comments.length === 50 && viaTool.comments[0].text === 'c0' && viaTool.next === 50, JSON.stringify({ ...viaTool, comments: viaTool.comments?.slice(0, 2) }))
    const viaTool2 = JSON.parse(tool('cw_read_task', { number: long, archived: 115 }).text)
    check('…and from another offset', viaTool2.offset === 115 && viaTool2.comments.map((c) => c.text).join() === 'c115,c116,c117,c118,c119' && !('next' in viaTool2), JSON.stringify(viaTool2))
    // A card that held 500 before the archive existed (the board step's record, written as the step writes it): it says
    // older comments may have been dropped, and never how many.
    const { DatabaseSync } = require('node:sqlite')
    const meta = (sql, ...a) => {
      const db = new DatabaseSync(path.join(ws, '.combwork', 'combwork.db'), { timeout: 5000 })
      try {
        db.prepare(sql).run(...a)
      } finally {
        db.close()
      }
    }
    meta("INSERT INTO board_meta (key, value) VALUES ('commentsMayHaveBeenLost', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify([long]))
    const flagged = await readIt('?comments=1&history=false')
    const viaRead = JSON.parse(tool('cw_read_task', { number: long, comments: 1 }).text)
    check('a card that held the cap before the archive: may have lost older comments, said in words, none counted', flagged.commentsMayHaveBeenLost === true && /may have been dropped then, and can't be recovered/.test(flagged.commentsNote ?? '') && viaRead.commentsMayHaveBeenLost === true && flagged.commentsArchived === 120, JSON.stringify({ flag: flagged.commentsMayHaveBeenLost, note: flagged.commentsNote, tool: viaRead.commentsMayHaveBeenLost }))
    meta("DELETE FROM board_meta WHERE key = 'commentsMayHaveBeenLost'")
    check('…another card says nothing of it', !('commentsMayHaveBeenLost' in (await api('GET', `/v1/tasks/${target}?history=false`)).body))
    await inv('tasks:delete', long)
  }
  // A card with a question waiting for the user (HI-1992): it comes just after the decisions (here after the title), with
  // who asked and when, in the latest comment's form too; with summary, its words cut as a comment's.
  // One of alpha's cards in Doing (the Todo counts below stay), given to the coder.
  const asking = numbers[52]
  await inv('tasks:update', asking, { agent: coder.id })
  const question = `Which greeting: "Hi" or "Hello"?\n\n${prose(300, 1200)}`.trim()
  check('the coder asks the user on its card', !tool('cw_ask_user', { card: `#${asking}`, kind: 'decide', text: question }, 'own').isError)
  const asked = JSON.parse(measure('cw_read_task (an open question)', tool('cw_read_task', { number: asking })))
  const askedKeys = Object.keys(asked)
  check('…the read has it at the top: id, who asked, the question, when', askedKeys.indexOf('forYou') === askedKeys.indexOf('title') + 1 && asked.forYou?.length === 1 && /\/r\d+$/.test(asked.forYou[0].request) && asked.forYou[0].asker === 'Coder' && asked.forYou[0].text === question && !Number.isNaN(Date.parse(asked.forYou[0].since)), JSON.stringify(asked.forYou))
  const askedLatest = JSON.parse(measure('cw_read_task (latestComment, an open question)', tool('cw_read_task', { number: asking, latestComment: true, summary: true }), 1000))
  check('…the latest comment with summary: it first, cut to its first line', JSON.stringify(Object.keys(askedLatest)) === '["number","forYou","comment"]' && askedLatest.forYou[0].text === 'Which greeting: "Hi" or "Hello"?' && askedLatest.forYou[0].length === asked.forYou[0].text.length && askedLatest.forYou[0].asker === 'Coder',JSON.stringify(askedLatest).slice(0, 400))
  // Waiting on cards: lean replies (a bounded wait with nothing new; a column already reached; a watch begun and
  // cancelled, as the Assistant: a script has nobody to wake).
  const waited = measure('cw_wait_for_tasks (no change)', tool('cw_wait_for_tasks', { cards: [target], timeoutSeconds: 1 }), 300)
  check('a wait with no change: no change, with its since', /^No change\.\nsince: @[0-9a-z]+;/.test(waited), waited)
  const met = measure('cw_wait_for_tasks (already in the column)', tool('cw_wait_for_tasks', { cards: [target], column: 'review' }), 400)
  check('a column already reached answers at once, the card by key (#1219)', met.startsWith(`${K(target)} is in Review (column`) && lib.KEYED.test(met), met)
  const watchingNow = measure('cw_wait_for_tasks (wake)', tool('cw_wait_for_tasks', { cards: [todo[0]], wake: true }, 'assistant'), 300)
  check('a watch begun: what it waits for, and to end the turn', watchingNow.startsWith(`Waiting for ${K(todo[0])}. End your turn now`), watchingNow)
  check('cancel ends it', measure('cw_wait_for_tasks (cancel)', tool('cw_wait_for_tasks', { cancel: true }, 'assistant'), 100) === 'Cancelled your card watch.', texts['cw_wait_for_tasks (cancel)'])
  const page2 = measure('cw_list_tasks (offset 70)', tool('cw_list_tasks', { offset: 70 }), 10 * 200)
  check('offset carries on where a page stopped', /^Cards 71–\d+ of \d+\.$/m.test(page2) && page2.split('\n').filter(isCardLine).length === all.split('\n').filter(isCardLine).length + 1 - 70, page2.slice(0, 200))

  // The developer console (#636; offered while Settings → Agent API lets agents read it): with no console open a read
  // starts nothing and says so; with the window watching Coder, a turn reads as a line an event (its prompt hidden), one
  // event in full, the sources (a page at a time) and Combwork's events as the Assistant.
  const consoleClosed = measure('cw_console (no console open)', tool('cw_console', { agent: 'Coder' }), 300)
  check('with no console open a read says nothing is captured', consoleClosed.startsWith("alpha · Coder: not captured: the developer console isn't open on it"), consoleClosed)
  const coderSource = (await inv('console:sources')).find((s) => s.agentId === coder.id)
  await inv('console:subscribe', [coderSource.id])
  await lib.sendPrompt(inv, lib.ptyKey(alpha, coder.id), 'turn 5 console', { submitted: async () => String(await inv('pty:buffer', lib.ptyKey(alpha, coder.id))).includes('Done: turn 5 console') })
  const consoleTurn = await until(async () => {
    const t = tool('cw_console', { agent: 'Coder' }).text
    return /hook Stop → stop/.test(t) ? t : null
  }, HUNG_MS)
  measure('cw_console (a turn)', consoleTurn ?? '', 2500)
  check('a turn: a line an event, its prompt hidden', /^#\d+ \d\d:\d\d:\d\d hook UserPromptSubmit → prompt; working/m.test(consoleTurn ?? '') && !(consoleTurn ?? '').includes('turn 5 console'), consoleTurn)
  const promptSeq = Number(/^#(\d+) .*UserPromptSubmit/m.exec(consoleTurn ?? '')?.[1])
  const consoleOne = measure('cw_console (an event in full)', tool('cw_console', { agent: 'Coder', seq: [promptSeq] }), 3000)
  check('…one in full: the raw hook and what Combwork made of it, its prompt still hidden', consoleOne.includes('"raw"') && consoleOne.includes('"made"') && /"prompt":"<text: \d+ chars>"/.test(consoleOne), consoleOne)
  const consoleList = measure('cw_console (sources, as the Assistant)', tool('cw_console', { action: 'sources' }, 'assistant'), 1200)
  check('the sources: a line each, with how to name it', /^alpha · Coder \(claude-code\): captured, \d+ events \[agent="a-[\w-]+" project="alpha"\]$/m.test(consoleList) && /^Combwork: not captured \[source="combwork"\]$/m.test(consoleList), consoleList)
  // On a connection of its own (agent: false): after the slow tool calls above, fetch's kept-alive socket can be the one
  // Combwork's server is closing for idleness, which reset this request once under load.
  const sourcePage = await new Promise((resolve, reject) => {
    require('http')
      .get(`${API}/v1/console/sources?limit=2`, { agent: false, headers: { Authorization: `Bearer ${apiToken}` } }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (d) => (text += d))
        res.on('end', () => resolve({ status: res.statusCode, text, body: JSON.parse(text) }))
      })
      .on('error', reject)
  })
  check('sources come a page at a time, with the total', sourcePage.status === 200 && sourcePage.body.sources.length === 2 && sourcePage.body.total > 2 && sourcePage.body.offset === 0, sourcePage.text.slice(0, 300))
  measure("cw_console (Combwork's events, as the Assistant)", tool('cw_console', { source: 'combwork' }, 'assistant'), 300)
  await inv('console:subscribe', [])

  console.log('\n--- Combwork tools (as the Assistant)')
  // A line a provider (HI-2814: the JSON of all five was about 12,200 characters with OpenCode), one in full on request.
  const providerRows = measure('cw_list_providers', tool('cw_list_providers', {}, 'assistant'), 2500)
  check('the providers listed a line each, by id, and how to get one in full', ['claude-code', 'codex', 'copilot'].every((id) => providerRows.includes(`(${id}): `)) && !providerRows.includes('"models"') && /cw_list_providers with provider/.test(providerRows), providerRows)
  const oneProvider = measure('cw_list_providers (one provider)', tool('cw_list_providers', { provider: 'claude-code' }, 'assistant'), 5000)
  check('one provider in full: its models and its modes with what each does', (() => { try { const p = JSON.parse(oneProvider); return p.id === 'claude-code' && Array.isArray(p.models) && p.modes?.every((m) => m.description) } catch { return false } })(), oneProvider.slice(0, 300))
  const noProvider = tool('cw_list_providers', { provider: 'nope' }, 'assistant')
  check('an unknown provider is refused, naming the ids', noProvider.isError && /No provider nope: one of claude-code, /.test(noProvider.text), noProvider.text)
  // Combwork's settings (#186): a listing (all, narrowed, a project's), one in full, and a change with Change settings on.
  // A line a setting (about 85 characters with its title): 6,200 since #418 added Tell the Assistant when I reply to an agent;
  // 7,000 since #450 added GitHub Copilot, a third provider with its own settings (about 730 characters); 7,200 since #412
  // added the workspace's Card loop rounds and wait (about 100 characters); 7,400 since #636 added Let agents read the
  // developer console (about 70 characters); 7,500 since #767 added Language (about 30 characters); 7,800 since #975
  // added Default view, #984 Resume agents after an unexpected close (about 85 characters each) and #976 Tile order
  // (about 40 characters). 7,780 since #1586 measures the checkout's path as `CHECKOUT` (10 characters, where the
  // 7,800 assumed a checkout of about 40). 7,860 since HI-980's Connections and HI-1755's Assistant connection
  // (accounts.list and assistant.connection, about 30 and 55 characters).
  const settingsList = measure('cw_list_settings', tool('cw_list_settings', {}, 'assistant'), 7860)
  check("settings: the fake CLI's path as it is set, whatever its length (#1586)",settingsList.split('\n').some((l) => l.startsWith(`claude-code.executablePath = ${path.join(__dirname, 'fake-claude', 'fake-claude.cmd')} `)), settingsList.split('\n').find((l) => l.startsWith('claude-code.executablePath')))
  check('settings: a line each, id = value, read-only ones marked',/^sessions\.compactSuggestTokens = 200000 · Suggest compacting above$/m.test(settingsList) && /^agentApi\.port = \d+ \[read-only\] · /m.test(settingsList) && /^advanced\.showDeveloperFeatures = off · /m.test(settingsList) && !/^advanced\.(logs|data|reset) /m.test(settingsList), settingsList.slice(0, 300))
  // 1,800 and 11 lines since #1286's Advanced switches The Assistant starts with Combwork's start view and Clear the CLI's
  // draft before Combwork types, whose text names compaction and Compact (about 120 characters each).
  const compactList = measure('cw_list_settings (query)', tool('cw_list_settings', { query: 'compact' }, 'assistant'), 1800)
  check('query narrows it, saying what each does', compactList.split('\n').length <= 11 && /^assistant\.compactSuggestTokens = 500000 · Highlight Compact over: Context size/m.test(compactList), compactList)
  // 3,100 since #1417's project.workflow.stageNames (one line, about 50 characters); 3,200 since #1382's
  // project.loopStepWaitMinutes (one line, about 70 characters).
  const projectList = measure('cw_list_settings (a project)', tool('cw_list_settings', { project: 'alpha', scope: 'project' }, 'assistant'), 3200)
  // Those set to inherit come last under one line (HI-1712: most of a project's own, about 350 characters less).
  check("a project's own settings, inheriting", /^Set to inherit:$[\s\S]*^project\.transcriptWarnMB · Warn when a transcript is over$/m.test(projectList) && !/= inherit · /.test(projectList.replace(/.*\[read-only\].*/g, '')), projectList.slice(0, 300))
  const one = measure('cw_read_setting', tool('cw_read_setting', { id: 'sessions.transcriptWarnMB' }, 'assistant'), 1500)
  check('a setting in full: where, what it takes, when it helps', one.includes('Where: Settings → Sessions → Warn when a transcript is over.') && /When it helps: /.test(one), one)
  // An unknown tool is a JSON-RPC error (no result at all).
  const offered = (() => {
    try {
      return !tool('cw_update_setting', { id: 'sessions.transcriptWarnMB', value: 50 }, 'assistant').isError
    } catch {
      return false
    }
  })()
  check("no change while Change settings is off: the tool isn't offered", !offered && !toolDescription('cw_update_setting', 'assistant') && (await inv('settings:get')).sessions.transcriptWarnMB === 20)
  await inv('settings:update', { assistant: { changeSettings: true } })
  const changed = measure('cw_update_setting', tool('cw_update_setting', { id: 'sessions.transcriptWarnMB', value: 50 }, 'assistant+settings'), 400)
  check('a change: old → new, and that the user can undo it', changed.startsWith('Changed Settings → Sessions → Warn when a transcript is over (sessions.transcriptWarnMB): 20 → 50. It applies now.'), changed)
  // A table keeping its size: the reply says what changed in it, not "nothing changed".
  const recolour = measure('cw_update_setting (a table)', tool('cw_update_setting', { id: 'board.colors', value: { doing: '#ff0000' } }, 'assistant+settings'), 400)
  check('a table change says which entry changed, old → new', /^Changed Settings → Board → Column colours \(board\.colors\): doing: #[0-9a-f]{6} → doing: #ff0000\./.test(recolour), recolour)
  await inv('settings:update', { board: { colors: { doing: '#3b82f6' } } })
  // The Assistant's model is its connection's (HI-2108): Settings → Assistant has no setting for it.
  const ownModel = tool('cw_read_setting', { id: 'assistant.claude-code.model' }, 'assistant').text
  check("the Assistant's own model is no setting: its connection's", /No setting "assistant\.claude-code\.model"/.test(ownModel), ownModel)
  const colours = measure('cw_read_setting (a table)', tool('cw_read_setting', { id: 'board.colors' }, 'assistant'), 1500)
  check('a table reads as its values', /: \{"hold":"#[0-9a-f]{6}",.*"done":"#[0-9a-f]{6}"\}/.test(colours), colours)
  const refusedOwn = tool('cw_update_setting', { id: 'assistant.control', value: 'projects' }, 'assistant+settings')
  check('its own Control is refused, saying where the user changes it', refusedOwn.isError && /Settings → Assistant → Control/.test(refusedOwn.text), refusedOwn.text)
  await inv('settings:update', { sessions: { transcriptWarnMB: 20 }, assistant: { changeSettings: false } })

  // The Assistant's journal (#1031): its tools only while it is on, for the Assistant; a recall is a line an entry, at
  // most ten by default, and an entry in full only on request.
  check("the journal's tools are the Assistant's, offered while it is on", !!toolDescription('cw_journal_recall', 'assistant') && !toolDescription('cw_journal_recall') && !toolDescription('cw_journal_recall', 'assistant-nojournal'))
  await inv('journal:set', { scope: ['decision', 'plan', 'event', 'incident', 'insight'] })
  for (let i = 0; i < 30; i++) tool('cw_journal_write', { kind: i % 2 ? 'decision' : 'insight', summary: `Entry ${i}: ${prose(i, 400).split('\n')[1].slice(0, 140)}`, detail: prose(300 + i, 2500), why: prose(400 + i, 300).split('\n')[1].slice(0, 200), project: PROJECTS[i % 4], links: [{ type: 'card', ref: String(numbers[i]) }], tags: ['seed'] }, 'assistant')
  const entryWritten = measure('cw_journal_write', tool('cw_journal_write', { kind: 'plan', summary: 'Measure the journal replies', why: 'Each reply stays small' }, 'assistant'), 60)
  const recalled = measure('cw_journal_recall', tool('cw_journal_recall', {}, 'assistant'), 2400)
  check('a recall gives ten one-line rows, the newest first', recalled.split('\n').length === 10 && /^#\d+ \d{4}-\d\d-\d\d plan: Measure the journal replies/.test(recalled), recalled)
  measure('cw_journal_recall (query)', tool('cw_journal_recall', { query: 'settings window reloads', limit: 10 }, 'assistant'), 2400)
  const firstId = Number(/^#(\d+)/.exec(recalled.split('\n').at(-1))[1])
  measure('cw_journal_entry', tool('cw_journal_entry', { id: firstId }, 'assistant'), 3500)
  measure('cw_journal_update', tool('cw_journal_update', { id: firstId, importance: 2 }, 'assistant'), 60)
  check('…written and changed are a line each', /^Entry #\d+ written\.$/.test(entryWritten) && tool('cw_journal_update', { id: firstId, addTags: ['kept'] }, 'assistant').text === `Entry #${firstId} updated.`)
  const outOfScope = tool('cw_journal_write', { kind: 'moment', summary: 'A nice moment' }, 'assistant')
  check("a kind the user's scope leaves out is refused, saying what is allowed", outOfScope.isError && /scope doesn't include moment entries .*allows: decision, plan, event, incident, insight/.test(outOfScope.text), outOfScope.text)
  await inv('journal:set', { enabled: false })
  const whileOff = tool('cw_journal_recall', {}, 'assistant')
  check('turned off meanwhile, a call is refused, saying the entries are kept', whileOff.isError && /journal is off .*entries are kept/.test(whileOff.text), whileOff.text)
  await inv('journal:set', { enabled: true })
  check('on again, every entry is there', tool('cw_journal_recall', { limit: 50 }, 'assistant').text.split('\n').length >= 31)
  // A card link by key (HI-1661: as the tool asks) is kept as its card: recall by its key or its old number finds it.
  const keyLinked = tool('cw_journal_write', { kind: 'plan', summary: 'Linked to its card by key', links: [{ type: 'card', ref: K(target) }] }, 'assistant')
  const linkedIds = (ref) => tool('cw_journal_recall', { link: { type: 'card', ref } }, 'assistant').text.split('\n').filter((l) => l.includes('Linked to its card by key')).length
  check('a card link by key is found by the key and by the old number', !keyLinked.isError && linkedIds(K(target)) === 1 && linkedIds(`#${target}`) === 1 && linkedIds(String(target)) === 1, keyLinked.text)
  // A long last turn in Coder's transcript (as Claude Code writes one): a 5,000-character task, 12 tool calls with long
  // summaries and a 7,000-character reply, longer than either form of the reply gives.
  const coderSession = (await live(alpha, coder.id)).sessionId
  const transcriptFile = path.join(claudeHome, 'projects', alpha.replace(/[^a-zA-Z0-9]/g, '-'), `${coderSession}.jsonl`)
  const entry = (e) => fs.appendFileSync(transcriptFile, JSON.stringify({ sessionId: coderSession, cwd: alpha, timestamp: new Date().toISOString(), ...e }) + '\n')
  const longTask = prose(7, 5000)
  entry({ type: 'user', message: { role: 'user', content: longTask } })
  for (let i = 0; i < 12; i++) {
    const id = `toolu_long_${i}`
    entry({ type: 'assistant', requestId: `req_long_${i}`, message: { model: 'claude-fake', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `echo step ${i} ${'x'.repeat(400)}` } }], usage: { input_tokens: 1, output_tokens: 1 } } })
    entry({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
  }
  const longReply = prose(8, 7000)
  entry({ type: 'assistant', requestId: 'req_long_end', message: { model: 'claude-fake', content: [{ type: 'text', text: longReply }], usage: { input_tokens: 1, output_tokens: 1 } } })
  await lib.sleep(500)
  // 1900 (HI-1996): its model and effort added, a slow round told from a throttled one.
  const activity = JSON.parse(measure('cw_agent_activity', tool('cw_agent_activity', { project: 'alpha', agent: 'Coder' }, 'assistant'), 1900))
  check('activity: the model and effort it runs with (the fake reports neither: its CLI’s default)', activity.model === 'default' && activity.effort === 'default' && !('retryWaits' in activity), JSON.stringify({ model: activity.model, effort: activity.effort, retryWaits: activity.retryWaits }))
  const detail = JSON.parse(measure('cw_agent_activity (detail)', tool('cw_agent_activity', { project: 'alpha', agent: 'Coder', detail: true }, 'assistant'), 8500))
  const shortOk = activity.toolCalls === 12 && activity.recentTools.length === 3 && activity.currentTask.length <= 301 && activity.latestReply.length <= 501 && activity.recentTools.every((t) => t.summary.length <= 101)
  check('activity: the short form is clipped as described (300, 500, last 3 calls at 100)', shortOk, JSON.stringify({ calls: activity.toolCalls, tools: activity.recentTools?.length, task: activity.currentTask?.length, reply: activity.latestReply?.length }))
  const detailOk = detail.toolCalls === 12 && detail.recentTools.length === 10 && detail.currentTask.length <= 2001 && detail.latestReply.length <= 3001 && detail.recentTools.every((t) => t.summary.length <= 201) && detail.recentTools.some((t) => t.summary.length > 101)
  check('activity: detail is bounded as described (2000, 3000, last 10 of 12 calls at 200), not "in full"', detailOk, JSON.stringify({ calls: detail.toolCalls, tools: detail.recentTools?.length, task: detail.currentTask?.length, reply: detail.latestReply?.length }))
  check('activity: says what was cut, by its whole length', activity.clipped?.currentTask === longTask.length && activity.clipped?.latestReply === longReply.length && detail.clipped?.currentTask === longTask.length && detail.clipped?.latestReply === longReply.length, JSON.stringify([activity.clipped, detail.clipped]))
  // Its bounds are in use-cw-api's tools.md (HI-2012); the description says detail=true clips less.
  const activityDetail = fs.readFileSync(path.join(lib.ROOT, 'resources', 'skills', 'use-cw-api', 'tools.md'), 'utf8')
  check('activity: the tool and its detail say the same bounds', /detail=true clips less/.test(toolDescription('cw_agent_activity', 'assistant')) && /the task to 300 characters, the reply to 500, the last 3 tool calls at 100 each; `detail=true` raises that to 2000, 3000 and the last 10 calls at 200 each/.test(activityDetail) && !/in full/.test(toolDescription('cw_agent_activity', 'assistant')))
  measure('cw_wait_for_agents', tool('cw_wait_for_agents', { agents: [{ project: 'alpha', agent: 'Coder' }], timeoutSeconds: 5 }, 'assistant'), 1000)
  // An agent watch (#416): an agent not working is the answer at once, in a line; cancel says what it ended.
  const agentAlready = measure('cw_wait_for_agents (wake, not working)', tool('cw_wait_for_agents', { agents: [{ project: 'alpha', agent: 'Coder' }], wake: true }, 'assistant'), 300)
  check('an agent watch on an agent not working: already, with its state', agentAlready.startsWith('Already: Coder (alpha) is '), agentAlready)
  check('cancel with no watch says so', measure('cw_wait_for_agents (cancel)', tool('cw_wait_for_agents', { cancel: true }, 'assistant'), 100) === 'You had no watch.', texts['cw_wait_for_agents (cancel)'])
  // A lane watch (#531): begun, saying what it counts; cancelled.
  const laneWatch = measure('cw_wait_for_tasks (lanes, wake)', tool('cw_wait_for_tasks', { lanes: ['all'], wake: true }, 'assistant'), 300)
  check('a lane watch begun (default events, not repeated): to end the turn', laneWatch.startsWith('Waiting on all running lanes. End your turn now: Combwork types a line into this session on a lane event'), laneWatch)
  check('…cancelled', measure('cw_wait_for_tasks (lanes, cancel)', tool('cw_wait_for_tasks', { cancel: true }, 'assistant'), 100) === 'Cancelled your lane watch.', texts['cw_wait_for_tasks (lanes, cancel)'])
  check('activating a project confirms it', measure('cw_activate_project', tool('cw_activate_project', { project: 'gamma' }, 'assistant'), 300) === 'gamma is on.')
  measure('cw_create_project', tool('cw_create_project', { name: 'epsilon' }, 'assistant'), 300)
  const added = measure('cw_add_agent', tool('cw_add_agent', { project: 'beta', name: 'Helper' }, 'assistant'), 400)
  check('a new agent: its name, id, connection and folder', /^Added Helper \(id a-\w+\) to beta: claude-code( on [^,]+)?, in the project folder, stopped\.$/.test(added), added)
  measure('cw_update_agent', tool('cw_update_agent', { project: 'beta', agent: 'Helper', workflowRole: 'builder' }, 'assistant'), 1000)
  // Connections (HI-2108): a row each, short.
  measure('cw_connection (list)', tool('cw_connection', { action: 'list' }, 'assistant'), 600)
  const started = measure('cw_start_agent', tool('cw_start_agent', { project: 'beta', agent: 'Helper' }, 'assistant'), 400)
  check('a start: its status and session', /^Started Helper in beta: \w+, session [\w-]+\. Follow it with cw_wait_for_agents\.$/.test(started), started)
  const helper = async () => live(path.join(ws, 'beta'), (await inv('workspace:refresh')).projects.find((p) => p.name === 'beta').agents.find((a) => a.name === 'Helper').id)
  check('Helper is ready', !!(await until(async () => (await helper())?.status === 'ready', HUNG_MS)), (await helper())?.status)
  measure('cw_prompt_agent', tool('cw_prompt_agent', { project: 'beta', agent: 'Helper', text: 'turn 1' }, 'assistant'), 300)
  // Its turn over before the message, which is then told at once (#724: a 15 s wait ran out unchecked under load, and
  // the message was queued for a working agent).
  check("Helper's turn is over", !!(await until(async () => (await helper())?.status === 'finished', HUNG_MS)), (await helper())?.status)
  const msg = measure('cw_message_agent', tool('cw_message_agent', { project: 'beta', agent: 'Helper', text: 'turn 2' }, 'assistant'), 200)
  check('a message to an idle agent is told at once, with its id', /^Told Helper now \(m\d+\): it reads it with cw_inbox\.$/.test(msg), msg)
  // Until Helper reads it, a told message can still be cancelled (#650): nothing waits once it is received (#681).
  await lib.until(() => ['received', 'acked'].includes(JSON.parse(tool('cw_agent_activity', { project: 'beta', agent: 'Helper' }, 'assistant').text).inbox?.deliveries?.at(-1)?.state), HUNG_MS)
  check('cancel with nothing waiting says so', measure('cw_message_agent (cancel)', tool('cw_message_agent', { project: 'beta', agent: 'Helper', cancel: true }, 'assistant'), 100) === 'No message was waiting for Helper.', texts['cw_message_agent (cancel)'])
  // Its turn for the message over: stopping a working agent would ask the user.
  check("…and its turn for the message is over", !!(await until(async () => (await helper())?.status === 'finished', HUNG_MS)), (await helper())?.status)
  measure('cw_stop_agent', tool('cw_stop_agent', { project: 'beta', agent: 'Helper' }, 'assistant'), 300)
  const startedCard = measure('cw_start_task', tool('cw_start_task', { number: todo[20], name: 'Starter' }, 'assistant'), 600)
  check('a started card: who has it', new RegExp(`^Started ${K(todo[20])} .+ on a new agent, Starter in \\w+; the card is in Doing\\.`).test(startedCard), startedCard)
  measure('cw_list_tasks (as Assistant, all)', tool('cw_list_tasks', {}, 'assistant'), 80 * 200)
  measure('cw_create_task (as Assistant)', tool('cw_create_task', { title: 'Assistant card', project: 'alpha', description: prose(600, 1800) }, 'assistant'), 400)
  measure('cw_update_task (as Assistant)', tool('cw_update_task', { number: todo[30], comment: 'Noted.' }, 'assistant'), 400)
  // A long title (HI-1872): kept, never refused, the reply's last line suggesting a shorter one; none for a title within
  // the limit, a change without a title, the user's own title (the window's), or with the setting at 0.
  const LONG = 'Tray: the restart notice stays after Combwork restarts, because the update check runs before the window opens'
  const NUDGE = 'Titles over 80 characters are cut in git and on the board: consider a shorter one (the detail belongs in the description).'
  const nudged = (text) => text.split('\n').at(-1) === NUDGE
  const longMade = measure('cw_create_task (a long title)', tool('cw_create_task', { title: LONG, description: prose(700, 600) }), 500)
  const longKey = /^([A-Z]{2,4}-\d+) /.exec(longMade)?.[1]
  check('a long title from an agent: created with it, the nudge on a last line of its own', longMade.split('\n').length === 2 && longMade.split('\n')[0].endsWith(`: ${LONG}`) && nudged(longMade), longMade)
  check('…and the card keeps it whole', !!longKey && JSON.parse(tool('cw_read_task', { number: longKey }).text).title === LONG, longKey)
  const retitled = measure('cw_update_task (a long title)', tool('cw_update_task', { number: longKey, title: `${LONG}, again` }), 500)
  check('a long retitle: changed, the nudge on a last line', retitled.split('\n').length === 2 && retitled.startsWith(`${longKey} ${LONG}, again: `) && nudged(retitled), retitled)
  const commentOnly = tool('cw_update_task', { number: longKey, comment: 'Noted.' }).text
  check('…a change without a title: no nudge', !commentOnly.includes('\n') && /: Commented\./.test(commentOnly), commentOnly)
  const shortened = tool('cw_update_task', { number: longKey, title: 'Restart notice stays after a restart' }).text
  check('…a title within the limit: no nudge', !shortened.includes('\n') && shortened.startsWith(`${longKey} Restart notice stays after a restart: `), shortened)
  const asLong = measure('cw_create_task (as Assistant, a long title)', tool('cw_create_task', { title: LONG, project: 'alpha', description: prose(701, 600) }, 'assistant'), 600)
  check("the Assistant's long title: created with it, the nudge on a last line", asLong.includes(`: ${LONG}`) && nudged(asLong), asLong)
  const viaApi = await api('POST', '/v1/tasks', { title: LONG, project: 'alpha' })
  check("the Agent API's card JSON: the title kept, nudge beside it", viaApi.status === 200 && viaApi.body?.title === LONG && viaApi.body?.nudge === NUDGE, viaApi.text.slice(0, 300))
  const mine = await inv('tasks:create', { title: LONG, project: 'alpha' })
  check("the user's own long title, from the window: kept, no nudge", mine?.title === LONG && mine?.nudge === undefined, JSON.stringify(mine).slice(0, 300))
  await inv('advanced:set', 'cw.cards.titleNudgeChars', 0)
  const unNudged = tool('cw_create_task', { title: LONG, description: 'Off.' }).text
  check('with Suggest a shorter title past at 0: kept, no nudge', !unNudged.includes('\n') && unNudged.endsWith(`: ${LONG}`), unNudged)
  await inv('advanced:set', 'cw.cards.titleNudgeChars', 80)
  // Out of Todo again, as the user would park them: the checks below count Todo's 50.
  for (const made of (await api('GET', '/v1/tasks?column=todo')).body.filter((x) => x.title.startsWith(LONG) || x.title === 'Restart notice stays after a restart')) await inv('tasks:update', made.number, { column: 'hold' })
  measure('cw_reorder_tasks (as Assistant)', tool('cw_reorder_tasks', { column: 'todo', cards: [todo[31], todo[32]] }, 'assistant'), 300)
  // Undo (#1282): its messages' changes, a line each; one message's changes with their ids; what an undo did.
  tool('cw_update_tasks', { numbers: [todo[33], todo[34]], addLabels: ['undo-me'] }, 'assistant')
  const changeGroups = measure('cw_undo (list)', tool('cw_undo', { list: true }, 'assistant'), 10 * 300)
  const changeLines = measure('cw_undo (list, a message)', tool('cw_undo', { list: true, group: changeGroups.split(' ')[0] }, 'assistant'), 40 * 200)
  const relabel = changeLines.split('\n').find((l) => new RegExp(`#${todo[33]}\\b`).test(l) && /\(labels\)/.test(l))
  const undone = measure('cw_undo', tool('cw_undo', { change: relabel?.split(':')[0] ?? '' }, 'assistant'), 300)
  check('an undo says what it did, in a line', undone === 'Undid 1 of 1 change in full.', `${relabel} → ${undone}`)
  // Release Slot (#1561): alpha has nothing to release, said in a line; project agents aren't given the tool.
  const releasable = measure('cw_release_slot (list)', tool('cw_release_slot', { action: 'list', project: 'alpha' }, 'assistant'), 200)
  check('release slot: nothing to release, in a line', releasable.startsWith('Nothing to release in alpha: '), releasable)
  check('…the tool is the Assistant\'s, not offered to project agents', toolDescription('cw_release_slot') === '' && toolDescription('cw_release_slot', 'assistant').length > 0)
  // Templates (HI-1502): a line per template; a plan and a load (Team 3×3 into gamma, which has no agents, one named) in
  // a few lines each; project agents aren't given the tool.
  const templateList = measure('cw_template (list)', tool('cw_template', { action: 'list', project: 'gamma' }, 'assistant'), 1200)
  check('templates: a line each, with the scope and file to name it by', templateList.split('\n').some((l) => l.startsWith('Team 3×3 (scope combwork, file team-3x3.json): 6 agents')), templateList)
  const templatePlan = measure('cw_template (plan)', tool('cw_template', { action: 'plan', project: 'gamma', template: 'team-3x3.json', names: { 1: 'Gamma lead' } }, 'assistant'), 1500)
  check('…a plan: who comes, the name given beside its own', /^"Team 3×3" into gamma: removes no agents; creates Gamma lead \([A-Z]+-B1\) builder with [A-Z]+-R1/.test(templatePlan), templatePlan)
  const templateLoaded = measure('cw_template (load)', tool('cw_template', { action: 'load', project: 'gamma', template: 'team-3x3.json', names: { 1: 'Gamma lead' } }, 'assistant'), 1500)
  check('…a load: what it made, the name given, and that undo puts it back', /^Loaded "Team 3×3" into gamma: removed no agents; created Gamma lead, .*cw_undo can put the agents and options back\.$/.test(templateLoaded), templateLoaded)
  // Choose Connections (HI-2109): the reviewers on the first connection the plan offered, in a line.
  const offeredConnection = /Connections here: [^(]*\([^,]+, ([^)]+)\)/.exec(templatePlan)?.[1] ?? ''
  const applied = measure('cw_template (apply)', tool('cw_template', { action: 'apply', project: 'gamma', connections: { reviewer: offeredConnection } }, 'assistant'), 500)
  check('…apply: who got which connection, in a line', applied.startsWith('Connections in gamma: ') && !applied.includes('\n'), applied)
  check('…the tool is the Assistant\'s, not offered to project agents', toolDescription('cw_template') === '' && toolDescription('cw_template', 'assistant').length > 0)

  console.log('\n--- Agent API routes not behind a tool')
  const route = async (label, method, p, body) => measure(`API ${label}`, (await api(method, p, body)).text)
  const status = JSON.parse(await route('GET /v1/status', 'GET', '/v1/status'))
  check('status: the API version, the caller, and the guidance and skill revisions', status.api?.version >= 2 && status.caller?.role === 'api' && /^[0-9a-f]{16}$/.test(status.guidance?.revision) && status.guidance.skills.some((x) => x.name === 'work-on-card' && x.bundled === 'same' && x.audience === 'agents') && !('agent' in status), JSON.stringify({ api: status.api, caller: status.caller, revision: status.guidance?.revision }))
  const skill = (await api('GET', '/v1/skills/review-agent-work')).body
  check("a skill's entry point and its file list", skill?.file === 'SKILL.md' && skill.content.replace(/\r\n/g, '\n').startsWith('---\nname: review-agent-work') && skill.files.includes('SKILL.md'), JSON.stringify(skill).slice(0, 200))
  for (const [label, q, code] of [['a path out of the folder', '../work-on-card/SKILL.md', 400], ['an absolute path', 'C:/Windows/win.ini', 400], ['a file it does not have', 'references/none.md', 404]]) {
    const r = await api('GET', `/v1/skills/review-agent-work?file=${encodeURIComponent(q)}`)
    check(`a skill file read refuses ${label} (${code})`, r.status === code, `${r.status} ${r.text.slice(0, 120)}`)
  }
  check('an unknown skill is 404', (await api('GET', '/v1/skills/no-such-skill')).status === 404)
  // A big skill: its listing says it's cut short, and a file over the limit is 413 without being sent.
  const bulky = path.join(ws, '.combwork', 'skills', 'bulky')
  fs.mkdirSync(path.join(bulky, 'refs'), { recursive: true })
  fs.writeFileSync(path.join(bulky, 'SKILL.md'), '---\nname: bulky\ndescription: Many files\n---\n\nSee refs.\n')
  for (let i = 0; i < 230; i++) fs.writeFileSync(path.join(bulky, 'refs', `r${String(i).padStart(3, '0')}.md`), 'r')
  fs.writeFileSync(path.join(bulky, 'refs', 'huge.md'), 'x'.repeat(600 * 1024))
  const bulk = (await api('GET', '/v1/skills/bulky')).body
  check('a long file list is cut at 200 and says so', bulk?.files?.length === 200 && bulk.filesTruncated === true && bulk.files[0] === 'SKILL.md', JSON.stringify({ n: bulk?.files?.length, t: bulk?.filesTruncated }))
  check('a short one says nothing about it', !('filesTruncated' in skill))
  const huge = await api('GET', '/v1/skills/bulky?file=refs%2Fhuge.md')
  check('a file over 512 KB is 413', huge.status === 413 && huge.text.length < 300, `${huge.status} ${huge.text.length}`)
  const statusAgain = (await api('GET', '/v1/status')).body
  check("the status has the new skill's revision", /^[0-9a-f]{16}$/.test(statusAgain.guidance.skills.find((x) => x.name === 'bulky')?.revision ?? ''), JSON.stringify(statusAgain.guidance.skills.find((x) => x.name === 'bulky')))
  fs.rmSync(bulky, { recursive: true, force: true })
  const doc = (await api('GET', '/v1/docs/agent-api')).body
  check("the API's own reference, from the running Combwork", doc?.content?.startsWith('# Combwork Agent API') && doc.api === status.api.version, JSON.stringify(doc).slice(0, 120))
  await route('GET /v1/workspace', 'GET', '/v1/workspace')
  await route('GET /v1/workspaces', 'GET', '/v1/workspaces')
  await route('GET /v1/projects/alpha/sessions', 'GET', '/v1/projects/alpha/sessions')
  await route('POST /v1/projects/delta/deactivate', 'POST', '/v1/projects/delta/deactivate')
  await route('POST /v1/projects/alpha/input', 'POST', '/v1/projects/alpha/input', { agent: 'Coder', text: '', submit: false })
  await route('POST /v1/tasks/n/comments', 'POST', `/v1/tasks/${todo[40]}/comments`, { text: 'Seen.' })
  await route('GET /v1/mcp', 'GET', '/v1/mcp')
  await route('GET /v1/health', 'GET', '/v1/health')

  // The Agent API's own replies are unchanged unless a caller asks for the short ones.
  const apiList = (await api('GET', '/v1/tasks?column=todo')).body
  check('API: GET /v1/tasks still gives whole cards, their history counted (HI-2568)', apiList.length === 50 && typeof apiList[0].description === 'string' && !('history' in apiList[0]) && apiList[0].historyEntries >= 1)
  const apiCard = (await api('PATCH', `/v1/tasks/${todo[41]}`, { comment: 'API' })).body
  check('API: PATCH still answers with the card', apiCard.number === todo[41] && Array.isArray(apiCard.comments) && Array.isArray(apiCard.history))
  const apiProjects = (await api('GET', '/v1/projects')).body
  check('API: GET /v1/projects still has settings', apiProjects.every((x) => x.settings && x.path))
  const apiShort = (await api('GET', '/v1/tasks?column=todo&view=short')).body
  check('API: ?view=short gives rows', apiShort.length === 50 && !('description' in apiShort[0]) && typeof apiShort[0].comments === 'number')
  // 1.0 (#1223): a card ends with its stage, additive; its facts are short rows (none here: no 1.0 rule has run on it).
  check('API: a card ends with its 1.0 stage', Object.keys(apiCard).at(-1) === 'stage' && apiCard.stage === 'todo' && apiCard.column === 'todo', JSON.stringify({ stage: apiCard.stage, last: Object.keys(apiCard).at(-1) }))
  const factsText = await route('GET /v1/tasks/n/facts', 'GET', `/v1/tasks/${todo[41]}/facts`)
  const facts = JSON.parse(factsText)
  check("API: a card's facts, lean", facts.number === todo[41] && facts.stage === 'todo' && Array.isArray(facts.facts) && factsText.length <= 200, factsText.slice(0, 200))
  check('API: facts in a view it has not is 400', (await api('GET', `/v1/tasks/${todo[41]}/facts?view=long`)).status === 400)

  // --- Performance metrics (#115): what the bridge reports is the model's text exactly, attributed by the caller's own
  // token; the API counts route templates, never paths asked for; the bridge's reports aren't API traffic.
  console.log('\n--- Performance metrics')
  const since = new Date(Date.now() - 3600_000).toISOString()
  const launch = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).reverse().find((l) => l.token && l.cwd.toLowerCase() === alpha.toLowerCase())
  // Its agent's latest launch's token, read at each call: a workflow change restarts it with a new one (HI-2694).
  const launchAgent = launch?.env?.CW_AGENT
  const latestToken = () => fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).reverse().find((l) => l.token && l.env?.CW_AGENT === launchAgent && l.cwd.toLowerCase() === alpha.toLowerCase())?.token
  check("metrics: the agent's own token is known", !!latestToken())
  const asCoder = (method, request) =>
    JSON.parse(execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: request }) + '\n', env: lib.childEnv({ CW_API_URL: API, CW_WORKSPACE: ws, CW_API_TOKEN_FILE: lib.tokenFile(latestToken()), CW_PROJECT: 'alpha', CW_AGENT_ID: coder.id }), timeout: 60000 }).toString().split('\n')[0]).result
  const unicode = (await api('POST', '/v1/tasks', { title: 'Ünïcödé 日本語 🐝 "quoted" \\ back', project: 'alpha', description: 'Ελληνικά — ✓ — \n new line' })).body.number
  const expected = {}
  for (const [name, args] of [['cw_list_tasks', {}], ['cw_list_tasks', { details: true }], ['cw_read_task', { number: unicode }], ['cw_read_task', { number: 999999 }]]) {
    const r = asCoder('tools/call', { name, arguments: args })
    const text = r.content[0].text
    // A failed call by its kind (HI-2553): an unknown card is a wrong call (the API's 404).
    const key = `${name} ${args.details ? 'detail' : 'compact'} ${r.isError ? 'invalid' : 'ok'}`
    const e = (expected[key] ??= { count: 0, chars: 0, bytes: 0 })
    e.count++
    e.chars += text.length
    e.bytes += Buffer.byteLength(text, 'utf8')
  }
  const list = asCoder('tools/list', {}).tools
  check('metrics: a Unicode reply has more bytes than characters', expected['cw_read_task compact ok'].bytes > expected['cw_read_task compact ok'].chars)
  await lib.sleep(500)
  const report = (await api('GET', `/v1/metrics?scope=workspace&from=${encodeURIComponent(since)}`)).body
  const alphaPart = report.projects?.alpha
  const got = {}
  for (const sr of alphaPart?.mcp ?? []) got[`${sr.tool} ${sr.mode} ${sr.outcome}`] = { count: sr.count, chars: sr.chars, bytes: sr.bytes }
  check("metrics: each tool call's reported size is the text the model got, by mode and outcome", JSON.stringify(Object.fromEntries(Object.entries(got).filter(([k]) => k in expected).sort())) === JSON.stringify(Object.fromEntries(Object.entries(expected).sort())), JSON.stringify({ got, expected }))
  // Each launch's side of the workflow its own series (HI-2049): summed here.
  const cats = (alphaPart?.catalog ?? []).filter((c) => c.role === 'agent')
  const cat = cats.reduce((a, c) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + c[k]])), { starts: 0, tools: 0, toolsBytes: 0, toolsChars: 0, charStarts: 0, partStarts: 0, partToolsChars: 0, descriptionChars: 0, paramChars: 0, upfrontStarts: 0, upfrontBytes: 0 })
  // Once a start: the coder's, and the agent a card was started on, whose fake reads its inbox when its task's doorbell
  // rings (#650: through the Combwork MCP server, which it starts for that call, with a tool list of its own). The catalog sums
  // them: the coder's list as it got it, and the other's.
  const listBytes = Buffer.byteLength(JSON.stringify(list), 'utf8')
  const listChars = JSON.stringify(list).length
  check("metrics: the tool list as the session got it, once a start, in bytes and characters", cat.starts === 2 && cat.tools > list.length && cat.tools < list.length * 3 && cat.toolsBytes > listBytes && cat.toolsBytes < listBytes * 3 && cat.charStarts === 2 && cat.toolsChars > listChars && cat.toolsChars < listChars * 3, JSON.stringify({ cat, list: list.length, bytes: listBytes, chars: listChars }))
  // Its parts (HI-2063): the descriptions and the parameters' descriptions as the list the coder got has them.
  const inJson = (s) => JSON.stringify(s).length - 2
  const paramsOf = (v) => (Array.isArray(v) ? v.reduce((n, x) => n + paramsOf(x), 0) : v && typeof v === 'object' ? Object.entries(v).reduce((n, [k, x]) => n + (k === 'description' && typeof x === 'string' ? inJson(x) : paramsOf(x)), 0) : 0)
  const listDescriptions = list.reduce((n, t) => n + inJson(t.description ?? ''), 0)
  const listParams = list.reduce((n, t) => n + paramsOf(t.inputSchema), 0)
  check("metrics: the tool list's descriptions and parameters' descriptions, a part of its characters", cat.partStarts === 2 && cat.partToolsChars === cat.toolsChars && cat.descriptionChars >= listDescriptions && cat.descriptionChars < listDescriptions * 3 && cat.paramChars >= listParams && cat.paramChars < listParams * 3 && cat.descriptionChars + cat.paramChars < cat.toolsChars, JSON.stringify({ cat, listDescriptions, listParams }))
  check("metrics: each tool list on the side of the launch whose Combwork MCP server sent it", cats.length > 0 && cats.every((c) => ['builder', 'reviewer', 'either', 'none'].includes(c.workflow)), JSON.stringify(cats.map((c) => [c.workflow, c.starts])))
  // HI-2553: on its launch's provider (the fake Claude Code), and what a CLI that defers tools got up front: the tools
  // marked to be sent in full and the others' names, as the coder's list has them.
  const marked = list.filter((t) => t._meta)
  const upfront = Buffer.byteLength(JSON.stringify(marked), 'utf8') + Buffer.byteLength(JSON.stringify(list.filter((t) => !t._meta).map((t) => t.name)), 'utf8')
  check('metrics: each tool list on its launch\'s provider, with its up-front part', cats.every((c) => ['claude-code', 'unknown'].includes(c.provider)) && cats.some((c) => c.provider === 'claude-code') && cat.upfrontStarts === 2 && cat.upfrontBytes >= upfront && cat.upfrontBytes < upfront * 3 && cat.upfrontBytes < cat.toolsBytes, JSON.stringify({ cats: cats.map((c) => [c.provider, c.workflow, c.starts, c.upfrontBytes]), upfront }))
  check("metrics: the Assistant's tool calls are the workspace's own, with detail mode counted", (report.workspace?.mcp ?? []).some((sr) => sr.role === 'assistant' && sr.tool === 'cw_agent_activity' && sr.mode === 'detail'), JSON.stringify(report.workspace?.mcp?.slice(0, 3)))
  const routes = [...Object.values(report.projects), report.workspace].flatMap((pt) => pt.api.map((sr) => sr.route))
  check('metrics: API routes are templates, never paths asked for', routes.includes('/v1/tasks/:n') && !routes.some((r) => /\/\d/.test(r)), routes.join(' '))
  check("metrics: the bridge's own reports aren't counted as API traffic", !routes.includes('/v1/metrics/mcp'))
  check("metrics: an agent's API calls are its project's", (alphaPart?.api ?? []).some((sr) => sr.role === 'agent' && sr.route === '/v1/tasks/:n'))
  // A project agent sees its own project only.
  const coderApi = (p) => api('GET', p, undefined, latestToken())
  check("metrics: an agent can't read the workspace's", (await coderApi('/v1/metrics?scope=workspace')).status === 403)
  const own = await coderApi('/v1/metrics?scope=project&project=alpha')
  check('metrics: an agent reads its own project only', own.status === 200 && Object.keys(own.body.projects).join() === 'alpha' && !own.body.workspace && !own.body.app, JSON.stringify(Object.keys(own.body ?? {})))
  check("metrics: an agent's project report carries only its own loss count, nothing of the workspace's", typeof own.body.dropped === 'number' && !('droppedUntracked' in own.body) && !own.body.skills, JSON.stringify(Object.keys(own.body ?? {})))
  // A request refused before Combwork knew whose it was; one whose client went away while sending its body.
  const before = report.app.unauthenticated
  await api('GET', '/v1/tasks', undefined, 'not-a-token')
  const net = require('net')
  await new Promise((resolve) => {
    const sock = net.connect(Number(new URL(API).port), '127.0.0.1', () => {
      sock.write(`POST /v1/tasks HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${apiToken}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"title":`)
      setTimeout(() => {
        sock.destroy()
        resolve()
      }, 300)
    })
  })
  await lib.sleep(500)
  const after = (await api('GET', `/v1/metrics?scope=workspace&from=${encodeURIComponent(since)}`)).body
  check('metrics: a refused token is counted, not attributed to a workspace', after.app.unauthenticated === before + 1, `${before} → ${after.app.unauthenticated}`)
  const cancelled = after.workspace.api.find((sr) => sr.route === '/v1/tasks' && sr.method === 'POST' && sr.outcome === 'cancelled' && sr.role === 'api')
  check('metrics: a client that goes away mid-request is cancelled, with the body bytes it did send', cancelled?.requestBytes === Buffer.byteLength('{"title":'), JSON.stringify(cancelled))
  check('metrics: says what it does not measure', after.notMeasured.length >= 4 && after.recording === true)
  const g = (after.projects.alpha?.guidance ?? []).find((x) => x.provider === 'claude-code' && x.role === 'agent')
  check("metrics: each launch's guidance, exact sizes, by provider, role and workflow role", ['builder', 'reviewer', 'either', 'none'].includes(g?.workflow) && g?.launches >= 1 && g.guidanceBytes > 1000 && g.guidanceChars > 1000 && g.skills >= 5 && g.skillCatalogBytes > 0 && g.skillBytes > g.skillCatalogBytes, JSON.stringify(g))
  const ga = (after.workspace?.guidance ?? []).find((x) => x.role === 'assistant')
  // Its custom part is the journal's rule (#1032: on by default, work only).
  const journalBytes = Buffer.byteLength(`
${require('../../src/shared/combworkGuidance.ts').journalRule(require('../../src/shared/journal.ts').DEFAULT_SCOPE)}`)
  check("metrics: the Assistant's launch is the workspace's own, its core, role and mode each measured, and the journal's rule as its custom part", ga?.launches >= 1 && ga.guidanceBytes > 0 && ga.roleBytes > 0 && ga.modeBytes > 0 && ga.customBytes === journalBytes, `${JSON.stringify(ga)}; the journal's rule: ${journalBytes}`)

  // --- cw_inbox's three forms (#1531), by each caller: the Assistant (its tool), a script with an agent's own token
  // (the API), the agent (its tool), and the workspace's token, which has no inbox. After the metrics' checks: the
  // agent's fake reads the message on its doorbell, starting a Combwork MCP server the catalog would count.
  check("inbox: the Assistant's ack with read: the ack line, then the read", measure('cw_inbox (ack, read)', tool('cw_inbox', { ack: ['m99'], read: true }, 'assistant'), 200) === 'Nothing acked. Not in your inbox: m99.\nNothing new.', texts['cw_inbox (ack, read)'])
  // A delivery the token's own agent has received (alpha's latest launch: the agent a card was started on, its task):
  // read with its token, it is that agent's to ack, whoever it is.
  const firstRead = await api('POST', '/v1/inbox', {}, latestToken())
  check('inbox: a read with the agent\'s own token: { items, unacked }', firstRead.status === 200 && Object.keys(firstRead.body).filter((k) => k !== 'names').sort().join() === 'items,unacked', firstRead.text)
  const coderMessage = [...(firstRead.body?.unacked ?? []), ...(firstRead.body?.items ?? []).flatMap((i) => i.ids)][0]
  check('…with one received, its to ack', !!coderMessage, firstRead.text)
  const both = await api('POST', '/v1/inbox', { ack: [coderMessage, 'm99999'], read: true }, latestToken())
  check("inbox: ack with read, with the agent's own token: acked, an id not its own unknown, then the read", both.status === 200 && both.body.acked?.join() === coderMessage && both.body.unknown?.join() === 'm99999' && Array.isArray(both.body.unread) && Array.isArray(both.body.items) && Array.isArray(both.body.unacked) && !both.body.unacked.includes(coderMessage), both.text)
  const ackOnly = await api('POST', '/v1/inbox', { ack: [coderMessage] }, latestToken())
  check('inbox: ack only lists nothing: { acked, unknown, unread }', ackOnly.status === 200 && Object.keys(ackOnly.body).sort().join() === 'acked,unknown,unread' && ackOnly.body.acked.join() === coderMessage, ackOnly.text)
  check("inbox: read isn't a flag of any kind", (await api('POST', '/v1/inbox', { ack: [coderMessage], read: 'yes' }, latestToken())).status === 400)
  check("inbox: the workspace's token has no inbox, combined or not", (await api('POST', '/v1/inbox', { ack: [coderMessage], read: true })).status === 400 && (await api('POST', '/v1/inbox', {})).status === 400)
  const coderBoth = asCoder('tools/call', { name: 'cw_inbox', arguments: { ack: [coderMessage], read: true } }).content[0].text
  check("inbox: the agent's tool, ack with read: the ack line, then the read's", coderBoth.split('\n')[0] === `Acked ${coderMessage}.` && /^(Nothing new\.|\d+ new:)/.test(coderBoth.split('\n')[1] ?? '') && coderBoth.length <= 2000, coderBoth)

  // A card's intents (#1267), as the coder with its own token: where the card went, in a line; a plain number refused.
  const intent = (name, args) => {
    const r = asCoder('tools/call', { name, arguments: args })
    return { text: r.content[0].text, isError: !!r.isError }
  }
  // In a lane Tester reviews (#1382: a design needs a reviewer to check it), ended once the design is measured. The card
  // is started first (HI-2082): a card in Doing is never a lane's to start, so Combwork's own look can't start it first.
  // The lane is the starter's, the same agent's (asCoder's token: alpha's latest launch, Starter's since cw_start_task):
  // a lane whose cards another agent holds ends by itself (HI-3118), and its card then has no reviewer (HI-3163).
  const startedOwn = measure('cw_start_card', intent('cw_start_card', { card: `#${todo[40]}` }), 400)
  const designStart = intent('cw_lane', { action: 'start', cards: [todo[40]], reviewer: 'Tester', name: 'design step' }).text
  const designLane = designStart.match(/lane-[0-9a-f]+$/)?.[0]
  check('a lane for the design step, Tester reviewing', !!designLane, designStart)
  check('an intent says where the card went', new RegExp(`^[A-Z]+-\\d+: todo → active\\. folder: `).test(startedOwn), startedOwn)
  // …and what can come next on it, as its rules have it (#1530).
  check('…and what comes next on it', startedOwn.split('\n')[0].endsWith(' Next on it: cw_submit or cw_put_back.'), startedOwn)
  // A card loop's design step (#1382): nothing moves, and the reply says how long to wait for the check.
  const designed = measure('cw_loop_step', intent('cw_loop_step', { card: `#${todo[40]}`, step: 'design', text: 'Design: one line.' }), 160)
  check('a design step says the card stays, names the design and when its check is due', /^[A-Z]+-\d+: still active\. design: [A-Z]+-\d+\/s\d+; until: \S+; waitMinutes: 30$/.test(designed), designed)
  check('…and its lane ends', !!designLane && tool('cw_lane', { action: 'end', lane: designLane, abandoned: true }).text.startsWith('Lane abandoned: '), designLane)
  const putBack = measure('cw_put_back', intent('cw_put_back', { card: `#${todo[40]}`, why: 'Not yet.' }), 200)
  check('put back names the start as next', putBack.endsWith(' Next on it: cw_start_card.'), putBack)
  // HI-2267: a card no running lane holds gets no lane line.
  check("…and a card on no lane: no lane line", !/keeps its own order/.test(putBack) && putBack.split('\n').length === 1, putBack)
  check("a reorder of cards on no lane: one line, no lane line", !/keeps its own order/.test(texts['cw_reorder_tasks (3 cards)'] ?? '') && (texts['cw_reorder_tasks (3 cards)'] ?? '').split('\n').length === 1, texts['cw_reorder_tasks (3 cards)'])
  // HI-2267: a lane's card put back (as its builder, and as the Assistant) or reordered on the board: the real reply names
  // the lane, which keeps its own order, and how to change it. Two cards of its own in alpha, gone again after.
  {
    const made = []
    for (const title of ['Lane order A', 'Lane order B']) made.push((await api('POST', '/v1/tasks', { title, project: 'alpha' })).body.number)
    const [a, b] = made
    // Their keys as replies give them (made after the board's names were read).
    const keys = new Map()
    for (const n of made) keys.set(n, (await api('GET', `/v1/tasks/${n}`)).body?.key ?? `#${n}`)
    const Kn = (n) => keys.get(n)
    const NOTE = new RegExp(`^${Kn(a)} is on Coder's lane \\(lane-[0-9a-f]+\\), which keeps its own order and takes it in that order\\. To change it: cw_lane start with its cards in the new order \\(applyNow: true to apply it now\\)\\.$`)
    const column = async (n) => (await api('GET', `/v1/tasks/${n}`)).body?.column
    // Coder held busy on another card (HR1, round 1): a lane starts its first Todo card on an idle builder (laneStarts),
    // which would take A back between the replies measured here. Watching the untouched card, as the lane above does,
    // Coder is never idle meanwhile; armed again after each start, cancelled at the end.
    const hold = async () => {
      tool('cw_wait_for_tasks', { cards: [`#${untouched}`], wake: true }, 'own')
      return !!(await until(async () => (await live(alpha, coder.id))?.status === 'watching', HUNG_MS))
    }
    // A, in Todo with no lane holding it (so nothing else starts it), started on Coder, then Coder held again.
    const startA = async () => {
      const r = intent('cw_start_card', { card: `#${a}` })
      return !r.isError && !!(await until(async () => (await column(a)) === 'doing', HUNG_MS)) && (await hold())
    }
    const laneOver = () => tool('cw_lane', { action: 'start', cards: [a, b], reviewer: 'Tester', name: 'lane order' }, 'own').text.match(/lane-[0-9a-f]+$/)?.[0]
    const endLane = (id) => !!id && tool('cw_lane', { action: 'end', lane: id, abandoned: true }).text.startsWith('Lane abandoned: ')
    try {
      check('Coder held on another card', await hold())
      check('a lane over two cards of its own, the first started', await startA())
      const first = laneOver()
      const agentBack = measure('cw_put_back (a lane\'s card)', intent('cw_put_back', { card: `#${a}`, why: 'Not yet.' }), 400)
      const agentLines = agentBack.split('\n')
      check("put back of a lane's card: its usual line, then the lane's as a warning", agentLines.length === 2 && agentLines[0].endsWith(' Next on it: cw_start_card.') && NOTE.test(agentLines[1].replace(/^Warning: /, '')) && agentLines[1].includes(first ?? '?'), agentBack)
      check('…the card left in Todo while Coder is held', (await column(a)) === 'todo', await column(a))
      check('…and that lane ends', endLane(first), first)
      check('…the card started again, on a new lane', await startA())
      const second = laneOver()
      // The Assistant moves a card with cw_update_task (HI-2664: cw_put_back is a worker's, never offered to it).
      const asBack = measure('cw_update_task to Todo (a lane\'s card, as Assistant)', tool('cw_update_task', { number: `#${a}`, column: 'todo', comment: 'The user wants B first.' }, 'assistant'), 600)
      check("…as the Assistant: the lane's line too", asBack.split('\n').some((l) => NOTE.test(l.replace(/^Warning: /, '')) && l.includes(second ?? '?')), asBack)
      const reorderedLane = measure("cw_reorder_tasks (a lane's cards)", tool('cw_reorder_tasks', { column: 'todo', cards: [b, a] }), 500)
      const reorderLines = reorderedLane.split('\n')
      check("a reorder of a lane's cards: its line, then the lane's, by key", reorderLines.length === 2 && reorderLines[0].startsWith(`Todo now starts ${Kn(b)}, ${Kn(a)}`) && new RegExp(`^${Kn(b)}, ${Kn(a)} are on Coder's lane \\(${second}\\), which keeps its own order and takes them in that order\\. To change it: cw_lane start`).test(reorderLines[1]), reorderedLane)
      // HI-2271: project status's pair for the running lane carries its state, the card it is on, in the lane line's words.
      const projectStatus = JSON.parse(tool('cw_project_status', { project: 'alpha' }, 'assistant').text)
      const pair = (projectStatus.pairs ?? []).find((x) => x.lane === second)
      const listed = tool('cw_lane', { action: 'list' }, 'own').text.split('\n').find((l) => l.endsWith(second ?? '?')) ?? ''
      check("project status: the lane's pair says the card it is on, as its lane line does", !!pair && /^active, on [A-Z]{2,4}-\d+/.test(pair.state ?? '') && listed.includes(`: ${pair.state}; `), `${JSON.stringify(pair)} | ${listed}`)
      check('…and that lane ends', endLane(second), second)
    } finally {
      tool('cw_wait_for_tasks', { cancel: true }, 'own')
      await until(async () => ['ready', 'finished'].includes((await live(alpha, coder.id))?.status), HUNG_MS)
      for (const n of made) await inv('tasks:delete', n)
    }
  }
  // A request for the Assistant (HI-1866): the card, and its id in the Assistant's inbox.
  const askedAssistant = measure('cw_ask_assistant', intent('cw_ask_assistant', { card: `#${todo[40]}`, text: 'Please put this card On Hold.' }), 120)
  check('asking the Assistant names the card and its inbox id', /^[A-Z]+-\d+: asked the Assistant \(m\d+ in its inbox\)\. Its answer comes to your inbox\.$/.test(askedAssistant), askedAssistant)
  // HI-2245: the builder's card watch on its card in Review whose folder has a commit past its submission: hand it over
  // first, then end the turn (the watch is registered as ever); without one, the plain watch.
  // A reviewer agent reviews it (alpha's rules have none): set for this card's start, put back after it (a card keeps
  // the rules it started under).
  const alphaRules = await inv('workflow:form', alpha)
  await inv('workflow:setOptions', alpha, { preset: alphaRules.preset, options: { ...alphaRules.own, review: 'agent', noSelfReview: true } })
  await toolsSettled()
  const builtCard = todo[44]
  const builtStart = intent('cw_start_card', { card: `#${builtCard}` }).text
  const builtFolder = builtStart.match(/folder: ([^;]+);/)?.[1]
  check('a card started for the unsubmitted watch, with its folder', !!builtFolder && fs.existsSync(builtFolder), builtStart)
  await inv('workflow:setOptions', alpha, { preset: alphaRules.preset, options: alphaRules.own })
  await toolsSettled()
  const builtCommit = (file) => {
    fs.writeFileSync(path.join(builtFolder, file), `${file}\n`)
    lib.git(builtFolder, ['add', file])
    lib.git(builtFolder, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `${K(builtCard)}: ${file}`, '--trailer', `Combwork-Card: ${K(builtCard)}`])
  }
  builtCommit('built.txt')
  const builtSubmitted = intent('cw_submit', { card: `#${builtCard}`, summary: 'Built.' }).text
  check('…submitted for review', / → review\b/.test(builtSubmitted), builtSubmitted)
  const plainWatch = intent('cw_wait_for_tasks', { cards: [`#${builtCard}`], wake: true }).text
  check('…its watch with nothing unsubmitted is the plain one', /^Waiting for [A-Z]+-\d+\. End your turn now: /.test(plainWatch), plainWatch)
  builtCommit('asked.txt')
  const unsubmittedWatch = measure('cw_wait_for_tasks (wake, unsubmitted commits)', intent('cw_wait_for_tasks', { cards: [`#${builtCard}`], wake: true }), 400)
  check('…with a commit past its submission: hand it over first, then end the turn', new RegExp(`^Waiting for ${K(builtCard)}\\. First hand ${K(builtCard)} over: ${K(builtCard)}'s line has 1 commit since its submission \\([0-9a-f]{7}\\); cw_submit with followUp: true, then end your turn: `).test(unsubmittedWatch) && !unsubmittedWatch.includes('End your turn now'), unsubmittedWatch)
  // Its builder only: another agent's watch on it (Starter's, the own token) is the plain one.
  const otherWatch = tool('cw_wait_for_tasks', { cards: [`#${builtCard}`], wake: true }, 'own').text
  check('…and only its builder is told', /^Waiting for [A-Z]+-\d+\. End your turn now: /.test(otherWatch), otherWatch)
  tool('cw_wait_for_tasks', { cancel: true }, 'own')
  intent('cw_wait_for_tasks', { cancel: true })
  const plainRefused = intent('cw_put_back', { card: String(todo[40]), why: 'Not yet.' })
  check("an intent refuses the coder's plain number, naming the card by its key", plainRefused.isError && plainRefused.text.includes(`Name the card by its key: ${K(todo[40])}.`) && plainRefused.text.length <= 600, plainRefused.text)
  check('metrics: a project agent has no role or mode', g?.roleBytes === 0 && g?.modeBytes === 0, JSON.stringify(g))
  const reported = (after.providers ?? []).find((x) => x.provider === 'claude-code' && x.role === 'agent')
  check("metrics: the providers' own reported usage for sessions in the range", reported?.sessions >= 1 && reported.inputTokens > 0, JSON.stringify(after.providers))
  check("metrics: the skill service is the workspace's own", after.skills?.scans?.count >= 1 && after.skills.hits + after.skills.misses > 0, JSON.stringify(after.skills))
  // What recording costs a request: 300 sequential calls with it on, then off (and back on). Recording is work in Combwork's
  // main process, so it is measured as that process's CPU time a request (#428): a request's wall-clock time (about 14 ms
  // here, mostly waiting) drifts by more than recording costs on a loaded machine, CPU time far less.
  const cpuMs = () => app.evaluate(() => {
    const u = process.cpuUsage()
    return (u.user + u.system) / 1000
  })
  const burst = async () => {
    const c = await cpuMs()
    const t = performance.now()
    for (let i = 0; i < 300; i++) await api('GET', '/v1/workspace')
    return { cpu: ((await cpuMs()) - c) / 300, wall: (performance.now() - t) / 300 }
  }
  const workspaceCalls = (rep) => rep.workspace.api.filter((sr) => sr.route === '/v1/workspace').reduce((n, sr) => n + sr.count, 0)
  const callsBefore = workspaceCalls((await api('GET', `/v1/metrics?scope=workspace&from=${encodeURIComponent(since)}`)).body)
  await burst()
  // Alternated three times. CPU time over all three, as Windows counts it in ticks of about 15.6 ms (0.05 ms a request
  // in one burst, 0.017 ms over three); wall-clock the best of each, for the log.
  const on = { cpu: 0, wall: Infinity }
  const off = { cpu: 0, wall: Infinity }
  const add = (into, b) => Object.assign(into, { cpu: into.cpu + b.cpu / 3, wall: Math.min(into.wall, b.wall) })
  for (let round = 0; round < 3; round++) {
    add(on, await burst())
    await inv('settings:update', { sessions: { recordPerformance: false } })
    add(off, await burst())
    await inv('settings:update', { sessions: { recordPerformance: true } })
  }
  console.log(`metrics overhead: Combwork's CPU ${on.cpu.toFixed(3)} ms a request recording, ${off.cpu.toFixed(3)} ms not (3 x 300 each); wall-clock ${on.wall.toFixed(2)} vs ${off.wall.toFixed(2)} ms (best of 3)`)
  check('metrics: recording adds well under a millisecond to a request', on.cpu - off.cpu < 1, `Combwork's CPU ${on.cpu.toFixed(3)} vs ${off.cpu.toFixed(3)} ms`)
  const recorded = (await api('GET', `/v1/metrics?scope=workspace&from=${encodeURIComponent(since)}`)).body
  check('metrics: turned off, nothing was recorded', workspaceCalls(recorded) - callsBefore === 1200, String(workspaceCalls(recorded) - callsBefore))

  // The merge slot (#350): an agent's own launch holds it; replies are a line each.
  console.log('\n--- merge slot')
  const slot = (args) => {
    const r = asCoder('tools/call', { name: 'cw_merge_slot', arguments: { branch: 'main', ...args } })
    return { text: r.content[0].text, isError: !!r.isError }
  }
  check('merge slot: free, in a line', /^Merge slot for main: free\.$/.test(measure('cw_merge_slot (status, free)', slot({ action: 'status' }), 120)), texts['cw_merge_slot (status, free)'])
  check('merge slot: a claim says it is held and for how long', /^You hold the merge slot for main, \d+ min left\. Release it once merged\.$/.test(measure('cw_merge_slot (claim)', slot({ action: 'claim', cards: [7] }), 160)), texts['cw_merge_slot (claim)'])
  check('merge slot: claiming again extends it', /\(extended\)/.test(measure('cw_merge_slot (claim, extend)', slot({ action: 'claim' }), 160)), texts['cw_merge_slot (claim, extend)'])
  check('merge slot: the status names the holder and the cards', /^Merge slot for main: \w+ is merging #7 \(/.test(measure('cw_merge_slot (status, held)', slot({ action: 'status' }), 200)), texts['cw_merge_slot (status, held)'])
  const scriptClaim = tool('cw_merge_slot', { action: 'claim', branch: 'main' })
  check("merge slot: a script can't claim it", scriptClaim.isError && /Only a project's own agents hold its merge slot/.test(scriptClaim.text), scriptClaim.text)
  check('merge slot: released in a line', /^Released the merge slot for main\.$/.test(measure('cw_merge_slot (release)', slot({ action: 'release' }), 120)), texts['cw_merge_slot (release)'])
  check("merge slot: agents have the tool, the Assistant doesn't", !!toolDescription('cw_merge_slot') && !toolDescription('cw_merge_slot', 'assistant'))

  // Connections (HI-1771; last, as a connection on changes how this workspace's agents start): an agent added on one by
  // name, the providers listing those on here, the status with each agent's connection.
  const max = await inv('connections:add', 'claude-code', 'Max')
  await inv('connections:setOn', max.id, true)
  const linked = measure('cw_add_agent (connection)', tool('cw_add_agent', { project: 'beta', name: 'Linked', connection: 'Max' }, 'assistant'), 400)
  check('a new agent on a connection: its line names it', /^Added Linked \(id a-\w+\) to beta: claude-code on Max, in the project folder, stopped\.$/.test(linked), linked)
  // The providers with a connection on here: a line each since HI-2814 (the JSON was about 12,200 characters with OpenCode,
  // a fifth CLI, past the 12,000 HI-2696 had raised it to); the connection named on its provider's line, by name and id.
  const withConnection = measure('cw_list_providers (connections)', tool('cw_list_providers', {}, 'assistant'), 2600)
  check("the connection on here is on its provider's line", /^Claude Code \(claude-code\): .*; connections .*\bMax \(id c-[0-9a-f]+\)/m.test(withConnection), withConnection)
  // beta's status with Linked's connection and each agent's connection fields (about 3,040 characters).
  measure('cw_project_status (connections)', tool('cw_project_status', { project: 'beta' }, 'assistant'), 3500)
  await inv('connections:setOn', max.id, false)

  // A request that began in this workspace and ends after the window opened another: counted nowhere (not the next).
  const nextWs = path.join(lib.WORK, 'replysize-next-ws')
  fs.rmSync(nextWs, { recursive: true, force: true })
  fs.mkdirSync(nextWs, { recursive: true })
  const pendingSock = await new Promise((resolve) => {
    const sock = net.connect(Number(new URL(API).port), '127.0.0.1', () => {
      sock.write(`POST /v1/tasks HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${apiToken}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"title":`)
      setTimeout(() => resolve(sock), 300)
    })
  })
  await inv('session:stop', alpha, coder.id).catch(() => undefined)
  await lib.openWorkspace(inv, page, nextWs)
  pendingSock.destroy()
  await lib.sleep(500)
  const nextReport = await inv('metrics:query', { scope: { kind: 'workspace' } })
  check('metrics: a request that crossed a workspace switch is not recorded in the next workspace', nextReport.workspacePath.toLowerCase() === nextWs.toLowerCase() && !nextReport.workspace.api.some((sr) => sr.outcome === 'cancelled'), JSON.stringify(nextReport.workspace.api))

  const out = path.join(lib.WORK, process.env.REPLYSIZE_OUT || 'replysize.json')
  fs.writeFileSync(out, JSON.stringify(sizes, null, 2))
  fs.writeFileSync(out.replace(/\.json$/, '-texts.json'), JSON.stringify(texts, null, 2))
  console.log(`\nWrote ${out}`)
  await inv('session:stop', alpha, coder.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
