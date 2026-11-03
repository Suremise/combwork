---
name: investigate-flake
description: Investigate a test that fails intermittently in Hive - does it still happen, reproduce it alone and under load, find the race, fix it with a condition rather than a timeout, prove the fix with repeated runs, and close it only with evidence. Use when a card or a run says a test is flaky, intermittent, passes alone but fails in a full run, or fails under load.
---

# Investigate a flaky test

A flake is a test whose result depends on timing or on what else is running. Each step below is one check, and the record of each is what closes the card.

## 1. Does it still happen?

- Find its history first: the card that cites it, the run records and logs (`%LOCALAPPDATA%\hive-test\e2e\logs`, one folder per run), and the test's own log. Note the commit each failure ran on: a failure on older code proves nothing about today's.
- Reproduce it alone: `npm run e2e -- <suite>` for an e2e suite, `npx vitest run <file>` for a unit test. This shows whether the test fails at all. It does not load the machine.
- Reproduce it under load, and make sure the load is there. A repeat of one suite alone is only repeats: nothing runs beside it. Run it with its **neighbours**, the suites that exercise the same area (its area's suites in `tests/e2e/affected.mjs`), enough of them to fill the runner's four jobs (`--jobs 4` is the default), three times: `npm run e2e -- <suite> <neighbours> --build --record --repeat 3`. If it doesn't fail that way, add load before concluding (more neighbours, more `--jobs`, up to 2 spinner workers) and say what you added. Keep the load modest and bounded: at most 2 spinner workers and 3 repeats per repro (AGENTS.md, **Tests per card**: flake work), never one per core. A saturated machine overheats (95 °C on 16 Oct), slows every other lane, and makes a flake look worse than it is. For a unit test: its file and the files near it (`npx vitest run <files>`), three times in a row, while a focused e2e run or up to 2 spinner workers load the machine.
- A flake seen only under a full run's load (the full unit run or the full e2e set) waits for the release window, when those runs happen anyway (AGENTS.md, **Tests per card**), unless it blocks merges: say so on its card and leave it there.
- A script of your own that starts the load sends what it runs beside straight to files (`stdio` a file's descriptor), never a pipe it may not read: a loop of `spawnSync` blocks its own event loop, a pipe it was to read fills, and the run writing to it stops where it stands (Vitest's main process blocks, and a worker's lazy `import()` waits on it), a hang that's the probe's, not the test's (HI-2147).
- The full set (`--all`) repeated is not the way to reproduce or prove a flake: it holds a heavy test slot for over an hour while other lanes queue, and under that load it fails on other lanes' flakes. Run it repeated only when the user asks.
- Write down, for each run: the command, the count (runs, passes, failures), the failing check, the load (the suites run beside it, `--jobs`, what else was running), and whether Windows Defender exclusions were on (scanning can hide a flake, or cause one). Without admin, read the exclusions from event 5007 in the `Microsoft-Windows-Windows Defender/Operational` log (`Get-WinEvent … -FilterXPath "*[System[EventID=5007]]"`, the newest per path; its times are local).

## 2. Find the race

- Read the failing check's name and its log line, then compare what the test waits for with what it assumes. A flake is a gap between the two.
- Typical causes in Hive: a Windows file lock (EPERM on teardown, `index.lock` in git), a wake or a keypress not yet taken, focus or timing in the UI, lane folders shared between runs, a real CLI home (#368), an antivirus scan holding a file.
- If the state at the failure is unknown, add evidence to the test (a screenshot, the page's status, the file's contents) and run it again before changing anything.

## 3. Fix with a condition, not a timeout

- Wait for the observable state: `lib.until(fn, ms)` (`vi.waitFor` in a unit test) with a check that says what is awaited, not a fixed `sleep()`. The rules every test follows are in [tests/README.md](../../../tests/README.md); the fixed test must meet them all.
- Teardown that can hit a lock retries with a cap, and each run uses its own folder.
- Don't delete from a shell on a computed path, whatever the shell (`rm -rf`, `Remove-Item -Recurse`, or any recursive delete). Use what the repo provides: `lib.probeDir('<what>')` for a new folder, `npm run e2e -- --clear-dir <folder>` to empty one, and `npm run test:clean` to prune what tests leave. The rule and the helpers are in AGENTS.md (no shell deletes on computed paths) and [tests/e2e/README.md](../../../tests/e2e/README.md) (Housekeeping); don't invent a second procedure.
- A longer timeout is not a fix, and neither is skipping the test. If the only option is a timeout, say so on the card and ask.

## 4. Prove it

- Repeat the fixed test under the load that showed the flake, on a verified build (`--build --record`): the suite with its neighbours three times (`npm run e2e -- <suite> <neighbours> --build --record --repeat 3`), or the unit test's files three times under load (step 1). A repeat of one suite alone doesn't count as that load. A later pass doesn't make up for an earlier failure: start a new repeat. These focused repeats, with the cause shown and their run record, are the proof the card needs.
- The full-set check is the next full run on the integration branch, when the lanes go quiet, or before the release (#1010: merges run focused checks only, tests/e2e/README.md). Don't run or repeat the full set for the card unless the user asks. A failure there in another lane's suite doesn't count against the card: add a card for it.
- Where it is cheap, check that the old wait fails in the same conditions. A fix that passes either way proves nothing.
- **Keep every proof run's output and cite it on the card**, or the reviewer can't inspect the proof and the round is lost (#981, #1149, #1150). An e2e repeat with `--record` keeps its logs and run record in its run folder (`logs\run-<date>-<time>`); anything else (a unit test's repeats, a spinner's or a script's output) is written to a new folder from `lib.probeDir('<card>-proof')`, never to the console alone. For each proof, the card says the command, the load (the suites beside it, `--jobs`, how many spinner workers), the number of runs and the passes, with the folder's full path: "3/3 passed with 3 neighbours, `--jobs 4` and 2 spinner workers: `C:\Users\…\hive-test\e2e\logs\run-…`". A path a card cites is kept from the runners' pruning while the card isn't Done ([tests/e2e/README.md](../../../tests/e2e/README.md), Housekeeping: evidence stays).

## 5. Closing

- "No longer reproduces" needs that evidence: the focused repeats under the load that showed the flake, on the commit that's being closed, with the environment noted (Defender exclusions on or off). Leave a watch-for note on the card.
- A flake that won't reproduce but whose test can be made cheaper (less work, never a longer bound): make it cheaper unasked and show before/after timings under load. Ask the user only when there's nothing cheaper.
- Link duplicate cards to the one that's fixed. The user archives them.

## Report

Cause, evidence (run folders by their full paths, kept as step 4 says, and commits), fix (what changed and why it's a condition), and runs (commands, counts, load, environment). Follow [tests/e2e/README.md](../../../tests/e2e/README.md) for the runner, the record and `--repeat`, and AGENTS.md for test isolation: don't restate them here.
