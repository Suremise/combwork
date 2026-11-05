---
name: translate-ui
description: Add, change or remove text Combwork's window shows - messages, plurals and numbers, the English catalogues, the i18n guard's allow lists, translating into every locale and checking it. Use when developing Combwork and a change touches text the user sees, or a locale file.
---

# Text the user sees, in every language

The rules are AGENTS.md's (**Translations**): text the user sees is a message, plurals and numbers are ICU and `fmt`,
agent-facing text stays English, and every locale is translated in the same change. This is how to do it. The design is
the shared note `plans/2026-10-14-i18n-design.md`.

## Writing messages

- A message is `msg({ id: '<area>.<name>', defaultMessage, description })`, kept as data and shown with `tr()`
  (`tRich()` for markup) when rendered or sent, never at module scope. The description is for translators: what it is,
  where it shows, what each placeholder holds.
- A message whose English changes keeps its id unless its meaning changes: its translations are then marked outdated
  and redone (below).
- **Numbers in plain placeholders**: `npm run i18n:numbers` (`-- --changed`: the branch's files) lists each place
  passing a number to a plain `{x}` (via `tr`, `tRich`, `combworkError` and helpers taking a message), typing plain
  placeholders `string` in a copy of `src`. Apart, it lists values that may be numbers, calls of a message unknown where
  made (a `Msg` variable: check the messages it can be), and placeholders used both plain and as a plural. A review aid,
  not a check: ids, ports, exit codes and small counts stay plain; a count, size or amount that can reach 1,000 needs
  `{n, number}` or a plural. Numbers in JSX outside a message aren't checked. A helper's signature change can stop it:
  `tests/i18nNumbers.test.ts` then names the patch to update.
- Numbers, sizes, token counts, percentages and dates go through `fmt`, `shared/units.ts` and `shared/dates.ts`, never a bare `toLocaleString()` (`tests/i18nFormatting.test.ts` fails on one); English named, `toLocaleString('en')`, is for what agents read.
- Agent-facing and CLI-facing text: whole files are in `EXCLUDED` in `scripts/i18nGuard.mjs`; elsewhere mark the line
  `// i18n-ignore: <reason>` (the reason is required).

## After adding or changing messages

1. `npm run i18n:extract`, and commit `locales/en/` and `src/shared/i18n/values/` (generated: never edit them; a unit
   test fails when they're stale).
2. The guard (`npm run i18n:guard`, in `npm test` and CI) fails on new hard-coded text. `i18n/allow/` lists the text not
   converted yet, per file, and the lists only shrink: after converting text, `npm run i18n:guard -- --prune <files>`.
   Never edit a list by hand or run `--init` again (CI compares them with the merge base's and fails one that grew); a
   file moved keeps its list (`git mv` it too).
3. **Translate into every language in `locales/`** (all seven besides `en`), in the same change, before review; never
   English fallbacks for later. Translations are `locales/<code>/<area>.json`, a flat object of ids: change a file
   with your editing tool or a script that keeps its key order and line endings (a re-sorted file is churn). Keep each
   locale's own words for Combwork's names (Version Control → Workflow, the presets, the Assistant), as its other messages
   have them, and each language's plural forms (`many` in es and fr; `few` and `many` in pl; only `other` in ja and
   zh-CN).
4. `npm run i18n:check` must pass: an extra key (a message removed: drop it from each locale), broken ICU, a changed
   placeholder or a control character fails it. A missing translation shows English and doesn't fail, so no check
   catches it: the builder does, and the reviewer checks it.
5. `npm run i18n:coverage` lists what is missing or outdated. Once translated, record the English they were made from:
   `npm run i18n:coverage -- --record <code>` records new ones; outdated ones you redid are named:
   `-- --record <code> <id> <id>…`.

## Looking at a language's screens

`npm run e2e -- --lang <codes>`, one run at a time: read its `report.txt` first and open only the screenshots it flags
or your change touches (#899).
