import { randomBytes } from 'crypto'
import { join } from 'path'
import { readFile } from 'original-fs/promises'
import { app, safeStorage } from 'electron'
import { msg } from '../shared/i18n'
import { emit } from './events'
import { writeJsonAtomic } from './fsutil'
import { combworkError } from './combworkError'
import { addKeyFingerprint, resetCoverage } from './keyCoverage'
import { createLogger } from './logger'

/**
 * Server connections' keys (HI-1772), the only place Hive keeps one: `connection-keys.json` in Hive's profile, each key
 * encrypted with Electron's safeStorage (DPAPI on Windows, bound to the user), beside what isn't secret (its version,
 * the origin it was saved for, its last 4 characters). This file is the only record of a key: config.json names none,
 * so restoring config from its backup can't bring one back. Each change is one atomic write, with no .bak (a backup would
 * keep a removed key), under one lock for the whole file (`serial`), so two connections saving at once can't lose each
 * other's. Lock order: a connection's own lock (accounts.ts), then this one; config is written after, outside it.
 *
 * A key is decrypted only for a launch's environment, a Set Up terminal's, a model listing's request (withKey), or Reset
 * Masking Data (the user confirmed it), and never sent to a window: the view gets `keyInfo`. Its fingerprint is kept
 * before it (keyCoverage.ts), so its text is masked for good without it.
 */

const log = createLogger('keys')

export interface KeyInfo {
  /** Its save's own id, random, never reused (HI-1772 round 1: a counter restarted after a removal, so a key saved again looked unchanged). */
  v: string
  origin: string
  last4: string
  at: string
}
interface Entry extends KeyInfo {
  blob: string
}
type Store = Record<string, Entry>

const file = (): string => join(app.getPath('userData'), 'connection-keys.json')

/** For tests: run before each write of the store (a fault, or holding it to race another). */
export const keyStoreTestHooks: { beforeWrite?: () => Promise<void> } = {}

let queue: Promise<unknown> = Promise.resolve()
/** Runs fn alone over the store: every read-modify-write and clean-up waits its turn, in order. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

/** What isn't secret about each key, as last read or written: what the view shows (no key, no ciphertext). */
const known = new Map<string, KeyInfo>()
let loaded: Promise<void> | null = null

async function read(): Promise<Store> {
  let text: string
  try {
    text = await readFile(file(), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`the key store couldn't be read: ${(e as Error).message}`)
    return {}
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object') // i18n-ignore: combwork.log, in English
    const out: Store = {}
    for (const [id, e] of Object.entries(parsed as Record<string, Partial<Entry>>)) {
      if (e && typeof e.blob === 'string' && typeof e.origin === 'string' && typeof e.v === 'string' && typeof e.last4 === 'string') out[id] = { v: e.v, origin: e.origin, last4: e.last4, at: String(e.at ?? ''), blob: e.blob }
    }
    return out
  } catch (e) {
    // Damaged: as if empty (every key must be entered again); it is overwritten at the next save.
    log.warn(`the key store is damaged and was read as empty: ${(e as Error).message}`)
    return {}
  }
}

async function write(store: Store): Promise<void> {
  await keyStoreTestHooks.beforeWrite?.()
  await writeJsonAtomic(file(), store)
}

function remember(store: Store): void {
  known.clear()
  for (const [id, e] of Object.entries(store)) known.set(id, { v: e.v, origin: e.origin, last4: e.last4, at: e.at })
}

/** Reads what isn't secret about the keys once (never decrypting): the view then shows which connections have one. */
export function loadKeys(): Promise<void> {
  loaded ??= serial(async () => {
    remember(await read())
  }).then(() => emit({ type: 'connections-changed' }))
  return loaded
}

/** What the view shows of a connection's key: its last 4 characters and when it was saved; undefined: none (or not read yet). */
export function keyInfo(id: string): KeyInfo | undefined {
  return known.get(id)
}

const UNSAFE = msg({ id: 'main.keys.unsafe', defaultMessage: "Combwork can't store a key safely on this system, so it wasn't saved.", description: "An error saving a server connection's API key (Settings → Accounts & Connections): Windows' protection for stored secrets isn't available, and Combwork won't keep a key in plain text." })

/** Whether a key can be stored encrypted: never in plain text (safeStorage's `basic_text` backend, off Windows). */
function assertSafe(): void {
  if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw combworkError(UNSAFE, undefined, { kind: 'conflict' })
}

/** Saves a connection's key for an origin (Save, Replace): one write, its version moved on. Returns what the view shows. */
export function saveKey(id: string, origin: string, key: string): Promise<KeyInfo> {
  assertSafe()
  return serial(async () => {
    // Its fingerprint first (HI-1772): masked for good, whatever happens to the key after; refused if it can't be kept.
    await addKeyFingerprint(id, key)
    const store = await read()
    const blob = safeStorage.encryptString(key).toString('base64')
    const entry: Entry = { v: randomBytes(12).toString('hex'), origin, last4: key.slice(-4), at: new Date().toISOString(), blob }
    const next = { ...store, [id]: entry }
    await write(next)
    remember(next)
    log.info(`connection ${id}: key saved`)
    return { v: entry.v, origin, last4: entry.last4, at: entry.at }
  })
}

/** Removes a connection's key (Remove Key, a new origin, the connection removed): one write. False: it had none. */
export function removeKey(id: string): Promise<boolean> {
  return serial(async () => {
    const store = await read()
    if (!store[id]) {
      remember(store)
      return false
    }
    const next = { ...store }
    delete next[id]
    await write(next)
    remember(next)
    log.info(`connection ${id}: key removed`)
    return true
  })
}

/**
 * Keys of connections that aren't server connections any more (or are gone) removed: at start, under the lock. `keep`
 * is asked under it, so a connection added (and its key saved) while this waited is kept.
 */
export function dropKeysExcept(keep: () => ReadonlySet<string>): Promise<string[]> {
  return serial(async () => {
    const store = await read()
    const kept = keep()
    const gone = Object.keys(store).filter((id) => !kept.has(id))
    if (gone.length) {
      const next = { ...store }
      for (const id of gone) delete next[id]
      await write(next)
      remember(next)
      log.info(`keys of ${gone.length} connection(s) no longer there removed`)
    } else remember(store)
    return gone
  })
}

/**
 * Reset Masking Data (HI-1772; the user confirmed it, in Settings → Accounts & Connections): the one decryption besides a launch,
 * Set Up and a model reading. The keys saved now that can still be read are fingerprinted again (keyCoverage.ts), under
 * this lock; what was lost leaves a coverage gap for good.
 */
export function resetMasking(): Promise<number> {
  return serial(async () => {
    const store = await read()
    const keys: { conn: string; key: string }[] = []
    for (const [id, e] of Object.entries(store)) {
      try {
        keys.push({ conn: id, key: safeStorage.decryptString(Buffer.from(e.blob, 'base64')) })
      } catch {
        log.warn(`connection ${id}'s key couldn't be read for the masking reset: it isn't fingerprinted again`)
      }
    }
    await resetCoverage(keys)
    return keys.length
  })
}

/**
 * A connection's key, decrypted for one use (a launch's environment, a model listing's request), with its version:
 * only when it is still saved for `origin`. Null: none, or saved for another origin. The caller keeps it no longer
 * than that use.
 */
export function withKey(id: string, origin: string): Promise<{ key: string; v: string } | null> {
  return serial(async () => {
    const store = await read()
    remember(store)
    const e = store[id]
    if (!e || e.origin !== origin) return null
    try {
      return { key: safeStorage.decryptString(Buffer.from(e.blob, 'base64')), v: e.v }
    } catch (err) {
      log.warn(`connection ${id}'s key couldn't be decrypted: ${(err as Error).message}`)
      return null
    }
  })
}
