// The i18n guard (#768): no new hard-coded text in what the user sees. Text the user sees is a message (`msg()`, shown
// with `tr()`/`tRich()`, shared/i18n); the text already in the code when the guard arrived is listed, file by file, in
// i18n/allow/, and those lists can only shrink as the extraction cards convert it.
//
// What it checks, with one walker and one policy:
//   - Text positions (sinks), whatever the text says: JSX children (text and {expressions}); JSX text attributes
//     (title, aria-label, placeholder, label, alt, tip… and any *Label, *Text, *Title, *Message, *Hint, *Tip); text
//     properties (label, title, desc, tip, message, detail, body, text, placeholder…); the shown arguments of UI calls
//     (notify(level, title, message) shows 1 and 2, not the level).
//   - At each sink, textLeaves() follows the expression to every text it can produce: literals and templates (and
//     every substitution in a template), both branches of ?:, both sides of || ?? && and +, array elements and the
//     array of a .join(), through parentheses and TypeScript wrappers. It stops at msg(), tr() and tRich() (translated)
//     and at anything that isn't literal text (a variable, another call).
//   - Outside the sinks, text that reads as prose (a helper's `return \`Passed in ${took}\``, an error's message).
//   - The same exclusions in both: text inside msg({…}) descriptors (by their exact range); anything inside a log call's
//     arguments; other attributes and keys; text with no letter; the files in EXCLUDED (agent-facing, CLI-facing,
//     test-only); and a line with a comment `// i18n-ignore: <reason>` on it, or on a line of its own just above. A
//     bare `i18n-ignore`, with no reason, fails.
//   - A file the parser can't read fails; it is never skipped.
//
// A site is `<sink>|<key>|<text>` (no line numbers); a file's allowlist (i18n/allow/<path with / as __>.json) is its
// sites with their counts. Modes:
//   (none)          check: a site seen more often than its file's list allows fails, and so does a bare ignore. It
//                   also compares the lists with those of the merge base with the base branch (the pull request's
//                   base on CI, else main; --base <ref> names another): a list that gained a site, raised a count or
//                   appeared for a file that had none fails, so a hand edit can't approve new text either. A list
//                   moved with its file (git mv) is the same list. --against <dir> compares with a folder of lists
//                   instead; --no-base doesn't compare.
//   --prune         lowers each list to what the code has now and drops what's gone (with no files given, also the
//                   lists of files deleted or excluded). It never adds a site or raises a count: run it after
//                   converting text (an extraction card prunes its own files' lists).
//   --init          writes the list of a file that has none, and never touches an existing one: run once, when the
//                   guard arrived (#768). Anything new since must be a message.
// Files given after the options limit it to those (relative to the repository, with /); by default every file in src/.
// tests/i18nGuard.test.ts runs the check against the merge base in `npm test` and CI.
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { ROOT, rootArg, sourceFiles } from './i18nExtract.mjs'
import { isAgentFile } from './agentTextFiles.mjs'

const traverse = traverseModule.default ?? traverseModule

export const ALLOW_DIR = 'i18n/allow'

/**
 * Files whose text is never translated, and why (plans/2026-10-14-i18n-manifest.md, Excluded). The agent-facing files
 * are the agent-text guard's (scripts/agentTextFiles.mjs, HI-2065), and left out here too.
 */
export const EXCLUDED = [
  [/^src\/main\/(launchGate|screenRecognition|terminalScreen)\.ts$/, "CLI-facing: a CLI's screen and text (#367)"],
  [/^src\/shared\/windowHealth\.ts$/, "hive.log's lines of a window's long tasks and hangs (HI-1775): English, as main's stall warnings are"],
  // The 1.0 workflow core's files with no text the window shows (#1264): the rest of src/main/workflow and platform is
  // checked, its window text messages in src/shared/workflow (refusals.ts, texts.ts) kept as data beside the English.
  [/^src\/main\/workflow\/factStore\.ts$/, "the fact log's SQL, no text"],
  [/^src\/main\/workflow\/queueJobs\.ts$/, "the merge queue's job supervisor and launcher: their C#, PowerShell and protocol, no text (#1360)"],
  [/^src\/shared\/agentText\//, "agent text's module (HI-2065): agents' text is its callers' messages; its own is ICU errors for the log and the extract script"],
  [/^src\/shared\/appName\.ts$/, 'brand names'],
  [/^src\/shared\/redact\.ts$/, 'log markers'],
  [/^src\/main\/freshPath\.ts$/, 'a registry key, not text'],
  [/^src\/main\/plainHttpsJson\.ts$/, "the version checks' GET: its errors are only ever their \"couldn't check\" (null), never shown (#1582)"],
  [/^src\/main\/exitLog\.ts$/, "log lines and Copy Diagnostics' report, in English (#985)"],
  [/^src\/main\/mainStalls\.ts$/, 'log lines of hive.log, in English (#1109)'],
  [/^src\/main\/db\.ts$/, 'SQL statements and settings, no text (#1017)'],
  [/^src\/main\/(codexLogWorker|providers\/codex\/retryLog)\.ts$/, "reading Codex's log for a retry wait (HI-1972): SQL, reasons for no answer and hive.log lines, no window text"],
  [/^src\/main\/schema\//, "hive.db's 1.0 tables and the card JSON contract: SQL, no text (#1208)"],
  [/^src\/main\/trash\.ts$/, 'test-only'],
  [/^src\/shared\/consoleFixtures\.mts$/, 'test-only'],
  // Developer views (the developer console, Performance) are translated too (Darren, 19 Oct, #1104).
  [/\.test\.tsx?$/, 'test-only']
]
export const isExcluded = (rel) => isAgentFile(rel) || EXCLUDED.some(([re]) => re.test(rel))

// --- The sinks.

const TEXT_ATTRS = new Set(['title', 'aria-label', 'aria-description', 'aria-valuetext', 'placeholder', 'label', 'alt', 'content', 'tip', 'tooltip', 'message', 'detail', 'heading', 'hint', 'help', 'empty', 'summary'])
const TEXT_ATTR_RE = /(Label|Text|Title|Message|Hint|Tip)$/
const TEXT_KEYS = new Set(['label', 'liveLabel', 'title', 'desc', 'description', 'tip', 'tooltip', 'message', 'detail', 'body', 'text', 'placeholder', 'heading', 'hint', 'help', 'empty', 'confirmLabel', 'cancelLabel', 'busyLabel', 'actionLabel', 'subtitle', 'caption', 'reason', 'why', 'statusMessage', 'sub'])
/** Which arguments of a UI call are shown: notify(level, title, message) shows 1 and 2, not the level. */
const UI_CALLS = { notify: [1, 2], toast: [1, 2], attempt: [0], setToolTip: [0], showErrorBox: [0, 1], alert: [0] }
const TRANSLATED = new Set(['msg', 'tr', 'tRich'])
const hasLetter = (s) => /\p{L}/u.test(s)
const norm = (s) => s.replace(/\s+/g, ' ').trim()
const calleeName = (c) => (c?.type === 'Identifier' ? c.name : (c?.type === 'MemberExpression' || c?.type === 'OptionalMemberExpression') && c.property.type === 'Identifier' ? c.property.name : '')

/** Every literal text an expression at a sink can produce. */
export function textLeaves(n) {
  if (!n) return []
  switch (n.type) {
    case 'StringLiteral':
      return [{ node: n, text: n.value }]
    case 'TemplateLiteral':
      // Its literal parts (substitutions as {}), and every substitution through the same walker: `${on ? 'none' : 'all'}`
      // shows "none" or "all"; `${tr(M.x)}` and `${name}` show no literal text.
      return [{ node: n, text: n.quasis.map((q) => q.value.cooked ?? q.value.raw).join('{}') }, ...n.expressions.flatMap((e) => textLeaves(e))]
    case 'ConditionalExpression':
      return [...textLeaves(n.consequent), ...textLeaves(n.alternate)]
    case 'LogicalExpression':
      return [...textLeaves(n.left), ...textLeaves(n.right)]
    case 'BinaryExpression':
      return n.operator === '+' ? [...textLeaves(n.left), ...textLeaves(n.right)] : []
    case 'ArrayExpression':
      return n.elements.flatMap((e) => textLeaves(e))
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'TypeCastExpression':
      return textLeaves(n.expression)
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const name = calleeName(n.callee)
      if (TRANSLATED.has(name)) return []
      // ['a', 'b'].join(' · '): the array's texts are shown.
      if (name === 'join' && (n.callee.type === 'MemberExpression' || n.callee.type === 'OptionalMemberExpression')) return textLeaves(n.callee.object)
      return []
    }
    default:
      return []
  }
}

// --- Prose outside the sinks: the #756 inventory's heuristic. A string reads as prose (words, a space or a capitalised
// word) in a context that shows text: not imports, class names, comparisons, keys, logs, regular expressions…

/** Attributes whose value is never shown. */
const NON_TEXT_ATTRS = new Set(['className', 'style', 'key', 'id', 'type', 'href', 'src', 'role', 'name', 'value', 'htmlFor', 'target', 'rel', 'lang', 'dir', 'autoComplete', 'inputMode', 'icon', 'codicon', 'kind', 'variant', 'size', 'mode', 'side', 'align', 'tabIndex', 'accept', 'pattern', 'spellCheck', 'testId', 'command', 'view', 'level', 'tone', 'section', 'tab', 'scope', 'for', 'path', 'language', 'provider', 'width', 'height', 'viewBox', 'd', 'fill', 'stroke', 'xmlns', 'transform', 'points', 'cx', 'cy', 'r', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'fillRule', 'clipRule', 'preserveAspectRatio', 'sandbox', 'draggable', 'loading', 'decoding', 'colSpan', 'rowSpan', 'min', 'max', 'step', 'list', 'form', 'method', 'action', 'enterKeyHint', 'shortcut', 'keybinding', 'keys', 'storageKey', 'prefKey', 'cls'])
/** Properties whose value is CSS class names, never text. */
const CLASS_KEYS = /^(className|cls)$/
/** Keys and properties that name shown text. */
const PROSE_KEYS = /^(label|liveLabel|title|desc|description|tip|tooltip|text|message|body|detail|placeholder|hint|help|heading|subtitle|caption|confirm\w*|cancel\w*|ok\w*|button\w*|empty\w*|note|summary|reason|status\w*|error|warning|prompt|question|explanation|why|what|more|aria-?label|ariaLabel|alt|off|on|action|actionLabel|name)$/i
// exitBy's caller is a line of hive.log (exitLog.ts, #985); so are the names of work stallWork.ts marks, which only its
// stall warnings print (HI-1692, HI-1735).
const LOG_CALLEE = /^(log|logger|console|journal|hookJournal|trace|debugLog|exitBy|beginWork|timedStep|noteStep)\b/
const NO_TEXT_CALLS = /^(require|import|querySelector|querySelectorAll|getElementById|closest|matches|addEventListener|removeEventListener|on|once|off|emit|emitTo|send|invoke|handle|call|subscribe|getItem|setItem|removeItem|startsWith|endsWith|includes|indexOf|match|matchAll|replace|replaceAll|split|test|exec|RegExp|join|resolve|normalize|basename|dirname|extname|spawn|execFile|exec|fork|setAttribute|getAttribute|hasAttribute|toggle|add|remove|contains|createElement|get|has|delete|Symbol|pattern|advanced|commandKeybinding|runCommand|cmd|run|git|readFile|writeFile|readKeptJson|writeKeptJson|appendFile|mkdir|rm|stat|access|readdir|env|getPath|setPath|createLogger|mark|measure|fetch|encodeURIComponent|decodeURIComponent|atob|btoa|parse|stringify|padStart|padEnd|localeCompare|sort|setProperty|getPropertyValue|scrollIntoView|dispatchEvent|CustomEvent|Event|KeyboardEvent|MouseEvent|keybinding|hasCommand|commandById|isEnabled|feature|cls|clsx|classNames|codicon)$/

function proseLike(s) {
  const t = s.replace(/\{\w+\}/g, 'X').trim()
  if (t.length < 2) return false
  if (!/[A-Za-z]{2,}/.test(t)) return false
  if (/^(https?:|file:|mailto:|data:|#[0-9a-f]{3,8}$|--|\.|\/|[A-Z]:\\|\$|@)/i.test(t)) return false
  if (/^[a-z0-9]+([-_:./][a-z0-9*]+)+$/i.test(t)) return false // ids, channels, paths, kebab-case, dotted
  if (/^[A-Z][A-Z0-9_]+$/.test(t)) return false // CONSTANTS, environment variables
  if (/^(Ctrl|Alt|Shift|Cmd|Meta)\+/.test(t)) return false
  if (/(px|em|rem|%|ms|vh|vw)\b/.test(t) && /^[\d\s.a-z%(),-]+$/i.test(t)) return false // CSS values
  if (/var\(--|rgba?\(|calc\(|^\d/.test(t) && !/ [a-z]{3,} [a-z]{3,}/i.test(t)) return false
  if (/[{};]\s*$|=>|\(\)|\bfunction\b|^\w+\(.*\)$/.test(t)) return false
  if (/^[\w-]+$/.test(t)) return /^[A-Z][a-z]+$/.test(t) || (/^[A-Z][a-z]+[A-Z]?[a-z]*$/.test(t) && !/[a-z][A-Z]/.test(t)) // one capitalised word ("Save")
  return /[A-Za-z]{2,}\s+[A-Za-z(“"'‘]/.test(t) || /^[A-Z][a-z]/.test(t)
}

const templateText = (node) => node.quasis.map((q, i) => (q.value.cooked ?? q.value.raw) + (i < node.expressions.length ? '{x}' : '')).join('')

/** The callee's name for the prose layer: `log.info` for a logger's method, so it is recognised as a log. */
function proseCallee(c) {
  if (!c) return ''
  if (c.type === 'Identifier') return c.name
  if (c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression') {
    const obj = c.object
    const objName = obj.type === 'Identifier' ? obj.name : obj.type === 'MemberExpression' && obj.property.type === 'Identifier' ? obj.property.name : ''
    const prop = c.property.type === 'Identifier' ? c.property.name : ''
    return objName && LOG_CALLEE.test(objName) ? `${objName}.${prop}` : prop
  }
  return ''
}

/** Whether, and as what, the string at p is shown: walks up past wrappers to the context that decides. */
function contextOf(p) {
  let child = p
  let parent = p.parentPath
  while (parent) {
    const n = parent.node
    switch (n.type) {
      case 'TSLiteralType':
      case 'TSEnumMember':
      case 'TSPropertySignature':
        return { skip: true }
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
      case 'ImportExpression':
        if (child.key === 'source') return { skip: true }
        break
      case 'BinaryExpression':
        if (['===', '!==', '==', '!=', 'in', 'instanceof', '<', '>'].includes(n.operator)) return { skip: true }
        break
      case 'SwitchCase':
        if (child.key === 'test') return { skip: true }
        break
      case 'ConditionalExpression':
        if (child.key === 'test') return { skip: true }
        break
      case 'ObjectProperty':
      case 'ObjectMethod': {
        if (child.key === 'key') return { skip: true }
        const k = n.key.type === 'Identifier' ? n.key.name : n.key.type === 'StringLiteral' ? n.key.value : ''
        // A class list, as in JSX (a table column's `className: 'nowrap git-queue-result'`, #1655).
        if (CLASS_KEYS.test(k)) return { skip: true }
        return { kind: PROSE_KEYS.test(k) ? 'prop:text' : 'prop:other' }
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        if (child.key === 'property') return { skip: true }
        break
      case 'JSXAttribute': {
        const a = n.name.type === 'JSXIdentifier' ? n.name.name : n.name.name.name
        if (NON_TEXT_ATTRS.has(a) || a.startsWith('data-') || a.startsWith('on')) return { skip: true }
        return { kind: 'jsx:attr' }
      }
      case 'JSXExpressionContainer':
        if (parent.parentPath.node.type === 'JSXAttribute') {
          child = parent
          parent = parent.parentPath
          continue
        }
        return { kind: 'jsx:expr' }
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression': {
        if (child.key === 'callee') return { skip: true }
        const name = proseCallee(n.callee)
        if (LOG_CALLEE.test(name)) return { skip: true }
        if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && n.callee.name.endsWith('Error')) return { kind: 'error' }
        if (NO_TEXT_CALLS.test(name)) return { skip: true }
        if (name === 'userText') {
          child = parent
          parent = parent.parentPath
          continue
        }
        return { kind: 'call' }
      }
      case 'ThrowStatement':
        return { kind: 'error' }
      case 'ReturnStatement':
      case 'ArrowFunctionExpression':
        return { kind: 'return' }
      case 'VariableDeclarator':
        return { kind: 'var' }
      case 'AssignmentExpression': {
        const l = n.left
        const k = l.type === 'MemberExpression' && l.property.type === 'Identifier' ? l.property.name : ''
        if (/^(className|id|src|href|cursor)$/.test(k) || (l.type === 'MemberExpression' && l.object.type === 'MemberExpression' && l.object.property.name === 'style')) return { skip: true }
        return { kind: PROSE_KEYS.test(k) || /^(textContent|innerText|title|placeholder)$/.test(k) ? 'prop:text' : 'assign' }
      }
      case 'ExpressionStatement':
        return { skip: true }
      case 'Program':
        return { kind: 'top' }
      default:
        break
    }
    child = parent
    parent = parent.parentPath
  }
  return { kind: 'other' }
}

/** Whether p is inside the arguments of a log call (log.info({ message: '…' }) is a log's, not the user's), up to its function. */
function inLog(p) {
  for (let child = p, q = p.parentPath; q; child = q, q = q.parentPath) {
    if (q.isFunction()) return false
    const n = q.node
    if ((n.type === 'CallExpression' || n.type === 'OptionalCallExpression') && child.key !== 'callee' && LOG_CALLEE.test(proseCallee(n.callee))) return true
  }
  return false
}

/** The prose strings in a parsed file: { line, start, text, kind }, the text in full (it is the site's identity). The agent-text guard reads them too. */
export function proseItems(ast) {
  const items = []
  const push = (p, text) => {
    const ctx = contextOf(p)
    if (ctx.skip || !proseLike(text) || inLog(p)) return
    items.push({ line: p.node.loc?.start.line, start: p.node.start, text, kind: ctx.kind })
  }
  traverse(ast, {
    StringLiteral(p) {
      push(p, p.node.value)
    },
    TemplateLiteral(p) {
      if (p.parent.type !== 'TaggedTemplateExpression') push(p, templateText(p.node))
    }
  })
  return items
}

// --- A file's sites.

/** A file's UI text sites, and its problems (a bare ignore, a file that doesn't parse). */
export function sitesOf(file, code) {
  let ast
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['typescript', ...(file.endsWith('x') ? ['jsx'] : [])] })
  } catch (e) {
    // A file the guard can't read is a failure, never a pass.
    return { sites: [], problems: [`UNPARSEABLE ${file}: ${String(e.message).split(/\r?\n/)[0]}`], unparseable: true }
  }
  const lines = code.split(/\r?\n/)
  const sites = []
  const problems = new Set()
  // Exemptions are comments (the parser's, so text in a string that reads "i18n-ignore: …" exempts nothing) that start
  // with `i18n-ignore: <reason>`: on the comment's own lines, and on the next line when the comment has its line to
  // itself. A bare marker, with no reason, exempts nothing and fails.
  const exempt = new Set()
  for (const c of ast.comments ?? []) {
    const m = /^[\s*]*i18n-ignore\b(:?)([\s\S]*)$/.exec(c.value)
    if (!m) continue
    const { start, end } = c.loc
    if (!m[1] || !m[2].trim()) {
      problems.add(`BARE IGNORE ${file}:${start.line}  i18n-ignore needs a reason: // i18n-ignore: <why this text isn't translated>`)
      continue
    }
    for (let l = start.line; l <= end.line; l++) exempt.add(l)
    if (!(lines[start.line - 1] ?? '').slice(0, start.column).trim()) exempt.add(end.line + 1)
  }
  const ignored = (line) => exempt.has(line)
  // Descriptors: the exact source ranges of msg({...}) calls (not whole lines: other text can share the line), and of
  // agentMsg({...}) calls, agents' text, which the agent-text guard checks (HI-2065).
  const msgRanges = []
  traverse(ast, {
    'CallExpression|OptionalCallExpression'(p) {
      if (calleeName(p.node.callee) === 'msg' || calleeName(p.node.callee) === 'agentMsg') msgRanges.push([p.node.start, p.node.end])
    }
  })
  const inMsg = (at) => at !== undefined && at !== null && msgRanges.some(([a, b]) => at >= a && at < b)
  const add = (sink, key, leaf) => {
    const line = leaf.node.loc?.start.line ?? 0
    if (!hasLetter(leaf.text) || inMsg(leaf.node.start) || ignored(line)) return
    sites.push({ site: `${sink}|${key}|${norm(leaf.text)}`, line })
  }
  traverse(ast, {
    JSXText(p) {
      if (!inLog(p)) add('jsx-text', '', { node: p.node, text: p.node.value })
    },
    JSXExpressionContainer(p) {
      // A child of an element or fragment: {'none'}, {on ? 'a' : 'b'}, {n > 1 && 'more'}.
      if ((p.parent.type !== 'JSXElement' && p.parent.type !== 'JSXFragment') || inLog(p)) return
      for (const leaf of textLeaves(p.node.expression)) add('jsx-expr', '', leaf)
    },
    JSXAttribute(p) {
      const name = p.node.name.type === 'JSXIdentifier' ? p.node.name.name : `${p.node.name.namespace.name}:${p.node.name.name.name}`
      if (!(TEXT_ATTRS.has(name) || TEXT_ATTR_RE.test(name)) || !p.node.value || inLog(p)) return
      const v = p.node.value
      for (const leaf of v.type === 'JSXExpressionContainer' ? textLeaves(v.expression) : textLeaves(v)) add('jsx-attr', name, leaf)
    },
    ObjectProperty(p) {
      const k = p.node.key.type === 'Identifier' ? p.node.key.name : p.node.key.type === 'StringLiteral' ? p.node.key.value : ''
      if (!TEXT_KEYS.has(k) || inLog(p)) return
      for (const leaf of textLeaves(p.node.value)) add('prop', k, leaf)
    },
    // tray?.setToolTip('…') is as much a UI call as tray.setToolTip('…').
    'CallExpression|OptionalCallExpression'(p) {
      const name = calleeName(p.node.callee)
      const args = Object.hasOwn(UI_CALLS, name) ? UI_CALLS[name] : null
      if (!args || inLog(p)) return
      for (const i of args) for (const leaf of textLeaves(p.node.arguments[i])) add('call', name, leaf)
    }
  })
  // Prose outside the sinks, with the same exclusions; a text already found at a sink on its line isn't counted twice.
  const sinkAt = sites.map((x) => ({ line: x.line, text: x.site.split('|').slice(2).join('|') }))
  for (const i of proseItems(ast)) {
    if (i.kind === 'jsx:attr' || inMsg(i.start) || ignored(i.line)) continue
    const text = norm(i.text.replace(/\{x\}/g, '{}'))
    if (sinkAt.some((x) => x.line === i.line && x.text === text)) continue
    sites.push({ site: `prose|${i.kind}|${text}`, line: i.line })
  }
  return { sites, problems: [...problems] }
}

// --- The allowlists.

/** A site as a report shows it: a long text cut short (the list holds it in full). */
const shown = (site) => (site.length > 200 ? `${site.slice(0, 197)}...` : site)

/** A source file's allowlist, by name in the allowlist folder. */
export const allowName = (rel) => `${rel.replace(/[\\/]/g, '__')}.json`

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const listText = (counts) => `${JSON.stringify(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 2)}\n`

/** A folder's allowlists: name → { site: count }. */
export function readLists(dir) {
  const out = new Map()
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) out.set(f, readJson(join(dir, f)))
  return out
}

const git = (root, args, input) => execFileSync('git', args, { cwd: root, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
const gitOk = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status === 0

/** The base branch to compare with: the pull request's base on CI, else main, else origin/main. */
export function defaultBaseRef(root = ROOT) {
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`
  return gitOk(root, ['rev-parse', '--verify', '-q', 'main^{commit}']) ? 'main' : 'origin/main'
}

/**
 * The allowlists of the merge base of HEAD and ref: what this branch started from, so a list pruned on the base since
 * doesn't count as this branch's growth. On the base branch itself (the merge base is HEAD), its previous commit's.
 * Returns null where there's none to compare with: no such ref, no earlier commit, or a base from before the guard.
 * `dir`: the lists' folder (the agent-text guard's are agent-text/allow).
 */
export function baseLists(root, ref, dir = ALLOW_DIR) {
  if (!gitOk(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])) return null
  const head = git(root, ['rev-parse', 'HEAD']).trim()
  let base = git(root, ['merge-base', 'HEAD', ref]).trim()
  if (base === head) {
    if (!gitOk(root, ['rev-parse', '--verify', '-q', 'HEAD^'])) return null
    base = git(root, ['rev-parse', 'HEAD^']).trim()
  }
  const names = git(root, ['ls-tree', '-r', '--name-only', base, '--', dir]).split('\n').filter((n) => n.endsWith('.json'))
  if (!names.length) return { base, lists: null }
  // One git process for every list: cat-file --batch prints "<sha> blob <size>\n<content>\n" for each.
  const out = Buffer.from(execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: names.map((n) => `${base}:${n}\n`).join(''), maxBuffer: 256 * 1024 * 1024 }))
  const lists = new Map()
  let at = 0
  for (const name of names) {
    const nl = out.indexOf(10, at)
    const size = Number(out.subarray(at, nl).toString('utf8').split(' ')[2])
    lists.set(name.slice(dir.length + 1), JSON.parse(out.subarray(nl + 1, nl + 1 + size).toString('utf8')))
    at = nl + 1 + size + 1
  }
  return { base, lists }
}

/**
 * The pairing of rows with columns that gives the largest total weight (w[row][col] >= 0; no more rows than columns):
 * the Hungarian method, on costs -w. Returns each row's column.
 */
function bestPairing(w) {
  const n = w.length
  const m = w[0]?.length ?? 0
  const u = Array.from({ length: n + 1 }, () => 0)
  const v = Array.from({ length: m + 1 }, () => 0)
  const p = Array.from({ length: m + 1 }, () => 0)
  const way = Array.from({ length: m + 1 }, () => 0)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = Array.from({ length: m + 1 }, () => Infinity)
    const used = Array.from({ length: m + 1 }, () => false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue
        const cur = -w[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else minv[j] -= delta
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0)
  }
  const colOf = Array.from({ length: n }, () => -1)
  for (let j = 1; j <= m; j++) if (p[j]) colOf[p[j] - 1] = j - 1
  return colOf
}

/**
 * Where the lists grew against the base's: a site gained or a count raised. A list the base hasn't is new, unless it is
 * a base list that is gone here, moved with its file (git mv). Each vanished list stands for one moved file: new lists
 * and vanished ones are paired one to one so that they share as many sites as they can (what is left over is what
 * grew, so this reports the least growth any pairing could), whatever order the lists come in. Two copies of one list
 * can't both be it.
 */
export function growth(now, was) {
  const byName = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
  const fresh = [...now].filter(([name]) => !was.has(name)).sort(byName)
  const vanished = [...was].filter(([name]) => !now.has(name)).sort(byName).map(([, list]) => list)
  const shared = (a, b) => Object.entries(a).reduce((n, [site, k]) => n + Math.min(k, b[site] ?? 0), 0)
  const movedFrom = new Map()
  if (fresh.length && vanished.length) {
    // Columns: the vanished lists, and an empty one per new list (no move), so there are never fewer than rows.
    const cols = [...vanished, ...fresh.map(() => ({}))]
    const colOf = bestPairing(fresh.map(([, list]) => cols.map((v) => shared(list, v))))
    fresh.forEach(([name], i) => movedFrom.set(name, cols[colOf[i]]))
  }
  const out = []
  for (const [name, list] of [...now].sort(byName)) {
    const before = was.get(name) ?? movedFrom.get(name)
    for (const [site, n] of Object.entries(list)) if (n > (before?.[site] ?? 0)) out.push(`ALLOWLIST GREW ${name}: ${site} (${before?.[site] ?? 0} → ${n}): the allowlist only shrinks; write the text as a message`)
  }
  return out
}

/**
 * Runs the guard. mode: check (default), init or prune; files: limit it to those (relative, with /); against: the base's
 * lists (a Map, as baseLists gives) to compare with, in a check. Returns its exit code and report lines.
 */
export function runGuard({ root = ROOT, allowDir = join(root, ALLOW_DIR), mode = 'check', files, against } = {}) {
  const out = []
  let failures = 0
  let total = 0
  let created = 0
  let pruned = 0
  let stale = 0
  const list = (files?.length ? files : sourceFiles(root)).filter((rel) => !isExcluded(rel))
  mkdirSync(allowDir, { recursive: true })
  for (const rel of list) {
    const { sites, problems, unparseable } = sitesOf(rel, readFileSync(join(root, rel), 'utf8'))
    // init and prune never act on a file they can't read; check fails on it.
    if (unparseable && mode !== 'check') {
      out.push(problems[0])
      continue
    }
    total += sites.length
    const counts = {}
    for (const s of sites) counts[s.site] = (counts[s.site] ?? 0) + 1
    const file = join(allowDir, allowName(rel))
    const allowed = existsSync(file) ? readJson(file) : null
    if (mode === 'init') {
      // Only a file with no list gets one: an existing list is never rewritten here.
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
        out.push(`NEW UI TEXT ${rel}:${s.line}  ${shown(s.site)}`)
      }
    }
    for (const [site, n] of Object.entries(allowed ?? {})) if ((counts[site] ?? 0) < n) stale++
  }
  if (mode === 'prune' && !files?.length) {
    // A list whose file is gone (deleted, or moved without its list) or now excluded goes too.
    const names = new Set(list.map(allowName))
    for (const f of readdirSync(allowDir).filter((x) => x.endsWith('.json') && !names.has(x))) {
      rmSync(join(allowDir, f))
      pruned++
    }
  }
  if (mode === 'init') out.push(`init: ${created} allowlists created; ${total} sites`)
  else if (mode === 'prune') out.push(`prune: ${pruned} allowlists lowered or removed`)
  else {
    if (against) {
      const grew = growth(readLists(allowDir), against)
      failures += grew.length
      out.push(...grew)
    }
    if (failures) out.push('Text the user sees is a message: msg({ id, defaultMessage, description }) shown with tr() (AGENTS.md, Translations). Text that is never translated takes // i18n-ignore: <reason>.')
    out.push(`${total} UI text sites; ${failures} failures; ${stale} allowed sites gone (--prune drops them)`)
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
    const b = baseLists(root, ref)
    if (!b) console.log(`(no merge base with ${ref} to compare the allowlists with)`)
    else if (!b.lists) console.log(`(the merge base with ${ref}, ${b.base.slice(0, 8)}, has no allowlists: nothing to compare with)`)
    else against = b.lists
  }
  const { exit, lines } = runGuard({ root, mode, files, against })
  console.log(lines.join('\n'))
  process.exit(exit)
}
