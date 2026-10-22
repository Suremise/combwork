---
name: card-loop
description: "Work through cards in turn as their builder or reviewer, waiting at no cost. Use when told to work through or review cards (one or several) as a builder or reviewer, or given rounds."
metadata:
  audience: agents
---

# Card loop

Two agents take the same cards in turn: the **builder** does each card and sends it to Review; the **reviewer** reviews it and passes it back with findings, or passes it. This skill is one side of that loop. Waiting for the other side costs nothing: you end your turn and Hive wakes you.

## Inputs

From the user's request:
- **role**: `builder` or `reviewer`;
- **cards**: the numbers, in the order given (one at a time, never ahead);
- **rounds**: how many rounds a card gets before the user is asked ("rounds: 10"). A round is one build and its review (below);
- **wait**: how long with no change before you tell the user ("wait: 4h");

Rounds or wait the request doesn't give are the project's settings (Card loops: 10 rounds and 6 hours unless the user changed them): the lane's reply below says them.

Ask if the role or the cards aren't clear.

## The lane

Hive keeps a record of the loop, its **lane**, and shows it to the user. Register it as you start, with `hive_lane`:
- builder: `action: "start"`, the cards in order, `reviewer` (its name), and `rounds` and `waitMinutes` only if the request gave them;
- reviewer: `action: "join"`, `builder` (its name) and the cards.

Its reply gives the lane's rounds and wait: use them where your request gave none. Without a lane, 10 rounds and 6 hours.

Hive follows the board from there and ends the lane when its cards are Done: never end it or give it a merge commit yourself. It takes one card at a time: `hive_lane` with `action: "next"` names your next card to start or carry on, or why the lane waits (a card not merged yet, a question for the user). A lane's cards change only between cards: given a new list (a card added, the order changed) once it's idle, the builder starts the lane again with it, and carries on from there. A running loop never sees a card added to the lane meanwhile, so for anything else a new lane is started. If the user calls the loop off, end the lane with `action: "end"`, `abandoned: true`; stopping to ask the user leaves it as it is. The lane is only a record: if the tool is missing or a call fails, carry on with the loop.

## Waiting

Wait with `hive_wait_for_tasks`, `wake: true`:
- builder: the card, `changes: ["verdict", "column", "comment"]`, `column: "passed"` (a review's verdict, the card moved into Passed, or a comment, such as the reviewer asking for a commit);
- reviewer, a new card: the card, `column: "review"` (only its arrival in Review counts, not the builder's comments; at once if it's already there);
- reviewer, after failing a card: the card, `column: "review"`, `fresh: true` (its next round: the builder's next submission brings it back; without `fresh`, a card still in the column answers at once);
- reviewer, after asking for a commit: the card, `changes: ["comment"]` (the builder's reply naming it);
- `limitMinutes`: the run's wait.

**Start the watch before the step that lets the other side act**, so a quick answer isn't missed: the builder just before moving the card to Review, the reviewer just before posting a failed verdict. Your own move doesn't wake you. **Check the watch's reply** before you end your turn:
- "Waiting for #12 → Review…": the watch is live. Finish that step and **end your turn**, saying what you're waiting for.
- "Already: #12 is in Review…": what you'd wait for has happened. Carry on with it now (no watch needed yet).
- An error, or anything else: start the watch again once. If it still says neither, tell the user (`hive_notify`) instead of saying you're watching. Don't poll, don't sleep in a command, and don't start other work: when the card changes, or the wait passes with no change, Hive types one short line into your session ("[Hive] New in your inbox: 1 card event (#12) (m7). Call hive_inbox to read it.").

When woken, call `hive_inbox` first: it lists what changed ("#12 is in Review: Codex failed it; latest comment by …"), and anything else left for you meanwhile, each with its sender (work-on-card, Your inbox). Then read only what you need: `hive_read_task` with `latestComment: true` (or `comments: n` for the last few); a report and a verdict lead with a one-line summary, so `summary: true` gives just those lines when the gist is enough (read the comment in full to act on findings). A reviewer whose card is back in Review reads it with `comments: 1` instead: its decisions, listed first, may have changed since the last round. Read the whole card again only when the comment says to, or a reply says the card has a new decision (then check the work against it before your next step). The same goes for a long plan or spec a card points to (over about 20 KB): `hive_doc_outline`, then `hive_read_section` for the sections it needs. A card's own references (its `context`, listed as Read these first in its start prompt): the builder reads them before starting, the reviewer checks the work against them. The line names every watched card that changed; when you wait on more than one (cards reviewed together), check each one's column and latest verdict before watching again, not only the one you expected, and watch them all in one watch.

If a wake isn't possible (the tool says so), wait in the call instead: `hive_wait_for_tasks` without `wake`, `timeoutSeconds` up to 840, and pass the reply's `since` to the next call.

**Never end a turn in a loop without a watch**, unless the loop is over or you're asking the user. Woken with nothing to do yet (a reviewer whose card isn't back in Review), start the same watch again.

**The watch is your only standing wait.** A loop runs for hours, and a command left running in it outlives the run it was for. Watch your own test runs with something that ends with them (`hive-progress`, your CLI's notice that a background command ended), never `tail -f`, and stop any watcher, server or app copy you started before you move a card on or end your turn to wait. To wait for a time too (a merge slot to renew), give the watch that `limitMinutes`: never a sleep or a timer in a command.

Hive also wakes a loop's agents itself (unless the project turned it off): the reviewer when a card arrives in Review or its builder posts a design (below), the builder on a verdict, its reviewer's request or its answer to a design (in your inbox: "#12 (B1's card) is in Review. You review this card in its loop…"). Act on it as on your watch's wake. Watches are still how you wait: where yours tells you of the change, Hive's own wake isn't sent.

**While you work**, Hive tells you of what arrives in your inbox at your next tool call, or before your turn ends ("[Hive] New in your inbox: …"), without typing into your session: read it then with `hive_inbox`, as when woken.

**Another agent's card** (one your card depends on): its inbox item names whose card it is ("#12 (Claude's card) is in Passed…"). It tells you that card changed, not yours: read it, then carry on with your card, or watch again. **Passed means it passed review, not that it's merged**; Done means merged. When your card needs another one merged, check it is in Done or main has it (e.g. `git merge-base --is-ancestor <its commit> main`), or ask the user, before going on.

**A card that left your watch** ("#12 was reassigned to …" or "… is reviewed by …", "your watch on it ended"): it isn't yours to wait for any more. Drop it from your list and carry on with your next card, without asking.

**A blocked card is paused, not gone**: it stays on your list and your watch on it carries on. Don't take the next card meanwhile (the other side can't either): the builder asks the user (below), and once it's unblocked and back in Review the reviewer's watch wakes it as usual.

## Builder

For each card, in order:
1. Do its work with the **work-on-card** skill: started first (`hive_start_card`). **Commit the card's work before submitting it**, every round, and name the commit in the round's summary: the reviewer reviews that commit. Just before submitting it, start the watch for its verdict (above); then submit it (`hive_submit`, its summary saying what you did) and end your turn.
2. Hive wakes you with the verdict. Woken by the reviewer asking for something instead (a commit, a run: its request is a comment on the card): do it, reply on the card naming it, and watch again.
3. **Passed** (a passing verdict moved it on): its work is merged before the next card starts, since the lane takes one card at a time. Merge it as your brief says (merge-ready: taking turns at the merge slot, when other branches merge too), then report it with `hive_report_merge` (the merge commit), which moves it to Done. Unless the card says Hive merges it (`hive_read_task`: its `merge`): then the merge queue merges it; wait for Done or a return. Where your project's workflow has someone else merge, wait for that. Then `hive_lane` `next` names your next card.
4. **Failed**: the verdict sent it back to Doing. Fix the **blocking** findings, commit, start the watch again, and submit it again with a summary of what changed (naming the commit): the next round, which wakes the reviewer. Suggestions that aren't blocking can become follow-up cards (`hive_create_task`) rather than another round. At the lane's round limit Hive asks the user how to go on itself (below).

**A design first** (the card, its decisions or the user asks for one, or you want one checked before building): in Doing, start the watch on the card first (`changes: ["comment"]`, `limitMinutes`: `designWaitMinutes` from `hive_start_card`'s reply), then post it with `hive_loop_step`, `step: "design"` (the design as its text), and end your turn. Its reviewer is woken; the reply names the design (`design`) and when its check is due (`until`). `ok`: build it. `gaps`: revise, and post it again (watch first). Woken by something else meanwhile: watch again, `limitMinutes` the time left until `until`. No answer by then: `step: "proceed"` with its `design` (saying so), and build as posted. Refused with no reviewer for the card: ask in a comment instead.

**The lane's end:** once every card is Done, the lane ends by itself. A merge step that needs the user (a commit or merge your CLI or a permission check refuses, a conflict you can't settle) is `hive_cannot_within_rules` on that card (the rule, and why): it goes to the user, who answers in your inbox; then finish the merge.

**Checks in a round:** each move to Review carries a run record (work-on-card). After a round's fixes, rerun the checks those fixes affect (the project's notes may have a way to pick them), not every check again; but before a card can pass, the card's full checks must have run on its final code. The reviewer checks the record instead of repeating it, and runs the affected tests and its own probes (review-agent-work).

## Reviewer

For each card, in order:
1. Wait for it to arrive in Review (above).
2. Review it with the **review-agent-work** skill: `hive_start_review` (its reply names the revision to review), then your verdict. **Review the commit the builder names.** Work sent uncommitted (or no commit named) isn't a failed round on that alone: start the watch for the builder's reply (above), ask for the commit with `hive_request_builder` (it wakes the builder), and end your turn; review the commit once it's named.
3. **Blocking findings**: start the watch for its return (above), then `hive_verdict` with `pass: false` and them in the comment, numbered, each with what to fix (`failKind: "explanation"` when only how the work was explained falls short), and end your turn. It goes back to Doing for its builder. Points that aren't blocking become follow-up cards, not another round.
4. **Passed**: `hive_verdict` with `pass: true`: it moves on and waits to be merged. Done is for merged work, not yours to move. Take the next card.

**A design to check** (woken with "The builder: design HI-12/s40 posted for your check…", the card in Doing): read its latest comment, start your watch again as before, then answer with `hive_loop_step`, `step: "ok"` or `"gaps"` (what's missing, numbered) and `design`, its id (the wake names it, and so does the first line of the design's comment: `hive_read_task` with `latestComment`), and end your turn. It's not a review: no verdict, no round. Told the builder went ahead unchecked: nothing to answer.

## Rounds and when to ask

A round is one build and its review: round 1 is the first build and the first review, and each fix with its review is the next round. A card that passes its first review passed in round 1. Count each card's rounds.

- **At the round limit** (a card that has failed as many reviews as **rounds**), Hive counts and asks the user itself, under For you: carry on (how many more rounds), split the card, accept it with follow-up cards, or take it over. The lane waits; the builder doesn't fix it again until their answer comes to its inbox, then carries on as it says.
- **A finding that comes back** (the fix missed part of it): the reviewer says so in the failed verdict ("recurring from round 2") and the loop carries on; the line per round at the limit shows it. A finding the builder **disputes**, rather than missed, is a design question: stop and ask.
- **Stop and ask** on a design question the card doesn't answer, on a blocked card, on a merge step that needs the user, when the wait passes with no change (Hive wakes you to say so), or when a card of the loop is archived or gone (the wake line says so: only the user brings it back). Stopping and asking, builder or reviewer, is `hive_ask_user` on the card where it is (`kind: "decide"`; `"approve"` for an OK only they can give, such as a push), saying what you need decided: it shows the card waiting on the user under For you, and wakes whoever watches the lane. A card archived or gone can't take one: `hive_notify` the user, and leave it as it is. A comment on the card alone reaches no one. No further verdict or round meanwhile; their answer comes to your inbox: carry on from where you asked.

## At the end

Report each card: its rounds, how it ended (Passed, Done once merged, waiting for the user), and any follow-up cards you created.
