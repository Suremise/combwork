---
name: merge-ready
description: "Get a branch ready to review and merge in Hive: commit the task's work, run the checks, compare with the base, summarise. Use when asked to finish up or get a branch or worktree ready to merge. Merging and pushing stay separate."
metadata:
  audience: agents
---

# Merge ready

In Hive an agent often works in its own git worktree on its own branch. The user reviews the branch and merges it from Hive. Make that review quick and the merge safe.

## Steps

1. **Where you are.** `git branch --show-current` and `git worktree list`. This prepares a separate branch. On the project's main branch there is nothing to merge: say so, and do what the user asked (commit there only if they asked you to).
2. **Finish loose work.** `git status`. Commit the work that belongs to this task, with clear messages, and only that. Leave out build output, logs, local config and secrets. List anything you left uncommitted, and why. End what you started that still runs (log watchers, servers, app copies): left running, they hold the worktree's files and ports.
3. **Run the checks.** Use the project's own commands (package scripts, a Makefile, the README, CI config): tests, typecheck, lint, and whatever else the change needs. Fix failures this branch caused. Report failures that were there before, without fixing unrelated code.
4. **Compare with the base** (usually `main` or `master`):
   - `git log --oneline <base>..HEAD` and `git diff --stat <base>...HEAD`. Look for files changed by accident, debug code, commented-out code and leftover TODOs.
   - If the base has moved on, check whether it merges cleanly, for example with `git merge-tree --write-tree <base> HEAD`, and say whether there are conflicts.
   - Files that `.gitattributes` merges with `merge=union` (often a changelog) never conflict: git keeps both sides' lines. After merging the base, glance over them for an entry that appears twice in two wordings.
5. **Summarise for the reviewer**:
   - **What**: the change in a few sentences.
   - **Why**: the problem it solves (and the card, if there is one).
   - **How to check**: what to try or look at.
   - **Checks**: what you ran, and the results.
   - **Watch out for**: risky areas, follow-ups, anything unfinished.

## Finishing

Give the user the summary and say plainly whether the branch is ready, and if not, what's in the way. Who merges: in a card loop, the builder, at the lane's end, as its brief says (Merging, below). Otherwise the user, from Hive, where they review it first (its Merge dialog's squash or merge commit is their choice), or you when they ask. Rebase, push, delete the branch or publish only when the user asks you to; for their OK on one (a push, a release), ask on the card with `hive_ask_user` (`kind: "approve"`): their answer is recorded and comes to your inbox. If the user isn't watching this agent, a short `hive_notify` that the branch is ready helps them notice.

## Merging, when the user or your brief asks you to

Other agents merge into the same base. What you merge must be what you checked, so merges into a base take turns through Hive's **merge slot**:
1. **Claim the slot** for the base with `hive_merge_slot` (`claim`, with the cards you are merging). If it replies that you are still in line, claim again: you keep your place. Without Hive's tools, go on without it; step 4 still protects the merge.
2. **Merge the base into your branch, note its commit** (`git rev-parse <base>`) **and run the checks** the combined change needs. While you hold the slot nobody merges into the base through Hive, so one run is enough. The hold lasts 60 minutes: claim again to extend it, or run long checks through `hive-progress`. Waiting while you hold it (for the user, a push, a card), wait with a watch, not a timer (work-on-card), its `limitMinutes` under the hold (such as 40), and claim again when it wakes you.
3. **If something fails**, release the slot (`release`) before fixing it, and claim it again when you are ready.
4. **Just before merging, compare** the base's commit with the one you noted. If it moved anyway (a merge from outside Hive), merge the base in again, rerun the checks (all of them when the new commits touch shared code or test tooling) and compare again.
5. **Merge** in the checkout where the base is (`git -C <that checkout> merge --no-ff <branch>`). If git says `index.lock` exists, another merge is under way there: wait and try again; never delete the lock.
6. **Release the slot** once merged, and **report** the merge commit and the base commit your checks ran on.

Then report each of the branch's passed cards merged with `hive_report_merge` (the merge commit): Hive checks its work is in the base and moves it to Done, which means merged. Cards still in Review or Doing stay where they are. A merge step you can't take within a rule (your CLI refused the commit, say) is `hive_cannot_within_rules` on the card (the rule, and why): it goes to the user.
