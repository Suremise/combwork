// Stop an agent and switch workspace at once (#297). The switch stops every live session of the workspace, and the
// agent just stopped was still live (its process hadn't exited yet), so its terminal was killed a second time. On
// Windows node-pty closes the pseudoconsole a moment after a kill, and a second kill before the first had finished
// corrupted the heap: Combwork's main process died, with nothing in its log (replysize's page closed this way under load).
// Twelve rounds, two agents each (one stopped just before the switch, one still working): Combwork survives every switch, and
// each switch leaves no session running. Fake Claude Code; dev build, throwaway profile and workspaces, quiet.
// A round counts only once both its agents are running, and "no session running" is read from Combwork's own list of every
// live session and the agents' processes (exited only when Windows says there is no such process), and any error fails
// the suite (#339).
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const base = path.join(lib.WORK, 'stopswitch')
const userData = path.join(base, 'profile')
const home = path.join(base, 'claude-home')
const [wsA, wsB] = ['ws-a', 'ws-b'].map((n) => path.join(base, n))
const projects = [path.join(wsA, 'alpha'), path.join(wsB, 'beta')]
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  fs.rmSync(base, { recursive: true, force: true })
  for (const p of projects) fs.mkdirSync(p, { recursive: true })
  const env = lib.fakeClaude(userData, home, projects)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  // Switching stops the agents without asking, as after the user says so.
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const { app, page, inv } = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: lib.port(47922) } })
  let gone = null
  page.on('close', () => (gone ??= new Date().toISOString()))
  const mainPid = await app.evaluate(() => process.pid)
  const alive = () => {
    try {
      process.kill(mainPid, 0)
      return true
    } catch {
      return false
    }
  }
  const agents = {}
  // Combwork's list of every live session, whichever workspace it's in: session:list checks the project is the window's,
  // which a switch has just changed, so its error can't be read as "none running" (#339).
  const liveIn = async (proj) => (await inv('session:live')).filter((s) => s.projectPath.toLowerCase() === proj.toLowerCase())
  // What a project still runs: its sessions in Combwork's list and the processes of the agents last started there.
  const pids = {}
  const runningIn = async (proj) => ({ sessions: (await liveIn(proj)).length, processes: (pids[proj] ?? []).filter(lib.processRunning).length })
  // The switch waits a moment for its sessions to end, then goes on: wait for the project to run nothing, and say what
  // it still ran if it doesn't.
  const leftNothing = async (name, proj) => {
    let left
    const none = await lib.until(async () => {
      left = await runningIn(proj)
      return !left.sessions && !left.processes
    }, 15000)
    check(name, none, JSON.stringify(left))
  }

  let rounds = 0
  try {
    for (let r = 0; r < 12; r++) {
      if (gone) break
      const proj = projects[r % 2]
      await lib.openWorkspace(inv, page, r % 2 ? wsB : wsA)
      if (r > 0) await leftNothing(`round ${r}: the last switch left no session running in ${path.basename(projects[(r + 1) % 2])}`, projects[(r + 1) % 2])
      agents[proj] ??= [await lib.addAgent(inv, proj, { name: 'One' }), await lib.addAgent(inv, proj, { name: 'Two' })]
      const [one, two] = agents[proj]
      await inv('session:start', proj, { agentId: one.id })
      await inv('session:start', proj, { agentId: two.id })
      // Both running, in Combwork's list and as processes, before the stop and the switch: a round without them proves nothing.
      const both = await lib.until(async () => {
        const l = await liveIn(proj)
        return l.length === 2 && l.every((s) => s.pid) && l
      }, 10000)
      pids[proj] = (both || (await liveIn(proj))).map((s) => s.pid).filter(Boolean)
      const now = await runningIn(proj)
      const ready = !!both && now.sessions === 2 && now.processes === 2
      check(`round ${r}: both agents are running before the stop`, ready, JSON.stringify(now))
      if (!ready) throw new Error(`round ${r} has no two agents running to stop and switch from`)
      // Stop one (Stop pressed again while it stops, as an impatient user might), and switch straight away: the switch
      // stops the other, and finds this one still live.
      await Promise.all([inv('session:stop', proj, one.id), inv('session:stop', proj, one.id), inv('session:stop', proj, one.id)])
      rounds = r + 1
    }
    if (!gone) {
      await lib.openWorkspace(inv, page, wsA)
      await leftNothing(`the final switch left no session running in ${path.basename(projects[1])}`, projects[1])
    }
  } catch (e) {
    // Whatever stopped the rounds or the final check (a failed query, a switch that didn't show) fails the suite: it was
    // never "no session running" (#339).
    check(`the rounds and the final switch ran without an error (stopped at round ${rounds})`, false, String(e?.message ?? e).split('\n')[0])
  }
  check('Combwork survives stopping an agent and switching workspace at once, twelve times', !gone && alive() && rounds === 12, JSON.stringify({ rounds, pageClosed: gone, mainAlive: alive() }))

  await app.close()
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
