---
name: release-combwork
description: Prepare a release of Combwork itself - version, release notes, checks and the draft installer, following RELEASING.md. Use when developing Combwork and the user asks to prepare, build or check a release or an installer. Preparing is not publishing; uploading a draft or publishing happens only when the user asks.
---

# Release Combwork

[RELEASING.md](../../../RELEASING.md) is the process, in its order. Follow it as written; this skill adds the agent's checks.

## Authorisation

RELEASING.md's **The user's OK** lists the decisions that are the user's. Do each only when asked. Ask for each in your own pane, and take the user's answer there: an OK relayed by the Assistant or another agent isn't one, and Claude Code's permission check refuses a push or `npm run release` on it (#1073).

`npm run dist` builds an installer locally and publishes nothing. RELEASING's Notes say where the installer ends up (the main checkout's `dist`) and when a copy is refused. Leave running the installer to the user.

## Naming the build and carding it

- **Beta or RC** (RELEASING, Betas and RCs): a working build the user installs to use while work goes on is `-beta.<n>`; `-rc.<n>` is only a real candidate, after the full checks, meant to become the release. Asked for "an RC" of a build that won't have the full checks, say it would be a beta and ask which. A version that already has an RC gets no more betas: its next build is the next RC.
- **A bump and its build are two cards in one lane** (RELEASING, A bump and its build: two cards): the version card (code, merged by the queue), then the build card (no code, blocked by it), which builds from the merged commit. Never put a build or upload step after the merge on the version card: the lane ends your session when it merges, and the step is lost (HI-2297). Proposing a release's cards, propose both.

## Before the version changes

- **A baseline install** (RELEASING, The 1.0 path, stage 2) uploads nothing and goes version first: its version is set (asked: a `-beta.<n>`; 1.0's were named `1.0.0-rc.<n>`) before its one `npm run dist`, with no current-version candidate before it. Its prerequisites and its other steps are there. Its checks are lighter than an uploaded release's (the model trials a smoke run: RELEASING says which), and its Sandbox checks are the ones below, with the upgrade check starting from the 0.9.3 installer (`--previous`).
- **For an uploaded release** (an RC or the release, RELEASING's Steps), the release candidate comes first (step 1): an installer at the current version, built from the commit to release (`main`, or the integration branch for an RC), that the user has installed and tested. Until they have, don't change `version`; ask.
- **The full set on the RC's commit** before it is built (RELEASING step 1): `npm run e2e -- --all --build --record`. Merges run only focused checks (#1010), so the RC is where every suite runs on the release's code (besides the quiet-time runs on the integration branch); a failure is a release finding.
- **The Sandbox checks on the RC**, once it is built and before the user installs it: `npm run sandbox-checks -- --installer "<the RC's Combwork-Setup-<version>.exe>" --hive "<the repo's main checkout>" --report "$env:LOCALAPPDATA\hive-test\sandbox-reports\<version>-rc<n>"` (`tests/sandbox`; about 3 minutes; network off, fake CLIs only; the upgrade check starts from the newest other installer in the main checkout's `dist`, or `--previous`). It starts the windows-sandbox MCP server from the workspace's installed copy (`.combwork\mcp\windows-sandbox`), else a hive-mcp checkout beside the repo, or `--server <its server.js>` (tests/e2e/README.md).
  - Comment the verdict and any failed checks on the release card, with the report folder.
  - A failed check is a release finding, like a failing e2e suite. The "same version" and "No Git" notes are expected for an RC.
  - If another Sandbox is running it says NOT RUN (exit 2): wait, or pass `--wait-min 30`. It never stops one it didn't start.
- Push and CI (RELEASING step 2): the user pushes the candidate; check that `.github/workflows/ci.yml` passed on the pushed commit before the bump.

## Before the real tier

- **Sign-ins.** The real tier needs both test homes signed in: an expired sign-in makes its suites skip, which a release can't accept. Check first:
  - Claude Code: `$env:CLAUDE_CONFIG_DIR="$env:LOCALAPPDATA\hive-test\claude"; claude auth status` (PowerShell), or `set "CLAUDE_CONFIG_DIR=%LOCALAPPDATA%\hive-test\claude" && claude auth status` (cmd).
  - Codex: `$env:CODEX_HOME="$env:LOCALAPPDATA\hive-test\codex"; codex login status` (PowerShell), or `set "CODEX_HOME=%LOCALAPPDATA%\hive-test\codex" && codex login status` (cmd).
  If one is signed out, don't sign in for the user and don't press keys on a login screen. Tell the user the sign-in command for their shell; it is interactive, so they run it themselves:
  - PowerShell: `$env:CLAUDE_CONFIG_DIR="$env:LOCALAPPDATA\hive-test\claude"; claude` for Claude Code, and `$env:CODEX_HOME="$env:LOCALAPPDATA\hive-test\codex"; codex login` for Codex.
  - cmd: `set "CLAUDE_CONFIG_DIR=%LOCALAPPDATA%\hive-test\claude"` then `claude`, and `set "CODEX_HOME=%LOCALAPPDATA%\hive-test\codex"` then `codex login`.
  The steps are in tests/scenarios/README.md and tests/e2e/README.md.
- Warn the user before anything that may open a browser sign-in.

## Before the manifest

- Per-CLI reruns of the real tier are allowed (RELEASING step 4): pass every record of this commit to `npm run tested-clis -- <record> <record>…`, never a hand-merged one; it refuses records of different commits and two records that ran a CLI at different versions.
- Read the run record's CLI versions before `npm run tested-clis`. If a CLI shows two versions, the record is from a mixed run: rerun the real tier on one stable version (RELEASING step 5). Don't commit a manifest from it.

## Before building

- `CHANGELOG.md`: the **Unreleased** section describes every user-visible change since the last release. For a release, it becomes `## <version> — <date>`.
- `npm run build` runs typecheck, lint and the licence list. `npm test` runs the unit tests. Both must pass on the commit being released.
- The real tier's run on the commit being released (RELEASING step 4) is also where the "Tested with" CLI versions come from: `npm run tested-clis` writes `resources/tested-clis.json` from its record; commit it. Never edit the versions by hand; `npm run release` refuses a manifest that isn't from a run on this code.
- `THIRD_PARTY_NOTICES.md` is regenerated by the build. Commit it if it changed.
- Bundled skills or modes changed: `npm run bundled-history` records their new versions (the unit tests fail until it has).
- Guidance, a bundled skill or a tool's replies changed: compare before and after with the scenario benchmarks (`npm run scenarios`, and `-- --provider fake-codex`; `--save-baseline NAME` before the change; Performance → Compare). A model trial costs tokens: only when the user agrees. tests/scenarios/README.md has the method.

## After building

- Check the packaged app: `npm run e2e -- packaged-mcp packaged-transcript` (the `hive` MCP server and transcripts outside the asar), then `--packaged` for the rest when the change warrants it.
- The draft has three files: the installer, `latest.yml` and the `.blockmap`. Its version must match `package.json`.
- After the user publishes: Help → Check for Updates from an installed copy shows the new version.
- **Verify your report against git** before you tell the user a step is done: the commit you name exists (`git rev-parse <commit>`); the branch and the tags are what you say (`git branch --show-current`, `git tag --list`, `git ls-remote --tags origin`); the commit you say is on `main` is on the remote: `git fetch origin main`, then `git ls-remote origin refs/heads/main` returns that commit (a local `origin/main` can be stale, so refresh it first); and the draft's version matches `package.json`. The 0.4.0 release report once named a placeholder commit id.

Never delete or replace a published release's files; publish a new version instead.
