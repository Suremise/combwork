// The old name's guard (HI-2617): the stopping rule for the rename (Darren, 5 Nov 2026: iterate "until we clean of the
// rename"). Every tracked file's path and text (and a new one not ignored, so a planted hit fails before it is committed)
// is searched for the app's old name, and each hit fails unless an entry in tests/oldNamesAllow.json places it:
//
// - regions: { file, id, why }, a section of the file between two marker lines, `old-name: begin <id>` and
//   `old-name: end <id>`, in whatever comment the file takes. The upgrade's input literals and conversions, genuine
//   history. A marker the list doesn't name fails: a file can't give itself an exemption.
// - strings: { file, text, why }, an exact text in the file (each place it is found), for a file that can't carry a
//   comment (JSON, a recorded fixture's one line).
// - files: { file, why }, a recorded fixture named whole: what a CLI wrote, kept as it was.
// - paths: { path, why }, a tracked path that names it (a recorded fixture's name).
// - history: { file, from, why }, everything in the file from the line `from` on (CHANGELOG.md's released sections).
// - diffFiles: { file, why }, the upgrade code that must name the old paths and values it converts, and the detector
//   itself: placed whole, here as in the change's check (the Assistant's call on HI-2625: one list, one rule). Never
//   stale: the change's check needs each one, its file clean or not.
//
// Every entry must still place at least one hit, or it fails as stale: the list only shrinks. No folder is exempt, nor
// any pattern of words: an allowance names where it is. The list's own file is the one place read as allowances, not
// searched (its entries name the text they allow).
//
// `node tests/oldNames.mjs` (npm run check:names) prints what fails in the whole tree, by file: the inventory a sweep
// works from; `--json` prints it as JSON. The merge checks run `--diff` (Darren's decision on HI-2617, 6 Nov): only the
// lines and paths a change adds since its target, which the merge queue gives as CW_CHECK_BASE (`--base <ref>` locally;
// with neither it says so and passes). checkDiffNames says what passes there.
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const { baseEnv } = require('./e2e/runContext.cjs')

export const ALLOW_FILE = 'tests/oldNamesAllow.json'

/** The hits in a text: [{ at, match }], by the matcher the clean-install check shares (tests/oldNameMatch.cjs). */
export const { nameHits } = require('./oldNameMatch.cjs')

/** A file's text: UTF-16 by its BOM, else UTF-8; binary content (a NUL in its first 8 KB) as Latin-1, so a name in it is still found. */
export function textOf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le')
  if (buf.subarray(0, 8192).includes(0)) return buf.toString('latin1')
  return buf.toString('utf8')
}

const MARKER = /old-name: (begin|end) ([\w.-]+)/g

/** Each file in `root` (tracked, or new and not ignored), with forward slashes. */
export function repoFiles(root) {
  const listed = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: root, env: baseEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return [...new Set(listed.split('\0').filter(Boolean))].sort()
}

/** The line (1-based) at `at`, and its text, shortened around the hit. */
function lineOf(s, at, len) {
  const a = s.lastIndexOf('\n', at - 1) + 1
  let b = s.indexOf('\n', at)
  if (b < 0) b = s.length
  const line = s.slice(0, a).split('\n').length
  const from = Math.max(a, at - 60)
  const to = Math.min(b, at + len + 60)
  return { line, text: `${from > a ? '…' : ''}${s.slice(from, to).replace(/[\r\t]/g, ' ').trim()}${to < b ? '…' : ''}` }
}

/**
 * The guard over a tree: { hits: [{ file, line, text }], problems: [string] }. `read(file)` gives a file's bytes (null
 * when it can't be read: deleted in the working tree), `allow` the list, `files` the paths searched.
 */
export function checkNames({ files, read, allow }) {
  const hits = []
  const problems = []
  const used = new Set()
  const entries = (kind) => (allow[kind] ?? []).map((e, i) => ({ ...e, key: `${kind}[${i}]` }))
  const regions = entries('regions')
  const strings = entries('strings')
  const whole = entries('files')
  const paths = entries('paths')
  const history = entries('history')
  const upgrade = entries('diffFiles')
  const listed = new Set(files)
  for (const e of [...regions, ...strings, ...whole, ...history, ...upgrade]) if (!listed.has(e.file)) problems.push(`${e.key}: ${e.file} isn't a file of the repository`)
  for (const e of paths) if (!listed.has(e.path)) problems.push(`${e.key}: ${e.path} isn't a file of the repository`)

  for (const file of files) {
    if (nameHits(file).length) {
      const p = paths.find((e) => e.path === file)
      if (p) used.add(p.key)
      else hits.push({ file, line: 0, text: '(its path)' })
    }
    if (file === ALLOW_FILE) continue
    const buf = read(file)
    if (!buf) continue
    const s = textOf(buf)
    const found = nameHits(s)
    // The marked regions: [start, end) of each, by id.
    const open = new Map()
    const spans = []
    for (const m of s.matchAll(MARKER)) {
      const [, kind, id] = m
      const entry = regions.find((e) => e.file === file && e.id === id)
      if (!entry) {
        problems.push(`${file}: the marker "old-name: ${kind} ${id}" isn't in ${ALLOW_FILE}'s regions`)
        continue
      }
      if (kind === 'begin') {
        if (open.has(id) || spans.some((r) => r.entry === entry)) problems.push(`${file}: the region ${id} begins twice`)
        else open.set(id, m.index)
      } else if (!open.has(id)) problems.push(`${file}: the region ${id} ends without beginning`)
      else {
        spans.push({ from: open.get(id), to: m.index + m[0].length, entry })
        open.delete(id)
      }
    }
    for (const id of open.keys()) problems.push(`${file}: the region ${id} never ends`)
    const strs = strings.filter((e) => e.file === file)
    const strSpans = []
    for (const e of strs) {
      for (let i = s.indexOf(e.text); e.text && i >= 0; i = s.indexOf(e.text, i + 1)) strSpans.push({ from: i, to: i + e.text.length, entry: e })
    }
    const wholeEntry = whole.find((e) => e.file === file)
    const upgradeEntry = upgrade.find((e) => e.file === file)
    const hist = history.find((e) => e.file === file)
    let histFrom = Infinity
    if (hist) {
      const i = s.search(new RegExp(`^${hist.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?$`, 'm'))
      if (i < 0) problems.push(`${hist.key}: ${file} has no line "${hist.from}"`)
      else histFrom = i
    }
    for (const h of found) {
      const end = h.at + h.match.length
      const by =
        wholeEntry ||
        (h.at >= histFrom && hist) ||
        spans.find((r) => r.from <= h.at && end <= r.to)?.entry ||
        strSpans.find((r) => r.from <= h.at && end <= r.to)?.entry ||
        upgradeEntry
      if (by) used.add(by.key)
      else hits.push({ file, ...lineOf(s, h.at, h.match.length) })
    }
  }
  for (const e of [...regions, ...strings, ...whole, ...paths, ...history]) {
    if (!used.has(e.key)) problems.push(`${e.key} (${e.file ?? e.path}${e.id ? `, ${e.id}` : ''}) places no hit: remove it`)
  }
  return { hits, problems }
}

/** The guard over the repository at `root`, with its own list. */
export function checkRepoNames(root) {
  const allow = JSON.parse(readFileSync(join(root, ALLOW_FILE), 'utf8'))
  const read = (f) => {
    try {
      return readFileSync(join(root, f))
    } catch (e) {
      if (e?.code === 'ENOENT') return null // tracked, deleted in the working tree
      throw e
    }
  }
  return checkNames({ files: repoFiles(root), read, allow })
}

/**
 * The path a diff's `+++ ` header names, without its `b/`: unquoted from git's C-style quoting ("b/caf\303\251.txt",
 * octal bytes as UTF-8), and without the tab git adds after a name holding a space. null for /dev/null.
 */
export function diffPath(header) {
  let s = header.replace(/\r$/, '')
  if (s.startsWith('"')) {
    const bytes = []
    const esc = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
    let i = 1
    for (; i < s.length && s[i] !== '"'; i++) {
      if (s[i] !== '\\') bytes.push(...Buffer.from(s[i], 'utf8'))
      else if (/[0-7]/.test(s[i + 1] ?? '')) {
        bytes.push(parseInt(s.slice(i + 1, i + 4), 8))
        i += 3
      } else bytes.push(esc[s[++i]] ?? s.charCodeAt(i))
    }
    s = Buffer.from(bytes).toString('utf8')
  } else s = s.replace(/\t$/, '')
  if (s === '/dev/null') return null
  return s.startsWith('b/') ? s.slice(2) : s
}

/** A line of a change's own that may name the old name: an `old-name: <why>` comment on it (not a region's begin or end). */
const LINE_MARKER = /old-name: (?!begin |end )\S/

/**
 * The names check of a change (Darren's decision on HI-2617, 6 Nov): only the lines it adds since `base` (its merge base
 * with HEAD; the working tree, so uncommitted lines count too, and files new and not ignored whole) and the paths it
 * adds. A hit there fails unless:
 * - its file is one of oldNamesAllow.json's `diffFiles`: the upgrade code that must name the old paths, and the
 *   detector itself;
 * - the whole-tree allowances place it (a listed region, string, file or path; the released CHANGELOG sections; the
 *   AGENTS.md rename line);
 * - or the line carries an `old-name: <why>` comment, for a legitimate old-name input elsewhere.
 * `node tests/oldNames.mjs` (no --diff) is still the whole tree's report.
 */
export function checkDiffNames(root, base) {
  const allow = JSON.parse(readFileSync(join(root, ALLOW_FILE), 'utf8'))
  const git = (...args) => execFileSync('git', args, { cwd: root, env: baseEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const from = git('merge-base', base, 'HEAD').trim()
  const diffFiles = new Set((allow.diffFiles ?? []).map((e) => e.file))
  // The files it adds and changes, by name as git has them (-z: a space, a quote or a non-ASCII letter kept as it is,
  // HI-2633). A new file, committed or not, is searched whole, its name too.
  const names = (filter) => git('diff', '--name-only', '-z', '--no-renames', `--diff-filter=${filter}`, from, '--').split('\0').filter(Boolean)
  const newFiles = new Set([...names('A'), ...git('ls-files', '-z', '-o', '--exclude-standard').split('\0').filter(Boolean)])
  const added = new Map([...newFiles].map((f) => [f, 'all']))
  // The lines each changed file adds, by its line numbers now, from its hunks' headers.
  const changed = names('M').filter((f) => !newFiles.has(f))
  const hunks = (out, set, only) => {
    let file = only
    // In a file's header (from its `diff --git` line to its first hunk), not in a hunk, where an added "++ x" reads the same.
    let header = false
    for (const line of out.split('\n')) {
      if (line.startsWith('diff --git ')) {
        header = true
        if (!only) file = null
      } else if (line.startsWith('@@')) header = false
      if (!only && header && line.startsWith('+++ ')) file = diffPath(line.slice(4))
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!h || !file) continue
      const lines = set.get(file) ?? new Set()
      for (let i = 0, n = h[2] === undefined ? 1 : Number(h[2]); i < n; i++) lines.add(Number(h[1]) + i)
      set.set(file, lines)
    }
  }
  const diff = (...paths) => git('-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--diff-filter=M', from, '--', ...paths)
  const parsed = new Map()
  if (changed.length) hunks(diff(), parsed, null)
  for (const f of changed) {
    // A name its header didn't give back as it is (some character git still quotes): that file's diff alone.
    if (!parsed.has(f)) hunks(diff(f), parsed, f)
    added.set(f, parsed.get(f) ?? new Set())
  }
  const read = (f) => {
    try {
      return readFileSync(join(root, f))
    } catch (e) {
      if (e?.code === 'ENOENT') return null
      throw e
    }
  }
  const hits = []
  for (const f of [...new Set([...added.keys(), ...newFiles])].sort()) {
    if (diffFiles.has(f)) continue
    const lines = added.get(f) ?? new Set()
    const buf = read(f)
    const text = buf ? textOf(buf).split('\n') : []
    for (const h of checkNames({ files: [f], read, allow }).hits) {
      if (h.line === 0 ? !newFiles.has(f) : lines !== 'all' && !lines.has(h.line)) continue
      if (h.line && LINE_MARKER.test(text[h.line - 1] ?? '')) continue
      hits.push(h)
    }
  }
  return { base: from, hits }
}

/** The hits by file, most first, as lines: `<file> (<n>)` then `  <line>: <text>` for each. */
export function inventory(hits) {
  const by = new Map()
  for (const h of hits) by.set(h.file, [...(by.get(h.file) ?? []), h])
  return [...by].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).flatMap(([f, hs]) => [`${f} (${hs.length})`, ...hs.map((h) => `  ${h.line}: ${h.text}`)])
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--diff')) {
  // check:repo's: the merge queue gives the target's head (CW_CHECK_BASE); locally, --base <ref>.
  const root = join(fileURLToPath(import.meta.url), '..', '..')
  const at = process.argv.indexOf('--base')
  const base = (at > 0 ? process.argv[at + 1] : null) || process.env.CW_CHECK_BASE
  if (!base) console.log('names check of a change: skipped, no base (the merge queue gives CW_CHECK_BASE; locally: node tests/oldNames.mjs --diff --base <target>)')
  else {
    const { base: from, hits } = checkDiffNames(root, base)
    for (const l of inventory(hits)) console.log(l)
    if (hits.length) console.log(`${hits.length} added line(s) or path(s) name the old name since ${from.slice(0, 9)}: reword them, or mark a legitimate old-name input with an \`old-name: <why>\` comment on its line (tests/oldNames.mjs)`)
    process.exitCode = hits.length ? 1 : 0
  }
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(import.meta.url), '..', '..')
  const { hits, problems } = checkRepoNames(root)
  if (process.argv.includes('--json')) console.log(JSON.stringify({ hits, problems }, null, 1))
  else {
    for (const p of problems) console.log(`problem: ${p}`)
    for (const l of inventory(hits)) console.log(l)
    console.log(`${hits.length} hit(s) in ${new Set(hits.map((h) => h.file)).size} file(s), ${problems.length} problem(s)`)
  }
  process.exitCode = hits.length || problems.length ? 1 : 0
}
