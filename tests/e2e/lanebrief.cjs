// A lane's brief reaches the conversation that works its cards (HI-1795, SPEC §16.10.2), on fake Claude Code agents, the
// Assistant off: alpha builds cards in slots. B1, running in the project folder, starts its own lane with a brief
// (`POST /v1/lanes` `brief`), then its first card: Hive places it in its slot in a new conversation, and that
// conversation's first prompt carries the card and the brief. Then, in its turn, it edits the brief and moves on to the
// next card; Hive is quit with that card's placement owed (B1 busy), and the next start resumes B1's conversation there
// (HI-1746) with the card and the edited brief. A list change racing a lane's end (HI-2097): a script's start just after
// B2's lane ended carries its brief and name, leaves out the Done card, and POST /v1/lanes' note says so.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const at = (x) => path.join(lib.WORK, `lanebrief-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const alpha = path.join(ws, 'alpha')
const root = path.join(`${ws}.worktrees`, 'alpha')
const PORT = Number(lib.port(47794))
const identity = { name: 'Hive Slot Test', email: 'slots@example.com' }
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'a.txt': 'a\n', '.gitignore': '.hive/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.git(alpha, ['branch', 'integration'])
  const env = lib.fakeClaude(userData, home, [alpha, ws, ...['slot-a', 'slot-b'].map((s) => path.join(root, s))])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let h = null
  const start = async () => {
    h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' } })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(h.inv)
    await lib.openWorkspace(h.inv, h.page, ws)
  }
  const inv = (...a) => h.inv(...a)
  const until = (fn, ms) => lib.until(fn, ms, 250)
  const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
  const launches = () => {
    const f = path.join(home, 'fake-launches.jsonl')
    const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
    return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  }
  /** An agent running now (started if it isn't), and its Agent API token (its latest launch's). */
  const tokenOf = async (id) => {
    if (!(await live(id))) await inv('session:start', alpha, { agentId: id })
    const sessionId = await until(async () => (await live(id))?.sessionId, HUNG_MS)
    const launch = await until(() => launches().filter((l) => l.sessionId === sessionId && l.opts['--mcp-config'] && fs.existsSync(l.opts['--mcp-config'])).at(-1), HUNG_MS)
    const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
    return hive ? JSON.parse(fs.readFileSync(hive.env.CW_API_TOKEN_FILE, 'utf8')).token : null
  }
  const api = async (token, route, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    return res ? { status: res.status, body: await res.json().catch(() => null) } : { status: 0, body: null }
  }
  const intent = (token, n, name, body = {}) => api(token, `/v1/tasks/${encodeURIComponent(`#${n}`)}/${name}`, body)
  const facts = async (n) => inv('tasks:facts', n)
  const placed = async (n) => (await facts(n)).find((f) => f.kind === 'BuilderPlaced')?.data ?? null
  const slotOf = async (n) => (await facts(n)).findLast((f) => f.kind === 'Started')?.data
  /** A conversation's transcript (its user turns among them), as the fake CLI writes it in its home's projects, or ''. */
  const transcript = async (sessionId) => {
    const projects = path.join(home, 'projects')
    if (!sessionId || !fs.existsSync(projects)) return ''
    for (const d of fs.readdirSync(projects)) {
      const f = path.join(projects, d, `${sessionId}.jsonl`)
      if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8')
    }
    return ''
  }

  try {
    await start()
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'hiveMerges', folder: 'slots', target: 'integration', style: 'merge', preChecks: [], mergeChecks: [], identity, okBefore: { mode: 'never', labels: [] } } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    const create = async (title) => (await inv('tasks:create', { title, project: 'alpha' })).number
    const [c1, c2] = [await create('Brief one'), await create('Brief two')]

    // --- 1. B1, in the project folder, starts its lane with a brief, then its first card.
    const t1 = await tokenOf(b1.id)
    const before = await live(b1.id)
    check('B1 runs in the project folder', same(before?.cwd, alpha), JSON.stringify(before))
    const lane = await api(t1, '/v1/lanes', { cards: [c1, c2], reviewer: 'R1', brief: 'LANE-BRIEF-ONE: stay off src/renderer; card one first.' })
    check('1. the lane starts with its brief, the reply saying where it goes', lane.status === 200 && /Its brief is given with each of its cards, in the builder's slot/.test(lane.body?.data?.note ?? lane.body?.note ?? ''), JSON.stringify(lane.body))
    const s1 = await intent(t1, c1, 'start')
    check('1. B1 starts card one in a slot', s1.status === 200 && !!s1.body?.data?.folder, JSON.stringify(s1.body))
    const st1 = await until(() => slotOf(c1), HUNG_MS)
    const p1 = await until(() => placed(c1), HUNG_MS)
    check('1. …placed there in a new conversation', p1?.how === 'newConversation', JSON.stringify(p1))
    const working = await until(async () => {
      const s = await live(b1.id)
      return s && same(s.cwd, st1.folder) && s.sessionId !== before.sessionId ? s : null
    }, HUNG_MS)
    check('1. …B1 works it in its slot, in that new conversation', !!working, JSON.stringify(await live(b1.id)))
    check("1. …whose first prompt carries the card and the lane's brief", !!(await until(async () => /Work on task .* from the Hive task board/.test(await transcript(working.sessionId)) && /LANE-BRIEF-ONE: stay off src\/renderer; card one first\./.test(await transcript(working.sessionId)), HUNG_MS)), (await transcript(working?.sessionId)).slice(0, 600))

    // --- 2. In its turn, it edits the brief and moves on to card two (card one put back); Hive is quit with card two's
    // placement owed; the next start resumes its conversation there with card two and the edited brief.
    const t2 = await tokenOf(b1.id)
    await until(async () => ['ready', 'finished'].includes((await live(b1.id))?.status), HUNG_MS)
    await lib.typeLine(inv, lib.ptyKey(alpha, b1.id), home, null, 'holduntil lanebrief-never', { live: () => live(b1.id) })
    check('2. B1 in its turn', !!(await until(async () => (await live(b1.id))?.status === 'working', HUNG_MS)))
    check('2. card one put back', (await intent(t2, c1, 'put-back', { why: 'card two first' })).status === 200)
    const edited = await api(t2, '/v1/lanes', { cards: [c2], brief: 'LANE-BRIEF-TWO: card two now.' })
    check('2. the lane edited: card two only, its brief replaced', edited.status === 200, JSON.stringify(edited.body))
    const s2 = await intent(t2, c2, 'start')
    check('2. B1 starts card two in its slot', s2.status === 200 && same(s2.body?.data?.folder, st1.folder), JSON.stringify(s2.body))
    check("2. …its placement owed: B1's turn not over", !(await placed(c2)) && (await live(b1.id))?.status === 'working', JSON.stringify((await facts(c2)).map((f) => f.kind)))
    await h.app.close().catch(() => {})
    await start()
    const p2 = await until(() => placed(c2), HUNG_MS)
    check('2. after the restart: B1 placed by resuming its conversation', p2?.how === 'resumed', JSON.stringify(p2))
    const back = await until(async () => {
      const s = await live(b1.id)
      return s && same(s.cwd, st1.folder) ? s : null
    }, HUNG_MS)
    check('2. …that same conversation, in its slot', back?.sessionId === working.sessionId, JSON.stringify(back))
    check("2. …its prompt carries card two and the edited brief", !!(await until(async () => /LANE-BRIEF-TWO: card two now\./.test(await transcript(working.sessionId)), HUNG_MS)), (await transcript(working.sessionId)).slice(-800))

    // --- 3. A list change racing its lane's end (HI-2097): B2's lane ends as its card is Done; a script's start for B2
    // with that card and a new one, no brief, makes a new lane with the ended lane's brief and name, the Done card left
    // out, and POST /v1/lanes' note says both, beside where the brief goes and the running builder left as it is.
    const b2 = await lib.addAgent(inv, alpha, { name: 'B2', workflowRole: 'builder' })
    // Card three already Done (the merged one), card four still to do.
    const c3 = (await inv('tasks:create', { title: 'Brief three', project: 'alpha', column: 'done' })).number
    const c4 = await create('Brief four')
    const t3 = await tokenOf(b2.id)
    const first = await api(t3, '/v1/lanes', { cards: [c4], name: 'Race lane', brief: 'LANE-BRIEF-THREE: two heavy slots.' })
    check('3. B2 starts its lane with a brief and a name', first.status === 200, JSON.stringify(first.body))
    const firstId = first.body?.data?.lane?.id ?? first.body?.lane?.id
    // Ended (not abandoned) by the user, as a lane ends once its cards merge.
    await inv('lanes:end', firstId, false)
    check('3. …and it ends', !!(await until(async () => (await inv('lanes:list')).find((l) => l.id === firstId && l.state === 'ended'), HUNG_MS)), JSON.stringify((await inv('lanes:list')).find((l) => l.id === firstId)))
    const scriptToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const raced = await api(scriptToken, '/v1/lanes', { project: 'alpha', builder: 'B2', cards: [c3, c4] })
    const r3 = raced.body?.data ?? raced.body
    const note3 = r3?.note ?? ''
    check("3. a script's start just after: a new lane, the Done card left out", raced.status === 200 && r3?.did === 'started' && r3?.lane?.id !== firstId && r3?.lane?.name === 'Race lane' && JSON.stringify(r3?.lane?.cards?.map((c) => c.number)) === JSON.stringify([c4]), JSON.stringify(raced.body))
    check("3. …its note says the brief and name were carried and the Done card left out, beside where the brief goes and who runs", /had just ended \(all merged\): started a new lane with its brief and name/.test(note3) && /is already Done: left out/.test(note3) && /Its brief is given with each of its cards/.test(note3) && /B2 is running/.test(note3), note3)  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    await h?.app.close().catch(() => {})
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
