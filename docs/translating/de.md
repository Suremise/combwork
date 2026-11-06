# Deutsch (`de`): style for Combwork

**Status:** drafted by AI (Claude, October 2026), not yet reviewed by a native speaker. Its entry in
`src/shared/i18n/languages.ts` says the same (`ai: true` until it is reviewed).

**In the language picker:** Deutsch, marked (KI) while drafted by AI, with the note „Von KI übersetzt, Verbesserungen
sind willkommen.“

**Improving it:** every German text is in `locales/de/<area>.json`, one file per area (settings, board, tasks…), next
to the English it was made from in `locales/en/<area>.json` (generated from the code: don't edit it). Change a text
there, run `npm run i18n:check` (it must pass) and `npm run i18n:coverage`, and open a pull request on
[Suremise/combwork](https://github.com/Suremise/combwork). A screenshot of the screen you changed helps the
review: start Combwork with `--lang=de` (`npm run dev -- --lang=de`). To change a term below, change it here first, in the
same pull request, then in every message that uses it. A native speaker's review takes the (KI) mark off.

## Voice

Combwork's English is plain and direct: short sentences, everyday words, *you* for the reader, and it says what happens.
Translate the meaning, not the words, and keep the result as short and plain.

- **Addressing the reader:** *du*, lower case (*du*, *dich*, *dein*), as current German software for developers
  does (VS Code's community texts, GitHub). Never *Sie*. Where a sentence reads more naturally without a pronoun,
  drop it: „Zuerst einen entfernen.“ rather than „Entferne zuerst einen.“ is fine in short notes.
- **Tone:** friendly and factual. No officialese (*seitens*, *diesbezüglich*, *erfolgen*, *durchführen*): say what
  happens with a plain verb. Prefer the active voice; a passive is fine where English has no subject either
  („Agent wurde entfernt“).
- **Sentence length:** German runs long. Split a long English sentence where it gets a second subclause. Prefer the
  shorter word (*Ordner*, not *Verzeichnis*; *Fehler*, not *Fehlermeldung*, where it's clear), and avoid stacking
  compounds of three or more nouns: „Einstellungen des Projekts“ beats „Projekteinstellungsbereich“.

## Buttons, commands, titles

- **Buttons and menu commands:** the infinitive, object first, as Windows and VS Code do: „Speichern“,
  „Agent hinzufügen“, „Karte verschieben“, „Neu starten“. The same form everywhere.
- **Capitalisation:** German rules: nouns capitalised, everything else lower case, also in titles, buttons and
  headings. Never copy the English Title Case („Agent-Einstellungen“, not „Agent-Einstellungen Öffnen“).
- **A trailing `…`** (the command asks something before it acts) stays, without a space: „Agent entfernen…“.
- **Column headings (stages):** Geparkt (On Hold), Offen (Todo), In Arbeit (Active, was Doing), Review (Review),
  Genehmigt (Approved, was Passed), Wird gemergt (Merging), Erledigt (Done). *Erledigt* means merged (or accepted),
  *Genehmigt* passed its review (or your approval) and waits to be merged. Combwork 1.0 changed *Geprüft* to *Genehmigt*:
  *Geprüft* read as "checked" (never *Freigegeben*, which reads as "released"). They are short on purpose: the board
  shows them in capitals, and *Zurückgestellt* and *Zu erledigen* didn't fit their column's header.
- **Error titles** („Could not add an agent“): a short statement, „Agent konnte nicht hinzugefügt werden“, or a noun
  phrase where space is tight, „Hinzufügen fehlgeschlagen“.
- **Shortcuts** use the German key names printed on keyboards where Combwork shows them so: *Strg* for Ctrl (Combwork's
  menus show `Strg+Shift+J`, from `actions.keys.ctrl`), *Entf* for Del. Shift, Alt and the F keys stay as written.

## Grammar

- **Names have no known gender.** Agents' names (*One*, *Codex*, *Builder*) and people's names don't say which
  pronoun or article fits. Never refer back to a name with *er*/*sie* or a gendered article; put the noun in front
  so it carries the gender („der Agent {agent}“, „Agent {agent}“), repeat the name, or restructure.
  Example: *{agent} was removed. Its sessions stay in the Sessions tab.* → „Agent {agent} wurde entfernt. Die
  Sitzungen bleiben im Tab „Sitzungen“.“ Role nouns (*Reviewer*, *Bearbeiter*) are about agents and stay as they are.
- **Plurals:** German's plural categories are *one* and *other* (CLDR). Every plural message gives both:
  `{n, plural, one {# Karte} other {# Karten}}`. Decimals take *other*. Keep `=0` and other exact cases where the
  English has them.
- **Cases and placeholders:** a placeholder like `{project}` or `{agent}` is a name inserted as it is, uninflected.
  Build the sentence so it needs no case ending: „im Projekt {project}“, „für Agent {agent}“, „von {name}“, never
  „{project}s Agenten“ (write „die Agenten von {project}“). A placeholder that inserts a word or phrase (`{why}`,
  `{what}`) is English-sourced text Combwork translates elsewhere: keep it where it reads as a whole clause.
- **`select`** keys (`{kind, select, file {…} other {…}}`) are ids: never translate them, only the texts inside.
- **Lists:** Combwork joins lists itself („One, Two und Three“). Never write *und* or *oder* into a message around a
  list placeholder.
- **Compounds with names and English terms** take a hyphen: „MCP-Server“, „Git-Branch“, „Claude-Code-Sitzung“,
  „Codex-Agent“. With a placeholder, put the noun in front instead: „Sitzung von {provider}“, „Anbieter {provider}“.

## Punctuation and typography

- **Quotation marks:** „…“ (U+201E, U+201C), and ‚…‘ inside them. They need no escaping in JSON, unlike `"`.
- **Apostrophe:** ’ where German needs one (rare: *geht’s*). Never a straight `'`: in ICU, `'` before `{`, `}` or `#`
  starts a quotation. Where the English quotes a literal brace (`'{'`), keep exactly that.
- **Spaces:** none before `:`, `;`, `?`, `!`.
- **Dashes, colons, ellipsis:** the en dash with spaces (` – `) for a break in a sentence, never the English em dash
  without spaces; `…` as one character. A colon is followed by a capital only when a full sentence follows.
- **Abbreviations:** „z. B.“ and „d. h.“ take a no-break space (U+00A0) inside, so they never break across lines.
- **Times inserted as `{when}`** („vor 5 Minuten“, „gerade eben“, „gestern“) follow a colon or come before the
  participle: „Gemessen: {when}“, „{when} gespeichert“, never „gespeichert {when}“.
- **Fragments inserted into other messages** (descriptions say so: „Could not load {what}“, „Closing loses {what}“)
  are written in the case the host sentence needs: „Konnte {what} nicht laden“ takes the accusative with its article
  („den Verlauf“, „die Sitzungen“).
- **Numbers, dates, money, durations:** formatted by Combwork in German (1.234,5; 15.10.2026). Never write them into a
  message: keep the placeholder and its `number` format.

## Terms

The words German uses for Combwork's terms ([glossary.md](glossary.md)). Use them every time. Where a term is kept in
English, it is as German developers say it.

| English | Deutsch | Notes |
|---|---|---|
| workspace | Arbeitsbereich | As in VS Code. |
| project | Projekt | |
| agent | Agent (der), Agenten | Put the noun before a name (above). |
| provider | Anbieter | |
| session | Sitzung | |
| the Assistant | der Assistent | Its only name: the full English name it had before went with the rename (HI-2458). |
| persona | Persona, Personas | |
| task board / board | Aufgabenboard / Board | *Board* alone in running text. |
| card | Karte | Never *Aufgabe* for a card; *Aufgaben* only in *Aufgabenboard* and the *Tasks* tab („Aufgaben“), and for work given to an agent (below). |
| On Hold / Todo / Active / Review / Approved / Merging / Done | Geparkt / Offen / In Arbeit / Review / Genehmigt / Wird gemergt / Erledigt | The stages (1.0: *Active* was *Doing*, *Approved* was *Passed*; *Genehmigt*, no longer *Geprüft*). In running text: „in Review“, „nach Genehmigt verschieben“, „Karten in „In Arbeit““ where *in In Arbeit* would stumble; *park* a card: „parken“. |
| category / stage | Kategorie / Phase | A stage is a board column; each is in one of six fixed categories. |
| decision | Entscheidung | |
| blocked / stalled | blockiert / festgefahren | |
| builder / reviewer / either | Bearbeiter / Reviewer / beides | Roles of agents in a card loop and in the workflow. Never *Builder*. |
| card loop / lane / round | Kartenschleife / Lane / Runde | *Lane* as in Swimlane. |
| merge slot | Merge-Slot | An agent's turn to merge its own branch. |
| merge queue / test merge / Pause queue, Resume queue | Merge-Warteschlange / Test-Merge / Warteschlange anhalten, Warteschlange fortsetzen | A paused queue is *angehalten*, not *pausiert* (that is a lane). |
| slot / pool / ready (a slot) | Slot / Pool / bereit | A slot is a working folder Combwork lends to a card or lane. |
| review copy / check copy | Review-Kopie / Check-Kopie | Never *Prüfkopie*. |
| Version Control (the tab), version control / None | Versionsverwaltung / Keine | „Tab „Versionsverwaltung““; *None* in quotes in running text: „auf „Keine“ umstellen“. |
| workflow / workflow options / preset (Solo, Pair, Team, Custom) | Workflow / Workflow-Optionen / Voreinstellung (Solo, Paar, Team, Benutzerdefiniert) | |
| rule / old rules / target branch | Regel / alte Regeln / Zielbranch | *Zielbranch* in one word, genitive *des Zielbranchs*. |
| revision / change / same change | Revision / Änderung / dieselbe Änderung | |
| check / checks before review / merge checks | Check / Checks vor dem Review / Merge-Checks | |
| verdict / pass, fail | Urteil / bestanden, nicht bestanden | A reviewer's pass is never a *Zustimmung*; as a noun, „das bestandene Review“, not *das Bestehen*. |
| carries over / stale | bleibt gültig / veraltet | |
| approval / Approve / approved (a card) | Zustimmung / Zustimmen / genehmigt | Never *Freigabe* or *freigegeben*, which read as "released". |
| For you (Decide, Test, Approve, Sign in) | Für dich (Entscheiden, Testen, Zustimmen, Anmelden) | In running text in quotes: „unter „Für dich““. |
| refused / returned / override, Move anyway | abgelehnt / zurückgegeben / Ausnahme, Trotzdem verschieben | |
| no-code card / before 1.0 / outside Combwork / work (a card's section) | Karte ohne Code / vor 1.0 / außerhalb von Combwork / Arbeit | The section in running text: „im Abschnitt „Arbeit““. |
| paused (a lane) / round limit | pausiert / Rundengrenze | |
| project key / deliverables / repository root | Projektschlüssel / Ergebnisse / Repository-Stammordner | |
| inbox / message / wake | Posteingang / Nachricht / wecken | „Combwork weckt den Agenten.“ |
| handover / shared notes | Übergabe / gemeinsame Notizen | |
| skill / template | Skill / Vorlage | The skill's own name stays (`work-on-card`). |
| worktree / branch / commit / merge | Worktree / Branch / Commit / Merge, mergen | As German git users say them; *committen*, *gemergt*. *Remote* stays. |
| Progress panel / run | Fortschrittspanel / Lauf | „Fortschritt“ as the panel's title. |
| Workspace Overview | Arbeitsbereichsübersicht | *Übersicht* where it's clear and space is short. |
| permission mode (Manual, Accept edits, Plan, Auto, Don't ask) | Berechtigungsmodus (Manuell, Änderungen annehmen, Planen, Auto, Nicht fragen) | The CLIs' own screens stay English. |
| effort / usage / cost / tokens | Aufwand / Nutzung / Kosten / Tokens | *API-equivalent cost*: „Kosten zu API-Preisen“. |
| banner / notification / tip | Banner / Benachrichtigung / Tipp | |
| sign in | anmelden, angemeldet, abmelden | |
| Agent API | Agent API | A name: never hyphenated („Referenz der Agent API“, „Anfragen an die Agent API“). |
| conversation / transcript | Unterhaltung / Transkript | |
| compact, compaction | komprimieren, Komprimierung | The button: „Komprimieren“. |
| an agent's turn | Durchgang | Not *Runde*, which is a card loop's round. |
| Inherit (a setting's choice) | Geerbt | „Geerbt (Einstellungen: Plan)“. The button that inherits again: „Erben“. |
| Working on (a project) | Aktiv | Not *In Arbeit*, which is the Active stage. |
| idle | untätig | „Als untätig markieren“. |
| memory (a CLI's memory files) | Gedächtnis | The project tab „Gedächtnis“. |
| background tasks | Hintergrundaufgaben | They aren't cards. |
| a task (work given to an agent: what the Assistant types into its terminal) | Aufgabe | „eine Aufgabe geben“, „keine neue Aufgabe geben“. Not a card. |
| backup | Sicherung | |
| staged | bereitgestellt | As VS Code says. Never *vorgemerkt*. |
| watch (a card watch) | Beobachtung, Kartenbeobachtung | |
| Provider Setup | Anbieter-Einrichtung | |
| the shipped modes (Coordinator, Planner, QA triager, Release manager) | Koordinator, Planer, QA-Triage, Release-Manager | As `assistant.modes.shipped.*` shows them. |

Common UI words, for consistency:

| English | Deutsch |
|---|---|
| Settings | Einstellungen |
| folder / file | Ordner / Datei |
| tab | Tab (der) — never *Registerkarte*, which collides with *Karte* |
| pane / panel | Bereich / Panel |
| sidebar / status bar / activity bar | Seitenleiste / Statusleiste / Aktivitätsleiste |
| command palette | Befehlspalette |
| shortcut | Tastenkombination |
| Cancel / Close / OK | Abbrechen / Schließen / OK |
| Remove / Delete | Entfernen / Löschen |
| Stop (an agent, a run) / Quit (Combwork) | Stoppen / Beenden |
| Resume / Restart | Fortsetzen / Neu starten |
| Recycle Bin | Papierkorb |
| Diagnostics | Diagnosedaten |
| Docs | Dokumentation |

## Examples

| English | Deutsch |
|---|---|
| Remove agent… | Agent entfernen… |
| {name} has {n, plural, one {# open card} other {# open cards}} | {name} hat {n, plural, one {# offene Karte} other {# offene Karten}} |
| {agent} was removed. Its sessions stay in the Sessions tab. | Agent {agent} wurde entfernt. Die Sitzungen bleiben im Tab „Sitzungen“. |
| Combwork was started in {language} (--lang): this setting applies from its next start. | Combwork wurde mit --lang {language} gestartet: Diese Einstellung gilt ab dem nächsten Start. |

## Checking

- `npm run i18n:check` passes, and `npm run i18n:coverage` shows what is still missing or outdated.
- Look at the screenshots: `npm run e2e -- --lang de --build`, in both themes, for text that is cut off or wraps
  badly. German is often a third longer than English. Shortened after the first screenshots (October 2026): the
  board's column headings, the project header's single-agent buttons („Fortsetzen“, „Stoppen“), the pane's ended
  bar („Beendet.“), the Sessions search box, the memory list, the keybindings table's „Tasten“ column and the Unused
  worktrees button. Where no shorter German fits, the layout is a follow-up card, not a wording change.
- A reviewer of this language should look first at the board and the Session tab (the most-seen screens), and at
  the terms table above: a term changed means every message that uses it changes.
