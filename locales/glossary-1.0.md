# Hive 1.0 glossary: the workflow layer's terms in every language

**Status:** written in 1.0 P1 (#1117), 20 Oct 2026, for every 1.0 phase (P2–P8) and the translation review (#1126).
The English labels marked **(proposed)** wait for Darren's agreement (SPEC §16.20, open point OP-1); the
translations follow the English once it is agreed, so a label that changes is translated again here first, then in
`locales/`. Nothing in this file is a message: messages stay in the code (`msg()`), and their translations in
`locales/<code>/<area>.json`.

**How it relates to the other glossaries:**
- [docs/translating/glossary.md](../docs/translating/glossary.md) is Hive's glossary of every term, with *keep* or
  *translate*; each language's style page (`docs/translating/<code>.md`) records the word it uses. This file adds the
  1.0 workflow terms. Its words agree with the style pages where a term already exists (*card*, *verdict*, *merge*,
  *worktree*, *run*), and a change to an existing word is marked **changed** with its reason.
- When a phase merges, the terms it shipped are copied into `docs/translating/glossary.md` and each style page's Terms
  table, so translators have one place to look after 1.0. Until then, this file wins for 1.0 terms.
- Reviewers of every 1.0 phase check new strings against this file (SPEC §16.18).

Language codes: **de** German, **es** Spanish, **fr** French, **ja** Japanese, **pl** Polish, **pt-BR** Brazilian
Portuguese, **zh-CN** Simplified Chinese. Agent-facing text (tool replies, refusals as the agent reads them, guidance,
the Agent API) stays English and isn't translated (AGENTS.md, Translations).

## 1. Authoring rules for 1.0 text (English source)

These apply to every user-visible string added on the 1.0.0 branch. They come from #884's findings, #908's readiness
and the 19 Oct decisions on #1117. Reviewers fail a string that breaks one.

1. **Say "card", never "task"** for a card (*Task board* and the *Tasks* tab keep their names). A card's key is written
   as the card shows it (`AM-12`, or `#1061` for a card from before keys).
2. **No bare `{n}`.** A number in a sentence is `{n, number}`; a count next to a noun is a plural
   (`{n, plural, one {# card} other {# cards}}`); sizes, durations, dates and percentages go through `fmt`,
   `shared/units.ts` and `shared/dates.ts`. Never `n === 1 ? '' : 's'`.
3. **No sentences glued from pieces.** One message per sentence, with placeholders. Lists use `fmt.list`, never "and"
   written around a placeholder. A refusal is one message with its rule, next step and where to change it as
   placeholders or parts of the same message (SPEC §16.8.3), never three strings concatenated.
4. **No names after prepositions.** "Added by {by}" reads badly in Polish, German and Japanese. Put a noun in front
   ("Added by agent {agent}") or use a colon ("{agent}: added"), or rephrase so the name is the subject. The same goes
   for a name a past-tense verb would agree with (the style pages' *Names have no known gender*).
5. **Outcomes, not mechanics** (Darren, 19 Oct). An option says what happens to the work: "Work is reviewed before it
   reaches main", not "Verdict binding: on". A mechanism (patch-id, temporary ref, merge-base) appears only in a
   description's second sentence or in Learn more, never in a label.
6. **The user's words, not the code's.** Internal terms have a user word (section 3): the user never reads *gate*,
   *intent*, *fact*, *capability*, *sameness*, *scratch checkout* or *integration* in the window.
7. **Short labels.** German and Polish run 20–35% longer than English. Option labels fit one line of the Version
   Control tab at its narrowest (a label of at most about 60 English characters); stage names fit a board column
   heading (at most about 14 English characters: "Merging", "Review").
8. **Logical CSS for every new 1.0 style** (#908: right-to-left stays undecided until after 1.0, but 1.0 adds no debt):
   `margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `border-inline-start`, `text-align: start`;
   never `left`/`right` in a new rule. Icons that point a direction (chevrons, arrows) take a class that can be
   mirrored later.
9. **Same concept, same word, everywhere:** the board, the Progress panel, the Version Control tab, the card dialog,
   notifications and the user's side of refusals. A refusal the agent got in English is shown to the user in their
   language from the same message (SPEC §16.8.3).
10. **The user's name.** Where a string means the user, it says *you* ("Waiting for you"), never "the user" or a
    person's name written into the message.

## 2. The terms

Each table gives the English (as the window shows it), what it means, and the word each language uses. *keep* means
the English word stays in that language.

### 2.1 Version control and its options

| English | Meaning | de | es | fr | ja | pl | pt-BR | zh-CN |
|---|---|---|---|---|---|---|---|---|
| **Version Control** (the tab) | The project's tab (renamed from Git) where you choose the version control and its workflow options. | Versionsverwaltung | Control de versiones | Gestion de versions | バージョン管理 | Kontrola wersji | Controle de versão | 版本控制 |
| **version control** | The system that keeps the project's history (Git now; others later). | Versionsverwaltung | control de versiones | gestion de versions | バージョン管理 | kontrola wersji | controle de versão | 版本控制 |
| **None** (no version control) | The choice for a project without version control. It still has a workflow. | Keine | Ninguno | Aucune | なし | Brak | Nenhum | 无 |
| **Git**, **Mercurial**, **Jujutsu** | Version control systems' names. | *keep* | *keep* | *keep* | *keep* | *keep* | *keep* | *keep* |
| **workflow** | How work moves from Todo to Done in a project: its stages and rules. | Workflow | flujo de trabajo | flux de travail | ワークフロー | przepływ pracy | fluxo de trabalho | 工作流程 |
| **workflow options** | The settings under the chosen version control that make the workflow. | Workflow-Optionen | opciones del flujo de trabajo | options du flux de travail | ワークフローのオプション | opcje przepływu pracy | opções do fluxo de trabalho | 工作流程选项 |
| **preset** | One click that fills in every option. | Voreinstellung | ajuste predefinido | préréglage | プリセット | ustawienie wstępne | predefinição | 预设 |
| **Solo** (proposed) | Preset: one person, one agent at a time, no reviewer. | Solo | Individual | Solo | ソロ | Solo | Solo | 单人 |
| **Pair** (proposed) | Preset: a builder and a reviewer. | Paar | Pareja | Binôme | ペア | Para | Dupla | 结对 |
| **Team** (proposed) | Preset: several builders and reviewers, Hive merges, stricter checks. | Team | Equipo | Équipe | チーム | Zespół | Equipe | 团队 |
| **Custom** | The options no longer match a preset. | Benutzerdefiniert | Personalizado | Personnalisé | カスタム | Własne | Personalizado | 自定义 |
| **rule** | Something the workflow checks before a card moves (internally a *gate*). | Regel | regla | règle | ルール | reguła | regra | 规则 |
| **old rules** | A card or lane still under the options it started with, after you changed them. | alte Regeln | reglas anteriores | anciennes règles | 旧ルール | stare reguły | regras antigas | 旧规则 |
| **target branch** | The branch work is merged into (`main` by default). | Zielbranch | rama de destino | branche cible | マージ先ブランチ | gałąź docelowa | branch de destino | 目标分支 |
| **up to date** (with the target) | The change includes everything on the target branch (the *strict* option). | auf dem neuesten Stand | al día | à jour | 最新の状態 | aktualna | atualizado | 与目标同步 |
| **deliverables** (None) | The files a card's work produces, which a None project's revisions are made of. | Ergebnisse | entregables | livrables | 成果物 | rezultaty | entregáveis | 交付物 |
| **repository root** | The top folder of the Git repository a project is in. | Repository-Stammordner | raíz del repositorio | racine du dépôt | リポジトリのルート | katalog główny repozytorium | raiz do repositório | 仓库根目录 |

### 2.2 The board: categories and stages

Categories are fixed and Hive's machinery works on them (decision A, #1112). Stages are the board's columns; each
sits in one category. The English category names are **proposed** (OP-1): today's *Doing* and *Passed* columns become
the *Active* and *Approved* categories; the ids agents use (`doing`, `passed`) don't change.

| English | Meaning | de | es | fr | ja | pl | pt-BR | zh-CN |
|---|---|---|---|---|---|---|---|---|
| **category** | One of the six fixed groups a stage belongs to. | Kategorie | categoría | catégorie | カテゴリ | kategoria | categoria | 类别 |
| **stage** | A column of the board, produced by the workflow options. | Phase | etapa | étape | ステージ | etap | etapa | 阶段 |
| **On Hold** | Category and stage: parked by you. | Geparkt | En espera | Suspendu | 保留 | Wstrzymane | Em espera | 搁置 |
| **Todo** | Category and stage: not started. | Offen | Pendiente | À faire | 未着手 | Do zrobienia | A fazer | 待办 |
| **Active** (proposed; was *Doing*) | Category and default stage: being worked on. | In Arbeit | En curso | En cours | 進行中 | Aktywne (**changed** from *W toku*, #1104's feedback) | Fazendo | 进行中 |
| **Review** | Category and stage: waiting for, or in, review. | Review | Revisión | Relecture | レビュー | Recenzja | Revisão | 评审 |
| **Approved** (proposed; was *Passed*) | Category and stage: its revision passed review (or your approval) and isn't merged yet. | Freigegeben (**changed** from *Geprüft*, which reads as "checked") | Aprobado | Validé | 承認済み | Zatwierdzone | Aprovado | 已批准 (**changed** from 已通过, which reads as a run that passed) |
| **Merging** (proposed) | Stage in Approved: in Hive's merge queue. | Wird gemergt | Fusionando | Fusion en cours | マージ中 | Scalanie | Em merge | 合并中 |
| **Done** | Category and stage: the approved work is in the target (Git), or accepted (None). | Erledigt | Hecho | Terminé | 完了 | Gotowe | Concluído | 已完成 |

### 2.3 Revisions, checks and reviews

| English | Meaning | de | es | fr | ja | pl | pt-BR | zh-CN |
|---|---|---|---|---|---|---|---|---|
| **revision** | An exact state of the work: a commit in Git, a content hash of the deliverables in None. Shown short (`a3f2c1d`). | Revision | versión (not *revisión*, which is Review) | révision | リビジョン | rewizja | versão (not *revisão*, which is Review) | 修订版本 |
| **change** | The whole of a card's work under review: everything from where it started to its revision. | Änderung | cambio | modification | 変更 | zmiana | alteração | 变更 |
| **same change** | A later revision with exactly the same changes (a clean rebase or a squash): an approval carries over. | dieselbe Änderung | el mismo cambio | la même modification | 同じ変更 | ta sama zmiana | a mesma alteração | 相同的变更 |
| **carries over** (an approval) | Still counts for a later revision that is the same change. | bleibt gültig | se mantiene | reste valable | 引き継がれる | pozostaje ważna | continua valendo | 继续有效 |
| **stale** (a pass) | A pass for an older revision that isn't the same change as the card's revision now. | veraltet | caducada | périmée | 失効 | nieaktualna | desatualizada | 已失效 |
| **check** | A command the workflow runs or expects on a revision (typecheck, lint, tests). | Check | comprobación | vérification | チェック | sprawdzenie | verificação | 检查 |
| **checks before review** | The checks a revision must pass to go to Review. | Checks vor dem Review | comprobaciones antes de la revisión | vérifications avant relecture | レビュー前のチェック | sprawdzenia przed recenzją | verificações antes da revisão | 评审前检查 |
| **merge checks** | The checks run on the target plus the change before it is merged. | Merge-Checks | comprobaciones de fusión | vérifications de fusion | マージ前のチェック | sprawdzenia przed scaleniem | verificações de merge | 合并前检查 |
| **verdict** | A reviewer's pass or fail, for one revision. | Urteil | veredicto | verdict | 判定 | werdykt | veredito | 结论 |
| **pass** / **fail** (a verdict) | The two verdicts. | bestanden / nicht bestanden | aprobada / rechazada | validée / refusée | 合格 / 不合格 | zaliczona / niezaliczona | aprovada / reprovada | 通过 / 未通过 |
| **review copy** | A separate checkout of the exact revision a reviewer reviews (internally a *scratch checkout*). | Review-Kopie | copia de revisión | copie de relecture | レビュー用コピー | kopia do recenzji | cópia de revisão | 评审副本 |
| **approval** | Your OK on a card (a release step, screenshots), recorded on the card. | Freigabe | aprobación | approbation | 承認 | zgoda | aprovação | 批准 |
| **For you** | A card waiting on your answer (an approval, a decision, a test, a sign-in). | Für dich | Para ti | Pour toi | 要対応 | Dla Ciebie | Para você | 待你处理 |
| **Decide** / **Test** / **Approve** / **Sign in** | What a For you card asks (OP-11). | Entscheiden / Testen / Freigeben / Anmelden | Decidir / Probar / Aprobar / Iniciar sesión | Décider / Tester / Approuver / Se connecter | 判断 / テスト / 承認 / サインイン | Zdecyduj / Przetestuj / Zatwierdź / Zaloguj się | Decidir / Testar / Aprovar / Entrar | 决定 / 测试 / 批准 / 登录 |

### 2.4 Moves, refusals and overrides

| English | Meaning | de | es | fr | ja | pl | pt-BR | zh-CN |
|---|---|---|---|---|---|---|---|---|
| **refused** (a move) | A move the workflow didn't allow, with the rule and the next step. | abgelehnt | rechazado | refusé | 拒否 | odrzucono | recusado | 已拒绝 |
| **override** (noun), **allow anyway** (verb) | Your (or the Assistant's, within Control) explicit exception to a rule, recorded on the card with the reason. | Ausnahme / trotzdem erlauben | excepción / permitir de todos modos | dérogation / autoriser quand même | 例外 / それでも許可 | wyjątek / zezwól mimo to | exceção / permitir mesmo assim | 例外放行 / 仍然允许 |
| **returned** (to its builder) | A card the merge queue sent back: a conflict or failed merge checks. | zurückgegeben | devuelta | renvoyée | 差し戻し | zwrócona | devolvido | 已退回 |
| **no-code card** | A card with no commits to review or merge (design, investigation, docs on request). | Karte ohne Code | tarjeta sin código | carte sans code | コードなしのカード | karta bez kodu | cartão sem código | 无代码卡片 |
| **before 1.0** (a card) | A card from before the workflow layer: it has no work record, and Hive invents none. | vor 1.0 | anterior a 1.0 | antérieure à 1.0 | 1.0 以前 | sprzed 1.0 | anterior à 1.0 | 1.0 之前 |
| **outside Hive** | Work Hive saw happen elsewhere (a commit or merge in a terminal or another tool). | außerhalb von Hive | fuera de Hive | hors de Hive | Hive の外 | poza Hive | fora do Hive | 在 Hive 之外 |
| **work** (a card's Work section) | What the card's facts say: branch, revisions, verdicts, checks, merge (internally *facts*). | Arbeit | trabajo | travail | 作業 | praca | trabalho | 工作记录 |
| **couldn't within the rules** | An agent's report that it can't meet a rule without breaking one: a question for you, never a failure. | im Rahmen der Regeln nicht möglich | no fue posible dentro de las reglas | impossible dans le respect des règles | ルールの範囲では不可 | niemożliwe w ramach reguł | não foi possível dentro das regras | 无法在规则内完成 |
| **paused** (a lane) | A lane that can't go on yet, with why (waiting for you, a dependency, a reviewer, a slot). | pausiert | en pausa | en pause | 一時停止中 | wstrzymany | pausada | 已暂停 |
| **undo** | Taking back the Assistant's changes, newest first. | Rückgängig machen | Deshacer | Annuler | 元に戻す | Cofnij | Desfazer | 撤销 |
| **changed since** | Undo skipped a change because you or an agent changed the same thing afterwards. | seitdem geändert | cambiado desde entonces | modifié depuis | その後変更済み | zmienione od tego czasu | alterado desde então | 此后已更改 |

### 2.5 Merging, slots and agents

| English | Meaning | de | es | fr | ja | pl | pt-BR | zh-CN |
|---|---|---|---|---|---|---|---|---|
| **merge queue** | Hive's queue of approved cards, merged one at a time per target after a test merge (replaces the *merge slot* in the window from P5). | Merge-Warteschlange | cola de fusión | file de fusion | マージキュー | kolejka scalania (the word *merge slot* had; it moves to the queue) | fila de merge | 合并队列 |
| **test merge** | The target plus the change, built aside and checked before the target moves. | Test-Merge | fusión de prueba | fusion d’essai | テストマージ | scalanie próbne | merge de teste | 试合并 |
| **Pause queue** / **Resume queue** | Your controls on the merge queue. | Warteschlange anhalten / fortsetzen | Pausar la cola / Reanudar la cola | Suspendre la file / Reprendre la file | キューを一時停止 / 再開 | Wstrzymaj kolejkę / Wznów kolejkę | Pausar a fila / Retomar a fila | 暂停队列 / 恢复队列 |
| **slot** | A working folder (a Git worktree) from the project's pool, lent to a card or lane. | Slot | slot (*keep*, masculine: *el slot*) | emplacement | スロット | slot (*slotu, sloty*) | slot (*keep*, masculine) | 槽位 |
| **pool** (of slots, of reviewers) | The project's set of slots, or reviewers shared by lanes. | Pool | grupo | groupe | プール | pula | grupo | 池 |
| **ready** (a slot: warm) | Set up, dependencies installed, waiting for work. | bereit | lista | prêt | 準備済み | gotowy | pronto | 就绪 |
| **project key** | A project's 2–4 letters (`HI`, `AM`), used in card keys, branch names and agent names. | Projektschlüssel | clave del proyecto | clé du projet | プロジェクトキー | klucz projektu | chave do projeto | 项目键 |
| **builder** / **reviewer** / **either** (workflow role) | Which side of the workflow an agent takes. | Bearbeiter / Reviewer / beides | autor / revisor / ambos | auteur / relecteur / les deux | ビルダー / レビュアー / どちらも | wykonawca / recenzent / dowolna | executor / revisor / ambos | 构建者 / 评审者 / 均可 |
| **lane** | Hive's record of a card loop (existing term). | Lane | carril | couloir | レーン | tor | raia | 通道 |
| **Start lane…** | Start a card loop from the board or the Progress panel, without the Assistant. | Lane starten… | Iniciar carril… | Démarrer un couloir… | レーンを開始… | Uruchom tor… | Iniciar raia… | 启动通道… |

## 3. Internal terms and their user words

The spec and the code use precise internal terms. The window uses the user word. Agent-facing English (tool
descriptions, refusals, guidance) may use the internal term where agents need it (*revision*, *verdict*, *intent* in
tool names), never *capability* or *sameness*.

| Internal (spec, code) | The user reads | Notes |
|---|---|---|
| gate, guard | rule | "Review needs a new commit (rule: checks before review)". |
| intent (`hive_submit`…) | — | Agents only. The user sees the move it caused, or its refusal. |
| fact, fact log | Work (the card's section), history | Facts show as the card's Work section and lines in its history. |
| capability | — | Never shown. A missing one shows as an option that isn't available, with why. |
| sameness, patch-id | same change | |
| scratch checkout | review copy | |
| integration, integrate | merge (Git); accept (None) | Each platform names its own. |
| ruleset (compiled options) | the options the card started with; old rules | |
| platform, adapter | version control | |
| observed fact | outside Hive | |
| pre-workflow | before 1.0 | |
| category id `doing`, `passed` | Active, Approved | Ids unchanged in the Agent API. |

## 4. Checking a phase's text

- `npm run i18n:check`, `npm run i18n:coverage` (every locale complete), `npm run i18n:numbers -- --changed`.
- Each new string's terms against sections 2 and 3; the authoring rules in section 1.
- In context: `npm run e2e -- --lang <codes>` and its `report.txt` (#899) for cut-off text, especially German and
  Polish option labels, stage names, segment hovers, the merge queue card and refusal lines.
