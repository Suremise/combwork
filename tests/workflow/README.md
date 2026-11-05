# Workflow scenarios and their tests

The acceptance scenarios of SPEC §16.18 (and §16.19's release candidates), each against the test that covers it. Here
`tests/workflow` is P2's core suite, run with the app's runtime settings (`reconcileActs` on, `harness.ts`). App-level
unit tests run Combwork's main process on a real board (a temporary `combwork.db`), and e2e suites (`tests/e2e/*.cjs`) run the
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
| S54 | P4's RC: Pair (the agent merges), agent worktrees, the Assistant off; squash merges bring the branch up to date | `p4lane` (on slots since #1573); `linecarried` (the branch brought up to date, on a lane carried on a 0.9 worktree, dev build only: #1579) | `lineUpdates.test.ts` (between cards: squash, merge commit, waits, For you, git's refusal, the switch) |
| S57 | Approvals aren't decisions; generations; distinct reviewers (P5: S57(e), the queue) | — | `workflow/scenarios.git.test.ts` "S57: …", "S57 (d)"; `workflow/forYou.test.ts` "S57 (a)"; `workflow/transitions.test.ts` "S57(d)", "S57(f) continued"; P5: `workflow/queue.test.ts` "S57 (e, f)" |
| S58 | A shared folder: own-commit revisions, exclusions, isolated check runs | — | `workflow/sharedFolder.test.ts` "S58: …" |
| S61 | None, Pair: declared paths, a counted check on them, a path added or edited after the run uncounts it (its hooks-free framing superseded: below) | — | `workflow/scenarios.none.test.ts` "S61: …" (the declared paths, the counted check and its uncounting, at core level) |

**Hooks-free mode is superseded, not deferred** (Darren's decision on #1285, 21 Oct: no hooks-free mode and no "Combwork's
hooks" switch; SPEC §16.15 row 10). S45's last sentence (a hooks-free session's card: an empty pre-fill, its paths
declared at submit) and S61's "hooks-free session" are out of scope for every phase. What stays valid of them is
covered as above: S45's path-based staleness and unclaimed changes, and S61's declared paths, a counted check and a
run uncounted by a later edit (the core's `declarePaths` and check runs in `scenarios.none.test.ts`; in the app, the
declare-paths route's arguments in `cardIntents.test.ts` and counted runs in `progressgates`). No test exercises a
hooks-free session, and none should.

## P5's scenarios (Combwork merges, the queue)

Written for #1358, P5's acceptance check. Each scenario's app-level proof is the e2e suite of the card that built it;
S4, S13, S14 (Combwork merges), S47 and S57(e) were proven at core level by their cards and in the app first here
(`p5scenarios`), S50's queue runner and S55 too (`queuelease`, `p5lane`).

| Scenario | What it checks | e2e (the app) | Unit (app level, or the core where the card says so) |
|---|---|---|---|
| S4 | Two approved changes, each fine alone and broken together: the second's merge checks fail, the target doesn't move, the card is returned with the output | `p5scenarios` (S4: the Merges tab and the card's Work section) | `workflow/queueChecks.test.ts` "S4's core: …"; `workflow/queue.test.ts` "S4: …" |
| S7 (the queue) | A hand merge during the queue's check is observed: Done (outside), the entry dropped, never merged twice | `mergequeue` (S7) | `workflow/queue.test.ts` "S7: …"; `reconciler.test.ts` "S7: …" |
| S8 (the queue) | A new revision after the pass: Stale, its entry cancelled, nothing for the queue, Retry merge refused | — (P4's `progressgates` for the stale mark) | `workflow/scenarios.git.test.ts` "S8: …"; `workflow/queueRecovery.test.ts` "an entry that is no longer approved is cancelled with an outcome; …" |
| S10 (the queue) | A rebase whose resolution changes the change goes stale, so the queue never merges it; one resolving to the replay carries over | — | `workflow/scenarios.git.test.ts` "S10: …" (both); `workflow/gitAdapter.test.ts` (S10); the queue's side as S8's: `workflow/queueRecovery.test.ts` (a pass gone stale is cancelled) |
| S13 | The warm queue worktree has a package installed; a change uses it undeclared: the install runs from scratch, the check fails, the target doesn't move | `p5scenarios` (S13: the project's setup command, the same worktree) | `workflow/queueChecks.test.ts` "S13's core: …"; `workflow/queue.test.ts` "S13: …" |
| S14 (Combwork merges) | Your OK before merging (G10): the approved card waits on For you (Approve), unqueued; approved → merged | `p5scenarios` (S14) | `workflow/queue.test.ts` "S14: …" |
| S27 | The target moves during the checks: tested again on the new head, never an untested advance | `mergequeue` (S27); `mergequeuefolder` (S27, checked out in the project folder) | `workflow/queue.test.ts` "S27: …" (both forms) |
| S28 | Two Combworks merge into one repository at once: one waits on the repository lock, naming the other | `repolock` | `repoLock.test.ts` "two processes take it in turn: …" and the dead-holder cases |
| S32 (the queue) | A transient check failure: the same revision requeued (at most twice); a red one needs a new revision or the user's Retry merge | `mergequeue` (the transient requeue); `queuecontrols` (Retry merge) | `workflow/queue.test.ts` "S32: …" (both) |
| S33(a) | A card removed from the queue during its check never merges, after a restart too | `queuecontrols` (S33a) | `workflow/queue.test.ts` "S33: …"; `workflow/queuePause.test.ts` "during its checks: never merged, after a restart too; …" |
| S33(c) | Combwork ends right after the target moved, before `Integrated`: the next start records it, once | `mergequeue` (S33c); `mergequeuecrash` (each journal point) | `workflow/queueHost.test.ts` "the target moved before Combwork ended (S33c): …" |
| S34 | A target checked out in a folder: (a) moved just before the swap, (b) the folder on another branch, (c) changes or staged files there, (d) a crash at each point of the journal | `mergequeuefolder` (S34a–c); `mergequeuecrash` (S34d) | `workflow/queueFolder.test.ts` "S34a: …", "… (S34b) …", "… (S34c) …"; `workflow/queueRecovery.test.ts` (the journal's recovery) |
| S42 | The merge checks run without the repository lock; an idle session in the folder doesn't hold the queue up | `mergequeuefolder` (S42) | `workflow/queueFolder.test.ts` "S42: the checks run without the lock" |
| S43 (the queue) | The next card waits while the one before merges ("waiting: … merging"); a returned card is fixed in the same clean worktree; the next starts from a target that contains it | `p5lane` (lane A: Two waits for One merging, Three returned and fixed in B1's worktree, each next card's base the new merge base) | `workflow/queueAgents.test.ts` "cw_lane next: a passed card Combwork merges is named …" |
| S47 | Combwork's merge commit: no identity → paused, said in the panel; a `commit-msg` hook rejecting it → returned with its output; a signer that waits → paused "signing waits for you" | `p5scenarios` (S47) | `workflow/queueCommits.test.ts` |
| S50 (the queue) | One runner across Combworks: the other says "Run by …"; the runner's process gone mid-check, the other takes over, ends its check, runs in a new folder, merges once | `queuelease` | `queueRunner.test.ts` "one runner per target across Combworks (#1360)" |
| S52 | The target moves during every test: after the retests the entry pauses with its reason; a hand merge during a test is observed, no empty merge commit | `mergequeue` (S7: the hand merge observed) | `workflow/queue.test.ts` "S52: …" (both) |
| S55 | P5's RC: Pair (Combwork merges), agent worktrees, the Assistant off; merged at the approved revision, the next card on the new merge base; two squashes in a row, the branch brought to the target between them; strict: updated on the queue's ref, the builder's worktree untouched, resumed cleanly after a return | `p5lane`; `mergestrict` (the strict part) | `lineUpdates.test.ts` "after a squash, the next card waits; …"; `workflow/queueStrict.test.ts` |
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

## P7's scenarios (slots, review copies, the reviewer pool)

Written for #1448, P7's acceptance check (#1123's done-when: a 6×6 setup runs a full lane on slots, Resume All and resume
after restart work): S35's window side, S42, S43, S51 and S56 on slots. `p7lane` runs them in one app, the Assistant off,
fake Claude Code builders and fake Codex reviewers acting by their own tokens:
- alpha: Combwork's Team 6×6 loaded from the Templates view (its twelve agents named from the project's key), Team chosen in
  the Version Control tab (G15 On, G17 One per lane), Combwork merging into main checked out in the project folder. Two lanes
  started from the window at once are lent slot-a and slot-b, their builders started there; each card gets its own line
  from main's head; counted checks in the slot; the reviewer, in the project folder, is leased a review copy at the
  revision and runs a check of it there; the queue merges; Done; the line deleted as the slot moves on; the Progress
  panel's rows ("AL-B1 / AL-R1 · slot-a", the copy's run "AL-1 · <revision> · in copy-1", the slots' and the copy's runs as
  Combwork's). A third lane is lent slot-a again; Combwork quits and opens again; the other lane carries on to Done.
- beta: Team 6 + pool trimmed to two builders and its two pooled reviewers, an either agent E1, G1b = 2: lanes on the pool
  ("BE-B1 / pool · slot-…"), a card reviewed by both pooled reviewers in review copies, E1 given no review while it builds
  in a slot, and reviewing from the pool in the project folder (its launch granted the copies folder) once its card is Done.
- gamma: everyone in the project folder with the pool (HR2's round 1 finding 2 on #1428), Committed is done: two builders'
  cards each reviewed from the pool in a review copy at its revision, Done, no slot lent.
- The gallery for #1123, light and dark, English and German: the Slots and copies group, lane rows with their slots and
  a pool, an agent pane "in slot-a", a refused resume, Resume All's list with a slot reused, a template load's names.

| Scenario | What it checks | e2e (the app) | Unit (app level, or the core where the card says so) |
|---|---|---|---|
| S35 | Slot reuse: a session whose slot was lent again is refused with why and left by Resume All, listed; two launches for a slot at once, one refused; a restart resumes the open lease's session | `p7lane` (the window side, after a restart: Resume All resumes AL-B2 in slot-b and AL-B3 in slot-a on their lanes' leases and lists AL-B1, whose slot holds a lane's work; the pane's refusal with Read Transcript and Start Fresh with a Handover); `slotsessions` (#1434's rest: by hand only, two launches at once, a carried slot's conversation after its card) | `agentFolders.test.ts` "Resume All resumes only conversations that may resume now, …", "the words: each refusal, …", "a lease that changed before the write: … (two Combworks at once: one writer)" |
| S42 | Team, the target checked out in the project folder: a reviewer idle there doesn't hold the queue; an uncommitted edit in a file the merge changes pauses it, the file named; a commit during the merge checks isn't held up | `p7lane` (on slots, Team from the tab: the reviewer's session in the project folder while it reviews in a copy; the user's commit and the Git view's branch and switch during the checks, merged after it; an edit to a.txt pauses the queue naming it, put back and resumed, merged); `mergequeuefolder` (P5's, on worktrees) | `workflow/queueFolder.test.ts` "S42: the checks run without the lock" |
| S43 | A lane's next card waits while the one before it merges ("waiting: AL-11 merging") and starts once it is Done, in the same slot, from a target that has it | `p7lane` (the next card's start refused `lane.oneAtATime` while the first merges, the lane's "waiting: AL-1 merging" in Pulse, then started in slot-a from main with the first in it, the first's line deleted); `p5lane` (P5's, in a worktree) | `laneOwnership.test.ts` "S43 (P4): one card at a time: …" |
| S51 | A Claude Code, a Codex and a Copilot reviewer each build and run tests in a review copy within their permission mode | `reviewcopiesreal` (the real tier: run again for #1448, its record on the card); `p7lane` (fake Codex reviewers' checks in their copies, counted for the revision) | `reviewCopies.test.ts` "goes to a reviewer and to an either agent in the project folder; …", "Claude Code: --add-dir, …", "Codex: --add-dir after resume <id>, …", "Copilot: --add-dir, …" |
| S56 | P7's RC: a lane running on an agent's worktree at the upgrade finishes there; the next lane gets a slot and per-card lines | `slotupgrade` (a 6×6-shaped 0.9.3 workspace, #1448: B1's lane finishes on hb1, carried; hb2–hb6 carried by their builders, R2's worktree a retired home; hb1, freed, renamed slot-a with its conversation; the next lane takes it with a per-card line; a solo agent's worktree keeps its work and conversation) | `slotMigration.test.ts` "builders' worktrees carried under their folders' names, kept for their lane or card", "… its reviewer's worktree is a retired home", "what a carried lease is kept for is going while its lane runs, or its card is in flight" |

S21 (the Assistant off, a lane from the window) again for P7's way in: `p7lane`'s lanes, started from the board of a
project set up from a template and the Version Control tab, run on slots to Done.

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
| G1b reviewers | `reviewers` | 1 / 1 / 1 | Agrees | `workflow/scenarios.git.test.ts` "S57: …" (a quorum of distinct reviewers); `combinations.test.ts` | `workflowoptions` (2 chosen, for its contradiction; 2 saved alone, #1483) | `p6rules` (S57's quorum: one pass leaves it in Review, the same reviewer again doesn't count, a second reviewer's approves it) |
| G2 / N2 no self-review | `noSelfReview` | false / true / true | Agrees | `workflow/scenarios.git.test.ts` "S6: …"; `agentMoves.test.ts` "S6: …"; `workflow/scenarios.none.test.ts` "S2, S6 (None)" | `workflowoptions` (held on with a reviewer agent; off pasted, refused) | `intents` (review.notAuthor, inv); None's N2: `p6rules` (the builder's own start review refused) |
| G3 / N3 checks before review | `preChecks` | [] / quick / quick + tests | Agrees | `workflow/scenarios.git.test.ts` "S26: …"; `agentMoves.test.ts` "S26: …"; `workflow/scenarios.none.test.ts` "S61: …" | `workflowoptions` (Add Check with its command, saved); `p5lane`, `p6lane` (from the scripts by Pair); `workflowoptions` (None's N3: Add Check with its command, saved) | `p4lane`, `p5lane`, `p6lane` (a counted check before submit); `progressgates` (S26, inv); None's N3: `p6rules` (submit refused until the check is counted; a run writing a deliverable as it runs doesn't count) |
| G4 carry-over | `sameness` | change / change / change | Agrees | `workflow/scenarios.git.test.ts` "S9: …" | `workflowoptions` (Same change, then Exact revision only, each saved) | `workflowoptions` (CarriedOver after a clean rebase; Stale with Exact revision only) |
| G5 who merges | `finish` | committed / hiveMerges / hiveMerges; None: accept | Agrees | `combinations.test.ts` "S36: …"; `workflow/scenarios.git.test.ts` "S17: …"; `workflow/transitions.test.ts` | `p4lane` (the agent merges), `p5lane`, `p6lane` (Combwork merges), `p6lane` (Committed is done by Solo; not checked by All off) | `p4lane` (S17); `p5lane`, `p6lane`, `mergequeue` (the queue); `p6lane` (Committed is done, S44; not checked, S11) |
| G6 style | `style` | merge / merge / merge | Agrees (Solo —) | `workflow/queueCommits.test.ts` "squash: …"; `workflow/queueStrict.test.ts`; `lineUpdates.test.ts` "after a squash, …" | `workflowoptions` (squash saved); `workflowdefaults` (the workspace's level); `p6lane` (squash mid-lane) | `p5lane` (lane B squashed, inv); `p6lane` (merge commit under old rules) |
| G7 target | `target` | '' / default branch / default branch | Agrees: Solo's row says the repository's default branch (the folder's own line, #1482) | `platformSwitch.test.ts` "Combwork merges and the agent merges need the project's own target"; `workflowOptionsForm.test.ts` "Pair is §16.6.3's …" | `workflowoptions` (typed; Pair fills the default branch); `p5lane`, `p6lane` (`main` by Pair) | `p5lane`, `p6lane` (into `main`); `mergequeue` (into `integration`, inv); `vcswitch` (OP-29's refusal) |
| G8 strict | `strict` | false / false / false | Agrees | `workflow/queueStrict.test.ts` "the target moved after the pass: …" | `mergestrict`, `p5lane` (switched on, saved) | `mergestrict`; `p5lane` (lane A's Two and Three) |
| G9 merge checks | `mergeChecks` | [] / quick / quick + tests | Agrees (Team's per-card tests: #1367) | `workflow/queueChecks.test.ts`; `workflow/queue.test.ts` "S4: …" | `workflowoptions` (Pair fills them, saved); `p5lane`, `p6lane` | `p5scenarios` (S4); `p5lane`, `p6lane` (the queue runs typecheck on the merged result) |
| G9's install | `mergeInstall` | onManifestChange / onManifestChange / always | Agrees (Built [#1361]) | `workflow/queueChecks.test.ts` "takes its two values; …", "onManifestChange: …", "always: …" | `workflowoptions` (always chosen, saved) | `p5scenarios` (S13: onManifestChange, inv); always: `p6rules` (an install before every entry's check, the warm worktree's too, no manifest changed) |
| G10 your OK | `okBefore` | never / never / labels ui, release | Agrees | `workflow/forYou.test.ts` "G10 under the agent merges (S14's P4 form)"; `workflow/queue.test.ts` "S14: …" | `workflowoptions` (labels typed, saved) | `foryou` (S14, P4's form); `p5scenarios` (S14, the queue); `boardstages`, `lanestages` (Approved waits for your OK); inv |
| G11 where | `folder` | project / slots / slots; None: project | Agrees (slots are #1438's: a card's own line in a slot lent to it or its lane) | `combinations.test.ts` "S36: …"; `workflow/sharedFolder.test.ts` "S29: …"; `gates.test.ts`; `workflow/slotStarts.test.ts` "starts in the builder's slot: the card's own line …"; `slots.test.ts` "preparing a lent slot for its card (#1438)" | `p7lane` (Team from the tab); `slotoptions` (slots again after the project folder); `p6lane` (the project folder by Solo and All off); `workflowdefaults` (slots refused at a level) | `p7lane` (two lanes in slot-a and slot-b, each card its own line; gamma in the project folder, no slot lent); `slotcards`, `lanesslots` (inv); `p6lane` (Solo and All off in the project folder) |
| G12 identity | `identity` | null / the repository's / the repository's | Agrees (On while it can be read) | `workflow/scenarios.git.test.ts` "S15: …"; `agentMoves.test.ts` "S15: …"; `workflow/queueCommits.test.ts` | `p5lane`, `p6lane` (filled by Pair from the repository); `workflowoptions` (switched alone, saved) | `p6lane` (S15: a personal email refuses submit with the amend command); `p5scenarios` (S47: none, the queue pauses) |
| G13 stop own runs | `stopOwnRuns` | false / true / true | Agrees | `gates.test.ts` "G13: …", "G13 off (its option): …" | `p4lane`, `p5lane`, `p6lane` (a preset's Use); `workflowoptions` (switched alone, saved) | `p6rules` (the builder's own open Progress run refuses its submit, naming it; ended, submitted; off, nothing refused) |
| G14 / N6 dependencies merged | `dependenciesDone` | true / true / true | Agrees | `workflow/scenarios.git.test.ts` "S12: …"; `workflow/transitions.test.ts`; `gates.test.ts` | `workflowdefaults` (Combwork's level); `workflowoptions` (a project's own row, and None's N6, each switched alone, saved) | `p6lane` (S12: blocked by an approved, unmerged card, the start refused; started once merged); `boardgates` (a blocked card asks first); None's N6: `p6rules` (blocked by a card not yet accepted, the start refused; started once accepted) |
| G15 slots up to date | `slotsUpToDate` | false / true / true | Agrees (#1445: On for Pair and Team now slots are built) | `slots.test.ts` "a lane's next card in the same slot: G15 on installs again when the lock files changed; off, nothing is installed"; `workflow/slotStarts.test.ts` "G15 on: the preparation asks for the install"; `workflowOptionsForm.test.ts` "shows G15 only with slots …", "Pair is §16.6.3's at its full values (P7, #1445) …" | `slotoptions` (Pair's and Team's previews and saves; the project folder hides it); `p7lane` (Team saved with it On) | `slotcards` (installed again before card 2, from the new lock file; inv); `slotswitches` (off: nothing installed before card 2, the lock file changed) |
| G16 shared-folder warning | `sharedFolderWarning` | true / false / false | Agrees (Pair and Team —) | `workflow/sharedFolder.test.ts` "S11: …", "G16's lock records …"; `lockRecord.test.ts` (the app's records: after release and restart, the next card, ordering) | `p6lane` (switched on with All off, saved; warns on G2's submit) | — (needs file locks on: Off records nothing, #1481) |
| G17 reviewers | `reviewerMode` | lane / lane / lane (Combwork's Team 6 + pool template suggests pool) | Agrees (#1443, #1445) | `reviewerPool.test.ts` "the option G17 (#1443)", "the pool's choice", "the pool's pass", "G1b %i × G17 × G11: every cell valid, …"; `laneStart.test.ts` "Start Lane… with the reviewer pool"; `workflowOptionsForm.test.ts` "sets G1b and G17 independently, and saves both" | `slotoptions` (One per lane through Pair and Team; A shared pool saved with the project folder; with G1b = 2); `p7lane` (One per lane through Team) | One per lane: `p7lane` (AL-B1 / AL-R1); the pool: `p7lane` beta (G1b = 2 × pool × slots: both pooled reviewers, an either agent) and gamma (pool × the project folder), `reviewerpool`, `lanesslots` (inv) |
| N4 what the work is | `excluded` | node_modules, .venv (every None preset) | Agrees: §16.3, §16.6.1 and §16.6.3 say the whole folder except `.combwork`, `node_modules` and `.venv`, no build folders found (#1482) | `runChecks.test.ts` "a write to a folder the options leave out of the deliverables still counts …" | `workflowoptions` (a folder added on None's form, saved) | `p6rules` (a change under node_modules is never unclaimed, and a check writing there as it runs still counts) |
| N5 stage names | `stageNames` | default names | Agrees | `workflow/stages.test.ts`; `projectWorkflow.test.ts` "a rename alone applies at once …" | `workflowoptions` (a rename saved, applies now; a duplicate refused) | `boardstages` (renamed columns, Git and None); `stagenames` (the Assistant's tool); `lanestages` (hovers and the legend) |
| N7 / G file locks | `fileLocks` (an option since HI-1766) | Block | `workflowPreferences.test.ts`; `samePlace.test.ts` (Combwork's default) | `workflowoptions` (Git with slots, None) | `agents` (ask, warn, inherit; setOwnOptions) |

`pairAgent` (Pair, the agent merges: §16.19.1's P4 row) has its values in `workflowOptionsForm.test.ts` "Pair (the agent
merges) is §16.19.1's …" and runs in `p4lane`.

**Gaps** (carded): none.

## P7's slot and copy options and switches

The Version Control tab's Slots and copies group (#1445) and Settings → Advanced's P7 switches, each with its unit test,
an e2e where the window sets it and one where it acts. **inv** as above (`project:updateConfig`, `advanced:set`).

| Option or switch | Key | Default | Unit test | e2e: the window sets it | e2e: it acts in the app |
|---|---|---|---|---|---|
| Setup script | `slots.setup` (falls back to `worktreeSetup`) | the setup command from before 1.0 | `slots.test.ts` "reads the setup and copy patterns from the worktree settings while the slot options are unset", "a failed setup leaves the slot not ready …"; `workflowOptionsForm.test.ts` "an empty value is the project's own none …" | `slotoptions` (typed, emptied to none, Inherit) | `slotoptions` (the next warming runs it); `p7lane`, `slotcards`, `lanesslots` (each slot's warming as Combwork's run; inv) |
| Archive script | `slots.archive` | none | `slots.test.ts` "runs the archive command first, as a run, and keeps the slot when it fails", "an archive command whose processes could not be ended keeps the slot" | `slotoptions` (saved beside another field) | `slotscripts` (failing: the slot kept, archiveFailed; passing: run first, with the folder there, then removed) |
| Files copied into new slots | `slots.copy` (falls back to `worktreeCopy`), then `slotDefaults.copy` of the workspace and of Combwork (HI-1765) | `.env*` | `slots.test.ts` "lends a new slot (a detached worktree …, its files copied …)", "Combwork's and the workspace's copied files (HI-1765)"; `slotDefaults.test.ts` | `slotoptions` (Set to none, Inherit; the workspace's none in Settings → Workspace) | `slotscripts` (`*.key`: an ignored api.key copied into each new slot, other ignored files not) |
| Slots per project | the builders, at most the project's Maximum agents (HI-2001; before, `hive.agents.perProject`) | the builders, 1 to 12 | `slots.test.ts` "is as large as the project's builders, at least one, at most the cap"; `agentLimit.test.ts` "takes 1 to 24, 12 when no level sets it" | `maxagents` (Version Control → Workflow's row) | `slotcards`, `lanesslots`, `slotrecovery` ("waiting for a slot" with one; inv); `p7lane` (two lanes, two slots, a third lane lent slot-a again) |
| Review and check copies | `copies.size` | the larger of 2 and the reviewers plus one | `copies.test.ts` "the pool's size: the larger of 2 and the reviewers plus one, or the project's own" | `slotoptions` (saved) | `isolatedcheck` (one: a check waits for a copy), `reviewcopies` (two at once; inv); `p7lane` (default) |
| Idle slots removed | `cw.slots.removeIdle` | on | `slots.test.ts` "removes ready slots beyond its size once unused for a day, oldest first, and only with the switch on" | `p7settings` | `slotpool` (on); `slotscripts` (off: a day later both kept; on again, the same tidy removes one) |
| Merged lines deleted | `cw.slots.deleteMergedLines` | on | `slotCards.test.ts` "a begun deletion settled …, whatever the switches" (off), "is kept while its slot has it checked out, deleted once nothing does" (on) | `p7settings` | `p7lane`, `slotcards` (on: LineDeleted as the slot moves on); `slotswitches` (off: card 1's merged line kept as slot-a moves on; on, deleted at the next pass) |
| Adopted worktrees renamed | `cw.slots.renameAdopted` | on | `relocateWorktree.test.ts` "free, but with the switch off, the rules off or a session running in it: kept as it is", "free and nothing in it: renamed …" | `p7settings` | `slotupgrade` (on: hb1 renamed slot-a once free); `slotswitches` (off: a free adopted hb2 keeps its name through a lane; on, renamed at the next pass) |
| Reviewers review in review copies | `cw.copies.review` | on | `copies.test.ts` "refuses when none is free (noCopy), and a review while review copies are off"; `reviewCopies.test.ts` "goes to a reviewer and to an either agent …" | shown in `slotoptions` (Open Advanced) | `reviewcopies` (on, then off: no --add-dir, no lease; inv); `p7lane` (on) |
| Wait for a copy to go quiet | `cw.copies.quietWaitMinutes` | 10 | `copies.test.ts` "a copy held back past the bound says what still uses it" | `p7settings` | `copyquiet` (1 min: a reviewer's returned copy, held back while it works, is "still in use by R1 (working)" past the minute, then leased on) |
| Idle skill copies removed | `cw.skills.removeIdleCopies` | Slots only | `skillCopies.test.ts` "in a workspace: the record is combwork.db's, and each value removes the copies where it says, …" | `p7settings` (Never, Everywhere) | `skilldelivery` (Slots only, Everywhere; inv); never: unit only |
| Inbox: checkpoints | `cw.inbox.checkpoints` (the project's `inboxCheckpoints`) | on | `carryingOn.test.ts` "the table: each switch decides only its own way, and nothing is dropped", "a project's own value wins over Settings' …"; `inboxNotices.test.ts` "with their switches off (#1432), …" | `carryingon` (the project's own, Project Settings → Sessions) | `carryingon` (on, then off; inv) |
| Inbox: carrying on at Stop | `cw.inbox.stopContinuation` (`inboxStopContinuation`) | on | the same `carryingOn.test.ts` table; `toolReplies.test.ts` "names only the ways the carrying-on switches on for the agent tell it …" | `carryingon` (the project's own) | `carryingon` (on, then off; inv) |
| Inbox: idle wakes | `cw.inbox.idleWakes` (`inboxIdleWakes`) | on | `carryingOn.test.ts` "idle wakes off: no kind of item is typed, a card event (a loop wake) included …" | `carryingon` (the project's own) | `carryingon` (off: nothing typed, a loop's wake included) |
| Wake reviewers and builders | `loopWakes` (a Card loops option since HI-1766) | on | `loopWakes.test.ts` "wakes a lane's reviewer …", "is off for a project that turned it off before HI-1766 …", "follows the workflow option (HI-1766) …" | `p7settings` (off, then on, with Save) | `loopwakes` (on, then off; setOwnOptions) |
| Rounds, wait, design check wait | `loopRounds`, `loopWaitHours`, `loopStepWaitMinutes` (Card loops options since HI-1766) | 10, 6 h, 30 min | `lanes.test.ts` (inherited, given, kept by a running lane), `workflowPreferences.test.ts` (resolving, migrations, not rules) | `workflowoptions` (defaults shown) | `cardloop` (the join takes the project's, the start's own win) |

The P7 switches' "the window sets it" is `p7settings` (Settings → Advanced's rows; Version Control → Workflow → Card loops).

## Later phases (named here so nothing is missed)

| Phase | Scenarios | Tests so far |
|---|---|---|
| P7 (slots) | S35, S42, S43, S51, S56 | P7's scenarios above (#1448) |

## Core-level carry-over and P3's observations

| Scenario | Where |
|---|---|
| S10, S30 | Carry-over and staleness at core level: `workflow/scenarios.git.test.ts` "S10: …", "S30: …"; `workflow/gitAdapter.test.ts` (S10, S30); in the app, the stale mark (`progressgates`) |
| S37, S46 | P3's observations of a hand squash (containment by the stored key, the "no longer in main" mark): `workflow/queue.test.ts` "S37: …", "S46: …" |
| S50, S53, S59, S60, S62 | Passed in P3: `workflow/observe.test.ts` "S50 (core)", "S59", "S62"; e2e `upgradelane` (S53), `boardupgrade` (S53, S60, restore) |
