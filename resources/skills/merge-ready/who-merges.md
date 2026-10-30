# Merge ready: other cards and edge cases

## Who merges

For a card, how its work lands is the card's own rules: those it started under (unless the user applied changed options to it), never the project's options now, which (`hive_project_status`'s `workflow`, a lane's brief) say how new cards finish.

- **A request waiting for the user** (For you: their review, their OK before merging, their acceptance): wait for their answer; Hive tells you what follows.
- **The card's `merge`** (`hive_read_task`): Hive's merge queue has it, and merges it or returns it with why (fix and submit again). Don't merge it yourself: while the rules are enforced Hive refuses that. With them switched off the queue pauses (its `merge` says so) and the card is finished as before them: as your brief says, then `hive_report_merge`.

Outside a card, or with no workflow: the user merges from Hive, or you when they ask. Rebase, push, delete the branch or publish only when the user asks you to; for their OK on one (a push, a release), ask on the card with `hive_ask_user` (`kind: "approve"`).

## Edge cases

- **The base moved anyway** before you merge (a merge from outside Hive): merge the base in again, rerun the checks (all of them when the new commits touch shared code or test tooling) and compare again.
- **Union merges:** files merged with `merge=union` never conflict: after merging the base, look there for an entry twice in two wordings.
