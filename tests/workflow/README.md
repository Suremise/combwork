# Workflow scenarios and their tests

The acceptance scenarios of SPEC §16.18 (and §16.19's release candidates), each against the test that covers it. Here
`tests/workflow` is P2's core suite, run with the app's runtime settings (`reconcileActs` on, `harness.ts`). App-level
unit tests run Hive's main process on a real board (a temporary `hive.db`), and e2e suites (`tests/e2e/*.cjs`) run the
built app. Written for #1287, P4's acceptance check. A part that a later phase builds is marked with that phase rather
than left out.

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

## Later phases (named here so nothing is missed)

| Phase | Scenarios | Tests so far |
|---|---|---|
| P5 (Hive merges, the queue) | S4, S13, S27, S28, S34, S42, S47, S52, S55; and S8's queue refusal, S10's queue side, S32's requeue, S57(e) | `workflow/queue.test.ts` and `workflow/queueRecovery.test.ts` cover S4, S13, S27, S32, S34, S42 and S57(e, f) at core level; S28, S47 and S52 have none yet (P5's cards) |
| P6 | S20 | `workflow/scenarios.none.test.ts` "S20: …" (core) |
| P7 (slots) | S35, S51, S56 | none yet (P7's cards) |

## Core-level carry-over and P3's observations

| Scenario | Where |
|---|---|
| S10, S30 | Carry-over and staleness at core level: `workflow/scenarios.git.test.ts` "S10: …", "S30: …"; `workflow/gitAdapter.test.ts` (S10, S30); in the app, the stale mark (`progressgates`) |
| S37, S46 | P3's observations of a hand squash (containment by the stored key, the "no longer in main" mark): `workflow/queue.test.ts` "S37: …", "S46: …" |
| S50, S53, S59, S60, S62 | Passed in P3: `workflow/observe.test.ts` "S50 (core)", "S59", "S62"; e2e `upgradelane` (S53), `boardupgrade` (S53, S60, restore) |
