import { FIXTURES as FIX, withValues, outagePatternId, overrideId, rightClickToCliId, drawnWaitId, outageCheckUrlId, type AdvancedSource, type AdvancedSample } from '../../advancedDef'
import { msg } from '../../i18n/msg'

/** A recording of it taking Combwork's hooks (configured with the default timeouts) and sending them. */
const HOOKS_TAKEN: AdvancedSample = { from: `${FIX}/turns-codex-0.162.1.json`, version: '0.162.1', text: '"hook_event_name": "PreToolUse"', shows: "Codex running Combwork's hooks (trusted, so their timeouts match the hashes Combwork gave it), PreToolUse too" } // i18n-ignore: a CLI's recorded text (#367)

/** A Codex token_count's rate-limit snapshot, its fields as recorded (Codex 0.159.0, tests/fixtures/codex-0.159.jsonl). */
const RATE_LIMIT_FIELDS = ['limit_id', 'limit_name', 'primary', 'secondary', 'credits', 'individual_limit', 'spend_control_reached', 'plan_type', 'rate_limit_reached_type']

/** Codex's advanced values (#367), in the order Settings lists them: advanced.ts gathers them through the registry (HI-3201). */
// agent-text: ADVANCED (Settings → Advanced's titles and descriptions, which agents read too: the settings tools, HI-2441)
export const ADVANCED: readonly AdvancedSource[] = [
  // Codex
  {
    id: 'codex.trust.perLaunch',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.trust.perLaunch.title', defaultMessage: "Trust Combwork's folders on each launch", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.trust.perLaunch.desc', defaultMessage: "Each Codex agent is started with its own folder (its project, slot or review copy) trusted for that launch, so Codex doesn't ask whether to trust it. Nothing is written to Codex's files. Off, Codex asks once per project on each connection, and Set Up walks you through them.", description: 'What the advanced setting "Trust Combwork\'s folders on each launch" is for, and what happens when it is off (Settings → Advanced, HI-1871). A slot and a review copy are folders Combwork lends to agents.' }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/trust-perlaunch-codex-0.164.0.txt`, version: '0.164.0', text: 'no trust question: at its prompt', shows: 'Codex started in a repository trusted only by a -c projects table for that launch, asking nothing and writing nothing' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.trust.prompt',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.trust.prompt.title', defaultMessage: 'Trust question', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.trust.prompt.desc', defaultMessage: "Codex's question before a folder's first session (in a Git repository). Combwork shows the agent as waiting for you while it is on screen.", description: 'What the advanced setting "Trust question" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: 'trust this folder', // i18n-ignore: a CLI's recorded text (#367)
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/trust-codex-0.162.1.txt`, version: '0.162.1', text: 'Trust this folder? Codex can read, edit, and run files here' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Its offer of a cheaper model near the account's limit (HI-2609): turned off for each launch, and never typed into.
  {
    id: 'codex.rateLimitNudge.hide',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.rateLimitNudge.hide.title', defaultMessage: "Don't offer a cheaper model near the limit", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork (HI-2609): Codex's offer to switch to a cheaper model when the account nears its usage limit." }),
    desc: msg({ id: 'settings.advanced.codex.rateLimitNudge.hide.desc', defaultMessage: "Each Codex agent is started with Codex's offer to switch to a cheaper model turned off for that launch, so it keeps its connection's model when the account nears its limit. Nothing is written to Codex's files. Off, Codex may ask, and the agent waits for your answer in its terminal: Combwork types nothing into it meanwhile.", description: 'What the advanced setting "Don\'t offer a cheaper model near the limit" is for, and what happens when it is off (Settings → Advanced, HI-2609). A connection is an account Combwork signs a CLI in with.' }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/ratelimit-nudge-hide-codex-0.166.0.txt`, version: '0.166.0', text: 'invalid type: string "notabool", expected a boolean', shows: 'Codex reading -c notice.hide_rate_limit_model_nudge as its own boolean setting (a wrong value refused), and the offer\'s strings in its binary' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.screen.idleQuestion',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.screen.idleQuestion.title', defaultMessage: 'Screen: question while idle', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.screen.idleQuestion.desc', defaultMessage: "The titles of the questions Codex shows by itself between turns, sending no hook (its offer of a cheaper model near the account's limit, and its offers to ask your workspace's owner for more credits or a higher limit once a workspace reaches its limit), in the lines it drew last. While one shows with one of its choices (Screen: question's choice), the agent waits for you and Combwork types nothing into it, since a key or Enter would answer it. Wrong, a wake typed into the question can answer it.", description: 'What the advanced setting "Screen: question while idle" is for, and what goes wrong when it is wrong (Settings → Advanced, HI-2609, HI-2619). "Screen: question\'s choice" is another advanced setting\'s title: keep it as translated there.' }),
    kind: 'pattern',
    default: String.raw`Approaching rate limits|You've reached your workspace credit limit|Usage limit reached`,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/ratelimit-nudge-codex-0.166.0.txt`, version: '0.166.0', text: 'Approaching rate limits' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/credit-limit-nudge-codex-0.166.0.txt`, version: '0.166.0', text: "You've reached your workspace credit limit" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/usage-limit-nudge-codex-0.166.0.txt`, version: '0.166.0', text: 'Usage limit reached' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'codex.screen.idleQuestionChoice',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.screen.idleQuestionChoice.title', defaultMessage: "Screen: question's choice", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.screen.idleQuestionChoice.desc', defaultMessage: "One of the choices of those questions (Screen: question while idle), as Codex numbers it. Both must show, near the bottom of its screen and not in its input, for the question to count, so the same words in the conversation don't stop Combwork typing.", description: 'What the advanced setting "Screen: question\'s choice" is for (Settings → Advanced, HI-2609, HI-2619). "Screen: question while idle" is another advanced setting\'s title: keep it as translated there.' }),
    kind: 'pattern',
    default: String.raw`\b\d\.\s+(?:Keep current model\b|No \(default\))`,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/ratelimit-nudge-codex-0.166.0.txt`, version: '0.166.0', text: '2. Keep current model' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/credit-limit-nudge-codex-0.166.0.txt`, version: '0.166.0', text: '2. No (default)' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/usage-limit-nudge-codex-0.166.0.txt`, version: '0.166.0', text: '2. No (default)' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'codex.fullAccess.warning',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.fullAccess.warning.title', defaultMessage: 'Full Access warning', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Full Access is Codex's mode: keep it." }),
    desc: msg({ id: 'settings.advanced.codex.fullAccess.warning.desc', defaultMessage: "Codex's own warning after Full Access is picked in its /permissions menu, which you answer in its terminal. While it is on screen, Combwork's switch to Full Access waits for your answer; if it doesn't match, Combwork may say Codex didn't confirm the switch while the warning is still waiting.", description: 'What the advanced setting "Full Access warning" is for, and what goes wrong when it is wrong (Settings → Advanced). Full Access and /permissions are Codex\'s: keep them.' }),
    kind: 'pattern',
    default: 'Enable full access\\?', // i18n-ignore: a CLI's recorded text (#367)
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/fullaccess-codex-0.162.1.txt`, version: '0.162.1', text: 'Enable full access?' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.fullAccess.warningAfterSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.fullAccess.warningAfterSeconds.title', defaultMessage: 'Full Access warning: time to appear', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Full Access is Codex's mode: keep it." }),
    desc: msg({ id: 'settings.advanced.codex.fullAccess.warningAfterSeconds.desc', defaultMessage: "How long Codex has, after Combwork picks a preset in its /permissions menu before its first message, to show its own warning (Full Access). With no session file to read the switch back from, Combwork takes the preset as switched once this passes with no warning; raise it if a slow machine draws the warning later.", description: 'What the advanced setting "Full Access warning: time to appear" is for, and what goes wrong when it is wrong (Settings → Advanced). Full Access and /permissions are Codex\'s: keep them.' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 30,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/fullaccess-codex-0.162.1.txt`, version: '0.162.1', text: 'Enable full access?', shows: "Codex's warning after Full Access is picked, which it draws within this time" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.fullAccess.answerSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.fullAccess.answerSeconds.title', defaultMessage: 'Full Access warning: wait for your answer', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Full Access is Codex's mode: keep it." }),
    desc: msg({ id: 'settings.advanced.codex.fullAccess.answerSeconds.desc', defaultMessage: "How long Combwork's switch to Full Access waits for you to answer Codex's own warning in its terminal. Meanwhile Combwork types nothing into the agent; once it passes, Combwork says Codex didn't confirm the switch, and still notices it later if you answer Yes.", description: 'What the advanced setting "Full Access warning: wait for your answer" is for, and what goes wrong when it is wrong (Settings → Advanced). Full Access is Codex\'s: keep it.' }),
    kind: 'number',
    default: 600,
    min: 30,
    max: 3600,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/fullaccess-codex-0.162.1.txt`, version: '0.162.1', text: '1. Yes, continue anyway', shows: "Codex's warning waiting for the user's answer" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.ready.placeholder',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.ready.placeholder.title', defaultMessage: 'Composer placeholder', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.ready.placeholder.desc', defaultMessage: "The text Codex's empty input shows. Codex only says it has started with the first prompt, so Combwork takes this text on screen to mean it is ready, and an input line showing only this to mean it is idle.", description: 'What the advanced setting "Composer placeholder" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'Ask Codex to do anything', // i18n-ignore: a CLI's recorded text (#367)
    applies: 'now',
    samples: [{ from: `${FIX}/screen-codex-0.162.1-idle.txt`, version: '0.162.1', text: '› Ask Codex to do anything' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.signIn.expired',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.signIn.expired.title', defaultMessage: 'Sign-in refused: error message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.signIn.expired.desc', defaultMessage: "A turn's error, in Codex's session file, that means its sign-in was refused or has expired, when Codex doesn't mark the error itself (#309).", description: 'What the advanced setting "Sign-in refused: error message" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`^unexpected status 401 Unauthorized\b|access token could not be refreshed|refresh token (?:has expired|was already used|was revoked)`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/signin-codex-0.160.0.jsonl`, version: '0.160.0', text: 'unexpected status 401 Unauthorized: Incorrect API key provided' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A turn its connection's failure ended (HI-1612): the error of its task_complete. A provider refusing connections
  // doesn't fail the turn (Codex waits for the network: tests/fixtures/advanced/README.md), a stream dropped does.
  {
    id: outagePatternId('codex'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.outage.connectionError.title', defaultMessage: 'Connection dropped: error message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.outage.connectionError.desc', defaultMessage: "A turn's error, in Codex's session file, that means it lost its connection to its API: with Resume agents after a connection drops on, Combwork waits for the connection and resumes the agent. Wrong, such agents stay stopped.", description: 'What the advanced setting "Connection dropped: error message" is for, and what goes wrong when it is wrong (Settings → Advanced). Resume agents after a connection drops is the title of another advanced setting.' }),
    kind: 'pattern',
    default: String.raw`\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b|stream disconnected|Transport error|network error|error sending request|connection (?:refused|reset|closed)`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/turn-failed-codex-0.164.0.jsonl`, version: '0.164.0', text: 'stream disconnected before completion: Transport error: network error: error decoding response body' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.subagent.item',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.subagent.item.title', defaultMessage: "Session file: subagent's activity", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.subagent.item.desc', defaultMessage: "The kind of item Codex records when a subagent it spawned starts or ends (#1584). Wrong, Combwork doesn't count Codex's subagents among an agent's background tasks.", description: 'What the advanced setting "Session file: subagent\'s activity" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'SubAgentActivity',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-codex-0.164.0.jsonl`, version: '0.164.0', text: 'SubAgentActivity' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.subagent.started',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.subagent.started.title', defaultMessage: 'Session file: subagent started', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.subagent.started.desc', defaultMessage: "The kind of that activity when the subagent starts; any other kind ends it. Wrong, Combwork doesn't count Codex's subagents.", description: 'What the advanced setting "Session file: subagent started" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'started',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-codex-0.164.0.jsonl`, version: '0.164.0', text: 'started' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.subagent.threadField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.subagent.threadField.title', defaultMessage: "Session file: subagent's thread field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.subagent.threadField.desc', defaultMessage: "The field of that activity with the subagent's thread, which tells its start and its end apart from another's. Wrong, Combwork doesn't count Codex's subagents.", description: 'What the advanced setting "Session file: subagent\'s thread field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'agent_thread_id',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['type', 'model', 'reasoning_effort', 'id', 'kind', 'agent_thread_id', 'agent_path'] }]
  },
  {
    id: 'codex.subagent.taskField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.subagent.taskField.title', defaultMessage: "Session file: subagent's task field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.subagent.taskField.desc', defaultMessage: "The field of that activity with the subagent's task name. Wrong, Combwork still counts it but has no description of it.", description: 'What the advanced setting "Session file: subagent\'s task field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'agent_path',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['type', 'model', 'reasoning_effort', 'id', 'kind', 'agent_thread_id', 'agent_path'] }]
  },
  {
    id: 'codex.rateLimits.field',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.rateLimits.field.title', defaultMessage: 'Session file: plan limits field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.rateLimits.field.desc', defaultMessage: "The field of Codex's token counts with a subscription's limits. Wrong, Combwork shows no plan limits for Codex.", description: 'What the advanced setting "Session file: plan limits field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'rate_limits',
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', fields: ['type', 'info', 'rate_limits'] }]
  },
  {
    id: 'codex.rateLimits.usedPercent',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.rateLimits.usedPercent.title', defaultMessage: 'Session file: percentage used field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.rateLimits.usedPercent.desc', defaultMessage: "A limit's field with the percentage used.", description: 'What the advanced setting "Session file: percentage used field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'used_percent',
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', fields: ['used_percent', 'window_minutes', 'resets_at'] }]
  },
  {
    id: 'codex.rateLimits.windowMinutes',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.rateLimits.windowMinutes.title', defaultMessage: "Session file: limit's window field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.rateLimits.windowMinutes.desc', defaultMessage: "A limit's field with its window in minutes (300 is the 5-hour limit, 10080 the weekly one).", description: 'What the advanced setting "Session file: limit\'s window field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'window_minutes',
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', fields: ['used_percent', 'window_minutes', 'resets_at'] }]
  },
  // HI-1125: which of Codex's limits a reading is (its rate-limit snapshot's id, codex-rs RateLimitSnapshot.limit_id).
  {
    id: 'codex.rateLimits.limitId',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.rateLimits.limitId.title', defaultMessage: "Session file: limit's id field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.rateLimits.limitId.desc', defaultMessage: "The plan limits' field naming which of Codex's limits they are. Wrong, Combwork takes every reading for Codex's own limit, and a second limit's figures are mixed into it.", description: 'What the advanced setting "Session file: limit\'s id field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'limit_id',
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', fields: RATE_LIMIT_FIELDS }]
  },
  {
    id: 'codex.rateLimits.limitName',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.rateLimits.limitName.title', defaultMessage: "Session file: limit's name field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.rateLimits.limitName.desc', defaultMessage: "The plan limits' field with the name Codex gives a limit other than its own. Wrong, Combwork names such a limit by its id.", description: 'What the advanced setting "Session file: limit\'s name field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'limit_name',
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', fields: RATE_LIMIT_FIELDS }]
  },
  {
    id: 'codex.rateLimits.defaultLimitId',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.rateLimits.defaultLimitId.title', defaultMessage: "Session file: Codex's own limit id", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.rateLimits.defaultLimitId.desc', defaultMessage: "The id of Codex's own plan limits (its 5-hour and weekly ones). A reading with another id is a limit of its own, shown by its name. Wrong, Codex's own limits are shown as a separate limit, and their earlier readings and warnings start again.", description: 'What the advanced setting "Session file: Codex\'s own limit id" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'codex', // i18n-ignore: a CLI's recorded value (#367)
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', text: '"limit_id": "codex"' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Connections (HI-1757): what Combwork asks Codex's app server in a connection's CODEX_HOME, never a token.
  {
    id: 'codex.accounts.statusSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.statusSeconds.title', defaultMessage: 'Connections: sign-in check timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.statusSeconds.desc', defaultMessage: "How long Combwork gives Codex's app server to say who a connection's folder is signed in as (`account/read`). Past it, the connection shows \"Couldn't check\", never signed out.", description: 'What the advanced setting "Connections: sign-in check timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `account/read` as it is (a request\'s name).' }),
    kind: 'number',
    default: 30,
    min: 5,
    max: 120,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/account-read-codex-0.164.0.jsonl`, version: '0.164.0', text: 'account/read', shows: "Codex's app server answering who its CODEX_HOME is signed in as" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.accounts.readMethod',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.readMethod.title', defaultMessage: 'Connections: sign-in request', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.readMethod.desc', defaultMessage: "The request Combwork sends Codex's app server to ask who a connection's folder is signed in as. Wrong, Combwork can't tell, and its Codex connections show \"Couldn't check\".", description: 'What the advanced setting "Connections: sign-in request" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'account/read',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/account-read-codex-0.164.0.jsonl`, version: '0.164.0', text: 'account/read' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.accounts.accountField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.accountField.title', defaultMessage: 'Connections: account field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.accountField.desc', defaultMessage: "The field of Codex's sign-in answer with the account a connection's folder is signed in as (empty when it is signed out). Wrong, Combwork can't tell, and its Codex connections show \"Couldn't check\".", description: 'What the advanced setting "Connections: account field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'account',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/account-read-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['account', 'requiresOpenaiAuth', 'workspaceRouting'] }]
  },
  {
    id: 'codex.accounts.emailField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.emailField.title', defaultMessage: 'Connections: email field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.emailField.desc', defaultMessage: "The field of Codex's account with the email a connection's folder is signed in as. Wrong, Combwork can't tell who a connection is signed in as, and can't warn when its login changes.", description: 'What the advanced setting "Connections: email field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'email',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/account-read-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['type', 'email', 'planType'] }]
  },
  {
    id: 'codex.accounts.planField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.planField.title', defaultMessage: 'Connections: plan field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.planField.desc', defaultMessage: "The field of Codex's account with a connection's plan (\"plus\", \"pro\"), shown beside its email in Settings → Accounts & Connections. Wrong, no plan is shown.", description: 'What the advanced setting "Connections: plan field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep "plus" and "pro" as they are (plan names).' }),
    kind: 'field',
    default: 'planType',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/account-read-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['type', 'email', 'planType'] }]
  },
  {
    id: 'codex.accounts.loginFiles',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.loginFiles.title', defaultMessage: 'Connections: login files', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.loginFiles.desc', defaultMessage: "The names of the files in a connection's folder that change when Codex signs in or out there, as a regular expression. Combwork watches them (it never reads them) and checks the connection again when one changes. Wrong, a sign-in or sign-out in an agent's pane is only found at the connection's next check.", description: 'What the advanced setting "Connections: login files" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: '^auth\\.json$',
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/home-codex-0.164.0.txt`, version: '0.164.0', text: 'auth.json', shows: 'The login file at the top of a signed-in Codex home (its contents never read)' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.accounts.dropEnv',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.dropEnv.title', defaultMessage: 'Connections: sign-in variables left out', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.dropEnv.desc', defaultMessage: "The environment variables Combwork leaves out when it runs Codex on a connection (its sign-in, its checks and its agents), so a key or token set on this PC can't stand in for the connection's own login. Wrong, a variable Codex reads as a login could make a connection run as someone else.", description: 'What the advanced setting "Connections: sign-in variables left out" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'list',
    default: ['CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY'],
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/ambient-auth-codex-0.164.0.txt`, version: '0.164.0', text: 'CODEX_ACCESS_TOKEN alone: "Error checking login status: invalid agent identity JWT format"', shows: 'A token in the environment taken over a connection home that is signed out' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Codex's non-admin Windows sandbox on connections (HI-1893, HI-1874's findings), passed per launch: off by default.
  {
    id: 'codex.accounts.unelevatedSandbox',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.unelevatedSandbox.title', defaultMessage: "Connections: use Codex's non-admin sandbox", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Codex's non-admin sandbox is its Windows sandbox that needs no Administrator permission." }),
    desc: msg({
      id: 'settings.advanced.codex.accounts.unelevatedSandbox.desc',
      defaultMessage:
        "Turned on, Combwork runs Codex on a connection (its agents, its Set Up and its checks) in Codex's non-admin Windows sandbox, passing -c windows.sandbox=\"unelevated\" each time, unless the connection's own config.toml chooses a sandbox. Nothing is written to Codex's config, and Codex on its own folder (~/.codex) runs as you've set it up. What it gains: no Administrator (UAC) prompts, and setting up one Codex folder no longer resets the sandbox's shared password, which makes the others ask for Administrator permission again. What it loses: commands run as you rather than as separate sandbox accounts, and their network is blocked by environment settings only, not by the firewall. Unchanged: writes outside the project's folders are still refused, and the first time a connection works in a project it still grants its permissions over the project's files once. Either way, Codex's commands can still read other connections' login files. Windows only.",
      description: 'What the advanced setting "Connections: use Codex\'s non-admin sandbox" does (Settings → Advanced, under Codex). -c windows.sandbox="unelevated" is a command-line option, and config.toml and ~/.codex are a file and a folder: keep them as they are. UAC is Windows\' User Account Control.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/windows-sandbox-codex-0.164.0.txt`, version: '0.164.0', text: 'Unelevated,', shows: "Codex's own config type for windows.sandbox, whose kebab-case values include \"unelevated\" (its source, not a run)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.appServer.closeSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.appServer.closeSeconds.title', defaultMessage: 'App server: time to close', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.appServer.closeSeconds.desc', defaultMessage: "How long Codex's app server gets to end by itself once Combwork has its answer (a connection's sign-in check, its hooks' check). Past it, Combwork ends it with everything it started. Too short, Codex is cut off as it ends; too long, its processes stay a little longer.", description: 'What the advanced setting "App server: time to close" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 3,
    min: 1,
    max: 30,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/appserver-close-codex-0.164.0.txt`, version: '0.164.0', text: 'exited by itself in 198 ms', shows: "Codex's app server ending by itself once its stdin closed" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.title.items',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.title.items.title', defaultMessage: 'Terminal title items', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.title.items.desc', defaultMessage: 'What Combwork asks Codex to put in its terminal title (tui.terminal_title): its activity, which shows the busy spinner and "Action Required", and the project\'s name. Without activity, Combwork can\'t tell from the title that Codex is working or needs you.', description: 'What the advanced setting "Terminal title items" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'list',
    default: ['activity', 'project-name'],
    applies: 'sessions',
    samples: [{ from: `${FIX}/codex-startup-0.160.0.json`, version: '0.160.0', text: ']0;⠹ demo-codex-setup', shows: "Codex's title with its activity spinner, from the title items Combwork gave its setup task" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.hooks.timeoutSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.timeoutSeconds.title', defaultMessage: 'Hooks: timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: withValues(msg({ id: 'settings.advanced.codex.hooks.timeoutSeconds.desc', defaultMessage: 'How long Codex waits for Combwork to take one of its hooks. Codex itself holds the interrupt and session-end hooks to {most, plural, one {# second} other {# seconds}} at most. Combwork approves its hooks for Codex itself, so a change needs no review in Codex.', description: 'What the advanced setting "Hooks: timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). {most} is the longest Codex allows those two hooks, in seconds.' }), { most: 3 }),
    kind: 'number',
    default: 30,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN]
  },
  {
    id: 'codex.hooks.preToolUseTimeoutSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.preToolUseTimeoutSeconds.title', defaultMessage: 'Hooks: before a tool, timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.hooks.preToolUseTimeoutSeconds.desc', defaultMessage: "How long Codex waits for Combwork's answer before a tool runs (an edit waits for a file lock). If Combwork doesn't answer in time, the tool goes ahead.", description: 'What the advanced setting "Hooks: before a tool, timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 30,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN]
  },
  // What Combwork asks Codex's app server for a launch's hooks (HI-982: the Hooks dialog; the hook hashes it trusts at launch).
  {
    id: 'codex.hooks.listMethod',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.listMethod.title', defaultMessage: 'Hooks: listing request', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.hooks.listMethod.desc', defaultMessage: "The request Combwork sends Codex's app server for the hooks a session has. Wrong, an agent's Hooks dialog lists only Combwork's own and says Codex couldn't list the rest, and Combwork trusts its hooks by its own hashes.", description: 'What the advanced setting "Hooks: listing request" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'hooks/list',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/hooks-list-codex-0.164.0.txt`, version: '0.164.0', text: 'hooks/list' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.hooks.listSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.listSeconds.title', defaultMessage: 'Hooks: listing timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.hooks.listSeconds.desc', defaultMessage: "How long Combwork gives Codex's app server to list a session's hooks (`hooks/list`). Past it, an agent's Hooks dialog lists only Combwork's own and says Codex couldn't list the rest.", description: 'What the advanced setting "Hooks: listing timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `hooks/list` as it is (a request\'s name).' }),
    kind: 'number',
    default: 20,
    min: 2,
    max: 120,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/hooks-list-codex-0.164.0.txt`, version: '0.164.0', text: 'hooks/list', shows: "Codex's app server taking the request Combwork sends for a session's hooks (its source: not a run)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Codex waiting to retry its model request (HI-1972): its only record is a row of its log database, read by these.
  {
    id: 'codex.retry.logTarget',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.retry.logTarget.title', defaultMessage: 'Retry wait: log entries', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. A retry wait: the coding agent waiting to try its model request again (after being rate-limited)." }),
    desc: msg({ id: 'settings.advanced.codex.retry.logTarget.desc', defaultMessage: "Where in its own log (logs_2.sqlite in its home folder) Codex says it is waiting to retry its model request, after being rate-limited for example. Combwork reads the latest such entry of a session's turn and shows the wait as its status. Wrong, a waiting agent just shows Working.", description: 'What the advanced setting "Retry wait: log entries" is for, and what goes wrong when it is wrong (Settings → Advanced). logs_2.sqlite is a file name: keep it.' }),
    kind: 'text',
    default: 'codex_core::responses_retry',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-log-codex-0.164.0.txt`, version: '0.164.0', text: 'WARN codex_core::responses_retry' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.retry.pattern',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.retry.pattern.title', defaultMessage: 'Retry wait: message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. A retry wait: the coding agent waiting to try its model request again." }),
    desc: msg({ id: 'settings.advanced.codex.retry.pattern.desc', defaultMessage: 'How Codex words that log entry: a regular expression whose named groups give the try (attempt), the tries allowed (max), the wait (seconds, or millis) and the HTTP status that refused the request (status: 429 is a rate limit). Wrong, a waiting agent just shows Working.', description: 'What the advanced setting "Retry wait: message" is for (Settings → Advanced). attempt, max, seconds, millis and status are the names of the regular expression\'s groups: keep them.' }),
    kind: 'pattern',
    default: String.raw`retrying sampling request \((?<attempt>\d+)/(?<max>\d+) in (?:(?<seconds>\d+(?:\.\d+)?)s|(?<millis>\d+(?:\.\d+)?)ms)\)(?:.*?last status: (?<status>\d{3})\b)?`,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-log-codex-0.164.0.txt`, version: '0.164.0', text: 'stream disconnected - retrying sampling request (1/5 in 399.9997619s)... turn_id=00000000-0000-4000-8000-0000000000a1 retries=1 max_retries=5 sampling_error=exceeded retry limit, last status: 429 Too Many Requests' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.retry.checkAfterSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.retry.checkAfterSeconds.title', defaultMessage: 'Retry wait: look after', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"20 s\"). A retry wait: the coding agent waiting to try its model request again." }),
    desc: msg({ id: 'settings.advanced.codex.retry.checkAfterSeconds.desc', defaultMessage: "How long a working Codex session has to go without a hook before Combwork looks in Codex's log for a wait to retry its model request, then every 15 seconds while it stays quiet.", description: 'What the advanced setting "Retry wait: look after" does (Settings → Advanced).' }),
    kind: 'number',
    default: 20,
    min: 5,
    max: 600,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-log-codex-0.164.0.txt`, version: '0.164.0', text: 'retrying sampling request', shows: "Codex's log entry saying it waits to retry, which Combwork looks for once a session has been quiet this long" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // How long Combwork waits for Codex to render a session's prompt (#1285): it reads the developer_instructions Combwork's guidance
  // follows from it. Past it, Combwork adds none of its guidance rather than replace instructions it couldn't read.
  {
    id: 'codex.promptInput.timeoutSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.promptInput.timeoutSeconds.title', defaultMessage: "Reading a session's instructions: timeout", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.promptInput.timeoutSeconds.desc', defaultMessage: "How long Combwork waits, as a Codex agent starts, for Codex to show the session's prompt (codex debug prompt-input, offline), from which it reads the developer_instructions it puts its guidance after. Too short on a slow machine, the agent starts with yours as they are and without Combwork's guidance, and Combwork says so.", description: 'What the advanced setting "Reading a session\'s instructions: timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). codex debug prompt-input is a command and developer_instructions a Codex setting: keep them.' }),
    kind: 'number',
    default: 60,
    min: 2,
    max: 300,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/help-codex-0.163.0-prompt-input.txt`, version: '0.163.0', text: 'Render the model-visible prompt input list as JSON', shows: "Codex's help for the command Combwork runs, offline, to read a session's developer_instructions" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.mcp.toolTimeoutSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.mcp.toolTimeoutSeconds.title', defaultMessage: 'Combwork tools: timeout in Codex', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.mcp.toolTimeoutSeconds.desc', defaultMessage: "How long Codex lets one of Combwork's tools run (its tool_timeout_sec for the combwork server). Combwork's waits stay a minute under it.", description: 'What the advanced setting "Combwork tools: timeout in Codex" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 900,
    min: 120,
    max: 3600,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/mcp-list-codex-0.162.1.json`, version: '0.162.1', text: '"tool_timeout_sec": 900.0', shows: "Codex reading the combwork server's tool_timeout_sec from Combwork's -c override (codex mcp list --json)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.mcp.startupTimeoutSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.mcp.startupTimeoutSeconds.title', defaultMessage: 'Combwork tools: startup timeout in Codex', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.mcp.startupTimeoutSeconds.desc', defaultMessage: "How long Codex waits for Combwork's combwork server to start: Combwork gives Codex this one for it at every launch, over Codex's own (10 s) and over a startup timeout your own Codex config sets for a server named combwork. Too short, and Codex agents start without Combwork's tools.", description: 'What the advanced setting "Combwork tools: startup timeout in Codex" is for, and what goes wrong when it is wrong (Settings → Advanced). combwork is the name of Combwork\'s MCP server.' }),
    kind: 'number',
    default: 30,
    min: 5,
    max: 300,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/mcp-get-codex-0.163.0-native-old-name.json`, version: '0.163.0', text: '"startup_timeout_sec": 10.0', shows: "Codex taking the combwork server's startup_timeout_sec from Combwork's -c override over a native server with Combwork's 1.0 name and its own (codex mcp get <that name> --json)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: drawnWaitId('codex'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.prompt.drawnSeconds.title', defaultMessage: 'Typed line: wait to be drawn', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.prompt.drawnSeconds.desc', defaultMessage: "How long Combwork waits for Codex to show a line Combwork typed (a message's notice, a wake) in its prompt before pressing Enter. Codex drops an Enter that it reads together with the line while it is busy, so Combwork presses Enter once the line shows; if it doesn't show in time, Combwork presses Enter anyway, and presses it again 10 seconds later if the line wasn't sent.", description: 'What the advanced setting "Typed line: wait to be drawn" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 5,
    min: 1,
    max: 60,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/drawn-codex-0.163.0.txt`, version: '0.163.0', text: '› [CW] New in your inbox: 1 message (m1). Call cw_inbox to read it.', shows: "Codex showing a line Combwork typed in its prompt, before Enter: what Combwork waits to see (the doorbell's text since HI-2463; the screen recorded with 0.163.0 had Combwork's)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A line break in a prompt Combwork types into Codex (HI-1327): a key its input box takes as a new line, or a space.
  {
    id: 'codex.prompt.newlineKey',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.prompt.newlineKey.title', defaultMessage: 'Typed prompts: line breaks', description: "An advanced setting's title (Settings → Advanced), listed under Codex: what Combwork presses for a line break in a prompt it types into Codex." }),
    desc: msg({
      id: 'settings.advanced.codex.prompt.newlineKey.desc',
      defaultMessage:
        "With Send prompts as typed on, what Combwork presses in Codex for each line break of a prompt it types. Alt+Enter and Ctrl+J are keys Codex takes as a new line rather than sending, so the prompt arrives as written (tried with Codex 0.164.0). Automatic uses Alt+Enter with a Codex version it was tried with, and spaces with others; a key you choose is used with any version. Spaces puts the prompt on one line. If you changed Codex's own new-line keys, choose Spaces. A slash command always gets spaces.",
      description: 'What the advanced setting "Typed prompts: line breaks" does (Settings → Advanced, under Codex). Send prompts as typed is another setting\'s title: use it as Settings shows it. Automatic, Spaces, Alt+Enter and Ctrl+J are the setting\'s choices: use the words its list shows (Alt+Enter and Ctrl+J are keys: name them as your language does). Keep 0.164.0 as it is (a version).'
    }),
    kind: 'choice',
    choices: [
      { value: 'auto', label: msg({ id: 'settings.advanced.codex.prompt.newlineKey.auto', defaultMessage: 'Automatic', description: 'A choice of the advanced setting "Typed prompts: line breaks": Alt+Enter with a Codex version it was tried with, spaces with others.' }) },
      { value: 'spaces', label: msg({ id: 'settings.advanced.codex.prompt.newlineKey.spaces', defaultMessage: 'Spaces', description: 'A choice of the advanced setting "Typed prompts: line breaks": each line break becomes a space.' }) },
      { value: 'alt-enter', label: msg({ id: 'settings.advanced.codex.prompt.newlineKey.altEnter', defaultMessage: 'Alt+Enter', description: 'A choice of the advanced setting "Typed prompts: line breaks": Combwork presses Alt+Enter for each line break (a key: name it as your language does).' }) },
      { value: 'ctrl-j', label: msg({ id: 'settings.advanced.codex.prompt.newlineKey.ctrlJ', defaultMessage: 'Ctrl+J', description: 'A choice of the advanced setting "Typed prompts: line breaks": Combwork presses Ctrl+J for each line break (a key: name it as your language does).' }) }
    ],
    default: 'auto',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/newline-keys-codex-0.164.0.txt`, version: '0.164.0', text: 'alt(KeyCode::Enter)', shows: "Codex's own keymap taking Alt+Enter and Ctrl+J as a new line (its source), and Windows' console delivering each as one key (HI-1327's probe); the real-tier suite codex-newline saw both prompts arrive as written in Codex 0.164.0" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.turnScreen.working',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.turnScreen.working.title', defaultMessage: 'Screen: working', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.turnScreen.working.desc', defaultMessage: "Codex's Working line, drawn only while a turn runs. When Combwork missed a turn's start or end, it takes this on screen to mean the agent is working; wrong, it can take a working agent for idle.", description: 'What the advanced setting "Screen: working" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`esc to interrupt|\bWorking \(`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/screen-codex-0.162.1-working.txt`, version: '0.162.1', text: '• Working (5s • esc to interrupt)' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.queue.hint',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.queue.hint.title', defaultMessage: 'Screen: holding what was typed', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.queue.hint.desc', defaultMessage: "Codex's hint on the last line it draws while it is busy and queues what is typed. Combwork waits for it to go before typing into Codex (a message, its /permissions menu at setup); wrong, what Combwork types can be queued rather than run.", description: 'What the advanced setting "Screen: holding what was typed" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`^tab to queue message\b`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/screen-codex-0.162.1-working.txt`, version: '0.162.1', text: 'tab to queue message' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A lane's end (HI-1706): the command Combwork types to end Codex as a person would, and how long it waits for the exit.
  {
    id: 'codex.exit.command',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.exit.command.title', defaultMessage: "Lane's end: exit command", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.exit.command.desc', defaultMessage: "What Combwork types into Codex, then Enter, to end it once its lane has ended and its turn is over, so it exits by itself rather than being killed. Wrong, Codex isn't ended by it and is killed after the exit grace.", description: 'What the advanced setting "Lane\'s end: exit command" is for, and what goes wrong when it is wrong (Settings → Advanced). A lane is a card loop.' }),
    kind: 'text',
    default: '/quit',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/exit-codex-0.164.0.json`, version: '0.164.0', text: '"sent": "/quit"', shows: 'Codex exiting by itself (exit code 0) on /quit and Enter at its prompt' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.exit.graceSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.exit.graceSeconds.title', defaultMessage: "Lane's end: exit grace", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: withValues(msg({ id: 'settings.advanced.codex.exit.graceSeconds.desc', defaultMessage: "How long Combwork gives Codex to exit by itself after typing its exit command at a lane's end, before killing it. It took {took, plural, one {# second} other {# seconds}} when recorded.", description: 'What the advanced setting "Lane\'s end: exit grace" is for (Settings → Advanced). {took} is how long Codex took to exit when recorded, in seconds (1.4).' }), { took: 1.4 }),
    kind: 'number',
    default: 30,
    min: 3,
    max: 300,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/exit-codex-0.164.0.json`, version: '0.164.0', text: '"exitCode": 0', shows: 'Codex exiting by itself 1.4 s after /quit and Enter' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  ...(
    [
      ['readOnly', 'Read Only', 'read-only'],
      ['ask', 'Ask for approval', 'ask'],
      ['approveForMe', 'Approve for me', 'approve-for-me'],
      ['fullAccess', 'Full Access', 'full-access']
    ] as const
  ).map(
    ([key, label, mode]): AdvancedSource => ({
      id: `codex.permissions.${key}`,
      group: 'codex',
      title: withValues(msg({ id: 'settings.advanced.codexPermissions.title', defaultMessage: '/permissions menu: {label}', description: "An advanced setting's title (Settings → Advanced, under Codex). /permissions is a Codex command and {label} Codex's own name for a preset, in English: keep both as they are." }), { label }),
      desc: withValues(
        msg({
          id: 'settings.advanced.codexPermissions.desc',
          defaultMessage: "The label Codex's /permissions menu shows for its {label} preset. Combwork types the number beside it to give an agent the {mode} mode; wrong, Combwork can't find it, and says so rather than choosing another.",
          description: "What the advanced setting is for (Settings → Advanced, under Codex). {label} is Codex's own name for a preset and {mode} Combwork's id for the mode (read-only, ask…), both in English: keep them as they are."
        }),
        { label, mode }
      ),
      kind: 'text',
      default: label,
      applies: 'now',
      samples: [{ from: `${FIX}/codex-0.161-permissions-ask.txt`, version: '0.161', text: label }]
    })
  ),
  {
    id: rightClickToCliId('codex'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.mouse.rightClickToCli.title', defaultMessage: 'Pass right-click to Codex', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({
      id: 'settings.advanced.codex.mouse.rightClickToCli.desc',
      defaultMessage: "Right-click in a Codex pane is Combwork's, as in every pane: it copies the terminal's selection (Shift+drag), or pastes. Turned on, Combwork passes right-clicks to Codex instead, which tracks the mouse itself.",
      description: 'What the advanced setting "Pass right-click to Codex" is for (Settings → Advanced, under Codex). Shift+drag names a key and a mouse action: use the key names your language uses.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/mouse-codex-0.163.0.json`, version: '0.163.0', text: '"mouseTracking": "?1003h ?1006h"', shows: 'Codex turning on mouse tracking as Combwork starts it, which a passed right-click reaches' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('codex', 'terminalTitle'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.override.terminalTitle.title', defaultMessage: "Set Codex's terminal title", description: "An advanced setting's title (Settings → Advanced, under Codex): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.codex.override.terminalTitle.desc',
      defaultMessage: "Combwork gives Codex's sessions their terminal title items (Terminal title items, as tui.terminal_title), whatever your own Codex config says, and tells from the title when Codex needs you (\"Action Required\"). Turned off, your Codex config decides the title, and Combwork tells when Codex needs you from its hooks instead, as it does for Codex versions before 0.160. Codex's setup in Provider Setup keeps Combwork's title, which it waits on.",
      description: 'What the advanced setting "Set Codex\'s terminal title" does (Settings → Advanced, under Codex). Terminal title items is another setting\'s title: use it as Settings shows it. tui.terminal_title is a config key and "Action Required" is Codex\'s own text: keep them. Provider Setup is a dialog\'s name.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/codex-startup-0.160.0.json`, version: '0.160.0', text: ']0;⠹ demo-codex-setup', shows: "Codex's title with its activity spinner, from the title items Combwork gave it" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('codex', 'preApproveCombworkTools'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.override.preApproveCombworkTools.title', defaultMessage: "Pre-approve Combwork's tools", description: "An advanced setting's title (Settings → Advanced, under Codex): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.codex.override.preApproveCombworkTools.desc',
      defaultMessage: "Combwork gives Codex its combwork server with its tools approved (for the Assistant, only those its Control settings let it use without asking), so Codex doesn't ask before them in any mode. Turned off, Codex asks before them as its own approval policy says. What an agent or the Assistant may do with them is still decided by Combwork.",
      description: 'What the advanced setting "Pre-approve Combwork\'s tools" does (Settings → Advanced, under Codex). combwork is the name of Combwork\'s MCP server. Control is the name of the Assistant\'s settings page.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/mcp-tool-approval-codex-0.163.0.txt`, version: '0.163.0', text: 'Allow the probe MCP server to run tool "b"?', shows: 'Codex running a tool approved alone (tools.a.approval_mode="approve") without asking, then asking before the server\'s other tool' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('codex', 'mcpIsolation'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.override.mcpIsolation.title', defaultMessage: "Only the workspace's MCP servers", description: "An advanced setting's title (Settings → Advanced, under Codex): one of Combwork's overrides of the CLI, on by default. MCP is a protocol's name." }),
    desc: msg({
      id: 'settings.advanced.codex.override.mcpIsolation.desc',
      defaultMessage: "Combwork's Codex sessions get the MCP servers the workspace gives them, and Combwork turns off the ones in your own Codex config and the project's (enabled=false, for those sessions only). Turned off, those load beside the workspace's too, as they would outside Combwork. Combwork's own combwork server always wins over one of yours with that name.",
      description: 'What the advanced setting "Only the workspace\'s MCP servers" does (Settings → Advanced, under Codex). enabled=false is a config value: keep it. combwork is the name of Combwork\'s MCP server.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/mcp-list-codex-0.163.0-disabled.json`, version: '0.163.0', text: '"enabled": false', shows: "Codex listing a server of its own config turned off for one launch (-c mcp_servers.<name>.enabled=false)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.hooks.knownEvents',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.knownEvents.title', defaultMessage: 'Hooks: known events', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.hooks.knownEvents.desc', defaultMessage: "The hook events Combwork knows Codex sends. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook named outside this list saves a capture of the agent's recent events.", description: 'What the advanced setting "Hooks: known events" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Interrupt', 'Stop', 'PreCompact', 'PostCompact', 'SessionEnd'], // i18n-ignore: a CLI's hook event names (#698)
    max: 20,
    applies: 'now',
    samples: [{ from: `${FIX}/turns-codex-0.162.1.json`, version: '0.162.1', text: '"hook_event_name": "SessionStart"' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.hooks.knownFields',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.knownFields.title', defaultMessage: 'Hooks: known fields', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.hooks.knownFields.desc', defaultMessage: "The top-level fields Combwork knows Codex sends in its hooks. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook with a field outside this list saves a capture of the agent's recent events: often the first sign that a Codex update changed something. Add a field here once you know it is harmless.", description: 'What the advanced setting "Hooks: known fields" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['hook_event_name', 'hookEventName', 'session_id', 'sessionId', 'transcript_path', 'transcriptPath', 'cwd', 'permission_mode', 'permissionMode', 'tool_name', 'toolName', 'tool_use_id', 'toolUseId', 'source', 'trigger', 'matcher', 'notification_type', 'model', 'agent_type', 'turn_id', 'timestamp', 'tool_input', 'prompt', 'tool_response', 'stop_hook_active', 'last_assistant_message', 'message', 'reason', 'error'],
    max: 80,
    applies: 'now',
    samples: [{ from: `${FIX}/turns-codex-0.162.1.json`, version: '0.162.1', fields: ['hook_event_name', 'permission_mode', 'session_id', 'tool_input', 'tool_name', 'tool_use_id', 'turn_id'] }, { from: `${FIX}/turns-codex-0.162.1.json`, version: '0.162.1', fields: ['hook_event_name', 'last_assistant_message', 'permission_mode', 'session_id', 'stop_hook_active', 'turn_id'] }]
  }
]

/** The address Combwork checks for its connection (a value of Combwork's own, listed under Combwork: HI-1612). */
// agent-text: OUTAGE_CHECK (Settings → Advanced's title and description, which agents read too: the settings tools, HI-2441)
export const OUTAGE_CHECK: AdvancedSource = {
  id: outageCheckUrlId('codex'),
  group: 'cw',
  title: msg({ id: 'settings.advanced.cw.outage.checkUrl.codex.title', defaultMessage: 'Resuming after a connection drops: address checked for Codex', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. Codex is a product name." }),
  desc: msg({ id: 'settings.advanced.cw.outage.checkUrl.codex.desc', defaultMessage: "The address Combwork asks to see whether Codex's connection is back: its API host. Any reply counts, an error page too.", description: 'What the advanced setting "Resuming after a connection drops: address checked for Codex" does (Settings → Advanced).' }),
  kind: 'text',
  default: 'https://chatgpt.com',
  applies: 'now'
}
