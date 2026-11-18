import { FIXTURES as FIX, withValues, outagePatternId, overrideId, rightClickToCliId, outageCheckUrlId, type AdvancedSource, type AdvancedSample, clearKeyWaitId } from '../../advancedDef'
import { msg } from '../../i18n/msg'
import { CLAUDE_SAFEGUARDS } from './safeguards'
import { CLAUDE_FOOTER_MODES } from './footer'

/** HI-2682: the model names Claude Code reads as its aliases, and the ID spellings it sizes itself (local-model limits). */
export const LOCAL_MODEL_ALIASES_ID = 'claude-code.localModel.aliases'
export const LOCAL_MODEL_SPELLINGS_ID = 'claude-code.localModel.spellings'
/** A recording of it taking Combwork's hooks (configured with the default timeouts) and sending them. */
const HOOKS_TAKEN: AdvancedSample = { from: `${FIX}/turns-claude-2.1.296.json`, version: '2.1.296', text: '"hook_event_name": "PreToolUse"', shows: "Claude Code sending Combwork's hooks, PreToolUse too" } // i18n-ignore: a CLI's recorded text (#367)
/** Its footer in each mode, from screens recorded in it (#696). */
const FOOTER_SAMPLES: Record<string, AdvancedSample> = {
  'claude-code.manual': { from: `${FIX}/screen-claude-2.1.296-idle.txt`, version: '2.1.296', text: '⏸ manual mode on · ? for shortcuts' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.acceptEdits': { from: `${FIX}/advanced/footer-claude-2.1.296-acceptEdits.txt`, version: '2.1.296', text: '⏵⏵ accept edits on (shift+tab to cycle)' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.plan': { from: `${FIX}/advanced/footer-claude-2.1.296-plan.txt`, version: '2.1.296', text: '⏸ plan mode on (shift+tab to cycle)' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.auto': { from: `${FIX}/screen-claude-2.1.296-auto-idle.txt`, version: '2.1.296', text: '⏵⏵ auto mode on (shift+tab to cycle)' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.bypassPermissions': { from: `${FIX}/advanced/footer-claude-2.1.296-bypassPermissions.txt`, version: '2.1.296', text: '⏵⏵ bypass permissions on (shift+tab to cycle)' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.dontAsk': { from: `${FIX}/advanced/footer-claude-2.1.296-dontAsk.txt`, version: '2.1.296', text: "⏵⏵ don't ask on (shift+tab to cycle)" } // i18n-ignore: a CLI's recorded text (#367)
}

/** Claude Code's advanced values (#367), in the order Settings lists them: advanced.ts gathers them through the registry (HI-3201). */
// agent-text: ADVANCED (Settings → Advanced's titles and descriptions, which agents read too: the settings tools, HI-2441)
export const ADVANCED: readonly AdvancedSource[] = [
  // Claude Code
  {
    id: 'claude-code.trust.prompt',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.trust.prompt.title', defaultMessage: 'Trust question', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.trust.prompt.desc', defaultMessage: "Claude Code's question before a folder's first session. Combwork shows the agent as waiting for you while it is on screen.", description: 'What the advanced setting "Trust question" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    // HI-3335: 2.1.326 also asks, before its session starts, about each folder it is given with --add-dir (a slot's
    // launch plugin, a reviewer's copies) outside every repository it trusts ("Adding a new directory:"); the answer holds
    // for that session only, so it asks at each launch. Its folder question reads as before.
    default: 'trust this folder|Adding a new directory:', // i18n-ignore: a CLI's recorded text (#367)
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/trust-claude-2.1.296.txt`, version: '2.1.296', text: 'Yes, I trust this folder' }, // i18n-ignore: a CLI's recorded text (#367)
      // HI-2004: with TERM=xterm-256color (no WT_SESSION) its pointer is ❯; with neither, >. The question reads the same.
      { from: `${FIX}/advanced/trust-term-claude-2.1.312.txt`, version: '2.1.312', text: '❯ No, exit\n   Yes, I trust this folder' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/trust-noterm-claude-2.1.312.txt`, version: '2.1.312', text: '> No, exit\n   Yes, I trust this folder' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/trust-added-claude-2.1.326.txt`, version: '2.1.326', text: 'Adding a new directory:' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/trust-added-repo-claude-2.1.326.txt`, version: '2.1.326', text: 'Adding a new directory:' } // i18n-ignore: a CLI's recorded text (#367)
    ] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.signIn.stopError',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.signIn.stopError.title', defaultMessage: 'Sign-in refused: StopFailure error', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.signIn.stopError.desc', defaultMessage: "The error a StopFailure hook names when Claude Code's sign-in was refused (expired, revoked, an invalid key): Combwork shows the agent signed out and offers to carry on once it's renewed (#309). Any other error ends the turn as failed.", description: 'What the advanced setting "Sign-in refused: StopFailure error" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'authentication_failed',
    applies: 'now',
    samples: [
      { from: `${FIX}/signin-claude-2.1.291.json`, version: '2.1.291', text: 'authentication_failed' }, // i18n-ignore: a CLI's recorded text (#367)
      // A server connection's key refused (HI-1772): after its retries, the same error; Combwork says the key was refused.
      { from: `${FIX}/advanced/stopfailure-server-401-claude-2.1.311.json`, version: '2.1.311', text: 'authentication_failed', shows: "A server connection's key refused (401), after Claude Code's 10 retries" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  // A turn its connection's failure ended (HI-1612): the StopFailure's message, after Claude Code's own retries.
  {
    id: outagePatternId('claude-code'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.outage.connectionError.title', defaultMessage: 'Connection dropped: StopFailure message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.outage.connectionError.desc', defaultMessage: "What a StopFailure hook's message says when Claude Code couldn't reach its API after its retries: with Resume agents after a connection drops on, Combwork waits for the connection and resumes the agent. Wrong, such agents stay stopped.", description: 'What the advanced setting "Connection dropped: StopFailure message" is for, and what goes wrong when it is wrong (Settings → Advanced). Resume agents after a connection drops is the title of another advanced setting.' }),
    kind: 'pattern',
    default: String.raw`\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b|Connection refused|Can't reach the API server|Connection error|Request timed out`,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/stopfailure-connection-claude-2.1.312.json`, version: '2.1.312', text: 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/stopfailure-connection-claude-2.1.312.json`, version: '2.1.312', text: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  // A lane's end (HI-1706): the command Combwork types to end Claude Code as a person would, and how long it waits for the exit.
  {
    id: 'claude-code.exit.command',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.exit.command.title', defaultMessage: "Lane's end: exit command", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.exit.command.desc', defaultMessage: "What Combwork types into Claude Code, then Enter, to end it once its lane has ended and its turn is over, so it exits by itself rather than being killed. Wrong, Claude Code isn't ended by it and is killed after the exit grace.", description: 'What the advanced setting "Lane\'s end: exit command" is for, and what goes wrong when it is wrong (Settings → Advanced). A lane is a card loop.' }),
    kind: 'text',
    default: '/exit',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/exit-claude-2.1.310.json`, version: '2.1.310', text: '"sent": "/exit"', shows: 'Claude Code exiting by itself (exit code 0) on /exit and Enter at its prompt' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.exit.graceSeconds',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.exit.graceSeconds.title', defaultMessage: "Lane's end: exit grace", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: withValues(msg({ id: 'settings.advanced.claude-code.exit.graceSeconds.desc', defaultMessage: "How long Combwork gives Claude Code to exit by itself after typing its exit command at a lane's end, before killing it. It took {took, plural, one {# second} other {# seconds}} when recorded.", description: 'What the advanced setting "Lane\'s end: exit grace" is for (Settings → Advanced). {took} is how long Claude Code took to exit when recorded, in seconds (1.9).' }), { took: 1.9 }),
    kind: 'number',
    default: 10,
    min: 3,
    max: 60,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/exit-claude-2.1.310.json`, version: '2.1.310', text: '"exitCode": 0', shows: 'Claude Code exiting by itself 1.9 s after /exit and Enter' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Accounts (HI-980): what Combwork reads from `claude auth status --json` in an account's folder, never a token.
  {
    id: 'claude-code.accounts.statusSeconds',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.statusSeconds.title', defaultMessage: 'Connections: sign-in check timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.statusSeconds.desc', defaultMessage: "How long Combwork gives `claude auth status` to say who a connection's folder is signed in as. Past it, the connection shows \"Couldn't check\", never signed out.", description: 'What the advanced setting "Connections: sign-in check timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status` as it is (a command).' }),
    kind: 'number',
    default: 30,
    min: 3,
    max: 120,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', text: '"loggedIn": true', shows: "Claude Code's sign-in status, as `claude auth status --json` gives it in an account's folder" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.accounts.loggedInField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.loggedInField.title', defaultMessage: 'Connections: signed-in field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.loggedInField.desc', defaultMessage: "The field of `claude auth status --json` that says whether a connection's folder is signed in. Wrong, Combwork can't tell, and its sign-in connections show \"Couldn't check\".", description: 'What the advanced setting "Connections: signed-in field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status --json` as it is (a command).' }),
    kind: 'field',
    default: 'loggedIn',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory', 'email', 'orgId', 'orgName', 'subscriptionType'] },
      { from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory'] }
    ]
  },
  {
    id: 'claude-code.accounts.emailField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.emailField.title', defaultMessage: 'Connections: email field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.emailField.desc', defaultMessage: "The field of `claude auth status --json` with the email a connection's folder is signed in as. Wrong, Combwork can't tell who a connection is signed in as, and can't warn when its login changes.", description: 'What the advanced setting "Connections: email field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status --json` as it is (a command).' }),
    kind: 'field',
    default: 'email',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory', 'email', 'orgId', 'orgName', 'subscriptionType'] }]
  },
  {
    id: 'claude-code.accounts.orgField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.orgField.title', defaultMessage: 'Connections: organisation field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.orgField.desc', defaultMessage: "The field of `claude auth status --json` with the organisation's id a connection's folder is signed in to. With the email, it tells two logins apart. Wrong, Combwork can't tell who a connection is signed in as.", description: 'What the advanced setting "Connections: organisation field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status --json` as it is (a command).' }),
    kind: 'field',
    default: 'orgId',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory', 'email', 'orgId', 'orgName', 'subscriptionType'] }]
  },
  {
    id: 'claude-code.accounts.planField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.planField.title', defaultMessage: 'Connections: plan field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.planField.desc', defaultMessage: "The field of `claude auth status --json` with a connection's plan (\"max\"), shown beside its email in Settings → Accounts & Connections. Wrong, no plan is shown.", description: 'What the advanced setting "Connections: plan field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status --json` and "max" as they are.' }),
    kind: 'field',
    default: 'subscriptionType',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory', 'email', 'orgId', 'orgName', 'subscriptionType'] }]
  },
  {
    id: 'claude-code.accounts.loginExpiresField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.loginExpiresField.title', defaultMessage: 'Connections: sign-in expiry field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.loginExpiresField.desc', defaultMessage: "The field of `claude auth status --json` with when a connection's sign-in expires, shown under its state in Settings → Accounts & Connections (HI-2528). Wrong, no expiry is shown.", description: 'What the advanced setting "Connections: sign-in expiry field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status --json` as it is.' }),
    kind: 'field',
    default: 'loginExpiresAt',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/auth-status-claude-2.1.318.jsonl`, version: '2.1.318', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory', 'loginExpiresAt', 'email', 'orgId', 'orgName', 'subscriptionType'] }]
  },
  {
    id: 'claude-code.accounts.onboardedField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.onboardedField.title', defaultMessage: 'Connections: set-up field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.onboardedField.desc', defaultMessage: "The field of a connection folder's `.claude.json` that says Claude Code's first-run screens were answered there (read only). Wrong, every Claude Code connection shows \"Needs set up\" in Settings → Accounts & Connections.", description: 'What the advanced setting "Connections: set-up field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `.claude.json` as it is (a file name); "Needs set up" is a state Combwork shows: use its name as Combwork shows it.' }),
    kind: 'field',
    default: 'hasCompletedOnboarding',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/onboarding-claude-2.1.311.jsonl`, version: '2.1.311', fields: ['additionalModelCostsCache', 'additionalModelOptionsAnsweredAt', 'additionalModelOptionsCache', 'announcementImpressions', 'apiCreditLinkStatusCache', 'autoCompactWindowsCache', 'autoUpdates', 'autoUpdatesProtectedForNative', 'cachedArtifactRoster', 'cachedExperimentData', 'cachedExperimentFeatures', 'cachedExtraUsageDisabledReason', 'cachedGrowthBookFeatures', 'cachedGrowthBookFeaturesAt', 'changelogLastFetched', 'claudeAiMcpEverConnected', 'claudeCodeFirstTokenDate', 'clientDataCacheSlots', 'closedIssuesLastChecked', 'firstStartTime', 'firstStartVersion', 'fullscreenAutoDisabled', 'groveChoiceSeenAt', 'groveConfigCache', 'hasCompletedOnboarding', 'hasResetAutoModeOptInForDefaultOffer', 'hasSeenAutoDefaultNotice', 'hasSeenAutoModeEntryWarning', 'hasVisitedPasses', 'installMethod', 'lastClawdEntranceVersion', 'lastOnboardingVersion', 'lastReleaseNotesSeen', 'machineID', 'migrationVersion', 'modelAccessCache', 'numStartups', 'oauthAccount', 'officialMarketplaceAutoInstallAttempted', 'officialMarketplaceAutoInstalled', 'opusProMigrationComplete', 'orgModelDefaultCache', 'passesEligibilityCache', 'passesLastSeenRemaining', 'passesUpsellSeenCount', 'pluginUsage', 'projects', 'promoStartupSeenCount', 'promoStartupStatusCache', 'promptQueueUseCount', 'seenNotifications', 'skillUsage', 'sonnet1m45MigrationComplete', 'tipLifetimeShownCounts', 'tipsHistory', 'tipsHistoryByCommand', 'userID'] }]
  },
  {
    id: 'claude-code.accounts.trustField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.trustField.title', defaultMessage: 'Connections: trusted folder field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.trustField.desc', defaultMessage: "The field of a folder's entry under `projects` in a connection folder's `.claude.json` that says Claude Code was told to trust that folder (read only). Wrong, every Claude Code connection on in a workspace shows \"Needs set up\" in Settings → Accounts & Connections.", description: 'What the advanced setting "Connections: trusted folder field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `projects` and `.claude.json` as they are; "Needs set up" is a state Combwork shows: use its name as Combwork shows it.' }),
    kind: 'field',
    default: 'hasTrustDialogAccepted',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/trust-entry-claude-2.1.311.json`, version: '2.1.311', fields: ['allowedTools', 'disabledMcpjsonServers', 'enabledMcpjsonServers', 'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown', 'hasTrustDialogAccepted', 'lastAPIDuration', 'lastAPIDurationWithoutRetries', 'lastCost', 'lastDuration', 'lastFpsAverage', 'lastFpsLow1Pct', 'lastGracefulShutdown', 'lastLinesAdded', 'lastLinesRemoved', 'lastModelUsage', 'lastSessionId', 'lastSessionMetrics', 'lastStartTime', 'lastToolDuration', 'lastTotalCacheCreationInputTokens', 'lastTotalCacheReadInputTokens', 'lastTotalInputTokens', 'lastTotalOutputTokens', 'lastTotalWebSearchRequests', 'lastVersionBase', 'mcpContextUris', 'mcpServers'] }]
  },
  {
    id: 'claude-code.accounts.loginFiles',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.loginFiles.title', defaultMessage: 'Connections: login files', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.loginFiles.desc', defaultMessage: "The names of the files in a connection's folder that change when Claude Code signs in or out there, as a regular expression. Combwork watches them (it never reads them) and checks the connection again when one changes. Wrong, a /login or /logout typed in an agent's pane is only found at the connection's next check.", description: 'What the advanced setting "Connections: login files" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep /login and /logout as they are (commands).' }),
    kind: 'pattern',
    default: String.raw`^\.(claude|credentials)\.json(\.tmp\.|$)`,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/home-claude-2.1.310.txt`, version: '2.1.310', text: '.claude.json', shows: "The account's identity file at the top of a signed-in Claude Code home" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/home-claude-2.1.310.txt`, version: '2.1.310', text: '.credentials.json', shows: "The login file at the top of a signed-in Claude Code home (its contents never read)" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'claude-code.accounts.dropEnv',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.dropEnv.title', defaultMessage: 'Connections: sign-in variables left out', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.dropEnv.desc', defaultMessage: "The environment variables Combwork leaves out when it runs Claude Code on a connection (its sign-in, its checks, Set Up and its agents), by name: a key, token, request header, server, provider switch or model set on this PC can't stand in for the connection's own. A server connection's own (its server, key and models) are set after. Wrong, a variable Claude Code reads as a login, a header or a server could make a connection run as someone else, or send a key elsewhere.", description: 'What the advanced setting "Connections: sign-in variables left out" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    // Every ANTHROPIC_* (keys, tokens, ANTHROPIC_CUSTOM_HEADERS, base URLs, models and their names), the provider
    // switches and their auth skips, the OAuth token, the subagents' model, the Bedrock bearer token and Vertex's region.
    default: String.raw`^(?:ANTHROPIC_\w+|CLAUDE_CODE_(?:USE_\w+|SKIP_\w+_AUTH|OAUTH_\w+|SUBAGENT_MODEL|API_KEY_HELPER_TTL_MS)|AWS_BEARER_TOKEN_BEDROCK|CLOUD_ML_REGION)$`,
    flags: 'i',
    applies: 'sessions',
    samples: [
      { from: `${FIX}/advanced/ambient-auth-claude-2.1.311.txt`, version: '2.1.311', text: 'ANTHROPIC_API_KEY', shows: 'A key in the environment taken as a login over a connection home that never signed in' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/ambient-auth-claude-2.1.311.txt`, version: '2.1.311', text: 'CLAUDE_CODE_USE_BEDROCK', shows: 'A third-party provider switch in the environment taken over a connection home' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/ambient-auth-claude-2.1.311.txt`, version: '2.1.311', text: 'ANTHROPIC_CUSTOM_HEADERS', shows: "Request headers from the environment sent with every request to the connection's server" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'claude-code.connections.remoteModels',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.connections.remoteModels.title', defaultMessage: 'Connections: Ollama cloud models', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Ollama is a product's name; its cloud models run on ollama.com." }),
    desc: msg({ id: 'settings.advanced.claude-code.connections.remoteModels.desc', defaultMessage: "The model names Ollama runs on ollama.com rather than on this PC (its cloud models, such as gpt-oss:120b-cloud), as a regular expression, for an Ollama connection's models typed in rather than read from Ollama (Read Models asks Ollama, which says). Such a connection's sessions aren't free (local). Wrong, a cloud model typed in is counted as free, or a local one as not free.", description: 'What the advanced setting "Connections: Ollama cloud models" is for, and what goes wrong when it is wrong (Settings → Advanced). Ollama, ollama.com and Read Models (a button) are names; "free (local)" is how Combwork shows the cost of sessions run only on this PC.' }),
    kind: 'pattern',
    // A tag of `cloud`, or one ending in `-cloud` (Ollama's earlier cloud models), never a name's own `-cloud`.
    default: String.raw`:(?:[\w.]+-)?cloud$`,
    flags: 'i',
    applies: 'sessions',
    samples: [
      { from: `${FIX}/advanced/ollama-cloud-models-0.33.1.txt`, version: '0.33.1', source: 'Ollama', text: 'gemma4:cloud' }, // i18n-ignore: a server's recorded text (#367)
      { from: `${FIX}/advanced/ollama-cloud-models-0.33.1.txt`, version: '0.33.1', source: 'Ollama', text: 'kimi-k2.7-code:cloud' }, // i18n-ignore: a server's recorded text (#367)
      { from: `${FIX}/advanced/ollama-cloud-models-0.33.1.txt`, version: '0.33.1', source: 'Ollama', text: 'gpt-oss:120b-cloud' } // i18n-ignore: a server's recorded text (#367)
    ]
  },
  // HI-2682: a server connection's model IDs Claude Code reads as its own aliases, so it sizes them itself: Combwork passes
  // no local-model context or output budget for them.
  {
    id: LOCAL_MODEL_ALIASES_ID,
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.localModel.aliases.title', defaultMessage: 'Local models: Claude Code’s aliases', description: "An advanced setting's title (Settings → Advanced), listed under its CLI: the model names Claude Code reads as its own aliases (opus, sonnet…)." }),
    desc: msg({ id: 'settings.advanced.claude-code.localModel.aliases.desc', defaultMessage: "The model names Claude Code reads as its own aliases (opus, sonnet…), as a regular expression. A server connection's model named so gets no Context size or Output budget from Combwork, as Claude Code sizes it itself. Wrong, a local model with one of these names is launched as if Claude Code knew it, or an alias gets limits Claude Code ignores.", description: 'What the advanced setting "Local models: Claude Code’s aliases" is for, and what goes wrong when it is wrong (Settings → Advanced). Context size and Output budget are fields of a server connection’s models: as translated there.' }),
    kind: 'pattern',
    default: String.raw`^(?:default|best|opus|sonnet|haiku|fable|opusplan)(?:\[1m\])?$`,
    flags: 'i',
    applies: 'sessions',
    samples: [
      { from: `${FIX}/advanced/help-model-claude-2.1.319.txt`, version: '2.1.319', text: 'opus' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/help-model-claude-2.1.319.txt`, version: '2.1.319', text: 'sonnet' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/help-model-claude-2.1.319.txt`, version: '2.1.319', text: 'fable' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  // HI-2682: the spellings Claude Code may resolve to a Claude model or size by its own rules (claude in the ID, [1m], a
  // stripped date suffix): unsupported for Combwork's local-model limits.
  {
    id: LOCAL_MODEL_SPELLINGS_ID,
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.localModel.spellings.title', defaultMessage: 'Local models: IDs Claude Code sizes itself', description: "An advanced setting's title (Settings → Advanced), listed under its CLI: model ID spellings (claude-…, [1m], a date suffix) Claude Code applies its own context rules to." }),
    desc: msg({ id: 'settings.advanced.claude-code.localModel.spellings.desc', defaultMessage: "Model ID spellings Claude Code may resolve to a Claude model or size by its own rules (claude in the ID, a [1m] suffix, a date after @), as a regular expression. A server connection's model spelt so gets no Context size or Output budget from Combwork. Wrong, Combwork passes limits Claude Code doesn't apply, or leaves out a local model it would.", description: 'What the advanced setting "Local models: IDs Claude Code sizes itself" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep [1m] and @ as they are. Context size and Output budget are fields of a server connection’s models: as translated there.' }),
    kind: 'pattern',
    default: String.raw`claude|\[1m\]|@`,
    flags: 'i',
    applies: 'sessions',
    samples: [
      { from: `${FIX}/advanced/model-ids-claude-2.1.319.txt`, version: '2.1.319', text: 'anthropic/claude-opus-4-8' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/model-ids-claude-2.1.319.txt`, version: '2.1.319', text: 'claude-sonnet-4-5@20250929' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/model-ids-claude-2.1.319.txt`, version: '2.1.319', text: 'my-gateway-opus[1m]' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'claude-code.statusLine.rateLimits',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.rateLimits.title', defaultMessage: 'Status line: plan limits field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.rateLimits.desc', defaultMessage: "The status line's field with a subscription's limits (the 5-hour and weekly use the status bar shows). Wrong, Combwork shows no plan limits for Claude Code.", description: 'What the advanced setting "Status line: plan limits field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'rate_limits',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['session_id', 'transcript_path', 'cwd', 'scratchpad_dir', 'prompt_id', 'effort', 'model', 'workspace', 'version', 'output_style', 'cost', 'context_window', 'exceeds_200k_tokens', 'prompt_cache', 'fast_mode', 'thinking', 'rate_limits'] }]
  },
  {
    id: 'claude-code.statusLine.fiveHour',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.fiveHour.title', defaultMessage: 'Status line: 5-hour limit field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.fiveHour.desc', defaultMessage: "The plan limits' field for the 5-hour window.", description: 'What the advanced setting "Status line: 5-hour limit field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'five_hour',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['five_hour', 'seven_day'] }]
  },
  {
    id: 'claude-code.statusLine.weekly',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.weekly.title', defaultMessage: 'Status line: weekly limit field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.weekly.desc', defaultMessage: "The plan limits' field for the weekly window.", description: 'What the advanced setting "Status line: weekly limit field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'seven_day',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['five_hour', 'seven_day'] }]
  },
  {
    id: 'claude-code.statusLine.usedPercent',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.usedPercent.title', defaultMessage: 'Status line: percentage used field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.usedPercent.desc', defaultMessage: "A limit's field with the percentage used.", description: 'What the advanced setting "Status line: percentage used field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'used_percentage',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['used_percentage', 'resets_at'] }]
  },
  {
    id: 'claude-code.subagent.launched',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.subagent.launched.title', defaultMessage: 'Transcript: background subagent launched', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.subagent.launched.desc', defaultMessage: "The status of the Agent tool's result when it runs a subagent (or a workflow) in the background (#1584). Wrong, Combwork doesn't count those subagents, and shows the agent finished while they work.", description: 'What the advanced setting "Transcript: background subagent launched" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'async_launched',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-launch-claude-2.1.310.jsonl`, version: '2.1.310', text: 'async_launched' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.subagent.idField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.subagent.idField.title', defaultMessage: "Transcript: background subagent's id field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.subagent.idField.desc', defaultMessage: "The field of that result with the subagent's id, which its notification names when it ends. Wrong, Combwork doesn't count background subagents.", description: 'What the advanced setting "Transcript: background subagent\'s id field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'agentId',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-launch-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['isAsync', 'status', 'agentId', 'description', 'resolvedModel', 'prompt', 'outputFile', 'canReadOutputFile', 'canContinueAgent'] }]
  },
  {
    id: 'claude-code.subagent.descriptionField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.subagent.descriptionField.title', defaultMessage: "Transcript: background subagent's description field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.subagent.descriptionField.desc', defaultMessage: 'The field of that result with what the subagent was asked to do, in a few words. Wrong, Combwork still counts it but has no description of it.', description: 'What the advanced setting "Transcript: background subagent\'s description field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'description',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-launch-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['isAsync', 'status', 'agentId', 'description', 'resolvedModel', 'prompt', 'outputFile', 'canReadOutputFile', 'canContinueAgent'] }]
  },
  {
    id: 'claude-code.subagent.resumedField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.subagent.resumedField.title', defaultMessage: 'Transcript: resumed subagent field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.subagent.resumedField.desc', defaultMessage: "The field of a message's result with the id of a finished subagent the message started again. Wrong, Combwork doesn't count a resumed subagent while it works.", description: 'What the advanced setting "Transcript: resumed subagent field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'resumedAgentId',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-resume-claude-2.1.309.jsonl`, version: '2.1.309', fields: ['success', 'message', 'resumedAgentId', 'revivedAgentId', 'pin'] }]
  },
  // Claude Code waiting to retry its model request (HI-1973): its transcript's entry for each try.
  {
    id: 'claude-code.retry.subtype',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.retry.subtype.title', defaultMessage: 'Transcript: retry entry', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. A retry: the coding agent trying its model request again after it failed." }),
    desc: msg({ id: 'settings.advanced.claude-code.retry.subtype.desc', defaultMessage: "The kind of transcript entry Claude Code writes each time its model request fails and it tries again (rate-limited, or the service unreachable). Combwork reads the latest and shows the wait as the agent's status. Wrong, a waiting agent just shows Working.", description: 'What the advanced setting "Transcript: retry entry" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'api_error',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-claude-2.1.312.jsonl`, version: '2.1.312', text: 'api_error' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.retry.attemptField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.retry.attemptField.title', defaultMessage: "Transcript: retry entry's try field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.retry.attemptField.desc', defaultMessage: "The field of that entry with which try it is (1, 2…). Wrong, a waiting agent just shows Working.", description: 'What the advanced setting "Transcript: retry entry\'s try field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'retryAttempt',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-claude-2.1.312.jsonl`, version: '2.1.312', fields: ['parentUuid', 'isSidechain', 'type', 'subtype', 'level', 'error', 'retryInMs', 'retryAttempt', 'maxRetries', 'source', 'timestamp', 'uuid', 'userType', 'entrypoint', 'cwd', 'sessionId', 'version', 'gitBranch'] }]
  },
  {
    id: 'claude-code.retry.maxField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.retry.maxField.title', defaultMessage: "Transcript: retry entry's tries field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.retry.maxField.desc', defaultMessage: 'The field of that entry with how many tries it makes in all. Wrong, a waiting agent just shows Working.', description: 'What the advanced setting "Transcript: retry entry\'s tries field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'maxRetries',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-claude-2.1.312.jsonl`, version: '2.1.312', fields: ['parentUuid', 'isSidechain', 'type', 'subtype', 'level', 'error', 'retryInMs', 'retryAttempt', 'maxRetries', 'source', 'timestamp', 'uuid', 'userType', 'entrypoint', 'cwd', 'sessionId', 'version', 'gitBranch'] }]
  },
  {
    id: 'claude-code.retry.waitField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.retry.waitField.title', defaultMessage: "Transcript: retry entry's wait field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.retry.waitField.desc', defaultMessage: 'The field of that entry with how long Claude Code waits before the next try, in milliseconds. Wrong, a waiting agent just shows Working.', description: 'What the advanced setting "Transcript: retry entry\'s wait field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'retryInMs',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-claude-2.1.312.jsonl`, version: '2.1.312', fields: ['parentUuid', 'isSidechain', 'type', 'subtype', 'level', 'error', 'retryInMs', 'retryAttempt', 'maxRetries', 'source', 'timestamp', 'uuid', 'userType', 'entrypoint', 'cwd', 'sessionId', 'version', 'gitBranch'] }]
  },
  {
    id: 'claude-code.retry.statusField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.retry.statusField.title', defaultMessage: "Transcript: retry error's status field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.retry.statusField.desc', defaultMessage: "The field of that entry's error with the HTTP status that refused the request (429: rate-limited). With none, the service couldn't be reached. Wrong, every wait shows as the service unreachable.", description: 'What the advanced setting "Transcript: retry error\'s status field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'status',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-claude-2.1.312.jsonl`, version: '2.1.312', fields: ['message', 'status', 'formatted', 'connection', 'isNetworkDown', 'rateLimits', 'noResponse'] }]
  },
  {
    id: 'claude-code.retry.checkAfterSeconds',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.retry.checkAfterSeconds.title', defaultMessage: 'Retry wait: look after', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"20 s\"). A retry wait: the coding agent waiting to try its model request again." }),
    desc: msg({ id: 'settings.advanced.claude-code.retry.checkAfterSeconds.desc', defaultMessage: "How long a working Claude Code session has to go without a hook before Combwork looks at the end of its transcript for a wait to retry its model request, then every 15 seconds while it stays quiet.", description: 'What the advanced setting "Retry wait: look after" does (Settings → Advanced).' }),
    kind: 'number',
    default: 20,
    min: 5,
    max: 600,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-claude-2.1.312.jsonl`, version: '2.1.312', text: 'api_error', shows: "Claude Code's transcript entry for a try it makes again, which Combwork looks for once a session has been quiet this long" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.hooks.timeoutSeconds',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.hooks.timeoutSeconds.title', defaultMessage: 'Hooks: timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.hooks.timeoutSeconds.desc', defaultMessage: "How long Claude Code waits for Combwork to take one of its hooks (a turn starting or ending, a notification). Combwork answers at once; raise it only if Combwork's log shows hooks timing out on a slow machine.", description: 'What the advanced setting "Hooks: timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 5,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN]
  },
  {
    id: 'claude-code.hooks.preToolUseTimeoutSeconds',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.hooks.preToolUseTimeoutSeconds.title', defaultMessage: 'Hooks: before a tool, timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.hooks.preToolUseTimeoutSeconds.desc', defaultMessage: "How long Claude Code waits for Combwork's answer before a tool runs (an edit waits for a file lock). If Combwork doesn't answer in time, the tool goes ahead.", description: 'What the advanced setting "Hooks: before a tool, timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN]
  },
  {
    id: 'claude-code.turnScreen.done',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.turnScreen.done.title', defaultMessage: 'Screen: turn done', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.turnScreen.done.desc', defaultMessage: 'Claude Code\'s line above its input when the last turn is done ("✻ Worked for 12s · done 16:52"). When Combwork missed a turn\'s end, it takes this on screen to mean the agent is idle; wrong, it leaves such an agent\'s status unknown, with Mark idle.', description: 'What the advanced setting "Screen: turn done" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`\bfor (?:\d+[hms]\s*)+· done \d{1,2}:\d{2}\b`,
    applies: 'now',
    samples: [{ from: `${FIX}/screen-claude-2.1.296-idle.txt`, version: '2.1.296', text: '✻ Worked for 0s · done 2:19' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A turn Claude Code starts by itself (HI-2410): its prompt hook is like the user's but for the text.
  {
    id: 'claude-code.prompt.cliTurn',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.prompt.cliTurn.title', defaultMessage: "Prompt hook: Claude Code's own turn", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.prompt.cliTurn.desc', defaultMessage: "What a prompt hook's text starts with when Claude Code starts a turn by itself, such as when a background task ends. Combwork never reports such a turn to the Assistant as your reply. Wrong, a background task's end soon after you pressed Enter in the agent's pane can be reported as your reply.", description: 'What the advanced setting "Prompt hook: Claude Code\'s own turn" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`^\s*<task-notification>`,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/prompt-task-notification-claude-2.1.317.json`, version: '2.1.317', text: '<task-notification>\n<task-id>bfrybgkuv</task-id>' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.safeguard.note',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.safeguard.note.title', defaultMessage: 'Safeguard stop: transcript note', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.safeguard.note.desc', defaultMessage: "Claude Code's note in its transcript when its safety classifier stops a response, and the notice it adds for the model (#606). Wrong, Combwork misses such stops: no shield on the agent's pane, and Performance doesn't count them.", description: 'What the advanced setting "Safeguard stop: transcript note" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: CLAUDE_SAFEGUARDS.note,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/safeguards-claude-2.1.296.jsonl`, version: '2.1.296', text: "Opus 5.5's safeguards stopped the response above · continuing once with that noted" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/safeguards-claude-2.1.296.jsonl`, version: '2.1.296', text: 'Your response above was stopped by a safety classifier' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'claude-code.safeguard.prompt',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.safeguard.prompt.title', defaultMessage: 'Safeguard stop: question', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.safeguard.prompt.desc', defaultMessage: 'Claude Code\'s question after a safeguard stop, whether to switch models, told by its open dialog\'s choices in the lines it wrote last. Combwork shows the agent waiting for you, and why, while it is open; wrong, the agent shows only "Claude needs your permission".', description: 'What the advanced setting "Safeguard stop: question" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: CLAUDE_SAFEGUARDS.prompt,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/safeguard-prompt-claude-2.1.296.txt`, version: '2.1.296', text: ' ❯ 1. Switch automatically\n      Continue on Opus 4.8 now, and switch without asking from now on\n   2. Stay on Opus 5.5' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.screen.idleQuestion',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.screen.idleQuestion.title', defaultMessage: 'Screen: question while idle', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.screen.idleQuestion.desc', defaultMessage: "A question Claude Code puts on its screen by itself after a turn, sending Combwork nothing (\"Teach auto mode about your environment?\"), as a line of its own in a dialog that replaces its input box or is drawn under it (the same words above the input box, in a prompt or a reply, aren't it). While it shows, Combwork shows the agent waiting for you with the question, and types nothing into it: Enter would answer it. Wrong, Combwork types its wakes into the question.", description: 'What the advanced setting "Screen: question while idle" is for, and what goes wrong when it is wrong (Settings → Advanced, HI-1959). The quoted question is Claude Code\'s own, in English: keep it as it is.' }),
    kind: 'pattern',
    default: String.raw`^[ \t]*Teach auto mode about your environment\?[ \t]*$`,
    flags: 'm',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/envsetup-claude-2.1.312.txt`, version: '2.1.312', text: '  Teach auto mode about your environment?' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/envsetup-offer-claude-2.1.312.txt`, version: '2.1.312', text: ' Teach auto mode about your environment?' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/envsetup-offer-claude-2.1.314.txt`, version: '2.1.314', text: '  Teach auto mode about your environment?', shows: "The offer drawn under Claude Code's empty input box and its footer (recorded, HI-2191)" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'claude-code.screen.input',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.screen.input.title', defaultMessage: 'Screen: input box', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.screen.input.desc', defaultMessage: "Claude Code's input box, between two rules, its first group what it holds after its prompt mark. Combwork reads it to tell that a line it typed is gone from the input (a screen of the CLI's took it), and then types it again. Wrong, such a line stays held, and nothing more is typed into the agent until you press Enter there.", description: 'What the advanced setting "Screen: input box" is for, and what goes wrong when it is wrong (Settings → Advanced, HI-1959). A rule: a horizontal line drawn across the terminal.' }),
    kind: 'pattern',
    // Its prompt mark is ">" where the terminal doesn't say it shows Unicode (no TERM or WT_SESSION: a Combwork started from the Start menu).
    default: String.raw`^─{3,}[^\n]*\n[❯>][  ]?([^\n]*(?:\n(?!─{3,})[^\n]*)*)\n(?=─{3,})`,
    flags: 'm',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/input-ascii-claude-2.1.312.txt`, version: '2.1.312', text: `${'─'.repeat(113)} demo ─\n> a draft typed and left there, long enough to wrap onto rows of its own test wake line typed and not sent\n${'─'.repeat(120)}`, shows: "Its input box where the terminal doesn't say it shows Unicode: \">\" its prompt mark, and the session's name in its top rule" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/input-claude-2.1.312.txt`, version: '2.1.312', text: `${'─'.repeat(120)}\n❯ test wake line typed and not sent\n${'─'.repeat(120)}` }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: clearKeyWaitId('claude-code'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.prompt.clearKeySeconds.title', defaultMessage: 'Clearing the input: wait for each key', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.prompt.clearKeySeconds.desc', defaultMessage: "Claude Code's Ctrl+U deletes one row of a draft that wraps onto several, so before Combwork types into it, it presses Ctrl+U a key at a time until the input box (Screen: input box) shows empty. This is how long Combwork waits for Claude Code to show each key's effect. Not shown in time, Combwork types nothing and tries again later: too short, and a busy Claude Code makes Combwork put its messages off more often.", description: 'What the advanced setting "Clearing the input: wait for each key" is for, and what goes wrong when it is wrong (Settings → Advanced, HI-1979). Ctrl+U names keys: use the key names your language uses. "Screen: input box" is another advanced setting\'s title: use its translation.' }),
    kind: 'number',
    default: 2,
    min: 1,
    max: 30,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/input-clear-claude-2.1.312.txt`, version: '2.1.312', text: 'Ctrl+Y to paste deleted text', shows: "Claude Code's input box after each Ctrl+U on a draft typed onto four rows: one row gone each time, then empty" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.autoModeSetup.offer',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.autoModeSetup.offer.title', defaultMessage: "Offer auto mode's environment setup", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Auto mode is one of Claude Code's permission modes." }),
    desc: msg({ id: 'settings.advanced.claude-code.autoModeSetup.offer.desc', defaultMessage: "Claude Code offers, now and then in auto mode, to read the project, your recent sessions and optionally your shell history and other repositories, to teach auto mode about your environment. Combwork never answers it: the agent waits for you. Off, Combwork's Claude Code agents are started with the offer turned off for that launch (nothing is written to Claude Code's files, and auto mode decides as before); /auto-mode-setup still runs it when you want.", description: "What the advanced setting \"Offer auto mode's environment setup\" is for, and what happens when it is off (Settings → Advanced, HI-1959). /auto-mode-setup is Claude Code's command: keep it as it is." }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/envsetup-code-claude-2.1.312.txt`, version: '2.1.312', text: 'ft().skillOverrides?.["auto-mode-setup"]!=="off"', shows: "Claude Code's own code: the offer is off when its settings turn the auto-mode-setup skill off (not seen on a screen)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  ...CLAUDE_FOOTER_MODES.map(
    (m): AdvancedSource => ({
      id: `claude-code.footer.${m.key}`,
      group: 'claude-code',
      title: withValues(msg({ id: 'settings.advanced.claudeFooter.title', defaultMessage: 'Footer: {mode}', description: "An advanced setting's title (Settings → Advanced, under Claude Code): the footer Claude Code shows in a permission mode. {mode} is the mode's name." }), { mode: m.label }),
      desc: withValues(
        msg({
          id: 'settings.advanced.claudeFooter.desc',
          defaultMessage: "Claude Code's footer in the {mode} mode (\"{footer}\"). Combwork reads an agent's permission mode from its footer (the mode found last on screen), and switches modes by pressing Shift+Tab until the footer shows the one wanted; wrong, Combwork doesn't see the agent in {mode}, and can't switch to it without a restart.",
          description: "What the advanced setting is for (Settings → Advanced, under Claude Code). {mode} is a permission mode's name; {footer} is Claude Code's own footer text, in English: keep it as it is."
        }),
        { mode: m.label, footer: FOOTER_SAMPLES[`claude-code.${m.key}`].text ?? '' }
      ),
      kind: 'pattern',
      default: m.pattern,
      flags: 'i',
      applies: 'now',
      samples: [FOOTER_SAMPLES[`claude-code.${m.key}`]]
    })
  ),
  {
    id: 'claude-code.memory.realPath',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.memory.realPath.title', defaultMessage: 'Auto memory by its real path on connections', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Auto memory is Claude Code's own notes it keeps per project; a connection is an account Combwork signs a CLI in with." }),
    desc: msg({ id: 'settings.advanced.claude-code.memory.realPath.desc', defaultMessage: "A connection's projects folder is a link to Claude Code's own, so Claude Code asked you before each memory it saved there. Each Claude Code agent on a connection is given its project's auto memory folder by its real path: the same folder, so it saves memories without asking, as it does without a connection. Nothing more is allowed, and nothing is written to Claude Code's files. Off, Claude Code asks before each memory on a connection.", description: "What the advanced setting \"Auto memory by its real path on connections\" is for, and what happens when it is off (Settings → Advanced, HI-1899). Auto memory is Claude Code's own notes it keeps per project; a connection is an account Combwork signs a CLI in with; \"projects\" is a folder's name: keep it." }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/memory-connection-claude-2.1.312.txt`, version: '2.1.312', text: 'memory saved without asking', shows: "Claude Code on a home whose projects folder is a junction, saving an auto memory with Combwork's autoMemoryDirectory and asking without it" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.memory.setting',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.memory.setting.title', defaultMessage: 'Auto memory folder setting', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Auto memory is Claude Code's own notes it keeps per project." }),
    desc: msg({ id: 'settings.advanced.claude-code.memory.setting.desc', defaultMessage: "The Claude Code setting that names its auto memory folder, which Combwork sets on a connection (Auto memory by its real path on connections) and leaves alone where you set it yourself. Wrong, Claude Code ignores it and asks before each memory on a connection.", description: "What the advanced setting \"Auto memory folder setting\" is for, and what goes wrong when it is wrong (Settings → Advanced, HI-1899). \"Auto memory by its real path on connections\" is another advanced setting's title: keep it as translated there." }),
    kind: 'field',
    default: 'autoMemoryDirectory',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/memory-setting-claude-2.1.312.json`, version: '2.1.312', fields: ['autoMemoryDirectory'] }]
  },
  {
    id: 'claude-code.update.channelSetting',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.update.channelSetting.title', defaultMessage: 'Update channel setting', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. The release channel Claude Code updates from (stable or latest)." }),
    desc: msg({ id: 'settings.advanced.claude-code.update.channelSetting.desc', defaultMessage: "The Claude Code setting that names the release channel `claude update` installs from (stable or latest), which Combwork reads from Claude Code's managed and user settings, never changes, to offer only an update on that channel. Wrong, Combwork compares Claude Code with the latest channel, and may offer an update it can't make.", description: 'What the advanced setting "Update channel setting" is for, and what goes wrong when it is wrong (Settings → Advanced, HI-2729). Keep `claude update` as it is (a command), and stable and latest (the channels\' names).' }),
    kind: 'field',
    default: 'autoUpdatesChannel',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/update-channel-claude-2.1.319.json`, version: '2.1.319', fields: ['autoUpdatesChannel'] }]
  },
  // The same for Claude Code and Codex (#1167). Codex tracks the mouse since 0.163; Claude Code (2.1.305) doesn't at its
  // prompt, so a right-click passed to it does nothing there, but Combwork's copy/paste can still be turned off.
  {
    id: rightClickToCliId('claude-code'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.mouse.rightClickToCli.title', defaultMessage: 'Pass right-click to Claude Code', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({
      id: 'settings.advanced.claude-code.mouse.rightClickToCli.desc',
      defaultMessage: "Right-click in a Claude Code pane is Combwork's, as in every pane: it copies the terminal's selection, or pastes. Turned on, Combwork passes right-clicks to Claude Code instead. Claude Code doesn't use the mouse at its prompt, so there a right-click then does nothing: copy and paste with Ctrl+C and Ctrl+V.",
      description: 'What the advanced setting "Pass right-click to Claude Code" is for (Settings → Advanced, under Claude Code). Ctrl+C and Ctrl+V name keys: use the key names your language uses.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/mouse-claude-2.1.305.json`, version: '2.1.305', text: '"mouseTracking": "none"', shows: 'Claude Code turning on no mouse tracking at its prompt, so a passed right-click reaches nothing there' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Off switches for Combwork's overrides of the CLIs' own behaviour (#966, #1167): on is what Combwork does today.
  {
    id: overrideId('claude-code', 'promptSnapshotOff'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.override.promptSnapshotOff.title', defaultMessage: 'Resume the Assistant with its current instructions', description: "An advanced setting's title (Settings → Advanced, under Claude Code): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.claude-code.override.promptSnapshotOff.desc',
      defaultMessage: "When the Assistant's conversation resumes, Combwork starts Claude Code with --system-prompt-snapshot off, so the Assistant follows its role and Control settings as they are now. Turned off, Combwork leaves the flag out and Claude Code keeps sending the instructions it recorded when the conversation began, until it compacts: a change to the Assistant's settings may not reach it until then. --system-prompt-snapshot in Extra arguments wins either way.",
      description: 'What the advanced setting "Resume the Assistant with its current instructions" does (Settings → Advanced, under Claude Code). --system-prompt-snapshot off is a command-line option and its value: keep them. Control is the name of the Assistant\'s settings page.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-claude-2.1.305.txt`, version: '2.1.305', text: '--system-prompt-snapshot <on|off>', shows: "Claude Code's help for the flag Combwork passes on the Assistant's resumes" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Combwork's tools pre-approved (#1281, #966 row 3): CLI trust only. What a session may do with them is the Agent API's and
  // Control's either way, and whether it has them at all is the workspace's MCP settings.
  {
    id: overrideId('claude-code', 'preApproveCombworkTools'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.override.preApproveCombworkTools.title', defaultMessage: "Pre-approve the Assistant's Combwork tools", description: "An advanced setting's title (Settings → Advanced, under Claude Code): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.claude-code.override.preApproveCombworkTools.desc',
      defaultMessage: "When the Assistant runs on Claude Code, Combwork passes --allowedTools with the Combwork tools its Control settings let it use without asking, so Claude Code doesn't ask before them. Turned off, Claude Code asks before each Combwork tool as its own permission mode says. Control still decides what the Assistant may do either way. Agents' Combwork tools are never pre-approved on Claude Code.",
      description: 'What the advanced setting "Pre-approve the Assistant\'s Combwork tools" does (Settings → Advanced, under Claude Code). --allowedTools is a command-line option: keep it. Control is the name of the Assistant\'s settings page.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-claude-2.1.305.txt`, version: '2.1.305', text: '--allowedTools, --allowed-tools <tools...>', shows: "Claude Code's help for the flag Combwork passes the Assistant's tools in" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Only the workspace's MCP servers (#1281, #966 rows 4–6). Off, the CLI's own load beside them, and the workspace's
  // (Combwork's own server, combwork, among them) still win over the CLI's own of the same name: each CLI checked (Claude Code 2.1.305,
  // Copilot 1.0.100 natively; Codex by Combwork's table, outrankNativeCombwork).
  {
    id: overrideId('claude-code', 'mcpIsolation'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.override.mcpIsolation.title', defaultMessage: "Only the workspace's MCP servers", description: "An advanced setting's title (Settings → Advanced, under Claude Code): one of Combwork's overrides of the CLI, on by default. MCP is a protocol's name." }),
    desc: msg({
      id: 'settings.advanced.claude-code.override.mcpIsolation.desc',
      defaultMessage: "Combwork starts Claude Code with --strict-mcp-config, so its sessions get only the MCP servers the workspace gives them. Turned off, the servers in your own Claude Code config and the project's .mcp.json load beside them, as they would outside Combwork (Claude Code may ask you to approve a project's new servers first). The workspace's servers, Combwork's own combwork server among them, win over yours of the same name.",
      description: 'What the advanced setting "Only the workspace\'s MCP servers" does (Settings → Advanced, under Claude Code). --strict-mcp-config is a command-line option and .mcp.json a file name: keep them. combwork is the name of Combwork\'s MCP server.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-claude-2.1.305.txt`, version: '2.1.305', text: 'Only use MCP servers from --mcp-config,', shows: "Claude Code's help for the flag Combwork passes" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Combwork's status line in place of the user's (#1285, #966 row 12). Off, theirs shows again, chained after Combwork's.
  {
    id: overrideId('claude-code', 'statusLine'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.override.statusLine.title', defaultMessage: "Combwork's status line in place of yours", description: "An advanced setting's title (Settings → Advanced, under Claude Code): one of Combwork's overrides of the CLI, on by default. The status line is the line Claude Code shows under its input." }),
    desc: msg({
      id: 'settings.advanced.claude-code.override.statusLine.desc',
      defaultMessage: "Combwork starts Claude Code with a status line of its own, which sends Combwork the session's model, context, cost and plan limits for the agent's footer and shows nothing under the input. Turned off, the status line in your Claude Code settings shows again: Combwork's command still reads the status, then runs yours with the same input Claude Code gives it and shows what it prints. With no status line of yours, nothing changes.",
      description: 'What the advanced setting "Combwork\'s status line in place of yours" does (Settings → Advanced, under Claude Code).'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', text: '"context_window"', shows: "Claude Code's status line input, which Combwork's command reads and passes on to yours" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.hooks.knownEvents',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.hooks.knownEvents.title', defaultMessage: 'Hooks: known events', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.hooks.knownEvents.desc', defaultMessage: "The hook events Combwork knows Claude Code sends. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook named outside this list saves a capture of the agent's recent events.", description: 'What the advanced setting "Hooks: known events" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact', 'SessionEnd'], // i18n-ignore: a CLI's hook event names (#698)
    max: 20,
    applies: 'now',
    samples: [{ from: `${FIX}/turns-claude-2.1.296.json`, version: '2.1.296', text: '"hook_event_name": "UserPromptSubmit"' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.hooks.knownFields',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.hooks.knownFields.title', defaultMessage: 'Hooks: known fields', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.hooks.knownFields.desc', defaultMessage: "The top-level fields Combwork knows Claude Code sends in its hooks. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook with a field outside this list saves a capture of the agent's recent events: often the first sign that a Claude Code update changed something. Add a field here once you know it is harmless.", description: 'What the advanced setting "Hooks: known fields" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['hook_event_name', 'hookEventName', 'session_id', 'sessionId', 'transcript_path', 'transcriptPath', 'cwd', 'permission_mode', 'permissionMode', 'tool_name', 'toolName', 'tool_use_id', 'toolUseId', 'source', 'trigger', 'matcher', 'notification_type', 'model', 'agent_type', 'turn_id', 'timestamp', 'tool_input', 'prompt_id', 'prompt', 'tool_response', 'stop_hook_active', 'last_assistant_message', 'message', 'title', 'custom_instructions', 'compact_summary', 'agent_id', 'reason', 'error', 'is_interrupt', 'effort'],
    max: 80,
    applies: 'now',
    samples: [{ from: `${FIX}/turns-claude-2.1.296.json`, version: '2.1.296', fields: ['hook_event_name', 'permission_mode', 'prompt_id', 'session_id', 'tool_input', 'tool_name', 'tool_use_id'] }, { from: `${FIX}/turns-claude-2.1.296.json`, version: '2.1.296', fields: ['hook_event_name', 'last_assistant_message', 'permission_mode', 'prompt_id', 'session_id', 'stop_hook_active'] }]
  },
  {
    id: 'claude-code.statusLine.knownFields',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.knownFields.title', defaultMessage: 'Status line: known fields', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.knownFields.desc', defaultMessage: "The top-level fields Combwork knows Claude Code sends in its status line. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a status line with a field outside this list saves a capture of the agent's recent events. Add a field here once you know it is harmless.", description: 'What the advanced setting "Status line: known fields" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['session_id', 'transcript_path', 'cwd', 'scratchpad_dir', 'prompt_id', 'effort', 'model', 'workspace', 'version', 'output_style', 'cost', 'context_window', 'exceeds_200k_tokens', 'prompt_cache', 'fast_mode', 'thinking', 'rate_limits'],
    max: 80,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['session_id', 'transcript_path', 'cwd', 'scratchpad_dir', 'prompt_id', 'effort', 'model', 'workspace', 'version', 'output_style', 'cost', 'context_window', 'exceeds_200k_tokens', 'prompt_cache', 'fast_mode', 'thinking', 'rate_limits'] }]
  }
]

/** The address Combwork checks for its connection (a value of Combwork's own, listed under Combwork: HI-1612). */
// agent-text: OUTAGE_CHECK (Settings → Advanced's title and description, which agents read too: the settings tools, HI-2441)
export const OUTAGE_CHECK: AdvancedSource = {
  id: outageCheckUrlId('claude-code'),
  group: 'cw',
  title: msg({ id: 'settings.advanced.cw.outage.checkUrl.claude-code.title', defaultMessage: 'Resuming after a connection drops: address checked for Claude Code', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. Claude Code is a product name." }),
  desc: msg({ id: 'settings.advanced.cw.outage.checkUrl.claude-code.desc', defaultMessage: "The address Combwork asks to see whether Claude Code's connection is back: its API host. Any reply counts, an error page too. An agent on a server connection is checked at its server's address instead.", description: 'What the advanced setting "Resuming after a connection drops: address checked for Claude Code" does (Settings → Advanced).' }),
  kind: 'text',
  default: 'https://api.anthropic.com',
  applies: 'now'
}
