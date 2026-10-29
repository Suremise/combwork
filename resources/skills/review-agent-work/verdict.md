# Review agent work: the verdict and reviewing again

## 5. Verdict on the board

For a card, end your review with `hive_verdict` on the submission you reviewed:

- `pass: true` or `false`, with the report as `comment`. Its **first line is the verdict in one line**: "Round 1: PASSED" (with the gist), or "Round 1: FAILED: 2 findings: <their titles>". The findings and the evidence follow below it.
- **Passed**: Hive moves it on by the project's rules (another reviewer's pass where it asks for two, the user's OK, its merge, or Done): the reply says where. Where the rules hold, a verdict on a submission that isn't the latest, or with a decision on the card you haven't read, is refused, saying what to do. Done is never yours to move.
- **Failed**: it goes back to Doing for its builder, a round counted. `failKind: "content"` when the work itself falls short, `"explanation"` when only how it was explained does. Leave its fixes to whoever the user asks to make them.
- **A question only the user can answer** (scope, a choice the card doesn't settle) comes before a verdict: ask it with `hive_ask_user` (`kind: "decide"`); it shows under For you with the card, which stays in Review, and the answer comes to your inbox. A comment alone reaches no one. Finish the review once it comes.

If the card leaves Review while you review it (taken back to Doing for more work), your review is over. Leave the card where it is and give no verdict: tell the user what you found, so the newer work is reviewed when it's ready. Only if your own session ended mid-review, with the card still in Review, start the review again.

## Reviewing again

When the card comes back after fixes, review what changed since your last verdict: the new revision's changes, the comments after yours, and any decision recorded since (a reply flags a new one). Re-run a check only when what it covers has changed, and confirm each earlier finding is fixed or still open.
