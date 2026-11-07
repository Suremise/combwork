// Which scenarios run on which fake provider (HI-2662). Combwork's workflow doesn't change by provider, so the common set
// (every scenario) runs once, on the fake Claude Code (`fake`). The fake Codex and the real Copilot CLI offline
// (`fake-codex`, `fake-copilot`) run the delivery contracts: the scenarios whose result depends on how that CLI is given
// and gives back what Combwork sends (its skills, tool calls and replies, prompts typed into its pane, hook context, its
// shell and process tree, its folder, a fresh launch). Each id here says which of those it exercises; a scenario whose
// own definition depends on the provider (providerSensitive) must be here (tests/scenarioSelection.test.ts). --every runs the whole set on any provider,
// and --only a named one on any provider, for a doubt about it there.

/** The delivery contracts: id → what of the CLI's delivery it exercises. Sorted by id. */
const DELIVERY = {
  'assistant-add-agent-connection': 'a new agent on a connection: its launch and environment, per provider',
  'assistant-agent-watch': "an agent watch (cw_wait_for_agents): its wake typed into the Assistant's pane when the agent is done",
  'assistant-journal-recall': "a fresh session's start: the state view delivered in its first context",
  'assistant-message-watching': 'a message typed into a watching agent wakes it',
  'card-detail': "a tool's reply, read back exactly as the CLI shows it",
  'card-loop-blocked': 'a card blocked while its reviewer waits: the wake and the watch as the CLI receives them',
  'card-loop-lane-next': "the next card's doorbell, typed into the pane after a turn ends",
  'card-loop-loop-wake': "Combwork's own loop wake typed into a reviewer with no watch",
  'card-loop-merge-refused': "a commit refused by the repository's pre-commit hook, as the CLI's shell reports it",
  'card-loop-submit-watch': "the watch Combwork keeps after a submission: its wake typed into the pane",
  'coordinator-lanes-to-end': "lane watches' real wakes as each lane ends, typed into the Assistant's pane one after another",
  'decision-while-waiting': 'a decision delivered to an agent that ended its turn: the wake typed in',
  'edited-skill': "an edited workspace skill: the version the CLI is given",
  'inbox-ack-and-read': "a second message while acting on the first: the doorbell and the inbox calls",
  'inbox-act-then-ack': "an idle agent's doorbell: typed into its pane, then cw_inbox",
  'inbox-rebrief': 'a re-brief told at the next tool call: the hook context the CLI shows',
  'intent-submit-commit': "committing and submitting through the CLI's shell",
  'isolated-check': "cw-progress --check --isolated through the CLI's shell",
  'list-compact': "a tool listing's reply as the CLI shows it",
  'long-doc-section': 'the outline and section tools, their replies read back',
  'missing-skill': 'a deleted workspace skill: what the CLI is given without it',
  'oversize-skill': "a skill too big to deliver: the launch's delivery count",
  'probe-outside-project': "the CLI's own folders (.codex, .claude) kept clean by a probe",
  'progress-background': "a background command in the CLI's shell, through cw-progress",
  'progress-long-command': "a long command in the CLI's shell, through cw-progress",
  'raw-api': "the API token's file in the CLI's environment, and its shell's HTTP call",
  'review-decision-next-round': 'a wake left by setup, read in the pane before the prompt is typed (beforePrompt)',
  'review-in-copy': "a review copy as the CLI's working folder for its commands",
  'skill-changed': 'a skill edited before launch: the revision the CLI is given',
  'skill-reference-read': "a skill's reference file read through the CLI's file tools",
  'skill-unchanged': "skills from the launch cache: what the CLI is given",
  'watcher-stopped': "a watcher started in the CLI's shell, and its process tree once stopped",
  'work-on-card': "the whole card: the skill read, the intents called and committed through the CLI's shell"
}

/**
 * Whether a scenario's own definition depends on the provider, so it must be a delivery contract (HR3's HI-2662 round 1):
 * a function-valued fakeSkips (its skips by provider, whatever its parameter is called); a fakeWakes, beforeLaunch or
 * beforePrompt (the launch's and the prompt's timing, which each CLI meets its own way); or the word provider anywhere
 * in its callbacks (`c.provider`). A lexical check of the scenario's own fields: what a helper it calls does with the
 * provider isn't seen, so the list's reasons are reviewed by hand too.
 */
function providerSensitive(s) {
  if (typeof s.fakeSkips === 'function') return true
  if (['fakeWakes', 'beforeLaunch', 'beforePrompt'].some((k) => typeof s[k] === 'function')) return true
  return Object.values(s).some((v) => typeof v === 'function' && /\bprovider\b/.test(String(v)))
}

/** The fake providers that run only the delivery contracts unless --every or --only says otherwise. */
const DELIVERY_PROVIDERS = ['fake-codex', 'fake-copilot']

/**
 * The scenarios a run takes, in the set's order: --only's (any provider; unknown ids are the runner's to refuse); else, on a
 * delivery provider without --every, the delivery contracts; else all of them (the fake Claude Code's common set, and
 * model trials, which pick with --only or --random).
 */
function scenarioSet(scenarios, provider, { only = [], every = false } = {}) {
  if (only.length) return scenarios.filter((s) => only.includes(s.id))
  if (DELIVERY_PROVIDERS.includes(provider) && !every) return scenarios.filter((s) => Object.prototype.hasOwnProperty.call(DELIVERY, s.id))
  return scenarios
}

module.exports = { DELIVERY, DELIVERY_PROVIDERS, providerSensitive, scenarioSet }
