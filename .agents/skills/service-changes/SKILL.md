---
name: service-changes
description: Hive's rules for risky changes to its main process - workspaces and windows, project scope and access checks, locking, storage and clean-up, cancellation, transcripts and bounded resources. Use when developing or reviewing Hive and a change touches src/main services, the Agent API or hive tools, files under .hive, or anything several windows, agents or processes can do at once.
---

# Changing Hive's services

The workspace's shared note `conventions/engineering-quality.md` (`hive_read_shared_note`) applies to every change, and [ARCHITECTURE.md](../../../docs/ARCHITECTURE.md) says where things live. Read the parts of this list your change touches. Each item is something that has gone wrong before.

## Workspaces and windows

Each window has its own workspace. Calls without a path (`workspace.path`, `skillsDir`) need the current work's workspace:

- IPC and Agent API calls have it;
- background code uses `workspaceOf(projectPath)` or `inWorkspace(ws, fn)`;
- window-specific events go through `emitTo(win, …)`.

## Scope and authorisation

A project agent is known by its own token, never by what a request says. Every route and tool that reads or changes another project's things, directly or through a side door, checks it:

- cards (`callerScope`);
- activity and sessions (`ownProjectOnly`);
- events (filtered per client);
- skills listings.

The Assistant's changes go through `assistantChange()` (control level, recorded for undo). A rejected request reveals nothing about what it couldn't reach: a 404 looks the same as a missing item.

## Locks and races

- Check ownership and permission inside the same lock as the write, against the record as it is then, for every item of a batch. A check made before the lock doesn't count.
- Kept files (`project.json`, `workspace.json`, `config.json`) and session records (in hive.db) change only through their locked helpers (`mutateProjectConfig`, `mutateSessions`, `writeKeptJson`).
- A slow call can see its world change: an agent stopped, a card moved, a window closed. Check again after each await that matters.

## Files Hive manages

- Folders other agents may read are replaced whole (`replaceDir`), never deleted and copied in place.
- What Hive deletes, it identifies first:
  - Hive's own copies carry markers;
  - worktrees must be ones git lists;
  - user folders are never touched;
  - deletions go to the Recycle Bin when the user could want them back.
- Storage clean-up previews and then applies exactly what was previewed, checked again at apply time.

## Resources

- Watchers, caches, event clients and lists that grow with use need a bound: a size, a TTL, or a disconnect when a client stops reading.
- Replies to agents stay lean (`toolReplies.ts`, `tests/e2e/replysize.cjs`).

## Privacy

- User text in log lines goes through `userText()`.
- Transcript fixtures have personal text removed.
- Diagnostics redact names and paths.

## Tests

Test the invariant, not the implementation:

- the access combinations (owner, other project, the Assistant, a script);
- ownership changing while a call waits;
- later items of a batch;
- invalid and missing input;
- several windows.
