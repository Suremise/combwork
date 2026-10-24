---
name: run-lanes
description: "Run a team as the Hive Assistant: builder and reviewer lanes on card loops, planned by files, briefed and watched to their end. Use when there are three or more agents or several builder and reviewer pairs, when asked for lanes, or woken about one."
metadata:
  audience: assistant
---

# Run lanes

A team works through cards in **lanes**: each a builder taking cards in order in a card loop (card-loop, the agents' skill), reviewed by its own reviewer or by the project's reviewer pool. coordinate-agents covers the tools; this is how to run a team well. With one or two agents, coordinate-agents is enough: a single builder and reviewer pair runs its cards as one lane, as it says.

## Whose job is what

Hive owns the lane: its card list, the wakes between builder and reviewer, merging as the project's Who merges says, and the lane's end once every card is Done. While workflow rules are enforced (Settings → Advanced, on by default) it also takes one card at a time (the next starts once the one before is Done), queues list changes between cards and asks the user at the round limit; with them off, none of those three happens. The loop runs itself: the builder builds and submits each card, its reviewer reviews it, and Hive wakes each when the other acts. You set lanes up, follow them to their end and handle what the loop can't: a question for the user, a finding that keeps coming back, a lane that stops. Dispatching each step yourself, or writing separate review cards, gets in the loop's way: a review happens on the card, in Review.

## Plan lanes by files

- Split the cards so that agents sharing a folder never edit the same files: group them by the files they touch. Where the project builds cards in slots (its Version Control tab), Hive lends each builder a slot as its card starts; a reviewer needs none: it reviews in a review copy. Hive also warns when two lanes' cards look likely to touch the same files.
- Cards that depend on each other go in the same lane, in order. Name overlaps between lanes in both briefs ("lane 2 also edits the settings view: keep to your sections").
- A follow-up card belongs to the lane that owns its files: add it to that builder's list (below), or put it in Todo saying which lane should take it.

## Reviewers: one per lane, or the pool

The project's Reviewers option decides:
- **One per lane**: each lane has a builder and its reviewer, both briefed. Where the project's work isn't reviewed by an agent (no review, or only the user's), a lane is its builder alone.
- **A shared pool**: a lane has no reviewer of its own. Hive gives each submitted card to the next free reviewer of the pool, oldest submission first, and tells it; a card nobody is free for waits ("waiting for a reviewer"). Brief only the builder, and leave the pool's agents to Hive: no reviewer briefs or starts per card. A pool lane is started with **Start Lane** in the window (its reviewer list offers the pool), which `hive_lane` can't record: ask the user to start it there, with your plan of cards. The pool works only while workflow rules are enforced: with them off, nothing is given out, so each lane needs a reviewer of its own.

## Brief completely

Each agent reads only what you send it, and each lane starts in a new conversation (coordinate-agents, A new lane). The rules themselves (where to work, what a submission needs, who merges, when a card is Done) are Hive's: each card's start, each reply and each refusal say them, so a brief doesn't repeat them. With workflow rules off nothing refuses, and the agents' own skills (card-loop) carry the steps. A builder's brief, to adapt:

```
Use card-loop as the builder. Lane "<name>": cards, in order, #12, #15. Your reviewer is R1.
Follow-ups go to Todo as new cards.
```

Then what this lane needs and the rules can't know: test homes or other safety rules, risky areas, overlaps with other lanes, and the project's own conventions agents can't know otherwise. Write them in now: anything you add later reaches a busy agent only as a message (`hive_message_agent`). A reviewer's brief: `Use card-loop as the reviewer. Cards, in order: #12, #15. Your builder is B1.`, with what to look at closely on risky cards.

- Give rounds and a wait only when the user did; otherwise the lane takes the project's card-loop settings.
- Explain the goal and the handoffs, give a sensible default and leave room for judgement: ask agents to say when they do something else, and why.
- Start the lane yourself with `hive_lane` `start`, so the user sees it at once.

## Watch to the end

Nothing wakes you but the user and a watch you started, so never leave lanes on "they'll tell you".

- **One lane watch covers the whole team.** `hive_wait_for_tasks` with `lanes: ["all"]`, `wake: true`, `limitMinutes: 360`, and no `cards` of the lanes: it follows every running lane, lanes started later and cards added to a lane too, and wakes you only for what needs you: a failed review, a card blocked or stalled, a lane whose cards have all passed (its merge is due) or whose merge then stalls, a lane ended or abandoned, and an agent starting to wait for the user. A lane's cards added as `cards` would wake you on every move of them. Add `events` (`passed`, `moved`) only to follow more. You have one watch at a time: a card you follow outside the lanes (a release, a one-off fix) goes in the same watch as `cards` (`lanes: ["all"], cards: [720]`), which the next lane watch keeps until you pass `cards` again (`[]` for none).
- **Check the reply says it is waiting** before you end your turn. If it doesn't, start it again once; if it still doesn't, tell the user.
- On each wake: `hive_inbox` lists what changed in each lane; read the cards it names (`hive_read_task` with `latestComment` and `summary: true`: reports and verdicts lead with a one-line summary; read a comment in full only when you act on its detail), then sweep the board: new follow-ups, stalled cards, a card waiting for the user, an agent idle while its card waits (check it with `hive_agent_activity`; prompt it once it is idle), and a duplicate, an unrecorded answer or an out-of-date blocked reason (board-hygiene). Then start the lane watch again, and tell the user in a line or two. Once every lane has ended, say so; there is nothing left to watch. If nothing else is running or waits on the user, add once, in a line, that it's a good moment to start fresh conversations (yours too, once your journal holds what is open): the user decides.
- An agent asking the user something, or woken because one waits for the user: pass the question on (coordinate-agents, Leave agents alone), never answer it for them, and start the lane watch again before you end your turn: the other lanes carry on while the user decides.

## What Hive does, so you don't ask

- **A failed review is the loop's**, at any round below the lane's limit (at any round with workflow rules off): the builder fixes it and submits again. Don't ask the user whether to go on, however many rounds it has taken.
- **The round limit** is the lane's rounds (the project's Card loops settings, or what the user gave). At it, Hive asks the user itself, under For you (carry on, split the card, accept it with follow-ups, or take it over), and the lane waits on that card: pass the question on and record the answer as a decision. With workflow rules off there is no limit: nothing asks and no lane pauses for it, so don't ask in its place; the loop runs on, and a finding that keeps coming back is still your judgement (below).
- **A merge due** (a code card passed; a no-code card has none): it goes on as Who merges says (coordinate-agents, How a card finishes). Under Hive merges, Hive's merge queue merges it (`hive_queue` shows why one waits or was returned); under the agent merges, its builder merges it as it passes; committed in the project folder, it is already done. Where the options ask for the user's OK before merging, Hive asks them first: pass it on. The lane's status says which step it waits on. Step in only when the merge stalls (the queue paused or failing, a builder idle on a passed card): read why, and prompt the builder or tell the user. Never ask whether to merge.
- **A lane's end**: it ends by itself once every card is Done. Don't end a finished lane or ask to.
- **A finding that keeps coming back**: when the reviewer marks a finding recurring, or the rounds keep turning up new edge cases of one mechanism, the loop isn't converging: that is your judgement, not a count of failures. Bring the user a simpler option with your recommendation (the simple version now, the rest on a new card), record their choice as a decision on the card (which wakes the builder and reviewer), and where the new shape needs agreeing first, ask the builder to post it as a design step (`hive_loop_step`) for its reviewer to check before building. The builder and reviewer carry on meanwhile (card-loop); stepping in is yours.

## Changing a running lane

- A lane's list is Hive's: `hive_lane` `start` with the builder's changed list (cards added, removed or reordered) updates it; you needn't wait for the builder to be idle. While workflow rules are enforced, a change made while one of its cards is in flight is queued until that card is Done, and Hive tells the builder when it applies; between cards, or with the rules off, it applies at once, so tell the builder yourself (`hive_message_agent`) when it changes what it works on next.
- A decision you record on a lane's card wakes its builder and reviewer (unless the project turned its loop wakes off); a block you clear from a card in Review doesn't: follow it with `hive_message_agent` to the builder (with `card`).
- To move a card to another lane, reassign it (`hive_update_task` with `agent`): Hive ends the old pair's watches on it and tells them. Then update both lanes' lists.

## Verify, don't trust

- Check what agents report against git and the board: the merge commit is in the target branch (`git log`), merged isn't pushed, a Done code card's work really is in the target (Not checked records no merge, and a no-code card has none). Correct the record on the card when it's wrong.
- When an agent finds a real problem late, lay out the options with your recommendation rather than letting "nearly done" ship a known break.
