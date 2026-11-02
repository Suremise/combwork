---
name: pick-up
description: Continue earlier work from its handover, checking it against the current state. Use when asked to continue, resume or pick up previous work, or to read a handover. Not for every new session.
metadata:
  audience: all
---

# Pick up

A handover describes the state when it was written. Others may have committed, the user may have edited, a card may have moved. Check before you trust it.

## 1. Read the right handover

- A handover the user names: `hive_read_shared_note` with its path (`hive_list_shared_notes` lists them).
- Otherwise the latest for this project: `hive_read_latest_handover`.
- No hive tool listed: look for `HANDOVER.md` in the project root, or ask the user where it is.

Its header says which project, agent and session wrote it, and when.

## 2. Compare it with now

Check only what the next step depends on:

- **Code**: the branch and `git status`; `git log` since the handover's date. Are the commits it names there, and is there newer work?
- **Cards** it mentions: `hive_read_task` (`latestComment: true` is often enough). Where are they now, and what was said since?
- **Decisions and questions** it lists as open: has the user answered them since (a newer comment or note)?
- **Checks**: re-run one only when the handover reports a failure you are about to work on, or the code it covers changed since.

## 3. Go on

- If the user already told you to continue, continue with the next step, and mention anything that no longer matches as you go.
- Otherwise report briefly: the next step, what changed since, and any open question that still needs the user. Then wait for them.

If the handover and the current state disagree in a way that changes the plan, say so plainly rather than quietly picking one.

## No handover

Say so. Offer to build a picture from `git log`, uncommitted changes, the project's cards (`hive_list_tasks`) and the shared notes instead.
