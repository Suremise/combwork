// What an agent left running stays listed across Combwork's restart (#614). The fake Claude Code's "devapp" leaves a dev
// copy of an Electron app running, as an agent's dev launch of Combwork or a suite's Playwright copy that was never closed
// did (Electron's own executable with --inspect=0 --remote-debugging-port=0 and the app's folder, started through a
// detached node that has exited by then), and "linger 1" a node. Combwork lists them as the agent stops, then closes without
// asking (a quiet test copy, as a quit to install an update does): they keep running, and the next start lists them
// again, each checked to be the same process (its id and start time), and offers to end them; End Them ends them. A kept
// record whose pid names another process by then (a stranger's, with another start time) isn't listed, and the stranger
// is never ended. And a test Combwork's own command line names its profile (lib.cjs), so the runner stops one whose suite
// died before closing it (HB1's, 10 Oct). Fake Claude Code; dev build, throwaway profile and workspace, quiet.
const lib = require('./lib.cjs')
const { namesFolder, processes } = require('./folderProcesses.cjs')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const base = path.join(lib.WORK, 'leftovers-restart')
const userData = path.join(base, 'profile')
const home = path.join(base, 'claude-home')
const ws = path.join(base, 'ws')
const proj = path.join(ws, 'site')
const kept = path.join(userData, 'leftovers.json')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const pidsIn = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).pid) : [])
const readKept = () => (fs.existsSync(kept) ? JSON.parse(fs.readFileSync(kept, 'utf8')) : null)

;(async () => {
  fs.rmSync(base, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  const started = Date.now()
  const env = lib.fakeClaude(userData, home, [proj])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.sessions = { ...cfg.settings.sessions, confirmStop: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // Someone else's process, whose pid a kept record will name with another start time: never listed or ended. It names
  // the suite's folder, so the clean-up below finds it. It runs until that clean-up, not for a set time (#708: leftovers'
  // 120 s one ended before a slow run's check), and ends itself once this suite's process is gone (or after an hour).
  const strangerCode = `const suite = ${process.pid}; setInterval(() => { try { process.kill(suite, 0) } catch { process.exit(0) } }, 1000); setTimeout(() => process.exit(0), 3600000)`
  const stranger = spawn(process.execPath, ['-e', strangerCode, base], { cwd: base, detached: true, stdio: 'ignore', windowsHide: true, env: lib.childEnv() })
  stranger.unref()

  let app = null
  try {
    const first = await lib.launch({ userData, env: { ...env, CW_API_PORT: lib.port(47870) } })
    app = first.app
    const { page, inv } = first
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    // A test Combwork's own command line names its profile (lib.cjs): a suite killed before closing it can't leave it
    // running unseen, as HB1's run did, since the runner stops what names the suite's folder once it ends.
    const own = processes().find((p) => p.pid === app.process().pid)
    check("the test copy's own command line names its profile, in the suite's folder", !!own && namesFolder(own.commandLine, userData) && namesFolder(own.commandLine, base), own?.commandLine)
    await lib.waitForProvider(inv)
    const agent = await lib.soloAgent(inv, proj, { name: 'Website' })
    const key = lib.ptyKey(proj, agent.id)
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === agent.id)
    await inv('session:start', proj, { agentId: agent.id })
    await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), 30000)
    const devFile = path.join(home, 'fake-devapp.jsonl')
    const lingerFile = path.join(home, 'fake-linger.jsonl')
    await lib.sendPrompt(inv, key, 'devapp then linger 1', { submitted: async () => (await live())?.status === 'working' || pidsIn(lingerFile).length > 0 })
    // The dev copy writes its pid once its window is made.
    await lib.until(async () => pidsIn(devFile).length === 1 && pidsIn(lingerFile).length === 1 && (await live())?.status === 'finished', 60000)
    const [dev] = pidsIn(devFile)
    const [node] = pidsIn(lingerFile)
    await inv('session:stop', proj, agent.id)
    await lib.until(async () => !(await live()), 15000)
    const listed = async (call = inv) => (await call('session:leftovers')).find((l) => l.agentId === agent.id)
    const before = await lib.until(async () => {
      const l = await listed()
      return l?.processes.some((p) => p.pid === dev) && l.processes.some((p) => p.pid === node) && l
    }, 15000)
    const devRow = before ? before.processes.find((p) => p.pid === dev) : null
    console.log(`Listed as the agent stopped: ${before ? before.processes.map((p) => p.label).join(' | ') : 'nothing'}`)
    check('the dev copy the agent started is listed as it stops, as Electron with Playwright\'s arguments', !!devRow && devRow.label.startsWith('electron --inspect=0 --remote-debugging-port=0 '), JSON.stringify(before))
    check('and the node it left', !!before && before.processes.some((p) => p.pid === node && p.label.startsWith('node ')))
    const all = before ? before.processes.map((p) => p.pid) : []
    const saved = await lib.until(() => {
      const k = readKept()
      const a = k?.launches?.find((x) => x.agentId === agent.id)
      return a && all.every((pid) => a.processes.some((p) => p.pid === pid && /^\d+$/.test(p.created))) && k
    }, 10000)
    check("Combwork keeps the list in its profile, each process with its start time", !!saved, JSON.stringify(readKept()))

    // Closed without asking (a quiet test copy, as a quit to install an update): left running, still listed.
    await app.close()
    app = null
    check('closing Combwork without asking leaves them running', lib.processRunning(dev) && lib.processRunning(node))
    const k = readKept()
    check('and keeps them listed for the next start', !!k?.launches?.some((a) => a.agentId === agent.id && a.processes.some((p) => p.pid === dev)), JSON.stringify(k))
    // A kept record whose pid names another process now: the stranger's, with another start time.
    k.launches[0].processes.push({ pid: stranger.pid, name: 'node.exe', label: 'node old-server.js', created: '116444736000000000' })
    fs.writeFileSync(kept, JSON.stringify(k, null, 2))

    const second = await lib.launch({ userData, env: { ...env, CW_API_PORT: lib.port(47870) } })
    app = second.app
    second.page.on('pageerror', (e) => check('no page errors (after the restart)', false, e.message))
    await lib.openWorkspace(second.inv, second.page, ws)
    const again = await lib.until(async () => {
      const l = await listed(second.inv)
      return l?.processes.some((p) => p.pid === dev) && l.processes.some((p) => p.pid === node) && l
    }, 30000)
    check('the next start lists them again', !!again, JSON.stringify(await listed(second.inv)))
    check("a kept pid that names another process by now (the stranger's) isn't listed", !!again && !again.processes.some((p) => p.pid === stranger.pid))
    const offer = second.page.locator('.toast', { hasText: /Website left \d+ process(es)? running/ })
    const shown = await offer.first().waitFor({ timeout: 15000 }).then(() => true, () => false)
    check('and a notification offers to end them', shown && (await offer.first().locator('button', { hasText: 'End Them' }).count()) > 0)
    if (shown) await offer.first().locator('button', { hasText: 'End Them' }).click()
    else await second.inv('session:settleLeftovers', proj, agent.id, 'end')
    check('End Them ends the dev copy and the node', await lib.until(() => !lib.processRunning(dev) && !lib.processRunning(node), 15000))
    check("and every process listed for them", await lib.until(() => (again ? again.processes : []).every((p) => !lib.processRunning(p.pid)), 15000), JSON.stringify(again?.processes.filter((p) => lib.processRunning(p.pid))))
    check('nothing is listed or kept any more', !!(await lib.until(async () => !(await listed(second.inv))?.processes.length && !readKept()?.launches?.length, 10000)), JSON.stringify(readKept()))
    check("the stranger's process still runs", lib.processRunning(stranger.pid))
  } finally {
    await app?.close().catch(() => undefined)
    // Whatever is left (a failed run): the processes naming the suite's folder, each ended as the process it was.
    lib.stopProcessesIn(base, started)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  lib.stopProcessesIn(base)
  process.exit(1)
})
