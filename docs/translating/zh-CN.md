# 简体中文 (`zh-CN`): style for Hive

**Status:** drafted by AI (Claude, October 2026), not yet reviewed by a native speaker. Its entry in
`src/shared/i18n/languages.ts` says the same (`ai: true` until it is reviewed).

**In the language picker:** 简体中文, marked (AI) while drafted by AI, with the note “由 AI 翻译，欢迎改进。”

**Improving it:** every Chinese message is in `locales/zh-CN/<area>.json`, one file per part of Hive. If a word is
wrong, stiff or unclear, change it there and open a pull request on GitHub (`Suremise/hive-desktop`):
`CONTRIBUTING.md` says how, and a small fix can be made in GitHub's web editor. If you change a term from the table
below, change it in every message and on this page in the same pull request, so Hive keeps one voice. A native
speaker's review takes the (AI) mark off.

## Voice

Hive's English is plain and direct: short sentences, everyday words, *you* for the reader, and it says what happens.
Translate the meaning, not the words, and keep the result as short and plain.

- **Addressing the reader:** 你, not 您, as most current software does. Leave it out where the sentence is clear
  without it (“已删除智能体 {agent}。”, not “你已删除智能体 {agent}。”). Where the English says *your*, usually say
  nothing.
- **Tone:** friendly and direct. Prefer an active verb to a nominal chain (“无法保存”, not “保存操作执行失败”). Avoid
  translationese such as 被 passives where an active sentence works, and long 的…的…的 chains.
- **Sentence length:** split a long English sentence into two. Chinese is shorter on screen than English, so keep
  labels short rather than padding them.

## Buttons, commands, titles

- **Buttons and menu commands:** a short verb phrase: “保存”, “删除”, “取消”, “添加智能体…”, “打开设置”. The same form
  everywhere, including the command palette.
- **Headings, labels, column names, status words:** nouns or short phrases: “设置”, “工作中”, “等待中”.
- **A trailing `…`** stays, with no space before it: “删除智能体…”. Don't turn it into ……
- **Column headings (stages):** 搁置, 待办, 进行中, 评审, 已批准, 合并中, 已完成.

## Grammar

- **Names have no gender** in Chinese, so agreement isn't a problem. A placeholder is a name inserted as it is.
- **Plurals:** Chinese has only the CLDR category *other*. Every plural message gives just `other`, plus any `=0` or
  `=1` case the English has: `{n, plural, other {# 张卡片}}`. Never add `one`. Where the English `one` holds a different
  sentence or a placeholder the `other` lacks (`one {Remove {agent}…}`), use `=1` for it.
- **Measure words:** cards 张 (“# 张卡片”), agents, projects, files, worktrees 个, messages and comments 条, items
  项, times 次, lines 行. Use the measure word wherever a noun is counted.
- **Placeholders:** a placeholder that holds a sentence or a status is placed after a colon (：), so it can stand on its
  own.
- **Lists:** Hive joins lists itself (“One、Two 和 Three”). Never write 和 or 或 into a message around a list
  placeholder.

## Punctuation and typography

- **Punctuation:** full-width ，。：；？！（） in Chinese text. A message that is a single label or button has no 。.
  Half-width : and () only around code, numbers or English alone (“Ctrl+K”, “(--lang)”).
- **Quotation marks:** “…”, and ‘…’ inside them. Never " in the text. A command, setting or tab named in a sentence
  goes in “” too: “设置”→“高级”，“添加智能体…”. Never put “” around a list placeholder (it would quote the whole list,
  “A和B”): where a message offers `{quotedNames}`, write that, which quotes each name (“A”和“B”).
- **Spaces:** one half-width space between Chinese and Latin letters, numbers or a placeholder (“Claude Code 会话”,
  “5 分钟”, “智能体 {agent}”), and none next to full-width punctuation (“（{n}）”, “：{error}”). A placeholder that
  holds Chinese text (a translated phrase, a quoted mode name) takes no space (“无法加载{what}”); one that holds Latin
  text, a code or a number takes one (“以 {language} 启动”, where {language} is a code such as pl).
  A percentage, a degree or a unit stays attached to its number (“42%”).
- **Apostrophe:** Chinese has none. Before `{`, `}` or `#`, a straight apostrophe starts an ICU quotation: keep the
  English's `'{'` exactly as it is.
- **Numbers, dates, money, durations:** formatted by Hive in the Chinese way. Never write them into a message.

## Terms

The words Chinese uses for Hive's terms ([glossary.md](glossary.md)). Use them every time.

| English | 简体中文 | Notes |
|---|---|---|
| workspace | 工作区 | |
| project | 项目 | |
| agent | 智能体 | |
| provider | 提供方 | Claude Code, Codex or Copilot. |
| session | 会话 | |
| turn (an agent's: a prompt and its work until it stops) | 回合 | “上一回合”, “回合结束后切换”. Never 本轮 / 一轮 / 轮次, which are a card loop's round. *In turn* / *take turns* (one after another) is 轮流 / 依次. |
| the Assistant | 助手 | The full name *Hive Assistant* stays in English. |
| persona / mode (the Assistant's) | 人设 / 模式 | |
| role (an agent's) | 角色 | |
| task board / board | 任务看板 / 看板 | The *Tasks* tab is “任务”. |
| card | 卡片 | Never “任务” for a card in running text. |
| On Hold / Todo / Active / Review / Approved / Merging / Done | 搁置 / 待办 / 进行中 / 评审 / 已批准 / 合并中 / 已完成 | The board's stages (阶段) and categories (类别). *Active* was *Doing*; *Approved* (was *Passed*) is 已批准, not 已通过, which reads as a run that passed. *已完成* means merged (or accepted); *已批准* means its work passed review (or your OK) but isn't merged. Agents' tool text keeps the English ids (`doing`, `passed`). |
| decision | 决定 | |
| blocked / stalled | 受阻 / 停滞 | |
| builder / reviewer | 构建者 / 评审者 | |
| review (the act) | 评审 | |
| card loop / lane / round | 卡片循环 / 通道 / 轮次 | |
| merge slot | 合并槽位 | |
| merge queue / test merge / Pause queue / Resume queue / Remove from queue | 合并队列 / 试合并 / 暂停队列 / 恢复队列 / 移出队列 | |
| slot / pool / ready (a slot) | 槽位 / 池 / 就绪 | A slot is a working folder Hive lends to a card or lane. |
| review copy / check copy | 评审副本 / 检查副本 | |
| Version Control (the tab) / version control / None | 版本控制 / 版本控制 / 无 | Cite the tab as “版本控制”, an option as “版本控制”→“由谁合并”. |
| workflow / workflow options / preset / rule / old rules | 工作流程 / 工作流程选项 / 预设 / 规则 / 旧规则 | Presets: 单人、结对、团队、自定义. |
| stage / category | 阶段 / 类别 | |
| target branch / up to date (with the target) | 目标分支 / 与目标分支保持同步 | |
| revision / change / same change | 修订版本 / 变更 / 相同的变更 | Never just 修订. |
| check / checks before review / merge checks | 检查 / 评审前检查 / 合并前检查 | A check that passed: 通过; a run: 成功. |
| pass / fail (a verdict) | 通过 / 未通过 | A reviewer's pass is 通过 (通过结论), never 批准. |
| approval / Approve | 批准 | Only your OK, never a reviewer's pass. |
| carries over / stale (a pass) | 继续有效 / 已失效 | |
| For you | 待你处理 | Its kinds: 决定、测试、批准、登录. |
| refused / returned (by the merge queue) | 已拒绝 / 已退回 | |
| override / Move anyway | 例外放行 / 仍然移动 | |
| no-code card / before 1.0 / outside Hive | 无代码卡片 / 1.0 之前 / 在 Hive 之外 | |
| Work (a card's section) | 工作记录 | |
| inbox / message / wake | 收件箱 / 消息 / 唤醒 | |
| handover / shared notes | 交接（交接说明） / 共享笔记 | |
| skill / template | 技能 / 模板 | A skill's own name (`work-on-card`) stays as it is. |
| worktree / branch / commit / merge | 工作树 / 分支 / 提交 / 合并 | *remote*: 远程仓库. |
| uncommitted / staged | 未提交 / 已暂存 | |
| fetch / pull / push | 获取 / 拉取 / 推送 | |
| Progress panel / run | 进度面板 / 运行 | |
| run states | 运行中、失败、成功、已停止、等待中 | A run that passed is 成功, not 已通过. |
| Workspace Overview | 工作区概览 | |
| permission mode (Manual, Accept edits, Plan, Auto, Don't ask) | 权限模式（手动、接受编辑、计划、自动、不再询问） | The CLIs' own screens stay in English. |
| effort / usage / cost / tokens | 推理强度 / 用量 / 费用 / Token | Effort levels: 低、中、高、超高、最高… *API-equivalent cost*: “按 API 价格计的费用”. |
| banner / notification / tip | 横幅 / 通知 / 提示 | A *notification* is Windows'; a *banner* is inside Hive's window. |
| sign in / sign out | 登录 / 退出登录 | |
| tab / settings | 标签页 / 设置 | |
| Session tab / Sessions tab | “会话”标签页 / “会话历史”标签页 | Chinese has no plural, so the Sessions tab (past conversations) is 会话历史. |
| Agent Settings / Project Settings / Provider Setup | 智能体设置 / 项目设置 / 配置提供方 | Provider Setup installs and signs in the CLIs. |
| Settings sections | 常规、外观、通知、会话、智能体与工作树、提供方、助手、看板、工作区、键盘快捷键、更新、高级、Agent API | Cited as “设置”→“常规”→“…”. |
| menus | 文件、编辑、视图、项目、会话、帮助 | |
| conversation / transcript | 对话 / 会话记录 | |
| status line (a CLI's) / status bar (Hive's) | 状态行 / 状态栏 | |
| compact / compaction | 压缩 | |
| prompt / prompt cache | 提示词 / 提示词缓存 | |
| archive / unarchive | 归档 / 取消归档 | |
| Start New / Archive and Start New | 新建会话 / 归档并新建会话 | |
| Hand Over to… | 交接给… | |
| Finished (an agent's status) | 已结束 | Never 已完成, which is the Done column. |
| Working on (the sidebar's marking) | 正在处理 | 工作中 is the Working status. |
| watch (a card watch) | 监视 | |
| verdict | 结论 | |
| redacted / masked | 已脱敏 / 已遮盖 | Never 已编辑, which means edited. |
| masking / masking data (API keys', Settings → Accounts & Connections) | 遮盖 / 遮盖数据 | “重置遮盖数据…”. Never 屏蔽, which reads as blocking. |
| account / connection / Set Up (a connection's) | 账号 / 连接 / 初始设置 | Its states: 已完成初始设置 / 需要初始设置. 设置 alone is Settings. Provider Setup is 配置提供方. |
| Storage (a project's) / Clean Up… | 存储 / 清理… | |
| Repair (a moved workspace) | 修复 | |
| Recycle Bin / File Explorer | 回收站 / 文件资源管理器 | |
| Copy Diagnostics / Developer Console | 复制诊断信息 / 开发者控制台 | |
| Mark idle | 标记为空闲 | |
| layouts | 逐个显示、两列、三列、2×2 网格、3×2 网格 | |
| the Assistant's modes | 协调员、规划师、QA 分诊员、发布经理 | |
| hook / timeout | 钩子 / 超时 | |
| coding agent | 编程智能体 | Never 编码智能体. |
| a relative time or duration in a placeholder | “测量时间：{when}”, “运行 {took}后失败” | {when} and {took} are Chinese (“刚刚”, “0 秒”): put them after a colon, or with no space before the Chinese that follows. |
| Open Recent (File menu) | 打开最近的工作区 | |
| Remove Project… / Remove agent… | 移除项目… / 删除智能体… | A project is only removed from the workspace (移除); an agent is deleted (删除). |
| Active / Inactive (a project) | 活跃 / 非活跃 | |
| antivirus | 防病毒软件 | “防病毒扫描”. |
| plan (a subscription) | 套餐 | *Plan limits*: 套餐限额 (5 小时限额, 每周限额). |
| setup command (a worktree's) | 初始化命令 | 设置 is Settings. |
| New Conversation | 新建对话 | |
| token (an auth or viewer token) | 令牌 | Usage tokens stay *Token*. |

## Examples

| English | 简体中文 |
|---|---|
| Remove agent… | 删除智能体… |
| {name} has {n, plural, one {# open card} other {# open cards}} | {name}：{n, plural, other {# 张未完成的卡片}} |
| {agent} was removed. Its sessions stay in the Sessions tab. | 已删除智能体 {agent}。它的会话保留在“会话历史”标签页中。 |
| Hive was started in {language} (--lang): this setting applies from its next start. | Hive 以 {language} 启动（--lang）：此设置将在下次启动时生效。 |
| Could not load {what}: {error} | 无法加载{what}：{error} |

## Checking

- `npm run i18n:check` passes, and `npm run i18n:coverage` shows what is still missing or outdated.
- Look at the screenshots: `npm run e2e -- --lang zh-CN --build`, in both themes, for text that is cut off, a font
  that doesn't fall back to a Chinese one (Japanese glyph forms), or line breaks in odd places.
- A reviewer should look first at the measure words, that no plural has a `one` case, and the spaces between Chinese
  and Latin text.
