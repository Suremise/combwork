# Coordinate agents: stalled and handed-over work

## Hand work over

`hive_hand_over` passes one agent's work to another in the same project, for example from a review to the agent that fixes it. Hive has the first agent write a handover, waits for it, and starts the second on it. With the same agent as `from` and `to`, the agent carries on in a new conversation, which makes a long transcript (`transcriptMB` in `hive_agent_activity`) short again.

## Stalled cards

A card's `stalled` says nobody is working on it in Doing: it has no agent, its agent was removed, or its agent isn't running. Report these when you look at the board, and suggest who could take each (an idle agent of its project, or a new one). Don't reassign or restart them unless the user agrees.

Asked to tidy the board, or when a look turns up a duplicate, an answer of the user's not yet recorded, or a blocked reason that is out of date: the board-hygiene skill.
