# Scenarios: do agents use Combwork's skills and keep its rules?

Combwork tells agents little up front (its session contract) and leaves its workflows to skills they load when needed
(#102). These scenarios check that this works. Given what a user would say, does the agent or the Assistant:

- read the right skill;
- make the right Combwork tool calls;
- leave the board, notes and files as they should be?

They check what happened, never the wording of a reply.

Each scenario (`scenarios.cjs`) sets up a throwaway workspace: cards, handovers, notes, a second project, or a deleted
or edited skill. It starts the project's agent **Coder** or the **Combwork Assistant** through Combwork's dev build with the
scenario's prompt, waits for its turn to end (and for any agent the Assistant started), and reads only evidence of what
ran:

- **Combwork tool calls** come from the Combwork MCP server itself. In development builds it logs each call it ran, with
  whether it worked, to the file named by `CW_TEST_MCP_LOG`. Tool names in a transcript, or in a Codex script that
  may never have run, are kept apart as *mentions* and are never counted as calls.
- **Codex's calls in code mode** (HI-2235, HI-2246): Codex runs its tools from a script (its `exec` tool), which Combwork's
  transcript shows as one tool, `Script`. Codex's rollout records each call a script made as it ends (MCP calls, commands,
  file changes, images viewed) with its arguments and result, and Combwork's parser gives each script those calls (`calls`,
  HI-2240), in the script it started in. The harness reads them from the transcript (a script with a call cut short for
  display read whole, `transcript:tool`) and puts them in the script's place, named as Combwork names the same call made
  directly (`combwork · <tool>`, `Shell`, `Edit`, `view_image`): the checks read what Codex called and got back, as for the
  other CLIs, and a call written in a script that never ran isn't one (`codexScripts.cjs`). A script whose calls aren't
  known (its Codex records none: no `calls`) is no evidence
  of any: neither its code nor what it printed counts, and the run notes it as unobservable (`NOTE unobservable`,
  `observed.codeMode.unknown`). The fake Codex works in code mode in the scenarios too (`fake-code-mode.txt` in its home).
- **The merge slot** comes from Combwork's own record: development builds write each change to the slots (who holds one,
  told so or not, and who waits in line) and each claim or release as Combwork resolved it (the branch, and what it did:
  held or in line; released, left the line or nothing), with its time, to the file named by `CW_TEST_MERGE_SLOT_LOG`.
  The merge scenarios (#374) set that beside the checks' own runs (check.js records each run's start, with the commit,
  the base, any merge in progress and the tree it checked, and its end with the result) and the merge's moment (a reference-transaction hook
  in the scenario's repository times each branch update to the millisecond). They check that the agent's claim of the
  base's slot held; it held the slot from before the checks that went in (the run that checked exactly the tree the merge
  committed) until they ended passing, and through the
  merge after them; it waited in line behind another holder; and its own release of the base's slot ended that hold
  after the merge, or after its checks ended failing. A hold that ended otherwise (its session's end, the user), a
  release resolved to another branch, or a time that can't be placed doesn't count.
- **Skills read**: a Skill call for the skill that didn't fail, or a read (not a write) of its `SKILL.md` whose result
  is that skill's own text (its `name:` line). Writing to the path, echoing it, or a failed read doesn't count.
- **The board, shared notes and files** afterwards, through the Agent API and `git status`.
- **Whether any Agent API token** (the workspace's, an agent's, or the Assistant's) shows up in a tool's output or a
  reply, checked against the actual token values.
- **Usage and cost** (`session:usage`), the CLI's version, and provenance: the running Combwork's guidance and skill
  revisions (`/v1/status`), and the source commit with a fingerprint of uncommitted changes.

The checks are positive and negative:
- **Working on a card**: through Doing to Review, never to Passed or Done.
- **A card in Done** needing more work goes back through Doing to Review.
- **A reviewer** marks the card and keeps it in Review with its implementer, changes no files, and doesn't finish a
  card that went back to Doing under it. **A review that passes** moves the card to Passed with its verdict, not to
  Done.
- **Done means merged**: the builder moves its Passed card to Done once its branch is merged.
- **Card decisions** (#357): a decision the user records while the agent works on the card is flagged in its next board reply, and the agent reads the card again before moving it to Review; a reviewer fails work that ignores one of the card's decisions, also when woken for round 2 with a decision recorded since round 1 (its first reply flags it, and it reads the card in full before its verdict). An agent that asks the user and ends its turn is told of the decision recorded for it (#401), also when it asked about a card in Todo, which it takes first (#438).
- **Merging when the base moved** after the checks (another branch merged meanwhile): the agent merges the base into
  its branch again and reruns the checks on that combination before merging (the fakes do it with real git commands).
  The merge scenarios' checks (`check.js`) record each run in the project's `check-runs.txt` wherever it runs (HI-2233):
  in the project, a worktree, a clone or a plain scratch copy of the files, with the tree it checked and the folder, so a
  run in a scratch copy counts for what it checked; a check acted out another way (its test copied into `node -e`) is no
  run. merge-checks-fail's fakes run them in a plain copy.
- **Handovers**: the latest handover's next step, or the named one's, is done, and the other isn't. A wrap-up writes a
  handover without re-running tests.
- **Notes**: a lasting rule goes to a shared note, while progress goes on the card.
- **A plan** starts nothing.
- **Tagging cards** (#1131): a label added to several cards keeps each card's own labels (`addLabels`, never `labels`),
  in one `cw_update_tasks` call.
- **A script against the API** runs with the agent's own token, lists its project's card, is refused for another
  project's, and never prints a token.
- **Ordinary coding** reads no Combwork skill.
- **No git worktree of its own** (#476, #482): asked to keep the folder as it is while it tries a change (not asked
  for a worktree), the agent makes none on its own initiative and leaves the folder as it was (Combwork sets its folder; an
  agent with its own worktree is the user's to add, and a worktree the user asks for is theirs).
- **Stop what you start** (#613): asked to watch a card's minute-long run for failures as it goes, the agent leaves
  nothing running once the card is in Review. A scenario with `leftovers: true` has the harness stop the session after
  its turn and read what Combwork then lists as left running (`session:leftovers` once settled, #507): the processes its
  launch started and left.
- **Scratch outside the project** (#509): a reviewer asked for a probe script and a log of its output leaves the
  project as it was, makes no `.codex` folder in it and adds nothing beside it.
- **Card loops**: at the round limit (two real failed reviews in a lane of 2 rounds) Combwork has asked the user and
  paused the lane: the builder says it waits for them, and sends no round three, bypasses nothing and answers nothing
  itself (HI-2560). A finding that comes back is another round: the builder
  fixes it without asking, and the reviewer fails it marked as recurring. A finding the builder disputes stops the reviewer
  to ask. A builder fixing a failed card brings it back into Review for round two (also without it leaving Review), so the
  waiting reviewer is woken. A builder woken by one card passing while the other failed at the same moment acts on the
  failed one too. A builder starting a loop registers its lane (the cards in order, its reviewer, rounds and wait) before
  its first card's review; a reviewer joins its builder's lane by name, starting none of its own (#483).
  A builder at the lane's end whose commit needs the user's OK (a hook refuses it until they allow it) asks the user on
  the card (`cw_cannot_within_rules`, under For you), bypasses nothing, and once allowed commits and moves the cards to
  Done (#869, HI-2222).
  A reviewer whose card its builder blocks while it waits (to ask the user) keeps watching it rather than moving on, and
  reviews it when Combwork wakes it once the card is unblocked and back in Review (#481).
  A reviewer woken by Combwork's own loop wake, with no watch of its own, reviews the card and waits for the next (#405).
  A builder told no rounds or wait gets the workspace's Card loop settings for its lane and its wait; one told its own keeps them (#412).
  The Assistant at Look and advise lists the running lanes when asked, and changes none (#500). A builder whose card's decision needs what only the Assistant may do (park another card, move its own to Done) asks it with `cw_ask_assistant`, not in a comment, and doesn't ask the user again (HI-1866).
- **The intents and their gates** (1.0): an agent starts, puts back, submits, reviews and gives verdicts with the intent
  tools (`cw_start_card`, `cw_submit`, `cw_start_review`, `cw_verdict`…). **work-on-card** runs in a project
  whose work an agent reviews and requires them: started, committed, submitted, stopping in Review. Most other
  scenarios' projects have every rule off (a new project's options before a preset). There a submission goes past
  Review, since nothing reviews the work, so a builder's check takes either: the card in Review, or past it by the
  agent's own submission, and never finished by a move of its own (`handedOn`). A reviewer's check takes where its
  verdict leaves the card (`verdictLeft`): a fail back with its builder in Doing, a pass in Passed, or Done where nothing
  comes after review. The `old-move-*` scenarios test Combwork translating the old moves.
- **The fakes act as the shipped guidance does** (#1536): their scripts use the intents (`fakeStart`, `fakeSubmit`,
  `fakeStartReview`, `fakeVerdict`, `cw_report_merge`), so a passing fake run shows the checks take what a model
  following the skills does. A fixture whose card a failed verdict would have sent back is in Doing, and one whose
  loop has a reviewer runs in a reviewed project. The old moves left in the fakes, each for a reason:
  - **old-move-submit** and **old-move-review**: they test the translation.
  - **done-card-more-work**: `cw_update_task` with `column: "doing"` is what work-on-card says for a card back from
    Passed or Done.
  - **assistant-override-***, **assistant-bulk-move**: the Assistant moves cards with `cw_update_task(s)` and an
    override reason.
  - **prioritise**: an order within Todo, not a move between stages.
- **A gate's refusal and its next step** (#1536):
  - **intent-submit-refused**: a submission of uncommitted work is refused, saying in git's words that nothing is
    committed (HI-1618: submitting for review never commits). Asked only to submit, not to do the card, the builder asks
    the user before committing, as the refusal's next step says (HI-2257: an agent doing the card commits, one asked
    only to submit asks first), committing nothing, overriding nothing and moving nothing by hand; the card stays in
    Doing.
  - **intent-submit-commit**: asked to commit and submit for review, the builder does both with no question.
  - **review-interrupted**: a review started with the intent loses its card to its builder, so the verdict is refused.
    The reviewer doesn't retry it and moves nothing.
- **Under the presets** (#1536), saved as the Workflow section saves them: a solo user's card goes from start to Done
  under Solo (started, committed, submitted: committed is done, with no review), and a pair's builder registers its
  lane and starts its card in the slot Combwork lends it under Pair, submitting from there.
- **With `work-on-card` deleted**, the board rules still hold, and **an edited skill** is the one followed.
- **The Assistant**:
  - at Look and advise, changes nothing;
  - at Control agents, starts a card (which worked), waits for it, and the card gets done;
  - with full control, plans as cards without starting them.
  - in Coordinator mode with a team (#402): reads run-lanes, starts each lane with `cw_lane start` (its builder,
    reviewer and cards, the builder's card-loop brief in `brief`; HI-2222), its reviewer briefed by Combwork's start of it or
    a prompt, and ends its turn with one live watch on every lane's last card (scored on the watch it
    ends with, which replaces any before it, and on any move of those cards); woken by a failed review or an agent's
    question, it reads the card, sweeps the board, watches every lane again (not only the card that woke it) and leaves
    the fix (or the answer) to the loop (or the user); moves a card between running lanes; places a follow-up in the lane
    that owns its files; and follows two lanes through Combwork's real wakes as each ends, re-watching what is left, until
    both have ended (the fake Claude Code acts out the Assistant's wakes from its `fake-wakes-Assistant.txt`);
  - in Coordinator mode, the defaults Combwork's setup decides (#1346 items 2–4, #1527), asking the user none of them: a
    builder and reviewer pair's one card runs as a lane; a card reaching Review outside a lane gets its idle reviewer
    started; a running lane is watched with `lanes` and none of its cards; a second failed review in a ten-round lane is
    left to the loop; a lane whose cards have all passed, its builder merging them, is left to merge (it never asks
    whether to merge, and merges, moves or ends nothing itself); and a no-code card that passed (its lane ended) is
    neither moved nor its lane ended again;
  - in Coordinator mode, looking before asking (#1346 items 1 and 5, #1528): a card whose deploy details are in a doc
    it names is looked up and started without asking the user; asked whether a card should wait for another lane, it
    reads the board and the lanes first and changes nothing;
  - in every mode (#325, #402): cards it plans are complete (80+ characters each), an open design question reaches the
    user, and one card on one agent loads no run-lanes and starts no lane.

## Running

```bash
npm run scenarios                             # the fake Claude Code: free, deterministic (a failure fails the run)
npm run scenarios -- --provider fake-codex    # the fake Codex: the same, through Combwork's Codex adapter
npm run scenarios -- --provider fake-copilot  # the real Copilot CLI offline against a scripted model: the same, at no cost
npm run scenarios -- --save-baseline fake-main                                  # keep this run's benchmark as a baseline
npm run scenarios -- --provider codex --repeat 3 --budget 2                     # a model trial, 3 samples a scenario
npm run scenarios -- --provider claude-code --model haiku --budget 2            # model trials: opt-in
npm run scenarios -- --provider codex --model gpt-5.6-luna --budget 2           # Codex, in its test home
npm run scenarios -- --only work-on-card,review-card --keep                     # some scenarios, keeping their folders
npm run scenarios -- --dialect "Opus 5.5 v2.json" --provider claude-code --model opus --repeat 2   # a dialect's trial
node tests/scenarios/measure.cjs              # what sessions are given about Combwork, measured from real launches
```

**A dialect** (HI-2439; plans/2026-11-03-dialects-design.md, section 6): `--dialect <file>` puts a dialect file in the
model slot of every agent of the provider's CLI, as a test copy in each scenario workspace's `.combwork/dialects/<CLI>/`.
The file is checked against the schema first, as Combwork checks one (`src/main/dialects/format.ts`): one that isn't a
dialect stops the run; outdated overrides are listed and fall through. `results.json` (its `meta` and each result) and
`summary.md` record the chain's files and hash, and the benchmark's label names it, so Performance → Compare tells a
dialect's run from the Default's. Without `--dialect` the shipped files run, all empty: the Default, which releases
test. Combwork applies the file to sessions once dialects are wired into them (card 6b, HI-2065); until then a run records
the chain it gives. A change to a shipped file goes in only with model trials for its model against that model's
baseline (`--repeat 2` at least).

The scenarios run the dev build in `out/`. A run first checks it is built from the source as it is now (the e2e
runner's build stamp, `tests/e2e/build.mjs`) and rebuilds it if not, so a run or a baseline never measures other code.
Combwork's test copies run quiet (`src/main/testQuiet.ts`): no window on screen, no focus taken, no notifications.
After each scenario, once Combwork has closed, the harness stops what of it still runs (a command an agent started can
outlive its session: #542): what the scenario's Combwork started (its process tree, taken before it closes, each by pid and
start time), what Combwork lists as its agents' leftovers once their sessions have stopped (their launches' jobs hold what
they started, so a command whose parent has exited and that names no folder is among them: HI-2217), and what names the scenario's folder on its command line (the folder itself, never a sibling whose name
starts the same) and started after the scenario did (`tests/e2e/folderProcesses.cjs`; the result's `leftOver` says how
many). A folder it still can't remove is kept and named in the result (`kept`) rather than ending the run. Setup helpers
that start an agent for the fixture (a builder working, an agent idle) fail the scenario (`setup: …`, with the
environment problem when the screen shows one) when it doesn't get there, rather than run on a fixture it didn't get.
So does a setup's move of a card as the user moves it (`userMove`): its reply is checked, and the card must be seen in
the column (in Review, with a new submission) before the scenario goes on (#1583). So does the scenario's own prompt
never taken (HI-1168): typed as Combwork types (`lib.sendPrompt`, on real Claude Code once its Combwork tools connected) and
not taken nor refused for the environment, the trial is `setup: the prompt was never taken`, with no checks (incomplete
in the benchmark), never every check failed as the model's. Setups change the project's workflow
options through Combwork (`workflow:setOptions`, under the project's lock), never by writing `project.json` beside it (a
write that lost the agents just added, #1588), and make an agent's watch with its own token (`POST /v1/tasks/wait`), as
its Combwork tool does, so a model trial gets the same fixture as a fake (#1545).

- **The fakes** (`fake`, the default, `fake-codex` and `fake-copilot`) act each scenario out with their scripted commands (`skill NAME`, `boardmove`,
  `boardreview`, `boardcomment`). It checks the harness itself and the board rules Combwork enforces, at no cost. Checks
  only a model's own work can meet are skipped there (listed as SKIP). `fake-copilot` is the real Copilot CLI, offline,
  in a home of the run's own: a scripted stand-in model (`tests/e2e/fake-copilot-api.cjs`) turns the same commands into
  Copilot's own tool calls (its skill tool, the Combwork MCP server's tools), so its hooks, skills and transcript are
  Copilot's. It needs the Copilot CLI installed (the run is skipped without it) and no sign-in.
- **Model trials** cost tokens, and run only in the providers' **test homes**: never the user's own `~/.claude` or
  `~/.codex`, and never a copy of their credentials (refreshing a copy could sign the user out).
  - **Claude Code** uses `%LOCALAPPDATA%\hive-test\claude` (`CW_TEST_CLAUDE_HOME` overrides it). Sign in to it once, by
    hand, with the account the trials may use:
    ```powershell
    New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\hive-test\claude" | Out-Null; $env:CLAUDE_CONFIG_DIR="$env:LOCALAPPDATA\hive-test\claude"; claude
    ```
    Then `/login` in it. It runs in Accept edits, with `mcp__combwork`, `Bash`, `PowerShell`, `Skill` and `Monitor` (a
    shell command whose output it follows, #613) allowed on the command line, so it never asks and never needs bypass
    mode.
  - **Codex** uses its test home (`%LOCALAPPDATA%\hive-test\codex`, signed in once as tests/e2e/README.md says), in
    Full access.
  - **Without a sign-in**, a trial prints `SKIP all scenarios: … isn't signed in to its test home` and does nothing. It
    never opens a login.
  - **Stopped by the environment** (#302): a sign-in that has expired since (the credentials file is still there),
    a usage or rate limit, an overloaded API or the network. When Combwork shows the session waiting for a sign-in, or the
    CLI's own notes say one of these (matched with the e2e runner's list, `environmentProblem` in tests/e2e/lib.cjs;
    never the prompt or the model's replies), the trial ends at once as `SKIP environment: <why>`: no check is failed,
    no cost is assumed, and the provider's other trials are skipped with one line saying what to do (sign in to the test
    home by hand, or run them again later). results.json and summary.md say "skipped: environment: …", and
    benchmark.json has the sample as incomplete, so Performance → Compare counts no sample for it. To check this
    without a model: `npm run scenarios -- --only work-on-card --signed-out` (the fake Claude Code acts out an expired
    sign-in; fakes only). A CLI that exits before its session starts (an OAuth session it couldn't refresh: "Failed to
    authenticate: OAuth session expired and could not be refreshed", exit 1) is matched by its last screen, the reason
    Combwork logs, or, for Claude Code, its own `auth status --json` in the test home; anything else ends the trial at once
    as `ERROR the session ended at launch: …`, not after the trial's limits (#577). `--signed-out=launch` acts it out.
    A prompt the CLI never takes is checked again (#1321): what it drew once the prompt was typed (Claude Code can show
    "Not logged in · Run /login" only then; not what the prompt itself names) or, for Claude Code, its `auth status
    --json` saying it isn't logged in skips the trial for the environment, rather than running the checks on an untouched
    board. `--signed-out=late` acts it out.
  - Each scenario is one session of the chosen model, 6 minutes at most. `--budget` (USD, API-equivalent, above 0,
    default 2) stops the run once the scenarios so far cost that much. A trial that reports no cost makes the spend
    unknown, so no further trial starts unless `--allow-unknown-cost` is given; the summary then says the total is
    unknown (the reported subtotal plus the unpriced trials), never $0.
    The usual reason is a model Combwork has no price for (a Codex trial's cost is Combwork's estimate): the guard names the
    model; add its published price to `SHIPPED_PRICES` (`src/shared/prices.ts`) or pass `--model` with a priced one.
  - Models vary from run to run: a trial reports, it doesn't fail the run.
- **Several runs at once** (from different worktrees, or the same one) don't touch each other: each run claims a
  **lane** from the e2e runner's pool (`tests/e2e/lanes.mjs`), and its scenarios' profiles and workspaces go in
  `%LOCALAPPDATA%\hive-test\scenarios\lanes\<k>\<scenario>-<provider>` (where `--keep` leaves them), with the lane's
  first port as the test Combwork's Agent API port. The run prints its lane when it starts. Ten runs at once (scenario and
  e2e runs together) is the most: an eleventh waits for a lane, saying who holds them (#707; `--no-wait` fails at
  once instead), and builds once it has one, so it tests the source as it is then (#735). A run of more than five
  scenarios, or with
  `--repeat`, is a heavy run: it waits for one of the machine's test slots, as heavy e2e runs do, saying who holds them
  (`--no-wait` fails at once instead; tests/e2e/README.md, "Heavy runs queue").
- **Results** go to `%LOCALAPPDATA%\hive-test\scenarios\results\<time>-<provider>`: `results.json` (each scenario's
  checks, skills read, executed Combwork calls and mentions, the final reply whole up to 6,000 characters, so a check that
  judged it can be audited (HI-2230; `finalReplyLength` when longer), versions, guidance and source, usage) and `summary.md` (a
  table). `results.json` is written as each trial ends (`meta.incomplete` says how many of how many until the run
  has ended), so a run cut short keeps what it had. A run holds its folder while it runs (`runner.json`, its process):
  no other run's start prunes it, however many start meanwhile (HI-2234), and should the folder go all the same, the
  run makes it again with everything it had written, says so, and carries on. `BASELINE.md` here records the latest baseline. Run the trials
  again after changing Combwork's guidance, a skill or a tool's description, and compare.
- **Progress** (#1457): run in a Combwork agent's session, a run shows in that Combwork's Progress panel with a step per trial,
  named with the results so far (`review-card · 11 ok, 1 failed`), and an estimate from the trials timed before (by
  provider); under `cw-progress` it gives the wrapper's row those steps. `--no-progress` or `CW_PROGRESS=0` turns
  it off.

Bump `FIXTURES_VERSION` in `scenarios.cjs` when a scenario's setup or checks change.

## Benchmarks: before and after a change

Each run also writes `benchmark.json` (schema `combwork-benchmark/1`, `benchmark.cjs`): for every scenario and sample, whether
it passed its checks and what Combwork's own parts cost in it. Combwork's performance metrics are read before the launch and after
the turn (`GET /v1/metrics` of the run's own workspace), and the difference is the scenario's:
- **Context Combwork gave the session**: launch guidance in parts (core, project, the Assistant's role and mode, the skills' catalog), the
  Combwork tools' list, and every tool reply (characters and UTF-8 bytes, exact; never tokens).
- **Work**: tool calls (detail ones too), calls the Combwork MCP server ran, repeated identical calls, failures, Agent API
  requests and bytes (the harness's own reads are left out), time.
- **Skills**: delivered skills' bytes (what was available, not what a model read), skills not delivered, and the skill
  service's scans, misses and bytes read.
- **The provider's usage** of the session (a new one, so its total is the scenario's), compared only when every sample on
  both sides reported it. A fake's tokens mean nothing; a cost is compared only when both sides have one.

**The subject apart from the other agents** (HI-2186): a scenario's measures are every agent's in its workspace together
(the session under test, a lane's builder and reviewer, agents it or Combwork started), and each sample also has them for
the subject (`measures.subject`: the Assistant, or the agent the scenario tests) and the others (`measures.others`), each
measured on its own, and each agent's Combwork calls in the measured window (`measures.agents`, by its fixture name):
- The Assistant as subject: Combwork's metrics by caller role (the Assistant's, project agents'), every measure, only when
  the coverage is whole (else `split: 'partial'` and neither part).
- An agent as subject: its tool calls, replies and tool lists from the Combwork MCP servers' test log (`CW_TEST_MCP_LOG`: each
  call with its reply's size, and a `kind: 'list'` line per server's tool list); its API and launch measures are unknown
  (Combwork's metrics don't say which agent a request or launch was).
- Which calls the window holds is told call by call, not by counting: each call and list line has an id, and the
  server logs a `kind: 'reported'` line with the ids each metrics report carried, when it was sent and when Combwork had
  taken it. The harness times each metrics snapshot's request; a call is the window's when its report was sent after
  the first snapshot's answer and taken before the last was asked for. A report that overlapped a snapshot, a call with
  no report on record, or a log without ids (before HI-2186) leaves the log's parts and rows out (`split: 'partial'`);
  so does a window whose counts still differ from the metrics' (Combwork's own start-view record left out).

**The fakes count per Combwork call.** The fake Claude Code and fake Codex (not fake-copilot: the real Copilot CLI) start a Combwork MCP server for every Combwork call (and
each lists the tools), where a real CLI starts one a session: with them, tool-list starts and API requests count calls,
not sessions. HI-2181 read a lane scenario's doubled tool-list starts as twice the fetches per session; it was the lane's
agents making more calls.

Compare two runs in Combwork: **Performance → Compare → Import…** each `benchmark.json` (in the Performance view, with the
whole workspace selected: a benchmark is its test workspace's, never a project's or the own work's). Each sample keeps
every check (passed, failed, skipped), the measurement's coverage, and the guidance and skill revisions the session was
given, and its **observations**: what a scenario records without checking it (`observe`, #1611: whether the skill that
owns a workflow was read, where the behaviour is what's checked), in `results.json` and the sample, never a pass or a
failure. Scenarios are judged **correctness first**, check by check:
- *Smaller, still correct*: less Combwork context; every check that passed still passes and still runs; no more calls,
  failures (failed calls, tool errors, API failures, cancellations) or retries.
- *Smaller but failing*: less context but a check passed or ran less often. A cut that breaks a workflow isn't an
  improvement.
- *Larger or worse*, *No change* (within 1%), *Incomplete* (no completed sample, all checks skipped, or not fully
  measured: recording off, measurements dropped, a part missing), and scenarios only one side ran.
- What wasn't measured is **unknown**, never zero: a total exists only when every part it adds up is known.

Two runs are **comparable** only with the same fixtures version, provider, fake or model (and, for a model, the same model,
effort and mode), and neither's source changed while it ran. Otherwise the page says why and the numbers are only shown.
A fake's token usage is simulated and never compared. A stale launch (the session got other
guidance than the run started with) and incomplete samples are left out, and said. With one sample a side there is no
spread to judge a change by: use `--repeat N` for model trials.

- **Fakes** prove routing, delivery, sizes and failure handling: deterministic, free. Their board steps and
  `cw TOOL {json}` go through the real Combwork MCP server (`tests/e2e/fake-bridge.cjs`), except the fake Claude Code's
  board moves, which call the Agent API directly (its e2e suites read their answers). So the fake Codex's runs measure
  tool replies for board work and the fake Claude Code's don't. Compare like with like.
- **Model trials** are opt-in, cost tokens, and only report (models vary). They record the model, effort, mode, CLI
  version and that they ran in the provider's test home.
- **Controlled pairs** (fixtures v5): **list-compact** and **list-detail** ask for the same three cards, the compact list
  against the explicit detail form, with the same required correctness (every card listed; detail also has each
  acceptance line), so their reply sizes compare. **skill-unchanged** and **skill-changed** do the same work, the second
  with a skill edited inside the measured window (`beforeLaunch`, after the first metrics read): the skill service's
  hits, misses and changes show the cache's work, and the session must get the edited revision.
- **Baselines**: `--save-baseline NAME` copies the run's `benchmark.json` to `scenarios/baselines/NAME.json`: the new
  one is read first and swapped in atomically, and an existing baseline of that name is archived as
  `NAME.<its time>.json` (`-2`, `-3`… if that name is taken), never overwritten; the 5 newest archives are kept. Each run
  gets a results folder of its own; the newest 30 fake runs (`fake`, `fake-codex`, `fake-copilot`) and, counted apart,
  the newest 30 model trials are kept (HI-2236: fake runs never push a paid trial's results out), besides those a card
  cites and those a run still writes into. Nothing is invented for a run that wasn't recorded.
- `tests/fixtures/benchmarks` holds a baseline from a real fake run, an intentional reduction of it and the same
  reduction that broke `card-detail`. `tests/benchmark.test.ts` checks that the first is "smaller, still correct" and the
  second "smaller but failing".
- **Overhead**: the two metrics reads cost a few milliseconds a scenario (`metricsOverheadMs` in the artifact); the
  collector's own cost is in docs/ARCHITECTURE.md.
