---
name: card-loop
description: "Work through cards in turn as their builder or reviewer, waiting at no cost. Use when told to work through or review cards (one or several) as a builder or reviewer, or given rounds."
metadata:
  audience: agents
---

# Card loop

Two agents take the same cards in turn: the **builder** does each card, commits it and submits it for review; the **reviewer** reviews it and fails it with findings, or passes it. Waiting for the other side costs nothing: you end your turn and Hive wakes you. Each step is a tool (work-on-card); what a step needs first is the project's rules, which Hive checks, and a refusal says what to do next.

## Inputs

From the request: your **role** (`builder` or `reviewer`) and the **cards**, in order. Ask if unclear. Rounds and wait: the request's, else the project's workflow options (the lane's reply says them).

## The lane

Hive keeps the loop as a **lane** and shows it to the user. Register it as you start, with `hive_lane`:
- builder: `action: "start"`, the cards in order, `reviewer` (its name), and `rounds` and `waitMinutes` only if the request gave them;
- reviewer: `action: "join"`, `builder` (its name) and the cards. A reviewer from the project's reviewer pool joins no lane: Hive tells it of each card it is given to review, in its inbox.

The lane's list is Hive's. `hive_lane` `next` names your next card, or why the lane waits (a card not merged yet, a question for the user): where the project's rules hold a lane to one card at a time, the next one can't start before the last is Done. Given a changed list, the builder sends it with `start` again: while a card is in flight Hive queues it and tells you when it applies. The lane ends by itself once every card is Done; abandoning one is the user's. The lane is a record: if a call fails, carry on with the loop.

## Waiting

Wait with `hive_wait_for_tasks`, `wake: true`, `limitMinutes` the lane's wait. **After a submission or a failed verdict in your lane, Hive watches the card for you**: the reply says so, so end your turn. Where it says your own watch stays, or nothing of a watch, or you are woken with nothing to do yet, start it yourself:
- builder, its card in Review: the card, `changes: ["verdict", "column", "comment"]`, `column: "passed"` (a verdict, the card moved on, or a comment such as the reviewer asking for something);
- reviewer, a new card: the card, `column: "review"` (at once if it's already there);
- reviewer, a card it failed: the card, `column: "review"`, `fresh: true` (its next submission brings it back);
- reviewer, after asking the builder for something: the card, `changes: ["comment"]` (its reply).

**Start the watch before the other steps that let the other side act** (a request, a design, a follow-up, a reply), so a quick answer isn't missed; your own step doesn't wake you. Then check the watch's reply: "Waiting for…" is live, so finish that step and **end your turn**, saying what you wait for; "Already: …" has happened, so carry on now. Anything else: start it again once, and if it still says neither, `hive_notify` the user. **Never end a turn in a loop without a watch or a loop wake to come**, unless the loop is over or you're asking the user, and never poll or sleep instead. Hive also wakes a loop's agents itself (a card arriving in Review, a verdict, a request, a design); act on that as on your own watch's wake.

**A loop wake to come:** while you wait on the other side's move, loop wakes bring it with no watch: as builder, the verdict on your card in Review (no request of the reviewer's left to answer) or your design's or follow-up's answer; as reviewer, the next submission. Only while the project's loop wakes are on (its workflow option **Wake reviewers and builders**) and you have your hive tools: then a watch a notice or its limit ended needs no restarting, and its limit is no question for the user. Otherwise, or for what a loop wake doesn't bring (a comment you asked for, another card, a dependency), start the watch as above. A design's or follow-up's own `until` still holds.

**When woken**, `hive_inbox` first: it says what changed and what else came, each with its sender (work-on-card, Your inbox: act, then ack). Read only what you need: `hive_read_task` with `latestComment: true` (`summary: true`: first lines only; read in full to act on findings). A reviewer whose card is back reads it with `comments: 1`: its decisions, listed first, may have changed. Woken by several watched cards: check each one's column and verdict, and watch them all again in one watch. Woken with nothing to do yet: start the same watch again. If a wake isn't possible (the tool says so), wait in the call instead (`timeoutSeconds` up to 840, passing the reply's `since` on).

**Another agent's card** that yours depends on: its event tells you that card changed, not yours; Passed means reviewed, not merged. **A card that left your watch** (reassigned, reviewed by another): drop it and carry on, without asking. **A blocked card** is paused, not gone: it stays on your list, and the next card waits for it.

## Builder

For each card, in order:
1. Do its work with the **work-on-card** skill (`hive_start_card` first). The reviewer reviews what you submit (work-on-card, Finish): for a code card in Git, commit each round's work and name the commit in its summary; a no-code card has nothing to commit. `hive_submit`, and end your turn (Waiting, above).
2. **A change asked of the card in Review**: make it (for a code card in Git, commit it), then `hive_submit` with `followUp: true` before you wait: until then nothing is handed over. A run asked for: reply naming it, then watch again.
3. **Passed**: its finish is the project's, and the card says what's next (work-on-card, Finish). **Done**: the lane goes on, whatever the card's own prompt named: with the rules on Hive starts the next card for you (end your turn), else take it unprompted (`hive_lane` `next`) until none is left.
4. **Failed**: the verdict sent it back to Doing. Fix the **blocking** findings (committed, for a code card in Git), and submit again with what changed (naming the commit, for a code card in Git): the next round. Suggestions that aren't blocking become follow-up cards (`hive_create_task`).

**Checks in a round:** each submission carries a run record (work-on-card). After a round's fixes rerun the checks they affect, but the card's full checks must have run on its final code before it can pass.

**A design first** (the card, its decisions or the user asks for one, a finding keeps coming back, or you want one checked before building): in Doing, start the watch (`changes: ["comment"]`, `limitMinutes`: `designWaitMinutes` from `hive_start_card`'s reply), post it with `hive_loop_step` (`step: "design"`, the design as its text), and end your turn. `ok`: build it. `gaps`: revise and post again (watch first). Woken by something else: watch again until the reply's `until`. No answer by then: `step: "proceed"` with its `design`, and build as posted.

**A follow-up** (a change asked of the card, for its reviewer to check): in Review, step 2 (no round). In Passed, make it (committed, for a code card in Git), start the watch (`changes: ["comment", "column", "verdict"]`), post it with `hive_loop_step` (`step: "followUp"`, saying what changed: for a code card in Git, its commit), and end your turn: a comment alone wakes nobody. `ok`: carry on; `gaps`: fix and post again. No answer by the wait: ask the user.

**The lane's end:** a merge step that needs the user (a commit or merge your CLI or a permission check refuses, a conflict you can't settle) is `hive_cannot_within_rules` on that card (the rule, and why): their answer comes to your inbox; then finish the merge.

## Reviewer

For each card, in order:
1. Wait for it to arrive in Review (above).
2. Review it with the **review-agent-work** skill: `hive_start_review` names what to review (a revision, or a no-code card's summary). For a code card in Git, work that revision doesn't hold (uncommitted, or no commit named) isn't a failed round on that alone: start the watch for the builder's reply, ask with `hive_request_builder` (it wakes the builder), and end your turn.
3. **Blocking findings**: `hive_verdict` with `pass: false` and them numbered, each with what to fix (`failKind: "explanation"` when only how the work was explained falls short), and end your turn (Waiting, above). Points that aren't blocking become follow-up cards.
4. **No blocking findings**: `hive_verdict` with `pass: true`; the reply says where it went. Take the next card.

**A design or follow-up to check** (woken with "The builder: design HI-12/s40 posted…" or "follow-up HI-12/s41 ready…"): read its latest comment (and what a follow-up names as changed), start your watch again (while a follow-up is due, `changes: ["comment", "column"]`: it doesn't move the card), then answer with `hive_loop_step`, `step: "ok"` or `"gaps"` (what's missing, numbered) and `design`, its id, and end your turn. Not a review: no verdict, no round. Told the builder went ahead unchecked: nothing to answer.

## Rounds and when to ask

A round is one submission and its review; a card that passes its first review passed in round 1.
- **The round limit** is the lane's rounds. Where the project's rules are enforced, Hive counts failed reviews and, at the limit, asks the user itself (carry on, split, accept with follow-ups, take over) and pauses the lane: submitting is refused until their answer comes to your inbox. With the rules off nothing counts them, and a card that keeps failing is your judgement, as below.
- **A finding that comes back** (the fix missed part of it): the reviewer says so in the failed verdict ("recurring from round 2") and the loop carries on. When the same kind keeps coming back, a design step (above) or a simpler option for the user beats another round. A finding the builder **disputes**, rather than missed, is a design question: stop and ask.
- **Stop and ask** on a design question the card doesn't answer, on a blocked card, on a merge step that needs the user, when the wait passes with no change on what no loop wake brings (above), or when a card of the loop is archived or gone. Builder or reviewer, use `hive_ask_user` on the card where it is (`kind: "decide"`; `"approve"` for an OK only they can give, such as a push): it shows under For you and wakes whoever watches the lane. A card archived or gone can't take one: `hive_notify` the user, and leave it as it is. A comment alone reaches no one: what only the Assistant may do, once decided (parking a card, say), goes to it: `hive_ask_assistant`. No further verdict or round meanwhile; their answer comes to your inbox: carry on from where you asked.

## At the end

Report each card: its rounds, how it ended (Passed, Done once merged, waiting for the user), and any follow-up cards you created.
