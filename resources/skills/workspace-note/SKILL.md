---
name: workspace-note
description: Record a lasting decision, convention or gotcha in the workspace's shared notes. Use when asked to remember or document something for later, or when other agents will need what you learned. Not for work in progress.
metadata:
  audience: all
---

# Workspace note

Combwork's shared notes (the workspace's `.hive/shared`) are read by every project and agent. They are for knowledge that outlives this conversation: decisions and their reasons, conventions, setup steps, and gotchas that cost time to find.

They are not for:

- the state of work in progress (a handover);
- what only one project's agents need (that project's `CLAUDE.md` or `AGENTS.md`);
- copies of a product's specification or docs (link to them instead).

## Where each kind of note goes

| Kind of note | Where it goes |
|---|---|
| Project rules true for anyone who works on it | the project's `AGENTS.md` (committed) |
| Allow rules for a CLI's commands | the project's `.claude/settings.json` |
| What one lane or card needs | its brief, or the card |
| About this machine or person: a full path a command needs, a local tool's version | the shared note `Workspace notes.md` |

Combwork gives `Workspace notes.md` to every agent at each launch, on every CLI and in any folder, and it stays out of git: never put local paths in a committed file instead. Keep it short (agents get 4 KB of it by default). A `## <project name>` section reaches only that project's agents. Only the user and the Assistant write it: a project agent suggests the change to the user.

## Steps

1. **Check what exists.** `cw_list_shared_notes`, then read the notes that may cover this already (`cw_read_shared_note`). Updating a note beats adding a near-duplicate.
2. **Decide where it goes.**
   - An existing note on the topic: update it, keeping its structure.
     - A busy, log-like note several agents add to (a status log, a follow-up list, a shared handover): `append` one entry, a line or bullet starting with the date and who you are. Appends never lose another agent's entry.
     - A slow-changing reference note (conventions, decisions): rewrite the section.
   - A new topic: a short, descriptive path in a folder by kind: `conventions/` for rules to follow, `decisions/` for choices and their reasons, `setup/` for how-tos, and `plans/` for plans. `handovers/` is Combwork's, for handovers.
3. **Write it for a reader with no context.**
   - The point first: the decision, rule or fact, in a sentence or two.
   - Why, and the alternatives rejected, when that matters.
   - Where it applies: which projects, folders or situations.
   - The date, and the project it came from.

   Keep it short, name files, commands and settings exactly, and never include secrets, tokens or personal data.
4. **Save it** with `cw_write_shared_note`. Rewriting an existing note, pass `expectedRevision`, the revision your read gave, so you never drop a change someone made since. If it is refused, read the note again, merge your change into what is there now, and write with the new revision.

Tell the user in a line which note you created or changed. No Combwork tools: show the note in your reply and suggest where it goes.
