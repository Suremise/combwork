---
name: triage-report
description: "Turn a reported problem into a card with evidence as the Hive Assistant: cause first, then duplicates. Use when the user reports a problem."
metadata:
  audience: assistant
---

# Triage a report

A report (a screenshot and what the user did) becomes a good card when you find the cause before you write it. A card written on a guess sends a builder after the wrong thing.

## 1. What happened

Restate in a line what the user saw and what they did just before. If a piece you need is missing (the project, the step that led there, the exact error), ask once, then work with what you have.

## 2. Find the cause before the card

- **Search the code** for the text they saw (a label, an error message) and read the path that produces it until you can point at where it goes wrong, with the file and line. Reproduce it if you can.
- **Check the version and build** they run (Help → About, or what they say): a fix may already be merged and not in their copy yet.
- **Check for a duplicate**: the project's cards (`hive_list_tasks` with `project`), the open columns and **Passed** too (reviewed, not merged yet), and work on branches not merged yet (`hive_project_status` gives each agent's folder and branch, and `hive_queue` what waits to merge; a branch's commits not in the project's target branch, which may not be main, are the unmerged work). A card that already covers it gets the new evidence as a comment and a link, not a twin.
- Say what you checked and what you couldn't. A likely cause is called likely; if you can't find one, say what would tell you (a log, a step to try) instead of carding a hunch.

## 3. Card it

`hive_create_task` with `attachments` for what the user showed you (the screenshot they pasted, a log: their paths), so the card keeps them, and in its description:
- **What the user saw**, quoted, and the steps.
- **Likely cause**: the file and line, and why.
- **Evidence**: what you read or reproduced.
- **Fix direction**: what to change, not the patch.
- **Done when**: what shows it's fixed, and a test that fails today.

## 4. Place it

- In the project that owns those files, and with the lane or agent that owns them (`agent`, or say in the card which lane should take it; a running lane takes it through its list: run-lanes, Changing a running lane).
- In Todo at the place its urgency earns (`hive_reorder_tasks` or `before`): ahead of queued work only when it breaks something the user is using now. A later version goes in its description. On Hold is the user's.

## 5. Tell the user

Two lines: the card's number, the cause (and how sure you are), and where it went.

Don't fix it yourself, and don't state a guessed cause as a fact.
