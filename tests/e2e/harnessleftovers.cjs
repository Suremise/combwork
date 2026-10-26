// The e2e harness ends the test copies of Hive it started (HI-1453: one outlived its suite by 12 h, its runner gone, and
// held its lane's port, so no later runner took that lane). Real test copies of the dev build, quiet, in throwaway
// profiles; nothing ended by name, nothing outside this suite's folder:
// 1. A suite killed mid-run: Playwright starts Electron through `cmd.exe /c`, the pid it gives is that shell's, and
//    Hive's main process, the shell's child, isn't in the suite's job: the shell ends with the killed suite while the
//    copy runs on (how one ran 12 h). lib.cjs records the main process; what the runner does once a suite has ended
//    (folderProcesses.cjs endCopies on its folder) ends it, by that record (its profile is outside the suite's folder).
// 2. The next run's start (leftCopies.mjs endLeftCopies, as run.mjs calls it before taking a lane), in a pool of lane
//    claims of this suite's own: the copies an earlier run left in a lane whose runner is gone are ended, found by their
//    profile there or by their record there (one whose profile is elsewhere); one in a lane a running runner holds is
//    left running.
const lib = require('./lib.cjs')
const runContext = require('./runContext.cjs')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { recordCopy } = require('./folderProcesses.cjs')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 90000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const ids = []
const running = (id) => lib.stillSame([id]).length === 1
const gone = (list) => lib.until(() => list.every((id) => !running(id)), HUNG_MS, 250)

/** A test copy of Hive started outside Playwright, detached (out of this process's job), as an escaped one runs. */
async function escaped(profile) {
  fs.mkdirSync(profile, { recursive: true })
  const from = Date.now()
  const child = spawn(lib.ELECTRON, [lib.ROOT, `--hive-test-profile=${profile}`], { cwd: lib.ROOT, env: lib.hiveEnv({ HIVE_USER_DATA: profile }), detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  const [id] = await lib.until(() => lib.identify([child.pid]), HUNG_MS, 250).then((r) => r ?? [])
  // Up: its main process has written its log (it has read its profile), so it is a Hive, not a process starting.
  await lib.until(() => fs.existsSync(path.join(profile, 'logs', 'hive.log')), HUNG_MS, 250)
  if (id) ids.push(id)
  return { id, from, to: Date.now() }
}

;(async () => {
  try {
    // --- 1. A suite killed mid-run.
    const suite = path.join(lib.WORK, 'killed-suite')
    fs.mkdirSync(suite, { recursive: true })
    const profile = path.join(lib.WORK, 'killed-suite-profile')
    const code = `const lib = require(${JSON.stringify(path.join(__dirname, 'lib.cjs'))}); const fs = require('fs'); const path = require('path')
;(async () => {
  const h = await lib.launch({ userData: ${JSON.stringify(profile)} })
  const main = await h.app.evaluate(() => process.pid)
  const file = path.join(lib.WORK, '.hive-copies.jsonl')
  await lib.until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('"pid":' + main), 60000, 250)
  console.log('COPY ' + h.app.process().pid + ' ' + main)
  setInterval(() => {}, 1000)
})().catch((e) => { console.log('ERR ' + e.stack); process.exit(1) })`
    const child = spawn(process.execPath, ['-e', code], { cwd: lib.ROOT, env: runContext.suiteEnv({ name: 'killed-suite', port: lib.port(47900), work: suite, runDir: suite }) })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const pids = await lib.until(() => /COPY (\d+) (\d+)/.exec(out)?.slice(1).map(Number) ?? (/ERR/.test(out) ? [] : null), HUNG_MS, 250)
    check('a suite starts its test copy of Hive', pids?.length === 2, out.slice(-2000))
    const [shell, main] = pids ?? []
    const copy = lib.identify(main ? [main] : [])[0]
    if (copy) ids.push(copy)
    check("…Playwright's pid is a shell's, Hive's main process its child", !!copy && shell !== main)
    check("…lib.cjs records the main process, by pid, in the suite's folder", !!copy)
    // Killed mid-run (as a runner's TaskStop or a crash ends it): its node only, no clean-up of its own.
    const exited = new Promise((r) => child.once('exit', r))
    child.kill()
    await exited
    check('…the copy outlives its killed suite', !!copy && !lib.processRunning(shell) && running(copy), JSON.stringify({ shell, copy }))
    const { endCopies } = require('./folderProcesses.cjs')
    const ended = endCopies([suite])
    check("the runner's step once a suite has ended (endCopies) ends the copy, by its record", ended > 0 && !!copy && !!(await gone([copy])), `ended ${ended}`)

    // --- 2. The next run's start, in a pool of lane claims of this suite's own.
    const pool = path.join(lib.WORK, 'lane-claims')
    const work = path.join(lib.WORK, 'pool-work')
    fs.mkdirSync(pool, { recursive: true })
    const { laneWork } = await import(pathToFileURL(path.join(__dirname, 'lanes.mjs')).href)
    const { endLeftCopies } = await import(pathToFileURL(path.join(__dirname, 'leftCopies.mjs')).href)
    // Lane 2's runner is gone (a process that has exited: its pid names none, or another by now); lane 3's runs (this one).
    const dead = spawn(process.execPath, ['-e', ''], { env: lib.childEnv(), windowsHide: true })
    const deadPid = dead.pid
    await new Promise((r) => dead.once('exit', r))
    fs.writeFileSync(path.join(pool, 'lane-2.json'), JSON.stringify({ pid: deadPid, at: Date.now() }))
    fs.writeFileSync(path.join(pool, 'lane-3.json'), JSON.stringify({ pid: process.pid, at: Date.now() }))
    const byProfile = await escaped(path.join(laneWork(work, 2), 'old-suite', 'profile'))
    // Its profile outside the lane: found by the record its suite left there.
    const byRecord = await escaped(path.join(lib.WORK, 'elsewhere', 'profile'))
    if (byRecord.id) recordCopy(path.join(laneWork(work, 2), 'old-suite'), { pid: byRecord.id.pid, started: byRecord.id.started })
    const held = await escaped(path.join(laneWork(work, 3), 'live-suite', 'profile'))
    check('three copies left running in the lanes', !!(byProfile.id && byRecord.id && held.id) && [byProfile, byRecord, held].every((c) => running(c.id)))
    const left = await endLeftCopies(pool, work)
    check("the next run's start sweeps the lanes no running runner holds", left.lanes.includes(2) && !left.lanes.includes(3) && left.ended > 0, JSON.stringify(left))
    check('…ends the copy with its profile in a gone runner\'s lane', !!(await gone([byProfile.id])))
    check('…and the one recorded there, its profile elsewhere', !!(await gone([byRecord.id])))
    check("…and leaves the one in a running runner's lane running", running(held.id))
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    for (const id of ids) lib.endTreeExactly(id)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
