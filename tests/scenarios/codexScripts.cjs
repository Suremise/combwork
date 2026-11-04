// What a Codex code-mode script actually called (HI-2235, HI-2246). In code mode the model writes a script (its `exec`
// tool) that calls tools from code: tools.mcp__combwork__cw_read_task(…), tools.exec_command({cmd}), tools.apply_patch(…).
// A call written in it may never run, and a reply it never printed isn't in its output. Codex's rollout records each
// call the script made as it ends, and Hive's parser gives each script those calls (`tool.calls`, HI-2240:
// src/main/providers/codex/scriptCalls.ts), named as the same call made directly is, in the script it started in. The
// scenario checks read those calls in the script's place, so the same check credits the same behaviour on every
// provider, and only for a call that ran.

/**
 * A transcript's items (as `transcript:read` gives them, each tool read whole) with each code-mode script (Hive's
 * Script, or the Edit it makes of one that patches) replaced by the calls it made, in order, each a tool item of its
 * own; the script itself is kept as a `script` item (no tool: its code names calls, which are mentions). A script whose
 * calls aren't known (its Codex records none: no `calls`), whatever Hive shows it as (Hive marks every one `script`, an
 * Edit of a patch it may never have applied too: HR1 on HI-2246), is a `script` item too, with none (`unknown`): neither
 * its code nor what it printed is evidence of a call (HI-2235, HR1 round 1), so what it ran is unobservable, never
 * credited. A direct call (an Edit from apply_patch called directly) is no script, and stays a tool.
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
    } else if (it.kind === 'tool' && (it.tool?.script === true || it.tool?.name === 'Script')) {
      // Any code-mode script, whatever Hive shows it as (an Edit of a patch it may never have applied, HR1 on HI-2246).
      unknown++
      out.push({ ...it, kind: 'script', unknown: true })
    } else out.push(it)
  }
  return { items: out, scripts, calls, unknown }
}

/** Whether a tool item was cut short for display, itself or any call of a script's: the harness reads those whole. */
const clipped = (tool) => !!(tool && (tool.inputLength || tool.resultLength || (Array.isArray(tool.calls) && tool.calls.some(clipped))))

/**
 * The transcript's items (`transcript:read`'s, shortened for display) with each tool cut short, itself or a call of a
 * script's, read whole: `whole(itemId)` is `transcript:tool`'s (the parser's own tool, every call in full), or null when
 * it can't be read (the item kept as it is). In place; the items, for chaining.
 */
async function readWhole(items, whole) {
  for (const it of items) {
    if (it.kind === 'tool' && clipped(it.tool)) it.tool = (await whole(it.id).catch(() => null)) ?? it.tool
  }
  return items
}

module.exports = { withScriptCalls, clipped, readWhole }
