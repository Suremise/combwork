// The agent-text guard (dialects, HI-2065; plans/2026-11-03-dialects-design.md, section 2): no new hard-coded text in what
// agents get. Agent text is a message (`agentMsg({ id, text, note })`, said with `say()`, shared/agentText); the text
// already in the code when the guard arrived is listed, file by file, in agent-text/allow/, and those lists only shrink as
// the extraction cards convert it (as the i18n guard's did, #768).
//
// What it checks: prose (the i18n guard's heuristic: words, not ids, paths, SQL or log lines) outside agentMsg() (and
// msg()) descriptors,
//   - in the agent-facing files (agentTextFiles.mjs, which the i18n guard leaves out), everywhere in them;
//   - in every other file, on the lines an `// i18n-ignore: <reason>` exempts from the i18n guard for being agent text
//     (agentReason): those lines are agents', so this guard has them.
// Text that reaches agents but isn't wording (a name, a path, a fixed prefix code parses back, a CLI's pattern) takes
// `// agent-protocol: <reason>` on its line, or on a line of its own just above. A bare `agent-protocol`, with no
// reason, fails. A file the parser can't read fails; it is never skipped.
//
// A site is `prose|<context>|<text>` (no line numbers); a file's list (agent-text/allow/<path with / as __>.json) is its
// sites with their counts. Modes, as the i18n guard's:
//   (none)    check: a site seen more often than its file's list allows fails; the lists are compared with the merge
//             base's (--base <ref>, --against <dir>, --no-base), and a list that gained a site or appeared fails.
//   --prune   lowers each list to what the code has now and drops what's gone (an extraction card prunes its files').
//   --init    writes the list of a file that has none, never touching one that exists: run once, when the guard arrived.
// Files given after the options limit it to those. `npm run check:repo` runs the check.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { ROOT, rootArg, sourceFiles } from './i18nExtract.mjs'
import { allowName, baseLists, defaultBaseRef, growth, proseItems, readLists } from './i18nGuard.mjs'
import { agentReason, isAgentFile } from './agentTextFiles.mjs'

const traverse = traverseModule.default ?? traverseModule

export const ALLOW_DIR = 'agent-text/allow'

const norm = (s) => s.replace(/\s+/g, ' ').trim()
/**
 * An SQL statement, not wording (HI-2447: the slot and copy pools' hundred-odd statements read as prose to the shared
 * heuristic): it starts with a statement's keywords, in capitals, as this codebase writes them. A fragment of one (a
 * WHERE clause kept in a constant) takes `// agent-protocol: SQL`.
 */
const SQL = /^(SELECT [\s\S]+ FROM |INSERT INTO |UPDATE \w+ SET |DELETE FROM |BEGIN( IMMEDIATE| EXCLUSIVE)?$|COMMIT$|ROLLBACK$)/
export const isSql = (text) => SQL.test(text.trim())
const calleeName = (c) => (c?.type === 'Identifier' ? c.name : (c?.type === 'MemberExpression' || c?.type === 'OptionalMemberExpression') && c.property.type === 'Identifier' ? c.property.name : '')

/** A comment's lines and, when it has its line to itself, the next one. */
function linesOf(c, lines) {
  const out = []
  for (let l = c.loc.start.line; l <= c.loc.end.line; l++) out.push(l)
  if (!(lines[c.loc.start.line - 1] ?? '').slice(0, c.loc.start.column).trim()) out.push(c.loc.end.line + 1)
  return out
}

/** A file's agent text sites, and its problems (a bare agent-protocol, a file that doesn't parse). */
export function agentSitesOf(file, code) {
  let ast
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['typescript', ...(file.endsWith('x') ? ['jsx'] : [])] })
  } catch (e) {
    return { sites: [], problems: [`UNPARSEABLE ${file}: ${String(e.message).split(/\r?\n/)[0]}`], unparseable: true }
  }
  const lines = code.split(/\r?\n/)
  const problems = []
  const protocol = new Set()
  // Outside the agent-facing files, the lines marked agent text for the i18n guard are this guard's.
  const whole = isAgentFile(file)
  const agentLines = new Set()
  for (const c of ast.comments ?? []) {
    const p = /^[\s*]*agent-protocol\b(:?)([\s\S]*)$/.exec(c.value)
    if (p) {
      if (!p[1] || !p[2].trim()) problems.push(`BARE PROTOCOL ${file}:${c.loc.start.line}  agent-protocol needs a reason: // agent-protocol: <why this isn't wording>`)
      else for (const l of linesOf(c, lines)) protocol.add(l)
      continue
    }
    const i = /^[\s*]*i18n-ignore:([\s\S]*)$/.exec(c.value)
    if (!whole && i && agentReason(i[1])) for (const l of linesOf(c, lines)) agentLines.add(l)
  }
  if (!whole && !agentLines.size) return { sites: [], problems }
  // Descriptors: the exact ranges of agentMsg({...}) and msg({...}) calls.
  const ranges = []
  traverse(ast, {
    'CallExpression|OptionalCallExpression'(p) {
      const name = calleeName(p.node.callee)
      if (name === 'agentMsg' || name === 'msg') ranges.push([p.node.start, p.node.end])
    }
  })
  const inDescriptor = (at) => at !== undefined && at !== null && ranges.some(([a, b]) => at >= a && at < b)
  const sites = []
  for (const i of proseItems(ast)) {
    if (inDescriptor(i.start) || protocol.has(i.line) || (!whole && !agentLines.has(i.line)) || isSql(i.text)) continue
    sites.push({ site: `prose|${i.kind}|${norm(i.text.replace(/\{x\}/g, '{}'))}`, line: i.line })
  }
  return { sites, problems }
}

/** The files the guard reads: the agent-facing ones, and any other with a line marked agent text. */
const candidates = (root) => sourceFiles(root).filter((rel) => !/\.test\.tsx?$/.test(rel))

const shown = (site) => (site.length > 200 ? `${site.slice(0, 197)}...` : site)
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const listText = (counts) => `${JSON.stringify(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 2)}\n`

/** Runs the guard. mode: check (default), init or prune; files: limit it to those; against: the base's lists. */
export function runAgentGuard({ root = ROOT, allowDir = join(root, ALLOW_DIR), mode = 'check', files, against } = {}) {
  const out = []
  let failures = 0
  let total = 0
  let created = 0
  let pruned = 0
  let stale = 0
  const list = files?.length ? files : candidates(root)
  const seenFiles = new Set()
  mkdirSync(allowDir, { recursive: true })
  for (const rel of list) {
    const code = readFileSync(join(root, rel), 'utf8')
    // A file that is neither agent-facing nor has an ignore can't have a site: not parsed.
    if (!isAgentFile(rel) && !code.includes('i18n-ignore') && !code.includes('agent-protocol')) continue
    const { sites, problems, unparseable } = agentSitesOf(rel, code)
    if (unparseable && mode !== 'check') {
      out.push(problems[0])
      continue
    }
    seenFiles.add(allowName(rel))
    total += sites.length
    const counts = {}
    for (const s of sites) counts[s.site] = (counts[s.site] ?? 0) + 1
    const file = join(allowDir, allowName(rel))
    const allowed = existsSync(file) ? readJson(file) : null
    if (mode === 'init') {
      if (!allowed && sites.length) {
        writeFileSync(file, listText(counts))
        created++
      }
      continue
    }
    if (mode === 'prune') {
      if (!allowed) continue
      const next = {}
      for (const [site, n] of Object.entries(allowed)) {
        const keep = Math.min(n, counts[site] ?? 0)
        if (keep > 0) next[site] = keep
      }
      if (listText(next) === listText(allowed)) continue
      pruned++
      if (Object.keys(next).length) writeFileSync(file, listText(next))
      else rmSync(file)
      continue
    }
    failures += problems.length
    out.push(...problems)
    const seen = {}
    for (const s of sites) {
      seen[s.site] = (seen[s.site] ?? 0) + 1
      if (seen[s.site] > (allowed?.[s.site] ?? 0)) {
        failures++
        out.push(`NEW AGENT TEXT ${rel}:${s.line}  ${shown(s.site)}`)
      }
    }
    for (const [site, n] of Object.entries(allowed ?? {})) if ((counts[site] ?? 0) < n) stale++
  }
  if (mode === 'prune' && !files?.length) {
    // A list whose file is gone, or no longer has agent text the guard reads, goes too.
    for (const f of readdirSync(allowDir).filter((x) => x.endsWith('.json') && !seenFiles.has(x))) {
      rmSync(join(allowDir, f))
      pruned++
    }
  }
  if (mode === 'init') out.push(`init: ${created} allowlists created; ${total} sites`)
  else if (mode === 'prune') out.push(`prune: ${pruned} allowlists lowered or removed`)
  else {
    if (against) {
      const grew = growth(readLists(allowDir), against).map((l) => l.replace('write the text as a message', 'write the text as an agent message'))
      failures += grew.length
      out.push(...grew)
    }
    if (failures) out.push("Text agents get is an agent message: agentMsg({ id, text, note }) said with say() (shared/agentText). Text that isn't wording (a name, a path, a prefix code parses) takes // agent-protocol: <reason>.")
    out.push(`${total} agent text sites; ${failures} failures; ${stale} allowed sites gone (--prune drops them)`)
  }
  return { exit: failures ? 1 : 0, lines: out }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const root = rootArg(args)
  const mode = args.includes('--init') ? 'init' : args.includes('--prune') ? 'prune' : 'check'
  const valueOf = (flag) => {
    const at = args.indexOf(flag)
    return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : undefined
  }
  const values = new Set([valueOf('--base'), valueOf('--against'), valueOf('--root')].filter(Boolean))
  const files = args.filter((a) => !a.startsWith('--') && !values.has(a)).map((f) => f.replace(/\\/g, '/'))
  let against
  if (args.includes('--against')) against = readLists(valueOf('--against') ?? '')
  else if (mode === 'check' && !args.includes('--no-base')) {
    const ref = valueOf('--base') ?? defaultBaseRef(root)
    const b = baseLists(root, ref, ALLOW_DIR)
    if (!b) console.log(`(no merge base with ${ref} to compare the agent text allowlists with)`)
    else if (!b.lists) console.log(`(the merge base with ${ref}, ${b.base.slice(0, 8)}, has no agent text allowlists: nothing to compare with)`)
    else against = b.lists
  }
  const { exit, lines } = runAgentGuard({ root, mode, files, against })
  console.log(lines.join('\n'))
  process.exit(exit)
}
