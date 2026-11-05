// Numbers passed to plain placeholders (#880): a plain `{n}` isn't localised (FormatJS writes `String(n)`), so a number
// that can reach 1,000 or have decimals needs `{n, number}` (AGENTS.md, Translations). `npm run i18n:numbers` lists the
// places that pass a number to a plain placeholder: a review aid when adding messages, not a check (most are card
// numbers, ports, exit codes and small counts that rightly stay plain), so it isn't in CI (tests/i18nNumbers.test.ts
// runs it on a probe, so it keeps working).
//
// How (#879's audit, repeatable): in a copy of src/ (in a new temp folder, with a junction to the repository's
// node_modules so tsc finds the packages; the junction is removed first, on its own, when the copy is), the
// typed values are generated with plain placeholders as `string` instead of `string | number`, the helpers that take a
// message with loose values (PATCHES) are typed by the message, and tRich's calls lose their explicit type argument (so
// the message's id is inferred); then tsc runs on the copy, and each "number isn't string" error is a site. The working
// tree is never changed. A patch that no longer applies (its line was changed) stops the run: update PATCHES.
//
// It lists, apart: values whose type allows a number (a TextPart, a union); calls whose message isn't known where they
// are made (a `Msg` variable, `tr(UNITS[unit], { n })`, or a helper passing on loose values), given a number or a value
// that may be one, where the message decides; and messages that use a placeholder both plain and as a number or plural
// (`{count}` and `{count, plural, …}`: typed number, so its plain use passes). Numbers in JSX outside a message aren't
// messages, and aren't looked at.
//
//   npm run i18n:numbers                    every site, by file
//   npm run i18n:numbers -- --changed       only files changed since the merge base with main (and uncommitted)
//   npm run i18n:numbers -- --keep          keep the copy (its path is printed) to look at it
import { spawnSync } from 'child_process'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { parse, TYPE } from '@formatjs/icu-messageformat-parser'
import { byArea, extractMessages, messageProblems, ROOT, VALUES_DIR } from './i18nExtract.mjs'
import { valuesDts } from './i18nValues.mjs'

/** In the copy, the values of a message known only as `Msg` (its id `string`): no number, and a marker that names them in tsc's errors. */
const DYNAMIC = 'HiveDynamicMessage'
const DYNAMIC_DTS = `// The audit's (scripts/i18nNumbers.mjs): the values of a message whose id isn't known where it is used.\ninterface ${DYNAMIC} { readonly __hiveDynamicMessage: true }\n`

/** A message's values typed by its id, for the helpers below: a plain placeholder takes text, a number or plural a number. */
const AUDIT_V = `type AuditV<Id extends string> = string extends Id ? Record<string, string | Text | ${DYNAMIC}> : Id extends keyof HiveMessageValues ? (HiveMessageValues[Id] extends undefined ? TextValues : { [K in keyof NonNullable<HiveMessageValues[Id]>]: NonNullable<HiveMessageValues[Id]>[K] extends string ? string | Text : TextPart }) : TextValues; export type { AuditV }; `
// NoInfer, here and below: the id comes from the message alone. Inferred from the values too, a value typed `string`
// made it `string` in the copy, so a message known where it is used read as one that isn't.
const V = "NoInfer<import('../shared/advanced').AuditV<Id>>"
/** tRich's values in the copy: a plain placeholder takes text or an element (any React node but a number), never a number; a tag, a function. */
const RICH_TAG = '((chunks: any[]) => unknown)'
const RICH_NODE = 'string | object | boolean | null | undefined'
const RICH_V = `string extends Id ? Record<string, ${RICH_NODE} | ${DYNAMIC} | ${RICH_TAG}> : Id extends keyof HiveMessageValues ? { [K in keyof NonNullable<HiveMessageValues[Id]>]: NonNullable<HiveMessageValues[Id]>[K] extends string ? ${RICH_NODE} : NonNullable<HiveMessageValues[Id]>[K] | object } & Record<string, ${RICH_NODE} | number | ${RICH_TAG}> : Record<string, unknown>`

/** The helpers that take a message with loose values, typed by the message in the copy: [file, text as it is, as patched]. One line each, so the copy's line numbers are the source's. */
export const PATCHES = [
  ['src/shared/i18n/msg.ts', 'export type MessageArgs<Id extends string> = string extends Id ? [values?: Values] :', `export type MessageArgs<Id extends string> = string extends Id ? [values?: Record<string, string | boolean | Date | null | undefined | ${DYNAMIC}>] :`],
  ['src/shared/i18n/index.ts', 'export function tr<Id extends string>(m: Msg<Id>, ...values: MessageArgs<Id>): string {', 'export function tr<Id extends string>(m: Msg<Id>, ...values: NoInfer<MessageArgs<Id>>): string {'],
  ['src/shared/advanced.ts', 'export const withValues = (m: Msg, values: TextValues): Text => ({ m, values })', `${AUDIT_V}export const withValues = <Id extends string>(m: Msg<Id>, values: NoInfer<AuditV<Id>>): Text => ({ m, values: values as TextValues })`],
  // hiveError() is typed by the message already: in the copy a plain placeholder there takes text (a Text too), not a number.
  ['src/main/combworkError.ts', 'type ErrorArgs<Id extends string> = string extends Id', `type ErrorArgs<Id extends string> = string extends Id ? [values?: Record<string, string | Text | ${DYNAMIC}>, options?: { kind?: HiveErrorKind; cause?: unknown }] : string extends Id`],
  ['src/main/combworkError.ts', '(m: Msg<Id>, ...[values, options]: ErrorArgs<Id>): HiveError {', '(m: Msg<Id>, ...[values, options]: NoInfer<ErrorArgs<Id>>): HiveError {'],
  ['src/main/combworkError.ts', 'HiveMessageValues[Id][K] extends string ? string : TextPart }', 'HiveMessageValues[Id][K] extends string ? string | Text : TextPart }'],
  ['src/main/combworkError.ts', 'withValues(m, values as TextValues)', 'withValues(m as Msg, values as never)'],
  ['src/main/gitRepo.ts', 'const refusal = (m: Msg, values?: TextValues): HiveError =>', `const refusal = <Id extends string>(m: Msg<Id>, values?: ${V}): HiveError =>`],
  // failed() adds `why` itself.
  ['src/main/gitRepo.ts', 'function failed(m: Msg, values: TextValues, r: GitResult): Error {', `function failed<Id extends string>(m: Msg<Id>, values: Omit<${V}, 'why'>, r: GitResult): Error {`],
  ['src/main/gitRepo.ts', '  return refusal(m, { ...values, why:', '  return (refusal as (m: Msg, v: TextValues) => HiveError)(m, { ...(values as TextValues), why:'],
  ['src/main/skills.ts', 'function problemOf(m: Msg, values?: TextValues): {', `function problemOf<Id extends string>(m: Msg<Id>, values?: ${V}): {`],
  ['src/main/templates.ts', 'const refusal = (m: Msg, values?: TextValues, kind?:', `const refusal = <Id extends string>(m: Msg<Id>, values?: ${V}, kind?:`],
  ['src/shared/i18n/index.ts', 'export function tRich<T>(m: Msg, values: Record<string, T | string | number | Date | ((chunks: (string | T)[]) => T)>): (string | T)[] {', `export function tRich<Id extends string, T = any>(m: Msg<Id>, values: NoInfer<${RICH_V}>): (string | T)[] {`],
  ...['src/renderer/src/views/FilesTab.tsx', 'src/renderer/src/views/GitTab.tsx', 'src/renderer/src/views/Performance.tsx'].map((file) => [
    file,
    'const rich = (m: Msg, values: Parameters<typeof tRich<React.ReactNode>>[1]): React.ReactNode[] => Children.toArray(tRich<React.ReactNode>(m, values))',
    `const rich = <Id extends string>(m: Msg<Id>, values: NoInfer<${RICH_V}>): React.ReactNode[] => Children.toArray(tRich(m, values as never))`
  ]),
  [
    'src/renderer/src/components/MoveRepair.tsx',
    'const rich = (m: Msg, values: Record<string, string | number>): React.ReactNode[] => Children.toArray(tRich<React.ReactNode>(m, { ...values, ...TAGS }))',
    'const rich = <Id extends string>(m: Msg<Id>, values: Id extends keyof HiveMessageValues ? { [K in keyof NonNullable<HiveMessageValues[Id]>]: NonNullable<HiveMessageValues[Id]>[K] extends string ? string : number } : Record<string, string | number>): React.ReactNode[] => Children.toArray(tRich(m as Msg, { ...values, ...TAGS } as never))'
  ]
]

/** How many times each patch's text is in the source (each must be once): [file, text, count]. */
export const patchCounts = (root = ROOT) => PATCHES.map(([file, from]) => [file, from, readFileSync(join(root, file), 'utf8').split(from).length - 1])

/** A call of tRich with an explicit type argument (`tRich<ReactNode>(`), its definition aside. */
const RICH_CALL = /(?<!function )\btRich<[^()]*?>\(/g

/**
 * The text with tRich's explicit type arguments dropped, so the message's id is inferred: TypeScript infers none of a
 * call's type arguments once one is given. `shifts`: by line (1-based), each [column in the new text, characters removed].
 */
export function dropRichTypeArgs(text) {
  const shifts = new Map()
  const lines = text.split('\n').map((line, i) => {
    let removed = 0
    return line.replace(RICH_CALL, (call, at) => {
      shifts.set(i + 1, [...(shifts.get(i + 1) ?? []), [at - removed + 1, call.length - 'tRich('.length]])
      removed += call.length - 'tRich('.length
      return 'tRich('
    })
  })
  return { text: lines.join('\n'), shifts }
}

/** A column in the copy's line, back in the source's. */
const sourceColumn = (col, shifts = []) => col + shifts.filter(([at]) => at <= col).reduce((n, [, removed]) => n + removed, 0)

/** An error on the values as a whole (tr's: an argument list), moved to the property it names when that is on the line after it. */
function propertyColumn(line, col, text) {
  const name = /(?:Types of property|Property) '([\w$]+)'/.exec(text)?.[1]
  if (!name) return col
  const at = line.slice(col - 1).search(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?=\\s*[:,}])`))
  return at < 0 ? col : col + at
}

/** The messages that use a placeholder both plain and as a number or plural: `{count}` beside `{count, plural, …}`. */
export function mixedPlaceholders(messages) {
  const out = []
  for (const [id, m] of Object.entries(messages)) {
    const plain = new Set()
    const numeric = new Set()
    const walk = (els) => {
      for (const el of els) {
        if (el.type === TYPE.argument) plain.add(el.value)
        if (el.type === TYPE.plural || el.type === TYPE.number) numeric.add(el.value)
        if (el.type === TYPE.tag) walk(el.children)
        if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) walk(o.value)
      }
    }
    walk(parse(m.defaultMessage))
    for (const name of plain) if (numeric.has(name)) out.push({ id, name, message: m.defaultMessage })
  }
  return out
}

/** tsc's errors (`file(line,col): error TSn: text`, with the lines that continue it), paths relative to `dir` with /. */
export function tscErrors(output, dir) {
  const errors = []
  const prefix = dir.replace(/\\/g, '/').replace(/\/?$/, '/')
  for (const line of output.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line)
    if (m) {
      let file = m[1].replace(/\\/g, '/')
      if (file.toLowerCase().startsWith(prefix.toLowerCase())) file = file.slice(prefix.length)
      errors.push({ file, line: +m[2], col: +m[3], code: m[4], text: m[5] })
    } else if (errors.length && /^\s/.test(line)) errors[errors.length - 1].text += `\n${line.trim()}`
  }
  return errors
}

/**
 * What an error in the copy says of a plain placeholder (typed `string` there): 'number', a number reaches it;
 * 'maybe', a value whose type allows a number does (a `TextPart`, a union); 'dynamic', a number or a value that may be
 * one reaches a message whose id isn't known there; null, something else (the copy's own errors).
 */
export function siteKind(e) {
  const lines = e.text.split('\n')
  const at = lines.findIndex((l) => l.startsWith("Type 'number' is not assignable"))
  if (at < 0) return null
  if (e.text.includes(DYNAMIC)) return 'dynamic'
  // The number is the value itself, or a property of the object passed; else it is one member of the value's type.
  return at === 0 || lines[at - 1].startsWith('Types of property') ? 'number' : 'maybe'
}

/** Removes the copy: the junction to the repository's packages first, on its own, and the rest only once it is gone. */
export function removeCopy(dir, modules = join(dir, 'node_modules')) {
  const linked = () => {
    try {
      lstatSync(modules)
      return true
    } catch {
      return false
    }
  }
  if (linked()) rmdirSync(modules)
  if (linked()) throw new Error(`couldn't remove the junction ${modules}; the copy is left in ${dir}`)
  rmSync(dir, { recursive: true, force: true })
}

/**
 * The audit, on a copy of `root`'s src/ with `extra` files added (path → text: tests add a probe). Returns the sites
 * ({ file, line, col, kind, source }: the source's line and column), the messages with mixed placeholders, how many
 * other tsc errors the copy had, and the copy's folder. The copy goes in `dir`, a new empty folder outside the
 * repository (tests give one of theirs; else a new one in the temp folder), and is removed with it unless `keep`.
 */
export function audit({ root = ROOT, extra = {}, keep = false, dir: given } = {}) {
  const bad = patchCounts(root).filter(([, , n]) => n !== 1)
  if (bad.length) throw Object.assign(new Error(`a helper changed, so its patch no longer applies; update PATCHES in scripts/i18nNumbers.mjs:\n  ${bad.map(([f, from, n]) => `${f} (${n}×): ${from.slice(0, 90)}`).join('\n  ')}`), { exitCode: 2 })
  const dir = given ?? mkdtempSync(join(realpathSync.native(tmpdir()), 'cw-i18n-numbers-'))
  if (readdirSync(dir).length) throw new Error(`${dir} isn't empty: the copy needs a new folder`)
  const modules = join(dir, 'node_modules')
  try {
    // The repository's packages, by a junction: tsc looks for them in node_modules beside the copy.
    symlinkSync(join(root, 'node_modules'), modules, 'junction')
    cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true })
    const source = new Map(Object.entries(extra).map(([file, text]) => [file, text.split(/\r?\n/)]))
    for (const [file, text] of Object.entries(extra)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), text)
    }
    for (const [file, from, to] of PATCHES) {
      const path = join(dir, file)
      writeFileSync(path, readFileSync(path, 'utf8').replace(from, () => to))
    }
    const shifts = new Map()
    const walk = (rel) => {
      for (const name of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const r = `${rel}/${name.name}`
        if (name.isDirectory()) walk(r)
        else if (/\.(ts|tsx|mts)$/.test(name.name)) {
          const text = readFileSync(join(dir, r), 'utf8')
          if (!text.includes('tRich<')) continue
          const dropped = dropRichTypeArgs(text)
          writeFileSync(join(dir, r), dropped.text)
          shifts.set(r, dropped.shifts)
        }
      }
    }
    walk('src')
    // The copy's messages (its extra files' too), typed with plain placeholders as `string`.
    const messages = extractMessages(dir)
    const problems = messageProblems(messages)
    if (problems.length) throw new Error(`messages to fix first (npm run i18n:extract says how):\n  ${problems.join('\n  ')}`)
    rmSync(join(dir, VALUES_DIR), { recursive: true, force: true })
    mkdirSync(join(dir, VALUES_DIR), { recursive: true })
    for (const [area, catalogue] of byArea(messages)) writeFileSync(join(dir, VALUES_DIR, `${area}.d.ts`), valuesDts(area, catalogue, 'string'))
    writeFileSync(join(dir, VALUES_DIR, 'zz-audit.d.ts'), DYNAMIC_DTS)
    // tsconfigs that check only src/, the window's aliases into the copy for src/ and the repository's otherwise.
    const node = JSON.parse(readFileSync(join(root, 'tsconfig.node.json'), 'utf8'))
    const web = JSON.parse(readFileSync(join(root, 'tsconfig.web.json'), 'utf8'))
    const paths = Object.fromEntries(Object.entries(web.compilerOptions.paths ?? {}).map(([k, v]) => [k, v.map((p) => (p.startsWith('./src/') ? p : join(root, p).replace(/\\/g, '/')))]))
    const configs = {
      'tsconfig.node.json': { ...node, include: node.include.filter((p) => p.startsWith('src/')) },
      'tsconfig.web.json': { ...web, compilerOptions: { ...web.compilerOptions, paths }, include: web.include.filter((p) => p.startsWith('src/')) }
    }
    const errors = []
    for (const [name, config] of Object.entries(configs)) {
      writeFileSync(join(dir, name), JSON.stringify(config, null, 2))
      const r = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(dir, name), '--pretty', 'false'], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      if (r.error) throw r.error
      errors.push(...tscErrors(`${r.stdout}\n${r.stderr}`, dir))
    }
    // The two configs share src/shared: one site, once.
    const seen = new Set()
    const sites = []
    for (const e of errors) {
      const kind = siteKind(e)
      const k = `${e.file}:${e.line}:${e.col}`
      if (!kind || seen.has(k)) continue
      seen.add(k)
      if (!source.has(e.file)) source.set(e.file, readFileSync(join(root, e.file), 'utf8').split(/\r?\n/))
      const text = source.get(e.file)[e.line - 1] ?? ''
      sites.push({ file: e.file, line: e.line, col: propertyColumn(text, sourceColumn(e.col, shifts.get(e.file)?.get(e.line)), e.text), kind, source: text })
    }
    sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col)
    return { sites, mixed: mixedPlaceholders(messages), other: errors.filter((e) => !siteKind(e)), dir }
  } finally {
    if (!keep) removeCopy(dir, modules)
  }
}

const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })

/** The files changed since the merge base with main, committed or not, relative to the root with /. */
function changedFiles() {
  const base = git(['merge-base', 'HEAD', 'main']).stdout.trim() || 'HEAD'
  const names = [...git(['diff', '--name-only', base]).stdout.split(/\r?\n/), ...git(['ls-files', '--others', '--exclude-standard', 'src']).stdout.split(/\r?\n/)]
  return new Set(names.filter(Boolean))
}

function main(args) {
  let result
  try {
    result = audit({ keep: args.includes('--keep') })
  } catch (e) {
    console.error(`i18n:numbers: ${e.message}`)
    process.exit(e.exitCode ?? 1)
  }
  const { sites, mixed, other, dir } = result
  const changed = args.includes('--changed') ? changedFiles() : null
  const shown = changed ? sites.filter((s) => changed.has(s.file)) : sites
  const print = (list) => {
    let file = ''
    for (const s of list) {
      if (s.file !== file) console.log(`\n${(file = s.file)} (${list.filter((x) => x.file === file).length})`)
      console.log(`  ${s.file}:${s.line}:${s.col}  ${s.source.slice(Math.max(0, s.col - 91), s.col + 59).trim()}`)
    }
  }
  const of = (kind) => shown.filter((s) => s.kind === kind)
  print(of('number'))
  const sections = [
    ['maybe', 'Values whose type allows a number (a TextPart, a union): check what they hold'],
    ['dynamic', "Messages not known where they are used (a Msg variable, or a helper passing on loose values), given a number or a value that may be one: check the messages they can be"]
  ]
  for (const [kind, title] of sections) {
    if (!of(kind).length) continue
    console.log(`\n── ${title} (${of(kind).length}) ──`)
    print(of(kind))
  }
  if (mixed.length) {
    console.log(`\n── Placeholders used both plain and as a number or plural: typed number, so their plain use isn't checked above (${mixed.length}) ──`)
    for (const m of mixed) console.log(`  ${m.id}: {${m.name}} in "${m.message.slice(0, 100)}"`)
  }
  console.log(
    `\ni18n:numbers: ${of('number').length} place(s) pass a number to a plain placeholder, ${of('maybe').length} a value that may be one, ${of('dynamic').length} one to a message not known there${changed ? `, in files changed since main (${sites.length} in all)` : ''}. ` +
      'Each is fine when the number is an id, a port, an exit code or a small count that never reaches 1,000; a count, size or amount that can needs {n, number} (or a plural).' +
      (other.length ? ` (${other.length} other tsc error(s) in the copy were left out: npm run typecheck shows the source's; --keep keeps the copy.)` : '')
  )
  console.log('Not looked at: numbers shown in JSX outside a message.')
  if (args.includes('--keep')) console.log(`The copy: ${dir}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
