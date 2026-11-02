# Run lanes: what Hive does, and changing a lane

## What Hive does, so you don't ask

- **Hive runs the loop**: a failed review below the lane's round limit is the builder's to fix; at the limit Hive asks the user itself (with workflow rules off there is none); a passed card merges as Who merges says, Hive asking for an OK where the options want one; a lane ends by itself once every card is Done. Never ask the user whether to go on, merge or end a lane: pass on Hive's questions, record the answers as decisions, and step in only when a merge stalls (read why, then prompt the builder or tell the user).
- **A finding that kept coming back** (SKILL.md: the user chose a simpler option): where the new shape needs agreeing first, ask the builder to post it as a design step (`hive_loop_step`) for its reviewer to check before building. The builder and reviewer carry on meanwhile (card-loop); stepping in is yours.

## Changing a running lane

- A new card for a lane goes on it as you create it: `hive_create_task` with `lane` (the builder's name), never `hive_lane` `start` with its guessed key.
- A lane's list is Hive's: `hive_lane` `start` with the builder's changed list (cards added, removed or reordered) updates it; you needn't wait for the builder to be idle. While workflow rules are enforced, a change made while one of its cards is in flight is queued until that card is Done, and Hive tells the builder when it applies; between cards, or with the rules off, it applies at once, so tell the builder yourself (`hive_message_agent`) when it changes what it works on next. To move the card in flight itself (the user wants it later), add `applyNow: true`: Hive puts it back in Todo (its work stays on its branch), applies the list and tells the builder; refused while that card is in Review or later, its builder is in a turn, or its folder has changes not committed. Never abandon a lane to reorder it. A builder's own start adds or reorders cards but never takes one off: a card leaves a lane by your start without it.
- A decision you record on a lane's card wakes its builder and reviewer (unless the project turned its loop wakes off); a block you clear from a card in Review doesn't: follow it with `hive_message_agent` to the builder (with `card`).
- To move a card to another lane, reassign it (`hive_update_task` with `agent`): Hive ends the old pair's watches on it and tells them. Then update both lanes' lists.
