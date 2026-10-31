// A scenario whose agent leaves a command running through hive-progress (#542): on 10 Oct a Codex agent's command
// (cmd → hive-progress → node) outlived its scenario, held the scenario's folder, and the next run in that lane crashed
// removing it. The harness stops what its Hive started, and what still names the folder, by command line (never by
// name), before it removes the folder; a folder still in use fails that one scenario, saying so, and nothing crashes.
// Here the fake Claude Code's "progress-linger" leaves such a command (a lingering node under the session's own
// hive-progress shim) and ends its turn; the same scenario then runs again in the same folder.
const fs = require('fs')
const path = require('path')
const lib = require('./lib.cjs')
const { runScenario } = require('../scenarios/harness.cjs')
const { processes, namesFolder } = require('./folderProcesses.cjs')

let failed = 0
function check(name, ok, extra) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const workRoot = path.join(lib.WORK, 'scenarioteardown')
const root = path.join(workRoot, 'left-running-fake')
const pidFile = path.join(root, 'claude-home', 'fake-progress-linger.jsonl')
/**
 * The pid the left-running node recorded in `file`, or null until it has: another process writes it, so the file can
 * be missing, empty or have half a row for a moment; any of those is "not yet", never an error.
 */
function pidIn(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  for (const line of text.split('\n')) {
    try {
      const pid = JSON.parse(line).pid
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch {
      // Not a whole row (yet).
    }
  }
  return null
}
const leftPid = () => pidIn(pidFile)

// What each run's agent left running, read before the scenario ends (its folder goes with it).
const seen = []
const scenario = {
  id: 'left-running',
  title: 'An agent leaves a command running through hive-progress, and ends its turn (#542)',
  prompt: 'Start a long command through hive-progress and end your turn without waiting for it.',
  fake: 'progress-linger then work 1',
  // The fake's turn ends once the command's node runs (#1100); a real agent's may end before: waited for (within the scenario's limit).
  keepWaiting: async () => !leftPid(),
  expect: () => {
    const pid = leftPid()
    seen.push(pid)
    return [['its agent left the command running', !!pid && alive(pid), String(pid)]]
  }
}

;(async () => {
  // The reader, on the file as another process writes it: missing, empty, half a row, then whole. A wait on it (as the
  // scenario's keepWaiting does) goes on through the first three and ends on the last.
  const probe = path.join(lib.WORK, 'scenarioteardown-pidfile', 'pids.jsonl')
  fs.rmSync(path.dirname(probe), { recursive: true, force: true })
  fs.mkdirSync(path.dirname(probe), { recursive: true })
  const states = []
  const waited = lib.until(() => {
    states.push(pidIn(probe))
    return pidIn(probe)
  }, 10000, 50)
  check('the pid file missing: not yet', pidIn(probe) === null)
  // Each state seen by the wait before the next: polled, not read once.
  const seenAgain = async () => {
    const n = states.length
    await lib.until(() => states.length > n, 10000, 20)
  }
  await seenAgain()
  fs.writeFileSync(probe, '')
  check('empty: not yet', pidIn(probe) === null)
  await seenAgain()
  fs.writeFileSync(probe, '{"pid":')
  check('half a row: not yet', pidIn(probe) === null)
  await seenAgain()
  fs.writeFileSync(probe, '{"pid":4242,"agent":"a"}\n')
  check('whole: its pid', pidIn(probe) === 4242)
  check('the wait went on through them and ended on the whole row', (await waited) === 4242 && states.length >= 4 && states.slice(0, -1).every((x) => x === null), JSON.stringify(states))

  for (const run of [1, 2]) {
    const r = await runScenario(scenario, 'fake', { workRoot, port: lib.port(47824), timeoutMs: 60000 })
    const pid = seen[run - 1]
    check(`run ${run}: the scenario ran (no error)`, !r.error, r.error)
    check(`run ${run}: its agent left a command running through hive-progress`, r.checks.length === 1 && r.checks[0].ok === true, JSON.stringify(r.checks))
    check(`run ${run}: the harness stopped what was left, and says so`, /process\(es\).*were stopped/.test(r.leftOver ?? ''), r.leftOver)
    check(`run ${run}: the command's node is no longer running`, !!pid && (await lib.until(() => !alive(pid), 10000)), String(pid))
    check(`run ${run}: the scenario's folder went`, !r.kept && !fs.existsSync(root), r.kept ?? root)
  }
  // HI-2217: what an agent leaves that names no scenario folder and whose parent has exited (a model's `find / …`) is
  // in no tree and named by no command line: only its launch's job knows it, and the harness asks Hive for that.
  const hiddenPidFile = path.join(workRoot, 'left-unnamed-fake', 'claude-home', 'fake-hidden-linger.jsonl')
  const hiddenPid = () => pidIn(hiddenPidFile)
  let hidden = null
  const unnamed = {
    id: 'left-unnamed',
    title: 'An agent leaves a command running that names no scenario folder, its parent gone (HI-2217)',
    prompt: 'Start a long command in the background and end your turn without waiting for it.',
    fake: 'hidden-linger then work 1',
    keepWaiting: async () => !hiddenPid(),
    expect: () => {
      hidden = hiddenPid()
      const cmd = hidden ? processes().find((p) => p.pid === hidden)?.commandLine : null
      return [
        ['its agent left the command running', !!hidden && alive(hidden), String(hidden)],
        ['its command line names no scenario folder', !!cmd && !namesFolder(cmd, path.join(workRoot, 'left-unnamed-fake')), String(cmd)]
      ]
    }
  }
  const u = await runScenario(unnamed, 'fake', { workRoot, port: lib.port(47824), timeoutMs: 60000 })
  check('unnamed: the scenario ran (no error)', !u.error, u.error)
  check('unnamed: its agent left a command naming no scenario folder, its parent gone', u.checks.length === 2 && u.checks.every((c) => c.ok === true), JSON.stringify(u.checks))
  check('unnamed: the harness stopped it, and counts it', /^[1-9]\d* process\(es\).*were stopped/.test(u.leftOver ?? ''), u.leftOver)
  check("unnamed: the command's node is no longer running", !!hidden && (await lib.until(() => !alive(hidden), 10000)), String(hidden))

  // Nothing of either run is left holding the folder.
  check('nothing still runs from its folder', lib.stopProcessesIn(workRoot) === 0)
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
