import { advanced } from '../../advanced'
import type { BackgroundTaskEvent } from '../types'

/**
 * One `exec` script waiting for its output: its source, how many exec_command calls it writes, the commands that
 * ended within it, and whether a command ended then that can't be told apart from its own (so it is unclear).
 */
type OpenCall = { input: string; code: string; ended: string[]; unclear: boolean }

/** What the parser keeps between reads of one launch's rollout (a script is written before its output). */
export interface CodexBackgroundMemo {
  open: Map<string, OpenCall>
  /** Ids taken as running from what a script or Codex printed (they end by their process_id). */
  known: Set<string>
  /** Commands taken as running from a simple script that printed no id: its source, by stand-in id. */
  unnamed: Map<string, string>
  /** Subagents seen to end (by thread id), so one started again (resume_agent) counts again (#1584). */
  subagentsEnded: Set<string>
}

const MAX_KEPT = 50

export function codexBackgroundMemo(): CodexBackgroundMemo {
  return { open: new Map(), known: new Set(), unnamed: new Map(), subagentsEnded: new Set() }
}

/** Drops the oldest entry past MAX_KEPT (a call whose output, or a command whose end, never came). */
function bound(kept: Map<string, unknown> | Set<string>): void {
  if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!)
}

/** Whether a script's source holds this command (as written, or as a JS/JSON string literal writes it). */
const runs = (input: string, command: string): boolean => !!command && (input.includes(command) || input.includes(JSON.stringify(command).slice(1, -1)))

/** A script's code without its string literals (each left as "") and comments: what runs, not what it says. */
const codeOf = (input: string): string =>
  input.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('/') ? ' ' : '""'))

const CALL = /\btools\s*\.\s*exec_command\s*\(/g

/** How many exec_command calls a script's code writes (none in a string or a comment). */
const callSites = (code: string): number => (code.match(CALL) ?? []).length

/**
 * Whether a script runs its one exec_command exactly once: its only call is a statement of its own at the top level
 * (`await tools.exec_command(…)`, or `const r = await …`), and nothing in its code repeats, skips, defers or leaves
 * code (loops, conditions, functions, try, return, throw). `??` and `?.` (printing the result) are fine.
 */
function runsOnce(code: string): boolean {
  if (callSites(code) !== 1) return false
  if (/\b(?:for|while|do|if|else|switch|case|try|catch|finally|function|return|throw|break|continue|yield|class)\b|=>|(?<!\?)\?(?![?.])|&&|\|\||\.(?:map|forEach|filter|reduce|some|every|then|catch)\s*\(/.test(code)) return false
  const at = code.search(CALL)
  let depth = 0
  for (const ch of code.slice(0, at)) depth += '([{'.includes(ch) ? 1 : ')]}'.includes(ch) ? -1 : 0
  const statement = code.slice(0, at).split(/[;\n{}]/).pop() ?? ''
  return depth === 0 && /^\s*(?:(?:const|let|var)\s+[\w$]+\s*=\s*)?(?:await\s+)?$/.test(statement)
}

/** A session id in exec_command's result: a whole number (JSON, quoted or not) or the older text. */
function sessionId(text: string): string | undefined {
  const m = /"session_id"\s*:\s*(?:(\d+)(?![\w.-])|"(\d+)")/.exec(text)
  return m?.[1] ?? m?.[2] ?? /Process running with session ID (\d+)/.exec(text)?.[1]
}

/**
 * Codex's background terminals in rollout lines. A command still running when exec_command returns gives a
 * session_id instead of an exit_code (older Codex: "Process running with session ID n"); Codex records its
 * end as an item_completed CommandExecution with that process_id. Codex isn't told when one ends.
 *
 * Code mode (Codex 0.160): commands run inside an `exec` script (`tools.exec_command({...})`) that prints what the
 * model chooses, and Codex records no start, only each command's end, so a start needs evidence (#162):
 * - an id the output shows: the result's session_id, or a script that reads session_id and printed only numbers
 *   (`text(r.session_id)`), not one of its commands that ended within it; it ends by that process_id;
 * - else a script that runs its one exec_command once (runsOnce) and completed with no command ended: Codex writes
 *   the end of every command that ends within a script before the script's output, so it is still running. It
 *   gets a stand-in id and ends with the CommandExecution of the same command text.
 * Anything less clear (a loop, a condition, a failed or aborted script, an end that could be its own) counts nothing:
 * a command missed rather than one counted that isn't running.
 *
 * Subagents (#1584, Codex 0.164's spawn_agent): one runs on after the turn that spawned it ends. The parent's rollout
 * records a SubAgentActivity item `started` and, when it ends, `completed` (Codex writes it under the spawning turn's
 * id and starts no turn for it), by its thread id; its task name (agent_path) describes it. Any other kind ends it too
 * (one missed rather than one counted that has ended). The item, its kind and fields are advanced settings (codex.subagent.*).
 */
export function codexBackgroundTasks(appended: string, memo: CodexBackgroundMemo = codexBackgroundMemo()): BackgroundTaskEvent[] {
  const out: BackgroundTaskEvent[] = []
  const start = (id: string, at: number): void => {
    memo.known.add(id)
    bound(memo.known)
    out.push({ kind: 'start', id, at })
  }
  const activity = advanced.get<string>('codex.subagent.item')
  const startedKind = advanced.get<string>('codex.subagent.started')
  const threadField = advanced.get<string>('codex.subagent.threadField')
  const taskField = advanced.get<string>('codex.subagent.taskField')
  for (const line of appended.split('\n')) {
    if (!/session_id|session ID|process_id|custom_tool_call/.test(line) && !line.includes(activity)) continue
    let o: Record<string, any>
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(o.timestamp) || Date.now()
    const p = o.payload
    if (!p || typeof p !== 'object') continue
    const sub = p.item
    if (o.type === 'event_msg' && p.type === 'item_completed' && sub?.type === activity && typeof sub[threadField] === 'string' && sub[threadField]) {
      const id: string = sub[threadField]
      if (sub.kind === startedKind) {
        const again = memo.subagentsEnded.delete(id)
        out.push({ kind: 'start', id, at, type: 'subagent', ...(typeof sub[taskField] === 'string' ? { description: sub[taskField] } : {}), ...(again ? { resumed: true as const } : {}) })
      } else {
        memo.subagentsEnded.add(id)
        bound(memo.subagentsEnded)
        out.push({ kind: 'end', id, at })
      }
      continue
    }
    if (o.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'CommandExecution' && p.item.process_id != null) {
      const pid = String(p.item.process_id)
      out.push({ kind: 'end', id: pid, at })
      // A command known by its id is that one, and says nothing about any other.
      if (memo.known.delete(pid)) continue
      const command = Array.isArray(p.item.command) ? String(p.item.command[p.item.command.length - 1] ?? '') : ''
      const calls = [...memo.open.values()]
      const own = calls.find((c) => runs(c.input, command))
      if (own) {
        own.ended.push(pid)
        continue
      }
      const unnamed = [...memo.unnamed].find(([, input]) => runs(input, command))?.[0]
      if (unnamed) {
        memo.unnamed.delete(unnamed)
        out.push({ kind: 'end', id: unnamed, at })
        continue
      }
      // Whose end it is can't be told (a command whose text a script built): any script running now is unclear.
      for (const c of calls) c.unclear = true
      continue
    }
    if (o.type === 'response_item' && p.type === 'custom_tool_call' && p.name === 'exec' && typeof p.input === 'string' && p.call_id) {
      const code = codeOf(p.input)
      if (callSites(code)) {
        memo.open.set(String(p.call_id), { input: p.input, code, ended: [], unclear: false })
        bound(memo.open)
      }
      continue
    }
    if (p.type !== 'custom_tool_call_output' && p.type !== 'function_call_output') continue
    const call = p.call_id != null ? memo.open.get(String(p.call_id)) : undefined
    if (call) memo.open.delete(String(p.call_id))
    const parts: string[] = typeof p.output === 'string' ? [p.output] : Array.isArray(p.output) ? p.output.map((x: any) => (typeof x?.text === 'string' ? x.text : '')) : []
    // A script whose one command ran once and ended within it started nothing, whatever it printed (a file it read).
    const allEnded = !!call && runsOnce(call.code) && call.ended.length > 0
    let started = 0
    for (const text of parts) {
      // One result per part: running (a session id) or done (an exit code, which may name the session too).
      const id = sessionId(text)
      if (!id) continue
      if (/"exit_code"\s*:|Process exited with code/.test(text)) out.push({ kind: 'end', id, at })
      else if (!allEnded && !call?.ended.includes(id)) {
        start(id, at)
        started++
      }
    }
    if (!call || started || !/^Script completed\b/.test(parts[0] ?? '')) continue
    // What the script printed after Codex's header: only numbers, from a script that reads session_id and none of
    // whose commands ended within it (so none printed a finished command's output), are its ids.
    const whole = parts.join('\n')
    const header = whole.indexOf('Output:\n')
    const printed = header < 0 ? '' : whole.slice(header + 'Output:\n'.length).trim() // i18n-ignore: Codex's own output marker, matched
    if (call.ended.length || call.unclear) continue
    if (/\bsession_id\b/.test(call.code) && /^\d+(?:[\s,]+\d+)*$/.test(printed)) {
      for (const id of new Set(printed.split(/[\s,]+/))) start(id, at)
      continue
    }
    if (runsOnce(call.code)) {
      const id = `${p.call_id}#0`
      memo.unnamed.set(id, call.input)
      bound(memo.unnamed)
      out.push({ kind: 'start', id, at })
    }
  }
  return out
}
