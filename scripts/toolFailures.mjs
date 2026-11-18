// Failed tool calls by class, from Claude Code's transcripts of Combwork's agents (HI-3361): a release checks the rate
// of the classes that point at Combwork's guidance or workflow, and whether a fix made them fall.
//   node scripts/toolFailures.mjs                  the last 7 days, every project, per day and class
//   node scripts/toolFailures.mjs --days 3         another window; --since 2026-11-18T00:00 for an exact start
//   node scripts/toolFailures.mjs --project slot-a  only transcript folders whose name contains it (one per folder worked in)
//   node scripts/toolFailures.mjs --by role        per session role instead of per day (assistant, or unknown: below)
//   node scripts/toolFailures.mjs --show staleRead  also each call of that class: its tool, input and error, shortened
//   node scripts/toolFailures.mjs --top 20         also the 20 commonest errors (card keys and numbers made alike)
//   node scripts/toolFailures.mjs --json           the counts as JSON
// Class 1 (schemaNotLoaded: arguments that don't fit a deferred tool) is counted whole; argNaming is the part of it where
// Combwork's own tools name one thing two ways, which the bridge now takes as meant (withAliases, the same rule).
//   --root <folder>                                 an accounts folder other than %LOCALAPPDATA%\Combwork\accounts
//   --dir <folder>                                  instead, every *.jsonl under a folder (a scenario run's homes), all times
// Each call is counted once, by its id (two accounts can hold the same session, a resumed one repeats its calls). A
// failed call is a tool result marked is_error; a call with no result in its transcript is unanswered, counted apart.
// Combwork's tools are its own server's (`mcp__combwork__cw_…`), never another server's tool of the same name. A
// session's role is `assistant` when it called a tool only the Assistant has; otherwise `unknown` (an agent's, most
// likely, but nothing in the transcript proves it), so per-role rates are labelled as inferred. Claude Code's transcript
// format only: Codex and Copilot sessions aren't read, and every count is Claude Code's. Read-only.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { withAliases } from '../src/shared/combworkToolLoad.ts'

export const PROVIDER = 'claude-code'

/**
 * The classes, first match wins. Those with a `card` are HI-3361's classes 1–4 (Combwork's guidance or workflow); the
 * rest are counted for the rate only. Correct refusals keep their own class, so a rate never falls by renaming them.
 */
export const CLASSES = [
  // Classes 1–4 are Combwork's tools' own failures only (call.cw): another tool's output quoting a refusal (a test run's,
  // another server's) is not one.
  // 2. A lane's next card started before the one before it is Done.
  { id: 'laneOneAtATime', card: 2, test: (t, call) => call.cw && /\(lane\.oneAtATime\)/.test(t) },
  // 3. The stale-read fence.
  { id: 'staleRead', card: 3, test: (t, call) => call.cw && /after you last read it/.test(t) },
  // 4. A lane reorder refused while its builder works, or work refused to an agent on a card watch.
  { id: 'laneReorderBusy', card: 4, test: (t, call) => call.cw && /a reorder applied now never puts|putting it back would lose its review/.test(t) },
  { id: 'watchBusy', card: 4, test: (t, call) => call.cw && /\(a card watch\)/.test(t) },
  // 1. A deferred Combwork tool called with arguments that don't fit it (its schema not loaded): Claude Code's own
  // validation, or Combwork's argument error, which names what the tool takes and what was missing or not one of its
  // arguments. Claude Code adds "input schema was not in your prompt" to any error of a tool not loaded, so that alone
  // isn't this class.
  { id: 'schemaNotLoaded', card: 1, test: (t, call) => call.cw && (/InputValidationError/.test(t) || /\btakes [^\n]*?; (missing|not): /.test(t) || t.startsWith('Combwork error: "undefined" is not a card number')) },
  { id: 'otherCombwork', test: (t, call) => call.cw },
  // Another tool's arguments that don't fit it (Claude Code's own tools', another server's): counted apart, not Combwork's.
  { id: 'otherSchema', test: (t) => /InputValidationError/.test(t) },
  { id: 'other', test: () => true }
]

/** Tools only the Assistant is offered (a subset of assistantTools.ts' ASSISTANT_ONLY_TOOLS: a unit test keeps it so). */
export const ASSISTANT_ONLY_SEEN = ['cw_message_agent', 'cw_prompt_agent', 'cw_start_agent', 'cw_stop_agent', 'cw_agent_activity', 'cw_journal_write', 'cw_journal_recall', 'cw_read_setting', 'cw_list_settings']

/**
 * Whether a class-1 failure is one of Combwork's own naming (HI-3361: `argNaming`, a subtotal of `schemaNotLoaded`, never a
 * class moved out of it): the bridge's alias rule (withAliases, the same function) on the call's actual arguments fills
 * every argument its refusal says is missing. The tool's schema is what that refusal's argument hint states of it: each
 * name it says the tool takes (and each one missing) it has; each it says the tool doesn't take, it hasn't. A wrong type,
 * a canonical given, or another argument still missing is not one.
 */
export function namingFailure(tool, text, input) {
  const takesM = /\btakes ([^;\n]*)/.exec(text)
  if (!takesM || !input || typeof input !== 'object') return false
  const names = (list) => (list ?? '').split(',').map((n) => n.replace(/\(required\)|…/g, '').trim()).filter(Boolean)
  // Missing: as the hint names them, or as Combwork's own refusal says one is required (an argument its schema leaves optional).
  const required = /^Combwork error: (\w+) is required/.exec(text)?.[1]
  const missing = [...new Set([...names(/; missing: ([^;.\n]*)/.exec(text)?.[1]), ...(required ? [required] : [])])]
  const lacks = new Set(names(/; not: ([^.\n]*)/.exec(text)?.[1]))
  const takes = new Set([...names(takesM[1]), ...missing])
  const fixed = withAliases(tool, (n) => takes.has(n) && !lacks.has(n), input)
  return missing.length > 0 && missing.every((n) => input[n] === undefined && fixed[n] !== undefined)
}

/** The class of a failed call: its error text and the call (cw: one of Combwork's tools). */
export function classify(text, call) {
  return CLASSES.find((c) => c.test(text, call)).id
}

/** An error's kind: its first sentence or so, card keys, request ids and numbers made alike, Claude Code's hint dropped. */
export const errorKind = (text) =>
  text
    .replace(/ This tool's input schema was not in your[\s\S]*$/, '')
    .replace(/\b[A-Z]{2,5}-\d+(\/r\d+)?\b|#\d+/g, 'K')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .slice(0, 100)

/** A tool's name without Combwork's server prefix, and whether it is Combwork's (its server's, or a bare cw_ name). */
export function toolOf(name) {
  const n = String(name ?? '?')
  const m = /^mcp__(.+?)__(.+)$/.exec(n)
  if (m) return { name: m[1] === 'combwork' ? m[2] : `${m[1]}:${m[2]}`, cw: m[1] === 'combwork' && m[2].startsWith('cw_') }
  return { name: n, cw: n.startsWith('cw_') }
}

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((x) => x?.text ?? '').join(' ') : '')

/**
 * A transcript's lines (JSONL): each answered call once by its id in `seen` (results from `since` on), with its day
 * (YYYY-MM-DD of the result), tool, and for a failure its class; and the session's role. `book` is the whole corpus's
 * record of calls by id, shared by every transcript read: `answered` (a result seen anywhere, any time) and `pending`
 * (a call in the window with no result seen yet). A call is pending until a result for its id turns up in any copy, so
 * the unanswered count is `book.pending.size` once every transcript is read: each id once, whatever copies and order.
 */
export function readTranscript(lines, seen, since = 0, book = { answered: new Set(), pending: new Set() }) {
  const uses = new Map()
  const results = []
  for (const line of lines) {
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const content = e?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type === 'tool_use' && b.id) {
        const at = Date.parse(e.timestamp ?? '')
        uses.set(b.id, { name: b.name, input: b.input, at })
        if (!book.answered.has(b.id) && (!Number.isFinite(at) || at >= since)) book.pending.add(b.id)
      }
      if (b?.type !== 'tool_result' || !b.tool_use_id) continue
      book.answered.add(b.tool_use_id)
      book.pending.delete(b.tool_use_id)
      if (seen.has(b.tool_use_id)) continue
      const at = Date.parse(e.timestamp ?? '')
      if (!Number.isFinite(at) || at < since) continue
      seen.add(b.tool_use_id)
      const use = uses.get(b.tool_use_id)
      const tool = toolOf(use?.name)
      const day = new Date(at).toISOString().slice(0, 10)
      if (!b.is_error) results.push({ day, name: tool.name, cw: tool.cw, failed: false })
      else {
        const text = textOf(b.content)
        const cls = classify(text, tool)
        results.push({ day, name: tool.name, cw: tool.cw, failed: true, cls, naming: cls === 'schemaNotLoaded' && tool.cw && namingFailure(tool.name, text, use?.input), input: use?.input, text })
      }
    }
  }
  const role = [...uses.values()].some((u) => ASSISTANT_ONLY_SEEN.includes(toolOf(u.name).name)) ? 'assistant' : 'unknown'
  for (const r of results) r.role = role
  return { results, role, book }
}

/** Rows of counts, one per key (a day or a role): calls, Combwork's calls, failed, and each class, numerators and denominators. */
export function countBy(results, keyOf) {
  const keys = [...new Set(results.map(keyOf))].sort()
  return keys.map((key) => {
    const of = results.filter((r) => keyOf(r) === key)
    const row = { key, calls: of.length, cwCalls: of.filter((r) => r.cw).length, failed: of.filter((r) => r.failed).length }
    for (const c of CLASSES) row[c.id] = of.filter((r) => r.failed && r.cls === c.id).length
    row.argNaming = of.filter((r) => r.failed && r.naming).length
    return row
  })
}

function args(argv) {
  const o = { days: 7, since: null, project: '', show: '', top: 0, by: 'day', json: false, dir: null, root: join(process.env.LOCALAPPDATA ?? '', 'Combwork', 'accounts') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--days') o.days = Number(argv[++i])
    else if (a === '--since') o.since = Date.parse(argv[++i])
    else if (a === '--project') o.project = argv[++i].toLowerCase()
    else if (a === '--show') o.show = argv[++i]
    else if (a === '--top') o.top = Number(argv[++i])
    else if (a === '--by') o.by = argv[++i]
    else if (a === '--root') o.root = argv[++i]
    else if (a === '--dir') o.dir = argv[++i]
    else if (a === '--json') o.json = true
    else throw new Error(`Unknown argument ${a}`)
  }
  if (!['day', 'role'].includes(o.by)) throw new Error('--by takes day or role')
  return o
}

/** The transcripts to read: every account's projects (folders matching `project`), or every *.jsonl under `dir`. */
function transcripts(o, since) {
  const files = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else if (e.name.endsWith('.jsonl')) files.push(join(d, e.name))
    }
  }
  if (o.dir) {
    walk(o.dir)
    return files
  }
  for (const account of readdirSync(o.root)) {
    let folders
    try {
      folders = readdirSync(join(o.root, account, 'projects'))
    } catch {
      continue
    }
    for (const folder of folders.filter((f) => f.toLowerCase().includes(o.project))) {
      try {
        for (const f of readdirSync(join(o.root, account, 'projects', folder))) if (f.endsWith('.jsonl')) files.push(join(o.root, account, 'projects', folder, f))
      } catch {
        // a folder that went meanwhile
      }
    }
  }
  return files.filter((f) => statSync(f).mtimeMs >= since)
}

function main() {
  const o = args(process.argv.slice(2))
  const since = o.dir && o.since === null ? 0 : Number.isFinite(o.since) ? o.since : Date.now() - o.days * 864e5
  const seen = new Set()
  const all = []
  const book = { answered: new Set(), pending: new Set() }
  const sessions = { assistant: 0, unknown: 0 }
  for (const file of transcripts(o, since)) {
    const t = readTranscript(readFileSync(file, 'utf8').split('\n'), seen, since, book)
    all.push(...t.results)
    if (t.results.length) sessions[t.role]++
  }
  // Calls still without a result in any transcript read: each id once.
  const unanswered = book.pending.size
  const rows = countBy(all, o.by === 'role' ? (r) => r.role : (r) => r.day)
  const ids = CLASSES.map((c) => c.id)
  if (o.json) {
    console.log(JSON.stringify({ provider: PROVIDER, since: new Date(since).toISOString(), source: o.dir ?? o.root, by: o.by, roleIsInferred: true, sessions, unanswered, classes: CLASSES.map(({ id, card }) => ({ id, card: card ?? null })), rows }, null, 2))
    return
  }
  const total = (k) => rows.reduce((s, r) => s + r[k], 0)
  const cols = ['key', 'calls', 'cwCalls', 'failed', ...ids, 'argNaming']
  console.log(`Claude Code tool calls since ${new Date(since).toISOString()} (${o.dir ? o.dir : o.project ? `folders with "${o.project}"` : 'every project'}); classes 1–4 are HI-3361's. Sessions: ${sessions.assistant} Assistant, ${sessions.unknown} unknown role (inferred: an Assistant-only tool called or not).`)
  console.log([o.by, ...cols.slice(1)].join('\t'))
  for (const r of rows) console.log(cols.map((c) => r[c]).join('\t'))
  console.log(['total', ...cols.slice(1).map(total)].join('\t'))
  const calls = total('calls')
  const cards = ids.filter((id) => CLASSES.find((c) => c.id === id).card).reduce((s, id) => s + total(id), 0)
  // The done-when's count (HI-3361, the user's decision): classes 2–4 and class 1's naming of Combwork's own (argNaming);
  // every other schema failure stays counted in schemaNotLoaded, as expected.
  const owned = cards - total('schemaNotLoaded') + total('argNaming')
  const pct = (n) => (calls ? ((100 * n) / calls).toFixed(2) : '0')
  console.log(`Failed: ${total('failed')} of ${calls} answered calls (${pct(total('failed'))}%); classes 1–4: ${cards} (${pct(cards)}%), of which schema failures ${total('schemaNotLoaded')} (Combwork's naming: ${total('argNaming')}); classes 2–4 and Combwork's naming: ${owned} (${pct(owned)}%); unanswered calls (no result): ${unanswered}.`)
  if (o.top) {
    const counts = new Map()
    for (const r of all.filter((x) => x.failed)) {
      const k = `${r.cls}\t${r.name}\t${errorKind(r.text)}`
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, o.top)) console.log(`${n}\t${k}`)
  }
  if (o.show) {
    for (const r of all.filter((x) => x.failed && x.cls === o.show)) console.log(`${r.day} ${r.role} ${r.name} ${JSON.stringify(r.input ?? {}).slice(0, 100)} → ${r.text.replace(/\s+/g, ' ').slice(0, 240)}`)
  }
}

if (process.argv[1]?.endsWith('toolFailures.mjs')) main()
