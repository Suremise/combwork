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
3. **Run the checks.** Use the project's own commands (package scripts, the README, CI config): tests, typecheck, lint, and whatever else the change needs. Fix failures this branch caused; report those that were there before.
4. **Compare with the base**: `git log --oneline <base>..HEAD` and `git diff --stat <base>...HEAD`. Look for files changed by accident, debug code, commented-out code and leftover TODOs. If the base has moved on, say whether it merges cleanly (`git merge-tree --write-tree <base> HEAD`). Files merged with `merge=union` never conflict: after merging the base, look there for an entry twice in two wordings.
5. **Summarise for the reviewer**: what changed, why (and the card), how to check it, the checks you ran and their results, and what to watch out for (risks, anything unfinished).

## Who merges

Give the user the summary, saying plainly whether the branch is ready and, if not, what's in the way. For a card, how its work lands is the card's own rules: those it started under (unless the user applied changed options to it), never the project's options now, which (`hive_project_status`'s `workflow`, a lane's brief) say how new cards finish. Never infer the next step from the card's column: do the one Hive names.
- **"Merge it and report the merge"** (Hive tells you once the merge is yours): merge it and report it (merging.md); Hive checks the work is in the base before Done, refusing with what's missing.
- **A request waiting for the user** (For you: their review, their OK before merging, their acceptance): wait for their answer; Hive tells you what follows.
- **The card's `merge`** (`hive_read_task`): Hive's merge queue has it, and merges it or returns it with why (fix and submit again). Don't merge it yourself: while the rules are enforced Hive refuses that. With them switched off the queue pauses (its `merge` says so) and the card is finished as before them: as your brief says, then `hive_report_merge`.
- **Done**: nothing is left.

The ways a card finishes, for context: Hive merges; the agent merges (after a passing review where there is one, after the user's OK where the rules ask for it, else straight after its submission, the card staying in Doing); merges not checked (once it passes, merged as the brief says and reported, nothing checked); committed is done, and no-code cards (Done once passed or submitted); no version control (accepted, after the user's approval where the rules ask for it).

Outside a card, or with no workflow: the user merges from Hive, or you when they ask. Rebase, push, delete the branch or publish only when the user asks you to; for their OK on one (a push, a release), ask on the card with `hive_ask_user` (`kind: "approve"`).

## Reference files

Read one only when it applies:

- [merging.md](merging.md): when the merge is yours to make.
