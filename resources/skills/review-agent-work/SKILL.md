---
name: review-agent-work
description: Review another agent's work (a card in Review, a branch, commits or uncommitted changes) and report findings without changing it. Use when asked to review, check or verify work.
metadata:
  audience: agents
---

# Review agent work

You are the reviewer: find what's wrong, don't fix it. Leave the code, the branch and the card's assignment as they are. The user decides what gets fixed and by whom.

## 1. Find exactly what to review

- **A card** (AM-12): read it with `hive_read_task` (what was meant, what was done). Start with `hive_start_review`: its reply names what to review (a revision with its base and files, or a no-code card's summary; `submission` names an earlier one), and the review copy holding that revision when the project has them. Review there, never in the builder's slot or folder. Your session and its shell stay in your own folder, so run every command with the review copy as its working directory: change into it first (`cd`, `Set-Location`) or give the command its working directory; one that doesn't runs your folder's code, not the submission, and leaves its output there. The card stays with its builder; you are recorded as its reviewer. Where the project's rules forbid it, Hive refuses a review of work you built, saying so. A reviewer from the project's pool is told of each card it is given in its inbox: that is its start. What start review names is what you review, and what your verdict is recorded against: if the builder's summary names another commit, ask the builder (`hive_request_builder`) rather than review that one. For a code card in Git, work that revision doesn't hold (sent uncommitted) gets a request for a commit (`hive_request_builder`), not a verdict (card-loop, Reviewer).
- **A card with no workflow** (an intent says so) is reviewed on the board instead: `hive_update_task` with `review: "start"`, and the verdict as `review: "passed"` (with `column: "passed"`) or `"failed"`.
- **A branch**: `git diff <base>...<branch>` and `git log <base>..<branch>`.
- **Commits**: `git show` for the range named.
- **Uncommitted changes**: `git status`, `git diff` and `git diff --staged` in that folder.

`hive_project_status` shows each agent's folder and branch when you're told an agent's name rather than a branch. Note the exact revision or state you reviewed, so the verdict refers to it. Ask the user if what to review is unclear.

## 2. Know the intent

Check the change against what was asked: the card, the user's request, a handover (`hive_read_latest_handover`) or a plan in the shared notes. A clean change can still do the wrong thing. A convention your brief or the card names (screenshots the user OKs before a visible change merges, say) is part of the intent: check the work has it. Where the project's options ask for the user's OK, Hive asks them itself. A card's **decisions** (listed first by `hive_read_task`) are what the user decided, and win over its description: check the work against every one, and work that doesn't follow one is a blocking finding.

## 3. Review

Read the whole change, and the code around it where needed. In order of importance:

1. **Bugs**: wrong logic, missed edge cases (empty, missing, very large, concurrent), broken error handling, leaks.
2. **Missed requirements**: asked for but not done, or done differently.
3. **Risk**: security (injection, secrets, unsafe paths, access checks), data loss, breaking formats or APIs, performance traps.
4. **Tests**: new behaviour without tests, or tests that don't test it. A new or changed test that sleeps and then checks, reads state once just after an action, depends on another test's leftovers, or raises a timeout with no stated reason is a blocking finding: it fails on a loaded or slower machine. The project's test notes may say more.
5. **Clarity**: only where it will cause real trouble later.

Run the checks that matter (tests, typecheck, a repro of a suspected bug), in the review copy when you have one (§1), without committing or changing files. Note what you ran.

**Screenshots cost far more to read than text.** When a check writes a text report of what its screenshots show, or its log says what each one is, read that first. Then open only the images it flags and those of the screens the change touches, never a whole set: the rest are for people to browse.

**Don't repeat the builder's run.** Check its run record instead (the summary's, and the runs Hive recorded as the card's checks of that revision): for the code you review, recent, the checks the change needs, every failure explained. Then run only the quick checks (typecheck, lint), the tests the change affects (the project's notes may say how to pick them), and your own probes of the riskiest parts. Run a whole suite again only when there's no record, it is for other code, something in it looks wrong (a flaky check, a pass that doesn't fit the change), or the change is to shared test infrastructure, and say which in your verdict. **Proof you can't open** (a cited log or run folder that isn't there) isn't a failed round on that alone: ask the builder for it (`hive_request_builder`), and judge it once it's there.

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
- **Passed**: Hive moves it on by the project's rules (another reviewer's pass where it asks for two, the user's OK, its merge, or Done): the reply says where. Where the rules hold, a verdict on a submission that isn't the latest, or with a decision on the card you haven't read, is refused, saying what to do. Done is never yours to move.
- **Failed**: it goes back to Doing for its builder, a round counted. `failKind: "content"` when the work itself falls short, `"explanation"` when only how it was explained does. Leave its fixes to whoever the user asks to make them.
- **A question only the user can answer** (scope, a choice the card doesn't settle) comes before a verdict: ask it with `hive_ask_user` (`kind: "decide"`); it shows under For you with the card, which stays in Review, and the answer comes to your inbox. A comment alone reaches no one. Finish the review once it comes.

If the card leaves Review while you review it (taken back to Doing for more work), your review is over. Leave the card where it is and give no verdict: tell the user what you found, so the newer work is reviewed when it's ready. Only if your own session ended mid-review, with the card still in Review, start the review again.

## Reviewing again

When the card comes back after fixes, review what changed since your last verdict: the new revision's changes, the comments after yours, and any decision recorded since (a reply flags a new one). Re-run a check only when what it covers has changed, and confirm each earlier finding is fixed or still open.
