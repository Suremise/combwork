// OpenCode agents' status from their server's event stream (HI-2760), through Combwork with the fake opencode (HI-2763,
// its 2.2.6 recordings): typed into the agent's pane, a prompt makes it working and its end finished; a permission asked
// makes it need you until answered in the pane; a failed turn ends finished, failed; an interrupt (Esc) leaves it ready;
// a stream dropped mid-turn, the turn ending meanwhile, ends finished through the settled snapshot after the reconnect.
// Each against what the fake's TUI shows in the pane. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'opencode-status-profile')
const ws = path.join(lib.WORK, 'opencode-status-ws')
const alpha = path.join(ws, 'alpha')
const fakeLog = path.join(lib.WORK, 'opencode-status-fake.jsonl')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
const turnEnds = () => lines().filter((e) => e.kind === 'turn-end')

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(fakeLog, { force: true })
  fs.mkdirSync(userData, { recursive: true })
  lib.gitProject(alpha)
  lib.enableProviders(userData, ['claude-code', 'opencode'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.opencode = { ...cfg.settings.providers.opencode, executablePath: path.join(__dirname, 'fake-opencode', 'opencode.cmd') }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const { app, page } = await lib.launch({ userData, env: { FAKE_OPENCODE_LOG: fakeLog, CW_TEST_CLI_HOME_CONNECTION: '0' }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'opencode')
    await lib.openWorkspace(inv, page, ws)
    const fake = path.join(__dirname, 'fake-opencode', 'opencode.cmd')
    const selected = await lib.until(async () => (await inv('provider:refresh', 'opencode'))?.opencode?.path ?? null, HUNG_MS)
    if (String(selected ?? '').toLowerCase() !== fake.toLowerCase()) {
      console.log(`FAIL stopped before any session: Combwork selected ${selected ?? 'no opencode'}, not the fake`)
      process.exitCode = 1
      return
    }
    const account = await inv('connections:add', 'opencode', 'OpenCode · Status')
    await inv('connections:setOn', account.id, true)
    const agent = await lib.addAgent(inv, alpha, { name: 'Oc', provider: 'opencode' })
    const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id && s.status !== 'stopped') ?? null
    const key = lib.ptyKey(alpha, agent.id)
    const screen = async () => lib.plainText((await inv('pty:buffer', key).catch(() => '')) ?? '')
    const type = async (text) => {
      await inv('pty:write', key, text)
      await inv('pty:write', key, '\r')
    }
    /** Waits for the agent's status, returning it, or the last one seen when it never came. */
    const statusIs = async (want) => {
      let last = null
      const got = await lib.until(async () => {
        last = (await live())?.status ?? null
        return want.includes(last) ? last : null
      }, HUNG_MS)
      return got ?? last
    }

    await inv('session:start', alpha, { agentId: agent.id })
    await lib.until(async () => lines().some((e) => e.kind === 'tui'), HUNG_MS)
    await lib.until(async () => /OpenCode|session/i.test(await screen()), HUNG_MS)

    // --- A prompt: working, then finished, as the TUI shows its reply.
    let ends = turnEnds().length
    await type('hello')
    const s1 = await statusIs(['working', 'finished'])
    check('a prompt typed in the pane makes the agent working (or already finished)', s1 === 'working' || s1 === 'finished', String(s1))
    await lib.until(async () => turnEnds().length > ends, HUNG_MS)
    // The hook post and the TUI's output are separate streams: both are waited for together, and checked as one look saw them.
    let seen = null
    const replied = await lib.until(async () => {
      seen = { status: (await live())?.status ?? null, screen: await screen() }
      return seen.status === 'finished' && /Done: hello/.test(seen.screen)
    }, HUNG_MS)
    check('…and finished at its end, as the TUI shows the reply', !!replied, JSON.stringify({ status: seen?.status, screen: seen?.screen.slice(-400) }))

    // --- A permission: needs you while it asks, working once answered in the pane, finished.
    ends = turnEnds().length
    await type('needs approval')
    const asked = await statusIs(['waiting'])
    check('a permission asked: the agent needs you', asked === 'waiting', String(asked))
    const live1 = await live()
    check('…saying what it asks for', /shell/i.test(live1?.statusMessage ?? JSON.stringify(live1?.question ?? '')), JSON.stringify({ message: live1?.statusMessage }))
    await type('y')
    await lib.until(async () => turnEnds().length > ends, HUNG_MS)
    check('…answered in the pane, the turn goes on and ends finished', (await statusIs(['finished'])) === 'finished')

    // --- A failed turn: finished, its failure said.
    ends = turnEnds().length
    await type('fail')
    await lib.until(async () => turnEnds().length > ends, HUNG_MS)
    // Finished and its failure, from the same look at the session (the hook post may land after the fake's log line).
    let f = null
    const failedSeen = await lib.until(async () => {
      f = await live()
      return f?.status === 'finished' && !!(f.failedTurn || /refused|fail/i.test(f.statusMessage ?? ''))
    }, HUNG_MS)
    check('a failed turn ends finished, failed', !!failedSeen, JSON.stringify({ status: f?.status, msg: f?.statusMessage, failed: f?.failedTurn }))

    // --- An interrupt: Esc in the pane while it works; ready again.
    ends = turnEnds().length
    await type('slow')
    await statusIs(['working'])
    await inv('pty:write', key, '\x1b')
    await lib.until(async () => turnEnds().length > ends, HUNG_MS)
    const after = await statusIs(['ready', 'finished', 'interrupted'])
    check('an interrupt (Esc) ends the turn: the agent is no longer working', after !== 'working', String(after))
    check('…as OpenCode recorded it', turnEnds().at(-1)?.outcome === 'interrupted', JSON.stringify(turnEnds().at(-1)))

    // --- The stream dropped mid-turn: the turn ends meanwhile; the settled snapshot after the reconnect ends it.
    ends = turnEnds().length
    await type('drop events')
    await lib.until(async () => turnEnds().length > ends, HUNG_MS)
    check('a stream dropped mid-turn: finished after the reconnect, from the settled snapshot', (await statusIs(['finished'])) === 'finished')
    check("…and the launcher's event stream reconnected (a second subscription)", lines().filter((e) => e.kind === 'http' && e.method === 'GET' && e.path === '/api/event').length >= 2, JSON.stringify(lines().filter((e) => e.kind === 'http' && e.path === '/api/event').length))

    await inv('session:stop', alpha, agent.id)
    await lib.until(async () => !(await live()), HUNG_MS)
    check('the fake logged no errors', !lines().some((e) => e.kind === 'error'), JSON.stringify(lines().filter((e) => e.kind === 'error')))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
