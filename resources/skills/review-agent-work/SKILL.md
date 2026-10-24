---
name: review-agent-work
description: Review another agent's work (a card in Review, a branch, commits or uncommitted changes) and report findings without changing it. Use when asked to review, check or verify work.
metadata:
  audience: agents
---

# Review agent work

You are the reviewer: find what's wrong, don't fix it. Leave the code, the branch and the card's assignment as they are. The user decides what gets fixed and by whom.

## 1. Find exactly what to review

- **A card** (#n): read it with `hive_read_task`. Its description says what was meant, and its comments say what was done and where. Start the review with `hive_start_review`: its reply names the revision, base and files to review (the latest submission; `submission` names an earlier one), and the review copy to read and run checks in when the project has them: review there, never in the builder's slot or folder. The card stays in Review with the agent that did the work. You are recorded as its reviewer, separately. In a card loop, review the commit its builder names: work sent uncommitted gets a request for a commit (`hive_request_builder`), not a verdict (card-loop, Reviewer). A card an intent says has no workflow is reviewed on the board instead: `hive_update_task` with `review: "start"`, and the verdict as `review: "passed"` (with `column: "passed"`) or `"failed"`.
- **A branch**: `git diff <base>...<branch>` and `git log <base>..<branch>`.
- **Commits**: `git show` for the range named.
- **Uncommitted changes**: `git status`, `git diff` and `git diff --staged` in that folder.

`hive_project_status` shows each agent's folder and branch when you're told an agent's name rather than a branch. Note the exact commit or state you reviewed, so the verdict refers to it. Ask the user if what to review is unclear.

## 2. Know the intent

Check the change against what was asked: the card, the user's request, a handover (`hive_read_latest_handover`) or a plan in the shared notes. A clean change can still do the wrong thing. A convention your brief or the card names (screenshots the user OKs before a visible change merges, say) is part of the intent: check the work has it. A card's **decisions** (listed first by `hive_read_task`) are what the user decided, and win over its description: check the work against every one, and work that doesn't follow one is a blocking finding.

## 3. Review

Read the whole change, and the code around it where needed. In order of importance:

1. **Bugs**: wrong logic, missed edge cases (empty, missing, very large, concurrent), broken error handling, leaks.
2. **Missed requirements**: asked for but not done, or done differently.
3. **Risk**: security (injection, secrets, unsafe paths, access checks), data loss, breaking formats or APIs, performance traps.
4. **Tests**: new behaviour without tests, or tests that don't test it. A new or changed test that sleeps and then checks, reads state once just after an action, depends on another test's leftovers, or raises a timeout with no stated reason is a blocking finding: it fails on a loaded or slower machine. The project's test notes may say more.
5. **Clarity**: only where it will cause real trouble later.

Run the checks that matter (tests, typecheck, a repro of a suspected bug) without committing or changing files; scratch files (probe scripts, screenshots, test profiles) go in your own scratchpad or temp folder, never in the project or a shared test folder. Note what you ran.

**Screenshots cost far more to read than text.** When a check writes a text report of what its screenshots show, or its log says what each one is (the project's test notes say which), read that first. Then open only the images it flags and those of the screens the change touches, never a whole set: the rest are for people to browse.

**Don't repeat the builder's run.** When the builder posted a run record (which checks ran on exactly which code, with results and logs), check the record instead of repeating it: it is for the code you are reviewing (its fingerprint or commit), recent, the checks the change needs ran, and every failure in it is explained. Then run only the quick checks (typecheck, lint), the tests the change affects (not the whole suite: the project's notes may give a command that picks them), and your own probes of the riskiest parts: they find what a repeated run doesn't. Run a whole suite or set again only when there's no record, it is for other or older code, something in it looks wrong (a flaky check, a pass that doesn't fit the change), or the change is to shared test infrastructure (the test runner, helpers or config), and say in your verdict which and why. The project's notes may say how to check a record. **Proof you can't open** (a cited log or run folder that isn't there, repeated runs cited with no path) isn't a failed round on that alone: ask on the card for the path, as for a missing commit in a card loop (card-loop), and judge the proof once it's there; the project's notes may say where proof is kept.

## 4. Report

Findings, most serious first. For each:

- **file:line**;
- what's wrong;
- a concrete case where it goes wrong (input or steps, and the result);
- the impact;
- a suggested fix in a sentence.

Say how sure you are when you aren't certain. Then give the verdict, with what you checked and what you didn't, so the user knows how far to trust it.

## 5. Verdict on the board

For a card, end your review with `hive_verdict` on the submission you reviewed:

- `pass: true` or `false`, with the report as `comment`. Its **first line is the verdict in one line**: "Round 1: PASSED" (with the gist), or "Round 1: FAILED: 2 findings: <their titles>". The findings and the evidence follow below it.
- **Passed**: Hive moves it on (to Passed, or to its merge): reviewed, waiting to be merged. Done means merged, never yours to move.
- **Failed**: it goes back to Doing for its builder, a round counted. `failKind: "content"` when the work itself falls short, `"explanation"` when only how it was explained does. Leave its fixes to whoever the user asks to make them.
- **A question only the user can answer** (scope, a choice the card doesn't settle) comes before a verdict: ask it with `hive_ask_user` (`kind: "decide"`); it shows under For you with the card, which stays in Review, and the answer comes to your inbox. A comment alone reaches no one. Finish the review once it comes.

If the card leaves Review while you review it (taken back to Doing for more work), your review is over. Leave the card where it is: don't move it back to Review or on to Passed, start another review or give a verdict: tell the user what you found, so the newer work is reviewed when it's ready. Only if your own session ended mid-review, with the card still in Review, start the review again.

## Reviewing again

When the card comes back after fixes, review what changed since your last verdict: the new commits, the comments after yours, and any decision recorded since (a reply flags a new one). Re-run a check only when what it covers has changed, and confirm each earlier finding is fixed or still open.
