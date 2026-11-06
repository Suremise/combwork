# Français (`fr`): style for Combwork

**Status:** drafted by AI (Claude, October 2026, card #855), not yet reviewed by a native speaker. Its entry in
`src/shared/i18n/languages.ts` says the same (`ai: true` until it is reviewed).

**In the language picker:** Français, marked (IA) while drafted by AI, with the note *Traduit par IA : les
améliorations sont les bienvenues.*

**Improving it:** this translation was drafted by an AI model and has not been checked by a native speaker yet, so
some wording will be stiff or wrong. Corrections are very welcome: edit `locales/fr/<area>.json`, run
`npm run i18n:check` (it must pass), and open a pull request on
[Suremise/combwork](https://github.com/Suremise/combwork) saying what you changed and why. A change to a
term in the table below changes it everywhere: change this page first, then every message that uses it. Once a
native speaker has reviewed the whole language, its `ai` flag comes off.

## Voice

Combwork's English is plain and direct: short sentences, everyday words, *you* for the reader, and it says what happens.
Translate the meaning, not the words, and keep the result as short and plain.

- **Addressing the reader:** the informal *tu* (*Choisis un projet*, *tes agents*), as Combwork's translation design
  decided for every language that has one. Never *vous* for the reader. (The plural *vous* is fine when it means
  several people.)
- **Tone:** friendly and direct, never familiar or jokey. Prefer active sentences: *Combwork enregistre la session*, not
  *La session est enregistrée par Combwork*. Avoid administrative phrasing (*procéder à*, *effectuer*, *veuillez*).
- **Sentence length:** keep one English sentence as one French sentence where it reads well; split a long one rather
  than chain *qui* and *dont* clauses. French runs about 20% longer than English: in buttons, titles and column
  headings, choose the shorter word.
- **Words:** standard French as used in France, Belgium, Switzerland and Canada alike: *courriel* or *e-mail* both
  read, but prefer the plain *adresse e-mail*; *fichier*, *dossier*, *cliquer*, *coller*.

## Buttons, commands, titles

- **Buttons and menu commands:** the infinitive (*Enregistrer*, *Ajouter un agent…*, *Afficher les notes
  partagées*). The same form everywhere, including the command palette.
- **Capitalisation:** sentence case everywhere: titles, buttons, menus, headings, tabs, settings and column names
  (*Paramètres de l’agent*, *Redémarrer et mettre à jour Combwork*). Don't copy the English Title Case. Product names and
  the glossary's kept names keep theirs.
- **A trailing `…`** (the command asks something before it acts) stays, with no space before it: *Retirer
  l’agent…*. Always the single character …, never three dots.
- **Column headings** (the board's stages, [glossary-1.0](../../locales/glossary-1.0.md) 2.2): *Suspendu*, *À faire*,
  *En cours* (Active, was Doing), *Relecture*, *Validé* (Approved, was Passed), *Fusion en cours* (Merging, a stage
  inside Validé), *Terminé*. In running text name the column (*dans la colonne Relecture*, *passe en Terminé*,
  *revient en Validé*), never an agreed participle (*jusqu’à ce qu’elle passe en Terminé*, not *soit Terminée*).
- **Where things are:** paths through menus and settings keep Combwork's arrows, with each name as Combwork shows it in
  French: *Paramètres → Fournisseurs*, *Aide → Configuration des fournisseurs*.

## Grammar

- **Names have no known gender.** Agents' names (*One*, *Codex*, *Builder*) and people's names don't say how a word
  must agree. Put the noun first, so it carries the gender (*l’agent {agent}*, *la carte #{n}*), or use a form that
  doesn't agree. Example: *{agent} was removed* → *L’agent {agent} a été retiré*, not *{agent} a été retiré(e)*.
- **Elision before a placeholder:** *de {project}* would need *d’* before a vowel, which a placeholder can't know.
  Put a noun between them: *du projet {project}*, *de l’agent {agent}*, never *de {name}* or *le {name}*.
- **Cards are feminine** (*la carte*): *bloquée*, *à l’arrêt*, *archivée*, *déplacée*. Agents are masculine (*l’agent*),
  sessions feminine (*la session*), worktrees masculine (*le worktree*).
- **Plurals:** French's plural categories are *one*, *many* and *other* (CLDR). *one* covers 0 and 1 (*0 carte*,
  *1 carte*). *many* is for large round numbers (1 000 000), which French says like *other*. Every plural message
  gives all three, *many* the same as *other*: `{n, plural, one {# carte} many {# cartes} other {# cartes}}`. Exact
  cases from the English (`=0`) stay.
- **Lists:** Combwork joins lists itself (*One, Two et Three*). Never write *et* or *ou* into a message around a list
  placeholder.

## Punctuation and typography

- **No-break spaces:** a no-break space (the character U+00A0) goes before *:* *;* *?* *!* and inside *« »*:
  *Paramètres : général*, *Continuer ?*, *« texte »*. Never an ordinary space there (a line could break before the
  mark), and never no space. Write the character itself in the JSON, not an escape.
- **Quotation marks:** « … » with no-break spaces inside; “…” inside them. Never the straight `"`.
- **Apostrophe:** always the typographic ’ (*l’agent*, *aujourd’hui*). In ICU a straight `'` before `{`, `}` or `#`
  starts a quotation and hides text, so the straight apostrophe is never used.
- **Ellipsis, dashes:** the single character …; a dash in running text is –, with spaces.
- **Numbers, dates, money, durations:** formatted by Combwork in the reader's locale. Never write them into a message.
- **Capitals keep their accents:** *À faire*, *État*, *Écrire*.
- **Keys:** a single key named in running text takes the label French keyboards print: *Entrée*, *Échap*, *Maj*,
  *Suppr* (*Échap ferme les boîtes de dialogue*). A shortcut written as keys keeps Combwork's notation, as its menus show
  it: `Ctrl+Shift+J`, `Shift+Tab`, and so does a key inside `<kbd>`.

## Terms

The words French uses for Combwork's terms ([glossary.md](glossary.md)). Use them every time. Where a term is kept in
English, it says so.

| English | Français | Notes |
|---|---|---|
| workspace | espace de travail | |
| project | projet | |
| agent | agent | Masculine: *l’agent {agent}*. |
| provider | fournisseur | |
| session | session | *Starting a session*: *démarrer une session*; signing in is *se connecter* (below). |
| the Assistant | l’Assistant | Capitalised. Its only name: the full English name it had before went with the rename (HI-2458). |
| persona (now: working mode) | mode (mode de travail) | The Assistant's personas became *modes*; the old *persona* is *personnage*. |
| task board / board | tableau des tâches / tableau | The *Tasks* tab is *Tâches*. |
| card | carte | Never *tâche* in running text. |
| On Hold / Todo / Active / Review / Approved / Merging / Done | Suspendu / À faire / En cours / Relecture / Validé / Fusion en cours / Terminé | Categories and stages (1.0). *Active* was *Doing*, *Approved* was *Passed*: the French words didn't change. *Terminé* means merged (or accepted); *Validé*, approved but not merged. |
| category / stage | catégorie / étape | |
| Version Control (the tab) / version control | Gestion de versions / gestion de versions | The tab was *Git*. *None* (no version control) is *Aucune*. |
| workflow / workflow options | flux de travail / options du flux de travail | |
| preset: Solo / Pair / Team / Custom | préréglage : Solo / Binôme / Équipe / Personnalisé | |
| rule / old rules | règle / anciennes règles | *Rule* is what the user reads for a gate. |
| target branch / repository root | branche cible / racine du dépôt | *Up to date* (with the target): *à jour*. |
| revision / change / same change | révision / modification / la même modification | *Carries over*: *reste valable*. |
| check / checks before review / merge checks | vérification / vérifications avant relecture / vérifications de fusion | A run of a check *réussit* or *échoue*. |
| verdict: pass / fail | verdict : validée / refusée | Of a review (*relecture validée*, *relecture refusée*); the noun for a pass is *validation*. A pass is never an *approbation*. *Stale* (a pass): *périmée*. |
| approval / Approve / your OK | approbation / Approuver / ton accord | Only the user's OK, never a reviewer's pass. |
| For you: Decide / Test / Approve / Sign in | Pour toi : Décider / Tester / Approuver / Se connecter | |
| review copy | copie de relecture | Never *revue*. |
| refused / override / Move anyway | refusé / dérogation / Déplacer quand même | |
| returned (to its builder) | renvoyée | Of a card. |
| no-code card / before 1.0 / outside Combwork | carte sans code / antérieure à 1.0 / hors de Combwork | |
| Work (a card's section) | Travail | |
| paused (a lane) / Pause queue / Resume queue | en pause / Suspendre la file / Reprendre la file | A paused merge queue is *suspendue*. |
| merge queue / test merge | file de fusion / fusion d’essai | *La file de fusion vers {target}*, never *de {target}*. |
| slot / pool / ready | emplacement / groupe / prêt | *Slot* is masculine (*l’emplacement {slot}*). A pool of reviewers is *le groupe de relecteurs*. |
| project key | clé du projet | |
| uncommitted / committed | non commité / commité | Never *validé*, which is the Approved stage and a pass. |
| decision | décision | |
| blocked / stalled | bloquée / à l’arrêt | Of a card. |
| builder / reviewer / either | auteur / relecteur / les deux | The builder is who does the card's work (not who created it: *créée par*; never *constructeur*). A review is a *relecture*; to review, *relire*. A review's *verdict* is *verdict*. |
| card loop / lane / round / Start lane… | boucle de cartes / couloir / tour / Démarrer un couloir… | |
| merge slot | créneau de fusion | An agent's turn to merge. From 1.0, cards Combwork merges go through the merge queue (*file de fusion*, above). |
| inbox / message / wake | boîte de réception / message / réveiller | *Wake* as a noun is *réveil*. A card *watch* is a *surveillance* (*surveiller*). |
| handover / shared notes | passation / notes partagées | |
| skill / template | compétence / modèle | A skill's own name (`work-on-card`) is kept. |
| worktree / branch / commit / merge | worktree / branche / commit / fusionner, fusion | *worktree* and *commit* are kept, masculine (*le worktree*, *les commits*; *faire un commit*). *Remote*: *dépôt distant*. *Push*, *pull*, *fetch*, *rebase* are kept as git's commands: *faire un push*. *Repository*: *dépôt*. *Detached HEAD*: *HEAD détachée*. |
| Progress panel / run | panneau Progression / exécution | |
| Workspace Overview | Vue d’ensemble de l’espace de travail | |
| permission mode | mode d’autorisation | Manual *Manuel*, Accept edits *Accepter les modifications*, Plan *Plan*, Auto *Auto*, Don't ask *Ne pas demander*, Ask *Demander*, Bypass permissions *Ignorer les autorisations*, Approve for me *Approuver pour moi*, Ask for approval *Demander l’approbation*, Full access *Accès complet*, Read only *Lecture seule*, Allow all *Tout autoriser*, Autopilot *Pilote automatique*. The CLIs' own screens stay in English. |
| effort / usage / cost / tokens | effort / utilisation / coût / jetons | *Cache*: *cache*; *context*: *contexte*; *usage limit*: *limite d’utilisation*. |
| banner / notification / tip | bannière / notification / astuce | |
| sign in | se connecter | *Signed in*: *connecté*; *sign out*: *se déconnecter*; *sign-in*: *connexion*. |
| compact, compaction | compacter, compactage | |
| transcript | transcription | |
| hook | hook | Kept, masculine (*les hooks*). |
| prompt | prompt | Kept, masculine: what is typed to an agent. A *permission prompt* is a *demande d’autorisation*. |
| terminal | terminal | Masculine. |
| pane / tab / layout | volet / onglet / disposition | |
| status bar / activity bar / sidebar / footer | barre d’état / barre d’activité / barre latérale / pied | |
| command palette | palette de commandes | |
| tray | zone de notification | |
| Recycle Bin | Corbeille | As Windows says it. |
| resume | reprendre | |
| idle / working / waiting / stopped | inactif / au travail / en attente / arrêté | Of an agent. |
| settings | paramètres | *Settings → …* is *Paramètres → …*; *Agent Settings* is *Paramètres de l’agent*. |
| add / remove / delete | ajouter / retirer / supprimer | *Remove* takes something out of a list or a project; *delete* destroys it. |

## Examples

| English | Français |
|---|---|
| Remove agent… | Retirer l’agent… |
| {name} has {n, plural, one {# open card} other {# open cards}} | {name} : {n, plural, one {# carte ouverte} many {# cartes ouvertes} other {# cartes ouvertes}} |
| {agent} was removed. Its sessions stay in the Sessions tab. | L’agent {agent} a été retiré. Ses sessions restent dans l’onglet Sessions. |
| Combwork was started in {language} (--lang): this setting applies from its next start. | Combwork a été démarré avec la langue {language} (--lang) : ce paramètre s’applique au prochain démarrage. |

## Checking

- `npm run i18n:check` passes, and `npm run i18n:coverage` shows what is still missing or outdated.
- Look at the screenshots: `npm run e2e -- --lang fr --build`, in both themes, for text that is cut off or wraps
  badly. French runs longer than English: settings titles, the board's column headings and the agent strip's
  buttons are where it shows first.
  The first check (October 2026) changed these:
  - the On Hold column is *Suspendu* (*En suspens* wrapped in its heading, and *En pause* is a paused lane);
  - *Session ended.* in a pane is *Terminée.*;
  - an agent's *Finished* status is *Fini*, so it isn't confused with the Done column (*Terminé*, merged);
  - *Archive and Start New* is *Archiver et repartir*;
  - search placeholders start *Chercher :*;
  - *À faire* in running text takes a no-break space (*À faire*), so it never splits across lines;
  - settings titles that ended in a dangling *de* became *Suggérer de compacter dès* and *Avertir quand une
    transcription dépasse*.
- **Model and template** are both *modèle* in French, as French software usually says (Word's *Modèles*). Where both
  appear together, the context or the noun after it tells them apart (*le modèle Opus*, *un modèle d’agents*). A
  native reviewer may prefer another word for a template.
- **Messages with `{what}`** (*Could not load {what}*) take a noun phrase that can be singular or plural, masculine or
  feminine: write them so nothing agrees with it (*Échec du chargement : {what}*).
- A reviewer should look first at the terms above (above all *carte*, *auteur* / *relecteur*, *couloir*), at
  agreement and elision with names, and at the no-break spaces.
