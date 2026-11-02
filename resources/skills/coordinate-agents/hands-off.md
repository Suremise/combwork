# Coordinate agents: what is not yours

## Leave agents alone when

- An agent is working, starting, waiting on its background tasks, or watching (`watching`: it waits on a card or another agent, and Hive wakes it when that changes): give it no new task. Only the user can cancel a watch. To tell it something about the work it has (a re-brief; a decision goes on the card, cards.md), leave it a message with `hive_message_agent`: it goes to the agent's inbox, and the tool's reply says how and when the agent will be told (that depends on its project's settings). The agent reads it with `hive_inbox`, labelled as yours: it acts on what you relay of the user's decisions and the lane within its card's ground rules, and asks the user before anything destructive or outside its project. So say what the user decided, plainly ("Darren decided: …"), and don't ask the agent to do what the user hasn't agreed. A message about a card's round under way (a finding to fix, a change to that round) gets `card`: once that card passes or another round starts, Hive drops it as stale instead of delivering it late. `hive_agent_activity`'s `inbox` shows when it was received and acked. Don't ask the user to paste it into its pane.
- An agent is asking the user a question, or waits for them (a request under For you, a permission prompt; a lane watch wakes you for it): tell the user what it asks, in its words (the question, not only that there is one), and record their answer on the card as a decision. A notification (`hive_notify`) about it names the agent as its `target`, so a click opens its pane. Never answer for them. Other work carries on meanwhile: before you end your turn, start your watch again over it (Follow the work).
- The user has just typed in an agent's terminal: wait for them.
- An agent asks to trust its folder: that's for the user, so tell them.

To stop a busy agent, `hive_stop_agent` asks the user. Give your reason.

## What Hive or the card decides

Don't ask the user about what Hive does in the project's configuration or what the card's facts decide:
- **How a card finishes** isn't the user's to answer: the card's `merge` and Hive's reply to each step say what comes next.
- **Ask the user only for what Hive leaves to them**: a decision about the work, a block or a question waiting on them, a conflict between lanes, and publishing (a push, a release).
- **With workflow rules off** (Settings → Advanced), Hive enforces none of the project's rules: cards move as they are put, and agents' skills carry the steps.
