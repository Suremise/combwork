// Activity's End Process in two windows (HI-2096): main ends a process only for the asking window's own workspace.
// Window B's beta agent and B's Assistant each leave a process running (fake Claude Code's "linger") while they run;
// window A calls activity:endProcess on each, as the process B's Activity shows (its id and start time): both are refused
// and still run. B's own window ends each, and its exact identity is still checked there (a wrong start time is notOwn).
// Dev build, throwaway profile, workspaces and CLAUDE_CONFIG_DIR; the windows stay quiet (lib.launch). Only processes the
// fake agents started here are ended, by their recorded identity.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const at = (x) => path.join(lib.WORK, `activitywindows-${x}`)
const userData = at('profile')
const wsA = at('wsA')
const wsB = at('wsB')
const claudeHome = at('claude-home')
const alpha = path.join(wsA, 'alpha')
const beta = path.join(wsB, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// The processes fake agents leave running ("linger"), by their identity (pid and start time), ended at the end in any case.
const lingerFile = path.join(claudeHome, 'fake-linger.jsonl')
const lingering = () => (fs.existsSync(lingerFile) ? fs.readFileSync(lingerFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).pid) : [])
const ids = new Map()
const alive = (pid) => ids.has(pid) && lib.stillSame([ids.get(pid)]).length === 1

;(async () => {
  for (const d of [userData, wsA, wsB, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  const env = lib.fakeClaude(userData, claudeHome, [alpha, beta, wsA, wsB])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.sessions = { ...cfg.settings.sessions, confirmStop: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, HIVE_TEST_TIPS: 'off' } })
  const { app, page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, wsA)
    const until = (fn, ms) => lib.until(fn, ms, 250)

    // --- Window B, another workspace.
    const next = app.waitForEvent('window')
    await inv('window:new')
    const pageB = await next
    await pageB.waitForLoadState('domcontentloaded')
    await lib.appReady(pageB)
    pageB.on('pageerror', (e) => check('no page errors (B)', false, e.message))
    const invB = (ch, ...a) => pageB.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await invB('workspace:open', wsB)
    await until(async () => (await invB('workspace:get'))?.path?.toLowerCase() === wsB.toLowerCase(), HUNG_MS)
    const homeB = (await invB('workspace:refresh')).assistant.path
    const homeA = (await inv('workspace:get')).assistant.path

    // --- B's agent and its Assistant each leave a process running while they run: Activity's End Process applies.
    const liveB = async (p, id) => (await invB('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
    const leaves = async (p, agentId) => {
      const had = lingering()
      await invB('session:start', p, { agentId })
      await until(async () => ['ready', 'finished'].includes((await liveB(p, agentId))?.status), HUNG_MS)
      await lib.sendPrompt(invB, lib.ptyKey(p, agentId), 'linger 1', { submitted: async () => lingering().length > had.length })
      await until(async () => (await liveB(p, agentId))?.status === 'finished', HUNG_MS)
      const pid = lingering().slice(had.length)[0]
      for (const id of lib.identify([pid])) ids.set(id.pid, id)
      // As B's Activity lists it: in the agent's running launch, with its start time.
      let shown
      await until(async () => (shown = (await invB('activity:now', p)).launches.filter((l) => l.agentId === agentId).flatMap((l) => l.processes).find((x) => x.pid === pid)), HUNG_MS)
      return shown
    }
    const site = await lib.addAgent(invB, beta, { name: 'Site' })
    const siteProc = await leaves(beta, site.id)
    const asstProc = await leaves(homeB, 'assistant')
    check("B's Activity lists both processes, its agent's and its Assistant's", !!siteProc && !!asstProc && alive(siteProc.pid) && alive(asstProc.pid), JSON.stringify({ siteProc, asstProc }))

    // --- Window A can't end them: refused before anything ends, by B's project path or B's Assistant home.
    const fromA = (p, agentId, x) => inv('activity:endProcess', p, agentId, x.pid, x.created).then((r) => r, (e) => `refused: ${e.message ?? e}`)
    const siteFromA = await fromA(beta, site.id, siteProc)
    const asstFromA = await fromA(homeB, 'assistant', asstProc)
    check("A's call for B's project is refused, and its process still runs", String(siteFromA).startsWith('refused') && alive(siteProc.pid), String(siteFromA))
    check("A's call for B's Assistant is refused, and its process still runs", String(asstFromA).startsWith('refused') && alive(asstProc.pid), String(asstFromA))
    // A's own Assistant has no such process: naming it with B's process ends nothing.
    const ownHome = await fromA(homeA, 'assistant', asstProc)
    check("A's own Assistant with B's process ends nothing", ownHome !== 'ended' && alive(asstProc.pid), String(ownHome))
    await until(async () => !!(await liveB(beta, site.id)) && !!(await liveB(homeB, 'assistant')), HUNG_MS)

    // --- Window B ends each, exactly: a wrong start time is still not its own.
    const wrong = await invB('activity:endProcess', beta, site.id, siteProc.pid, '1')
    check("B's call with a wrong start time is notOwn, and the process still runs", wrong === 'notOwn' && alive(siteProc.pid), String(wrong))
    const siteFromB = await invB('activity:endProcess', beta, site.id, siteProc.pid, siteProc.created)
    check("B ends its agent's process", siteFromB === 'ended' && !!(await until(async () => !alive(siteProc.pid), HUNG_MS)), String(siteFromB))
    const asstFromB = await invB('activity:endProcess', homeB, 'assistant', asstProc.pid, asstProc.created)
    check("B ends its Assistant's process", asstFromB === 'ended' && !!(await until(async () => !alive(asstProc.pid), HUNG_MS)), String(asstFromB))
    check('…and both agents still run', !!(await liveB(beta, site.id)) && !!(await liveB(homeB, 'assistant')))
  } catch (err) {
    check('no unexpected error', false, err.stack)
  } finally {
    await app.close().catch(() => undefined)
    lib.endExactly([...ids.values()])
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
