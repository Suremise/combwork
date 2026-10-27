// A card's intents over the Agent API (#1267, SPEC §16.8.1), each caller with its own token: a builder and a reviewer
// (fake Claude Code agents, their own tokens as their hive tools use them) and the Hive Assistant through Settings →
// Assistant → Control. An agent's plain number is refused naming the card's key alone (S48); start, submit, start
// review, the reviewer's request (which ends the builder's wait for its verdict, #1272) and a failed verdict move the
// card by its workflow (the card stays its builder's); the builder can't review its own card; ask the user leaves it
// where it is; missing arguments are 400; the Assistant's intent is refused at Look and advise and runs at Control
// agents; and an agent's hive tool (hive_start_card) runs the start intent. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { createHash } = require('crypto')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47832))
const userData = path.join(lib.WORK, 'intents-profile')
const ws = path.join(lib.WORK, 'intents-ws')
const claudeHome = path.join(lib.WORK, 'intents-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
  return v
}
const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: alpha, env: lib.gitEnv(), encoding: 'utf8' }).trim()

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha, { 'a.txt': 'one\n', '.gitignore': '.hive/\n' })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1300, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    // Pair: a reviewer agent, who isn't the builder; everyone in the project folder, committed is done.
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'committed', folder: 'project' } })
    const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
    const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    for (const a of [builder, reviewer]) await inv('session:start', alpha, { agentId: a.id })
    check('the agents start', !!(await until(async () => (await live(builder.id))?.status === 'ready' && (await live(reviewer.id))?.status === 'ready', HUNG_MS)))

    // Each agent's own token, from its launch (by its session id) as its hive tools read it.
    const launchesFile = path.join(claudeHome, 'fake-launches.jsonl')
    const launches = () => {
      const text = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    }
    /** An agent's hive server as its launch has it (command and environment), or null. */
    const hiveOf = async (id) => {
      const sessionId = (await live(id))?.sessionId
      const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      return launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.hive : null
    }
    const tokenOf = async (id) => {
      const hive = await hiveOf(id)
      return hive ? JSON.parse(fs.readFileSync(hive.env.HIVE_API_TOKEN_FILE, 'utf8')).token : null
    }
    const tokens = { builder: await tokenOf(builder.id), reviewer: await tokenOf(reviewer.id) }
    check('each agent has its own token', !!tokens.builder && !!tokens.reviewer && tokens.builder !== tokens.reviewer)
    const call = async (token, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const asBuilder = (p, body) => call(tokens.builder, p, body)
    const asReviewer = (p, body) => call(tokens.reviewer, p, body)
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)

    const n = (await inv('tasks:create', { title: 'Greeting says Hi', project: 'alpha' })).number
    const key = (await card(n)).key
    check('the card has a key', /^[A-Z]{2,4}-\d+$/.test(key ?? ''), key)
    const ref = encodeURIComponent(key)

    // S48: an agent's plain number is refused, naming the card by its key alone (HI-1661: never the workspace-wide #N).
    const plain = await asBuilder(`/v1/tasks/${n}/start`)
    check("an agent's plain number is refused (409, card.plainNumber), naming the key, not #N", plain.status === 409 && plain.body?.rule === 'card.plainNumber' && plain.body.next.includes(key) && !plain.body.next.includes(`#${n}`), JSON.stringify(plain.body))
    check('…and nothing moved', (await card(n)).column === 'todo')

    // Start: the builder's own, in Doing.
    const started = await asBuilder(`/v1/tasks/${ref}/start`)
    check('the builder starts it by its key: Todo → Doing, with its folder', started.status === 200 && started.body?.from === 'todo' && started.body.to === 'active' && !!started.body.data?.folder, JSON.stringify(started.body))
    check('…the card is in Doing and the builder\'s', (await card(n))?.column === 'doing' && (await card(n))?.agent === builder.id, JSON.stringify(await card(n)))

    // Missing arguments: 400.
    check('a submission without its summary is 400', (await asBuilder(`/v1/tasks/${ref}/submit`, {})).status === 400)
    fs.writeFileSync(path.join(alpha, 'b.txt'), 'hi\n')
    git('add', '-A')
    git('commit', '-qm', 'Hi')
    const submitted = await asBuilder(`/v1/tasks/%23${n}/submit`, { summary: 'Round 1 ready: says Hi' })
    check('the builder submits it by #N: Review, its summary a comment', submitted.status === 200 && submitted.body?.to === 'review' && (await card(n))?.column === 'review' && (await card(n))?.comments.at(-1)?.text === 'Round 1 ready: says Hi', JSON.stringify(submitted.body))

    // The builder can't review its own card; the reviewer can.
    const own = await asBuilder(`/v1/tasks/${ref}/start-review`)
    check("the builder can't start reviewing its own card (409, review.notAuthor)", own.status === 409 && own.body?.rule === 'review.notAuthor', JSON.stringify(own.body))
    const review = await asReviewer(`/v1/tasks/${ref}/start-review`)
    check('the reviewer starts reviewing: the revision to review', review.status === 200 && review.body?.to === 'review' && !!review.body.data?.revision, JSON.stringify(review.body))
    // The builder waits for its verdict or Passed (#912's case: not comments), from a point taken before the request.
    const mark = await asBuilder('/v1/tasks/wait', { cards: [n], changes: ['verdict', 'column'], column: 'passed', timeoutSeconds: 1 })
    const waiting = asBuilder('/v1/tasks/wait', { cards: [n], changes: ['verdict', 'column'], column: 'passed', timeoutSeconds: 30, since: mark.body?.since })
    const asked = await asReviewer(`/v1/tasks/${ref}/request`, { text: 'Commit the test too.' })
    check("the reviewer's request is a comment on the card", asked.status === 200 && (await card(n))?.comments.at(-1)?.text === 'Commit the test too.', JSON.stringify(asked.body))
    check('…and a line of its history, by the reviewer', (await card(n))?.history.some((h) => h.what === 'Asked the builder: "Commit the test too."' && h.by.startsWith('Reviewer')), JSON.stringify((await card(n))?.history.slice(-3)))
    const heard = await waiting
    check("…which ends the builder's wait for its verdict, as a request (#1272)", heard.status === 200 && !heard.body?.timedOut && heard.body?.changes?.[0]?.changes.includes('request'), JSON.stringify(heard.body))
    check('a verdict without pass is 400', (await asReviewer(`/v1/tasks/${ref}/verdict`, { comment: 'x' })).status === 400)
    const verdict = await asReviewer(`/v1/tasks/${ref}/verdict`, { pass: false, failKind: 'content', comment: 'Round 1: FAILED. 1. Add a test.' })
    const after = await card(n)
    check("a failed verdict: back in Doing, still the builder's", verdict.status === 200 && verdict.body?.to === 'active' && after?.column === 'doing' && after.agent === builder.id, JSON.stringify({ verdict: verdict.body, column: after?.column, agent: after?.agent }))

    // A design first (#1382): posted in Doing, it wakes the reviewer (the agent that last reviewed the card) with no watch
    // of its own; its answer wakes the builder. Nothing moves; each side only its own.
    const wakesOf = (agent) => {
      const f = path.join(claudeHome, 'fake-wakes.jsonl')
      return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === agent).map((w) => w.text)
    }
    await until(async () => (await live(reviewer.id))?.status === 'ready' && (await live(builder.id))?.status === 'ready', HUNG_MS)
    const [reviewerWakes, builderWakes] = [wakesOf('Reviewer').length, wakesOf('Builder').length]
    const notYours = await asReviewer(`/v1/tasks/${ref}/loop-step`, { step: 'design', text: 'Mine?' })
    check("the reviewer can't post the builder's design (409, loop.stepNotYours)", notYours.status === 409 && notYours.body?.rule === 'loop.stepNotYours', JSON.stringify(notYours.body))
    const designed = await asBuilder(`/v1/tasks/${ref}/loop-step`, { step: 'design', text: 'Design: greet with Hi, tested by b.test.' })
    const designId = designed.body?.data?.design
    check('the builder posts a design in Doing: it stays, and the reply names it and when its check is due', designed.status === 200 && designed.body?.to === 'active' && /\/s\d+$/.test(designId ?? '') && designed.body.data.waitMinutes === 30 && Date.parse(designed.body.data.until) > Date.now() && (await card(n))?.column === 'doing', JSON.stringify(designed.body))
    check('…a line of its history', (await card(n))?.history.some((h) => h.what === 'Posted a design for the reviewer to check: "Design: greet with Hi, tested by b.test."'), JSON.stringify((await card(n))?.history.slice(-3)))
    check('…which wakes the reviewer with it, by its id', !!(await until(() => wakesOf('Reviewer').length > reviewerWakes && wakesOf('Reviewer').at(-1).includes(`The builder: "design ${designId} posted for your check (answer with its id): Design: greet with Hi`), HUNG_MS)), JSON.stringify(wakesOf('Reviewer').slice(reviewerWakes)))
    const early = await asBuilder(`/v1/tasks/${ref}/loop-step`, { step: 'proceed', text: 'Going ahead', design: designId })
    check('going ahead before the check is due is refused (409, loop.tooEarly)', early.status === 409 && early.body?.rule === 'loop.tooEarly', JSON.stringify(early.body))
    check('an answer must name the design it is about (400)', (await asReviewer(`/v1/tasks/${ref}/loop-step`, { step: 'ok', text: 'Holds' })).status === 400)
    const stale = await asReviewer(`/v1/tasks/${ref}/loop-step`, { step: 'ok', text: 'Holds', design: `${key}/s1` })
    check('…and one about another design is refused (409, loop.staleStep)', stale.status === 409 && stale.body?.rule === 'loop.staleStep', JSON.stringify(stale.body))
    await until(async () => (await live(reviewer.id))?.status === 'ready', HUNG_MS)
    const ok = await asReviewer(`/v1/tasks/${ref}/loop-step`, { step: 'ok', text: 'Holds: build it.', design: designId })
    check("the reviewer's answer is taken", ok.status === 200 && (await card(n))?.history.some((h) => h.what === 'Checked the design: OK: "Holds: build it."'), JSON.stringify(ok.body))
    check('…and wakes the builder with it', !!(await until(() => wakesOf('Builder').length > builderWakes && wakesOf('Builder').at(-1).includes(`The reviewer: "design ${designId} is OK: Holds: build it."`), HUNG_MS)), JSON.stringify(wakesOf('Builder').slice(builderWakes)))
    await until(async () => (await live(builder.id))?.status === 'ready', HUNG_MS)
    // A follow-up (#1467) is for work in Review or Passed: in Doing it is refused, and nothing is written.
    const followUp = await asBuilder(`/v1/tasks/${ref}/loop-step`, { step: 'followUp', text: 'Fixes ready.' })
    check('a follow-up in Doing is refused (409, loop.stepNotHere)', followUp.status === 409 && followUp.body?.rule === 'loop.stepNotHere' && !(await card(n))?.history.some((h) => h.what.startsWith('Posted a follow-up')), JSON.stringify(followUp.body))

    // Ask the user: nothing moves.
    const head = git('rev-parse', 'HEAD')
    const question = await asBuilder(`/v1/tasks/${ref}/ask`, { kind: 'test', text: 'Does it say Hi?', revision: head, checklist: ['Open the app', 'Read the greeting'] })
    check('asking the user leaves it in Doing', question.status === 200 && question.body?.from === 'active' && question.body.to === 'active' && !!question.body.data?.request && (await card(n))?.column === 'doing', JSON.stringify(question.body))
    const facts = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${ref}/facts?view=full`, { headers: { Authorization: `Bearer ${tokens.builder}` } }).then((r) => r.json())
    const request = facts.facts?.find((f) => f.kind === 'ApprovalRequested')?.data
    check('…and is a request for the user in its facts, with its revision and Test checklist', request?.kind === 'test' && request.revision === head && JSON.stringify(request.checklist) === JSON.stringify(['Open the app', 'Read the greeting']), JSON.stringify(request))
    check('an ask with a checklist that is not a list is 400', (await asBuilder(`/v1/tasks/${ref}/ask`, { text: 'x', checklist: 'Open the app' })).status === 400)

    // The Assistant, with its own token: refused at Look and advise, runs at Control agents.
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    const assistantLive = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.agentId === 'assistant')
    await until(async () => {
      const s = await assistantLive()
      if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
      return s?.status === 'ready'
    }, HUNG_MS)
    const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const assistantToken = (await until(() => fs.existsSync(tokenFile), HUNG_MS)) ? JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token : null
    check("the Assistant has its token", !!assistantToken)
    await inv('settings:update', { assistant: { control: 'look' } })
    const looked = await call(assistantToken, `/v1/tasks/${n}/put-back`, { why: 'The user wants it later.' })
    check("at Look and advise the Assistant's intent is refused (403)", looked.status === 403 && (await card(n))?.column === 'doing', JSON.stringify(looked.body))
    await inv('settings:update', { assistant: { control: 'agents' } })
    const putBack = await call(assistantToken, `/v1/tasks/${n}/put-back`, { why: 'The user wants it later.' })
    check("at Control agents the Assistant puts it back, by its number: Todo", putBack.status === 200 && putBack.body?.to === 'todo' && (await card(n))?.column === 'todo' && (await card(n))?.comments.at(-1)?.text === 'The user wants it later.', JSON.stringify(putBack.body))
    check("…listed in what it did", (await inv('assistant:actions')).some((x) => x.ok && x.text.includes('put back')), JSON.stringify((await inv('assistant:actions')).map((x) => x.text)))

    // An agent asks the Assistant on a card (HI-1866): its comment and a history line, and the Assistant's inbox, whose
    // doorbell its idle session takes. Refused, with nothing written: a plain number, no text, the Assistant itself, and
    // at Look and advise (it can't act on it). What the Assistant's fake read: it follows Hive's doorbell with
    // hive_inbox and logs what it read.
    const asks = () => {
      const f = path.join(claudeHome, 'fake-wakes.jsonl')
      return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === 'Assistant').map((w) => w.text)
    }
    const asksBefore = asks().length
    const plainAsk = await asBuilder(`/v1/tasks/${n}/ask-assistant`, { text: 'Park it.' })
    check("asking the Assistant by a plain number is refused (409, card.plainNumber)", plainAsk.status === 409 && plainAsk.body?.rule === 'card.plainNumber', JSON.stringify(plainAsk.body))
    check('…and without text is 400', (await asBuilder(`/v1/tasks/${ref}/ask-assistant`, {})).status === 400)
    check("…and the Assistant can't ask itself (403)", (await call(assistantToken, `/v1/tasks/${ref}/ask-assistant`, { text: 'Park it.' })).status === 403)
    await inv('settings:update', { assistant: { control: 'look' } })
    const lookAsk = await asBuilder(`/v1/tasks/${ref}/ask-assistant`, { text: 'Park it.' })
    check('…and at Look and advise it is refused (409), saying to ask the user', lookAsk.status === 409 && /hive_ask_user/.test(JSON.stringify(lookAsk.body)), JSON.stringify(lookAsk.body))
    check('…with nothing written', !(await card(n))?.comments.some((c) => c.text === 'Park it.'), JSON.stringify((await card(n))?.comments.slice(-2)))
    await inv('settings:update', { assistant: { control: 'agents' } })
    const askedAssistant = await asBuilder(`/v1/tasks/${ref}/ask-assistant`, { text: 'Please put this card On Hold: the user said so.' })
    const askId = askedAssistant.body?.delivery
    check('the builder asks the Assistant: the card and its id in the Assistant\'s inbox', askedAssistant.status === 200 && askedAssistant.body?.card === key && /^m\d+$/.test(askId ?? ''), JSON.stringify(askedAssistant.body))
    check("…its comment and a line of its history, by the builder", (await card(n))?.comments.at(-1)?.text === 'Please put this card On Hold: the user said so.' && (await card(n))?.history.some((h) => h.what === 'Asked the Hive Assistant: "Please put this card On Hold: the user said so."' && h.by.startsWith('Builder')), JSON.stringify((await card(n))?.history.slice(-2)))
    check("…and the Assistant's idle session is woken and reads it, whole, as the builder's request", !!(await until(() => asks().slice(asksBefore).some((t) => t.includes("Builder (alpha) asks you on ") && t.includes('<<<Please put this card On Hold: the user said so.>>>')), HUNG_MS)), JSON.stringify(asks().slice(asksBefore)))
    await inv('session:stop', home, 'assistant')

    // An agent's hive tool: hive_start_card runs the start intent. Called through hive-mcp.js with the builder's own
    // hive server settings (from its launch), not typed into its pane, where Hive's own wakes may be typed meanwhile.
    const builderHive = await hiveOf(builder.id)
    const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'hive-mcp.js')], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hive_start_card', arguments: { card: key } } }) + '\n',
      env: lib.childEnv(builderHive.env),
      timeout: HUNG_MS
    }).toString()
    const reply = JSON.parse(out.split('\n')[0]).result
    check('hive_start_card starts it: a line saying where it went', !reply.isError && reply.content[0].text.startsWith(`${key}: todo → active.`), JSON.stringify(reply))
    check("…and it is in Doing, the builder's", (await card(n))?.column === 'doing' && (await card(n))?.agent === builder.id, JSON.stringify(await card(n)))

    await inv('session:stop', alpha)
    await until(async () => (await inv('session:live')).length === 0, HUNG_MS)
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
