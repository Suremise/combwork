# End-to-end suites

Each suite starts the dev build of Hive with Playwright's `_electron`, in a throwaway profile and workspace, and
checks a feature the way a user would use it. They run on your machine, not in CI: they need the real CLIs.

```bash
npm run e2e -- --build          # build first, only if the dev build in out/ isn't from this source, then the full set
npm run e2e                      # the full set: every fake-tier suite (the packaged ones only with --packaged); same as --all
npm run e2e -- --all --real      # everything, the real tier (real Claude Code and Codex) too
npm run e2e -- --only-real       # only the real tier
npm run e2e -- agents transcript # just these
npm run e2e -- --affected        # the suites the changes since main need (affected.mjs), uncommitted ones included, real ones too; a tool for picking suites, not a merge's gate (#1010)
npm run e2e -- <suites> --build --record # and print a run record for the card (saved with the run's logs, and the latest as logs/run-record.md)
npm run e2e -- --fingerprint     # the code's fingerprint, to compare with a run record
npm run e2e -- <suites> --repeat 3 --build --record # three runs, stopping at the first that fails; one record for all
npm run e2e -- --all --no-wait   # a heavy run: fail at once rather than wait while two others hold the test slots
npm run e2e -- <suites> --build --keep-files # passed suites' screenshots and files kept too, in the run's log folder (<run>\<suite>)
npm run e2e -- --clear-dir <folder>          # empty a probe's or a suite's own folder from Node, for a rerun into the same place
npm run e2e -- --lang en-XA,pl --build       # the i18n screenshot route (i18nshots) in these languages, its screenshots kept
npm run dist && npm run e2e -- --packaged   # also the installed-app suites (dist/win-unpacked)
```

**Two tiers.** The **fake tier** is every suite that starts no real CLI: those with no `needs`, those that run the
fake Claude Code or fake Codex, and `copilot`, `copilotcopy` and `copilotsize` (`needs: ['copilot']`), which run the real Copilot CLI offline against a
scripted stand-in model: no sign-in and no cost, so it is in the full set, and skipped where Copilot isn't installed. The **real tier** is the suites that start the real Claude Code (`needs: ['claude']` in
`suites.mjs`) or the real Codex in its test home (`needs: ['codex']`): they test what fakes can't (hooks reaching Hive,
the CLIs' transcript formats, session binding, usage, their trust and mode screens, Codex's sandbox), but they are slow,
cost tokens and fail for reasons that aren't the code. The full set (`--all`, or nothing named) is the fake tier, and
the runner lists the real suites it left out ("Not run: the real tier"), in its output and the run record. `--real` adds
the real tier, `--only-real` runs only it; a suite named always runs.

A suite passes when it exits cleanly and prints no `FAIL` line. **Environment failures are a SKIP, not a FAIL**, but
only where it is certain: a real suite marks each step that waits on the CLI answering (a turn) with
`lib.cliStep(name, { session: <pty key> }, fn)`, and its `check` reports to `lib.checked(ok)`. When a check in such a step
fails and a **new** usage or rate limit, sign-in or network error (`lib.environmentProblems`), or a launch of the Store
PowerShell 7 that Codex's sandbox refused (`lib.storePwshRefusals`, below), appeared **in that step's session** during it, the suite stops there with `SKIPPED environment: <why> (in "<step>", <session>)`, which the run
record lists under **Skipped for the environment**. It stays a FAIL when the step threw (an exception is never the
environment's: a bug, a rejected IPC call, a file error; so a step's waits on the CLI end in a check, not a throw), when
anything failed before the step, when another FAIL line was printed (a page error), when the error is in another
session or was already there before the step (the CLI recovered), or when the suite's checks don't report to
`lib.checked`; an `ENVIRONMENT` line in its output
says it saw the error but couldn't put the failure down to it. Hive's own checks about the turn (what it recorded,
counted, showed) go after the step, outside it. The runner skips real suites up front, with an `environment:` reason,
when their CLI isn't installed, Claude Code says its test home isn't signed in (`claude auth status`, only for
`claudeHome: 'test'` suites), or the Codex test home has no sign-in. A suite that can't run on a machine says so with `lib.skip('<why>')`. The runner prints a summary; each suite's output
is kept in a folder of its own for each run, `logs/run-<date>-<time>` under the work folder, with `-2`, `-3`… when
another run started in the same second. The last ten finished runs are kept, and every run started in the last 24 hours
up to 2 GB of logs (Where they work, below): a run still going (`.active` in its folder,
with its runner's process id) is never pruned, so runners started side by side don't remove each other's logs. A runner started inside a suite (`progressreport`
runs one) keeps its runs under `logs/nested`, so they never push real runs out (`logs.mjs`). It knows it is inside a
suite from `E2E_RUN_SUITE`, which the runner sets for each suite: Hive drops `HIVE_` variables from its sessions, so
`HIVE_E2E_PORT` doesn't reach an agent's shell.

**The build.** The suites run the dev build in `out/`. `--build` builds it first, only when it isn't from the source
as it is now: a build made with `--build` is stamped with a hash of everything it was made from (the paths and contents
of `src`, `resources`, `docs`, the root files the app bundles and the build config; `build.mjs`), so an added, changed
or deleted file is noticed whatever its modification time. A build made another way (`npx electron-vite build`) has no
stamp: the runner warns that it may hold other code, and a run record made with it is marked not valid. So use
`--build` with `--record`. Runners in the same worktree build it once between them (Run context, below).
`npm run dist` builds `out/` the same way (under the worktree's build lock) and stamps it, so a run straight after it
needs no `--build` (#274).

**The installer's suites** (`packaged*`) test `dist\win-unpacked`, not `out/`: a run of only those doesn't look at
`out/` (unless `HIVE_PROGRESS_CHECK_DEV=1`). Instead the runner checks what `dist\win-unpacked` itself was built from:
`npm run dist` records that inside it (`win-unpacked\.hive-build-info.json`) once it is sure, and removes it when it
starts. Not `dist\build-info.json`: that describes the installer set, which a worktree's `npm run dist` copies into the
main checkout's `dist` without `win-unpacked`, so there it can describe another build than the one the suites would
run. When the record's code isn't the fingerprint of the code now, or there is none, the runner warns and a run
record is marked not valid. So `npm run dist`, then
`npm run e2e -- packaged packaged-mcp packaged-progress --record`, gives a valid record without `--build`; a `dist` from
another commit, or from before an edit, is reported.

**Windows** (#1253): no suite puts a window on the screen or takes the focus. A dev test copy is quiet itself
(`testQuiet`: off screen, unfocusable, no notifications). A packaged Hive isn't, unless it is 1.0 with
`HIVE_TEST_QUIET=1` (which `hiveEnv` sets); a released 0.9 can't be changed at all. So `lib.cjs`'s `_electron.launch`
does it from outside for every packaged Hive a suite starts (`packaged`, `packaged-transcript`, `packaged-workers`, `boardupgrade` and
`upgradelane`'s 0.9 from `HIVE_E2E_HIVE09` or the main checkout's `dist\win-unpacked`, `plan` with `HIVE_EXE`). It
starts with `--hidden` (Hive makes its windows but shows none, as when started at sign-in). As soon as Playwright
reaches its main process, `keepPackagedQuiet` moves its windows off screen, makes them unfocusable and keeps them off
the taskbar, then shows them inactive so they draw for screenshots. From then on, showing, focusing, maximising,
raising or flashing a window keeps it off screen, Windows notifications are dropped, and message boxes answer as
cancelled. A window already shown when it is reached fails the launch, saying so. Only its tray icon can appear.
`packaged-progress` and `packaged-mcp` run Hive.exe as Node and show nothing. Checked in Windows Sandbox (0.9.3, a
watcher of on-screen windows and the foreground: none from Hive) and on the host for these suites (the card says how).

**No update checks** (#1332): a packaged Hive checks GitHub 30 s after it starts and every 6 hours, and each check
fetches the release's `latest.yml`, which GitHub counts as a download. A packaged test Hive never does: 1.0 with
`HIVE_TEST_QUIET=1` checks nothing, automatic or manual (Settings → Updates says it's a test copy, and its log says so
at start), and `lib.cjs`'s `_electron.launch` also gives every packaged Hive `HIVE_UPDATE_DELAY` at its maximum (about
24.8 days: a 0.9's first check never comes) and, in a profile it has saved, automatic checks off (no 6-hourly one).
The guard: when a suite ends, each packaged Hive's `hive.log` must show no `[updates] Checking for update` since it
was started, or the suite fails, naming the lines. The Sandbox checks run with their network off.

Nor does a test ever start the installed Hive (`%LOCALAPPDATA%\Programs\Hive`): `lib.cjs` refuses it and any Hive.exe
outside this checkout, the test folders, the main checkout's `dist\win-unpacked`, `HIVE_E2E_HIVE09` and `HIVE_EXE`. And
children of the run context get no `%APPDATA%\Hive\bin` or `Hive-Dev\bin` on their PATH (an agent session has them):
those `hive-progress` shims run the installed Hive.exe. A `hive-progress` run seen in a process list is itself
`Programs\Hive\Hive.exe` (as Node, no window), not the app.

**Several at once.** Suites run four at a time (`--jobs N` for another number; `--jobs 1` runs them one after
another). Each gets its own profile, folders and Agent API port: the runner sets `HIVE_E2E_PORT` and `HIVE_API_PORT`,
and suites read the port with `lib.port(<default>)` (the default is used when a suite runs on its own). Suites that
start the real Claude Code or use the Codex test home share those with each other, so they run one at a time in a lane
of their own, beside the rest. Those marked `serial` in `suites.mjs` (with the reason: window focus, a shared test
home) and the installer's run last, alone.

**Several runners at once** (agents in different worktrees each checking their card). Each runner claims a **lane**
when it starts (`lanes.mjs`): a range of ten Agent API ports (lane *k*'s first slot is 47940 + 20*k*, the CLI lane the
port below) and a folder of its own for its suites' profiles, workspaces and screenshots (`lanes\<k>` in the work
folder, a folder per suite in it, below). Claims are files in `%LOCALAPPDATA%\hive-test\e2e-lanes`
(`lane-<k>.json`, with the runner's process id), taken under a short lock and released when the runner ends; a crashed
runner's claim expires (its process is gone, or it is a day old). A lane is only taken when nothing is listening on
its ports, so anything else holding them (an older runner without lanes, another app) moves the runner to the next
one. The runner prints its lane, its suites' folder and its logs folder when it starts. Ten runners at once is the
most: an eleventh (e2e or scenarios) waits for a lane, printing who holds them and showing as "e2e: waiting for a test
lane" in the Progress panel, and takes the first one let go (#707); with `--no-wait` it fails at once instead.
A runner takes its lane before it looks at the code (its record's fingerprint) and the build (#735), so one that waited
tests the source as it is once it has a lane, built from it.
A runner started inside a suite claims no lane: it takes ports 1000 above its parent suite's (`portBase` in
`runner.mjs`) and its suites' folders in `nested` inside the parent's (`E2E_RUN_DIR`). Logs stay in one place for every
lane (`logs/` below), so `.active` there shows every run still going. Suites keep their test projects outside the
repository, so its `CLAUDE.md` (which imports `AGENTS.md`) never applies to their Claude Code sessions: Claude Code
would ask each session whether to allow the import. `update` keeps its download cache per lane too (`%LOCALAPPDATA%\hive-test-updater-<k>`, through
`HIVE_UPDATE_CACHE`). The Codex test home stays shared: it holds the one sign-in, and copies of it would share a
refresh token. Real Codex suites take a machine-wide lock on that home's real path for their whole suite (#478):
two runners starting sandbox commands through the PowerShell alias together could leave one launch refused with
`CreateProcessAsUserW failed: 5`. The second runner prints who holds the home and waits in the Progress panel;
it starts when the first releases it. A dead or stale holder is recovered. The real Codex scenario provider takes
the same lock for its run; fake Codex trials use their own homes and do not wait for it. Different test homes have
different locks, and a junction or another spelling of one home has the same lock. Codex runs any number of sessions
inside the suite that holds the lock. What the suites change there, the trusted folders in its
`config.toml`, goes through `lib.trustForCodex`, under a lock beside the file (`config.toml.lock`, broken after 30 s
as a crash's), so two runners trusting their lanes' folders at once never lose one. A suite that runs out of time (10 minutes; a `--lang` run 6 a language) is stopped with everything it started, so its test
Hive doesn't keep holding the lane's port.
The home lock fixes overlapping launches. A separate failure where every alias launch is refused during another
runner's full test run is tracked in #499; the diagnostics record it and keep its FAIL verdict.

**Run context.** Tests assume nothing about the machine they run on or the shell they were started from: everything
a run uses of its own comes from one place, `runContext.cjs` (with `lanes.mjs` for ports and folders and `build.mjs`
for the build), and the e2e runner, `lib.cjs` and the scenario harness all take it from there.

- **Environments are built from an allowlist.** A suite (from the runner), a test copy of Hive (`lib.hiveEnv({
  HIVE_USER_DATA, … })`, which `lib.launch()` uses) and a child that is part of Hive, such as the hive MCP server or the
  `hive-progress` wrapper (`lib.childEnv({ … })`), get Windows' own variables, the user's folders and the network's
  proxy and certificates (`ALLOW`), plus what the context sets: the profile, quiet and tips off, the suite's folder
  (`HIVE_E2E_DIR`) and port (`HIVE_E2E_PORT`, which a test Hive gets as `HIVE_API_PORT`), the CLI test homes a suite
  names. Nothing else of the parent's: not an agent session's `HIVE_*` variables or an outer `hive-progress`'s
  `HIVE_PROGRESS_*`, not `NO_COLOR`/`FORCE_COLOR`, `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `CLAUDE_*` or `ANTHROPIC_*`
  (the real tier uses the CLIs' own sign-in) or `GIT_*`. So a run started from an agent's shell inside `hive-progress`
  behaves as one started from a plain one, and there is no strip list to keep growing.
- **Test settings are passed on by name** (`PASS_ENV`, each with what it is for): `HIVE_TEST_CODEX_HOME`,
  `HIVE_TEST_CLAUDE_HOME`, `HIVE_TEST_QUIET` (`0` shows the copies), `HIVE_TEST_PROGRESS_TIMINGS`,
  `HIVE_PROGRESS_CHECK_DEV`, `HIVE_EXE`, `REPLYSIZE_OUT`. A new setting a suite must get from the person running it is
  added there. `HIVE_E2E_NATIVE` never is: it only works with a suite run on its own.
- **No child environment from `process.env`.** `lib.cjs` refuses to start a test Hive whose environment `lib.hiveEnv`
  didn't build, and `tests/e2esuites.test.ts` fails for a suite, the runner or the scenario harness that spreads or
  passes `process.env`. The fake CLIs are the exception: they stand for Claude Code and Codex, which start their MCP
  servers from their own environment (a test Hive's session's, already the context's). A suite's own tools (git, a
  PowerShell query) run in the suite's environment, which under the runner is the context's.
- **The runners' own tools get it too** (#208). The runners, their modules, `lib.cjs` and the scenario harness run in
  the shell they were started from, so every child they start themselves is given an environment: the build
  (`devBuild` in `build.mjs`), the git of the run record's fingerprint, `--affected` and the concurrency checker's
  worktrees, `where.exe`, `taskkill` (`runContext.baseEnv()`, the allowlist alone). A `GIT_DIR` or `GIT_WORK_TREE` in
  the shell can't point their git at another repository, and `NODE_OPTIONS` or npm's `npm_config_*` don't reach the
  build. The unit test fails for a `child_process` call there without `env`. The deliberate exception is the runners'
  progress reporting (`tests/progressReport.mts`): it is no child, and reads the Hive variables of the shell it was
  started from, to report to the Hive that started it.
- **Folders, ports and CLI homes**: the lane (above), the Codex test home under its `config.toml` lock, the Claude Code
  test home for the model trials (`CLAUDE_TEST_HOME`); each suite keeps its own `CLAUDE_CONFIG_DIR` folders in its lane.
  **Every test copy of Hive gets the CLI homes** (#382, #452): Hive looks for the CLIs when it starts, and their sign-in
  checks (`claude auth status`, `codex login status`, Copilot's `config.json` and `gh auth status`) read the home they
  are given, else yours. `lib.hiveEnv` gives `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME` and `GH_CONFIG_DIR` as
  empty folders of the suite's (`<suite folder>\cli-homes\claude`, `\codex`, `\copilot` and `\gh`, `runContext.cliHomes`;
  the empty gh config hides your GitHub CLI login, which Copilot falls back to) unless the suite gives a test home (the
  fake Claude Code's, `lib.ownClaudeHome`, the Codex test home). `lib.cjs` refuses to start a test Hive with one missing
  or pointing at your own `~/.claude`, `~/.codex`, `~/.copilot` or `%APPDATA%\GitHub CLI` (however the path is spelled),
  and makes the empty ones. **Its git has the suite's config alone** (#1466): `GIT_CONFIG_GLOBAL` is
  `<suite folder>\gitconfig` (`runContext.gitConfig`), which `lib.cjs` writes with the test identity (`Hive Test`,
  `hive-test@example.invalid`, `lib.TEST_GIT_IDENTITY`) and `core.autocrlf = false`, and `GIT_CONFIG_NOSYSTEM=1`, so
  your name and email never show in its screens or commits and the machine's git settings don't apply. **A suite's own
  git on its fixtures gets the same** (`lib.gitEnv()`, which `lib.git` uses): Git for Windows' system
  `core.autocrlf=true` for the suite's checkouts and not for its Hive made Hive take them for uncommitted changes. A
  unit test fails for a suite's git started with another environment (the exceptions: `evidence`'s on the checkout under
  test, which keeps `baseEnv` and the machine's settings it was checked out with, and `isolation`'s inside its Hive). A
  suite that needs no identity, or another, gives its Hive and its git a `GIT_CONFIG_GLOBAL` of its own (`gitinit`,
  `gitview`, `p5scenarios`); `lib.cjs` refuses one missing or pointing at your own `~/.gitconfig`.
- **The build, once per worktree** (`build.mjs`): runners started at the same time in one worktree share its `out/`,
  so the first that finds it stale takes the worktree's build lock (`%LOCALAPPDATA%\hive-test\build-locks`, a folder
  per worktree with its holder's process id), looks again, builds once and stamps it; the others wait (`Waited for
  another runner's build`) and find it fresh. A runner that only checks waits too, so it never reads half a build. A
  lock whose runner is gone is broken; a failed build lets go of it. Worktrees don't wait for each other.

`isolation` checks what a suite, a test Hive, a child and the `hive-progress` wrapper get, with an agent shell's
variables put into the suite's own environment. **`npm run e2e:concurrency`** (`concurrency.mjs`, `--repeat N`) starts
four runs at once with both builds stale: an e2e runner and a scenario run in this worktree, two e2e runners in a
second worktree it makes for the check (a git worktree of `HEAD` with the uncommitted changes, sharing `node_modules`
through a junction, removed afterwards), one in each worktree with an agent shell's environment (`NO_COLOR`,
`HIVE_PROGRESS_WRAPPED`, a token…) and one with a plain one. It checks that every run passes in a lane, folders, ports
and logs folder of its own, and that each worktree is built once and stamped. After that (alone with `--lane-wait`),
an e2e run and a scenario run wait for a lane of a pool of their own (`HIVE_TEST_LANES_DIR`) while a source file is
added: both must build and test the changed source, and the record name it (#735); meanwhile it holds machine lanes 0 and 1 with a suite folder in each, which their housekeeping as they end must leave (#1133). Run it after changing the runner,
`lib.cjs`, `runContext.cjs`, `lanes.mjs`, `build.mjs` or the scenario harness. Two checkers can run at once, from two
worktrees (#207): each keeps what it makes (its worktrees, decoy, heavy-run pool) in a folder of its own,
`%LOCALAPPDATA%\hive-test\concurrency\run-<pid>-<time>` (`tempWorktrees.mjs`), and removes only that. A setup that
fails part way removes its own worktree; the folder of a checker that crashed is removed by the next one, unless it
was kept with `--keep`. Two started from the same worktree share its build, so its "built once" checks may fail.

**Heavy runs queue** (`slots.mjs`, #204). Several agents each running full sets on one machine slowed each other until
tests that pass alone timed out. So at most **two heavy runs** go at once across every worktree
(`heavySlots` in `%LOCALAPPDATA%\hive-test\config.json` changes it: "How many heavy runs at once", below): an e2e run of more than five suites (`--all`, `--real`, a big `--affected`) or
any `--repeat`, a scenario run of more than five scenarios or with `--repeat`, and a **full unit run** (`npm test`, a
`vitest run` of the whole set: `tests/unitSlot.ts`, `isFullUnitRun`, #599; its workers and what its tests start, beside
e2e runs, were what ran Windows short of desktop heap: 0xc0000142, below). A run of a few suites, a single
scenario, a focused unit run (some files, `-t`, `--changed`, `--related`, or watch mode), or a runner or unit run
started inside a suite never waits (`needsSlot`, #211), since its parent's run
holds a slot and waiting behind it would never end. It still keeps apart from its parent (a nested e2e runner in the
parent's `nested` folder with ports above the parent's, a nested scenario run in a lane of its own). A heavy run that finds both slots taken waits for one,
before it builds, in the order runs asked. It prints `Waiting for a test slot …: held by e2e: 68 suites in <worktree>
(process …, 12 min)` and shows in the Progress panel as **e2e: waiting for a test slot** (or **scenarios: …**, **unit tests: …**), naming
what is ahead of it by whose run (`waiting for a test slot (2 heavy runs ahead: HB6's scenarios: 151 (fake), HB4's e2e:
4 suites × 5)`, HI-2070: the holders' runs, never this one's), until it gets one (`Got a test slot after N s`). So a run
that seems stuck is usually waiting: that line says for whom. `--no-wait` fails at once instead (exit 2, saying who
holds them).
**Small runs take the side slot** (HI-2070). A heavy run within the small-run bound, `smallRun` in `config.json`
(default: an e2e run of at most 3 suites repeated at most 3 times, or fake scenario runs of at most 5 in all, scenarios
× repeats), is small: it takes the **side slot** when that is free (`sideSlots`, default 1), else a heavy slot, else it
waits for whichever frees first. Heavy runs never take the side slot, so at most one small CPU run goes beside the two
heavy ones. A focused unit run (named files) stays light and takes no slot, as before. So a flake proof of one suite × 3
no longer waits behind a full scenario set. Held side slots are `side-<k>.json`.
**Model trials have their own cap** (HI-2070). A scenario run on a real model (`--provider claude-code` or `codex`), of
any size, is network-bound, not CPU-bound: it takes no CPU slot (heavy or side), only one of the model trials' own
(`modelTrials`, default 2, `model-<k>.json`), which bounds API spend and Codex's account-wide rate window (429s). It
waits only for another model trial (`Waiting for a model-trial slot (2 real-model trials at once on this machine,
modelTrials): held by …`). Its build, when the dev build isn't from its source, is CPU work: the trial takes a small
run's slot (the side slot, else a heavy one) for the build alone (below).
**Runs inside runs** get credit only for the kind of slot their parent holds (HI-2070, `heldCredit`): each runner
sets `E2E_RUN_SLOTS` (`cpu`, `model` or both) for what it starts, carried into a test Hive's sessions: what it was
given, and the kind of slot it holds itself (`creditFor`). A heavy or small e2e run gives its suites CPU credit (#211: a
nested run waiting for its parent's own slot would never end); a light one, which holds none, passes on only what it
was given; a model trial adds model credit. So a heavy e2e or full unit run inside a model trial asks for a CPU slot,
also through a light e2e run in between, and a model trial inside an e2e suite for a model trial's. A model trial's
build takes a CPU slot unless its credit covers CPU work (`buildNeedsCpuSlot`): it looks once no other runner is
building and takes the slot only for a stale build (`ensureBuildWithSlot`). A suite of an older runner (no
`E2E_RUN_SLOTS`) gives CPU credit. **On the side slot**, an e2e run runs at most two suites at once (`SIDE_E2E_JOBS`),
whatever `--jobs` says: four beside two heavy runs took the machine near full load.
**A pre-merge run goes first** (#558): one started in the session of the agent that holds its project's merge slot
(the runner asks Hive's Agent API, with the session's `HIVE_API_URL`, token, `HIVE_PROJECT` and `HIVE_AGENT`, at its
first look and every 30 s while it waits), or one with `--pre-merge` (either runner; for a merge's checks started
outside an agent's session). It takes the next free slot before runs that asked earlier for other reasons, behind only
pre-merge runs that asked before it, and says `…, pre-merge, next in line: held by …`; it never stops a run that holds a
slot, and no slot is kept back for it. So a merge, which every other merge waits behind, doesn't wait behind flake-proof
repeats. The merge-ready skill claims the merge slot before its checks, so its runs need no flag. Slots are files in
`%LOCALAPPDATA%\hive-test\heavy-slots` (`slot-<k>.json` held, `wait-<pid>.json` waiting, each with its runner's
process id, and `first` for a pre-merge run, under the same claims lock as lanes); a crashed or killed run's slot, or
place in the queue, expires at once (its process is gone).
**A run left over** (#1008): a run started in an agent's session that ended since (Hive closed under it, the agent
stopped or restarted) keeps going, and keeps its slot, while its process lives. Its slot records the agent's launch
(`owner`: `HIVE_PROJECT`, `HIVE_AGENT`, `HIVE_RUN_ID`, `HIVE_WORKSPACE`), and a waiting run asks Hive's Agent API whether
that launch still runs (`GET /v1/projects/{name}/agents/{agent}/launches/{run}`, at its first look and every 30 s): the
wait line, and the Progress panel, then name it `held by e2e: 196 suites in <worktree>, left over from a session that
ended (process 39788, 41 min)`. A run starting in the same worktree says so too (`Still running in this worktree, left
over from a session that ended: …`), so a resumed agent knows its earlier run still goes. Nothing is stopped on its own:
its results may still be wanted. Stop it by its process id (never by name), or with **Stop Them** in Hive's notice after
an unexpected close, which ends the whole run.
`npm run e2e:concurrency -- --heavy` checks it: three heavy runs from three worktrees with two slots (in a pool of their
own, `HIVE_TEST_HEAVY_DIR`, with no side slot), one waiting visibly, `--no-wait`, with both heavy slots held a small run
taking the side slot while a heavy one is refused, a killed run's slot, a pre-merge run taking the slot
before two that asked earlier (the stand-in Agent API says its agent holds the merge slot), and a killed pre-merge run's
place.

**How many heavy runs at once** (#544, #589). The default is two (`DEFAULT_SLOTS` in `slots.mjs`). A machine with more
cores and memory, or with nothing else running, may take more; a slower one fewer. To change it, write the number into
the shared test folder's settings file, `%LOCALAPPDATA%\hive-test\config.json`: `{ "heavySlots": 3 }`, a whole number,
1 or more. It is machine-wide, as the slots are: every worktree's runs, an agent's or a terminal's, read the same file,
so they all count the same slots. It is read each time a run asks for a slot, so an edit counts from the next run, with
no restart of Hive or a terminal. A missing or unreadable file, or a value that isn't a whole number from 1, means two,
and the run says so in one line (`Test slots: …`). `HIVE_TEST_HEAVY_SLOTS`, a whole number, overrides the file for one
run (the concurrency checker uses it); Hive doesn't pass it on to its sessions (it drops its `HIVE_` variables), and a
run started with a higher number than the others can take a slot they are waiting for, so use the file for the
machine's setting. If runs start failing after raising it, go back down. A pool of its own (`HIVE_TEST_HEAVY_DIR`) with
a count of its own is for checking the queue itself (`npm run e2e:concurrency -- --heavy`), never for getting round
it. The side slot and model trials are set beside it (HI-2070), read the same way:
`{ "heavySlots": 2, "sideSlots": 1, "modelTrials": 2, "smallRun": { "e2eSuites": 3, "e2eRepeat": 3, "scenarioRuns": 5 } }`.
`sideSlots` is a whole number from 0 (0: no side slot, small runs queue for the heavy slots); `modelTrials` and each of
`smallRun`'s from 1; one left out, or one that isn't valid (said in a `Test slots: …` line), is its default.
`HIVE_TEST_SIDE_SLOTS` and `HIVE_TEST_MODEL_TRIALS` override the first two for one run, as `HIVE_TEST_HEAVY_SLOTS` does.

**Unit tests under load.** `npm test` uses half the cores (`maxWorkers: '50%'` in `vitest.config.ts`) and allows 20 s
a test and 30 s a hook, so a full run beside an e2e set doesn't hit Vitest's 5 s default. A test that needs longer says
so itself (`it(…, 60_000)`), and a test that waits for something waits for it (polling), not for a fixed time.

## Which suites to run, and who runs them

For a card in the builder/reviewer loop (the `card-loop` skill), so a round doesn't run the same suites twice on the
same code while every required check still runs:

- **The builder** runs the suites the card names and moves the card to Review with a **run record**
  (`--build --record`): the code's fingerprint (HEAD, plus a hash of any uncommitted changes; in a card loop the builder
  commits first, so it is the commit the round names), each suite's result and time,
  and the logs folder. Paste the printed block into the card comment. When real suites ran, the record also names the
  real CLIs' versions as the suites' test copies of Hive selected them ("Real CLIs (as Hive selected them): Claude Code
  2.1.292, Codex 0.160.1"; each Hive notes its choice in the suite's `hive-clis.jsonl`, `HIVE_TEST_CLI_LOG`), and
  `run-record.json` beside it holds them per suite: `npm run tested-clis` makes the release's "Tested with" manifest
  from it (#365, RELEASING.md). The runner itself never starts a CLI.
- **The reviewer** checks the record instead of repeating it (#533): its fingerprint is the code it's reviewing
  (`npm run e2e -- --fingerprint` in the builder's folder), it's recent, the suites the change needs ran, and each
  failure in it is explained. It then runs the quick checks (`npm run typecheck`, `npm run lint`), the unit tests the
  change affects (`npx vitest run --changed <base>`, where `<base>` is the commit the card's work started from;
  uncommitted changes count too; it follows imports, so add the tests that read a changed file, such as a skill's
  Markdown or a fixture), not the whole unit suite, and only the new or changed suites and those it doubts
  (the one or two closest to the riskiest change), saying which on the card, and spends the rest of its time on its own probes. It reruns a whole suite or set only when there's no record, the
  fingerprint differs or the record is stale, a result looks wrong, or the change is to shared test infrastructure (the
  runner, `lib.cjs`, the run context, the scenario harness, `vitest.config.ts` or a helper in `tests/`), and says in
  its verdict which and why.
- **Follow-up rounds** run only the suites that failed plus those the fixes touch, by name (`--affected` can help pick
  them). **Before a card passes**, every suite it names has run on its final code (the builder's last record). How
  narrow a round's tests are, and what never runs on a card unless it asks, is AGENTS.md's **Tests per card**.
- **A merge** (#1010; into main or an integration branch such as `feature/090-session`) runs **focused checks** on the
  merged code: typecheck, lint, `npm run check:repo` (the repo-wide checks: the i18n guard and the unit tests that
  scan every file, under a minute, HI-2244), and the cards' own focused suites (those their reviews ran, plus any
  suite the merge's conflicts touched), `npm run e2e -- <suites> --build --record`. **Not** the full set and **not**
  `--affected`: merges take turns at one slot, and an hour or more of e2e for each kept every other lane waiting (a
  phase of five merges took hours) and was the load Hive crashed under (#988). Every card has already passed review
  with its focused suites, which its reviewer checked. A pre-merge run still goes first in the slot queue (#558). A
  real suite skipped for the environment doesn't block a merge, but the record says so and the reviewer decides
  whether it must run again first. The full unit run (`npm test`, about 7 minutes) is a release's checks, and on
  request, never a card's while building (AGENTS.md, Tests per card: no builder or reviewer runs or asks for it); CI
  runs only the unit tests.
- **The full set runs at checkpoints**: `npm run e2e -- --all --build --record` **on the integration branch when the
  lanes go quiet** (a phase's end, overnight with the load capped, before a long pause; a failure is carded at once and
  bisected over the merge commits since the last full run), for **every RC and release** (RELEASING.md, with the real
  tier: `--all --real`), and **on request** (the user, or a card that asks for it). Run the real tier on its own
  (`--all --only-real`) **after updating Claude Code or Codex**. `--affected` (below) stays a tool for picking the
  suites a change needs, such as a review round's fixes, and isn't any merge's gate.
- **A flake fix, or a change to a suite's waits**, is proven by focused repeats under load (the `investigate-flake`
  skill): the suite with its neighbours (its area's suites in `affected.mjs`, filling the four jobs) three times,
  `npm run e2e -- <suite> <neighbours> --build --record --repeat 3` (at most 2 spinner workers; a flake seen only
  under a full run's load waits for the release window unless it blocks merges: AGENTS.md, Tests per card). The full-set check is the next quiet-time or
  release run (above), not the card's or the merge's; the full set repeated (`--all --repeat 5`) runs only when the
  user asks: it holds a heavy slot for over an hour while other lanes queue, and under that load it fails on their
  flakes (a failure in another lane's suite is a card of its own, not a reason to fail the fix).
- **When a change could make every suite flaky** (the runner, `lib.cjs`, the run context, how suites run side by side),
  the card proves it with focused loaded runs: `npm run e2e:concurrency` (`-- --heavy` after a change to `slots.mjs`)
  and the suites closest to the change with their neighbours, repeated (`--repeat 3`). The full set, repeated if need
  be (`--all --build --record --repeat 3`), is then the next quiet-time run on the integration branch (say on the card
  that it's due), or runs when the user asks: never a per-card mandate.
- A repeat stops at the first run that fails, and its one record is valid only if every run passed on the same code. A
  failure means fix it and start a new repeat: a later passing run doesn't make up for an earlier failure.

`--affected` errs towards more: a change to a file every part of Hive goes through (the IPC contract, types, the store,
`lib.cjs`, the fake Claude Code, the runner and the scenario harness: `EVERYTHING` in `affected.mjs`) or to any file no
area names (code, resources, scripts, build files) means every fake suite; only documentation (`DOCS_ONLY`) and what
only the unit tests use select nothing, and `tests/e2esuites.test.ts` checks that every other tracked file selects a
suite. Real suites come in when an area names them, or when the change is to Hive's side of every CLI (`REAL_TIER` in
`affected.mjs`: `sessions.ts`, the providers, `providerService`, the terminal host, hook status, transcripts,
`lib.cjs`) or to code no area names; a provider's own adapter (`src/main/providers/claude/`, `codex/`) picks only its
real suites. Add an area to `affected.mjs` when you add a
suite or a source file; `tests/e2esuites.test.ts` checks every suite and source file is covered. What only the unit
tests use (`tests/*.test.ts` and their helpers in `tests/`, `vitest.config.ts`, CI's workflow: `UNIT_ONLY`) selects no
suite, so an e2e suite or scenario must never load a `.ts` helper from `tests/` (the unit test fails if one does).

**Progress in Hive.** Run from an agent's session in Hive, the runner shows in that Hive's Progress panel: **e2e: N
suites**, a step per suite, and the time left from how long each suite took before (kept in
`%LOCALAPPDATA%\hive-test\progress-timings.json`). `npm test` does the same, a step per test file. It reports to the
Hive that launched the agent, never to the test copies the suites start (the session's `HIVE_*` variables aren't
passed to them), and it never changes the output or the results. Turn it off with `--no-progress` (e2e) or
`HIVE_PROGRESS=0` (both). The reporting is all in `tests/progressReport.mts`.

`packaged-progress` checks the `hive-progress` wrapper as installed (`dist/win-unpacked`), against a stand-in for the
Agent API; `HIVE_PROGRESS_CHECK_DEV=1 node tests/e2e/packaged-progress.cjs` checks the dev build's copy.

### Contract tests: what a CLI sends Hive

A **contract suite** (`contract-copilot`, #638) runs a CLI through a scripted turn in a test copy, records what it
sends through the developer console's own recording, and compares it with a fixture recorded before
(`tests/fixtures/console/`, which says how to make one): a hook that stops arriving, a hook's field gone or of another
type, or Hive reading a hook differently fails it; a new hook or field is flagged in its log (`FLAG …`) without failing.
They are real-tier suites: they run with `--real` (before a release, and after a CLI update), and when `--affected`
selects them (a change to the console's capture or recording, or to that provider's adapter). A failure after a CLI
update is the point: read what changed, fix Hive's side (or #367's advanced defaults), and when the new behaviour is
right, record the fixture again. `contract-copilot` needs no sign-in: the real Copilot CLI runs offline against the
scripted stand-in model.

### The i18n screenshot route: every screen in another language

Every suite runs Hive in English (`lib.hiveEnv` sets `HIVE_LANG=en`, #767): they find what they click by its English
text, and numbers and dates come out the same on any Windows. Whether the window works in **another language** is
the **i18nshots** route's (#769; #756's design, section 4): it opens each screen and photographs it in both themes, for
a person or an agent to look at. Under the pseudo-locale (`en-XA`: English accented, longer and in brackets) any text
still plain English was missed; under a language, text that is cut off or wraps badly shows.

```bash
npm run e2e -- --lang en-XA,pl --build   # the route alone, in these languages; the screenshots are kept
npm run e2e -- i18nshots                 # as part of a run (the full set, or --affected): en-XA, screenshots not kept
```

- **It finds nothing by its words**, which are translated: IPC calls, the Agent API, command ids (the `menu-command`
  event, as the menu sends) and structural hooks (`data-run`, `data-agent`, `data-action`, `data-stat`, `data-task`,
  classes). A unit test (`tests/i18nshots.test.ts`) fails for a text, role-name, label or title locator in it.
- **It fails when a screen can't be reached** (`FAIL pl: core/banner reached in both themes (<why>)`), or when Hive
  doesn't show the language asked for (a code it doesn't have), **never on wording**: judging the words is for whoever
  looks at the screenshots.
- **Its screens are case files** in `tests/e2e/i18nshots/`, found by name: `core.cjs` first, then each area's
  `<area>.cjs`, written by the card that translates that area, so no two cards edit the same file. A case file is
  `{ area, screens: [{ name, open(ctx), close?(ctx) }] }`: `open()` shows the screen and resolves to the locator to
  photograph (`null`: the whole window), or throws saying what didn't show; `close()` leaves the window as the next
  screen needs it. `ctx` is in the header of `i18nshots.cjs`. A screen that needs a hook gets one in the component, as
  `data-action` on `IconButton` and `data-stat` on the Usage tab's figures did.
- **What it writes**, in its suite folder's `i18nshots-shots` (with `--lang`, or `--keep-files`, copied into the run's
  log folder, `<run>\i18nshots\i18nshots-shots`): `<lang>\<area>-<screen>-<theme>.png`, and `reached.json`, each
  language's screens with the screenshots taken or why one wasn't. `--lang` takes codes separated by commas (or the
  option again), runs the route alone (with another suite, `--all` or `--affected`, the runner refuses) and keeps its
  screenshots; without it the route photographs `en-XA`.
- **Its text report** (#899, `layoutReport.cjs`): `report.txt` beside the screenshots, and `report.json`, list what each
  screen does to its text, a line each, naming the screenshot to open: `board/board (pl): wraps "DO ZROBIENIA" [div.col-head > h3, 2 lines] → pl/board-board-dark.png`.
  Kinds: `ellipsis` (cut off with "…", unless a tooltip shows it whole, or it's a long description cut to a line: a
  label is reported however much is cut), `clipped` (cut off by its own box), `cut-off` (by a box around it: at a
  side, or a line cut in half or hidden at its top or bottom), `outside` (past the window's edge), `wraps` (a short label on two lines or more), `mid-word` (a
  word broken across lines; paths, addresses and ids may break anywhere), `squeezed` (many short lines in a narrow
  column), `overlaps` (text over nearby text; sticky and fixed layers float on purpose), `sideways` (a box that scrolls
  sideways: one line for what is out of its view) and `english` (a message the language translates, shown in English;
  not in a document Hive renders, such as a skill or a note, whose words are its author's).
  Only text that shows counts: text for screen readers, or scrolled away (a list's rows), doesn't. The same
  issue on several screens (the status bar, a sidebar) is one line, saying on how many others. The layout is read once
  per screen, in the dark theme. The run's log gives each language's count; the report never fails it. The
  `i18nreport` suite seeds each kind (the layouts #886, #887, #890 and #892 fixed) on a page of its own and checks
  they're reported and a clean part isn't.
- **Read the report, not the route.** Each screenshot an agent views costs many times its text: read `report.txt` and
  open only the images it flags, a card names or your change touches (a language run is ~170 screens in two themes).
  The screenshots are kept for people to browse. Check a flag before acting on it: a deliberate layout (a tab strip
  that scrolls, a long path cut with "…") is flagged too.
- **A full language run is heavy**: run one at a time on the machine, with load capped (AGENTS.md). A language takes
  about 3 minutes, so a `--lang` run's time limit is 6 minutes a language (at least the usual 10, HI-2159): all seven
  languages fit in one run.

### The installer on a clean machine: the Sandbox checks

The e2e suites test the app on this machine. The **Sandbox checks** (`tests/sandbox`, #538; moved from the hive-mcp
repo in HI-2298) test the **installer** on a clean Windows in Windows Sandbox:
a fresh install and first launch, the first run with no CLIs (#474), a CLI appearing while Hive runs (#472), an upgrade
from the previous release with its settings kept, uninstall, and a new workspace. Two throwaway Sandboxes, about 3
minutes, the network off and Hive's fake CLIs only: no real CLI, sign-in or credential goes in. It writes `report.md`
(pass or fail per check, with screenshots) and passes only with every check run.

- **When:** on each release candidate, once it is built and before the user installs it (RELEASING.md step 1, the
  release-hive skill), with the verdict and report folder commented on the release card.
- **How:** `npm run sandbox-checks -- --installer "<the RC's installer>" --hive "<the main checkout>"
  --report "$env:LOCALAPPDATA\hive-test\sandbox-reports\<version>-rc<n>"` (`--previous <installer>` for another
  upgrade start; `--hive` is only where that is looked for, the newest other installer in its `dist`). It drives the
  hive-mcp project's **windows-sandbox MCP server** over stdio as any MCP client does, starting its own copy of it, so
  it needs no MCP registration: `--server <its server.js>` (or `WSB_SERVER`), else the copy Hive installed from the MCP
  catalogue in the workspace holding `--hive` (`<workspace>\.hive\mcp\windows-sandbox`), else a hive-mcp checkout
  beside it (`<hive>\..\mcp\servers\windows-sandbox`). The server keeps its run folders in
  `%LOCALAPPDATA%\hive-test\sandbox`.
- **What's where:** the runner (`checks.cjs`) maps this checkout's `tests` folder and `playwright-core` read-only into
  the Sandbox, so the scripts that run inside (`tests/sandbox/inside`: the installer runs, the install record and the
  window driver `drive.cjs`) and the e2e fake CLIs are this checkout's. A change to what `drive.cjs` drives (Provider
  Setup's text, the banner, the views, `provider:info`, the Agent API routes) changes it in the same card:
  `tests/sandboxChecks.test.ts` fails when one it relies on is gone. The report is `report.cjs`; the fresh-install
  comparison against a workspace of yours, `node tests/sandbox/compare-workspace.cjs --report <report folder>
  --workspace <workspace>`. Their unit tests (`tests/sandbox*.test.ts`) run in `npm test` against a fake server
  (`tests/sandbox/fake-server.cjs`); the Sandbox runs themselves stay a manual release step.
- **One Sandbox at a time** on the machine: when another is running it says NOT RUN (exit 2); wait, or pass
  `--wait-min 30`. It never stops a Sandbox it didn't start.
- **By hand** (an agent working in a Sandbox through the `windows-sandbox` MCP tools): Hive turns MCP servers on per
  project, not per agent, so until it can give a server to chosen agents only (#537), the server is on only in a
  release-testing project that holds just the release-testing agent (the hive-mcp repo's
  `servers/windows-sandbox/RELEASE-TESTING.md`).
- **The 1.0 upgrade from installed 0.9** (S53, S60 and restore, #1227): `upgradelane` and `boardupgrade` run inside the
  Sandbox against two installs, with `HIVE_E2E_HIVE09` a copy of the installed 0.9 and `HIVE_EXE` a copy of the new
  build installed over it (copies, as `lib.cjs` never starts a Hive from `Programs\Hive`). With `HIVE_EXE` set,
  `lib.launch` starts that packaged Hive.exe instead of the dev build, saying so in the suite's log; `boardupgrade`'s
  step 8 needs an unpackaged build's upgrade hold, so it says NOT RUN there. The Sandbox maps Node, Git and the checkout
  read-only as tool folders; #1227's card has the script.
- **The queue suites on a packaged build** (#1578; S54 and S55 among them, for #1449 and #1539): `queueFixture.cjs`
  starts Hive through `lib.launch`, so `HIVE_EXE` runs them on the build named. A packaged build refuses the test
  copies' channels (`agents:testLegacy`, which makes 0.9 worktree agents, and `slots:test`) and ignores the
  `HIVE_TEST_…` seams, so builders are added in the project folder and work on the slot each card's start lends
  (`q.approve`, `q.approveBy`, `q.startCard`). A part that needs a seam runs only when `q.devSeam(what)` says so, and
  prints NOT RUN on a packaged build. A suite that tests 0.9 worktrees on purpose (a lane carried over the upgrade, the
  Merge dialog on an agent's branch) or that needs the test channels says "Dev build only" and why in its header.
  `tests/e2esuites.test.ts` fails on a queue suite that needs one of these without saying so, and on any suite that
  uses the test channels without saying so (#1580: the suites making 0.9 worktree agents or lending slots through
  `slots:test` are all dev-build tests, each header saying why).
- **What can't run on a packaged build is NOT RUN, never a pass** (#1591). With `HIVE_EXE` set, the runner doesn't
  start a suite that would test the dev build all the same: one whose header says "Dev build only", one that starts
  this checkout's Electron itself (`executablePath: lib.ELECTRON`, not `lib.launch`), and, unless it reads `HIVE_EXE`
  or uses `q.devSeam` (it then handles the packaged build itself), one that needs a `HIVE_TEST_…` seam a packaged
  build ignores or a test channel it refuses. Each is listed `NOT RUN` with why, in the output and the run record,
  which names the packaged build; a `NOT RUN <what>` line a suite prints for a part it leaves out is in the record
  too. A suite is judged with the files it uses: a folder of its name and the helpers it requires (`wakepaste-codex`
  hands over to `wakepaste-cli/run.cjs`), but not `lib.cjs` or `runContext.cjs`. The test is `suiteDevOnly` in
  `runner.mjs`, which `tests/e2esuites.test.ts` uses for the headers; its `DEV_SEAMS` must name every seam `src` reads
  that a packaged build ignores (the unit test lists one missing), and its `PACKAGED_SEAMS` those a quiet packaged build
  honours too: the notify log, the dialog snapshot, asking about leftovers, and the trash folder and tips every test
  copy is given (`takesTestSeams` in `src/main/testQuiet.ts`, #1599). A run where nothing chosen can run packaged still
  writes its record, marked not valid ("nothing was tested"), and fails.

## What they need

- **Claude Code**, installed. **No real suite runs it in your own `~/.claude`** (#368): each one says its home in
  `suites.mjs` (`claudeHome`), and `tests/e2esuites.test.ts` fails for one that doesn't. Suites that start sessions
  without sending a prompt (`claude-real`, `mode`, `plan`, `compact`, `agentview`, and `claudehome`, below) run it in a
  home of their own (`claudeHome: 'own'`, `lib.ownClaudeHome(name)`): a new `<suite folder>\<name>-claude-home` each
  run, with onboarding done and a made-up API key approved, so it starts at its prompt with no sign-in and no tokens.
  The one that sends prompts (`assistantresume`) uses the signed-in Claude Code test home (`claudeHome: 'test'`,
  below). The runner asks Claude Code about the test home's sign-in only, and refuses a Claude suite with no home. Each
  test copy of Hive notes the home its CLIs run in (`HIVE_TEST_CLI_LOG`), and the run record names each real suite's
  ("Real CLIs' homes"); a real suite that ran in your own `~/.claude` or `~/.codex` makes the record not valid. The
  first run in a test folder answers Claude Code's "trust this folder" question (never a sign-in screen). Suites about Hive's own behaviour that only need some
  session running (`quit`, `windows`, `launchrace`, `resume`) use the fake (#194), and so do `agents`, `image`,
  `assistant` and `restart` (#195), whose few checks that only the real Claude Code can answer are in `claude-real`: a
  session starting in a worktree, a relaunch with a new setting (Restart session) bringing the same session back, and
  the Assistant's launch (in the workspace folder, asking for Auto; with Haiku, Claude Code's fallback to Manual).
  These suites (`needs: ['claude']` in `suites.mjs`) are the real tier: only with `--real`, `--only-real`, by name or
  when `--affected` needs them. Run them when what they test can't be done with the fake Claude Code (below), and
  prefer the fake where it covers the case. Warn the user first if one could
  reach a sign-in screen; never send key presses to one.
- **`claudehome`** (#345) runs the real Claude Code in a home of its own (`claudeHome: 'own'` in `suites.mjs`), never
  the default one: a new folder each run with onboarding done and a made-up API key approved in its `.claude.json`, so
  Claude Code starts at its prompt with no sign-in, and is sent nothing (no tokens, nothing reaches Anthropic). It
  checks Hive's hooks with it: SessionStart and the status line (curl reading the header from the launch's auth file)
  reaching Hive, the launch's settings, MCP config and auth file in its private folder in Hive's user data, and the
  token refused once the session ends. The runner asks about no sign-in for it. The other real Claude suites that send
  no prompt now do the same with `lib.ownClaudeHome()` (#368).
- **`claudesettings`** (#333) runs the real Claude Code in a home of its own too, with `-p --init-only` (hooks only,
  no conversation: no sign-in, no tokens), the Claude Code a test copy of Hive selects in that home (started briefly). A SessionStart hook in each settings file shows which
  files it reads under `--setting-sources` and `--restricted`, and which `--settings` files it refuses (over 2 MiB, a
  folder, missing): what Hive's compaction reader and its launch read of a user's `--settings` assume. Run it after a
  Claude Code update; a failure means `providers/claude/autoCompact.ts` no longer matches the CLI.
- **`assistantresume`** (#334) sends prompts (five short ones, with Haiku), so it runs in the **Claude Code test home**
  (`claudeHome: 'test'` in `suites.mjs`: `CLAUDE_TEST_HOME`, `%LOCALAPPDATA%\hive-test\claude`), never your own
  `~/.claude`. Sign in to it once by hand (as for the model trials, tests/scenarios/README.md), then `/exit`:
  ```powershell
  New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\hive-test\claude" | Out-Null; $env:CLAUDE_CONFIG_DIR="$env:LOCALAPPDATA\hive-test\claude"; claude
  ```
  `HIVE_TEST_CLAUDE_HOME` points it at another test home. Without that sign-in the suite is skipped for the
  environment, and never falls back to your own home. It checks that a resumed Assistant answers from its current mode's instructions (a
  codeword only those give), not the system prompt Claude Code recorded: after Restart in This Mode… and after a switch
  while it was stopped. `node tests/e2e/assistantresume.cjs --snapshot-on` is its negative control (the recorded
  prompt asked for: the old codeword comes back).
  The probe waits for the mode notice's finished turn, then matches the codeword reply to the question's new
  transcript item (#473); an acknowledgement of the notice cannot stand in for that answer.
- **`reviewcopiesreal`** (#1439, S51) is real: a Claude Code (Haiku, Accept edits, in the **Claude Code test home**,
  `claudeHome: 'test'`) and a Codex (gpt-6-luna, low effort, Ask, in the Codex test home) reviewer each build and run
  the project's test in their review copy, outside their own folder, within their permission mode (a few short
  prompts: tokens); a Copilot reviewer does the same with the real CLI offline against the stand-in model (no sign-in,
  no cost), which also builds the cards. A question about a command is answered Yes (counted in its output), an edit in
  the copy is never asked about. It checks each reviewer's process has `--add-dir` the copies folder and no CLI's own
  settings name it. A reviewer whose CLI isn't signed in is skipped and said; without Copilot the suite is skipped.
  The fake tier's `reviewcopies` covers the leases, waits and returns.
- **Codex** for the `codex*` suites, signed in to the **test home** `%LOCALAPPDATA%\hive-test\codex` (never your
  own `~/.codex`). Sign in once:
  ```powershell
  New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\hive-test\codex" | Out-Null; $env:CODEX_HOME="$env:LOCALAPPDATA\hive-test\codex"; codex login
  ```
  The suites add their folders to that home's trusted projects and use its non-admin Windows sandbox. They send a
  few short prompts to a small model. Without a sign-in they are skipped.
  A `codex-background` failure records `codex-sandbox-diagnostics.json` and prints its evidence in the suite log:
  bounded sandbox-log entries for the prompt's time window (timestamps there are local), the terminal tail, and
  real suites active in other runners at turn start and failure. `running-suites.json` in each run's logs supplies
  those peer snapshots; a missing or partial snapshot is reported as unavailable. A sandbox START with no result
  is evidence to investigate, not proof of a collision or a reason to skip. Compare the selected CLI version, shell
  path and launch environment with an unchanged solo pass before testing concurrent runs.
  Codex's non-admin sandbox can't start the **Microsoft Store's PowerShell 7** (the shell Codex picks where it is
  installed) while any other process of that package runs on the machine, sandboxed or not (#499, #658): any agent's
  PowerShell command or a pwsh terminal is enough, so it comes and goes with what else runs. Codex then shows
  `CreateProcessAsUserW failed: 5 (Access is denied.)` (`-1073283067` by the package's path) and the command never
  runs. In a CLI step that is an environment SKIP only when that session's Codex transcript records the refusal with
  the command's executable the Store's pwsh (its WindowsApps alias or the package's path; the terminal cuts it off):
  another shell, another code, or a command that can't be read stays a FAIL. Windows PowerShell 5.1 and cmd aren't
  affected, so the suites that run the real Codex (codex, codex-background, codex-extra, codex-handover, codex-mcpapproval, codex-setup, codexoverrides,
  and real Codex scenario trials) give their test Hive a PATH without the Store's aliases
  (`lib.pathWithoutStoreAliases()`, #584): Codex then runs commands in Windows PowerShell, even with a Store pwsh
  open. `leftovers-codex` keeps the Store's on purpose (what escapes through it is its subject, #543), and
  `codex-storepwsh` checks the refusal itself, with a Store pwsh held open: it passes while the sandbox refuses the
  Store's pwsh and starts Windows PowerShell, and fails if Codex starts the Store's one day (then #585 and the PATH
  are to be looked at again). It needs no model (`codex sandbox`), and is skipped where the Store's isn't installed.

## Where they work

Everything goes in `%LOCALAPPDATA%\hive-test\e2e` (override with `HIVE_E2E_DIR`). In it:

- `lanes\<k>\<suite>`: the profiles (`HIVE_USER_DATA`), workspaces and screenshots of each suite a runner in lane *k*
  runs (above). The runner gives each suite a folder of its own in its lane's as `HIVE_E2E_DIR`, which `lib.WORK`
  reads, made fresh when the suite starts (`<suite>-2`… while an earlier run keeps it: Housekeeping, below). When the
  suite passes (or skips), the whole folder is removed; when it fails, it stays for a look (the runner prints where,
  and copies its screenshots and reports into the run's log folder) and goes with that run's logs.
- `logs\run-<date>-<time>`: each run's logs and run record, from every lane (above); `logs\run-record.md` is the latest
  record. The newest ten finished runs are kept, counted across every worktree's and agent's runs, and besides them
  every run that started in the last 24 hours (#1595: with several lanes testing, ten newer runs came within the hour,
  before a reviewer opened the run a builder cited), as long as the logs' run folders come to no more than 2 GB: past
  that, the oldest of those runs go first, passing ones before failed ones, and the runner says how many went early.
  The newest ten are never pruned for size. `HIVE_E2E_KEEP_HOURS` (0: only the newest ten, and failed runs) and `HIVE_E2E_KEEP_MB`
  change the window and the cap for a runner (a value that isn't a number of 0 or more is ignored, and said so). A run that **failed**
  (a suite failed, or its record isn't valid) is kept a day beyond that (the newest twenty such; #223), and its failed
  suites' own files are copied into it, in `<run folder>\<suite>`: the files at the top of the suite's folder
  (screenshots, notification logs, reports) and its folders of screenshots and reports at any depth (`*shots`, such as
  `restart-shots` or `pshots`; `screenshots`, `artifacts`, `reports`; #284), never a profile, workspace, CLI home or
  sign-in file at any depth (inside a screenshot folder too), and never through a link (a suite folder with a link
  anywhere on its path isn't read at all). One file of a CLI home is kept: a fake Claude Code home's `fake-exits.jsonl`
  (how each launch ended, with its code or uncaught error), as `<home>.fake-exits.jsonl` (#1146). A file over 20 MB, or past 500 files or 200 MB in all, is left out (`keepSuiteFiles` in
  `logs.mjs`). The runner says so when the run ends, with anything it left out, so the run folder is the path to cite in
  a card. A suite writing screenshots into a folder of its own names it to match.
- The work folder itself: suites run on their own (`node tests/e2e/<suite>.cjs`) keep their folders there (each run
  empties its own subfolders, and its screenshots replace the last run's). To keep a run's screenshots, run it through
  the runner with `--keep-files` instead: they land in that run's new log folder.

Nothing touches your Hive profile, your clipboard, your real Claude Code and Codex homes (#368, #382: above) or your
**Recycle Bin**. What Hive moves to the
Recycle Bin (Delete in Files, notes, skills, templates, cards, session copies, Clean Up, Delete Project) a test copy
moves into its suite's trash folder instead, `<suite folder>\trash` (`HIVE_TEST_TRASH_DIR`, set by `lib.hiveEnv`;
without it, a test profile's `test-trash`; a packaged Hive too, `HIVE_EXE` or `dist\win-unpacked`, when quiet:
`HIVE_TEST_QUIET=1`, which `hiveEnv` sets, #1599), which goes with the suite's folder (#414). A move is one rename, whole or not at all (an item on another drive than
that folder is refused, changing nothing), and then a line in its `trash.jsonl` (`{ at, from, to }`; best effort: a
line that can't be written is a warning in the test copy's log, and the deletion still counts): a suite checks what it deleted arrived with `lib.trashed(path)` (`board`, `files`,
`storage`, `sessiontree`). Hive's one way there is `trash()` in `src/main/trash.ts` (`tests/trash.test.ts` fails for a
direct `shell.trashItem` anywhere else); the installed app and `npm run dev` use the real Recycle Bin. The runner counts
the Recycle Bin, read only, before and after a run, and says so under the summary and in the run record ("Recycle Bin:
266 items before and after the run").
`HIVE_TEST_CODEX_HOME` points the Codex suites at another test home.

**A process that fails to start** (#599): under heavy load Windows can fail one as it starts (0xc0000142: its desktop
heap runs short with many processes at once). Node sets the error mode that keeps Windows' error dialogs away
(SEM_FAILCRITICALERRORS), Electron keeps it, and whatever the runners, the suites, the unit test workers and the test
copies of Hive start directly inherits it. Something started through the shell (PowerShell's `Start-Process`, `start`,
a file opened by its association) starts without it, so test tooling never does that (`tests/windowsExits.test.ts`
checks). That is no promise that a run can't hang on a dialog: see the end of this paragraph. Nothing machine-wide is
changed. The runners say such a code with what it means (`windowsExits.cjs`): in a failed suite's line
(`FAIL 3s (exit 0xc0000142: a DLL failed to initialise as it started, usually Windows' desktop heap running short …:
rerun with fewer runs at once)`), under it for a code its output names (a child's, or Electron's that didn't start), and
in the run record. Seeing 0xc0000142, run fewer test runs at once rather than looking for a fault in the code.
**Such a failure can still show a dialog and hold the run:** logged under load, the desktop heap running out showed
Windows' "Application Error" dialog even for processes that had the error mode (children of Vitest workers during full
unit runs beside e2e runs), and the process waits behind it until someone clicks OK. Fewer heavy runs at once makes it
rarer (a full unit run is a heavy run, above); only a machine-wide setting, left to the machine's owner, would stop it.
The `failfast` suite checks the reporting (a child ending with 0xc0000142 is seen at once, and said), not that a real
startup failure shows no dialog.

## Housekeeping

**Test copies of Hive never outlive their run** (HI-1453: one ran on 12 hours after its suite, its runner gone, and held
its lane's port, so no later runner took that lane). Playwright starts Electron through `cmd.exe /c`, so the pid it
gives is that shell's: a killed suite takes the shell with it, while Hive's main process, the shell's child, runs on.
`lib.cjs` records each copy's main process as it starts (the shell's child, by the process tree), by pid and when it
started, in the suite's folder (`.hive-copies.jsonl`, looked up in the background, so a launch returns as before).
Once a suite has ended, however it ended (passed, failed, timed out, killed), the runner ends what is left of the
copies it recorded (`folderProcesses.cjs` `endCopies`); and each run's start, before it takes a lane, ends the copies
an earlier run recorded in the lanes no running runner holds, started before it looked (`leftCopies.mjs`). Only what
was recorded, and only while it is still the process recorded (pid and start time): never by name (the installed Hive
is `Hive.exe` too) or by reading command lines, which can't be read reliably. What only looks like a copy there (a
profile flag naming the lane's folder) with no record (a record not made before its suite was killed, a run from
before records) is listed in the run's output with its pid and command line, for you to look at, and left running.
`harnessleftovers` checks all of it with real copies.

What the tests leave in `%LOCALAPPDATA%\hive-test` is removed once it is no longer needed (`clean.mjs`, #253). The e2e
runner and the scenario runner do it when they finish (at most a minute; what is left goes next time), and
**`npm run test:clean`** does it on demand and prints each area's size (`--dry-run` lists what would go, and what is
kept and why, without removing anything; `--days N` sets the age, default 3).
- **Goes:** in a lane no runner holds (by the machine pool's claims, whatever pool the runner that cleans up uses, #1133; the clean-up claims it meanwhile, so no runner starts there), every suite
  folder no run's logs claim, whatever its age (a failed suite's is claimed until its run is pruned: below), and
  anything left from before suites had folders of their own; in scenario lanes, numbered copies (`<scenario>-2`…) and
  folders older than the age; in `e2e`, anything but `lanes` and `logs` older than the age (suites run on their own,
  probes); in `tmp` (the unit tests' temp folders: tests/README.md, #992), anything older than a day (or `--days`, if
  less); and anything else in `hive-test` older than the age (one-off folders and files).
- **In the Codex test home** (`codex`, #404), which otherwise only grows (1.8 GB by 8 Oct 2026): its rollouts older
  than the age (`sessions\YYYY\MM\DD`; a folder whose rollouts are all that old goes whole), package copies Codex no
  longer runs (`packages\<name>\releases\<version>` that is neither its `current` link's target nor the version
  `auto-update-version` names: 430 MB each; when the link or marker is blank, malformed or names no release there,
  every release of that package stays) and downloads it left unfinished in `cache` (`.tmp*`) older than the age.
  Only under the home's lease (`codexHomeLock.mjs`, the one real Codex suites and scenarios hold), taken without
  waiting: while a run holds it, nothing there goes ("a run is using the Codex test home"), and it goes next time.
  Once it holds the lease, the clean-up plans the home again and checks each item just before it goes, so a release
  Codex took up or a rollout it refreshed since the first look stays. Nothing is looked in or deleted through a link
  (a junction or symlink anywhere on the path, the home's own included).
  Never its sign-in (`auth.json`), config, sandbox setup (`.sandbox`, `.sandbox-bin`, `cap_sid`), databases (Codex
  prunes its own logs), plugins, skills or history. What stays is about 0.8 GB, most of it the copy of Codex it runs
  (430 MB) and the sandbox's (320 MB). The Claude Code test home is small (about 80 MB) and isn't opened.
- **Stays:** the CLI test homes' sign-ins, config and sandbox setup (`codex`, but for the above; `claude`, never opened), scenario results and baselines (a scenario run's own start keeps the newest 30 fake runs' results and the newest 30 model trials', those cited and those a run still writes into: tests/scenarios/README.md), the
  claims and locks, the concurrency checker's folders (it removes its own), the Progress panel's timings, the machine's test settings (`config.json`: `heavySlots`, #589); logs (the
  runner keeps the newest ten runs); a lane a runner holds.
- **Evidence stays, whoever deletes** (`evidence.cjs`): anything a card that isn't Done cites is kept by the clean-up,
  by the runners' own deletions (a suite's or scenario's earlier folder, a passed suite's folders, log pruning,
  scenario results and older baselines) and listed as `kept: … (cited by #n)`. A card cites a path by writing it: the
  thing itself (`e2e\review158-dark.png`), a path inside a folder (`evidence\x.png` keeps `evidence`;
  `lanes\0\board\board.png` keeps that suite's folder, not the rest of the lane), or a folder as a whole
  (`hive-test\evidence`, `lanes\0\board\`). A name alone isn't a citation, nor an area: `hive-test\e2e`, `scratch`, and
  **a lane** (`e2e\lanes\0`), which is where runs keep their suites' folders, not evidence (#285: cards naming lane 0
  kept every folder every later run made there, 2,078 of them, 23 GB in six hours). The cards are read from the
  workspace's board, found up from this repository's main checkout, afresh for every deletion (a card that cites
  something a moment before it would go keeps it). **Without the board** (none found, or a card that can't be read)
  the runners don't start: nothing they made could be removed. Set `HIVE_TEST_NO_BOARD=1` on a machine where no Hive
  board cites test output. Should the board become unreadable during a run, nothing is deleted meanwhile and what
  stays is tied to the run.
- **A suite's folder** in its lane (`lanes\<k>\<suite>`): when the suite passes, the whole folder goes; when it fails
  (or something in it must stay), it is tied to the run (`.kept-folders.json` in the run's log folder) and goes when
  that run's logs are pruned (the newest ten runs, a day's runs up to 2 GB, a failed run a day): only in a lane the pruning runner may work in
  (its own, or an idle one it claims; in a lane another runner holds it is left, and the clean-up removes it once the
  lane is idle, since no run claims it then), and only if every entry of that list is a suite folder in a lane
  (`e2e\lanes\<k>\<suite>`, or a nested run's inside one), never a test home, results or a lane itself. While an earlier run keeps `<suite>`, a run
  takes `<suite>-2` (…), at most 32 copies: past that the suite is refused, saying what keeps them, rather than filling
  the disk.
- Links in what goes (a worktree's `node_modules` junction) are removed as links, never followed.
- **Something still holds it** (another lane's process working there, a scan, an open handle: EPERM, EBUSY, ENOTEMPTY
  or EACCES, after a few tries): it is kept and named, never a failure. The runner prints `Kept <run folder>: something
  still holds it (EPERM)…` and a later run prunes it; its exit code stays its suites' (#1616). The clean-up counts such
  an item as kept (in use), and a suite folder a pruned run kept is left for the clean-up.

**Probes** (a reviewer's or builder's screenshots, scripts and profiles outside a suite) take **a new folder each run**,
so nothing needs deleting before a rerun (#304): `require('./tests/e2e/lib.cjs').probeDir('<what>')` makes
`hive-test\scratch\<what>-<date>-<time>-<random>`, which the clean-up prunes by age; or a new folder of your own in your
scratchpad (Claude Code's session scratchpad, or `%TEMP%`). Never in the lanes or logs. A folder that has to be reused
is emptied from Node with `npm run e2e -- --clear-dir <folder>` (`clearDir` in `evidence.cjs`): only inside a Claude
Code scratchpad, a `hive…` folder in `%TEMP%`, or `hive-test\scratch` or `e2e` outside the lanes and logs; never an area
itself, a CLI test home, a link or what a card cites. Cite evidence a card needs by its full path: it stays until the
card is Done.

## Writing one

Start from an existing suite and use `lib.cjs`:
- `hiveEnv({ HIVE_USER_DATA, … })` as the environment of every test Hive it starts (or `launch()`), `childEnv({ … })`
  for a child that is part of Hive (the hive MCP server, `hive-progress`); never `process.env` (Run context, above);
- `port(<default>)` for its Agent API port (never a fixed number, so it can run beside others); add it to an area in
  `affected.mjs` and to `suites.mjs` (sorted), with `serial: '<why>'` if it can't run beside others;
- `until(fn, ms)` to wait for what you expect to see, never a fixed `sleep()` and then a check, nor a single read just
  after an action: the rules every test follows are in [tests/README.md](../README.md) (Tests wait for conditions,
  never for time), and reviewers check them;
- `enableProviders()` for the profile, `launch()`; `fakeClaude(userData, home, trusted)` to run the fake Claude Code
  (below) when the suite only needs some session running;
- `addAgent()` / `soloAgent()`: projects start without agents;
- `acceptClaudeTrust()`, `trustForCodex()`, `gitProject()`, `samplePng()`;
- `skip('<why>')` when the suite can't run on this machine (the record shows the reason);
- in a real-CLI suite, `cliStep(name, { session }, fn)` around each step that waits on the CLI answering, with
  `checked(ok)` in the suite's `check` (above: how an environment failure there becomes a SKIP).

**Slow or failing calls** (unpackaged builds only): `HIVE_TEST_SLOW_IPC="tasks:start=2000,git:diff=3000*1"` delays those IPC calls (`*n`: only the first n) and `HIVE_TEST_FAIL_IPC="git:status*1"` makes them fail; `HIVE_TEST_BLOCK_IPC="app:info=1500*1"` holds the main process that long in them, a stall the log's busy warning names (`stalls`, #1109, with `HIVE_TEST_STALL_QUIET_MS` shortening the minute between warnings). Hive reads them again when they change, so a suite can set them in the main process while it runs (`app.evaluate(() => { process.env.HIVE_TEST_SLOW_IPC = '…' })`). `busy`, `changes` and `loadfail` use them. `HIVE_TEST_SLOW_DETECT="claude-code=12000"` holds that provider's detection at start, so another answers first, and `HIVE_TEST_DETECT_WAIT_MS` shortens how long a launch waits for detection before it is refused (`providerdetect`, #506); a test launch that holds one can't use `lib.launch`, whose `appReady` waits for every provider. `HIVE_TEST_SILENT_MS` shortens how long a running turn may be silent before Hive looks for its end on screen or says its state is unknown (five minutes; `turnledger`, #648). `HIVE_TEST_FLIGHT_AFTER_MS` shortens how long the flight recorder waits after a trigger before it writes its capture (ten seconds; `flightrecorder`, #698). `HIVE_TEST_QUEUE_RETURNS` makes the window's merge queue model list fewer returns (50; the rest are counted), so a suite passes that bound with a few cards; read at each listing, so a suite can set them in main as it goes (`progressqueue`, #1356).

**Restarting Hive** (unpackaged builds only, #676): Settings → Advanced's **Restart Hive** quits and starts Hive again. With `HIVE_TEST_RELAUNCH_LOG=<file>`, a test copy writes the relaunch it would make to that file as a JSON line (`{ args }`) instead of making it, so no copy of Hive outlives its suite (`hwaccel`).

**The registry's PATH** (unpackaged builds only, #472): Hive adds the folders of the PATH Windows gives new programs to its own before it looks for the CLIs. A test copy (a test profile) never reads the machine's: `HIVE_TEST_REGISTRY_PATH` (`;`-separated folders, none when unset) stands in for it, and a suite can change it while Hive runs, as an installer would (`freshpath`). So a suite's PATH without a CLI (or git, `gitmissing`) stays without it.

**Quiet test copies** (unpackaged builds only): a copy of Hive started with a test profile (`HIVE_USER_DATA`, which every suite sets) is quiet, however it was started (the runner, `node tests/e2e/<suite>.cjs`, a scenario or a Playwright script), and so is one started with `HIVE_TEST_QUIET=1`. `HIVE_TEST_QUIET=0` turns it off, for a suite that needs a real window (listed in `LOUD` in `tests/testQuiet.test.ts`, which fails for a suite that starts Hive without a test profile or turns quiet off unlisted). So the copies of Hive the suites start never interrupt you: their windows open off screen, to the left of your screens, and never take focus (`showInactive`; Chromium's occlusion tracking is off for them, so they still draw), and they raise no Windows notification, taskbar flash or chime (`src/main/testQuiet.ts`; the window still counts a chime, for `window.__hiveChimes`). Set `HIVE_TEST_NOTIFY_LOG=<file>` to have each notification, flash and chime they would have made written there as a JSON line (`{ kind, title, body }`); `bursts` checks its notifications that way. The message Hive shows when it can't start from its install folder (`src/main/installDir.ts`) is recorded there too (`kind: 'dialog'`), and `HIVE_TEST_DIALOG_SNAPSHOT=<png>` draws it off screen to that picture without showing it; `HIVE_TEST_INSTALL_DIR` makes Hive check a test folder's permissions instead of its own folder's (`installdir`). Quitting with processes agents left running asks in a native dialog (#507), which a quiet copy skips (leaving them running, and listed again at its next start: `leftovers-restart`, #614) unless started with `HIVE_TEST_ASK_LEFTOVERS=1`: `leftovers` sets it and stubs the dialog, and sets `HIVE_TEST_JOB_KILL_FAILS=1` in Hive's main process while it runs to make ending them fail, as Windows refusing would, and starts a second copy with `HIVE_TEST_PROCESS_TRACKER=silent` and `HIVE_TEST_TRACKER_WAIT_MS=3000` (a tracker that never gets going: agents start untracked, with one notice; `=fail` acts out one that can't start at all). Suites that need a focused window stub it (`inbox`, `progress`, `taskbar`) rather than taking OS focus. Maximising is simulated the same way: `carddialog` gives its off-screen window a screen's work-area size, makes `isMaximized()` say so and emits `maximize`/`unmaximize`, which checks Hive's handling of them (the card kept in the window, the title-bar buttons dimmed) but not Electron's and Windows' own maximise. For that, run it on its own with **`HIVE_E2E_NATIVE=1 node tests/e2e/carddialog.cjs`** (PowerShell: `$env:HIVE_E2E_NATIVE='1'; node tests/e2e/carddialog.cjs`): the same checks with the real `maximize()`/`unmaximize()` in a normal window, which **comes on screen, takes the focus and fills the screen** while it runs, so only when asked. The runner drops `HIVE_E2E_NATIVE`, so full and `--affected` runs stay quiet.

**React's commit bursts and chains** (HI-1387, HI-1865): a render loop (a setState per event in a useEffect, #1366)
only throws once React's nested-update limit (50) is passed, and a production build says nothing before then. So a quiet
test copy's window counts React's commits through a DevTools hook installed before React DOM loads
(`src/renderer/src/commitWatch.ts`; main passes `--hive-commit-watch` to a test copy's window only), and says on its
console each new largest burst (the most commits within 250 ms) and each new longest chain (commits with nothing from
outside between them: no input or other DOM event, no message or reply from main, which the preload marks, and no
timer's or frame's callback; React's own scheduling, through a MessageChannel and microtasks, keeps a chain going).
`lib.cjs` collects both from every window of the suite's test copies: each suite's largest is an `INFO React commit
burst` and an `INFO React commit chain` line as it exits (and one at the time it first reaches 50), and the runner lists
each suite's at the end of the run. **A chain of 50 fails its suite** as it exits (a `FAIL React commit chain` line and
exit code 1, set even after the suite's own `process.exit(0)`): a full fake run's normal suites stayed at 8 or under
(HI-1865), so a loop stands out. A suite that makes one on purpose says so with `lib.acceptCommitChain(why)`. Bursts
are recorded only: fast typing makes one as large as a loop's (HI-1864), but each key starts a new chain.
`commitburst` checks a deliberate loop is caught (its burst and chain both reach 50) and typing's chain stays short,
shows a child run failing at a chain of 60 and passing once it accepts it, and accepts its own loop.

**Tips** are off in every test copy of Hive (`lib.hiveEnv` sets `HIVE_TEST_TIPS=off`, which unpackaged builds and quiet packaged ones take, #1599: a profile that doesn't set *Show a tip when Hive starts* gets it off), so no tip card covers what a suite clicks. A suite about tips (`tips`) turns them on in its profile.

**A fake Claude Code** (`fake-claude/fake-claude.cmd`) runs agents without signing in or spending tokens: set it as
the profile's Claude Code path (`settings.providers['claude-code'].executablePath`) and start Hive with
`CLAUDE_CONFIG_DIR` pointing at a test folder. It goes through Hive's real Claude Code adapter: it asks to trust a
new folder (Enter trusts it), sends Claude Code's hooks, writes its transcripts, starts on a task given on the
command line, and answers each prompt after a second (`work N` takes N seconds; `edit <file>` makes an Edit, with
its file lock; `pad N` adds N KB to its transcript; `ask` sends a permission prompt; `window N` makes its status line report an N-token context window; `boardmove N COLUMN` moves card N as its hive tools would, and `boardreview N ACTION [COLUMN]` reviews it (both recording the answer in `fake-calls.jsonl`); `background N` starts a background command that ends after N seconds, whose task notification then
starts a turn by itself (a UserPromptSubmit with the notification as its prompt, under a new `prompt_id`, as Claude Code 2.1.296 does, #648); `/compact [focus]` compacts (under a `prompt_id` of its own, as Claude Code 2.1.296 does; PreCompact, a compaction in the transcript after 1 s or `hold N` seconds, PostCompact; `compactfail` in the focus fails it, and with no messages yet it says "Not enough messages to compact."); it acts out what Claude Code does by itself while idle (#612): `fake-idle-notify.txt` (N) in its home sends the idle notification (idle_prompt) N ms after a turn, `fake-idle-compact-<agent>` compacts while idle (until `fake-idle-compact-done-<agent>`), `fake-recap-<agent>` writes a recap, and `loststop` in a prompt ends its turn without a Stop reaching Hive; each turn has its own `prompt_id` in its hooks, with Claude Code 2.1.296's spinner ("esc to interrupt") while it works and its "✻ Worked for Ns · done H:MM" line above its input once done (#648), `latetool` sends a Read's PostToolUse after the turn's Stop, and `stopcontinue` goes on after its Stop as when another Stop hook blocks (once `fake-continue-<agent>` is in its home: a tool call in the same turn, held until `fake-continue-done-<agent>`, then Stop with `stop_hook_active`); it records a conversation's system prompt (the `--append-system-prompt-file`) on its first request and uses that record on resume, as Claude Code does, unless launched with `--system-prompt-snapshot off`, and `whatmode` in a prompt ends its reply with the mode that prompt is in (#334); `--model fail-start` makes it refuse to start, printing an error and exiting with 1; `/crash` typed in it exits with 1 at once, a crash). Each launch is recorded in `fake-launches.jsonl` in `CLAUDE_CONFIG_DIR` (its options and
`CLAUDE_CODE_*` variables), and a hook that didn't reach Hive (a failed post, or an error status) in `fake-hook-errors.jsonl` (#684). Suites type a prompt into it with `lib.fakePrompts(inv, key, live, { home })`: typed once the fake takes prompts (its last turn over on its screen too, or the Enter is lost), and waited for by its own turn (the prompt in its conversation, a reply after it, Hive's turn ledger over), never by the status alone, which still says the last turn's "finished" until the fake takes the new one (#672, #684). `assistant-control`, `context`, `background`, `longsession`, `resumeall`, `cardchip`, `sessionorigin`, `assistantend`, `tipcorner`, `review`, `reorder`, `busy`, `startfail`, `filelinks`, `quitwait`, `rendercrash`, `bursts`, `taskbar`, `ctxpercent`, `donemove`, `doingmove`, `paneheader`, `tabstrip`, `closewindow`, `storage`, `skilldelivery`, `quit`, `windows`, `launchrace`, `resume`, `agents`, `image`, `assistant`, `restart`, `idlestatus`, `turnledger` and `board` use it (`board` also deletes a small test folder, as Delete Project does, and `storage` its fixture attachments and backups, as Clean Up does: into the suite's own trash folder, below). `codex-background` checks Codex's background
terminals with the real Codex (one short prompt).

**Typing a line into an agent Hive can wake** (#1553, #1560): Hive may type a wake into it at the same moment, and the wake's Ctrl+U clears the suite's line, or the two lines mix, or the line lands while the agent is busy with the wake and is dropped; a suite that typed, slept and pressed Enter then waited its whole bound for nothing. So suites type such a line with `lib.typeLine(inv, key, home, agent, text, { live })` (`agent` null: the live entry's name): with the fake's input log on (`fake-input.jsonl`: `lib.fakeClaude` turns it on, `lib.logFakeInput(home)` where a suite makes the home itself, before the fake starts), it types once the agent takes prompts and its line is clear, presses Enter once the CLI has read the line whole, counts it only when nothing else was on it or between it and its Enter, and types it again when it was disturbed, dropped (`fake-dropped.jsonl`) or not taken (taken: a turn of its started, never its command's end; `taken` for another sign). `fakePrompts().type` uses it when the home's input log is on. `progressreport` shows it types again (`disturb`). Every suite with a wake source (cards, lanes, messages or watches) types this way, except: a fake Codex (no input log: `codexqueued`, `carryingon`'s Codex agent); keystrokes under test (`replytell`'s replies in the builder, which a second try would send twice; `agentwatch`'s half-typed line; `wakeuntaken`'s Enter; `idlequestion`'s Esc, the user putting off the CLI's own question); and suites whose agent nothing can wake (no cards, lanes, messages or watches: `assistantcompact`, `assistantend`, `closewindow`, `footerfit`, `longsession`, `reorder`, `resumeall`, `sessionorigin`, `sessiontree`, `slotsessions`, `startbusy`, `tipcorner`, and the `fakePrompts` suites `assistantmode`, `assistantsettings`, `ctxpercent`, `sessionname`), which keep a pause before Enter on purpose (the fake reads a typed line before its Enter, as a CLI does).

**Copilot offline** (`fake-copilot-api.cjs`, #453): no fake CLI, the real one. `startFakeCopilotApi()` starts a scripted stand-in for Copilot's model, an OpenAI-compatible chat completions API on a port of its own; `copilotTestEnv(api, dir)` gives a test Hive the environment for it: Copilot offline in its BYOK mode (`COPILOT_OFFLINE`, `COPILOT_PROVIDER_BASE_URL`, `COPILOT_MODEL=gpt-4.1`), its own `COPILOT_HOME`, a fake profile folder, and the GitHub CLI's login hidden (`GH_CONFIG_DIR` empty, `gh` off PATH: with no stored login Copilot signs in with `gh auth token`). The "model" does a prompt's steps, separated by ` then `, one per request: `skill NAME`, `hive TOOL {json}`, `boardmove`/`boardreview`/`boardcomment`, `work N`, `edit PATH OLD NEW`, `write PATH TEXT`, `shell COMMAND`, `question` (Copilot's ask_user) and `say TEXT` (the last reply). Copilot then runs its own tools, hooks, MCP servers and transcript as it would for a real model; each request is logged with the tools it offered. Never run `copilot login` or `logout` for a test: its sign-in is in Windows Credential Manager, per account, not in `COPILOT_HOME`. `copilot` and `copilotsize` use it; so does `npm run scenarios -- --provider fake-copilot`.

**Copilot's skills from folders above** (#1308, Copilot 1.0.100, checked with `copilot skill list` and marker skills): besides its project's `.github/skills`, `.agents/skills` and `.claude/skills`, Copilot takes as "inherited" skills those of every folder above its working folder, up to the git root inside a repository, otherwise up to its profile folder (`USERPROFILE`/`HOME`, not included) or the drive's root. A test folder is under the user's profile (`%LOCALAPPDATA%\hive-test`) while the test's profile is elsewhere, so a Copilot working outside a repository (the Assistant's home, `<workspace>\.hive\assistant`) walked up to the user's own `~\.claude\skills`. So `copilotTestEnv(api, dir, { above })` makes `above`, a folder above every folder the test's Copilot works in (the suite's `lib.WORK`, a scenario's run folder), its profile folder, where the walk stops; it's required. Hive's own Copilot sessions do the same as Copilot run by hand: a project in a git repository stops at its root; the Assistant's home, or a project outside a repository, under the user's profile takes the user's `~\.claude\skills` too.

**A fake Codex** (`fake-codex/fake-codex.cmd`) does the same for Codex: set it as `settings.providers.codex.executablePath` and start Hive with `CODEX_HOME` pointing at a test folder (with `[windows] sandbox = "unelevated"` in its `config.toml`, so nothing is left to set up). It reports itself as Codex 0.160.0 (`FAKE_CODEX_VERSION` changes it) and sends Codex's hooks and terminal titles for a few prompts: `review allow` / `review deny` (its auto-reviewer answers a permission request), `approve` (an approval prompt: `y` approves, Esc rejects) and `question` (an async question it works on beside: `a` answers it). Each prompt is a turn with its own id in its hooks (`turn_id`) and its rollout (`task_started`, and `task_complete` after its Stop), as Codex 0.162.1 has them; for the turn ledger (#648), `latetool` sends a command's PostToolUse after the turn's Stop, `loststop` sends no Stop (the rollout still records the end) and `silent` neither. `attention`, `turnledger` and `flightrecorder` use it, and so does `skilldelivery` (with the fake Claude Code); each launch is recorded in `fake-launches.jsonl` in `CODEX_HOME` (its folder and arguments).

Print `PASS name` / `FAIL name` per check, and add the suite to `SUITES` in `run.mjs`.

**Agent behaviour** (do agents use Hive's skills and keep its board rules?) is tested by the scenarios in `tests/scenarios` (`npm run scenarios`), which reuse `lib.cjs` and the fake CLIs, with opt-in model trials: see its README.
