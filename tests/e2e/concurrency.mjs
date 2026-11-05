// Runners at the same time share nothing (#203), and heavy runs queue (#204):
//   npm run e2e:concurrency [-- --repeat N] [--keep] [--heavy] [--lane-wait]
//
// Starts four test runs at once from two worktrees, with both dev builds made stale first: in this worktree an e2e
// runner and a scenario run, and in a second worktree (a git worktree of this one's HEAD with its uncommitted changes,
// made for the check in this invocation's own folder and removed after unless --keep: tempWorktrees.mjs, #207, so two
// checkers at once never remove each other's) two e2e runners. One run in each worktree is started with the
// environment of an agent's shell inside an outer hive-progress (NO_COLOR, CW_PROGRESS_WRAPPED, a Combwork Agent API
// token…) and a shell's git and Node settings pointing elsewhere (GIT_DIR and GIT_WORK_TREE at a decoy repository,
// NODE_OPTIONS loading a script that notes each Node process it starts in), the other with a plain one; the checker's
// own environment points git at the decoy too, for its own setup (#208). Checked, each round: every run passes; each
// holds a lane of its own (its own ports and folders) and its own logs folder; each worktree's build is made once (the
// build lock), stamped as its source (by its runs, or by another checker's started in the same worktree, #282); no build lock is left held; each e2e run's record names its own worktree's code;
// and the decoy is untouched and no Node process but the runners themselves got the NODE_OPTIONS (#208). --repeat N
// runs N rounds, stopping at the first that fails. Before the rounds, in the second worktree with no dev build yet: a
// packaged run (HIVE_EXE) whose suites can't run on it makes no build, writes its record (not valid, each suite NOT
// RUN with why) and fails (#1591).
//
// --heavy checks the machine-wide limit on heavy runs instead (slots.mjs), in a pool of slots of its own (so real runs
// on the machine neither wait for it nor make it wait): three heavy runs (a repeat) started at once from three
// worktrees with two slots. Checked: two run and the third waits, saying so (and in the Progress panel, through a
// stand-in for Combwork's Agent API), then starts when a slot is let go; no more than two hold slots at any moment; all
// pass; a run with --no-wait while the slots are taken fails at once, saying who holds them; with both heavy slots
// held, a small run takes the side slot and a heavy run is refused (HI-2070: no side slot in the rest); the slot of a run that
// is killed is taken by the next run without waiting; a pre-merge run (its agent holds the merge slot, as the stand-in
// says) takes the only slot before two runs that asked earlier, and a killed pre-merge run's place expires (#558); and
// with the only slot held by a parent run, a heavy scenario run started inside its suite runs without asking for one
// (even with --no-wait), while the same run at the top level is refused (#211).
//
// After the rounds (or alone, with --lane-wait): a run that waits for a test lane while its source changes (#735). In
// the second worktree, an e2e run (--build --record) and a scenario run start while every lane of a pool of their own
// is held (HIVE_TEST_LANES_DIR, with folders and ports of their own, #1127: real runs neither wait for it, make it
// wait nor answer on its ports); once both
// say they wait, a source file is added there, then lanes are let go. Checked: both waited, then built the source as
// it was once they had a lane, after the wait; both pass; the e2e record names that source and is valid; the build
// is stamped as it.
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import http from 'http'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { BUILD_LOCKS, buildInputs, buildLock, buildStamp, buildStampedAt, builtOnce } from './build.mjs'
import { holdLane } from './clean.mjs'
import { LANES, OWN_POOL_FIRST, claimHeld, holdOwnPool } from './lanes.mjs'
import { trySlot } from './slots.mjs'
import { addWorktree, invocationDir, keepDir, removeInvocation, removeStale } from './tempWorktrees.mjs'
import { fingerprint } from './record.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const runContext = createRequire(import.meta.url)('./runContext.cjs')
// A process tree ended by identity, never taskkill /T on a pid (#603).
const { endChildTree } = createRequire(import.meta.url)('./folderProcesses.cjs')

const argv = process.argv.slice(2)
const repeat = Math.max(1, Number(argv[argv.indexOf('--repeat') + 1]) || 1)
const keep = argv.includes('--keep')
const heavy = argv.includes('--heavy')
const laneWaitOnly = argv.includes('--lane-wait')
/** The small fake set each e2e runner runs, and the scenario. */
const SUITES = ['isolation', 'about', 'bridgereport', 'busy']
const SCENARIO = 'work-on-card'
/** This invocation's own folder (tempWorktrees.mjs): its worktrees, decoy, heavy-run pool; no other checker's. */
const RUN = invocationDir()
/** An agent's shell in Combwork running the tests through hive-progress, and a person's own settings. */
const AGENT_SHELL = {
  NO_COLOR: '1',
  FORCE_COLOR: '1',
  CW_PROGRESS_WRAPPED: '1',
  CW_PROGRESS_RUN_AS_NODE: '1',
  CW_PROGRESS_DATA: join(RUN, 'leaked-progress'),
  CW_API_URL: 'http://127.0.0.1:9',
  HIVE_API_TOKEN: 'leaked-token',
  CW_PROJECT: 'hive',
  CLAUDE_CONFIG_DIR: join(RUN, 'leaked-claude'),
  ELECTRON_RUN_AS_NODE: '1',
  HIVE_TEST_SLOW_IPC: 'tasks:list=1'
}
/**
 * A shell's git and Node settings pointing elsewhere (#208): a decoy repository the runs' git must never use, and a
 * script NODE_OPTIONS loads into every Node process started with it, noting which: only the runners themselves, never
 * a build, suite or other child, may have it.
 */
const DECOY = join(RUN, 'decoy')
const NODE_SEEN = join(RUN, 'node-options.log')
const NODE_MARKER = join(RUN, 'node-options.cjs')
const SHELL_ELSEWHERE = { GIT_DIR: join(DECOY, '.git'), GIT_WORK_TREE: DECOY, NODE_OPTIONS: `--require "${NODE_MARKER.replaceAll('\\', '/')}"` }

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// Every child of the checker's own gets the allowlisted environment (runContext.baseEnv): git works in cwd's repository.
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: runContext.baseEnv() })

/** The decoy repository (one commit) and the NODE_OPTIONS script, made before the checker's own environment points at them. */
function makeDecoy() {
  rmSync(DECOY, { recursive: true, force: true })
  mkdirSync(DECOY, { recursive: true })
  writeFileSync(join(DECOY, 'decoy.txt'), 'not the code under test\n')
  for (const a of [['init', '-q'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'decoy']]) git(DECOY, ...a)
  writeFileSync(NODE_MARKER, `require('fs').appendFileSync(${JSON.stringify(NODE_SEEN)}, JSON.stringify(process.argv.slice(1)) + '\\n')\n`)
  rmSync(NODE_SEEN, { force: true })
  return git(DECOY, 'rev-parse', 'HEAD').trim()
}


/** Starts a run: { name, cwd, args, polluted, env } → { name, cwd, code, out, ms }; started(child) when it starts. */
function start({ name, cwd, script, args, polluted, env: extra = {}, started = () => {} }) {
  const env = { ...runContext.childEnv(), ...(polluted ? { ...AGENT_SHELL, ...SHELL_ELSEWHERE } : {}), ...extra }
  const t0 = Date.now()
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(cwd, script), ...args], { cwd, env })
    started(p)
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ name, cwd, script, code, out, polluted, ms: Date.now() - t0 }))
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Waits until fn() is true, checking every 100 ms, up to ms; returns whether it was. */
async function until(fn, ms) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(100)) if (fn()) return true
  return false
}

async function round(k, wt, decoyHead) {
  console.log(`\n--- Round ${k} of ${repeat}`)
  // Both builds stale: each worktree's runners find it so at the same time.
  const since = Date.now()
  for (const w of [root, wt]) rmSync(join(w, 'out', '.e2e-build.json'), { force: true })
  rmSync(NODE_SEEN, { force: true })
  const e2e = ['tests/e2e/run.mjs', [...SUITES, '--build', '--record', '--no-progress']]
  const runs = await Promise.all([
    start({ name: 'this worktree, e2e (agent shell)', cwd: root, script: e2e[0], args: e2e[1], polluted: true }),
    start({ name: 'this worktree, scenario (plain)', cwd: root, script: 'tests/scenarios/run.mjs', args: ['--only', SCENARIO], polluted: false }),
    start({ name: 'second worktree, e2e (plain)', cwd: wt, script: e2e[0], args: e2e[1], polluted: false }),
    start({ name: 'second worktree, e2e (agent shell)', cwd: wt, script: e2e[0], args: e2e[1], polluted: true })
  ])
  for (const r of runs) {
    check(`${r.name}: passes`, r.code === 0, `exit ${r.code}\n${r.out.split(/\r?\n/).filter((l) => /FAIL|ERROR|Error|failed/.test(l)).slice(0, 12).join('\n')}`)
    r.lane = /Lane (\d+):/.exec(r.out)?.[1]
    r.logs = /Logs: (.+)$/m.exec(r.out)?.[1]?.trim() ?? null
    r.folders = /suites' folders: (.+)$|folders in (.+)$/m.exec(r.out)?.slice(1).find(Boolean)?.trim() ?? null
    r.ports = /ports (\d+)–(\d+)|Agent API port (\d+)/.exec(r.out)?.slice(1).filter(Boolean).map(Number) ?? []
  }
  const lanes = runs.map((r) => r.lane)
  check('each run holds a lane of its own', lanes.every((l) => l !== undefined) && new Set(lanes).size === runs.length, lanes.join(', '))
  const folders = runs.map((r) => r.folders)
  check('…and so folders of its own', folders.every(Boolean) && new Set(folders.map((f) => f.toLowerCase())).size === runs.length, folders.join(' | '))
  const spans = runs.map((r) => [r.ports[0], r.ports.at(-1)])
  const overlap = spans.some(([a, b], i) => spans.some(([c, d], j) => i !== j && a <= d && c <= b))
  check('…and ports no other run uses', spans.every(([a]) => a) && !overlap, JSON.stringify(spans))
  const logs = runs.filter((r) => r.logs).map((r) => r.logs.toLowerCase())
  check('each e2e run keeps its own logs folder', logs.length === 3 && new Set(logs).size === 3, logs.join(' | '))
  for (const [w, label] of [[root, 'this worktree'], [wt, 'the second worktree']]) {
    const inIt = runs.filter((r) => r.cwd === w)
    const builds = inIt.reduce((n, r) => n + (r.out.match(/^Building \(the dev build/gm)?.length ?? 0), 0)
    // Once, whoever built it: a second checker started in this worktree at the same time may have built it first (#282).
    const once = builtOnce({ builds, stamp: buildStamp(w), inputs: buildInputs(w), at: buildStampedAt(w), since })
    check(`${label}: built once while its two runs ran at the same time, stamped as its source (${once.why})`, once.ok, once.why)
    check(`${label}: no build lock left held`, !existsSync(buildLock(w).folder))
    // The record's code is this worktree's (with GIT_DIR leaked, it would be the decoy's commit).
    const code = fingerprint(w)
    for (const r of inIt.filter((x) => x.script === e2e[0])) check(`${r.name}: its record names this worktree's code`, r.out.includes(`code \`${code}\``), /code `[^`]+`/.exec(r.out)?.[0] ?? 'no record')
  }
  // The decoy: same commit, nothing added, changed or registered as a worktree; and NODE_OPTIONS only in the runners.
  const decoyStatus = git(DECOY, 'status', '--porcelain', '--ignored').trim()
  const decoyClean = git(DECOY, 'rev-parse', 'HEAD').trim() === decoyHead && !decoyStatus && git(DECOY, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length === 1
  check("no run's git used the shell's GIT_DIR/GIT_WORK_TREE (the decoy is untouched)", decoyClean, decoyStatus)
  const seen = existsSync(NODE_SEEN) ? readFileSync(NODE_SEEN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)[0] ?? '') : []
  const others = seen.filter((f) => !/[\\/]tests[\\/]e2e[\\/]run\.mjs$/.test(f))
  check('NODE_OPTIONS reached the polluted runners and no Node process they started', seen.length === 2 && !others.length, `${seen.length} started with it: ${others.join(', ')}`)
}

/** The heavy-run queue (--heavy): see the top of this file. */
async function heavyRound(k, worktrees) {
  console.log(`\n--- Round ${k} of ${repeat} (heavy runs)`)
  const pool = join(RUN, 'heavy-slots')
  rmSync(pool, { recursive: true, force: true })
  // A stand-in for Combwork's Agent API: the runs report their progress to it, and ask it who holds the merge slot (HB).
  const reports = []
  const api = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      reports.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : {} })
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST' && req.url === '/v1/progress') res.end(JSON.stringify({ id: `r${reports.length}` }))
      else if (req.method === 'GET' && req.url === '/v1/projects/hive/merge-slot') res.end(JSON.stringify({ project: 'hive', branch: 'main', holder: { kind: 'agent', name: 'HB', cards: [] }, waiting: [] }))
      else res.end('{}')
    })
  })
  await new Promise((r) => api.listen(0, '127.0.0.1', r))
  // No side slot (HI-2070): these runs are small (two suites, twice), and queue for the heavy slots as heavy runs do.
  // The agent's token in its file, as a session has it (HI-2262: never HIVE_API_TOKEN).
  const tokenFile = join(RUN, 'agent-token.json')
  writeFileSync(tokenFile, JSON.stringify({ token: 'agent-token' }))
  const env = { HIVE_TEST_HEAVY_DIR: pool, HIVE_TEST_HEAVY_SLOTS: '2', HIVE_TEST_SIDE_SLOTS: '0', CW_API_URL: `http://127.0.0.1:${api.address().port}`, CW_API_TOKEN_FILE: tokenFile }
  const slots = () => (existsSync(pool) ? readdirSync(pool).filter((f) => /^slot-\d+\.json$/.test(f)).length : 0)
  const waiting = () => (existsSync(pool) ? readdirSync(pool).filter((f) => f.startsWith('wait-')).length : 0)
  // Heavy by repeating: two quick suites, twice.
  const args = ['isolation', 'about', '--repeat', '2', '--build']
  let most = 0
  const watch = setInterval(() => (most = Math.max(most, slots())), 50)
  try {
    const runs = Promise.all(worktrees.map((w, i) => start({ name: `worktree ${i + 1}, heavy e2e`, cwd: w, script: 'tests/e2e/run.mjs', args, env })))
    // While two hold the slots and one waits: a run with --no-wait fails at once.
    const queued = await until(() => slots() === 2 && waiting() === 1, 120_000)
    check('two heavy runs hold the slots and the third waits', queued, `slots ${slots()}, waiting ${waiting()}`)
    const refused = await start({ name: '--no-wait', cwd: root, script: 'tests/e2e/run.mjs', args: [...args.slice(0, -1), '--no-wait'], env })
    check('a run with --no-wait fails at once, saying who holds the slots', refused.code === 2 && /No test slot free \(--no-wait\).*held by .*e2e: 2 suites × 2/.test(refused.out) && refused.ms < 15_000, `exit ${refused.code} in ${refused.ms} ms: ${refused.out.trim().split('\n').at(-1)}`)
    const done = await runs
    for (const r of done) check(`${r.name}: passes`, r.code === 0, `exit ${r.code}\n${r.out.split(/\r?\n/).filter((l) => /FAIL|ERROR|Error|failed/.test(l)).slice(0, 12).join('\n')}`)
    check('never more than two at once', most === 2, `${most} at once`)
    const waited = done.filter((r) => /^Waiting for a test slot \(2 heavy runs at once/m.test(r.out))
    check('one run waited, saying who held the slots, and started once one was let go', waited.length === 1 && /held by .*e2e: 2 suites × 2 in /.test(waited[0].out) && /^Got a test slot after \d+ s/m.test(waited[0].out), done.map((r) => r.out.split('\n').filter((l) => /test slot/.test(l)).join(' / ')).join(' | '))
    // The stand-in gives each run the id r<n>, n its place among the requests.
    // The wait is the run's `waiting` (#549: what it waits for, not a step's name).
    const row = reports.findIndex((x) => x.method === 'POST' && x.url === '/v1/progress' && x.body.title === 'e2e: waiting for a test slot')
    const id = `r${row + 1}`
    // What it waits for is the run's `waiting` (#549), set as it starts and updated while it waits.
    // Named as what is ahead of it (HI-2070), never as if the holders' run were its own.
    const named = reports.some((x) => ((x.method === 'POST' && reports.indexOf(x) === row) || (x.method === 'PATCH' && x.url === `/v1/progress/${id}`)) && /^waiting for a test slot \(2 heavy runs ahead: .*e2e: 2 suites × 2/.test(x.body.waiting ?? ''))
    const ended = reports.some((x) => x.url === `/v1/progress/${id}/finish` && x.body.ok === true && /got a test slot after/.test(x.body.summary ?? ''))
    check('…and showed in the Progress panel as waiting, naming who held the slots, until it got one', row >= 0 && named && ended, JSON.stringify(reports.filter((x) => /waiting|slot/.test(JSON.stringify(x.body))).slice(0, 4)))
    check('every slot is let go at the end', slots() === 0 && waiting() === 0, readdirSync(pool).join(', '))

    // The side slot (HI-2070): with both heavy slots held (by this checker), a small run takes the side slot without
    // waiting, while a heavy run (more than three suites' repeats) is refused at once: it never takes the side slot.
    const sided = { ...env, HIVE_TEST_SIDE_SLOTS: '1' }
    const gates = [await trySlot(pool, { slots: 2, owner: process.pid, what: 'the checker, 1', root }), await trySlot(pool, { slots: 2, owner: process.pid, what: 'the checker, 2', root })]
    try {
      let sideHeld = false
      const sideWatch = setInterval(() => (sideHeld ||= existsSync(pool) && readdirSync(pool).some((f) => /^side-\d+\.json$/.test(f))), 50)
      const small = await start({ name: 'small run', cwd: root, script: 'tests/e2e/run.mjs', args: [...args.slice(0, -1), '--no-wait'], env: sided })
      clearInterval(sideWatch)
      check('a small run takes the side slot while two heavy runs hold theirs, and passes', gates.every((g) => g.slot !== undefined) && sideHeld && small.code === 0 && !/Waiting for a test slot/.test(small.out), `heavy slots ${gates.map((g) => g.slot)}, side held ${sideHeld}, exit ${small.code}: ${small.out.trim().split('\n').at(-1)}`)
      const big = await start({ name: 'heavy run', cwd: root, script: 'tests/e2e/run.mjs', args: ['isolation', 'about', '--repeat', '4', '--no-wait'], env: sided })
      check('…while a heavy run never takes the side slot: refused at once, with the side slot free', big.code === 2 && /No test slot free \(--no-wait\): 2 heavy runs at once/.test(big.out) && big.ms < 15_000, `exit ${big.code} in ${big.ms} ms: ${big.out.trim().split('\n').at(-1)}`)
    } finally {
      for (const g of gates) rmSync(join(pool, `slot-${g.slot}.json`), { force: true })
    }
    check('…and every slot is let go', existsSync(pool) && !readdirSync(pool).some((f) => /^(slot|side|model)-\d+\.json$/.test(f)), readdirSync(pool).join(', '))

    // A run killed while it holds a slot: with one slot, the next run takes it without waiting.
    let child
    const killed = start({ name: 'killed', cwd: root, script: 'tests/e2e/run.mjs', args, env: { ...env, HIVE_TEST_HEAVY_SLOTS: '1' }, started: (p) => (child = p) })
    const held = await until(() => slots() === 1, 60_000)
    endChildTree(child)
    await killed
    const next = await start({ name: 'after a killed run', cwd: root, script: 'tests/e2e/run.mjs', args, env: { ...env, HIVE_TEST_HEAVY_SLOTS: '1' } })
    check("a killed run's slot is taken by the next run without waiting", held && next.code === 0 && !/Waiting for a test slot/.test(next.out), `held ${held}, exit ${next.code}`)

    // The merge slot holder's run goes first (#558). The only slot is this checker's; two runs wait for it, then the
    // run of the agent that holds the merge slot (HB, says the stand-in) asks last and takes it when it is let go.
    const single = { ...env, HIVE_TEST_HEAVY_SLOTS: '1', CW_PROJECT: 'hive' }
    const run = (i, agent, started) => start({ name: `${agent}, worktree ${i + 1}`, cwd: worktrees[i], script: 'tests/e2e/run.mjs', args, env: { ...single, CW_AGENT: agent }, started })
    const slotFile = () => readdirSync(pool).find((f) => /^slot-\d+\.json$/.test(f))
    let gate = await trySlot(pool, { slots: 1, what: 'the checker', root })
    const earlier = [run(0, 'B1')]
    let lined = await until(() => waiting() === 1, 60_000)
    earlier.push(run(1, 'B2'))
    lined = lined && (await until(() => waiting() === 2, 60_000))
    let merger
    const merging = run(2, 'HB', (p) => (merger = p))
    lined = lined && (await until(() => waiting() === 3, 60_000))
    rmSync(join(pool, `slot-${gate.slot}.json`), { force: true })
    const taken = await until(() => slots() === 1, 60_000)
    const holder = taken ? JSON.parse(readFileSync(join(pool, slotFile()), 'utf8')) : null
    check('a pre-merge run (its agent holds the merge slot) takes the slot before two runs that asked earlier', lined && holder?.pid === merger.pid && holder.first === true, `queued ${lined}, slot held by ${JSON.stringify(holder)}, pre-merge run ${merger?.pid}`)
    const all = await Promise.all([merging, ...earlier])
    check('…having said it was next in line, and all three pass', /^Waiting for a test slot \(1 heavy runs at once.*\), pre-merge, next in line: held by the checker/m.test(all[0].out) && all.every((r) => r.code === 0), all.map((r) => `${r.name}: exit ${r.code}, ${r.out.split('\n').filter((l) => /test slot/.test(l)).join(' / ')}`).join(' | '))

    // A pre-merge run killed while it waits: its place expires, and the run that asked before it takes the slot.
    gate = await trySlot(pool, { slots: 1, what: 'the checker', root })
    const ordinary = run(0, 'B1')
    let doomed
    lined = await until(() => waiting() === 1, 60_000)
    const killedMerge = run(2, 'HB', (p) => (doomed = p))
    lined = lined && (await until(() => waiting() === 2 && existsSync(join(pool, `wait-${doomed.pid}.json`)), 60_000))
    endChildTree(doomed)
    await killedMerge
    rmSync(join(pool, `slot-${gate.slot}.json`), { force: true })
    const after = await ordinary
    check("a killed pre-merge run's place expires: the run that asked before it takes the slot", lined && after.code === 0 && /^Got a test slot after \d+ s/m.test(after.out), `queued ${lined}, exit ${after.code}: ${after.out.split('\n').filter((l) => /test slot/.test(l)).join(' / ')}`)
    check('…and every slot and place is let go', slots() === 0 && waiting() === 0, readdirSync(pool).join(', '))

    // A heavy scenario run inside a suite (#211): its parent (this checker, standing in for an e2e run) holds the only slot.
    const parent = await trySlot(pool, { slots: 1, what: 'the parent e2e run', root })
    try {
      const one = { ...env, HIVE_TEST_HEAVY_SLOTS: '1' }
      const scenarios = ['--repeat', '2', '--only', SCENARIO, '--no-wait', '--no-progress']
      // What a suite's agent shell keeps of its run context (E2E_RUN_*).
      // Its parent's run holds the CPU slot it runs in: E2E_RUN_SLOTS says so (HI-2070).
      const inSuite = { ...one, E2E_RUN_SUITE: 'progressreport', E2E_RUN_DIR: join(pool, 'parent-run'), E2E_RUN_PORT: '47950', E2E_RUN_SLOTS: 'cpu' }
      const nested = await start({ name: 'nested heavy scenarios', cwd: root, script: 'tests/scenarios/run.mjs', args: scenarios, env: inSuite })
      check('a heavy scenario run inside a suite runs without a slot while its parent holds the only one, even with --no-wait', parent.slot === 0 && nested.code === 0 && !/test slot/i.test(nested.out), `parent slot ${parent.slot}, exit ${nested.code}: ${nested.out.trim().split('\n').slice(-3).join(' / ')}`)
      // Inside a suite of a light run, which holds no slot (HI-2070): no credit, so it asks for a slot and is refused.
      const light = await start({ name: 'nested heavy scenarios, light parent', cwd: root, script: 'tests/scenarios/run.mjs', args: scenarios, env: { ...inSuite, E2E_RUN_SLOTS: '' } })
      check("…while inside a light run's suite (no slot held: no credit) it asks for one, refused at once", light.code === 2 && /No test slot free \(--no-wait\).*held by the parent e2e run/.test(light.out) && light.ms < 15_000, `exit ${light.code} in ${light.ms} ms: ${light.out.trim().split('\n').at(-1)}`)
      const top = await start({ name: 'top-level heavy scenarios', cwd: root, script: 'tests/scenarios/run.mjs', args: scenarios, env: one })
      check('…while the same run at the top level is refused, naming the holder', top.code === 2 && /No test slot free \(--no-wait\).*held by the parent e2e run/.test(top.out) && top.ms < 15_000, `exit ${top.code} in ${top.ms} ms: ${top.out.trim().split('\n').at(-1)}`)
    } finally {
      rmSync(join(pool, `slot-${parent.slot}.json`), { force: true })
    }
  } finally {
    clearInterval(watch)
    api.close()
  }
}

/** A run that waits for a test lane while its source changes (#735): see the top of this file. */
async function laneWaitCheck(wt) {
  console.log('\n--- A run that waits for a test lane while its source changes (#735)')
  // The machine's one pool of its own (#1127): another checker's would have the same ports. Waits while one runs.
  let saidHolder = ''
  const own = await holdOwnPool(runContext.MACHINE_LANES_DIR, {
    root,
    what: 'the concurrency check of a run waiting for a lane',
    onWait: (h) => {
      const line = `Waiting for the pool of its own: held by ${h.what || 'a checker'} in ${h.root || 'another worktree'} (process ${h.pid})`
      if (line !== saidHolder) console.log(line)
      saidHolder = line
    }
  })
  process.on('exit', own.release)
  const pool = join(RUN, 'lanes')
  rmSync(pool, { recursive: true, force: true })
  mkdirSync(pool, { recursive: true })
  // Every lane held by this checker (a claim holds while its process runs), so both runs wait.
  for (let k = 0; k < LANES; k++) writeFileSync(join(pool, `lane-${k}.json`), JSON.stringify({ pid: process.pid, at: Date.now(), what: 'the checker' }))
  const env = { HIVE_TEST_LANES_DIR: pool, HIVE_E2E_DIR: join(RUN, 'lane-work', 'e2e') }
  const probe = join(wt, 'src', 'main', 'lane-wait-probe.ts')
  rmSync(probe, { force: true })
  // What each run has said so far, as it says it.
  const said = { e2e: '', scenario: '' }
  const listen = (key) => (p) => {
    p.stdout.on('data', (d) => (said[key] += d))
    p.stderr.on('data', (d) => (said[key] += d))
  }
  const waitLine = /^Waiting for a test lane \(all \d+ are taken/m
  try {
    const runs = Promise.all([
      start({ name: 'e2e waiting for a lane', cwd: wt, script: 'tests/e2e/run.mjs', args: ['about', '--build', '--record', '--no-progress'], env, started: listen('e2e') }),
      start({ name: 'scenario waiting for a lane', cwd: wt, script: 'tests/scenarios/run.mjs', args: ['--only', SCENARIO, '--no-progress'], env, started: listen('scenario') })
    ])
    const waiting = await until(() => waitLine.test(said.e2e) && waitLine.test(said.scenario), 300_000)
    check('both runs wait for a test lane, every lane of their pool being held', waiting, JSON.stringify({ e2e: said.e2e.slice(-300), scenario: said.scenario.slice(-300) }))
    // The source changes while they wait: what they test must be this, not what was there when they started.
    writeFileSync(probe, '// A source file added while runs waited for a test lane (concurrency.mjs, #735).\nexport {}\n')
    const source = { inputs: buildInputs(wt), code: fingerprint(wt) }
    // Machine lanes of the same numbers, held as a runner holds them, each with a suite's folder in it (#1133): the
    // waiting runs' housekeeping, as they end, must leave them, whatever their own pool's claims say. A lane free on the
    // machine is held by this checker; one another worktree's runner holds is used as it is (its own suites' folders
    // were what went), and counts only while that runner still holds it when the runs end.
    const machineClaim = (k) => {
      try {
        const c = JSON.parse(readFileSync(join(runContext.MACHINE_LANES_DIR, `lane-${k}.json`), 'utf8'))
        return claimHeld(c) ? c : null
      } catch {
        return null
      }
    }
    const sentinels = []
    for (let k = 0; k < 2; k++) {
      const release = (await holdLane(runContext.MACHINE_LANES_DIR, k, { owner: process.pid })) ?? (() => {})
      const holder = machineClaim(k)
      if (!holder) continue
      const dir = join(runContext.TEST_ROOT, 'e2e', 'lanes', String(k), `concurrency-sentinel-${process.pid}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'held.txt'), "A machine lane's suite folder, kept while its lane is held (the concurrency check, #1133).\n")
      sentinels.push({ k, dir, release, holder })
    }
    for (let k = 0; k < 2; k++) rmSync(join(pool, `lane-${k}.json`), { force: true })
    const [e2e, scenario] = await runs
    // Still held by the same runner throughout: its lane's folders were never another runner's to remove.
    const counted = sentinels.filter((s) => machineClaim(s.k)?.pid === s.holder.pid)
    for (const s of sentinels.filter((x) => !counted.includes(x))) console.log(`(machine lane ${s.k} changed hands while the runs ran: it doesn't count)`)
    if (counted.length) check("machine lanes held by a runner keep their folders through the waiting runs' housekeeping", counted.every((s) => existsSync(join(s.dir, 'held.txt'))), counted.filter((s) => !existsSync(join(s.dir, 'held.txt'))).map((s) => `lane ${s.k}'s folder was removed, the lane held by ${s.holder.pid === process.pid ? 'this checker' : `process ${s.holder.pid}`} throughout`).join('; '))
    else console.log("(no machine lane 0 or 1 stayed held through the runs: the housekeeping check didn't run)")
    for (const s of sentinels) {
      rmSync(s.dir, { recursive: true, force: true })
      s.release()
    }
    for (const r of [e2e, scenario]) {
      check(`${r.name}: passes`, r.code === 0, `exit ${r.code}\n${r.out.split(/\r?\n/).filter((l) => /FAIL|ERROR|Error|failed|isn't from this source/.test(l)).slice(0, 12).join('\n')}`)
      check(`${r.name}: it got a lane after waiting`, /^Got a test lane after \d+ s/m.test(r.out), r.out.slice(0, 600))
      // Its pool's ports, never a machine lane's another worktree's run may hold (#1127).
      const port = Number(/^Lane \d+: (?:ports|Agent API port) (\d+)/m.exec(r.out)?.[1])
      check(`${r.name}: its lane's ports are its pool's own`, port >= OWN_POOL_FIRST - 1, /^Lane .*/m.exec(r.out)?.[0] ?? 'no lane line')
    }
    // Built once, after the wait, by one of the two (the build lock): from the source as it was once they had a lane.
    const builtAfter = [e2e, scenario].filter((r) => {
      const got = r.out.search(/^Got a test lane after/m)
      const built = r.out.search(/^Building \(the dev build/m)
      return got >= 0 && built > got
    })
    check('the build is made after the wait, from the source as it is then', builtAfter.length === 1 && buildStamp(wt) === source.inputs, `${builtAfter.length} built after the wait; stamp ${buildStamp(wt) === source.inputs ? 'is' : 'is not'} the changed source's`)
    check("the e2e run's record names the changed source, and is valid", e2e.out.includes(`code \`${source.code}\``) && !/Not valid/.test(e2e.out), /code `[^`]+`/.exec(e2e.out)?.[0] ?? 'no record')
  } finally {
    rmSync(probe, { force: true })
    rmSync(pool, { recursive: true, force: true })
    own.release()
  }
}

/**
 * A packaged run (HIVE_EXE) of suites none of which can run on it, in the second worktree before anything builds it
 * (#1591): no dev build is made or needed, and the run still writes its record, not valid ("nothing was tested"), with
 * each suite NOT RUN and why, and fails. HIVE_EXE names no file: a run that started a Combwork would fail on it.
 */
async function packagedNothingCheck(wt) {
  console.log('\n--- A packaged run where no suite chosen can run, with no dev build (#1591)')
  const built = join(wt, 'out', 'main', 'index.js')
  check('the second worktree has no dev build yet', !existsSync(built), built)
  const work = join(RUN, 'packaged-work', 'e2e')
  const r = await start({ name: 'packaged, nothing runnable', cwd: wt, script: 'tests/e2e/run.mjs', args: ['cardloop', 'wakepaste-codex', '--build', '--record', '--no-progress'], polluted: false, env: { HIVE_EXE: join(RUN, 'no-such', 'Hive.exe'), HIVE_E2E_DIR: work } })
  check(`${r.name}: fails (nothing was tested)`, r.code === 1, `exit ${r.code}\n${r.out.slice(-800)}`)
  check(`${r.name}: makes no dev build`, !/^Building \(the dev build/m.test(r.out) && !/No dev build/.test(r.out) && !existsSync(built), r.out.slice(0, 800))
  const logs = /Logs: `?([^`\r\n]+?)`?$/m.exec(r.out)?.[1]?.trim()
  const read = (f) => (logs && existsSync(join(logs, f)) ? readFileSync(join(logs, f), 'utf8') : '')
  const md = read('run-record.md')
  let json = null
  try {
    json = JSON.parse(read('run-record.json'))
  } catch {}
  check(`${r.name}: its Markdown record says it is not valid, and why each suite was NOT RUN`, md.startsWith("**Not valid — don't trust this record:** no suite chosen can run on a packaged build: nothing was tested.") && /\| cardloop \| \*\*NOT RUN\*\*: it starts this checkout's Electron itself/.test(md) && /\| wakepaste-codex \| \*\*NOT RUN\*\*: wakepaste-cli\/run\.cjs: /.test(md), md.slice(0, 800) || `no record in ${logs}`)
  check(`${r.name}: its JSON record too`, json?.valid === false && !!json.packaged && json.results?.length === 2 && json.results.every((x) => x.notRun && !x.ok), JSON.stringify(json)?.slice(0, 800) ?? `no JSON record in ${logs}`)
}

const made = []
let decoyHead = null
try {
  const stale = removeStale(root)
  if (stale.length) console.log(`Removed the folders of checkers that are gone: ${stale.join(', ')}`)
  console.log(`This checker's folder: ${RUN}`)
  if (!heavy) {
    decoyHead = makeDecoy()
    // The checker's own children too (its worktree setup and clean-up, the fingerprints it checks): none may follow it.
    Object.assign(process.env, { GIT_DIR: SHELL_ELSEWHERE.GIT_DIR, GIT_WORK_TREE: SHELL_ELSEWHERE.GIT_WORK_TREE })
  }
  if (heavy) {
    made.push(addWorktree(root, RUN, 'worktree'), addWorktree(root, RUN, 'worktree-3'))
    console.log(`Other worktrees: ${made.join(', ')}`)
  } else {
    made.push(addWorktree(root, RUN, 'worktree'))
    console.log(`Second worktree: ${made[0]}\nBuild locks: ${BUILD_LOCKS}`)
    // Before the rounds build that worktree.
    if (!laneWaitOnly) await packagedNothingCheck(made[0])
  }
  for (let k = 1; k <= repeat; k++) {
    if (heavy) await heavyRound(k, [root, ...made])
    else if (!laneWaitOnly) await round(k, made[0], decoyHead)
    if (failed) {
      if (k < repeat) console.log(`\nRound ${k} failed: stopping here.`)
      break
    }
  }
  if (!heavy && !failed) await laneWaitCheck(made[0])
} catch (e) {
  check('the check ran', false, e.stack ?? String(e))
} finally {
  // Only this checker's folder, with whatever of it was made (a setup that failed part way removed its own worktree).
  if (keep) {
    keepDir(RUN)
    console.log(`Kept: ${RUN} (remove its worktrees with git worktree remove, then the folder)`)
  } else {
    try {
      removeInvocation(root, RUN)
    } catch (e) {
      check("this checker's folder is removed", false, e.message)
    }
  }
}
check("this worktree's node_modules is untouched", existsSync(join(root, 'node_modules', 'electron')) && readdirSync(join(root, 'node_modules')).length > 50)
console.log(failed ? `\n${failed} failed` : `\nAll passed (${repeat} round${repeat === 1 ? '' : 's'}).`)
process.exit(failed ? 1 : 0)
