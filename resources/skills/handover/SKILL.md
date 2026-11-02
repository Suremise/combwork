---
name: handover
description: Write a handover so a later session or another agent can carry on cold. Use when asked to wrap up for later, hand over or stop for the day. Readying a branch to merge is merge-ready.
metadata:
  audience: all
---

# Handover

A handover is read cold by someone with none of this conversation. Write it so they can carry on in minutes.

## Check the state

- **Code**: the branch and folder (slot or project folder), `git status`, and `git log --oneline -10`. Note what is committed and what isn't.
- **Checks**: give the results you already have, and say when they were run and against what. Don't re-run unchanged checks just to write the note: results the user has just given you count too. If the code changed since a check, say so, or run it again if it's quick.
- **Running work**: anything still going or half-done (a background job, a migration, a file mid-edit).

## What to write

Use these headings. Keep each short and concrete:

- **Goal**: what the work is for, in a sentence or two.
- **Done**: what was completed, with commits and card keys.
- **Current state**: branch, uncommitted changes, and what passes and fails (the key error line, not the log).
- **Decisions**: choices made and why, especially ones that look odd without context, and what was tried and rejected.
- **Next steps**: in order, the first small enough to start at once.
- **Open questions**: what waits on the user or someone else, and who.
- **Files**: the ones that matter most, a few words each.

Name files, functions, commands and cards exactly. Leave out the story of how you got here. Never include secrets, tokens, or personal data.

Lasting decisions and conventions belong in the shared notes too (the workspace-note skill). The handover can link to them.

## Saving it

Save it with `hive_create_handover` (title: a few words on the work, content: the note). Hive files it in the workspace's shared notes for this project and writes the header itself (title, project, author, session and date), so start the content at the first heading. The next session is told it exists.

No hive tool listed: write it to `HANDOVER.md` in the project root and tell the user.

Finish by telling the user, in a line or two, where it is and what the next step is.
