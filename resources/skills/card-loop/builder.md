# Card loop: the builder

## The lane and your watch

Register the lane as you start: `hive_lane` with `action: "start"`, the cards in order, `reviewer` (its name), and `rounds` and `waitMinutes` only if the request gave them.

Your watch, your card in Review: the card, `changes: ["verdict", "column", "comment"]`, `column: "passed"` (a verdict, the card moved on, or a comment such as the reviewer asking for something).

## Builder

For each card, in order:
1. Do its work with the **work-on-card** skill (`hive_start_card` first). The reviewer reviews what you submit (work-on-card, Finish): for a code card in Git, commit each round's work and name the commit in its summary; a no-code card has nothing to commit. `hive_submit`, and end your turn (SKILL.md, Waiting).
2. **A change asked of the card in Review**: make it (for a code card in Git, commit it), and hand it over first (SKILL.md, Waiting). A run asked for: reply naming it, then watch again.
3. **Passed**: its finish is the project's, and the card says what's next (work-on-card, Finish). **Done**: the lane goes on, whatever the card's own prompt named: with the rules on Hive starts the next card for you (end your turn), else take it unprompted (`hive_lane` `next`) until none is left.
4. **Failed**: the verdict sent it back to Doing. Fix the **blocking** findings (committed, for a code card in Git), and submit again with what changed (naming the commit, for a code card in Git): the next round. Suggestions that aren't blocking become follow-up cards (`hive_create_task`).

**Checks in a round:** each submission carries a run record (work-on-card). After a round's fixes rerun the checks they affect; to pass, its final code needs the checks the project's notes require (if they don't say, its full checks).

**A design first** (the card, its decisions or the user asks for one, a finding keeps coming back, or you want one checked before building): in Doing, start the watch (`changes: ["comment"]`, `limitMinutes`: `designWaitMinutes` from `hive_start_card`'s reply), post it with `hive_loop_step` (`step: "design"`, the design as its text), and end your turn. `ok`: build it. `gaps`: revise and post again (watch first). Woken by something else: watch again until the reply's `until`. No answer by then: `step: "proceed"` with its `design`, and build as posted. Pool lanes too.

**A follow-up** (a change asked of the card, for its reviewer to check): in Review, step 2 (no round). In Passed, make it (committed, for a code card in Git), start the watch (`changes: ["comment", "column", "verdict"]`), post it with `hive_loop_step` (`step: "followUp"`, saying what changed: for a code card in Git, its commit), and end your turn: a comment alone wakes nobody. `ok`: carry on; `gaps`: fix and post again. No answer by the wait: ask the user.

**The lane's end:** a merge step that needs the user (a commit or merge your CLI or a permission check refuses, a conflict you can't settle) is `hive_cannot_within_rules` on that card (the rule, and why): their answer comes to your inbox; then finish the merge.
