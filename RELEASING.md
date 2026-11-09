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
- opening or merging a GitHub pull request (it's public), and merging into `main`, which only a pull request can (The release path, `main` is protected);
- using the admin bypass of `main`'s protection (an emergency only, recorded on the release card);
- merging `main` into the next version's branch;
- `npm run release` (it uploads a draft);
- publishing the draft, and creating tags;
- opening or closing a GitHub issue (it's public).

Freezing a release, what counts as a release blocker and how long an RC soaks are the user's decisions too (The release path).

An agent takes the OK in its own pane: the release-combwork skill says how.

## Betas and RCs

A build's pre-release name says what it is (HI-2308):

- **`-beta.<n>`: a working build**, installed to use while work goes on (`npm run dist`; the journal records it as a beta from its version, or `--kind beta`), built from the release branch's head before the freeze. Its checks are the release branch's own (the merge checks, CI on the pushed head, the quiet-time full runs: AGENTS.md, Tests), not a release's. It isn't uploaded unless the user asks, and then as a GitHub pre-release.
- **`-rc.<n>`: a real release candidate** only: built after the freeze, after the full checks (What a release checks), and meant to become the release unless something is found. Every RC is an `-rc.<n>` build: there is no candidate at the release's own version.

Semver orders them `1.1.0-beta.3` < `1.1.0-rc.1` < `1.1.0`, so a version's betas all come before its first RC. Once a version has an RC, a fix to it is the next RC: a beta then would be older than the installed RC. 1.0 named every installable build `-rc.<n>`: rc.17 on were real candidates, and the earlier ones (rc.10 to rc.16 in particular) were working builds that would now be betas.

What the updater offers (GitHub's releases feed through Combwork's provider, `src/main/updateFeed.ts`; versions compared by semver, `src/shared/updates.ts`): with **Include pre-releases** off, releases only. With it on, a pre-release install is offered the newest uploaded version newer than it, beta, RC or release, in that semver order: a beta gets a later RC, an RC the release (HI-2311); a release install takes the feed's newest entry. Builds before 1.0.0-rc.19 lack this: there an installed beta is never offered an RC and an installed RC only a later RC, never the release, so someone on rc.18 or earlier reaches 1.0.0 by updating to the last RC first, or by turning **Include pre-releases** off.

## The release path

A release is made on its own **release branch**, named for its version (`1.3.0`), and reaches `main` through a pull request. `main` holds what was released, and a patch's fixes (stage 5). The stages, in order:

1. **Develop on the release branch.**
   - The branch is made from `main` and is the project's **Work merges into** (Version Control → Workflow → Merging; the user guide's Merging into another branch). Lanes merge into it through the merge queue, each merge with the merge checks (AGENTS.md, Tests).
   - **Early on**, at its first push, the user pushes the branch and opens a **draft pull request into `main`** (asked: The user's OK). CI (`.github/workflows/ci.yml`) runs on pull requests, so from then on **every push of the branch runs CI**, on the branch as it would merge into `main`. The user pushes at natural points: a batch of merges, before a beta, the end of a day.
   - **A red CI is fixed then**, as a card of its own straight away, not at release time.
   - `ci.yml` is left as it is: it runs on pushes to `main` and on pull requests. The draft pull request already runs CI on every push of the branch, and a push trigger for release branches as well would run it twice for each push (the push and the pull request are separate runs) and test the branch on its own rather than merged with `main`. Changing `ci.yml` would also be a path in no class, which invalidates a release's every slice (The coverage ledger).
   - The full fake set runs on the branch at quiet times (tests/e2e/README.md, Which suites to run), and betas are built from its head when the user wants one (Betas and RCs).
2. **Freeze and rc.1.**
   - When the release's planned cards are Done (merged into the branch) and none of its features is unfinished (What a release checks: no known gaps), the user **freezes** the release. From then on only **release blockers** join it: a regression from the last release, data loss or a safety problem, a new feature of this release that's broken, or a red CI. Each is marked with the `release-blocker` label (below). Everything else goes to the next version.
   - **The RC card** for rc.1 (A release's cards): the version `<version>-rc.1`, set on the release branch; the full release checks, **once**, on its commit (What a release checks: the first release candidate; Steps 1, 4 and 5), with the coverage ledger started; then the installer, `npm run dist` (asked), with the packaged checks and the Sandbox checks on its bytes.
   - **The user installs it.** Optionally, the user asks for it to be uploaded as a **GitHub pre-release** for opted-in testers (Steps 6 to 8, with **Set as a pre-release** ticked; asked): the uploaded installer gets packaged and Sandbox `fresh` rows of its own bytes (The coverage ledger, the artifact rules).
3. **Soak.**
   - The user works on the RC for a minimum time: **one day of normal use**, unless the user says otherwise. The minimum applies to each RC.
   - Meanwhile **the next version starts on its own branch** (`1.4.0`), made from the release branch at the freeze, so lanes aren't idle: it goes under **Other branches work can merge into**, and **Work merges into** moves to it (the user guide's Merging into another branch, When a release ships: **Also retarget what can move** moves the cards and lanes it can, and the Assistant lists them first). A blocker's card keeps, or is given back, the release branch as its **Merges into**.
   - **A blocker** gets a card with the `release-blocker` label, merging into the release branch, fixed with a card's budget for its kind (AGENTS.md, Tests per card). Then the next RC card: `rc.N`, with only the fix's slice of the checks rerun, per the coverage ledger (What a release checks: an RC fix round), and the soak starts again on it.
   - **The manifest is stricter than the ledger**: `npm run release` takes only a record of the released code, besides the manifest, the test-only allowlist and the version bump (The coverage ledger). So an RC whose fixes since rc.1 changed anything else runs the real tier again on its own commit (Steps 4 and 5, about 15 minutes), even where the ledger has no slice of it invalid.
4. **Release**, once an RC has soaked with no open blockers:
   - **The version card**: `<version>` (from `<version>-rc.N`) and `package-lock.json`, the CHANGELOG's Unreleased section turned into the release's, and the tested-with manifest from the last RC's real-tier record if the RC didn't commit it (Steps 3 and 5). Nothing else changes, so the RC's record and coverage stand (a version-only bump keeps it: HI-2676). The merge queue merges it into the release branch.
   - **The user pushes**, CI is green on the pull request (Step 2), the user marks it ready and **merges it into `main`** (asked), as a merge commit, so `main` has the tested commits. This is the only way the release reaches `main` (`main` is protected, below).
   - **Nothing reruns** when `main` hasn't moved since the release branch last took it in (`git log <release branch>..origin/main` is empty): the merge's tree is the tested one. If it has (a patch, stage 5), `main` is merged into the release branch before the version card (asked), its change gets its ledger row, and only the slices the ledger marks invalid rerun.
   - **The publish card** (no code), blocked by the version card: `npm run release` in the main checkout at the merged `main` commit (Step 6, asked), the packaged checks and Sandbox `fresh` and `upgrade` on the release installer's own bytes (What a release checks: the release of the tested candidate), the draft for the user to review and publish (which tags: Step 7), then Help → Check for Updates (Step 8).
5. **After the release.**
   - `main` is merged into the next version's branch (asked), bringing the release's version and notes. Cards and lanes still on the release branch are retargeted to the next one (the user guide's Merging into another branch, When a release ships), and the release branch is deleted only after that.
   - **A patch** (`x.y.1`) comes from `main`, on a **patch branch** made from it (named for its version, `1.3.1`) and set as the fix cards' **Merges into**: they merge into it through the merge queue, never into `main` (`main` is protected, below). It goes out as a small patch release, its checks the fix-round budget by the release's coverage ledger (What a release checks: an RC fix round), then a version card on the patch branch; the user pushes it, CI is green on its pull request into `main`, and the user merges that (asked), as a merge commit; then the publish card from the merged `main` commit, and `main` merged into the next version's branch again. A dialect-only patch has its own path (A dialect-only release), and reaches `main` the same way.
   - **A bug found in a released version** gets a public GitHub issue (asked). It's closed "Fixed in <version>" once that version ships the fix.

### `main` is protected

GitHub's branch protection on `main` (the repository's ruleset **Main**) holds every route to it to the release path:
- **Everything reaches `main` through a pull request with CI green**: the release's pull request (stage 4) and a patch's (stage 5). Its CI status check `check` is required, and the branch must be up to date with `main` before it merges, so a pull request behind `main` takes `main` in first (asked; stage 4 says what then reruns). No approval is required: the user's merge is the OK (The user's OK). `git push origin main` is refused, as are force pushes and deleting `main`, so nothing (a card, a lane's merge, a fix) merges into `main` locally to be pushed: work goes to the release or patch branch.
- **A pull request into `main` is merged with a merge commit**, keeping the release's commits and their card keys (their `Combwork-Card` trailers, `Hive-Card` in older commits), never squashed or rebased: the ruleset allows only merge commits, and the tested commits are the ones `main` gets.
- **The admin bypass is for an emergency only**: the repository admin can bypass the rules, on a pull request only (never a direct push), when CI is broken by something outside the code, such as a fault in GitHub's runner. Using it is the user's decision, asked each time, and recorded on the release card (or the patch's version card) with why and which run failed. A failure in the code is fixed, never bypassed.

### The release-blocker label

On the board, `release-blocker` marks the cards that may join a frozen release. Before the freeze it isn't used: every card targeting the release branch belongs to the release. After the freeze:
- a new card goes into the release only if it is a blocker by the list in stage 2; the user decides, and the card gets the label and the release's version label, with its **Merges into** set to the release branch;
- a card without the label merges into the next version's branch, however small;
- the RC card names the blockers it takes in, and a release has no open blockers: no card with the label and the release's version label that isn't Done;
- a red CI on the pull request is a blocker card too.

## A release's cards

A version change and the build made from it are separate cards in one lane, because a lane ends its builder's session when its last card merges, so steps written after the merge on a code card are lost: rc.17's HI-2297 lost its build that way, and its builder had to be restarted to make it.

- **The RC card** (code), one per RC: the version `<version>-rc.N`, that RC's checks (rc.1: the first RC's; rc.N: what the ledger marks invalid since the last RC), the installer built from the card's own commit before it is submitted (`npm run dist`, asked: a worktree's build is copied into the main checkout's `dist`, Notes), its packaged and Sandbox checks, and the coverage ledger, which the card names in its context and its builder keeps each round. Its reviewer checks the ledger against the diff. Nothing comes after its merge but the user's install: the branch is frozen, so its merge changes no code; a blocker merged meanwhile is a row in the ledger's Changes since and goes into the next RC.
- **The version card** (code): the release's version, the lockfile, the notes and the manifest (stage 4). The merge queue merges it.
- **The publish card** (no code), blocked by the version card: what comes after the merge into `main`, from the merged commit (stage 4). Nothing else merges between the two cards: `npm run release` refuses code that differs from the real tier's run, other than the manifest, the test-only files on its allowlist (The coverage ledger) and the version bump itself (HI-2676).

## Builds and the journal

Each build `npm run dist` or `npm run release` makes is recorded in `dist/build-info.json`, beside its installer: the code, commit and branch it was built from (Notes). Each successful build, by `npm run dist` or `npm run release`, also goes into the Combwork Assistant's journal as Combwork's entry: its kind (`--kind beta|baseline|rc|release`, else from the version: a `-beta.n` is a beta, an `-rc.n` an RC, and a release version is `npm run release`'s release or `npm run dist`'s candidate for it), version, commit and installer. It's sent to Combwork while it's running; otherwise it's recorded when the workspace next opens. **Settings → Advanced → Record builds in the journal** turns it off.

A build also says inside itself whether it is local (#1647, SPEC §11.1): `npm run dist` packages `build-identity.json` with `local: true`, and its installer waits for another Combwork installer to finish before installing; `npm run release` packages `local: false`, and its installer doesn't wait. An installed local build is never replaced by a release of its own version (it's offered instead), so a build made with `npm run dist` at the release's version and then released as the same version isn't updated to the published build: install the published one by hand. RCs at `-rc.<n>` avoid this: the release is a newer version than any of them.

## What a release checks

An uploaded release's checks, unlike a beta's, have a budget for each stage (HI-2658; AGENTS.md, Tests per card, has the cards' budgets). Each is the checking's wall-clock, not fixes, usage limits or queue waits. An over-budget run is a reason to look at what was selected or what changed, never to call unrun checks passed.

- **The first release candidate**, about **2–3 hours**: on its commit, once each: the full unit run (`npm test`); the full fake set (`npm run e2e -- --all --build --record`, Step 1); the real tier for every CLI, once (Step 4); the i18n checks, with all text translated in the 7 locales and checked in context (#1126); the relevant fake scenarios against the baseline (`npm run scenarios -- --only <ids>` for what changed; for a guidance-wide change each fake's default run, which `tests/scenarios/fakeScope.cjs` scopes by provider, AGENTS.md); the packaged checks and the Sandbox checks on the installer; and the model trial: **3 to 5 scenarios picked at random** from the trial set, once each, with no repeats (`npm run scenarios -- --provider <provider> --random 3`, which prints the ids it picked and its seed; HI-2655). The RC card names the seed or the ids, so the same pick can be run again (`--random 3 --seed <seed>`, or `--only <ids>`). The full set on every provider is not a release step (the user, 6 Nov: Combwork is used daily on real models, where a failure would be noticed first); it is for guidance-wide changes (AGENTS.md).
- **An RC fix round**, **15–45 min**: the tests that failed, plus the fix's affected boundaries (its unit tests and callers, the suites covering it), on the fixed commit. The rest of the candidate's results stand where the fix didn't touch them; the whole list doesn't start again. The installer and its Sandbox checks are rebuilt and run again only when the fix changed what ships or a migration. Which results still stand, and what each change since invalidates, is the coverage ledger's to record (below).
- **The release of the tested candidate**, **15–30 min**: the artifact is the one tested (its commit, and nothing changed since but the version, the release notes and the manifest), its version and the package checks (`npm run build`, the licences, the packaged checks), and an upgrade smoke test from the last release, on the release installer's own bytes (the coverage ledger's artifact rules). The candidate's coverage stands. A source change, or a new CLI version, invalidates the slice it touches: that slice runs again. The candidate's tested-with manifest stands too: `npm run release` takes a record of an earlier commit when the only changes since it are the manifest, test-only files on its allowlist, and the version bump itself (`manifestCheck`, `scripts/testedClis.mjs`, HI-2676): `version` in package.json, the lockfile's two version fields, and CHANGELOG's one `## Unreleased` heading become `## <version> — <date>`, all saying the same version, with nothing else changed in those files. Anything more in them (a script, a dependency, other release-note wording) asks for the real tier on the bumped commit, Step 4's command (HI-2484's took 14 minutes).

### The coverage ledger

Each release keeps one **coverage ledger** (HI-2661): a shared note, `shared:releases/<version>-coverage.md`, that each RC card names in its context. The RC card's builder edits it in place each round, so it always says what stands now. It has two tables.

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

**Changes since**, a row for each change merged after the first pass. Each row gives the commit and its card, its paths by class (below), the slices it invalidates, and the pass rows rerun for it. A slice's evidence stands while no change since invalidates it. **A fix round reruns the invalidated slices and nothing else.** A doubt still allows any rerun, said as "reran X because Y". The RC card's reviewer checks the ledger against the diff, not by rerunning; where an invalidation choice is in doubt it asks for focused proof.

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
- **The version-only bump** (`versionOnlyFiles`, HI-2676): `package.json`, `package-lock.json` and `CHANGELOG.md`, changed only as the release of the tested candidate, above, says: `version`, the lockfile's two version fields and the one `## Unreleased` heading become `## <version> — <date>`, all the same version. An RC keeps the Unreleased heading, so the version card's bump from `<version>-rc.N` is one.
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

A release has **no known gaps**: a card showing that one of the release's features is unfinished joins the release before the freeze, or the user moves it out of the release.

## Release notes

`CHANGELOG.md`'s **Unreleased** section becomes the notes (Step 3). Read it as a user of the last release would: first anything they must do or know before updating (a one-way upgrade, something to back up or close first), then what's new.

## Steps

These are the steps for an uploaded release: the procedures the stages of The release path use, each named there by its number. For an RC the commit is on the release branch; for the release it is the merged `main` commit (stage 4).

1. **The first RC's full checks.** On rc.1's commit (its version set, `<version>-rc.1`), the full unit run (`npm test`) and the full fake set (`npm run e2e -- --all --build --record`) run once each (What a release checks): merges run only focused checks (#1010; AGENTS.md, Tests), so the first RC is the checkpoint where every suite runs; a failure is a release finding, and its fix round reruns only what failed and what the fix touches. Then its installer (`npm run dist`, asked) and, before the user installs it, the Sandbox checks on it (`npm run sandbox-checks`, `tests/sandbox`: the release-combwork skill and tests/e2e/README.md), their report attached to the RC card. A later RC runs the slices the ledger marks invalid instead, and its own installer's packaged and Sandbox `fresh` rows.
2. **Push and let CI pass.** The user pushes the release branch (or a patch's branch), and `.github/workflows/ci.yml` passes on its pull request (stage 1) for the commit to release: `main` requires it before the merge (The release path, `main` is protected). The 0.4.0 push found a failure no local run could: #389, 8.3 short paths on GitHub's runner. CI on the pushed commit is the check that counts.
3. **Version and release notes.** Set `version` in `package.json` (semver: `1.3.0-rc.1` for an RC, `1.3.0` for the release) and run `npm install` so `package-lock.json` matches. For the release, turn `CHANGELOG.md`'s **Unreleased** section into `## <version> — <date>`: it is bundled into the app (Docs → Release Notes), and the same text goes in the GitHub release. An RC keeps it as Unreleased. Commit everything; `npm run release` refuses to run on a dirty tree. It also refuses stale third-party notices (`npm run licenses -- --check`; the unit tests and CI check the same): run `npm run licenses` and commit them. When the release adds dependencies, bundled libraries, assets or installer parts, audit their licences first with the **licence-audit** skill (vendored material and what the installer adds included; `scripts/thirdPartyNotices.mjs` lists the bundled renderer libraries).
4. **The real tier**, once: on the RC's commit, whose record the release's version-only bump keeps (What a release checks, the release of the tested candidate; HI-2676), or on the bumped commit when more than the bump changed since. The full fake set has passed on the candidate's code (Step 1); it isn't run again for the real tier. With the CLIs signed in (the release-combwork skill checks that first), run the real-CLI suites: `npm run e2e -- --all --only-real contract-copilot copilot copilotcopy copilotsize hookscopilot wakepaste-copilot --build --record`. `--all --only-real` is the whole real tier (Claude Code's and Codex's suites; without `--all`, naming suites runs only those named), and the names are Copilot's suites, those with `copilot` in their `needs` in `tests/e2e/suites.mjs` (`reviewcopiesreal` is in the real tier already; `tests/guidance.test.ts` fails when this list misses one). Copilot's suites run the real Copilot CLI offline, so they are in the fake set, not the real tier: a record without them has no Copilot version (0.8.0 found this), and a suite named always runs. `npm run tested-clis` checks that every real suite of each CLI is in the record, so a missed one is refused, not passed over (HI-2484's manifest came from such a record, `run-20261106-210629`, 31 suites). `--all --real` (both tiers in one record) works too, but runs the fake set again. Keep the record. Every real suite must pass: a suite that failed or was skipped for the environment (a sign-in, a usage limit, the network) is rerun on this exact code, with a stable CLI version and its sign-in in place, before step 5. A reviewer's acceptance of a skip doesn't stand in for that: `npm run tested-clis` requires every real suite of each CLI to have run and passed. The real tier may also run one CLI at a time (when one CLI's suites can't share the machine with another's, as Codex's with a Store PowerShell 7 for 0.9.2, #585): each run on this same commit, with `--record`, its record kept.
5. **The tested-with manifest.** Run `npm run tested-clis` on that record (or on the per-CLI records, all of this commit: `npm run tested-clis -- <record> <record>…`, each CLI's entry from the record where all its real suites ran and passed; never a record merged by hand, #1105) and commit `resources/tested-clis.json` (what Provider Setup shows as "Tested with", #365): on the RC card, or at the latest on the version card. It writes each CLI's version from the record, and exits 1 if a CLI's real suites ran different versions or the record doesn't say which. To test one CLI at two versions (HI-2780: Copilot's newest from GitHub beside the one WinGet still offers), run its real suites once per version on this same commit, each with `--record`, then `npm run tested-clis -- --also copilot <record> <record>`: the newest becomes the version, the other its `also`, each only from a record where all its real suites passed at that version, and Provider Setup ticks either. A CLI can update itself during the run (Codex went from 0.160.1 to 0.161.0 during 0.4.0's): then rerun the real tier on one stable version. A new real-tier failure after a CLI update may be a real change in behaviour (#396), not noise. `npm run release` refuses a manifest that isn't from a run on this code, so only the manifest, test-only files on its allowlist (What a release checks, The coverage ledger) and the version bump itself (HI-2676) may differ since the run. Each CLI's entry comes from this run's real suites, which run in the test homes (`%LOCALAPPDATA%\combwork-test\claude` and `…\codex`), not in your own `~/.claude` or `~/.codex`; the sign-ins are in the release-combwork skill and tests/e2e/README.md.
6. **Build and upload:** `npm run release`, in the main checkout at the commit to release. It uses your `gh` login (`gh auth status` to check), builds, and creates or updates the draft release `v<version>` (titled **Combwork <version>**, package.json's productName) with the three files. It builds in the checkout's own `dist` by `npm run dist`'s rules and writes `dist/build-info.json` for what it uploaded (Notes).
7. **Review the draft** on GitHub. Write the release notes (the updater shows them in Combwork's update dialog; Markdown works). When the changelog is long, put a short summary at the top for that dialog. Tick **Set as a pre-release** for a beta or an RC, then **Publish**. Publishing creates the tag.
8. **Check** from an installed copy: Help → Check for Updates.

Pre-releases are only offered to users who turned on **Settings → Updates → Include pre-releases**.

## A dialect-only release

Combwork ships dialect files (`resources/dialects/`: a model file for each model it tunes, the CLI files and the API file; the dialects design, plans/2026-11-03-dialects-design.md), which each workspace gets a copy of: an untouched copy follows an update, an edited one is kept and offered Revert. A change to a shipped file goes in only once it's measured, on its own card (the scenarios and model trials for that dialect's model against the baseline). To ship such changes without a full release, they go out as a **patch release** (`1.0.x`, decided 1 Nov on HI-2065), batched rather than one per file, with lighter checks: the code is the last release's, so its checks still stand.

`npm run release -- --dialects` makes one. Beside the usual (a clean tree, the `gh` login, the notices), it refuses unless, since the last release's tag (the newest `v<major>.<minor>.<patch>` HEAD contains, never a pre-release's; `git fetch --tags` first):
- only files under `resources/dialects/` changed, with `CHANGELOG.md`, `package.json` and `package-lock.json` (their version only) and `src/main/bundledHistory.json` (the dialect versions `npm run bundled-history` records, no skill or mode);
- at least one dialect file changed;
- the version is a patch of that release (`1.0.0` → `1.0.1`), not a pre-release.

The tested-with manifest therefore can't have changed, and still holds, so the real tier isn't run again. The script runs the dialect checks itself before it builds (`DIALECT_CHECKS` in `scripts/dialectRelease.mjs`: the shipped files and their schema check, the dialects service, the bundled sync), then builds and uploads the draft as Steps 6 does. Those tests check what any shipped file must be (Combwork's form, the schema, a `why` on every override, one file per model), never which texts it holds, so a measured override or another model's file passes them unchanged: a patch that had to change a test isn't dialect-only. They run with Vitest's module cache off (`dialectCheckArgs`), which would otherwise keep an old schema. Its rules are tested with fakes (`tests/dialectRelease.test.ts`): never run `npm run release` to try them.

Each step needs the user's OK as for any release (The user's OK). In order:
1. **The scenarios for each changed dialect's model** against the baseline, on the release commit: the results each dialect's card measured, rerun there (`npm run scenarios -- --dialect …`; tests/scenarios/README.md). No other model's trials.
2. **Version and notes** (Steps, step 3): the patch version and an Unreleased section turned into `## <version> — <date>`, naming each dialect file changed and why, on a patch branch from `main` (The release path, stage 5). Commit; the user pushes, CI passes on its pull request into `main` (Steps, step 2), and the user merges it as a merge commit (`main` is protected).
3. **`npm run release -- --dialects`**, in the main checkout at the merged `main` commit.
4. **The packaged checks** on that build (`npm run e2e -- packaged-mcp packaged-progress`: the app starts and reads its files) and **the Sandbox checks** with the upgrade check from the last release's installer (`npm run sandbox-checks -- … --previous <it>`; the release-combwork skill): the patch installs over the release and the app reads its dialect files.
5. **Review and publish the draft** (Steps, steps 7 and 8).

Not needed: the full e2e set, the real tier, the full unit run, or other models' trials: no code changed, and the script proves it. Anything else in the diff (a fix, a test, a skill) means a full release.

## The 1.0 path (history)

1.0 had no release branches yet: it was built on a long-lived `1.0.0` branch while `main` carried 0.9.x fixes, in phases each closed by a checks card (#1449), then a **baseline install** (#1288) the user used daily before anything was uploaded (built with `npm run dist -- --kind baseline`, lighter checks, a one-way upgrade from 0.9.3 whose notes said to back up first and close every 0.9.3), then RCs and the release (#1541), each RC preceded by an installer at the current version. Before 1.3.0, releases also built that current-version candidate first. Both are replaced by The release path: RCs are `-rc.<n>` builds after the freeze, and the release branch reaches `main` through its pull request.

## Notes

- `npm run dist` builds the installer locally and never publishes. It writes `dist/build-info.json` (the code, commit and branch it was built from), only if none of them changed while it built (otherwise it says the build must be made again once the code stays put, and copies nothing). Run in an agent's git worktree, it also copies the installer, its blockmap, `latest.yml` and the build info to the **main checkout's** `dist`, where the user looks for them, and says so; it never replaces an installer of the same name there built from other code (`--replace` does), and `--here` keeps it in the worktree only. Worktrees copying at the same time take turns (a lock in the main `dist`), and a copy is whole or not at all. `npm run release` follows the same rules in the checkout it runs in (HI-2411): before building, it refuses (and creates no draft) when its `dist` already has an installer of the same name built from other code or from code it can't tell (no `build-info.json`); `--replace` builds over it, so move the old one aside first to keep it. One built from the same commit is replaced without a word. From that check until it ends, the release holds its `dist` (`dist/.release-build.json`, naming its process; left by one that failed, it lapses once that process is gone): a worktree's `npm run dist` doesn't copy an installer there meanwhile, even with `--replace` (it says so; run it again after the release), and a second release refuses. `npm run dist` holds the `dist` it builds in the same way while it runs (`dist/.dist-build.json`, HI-2417): it refuses, building nothing, while a release or another `npm run dist` holds that `dist`, so a local build in the main checkout can't replace the installer a release there is uploading; and while it builds, a release there refuses and a worktree's copy waits for it, as above. After the upload it writes `dist/build-info.json` for the installer it uploaded (only if the code didn't change while it built, as above), and copies nothing elsewhere: build a release in the main checkout, at the commit being released.
- Don't delete or replace the files of a published release: installed copies may be halfway through downloading them. Publish a new version instead.
- Publishing settings are in `electron-builder.yml` (`publish:`). The feed URL is also in `src/shared/defaults.ts` (`RELEASES_URL`) for the "What's new" links.
