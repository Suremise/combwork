# &lt;Language&gt; (`<code>`): style for Combwork

<!--
This is the template for a language's style page. Copy it to docs/translating/<code>.md (de.md, pt-BR.md), replace
everything in <angle brackets>, and delete these comments. Decide each point once, here, before translating many
messages: whoever translates or reviews later (a person or an agent) follows this page, so the language reads as one
voice. Change a decision here first, then in the messages.
-->

**Status:** <drafted by AI | reviewed by a native speaker (who, when)>. Its entry in `src/shared/i18n/languages.ts`
says the same (`ai: true` until it is reviewed).

**In the language picker:** <its own name, e.g. Polski>, marked <its AI mark, e.g. (AI)> while drafted by AI, with
the note <its AI note, in its own words>.

## Voice

Combwork's English is plain and direct: short sentences, everyday words, *you* for the reader, and it says what happens.
Translate the meaning, not the words, and keep the result as short and plain.

- **Addressing the reader:** <the informal "you" (du / tu / ty…), or why this language uses another form>.
  <Whether "you" is capitalised in this language (Polish "Ci" in letters, German "du" is lower case), and the rule
  for Combwork.>
- **Tone:** <how to keep it friendly and direct without being casual: what to avoid (bureaucratic phrasing, passive
  constructions where the language prefers active…)>.
- **Sentence length:** <whether to split long English sentences, and how to avoid the language's typical long
  constructions>.

## Buttons, commands, titles

- **Buttons and menu commands:** <infinitive or imperative, as software in this language usually does
  (e.g. German "Speichern", French "Enregistrer", Polish "Zapisz")>. The same form everywhere.
- **Capitalisation:** <this language's rule for titles, buttons, headings and column names>. Don't copy the English
  Title Case.
- **A trailing `…`** (the command asks something before it acts) stays: <with or without a space before it>.
- **Column headings** (On Hold, Todo, Doing, Review, Passed, Done): <the words chosen, and their length>.

## Grammar

- **Names have no known gender.** Agents' names (*One*, *Codex*, *Builder*) and people's names don't say how a word
  must agree. <How this language avoids agreement with a name: impersonal or passive forms, "agent {agent}" with the
  noun carrying the gender, restructuring.> Example: <English> → <translation that avoids a gendered form>.
- **Plurals:** this language's plural categories are <one, few, many, other / only other…> (CLDR). Every plural
  message gives each of them: `{n, plural, one {…} few {…} many {…} other {…}}`. <Notes, e.g. how decimals take
  `other`.>
- **Cases and placeholders:** a placeholder like `{project}` or `{agent}` is a name inserted as it is, uninflected.
  <How to build sentences so the name stays in the nominative (e.g. "in the project {project}", "for agent {agent}").>
- **Lists:** Combwork joins lists itself ("One, Two and Three"), in this language's way. Never write the conjunction
  into a message around a list placeholder.

## Punctuation and typography

- **Quotation marks:** <e.g. „…“ / «…» / 「…」>. They need no escaping in JSON, unlike `"`.
- **Apostrophe:** <’ or '>. Before `{`, `}` or `#`, a straight apostrophe starts an ICU quotation: write ’ there, or
  `''`.
- **Spaces:** <e.g. French's no-break space before : ; ? !, written as the character U+00A0, or none>.
- **Dashes, colons, ellipsis:** <this language's conventions where they differ from English>.
- **Numbers, dates, money, durations:** formatted by Combwork in this language's way. Never write them into a message.

## Terms

The words this language uses for Combwork's terms ([glossary.md](glossary.md)). Use them every time. Where a term is
kept in English, say so.

| English | <Language> | Notes |
|---|---|---|
| workspace | | |
| project | | |
| agent | | |
| provider | | |
| session | | |
| the Assistant | | Its only name (HI-2458: there is no English full name to keep). |
| persona | | |
| task board / board | | |
| card | | |
| On Hold / Todo / Doing / Review / Passed / Done | | |
| decision | | |
| blocked / stalled | | |
| builder / reviewer | | |
| card loop / lane / round | | |
| merge slot | | |
| inbox / message / wake | | |
| handover / shared notes | | |
| skill / template | | |
| worktree / branch / commit / merge | | |
| Progress panel / run | | |
| Workspace Overview | | |
| permission mode (Manual, Accept edits, Plan, Auto, Don't ask) | | |
| effort / usage / cost / tokens | | |
| banner / notification / tip | | |
| sign in | | |

## Examples

A few messages as this language renders them, to show the decisions above in practice. Choose ones with a
placeholder, a plural and a button.

| English | <Language> |
|---|---|
| Remove agent… | |
| {name} has {n, plural, one {# open card} other {# open cards}} | |
| {agent} was removed. Its sessions stay in the Sessions tab. | |
| Combwork was started in {language} (--lang): this setting applies from its next start. | |

## Checking

- `npm run i18n:check` passes, and `npm run i18n:coverage` shows what is still missing or outdated.
- Look at the screenshots: `npm run e2e -- --lang <code> --build`, in both themes, for text that is cut off or wraps
  badly. <Screens where this language is known to run long, and how they were shortened.>
- <Anything a reviewer of this language should look at first.>
