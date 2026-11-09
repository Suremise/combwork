// opencodereal-dirs.cjs's reading of a session's record and its end (HI-2772), apart so tests/opencodeDirsProbe.test.ts
// checks them without a model: the record Combwork mirrors from OpenCode's server comes in as it can (a turn's user
// message before its tool results), and a probe the model never tried isn't a pass.
const fs = require('fs')
const path = require('path')

/** A session's record as Combwork keeps it (the account's combwork-sessions/<id>.jsonl): its messages in order. */
function recordOf(accountHome, sessionId) {
  const file = path.join(accountHome, 'combwork-sessions', `${sessionId}.jsonl`)
  if (!sessionId || !fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => {
    try {
      const x = JSON.parse(l)
      return x.type === 'combwork.message' ? [x.message] : []
    } catch {
      return []
    }
  })
}

/**
 * The tool calls of the turn a user message holding `nonce` started (its assistant messages up to the next user
 * message), or null while that user message isn't in the record.
 */
function toolsOfTurn(messages, nonce) {
  const at = messages.findIndex((m) => m.type === 'user' && String(m.text ?? '').includes(nonce))
  if (at < 0) return null
  const next = messages.findIndex((m, i) => i > at && m.type === 'user')
  return messages.slice(at + 1, next < 0 ? undefined : next).flatMap((m) => (m.content ?? []).filter((c) => c.type === 'tool')).map((c) => ({ name: c.name, status: c.state?.status ?? null, input: c.state?.input ?? null, result: (c.state?.content ?? []).map((x) => x.text ?? '').join('\n').slice(0, 400), error: c.state?.error?.message ?? null }))
}

/** A tool call that has ended (completed or failed), not one still running. */
const ended = (t) => t.status === 'completed' || t.status === 'error'

/** A path as a tool's input or the probe gives it: either slash, any case, no trailing separator. */
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
/** A tool call on `file` (its input's path, as 2.2.6's read and write give it: `path`, or `filePath`). */
const on = (t, file) => samePath(t.input?.path ?? t.input?.filePath, file)
/** The read of the attempt's own file that has ended (another file's read, say AGENTS.md, never counts). */
const readOf = (file) => (tools) => tools.find((t) => t.name === 'read' && ended(t) && on(t, file)) ?? null
/** A write (or edit, patch) of the attempt's own file that has ended. */
const writeOf = (file) => (tools) => tools.find((t) => /^(write|edit|patch)$/.test(t.name) && ended(t) && on(t, file)) ?? null

/**
 * The turn's tools once `ready(tools)` holds of what the record has for it, polled with `until(fn, ms)` (lib.until);
 * at the bound, what it had (null: not even the turn's user message), for the caller to call it not tried.
 */
async function turnTools(read, nonce, ready, until, ms) {
  let last = null
  const got = await until(() => {
    last = toolsOfTurn(read(), nonce)
    return last && ready(last) ? last : null
  }, ms)
  return got ?? last
}

/**
 * The suite's last line and exit code: failed checks fail it; with none, a step the model never tried makes the run
 * SKIPPED (the runner's own non-pass, never `environment:`, which is for a missing CLI or model), else it passed.
 */
function ending({ failed, inconclusive }) {
  if (failed) return { line: `${failed} check(s) failed`, code: 1 }
  if (inconclusive.length) return { line: `SKIPPED inconclusive: the model never tried ${inconclusive.join('; ')} in its prompts, so nothing is proved`, code: 0 }
  return { line: 'all checks passed', code: 0 }
}

module.exports = { recordOf, toolsOfTurn, ended, samePath, readOf, writeOf, turnTools, ending }
