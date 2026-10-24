---
name: run-lanes
description: "Run a team as the Hive Assistant: builder and reviewer lanes on card loops, planned by files, briefed and watched to their end. Use when there are three or more agents, builder and reviewer pairs or worktree agents, when asked for lanes, or woken about one."
metadata:
  audience: assistant
---

# Run lanes

A team works through cards in **lanes**: each a builder and a reviewer taking cards in turn in a card loop (card-loop, the agents' skill). coordinate-agents covers the tools; this is how to run a team well. With one or two agents and no reviewers, coordinate-agents is enough.

## Whose job is what

The loop runs itself: the builder builds each card and sends it to Review, the reviewer reviews it, and Hive wakes each when the other acts. The builder handles failed verdicts, merges at the lane's end and moves its cards to Done. You set lanes up, follow them to their end and handle what the loop can't: a question for the user, a card that keeps failing, a lane that stops. Dispatching each step yourself, or writing separate review cards, gets in the loop's way: a review happens on the card, in Review.

## Plan lanes by files

- Split the cards so that agents sharing a folder never edit the same files: group them by the files they touch. A builder working beside others is best in a slot of its own, which Hive lends its lane where the project builds cards in slots (set it only if the user agrees; a team setup they chose, such as a template, counts); a reviewer needs none: it reviews in a review copy.
- Cards that depend on each other go in the same lane, in order. Name overlaps between lanes in both briefs ("lane 2 also edits the settings view: merge main before each card and keep to your sections").
- A follow-up card belongs to the lane that owns its files: add it to that builder's list (below), or put it in Todo saying which lane should take it.

## Brief completely

Each agent reads only what you send it, and each lane starts in a new conversation (coordinate-agents, A new lane). A builder's brief, to adapt:

```
Use card-loop as the builder. Cards, in order: #12, #15. Your reviewer is R1. Each card's start names its slot and branch: work there.
First, and before each card: merge main, and install dependencies if the lock file changed.
Commit each round on the card's branch before sending the card to Review (card-loop).
Lane end: claim the merge slot, use merge-ready, merge the branch into main, move the cards to Done, report the merge commit on the last card, release the slot, then stop. No push, release or installer.
Follow-ups go to Todo as new cards.
```

Then what this lane needs: test homes or other safety rules, risky areas, overlaps with other lanes, a merge point mid-lane, and the project's own conventions agents can't know otherwise, such as the user OK-ing a visible change from before and after screenshots before the merge (then the brief says who takes them, when, and that the last card waits, blocked, for the OK). Write them in now: anything you add later reaches a busy agent only as a message (`hive_message_agent`), read from its inbox at its next tool call or turn's end. A reviewer's brief: `Use card-loop as the reviewer. Cards, in order: #12, #15. Your builder is B1.`, with what to look at closely on risky cards.

- Give rounds and a wait only when the user did; otherwise the lane takes the project's card-loop settings.
- Agents working in the project folder, with no slot, have nothing to merge: their brief says to commit, and to move a passed card to Done.
- Explain the goal and the handoffs, give a sensible default and leave room for judgement: ask agents to say when they do something else, and why.
- Start the lane yourself with `hive_lane` `start`, so the user sees it at once.

## Watch to the end

Nothing wakes you but the user and a watch you started, so never leave lanes on "they'll tell you".

- **One lane watch covers the whole team.** `hive_wait_for_tasks` with `lanes: ["all"]`, `wake: true`, `limitMinutes: 360`: it follows every running lane, lanes started later and cards added to a lane too, with no card limit, and wakes you only for what needs you: a failed review, a card blocked (a question for the user) or stalled, a lane whose cards have all passed (its merge is due) or whose merge then stalls (its builder idle, no merge slot), a lane ended or abandoned, and an agent starting to wait for the user (a permission prompt or a question in its pane). Add `events` (`passed`, `moved`) only to follow more. You have one watch at a time, and a card watch would replace it: a card you follow outside the lanes (a release, a one-off fix) goes in the same watch as `cards` (`lanes: ["all"], cards: [720]`), which the next lane watch keeps until you pass `cards` again (`[]` for none). Put follow-ups in a lane.
- **Check the reply says it is waiting** before you end your turn. If it doesn't, start it again once; if it still doesn't, tell the user.
- On each wake: `hive_inbox` lists what changed in each lane; read the cards it names (`hive_read_task` with `latestComment` and `summary: true`: reports and verdicts lead with a one-line summary; read a comment in full only when you act on its detail), then sweep the board: new follow-ups, stalled cards, a card waiting for the user, an agent idle while its card waits (check it with `hive_agent_activity`; prompt it once it is idle), and a duplicate, an unrecorded answer or an out-of-date blocked reason (board-hygiene). Then start the lane watch again, and tell the user in a line or two. Once every lane has ended, say so; there is nothing left to watch. If nothing else is running or waits on the user, add once, in a line, that it's a good moment to start fresh conversations (yours too, once your journal holds what is open): the user decides.
- An agent asking the user something, or woken because one waits for the user: pass the question on (coordinate-agents, Leave agents alone), never answer it for them, and start the lane watch again before you end your turn: the other lanes carry on while the user decides.
- **A finding that keeps coming back.** When a card fails review a second or third time on the same kind of finding (new edge cases in one mechanism), don't let its loop run on: bring the user a simpler option with your recommendation (the simple version now, the rest on a new card). Record their choice on the card as a decision and tell the builder (`hive_message_agent`). The builder and reviewer carry on meanwhile (card-loop); stepping in is yours.

## Changing a running lane

- A decision you record on a lane's card in Review, or a block you clear from one, wakes neither side: follow it with `hive_message_agent` to the builder (with `card`), and to the reviewer when it changes what they check (coordinate-agents, Plan as cards).
- A comment on a card doesn't reach a builder's loop, and neither does a card added to its lane while it runs. A lane's list changes only between cards: wait until the builder is idle, prompt it with the new list, and start the lane again with it (`hive_lane` `start`); otherwise start a new lane.
- To move a card to another lane, reassign it (`hive_update_task` with `agent`): Hive ends the old pair's watches on it and tells them. Then prompt the new lane's builder once it is idle.

## Verify, don't trust

- Check what agents report against git and the board: the merge commit is in main (`git log`), merged isn't pushed, a Done card's work really is merged. Correct the record on the card when it's wrong.
- When an agent finds a real problem late, lay out the options with your recommendation rather than letting "nearly done" ship a known break.
