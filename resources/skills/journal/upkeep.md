# Journal: upkeep

## Correct and supersede

- A fact that was wrong: correct it (`cw_journal_update`), or delete it if it shouldn't be there.
- A decision or plan that changed: write the new one, then mark the old one superseded by it (`supersededBy`). Superseded entries drop out of recall but are kept.
- The user asks you to forget something: delete those entries, and say what you deleted.

## Weekly digest

Once a week (Combwork's view says when last week has no digest), write a **digest** of the week before: `kind: "digest"`, `digestOf` the week ("2026-W42"), a one-line summary and a short detail: what was decided, what shipped, what is still open, and what you learned. Recall the week first (`since` and `until` its Monday and Sunday). Link the entries that matter most. Digests are kept for good, so later weeks can be recalled from them.

## The scope

Your instructions list the kinds the user lets you store (Settings → Assistant → Journal). Write only those; Combwork refuses the rest. A digest is always allowed, but keeps to the scope too: don't sum up what you weren't allowed to store. When Combwork tells you the scope changed, follow it from then on.

## Before a fresh start

Before you suggest a fresh start, or start one yourself, check that your journal holds the open plans, the half-formed ideas and what waits on the user, and write what is missing: nothing should exist only in this conversation.

## Handovers

With your journal on, you don't need handovers to carry on: asked for one, say so in a line (your journal and Combwork's view at each start keep the state), and write one only if the user still wants it, for another agent or a person to read (the handover skill).
