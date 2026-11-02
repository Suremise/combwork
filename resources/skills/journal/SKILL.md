---
name: journal
description: Keep your journal as the Hive Assistant while it is on - what to write, recalling, superseding, the weekly digest and the scope. Use when something worth remembering happens, before deciding from memory, or when asked for a handover.
metadata:
  audience: assistant
---

# Journal

Your journal is your memory across sessions and compactions: a small database in the workspace, local only, that the user can browse, correct and delete. Hive gives you a short view of where things stand, with the few entries relevant now, each time you start and after each compaction. The rest you recall when you need it.

## Write as it happens

Write an entry (`hive_journal_write`) when something happens that a later you would need, not at the end of the day:

- **decision**: what the user decided, in their own words (quote them), and why. Link the cards it is about. Write it as they decide, every time: a decision about a card goes on the card first, as its decision (`hive_update_task` with `decision`: coordinate-agents), since agents check their work against the card's, never your journal's; then write its entry in the same turn, linked to the card, so a later you knows why. A decision with no card (a direction, a default for the workspace) is only here.
- **plan**: what you or the user mean to do next, and what it waits for ("when AM-75 is Done, start AM-76").
- **incident**: something that went wrong (a crash, a failed merge, an agent stuck), what you did, and whether it is settled.
- **insight**: something learned that changes how you work here (a test that is slow under load, an agent that needs a nudge).
- **event**: something that happened that the board doesn't keep (a release, a talk with the user about direction). Hive records its own facts (lanes ended, merges, and the builds a project records in your journal): don't repeat them.
- **Open threads and hunches**: a plan or an insight, saying it is open or unsure.
- **preference** and **moment** (how the user likes things done; a moment worth keeping), only if the scope allows them.

How:

- **summary**: one line a later you can act on from the line alone ("Darren: 0.9.1 ships the journal before intentions").
- **why**: why it mattered, a sentence. **detail** only when the line can't carry it.
- **links**: the cards, commits, notes, agents and entries it is about. Linked to a card, it comes back while that card is in hand.
- **importance**: 1 for everyday entries; 2 for what must outlive retention and the size cap (decisions that shape the work, lasting preferences); 3 rarely. 0 for trivia.
- **project**: the project it is about; none for the workspace.

Never store secrets, tokens or what the user asked you not to keep.

## Recall small first

- Before deciding from memory, recall (`hive_journal_recall`): a query of a few words, or a card's history (`link: { type: "card", ref: "975" }`), or a time range (`since`). It gives one line an entry; read one in full with `hive_journal_entry` only when the line isn't enough.
- Keep `limit` small. Narrow by `kinds`, `project` or `tag` rather than reading more.
- What you recall was true when written: check it against the board, the agents and the code before acting on it.

## Reference files

Read one only when it applies. Each is in this skill's own folder, beside this SKILL.md, not your working folder:

- [upkeep.md](upkeep.md): when correcting an entry, the weekly digest, its scope, a fresh start or a handover.
