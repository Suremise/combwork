# Workflow scenarios and their tests

The acceptance scenarios of SPEC §16.18 (and §16.19's release candidates), each against the test that covers it. Here
`tests/workflow` is P2's core suite, run with the app's runtime settings (`reconcileActs` on, `harness.ts`). App-level
unit tests run Hive's main process on a real board (a temporary `hive.db`), and e2e suites (`tests/e2e/*.cjs`) run the
built app. Written for #1287, P4's acceptance check, and extended for #1358, P5's, and #1425, P6's (with every option
against its tests: [Options and their tests](#options-and-their-tests)). A part that a later phase builds is marked
with that phase rather than left out.

## P4's scenarios

| Scenario | What it checks | e2e (the app) | Unit (app level, or the core where the card says so) |
|---|---|---|---|
| S1 | Uncommitted changes refuse submit (`submit.clean`); the card stays Active | — | `agentMoves.test.ts` "S1: …"; `workflow/scenarios.git.test.ts` "S1: …" |
| S2 | A comment or message never moves an Approved card | — | `cardIntents.test.ts` (a whole round trip: a comment after the pass); `workflow/scenarios.git.test.ts` "S2: …", "S2 (round): …"; `workflow/scenarios.none.test.ts` "S2, S6 (None)" |
| S3 | A card added to a running lane waits for the card in flight | — | `laneOwnership.test.ts` "S3: …"; `workflow/lanes.test.ts` "S3: …" |
| S5 | A decision in Review wakes builder and reviewer; the verdict waits for it | — | `actionHandlers.test.ts` "decisions wake the loop (#1266, S5; #587)"; `workflow/scenarios.git.test.ts` "S5 (Git)"; `workflow/scenarios.none.test.ts` "S5 (None)" |
| S6 | The builder can't review its own card (`review.notAuthor`) | — | `agentMoves.test.ts` "S6: …"; `cardIntents.test.ts` (round trip); `workflow/scenarios.git.test.ts` "S6: …" |
| S7 | An approved card merged by hand is Integrated (outside), then Done | `reconcile` (a hand merge observed) | `reconciler.test.ts` "S7: …"; `workflow/queue.test.ts` "S7: …" |
| S8 | A new revision after the pass is Stale (the agent merges; P5: the queue refuses it) | `progressgates` (a new revision after the pass marks the lane stale) | `reconciler.test.ts` "a rebase after the pass carries it over; an amend with new content makes it stale…"; `workflow/scenarios.git.test.ts` "S8: …" |
| S9 | A clean rebase carries the pass over; Exact revision only goes Stale | — | `reconciler.test.ts` (the same test: CarriedOver observed in the app); `workflow/scenarios.git.test.ts` "S9: …" |
| S11 | All off: three agents on one branch with trailers; G16 warns, nothing refused | — | `workflow/sharedFolder.test.ts` "S11: …" |
| S12 | A card blocked by an Approved, unmerged card can't start | — | `workflow/scenarios.git.test.ts` "S12: …" |
| S14 | Your OK before merging (G10), P4's form (the agent merges) | `foryou` (S14's P4 form) | `workflow/forYou.test.ts` "G10 under the agent merges (S14's P4 form)"; P5's queue form: `workflow/queue.test.ts` "S14: …" |
| S15 | A personal-email commit refuses submit (`submit.identity`) with the amend command | — | `agentMoves.test.ts` "S15: …"; `workflow/scenarios.git.test.ts` "S15: …" |
| S16 | An agent's Done is report merge (refused before it passed); the user's drag asks, then records an Override | `boardgates` (the user's part) | `agentMoves.test.ts` "S16, S17: …"; `gates.test.ts` "S16, the user part"; `workflow/scenarios.git.test.ts` "S16: …" |
| S17 | A reported merge not in the target is refused (`done.contained`) | `p4lane` (a report before the merge) | `agentMoves.test.ts` "S16, S17: …"; `workflow/scenarios.git.test.ts` "S17: …" |
| S18 | None, a reviewer then you: approve → Done; a path edited after → Stale | — | `workflow/scenarios.none.test.ts` "S18: …" |
| S19 | Options changed mid-lane: the lane keeps its rules, the next lane takes the new | — | `laneOwnership.test.ts` "S19: …"; `gates.test.ts` "S19: …"; `workflowOptionsForm.test.ts` "the next card starts under the saved options (#1278, S19)"; `workflow/lanes.test.ts` "S19: …" |
| S21 | The Assistant off: a lane from the board runs to its passes, merge and verified end | `lanestart` (the window's part); `p4lane` (a lane from the board, through to Done) | `laneOwnership.test.ts` (the verified end) |
| S22 | The CLI refuses a commit: couldn't within the rules → For you, no failed round | — | `cardIntents.test.ts` "… (S22)"; `workflow/forYou.test.ts` "S22: …" |
| S23 | A reviewer's mid-review request wakes the builder at once | — | `actionHandlers.test.ts` "S23: …", "S23's watch side" |
| S24 | The Assistant relabels 70 cards; the group undo skips a card the user edited | `assistantundo` | `assistantUndo.test.ts` "S24: …" |
| S25 | A no-code card: a summary, a pass, Done, no queue | `nocode` | `cardIntents.test.ts` "… (S25, S38)"; `workflow/scenarios.git.test.ts` "S25: …" |
| S26 | A failing pre-review check refuses submit (`submit.checksPassed`) | `progressgates` (the failed run says it blocks review); `p4lane` (a counted check before submit) | `agentMoves.test.ts` "S26: …"; `workflow/scenarios.git.test.ts` "S26: …" |
| S29 | Pair in the project folder: trailered commits; a commit with none refuses submit (`submit.trailer`) | — | `agentMoves.test.ts` "S29: …"; `workflow/sharedFolder.test.ts` "S29: …" |
| S31 | Check runs: edits and HEAD moves uncount a run; a wrong `--revision` is refused | — | `workflow/sharedFolder.test.ts` "S31: …" |
| S32 | The explanation part: the same revision again, with a note (P5: the transient requeue) | — | `cardIntents.test.ts` (round trip: `submit.sameRevisionNote`, then a new round with a note); P5: `workflow/queue.test.ts` "S32: …" |
| S33(b) | A wake delivered once across restarts | — | `actionHandlers.test.ts` "delivered once (#1266, S33(b))" |
| S36 | Every option combination walked Todo → Done; contradictions refused | — | `workflow/combinations.test.ts` "S36: every combination" |
| S38 | A no-code card with no review → Done, no `Integrated` (Git and None) | `nocode` | `cardIntents.test.ts` "… (S25, S38)"; `workflow/scenarios.git.test.ts` "S38: …"; `workflow/scenarios.none.test.ts` "S38 (None)" |
| S39 | All off: a blocked card starts with a warning; the user drags freely | `boardgates` (S39) | `gates.test.ts` "S39: …"; `workflow/scenarios.git.test.ts` "S39: …" |
| S40 | A running lane at the upgrade: adopted, its old moves translated | `upgradelane` | `agentMoves.test.ts` "S40: an upgraded lane's old moves"; `workflow/lanes.test.ts` "S40: …" |
| S41 | Just started isn't Done; part merged is a mark; a Review card merged by hand is Done outside the rules | — | `reconciler.test.ts` "S41: …"; `workflow/scenarios.git.test.ts` "S41: …" |
| S43 | P4's form: one card at a time, the next waits for Done (P5: the queue) | `p4lane` (the next card refused until Done); `progressgates` | `laneOwnership.test.ts` "S43 (P4): …" |
| S44 | Solo, the project folder, no trailers: start → commit → submit → Done | — | `workflow/scenarios.git.test.ts` "S44: …" |
| S45 | None, two agents in one folder: staleness by paths, unclaimed changes (its hooks-free part superseded: below) | — | `workflow/scenarios.none.test.ts` "S45: …" |
| S48 | An agent's plain number is refused, naming the key and `#N` | `intents` (S48) | `cardIntents.test.ts` "… (S48)"; `workflow/scenarios.git.test.ts` "S48: …" |
| S49 | The round limit asks the user (Decide), the lane pauses | — | `forYouBoard.test.ts` (the round limit on the board); `workflow/forYou.test.ts` "S49, the round limit: …" |
| S54 | P4's RC: Pair (the agent merges), agent worktrees, the Assistant off; squash merges bring the branch up to date | `p4lane` | `lineUpdates.test.ts` (between cards: squash, merge commit, waits, For you, git's refusal, the switch) |
| S57 | Approvals aren't decisions; generations; distinct reviewers (P5: S57(e), the queue) | — | `workflow/scenarios.git.test.ts` "S57: …", "S57 (d)"; `workflow/forYou.test.ts` "S57 (a)"; `workflow/transitions.test.ts` "S57(d)", "S57(f) continued"; P5: `workflow/queue.test.ts` "S57 (e, f)" |
| S58 | A shared folder: own-commit revisions, exclusions, isolated check runs | — | `workflow/sharedFolder.test.ts` "S58: …" |
| S61 | None, Pair: declared paths, a counted check on them, a path added or edited after the run uncounts it (its hooks-free framing superseded: below) | — | `workflow/scenarios.none.test.ts` "S61: …" (the declared paths, the counted check and its uncounting, at core level) |

**Hooks-free mode is superseded, not deferred** (Darren's decision on #1285, 21 Oct: no hooks-free mode and no "Hive's
hooks" switch; SPEC §16.15 row 10). S45's last sentence (a hooks-free session's card: an empty pre-fill, its paths
declared at submit) and S61's "hooks-free session" are out of scope for every phase. What stays valid of them is
covered as above: S45's path-based staleness and unclaimed changes, and S61's declared paths, a counted check and a
run uncounted by a later edit (the core's `declarePaths` and check runs in `scenarios.none.test.ts`; in the app, the
declare-paths route's arguments in `cardIntents.test.ts` and counted runs in `progressgates`). No test exercises a
hooks-free session, and none should.

## P5's scenarios (Hive merges, the queue)

Written for #1358, P5's acceptance check. Each scenario's app-level proof is the e2e suite of the card that built it;
S4, S13, S14 (Hive merges), S47 and S57(e) were proven at core level by their cards and in the app first here
(`p5scenarios`), S50's queue runner and S55 too (`queuelease`, `p5lane`).

| Scenario | What it checks | e2e (the app) | Unit (app level, or the core where the card says so) |
|---|---|---|---|
| S4 | Two approved changes, each fine alone and broken together: the second's merge checks fail, the target doesn't move, the card is returned with the output | `p5scenarios` (S4: the Merges tab and the card's Work section) | `workflow/queueChecks.test.ts` "S4's core: …"; `workflow/queue.test.ts` "S4: …" |
| S7 (the queue) | A hand merge during the queue's check is observed: Done (outside), the entry dropped, never merged twice | `mergequeue` (S7) | `workflow/queue.test.ts` "S7: …"; `reconciler.test.ts` "S7: …" |
| S8 (the queue) | A new revision after the pass: Stale, its entry cancelled, nothing for the queue, Retry merge refused | — (P4's `progressgates` for the stale mark) | `workflow/scenarios.git.test.ts` "S8: …"; `workflow/queueRecovery.test.ts` "an entry that is no longer approved is cancelled with an outcome; …" |
| S10 (the queue) | A rebase whose resolution changes the change goes stale, so the queue never merges it; one resolving to the replay carries over | — | `workflow/scenarios.git.test.ts` "S10: …" (both); `workflow/gitAdapter.test.ts` (S10); the queue's side as S8's: `workflow/queueRecovery.test.ts` (a pass gone stale is cancelled) |
| S13 | The warm queue worktree has a package installed; a change uses it undeclared: the install runs from scratch, the check fails, the target doesn't move | `p5scenarios` (S13: the project's setup command, the same worktree) | `workflow/queueChecks.test.ts` "S13's core: …"; `workflow/queue.test.ts` "S13: …" |
| S14 (Hive merges) | Your OK before merging (G10): the approved card waits on For you (Approve), unqueued; approved → merged | `p5scenarios` (S14) | `workflow/queue.test.ts` "S14: …" |
| S27 | The target moves during the checks: tested again on the new head, never an untested advance | `mergequeue` (S27); `mergequeuefolder` (S27, checked out in the project folder) | `workflow/queue.test.ts` "S27: …" (both forms) |
| S28 | Two Hives merge into one repository at once: one waits on the repository lock, naming the other | `repolock` | `repoLock.test.ts` "two processes take it in turn: …" and the dead-holder cases |
| S32 (the queue) | A transient check failure: the same revision requeued (at most twice); a red one needs a new revision or the user's Retry merge | `mergequeue` (the transient requeue); `queuecontrols` (Retry merge) | `workflow/queue.test.ts` "S32: …" (both) |
| S33(a) | A card removed from the queue during its check never merges, after a restart too | `queuecontrols` (S33a) | `workflow/queue.test.ts` "S33: …"; `workflow/queuePause.test.ts` "during its checks: never merged, after a restart too; …" |
| S33(c) | Hive ends right after the target moved, before `Integrated`: the next start records it, once | `mergequeue` (S33c); `mergequeuecrash` (each journal point) | `workflow/queueHost.test.ts` "the target moved before Hive ended (S33c): …" |
| S34 | A target checked out in a folder: (a) moved just before the swap, (b) the folder on another branch, (c) changes or staged files there, (d) a crash at each point of the journal | `mergequeuefolder` (S34a–c); `mergequeuecrash` (S34d) | `workflow/queueFolder.test.ts` "S34a: …", "… (S34b) …", "… (S34c) …"; `workflow/queueRecovery.test.ts` (the journal's recovery) |
| S42 | The merge checks run without the repository lock; an idle session in the folder doesn't hold the queue up | `mergequeuefolder` (S42) | `workflow/queueFolder.test.ts` "S42: the checks run without the lock" |
| S43 (the queue) | The next card waits while the one before merges ("waiting: … merging"); a returned card is fixed in the same clean worktree; the next starts from a target that contains it | `p5lane` (lane A: Two waits for One merging, Three returned and fixed in B1's worktree, each next card's base the new merge base) | `workflow/queueAgents.test.ts` "hive_lane next: a passed card Hive merges is named …" |
| S47 | Hive's merge commit: no identity → paused, said in the panel; a `commit-msg` hook rejecting it → returned with its output; a signer that waits → paused "signing waits for you" | `p5scenarios` (S47) | `workflow/queueCommits.test.ts` |
| S50 (the queue) | One runner across Hives: the other says "Run by …"; the runner's process gone mid-check, the other takes over, ends its check, runs in a new folder, merges once | `queuelease` | `queueRunner.test.ts` "one runner per target across Hives (#1360)" |
| S52 | The target moves during every test: after the retests the entry pauses with its reason; a hand merge during a test is observed, no empty merge commit | `mergequeue` (S7: the hand merge observed) | `workflow/queue.test.ts` "S52: …" (both) |
| S55 | P5's RC: Pair (Hive merges), agent worktrees, the Assistant off; merged at the approved revision, the next card on the new merge base; two squashes in a row, the branch brought to the target between them; strict: updated on the queue's ref, the builder's worktree untouched, resumed cleanly after a return | `p5lane`; `mergestrict` (the strict part) | `lineUpdates.test.ts` "after a squash, the next card waits; …"; `workflow/queueStrict.test.ts` |
| S57(e) | A decision after the checks and before the advance: no advance; after `IntegrationStarted`: merged, then For you | `p5scenarios` (S57(e): a decision recorded in the card while its checks run) | `workflow/queue.test.ts` "S57 (e, f): …" |

S21's queue part (a lane started and answered from the window, the Assistant off, through to its verified end) is
`p5lane` (both lanes end verified, their merge commits the queue's results).

## P6's scenarios (stages, detection, the Version Control tab)

Written for #1425, P6's acceptance check: S19 and S20, and the scenarios whose way in P6 changed (set up through the
Version Control tab's step or Workflow section, shown on the board by stage). `p6lane` runs them in one app, the
Assistant off: a Git project added with a builder and a reviewer, Pair from the step, a lane started from the window
through the queue to Done (Branches & remotes and the Progress panel's hovers on the way); a Solo project; an all-off
project with two agents in its folder; then S19 and S20.

| Scenario | What it checks | e2e (the app) | Unit (app level, or the core where the card says so) |
|---|---|---|---|
| S11 | All off: agents in the project folder commit with trailers; cards move freely; G16 warns; nothing refused | `p6lane` (all off saved in the tab with G16 on; two agents' trailered commits, each card's own; both Done; the user moves a card freely; G16: G1's edit hook locks a file, recorded on its card, and G2's submit including it warns, naming that card) | `workflow/sharedFolder.test.ts` "S11: …" |
| S19 | Options changed mid-lane: the lane keeps its rules ("old rules"), the next lane takes the new | `p6lane` (squash saved in the tab while Two is Active: the save names the lane keeping old rules, the mark in Pulse, Two merged with a merge commit); `lanestages` (marks, Apply to cards in flight, a rename sets nothing); `workflowoptions` (the save's warning) | `laneOwnership.test.ts` "S19: …"; `gates.test.ts` "S19: …"; `workflow/lanes.test.ts` "S19: …" |
| S20 | `.git` removed: Git's rules hold (unknown), None offered; `git init` offers Git back | `p6lane` (the offer, Switch to None, a new card under None's rules); `vcswitch` (the refusal's next step, the warning, `git init` → Git with its options back) | `workflow/scenarios.none.test.ts` "S20: …" (core); `platformSwitch.test.ts` "S20: the repository gone (#1419)" |
| S36 | Every combination walked Todo → Done; contradictions refused when saved | `workflowoptions` (each contradiction under its rows as chosen, a pasted one refused) | `workflow/combinations.test.ts` "S36: every combination" |
| S39 | All off: a blocked card starts with a warning; submit → Done with no guard; the user moves anything with no question | `p6lane` (all off saved in the tab: started with the warning, Done on submit, Done → Todo → Done by the user); `boardgates` (S39: no question, no drop where the rules have no column) | `gates.test.ts` "S39: …"; `workflow/scenarios.git.test.ts` "S39: …" |
| S44 | Solo, one agent in the project folder, no trailers: start → commit → submit → Done (Committed is done) | `p6lane` (Solo from the step; its lane in Pulse while it runs, left out once ended) | `workflow/scenarios.git.test.ts` "S44: …" |

S21 (the Assistant off, a lane from the window) again for P6's way in: `p6lane`'s first lane, started from the board of
a project set up through the step, ends verified.

## Options and their tests

Every option the Version Control tab offers (SPEC §16.6.1, §16.6.2), for #1122's done-when: each with its unit test, an
e2e where the window sets it, an e2e where the rule it switches acts in the app, and the values the presets give it
(`preset()` in `src/shared/workflow/options.ts`) against §16.6.3. **Window**: set in Version Control → Workflow (a row,
or a preset's Use, or the step's Choose); **inv**: through `workflow:setOptions` (queueFixture's options), which shows
the rule acting but not the window setting it. N1–N3 share G1–G3's keys; N5 is `stageNames`, N6 `dependenciesDone`
(G14). Every row also has `workflowOptionsForm.test.ts` "has a row for every option of §16.6.1 and §16.6.2, …", and
`workflowoptions` checks each group's rows in the window. The preset values are asserted in `workflowOptionsForm.test.ts`
("Pair is §16.6.3's …", "Team is Darren's …", "Pair (the agent merges) is §16.19.1's …", "Solo (Git) and None's Solo,
Pair and Team are §16.6.3's (#1425)").

| Option | Key | Solo / Pair / Team (Git; None where it differs) | §16.6.3 | Unit test | e2e: the window sets it | e2e: the rule acts in the app |
|---|---|---|---|---|---|---|
| G1 / N1 review | `review` | none / agent / agent; None: none / agent / agentThenYou | Agrees | `workflow/combinations.test.ts` "S36: every combination"; `workflow/scenarios.none.test.ts` "S18: …" | `presetstep`, `p6lane` (Pair through the step); `p4lane`, `p5lane` (a preset's Use); `workflowoptions` (None's N1: You, saved) | `p4lane`, `p5lane`, `p6lane` (a reviewer agent); `foryou` (you, inv); `nocode` (no review, Git and None, inv) |
| G1b reviewers | `reviewers` | 1 / 1 / 1 | Agrees | `workflow/scenarios.git.test.ts` "S57: …" (a quorum of distinct reviewers); `combinations.test.ts` | `workflowoptions` (2 chosen, for its contradiction; 2 saved alone, #1483) | #1507 (S57's quorum) |
| G2 / N2 no self-review | `noSelfReview` | false / true / true | Agrees | `workflow/scenarios.git.test.ts` "S6: …"; `agentMoves.test.ts` "S6: …"; `workflow/scenarios.none.test.ts` "S2, S6 (None)" | `workflowoptions` (held on with a reviewer agent; off pasted, refused) | `intents` (review.notAuthor, inv); None's N2: #1507 |
| G3 / N3 checks before review | `preChecks` | [] / quick / quick + tests | Agrees | `workflow/scenarios.git.test.ts` "S26: …"; `agentMoves.test.ts` "S26: …"; `workflow/scenarios.none.test.ts` "S61: …" | `workflowoptions` (Add Check with its command, saved); `p5lane`, `p6lane` (from the scripts by Pair); `workflowoptions` (None's N3: Add Check with its command, saved) | `p4lane`, `p5lane`, `p6lane` (a counted check before submit); `progressgates` (S26, inv); None's N3: #1507 |
| G4 carry-over | `sameness` | change / change / change | Agrees | `workflow/scenarios.git.test.ts` "S9: …" | `workflowoptions` (Same change, then Exact revision only, each saved) | `workflowoptions` (CarriedOver after a clean rebase; Stale with Exact revision only) |
| G5 who merges | `finish` | committed / hiveMerges / hiveMerges; None: accept | Agrees | `combinations.test.ts` "S36: …"; `workflow/scenarios.git.test.ts` "S17: …"; `workflow/transitions.test.ts` | `p4lane` (the agent merges), `p5lane`, `p6lane` (Hive merges), `p6lane` (Committed is done by Solo; not checked by All off) | `p4lane` (S17); `p5lane`, `p6lane`, `mergequeue` (the queue); `p6lane` (Committed is done, S44; not checked, S11) |
| G6 style | `style` | merge / merge / merge | Agrees (Solo —) | `workflow/queueCommits.test.ts` "squash: …"; `workflow/queueStrict.test.ts`; `lineUpdates.test.ts` "after a squash, …" | `workflowoptions` (squash saved); `workflowdefaults` (the workspace's level); `p6lane` (squash mid-lane) | `p5lane` (lane B squashed, inv); `p6lane` (merge commit under old rules) |
| G7 target | `target` | '' / default branch / default branch | Agrees: Solo's row says the repository's default branch (the folder's own line, #1482) | `platformSwitch.test.ts` "Hive merges and the agent merges need the project's own target"; `workflowOptionsForm.test.ts` "Pair is §16.6.3's …" | `workflowoptions` (typed; Pair fills the default branch); `p5lane`, `p6lane` (`main` by Pair) | `p5lane`, `p6lane` (into `main`); `mergequeue` (into `integration`, inv); `vcswitch` (OP-29's refusal) |
| G8 strict | `strict` | false / false / false | Agrees | `workflow/queueStrict.test.ts` "the target moved after the pass: …" | `mergestrict`, `p5lane` (switched on, saved) | `mergestrict`; `p5lane` (lane A's Two and Three) |
| G9 merge checks | `mergeChecks` | [] / quick / quick + tests | Agrees (Team's per-card tests: #1367) | `workflow/queueChecks.test.ts`; `workflow/queue.test.ts` "S4: …" | `workflowoptions` (Pair fills them, saved); `p5lane`, `p6lane` | `p5scenarios` (S4); `p5lane`, `p6lane` (the queue runs typecheck on the merged result) |
| G9's install | `mergeInstall` | onManifestChange / onManifestChange / always | Agrees (Built [#1361]) | `workflow/queueChecks.test.ts` "takes its two values; …", "onManifestChange: …", "always: …" | `workflowoptions` (always chosen, saved) | `p5scenarios` (S13: onManifestChange, inv); always: #1507 |
| G10 your OK | `okBefore` | never / never / labels ui, release | Agrees | `workflow/forYou.test.ts` "G10 under the agent merges (S14's P4 form)"; `workflow/queue.test.ts` "S14: …" | `workflowoptions` (labels typed, saved) | `foryou` (S14, P4's form); `p5scenarios` (S14, the queue); `boardstages`, `lanestages` (Approved waits for your OK); inv |
| G11 where | `folder` | project / slots / slots; None: project | Agrees (slots = agent worktrees until P7) | `combinations.test.ts` "S36: …"; `workflow/sharedFolder.test.ts` "S29: …"; `gates.test.ts` | `p6lane` (slots by Pair; the project folder by Solo and All off); `workflowdefaults` (slots refused at a level) | `p5lane`, `p6lane` (the builder's worktree; Solo and All off in the project folder) |
| G12 identity | `identity` | null / the repository's / the repository's | Agrees (On while it can be read) | `workflow/scenarios.git.test.ts` "S15: …"; `agentMoves.test.ts` "S15: …"; `workflow/queueCommits.test.ts` | `p5lane`, `p6lane` (filled by Pair from the repository); `workflowoptions` (switched alone, saved) | `p6lane` (S15: a personal email refuses submit with the amend command); `p5scenarios` (S47: none, the queue pauses) |
| G13 stop own runs | `stopOwnRuns` | false / true / true | Agrees | `gates.test.ts` "G13: …", "G13 off (its option): …" | `p4lane`, `p5lane`, `p6lane` (a preset's Use); `workflowoptions` (switched alone, saved) | #1507 |
| G14 / N6 dependencies merged | `dependenciesDone` | true / true / true | Agrees | `workflow/scenarios.git.test.ts` "S12: …"; `workflow/transitions.test.ts`; `gates.test.ts` | `workflowdefaults` (Hive's level); `workflowoptions` (a project's own row, and None's N6, each switched alone, saved) | `p6lane` (S12: blocked by an approved, unmerged card, the start refused; started once merged); `boardgates` (a blocked card asks first); None's N6: #1507 |
| G15 slots up to date | `slotsUpToDate` | false / false / false | §16.6.3's On for Pair and Team waits for slots (Built [#1355]) | P7 | P7 (not in the form) | P7 |
| G16 shared-folder warning | `sharedFolderWarning` | true / false / false | Agrees (Pair and Team —) | `workflow/sharedFolder.test.ts` "S11: …", "G16's lock records …"; `lockRecord.test.ts` (the app's records: after release and restart, the next card, ordering) | `p6lane` (switched on with All off, saved; warns on G2's submit) | — (needs file locks on: Off records nothing, #1481) |
| G17 reviewers per lane | — | — | P7 | P7 | P7 | P7 |
| N4 what the work is | `excluded` | node_modules, .venv (every None preset) | Agrees: §16.3, §16.6.1 and §16.6.3 say the whole folder except `.hive`, `node_modules` and `.venv`, no build folders found (#1482) | `runChecks.test.ts` "a write to a folder the options leave out of the deliverables still counts …" | `workflowoptions` (a folder added on None's form, saved) | #1507 |
| N5 stage names | `stageNames` | default names | Agrees | `workflow/stages.test.ts`; `projectWorkflow.test.ts` "a rename alone applies at once …" | `workflowoptions` (a rename saved, applies now; a duplicate refused) | `boardstages` (renamed columns, Git and None); `stagenames` (the Assistant's tool); `lanestages` (hovers and the legend) |
| N7 file locks | — (Settings → Agents & Worktrees) | as set | Shown, not set | — | `workflowoptions` (shown in None's Set elsewhere) | — |

`pairAgent` (Pair, the agent merges: §16.19.1's P4 row) has its values in `workflowOptionsForm.test.ts` "Pair (the agent
merges) is §16.19.1's …" and runs in `p4lane`.

**Gaps** (carded): the acting e2e of G1b's quorum, G13, `mergeInstall: always`, None's N2,
N3, N4 and N6 (#1507).

## Later phases (named here so nothing is missed)

| Phase | Scenarios | Tests so far |
|---|---|---|
| P7 (slots) | S35, S51, S56 | none yet (P7's cards) |

## Core-level carry-over and P3's observations

| Scenario | Where |
|---|---|
| S10, S30 | Carry-over and staleness at core level: `workflow/scenarios.git.test.ts` "S10: …", "S30: …"; `workflow/gitAdapter.test.ts` (S10, S30); in the app, the stale mark (`progressgates`) |
| S37, S46 | P3's observations of a hand squash (containment by the stored key, the "no longer in main" mark): `workflow/queue.test.ts` "S37: …", "S46: …" |
| S50, S53, S59, S60, S62 | Passed in P3: `workflow/observe.test.ts` "S50 (core)", "S59", "S62"; e2e `upgradelane` (S53), `boardupgrade` (S53, S60, restore) |
