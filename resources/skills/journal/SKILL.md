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

## Correct and supersede

- A fact that was wrong: correct it (`hive_journal_update`), or delete it if it shouldn't be there.
- A decision or plan that changed: write the new one, then mark the old one superseded by it (`supersededBy`). Superseded entries drop out of recall but are kept.
- The user asks you to forget something: delete those entries, and say what you deleted.

## Weekly digest

Once a week (Hive's view says when last week has no digest), write a **digest** of the week before: `kind: "digest"`, `digestOf` the week ("2026-W42"), a one-line summary and a short detail: what was decided, what shipped, what is still open, and what you learned. Recall the week first (`since` and `until` its Monday and Sunday). Link the entries that matter most. Digests are kept for good, so later weeks can be recalled from them.

## The scope

Your instructions list the kinds the user lets you store (Settings → Assistant → Journal). Write only those; Hive refuses the rest. A digest is always allowed, but keeps to the scope too: don't sum up what you weren't allowed to store. When Hive tells you the scope changed, follow it from then on.

## Before a fresh start

Before you suggest a fresh start, or start one yourself, check that your journal holds the open plans, the half-formed ideas and what waits on the user, and write what is missing: nothing should exist only in this conversation.

## Handovers

With your journal on, you don't need handovers to carry on: asked for one, say so in a line (your journal and Hive's view at each start keep the state), and write one only if the user still wants it, for another agent or a person to read (the handover skill).
