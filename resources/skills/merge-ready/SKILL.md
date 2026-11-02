---
name: merge-ready
description: "Get a branch ready to merge and merge it when asked, through the merge slot: commit, run the checks, compare with the base. Use when asked to finish up, ready a branch, or merge one (\"merge X into Y\", \"merge this lane\")."
metadata:
  audience: agents
---

# Merge ready

In Hive a card's work is often on its own branch, in the slot (a working folder) Hive lends the card or its lane. Make its review quick and its merge safe.

## Steps

1. **Where you are.** `git branch --show-current` and `git worktree list`. On the project's main branch there is nothing to merge: say so, and do what the user asked (commit there only if they asked you to).
2. **Finish loose work.** `git status`. Commit the work that belongs to this task, and only that. Leave out build output, logs, local config and secrets. List anything you left uncommitted, and why.
3. **Run the checks.** Use the project's own commands (package scripts, the README, CI config): tests, typecheck, lint, and whatever else the change needs. Fix failures this branch caused; report those that were there before. Merging it yourself: run them once, holding the slot (Merging, step 2), not first here.
4. **Compare with the base**: `git log --oneline <base>..HEAD` and `git diff --stat <base>...HEAD`. Look for files changed by accident, debug code, commented-out code and leftover TODOs. If the base has moved on, say whether it merges cleanly (`git merge-tree --write-tree <base> HEAD`).
5. **Summarise for the reviewer**: what changed, why (and the card), how to check it, the checks you ran and their results, and what to watch out for (risks, anything unfinished).

## Who merges

Give the user the summary, saying plainly whether the branch is ready and, if not, what's in the way. Never infer the next step from the card's column: do the one Hive names.
- **"Merge it and report the merge"** (Hive tells you once the merge is yours): merge it and report it (below); Hive checks the work is in the base before Done, refusing with what's missing.
- **Done**: nothing is left.
- Anything else: [who-merges.md](who-merges.md).

## Merging, when it is yours

What you merge must be what you checked, so merges into a base take turns through Hive's **merge slot**:
1. **Claim the slot** for the base with `hive_merge_slot` (`claim`, with the cards you are merging, if any: a merge of no card claims it too). Still in line: claim again, keeping your place. No hive tool listed: go on, as step 4 still protects the merge.
2. **Merge the base into the branch, note its commit** (`git rev-parse <base>`) **and run the checks** the combined change needs. Merge it into the branch, not the branch into the base with `--no-commit`: a failure is then fixed on the branch, and the base's checkout is never left mid-merge where others work. While you hold the slot nobody merges into the base through Hive, so one run is enough. The hold lasts 60 minutes: claim again to extend it.
3. **If something fails**, release the slot (`release`) before fixing it, and claim it again once ready.
4. **Just before merging, compare** the base's commit with the one you noted (moved anyway: who-merges.md).
5. **Merge** in the checkout where the base is (`git -C <that checkout> merge --no-ff <branch>`). An `index.lock` there means another merge is under way: wait and try again; never delete it.
6. **Release the slot** once merged, and **report** the merge commit and the base commit your checks ran on: `hive_report_merge` for each card Hive told you to merge. A merge step you can't take within a rule (your CLI refused the commit, say) is `hive_cannot_within_rules` on the card (the rule, and why): it goes to the user.

## Reference files

Read one only when it applies. Each is in this skill's own folder, beside this SKILL.md, not your working folder:

- [who-merges.md](who-merges.md): a card not yours to merge, which rules a card finishes by, the base moved, union merges.
