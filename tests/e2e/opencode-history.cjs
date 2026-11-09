// OpenCode agents' history, tokens, cost and plan limits (HI-2762), through Combwork with the fake opencode (HI-2763, its
// 2.2.6 recordings): a turn typed into the agent's pane shows in the Sessions tab's transcript (the prompt, the reply, a
// tool call) once Combwork has read the session from the agent's server, off main's thread; its usage is the session's
// own (the title's request included, which no message shows), its cost OpenCode's $0, said in the footer's hover to be no
// measure of a plan's allowance; usage/limits answers no Console sign-in, so the Overview says OpenCode's plan limits
// aren't available, with no meter; stopped, the session is exported once and its history stays, read again after a
// restart. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'opencode-history-profile')
const ws = path.join(lib.WORK, 'opencode-history-ws')
const alpha = path.join(ws, 'alpha')
const fakeLog = path.join(lib.WORK, 'opencode-history-fake.jsonl')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
const turnEnds = () => lines().filter((e) => e.kind === 'turn-end')
const http = (pred) => lines().filter((e) => e.kind === 'http' && pred(e))

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

  const env = { FAKE_OPENCODE_LOG: fakeLog, CW_TEST_CLI_HOME_CONNECTION: '0' }
  let { app, page } = await lib.launch({ userData, env, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    let inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'opencode')
    await lib.openWorkspace(inv, page, ws)
    const fake = path.join(__dirname, 'fake-opencode', 'opencode.cmd')
    const selected = await lib.until(async () => (await inv('provider:refresh', 'opencode'))?.opencode?.path ?? null, HUNG_MS)
    if (String(selected ?? '').toLowerCase() !== fake.toLowerCase()) {
      console.log(`FAIL stopped before any session: Combwork selected ${selected ?? 'no opencode'}, not the fake`)
      process.exitCode = 1
      return
    }
    const account = await inv('connections:add', 'opencode', 'OpenCode · History')
    await inv('connections:setOn', account.id, true)
    const agent = await lib.addAgent(inv, alpha, { name: 'Oc', provider: 'opencode' })
    const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id && s.status !== 'stopped') ?? null
    const key = lib.ptyKey(alpha, agent.id)
    const type = async (text) => {
      await inv('pty:write', key, text)
      await inv('pty:write', key, '\r')
    }

    await inv('session:start', alpha, { agentId: agent.id })
    await lib.until(async () => lines().some((e) => e.kind === 'tui'), HUNG_MS)
    const sid = (await lib.until(async () => (await live())?.sessionId ?? null, HUNG_MS)) ?? ''
    check('the agent has its session', sid.startsWith('ses_'), sid)

    // --- Two turns: a reply, and a tool call through Code Mode's execute.
    let ends = turnEnds().length
    await type('hello')
    await lib.until(async () => turnEnds().length > ends, HUNG_MS)
    ends = turnEnds().length
    await type('tool history-marker')
    await lib.until(async () => turnEnds().length > ends, HUNG_MS)

    // --- The transcript, read from the agent's server (its poll or the turn's end).
    const items = async () => (await inv('transcript:read', alpha, sid).catch(() => null))?.items ?? []
    const shown = await lib.until(async () => {
      const i = await items()
      return i.some((x) => x.kind === 'tool') && i.filter((x) => x.kind === 'user').length >= 2 ? i : null
    }, HUNG_MS)
    const all = shown ?? (await items())
    check('the Sessions tab shows the conversation: its prompts', ['hello', 'tool history-marker'].every((t) => all.some((x) => x.kind === 'user' && x.text === t)), JSON.stringify(all.map((x) => x.kind)))
    check('…the replies', all.some((x) => x.kind === 'assistant' && /hello/.test(x.text)), JSON.stringify(all.filter((x) => x.kind === 'assistant').map((x) => x.text)))
    check('…and the tool call, with its result', all.some((x) => x.kind === 'tool' && x.tool?.name === 'execute' && /history-marker/.test(x.tool?.result ?? '')), JSON.stringify(all.filter((x) => x.kind === 'tool').map((x) => x.tool)))
    check("…read through the server's settled reads (the log's watermark, the session, its messages by page)", http((e) => e.path.endsWith('/log')).length >= 2 && http((e) => e.path.endsWith('/message')).length >= 1, JSON.stringify(http((e) => /\/api\/(experimental\/)?session\//.test(e.path)).map((e) => e.path).slice(-6)))

    // --- Usage: the session's own totals, its title's request included; OpenCode's cost, $0, not an estimate.
    const usage = await lib.until(async () => {
      const u = await inv('session:usage', alpha, sid)
      return u && u.requests >= 3 ? u : null
    }, HUNG_MS)
    check("usage: every request of the session's messages", !!usage && usage.requests >= 3, JSON.stringify(usage && { requests: usage.requests, in: usage.inputTokens }))
    // The fake's title request (457 in, 312 out: HI-2762's R0) is in the session's tokens, in none of its messages.
    check("…the session's tokens, its title's request included (457 more input than its messages)", !!usage && usage.inputTokens >= 457 + 200 && usage.outputTokens >= 312, JSON.stringify(usage && { in: usage.inputTokens, out: usage.outputTokens }))
    check('…its cost as OpenCode reports it: $0, not estimated', !!usage && usage.costUsd === 0 && usage.costEstimated === false, JSON.stringify(usage && { cost: usage.costUsd, estimated: usage.costEstimated }))

    // --- The footer's cost: $0, its hover saying $0 is no measure of the plan's allowance.
    await page.locator('.tabs .tab', { hasText: 'Session' }).first().click().catch(() => undefined)
    const cost = page.locator('.foot-cost').first()
    const costShown = await lib.until(async () => ((await cost.count()) ? /\$0/.test(await cost.innerText()) : false), HUNG_MS)
    check("the pane's footer shows the cost, $0", !!costShown, (await cost.count()) ? await cost.innerText() : 'no cost in the footer')
    await cost.hover().catch(() => undefined)
    const tip = page.locator('.tip', { hasText: 'reported this session’s cost as $0' })
    check('…its hover says OpenCode reported $0, which is no measure of the allowance', !!(await lib.until(async () => (await tip.count()) >= 1, HUNG_MS)))

    // --- Plan limits: usage/limits asked of the agent's server, no Console sign-in, so none: the Overview says why.
    check("the agent's server was asked for its usage limits", !!(await lib.until(async () => http((e) => e.path === '/api/experimental/usage/limits').length >= 1, HUNG_MS)))
    check('…and Combwork kept none for the account', !(await inv('app:connectionPlanUsage'))[account.id])
    await page.locator('.tabs .tab', { hasText: 'Overview' }).first().click()
    const none = page.locator('.plan-connection-limits', { hasText: 'OpenCode reports plan limits only for an OpenCode Go or Console workspace' })
    check('the Overview says OpenCode reports limits only for OpenCode Go or Console, with no meter', !!(await lib.until(async () => (await none.count()) >= 1, HUNG_MS)) && (await none.first().locator('.meter').count()) === 0)

    // --- Stopped: one export of the session, standalone; its history stays.
    const exports = () => lines().filter((e) => e.kind === 'launch' && /session export/.test((e.args ?? []).join(' ')))
    await inv('session:stop', alpha, agent.id)
    await lib.until(async () => !(await live()), HUNG_MS)
    const exported = await lib.until(async () => (exports().length ? exports() : null), HUNG_MS)
    check('stopped, the session is exported once, standalone', !!exported && exported.length === 1 && (exported[0].args ?? []).includes('--standalone'), JSON.stringify(lines().filter((e) => e.kind === 'launch').map((e) => e.args)))
    check('…and its history stays', (await items()).filter((x) => x.kind === 'user').length >= 2)

    // --- After a restart, the history is read from Combwork's mirror, no server needed.
    await app.close().catch(() => undefined)
    ;({ app, page } = await lib.launch({ userData, env, viewport: { width: 1400, height: 900 } }))
    inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const again = await lib.until(async () => {
      const t = (await inv('transcript:read', alpha, sid).catch(() => null))?.items ?? []
      return t.filter((x) => x.kind === 'user').length >= 2 ? t : null
    }, HUNG_MS)
    check('after a restart, the session’s history shows again', !!again)
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
