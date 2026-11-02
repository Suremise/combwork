# Review agent work: when it isn't a card

- **A card with no workflow** (an intent says so) is reviewed on the board instead: `hive_update_task` with `review: "start"`, and the verdict as `review: "passed"` (with `column: "passed"`) or `"failed"`.
- **A branch**: `git diff <base>...<branch>` and `git log <base>..<branch>`.
- **Commits**: `git show` for the range named.
- **Uncommitted changes**: `git status`, `git diff` and `git diff --staged` in that folder.

`hive_project_status` shows each agent's folder and branch when you're told an agent's name rather than a branch. Note the exact revision or state you reviewed, so the verdict refers to it. Ask the user if what to review is unclear.

**A card from the pool:** A reviewer from the project's pool is told of each card it is given in its inbox: that is its start.

**Work sent uncommitted:** For a code card in Git, work that revision doesn't hold (sent uncommitted) gets a request for a commit (`hive_request_builder`), not a verdict (card-loop, Reviewer).
