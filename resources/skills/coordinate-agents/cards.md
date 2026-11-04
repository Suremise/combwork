# Coordinate agents: plan as cards

## Plan as cards

The task board is the shared list of work. For work that needs more than one step or agent:

- Create cards (`cw_create_task`) with a project and a description complete enough to start from cold: what to do, where, and what done looks like. A card with no code to merge (a decision, a write-up, a trial) is made `kind: "no-code"`: it finishes with no merge, through its review where the project has one, else as it is submitted.
- With lanes running, a card whose files a lane owns (a follow-up, say) goes on that lane as you make it (`lane`: its builder); asked to put it where it belongs, that is the OK.
- Set `blockedBy` for what must land first (where the project's rules say so, Combwork refuses to start a card before them), and put the column in priority order (`cw_reorder_tasks`).
- Bulk moves (a whole column moved, a set of cards given a label or an agent): one `cw_update_tasks` call for up to 100 cards, not a call per card. Each card is changed as `cw_update_task` would change it, and one it can't change is left as it was.
- When the user decides something about a card (scope, wording, a default, an option), it goes on the card as a decision (SKILL.md, After acting): agents check their work against a card's decisions. As well as telling its agent, Combwork in a loop wakes its builder and, while the card is in Review or Passed, its reviewer, unless the project turned its loop wakes off (its workflow option Wake reviewers and builders); then follow it with `cw_message_agent` (with `card`). A block you clear from a card in Review wakes neither side of its loop: tell its builder the same way. Older cards may have decisions in comments; move those of open cards into decisions only when the user asks.
- A card without a project is about the workspace: somewhere to plan before the work has a project. Only a card with a project can be started on an agent. Use the planning tools Combwork gives you; don't assume ones it doesn't list.
- Agents sharing a folder must not edit the same files: split the work by files. Where the project builds cards in slots (its Version Control tab), Combwork lends each card's builder a slot of its own as the card starts; no agent has a worktree of its own. The split-work skill helps plan the split.


- **"Move AM-12 to Doing"**: what the user said is their choice: "have Claude start this" is a start (`cw_start_task`), and "assign it to Claude" an assignment only (`agent`).
