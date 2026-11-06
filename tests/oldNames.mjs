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
//
// Every entry must still place at least one hit, or it fails as stale: the list only shrinks. No folder is exempt, nor
// any pattern of words: an allowance names where it is. The list's own file is the one place read as allowances, not
// searched (its entries name the text they allow).
//
// `node tests/oldNames.mjs` prints what fails, by file (the inventory a sweep works from); `--json` prints it as JSON.
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { fileURLToPath } from 'url'

const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs')

export const ALLOW_FILE = 'tests/oldNamesAllow.json'

// old-name: begin detector
/** Every place the name appears, in any case, as a word or joined to anything (myHive, HIVE_DIR, hive2, xhive, hives). */
const NAME = /hive/gi
/**
 * The ordinary words that hold its letters, and only these: archive in all its forms (Archived, unarchive, ARCHIVE_DIR,
 * boardarchive, désarchiver), chive and chives, beehive and beehives. Each is the text just before the letters and just
 * after them. The letters are in one case, all lower or all upper, as the word's are: arcHive, beeHive or ArcHIVE (a
 * capital where a word joins) is a hit.
 */
const ORDINARY = {
  lower: [
    { before: /[Aa]rc$/, after: /^/ },
    { before: /(?:^|[^A-Za-z])[Cc]$/, after: /^s?(?![A-Za-z])/ },
    { before: /(?:^|[^A-Za-z])[Bb]ee$/, after: /^s?(?![A-Za-z])/ }
  ],
  upper: [
    { before: /ARC$/, after: /^/ },
    { before: /(?:^|[^A-Za-z])C$/, after: /^S?(?![A-Za-z])/ },
    { before: /(?:^|[^A-Za-z])BEE$/, after: /^S?(?![A-Za-z])/ }
  ]
}
// old-name: end detector

/** The hits in a text: [{ at, match }]. */
export function nameHits(text) {
  const s = String(text ?? '')
  const out = []
  for (const m of s.matchAll(NAME)) {
    const words = m[0] === m[0].toLowerCase() ? ORDINARY.lower : m[0] === m[0].toUpperCase() ? ORDINARY.upper : []
    const before = s.slice(Math.max(0, m.index - 4), m.index)
    const after = s.slice(m.index + 4, m.index + 6)
    if (words.some((w) => w.before.test(before) && w.after.test(after))) continue
    out.push({ at: m.index, match: m[0] })
  }
  return out
}

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
  const listed = new Set(files)
  for (const e of [...regions, ...strings, ...whole, ...history]) if (!listed.has(e.file)) problems.push(`${e.key}: ${e.file} isn't a file of the repository`)
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
        strSpans.find((r) => r.from <= h.at && end <= r.to)?.entry
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

/** The hits by file, most first, as lines: `<file> (<n>)` then `  <line>: <text>` for each. */
export function inventory(hits) {
  const by = new Map()
  for (const h of hits) by.set(h.file, [...(by.get(h.file) ?? []), h])
  return [...by].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).flatMap(([f, hs]) => [`${f} (${hs.length})`, ...hs.map((h) => `  ${h.line}: ${h.text}`)])
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
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
