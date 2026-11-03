# Combwork 1.0 glossary: the workflow layer's terms in every language

**Status:** written in 1.0 P1 (#1117), 20 Oct 2026, for every 1.0 phase (P2–P8) and the translation review (#1126).
The English labels, category and stage names were agreed by Darren as proposed on 20 Oct (SPEC §16.20, OP-1 and
OP-2, recorded on #1117). A label that changes later is translated again here first, then in `locales/`. Nothing in this file is a message: messages stay in the code (`msg()`), and their translations in
`locales/<code>/<area>.json`.

**How it relates to the other glossaries:**
- [docs/translating/glossary.md](../docs/translating/glossary.md) is Combwork's glossary of every term, with *keep* or
  *translate*; each language's style page (`docs/translating/<code>.md`) records the word it uses. This file adds the
  1.0 workflow terms. Its words agree with the style pages where a term already exists (*card*, *verdict*, *merge*,
  *worktree*, *run*), and a change to an existing word is marked **changed** with its reason.
- When a phase merges, the terms it shipped are copied into `docs/translating/glossary.md` and each style page's Terms
  table, so translators have one place to look after 1.0. Until then, this file wins for 1.0 terms.
- Reviewers of every 1.0 phase check new strings against this file (SPEC §16.16).

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
   written around a placeholder. A refusal has three parts, what was refused, the next step, and where the rule is
   changed, and **each part is a whole sentence of its own message** (`workflow.refused.<rule>.message`, `.next`,
   `.change`), shown as separate lines; never one sentence built from them (SPEC §16.8.3).
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
11. **The runtime rules are AGENTS.md's** (Translations), not repeated here: text is `msg({ id, defaultMessage,
    description })`, kept as data and shown with `tr()` (`tRich()` for markup) when rendered or sent, never at module
    scope; every message has a description for translators (for a 1.0 term, name it: "Stage name (glossary 2.2)");
    after adding messages, `npm run i18n:extract` and commit `locales/en/` and `src/shared/i18n/values/`; each phase
    adds its translations in all 7 locales in the same change, and `npm run i18n:coverage -- --record <code>`.

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
| **Solo** | Preset: one person, one agent at a time, no reviewer. | Solo | Individual | Solo | ソロ | Solo | Solo | 单人 |
| **Pair** | Preset: a builder and a reviewer. | Paar | Pareja | Binôme | ペア | Para | Dupla | 结对 |
| **Team** | Preset: several builders and reviewers, Combwork merges, stricter checks. | Team | Equipo | Équipe | チーム | Zespół | Equipe | 团队 |
| **Custom** | The options no longer match a preset. | Benutzerdefiniert | Personalizado | Personnalisé | カスタム | Własne | Personalizado | 自定义 |
| **rule** | Something the workflow checks before a card moves (internally a *gate*). | Regel | regla | règle | ルール | reguła | regra | 规则 |
| **old rules** | A card or lane still under the options it started with, after you changed them. | alte Regeln | reglas anteriores | anciennes règles | 旧ルール | stare reguły | regras antigas | 旧规则 |
| **target branch** | The branch work is merged into (`main` by default). | Zielbranch | rama de destino | branche cible | マージ先ブランチ | gałąź docelowa | branch de destino | 目标分支 |
| **up to date** (with the target) | The change includes everything on the target branch (the *strict* option). | auf dem neuesten Stand | al día | à jour | 最新の状態 | aktualna | atualizado | 与目标同步 |
| **deliverables** (None) | The files a card's work produces, which a None project's revisions are made of. | Ergebnisse | entregables | livrables | 成果物 | rezultaty | entregáveis | 交付物 |
| **repository root** | The top folder of the Git repository a project is in. | Repository-Stammordner | raíz del repositorio | racine du dépôt | リポジトリのルート | katalog główny repozytorium | raiz do repositório | 仓库根目录 |

### 2.2 The board: categories and stages

Categories are fixed and Combwork's machinery works on them (decision A, #1112). Stages are the board's columns; each
sits in one category. The English category names were agreed on 20 Oct (OP-1): today's *Doing* and *Passed* columns become
the *Active* and *Approved* categories; the ids agents use (`doing`, `passed`) don't change.

| English | Meaning | de | es | fr | ja | pl | pt-BR | zh-CN |
|---|---|---|---|---|---|---|---|---|
| **category** | One of the six fixed groups a stage belongs to. | Kategorie | categoría | catégorie | カテゴリ | kategoria | categoria | 类别 |
| **stage** | A column of the board, produced by the workflow options. | Phase | etapa | étape | ステージ | etap | etapa | 阶段 |
| **On Hold** | Category and stage: parked by you. | Geparkt | En espera | Suspendu | 保留 | Wstrzymane | Em espera | 搁置 |
| **Todo** | Category and stage: not started. | Offen | Pendiente | À faire | 未着手 | Do zrobienia | A fazer | 待办 |
| **Active** (was *Doing*) | Category and default stage: being worked on. | In Arbeit | En curso | En cours | 進行中 | Aktywne (**changed** from *W toku*, #1104's feedback) | Fazendo | 进行中 |
| **Review** | Category and stage: waiting for, or in, review. | Review | Revisión | Relecture | レビュー | Recenzja | Revisão | 评审 |
| **Approved** (was *Passed*) | Category and stage: its revision passed review (or your approval) and isn't merged yet. | Genehmigt (**changed** from *Geprüft*, which reads as "checked"; not *Freigegeben*, which also reads as "released") | Aprobado | Validé | 承認済み | Zatwierdzone | Aprovado | 已批准 (**changed** from 已通过, which reads as a run that passed) |
| **Merging** | Stage in Approved: in Combwork's merge queue. | Wird gemergt | Fusionando | Fusion en cours | マージ中 | Scalanie | Em merge | 合并中 |
| **Done** | Category and stage: the approved work is in the target (Git), or accepted (None). | Erledigt | Hecho | Terminé | 完了 | Gotowe | Concluído | 已完成 |

### 2.3 Revisions, checks and reviews

| English | Meaning | de | es | fr | ja | pl | pt-BR | zh-CN |
|---|---|---|---|---|---|---|---|---|
| **revision** | An exact state of the work: a commit in Git, a content hash of the deliverables in None. Shown short (`a3f2c1d`). | Revision | versión (not *revisión*, which is Review) | révision | リビジョン | rewizja | versão (not *revisão*, which is Review) | 修订版本 |
| **change** | The whole of a card's work under review: everything from where it started to its revision. | Änderung | cambio | modification | 変更 | zmiana | alteração | 变更 |
| **same change** | A later revision with exactly the same changes (a clean rebase or a squash): an approval carries over. | dieselbe Änderung | el mismo cambio | la même modification | 同じ変更 | ta sama zmiana | a mesma alteração | 相同的变更 |
| **carries over** (a pass or an approval) | Still counts for a later revision that is the same change. | bleibt gültig | se mantiene | reste valable | 引き継がれる | pozostaje ważna | continua valendo | 继续有效 |
| **stale** (a pass) | A pass for an older revision that isn't the same change as the card's revision now. | veraltet | caducada | périmée | 失効 | nieaktualna | desatualizada | 已失效 |
| **check** | A command the workflow runs or expects on a revision (typecheck, lint, tests). | Check | comprobación | vérification | チェック | sprawdzenie | verificação | 检查 |
| **checks before review** | The checks a revision must pass to go to Review. | Checks vor dem Review | comprobaciones antes de la revisión | vérifications avant relecture | レビュー前のチェック | sprawdzenia przed recenzją | verificações antes da revisão | 评审前检查 |
| **merge checks** | The checks run on the target plus the change before it is merged. | Merge-Checks | comprobaciones de fusión | vérifications de fusion | マージ前のチェック | sprawdzenia przed scaleniem | verificações de merge | 合并前检查 |
| **verdict** | A reviewer's pass or fail, for one revision. | Urteil | veredicto | verdict | 判定 | werdykt | veredito | 结论 |
| **pass** / **fail** (a verdict) | The two verdicts. A reviewer's verdict is a **pass**, never an "approval", which is only your OK (HB3's round 1 finding 18): the two must read differently. | bestanden / nicht bestanden | superada / no superada | validée / refusée | 合格 / 不合格 | zaliczona / niezaliczona | bem-sucedida / reprovada | 通过 / 未通过 |
| **review copy** | A separate checkout of the exact revision a reviewer reviews (internally a *scratch checkout*). | Review-Kopie | copia de revisión | copie de relecture | レビュー用コピー | kopia do recenzji | cópia de revisão | 评审副本 |
| **approval** | Your OK on a card (a release step, screenshots), recorded on the card. Never a reviewer's pass. | Zustimmung (not *Freigabe*, which reads as "release") | aprobación | approbation | 承認 | zgoda | aprovação | 批准 |
| **For you** | A card waiting on your answer (an approval, a decision, a test, a sign-in). | Für dich | Para ti | Pour toi | 要対応 | Dla Ciebie | Para você | 待你处理 |
| **Decide** / **Test** / **Approve** / **Sign in** | What a For you card asks (OP-11). | Entscheiden / Testen / Zustimmen / Anmelden | Decidir / Probar / Aprobar / Iniciar sesión | Décider / Tester / Approuver / Se connecter | 判断 / テスト / 承認 / サインイン | Zdecyduj / Przetestuj / Zatwierdź / Zaloguj się | Decidir / Testar / Aprovar / Entrar | 决定 / 测试 / 批准 / 登录 |

### 2.4 Moves, refusals and overrides

| English | Meaning | de | es | fr | ja | pl | pt-BR | zh-CN |
|---|---|---|---|---|---|---|---|---|
| **refused** (a move) | A move the workflow didn't allow, with the rule and the next step. | abgelehnt | rechazado | refusé | 拒否 | odrzucono | recusado | 已拒绝 |
| **override** (noun), **Move anyway** (the button) | Your (or the Assistant's, within Control) explicit exception to a rule, recorded on the card with the reason. | Ausnahme / Trotzdem verschieben | excepción / Mover de todos modos | dérogation / Déplacer quand même | 例外 / それでも移動 | wyjątek / Przenieś mimo to | exceção / Mover mesmo assim | 例外放行 / 仍然移动 |
| **returned** (to its builder) | A card the merge queue sent back: a conflict or failed merge checks. | zurückgegeben | devuelta | renvoyée | 差し戻し | zwrócona | devolvido | 已退回 |
| **no-code card** | A card with no commits to review or merge (design, investigation, docs on request). | Karte ohne Code | tarjeta sin código | carte sans code | コードなしのカード | karta bez kodu | cartão sem código | 无代码卡片 |
| **before 1.0** (a card) | A card from before the workflow layer: it has no work record, and Combwork invents none. | vor 1.0 | anterior a 1.0 | antérieure à 1.0 | 1.0以前 | sprzed 1.0 | anterior à 1.0 | 1.0 之前 |
| **outside Combwork** | Work Combwork saw happen elsewhere (a commit or merge in a terminal or another tool). | außerhalb von Combwork | fuera de Combwork | hors de Combwork | Combworkの外 | poza Combwork | fora do Combwork | 在 Combwork 之外 |
| **work** (a card's Work section) | What the card's facts say: branch, revisions, verdicts, checks, merge (internally *facts*). | Arbeit | trabajo | travail | 作業 | praca | trabalho | 工作记录 |
| **couldn't within the rules** | An agent's report that it can't meet a rule without breaking one: a question for you, never a failure. | im Rahmen der Regeln nicht möglich | no fue posible dentro de las reglas | impossible dans le respect des règles | ルールの範囲では不可 | niemożliwe w ramach reguł | não foi possível dentro das regras | 无法在规则内完成 |
| **paused** (a lane) | A lane that can't go on yet, with why (waiting for you, a dependency, a reviewer, a slot). | pausiert | en pausa | en pause | 一時停止中 | wstrzymany | pausada | 已暂停 |
| **undo** | Taking back the Assistant's changes, newest first. | Rückgängig machen | Deshacer | Annuler | 元に戻す | Cofnij | Desfazer | 撤销 |
| **changed since** | Undo skipped a change because you or an agent changed the same thing afterwards. | seitdem geändert | cambiado desde entonces | modifié depuis | その後変更済み | zmienione od tego czasu | alterado desde então | 此后已更改 |

### 2.5 Merging, slots and agents

| English | Meaning | de | es | fr | ja | pl | pt-BR | zh-CN |
|---|---|---|---|---|---|---|---|---|
| **merge queue** | Combwork's queue of approved cards, merged one at a time per target after a test merge. Where Combwork merges, it replaces the *merge slot*; the merge slot stays where agents merge (one agent merge at a time into a branch, SPEC §6.2), and keeps a word of its own (pl *blokada scalania*). | Merge-Warteschlange | cola de fusión | file de fusion | マージキュー | kolejka scalania (the word *merge slot* had; it moves to the queue) | fila de merge | 合并队列 |
| **test merge** | The target plus the change, built aside and checked before the target moves. | Test-Merge | fusión de prueba | fusion d’essai | テストマージ | scalanie próbne | merge de teste | 试合并 |
| **Pause queue** / **Resume queue** | Your controls on the merge queue. | Warteschlange anhalten / fortsetzen | Pausar la cola / Reanudar la cola | Suspendre la file / Reprendre la file | キューを一時停止 / 再開 | Wstrzymaj kolejkę / Wznów kolejkę | Pausar a fila / Retomar a fila | 暂停队列 / 恢复队列 |
| **slot** | A working folder (a Git worktree) from the project's pool, lent to a card or lane. | Slot | slot (*keep*, masculine: *el slot*) | emplacement | スロット | slot (*slotu, sloty*) | slot (*keep*, masculine) | 槽位 |
| **pool** (of slots, of reviewers) | The project's set of slots, or reviewers shared by lanes. | Pool | grupo | groupe | プール | pula | grupo | 池 |
| **ready** (a slot: warm) | Set up, dependencies installed, waiting for work. | bereit | lista | prêt | 準備済み | gotowy | pronto | 就绪 |
| **project key** | A project's 2–4 letters (`HI`, `AM`), used in card keys, branch names and agent names. | Projektschlüssel | clave del proyecto | clé du projet | プロジェクトキー | klucz projektu | chave do projeto | 项目键 |
| **builder** / **reviewer** / **either** (workflow role) | Which side of the workflow an agent takes. | Bearbeiter / Reviewer / beides | autor / revisor / ambos | auteur / relecteur / les deux | ビルダー / レビュアー / どちらも | wykonawca / recenzent / dowolna | executor / revisor / ambos | 构建者 / 评审者 / 均可 |
| **generalist** (workflow role, HI-686) | Takes no side: does what the user asks in its pane, never a lane's builder or reviewer. | Generalist | generalista | généraliste | ゼネラリスト | generalista | generalista | 通才 |
| **lane** | Combwork's record of a card loop (existing term). | Lane | carril | couloir | レーン | tor | raia | 通道 |
| **Start lane…** | Start a card loop from the board or the Progress panel, without the Assistant. | Lane starten… | Iniciar carril… | Démarrer un couloir… | レーンを開始… | Uruchom tor… | Iniciar raia… | 启动通道… |

### 2.6 The Version Control tab's options and values

The labels of SPEC §16.6.1 (None, N1–N7) and §16.6.2 (Git, G1–G17), worded as outcomes [#1117, Darren 19 Oct], with
their values. **The English was agreed on 20 Oct (OP-2):** each phase copies its rows into the messages it adds; the
translations below are AI drafts made from that English, which the phases use and the translation review (#1126)
checks in context. N7 (File locks) and the Card loops settings keep their existing messages.
`{target}` is the target branch's name (`main`), a placeholder kept as written. The form of address is each style
page's (*du*, *tú*, *tu*, *ty*, *você*, 你; Japanese leaves the reader out and says 自分 for "you" as a choice).

| Id | English (agreed) | de | es | fr | ja | pl | pt-BR | zh-CN |
|---|---|---|---|---|---|---|---|---|
| N1 | Who checks the work before it's done | Wer die Arbeit prüft, bevor sie erledigt ist | Quién revisa el trabajo antes de terminarlo | Qui vérifie le travail avant qu’il soit terminé | 完了前に作業を確認する人 | Kto sprawdza pracę, zanim będzie gotowa | Quem verifica o trabalho antes de concluí-lo | 完成前由谁检查工作 |
| N1 values | No one · A reviewer agent · You · A reviewer agent, then you | Niemand · Ein Reviewer-Agent · Du · Ein Reviewer-Agent, dann du | Nadie · Un agente revisor · Tú · Un agente revisor y después tú | Personne · Un agent relecteur · Toi · Un agent relecteur, puis toi | なし · レビュアーエージェント · 自分 · レビュアーエージェント、その後に自分 | Nikt · Agent recenzent · Ty · Agent recenzent, potem Ty | Ninguém · Um agente revisor · Você · Um agente revisor e depois você | 无人 · 评审者智能体 · 你 · 评审者智能体，然后是你 |
| N2, G2 | Nobody reviews their own work | Niemand reviewt die eigene Arbeit | Nadie revisa su propio trabajo | Personne ne relit son propre travail | 作業した本人はレビューしない | Nikt nie recenzuje własnej pracy | Ninguém revisa o próprio trabalho | 任何人都不评审自己的工作 |
| N3, G3 | Checks pass before review | Checks bestehen vor dem Review | Las comprobaciones pasan antes de la revisión | Les vérifications passent avant la relecture | レビュー前にチェックに合格する | Sprawdzenia przechodzą przed recenzją | As verificações passam antes da revisão | 评审前检查通过 |
| N4 | What the work is | Was die Arbeit umfasst | Qué es el trabajo | Ce qui constitue le travail | 作業の対象 | Co jest wynikiem pracy | O que é o trabalho | 工作包含哪些内容 |
| N5 | Stage names | Namen der Phasen | Nombres de las etapas | Noms des étapes | ステージ名 | Nazwy etapów | Nomes das etapas | 阶段名称 |
| N6 | Cards start only when the cards they wait for are done | Karten starten erst, wenn die Karten, auf die sie warten, erledigt sind | Las tarjetas empiezan solo cuando las tarjetas que esperan están hechas | Une carte ne démarre que lorsque les cartes qu’elle attend sont terminées | 待っているカードが完了してから開始する | Karta startuje dopiero, gdy karty, na które czeka, są gotowe | Os cartões só começam quando os cartões que aguardam estão concluídos | 卡片仅在所等待的卡片完成后开始 |
| G1 | Work is reviewed before it's merged | Arbeit wird vor dem Merge reviewt | El trabajo se revisa antes de fusionarlo | Le travail est relu avant d’être fusionné | マージ前に作業をレビューする | Praca jest recenzowana przed scaleniem | O trabalho é revisado antes do merge | 合并前评审工作 |
| G1 (shared folder) | Work is reviewed before it's done | Arbeit wird reviewt, bevor sie erledigt ist | El trabajo se revisa antes de darlo por hecho | Le travail est relu avant d’être terminé | 完了前に作業をレビューする | Praca jest recenzowana, zanim będzie gotowa | O trabalho é revisado antes de ser concluído | 完成前评审工作 |
| G1 values | No review · A reviewer agent · A reviewer agent, then you · You | Kein Review · Ein Reviewer-Agent · Ein Reviewer-Agent, dann du · Du | Sin revisión · Un agente revisor · Un agente revisor y después tú · Tú | Pas de relecture · Un agent relecteur · Un agent relecteur, puis toi · Toi | レビューなし · レビュアーエージェント · レビュアーエージェント、その後に自分 · 自分 | Bez recenzji · Agent recenzent · Agent recenzent, potem Ty · Ty | Sem revisão · Um agente revisor · Um agente revisor e depois você · Você | 不评审 · 评审者智能体 · 评审者智能体，然后是你 · 你 |
| G1b | Reviewers per card | Reviewer pro Karte | Revisores por tarjeta | Relecteurs par carte | カードごとのレビュアー数 | Recenzenci na kartę | Revisores por cartão | 每张卡片的评审者数量 |
| G4 | A pass survives a clean rebase | Ein bestandenes Review übersteht einen sauberen Rebase | Una revisión superada se mantiene tras un rebase limpio | Une relecture validée reste valable après un rebase propre | クリーンなリベース後も合格を引き継ぐ | Zaliczona recenzja zostaje po czystym rebase | Uma revisão bem-sucedida continua valendo após um rebase limpo | 干净变基后评审通过仍然有效 |
| G4 values | Same change · Exact revision only | Dieselbe Änderung · Nur exakt dieselbe Revision | El mismo cambio · Solo la versión exacta | La même modification · Uniquement la révision exacte | 同じ変更 · 完全に同じリビジョンのみ | Ta sama zmiana · Tylko dokładnie ta rewizja | A mesma alteração · Somente a versão exata | 相同的变更 · 仅限完全相同的修订版本 |
| G5 | Who merges | Wer mergt | Quién fusiona | Qui fusionne | マージする人 | Kto scala | Quem faz o merge | 由谁合并 |
| G5 values | Combwork merges · The agent merges, Combwork checks · Committed is done · Not checked | Combwork mergt · Der Agent mergt, Combwork prüft · Committet ist erledigt · Nicht geprüft | Combwork fusiona · El agente fusiona y Combwork comprueba · Hacer commit es terminar · Sin comprobar | Combwork fusionne · L’agent fusionne, Combwork vérifie · Un commit suffit · Non vérifié | Combworkがマージ · エージェントがマージしCombworkが確認 · コミットで完了 · 確認しない | Combwork scala · Agent scala, Combwork sprawdza · Commit oznacza gotowe · Bez sprawdzania | O Combwork faz o merge · O agente faz o merge e o Combwork verifica · Commit é concluir · Sem verificação | Combwork 合并 · 智能体合并，Combwork 检查 · 提交即完成 · 不检查 |
| G6 | Merge style | Merge-Art | Tipo de fusión | Type de fusion | マージ方法 | Sposób scalania | Tipo de merge | 合并方式 |
| G6 values | Merge commit · Squash | Merge-Commit · Squash | Commit de fusión · Squash | Commit de fusion · Squash | マージコミット · スカッシュ | Commit scalający · Squash | Commit de merge · Squash | 合并提交 · 压缩合并 |
| G7 | Work merges into | Arbeit wird gemergt in | El trabajo se fusiona en | Le travail est fusionné dans | マージ先 | Praca jest scalana do | O trabalho é mesclado em | 工作合并到 |
| G8 | Work is up to date with {target} before it merges | Arbeit ist vor dem Merge auf dem Stand von {target} | El trabajo está al día con {target} antes de fusionarse | Le travail est à jour avec {target} avant d’être fusionné | マージ前に{target}の最新状態を取り込む | Praca jest aktualna względem {target} przed scaleniem | O trabalho está atualizado com {target} antes do merge | 合并前工作与 {target} 保持同步 |
| G9 | Checks pass on the merged result | Checks bestehen auf dem gemergten Ergebnis | Las comprobaciones pasan en el resultado fusionado | Les vérifications passent sur le résultat fusionné | マージ結果でチェックに合格する | Sprawdzenia przechodzą na scalonym wyniku | As verificações passam no resultado mesclado | 合并结果的检查通过 |
| G10 | Your OK before merging | Deine Zustimmung vor dem Merge | Tu aprobación antes de fusionar | Ton accord avant la fusion | マージ前の自分の承認 | Twoja zgoda przed scaleniem | Sua aprovação antes do merge | 合并前需要你批准 |
| G10 values | Never · Cards with these labels · Every card | Nie · Karten mit diesen Labels · Jede Karte | Nunca · Tarjetas con estas etiquetas · Todas las tarjetas | Jamais · Cartes avec ces étiquettes · Toutes les cartes | なし · これらのラベルのカード · すべてのカード | Nigdy · Karty z tymi etykietami · Każda karta | Nunca · Cartões com estes rótulos · Todos os cartões | 从不 · 带有这些标签的卡片 · 每张卡片 |
| G11 | Where cards are built | Wo Karten bearbeitet werden | Dónde se trabaja cada tarjeta | Où les cartes sont réalisées | カードの作業場所 | Gdzie powstają karty | Onde os cartões são feitos | 卡片在哪里完成 |
| G11 values | Each card in its own folder · Everyone in the project folder | Jede Karte in ihrem eigenen Ordner · Alle im Projektordner | Cada tarjeta en su propia carpeta · Todos en la carpeta del proyecto | Chaque carte dans son propre dossier · Tout le monde dans le dossier du projet | カードごとに専用フォルダー · 全員がプロジェクトフォルダー | Każda karta we własnym folderze · Wszyscy w folderze projektu | Cada cartão em sua própria pasta · Todos na pasta do projeto | 每张卡片使用自己的文件夹 · 所有人都在项目文件夹中 |
| G12 | Commits use the project's identity | Commits verwenden die Identität des Projekts | Los commits usan la identidad del proyecto | Les commits utilisent l’identité du projet | コミットにプロジェクトのIDを使う | Commity używają tożsamości projektu | Os commits usam a identidade do projeto | 提交使用项目的身份 |
| G13 | Agents stop what they started before review | Agenten stoppen vor dem Review, was sie gestartet haben | Los agentes detienen lo que iniciaron antes de la revisión | Les agents arrêtent ce qu’ils ont lancé avant la relecture | レビュー前にエージェントが開始したものを停止する | Agenci zatrzymują przed recenzją to, co uruchomili | Os agentes param o que iniciaram antes da revisão | 评审前智能体停止自己启动的任务 |
| G14 | Cards start only when the cards they wait for are merged | Karten starten erst, wenn die Karten, auf die sie warten, gemergt sind | Las tarjetas empiezan solo cuando las tarjetas que esperan están fusionadas | Une carte ne démarre que lorsque les cartes qu’elle attend sont fusionnées | 待っているカードがマージされてから開始する | Karta startuje dopiero, gdy karty, na które czeka, są scalone | Os cartões só começam quando os cartões que aguardam estão mesclados | 卡片仅在所等待的卡片合并后开始 |
| G15 | Slots are brought up to date before each card | Slots werden vor jeder Karte aktualisiert | Los slots se actualizan antes de cada tarjeta | Les emplacements sont mis à jour avant chaque carte | カードごとにスロットを最新にする | Sloty są aktualizowane przed każdą kartą | Os slots são atualizados antes de cada cartão | 每张卡片开始前更新槽位 |
| G15 value | Install when the lock file changed | Installieren, wenn sich die Lock-Datei geändert hat | Instalar cuando cambie el archivo de bloqueo | Installer quand le fichier de verrouillage change | ロックファイルが変わったらインストール | Instaluj, gdy zmieni się plik blokady | Instalar quando o arquivo de lock mudar | 锁文件变化时安装 |
| G16 | Warn when a commit includes another agent's files | Warnen, wenn ein Commit Dateien eines anderen Agenten enthält | Avisar cuando un commit incluye archivos de otro agente | Avertir quand un commit inclut des fichiers d’un autre agent | コミットに他のエージェントのファイルが含まれていたら警告 | Ostrzegaj, gdy commit zawiera pliki innego agenta | Avisar quando um commit inclui arquivos de outro agente | 提交包含其他智能体的文件时发出警告 |
| G17 | Reviewers | Reviewer | Revisores | Relecteurs | レビュアー | Recenzenci | Revisores | 评审者 |
| G17 values | One per lane · A shared pool | Einer pro Lane · Ein gemeinsamer Pool | Uno por carril · Un grupo compartido | Un par couloir · Un groupe partagé | レーンごとに1人 · 共有プール | Jeden na tor · Wspólna pula | Um por raia · Um grupo compartilhado | 每个通道一个 · 共享池 |

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
| observed fact | outside Combwork | |
| pre-workflow | before 1.0 | |
| category id `doing`, `passed` | Active, Approved | Ids unchanged in the Agent API. |

## 4. Checking a phase's text

- `npm run i18n:check`, `npm run i18n:coverage` (every locale complete), `npm run i18n:numbers -- --changed`.
- Each new string's terms against sections 2 and 3; the authoring rules in section 1.
- In context: `npm run e2e -- --lang <codes>` and its `report.txt` (#899) for cut-off text, especially German and
  Polish option labels, stage names, segment hovers, the merge queue card and refusal lines.
