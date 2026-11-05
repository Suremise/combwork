/**
 * The clean-install check's search (HI-2592): Darren, 5 Nov 2026, "the app is clean when there is no reference to hive
 * anywhere on a clean install". Used inside the Sandbox by inside/clean-scan.cjs (this checkout's tests folder is mapped
 * there read-only) and on the host by report.cjs, and unit-tested in tests/sandboxClean.test.ts. Node built-ins only.
 *
 * A hit is "hive" in any case, as a whole word or joined to other text, as HG1's sweep read it (HI-2578): Hive, HIVE,
 * hive_, hive-, .hive, Hive's, hiveGuidance, getHive, CW_HIVE. Not a hit: "hive" inside an ordinary word, where it
 * follows a letter in the same case (archive, ARCHIVE, chives, beehive).
 *
 * Where it searches (CATEGORIES): file and folder names and text files under the install folder, the profile folders
 * and the workspace (logs apart), the shortcuts, the registry, the agent's environment, the window's text, Copy
 * Diagnostics and the exported board. app.asar is the one exception: its hits are counted and reported, never failed
 * (the upgrade code that knows the 1.0 names lives in it).
 */
const fs = require('fs')
const path = require('path')

/** Each place searched: its id (the report's check is 9.no-hive-<id>) and what it is, for the report. */
const CATEGORIES = [
  { id: 'install', title: 'the install folder (names, text files and the exes\' version info; app.asar counted apart)' },
  { id: 'roaming', title: '%APPDATA%\\Combwork (names and files)' },
  { id: 'local', title: '%LOCALAPPDATA%\\Combwork (names and files)' },
  { id: 'workspace', title: 'the workspace and its git project (names and files, .git/info/exclude, .gitignore, READMEs)' },
  { id: 'logs', title: 'the logs' },
  { id: 'shortcuts', title: 'the Start menu and Desktop shortcuts (name, target, arguments, AppUserModelID)' },
  { id: 'registry', title: 'the registry: the uninstall key, the app\'s keys, its protocol and AppUserModelID, and every new HKCU key or value' },
  { id: 'env', title: 'the environment the agent gets (`set` in its session)' },
  { id: 'window', title: 'the window\'s text on the pages visited' },
  { id: 'diagnostics', title: 'the Copy Diagnostics text' },
  { id: 'export', title: 'the exported board' }
]
/** How many hits each place keeps with their text (the count is always whole). */
const KEEP = 200
/** A file read whole up to this size; bigger ones are read in parts. */
const CHUNK = 8 * 1024 * 1024

/** The hits in a text: [{ at, match, text }], text the hit's line (shortened around it). */
function hiveHits(text) {
  const s = String(text ?? '')
  const out = []
  const re = /hive/gi
  for (let m; (m = re.exec(s)); ) {
    const before = s[m.index - 1] ?? ''
    // Inside a word: lower-case after any letter (archive, chives), or upper-case after an upper-case letter (ARCHIVE).
    // A capital after a lower-case letter is a join (getHive), and so is anything after a digit, _, -, . or space.
    if (/[a-z]/i.test(before) && (m[0][0] === 'h' || /[A-Z]/.test(before))) continue
    out.push({ at: m.index, match: m[0], text: lineAround(s, m.index, m[0].length) })
  }
  return out
}

/** The line holding s[at, at+len), at most 80 characters each side of it, control characters as dots. */
function lineAround(s, at, len) {
  let a = s.lastIndexOf('\n', at) + 1
  let b = s.indexOf('\n', at + len)
  if (b < 0) b = s.length
  const from = Math.max(a, at - 80)
  const to = Math.min(b, at + len + 80)
  // oxlint-disable-next-line no-control-regex
  return `${from > a ? '…' : ''}${s.slice(from, to).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '.').trim()}${to < b ? '…' : ''}`
}

/** A file's text: UTF-16 by its BOM, else UTF-8; null when it looks binary (a NUL in its first 8 KB). */
function textOf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le')
  if (buf.subarray(0, 8192).includes(0)) return null
  return buf.toString('utf8')
}

/** A binary's hits: its bytes read as Latin-1 (UTF-8 strings) and as UTF-16. */
function binaryHits(buf) {
  return [...hiveHits(buf.toString('latin1')), ...hiveHits(buf.toString('utf16le'))]
}

/** A new tally: { [category]: { scanned, count, hits: [{ place, text }] } }, and app.asar's apart. */
function tally() {
  return { places: Object.fromEntries(CATEGORIES.map((c) => [c.id, { scanned: 0, count: 0, hits: [] }])), asar: [], skipped: [] }
}

/** Counts one thing searched in a category, and its hits ({ text }), each named by place. */
function record(t, category, place, hits) {
  const c = t.places[category]
  if (!c) throw new Error(`no category ${category}`)
  c.scanned++
  for (const h of hits) {
    c.count++
    if (c.hits.length < KEEP) c.hits.push({ place, text: h.text })
  }
}

/** Searches a text for one place (a variable, a page, a registry dump). */
function scanText(t, category, place, text) {
  record(t, category, place, hiveHits(text))
}

const isLog = (p) => /\.log(\.\d+)?$/i.test(p) || /(^|[\\/])logs?[\\/]/i.test(p)

/**
 * Searches a folder: every file and folder's name below it (and the folder's own path's last part), and every file's
 * content, without following links or junctions. Text files always; binary files when binary is 'scan' (the app's own
 * data: its databases), else only named (the install folder's Electron, Chromium and native modules). A log goes under
 * 'logs' whatever the folder. app.asar's hits are counted in t.asar, not failed. `skip(rel)`: true leaves a file's
 * content out (named still), e.g. .git/objects, which is compressed. Returns how many files and folders it went through.
 */
function scanTree(t, category, root, { binary = 'skip', skip = () => false } = {}) {
  let n = 0
  if (!fs.existsSync(root)) return n
  record(t, category, root, hiveHits(path.basename(root)))
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      t.skipped.push({ place: dir, why: String(e.message) })
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      const rel = path.relative(root, full)
      n++
      record(t, isLog(rel) && e.isFile() ? 'logs' : category, full, hiveHits(e.name))
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        walk(full)
        continue
      }
      if (!e.isFile()) continue
      if (/\.asar$/i.test(e.name)) {
        t.asar.push({ place: full, count: fileHits(full, 'scan').length })
        continue
      }
      if (skip(rel.replace(/\\/g, '/'))) continue
      const where = isLog(rel) ? 'logs' : category
      let hits
      try {
        hits = fileHits(full, binary)
      } catch (err) {
        t.skipped.push({ place: full, why: String(err.message) })
        continue
      }
      if (hits) record(t, where, full, hits)
    }
  }
  walk(root)
  return n
}

/** A file's hits: as text, or (binary 'scan') as a binary; null for a binary left unread. Read in parts when large. */
function fileHits(file, binary) {
  const size = fs.statSync(file).size
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(Math.min(size, CHUNK))
    fs.readSync(fd, head, 0, head.length, 0)
    const asText = textOf(head)
    if (asText === null && binary !== 'scan') return null
    const hits = asText === null ? binaryHits(head) : hiveHits(asText)
    // The rest, in parts overlapping by 8 bytes (an even count, for UTF-16), so a "hive" across a boundary is found, at
    // worst twice.
    for (let at = head.length - 8; head.length === CHUNK && at + 8 < size; at += CHUNK - 8) {
      const part = Buffer.alloc(Math.min(CHUNK, size - at))
      fs.readSync(fd, part, 0, part.length, at)
      hits.push(...(asText === null ? binaryHits(part) : hiveHits(part.toString(head[0] === 0xff && head[1] === 0xfe ? 'utf16le' : 'utf8'))))
    }
    return hits
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * `reg query <root> /f hive /s` output as entries: a key ("HKEY_CURRENT_USER\\…") and each value under it ("<key>\\<name>
 * = <data>"). reg's /f matches inside words too (archive), so hiveHits decides.
 */
function regEntries(text) {
  const out = []
  let key = null
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (/^HKEY_/.test(raw)) {
      key = raw.trim()
      out.push(key)
      continue
    }
    const v = /^\s{4}(.*?)\s{4}(REG_\w+)\s{4}?(.*)$/.exec(raw)
    if (key && v) out.push(`${key}\\${v[1]} = ${v[3]}`)
  }
  return out
}

/** The registry entries naming "hive" that weren't there before the install: what the app (or its installer) wrote. */
function newRegistryHits(before, after) {
  const was = new Set(regEntries(before))
  return regEntries(after).filter((e) => !was.has(e) && hiveHits(e).length)
}

/**
 * The report's checks for a scan (C:\out\<prefix>-scan.json, inside/clean-scan.cjs): one a place, which passes with
 * something searched there and no hit, and app.asar's count, which never fails while there is an app.asar to count.
 * add(id, name, ok, detail) is report.cjs's. Returns app.asar's hits, for the report's note.
 */
function cleanChecks(scan, add) {
  for (const c of CATEGORIES) {
    const p = scan?.places?.[c.id]
    const id = `9.no-hive-${c.id}`
    // Something to search must have been there: a place missing (p.why) fails, so a gap is never a pass.
    if (!p || !p.scanned || p.why) {
      add(id, `No "hive" in ${c.title}`, false, `not searched: ${p?.why || 'nothing was there'}`)
      continue
    }
    const shown = p.hits.slice(0, 15).map((h) => `${h.place}: ${h.text}`).join('; ')
    add(id, `No "hive" in ${c.title} (${p.scanned} searched)`, p.count === 0, `${p.count} hit${p.count === 1 ? '' : 's'}: ${shown}${p.count > 15 ? '; …' : ''}`)
  }
  const asar = [].concat(scan?.asar || [])
  const total = asar.reduce((s, a) => s + (a.count || 0), 0)
  add('9.asar-counted', `app.asar's own hits counted, not failed: ${total}`, asar.length > 0, 'no app.asar in the install folder')
  return { total, files: asar }
}

/** The hits, a section of the report: every place with any, and each hit's place and text (as kept). */
function hitsMarkdown(scan) {
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const lines = []
  for (const c of CATEGORIES) {
    const p = scan?.places?.[c.id]
    if (!p?.count) continue
    lines.push(`### ${c.title}: ${p.count}`, '', '| Place | Text |', '|---|---|')
    for (const h of p.hits) lines.push(`| ${esc(h.place)} | ${esc(h.text)} |`)
    if (p.count > p.hits.length) lines.push(`| … | ${p.count - p.hits.length} more |`)
    lines.push('')
  }
  return lines
}

module.exports = { CATEGORIES, KEEP, hiveHits, textOf, tally, record, scanText, scanTree, isLog, regEntries, newRegistryHits, cleanChecks, hitsMarkdown }
