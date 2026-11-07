// A wake put off part-way (HI-1974), on a fake Claude Code and a fake Codex agent: a doorbell typed into an idle agent
// whose terminal is 40 columns wide, so the line wraps onto several rows, is held before its Enter (CW_TEST_HOLD_TYPED),
// and idle wakes are turned off meanwhile, so it is no longer wanted. What Combwork typed is taken back whole: the input is
// empty again (the fake Claude Code's Ctrl+U deletes one wrapped row, as Claude Code 2.1.312's does; LB1 kept a stopped
// wake's first rows, and the next wake was sent after them). Idle wakes on again, the next wake is typed and sent alone.
// Codex (and Copilot, wakepaste-copilot) clear the whole line with one Ctrl+U. Then a draft the user left in Claude
// Code's input (HI-1979), which its Ctrl+U clears a row at a time: Combwork types only once it reads the input box empty.
// One taller than the screen, with line breaks, is cleared and the doorbell sent alone; with the fake's input not read
// (fake-slow-input), nothing is typed until it reads again, then the same. Dev build only (the seam), throwaway profile,
// workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
// HI-2482: four comments on a watched card arrive together. Its existing settle produces one typed doorbell; further
// board traffic while it is held before Enter must not erase it. The withdrawal checks above still reject stale lines.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFile } = require('child_process')
const { Terminal } = require('@xterm/headless')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
const COLS = 40

const userData = path.join(lib.WORK, 'wakeputoff-profile')
const ws = path.join(lib.WORK, 'wakeputoff-ws')
const claudeHome = path.join(lib.WORK, 'wakeputoff-claude-home')
const codexHome = path.join(lib.WORK, 'wakeputoff-codex-home')
const hold = path.join(lib.WORK, 'wakeputoff-hold')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47864))
const API = `http://127.0.0.1:${PORT}`
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome, hold]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  lib.logFakeInput(claudeHome)
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(alpha)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  // A short pause after the user types (HI-1979's drafts): Combwork types nothing into a pane for this long after a key there.
  cfg.settings.assistant = { ...cfg.settings.assistant, typingPause: 2, enterEndsPause: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), ws.toLowerCase()]))
  // Both follow Combwork's notices, as a model does: they read their inbox and ack what they listed.
  fs.writeFileSync(path.join(claudeHome, 'fake-follow-notices.txt'), '')
  fs.writeFileSync(path.join(codexHome, 'fake-follow-notices.txt'), '')

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, CW_TEST_TIPS: 'off', CW_TEST_HOLD_TYPED: hold })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const until = (fn, ms) => lib.until(fn, ms, 100)
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    const homeOf = (a) => (a.provider === 'codex' ? codexHome : claudeHome)
    /** The doorbells the agent was sent, each line as its CLI took it. */
    const wakes = (a) => lines(path.join(homeOf(a), 'fake-wakes.jsonl')).filter((w) => w.agent === a.name && w.doorbell).map((w) => w.doorbell)
    const setSwitch = (which, value) => inv('advanced:set', `cw.inbox.${which}`, value)
    const combworkLog = () => {
      const f = path.join(userData, 'logs', 'combwork.log')
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
    }
    const logCount = (re) => combworkLog().split('\n').filter((l) => re.test(l)).length
    /** What the agent's terminal shows: its output (pty:buffer, which keeps what was erased too) drawn at its size. */
    const screen = async (a) => {
      const key = lib.ptyKey(alpha, a.id)
      const size = await inv('pty:size', key)
      const output = String(await inv('pty:buffer', key).catch(() => ''))
      const term = new Terminal({ cols: size?.cols ?? 120, rows: size?.rows ?? 40, allowProposedApi: true })
      await new Promise((res) => term.write(output, res))
      const b = term.buffer.active
      const rows = []
      for (let i = 0; i < term.rows; i++) rows.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
      term.dispose()
      return rows.join('\n')
    }
    /** The doorbell's copies on screen, wherever its rows were wrapped. */
    const onScreen = async (a) => ((await screen(a)).replace(/\s+/g, '').match(/\[CW\]Newinyourinbox/g) ?? []).length

    await page.getByText('alpha', { exact: true }).first().click()
    const claude = { ...(await lib.addAgent(inv, alpha, { name: 'Claude', workflowRole: 'reviewer' })), name: 'Claude', provider: 'claude-code' }
    const codex = { ...(await lib.addAgent(inv, alpha, { name: 'Codex', provider: 'codex', permissionMode: 'approve-for-me' })), name: 'Codex', provider: 'codex' }
    for (const a of [claude, codex]) await inv('session:start', alpha, { agentId: a.id })
    check('both agents start', !!(await until(async () => (await idle(claude.id)) && (await idle(codex.id)), HUNG_MS)))

    const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    await until(async () => (await inv('session:live')).some((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.status === 'ready'), HUNG_MS)
    // Not synchronous: leaving a message replies once its doorbell is typed, which the test holds meanwhile.
    const tool = (name, args) =>
      new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], { env: lib.childEnv({ CW_API_URL: API, CW_WORKSPACE: ws, CW_ROLE: 'assistant', CW_ASSISTANT_CONTROL: 'projects', CW_API_TOKEN_FILE: asTokenFile, CW_API_TOKEN: '', CW_PROJECT: '' }), timeout: 60000 }, (e, out) => (e ? reject(e) : resolve(JSON.parse(String(out).split('\n')[0]).result.content[0].text)))
        child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n')
      })
    const leave = async (a, text) => /\((m\d+)/.exec(await tool('cw_message_agent', { project: 'alpha', agent: a.name, text }))?.[1] ?? null
    const delivery = async (a, id) => JSON.parse(await tool('cw_agent_activity', { project: 'alpha', agent: a.name, detail: true })).inbox?.deliveries?.find((d) => d.id === id) ?? null

    for (const a of [claude, codex]) {
      const key = lib.ptyKey(alpha, a.id)
      // Narrow, so the doorbell wraps onto several rows (asked again until the terminal is that size).
      check(`${a.name}: its terminal is ${COLS} columns wide`, !!(await until(async () => (await inv('pty:resize', key, COLS, 30), (await inv('pty:size', key))?.cols === COLS), HUNG_MS)), JSON.stringify(await inv('pty:size', key)))
      const before = wakes(a).length
      const held = logCount(/the line Combwork typed is held before its Enter/)
      const putOff = logCount(/put off: It is no longer wanted/)
      fs.writeFileSync(hold, '')
      const left = leave(a, 'Rebase onto main.')
      check(`${a.name}: its doorbell is typed, and held before its Enter`, !!(await until(() => logCount(/the line Combwork typed is held before its Enter/) > held, HUNG_MS)))
      // The fake Codex doesn't draw its input: its line is checked by what it is sent (below).
      const draws = a.provider === 'claude-code'
      if (draws) check(`${a.name}: …it shows in its input, wrapped onto several rows`, !!(await until(async () => (await onScreen(a)) === 1, HUNG_MS)) && (await inv('pty:size', key))?.cols === COLS, await screen(a))
      // No longer wanted as it waits there: what it was made for can't be typed by itself now.
      await setSwitch('idleWakes', false)
      check(`${a.name}: idle wakes turned off: the wake is put off part-way`, !!(await until(() => logCount(/put off: It is no longer wanted/) > putOff, HUNG_MS)))
      if (draws) check(`${a.name}: …what Combwork typed is taken back whole: none of it is left in the input`, !!(await until(async () => (await onScreen(a)) === 0, HUNG_MS)), await screen(a))
      const m = await left
      const waiting = await delivery(a, m)
      check(`${a.name}: …nothing was sent, the message still waits`, !!m && wakes(a).length === before && waiting?.state === 'queued', JSON.stringify({ m, wakes: wakes(a).slice(before), d: waiting }))
      fs.rmSync(hold, { force: true })
      await setSwitch('idleWakes', null)
      check(`${a.name}: idle wakes on again: the next wake is typed and sent`, !!(await until(() => wakes(a).length > before, HUNG_MS)), JSON.stringify(wakes(a).slice(before)))
      const sent = wakes(a).slice(before)
      check(`${a.name}: …alone: one doorbell, nothing typed before it`, sent.length === 1 && sent[0].startsWith('[CW] New in your inbox') && (sent[0].match(/\[CW\]/g) ?? []).length === 1, JSON.stringify(sent))
      check(`${a.name}: …it reads and acks the message`, !!(await until(async () => (await delivery(a, m))?.state === 'acked' && (await idle(a.id)), HUNG_MS)), JSON.stringify(await delivery(a, m)))
    }

    // --- HI-2482: a burst on a watched card, with board traffic continuing after the doorbell has been typed.
    const watched = await inv('tasks:create', { title: 'Burst of card events', project: 'alpha' })
    const unrelated = await inv('tasks:create', { title: 'Unrelated board traffic', project: 'alpha' })
    await lib.typeLine(inv, lib.ptyKey(alpha, claude.id), claudeHome, null,
      `cw cw_wait_for_tasks ${JSON.stringify({ cards: [watched.key], changes: ['comment'], wake: true })}`, { live: () => live(claude.id) })
    check('burst: Claude watches the card', !!(await until(async () => (await live(claude.id))?.status === 'watching', HUNG_MS)))
    const burstBefore = wakes(claude).length
    const burstHeld = logCount(/the line Combwork typed is held before its Enter/)
    const burstPutOff = logCount(/put off: It is no longer wanted/)
    fs.writeFileSync(hold, '')
    const burstAt = Date.now()
    // These timers produce the burst over 1.35 s (test input, not a wait for success); every assertion polls a condition.
    await Promise.all([0, 450, 900, 1350].map((after, i) => new Promise((resolve, reject) => {
      setTimeout(() => inv('tasks:comment', watched.number, `Burst comment ${i + 1}`).then(resolve, reject), after)
    })))
    console.log(`burst: four watched-card events posted in ${Date.now() - burstAt} ms`)
    check('burst: one doorbell is typed and held before Enter', !!(await until(() => logCount(/the line Combwork typed is held before its Enter/) > burstHeld, HUNG_MS)))
    await inv('tasks:comment', unrelated.number, 'Another card changes while the wake is typed')
    await inv('tasks:comment', watched.number, 'The watched card changes again while the wake is typed')
    fs.rmSync(hold, { force: true })
    check('burst: the doorbell is sent and its inbox read', !!(await until(async () => wakes(claude).length > burstBefore && (await idle(claude.id)), HUNG_MS)))
    check('burst: one typed line, no repeated erase and retry',
      logCount(/the line Combwork typed is held before its Enter/) === burstHeld + 1 && logCount(/put off: It is no longer wanted/) === burstPutOff && wakes(claude).length === burstBefore + 1,
      JSON.stringify({ typed: logCount(/the line Combwork typed is held before its Enter/) - burstHeld, putOff: logCount(/put off: It is no longer wanted/) - burstPutOff, sent: wakes(claude).slice(burstBefore) }))

    // A loop's card-event doorbell (the reported line): HI-2486 already stopped unrelated board events invalidating
    // it. Hold it across four such events, then withdraw a second review while its line is typed: that one must stop.
    const builder = { ...(await lib.addAgent(inv, alpha, { name: 'Builder' })), name: 'Builder', provider: 'claude-code' }
    await inv('session:start', alpha, { agentId: builder.id })
    const loopCard = await inv('tasks:create', { title: 'Loop wake during a burst', project: 'alpha', agent: builder.id })
    await inv('tasks:update', loopCard.number, { column: 'doing', agent: builder.id })
    await lib.typeLine(inv, lib.ptyKey(alpha, builder.id), claudeHome, null,
      `cw cw_lane ${JSON.stringify({ action: 'start', cards: [loopCard.key], reviewer: claude.name })}`, { live: () => live(builder.id) })
    check('loop burst: its lane names Claude as reviewer', !!(await until(async () => (await inv('lanes:list')).some((l) => l.reviewer?.id === claude.id), HUNG_MS)))
    for (const withdraw of [false, true]) {
      const before = wakes(claude).length
      const held = logCount(/the line Combwork typed is held before its Enter/)
      const putOff = logCount(/put off: It is no longer wanted/)
      fs.writeFileSync(hold, '')
      await inv('tasks:update', loopCard.number, { column: 'review' })
      check(`loop burst: ${withdraw ? 'second' : 'first'} review doorbell is typed before Enter`, !!(await until(() => logCount(/the line Combwork typed is held before its Enter/) > held, HUNG_MS)))
      for (let i = 1; i <= 4; i++) await inv('tasks:comment', unrelated.number, `Unrelated event ${i}, withdrawal ${withdraw}`)
      if (withdraw) {
        await inv('tasks:update', loopCard.number, { column: 'doing' })
        check('loop burst: the withdrawn review is put off before Enter', !!(await until(() => logCount(/put off: It is no longer wanted/) > putOff, HUNG_MS)))
        check('loop burst: the stale card-event line was never sent', wakes(claude).length === before, JSON.stringify(wakes(claude).slice(before)))
      }
      fs.rmSync(hold, { force: true })
      if (!withdraw) {
        check('loop burst: the card-event doorbell is sent and read', !!(await until(async () => wakes(claude).length > before && (await idle(claude.id)), HUNG_MS)))
        check('loop burst: unrelated events do not erase and retype the line',
          logCount(/the line Combwork typed is held before its Enter/) === held + 1 && logCount(/put off: It is no longer wanted/) === putOff && wakes(claude).length === before + 1 && wakes(claude)[before].includes('card event'),
          JSON.stringify({ typed: logCount(/the line Combwork typed is held before its Enter/) - held, putOff: logCount(/put off: It is no longer wanted/) - putOff, sent: wakes(claude).slice(before) }))
        await inv('tasks:update', loopCard.number, { column: 'doing' })
      }
    }

    // --- HI-1979: a draft the user left in Claude Code's input, which its Ctrl+U clears a row at a time. Combwork types only
    // once it reads the input box empty; a box it can't see cleared, it types nothing into.
    const key = lib.ptyKey(alpha, claude.id)
    const box = async () => (await screen(claude)).replace(/\s+/g, '')
    /** Every prompt its CLI took, as its conversation has them (a doorbell sent after a draft would be one, not a doorbell). */
    const prompts = async () => {
      const s = await live(claude.id)
      const items = s?.sessionId ? ((await inv('transcript:read', alpha, s.sessionId).catch(() => null))?.items ?? []) : []
      return items.filter((i) => i.kind === 'user').map((i) => i.text)
    }
    // The user's own paste (through the pane, as typing): sixteen lines of fifty characters, two rows each at 40 columns,
    // taller than the 30-row screen; no Enter.
    const tall = Array.from({ length: 16 }, (_, i) => `draft line ${String(i).padStart(2, '0')} ${'d'.repeat(36)}`).join('\r')
    let before = wakes(claude).length
    let took = (await prompts()).length
    await inv('pty:write', key, `\x1b[200~${tall}\x1b[201~`)
    check('Claude: a draft of the user\'s, taller than the screen, in its input', !!(await until(async () => (await box()).includes('draftline15'), HUNG_MS)), await screen(claude))
    let m = await leave(claude, 'Draft or not, read this.')
    check('Claude: past the typing pause, the doorbell goes once the draft is cleared', !!(await until(() => wakes(claude).length > before, HUNG_MS)), JSON.stringify(wakes(claude).slice(before)))
    let sent = wakes(claude).slice(before)
    let taken = (await prompts()).slice(took)
    check('Claude: …alone, with none of the draft before it: the one prompt it took is the doorbell', sent.length === 1 && taken.length === 1 && taken[0].startsWith('[CW] New in your inbox') && !taken[0].includes('draft line'), JSON.stringify({ sent, taken }))
    check('Claude: …it reads and acks the message', !!(await until(async () => (await delivery(claude, m))?.state === 'acked' && (await idle(claude.id)), HUNG_MS)), JSON.stringify(await delivery(claude, m)))

    // Its input not read meanwhile (a busy CLI: fake-slow-input): a Ctrl+U it doesn't answer. Combwork types nothing, puts the
    // doorbell off, and once the CLI reads its input again, clears the draft and sends the doorbell alone.
    const knob = path.join(claudeHome, `fake-slow-input-${claude.name}.txt`)
    const paused = path.join(claudeHome, `fake-slow-input-${claude.name}.paused`)
    await inv('pty:write', key, `a draft typed and left there, ${'long enough to wrap onto rows of its own, '.repeat(2)}end`)
    check('Claude: a wrapped draft in its input', !!(await until(async () => (await box()).includes('end'), HUNG_MS)), await screen(claude))
    fs.writeFileSync(knob, '')
    check('Claude: its input reading stops', !!(await until(() => fs.existsSync(paused), HUNG_MS)))
    before = wakes(claude).length
    took = (await prompts()).length
    const notSeen = logCount(/its input wasn't seen empty, so nothing is typed into it/)
    const leftHeld = leave(claude, 'Read this once your input is clear.')
    check('Claude: a Ctrl+U it doesn\'t answer: nothing is typed, the doorbell put off', !!(await until(() => logCount(/its input wasn't seen empty, so nothing is typed into it/) > notSeen, HUNG_MS)) && wakes(claude).length === before && (await prompts()).length === took)
    fs.rmSync(knob, { force: true })
    check('Claude: reading again, the draft is cleared and the doorbell goes', !!(await until(() => wakes(claude).length > before, HUNG_MS)), JSON.stringify(wakes(claude).slice(before)))
    m = await leftHeld
    sent = wakes(claude).slice(before)
    taken = (await prompts()).slice(took)
    check('Claude: …alone, with none of the draft before it: the one prompt it took is the doorbell', sent.length === 1 && taken.length === 1 && taken[0].startsWith('[CW] New in your inbox') && !taken[0].includes('a draft typed'), JSON.stringify({ sent, taken }))
    check('Claude: …it reads and acks the message', !!(await until(async () => (await delivery(claude, m))?.state === 'acked' && (await idle(claude.id)), HUNG_MS)), JSON.stringify(await delivery(claude, m)))
  } catch (e) {
    check('no error', false, e.stack)
  } finally {
    fs.rmSync(hold, { force: true })
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
