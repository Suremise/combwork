// Records each version of Hive's bundled skills, modes and dialect files (resources/skills, resources/modes,
// resources/dialects/<folder>/*.json, HI-2439) in src/main/bundledHistory.json, oldest first, so a workspace's untouched copy of an older version can be told from one
// the user changed (src/main/bundled.ts). Run it after changing a bundled skill, mode or dialect file: `npm run bundled-history`
// (tests/bundled.test.ts fails until the current versions are recorded). Entries are only ever appended.
// `--from-git` also walks the git history for versions not yet recorded (how the file was first made).
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'src', 'main', 'bundledHistory.json')
const SKIP = new Set(['.hive-copy', '.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** The same hash as contentHash() in src/main/fsutil.ts, over [relative path, bytes] pairs. */
function hash(files) {
  const h = createHash('sha256')
  for (const [rel, data] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    h.update(rel)
    h.update('\0')
    h.update(data.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
    h.update('\0')
  }
  return h.digest('hex').slice(0, 16)
}

function filesOnDisk(path) {
  if (statSync(path).isFile()) return [['', readFileSync(path)]]
  const files = []
  const walk = (rel) => {
    for (const e of readdirSync(rel ? join(path, rel) : path, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      // contentHash() counts a link as one (never following it); Hive ships none, so none may be recorded either.
      if (e.isSymbolicLink()) throw new Error(`${path}/${r} is a link: bundled skills and modes are plain files`)
      if (e.isDirectory()) walk(r)
      else if (e.isFile() && !SKIP.has(e.name)) files.push([r, readFileSync(join(path, r))])
    }
  }
  walk('')
  return files
}

const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })

/** An item's versions in git, oldest first: [commit, hash] for each commit that changed it. */
function gitVersions(rel, isFile) {
  const commits = git('rev-list', '--reverse', 'HEAD', '--', rel).toString().split('\n').filter(Boolean)
  const versions = []
  for (const c of commits) {
    const listed = git('ls-tree', '-r', '--name-only', c, '--', rel).toString().split('\n').filter(Boolean)
    if (!listed.length) continue
    const files = listed.filter((f) => !SKIP.has(f.split('/').pop())).map((f) => [isFile ? '' : f.slice(rel.length + 1), git('show', `${c}:${f}`)])
    versions.push(hash(files))
  }
  return versions
}

const fromGit = process.argv.includes('--from-git')
const history = { skills: {}, modes: {}, dialects: {}, ...(existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {}) }
let added = 0
const record = (kind, id, h) => {
  const list = (history[kind][id] ??= [])
  if (list[list.length - 1] !== h) {
    list.push(h)
    added++
  }
}
for (const [kind, dir, isFile] of [['skills', 'resources/skills', false], ['modes', 'resources/modes', true]]) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (isFile ? !e.isFile() || !e.name.endsWith('.md') : !e.isDirectory() || !existsSync(join(root, dir, e.name, 'SKILL.md'))) continue
    const id = isFile ? e.name.slice(0, -3) : e.name
    const rel = `${dir}/${e.name}`
    if (fromGit) for (const h of gitVersions(rel, isFile)) if (!(history[kind][id] ?? []).includes(h)) record(kind, id, h)
    record(kind, id, hash(filesOnDisk(join(root, rel))))
  }
}
// Dialect files: one per file in each folder (a provider's id, or api), their id `<folder>/<label>`.
const DIALECTS = 'resources/dialects'
if (existsSync(join(root, DIALECTS))) {
  for (const f of readdirSync(join(root, DIALECTS), { withFileTypes: true })) {
    if (!f.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(f.name)) continue
    for (const e of readdirSync(join(root, DIALECTS, f.name), { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.json') || e.name.startsWith('.')) continue
      const id = `${f.name}/${e.name.slice(0, -5)}`
      const rel = `${DIALECTS}/${f.name}/${e.name}`
      if (fromGit) for (const h of gitVersions(rel, true)) if (!(history.dialects[id] ?? []).includes(h)) record('dialects', id, h)
      record('dialects', id, hash(filesOnDisk(join(root, rel))))
    }
  }
}
const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))
writeFileSync(out, JSON.stringify({ skills: sorted(history.skills), modes: sorted(history.modes), dialects: sorted(history.dialects) }, null, 2) + '\n')
console.log(added ? `Recorded ${added} new version(s) in src/main/bundledHistory.json` : 'Every bundled version is already recorded.')
