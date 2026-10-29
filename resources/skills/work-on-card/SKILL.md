---
name: work-on-card
description: "Carry a card from Hive's task board through its work, from Doing to Review with a summary. Use when given a card to work on (\"work on AM-12\", a card Hive started you on, more work on one back from Review). Not for reviewing one, nor a card loop (card-loop)."
metadata:
  audience: agents
---

# Work on a card

The card is the brief, and the board is how the user, the Hive Assistant and other agents see where the work stands. Keep it true.

**You say what you did; Hive moves the card.** Each step is a tool: `hive_start_card`, `hive_submit`, `hive_put_back`, `hive_report_merge`. What a step needs first is the project's rules, checked by Hive: a refusal says the next step ([refused.md](refused.md)).

## Start

1. **Read the card** with `hive_read_task`: its decisions, description, comments, links, the cards it depends on and its `attachments` (`hive_read_attachment` reads each). Its **decisions** (listed first) are what the user decided: where they differ from the description or a comment, follow the decisions. On a long card back for more work, the description and the newest comments (`comments: 5`) usually say what is wanted now; read further back when they refer to earlier ones.
2. **Work or review?** If you are asked to check work rather than do it, this is a review: use the review-agent-work skill and leave the card where it is.
3. **Start it** with `hive_start_card` before you change anything or ask the user about it: it moves to Doing and is yours, and the reply says its folder, branch, base and target. Refused (a card it depends on isn't done, say), the reply says why and what to do. Where the project lends each card or lane a slot (a working folder of its own, on the card's branch), that folder is the slot: work and run checks there, never in another one. A reply that says you continue in another folder means a new conversation there: end your turn. A card already yours, or back for more work: [after-review.md](after-review.md).

## Finish

1. **Check the work**: run the project's checks that matter for this change. Note what you ran, the result, and what you didn't run, as a **run record** a reviewer can trust instead of repeating it: the checks, the exact code they ran on (for a code card in Git, the commit; the project's notes may give a command that prints a fingerprint), each result, and where the logs are. A check the project's workflow names runs as that check of the card: `hive-progress --check <name> --card "<key>"`; with `--isolated` it runs in a check copy of its own at the card's revision, which nothing else changes meanwhile.
2. **Read the card again, then submit it for review.** `hive_read_task` first: check the work against each decision, recorded meanwhile too. `hive_submit` submits the card's work for review as it stands: for a code card in Git, a revision, by default the card's own (its line's head, or its newest commit in a folder shared with other agents; the reply names it), so commit what it should hold first; without version control, the state of the card's files (`paths`); for a no-code card, such as a decision or a write-up, its summary alone. Its `summary` starts with a one-sentence line ("Round 2 ready: <what changed>"); below it, what changed, how to check it, the run record, and anything left open. A revision already reviewed needs a `note` saying what this submission adds. The reply says where the card went: Review, or on past it where the project has no review, or a refusal saying what's missing.

## Reference files

Read one only when it applies. Each is in this skill's own folder, beside this SKILL.md, not your working folder:

- [refused.md](refused.md): a refusal, an unasked commit, rules off, no workflow.
- [inbox.md](inbox.md): your inbox has something.
- [while-working.md](while-working.md): a question for the user, comments, decisions, tests, follow-ups, waits, order.
- [after-review.md](after-review.md): your card passed, is Done, or is back.
