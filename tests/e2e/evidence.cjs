// What the tests may delete in %LOCALAPPDATA%\combwork-test (#253): never what a card that isn't Done cites as evidence,
// and nothing at all while the board can't be read. Every deletion of test output goes through here: the clean-up
// (clean.mjs), the e2e runner's suite folders and log pruning (run.mjs, logs.mjs), the scenario runner's lane folders,
// results and baselines (tests/scenarios). Removing never follows a link out (a worktree's node_modules is a junction).
//
// A card cites a path under combwork-test by writing it (in its title, description or a comment, any slash and case):
// - the thing itself, ending with at least its folder and name: `e2e\review158-dark.png`, `lanes\0\board\board.png`,
//   `%LOCALAPPDATA%\combwork-test\evidence`;
// - a path inside a folder keeps the folder: `evidence\x.png` keeps `evidence`, `lanes\0\board\board.png` keeps the
//   suite folder `lanes\0\board` (but not the rest of lane 0);
// - a folder as a whole keeps everything in it: `combwork-test\evidence` (ending there) keeps what is in it, and
//   `lanes\0\board\` keeps that suite's folder. Only folders that hold evidence count, not the areas themselves
//   (`combwork-test`, `e2e`, `e2e\lanes`, a lane `e2e\lanes\0`, `scratch`, the unit tests' `tmp`…), which cards name when they talk about the
//   tests: a lane is where runs keep their suites' folders, not evidence, and a card naming one kept every folder every
//   later run made in it (#285).
// A name alone isn't a citation: a card listing leftovers to remove names them (`charts-132`), and a folder named like
// a word (`scripts`) would be kept by any path with that word (`scripts/licenses.mjs`). Keeping a little more than
// needed is the safe side.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const runContext = require('./runContext.cjs')
const { readCitingDocs } = require('./boardRows.cjs')

/** Areas: folders that hold evidence rather than being it (relative to combwork-test). Naming one keeps nothing. */
const AREAS = new Set(['', 'e2e', 'e2e/lanes', 'e2e/logs', 'e2e/logs/nested', 'scenarios', 'scenarios/lanes', 'scenarios/results', 'scenarios/baselines', 'scratch', 'tmp', 'codex', 'codex/sessions', 'codex/packages', 'codex/cache'])
/**
 * Whether rel (relative to combwork-test, with `/`) is an area: one of AREAS, a lane (`e2e/lanes/0`, `scenarios/lanes/3`), or
 * in the Codex test home a year or month of rollouts, a package or its releases, or a cache (#404: cards name the home
 * and its folders when they talk about Codex; a rollout, a day's rollouts or a release cited keeps it).
 */
const isArea = (rel) => AREAS.has(rel) || /^(?:e2e|scenarios)\/lanes\/\d+$/.test(rel) || /^codex\/(?:sessions\/\d{4}(?:\/\d{2})?|packages\/[^/]+(?:\/releases)?|cache\/[^/]+)$/.test(rel)

/**
 * Areas of the temp folder (clearDir, #304): Claude Code's sessions folder and the folders down to a scratchpad
 * (`claude`, `claude/<project>`, `claude/<project>/<session>`, `…/scratchpad`). Naming one keeps nothing, as for combwork-test's.
 */
const isTempArea = (rel) => /^claude(?:\/[^/]+(?:\/[^/]+(?:\/scratchpad)?)?)?$/.test(rel)

/** Text written as a path: lower case, `/` for `\` (and for `\\` in JSON or Markdown). */
const pathText = (s) => String(s ?? '').toLowerCase().replace(/\\+/g, '/')

const NAME = /[a-z0-9._-]/
const isName = (c) => c !== undefined && NAME.test(c)

/**
 * Whether text has `part` as a path of its own, not inside a longer name before it. how: 'end' (it ends there: a
 * full stop or a slash closing a sentence or a folder isn't more of it), 'inside' (a path goes on into it: `part/x`),
 * 'either'.
 */
function mentions(text, part, how = 'either') {
  for (let i = text.indexOf(part); i >= 0; i = text.indexOf(part, i + 1)) {
    if (isName(text[i - 1])) continue
    const a = text[i + part.length]
    const b = text[i + part.length + 1]
    const inside = a === '/' && isName(b)
    const ends = !isName(a) ? !inside : a === '.' && !isName(b)
    if (how === 'inside' ? inside : how === 'end' ? ends : inside || ends) return true
  }
  return false
}

/** Its tails of at least two parts: ['combwork-test','e2e','x'] → 'combwork-test/e2e/x', 'e2e/x'. */
const tails = (parts) => Array.from({ length: Math.max(0, parts.length - 1) }, (_, k) => parts.slice(k).join('/'))

/**
 * The card citing a path under combwork-test (rel: relative to it, e.g. `e2e/lanes/0/board`), or null. children: the names
 * in it when it is a folder (so `evidence\x.png` keeps `evidence`; deeper paths keep it too, as `x/…`). label: the
 * root's own name as cards write it (`combwork-test`; `temp` for paths in the temp folder, clearDir), whose areas don't count.
 */
function citedBy(rel, cards, children = [], label = 'combwork-test') {
  const own = pathText(rel).split('/').filter(Boolean)
  const parts = [label, ...own]
  const ancestors = []
  const area = label === 'temp' ? isTempArea : isArea
  for (let k = 1; k < own.length; k++) if (!area(own.slice(0, k).join('/'))) ancestors.push([label, ...own.slice(0, k)])
  // Each tail ends with the path's last two parts, so a text without them (or, for a child, without `<last>/<child>`)
  // can't mention one: looked for first, they spare scanning every card for every tail (HI-2365: the clean-up's plan
  // spent seconds here). The answer is the same.
  const last = parts.slice(-2).join('/')
  const kids = children.map((c) => pathText(c))
  for (const { number, text } of cards) {
    if (text.includes(parts.at(-1))) {
      if (text.includes(last)) for (const t of tails(parts)) if (mentions(text, t)) return number
      for (const c of kids) if (text.includes(`${parts.at(-1)}/${c}`)) for (const t of tails([...parts, c])) if (mentions(text, t)) return number
    }
    for (const a of ancestors) if (text.includes(a.slice(-2).join('/'))) for (const t of tails(a)) if (mentions(text, t, 'end')) return number
  }
  return null
}

/**
 * The workspace's board for the repository at root, found up from its main checkout: its database (.combwork\combwork.db,
 * #1017) or, before that, its cards folder (.combwork\tasks); null when there is none. Current names only (HI-2622): a
 * workspace no 1.1 has opened yet has no board here until it is opened. A workspace moved to the database keeps a stub
 * tasks folder for older versions: the database is looked for first, so the stub never counts.
 */
function findBoard(root) {
  let dir
  try {
    dir = path.dirname(path.resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: runContext.baseEnv() }).trim()))
  } catch {
    dir = root
  }
  for (;;) {
    const db = path.join(dir, '.combwork', 'combwork.db')
    if (fs.existsSync(db)) return db
    const tasks = path.join(dir, '.combwork', 'tasks')
    if (fs.existsSync(path.join(tasks, 'board.json'))) return tasks
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** A card that may cite evidence: neither Done nor archived, with its words (title, description, comments) as pathText. */
const citing = (c) => (!c || c.archived || c.column === 'done' ? null : { number: c.number, text: pathText([c.title, c.description, ...(c.comments ?? []).map((m) => m.text)].join('\n')) })

/** The cards from a board's database (read-only; Combwork writing meanwhile is fine: WAL), as readCards gives them. */
function readDbCards(file) {
  let db
  try {
    const { DatabaseSync } = require('node:sqlite')
    db = new DatabaseSync(file, { readOnly: true, timeout: 5000 })
    const cards = []
    for (const row of readCitingDocs(db)) {
      const c = citing({ ...row.doc, number: row.number })
      if (c) cards.push(c)
    }
    return { ok: true, cards }
  } catch (e) {
    return { ok: false, why: `the board (${file}) can't be read: ${e.code ?? e.message}` }
  } finally {
    db?.close()
  }
}

/**
 * The cards that may cite evidence, from a board (its database, or a folder of card files before 0.9): { ok: true,
 * cards: [{ number, text }] } for every card that is neither Done nor archived (its title, description and comments, as
 * pathText), or { ok: false, why } when any card can't be read (a card file being saved is read again once first): then
 * nothing may be deleted.
 */
function readCards(tasksDir) {
  if (tasksDir.endsWith('.db')) return readDbCards(tasksDir)
  let names
  try {
    names = fs.readdirSync(tasksDir).filter((n) => /^\d+\.json$/.test(n))
  } catch (e) {
    return { ok: false, why: `the board (${tasksDir}) can't be read: ${e.code ?? e.message}` }
  }
  const cards = []
  for (const name of names) {
    let c = null
    for (let attempt = 0; attempt < 2 && !c; attempt++) {
      try {
        c = JSON.parse(fs.readFileSync(path.join(tasksDir, name), 'utf8'))
      } catch (e) {
        if (e.code === 'ENOENT') break // Archived or removed meanwhile: it cites nothing now.
        if (attempt) return { ok: false, why: `card ${name} on the board (${tasksDir}) can't be read` }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
    }
    const cited = citing(c)
    if (cited) cards.push(cited)
  }
  return { ok: true, cards }
}

/**
 * What may be deleted under testRoot, by the board's cards: protects(p) gives why p must stay (`cited by #n`, or that
 * the board can't be read), or null. Built from a board (tasksDir: its database or folder; null: none found, so nothing may go) or from
 * cards given (tests). Every protects() reads the board afresh (a few ms: only the cards that may cite, HI-2364), so a deletion is never authorised by
 * an older look: a card that cites something a moment before it would go keeps it. snapshot() reads it once, for
 * listing many things (the clean-up's plan), never for deleting.
 */
function evidence({ tasksDir, cards, testRoot = runContext.TEST_ROOT, label = 'combwork-test' } = {}) {
  const load = () => {
    if (cards) return { ok: true, cards }
    if (!tasksDir) return { ok: false, why: "no board was found (the workspace's board in .combwork, up from this repository's main checkout)" }
    return readCards(tasksDir)
  }
  /** Rules over one look (get: the cards, read when asked). */
  const rules = (get) => ({
    get ok() {
      return get().ok
    },
    get why() {
      return get().why ?? null
    },
    /** Why p (a path under testRoot) must stay, or null when it may go. */
    protects(p) {
      const s = get()
      if (!s.ok) return s.why
      const rel = path.relative(testRoot, p)
      if (rel.startsWith('..') || path.isAbsolute(rel)) return 'outside combwork-test'
      // A folder on the way that is a link (a junction) would carry the deletion somewhere else.
      const link = linkOnTheWay(testRoot, p)
      if (link) return `reached through a link (${link})`
      const n = citedBy(rel.split(path.sep).join('/'), s.cards, safeList(p), label)
      return n === null ? null : `cited by #${n}`
    },
    /** One look at the board, for listing many things (not for deleting): the same ok, why and protects(p). */
    snapshot() {
      const s = get()
      return rules(() => s)
    }
  })
  return rules(load)
}

/**
 * The evidence rules for the repository at root (its workspace's board). CW_TEST_NO_BOARD=1 says there is no board
 * whose cards could cite test output (a checkout outside a Combwork workspace): then nothing is evidence. Without it, no
 * board found means nothing may be deleted, and the runners won't start (#285: copies would pile up run after run).
 */
const evidenceFor = (root, opts = {}, env = process.env) => (env.CW_TEST_NO_BOARD === '1' ? evidence({ cards: [], ...opts }) : evidence({ tasksDir: findBoard(root), ...opts }))

/**
 * The first folder between root and p (root and p themselves not counted) that is a link (a junction or a symlink), or
 * null; one that can't be looked at counts as a link. Anything deleted below it would be deleted where it points (#285).
 * p itself may be a link: removeTree removes a link as a link.
 */
function linkOnTheWay(root, p) {
  const parts = path.relative(path.resolve(root), path.resolve(p)).split(path.sep).filter(Boolean)
  let at = path.resolve(root)
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part)
    try {
      if (fs.lstatSync(at).isSymbolicLink()) return at
    } catch (e) {
      if (e.code === 'ENOENT') return null // Not there: nothing below it either.
      return at
    }
  }
  return null
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** A folder's or file's size in bytes, links counted as nothing (never followed). */
function sizeOf(p) {
  let st
  try {
    st = fs.lstatSync(p)
  } catch {
    return 0
  }
  if (st.isSymbolicLink()) return 0
  if (!st.isDirectory()) return st.size
  let total = 0
  for (const name of safeList(p)) total += sizeOf(path.join(p, name))
  return total
}

/** Removes the links in a tree (junctions, symlinks) as links, without following them, so a recursive delete can't. */
function unlinkLinks(p) {
  let st
  try {
    st = fs.lstatSync(p)
  } catch {
    return
  }
  if (st.isSymbolicLink()) {
    try {
      fs.unlinkSync(p)
    } catch {
      fs.rmdirSync(p) // A junction to a folder.
    }
    return
  }
  if (st.isDirectory()) for (const name of safeList(p)) unlinkLinks(path.join(p, name))
}

/** Removes a file or folder (links in it as links): its size, or throws. Callers check protects() first. */
function removeTree(p) {
  const size = sizeOf(p)
  unlinkLinks(p)
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  return size
}

/**
 * At most this many copies of one folder (`dir`, `dir-2`… `dir-32`): a failed suite's is kept with its run (KEEP_RUNS,
 * and failed runs a day: logs.mjs), so a suite failing in every kept run needs about thirty. More means something keeps
 * them that shouldn't (#285: a card naming a lane kept 2,078 of them): freshFolder stops there rather than fill the disk.
 */
const MAX_COPIES = 32

/**
 * A folder of its own for a run to fill (a suite's in its lane, a scenario's): `dir` itself, emptied, unless something
 * in it must stay (ev.protects: cited, or the board can't be read; or claimed(d): a failed run still keeps it), then the
 * first of `dir-2`, `dir-3`… that is free or may be emptied. So a run never deletes evidence from an earlier one.
 * Returns the folder, made and empty; throws when all `max` are taken (saying what keeps them).
 */
function freshFolder(dir, ev, { max = MAX_COPIES, claimed = () => false } = {}) {
  let why = null
  for (let n = 1; ; n++) {
    if (n > max) throw new Error(`${max} copies of ${path.basename(dir)} are kept in ${path.dirname(dir)} and none may be reused (${why}): remove them (npm run test:clean, once nothing cites them)`)
    const d = n === 1 ? dir : `${dir}-${n}`
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true })
      return d
    }
    why = ev.protects(d) || (claimed(d) ? 'a failed run keeps it' : null)
    if (why) continue
    try {
      removeTree(d)
      fs.mkdirSync(d, { recursive: true })
      return d
    } catch (e) {
      // Still in use (a test Combwork of a crashed run): take the next.
      why = `in use: ${e.code ?? e.message}`
    }
  }
}

/**
 * The first link (a junction or a symlink) anywhere on p's path, from the drive's root down to p itself, or null; one
 * that can't be looked at counts as a link. For clearDir (#304): unlike linkOnTheWay, the allowed root and the folders
 * above it count too, so a root that is a junction can't carry a delete somewhere else.
 */
function linkOnPath(p) {
  const full = path.resolve(p)
  const { root } = path.parse(full)
  let at = root
  for (const part of full.slice(root.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part)
    try {
      if (fs.lstatSync(at).isSymbolicLink()) return at
    } catch (e) {
      if (e.code === 'ENOENT') return null // Not there: nothing below it either.
      return at
    }
  }
  return null
}

/** p as written and, when it (or the part of it that exists) can be resolved, as it really is: for comparing places. */
function pathForms(p) {
  const full = path.resolve(p)
  const forms = new Set([full.toLowerCase()])
  let at = full
  const rest = []
  while (!fs.existsSync(at) && path.dirname(at) !== at) {
    rest.unshift(path.basename(at))
    at = path.dirname(at)
  }
  try {
    forms.add(path.join(fs.realpathSync.native(at), ...rest).toLowerCase())
  } catch {
    // Can't be resolved: as written only.
  }
  return [...forms]
}

/** p's path relative to root when p is strictly inside it (not root itself), else null. */
function within(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(p))
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null
}

/**
 * Empties a folder of your own so a rerun starts clean (#304), from Node: nobody needs a shell delete on a computed path
 * (`rm -rf "$(…)"`, which Claude Code can't check, so it asks, and unattended it denies). Only a probe's or a suite's
 * own folder: inside a Claude Code scratchpad (`<temp>\claude\…\scratchpad\<x>`), a `cw…` folder in the temp folder
 * (or inside one), or inside combwork-test's `scratch` or `e2e` (not its lanes or logs, which the runners own). Never one of
 * those areas itself, a CLI test home or a folder holding one (as written or as it really is), anything with a link on
 * its path (the roots and the folders above them included) or a link itself, a file,
 * or evidence (a card that isn't Done cites it or something in it, or the board can't be read). board: { tasksDir } or
 * { cards } (evidence()). Returns the folder, made and empty; throws saying why it refused, having deleted nothing.
 */
function clearDir(target, { board = {}, temp = os.tmpdir(), testRoot = runContext.TEST_ROOT, homes = [runContext.CODEX_HOME, runContext.CLAUDE_TEST_HOME] } = {}) {
  if (!target) throw new Error('Name the folder to clear.')
  const p = path.resolve(String(target))
  // A link anywhere on the way, the allowed roots and the folders above them included, would carry the delete elsewhere.
  const link = linkOnPath(p)
  if (link) throw new Error(link.toLowerCase() === p.toLowerCase() ? `${p} is a link: never cleared.` : `${p} is reached through a link (${link}): never cleared.`)
  // The test homes, compared as written and as they really are (a home reached through a link elsewhere is still one).
  const near = (a, b) => a === b || within(a, b) !== null || within(b, a) !== null
  for (const h of homes) if (pathForms(h).some((hf) => pathForms(p).some((pf) => near(hf, pf)))) throw new Error(`${p} is a CLI test home, or holds or is in one: never cleared (its sign-in).`)
  let root
  const inTest = within(testRoot, p)
  const inTemp = within(temp, p)
  if (inTest !== null) {
    const rel = inTest.split(path.sep).join('/').toLowerCase()
    const own = /^scratch\/[^/]/.test(rel) || (/^e2e\/[^/]/.test(rel) && !/^e2e\/(?:lanes|logs)(?:\/|$)/.test(rel))
    if (!own || isArea(rel)) throw new Error(`${p} isn't a probe's or a suite's own folder: in combwork-test only folders inside scratch, or inside e2e outside its lanes and logs, are cleared.`)
    root = testRoot
  } else if (inTemp !== null) {
    const parts = inTemp.split(path.sep)
    const pad = parts.findIndex((x) => x.toLowerCase() === 'scratchpad')
    const own = (parts[0].toLowerCase() === 'claude' && pad > 0 && pad < parts.length - 1) || /^cw/i.test(parts[0])
    if (!own) throw new Error(`${p} isn't a probe's folder: in the temp folder only folders inside a Claude Code scratchpad, or cw… folders, are cleared.`)
    root = temp
  } else throw new Error(`${p} is outside the temp folder and combwork-test: never cleared.`)
  let st = null
  try {
    st = fs.lstatSync(p)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  if (st?.isSymbolicLink()) throw new Error(`${p} is a link: never cleared.`)
  if (st && !st.isDirectory()) throw new Error(`${p} is a file, not a folder.`)
  // Judged as the cards write it: `combwork-test\…`, or `Temp\…` for the temp folder.
  const why = st ? evidence({ ...board, testRoot: root, label: root === testRoot ? 'combwork-test' : 'temp' }).protects(p) : null
  if (why) throw new Error(`${p} must stay: ${why}.`)
  for (const name of safeList(p)) removeTree(path.join(p, name))
  fs.mkdirSync(p, { recursive: true })
  return p
}

/**
 * A suite's folder when it ends (#285): when it passed (or skipped), the whole folder goes, unless the board, read as
 * it is now, says it must stay (a card cites it, or the board can't be read). A failed suite's stays for a look. What
 * stays is the run's to remove: recordKept() ties it to the run's log folder, and it goes when that run's logs are
 * pruned (releaseKept). Returns { removed, kept: why or null }.
 */
function finishSuiteDir(dir, ev, passed) {
  if (!passed) return { removed: false, kept: 'it failed' }
  const why = ev.protects(dir)
  if (why) return { removed: false, kept: why }
  try {
    removeTree(dir)
    return { removed: true, kept: null }
  } catch (e) {
    return { removed: false, kept: `in use: ${e.code ?? e.message}` }
  }
}

/** In a run's log folder: the suite folders the run kept (failed, or not removable when it ended). */
const KEPT_FILE = '.kept-folders.json'

/** Ties folders to a run (its log folder): they are removed when the run's logs are (releaseKept). */
function recordKept(runDir, dirs) {
  if (!dirs.length) return
  let had = []
  try {
    had = JSON.parse(fs.readFileSync(path.join(runDir, KEPT_FILE), 'utf8'))
  } catch {
    // None yet.
  }
  fs.writeFileSync(path.join(runDir, KEPT_FILE), JSON.stringify([...new Set([...had, ...dirs])], null, 1))
}

/** The folders a run (its log folder) kept. */
function keptBy(runDir) {
  try {
    const dirs = JSON.parse(fs.readFileSync(path.join(runDir, KEPT_FILE), 'utf8'))
    return Array.isArray(dirs) ? dirs.filter((d) => typeof d === 'string') : []
  } catch {
    return []
  }
}

/** A run's own suite folder in a lane: `e2e/lanes/<k>/<suite>`, or a nested run's inside one (`…/<suite>/nested/<suite>`). */
const SUITE_FOLDER = /^e2e\/lanes\/(\d+)\/[a-z0-9][a-z0-9._-]*(?:\/nested\/[a-z0-9][a-z0-9._-]*)*$/i

/**
 * Where a manifest entry may be removed from: { path, lane } when it is a suite folder in a lane under testRoot (that
 * shape exactly, no `..`, a real folder and not a link), else null. A manifest is the runner's own record, but a wrong
 * or damaged one must never point a deletion at a test home, scenario results or a lane itself.
 */
function suiteFolderTarget(entry, testRoot) {
  const shape = suiteFolderShape(entry, testRoot)
  if (!shape) return null
  try {
    const st = fs.lstatSync(shape.path)
    if (!st.isDirectory() || st.isSymbolicLink()) return null
    // Really there, not through a link: no folder on the way is one, and its real path is where its path says.
    if (linkOnTheWay(testRoot, shape.path)) return null
    const real = path.relative(fs.realpathSync.native(testRoot), fs.realpathSync.native(shape.path))
    if (real.toLowerCase() !== path.relative(path.resolve(testRoot), shape.path).toLowerCase()) return null
  } catch {
    return null
  }
  return shape
}

/** suiteFolderTarget's path checks alone (not whether it is there): { path, lane } or null. */
function suiteFolderShape(entry, testRoot) {
  if (typeof entry !== 'string' || !path.isAbsolute(entry) || /(^|[\\/])\.\.?([\\/]|$)/.test(entry)) return null
  const rel = path.relative(testRoot, path.resolve(entry))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const m = SUITE_FOLDER.exec(rel.split(path.sep).join('/'))
  return m ? { path: path.resolve(entry), lane: Number(m[1]) } : null
}

/**
 * Before a run's logs are pruned: removes the suite folders it kept (#285). Only when its manifest is entirely valid
 * (every entry a suite folder in a lane: suiteFolderTarget), else nothing at all; only in a lane this runner may work
 * in (hold(k): its own, or an idle one it claims under the lanes' lock; null when another runner holds it), else that
 * folder is left, and with its run gone no run claims it, so the clean-up removes it once the lane is idle; and each
 * unless the board, read now, says it must stay. Returns { removed, deferred, refused } (refused: why the manifest
 * authorised nothing).
 */
async function releaseKept(runDir, ev, { hold, testRoot = runContext.TEST_ROOT } = {}) {
  const out = { removed: 0, deferred: 0, refused: null }
  let entries
  try {
    entries = JSON.parse(fs.readFileSync(path.join(runDir, KEPT_FILE), 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') out.refused = `${KEPT_FILE} can't be read`
    return out
  }
  if (!Array.isArray(entries)) return { ...out, refused: `${KEPT_FILE} isn't a list` }
  const live = []
  for (const entry of entries) {
    const refused = { ...out, refused: `${KEPT_FILE} names ${JSON.stringify(entry)}, not a suite folder in a lane` }
    if (!suiteFolderShape(entry, testRoot)) return refused
    if (!fs.existsSync(entry)) continue // Gone already.
    const t = suiteFolderTarget(entry, testRoot)
    if (!t) return refused
    live.push(t)
  }
  for (const lane of new Set(live.map((t) => t.lane))) {
    const release = hold ? await hold(lane) : null
    const here = live.filter((t) => t.lane === lane)
    if (!release) {
      out.deferred += here.length
      continue
    }
    try {
      for (const t of here) {
        // Checked again now the lane is held, just before it goes: still a suite folder reached through no link.
        if (!suiteFolderTarget(t.path, testRoot)) {
          out.refused = `${t.path} is no longer a suite folder reached through no link`
          return out
        }
        if (ev.protects(t.path)) continue
        try {
          removeTree(t.path)
          out.removed++
        } catch {
          // In use: no run claims it once this run is gone, so the clean-up removes it.
          out.deferred++
        }
      }
    } finally {
      release()
    }
  }
  return out
}

/** Every suite folder a run still in logsRoots (and their nested/) claims: lowercase paths. */
function claimedByRuns(logsRoots) {
  const out = new Set()
  for (const root of logsRoots)
    for (const name of safeList(root)) {
      const d = path.join(root, name)
      if (name === 'nested') for (const n of safeList(d)) for (const k of keptBy(path.join(d, n))) out.add(path.resolve(k).toLowerCase())
      for (const k of keptBy(d)) out.add(path.resolve(k).toLowerCase())
    }
  return out
}

module.exports = { AREAS, MAX_COPIES, KEPT_FILE, SUITE_FOLDER, suiteFolderTarget, linkOnTheWay, linkOnPath, isArea, pathText, mentions, citedBy, findBoard, readCards, evidence, evidenceFor, safeList, sizeOf, removeTree, freshFolder, clearDir, finishSuiteDir, recordKept, keptBy, releaseKept, claimedByRuns }
