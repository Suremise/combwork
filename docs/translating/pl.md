# Polski (`pl`): style for Combwork

**Status:** drafted by AI (Claude, October 2026), not yet reviewed by a native speaker. Its entry in
`src/shared/i18n/languages.ts` says the same (`ai: true` until it is reviewed).

**In the language picker:** Polski, marked (AI) while drafted by AI, with the note „Przetłumaczone przez AI, poprawki
mile widziane.”

**Improving it:** every Polish message is in `locales/pl/<area>.json`, one file per part of Combwork. If a word is wrong,
stiff or unclear, change it there and open a pull request on GitHub (`Suremise/hive-desktop`): `CONTRIBUTING.md` says
how, and a small fix can be made in GitHub's web editor. If you change a term from the table below, change it in every
message and on this page in the same pull request, so Combwork keeps one voice. A native speaker's review takes the (AI)
mark off.

## Voice

Combwork's English is plain and direct: short sentences, everyday words, *you* for the reader, and it says what happens.
Translate the meaning, not the words, and keep the result as short and plain.

- **Addressing the reader:** the informal *ty*, as most Polish software does today: „Zapisz zmiany”, „Możesz…”,
  „Twój projekt”. Never *Pan/Pani* or the impersonal plural *Państwo*. Pronouns that refer to the reader are
  capitalised, as in a letter: *Ty, Ci, Cię, Twój, Twoje* („odpowiadać Ci w Twoim języku”). Leave them out where the
  verb already says it (Polish rarely needs „Ty”).
- **Tone:** friendly and direct, never bureaucratic. Avoid office phrasing („dokonaj zapisu”, „w celu”, „przedmiotowy”),
  nominal chains („przeprowadzenie usunięcia”) and passive voice where an active verb works. Write „Combwork usuwa…”,
  not „Zostaje usunięty przez Combwork…”.
- **Sentence length:** Polish runs about a fifth longer than English. Split a long English sentence rather than
  stacking subordinate clauses with „który”. In tight places (buttons, badges, column headings, status bar) choose the
  shortest natural word.

## Buttons, commands, titles

- **Buttons and menu commands:** the imperative, second person singular: „Zapisz”, „Usuń”, „Anuluj”, „Otwórz”,
  „Dodaj agenta…”. The same form everywhere, including menu items and the command palette.
- **Capitalisation:** sentence case everywhere: only the first word and names take a capital („Dodaj nowego agenta”,
  „Ustawienia agenta”). Don't copy the English Title Case. Names stay as they are (Combwork, Claude Code, Assistant).
- **A trailing `…`** stays, with no space before it: „Usuń agenta…”.
- **Column headings:** Wstrzymane, Do zrobienia, Aktywne, Recenzja, Zatwierdzone, Gotowe (and the stage Scalanie inside
  Zatwierdzone). Before 1.0 the Active column was „W toku”; it is „Aktywne” now (a Polish user's feedback, #1104).

## Grammar

- **Names have no known gender.** An agent's name (*One*, *Codex*, *Builder*) or a person's name doesn't say whether a
  past-tense verb is masculine or feminine. Never make a verb agree with a name. Either put the noun in front, so it
  carries the gender („Agent {agent} zakończył pracę”), use the present tense („{agent} pracuje”), or use an impersonal
  form in *-no/-to* („Usunięto agenta {agent}”). Example: „{agent} was removed.” → „Usunięto agenta {agent}.”, not
  „{agent} został usunięty”.
- **Plurals:** Polish has the CLDR categories *one, few, many, other*. Every plural message gives all four:
  `{n, plural, one {# karta} few {# karty} many {# kart} other {# karty}}`. *one* is exactly 1; *few* is 2–4, 22–24…;
  *many* is 0, 5–21, 25…; *other* is fractions (1,5 karty), so it takes the genitive singular, usually the same form
  as *few* for nouns („1,5 karty”, „2,5 minuty”). Where the English has `=0` or `=1`, keep it too.
- **Cases and placeholders:** a placeholder like `{project}` or `{agent}` is a name inserted as it is, in the
  nominative. Put a noun in front of it to take the case: „w projekcie {project}”, „dla agenta {agent}”, „z karty
  {card}”, „w obszarze roboczym {workspace}”. A placeholder that holds a sentence or a status is placed so it can stand
  on its own, usually after a colon.
- **Counting agents:** *agent* is a masculine personal noun, so 2–4 take the genitive plural, like 5 and more:
  `{n, plural, one {# agent} few {# agentów} many {# agentów} other {# agenta}}`, with a singular verb
  („3 agentów pracuje”).
- **Combwork as a subject:** Combwork is an app, and Polish treats app names as masculine („program Combwork”): „Combwork nie mógł
  sprawdzić…”, „Combwork przeniósł…”, always masculine. Combwork isn't inflected, so where a sentence needs it in another case
  („Combwork nie udało się”), rephrase: „Nie udało się…”.
- **„Could not load {what}”:** the frames are „Nie udało się wczytać {what}” and „Nie udało się odświeżyć {what}”, so
  every `{what}` they take is in the genitive („szablonów”, „historii”, „gałęzi i zdalnych repozytoriów”).
- **Lists:** Combwork joins lists itself („One, Two i Three”). Never write „i” or „lub” into a message around a list
  placeholder.
- **Numbers before nouns:** with `{n, number}` inside a sentence, keep the noun's form in the plural branches, never
  after a bare number outside a plural.

## Punctuation and typography

- **Quotation marks:** „…” (U+201E and U+201D); inside them, »…«. They need no escaping in JSON, unlike `"`.
- **Apostrophe:** Polish rarely needs one. Where it does (a foreign name: „Combwork’a” is avoided, see Terms), write ’.
  Before `{`, `}` or `#`, a straight apostrophe starts an ICU quotation: keep the English's `'{'` exactly as it is.
- **Spaces:** none before `:`, `;`, `?`, `!`. A space before and after a dash: „Combwork – aplikacja…”, with an en dash
  (–), not a hyphen.
- **Colons:** after a colon, lower case unless a name or a full sentence follows that would start with a capital in
  English too.
- **Numbers, dates, money, durations:** formatted by Combwork in the Polish way (1 234,5; 15.10.2026). Never write them
  into a message.

## Terms

The words Polish uses for Combwork's terms ([glossary.md](glossary.md)). Use them every time.

| English | Polski | Notes |
|---|---|---|
| workspace | obszar roboczy | „w obszarze roboczym”. |
| project | projekt | |
| agent | agent | *agenta, agentowi, agenci, agentów*. |
| provider | dostawca | Claude Code, Codex or Copilot. |
| session | sesja | |
| the Assistant | Asystent | Capitalised, as a name: „zapytaj Asystenta”. Its only name: the full English name *Hive Assistant* went with the rename (HI-2458). |
| persona | persona | *persony*. |
| task board / board | tablica zadań / tablica | The *Tasks* tab is the „Zadania” tab („zakładka Zadania”). |
| card | karta | Feminine: „karta jest zablokowana”, „karta utknęła”. Never „zadanie” for a card in running text. |
| On Hold / Todo / Active / Review / Approved / Done | Wstrzymane / Do zrobienia / Aktywne / Recenzja / Zatwierdzone / Gotowe | The board's categories and default stages (1.0; *Active* was *Doing*, „W toku”, and *Approved* was *Passed*). *Gotowe* means merged (or accepted); *Zatwierdzone* means it passed its review but isn't merged. Name a column in a sentence with a noun in front: „do kolumny Aktywne”, „na etapie Zatwierdzone”. Agents' tool text keeps the English ids (`doing`, `passed`). |
| Merging (a stage in Approved) | Scalanie | |
| category / stage | kategoria / etap | „na etapie {stage}”. |
| decision | decyzja | |
| blocked / stalled | zablokowana / utknęła (zastój) | Said of a card: „zablokowana karta”, „karta utknęła”. |
| builder / reviewer / either (workflow role) | wykonawca / recenzent / dowolna | |
| review (the act) | recenzja | „przekaż do recenzji”, „recenzja nie przeszła”. |
| card loop / lane / round | pętla kart / tor / runda | *Start lane…*: „Uruchom tor…”. |
| merge queue / test merge | kolejka scalania / scalanie próbne | *kolejka scalania* was the old *merge slot*'s word; from 1.0 it names the merge queue. *Pause queue / Resume queue*: „Wstrzymaj kolejkę / Wznów kolejkę”. |
| merge slot (one agent merge at a time into a branch, where agents merge) | blokada scalania | Feminine: „blokada jest wolna”, „zwolnij ją”. Never *kolejka scalania*, which is the merge queue (Darren, HI-1928). |
| slot / pool / ready (a slot) | slot (*slotu, sloty, slotów*) / pula / gotowy | „w slocie {slot}”, „pula recenzentów”. |
| version control (the Version Control tab) | kontrola wersji (zakładka Kontrola wersji) | Its choice *None*: „Brak” („opcja Brak”). |
| workflow / workflow options | przepływ pracy / opcje przepływu pracy | |
| preset (Solo, Pair, Team, Custom) | ustawienie wstępne (Solo, Para, Zespół, Własne) | „ustawienie Para”. |
| rule / old rules | reguła / stare reguły | |
| target branch / up to date | gałąź docelowa / aktualna | „aktualna względem {target}”. |
| revision / change / same change | rewizja / zmiana / ta sama zmiana | |
| check / checks before review / merge checks | sprawdzenie / sprawdzenia przed recenzją / sprawdzenia przed scaleniem | A check *passed / failed*: „udane / nieudane”. |
| pass / fail (a verdict) | zaliczona / niezaliczona (zaliczenie) | Said of the review: „recenzja zaliczona”. A reviewer's pass is never an approval (*zgoda*). *carries over*: „pozostaje ważne”; *stale*: „nieaktualne”. |
| approval / Approve | zgoda / Zatwierdź | Your OK on a card: „Twoja zgoda przed scaleniem”. |
| For you (Decide, Test, Approve, Sign in) | Dla Ciebie (Zdecyduj, Przetestuj, Zatwierdź, Zaloguj się) | „w sekcji Dla Ciebie”. |
| review copy | kopia do recenzji | |
| refused / returned (a card) | odrzucono / zwrócona | „Karta {card} zwrócona wykonawcy {builder}”. |
| override / Move anyway | wyjątek / Przenieś mimo to | |
| no-code card / before 1.0 / outside Combwork | karta bez kodu / sprzed 1.0 / poza Combwork | |
| work (a card's Work section) | praca (sekcja Praca) | |
| deliverables | rezultaty | |
| inbox / message / wake | skrzynka odbiorcza / wiadomość / wybudzenie (wybudzić) | |
| handover / shared notes | przekazanie (notatka przekazania) / notatki wspólne | |
| skill / template | umiejętność / szablon | A skill's own name (`work-on-card`) stays as it is. |
| worktree / branch / commit / merge | worktree / gałąź / commit / scalanie (scalić) | *worktree* is kept and not inflected: „w worktree”, „worktree agenta”. *commit* inflects as Polish git users say it: *commita, commity, commitów*. *remote* is „zdalne repozytorium” (*remote* in commands). |
| Progress panel / run | panel Postęp / uruchomienie | „w panelu Postęp”. |
| Workspace Overview | Przegląd obszaru roboczego | |
| permission mode (Manual, Accept edits, Plan, Auto, Don't ask) | tryb uprawnień (Ręczny, Akceptuj edycje, Plan, Auto, Bez pytania) | The CLIs' own screens stay in English. |
| effort / usage / cost / tokens | wysiłek / użycie / koszt / tokeny | Effort levels: niski, średni, wysoki, bardzo wysoki, maksymalny. *API-equivalent cost*: „koszt według cen API”. |
| banner / notification / tip | baner / powiadomienie / wskazówka | A *notification* is Windows'; a *banner* is inside Combwork's window. |
| sign in | zaloguj się / zalogowany | *sign out*: wyloguj się. |
| tab | zakładka | Never „karta”, which is a card: „w zakładce Sesje”. |
| settings | ustawienia | |
| file / folder | plik / folder | |
| terminal | terminal | |
| conversation / transcript | rozmowa / transkrypcja | |
| Combwork (inflected) | Combwork | Not inflected: „w Combwork”, „okno Combwork”, „ustawienia Combwork”. |
| uncommitted (changes, files) | bez commita | „# pliki bez commita”, „zmiany bez commita”. Never „niezatwierdzone”, which reads as the Approved column; and to commit is „zrób commit”, never „zatwierdź”, which is Approve. |
| staged / unstage | w indeksie / usuń z indeksu | |
| fetch / pull / push | pobierz / ściągnij / wypchnij | |
| check out (a branch) | wybierz (gałąź wybrana w folderze projektu) | |
| detached HEAD | odłączony HEAD | |
| hook | hook (hooki) | |
| status line (a CLI's) / status bar (Combwork's) | linia statusu / pasek stanu | |
| compact / compaction | kompaktuj / kompaktowanie | |
| prompt | prompt (prompty, promptów) | |
| cache (prompt cache) | pamięć podręczna in sentences, cache in short figures | |
| archive / unarchive | zarchiwizuj / przywróć | Buttons: „Zarchiwizuj i zacznij nową”. |
| Start New (a session) | Zacznij nową | |
| Hand Over to… | Przekaż pracę… | handover note: notatka przekazania. |
| watch (a card watch) | obserwowanie (obserwuje) | |
| verdict | werdykt | |
| Storage (a project's) | Miejsce na dysku | Clean Up…: Wyczyść…. |
| Repair (a moved workspace) | Naprawa (button: Napraw…) | |
| Recycle Bin / File Explorer | Kosz / Eksplorator plików | |
| Provider Setup | Konfiguracja dostawców | |
| Mark idle | Oznacz jako bezczynny | |
| layouts | Pojedynczo, Dwie kolumny, Trzy kolumny, Siatka 2×2, Siatka 3×2 | |
| the Assistant's modes | Koordynator, Planista, Triażysta QA, Menedżer wydań | |
| timeout | limit czasu | |
| redacted / unredacted | z ukrytymi danymi (ukrywa dane wrażliwe) / bez ukrywania danych | Never „redagować”, which means editing a text. *masked* (tokens, keys): zamaskowane. |
| safeguard / safety classifier | zabezpieczenie / klasyfikator bezpieczeństwa | |
| system tray | zasobnik systemowy | |

## Examples

| English | Polski |
|---|---|
| Remove agent… | Usuń agenta… |
| {name} has {n, plural, one {# open card} other {# open cards}} | {name}: {n, plural, one {# otwarta karta} few {# otwarte karty} many {# otwartych kart} other {# otwartej karty}} |
| {agent} was removed. Its sessions stay in the Sessions tab. | Usunięto agenta {agent}. Jego sesje zostają w zakładce Sesje. |
| Combwork was started in {language} (--lang): this setting applies from its next start. | Combwork uruchomiono z językiem {language} (--lang): to ustawienie zadziała od następnego uruchomienia. |

The example with `{name}` shows the usual way round agreement with a name: a colon instead of „ma”, which would be
fine here, but the same shape also fits verbs that would agree with a gender.

## Checking

- `npm run i18n:check` passes, and `npm run i18n:coverage` shows what is still missing or outdated.
- Look at the screenshots: `npm run e2e -- --lang pl --build`, in both themes, for text that is cut off or wraps
  badly. Polish runs long in buttons, the status bar and the board's column headings: there the shortest natural word
  was chosen („Recenzja”, „Aktywne”).
- A reviewer should look first at the plurals (all four forms), past-tense verbs next to names, and the status bar's
  limit tooltip (GitHub issue #1).
