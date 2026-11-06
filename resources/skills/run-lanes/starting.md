# Run lanes: planning and briefing

## Plan lanes by files

- Split the cards so that agents sharing a folder never edit the same files: group them by the files they touch. Where the project builds cards in slots (its Version Control tab), Combwork lends each builder a slot as its card starts; a reviewer needs none: it reviews in a review copy. Combwork also warns when two lanes' cards look likely to touch the same files.
- Cards that depend on each other go in the same lane, in order. Name overlaps between lanes in both briefs ("lane 2 also edits the settings view: keep to your sections").
- A follow-up card belongs to the lane that owns its files: create it on that builder's lane (`cw_create_task` with `lane`, changing-lanes.md), or put it in Todo saying which lane should take it.

## Brief completely

Each agent reads only what you send it, and each lane starts in a new conversation (coordinate-agents, A new lane). The rules themselves (where to work, what a submission needs, who merges, when a card is Done) are Combwork's: each card's start, each reply and each refusal say them, so a brief doesn't repeat them. With workflow rules off nothing refuses, and the agents' own skills (card-loop) carry the steps. A builder's brief, to adapt:

```
Use card-loop as the builder. Lane "<name>": cards, in order, AM-12, AM-15. Your reviewer is R1.
Follow-ups go to Todo as new cards.
```

Then what this lane needs and the rules can't know: test homes or other safety rules, risky areas, overlaps with other lanes, and the project's own conventions agents can't know otherwise. Write them in now: anything you add later reaches a busy agent only as a message (`cw_message_agent`). A reviewer's brief is coordinate-agents' (A new lane), with what to look at closely on risky cards.

- Give rounds and a wait only when the user did; otherwise the lane takes the project's workflow options (Card loops).
- Explain the goal and the handoffs, give a sensible default and leave room for judgement: ask agents to say when they do something else, and why.
- Start the lane yourself with `cw_lane` `start`, so the user sees it at once, with the builder's brief in its `brief` (coordinate-agents, A new lane): Combwork gives it with each of its cards, where a prompt alone is lost to the slot's new conversation.
