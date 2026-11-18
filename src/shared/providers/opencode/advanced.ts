import { FIXTURES as FIX, overrideId, type AdvancedSource } from '../../advancedDef'
import { msg } from '../../i18n/msg'

/** OpenCode's advanced values (#367), in the order Settings lists them: advanced.ts gathers them through the registry (HI-3201). */
// agent-text: ADVANCED (Settings → Advanced's titles and descriptions, which agents read too: the settings tools, HI-2441)
export const ADVANCED: readonly AdvancedSource[] = [
  // OpenCode 2 (HI-2759, against 2.2.6; HI-2758's recipe): its overrides, the CLI text Combwork reads, its server's wait.
  {
    id: overrideId('opencode', 'noAutoUpdate'),
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.override.noAutoUpdate.title', defaultMessage: "Don't let OpenCode update itself", description: "An advanced setting's title (Settings → Advanced, under OpenCode): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.opencode.override.noAutoUpdate.desc',
      defaultMessage: 'Combwork runs OpenCode with update: "disable" in its private config and OPENCODE_DISABLE_AUTOUPDATE=1 (its agents, and checking its accounts and models), so it runs the version installed and never changes between an agent\'s restarts; Update in Provider Setup updates it when you choose. Turned off, OpenCode may update itself as it would outside Combwork.',
      description: 'What the advanced setting "Don\'t let OpenCode update itself" does (Settings → Advanced, under OpenCode). update: "disable" is a config setting and OPENCODE_DISABLE_AUTOUPDATE=1 an environment variable: keep them. Update is a button\'s name and Provider Setup a dialog\'s.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-opencode-2.2.6.txt`, version: '2.2.6', text: 'upgrade, update    Upgrade OpenCode to the latest or a specific version', shows: "OpenCode's own update command, which Provider Setup's Update replaces" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('opencode', 'keepProjectConfigOut'),
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.override.keepProjectConfigOut.title', defaultMessage: "Keep the project's OpenCode config out", description: "An advanced setting's title (Settings → Advanced, under OpenCode): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.opencode.override.keepProjectConfigOut.desc',
      defaultMessage: "Combwork runs OpenCode with OPENCODE_DISABLE_PROJECT_CONFIG=1 and OPENCODE_DISABLE_CLAUDE_CODE=1, so nothing of the project's own OpenCode setup loads, and Combwork gives OpenCode the project's AGENTS.md itself. Turned off, OpenCode loads what it would outside Combwork: the project's opencode.json and any opencode.json in a folder above it, its .opencode folder (MCP servers, agents, and plugins, whose code runs), the skills in its .agents and .claude folders and in your home folder's .claude, and the instructions its config names. A project's MCP server with the same name as one Combwork gave the agent then replaces it, Combwork's own tools included.",
      description: 'What the advanced setting "Keep the project\'s OpenCode config out" does (Settings → Advanced, under OpenCode), as OpenCode 2.2.6 was recorded loading each (HI-2763, HI-2761). OPENCODE_DISABLE_PROJECT_CONFIG=1 and OPENCODE_DISABLE_CLAUDE_CODE=1 are environment variables; opencode.json, .opencode, .agents, .claude and AGENTS.md are file and folder names: keep them.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-opencode-2.2.6.txt`, version: '2.2.6', text: 'Directory to start OpenCode in (optional)', shows: 'The project folder OpenCode is started in, whose own config these switches keep out' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('opencode', 'stripCredentials'),
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.override.stripCredentials.title', defaultMessage: 'Keep other credentials from OpenCode', description: "An advanced setting's title (Settings → Advanced, under OpenCode): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.opencode.override.stripCredentials.desc',
      defaultMessage: "Combwork leaves the variables OpenCode reads as a provider's key or token out of its environment (the shell its agents run commands in too: GITHUB_TOKEN and HF_TOKEN among them), and denies Amazon Bedrock, Google Vertex and Azure unless the account saved a credential for them, so an AWS profile, a gcloud login or an Azure CLI sign-in on this PC is never used unasked. OpenCode's Claude Agent provider is denied either way. Turned off, OpenCode gets those variables and may use those sign-ins as it would outside Combwork.",
      description: 'What the advanced setting "Keep other credentials from OpenCode" does (Settings → Advanced, under OpenCode). GITHUB_TOKEN and HF_TOKEN are environment variables; Amazon Bedrock, Google Vertex, Azure, gcloud, Azure CLI and Claude Agent are names: keep them.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/integrations-opencode-2.2.6.json`, version: '2.2.6', text: '"label": "AWS profile (SSO or named profile)"', shows: "One of OpenCode's sign-ins that reads what the PC already has, which Combwork denies" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    // HI-2769 (option a, after HI-2768's source research): side jobs set to another provider's model, and image
    // generation's fallback across providers, can't leave the connection's provider while this is on.
    id: overrideId('opencode', 'ownProviderOnly'),
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.override.ownProviderOnly.title', defaultMessage: "Keep OpenCode to the connection's own provider", description: "An advanced setting's title (Settings → Advanced, under OpenCode): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.opencode.override.ownProviderOnly.desc',
      defaultMessage: "Combwork's private OpenCode config denies every provider but the one in the connection's model (ollama in ollama/qwen3:8b), so nothing OpenCode does on the agent's behalf goes to another provider: not a title or compaction set to another provider's model, nor an image request falling back to another provider's model, nor OpenCode's free cloud models. A connection with this on must name its model. It decides which provider OpenCode uses, not where the provider's address points, and isn't a firewall: web search, MCP servers, plugins and commands can still reach the network. Turned off, OpenCode may use any provider it can, as it would outside Combwork; Claude Agent stays denied either way.",
      description: 'What the advanced setting "Keep OpenCode to the connection\'s own provider" does (Settings → Advanced, under OpenCode). ollama and ollama/qwen3:8b are a provider\'s and a model\'s ids, and Claude Agent a provider\'s name: keep them.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/models-opencode-2.2.6.txt`, version: '2.2.6', text: 'opencode/big-pickle', shows: "One of OpenCode's free cloud models it offers with no account, which this keeps a local connection from" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    // HI-2775 (decided after HI-2772): 2.2.6's agents reach any folder unasked; a launch's private config asks.
    id: overrideId('opencode', 'askOutsideFolder'),
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.override.askOutsideFolder.title', defaultMessage: "Ask before reaching outside the agent's folder", description: "An advanced setting's title (Settings → Advanced, under OpenCode): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.opencode.override.askOutsideFolder.desc',
      defaultMessage: "Combwork's private OpenCode config makes an OpenCode agent ask before it reads or changes anything outside its own folder (OpenCode's external_directory permission). A reviewer's review copies, the agent's skills and its temp folder stay allowed. Approve all approves these questions without asking you, and a rule in the project's own OpenCode config, when you let it load, comes after Combwork's and wins. An agent nobody is watching waits at such a question until you answer it in its pane. Turned off, OpenCode agents reach any folder on this PC without asking, as OpenCode's own rules allow outside Combwork.",
      description: 'What the advanced setting "Ask before reaching outside the agent\'s folder" does (Settings → Advanced, under OpenCode). external_directory is the name of an OpenCode permission: keep it. Approve all is the name of a permission mode: use its translated name.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-opencode-2.2.6.txt`, version: '2.2.6', text: 'Auto-approve permissions that are not explicitly denied', shows: "OpenCode's --auto (Combwork's Approve all), which approves these questions" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    // HI-2775 (HR1's question): 2.2.6 puts the config's rules on its agents a moment after a folder's first session, and
    // checks a tool against the agent as it is then, so the launcher waits for the rule before the TUI starts.
    id: 'opencode.rules.loaded',
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.rules.loaded.title', defaultMessage: "Combwork's folder rule, in OpenCode's agent", description: "An advanced setting's title (Settings → Advanced, under OpenCode): the pattern of the rule Combwork waits to see on OpenCode's agent." }),
    desc: msg({ id: 'settings.advanced.opencode.rules.loaded.desc', defaultMessage: "What OpenCode shows on the agent (its /api/agent reply) once it has loaded Combwork's rule to ask before folders outside the agent's own. With Ask before reaching outside the agent's folder on, Combwork waits for it before OpenCode's window opens, so no tool runs before the rule applies, and the agent doesn't start without it. Wrong, OpenCode agents don't start.", description: 'What the advanced setting "Combwork\'s folder rule, in OpenCode\'s agent" is (Settings → Advanced, under OpenCode). /api/agent is an address: keep it. The quoted setting title is another advanced setting\'s: use its translated title.' }),
    kind: 'pattern',
    default: String.raw`\{"action":"external_directory","resource":"\*","effect":"ask"\}`,
    flags: '',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/agent-opencode-2.2.6.txt`, version: '2.2.6', text: '{"action":"external_directory","resource":"*","effect":"ask"}', shows: "Combwork's rule on OpenCode's Build agent once the folder's config has loaded" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'opencode.version',
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.version.title', defaultMessage: 'The version in opencode --version', description: "An advanced setting's title (Settings → Advanced, under OpenCode): the pattern of the CLI's version line. opencode --version is a command: keep it." }),
    desc: msg({ id: 'settings.advanced.opencode.version.desc', defaultMessage: "What opencode --version prints: the version is its first group. Combwork uses only OpenCode 2 or later. Wrong, OpenCode isn't found.", description: 'What the advanced setting "The version in opencode --version" is (Settings → Advanced, under OpenCode). opencode --version is a command: keep it.' }),
    kind: 'pattern',
    default: String.raw`^\s*opencode\s+v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]*[0-9A-Za-z])?)\s*$`,
    flags: 'mi',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/version-opencode-2.2.6.txt`, version: '2.2.6', text: 'opencode v2.2.6', shows: 'OpenCode 2.2.6 naming its version' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'opencode.models.line',
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.models.line.title', defaultMessage: 'A model in opencode models', description: "An advanced setting's title (Settings → Advanced, under OpenCode): the pattern of one line of the CLI's model list. opencode models is a command: keep it." }),
    desc: msg({ id: 'settings.advanced.opencode.models.line.desc', defaultMessage: "One line of opencode models' list: the model's id, its provider and model as provider/model (its first group). Wrong, no OpenCode models are offered.", description: 'What the advanced setting "A model in opencode models" is (Settings → Advanced, under OpenCode). opencode models is a command: keep it.' }),
    kind: 'pattern',
    default: String.raw`^\s*([A-Za-z0-9][A-Za-z0-9._-]*/\S+)\s*$`,
    flags: '',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/models-opencode-2.2.6.txt`, version: '2.2.6', text: 'ollama/qwen3:8b', shows: 'A local model OpenCode found' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/models-opencode-2.2.6.txt`, version: '2.2.6', text: 'opencode/big-pickle', shows: "One of OpenCode's own built-in models" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'opencode.models.variants',
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.models.variants.title', defaultMessage: "Model list: a model's variants field", description: "An advanced setting's title (Settings → Advanced, under OpenCode): the field of OpenCode's model list that holds a model's variants." }),
    desc: msg({ id: 'settings.advanced.opencode.models.variants.desc', defaultMessage: "The field of a model in OpenCode's model list with its variants, which Combwork offers as its effort levels. Wrong, no effort is offered for OpenCode models.", description: 'What the advanced setting "Model list: a model\'s variants field" is for, and what goes wrong when it is wrong (Settings → Advanced, under OpenCode).' }),
    kind: 'field',
    default: 'variants',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/models-api-opencode-2.2.6.json`, version: '2.2.6', fields: ['capabilities', 'cost', 'enabled', 'id', 'limit', 'modelID', 'name', 'package', 'providerID', 'settings', 'status', 'time', 'variants'] }]
  },
  {
    id: 'opencode.models.variantId',
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.models.variantId.title', defaultMessage: "Model list: a variant's id field", description: "An advanced setting's title (Settings → Advanced, under OpenCode): the field of one of a model's variants that holds its id." }),
    desc: msg({ id: 'settings.advanced.opencode.models.variantId.desc', defaultMessage: "The field of a model's variant with its id, the effort level Combwork passes when an OpenCode session starts. Wrong, no effort is offered for OpenCode models.", description: 'What the advanced setting "Model list: a variant\'s id field" is for, and what goes wrong when it is wrong (Settings → Advanced, under OpenCode).' }),
    kind: 'field',
    default: 'id',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/models-api-opencode-2.2.6.json`, version: '2.2.6', fields: ['id', 'settings'] }]
  },
  {
    id: 'opencode.env.credentials',
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.env.credentials.title', defaultMessage: 'Credentials left out of OpenCode', description: "An advanced setting's title (Settings → Advanced, under OpenCode): the pattern of the environment variables' names Combwork leaves out." }),
    desc: msg({ id: 'settings.advanced.opencode.env.credentials.desc', defaultMessage: "The names of the environment variables Combwork leaves out of OpenCode while Keep other credentials from OpenCode is on: every variable OpenCode's providers read as a key or token, and the clouds' own (AWS, Azure, Google). Combwork's own variables are always kept. Wrong, a key set on this PC could reach an OpenCode agent unasked.", description: 'What the advanced setting "Credentials left out of OpenCode" is (Settings → Advanced, under OpenCode). Keep other credentials from OpenCode is the name of another setting; AWS, Azure and Google are names.' }),
    kind: 'pattern',
    default: String.raw`^(AWS_|AZURE_|AZD_|GOOGLE_|GCLOUD|CLOUDSDK_|VERTEX|OPENCODE_|XDG_)|_(API_?KEY|TOKEN|PAT|KEY|SECRET)$|^(CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_GATEWAY_ID|INFOMANIAK_PRODUCT_ID|WATSONX_AI_PROJECT_ID)$`,
    flags: 'i',
    applies: 'sessions',
    samples: [
      { from: `${FIX}/advanced/integrations-opencode-2.2.6.json`, version: '2.2.6', text: 'ANTHROPIC_API_KEY', shows: 'A key OpenCode reads from the environment' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/integrations-opencode-2.2.6.json`, version: '2.2.6', text: 'AWS_BEARER_TOKEN_BEDROCK', shows: 'A token OpenCode reads from the environment' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/integrations-opencode-2.2.6.json`, version: '2.2.6', text: 'GITHUB_TOKEN', shows: 'A token OpenCode reads for GitHub Copilot' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'opencode.ambient.integrations',
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.ambient.integrations.title', defaultMessage: "Providers using this PC's sign-ins", description: "An advanced setting's title (Settings → Advanced, under OpenCode): OpenCode's providers that can use a sign-in the PC already has." }),
    desc: msg({ id: 'settings.advanced.opencode.ambient.integrations.desc', defaultMessage: "OpenCode's providers that can use a sign-in this PC already has (an AWS profile, a gcloud login, the Azure CLI's), by their ids: Combwork denies each unless the account saved a credential for it. Wrong, an agent could use one of those sign-ins unasked.", description: 'What the advanced setting "Providers using this PC\'s sign-ins" is (Settings → Advanced, under OpenCode). AWS, gcloud and Azure CLI are names.' }),
    kind: 'list',
    default: ['amazon-bedrock', 'google-vertex', 'azure'],
    applies: 'sessions',
    samples: [
      { from: `${FIX}/advanced/integrations-opencode-2.2.6.json`, version: '2.2.6', text: '"id": "aws-profile"', shows: "Amazon Bedrock's AWS profile sign-in" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/integrations-opencode-2.2.6.json`, version: '2.2.6', text: '"id": "google-adc"', shows: "Google Vertex's gcloud sign-in" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'opencode.server.readySeconds',
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.server.readySeconds.title', defaultMessage: 'Server: time to start', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.opencode.server.readySeconds.desc', defaultMessage: "How long an OpenCode agent's private server gets to answer before the launch gives up and ends it. Too short, an agent on a slow PC doesn't start.", description: 'What the advanced setting "Server: time to start" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 120,
    min: 5,
    max: 300,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/help-opencode-2.2.6.txt`, version: '2.2.6', text: 'serve              Start the v2 API and web server', shows: 'The server each OpenCode agent runs privately' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // OpenCode's history (HI-2762, providers/opencode/history.ts): how often Combwork reads a running session, and repairs
  // the history of one it couldn't read.
  {
    id: 'opencode.history.pollSeconds',
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.history.pollSeconds.title', defaultMessage: 'History: check interval', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.opencode.history.pollSeconds.desc', defaultMessage: "How often Combwork checks a running OpenCode agent's session for changes, and reads it again when it changed, for its history, tokens and cost. Longer, they're behind for longer; shorter, more reads.", description: 'What the advanced setting "History: check interval" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 5,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/opencode/real-2.2.6/wire/session-after-turn.json`, version: '2.2.6', text: '"updated": 1794179626037', shows: "The session's time.updated, which each check compares with the one Combwork read last" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'opencode.history.repairMinutes',
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.history.repairMinutes.title', defaultMessage: 'History: repair interval', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.opencode.history.repairMinutes.desc', defaultMessage: "How often Combwork looks for OpenCode sessions whose history it couldn't read, and tries again for those whose OpenCode data changed since. Longer, a history stays incomplete for longer.", description: 'What the advanced setting "History: repair interval" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 1440,
    unit: 'min',
    applies: 'restart',
    samples: [{ from: `${FIX}/opencode/real-2.2.6/cli/session-export-absent.txt`, version: '2.2.6', text: 'Session not found:', shows: 'An export of a session that failed, which the history says and tries again' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'opencode.history.retryMinutes',
    group: 'opencode',
    title: msg({ id: 'settings.advanced.opencode.history.retryMinutes.title', defaultMessage: 'History: retry after', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.opencode.history.retryMinutes.desc', defaultMessage: "How long Combwork waits before trying again to read an OpenCode session's history it couldn't read, when nothing in that account's OpenCode data changed meanwhile.", description: 'What the advanced setting "History: retry after" is for (Settings → Advanced).' }),
    kind: 'number',
    default: 1440,
    min: 10,
    max: 43200,
    unit: 'min',
    applies: 'restart',
    samples: [{ from: `${FIX}/opencode/real-2.2.6/cli/session-export-absent.txt`, version: '2.2.6', text: 'Session not found:', shows: 'An export of a session that failed, which the history says and tries again' }] // i18n-ignore: a CLI's recorded text (#367)
  }
]
