// What a Codex code-mode script actually called (HI-2235, HI-2246). In code mode the model writes a script (its `exec`
// tool) that calls tools from code: tools.mcp__hive__hive_read_task(…), tools.exec_command({cmd}), tools.apply_patch(…).
// A call written in it may never run, and a reply it never printed isn't in its output. Codex's rollout records each
// call the script made as it ends, and Hive's parser gives each script those calls (`tool.calls`, HI-2240:
// src/main/providers/codex/scriptCalls.ts), named as the same call made directly is, in the script it started in. The
// scenario checks read those calls in the script's place, so the same check credits the same behaviour on every
// provider, and only for a call that ran.

/**
 * A transcript's items (as `transcript:read` gives them, each tool read whole) with each code-mode script (Hive's
 * Script, or the Edit it makes of one that patches) replaced by the calls it made, in order, each a tool item of its
 * own; the script itself is kept as a `script` item (no tool: its code names calls, which are mentions). A Script whose
 * calls aren't known (its Codex records none: no `calls`) is a `script` item too, with none (`unknown`): neither its
 * code nor what it printed is evidence of a call (HI-2235, HR1 round 1), so what it ran is unobservable, never credited.
 */
function withScriptCalls(items) {
  let scripts = 0
  let calls = 0
  let unknown = 0
  const out = []
  for (const it of items) {
    const nested = it.kind === 'tool' && Array.isArray(it.tool?.calls) ? it.tool.calls : null
    const id = it.kind === 'tool' ? String(it.tool?.toolUseId ?? '') : ''
    if (nested) {
      scripts++
      calls += nested.length
      out.push({ ...it, kind: 'script' })
      for (const tool of nested) out.push({ kind: 'tool', timestamp: it.timestamp ?? null, tool, script: id })
    } else if (it.kind === 'tool' && it.tool?.name === 'Script') {
      unknown++
      out.push({ ...it, kind: 'script', unknown: true })
    } else out.push(it)
  }
  return { items: out, scripts, calls, unknown }
}

/** Whether a tool item was cut short for display, itself or any call of a script's: the harness reads those whole. */
const clipped = (tool) => !!(tool && (tool.inputLength || tool.resultLength || (Array.isArray(tool.calls) && tool.calls.some(clipped))))

module.exports = { withScriptCalls, clipped }
