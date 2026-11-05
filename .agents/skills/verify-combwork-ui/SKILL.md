---
name: verify-combwork-ui
description: Check a change to Combwork's window works by driving the real app - build the exact code under review, run the matching end-to-end suites or a short Playwright script in a throwaway profile, and look at screenshots. Use when developing or reviewing Combwork and a change affects what the user sees or clicks, or when source and running behaviour seem to disagree.
---

# Verify Combwork's UI

Unit tests don't show what the user sees. This is how to see it without touching a real Combwork.

## Build what you are checking

- Build the code under review in the folder Combwork gave you (the card's slot, or the review copy): `npx electron-vite build` there. Suites run `out/` of the folder they're started from, so a build from another branch tests something else.
- When behaviour and source disagree, first find out which build ran. The installed app (`%LOCALAPPDATA%\Programs\Combwork`; an installed 1.0, `Programs\Hive`) and a dev build are different code. `GET /v1/status` gives `app.version` and `guidance.revision`, and `/v1/projects/{name}` gives each running agent's `launched` revisions.
- Start test copies with the run context's environment: the suites and `lib.launch()` do, and a Playwright script of your own passes `require('./tests/e2e/lib.cjs').combworkEnv({ CW_USER_DATA: <temp dir> })` as its `env`. Nothing of your shell's then reaches the copy (`ELECTRON_RUN_AS_NODE`, with which `electron.exe` runs as plain Node; `NO_COLOR`; your session's `CW_*`).

## Choose the suites

[tests/e2e/README.md](../../../tests/e2e/README.md) lists them, with what each needs. Run them through the runner, which turns tips off and keeps logs: `npm run e2e -- <suite> <suite>`.

- Pick the suites for the feature you changed (`board`, `review`, `cardchip` for the task board; `assistant*` for the Assistant; `skills` for skills). Not every suite for a CSS change.
- Prefer the fake Claude Code and fake Codex (no sign-in, no tokens). Real-CLI suites (the real tier) cost tokens; Codex ones need the test home, which the user signs in to once. The full set (`--all`) is the fake tier; a real suite the change needs runs by name (`--affected` says which), and the whole real tier (`--real`, `--only-real`) before a release and after a Claude Code or Codex update, not on a card unless it asks (AGENTS.md, Tests per card). A real suite skipped for the environment (usage limit, sign-in, network) is no result for the code: say so in the record. Warn the user before anything that may open a browser sign-in, and never press keys on a CLI's login screen.
- Suites that share a test home or the real CLI run one after another: the runner does that. Runners in different worktrees can run at once: each claims a lane (its own ports and suite folders; `tests/e2e/lanes.mjs`).
- Each suite works in `%LOCALAPPDATA%\combwork-test\e2e` (`CW_E2E_DIR`; from the runner, its own `lanes\<k>\<suite>` in it, which goes when it passes and, when it fails, stays until its run's logs are pruned), with its own `CW_USER_DATA` profile and workspace. Never point a test at the user's profile, clipboard, `~/.claude` or `~/.codex`.
- To look at a passing suite's screenshots, add `--keep-files`: they are copied into the run's new log folder (`<run>\<suite>`), so a rerun never needs a folder deleted first.

## A one-off check

Start from an existing suite and its `lib.cjs` helpers (`launch`, `fitWindow`, `addAgent`, `gitProject`), or a script of your own: build with `npx electron-vite build`, then drive `node_modules/electron/dist/electron.exe .` with Playwright's `_electron` (`playwright-core` is a dev dependency) in a throwaway workspace folder. In the page, `window.combwork.invoke(channel, …)` calls any IPC channel from `src/shared/api.ts`. To see the window while an action is slow or fails, give the copy `CW_TEST_SLOW_IPC` / `CW_TEST_FAIL_IPC` (in `combworkEnv({ … })`, or in its main process while it runs; unpackaged builds only; tests/e2e/README.md). To test updates, set `CW_UPDATE_FEED` to a local HTTP server serving a `latest.yml` (generic provider): unpackaged builds then check it, cache downloads in `%LOCALAPPDATA%\combwork-test-updater`, and never install what they download. Give each run of the probe (profile, workspace, screenshots) a new folder: `lib.probeDir('<what>')` makes one in `combwork-test\scratch`, which `npm run test:clean` prunes; or a new one in your scratchpad. Never shell-delete a folder to rerun into it (AGENTS.md); `npm run e2e -- --clear-dir <folder>` empties one from Node. Evidence a card needs is cited by its full path, and is kept until the card is Done. Then:

- **Click what the user clicks.** Use Playwright's own clicks, which check hit-testing: an element covered by an overlay, a dialog or a tip fails the click, as it would for the user. `elementFromPoint` at the target's centre tells you what's on top.
- **Look at screenshots** (`page.screenshot`), and read them; don't only save them. Check light and dark themes, a narrow window and zoom when layout changed, and nested overlays (a dialog over a panel over a pane).
- **Open only the screenshots you need**: each one costs far more to read than text. Look at the screens your change touches, and for a set of them read its text first. The i18nshots route's `report.txt` lists text cut off, wrapped, squeezed, overlapping or left in English, each with its screenshot (tests/e2e/README.md). Open what it flags, never the whole route: the rest are for people to browse.
- **Drag and drop**: Playwright drops only on a mouse-up straight after a move, and sends few dragover events, so move in small steps.

## Cleaning up

Close every copy you start, in a `finally` (`app.close()`), so a probe that fails or is interrupted doesn't leave it running: a copy left from an e2e run stayed on the taskbar for a day (#614). Look at a change through a suite or a `lib.launch()` copy, which runs quiet in a test profile, rather than `npm run dev` or `electron .`; if you do start one of those, close it before the card goes to Review.

Stop only what you started: test Electron processes are found by their test profile in the command line (the main process's `--combwork-test-profile=…`, Chromium's `--user-data-dir=…`: `combwork-test\e2e\lanes\<k>\<suite>\<suite>-profile`, or `combwork-test\e2e\<suite>-profile` for a suite run on its own) or Playwright's `--remote-debugging-port=0`; the runner stops what names a suite's folder once the suite ends. Never by name (AGENTS.md, Developing Combwork from inside Combwork).

## Report

Say what you ran (suites, builds, commits), what passed, what failed with the key line, and what you couldn't check (a real CLI suite skipped, a packaged-only behaviour).
