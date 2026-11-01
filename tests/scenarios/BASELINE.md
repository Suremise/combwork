# Scenario baseline, 3 October 2026

**Fixtures v5** (`scenarios.cjs`), with evidence only of what ran:
- **Hive calls**: the hive MCP server's own log of executed calls. Transcript names count as mentions only.
- **Skill reads**: a successful read showing the skill.
- **Tokens**: the actual values are checked for in tool output and replies.

**Provenance**, recorded in each run's `results.json`:
- the source commit;
- a fingerprint of everything uncommitted (the diff and the contents of untracked files), taken when the run starts and
  checked again at its end;
- the running Hive's guidance and skill revisions before setup;
- what the session itself was given at launch (its guidance and delivered skills).

v3 adds checks that an edited skill was delivered as edited and a deleted one wasn't delivered.

**The latest runs**:
- **Fake Claude Code**: fixtures v5, all 26 pass (`results/2026-10-03T18-21-32-fake`, kept as the baseline
  `baselines/fake-claude.json`); guidance revision `63db94808e669a5e`.
- **Fake Codex**: fixtures v5, all 26 pass (`results/2026-10-03T18-28-52-fake-codex`, baseline
  `baselines/fake-codex.json`). Its board steps and tool calls go through the real hive MCP server, so its benchmark
  measures their replies.
- **Codex** (a model): fixtures v2 (below). No model trial has run under v5 yet; one would be its first benchmark.

v4 added **card-detail** and **oversize-skill**; v5 adds two controlled pairs: **list-compact** / **list-detail** (the same
three cards: 144 characters of compact list against 2,283 of explicit detail with the fake Codex, both correct) and
**skill-unchanged** / **skill-changed** (a skill edited inside the measured window: no misses against a miss and a
change, and the session gets the edited revision). Every run writes `benchmark.json` (README.md, Benchmarks); each sample
keeps its checks, coverage and the revisions its session was given.

**Repeatability** (fakes): v5 runs an hour apart compare as *No change* in every scenario both ran (Performance → Compare's
own rules), for each fake. A run whose source changed while it ran isn't comparable: a run during which only docs were
edited was refused, as it should be, and was run again without touching the tree. The fake Claude Code and the fake Codex
aren't compared with each other (different providers). The two metrics reads per scenario cost 476 ms in a 20-minute fake
Codex run.

Every scenario ran once per provider. Models vary from run to run, so a single result is a sample, not a rate.

## A known Codex habit (accepted for 1.0.0): Codex, fixtures v119–v120, 1 November 2026

**assistant-card-question**, Codex 0 of 2 before and after HI-2265's fixes (and 0 of 3 on df1676127, HI-2190); Haiku
2 of 2 both times. Asked "Coder has stopped… is that a Hive bug, or is it waiting?", Codex reads the card once with
`history: true`. That one reply already holds the question in forYou, and its answer is right, in one call. The check
"didn't read the card's history for it" (HI-1992) fails on that one argument; no guidance asks it not to pass it, and
HI-2265's nudge in `hive_read_task`'s description ("what waits is in forYou") didn't change it (HI-2267 takes that nudge
out again, to keep the tool descriptions within replysize's bound). The cost is one larger reply.

Darren accepted it for 1.0.0 as a known Codex habit (HI-2282, 1 Nov), with HI-2265's other residual (below, in the
Haiku gaps). No check loosened; it goes to the per-model dialects work after 1.0 (HI-2065).

Runs (`--repeat 2`, CLI 0.166.0), in `results/`: before `2026-11-01T07-54-48-codex` (fixtures v119, source
6b7c3c9e1), after `2026-11-01T08-22-24-codex` (v120, 3458f1f6e, guidance ebb0b9f39a70beb1); both samples fail only
that check (4/5).

## Known Haiku gaps (accepted for 1.0.0): Claude Code Haiku and Codex, fixtures v115, 1 November 2026

After HI-2261's fixes, these scenarios still miss on Haiku and pass (or, for one, also miss once) on Codex. Darren
accepted them for 1.0.0 as known Haiku gaps (HI-2279, 1 Nov): no Haiku-specific guidance now, and no check loosened.
They are the starting point of the per-model dialects work after 1.0 (HI-2065).

Both runs: `--repeat 2`, fixtures v115, source 46e7b89b8, guidance 026680618df5c3a1. Haiku (CLI 2.1.316):
`results/2026-11-01T06-01-13-claude-code`, 27 of 50. Codex (CLI 0.166.0): `results/2026-11-01T06-02-29-codex`, 49 of 50.

| Scenario | Haiku | Codex | Haiku's miss |
|---|---|---|---|
| assistant-agent-watch | 0 of 2 | 2 of 2 | read no skill (the coordinate-agents check); the behaviour was right |
| assistant-settings-suggest | 0 of 2 | 2 of 2 | read no skill (the tune-settings check); the behaviour was right |
| wrap-up | 0 of 2 | 2 of 2 | reran the tests it was told had passed, to write the handover |
| coordinator-recurring-finding | 0 of 2 | 2 of 2 | brought the user no simpler option with a recommendation |
| assistant-new-lane | 0 of 2 | 2 of 2 | used hive_start_task, not hive_lane start, for a lane with no reviewer |
| coordinator-one-card-lane | 0 of 2 | 2 of 2 | used hive_start_task after reading "hive_lane start instead" |
| inbox-destructive | 1 of 2 | 2 of 2 | didn't ask the user to approve the destructive request |
| inbox-ack-and-read | 1 of 2 | 1 of 2 | didn't ack the first item with the read of the second (Codex's one miss too, with a fourth hive_inbox call) |
| coordinator-fact-before-asking | 1 of 2 | 2 of 2 | asked without looking the card or its doc up first |
| coordinator-follow-up | 1 of 2 | 2 of 2 | put the follow-up card on no lane, not the lane that owns its file |
| decision-while-waiting (HI-2282) | 0 of 2 | 2 of 2 | s2: doing its own card, refused with "nothing committed", asked the user before committing ("I only commit when asked") |

- **The card's list said 1 of 2 for coordinator-one-card-lane;** the run's summary has both samples failing (1/4
  checks each), so it is recorded here as 0 of 2. **It said each passes on Codex;** inbox-ack-and-read is Codex's one
  miss in its 49 of 50, so it isn't Haiku-only.
- **decision-while-waiting is a later run, added by HI-2282** (Darren, 1 Nov, with the Codex habit above): HI-2265's
  after, `results/2026-11-01T08-22-24-claude-code` and `…-codex` (fixtures v120, source 3458f1f6e, guidance
  ebb0b9f39a70beb1, Haiku CLI 2.1.316). Haiku was 2 of 2 before (`2026-11-01T07-54-48-claude-code`, v119), so s2 is
  variance against HI-2257's rule (a builder doing the card commits; the refusal says so). s1 missed only "read the
  work-on-card skill", the same kind as the first two rows.
- **What these are, and aren't:** 2 samples a side, descriptive totals across fixtures and checks changed by HI-2261, not
  rates (HR1's note on HI-2279). Codex's before (38 of 40 run, 10 skipped for budget) is HI-2261's.

## A builder told of its unsubmitted commits (HI-2245): fakes, Claude Code Haiku, fixtures v112, 31 October 2026

HI-2228's card-loop-follow-up misses (below) read the rule, saw the asked change committed and the card in Review, and
took it as handed over. Hive's reply now says it as a fact: a builder's card watch on its own card in Review (and
`hive_lane next`'s "Carry on with…") whose folder has commits on its line past the submitted revision says "First hand
AL-1 over: AL-1's line has 1 commit since its submission (59f92a2); hive_submit with followUp: true, then end your
turn: …" in place of "End your turn now". No guidance, skill or tool description changed; no fixture bump.

| Haiku, `--repeat 5` (CLI 2.1.316) | before (HI-2228's after) | after |
|---|---|---|
| card-loop-follow-up | 2 of 5: `2026-10-31T17-20-28-claude-code`, head 9b4b56f0c with HI-2228's change uncommitted (fingerprint 93ec529ab027) | **5 of 5**: `2026-10-31T18-54-45-claude-code`, source 5d043adcd, guidance 8bcc3c142cad49aa, $0.041 |

- **Authorization:** the lane brief of lane-18c973 (from the Assistant, 31 Oct): "Darren already OK'd paid Haiku runs
  for this scenario's family on HI-2228. Run card-loop-follow-up Haiku `--repeat 5` once, after the fix (HI-2228's 2/5
  run is the before)". The before is HI-2228's run, not run again.
- **What the samples did:** three watched the card first and got the new reply (one each, its commit named), then
  submitted with `followUp: true`; two submitted without watching. 5 samples a side give no rates, and the before ran
  HI-2228's uncommitted change (the same guidance hash), so the difference is the reply's fact, as far as 5 samples show.
- **Fakes:** card-loop-follow-up passes (`2026-10-31T18-53-55-fake`).

## Haiku's regressions since the baselines (HI-2228): fakes, Claude Code Haiku, fixtures v107 (v112 once merged), 31 October 2026

HI-2190's Haiku ×3 trials on ac799cd25 (fixtures v101) passed four scenarios less often than their sections below
record. The 3-sample transcripts pointed at two changes since those baselines. A Haiku `--repeat 5` before and after
(Darren's OK, HI-2228/r8) measured them:
- **review-card**, **review-in-copy** (only the skill-read check failed; the review was right). Since HI-2046
  (30 Oct) Hive starts the reviewer itself, with the line from reviewerPool.ts, which spelled out the review's steps
  ("hive_read_task, then hive_start_review and hive_verdict"). The misses followed it and opened no skill; the
  baselines (v59, v78) began with "Review card #N.", which the contract routes to review-agent-work. The line now names
  the skill instead: "Review its latest submission with the review-agent-work skill" (the scenarios' copy of it too).
- **card-loop-follow-up**. HI-2011 (29 Oct) split card-loop into a contents page; builder.md's step 2 (`hive_submit`
  with `followUp: true` before the wait) was read, but SKILL.md, read first, said to start the watch before "a
  follow-up", whose reply says "End your turn now". The rule (the follow-up submitted first) now opens SKILL.md's
  Waiting, and "a follow-up" there is "a follow-up step" (`hive_loop_step`, a Passed card's); builder.md points to it.
- **assistant-decision-answers**. The split left "Hive tells the card's agent" only in coordinate-agents/cards.md,
  and hands-off.md offered "the user's answer" as something to message. Most misses read no skill at all and typed the
  answer into Coder (`hive_prompt_agent`, refused while it worked). The side effect is now stated where every sample
  looks, `decision` in hive_update_task's schema ("Hive normally tells the card's agent"; the Haiku samples below had "…tells the card's agent itself", shortened after them to the 120-character limit on a parameter's text). coordinate-agents
  SKILL.md (After acting) says a decision goes on the card and nothing more is sent; cards.md keeps the cases where it
  isn't enough (loop wakes off, a block cleared in Review, decisions in old comments); hands-off.md's example is a
  re-brief.

Each SKILL.md stays within 4,000 characters (card-loop 3,996, coordinate-agents 3,983).

| Haiku, `--repeat 5` (CLI 2.1.316) | before: `2026-10-31T16-53-19-claude-code`, $0.21 | after: `2026-10-31T17-20-28-claude-code`, $0.20 |
|---|---|---|
| review-card | 4 of 5 (the miss read no skill) | **5 of 5** |
| review-in-copy | 4 of 5 (the same) | **5 of 5** |
| pool-reviewer-wake | 5 of 5 | 5 of 5 |
| card-loop-follow-up | **0 of 5** (each watched, none submitted) | **2 of 5** |
| assistant-decision-answers | **1 of 5** (4 typed it into Coder, none of them reading a skill) | **5 of 5** |

Before: 9b4b56f0c, clean, baseline `hi2228-haiku-before`; after: the change uncommitted (fingerprint 93ec529ab027),
`hi2228-haiku-after`; the contract the same in both (8bcc3c142cad49aa), card-loop's revision 1289cc89 → 8166252c. A
first "after" run was stopped before it ended, with nothing saved, to cover the schema's final wording (HR2).
- **What this shows, and what it doesn't.** The before run confirms the regressions at 5 samples (0/5 against HI-1843's
  4/5, 1/5 against HI-1932's 5/5), and the transcripts show the mechanism in each miss. That each change caused its
  regression is what the transcripts support, not proven: the model or the CLI (2.1.312 then, 2.1.316 now) may also
  differ, and 5 samples a side give no rates. HI-2190's final-head trials measure them again.
- **Left:** card-loop-follow-up's three misses read the rule, saw the commit and the card in Review, and took it as
  handed over (one loaded hive_submit and didn't call it). A fact in Hive's reply that the card's folder has commits
  past its submission is HI-2245.
- **Fakes**: the seven scenarios (with card-loop-follow-up-check and assistant-decision-answers-one) pass before
  (`hi2228-before-a`, `hi2228-before-b`) and after (`hi2228-after-a`, `hi2228-after-b2`). The tool list a session gets
  grew 45 to 225 bytes (the `decision` line); delivered skills 76,108 → 76,064 bytes (agents), 76,090 → 76,104 (the
  Assistant).

## A decision that answers a card's open requests (HI-1932): fakes, Claude Code Haiku, fixtures v97, 28 October 2026

`hive_update_task` gains `answers` (the Assistant's only: the ids of the card's open requests the user's decision answers,
closed with it in one write), and `hive_read_task` lists a card's open requests for the user (`forYou`) with their ids.
Two new scenarios: **assistant-decision-answers** (the user's answer covers both of Coder's questions: both named) and
**assistant-decision-answers-one** (it covers only the first: only that one named).
- **Fakes**: the 144 scenarios both ran are the same before (`hi1932-before`, `results/2026-10-28T12-23-06-fake`, the
  tools as they were) and after (`hi1932-after`, `results/2026-10-28T14-01-55-fake`), but for assistant-agent-watch,
  which failed one check before the change and passes after (unrelated to it); the two new ones pass. The tool list a
  start is given grew 55 bytes on average (39,522 to 39,577).
- **Haiku** (CLI 2.1.312, `--repeat 5`, $0.083; `results/2026-10-28T14-57-53-claude-code`): **5 of 5** for both
  questions, **4 of 5** for one. The miss recorded the decision and named no request: the question stays open in For
  you, the safe side (nothing was closed that the answer doesn't cover).
- **Claude Code's default model** (`results/2026-10-28T15-04-45-claude-code`, $0.38): both pass.

## A follow-up in Review handed over before the wait (HI-1843): fakes, Claude Code Haiku, fixtures v96, 28 October 2026

HI-1832's Haiku trials of card-loop-follow-up passed 1 of 5, that one only through the plain submit's refusal. Their
transcripts (the Claude test home, 27 Oct) show the other four reading card-loop, finding the card in Review with the
commit made, and only starting a watch: committed and in Review was taken as handed over. card-loop's builder step 2
now says it as one step: a change asked of the card in Review is made (committed, for a code card in Git), then
`hive_submit` with `followUp: true` before the builder waits, as until then nothing is handed over. The follow-up paragraph
points to step 2 rather than restating it. Trimmed elsewhere to stay under the skill's 11,000 characters; the
always-present guidance is unchanged.
- **Fakes**: the 24 card-loop scenarios pass before (`hi1843-before`, `results/2026-10-28T11-40-00-fake`, the skill as
  it was) and after (`hi1843-after`, `results/2026-10-28T11-51-38-fake`); Performance → Compare's rules: 24 the same.
- **Haiku** (CLI 2.1.312, `--repeat 5`, $0.036; `results/2026-10-28T12-02-25-claude-code`): **4 of 5** (was 1 of 5). The
  fifth called `hive_submit` without `followUp`, was refused with the next step named ("submit it again with followUp:
  true"), and waited without taking it: the remaining limitation, in the refusal's handling rather than the skill's words.
- **Claude Code's default model** (`results/2026-10-28T12-06-18-claude-code`, $0.16): pass.

## Three checks that failed a model doing it right (HI-1950): the fake Claude Code, fixtures v96, 28 October 2026

HI-686's Claude Code trials (`results/2026-10-28T10-28-14-claude-code`, CLI 2.1.312, its default model) failed three
scenarios where the agent did the right thing; the fakes passed them, as they only do what the checks expect:
- **card-loop-lane**: the agent named its lane's cards by key (`["AL-1","AL-2"]`), the form the tools ask for (HI-1661),
  and the check compared numbers. `namesCards` and `namesCard` accept each card's number or key, in order: used there and
  in the other checks of an agent's own card lists (card-loop-uncommitted, card-loop-lane-defaults and -override,
  card-loop-lane-join, card-loop-already-in-review).
- **wrap-up**: the agent ran no tests, but the check matched `npm test` in its handover's own text. It now counts only
  test runs among the shell commands (`testRunsOf`), as the review scenarios do.
- **review-card**: the card was put in Review with `greet.js` in the initial commit, so its submission changed nothing and
  the reviewer rightly asked for a commit rather than giving a verdict. It now has a real submission (`submittedCard`
  with the card's own files, in a project that reviews: Pair, Implementer building, Coder reviewing).

The fake Claude Code passes all nine scenarios these changes touch (`results/2026-10-28T11-21-57-fake`, with
coordinator-start-reviewer, whose `submittedCard` now takes the files). Fifteen other setups still put a card straight in
Review with its work in the initial commit; none has failed a real run yet, and a scenario whose review needs a
submitted change should use `submittedCard`.

## Reading the owning skill, recorded (#1611): the three fakes, fixtures v91, 25 October 2026

Claude Code's #1537 trial relayed the user's answer to a watching reviewer correctly without reading coordinate-agents.
The Assistant's call: the scenario checks the behaviour. assistant-message-watching's "read the coordinate-agents
skill" is now an observation (`observe`: in `results.json` and each benchmark sample, never a pass or a failure); the
relay's checks are unchanged. The three fakes pass its four checks and record the read (`2026-10-25T16-52-41-fake`,
`2026-10-25T16-53-01-fake-codex`, `2026-10-25T16-53-28-fake-copilot`). The real rerun is #1539's final step.

## Ack with the next read (#1608): the three fakes, fixtures v90, 25 October 2026

Codex's #1537 trial acked two messages in a call of their own. `hive_inbox`'s description now says to ack the ids you've
acted on in your next hive_inbox call, not in a call of their own (the tool owns it; work-on-card doesn't repeat it).
The check is unchanged: inbox-ack-and-read passes on the three fakes (`2026-10-25T16-44-54-fake`,
`2026-10-25T16-45-34-fake-codex`, `2026-10-25T16-46-10-fake-copilot`). The real rerun is #1539's final step.

## A refusal's next step is the task's (#1609): the three fakes, fixtures v90, 25 October 2026

Claude Code's #1537 trial asked the user rather than commit when `hive_submit` was refused ("Commit the work, then
submit"). work-on-card now says a refusal's next step is part of the task, even one naming only the refused tool, taken
without asking unless it would discard or overwrite work or needs the user's decision. The scenario is unchanged:
intent-submit-refused passes on the three fakes (`2026-10-25T16-39-12-fake`, `2026-10-25T16-39-35-fake-codex`,
`2026-10-25T16-39-58-fake-copilot`). The real rerun is #1539's final step.

## A wake left by setup rings before the prompt (#1613): the three fakes, fixtures v90, 25 October 2026

card-loop-follow-up-check failed once on fake Copilot (#1537's v89 run): its only turn read the inbox. Setup posts the
builder's follow-up (or design) before the subject starts, so Hive's loop wake rings its doorbell as the session becomes
idle, just as the harness types the prompt; in every sample the doorbell's turn came first, with the prompt typed into
the busy session, and once the prompt was lost. Scenarios now have `beforePrompt`: these two wait until the wake is
read and its turn is over (idle, or watching once it has acted on the wake, as a model does). Fake Copilot, both ×8 with 2 spinner workers: 16 of 16
(`results/2026-10-25T16-04-10-fake-copilot`); fake Claude Code and fake Codex once each: all pass
(`2026-10-25T16-09-43-fake`, `2026-10-25T16-10-36-fake-codex`). Every fake now reads the wake before the prompt.

## P8's smoke trials (#1537): Claude Code and Codex, fixtures v86–v89, 25 October 2026

Darren's scope (24 Oct): each key scenario once on Claude Code and on Codex, with no `--repeat`, Haiku or Copilot. The
full trials come before the release (#1541). The 40 key scenarios: the intent tools, the inbox, lanes, #1346's five (with
the other #1346 items 2–4 scenarios), the fresh-workspace set (#1539's model evidence), merge-main-moved and
merged-to-done.
- **A clean context**, checked before the run (`hive-test\scratch\1537-trials-20261025-054351\clean-context-before.json`):
  no memory files in Claude Code's test home and no CLAUDE.md; Codex's has no AGENTS.md and empty memory tables; each
  scenario runs in a new workspace (no shared notes). Both homes hold skills that aren't Hive's: Claude Code's synced
  from the account, and Codex's system skills (imagegen, openai-docs, review-agent, skill-creator, skill-installer).
- **Codex** (CLI 0.164.0, its default model; `2026-10-25T05-45-03-codex`, $2.87): 36 of 40 at v86.
  - Two failures were the scenarios', fixed in v87:
    - **coordinator-lanes-to-end**: Codex calls hive tools from its code tool, so the harness didn't find its inbox
      read after the doorbell; `wakeLines` now takes a `Script` call of `hive_inbox`.
    - **coordinator-start-reviewer**: its card, set in Review with nothing committed, stayed in Doing under the
      project's rules, and Codex rightly said so. It now has a real submission. The harness's `card()` now fails setup
      for a card short of its column; a full fake run found no other.
    - Rerun at v87 (`2026-10-25T07-00-17-codex`, $0.32): those two and coordinator-ten-rounds (now back in Doing after
      its failed review) pass.
  - Two are guidance findings, carded:
    - **#1607**: a one-card lane's brief named no card-loop. coordinate-agents defines the brief without it; only
      run-lanes' template has it.
    - **#1608**: inbox messages acked together at the end, not with the next read. Act, then ack, held.
  - #1545: assistant-message-watching reached the Assistant with Coder really watching, and passed. #1162:
    merge-main-moved passed in its one sample.
- **Claude Code** (CLI 2.1.310, its default model). The first try skipped every scenario: the test home wasn't signed in
  (`2026-10-25T05-44-19-claude-code`, $0, no login opened). Darren signed it in by hand. Then
  `2026-10-25T09-42-15-claude-code` ($8.33): 32 of 40 at v87.
  - Five failures were the scenarios', fixed in v88–v89:
    - `asksTheUser` read "Nothing needs your decision" as a question (coordinator-start-reviewer, coordinator-merge-due).
    - coordinator-no-code-done's card title ended in "?", which the reply quoted. Its card was also never no-code: the
      API's kind on create is only an agent's proposal, so it is now set as the user sets it (`tasks:setKind`). Its
      research comment is there too.
    - inbox-destructive didn't count asking through `hive_ask_user`.
    - coordinator-ten-rounds' builder was stopped, so the loop had stalled and asking was fair. Its builder now works
      on the fix.
    - coordinator-merge-due's passed cards had no work anywhere. Their work is now on the lane's unmerged branch, and
      Coder's task says it is merging.
    - Rerun at v88–v89 (`2026-10-25T10-20-18-claude-code`, `10-25-08-claude-code`, $1.11): all five pass. Codex reran
      the three changed Assistant fixtures (`2026-10-25T10-25-46-codex`, $0.25): pass.
  - Three are guidance findings, carded:
    - **#1609**: refused with "commit, then submit", it asked the user rather than committing (intent-submit-refused).
      Whether the prompt narrowed the task is weighed there.
    - **#1610**: it merged without merge-ready: no slot, a `--no-commit` merge on the base (merge-main-moved; #1162's
      pattern).
    - **#1611**: it relayed the user's answer correctly without reading coordinate-agents (assistant-message-watching:
      only the skill check failed).
- **The run was interrupted** at about 11:57 (the connection to Anthropic dropped and Hive's agents stopped). Only the
  Copilot-offline baseline run was cut off. Its rerun (`2026-10-25T12-07-59-fake-copilot`) had 137 of 138:
  card-loop-follow-up-check only read its inbox. It passed 5 of 5 alone, so it's carded as a flake (#1613), and the set
  was run once more for a clean baseline.
- **Fake baselines at v89**, source ab349143: 138 of 138 on each fake (`2026-10-25T10-29-00-fake`,
  `2026-10-25T11-09-30-fake-codex`, `2026-10-25T12-54-26-fake-copilot`; the last with only this file's notes uncommitted),
  saved as the `p8-scenarios` baselines.
  The v87 baselines (`2026-10-25T07-04-36-fake`, `07-44-50-fake-codex`, `08-25-26-fake-copilot`) are archived beside them.

## P8's scenarios for the intents and gates (#1536): the three fakes, fixtures v86, 24–25 October 2026

The baseline for P8's trials (#1537) and the checks card (#1539), on the guidance that ships (lanes A–D merged, 1.0.0
6e9eeb47), saved as `p8-scenarios` (fake Claude Code), `p8-scenarios-fake-codex` and `p8-scenarios-fake-copilot`.
- **Before**, v82 (`p8-e-before`, `2026-10-24T17-38-41-fake`): all 134 pass on the fake Claude Code.
- **After**, v86, source a450ce5c, guidance `3ef4abb443998e00`: **138 of 138 pass on each fake**. Fake Claude Code
  `2026-10-25T03-34-16-fake` (CLI 2.1.999), fake Codex `2026-10-25T04-14-20-fake-codex` (0.160.0), Copilot offline
  `2026-10-25T04-55-02-fake-copilot` (1.0.98). Not comparable with v82 (another fixtures version).

What changed in v86 (review round 3, the root fix):
- **The fakes act as the shipped guidance does.** Every fake script uses the intents: `fakeStart`, `fakeSubmit` (the
  work committed, then `hive_submit`), `fakeStartReview`, `fakeVerdict` and `hive_report_merge`. The old moves stay only
  where they are meant:
  - `old-move-*`: the translation's tests;
  - done-card-more-work: work-on-card's own step for a card back from Done;
  - assistant-override-* and assistant-bulk-move: the Assistant's moves;
  - prioritise: an order within Todo.
  The full fake run was then the audit, and its failures were fixed in the fixtures.
- **Reviewers' checks** take where the verdict leaves the card (`verdictLeft`): a fail back with its builder in Doing (or
  in Review by the old move), a pass in Passed or past it, moved by nothing else of the reviewer's. This covers
  review-card, test-waits-review, review-against-decision, review-decision-next-round and card-loop-recurring-review.
  **review-passed** means "Passed, not Done", so its project has a reviewer agent and unchecked merges, where a pass
  stops in Passed, with a real submission.
- **Fixtures for the outcome they mean**:
  - a card back from a failed review is in Doing: fix-returned-card, card-loop-rounds, card-loop-recurring,
    card-loop-return, card-loop-two-cards;
  - a loop with a reviewer has its work reviewed, so the builder's watch has a verdict to wait for:
    card-loop-recurring, card-loop-return, card-loop-commit.

What changed in v85 (review round 2):
- **work-on-card** runs in a project whose work an agent reviews, and requires the intents: started with
  `hive_start_card`, committed, submitted with `hive_submit`, stopping in Review, never moved on by the agent itself.
- **Builders' checks on projects with every rule off** take what the intents do there (`handedOn`): the card in Review,
  or past it by the agent's own submission, since nothing reviews the work. They never take a finish by a move of the
  agent's own. Before, a model following the skills (submit, so Done) failed "ends in Review". This covers every
  builder scenario whose check named Review: the decision, inbox, skill, card-loop and dispatch scenarios.
  test-waits-write's fake now uses the intents, so the fakes cover the submission past Review. inbox-stale, whose
  premise is a reviewed card, runs in a reviewed project.
- **A gate's refusal and its next step**:
  - **intent-submit-refused** (new): a submission of uncommitted work is refused (`submit.empty`: commit, then submit).
    The builder commits and submits again, with no Override and no move by hand.
  - **review-interrupted**, rewritten: started with `hive_start_review` on a real submission, then the card goes back
    to its builder, so the verdict is refused. The reviewer retries no verdict and moves nothing. Its refusal names
    the builder's moves, "From active, use: submit, put back": carded as #1604.

What changed (v83–v84):
- **New**:
  - **preset-solo-card**: Solo, saved as the Workflow section saves it. Started with `hive_start_card`, committed,
    `hive_submit`, and Done with no review and no Override.
  - **preset-pair-lane**: Pair. The builder registers its lane with Implementer and starts its card in the slot Hive
    lends it, with no worktree of its own. Submitting from the slot is a model's check.
  - **coordinator-merge-due**: #1346 item 4, a lane's merge due with its builder merging. The Coordinator asks nothing,
    merges, moves or ends nothing itself, and watches the lanes again.
- **#1346's five** are now coordinator-fact-before-asking, coordinator-start-reviewer, coordinator-lanes-only-watch,
  coordinator-merge-due (with coordinator-ten-rounds and coordinator-no-code-done) and coordinator-look-before-asking.
  #1346 stays open for its Haiku run before the release (#1541).
- **Checks follow the intents**: where a check counted only `hive_update_task`, it now also takes `hive_start_review`
  or a moving intent, in review-card, card-detail, list-compact, list-detail, card-loop-released and
  card-loop-blocked. Scenarios with every rule off keep their old moves; the `old-move-*` scenarios test the
  translation.
- **Fixtures**:
  - merged-to-done: a real `--no-ff` merge of the card's branch into the base its prompt names (#1169).
  - assistant-new-lane: accepts run-lanes or coordinate-agents (#1169).
  - assistant-message-watching: Coder's watch made with its own token, `POST /v1/tasks/wait`, so a real CLI gets it
    too (#1545).
  - assistant-journal-recall: every CLI gets the start view since #1065, so it no longer expects none on Codex and
    Copilot.
  - card-loop-blocked: the fakes that answer no wake end at the card's return, rather than at the fakes' time limit.
- **Unchanged**:
  - merge-main-moved keeps "it merged the moved base into the branch first", as #1525 left it (#1162).
  - **#903**: act, then ack. inbox-act-then-ack and inbox-ack-and-read end `acked` on all three fakes; the order, ack
    after acting, is a model's check.
- **Setup flakes**, each fixed with a condition, not a sleep:
  - #1583: a setup's move as the user moves it (`userMove`) checks the reply, and waits for the card in the column,
    and in Review for a new submission, else fails as `setup: …`.
  - #1588: setups save workflow options through `workflow:setOptions` (the project's lock), not by rewriting
    `project.json` beside Hive. That rewrite is the likely way the agents just added went missing.
  - Proof: 6 scenarios that move cards in setup, `--repeat 5` with 2 bounded CPU spinner workers, 30 of 30 pass
    (`2026-10-24T19-08-44-fake`). Neither flake had reproduced alone before the fix.

## A reviewer's commands in its review copy (#1559): fakes, Claude Code Haiku, fixtures v77–v78, 24 October 2026

review-agent-work now says to run every command with the review copy as its working directory (a reviewer's session and
shell stay in the project folder, so a command that doesn't change folder runs there), and start review's reply names the
copy as their working directory. In v78 **review-in-copy**'s `test.js` leaves `ran.txt` beside itself, and a new check
fails a run that leaves one in the project folder.
- **Fakes, compared** (v77, the 16 review scenarios): before `hb2-1559-before` (`2026-10-24T03-17-30-fake`, 1.0.0
  03dd3c1f), after `2026-10-24T03-24-23-fake`. All checks pass on both sides; the only differences are review-agent-work
  343 bytes longer in each, and the start review reply 36 characters longer in review-in-copy and pool-reviewer-wake.
- **Model trial**, review-in-copy v78, Claude Code Haiku `--repeat 3` (`2026-10-24T03-31-51-claude-code`, $0.024): 3 of
  3, each changing into the copy (`cd "<copy>" && …`) before every command, `node test.js` among them; no `ran.txt` in
  the project folder. Before the change, #1546's reviewcopiesreal saw Haiku run its command in the project folder 1 run
  in 7.

## What agents are told about slots (P7): fakes, Claude Code, Codex, fixtures v76–v77, 24 October 2026

#1444 changes the lines P7 made wrong: work-on-card (a card's folder is its slot: work and run checks there; a move to
another folder is a new conversation; `hive-progress --check --isolated`), card-loop (a pool reviewer joins no lane),
review-agent-work (review in the review copy the start names, never the builder's slot or folder), merge-ready,
coordinate-agents, run-lanes and split-work (no agent has a worktree of its own), the session contract's folder line,
and `hive_agent_activity`'s description. The start review reply now lists its files by name ("M greet.js", where
`[object Object]` stood) and puts the review copy first. Three new scenarios: **slot-start** (a builder starts a card
where cards are built in slots: a slot lent, no worktree of its own, nothing changed in the project folder),
**review-in-copy** (a reviewer reviews in the copy its start names) and **pool-reviewer-wake** (a reviewer from the pool,
given a card, reviews it and joins no lane), and in round 2 (v77) **isolated-check** (a builder runs its card's check
while other agents edit the shared folder: with `--isolated`, in a check copy at the card's revision, which the check
records).
- **Fakes, compared** (round 2, after HR3's round 1): both sides fixtures v77, on 152440e6, neither changing while it ran.
  Before: the pre-change guidance (the skills, the contract, `hive-mcp.ts`, `toolReplies.ts`, `servers.ts` and
  `bundledHistory.json` as on 1.0.0 df336407) with the new scenarios (`fake-1444-before-v77`,
  `2026-10-24T01-59-35-fake`); after: the change (`fake-1444-after-v77`, `2026-10-24T02-35-52-fake`). Each has 124 of 124
  scenarios passing (the fakes act from scripts, so the change can't move them; they check the harness and Hive's
  costs). The only differences: the contract 24 bytes longer in 87 scenarios (48 and 96 in two with more sessions), the
  skills 264–3,148 bytes longer (721 in most agent sessions), and 5 fewer characters of tool replies in 3 (start review's
  files as "M greet.js"); requests, tool calls and everything else the same.
- **Round 1's fake runs** (`fake-1444-before`, v75 on 63e6bc21, and `fake-1444-after`, v76, whose source changed during the
  run) passed whole but aren't a comparison: their fixture versions differ and the after side wasn't settled. They also
  showed the benchmark kept only its first 100 scenarios (of 120 and 123 run), so it keeps 200 now (`BENCHMARK_LIMITS`).
  The fake Codex runs the new ones (`2026-10-24T01-36-43-fake-codex`, `…01-51-41-…` for isolated-check).
- **Claude Code** (CLI 2.1.310, its default model, the test home): slot-start 3 of 3, review-in-copy 3 of 3,
  pool-reviewer-wake 2 of 2 (`2026-10-24T01-04-29-claude-code`, `…01-13-45-…`, `…01-37-48-…`; the $2 budget ended the
  first run's third samples). worktree-isolation passes 2 of 2.
- **Codex** (0.164.0, its default model, its test home, `2026-10-24T01-16-19-codex`): slot-start 3 of 3,
  pool-reviewer-wake 3 of 3, worktree-isolation 3 of 3. review-in-copy failed 3 of 3 at first: Codex calls the hive
  tools from its code tool, printing a card's JSON and the start review reply in one output, and never saw the copy's
  folder at the reply's end; it diffed the revisions from the project folder. With the copy first in the reply, 3 of 3
  (`2026-10-24T01-34-27-codex`), reviewing in the copy.
- **isolated-check** (round 2, v77): Codex 3 of 3 (`2026-10-24T01-54-35-codex`): it read work-on-card and ran
  `hive-progress --check quick --isolated`, which ran in copies/copy-1 at the card's revision. Claude Code 2 of 3
  (`2026-10-24T01-52-10-claude-code`): it read the card and the project's files rather than work-on-card, and ran the
  check with `--isolated` twice; the third time it ran the check in a clone of its own in its scratchpad, at the right
  revision but outside Hive's check copy. The scenario checks what it does, not which skill it read (Claude Code read
  none in the three).
- **work-on-card** and **review-card** fail 3 checks in every sample on both models, as before this change: the agents
  start, submit and review with the intent tools, and the fixture's project, with no review set, moves a submitted card
  on past Review, where the checks still expect the 0.9 board moves (#1536 rewrites them for the intents).

## The Assistant's override, fixed scenarios: fakes, Claude Code, Codex, fixtures v74, 22 October 2026

#1474 fixes the two scenario faults #1322's trial found (below). **assistant-override-reason**'s repository now shows the
hand merge the user tells of (a card branch with a commit, merged `--no-ff` into alpha's default branch, which the
prompt names with the branch), and the "passed no override" checks count every tool that moves the card
(`hive_update_task`, `hive_update_tasks`, and the intents `hive_start_card`, `hive_put_back`, `hive_submit`,
`hive_verdict`, `hive_report_merge`): **assistant-override-unneeded** needs one of them to have worked, and
**assistant-override-none** no longer misses an override given through another tool than `hive_update_task`. Source
db34091a with the change uncommitted.
- **Fakes**: 9 of 9 checks on each (`2026-10-22T21-11-21-fake`, `2026-10-22T21-12-10-fake-codex`).
- **Claude Code** (CLI 2.1.308, its default model, the test home's Max login): 30 of 30 checks in 3 samples of each
  (`2026-10-22T21-13-13-claude-code`). With the merge in git it moved the card to Done with the user's reason as
  `override` each time; it put the unneeded card back with `hive_put_back` each time, with no override. $1.09 for the 9
  sessions (API-equivalent, as the CLI reports it).
- **Codex** (0.163.0, its default model, its test home): 30 of 30 in 3 samples of each (`2026-10-22T21-17-11-codex`),
  every move by `hive_update_task`. $0.48 for the 9 sessions.
- **Round 2** (still v74, never merged at the first round's checks): the checks take a card by number, "#n" or its key
  ("AL-1"), in `hive_update_task`, `hive_update_tasks` and the intents alike, and assistant-override-reason counts an
  override given through `hive_update_tasks` too (unit tests in `tests/scenarioObserve.test.ts`). Fakes again: every
  check passes (`2026-10-22T21-30-17-fake`, `2026-10-22T21-31-08-fake-codex`). The 18 real sessions above, re-scored with
  these checks from their recorded observations rather than run again: all 60 results unchanged (every call named the
  card by number).

## The Assistant's override, Claude Code's trial: fixtures v73, 22 October 2026

#1322: the Claude Code trial of #1319's three scenarios (below, where Codex passed 10 of 10), its test home signed in to a
Max subscription. CLI 2.1.308, its default model, source 3a75fd16. Both failures are the scenarios', not the override
path's: #1474.
- **assistant-override-none**: passes, 4 of 4 (`2026-10-22T21-02-51-claude-code`). It tried the move without an
  override, was refused, and told the user what the move would skip.
- **assistant-override-unneeded**: 2 of 3 (same run). It put the card back with `hive_put_back` (#1267), with no
  override and no `Override` fact; the check "passed no override" counts only `hive_update_task` calls, so it failed.
- **assistant-override-reason**: 0 of 3 checks, in 3 samples (that run and `2026-10-22T21-05-00-claude-code`, 2 more).
  Each time it checked the user's "merged into main by hand" against git, found the fixture's repository has only
  `master` with one `init` commit (no `main`, no branch, no merge), and asked the user rather than moving the card.
  Codex never looked at git. The fixture should show the merge.
- Cost $0.64 for the 5 sessions (API-equivalent, as the CLI reports it; the test home's login is a Max subscription).

## Agents' old moves as intents: fakes, Codex (its default model), fixtures v73, 21 October 2026

#1268 makes a project agent's `hive_update_task` `column` and `review` the card's intents while the skills still say
to move cards (§16.17), and says so in the tool's description: +592 B to every session's tool list (27,105 to 27,697 B
a start; `before-1268`, 1.0.0 at dd4ed990, against `2026-10-21T08-18-00-fake`, fixtures v72: every scenario passes on
both, with no regression or failed check). A reply to a translated move adds a line naming the tool to use next time
(`As start: next time call hive_start_card`, 43 B). The baseline is marked as mixed source: files were edited while it
ran, after its build, which is made from the source at the start. Two new scenarios, in Pair with everyone in the
project folder, with the skills as they are now: **old-move-submit** (a builder sends its committed work to Review: a
`Submitted` fact, its summary the comment) and **old-move-review** (a reviewer starts a review and fails it with
`review`: `ReviewStarted` and a failed `Verdict`, the card back in Doing with its builder).
- **Fakes** (Claude Code's and Codex's): both pass, 6 of 6 checks each (`2026-10-21T08-52-37-fake`, `2026-10-21T08-53-52-fake-codex`).
- **Codex**, 3 samples each (`2026-10-21T08-54-37-codex`, CLI 0.163.0, $0.37): 6 of 6 pass, every check. The builder
  sent the card with `hive_update_task` twice and with `hive_submit` once; the reviewer used `hive_update_task`'s
  `review` each time, its facts the runtime's.
- **Claude Code**: not run (its test home is signed out, #1321/#1322).

## The card intents' tools: fakes, Codex (its default model), fixtures v72, 21 October 2026

#1267 gives agents a hive tool per card intent (`hive_start_card`, `hive_put_back`, `hive_start_review`,
`hive_request_builder`, `hive_verdict`…), +4.9 KB to every session's tool list (27.4 to 32.3 KB a start: baselines
`hb1-1267-before`, 1.0.0 at d148192c, and `hb1-1267-after`; every other cost unchanged). Two new scenarios, in Pair
with everyone in the project folder: **intent-put-back** (a builder starts a card and puts it back, saying why) and
**intent-review-request** (a reviewer starts a review, asks the builder something, and fails it). Each checks the
card's facts and, for the trials, which tools the model chose.
- **Fakes** (Claude Code's and Codex's): both pass, 12 of 12 checks (`2026-10-21T06-36-51-fake`, `2026-10-21T06-37-43-fake-codex`).
- **Codex**, 1 sample each (`2026-10-21T06-38-41-codex`, CLI 0.163.0, $0.16): the skills (unchanged until #1274) still say
  `hive_update_task`, and the model followed them. The builder read the card and moved it with `hive_update_task`, never
  started it (no `Started` fact, so no `why` either). The reviewer started its review and failed the card with
  `hive_update_task`'s `review` (its facts written through that path, the card left in Review as that path does), and
  chose **`hive_request_builder`** for the question, the one step no older tool covers. 6 of 12 checks pass: the
  failures are the tool-choice checks and what the older path does differently. The trial to repeat once #1274 points
  the skills at the intents.
- **Claude Code**: not run, skipped for the environment (`2026-10-21T06-40-46-claude-code`: its test home is signed
  out, #1321).

## The Assistant's override, with its facts and a move that skips nothing: fakes, Codex (its default model), fixtures v71, 21 October 2026

The runs below record fixtures v70: they ran #1319's checks before the version was bumped for them (v71).

#1319, after #1265: the harness reads each scenario card's workflow facts (`tasks:facts`); **assistant-override-reason**
checks one `Override` fact by the Assistant with the user's reason, **assistant-override-none** checks none, and the new
**assistant-override-unneeded** (a Doing card put back in Todo: a move backwards skips no rule) checks it moves with no
override and no `Override` fact.
- **Fakes**: all three pass (`2026-10-21T04-55-29-fake`).
- **Codex**, 1 sample each (`2026-10-21T04-56-27-codex`, $0.18): 10 of 10 checks pass. With no reason it told the user
  what the move would skip; asked to put the card back it moved it without an override.
- **Claude Code**: not run. Its test home is still signed out (`2026-10-21T04-58-14-claude-code`: "Not logged in · Run
  /login" in its status line, the prompt never taken; the harness counted that as 3 failures instead of skipping it for
  the environment: #1321). The trial is #1322, once the test home is signed in: run 22 October (above).

## The Assistant's override of a card's workflow rules: fakes, Codex (its default model), fixtures v70, 21 October 2026

#1265: the Assistant's `hive_update_task`/`hive_update_tasks` take `override: { reason }`; a move that skips a card's
rules without it is refused (409, `move.needsOverride`: what it skips, the next step, where the rules are set). New
scenarios on a project with Pair options: **assistant-override-reason** (the user says why: merged by hand) and
**assistant-override-none** (the user only asks for the move).
- **Fakes**: both pass (`2026-10-21T04-00-23-fake`). The whole fake set before and after the tool descriptions changed
  (`hb2-1265-before`, `hb2-1265-after`, fixtures v69): no check changed; pick-up-latest and licence-audit timed out once
  under load and pass alone (#1311).
- **Codex**, 3 samples each, after (`2026-10-21T04-14-09-codex`, $0.30): 6 of 6 pass. Two wordings were tried first:
  the refusal's next step "Give a reason to move it anyway…" let Codex make one up from the request
  ("User explicitly requested: …", `04-05-23-codex`, 1 of 1 failed); "tell the user… a request isn't a reason" made it
  skip the override even with the user's reason (`04-07-30-codex`, 0 of 3). Now: pass the user's own reason, given with
  the request or after being told what the move skips; never make one up.
- **Claude Code**: not run. Its test home isn't signed in (`04-03-47-claude-code`: "Hive shows the session waiting for
  a sign-in"; an earlier haiku attempt's prompt wasn't taken, `04-01-06-claude-code`, and haiku has no price to budget).

## One answer per workflow rule (Phase 0 tidy): fakes, Claude Code and Codex (their default models), fixtures v67, 20 October 2026

#1129: the board rule says Done in the project folder is committed; merge-ready says who merges (a lane's builder at
its end, otherwise the user or an agent asked); a lane's cards change only between cards (card-loop, run-lanes, the
`hive_lane` descriptions); run-lanes counts a team setup the user chose as agreeing to worktrees, and its brief names
the project's own conventions (such as the user OK-ing screenshots); review-agent-work checks a convention the brief
names; merge-ready's timer line points to work-on-card. Repo docs (AGENTS.md, RELEASING.md, tests/e2e/README.md) too.
- **Fakes**: every scenario passes the same checks before (`hb5-1136-after`, the branch before #1129) and after
  (`hb5-1129-after`); progress-long-command timed out once under load and passes alone. Agents' guidance +35
  characters, delivered skills about +490 bytes.
- **Codex, before and after** (assistant-new-lane, card-loop-lane, merged-to-done, merge-main-moved, review-card, 2
  each: `2026-10-20T04-38-23-codex`, `04-31-16-codex`): all pass both ways but merge-main-moved.
- **merge-main-moved on Codex**, a known weak spot: before 5 of 10 (`04-38-23`, `04-50-29`, `04-57-25`); after, with
  merge-ready's "who merges" line first naming `--no-ff` and the slot, 3 of 10 (`04-31-16`, `04-47-06`, `04-53-41`): every
  sample that read the skill passed before (5 of 5), 3 of 5 after, the two others merging with `--no-commit` on the base
  and checking the combined tree (the same path seen before #1129). With that line pointing to the section instead, 5 of
  8 (`05-00-39`, `05-03-11`; read 6 times, passed 5). Not reading merge-ready (about half the runs, both ways) is the
  main failure; #1162 settles the `--no-commit` path.
- **Claude Code** (CLI 2.1.304), after (`2026-10-20T07-34-17-claude-code`, 2 each): review-card and card-loop-lane pass
  (card-loop-lane once ended its turn not watching); merge-main-moved 0 of 2 (merge-ready not read; one merged the
  branch without merging the moved base first); merged-to-done 0 of 2 and assistant-new-lane's skill check 0 of 2,
  both fixtures (#1169: the repo has no merge to find, so it rightly leaves the card; it reads run-lanes, which the
  check doesn't count). Before, on the branch before #1129 (`07-42-36-claude-code`, those three): the same, and
  merge-main-moved worse (1 of 8 checks each).

## A decision about a card goes on the card: fakes, Claude Code and Codex (their default models), fixtures v65, 20 October 2026

#1136: with the journal on, its always-present rule said to write decisions as they happen, and nothing always-present
said a decision about a card belongs on the card (coordinate-agents does, but a wake doesn't load it): Claude Code's
Assistant wrote a journal entry instead (assistant-reply-decision 0 of 3 on 19 Oct). The journal rule now says a
decision about a card goes on the card first, the journal only noting it; the Control rule says to pass an agent's
question on in its words; the journal and coordinate-agents skills match.
- **Fakes**: every scenario passes the same checks before (`hb5-1136-before`) and after (`hb5-1136-after`);
  worktree-isolation timed out once before, under load. The Assistant's guidance +172 bytes with the journal on.
Samples the harness lost before the model acted (a typed prompt not taken: #1168) are counted apart, as neither.
- **Claude Code (CLI 2.1.304), before**: on 97fc8adf, the branch before the change (`2026-10-20T07-52-16-claude-code`,
  3 each): assistant-reply-decision 1 of 2 (the other read the card and Coder's activity and recorded nothing), 1
  lost; coordinator-wake-question 2 of 2, 1 lost. On main at 1cd25924 (`2026-10-19T22-48-31-claude-code`): 0 of 2 and
  1 of 2 (its reply didn't quote the question). In all: 1 of 4 and 3 of 4.
- **Claude Code, after**: assistant-reply-decision 3 of 3 (`2026-10-20T07-22-24-claude-code`); coordinator-wake-question
  5 of 5 (`07-22-24`, `07-26-01`, `07-32-19`), 4 lost.
- **Codex (its default model)**: both 3 of 3 before, on 97fc8adf (`2026-10-20T07-59-00-codex`; an earlier 2 of 2,
  `03-04-44-codex`, was pruned), and 3 of 3 after (`03-42-10-codex`, `07-51-45-codex`).

## Screenshots read through their report: fakes, Claude Code (its default model), Codex (its default model), fixtures v65, 20 October 2026

#899: i18nshots writes a text report naming the screenshots worth opening, and review-agent-work gains a general line:
read a check's text report of its screenshots first, then open only the images it flags and those of the screens the
change touches. New scenario **review-screenshot-report**: a card translating one screen, 24 screenshots of 12 screens,
and a report flagging two (one of them the changed screen's); the project's README says the check writes the report.
- **Fakes**: all 99 earlier scenarios pass the same checks before (`hb5-899-before`, review-agent-work as on main) and
  after (`hb5-899-after`); delivered skills +338 bytes. The new scenario passes (its model checks skipped).
- **Claude Code, before** (main's review-agent-work, the scenario copied in): 3 of 3, with the comment naming the report
  (`2026-10-20T02-13-46-claude-code`) and 3 of 3 with only the README naming it (`2026-10-20T02-16-12-claude-code`).
  Each sample read the report, then opened one screenshot (the changed screen's).
- **Claude Code, after**: 3 of 3 both ways (`2026-10-20T02-00-54-claude-code`, `2026-10-20T02-20-42-claude-code`). It
  opened the changed screen's and, in some samples, the flagged one.
- **Codex, after**, with the comment naming the report: 3 of 3 (`2026-10-20T02-09-30-codex`). It read the report, then
  opened the changed screen's two and the flagged one, or none. Its first trial found two gaps in the check, now fixed:
  a script listing or building the paths it views, and the changed screen's image opened in the same script as the
  report read.
- **So**: on a 24-image fixture both models are already frugal, and the line doesn't change what they do. It's a
  safeguard for Hive's own language runs (about 370 screenshots a language), where builders and reviewers opened every
  image (#899). It costs nothing measurable in the fakes.

## Tagging cards: fake, Claude Code (haiku), Codex (its default model), fixtures v66, 20 October 2026

#1131: `hive_update_task(s)` and the Agent API take `addLabels` and `removeLabels` (labels added or taken off, the
others kept); `labels` still replaces them, and its description now points to the new two for tagging. One new
scenario, **tag-cards**: three cards with labels of their own, and the prompt "Tag cards #a, #b and #c with the label
0.9.4". Checks: each has 0.9.4 and kept its own, every change used `addLabels` and never `labels`, in one
`hive_update_tasks` call, and no card moved.
- **Fakes**: the whole set before and after the description change (baseline `hb2-1131-before` against
  `2026-10-20T01-08-41-fake`): 398 pass both times, check for check; the tool list +600 bytes (20,351 → 20,951). The new
  scenario passes with the fake Claude Code (`2026-10-20T01-43-11-fake`).
- **Codex**: 2 of 2 (`2026-10-20T01-44-06-codex`): one `hive_update_tasks` with `addLabels`, every card's own labels kept.
- **Claude Code (haiku)**: 2 of 2 (`2026-10-20T01-46-16-claude-code`): the same.

## A card's reference that no longer resolves: fake, Claude Code (haiku), Codex (its default model), fixtures v63–v64 (v65 once merged with main, which also reached v64), 19 October 2026

#819: the start prompt names a reference that doesn't resolve, why and the closest headings ("This reference no
longer resolves: DESIGN.md#retry-policies (no such heading; closest: #retry-policy). Ask the user which section is
meant, or read the closest."). One new scenario, **card-read-first-broken**: checks that the agent reads the closest
section or asks, never the whole document, and does the work from it or waits on the user.
- **Fake**: passes. The prompt is unchanged for references that resolve, so the other scenarios aren't affected.
- **Codex**: 2 of 2 (`2026-10-19T22-54-27-codex`): hive_doc_outline, then hive_read_section on the closest
  (`#retry-policy`), RETRY.md right, Review.
- **Claude Code (haiku)**: 2 of 2 (`2026-10-19T22-58-45-claude-code`): the closest section, by hive_read_section in one
  sample and a ranged read in the other; never the whole file.
- **Round 2, fixtures v64** (the prompt says to read the closest with `from: "project"` also when none resolves; a new
  check that every hive_read_section call names it): fake passes; Codex 2 of 2 (`2026-10-19T23-16-37-codex`), each
  reading `#retry-policy` with `from: "project"`; Claude Code (haiku) 1 of 1 that ran (`2026-10-19T23-18-49-claude-code`,
  the same); its second sample never took a turn: the test account was at 99% of its weekly limit (an environment
  skip, so no more Claude Code trials were run).

## A card's Read first references: fakes, Claude Code (haiku), Codex (its default model), fixtures v62, 19 October 2026

#818: a card's `context` (doc sections to read first) is listed in its start prompt with each section's size, and the
card-loop skill has the builder read them first and the reviewer check against them. One new scenario,
**card-read-first**: a card with `DESIGN.md#retry-policy` as its reference, started with the prompt Hive gives (the
reference and size, not the text); the work (RETRY.md) needs that section.
- **Fakes**: the whole set passes before and after (baseline `hb3-818-before` against `hb3-818-after`: none fails;
  measures the same but for the tool list, +0.8 KB for `context` on hive_create_task and hive_update_task, and the
  card-loop skill, +45 bytes). The new scenario passes with the fake Claude Code.
- **Codex**: 3 of 3 (`2026-10-19T22-13-57-codex`): it read the section with hive_read_section, never the whole file,
  wrote RETRY.md from it and moved the card to Review.
- **Claude Code (haiku)**: 3 of 3 that ran (`2026-10-19T22-19-07-claude-code` sample 1, `2026-10-19T22-24-54-claude-code`
  both): hive_read_section for the section, then the work. One sample in the first run never took a turn (no tool call,
  no reported cost: the session, not the guidance) and stopped that run at its budget check.
- **Round 2** (the prompt names `from: "project"`, the copy the card was briefed from, and a whole file's empty heading):
  Codex 2 of 2 (`2026-10-19T22-39-02-codex`), Claude Code (haiku) 2 of 2 (`2026-10-19T22-41-09-claude-code`); both
  passed `from: "project"` to hive_read_section in every sample.

## Long documents by section: fakes, Claude Code (haiku), Codex (its default model), fixtures v59 (v61 once merged with main), 19 October 2026

#817: two hive tools read Markdown by section (hive_doc_outline, hive_read_section), and both session contracts say to
use them on documents over about 20 KB. One new scenario, **long-doc-section**: a question answered by one section
(Retry policy) of a 58,000-character DESIGN.md in the project.
- **Fakes**: the whole set passes before and after the guidance change (baseline `hb3-817-before`, fixtures v58, against
  `hb3-817-after`: 355 checks pass, none fails; measures the same but for the guidance, +119 characters, and the tool
  list, +1,624 bytes for the two tools). The new scenario passes with the fake Claude Code.
- **Codex**: 3 of 3 (`2026-10-19T20-47-42-codex`): each called hive_doc_outline and then hive_read_section, never read
  the whole file, and answered right ($0.04–0.05 a sample).
- **Claude Code (haiku)**: 3 of 3 (`2026-10-19T20-53-36-claude-code`): it searched the file (Grep) and read a line range
  around the answer, not the hive tools, and never the whole file: as good for a document in its own folder, which Claude
  Code can read by range (Codex and Copilot can't, the card's reason for the tools). An earlier run
  (`2026-10-19T20-44-11-claude-code`) did the same, failed by checks that took a ranged Read for a whole one; fixed.
## Licence audit: fakes, Claude Code (its default model), Codex (its default model), fixtures v64, 20 October 2026

#410: a general agents' skill, **licence-audit**: inventory what ships (runtime dependencies, bundled libraries, vendored
material inside packages, assets, installer parts, runtimes), read each licence from its files, flag anything not plainly
permissive for the user, regenerate the notices, report a table. RELEASING.md points to it. The agents' catalog has a
2,000-character budget: its description is short to fit (1,985). New scenario **licence-audit**: a fixture with an MIT
package carrying a CC-BY-3.0 icon (vendored), an MIT-or-GPL dual licence and a GPL dev tool.
- **Fakes**: work-on-card, review-card and card-loop-rounds pass before (`hb5-410-before`, main at 5ed47fbd) and after
  (`hb5-410-after`): calls the same; the catalog +130 bytes, delivered skills +2,869.
- **Claude Code, before** (main's skills, the scenario copied in; `2026-10-19T23-02-47-claude-code`): the behaviour checks
  pass 2 of 2 on this small fixture without the skill (it found the vendored icon and the dual licence by reading
  node_modules). The skill's value is the method on a real project (installer parts, notices), which a fixture can't show.
- **Claude Code, after**: 2 of 2, reading licence-audit each time (`2026-10-19T22-58-58-claude-code`).
- **Codex**: passes, reading it (`2026-10-19T23-00-22-codex`).

## Board hygiene: fakes, Claude Code (its default model), Codex (its default model), fixtures v62 and v63, 19 October 2026

#409, built small (the Assistant's brief after #1112's drift review): **board-hygiene** sweeps for duplicates (linked,
marked for the user to archive), the user's answers not yet recorded as decisions, and blocked reasons gone stale
(rewritten or raised, not cleared); it leaves archiving, On Hold, Done, columns and lanes alone. coordinate-agents and
run-lanes name it. The Assistant's catalog has a 2,000-character budget: triage-report's and board-hygiene's
descriptions are short to fit (1,997). New scenario **board-hygiene**: a duplicate pair, an answer only in an agent's
comment, a card blocked on one now Done, and a card On Hold.
- **Fakes**: coordinator-wake-failed, assistant-look-lanes and mode-qa-triager-plans pass before (`hb5-409-before`,
  main at 1cd25924) and after (`hb5-409-after`): calls the same; the catalog +291 bytes, delivered skills +5,129 (two
  more skills, with #408's).
- **Claude Code, before** (main's skills, the scenario copied in; `2026-10-19T22-23-33-claude-code`): 0 of 2. It linked
  the duplicates, but recorded no decision and cleared the block itself, both times.
- **Claude Code, after**: 2 of 2, reading board-hygiene (`2026-10-19T22-16-42-claude-code`); qa-triage-report 2 of 2
  there with its shorter description.
- **Codex**: board-hygiene and qa-triage-report pass (`2026-10-19T22-19-07-codex`).
- **Round 2 (fixtures v63)**: decisions only from the user's own words (their chat, a comment the card shows as theirs, Hive's
  reply wake); an agent's account of an answer is asked about, not recorded. The scenario now has the user's own comment
  (CSV) and an agent's "the user told me: tabs" (no decision, ask). Fake passes; Claude Code 3 of 3
  (`2026-10-19T22-40-54-claude-code`); Codex 2 of 2 (`2026-10-19T22-42-34-codex`). assistant-reply-decision and
  coordinator-wake-question fail on Claude Code on main too (reading no skill; `2026-10-19T22-48-31-claude-code`): #1136.

## The QA triager's procedure: fakes, Claude Code (its default model), Codex (its default model), fixtures v61, 19 October 2026

#408: a new Assistant skill, **triage-report** (the cause found in the code before the card, a duplicate check including
Passed and unmerged work, then the card with what the user saw, the likely cause, evidence, fix direction and done
when), which the QA triager mode now names. Two new scenarios: **qa-triage-report** (a banner reads "Saved 0 card": the
cause is a plural in banner.js) and **qa-triage-duplicate** (the same report while a card with its fix is in Passed).
- **Fakes**: mode-qa-triager-plans and -coordinates pass before (`hb5-408-before`, main at 1cd25924) and after
  (`hb5-408-after`); the mode is +126 bytes, the skills' catalog +255, delivered skills +2,521 (one more skill).
- **Claude Code, before** (main's skills, the new scenarios copied in; `2026-10-19T20-48-31-claude-code`): 2 of 2 each
  already found the cause, filed one card in Todo and, with the fix in Passed, commented on it instead of filing a twin.
  Its cards gave the cause, a fix and a test, but no evidence and no done-when.
- **Claude Code, after**: both pass 2 of 2, reading triage-report each time (`2026-10-19T20-41-33-claude-code`), and the
  cards carry what the user saw, evidence and a done-when. qa-triage-report now checks evidence and done-when: 2 of 2
  (`2026-10-19T20-54-40-claude-code`).
- **Codex**: both pass (`2026-10-19T20-44-15-codex`), reading triage-report; its card has evidence and a done-when.

## Coordinator lessons from 0.9.0: fakes, Claude Code (its default model), Codex (its default model), fixtures v60, 19 October 2026

#1075: run-lanes has the coordinator bring the user a simpler option, with a recommendation, when a card fails review a
second or third time on the same kind of finding; coordinate-agents (and `hive_message_agent`'s description, and
release-hive) have a push or release OK given in the agent's own pane, never relayed. Two new scenarios:
**coordinator-recurring-finding** (woken by a third failed round, each finding a new edge case of one cleaner) and
**coordinator-relayed-ok** (the user asks the Assistant to tell Coder it may push and release).
- **Fakes**: coordinator-team-lanes, -wake-failed, -wake-question and -follow-up pass before (`hb5-1075-before`, on
  6428053a) and after (`hb5-1075-after`); the new ones pass with the fake (`2026-10-19T20-10-02-fake`).
- **Claude Code**: recurring-finding 4 of 5 (`2026-10-19T20-13-13-claude-code`, `2026-10-19T20-19-35-claude-code`),
  each reading run-lanes; the miss asked the user about shipping the simple version (its journal entry says so) but
  its reply had no recommendation the check found. relayed-ok: in the first run the Assistant read no skill and relayed
  the OK once of twice; with `hive_message_agent`'s line, 3 of 3, and 2 of 2 on the final wording
  (`2026-10-19T20-30-38-claude-code`).
- **Codex**: recurring-finding passes (`2026-10-19T20-23-34-codex`). relayed-ok failed there: it read coordinate-agents
  but started Coder with the OK in a `hive_start_task` note (the check then read only messages and prompts: it reads
  notes now). With the rule naming start notes, 2 of 2 (`2026-10-19T20-29-22-codex`).

## One card as a loop's builder picks card-loop: fakes, Claude Code (haiku), Codex (its default model), fixtures v59, 19 October 2026

#878: haiku sometimes read work-on-card for card-loop-rounds ("Work through card #N as its builder (rounds: 2)") and
treated the card at its round limit as a fix. card-loop's description said "Use when told to work through or review
**several** cards in order", and the session contract "several cards in turn", which one card doesn't match. Now
card-loop's says "cards (one or several) as a builder or reviewer, or given rounds", the contract "as a loop's builder
or reviewer (one card or several, with rounds)", and work-on-card's "Not for reviewing one, nor a card loop".
- **Claude Code (haiku), before**: card-loop-rounds 9 of 10 (`2026-10-19T19-29-31-claude-code`, baseline
  `hb5-878-haiku-before`, 5 of 5; `2026-10-19T19-36-32-claude-code`, 4 of 5: sample 5 read work-on-card, moved the card
  to Doing and blocked it asking where the sync code is, as on 15 Oct).
- **Claude Code (haiku), after**: card-loop-rounds 10 of 10, each reading card-loop (`2026-10-19T19-42-52-claude-code`,
  baseline `hb5-878-haiku-after`); work-on-card and review-card 3 of 3 each (`2026-10-19T19-50-32-claude-code`).
- **Codex**: card-loop-rounds and work-on-card pass (`2026-10-19T19-55-30-codex`).
- **Fakes**: work-on-card, review-card, card-loop-rounds, -return and -lane pass before and after (`hb5-878-fake-before`
  against `hb5-878-fake-after`): calls and replies the same; core guidance -13 bytes, the skills' catalog +71, delivered
  skills +71.

## Card loops review a commit: fakes, Claude Code (haiku), Codex (its default model), fixtures v59, 19 October 2026

#1074: card-loop has the builder commit each round before Review and name the commit, and a reviewer handed uncommitted
work ask for a commit (watching for the reply) rather than give a verdict; run-lanes' sample brief and review-agent-work
point to it, and a project agent's own comments no longer wake its watch. Two new scenarios: **card-loop-commit** (a
builder with finished, uncommitted work sends it to Review) and **card-loop-uncommitted** (a reviewer gets uncommitted work).
- **Fakes**: card-loop-rounds, -recurring, -return, -lane and -already-in-review pass before and after (baseline
  `hb5-1074-before`, on main, against `hb5-1074-after`): checks, calls and replies the same, delivered skills +703 bytes
  (+1.7%). The new scenarios pass with the fake Claude Code (`2026-10-19T19-07-13-fake`).
- **Claude Code (haiku)**: card-loop-rounds, -return and -commit pass (`2026-10-19T19-09-36-claude-code`); in that run
  card-loop-uncommitted failed: the reviewer read only review-agent-work and passed the uncommitted work. With
  review-agent-work's pointer it passes 2 of 2 (`2026-10-19T19-13-10-claude-code`); review-card passed 1 of 2 there (the
  other sample sat at a permission prompt after starting its review) and 2 of 2 again (`2026-10-19T19-15-41-claude-code`).
- **Codex**: card-loop-commit and card-loop-uncommitted pass (`2026-10-19T19-24-41-codex`).

## Starting fresh at a natural break: fakes, Claude Code (its default model, and haiku), Codex (its default model), fixtures v58, 18 October 2026

#1082 (#1080's gaps 1 and 3, guidance only): run-lanes and coordinate-agents have the Assistant suggest once, in a line,
starting fresh conversations when every lane has ended or an agent's card is done with nothing else running, never while
work, a question or a watch remains; the journal skill has it save what is open first. Five new scenarios: **fresh-start-lanes-ended**
(both lanes ended, their work committed at the lanes' merge commit), **fresh-start-lane-running** (one ended, the other's
builder working), **fresh-start-question-waits** (the lanes ended, an agent waiting for the user's answer),
**fresh-start-solo-done** (one agent, its card Done, nothing else) and **fresh-start-saves-first** (the user, at the end
of a block, mentions an idea that is in no card).
- **Fakes**: the whole set passes before and after the skill change (`2026-10-18T13-19-46-fake`, baseline
  `hb3-1082-before`, against `2026-10-18T13-45-46-fake`, fixtures v57: 346 checks pass in each, measures the same but
  for the delivered skills, +0.46%). The new scenarios pass with the fake Claude Code (`2026-10-18T14-42-13-fake`).
- **Codex**: all five pass (`2026-10-18T14-34-03-codex`; its "said the lanes are done" missed "Merged" in that run, a
  check fixed since). It read run-lanes or coordinate-agents (and journal) in each.
- **Claude Code (default model)**: lanes-ended, lane-running and question-waits pass (`2026-10-18T14-31-07-claude-code`);
  solo-done and saves-first don't suggest a fresh start in 4 of 4 samples each (that run and `2026-10-18T14-38-23-claude-code`,
  `--repeat 3`), though saves-first writes the idea to its journal, kept open, every time. In each miss it read no skill
  (a card-done wake and a wrap-up message don't lead it to coordinate-agents), so the new line was never seen; it
  suggested starting fresh where it read run-lanes. Follow-up #1090.
- **Claude Code (haiku)**: read no skill in any of the five (`2026-10-18T14-19-10-claude-code`, before the fixtures
  committed the lanes' work).
- A first model run, with nothing committed though the board said merged, got no suggestion from any model: each checked
  git and reported the missing work instead (run-lanes, Verify), rightly. The fixtures now commit it.

## A merge step at the lane's end that needs the user: fakes, Claude Code (haiku), Codex (its default model), fixtures v57, 15 October 2026

#869: lane G's builder had every card passed when its CLI refused the commit; it told the user only, and nothing woke
the Assistant for two hours. card-loop's Builder now has **The lane's end**: a merge step that needs the user (a commit
or merge the CLI or a permission check refuses, a conflict it can't settle) is a stop and ask on the last card. Hive's
lane watch also wakes on a stalled merge (`mergeStallReason`, unit-tested). **card-loop-merge-refused** is new: two cards
in Passed, the lane's work uncommitted, and a pre-commit hook that refuses commits until the maintainer allows them (a
file only the user makes). The builder must block the last card, tell the user, bypass nothing (the hook unchanged, no OK
of its own, no commit, nothing Done before the answer); once the user allows it and says so in its pane, clear the block,
commit and move both cards to Done.
- **Fakes**: all 88 scenarios pass before and after the skill change (`2026-10-15T00-40-50-fake` against
  `2026-10-15T01-09-41-fake`, fixtures v56: 325 checks pass in each, no regressions; neither run recorded context sizes,
  so a size change is unknown). The new scenario passes with the fake Claude Code (`2026-10-15T01-47-12-fake`: its first
  commit was refused, exit 1, and the one after the answer went through) and the fake Codex (`2026-10-15T01-48-31-fake-codex`,
  which runs no shell steps, so the commit check is skipped). The whole set at v57, on the final code, passes
  (`2026-10-15T01-56-26-fake`: 333 checks, the 325 before and the new scenario's 8, 0 fail, 69 skip).
- **Claude Code (haiku)**: card-loop-merge-refused passes (`2026-10-15T01-50-19-claude-code`, and in the earlier pair below). card-loop-rounds
  passed in 3 of 5 samples (the earlier pair, `2026-10-15T01-50-19-claude-code` failed, and `2026-10-15T01-53-38-claude-code`: 2 of 3). Each
  failure read work-on-card, never card-loop, and treated the card as a fix to make (to Doing, then blocked for the
  missing code): a skill choice made from the catalog's descriptions, which #869 didn't change, before the changed
  text could be read. Follow-up #878.
- **Codex**: both pass (`2026-10-15T01-51-43-codex`).
- An earlier pair of trials (`2026-10-15T01-47-56-claude-code`, `…-codex`) also passed both, but the scenario file changed
  while they ran (only its fake skips), so they were run again.

## A question for the user blocks the card: fakes, Claude Code (haiku), Codex (its default model), fixtures v56, 14 October 2026

#840: a reviewer that needed the user's decision on #805 asked only in a comment, which no lane watch sees. card-loop's
Stop and ask, review-agent-work and work-on-card now say to set the card's `blocked` to the question (where it is: no
move) as well as `hive_notify`, and to clear it after the decision. **review-asks-user** is new (a card in Review whose
implementer guessed a currency the card doesn't name: the reviewer blocks it with its question, tells the user and gives
no verdict); **card-loop-rounds** now also checks the card is blocked.
- **Fakes**: all pass before and after the skill change (`2026-10-14T16-19-38-fake` against `2026-10-14T16-52-18-fake`:
  318 checks pass in each, the same ones; tool calls and tokens unchanged, skill bytes delivered +1.3%), and the two
  scenarios pass with the fake Claude Code and the fake Codex (`2026-10-14T17-42-14-fake`, `2026-10-14T17-42-54-fake-codex`).
- **Claude Code (haiku)**: review-card, review-asks-user and card-loop-rounds all pass (`2026-10-14T17-43-42-claude-code`,
  $0.02 in all).
- **Codex**: review-card and review-asks-user pass; card-loop-rounds failed once (`2026-10-14T17-45-34-codex`): the
  builder moved the card to Doing before blocking it, following work-on-card's "with the card yours in Doing". card-loop
  now says to block it where it is; run again, it passes for both (`2026-10-14T17-49-32-codex`,
  `2026-10-14T17-50-55-claude-code`).

## A decision put to the user without a "?" counts: fakes, Codex rescored, fixtures v53, 11 October 2026

#566: every **mode-*-plans**' "wrote cards for alpha, or asked first" and "surfaced a decision for the user" looked only
for a `?`. A request to choose now counts too ("Please choose…", "Let me know which…", "I need your decision on…"); a
polite closing ("Please let me know if you need anything else", "Tell me if anything is unclear") doesn't. Fixtures v53
(v52 on the lane's branch, before #374's v52 merged).
- **Fakes**: the four mode-*-plans pass as before (`2026-10-11T10-14-53-fake`); both checks are skipped for the fakes,
  which act nothing out there.
- **Codex rescored, no new trial**: the one model trial of these on record (`2026-10-10T23-50-39-codex`,
  mode-coordinator-plans) ended "Please choose the export target and contents above…" with no cards. It failed both
  checks before and passes them now. It was the only saved trial whose result changes.

## Merging through the merge slot: fakes, Codex (its default model, `gpt-5.6-luna`), fixtures v51 (v52 once merged with main), 11 October 2026

#374 checks that merge-ready's merge slot is used, from what ran rather than mentions. The evidence:
- Hive's own record (`HIVE_TEST_MERGE_SLOT_LOG`, development builds only): each change to the slots (who holds one,
  told so or not, and who waits) and each claim or release as Hive resolved it (the branch, and what it did), timed.
- The checks' own runs: check.js records each run's start (commit, base, any merge in progress, and the tree it
  checked: the tracked files as they are on disk, staged or not) and its end with the result. What went into a merge is
  the run that checked exactly the tree the merge committed, so a file changed after the checks doesn't count.
- The merge's moment: a reference-transaction hook in the scenario's repository times each branch update to the
  millisecond, from prepared to committed.

**merge-main-moved** keeps #306's base-moved checks and adds:
- the agent's claim of the base's slot held;
- it held the slot from before the checks that went in until they ended passing;
- it merged in the same hold, after the checks;
- its own release of the base's slot ended that hold after the merge.

New:
- **merge-slot-queued**: Implementer, running, holds the slot until Coder is in line behind it. Coder waits, holds the
  slot only after Implementer's release, then checks, merges and releases.
- **merge-checks-fail**: the branch fails its checks. The agent held the slot through the failing run (on the branch,
  or with its merge in progress in the base), merged nothing, and released the slot itself after.

A hold that ended otherwise (its session's end, the user), a release resolved to another branch (#586's bare
`release` after a checkout) or a no-op, and a time that can't be placed (a check that never ended, a merge git kept no
time of) don't count. `tests/scenarioObserve.test.ts` fails each check on its own with a real repository: no slot use,
never released, released by cleanup, by a release for another branch or a no-op, released between the checks and the
merge within the same second, released while the checks ran, a check that never ended, another branch's slot, a hold
only after the checks, a turn not taken, never in line, a failing branch merged anyway, and a staged merge changed after its checks passed and then
committed. It also passes the staged workflow (`git merge --no-commit` in the base, the checks there, then commit or
abort).
- **Fakes**: baseline `before-374` (v50, on 9fce652: merge-main-moved 4/4, merged-to-done 1/1) and `after-374` (v51,
  first round: merge-main-moved 8/8, merge-slot-queued 9/9, merge-checks-fail 5/5, merged-to-done 1/1). Same guidance
  revision (`69388e8bab64a2cf`) and launch size (1,947 bytes core); the slot calls add 2 or 3 tool calls (107–190 bytes)
  a scenario. The fake's release naming no branch after it checked out its branch fails "released the slot itself" in
  merge-checks-fail (it resolves to `feature`), and passes in merge-main-moved (back on the base).
- **Codex, its default model** (CLI 0.162.1): on the first round's evidence (`2026-10-11T08-35-35-codex`, $0.15), all
  three passed. Those records have no call records, ref times or check ends, so they were run again on the final
  evidence (`2026-10-11T09-10-31-codex`, $0.13). merge-main-moved passed every check. merge-slot-queued passed every slot check: it waited in line, staged the merge in the base with `--no-commit`, checked it, committed and released. Only "read the merge-ready skill" failed: it read no skill. merge-checks-fail claimed no slot this time: it staged the merge, saw the checks fail, aborted and merged nothing, so the three slot checks and the skill read failed. Models vary from sample to sample, and the first round's sample did use the slot here. Those records have no checked trees, so they can't show that what went in was what was checked. Run again on the final evidence (`2026-10-11T09-28-17-codex`, $0.16): every slot check passed in all three, the tree its checks ran on is the tree each merge committed, and only merge-checks-fail's "read the merge-ready skill" failed.
- **Codex, `gpt-5.6-luna`** (`2026-10-11T08-31-38-codex`, $0.015, first round): read no skill and claimed no slot. It
  merged at once in merge-main-moved (the base-moved checks fail too, as at v50) and merge-slot-queued, and in
  merge-checks-fail ran the checks on the base and merged the broken branch. That is a model skipping merge-ready, not
  a fixture change.
- **Claude Code**: not run. Its test home's sign-in had expired (`claude auth status`: not logged in), and the trial
  ended as "the session ended" rather than an environment skip (#577).

## Reports and verdicts lead with a one-line summary: fakes, Codex (its default model), fixtures v46–v47, 11 October 2026

#532: work-on-card has a report to Review start with a one-sentence summary, review-agent-work a verdict with one line
("Round 1: FAILED: 2 findings: …"); `hive_read_task` with `summary: true` gives each comment as its first line, and
card-loop and run-lanes read wakes that way when the gist is enough. Fixtures v47 add a check to **work-on-card** (its
report leads with a summary line, 10–300 characters) and **review-card** (its verdict's first line, the same, says
passed or failed); their fakes post that comment through `hive_update_task`.
- **Fakes**: before `hb1-532-before` (v46 on 4d7a16a, `2026-10-11T07-33-37-fake`) 76 of 76; after (v47,
  `hb1-532-after`, `2026-10-11T08-02-47-fake`) 76 of 76. Hive's cost changed only in the two scenarios whose fakes now
  comment through a hive tool (0 → 91 characters, 1 call each); every other scenario is unchanged.
- **Codex: 4 of 4 pass** (`2026-10-11T08-27-42-codex`, $0.221): work-on-card and review-card pass their new checks
  (the report and the verdict lead with a summary line); card-loop-rounds and coordinator-wake-failed pass. It didn't
  read with `summary: true` in these runs (coordinator-wake-failed read the latest comment in full): the reports here
  are short, and the skills offer it when the gist is enough.
- **Claude Code**: not run: its test home isn't signed in.

## The Assistant watches whole lanes: fakes, Codex (its default model), fixtures v46, 11 October 2026

#531: `hive_wait_for_tasks` with `lanes` (ids, or `["all"]`) is a lane watch: every running lane, followed as it goes on,
no card limit, woken only for a failed review, a blocked or stalled card, a lane due to merge, ended or abandoned.
run-lanes and coordinate-agents now say to watch the lanes that way, and the lanes-running tail and `hive_lane start`'s
nudge point at it. Fixtures v46: the coordinator scenarios' fakes watch `lanes: ["all"]`, and a lane watch on all
lanes counts as covering every lane's cards (`watchCovers`); coordinator-lanes-to-end's first-wake check also takes a
lane watch's own line.

**Before and after** (Performance → Compare calls v45 against v46 not comparable, so per scenario here):
- **Fakes**: before `hb1-531-before` (v45 on a7b9e6e, results `2026-10-11T05-42-20-fake`): 76 of 76. After (v46,
  `2026-10-11T06-16-02-fake`, baseline `hb1-531-after2`): 76 of 76. Hive's cost changed only in the coordinator
  scenarios, whose fakes now watch lanes: after round 2 trimmed the lane watch's reply (the events only when not the
  default), each is smaller than before (`2026-10-11T06-47-53-fake`): coordinator-team-lanes 640 → 624 characters,
  wake-failed 554 → 534, wake-question 336 → 316, reassign 735 → 721, lanes-to-end 762 → 734; the same calls and
  requests, the same guidance.
- **Codex, 4 of 4 both times**: before (a7b9e6e, v45 fixtures, `2026-10-11T06-09-37-codex`, $0.252) it watched cards
  (`{"cards":[2,3,1],…}`, the lanes' cards listed); after (v46, `2026-10-11T06-41-15-codex`, $0.235) every last watch
  was `{"lanes":["all"],"wake":true}`. Hive's cost: team-lanes 6,304 → 4,349 characters (17 → 18 requests), wake-failed
  3,285 → 4,518 (10 → 9), wake-question 1,460 → 1,495 (7 → 7), reassign 6,501 → 5,782 (27 → 21); one sample each.
  Round 1's after run (`2026-10-11T05-01-03-codex`, $0.255) was also 4 of 4 with lane watches.
- **Claude Code**: not run: its test home isn't signed in.

## The Assistant leaves a message for a busy agent: fakes, Codex (its default model), fixtures v44–v45, 11 October 2026

#530: `hive_message_agent` leaves a watching or busy agent a message (typed at once into an idle or watching agent, its
watch carrying on; else with its next line, at the front of a wake that comes first), and coordinate-agents and run-lanes
say to use it rather than ask the user to paste. Fixtures v45 add **assistant-message-watching** (Coder reviews a card in
its loop and watches for it; the user's answer to the card's question is to reach Coder: it is passed by message, with no
new task, stop or request to paste, and Coder's watch carries on).
- **Fakes**: baseline `hb1-530-before` (v44 on main a669fc1 with the #530 code but its old tool descriptions and skills):
  75 of 75 pass. After round 1 (`hb1-530-after`, results `2026-10-11T01-09-28-fake`): 76 of 76, and no scenario's Hive
  cost changed but the new one's. After round 2's tool description (v45, `hb1-530-after2`, results
  `2026-10-11T02-23-02-fake`): 76 of 76.
- **Codex: 3 of 3 pass**, twice: round 1 (`2026-10-11T01-34-39-codex`, $0.149) and round 2
  (`2026-10-11T02-49-45-codex`, $0.202): assistant-message-watching, assistant-reply-decision (records the decision and
  doesn't message Coder, which has the answer), assistant-agent-watch. In the new scenario Codex also recorded the
  answer on the card and watched it.
- **Claude Code**: not run: its test home isn't signed in.

## Coordinator out of the box: fakes, Codex (its default model), Claude Code (sonnet), fixtures v43, 10 October 2026

#402 (Darren's decisions: adaptive habits, the team material in its own skill) folds the coordinator playbook into the
bundled guidance: a new Assistant skill **run-lanes** (lanes by files, builder and reviewer briefs, **one watch over the
whole team**: every unfinished lane's last card and any card in Review, waiting for the user or at a merge point, on any
change; a board sweep and the whole watch started again on each wake; changing a running lane; verifying claims);
**coordinate-agents** gains "Fit the setup" (light for one or two agents, run-lanes for three or more, pairs or
worktrees, or a wake about a card in a running lane; a one-line suggestion at most), the Done wording (the agent moves its
own merged card; the Assistant only when asked), "one watch at a time: a watch you start again lists everything you
still follow", and, while an agent asks the user, "before you end your turn, start your watch again over the other
work"; the **Coordinator** mode puts watching and verifying first. Hive's reply to the Assistant's `hive_lane start`
says when no watch of its covers the lane's last card.

Scoring (round 2, after HR1's review): a watch check reads the Assistant's **live watch** at the end of its turn (the
session's `watch`: a new watch replaces the last, so an earlier call proves nothing), which must cover the named cards on
any column move. Scenarios, with #325's scoring: **coordinator-team-lanes** (four agents, two lanes: run-lanes read, each
builder and reviewer briefed with card-loop, its cards and partner, ends its turn watching both lanes' last cards, no
"they'll tell you"), **coordinator-wake-failed** (woken by a failed review: reads it, sweeps, watches both lanes' ends
again, gives no verdict and writes no review card), **coordinator-wake-question** (woken by an agent's question: passes it
on, answers nothing, and watches both lanes again, the other lane too), **coordinator-reassign** (a card moved between
running lanes), **coordinator-follow-up** (a complete card placed in the lane owning its files) and
**coordinator-lanes-to-end** (both lanes followed through Hive's real wakes: Builder2's lane ends while it watches, it is
woken, sweeps and watches Coder's lane; that ends, it is woken again and says both are done). Every **mode-*-plans**
checks its cards are complete (80+ characters) and a decision reaches the user, and every **mode-*-coordinates** that one
card on one agent reads no run-lanes and starts no lane. The fixtures' lane agents aren't running, so nothing is in Doing
unless a scenario needs it; v38 makes coordinator-wake-question's lanes run as in life (Coder started and idle after
asking, Builder2 working on #3): with nothing running, Codex read both lanes as stalled and offered to restart Coder
rather than watch. The harness now stops what still runs from a scenario's folder after Hive closes (a command Codex
started through hive-progress outlived its session and held the folder, crashing the runner: Non-shipping #542).
- **Fakes**, v37 (baselines `hb1-402r2-before`, the fixtures on the guidance and code before #402, and `hb1-402r2-after`;
  results `2026-10-10T14-25-39-fake` and `2026-10-10T15-25-55-fake`): before, coordinator-team-lanes can't read
  run-lanes (it doesn't exist); every other scenario passes. After, all pass, lanes-to-end included (it acts out the two
  wakes). Performance → Compare: comparable, 53 **No change** (the agents' scenarios), 21 **Larger** (one sample a
  side): the Assistant's launch guidance is 696 bytes larger in Coordinator mode (the mode's habits, run-lanes in the
  skills' catalog) and 266 in the other modes (the catalog). v38's wake-question passes on the fakes
  (`2026-10-10T16-47-16-fake`). v39 makes lanes-to-end count an idle Assistant as its turn ending only once the
  wake's turn was seen working, or after three idle polls (once, after main was merged, it read the moment Hive types a
  wake in as the end); it then passed 4 of 4 on the fakes (`2026-10-10T19-59-35-fake` to `…T20-01-01-fake`).
- **Codex, before** (v37, `2026-10-10T15-06-00-codex`, $0.33): team-lanes briefed all four and ended watching both lane
  ends, but had no run-lanes to read; **wake-failed** ended watching #1 and #2, not Builder2's lane; **wake-question**
  ended its turn with no watch; **lanes-to-end** never watched both lanes and timed out with both still running;
  reassign and follow-up pass.
- **Codex, after** (v37, `2026-10-10T16-11-15-codex`, $0.59): team-lanes, wake-failed, reassign, follow-up and
  **lanes-to-end** (all six checks: two real wakes, a sweep, both lanes ended, the user told) pass, as do
  assistant-dispatch and assistant-new-lane. **wake-question** with the lanes not running ended with no watch (1 run here,
  3 more with the sharper "start your watch again" line, `2026-10-10T16-25-48-codex`, $0.12: 0 of 4 watched both lanes;
  it read both lanes as stalled). With v38's running lanes (`2026-10-10T16-50-01-codex`, 3 runs, $0.11) it passed the
  question on and answered nothing in all 3, and ended every turn watching both lanes: once on both lanes' last cards
  (the check passes), twice on the asking card #1 and Builder2's running #3 (both lanes covered, but not by their last
  cards as run-lanes says: the check fails). Samples, not rates.
- **mode-coordinator-coordinates under Codex** fails "launched in Coordinator mode": the check reads Claude Code's
  instructions file, which a Codex launch doesn't write (Non-shipping #520). Its other checks pass (no run-lanes and no
  lane for one card).
- **Claude Code**: not run: its test home isn't signed in. Codex spend for #402: about $1.84 in round 1 and about $1.15 in
  round 2 (two runs that crashed on a held folder before #542's fix aren't counted).

**Round 3** (HR1's second review: the strict end-card check kept; Claude Code's test home available). Fixtures v40
score a watch by what it wakes on: column moves, comments and verdicts (a column-only watch misses a question and a
failed review left in Review), and a board sweep only when it comes after the first watch (a wake's turn). v41 runs the
lanes in lanes-to-end too (both builders working on their current cards) and its setup helpers fail the scenario
(`setup: …`) when an agent isn't ready or working, with the environment problem when the screen shows one (they had
answered Claude Code's trust question on the raw screen and with Down then Enter, which can quit it, #218: Builder2's
"exited 1"). The harness stops only what is the scenario's own: its Hive's process tree (taken before it closes, by pid
and start time) and what names its folder at a path boundary (never `scenario-2`'s) and started after it
(`tests/e2e/folderProcesses.cjs`). Guidance: run-lanes says a lane's last card stays in the watch while an earlier one
waits for the user; coordinate-agents' question bullet, the one Codex reads on a wake, says "each running lane by its
last card (run-lanes)". Product: the Assistant's card wake ends, while lanes run, with "Lanes are still running
(hive_lane list): before you end your turn, watch them all again in one watch, each lane by its last card
(run-lanes)." (v42 checks lanes-to-end's first real wake says so; v43's simulated wakes end the same way).
- **Codex, question wake, strict end-card check:** v40 (coordinate-agents without the end-card words) 1 of 3, watching
  the asking card #1 and #3 (`2026-10-10T20-18-12-codex`, `…20-19-15…`, `…20-20-12…`, $0.11); v41 with them 3 of 3
  (`…20-36-21…`, `…20-37-16…`, `…20-38-07…`, $0.12); v42 (the simulated wake not yet ending as Hive's does) 1 of 3
  (`…20-48-05…`, `…20-49-25…`, `…20-50-09…`, $0.12); v43 3 of 3 (`…20-54-51…`, `…20-55-39…`, `…20-56-26…`, $0.14).
  Every run passed the question on and answered nothing. wake-failed v43 passes (`…20-57-14…`); lanes-to-end with
  running lanes passes, v41 and v42 (`…20-41-11…`, `…20-50-59…`).
- **Claude Code (sonnet), question wake** v41, the lanes running (Builder2 working, Coder idle): 0 of 3 ended watching
  (`2026-10-10T20-38-55-claude-code`, `…20-39-33…`, `…20-40-15…`, $0.27): it read no skill on the wake, passed the
  question on and said its watch had ended, then stopped. That is what the lanes-running wake tail is for; its test
  home's sign-in then expired ("Login expired · Please run /login"), so the v43 runs stopped at setup, reported as the
  environment (`…20-58-08…`, `…20-58-53…`), and lanes-to-end under Claude Code too (`…20-43-06…`). HR1's earlier
  Claude run of lanes-to-end (v38 fixture) passed 6 of 6. Claude Code with the tail: to run once the home is signed in.
- **Fakes**: every coordinator scenario passes on v43 (`2026-10-10T20-53-34-fake` and the runs before it).
- Round-3 model spend: Codex about $0.80, Claude Code about $0.52.

## The Assistant lists lanes at Look: fakes, Codex (its default model), fixtures v35, 10 October 2026

#500 (Darren's decision: at Control level Look the Assistant can list lanes, a read): `hive_lane` joins the Assistant's
tools at every level (`ASSISTANT_LANE_TOOLS`), and its description at Look and advise says only list works; the Agent
API already refused start, join and end below Control agents (403). Fixtures v35 add **assistant-look-lanes** (Look, a
running lane, "which lanes are running and where are they?": it lists the lanes, starts or ends none, and names the
lane's current card).
- **Fakes** (baselines `hb1-500-before`, the v35 fixtures on the code before #500, and `hb1-500-after`; results
  `2026-10-10T08-41-53-fake` and `2026-10-10T10-06-29-fake`): 68 of 68 pass both times. Performance → Compare:
  comparable, 68 **No change**. The fake doesn't check Claude Code's permission list, so it can't show the gap.
- **Codex: 2 of 2 pass** (`2026-10-10T10-28-46-codex`, $0.084): assistant-look-lanes and assistant-new-lane. On the old
  code assistant-look-lanes passed too (`2026-10-10T09-01-01-codex`): Codex doesn't gate Hive's tools by the
  Assistant's trusted list, so the gap was Claude Code's (a permission prompt at Look).
- **Claude Code**: not run: its test home isn't signed in.

## Card-loop rounds and wait as settings: fakes, Codex (its default model), fixtures v34, 10 October 2026

#412 (Darren's decision: Rounds 10, Wait 6h, set per workspace, a project can override, a prompt's own values win): a
lane started without rounds or a wait takes the project's, else the workspace's settings. card-loop gives `hive_lane
start` only the values its request named and uses the lane's from the reply; coordinate-agents briefs a lane with rounds
and a wait only when the user gave them. Fixtures v34 add **card-loop-lane-defaults** (the workspace's settings 7 and
3 h, a prompt naming neither: the lane has 7 and 180 minutes, and the verdict watch waits 180) and
**card-loop-lane-override** (the same settings, a prompt with "Rounds: 3. Wait: 1h.": 3 and 60).
- **Fakes** (baselines `hb1-412-before`, the v34 fixtures on the code and skills before #412, and `hb1-412-after`;
  results `2026-10-10T07-30-17-fake` and `2026-10-10T07-49-28-fake`): before, the two new scenarios can't set the
  workspace's settings (no `workspace:setLoops` yet); the other 63 pass. After, all 67 pass. Performance → Compare:
  comparable, 65 **No change**, the two new ones incomplete (no before sample).
- **Codex: 6 of 6 pass** (`2026-10-10T08-08-30-codex`, $0.41): card-loop-lane-defaults (7 rounds, a 180-minute wait),
  card-loop-lane-override (3 and 60), card-loop-lane, card-loop-lane-join, card-loop-rounds and assistant-new-lane.
- **Claude Code**: not run: its test home isn't signed in.

## Hive wakes a loop's reviewer and builder: fakes, Codex (its default model), fixtures v33, 10 October 2026

#405 (Darren's decision: on by default for cards with a reviewer, with a per-project opt-out): Hive wakes a card's
reviewer when it arrives in Review and its builder on a verdict, with no card watch of theirs (`main/loopWakes.ts`).
card-loop gains a paragraph: Hive may wake the agent itself, act on that line as on a watch's, and watches are still how
it waits. Fixtures v33 add **card-loop-loop-wake** (a reviewer with no watch given Hive's loop-wake line reviews the card
and waits for the next).
- **Fakes** (baselines `hb1-405-before`, the v33 fixtures on the code and skill before #405, and `hb1-405-after`;
  results `2026-10-10T05-47-46-fake` and `2026-10-10T06-06-47-fake`): every check passes both times; Performance →
  Compare: comparable, all 65 **No change**.
- **Codex: 5 of 5 pass** (`2026-10-10T06-25-12-codex`, $0.35): card-loop-loop-wake reviewed the card and ended watching
  the next; card-loop-blocked, card-loop-return, card-loop-recurring-review and card-loop-rounds pass with the new
  paragraph too.
- **Claude Code**: not run: its test home isn't signed in (as for #481).

## A blocked card stays in its loop: fakes, Codex (its default model), fixtures v32, 10 October 2026

#481 (Darren's decision: a blocked card stays in its lane, paused; the reviewer never drops it): a card that becomes
blocked no longer leaves an agent's watch (#420 released it, so on #468 the reviewer dropped a card its builder had
blocked to ask a question, and nobody reviewed it when it came back). card-loop says a blocked card is paused, not gone:
the loop doesn't take the next card meanwhile. Fixtures v32 add **card-loop-blocked**, #468 replayed: the reviewer has
just failed #1 and waits for its next round; once it is watching, its builder blocks #1 to ask the user, 15 s later
unblocks it and returns it to Review; nobody prompts the reviewer, and it must review #1 (woken by Hive) without moving
on to #2. The harness gained `fakeWakes` (the fake Claude Code's answer to a wake) and `fakeSkips(provider)`.
- **Fakes** (baselines `hb1-481-before-v32`, the v32 fixtures on the old watch code and skill, and `hb1-481-after-v32`;
  results `2026-10-10T04-32-47-fake` and `2026-10-10T05-01-38-fake`): before, card-loop-blocked **fails** as #468 did
  (the block ends the watch, "Ended Coder (alpha)'s watch on it: the card is blocked", and the returned card is never
  reviewed); after, all 64 pass. Performance → Compare: comparable, 63 **No change**, card-loop-blocked incomplete (its
  before sample timed out).
- **Codex, on the old code: card-loop-blocked fails** (`2026-10-10T04-56-06-codex`, $0.051): released by the block, the
  reviewer moved on to #2 and never reviewed #1.
- **Codex, with #481: 2 of 2 pass** (`2026-10-10T05-19-49-codex`, $0.15): card-loop-blocked reviewed #1 once Hive woke
  it, without moving on first; card-loop-released still drops a reassigned card and goes on. Under v31 (the scenario
  without the block mid-watch) card-loop-rounds and card-loop-recurring-review passed with it too
  (`2026-10-10T03-49-51-codex`).
- **Claude Code (sonnet)**: not run: its test home isn't signed in (`2026-10-10T05-22-30-claude-code`, skipped for the
  environment).

## A bulk board change is one change: fakes, Codex (`gpt-5.6-luna`), Claude Code (sonnet), fixtures v29, 9 October 2026

#488 (Darren's decision): the Assistant's `hive_update_tasks` counts as one of its 30 changes for a message, however
many cards it has, so a bulk move never stops part-way. Hive enforces it (`assistantControl.admit`); the coordinate-agents
skill's "Bulk moves" line and the tool's description now say so instead of "each card counts".
- **Fakes** (baselines `b3-488-before` on `540fbd2`, clean, and `b3-488-after`, the change uncommitted; results
  `2026-10-09T22-01-58-fake` and `2026-10-09T22-39-09-fake`): every check passes both times, and Performance → Compare finds all
  61 scenarios **No change** (the description is shorter by a sentence, within 1%).
- **Codex: 2 of 2 pass** (`2026-10-09T22-23-11-codex`, $0.013): assistant-bulk-move moved the five cards with one
  `hive_update_tasks` call; assistant-dispatch started and followed its card.
- **Claude Code (sonnet)**: assistant-bulk-move **passes** (one call, $0.114). assistant-dispatch fails "the agent did it"
  (the card still in Doing when the run ends, after the Assistant started it and watched it), three times, **also without
  this change** (`22-57-43`, on `540fbd2`): not from #488, now #498.

## Asking before taking the card: fakes, Codex (`gpt-5.6-luna`), Claude Code (sonnet), fixtures v29, 9 October 2026

#438 (Darren's option 3): work-on-card has an agent take the card (move it to Doing, which gives it to itself) before it
asks the user a question about it, and clear `blocked` once a decision answers it. A card counts as an agent's for the
decision line (#401) only in Doing with it, so a question asked with the card in Todo left the decision nobody's.
Fixtures v29 add **decision-before-taking**: decision-while-waiting with the card in Todo and no agent, the decision
recorded once the turn ends wherever the card is.
- **Before, a model** (old skill, results `2026-10-09T19-55-23-codex` and `-claude-code`): **Codex failed** exactly as the
  card says: it read the skill and the card, asked, and left the card in Todo with no agent, so Hive told no one and it
  never carried on. **Claude Code (sonnet) passed**: it moved the card to Doing before asking.
- **After** (`2026-10-09T19-58-54-codex` and `-claude-code`; decision-before-taking, decision-while-waiting,
  work-on-card and card-decision): **Codex 4 of 4** ($0.071) and **Claude Code 4 of 4** ($0.397). In
  decision-before-taking both took the card before the decision, were told once, read the card, wrote "Welcome back!"
  and moved the card to Review.
- **Fakes** on one source (`7ce2a15` plus the change), the before run with only work-on-card put back (baselines
  `b3-438-before-v29` and `b3-438-after`, results `2026-10-09T20-49-26-fake` and `2026-10-09T20-31-25-fake`): every
  check passes both times, and Performance → Compare finds all 61 scenarios **No change** (the guidance revision, tool
  list and replies are unchanged; the skill grows by one step). A v28 baseline before the scenario was added
  (`b3-438-before`) isn't comparable with v29 runs.

## Hive sets the agent's folder: no git worktree of its own; fakes, Codex (`gpt-5.6-luna`), Claude Code (Haiku, Sonnet), fixtures v27–v28, 9 October 2026

#476 adds one line to agents' session contract; #482 (Darren) made a worktree the user asks for theirs: "Hive sets your
folder: make no git worktree to work in unless the user asks (else ask for an agent with its own). Merge or remove a
subagent's worktree before you finish." **worktree-isolation** checks that the agent makes no worktree of its own (git's
list unchanged), leaves the project folder as it was and leaves the board alone.
- **v27** asked outright for "a separate git worktree on a new branch". Without the rule every model made one (Codex 2 of
  2, `2026-10-09T13-58-13-codex`; Haiku 2 of 2, `2026-10-09T13-57-15-claude-code`). With the first wording ("don't make
  git worktrees to work in") Codex made none (`2026-10-09T14-32-41-codex`), Haiku still did (2 of 2,
  `2026-10-09T14-31-39-claude-code`), and Sonnet made none in 1 of 2 (`2026-10-09T14-33-52-claude-code`). Asking
  outright is now the user's call (#482), so v28 tests the agent's own initiative instead.
- **v28** asks it to "keep this folder exactly as it is while you try it", with no worktree mentioned. All runs below had
  no source change while they ran.
  - **Fakes**: without the rule (`baselines/b1-476-before-v28`, guidance `c484fe62…`) and with it
    (`results/2026-10-09T15-15-56-fake`, `985744b0…`), 187 pass and 43 skip both times, check for check. Performance →
    Compare: no regressions, no change in quality, each agent launch +171 bytes of guidance (43 launches), nothing else
    outside the spread.
  - **Model trials**, 2 samples each, without the rule and then with it: Codex `gpt-5.6-luna` (`2026-10-09T15-12-09-codex`,
    `…T15-32-12-codex`), Claude Code Haiku (`…T15-13-28-claude-code`, `…T15-33-54-claude-code`) and Sonnet
    (`…T15-14-27-claude-code`, `…T15-34-51-claude-code`): every check passed in all 12 samples ($0.25 in all). Asked only to
    keep the folder as it is, none made a worktree on its own even without the rule, so these trials show the rule costs
    nothing and changes nothing here, not that it is needed: it stays for agents that would (a subagent's isolation, an
    agent told to work on several things at once).

## A watch already met answers at once; a reviewer asks for the next round: fakes, Codex, Claude Code (Haiku), fixtures v25–v26, 8 October 2026

#434 makes a card watch whose column condition already holds answer at once, also one for a move into the column (a
builder's "verdict, or into Passed" on a card already in Passed had waited six hours). The reviewer's wait for a failed
card's next round now asks for it with `fresh: true` (`hive_wait_for_tasks`, `POST /v1/tasks/wait`), and card-loop's
reviewer step says so. Fixtures v25 (v26 once merged with main) give **card-loop-recurring-review** a check that the reviewer ends its turn watching
for the card to come back (its fake watches with `fresh` before failing it).
- **Fakes**, v25, before (`2867cd2` with the final fixtures) and after, neither source changed while it ran (baselines
  `b2-434-before` and `b2-434-after`): 57 of 58 before, the new check failing (the old code ignores `fresh`, so the
  watch answers Already and the reviewer ends its turn not watching); 58 of 58 after. card-loop +50 bytes; the tool list
  +6.4 KB over the whole run (the `fresh` argument and its sentence).
- **Codex: 6 of 6 pass** (its default model, CLI 0.161.0; `2026-10-08T18-46-06-codex`, $0.398): card-loop-recurring-review,
  card-loop-return and card-loop-already-in-review, twice each; the reviewer ended its turn watching with `fresh`.
- **Claude Code (Haiku): 6 of 6 pass** (CLI 2.1.294; `2026-10-08T18-52-08-claude-code`, $0.055): the same scenarios.

## A new lane in a new conversation: fakes, Codex (`gpt-5.6-luna`), fixtures v22–v25, 8 October 2026

#437 gives `hive_prompt_agent` a `newConversation` (the agent's conversation ends, kept in the Sessions tab, and a new
one starts on the task, with no handover), and adds a bullet to coordinate-agents: a new lane's brief goes in one
`hive_prompt_agent` call with `newConversation`, not `hive_start_task`, and the conversation is kept within a lane. The
tool's description gets the parameter's meaning only. Fixtures v23 (v25 once merged with main) add **assistant-new-lane** (Coder idle after its last
lane; "start its next lane on #1"): one call, Coder runs in a new launch and session, and its last conversation stays
listed. The fake Codex now starts on a first prompt given on its command line, as Codex does (it ignored it before, so a
start with a prompt never ran under it).
- **Fakes**: before (`631738f`, v22, baseline `b3-437-before`) and after, neither source changed while it ran: v22 with
  the first wording (`b3-437-after`), every check the same; v23 with the final wording (`b3-437-after-v23`), all 58 pass,
  and the 57 scenarios both ran have the same checks. Sizes: the Assistant's skills +602 bytes (19,481 → 20,083), its
  tool list +167 (22,705 → 22,872); project agents' sessions are unchanged. Merged with main (#430, #401, #426, whose
  fixtures were v24): v25, all 59 pass (`b3-437-after-v25`); the Assistant's skills are 20,173 bytes with #426's line.
- **Codex**: with the first wording, assistant-new-lane **failed** (`2026-10-08T16-32-22-codex`): the Assistant started
  the lane's card with `hive_start_task` (the skill's "A card" bullet), in Coder's current conversation. The bullet now
  says a lane, even of one card, goes through `hive_prompt_agent` with `newConversation`, not `hive_start_task`. Then
  **2 of 2 pass** (`16-38-04`, `16-39-51`, $0.015), and assistant-dispatch still starts a plain card with
  `hive_start_task` (`16-38-04`); assistant-agent-watch passed too (`16-32-22`). After the merge, v25: passes again
  (`17-22-58`, $0.011).
- **Claude Code**: not run (its test home isn't signed in).

## A card that left a loop's watch: fakes, Codex (`gpt-5.6-luna`), fixtures v22, 8 October 2026

#420 releases a card from the watch of an agent whose part in it ended (given to another agent, reviewed by another, or
blocked) with a line ("[Hive] #1 was reassigned to Other (your watch on it ended). Your card watch has ended: drop it from
your list and carry on with your next card."), and adds a line to card-loop: such a wake means drop the card and carry
on, without asking. Fixtures v22 add **card-loop-released** (a reviewer with #1 then #2 gets that line for #1).
- **Fakes**, v22, before (`4d9337a`, with the final fixtures, in a worktree of its own) and after, neither source changed
  while it ran (baselines `b2-420-before` and `b2-420-after`): Performance → Compare finds them comparable, every scenario
  the same, all checks passing both times. card-loop's text read grows +259 bytes; the tool list is unchanged.
- **Codex: 2 of 2 pass** (`2026-10-08T07-55-04-codex`, $0.030): told #1 was reassigned, the reviewer read card-loop, went on
  to #2 (began its review), didn't wait on #1 again and didn't stop to ask; card-loop-rounds still asks at the limit.
- **Claude Code**: not run (its test home isn't signed in).

## The user's replies told to the Assistant: fakes, Codex (`gpt-5.6-luna`), fixtures v21, 8 October 2026

#418 tells the Assistant's watches when the user answers an agent in its pane ("[Hive] The user replied to Coder on #1:
"C, the hive cell"…"), adds a line to coordinate-agents (such a reply is what the user told the agent: don't ask again; a
decision goes on the card), and a clause for the Assistant only in the two watch tools' descriptions. Fixtures v21 add
**assistant-reply-decision** (the Assistant gets that line for a card whose agent asked the user to pick an icon).
- **Fakes**, v21, before (`7456ea1`, #416 without #418, with the final fixtures, in a worktree of its own) and after,
  neither source changed while it ran (baselines `b2-418-before` and `b2-418-after2`): Performance → Compare finds them
  comparable, every scenario the same, all checks passing both times. Sizes: the Assistant's skills +293 bytes, its tool
  list +178 (the clause is the Assistant's only: project agents' tool list is unchanged).
- **Codex: 2 of 2 pass** (`2026-10-08T06-03-45-codex`, $0.021): told the user's reply, the Assistant recorded "C, the hive
  cell" as the card's decision, didn't ask the user again and didn't type it into Coder; assistant-dispatch still passes.
- **Claude Code**: not run (its test home isn't signed in).

## Agent watches: fakes, Codex (`gpt-5.6-luna`), fixtures v19–v20, 8 October 2026

#416 gives `hive_wait_for_agents` a `wake` (an **agent watch**: the Assistant, or an agent, ends its turn and is woken
when an agent finishes, waits for the user or stops), gives the tool to project agents too, and changes coordinate-agents
(an agent watch rather than waiting call after call; a card watch for work on a card) and the Assistant's always-present
line (a watch wakes it too). Fixtures v19 added **assistant-agent-watch** (Coder busy with work that has no card; "tell me
when it's done"): it passes only when the Assistant ends its turn watching (status `watching`), not waiting in the call.
v20 lets assistant-dispatch follow its card with a card watch on that card as well as with `hive_wait_for_agents`.
- **Fakes**, v19, before (main `21c2ff5` with the final fixtures, in a worktree of its own) and after, neither source
  changed while it ran (baselines `b2-416-before-r2b` and `b2-416-after-r2b`): Performance → Compare finds them
  comparable. assistant-agent-watch fails before (main ignores `wake` and holds the call until Coder is done) and passes
  after; every other check is the same. Project agents' tool list grows **+10.3%** (+1,321 bytes a session: the tool is
  new to them); the Assistant's grows +463 bytes (the longer description), its instructions +66 and its skills +352.
  The runs' times went up 2–4 s across the board; three repeats of two scenarios on each side all took 15 s, so that was
  the machine's load.
- **Codex: 2 of 2 pass** under v20 (`2026-10-08T04-23-27-codex`, $0.018): the Assistant read coordinate-agents, watched
  Coder with `wake`, ended its turn watching without polling, and was woken when Coder finished; dispatching a card, it
  followed the card with a card watch. Under v19 (`04-03-07`) assistant-dispatch failed only because its check wanted
  `hive_wait_for_agents` for card work, which the skill now sends to a card watch: v20.
- **Claude Code**: not run (its test home isn't signed in).

## Card decisions: fakes, Codex (`gpt-5.6-luna`, CLI 0.160.1), Claude Code (sonnet), fixtures v18, 7 October 2026

#357 adds a card's **Decisions** and the "new decision" flag on an agent's replies, and changes work-on-card (read decisions
first; read the card again as part of moving it to Review), review-agent-work (a decision the work ignores is blocking),
card-loop (a reviewer back in Review reads the card with `comments: 1`) and coordinate-agents (record the user's decisions
as decisions), plus two tool descriptions (`hive_update_task` `decision`, `hive_read_task` decisions first). Fixtures v16
added **card-decision** and **review-against-decision**, v17 **review-decision-next-round**, v18 loosened card-decision's
model-only file check (it wanted the original `<input name="user">` markup).
- **Fakes**, one source, unchanged while each ran, the before run with only #357's guidance put back (the four skills and
  the two descriptions; baselines `b5-357-before-v18` and `b5-357-after-v18`, results `2026-10-07T13-09-06-fake` and
  `2026-10-07T13-30-28-fake`): the same checks pass both times (154 pass, 40 skipped, 0 fail; the fakes act the decision
  scenarios out by script, so they show Hive's side: the flag in the reply, the board, the costs). The session contract
  and every tool reply are unchanged; the tool list grows **+3.0%** (204,284 → 210,458 bytes over the run); skill text
  read grows +626 bytes in each of the two scenarios that read work-on-card's edited copy.
- **Codex: 3 of 3 pass** (`2026-10-07T13-46-14-codex`, $0.036): the builder read the card again after the decision and
  before Review, the reviewer read the card in full and failed work that ignores the decision, and in round 2 it read the
  card in full before its verdict. (A first try of review-decision-next-round, `12-43-37`, hung for its 6 minutes with no
  tool call after "I'm continuing the card loop…"; it passed when run again, `12-52-39`.)
- **Claude Code (sonnet): 2 of 3 pass** (`2026-10-07T13-44-27-claude-code`, $0.374). Both reviews pass. In card-decision it
  moved the card to Review 6 s after the decision without reading the card again; that reply carried the flag (the card was
  its own when the call began), it read the card at once, changed login.html to match ("Aligned with the new decision")
  and said so, leaving the card in Review rather than moving it back to Doing for the fix. The first trial
  (`12-56-21`, before the flag counted the cards an agent had when a call began) had no flag on that reply and didn't
  notice the decision.

## Long commands get a title: fakes, Codex (`gpt-5.6-luna`, CLI 0.160.0), fixtures v11, 6 October 2026

#251 changed the session contract's hive-progress line to `hive-progress --title "<what and why, in a few words>" --
<command>` (and "shows them to the user"); fixtures v11 added the model-only check **gave the run a title for the user**
to progress-long-command and progress-background. #272 measured it cleanly, on one source (`7030a62`, unchanged while
each run ran), the before run with only that line put back as it was:
- **Fakes** (work-on-card and the three progress scenarios; baselines `b6-272-before` and `b6-272-after`, results
  `2026-10-06T13-48-37-fake` and `2026-10-06T13-50-39-fake`): all pass both times, and Performance → Compare finds them
  comparable. The launch guidance grows **+53 bytes** (1,506 → 1,559 characters of the contract; +41 with wrapping off,
  progress-off), so each scenario reads *Larger or worse*; no check passed or ran less often. Everything else is
  unchanged. The fakes skip both "ran through hive-progress" and "gave the run a title": they show the size, not what a
  model does with the line.
- **Codex: 2 of 2 pass** (`results/2026-10-06T13-52-42-codex`, $0.003), one sample each: both ran
  `hive-progress --title "Run full npm test suite" -- npm test` (the background one through `exec_command` with a 1 s
  yield).
- **Claude Code** (sonnet, CLI 2.1.291, its test home): no result. Claude Code answered the prompt with "Login expired ·
  Please run /login" at once (`2026-10-06T13-54-07-claude-code`; the 6 Oct 02:05 and 00:18/00:24 tries, on 2.1.290, were the same),
  and the harness waited out its 6 minutes. The test home needs signing in again, by hand.

## On Hold and Passed: fakes, Codex (`gpt-5.6-luna`, CLI 0.160.0), fixtures v10, 6 October 2026

#170 adds the On Hold and Passed columns: the session contract, card-loop, review-agent-work, work-on-card, merge-ready and
coordinate-agents now say a reviewer moves a passing card to Passed, Done means merged and On Hold is the user's. Fixtures
v10 replace **standing-done** with **review-passed** and add **merged-to-done** and **hold-skipped**; **review-interrupted**
no longer offers Done, and **card-loop-two-cards**' passed card is in Passed.
- **Fakes**, before (`card170-before-claude` / `-codex` baselines, results `2026-10-05T23-18-53-fake` and
  `2026-10-05T23-20-02-fake-codex`, v9: 35 of 35 pass) and after (`2026-10-05T23-43-40-fake` and
  `2026-10-06T00-06-02-fake-codex`, v10: 37 of 37 pass). The versions differ, so Performance → Compare only shows them;
  over the 34 scenarios both ran: the session contract +5.5% (about 80 characters a launch), skills +1.0%, the hive tools'
  list +2.1%, tool replies unchanged.
- **Codex: 8 of 8 pass** (`results/2026-10-06T00-07-15-codex`, $0.08): work-on-card, review-card, review-interrupted,
  done-card-more-work, **review-passed** (the reviewer moved it to Passed with its verdict), **merged-to-done**,
  **hold-skipped** (took the Todo card, left the On Hold one alone) and card-loop-two-cards.
- **Claude Code** (CLI 2.1.290, its test home): no result. Two tries (`2026-10-06T00-18-23-claude-code`,
  `2026-10-06T00-24-57-claude-code`) timed out with no reply and no tokens used, the environment rather than the change.

## Card loops: Codex (default `gpt-6.1-sol`, CLI 0.160.0), fixtures v9, 5 October 2026

The card-loop scenarios only (#143: wake lines name a dependency's agent and say Done isn't merged; the skill covers
dependency watches, Done ≠ merged and always re-arming), two samples each, on Codex's default model now that #192
prices it (`results/2026-10-05T05-23-51-codex`, $0.55 API-equivalent):
- **Every behaviour check passes, 8 of 8 samples**: rounds asked the user at the limit, recurring went back for round
  three, recurring-review failed it marking the finding as recurring, disputed asked the user.
- **"read the card-loop skill" fails in 7 of 8, a measuring gap, not the agents**: each sample read it, through a
  code-mode script whose output comes back JSON-escaped, which the harness's `name:` line check misses (#198).
- Fake runs before and after the change (`card143-before-claude`/`-codex` baselines, results `2026-10-05T04-49-10-fake`
  and `2026-10-05T04-57-32-fake-codex`): 33 of 33 pass both times; skill bytes +2.5% (the longer card-loop skill).

## Long commands through hive-progress: Codex (`gpt-5.6-luna`, CLI 0.160.0) and Claude Code (default model, CLI 2.1.289), fixtures v9, 5 October 2026

The new **progress-long-command**, **progress-background** and **progress-off** scenarios and **work-on-card**, two
samples each, after the session contract got its hive-progress line (#167; on by default, off in Settings):
- **Codex: 8 of 8 pass** (`results/2026-10-05T02-19-13-codex`, $0.03): `hive-progress -- npm test` in each "on" run (the
  background one through `exec_command` with a 1 s yield, so it went on in the background); plain `npm test` with the
  setting off.
- **Claude Code: 8 of 8 pass** (`results/2026-10-05T02-24-06-claude-code`, $0.86 API-equivalent): the same, through
  PowerShell (the transcript's command doesn't show whether it was run in the background).

## Card loops: Codex (`gpt-5.6-luna`, CLI 0.160.0) and Claude Code (default model, CLI 2.1.289), fixtures v8, 5 October 2026

The card-loop scenarios only (#173), two samples each, after the skill's rounds became "a round is one build and its
review; at **rounds** failed reviews, ask" and stopping to ask became always `hive_notify`:
- **Codex: 8 of 8 pass** (`results/2026-10-05T01-40-53-codex`, $0.10), **card-loop-rounds** 2 of 2 included.
- **Claude Code: 8 of 8 pass** (`results/2026-10-05T01-49-19-claude-code`, $1.52 API-equivalent).

On the way there (Codex, same four scenarios): with the new count but a prompt saying "it is in round 2", one rounds
sample still read it as "do round 2's fix" (`results/2026-10-05T01-20-09-codex`); and **card-loop-disputed** failed
2 of 2 (`results/2026-10-05T00-58-32-codex`): one reviewer found a real new bug (fixture v7's `sync.js` makes three
attempts while the card said "retry three times", now "try up to three times"), the other stopped but asked in a card
comment instead of `hive_notify`.

## Card loops: Codex (`gpt-5.6-luna`, CLI 0.160.0), fixtures v7, 4 October 2026

The card-loop scenarios only (#163), two samples each, against the card-loop skill before and after its "a finding that
comes back" rule ($0.17 API-equivalent in all):
- **card-loop-recurring**, **card-loop-recurring-review**, **card-loop-disputed**: 2 of 2 pass after the change
  (`results/2026-10-04T20-51-42-codex`). The two recurring ones also pass 2 of 2 before it
  (`results/2026-10-04T21-05-26-codex`): this model didn't stop early under the old rule either, so these runs show no
  regression rather than the change's effect.
- **card-loop-rounds** fails 2 of 2 both before and after (`results/2026-10-04T21-01-45-codex`): told *rounds: 2* with
  two failed reviews, the builder sends the card round three instead of asking. By the skill's count (each time it goes
  back to Review after failing) the card has had one round, so the scenario and the skill's counting disagree (#173).

The default Codex model (`gpt-6.1-sol`) has no price in `prices.ts`, so a trial with it reports no cost and the budget
stops the run after one trial: use `--model gpt-5.6-luna`, or `--allow-unknown-cost`.

## Codex (`gpt-5.6-luna`, CLI 0.160.0, its test home, Full access)

**20 of 20 pass** under fixtures v2 (`results/2026-10-03T04-44-06-codex`; $0.18 API-equivalent, on a subscription
plan). Its run has guidance revision `63db94808e669a5e`, the same as now, but two pieces of its provenance can't be
recovered:
- Its source fingerprint (`05380a152540`) was taken by the earlier method, which hashed untracked files' names but not
  their contents, so it can't be matched to the current source.
- Its skill revisions were read before setup, so edited-skill and missing-skill don't record what their sessions were
  given.

It wasn't re-run just to refresh them (no paid re-run for a provenance-only change). The next Codex run records both,
and checks v3's delivery checks. That run included:
- **raw-api**: the script ran, listed alpha's card, was refused for beta, and printed no token;
- **assistant-dispatch**: `hive_start_task` worked, then `hive_wait_for_agents`, and the agent finished the card;
- the three new cases: **pick-up-named**, **done-card-more-work** and **progress-log**.

Under fixtures v1, two Codex runs failed and passed when repeated:
- **review-interrupted**: it moved the card to Done after its review ended, before the wording fix below.
- **edited-skill**: it hung for 6 minutes with no tool calls.

## Claude Code: not yet run under fixtures v2

The trials now run Claude Code only in its own test home (`%LOCALAPPDATA%\hive-test\claude`, never the user's
`~/.claude`). That home isn't signed in yet, so `--provider claude-code` prints a skip. Signing in is a one-time step
by hand (README.md).

The earlier Claude runs (fixtures v1, Haiku, CLI 2.1.288; $2.92 over 4 runs) used the user's own Claude home, so its
skills, plugins and settings were part of the run. They also counted hive calls from the transcript. They aren't a
baseline. They're kept below only for what they showed:

- Once Haiku had read a skill, it followed it: work on a card, reviews, fixes, a standing Done instruction,
  prioritising, pick-up, an edited skill, and the Assistant's dispatch and plans.
- Haiku chose skills from their descriptions less reliably:
  - **wrap-up**: re-ran tests it was told had passed.
  - **lasting-decision**: took "remember for every project" as context for the conversation.
  - **plan-only**: used Claude Code's own plan mode.
  - **missing-skill**: skipped Doing in 2 of 3 runs.
- Before the wording fix, it moved an interrupted review's card back to Review and passed it.

## What changed because of the trials

**Guidance**:
- **review-agent-work skill and session contract**: when a card leaves Review during a review, the card is left
  where it is, neither moved back nor on to Done.
- **Board rules**: now separate short lines in the session contract. "Fix or continue" routes to work-on-card.
- **handover skill**: test results the user gives count, so they aren't re-run.
- **split-work description**: also triggers on "how to split work between agents".
- **`hive_start_agent`**: says to use `hive_start_task` for a card.
- **#107**: whether Hive should refuse an agent finishing a card another agent has in Doing (a product decision).

**Harness** (each with unit tests):
- isolated CLI homes;
- the server-side call log;
- strict read evidence;
- token-value checks;
- outcome checks that fail on no-op, failed or out-of-order calls;
- prompts confirmed by the transcript;
- trust questions answered for agents the Assistant starts;
- a fake Codex rollout, so Codex resumes are real.

## Not covered

- **Claude Code under fixtures v2**, until its test home is signed in.
- **Packaged builds.** The trials use the dev build; packaged delivery is covered by `npm run e2e -- packaged-mcp`.
- **The Assistant answering a question an agent asks the user.** A real agent has to reach a question first, which isn't
  deterministic. The tool contract and `coordinate-agents` say never to answer one, and Hive refuses prompts to an agent
  that is waiting.
- **A real npm-installed Codex** (#103 used the fake `.cmd`).
- **Stronger models, and repeat runs for pass rates.** Run with `--model` and `--only` several times when one matters.

## Measured: what each session is given about Hive

From real launches (`node tests/scenarios/measure.cjs`, with the fake CLIs; source `edb813e` with changes
`5baebcf8fd8c`), in UTF-8 bytes; ≈ tokens is bytes / 4 (no tokenizer was run).
- **All 32 combinations** were measured: both providers; the project agent and the Assistant at each control level; a
  short catalog (Hive's own skills) and a long one (40 more of the user's); new and resumed sessions.
- **Every resume was confirmed** from the CLI's own arguments (`--resume <id>`, `codex resume <id>`).
- **Instructions**: for Codex, its developer instructions; for Claude Code, the hive server's instructions plus, for
  the Assistant, its appended prompt.

| Role | Catalog | Instructions | Tools | Skill metadata (skills) | Total | ≈ tokens |
|---|---|---:|---:|---:|---:|---:|
| agent | short | 1,149 | 8,256 | 1,912 (8) | 11,317 | 2,829 |
| agent | long | 1,149 | 8,256 | 7,085 (48) | 16,490 | 4,123 |
| Assistant, Look and advise | short or long | ≈3,250 | 9,769 | 1,197 (5) | ≈14,215 | ≈3,554 |
| Assistant, Control agents | short or long | ≈3,880 | 16,542 | 1,197 (5) | ≈21,620 | ≈5,406 |
| Assistant, Control agents and create projects | short or long | ≈3,950 | 16,804 | 1,197 (5) | ≈21,950 | ≈5,488 |

- **Claude Code and Codex measure the same**, to within 4 bytes (Claude's appended prompt for the Assistant carries
  one more line break).
- **A resumed session measures the same as a new one.**
- **The user's own skills reach project agents only**: the long catalog doesn't change the Assistant's size.
- **The tool schemas are the largest fixed part.**
