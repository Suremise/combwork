---
name: split-work
description: "Plan whether and how to divide a task between agents without conflicts, and save the plan. Use when asked how to split work between agents, to parallelise it, or to run several agents on it. Plans only: starting agents is separate."
metadata:
  audience: all
---

# Split work

Produce a plan the user (or the Hive Assistant, if the user asks it to) can act on. Don't start agents or the work yourself.

## First: does splitting help?

Splitting costs coordination and, with cards on branches of their own, a merge each. It helps when the task has parts that can go ahead independently and each is big enough to be worth an agent. If the work is small, or every part touches the same few files, say so and suggest one agent. Don't invent tiny parts to fill agents.

## Steps

1. **Understand the task.** Read the request and the code it touches. Ask the user when the goal or the boundaries are unclear.
2. **Find the seams.** Look for parts with a clear goal, a set of files they own, and few dependencies on the others: separate modules, layers (API, UI, tests, docs) or features.
3. **Order what can't be parallel.** Shared foundations (a type, an interface, a schema, a helper) land first, by one agent, before the others build on them.
4. **Plan by files.** Where cards are built is the project's option (`hive_project_status`'s `workflow`): in slots (a working folder Hive lends each card or lane, on a branch of its own, merged back later), or all in the project folder, sharing its files (Hive's file locks make one agent wait while another edits a file). In a shared folder, give parts files that don't overlap; with slots, parts that change the same files merge one after another, so order them.
5. **Plan the integration.** Say in what order the parts land (a card's `blockedBy`: where the project's rules check it, Hive won't start a card before those are done) and how the whole is checked at the end (often a review with the review-agent-work skill).

## The plan

For each part:

- **Name** and a one-line goal.
- **Owns**: the files or folders only it changes.
- **Reads**: what it depends on but doesn't change.
- **After**: parts that must land first.
- **Done when**: how to tell (checks pass, behaviour works).
- **Brief**: a self-contained prompt for its agent, which sees nothing else.

## Keeping it

When the plan should outlive this conversation, save it with `hive_write_shared_note` under `plans/` (for example `plans/2026-10-03-auth-refactor.md`), so any agent in any folder can read it. When the user wants it on the board, each part can become a card (`hive_create_task`, with `blockedBy` for the order). Otherwise give the plan in your reply.
