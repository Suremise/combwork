# Releasing Hive

Hive updates itself from this repository's [GitHub Releases](https://github.com/Suremise/hive-desktop/releases) using [electron-updater](https://www.electron.build/auto-update). A release is only seen by installed copies once it is **published** (not a draft) and the repository is **public**: the updater reads releases without credentials, and Hive never ships a token.

## What a release contains

`npm run release` uploads three files to a draft release tagged `v<version>`:

| File | Purpose |
|---|---|
| `Hive-Setup-<version>.exe` | The NSIS installer, for new installs and updates |
| `latest.yml` | What the updater reads: version, file name, size, SHA-512 and release date |
| `Hive-Setup-<version>.exe.blockmap` | Lets the next update download only the blocks that changed |

The updater checks the downloaded installer against the SHA-512 in `latest.yml` before installing it. The installer is not code-signed yet, so the first install from a browser shows a SmartScreen warning; in-app updates don't.

## The user's OK

Each of these is a separate decision of the user's, asked for each time (an OK for one isn't an OK for the next):

- building an installer (`npm run dist`): more changes often come first;
- changing the version;
- pushing (the user pushes);
- merging an integration branch into `main`;
- `npm run release` (it uploads a draft);
- publishing the draft, and creating tags;
- opening or closing a GitHub issue (it's public).

An agent takes the OK in its own pane: the release-hive skill says how.

## Betas and RCs

A build's pre-release name says what it is (HI-2308):

- **`-beta.<n>`: a working build**, installed to use while work goes on (`npm run dist`; the journal records it as a beta from its version, or `--kind beta`). Its checks are lighter than a release's, as the baseline's are (The 1.0 path). It isn't uploaded unless the user asks, and then as a GitHub pre-release.
- **`-rc.<n>`: a real release candidate** only: built after the full checks (What a release checks), and meant to become the release unless something is found.

Semver orders them `1.1.0-beta.3` < `1.1.0-rc.1` < `1.1.0`, so a version's betas all come before its first RC. Once a version has an RC, a fix to it is the next RC: a beta then would be older than the installed RC. The working builds after 1.0.0 are `1.1.0-beta.<n>`. 1.0 named every installable build `-rc.<n>`: rc.17 on were real candidates, and the earlier ones (rc.10 to rc.16 in particular) were working builds that would now be betas.

What the updater offers (GitHub's releases feed through Hive's provider, `src/main/updateFeed.ts`; versions compared by semver, `src/shared/updates.ts`): with **Include pre-releases** off, releases only. With it on, a pre-release install is offered the newest uploaded version newer than it, beta, RC or release, in that semver order: a beta gets a later RC, an RC the release (HI-2311); a release install takes the feed's newest entry. Builds before 1.0.0-rc.19 lack this: there an installed beta is never offered an RC and an installed RC only a later RC, never the release, so someone on rc.18 or earlier reaches 1.0.0 by updating to the last RC first, or by turning **Include pre-releases** off.

## A bump and its build: two cards

A version change and the build made from it are **two cards in one lane**, in this order:

1. **The version card** (code): the version, `package-lock.json` and the release notes (Steps, step 3), and for an uploaded release the real tier on its final commit and the tested-with manifest (steps 4 and 5). The merge queue merges it.
2. **The build card** (no code), blocked by the version card: what comes after the merge, from the merged commit. For a working build or the baseline: `npm run dist`, the packaged checks, the Sandbox checks and the install note. For an uploaded release: steps 6 to 8 (`npm run release` in the main checkout at the merged commit, the draft for the user to publish, then the check). Nothing else merges into the target between the two cards: `npm run release` refuses code that differs from the real tier's run, other than the manifest.

A lane ends its builder's session when its last card merges, so steps written after the merge on the version card are lost: rc.17's HI-2297 lost its build that way, and its builder had to be restarted to make it. rc.18 (HI-2300, then HI-2301) and rc.19 were built in this shape.

## The 1.0 path

1.0 is built on an **integration branch** (`1.0.0`), not on `main`, which carries only 0.9.x fixes meanwhile. A fix made on `main` is merged into the integration branch as well. It goes out in three stages:

1. **Phases.** Cards merge into the integration branch through lanes, each merge with the merge checks (AGENTS.md, Tests). Each phase ends with its **checks card**, #1449 (P7's) being the pattern:
   - typecheck, lint, `npm test` and the i18n checks;
   - the full fake set (`npm run e2e -- --all --build --record`) and the phase's real suites (`--real`);
   - `npm run scenarios` against the last baseline when guidance changed, and model trials when it could alter what agents do.

   Failures are carded at once and bisected over the merges since the last full run.
2. **The baseline install** (#1288): a 1.0 build the user installs and uses day to day, before anything is uploaded. Features from On Hold are then built on top of it for a while.
   - It waits for the last phase's checks card (#1539), the translation review (#1126) and #1582 (Hive's version checks off `fetch()`). Electron's CVE fix (#1503) comes before the RC (#1541), not the baseline (the user, 24 Oct).
   - **Its checks are lighter than a release's** (the user, 24 Oct): the checks on the integration branch's head, where the last checks card's results stand if the branch hasn't moved since (otherwise run them again), with the model trials as a **smoke run**: Claude Code and Codex each run the key scenarios once, with no repeats, no Haiku and no Copilot. The full trials, the full e2e set and the real tier come before a proper release (What a release checks).
   - The release notes (below).
   - The version is `1.0.0-rc.<n>` (asked), set before the build: no current-version candidate comes first (that's Step 1, for an uploaded release). (1.0's baselines were named as RCs; a later baseline is a beta: Betas and RCs.) A pre-release version means the updater never offers a 0.9.x release over it, and a later RC or 1.0.0 updates it.
   - `npm run dist -- --kind baseline` (asked), built from the integration branch's head. From a worktree, it copies the installer into the main checkout's `dist` (Notes).
   - `npm run e2e -- packaged-mcp packaged-progress` against `dist/win-unpacked`, and the Sandbox checks (the release-hive skill), including the one-way upgrade from 0.9.3.
   - An install note for the user: back up first, close every 0.9.3 Hive on the workspace, and what to expect. **The user installs.** Nothing is pushed, tagged or uploaded.
3. **The RC, then the release** (#1541), once the user is happy with what the baseline has become:
   - **An RC** is a draft GitHub pre-release at `1.0.0-rc.<n>`. It follows the Steps below, built from the integration branch, with **Set as a pre-release** ticked. Only installs with **Include pre-releases** on see it.
   - **The release**: the integration branch is merged into `main` (asked, `--no-ff`), and the Steps run on `main` at `1.0.0`, as a version card and a build card in one lane (A bump and its build: two cards): the version card holds steps 3 to 5, the build card steps 6 to 8. After that, 1.0.x fixes go to `main`, and 1.1's working builds are `1.1.0-beta.<n>` (Betas and RCs).

Each build `npm run dist` or `npm run release` makes is recorded in `dist/build-info.json`, beside its installer: the code, commit and branch it was built from (Notes). Each successful build, by `npm run dist` or `npm run release`, also goes into the Hive Assistant's journal as Hive's entry: its kind (`--kind beta|baseline|rc|release`, else from the version: a `-beta.n` is a beta, an `-rc.n` an RC, and a release version is `npm run release`'s release or `npm run dist`'s candidate for it), version, commit and installer. It's sent to Hive while it's running; otherwise it's recorded when the workspace next opens. **Settings → Advanced → Record builds in the journal** turns it off.

A build also says inside itself whether it is local (#1647, SPEC §11.1): `npm run dist` packages `build-identity.json` with `local: true`, and its installer waits for another Hive installer to finish before installing; `npm run release` packages `local: false`, and its installer doesn't wait. An installed local build is never replaced by a release of its own version (it's offered instead), so a candidate built with `npm run dist` and then released as the same version isn't updated to the published build: install the published one by hand.

## What a release checks

Before any release that is uploaded, an RC or the release itself, everything runs on its commit, unlike the baseline's lighter checks (The 1.0 path):

- the full fake set, and the real tier for every CLI (Steps 4 and 5);
- the i18n checks, with all text translated in the 7 locales and checked in context (#1126);
- `npm run scenarios` against the baseline, and the model trials. Their scope is agreed with the user, since they cost tokens;
- the Sandbox checks.

A release has **no known gaps**: a card showing that one of the release's features is unfinished joins the release's path before the RC, or the user moves it out of the release.

## Release notes

`CHANGELOG.md`'s **Unreleased** section becomes the notes (Step 3). Read it as a user of the last release would.

For 1.0, that's a 0.9.3 user. It says first:
- that the upgrade is one way: **back up first, there's no going back**;
- what Help → Restore the 0.9 Board Backup… brings back (the board's cards and history), and that it isn't a way back for worktrees, sessions or lanes;
- that every 0.9.3 Hive on the workspace must be closed first.

Then it says what's new.

## Steps

These are the steps for an uploaded release: an RC, or the release. The commit to release is on `main`, or for an RC, on the integration branch.

1. **Release candidate first.** Before any version change, build an installer at the **current** version from the commit to release (`npm run dist`, in the main checkout, at that commit) and have the user install and test it. The full fake set runs on that commit first (`npm run e2e -- --all --build --record`): merges to main run typecheck, lint, the unit tests and their cards' focused e2e suites (#1010; AGENTS.md, Tests), so each RC is the checkpoint where every suite runs; a failure is a release finding. Before the user installs it, run the Sandbox checks on it (`npm run sandbox-checks`, `tests/sandbox`: the release-hive skill and tests/e2e/README.md) and attach the report to the release card. Fixes found now go in before the bump; the bump is step 3.
2. **Push and let CI pass before the bump.** Push the release-candidate commit (the user pushes) and wait for `.github/workflows/ci.yml` to pass on it. The 0.4.0 push found a failure no local run could: #389, 8.3 short paths on GitHub's runner. CI on the pushed commit is the check that counts.
3. **Version and release notes.** Set `version` in `package.json` (semver: `0.2.0`, or `0.2.0-beta.1` for a pre-release) and run `npm install` so `package-lock.json` matches. In `CHANGELOG.md`, turn the **Unreleased** section into `## <version> — <date>`: it is bundled into the app (Docs → Release Notes), and the same text goes in the GitHub release. Commit everything; the script refuses to run on a dirty tree. It also refuses stale third-party notices (`npm run licenses -- --check`; the unit tests and CI check the same): run `npm run licenses` and commit them. When the release adds dependencies, bundled libraries, assets or installer parts, audit their licences first with the **licence-audit** skill (vendored material and what the installer adds included; `scripts/thirdPartyNotices.mjs` lists the bundled renderer libraries).
4. **The real tier on that commit.** The full fake set must pass on this code first (`npm run e2e -- --all --build --record`). Then the real tier, with the CLIs signed in (the release-hive skill checks that first): `npm run e2e -- --all --real --build --record`. The manifest needs that one record of both tiers: Copilot's suites run the real Copilot CLI offline, so they are in the fake set, and an `--only-real` record has no Copilot version (0.8.0 found this). Keep the record. Every real suite must pass: a suite that failed or was skipped for the environment (a sign-in, a usage limit, the network) is rerun on this exact code, with a stable CLI version and its sign-in in place, before step 5. A reviewer's acceptance of a skip doesn't stand in for that: `npm run tested-clis` requires every real suite of each CLI to have run and passed. The real tier may also run one CLI at a time (when one CLI's suites can't share the machine with another's, as Codex's with a Store PowerShell 7 for 0.9.2, #585): each run on this same commit, with `--record`, its record kept.
5. **The tested-with manifest.** Run `npm run tested-clis` on that record (or on the per-CLI records, all of this commit: `npm run tested-clis -- <record> <record>…`, each CLI's entry from the record where all its real suites ran and passed; never a record merged by hand, #1105) and commit `resources/tested-clis.json` (what Provider Setup shows as "Tested with", #365). It writes each CLI's version from the record, and exits 1 if a CLI's real suites ran different versions or the record doesn't say which. A CLI can update itself during the run (Codex went from 0.160.1 to 0.161.0 during 0.4.0's): then rerun the real tier on one stable version. A new real-tier failure after a CLI update may be a real change in behaviour (#396), not noise. `npm run release` refuses a manifest that isn't from a run on this code, so only the manifest may differ since the run. Each CLI's entry comes from this run's real suites, which run in the test homes (`%LOCALAPPDATA%\hive-test\claude` and `…\codex`), not in your own `~/.claude` or `~/.codex`; the sign-ins are in the release-hive skill and tests/e2e/README.md.
6. **Build and upload:** `npm run release`. It uses your `gh` login (`gh auth status` to check), builds, and creates or updates the draft release `v<version>` (titled **Hive Desktop <version>**; releases before 0.5.0 were titled **Hive <version>**) with the three files. It builds in the checkout's own `dist` by `npm run dist`'s rules and writes `dist/build-info.json` for what it uploaded (Notes).
7. **Review the draft** on GitHub. Write the release notes (the updater shows them in Hive's update dialog; Markdown works). When the changelog is long, put a short summary at the top for that dialog. Tick **Set as a pre-release** for a beta, then **Publish**. Publishing creates the tag.
8. **Check** from an installed copy: Help → Check for Updates.

Pre-releases are only offered to users who turned on **Settings → Updates → Include pre-releases**.

**A bug found in a released version** gets a public GitHub issue (asked). It's closed "Fixed in <version>" once that version ships the fix.

## A dialect-only release

Hive ships dialect files (`resources/dialects/`: a model file for each model it tunes, the CLI files and the API file; the dialects design, plans/2026-11-03-dialects-design.md), which each workspace gets a copy of: an untouched copy follows an update, an edited one is kept and offered Revert. A change to a shipped file goes in only once it's measured, on its own card (the scenarios and model trials for that dialect's model against the baseline). To ship such changes without a full release, they go out as a **patch release** (`1.0.x`, decided 1 Nov on HI-2065), batched rather than one per file, with lighter checks: the code is the last release's, so its checks still stand.

`npm run release -- --dialects` makes one. Beside the usual (a clean tree, the `gh` login, the notices), it refuses unless, since the last release's tag (the newest `v<major>.<minor>.<patch>` HEAD contains, never a pre-release's; `git fetch --tags` first):
- only files under `resources/dialects/` changed, with `CHANGELOG.md`, `package.json` and `package-lock.json` (their version only) and `src/main/bundledHistory.json` (the dialect versions `npm run bundled-history` records, no skill or mode);
- at least one dialect file changed;
- the version is a patch of that release (`1.0.0` → `1.0.1`), not a pre-release.

The tested-with manifest therefore can't have changed, and still holds, so the real tier isn't run again. The script runs the dialect checks itself before it builds (`DIALECT_CHECKS` in `scripts/dialectRelease.mjs`: the shipped files and their schema check, the dialects service, the bundled sync), then builds and uploads the draft as Steps 6 does. Those tests check what any shipped file must be (Hive's form, the schema, a `why` on every override, one file per model), never which texts it holds, so a measured override or another model's file passes them unchanged: a patch that had to change a test isn't dialect-only. They run with Vitest's module cache off (`dialectCheckArgs`), which would otherwise keep an old schema. Its rules are tested with fakes (`tests/dialectRelease.test.ts`): never run `npm run release` to try them.

Each step needs the user's OK as for any release (The user's OK). In order:
1. **The scenarios for each changed dialect's model** against the baseline, on the release commit: the results each dialect's card measured, rerun there (`npm run scenarios -- --dialect …`; tests/scenarios/README.md). No other model's trials.
2. **Version and notes** (Steps, step 3): the patch version and an Unreleased section turned into `## <version> — <date>`, naming each dialect file changed and why. Commit; push and let CI pass (Steps, step 2).
3. **`npm run release -- --dialects`**, in the main checkout at that commit.
4. **The packaged checks** on that build (`npm run e2e -- packaged-mcp packaged-progress`: the app starts and reads its files) and **the Sandbox checks** with the upgrade check from the last release's installer (`npm run sandbox-checks -- … --previous <it>`; the release-hive skill): the patch installs over the release and the app reads its dialect files.
5. **Review and publish the draft** (Steps, steps 7 and 8).

Not needed: the full e2e set, the real tier, the full unit run, or other models' trials: no code changed, and the script proves it. Anything else in the diff (a fix, a test, a skill) means a full release.

## Notes

- `npm run dist` builds the installer locally and never publishes. It writes `dist/build-info.json` (the code, commit and branch it was built from), only if none of them changed while it built (otherwise it says the build must be made again once the code stays put, and copies nothing). Run in an agent's git worktree, it also copies the installer, its blockmap, `latest.yml` and the build info to the **main checkout's** `dist`, where the user looks for them, and says so; it never replaces an installer of the same name there built from other code (`--replace` does), and `--here` keeps it in the worktree only. Worktrees copying at the same time take turns (a lock in the main `dist`), and a copy is whole or not at all. `npm run release` follows the same rules in the checkout it runs in (HI-2411): before building, it refuses (and creates no draft) when its `dist` already has an installer of the same name built from other code or from code it can't tell (no `build-info.json`); `--replace` builds over it, so move the old one aside first to keep it. One built from the same commit is replaced without a word. From that check until it ends, the release holds its `dist` (`dist/.release-build.json`, naming its process; left by one that failed, it lapses once that process is gone): a worktree's `npm run dist` doesn't copy an installer there meanwhile, even with `--replace` (it says so; run it again after the release), and a second release refuses. `npm run dist` holds the `dist` it builds in the same way while it runs (`dist/.dist-build.json`, HI-2417): it refuses, building nothing, while a release or another `npm run dist` holds that `dist`, so a local build in the main checkout can't replace the installer a release there is uploading; and while it builds, a release there refuses and a worktree's copy waits for it, as above. After the upload it writes `dist/build-info.json` for the installer it uploaded (only if the code didn't change while it built, as above), and copies nothing elsewhere: build a release in the main checkout, at the commit being released.
- Don't delete or replace the files of a published release: installed copies may be halfway through downloading them. Publish a new version instead.
- Publishing settings are in `electron-builder.yml` (`publish:`). The feed URL is also in `src/shared/defaults.ts` (`RELEASES_URL`) for the "What's new" links.
