# Run lanes: reviewers

## Reviewers: one per lane, or the pool

The project's Reviewers option decides:
- **One per lane**: each lane has a builder and its reviewer, both briefed. Where the project's work isn't reviewed by an agent (no review, or only the user's), a lane is its builder alone.
- **A shared pool**: a lane has no reviewer of its own. Combwork gives each submitted card to the next free reviewer of the pool, oldest submission first, and tells it; a card nobody is free for waits ("waiting for a reviewer"). A builder's design step goes to the pool the same way, and whoever checks it reviews the card next when free. Brief only the builder, and leave the pool's agents to Combwork: no reviewer briefs or starts per card. Start a pool lane with `cw_lane` `start` and `pool: true` instead of a reviewer: Combwork refuses it where the project's Reviewers option isn't a shared pool, or nobody but the builder reviews. The pool works only while workflow rules are enforced: with them off, nothing is given out, so each lane needs a reviewer of its own.
