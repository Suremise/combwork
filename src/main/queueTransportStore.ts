import { randomBytes } from 'crypto'
import { join } from 'path'
import { readFile } from 'original-fs/promises'
import { app, safeStorage } from 'electron'
import { writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { ownerOf, snapshotDigest, snapshotOf, type TransportStore } from './workflow/transportSnapshots'

/**
 * Follow mode's captured transports (HI-1183, SPEC §16.9.4), the only place Combwork keeps one: `queue-transport.json` in
 * Combwork's profile, each snapshot (its exact URL, which may hold credentials, and the carried sign-in and transport
 * settings) encrypted with Electron's safeStorage (DPAPI on Windows, bound to the user). A begun publication's fact
 * names only the snapshot's id and its digest (the SHA-256 of what was captured); recovery decrypts it and checks the
 * digest, and anything missing, undecryptable or different is never rebuilt from the configuration as it is now.
 *
 * keyStore.ts's pattern: one atomic write per change, no .bak (a backup would keep a removed snapshot), every change in
 * turn (`serial`). A snapshot is decrypted only to build a sealed context's config for one fetch, publication or
 * verification, and never sent to a window, a tool reply, a log or diagnostics. Removed once its entry has an outcome;
 * the queue host drops any whose entry is no longer begun (dropExcept).
 */

const log = createLogger('queue')
const file = (): string => join(app.getPath('userData'), 'queue-transport.json')

interface Entry {
  /** Its project (lower case) and target: a clean-up is that target's queue's alone (the store is the profile's). */
  owner: string
  digest: string
  at: string
  blob: string
}
type Store = Record<string, Entry>

/** For tests (HI-2993): run before each read of the file, inside its error handling, so a test can fail one. */
export const queueTransportTestHooks: { beforeRead?: () => Promise<void> } = {}

/**
 * HI-2993: the store's file there but not readable now (a lock, a sharing violation, an I/O error), after `READ_TRIES`
 * tries: never taken as an empty store, which a save would then write back with only its own snapshot, dropping every
 * other target's.
 */
export class TransportStoreUnreadable extends Error {
  constructor(why: string) {
    super(`the transport store couldn't be read: ${why}`) // i18n-ignore: for the log and the queue's retry, as git's words are
    this.name = 'TransportStoreUnreadable'
  }
}

/** Reads of the file tried before it counts as unreadable, `READ_RETRY_MS` apart. */
const READ_TRIES = 3
const READ_RETRY_MS = 100

let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

/**
 * The store as its file holds it: none yet is empty; one there that can't be read (after `READ_TRIES` tries) throws
 * `TransportStoreUnreadable` (HI-2993), never empty.
 */
async function read(): Promise<Store> {
  let text: string
  for (let tries = 1; ; tries++) {
    try {
      await queueTransportTestHooks.beforeRead?.()
      text = await readFile(file(), 'utf8')
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
      if (tries >= READ_TRIES) {
        log.warn(`the transport store couldn't be read: ${userText((e as Error).message)}`)
        throw new TransportStoreUnreadable((e as Error).message)
      }
      await new Promise((r) => setTimeout(r, READ_RETRY_MS))
    }
  }
  try {
    const parsed = JSON.parse(text) as Record<string, Partial<Entry>>
    const out: Store = {}
    for (const [id, e] of Object.entries(parsed ?? {})) if (e && typeof e.blob === 'string' && typeof e.digest === 'string') out[id] = { owner: String(e.owner ?? ''), digest: e.digest, at: String(e.at ?? ''), blob: e.blob }
    return out
  } catch (e) {
    // Damaged: as if empty; a begun publication then pauses as unknown (its snapshot gone), never guessed.
    log.warn(`the transport store is damaged and was read as empty: ${(e as Error).message}`)
    return {}
  }
}

/** The store, or `fallback` when its file can't be read (HI-2993): for the changes that write nothing then. */
async function readOr<T>(fallback: T): Promise<Store | T> {
  try {
    return await read()
  } catch (e) {
    if (e instanceof TransportStoreUnreadable) return fallback
    throw e
  }
}

/** Never in plain text: safeStorage's `basic_text` backend (off Windows) or no encryption is no store. */
const safe = (): boolean => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'

export const queueTransportStore: TransportStore = {
  // Unreadable (HI-2993): refused (it throws), nothing written: the queue tries again later, never with a partial store.
  save(project, target, snap) {
    if (!safe()) return Promise.resolve(null)
    return serial(async () => {
      const store = await read()
      const id = randomBytes(12).toString('hex')
      const digest = snapshotDigest(snap)
      store[id] = { owner: ownerOf(project, target), digest, at: new Date().toISOString(), blob: safeStorage.encryptString(JSON.stringify(snap)).toString('base64') }
      await writeJsonAtomic(file(), store)
      return { id, digest }
    })
  },
  load(id, digest) {
    return serial(async () => {
      // Unreadable: none, as one missing (a begun publication then asks, and Resume reads again), nothing written.
      const e = (await readOr(null))?.[id]
      if (!e || e.digest !== digest) return null
      try {
        const snap = snapshotOf(safeStorage.decryptString(Buffer.from(e.blob, 'base64')))
        return snap && snapshotDigest(snap) === digest ? snap : null
      } catch {
        log.warn(`a transport snapshot couldn't be decrypted (${id})`)
        return null
      }
    })
  },
  drop(id) {
    return serial(async () => {
      // Unreadable: nothing written (it stays until a later clean-up of its target's reads the store).
      const store = await readOr(null)
      if (!store?.[id]) return
      delete store[id]
      await writeJsonAtomic(file(), store)
    })
  },
  dropExcept(project, target, keep) {
    return serial(async () => {
      const store = await readOr(null)
      if (!store) return
      const gone = Object.keys(store).filter((id) => store[id].owner === ownerOf(project, target) && !keep.has(id))
      if (!gone.length) return
      for (const id of gone) delete store[id]
      await writeJsonAtomic(file(), store)
    })
  }
}
