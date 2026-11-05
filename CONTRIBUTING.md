# Contributing to Combwork

Thank you for helping. This page is mostly about **translations**: fixing a word in a language Combwork already has, and
adding a new language. You can do a small fix in GitHub's web editor without installing anything. The checks run on
your pull request. Code changes are covered briefly at the end.

**Found a bug, or have an idea?** [Open an issue](https://github.com/Suremise/combwork/issues/new/choose): there
are forms for a bug report (with **Help → Copy Diagnostics…**), a feature request, a translation and anything else.
A **security problem** goes privately, never in an issue: see [SECURITY.md](.github/SECURITY.md). Pull requests start
from [a short template](.github/PULL_REQUEST_TEMPLATE.md). Everyone taking part follows the
[code of conduct](.github/CODE_OF_CONDUCT.md).

Combwork's languages besides English are **drafted by AI**, and Combwork marks them so: *Deutsch (KI)*, *Polski
(AI)*. They are a starting point. A native speaker who fixes what reads badly is exactly what they need.

## How Combwork's text is organised

| Where | What | Edit it? |
|---|---|---|
| `locales/<code>/<area>.json` | One language's translations for one area of Combwork (settings, board, progress…): message id → text. | **Yes.** This is where translations go. |
| `locales/en/<area>.json` | The English source: each message's `defaultMessage`, and a `description` that tells you where it appears and what its placeholders are. | **No.** It is generated from the code (`npm run i18n:extract`). Read it, don't edit it. |
| `locales/.source/<code>/<area>.json` | The English each translation was made from, so Combwork can tell when the English changed later. | Only through `npm run i18n:coverage -- --record` (below). |
| `src/shared/i18n/languages.ts` | The list of languages: each one's own name, its AI mark and note, and its direction. | When you add a language. A maintainer takes a language's AI mark off once it has been reviewed (below). |
| `docs/translating/glossary.md` | Combwork's terms, and which to keep in English. | Suggest changes in a pull request. |
| `docs/translating/<code>.md` | One language's style page: how to address the reader, its word for each glossary term, its punctuation. | Yes, for your language. New ones start from `style-template.md`. |

A message's **area** is the first part of its id: `language.setting.title` is in `language.json`. Each language has
the same file names as `locales/en/`.

A translation file is just ids and text:

```json
{
  "language.setting.title": "Język",
  "language.automatic": "Automatycznie (Windows: {language})"
}
```

**What isn't translated.** Text that Combwork sends to coding agents and the Combwork Assistant (tool replies, guidance,
messages in an agent's inbox), the Agent API, and command-line output all stay in English, so none of it is in
`locales/`. The user guide is English only for now.

**What a missing translation does.** Nothing breaks: Combwork shows that message in English. So you can translate one area
at a time, and an unfinished language still works.

## Fix a translation

Say a German button reads badly.

1. **Find the message.** Search `locales/de/` for the German text you saw. If the text you saw is English (not
   translated yet), search `locales/en/` for it instead, and note its id and file.
2. **Edit `locales/de/<area>.json`.** Change the text, or add the id with its translation if it isn't there. Keep the
   file valid JSON: put a straight double quote inside text as `\"`, or use the language's own quotation marks
   („…“, «…»), which need no escaping.
3. **Keep the message's structure** (the check below fails if you don't):
   - **Placeholders** in braces stay exactly as they are: `{name}`, `{count}`. Move them wherever the sentence needs
     them, but never translate or rename them. A few messages offer a second form of a placeholder for languages that
     want it, and their description says so (`{quotedNames}`: the same names, each in its own quotation marks): write
     it in place of the first, and the check accepts it.
   - **Plurals and choices** are ICU MessageFormat. In `{n, plural, one {# card} other {# cards}}` translate only the
     text inside the inner braces. `#` is the number. Use your language's plural forms: Polish needs `one`, `few`,
     `many` and `other`; Japanese and Chinese need only `other`. In `{who, select, assistant {…} other {…}}` keep the
     keys (`assistant`, `other`) and translate the text.
   - **Tags** such as `<b>…</b>` stay, around the words that belong in them, with the same names as in the English.
   - **Apostrophes:** in ICU an apostrophe right before `{`, `}` or `#` starts a quotation, so `dell'{agent}` hides
     the placeholder. Write the typographic apostrophe `’` (`dell’{agent}`), or double it (`dell''{agent}`). Apostrophes
     elsewhere (`l'agente`) are fine.
   - A `…` at the end of a button or command means it asks something before it acts. Keep it.
4. **Check it:**
   ```bash
   npm install
   npm run i18n:check       # must pass: placeholders, plurals, tags and ids
   npm run i18n:coverage    # informational: how much of each language is done, and what is outdated
   ```
   `i18n:check` fails on a translation that would show wrong: a renamed or missing placeholder, broken ICU, a plural
   without `other`, a tag that isn't the English's, an id the English doesn't have, invalid JSON, a control character
   (a stray byte from a scripted edit; a line break only where the English has one). It never fails on a
   missing translation. The unit tests read the translations from the files rather than expecting their words, so a
   wording change needs no change to a test.
5. **Record what you translated from.** If `i18n:coverage` listed the message as **outdated** (its English changed
   since it was translated) and you have brought it up to date, record that:
   `npm run i18n:coverage -- --record de <id>`. If you added new translations, `npm run i18n:coverage -- --record de`
   records all of them. Commit the files it writes in `locales/.source/de/` with your change. A wording fix to a
   translation that wasn't outdated needs no record.
6. **Look at it in Combwork** (optional, but the best check of length and tone). Any one of these:
   - **Installed Combwork:** quit Combwork, then start it with `--lang=de`. In PowerShell:
     `& "$env:LOCALAPPDATA\Programs\Combwork\Combwork.exe" --lang=de`. Your edited file only appears once a build includes it,
     so this shows the current release's German.
   - **From the source:** `npx install-electron --no` once, then `npm run dev -- -- --lang=de` (both `--` are
     needed: the first is npm's, the second electron-vite's).
   - **Screenshots of the main screens** in both themes, without clicking around:
     `npm run e2e -- --lang de --build` (after `npx install-electron --no`; outside a Combwork workspace, set
     `CW_TEST_NO_BOARD=1` first, in PowerShell `$env:CW_TEST_NO_BOARD='1'`). It needs no sign-in: the agents in it
     are a stand-in. The runner prints where it kept the screenshots. Look for text that is cut off or wraps
     badly. See [tests/e2e/README.md](tests/e2e/README.md), *The i18n screenshot route*.

   A language started this way stays for that run only. The setting (**Settings → General → Language**) says so and
   applies from the next start.
7. **Open a pull request** against `main` on [Suremise/combwork](https://github.com/Suremise/combwork). Say
   what you changed and why, and add a screenshot if you have one. Keep each pull request to one language.

**The English itself is wrong?** English text lives in the code, not in `locales/`. Open an issue, or change the
message's `defaultMessage` in the code and run `npm run i18n:extract`. That is a code change (see below).

## Add a language

Say you want to add Italian (`it`). Use the language's BCP 47 tag, as Windows does: `it`, `pt-BR`, `zh-CN`.

1. **Write its style page** first: copy `docs/translating/style-template.md` to `docs/translating/it.md` and fill it
   in, with the glossary (`docs/translating/glossary.md`) beside you. Deciding "agente" or "agent", and the formal or
   informal "you", once, up front, keeps hundreds of messages consistent.
2. **Add its folder:** `locales/it/`, with one file per area, named as in `locales/en/`. Start with any area. Each file
   holds `"id": "text"` pairs only, without the descriptions. Untranslated messages show in English.
3. **Add it to `LANGUAGES`** in `src/shared/i18n/languages.ts`. The list is ordered by the languages' own names,
   Latin scripts first (Italiano goes between Français and Polski):
   ```ts
   { code: 'it', name: 'Italiano', english: 'Italian', ai: false, dir: 'ltr' }, // i18n-ignore: a language's own name and English name, never translated
   ```
   - The comment at the end tells `npm run i18n:guard` that these names are meant to stay as they are. Without it, the
     guard reports them as new hard-coded English.
   - `name` is its own name, as the language picker shows it.
   - `ai: true` if a machine drafted it. Then also give `aiMark`, the short mark after its name in its own words
     (`'(IA)'`), and `aiNote`, the line under the picker, in its own words
     (`'Tradotto dall’IA: i miglioramenti sono benvenuti.'`).
   - `dir: 'rtl'` for a right-to-left language. Combwork doesn't lay itself out right to left yet, so ask in an issue
     first.
   - Combwork finds the language's files by itself: nothing else in the code lists them.
4. **Let the installer speak it:** add its NSIS name (`it_IT`) to `installerLanguages` in `electron-builder.yml`.
5. **Update the lists the tests expect.** Two unit tests name every language, so that one isn't added or dropped by
   mistake. Add yours to both:
   - `tests/i18n.test.ts`, *every language has its own name…*: the codes, sorted;
   - `tests/i18n/language.test.ts`, *the Assistant sets it by English name or code*: `'auto'`, then the codes in
     `LANGUAGES`' order.
6. **Record and check:**
   ```bash
   npm run i18n:coverage -- --record it   # the English each translation was made from
   npm run i18n:check
   npm run i18n:guard
   npm test                               # includes the language lists, the catalogues and the guard
   npm run typecheck
   ```
7. **Say what's new:** a line under **Unreleased** in `CHANGELOG.md` (*Combwork speaks Italian*). Where `docs/SPEC.md` and
   `docs/USER_GUIDE.md` list Combwork's languages (their *Language* sections), add it there too.
8. **Look at it** with `--lang=it` or the screenshot route (Fix a translation, step 6), then open a pull request.

**Automatic only picks a language that has translations.** Until `locales/it/` has a file, Windows set to Italian
still gets English, though Italian can be chosen by hand.

## How a pull request is checked

CI (`.github/workflows/ci.yml`) runs on every pull request: typecheck, lint, the unit tests, and then the translation
checks, each on its own line:

- `npm run i18n:extract -- --check`: `locales/en/` matches the code. You only change it through the code.
- `npm run i18n:check`: **blocks the merge** when a translation would show wrong (step 4 above).
- `npm run i18n:guard`: no new hard-coded English in Combwork's interface. This only concerns code changes.
- `npm run i18n:coverage`: informational. Missing and outdated translations are listed, never failed.

A maintainer reviews the change too.

**From AI-drafted to reviewed.** When a native speaker has read through a language (all of it, or at least every
area Combwork shows often), say so in the pull request. The maintainer then sets `ai: false` for it in `languages.ts` and
removes its `aiMark` and `aiNote`, and Combwork stops marking it.

## Style

Combwork's English is plain: short sentences, everyday words, and it says what happens rather than how the code works.
Buttons say what they do: *Remove*, *Move them back*. Translations should read the same way in their own language.
They should be natural, not word for word.

- **Address the reader** informally where the language has a choice (du, tu, ty), unless the language's style page
  decides otherwise and says why.
- **Buttons and commands** follow the language's usual convention for software (infinitive or imperative), the same
  way everywhere. Follow your language's capitalisation, not the English's.
- **Never guess a gender from a name.** Agent names (*One*, *Codex*, *Builder*) have no known gender, so avoid a verb
  or adjective that must agree with one: *Usunięto {agent}* ("{agent} was removed", impersonal), not *{agent} został
  usunięty*.
- **Keep the glossary's "keep" terms** in English (Combwork, Claude Code, Codex, GitHub Copilot, MCP…), and use your
  style page's word for each of Combwork's own terms every time.
- **Numbers, dates, money and lists** are formatted by Combwork for the language (`1 234,50 USD`, `14.10.2026`), so never
  write them out in a translation. Keep them as the placeholders they are.
- **Keep the line breaks.** A message with `\n` in it (a hover of several lines) shows each part on its own line:
  keep them where the English has them.
- **Mind the length.** Buttons, tabs and column headings have little room. If a translation is much longer than the
  English, look at it in Combwork or in the screenshots.
- **Read the description.** Each message in `locales/en/<area>.json` has a note saying where it appears and what its
  placeholders hold. When it says to keep a word (`--lang`, *Chromium*), keep it.

The details are in [docs/translating/glossary.md](docs/translating/glossary.md) and your language's page in
`docs/translating/` (or, for a new language, [docs/translating/style-template.md](docs/translating/style-template.md)).

## Code

Combwork is an Electron, TypeScript and React app for Windows.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how it fits together, and [docs/SPEC.md](docs/SPEC.md) is what
it should do. The commands and conventions are in [AGENTS.md](AGENTS.md). Agents and people follow the same file.
In short:

```bash
npm install
npx install-electron --no   # once: Electron downloads its binary when first needed
npm run dev                 # Combwork from source, beside an installed Combwork (its own profile)
npm run typecheck
npm run lint
npm test
```

- Text the user sees is a message, `msg({ id, defaultMessage, description })`, shown with `tr()`. After adding or
  changing one, run `npm run i18n:extract` and commit what it writes (AGENTS.md, *Translations*).
- A change that users will notice also updates the user guide and adds a line under **Unreleased** in
  `CHANGELOG.md`.
- New dependencies need a permissive licence (MIT, BSD, ISC, Apache-2.0 and similar).
- The end-to-end suites (`npm run e2e`) run on your machine, not in CI: see
  [tests/e2e/README.md](tests/e2e/README.md).

Combwork is MIT-licensed ([LICENSE](LICENSE)).
