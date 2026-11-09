// Which fake providers run each scenario (HI-2663). A fake run (fake, fake-codex, fake-copilot, fake-antigravity, fake-opencode) tests Combwork's
// machinery: each fake sends `cw TOOL {json}` to the same Combwork MCP server (tests/e2e/fake-bridge.cjs; Copilot's own
// MCP client, tests/e2e/fake-copilot-api.cjs), so what a call does after the server is the same for every provider.
// Running a scenario on all three proves something only where its fake script exercises what differs per CLI: skill
// delivery and reading, launch guidance and modes, the shell, lines Combwork types in, hooks and notices, launch, slot
// and copy folders. A model trial (claude-code, codex) tests what agents do, and runs every scenario, whatever is here.
//
// A scenario not named here runs on all three fakes: a new one keeps every provider until it is placed. The lists come
// from HI-2663's per-scenario ownership matrix (fakeScope-matrix.md: each live check's owner, or why it holds by
// construction on a fake). tests/scenarioScope.test.ts checks every name is a scenario and the selection rules.
//
// - FAKE_CLAUDE_ONLY: their checks read the board, facts, lanes, the MCP log or Combwork's own records, after the
//   server. What each exercises per provider (the skill it reads, its cw_ tools, a shell command) is still exercised on
//   Codex and Copilot by a scenario on all three (work-on-card, review-card, card-loop-lane…, and tool-sweep for the cw_
//   tools only these call) and the MCP path's own tests (codex.test.ts, carryingon.cjs, copilot.test.ts, copilot.cjs).
//   Loss of work, crash, storage or settings races and file safety stay on all three (not listed here).
// - MODEL_TRIALS_ONLY: on a fake every live check holds by construction (it reads only what the fake script says, or
//   state the script can't change), or repeats another scenario's script; each check's deterministic owner is named in
//   the matrix. No fake runs them; model trials do.
// - NOT_A_TRIAL: a check of the fakes' plumbing only, with nothing for a model to decide: model trials leave it out.

const FAKE_CLAUDE_ONLY = [
  // Review, a decision, the inbox: the board and facts after the server.
  'review-asks-user', 'test-waits-write', 'test-waits-review', 'review-record-trusted', 'review-record-stale', 'fix-returned-card', 'done-card-more-work', 'review-against-decision', 'review-decision-next-round', 'review-passed',
  'card-decision', 'decision-before-taking', 'inbox-spoofed-user', 'inbox-destructive', 'inbox-stale', 'inbox-ack-and-read',
  // Board tools, reads and skills already read on all three elsewhere.
  'merged-to-done', 'tag-cards', 'progress-log', 'card-detail', 'card-read-first', 'card-read-first-broken', 'long-doc-section', 'list-compact', 'list-detail', 'skill-unchanged',
  // The card loop's rules (its delivery: card-loop-lane, card-loop-submit-watch, card-loop-lane-next, card-loop-design-check).
  'card-loop-rounds', 'card-loop-recurring', 'card-loop-recurring-review', 'card-loop-return', 'card-loop-commit', 'card-loop-uncommitted', 'card-loop-lane-defaults', 'card-loop-lane-override', 'card-loop-lane-join',
  'card-loop-already-in-review', 'card-loop-two-cards', 'card-loop-disputed', 'card-loop-design-first', 'card-loop-follow-up', 'card-loop-follow-up-check', 'card-loop-ask-assistant', 'card-loop-released', 'card-loop-loop-wake',
  // Wakes are the fake Claude Code's alone (harness.cjs: fakeWakes): on the others these check only their fixture.
  'card-loop-blocked', 'coordinator-lanes-to-end',
  // Overrides, intents, old moves, presets.
  'assistant-override-reason', 'assistant-override-none', 'assistant-override-unneeded', 'intent-put-back', 'intent-submit-commit', 'intent-review-request', 'pool-reviewer-wake', 'old-move-submit', 'old-move-review', 'preset-solo-card', 'preset-pair-lane',
  // The Assistant's board work.
  'assistant-dispatch', 'assistant-reply-decision', 'assistant-doing-nobody', 'assistant-decision-answers', 'assistant-decision-answers-one', 'assistant-card-question', 'assistant-look-lanes', 'assistant-lane-reorder-now', 'assistant-bulk-move', 'assistant-retarget-release',
  // The coordinator and fresh starts.
  'coordinator-wake-failed', 'coordinator-recurring-finding', 'coordinator-wake-question', 'coordinator-build-beside-lanes', 'coordinator-reassign', 'coordinator-follow-up', 'coordinator-one-card-lane', 'coordinator-start-reviewer',
  'coordinator-lanes-only-watch', 'coordinator-ten-rounds', 'coordinator-no-code-done', 'coordinator-merge-due', 'coordinator-fact-before-asking', 'coordinator-look-before-asking', 'fresh-start-lane-running', 'fresh-start-question-waits',
  // Modes: each mode's launch text on all three is mode-coordinator-plans's; the others' differ only in the mode's name.
  'mode-planner-plans', 'mode-qa-triager-plans', 'mode-release-manager-plans', 'qa-triage-duplicate'
]

const MODEL_TRIALS_ONLY = [
  'pick-up-named', 'hold-skipped', 'assistant-plan', 'assistant-look', 'coordinator-relayed-ok', 'fresh-start-solo-done', 'fresh-start-lanes-ended', 'review-screenshot-report', 'prioritise',
  'follow-up-title', 'assistant-follow-up-title', 'progress-background', 'mode-coordinator-coordinates', 'mode-planner-coordinates', 'mode-qa-triager-coordinates', 'mode-release-manager-coordinates'
]

const NOT_A_TRIAL = ['tool-sweep']

const FAKES = ['fake', 'fake-codex', 'fake-copilot', 'fake-antigravity', 'fake-opencode']

/**
 * A fake provider whose runs wait for a card, every scenario left out with why (HI-2761). fake-opencode waited for HI-2760
 * (its agents' turn status: the harness knows a prompt was taken from the agent's status), which lifted it. None waits now.
 */
const PROVIDER_WAITS = {}

/**
 * Scenarios a fake provider leaves out until a card lands, each group with why (HI-2760). fake-opencode's own run
 * (2026-11-09T01-59-16-fake-opencode, then 02-32-38 for those not about the transcript). The ones that read the agent's
 * transcript ran once HI-2762 gave OpenCode agents their history (2026-11-09T02-52-58-fake-opencode).
 * - an OpenCode Assistant gets no state view at its start: HI-2771;
 * - an OpenCode reviewer is lent no review copy (extraDirs not verified): HI-2772.
 */
const SCENARIO_WAITS = {
  'fake-opencode': [
    { why: "waits for HI-2772: an OpenCode reviewer is lent no review copy, as OpenCode's extraDirs isn't verified (tests/scenarios/fakeScope.cjs)", ids: ['review-in-copy'] },
    { why: "waits for HI-2771: an OpenCode Assistant gets no state view at its start (tests/scenarios/fakeScope.cjs)", ids: ['assistant-journal-recall'] }
  ]
}

/** Why a provider leaves this scenario out until a card lands (SCENARIO_WAITS), or null. */
const waitOf = (providerKey, id) => (SCENARIO_WAITS[providerKey] ?? []).find((w) => w.ids.includes(id))?.why ?? null

/** The fakes a scenario runs on: every fake, ['fake'], or [] (model trials only). */
function fakesFor(id) {
  if (MODEL_TRIALS_ONLY.includes(id)) return []
  if (FAKE_CLAUDE_ONLY.includes(id)) return ['fake']
  return [...FAKES]
}

/** What's wrong with the lists, against the scenarios' ids: [] when nothing. */
function scopeProblems(ids) {
  const named = [...FAKE_CLAUDE_ONLY, ...MODEL_TRIALS_ONLY, ...NOT_A_TRIAL]
  const waiting = Object.entries(SCENARIO_WAITS).flatMap(([p, ws]) => ws.flatMap((w) => w.ids.map((id) => ({ p, id }))))
  return [
    ...waiting.filter((w) => !ids.includes(w.id)).map((w) => `${w.id}: no such scenario (${w.p}'s waits)`),
    ...waiting.filter((w, i) => waiting.findIndex((x) => x.p === w.p && x.id === w.id) !== i).map((w) => `${w.id}: listed twice (${w.p}'s waits)`),
    ...waiting.filter((w) => !fakesFor(w.id).includes(w.p)).map((w) => `${w.id}: ${w.p} doesn't run it anyway (${w.p}'s waits)`),
    ...named.filter((id) => !ids.includes(id)).map((id) => `${id}: no such scenario`),
    ...named.filter((id, i) => named.indexOf(id) !== i).map((id) => `${id}: listed twice`),
    ...NOT_A_TRIAL.filter((id) => MODEL_TRIALS_ONLY.includes(id)).map((id) => `${id}: runs nowhere (neither a model trial nor on a fake)`)
  ]
}

/**
 * The scenarios a run takes, for a provider (its key: fake, fake-codex, fake-copilot, fake-antigravity, fake-opencode, claude-code, codex): { run, excluded }.
 * listed: the scenarios asked for (all, or --only's). excluded: [{ id, why }], those a run of this provider leaves out,
 * each to be said (never silently dropped), with where it does run.
 */
function selectFor(listed, providerKey) {
  const fake = FAKES.includes(providerKey)
  const run = []
  const excluded = []
  for (const s of listed) {
    if (PROVIDER_WAITS[providerKey]) excluded.push({ id: s.id, why: PROVIDER_WAITS[providerKey] })
    else if (fake) {
      const on = fakesFor(s.id)
      const wait = waitOf(providerKey, s.id)
      if (on.includes(providerKey) && wait) excluded.push({ id: s.id, why: wait })
      else if (on.includes(providerKey)) run.push(s)
      else excluded.push({ id: s.id, why: on.length ? `runs on ${on.join(', ')} only (tests/scenarios/fakeScope.cjs): --provider ${on[0]}` : 'model trials only: no fake runs it (tests/scenarios/fakeScope.cjs)' })
    } else if (NOT_A_TRIAL.includes(s.id)) excluded.push({ id: s.id, why: "the fakes' plumbing only: model trials leave it out (tests/scenarios/fakeScope.cjs)" })
    else run.push(s)
  }
  return { run, excluded }
}

module.exports = { FAKES, PROVIDER_WAITS, SCENARIO_WAITS, FAKE_CLAUDE_ONLY, MODEL_TRIALS_ONLY, NOT_A_TRIAL, fakesFor, scopeProblems, selectFor }
