import { FIXTURES as FIX, withValues, outagePatternId, overrideId, rightClickToCliId, outageCheckUrlId, type AdvancedSource, type AdvancedSample } from '../../advancedDef'
import { msg } from '../../i18n/msg'
import { COPILOT_FOOTER_MODES } from './footer'

/** A recording of it taking Combwork's hooks (configured with the default timeouts) and sending them. */
const HOOKS_TAKEN: AdvancedSample = { from: `${FIX}/console/copilot.json`, version: '1.0.105', text: '"name": "PreToolUse"', shows: "Copilot sending Combwork's hooks from its launch plugin, PreToolUse too" } // i18n-ignore: a CLI's recorded text (#367)
/** Its footer in each mode, from screens recorded in it (#696). */
const FOOTER_SAMPLES: Record<string, AdvancedSample> = {
  'copilot.ask': { from: `${FIX}/advanced/ready-copilot-1.0.95.txt`, version: '1.0.95', text: '· Interactive · Manual Approval ·' }, // i18n-ignore: a CLI's recorded text (#367)
  'copilot.allowAll': { from: `${FIX}/advanced/footer-copilot-1.0.95-allow-all.txt`, version: '1.0.95', text: '· Interactive · Allow All ·' }, // i18n-ignore: a CLI's recorded text (#367)
  'copilot.plan': { from: `${FIX}/advanced/footer-copilot-1.0.95-plan.txt`, version: '1.0.95', text: '· Plan · Manual Approval ·' }, // i18n-ignore: a CLI's recorded text (#367)
  'copilot.autopilot': { from: `${FIX}/advanced/footer-copilot-1.0.95-autopilot.txt`, version: '1.0.95', text: '· Autopilot · Manual Approval ·' } // i18n-ignore: a CLI's recorded text (#367)
}
// The plan's limits as it records them (HI-2734): a Copilot 1.0.93 quota snapshot's fields.
const COPILOT_QUOTA = ['entitlementRequests', 'isUnlimitedEntitlement', 'overage', 'overageAllowedWithExhaustedQuota', 'remainingPercentage', 'resetDate', 'usageAllowedWithExhaustedQuota', 'usedRequests'] // i18n-ignore: a CLI's field names (#367)
const COPILOT_QUOTA_FROM = `${FIX}/copilot/quota-snapshots-1.0.93.jsonl`

/** GitHub Copilot's advanced values (#367), in the order Settings lists them: advanced.ts gathers them through the registry (HI-3201). */
// agent-text: ADVANCED (Settings → Advanced's titles and descriptions, which agents read too: the settings tools, HI-2441)
export const ADVANCED: readonly AdvancedSource[] = [
  // GitHub Copilot
  {
    id: 'copilot.trust.prompt',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.trust.prompt.title', defaultMessage: 'Trust question', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.trust.prompt.desc', defaultMessage: "Copilot's question before a folder's first session. Combwork shows the agent as waiting for you while it is on screen.", description: 'What the advanced setting "Trust question" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`Do you trust the files in this folder\?`,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/trust-copilot-1.0.95.txt`, version: '1.0.95', text: 'Do you trust the files in this folder?' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.ready.footer',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.ready.footer.title', defaultMessage: 'Ready footer', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.ready.footer.desc', defaultMessage: 'Copilot only says it has started with the first prompt, so Combwork takes its footer on screen to mean it is ready.', description: 'What the advanced setting "Ready footer" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`· \/ commands ·`,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/ready-copilot-1.0.95.txt`, version: '1.0.95', text: '← open sidebar · Interactive · Manual Approval · / commands · ? help' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Its turn's state in the terminal (HI-2802): read only while its hooks are missing.
  {
    id: 'copilot.terminal.turn',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.terminal.turn.title', defaultMessage: 'Turn state in the terminal', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.terminal.turn.desc', defaultMessage: "What Copilot writes to its terminal (an OSC sequence, without its ESC ]) as a turn starts and ends; the first group is the state (working, done). Combwork reads it only while an agent's hooks aren't arriving, to show it working or finished; wrong, such an agent shows only that its status is unknown.", description: 'What the advanced setting "Turn state in the terminal" is for, and what goes wrong when it is wrong (Settings → Advanced). "OSC sequence" and "ESC ]" are terminal terms: keep them.' }),
    kind: 'pattern',
    default: String.raw`^7501;state=(\w+)`,
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/terminal-turn-copilot-1.0.106.json`, version: '1.0.106', text: '7501;state=working:app=copilot' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/terminal-turn-copilot-1.0.106.json`, version: '1.0.106', text: '7501;state=done:app=copilot' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  ...COPILOT_FOOTER_MODES.map(
    (m): AdvancedSource => ({
      id: `copilot.footer.${m.key}`,
      group: 'copilot',
      title: withValues(msg({ id: 'settings.advanced.copilotFooter.title', defaultMessage: 'Footer: {mode}', description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): the footer Copilot shows in a mode. {mode} is the mode's name." }), { mode: m.label }),
      desc: withValues(
        msg({
          id: 'settings.advanced.copilotFooter.desc',
          defaultMessage:
            "Copilot's footer in the {mode} mode (\"{footer}\"){shared, select, yes {, which Ask and Accept edits share (Combwork tells them apart by the mode the session started in)} other {}}. Combwork reads an agent's mode from its footer (the mode found last on screen), and switches modes by pressing Shift+Tab until the footer shows the one wanted; wrong, Combwork doesn't see the agent in that mode, and can't switch to it without a restart.",
          description: "What the advanced setting is for (Settings → Advanced, under GitHub Copilot). {mode} is a mode's name; {footer} is Copilot's own footer text, in English: keep it as it is. {shared} is yes for the footer two modes share."
        }),
        { mode: m.label, footer: FOOTER_SAMPLES[`copilot.${m.key}`].text ?? '', shared: m.mode === 'ask' ? 'yes' : 'no' }
      ),
      kind: 'pattern',
      default: m.pattern,
      applies: 'now',
      samples: [FOOTER_SAMPLES[`copilot.${m.key}`]]
    })
  ),
  {
    id: 'copilot.signIn.errorType',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.signIn.errorType.title', defaultMessage: 'Sign-in refused: error type', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.signIn.errorType.desc', defaultMessage: "A session error's type, in Copilot's session file, that means its sign-in was refused or is missing (#309): Combwork shows the agent signed out.", description: 'What the advanced setting "Sign-in refused: error type" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: '^auth',
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/signin-error-copilot-1.0.95.jsonl`, version: '1.0.95', text: 'authentication' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A turn that failed (HI-1960): Copilot 1.0.105 gives up on a model call with a session.error of this type and no
  // Stop (each ErrorOccurred hook of its retries says recoverable, the last too).
  {
    id: 'copilot.turnFailed.errorType',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.turnFailed.errorType.title', defaultMessage: 'Turn failed: error type', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.turnFailed.errorType.desc', defaultMessage: "A session error's type, in Copilot's session file, that means its turn ended because a model call failed after Copilot's retries (it sends no Stop then): Combwork ends the turn as failed, with Copilot's message. Wrong, such an agent shows working until you look.", description: 'What the advanced setting "Turn failed: error type" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    // rate_limit (HI-1973): a turn refused as too many requests (429) after its retries ends with that type.
    default: '^(query|rate_limit)$',
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/connection-error-copilot-1.0.105.jsonl`, version: '1.0.105', text: 'query' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/rate-limit-copilot-1.0.105.jsonl`, version: '1.0.105', text: 'rate_limit' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  // Copilot's plan limits (HI-2734, providers/copilot/quota.ts): a model call's quota snapshots in its session file.
  {
    id: 'copilot.quota.event',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.quota.event.title', defaultMessage: 'Plan limits: event', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.quota.event.desc', defaultMessage: "The event, in Copilot's session file, of a model call that carries your plan's quotas. Wrong, Combwork shows no plan limits for Copilot.", description: 'What the advanced setting "Plan limits: event" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'model.model_call_success',
    applies: 'now',
    samples: [{ from: COPILOT_QUOTA_FROM, version: '1.0.93', text: 'model.model_call_success' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.quota.snapshotsField',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.quota.snapshotsField.title', defaultMessage: 'Plan limits: quotas field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.quota.snapshotsField.desc', defaultMessage: "That event's field with your plan's quotas, one per kind of request. Wrong, Combwork shows no plan limits for Copilot.", description: 'What the advanced setting "Plan limits: quotas field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'quotaSnapshots',
    applies: 'now',
    samples: [{ from: COPILOT_QUOTA_FROM, version: '1.0.93', fields: ['quotaSnapshots'] }]
  },
  {
    id: 'copilot.quota.premiumKey',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.quota.premiumKey.title', defaultMessage: 'Plan limits: premium requests', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.quota.premiumKey.desc', defaultMessage: "The quota of premium requests among them. Wrong, that limit shows by Copilot's own name for it.", description: 'What the advanced setting "Plan limits: premium requests" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'premium_interactions',
    applies: 'now',
    samples: [{ from: COPILOT_QUOTA_FROM, version: '1.0.93', text: 'premium_interactions' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  ...([
    ['entitlementField', 'entitlementRequests', msg({ id: 'settings.advanced.copilot.quota.entitlementField.title', defaultMessage: 'Plan limits: allowance field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }), msg({ id: 'settings.advanced.copilot.quota.entitlementField.desc', defaultMessage: "A quota's field with how much your plan allows (-1: unlimited). Wrong, Combwork shows no plan limits for Copilot.", description: 'What the advanced setting "Plan limits: allowance field" is for, and what goes wrong when it is wrong (Settings → Advanced).' })],
    ['usedField', 'usedRequests', msg({ id: 'settings.advanced.copilot.quota.usedField.title', defaultMessage: 'Plan limits: used field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }), msg({ id: 'settings.advanced.copilot.quota.usedField.desc', defaultMessage: "A quota's field with how much of it is used. Wrong, Copilot's limits don't say how many were used.", description: 'What the advanced setting "Plan limits: used field" is for, and what goes wrong when it is wrong (Settings → Advanced).' })],
    ['remainingPercentField', 'remainingPercentage', msg({ id: 'settings.advanced.copilot.quota.remainingPercentField.title', defaultMessage: 'Plan limits: percent left field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }), msg({ id: 'settings.advanced.copilot.quota.remainingPercentField.desc', defaultMessage: "A quota's field with the percent of it left. Wrong, Combwork shows no plan limits for Copilot.", description: 'What the advanced setting "Plan limits: percent left field" is for, and what goes wrong when it is wrong (Settings → Advanced).' })],
    ['unlimitedField', 'isUnlimitedEntitlement', msg({ id: 'settings.advanced.copilot.quota.unlimitedField.title', defaultMessage: 'Plan limits: unlimited field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }), msg({ id: 'settings.advanced.copilot.quota.unlimitedField.desc', defaultMessage: "A quota's field that is true when your plan has no limit on it. Wrong, an unlimited quota isn't shown as unlimited.", description: 'What the advanced setting "Plan limits: unlimited field" is for, and what goes wrong when it is wrong (Settings → Advanced).' })],
    ['resetField', 'resetDate', msg({ id: 'settings.advanced.copilot.quota.resetField.title', defaultMessage: 'Plan limits: reset date field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }), msg({ id: 'settings.advanced.copilot.quota.resetField.desc', defaultMessage: "A quota's field with when it resets. Wrong, Copilot's plan limits show no reset date.", description: 'What the advanced setting "Plan limits: reset date field" is for, and what goes wrong when it is wrong (Settings → Advanced).' })]
  ] as const).map(([name, field, title, desc]): AdvancedSource => ({ id: `copilot.quota.${name}`, group: 'copilot', title, desc, kind: 'field', default: field, applies: 'now', samples: [{ from: COPILOT_QUOTA_FROM, version: '1.0.93', fields: [...COPILOT_QUOTA] }] })),
  // Copilot trying a failed model call again (HI-1973): an ErrorOccurred hook that says recoverable, for each try.
  {
    id: 'copilot.retry.context',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.retry.context.title', defaultMessage: 'Retry: error context', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. A retry: the coding agent trying its model request again after it failed." }),
    desc: msg({ id: 'settings.advanced.copilot.retry.context.desc', defaultMessage: "Where Copilot's error hook says a recoverable error happened when it is a model call it tries again (rate-limited, or the service unreachable). Combwork shows the agent's status as waiting to retry until Copilot goes on. Wrong, a waiting agent just shows Working.", description: 'What the advanced setting "Retry: error context" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: '^model_call$',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/errorhooks-copilot-1.0.105.json`, version: '1.0.105', text: 'model_call' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.retry.message',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.retry.message.title', defaultMessage: 'Retry: error message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.retry.message.desc', defaultMessage: "How that hook words why the call failed: a regular expression whose named group status is the HTTP status that refused it, whose group limited matches the words of a rate limit (429), or whose group network matches when the service couldn't be reached. Copilot's hook gives the service's own error, often with no status. Wrong, the wait shows without its reason.", description: 'What the advanced setting "Retry: error message" is for, and what goes wrong when it is wrong (Settings → Advanced). status, limited and network are the names of the regular expression\'s groups: keep them.' }),
    kind: 'pattern',
    default: String.raw`(?<network>ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|tcp connect error|dns error)|(?<limited>rate[ _-]?limit|too many requests)|(?:^|[^\d.])(?<status>[1-5]\d\d)(?=\s)`,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/errorhooks-copilot-1.0.105.json`, version: '1.0.105', text: 'tcp connect error' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/retry-hooks-copilot-1.0.105.json`, version: '1.0.105', text: 'Rate limit reached for requests' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'copilot.signIn.errorMessage',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.signIn.errorMessage.title', defaultMessage: 'Sign-in refused: error message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.signIn.errorMessage.desc', defaultMessage: "A session error's message, in Copilot's session file, that means its sign-in was refused, when its type doesn't say so.", description: 'What the advanced setting "Sign-in refused: error message" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`please use \/login|sign in to use copilot|not (?:signed|logged) in|\b401\b|bad credentials`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/signin-error-copilot-1.0.95.jsonl`, version: '1.0.95', text: 'Authentication failed with provider at http://127.0.0.1:50713/v1 (HTTP 401).' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.signIn.hookMessage',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.signIn.hookMessage.title', defaultMessage: 'Sign-in refused: ErrorOccurred hook', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.signIn.hookMessage.desc', defaultMessage: "The message of Copilot's ErrorOccurred hook that means a model call was refused for the sign-in: the turn ends signed out. Another error that ends the turn ends it as failed.", description: 'What the advanced setting "Sign-in refused: ErrorOccurred hook" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`\b401\b|unauthori[sz]ed|bad credentials|not (logged|signed) in|\/login|token (has )?expired`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/signin-error-copilot-1.0.95.jsonl`, version: '1.0.95', text: 'Authentication failed with provider at http://127.0.0.1:50713/v1 (HTTP 401).' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A question's text (HI-1945): from 1.0.104 the question's Notification says only "Information requested", so Combwork
  // takes the question from the asking tool's PreToolUse.
  {
    id: 'copilot.question.tool',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.question.tool.title', defaultMessage: 'Question: tool name', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.question.tool.desc', defaultMessage: "The name Copilot's hooks give its tool that asks you a question. Combwork shows that tool's question while the agent waits for your answer; when it doesn't match, the agent shows only Copilot's own notice.", description: 'What the advanced setting "Question: tool name" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: '^(ask_user|AskUserQuestion)$',
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/question-copilot-1.0.105.jsonl`, version: '1.0.105', text: 'AskUserQuestion' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.question.field',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.question.field.title', defaultMessage: 'Question: text field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.question.field.desc', defaultMessage: "The field of the question tool's input, in Copilot's hooks, with the question's text. When it is wrong, the agent shows only Copilot's own notice while it waits for your answer.", description: 'What the advanced setting "Question: text field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'message',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/question-copilot-1.0.105.jsonl`, version: '1.0.105', fields: ['message', 'requestedSchema'] }]
  },
  // A turn its connection's failure ended (HI-1612): its error's message, after Copilot's own retries.
  {
    id: outagePatternId('copilot'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.outage.connectionError.title', defaultMessage: 'Connection dropped: error message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.outage.connectionError.desc', defaultMessage: "What Copilot's error says when it couldn't reach its model's API after its retries: with Resume agents after a connection drops on, Combwork waits for the connection and resumes the agent. Wrong, such agents stay stopped.", description: 'What the advanced setting "Connection dropped: error message" is for, and what goes wrong when it is wrong (Settings → Advanced). Resume agents after a connection drops is the title of another advanced setting.' }),
    kind: 'pattern',
    default: String.raw`\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b|error sending request|Could not connect to|dns error`,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/connection-error-copilot-1.0.105.jsonl`, version: '1.0.105', text: 'error resolving DNS: No such host is known. (os error 11001) [ENOTFOUND]' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/connection-error-copilot-1.0.105.jsonl`, version: '1.0.105', text: 'Could not connect to local model provider at http://127.0.0.1:50000/v1.' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  // A compaction's context before and after (#454): the three parts Copilot counts it in, in its compaction_start and
  // compaction_complete events, added up.
  {
    id: 'copilot.compaction.systemTokens',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.compaction.systemTokens.title', defaultMessage: 'Compaction: system prompt tokens field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.compaction.systemTokens.desc', defaultMessage: "The field of a compaction's start and end, in Copilot's session file, with the system prompt's tokens: one of the three parts of the context before and after it, in usage and the Sessions tab.", description: 'What the advanced setting "Compaction: system prompt tokens field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'systemTokens',
    applies: 'now',
    samples: [{ from: `${FIX}/copilot/compaction-1.0.98.jsonl`, version: '1.0.98', fields: ['systemTokens', 'conversationTokens', 'toolDefinitionsTokens', 'currentTokens', 'tokenLimit', 'trigger'] }]
  },
  {
    id: 'copilot.compaction.conversationTokens',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.compaction.conversationTokens.title', defaultMessage: 'Compaction: conversation tokens field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.compaction.conversationTokens.desc', defaultMessage: "The field of a compaction's start and end, in Copilot's session file, with the conversation's tokens: one of the three parts of the context before and after it, in usage and the Sessions tab.", description: 'What the advanced setting "Compaction: conversation tokens field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'conversationTokens',
    applies: 'now',
    samples: [{ from: `${FIX}/copilot/compaction-1.0.98.jsonl`, version: '1.0.98', fields: ['systemTokens', 'conversationTokens', 'toolDefinitionsTokens', 'currentTokens', 'tokenLimit', 'trigger'] }]
  },
  {
    id: 'copilot.compaction.toolTokens',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.compaction.toolTokens.title', defaultMessage: 'Compaction: tool definition tokens field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.compaction.toolTokens.desc', defaultMessage: "The field of a compaction's start and end, in Copilot's session file, with the tool definitions' tokens: one of the three parts of the context before and after it, in usage and the Sessions tab.", description: 'What the advanced setting "Compaction: tool definition tokens field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'toolDefinitionsTokens',
    applies: 'now',
    samples: [{ from: `${FIX}/copilot/compaction-1.0.98.jsonl`, version: '1.0.98', fields: ['systemTokens', 'conversationTokens', 'toolDefinitionsTokens', 'currentTokens', 'tokenLimit', 'trigger'] }]
  },
  {
    id: 'copilot.compaction.summary',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.compaction.summary.title', defaultMessage: 'Compaction: summary field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.compaction.summary.desc', defaultMessage: "The field of a compaction's end, in Copilot's session file, with the summary it carries on from: the Sessions tab shows it with the compaction.", description: 'What the advanced setting "Compaction: summary field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'summaryContent',
    applies: 'now',
    samples: [{ from: `${FIX}/copilot/compaction-1.0.98.jsonl`, version: '1.0.98', fields: ['success', 'preCompactionTokens', 'postCompactionTokens', 'preCompactionMessagesLength', 'messagesRemoved', 'tokensRemoved', 'summaryContent', 'behaviorModelId', 'compactionTokensUsed', 'systemTokens', 'conversationTokens', 'toolDefinitionsTokens', 'tokenLimit', 'trigger', 'checkpointNumber', 'checkpointPath'] }]
  },
  {
    id: 'copilot.hooks.timeoutSeconds',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.hooks.timeoutSeconds.title', defaultMessage: 'Hooks: timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.hooks.timeoutSeconds.desc', defaultMessage: 'How long Copilot waits for Combwork to take one of its hooks.', description: 'What the advanced setting "Hooks: timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 5,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN]
  },
  {
    id: 'copilot.hooks.preToolUseTimeoutSeconds',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.hooks.preToolUseTimeoutSeconds.title', defaultMessage: 'Hooks: before a tool, timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.hooks.preToolUseTimeoutSeconds.desc', defaultMessage: "How long Copilot waits for Combwork's answer before a tool runs (an edit waits for a file lock). If Combwork doesn't answer in time, the tool goes ahead.", description: 'What the advanced setting "Hooks: before a tool, timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN]
  },
  {
    id: 'copilot.exit.graceSeconds',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.exit.graceSeconds.title', defaultMessage: 'Stop: exit grace', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: withValues(msg({ id: 'settings.advanced.copilot.exit.graceSeconds.desc', defaultMessage: "When Combwork stops Copilot (Stop, Restart, closing a project or quitting), how long it gives Copilot to exit by itself after its Ctrl+C before killing it. Copilot writes the session's token totals only as it exits by itself: one killed first loses them. It took up to {took, plural, one {# second} other {# seconds}} on a busy machine (#716); quitting Combwork or closing a workspace waits up to this long, and a second more, for a Copilot that hangs.", description: 'What the advanced setting "Stop: exit grace" is for, and what goes wrong when it is wrong (Settings → Advanced). {took} is the longest Copilot was seen to take, in seconds (2.4).' }), { took: 2.4 }),
    kind: 'number',
    default: 10,
    min: 3,
    max: 60,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/console/copilot.json`, version: '1.0.105', text: '"type": "session.shutdown"', shows: "Copilot stopped by Combwork, writing its token totals (session.shutdown) and exiting by itself (exit code 0)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.exit.armed',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.exit.armed.title', defaultMessage: 'Stop: exit hint', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.exit.armed.desc', defaultMessage: 'What Copilot shows after one Ctrl+C at its prompt, meaning the next one exits. When Combwork stops Copilot, it presses Ctrl+C again once this shows. If it no longer matches, Combwork keeps pressing Ctrl+C until Copilot exits, which takes longer.', description: 'What the advanced setting "Stop: exit hint" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`ctrl\+c again to exit`,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/exit-armed-copilot-1.0.105.txt`, version: '1.0.105', text: 'ctrl+c again to exit' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Terminals behave the same in every pane (#737): right-click is Combwork's, and this hands it to Copilot instead.
  {
    id: rightClickToCliId('copilot'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.mouse.rightClickToCli.title', defaultMessage: 'Pass right-click to Copilot', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({
      id: 'settings.advanced.copilot.mouse.rightClickToCli.desc',
      defaultMessage: "Right-click in a Copilot pane is Combwork's, as in every pane: it copies the terminal's selection (Shift+drag), or pastes. Turned on, Combwork passes right-clicks to Copilot instead, which copies its own selection (a drag) with them, as its footer says.",
      description: 'What the advanced setting "Pass right-click to Copilot" is for (Settings → Advanced, under GitHub Copilot). Shift+drag names a key and a mouse action: use the key names your language uses.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/mouse-copilot-1.0.95.json`, version: '1.0.95', text: '"mouseTracking": "?1003h ?1006h"', shows: 'Copilot turning on mouse tracking as Combwork starts it (without --no-mouse), which a passed right-click reaches' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('copilot', 'noAutoUpdate'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.noAutoUpdate.title', defaultMessage: "Don't let Copilot update itself", description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.noAutoUpdate.desc',
      defaultMessage: "Combwork starts Copilot with --no-auto-update and COPILOT_AUTO_UPDATE=false (its sessions, and checking its sign-in and models), so it runs the version installed and a download never changes it between a session's restarts; Update in Provider Setup updates it when you choose. Turned off, Combwork sets neither and Copilot updates itself as it would outside Combwork (your own COPILOT_AUTO_UPDATE still applies).",
      description: 'What the advanced setting "Don\'t let Copilot update itself" does (Settings → Advanced, under GitHub Copilot). --no-auto-update is a command-line option and COPILOT_AUTO_UPDATE=false an environment variable: keep them. Update is a button\'s name and Provider Setup a dialog\'s.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [
      { from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: '--no-auto-update', shows: "Copilot's help for the flag Combwork passes" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: '`COPILOT_AUTO_UPDATE`: set to "false"', shows: "Copilot's help for the variable Combwork sets" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: overrideId('copilot', 'allMcpInstructions'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.allMcpInstructions.title', defaultMessage: "Include every MCP server's instructions", description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Combwork's overrides of the CLI, on by default. MCP is a protocol's name." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.allMcpInstructions.desc',
      defaultMessage: "Combwork starts Copilot with --allow-all-mcp-server-instructions, so Copilot puts the combwork server's instructions (Combwork's guidance for agents) in its system prompt, and the instructions of the other servers its agents get too. Turned off, Copilot includes only the servers it allows by itself, and Combwork gives its guidance as custom instructions instead.",
      description: 'What the advanced setting "Include every MCP server\'s instructions" does (Settings → Advanced, under GitHub Copilot). --allow-all-mcp-server-instructions is a command-line option: keep it. combwork is the name of Combwork\'s MCP server.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: '--allow-all-mcp-server-instructions', shows: "Copilot's help for the flag Combwork passes" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('copilot', 'mcpIsolation'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.mcpIsolation.title', defaultMessage: "Only the workspace's MCP servers", description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Combwork's overrides of the CLI, on by default. MCP is a protocol's name." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.mcpIsolation.desc',
      defaultMessage: "Combwork starts Copilot with --disable-builtin-mcps, and --disable-mcp-server for each server in your own Copilot config and the project's, so its sessions get only the MCP servers the workspace gives them. Turned off, those and Copilot's built-in GitHub servers load beside them, as they would outside Combwork. The workspace's servers, Combwork's own combwork server among them, win over yours of the same name.",
      description: 'What the advanced setting "Only the workspace\'s MCP servers" does (Settings → Advanced, under GitHub Copilot). --disable-builtin-mcps and --disable-mcp-server are command-line options: keep them. combwork is the name of Combwork\'s MCP server.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [
      { from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: 'Disable all built-in MCP servers (currently:', shows: "Copilot's help for the flag Combwork passes" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: 'Disable a specific MCP server (can be used multiple times)', shows: "Copilot's help for the flag Combwork passes for each of the user's servers" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: overrideId('copilot', 'preApproveCombworkTools'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.preApproveCombworkTools.title', defaultMessage: "Pre-approve Combwork's tools", description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.preApproveCombworkTools.desc',
      defaultMessage: "Combwork starts Copilot with --allow-tool for Combwork's tools (for the Assistant, only those its Control settings let it use without asking), so Copilot doesn't ask before them in any mode. Turned off, Copilot asks before them as its own permission mode says. What an agent or the Assistant may do with them is still decided by Combwork.",
      description: 'What the advanced setting "Pre-approve Combwork\'s tools" does (Settings → Advanced, under GitHub Copilot). --allow-tool is a command-line option: keep it. Control is the name of the Assistant\'s settings page.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: 'Tools the CLI has permission to use; will not prompt for', shows: "Copilot's help for the flag Combwork pre-approves its tools with" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('copilot', 'stripGitHubTokens'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.stripGitHubTokens.title', defaultMessage: 'Keep GH_TOKEN and GITHUB_TOKEN from Copilot', description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Combwork's overrides of the CLI, on by default. GH_TOKEN and GITHUB_TOKEN are environment variables: keep them." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.stripGitHubTokens.desc',
      defaultMessage: "Combwork leaves GH_TOKEN and GITHUB_TOKEN, which other tools set, out of Copilot's environment, so a token left there never signs Copilot agents in to another account; COPILOT_GITHUB_TOKEN, set for Copilot, is kept. Turned off, Copilot gets them and signs in with them before its own login, as it would outside Combwork, and Provider Setup shows that sign-in.",
      description: 'What the advanced setting "Keep GH_TOKEN and GITHUB_TOKEN from Copilot" does (Settings → Advanced, under GitHub Copilot). GH_TOKEN, GITHUB_TOKEN and COPILOT_GITHUB_TOKEN are environment variables: keep them. Provider Setup is a dialog\'s name.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: '`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` (in order of precedence)', shows: "Copilot's help for the token variables it signs in with" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.hooks.knownEvents',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.hooks.knownEvents.title', defaultMessage: 'Hooks: known events', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.hooks.knownEvents.desc', defaultMessage: "The hook events Combwork knows GitHub Copilot sends. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook named outside this list saves a capture of the agent's recent events.", description: 'What the advanced setting "Hooks: known events" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'ErrorOccurred', 'PreCompact', 'SessionEnd'], // i18n-ignore: a CLI's hook event names (#698)
    max: 20,
    applies: 'now',
    samples: [{ from: `${FIX}/console/copilot.json`, version: '1.0.105', text: '"hook_event_name": "SessionEnd"' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.hooks.knownFields',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.hooks.knownFields.title', defaultMessage: 'Hooks: known fields', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.hooks.knownFields.desc', defaultMessage: "The top-level fields Combwork knows GitHub Copilot sends in its hooks. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook with a field outside this list saves a capture of the agent's recent events: often the first sign that a GitHub Copilot update changed something. Add a field here once you know it is harmless.", description: 'What the advanced setting "Hooks: known fields" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['hook_event_name', 'hookEventName', 'session_id', 'sessionId', 'transcript_path', 'transcriptPath', 'cwd', 'permission_mode', 'permissionMode', 'tool_name', 'toolName', 'tool_use_id', 'toolUseId', 'source', 'trigger', 'matcher', 'notification_type', 'model', 'agent_type', 'turn_id', 'timestamp', 'tool_input', 'prompt', 'initial_prompt', 'initialPrompt', 'toolInput', 'toolArgs', 'tool_result', 'toolResult', 'stop_hook_active', 'stop_reason', 'stopReason', 'reason', 'error', 'message', 'title', 'is_recoverable', 'recoverable'],
    max: 80,
    applies: 'now',
    samples: [{ from: `${FIX}/console/copilot.json`, version: '1.0.105', fields: ['cwd', 'hook_event_name', 'session_id', 'timestamp', 'tool_input', 'tool_name'] }, { from: `${FIX}/console/copilot.json`, version: '1.0.105', fields: ['cwd', 'hook_event_name', 'session_id', 'stop_hook_active', 'stop_reason', 'timestamp', 'transcript_path'] }]
  }
]

/** The address Combwork checks for its connection (a value of Combwork's own, listed under Combwork: HI-1612). */
// agent-text: OUTAGE_CHECK (Settings → Advanced's title and description, which agents read too: the settings tools, HI-2441)
export const OUTAGE_CHECK: AdvancedSource = {
  id: outageCheckUrlId('copilot'),
  group: 'cw',
  title: msg({ id: 'settings.advanced.cw.outage.checkUrl.copilot.title', defaultMessage: 'Resuming after a connection drops: address checked for GitHub Copilot', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. GitHub Copilot is a product name." }),
  desc: msg({ id: 'settings.advanced.cw.outage.checkUrl.copilot.desc', defaultMessage: "The address Combwork asks to see whether GitHub Copilot's connection is back: its API host. Any reply counts, an error page too.", description: 'What the advanced setting "Resuming after a connection drops: address checked for GitHub Copilot" does (Settings → Advanced).' }),
  kind: 'text',
  default: 'https://api.githubcopilot.com',
  applies: 'now'
}
