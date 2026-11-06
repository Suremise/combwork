/**
 * The clean-install check's search (HI-2592): Darren, 5 Nov 2026, "the app is clean when there is no reference to hive
 * anywhere on a clean install". Used inside the Sandbox by inside/clean-scan.cjs (this checkout's tests folder is mapped
 * there read-only) and on the host by report.cjs, and unit-tested in tests/sandboxClean.test.ts. Node built-ins only,
 * and the tests folder's own oldNameMatch.cjs.
 *
 * A hit is what the repository's guard counts one (HI-2633: one matcher, tests/oldNameMatch.cjs): the name in any case,
 * as a whole word or joined to anything. Not a hit: only the ordinary words that hold its letters (archive in all its
 * forms, chive, chives, beehive).
 *
 * Where it searches (CATEGORIES): file and folder names and text files under the install folder, the profile folders
 * and the workspace (logs apart), the shortcuts, the registry, the agent's environment, the window's text, Copy
 * Diagnostics and the exported board. app.asar is the one exception: its hits are counted and reported, never failed
 * (the upgrade code that knows the 1.0 names lives in it).
 *
 * The bundled code's contents aren't searched (HI-2647: Darren, 6 Nov, "check the job, not the tree"). The code is the
 * repository's source, compiled, and which source may name the old name (only the upgrade code) is the repository's
 * name guard's job (tests/oldNames.mjs, tests/oldNamesAllow.json). This check's job is what a clean install writes and
 * shows, so the bundled code's files are named and counted (isBundledCode), never read.
 */
const fs = require('fs')
const path = require('path')
// The repository's guard's matcher (HI-2633): both find the same hits.
const { nameHits } = require('../oldNameMatch.cjs')

/** Each place searched: its id (the report's check is 9.no-old-name-<id>) and what it is, for the report. */
const CATEGORIES = [
  { id: 'install', title: 'the install folder (names, text files and the exes\' version info; the bundled code\'s contents left to the repo\'s name guard, app.asar counted apart)' },
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

/**
 * The bundled code under the install folder (`rel` from it): the JavaScript electron-vite builds into out/main,
 * out/preload and out/renderer, as app.asar.unpacked holds it. Its names are searched, its contents aren't: code is the
 * repository's name guard's (HI-2647). Anything else under app.asar.unpacked (a native module, a resource) is searched
 * as before.
 */
const BUNDLED_CODE = /^resources\/app\.asar\.unpacked\/out\/(?:main|preload|renderer)\/(?:[^/]+\/)*[^/]+\.[cm]?js$/i
const isBundledCode = (rel) => BUNDLED_CODE.test(String(rel).replace(/\\/g, '/'))

/** The hits in a text: [{ at, match, text }], text the hit's line (shortened around it). */
function oldNameHits(text) {
  const s = String(text ?? '')
  const out = []
  for (const m of nameHits(s)) out.push({ at: m.at, match: m.match, text: lineAround(s, m.at, m.match.length) })
  return out
}

/** The line holding s[at, at+len), at most 80 characters each side of it, control characters as dots. */
function lineAround(s, at, len) {
  const a = s.lastIndexOf('\n', at) + 1
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
  return [...oldNameHits(buf.toString('latin1')), ...oldNameHits(buf.toString('utf16le'))]
}

/**
 * A new tally: { [category]: { scanned, count, hits: [{ place, text }], unread } }, app.asar's apart, how many of the
 * bundled code's files were named but not read (code), and what couldn't be read ({ category, place, why }), which fails
 * its place: an unread file or folder could hold a hit.
 */
function tally() {
  return { places: Object.fromEntries(CATEGORIES.map((c) => [c.id, { scanned: 0, count: 0, hits: [], unread: 0 }])), asar: [], code: 0, skipped: [] }
}

/** Something in a place that couldn't be read: counted against the place, and kept with why. */
function unread(t, category, place, why) {
  t.places[category].unread = (t.places[category].unread || 0) + 1
  t.skipped.push({ category, place, why: String(why) })
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
  record(t, category, place, oldNameHits(text))
}

const isLog = (p) => /\.log(\.\d+)?$/i.test(p) || /(^|[\\/])logs?[\\/]/i.test(p)

/**
 * Searches a folder: every file and folder's name below it (and the folder's own path's last part), and every file's
 * content, without following links or junctions. Text files always; binary files when binary is 'scan' (the app's own
 * data: its databases), else only named (the install folder's Electron, Chromium and native modules). A log goes under
 * 'logs' whatever the folder. app.asar's hits are counted in t.asar, not failed. `skip(rel)`: true leaves a file's
 * content out (named still), e.g. .git/objects, which is compressed. `code(rel)`: true for the bundled code
 * (isBundledCode), named and counted in t.code, its content left to the repository's name guard. Returns how many files
 * and folders it went through.
 */
function scanTree(t, category, root, { binary = 'skip', skip = () => false, code = () => false } = {}) {
  let n = 0
  if (!fs.existsSync(root)) return n
  record(t, category, root, oldNameHits(path.basename(root)))
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      unread(t, category, dir, e.message)
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      const rel = path.relative(root, full)
      n++
      record(t, isLog(rel) && e.isFile() ? 'logs' : category, full, oldNameHits(e.name))
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        walk(full)
        continue
      }
      if (!e.isFile()) continue
      if (/\.asar$/i.test(e.name)) {
        try {
          t.asar.push({ place: full, count: fileHits(full, 'scan').length })
        } catch (err) {
          unread(t, category, full, err.message)
        }
        continue
      }
      if (code(rel.replace(/\\/g, '/'))) {
        t.code = (t.code || 0) + 1
        continue
      }
      if (skip(rel.replace(/\\/g, '/'))) continue
      const where = isLog(rel) ? 'logs' : category
      let hits
      try {
        hits = fileHits(full, binary)
      } catch (err) {
        unread(t, where, full, err.message)
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
    const hits = asText === null ? binaryHits(head) : oldNameHits(asText)
    // The rest, in parts overlapping by 8 bytes (an even count, for UTF-16), so a "hive" across a boundary is found, at
    // worst twice.
    for (let at = head.length - 8; head.length === CHUNK && at + 8 < size; at += CHUNK - 8) {
      const part = Buffer.alloc(Math.min(CHUNK, size - at))
      fs.readSync(fd, part, 0, part.length, at)
      hits.push(...(asText === null ? binaryHits(part) : oldNameHits(part.toString(head[0] === 0xff && head[1] === 0xfe ? 'utf16le' : 'utf8'))))
    }
    return hits
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * `reg query <root> /f hive /s` output as entries: a key ("HKEY_CURRENT_USER\\…") and each value under it ("<key>\\<name>
 * = <data>"). reg's /f matches inside words too (archive), so oldNameHits decides.
 */
function regEntries(text) {
  const out = []
  let key = null
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (raw.startsWith('HKEY_')) {
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
  return regEntries(after).filter((e) => !was.has(e) && oldNameHits(e).length)
}

/**
 * The report's checks for a scan (C:\out\<prefix>-scan.json, inside/clean-scan.cjs): one a place, which passes with
 * something searched there, nothing there left unread (a folder or file that couldn't be read might hold a hit) and no
 * hit; and app.asar's count, which never fails while there is an app.asar to count.
 * add(id, name, ok, detail) is report.cjs's. Returns app.asar's hits, for the report's note.
 */
function cleanChecks(scan, add) {
  for (const c of CATEGORIES) {
    const p = scan?.places?.[c.id]
    const id = `9.no-old-name-${c.id}`
    // Something to search must have been there: a place missing (p.why) fails, so a gap is never a pass.
    if (!p || !p.scanned || p.why) {
      add(id, `No trace of the old name in ${c.title}`, false, `not searched: ${p?.why || 'nothing was there'}`)
      continue
    }
    const shown = p.hits.slice(0, 15).map((h) => `${h.place}: ${h.text}`).join('; ')
    const hits = p.count ? `${p.count} hit${p.count === 1 ? '' : 's'}: ${shown}${p.count > 15 ? '; …' : ''}` : ''
    // Unread there: the count is the place's own; what is listed, the scan's record of them (kept up to its limit).
    const notRead = [].concat(scan?.skipped || []).filter((s) => s.category === c.id)
    const unreadText = p.unread ? `${p.unread} not read: ${notRead.slice(0, 10).map((s) => `${s.place} (${s.why})`).join('; ')}${p.unread > 10 ? '; …' : ''}` : ''
    add(id, `No trace of the old name in ${c.title} (${p.scanned} searched)`, p.count === 0 && !p.unread, [hits, unreadText].filter(Boolean).join('; '))
  }
  const asar = [].concat(scan?.asar || [])
  const total = asar.reduce((s, a) => s + (a.count || 0), 0)
  add('9.asar-counted', `app.asar's own hits counted, not failed: ${total}`, asar.length > 0, 'no app.asar in the install folder')
  // The bundled code: named, its contents the repository's name guard's (HI-2647). None found means the build's layout
  // moved from under isBundledCode, so a gap is never a pass.
  const code = Number(scan?.code) || 0
  add('9.code-named', `The bundled code's files named, their contents left to the repository's name guard (tests/oldNames.mjs): ${code}`, code > 0, 'no bundled code found in app.asar.unpacked')
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
  // What couldn't be read, each with why: those places fail too.
  const notRead = [].concat(scan?.skipped || [])
  if (notRead.length) {
    lines.push(`### Not read: ${notRead.length}`, '', '| Place | Why |', '|---|---|')
    for (const s of notRead) lines.push(`| ${esc(s.place)} | ${esc(s.why)} |`)
    lines.push('')
  }
  return lines
}

module.exports = { CATEGORIES, KEEP, isBundledCode, oldNameHits, textOf, tally, record, scanText, scanTree, isLog, regEntries, newRegistryHits, cleanChecks, hitsMarkdown }
