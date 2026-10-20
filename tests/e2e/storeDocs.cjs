// The workspace's small stores as its database keeps them (#1018: lanes, watches, deliveries in .hive/hive.db), read by
// the suites that checked their files before: a read-only connection, opened and closed for each read.
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const codec = require('./storeCodec.cjs')

/** Whether the file has a table (sessions' and deliveries' are 1.0's, #1211: a 0.9 file keeps them in store_rows). */
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)

/** A store's entries, in order (what its file's array held); [] while the workspace has no database yet. */
function storeDocs(ws, store, scope = '') {
  const file = path.join(ws, '.hive', 'hive.db')
  if (!fs.existsSync(file)) return []
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 })
  try {
    // Deliveries in their own table since 1.0 (#1211), in the order of their seq.
    if (store === 'deliveries' && hasTable(db, 'deliveries')) return db.prepare('SELECT * FROM deliveries WHERE host = ? ORDER BY seq, id').all(scope).map(codec.deliveryFromRow)
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'store_rows'").get()) return []
    return db.prepare('SELECT doc FROM store_rows WHERE store = ? AND scope = ? ORDER BY ord').all(store, scope).map((r) => JSON.parse(r.doc))
  } finally {
    db.close()
  }
}

/** Where a session host's deliveries are kept: its workspace's database, under its project's id (the Assistant's under `assistant`). */
function deliveriesPlace(host) {
  const h = path.resolve(host)
  const parent = path.dirname(h)
  if (path.basename(h).toLowerCase() === 'assistant' && path.basename(parent).toLowerCase() === '.hive') return { ws: path.dirname(parent), scope: 'assistant' }
  let id = null
  try {
    id = JSON.parse(fs.readFileSync(path.join(h, '.hive', 'project.json'), 'utf8')).id
  } catch {
    // No project.json: kept under the folder's name.
  }
  return { ws: parent, scope: typeof id === 'string' && id ? id : `folder:${path.basename(h).toLowerCase()}` }
}

/** A session host's deliveries, in order. */
function deliveriesOf(host) {
  const p = deliveriesPlace(host)
  return storeDocs(p.ws, 'deliveries', p.scope)
}

/** A value kept beside a store's entries (deliveries' `next`), parsed; undefined when there is none. */
function storeMeta(ws, store, key, scope = '') {
  const db = new DatabaseSync(path.join(ws, '.hive', 'hive.db'), { readOnly: true, timeout: 5000 })
  try {
    const r = db.prepare('SELECT value FROM store_meta WHERE store = ? AND scope = ? AND key = ?').get(store, scope, key)
    return r ? JSON.parse(r.value) : undefined
  } finally {
    db.close()
  }
}

/**
 * Saves one entry of a store as Hive would (a suite's stand-in for editing its file by hand): in its place if it is
 * there, else last; `meta` values set beside it (JSON-encoded here). In one transaction.
 */
function putStoreDoc(ws, store, key, doc, { scope = '', meta = {} } = {}) {
  const db = new DatabaseSync(path.join(ws, '.hive', 'hive.db'), { timeout: 5000 })
  try {
    db.exec('BEGIN IMMEDIATE')
    if (store === 'deliveries' && hasTable(db, 'deliveries')) {
      // Its table (#1211): the delivery's row, by its id.
      const row = codec.deliveryToRow(scope, doc)
      if (!row) throw new Error(`not a delivery Hive keeps: ${JSON.stringify(doc)}`)
      db.prepare('DELETE FROM deliveries WHERE host = ? AND id = ?').run(scope, doc.id)
      codec.insert(db, 'deliveries', row)
      for (const [k, v] of Object.entries(meta)) db.prepare('INSERT INTO store_meta (store, scope, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET value = excluded.value').run(store, scope, k, JSON.stringify(v))
      db.exec('COMMIT')
      return
    }
    const had = db.prepare('SELECT ord FROM store_rows WHERE store = ? AND scope = ? AND key = ?').get(store, scope, key)
    const ord = had ? had.ord : (db.prepare('SELECT coalesce(max(ord), -1) + 1 AS o FROM store_rows WHERE store = ? AND scope = ?').get(store, scope).o)
    db.prepare('INSERT INTO store_rows (store, scope, key, ord, doc) VALUES (?, ?, ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET ord = excluded.ord, doc = excluded.doc').run(store, scope, key, ord, JSON.stringify(doc))
    for (const [k, v] of Object.entries(meta)) db.prepare('INSERT INTO store_meta (store, scope, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET value = excluded.value').run(store, scope, k, JSON.stringify(v))
    db.exec('COMMIT')
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw e
  } finally {
    db.close()
  }
}

/**
 * A session host's records as Hive keeps them (#1061: rows of the `sessions` store, under its project's id), in the form
 * its sessions.json had: `{ version, sessions, deleted?, deletedUsage? }`. Empty while there are none (or no database).
 */
function sessionsOf(host) {
  const p = deliveriesPlace(host)
  const out = { version: 1, sessions: [] }
  const file = path.join(p.ws, '.hive', 'hive.db')
  if (!fs.existsSync(file)) return out
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 })
  try {
    if (hasTable(db, 'sessions')) {
      // Their own tables since 1.0 (#1211).
      const cards = new Map()
      for (const c of db.prepare('SELECT * FROM session_cards WHERE host = ? ORDER BY session, ord').all(p.scope)) cards.set(c.session, [...(cards.get(c.session) ?? []), c])
      out.sessions = db.prepare('SELECT * FROM sessions WHERE host = ? ORDER BY ord, id').all(p.scope).map((r) => codec.sessionFromRows(r, cards.get(r.id) ?? []))
      const deleted = db.prepare('SELECT id FROM sessions_deleted WHERE host = ? ORDER BY ord, id').all(p.scope).map((r) => r.id)
      const usage = db.prepare('SELECT * FROM sessions_deleted_usage WHERE host = ? ORDER BY ord, id').all(p.scope).map(codec.keptUsageFromRow)
      if (deleted.length) out.deleted = deleted
      if (usage.length) out.deletedUsage = usage
      return out
    }
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'store_rows'").get()) return out
    const deleted = []
    const usage = []
    for (const r of db.prepare("SELECT key, doc FROM store_rows WHERE store = 'sessions' AND scope = ? ORDER BY ord, key").all(p.scope)) {
      const doc = JSON.parse(r.doc)
      if (r.key.startsWith('s:')) out.sessions.push(doc)
      else if (r.key.startsWith('d:')) deleted.push(doc)
      else if (r.key.startsWith('u:')) usage.push(doc)
    }
    if (deleted.length) out.deleted = deleted
    if (usage.length) out.deletedUsage = usage
    return out
  } finally {
    db.close()
  }
}

/**
 * Replaces a session host's records as Hive would (a suite's stand-in for writing its sessions.json by hand, which Hive
 * only moves in before it first reads them): `f` in sessions.json's form. In one transaction, marked moved in.
 */
function putSessions(host, f) {
  const p = deliveriesPlace(host)
  const db = new DatabaseSync(path.join(p.ws, '.hive', 'hive.db'), { timeout: 5000 })
  try {
    db.exec('BEGIN IMMEDIATE')
    if (hasTable(db, 'sessions')) {
      // Their own tables since 1.0 (#1211).
      for (const t of ['sessions', 'sessions_deleted', 'sessions_deleted_usage']) db.prepare(`DELETE FROM ${t} WHERE host = ?`).run(p.scope)
      ;(f.sessions ?? []).forEach((rec, i) => {
        const r = codec.sessionToRows(p.scope, i, rec)
        if (!r) throw new Error(`not a session record Hive keeps: ${JSON.stringify(rec)}`)
        codec.insert(db, 'sessions', r.row)
        for (const c of r.cards) codec.insert(db, 'session_cards', c)
      })
      ;(f.deleted ?? []).forEach((id, i) => codec.insert(db, 'sessions_deleted', { host: p.scope, id, ord: i }))
      ;(f.deletedUsage ?? []).forEach((k, i) => codec.insert(db, 'sessions_deleted_usage', codec.keptUsageToRow(p.scope, i, k)))
      db.prepare("INSERT INTO store_meta (store, scope, key, value) VALUES ('sessions', ?, 'imported', ?) ON CONFLICT(store, scope, key) DO NOTHING").run(p.scope, JSON.stringify({ at: new Date().toISOString(), rows: 0, file: null }))
      db.exec('COMMIT')
      return
    }
    db.prepare("DELETE FROM store_rows WHERE store = 'sessions' AND scope = ?").run(p.scope)
    const put = db.prepare("INSERT INTO store_rows (store, scope, key, ord, doc) VALUES ('sessions', ?, ?, ?, ?)")
    const group = (prefix, list, idOf) => list.forEach((e, i) => put.run(p.scope, prefix + (idOf(e) || `#${i}`), i, JSON.stringify(e)))
    group('s:', f.sessions ?? [], (e) => e.id)
    group('d:', f.deleted ?? [], (e) => e)
    group('u:', f.deletedUsage ?? [], (e) => e.id)
    db.prepare("INSERT INTO store_meta (store, scope, key, value) VALUES ('sessions', ?, 'imported', ?) ON CONFLICT(store, scope, key) DO NOTHING").run(p.scope, JSON.stringify({ at: new Date().toISOString(), rows: 0, file: null }))
    db.exec('COMMIT')
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw e
  } finally {
    db.close()
  }
}

module.exports = { storeDocs, storeMeta, putStoreDoc, deliveriesPlace, deliveriesOf, sessionsOf, putSessions }
