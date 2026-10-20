// Hive's tool replies stay lean: every hive MCP tool (through out/main/hive-mcp.js, as an agent and as the
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

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  // Once (4 Oct 2026) the page closed during a workspace switch, with nothing in Hive's log: say what happened, if again.
  page.on('crash', () => console.log(`PAGE CRASHED ${new Date().toISOString()}`))
  page.on('close', () => console.log(`PAGE CLOSED ${new Date().toISOString()}`))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.on('close', () => console.log(`HIVE WINDOW CLOSING ${new Date().toISOString()}`)))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
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
  const coder = await lib.addAgent(inv, alpha, { name: 'Coder' })
  await lib.addAgent(inv, alpha, { name: 'Tester' })
  await lib.addAgent(inv, path.join(ws, 'beta'), { name: 'Builder' })
  const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
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

  /** One hive tool call through hive-mcp.js: the text the agent gets (role 'assistant+settings': with Change settings on). */
  const tool = (name, args, role = 'agent') => {
    const extra = { HIVE_DEV_CONSOLE: '1', ...(role.startsWith('assistant') ? { HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'projects', HIVE_ASSISTANT_SETTINGS: role === 'assistant+settings' ? '1' : '0', HIVE_JOURNAL: '1', HIVE_API_TOKEN_FILE: asTokenFile, HIVE_API_TOKEN: '', HIVE_PROJECT: '' } : { HIVE_API_TOKEN: apiToken, HIVE_PROJECT: 'alpha', HIVE_AGENT_ID: coder.id }) }
    const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'hive-mcp.js')], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
      env: lib.childEnv({ HIVE_API_URL: API, HIVE_WORKSPACE: ws, ...extra }),
      timeout: 60000
    }).toString()
    const r = JSON.parse(out.split('\n')[0]).result
    return { text: r.content[0].text, isError: !!r.isError }
  }
  /** A tool's description as the agent (or the Assistant) is given it. */
  const toolDescription = (name, role = 'agent') => {
    const extra = { HIVE_DEV_CONSOLE: '1', ...(role.startsWith('assistant') ? { HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'projects', HIVE_JOURNAL: role === 'assistant-nojournal' ? '0' : '1', HIVE_API_TOKEN_FILE: asTokenFile, HIVE_API_TOKEN: '', HIVE_PROJECT: '' } : { HIVE_API_TOKEN: apiToken, HIVE_PROJECT: 'alpha', HIVE_AGENT_ID: coder.id }) }
    const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'hive-mcp.js')], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n',
      env: lib.childEnv({ HIVE_API_URL: API, HIVE_WORKSPACE: ws, ...extra }),
      timeout: 60000
    }).toString()
    return JSON.parse(out.split('\n')[0]).result.tools.find((t) => t.name === name)?.description ?? ''
  }
  const sizes = {}
  const texts = {}
  /** Records a reply's size; with `max`, checks it worked and stays within it. */
  const measure = (label, r, max) => {
    const text = typeof r === 'string' ? r : r.text
    sizes[label] = text.length
    texts[label] = text
    console.log(`${String(text.length).padStart(8)}  ${label}${r.isError ? `  (error: ${text.slice(0, 120)})` : ''}`)
    if (max !== undefined) check(`${label}: at most ${max.toLocaleString('en')} characters`, !r.isError && text.length <= max, `${text.length}: ${text.slice(0, 200)}`)
    return text
  }
  const todo = numbers.slice(0, 50)
  const target = numbers[3]

  console.log('\n--- hive tools (as an agent)')
  const projects = measure('hive_list_projects', tool('hive_list_projects', {}), 1000)
  check('projects: a line each, with their agents', /^alpha \(on, \w+\): Coder \[claude-code\] idle; Tester \[claude-code\] stopped$/m.test(projects), projects)
  measure('hive_project_status', tool('hive_project_status', {}), 3000)
  const usage = measure('hive_session_usage', tool('hive_session_usage', {}), 1500)
  check('usage leaves out its days unless asked', !usage.includes('"days"') && tool('hive_session_usage', { days: true }).text.includes('"days"'))
  const notes = measure('hive_list_shared_notes', tool('hive_list_shared_notes', {}), 1500)
  check('notes: one path a line', /^notes\/note-1\.md \(\d{4}-\d\d-\d\d\)$/m.test(notes), notes)
  const note = measure('hive_read_shared_note', tool('hive_read_shared_note', { path: 'notes/note-1.md' }))
  check('a note reads as its text, with its revision', /^notes\/note-1\.md \(revision [0-9a-f]{12}\)\n\n## Why\n/.test(note), note.slice(0, 80))
  // Documents by section (#817): a long plan (~70k characters: 8 parts of 5 sections), as a shared note and a project file.
  const longDoc = `# Long plan\n\n${Array.from({ length: 8 }, (_, p) => `## Part ${p + 1}\n\n${Array.from({ length: 5 }, (__, s) => `### Section ${p + 1}.${s + 1}\n\n${prose(600 + p * 5 + s, 1700).replaceAll('## ', '')}\n`).join('\n')}`).join('\n')}`
  await api('PUT', `/v1/shared/file?path=${encodeURIComponent('plans/long.md')}`, { content: longDoc })
  fs.mkdirSync(path.join(alpha, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(alpha, 'docs', 'LONG.md'), longDoc)
  const outlined = measure('hive_doc_outline', tool('hive_doc_outline', { path: 'shared:plans/long.md' }), 3000)
  check('an outline: a line per heading with its slug and size', outlined.includes('\n    ### Section 3.2 [section-32] 1.') && outlined.length < longDoc.length / 20, outlined.slice(0, 300))
  measure('hive_doc_outline (project file, depth 2)', tool('hive_doc_outline', { path: 'docs/LONG.md', depth: 2 }), 800)
  const sectionRead = measure('hive_read_section', tool('hive_read_section', { path: 'docs/LONG.md', heading: 'section-32' }), 2200)
  check('a section: its own text only', sectionRead.startsWith('docs/LONG.md#section-32 (') && !sectionRead.includes('### Section 3.3'), sectionRead.slice(0, 200))
  const partial = measure('hive_read_section (long: its subsections)', tool('hive_read_section', { path: 'shared:plans/long.md', heading: 'Long plan' }), 1500)
  check('a section over 30,000 characters: its outline instead', partial.includes('## Part 8 [part-8]') && partial.endsWith('or this whole section with full=true.'), partial.slice(0, 300))
  const unknown = tool('hive_read_section', { path: 'docs/LONG.md', heading: 'part nine' })
  measure('hive_read_section (unknown)', unknown)
  check('an unknown section: an error naming the closest, short', unknown.isError && unknown.text.includes('Closest: ') && unknown.text.length <= 400, unknown.text)
  check('writing a note confirms it', /^Wrote notes\/new\.md \([\d,]+ characters, revision [0-9a-f]{12}\)\.$/.test(measure('hive_write_shared_note', tool('hive_write_shared_note', { path: 'notes/new.md', content: prose(300, 2500) }), 200)), texts.hive_write_shared_note)
  const written = texts.hive_write_shared_note.match(/revision ([0-9a-f]{12})/)?.[1]
  measure('hive_write_shared_note (append)', tool('hive_write_shared_note', { path: 'notes/new.md', content: prose(301, 500), append: true }), 200)
  // A rewrite naming the revision before that append is refused, with the current one.
  const stale = tool('hive_write_shared_note', { path: 'notes/new.md', content: 'lost?', expectedRevision: written })
  measure('hive_write_shared_note (conflict)', stale)
  check('a stale revision is refused with the current one, in a few lines', stale.isError && /expectedRevision [0-9a-f]{12}/.test(stale.text) && stale.text.length <= 300, stale.text)
  // A revision given but empty or not a string is refused, never taken as "unguarded" (only leaving it out is).
  const noteNow = async () => (await api('GET', '/v1/shared/file?path=notes%2Fnew.md')).body
  const noteBefore = await noteNow()
  const bad = []
  for (const v of ['', false, 0, null]) {
    const r = tool('hive_write_shared_note', { path: 'notes/new.md', content: 'unguarded?', expectedRevision: v })
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
  measure('hive_read_latest_handover', tool('hive_read_latest_handover', {}))
  check('a handover is saved and named', /^Handover saved as handovers\/.+\.md\.$/.test(measure('hive_create_handover', tool('hive_create_handover', { title: 'Measured', content: prose(400, 3500) }), 300)), texts.hive_create_handover)
  measure('hive_notify', tool('hive_notify', { title: 'Hello', message: 'Measuring' }), 100)
  // The Assistant's inbox (#647; these calls use the workspace token, not an agent's): nothing new; an ack of an id that isn't its own says so, and nothing about it.
  check('the inbox with nothing new says so', measure('hive_inbox', tool('hive_inbox', {}, 'assistant'), 200) === 'Nothing new.', texts.hive_inbox)
  check("an ack of an id that isn't its own", measure('hive_inbox (ack)', tool('hive_inbox', { ack: ['m99'] }, 'assistant'), 100) === 'Nothing acked. Not in your inbox: m99.', texts['hive_inbox (ack)'])
  // A card's line: its key with its number (#1219: "AL-12 (#77) …"), or its number for a card with no key.
  const CARD = '([A-Z]{2,4}-\\d+ \\(#\\d+\\)|#\\d+)'
  const isCardLine = (l) => new RegExp(`^${CARD} `).test(l)
  const all = measure('hive_list_tasks (all)', tool('hive_list_tasks', {}), 76 * 200)
  check('the board: a line a card, no descriptions', all.split('\n').filter(isCardLine).length === 76 && !all.includes('## Why'), all.slice(0, 300))
  const todoList = measure('hive_list_tasks (todo)', tool('hive_list_tasks', { column: 'todo' }), 50 * 200)
  check('Todo is listed top first', todoList.startsWith('Todo (50, top first):\n') && isCardLine(todoList.split('\n')[1]), todoList.slice(0, 80))
  measure('hive_list_tasks (alpha)', tool('hive_list_tasks', { project: 'alpha' }), 25 * 200)
  const full = tool('hive_list_tasks', { column: 'review', details: true }).text
  check('details=true still lists cards in full', JSON.parse(full).length === 10 && JSON.parse(full)[0].description.length > 1000)
  const read = JSON.parse(measure('hive_read_task', tool('hive_read_task', { number: target })))
  check('a read has the description and comments, not the history', read.description.length > 1000 && read.comments.length === 3 && !('history' in read) && read.historyEntries >= 1, Object.keys(read).join(','))
  check('history=true adds it', JSON.parse(tool('hive_read_task', { number: target, history: true }).text).history.length >= 1)
  const latest = JSON.parse(measure('hive_read_task (latestComment)', tool('hive_read_task', { number: target, latestComment: true }), 1500))
  check('latestComment=true: the newest comment only', latest.number === target && latest.comment?.text === read.comments.at(-1).text && JSON.stringify(Object.keys(latest)) === '["number","comment"]', JSON.stringify(latest).slice(0, 200))
  // Summaries (#532): each comment as its first line, with the whole comment's length when there is more.
  const summary = JSON.parse(measure('hive_read_task (latestComment, summary)', tool('hive_read_task', { number: target, latestComment: true, summary: true }), 500))
  const fullLatest = read.comments.at(-1).text
  check('summary=true: the latest comment as its first line, with its whole length', summary.comment?.text === fullLatest.split('\n').map((l) => l.trim()).find(Boolean).slice(0, 300) && (summary.comment.text === fullLatest.trim() || summary.comment.length === fullLatest.length), JSON.stringify(summary).slice(0, 300))
  const allSummary = JSON.parse(tool('hive_read_task', { number: target, summary: true }).text)
  check('…and every comment of a card read with it', allSummary.comments.length === read.comments.length && allSummary.comments.every((x, i) => x.text.length <= 300 && read.comments[i].text.includes(x.text.replace(/…$/, '').slice(0, 20))), JSON.stringify(allSummary.comments).slice(0, 300))
  const created = measure('hive_create_task', tool('hive_create_task', { title: 'Measured card', description: prose(500, 1800), labels: ['bug'] }), 400)
  check('a new card: its key, number and place', new RegExp(`^${CARD} created in Todo \\(51st of 51\\) for alpha: Measured card$`).test(created) && /^[A-Z]{2,4}-\d+ /.test(created), created)
  const commented = measure('hive_update_task (comment)', tool('hive_update_task', { number: target, comment: 'Looked at it.' }), 400)
  check('a comment is confirmed with where the card is', new RegExp(`^([A-Z]{2,4}-\\d+ \\(#${target}\\)|#${target}) .+: Commented\\. Now in Todo \\(\\d+\\w\\w of 51\\), \\w+\\.$`).test(commented), commented)
  const top = measure('hive_update_task (to top)', tool('hive_update_task', { number: target, position: 'top' }), 400)
  check('a move says where to', /: Moved to the top of Todo\. Now in Todo \(1st of 51\), \w+\.$/.test(top), top)
  const review = measure('hive_update_task (to review)', tool('hive_update_task', { number: target, column: 'review', comment: 'Done: see the branch.' }), 400)
  check('a move to Review and a comment, both said', /: Moved to Review; Commented\. Now in Review \(11th of 11\)/.test(review), review)
  const reordered = measure('hive_reorder_tasks (3 cards)', tool('hive_reorder_tasks', { column: 'todo', cards: [todo[10], todo[5], todo[7]] }), 300)
  check('a reorder confirms the new top, its cards by key (#1219)', lib.unkey(reordered) === `Todo now starts #${todo[10]}, #${todo[5]}, #${todo[7]}; its other 47 cards keep their order below.` && lib.KEYED.test(reordered), reordered)
  const batched = measure('hive_update_tasks (3 cards)', tool('hive_update_tasks', { numbers: [todo[20], todo[21], todo[22]], labels: ['perf'] }), 400)
  const batchLines = batched.split('\n')
  check('a batch confirms each card and its change', batchLines[0] === '3 cards changed:' && batchLines.length === 4 && batchLines.slice(1).every((l) => /^([A-Z]{2,4}-\d+ \(#\d+\)|#\d+) .+: Labels: perf\. Now in Todo \(\d+\w+ of \d+\)(, [^,]+)?\.$/.test(l)), batched)
  // #1131: tagging says only the label added, not each card's labels.
  const tagged = measure('hive_update_tasks (3 cards, addLabels)', tool('hive_update_tasks', { numbers: [todo[20], todo[21], todo[22]], addLabels: ['0.9.4'] }), 400)
  const tagLines = tagged.split('\n')
  check('tagging says only the label added', tagLines[0] === '3 cards changed:' && tagLines.length === 4 && tagLines.slice(1).every((l) => /^([A-Z]{2,4}-\d+ \(#\d+\)|#\d+) .+: Labels: added 0\.9\.4\. Now in Todo \(\d+\w+ of \d+\)(, [^,]+)?\.$/.test(l)), tagged)
  // Lanes (#483): a start, a join (a lane made for a builder that hasn't registered yet), the listing and an end.
  const laneStarted = measure('hive_lane (start)', tool('hive_lane', { action: 'start', cards: [todo[0], todo[1], todo[2]], reviewer: 'Tester', rounds: 10, waitMinutes: 360, name: 'measured lane' }), 400)
  check('a lane start: its pair, state, cards and id', /^Lane started: Coder \/ Tester \(alpha\) measured lane: active, on #\d+; .+; rounds 10, wait 6 h\. lane-[0-9a-f]+$/.test(laneStarted), laneStarted)
  const laneId = laneStarted.match(/lane-[0-9a-f]+$/)?.[0]
  measure('hive_lane (join)', tool('hive_lane', { action: 'join', builder: 'Tester', cards: [todo[3]] }), 400)
  const laneList = measure('hive_lane (list)', tool('hive_lane', { action: 'list' }), 600)
  check('lanes listed a line each', laneList.split('\n').length === 2 && laneList.includes(laneId), laneList)
  check('a lane ended', measure('hive_lane (end)', tool('hive_lane', { action: 'end', lane: laneId, abandoned: true }), 400).startsWith('Lane abandoned: '), texts['hive_lane (end)'])
  const skillList = measure('hive_list_skills', tool('hive_list_skills', {}), 4000)
  check('skills: a line each, who they are for, no folders', /^work-on-card \(Hive, for agents\): /m.test(skillList) && !skillList.includes(ws), skillList.slice(0, 300))
  // Who each listing is about: an agent's lists what its project's agents get (not the Assistant's skills); the
  // Assistant's lists them all with who gets each, and with a project what that project's agents get.
  for (const [name, audience] of [['for-assistant', 'assistant'], ['for-both', 'all'], ['for-default', null]]) {
    fs.mkdirSync(path.join(ws, '.hive', 'skills', name), { recursive: true })
    fs.writeFileSync(path.join(ws, '.hive', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill.\n${audience ? `metadata:\n  audience: ${audience}\n` : ''}---\n`)
  }
  const has = (list, re) => new RegExp(re, 'm').test(list)
  const agentSkills = tool('hive_list_skills', {}).text
  check("skills (agent): its project's agents' skills, without the Assistant's", has(agentSkills, '^for-default \\(Hive, for agents\\)') && has(agentSkills, '^for-both \\(Hive, for agents and the Assistant\\)') && !has(agentSkills, '^for-assistant ') && !has(agentSkills, '^coordinate-agents '), agentSkills.slice(0, 400))
  const allSkills = tool('hive_list_skills', {}, 'assistant').text
  check("skills (Assistant): every Hive skill with who gets it", has(allSkills, '^for-assistant \\(Hive, for the Assistant\\)') && has(allSkills, '^coordinate-agents \\(Hive, for the Assistant\\)') && has(allSkills, '^for-both \\(Hive, for agents and the Assistant\\)') && has(allSkills, '^for-default \\(Hive, for agents\\)'), allSkills.slice(0, 400))
  const projectSkills = tool('hive_list_skills', { project: 'alpha' }, 'assistant').text
  check("skills (Assistant, a project): what that project's agents get", !has(projectSkills, '^for-assistant ') && has(projectSkills, '^for-both ') && has(projectSkills, '^for-default '), projectSkills.slice(0, 400))
  check('skills: the descriptions say a listing, not what a session loaded', /not of what a running session loaded/.test(toolDescription('hive_list_skills')) && /for agents \(not those for the Assistant alone\)/.test(toolDescription('hive_list_skills')) && /user and plugin skills/.test(toolDescription('hive_list_skills', 'assistant')))
  for (const name of ['for-assistant', 'for-both', 'for-default']) fs.rmSync(path.join(ws, '.hive', 'skills', name), { recursive: true, force: true })
  // A long card's latest feedback without its whole thread; the board a page at a time.
  const newest = JSON.parse(measure('hive_read_task (comments: 2)', tool('hive_read_task', { number: target, comments: 2 })))
  check('comments=2: the description and the newest two, with a count of the rest', newest.description.length > 1000 && newest.comments.length === 2 && newest.commentsOmitted === read.comments.length + 2 - 2 && newest.comments.at(-1).text === 'Done: see the branch.', JSON.stringify({ n: newest.comments?.length, omitted: newest.commentsOmitted }))
  // Waiting on cards: lean replies (a bounded wait with nothing new; a column already reached; a watch begun and
  // cancelled, as the Assistant: a script has nobody to wake).
  const waited = measure('hive_wait_for_tasks (no change)', tool('hive_wait_for_tasks', { cards: [target], timeoutSeconds: 1 }), 300)
  check('a wait with no change: no change, with its since', /^No change\.\nsince: @[0-9a-z]+;/.test(waited), waited)
  const met = measure('hive_wait_for_tasks (already in the column)', tool('hive_wait_for_tasks', { cards: [target], column: 'review' }), 400)
  check('a column already reached answers at once', met.startsWith(`#${target} is in Review (column`), met)
  const watchingNow = measure('hive_wait_for_tasks (wake)', tool('hive_wait_for_tasks', { cards: [todo[0]], wake: true }, 'assistant'), 300)
  check('a watch begun: what it waits for, and to end the turn', lib.unkey(watchingNow).startsWith(`Waiting for #${todo[0]}. End your turn now`), watchingNow)
  check('cancel ends it', measure('hive_wait_for_tasks (cancel)', tool('hive_wait_for_tasks', { cancel: true }, 'assistant'), 100) === 'Cancelled your card watch.', texts['hive_wait_for_tasks (cancel)'])
  const page2 = measure('hive_list_tasks (offset 70)', tool('hive_list_tasks', { offset: 70 }), 10 * 200)
  check('offset carries on where a page stopped', /^Cards 71–\d+ of \d+\.$/m.test(page2) && page2.split('\n').filter(isCardLine).length === all.split('\n').filter(isCardLine).length + 1 - 70, page2.slice(0, 200))

  // The developer console (#636; offered while Settings → Agent API lets agents read it): with no console open a read
  // starts nothing and says so; with the window watching Coder, a turn reads as a line an event (its prompt hidden), one
  // event in full, the sources (a page at a time) and Hive's events as the Assistant.
  const consoleClosed = measure('hive_console (no console open)', tool('hive_console', { agent: 'Coder' }), 300)
  check('with no console open a read says nothing is captured', consoleClosed.startsWith("alpha · Coder: not captured: the developer console isn't open on it"), consoleClosed)
  const coderSource = (await inv('console:sources')).find((s) => s.agentId === coder.id)
  await inv('console:subscribe', [coderSource.id])
  await lib.sendPrompt(inv, lib.ptyKey(alpha, coder.id), 'turn 5 console', { submitted: async () => String(await inv('pty:buffer', lib.ptyKey(alpha, coder.id))).includes('Done: turn 5 console') })
  const consoleTurn = await until(async () => {
    const t = tool('hive_console', { agent: 'Coder' }).text
    return /hook Stop → stop/.test(t) ? t : null
  }, HUNG_MS)
  measure('hive_console (a turn)', consoleTurn ?? '', 2500)
  check('a turn: a line an event, its prompt hidden', /^#\d+ \d\d:\d\d:\d\d hook UserPromptSubmit → prompt; working/m.test(consoleTurn ?? '') && !(consoleTurn ?? '').includes('turn 5 console'), consoleTurn)
  const promptSeq = Number(/^#(\d+) .*UserPromptSubmit/m.exec(consoleTurn ?? '')?.[1])
  const consoleOne = measure('hive_console (an event in full)', tool('hive_console', { agent: 'Coder', seq: [promptSeq] }), 3000)
  check('…one in full: the raw hook and what Hive made of it, its prompt still hidden', consoleOne.includes('"raw"') && consoleOne.includes('"made"') && /"prompt":"<text: \d+ chars>"/.test(consoleOne), consoleOne)
  const consoleList = measure('hive_console (sources, as the Assistant)', tool('hive_console', { action: 'sources' }, 'assistant'), 1200)
  check('the sources: a line each, with how to name it', /^alpha · Coder \(claude-code\): captured, \d+ events \[agent="a-[\w-]+" project="alpha"\]$/m.test(consoleList) && /^Hive: not captured \[source="hive"\]$/m.test(consoleList), consoleList)
  // On a connection of its own (agent: false): after the slow tool calls above, fetch's kept-alive socket can be the one
  // Hive's server is closing for idleness, which reset this request once under load.
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
  measure("hive_console (Hive's events, as the Assistant)", tool('hive_console', { source: 'hive' }, 'assistant'), 300)
  await inv('console:subscribe', [])

  console.log('\n--- hive tools (as the Assistant)')
  measure('hive_list_providers', tool('hive_list_providers', {}, 'assistant'))
  // Hive's settings (#186): a listing (all, narrowed, a project's), one in full, and a change with Change settings on.
  // A line a setting (about 85 characters with its title): 6,200 since #418 added Tell the Assistant when I reply to an agent;
  // 7,000 since #450 added GitHub Copilot, a third provider with its own settings (about 730 characters); 7,200 since #412
  // added the workspace's Card loop rounds and wait (about 100 characters); 7,400 since #636 added Let agents read the
  // developer console (about 70 characters); 7,500 since #767 added Language (about 30 characters); 7,800 since #975
  // added Default view, #984 Resume agents after an unexpected close (about 85 characters each) and #976 Tile order
  // (about 40 characters).
  const settingsList = measure('hive_list_settings', tool('hive_list_settings', {}, 'assistant'), 7800)
  check('settings: a line each, id = value, read-only ones marked', /^sessions\.compactSuggestTokens = 200000 · Suggest compacting above$/m.test(settingsList) && /^agentApi\.port = \d+ \[read-only\] · /m.test(settingsList) && /^advanced\.showDeveloperFeatures = off · /m.test(settingsList) && !/^advanced\.(logs|data|reset) /m.test(settingsList), settingsList.slice(0, 300))
  const compactList = measure('hive_list_settings (query)', tool('hive_list_settings', { query: 'compact' }, 'assistant'), 1500)
  check('query narrows it, saying what each does', compactList.split('\n').length < 10 && /^assistant\.compactSuggestTokens = 500000 · Highlight Compact over: Context size/m.test(compactList), compactList)
  const projectList = measure('hive_list_settings (a project)', tool('hive_list_settings', { project: 'alpha', scope: 'project' }, 'assistant'), 3000)
  check("a project's own settings, inheriting", /^project\.transcriptWarnMB = inherit · Warn when a transcript is over$/m.test(projectList), projectList.slice(0, 300))
  const one = measure('hive_read_setting', tool('hive_read_setting', { id: 'sessions.transcriptWarnMB' }, 'assistant'), 1500)
  check('a setting in full: where, what it takes, when it helps', one.includes('Where: Settings → Sessions → Warn when a transcript is over.') && /When it helps: /.test(one), one)
  // An unknown tool is a JSON-RPC error (no result at all).
  const offered = (() => {
    try {
      return !tool('hive_update_setting', { id: 'sessions.transcriptWarnMB', value: 50 }, 'assistant').isError
    } catch {
      return false
    }
  })()
  check("no change while Change settings is off: the tool isn't offered", !offered && !toolDescription('hive_update_setting', 'assistant') && (await inv('settings:get')).sessions.transcriptWarnMB === 20)
  await inv('settings:update', { assistant: { changeSettings: true } })
  const changed = measure('hive_update_setting', tool('hive_update_setting', { id: 'sessions.transcriptWarnMB', value: 50 }, 'assistant+settings'), 400)
  check('a change: old → new, and that the user can revert it', changed.startsWith('Changed Settings → Sessions → Warn when a transcript is over (sessions.transcriptWarnMB): 20 → 50. It applies now.'), changed)
  // A table keeping its size: the reply says what changed in it, not "nothing changed".
  const recolour = measure('hive_update_setting (a table)', tool('hive_update_setting', { id: 'board.colors', value: { doing: '#ff0000' } }, 'assistant+settings'), 400)
  check('a table change says which entry changed, old → new', /^Changed Settings → Board → Column colours \(board\.colors\): doing: #[0-9a-f]{6} → doing: #ff0000\./.test(recolour), recolour)
  await inv('settings:update', { board: { colors: { doing: '#3b82f6' } } })
  const badEffort = tool('hive_update_setting', { id: 'claude-code.defaultEffort', value: 'bananas' }, 'assistant+settings')
  check("an effort level the picker doesn't offer is refused, naming those it does", badEffort.isError && /takes one of: /.test(badEffort.text) && (await inv('settings:get')).providers['claude-code'].defaultEffort === '', badEffort.text)
  await inv('settings:update', { assistant: { providers: { 'claude-code': { model: 'opus' } } } })
  const ownModel = tool('hive_read_setting', { id: 'assistant.claude-code.model' }, 'assistant').text
  check("the Assistant's own model reads as it is, and is the user's", /\(assistant\.claude-code\.model\): opus \(default \(empty\)\)/.test(ownModel) && /Read-only to you: /.test(ownModel), ownModel)
  await inv('settings:update', { assistant: { providers: { 'claude-code': { model: '' } } } })
  const colours = measure('hive_read_setting (a table)', tool('hive_read_setting', { id: 'board.colors' }, 'assistant'), 1500)
  check('a table reads as its values', /: \{"hold":"#[0-9a-f]{6}",.*"done":"#[0-9a-f]{6}"\}/.test(colours), colours)
  const refusedOwn = tool('hive_update_setting', { id: 'assistant.control', value: 'projects' }, 'assistant+settings')
  check('its own Control is refused, saying where the user changes it', refusedOwn.isError && /Settings → Assistant → Control/.test(refusedOwn.text), refusedOwn.text)
  await inv('settings:update', { sessions: { transcriptWarnMB: 20 }, assistant: { changeSettings: false } })

  // The Assistant's journal (#1031): its tools only while it is on, for the Assistant; a recall is a line an entry, at
  // most ten by default, and an entry in full only on request.
  check("the journal's tools are the Assistant's, offered while it is on", !!toolDescription('hive_journal_recall', 'assistant') && !toolDescription('hive_journal_recall') && !toolDescription('hive_journal_recall', 'assistant-nojournal'))
  await inv('journal:set', { scope: ['decision', 'plan', 'event', 'incident', 'insight'] })
  for (let i = 0; i < 30; i++) tool('hive_journal_write', { kind: i % 2 ? 'decision' : 'insight', summary: `Entry ${i}: ${prose(i, 400).split('\n')[1].slice(0, 140)}`, detail: prose(300 + i, 2500), why: prose(400 + i, 300).split('\n')[1].slice(0, 200), project: PROJECTS[i % 4], links: [{ type: 'card', ref: String(numbers[i]) }], tags: ['seed'] }, 'assistant')
  const entryWritten = measure('hive_journal_write', tool('hive_journal_write', { kind: 'plan', summary: 'Measure the journal replies', why: 'Each reply stays small' }, 'assistant'), 60)
  const recalled = measure('hive_journal_recall', tool('hive_journal_recall', {}, 'assistant'), 2400)
  check('a recall gives ten one-line rows, the newest first', recalled.split('\n').length === 10 && /^#\d+ \d{4}-\d\d-\d\d plan: Measure the journal replies/.test(recalled), recalled)
  measure('hive_journal_recall (query)', tool('hive_journal_recall', { query: 'settings window reloads', limit: 10 }, 'assistant'), 2400)
  const firstId = Number(/^#(\d+)/.exec(recalled.split('\n').at(-1))[1])
  measure('hive_journal_entry', tool('hive_journal_entry', { id: firstId }, 'assistant'), 3500)
  measure('hive_journal_update', tool('hive_journal_update', { id: firstId, importance: 2 }, 'assistant'), 60)
  check('…written and changed are a line each', /^Entry #\d+ written\.$/.test(entryWritten) && tool('hive_journal_update', { id: firstId, addTags: ['kept'] }, 'assistant').text === `Entry #${firstId} updated.`)
  const outOfScope = tool('hive_journal_write', { kind: 'moment', summary: 'A nice moment' }, 'assistant')
  check("a kind the user's scope leaves out is refused, saying what is allowed", outOfScope.isError && /scope doesn't include moment entries .*allows: decision, plan, event, incident, insight/.test(outOfScope.text), outOfScope.text)
  await inv('journal:set', { enabled: false })
  const whileOff = tool('hive_journal_recall', {}, 'assistant')
  check('turned off meanwhile, a call is refused, saying the entries are kept', whileOff.isError && /journal is off .*entries are kept/.test(whileOff.text), whileOff.text)
  await inv('journal:set', { enabled: true })
  check('on again, every entry is there', tool('hive_journal_recall', { limit: 50 }, 'assistant').text.split('\n').length >= 31)
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
  const activity = JSON.parse(measure('hive_agent_activity', tool('hive_agent_activity', { project: 'alpha', agent: 'Coder' }, 'assistant'), 1800))
  const detail = JSON.parse(measure('hive_agent_activity (detail)', tool('hive_agent_activity', { project: 'alpha', agent: 'Coder', detail: true }, 'assistant'), 8500))
  const shortOk = activity.toolCalls === 12 && activity.recentTools.length === 3 && activity.currentTask.length <= 301 && activity.latestReply.length <= 501 && activity.recentTools.every((t) => t.summary.length <= 101)
  check('activity: the short form is clipped as described (300, 500, last 3 calls at 100)', shortOk, JSON.stringify({ calls: activity.toolCalls, tools: activity.recentTools?.length, task: activity.currentTask?.length, reply: activity.latestReply?.length }))
  const detailOk = detail.toolCalls === 12 && detail.recentTools.length === 10 && detail.currentTask.length <= 2001 && detail.latestReply.length <= 3001 && detail.recentTools.every((t) => t.summary.length <= 201) && detail.recentTools.some((t) => t.summary.length > 101)
  check('activity: detail is bounded as described (2000, 3000, last 10 of 12 calls at 200), not "in full"', detailOk, JSON.stringify({ calls: detail.toolCalls, tools: detail.recentTools?.length, task: detail.currentTask?.length, reply: detail.latestReply?.length }))
  check('activity: says what was cut, by its whole length', activity.clipped?.currentTask === longTask.length && activity.clipped?.latestReply === longReply.length && detail.clipped?.currentTask === longTask.length && detail.clipped?.latestReply === longReply.length, JSON.stringify([activity.clipped, detail.clipped]))
  check('activity: the tool says the same bounds', /2000, 3000 and the last 10 calls/.test(toolDescription('hive_agent_activity', 'assistant')) && !/in full/.test(toolDescription('hive_agent_activity', 'assistant')))
  measure('hive_wait_for_agents', tool('hive_wait_for_agents', { agents: [{ project: 'alpha', agent: 'Coder' }], timeoutSeconds: 5 }, 'assistant'), 1000)
  // An agent watch (#416): an agent not working is the answer at once, in a line; cancel says what it ended.
  const agentAlready = measure('hive_wait_for_agents (wake, not working)', tool('hive_wait_for_agents', { agents: [{ project: 'alpha', agent: 'Coder' }], wake: true }, 'assistant'), 300)
  check('an agent watch on an agent not working: already, with its state', agentAlready.startsWith('Already: Coder (alpha) is '), agentAlready)
  check('cancel with no watch says so', measure('hive_wait_for_agents (cancel)', tool('hive_wait_for_agents', { cancel: true }, 'assistant'), 100) === 'You had no watch.', texts['hive_wait_for_agents (cancel)'])
  // A lane watch (#531): begun, saying what it counts; cancelled.
  const laneWatch = measure('hive_wait_for_tasks (lanes, wake)', tool('hive_wait_for_tasks', { lanes: ['all'], wake: true }, 'assistant'), 300)
  check('a lane watch begun (default events, not repeated): to end the turn', laneWatch.startsWith('Waiting on all running lanes. End your turn now: Hive types a line into this session on a lane event'), laneWatch)
  check('…cancelled', measure('hive_wait_for_tasks (lanes, cancel)', tool('hive_wait_for_tasks', { cancel: true }, 'assistant'), 100) === 'Cancelled your lane watch.', texts['hive_wait_for_tasks (lanes, cancel)'])
  check('activating a project confirms it', measure('hive_activate_project', tool('hive_activate_project', { project: 'gamma' }, 'assistant'), 300) === 'gamma is on.')
  measure('hive_create_project', tool('hive_create_project', { name: 'epsilon' }, 'assistant'), 300)
  const added = measure('hive_add_agent', tool('hive_add_agent', { project: 'beta', name: 'Helper' }, 'assistant'), 400)
  check('a new agent: its name, id and folder', /^Added Helper \(id a-\w+\) to beta: claude-code, in the project folder, stopped\.$/.test(added), added)
  measure('hive_update_agent', tool('hive_update_agent', { project: 'beta', agent: 'Helper', effort: 'high' }, 'assistant'), 1000)
  const started = measure('hive_start_agent', tool('hive_start_agent', { project: 'beta', agent: 'Helper' }, 'assistant'), 400)
  check('a start: its status and session', /^Started Helper in beta: \w+, session [\w-]+\. Follow it with hive_wait_for_agents\.$/.test(started), started)
  const helper = async () => live(path.join(ws, 'beta'), (await inv('workspace:refresh')).projects.find((p) => p.name === 'beta').agents.find((a) => a.name === 'Helper').id)
  check('Helper is ready', !!(await until(async () => (await helper())?.status === 'ready', HUNG_MS)), (await helper())?.status)
  measure('hive_prompt_agent', tool('hive_prompt_agent', { project: 'beta', agent: 'Helper', text: 'turn 1' }, 'assistant'), 300)
  // Its turn over before the message, which is then told at once (#724: a 15 s wait ran out unchecked under load, and
  // the message was queued for a working agent).
  check("Helper's turn is over", !!(await until(async () => (await helper())?.status === 'finished', HUNG_MS)), (await helper())?.status)
  const msg = measure('hive_message_agent', tool('hive_message_agent', { project: 'beta', agent: 'Helper', text: 'turn 2' }, 'assistant'), 200)
  check('a message to an idle agent is told at once, with its id', /^Told Helper now \(m\d+\): it reads it with hive_inbox\.$/.test(msg), msg)
  // Until Helper reads it, a told message can still be cancelled (#650): nothing waits once it is received (#681).
  await lib.until(() => ['received', 'acked'].includes(JSON.parse(tool('hive_agent_activity', { project: 'beta', agent: 'Helper' }, 'assistant').text).inbox?.deliveries?.at(-1)?.state), HUNG_MS)
  check('cancel with nothing waiting says so', measure('hive_message_agent (cancel)', tool('hive_message_agent', { project: 'beta', agent: 'Helper', cancel: true }, 'assistant'), 100) === 'No message was waiting for Helper.', texts['hive_message_agent (cancel)'])
  // Its turn for the message over: stopping a working agent would ask the user.
  check("…and its turn for the message is over", !!(await until(async () => (await helper())?.status === 'finished', HUNG_MS)), (await helper())?.status)
  measure('hive_stop_agent', tool('hive_stop_agent', { project: 'beta', agent: 'Helper' }, 'assistant'), 300)
  const startedCard = measure('hive_start_task', tool('hive_start_task', { number: todo[20], name: 'Starter' }, 'assistant'), 600)
  check('a started card: who has it', new RegExp(`^Started #${todo[20]} .+ on a new agent, Starter in \\w+; the card is in Doing\\.`).test(lib.unkey(startedCard)), startedCard)
  measure('hive_list_tasks (as Assistant, all)', tool('hive_list_tasks', {}, 'assistant'), 80 * 200)
  measure('hive_create_task (as Assistant)', tool('hive_create_task', { title: 'Assistant card', project: 'alpha', description: prose(600, 1800) }, 'assistant'), 400)
  measure('hive_update_task (as Assistant)', tool('hive_update_task', { number: todo[30], comment: 'Noted.' }, 'assistant'), 400)
  measure('hive_reorder_tasks (as Assistant)', tool('hive_reorder_tasks', { column: 'todo', cards: [todo[31], todo[32]] }, 'assistant'), 300)

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
  const bulky = path.join(ws, '.hive', 'skills', 'bulky')
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
  check("the API's own reference, from the running Hive", doc?.content?.startsWith('# Hive Agent API') && doc.api === status.api.version, JSON.stringify(doc).slice(0, 120))
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
  check('API: GET /v1/tasks still gives whole cards', apiList.length === 50 && typeof apiList[0].description === 'string' && Array.isArray(apiList[0].history))
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
  const launch = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).reverse().find((l) => l.env?.HIVE_API_TOKEN && l.cwd.toLowerCase() === alpha.toLowerCase())
  const coderToken = launch?.env?.HIVE_API_TOKEN
  check("metrics: the agent's own token is known", !!coderToken)
  const asCoder = (method, request) =>
    JSON.parse(execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'hive-mcp.js')], { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: request }) + '\n', env: lib.childEnv({ HIVE_API_URL: API, HIVE_WORKSPACE: ws, HIVE_API_TOKEN: coderToken, HIVE_API_TOKEN_FILE: '', HIVE_PROJECT: 'alpha', HIVE_AGENT_ID: coder.id }), timeout: 60000 }).toString().split('\n')[0]).result
  const unicode = (await api('POST', '/v1/tasks', { title: 'Ünïcödé 日本語 🐝 "quoted" \\ back', project: 'alpha', description: 'Ελληνικά — ✓ — \n new line' })).body.number
  const expected = {}
  for (const [name, args] of [['hive_list_tasks', {}], ['hive_list_tasks', { details: true }], ['hive_read_task', { number: unicode }], ['hive_read_task', { number: 999999 }]]) {
    const r = asCoder('tools/call', { name, arguments: args })
    const text = r.content[0].text
    const key = `${name} ${args.details ? 'detail' : 'compact'} ${r.isError ? 'error' : 'ok'}`
    const e = (expected[key] ??= { count: 0, chars: 0, bytes: 0 })
    e.count++
    e.chars += text.length
    e.bytes += Buffer.byteLength(text, 'utf8')
  }
  const list = asCoder('tools/list', {}).tools
  check('metrics: a Unicode reply has more bytes than characters', expected['hive_read_task compact ok'].bytes > expected['hive_read_task compact ok'].chars)
  await lib.sleep(500)
  const report = (await api('GET', `/v1/metrics?scope=workspace&from=${encodeURIComponent(since)}`)).body
  const alphaPart = report.projects?.alpha
  const got = {}
  for (const sr of alphaPart?.mcp ?? []) got[`${sr.tool} ${sr.mode} ${sr.outcome}`] = { count: sr.count, chars: sr.chars, bytes: sr.bytes }
  check("metrics: each tool call's reported size is the text the model got, by mode and outcome", JSON.stringify(Object.fromEntries(Object.entries(got).filter(([k]) => k in expected).sort())) === JSON.stringify(Object.fromEntries(Object.entries(expected).sort())), JSON.stringify({ got, expected }))
  const cat = (alphaPart?.catalog ?? []).find((c) => c.role === 'agent')
  // Once a start: the coder's, and the agent a card was started on, whose fake reads its inbox when its task's doorbell
  // rings (#650: through the hive server, which it starts for that call, with a tool list of its own). The catalog sums
  // them: the coder's list as it got it, and the other's.
  const listBytes = Buffer.byteLength(JSON.stringify(list), 'utf8')
  check("metrics: the tool list as the session got it, once a start", cat?.starts === 2 && cat.tools > list.length && cat.tools < list.length * 3 && cat.toolsBytes > listBytes && cat.toolsBytes < listBytes * 3, JSON.stringify({ cat, list: list.length, bytes: listBytes }))
  check("metrics: the Assistant's tool calls are the workspace's own, with detail mode counted", (report.workspace?.mcp ?? []).some((sr) => sr.role === 'assistant' && sr.tool === 'hive_agent_activity' && sr.mode === 'detail'), JSON.stringify(report.workspace?.mcp?.slice(0, 3)))
  const routes = [...Object.values(report.projects), report.workspace].flatMap((pt) => pt.api.map((sr) => sr.route))
  check('metrics: API routes are templates, never paths asked for', routes.includes('/v1/tasks/:n') && !routes.some((r) => /\/\d/.test(r)), routes.join(' '))
  check("metrics: the bridge's own reports aren't counted as API traffic", !routes.includes('/v1/metrics/mcp'))
  check("metrics: an agent's API calls are its project's", (alphaPart?.api ?? []).some((sr) => sr.role === 'agent' && sr.route === '/v1/tasks/:n'))
  // A project agent sees its own project only.
  const coderApi = (p) => api('GET', p, undefined, coderToken)
  check("metrics: an agent can't read the workspace's", (await coderApi('/v1/metrics?scope=workspace')).status === 403)
  const own = await coderApi('/v1/metrics?scope=project&project=alpha')
  check('metrics: an agent reads its own project only', own.status === 200 && Object.keys(own.body.projects).join() === 'alpha' && !own.body.workspace && !own.body.app, JSON.stringify(Object.keys(own.body ?? {})))
  check("metrics: an agent's project report carries only its own loss count, nothing of the workspace's", typeof own.body.dropped === 'number' && !('droppedUntracked' in own.body) && !own.body.skills, JSON.stringify(Object.keys(own.body ?? {})))
  // A request refused before Hive knew whose it was; one whose client went away while sending its body.
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
  check("metrics: each launch's guidance, exact sizes, by provider and role", g?.launches >= 1 && g.guidanceBytes > 1000 && g.guidanceChars > 1000 && g.skills >= 5 && g.skillCatalogBytes > 0 && g.skillBytes > g.skillCatalogBytes, JSON.stringify(g))
  const ga = (after.workspace?.guidance ?? []).find((x) => x.role === 'assistant')
  // Its custom part is the journal's rule (#1032: on by default, work only).
  const journalBytes = Buffer.byteLength(`
${require('../../src/shared/hiveGuidance.ts').journalRule(require('../../src/shared/journal.ts').DEFAULT_SCOPE)}`)
  check("metrics: the Assistant's launch is the workspace's own, its core, role and mode each measured, and the journal's rule as its custom part", ga?.launches >= 1 && ga.guidanceBytes > 0 && ga.roleBytes > 0 && ga.modeBytes > 0 && ga.customBytes === journalBytes, `${JSON.stringify(ga)}; the journal's rule: ${journalBytes}`)
  check('metrics: a project agent has no role or mode', g?.roleBytes === 0 && g?.modeBytes === 0, JSON.stringify(g))
  const reported = (after.providers ?? []).find((x) => x.provider === 'claude-code' && x.role === 'agent')
  check("metrics: the providers' own reported usage for sessions in the range", reported?.sessions >= 1 && reported.inputTokens > 0, JSON.stringify(after.providers))
  check("metrics: the skill service is the workspace's own", after.skills?.scans?.count >= 1 && after.skills.hits + after.skills.misses > 0, JSON.stringify(after.skills))
  // What recording costs a request: 300 sequential calls with it on, then off (and back on). Recording is work in Hive's
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
  console.log(`metrics overhead: Hive's CPU ${on.cpu.toFixed(3)} ms a request recording, ${off.cpu.toFixed(3)} ms not (3 x 300 each); wall-clock ${on.wall.toFixed(2)} vs ${off.wall.toFixed(2)} ms (best of 3)`)
  check('metrics: recording adds well under a millisecond to a request', on.cpu - off.cpu < 1, `Hive's CPU ${on.cpu.toFixed(3)} vs ${off.cpu.toFixed(3)} ms`)
  const recorded = (await api('GET', `/v1/metrics?scope=workspace&from=${encodeURIComponent(since)}`)).body
  check('metrics: turned off, nothing was recorded', workspaceCalls(recorded) - callsBefore === 1200, String(workspaceCalls(recorded) - callsBefore))

  // The merge slot (#350): an agent's own launch holds it; replies are a line each.
  console.log('\n--- merge slot')
  const slot = (args) => {
    const r = asCoder('tools/call', { name: 'hive_merge_slot', arguments: { branch: 'main', ...args } })
    return { text: r.content[0].text, isError: !!r.isError }
  }
  check('merge slot: free, in a line', /^Merge slot for main: free\.$/.test(measure('hive_merge_slot (status, free)', slot({ action: 'status' }), 120)), texts['hive_merge_slot (status, free)'])
  check('merge slot: a claim says it is held and for how long', /^You hold the merge slot for main, \d+ min left\. Release it once merged\.$/.test(measure('hive_merge_slot (claim)', slot({ action: 'claim', cards: [7] }), 160)), texts['hive_merge_slot (claim)'])
  check('merge slot: claiming again extends it', /\(extended\)/.test(measure('hive_merge_slot (claim, extend)', slot({ action: 'claim' }), 160)), texts['hive_merge_slot (claim, extend)'])
  check('merge slot: the status names the holder and the cards', /^Merge slot for main: \w+ is merging #7 \(/.test(measure('hive_merge_slot (status, held)', slot({ action: 'status' }), 200)), texts['hive_merge_slot (status, held)'])
  const scriptClaim = tool('hive_merge_slot', { action: 'claim', branch: 'main' })
  check("merge slot: a script can't claim it", scriptClaim.isError && /Only a project's own agents hold its merge slot/.test(scriptClaim.text), scriptClaim.text)
  check('merge slot: released in a line', /^Released the merge slot for main\.$/.test(measure('hive_merge_slot (release)', slot({ action: 'release' }), 120)), texts['hive_merge_slot (release)'])
  check("merge slot: agents have the tool, the Assistant doesn't", !!toolDescription('hive_merge_slot') && !toolDescription('hive_merge_slot', 'assistant'))

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
