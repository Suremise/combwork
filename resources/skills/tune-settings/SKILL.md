---
name: tune-settings
description: "Explain and suggest Combwork's settings as the Assistant; change one only when the user agrees. Use when asked what a setting does or how to make Combwork behave differently, or when one would fix what you see."
metadata:
  audience: assistant
---

# Tune settings

Combwork's settings are many, and users rarely know which one would help. You can read and explain every one. Whether you may change them is the user's choice (Settings → Assistant → Control → Change settings; your instructions say whether it is on).

## Look them up

- `cw_list_settings` with a `query` ("transcript", "notifications", "slots") finds candidates, a line each with the value and the default when it differs. `project` adds a project's own settings (Project Settings).
- `cw_read_setting` explains one: where the user finds it, what it takes, what it does, when it helps, whether a change waits for a restart, and whether you may change it.
- Answer from what they say, not from memory: settings change between versions of Combwork.

## Suggest when the signal is there

Suggest a setting when what you see matches its "when it helps" line. Some signals and the settings they point to:

- A transcript in the tens of MB (`transcriptMB` in `cw_agent_activity`), or an agent that types slowly: `sessions.transcriptWarnMB` (and a handover to a new conversation now).
- Big contexts for long stretches (`cw_session_usage`): `sessions.compactSuggestTokens`, or a connection with 200K context.
- Several agents in one project folder editing the same files: `agents.fileLocks`, or building each card in a slot of its own (the project's Version Control tab, Where cards are built).
- New slots or review copies whose builds fail for a missing `.env` or local config: `workflow.git.slotCopy` (Combwork's), `workspace.workflow.git.slotCopy` or the project's `project.slotCopy`.
- Long runs that stopped while the user was away: `general.keepAwake`.
- Long test runs the user can't follow: `general.progressPanel` and `general.progressCommands`.
- The chime or banners interrupting the user, or agents waiting unnoticed: `notifications.*`.
- A Done column that has grown long: `board.archiveDoneDays`.

Suggest in one line: what it does, why now, and where it is ("Settings → Sessions → Warn when a transcript is over is 100 MB; Coder's is at 80 MB and slowing down. 50 would flag it sooner."). One suggestion at a time, and not again once the user has declined it.

## Change only with the user's say-so

- Change a setting (`cw_update_setting`) only when the user asked for that change, or agreed to your suggestion in this conversation. "Make Combwork faster" is not a yes to any setting: suggest, then wait.
- Without Change settings, or for a read-only setting, tell the user where to change it themselves. Read-only are permission modes, the Agent API, what Combwork runs (CLI paths, extra arguments, setup commands) and your own settings, Control above all: never ask the user to let you change those.
- A project's setting takes `project`; `null` gives it back to Combwork's.
- Say what changed (old → new) and when it applies: some only reach agents when they restart. The user can revert it from your panel.

An agent's model, effort and mode are its connection's (`cw_connection`, under Change settings); which connection it runs on is `cw_update_agent`'s, and the coordinate-agents skill's.
