---
name: review-agent-work
description: Review another agent's work (a card in Review, a branch, commits or uncommitted changes) and report findings without changing it. Use when asked to review, check or verify work.
metadata:
  audience: agents
---

# Review agent work

You are the reviewer: find what's wrong, don't fix it. Leave the code, the branch and the card's assignment as they are. The user decides what gets fixed and by whom.

## 1. Find exactly what to review

- **A card** (AM-12): read it with `cw_read_task`. Start with `cw_start_review`: its reply names what to review (a revision with its base and files, or a no-code card's summary; `submission` names an earlier one), and the review copy holding that revision when the project has them. Review there, never in the builder's slot or folder. Your session and its shell stay in your own folder, so run every command with the review copy as its working directory: change into it first (`cd`, `Set-Location`) or give the command its working directory; one that doesn't runs your folder's code, not the submission, and leaves its output there. Where the project's rules forbid it, Combwork refuses a review of work you built, saying so. What start review names is what you review, and what your verdict is recorded against: if the builder's summary names another commit, ask the builder (`cw_request_builder`) rather than review that one.

## 2. Know the intent

Check the change against what was asked: the card, the user's request, a handover (`cw_read_latest_handover`) or a plan in the shared notes. A convention your brief or the card names (screenshots the user OKs before a visible change merges, say) is part of the intent: check the work has it. Where the project's options ask for the user's OK, Combwork asks them itself. A card's **decisions** (listed first) are what the user decided, and win over its description: check the work against every one, and work that doesn't follow one is a blocking finding.

## 3. Review

Read the whole change, and the code around it where needed. In order of importance:

1. **Bugs**: wrong logic, missed edge cases (empty, missing, very large, concurrent), broken error handling, leaks.
2. **Missed requirements**: asked for but not done, or done differently.
3. **Risk**: security (injection, secrets, unsafe paths, access checks), data loss, breaking formats or APIs, performance traps.
4. **Tests**: new behaviour without tests, or tests that don't test it. A new or changed test that sleeps and then checks, reads state once just after an action, depends on another test's leftovers, or raises a timeout with no stated reason is a blocking finding: it fails on a loaded or slower machine.
5. **Clarity**: only where it will cause real trouble later.

**Reuse the builder's run, don't repeat it**: a result recorded at the exact revision you review stands (`cw_start_review`'s `checksAtRevision`; a summary's record once its fingerprint and coverage check out). Run only what no record covers, what the workflow asks of you, your own probes, and a rerun for a doubt your verdict names ([checks.md](checks.md)), in the review copy (§1), changing nothing.

## 4. Report

Findings, most serious first. For each:

- **file:line**;
- what's wrong;
- a concrete case where it goes wrong (input or steps, and the result);
- the impact;
- a suggested fix in a sentence.

Say how sure you are when you aren't certain. Then give the verdict, with what you checked and what you didn't, so the user knows how far to trust it.

## Reference files

Read one only when it applies. Each is in this skill's own folder, beside this SKILL.md, not your working folder:

- [other-targets.md](other-targets.md): not a card, a card with no workflow, a pool's card, work sent uncommitted.
- [checks.md](checks.md): what you run, screenshots to look at, or proof you can't open.
- [verdict.md](verdict.md): giving the verdict on a card, or reviewing work again.
