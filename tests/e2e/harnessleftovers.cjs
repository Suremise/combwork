// The e2e harness ends the test copies of Combwork it started (HI-1453: one outlived its suite by 12 h, its runner gone, and
// held its lane's port, so no later runner took that lane). It ends only what it recorded starting, as the process it
// recorded (pid and start time); what only looks like a copy is listed, never ended. Real test copies of the dev build,
// quiet, in throwaway profiles; nothing ended by name, nothing outside this suite's folder:
// 1. A suite killed mid-run: Playwright starts Electron through `cmd.exe /c`, the pid it gives is that shell's, and
//    Combwork's main process, the shell's child, isn't in the suite's job: the shell ends with the killed suite while the
//    copy runs on (how one ran 12 h). lib.cjs records the main process; what the runner does once a suite has ended
//    (folderProcesses.cjs endCopies on its folder) ends it, by that record (its profile is outside the suite's folder).
// 2. The next run's start (leftCopies.mjs endLeftCopies, as run.mjs calls it before taking a lane), in a pool of lane
//    claims of this suite's own. In a lane whose runner is gone: a copy of a suite killed mid-run is ended from its
//    record; a copy with no record (one whose record wasn't written before its suite was killed, or from a run before
//    records) is listed with its pid and left running. In a lane a running runner holds, a recorded copy is left running.
const lib = require('./lib.cjs')
const runContext = require('./runContext.cjs')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { recordCopy, endCopies } = require('./folderProcesses.cjs')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 90000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
/** Every copy this suite started or was told of, by identity: ended in `finally`, whatever else ended them. */
const ids = []
const running = (id) => lib.stillSame([id]).length === 1
const gone = (list) => lib.until(() => list.every((id) => !running(id)), HUNG_MS, 250)

/**
 * A suite (a node of its own, with its runner's environment: `work` its folder) that starts a test copy of Combwork through
 * lib.launch, waits for lib.cjs's record of it, and is then killed mid-run (its node only, as a runner's TaskStop or a
 * crash ends it). { shell: the identity of Playwright's process (the shell), copy: the main process's identity, out },
 * both taken while the suite still runs, so its handle to the shell keeps that pid the shell's.
 */
async function killedSuite(work, profile) {
  fs.mkdirSync(work, { recursive: true })
  const code = `const lib = require(${JSON.stringify(path.join(__dirname, 'lib.cjs'))}); const fs = require('fs'); const path = require('path')
;(async () => {
  const h = await lib.launch({ userData: ${JSON.stringify(profile)} })
  const main = await h.app.evaluate(() => process.pid)
  const file = path.join(lib.WORK, '.hive-copies.jsonl')
  await lib.until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('"pid":' + main), 60000, 250)
  console.log('COPY ' + h.app.process().pid + ' ' + main)
  setInterval(() => {}, 1000)
})().catch((e) => { console.log('ERR ' + e.stack); process.exit(1) })`
  const child = spawn(process.execPath, ['-e', code], { cwd: lib.ROOT, env: runContext.suiteEnv({ name: path.basename(work), port: lib.port(47900), work, runDir: work }) })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const pids = await lib.until(() => /COPY (\d+) (\d+)/.exec(out)?.slice(1).map(Number) ?? (/ERR/.test(out) ? [] : null), HUNG_MS, 250)
  const [shellPid, main] = pids ?? []
  const known = lib.identify([shellPid, main].filter(Boolean))
  const shell = known.find((p) => p.pid === shellPid) ?? null
  const copy = known.find((p) => p.pid === main) ?? null
  if (copy) ids.push(copy)
  const exited = new Promise((r) => child.once('exit', r))
  child.kill()
  await exited
  return { shell, copy, out }
}

/** A test copy of Combwork started outside Playwright, detached, its identity once it is up (it has written its log). */
async function detachedCopy(profile) {
  fs.mkdirSync(profile, { recursive: true })
  const child = spawn(lib.ELECTRON, [lib.ROOT, `--hive-test-profile=${profile}`], { cwd: lib.ROOT, env: lib.hiveEnv({ CW_USER_DATA: profile }), detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  const id = lib.identify([child.pid])[0] ?? null
  if (id) ids.push(id)
  await lib.until(() => fs.existsSync(path.join(profile, 'logs', 'hive.log')), HUNG_MS, 250)
  return id
}

;(async () => {
  try {
    // --- 1. A suite killed mid-run, then the runner's step once it has ended.
    const suite = path.join(lib.WORK, 'killed-suite')
    const one = await killedSuite(suite, path.join(lib.WORK, 'killed-suite-profile'))
    check('a suite starts its test copy of Combwork', !!one.copy, one.out.slice(-2000))
    check("…Playwright's pid is a shell's, Combwork's main process its child", !!one.copy && !!one.shell && one.shell.pid !== one.copy.pid)
    check("…lib.cjs records the main process, by pid and start time, in the suite's folder", !!one.copy && fs.readFileSync(path.join(suite, '.hive-copies.jsonl'), 'utf8').includes(`"started":${one.copy.started}`))
    // The shell ends with the suite's job, after the suite's node: waited for, by its identity.
    const shellGone = !!one.shell && !!(await gone([one.shell]))
    check('…the copy outlives its killed suite', !!one.copy && shellGone && running(one.copy), JSON.stringify({ ...one, shellGone }))
    const atEnd = endCopies([suite])
    check("the runner's step once a suite has ended (endCopies) ends the copy, by its record", atEnd.ended > 0 && !!one.copy && !!(await gone([one.copy])), JSON.stringify(atEnd))

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
    const left = await killedSuite(path.join(laneWork(work, 2), 'old-suite'), path.join(laneWork(work, 2), 'old-suite', 'profile'))
    const unrecorded = await detachedCopy(path.join(laneWork(work, 2), 'stray', 'profile'))
    const held = await detachedCopy(path.join(laneWork(work, 3), 'live-suite', 'profile'))
    if (held) recordCopy(path.join(laneWork(work, 3), 'live-suite'), { pid: held.pid, started: held.started })
    check('copies left running: a killed suite\'s and one with no record in a gone runner\'s lane, a recorded one in a held lane', [left.copy, unrecorded, held].every((c) => c && running(c)))
    const swept = await endLeftCopies(pool, work)
    check("the next run's start sweeps the lanes no running runner holds", swept.lanes.includes(2) && !swept.lanes.includes(3), JSON.stringify(swept.lanes))
    check("…ends the killed suite's copy from its record", swept.ended > 0 && !!left.copy && !!(await gone([left.copy])), JSON.stringify(swept))
    check('…lists the copy with no record, with its pid, and leaves it running', !!unrecorded && swept.unrecorded.some((p) => p.pid === unrecorded.pid) && running(unrecorded), JSON.stringify(swept.unrecorded))
    check("…and leaves the recorded one in a running runner's lane running", !!held && running(held))
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    for (const id of ids) lib.endTreeExactly(id)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
