# Releasing Combwork

Combwork updates itself from this repository's [GitHub Releases](https://github.com/Suremise/combwork/releases) using [electron-updater](https://www.electron.build/auto-update). A release is only seen by installed copies once it is **published** (not a draft) and the repository is **public**: the updater reads releases without credentials, and Combwork never ships a token.

## What a release contains

`npm run release` uploads three files to a draft release tagged `v<version>`:

| File | Purpose |
|---|---|
| `Combwork-Setup-<version>.exe` | The NSIS installer, for new installs and updates |
| `latest.yml` | What the updater reads: version, file name, size, SHA-512 and release date |
| `Combwork-Setup-<version>.exe.blockmap` | Lets the next update download only the blocks that changed |

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

An agent takes the OK in its own pane: the release-combwork skill says how.

## Betas and RCs

A build's pre-release name says what it is (HI-2308):

- **`-beta.<n>`: a working build**, installed to use while work goes on (`npm run dist`; the journal records it as a beta from its version, or `--kind beta`). Its checks are lighter than a release's, as the baseline's are (The 1.0 path). It isn't uploaded unless the user asks, and then as a GitHub pre-release.
- **`-rc.<n>`: a real release candidate** only: built after the full checks (What a release checks), and meant to become the release unless something is found.

Semver orders them `1.1.0-beta.3` < `1.1.0-rc.1` < `1.1.0`, so a version's betas all come before its first RC. Once a version has an RC, a fix to it is the next RC: a beta then would be older than the installed RC. The working builds after 1.0.0 are `1.1.0-beta.<n>`. 1.0 named every installable build `-rc.<n>`: rc.17 on were real candidates, and the earlier ones (rc.10 to rc.16 in particular) were working builds that would now be betas.

What the updater offers (GitHub's releases feed through Combwork's provider, `src/main/updateFeed.ts`; versions compared by semver, `src/shared/updates.ts`): with **Include pre-releases** off, releases only. With it on, a pre-release install is offered the newest uploaded version newer than it, beta, RC or release, in that semver order: a beta gets a later RC, an RC the release (HI-2311); a release install takes the feed's newest entry. Builds before 1.0.0-rc.19 lack this: there an installed beta is never offered an RC and an installed RC only a later RC, never the release, so someone on rc.18 or earlier reaches 1.0.0 by updating to the last RC first, or by turning **Include pre-releases** off.

## A bump and its build: two cards

A version change and the build made from it are **two cards in one lane**, in this order:

1. **The version card** (code): the version, `package-lock.json` and the release notes (Steps, step 3), and for an uploaded release the tested-with manifest from the real tier's record, on its final commit or the RC's before the version-only bump (steps 4 and 5). The merge queue merges it.
2. **The build card** (no code), blocked by the version card: what comes after the merge, from the merged commit. For a working build or the baseline: `npm run dist`, the packaged checks, the Sandbox checks and the install note. For an uploaded release: steps 6 to 8 (`npm run release` in the main checkout at the merged commit, the draft for the user to publish, then the check). Nothing else merges into the target between the two cards: `npm run release` refuses code that differs from the real tier's run, other than the manifest, the test-only files on its allowlist (The coverage ledger) and the version bump itself (HI-2676).

A lane ends its builder's session when its last card merges, so steps written after the merge on the version card are lost: rc.17's HI-2297 lost its build that way, and its builder had to be restarted to make it. rc.18 (HI-2300, then HI-2301) and rc.19 were built in this shape.

## The 1.0 path

1.0 is built on an **integration branch** (`1.0.0`), not on `main`, which carries only 0.9.x fixes meanwhile. A fix made on `main` is merged into the integration branch as well. It goes out in three stages:

1. **Phases.** Cards merge into the integration branch through lanes, each merge with the merge checks (AGENTS.md, Tests). Each phase ends with its **checks card**, #1449 (P7's) being the pattern:
   - typecheck, lint, `npm test` and the i18n checks;
   - the full fake set (`npm run e2e -- --all --build --record`) and the phase's real suites (`--real`);
   - `npm run scenarios` against the last baseline when guidance changed, and, when it could alter what agents do, the release's model trial: 3 to 5 scenarios picked at random (What a release checks).

   Failures are carded at once and bisected over the merges since the last full run.
2. **The baseline install** (#1288): a 1.0 build the user installs and uses day to day, before anything is uploaded. Features from On Hold are then built on top of it for a while.
   - It waits for the last phase's checks card (#1539), the translation review (#1126) and #1582 (the version checks off `fetch()`). Electron's CVE fix (#1503) comes before the RC (#1541), not the baseline (the user, 24 Oct).
   - **Its checks are lighter than a release's** (the user, 24 Oct): the checks on the integration branch's head, where the last checks card's results stand if the branch hasn't moved since (otherwise run them again), with the model trials as a release's: 3 to 5 scenarios picked at random, once each (What a release checks). The full e2e set and the real tier come before a proper release.
   - The release notes (below).
   - The version is `1.0.0-rc.<n>` (asked), set before the build: no current-version candidate comes first (that's Step 1, for an uploaded release). (1.0's baselines were named as RCs; a later baseline is a beta: Betas and RCs.) A pre-release version means the updater never offers a 0.9.x release over it, and a later RC or 1.0.0 updates it.
   - `npm run dist -- --kind baseline` (asked), built from the integration branch's head. From a worktree, it copies the installer into the main checkout's `dist` (Notes).
   - `npm run e2e -- packaged-mcp packaged-progress` against `dist/win-unpacked`, and the Sandbox checks (the release-combwork skill), including the one-way upgrade from 0.9.3.
   - An install note for the user: back up first, close every 0.9.3 on the workspace, and what to expect. **The user installs.** Nothing is pushed, tagged or uploaded.
3. **The RC, then the release** (#1541), once the user is happy with what the baseline has become:
   - **An RC** is a draft GitHub pre-release at `1.0.0-rc.<n>`. It follows the Steps below, built from the integration branch, with **Set as a pre-release** ticked. Only installs with **Include pre-releases** on see it.
   - **The release**: the integration branch is merged into `main` (asked, `--no-ff`), and the Steps run on `main` at `1.0.0`, as a version card and a build card in one lane (A bump and its build: two cards): the version card holds steps 3 to 5, the build card steps 6 to 8. After that, 1.0.x fixes go to `main`, and 1.1's working builds are `1.1.0-beta.<n>` (Betas and RCs).
   - **Cards and lanes still on the integration branch** (HI-2753): once it is merged into `main`, move **Work merges into** to `main` and leave **Also retarget what can move** ticked (the Assistant: `cw_queue` `retarget`): the cards in flight whose work is all their own and the running lanes with them move to `main` with their branches kept; anything that stays says why. Delete the branch only after; a card left on it says so when submitted, and a retarget from it still moves it then.

Each build `npm run dist` or `npm run release` makes is recorded in `dist/build-info.json`, beside its installer: the code, commit and branch it was built from (Notes). Each successful build, by `npm run dist` or `npm run release`, also goes into the Combwork Assistant's journal as Combwork's entry: its kind (`--kind beta|baseline|rc|release`, else from the version: a `-beta.n` is a beta, an `-rc.n` an RC, and a release version is `npm run release`'s release or `npm run dist`'s candidate for it), version, commit and installer. It's sent to Combwork while it's running; otherwise it's recorded when the workspace next opens. **Settings → Advanced → Record builds in the journal** turns it off.

A build also says inside itself whether it is local (#1647, SPEC §11.1): `npm run dist` packages `build-identity.json` with `local: true`, and its installer waits for another Combwork installer to finish before installing; `npm run release` packages `local: false`, and its installer doesn't wait. An installed local build is never replaced by a release of its own version (it's offered instead), so a candidate built with `npm run dist` and then released as the same version isn't updated to the published build: install the published one by hand.

## What a release checks

An uploaded release's checks, unlike the baseline's lighter checks (The 1.0 path), have a budget for each stage (HI-2658; AGENTS.md, Tests per card, has the cards' budgets). Each is the checking's wall-clock, not fixes, usage limits or queue waits. An over-budget run is a reason to look at what was selected or what changed, never to call unrun checks passed.

- **The first release candidate**, about **2–3 hours**: on its commit, once each: the full unit run (`npm test`); the full fake set (`npm run e2e -- --all --build --record`, Step 1); the real tier for every CLI, once (Step 4); the i18n checks, with all text translated in the 7 locales and checked in context (#1126); the relevant fake scenarios against the baseline (`npm run scenarios -- --only <ids>` for what changed; for a guidance-wide change each fake's default run, which `tests/scenarios/fakeScope.cjs` scopes by provider, AGENTS.md); the packaged checks and the Sandbox checks on the installer; and the model trial: **3 to 5 scenarios picked at random** from the trial set, once each, with no repeats (`npm run scenarios -- --provider <provider> --random 3`, which prints the ids it picked and its seed; HI-2655). The release card names the seed or the ids, so the same pick can be run again (`--random 3 --seed <seed>`, or `--only <ids>`). The full set on every provider is not a release step (the user, 6 Nov: Combwork is used daily on real models, where a failure would be noticed first); it is for guidance-wide changes (AGENTS.md).
- **An RC fix round**, **15–45 min**: the tests that failed, plus the fix's affected boundaries (its unit tests and callers, the suites covering it), on the fixed commit. The rest of the candidate's results stand where the fix didn't touch them; the whole list doesn't start again. The installer and its Sandbox checks are rebuilt and run again only when the fix changed what ships or a migration. Which results still stand, and what each change since invalidates, is the coverage ledger's to record (below).
- **The release of the tested candidate**, **15–30 min**: the artifact is the one tested (its commit, and nothing changed since but the version, the release notes and the manifest), its version and the package checks (`npm run build`, the licences, the packaged checks), and an upgrade smoke test from the last release, on the release installer's own bytes (the coverage ledger's artifact rules). The candidate's coverage stands. A source change, or a new CLI version, invalidates the slice it touches: that slice runs again. The candidate's tested-with manifest stands too: `npm run release` takes a record of an earlier commit when the only changes since it are the manifest, test-only files on its allowlist, and the version bump itself (`manifestCheck`, `scripts/testedClis.mjs`, HI-2676): `version` in package.json, the lockfile's two version fields, and CHANGELOG's one `## Unreleased` heading become `## <version> — <date>`, all saying the same version, with nothing else changed in those files. Anything more in them (a script, a dependency, other release-note wording) asks for the real tier on the bumped commit, Step 4's command (HI-2484's took 14 minutes).

### The coverage ledger

Each release keeps one **coverage ledger** (HI-2661): a shared note, `shared:releases/<version>-coverage.md`, that its release card names in its context. The release card's builder edits it in place each round, so it always says what stands now. It has two tables.

**Passes**, a row for each slice that ran. Each row gives:
- the slice;
- the code it ran on: the commit, and the e2e fingerprint where there is one;
- for an installer, packaged or Sandbox row, the installer's **SHA-256** and `dist/build-info.json` (commit, version, kind). Upgrade kinds also give the previous installer, its SHA-256 and version: their profile baseline. A commit or a path alone isn't evidence of which artifact was checked;
- the CLI versions, where real CLIs ran;
- the environment: the machine, Defender exclusions, the sign-ins, the Sandbox server;
- the result, and the record's or report's path.

The slices are:
- unit tests, by file;
- the fake e2e suites, by suite;
- the real tier, by CLI;
- the scenarios, by id;
- the model sample;
- check:repo and the i18n checks;
- the installer build;
- the packaged checks;
- the Sandbox checks, by kind: `fresh`, `upgrade`, `upgrade-rc`, `clean`, `profile-move`, `edges`, `manual` (`npm run sandbox-checks -- --only <kind>`).

**Changes since**, a row for each change merged after the first pass. Each row gives the commit and its card, its paths by class (below), the slices it invalidates, and the pass rows rerun for it. A slice's evidence stands while no change since invalidates it. **A fix round reruns the invalidated slices and nothing else.** A doubt still allows any rerun, said as "reran X because Y". The release card's reviewer checks the ledger against the diff, not by rerunning; where an invalidation choice is in doubt it asks for focused proof.

**What a change invalidates, by the class of each path it changes.** A path in no class invalidates everything, as for a first RC.

- **Shipped app code:** `src/**`, and `resources/**` except the dialects and the manifest.
  - Its unit tests: the changed files and the files that import them.
  - Its fake e2e suites. `--affected` finds the candidates, and its "Why each suite" lines say why each was picked, for the row to cite (HI-2690). `ipc.ts`, `shared/api.ts`, `actions.ts`, `commands.ts` and `workspace.ts`'s top-level functions select by their changed parts (HI-2659), and a change of types or comments alone selects nothing (HI-2690). For a file it still calls shared by every part (`App.tsx`, `servers.ts`, `workspace.ts`'s members), that is every suite. A **boundary analysis** in the ledger row can narrow them: what the change does, the owners of the behaviour it leaves alone, and the suites that cover what it changes. The reviewer can check that analysis against the diff. Without one, or where it is uncertain, the full affected set runs: that is the fallback, not a rule that a shared filename needs every suite.
  - A provider, session, hook or transcript change adds its CLI's real tier.
  - Guidance, a skill or tool text adds its named scenarios, and the model sample where it could change what agents do.
  - Then the artifact rules below.
- **Shipped text:** `locales/**`, the docs the app bundles (`docs/USER_GUIDE.md`, `docs/AGENT_API.md`, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md`) and `docs/images/**`. check:repo, the i18n checks, the changed locales' i18nshots and the Docs view's suites, then the artifact rules.
- **Dialects** (`resources/dialects/**`): the dialect checks (A dialect-only release, below: that model's scenarios against the baseline), then the artifact rules.
- **Build and package inputs:**
  - which files: `package.json` (anything but `version`), `package-lock.json` (anything but its version fields), `electron.vite.config.*`, `electron-builder.yml`, `build/**` (the NSIS script and its PowerShell helpers), `tsconfig*.json`, and the scripts that build, package or release (`scripts/` for the build, `dist`, the identity, the licences, `release` and `testedClis`);
  - what they invalidate: everything, and every Sandbox kind;
  - no "test-only" label exempts a file used to build or package the app.
- **Tests:**
  - a unit test file: itself;
  - a fake suite's own file: itself;
  - the e2e harness (`tests/e2e/` files that aren't suites: `lib.cjs`, `runContext.cjs`, `run.mjs`, `runner.mjs`, `suites.mjs`, the fakes), a helper or a fixture: the suites that read it (unknown: all), and its CLI's real tier when a real suite reads it;
  - a real suite's own file: its CLI's real tier;
  - `tests/sandbox/**`: the Sandbox kinds it runs (unknown: all);
  - `tests/scenarios/**`: the scenarios it changes, on the fake providers.
- **Not shipped:** `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `RELEASING.md`, `AGENTS.md`, the dev skills (`.claude`, `.agents`), `plans/`. check:repo only.
- **Version only:** `package.json`'s `version`, the lockfile's version fields, CHANGELOG's Unreleased becoming the version. The package checks, then the artifact rules. The manifest's record stands (`manifestCheck`'s version-only rule, HI-2676).

**The artifact rules.**
- An intermediate rebuild can wait while the changes since the last one are shipped text or not shipped. A change to shipped app code, dialects or build inputs needs one before the next installer row.
- **The installer the user installs, and the one `npm run release` uploads, always get rows of their own bytes:**
  - the packaged checks and Sandbox `fresh`;
  - for the release itself, Sandbox `upgrade` from the last release too: the upgrade smoke test.
- The other Sandbox kinds carry forward to new bytes only while none of their inputs changed since their row: build and package inputs, `build/**`, the upgrade, migration and profile code (`src/main/*Move*.ts`, such as `workspaceMove`, `connectionMoves` and `combworkFolderMove`; the store's schema steps; first run), and the Sandbox's own tests. Otherwise they run again on the final bytes.

**The manifest, test-only changes and the version bump.** `npm run release` takes the tested-with manifest from a record of an earlier commit when every file changed since it (besides the manifest) is either part of a version-only bump or on the test-only allowlist (`manifestCheck`, `scripts/testedClis.mjs`). Anything else means the real tier runs again.
- **The version-only bump** (`versionOnlyFiles`, HI-2676): `package.json`, `package-lock.json` and `CHANGELOG.md`, changed only as the release of the tested candidate, above, says: `version`, the lockfile's two version fields and the one `## Unreleased` heading become `## <version> — <date>`, all the same version.
- **The test-only allowlist** (`testOnlyFiles`) has only two kinds of file on it:
  - a unit test file (`tests/**/*.test.ts`) that nothing under `tests/e2e` or `tests/fixtures` names, at the record's commit or now;
  - a fake suite's own file (`tests/e2e/<name>.cjs`): a suite in `suites.mjs` that needs no real CLI at both commits, and that no other file there names.

So these stale the manifest: a fixture or helper a suite reads, the harness, `suites.mjs` (a suite added, renamed, deleted or reclassified), a real suite, a scenario, anything outside `tests/` other than the version-only bump of those three files, more than that bump in them (a script, a dependency, other release-note text, versions that don't agree), and anything git can't show (an unknown commit, a `suites.mjs` that doesn't load, a version file missing at either commit). The record's validity, the CLI-version checks and the clean-tree refusal are unchanged. `npm run release` prints the files it let through, for each provider's record (the bump's version among them), and the ledger copies them into the release's row.

**Worked example: 1.1.0's RC4 rounds** (HI-2484), by each round's diff (`git diff --name-only --no-renames`). `--affected` picks every suite in every round. A full-set row below is the **conservative fallback**: no boundary analysis was written then. It isn't a rule of the file names.

| Round | What changed | What ran (recorded) | What the ledger asks |
|---|---|---|---|
| dc539d923 → 893a666a5 | 15 files: `App.tsx`, `reviewCopies.ts`, the user guide and its images, tests | the full e2e set (about 52 min); 4 review scenarios × 3 fake providers | the same: full fake set (fallback), the 4 scenarios |
| 893a666a5 → ee2d45a66 | 26 files: `servers.ts`, `cw-mcp.ts` and 6 more in `src/main`, tests, docs | the installer build, packaged 5/5, Sandbox 103/136 (the failures from the Sandbox's own driver and shipped sample text: HI-2644 to 2648) | the same |
| ee2d45a66 → a7a7816df | 99 files: 60 locale files, `workspace.ts`, `workspaceMove.ts`, `connectionMoves.ts`, `accounts.ts`, `tests/sandbox` | the full e2e set, a rebuild, Sandbox 137/137, packaged 5/5 | the same: shared code (fallback), profile and connection moves and the Sandbox's tests give every Sandbox kind |
| a7a7816df → ac8e5773a | 12 files: `ipc.ts`, `workspace.ts` (settings), `actions.ts`, `Overlays.tsx`, tests | 8 named e2e suites, the changed unit tests, a rebuild, Sandbox 137/137, packaged 5/5 | **the full fake set** (fallback: the 8 suites had no written boundary analysis); a rebuild, packaged, **Sandbox `fresh` only** (no upgrade, migration or installer input changed) |
| ac8e5773a → ac6969d75, the release commit | the version (both lockfile fields only), CHANGELOG, RELEASING and dev skills, scenario and e2e test files | the full fake set and the real tier, 65.7 min | the package checks, the changed tests, and the real tier for the manifest: 31 suites, 14.3 min. Its version files were a bare bump, which `manifestCheck` now passes (HI-2676); the record moved for the rest of that diff (RELEASING, AGENTS, the dev skills, `tests/oldNamesAllow.json`, `tests/e2e/evidence.cjs`, the scenario runner), none of them on the allowlist |
| ac6969d75 → 912a43f52, and the 1.1.0 installer | the manifest only | no packaged or Sandbox row on the 1.1.0 installer's bytes | **added:** packaged, Sandbox `fresh` and `upgrade` on the 1.1.0 installer, its SHA-256 recorded; the other kinds carried forward (none of their inputs changed since a7a7816df) |
| HI-2656, HI-2657 | the fake suites `advanced` and `mergequeuefolder`, test-only | deferred until after the release, because they would have moved the manifest | they merge into the release commit and their two suites run, a few minutes; the manifest stands (allowlist) |

The net, from the records' times, as estimates and not measurements:
- **Saved:** the release commit's fake set (about 51 min, 65.7 − 14.3), and the non-`fresh` Sandbox kinds at ac8e5773a (about 10–15 min; the reports give build-to-report time, not per kind).
- **Added:** the fake set at ac8e5773a (about 52 min), and the 1.1.0 installer's packaged, `fresh` and `upgrade` rows (about 15–20 min).
- **About zero overall for RC4.** Most of RC4's rounds touched code `--affected` treats as shared, and no round had a written boundary analysis. The ledger pays where a fix is test-only or version-only, or where a boundary analysis is written. HI-2690 measured these rounds again with its rules: each still selects every suite, by `App.tsx` (RC4 1), `servers.ts` (RC4 2) and `workspace.ts`'s members (RC4 3 and 4, HI-2678's), though RC4 3 no longer does so for `shared/types.ts`, its `values/*.d.ts` or its `tests/sandbox` files.

A release has **no known gaps**: a card showing that one of the release's features is unfinished joins the release's path before the RC, or the user moves it out of the release.

## Release notes

`CHANGELOG.md`'s **Unreleased** section becomes the notes (Step 3). Read it as a user of the last release would.

For 1.0, that's a 0.9.3 user. It says first:
- that the upgrade is one way: **back up first, there's no going back**;
- what Help → Restore the 0.9 Board Backup… brings back (the board's cards and history), and that it isn't a way back for worktrees, sessions or lanes;
- that every 0.9.3 on the workspace must be closed first.

Then it says what's new.

## Steps

These are the steps for an uploaded release: an RC, or the release. The commit to release is on `main`, or for an RC, on the integration branch.

1. **Release candidate first.** Before any version change, build an installer at the **current** version from the commit to release (`npm run dist`, in the main checkout, at that commit) and have the user install and test it. The full unit run (`npm test`) and the full fake set (`npm run e2e -- --all --build --record`) run on that commit first, once each (What a release checks): merges run only focused checks (#1010; AGENTS.md, Tests), so the first RC is the checkpoint where every suite runs; a failure is a release finding, and its fix round reruns only what failed and what the fix touches. Before the user installs it, run the Sandbox checks on it (`npm run sandbox-checks`, `tests/sandbox`: the release-combwork skill and tests/e2e/README.md) and attach the report to the release card. Fixes found now go in before the bump; the bump is step 3.
2. **Push and let CI pass before the bump.** Push the release-candidate commit (the user pushes) and wait for `.github/workflows/ci.yml` to pass on it. The 0.4.0 push found a failure no local run could: #389, 8.3 short paths on GitHub's runner. CI on the pushed commit is the check that counts.
3. **Version and release notes.** Set `version` in `package.json` (semver: `0.2.0`, or `0.2.0-beta.1` for a pre-release) and run `npm install` so `package-lock.json` matches. In `CHANGELOG.md`, turn the **Unreleased** section into `## <version> — <date>`: it is bundled into the app (Docs → Release Notes), and the same text goes in the GitHub release. Commit everything; the script refuses to run on a dirty tree. It also refuses stale third-party notices (`npm run licenses -- --check`; the unit tests and CI check the same): run `npm run licenses` and commit them. When the release adds dependencies, bundled libraries, assets or installer parts, audit their licences first with the **licence-audit** skill (vendored material and what the installer adds included; `scripts/thirdPartyNotices.mjs` lists the bundled renderer libraries).
4. **The real tier**, once: on the bumped commit, or on the RC's commit before the bump, whose record a version-only bump keeps (What a release checks, the release of the tested candidate; HI-2676). The full fake set has passed on the candidate's code (Step 1); it isn't run again for the real tier. With the CLIs signed in (the release-combwork skill checks that first), run the real-CLI suites: `npm run e2e -- --all --only-real contract-copilot copilot copilotcopy copilotsize hookscopilot wakepaste-copilot --build --record`. `--all --only-real` is the whole real tier (Claude Code's and Codex's suites; without `--all`, naming suites runs only those named), and the names are Copilot's suites, those with `copilot` in their `needs` in `tests/e2e/suites.mjs` (`reviewcopiesreal` is in the real tier already; `tests/guidance.test.ts` fails when this list misses one). Copilot's suites run the real Copilot CLI offline, so they are in the fake set, not the real tier: a record without them has no Copilot version (0.8.0 found this), and a suite named always runs. `npm run tested-clis` checks that every real suite of each CLI is in the record, so a missed one is refused, not passed over (HI-2484's manifest came from such a record, `run-20261106-210629`, 31 suites). `--all --real` (both tiers in one record) works too, but runs the fake set again. Keep the record. Every real suite must pass: a suite that failed or was skipped for the environment (a sign-in, a usage limit, the network) is rerun on this exact code, with a stable CLI version and its sign-in in place, before step 5. A reviewer's acceptance of a skip doesn't stand in for that: `npm run tested-clis` requires every real suite of each CLI to have run and passed. The real tier may also run one CLI at a time (when one CLI's suites can't share the machine with another's, as Codex's with a Store PowerShell 7 for 0.9.2, #585): each run on this same commit, with `--record`, its record kept.
5. **The tested-with manifest.** Run `npm run tested-clis` on that record (or on the per-CLI records, all of this commit: `npm run tested-clis -- <record> <record>…`, each CLI's entry from the record where all its real suites ran and passed; never a record merged by hand, #1105) and commit `resources/tested-clis.json` (what Provider Setup shows as "Tested with", #365). It writes each CLI's version from the record, and exits 1 if a CLI's real suites ran different versions or the record doesn't say which. To test one CLI at two versions (HI-2780: Copilot's newest from GitHub beside the one WinGet still offers), run its real suites once per version on this same commit, each with `--record`, then `npm run tested-clis -- --also copilot <record> <record>`: the newest becomes the version, the other its `also`, each only from a record where all its real suites passed at that version, and Provider Setup ticks either. A CLI can update itself during the run (Codex went from 0.160.1 to 0.161.0 during 0.4.0's): then rerun the real tier on one stable version. A new real-tier failure after a CLI update may be a real change in behaviour (#396), not noise. `npm run release` refuses a manifest that isn't from a run on this code, so only the manifest, test-only files on its allowlist (What a release checks, The coverage ledger) and the version bump itself (HI-2676) may differ since the run. Each CLI's entry comes from this run's real suites, which run in the test homes (`%LOCALAPPDATA%\combwork-test\claude` and `…\codex`), not in your own `~/.claude` or `~/.codex`; the sign-ins are in the release-combwork skill and tests/e2e/README.md.
6. **Build and upload:** `npm run release`. It uses your `gh` login (`gh auth status` to check), builds, and creates or updates the draft release `v<version>` (titled **Combwork <version>**, package.json's productName) with the three files. It builds in the checkout's own `dist` by `npm run dist`'s rules and writes `dist/build-info.json` for what it uploaded (Notes).
7. **Review the draft** on GitHub. Write the release notes (the updater shows them in Combwork's update dialog; Markdown works). When the changelog is long, put a short summary at the top for that dialog. Tick **Set as a pre-release** for a beta, then **Publish**. Publishing creates the tag.
8. **Check** from an installed copy: Help → Check for Updates.

Pre-releases are only offered to users who turned on **Settings → Updates → Include pre-releases**.

**A bug found in a released version** gets a public GitHub issue (asked). It's closed "Fixed in <version>" once that version ships the fix.

## A dialect-only release

Combwork ships dialect files (`resources/dialects/`: a model file for each model it tunes, the CLI files and the API file; the dialects design, plans/2026-11-03-dialects-design.md), which each workspace gets a copy of: an untouched copy follows an update, an edited one is kept and offered Revert. A change to a shipped file goes in only once it's measured, on its own card (the scenarios and model trials for that dialect's model against the baseline). To ship such changes without a full release, they go out as a **patch release** (`1.0.x`, decided 1 Nov on HI-2065), batched rather than one per file, with lighter checks: the code is the last release's, so its checks still stand.

`npm run release -- --dialects` makes one. Beside the usual (a clean tree, the `gh` login, the notices), it refuses unless, since the last release's tag (the newest `v<major>.<minor>.<patch>` HEAD contains, never a pre-release's; `git fetch --tags` first):
- only files under `resources/dialects/` changed, with `CHANGELOG.md`, `package.json` and `package-lock.json` (their version only) and `src/main/bundledHistory.json` (the dialect versions `npm run bundled-history` records, no skill or mode);
- at least one dialect file changed;
- the version is a patch of that release (`1.0.0` → `1.0.1`), not a pre-release.

The tested-with manifest therefore can't have changed, and still holds, so the real tier isn't run again. The script runs the dialect checks itself before it builds (`DIALECT_CHECKS` in `scripts/dialectRelease.mjs`: the shipped files and their schema check, the dialects service, the bundled sync), then builds and uploads the draft as Steps 6 does. Those tests check what any shipped file must be (Combwork's form, the schema, a `why` on every override, one file per model), never which texts it holds, so a measured override or another model's file passes them unchanged: a patch that had to change a test isn't dialect-only. They run with Vitest's module cache off (`dialectCheckArgs`), which would otherwise keep an old schema. Its rules are tested with fakes (`tests/dialectRelease.test.ts`): never run `npm run release` to try them.

Each step needs the user's OK as for any release (The user's OK). In order:
1. **The scenarios for each changed dialect's model** against the baseline, on the release commit: the results each dialect's card measured, rerun there (`npm run scenarios -- --dialect …`; tests/scenarios/README.md). No other model's trials.
2. **Version and notes** (Steps, step 3): the patch version and an Unreleased section turned into `## <version> — <date>`, naming each dialect file changed and why. Commit; push and let CI pass (Steps, step 2).
3. **`npm run release -- --dialects`**, in the main checkout at that commit.
4. **The packaged checks** on that build (`npm run e2e -- packaged-mcp packaged-progress`: the app starts and reads its files) and **the Sandbox checks** with the upgrade check from the last release's installer (`npm run sandbox-checks -- … --previous <it>`; the release-combwork skill): the patch installs over the release and the app reads its dialect files.
5. **Review and publish the draft** (Steps, steps 7 and 8).

Not needed: the full e2e set, the real tier, the full unit run, or other models' trials: no code changed, and the script proves it. Anything else in the diff (a fix, a test, a skill) means a full release.

## Notes

- `npm run dist` builds the installer locally and never publishes. It writes `dist/build-info.json` (the code, commit and branch it was built from), only if none of them changed while it built (otherwise it says the build must be made again once the code stays put, and copies nothing). Run in an agent's git worktree, it also copies the installer, its blockmap, `latest.yml` and the build info to the **main checkout's** `dist`, where the user looks for them, and says so; it never replaces an installer of the same name there built from other code (`--replace` does), and `--here` keeps it in the worktree only. Worktrees copying at the same time take turns (a lock in the main `dist`), and a copy is whole or not at all. `npm run release` follows the same rules in the checkout it runs in (HI-2411): before building, it refuses (and creates no draft) when its `dist` already has an installer of the same name built from other code or from code it can't tell (no `build-info.json`); `--replace` builds over it, so move the old one aside first to keep it. One built from the same commit is replaced without a word. From that check until it ends, the release holds its `dist` (`dist/.release-build.json`, naming its process; left by one that failed, it lapses once that process is gone): a worktree's `npm run dist` doesn't copy an installer there meanwhile, even with `--replace` (it says so; run it again after the release), and a second release refuses. `npm run dist` holds the `dist` it builds in the same way while it runs (`dist/.dist-build.json`, HI-2417): it refuses, building nothing, while a release or another `npm run dist` holds that `dist`, so a local build in the main checkout can't replace the installer a release there is uploading; and while it builds, a release there refuses and a worktree's copy waits for it, as above. After the upload it writes `dist/build-info.json` for the installer it uploaded (only if the code didn't change while it built, as above), and copies nothing elsewhere: build a release in the main checkout, at the commit being released.
- Don't delete or replace the files of a published release: installed copies may be halfway through downloading them. Publish a new version instead.
- Publishing settings are in `electron-builder.yml` (`publish:`). The feed URL is also in `src/shared/defaults.ts` (`RELEASES_URL`) for the "What's new" links.
