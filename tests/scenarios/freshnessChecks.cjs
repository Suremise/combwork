// HI-2854 (HR2's round 1 finding 3): whether an agent was given a decision by a submit refused for it. Only the refusal
// for what it hadn't seen counts (its rule in the reply), and only when the decision's words are among the lines it
// gave, so a submit refused for anything else, or one whose list left the decision out or had other words, is not
// taken for the agent seeing it. Its own module so its unit test (tests/scenarioFreshness.test.ts) loads it alone.

/** The lines a refused submit gave of what the agent hadn't seen: a decision's or a comment of the user's. */
function unreadLines(error) {
  return String(error ?? '')
    .split(/\r?\n/)
    .filter((l) => /^(Decision \(|Comment from the user \()/.test(l))
}

/**
 * A cw_submit refused for submit.decisionsReceived, made after `from` and before `until` (ms), whose unread lines
 * give the decision `words` in full (a line ending with them).
 */
function refusedWithDecision(calls, words, from, until) {
  return (calls ?? []).some((x) => {
    if (x.tool !== 'cw_submit' || x.ok) return false
    const at = Date.parse(x.at)
    if (!(at > from && at < until)) return false
    if (!/\(submit\.decisionsReceived\)/.test(String(x.error ?? ''))) return false
    return unreadLines(x.error).some((l) => l.startsWith('Decision (') && l.endsWith(`: ${words}`))
  })
}

module.exports = { refusedWithDecision, unreadLines }
