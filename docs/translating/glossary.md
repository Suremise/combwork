# Glossary for translators

Combwork's terms, what each means, and whether to keep it in English or translate it. Use it with your language's style
page (`docs/translating/<code>.md`). That page records the word your language uses for each **translate** term, so that
every message uses the same one. A new language fills in that table from
[style-template.md](style-template.md).

**Keep** means: leave it in English exactly as written, in every language. **Translate** means: choose one word or
phrase for it once, in your style page, and use it everywhere.

## Names: always keep

| Term | Why |
|---|---|
| Combwork | The app's name (since HI-2458). |
| Claude Code, Codex, GitHub Copilot (Copilot CLI), Claude, Opus, Sonnet, Haiku, GPT | Products and models. |
| Anthropic, OpenAI, GitHub, Microsoft | Companies. |
| Windows, PowerShell, Git, Node.js, npm, Electron, Chromium, NSIS | Software names. |
| MCP, MCP server | A standard's name (Model Context Protocol). You may translate "server" if your language always does (*serwer MCP*). |
| Agent API | The name of Combwork's local HTTP API. |
| ICU, JSON, Markdown, CSV, PDF, URL, CLI | Formats and abbreviations. |
| File names, folders, paths and commands | `AGENTS.md`, `.combwork/shared`, `npm run e2e`, `--lang`, `Ctrl+Shift+J`. |
| Tool names | `cw_inbox`, `cw_update_task`: agents call them by these names. |
| Skill names | `work-on-card`, `card-loop`, `merge-ready`: they are identifiers. |
| `#12`, `m178` | Card numbers and message ids, as written. |

## Combwork's own terms: translate, consistently

Combwork's own words are translated, the same way every time. Where your language commonly uses the English word in
software (many developers say "worktree" or "commit" untranslated), keeping it is a valid choice. Make that choice in
your style page, and keep to it.

| Term | What it is in Combwork | Notes |
|---|---|---|
| **workspace** | A folder of projects that Combwork opens as one; each window shows one workspace. | |
| **project** | A folder in the workspace, usually a git repository. | |
| **agent** | A coding agent (Claude Code, Codex or Copilot) that Combwork runs in a project, with a name the user gives it. | The most frequent term. Agents' names have no known gender: don't make a verb agree with one. |
| **provider** | Which CLI an agent runs: Claude Code, Codex or Copilot. | |
| **session** | One conversation of an agent, from its start to its end; it can be resumed later. | |
| **the Assistant** | The Assistant, named by its role in running text (*ask the Assistant*). | Translate *Assistant*, and capitalise it if your language allows, so it reads as a name. It is the Assistant's only name: its full English name went with the rename (HI-2458). |
| **persona** | A character the Assistant can take on (its instructions and tone). | |
| **task board**, **board** | The workspace's list of work, as cards in columns. | |
| **card** | One piece of work on the board (#12): a title, a description, comments, decisions. | As in a kanban card, not a playing card or a bank card. |
| **On Hold, Todo, Doing, Review, Passed, Done** | The board's columns. **Done** means merged; **Passed** means it passed its review but isn't merged yet. | Translate the column titles, short (they are headings). Agents and tools use the English ids (`todo`, `doing`…), which aren't in `locales/`. |
| **decision** | Something the user decided about a card, pinned above its comments. | |
| **blocked** | A card that can't go on until something happens (often the user's answer). | |
| **stalled** | A card that looks stuck: in Doing while its agent has stopped or been removed, or waiting in Review for a long time. | |
| **builder**, **reviewer** | The two roles in a card loop: one does the work, the other reviews it. | |
| **card loop** | Two agents taking a list of cards in turn, one building and one reviewing. | |
| **lane** | Combwork's record of one card loop, shown in the Progress panel. | |
| **round** | One build and its review, in a card loop. | |
| **merge slot** | Combwork's turn-taking for merges into a branch: one at a time. | |
| **inbox** | Where Combwork keeps what an agent has to read (messages, tasks, card events). | |
| **message** | Something left for an agent in its inbox. | |
| **wake** | Combwork typing a short line into an idle agent so it reads its inbox. | |
| **handover** | A note a session writes so a later one can carry on. | |
| **shared notes** | The workspace's Markdown notes, which every agent can read. | |
| **skill** | A packaged set of instructions an agent can use (a folder with a `SKILL.md`). | The skill's own name is kept (above). |
| **template** | A saved set of agents to load into a project. | |
| **worktree** | A second working folder of a git repository, on its own branch, so agents don't edit the same files. | A git term. Many languages keep it in English. |
| **branch**, **commit**, **merge**, **remote** | Git's own terms. | Use the words your language's git users and git tools use. |
| **Progress panel** | The panel listing tests and builds that agents and scripts run, with how far along they are. | |
| **run** | One command shown in the Progress panel: running, waiting, passed, failed, stopped. | |
| **Workspace Overview** | The page summarising every project, agent and card. | |
| **permission mode** | How much an agent may do without asking (Manual, Accept edits, Plan, Auto, Don't ask). | Translate the modes' names in Combwork. The CLIs' own screens stay in English. |
| **effort** | How much thinking a model does (low, medium, high…). | |
| **usage**, **cost**, **tokens** | What a session used. *API-equivalent cost* is what it would cost at API prices. | *Token* is usually kept or transliterated. |
| **banner** | A notice shown inside Combwork's window. | Not a Windows notification, which is *notification*. |
| **tip** | A short hint Combwork shows when it starts. | |
| **sign in**, **signed in** | Logging in to a CLI or service. | Use your language's usual term for logging in. |

## Words to avoid

- **"Task"** for a card in running text: Combwork's word is *card*. Only *Task board* and the *Tasks* tab use *task*.
- **"User"** when speaking to the reader: say *you*.
- **Gendered words with a name**: see *agent* above, and the style page.

## Changing the glossary

The glossary is shared by every language. To add a term or change a "keep", open a pull request that changes this file
and says why. Each language's choices go in its own style page.
