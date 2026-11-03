# Português (Brasil) (`pt-BR`): style for Combwork

**Status:** drafted by AI (Claude, October 2026), not yet reviewed by a native speaker. Its entry in
`src/shared/i18n/languages.ts` says the same (`ai: true` until it is reviewed).

**In the language picker:** Português (Brasil), marked (IA) while drafted by AI, with the note “Traduzido por IA:
melhorias são bem-vindas.”

**Improving it:** every Brazilian Portuguese text is in `locales/pt-BR/<area>.json`, one file per area (settings,
board, tasks…), next to the English it was made from in `locales/en/<area>.json` (generated from the code: don't edit
it). Change a text there, run `npm run i18n:check` (it must pass) and `npm run i18n:coverage`, and open a pull request
on [Suremise/hive-desktop](https://github.com/Suremise/hive-desktop). A screenshot of the screen you changed helps the
review: start Combwork with `--lang=pt-BR` (`npm run dev -- --lang=pt-BR`). To change a term below, change it here first,
in the same pull request, then in every message that uses it. A native speaker's review takes the (IA) mark off.

## Voice

Combwork's English is plain and direct: short sentences, everyday words, *you* for the reader, and it says what happens.
Translate the meaning, not the words, and keep the result as short and plain.

- **Addressing the reader:** *você*, as Brazilian software does, with the matching verb forms in instructions
  („Clique“, „Adicione“, „Abra“). Never *tu* or *o senhor*. Where a sentence reads more naturally without a pronoun,
  drop it: „Remova um primeiro.“
- **Tone:** friendly and factual, like current Brazilian developer tools (VS Code, GitHub). No bureaucratic phrasing
  (*efetuar*, *realizar* where a plain verb works, *o mesmo* as a pronoun). Prefer the active voice.
- **Sentence length:** Portuguese runs about a fifth longer than English. Split a long English sentence where it gets
  a second clause, and prefer the shorter everyday word.

## Buttons, commands, titles

- **Buttons and menu commands:** the infinitive, as Windows and VS Code in Brazilian Portuguese do: „Salvar“,
  „Adicionar agente“, „Mover cartão“, „Reiniciar“. The same form everywhere.
- **Capitalisation:** sentence case in titles, buttons, headings and menus: only the first word and names take a
  capital („Configurações do projeto“, not „Configurações do Projeto“). Don't copy the English Title Case.
- **A trailing `…`** (the command asks something before it acts) stays, without a space: „Remover agente…“.
- **Column headings** (the stages, glossary-1.0 §2.2): Em espera (On Hold), A fazer (Todo), Fazendo (Active, was
  Doing), Revisão (Review), Aprovado (Approved, was Passed), Em merge (Merging, inside Approved), Concluído (Done).
  *Concluído* means merged (or accepted, without version control); *Aprovado* passed its review (or got your OK) and
  waits to be merged. They are short on purpose: the board shows them in capitals in a narrow header.
- **Error titles** („Could not add an agent“): „Não foi possível adicionar um agente“, or a short noun phrase where
  space is tight, „Falha ao adicionar“.
- **Shortcuts** keep the key names Brazilian keyboards print (ABNT2): Ctrl, Shift, Alt, Del, as written.

## Grammar

- **Names have no known gender.** Agents' names (*One*, *Codex*, *Builder*) and people's names don't say whether
  *o* or *a*, *ele* or *ela*, or an adjective's ending fits. Put the noun in front so it carries the gender
  („o agente {agent}“), repeat the name, or restructure so nothing agrees with the name.
  Example: *{agent} was removed. Its sessions stay in the Sessions tab.* → „O agente {agent} foi removido. As sessões
  continuam na aba Sessões.“ The roles (*executor*, *revisor*) are masculine nouns about agents and stay so.
- **Plurals:** Brazilian Portuguese's CLDR categories are *one* (0 and 1), *many* (exact millions, rare) and *other*.
  Give `one` and `other` in every plural (`many` falls back to `other`). Because 0 takes `one` („0 cartão“), add an
  `=0` case with the plural form where the count can be zero: `{n, plural, =0 {# cartões} one {# cartão} other
  {# cartões}}`. Keep `=0` and other exact cases where the English has them.
- **Cases and placeholders:** a placeholder like `{project}` or `{agent}` is a name inserted as it is. Avoid
  contracting a preposition with it (*do {project}* assumes a gender): write „no projeto {project}“, „do agente
  {agent}“, „de {name}“. The one exception is a CLI's name (`{provider}`, `{cli}`): Claude Code, Codex and Copilot
  are all masculine in Portuguese, so „do {provider}“, „o {cli}“ are fine.
- **`select`** keys (`{kind, select, file {…} other {…}}`) are ids: never translate them, only the texts inside.
- **Lists:** Combwork joins lists itself („One, Two e Three“). Never write *e* or *ou* into a message around a list
  placeholder.
- **Fragments inserted into other messages** (descriptions say so: „Could not load {what}“, „Closing loses {what}“)
  carry their article so the host sentence reads whole: „Não foi possível carregar {what}“ with „as sessões“,
  „o histórico“.
- **Times inserted as `{when}`** („há 5 minutos“, „agora mesmo“, „ontem“) read best after a colon or at the end:
  „Medido: {when}“, „salvo {when}“.

## Punctuation and typography

- **Quotation marks:** “…” (U+201C, U+201D), and ‘…’ inside them. They need no escaping in JSON, unlike `"`.
- **Apostrophe:** ’ where needed (rare: *d’água*). Never a straight `'`: in ICU, `'` before `{`, `}` or `#` starts a
  quotation. Where the English quotes a literal brace (`'{'`), keep exactly that.
- **Spaces:** none before `:`, `;`, `?`, `!`.
- **Dashes, colons, ellipsis:** the em dash with spaces (` — `) for a break in a sentence, as Brazilian typography
  does; `…` as one character. After a colon, lower case unless a name or a full new sentence follows.
- **Abbreviations:** „p. ex.“ takes a no-break space (U+00A0) inside; „por exemplo“ is often better.
- **Numbers, dates, money, durations:** formatted by Combwork in Brazilian style (1.234,5; 15/10/2026). Never write them
  into a message: keep the placeholder and its `number` format.

## Terms

The words Brazilian Portuguese uses for Combwork's terms ([glossary.md](glossary.md), and for the 1.0 workflow terms
[glossary-1.0.md](../../locales/glossary-1.0.md)). Use them every time. Where a term
is kept in English, it is as Brazilian developers say it.

| English | Português (Brasil) | Notes |
|---|---|---|
| workspace | espaço de trabalho | As in VS Code. |
| project | projeto | |
| agent | agente (o) | Put the noun before a name (above). |
| provider | provedor | |
| session | sessão | |
| the Assistant | o Assistente | Its only name: the full English name *Hive Assistant* went with the rename (HI-2458). |
| persona | persona | |
| task board / board | quadro de tarefas / quadro | |
| card | cartão (o), cartões | Never *tarefa* for a card; *tarefas* only in *quadro de tarefas* and the *Tasks* tab („Tarefas“). |
| On Hold / Todo / Active / Review / Approved / Merging / Done | Em espera / A fazer / Fazendo / Revisão / Aprovado / Em merge / Concluído | The stages (1.0; *Active* was *Doing*, *Approved* was *Passed*). In running text: „em Revisão“, „mover para Aprovado“; *park* a card: „pôr em espera“. |
| category / stage | categoria / etapa | A stage is a board column; each sits in one of the six categories. |
| decision | decisão | |
| blocked / stalled | bloqueado / travado | |
| builder / reviewer | executor / revisor | Roles of agents in a card loop. |
| card loop / lane / round | ciclo de cartões / raia / rodada | *Raia* as in a kanban swimlane. Never *loop de cartões*. *Start lane…*: „Iniciar raia…“. |
| merge slot | vez de merge | One merge at a time when an agent merges: „a vez de merge“, „liberar a vez“. |
| merge queue / test merge / Pause queue / Resume queue | fila de merge / merge de teste / Pausar a fila / Retomar a fila | Combwork's queue of approved cards (1.0). |
| slot / pool / ready (a slot) | slot (o) / grupo / pronto | A slot is a worktree Combwork lends to a card or lane; *pool* of slots or of reviewers: „o grupo de revisores“. |
| version control / Version Control (the tab) / None | controle de versão / Controle de versão / Nenhum | |
| workflow / workflow options / rule / old rules | fluxo de trabalho / opções do fluxo de trabalho / regra / regras antigas | |
| preset (Solo, Pair, Team, Custom) | predefinição (Solo, Dupla, Equipe, Personalizado) | |
| target branch / up to date / repository root | branch de destino / atualizado / raiz do repositório | |
| revision | versão | Never *revisão*, which is Review. |
| change / same change / carries over / stale | alteração / a mesma alteração / continua valendo / desatualizada | *stale* agrees with *revisão bem-sucedida*. |
| check / checks before review / merge checks | verificação / verificações antes da revisão / verificações de merge | A check *passes* („passou“) or *fails* („falhou“). |
| verdict / pass / fail | veredito / bem-sucedida / reprovada | A reviewer's pass is „revisão bem-sucedida“, „passou na revisão“: never *aprovação* or *aprovado*, which are your OK and the Approved stage. |
| review copy | cópia de revisão | |
| approval / Approve / For you | aprovação / Aprovar / Para você | Your OK only. For you asks: Decidir / Testar / Aprovar / Entrar. |
| refused / override / Move anyway / returned | recusado / exceção / Mover mesmo assim / devolvido | |
| no-code card / before 1.0 / outside Combwork / Work (a card's section) | cartão sem código / anterior à 1.0 / fora do Combwork / Trabalho | |
| deliverables | entregáveis | |
| inbox / message / wake | caixa de entrada / mensagem / acordar | „O Combwork acorda o agente.“ |
| handover / shared notes | passagem de trabalho (passagem) / notas compartilhadas | |
| skill / template | skill / modelo | The skill's own name stays (`work-on-card`). |
| worktree / branch / commit / merge | worktree / branch / commit / merge | As Brazilian git users say them, all masculine („o branch“, „o worktree“, „o remote“; „a tag“). Verbs: „fazer commit“, „fazer merge“, „fazer pull/push/fetch“, „mesclado“ for merged. *detached HEAD*: „HEAD desanexado“. |
| Progress panel / run | painel Progresso / execução | „Progresso“ as the panel's title. |
| Workspace Overview | Visão geral do espaço de trabalho | *Visão geral* where it's clear and space is short. |
| permission mode (Manual, Accept edits, Plan, Auto, Don't ask) | modo de permissão (Manual, Aceitar edições, Planejar, Auto, Não perguntar) | The CLIs' own screens stay in English. |
| effort / usage / cost / tokens | esforço / uso / custo / tokens | *API-equivalent cost*: „custo a preços de API“. |
| banner / notification / tip | banner / notificação / dica | |
| sign in | entrar, conectado, sair | „Fazer login“ in running text. |
| Agent API | Agent API | A name, kept: „referência da Agent API“. |
| conversation / transcript | conversa / transcrição | |
| compact, compaction | compactar, compactação | The button: „Compactar“. |
| an agent's turn | turno | Not *rodada*, which is a card loop's round. |
| Inherit (a setting's choice) | Herdado | „Herdado (Configurações: Planejar)“. |
| Working on (a project) | Ativo | Not *Fazendo*, which is the Active column. |
| idle | ocioso | „Marcar como ocioso“. |
| memory (a CLI's memory files) | memória | |
| background tasks | tarefas em segundo plano | They aren't cards. |
| backup | backup | |
| staged | preparado | As VS Code says („alterações preparadas“). |
| watch (a card watch) | observação, observação de cartão | |
| Provider Setup | Configuração de provedores | |
| the shipped modes (Coordinator, Planner, QA triager, Release manager) | Coordenador, Planejador, Triagem de QA, Gerente de release | As `assistant.modes.shipped.*` shows them. |
| view (the Skills view, the MCP view) | visualização | „na visualização Skills“; the View menu is „Exibir“. |
| Start… (a card) | Iniciar… | *Start New* is „Começar de novo“. |
| setup command (a worktree's) | comando de preparação | Not *configuração*, which is Settings. |
| exclude from git (.git/info/exclude) | ignorar no git | Not *excluir*, which is Delete. |
| role (an agent's) | função | An agent's own role, in its words. |
| role in the workflow (builder, reviewer, either, generalist) | papel | „Papel no fluxo de trabalho” (Darren, HI-1928). |
| hand over (to) | passar o trabalho (para) | The command *Hand Over to…*: „Passar para…“. |
| Reset / Reset to defaults | Redefinir / Restaurar padrões | |
| chime | som | |
| label (on a card) | rótulo | |

Common UI words, for consistency:

| English | Português (Brasil) |
|---|---|
| Settings | Configurações |
| folder / file | pasta / arquivo |
| tab | aba |
| pane / panel | painel |
| sidebar / status bar / activity bar | barra lateral / barra de status / barra de atividades |
| command palette | paleta de comandos |
| shortcut | atalho |
| Cancel / Close / OK | Cancelar / Fechar / OK |
| Remove / Delete | Remover / Excluir |
| Stop (an agent, a run) / Quit (Combwork) | Parar / Sair |
| Resume / Restart | Retomar / Reiniciar |
| Recycle Bin | Lixeira |
| Diagnostics | Diagnóstico |
| Docs | Documentação |

## Examples

| English | Português (Brasil) |
|---|---|
| Remove agent… | Remover agente… |
| {name} has {n, plural, one {# open card} other {# open cards}} | {name} tem {n, plural, =0 {# cartões abertos} one {# cartão aberto} other {# cartões abertos}} |
| {agent} was removed. Its sessions stay in the Sessions tab. | O agente {agent} foi removido. As sessões continuam na aba Sessões. |
| Combwork was started in {language} (--lang): this setting applies from its next start. | O Combwork foi iniciado com --lang {language}: esta configuração vale a partir da próxima inicialização. |

## Checking

- `npm run i18n:check` passes, and `npm run i18n:coverage` shows what is still missing or outdated.
- Look at the screenshots: `npm run e2e -- --lang pt-BR --build`, in both themes, for text that is cut off or wraps
  badly. Buttons, the board's column headings, the project header and the agent strip are where longer text shows
  first. Shortened after the first screenshots (October 2026): the project header's single-agent buttons
  („Retomar“, „Parar“), the pane's ended bar („Encerrada.“), the board card's agent state („Parado“), the Sessions
  search box, the table filter's „Tudo“, the merge-slot lines in the Progress panel, the MCP server row („Em nenhum
  projeto“) and the update status chip. „A fazer“ takes a no-break space so the board's heading doesn't wrap. Where no
  shorter wording fits, the layout is a follow-up card, not a wording change.
- A reviewer of this language should look first at the board and the Session tab (the most-seen screens), and at
  the terms table above: a term changed means every message that uses it changes.
