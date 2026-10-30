# Tests

Unit tests (Vitest) are the `*.test.ts` files here: `npm test`, or `npx vitest run <file>` for one. The end-to-end
suites are in [e2e](e2e/README.md) and the agent-behaviour scenarios in [scenarios](scenarios/README.md). Helpers:
`tempDir()` (`tempDir.ts`) for a test's folders, `pathAliases.ts` for another name for one, `noGlobalGit.ts` (unit
tests run git with no global config, as CI does), `cliHomes.ts` (each test file gets empty Claude Code, Codex and
Copilot homes, never the user's, whatever the shell sets: HI-1703), `loggerListeners.ts` (takes off the process
listeners a test's fresh load of the logger added: HI-1728), and `electron-stub.ts` standing in for `electron`.

Test runs' temp folders are in the test area, `%LOCALAPPDATA%\hive-test\tmp` (#992), not `%TEMP%`: Hive's Antivirus
scanning setting covers the test area, and thousands of folders made and removed in `%TEMP%` kept Defender busy.
`tempDir()` makes them there, and `vitest.config.ts` makes it the run's temp folder (`TEMP`, `TMP`, `TMPDIR`) too, so
Vitest's own copies of the modules, Hive's code under test and the programs tests start (git) put theirs there. The e2e
and scenario runners do the same for their suites (HI-2102: Playwright's `playwright-artifacts-*`, the test copies of
Hive, the CLIs), and remove theirs as they exit (an e2e run with `--record` keeps it). Each run has its own folder
there, `run-<pid>-<random>` (`runTemp.mts`), and a run's start removes those older than a day whose run has ended, as the board's evidence rules allow
(`e2e/evidence.cjs`: nothing an open card cites, nothing while the board can't be read). A
unit run's is removed once the run has ended (`tempRun.ts`, #995), with whatever Hive's code wrote
late; and every folder `tempDir()` makes is removed when its test file ends (`tempCleanup.ts`), after the file's own
`afterAll` hooks, so a run doesn't grow as it goes: close what holds files in it (watchers, services, processes) in the
test or its hooks, or the run warns that it was left behind. `npm run test:clean` and the e2e and scenario runners sweep what is older than a day (e2e/README.md,
Housekeeping). Off Windows, with no `LOCALAPPDATA`, they are in the temp folder.

A test run outlives the session that started it when Hive closes or the agent restarts (#1008). A heavy run's runner
says as it starts when one of this worktree's runs was left over that way (`Still running in this worktree, left over
from a session that ended: …`), and a waiting run names it in its wait line. For a run that isn't heavy, look for a
`node` whose command line has this worktree's path (`Get-CimInstance Win32_Process`), and stop it by its process id,
never by name.

Two tests in `agentProcesses.test.ts` start the Microsoft Store's PowerShell 7 (the `WindowsApps` alias): the one that
adopts what it runs (#543) and the one that follows it before it joins its package's job (#678). They are skipped
unless `HIVE_TEST_STORE_PWSH=1` is set (#1027). Run from a Store PowerShell, which is every Codex agent's shell, they can
end that shell and every other Store PowerShell on the PC, other agents' commands included; why is #1056. Opt in only
where no one else's Store PowerShell runs (a Windows Sandbox, or a machine of your own with no Codex agents running).

## Isolation: never alone, never the shell's (moved from AGENTS.md, HI-2013)

Tests never assume they're alone on the machine or inherit their shell.
- What a run uses of its own comes from the run context (`e2e/runContext.cjs`, `lanes.mjs`, `build.mjs`): environments
  from an allowlist (`lib.hiveEnv()` for a test Hive, `lib.childEnv()` for the hive MCP server or `hive-progress`), a
  lane's ports and folders, the CLI test homes, and the dev build under a lock per worktree.
- Never build a child's environment from `process.env`. Give every child the runners, `lib.cjs` or the harness start
  themselves an `env` (`runContext.baseEnv()` for git and the build), so a shell's `GIT_DIR` or `NODE_OPTIONS` can't
  reach it (unit tests fail); a setting a run must pass on goes in `PASS_ENV`.
- After changing the runner, `lib.cjs`, the run context or the scenario harness, run `npm run e2e:concurrency` (and
  `-- --heavy` after changing `slots.mjs`).
- At most two heavy runs (a full or `--repeat` e2e run, more than five scenarios, a full unit run) go at once on the
  machine (`heavySlots` in `%LOCALAPPDATA%\hive-test\config.json` changes it, for the whole machine: e2e/README.md): a
  third waits, not hung, printing who holds the slots ("e2e: waiting for a test slot" in Progress; `--no-wait` fails at
  once).
- Temp folders come from `tempDir()`, by long, real paths, in `%LOCALAPPDATA%\hive-test\tmp`, never under
  `os.tmpdir()` (a unit test fails): CI's is the 8.3 form `C:\Users\RUNNER~1\…` and Hive compares real paths, so such
  tests failed on CI only. Another name for a folder comes from `pathAliases.ts`: `junction()` works on any machine,
  `shortPath()` only where the volume makes 8.3 names.
- Unit tests run git with none of the shell's `GIT_*` variables (`cleanGitEnv.ts`) and no global config, as CI does
  (`noGlobalGit.ts`): a test whose Hive code commits or merges sets its repository's own `user.name` and `user.email`.
- e2e suites use `lib.cjs` and work under `%LOCALAPPDATA%\hive-test\e2e` (each runner's suites in its lane's
  `lanes\<k>\<suite>`, so runners in different worktrees don't collide), never the real clipboard, profile or
  `~/.codex`.
- Probes of your own (scripts, screenshots, profiles outside a suite) and redirected output take a new folder each run,
  from `lib.probeDir()` (in `hive-test\scratch`) or your scratchpad, never in the lanes or logs, the project, a worktree
  or beside one (the worktrees' parent folder), or a project's `.codex`, `.claude` or `.agents` (a stray `.codex` with a
  reviewer's probe stopped every Codex agent's commands, #509; logs left beside worktrees outlived them). The runners
  prune what tests leave in `hive-test`, keeping what an open card cites by path (`npm run test:clean`, e2e/README.md
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
- **Wait for Hive to settle, not for a quiet spell.** Watches and loop wakes finish their work in the background (a
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
  alone. A machine can be set to take more or fewer heavy runs in `%LOCALAPPDATA%\hive-test\config.json` (`heavySlots`;
  [e2e](e2e/README.md), "How many heavy runs at once"); a test must pass with any number of them.

A sleep that is the point of the test is fine: checking that something does *not* happen within a period, pacing
keystrokes, a fake standing in for a slow CLI. Say so in a comment beside it. Something that is truly waited for with
a sleep, where nothing can be observed, is the exception: say why in the comment.

**`npm run test:waits`** (`scripts/testWaits.mjs`) finds every wait in the tests that states no bound of its own, or one
under 5 s with no comment, and the sleeps a branch adds or changes in the tests since main (uncommitted and new files
too) that a check follows within three lines, with no comment beside or above saying why; it exits 1 when there is one, and 2 when it can't compare (no `main`, a bad `--base`, git failing): nothing was
checked, so that isn't a pass. Only the first check after a sleep counts, and the sleep is let through only when that
check itself waits (`until`, `waitFor`, `poll`): a wait in a later check doesn't cover an earlier one. A short sleep
needs its comment like a long one. A pause inside a loop that polls state is the loop's way of
waiting for its condition, so it isn't counted: one whose `while` (or `do…while`) condition reads state, or whose body
leaves on an `if` with `break` or `return`, with the check after the loop. A loop that only repeats actions (a counted
`for`, `for…of`, a `while` on a count or a clock) is no poll: a sleep in it before a check, inside the loop or after
it, is found like any other. What it can't see: a single read with no sleep before it, a sleep more than three
lines before its check, and a wait under another helper's name; and a comment counts as the reason whatever it says.
Reviewers look for those and judge the reasons. `-- --all` lists every such sleep in the tests, the older ones too (the
backlog in #524's audit). Builders run it before Review, and reviewers fail a new or changed test that sleeps and then
checks, reads state once after an action, or raises a timeout with no stated reason.

A test that flakes anyway is investigated with the `investigate-flake` skill (`.claude/skills`, `.agents/skills`).
