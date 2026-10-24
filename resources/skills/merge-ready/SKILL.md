---
name: merge-ready
description: "Get a branch ready to review and merge in Hive: commit the task's work, run the checks, compare with the base, summarise. Use when asked to finish up or get a branch or worktree ready to merge. Merging and pushing stay separate."
metadata:
  audience: agents
---

# Merge ready

In Hive a card's work is often on its own branch, in the slot (a working folder) Hive lends the card or its lane. Make its review quick and its merge safe.

## Steps

1. **Where you are.** `git branch --show-current` and `git worktree list`. This prepares a separate branch. On the project's main branch there is nothing to merge: say so, and do what the user asked (commit there only if they asked you to).
2. **Finish loose work.** `git status`. Commit the work that belongs to this task, with clear messages, and only that. Leave out build output, logs, local config and secrets. List anything you left uncommitted, and why.
3. **Run the checks.** Use the project's own commands (package scripts, a Makefile, the README, CI config): tests, typecheck, lint, and whatever else the change needs. Fix failures this branch caused. Report failures that were there before, without fixing unrelated code.
4. **Compare with the base** (usually `main` or `master`): `git log --oneline <base>..HEAD` and `git diff --stat <base>...HEAD`. Look for files changed by accident, debug code, commented-out code and leftover TODOs. If the base has moved on, say whether it merges cleanly (`git merge-tree --write-tree <base> HEAD`). Files `.gitattributes` merges with `merge=union` (often a changelog) never conflict: after merging the base, glance over them for an entry that appears twice in two wordings.
5. **Summarise for the reviewer**:
   - **What**: the change in a few sentences.
   - **Why**: the problem it solves (and the card, if there is one).
   - **How to check**: what to try or look at.
   - **Checks**: what you ran, and the results.
   - **Watch out for**: risky areas, follow-ups, anything unfinished.

## Who merges

Give the user the summary and say plainly whether the branch is ready, and if not, what's in the way. For a card, how its work lands is the project's (its options, in `hive_project_status`'s `workflow`; a lane's brief says it too), and a card that passed waits on it:
- **Hive merges**: its merge queue checks it on the target as it is then and merges it, or returns it to its builder with why (fix and submit again). Don't merge it yourself: the card's `merge` (`hive_read_task`) says where it is.
- **The agent merges**: you merge it (below), then `hive_report_merge` with the merge commit; Hive checks the work is in the base before the card is Done, and refuses saying what's missing.
- **Merges aren't checked**: merge as your brief says, then `hive_report_merge`; nothing is checked.
- **Committed is done**, or a project without version control: there is nothing to merge; the card finishes on its own.

Outside a card, or with no workflow: the user merges from Hive, or you when they ask. Rebase, push, delete the branch or publish only when the user asks you to; for their OK on one (a push, a release), ask on the card with `hive_ask_user` (`kind: "approve"`): their answer comes to your inbox. If the user isn't watching this agent, a short `hive_notify` that the branch is ready helps them notice.

## Merging, when it is yours

Other agents merge into the same base. What you merge must be what you checked, so merges into a base take turns through Hive's **merge slot**:
1. **Claim the slot** for the base with `hive_merge_slot` (`claim`, with the cards you are merging). Still in line: claim again, keeping your place. Without Hive's tools, go on without it; step 4 still protects the merge.
2. **Merge the base into the branch, note its commit** (`git rev-parse <base>`) **and run the checks** the combined change needs. Merge it into the branch, not the branch into the base with `--no-commit`: a failure is then fixed on the branch, and the base's checkout is never left mid-merge where others work. While you hold the slot nobody merges into the base through Hive, so one run is enough. The hold lasts 60 minutes: claim again to extend it (waiting meanwhile, use a watch with `limitMinutes` under the hold: work-on-card).
3. **If something fails**, release the slot (`release`) before fixing it, and claim it again when you are ready.
4. **Just before merging, compare** the base's commit with the one you noted. If it moved anyway (a merge from outside Hive), merge the base in again, rerun the checks (all of them when the new commits touch shared code or test tooling) and compare again.
5. **Merge** in the checkout where the base is (`git -C <that checkout> merge --no-ff <branch>`). If git says `index.lock` exists, another merge is under way there: wait and try again; never delete the lock.
6. **Release the slot** once merged, and **report** the merge commit and the base commit your checks ran on: for each passed card, `hive_report_merge` (the merge commit). Cards still in Review or Doing stay where they are. A merge step you can't take within a rule (your CLI refused the commit, say) is `hive_cannot_within_rules` on the card (the rule, and why): it goes to the user.
