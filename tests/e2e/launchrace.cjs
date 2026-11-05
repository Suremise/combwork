// Closing a workspace while one of its agents is still starting cancels the start: no CLI process is left
// running for a workspace that is no longer open. Dev build, throwaway profile and workspace; the agent runs the fake
// Claude Code (fake-claude/, #194): the race is in Combwork's start, before the CLI runs.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'launchrace-profile')
const ws = path.join(lib.WORK, 'launchrace-ws')
const proj = path.join(ws, 'demo')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  const claude = lib.fakeClaude(userData, path.join(lib.WORK, 'launchrace-claude-home'), [proj])
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47895), ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const agent = await lib.soloAgent(inv, proj)

  // Start and close in the same moment: the close must see the start in progress and cancel it.
  const [start, close] = await page.evaluate(
    ([p, id]) =>
      Promise.allSettled([window.combwork.invoke('session:start', p, { agentId: id }), window.combwork.invoke('workspace:close')]).then((r) =>
        r.map((x) => (x.status === 'fulfilled' ? { ok: true, value: x.value } : { ok: false, error: String(x.reason?.message ?? x.reason) }))
      ),
    [proj, agent.id]
  )
  check('the workspace closed', close.ok && close.value === true, JSON.stringify(close))
  check('the start was cancelled', !start.ok && /stopped before it had started/.test(start.error), JSON.stringify(start).slice(0, 200))
  await lib.sleep(4000) // A fixed wait on purpose: this checks that the cancelled start does NOT start an agent later.
  const live = await inv('session:live')
  check('no agent is running afterwards', live.length === 0, JSON.stringify(live).slice(0, 200))

  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
