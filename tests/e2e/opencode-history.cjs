// OpenCode agents' history, tokens, cost and plan limits (HI-2762), through Combwork with the fake opencode (HI-2763, its
// 2.2.6 recordings): a turn typed into the agent's pane shows in the Sessions tab's transcript (the prompt, the reply, a
// tool call) once Combwork has read the session from the agent's server, off main's thread; its usage is the session's
// own (the title's request included, which no message shows), its cost OpenCode's $0, said in the footer's hover to be no
// measure of a plan's allowance; usage/limits answers no Console sign-in, so the Overview says OpenCode's plan limits
// aren't available, with no meter; a subagent's session (HI-2773) is listed under the agent's with its own conversation and
// usage, counted once; stopped, the session is exported once and its history stays, read again after a restart, its
// subagent's too. Dev build, throwaway profile and workspace.
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
    const agent = await lib.addAgent(inv, alpha, { name: 'Oc', provider: 'opencode', model: 'opencode/big-pickle' })
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

    // --- A subagent (HI-2773, 2.2.6's `subagent` tool as recorded): its own session, listed under the agent's with its own
    // conversation and usage, its tokens counted once (the parent's are its own steps' and its title's only).
    ends = turnEnds().length
    await type('subagent: say pong')
    await lib.until(async () => turnEnds().length > ends, HUNG_MS)
    const childId = (await lib.until(async () => lines().find((e) => e.kind === 'subagent')?.child ?? null, HUNG_MS)) ?? ''
    const childRow = await lib.until(async () => {
      const r = (await inv('session:list', alpha)).find((s) => s.id === childId)
      return r?.usage?.requests ? r : null
    }, HUNG_MS)
    check("the subagent's session is listed under the agent's, as a subagent", !!childRow && childRow.sub?.parentId === sid && childRow.sub?.kind === 'subagent' && childRow.provider === 'opencode', JSON.stringify(childRow && { sub: childRow.sub, provider: childRow.provider }))
    const childItems = await lib.until(async () => {
      const t = (await inv('transcript:read', alpha, childId).catch(() => null))?.items ?? []
      return t.some((x) => x.kind === 'assistant') ? t : null
    }, HUNG_MS)
    check('…with its own conversation: the prompt OpenCode gave it and its reply', !!childItems && childItems.some((x) => x.kind === 'user' && /subagent spawned by another session/.test(x.text)) && childItems.some((x) => x.kind === 'assistant' && /say pong/.test(x.text)), JSON.stringify((childItems ?? []).map((x) => x.kind)))
    check('…and its own usage: its one request, 1196 input tokens', !!childRow && childRow.usage.requests === 1 && childRow.usage.inputTokens === 1196, JSON.stringify(childRow?.usage && { requests: childRow.usage.requests, in: childRow.usage.inputTokens }))
    // The parent's: its title's 457 and its five steps' (200; 200, 300; 200, 300), never the subagent's 1196 as well.
    const parentUsage = await lib.until(async () => {
      const u = await inv('session:usage', alpha, sid)
      return u && u.requests >= 5 ? u : null
    }, HUNG_MS)
    check("…counted once: the agent's session's tokens are its own, without the subagent's", !!parentUsage && parentUsage.inputTokens === 457 + 200 + 500 + 500, JSON.stringify(parentUsage && { requests: parentUsage.requests, in: parentUsage.inputTokens }))

    // --- HI-2774: the TUI's /fork and /new (the fake's stand-ins), found after the run; then an attached image, which a
    // text-only model refuses, as 2.2.6 did with qwen3 (the last turn here: every later one would be refused too).
    ends = turnEnds().length
    await type('fork then newsession: hello from the tui')
    await lib.until(async () => turnEnds().length >= ends + 2, HUNG_MS)
    const forkId = lines().find((e) => e.kind === 'fork')?.fork ?? ''
    const newId = lines().filter((e) => e.kind === 'session' && e.created !== sid).map((e) => e.created).pop() ?? ''
    check('the TUI made a fork and a new session (fake stand-ins)', forkId.startsWith('ses_') && newId.startsWith('ses_') && newId !== forkId, JSON.stringify({ forkId, newId }))
    fs.writeFileSync(path.join(alpha, 'img.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII=', 'base64'))
    ends = turnEnds().length
    await type('attach:img.png what colour is this?')
    await lib.until(async () => turnEnds().length > ends, HUNG_MS)
    const withImage = await lib.until(async () => {
      const t = await items()
      const u = t.find((x) => x.kind === 'user' && x.text === 'what colour is this?')
      return u && u.images?.length ? { t, u } : null
    }, HUNG_MS)
    const url = withImage ? await inv('transcript:image', alpha, sid, withImage.u.images[0].id).catch((e) => String(e)) : null
    check('the attached image shows in the history, from the session\'s own data', typeof url === 'string' && url.startsWith('data:image/png;base64,iVBOR'), String(url).slice(0, 80))
    check("…and OpenCode's refusal from a text-only model, in its words", !!withImage && withImage.t.some((x) => x.kind === 'notice' && /Multimodal data provided/.test(x.text)), JSON.stringify((withImage?.t ?? []).filter((x) => x.kind === 'notice').map((x) => x.text)))

    // --- Stopped: one export of the session, standalone; its history stays.
    const exports = () => lines().filter((e) => e.kind === 'launch' && /session export/.test((e.args ?? []).join(' ')))
    await inv('session:stop', alpha, agent.id)
    await lib.until(async () => !(await live()), HUNG_MS)
    const exportsOf = (id) => exports().filter((e) => (e.args ?? []).includes(id))
    const exported = await lib.until(async () => (exportsOf(sid).length ? exportsOf(sid) : null), HUNG_MS)
    check('stopped, the session is exported once, standalone', !!exported && exported.length === 1 && (exported[0].args ?? []).includes('--standalone'), JSON.stringify(lines().filter((e) => e.kind === 'launch').map((e) => e.args)))
    check('…and its history stays', (await items()).filter((x) => x.kind === 'user').length >= 2)

    // --- HI-2774: after the run, discovery finds what its TUI made: the fork under its source, the new session on its own.
    const listedNow = async () => inv('session:list', alpha)
    const found = await lib.until(async () => {
      const l = await listedNow()
      const f = l.find((s) => s.id === forkId)
      const n2 = l.find((s) => s.id === newId)
      return f && n2 && n2.usage?.requests ? { f, n2 } : null
    }, HUNG_MS)
    check('discovery lists the fork under the session it came from', !!found && found.f.sub?.parentId === sid && found.f.sub?.kind === 'fork', JSON.stringify(found?.f && { sub: found.f.sub, source: found.f.source }))
    check('…and the new session as an external one, with its own usage', !!found && !found.n2.sub && found.n2.source === 'external' && found.n2.usage.requests === 1, JSON.stringify(found?.n2 && { sub: found.n2.sub, source: found.n2.source, usage: found.n2.usage && { requests: found.n2.usage.requests } }))
    check('…through session list in its folder, standalone', lines().some((e) => e.kind === 'launch' && /session list/.test((e.args ?? []).join(' ')) && path.resolve(e.cwd).toLowerCase() === path.resolve(alpha).toLowerCase()), JSON.stringify(lines().filter((e) => e.kind === 'launch' && /session list/.test((e.args ?? []).join(' '))).map((e) => e.cwd)))
    const forkItems = ((await inv('transcript:read', alpha, forkId).catch(() => null))?.items ?? [])
    check("…the fork's history: its copies, then a notice where they end", forkItems.some((x) => x.kind === 'notice' && x.message?.id === 'providers.transcript.opencodeForked'), JSON.stringify(forkItems.map((x) => x.kind)))

    // --- Adopting the new session: Combwork's mark goes into its account, and it resumes as one of Combwork's.
    await inv('session:adopt', alpha, newId)
    const adopted = await lib.until(async () => (await listedNow()).find((s) => s.id === newId && s.source === 'combwork') ?? null, HUNG_MS)
    check('adopting it makes it one of Combwork\'s sessions', !!adopted, JSON.stringify((await listedNow()).find((s) => s.id === newId)))
    const tuis = () => lines().filter((e) => e.kind === 'tui')
    const before = tuis().length
    await inv('session:start', alpha, { agentId: agent.id, resumeId: newId })
    const resumed = await lib.until(async () => tuis().slice(before).find((e) => e.session === newId) ?? null, HUNG_MS)
    check('…and it resumes on its account', !!resumed && resumed.absent === false, JSON.stringify(tuis().slice(before)))
    await inv('session:stop', alpha, agent.id)
    await lib.until(async () => !(await live()), HUNG_MS)
    // A fork stays a sub-session: adopted as one, never resumed.
    await inv('session:adopt', alpha, forkId)
    const forkRec = await lib.until(async () => (await listedNow()).find((s) => s.id === forkId && s.source === 'combwork') ?? null, HUNG_MS)
    check('a fork adopted stays a sub-session of its source', !!forkRec && forkRec.sub?.kind === 'fork' && forkRec.sub?.parentId === sid, JSON.stringify(forkRec && forkRec.sub))

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
    const childAgain = await lib.until(async () => (await inv('session:list', alpha)).find((s) => s.id === childId && s.sub?.parentId === sid) ?? null, HUNG_MS)
    check("…its subagent's still under it, its conversation read from its mirror", !!childAgain && ((await inv('transcript:read', alpha, childId).catch(() => null))?.items ?? []).some((x) => x.kind === 'assistant'))
    // Its parent's export (long done by now) found its mirror as new as its start: no export of its own.
    check("the subagent's session wasn't exported again after the run: read while it ran, it was as new as its start", exportsOf(childId).length === 0, JSON.stringify(exports().map((e) => e.args)))
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
