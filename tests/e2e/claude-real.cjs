// What only the real Claude Code can show, from suites whose Combwork-side checks run the fake (#195): no prompt is sent.
// - A session starts in a worktree agent's worktree (agents checks the rest of worktree agents with the fake).
// - A relaunch with a changed setting (Restart session after a new effort) is taken by Claude Code, bringing the same
//   session back (restart checks Combwork's side with the fake).
// - The Assistant's launch is taken by Claude Code in the workspace folder, asking for Auto, with Haiku. Whether Claude
//   Code runs Haiku in Auto depends on its version and the account (#129): its initialize reply says (supportsAutoMode).
//   Combwork must show the mode the session really runs in, whichever that is, and warn exactly when Auto isn't offered:
//   Auto when it says Haiku takes Auto, else Manual (2.1.286 and 2.1.289 run it in Manual); either when it doesn't say
//   (assistant checks the rest with the fake).
// Each wait on the CLI is a lib.cliStep: a usage limit, sign-in or network failure there makes the suite a SKIP.
// Dev build, throwaway profile and workspace; the real Claude Code in a home of the suite's own with a made-up API key
// (lib.ownClaudeHome, #368: never the user's ~/.claude). No prompt is sent, so it needs no sign-in.
// Dev build only (#1580): it starts this checkout's Electron itself, and Reviewer is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build), for a real session in a worktree.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'claude-real-profile')
// Outside the repository, so its CLAUDE.md (which imports AGENTS.md) doesn't apply to the test sessions (#174).
const ws = path.join(lib.WORK, 'claude-real-ws')
const wtRoot = `${ws}.worktrees`
const proj = path.join(ws, 'demo')
const home = path.join(ws, '.combwork', 'assistant')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, wtRoot]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(proj, { 'README.md': '# Demo\n' })
  lib.enableProviders(userData)
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47925), ...lib.ownClaudeHome('claude-real').env })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  await page.getByText('demo', { exact: true }).first().click()
  const live = async (host, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === host.toLowerCase() && s.agentId === id)
  const ready = (host, id, ms = 60000) => lib.until(async () => (await live(host, id))?.status === 'ready', ms, 400)
  const stop = async (host, id) => {
    await inv('session:stop', host, id)
    await lib.until(async () => !(await live(host, id)), 20000)
  }
  /** Combwork's last launch line for a session key (its log marks the key and ids as the user's text: found by their parts). */
  const launchLine = (key) => fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8').split('\n').filter((l) => / spawn \W?session:/.test(l) && l.toLowerCase().includes(key)).pop() ?? ''

  // --- A session in a worktree.
  const reviewer = await inv('agents:testLegacy', proj, { location: 'new-worktree', name: 'Reviewer' })
  const wtPath = reviewer.worktree?.path ?? ''
  await inv('session:start', proj, { agentId: reviewer.id })
  await lib.cliStep('a session starts in the worktree', { session: lib.ptyKey(proj, reviewer.id) }, async () => {
    await lib.acceptClaudeTrust(inv, proj, reviewer.id, 30000)
    const ok = !!(await ready(proj, reviewer.id))
    check('Claude Code starts in a worktree agent', ok, (await live(proj, reviewer.id))?.status)
    // What Claude Code said, when it didn't start (#218): its terminal's last words.
    if (!ok) console.log(`(its terminal: …${lib.plainText(await inv('pty:buffer', lib.ptyKey(proj, reviewer.id)).catch(() => '')).slice(-1500)})`)
  })
  const l = await live(proj, reviewer.id)
  check('…in its worktree', !!wtPath && path.resolve(l?.cwd ?? '').toLowerCase() === path.resolve(wtPath).toLowerCase(), `${l?.cwd} vs ${wtPath}`)
  await stop(proj, reviewer.id)

  // --- Restart session with a new effort: Claude Code takes the relaunch, the same session.
  // The project's only agent, so its pane (where Restart session is offered) is the one on screen.
  const agent = await lib.soloAgent(inv, proj, { name: 'Coder' })
  await inv('workspace:refresh')
  const st = await inv('session:start', proj, { agentId: agent.id, name: 'restart test' })
  await lib.cliStep('a session starts', { session: lib.ptyKey(proj, agent.id) }, async () => {
    await lib.acceptClaudeTrust(inv, proj, agent.id, 30000)
    check('Claude Code starts in the project', !!(await ready(proj, agent.id)), (await live(proj, agent.id))?.status)
  })
  // The agent's own effort (a project's isn't read for a CLI with connections, HI-1774).
  await lib.setLaunch(inv, proj, agent.id, { effort: 'low' })
  await inv('workspace:refresh')
  const restart = page.getByRole('button', { name: 'Restart session' })
  check('a new effort offers Restart session', !!(await lib.until(async () => (await restart.count()) > 0, 10000)))
  const launched = () => fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8').split('\n').filter((line) => / spawn \W?session:/.test(line) && line.toLowerCase().includes(`#${agent.id.toLowerCase()}`)).length
  const before = launched()
  await restart.first().click()
  await lib.cliStep('the relaunch with the new effort', { session: lib.ptyKey(proj, agent.id) }, async () => {
    // A relaunch soon after the first start can be asked to trust the folder again (its "Yes" not saved yet, #283):
    // answered once the relaunch's own process runs (until then the terminal holds the first session's screen).
    // A relaunch that never spawns fails here, with nothing read or typed in the old terminal (#341).
    const spawned = !!(await lib.until(async () => launched() > before, 20000))
    check('the restart starts a new Claude Code process', spawned, `launches: ${launched()}, before: ${before}`)
    if (!spawned) return
    // One wait for the relaunch to be ready, answering the trust question whenever its process asks (#323): it could
    // ask after a fixed window for it had passed (a slow start right after a full run), and nobody answered it then.
    // Since the spawn the terminal holds only the new process's output, so the question there is its own. The budget is
    // the two waits' it replaces (30 s + 60 s).
    const key = lib.ptyKey(proj, agent.id)
    let trusted = false
    const relaunched = !!(await lib.until(
      async () => {
        if ((await restart.count()) === 0 && (await live(proj, agent.id))?.status === 'ready') return true
        if (!trusted && /trust this folder/i.test(lib.plainText(await inv('pty:buffer', key).catch(() => '')))) {
          trusted = await lib.acceptClaudeTrust(inv, proj, agent.id, 30000)
          if (trusted) console.log('(the relaunch asked to trust the folder again: answered yes)')
        }
        return false
      },
      90000,
      400
    ))
    check('Claude Code takes the relaunch', relaunched, (await live(proj, agent.id))?.status)
    // What Claude Code said when it didn't come back ready: its terminal's last words.
    if (!relaunched) console.log(`(its terminal: …${lib.plainText(await inv('pty:buffer', key).catch(() => '')).slice(-1500)})`)
  })
  const relaunch = launchLine(`#${agent.id.toLowerCase()}`)
  // Nothing typed yet, Claude Code has no transcript to resume: Combwork starts the same session id again (--session-id);
  // the fake writes one at once, so restart sees the --resume path.
  check('…which was launched with the new effort, for the same session', relaunch.includes('"--effort","low"') && new RegExp(`"--(session-id|resume)","\\W?${st.sessionId}\\W?"`).test(relaunch), relaunch.slice(0, 300))
  check('…and brought the same conversation back', (await live(proj, agent.id))?.sessionId === st.sessionId, (await live(proj, agent.id))?.sessionId)
  await stop(proj, agent.id)

  // --- The Assistant with Haiku: launched asking for Auto; what Claude Code runs it in, and what Combwork shows and says.
  // Its model is its connection's (HI-2108; Settings → Assistant's old one is only read by the migration): HI-2145.
  await lib.setLaunch(inv, home, 'assistant', { model: 'haiku' })
  await inv('session:start', home, { agentId: 'assistant' })
  await lib.cliStep('the Assistant starts', { session: lib.ptyKey(home, 'assistant') }, async () => {
    await lib.acceptClaudeTrust(inv, home, 'assistant', 30000)
    check('Claude Code takes the Assistant’s launch', !!(await ready(home, 'assistant')), (await live(home, 'assistant'))?.status)
  })
  const a = await live(home, 'assistant')
  check('…in the workspace folder', a?.cwd.toLowerCase() === ws.toLowerCase(), a?.cwd)
  check('…asking for Auto, with Haiku', launchLine('assistant#assistant').includes('"--permission-mode","auto"') && launchLine('assistant#assistant').includes('"--model","haiku"'))
  // The mode Claude Code itself showed (its footer or a hook: never the one asked for at launch), and Combwork's (#234).
  let m = null
  await lib.cliStep('Claude Code shows its mode', { session: lib.ptyKey(home, 'assistant') }, async () => {
    m = await lib.haikuAutoMode(inv, home)
    console.log(`Claude Code ${m.version}: Haiku ${m.autoOffered === undefined ? "doesn't say whether it takes" : m.autoOffered ? 'takes' : "doesn't take"} Auto; it showed ${m.observed ?? 'no mode'}`)
    check(`with Haiku, Claude Code shows the mode it says (${m.expected.join(' or ')})`, m.expected.includes(m.observed), m.observed ?? 'none shown')
    check('…and Combwork shows that mode', !!m.observed && m.shown === m.observed, `${m.shown} / ${m.observed}`)
  })
  // The warning matches what this Claude Code says: there exactly when Auto isn't offered (a guess when it doesn't say).
  const [caveatRight, caveat] = await lib.haikuAutoCaveat(page, m?.autoOffered)
  check("the connection dialog warns about Auto with Haiku exactly when Claude Code says it isn't offered", caveatRight, caveat)
  await stop(home, 'assistant')

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.stack ?? e)
  process.exit(1)
})
