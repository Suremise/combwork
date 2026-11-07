---
name: card-loop
description: "Work through cards in turn as their builder or reviewer, waiting at no cost. Use when told to work through or review cards (one or several) as a builder or reviewer, or given rounds."
metadata:
  audience: agents
---

# Card loop

Two agents take the same cards in turn: the **builder** does each card, commits it and submits it for review; the **reviewer** reviews it and fails it with findings, or passes it. Waiting for the other side costs nothing: you end your turn and Combwork wakes you. Each step is a tool (work-on-card); Combwork checks the project's rules, and a refusal says what to do next.

**Read your role's file now:** [builder.md](builder.md) or [reviewer.md](reviewer.md), beside this SKILL.md in this skill's folder. It has how you register the lane, the watch you start and each step of yours.

## Inputs

From the request: your **role** and the **cards**, in order. Ask if unclear. Rounds and wait: the request's, else the project's workflow options (the lane's reply says them).

## The lane

Combwork keeps the loop as a **lane**, shown to the user. Register it as you start, with `cw_lane` (your role's file says how). The lane's list is Combwork's. `cw_lane` `next` names your next card, or why the lane waits (a card not merged yet, a question for the user): where the project's rules hold a lane to one card at a time, the next one can't start before the last is Done. Given a changed list, the builder sends it with `start` again: while a card is in flight Combwork queues it and tells you when it applies. The lane ends by itself once every card is Done; abandoning one is the user's. The lane is a record: if a call fails, carry on with the loop.

## Waiting

Wait with `cw_wait_for_tasks`, `wake: true`, `limitMinutes` the lane's wait. **After a submission or a failed verdict in your lane, Combwork watches the card for you**: the reply says so; end your turn. Where it says your own watch stays, or nothing of a watch, or you are woken with nothing to do yet, start it yourself, as your role's file says.

**End your turn only when your next step waits on someone else** (a verdict, an answer, the user, a card you need, the rest done), on a watch or loop wake ([waiting.md](waiting.md)), never polling: a comment or reply hands nothing over. A change asked in Review: `cw_submit` with `followUp: true` before you wait. **Start the watch before the step that lets the other side act** (a request, a design, a follow-up step, a reply asked for), so a quick answer isn't missed; your own step doesn't wake you. Then its reply: "Waiting for…" is live, so finish that step and **end your turn**, saying what you wait for; "Already: …" has happened, so carry on now. Combwork also wakes a loop's agents (a submission, a verdict, a request, a design): act on it as on your watch's wake.

**When woken**, `cw_inbox` first: it says what changed and what else came, each with its sender (work-on-card, Your inbox: act, then ack). Read only what you need: `cw_read_task` with `latestComment: true` (`summary: true` for first lines; in full to act on findings). Woken by several watched cards: check each one's column and verdict, and watch them all again in one watch.

## At the end

Report each card: its rounds, how it ended (Passed, Done once merged, waiting for the user), and any follow-up cards you created.

## Reference files

Read one only when it applies. Each is in this skill's own folder, beside this SKILL.md, not your working folder:

- [waiting.md](waiting.md): ending a turn with no watch (a loop wake), odd watch replies, no wake, another card, one that left your watch, a blocked one.
- [rounds.md](rounds.md): a card failing again, a finding back or disputed, the round limit, stopping to ask the user.
