// A card loop left with no watch (#376), on fake Claude Code agents (fake-claude/). On 7 Oct a Codex reviewer's wake was
// typed but its Enter never taken, so it sat "finished" for hours with its watch gone while the builder waited on it.
// Checked: a wake whose first Enter the CLI drops gets Enter again and is taken; one never taken leaves the agent idle
// with no watch, and after the grace its card shows as stalled ("Reviewer isn't watching #n", on the board and through
// the Agent API) with one notification, cleared once the agent works again; an agent that ends its turn without starting
// a watch, with its card in Review, is flagged the same way; one that keeps watching never is. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR; the grace and the wait for a wake to be taken are shortened for the test.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'loopwatch-profile')
const ws = path.join(lib.WORK, 'loopwatch-ws')
const claudeHome = path.join(lib.WORK, 'loopwatch-claude-home')
const notifyLog = path.join(lib.WORK, 'loopwatch-notify.jsonl')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const PORT = Number(lib.port(47864))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(notifyLog, { force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_NOTIFY_LOG: notifyLog, HIVE_TEST_LOOP_GRACE_MS: '3000', HIVE_TEST_WAKE_TAKE_MS: '2000' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 30000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const wakes = (agent) => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === agent).map((w) => ({ ...w, raw: w.text, text: lib.unkey(w.text) }))
  }
  const script = (agent, lines) => fs.writeFileSync(path.join(claudeHome, `fake-wakes-${agent}.txt`), lines.join('\n') + '\n')
  /** The fake drops the next n Enters that would send a line from Combwork ("[CW]…"), as Codex did once (#376). */
  const dropEnters = (agent, n) => fs.writeFileSync(path.join(claudeHome, `fake-drop-enters-${agent}.txt`), String(n))
  /** What an agent is doing, for a failed check: its state, its terminal's last lines and the log's (#539). */
  const why = async (id) => {
    const l = await live(id)
    const state = l ? `${l.status}${l.notWatching ? `, not watching ${JSON.stringify(l.notWatching)}` : ''}` : 'no session'
    const term = lib.plainText(await inv('pty:buffer', lib.ptyKey(alpha, id)).catch(() => '')).trim().slice(-600)
    return `${state}; terminal: ${term || '(empty)'}; hive.log: ${hiveLog().split(/\r?\n/).filter(Boolean).slice(-25).join(' | ')}`
  }
  /** Starts an agent: whether it is ready for a line, a failed check saying why when it isn't (#539). */
  const start = async (id, name) => {
    await inv('session:start', alpha, { agentId: id })
    const ok = !!(await until(async () => (await live(id))?.status === 'ready', HUNG_MS))
    check(`${name} starts`, ok, ok ? '' : await why(id))
    return ok
  }
  /** How many times the agent's transcript has `text` as a prompt it took. */
  const said = async (id, text) => {
    const sessionId = (await live(id))?.sessionId
    const items = sessionId ? ((await inv('transcript:read', alpha, sessionId).catch(() => null))?.items ?? []) : []
    return items.filter((x) => x.kind === 'user' && String(x.text ?? '').trim() === text).length
  }
  /**
   * Types a line to an agent and checks its CLI took it (#564). Under load a line can reach the fake late, after the end
   * of a turn Combwork already shows, and be dropped while it is still busy (as a line typed during a turn is): typed again.
   */
  const say = async (id, text) => {
    const key = lib.ptyKey(alpha, id)
    const before = await said(id, text)
    for (let attempt = 0; attempt < 3; attempt++) {
      // A retry clears what is left on the line first (Ctrl+U); the first try leaves a line Combwork typed alone.
      await inv('pty:write', key, attempt ? `\x15${text}` : text)
      await until(async () => lib.plainText(await inv('pty:buffer', key).catch(() => '')).trimEnd().endsWith(text), 5000)
      await inv('pty:write', key, '\r')
      if (await until(async () => (await said(id, text)) > before, 10000)) return
    }
  }
  // The card as `#N`, its workspace number: a plain number reading as another card's key is refused (HI-2197).
  const wait = (n, extra) => `hive cw_wait_for_tasks ${JSON.stringify({ cards: [`#${n}`], ...extra, wake: true })}`
  // As its checks read it, the card by number (it names it by key too, #1219: checked below).
  const rawStalled = async (n) => (await api('GET', `/v1/tasks/${n}`)).body?.stalled ?? null
  const stalledOf = async (n) => lib.unkey(await rawStalled(n))
  const notices = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const hiveLog = () => fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8')

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  // Every check below types to them: an agent that isn't running would fail them all, saying nothing of why (#539).
  if (!(await start(reviewer.id, 'the reviewer')) || !(await start(builder.id, 'the builder'))) {
    await app.close()
    process.exit(1)
  }

  // --- 1. A wake whose first Enter is dropped: Combwork presses Enter again and the line is taken; no stall.
  const c1 = (await inv('tasks:create', { title: 'Dropped Enter', project: 'alpha', agent: builder.id, column: 'doing' })).number
  script('Reviewer', [`boardreview ${c1} start then ${wait(c1, { column: 'review', fresh: true })}`])
  await say(reviewer.id, wait(c1, { column: 'review' }))
  check('the reviewer watches #1', !!(await until(async () => (await live(reviewer.id))?.status === 'watching', HUNG_MS)), await why(reviewer.id))
  dropEnters('Reviewer', 1)
  await inv('tasks:update', c1, { column: 'review' })
  check('its wake is taken after Enter is pressed again', !!(await until(async () => wakes('Reviewer').length === 1, 20000)), JSON.stringify(wakes('Reviewer')))
  check('…Combwork says it pressed Enter again', /wasn't taken: pressed Enter again/.test(hiveLog()))
  check('…and the reviewer works, then watches again', !!(await until(async () => (await live(reviewer.id))?.status === 'watching', 15000)))
  await lib.sleep(4500) // on purpose: longer than the grace, to see no flag comes
  check('a reviewer that keeps watching is never flagged', !(await stalledOf(c1)) && !(await live(reviewer.id))?.notWatching, String(await stalledOf(c1)))

  // --- 2. A wake never taken (both Enters dropped): the reviewer did watch, but its wake waits in its prompt, so nothing
  // will move it on; after the grace its card is stalled, saying so (#777: not "its turn ended with no card watch", which
  // blamed the reviewer, as Codex reviewers were on 14 Oct), with one notice (the untaken line's, not "isn't watching");
  // the line goes through once Enter is pressed (by the user here), and the flag clears.
  dropEnters('Reviewer', 2)
  script('Reviewer', [`work 1 then ${wait(c1, { column: 'passed' })}`])
  await inv('tasks:update', c1, { column: 'doing' })
  await inv('tasks:update', c1, { column: 'review' })
  const reason = `Reviewer hasn't taken the wake Combwork typed for #${c1}: it waits in its prompt.`
  check('a wake never taken: after the grace, the card is stalled, saying who and why', !!(await until(async () => (await stalledOf(c1)) === reason, 30000)), String(await stalledOf(c1)))
  check('…naming the card by key alone (#1219, HI-1661)', lib.KEYED.test(String(await rawStalled(c1))), String(await rawStalled(c1)))
  check('…the line was never sent, and Combwork says so', !!(await until(async () => /still wasn't taken/.test(hiveLog()), 8000)) && wakes('Reviewer').length === 1)
  check('…the reviewer shows idle, with the card it left', ['ready', 'finished'].includes((await live(reviewer.id))?.status) && JSON.stringify((await live(reviewer.id))?.notWatching) === JSON.stringify([c1]), JSON.stringify(await live(reviewer.id)))
  await page.getByRole('button', { name: 'Task Board' }).click()
  const tile = page.locator(`.task-card[data-task="${c1}"]`)
  check('the board shows the card stalled', !!(await until(async () => /Stalled: Reviewer hasn't taken the wake Combwork typed/.test((await tile.innerText().catch(() => '')) ?? ''), 8000)), await tile.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'loopwatch-stalled.png') })
  // Windows notifications only: each tell() also logs an `entry` line (HI-2320), not a second notice (HI-2369). Any line
  // counts for "isn't watching" below, a bell-only notice too.
  const told = () => notices().filter((n) => n.kind === 'notification' && /hasn't taken a line Combwork typed/.test(JSON.stringify(n)))
  check('one notice tells the user', !!(await until(async () => told().length === 1, 5000)), JSON.stringify(notices()))
  await lib.sleep(4000) // on purpose: longer than the grace, to see no second notice comes
  check('…only once, and none saying it isn\'t watching (#777)', told().length === 1 && !notices().some((n) => /isn't watching/.test(n.title ?? '')), JSON.stringify(notices()))
  await inv('pty:write', lib.ptyKey(alpha, reviewer.id), '\r')
  check('Enter sends the waiting line: the reviewer takes it', !!(await until(async () => wakes('Reviewer').length === 2, 10000)))
  check('…and the flag clears', !!(await until(async () => !(await stalledOf(c1)) && !(await live(reviewer.id))?.notWatching, 10000)), String(await stalledOf(c1)))
  check('…and stays clear while it watches again', !!(await until(async () => (await live(reviewer.id))?.status === 'watching', 10000)) && !(await stalledOf(c1)))

  // --- 2b. A card moved to another project after it was flagged (review round 1): the flag goes, it isn't the old
  // project's agent's any more. Cancelling the reviewer's watch leaves it idle with no watch, so #1 is flagged first.
  await inv('watch:cancel', alpha, reviewer.id)
  check('a cancelled watch: after the grace the card it left is flagged', !!(await until(async () => ((await stalledOf(c1)) ?? '').startsWith("Reviewer isn't watching #"), 15000)), String(await stalledOf(c1)))
  // Combwork's loop wake for #1, in Review since section 2 (#405), reaches the reviewer: read with whatever else its inbox
  // had when it read it (#650: in section 2, with the wake whose line it took then), and the reviewer is idle again before
  // anything else is typed to it, or the next line lands while it works and is lost (#571).
  const loopWake = `[CW] #${c1} (Builder's card) is in Review. You review this card in its loop`
  check("…and Combwork's loop wake for it reaches the reviewer, which is idle again", !!(await until(async () => wakes('Reviewer').some((w) => w.text.includes(loopWake)) && ['ready', 'finished'].includes((await live(reviewer.id))?.status), 15000)), `${JSON.stringify(wakes('Reviewer').map((w) => w.text.slice(0, 60)))} ${await why(reviewer.id)}`)
  await inv('tasks:update', c1, { project: 'beta' })
  check('moved to another project: no longer stalled, and the mark leaves the agent', !!(await until(async () => !(await stalledOf(c1)) && !(await live(reviewer.id))?.notWatching, 8000)), JSON.stringify({ stalled: await stalledOf(c1), mark: (await live(reviewer.id))?.notWatching }))

  // --- 2c. Moved to another project within the grace: never flagged.
  const c4 = (await inv('tasks:create', { title: 'Moved in the grace', project: 'alpha', agent: builder.id, column: 'review' })).number
  await say(reviewer.id, wait(c4, { changes: ['comment'] }))
  check('the reviewer watches #4', !!(await until(async () => (await live(reviewer.id))?.status === 'watching', HUNG_MS)), await why(reviewer.id))
  await inv('watch:cancel', alpha, reviewer.id)
  await inv('tasks:update', c4, { project: 'beta' })
  await lib.sleep(4500) // on purpose: longer than the grace, to see no flag comes
  check('moved within the grace: never flagged', !(await stalledOf(c4)) && !(await live(reviewer.id))?.notWatching, JSON.stringify({ stalled: await stalledOf(c4), mark: (await live(reviewer.id))?.notWatching }))

  // --- 3. An agent in a loop that ends its turn without starting a watch (said "watching", never did): its card in
  // Review is flagged the same way.
  const c2 = (await inv('tasks:create', { title: 'No watch after', project: 'alpha', agent: builder.id, column: 'review' })).number
  script('Builder', [`boardcomment ${c2}`])
  await say(builder.id, wait(c2, { changes: ['comment'] }))
  check('the builder watches #2', !!(await until(async () => (await live(builder.id))?.status === 'watching', HUNG_MS)), await why(builder.id))
  await inv('tasks:comment', c2, 'Round 1: failed. 1. Fix the greeting.')
  check('…is woken, comments and ends its turn with no watch', !!(await until(async () => wakes('Builder').length === 1 && ['ready', 'finished'].includes((await live(builder.id))?.status), 15000)))
  check('after the grace its card is stalled: Builder isn\'t watching it', !!(await until(async () => ((await stalledOf(c2)) ?? '').startsWith("Builder isn't watching #"), 15000)), String(await stalledOf(c2)))
  // Working clears it at once; idle again with no watch, it comes back after the grace.
  await say(builder.id, 'work 3')
  check('working again clears it', !!(await until(async () => (await live(builder.id))?.status === 'working' && !(await live(builder.id))?.notWatching && !(await stalledOf(c2)), 8000)))
  check('idle again with no watch: flagged again after the grace', !!(await until(async () => ((await stalledOf(c2)) ?? '').startsWith("Builder isn't watching #"), 20000)), String(await stalledOf(c2)))
  // Moved on (Passed): no longer in play, so no longer stalled.
  await inv('tasks:update', c2, { column: 'passed' })
  check('a card that has moved on (Passed) is no longer stalled', !!(await until(async () => !(await stalledOf(c2)), 8000)))

  // --- 4. HI-2080: a builder that asks the user on its card (cw_ask_user) and ends its turn with no watch waits for
  // the user, never stalled; once the user answers, the usual rule applies again.
  const c3 = (await inv('tasks:create', { title: 'Asks the user', project: 'alpha' })).number
  const started = await inv('tasks:move', c3, 'doing', { agent: builder.id })
  check('#3 starts on the builder', !!started.moved, JSON.stringify(started))
  script('Builder', [`hive cw_ask_user ${JSON.stringify({ card: `#${c3}`, kind: 'decide', text: 'Keep the old greeting?' })}`])
  await say(builder.id, wait(c3, { changes: ['comment'] }))
  check('the builder watches #3', !!(await until(async () => (await live(builder.id))?.status === 'watching', HUNG_MS)), await why(builder.id))
  await inv('tasks:comment', c3, 'Which greeting should it keep?')
  const question = async () => (await inv('tasks:forYou', 'alpha')).items.find((i) => i.card === c3 && i.asker === builder.id)
  check('…is woken, asks the user and ends its turn with no watch', !!(await until(async () => !!(await question()) && ['ready', 'finished'].includes((await live(builder.id))?.status) && !(await live(builder.id))?.watch, 15000)), `${JSON.stringify((await inv('tasks:forYou', 'alpha')).items)} ${await why(builder.id)}`)
  await lib.sleep(4500) // on purpose: longer than the grace, to see no flag comes
  check('waiting on its own question: never flagged (HI-2080)', !(await stalledOf(c3)) && !((await live(builder.id))?.notWatching ?? []).includes(c3), JSON.stringify({ stalled: await stalledOf(c3), mark: (await live(builder.id))?.notWatching }))
  await inv('tasks:answer', c3, (await question()).request, { outcome: 'answered', reply: 'Keep it.' })
  check('once the user answers, its card is the builder\'s move again: flagged after the grace', !!(await until(async () => ((await stalledOf(c3)) ?? '').startsWith("Builder isn't watching #"), 20000)), String(await stalledOf(c3)))

  // --- 5. HI-2381: an agent whose next card waits on another's card in progress (CB2 watching CB1's CL-8, which its CL-10
  // depends on). Its watch's limit says where they are and asks nothing of the user; ending its turn with no watch then
  // stalls nothing: CL-8's stall is its own builder's and reviewer's.
  const dep = (await inv('tasks:create', { title: 'Another builder works on it', project: 'alpha', agent: builder.id, column: 'doing' })).number
  const next = (await inv('tasks:create', { title: 'Waits on it', project: 'alpha' })).number
  await inv('tasks:update', next, { blockedBy: [dep] })
  script('Reviewer', [])
  const limitWakes = () => wakes('Reviewer').filter((w) => w.text.includes('your card watch has ended'))
  const before = limitWakes().length
  // Its grace checks so far (loops:checks: counted once a check has decided its mark): the next is the one after its turn ends.
  const checksBefore = await inv('loops:checks', alpha, reviewer.id)
  await say(reviewer.id, `hive cw_wait_for_tasks ${JSON.stringify({ cards: [`#${dep}`, `#${next}`], changes: ['column'], limitMinutes: 1, wake: true })}`)
  check('the reviewer watches the card and the one waiting on it', !!(await until(async () => (await live(reviewer.id))?.status === 'watching', HUNG_MS)), await why(reviewer.id))
  // The watch's limit is a minute: the wait is bounded at twice that.
  check('its limit passes: woken, then idle with no watch', !!(await until(async () => limitWakes().length > before && ['ready', 'finished'].includes((await live(reviewer.id))?.status) && !(await live(reviewer.id))?.watch, 120000)), `${JSON.stringify(limitWakes().map((w) => w.text))} ${await why(reviewer.id)}`)
  const limit = limitWakes().at(-1)?.text ?? ''
  check("…the line says what waits on what, and not to tell the user", limit.includes(`#${next} waits on #${dep}`) && limit.includes(`#${dep} is in Doing with Builder`) && limit.endsWith("don't tell the user about them.") && !/cw_notify/.test(limit), limit)
  check('…its grace check runs', !!(await until(async () => (await inv('loops:checks', alpha, reviewer.id)) > checksBefore, HUNG_MS)), String(await inv('loops:checks', alpha, reviewer.id)))
  check("another's card it waits on is never stalled for it (HI-2381)", !(await stalledOf(dep)) && !((await live(reviewer.id))?.notWatching ?? []).includes(dep), JSON.stringify({ stalled: await stalledOf(dep), mark: (await live(reviewer.id))?.notWatching }))

  // --- 5b. HI-2381 round 2: the blocker alone in the watch (its dependent card left out), with a reviewer of its own: still
  // its builder's and reviewer's, never the watcher's. Other builds it (never started: the card names it), Builder reviewed
  // it (a review started is its loop reviewer), and the Reviewer, which reviews neither, watches it and ends with none.
  const other = await lib.addAgent(inv, alpha, { name: 'Other' })
  const solo = (await inv('tasks:create', { title: "Another's, reviewed by another", project: 'alpha', agent: other.id, column: 'review' })).number
  const launches = () => {
    const f = path.join(claudeHome, 'fake-launches.jsonl')
    const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
    return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  }
  const builderSession = (await live(builder.id))?.sessionId
  const launch = launches().find((l) => l.sessionId === builderSession && l.opts['--mcp-config'])
  const hiveServer = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
  const builderToken = hiveServer ? JSON.parse(fs.readFileSync(hiveServer.env.CW_API_TOKEN_FILE, 'utf8')).token : null
  const reviewing = builderToken ? await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${encodeURIComponent(`#${solo}`)}/start-review`, { method: 'POST', headers: { Authorization: `Bearer ${builderToken}`, 'Content-Type': 'application/json' }, body: '{}' }) : null
  check('Builder starts reviewing it', reviewing?.status === 200, String(reviewing?.status))
  await inv('tasks:update', solo, { column: 'doing' })
  const soloBefore = await inv('loops:checks', alpha, reviewer.id)
  await say(reviewer.id, wait(solo, { changes: ['comment'] }))
  check('the reviewer watches it alone', !!(await until(async () => (await live(reviewer.id))?.status === 'watching', HUNG_MS)), await why(reviewer.id))
  await inv('watch:cancel', alpha, reviewer.id)
  check('…ends with no watch, and its grace check runs', !!(await until(async () => (await inv('loops:checks', alpha, reviewer.id)) > soloBefore, HUNG_MS)), String(await inv('loops:checks', alpha, reviewer.id)))
  // Its stall, if any, is its own builder's ("Other isn't running": never started here), never the Reviewer's.
  check("…and another's card with its own reviewer is never stalled for it", !/^Reviewer\b/.test((await stalledOf(solo)) ?? '') && !((await live(reviewer.id))?.notWatching ?? []).includes(solo), JSON.stringify({ stalled: await stalledOf(solo), mark: (await live(reviewer.id))?.notWatching }))

  // --- 5c. HR1's round 2: the blocker alone with no reviewer known (section 5's, Builder's in Doing): only its builder and
  // its reviewer owe it, so the watcher still isn't flagged (the Assistant's scope call: no exception for a missing reviewer).
  const depBefore = await inv('loops:checks', alpha, reviewer.id)
  await say(reviewer.id, wait(dep, { changes: ['comment'] }))
  check('the reviewer watches the blocker alone', !!(await until(async () => (await live(reviewer.id))?.status === 'watching', HUNG_MS)), await why(reviewer.id))
  await inv('watch:cancel', alpha, reviewer.id)
  check('…ends with no watch, and its grace check runs', !!(await until(async () => (await inv('loops:checks', alpha, reviewer.id)) > depBefore, HUNG_MS)), String(await inv('loops:checks', alpha, reviewer.id)))
  check('…and a card with no reviewer is never stalled for an agent that only watches it', !/^Reviewer\b/.test((await stalledOf(dep)) ?? '') && !((await live(reviewer.id))?.notWatching ?? []).includes(dep), JSON.stringify({ stalled: await stalledOf(dep), mark: (await live(reviewer.id))?.notWatching }))

  await inv('session:stop', alpha)
  await until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
