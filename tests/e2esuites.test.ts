// The e2e suites (tests/e2e/suites.mjs): sorted by name, so suites added on different branches don't conflict, each one
// names a suite that exists, and the runner's helpers: which suites a change needs (affected.mjs) and the code's
// fingerprint in a run record (record.mjs).
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs'
import { userInfo } from 'os'
import { basename, join } from 'path'
import { pathToFileURL } from 'url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { SUITES } from './e2e/suites.mjs'
// @ts-expect-error: plain .mjs modules without types
import { AREAS, DOCS_ONLY, EVERYTHING, REAL_TIER, UNIT_ONLY, affectedSuites, under, unitTest } from './e2e/affected.mjs'
// @ts-expect-error: plain .mjs modules without types
import { fingerprint } from './e2e/record.mjs'
// @ts-expect-error: plain .mjs modules without types
import { DEV_SEAMS, PACKAGED_SEAMS, TEST_CHANNELS, devBuildOnly, isRealCli, keepLimits, needsDevBuild, packagedPlan, packagedStatus, parentSuite, parseArgs, portBase, realNotRun, recordStatus, repeatStatus, resultLines, selectSuites, suiteDevOnly, suiteFiles as filesOfSuite, suiteLimitMs, suiteOutcome, suiteSource } from './e2e/runner.mjs'
// @ts-expect-error: plain .mjs modules without types
import { recordJson, recordMarkdown, selectionLine, selectionOf } from './e2e/record.mjs'
// @ts-expect-error: plain .mjs modules without types
import { makeDist } from '../scripts/distCopy.mjs'
// @ts-expect-error: plain .mjs modules without types
import { buildLock, buildStamp, buildStamped, buildStampedAt, builtOnce, devBuild, ensureBuild, ensureBuildWithSlot } from './e2e/build.mjs'
// @ts-expect-error: plain .mjs modules without types
import { LANES, LANE_FIRST, LANE_PORTS, claimHeld, claimLane, describeHolder, holdOwnPool, laneHolders, lanePorts, laneWaitLine, lanesFirst, laneWork, pickLane, portFree, waitForLane } from './e2e/lanes.mjs'
// @ts-expect-error: plain .mjs modules without types
import { SIDE_E2E_JOBS, buildNeedsCpuSlot, creditFor, describeClaim, heavySlots, heldCredit, holdsMergeSlot, isFullUnitRun, isHeavy, launchEnded, leftOverCheck, leftOverLine, needsSlot, preMerge, refusedLine, runOwner, slotPool, slotSettings, trySlot, waitForSlot, waitLine, waitSummary } from './e2e/slots.mjs'
// @ts-expect-error: plain .mjs modules without types
import { addWorktree, invocationDir, keepDir, removeInvocation, removeStale, removeWorktree } from './e2e/tempWorktrees.mjs'
// @ts-expect-error: plain .mjs modules without types
import { FAILED_KEEP_MS, FAILED_MAX, KEEP_HOURS, KEEP_MB, KEEP_RUNS, finishRunDirs, keepSuiteFiles, logRetention, logsRootFor, markRunFailed, newRunDir, pruneRunDirs, pruneRunDirsReleasing, runDirActive, runDirsInOrder, runDirsToPrune, runFailedAt, runStartedAt } from './e2e/logs.mjs'
import { createRequire } from 'module'
import { ProgressStore } from '../src/main/progress'
import { tempDir } from './tempDir'
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

type Suite = { name: string; needs?: string[]; serial?: string }
type Area = { paths: string[]; suites: string[] }
const suites = SUITES as Suite[]
const names = suites.map((s) => s.name)
const realNames = suites.filter(isRealCli).map((s) => s.name)
const dir = join(__dirname, 'e2e')
const root = join(__dirname, '..')

describe('the e2e suite list', () => {
  it('is sorted by name, without repeats', () => {
    expect(names.length).toBeGreaterThan(50)
    expect(names).toEqual([...names].sort())
    expect(new Set(names).size).toBe(names.length)
  })

  it('names suites that exist, and every suite file is listed', () => {
    for (const n of names) expect(existsSync(join(dir, `${n}.cjs`)), n).toBe(true)
    const helpers = ['lib', 'fake-bridge', 'fake-copilot-api', 'runContext', 'evidence', 'codexDiagnostics', 'folderProcesses', 'storeDocs', 'boardRows', 'sessionDeliveryCodec', 'windowsExits', 'layoutReport', 'queueFixture', 'fakeInstall', 'toolLimits']
    const files = execFileSync('git', ['ls-files', 'tests/e2e/*.cjs'], { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((f) => f.replace(/^tests\/e2e\//, '').replace(/\.cjs$/, ''))
      .filter((f) => !f.includes('/'))
    for (const f of files) if (!helpers.includes(f)) expect(names, `${f}.cjs isn't in suites.mjs`).toContain(f)
  })

  it('says why a suite must run alone', () => {
    for (const s of suites) if ('serial' in s) expect(typeof s.serial === 'string' && s.serial.length > 3, s.name).toBe(true)
  })

  it("suites run on a packaged build, or say in their header why they can't (#1578, #1580, #1591)", () => {
    // Under CW_EXE the runner reports a suite devBuildOnly names NOT RUN, with why, so no header is needed for that
    // (#1591). Two kinds still say so in their header: one using the test copies' channels, which a packaged Combwork
    // refuses (#1580: 0.9 worktree agents and slots:test, dev-build tests on purpose); and a queue suite, or one #1578
    // named beside them, that can't run packaged at all, as the packaged checks (#1539) run them. One that handles
    // CW_EXE itself (its dev-only parts say NOT RUN: queueFixture's devSeam) says that in its header.
    const named = ['agentapislots', 'gitbranchcards', 'mergedialogslots', 'slotreleaseapi', 'templatesv2']
    const unsaid: string[] = []
    for (const n of names) {
      const src = readFileSync(join(dir, `${n}.cjs`), 'utf8')
      const { header, code } = suiteSource(src)
      const why = suiteDevOnly(n, dir)
      const queue = named.includes(n) || code.some((l: string) => /require\('\.\/queueFixture\.cjs'\)/.test(l))
      const handles = code.some((l: string) => /q\.devSeam\(|process\.env\.CW_EXE/.test(l))
      const channel = handles ? null : code.filter((l: string) => !/inv\('agents:add'/.test(l)).find((l: string) => TEST_CHANNELS.test(l))
      if (/Dev build only/.test(header)) continue
      if (channel) unsaid.push(`${n}.cjs: ${TEST_CHANNELS.exec(channel)?.[0]}`)
      else if (queue && why) unsaid.push(`${n}.cjs: ${why}`)
      else if (queue && handles && code.some((l: string) => DEV_SEAMS.some((s: string) => l.includes(s))) && !/NOT RUN on a packaged build/.test(header)) unsaid.push(`${n}.cjs: a dev-only part on a packaged build, without "NOT RUN on a packaged build" in its header`)
    }
    expect(unsaid).toEqual([])
  })

  it("names every CW_TEST_ seam Hive reads: one a packaged build ignores or honours (#1591, #1599)", () => {
    const src = execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter((f) => /\.(ts|tsx|mts|cjs|mjs|js)$/.test(f))
    const read = new Set(src.flatMap((f) => readFileSync(join(root, f), 'utf8').match(/CW_TEST_[A-Z0-9_]*[A-Z0-9]/g) ?? []))
    const listed = [...DEV_SEAMS, ...PACKAGED_SEAMS]
    expect(new Set(listed).size, 'a seam is in two lists').toBe(listed.length)
    expect([...read].filter((s) => !listed.includes(s)).sort(), 'add each to DEV_SEAMS (runner.mjs) unless a packaged build honours it').toEqual([])
    expect(listed.filter((s) => !read.has(s)), 'no longer read by Hive: take it off its list').toEqual([])
  })

  it('says why a suite would test the dev build on a packaged one (devBuildOnly, #1591)', () => {
    const hdr = '// A suite.\n'
    expect(devBuildOnly(`${hdr}const h = await lib.launch({ userData })\n`)).toBe(null)
    expect(devBuildOnly(`${hdr}// Dev build only: it makes 0.9 worktree agents.\nconst h = await lib.launch({ userData })\n`)).toBe('its header says "Dev build only"')
    expect(devBuildOnly(`${hdr}const app = await _electron.launch({\n  executablePath: lib.ELECTRON,\n  args: [lib.ROOT] })\n`)).toMatch(/starts this checkout's Electron itself/)
    // Starting CW_EXE when set, or a packaged build by path, is not the dev build.
    expect(devBuildOnly(`${hdr}_electron.launch({ executablePath: process.env.CW_EXE || lib.ELECTRON })\n`)).toBe(null)
    expect(devBuildOnly(`${hdr}_electron.launch({ executablePath: path.join(lib.ROOT, 'dist/win-unpacked/Hive.exe') })\n`)).toBe(null)
    expect(devBuildOnly(`${hdr}lib.launch({ env: { CW_TEST_SLOW_IPC: 'git:diff=1500' } })\n`)).toBe('it needs CW_TEST_SLOW_IPC, a test seam a packaged build ignores')
    // Seams a packaged build honours (the tips and trash ones every test copy gets too) don't count; nor does a seam in a comment.
    expect(devBuildOnly(`${hdr}lib.launch({ env: { CW_TEST_TIPS: 'off', CW_TEST_NOTIFY_LOG: log } })\n  // CW_TEST_SLOW_IPC once\n`)).toBe(null)
    expect(devBuildOnly(`${hdr}await inv('slots:test', 'lend')\n`)).toBe('it uses a test channel a packaged build refuses (slots:test)')
    expect(devBuildOnly(`${hdr}await inv('agents:add', p, { worktree: true })\n`)).toBe(null)
    // A suite handling CW_EXE itself runs: its dev-only parts say NOT RUN. Starting Electron itself it can't handle.
    expect(devBuildOnly(`${hdr}if (q.devSeam('S7')) env.CW_TEST_QUEUE_CRASH = 'afterFiles'\n`)).toBe(null)
    expect(devBuildOnly(`${hdr}if (process.env.CW_EXE) return\n_electron.launch({ executablePath: lib.ELECTRON })\n`)).toMatch(/Electron itself/)
  })

  it('judges a suite with the helpers it uses: its own folder and what it requires, not lib.cjs (suiteDevOnly, #1591)', () => {
    // wakepaste-codex is a few lines handing over to wakepaste-cli/run.cjs, which starts Electron itself.
    expect(filesOfSuite('wakepaste-codex', dir)).toContain('wakepaste-cli/run.cjs')
    expect(suiteDevOnly('wakepaste-codex', dir)).toMatch(/^wakepaste-cli\/run\.cjs: it starts this checkout's Electron itself/)
    // A suite's own folder (i18nshots/) counts; the shared launch helpers don't (lib.cjs honours CW_EXE).
    expect(filesOfSuite('i18nshots', dir)).toEqual(expect.arrayContaining(['i18nshots/main.cjs', 'layoutReport.cjs']))
    expect(filesOfSuite('p4lane', dir)).not.toContain('lib.cjs')
    expect(filesOfSuite('wakepaste-codex', dir)).not.toContain('lib.cjs')
    // A queue suite: queueFixture handles CW_EXE (devSeam), so it runs; #1539's packaged suites all do.
    expect(filesOfSuite('p5lane', dir)).toContain('queueFixture.cjs')
    for (const n of ['p4lane', 'p5lane', 'reviewcopies', 'mergequeuefolder']) expect(suiteDevOnly(n, dir), n).toBe(null)
  })

  it('a packaged run of suites none of which can run tested nothing: its record says so and it fails (#1591)', () => {
    const pick = (...n: string[]) => suites.filter((s) => n.includes(s.name))
    const exe = 'C:\\sb\\Hive.exe'
    const none = packagedPlan(pick('cardloop', 'wakepaste-codex'), dir, exe)
    expect([...none.devOnly.keys()]).toEqual(['cardloop', 'wakepaste-codex'])
    expect(none.nothingRan).toMatch(/nothing was tested/)
    const some = packagedPlan(pick('cardloop', 'p4lane'), dir, exe)
    expect([...some.devOnly.keys()]).toEqual(['cardloop'])
    expect(some.nothingRan).toBe(null)
    // Without CW_EXE nothing changes.
    expect(packagedPlan(pick('cardloop'), dir, null)).toEqual({ devOnly: new Map(), nothingRan: null })
    // run.mjs doesn't stop before its record: the record is not valid for it, and the run fails.
    const runner = readFileSync(join(dir, 'run.mjs'), 'utf8')
    expect(runner).toContain('const problems = [...(nothingRan ? [nothingRan] : []),')
    expect(runner).toContain('process.exit(!lastRun.ok || recordInvalid || nothingRan ? 1 : 0)')
    expect(runner).not.toMatch(/nothingRan[^\n]*\n[^\n]*process\.exit\(1\)/)
    // Nor does it need a dev build for suites it won't run (concurrency.mjs runs it in a worktree with none).
    expect(runner).toContain('const devBuildNeeded = !nothingRan && needsDevBuild(runnable)')
  })

  it('no fixed wait of 1 s or more without a reason: wait for the condition (lib.until) instead', () => {
    // A long sleep is slower and flakier than waiting for what the next check needs. The ones left say why: they check
    // that something does NOT happen, are a loop's poll interval, or are a race's timeout.
    const unexplained: string[] = []
    for (const n of names) {
      readFileSync(join(dir, `${n}.cjs`), 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          const m = /sleep\((\d+)\)/.exec(line)
          if (m && Number(m[1]) >= 1000 && !/on purpose|poll interval|Promise\.race/.test(line)) unexplained.push(`${n}.cjs:${i + 1}`)
        })
    }
    expect(unexplained).toEqual([])
  })

  it('suites that run side by side take their port from the runner, not a fixed number', () => {
    for (const s of suites) {
      if (s.serial || s.needs?.length) continue
      const src = readFileSync(join(dir, `${s.name}.cjs`), 'utf8')
      expect(/CW_API_PORT:\s*'\d{5}'|const PORT = '?\d{5}'?(?!\))|127\.0\.0\.1:\d{5}/.test(src), `${s.name}: use lib.port()`).toBe(false)
    }
  })
})

describe('the suites a change needs (affected.mjs)', () => {
  const areas = AREAS as Area[]

  it('puts every suite in an area, and names only real suites and paths', () => {
    const inAreas = new Set(areas.flatMap((a) => a.suites))
    for (const n of names) expect(inAreas.has(n), `${n} is in no area`).toBe(true)
    for (const s of inAreas) expect(names, s).toContain(s)
    for (const p of [...areas.flatMap((a) => a.paths), ...(EVERYTHING as string[])]) expect(existsSync(join(root, p.replace(/\/$/, ''))), p).toBe(true)
  })

  it('covers every source file: in an area, one every suite needs, or one only the unit tests load', () => {
    const src = execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    for (const f of src) expect(under(f, EVERYTHING) || unitTest(f) || areas.some((a) => under(f, a.paths)), `${f} is in no area`).toBe(true)
  })

  it('picks an area’s suites, a suite’s own file, and about for docs the app bundles', () => {
    expect(affectedSuites(['src/renderer/src/components/Progress.tsx'], names).suites).toEqual(['i18nshots', 'lanesslots', 'progress', 'progressgates', 'progresslanes', 'progressqueue', 'progressreport', 'progressstates', 'progresstabs', 'replysize'])
    expect(affectedSuites(['tests/e2e/carddialog.cjs', 'docs/SPEC.md', 'CHANGELOG.md'], names).suites).toEqual(['about', 'carddialog'])
    expect(affectedSuites(['docs/USER_GUIDE.md'], names).suites).toEqual(['about', 'tipcorner', 'tips'])
    expect(affectedSuites(['README.md'], names).suites).toEqual([])
    expect(affectedSuites(['CONTRIBUTING.md'], names)).toEqual({ suites: [], why: [] })
  })

  it('maps runtime resources and every user of a shared test helper (review round 1)', () => {
    expect(affectedSuites(['resources/skills/card-loop/SKILL.md'], names).suites).toEqual(expect.arrayContaining(['skills', 'skillaudience', 'skilldelivery', 'cardloop']))
    expect(affectedSuites(['resources/modes/planner.md'], names).suites).toEqual(expect.arrayContaining(['assistant', 'assistant-control']))
    expect(affectedSuites(['tests/e2e/fake-codex/fake-codex.cjs'], names).suites).toEqual(['accounts', 'agenttemp', 'attachread', 'attention', 'carryingon', 'codexfolder', 'codexnewline', 'codexqueued', 'connectionfirst', 'connections-codex', 'defaultprovider', 'dialectlaunch', 'flightrecorder', 'footerfit', 'freshpath', 'hookshealth', 'hookstranscript', 'hooksview', 'lockask', 'models', 'p7lane', 'providerdetect', 'reviewcopies', 'sessiontree', 'skilldelivery', 'slotguidance', 'termsize', 'turnledger', 'wakeputoff', 'workspacenotes'])
    // The shared tab strip selects every suite driving one, its keyboard and attachment users too (HI-1902).
    for (const f of ['src/renderer/src/components/Tabs.tsx', 'src/shared/tabs.ts']) expect(affectedSuites([f], names).suites, f).toEqual(expect.arrayContaining(['keys', 'cardattach', 'image', 'vcswitch', 'versioncontrol', 'workflowdefaults', 'advanced']))
    expect(affectedSuites(['tests/e2e/fake-bridge.cjs'], names).all).toBe(true)
    expect(affectedSuites(['resources/tray.png'], names).all).toBe(true)
    expect(affectedSuites(['scripts/build-icons.mjs'], names).all).toBe(true)
    expect(affectedSuites(['scripts/release.mjs'], names).suites).toEqual(['testedclis'])
    expect(affectedSuites(['docs/SPEC.md'], names).suites).toEqual(['about'])
    expect(affectedSuites(['tests/progress.test.ts', 'AGENTS.md'], names).suites).toEqual([])
    expect(affectedSuites(['scripts/notices/winshell.txt'], names, realNames)).toEqual({ suites: ['about'], why: ['scripts/notices/winshell.txt: about'] })
    // The skills for developing Combwork are notes for agents, neither shipped nor read by the app (#197).
    expect(affectedSuites(['.claude/skills/verify-combwork-ui/SKILL.md', '.agents/skills/verify-combwork-ui/SKILL.md'], names, realNames)).toEqual({ suites: [], why: [] })
    // Every suite file that uses the fake Codex is selected by it.
    const users = names.filter((n) => readFileSync(join(dir, `${n}.cjs`), 'utf8').includes('fake-codex'))
    expect(affectedSuites(['tests/e2e/fake-codex/fake-codex.cjs'], names).suites).toEqual(expect.arrayContaining(users))
  })

  it('what only the unit tests use selects no suite, real or fake (#390)', () => {
    const tracked = (...paths: string[]) => execFileSync('git', ['ls-files', ...paths], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    const helpers = tracked('tests').filter((f) => /^tests\/[^/]+\.ts$/.test(f) && !f.endsWith('.test.ts'))
    expect(helpers).toEqual(expect.arrayContaining(['tests/electron-stub.ts', 'tests/tempDir.ts', 'tests/noGlobalGit.ts', 'tests/pathAliases.ts', 'tests/watchRealPaths.ts']))
    for (const f of [...helpers, ...(UNIT_ONLY as string[])]) {
      expect(unitTest(f), f).toBe(true)
      expect(affectedSuites([f], names, realNames), f).toEqual({ suites: [], why: [] })
    }
    expect(affectedSuites(['vitest.config.ts', 'tests/tempDir.ts', 'tests/licenses.test.ts'], names, realNames)).toEqual({ suites: [], why: [] })
    // The runners' progress reporter isn't the unit tests' alone.
    expect(unitTest('tests/progressReport.mts')).toBe(false)
    expect(affectedSuites(['tests/progressReport.mts'], names).all).toBe(true)
    // Which holds only while no suite, harness or scenario loads one of those helpers.
    const loads = (base: string) => new RegExp(`[/\\\\]${base}(\\.ts)?['"\`]`)
    for (const f of tracked('tests/e2e', 'tests/scenarios').filter((p) => /\.(c|m)?[jt]s$/.test(p))) {
      const text = readFileSync(join(root, f), 'utf8')
      for (const h of helpers) expect(loads(h.slice('tests/'.length, -'.ts'.length)).test(text), `${f} loads ${h}: give it an area in affected.mjs`).toBe(false)
    }
  })

  it('errs towards more: shared files and unknown code mean every suite', () => {
    expect(affectedSuites(['src/renderer/src/store.ts'], names).all).toBe(true)
    expect(affectedSuites(['tests/e2e/lib.cjs'], names).all).toBe(true)
    expect(affectedSuites(['src/main/brandNewThing.ts'], names).all).toBe(true)
    expect(affectedSuites(['SRC\\Renderer\\src\\components\\Progress.tsx'], names).suites).toContain('progress')
  })

  it('a file no area names falls back to the full set, real tier too, wherever it is (#628)', () => {
    const unmapped = ['src/main/brandNewThing.ts', 'src/renderer/src/components/BrandNew.tsx', 'src/shared/brandNew.ts', 'src/brandNew/x.ts', 'resources/brandNew.bin', 'scripts/brandNew.mjs', 'build/brandNew.nsh', 'tests/e2e/brandNewHelper.mjs', 'tests/e2e/fake-brandnew/cli.cjs', 'brandNew.config.json']
    for (const f of unmapped) {
      const r = affectedSuites([f], names, realNames)
      expect(r, f).toMatchObject({ all: true, real: realNames })
      expect(r.why[0], f).toMatch(/no area names it, so every suite/)
      // With files an area does name, still the full set.
      expect(affectedSuites(['src/renderer/src/components/Progress.tsx', f, 'docs/SPEC.md'], names, realNames), f).toMatchObject({ all: true, real: realNames })
    }
    // Every tracked file selects something, unless it is documentation or the unit tests': none is silently left out.
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    const nothing = tracked.filter((f) => {
      const r = affectedSuites([f], names, realNames)
      return !r.all && !r.suites.length
    })
    for (const f of nothing) expect(under(f, DOCS_ONLY) || unitTest(f), `${f} selects no suite: give it an area in affected.mjs`).toBe(true)
  })

  it('shared test tooling means the full set (#628): the runner and its helpers, the concurrency checker, the scenario harness', () => {
    for (const f of ['tests/e2e/run.mjs', 'tests/e2e/runner.mjs', 'tests/e2e/affected.mjs', 'tests/e2e/record.mjs', 'tests/e2e/recycleBin.mjs', 'tests/e2e/concurrency.mjs', 'tests/e2e/tempWorktrees.mjs', 'tests/e2e/runContext.cjs', 'tests/scenarios/harness.cjs', 'tests/scenarios/run.mjs']) {
      const r = affectedSuites([f], names, realNames)
      expect(r.all, f).toBe(true)
      expect(r.why[0], f).toMatch(/shared by every part of Combwork/)
    }
    // The scenarios themselves, and the notes on testing, are checked by npm run scenarios and need no suite.
    for (const f of ['tests/scenarios/scenarios.cjs', 'tests/scenarios/README.md', 'tests/README.md', 'scripts/testWaits.mjs']) expect(affectedSuites([f], names, realNames), f).toEqual({ suites: [], why: [] })
  })

  it('picks real-CLI suites only for changes to what they cover (card #191)', () => {
    const pick = (...files: string[]) => affectedSuites(files, names, realNames)
    for (const p of REAL_TIER as string[]) expect(existsSync(join(root, p.replace(/\/$/, ''))), p).toBe(true)
    // Combwork's side of every CLI: every real suite, with every fake one.
    for (const f of ['src/main/sessions.ts', 'src/main/providers/types.ts', 'tests/e2e/lib.cjs', 'src/shared/providers.ts']) expect(pick(f), f).toMatchObject({ all: true, real: realNames })
    // Not shared by every part of Combwork, but still every CLI's: every real suite and the area's fakes.
    expect(pick('src/main/transcripts.ts').suites).toEqual(expect.arrayContaining([...realNames, 'transcript']))
    // A provider's own adapter: only its area's real suites.
    const claude = pick('src/main/providers/claude/adapter.ts')
    expect(claude.all).toBe(true)
    expect(claude.real).toEqual(expect.arrayContaining(['claude-real', 'mode', 'compact']))
    expect(claude.real).not.toContain('codex')
    expect(pick('src/main/providers/codex/rollout.ts').real).not.toContain('agents')
    // Shared, but not a CLI's: every fake suite, no real one; an area naming a real suite picks it.
    expect(pick('src/renderer/src/store.ts')).toMatchObject({ all: true, real: [] })
    expect(pick('src/renderer/src/components/Progress.tsx').suites.filter((n: string) => realNames.includes(n))).toEqual([])
    expect(pick('src/main/power.ts').suites).toContain('quit')
    // Code no area names: everything, real tier included (errs towards more).
    expect(pick('src/main/brandNewThing.ts')).toMatchObject({ all: true, real: realNames })
    // A real suite's own file.
    expect(pick('tests/e2e/codex.cjs').suites).toEqual(['codex'])
  })
})

describe('the real tier and environment failures (card #191)', () => {
  const parse = (...a: string[]) => parseArgs(a, names)
  const pick = (a: string[], affected: unknown = null): string[] => selectSuites(suites, parse(...a), affected).map((s: Suite) => s.name)
  const fakes = suites.filter((s) => !isRealCli(s) && !s.needs?.includes('packaged')).map((s) => s.name)

  it('the full set is the fake tier; --real adds the real one, --only-real runs only it', () => {
    expect(realNames).toEqual(expect.arrayContaining(['claude-real', 'mode', 'codex', 'codex-setup']))
    // Suites about Combwork's own behaviour run the fake Claude Code (#194, #195); claude-real keeps what needs the real one.
    for (const n of ['quit', 'windows', 'launchrace', 'resume', 'agents', 'image', 'assistant', 'restart']) expect(realNames, n).not.toContain(n)
    expect(pick(['--all'])).toEqual(fakes)
    expect(pick([])).toEqual(fakes)
    expect(pick(['--all', '--real'])).toEqual(names.filter((n) => !n.startsWith('packaged')))
    expect(pick(['--only-real'])).toEqual(realNames)
    expect(pick(['--all', '--only-real'])).toEqual(realNames)
    expect(parse('--real', '--only-real').error).toMatch(/one of them/)
    // Named suites always run, real or not.
    expect(pick(['agents', 'board'])).toEqual(['agents', 'board'])
    expect(pick(['--all', 'agents'])).toEqual(names.filter((n) => fakes.includes(n) || n === 'agents'))
    // The left-out real tier is listed.
    const chosen = selectSuites(suites, parse('--all'))
    expect(realNotRun(suites, chosen).map((s: Suite) => s.name)).toEqual(realNames)
    expect(realNotRun(suites, selectSuites(suites, parse('--all', '--real')))).toEqual([])
  })

  it('--affected takes the real suites the changes need, and --real or --only-real on top', () => {
    expect(pick(['--affected'], { all: true, real: ['mode'] })).toEqual(names.filter((n) => fakes.includes(n) || n === 'mode'))
    expect(pick(['--affected'], { suites: ['board', 'mode'] })).toEqual(['board', 'mode'])
    expect(pick(['--affected', '--only-real'], { suites: ['board', 'mode'] })).toEqual(['mode'])
    expect(pick(['--affected', '--only-real'], { all: true, real: ['mode'] })).toEqual(['mode'])
    expect(pick(['--affected', '--real'], { suites: ['board'] })).toEqual(names.filter((n) => n === 'board' || realNames.includes(n)))
  })

  it('a suite is a SKIP only when it skipped itself, with every FAIL line put down to its failed CLI step (review round 1)', () => {
    const skipped = 'SKIPPED environment: usage or rate limit: …API Error: 429… (in "the prompt’s turn", session:c:\\p#a)'
    // cliStep: the step's failed check, then the skip.
    expect(suiteOutcome({ code: 0, out: `PASS a\nFAIL prompt makes it working\n${skipped}\nSKIPPED-FAILS 1\n` })).toMatchObject({ skipped: skipped.slice(8), environment: true })
    // An ENVIRONMENT line alone never makes a skip (the reviewer's case: an unrelated Combwork failure).
    expect(suiteOutcome({ code: 1, out: 'ENVIRONMENT usage or rate limit: API Error: 429\nFAIL saved project settings were lost\n' })).toMatchObject({ ok: false, failed: ['FAIL saved project settings were lost'] })
    // A FAIL line the step didn't count (a check before it, a page error): a FAIL.
    expect(suiteOutcome({ code: 0, out: `FAIL settings lost\nFAIL prompt makes it working\n${skipped}\nSKIPPED-FAILS 1\n` })).toMatchObject({ ok: false })
    expect(suiteOutcome({ code: 1, out: `${skipped}\nSKIPPED-FAILS 0\n` })).toMatchObject({ ok: false })
    expect(suiteOutcome({ code: 1, out: 'FAIL x\n' })).toMatchObject({ ok: false })
    // A pass is a pass, whatever the CLI said on the way.
    expect(suiteOutcome({ code: 0, out: 'ENVIRONMENT usage or rate limit: x\nPASS a\n' })).toEqual({ ok: true, failed: [] })
    // A suite that skipped itself (lib.skip).
    expect(suiteOutcome({ code: 0, out: 'SKIPPED environment: Codex is not signed in\n' })).toEqual({ skipped: 'environment: Codex is not signed in', environment: true })
    expect(suiteOutcome({ code: 0, out: 'SKIPPED no dist\n' })).toEqual({ skipped: 'no dist', environment: false })
    expect(suiteOutcome({ code: 1, out: 'SKIPPED x\nFAIL y\n' })).toMatchObject({ ok: false })
  })

  it('suites that mark CLI steps are real-CLI suites whose checks report to lib.checked', () => {
    const marking = names.filter((n) => readFileSync(join(dir, `${n}.cjs`), 'utf8').includes('lib.cliStep('))
    expect(marking).toEqual(expect.arrayContaining(['codex', 'codex-background', 'codex-extra', 'codex-handover']))
    for (const n of marking) {
      expect(realNames, n).toContain(n)
      expect(readFileSync(join(dir, `${n}.cjs`), 'utf8'), n).toMatch(/const check = [^\n]*\n?\s*lib\.checked\(ok\)/)
    }
  })

  it('a failed CLI step is the environment’s only with a new environment failure in its own session, and nothing failed before (review round 1)', () => {
    type Problems = Map<string, { why: string; at: number }[]>
    const { stepVerdict } = createRequire(import.meta.url)('./e2e/lib.cjs') as { stepVerdict: (o: object) => { skip?: string; note?: string } | null }
    const p = (n: number, why = 'usage or rate limit: …429…') => Array.from({ length: n }, (_, at) => ({ why, at }))
    const map = (o: Record<string, number>): Problems => new Map(Object.entries(o).map(([k, n]) => [k, p(n)]))
    const base = { name: 'turn', session: 'session:c:\\p#a', stepFailed: 1, error: null, failedBefore: 0, wired: true }
    // A new rate limit in the step's session while it failed: a skip, saying where.
    expect(stepVerdict({ ...base, before: map({}), after: map({ 'session:c:\\p#a': 1 }) })).toEqual({ skip: 'environment: usage or rate limit: …429… (in "turn", session:c:\\p#a)' })
    // An exception is never the environment's, even with a fresh error in the same session (review round 2): a bug, a
    // rejected IPC call, a file error. A note at most, so cliStep throws it on; also when a check failed beside it.
    const fs = Object.assign(new Error("ENOENT: no such file or directory, open 'notes.txt'"), { code: 'ENOENT' })
    for (const error of [new TypeError("Cannot read properties of undefined (reading 'sessionId')"), new Error("Error invoking remote method 'session:start': Error: Project not found"), fs])
      for (const stepFailed of [0, 1]) {
        const v = stepVerdict({ ...base, stepFailed, error, before: map({}), after: map({ 'session:c:\\p#a': 1 }) })
        expect(v?.skip, `${error.message} (${stepFailed} failed)`).toBeUndefined()
        expect(v?.note).toMatch(/not a skip: the step threw/)
      }
    // The step didn't fail: nothing to put down to the environment.
    expect(stepVerdict({ ...base, stepFailed: 0, before: map({}), after: map({ 'session:c:\\p#a': 1 }) })).toBeNull()
    // Another session's failure (several sessions): not this step's.
    expect(stepVerdict({ ...base, before: map({}), after: map({ 'session:c:\\p#b': 1 }) })).toBeNull()
    // Recovered: the error was there before the step and no new one came: the step's failure is Combwork's.
    expect(stepVerdict({ ...base, before: map({ 'session:c:\\p#a': 1 }), after: map({ 'session:c:\\p#a': 1 }) })).toBeNull()
    // A failure before the step, or checks lib can't see: a note, never a skip.
    expect(stepVerdict({ ...base, failedBefore: 1, before: map({}), after: map({ 'session:c:\\p#a': 1 }) })).toMatchObject({ note: expect.stringMatching(/not a skip: 1 check\(s\) failed before it/) })
    expect(stepVerdict({ ...base, wired: false, before: map({}), after: map({ 'session:c:\\p#a': 1 }) })).toMatchObject({ note: expect.stringMatching(/don't report/) })
    // No session named: any session's new failure.
    expect(stepVerdict({ ...base, session: null, before: map({}), after: map({ 'session:c:\\p#b': 2 }) })?.skip).toMatch(/session:c:\\p#b/)
  })

  it("lib.cjs knows the CLIs' environment failures from their output, and nothing else", () => {
    const { environmentProblem } = createRequire(import.meta.url)('./e2e/lib.cjs') as { environmentProblem: (t: string) => string | null }
    const env = {
      'usage or rate limit': ['\x1b[31m  ⎿  API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', 'Claude usage limit reached. Your limit will reset at 3pm', "You've hit your limit · resets 5pm (Europe/London)", "■ You've hit your usage limit. Upgrade to Pro or try again in 2 hours."],
      'the API is overloaded': ['API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'],
      'not signed in': ['Invalid API key · Please run /login', 'Select login method:', 'OAuth token has expired. Please obtain a new token or refresh your existing token.', 'Sign in with ChatGPT'],
      network: ['API Error: Connection error.', 'Unable to connect to Anthropic API', 'stream error: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)', 'getaddrinfo ENOTFOUND api.anthropic.com']
    }
    for (const [why, texts] of Object.entries(env)) for (const t of texts) expect(environmentProblem(t), t).toMatch(new RegExp(`^${why}: `))
    // Combwork's own failures, and ordinary output that mentions limits.
    for (const t of ['PreToolUse hook error: connect ECONNREFUSED 127.0.0.1:51234', 'Context limit reached · /compact or /clear to continue', 'Error: Cannot read properties of undefined', '? for shortcuts', 'The rate limiter in src/limits.ts']) expect(environmentProblem(t), t).toBeNull()
  })

  it("Codex's sandbox refusing a launch is the environment's only when its transcript shows the command was the Store PowerShell 7 (#658)", () => {
    const { environmentProblem, storePwshRefusals } = createRequire(import.meta.url)('./e2e/lib.cjs') as {
      environmentProblem: (t: string) => string | null
      storePwshRefusals: (jsonl: string) => { why: string }[]
    }
    const alias = 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
    const pkg = '"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\\pwsh.exe"'
    const refusal = (code: string, cmd: string) => `Failed to create unified exec process: CreateProcessAsUserW failed: ${code} | cwd=C:\\demo | cmd=${cmd} -Command "node linger.js stop" | env_u16_len=5324 | si_flags=256 | creation_flags=134743040`
    const unquoted = (cmd: string) => cmd.replace(/^"|"$/g, '')
    // The command's end as Codex 0.162 writes it in its rollout (an item_completed event of a failed CommandExecution).
    const ended = (item: Record<string, unknown>) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 't', turn_id: 'u', item: { type: 'CommandExecution', id: 'exec-1', source: 'unified_exec_startup', status: 'failed', exit_code: -1, ...item } } })
    const end = (code: string, cmd: string, item: Record<string, unknown> = {}) => ended({ command: [unquoted(cmd), '-Command', 'node linger.js stop'], aggregated_output: refusal(code, cmd), ...item })
    // That record, and the Rust form of the same error in the tool's output, which isn't a launch of its own.
    const line = (code: string, cmd: string) =>
      end(code, cmd) +
      '\n' +
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: `Script error:\nexec_command failed: CreateProcess { message: "Rejected(\\"${refusal(code, cmd).replace(/\\/g, '\\\\\\\\')}\\")" }` } })
    // The Store pwsh by its alias (error 5) and by the package's path (0xC0070005): the environment's, once each.
    for (const [code, cmd] of [['5 (Access is denied.)', alias], ['-1073283067', pkg]]) {
      const found = storePwshRefusals(line(code, cmd))
      expect(found.length, cmd).toBe(1)
      expect(found[0].why).toMatch(/^Codex's sandbox couldn't start the Store PowerShell 7/)
    }
    // Any other shell, even on a machine with the Store pwsh, another code, or a longer number: not it (a FAIL).
    const others: [string, string][] = [
      ['5 (Access is denied.)', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
      ['5 (Access is denied.)', 'C:\\Windows\\System32\\cmd.exe'],
      ['5 (Access is denied.)', '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"'],
      ['5 (Access is denied.)', 'C:\\tools\\WindowsApps-old\\pwsh.exe'],
      ['2 (The system cannot find the file specified.)', alias],
      ['50 (The request is not supported.)', alias],
      ['-10732830670', pkg],
      ['-1073283067.5', pkg]
    ]
    for (const [code, cmd] of others) expect(storePwshRefusals(line(code, cmd)), `${code} ${cmd}`).toEqual([])
    // Only that record is a launch: the same refusal quoted by the user, by Codex's answer or reasoning, in the tool's
    // output, in another object, or as what a command printed (it ran: completed, or failed with its own exit code) isn't.
    const said = refusal('5 (Access is denied.)', alias)
    const quoted = [
      { type: 'event_msg', payload: { type: 'user_message', message: said } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: said }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: said }] } },
      { type: 'event_msg', payload: { type: 'agent_message', message: said } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: said }] } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', output: said } },
      { type: 'event_msg', payload: { type: 'exec_command_end', status: 'failed', exit_code: -1, aggregated_output: said } },
      { msg: said }
    ].map((r) => JSON.stringify(r))
    for (const l of quoted) expect(storePwshRefusals(l), l).toEqual([])
    expect(storePwshRefusals(end('5 (Access is denied.)', alias, { status: 'completed', exit_code: 0 }))).toEqual([])
    expect(storePwshRefusals(end('5 (Access is denied.)', alias, { exit_code: 1 }))).toEqual([])
    expect(storePwshRefusals(end('5 (Access is denied.)', alias, { type: 'FileChange' }))).toEqual([])
    // Its executable must be the one the refusal names, and be given.
    expect(storePwshRefusals(end('5 (Access is denied.)', alias, { command: ['C:\\Windows\\System32\\cmd.exe', '/c', 'x'] }))).toEqual([])
    expect(storePwshRefusals(end('5 (Access is denied.)', alias, { command: undefined }))).toEqual([])
    expect(storePwshRefusals(end('5 (Access is denied.)', 'C:\\Windows\\System32\\cmd.exe', { command: [alias] }))).toEqual([])
    // The same command's end twice is one launch; two commands are two.
    expect(storePwshRefusals(`${end('5 (Access is denied.)', alias)}\n${end('5 (Access is denied.)', alias)}`)).toHaveLength(1)
    expect(storePwshRefusals(`${end('5 (Access is denied.)', alias)}\n${end('5 (Access is denied.)', alias, { id: 'exec-2' })}`)).toHaveLength(2)
    // Nothing that isn't JSON, and nothing at all.
    expect(storePwshRefusals(`not json ${said}`)).toEqual([])
    expect(storePwshRefusals('')).toEqual([])
    // The terminal alone, which cuts the command off, is never enough.
    expect(environmentProblem(`• Failed (exit -1) node linger.js stop └ ${refusal('5 (Access is denied.)', alias)}`)).toBeNull()
  })

  it('the record lists the real tier not run and the suites skipped for the environment', () => {
    const results = [
      { name: 'board', ok: true, seconds: 3 },
      { name: 'codex', skipped: 'environment: usage or rate limit: | API Error: 429', environment: true, seconds: 40 }
    ]
    const md = recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results, logDir: 'x', summary: '1 passed, 1 skipped', notRun: ['agents', 'quit'] })
    expect(md).toContain('| codex | skipped: environment: usage or rate limit: / API Error: 429 | 40s |')
    expect(md).toContain('Not run: the real tier (`--real`): agents, quit.')
    expect(md).toMatch(/\*\*Skipped for the environment\*\* .*: codex\./)
    expect(recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results: [results[0]], logDir: 'x', summary: 's' })).not.toMatch(/Not run|environment/)
  })

  it('on a packaged build, the record names it, the suites not run and why, and the parts a suite left out (#1591)', () => {
    const out = 'PASS a\nNOT RUN S34a (main moved just before the swap) needs an unpackaged build: not run with CW_EXE\nPASS b\n'
    const p4 = { name: 'mergequeuefolder', ...suiteOutcome({ code: 0, out }), seconds: 50 }
    expect(p4).toMatchObject({ ok: true, partsNotRun: ['S34a (main moved just before the swap) needs an unpackaged build: not run with CW_EXE'] })
    expect(resultLines('mergequeuefolder', p4)).toEqual(['mergequeuefolder      pass  50s  (1 part NOT RUN)', '    NOT RUN S34a (main moved just before the swap) needs an unpackaged build: not run with CW_EXE'])
    const why = "it starts this checkout's Electron itself (executablePath: lib.ELECTRON), not lib.launch"
    expect(resultLines('cardloop', { notRun: why })).toEqual([`cardloop              NOT RUN  (${why})`])
    const results = [p4, { name: 'cardloop', notRun: why }]
    const md = recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results, logDir: 'x', summary: '1 passed, 0 failed, 0 skipped, 1 not run', packaged: 'C:\\sb\\Hive.exe' })
    expect(md).toMatch(/^\*\*e2e run record\*\* .* · packaged build `C:\\sb\\Hive\.exe` \(CW_EXE\)$/m)
    expect(md).toContain(`| cardloop | **NOT RUN**: ${why} | – |`)
    expect(md).toContain('| mergequeuefolder | pass (1 part NOT RUN) | 50s |')
    expect(md).toContain('**Not run on the packaged build** (they would test the dev build; why in the table): cardloop.')
    expect(md).toContain('**Parts not run** (the suite said NOT RUN): mergequeuefolder: S34a')
    const json = recordJson({ code: 'abc', when: 'now', results, packaged: 'C:\\sb\\Hive.exe' })
    expect(json.packaged).toBe('C:\\sb\\Hive.exe')
    expect(json.results).toEqual([expect.objectContaining({ name: 'mergequeuefolder', ok: true, partsNotRun: p4.partsNotRun }), expect.objectContaining({ name: 'cardloop', ok: false, notRun: why })])
    // A dev run's record has none of it.
    expect(recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results: [{ name: 'board', ok: true, seconds: 3 }], logDir: 'x', summary: 's' })).not.toMatch(/packaged|NOT RUN|Not run/)
    expect(recordJson({ code: 'abc', when: 'now', results: [{ name: 'board', ok: true }] })).not.toHaveProperty('packaged')
  })

  it('the record says how its suites were picked (#628): the full set, or what --affected selected and why', () => {
    const results = [{ name: 'board', ok: true, seconds: 3 }]
    const rec = (selection: unknown) => recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results, logDir: 'x', summary: '1 passed', selection })
    expect(rec(selectionOf({ all: true }))).toContain('Selected: the full set (fake tier).')
    // Nothing named and no --affected is the full set too.
    expect(selectionOf({})).toMatchObject({ how: 'all', full: true })
    expect(rec(selectionOf({ named: ['board'] }))).toContain('Selected: the suites named; named: board (not the full set).')
    const base = { base: 'main', mergeBase: '4255cbc0a1b2c3d4', files: 3 }
    const some = selectionOf({ ...base, affected: { suites: ['board', 'review'], why: ['src/main/tasks.ts: board, review', 'docs/SPEC.md: about'] } })
    expect(some).toMatchObject({ how: 'affected', full: false, base: 'main', files: 3 })
    expect(rec(some)).toContain('Selected: `--affected` since main (4255cbc0a1b2), 3 changed files: not the full set, because src/main/tasks.ts: board, review; docs/SPEC.md: about.')
    const every = selectionOf({ ...base, files: 1, named: ['codex'], affected: { all: true, real: [], why: ['tests/e2e/run.mjs: shared by every part of Combwork'] } })
    expect(rec(every)).toContain('Selected: `--affected` since main (4255cbc0a1b2), 1 changed file: every fake suite (the full set), because tests/e2e/run.mjs: shared by every part of Combwork; named: codex.')
    // A long list of reasons is cut to a few.
    const many = selectionOf({ ...base, files: 9, affected: { suites: ['board'], why: Array.from({ length: 9 }, (_, i) => `f${i}: board`) } })
    expect(selectionLine(many)).toMatch(/f4: board; and 4 more\.$/)
    // In the record's data too; a record made without one has none.
    expect(recordJson({ code: 'abc', when: 'now', results, selection: some }).selection).toEqual(some)
    expect(recordJson({ code: 'abc', when: 'now', results })).not.toHaveProperty('selection')
    expect(recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results, logDir: 'x', summary: 's' })).not.toContain('Selected:')
  })
})

describe('the code fingerprint in a run record (record.mjs)', () => {
  const repo = tempDir('cw-fp-')
  afterAll(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd: repo, encoding: 'utf8' })

  it('is HEAD when clean, changes with any edit or new file, and ignores line endings and the notices file', () => {
    git('init', '-q')
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\n')
    git('add', '.')
    git('commit', '-qm', 'one')
    const head = git('rev-parse', '--short=12', 'HEAD').trim()
    expect(fingerprint(repo)).toBe(head)
    writeFileSync(join(repo, 'a.ts'), 'one\nTWO\n')
    const edited = fingerprint(repo)
    expect(edited).toMatch(new RegExp(`^${head}\\+[0-9a-f]{12}$`))
    writeFileSync(join(repo, 'a.ts'), 'one\r\nTWO\r\n')
    expect(fingerprint(repo)).toBe(edited)
    writeFileSync(join(repo, 'new.ts'), 'x')
    const withNew = fingerprint(repo)
    expect(withNew).not.toBe(edited)
    writeFileSync(join(repo, 'THIRD_PARTY_NOTICES.md'), 'rewritten by a build')
    expect(fingerprint(repo)).toBe(withNew)
  })
})

describe('the runner command line and run records (runner.mjs)', () => {
  const parse = (...a: string[]) => parseArgs(a, names)
  const pick = (...a: string[]): string[] => selectSuites(suites, parse(...a)).map((s: Suite) => s.name)

  it('keeps every suite named, and takes a flag value only when it is one', () => {
    expect(parse('--affected', 'board')).toMatchObject({ affected: 'main', named: ['board'] })
    expect(parse('--affected', 'origin/main', 'board')).toMatchObject({ affected: 'origin/main', named: ['board'] })
    expect(parse('board', '--affected')).toMatchObject({ affected: 'main', named: ['board'] })
    expect(parse('--jobs', '2', 'board')).toMatchObject({ jobs: 2, named: ['board'] })
    expect(parse('--jobs', 'board').error).toMatch(/--jobs needs/)
    expect(parse('--nope').error).toMatch(/Unknown option/)
    expect(parse('nosuch').error).toMatch(/Unknown suite/)
  })

  it('--all runs every eligible suite of the fake tier, also with names, and conflicts with --affected', () => {
    const everything = suites.filter((s) => !s.needs?.includes('packaged') && !isRealCli(s)).map((s) => s.name)
    expect(pick('--all')).toEqual(everything)
    expect(pick('--all', 'board')).toEqual(everything)
    expect(pick()).toEqual(everything)
    expect(parse('--all', '--affected').error).toMatch(/one of them/)
    expect(pick('board', 'tips')).toEqual(['board', 'tips'])
  })

  it('with --affected, named suites always run, and nothing needed means none (not everything)', () => {
    const o = parse('--affected', 'board')
    expect(selectSuites(suites, o, { suites: [] }).map((s: Suite) => s.name)).toEqual(['board'])
    expect(selectSuites(suites, o, { suites: ['tips'] }).map((s: Suite) => s.name)).toEqual(['board', 'tips'])
    expect(selectSuites(suites, parse('--affected'), { suites: [] })).toEqual([])
    expect(selectSuites(suites, parse('--affected'), { all: true }).length).toBeGreaterThan(50)
  })

  it('installer suites only with --packaged (or named)', () => {
    expect(pick('--all')).not.toContain('packaged-mcp')
    expect(pick('--all', '--packaged')).toContain('packaged-mcp')
    expect(pick('packaged-mcp')).toEqual(['packaged-mcp'])
  })

  it("a record is valid only for unchanged code and a fresh build, and says why not first", () => {
    expect(recordStatus({ before: 'abc+1', after: 'abc+1', buildStale: false })).toEqual({ valid: true, problems: [] })
    const changed = recordStatus({ before: 'abc', after: 'abc+2', buildStale: false })
    expect(changed.valid).toBe(false)
    expect(changed.problems[0]).toMatch(/changed while the suites ran/)
    expect(recordStatus({ before: 'abc', after: 'abc', buildStale: true }).problems[0]).toMatch(/isn't known to be from this source/)
    const md = recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results: [{ name: 'board', ok: true, seconds: 3 }], logDir: 'x', summary: '1 passed', problems: changed.problems })
    expect(md.split('\n')[0]).toMatch(/^\*\*Not valid/)
    expect(recordMarkdown({ code: 'abc', when: 'now', jobs: 1, results: [], logDir: 'x', summary: 's' })).toMatch(/^\*\*e2e run record\*\* · code `abc`/)
  })
})

describe('whether the dev build is from this source (build.mjs)', () => {
  const buildDir = tempDir('cw-build-')
  afterAll(() => rmSync(buildDir, { recursive: true, force: true }))
  mkdirSync(join(buildDir, 'src'), { recursive: true })
  writeFileSync(join(buildDir, 'src', 'a.ts'), 'a\n')
  writeFileSync(join(buildDir, 'src', 'b.ts'), 'b\n')
  let builds = 0
  // A build that writes its output newer than every source file, as a real one does.
  const lockDir = join(buildDir, 'locks')
  const runBuild = (): void => {
    builds++
    mkdirSync(join(buildDir, 'out', 'main'), { recursive: true })
    writeFileSync(join(buildDir, 'out', 'main', 'index.js'), `built ${builds}`)
  }
  const check = (build: boolean, during?: () => void): { stale: boolean; built: boolean; waited: boolean; why: string | null } =>
    ensureBuild({ root: buildDir, build, runBuild: () => { runBuild(); during?.() }, lock: { dir: lockDir } })
  const old = new Date('2001-01-01')

  it('no build: stale, and --build builds once, then skips while nothing changed', () => {
    expect(check(false)).toMatchObject({ stale: true, why: expect.stringMatching(/no dev build/) })
    expect(check(true)).toEqual({ stale: false, built: true, waited: false, why: null })
    expect(builds).toBe(1)
    expect(check(false)).toEqual({ stale: false, built: false, waited: false, why: null })
    expect(check(true).built).toBe(false)
    expect(builds).toBe(1)
  })

  it('a build made without --build holds unknown code', () => {
    rmSync(join(buildDir, 'out', '.e2e-build.json'))
    expect(check(false)).toMatchObject({ stale: true, why: expect.stringMatching(/unknown/) })
    expect(check(true)).toMatchObject({ stale: false, built: true })
  })

  it('a source file deleted after the build makes it stale (every remaining file is still older)', () => {
    unlinkSync(join(buildDir, 'src', 'b.ts'))
    const r = check(false)
    expect(r).toMatchObject({ stale: true, why: expect.stringMatching(/other source/) })
    // …and a record of that run is not valid, though the code didn't change while the suites ran.
    expect(recordStatus({ before: 'abc+1', after: 'abc+1', buildStale: r.stale }).valid).toBe(false)
    const n = builds
    expect(check(true)).toMatchObject({ stale: false, built: true })
    expect(builds).toBe(n + 1)
  })

  it('changed content with an older time, or an older copy restored, makes it stale', () => {
    writeFileSync(join(buildDir, 'src', 'a.ts'), 'a changed\n')
    utimesSync(join(buildDir, 'src', 'a.ts'), old, old)
    expect(check(false).stale).toBe(true)
    check(true)
    writeFileSync(join(buildDir, 'src', 'a.ts'), 'a\n')
    utimesSync(join(buildDir, 'src', 'a.ts'), old, old)
    expect(check(false).stale).toBe(true)
    check(true)
    writeFileSync(join(buildDir, 'src', 'new.ts'), 'added\n')
    utimesSync(join(buildDir, 'src', 'new.ts'), old, old)
    expect(check(false).stale).toBe(true)
    check(true)
  })

  it('line endings alone keep it fresh; a source change while building leaves no stamp at all', () => {
    writeFileSync(join(buildDir, 'src', 'a.ts'), 'a\r\n')
    expect(check(false).stale).toBe(false)
    writeFileSync(join(buildDir, 'src', 'b.ts'), 'b again\n')
    expect(check(true, () => writeFileSync(join(buildDir, 'src', 'a.ts'), 'edited mid-build\n'))).toMatchObject({ stale: true, built: true, why: expect.stringMatching(/changed while/) })
    expect(buildStamp(buildDir)).toBeNull()
    expect(check(false).stale).toBe(true)
  })

  it("a rebuild interrupted by the source going back doesn't leave the old stamp to match it", () => {
    // Source A, built and stamped.
    writeFileSync(join(buildDir, 'src', 'a.ts'), 'A\n')
    expect(check(true)).toMatchObject({ stale: false, built: true })
    // Source B; while B builds (its output replaces A's), the source goes back to A.
    writeFileSync(join(buildDir, 'src', 'a.ts'), 'B\n')
    expect(check(true, () => writeFileSync(join(buildDir, 'src', 'a.ts'), 'A\n')).stale).toBe(true)
    // The source is A again, but out/ holds B's build: stale without --build, and --build really rebuilds.
    expect(check(false)).toMatchObject({ stale: true, why: expect.stringMatching(/unknown/) })
    const n = builds
    expect(check(true)).toMatchObject({ stale: false, built: true })
    expect(builds).toBe(n + 1)
  })

  it('a failed build leaves no stamp', () => {
    writeFileSync(join(buildDir, 'src', 'a.ts'), 'C\n')
    expect(() => ensureBuild({ root: buildDir, build: true, runBuild: () => { throw new Error('build failed') }, lock: { dir: lockDir } })).toThrow('build failed')
    expect(buildLock(buildDir, { dir: lockDir }).heldByOther()).toBe(false)
    expect(buildStamp(buildDir)).toBeNull()
    expect(check(false).stale).toBe(true)
  })

  it("npm run dist's build (buildStamped) stamps out/ as --build does, under the build lock, and builds even when fresh (#274)", () => {
    writeFileSync(join(buildDir, 'src', 'a.ts'), 'D\n')
    const n = builds
    let lockedMeanwhile = false
    const stampedBuild = (during?: () => void) =>
      buildStamped({ root: buildDir, lock: { dir: lockDir }, runBuild: () => { lockedMeanwhile = buildLock(buildDir, { dir: lockDir, owner: -1, alive: () => true }).heldByOther(); runBuild(); during?.() } })
    expect(stampedBuild()).toEqual({ stamped: true, waited: false })
    expect(lockedMeanwhile).toBe(true)
    expect(buildLock(buildDir, { dir: lockDir }).heldByOther()).toBe(false)
    // A runner right after it finds out/ from this source, without --build.
    expect(check(false)).toEqual({ stale: false, built: false, waited: false, why: null })
    // It builds whatever the stamp says (dist packages what it just built), and a change mid-build leaves no stamp.
    expect(stampedBuild(() => writeFileSync(join(buildDir, 'src', 'a.ts'), 'edited during dist\n'))).toEqual({ stamped: false, waited: false })
    expect(builds).toBe(n + 2)
    expect(buildStamp(buildDir)).toBeNull()
    expect(check(false).stale).toBe(true)
  })

  // What npm run dist does, in order (makeDist, #281): the steps it is given record what it does, in turn.
  const distSteps = ({ stamped = true, refuse = null as string | null } = {}) => {
    const done: string[] = []
    const made = makeDist({
      root: 'R',
      here: true,
      run: (cmd: string) => void done.push(`run ${cmd}`),
      buildStamped: ({ root: r, runBuild: build }: { root: string; runBuild: () => void }) => {
        done.push(`buildStamped ${r}`)
        build()
        return { stamped, waited: false }
      },
      identity: () => (done.push('identity'), 'id'),
      clear: (d: string) => void done.push(`clear ${d.replace(/\\/g, '/')}`),
      finish: (o: { here: boolean; before: string; after: string }) => (done.push(`finish here=${o.here} ${o.before}->${o.after}`), ['done']),
      warn: (m: string) => void done.push(`warn ${m.trim()}`),
      stampApp: (r: string, o: { local: boolean }) => void done.push(`stamp ${r} local=${o.local}`),
      claim: (d: string, kind: string) => (done.push(`claim ${d.replace(/\\/g, '/')} ${kind}`), refuse),
      unclaim: (d: string, kind: string) => void done.push(`unclaim ${d.replace(/\\/g, '/')} ${kind}`)
    })
    return { done, lines: made.lines, refused: made.refused }
  }

  it('npm run dist drops the earlier build records before it builds, builds out/ stamped, then packages and finishes', () => {
    const { done, lines } = distSteps()
    expect(done).toEqual(['identity', 'claim R/dist dist', 'clear R/dist', 'buildStamped R', 'run npm run build', 'stamp R local=true', 'run npx electron-builder --win --publish never', 'identity', 'finish here=true id->id', 'unclaim R/dist dist'])
    expect(lines).toEqual(['done'])
  })

  it('…holding its dist from before the records go until it ends, and builds nothing while another build holds it (HI-2417)', () => {
    const { done, lines, refused } = distSteps({ refuse: 'Not built: npm run release is building in R/dist' })
    expect(refused).toBe('Not built: npm run release is building in R/dist')
    expect(lines).toBeUndefined()
    expect(done).toEqual(['identity', 'claim R/dist dist'])
  })

  it('…and says so when the source changed while it built (out/ not stamped)', () => {
    expect(distSteps({ stamped: false }).done.some((d) => d.startsWith('warn The source changed while it was building'))).toBe(true)
    expect(distSteps().done.some((d) => d.startsWith('warn'))).toBe(false)
  })
})

describe("the installer's suites check the packaged build they test (#274)", () => {
  const info = { version: '0.3.1', code: 'abc123+def', head: 'abc123', branch: 'cw/claudio' }

  it('dist/win-unpacked from this code is fine; from other code, or with no record of its own, is said', () => {
    expect(packagedStatus(info, 'abc123+def')).toBeNull()
    expect(packagedStatus(info, 'abc123')).toMatch(/is from other code \(abc123\+def, cw\/claudio; this is abc123\)/)
    expect(packagedStatus(null, 'abc123')).toMatch(/has no record of what it was built from/)
  })

  it('…and makes a record not valid', () => {
    const r = recordStatus({ before: 'abc', after: 'abc', buildStale: false, packagedStale: packagedStatus(info, 'abc') })
    expect(r.valid).toBe(false)
    expect(r.problems[0]).toMatch(/other code.*run npm run dist/)
    expect(repeatStatus({ repeat: 1, runs: [{ ok: true }], before: 'abc', after: 'abc', buildStale: false, packagedStale: 'x' }).valid).toBe(false)
  })

  it("a run of only the installer's suites doesn't need the dev build in out/, unless packaged-progress checks it", () => {
    const pk = suites.filter((s) => (s.needs ?? []).includes('packaged'))
    expect(pk.map((s) => s.name)).toEqual(['packaged', 'packaged-mcp', 'packaged-progress', 'packaged-transcript', 'packaged-workers'])
    expect(needsDevBuild(pk, {})).toBe(false)
    expect(needsDevBuild(pk, { CW_PROGRESS_CHECK_DEV: '1' })).toBe(true)
    expect(needsDevBuild([...pk, suites.find((s) => s.name === 'board')!], {})).toBe(true)
    expect(needsDevBuild([], {})).toBe(true)
  })
})

describe("Claude Code's trust question (lib.acceptClaudeTrust, #218)", () => {
  const { trustChoice } = createRequire(import.meta.url)('./e2e/lib.cjs') as { trustChoice: (text: string) => string | null }
  // As Claude Code 2.1.291 draws it (terminal text, control sequences and all): the menu starts on "No, exit".
  const drawn = (on: 'No' | 'Yes') =>
    `\x1b[2K Quick safety check: Is this a project you created or one you trust?\r\n \x1b[36m${on === 'No' ? '>' : ' '}\x1b[39m No, exit\r\n ${on === 'Yes' ? '❯' : ' '} Yes, I trust this folder\r\n Enter to confirm · Esc to cancel\x1b[>0q`

  it('reads the selected choice from the latest drawing of the menu, never an earlier one', () => {
    expect(trustChoice(drawn('No'))).toBe('No, exit')
    expect(trustChoice(drawn('Yes'))).toBe('Yes, I trust this folder')
    // Moved to Yes, then back to No (a Down arriving late): the last drawing counts.
    expect(trustChoice(drawn('No') + drawn('Yes') + drawn('No'))).toBe('No, exit')
    expect(trustChoice(drawn('No') + drawn('Yes'))).toBe('Yes, I trust this folder')
    expect(trustChoice('Welcome to Claude Code')).toBeNull()
  })
})

describe("progressreport's estimate check (lib.hadEstimate)", () => {
  const { hadEstimate } = createRequire(import.meta.url)('./e2e/lib.cjs') as { hadEstimate: (run: unknown) => boolean }
  const caller = { source: 'api' as const, workspacePath: 'C:\\ws' }

  it('a run that outlasts its estimate ends with 0 left, and still had one; a run never given one did not', () => {
    let now = 1_000_000
    const store = new ProgressStore({ now: () => now, changed: () => undefined, ownerRunning: () => true, emitEveryMs: 250 })
    // As Combwork's unit runner reports: an estimate from earlier runs at the start, then steps without one.
    const run = store.start(caller, { title: 'unit: 2 files', total: 2, step: 0, estimateMs: 500 })
    now += 400
    store.update(caller, run.id, { step: 1 })
    now += 600
    store.update(caller, run.id, { step: 2 })
    const done = store.finish(caller, run.id, { ok: true, summary: '2 passed, 0 failed' })
    expect(done).toMatchObject({ state: 'passed', estimateMs: 0 })
    expect(hadEstimate(done)).toBe(true)
    const first = store.start(caller, { title: 'unit: 2 files', total: 2, step: 0 })
    now += 1000
    store.update(caller, first.id, { step: 2 })
    expect(hadEstimate(store.finish(caller, first.id, { ok: true }))).toBe(false)
    expect(hadEstimate(undefined)).toBe(false)
  })
})

describe("each run's own log folder (logs.mjs)", () => {
  const logsDir = tempDir('cw-logs-')
  afterAll(() => rmSync(logsDir, { recursive: true, force: true }))
  const second = new Date(2026, 9, 4, 15, 0, 2)

  it('two runs in the same second get folders of their own, and keep their records and logs', () => {
    const a = newRunDir(logsDir, second)
    const b = newRunDir(logsDir, second)
    const c = newRunDir(logsDir, second)
    expect([a, b, c].map((d) => d.slice(logsDir.length + 1))).toEqual(['run-20261004-150002', 'run-20261004-150002-2', 'run-20261004-150002-3'])
    writeFileSync(join(a, 'run-record.md'), 'first')
    writeFileSync(join(a, 'board.log'), 'first board')
    writeFileSync(join(b, 'run-record.md'), 'second')
    writeFileSync(join(b, 'board.log'), 'second board')
    expect(readFileSync(join(a, 'run-record.md'), 'utf8')).toBe('first')
    expect(readFileSync(join(a, 'board.log'), 'utf8')).toBe('first board')
    expect(readFileSync(join(b, 'run-record.md'), 'utf8')).toBe('second')
  })

  it('keeps the newest ten in time order, suffixes after their base (and -10 after -9), and leaves nested/ alone', () => {
    expect(runDirsInOrder(['run-20261004-150002-10', 'run-20261004-150003', 'nested', 'run-record.md', 'run-20261004-150002-9', 'run-20261004-150002'])).toEqual(['run-20261004-150002', 'run-20261004-150002-9', 'run-20261004-150002-10', 'run-20261004-150003'])
    for (let i = 0; i < 12; i++) newRunDir(logsDir, new Date(2026, 9, 4, 16, 0, i))
    mkdirSync(join(logsDir, 'nested', 'run-20261004-170000'), { recursive: true })
    writeFileSync(join(logsDir, 'run-record.md'), 'latest')
    finishRunDirs(runDirsInOrder(readdirSync(logsDir)).map((n: string) => join(logsDir, n)))
    const removed = pruneRunDirs(logsDir)
    expect(removed).toEqual(['run-20261004-150002', 'run-20261004-150002-2', 'run-20261004-150002-3', 'run-20261004-160000', 'run-20261004-160001'])
    const left = readdirSync(logsDir)
    expect(left.filter((n) => n.startsWith('run-2'))).toHaveLength(KEEP_RUNS)
    expect(left).toContain('nested')
    expect(left).toContain('run-record.md')
    expect(left).toContain('run-20261004-160011')
  })

  it('a repeat of more than ten runs in one second keeps every one of its folders until its record is saved, then the next run trims to ten', () => {
    const runsDir = tempDir('cw-repeat-')
    try {
      // Older runs from before.
      finishRunDirs(Array.from({ length: 4 }, (_, i) => newRunDir(runsDir, new Date(2026, 9, 4, 14, 0, i))))
      // The repeat, as run.mjs does it: a folder per run (all in one second), each suite's log written as it ends, no
      // pruning until the end.
      const frozen = new Date(2026, 9, 4, 15, 0, 2)
      const mine: string[] = []
      for (let k = 1; k <= 11; k++) {
        const runDir = newRunDir(runsDir, frozen)
        writeFileSync(join(runDir, 'one.log'), `run ${k}`)
        mine.push(runDir)
      }
      expect(new Set(mine).size).toBe(11)
      // The one record for the repeat, saved into every run's folder, then the latest.
      for (const runDir of mine) writeFileSync(join(runDir, 'run-record.md'), 'all 11 passed')
      writeFileSync(join(runsDir, 'run-record.md'), 'all 11 passed')
      finishRunDirs(mine)
      const removed = pruneRunDirs(runsDir, KEEP_RUNS, mine)
      expect(removed).toHaveLength(4)
      for (const [k, runDir] of mine.entries()) {
        expect(readFileSync(join(runDir, 'run-record.md'), 'utf8')).toBe('all 11 passed')
        expect(readFileSync(join(runDir, 'one.log'), 'utf8')).toBe(`run ${k + 1}`)
      }
      expect(readdirSync(runsDir).filter((n) => n.startsWith('run-2'))).toHaveLength(11)
      // The next runner, in the same second again: a new name above the others, and it trims to the newest ten.
      const next = newRunDir(runsDir, frozen)
      expect(next.endsWith('run-20261004-150002-12')).toBe(true)
      finishRunDirs([next])
      pruneRunDirs(runsDir, KEEP_RUNS, [next])
      const left = runDirsInOrder(readdirSync(runsDir))
      expect(left).toHaveLength(KEEP_RUNS)
      expect(left.at(-1)).toBe('run-20261004-150002-12')
      expect(left[0]).toBe('run-20261004-150002-3')
    } finally {
      rmSync(runsDir, { recursive: true, force: true })
    }
  })

  it("a runner never prunes another runner's run still going: a slow run overlapping a fast repeat of more than ten", () => {
    const shared = tempDir('cw-overlap-')
    try {
      const A = 111
      const B = 222
      const running = new Set([A, B])
      const alive = (pid: number): boolean => running.has(pid)
      const sameSecond = new Date(2026, 9, 4, 15, 0, 2)
      // A: a slow run, started first (the base name), still running its suite.
      const a = newRunDir(shared, sameSecond, A)
      // B: a fast repeat of 11 in the same sameSecond, then its record, then it finishes and prunes.
      const b = Array.from({ length: 11 }, () => newRunDir(shared, sameSecond, B))
      for (const runDir of b) writeFileSync(join(runDir, 'run-record.md'), 'B: 11 of 11 runs passed')
      finishRunDirs(b)
      running.delete(B)
      expect(pruneRunDirs(shared, KEEP_RUNS, b, alive)).toEqual([])
      // A finishes its suite and saves its record: its folder is still there.
      writeFileSync(join(a, 'one.log'), 'A passed')
      writeFileSync(join(a, 'run-record.md'), 'A: 1 passed')
      expect(readFileSync(join(a, 'run-record.md'), 'utf8')).toBe('A: 1 passed')
      for (const runDir of b) expect(readFileSync(join(runDir, 'run-record.md'), 'utf8')).toBe('B: 11 of 11 runs passed')
      // A is done and prunes: the finished runs come down to the newest ten, A's own kept.
      finishRunDirs([a])
      running.delete(A)
      // A's own run is the oldest but protected while A prunes: the newest ten finished runs plus A's.
      expect(pruneRunDirs(shared, KEEP_RUNS, [a], alive)).toEqual(['run-20261004-150002-2'])
      expect(runDirsInOrder(readdirSync(shared))).toHaveLength(KEEP_RUNS + 1)
      expect(readFileSync(join(a, 'one.log'), 'utf8')).toBe('A passed')
      // The next runner's prune keeps the newest ten finished runs.
      expect(pruneRunDirs(shared, KEEP_RUNS, [], alive)).toEqual(['run-20261004-150002'])
      expect(runDirsInOrder(readdirSync(shared))).toHaveLength(KEEP_RUNS)
    } finally {
      rmSync(shared, { recursive: true, force: true })
    }
  })

  it("keeps a folder's files before its folders, and a --lang run's every language (#899)", () => {
    const runsDir = tempDir('cw-keeplang-')
    try {
      // The i18nshots route's shots: a folder per language, its reports beside them.
      const shots = join(runsDir, 'lane', 'i18nshots', 'i18nshots-shots')
      for (const lang of ['en-XA', 'pl']) {
        mkdirSync(join(shots, lang), { recursive: true })
        for (let i = 0; i < 3; i++) writeFileSync(join(shots, lang, `core-${i}-dark.png`), 'png')
      }
      for (const f of ['reached.json', 'report.json', 'report.txt']) writeFileSync(join(shots, f), '{}')
      const run = newRunDir(join(runsDir, 'logs'), new Date(2026, 9, 20, 1, 0, 0))
      // Past the limit, the reports are kept and the screenshots cut.
      const kept = keepSuiteFiles(join(runsDir, 'lane', 'i18nshots'), run, 'i18nshots', { maxFiles: 4 })
      expect(kept.copied).toBe(4)
      expect(readdirSync(join(run, 'i18nshots', 'i18nshots-shots')).sort()).toEqual(['en-XA', 'reached.json', 'report.json', 'report.txt'])
    } finally {
      rmSync(runsDir, { recursive: true, force: true })
    }
    // Room for each language a --lang run photographs; any other run, or suite, keeps the defaults.
    expect(keepLimits('i18nshots', ['en-XA', 'pl', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh-CN'])).toEqual({ maxFiles: 3700, maxTotal: 500 * 1024 * 1024 })
    expect(keepLimits('i18nshots', [])).toEqual({})
    expect(keepLimits('board', ['pl'])).toEqual({})
  })

  it("a --lang run's time limit grows with its languages; every other suite keeps 10 minutes (HI-2159)", () => {
    expect(suiteLimitMs('i18nshots', [])).toBe(10 * 60_000)
    expect(suiteLimitMs('i18nshots', ['en-XA'])).toBe(10 * 60_000)
    expect(suiteLimitMs('i18nshots', ['en-XA', 'pl', 'de', 'es', 'fr', 'ja', 'pt-BR'])).toBe(42 * 60_000)
    expect(suiteLimitMs('board', ['pl', 'de', 'es'])).toBe(10 * 60_000)
  })

  it('a failed run survives ten newer passing runs for a day, with its failed suites’ screenshots, then goes (#223)', () => {
    const runsDir = tempDir('cw-failed-')
    try {
      // A failed suite's folder in its lane: screenshots and a report at the top, a profile below.
      const suite = join(runsDir, 'lane', 'board')
      mkdirSync(join(suite, 'board-profile', 'Cache'), { recursive: true })
      writeFileSync(join(suite, 'board-profile', 'Cache', 'data'), 'x')
      writeFileSync(join(suite, 'board-stalled.png'), 'png')
      writeFileSync(join(suite, 'board-notify.log'), 'log')
      writeFileSync(join(suite, 'huge.png'), 'x'.repeat(2000))
      const logs = join(runsDir, 'logs')
      const failed = newRunDir(logs, new Date(2026, 9, 4, 15, 0, 0))
      markRunFailed(failed, 'board')
      expect(keepSuiteFiles(suite, failed, 'board', { maxBytes: 1000 })).toEqual({ copied: 2, omitted: [{ path: 'huge.png', why: 'over 1 KB' }] })
      expect(readdirSync(join(failed, 'board')).sort()).toEqual(['board-notify.log', 'board-stalled.png'])
      // Ten passing runs after it, from other agents.
      for (let i = 1; i <= KEEP_RUNS; i++) newRunDir(logs, new Date(2026, 9, 4, 15, 0, i))
      finishRunDirs(runDirsInOrder(readdirSync(logs)).map((n: string) => join(logs, n)))
      expect(runFailedAt(failed)).not.toBeNull()
      expect(pruneRunDirs(logs, KEEP_RUNS, [], () => false)).toEqual([])
      // An eleventh passing run: the oldest passing one goes, the failed one stays.
      newRunDir(logs, new Date(2026, 9, 4, 15, 0, 11))
      finishRunDirs(runDirsInOrder(readdirSync(logs)).map((n: string) => join(logs, n)))
      expect(pruneRunDirs(logs, KEEP_RUNS, [], () => false)).toEqual(['run-20261004-150001'])
      expect(readFileSync(join(failed, 'board', 'board-stalled.png'), 'utf8')).toBe('png')
      // A day later it goes like any other.
      expect(pruneRunDirs(logs, KEEP_RUNS, [], () => false, () => null, { now: Date.now() + FAILED_KEEP_MS + 60_000 })).toEqual(['run-20261004-150000'])
      expect(existsSync(failed)).toBe(false)
    } finally {
      rmSync(runsDir, { recursive: true, force: true })
    }
  })

  it('…at most the newest FAILED_MAX failed runs are kept beyond KEEP_RUNS', () => {
    const runsDir = tempDir('cw-failed-')
    try {
      const dirs = Array.from({ length: FAILED_MAX + 2 }, (_, i) => newRunDir(runsDir, new Date(2026, 9, 4, 15, 1, i)))
      for (const d of dirs) markRunFailed(d, 'x')
      finishRunDirs(dirs)
      expect(pruneRunDirs(runsDir, 0, [], () => false)).toEqual(['run-20261004-150100', 'run-20261004-150101'])
      expect(readdirSync(runsDir)).toHaveLength(FAILED_MAX)
    } finally {
      rmSync(runsDir, { recursive: true, force: true })
    }
  })

  it('a passing run of the last day survives twenty newer runs; an older one goes (#1595)', () => {
    const runsDir = tempDir('cw-window-')
    try {
      const now = Date.now()
      const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000)
      const old = newRunDir(runsDir, at(25 * 60))
      const cited = newRunDir(runsDir, at(60))
      const failed = newRunDir(runsDir, at(59))
      markRunFailed(failed, 'board')
      for (let i = 0; i < 20; i++) newRunDir(runsDir, new Date(now - 50 * 60_000 + i * 1000))
      finishRunDirs(runDirsInOrder(readdirSync(runsDir)).map((n: string) => join(runsDir, n)))
      expect(runStartedAt(basename(cited))).toBe(Math.floor(at(60).getTime() / 1000) * 1000)
      // Only the run from before the window goes.
      expect(runDirsToPrune(runsDir, KEEP_RUNS, [], () => false, () => null, { now })).toEqual([basename(old)])
      // With no window (CW_E2E_KEEP_HOURS=0), the newest ten and the failed run stay, as before.
      const noWindow = runDirsToPrune(runsDir, KEEP_RUNS, [], () => false, () => null, { now, keepMs: 0 })
      expect(noWindow).toHaveLength(12)
      expect(noWindow).toContain(basename(cited))
      expect(noWindow).not.toContain(basename(failed))
      // A window of two hours keeps it too; past it, it goes.
      expect(pruneRunDirs(runsDir, KEEP_RUNS, [], () => false, () => null, { now, keepMs: 2 * 3_600_000 })).toEqual([basename(old)])
      expect(existsSync(cited)).toBe(true)
      expect(runDirsToPrune(runsDir, KEEP_RUNS, [], () => false, () => null, { now: now + 2 * 3_600_000, keepMs: 2 * 3_600_000 })).toContain(basename(cited))
    } finally {
      rmSync(runsDir, { recursive: true, force: true })
    }
  })

  it('past the size cap, the oldest passing runs of the window go first, then failed ones, never the newest ten (#1595)', () => {
    const runsDir = tempDir('cw-cap-')
    try {
      const now = Date.now()
      const run = (minutesAgo: number) => {
        const runDir = newRunDir(runsDir, new Date(now - minutesAgo * 60_000))
        mkdirSync(join(runDir, 'board'))
        writeFileSync(join(runDir, 'board', 'shot.png'), 'x'.repeat(600))
        writeFileSync(join(runDir, 'board.log'), 'x'.repeat(400))
        return basename(runDir)
      }
      // The oldest is a failed run; two passing runs after it; then the newest ten. 1000 bytes each.
      const failed = run(120)
      markRunFailed(join(runsDir, failed), 'board')
      const passing = [run(110), run(100)]
      const newest = Array.from({ length: KEEP_RUNS }, (_, i) => run(90 - i))
      finishRunDirs(runDirsInOrder(readdirSync(runsDir)).map((n: string) => join(runsDir, n)))
      const prune = (maxBytes: number) => {
        const told: [string[], number][] = []
        const gone = runDirsToPrune(runsDir, KEEP_RUNS, [], () => false, () => null, { now, maxBytes, onOverCap: (early: string[], bytes: number) => told.push([early, bytes]) })
        return { gone, told }
      }
      // 13 006 bytes in all (the failed run's mark is 6).
      const total = 13_006
      expect(prune(total)).toEqual({ gone: [], told: [] })
      // A cap a run below it: the oldest passing run goes, not the older failed one.
      expect(prune(total - 1000)).toEqual({ gone: [passing[0]], told: [[[passing[0]], total]] })
      expect(prune(total - 2000).gone).toEqual(passing)
      // Then the failed one; never the newest ten, however small the cap.
      expect(prune(total - 2001).gone).toEqual([failed, ...passing])
      expect(pruneRunDirs(runsDir, KEEP_RUNS, [], () => false, () => null, { now, maxBytes: 0 })).toEqual([failed, ...passing])
      expect(runDirsInOrder(readdirSync(runsDir))).toEqual(newest)
    } finally {
      rmSync(runsDir, { recursive: true, force: true })
    }
  })

  it('the window and the cap come from CW_E2E_KEEP_HOURS and CW_E2E_KEEP_MB (#1595)', () => {
    expect(logRetention({})).toEqual({ keepMs: KEEP_HOURS * 3_600_000, maxBytes: KEEP_MB * 1024 * 1024, bad: [] })
    expect(KEEP_HOURS).toBe(24)
    expect(KEEP_MB).toBe(2048)
    expect(logRetention({ CW_E2E_KEEP_HOURS: '48', CW_E2E_KEEP_MB: '512' })).toEqual({ keepMs: 48 * 3_600_000, maxBytes: 512 * 1024 * 1024, bad: [] })
    expect(logRetention({ CW_E2E_KEEP_HOURS: '0', CW_E2E_KEEP_MB: ' ' })).toEqual({ keepMs: 0, maxBytes: KEEP_MB * 1024 * 1024, bad: [] })
    expect(logRetention({ CW_E2E_KEEP_HOURS: 'a day', CW_E2E_KEEP_MB: '-1' })).toEqual({
      keepMs: KEEP_HOURS * 3_600_000,
      maxBytes: KEEP_MB * 1024 * 1024,
      bad: ['CW_E2E_KEEP_HOURS=a day', 'CW_E2E_KEEP_MB=-1']
    })
  })

  it("a run folder counts as still going only while its runner's process is alive (a crashed runner's is pruned)", () => {
    const crashed = tempDir('cw-crash-')
    try {
      const runDir = newRunDir(crashed, new Date(2026, 9, 4, 15, 0, 2), 333)
      expect(runDirActive(runDir, () => true)).toBe(true)
      expect(runDirActive(runDir, () => false)).toBe(false)
      // A marker a day old is stale even if the process id is in use again.
      expect(runDirActive(runDir, () => true, Date.now() + 25 * 60 * 60_000)).toBe(false)
      expect(runDirActive(newRunDir(crashed, new Date(2026, 9, 4, 15, 0, 3)))).toBe(true)
      expect(pruneRunDirs(crashed, 0, [], () => false)).toHaveLength(2)
    } finally {
      rmSync(crashed, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')("a run folder something still holds is kept and named, never a failure; a later prune removes it (#1616)", async () => {
    const logs = tempDir('cw-held-')
    let holder: ReturnType<typeof spawn> | null = null
    try {
      const held = newRunDir(logs, new Date(2026, 9, 4, 15, 0, 0))
      const free = newRunDir(logs, new Date(2026, 9, 4, 15, 0, 1))
      finishRunDirs([held, free])
      mkdirSync(join(held, 'suite'))
      // Another process works in it (a lane's, a scan): Windows refuses to remove a folder a process has as its own. Its
      // folder is held once the process runs (not yet at 'spawn'), so it says when it does.
      holder = spawn(process.execPath, ['-e', "process.stdout.write('ready'); process.stdin.resume()"], { cwd: join(held, 'suite'), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: {} })
      await new Promise<void>((resolve, reject) => {
        holder!.once('error', reject).once('exit', (code) => reject(new Error(`the holder ended (${code})`)))
        holder!.stdout!.once('data', () => resolve())
      })
      holder.removeAllListeners('exit')
      const kept: [string, string][] = []
      const onKept = (name: string, code: string) => kept.push([name, code])
      expect(pruneRunDirs(logs, 0, [], () => false, () => null, { onKept })).toEqual([basename(free)])
      expect(kept).toHaveLength(1)
      expect(kept[0][0]).toBe(basename(held))
      expect(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']).toContain(kept[0][1])
      expect(existsSync(held)).toBe(true)
      // The runner's prune keeps it the same way, after releasing what the run kept.
      const released: string[] = []
      expect(await pruneRunDirsReleasing(logs, 0, [], () => false, () => null, { onKept, release: async (d: string) => void released.push(basename(d)) })).toEqual([])
      expect(released).toEqual([basename(held)])
      expect(kept.map(([n]) => n)).toEqual([basename(held), basename(held)])
      // Let go: the next prune removes it.
      const exited = new Promise((resolve) => holder!.once('exit', resolve))
      holder.stdin!.end()
      await exited
      holder = null
      expect(pruneRunDirs(logs, 0, [], () => false, () => null, { onKept })).toEqual([basename(held)])
      expect(existsSync(held)).toBe(false)
    } finally {
      holder?.kill()
      rmSync(logs, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  })

  it('a name pruned away is never given to a newer run in the same second (it would sort as the oldest)', () => {
    const runsDir = tempDir('cw-reuse-')
    try {
      const when = new Date(2026, 9, 4, 15, 0, 2)
      const first = newRunDir(runsDir, when)
      newRunDir(runsDir, when)
      rmSync(first, { recursive: true })
      const again = newRunDir(runsDir, when)
      expect(again.endsWith('run-20261004-150002-3')).toBe(true)
      expect(runDirsInOrder(readdirSync(runsDir)).at(-1)).toBe('run-20261004-150002-3')
    } finally {
      rmSync(runsDir, { recursive: true, force: true })
    }
  })

  it("a runner started inside a suite keeps its runs under logs/nested, and its ports clear of the suite's", () => {
    expect(logsRootFor('W', {})).toBe(join('W', 'logs'))
    // A runner of its own: its lane's ports (lanes.mjs).
    expect(portBase({}, 47960)).toBe(47960)
    // In the suite itself: the runner set both.
    expect(logsRootFor('W', { CW_E2E_PORT: '48302', E2E_RUN_SUITE: 'progressreport', E2E_RUN_PORT: '48302' })).toBe(join('W', 'logs', 'nested'))
    // In an agent's shell in the Combwork the suite started: Combwork dropped the CW_ variables, E2E_RUN_* remain.
    const inSession = { E2E_RUN_SUITE: 'progressreport', E2E_RUN_PORT: '48302', CW_API_URL: undefined }
    expect(parentSuite(inSession)).toEqual({ name: 'progressreport', port: 48302 })
    expect(logsRootFor('W', inSession)).toBe(join('W', 'logs', 'nested'))
    expect(portBase(inSession)).toBe(49302)
    // A suite run on its own, one at a time: no port, still inside a suite.
    expect(portBase({ E2E_RUN_SUITE: 'progressreport' }, 47940)).toBe(48940)
    // An agent session in a real Combwork (no suite): neither.
    expect(parentSuite({ CW_API_URL: 'http://127.0.0.1:47821' })).toBeNull()
  })
})

describe('--repeat N: runs until the first failure, one record for all (runner.mjs, record.mjs)', () => {
  const suiteNames = ['board', 'about']

  it('parses --repeat: a whole number of 1 or more, 1 by default', () => {
    expect(parseArgs(['board'], suiteNames).repeat).toBe(1)
    expect(parseArgs(['--repeat', '3', 'board'], suiteNames)).toMatchObject({ repeat: 3, named: ['board'] })
    expect(parseArgs(['board', '--repeat', '1'], suiteNames).repeat).toBe(1)
    for (const bad of [['--repeat'], ['--repeat', 'board'], ['--repeat', 'two'], ['--repeat', '0'], ['--repeat', '-1'], ['--repeat', '1.5']]) expect(parseArgs(bad, suiteNames).error).toMatch(/--repeat needs a whole number/)
  })

  it('parses --keep-files and --clear-dir <folder> (#304)', () => {
    expect(parseArgs(['board'], suiteNames)).toMatchObject({ keepFiles: false, clearDir: null })
    expect(parseArgs(['board', '--keep-files'], suiteNames)).toMatchObject({ keepFiles: true, named: ['board'] })
    expect(parseArgs(['--clear-dir', 'C:\\x\\shots'], suiteNames)).toMatchObject({ clearDir: 'C:\\x\\shots', named: [] })
    for (const bad of [['--clear-dir'], ['--clear-dir', '--build']]) expect(parseArgs(bad, suiteNames).error).toMatch(/--clear-dir needs the folder/)
  })

  const run = (ok: boolean): { ok: boolean } => ({ ok })
  const same = { before: 'abc+1', after: 'abc+1', buildStale: false }

  it('is valid only when every run passed, on unchanged code, with a build from it', () => {
    expect(repeatStatus({ repeat: 3, runs: [run(true), run(true), run(true)], ...same })).toEqual({ valid: true, problems: [] })
    const stopped = repeatStatus({ repeat: 3, runs: [run(true), run(false)], ...same })
    expect(stopped.valid).toBe(false)
    expect(stopped.problems[0]).toBe('stopped after run 2 of 3 failed')
    expect(repeatStatus({ repeat: 3, runs: [run(false)], ...same }).problems[0]).toBe('stopped after run 1 of 3 failed')
    expect(repeatStatus({ repeat: 3, runs: [run(true), run(true), run(false)], ...same }).problems[0]).toBe('run 3 of 3 failed')
    expect(repeatStatus({ repeat: 3, runs: [run(true), run(true)], ...same }).problems[0]).toBe('only 2 of 3 runs ran')
    const changed = repeatStatus({ repeat: 3, runs: [run(true), run(true), run(true)], before: 'abc+1', after: 'abc+2', buildStale: false })
    expect(changed.valid).toBe(false)
    expect(changed.problems[0]).toMatch(/changed while the suites ran/)
    expect(repeatStatus({ repeat: 2, runs: [run(true), run(true)], ...same, buildStale: true }).valid).toBe(false)
    // One run: a failed suite shows in the record, which is still a true one.
    expect(repeatStatus({ repeat: 1, runs: [run(false)], ...same }).valid).toBe(true)
  })

  it("the record lists each run (result, logs) and each suite's result in each run, and says first when it is not valid", () => {
    const r = (ok: boolean, seconds: number) => [{ name: 'board', ok: true, seconds }, { name: 'about', ok, seconds: 6, failed: ok ? [] : ['FAIL x'] }]
    const runs = Object.assign([
      { ok: true, results: r(true, 13), logDir: 'L1', summary: '2 passed, 0 failed, 0 skipped in 0.3 min' },
      { ok: false, results: r(false, 14), logDir: 'L2', summary: '1 passed, 1 failed, 0 skipped in 0.3 min' }
    ], { repeat: 3 })
    const md = recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results: runs[1].results, logDir: 'L2', summary: '1 of 3 runs passed (stopped after run 2)', problems: ['stopped after run 2 of 3 failed'], runs })
    const lines = md.split('\n')
    expect(lines[0]).toBe("**Not valid — don't trust this record:** stopped after run 2 of 3 failed.")
    expect(md).toContain('· 2 of 3 runs')
    expect(md).toContain('| 1 | pass: 2 passed, 0 failed, 0 skipped in 0.3 min | `L1` |')
    expect(md).toContain('| 2 | **FAIL**: 1 passed, 1 failed, 0 skipped in 0.3 min | `L2` |')
    expect(md).toContain('| Suite | Run 1 | Run 2 |')
    expect(md).toContain('| board | pass 13s | pass 14s |')
    expect(md).toContain('| about | pass 6s | **FAIL** (1 check) 6s |')
  })
})

describe("each runner's own lane: ports and suite folders (lanes.mjs)", () => {
  const alive = (pid: number) => pid === 100 || pid === 200
  const now = Date.parse('2026-10-04T12:00:00Z')

  it("lanes' ports are their own, clear of Hive's, of the suites' defaults and of Windows' dynamic range", () => {
    const ranges = Array.from({ length: LANES }, (_, k) => lanePorts(k))
    for (const [k, r] of ranges.entries()) {
      expect(r.last - r.first + 1).toBe(LANE_PORTS)
      // The CLI lane (base − 1) and eight slots (--jobs is at most 8).
      expect(r.first).toBe(r.base - 1)
      expect(r.last).toBeGreaterThanOrEqual(r.base + 7)
      if (k) expect(r.first).toBeGreaterThan(ranges[k - 1].last)
    }
    // The suites' own defaults (lib.port(<default>)), the installed and dev Hives' ports and the scenarios' (harness.cjs).
    const defaults = new Set([47821, 47822, 47930])
    expect(readFileSync(join(__dirname, 'scenarios', 'harness.cjs'), 'utf8')).toContain('opts.port ?? 47930')
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.cjs'))) for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/lib\.port\((\d+)\)/g)) defaults.add(Number(m[1]))
    expect(defaults.size).toBeGreaterThan(10)
    const top = ranges.at(-1)!.last
    for (const p of defaults) expect(p < ranges[0].first || p > top).toBe(true)
    // A runner inside a suite takes 1000 above its parent's slot: still below 49152, where Windows hands ports out.
    expect(portBase({ E2E_RUN_SUITE: 's', E2E_RUN_PORT: String(top) })).toBeLessThan(49152)
    expect(portBase({ E2E_RUN_SUITE: 's', E2E_RUN_PORT: String(top) }) - 1 + LANE_PORTS).toBeLessThan(49152)
  })

  it("a pool of its own (CW_TEST_LANES_DIR) claims ports no lane of the machine pool has, and both runners pass the pool's (#1127)", async () => {
    expect(lanesFirst(false)).toBe(LANE_FIRST)
    const machineTop = lanePorts(LANES - 1).last
    const own = Array.from({ length: LANES }, (_, k) => lanePorts(k, lanesFirst(true)))
    expect(own[0].first).toBeGreaterThan(machineTop)
    expect(own.at(-1)!.last).toBeLessThan(49152)
    const lanesDir = tempDir('cw-own-lanes-')
    try {
      const got = await claimLane(lanesDir, { owner: 300, alive: () => true, free: async () => true, portsFrom: lanesFirst(true) })
      expect(got).toMatchObject({ lane: 0, ...own[0] })
    } finally {
      rmSync(lanesDir, { recursive: true, force: true })
    }
    for (const file of [join(dir, 'run.mjs'), join(__dirname, 'scenarios', 'run.mjs')]) expect(readFileSync(file, 'utf8')).toContain('portsFrom: lanesFirst(runContext.OWN_LANES),')
  })

  it('only one pool of its own at a time on the machine: a second checker waits for the first, whose pools would have the same ports (#1127)', async () => {
    const machine = tempDir('cw-machine-lanes-')
    const pools = [tempDir('cw-own-lanes-a-'), tempDir('cw-own-lanes-b-')]
    try {
      const running = (pid: number) => pid === 300 || pid === 301
      // Two pools of their own hand out the same ports: the reason for the hold.
      const [a, b] = await Promise.all(pools.map((p, i) => claimLane(p, { owner: 300 + i, alive: running, free: async () => true, portsFrom: lanesFirst(true) })))
      expect(a.first).toBe(b.first)
      a.release()
      b.release()
      const first = await holdOwnPool(machine, { owner: 300, alive: running, what: 'checker A' })
      expect(first.release).toBeTypeOf('function')
      expect(await holdOwnPool(machine, { owner: 301, alive: running, wait: false })).toEqual({ refused: expect.objectContaining({ pid: 300, what: 'checker A' }) })
      // The second waits, saying who holds it, and takes it once the first lets go.
      const seen: number[] = []
      const second = holdOwnPool(machine, { owner: 301, alive: running, pollMs: 10, onWait: (h: { pid: number }) => seen.push(h.pid) })
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: HUNG_MS })
      first.release()
      const got = await second
      expect(got.release).toBeTypeOf('function')
      expect(seen.every((pid) => pid === 300)).toBe(true)
      expect(JSON.parse(readFileSync(join(machine, 'own-pool.json'), 'utf8')).pid).toBe(301)
      // The machine pool's own claims are untouched: the hold is a file of its own beside them.
      expect(readdirSync(machine).filter((n) => /^lane-\d+\.json$/.test(n))).toEqual([])
      // A crashed holder's hold is taken over at once.
      expect(await holdOwnPool(machine, { owner: 302, alive: (pid: number) => pid === 302, wait: false })).toHaveProperty('release')
    } finally {
      for (const d of [machine, ...pools]) rmSync(d, { recursive: true, force: true })
    }
  })

  it("each lane's suites have a folder of their own, never the work folder a suite run on its own uses", () => {
    const folders = Array.from({ length: LANES }, (_, k) => laneWork('W', k))
    expect(folders[0]).toBe(join('W', 'lanes', '0'))
    expect(folders[3]).toBe(join('W', 'lanes', '3'))
    expect(new Set(folders).size).toBe(LANES)
    expect(folders).not.toContain('W')
  })

  it('scenario runs claim a lane too: their folders and Agent API port, never the shared 47930 or scenarios folder (#183, #184)', () => {
    const run = readFileSync(join(__dirname, 'scenarios', 'run.mjs'), 'utf8')
    // The same pool as the e2e runner's (runContext.LANES_DIR), each waiting for a lane while all are taken (#707).
    expect(run).toMatch(/const lane = await waitForLane\(runContext\.LANES_DIR, \{\s+root: lib\.ROOT,/)
    expect(readFileSync(join(dir, 'run.mjs'), 'utf8')).toMatch(/const got = await waitForLane\(runContext\.LANES_DIR, \{\s+root,/)
    for (const r of [run, readFileSync(join(dir, 'run.mjs'), 'utf8')]) {
      expect(r).toContain("'a test lane')")
      expect(r).toMatch(/wait: !(opts\.noWait|argv\.includes\('--no-wait'\))/)
    }
    expect(run).toContain("const workRoot = laneWork(join(lib.WORK, '..', 'scenarios'), lane.lane)")
    expect(run).toMatch(/runScenario\(sc, provider, \{[^}]*workRoot, port: lane\.first/)
    expect(run).toContain('process.on(\'exit\', lane.release)')
  })

  it('takes the lowest lane no live claim holds and whose ports are free', () => {
    expect(pickLane([], new Set(), alive, now)).toBe(0)
    // Held by a running runner: skipped.
    expect(pickLane([{ pid: 100, at: now - 60_000 }], new Set(), alive, now)).toBe(1)
    // A crashed runner's claim (its process is gone), or a day-old one: free again.
    expect(pickLane([{ pid: 999, at: now - 60_000 }], new Set(), alive, now)).toBe(0)
    expect(pickLane([{ pid: 100, at: now - 25 * 3600_000 }], new Set(), alive, now)).toBe(0)
    expect(claimHeld({ pid: 'x', at: now }, alive, now)).toBe(false)
    // Ports in use (an older runner, another app): the next lane.
    expect(pickLane([{ pid: 100, at: now }], new Set([1]), alive, now)).toBe(2)
    // Every lane taken.
    const all = Array.from({ length: LANES }, () => ({ pid: 200, at: now }))
    expect(pickLane(all, new Set(), alive, now)).toBeNull()
  })

  it('runners claiming at the same time each get a lane of their own; a released lane is taken again', async () => {
    const lanesDir = tempDir('cw-lanes-')
    try {
      const free = async () => true
      type Claim = { lane: number; base: number; release: () => void }
      const claims: Claim[] = await Promise.all([101, 102, 103, 104].map((pid) => claimLane(lanesDir, { owner: pid, alive: () => true, free })))
      expect(claims.map((c) => c.lane).sort()).toEqual([0, 1, 2, 3])
      expect(new Set(claims.map((c) => c.base)).size).toBe(4)
      const first = claims.find((c) => c.lane === 0)!
      first.release()
      expect(existsSync(join(lanesDir, 'lane-0.json'))).toBe(false)
      expect((await claimLane(lanesDir, { owner: 105, alive: () => true, free })).lane).toBe(0)
      // release() leaves a claim that is no longer its runner's.
      first.release()
      expect(existsSync(join(lanesDir, 'lane-0.json'))).toBe(true)
      expect(readdirSync(lanesDir).includes('.claiming')).toBe(false)
    } finally {
      rmSync(lanesDir, { recursive: true, force: true })
    }
  })

  it('runners beyond the lanes wait for one instead of failing; --no-wait refuses at once, saying who holds them (#707)', async () => {
    const lanesDir = tempDir('cw-lanes-')
    try {
      const free = async () => true
      // Every runner is alive until it lets its lane go (a claim written is held at once, by its owner).
      const ended = new Set<number>()
      const running = (pid: number) => !ended.has(pid)
      const pids = Array.from({ length: LANES + 2 }, (_, i) => 500 + i)
      const got = new Map<number, { lane: number; waitedMs: number; release: () => void }>()
      const waiting = new Set<number>()
      const runs = pids.map((pid) =>
        waitForLane(lanesDir, { owner: pid, what: `e2e: run ${pid}`, root: 'W', alive: running, free, pollMs: 10, onWait: () => waiting.add(pid) }).then((g: { lane: number; waitedMs: number; release: () => void }) => {
          got.set(pid, g)
          return g
        })
      )
      // Ten get a lane each; the other two wait, none fails.
      await vi.waitFor(() => expect([got.size, [...waiting].filter((p) => !got.has(p)).length]).toEqual([LANES, 2]), { timeout: HUNG_MS })
      expect(new Set([...got.values()].map((g) => g.lane)).size).toBe(LANES)
      // Meanwhile a runner with --no-wait is refused at once, with who holds the lanes.
      const refused = await waitForLane(lanesDir, { owner: 900, alive: running, free, wait: false })
      expect(refused.refused.holders).toHaveLength(LANES)
      expect(describeHolder(refused.refused.holders[0])).toMatch(/^e2e: run 5\d\d in W \(process 5\d\d, 0 min\)$/)
      expect(laneWaitLine(refused.refused)).toMatch(new RegExp(`^Waiting for a test lane \\(all ${LANES} are taken on this machine\\): held by e2e: run 5`))
      expect(existsSync(join(lanesDir, 'lane-900.json'))).toBe(false)
      // Two let theirs go (one ends, one crashes): the two waiting take those lanes.
      const [a, b] = [...got.entries()].slice(0, 2)
      a[1].release()
      ended.add(a[0])
      ended.add(b[0])
      const all = await Promise.all(runs)
      const late = pids.filter((p) => waiting.has(p))
      expect(late).toHaveLength(2)
      expect(late.map((p) => got.get(p)!.lane).sort()).toEqual([a[1].lane, b[1].lane].sort())
      expect(all).toHaveLength(LANES + 2)
      expect(laneHolders(lanesDir, running)).toHaveLength(LANES)
    } finally {
      rmSync(lanesDir, { recursive: true, force: true })
    }
  })

  it("skips a lane whose ports are busy, takes over a crashed runner's, and breaks a lock left by a crash", async () => {
    const lanesDir = tempDir('cw-lanes-')
    try {
      // Lane 0 claimed by a process that is gone: taken over.
      writeFileSync(join(lanesDir, 'lane-0.json'), JSON.stringify({ pid: 999, at: Date.now() }))
      const living = (pid: number) => pid !== 999
      // Lane 1's ports are in use.
      const busy = lanePorts(1).first + 3
      const free = async (p: number) => p !== busy
      // A lock from a runner that crashed while holding it.
      mkdirSync(join(lanesDir, '.claiming'))
      const old = new Date(Date.now() - 60_000)
      utimesSync(join(lanesDir, '.claiming'), old, old)
      const a = await claimLane(lanesDir, { owner: 300, alive: living, free })
      expect(a.lane).toBe(0)
      expect(JSON.parse(readFileSync(join(lanesDir, 'lane-0.json'), 'utf8')).pid).toBe(300)
      const b = await claimLane(lanesDir, { owner: 301, alive: living, free })
      expect(b.lane).toBe(2)
      // Every lane held: none.
      for (let k = 0; k < LANES; k++) writeFileSync(join(lanesDir, `lane-${k}.json`), JSON.stringify({ pid: 400 + k, at: Date.now() }))
      expect(await claimLane(lanesDir, { owner: 302, alive: living, free })).toBeNull()
    } finally {
      rmSync(lanesDir, { recursive: true, force: true })
    }
  })

  it('sees a port something listens on as busy (portFree)', async () => {
    // A port the system picks, never a lane's: a runner may be using those while the unit tests run (progressreport
    // runs this file inside a suite).
    const { createServer } = await import('net')
    const srv = createServer()
    const port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as { port: number }).port)))
    expect(await portFree(port)).toBe(false)
    await new Promise((r) => srv.close(r))
    expect(await portFree(port)).toBe(true)
  })
})

describe("answering Claude Code's trust question (lib.acceptClaudeTrust, #188)", () => {
  type Accept = (inv: (ch: string, ...a: unknown[]) => Promise<unknown>, proj: string, agentId: string, ms?: number) => Promise<boolean>
  const { acceptClaudeTrust } = createRequire(import.meta.url)('./e2e/lib.cjs') as { acceptClaudeTrust: Accept }
  /**
   * A session whose terminal shows `screen` (or what screen(writes so far) gives: a menu that redraws as keys arrive)
   * and whose Combwork status is `status`.
   */
  const session = (screen: string | ((writes: string[]) => string), status = 'starting') => {
    const writes: string[] = []
    const inv = async (ch: string, ...a: unknown[]) => {
      if (ch === 'pty:buffer') return typeof screen === 'function' ? screen(writes) : screen
      if (ch === 'session:live') return [{ projectPath: 'C:\\P', agentId: 'a1', status }]
      writes.push(String(a[1]))
      return undefined
    }
    return { writes, run: async () => { const t = Date.now(); const r = await acceptClaudeTrust(inv, 'c:\\p', 'a1', 4000); return { r, ms: Date.now() - t } } }
  }
  /** Claude Code 2.1.291's trust menu: it starts on "No, exit", and each Down it takes moves the choice (two choices). */
  const trustMenu = (taken: (downs: number) => number) => (writes: string[]) => {
    const on = taken(writes.filter((w) => w === '\x1b[B').length) % 2 ? 'Yes' : 'No'
    return `Quick safety check: Is this a project you created or one you trust? ${on === 'No' ? '>' : ' '} No, exit ${on === 'Yes' ? '>' : ' '} Yes, I trust this folder Enter to confirm`
  }

  it('answers the trust question: Down to "Yes", and Enter once the terminal shows it chosen', async () => {
    const s = session(trustMenu((downs) => downs))
    expect((await s.run()).r).toBe(true)
    expect(s.writes).toEqual(['\x1b[B', '\r'])
  })

  it('a Down dropped while the menu is still drawing (#218) is sent again; Enter never goes on "No, exit"', async () => {
    // The first Down is lost: the menu stays on No until the second.
    const s = session(trustMenu((downs) => Math.max(0, downs - 1)))
    expect((await s.run()).r).toBe(true)
    expect(s.writes).toEqual(['\x1b[B', '\x1b[B', '\r'])
    // Already on Yes (an older Claude Code's menu): Enter at once.
    const yes = session('Quick safety check: Is this a project you created or one you trust? \x1b[1m❯\x1b[0m 1. Yes, I trust this folder  2. No, exit')
    expect((await yes.run()).r).toBe(true)
    expect(yes.writes).toEqual(['\r'])
    // A menu that never moves: no Enter at all (Claude Code is left asking, not quit).
    const stuck = session(trustMenu(() => 0))
    expect((await stuck.run()).r).toBe(false)
    expect(stuck.writes.length).toBeGreaterThan(0)
    expect(stuck.writes.includes('\r')).toBe(false)
  })

  it("in a trusted folder it returns at once: Claude Code 2.1.289's mode footer, the old one, or Hive's ready status", async () => {
    for (const screen of ['> \x1b[2m⏵⏵ auto mode on (shift+tab to cycle)\x1b[0m', '>  ⏸ manual mode on', '> ? for shortcuts']) {
      const s = session(screen)
      const { r, ms } = await s.run()
      expect(r, screen).toBe(false)
      expect(ms, screen).toBeLessThan(1000)
      expect(s.writes).toEqual([])
    }
    const ready = session('Claude Code v2.1.290', 'ready')
    expect(await ready.run()).toMatchObject({ r: false })
    expect(ready.writes).toEqual([])
  })

  it('answers nothing else: a sign-in screen waits out the timeout untouched', async () => {
    const s = session('Select login method: 1. Claude account with subscription 2. Anthropic Console account', 'waiting')
    const { r, ms } = await s.run()
    expect(r).toBe(false)
    expect(ms).toBeGreaterThanOrEqual(3900)
    expect(s.writes).toEqual([])
  })
})

describe("a restart's trust question (lib.acceptRelaunchTrust, #341)", () => {
  type Relaunch = (inv: (ch: string, ...a: unknown[]) => Promise<unknown>, proj: string, agentId: string, spawned: () => boolean, o?: { spawnMs?: number; timeoutMs?: number }) => Promise<{ spawned: boolean; trusted: boolean }>
  const { acceptRelaunchTrust } = createRequire(import.meta.url)('./e2e/lib.cjs') as { acceptRelaunchTrust: Relaunch }
  // The old process's screen still asks to trust the folder; a Down moves its menu to Yes.
  const terminal = () => {
    const calls: string[] = []
    const writes: string[] = []
    const inv = async (ch: string, ...a: unknown[]) => {
      calls.push(ch)
      if (ch === 'pty:buffer') return `Is this a project you trust? ${writes.length ? ' ' : '>'} No, exit ${writes.length ? '>' : ' '} Yes, I trust this folder`
      if (ch === 'session:live') return []
      writes.push(String(a[1]))
      return undefined
    }
    return { calls, writes, inv }
  }

  it('a restart that never spawns: not spawned, and nothing is read from or typed into the old terminal', async () => {
    const t = terminal()
    expect(await acceptRelaunchTrust(t.inv, 'c:\\p', 'a1', () => false, { spawnMs: 300, timeoutMs: 2000 })).toEqual({ spawned: false, trusted: false })
    expect(t.calls).toEqual([])
    expect(t.writes).toEqual([])
  })

  it("once the new process is seen, its trust question is answered", async () => {
    const t = terminal()
    let polls = 0
    expect(await acceptRelaunchTrust(t.inv, 'c:\\p', 'a1', () => ++polls > 2, { spawnMs: 5000, timeoutMs: 4000 })).toEqual({ spawned: true, trusted: true })
    expect(t.writes).toEqual(['\x1b[B', '\r'])
  })
})

describe('the Hives a suite starts (lib.cjs testExecutable, keepPackagedQuiet, #1253)', () => {
  type Lib = { ROOT: string; ELECTRON: string; PACKAGED_EXE: string; PACKAGED_ARGS: string[]; testExecutable: (exe: string) => string; keepPackagedQuiet: (m: object) => string[] }
  const lib = createRequire(import.meta.url)('./e2e/lib.cjs') as Lib

  it("this checkout's Electron is the dev build; its dist and the test folders' are packaged; the installed Hive and any other are refused", () => {
    expect(lib.testExecutable(lib.ELECTRON)).toBe('dev')
    expect(lib.testExecutable(lib.PACKAGED_EXE)).toBe('packaged')
    expect(lib.testExecutable(join(lib.ROOT, 'dist', 'win-unpacked', 'Hive.exe'))).toBe('packaged')
    expect(lib.testExecutable(join(process.env.LOCALAPPDATA ?? '', 'combwork-test', 'builds', 'Hive.exe'))).toBe('packaged')
    // Combwork's install (HI-2460) and Hive Desktop's from before.
    expect(() => lib.testExecutable(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Combwork', 'Combwork.exe'))).toThrow(/never start the installed Combwork/)
    expect(() => lib.testExecutable(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Hive', 'Hive.exe'))).toThrow(/never start the installed Combwork/)
    expect(() => lib.testExecutable(join(process.env.LOCALAPPDATA ?? '', 'programs', 'hive', 'Hive.exe'))).toThrow(/never start the installed Combwork/)
    expect(() => lib.testExecutable('C:\\Elsewhere\\Hive.exe')).toThrow(/never C:\\Elsewhere\\Hive\.exe/)
    // Started hidden: no window is shown before keepPackagedQuiet reaches it.
    expect(lib.PACKAGED_ARGS).toContain('--hidden')
  })

  /** A stand-in for Electron's main-process modules, with one window. */
  const electron = (visible: boolean) => {
    const calls: string[] = []
    const listeners: Record<string, (...a: unknown[]) => void> = {}
    class BrowserWindow {
      static all: BrowserWindow[] = []
      static getAllWindows = () => BrowserWindow.all
      bounds = { x: 100, y: 100, width: 1200, height: 800 }
      visible = visible
      isDestroyed = () => false
      isVisible = () => this.visible
      getTitle = () => 'Hive Desktop'
      getBounds = () => this.bounds
      setPosition = (x: number, y: number) => void (this.bounds = { ...this.bounds, x, y })
      setFocusable = (on: boolean) => void calls.push(`focusable ${on}`)
      setSkipTaskbar = (on: boolean) => void calls.push(`skipTaskbar ${on}`)
      on = () => undefined
      once = () => undefined
    }
    Object.assign(BrowserWindow.prototype, {
      show: () => calls.push('show'),
      showInactive: function (this: BrowserWindow) {
        this.visible = true
        calls.push('showInactive')
      },
      focus: () => calls.push('focus'),
      maximize: () => calls.push('maximize'),
      flashFrame: () => calls.push('flashFrame')
    })
    BrowserWindow.all.push(new BrowserWindow())
    class Notification {
      show() {
        calls.push('notification')
      }
    }
    const dialog = { showMessageBox: () => calls.push('dialog'), showErrorBox: () => calls.push('errorBox') }
    const app = { on: (e: string, f: (...a: unknown[]) => void) => void (listeners[e] = f) }
    const screen = { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 2560, height: 1440 } }, { bounds: { x: -1920, y: 200, width: 1920, height: 1080 } }] }
    const state = { ready: true }
    // Electron's screen isn't usable before the app is ready (0.9.3 in Windows Sandbox: "getAllDisplays is not a function").
    const modules = {
      app,
      BrowserWindow,
      Notification,
      dialog,
      get screen() {
        if (!state.ready) throw new Error('screen before ready')
        return screen
      }
    }
    return { modules, state, calls, win: BrowserWindow.all[0] as unknown as { bounds: { x: number }; visible: boolean } & Record<string, () => void>, listeners, BrowserWindow }
  }

  it('reached before the app is ready (no window yet), it uses the screen only once a window is made', () => {
    const e = electron(false)
    e.BrowserWindow.all.length = 0
    e.state.ready = false
    expect(lib.keepPackagedQuiet(e.modules)).toEqual([])
    e.state.ready = true
    const win = new e.BrowserWindow()
    e.listeners['browser-window-created']({}, win)
    expect(win.bounds.x).toBe(-1920 - 1200 - 8000)
  })

  it('its windows go off screen, unfocusable and off the taskbar, then show without the focus; nothing shows, focuses or notifies after', async () => {
    const e = electron(false)
    expect(lib.keepPackagedQuiet(e.modules)).toEqual([])
    expect(e.win.bounds.x).toBe(-1920 - 1200 - 8000)
    expect(e.calls).toEqual(['focusable false', 'skipTaskbar true', 'showInactive'])
    e.calls.length = 0
    e.win.show()
    e.win.focus()
    e.win.maximize()
    e.win.flashFrame()
    expect(e.calls).toEqual(['showInactive'])
    e.calls.length = 0
    ;(new (e.modules.Notification as new () => { show: () => void })()).show()
    e.modules.dialog.showErrorBox()
    expect(await (e.modules.dialog.showMessageBox as unknown as (o: object) => Promise<{ response: number }>)({ cancelId: 2 })).toEqual({ response: 2, checkboxChecked: false })
    expect(e.calls).toEqual([])
    expect(e.listeners['browser-window-created']).toBeTypeOf('function')
  })

  it('a window already shown when it is reached is said (the launch then fails)', () => {
    expect(lib.keepPackagedQuiet(electron(true).modules)).toEqual(['Hive Desktop'])
  })
})

describe('packaged test Hives never check GitHub for updates (lib.cjs, #1332)', () => {
  type Lib = { NO_UPDATE_CHECK: Record<string, string>; noUpdateChecks: (profile: string) => void; updateChecksLogged: (l: { profile: string; since: string }) => string[] }
  const lib = createRequire(import.meta.url)('./e2e/lib.cjs') as Lib

  it("a 0.9's first check is put off as far as a timer goes", () => {
    expect(Number(lib.NO_UPDATE_CHECK.CW_UPDATE_DELAY)).toBe(2147483647)
  })

  it("a saved profile gets automatic checks off, its other settings kept; a new one is left alone", () => {
    const profile = tempDir('cw-noupdates-')
    lib.noUpdateChecks(profile)
    expect(existsSync(join(profile, 'config.json'))).toBe(false)
    writeFileSync(join(profile, 'config.json'), JSON.stringify({ version: 9, settings: { updates: { install: 'manual' }, general: { showTips: true } } }))
    lib.noUpdateChecks(profile)
    expect(JSON.parse(readFileSync(join(profile, 'config.json'), 'utf8'))).toEqual({ version: 9, settings: { updates: { install: 'manual', checkAutomatically: false }, general: { showTips: true } } })
  })

  it('the guard finds a check logged since the launch, in combwork.log or its older copy, and only those', () => {
    const profile = tempDir('cw-noupdates-')
    mkdirSync(join(profile, 'logs'))
    const check = '2026-10-21T10:00:05.000Z [INFO] [updates] Checking for update'
    writeFileSync(join(profile, 'logs', 'combwork.1.log'), `2026-10-21T09:00:00.000Z [INFO] [updates] Checking for update\n${check}\n`)
    writeFileSync(join(profile, 'logs', 'combwork.log'), '2026-10-21T10:00:06.000Z [INFO] [updates] Update settings: check off\n')
    expect(lib.updateChecksLogged({ profile, since: '2026-10-21T10:00:00.000Z' })).toEqual([check])
    expect(lib.updateChecksLogged({ profile, since: '2026-10-21T11:00:00.000Z' })).toEqual([])
  })
})

describe('whether a process still runs (lib.processRunning, #339)', () => {
  const { processRunning } = createRequire(import.meta.url)('./e2e/lib.cjs') as { processRunning: (pid: number) => boolean }
  const failing = (code: string) => () => {
    throw Object.assign(new Error(`kill ${code}`), { code })
  }

  it('runs: true; no such process (ESRCH): false', () => {
    expect(processRunning(process.pid)).toBe(true)
    const kill = vi.spyOn(process, 'kill').mockImplementation(failing('ESRCH'))
    try {
      expect(processRunning(1234)).toBe(false)
    } finally {
      kill.mockRestore()
    }
  })

  it("any other error (EPERM) is thrown, never read as exited: its state is unknown", () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(failing('EPERM'))
    try {
      expect(() => processRunning(1234)).toThrow(/Can't tell whether process 1234 runs: EPERM/)
    } finally {
      kill.mockRestore()
    }
  })
})

describe('sending a prompt to a CLI until it takes it (lib.sendPrompt, #190)', () => {
  type Send = (inv: (ch: string, ...a: unknown[]) => Promise<unknown>, key: string, text: string, o: { submitted: () => boolean | Promise<boolean>; ready?: () => boolean; tries?: number; waitMs?: number }) => Promise<number>
  const { sendPrompt } = createRequire(import.meta.url)('./e2e/lib.cjs') as { sendPrompt: Send }
  const text = 'Use apply_patch to add a file notes.txt containing hi.'
  /**
   * A terminal that drops the first `dropText` prompts typed and ignores the first `dropEnter` Enters (a new line in
   * the input instead). With `paste` it has bracketed paste on and reads as Claude Code 2.1.309 does (#1547): each write
   * is one read, however it was split; a long typed read is a paste, a Ctrl+U in it kept as an invisible character that
   * leaves the prompt unsent; a Ctrl+U read alone clears the input. With `emptyAfterFirst` it empties its input after
   * drawing the first prompt, as Claude Code does drawing its weekly limit line just after start (#1148, #1556).
   */
  const terminal = ({ dropText = 0, dropEnter = 0, paste = false, emptyAfterFirst = false, prompt = text }) => {
    const t = { writes: [] as string[], screen: paste ? '\x1b[?2004h' : '', input: '', submitted: false, taken: [] as string[] }
    let drawn = 0
    const inv = async (ch: string, _key: unknown, data?: unknown) => {
      if (ch === 'pty:buffer') return t.screen
      const d = String(data)
      t.writes.push(d)
      if (d === '\x15') t.input = ''
      else if (d === '\r') {
        if (dropEnter-- > 0) t.input += '\n'
        else if (t.input.trim() && !t.input.includes('\x15')) {
          t.submitted = true
          t.taken.push(t.input)
        }
      } else if (dropText-- <= 0) {
        const pasted = /^\x1b\[200~([^]*)\x1b\[201~$/.exec(d)
        t.input = pasted ? pasted[1] : d
        t.screen += `\x1b[2m> ${t.input}`
        if (emptyAfterFirst && ++drawn === 1) {
          t.input = ''
          t.screen += '\r\nYou\'ve used 95% of your weekly limit\r\n> Try "how does <filepath> work?"'
        }
      }
      return undefined
    }
    return { t, run: (tries?: number, o: { submitted?: () => boolean; ready?: () => boolean } = {}) => sendPrompt(inv, 'k', prompt, { submitted: () => t.submitted, waitMs: 50, ...(tries ? { tries } : {}), ...o }) }
  }
  /** An attempt as typed: Ctrl+U as a write of its own, the prompt (pasted or typed), Enter. */
  const attempt = (prompt: string, paste: boolean) => ['\x15', paste ? `\x1b[200~${prompt}\x1b[201~` : prompt, '\r']
  afterEach(() => vi.restoreAllMocks())

  it('taken at once: Ctrl+U on its own, one prompt, one Enter; pasted while the CLI has bracketed paste on', async () => {
    const typed = terminal({})
    expect(await typed.run()).toBe(1)
    expect(typed.t.writes).toEqual(attempt(text, false))
    const pasted = terminal({ paste: true })
    expect(await pasted.run()).toBe(1)
    expect(pasted.t.writes).toEqual(attempt(text, true))
  })

  it('typed, an Enter that became a new line: Enter again, without typing the prompt twice', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { t, run } = terminal({ dropEnter: 1 })
    expect(await run()).toBe(2)
    expect(t.writes).toEqual([...attempt(text, false), '\r'])
  })

  it('a prompt dropped while the CLI was drawing: typed again over a cleared input', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { t, run } = terminal({ dropText: 1 })
    expect(await run()).toBe(2)
    expect(t.writes).toEqual([...attempt(text, false), ...attempt(text, false)])
  })

  it('pasted, an input the CLI emptied after drawing the prompt: pasted again whole, taken once, never Enter on nothing (#1148, #1556)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { t, run } = terminal({ paste: true, emptyAfterFirst: true })
    expect(await run()).toBe(2)
    expect(t.writes).toEqual([...attempt(text, true), ...attempt(text, true)])
    expect(t.taken).toEqual([text])
    expect(String(log.mock.calls[0][0])).toMatch(/^INFO sendPrompt attempt 1 not taken: pasted, echoed yes, its text not on the last input line/)
  })

  it('with bracketed paste on, a dropped prompt goes again as a paste after a Ctrl+U of its own (#1547)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { t, run } = terminal({ dropText: 1, paste: true })
    expect(await run()).toBe(2)
    expect(t.writes).toEqual([...attempt(text, true), ...attempt(text, true)])
  })

  it('a slash command is typed again, never pasted (pasted, it would be sent as a message)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { t, run } = terminal({ dropText: 1, paste: true, prompt: '/exit' })
    expect(await run()).toBe(2)
    expect(t.writes).toEqual([...attempt('/exit', false), ...attempt('/exit', false)])
  })

  it('a prompt taken after its attempt gave up is not typed again: submitted() is checked before a retry', async () => {
    // The CLI took it, but says so only once the attempt's wait is over (a slow hook).
    let late = false
    vi.spyOn(console, 'log').mockImplementation(() => {
      late = true
    })
    const { t, run } = terminal({ paste: true })
    expect(await run(3, { submitted: () => late })).toBe(1)
    expect(t.writes).toEqual(attempt(text, true))
  })

  it('waits for ready() before the first attempt, and types anyway, saying so, when it never comes', async () => {
    const { t, run } = terminal({ paste: true })
    let polls = 0
    const ready = () => {
      // Nothing typed while it isn't ready.
      expect(t.writes).toEqual([])
      return ++polls >= 2
    }
    expect(await run(3, { ready })).toBe(1)
    expect(polls).toBe(2)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const never = terminal({ paste: true })
    expect(await never.run(3, { ready: () => false })).toBe(1)
    expect(String(log.mock.calls[0][0])).toBe('INFO sendPrompt: not ready within 0.05 s, typed anyway')
    expect(never.t.taken).toEqual([text])
  })

  it('never taken: 0 after the tries, the last typed again whole', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { t, run } = terminal({ dropEnter: 9 })
    expect(await run(3)).toBe(0)
    expect(t.writes).toEqual([...attempt(text, false), '\r', ...attempt(text, false)])
  })
})

describe('the shared Codex test home: changes to its config.toml under a lock (lib.cjs)', () => {
  type Lib = { trustForCodex: (folder: string, home?: string) => void }
  const { trustForCodex } = createRequire(import.meta.url)('./e2e/lib.cjs') as Lib
  const libPath = join(dir, 'lib.cjs')
  /** Another runner's suite trusting a folder in that home: a process of its own. */
  const trustIn = async (home: string, folder: string) => {
    const env: Record<string, string | undefined> = { ...process.env, CW_TEST_CODEX_HOME: home, CW_E2E_DIR: join(home, 'work') }
    delete env.ELECTRON_RUN_AS_NODE
    // Its error output is kept: a runner that fails says why in the test's failure (#181), rather than only exit 1.
    const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(libPath)}).trustForCodex(${JSON.stringify(folder)})`], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr?.on('data', (d) => (err += d))
    return new Promise<number | null>((resolve) =>
      child.on('exit', (code) => {
        if (code) failures.push(`${folder}: exit ${code}\n${err.trim().split('\n').slice(0, 8).join('\n')}`)
        resolve(code)
      })
    )
  }
  /** The runners that failed in this test file, with their error output, for the assertion messages. */
  const failures: string[] = []
  const entries = (home: string) => [...readFileSync(join(home, 'config.toml'), 'utf8').matchAll(/^\[projects\.'([^']+)'\]$/gm)].map((m) => m[1]).sort()

  it("waits while another runner changes it, and keeps that runner's change", async () => {
    const home = tempDir('cw-codex-home-')
    try {
      writeFileSync(join(home, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
      // This runner holds the lock (mid-change: it has read the file and not yet written it back).
      mkdirSync(join(home, 'config.toml.lock'))
      const other = trustIn(home, 'C:/lane1/codex-ws/demo')
      await new Promise((r) => setTimeout(r, 1500))
      // The other runner is waiting: the file is as this one read it.
      expect(entries(home)).toEqual([])
      writeFileSync(join(home, 'config.toml'), `${readFileSync(join(home, 'config.toml'), 'utf8')}\n[projects.'C:/lane0/codex-ws/demo']\ntrust_level = "trusted"\n`)
      rmSync(join(home, 'config.toml.lock'), { recursive: true })
      expect(await other, failures.join('\n\n')).toBe(0)
      // Neither change lost.
      expect(entries(home)).toEqual(['C:/lane0/codex-ws/demo', 'C:/lane1/codex-ws/demo'])
      expect(readFileSync(join(home, 'config.toml'), 'utf8').match(/^\[windows\]/gm)).toHaveLength(1)
      expect(existsSync(join(home, 'config.toml.lock'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  it('several runners at once: every folder trusted once', async () => {
    const home = tempDir('cw-codex-home-')
    try {
      const folders = Array.from({ length: 6 }, (_, k) => `C:/lanes/${k}/codex-ws/demo`)
      expect(await Promise.all(folders.map((f) => trustIn(home, f))), failures.join('\n\n')).toEqual(folders.map(() => 0))
      expect(entries(home)).toEqual([...folders].sort())
      // Again: nothing added twice. A folder whose name starts with another's is its own entry.
      trustForCodex(folders[0], home)
      trustForCodex(`${folders[0]}2`, home)
      expect(entries(home)).toEqual([...folders, `${folders[0]}2`].sort())
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  it('breaks a lock left by a runner that crashed while holding it', () => {
    const home = tempDir('cw-codex-home-')
    try {
      const lock = join(home, 'config.toml.lock')
      mkdirSync(lock)
      const old = new Date(Date.now() - 120_000)
      utimesSync(lock, old, old)
      trustForCodex('C:/ws/demo', home)
      expect(entries(home)).toEqual(['C:/ws/demo'])
      expect(existsSync(lock)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("Windows' in-use answers (EPERM, EACCES, EBUSY) while taking or letting go of the lock mean busy, not a failure (#181)", () => {
    type Lock = (file: string, fn: () => unknown, o?: { staleMs?: number; timeoutMs?: number }) => unknown
    const req = createRequire(import.meta.url)
    const { withFileLock } = req('./e2e/lib.cjs') as { withFileLock: Lock }
    const nodeFs = req('fs') as typeof import('fs')
    const home = tempDir('cw-codex-home-')
    const file = join(home, 'config.toml')
    const lock = `${file}.lock`
    const fail = (code: string) => Object.assign(new Error(`${code}: operation not permitted`), { code })
    const mkdir = nodeFs.mkdirSync
    const rm = nodeFs.rmSync
    try {
      // Taking it: in use twice (another runner still had the folder open), then free.
      let refusals = ['EPERM', 'EBUSY', 'EACCES']
      const spyMk = vi.spyOn(nodeFs, 'mkdirSync').mockImplementation(((p: string, o?: object) => {
        if (p === lock && refusals.length) throw fail(refusals.shift()!)
        return mkdir(p, o as never)
      }) as never)
      // Letting go: in use once, then gone.
      let busyRm = 1
      const spyRm = vi.spyOn(nodeFs, 'rmSync').mockImplementation(((p: string, o?: object) => {
        if (p === lock && busyRm-- > 0) throw fail('EBUSY')
        return rm(p, o as never)
      }) as never)
      let ran = 0
      expect(withFileLock(file, () => ++ran)).toBe(1)
      expect(ran).toBe(1)
      expect(existsSync(lock)).toBe(false)
      // A permission problem that doesn't pass still ends, at the timeout, naming its error.
      refusals = Array(10_000).fill('EPERM')
      expect(() => withFileLock(file, () => ++ran, { timeoutMs: 200 })).toThrow(/is still held \(EPERM\)/)
      // Anything else is a failure at once (its parent folder missing, say).
      refusals = []
      expect(() => withFileLock(join(home, 'no', 'such', 'config.toml'), () => ++ran)).toThrow(/ENOENT/)
      expect(ran).toBe(1)
      // Refused with its age unreadable (stat fails): a paced poll, never a busy loop (review round 1). A refusal that
      // clears is taken after a few paced tries; one that lasts ends at the timeout after about timeout / 25 ms tries.
      let tries = 0
      const spyStat = vi.spyOn(nodeFs, 'statSync').mockImplementation(((p: string) => {
        if (p === lock) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        throw new Error(`unexpected stat of ${p}`)
      }) as never)
      spyMk.mockImplementation(((p: string, o?: object) => {
        if (p === lock && (tries++, refusals.length)) throw fail(refusals.shift()!)
        return mkdir(p, o as never)
      }) as never)
      refusals = ['EPERM', 'EACCES', 'EBUSY']
      const t0 = Date.now()
      expect(withFileLock(file, () => ++ran)).toBe(2)
      expect(tries).toBe(4)
      expect(Date.now() - t0).toBeGreaterThanOrEqual(3 * 20)
      tries = 0
      refusals = Array(100_000).fill('EPERM')
      expect(() => withFileLock(file, () => ++ran, { timeoutMs: 200 })).toThrow(/is still held \(EPERM\)/)
      expect(tries).toBeGreaterThan(2)
      expect(tries).toBeLessThan(20)
      spyStat.mockRestore()
      spyMk.mockRestore()
      spyRm.mockRestore()
    } finally {
      vi.restoreAllMocks()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('the run context: what a test starts gets only the allowlist and its own context (runContext.cjs, #203)', () => {
  type Env = Record<string, string | undefined>
  type Ctx = {
    WORK: string
    isUserCliHome: (dir: string, parent?: Env) => boolean
    ALLOW: string[]
    PASS_ENV: Record<string, string>
    CARRIED: string[]
    baseEnv: (parent?: Env) => Env
    childEnv: (vars?: Env, parent?: Env) => Env
    combworkEnv: (vars?: Env, parent?: Env) => Env
    isCombworkEnv: (env: unknown) => boolean
    suiteEnv: (o: { name: string; port?: number | null; work?: string | null; runDir: string; cliLog?: string | null }, parent?: Env) => Env
    TEST_GIT_IDENTITY: { name: string; email: string }
    gitConfig: (parent?: Env) => string
    writeGitConfig: (file: string) => void
    gitEnv: (vars?: Env, parent?: Env) => Env
    isUserGitConfig: (file: string, parent?: Env) => boolean
  }
  const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs') as Ctx
  /** An agent's shell in Combwork, inside an outer hive-progress, in a suite of a runner, with a person's settings. */
  const parent: Env = {
    Path: 'C:\\Windows;C:\\node',
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\t',
    LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local',
    https_proxy: 'http://proxy:8080',
    NO_COLOR: '1',
    FORCE_COLOR: '1',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--inspect',
    CLAUDE_CONFIG_DIR: 'C:\\mine\\claude',
    ANTHROPIC_API_KEY: 'k',
    GIT_DIR: 'C:\\repo\\.git',
    CW_API_URL: 'http://127.0.0.1:47821',
    CW_API_TOKEN: 'secret',
    CW_PROJECT: 'hive',
    CW_PROGRESS_WRAPPED: '1',
    CW_PROGRESS_RUN_AS_NODE: '1',
    CW_PROGRESS_DATA: 'C:\\progress',
    CW_E2E_NATIVE: '1',
    CW_TEST_SLOW_IPC: 'tasks:list=9000',
    CW_TEST_CODEX_HOME: 'C:\\codex-test',
    CW_E2E_PORT: '47950',
    E2E_RUN_SUITE: 'progressreport',
    E2E_RUN_DIR: 'C:\\lanes\\0',
    E2E_RUN_PORT: '47950'
  }
  const has = (env: Env, k: string) => Object.keys(env).some((x) => x.toUpperCase() === k.toUpperCase())

  it('no suite, runner or harness builds a child environment from process.env: they use lib.combworkEnv, lib.childEnv or runContext', () => {
    // The fake CLIs are left out: they stand for Claude Code and Codex, which start their MCP servers from their own
    // environment (a test Combwork's session's, already the run context's).
    const exempt = ['runContext.cjs', 'fake-bridge.cjs']
    const files = [
      ...readdirSync(dir).filter((f) => /\.(c|m)js$/.test(f) && !exempt.includes(f)).map((f) => join(dir, f)),
      ...readdirSync(join(__dirname, 'scenarios')).filter((f) => /\.(c|m)js$/.test(f)).map((f) => join(__dirname, 'scenarios', f))
    ]
    expect(files.length).toBeGreaterThan(80)
    const fromProcessEnv = /\.\.\.\s*process\.env\b|env\s*:\s*process\.env\b|Object\.assign\(\s*\{\s*\}\s*,\s*process\.env\b|\b(const|let|var)\s+\w+\s*=\s*process\.env\s*($|[;,])/
    // Each form it catches, and reading one variable it doesn't (#1023: a backspace in place of the last \b made that
    // form never match, unnoticed from #203 on).
    for (const line of ['spawn(x, [], { env: { ...process.env, A: 1 } })', '{ env: process.env }', 'Object.assign({}, process.env)', 'const env = process.env', '  let e = process.env;']) expect(fromProcessEnv.test(line), line).toBe(true)
    for (const line of ['const home = process.env.HOME', 'const env = process.env.NODE_ENV || "x"', 'if (process.env.CI) return']) expect(fromProcessEnv.test(line), line).toBe(false)
    const found: string[] = []
    for (const f of files)
      readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (fromProcessEnv.test(line)) found.push(`${f.slice(root.length + 1)}:${i + 1}`)
        })
    expect(found).toEqual([])
  })

  it("a suite's environment: the allowlist, the test settings passed on by name, and its run context; nothing else", () => {
    const env = ctx.suiteEnv({ name: 'board', port: 47961, work: 'C:\\lanes\\1', runDir: 'C:\\lanes\\1' }, parent)
    expect(env).toMatchObject({ Path: parent.Path, SystemRoot: 'C:\\Windows', https_proxy: 'http://proxy:8080', CW_TEST_CODEX_HOME: 'C:\\codex-test', CW_E2E_DIR: 'C:\\lanes\\1', CW_E2E_PORT: '47961', CW_API_PORT: '47961', E2E_RUN_SUITE: 'board', E2E_RUN_DIR: 'C:\\lanes\\1', E2E_RUN_PORT: '47961' })
    for (const k of ['NO_COLOR', 'FORCE_COLOR', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'GIT_DIR', 'CW_API_URL', 'CW_API_TOKEN', 'CW_PROJECT', 'CW_PROGRESS_WRAPPED', 'CW_PROGRESS_RUN_AS_NODE', 'CW_PROGRESS_DATA', 'CW_E2E_NATIVE', 'CW_TEST_SLOW_IPC']) expect(has(env, k), k).toBe(false)
    // Without a port (a serial suite of a runner inside a suite): none inherited from the runner that started this one.
    const nested = ctx.suiteEnv({ name: 'about', runDir: 'C:\\lanes\\0\\nested' }, parent)
    for (const k of ['CW_E2E_PORT', 'CW_API_PORT', 'E2E_RUN_PORT', 'CW_E2E_DIR']) expect(has(nested, k), k).toBe(false)
  })

  it("every test copy of Hive deletes into its suite's trash folder, never the user's Recycle Bin (#414)", () => {
    const suite = ctx.suiteEnv({ name: 'board', port: 47961, work: 'C:\\lanes\\1\\board', runDir: 'C:\\lanes\\1\\board' }, parent)
    expect(ctx.combworkEnv({ CW_USER_DATA: 'C:\\p' }, suite).CW_TEST_TRASH_DIR).toBe('C:\\lanes\\1\\board\\trash')
    // A suite run on its own: the work folder's.
    expect(ctx.combworkEnv({ CW_USER_DATA: 'C:\\p' }, parent).CW_TEST_TRASH_DIR).toBe(join(ctx.WORK, 'trash'))
    // Not a child that isn't Combwork, and not from the shell the run was started from.
    expect(has(ctx.childEnv({}, suite), 'CW_TEST_TRASH_DIR')).toBe(false)
    expect(ctx.combworkEnv({}, { ...suite, CW_TEST_TRASH_DIR: 'C:\\elsewhere' }).CW_TEST_TRASH_DIR).toBe('C:\\lanes\\1\\board\\trash')
    // The runner counts the Recycle Bin, read only, before and after.
    const runner = readFileSync(join(root, 'tests', 'e2e', 'run.mjs'), 'utf8')
    expect(runner).toMatch(/recycleBinCount\(\)[\s\S]*recycleBinLine\(binBefore, recycleBinCount\(\)\)/)
    expect(readFileSync(join(root, 'tests', 'e2e', 'recycleBin.mjs'), 'utf8')).not.toMatch(/Empty|InvokeVerb|Delete|Remove-/)
  })

  it("every test copy of Hive gets the CLI homes, test folders, never the user's ~/.claude, ~/.codex, ~/.copilot or gh login (#382, #452)", () => {
    const suite = ctx.suiteEnv({ name: 'board', port: 47961, work: 'C:\\lanes\\1\\board', runDir: 'C:\\lanes\\1\\board' }, parent)
    // By default, empty folders of the suite's own; whatever the shell the run was started from had.
    const shell = { ...suite, CLAUDE_CONFIG_DIR: 'C:\\Users\\t\\.claude', CODEX_HOME: 'C:\\Users\\t\\.codex' }
    expect(ctx.combworkEnv({ CW_USER_DATA: 'C:\\p' }, shell)).toMatchObject({ CLAUDE_CONFIG_DIR: 'C:\\lanes\\1\\board\\cli-homes\\claude', CODEX_HOME: 'C:\\lanes\\1\\board\\cli-homes\\codex' })
    expect(ctx.combworkEnv({ CW_USER_DATA: 'C:\\p' }, parent)).toMatchObject({ CLAUDE_CONFIG_DIR: join(ctx.WORK, 'cli-homes', 'claude'), CODEX_HOME: join(ctx.WORK, 'cli-homes', 'codex') })
    // Copilot's home and the GitHub CLI's config (Copilot falls back to gh's login): empty folders too, whatever the shell had.
    expect(ctx.combworkEnv({ CW_USER_DATA: 'C:\\p' }, { ...shell, COPILOT_HOME: 'C:\\Users\\t\\.copilot', GH_CONFIG_DIR: 'C:\\Users\\t\\AppData\\Roaming\\GitHub CLI' })).toMatchObject({ COPILOT_HOME: 'C:\\lanes\\1\\board\\cli-homes\\copilot', GH_CONFIG_DIR: 'C:\\lanes\\1\\board\\cli-homes\\gh' })
    // A suite gives a test home instead (the fake Claude Code's, its own, the Codex test home).
    expect(ctx.combworkEnv({ CW_USER_DATA: 'C:\\p', CLAUDE_CONFIG_DIR: 'C:\\fake-home', CODEX_HOME: 'C:\\codex-test' }, suite)).toMatchObject({ CLAUDE_CONFIG_DIR: 'C:\\fake-home', CODEX_HOME: 'C:\\codex-test' })
    // Not for a child that isn't Combwork.
    for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'GH_CONFIG_DIR']) expect(has(ctx.childEnv({}, suite), k), k).toBe(false)
    // The user's homes, however spelled; not a folder beside or inside them.
    const user = { ...parent, USERPROFILE: 'C:\\Users\\t', APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }
    for (const p of ['C:\\Users\\t\\.claude', 'c:/users/T/.codex/', 'C:\\Users\\t\\x\\..\\.claude', 'C:\\Users\\t\\.copilot', 'c:\\users\\t\\appdata\\roaming\\github cli\\']) expect(ctx.isUserCliHome(p, user), p).toBe(true)
    for (const p of ['C:\\Users\\t\\.claude-test', 'C:\\Users\\t\\.codex\\homes\\x', join(ctx.WORK, 'cli-homes', 'claude'), join(ctx.WORK, 'cli-homes', 'gh')]) expect(ctx.isUserCliHome(p, user), p).toBe(false)
    // lib.cjs refuses to start a test Combwork with any home missing or the user's own.
    const lib = readFileSync(join(root, 'tests', 'e2e', 'lib.cjs'), 'utf8')
    expect(lib).toMatch(/for \(const k of \['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'GH_CONFIG_DIR'\]\) \{\s*if \(!env\[k\]\) throw[\s\S]*?if \(isUserCliHome\(env\[k\]\)\) throw/)
  })

  it("every test copy of Hive's git, and its suite's on the fixtures, has the suite's config alone: a test identity, explicit line endings, no user or system config (#1466)", () => {
    const suite = ctx.suiteEnv({ name: 'gitview', port: 47961, work: 'C:\\lanes\\1\\gitview', runDir: 'C:\\lanes\\1\\gitview' }, parent)
    // The suite's, whatever the shell had, and no system config; a suite may give its own global one.
    const fromShell = ctx.combworkEnv({ CW_USER_DATA: 'C:\\p' }, { ...suite, GIT_CONFIG_GLOBAL: 'C:\\Users\\t\\.gitconfig', GIT_CONFIG_NOSYSTEM: '0' })
    expect(fromShell).toMatchObject({ GIT_CONFIG_GLOBAL: 'C:\\lanes\\1\\gitview\\gitconfig', GIT_CONFIG_NOSYSTEM: '1' })
    expect(ctx.combworkEnv({ CW_USER_DATA: 'C:\\p' }, parent).GIT_CONFIG_GLOBAL).toBe(join(ctx.WORK, 'gitconfig'))
    expect(ctx.combworkEnv({ CW_USER_DATA: 'C:\\p', GIT_CONFIG_GLOBAL: 'C:\\w\\empty.gitconfig' }, suite).GIT_CONFIG_GLOBAL).toBe('C:\\w\\empty.gitconfig')
    // The suite's own git on its fixtures gets the same; a child that isn't git, and the runners' git on the checkout
    // under test (baseEnv, checked out with the machine's settings), get neither.
    expect(ctx.gitEnv({}, { ...suite, GIT_CONFIG_GLOBAL: 'C:\\Users\\t\\.gitconfig' })).toMatchObject({ GIT_CONFIG_GLOBAL: 'C:\\lanes\\1\\gitview\\gitconfig', GIT_CONFIG_NOSYSTEM: '1' })
    expect(has(ctx.gitEnv({}, suite), 'GIT_DIR')).toBe(false)
    for (const env of [ctx.childEnv({}, suite), ctx.baseEnv(suite)]) for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) expect(has(env, k), k).toBe(false)
    // The user's own, however spelled.
    for (const f of ['C:\\Users\\t\\.gitconfig', 'c:/users/T/.gitconfig', 'C:\\Users\\t\\.config\\git\\config']) expect(ctx.isUserGitConfig(f, parent), f).toBe(true)
    expect(ctx.isUserGitConfig('C:\\lanes\\1\\gitview\\gitconfig', parent)).toBe(false)
    // What git reads with them (run with combworkEnv's and gitEnv's environments, outside any repository): the test identity,
    // autocrlf false, from the suite's file alone.
    const work = tempDir('cw-gitconfig-')
    const shell = { ...process.env, CW_E2E_DIR: work }
    for (const env of [ctx.combworkEnv({ CW_USER_DATA: join(work, 'profile') }, shell), ctx.gitEnv({}, shell)]) {
      ctx.writeGitConfig(env.GIT_CONFIG_GLOBAL!)
      const read = (...a: string[]) => execFileSync('git', ['config', ...a], { cwd: work, env: env as NodeJS.ProcessEnv, encoding: 'utf8' }).trim()
      expect([read('--global', 'user.name'), read('--global', 'user.email'), read('core.autocrlf')]).toEqual([ctx.TEST_GIT_IDENTITY.name, ctx.TEST_GIT_IDENTITY.email, 'false'])
      // Every setting from the global scope (GIT_CONFIG_GLOBAL, the suite's file): none from the system or the user's.
      const scopes = new Set(read('--list', '--show-scope').split(/\r?\n/).map((l) => l.split('\t')[0]))
      expect([...scopes]).toEqual(['global'])
    }
    // lib.cjs refuses a test Combwork without one or with the user's, and writes the suite's.
    const lib = readFileSync(join(root, 'tests', 'e2e', 'lib.cjs'), 'utf8')
    expect(lib).toMatch(/if \(!env\.GIT_CONFIG_GLOBAL\) throw[\s\S]*?if \(isUserGitConfig\(env\.GIT_CONFIG_GLOBAL\)\) throw[\s\S]*?writeGitConfig\(env\.GIT_CONFIG_GLOBAL\)/)
    // Every git a suite starts on its fixtures has gitEnv (lib.git does): not the shell's, the allowlist's or none. The
    // exceptions: evidence's on the checkout under test, and isolation's inside its test Combwork (which has combworkEnv's).
    const suiteFiles = [...readdirSync(dir).filter((f) => f.endsWith('.cjs')).map((f) => join(dir, f)), ...readdirSync(join(dir, 'i18nshots')).filter((f) => f.endsWith('.cjs')).map((f) => join(dir, 'i18nshots', f))]
    const plain: string[] = []
    for (const f of suiteFiles)
      readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/(execSync|execFileSync|spawnSync|spawn)\(\s*['"`]git\b/.test(line) && !/gitEnv/.test(line)) plain.push(`${f.slice(dir.length + 1)}:${i + 1}`)
        })
    expect(plain.map((p) => p.replace(/:\d+$/, ''))).toEqual(['evidence.cjs', 'isolation.cjs'])
    expect(lib).toMatch(/execFileSync\('git', cmd, \{ env: gitEnv\(\), \.\.\.o \}\) : execSync\(`git \$\{cmd\}`, \{ env: gitEnv\(\), \.\.\.o \}\)/)
  })

  it("the CLIs a suite's Hive selects go to a log of the suite's own; the runner starts no CLI of its own (#365)", () => {
    // The runner gives each suite a log in its folder, and the suite's test copies of Combwork inherit it (CARRIED).
    const suite = ctx.suiteEnv({ name: 'codex', port: 47961, work: 'C:\\lanes\\1\\codex', runDir: 'C:\\lanes\\1\\codex', cliLog: 'C:\\lanes\\1\\codex\\cw-clis.jsonl' }, parent)
    expect(suite.CW_TEST_CLI_LOG).toBe('C:\\lanes\\1\\codex\\cw-clis.jsonl')
    expect(ctx.combworkEnv({ CW_USER_DATA: 'C:\\p' }, suite).CW_TEST_CLI_LOG).toBe('C:\\lanes\\1\\codex\\cw-clis.jsonl')
    expect(has(ctx.childEnv({}, suite), 'CW_TEST_CLI_LOG')).toBe(false)
    expect(has(ctx.suiteEnv({ name: 'x', runDir: 'C:\\w' }, { ...parent, CW_TEST_CLI_LOG: 'C:\\elsewhere' }), 'CW_TEST_CLI_LOG')).toBe(false)
    // The record's versions are what the suites' Combwork selected, in the CLI homes the suites gave it: the runner never
    // runs a CLI itself (a --version of its own ran in the user's homes and took the first copy on PATH, #365 round 1).
    const runner = readFileSync(join(root, 'tests', 'e2e', 'run.mjs'), 'utf8')
    expect(runner).not.toMatch(/['"]--version['"]/)
  })

  // Combwork looks for both CLIs when it starts, and their sign-in checks read the home they are given, else the user's.
  // Suites added since (#333, #362, #365) give every Combwork they start both homes; #382 brings the older ones in.
  it('newer suites give each test Hive their own Claude Code and Codex homes (#362)', () => {
    for (const name of ['claudesettings', 'contrast', 'testedclis']) {
      const src = readFileSync(join(root, 'tests', 'e2e', `${name}.cjs`), 'utf8')
      const launches = [...src.matchAll(/lib\.launch\(\{[^\n]*\}\)/g)].map((m) => m[0])
      expect(launches.length, name).toBeGreaterThan(0)
      for (const l of launches) {
        // The homes are passed directly, through `homes`, or with the fake Claude Code's (lib.fakeClaude's CLAUDE_CONFIG_DIR).
        const claude = /CLAUDE_CONFIG_DIR|env: homes|\.\.\.claude\b/.test(l)
        const codex = /CODEX_HOME|env: homes/.test(l)
        expect(claude && codex, `${name}: ${l}`).toBe(true)
      }
    }
  })

  // The real Claude Code never runs in the user's ~/.claude (#368): each suite that starts it has a home of its own (a
  // made-up API key, no prompt sent) or the signed-in test home, says which in suites.mjs, and starts its Combwork with it.
  it("every suite that starts the real Claude Code runs it in a test home, never the user's own (#368)", () => {
    const claudeSuites = (SUITES as { name: string; needs?: string[]; claudeHome?: string }[]).filter((s) => s.needs?.includes('claude'))
    expect(claudeSuites.length).toBeGreaterThan(5)
    for (const s of claudeSuites) {
      expect(['own', 'test'], s.name).toContain(s.claudeHome)
      const src = readFileSync(join(root, 'tests', 'e2e', `${s.name}.cjs`), 'utf8')
      // Its Combwork (every combworkEnv or lib.launch call) gets the home: lib's helper for it, CLAUDE_CONFIG_DIR given directly,
      // or the suite's `homes`.
      const launches = [...src.matchAll(/(?:combworkEnv|lib\.launch)\(\{[^\n]*\}\)/g)].map((m) => m[0])
      expect(launches.length, s.name).toBeGreaterThan(0)
      for (const l of launches) expect(/CLAUDE_CONFIG_DIR|ownClaudeHome|claudeHome\.env|env: homes/.test(l), `${s.name}: ${l}`).toBe(true)
      if (s.claudeHome === 'test') expect(src, s.name).toMatch(/CLAUDE_CONFIG_DIR: CLAUDE_TEST_HOME/)
      // A home of its own: lib's (a made-up key), or a folder of the suite's (claudehome, claudesettings); never the test home.
      if (s.claudeHome === 'own') {
        expect(src, s.name).toMatch(/ownClaudeHome\(|CLAUDE_CONFIG_DIR: home\b/)
        expect(src, s.name).not.toMatch(/CLAUDE_CONFIG_DIR: CLAUDE_TEST_HOME/)
      }
    }
    // The runner asks Claude Code about its test home's sign-in only, and refuses a Claude suite with no home.
    const runner = readFileSync(join(root, 'tests', 'e2e', 'run.mjs'), 'utf8')
    expect(runner).toMatch(/childEnv\(\{ CLAUDE_CONFIG_DIR: runContext\.CLAUDE_TEST_HOME \}\)/)
    expect(runner).not.toMatch(/claudeLoggedIn\(\s*'default'|home === 'test' \?/)
    expect(runner).toMatch(/s\.claudeHome !== 'own' && s\.claudeHome !== 'test'/)
  })

  it('every variable Hive sets for its sessions and its hive-progress wrapper is left out (#202)', () => {
    const src = ['src/main/progressReporters/wrapper.ts', 'src/main/progressReporters/shims.ts', 'src/main/ptyHost.ts', 'src/main/sessions.ts'].map((f) => readFileSync(join(root, f), 'utf8')).join('\n')
    const sessionVars = [...new Set([...src.matchAll(/\b((?:HIVE|CW)_[A-Z0-9_]+|ELECTRON_RUN_AS_NODE|NO_COLOR|FORCE_COLOR)\b/g)].map((m) => m[1]))]
    expect(sessionVars).toEqual(expect.arrayContaining(['CW_PROGRESS_WRAPPED', 'CW_PROGRESS_RUN_AS_NODE', 'CW_PROGRESS_DATA', 'CW_HOOK_TOKEN', 'CW_PROJECT']))
    const everywhere = Object.fromEntries(sessionVars.map((n) => [n, 'set']))
    const suite = ctx.suiteEnv({ name: 'x', runDir: 'C:\\w' }, everywhere)
    const hive = ctx.combworkEnv({ CW_USER_DATA: 'C:\\p' }, everywhere)
    const child = ctx.childEnv({}, everywhere)
    const contextSets = ['CW_USER_DATA', 'CW_TEST_QUIET', 'CW_TEST_TIPS', 'CW_API_PORT', 'CW_E2E_DIR', 'CW_E2E_PORT']
    for (const n of sessionVars.filter((x) => !contextSets.includes(x))) {
      expect(has(suite, n), `suite: ${n}`).toBe(false)
      expect(has(hive, n), `test Hive: ${n}`).toBe(false)
      expect(has(child, n), `child: ${n}`).toBe(false)
    }
    // And no Combwork session variable is ever allowlisted or passed on.
    for (const n of [...ctx.ALLOW, ...Object.keys(ctx.PASS_ENV)]) expect(/^(CW_(API|PROJECT|AGENT|WORKSPACE|SLOT|HOOK|PROVIDER|SESSION|RUN_ID|DIALECT|ROLE)|CW_PROGRESS(_(WRAPPED|RUN_AS_NODE|DATA))?$|ELECTRON|CLAUDE|ANTHROPIC|NO_COLOR|FORCE_COLOR)/.test(n), n).toBe(false)
  })

  it("a test Hive's environment: quiet, tips off, the suite's port and the carried run variables, then the suite's own", () => {
    const env = ctx.combworkEnv({ CW_USER_DATA: 'C:\\profile', CLAUDE_CONFIG_DIR: 'C:\\test-claude', CW_TEST_SLOW_IPC: undefined }, parent)
    expect(env).toMatchObject({ CW_USER_DATA: 'C:\\profile', CW_TEST_QUIET: '1', CW_TEST_TIPS: 'off', CW_API_PORT: '47950', E2E_RUN_SUITE: 'progressreport', E2E_RUN_DIR: 'C:\\lanes\\0', E2E_RUN_PORT: '47950', CLAUDE_CONFIG_DIR: 'C:\\test-claude', Path: parent.Path })
    for (const k of ['NO_COLOR', 'ELECTRON_RUN_AS_NODE', 'CW_API_TOKEN', 'CW_PROGRESS_WRAPPED', 'CW_TEST_SLOW_IPC', 'CW_E2E_NATIVE', 'CW_TEST_CODEX_HOME', 'ANTHROPIC_API_KEY']) expect(has(env, k), k).toBe(false)
    // CW_TEST_QUIET=0 for the run shows the copies; a suite's own setting wins.
    expect(ctx.combworkEnv({}, { ...parent, CW_TEST_QUIET: '0' }).CW_TEST_QUIET).toBe('0')
    expect(ctx.combworkEnv({ CW_TEST_QUIET: '0' }, parent).CW_TEST_QUIET).toBe('0')
    // A suite's variable replaces the allowlisted one in another case, rather than adding a second.
    const path = ctx.combworkEnv({ PATH: 'C:\\only' }, parent)
    expect(Object.keys(path).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH'])
    // Only what combworkEnv built starts a test Combwork (lib.cjs's _electron.launch): not a copy, not process.env.
    expect(ctx.isCombworkEnv(env)).toBe(true)
    expect(ctx.isCombworkEnv({ ...env })).toBe(false)
    expect(ctx.isCombworkEnv(process.env)).toBe(false)
  })

  it("a child that is part of Hive gets the allowlist and what it is given; nothing is passed that wasn't allowed", () => {
    const env = ctx.childEnv({ CW_API_URL: 'http://127.0.0.1:1', ELECTRON_RUN_AS_NODE: '1' }, parent)
    expect(Object.keys(env).sort()).toEqual(['CW_API_URL', 'ELECTRON_RUN_AS_NODE', 'LOCALAPPDATA', 'Path', 'SystemRoot', 'USERPROFILE', 'https_proxy'])
    expect(Object.keys(ctx.baseEnv(parent)).every((k) => ctx.ALLOW.includes(k.toUpperCase()))).toBe(true)
  })

  it("no child gets the user's Hives' hive-progress shims on its PATH: they run the installed Hive.exe (#1253)", () => {
    const shell = { APPDATA: 'C:\\Users\\x\\AppData\\Roaming', Path: 'C:\\Windows;C:\\Users\\x\\AppData\\Roaming\\Hive\\bin;C:\\tools;c:\\users\\x\\appdata\\roaming\\hive-dev\\bin\\;C:\\Users\\x\\AppData\\Roaming\\Hive\\bin-other' }
    for (const env of [ctx.baseEnv(shell), ctx.childEnv({}, shell), ctx.combworkEnv({ CW_USER_DATA: 'C:\\p' }, shell)]) {
      expect(env.Path).toBe('C:\\Windows;C:\\tools;C:\\Users\\x\\AppData\\Roaming\\Hive\\bin-other')
    }
  })

  it('every child the runners and the harness start themselves is given its environment, never left to inherit the shell (#208)', () => {
    // The runners, their modules, lib.cjs and the scenario harness run in the shell a person or an agent started them
    // from; a child_process call without env inherits all of it (GIT_DIR, NODE_OPTIONS…). The suites are left out:
    // their own environment is already the run context's (suiteEnv), and so is what their children inherit.
    const files = [
      ...readdirSync(dir).filter((f) => f.endsWith('.mjs') || f === 'lib.cjs').map((f) => join(dir, f)),
      ...readdirSync(join(__dirname, 'scenarios')).filter((f) => /\.(c|m)js$/.test(f)).map((f) => join(__dirname, 'scenarios', f))
    ]
    const found: string[] = []
    let calls = 0
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      for (const m of text.matchAll(/(?<![.\w])(spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\(/g)) {
        // The call's arguments, to its closing parenthesis.
        let depth = 0
        let end = m.index + m[0].length - 1
        for (; end < text.length; end++) {
          if (text[end] === '(') depth++
          else if (text[end] === ')' && --depth === 0) break
        }
        calls++
        if (!/\benv\s*:|\{\s*env\b|,\s*env\s*[,}]/.test(text.slice(m.index, end))) found.push(`${f.slice(root.length + 1)}:${text.slice(0, m.index).split('\n').length}`)
      }
    }
    expect(calls).toBeGreaterThan(20)
    expect(found).toEqual([])
  })

  it("a shell's GIT_DIR, GIT_WORK_TREE and NODE_OPTIONS reach neither the runners' git nor the build (#208)", () => {
    const tmp = tempDir('cw-shellenv-')
    const repo = (name: string, file: string) => {
      const d = join(tmp, name)
      mkdirSync(d)
      writeFileSync(join(d, file), 'x\n')
      const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: d, env: ctx.baseEnv(), encoding: 'utf8' })
      git('init', '-q')
      git('add', '.')
      git('commit', '-qm', name)
      return { d, head: git('rev-parse', 'HEAD').trim() }
    }
    const project = repo('project', 'a.txt')
    const decoy = repo('decoy', 'decoy.txt')
    writeFileSync(join(project.d, 'untracked.txt'), 'new\n')
    const req = createRequire(import.meta.url)
    const lib = req('./e2e/lib.cjs') as { git: (cwd: string, cmd: string | string[]) => string }
    const { sourceFingerprint } = req('./scenarios/harness.cjs') as { sourceFingerprint: (root: string) => { head: string; dirty: string | null } }
    const clean = { fp: fingerprint(project.d), scenario: sourceFingerprint(project.d) }
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, NODE_OPTIONS: process.env.NODE_OPTIONS }
    try {
      Object.assign(process.env, { GIT_DIR: join(decoy.d, '.git'), GIT_WORK_TREE: decoy.d, NODE_OPTIONS: `--require "${join(tmp, 'missing.cjs')}"` })
      // git follows them, from a shell that has them (so the check below means something).
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project.d, encoding: 'utf8' }).trim()).toBe(decoy.head)
      expect(fingerprint(project.d)).toBe(clean.fp)
      expect(fingerprint(project.d)).toMatch(new RegExp(`^${project.head.slice(0, 12)}\\+`))
      expect(sourceFingerprint(project.d)).toEqual(clean.scenario)
      expect(lib.git(project.d, ['rev-parse', 'HEAD']).trim()).toBe(project.head)
      expect(lib.git(project.d, 'rev-parse HEAD').trim()).toBe(project.head)
      // The build's command gets the allowlist: a Node with that NODE_OPTIONS wouldn't start at all.
      const out = join(tmp, 'build-env.json')
      writeFileSync(join(tmp, 'build.cjs'), `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))\n`)
      devBuild(project.d, { command: `"${process.execPath}" "${join(tmp, 'build.cjs')}"` })
      const env = JSON.parse(readFileSync(out, 'utf8')) as Env
      for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'NODE_OPTIONS']) expect(has(env, k), k).toBe(false)
      expect(has(env, 'PATH')).toBe(true)
      // And a failed build throws with its exit code.
      expect(() => devBuild(project.d, { command: `"${process.execPath}" -e "process.exit(3)"` })).toThrow(/exit 3/)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("the concurrency checker's temporary worktrees: each invocation's own (tempWorktrees.mjs, #207)", () => {
  const tmp = tempDir('cw-tempwt-')
  afterAll(() => {
    // Junctions first (rmdir removes only the link), as the module does.
    for (const base of readdirSync(tmp).filter((n) => n.startsWith('concurrency')))
      for (const run of readdirSync(join(tmp, base))) {
        const nm = join(tmp, base, run, 'worktree', 'node_modules')
        if (existsSync(nm)) execFileSync('cmd.exe', ['/c', 'rmdir', nm], { stdio: 'ignore', env: ctx.baseEnv() })
      }
    rmSync(tmp, { recursive: true, force: true })
  })
  const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', env: ctx.baseEnv() })
  /** A checkout with a commit, an uncommitted change, an untracked file and a node_modules (with electron, or not). */
  const checkout = (name: string, electron = true) => {
    const d = join(tmp, name)
    mkdirSync(join(d, 'node_modules', electron ? 'electron' : 'other'), { recursive: true })
    writeFileSync(join(d, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(d, 'a.txt'), 'one\n')
    git(d, 'init', '-q')
    git(d, 'add', '.')
    git(d, 'commit', '-qm', 'init')
    writeFileSync(join(d, 'a.txt'), 'two\n')
    writeFileSync(join(d, 'new.txt'), 'new\n')
    return d
  }
  const registered = (repo: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length - 1

  it('two invocations get folders of their own; removing one leaves the other\'s worktree, junction and registration', async () => {
    const repo = checkout('repo')
    const base = join(tmp, 'concurrency')
    const a = invocationDir({ base, owner: 101 })
    const b = invocationDir({ base, owner: 101 })
    expect(a).not.toBe(b)
    expect(JSON.parse(readFileSync(join(a, 'owner.json'), 'utf8'))).toMatchObject({ pid: 101 })
    const wa = addWorktree(repo, a, 'worktree')
    const wb = addWorktree(repo, b, 'worktree')
    expect(wa).not.toBe(wb)
    // Each is repo's HEAD with its uncommitted changes, sharing its node_modules.
    for (const w of [wa, wb]) {
      // (Line endings as the machine's git config checks files out.)
      expect(readFileSync(join(w, 'a.txt'), 'utf8')).toMatch(/^two\r?\n$/)
      expect(readFileSync(join(w, 'new.txt'), 'utf8')).toBe('new\n')
      expect(existsSync(join(w, 'node_modules', 'electron'))).toBe(true)
    }
    expect(registered(repo)).toBe(2)
    removeInvocation(repo, a)
    expect(existsSync(a)).toBe(false)
    expect(existsSync(join(wb, 'node_modules', 'electron')) && existsSync(join(wb, 'a.txt'))).toBe(true)
    expect(registered(repo)).toBe(1)
    // The junction went, never what it pointed to.
    expect(existsSync(join(repo, 'node_modules', 'electron'))).toBe(true)
    removeInvocation(repo, b)
    expect(registered(repo)).toBe(0)
  })

  it('a setup that fails part way leaves no worktree registered or folder behind, and nothing outside its folder is removed', () => {
    const repo = checkout('no-electron', false)
    const own = invocationDir({ base: join(tmp, 'concurrency2'), owner: 102 })
    expect(() => addWorktree(repo, own, 'worktree')).toThrow(/Couldn't link node_modules/)
    expect(registered(repo)).toBe(0)
    expect(existsSync(join(own, 'worktree'))).toBe(false)
    expect(existsSync(join(repo, 'node_modules', 'other'))).toBe(true)
    expect(() => removeWorktree(repo, own, join(tmp, 'repo'))).toThrow(/isn't in this checker's folder/)
  })

  it("the next checker removes a gone checker's folder (junction first), and leaves a live or kept one", () => {
    const repo = checkout('stale-repo')
    const base = join(tmp, 'concurrency3')
    const gone = invocationDir({ base, owner: 201 })
    const live = invocationDir({ base, owner: 202 })
    const kept = invocationDir({ base, owner: 203 })
    for (const d of [gone, live, kept]) addWorktree(repo, d, 'worktree')
    keepDir(kept)
    const alive = (pid: number) => pid === 202
    expect(removeStale(repo, { base, alive })).toEqual([gone])
    expect(existsSync(gone)).toBe(false)
    expect(existsSync(join(live, 'worktree', 'node_modules', 'electron')) && existsSync(join(kept, 'worktree', 'a.txt'))).toBe(true)
    expect(existsSync(join(repo, 'node_modules', 'electron'))).toBe(true)
    // Its registration is pruned in this checkout; the other two stay.
    expect(registered(repo)).toBe(2)
  })

  it('two checkers sweeping at once: a folder the other removes part way is passed over, never an error (#221)', () => {
    const repo = checkout('stale-race')
    const base = join(tmp, 'concurrency4')
    const first = invocationDir({ base, owner: 301 })
    const takenFromList = invocationDir({ base, owner: 302 })
    const takenAfterOwner = invocationDir({ base, owner: 303 })
    const live = invocationDir({ base, owner: 304 })
    const kept = invocationDir({ base, owner: 305 })
    for (const d of [first, takenFromList, takenAfterOwner, live, kept]) addWorktree(repo, d, 'worktree')
    keepDir(kept)
    // The other checker, as this one looks: it removes 302's folder (still in this sweep's list, so its owner can't be
    // read and the folder can't be dated), and 303's just after this sweep read its owner.
    const alive = (pid: number) => {
      if (pid === 301) removeInvocation(repo, takenFromList)
      if (pid === 303) removeInvocation(repo, takenAfterOwner)
      return pid === 304
    }
    expect(removeStale(repo, { base, alive })).toEqual([first])
    for (const d of [first, takenFromList, takenAfterOwner]) expect(existsSync(d), d).toBe(false)
    // The live and the kept one are untouched, and no junction was followed.
    expect(existsSync(join(live, 'worktree', 'node_modules', 'electron')) && existsSync(join(kept, 'worktree', 'a.txt'))).toBe(true)
    expect(existsSync(join(repo, 'node_modules', 'electron'))).toBe(true)
    expect(registered(repo)).toBe(2)
    // The other checker removed the whole base meanwhile: still nothing to stop for.
    expect(removeStale(repo, { base: join(tmp, 'concurrency-gone'), alive })).toEqual([])
  })
})

describe('e2e:concurrency checks a worktree was built once, whoever built it (builtOnce, #282)', () => {
  const since = Date.parse('2026-10-06T10:00:00Z')
  const fresh = { stamp: 'h', inputs: 'h' }
  it('these runs built it once, stamped as the source: right', () => {
    expect(builtOnce({ builds: 1, ...fresh, at: '2026-10-06T10:01:00Z', since }).ok).toBe(true)
  })
  it('two builds are wrong, whatever the stamp says', () => {
    expect(builtOnce({ builds: 2, ...fresh, at: '2026-10-06T10:01:00Z', since })).toEqual({ ok: false, why: '2 builds' })
  })
  it('none by these runs is right only when another runner stamped it during this round', () => {
    expect(builtOnce({ builds: 0, ...fresh, at: '2026-10-06T10:00:05Z', since }).ok).toBe(true)
    expect(builtOnce({ builds: 0, ...fresh, at: '2026-10-06T09:59:59Z', since }).ok).toBe(false)
    expect(builtOnce({ builds: 0, ...fresh, at: null, since }).ok).toBe(false)
  })
  it('a build not stamped, or stamped from other source, is wrong', () => {
    expect(builtOnce({ builds: 1, stamp: null, inputs: 'h', at: null, since }).ok).toBe(false)
    expect(builtOnce({ builds: 0, stamp: 'old', inputs: 'h', at: '2026-10-06T10:00:05Z', since }).ok).toBe(false)
  })
  it('the stamp says when it was made', () => {
    const w = tempDir('cw-stampat-')
    try {
      expect(buildStampedAt(w)).toBeNull()
      mkdirSync(join(w, 'out'), { recursive: true })
      writeFileSync(join(w, 'out', '.e2e-build.json'), JSON.stringify({ inputs: 'h', at: '2026-10-06T10:00:05.000Z' }))
      expect(buildStampedAt(w)).toBe('2026-10-06T10:00:05.000Z')
    } finally {
      rmSync(w, { recursive: true, force: true })
    }
  })
})

describe('the build lock: runners started together in one worktree build it once (build.mjs, #200)', () => {
  const tmp = tempDir('cw-buildlock-')
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
  const locks = join(tmp, 'locks')
  const buildMjs = pathToFileURL(join(dir, 'build.mjs')).href
  /** A worktree with a source file and no build. */
  const worktree = (name: string) => {
    const r = join(tmp, name)
    mkdirSync(join(r, 'src'), { recursive: true })
    writeFileSync(join(r, 'src', 'a.ts'), `${name}\n`)
    return r
  }
  /**
   * Another runner: a process of its own that calls ensureBuild on root, whose build takes ms and counts itself in
   * builds.txt. Resolves with its result.
   */
  const runner = (wt: string, { build = true, ms = 1500, fail = false } = {}) => {
    const script = `
      import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
      import { join } from 'path'
      const { ensureBuild } = await import(${JSON.stringify(buildMjs)})
      const root = ${JSON.stringify(wt)}
      try {
        const r = ensureBuild({ root, build: ${build}, lock: { dir: ${JSON.stringify(locks)}, pollMs: 50 }, runBuild: () => {
          appendFileSync(join(root, 'builds.txt'), 'b')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms})
          if (${fail}) throw new Error('build failed')
          mkdirSync(join(root, 'out', 'main'), { recursive: true })
          writeFileSync(join(root, 'out', 'main', 'index.js'), 'built')
        } })
        console.log(JSON.stringify(r))
      } catch (e) {
        console.log(JSON.stringify({ error: e.message }))
      }`
    return new Promise<{ stale?: boolean; built?: boolean; waited?: boolean; error?: string }>((resolve) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.on('close', () => resolve(JSON.parse(out.trim().split('\n').at(-1) || '{}')))
    })
  }
  const builds = (wt: string) => (existsSync(join(wt, 'builds.txt')) ? readFileSync(join(wt, 'builds.txt'), 'utf8').length : 0)

  it('two runners in one worktree with a stale build: one builds, the other waits and finds it fresh; another worktree builds at the same time', async () => {
    const a = worktree('a')
    const b = worktree('b')
    const results = await Promise.all([runner(a), runner(a), runner(b)])
    expect(builds(a)).toBe(1)
    expect(builds(b)).toBe(1)
    const inA = results.slice(0, 2)
    expect(inA.every((r) => r.stale === false)).toBe(true)
    expect(inA.filter((r) => r.built).length).toBe(1)
    expect(inA.find((r) => !r.built)?.waited).toBe(true)
    expect(results[2]).toMatchObject({ stale: false, built: true, waited: false })
    expect(buildStamp(a)).not.toBeNull()
    // Nothing left held.
    expect(readdirSync(locks)).toEqual([])
  }, 30_000)

  it('a runner that only checks waits while another builds, so it never looks at half a build', async () => {
    const c = worktree('c')
    const building = runner(c, { ms: 2000 })
    const t0 = Date.now()
    while (!readdirSync(locks).length && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20))
    const r = ensureBuild({ root: c, build: false, runBuild: () => undefined, lock: { dir: locks, pollMs: 50 } })
    expect(r).toMatchObject({ stale: false, waited: true })
    expect((await building).built).toBe(true)
  }, 30_000)

  it('a failed build lets go of the lock (the next runner builds); a lock whose runner is gone is broken', async () => {
    const d = worktree('d')
    expect((await runner(d, { fail: true, ms: 10 })).error).toMatch(/build failed/)
    expect(readdirSync(locks)).toEqual([])
    expect(buildStamp(d)).toBeNull()
    // A crashed runner's lock: its process is gone.
    const lock = buildLock(d, { dir: locks, owner: 999_999_999 })
    expect(lock.take()).toBe(false)
    const r = ensureBuild({ root: d, build: true, runBuild: () => { mkdirSync(join(d, 'out', 'main'), { recursive: true }); writeFileSync(join(d, 'out', 'main', 'index.js'), 'x') }, lock: { dir: locks, alive: (pid: number) => pid !== 999_999_999 } })
    expect(r).toMatchObject({ stale: false, built: true, waited: false })
    // One that crashed before writing its owner: broken once it is 30 s old.
    const held = buildLock(d, { dir: locks })
    mkdirSync(held.folder, { recursive: true })
    const old = new Date(Date.now() - 60_000)
    utimesSync(held.folder, old, old)
    expect(held.heldByOther()).toBe(false)
    expect(held.take()).toBe(false)
    held.release()
    expect(readdirSync(locks)).toEqual([])
  }, 30_000)
})

describe('heavy runs: at most a few at once on the machine, the rest queue in order (slots.mjs, #204)', () => {
  const tmp = tempDir('cw-slots-')
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
  let n = 0
  const newPool = () => join(tmp, `pool-${++n}`)
  const live = new Set([101, 102, 103, 104, 105, 106])
  const alive = (pid: number) => live.has(pid)
  let clock = 1_000_000
  const now = () => clock
  // Never the shell's agent session (its launch is asked about through the Agent API, #1008): these say what they test.
  const offline = { session: null, leftOver: async <T,>(h: T): Promise<T> => h, say: () => {} }
  const ask = (dir2: string, owner: number, more: object = {}) => trySlot(dir2, { slots: 2, owner, alive, now, what: `run ${owner}`, root: `C:/wt${owner}`, ...offline, ...more })

  it("how many at once (#589): the machine's config.json, CW_TEST_HEAVY_SLOTS over it, else 2, saying why in one line", () => {
    const folder = tempDir('cw-slots-config-')
    const file = join(folder, 'config.json')
    const lines: string[] = []
    const count = (env: Record<string, string> = {}) => heavySlots(env, file, (l: string) => lines.push(l))
    // No file: the default, said once however often it is asked.
    expect(count()).toBe(2)
    expect(count()).toBe(2)
    expect(lines).toEqual([`Test slots: 2 heavy runs at once, the default (${file}: there is none).`])
    // The file's count, read each time (an edit counts from the next run), BOM and other settings beside it are fine.
    writeFileSync(file, JSON.stringify({ heavySlots: 3 }))
    expect(count()).toBe(3)
    writeFileSync(file, '\uFEFF' + JSON.stringify({ other: true, heavySlots: 4 }))
    expect(count()).toBe(4)
    // The environment variable overrides it; a bad one is left out, said once.
    expect(count({ CW_TEST_HEAVY_SLOTS: '1' })).toBe(1)
    for (const bad of ['0', '-1', '1.5', 'x']) expect(count({ CW_TEST_HEAVY_SLOTS: bad })).toBe(4)
    expect(count({ CW_TEST_HEAVY_SLOTS: '' })).toBe(4)
    expect(lines.filter((l) => l.includes('CW_TEST_HEAVY_SLOTS'))).toHaveLength(4)
    // A bad file: the default, with the reason.
    lines.length = 0
    for (const [text, why] of [
      ['{ heavySlots: 3', "isn't JSON"],
      [JSON.stringify({ heavySlots: 0 }), 'heavySlots 0 isn\'t a whole number from 1'],
      [JSON.stringify({ heavySlots: '3' }), 'heavySlots "3" isn\'t a whole number from 1'],
      [JSON.stringify({ other: 1 }), 'no heavySlots in it']
    ]) {
      writeFileSync(file, text)
      expect(count(), text).toBe(2)
      expect(lines.at(-1), text).toContain(why)
    }
  })

  it('a heavy run: more than five suites or scenarios, or a repeat', () => {
    expect(isHeavy({ count: 5 })).toBe(false)
    expect(isHeavy({ count: 6 })).toBe(true)
    expect(isHeavy({ count: 1, repeat: 2 })).toBe(true)
    expect(parseArgs(['--all', '--no-wait'], names)).toMatchObject({ all: true, noWait: true })
    expect(parseArgs(['--all'], names)).toMatchObject({ noWait: false })
  })

  it('a heavy run started inside a suite waits for no slot, e2e or scenarios: its parent holds one (#211)', () => {
    const heavy = { count: 1, repeat: 2 }
    expect(needsSlot(heavy, {})).toBe(true)
    expect(needsSlot({ count: 3 }, {})).toBe(false)
    // In a suite's own environment, and in the agent shell of a test Combwork it started (which keeps only E2E_RUN_*).
    expect(needsSlot(heavy, { CW_E2E_PORT: '47950', E2E_RUN_SUITE: 'progressreport' })).toBe(false)
    expect(needsSlot(heavy, { E2E_RUN_SUITE: 'progressreport', E2E_RUN_DIR: 'C:\\lanes\\0', E2E_RUN_PORT: '47950' })).toBe(false)
    // Both runners ask slotPool (which asks needsSlot), never isHeavy alone (the scenario runner did, and queued behind
    // its parent), and wait only when it names a pool.
    for (const f of ['e2e/run.mjs', 'scenarios/run.mjs']) {
      const src = readFileSync(join(__dirname, f), 'utf8')
      expect(src, f).toMatch(/const pool = slotPool\(\{ kind: '(e2e|scenarios)', count: chosen\.length, repeat: \w+(\.repeat)?(, provider)? \}\)\r?\nif \(pool\) \{/)
      expect(src, f).not.toMatch(/\bisHeavy\b|\bneedsSlot\(/)
    }
    // A suite's nested heavy run has the suite's CPU credit; a real model's trial inside it still needs a model trial's
    // slot (HI-2070: only matching credit counts; "a resource-aware rule" below).
    expect(slotPool({ kind: 'scenarios', count: 1, repeat: 3, provider: 'fake' }, { E2E_RUN_SUITE: 'progressreport' })).toBeNull()
    expect(slotPool({ kind: 'scenarios', count: 1, repeat: 3, provider: 'codex' }, { E2E_RUN_SUITE: 'progressreport' })).toBe('model')
  })

  it('a full unit run is heavy; a focused one, or watch mode, is not (#599)', () => {
    const full = (args: string[], cfg: object = {}) => isFullUnitRun({ args, ...cfg })
    // npm test, and the whole set with options whose values aren't file filters.
    expect([full(['run']), full([]), full(['run', '--reporter', 'verbose']), full(['run', '--maxWorkers=2', '--reporter=dot'])]).toEqual([true, true, true, true])
    // Some files, some tests, the changed or related files, a shard or a project, watch mode: light.
    expect([full(['run', 'tests/tips.test.ts']), full(['run', 'tips']), full(['run', '-t', 'rounds']), full(['run', '--changed', '3317ffa']), full(['run', '--changed']), full(['run', '--shard=1/3']), full(['--watch'])]).toEqual([false, false, false, false, false, false, false])
    // What Vitest resolved says the same, however the command line put it.
    expect([full(['run'], { watch: true }), full(['run'], { changed: true }), full(['run'], { related: ['src/a.ts'] }), full(['run'], { testNamePattern: /x/ })]).toEqual([false, false, false, false])
    // The unit tests' global setup asks it, with a run started inside a suite left out (its parent's slot counts it).
    const setup = readFileSync(join(__dirname, 'unitSlot.ts'), 'utf8')
    expect(setup).toMatch(/if \(heldCredit\(\)\.has\('cpu'\) \|\| !isFullUnitRun\(/)
    expect(readFileSync(join(__dirname, '..', 'vitest.config.ts'), 'utf8')).toMatch(/globalSetup: \[[^\]]*'tests\/unitSlot\.ts'/)
  })

  it("a holder left over by a session that ended is named so in the wait line, and nothing is stopped (#1008)", async () => {
    // The claim records the agent's launch the run was started in, from its shell's variables.
    const session = { CW_PROJECT: 'hive', CW_AGENT: 'HB2', CW_RUN_ID: 'run-old', CW_WORKSPACE: 'D:/ws' }
    expect(runOwner(session)).toEqual({ project: 'hive', agent: 'HB2', run: 'run-old', workspace: 'D:/ws' })
    expect([runOwner({}), runOwner({ CW_PROJECT: 'hive', CW_AGENT: 'HB2' })]).toEqual([undefined, undefined])
    const dir2 = newPool()
    expect(await ask(dir2, 101, { what: 'e2e: 196 suites', root: 'D:/wt/hb2', session: runOwner(session) })).toEqual({ slot: 0 })
    const claim = JSON.parse(readFileSync(join(dir2, 'slot-0.json'), 'utf8'))
    expect(claim.owner).toEqual({ project: 'hive', agent: 'HB2', run: 'run-old', workspace: 'D:/ws' })
    expect(await ask(dir2, 102)).toEqual({ slot: 1 })
    // Combwork answers for the launch, asked with the waiting run's own session and in the holder's workspace.
    const asked: { url: string; workspace: string | null }[] = []
    const api = (running: boolean | 'down') => async (url: string, init: { headers: Record<string, string> }) => {
      asked.push({ url, workspace: init.headers['X-Combwork-Workspace'] ?? null })
      if (running === 'down') throw new Error('ECONNREFUSED')
      return { ok: true, json: async () => ({ running }) }
    }
    // The session's token in its file (HI-2262: sessions never get CW_API_TOKEN).
    const tokenFile = join(tmp, 'launch-token.json')
    writeFileSync(tokenFile, JSON.stringify({ token: 't' }))
    const env = { CW_API_URL: 'http://127.0.0.1:47821/', CW_API_TOKEN_FILE: tokenFile, CW_PROJECT: 'web', CW_AGENT: 'W1', CW_RUN_ID: 'run-new' }
    expect(await launchEnded(claim.owner, env, { fetch: api(false) })).toBe(true)
    expect(asked[0]).toEqual({ url: 'http://127.0.0.1:47821/v1/projects/hive/agents/HB2/launches/run-old', workspace: 'D%3A%2Fws' })
    expect(await launchEnded(claim.owner, env, { fetch: api(true) })).toBe(false)
    // It can't say: Combwork not answering, no API here, or a claim with no owner (a run started outside an agent).
    expect(await launchEnded(claim.owner, env, { fetch: api('down') })).toBeNull()
    expect(await launchEnded(claim.owner, {}, { fetch: api(false) })).toBeNull()
    expect(await launchEnded(undefined, env, { fetch: api(false) })).toBeNull()
    // Asked again only after askMs; the answer is kept meanwhile.
    let calls = 0
    let ended = true
    const check = leftOverCheck({ env, askMs: 30_000, now, ended: async () => (calls++, ended) })
    const held = [claim, JSON.parse(readFileSync(join(dir2, 'slot-1.json'), 'utf8'))]
    expect((await check(held)).map((c: { leftOver?: boolean }) => !!c.leftOver)).toEqual([true, false])
    ended = false
    clock += 10_000
    expect((await check(held))[0].leftOver).toBe(true)
    clock += 30_000
    expect((await check(held))[0].leftOver).toBeUndefined()
    expect(calls).toBe(2)
    // The wait line names it as left over; the slot stays its own, and its process isn't touched.
    clock += 41 * 60_000
    const looks: { holders: { pid: number; leftOver?: boolean }[] }[] = []
    const said: string[] = []
    const r = await waitForSlot(dir2, { slots: 2, owner: 103, alive, now, wait: false, root: 'D:/wt/hb2', session: null, leftOver: leftOverCheck({ env, now, ended: async (o: { run: string }) => o.run === 'run-old' }), say: (l: string) => said.push(l) })
    looks.push(r.refused)
    const line = waitLine(r.refused, 2)
    expect(line).toContain('held by e2e: 196 suites in D:/wt/hb2, left over from a session that ended (process 101, ')
    expect(line).toMatch(/; run 102 in C:\/wt102 \(process 102, /)
    expect(looks[0].holders.find((c) => c.pid === 102)?.leftOver).toBeUndefined()
    expect(existsSync(join(dir2, 'slot-0.json')) && live.has(101)).toBe(true)
    // A run in the same worktree says so as it starts (the agent, resumed, may want its results); another worktree's doesn't.
    expect(said).toEqual(['Still running in this worktree, left over from a session that ended: e2e: 196 suites in D:/wt/hb2 (process 101, 42 min). Its results may still be wanted; to stop it, stop its process by id (never by name).'])
    expect(leftOverLine([{ ...claim, leftOver: true }], 'D:/wt/other', clock)).toBe('')
    expect(leftOverLine([claim], 'D:/wt/hb2', clock)).toBe('')
  })

  it('two take the slots; the others wait in the order they asked, and the first to ask gets the next free one', async () => {
    const dir2 = newPool()
    expect(await ask(dir2, 101)).toEqual({ slot: 0 })
    expect(await ask(dir2, 102)).toEqual({ slot: 1 })
    clock += 10
    const third = await ask(dir2, 103)
    expect(third).toMatchObject({ ahead: 0 })
    expect((third as { holders: { pid: number }[] }).holders.map((c) => c.pid).sort()).toEqual([101, 102])
    clock += 10
    expect(await ask(dir2, 104)).toMatchObject({ ahead: 1 })
    // 101 finishes: 104 looks first, but 103 asked earlier and gets the slot.
    rmSync(join(dir2, 'slot-0.json'))
    expect(await ask(dir2, 104)).toMatchObject({ ahead: 1 })
    expect(await ask(dir2, 103)).toEqual({ slot: 0 })
    expect(await ask(dir2, 104)).toMatchObject({ ahead: 0 })
    expect(readdirSync(dir2).filter((f) => f.startsWith('wait-'))).toEqual(['wait-104.json'])
  })

  it("a crashed run's slot, and its place in the queue, expire", async () => {
    const dir2 = newPool()
    await ask(dir2, 101)
    await ask(dir2, 102)
    await ask(dir2, 103)
    live.delete(102)
    live.delete(103)
    try {
      expect(await ask(dir2, 104)).toEqual({ slot: 1 })
      expect(readdirSync(dir2).sort()).toEqual(['slot-0.json', 'slot-1.json'])
    } finally {
      live.add(102)
      live.add(103)
    }
  })

  it('--no-wait: refused at once with who holds the slots, leaving no place in the queue', async () => {
    const dir2 = newPool()
    await ask(dir2, 101)
    await ask(dir2, 102)
    const r = await waitForSlot(dir2, { slots: 2, owner: 103, alive, now, ...offline, wait: false })
    expect(r.refused?.holders.map((c: { pid: number }) => c.pid).sort()).toEqual([101, 102])
    expect(readdirSync(dir2).some((f) => f.startsWith('wait-'))).toBe(false)
    expect(describeClaim({ pid: 101, at: clock - 3 * 60_000, what: 'e2e: 68 suites', root: 'D:/wt' }, clock)).toBe('e2e: 68 suites in D:/wt (process 101, 3 min)')
  })

  it('waiting: says so at each look, and takes the slot once one is let go', async () => {
    const dir2 = newPool()
    const first = await waitForSlot(dir2, { slots: 1, owner: 101, alive, now, ...offline })
    const seen: number[] = []
    const second = waitForSlot(dir2, { slots: 1, owner: 102, alive, now, ...offline, pollMs: 30, onWait: (r: { holders: { pid: number }[] }) => seen.push(r.holders[0].pid) })
    // At least two looks while the slot is held, however slow the machine is.
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(1), { timeout: 10000 })
    expect(new Set(seen)).toEqual(new Set([101]))
    first.release()
    const got = await second
    expect(got.slot).toBe(0)
    // It waited through those looks and says how long.
    expect(got.waitedMs).toBeGreaterThan(0)
    got.release()
    expect(readdirSync(dir2).filter((f) => f.endsWith('.json'))).toEqual([])
  })

  it('a pre-merge run goes first (#558): it takes the next free slot before two that asked earlier, and says so', async () => {
    const dir2 = newPool()
    await ask(dir2, 101)
    await ask(dir2, 102)
    clock += 10
    expect(await ask(dir2, 103)).toMatchObject({ ahead: 0 })
    clock += 10
    expect(await ask(dir2, 104)).toMatchObject({ ahead: 1 })
    clock += 10
    // The merge slot holder's run asks last and is next in line; the others move back one.
    const merging = await ask(dir2, 105, { first: true })
    expect(merging).toMatchObject({ ahead: 0 })
    expect(waitLine({ ...(merging as { holders: object[]; ahead: number }), first: true }, 2)).toMatch(/^Waiting for a test slot \(2 heavy runs at once on this machine, CW_TEST_HEAVY_SLOTS\), pre-merge, next in line: held by run 101 in C:\/wt101 /)
    expect(await ask(dir2, 103)).toMatchObject({ ahead: 1 })
    expect(await ask(dir2, 104)).toMatchObject({ ahead: 2 })
    // A second pre-merge run queues behind the first, still ahead of the others.
    clock += 10
    const second = await ask(dir2, 106, { first: true })
    expect(second).toMatchObject({ ahead: 1 })
    expect(waitLine({ ...(second as { holders: object[]; ahead: number }), first: true }, 2)).toMatch(/, pre-merge, 1 pre-merge ahead of this one: held by/)
    // 101 finishes: 103 looks first, but the pre-merge run gets the slot. 102 keeps its own: no run is stopped.
    rmSync(join(dir2, 'slot-0.json'))
    expect(await ask(dir2, 103)).toMatchObject({ ahead: 2 })
    expect(await ask(dir2, 105, { first: true })).toEqual({ slot: 0 })
    expect(readdirSync(dir2).filter((f) => f.startsWith('slot-')).sort()).toEqual(['slot-0.json', 'slot-1.json'])
    // Holding it, others waiting name it as a pre-merge run.
    expect(describeClaim(JSON.parse(readFileSync(join(dir2, 'slot-0.json'), 'utf8')), clock)).toBe('run 105 (pre-merge) in C:/wt105 (process 105, 0 min)')
    expect(await ask(dir2, 106, { first: true })).toMatchObject({ ahead: 0 })
  })

  it("a crashed pre-merge run's place expires: the run that asked first takes the slot", async () => {
    const dir2 = newPool()
    await ask(dir2, 101)
    await ask(dir2, 102)
    clock += 10
    await ask(dir2, 103)
    clock += 10
    expect(await ask(dir2, 105, { first: true })).toMatchObject({ ahead: 0 })
    live.delete(105)
    try {
      rmSync(join(dir2, 'slot-1.json'))
      expect(await ask(dir2, 103)).toEqual({ slot: 1 })
      expect(readdirSync(dir2).some((f) => f.startsWith('wait-'))).toBe(false)
    } finally {
      live.add(105)
    }
  })

  it("the merge slot holder's run: asked of Hive with the session's own variables; anything else is an ordinary run", async () => {
    // The token from its file, as hive-progress reads it (HI-2262: never CW_API_TOKEN).
    const sessionToken = join(tmp, 'session-token.json')
    writeFileSync(sessionToken, JSON.stringify({ token: 'tok' }))
    const session = { CW_API_URL: 'http://127.0.0.1:1/', CW_API_TOKEN_FILE: sessionToken, CW_PROJECT: 'hive', CW_AGENT: 'HB4', CW_WORKSPACE: 'D:/ws' }
    const calls: { url: string; init: RequestInit }[] = []
    const answer = (body: unknown, ok = true) =>
      (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return { ok, json: async () => body }
      }) as unknown as typeof fetch
    const holder = (name: string, kind = 'agent') => ({ holder: { kind, name } })
    expect(await holdsMergeSlot(session, { fetch: answer(holder('HB4')) })).toBe(true)
    expect(calls[0].url).toBe('http://127.0.0.1:1/v1/projects/hive/merge-slot')
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer tok', 'X-Combwork-Workspace': encodeURIComponent('D:/ws') })
    expect(await holdsMergeSlot(session, { fetch: answer(holder('HB1')) })).toBe(false)
    expect(await holdsMergeSlot(session, { fetch: answer(holder('HB4', 'user')) })).toBe(false)
    expect(await holdsMergeSlot(session, { fetch: answer({ holder: null }) })).toBe(false)
    expect(await holdsMergeSlot(session, { fetch: answer(holder('HB4'), false) })).toBe(false)
    const refused = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    expect(await holdsMergeSlot(session, { fetch: refused })).toBe(false)
    // Not a Combwork agent's session: Combwork isn't asked.
    const asked = calls.length
    for (const k of ['CW_API_URL', 'CW_PROJECT', 'CW_AGENT', 'CW_API_TOKEN_FILE']) expect(await holdsMergeSlot({ ...session, [k]: '' }, { fetch: answer(holder('HB4')) }), k).toBe(false)
    expect(calls.length).toBe(asked)
    // CW_API_TOKEN alone is no session's (HI-2262): Combwork isn't asked; beside the file, the file's is sent.
    expect(await holdsMergeSlot({ ...session, CW_API_TOKEN_FILE: '', CW_API_TOKEN: 'tok' }, { fetch: answer(holder('HB4')) })).toBe(false)
    expect(calls.length).toBe(asked)
    expect(await holdsMergeSlot({ ...session, CW_API_TOKEN: 'other' }, { fetch: answer(holder('HB4')) })).toBe(true)
    expect(calls.at(-1)!.init.headers).toMatchObject({ Authorization: 'Bearer tok' })
  })

  it('--pre-merge goes first without asking; otherwise Hive is asked again at most every 30 s while the run waits', async () => {
    expect(parseArgs(['--all', '--pre-merge'], names)).toMatchObject({ preMerge: true })
    expect(parseArgs(['--all'], names)).toMatchObject({ preMerge: false })
    let asks = 0
    let holds = false
    let t = 0
    const flagged = preMerge(true, { holds: async () => (asks++, false) })
    expect(await flagged()).toBe(true)
    expect(asks).toBe(0)
    const first = preMerge(false, { holds: async () => (asks++, holds), now: () => t, askMs: 30_000 })
    expect(await first()).toBe(false)
    holds = true
    t += 29_000
    expect(await first()).toBe(false)
    t += 1_000
    expect(await first()).toBe(true)
    expect(asks).toBe(2)
  })

  it('waiting: a run that becomes pre-merge while it waits moves to the front at its next look', async () => {
    const dir2 = newPool()
    const holding = await waitForSlot(dir2, { slots: 1, owner: 101, alive, now, ...offline })
    expect(await trySlot(dir2, { slots: 1, owner: 103, alive, now, ...offline })).toMatchObject({ ahead: 0 })
    clock += 10
    const looks: { ahead: number; first: boolean }[] = []
    let goesFirst = false
    const merging = waitForSlot(dir2, { slots: 1, owner: 105, alive, now, ...offline, pollMs: 20, first: async () => goesFirst, onWait: (r: { ahead: number; first: boolean }) => looks.push(r) })
    await vi.waitFor(() => expect(looks.at(-1)).toMatchObject({ ahead: 1, first: false }), { timeout: HUNG_MS })
    goesFirst = true
    await vi.waitFor(() => expect(looks.at(-1)).toMatchObject({ ahead: 0, first: true }), { timeout: HUNG_MS })
    holding.release()
    const got = await merging
    expect(got.slot).toBe(0)
    got.release()
    rmSync(join(dir2, 'wait-103.json'))
  })

  it("the side slot, model trials and the small-run bound (HI-2070): beside heavySlots in config.json, the environment over the first two, else their defaults, saying why", () => {
    const folder = tempDir('cw-slots-side-')
    const file = join(folder, 'config.json')
    const lines: string[] = []
    const read = (env: Record<string, string> = {}) => slotSettings(env, file, (l: string) => lines.push(l))
    expect(read()).toEqual({ side: 1, models: 2, small: { e2eSuites: 3, e2eRepeat: 3, scenarioRuns: 5 } })
    expect(lines).toEqual([])
    writeFileSync(file, '\uFEFF' + JSON.stringify({ heavySlots: 2, sideSlots: 0, modelTrials: 3, smallRun: { e2eSuites: 2, scenarioRuns: 8 } }))
    expect(read()).toEqual({ side: 0, models: 3, small: { e2eSuites: 2, e2eRepeat: 3, scenarioRuns: 8 } })
    expect(read({ CW_TEST_SIDE_SLOTS: '2', CW_TEST_MODEL_TRIALS: '1' })).toMatchObject({ side: 2, models: 1 })
    expect(read({ CW_TEST_MODEL_TRIALS: '0' }).models).toBe(3)
    expect(lines).toEqual(['Test slots: CW_TEST_MODEL_TRIALS="0" isn\'t a whole number from 1; it is left out.'])
    writeFileSync(file, JSON.stringify({ sideSlots: -1, modelTrials: 'two', smallRun: { e2eRepeat: 0 } }))
    expect(read()).toEqual({ side: 1, models: 2, small: { e2eSuites: 3, e2eRepeat: 3, scenarioRuns: 5 } })
    expect(lines.slice(1)).toEqual([
      `Test slots: sideSlots -1 in ${file} isn't a whole number from 0; 1, the default.`,
      `Test slots: modelTrials "two" in ${file} isn't a whole number from 1; 2, the default.`,
      `Test slots: smallRun.e2eRepeat 0 in ${file} isn't a whole number from 1; 3, the default.`
    ])
  })

  it('which slot a run takes (HI-2070): small within the bound, heavy past it, model trials of any size, none for a light run', () => {
    const small = { e2eSuites: 3, e2eRepeat: 3, scenarioRuns: 5 }
    const pool = (run: object) => slotPool(run, {}, small)
    // Light: no slot, as before.
    expect([pool({ kind: 'e2e', count: 3 }), pool({ kind: 'scenarios', count: 5, provider: 'fake' })]).toEqual([null, null])
    // Small: a few suites repeated a few times, a few fake scenario runs in all.
    expect([pool({ kind: 'e2e', count: 1, repeat: 3 }), pool({ kind: 'e2e', count: 3, repeat: 2 }), pool({ kind: 'scenarios', count: 1, repeat: 5, provider: 'fake-copilot' })]).toEqual(['small', 'small', 'small'])
    // Heavy: past it.
    expect([pool({ kind: 'e2e', count: 4, repeat: 2 }), pool({ kind: 'e2e', count: 1, repeat: 4 }), pool({ kind: 'e2e', count: 196 }), pool({ kind: 'scenarios', count: 2, repeat: 3, provider: 'fake' }), pool({ kind: 'scenarios', count: 151, provider: 'fake' })]).toEqual(['heavy', 'heavy', 'heavy', 'heavy', 'heavy'])
    // A real model's run is a model trial, a single scenario too.
    expect([pool({ kind: 'scenarios', count: 1, provider: 'claude-code' }), pool({ kind: 'scenarios', count: 3, repeat: 3, provider: 'codex' }), pool({ kind: 'scenarios', count: 151, provider: 'codex' })]).toEqual(['model', 'model', 'model'])
  })

  it('a small run takes the side slot while two heavy runs hold theirs, else a heavy one; a heavy run never takes it (HI-2070)', async () => {
    const dir2 = newPool()
    const take = (owner: number, pool: string) => ask(dir2, owner, { pool, side: 1 })
    expect(await take(101, 'heavy')).toEqual({ slot: 0 })
    expect(await take(102, 'heavy')).toEqual({ slot: 1 })
    // A heavy run waits, the side slot free.
    clock += 10
    const heavy = await take(103, 'heavy')
    expect(heavy).toMatchObject({ ahead: 0, pool: 'heavy' })
    expect(existsSync(join(dir2, 'side-0.json'))).toBe(false)
    // A small run takes it, though the heavy run asked first; another small one then waits for whichever frees first.
    expect(await take(104, 'small')).toEqual({ slot: 0, pool: 'side' })
    expect(JSON.parse(readFileSync(join(dir2, 'side-0.json'), 'utf8'))).toMatchObject({ pid: 104, pool: 'side' })
    clock += 10
    const second = await take(105, 'small')
    expect(second).toMatchObject({ pool: 'small' })
    expect((second as { holders: { pid: number; pool: string }[] }).holders.map((c) => [c.pid, c.pool])).toEqual([[104, 'side'], [101, 'heavy'], [102, 'heavy']])
    // A heavy slot freed: the heavy run that asked first takes it, not the small run behind it.
    rmSync(join(dir2, 'slot-0.json'))
    expect(await take(105, 'small')).toMatchObject({ pool: 'small' })
    expect(await take(103, 'heavy')).toEqual({ slot: 0 })
    // The side slot freed: the small run takes it; the next heavy run still waits for a heavy slot.
    rmSync(join(dir2, 'side-0.json'))
    expect(await take(105, 'small')).toEqual({ slot: 0, pool: 'side' })
    expect(await take(106, 'heavy')).toMatchObject({ ahead: 0, pool: 'heavy' })
    // No side slot (sideSlots 0): a small run queues for the heavy slots, behind the heavy run that asked first, as before.
    clock += 10
    expect(await ask(dir2, 107, { pool: 'small', side: 0 })).toMatchObject({ ahead: 1, holders: [{ pool: 'heavy' }, { pool: 'heavy' }] })
    // waitForSlot lets the side slot go by its own file.
    const dir3 = newPool()
    const got = await waitForSlot(dir3, { pool: 'small', slots: 2, side: 1, owner: 101, alive, now, ...offline })
    expect([got.slot, got.pool, readdirSync(dir3)]).toEqual([0, 'side', ['side-0.json']])
    got.release()
    expect(readdirSync(dir3).filter((f) => f.endsWith('.json'))).toEqual([])
  })

  it('a resource-aware rule for nested runs (HI-2070): only the credit of the kind of slot the parent holds counts', () => {
    const small = { e2eSuites: 3, e2eRepeat: 3, scenarioRuns: 5 }
    const pool = (run: object, env: Record<string, string>) => slotPool(run, env, small)
    const heavyE2e = { kind: 'e2e', count: 196 }
    const trial = { kind: 'scenarios', count: 3, repeat: 3, provider: 'codex' }
    // What each kind of parent gives what it starts: an e2e suite CPU credit (always, as before: #211), a model trial
    // model credit, and each passes on what it was given.
    expect([...heldCredit({})]).toEqual([])
    expect([...heldCredit({ E2E_RUN_SUITE: 'progressreport' })]).toEqual(['cpu'])
    expect(creditFor('cpu', {})).toBe('cpu')
    expect(creditFor('model', {})).toBe('model')
    expect(creditFor('model', { E2E_RUN_SLOTS: 'cpu' })).toBe('cpu,model')
    expect(creditFor(null, {})).toBe('')
    expect(creditFor(null, { E2E_RUN_SLOTS: 'model' })).toBe('model')
    // Inside a model trial (its test Combwork's session): heavy CPU work asks for a CPU slot, a nested trial is covered.
    const inTrial = { E2E_RUN_SUITE: 'real-model-parent', E2E_RUN_PORT: '47950', E2E_RUN_SLOTS: creditFor('model', {}) }
    expect([pool(heavyE2e, inTrial), pool({ kind: 'e2e', count: 1, repeat: 3 }, inTrial), pool(trial, inTrial)]).toEqual(['heavy', 'small', null])
    // Inside an e2e suite: CPU work is covered (waiting for its parent's slot would never end), a model trial isn't.
    const inSuite = { E2E_RUN_SUITE: 'progressreport', E2E_RUN_PORT: '47950', E2E_RUN_SLOTS: creditFor('cpu', {}) }
    expect([pool(heavyE2e, inSuite), pool(trial, inSuite)]).toEqual([null, 'model'])
    // Inside a model trial inside an e2e suite: both covered.
    const both = { ...inSuite, E2E_RUN_SLOTS: creditFor('model', inSuite) }
    expect([pool(heavyE2e, both), pool(trial, both)]).toEqual([null, null])
    // An empty credit (a light top-level run's): nothing is covered, even with the suite's marker carried.
    expect([pool(heavyE2e, { E2E_RUN_SUITE: 'x', E2E_RUN_SLOTS: '' }), pool(trial, { E2E_RUN_SUITE: 'x', E2E_RUN_SLOTS: '' })]).toEqual(['heavy', 'model'])
    // The runners pass it on: the e2e runner to each suite, the scenario runner into its test Hives (CARRIED).
    const runContext = createRequire(import.meta.url)('./e2e/runContext.cjs') as { CARRIED: string[]; suiteEnv: (o: object, parent: object) => Record<string, string> }
    expect(runContext.CARRIED).toContain('E2E_RUN_SLOTS')
    expect(runContext.suiteEnv({ name: 's', runDir: 'C:/x', slots: 'cpu,model' }, {}).E2E_RUN_SLOTS).toBe('cpu,model')
    expect(runContext.suiteEnv({ name: 's', runDir: 'C:/x' }, {}).E2E_RUN_SLOTS).toBe('')
    // Each runner passes on what it holds and was given, never a kind it doesn't hold (HR2's round 2).
    expect(readFileSync(join(__dirname, 'e2e', 'run.mjs'), 'utf8')).toContain('slots: creditFor(pool) })')
    expect(readFileSync(join(__dirname, 'e2e', 'run.mjs'), 'utf8')).not.toMatch(/creditFor\('cpu'\)/)
    expect(readFileSync(join(__dirname, 'scenarios', 'run.mjs'), 'utf8')).toMatch(/process\.env\.E2E_RUN_SLOTS = creditFor\(pool\)/)
    expect(readFileSync(join(__dirname, 'scenarios', 'run.mjs'), 'utf8')).toMatch(/ensureBuildWithSlot\(\{[\s\S]{0,120}needsSlot: buildNeedsCpuSlot\(\{ provider, pool \}\),\s+takeSlot: takeBuildSlot/)
  })

  it("composed (HI-2070, HR2's round 2): a light run passes on only what it was given; a model parent's light e2e run's suite gives its heavy child no CPU credit", () => {
    const runContext = createRequire(import.meta.url)('./e2e/runContext.cjs') as { suiteEnv: (o: object, parent: object) => Record<string, string> }
    const small = { e2eSuites: 3, e2eRepeat: 3, scenarioRuns: 5 }
    // What the e2e runner does: its pool from slotPool, then each suite's environment from suiteEnv with creditFor(pool).
    const e2eRun = (run: object, env: Record<string, string>) => {
      const pool = slotPool({ kind: 'e2e', ...run }, env, small)
      return { pool, suite: runContext.suiteEnv({ name: 'inner', port: 48950, runDir: 'C:/x', slots: creditFor(pool, env) }, env) }
    }
    // A model trial's test Combwork session (the scenario runner's creditFor('model'), carried into it).
    const trialSession = { E2E_RUN_SUITE: 'real-model-parent', E2E_RUN_PORT: '47950', E2E_RUN_SLOTS: creditFor('model', {}) }
    const light = e2eRun({ count: 1 }, trialSession)
    expect(light.pool).toBeNull()
    expect(light.suite.E2E_RUN_SLOTS).toBe('model')
    // Its suite's heavy grandchild asks for a CPU slot, and so does a full unit run there; a nested trial is covered.
    expect(slotPool({ kind: 'e2e', count: 196 }, light.suite, small)).toBe('heavy')
    expect(heldCredit(light.suite).has('cpu')).toBe(false)
    expect(slotPool({ kind: 'scenarios', count: 1, provider: 'codex' }, light.suite, small)).toBeNull()
    // A light top-level run mints no credit either; a heavy one gives its suites CPU credit, as before (#211).
    expect(e2eRun({ count: 2 }, {}).suite.E2E_RUN_SLOTS).toBe('')
    expect(slotPool({ kind: 'e2e', count: 196 }, e2eRun({ count: 2 }, {}).suite, small)).toBe('heavy')
    const heavy = e2eRun({ count: 196 }, {})
    expect([heavy.pool, heavy.suite.E2E_RUN_SLOTS, slotPool({ kind: 'e2e', count: 196 }, heavy.suite, small)]).toEqual(['heavy', 'cpu', null])
    // Inside a CPU parent's suite, a model trial's light e2e run passes CPU credit on, with model credit from the trial.
    expect(e2eRun({ count: 1 }, { E2E_RUN_SLOTS: 'cpu,model', E2E_RUN_SUITE: 'x' }).suite.E2E_RUN_SLOTS).toBe('cpu,model')
  })

  it("a real model's trial's build takes a CPU slot unless it holds or runs inside one (HI-2070): only a stale build, looked at once no other runner builds", async () => {
    // Which trials: by the credit after its own slot, whether it took a model slot or one it runs inside covers it.
    expect(buildNeedsCpuSlot({ provider: 'codex', pool: 'model' }, {})).toBe(true)
    expect(buildNeedsCpuSlot({ provider: 'codex', pool: null }, { E2E_RUN_SUITE: 'x', E2E_RUN_SLOTS: 'model' })).toBe(true)
    expect(buildNeedsCpuSlot({ provider: 'claude-code', pool: null }, { E2E_RUN_SUITE: 'x', E2E_RUN_SLOTS: 'cpu,model' })).toBe(false)
    expect(buildNeedsCpuSlot({ provider: 'codex', pool: 'model' }, { E2E_RUN_SUITE: 'x', E2E_RUN_SLOTS: 'cpu' })).toBe(false)
    // A fake run's build is covered as its run is.
    expect([buildNeedsCpuSlot({ provider: 'fake', pool: null }, {}), buildNeedsCpuSlot({ provider: 'fake-codex', pool: 'small' }, {})]).toEqual([false, false])
    // The order of what happens: a fake ensureBuild (its answers in turn) and a slot that records when it is held.
    const run = async (slotNeeded: boolean, answers: { stale: boolean; waited?: boolean }[]) => {
      const steps: string[] = []
      let held = false
      const ensure = ({ build }: { build: boolean }) => {
        steps.push(`${build ? 'build' : 'look'}${held ? ' (slot held)' : ''}`)
        return { built: build, why: null, waited: false, ...answers.shift()! }
      }
      const takeSlot = async () => {
        steps.push('slot')
        held = true
        return { release: () => ((held = false), steps.push('release')) }
      }
      const result = await ensureBuildWithSlot({ root: 'C:/wt', runBuild: () => {}, needsSlot: slotNeeded, takeSlot, ensure })
      return { steps, result, held }
    }
    // Model credit only, a stale build: it takes the slot, builds holding it, and lets it go.
    expect(await run(true, [{ stale: true }, { stale: false }])).toMatchObject({ steps: ['look', 'slot', 'build (slot held)', 'release'], held: false })
    // A build that became needed while it waited out another runner's (the look waits for the build lock): the same.
    expect((await run(true, [{ stale: true, waited: true }, { stale: false }])).steps).toEqual(['look', 'slot', 'build (slot held)', 'release'])
    // Current once looked at: no slot, no build.
    expect(await run(true, [{ stale: false }])).toMatchObject({ steps: ['look'], result: { stale: false } })
    // CPU credit with model credit: the build is covered: as before, no slot taken.
    expect((await run(false, [{ stale: false }])).steps).toEqual(['build'])
    // The slot is let go when the build throws too.
    const failing = { steps: [] as string[] }
    await expect(
      ensureBuildWithSlot({
        root: 'C:/wt',
        runBuild: () => {},
        needsSlot: true,
        takeSlot: async () => ({ release: () => failing.steps.push('release') }),
        ensure: ({ build }: { build: boolean }) => {
          if (build) throw new Error('build failed')
          return { stale: true }
        }
      })
    ).rejects.toThrow('build failed')
    expect(failing.steps).toEqual(['release'])
  })

  it('an e2e run on the side slot runs at most two suites at once (HI-2070)', () => {
    expect(SIDE_E2E_JOBS).toBe(2)
    expect(readFileSync(join(__dirname, 'e2e', 'run.mjs'), 'utf8')).toMatch(/if \(got\.pool === 'side' && jobs > SIDE_E2E_JOBS\) \{[\s\S]{0,200}jobs = SIDE_E2E_JOBS/)
  })

  it("a real model's trial waits only on its own cap, never for the CPU slots (HI-2070)", async () => {
    const dir2 = newPool()
    // Both heavy slots and the side slot held: a model trial takes one of its own at once.
    await ask(dir2, 101)
    await ask(dir2, 102)
    expect(await ask(dir2, 103, { pool: 'small', side: 1 })).toEqual({ slot: 0, pool: 'side' })
    expect(await ask(dir2, 104, { pool: 'model', models: 2 })).toEqual({ slot: 0, pool: 'model' })
    expect(await ask(dir2, 105, { pool: 'model', models: 2 })).toEqual({ slot: 1, pool: 'model' })
    // A third waits for a model trial's slot, naming only those; the CPU slots' queue doesn't count it.
    clock += 10
    const third = await ask(dir2, 106, { pool: 'model', models: 2 })
    expect(third).toMatchObject({ ahead: 0, pool: 'model' })
    expect((third as { holders: { pid: number }[] }).holders.map((c) => c.pid)).toEqual([104, 105])
    rmSync(join(dir2, 'slot-0.json'))
    expect(await ask(dir2, 107)).toEqual({ slot: 0 })
    rmSync(join(dir2, 'model-1.json'))
    expect(await ask(dir2, 106, { pool: 'model', models: 2 })).toEqual({ slot: 1, pool: 'model' })
  })

  it('the wait names what is ahead, by whose run, never as if it were its own (HI-2070)', () => {
    const at = clock - 12 * 60_000
    const hb6 = { pid: 101, at, what: 'scenarios: 151 (fake)', root: 'D:/wt/hb6', pool: 'heavy', owner: { project: 'hive', agent: 'HB6', run: 'r6' } }
    const hb4 = { pid: 102, at, what: 'e2e: 4 suites × 5', root: 'D:/wt/hb4', pool: 'heavy', owner: { project: 'hive', agent: 'HB4', run: 'r4' } }
    const side = { pid: 103, at, what: 'e2e: 1 suites × 3', root: 'D:/wt/term', pool: 'side' }
    expect(waitSummary({ holders: [hb6, hb4], ahead: 0, pool: 'heavy' })).toBe("waiting for a test slot (2 heavy runs ahead: HB6's scenarios: 151 (fake), HB4's e2e: 4 suites × 5)")
    expect(waitSummary({ holders: [side, hb6, hb4], ahead: 2, pool: 'small' })).toBe("waiting for a test slot (1 small run and 2 heavy runs ahead: e2e: 1 suites × 3 in D:/wt/term, HB6's scenarios: 151 (fake), HB4's e2e: 4 suites × 5; 2 more waiting first)")
    expect(waitSummary({ holders: [{ ...hb6, pool: 'model', what: 'scenarios: 3 (codex) × 3' }], pool: 'model' })).toBe("waiting for a model-trial slot (1 model-trial run ahead: HB6's scenarios: 3 (codex) × 3)")
    expect(waitSummary({ holders: [], pool: 'heavy' })).toBe('waiting for a test slot (runs just finishing)')
    // The runner's own line: the heavy one as before; a small run's and a model trial's say what they can take.
    const settings = { side: 1, models: 2, small: { e2eSuites: 3, e2eRepeat: 3, scenarioRuns: 5 } }
    expect(waitLine({ holders: [hb6], ahead: 0 }, 2)).toMatch(/^Waiting for a test slot \(2 heavy runs at once on this machine, CW_TEST_HEAVY_SLOTS\): held by scenarios: 151 \(fake\) in D:\/wt\/hb6 /)
    expect(waitLine({ holders: [side, hb6], ahead: 1, pool: 'small' }, 2, settings)).toMatch(/^Waiting for a test slot \(a small run: 1 side and 2 heavy slots on this machine, sideSlots and heavySlots\), 1 ahead of this one: held by e2e: 1 suites × 3 in D:\/wt\/term /)
    expect(waitLine({ holders: [], ahead: 0, pool: 'model' }, 2, settings)).toBe('Waiting for a model-trial slot (2 real-model trials at once on this machine, modelTrials): held by runs just finishing.')
    expect(refusedLine({ holders: [hb6], pool: 'model' }, 2, settings)).toMatch(/^No model-trial slot free \(--no-wait\): 2 real-model trials at once on this machine, modelTrials, held by scenarios: 151/)
    expect(refusedLine({ holders: [hb6] }, 2)).toMatch(/^No test slot free \(--no-wait\): 2 heavy runs at once on this machine, CW_TEST_HEAVY_SLOTS, held by scenarios: 151/)
  })
})

describe("a suite's git waits out the Hive under test's own (lib.git, #199)", () => {
  type Git = (cwd: string, cmd: string | string[], opts?: { timeoutMs?: number }) => string
  const { git, GIT_LOCKED, baseEnv } = createRequire(import.meta.url)('./e2e/lib.cjs') as { git: Git; GIT_LOCKED: RegExp; baseEnv: () => NodeJS.ProcessEnv }
  const repo = tempDir('cw-gitlock-')
  afterAll(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init -q -b main')
  git(repo, ['config', 'user.email', 't@t'])
  git(repo, ['config', 'user.name', 't'])
  const lock = join(repo, '.git', 'index.lock')
  /**
   * Creates index.lock, as another git would. On a busy Windows the last lock can still be on its way out (a scanner
   * has it open), and creating it again fails with EPERM until it has gone (#298): wait for that, not a fixed time.
   */
  const takeLock = () => {
    const t0 = Date.now()
    for (;;) {
      try {
        return writeFileSync(lock, '')
      } catch (e) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '') || Date.now() - t0 > 10_000) throw e
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      }
    }
  }
  /** Another process (the Combwork under test's git status) holding index.lock for ms, then letting go. */
  const holdLock = (ms: number) => {
    takeLock()
    spawn(process.execPath, ['-e', `setTimeout(() => require('fs').rmSync(${JSON.stringify(lock)}, { force: true }), ${ms})`], { stdio: 'ignore' })
  }
  /**
   * Windows refusing to create index.lock for ms, as it does while the last one is still being deleted (#298): an
   * access rule on .git that denies creating files, which another process lifts after ms.
   */
  const user = userInfo().username
  const denyLock = (ms: number) => {
    execFileSync('icacls', [join(repo, '.git'), '/deny', `${user}:(WD)`], { stdio: 'pipe', env: baseEnv() })
    spawn(process.execPath, ['-e', `setTimeout(() => require('child_process').execFileSync('icacls', [${JSON.stringify(join(repo, '.git'))}, '/remove:d', ${JSON.stringify(user)}], { stdio: 'ignore' }), ${ms})`], { stdio: 'ignore', env: baseEnv() })
  }
  afterAll(() => void execFileSync('icacls', [join(repo, '.git'), '/remove:d', user], { stdio: 'pipe', env: baseEnv() }))

  it('a write while another git holds index.lock waits for it, then runs', () => {
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    holdLock(600)
    const t0 = Date.now()
    git(repo, 'add -A')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('a.txt')
    holdLock(300)
    git(repo, 'commit -q -m "a"')
    expect(git(repo, 'log --oneline').trim()).toMatch(/ a$/)
  })

  it("a lock Windows won't create yet (Permission denied, while the last one is deleted) is waited out too (#298)", () => {
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    denyLock(600)
    const t0 = Date.now()
    git(repo, 'add -A')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('b.txt')
    git(repo, 'commit -q -m "b"')
  })

  it("knows git's lock messages, and only those", () => {
    for (const held of [
      "fatal: Unable to create 'C:/t/.git/index.lock': File exists.",
      "fatal: Unable to create 'C:/t/.git/index.lock': Permission denied",
      "fatal: Unable to create 'C:/t/.git/refs/heads/main.lock': Permission denied",
      'Another git process seems to be running in this repository'
    ])
      expect(GIT_LOCKED.test(held), held).toBe(true)
    for (const other of ["error: open(\"a.txt\"): Permission denied", "fatal: Unable to create 'C:/t/.git/index.lock': Is a directory", "fatal: not a git repository"]) expect(GIT_LOCKED.test(other), other).toBe(false)
  })

  it('a lock that stays is an error after the timeout; any other failure throws at once', () => {
    takeLock()
    try {
      expect(() => git(repo, 'add -A', { timeoutMs: 300 })).toThrow(/index\.lock/)
    } finally {
      rmSync(lock, { force: true })
    }
    const t0 = Date.now()
    expect(() => git(repo, 'no-such-command')).toThrow(/not a git command/)
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('the suites that write to a repository while their Hive runs use it', () => {
    for (const s of ['agents', 'agents-ui', 'resume', 'inbox', 'unmerged', 'paneheader']) expect(readFileSync(join(dir, `${s}.cjs`), 'utf8'), s).toMatch(/= \([^)]*\) => lib\.git\(/)
  })
})
