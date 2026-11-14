---
name: release-combwork
description: Prepare a release of Combwork itself - version, release notes, checks and the draft installer, following RELEASING.md. Use when developing Combwork and the user asks to prepare, build or check a release or an installer. Preparing is not publishing; uploading a draft or publishing happens only when the user asks.
---

# Release Combwork

[RELEASING.md](../../../RELEASING.md) is the process, in its order: The release path's five stages (develop on the release branch, freeze and rc.1, soak, release, after the release), and the Steps they name by number. Follow it as written; this skill adds the agent's checks at each stage.

## Authorisation

RELEASING.md's **The user's OK** lists the decisions that are the user's. Do each only when asked. Ask for each in your own pane, and take the user's answer there: an OK relayed by the Assistant or another agent isn't one, and Claude Code's permission check refuses a push or `npm run release` on it (#1073). Opening or merging a pull request is public: the user's OK each time, like a push.

**`main` is protected** (RELEASING, The release path, `main` is protected): everything reaches it through a pull request with CI green, the release's (stage 4) or a patch's (stage 5); `git push origin main` is refused, so never merge into `main` locally. A pull request into `main` is merged with a merge commit, keeping the release's commits and their card keys, never squashed or rebased. The admin bypass is for an emergency only (CI broken by something outside the code, such as a GitHub runner fault), on a pull request only: never suggest it for a failure in the code; using it is the user's decision, and you record it on the release card with why and the failed run.

`npm run dist` builds an installer locally and publishes nothing. RELEASING's Notes say where the installer ends up (the main checkout's `dist`) and when a copy is refused. Leave running the installer to the user.

## Naming the build and carding it

- **Beta or RC** (RELEASING, Betas and RCs): a working build the user installs to use while work goes on, before the freeze, is `-beta.<n>`; `-rc.<n>` is only a real candidate, after the freeze and the full checks, meant to become the release. Asked for "an RC" of a build that won't have the full checks, say it would be a beta and ask which. A version that already has an RC gets no more betas: its next build is the next RC. There is no installer at the release's own version before the version card: every candidate is an `-rc.<n>` build.
- **A release's cards** (RELEASING, A release's cards): an RC card per RC (code: the `-rc.N` version, its checks, its installer built from the card's own commit before you submit, the coverage ledger), then the version card (code, merged by the queue) and the publish card (no code, blocked by it), which builds from the merged `main` commit. Never put a build or upload step after the merge on a code card: the lane ends your session when it merges, and the step is lost (HI-2297). Proposing a release's cards, propose the version card and the publish card together.

## Stage 1: the release branch

- Work merges into the release branch (`<version>`) through the merge queue. Its draft pull request into `main` is what runs CI on each push: if there isn't one yet, ask the user to open it at the next push (their OK). A red CI on it is carded and fixed now.
- Don't add release branches to `ci.yml`'s push trigger (RELEASING, stage 1, says why).

## Stage 2: freeze and rc.1

- The freeze and what counts as a release blocker are the user's. After the freeze, a card joins the release only with the `release-blocker` label (RELEASING, The release-blocker label); anything else you're asked to add goes to the next version's branch: say so, and ask if it seems to be a blocker.
- **The coverage ledger** (RELEASING, What a release checks, The coverage ledger): from rc.1's first pass, keep `shared:releases/<version>-coverage.md` and name it in each RC card's context. Each pass is a row: its code, CLI versions, environment, record, and for an installer its SHA-256 and `build-info.json`. Each change merged since is a row: its paths by class and the slices it invalidates. A fix round reruns those slices and nothing else; where `--affected` says every suite for a shared file, write the boundary analysis that narrows it, or run the full affected set. A path in no class invalidates everything. The installer the user installs and the one uploaded get packaged and Sandbox `fresh` rows of their own bytes (the release: `upgrade` too). Copy what `npm run release` prints as test-only files let through the manifest into the ledger.
- **Each stage's budget** is RELEASING's What a release checks: the first RC about 2–3 hours, an RC fix round 15–45 min, the release of the tested candidate 15–30 min. Say on the RC card which stage a run is and how long it took; over budget, look at what was selected, and never count a check that didn't run.
- **The full set on rc.1's commit**, once (RELEASING step 1), its version `<version>-rc.1` already set (asked): `npm test` and `npm run e2e -- --all --build --record`, then the real tier and the manifest (steps 4 and 5; below). Merges run only focused checks (#1010), so the first RC is where every suite runs on the release's code (besides the quiet-time runs on the release branch); a failure is a release finding. A fix round reruns the failed tests and what the fix touches, not the set.
- **The Sandbox checks on the RC**, once it is built and before the user installs it: `npm run sandbox-checks -- --installer "<the RC's Combwork-Setup-<version>.exe>" --repo "<the repo's main checkout>" --report "$env:LOCALAPPDATA\combwork-test\sandbox-reports\<version>-rc<n>"` (`tests/sandbox`; about 20 minutes, with the clean install searched for the old name, HI-2592, and the profile move the installer couldn't make, HI-2602; network off, fake CLIs only; the upgrade check starts from the newest other installer in the main checkout's `dist`, or `--previous`). It starts the windows-sandbox MCP server from the workspace's installed copy (`.combwork\mcp\windows-sandbox`), else a combwork-mcp checkout beside the repo, or `--server <its server.js>` (tests/e2e/README.md).
  - Comment the verdict and any failed checks on the RC card, with the report folder.
  - A failed check is a release finding, like a failing e2e suite. The "same version" and "No Git" notes are expected for an RC.
  - If another Sandbox is running it says NOT RUN (exit 2): wait, or pass `--wait-min 30`. It never stops one it didn't start.
- An RC uploaded as a GitHub pre-release (only when the user asks) follows Steps 6 to 8 with **Set as a pre-release** ticked, and its uploaded installer gets packaged and Sandbox `fresh` rows of its own.

## Stage 3: soak

- The soak's length is the user's (one day of normal use unless they say otherwise); don't start the release before they say the RC has soaked with no open blockers.
- A blocker's fix is a card of its own, labelled, merging into the release branch; the next RC card reruns only what the ledger marks invalid. If anything but the manifest, allowlisted test files or the version changed since rc.1's real-tier record, that RC runs the real tier again on its own commit: `npm run release` would refuse the old record.

## Before the real tier

- **Sign-ins.** The real tier needs both test homes signed in: an expired sign-in makes its suites skip, which a release can't accept. Check first:
  - Claude Code: `$env:CLAUDE_CONFIG_DIR="$env:LOCALAPPDATA\combwork-test\claude"; claude auth status` (PowerShell), or `set "CLAUDE_CONFIG_DIR=%LOCALAPPDATA%\combwork-test\claude" && claude auth status` (cmd).
  - Codex: `$env:CODEX_HOME="$env:LOCALAPPDATA\combwork-test\codex"; codex login status` (PowerShell), or `set "CODEX_HOME=%LOCALAPPDATA%\combwork-test\codex" && codex login status` (cmd).
  If one is signed out, don't sign in for the user and don't press keys on a login screen. Tell the user the sign-in command for their shell; it is interactive, so they run it themselves:
  - PowerShell: `$env:CLAUDE_CONFIG_DIR="$env:LOCALAPPDATA\combwork-test\claude"; claude` for Claude Code, and `$env:CODEX_HOME="$env:LOCALAPPDATA\combwork-test\codex"; codex login` for Codex.
  - cmd: `set "CLAUDE_CONFIG_DIR=%LOCALAPPDATA%\combwork-test\claude"` then `claude`, and `set "CODEX_HOME=%LOCALAPPDATA%\combwork-test\codex"` then `codex login`.
  The steps are in tests/scenarios/README.md and tests/e2e/README.md.
- Warn the user before anything that may open a browser sign-in.

## Before the manifest

- Per-CLI reruns of the real tier are allowed (RELEASING step 4): pass every record of this commit to `npm run tested-clis -- <record> <record>…`, never a hand-merged one; it refuses records of different commits and two records that ran a CLI at different versions.
- Read the run record's CLI versions before `npm run tested-clis`. If a CLI shows two versions, the record is from a mixed run: rerun the real tier on one stable version (RELEASING step 5). Don't commit a manifest from it.

## Stage 4: the release

- **The version card**: the version (from `<version>-rc.N`), `npm install` for the lockfile, `CHANGELOG.md`'s **Unreleased** section (it describes every user-visible change since the last release) turned into `## <version> — <date>`, and the manifest if the RC didn't commit it. Nothing else in those files, so the RC's real-tier record and coverage stand (RELEASING step 3, HI-2676).
- `npm run build` runs typecheck, lint and the licence list: it must pass on the commit being released. `npm test` runs the unit tests: once on rc.1's commit, then only the failed and affected files in a fix round; a version-only bump keeps the candidate's result (RELEASING, What a release checks).
- The real tier's run on the RC's commit, which a version-only bump keeps (RELEASING step 4, HI-2676: `--all --only-real` with Copilot's suites named, not the fake set again), is where the "Tested with" CLI versions come from: `npm run tested-clis` writes `resources/tested-clis.json` from its record; commit it. Never edit the versions by hand; `npm run release` refuses a manifest that isn't from a run on this code.
- `THIRD_PARTY_NOTICES.md` is regenerated by the build. Commit it if it changed.
- Bundled skills or modes changed: `npm run bundled-history` records their new versions (the unit tests fail until it has).
- Guidance, a bundled skill or a tool's replies changed: compare before and after with the scenario benchmarks (`npm run scenarios`, and `-- --provider fake-codex` and `fake-copilot`, each running the scenarios `tests/scenarios/fakeScope.cjs` gives it; `--save-baseline NAME` before the change; Performance → Compare). The cards that changed agent-facing text ran their own model trials (AGENTS.md, HI-2662): read their records, and don't run them again. A release's model trial is 3 to 5 scenarios picked at random, once each (`npm run scenarios -- --provider <provider> --random 3`), its seed or ids named on the RC card so it can be rerun; the full set on every provider is not a release step (RELEASING, What a release checks). tests/scenarios/README.md has the method.
- **The pull request**: once the version card has merged, the user pushes, CI passes on the pull request (RELEASING step 2), and the user merges it into `main` (their OK) with a merge commit. `main` requires the branch to be up to date before it merges. Check whether `main` had moved first (`git fetch origin main`, then `git log <release branch>..origin/main`): empty means nothing reruns; otherwise the ledger says what does (RELEASING, stage 4).
- **The publish card**: `npm run release` in the main checkout at the merged `main` commit (asked), then the checks below.

## After building

- Check the packaged app: `npm run e2e -- packaged-mcp packaged-transcript` (the `combwork` MCP server and transcripts outside the asar), then `--packaged` for the rest when the change warrants it. The release installer's own bytes also get Sandbox `fresh` and `upgrade` rows in the ledger.
- The draft has three files: the installer, `latest.yml` and the `.blockmap`. Its version must match `package.json`.
- After the user publishes: Help → Check for Updates from an installed copy shows the new version.
- **Verify your report against git** before you tell the user a step is done: the commit you name exists (`git rev-parse <commit>`); the branch and the tags are what you say (`git branch --show-current`, `git tag --list`, `git ls-remote --tags origin`); the commit you say is on `main` is on the remote: `git fetch origin main`, then `git ls-remote origin refs/heads/main` returns that commit (a local `origin/main` can be stale, so refresh it first); and the draft's version matches `package.json`. The 0.4.0 release report once named a placeholder commit id.

## Stage 5: after the release

- Once the release is tagged and merged into `main`, **Work merges into** must be the next version (RELEASING, stage 5): new work on a released branch is refused, except by the user's or the Assistant's override for a hotfix. If it still names the release, Start the next version (`cw_branch` `nextVersion`), or answer Combwork's release offer (For you: Move…, Start…), with the user's OK; then take the release out of Other branches work can merge into once nothing uses it (the offer's Remove…).
- Merging `main` into the next version's branch is the user's OK; retarget what's still on the release branch before it is deleted (RELEASING, stage 5).
- A patch (`x.y.1`) comes from `main` with the fix-round budget, on a patch branch made from it that its fix cards merge into (their **Merges into**, never `main`); its version card goes on that branch, and it reaches `main` by its pull request, CI green, merged as a merge commit (their OK), before the publish card builds from the merged `main` commit. A dialect-only patch goes the same way. A bug found in a release gets its GitHub issue only when the user asks.

Never delete or replace a published release's files; publish a new version instead.
