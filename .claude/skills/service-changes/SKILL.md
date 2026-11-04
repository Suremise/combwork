---
name: service-changes
description: Hive's rules for risky changes to its main process - workspaces and windows, project scope and access checks, locking, storage and clean-up, cancellation, transcripts and bounded resources. Use when developing or reviewing Hive and a change touches src/main services, the Agent API or hive tools, files under .combwork, or anything several windows, agents or processes can do at once.
---

# Changing Hive's services

The workspace's shared note `conventions/engineering-quality.md` (`hive_read_shared_note`) applies to every change, and [ARCHITECTURE.md](../../../docs/ARCHITECTURE.md) says where things live. Read the parts of this list your change touches. Each item is something that has gone wrong before.

## Workspaces and windows

Each window has its own workspace: AGENTS.md (Gotchas: Several windows) says which calls need the current work's workspace and how background code and window events get theirs.

## Scope and authorisation

A project agent is known by its own token, never by what a request says. Every route and tool that reads or changes another project's things, directly or through a side door, checks it:

- cards (`callerScope`);
- activity and sessions (`ownProjectOnly`);
- events (filtered per client);
- skills listings.

The Assistant's changes go through `assistantChange()` (control level, recorded for undo). A rejected request reveals nothing about what it couldn't reach: a 404 looks the same as a missing item.

## Locks and races

- Check ownership and permission inside the same lock as the write, against the record as it is then, for every item of a batch. A check made before the lock doesn't count.
- Kept files and session records change only through their locked helpers (AGENTS.md, Gotchas: Kept files, project.json / sessions).
- A slow call can see its world change: an agent stopped, a card moved, a window closed. Check again after each await that matters.

## Files Hive manages

- Folders other agents may read are replaced whole (`replaceDir`), never deleted and copied in place.
- What Hive deletes, it identifies first:
  - Hive's own copies carry markers;
  - worktrees must be ones git lists;
  - user folders are never touched;
  - deletions go to the Recycle Bin when the user could want them back.
- Storage clean-up previews and then applies exactly what was previewed, checked again at apply time.

## Main's thread

AGENTS.md's gotcha: main's thread carries every keystroke. Moving work off it:
- The pattern to copy is the repository lock's (HI-1680): `src/main/repoLockWorker.ts` runs the unchanged core, `repoLock.ts`'s `LockThread` talks to it (its code runs in-process in unit tests), and it is a build entry in `electron.vite.config.ts`. The usage history's worker (#1106) is the larger example. A queue in the worker keeps calls in order where they must stay so.
- Only where it makes sense: small, fast work stays on main, where a worker's messaging would cost more than it saves.
- The evidence is hive.log's "main process was busy" and "on main's thread" warnings, which name what was under way (often waiting, not the cause), or a stall you measured. Measure before and after (main's longest stall, and a keystroke's echo where typing suffers, as `tests/e2e/repolocktyping.cjs` does), and put the numbers on the card.
- Asynchronous file calls don't hold the thread but share the process's 16-thread libuv pool with every window and worker (`threadPool.ts`, HI-1702): keep bulk file work a few calls at a time (`atMost`), and read hive.log's "A file call took … to end" as the pool full or the disk slow (timed off main's thread, so not main being busy).

## Resources

- Watchers, caches, event clients and lists that grow with use need a bound: a size, a TTL, or a disconnect when a client stops reading.
- Replies to agents stay lean (`toolReplies.ts`, `tests/e2e/replysize.cjs`).

## Privacy

- User text in log lines goes through `userText()` (AGENTS.md, Logging).
- Transcript fixtures have personal text removed.
- Diagnostics redact names and paths.

## Tests

Test the invariant, not the implementation:

- the access combinations (owner, other project, the Assistant, a script);
- ownership changing while a call waits;
- later items of a batch;
- invalid and missing input;
- several windows.
