---
name: run-lanes
description: "Run a team as the Hive Assistant: builder and reviewer lanes on card loops, planned by files, briefed and watched to their end. Use when there are three or more agents or several builder and reviewer pairs, when asked for lanes, or woken about one."
metadata:
  audience: assistant
---

# Run lanes

A team works through cards in **lanes**: each a builder taking cards in order in a card loop (card-loop, the agents' skill), reviewed by its own reviewer or by the project's reviewer pool. coordinate-agents covers the tools; this is how to run a team well. With one or two agents, coordinate-agents is enough: a single builder and reviewer pair runs its cards as one lane, as it says.

## Watch to the end

Nothing wakes you but the user and a watch you started, so never leave lanes on "they'll tell you". The loop runs itself; you handle what it can't: a question for the user, a finding that keeps coming back, a lane that stops.

- **One lane watch covers the whole team.** `hive_wait_for_tasks` with `lanes: ["all"]`, `wake: true`, `limitMinutes: 360`, and no `cards` of the lanes: it follows every running lane, lanes started later and cards added to a lane too, and wakes you only for what needs you: a failed review, a card blocked or stalled, a lane whose cards have all passed (its merge is due) or whose merge then stalls, a lane ended or abandoned, an agent starting to wait for the user, and always a question for the user on a lane's card (`paused-user`). A lane's cards added as `cards` would wake you on every move of them. Add `events` (`passed`, `moved`, `paused-merge` for a lane waiting on a merge) only to follow more. You have one watch at a time: a card you follow outside the lanes (a release, a one-off fix) goes in the same watch as `cards` (`cards: [720]`), an agent's work on no card as `agents`; the next lane watch keeps both until you pass them again (`[]` for none).
- **Check the reply says it is waiting** before you end your turn. If it doesn't, start it again once; if it still doesn't, tell the user.
- On each wake: `hive_inbox` lists what changed in each lane; read the cards it names (`hive_read_task` with `latestComment` and `summary: true`: reports and verdicts lead with a one-line summary; read a comment in full only when you act on its detail), then sweep the board: new follow-ups, stalled cards, a card waiting for the user, an agent idle while its card waits (check it with `hive_agent_activity`; prompt it once it is idle), and a duplicate, an unrecorded answer or an out-of-date blocked reason (board-hygiene). Then start the lane watch again, and tell the user in a line or two. Once every lane has ended, say so; there is nothing left to watch.
- An agent asking the user something, or woken because one waits for the user: pass the question on (coordinate-agents, Leave agents alone), never answer it for them, and start the lane watch again before you end your turn: the other lanes carry on while the user decides.
- **A finding that keeps coming back**: when the reviewer marks a finding recurring, or the rounds keep turning up new edge cases of one mechanism, the loop isn't converging: that is your judgement, not a count of failures. Bring the user a simpler option with your recommendation (the simple version now, the rest on a new card), and record their choice as a decision on the card (it wakes the lane): changing-lanes.md.

## Reference files

Read one only when it applies. Each is in this skill's own folder, beside this SKILL.md, not your working folder:

- [starting.md](starting.md): planning lanes by files and briefing them, before you start one.
- [reviewers.md](reviewers.md): choosing a lane's reviewer, or the project reviews from a pool.
- [changing-lanes.md](changing-lanes.md): what Hive does (so you don't ask), the user's choice on a finding that kept coming back, or a running lane to change.
- [verify.md](verify.md): a lane says it is done, or an agent reports a result.
