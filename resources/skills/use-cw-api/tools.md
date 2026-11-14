# The Combwork tools in detail

Each Combwork tool's description says what it does and the rule a caller can't guess. This file holds the rest: cases, defaults, event lists and mechanics. Read the section you need; don't read it all. Do routine work with the tools themselves, never by calling the HTTP API instead.

**Sections:** [Inbox](#inbox) · [Card watches](#card-watches-cw_wait_for_tasks) · [Agent watches](#agent-watches-cw_wait_for_agents) · [Agent activity](#agent-activity-cw_agent_activity) · [Messages to agents](#messages-to-agents-cw_message_agent) · [Reading a card](#reading-a-card-cw_read_task) · [Changing cards](#changing-cards-cw_update_task) · [Adding cards](#adding-cards-cw_create_task) · [Submitting and reviewing](#submitting-and-reviewing) · [Card loop steps](#card-loop-steps-cw_loop_step) · [Lanes](#lanes-cw_lane) · [Merge slot](#merge-slot-cw_merge_slot) · [Merge queue](#merge-queue-cw_queue) · [Release Slot](#release-slot-cw_release_slot) · [Pausing the team](#pausing-the-team-cw_team) · [Templates](#templates-cw_template) · [Agents' settings](#agents-settings) · [Documents](#documents-cw_doc_outline-and-cw_read_section) · [Undo](#undo-cw_undo) · [Journal](#journal) · [Developer console](#developer-console-cw_console)

## Inbox

`cw_inbox` lists what is new, oldest first, each with its id, who it is from and its card; a card's events come as one item. Listing marks them received, not acked.

- Ack a message, task, handover or decision once you have read and acted on it (`ack`: its ids, as listed). One not read yet isn't acked. Card events need no ack.
- Three forms: no `ack` reads; `ack` alone acks and lists nothing; `ack` with `read=true` acks, then reads in the same call, for when more came in while you acted (what it lists then is received, not acked).
- Ack the ids you acted on in your next `cw_inbox` call, not in a call of their own.
- Not acked 30 minutes after it was made, an item shows as overdue to the user and the Assistant.

## Card watches (`cw_wait_for_tasks`)

- **What counts:** a column move, a new comment, a review verdict or a new agent; `changes` narrows it. Counting a verdict, a move or a comment also counts a reviewer's request to the builder and a decision of the user's.
- **column:** alone, it waits only until a card is in that column (at once if it already is; nothing else counts). With `changes` including `column`: until one moves into it, or another change listed. Either way a card already there answers at once. `fresh=true` (with `column`) waits for the next move into it: a card there must leave and come back, or be returned for review.
- **wake=true:** Combwork types one line into your session when a card changes, naming every watched card that changed, or after `limitMinutes` (default 120) with none. The Assistant also hears the user's prompt to a watched card's agent or reviewer from its pane, with its first line. A watch started after a wake also counts what others changed since that wake. End your turn after starting it: nothing runs, and no other work is given to you, meanwhile. It is your one watch: an agent watch replaces it, and it replaces one. `cancel=true` ends it.
- **Without wake:** it waits in the call up to `timeoutSeconds` (default 300, at most 840) and replies with each change (column, by whom, the latest comment's first line) or no change, with `since`: pass it to the next wait so nothing between them is missed.
- A project agent watches its own project's cards only.
- **Lane watch (`lanes`, with wake):** lane ids from `cw_lane list`, or `["all"]` for every running lane (a project agent: its project's), started later too. Each lane's cards are followed as it goes on, with no card limit, and it wakes you only for its events:
  - by default: `failed` (a failed review), `blocked`, `unblocked`, `reblocked` (a blocked card's reason changed, or its builder commented on it), `stalled`, `merge-due` (every card passed), a merge that stalls with its builder idle, `ended` (with its merge commit), `abandoned`, `waiting` (an agent starting to wait for the user), and always `paused-user` (a question for the user on a lane's card);
  - add `passed`, `moved` or `paused-merge` (a lane waiting for a merge) to count those.
  - One line names each lane, card and agent. The Assistant also hears the user's prompt to a lane's agent from its pane, as a line of its own; the watch goes on.
  - With `lanes`, `cards` are cards outside the lanes followed in the same watch (changes default: comment, column, verdict; a card becoming blocked counts too), and `agents` are followed as `cw_wait_for_agents` does, each until a wake tells it. Left out, your last lane watch's cards and agents are kept; `[]` drops them.
  - **For a lane, pass `lanes` only:** adding its cards wakes you on every move.

## Agent watches (`cw_wait_for_agents`)

- Waits until agents stop working: finished, idle, waiting for the user or stopped. Without `agents`, every busy agent in the workspace.
- Background tasks an agent started (status `background`) count as working unless `ignoreBackground=true`; an agent watching cards (`watching`) doesn't.
- `wake=true`: replies at once, then Combwork types one line into your session when one finishes its turn, waits for the user or stops, with the start of its reply (the Assistant also hears the user's prompt to one from its pane), or after `limitMinutes` (default 120). Agents not working now are the reply instead. End your turn after it. It is your one watch: a card watch replaces it. `cancel=true` ends it.
- Without wake it waits in the call up to `timeoutSeconds` (default 50, at most 600) and replies with each one's status and whether it timed out: call again to keep waiting.

## Agent activity (`cw_agent_activity`)

The reply is JSON with named fields, among them:
- `model` and `effort` it runs with (as its CLI reports them, else as launched; `default`: its CLI's own); `retryWaits` (this launch's waits for its CLI to retry a throttled or failed request: count, seconds, latest);
- its `folder` (a slot, the project folder or a retired home) and `launchFolder` (where a new conversation would start, when that differs), branch, background tasks;
- `transcriptMB` and `transcriptWarnMB` (past it, it slows down: suggest a handover to a new conversation);
- the start of the task it was last given and of its latest reply, and its last tool calls this turn (`toolCalls`: how many);
- `safeguard`: its CLI's safety classifier stopped a response or switched its model (when, the model, the tool calls before it; "not detected" for a CLI Combwork can't tell);
- locked files, how long ago the user typed in its terminal;
- `inbox`: what was left for it (unread, overdue, its latest deliveries with their states: queued, offered, received, acked, cancelled, refused, expired, stale).

Texts are clipped: the task to 300 characters, the reply to 500, the last 3 tool calls at 100 each; `detail=true` raises that to 2000, 3000 and the last 10 calls at 200 each, and 20 deliveries. `clipped` gives a cut text's whole length. Combwork gives no more of a conversation than that: for the rest, the card's comments or the agent itself.

## Messages to agents (`cw_message_agent`)

- For an agent that can't take a prompt now: watching (a card loop), working, waiting on background tasks or for the user, or where the user just typed. It goes to the agent's inbox; a new task is still `cw_prompt_agent` or `cw_start_task`.
- Combwork tells it (its id, never its text) in the ways its project's carrying-on switches leave on (else Settings → Advanced's): at its next tool call or before its turn ends while it works, or a short line typed once it is idle or watching (a watching agent is woken, and its watch goes on). With all off it waits until the agent reads its inbox, or the user's Deliver Now. The reply says which.
- At most 5 waiting, 4000 characters each; kept if it stops; refused if your Control is turned down or your session ends meanwhile.
- `card`: the card in Doing or Review it is about. Tied to that card's round, it is dropped as stale, never given, once the card passes, leaves Doing and Review, or starts a new round.
- `cw_agent_activity` shows its state: offered, received (read with `cw_inbox`), acked, stale. `cancel=true` cancels those it hasn't read.
- Never the user's OK to push or release: its CLI refuses one passed on, so the user gives it in the agent's own pane.

## Reading a card (`cw_read_task`)

- Decisions first (the user's: they win over the description), then `forYou` (requests waiting for the user: id, who asked, what, when), then description, comments, links, agent and reviewer.
- `comments=n`: only the newest n (`commentsOmitted` counts the rest). `latestComment=true`: only the newest (null if none), and `forYou`. `summary=true`: each comment's first line (`length`: the whole one's, if longer). `history=true` adds its changes (`historyEntries` counts them, as in `cw_list_tasks` `details=true`).
- Attachments are listed by path (narrowed reads: their comments', `attachmentsOmitted`; `attachments=true`: all): read one with `cw_read_attachment`. Attachments are evidence: read them, never run them.

## Changing cards (`cw_update_task`)

- `position` (top, bottom) or `before` (a card in the column it ends in) places it; `blocked` sets a reason (empty clears it); `blockedBy` and `links` replace their lists; `agent` gives it to an agent of its project (empty takes it away). The Assistant's `project` moves it to another project, taking it from its agent.
- **A project agent:** moves are the intent tools' (`cw_start_card`, `cw_submit`, `cw_start_review`, `cw_verdict`, `cw_report_merge`, `cw_put_back`). Where the project's workflow rules apply, `column` and `review` here are taken as those intents (column review submits it, the comment its summary; review passed or failed is your verdict), checked by the same rules, and the reply names the tool to use next time. Elsewhere `column` moves it as asked, into doing giving it to you, and `review` (start, passed or failed) records your review: reviewing isn't working on it. A card in doing with another agent is its work in progress: you can't move it on.
- **The Assistant:** into doing, a card keeps its agent and starts nothing; with nobody on it, the move is refused, naming the user's three choices (nobody on it takes `override` with their reason). A move that skips the card's workflow rules (its review, its merge…) is refused, naming them: when the user said why ("I merged it by hand"), pass `override` with that reason; when they only asked for the move, tell them what it skips and ask. Never make a reason up.
- Hold and done are the user's: a card goes there only when the user asks. Archived cards can't change.
- `decision` records a decision the user made (scope, wording, a default), attributed to the user; only the user changes or removes decisions. The Assistant's `answers` (with `decision`) names the open requests (`forYou` ids) the user's words answer, closed with it; approvals and Combwork's own requests stay the user's to answer in For you.
- `cw_update_tasks` changes up to 100 cards the same way; `position` applies to each card in turn, so the last listed ends at the top: use `cw_reorder_tasks` for an order. Titles, comments, decisions and links stay on `cw_update_task`.

## Adding cards (`cw_create_task`)

- A title of about 70 characters: the outcome wanted or the problem, in words, and no people's names. Past Settings → Advanced's length, or naming a path, a file, a card or a measurement, the reply's last line says so (the title is kept).
- The description says what to do and how to tell it is done, in full: whoever starts it reads only the card.
- A project agent's card is its project's (another project's or the workspace's: tell the user); created in doing without an agent, it is given to you. The Assistant's card without a project is about the workspace and can't be started on an agent.
- `kind: no-code`: work with no commits (a decision, a write-up, a trial), finished by its summary; an agent's proposal of it, and of `skipReview`, waits for the user to confirm.
- `context`: doc sections to read first, by file and heading slug as `cw_doc_outline` lists them ("docs/PLAN.md#setup", "shared:plans/notes.md#open-questions"), never line numbers. It replaces the card's list (`cw_update_task` too); `[]` clears it.
- `attachments`: at most 10 files and 100 MB, each copied in (the same file once), and linked at the end of its description; with `cw_update_task`, in its comment, or at the end of its description without one.
- `lane`: puts it on a lane as it is made, never by a guessed key: a builder's name (last on its running lane), or `{ builder, reviewer, … }` to start one if none.
- `target` (also `cw_update_task`, `cw_lane`): a lane's is fixed once it starts; a card's changes only while its branch has no work of its own.

## Submitting and reviewing

- `cw_submit` hands a card's committed work to review (a code card in Git needs its work committed; submitting never commits) and it moves on, to Review or past it where there is no review. As a lane's builder, Combwork then watches it for you. Its reply warns of files outside its paths and other agents' changes in a shared folder. `tests`: focused tests its merge runs beyond those its picker chooses (or all, when it can't choose): each a test id, or `{ id, needs }` (needs: unit, fake, real, packaged).
- `cw_start_review`: you review it; the reply names the revision, base, files, review copy and `checksAtRevision` (checks recorded there).
- `cw_verdict`: a pass moves it on once its reviews are in; a fail sends it back to Doing, a round counted. `accept` (a pass): `runYourself` tests proved by another's run there.
- `cw_ask_user` and `cw_cannot_within_rules` count no round and are no stall.

## Card loop steps (`cw_loop_step`)

- Builder: `design` (posted for the reviewer to check, the card in Doing; the reply gives its id and `until`, when the check is due); `proceed` (no answer by then: building as posted; refused before); `followUp` (a follow-up asked of reviewed work, such as a screenshot change, ready for the reviewer's check, the card in Review or Passed; no proceed).
- Reviewer: `ok` or `gaps` (what is missing), naming the design.
- Refused with no reviewer to check it.

## Lanes (`cw_lane`)

- `start` (the builder; the Assistant names `project`, `builder`, and `reviewer` or `pool=true`): `cards` in order, `rounds`, `waitMinutes` (left out: the project's Card loops options), `name`, `brief`.
- `brief` is kept with the lane and given with each of its cards: never prompt it separately. Left out, a running lane keeps its own; `''` clears it.
- `start` again on the builder's running lane with any of these cards updates it: while one of its cards is in flight the new list is queued until that card is Done, and its builder is told. `applyNow=true` applies it at once, putting that card back to Todo when it isn't first.
- `join` (the reviewer): `builder`, and `cards` if it hasn't started one. `next`: your next card to start or carry on, or why the lane waits.
- A lane ends by itself once every card is Done. Abandoning one is the user's: the Assistant ends it with `end`, `lane` and `abandoned=true`.
- `list`: running and lately ended lanes, a line each; the Assistant's `all=true` gives every one kept.

## Merge slot (`cw_merge_slot`)

One merge at a time into a branch (default: the project folder's). `claim` waits up to `timeoutSeconds` (default 240, at most 290): you hold it, or have your place in line (claim again to keep it). Claiming again extends the 60-minute hold, and your session ending releases it. `release` gives it up or leaves the line (with no branch: yours). `cards`: what you merge.

## Merge queue (`cw_queue`)

- `list` (`target` narrows to one queue): the card testing now and its step, the cards waiting in order, the latest outcomes (merged, returned and why, cancelled), and whether it is paused, why and by whom.
- The Assistant's `pause`: the queue stops before its next card; one being checked finishes its checks and waits, unmerged. `resume`: it runs again; while what paused it is still there (a target checked out, the rules off), it stays paused and says so.
- `remove` (`card`, `reason`): out of the queue, back to Approved, never merged, its builder woken; refused once its merge has begun. `retry`: queues a card the queue returned (its approved revision, unchanged) once more. `resolve`: a returned forward ends unmerged, and a linked card has a builder merge it by hand. Each takes the user's reason, recorded with the override.
- `retarget`, once Work merges into moved on: `from` (the finished target) and `target` (the new one) preview the Todo cards and free slots that can follow; with the user's OK, `preview` and `items` move them.
- At Look and advise, only `list` works.

## Release Slot (`cw_release_slot`)

- `list`: each carried slot (kept for an agent: its 0.9 worktree) and each held writer (an ended run whose processes Combwork doesn't know have ended: its run, whether its Combwork is this one or gone, the processes it lists).
- `release` (`slot`, and `kind` when it is both): a carried slot stops being kept for its agent (its folder and branch stay).
- A held writer needs the user's agreement first: show them the slot, run and processes, and once they agree pass `confirm` `{slot, run}` as `list` gave them. `end=true` ends the listed processes first (left running, they may still write in the slot).
- Refused while that run is still live in this Combwork, while another Combwork holding it still runs, or when the slot changed since `list` (look again). Not undoable.

## Pausing the team (`cw_team`)

- `status`: whether your workspace's team is paused, whether it is parked (safe to install), and what still runs, a row each (an agent working, a run, a process beyond its CLI's own; "can't be checked" is never parked). Another open workspace is one line, with none of its agents.
- The Assistant's `pause` (Control agents): no lane starts a card, no card events, watch wakes or pool reviews are sent, the merge queue takes no new card, and each running agent is told once to park. `resume` lifts it; what it held is offered again if still due.
- Your own workspace only: the user's Pause the Team covers every open window. Tell the user when `status` says it is safe to install; installing is theirs (Install Now).

## Templates (`cw_template`)

- `list`: those the project can use.
- `plan`: what loading one would do, changing nothing: who it removes and creates, names another project's agent has (each with a free one), what stops it, and the workflow options it would set.
- `load`: replaces every agent of the project with the template's and sets its workflow options for the project's version control (`workflow: false` leaves them). Refused while an agent runs, and when its workflow needs Git the project hasn't (setting up Git is the user's). `cw_undo` puts the agents, layout and options back.
- `names`: new names by place ("1") or name; names are unique across the workspace.
- `connections`: `*`, a role, or an agent's place or name → a connection (`plan` lists them). `apply`: existing agents' only.
- Only when the user asked for it.

## Agents' settings

`cw_add_agent`, `cw_update_agent`, `cw_start_task`: its connection sets model, effort, context, mode, CLI; `provider`, `model`, `effort`, `mode`, `context200k` refused.
- `connection`: id or name (`cw_connection`). Default or empty: the first usable here.
- `workflowRole`: builder, reviewer, either (never its own cards), generalist (no lanes or reviews) or independent (no cards, wakes or typing). Default: from its name. Its Combwork tools follow it: a running agent restarts to load them (asked first when busy). A lane part only takes a role that does it. Made Independent on a lane or holding a card: `confirm`, the refusal's fingerprint, once the user agreed.
- `mcpServers`: `[]` none, `["*"]` all (default); combwork always.
- A running agent takes a change when restarted; another CLI's connection only while stopped. A connection gone or off here: its CLI's first usable one runs it.
- `cw_start_agent`: a folder new to its CLI asks the user to trust it.

## Connections (`cw_connection`)

- A named setup (model, effort, context, mode, arguments) on an account (the user's alone).
- `list`: id, account, CLI, values.
- `add` on an existing `account`; `update` a `connection` (`""`: the CLI's own). Need Change settings and the user's OK; not undoable.
- `launch` (`update`): an object, such as `{ "tools": false, "overrides": { … } }`, `{ "preset": "terminal" }` (all off) or `{}` (all on). `tools: false` makes its agents Independent; where that takes one off a lane or a card, `confirm` as for `cw_update_agent`.

## Documents (`cw_doc_outline` and `cw_read_section`)

- `path`: a file of your project, relative to the folder you work in, or a shared note as `shared:<path>`. `from: "project"` reads the project folder's copy instead. `depth` (outline): headings down to that level.
- `heading`: `#` and a slug from the outline (two "Setup" headings are `#setup` and `#setup-1`), or the heading's text (several: it lists their slugs). An unknown heading replies with the closest ones; none reads the whole document.
- A section over 30,000 characters comes as its text before its subsections and their outline; `full=true` gives all of it.

## Undo (`cw_undo`)

- `list`: your messages' changes, a line each; with `group`, its changes and their ids. Then `change` (an id) or `group` (a message's id, or `latest`: your newest with a change left to undo).
- Each field goes back to what it was unless someone changed it since (left as it is, and said). A card you made is archived, a lane you started abandoned, an agent you started stopped (its work stays). Prompts, messages and comments can't be undone.

## Journal

- `cw_journal_write`: `kind` is decision, plan, event, incident, insight, preference, moment or digest (a summary of others; `digestOf` names the period, e.g. 2026-W42). `importance`: 0 trivia, 1 everyday (default), 2 important, 3 essential (2 and 3 outlive retention and the size cap). `links`: card, commit, note, artifact, session, agent, project or entry. A kind outside the user's scope is refused, saying which are allowed.
- `cw_journal_recall`: a line an entry (id, date, kind, project, summary), newest first, or best first for a `query` (words in summaries, details and whys; importance and recency count too). Narrow with `since`/`until` (a date or ISO time), `kinds`, `project`, `link` (`{ type, ref }`), `tag`. Superseded entries are left out unless `superseded=true`. `limit`: default 10, at most 50. `cw_journal_entry` reads one in full.
- `cw_journal_update`: `supersededBy` (a newer entry's id; null: current again). `delete=true` deletes it with its links and tags; entries it superseded are current again.

## Developer console (`cw_console`)

- What a CLI sent Combwork (hooks, status lines, transcript records, terminal markers, lines Combwork typed, its launch and exit, its Combwork tool calls), each next to what Combwork made of it, redacted (no prompt or reply text, commands, tokens or sign-in details).
- The Assistant reads any agent of its workspace (`agent`, `project`), its own session (`source=assistant`) and Combwork's own events (`source=combwork`: Agent API calls, merge slots, watches, Progress, refused hooks). An agent reads its own session.
- Combwork captures only while the user has the console open on a source; reading starts nothing, and the reply says when nothing is captured.
- `read` (default): a line per event, the newest 30 the first time, then `since` carries on; `kinds` narrows them; `seq` gives up to 3 events in full. `sources` lists what you can read, whether it is captured and the arguments that read it (50 a page, `offset` for more).
