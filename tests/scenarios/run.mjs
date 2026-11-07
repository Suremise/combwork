// Runs the scenarios (scenarios.cjs) with a provider and writes what happened.
//
//   npm run scenarios                                     # the fake Claude Code: free, deterministic, every check
//   npm run scenarios -- --provider fake-codex            # the fake Codex: its delivery contracts (delivery.cjs, HI-2662)
//   npm run scenarios -- --provider fake-copilot          # the real Copilot CLI offline against a scripted model: the same
//   npm run scenarios -- --provider fake-codex --every    # every scenario there (or --only some, on any provider)
//   npm run scenarios -- --provider claude-code --model haiku --budget 2      # model trials (opt-in, cost tokens)
//   npm run scenarios -- --provider codex --model gpt-5.6-luna --only work-on-card,review-card
//   npm run scenarios -- --dialect "my/Opus 5.5 v2.json" --only work-on-card   # a dialect file in the model slot (HI-2439)
//   npm run scenarios -- --only work-on-card --signed-out   # the fake signed out: the trial is skipped for the environment
//   npm run scenarios -- --only work-on-card --signed-out=launch   # its OAuth expired: it exits at launch, skipped too
//   npm run scenarios -- --only work-on-card --signed-out=late   # signed out, shown only once the prompt is sent: skipped too
//
// A trial that Combwork shows waiting for a sign-in, or whose CLI says it hit a limit or can't reach its API, is skipped for
// the environment at once (no checks failed, no cost), and so are the provider's other trials, said once (#302).
//
// More than five scenarios, or --repeat, waits for a test slot (tests/e2e/slots.mjs; --no-wait fails at once instead),
// unless started inside an e2e suite, whose run holds one: a few fake runs in all take the side slot, and a real
// model's run of any size only a model trial's slot (HI-2070). A pre-merge run goes first in that queue (#558): --pre-merge,
// or one started by the agent holding its project's merge slot. Every run waits for a test lane while all 10 are taken
// (tests/e2e/lanes.mjs, #707; --no-wait fails at once instead).
// --budget N (USD, API-equivalent, above 0, default 2) stops a model run once the scenarios so far cost that much, or
// as soon as a trial reports no cost (the spend can't be checked then; --allow-unknown-cost goes on anyway); --only runs
// some; --random N picks N of them at random, printing its seed (--seed S picks the same again); --keep leaves each scenario's profile and workspace; --repeat N runs each N times (samples, for spread);
// --save-baseline NAME keeps this run's benchmark as a named baseline (an older one of that name is kept, not
// overwritten). Results go to %LOCALAPPDATA%\combwork-test\scenarios\results (the newest 30 fake runs and, counted apart,
// the newest 30 model trials are kept, besides those a card cites and those a run still writes into: runner.json,
// HI-2234, HI-2236): results.json
// (every scenario's checks, skills read, Combwork calls, versions, usage, measures), benchmark.json (combwork-benchmark/1: the
// Performance page compares two) and summary.md; results.json is written as each trial ends (#1457: a run cut short keeps
// what it had). Run in a Combwork agent's session it shows in the Progress panel, a step per trial (--no-progress: not).
// With a fake provider a failed check fails the run (exit 1); model
// trials only report (models vary). A dev build that isn't from the source as it is now (tests/e2e/build.mjs) is rebuilt
// first, so a run (and a baseline) never measures other code.
//
// Runs at the same time (from different worktrees, or the same one) don't share folders or ports: each run claims a
// lane, from the same pool as the e2e runner (tests/e2e/lanes.mjs), and keeps its scenarios' profiles and workspaces in
// %LOCALAPPDATA%\combwork-test\scenarios\lanes\<k> (--keep leaves them there) with the lane's first port as their Agent API
// port (#183, #184). Results and baselines stay shared: Performance → Compare reads them.
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { devBuild, ensureBuildWithSlot } from '../e2e/build.mjs'
import { LANES, describeHolder, laneWaitLine, lanesFirst, laneWork, waitForLane } from '../e2e/lanes.mjs'
import { buildNeedsCpuSlot, creditFor, preMerge, refusedLine, slotPool, waitForSlot, waitLine, waitSummary } from '../e2e/slots.mjs'
import { waitForCodexHome } from '../e2e/codexHomeLock.mjs'
import { autoClean } from '../e2e/clean.mjs'
import { scenariosProgress, slotWaitProgress } from '../progressReport.mts'
import { endRunTemp, startRunTemp } from '../runTemp.mts'

const require = createRequire(import.meta.url)
// What may be deleted (#253): never what a card that isn't Done cites, nothing earlier while the board can't be read.
const evidence = require('../e2e/evidence.cjs').evidenceFor(join(import.meta.dirname, '..', '..'))
const spare = (p) => evidence.protects(p)
// Without the board nothing a run made could be removed, so copies would pile up (#285): as the e2e runner, it doesn't
// start (CW_TEST_NO_BOARD=1: no board cites test output on this machine).
if (!evidence.ok) {
  console.error(`Can't tell what the tests may delete: ${evidence.why}. Fix the board, or set CW_TEST_NO_BOARD=1 if no Combwork board cites test output on this machine.`)
  process.exit(2)
}
// The run's own temp folder in combwork-test\tmp (HI-2102): the test copies of Combwork and the CLIs its scenarios start get it
// as TEMP (e2e/runContext.cjs ALLOW), not %TEMP%. It goes as the runner exits; its start removes what stopped runs
// left, as the evidence rules allow. Before lib.cjs loads: Playwright, which the harness runs in this process, takes
// the temp folder for its playwright-artifacts-* folders as it loads.
startRunTemp(spare)
process.on('exit', () => {
  const failed = endRunTemp()
  if (failed) console.warn(`The run's temp folder was left behind (the next run's start removes it after a day): ${failed}`)
})
const lib = require('../e2e/lib.cjs')
const runContext = require('../e2e/runContext.cjs')
const { runScenario, dialectForRun, dialectRecord, sourceFingerprint, claudeSignedIn, environmentAdvice, CLAUDE_TEST_HOME, PROVIDERS } = require('./harness.cjs')
const { copilotInstalled } = require('../e2e/fake-copilot-api.cjs')
const { SCENARIOS, FIXTURES_VERSION } = require('./scenarios.cjs')
const { DELIVERY_PROVIDERS, scenarioSet } = require('./delivery.cjs')
const { parseRandom, parseSeed, pickRandom } = require('./randomPick.cjs')
const { benchmarkOf, pruneResults, saveBaseline, resultsFolder, releaseResults, writeResults, parseBudget, budgetGate, spendText } = require('./benchmark.cjs')

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const provider = arg('provider', 'fake')
const model = arg('model', undefined)
const effort = arg('effort', undefined)
let budget
try {
  budget = parseBudget(arg('budget', '2'))
} catch (e) {
  console.error(e.message)
  process.exit(2)
}
const allowUnknownCost = argv.includes('--allow-unknown-cost')
const only = arg('only', '')?.split(',').filter(Boolean)
// --random N (HI-2655): N of the scenarios (of --only's, if given) picked at random, seeded (--seed S picks the same again).
let random = null
try {
  random = argv.includes('--random') ? { count: parseRandom(arg('random', '')), seed: parseSeed(arg('seed', '')) } : null
} catch (e) {
  console.error(e.message)
  process.exit(2)
}
const keep = argv.includes('--keep')
const repeats = Math.max(1, Math.min(20, Number(arg('repeat', '1')) || 1))
const baselineName = arg('save-baseline', '')
const fake = !!PROVIDERS[provider]?.fake
if (!PROVIDERS[provider]) {
  console.error(`Unknown provider "${provider}": fake, fake-codex, fake-copilot, claude-code or codex.`)
  process.exit(2)
}
// --dialect <file> (HI-2439): a dialect file in the model slot of every agent of the provider's CLI, its chain recorded
// in the results. Without it, the shipped files (all empty): the Default, which releases test.
let dialect = null
try {
  dialect = dialectForRun(arg('dialect', ''), provider)
} catch (e) {
  console.error(`--dialect: ${e.message}`)
  process.exit(2)
}
if (dialect) console.log(`Dialect ${dialect.path}: ${dialect.overrides} override(s), chain ${dialect.hash || '(the Default)'}${dialect.outdated.length ? `; outdated, falling through: ${dialect.outdated.join(', ')}` : ''}`)
// The fake Claude Code acting out an expired sign-in: to check that a trial the environment stops is skipped (#302).
// --signed-out=launch: its OAuth session can't be refreshed, so it exits before its session starts (#577).
// --signed-out=late: it shows it isn't logged in only once the prompt is sent, which it doesn't take (#1321).
const signedOut = argv.includes('--signed-out=launch') ? 'launch' : argv.includes('--signed-out=late') ? 'late' : argv.includes('--signed-out')
if (signedOut && provider !== 'fake') {
  console.error('--signed-out is for the fake Claude Code (--provider fake) only: a real CLI is never signed out from here.')
  process.exit(2)
}
// Model trials run only in the providers' test homes, signed in once by hand: never the user's own, never a login here.
const notSignedIn =
  provider === 'codex' && !lib.codexSignedIn()
    ? `Codex isn't signed in to its test home (${lib.CODEX_HOME}): see tests/e2e/README.md.`
    : provider === 'claude-code' && !claudeSignedIn()
      ? `Claude Code isn't signed in to its test home (${CLAUDE_TEST_HOME}): see tests/scenarios/README.md.`
      : provider === 'fake-copilot' && !copilotInstalled()
        ? "the GitHub Copilot CLI isn't installed (fake-copilot runs the real CLI offline)."
        : null
if (notSignedIn) {
  console.log(`SKIP all scenarios: ${notSignedIn}`)
  process.exit(0)
}

// HI-2662: the fake Codex and the Copilot CLI run the delivery contracts (delivery.cjs) unless --every or --only says otherwise.
const every = argv.includes('--every')
const listed = scenarioSet(SCENARIOS, provider, { only: only ?? [], every })
if (DELIVERY_PROVIDERS.includes(provider) && !only?.length && !every) console.log(`${provider}: the ${listed.length} delivery contracts (tests/scenarios/delivery.cjs); the common set runs on the fake provider. --every for all ${SCENARIOS.length}.`)
const chosen = random ? pickRandom(listed, random.count, random.seed) : listed
if (random) console.log(`Picked ${chosen.length} of ${listed.length} at random (seed ${random.seed}): ${chosen.map((s) => s.id).join(', ')}. Again: --random ${random.count} --seed ${random.seed}${only?.length ? ` --only ${only.join(',')}` : ''}, or --only ${chosen.map((s) => s.id).join(',')}`)
// More than a few scenarios (or --repeat) is a heavy run: it waits for a test slot, as the e2e runner's do
// (tests/e2e/slots.mjs), so runs on this machine don't slow each other until tests time out; a few fake runs in all
// take the side slot, else a heavy one. A real model's run (a model trial) takes none of those, only a model trial's
// slot, whatever its size (HI-2070). Not one started inside a suite, whose parent holds a slot (slotPool, #211).
// --no-wait: fail at once.
const pool = slotPool({ kind: 'scenarios', count: chosen.length, repeat: repeats, provider })
if (pool) {
  const resource = pool === 'model' ? 'a model-trial slot' : 'a test slot'
  const queue = slotWaitProgress('scenarios', `npm run scenarios -- ${argv.join(' ')}`.trim(), argv, resource)
  let said = ''
  const got = await waitForSlot(runContext.HEAVY_DIR, {
    pool,
    what: `scenarios: ${chosen.length} (${provider})${repeats > 1 ? ` × ${repeats}` : ''}`,
    root: lib.ROOT,
    wait: !argv.includes('--no-wait'),
    first: preMerge(argv.includes('--pre-merge')),
    onWait: (look) => {
      const line = waitLine(look)
      if (line !== said) console.log(line)
      said = line
      queue.waitingAs(waitSummary(look))
    }
  })
  if (got.refused) {
    console.error(refusedLine(got.refused))
    process.exit(2)
  }
  if (said) {
    const after = `${Math.round(got.waitedMs / 1000)} s`
    console.log(`Got ${resource} after ${after}.`)
    await queue.finish(`got ${resource} after ${after}`)
  }
}
// What runs inside this run's test Combworks (an agent's own test run) has this run's slot as credit, and its parent's
// (HI-2070): carried into their sessions (runContext CARRIED), so CPU work inside a model trial still asks for a CPU slot.
process.env.E2E_RUN_SLOTS = creditFor(pool)

// This run's lane: its own folders and Agent API port, so another run at the same time can't remove, open or answer
// for this one's test Combwork. With every lane taken it waits for one (#707), as for a test slot; --no-wait: fail at once.
const laneQueue = slotWaitProgress('scenarios', `npm run scenarios -- ${argv.join(' ')}`.trim(), argv, 'a test lane')
let laneSaid = ''
const lane = await waitForLane(runContext.LANES_DIR, {
  root: lib.ROOT,
  portsFrom: lanesFirst(runContext.OWN_LANES),
  what: `scenarios: ${chosen.length} (${provider})${repeats > 1 ? ` × ${repeats}` : ''}`,
  wait: !argv.includes('--no-wait'),
  onWait: (look) => {
    const line = laneWaitLine(look)
    if (line !== laneSaid) console.log(line)
    laneSaid = line
    laneQueue.waiting(look.holders.map((c) => describeHolder(c)).join('; '))
  }
})
if (lane.refused) {
  console.error(`No test lane free (--no-wait): every test lane (${LANES}) is taken, by ${lane.refused.holders.map((c) => describeHolder(c)).join('; ') || 'runs just finishing'}.`)
  process.exit(2)
}
if (laneSaid) {
  const after = `${Math.round(lane.waitedMs / 1000)} s`
  console.log(`Got a test lane after ${after}.`)
  await laneQueue.finish(`got a test lane after ${after}`)
}
process.on('exit', lane.release)
process.on('SIGINT', () => process.exit(130))

// A model trial holds no CPU slot (HI-2070): a build it has to make is CPU work, so it takes a small run's slot (the
// side slot, else a heavy one) for the build alone, unless what it holds or runs inside covers CPU work.
const takeBuildSlot = async () => {
  const buildQueue = slotWaitProgress('scenarios', `npm run scenarios -- ${argv.join(' ')}`.trim(), argv)
  let said = ''
  const got = await waitForSlot(runContext.HEAVY_DIR, {
    pool: 'small',
    what: `the build for scenarios: ${chosen.length} (${provider})`,
    root: lib.ROOT,
    wait: !argv.includes('--no-wait'),
    onWait: (look) => {
      const line = waitLine(look)
      if (line !== said) console.log(line)
      said = line
      buildQueue.waitingAs(waitSummary(look))
    }
  })
  if (got.refused) {
    console.error(refusedLine(got.refused))
    process.exit(2)
  }
  if (said) await buildQueue.finish(`got a test slot after ${Math.round(got.waitedMs / 1000)} s`)
  return got
}

// Under the worktree's build lock (build.mjs): an e2e or scenario run started beside this one builds it once. Once it
// has a lane (#735): a run that waited for one tests the source as it is then, not as it was when it started.
let build
try {
  build = await ensureBuildWithSlot({
    root: lib.ROOT,
    needsSlot: buildNeedsCpuSlot({ provider, pool }),
    takeSlot: takeBuildSlot,
    runBuild: () => {
      console.log('Building (the dev build is not from this source)…')
      devBuild(lib.ROOT)
    }
  })
} catch (e) {
  console.error(e.message)
  process.exit(e.status ?? 2)
}
if (build.waited) console.log(`Waited for another runner's build of this worktree${build.built ? '' : ': it is from this source'}.`)
if (build.stale) {
  console.error(`The dev build isn't from this source (${build.why}): run the scenarios again once it has stopped changing.`)
  process.exit(2)
}

const workRoot = laneWork(join(lib.WORK, '..', 'scenarios'), lane.lane)
console.log(`Lane ${lane.lane}: Agent API port ${lane.first}, folders in ${workRoot}`)

// Real Codex trials use lib.CODEX_HOME, as the e2e suites do. Fake Codex has its own per-trial home (harness.cjs).
const codexLease = !fake && PROVIDERS[provider].provider === 'codex' ? await waitForCodexHome(lib.CODEX_HOME, { kind: 'scenarios', root: lib.ROOT, what: `scenarios: ${chosen.length} (${provider})`, argv }) : null

// The source this run tests, taken before it starts (and checked again at the end).
const sourceAtStart = sourceFingerprint()
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const resultsDir = join(lib.WORK, '..', 'scenarios', 'results')
const out = resultsFolder(resultsDir, `${stamp}-${provider}`)
// After making its own folder (held, so not counted): the newest 30 of each kind stay besides it (HI-2236).
pruneResults(resultsDir, undefined, spare)
// Held while this process runs (runner.json: no other run's prune takes it, HI-2234), let go as it exits.
process.on('exit', () => releaseResults(out))
// What the run has written to its folder, by name, so a folder removed under it is made again with all of it.
const written = new Map()
const save = (name, data) => {
  writeResults(out, name, data, {
    rewrite: () => {
      for (const [n, d] of written) writeFileSync(join(out, n), d)
    },
    onRecreated: () => console.warn(`\nThe results folder was removed during the run: made it again with what the run has so far (${out}).`)
  })
  written.set(name, data)
}
const results = []
let spent = 0
let unknownCostTrials = 0
// Models of the trials without a cost (the guard names them: usually Combwork has no price for one).
const noCostModels = new Set()
// A trial the environment stopped (not signed in, a limit, the network: #302): the provider's other trials would meet it
// too, so they are skipped, said once.
let environment = null
let saidRest = false
/** What the run has so far: its source and settings (`complete` once every trial has run, and checked again then). */
const metaNow = (complete) => ({
  fixturesVersion: FIXTURES_VERSION,
  source: sourceAtStart,
  ...(complete ? {} : { incomplete: `${results.length} of ${trials.length} trials` }),
  guidance: results.find((r) => r.guidance?.atStart)?.guidance.atStart.revision ?? null,
  provider, model: model ?? '(default)', effort: effort ?? '(default)', mode: PROVIDERS[provider].mode, ...(dialect ? { dialect: dialectRecord(dialect) } : {}), ...(random ? { random: { ...random, picked: chosen.map((s) => s.id) } } : {}), repeats, budgetUsd: budget, when: new Date().toISOString(), spentUsd: Math.round(spent * 1000) / 1000, unknownCostTrials })
// Each trial's result written as it ends (#1457): a run cut short keeps what it had.
// Should even that fail (the folder kept going, or another error), the run goes on: what it has stays in memory and the
// next trial's write tries again; the writes at the end fail the run.
const keepSoFar = () => {
  try {
    save('results.json', JSON.stringify({ meta: metaNow(false), results }, null, 2))
  } catch (e) {
    console.warn(`\nCouldn't write results.json so far (${e.code ?? e.message}): the run goes on, and writes it again after the next trial.`)
  }
}
// The Progress panel (#1457): a step per trial, named with the results so far, so a long run shows it moving.
const trials = Array.from({ length: repeats }, (_, k) => chosen.map((sc) => ({ sc, sample: k + 1, name: repeats > 1 ? `${sc.id} (${k + 1}/${repeats})` : sc.id }))).flat()
const progress = scenariosProgress(trials.map((t) => t.name), provider, argv)
for (const [i, { sc, sample, name }] of trials.entries()) {
  progress.start(i, name)
  if (environment) {
    results.push({ scenario: sc.id, title: sc.title, provider, sample, skipped: `environment: ${environment.why}`, environment: environment.why })
    if (!saidRest) console.log(`SKIP the other trials: ${environment.why}. To run them: ${environment.advice}.`)
    saidRest = true
    progress.done(sc.id, 0, 'skipped')
    keepSoFar()
    continue
  }
  const gate = budgetGate({ fake, budget, spentKnown: spent, unknownCostTrials, allowUnknownCost, noCostModels: [...noCostModels] })
  if (!gate.ok) {
    results.push({ scenario: sc.id, title: sc.title, provider, sample, skipped: gate.reason })
    console.log(`SKIP ${sc.id}: ${gate.reason}`)
    progress.done(sc.id, 0, 'skipped')
    keepSoFar()
    continue
  }
  process.stdout.write(`${sc.id} (${provider}${repeats > 1 ? `, ${sample}/${repeats}` : ''})… `)
  const r = await runScenario(sc, provider, { model, effort, dialect, keep, workRoot, port: lane.first, evidence, signedOut, timeoutMs: fake ? 60000 : 360000 })
  r.sample = sample
  if (r.environment) {
    // Not a result of the scenario: no checks, and no cost assumed.
    environment = { why: r.environment, advice: environmentAdvice(r.environment, provider) }
    results.push(r)
    console.log(`SKIP environment: ${r.environment}, ${r.seconds}s${r.kept ? ` (its folder is kept: ${r.kept})` : ''}`)
    progress.done(sc.id, r.seconds * 1000, 'skipped')
    keepSoFar()
    continue
  }
  // A trial's cost as reported; none reported is unknown (counted), never $0.
  if (typeof r.usage?.costUsd === 'number') spent += r.usage.costUsd
  else if (!fake) {
    unknownCostTrials++
    noCostModels.add(r.usage?.model ?? r.model)
  }
  results.push(r)
  const failed = r.checks.filter((c) => c.ok === false)
  console.log(`${r.error ? `ERROR (${r.error.split('\n')[0]})` : failed.length ? `${failed.length} failed` : 'ok'}, ${r.seconds}s${r.usage?.costUsd ? `, $${r.usage.costUsd.toFixed(3)}` : ''}${r.kept ? ` (its folder is kept: ${r.kept})` : ''}`)
  for (const c of r.checks) console.log(`  ${c.ok === null ? 'SKIP' : c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok === false && c.detail ? ` (${c.detail})` : ''}`)
  // Codex scripts whose calls its rollout didn't record (HI-2235): what they ran can't be seen, so no check credits it.
  if (r.observed?.codeMode?.unknown) console.log(`  NOTE unobservable: ${r.observed.codeMode.unknown} Codex script(s) whose calls the rollout didn't record; no check credits what they ran`)
  progress.done(sc.id, r.seconds * 1000, r.error || failed.length ? 'failed' : 'ok')
  keepSoFar()
}

const sourceAtEnd = sourceFingerprint()
const meta = { ...metaNow(true), ...(sourceAtEnd.head !== sourceAtStart.head || sourceAtEnd.dirty !== sourceAtStart.dirty ? { sourceChangedDuringRun: sourceAtEnd } : {}) }
save('results.json', JSON.stringify({ meta, results }, null, 2))
const appVersion = JSON.parse(readFileSync(join(lib.ROOT, 'package.json'), 'utf8')).version
const benchmarkFile = join(out, 'benchmark.json')
save('benchmark.json', JSON.stringify(benchmarkOf(meta, results, appVersion), null, 2))
if (baselineName) console.log(`Baseline "${baselineName}": ${saveBaseline(join(lib.WORK, '..', 'scenarios', 'baselines'), baselineName, benchmarkFile, spare)}`)
/** What Combwork's own parts cost in the scenario (its measures): tool reply characters, requests, guidance at launch. */
const combworkCost = (m) => (m ? `${m.toolChars.toLocaleString('en')} chars in ${m.toolCalls} tool calls; ${m.apiRequests} requests; ${(m.coreBytes + m.customBytes + m.roleBytes + m.modeBytes + m.catalogBytes).toLocaleString('en')} B guidance` : 'not measured')
const row = (r) => {
  if (r.skipped) return `| ${r.scenario} | skipped: ${r.skipped} | | | | | |`
  const passed = r.checks.filter((c) => c.ok === true).length
  const failed = r.checks.filter((c) => c.ok === false)
  const skipped = r.checks.filter((c) => c.ok === null).length
  return `| ${r.scenario} | ${r.error ? `error: ${r.error.split('\n')[0]}` : failed.length ? `**${failed.length} failed**: ${failed.map((c) => c.name).join('; ')}` : 'pass'} | ${passed}/${r.checks.length}${skipped ? ` (${skipped} skipped)` : ''} | ${r.observed?.skillsRead.join(', ') || '–'} | ${[...new Set(r.observed?.combworkCalls.map((c) => c.tool) ?? [])].join(', ') || '–'} | ${combworkCost(r.measures)} | ${r.usage?.costUsd != null ? `$${r.usage.costUsd.toFixed(3)}` : '–'}, ${r.seconds}s |`
}
const cli = results.find((r) => r.cliVersion)?.cliVersion ?? 'unknown'
save(
  'summary.md',
  [
    `# Scenarios: ${provider}${model ? ` (${model})` : ''}${repeats > 1 ? `, ${repeats} samples each` : ''}`,
    '',
    `Fixtures v${FIXTURES_VERSION}; source ${meta.source.head}${meta.source.dirty ? ` + changes ${meta.source.dirty}` : ''}; guidance ${meta.guidance}; CLI ${cli}; ${meta.when}; spent ${spendText(meta)}.`,
    ...(random ? ['', `Picked at random: ${random.count} with seed ${random.seed} (again: --random ${random.count} --seed ${random.seed}).`] : []),
    ...(dialect ? ['', `Dialect: ${dialect.path} (${dialect.overrides} override(s)), chain ${dialect.files.join(' → ')}, hash ${dialect.hash || '(the Default)'}.`] : []),
    '',
    '| Scenario | Result | Checks | Skills read | Combwork tools | Combwork’s cost | Provider cost, time |',
    '|---|---|---|---|---|---|---|',
    ...results.map(row)
  ].join('\n') + '\n'
)
console.log(`\nResults: ${out}`)
const hardFailures = fake ? results.filter((r) => r.error || r.checks?.some((c) => c.ok === false)).length : 0
const failedTrials = results.filter((r) => r.error || r.checks?.some((c) => c.ok === false)).length
await progress.finish(!hardFailures, `${results.length - failedTrials - results.filter((r) => r.skipped).length} ok, ${failedTrials} failed${results.some((r) => r.skipped) ? `, ${results.filter((r) => r.skipped).length} skipped` : ''}`, join(out, 'summary.md'))
codexLease?.release()
// What tests left in combwork-test that is no longer needed (tests/e2e/clean.mjs), this lane's included: let go first.
lane.release()
await autoClean({ root: lib.ROOT, ev: evidence })
process.exit(hardFailures ? 1 : 0)
