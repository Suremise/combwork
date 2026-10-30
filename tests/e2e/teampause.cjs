// Pausing the team before an update (HI-2081, SPEC §16.10.9), on fake Claude Code agents, in two windows:
// - window A's alpha: Builder runs a lane (two cards) and watches its first card. Pause the Team: the lane shows it is
//   paused for the team, Builder is told once to park, Start Lane is refused, and a comment on its card wakes it with
//   nothing (its watch's wake held) until the team resumes, when the wake is typed once;
// - Builder's run (hive-progress, held open) keeps the team unparked, named; once it ends, All parked; Install Now with no
//   update ready installs nothing;
// - window B's workspace is paused by the user's pause too; its Assistant's token reads its own team only, with A as one
//   line, and its pause or resume never touches A; a project agent and a script are refused.
// Dev build, throwaway profile, workspaces and CLAUDE_CONFIG_DIR; the windows stay quiet (lib.launch).
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const at = (x) => path.join(lib.WORK, `teampause-${x}`)
const userData = at('profile')
const wsA = at('wsA')
const wsB = at('wsB')
const claudeHome = at('claude-home')
const alpha = path.join(wsA, 'alpha')
const beta = path.join(wsB, 'beta')
const PORT = Number(lib.port(47791))
const API = `http://127.0.0.1:${PORT}`
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const PARK_LINE = '[Hive] The team is pausing for an update.'

;(async () => {
  for (const d of [userData, wsA, wsB, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha)
  lib.gitProject(beta)
  const env = lib.fakeClaude(userData, claudeHome, [alpha, beta, wsA, wsB])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  cfg.settings.assistant = { ...cfg.settings.assistant, control: 'agents', tellReplies: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const release = path.join(claudeHome, 'release-run')
  const holder = path.join(claudeHome, 'hold.cjs')
  fs.writeFileSync(holder, "const fs = require('fs'); const f = process.argv[2]; setInterval(() => fs.existsSync(f) && process.exit(0), 200); setTimeout(() => process.exit(0), 180000)\n")

  const h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' } })
  const { app, page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, wsA)
    const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 250)
    const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
    const idle = async (p, id) => ['ready', 'finished'].includes((await live(p, id))?.status)
    const say = (p, id, text) => lib.typeLine(inv, lib.ptyKey(p, id), claudeHome, null, text, { live: () => live(p, id) })
    const wakes = (agent) => {
      const f = path.join(claudeHome, 'fake-wakes.jsonl')
      return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === agent).map((w) => w.text)
    }
    const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (token, method, p, body) => {
      // Two workspaces open: a workspace token names its own (an Assistant's token is its workspace's anyway).
      const res = await fetch(`${API}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(token === workspaceToken ? { 'X-Hive-Workspace': path.basename(wsA) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const deliveries = async (agent) => {
      const v = (await api(workspaceToken, 'GET', `/v1/projects/alpha/agents/${encodeURIComponent(agent)}/deliveries?limit=20`)).body ?? {}
      return (v.items ?? v.deliveries ?? []).map((d) => d.body ?? d.text ?? '')
    }

    // --- alpha: Builder runs a lane and watches its first card.
    const builder = await lib.addAgent(inv, alpha, { name: 'Builder', workflowRole: 'builder' })
    await lib.addAgent(inv, alpha, { name: 'Reviewer', workflowRole: 'reviewer' })
    fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([wsA.toLowerCase(), alpha.toLowerCase(), wsB.toLowerCase(), beta.toLowerCase()]))
    await inv('session:start', alpha, { agentId: builder.id })
    check('Builder starts', !!(await until(() => idle(alpha, builder.id))))
    const c1 = (await inv('tasks:create', { title: 'Greeting says Hi', project: 'alpha', agent: builder.id, column: 'doing' })).number
    const c2 = (await inv('tasks:create', { title: 'Greeting trims', project: 'alpha', agent: builder.id })).number
    await say(alpha, builder.id, `hive hive_lane ${JSON.stringify({ action: 'start', cards: [c1, c2], reviewer: 'Reviewer', name: 'greetings' })}`)
    const lane = async () => (await inv('lanes:list')).find((l) => l.builder.id === builder.id && l.state !== 'ended')
    check("Builder's lane runs", !!(await until(async () => (await lane())?.state === 'active')), JSON.stringify(await lane()))
    await until(() => idle(alpha, builder.id))
    await say(alpha, builder.id, `hive hive_wait_for_tasks ${JSON.stringify({ cards: [c1], changes: ['comment'], wake: true, limitMinutes: 60 })}`)
    check('Builder watches its card', !!(await until(async () => (await live(alpha, builder.id))?.status === 'watching')))

    // --- Window B, another workspace (opened before the pause: the user's pause covers it).
    const next = app.waitForEvent('window')
    await inv('window:new')
    const pageB = await next
    await pageB.waitForLoadState('domcontentloaded')
    await lib.appReady(pageB)
    const invB = (ch, ...a) => pageB.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await invB('workspace:open', wsB)
    await until(async () => (await invB('workspace:get'))?.path?.toLowerCase() === wsB.toLowerCase())

    // --- Pause the Team (the user's): both workspaces.
    const paused = await inv('team:pause')
    check('Pause the Team pauses both open workspaces', paused.failed.length === 0 && paused.done.length === 2, JSON.stringify(paused))
    check("alpha's lane shows it is paused for the team", !!(await until(async () => (await lane())?.status?.reason === 'teamPause' && (await lane())?.state === 'paused')), JSON.stringify((await lane())?.status))
    check('Builder is told once to park', !!(await until(async () => (await deliveries('Builder')).filter((b) => b.startsWith(PARK_LINE)).length === 1)), JSON.stringify(await deliveries('Builder')))
    const refused = await inv('lanes:start', alpha, { builder: builder.id, reviewer: null, cards: [c2] }).then(() => null, (e) => String(e.message ?? e))
    check('Start Lane is refused while paused', !!refused && /resume the team first/i.test(refused), String(refused))
    await page.screenshot({ path: at('band.png') }).catch(() => undefined)

    // A comment on its watched card: its watch's wake is held, typed into nothing.
    await until(async () => ['ready', 'finished', 'watching'].includes((await live(alpha, builder.id))?.status))
    const before = wakes('Builder').length
    await inv('tasks:comment', c1, 'Round 1: one finding.')
    await lib.sleep(4000) // on purpose: longer than a wake takes, to see none is typed while paused
    check("its watch's wake is held while paused (not typed)", !wakes('Builder').slice(before).some((t) => t.includes('Round 1: one finding')), JSON.stringify(wakes('Builder').slice(before)))

    // --- What still runs: Builder's run keeps the team unparked; once it ends, All parked.
    await until(() => idle(alpha, builder.id))
    await say(alpha, builder.id, `shell: hive-progress --title "probe run" -- node "${holder}" "${release}"`)
    const named = async () => (await inv('team:state')).workspaces.find((w) => w.workspacePath.toLowerCase() === wsA.toLowerCase())?.items ?? []
    check('the run keeps the team unparked, named', !!(await until(async () => (await named()).some((i) => i.kind === 'run' && i.label === 'probe run'))), JSON.stringify(await named()))
    check('…not All parked', (await inv('team:state')).allParked === false)
    // The status bar's Team paused opens the Progress panel, whose Lanes band names what still runs.
    await page.locator('.status-item.team-paused').click()
    const band = page.locator('.team-pause-band')
    check("the status bar's item opens the Progress panel, where the band names the run, its process (End It…) and Builder at work", !!(await until(async () => /Pausing the team: \d+ still running/.test((await band.innerText().catch(() => '')) ?? '') && /Builder: probe run \(a run\)/.test((await band.innerText().catch(() => '')) ?? '') && /hold\.cjs.*\(process \d+\)/.test((await band.innerText().catch(() => '')) ?? '') && (await band.getByRole('button', { name: 'End It…' }).count()) > 0)), await band.innerText().catch(() => ''))
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
      await band.screenshot({ path: at(`band-${theme}.png`) }).catch(() => undefined)
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
    const early = await inv('team:install')
    check('Install Now while not parked installs nothing', early.installed === false)
    fs.writeFileSync(release, '')
    check('once the run ends, All parked', !!(await until(async () => (await inv('team:state')).allParked, 60000)), JSON.stringify((await inv('team:state')).workspaces.map((w) => [w.workspacePath, w.pause?.by, w.items])))
    check('…and the band says so', !!(await until(async () => /All parked: safe to install/.test((await band.innerText().catch(() => '')) ?? ''))), await band.innerText().catch(() => ''))
    await band.screenshot({ path: at('band-parked.png') }).catch(() => undefined)
    const install = await inv('team:install')
    check('Install Now with no update ready installs nothing', install.installed === false && install.state.allParked === true)

    // --- The Assistants' authority (HR1's s12 check): B's reads and pauses its own workspace only.
    const homeB = (await invB('workspace:refresh')).assistant.path
    await invB('session:start', homeB, { agentId: 'assistant' })
    await until(async () => ['ready', 'finished'].includes((await invB('session:live')).find((s) => s.projectPath.toLowerCase() === homeB.toLowerCase() && s.agentId === 'assistant')?.status))
    const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(wsB.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const tokenB = (await until(() => fs.existsSync(tokenFile))) ? JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token : null
    const seen = await api(tokenB, 'GET', '/v1/team')
    check("B's Assistant reads its own team, with A only as a line (no names)", seen.status === 200 && seen.body?.paused === true && !JSON.stringify(seen.body).includes('Builder') && !JSON.stringify(seen.body).toLowerCase().includes('alpha'), JSON.stringify(seen.body))
    const resumedB = await api(tokenB, 'POST', '/v1/team/resume', {})
    check("B's Assistant resumes B…", resumedB.status === 200 && resumedB.body?.paused === false, JSON.stringify(resumedB.body))
    check('…and A stays paused', (await inv('team:state')).workspaces.find((w) => w.workspacePath.toLowerCase() === wsA.toLowerCase())?.pause !== null && (await lane())?.status?.reason === 'teamPause')
    const pausedB = await api(tokenB, 'POST', '/v1/team/pause', {})
    check("B's Assistant pauses B again (its own, by the Assistant)", pausedB.status === 200 && pausedB.body?.paused === true && pausedB.body?.pausedBy === 'assistant', JSON.stringify(pausedB.body))
    const script = await api(workspaceToken, 'POST', '/v1/team/resume', {})
    check('a script is refused (403)', script.status === 403, JSON.stringify(script))

    // --- Resume the Team: the held wake is typed once, the lane runs again.
    const back = await inv('team:resume')
    check('Resume the Team resumes both', back.failed.length === 0 && back.done.length === 2, JSON.stringify(back))
    check('the held wake is typed once after the resume', !!(await until(async () => wakes('Builder').slice(before).filter((t) => t.includes('Round 1: one finding')).length === 1)), JSON.stringify(wakes('Builder').slice(before)))
    check("the lane isn't paused for the team any more", !!(await until(async () => (await lane())?.status?.reason !== 'teamPause')), JSON.stringify((await lane())?.status))
  } catch (err) {
    check('no unexpected error', false, err.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
