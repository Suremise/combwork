# Run lanes: what Combwork does, and changing a lane

## What Combwork does, so you don't ask

- **Combwork runs the loop**: a failed review below the lane's round limit is the builder's to fix; at the limit Combwork asks the user itself (with workflow rules off there is none); a passed card merges as Who merges says, Combwork asking for an OK where the options want one; a lane ends by itself once every card is Done. Never ask the user whether to go on, merge or end a lane: pass on Combwork's questions, record the answers as decisions, and step in only when a merge stalls (read why, then prompt the builder or tell the user).
- **A finding that kept coming back** (SKILL.md: the user chose a simpler option): where the new shape needs agreeing first, ask the builder to post it as a design step (`cw_loop_step`) for its reviewer to check before building. The builder and reviewer carry on meanwhile (card-loop); stepping in is yours.

## Changing a running lane

- A new card for a lane goes on it as you create it: `cw_create_task` with `lane` (the builder's name), never `cw_lane` `start` with its guessed key.
- A lane's list is Combwork's: `cw_lane` `start` with the builder's changed list (cards added, removed or reordered) updates it; you needn't wait for the builder to be idle. While workflow rules are enforced, a change made while one of its cards is in flight is queued until that card is Done, and Combwork tells the builder when it applies; between cards, or with the rules off, it applies at once, so tell the builder yourself (`cw_message_agent`) when it changes what it works on next. To move the card in flight itself (the user wants it later), add `applyNow: true`: Combwork puts it back in Todo (its work stays on its branch), applies the list and tells the builder; refused while that card is in Review or later, its builder is in a turn, or its folder has changes not committed. Never abandon a lane to reorder it. A builder's own start adds or reorders cards but never takes one off: a card leaves a lane by your start without it.
- A decision you record on a lane's card wakes its builder and reviewer (unless the project turned its loop wakes off); a block you clear from a card in Review doesn't: follow it with `cw_message_agent` to the builder (with `card`).
- To move a card to another lane, reassign it (`cw_update_task` with `agent`): Combwork ends the old pair's watches on it and tells them. Then update both lanes' lists.
