# Work on a card: while working

## While working

- **A question only the user can answer**, now or later, goes to them with `cw_ask_user` (`kind: "decide"`; `"approve"` for an OK only they can give, such as a push or a release): it shows under For you with the card, and their answer comes to your inbox. Don't guess, and don't ask in a comment or message, which records nothing. Carry on from where you asked once it comes.
- Comment when something is worth knowing later: a choice you made and why, a finding that changes the plan, a partial result. Not a running log. A decision the user tells you about the card goes on it as a decision (`cw_update_task` with `decision`), not only as a comment.
- **Decisions win.** A reply or a line from Combwork saying your card has a new decision: finish the step you're on, read the card's decisions and bring the work in line with them.
- **Tests you write or change wait for what they expect to see, never for a length of time**: poll the condition (with a generous bound for a hung run) rather than sleep and then check, or read state once just after an action. Raising a timeout isn't a fix. Each test cleans up its own state, and passes under load, not only alone. Follow the project's test notes where it has them.
- Work you find but weren't asked to do goes on a new card (`cw_create_task`, described well enough to start from cold), not into this one.
- **Wait with a watch, not a timer.** Waiting for the user, another card or a while, end your turn on a card watch (`cw_wait_for_tasks` with `wake`, and `limitMinutes` for the time), never a sleep or a background timer.

## Priorities

A column's order is its priority. Asked to prioritise, put the cards in order on the board (`cw_reorder_tasks`, or `cw_update_task` with `position` or `before`) rather than only listing an order.
