// What a Codex code-mode script actually called (HI-2235). In code mode the model writes a script (its `exec` tool) that
// calls tools from code: tools.mcp__hive__hive_read_task(…), tools.exec_command({cmd}), tools.apply_patch(…). Hive's
// parser shows the script as one tool, Script, its input the code and its result what the code printed: a call written
// in it may never run, and a reply it never printed isn't there. Codex's rollout records each call the script made as it
// ends (an `item_completed` event: McpToolCall, CommandExecution, FileChange, ImageView…), with its arguments and its
// result. The scenario checks read those calls in the script's place, named as a direct call is, so the same check
// credits the same behaviour on every provider, and only for a call that ran.
const fs = require('fs')
const path = require('path')

/** The session's rollout in a Codex home (sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl), or null. */
function codexRollout(codexHome, sessionId) {
  if (!codexHome || !sessionId) return null
  const find = (dir, depth) => {
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const f = path.join(dir, e.name)
      const hit = e.isDirectory() ? (depth < 3 ? find(f, depth + 1) : null) : e.name.endsWith(`-${sessionId}.jsonl`) ? f : null
      if (hit) return hit
    }
    return null
  }
  return find(path.join(codexHome, 'sessions'), 0)
}

/** A shell command as the model wrote it: Codex runs it as [shell, -Command, cmd]. */
function commandText(command) {
  if (!Array.isArray(command)) return String(command ?? '')
  if (command.length === 3 && /^-(Command|c)$/i.test(String(command[1]))) return String(command[2])
  return command.map(String).join(' ')
}

/** A FileChange's changes as an apply_patch would have written them (what an Edit's input is from a script). */
function changesPatch(changes) {
  const lines = ['*** Begin Patch']
  for (const [file, c] of Object.entries(changes ?? {})) {
    if (c?.type === 'add') lines.push(`*** Add File: ${file}`, ...String(c.content ?? '').replace(/\n$/, '').split('\n').map((l) => `+${l}`))
    else if (c?.type === 'delete') lines.push(`*** Delete File: ${file}`)
    else lines.push(`*** Update File: ${file}`, ...(c?.move_path ? [`*** Move to: ${c.move_path}`] : []), String(c?.unified_diff ?? '').replace(/\n$/, ''))
  }
  lines.push('*** End Patch')
  return lines.join('\n')
}

/** The text of an MCP result's content (its text parts). */
const contentText = (content) => (Array.isArray(content) ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n') : '')

/** Items a script makes that are no tool call (the conversation's own records). */
const NOT_CALLS = /^(UserMessage|AgentMessage|Reasoning|ContextCompaction|HookPrompt|Plan|TodoList)$/

/**
 * One recorded call as a transcript tool ({ toolUseId, name, summary, input, result, isError, images }), named as Hive
 * names the same call made directly (mcp__<server>__<tool>, Shell, Edit, view_image), or null for an item that isn't one.
 */
function callTool(item) {
  const id = String(item.id ?? '')
  const base = { toolUseId: id, summary: '', images: [] }
  switch (item.type) {
    case 'McpToolCall': {
      const failed = item.status !== 'completed' || item.result?.isError === true || !!item.error
      const result = contentText(item.result?.content) || (item.error?.message ? String(item.error.message) : item.result ? JSON.stringify(item.result) : '')
      return { ...base, name: `mcp__${item.server}__${item.tool}`, input: JSON.stringify(item.arguments ?? {}, null, 2), result, isError: failed }
    }
    case 'CommandExecution': {
      const cmd = commandText(item.command)
      const code = typeof item.exit_code === 'number' ? item.exit_code : null
      return { ...base, name: 'Shell', summary: cmd.split('\n')[0].slice(0, 200), input: cmd, result: String(item.aggregated_output ?? ''), isError: item.status !== 'completed' || (code !== null && code !== 0) }
    }
    case 'FileChange':
      return { ...base, name: 'Edit', summary: Object.keys(item.changes ?? {}).join(', ').slice(0, 200), input: changesPatch(item.changes), result: [item.stdout, item.stderr].filter(Boolean).join('\n'), isError: item.status !== 'completed' }
    case 'ImageView':
      return { ...base, name: 'view_image', input: JSON.stringify({ path: String(item.path ?? '').replace(/^file:\/\/\/?/, '') }), result: '', isError: false }
    case 'WebSearch':
      return { ...base, name: 'WebSearch', input: String(item.query ?? item.action?.query ?? ''), result: '', isError: false }
    default: {
      if (!item.type || NOT_CALLS.test(item.type)) return null
      const rest = Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'id' && k !== 'type'))
      return { ...base, name: item.kind ? String(item.kind) : String(item.type), input: JSON.stringify(rest), result: '', isError: item.status !== undefined && item.status !== 'completed' }
    }
  }
}

/**
 * The calls each code-mode script made, from a rollout's text: { recorded, byScript: Map<exec call_id, tool[]> }.
 * `recorded`: this Codex records its calls as items (an `item_completed` event at all); with none, a script's calls are
 * unknown, not absent. A call ends inside its script's run (between the exec call and its output), or later, from a
 * command it left running (a `wait` call reads it on): either way it is the last script's. A direct call recorded as an
 * item too (its id a call's own) is the transcript's already, and left out.
 */
function scriptCalls(text) {
  const lines = []
  for (const s of String(text ?? '').split('\n')) {
    if (!s.trim()) continue
    try {
      lines.push(JSON.parse(s))
    } catch {
      // A line still being written.
    }
  }
  const callIds = new Set(lines.filter((l) => l.type === 'response_item' && String(l.payload?.type ?? '').endsWith('call')).map((l) => String(l.payload.call_id ?? '')))
  const byScript = new Map()
  let recorded = false
  let last = null
  for (const l of lines) {
    const p = l.payload ?? {}
    if (l.type === 'response_item' && p.type === 'custom_tool_call' && p.name === 'exec') {
      last = String(p.call_id ?? '')
      byScript.set(last, [])
    } else if (l.type === 'event_msg' && p.type === 'item_completed' && p.item) {
      recorded = true
      const tool = callIds.has(String(p.item.id ?? '')) ? null : callTool(p.item)
      if (tool && last !== null) byScript.get(last).push(tool)
    }
  }
  return { recorded, byScript }
}

/**
 * A transcript's items with each code-mode script (Hive's Script, or the Edit it makes of one that patches) replaced by
 * the calls it made, in order, each a tool item of its own; the script itself is kept as a `script` item (no tool: its
 * code names calls, which are mentions). A Script whose calls aren't known (no rollout, a rollout that records no calls,
 * or one without that script) is a `script` item too, with none (`unknown`): neither its code nor what it printed is
 * evidence of a call (HI-2235, HR1 round 1), so what it ran is unobservable, never credited. Calls of a script the
 * transcript doesn't show come last. `rolloutText`: the rollout's text, or null when there is none.
 */
function withScriptCalls(items, rolloutText) {
  const { recorded, byScript } = scriptCalls(rolloutText)
  const placed = new Set()
  let scripts = 0
  let calls = 0
  let unknown = 0
  const out = []
  for (const it of items) {
    const id = it.kind === 'tool' ? it.tool?.toolUseId : undefined
    const nested = recorded && id !== undefined ? byScript.get(String(id)) : undefined
    if (nested) {
      placed.add(String(id))
      scripts++
      calls += nested.length
      out.push({ ...it, kind: 'script' })
      for (const tool of nested) out.push({ kind: 'tool', timestamp: it.timestamp ?? null, tool, script: String(id) })
    } else if (it.kind === 'tool' && it.tool?.name === 'Script') {
      unknown++
      out.push({ ...it, kind: 'script', unknown: true })
    } else out.push(it)
  }
  if (recorded) {
    for (const [id, nested] of byScript) {
      if (placed.has(id)) continue
      calls += nested.length
      for (const tool of nested) out.push({ kind: 'tool', timestamp: null, tool, script: id })
    }
  }
  return { items: out, scripts, calls, unknown }
}

module.exports = { codexRollout, scriptCalls, withScriptCalls, callTool }
