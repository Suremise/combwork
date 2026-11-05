// The English catalogues and typed values (#768): `npm run i18n:extract` reads every message in src/ (`msg({ id,
// defaultMessage, description })`, shared/i18n/msg.ts) and writes, per area, locales/en/<area>.json (id → its English
// and its note for translators: what translators work from) and src/shared/i18n/values/<area>.d.ts (i18nValues.mjs).
// A message's area is its id's first part (`settings.general.title` → settings), so each area's files are its own and
// no list of areas needs editing. Never edit the generated files by hand: change the message in the code and run this.
// `--check` writes nothing and exits 1 when a generated file is out of date; tests/i18nCatalogues.test.ts checks the
// same in `npm test` and CI.
//
// FormatJS's CLI (`formatjs extract`) reads the messages with its native binding, which exists for win32-x64, Linux and
// macOS on arm64. Without it the CLI quietly finds nothing, so where the binding is missing (Windows on Arm) this reads
// them itself, with Babel's parser, the same way (a unit test checks the two agree on Combwork's source).
import { spawnSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { valuesDts } from './i18nValues.mjs'

const traverse = traverseModule.default ?? traverseModule
const require = createRequire(import.meta.url)

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const EN_DIR = 'locales/en'
export const VALUES_DIR = 'src/shared/i18n/values'

/** The repository a script works on: --root <dir> (tests run the scripts on a tree of their own), else this one. */
export function rootArg(args = process.argv.slice(2)) {
  const at = args.indexOf('--root')
  return at >= 0 && args[at + 1] ? args[at + 1] : ROOT
}

/** An id: its area (lower camel case), then at least one more part. */
const ID = /^[a-z][a-zA-Z0-9]*(\.[A-Za-z0-9_-]+)+$/

/** A message's area: its id's first part. */
export const areaOf = (id) => id.split('.')[0]

/** Every source file messages can be in: src/**\/*.ts, .tsx and .mts, declarations aside, relative to root with /. */
export function sourceFiles(root, dir = 'src') {
  const out = []
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
    }
  }
  if (existsSync(join(root, dir))) walk(dir)
  return out.sort()
}

/** Whether FormatJS's CLI has its native binding on this machine (it reads source only with it). */
export function hasNativeCli() {
  try {
    const cli = require.resolve('@formatjs/cli/package.json')
    createRequire(cli).resolve(`@formatjs/cli-native-${process.platform}-${process.arch}`)
    return true
  } catch {
    return false
  }
}

/** The CLI's bin, run with this Node. */
export const cliBin = () => join(dirname(require.resolve('@formatjs/cli/package.json')), 'bin', 'formatjs')

/** Messages by id, as `formatjs extract` reads them, white space kept (#815: a leading space or a line break is part of
 * the message, and translators work from this English). Throws with its error (a duplicate id with other text, a file it can't parse). */
export function extractWithCli(root) {
  const r = spawnSync(process.execPath, [cliBin(), 'extract', 'src/**/*.ts', 'src/**/*.tsx', 'src/**/*.mts', '--ignore', 'src/**/*.d.ts', '--additional-function-names', 'msg', '--preserve-whitespace', '--throws'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`formatjs extract failed: ${(r.stderr || r.stdout || String(r.error)).split(/\r?\n/)[0]}`)
  return JSON.parse(r.stdout)
}

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

/** Messages by id, read with Babel the way `formatjs extract --preserve-whitespace` reads them (the English as written). */
export function extractWithJs(root) {
  const out = {}
  for (const rel of sourceFiles(root)) {
    const code = readFileSync(join(root, rel), 'utf8')
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript', ...(rel.endsWith('x') ? ['jsx'] : [])] })
    traverse(ast, {
      CallExpression(p) {
        const c = p.node.callee
        const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && c.property.type === 'Identifier' ? c.property.name : ''
        const arg = p.node.arguments[0]
        if (name !== 'msg' || arg?.type !== 'ObjectExpression') return
        const field = (key) => arg.properties.find((x) => x.type === 'ObjectProperty' && ((x.key.type === 'Identifier' && x.key.name === key) || (x.key.type === 'StringLiteral' && x.key.value === key)))?.value
        const id = literalText(field('id'))
        const english = literalText(field('defaultMessage'))
        const description = field('description') ? literalText(field('description')) : undefined
        const at = `${rel}:${p.node.loc?.start.line}`
        if (id === undefined || english === undefined || (field('description') && description === undefined)) throw new Error(`${at}: a message's id, defaultMessage and description must be literal text`)
        const m = { defaultMessage: english, ...(description === undefined ? {} : { description }) }
        if (out[id] && JSON.stringify(out[id]) !== JSON.stringify(m)) throw new Error(`Duplicate message id: "${id}", but the \`description\` and/or \`defaultMessage\` are different (${at}).`)
        out[id] = m
      }
    })
  }
  return out
}

/** Every message in the source, by id: with the CLI where it can read source, else with Babel. */
export const extractMessages = (root = ROOT) => (hasNativeCli() ? extractWithCli(root) : extractWithJs(root))

/** What's wrong with the messages as a catalogue: an id that names no area, a message with no note for translators. */
export function messageProblems(messages) {
  const problems = []
  for (const [id, m] of Object.entries(messages)) {
    if (!ID.test(id)) problems.push(`${id}: an id is its area and a name, in parts joined by dots ("settings.general.title")`)
    if (!m.description || m.description.trim().length < 3) problems.push(`${id}: needs a description, a note for translators (what it is and where it shows)`)
  }
  return problems
}

/** The messages by area, each area's ids sorted. */
export function byArea(messages) {
  const areas = new Map()
  for (const id of Object.keys(messages).sort()) {
    const area = areaOf(id)
    if (!areas.has(area)) areas.set(area, {})
    areas.get(area)[id] = messages[id]
  }
  return areas
}

/** The generated files as they should be (path relative to root → content with \n), and those that should be gone. */
export function generatedFiles(root, messages) {
  const want = new Map()
  for (const [area, catalogue] of byArea(messages)) {
    want.set(`${EN_DIR}/${area}.json`, `${JSON.stringify(catalogue, null, 2)}\n`)
    want.set(`${VALUES_DIR}/${area}.d.ts`, valuesDts(area, catalogue))
  }
  const present = [
    ...(existsSync(join(root, EN_DIR)) ? readdirSync(join(root, EN_DIR)).filter((f) => f.endsWith('.json')).map((f) => `${EN_DIR}/${f}`) : []),
    ...(existsSync(join(root, VALUES_DIR)) ? readdirSync(join(root, VALUES_DIR)).filter((f) => f.endsWith('.d.ts')).map((f) => `${VALUES_DIR}/${f}`) : [])
  ]
  return { want, gone: present.filter((f) => !want.has(f)) }
}

const toLf = (s) => s.replace(/\r\n?/g, '\n')

/** The generated files that differ from what the source makes (line endings aside), or should be gone. */
export function extractDrift(root = ROOT, messages = extractMessages(root)) {
  const { want, gone } = generatedFiles(root, messages)
  const stale = [...want].filter(([rel, text]) => !existsSync(join(root, rel)) || toLf(readFileSync(join(root, rel), 'utf8')) !== text).map(([rel]) => rel)
  return [...stale, ...gone].sort()
}

/** Writes text (with \n endings) to a file unless it already says that, line endings aside, keeping the ending the file on disk has (\n for a new one). Returns whether it wrote. */
export function writeKeepingEndings(file, text) {
  const old = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (old !== null && toLf(old) === text) return false
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, old?.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text)
  return true
}

/** Writes the generated files that changed (with the line endings the file on disk has; \n for a new one) and removes those of areas that have no messages left. */
export function writeGenerated(root = ROOT, messages = extractMessages(root)) {
  const { want, gone } = generatedFiles(root, messages)
  const written = []
  for (const [rel, text] of want) if (writeKeepingEndings(join(root, rel), text)) written.push(rel)
  for (const rel of gone) {
    rmSync(join(root, rel))
    written.push(`${rel} (removed)`)
  }
  return written
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = rootArg()
  const messages = extractMessages(root)
  const problems = messageProblems(messages)
  if (problems.length) {
    console.error(`i18n: messages to fix (${problems.length}):\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  const areas = `areas: ${[...byArea(messages).keys()].join(', ') || 'none'}`
  if (process.argv.includes('--check')) {
    const drift = extractDrift(root, messages)
    if (drift.length) {
      console.error(`i18n: out of date with the source (run npm run i18n:extract and commit the result):\n  ${drift.join('\n  ')}`)
      process.exit(1)
    }
    console.log(`i18n: ${Object.keys(messages).length} messages (${areas}), up to date`)
  } else {
    const written = writeGenerated(root, messages)
    console.log(`i18n: ${Object.keys(messages).length} messages (${areas})${written.length ? `; wrote ${written.join(', ')}` : ', unchanged'}${hasNativeCli() ? '' : ' (read without the CLI: no native binding here)'}`)
  }
}
