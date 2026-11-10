// The fake opencode's data root: one JSON file at OPENCODE_DB (the real one keeps SQLite there), so an account's sessions
// and credentials survive a restart and two roots stay apart, as HI-2758's Q4, Q6 and Q7 showed for the real one.
// { sessions: { [id]: { info, messages: [oldest first] } }, credentials: [{ integration, label, type, key }] }
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function dbPath(env = process.env) {
  if (env.OPENCODE_DB) return env.OPENCODE_DB
  const data = env.XDG_DATA_HOME || path.join(env.USERPROFILE || env.HOME || '', '.local', 'share')
  return path.join(data, 'opencode', 'opencode.db')
}
// Windows refuses a rename over a file another process has open for a moment (EPERM, EBUSY): such a step is tried again.
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES'])
const pause = new Int32Array(new SharedArrayBuffer(4))
function retrying(fn) {
  for (let i = 0; ; i++) {
    try {
      return fn()
    } catch (e) {
      if (!BUSY.has(e?.code) || i >= 50) throw e
      Atomics.wait(pause, 0, 0, 20)
    }
  }
}
function read(env) {
  let text
  try {
    text = retrying(() => fs.readFileSync(dbPath(env), 'utf8'))
  } catch (e) {
    if (e?.code === 'ENOENT') return { sessions: {}, credentials: [] }
    throw e
  }
  return JSON.parse(text)
}
function write(db, env) {
  const f = dbPath(env)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(db))
  retrying(() => fs.renameSync(tmp, f))
}
/** Changes the store under no lock: the fake's server is its only writer while it runs (a CLI command runs standalone). */
function change(fn, env) {
  const db = read(env)
  const r = fn(db)
  write(db, env)
  return r
}

// Ids as 2.2.6 makes them: a prefix, then hex time and base62 (ses_e428fc2ecffex263I9wXsnv2XZ, msg_1bd703f8d001MyMGf37DsURKbF).
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
let counter = 0
function newId(prefix) {
  const t = (Date.now() * 4096 + (counter++ % 4096)).toString(16).padStart(12, '0').slice(-12)
  const r = [...crypto.randomBytes(14)].map((b) => B62[b % 62]).join('')
  return `${prefix}_${t}${r}`
}
const projectId = (dir) => crypto.createHash('sha1').update(String(dir).toLowerCase()).digest('hex')

module.exports = { dbPath, read, write, change, newId, projectId }
