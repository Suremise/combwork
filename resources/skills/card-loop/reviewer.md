# Card loop: the reviewer

## The lane and your watches

Join the lane: `hive_lane` with `action: "join"`, `builder` (its name) and the cards. A reviewer from the project's reviewer pool joins no lane: Hive tells it of each card or design it gets, in its inbox.

Your watches:
- a new card: the card, `column: "review"` (at once if it's already there);
- a card you failed: the card, `column: "review"`, `fresh: true` (its next submission brings it back);
- after asking the builder for something: the card, `changes: ["comment"]` (its reply).

Woken with your card back, read it with `comments: 1`: its decisions, listed first, may have changed.

## Reviewer

For each card, in order:
1. Wait for it to arrive in Review (above).
2. Review it with the **review-agent-work** skill: `hive_start_review` names what to review (a revision, or a no-code card's summary). For a code card in Git, work that revision doesn't hold (uncommitted, or no commit named) isn't a failed round on that alone: start the watch for the builder's reply, ask with `hive_request_builder` (it wakes the builder), and end your turn.
3. **Blocking findings**: `hive_verdict` with `pass: false` and them numbered, each with what to fix (`failKind: "explanation"` when only how the work was explained falls short), and end your turn (SKILL.md, Waiting). Points that aren't blocking become follow-up cards.
4. **No blocking findings**: `hive_verdict` with `pass: true`, and take the next card.

A finding the builder **disputes**: stop and ask (rounds.md).

**A design or follow-up to check** (woken with "The builder: design HI-12/s40 posted…" or "follow-up HI-12/s41 ready…"): read its latest comment (and what a follow-up names as changed), start your watch again (while a follow-up is due, `changes: ["comment", "column"]`: it doesn't move the card), then answer with `hive_loop_step`, `step: "ok"` or `"gaps"` (what's missing, numbered) and `design`, its id, and end your turn. Not a review: no verdict, no round. Told the builder went ahead unchecked: nothing to answer.
