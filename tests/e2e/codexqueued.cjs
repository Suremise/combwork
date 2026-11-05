// A Codex line taken as queued input (#1514), on a fake Codex agent (fake-codex/): on 23 Oct Codex reviewers compacted
// at a turn's start, sending no hook meanwhile; Combwork took them for idle and typed a doorbell, which Codex queued and took
// in that turn with no UserPromptSubmit. The agent read its inbox eight seconds later, yet Combwork pressed Enter again, marked
// the line not taken and refused every prompt until someone pressed Enter on an empty composer. Here the fake compacts
// for a while ("compacting N", fake-queue-<agent>): the doorbell Combwork types meanwhile is read in that turn, Combwork counts it
// taken (what it rang for was read), marks nothing, and types the next line as usual. Dev build,
// throwaway profile, workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const userData = path.join(lib.WORK, 'codexqueued-profile')
const ws = path.join(lib.WORK, 'codexqueued-ws')
const claudeHome = path.join(lib.WORK, 'codexqueued-claude-home')
const codexHome = path.join(lib.WORK, 'codexqueued-codex-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47861))
const API = `http://127.0.0.1:${PORT}`
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(alpha)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // The Assistant's fake (which leaves the message) runs in the workspace's folder: trusted.
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), ws.toLowerCase()]))
  // The Codex agent reads its inbox and acks what it listed, as a model does, and queues what is typed while it works.
  fs.writeFileSync(path.join(codexHome, 'fake-follow-notices.txt'), '')
  fs.writeFileSync(path.join(codexHome, 'fake-queue-Codex'), '')

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1300, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    const say = async (id, text) => {
      await inv('pty:write', lib.ptyKey(alpha, id), text)
      await lib.sleep(300)
      await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    }
    const wakes = () => lines(path.join(codexHome, 'fake-wakes.jsonl')).filter((w) => w.agent === 'Codex')
    const hiveLog = () => (fs.existsSync(path.join(userData, 'logs', 'combwork.log')) ? fs.readFileSync(path.join(userData, 'logs', 'combwork.log'), 'utf8') : '')

    await page.getByText('alpha', { exact: true }).first().click()
    const codex = await lib.addAgent(inv, alpha, { name: 'Codex', provider: 'codex', permissionMode: 'approve-for-me' })
    await inv('session:start', alpha, { agentId: codex.id })
    check('the Codex agent starts', !!(await until(() => idle(codex.id), HUNG_MS)))

    // Messages are left as the Assistant leaves them (cw_message_agent, with its token).
    const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    await until(async () => (await inv('session:live')).some((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.status === 'ready'), HUNG_MS)
    const tool = (name, args) => {
      const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], {
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
        env: lib.childEnv({ CW_API_URL: API, CW_WORKSPACE: ws, HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'projects', CW_API_TOKEN_FILE: asTokenFile, HIVE_API_TOKEN: '', CW_PROJECT: '' }),
        timeout: 60000
      }).toString()
      const r = JSON.parse(out.split('\n')[0]).result
      return { text: r.content[0].text, isError: !!r.isError }
    }
    const leave = (text) => /\((m\d+)/.exec(tool('cw_message_agent', { project: 'alpha', agent: 'Codex', text }).text)?.[1] ?? null
    const delivery = (id) => JSON.parse(tool('cw_agent_activity', { project: 'alpha', agent: 'Codex', detail: true }).text).inbox?.deliveries?.find((d) => d.id === id) ?? null

    // A turn that compacts for 25 s with no hook: Combwork sees no prompt, so the agent looks idle, and the doorbell for a
    // message left meanwhile is typed into it; Codex queues it and takes it once it has compacted.
    await say(codex.id, 'compacting 25')
    const m1 = leave('Review #166 next.')
    check('a message is left for it', !!m1, String(m1))
    check('…and its doorbell is typed while it compacts, Combwork seeing no turn', !!(await until(() => /Deliveries m\d+ for .* offered/.test(hiveLog()) && wakes().length === 0, HUNG_MS)), hiveLog().slice(-800))
    check('the agent reads it in that turn, with no prompt Combwork saw', !!(await until(() => wakes().some((w) => w.queued && w.text.includes('Review #166 next.')), HUNG_MS)), JSON.stringify(wakes()))
    check('…and Combwork counts the line taken: what it rang for was read', !!(await until(() => /The wake typed into .* was taken after \d+ ms: what it rang for was read, with no prompt seen/.test(hiveLog()), HUNG_MS)), hiveLog().slice(-1200))
    check('the message is read', ['received', 'acked'].includes(delivery(m1)?.state), JSON.stringify(delivery(m1)))
    check('its turn ends and it is idle', !!(await until(() => idle(codex.id), HUNG_MS)), JSON.stringify(await live(codex.id)))
    // No mark: nothing was left in its composer, and Combwork doesn't believe otherwise. (An Enter again while it compacts,
    // past the first 10 s, is #376's, on an empty composer.)
    const after = await live(codex.id)
    check('no mark that a line was not taken', !after?.untakenLine && !/still wasn't taken|Enter couldn't be pressed again/.test(hiveLog()), JSON.stringify({ untaken: after?.untakenLine, log: hiveLog().match(/.*wasn't taken.*/g) }))
    // The next line is typed as usual, and read.
    const m2 = leave('Then #167.')
    check('the next doorbell is typed and read as usual', !!(await until(() => wakes().some((w) => w.text.includes('Then #167.')), HUNG_MS)), JSON.stringify(wakes()))
    check('…and still no mark', !(await live(codex.id))?.untakenLine && ['received', 'acked'].includes(delivery(m2)?.state), JSON.stringify(delivery(m2)))
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
