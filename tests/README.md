# Tests

Unit tests (Vitest) are the `*.test.ts` files here: `npm test`, or `npx vitest run <file>` for one. The end-to-end
suites are in [e2e](e2e/README.md) and the agent-behaviour scenarios in [scenarios](scenarios/README.md). Helpers:
`tempDir()` (`tempDir.ts`) for a test's folders, `pathAliases.ts` for another name for one, `noGlobalGit.ts` (unit
tests run git with no global config, as CI does), `cliHomes.ts` (each test file gets empty Claude Code, Codex and
Copilot homes, never the user's, whatever the shell sets: HI-1703), `loggerListeners.ts` (takes off the process
listeners a test's fresh load of the logger added: HI-1728), and `electron-stub.ts` standing in for `electron`.

**The test area** is `%LOCALAPPDATA%\combwork-test` (`testArea.cjs`): the test profiles, the signed-in Claude Code and
Codex test homes, the scenario baselines and results, the e2e lanes and logs, the Sandbox reports and the runs' temp
folders. Before 1.1 it had the old name: `npm run test:move-area` (`moveTestArea.mjs`, HI-2590) moves it once, one way,
at a time no test runs, keeping the sign-ins and rewriting the trust entries that name it; `-- --dry-run` says what it
would do. Until then, and while a move is unfinished (run it again: it resumes), every test run refuses to start. It
ends by printing the Defender lines that exclude the new folder and drop the old one (PowerShell, as administrator).
It also converts the scenario benchmarks saved before 1.1 (the baselines and each run's `benchmark.json`) to 1.1's
names, after the move or run again once the area is moved (`convertBenchmarks.mjs`, HI-2605): the schema
name and the two call measures that HI-2591 renamed, nothing else. Performance →
Compare reads only the new names. It refuses while a scenario run is going on, and keeps each original, byte for byte,
in `benchmark-schema-backup` in the test area: remove it by hand once Compare reads them.

Test runs' temp folders are in the test area, `%LOCALAPPDATA%\combwork-test\tmp` (#992), not `%TEMP%`: Combwork's Antivirus
scanning setting covers the test area, and thousands of folders made and removed in `%TEMP%` kept Defender busy.
`tempDir()` makes them there, and `vitest.config.ts` makes it the run's temp folder (`TEMP`, `TMP`, `TMPDIR`) too, so
Vitest's own copies of the modules, Combwork's code under test and the programs tests start (git) put theirs there. The e2e
and scenario runners do the same for their suites (HI-2102: Playwright's `playwright-artifacts-*`, the test copies of
Combwork, the CLIs), and remove theirs as they exit (an e2e run with `--record` keeps it). Each run has its own folder
there, `run-<pid>-<random>` (`runTemp.mts`), and a run's start removes those older than a day whose run has ended, as the board's evidence rules allow
(`e2e/evidence.cjs`: nothing an open card cites, nothing while the board can't be read). A
unit run's is removed once the run has ended (`tempRun.ts`, #995), with whatever Combwork's code wrote
late; and every folder `tempDir()` makes is removed when its test file ends (`tempCleanup.ts`), after the file's own
`afterAll` hooks, so a run doesn't grow as it goes: close what holds files in it (watchers, services, processes) in the
test or its hooks, or the run warns that it was left behind. `npm run test:clean` and the e2e and scenario runners sweep what is older than a day (e2e/README.md,
Housekeeping). Off Windows, with no `LOCALAPPDATA`, they are in the temp folder.

A test run outlives the session that started it when Combwork closes or the agent restarts (#1008). A heavy run's runner
says as it starts when one of this worktree's runs was left over that way (`Still running in this worktree, left over
from a session that ended: …`), and a waiting run names it in its wait line. For a run that isn't heavy, look for a
`node` whose command line has this worktree's path (`Get-CimInstance Win32_Process`), and stop it by its process id,
never by name.

Two tests in `agentProcesses.test.ts` start the Microsoft Store's PowerShell 7 (the `WindowsApps` alias): the one that
adopts what it runs (#543) and the one that follows it before it joins its package's job (#678). They are skipped
unless `CW_TEST_STORE_PWSH=1` is set (#1027). Run from a Store PowerShell, which is every Codex agent's shell, they can
end that shell and every other Store PowerShell on the PC, other agents' commands included; why is #1056. Opt in only
where no one else's Store PowerShell runs (a Windows Sandbox, or a machine of your own with no Codex agents running).

## Isolation: never alone, never the shell's (moved from AGENTS.md, HI-2013)

Tests never assume they're alone on the machine or inherit their shell.
- What a run uses of its own comes from the run context (`e2e/runContext.cjs`, `lanes.mjs`, `build.mjs`): environments
  from an allowlist (`lib.combworkEnv()` for a test Combwork, `lib.childEnv()` for the combwork MCP server or `cw-progress`), a
  lane's ports and folders, the CLI test homes, and the dev build under a lock per worktree.
- Never build a child's environment from `process.env`. Give every child the runners, `lib.cjs` or the harness start
  themselves an `env` (`runContext.baseEnv()` for git and the build), so a shell's `GIT_DIR` or `NODE_OPTIONS` can't
  reach it (unit tests fail); a setting a run must pass on goes in `PASS_ENV`.
- After changing the runner, `lib.cjs`, the run context or the scenario harness, run `npm run e2e:concurrency` (and
  `-- --heavy` after changing `slots.mjs`).
- At most two heavy runs (a full or `--repeat` e2e run, more than five scenarios, a full unit run) go at once on the
  machine (`heavySlots` in `%LOCALAPPDATA%\combwork-test\config.json` changes it, for the whole machine: e2e/README.md): a
  third waits, not hung, printing who holds the slots ("e2e: waiting for a test slot" in Progress; `--no-wait` fails at
  once).
- Temp folders come from `tempDir()`, by long, real paths, in `%LOCALAPPDATA%\combwork-test\tmp`, never under
  `os.tmpdir()` (a unit test fails): CI's is the 8.3 form `C:\Users\RUNNER~1\…` and Combwork compares real paths, so such
  tests failed on CI only. Another name for a folder comes from `pathAliases.ts`: `junction()` works on any machine,
  `shortPath()` only where the volume makes 8.3 names.
- Unit tests run git with none of the shell's `GIT_*` variables (`cleanGitEnv.ts`) and no global config, as CI does
  (`noGlobalGit.ts`): a test whose Combwork code commits or merges sets its repository's own `user.name` and `user.email`.
- e2e suites use `lib.cjs` and work under `%LOCALAPPDATA%\combwork-test\e2e` (each runner's suites in its lane's
  `lanes\<k>\<suite>`, so runners in different worktrees don't collide), never the real clipboard, profile or
  `~/.codex`.
- Probes of your own (scripts, screenshots, profiles outside a suite) and redirected output take a new folder each run,
  from `lib.probeDir()` (in `combwork-test\scratch`) or your scratchpad, never in the lanes or logs, the project, a worktree
  or beside one (the worktrees' parent folder), or a project's `.codex`, `.claude` or `.agents` (a stray `.codex` with a
  reviewer's probe stopped every Codex agent's commands, #509; logs left beside worktrees outlived them). The runners
  prune what tests leave in `combwork-test`, keeping what an open card cites by path (`npm run test:clean`, e2e/README.md
  Housekeeping).

## Tests wait for conditions, never for time

Every test, unit or end-to-end, new or changed, follows these rules. Each one was a flaky test in 0.6.0, failing on a
loaded or slower machine and passing on the one it was written on (#457, #459, #466, #477, #516, #518, #519, #522).
Anyone who clones the repository must get the same results, on any machine and under any load.

- **Wait for what you expect to see, not for a length of time.** Poll the observable state until it holds:
  `lib.until(fn, ms)` in the e2e suites and scenarios, `vi.waitFor(fn)` or `expect.poll(fn)` in unit tests. Say what
  is awaited in the check's name or the failure message. Never `sleep()` and then check, and never read UI or state
  once just after an action that changes it: a click, an IPC call, a hook, a file write, a git command.
- **A timeout bounds a hung run, and never makes a test pass.** Make it generous, and name or explain it. Raising a
  timeout isn't a fix: a change that raises one says why, in the code and on the card.
- **Every wait states its bound** (#570). No `vi.waitFor`, `expect.poll` or `until` is left to its default (Vitest's
  1 s is a time budget under load; until's 10 s is a default nobody chose): each passes a named bound for a hung run,
  `HUNG_MS` (10–30 s) in the file, as `until(fn, HUNG_MS)` or `{ timeout: HUNG_MS }`. A bound under 5 s is a time
  budget, so it needs a comment saying why it is short: a retry's pace (press again if this one was lost), or a quiet
  period that is the point of the check (nothing comes within it).
- **Wait for Combwork to settle, not for a quiet spell.** Watches and loop wakes finish their work in the background (a
  delivery a comment started, the settle before a wake, the check that a typed wake was taken). In unit tests,
  `await watches.settled()` (and `await loopWakes.settled()`, which waits for both) resolves once nothing of theirs is
  in flight; check after it, never straight after `evaluateWatches` or `tryLoopWakes`, and never after a short sleep.
- **No test depends on another's leftovers.** Each test sets up and removes its own state: folders, git worktrees,
  processes, settings, environment variables. It passes alone, in any order, and when run twice.
- **Processes are ended by identity, never by a remembered pid** (#603). Windows gives a pid to a new process soon
  after its last one ends, so `process.kill(pid)` on a pid read earlier can end another run's process (a Vitest worker
  then exits with code 1), and `taskkill /T` follows parent ids that may be stale. Take a process's identity while it is
  known to be yours (`identify` in `tests/e2e/folderProcesses.cjs`, also on `lib`), check it with `stillSame`, and end
  it with `endExactly` or `endTreeExactly` (which take that identity, never a pid: a root that is another process by
  now ends nothing) or `stopProcessesIn`; a `ChildProcess` you hold and that hasn't exited, with `endChildTree` or its
  own `kill()`.
  `tests/folderProcesses.test.ts` fails on a `process.kill` of a pid or a `taskkill` in the tests or scripts.
- **Tests pass under load.** The full suites run beside other runs (up to two heavy runs on a machine by default, the
  e2e runner's test slots, which a full unit run takes too, and focused unit runs beside them). Before calling a test done, run it under that load, not only
  alone. A machine can be set to take more or fewer heavy runs in `%LOCALAPPDATA%\combwork-test\config.json` (`heavySlots`;
  [e2e](e2e/README.md), "How many heavy runs at once"); a test must pass with any number of them.

A sleep that is the point of the test is fine: checking that something does *not* happen within a period, pacing
keystrokes, a fake standing in for a slow CLI. Say so in a comment beside it. Something that is truly waited for with
a sleep, where nothing can be observed, is the exception: say why in the comment.

**`npm run test:waits`** (`scripts/testWaits.mjs`) checks waits and sleeps a branch adds or changes since main
(uncommitted and new files too; `-- --base <ref>` chooses another base, and cards targeting an integration branch
pass that branch, for example `npm run test:waits -- --base 1.1.0`). It finds waits that state no bound of their
own, or one under 5 s with no comment, and sleeps that a check follows within three lines with no comment beside or
above saying why. A change anywhere in a multiline wait counts, including removing its timeout. Existing findings
are left to the full audit (HI-2491), so unrelated cards can run this lean builder check. It exits 1 when there is a
new or changed finding, and 2 when it can't compare (no `main`, a bad `--base`, git failing): nothing was
checked, so that isn't a pass. Only the first check after a sleep counts, and the sleep is let through only when that
check itself waits (`until`, `waitFor`, `poll`): a wait in a later check doesn't cover an earlier one. A short sleep
needs its comment like a long one. A pause inside a loop that polls state is the loop's way of
waiting for its condition, so it isn't counted: one whose `while` (or `do…while`) condition reads state, or whose body
leaves on an `if` with `break` or `return`, with the check after the loop. A loop that only repeats actions (a counted
`for`, `for…of`, a `while` on a count or a clock) is no poll: a sleep in it before a check, inside the loop or after
it, is found like any other. What it can't see: a single read with no sleep before it, a sleep more than three
lines before its check, and a wait under another helper's name; and a comment counts as the reason whatever it says.
Reviewers look for those and judge the reasons. `-- --all` lists every such wait and sleep in the tests, the older
ones too (the backlog in #524's audit); it is a report and exits 0. Builders run the default check before Review, and reviewers fail a new or changed test that sleeps and then
checks, reads state once after an action, or raises a timeout with no stated reason.

A test that flakes anyway is investigated with the `investigate-flake` skill (`.claude/skills`, `.agents/skills`).

## Which test owns what: retired duplicates and their owners (HI-2663)

HI-2627's inventory marked six areas SLIM: cut repeated execution before coverage, retire no whole area, and keep the
safety cases (loss of work, crash ownership, storage and settings races, file corruption). HI-2663 audited each area
(every candidate read on both sides) and retired a check only once it had named the test that still owns it; any check
only the retired one made was moved into that owner first. Read this table before adding a check like one of these: its
owner is where it goes. **Measured** times are suite runs before (the full run of 6 Nov, run-20261106-141513) and after
(run-20261107-021625 at 26211c113, the same suites; the machine was loaded, so a few seconds either way is noise);
**estimated** ones are smaller than that noise.

The waits found along the way cost more than any duplicate: `lib.until` now says a wait of 10 s or more that ran out
(`WAIT ran out after … at <suite:line>`), and each run and its record list them per suite. HI-2688 sweeps the rest.

| Area | Retired, or trimmed | Its assertions' owner now | Time saved |
|---|---|---|---|
| Notifications and UI; usage and logging | 14 waits that ran out unchecked: `status === 'ready'` after a turn (a fake's is then `finished`: `lib.agentIdle`), a board wait on pane toolbars that stay mounted, an option found by a CSS selector | the same checks, now waiting for what they meant | **measured**: consolewindow 266 → 33 s, consoletext 130 → 18 s, notifytarget 219 → 190 s |
| Guidance and scenarios | 86 scenarios run on the fake Claude Code only, 16 as model trials only, the rest on all three fakes (`scenarios/fakeScope.cjs`) | each id's owner in HI-2663's ownership matrix (on the card); per-CLI delivery: the scenarios kept on all three, `tool-sweep` for the tools only fake-alone scenarios call, codex.test.ts, carryingon.cjs, copilot.test.ts, copilot.cjs | **projected** about 73 min per three-provider fake pass (152.7 → about 80 min, from the 6 Nov per-scenario times), until comparable runs confirm it |
| Test harness | the runner's second process listing after each suite | `stopProcessesIn` takes `endCopies`' listing when nothing was ended; listed again after an ending (each still by pid and start time) | **measured** per listing 0.9–1.0 s: about 1 s a suite, ~6 min of the runner's thread per full set |
| Test harness | `failfast.cjs` | `windowsExits.test.ts`: the reporting it checked, and its one real-child check (0xc0000142, Windows only) | **measured** 1 s, one suite slot |
| Repository guards | `i18nGuard.test.ts`'s scan of the whole source against its merge base | `node scripts/i18nGuard.mjs` (check:repo, CI's `i18n:guard`), which now also fails on CI without a merge base, the test's one extra assertion | **measured** about 11 s a full unit run, and one per change to `src/` it picked |
| Git and the merge queue | `mergestrict.cjs` (S55's strict part) | `p5lane` Lane A (strict's update, carried, both trailers, the slot untouched, notUpToDate, resumed), with mergestrict's two checks moved there (the update ref dropped; the Work section's hunks, the card's side first); `queueStrict.test.ts` | **measured** 22 s |
| Workflow and lanes | `p7lane`'s part C (everyone in the project folder with the pool) | `reviewerpool` section 2, with its checks moved there (no slot lent, the builder's and the reviewer's folder); `reviewcopies` (a Codex reviewer's copy at the revision) | estimated 15–20 s |
| Usage and progress | `progresstabs`' real one-minute wait for the "long" lane wait | the same rendered transition, the window's clock moved on past the bound (`page.clock`); `laneBar.test.ts` the bound's arithmetic | **measured** 154 → 97 s |
| Usage and progress | `progressreport`'s late total, `--check` with no command, and `CW_PROGRESS=0` runs | `progressReport.test.ts` (late total once, `--check lint` exit 2, `progressTarget` off) and `progress.test.ts` | **measured** 239 → 185 s |
| Notifications and UI | `tips`' "none after a reload" | `tips.test.ts` ("shows one a day"), and the suite's own #295 check (the same start path) | estimated 7 s |
| Workflow and lanes | `p6rules`' G1b (two reviewers' quorum) | `tests/workflow/scenarios.git.test.ts` S57(c); in the app with Combwork merging, `p7lane`'s pool | estimated 6 s |
| Git and the merge queue | `mergequeue`'s options moved to the agent merge during a check | `queuecard`'s "old rules" (Work section, Git tab history), `progressqueue` | estimated 5 s |
| Git and the merge queue | `queuecontrols`' Pause and Resume over IPC | `progressqueue` (the window's Pause and Resume), `queuecard`, `queuePause.test.ts` | estimated 5 s |
| Git and the merge queue | `gitview`'s project without git | `versioncontrol` (None: Workflow only, no Initialise, and now no status bar item), `gitinit` | estimated 3 s |

**Kept, unchanged** (each audited; one line for why):
- **Workflow, board and lanes**: suites share their setup (start, submit, review, merge), but each one's assertions are its own. The splits are recorded in their headers. The card-loop and wake suites differ in trigger, recipient and stall. `slotrecovery` and `lanebrief` (restart and ownership) stay.
- **Git, locks and the merge queue**: these stay as the safety and boundary cases:
  - `mergequeuecrash` and `queueupgrade` (crash seams);
  - `queuelease` (takeover);
  - `repolock` and `lockask`;
  - `slotrelease`, `slotwriterhold` and the slot repair suites;
  - `gitcleanup`, `unusedwt` and `unusedslots` (loss of work).

  Kept but tentative, so not touched: `p5lane` Lane B, `mergequeuecrash`'s terminal part and `slotsessions`' restart step.
- **Usage, performance and logging**: the metrics retention and cap arithmetic and their suites, and `performance`, `perftable` and `perfcompare`. The rest of `progressreport` stays (the shims, card defaults, nested Combwork).
- **Notifications, navigation and UI**: the geometry and window suites (`tipcorner`, `tabstrip`, `rail`, `narrowmain`, `windows`…), `notifyonce` and `inbox`. They have no unit equivalent.
- **Guidance and scenarios**: 52 scenarios stay on all three fakes:
  - per-CLI skill delivery and reading, launch guidance and modes;
  - the shell, typed lines, hooks, slots and copies;
  - loss of work and settings.

  Model trials (HI-2655) are unchanged.
- **Test harness and guards**: every guard that is a rule's only owner (`tests/README.md`'s Isolation rules, e2esuites' suite and seam lists, focusedPick, checkRepo, line endings, control characters, temp folders, quiet copies, process identity, no shell starts), `isolation`, `harnessleftovers` and `scenarioteardown`. The upkeep left is HI-2689.

**Release pass only:** an area whose code, callers and dependencies didn't change runs in the release pass, and in a focused run when its code changes (`--affected`, HI-2659). Nothing above moved a test out of the release pass.
