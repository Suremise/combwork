// Agent text's catalogue and schema (dialects, HI-2065; plans/2026-11-03-dialects-design.md, section 2):
// `npm run agent-text:extract` reads every agent message in src/ (`agentMsg({ id, text, note })`, shared/agentText) and
// writes, per area (an id's first part: `contract.inbox.rule` → contract), so cards extracting different areas never
// write the same file:
//   - agent-text/catalogue/<area>.json: id → { text, note }, the Default layer (the code's English and why it is worded so);
//     a window message agents read too (HI-2440, agentTextBoth.mjs) keeps its UI id and adds `audience: "both"`, its
//     description as its note;
//   - agent-text/schema/<area>.json: id → { placeholders: { name: kind } }, what a dialect's override must keep exactly
//     (kind: plain, number, plural or select).
// Never edit them by hand: change the message in the code and run this. `--check` writes nothing and exits 1 when one is
// out of date; `npm run check:repo` runs it.
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { parse as parseIcu, TYPE } from '@formatjs/icu-messageformat-parser'
import { ROOT, rootArg, sourceFiles, writeKeepingEndings } from './i18nExtract.mjs'
import { analyzeBoth } from './agentTextBoth.mjs'

const traverse = traverseModule.default ?? traverseModule

export const CATALOGUE_DIR = 'agent-text/catalogue'
export const SCHEMA_DIR = 'agent-text/schema'

/** An id: its area (lower camel case), then at least one more part. */
const ID = /^[a-z][a-zA-Z0-9]*(\.[A-Za-z0-9_-]+)+$/

export const areaOf = (id) => id.split('.')[0]

/** The text of a literal: a string, a template with no substitutions, or those joined with +; undefined otherwise. */
function literalText(n) {
  if (!n) return undefined
  if (n.type === 'StringLiteral') return n.value
  if (n.type === 'TemplateLiteral' && !n.expressions.length) return n.quasis.map((q) => q.value.cooked ?? q.value.raw).join('')
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    const [a, b] = [literalText(n.left), literalText(n.right)]
    return a === undefined || b === undefined ? undefined : a + b
  }
  if (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'ParenthesizedExpression') return literalText(n.expression)
  return undefined
}

const calleeName = (c) => (c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && c.property.type === 'Identifier' ? c.property.name : '')

/** The agent messages in one file's code: [{ id, text, note, at }]; throws on one that isn't literal. */
export function messagesIn(rel, code) {
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript', ...(rel.endsWith('x') ? ['jsx'] : [])] })
  const out = []
  traverse(ast, {
    CallExpression(p) {
      const arg = p.node.arguments[0]
      if (calleeName(p.node.callee) !== 'agentMsg' || arg?.type !== 'ObjectExpression') return
      const field = (key) => arg.properties.find((x) => x.type === 'ObjectProperty' && ((x.key.type === 'Identifier' && x.key.name === key) || (x.key.type === 'StringLiteral' && x.key.value === key)))?.value
      const at = `${rel}:${p.node.loc?.start.line}`
      const id = literalText(field('id'))
      const text = literalText(field('text'))
      const note = field('note') ? literalText(field('note')) : undefined
      if (id === undefined || text === undefined || (field('note') && note === undefined)) throw new Error(`${at}: an agent message's id, text and note must be literal text`)
      out.push({ id, text, ...(note === undefined ? {} : { note }), at })
    }
  })
  return out
}

/**
 * Every message agents read, by id: the agent messages, and the window's messages agents also read (HI-2440: `audience:
 * "both"`, by their UI id, found by agentTextBoth.mjs). Throws on two messages with one id and different text or note, or
 * a mark that leads nowhere.
 */
export function extractAgentMessages(root = ROOT) {
  const own = extractOwnMessages(root)
  const both = analyzeBoth(root)
  if (both.problems.length) throw new Error(both.problems.join('; '))
  for (const [id, d] of Object.entries(both.messages)) {
    if (own[id]) throw new Error(`An agent message and a window message agents read share the id "${id}" (${d.at})`)
    own[id] = { text: d.text, ...(d.note === undefined ? {} : { note: d.note }), audience: 'both' }
  }
  return own
}

/** The agent messages declared with agentMsg(), by id. Throws on two messages with one id and different text or note. */
export function extractOwnMessages(root = ROOT) {
  const out = {}
  for (const rel of sourceFiles(root)) {
    const code = readFileSync(join(root, rel), 'utf8')
    if (!code.includes('agentMsg')) continue
    for (const { id, text, note, at } of messagesIn(rel, code)) {
      const m = { text, ...(note === undefined ? {} : { note }) }
      if (out[id] && JSON.stringify(out[id].m) !== JSON.stringify(m)) throw new Error(`Duplicate agent message id "${id}" with other text or note (${out[id].at} and ${at})`)
      out[id] = { m, at }
    }
  }
  return Object.fromEntries(Object.entries(out).map(([id, { m }]) => [id, m]))
}

/**
 * A message's placeholders and their kinds, nested ones too. Throws on text that isn't ICU as agent text reads it:
 * FormatJS's grammar with tags off and a plural or select needing its other option, as intl-messageformat formats it at
 * run time (shared/agentText/icu.ts), so what passes here formats there.
 */
export function placeholders(text) {
  const out = Object.create(null)
  const kinds = { [TYPE.argument]: 'plain', [TYPE.number]: 'number', [TYPE.date]: 'date', [TYPE.time]: 'time', [TYPE.select]: 'select', [TYPE.plural]: 'plural' }
  const walk = (els) => {
    for (const el of els) {
      const kind = kinds[el.type]
      if (!kind) continue
      if (!Object.hasOwn(out, el.value) || out[el.value] === 'plain') out[el.value] = kind
      if (el.options) for (const o of Object.values(el.options)) walk(o.value)
    }
  }
  walk(parseIcu(text, { ignoreTag: true, requiresOtherClause: true }))
  return { ...out }
}

/** What's wrong with the messages: an id that names no area, text that isn't ICU agent text can use. */
export function messageProblems(messages) {
  const problems = []
  for (const [id, m] of Object.entries(messages)) {
    if (!ID.test(id)) problems.push(`${id}: an id is its area and a name, in parts joined by dots ("contract.inbox.rule")`)
    try {
      placeholders(m.text)
    } catch (e) {
      problems.push(`${id}: its text isn't ICU agent text can use: ${String(e.message).split('\n')[0]}`)
    }
  }
  return problems
}

const json = (v) => `${JSON.stringify(v, null, 2)}\n`

/** The generated files as they should be (path relative to root → content with \n), and those that should be gone. */
export function generatedFiles(root, messages) {
  const areas = new Map()
  for (const id of Object.keys(messages).sort()) {
    const area = areaOf(id)
    if (!areas.has(area)) areas.set(area, [])
    areas.get(area).push(id)
  }
  const want = new Map()
  for (const [area, ids] of areas) {
    want.set(`${CATALOGUE_DIR}/${area}.json`, json(Object.fromEntries(ids.map((id) => [id, messages[id]]))))
    want.set(`${SCHEMA_DIR}/${area}.json`, json(Object.fromEntries(ids.map((id) => [id, { placeholders: placeholders(messages[id].text) }]))))
  }
  const present = [CATALOGUE_DIR, SCHEMA_DIR].flatMap((dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((f) => f.endsWith('.json')).map((f) => `${dir}/${f}`) : []))
  return { want, gone: present.filter((f) => !want.has(f)) }
}

const toLf = (s) => s.replace(/\r\n?/g, '\n')

/** The generated files that differ from what the source makes (line endings aside), or should be gone. */
export function extractDrift(root = ROOT, messages = extractAgentMessages(root)) {
  const { want, gone } = generatedFiles(root, messages)
  const stale = [...want].filter(([rel, text]) => !existsSync(join(root, rel)) || toLf(readFileSync(join(root, rel), 'utf8')) !== text).map(([rel]) => rel)
  return [...stale, ...gone].sort()
}

/** Writes the generated files that changed, and removes those of areas with no messages left. Returns what it wrote. */
export function writeGenerated(root = ROOT, messages = extractAgentMessages(root)) {
  const { want, gone } = generatedFiles(root, messages)
  const written = []
  for (const [rel, text] of want) if (writeKeepingEndings(join(root, rel), text)) written.push(rel)
  for (const rel of gone) {
    rmSync(join(root, rel))
    written.push(`${rel} (removed)`)
  }
  return written
}

/** The Default catalogue, every area's, as one map (id → { text, note }): what the canary and the dialects service read. */
export function readCatalogue(root = ROOT) {
  const dir = join(root, CATALOGUE_DIR)
  if (!existsSync(dir)) return {}
  return Object.assign({}, ...readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = rootArg()
  let messages
  try {
    messages = extractAgentMessages(root)
  } catch (e) {
    console.error(`agent text: ${e.message}`)
    process.exit(1)
  }
  const problems = messageProblems(messages)
  if (problems.length) {
    console.error(`agent text: messages to fix (${problems.length}):\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  const n = Object.keys(messages).length
  if (process.argv.includes('--check')) {
    const drift = extractDrift(root, messages)
    if (drift.length) {
      console.error(`agent text: out of date with the source (run npm run agent-text:extract and commit the result):\n  ${drift.join('\n  ')}`)
      process.exit(1)
    }
    console.log(`agent text: ${n} messages, up to date`)
  } else {
    const written = writeGenerated(root, messages)
    console.log(`agent text: ${n} messages${written.length ? `; wrote ${written.join(', ')}` : ', unchanged'}`)
  }
}
