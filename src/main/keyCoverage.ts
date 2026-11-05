import { randomBytes, randomInt } from 'crypto'
import { join } from 'path'
import { existsSync, readFileSync } from 'original-fs'
import { readFile } from 'original-fs/promises'
import { app, safeStorage } from 'electron'
import { msg } from '../shared/i18n'
import { config } from './config'
import { writeJsonAtomic } from './fsutil'
import { hiveError } from './hiveError'
import { addWindows, fingerprint, maskingState, MOD, setMasking, type MatchSecret, type Window } from './keyMatcher'
import { createLogger } from './logger'

/**
 * Server connections' key coverage (HI-1772, design s68/s70/s72): the fingerprint of every key ever saved, kept so its
 * text is masked in logs, captures and exports long after the key was replaced or removed, without keeping (or
 * decrypting) a key for it.
 *
 * - `key-fingerprints.json`: one safeStorage-encrypted blob (the matcher's salt and prefilter base, and each key's
 *   windows: keyMatcher.ts). Matching data, not credentials. Written first when a key is saved, so a key never exists
 *   without its fingerprint; never pruned: a further Save is refused past MAX_WINDOWS.
 * - Durable evidence, never cleared, in `key-coverage.json` and mirrored in config.json (`keyMasking`): `ever` (a key
 *   was saved: fingerprints must be there) and `gap` (a reset lost some: masking strict for good). Reconciled as their
 *   union; a backup restored never lowers them.
 * - States: `none` (no evidence, no key, no fingerprints: a profile that never saved a key, keyless servers included:
 *   nothing is masked, nothing needs safeStorage); `ready`; `unavailable` (evidence or keys but no readable
 *   fingerprints): strict masking, and exports, Copy Diagnostics and recordings refused until Reset Masking Data.
 */

const log = createLogger('keys')

/** The most windows kept, all keys together (a 50-character key has about 200): Save is refused past it. */
export const MAX_WINDOWS = 100_000
let maxWindows = MAX_WINDOWS

interface Marks {
  ever?: true
  gap?: true
  gapSince?: string
}
interface Stored {
  salt: string
  base: number
  keys: { at: string; conn: string; windows: Window[] }[]
}

const dir = (): string => app.getPath('userData')
const marksFile = (): string => join(dir(), 'key-coverage.json')
const fingerprintsFile = (): string => join(dir(), 'key-fingerprints.json')
const keysFile = (): string => join(dir(), 'connection-keys.json')

let stored: Stored | null = null
let total = 0
let loading: Promise<void> | null = null

const UNREADABLE = msg({ id: 'main.keys.maskingUnreadable', defaultMessage: "Combwork can't check this for API keys: its masking data can't be read. See Settings → Accounts & Connections.", description: "An error: an export, Copy Diagnostics or a recording was refused because the data Combwork uses to hide server connections' API keys can't be read. Settings → Accounts & Connections names a section, where it can be reset." })
const FULL = msg({ id: 'main.keys.maskingFull', defaultMessage: "Combwork can't keep masking for another key: it already keeps the most it can. The key wasn't saved.", description: "An error saving a server connection's API key: Combwork keeps a fingerprint of every key ever saved (to hide it in logs and exports) and has reached its limit." })

function readMarksFile(): Marks {
  try {
    const m = JSON.parse(readFileSync(marksFile(), 'utf8')) as Marks
    return { ...(m.ever ? { ever: true } : {}), ...(m.gap ? { gap: true } : {}), ...(typeof m.gapSince === 'string' ? { gapSince: m.gapSince } : {}) }
  } catch {
    // Missing or damaged: what config mirrors stands in (and a damaged file with nothing else is no evidence).
    return {}
  }
}

/** The evidence, both copies together (their union: neither lowers the other). */
function marks(): Marks {
  const f = readMarksFile()
  const c = config.get().keyMasking ?? {}
  return { ...((f.ever || c.ever) ? { ever: true } : {}), ...((f.gap || c.gap) ? { gap: true } : {}), ...(f.gapSince ? { gapSince: f.gapSince } : {}) }
}

/** Writes the evidence to both copies, never lowering either. */
async function writeMarks(add: Marks): Promise<Marks> {
  const now = marks()
  const next: Marks = { ...now, ...(add.ever ? { ever: true } : {}), ...(add.gap ? { gap: true } : {}), ...(add.gapSince && !now.gapSince ? { gapSince: add.gapSince } : {}) }
  await writeJsonAtomic(marksFile(), next)
  config.update((c) => (c.keyMasking = { ...(next.ever ? { ever: true as const } : {}), ...(next.gap ? { gap: true as const } : {}) }))
  return next
}

/** Whether the key store has an entry (or can't be read: then it may). */
function keysSaved(): boolean {
  if (!existsSync(keysFile())) return false
  try {
    return Object.keys(JSON.parse(readFileSync(keysFile(), 'utf8')) as object).length > 0
  } catch {
    return true
  }
}

/** No evidence a key was ever saved: nothing to mask, nothing to load. */
const neverKeyed = (m: Marks): boolean => !m.ever && !m.gap && !existsSync(fingerprintsFile()) && !keysSaved()

/**
 * As the main process starts, before ready (HI-1855): hive.log's first lines (the install folder's check) were masked
 * strictly in every profile. A profile with no evidence of a key ever saved (config.json read as is: unreadable, it
 * stays strict) masks nothing from here; any other stays strict until startCoverage and loadCoverage, after ready.
 */
export function startCoverageEarly(): void {
  const c = config.savedKeyMasking()
  if (c === null) return
  const f = readMarksFile()
  if (neverKeyed({ ...((f.ever || c.ever) ? { ever: true } : {}), ...((f.gap || c.gap) ? { gap: true } : {}) })) setMasking({ state: 'none', gap: false })
}

/**
 * At start, before anything is logged with a key in it: a profile that never saved a key masks nothing at once;
 * any other is strict until loadCoverage has read its fingerprints (a few small files, read once here).
 */
export function startCoverage(): void {
  const m = marks()
  setMasking(neverKeyed(m) ? { state: 'none', gap: false } : { state: 'pending', gap: !!m.gap })
}

/** Reads the fingerprints (once safeStorage can decrypt: after the app is ready). Unreadable: unavailable, strict. */
export function loadCoverage(): Promise<void> {
  loading ??= (async () => {
    const m = marks()
    // Both copies agree from here (a restored backup can't lower either).
    if (m.ever || m.gap) await writeMarks(m).catch((e) => log.warn(`key masking: its markers couldn't be written: ${(e as Error).message}`))
    if (neverKeyed(m)) return setMasking({ state: 'none', gap: false })
    try {
      if (!existsSync(fingerprintsFile())) throw new Error('missing') // i18n-ignore: hive.log, in English
      if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable') // i18n-ignore: hive.log, in English
      const file = JSON.parse(await readFile(fingerprintsFile(), 'utf8')) as { blob?: unknown }
      if (typeof file.blob !== 'string') throw new Error('no blob') // i18n-ignore: hive.log, in English
      const s = JSON.parse(safeStorage.decryptString(Buffer.from(file.blob, 'base64'))) as Stored
      const n = validWindows(s)
      stored = s
      total = n
      setMasking({ state: 'ready', gap: !!m.gap, secret: secretOf(s), windows: s.keys.flatMap((k) => k.windows) })
    } catch (e) {
      // A fixed line: nothing of the file or the error's text.
      log.warn(`key masking data unreadable (${(e as Error).message === 'missing' ? 'missing' : 'damaged or not decryptable'}): masking strictly`)
      setMasking({ state: 'unavailable', gap: !!m.gap })
    }
  })()
  return loading
}

/** The stored fingerprints' window count, checked whole (bounds included); throws when they aren't usable. */
function validWindows(s: Stored): number {
  if (!s || typeof s.salt !== 'string' || !Number.isInteger(s.base) || s.base < 2 || s.base >= MOD || !Array.isArray(s.keys)) throw new Error('shape') // i18n-ignore: hive.log, in English
  let n = 0
  for (const k of s.keys) {
    if (!Array.isArray(k.windows)) throw new Error('shape') // i18n-ignore: hive.log, in English
    for (const w of k.windows) if (!Array.isArray(w) || typeof w[0] !== 'number' || typeof w[1] !== 'string') throw new Error('shape') // i18n-ignore: hive.log, in English
    n += k.windows.length
  }
  if (n > maxWindows) throw new Error('over its bound') // i18n-ignore: hive.log, in English
  return n
}

const secretOf = (s: Stored): MatchSecret => ({ salt: Buffer.from(s.salt, 'base64'), base: s.base })
const newStored = (): Stored => ({ salt: randomBytes(32).toString('base64'), base: randomInt(1 << 12, MOD - 1), keys: [] })

async function writeStored(s: Stored): Promise<void> {
  await writeJsonAtomic(fingerprintsFile(), { v: 1, blob: safeStorage.encryptString(JSON.stringify(s)).toString('base64') })
}

/**
 * A key about to be saved (the key store's lock held): its fingerprint kept first (the `ever` marker before it), so it
 * is masked for good, whatever happens to the key after. Refused while the fingerprints can't be read, or past
 * MAX_WINDOWS (nothing is ever dropped to make room).
 */
export async function addKeyFingerprint(conn: string, key: string): Promise<void> {
  await loadCoverage()
  if (maskingState().state === 'unavailable') throw hiveError(UNREADABLE, undefined, { kind: 'conflict' })
  const base = stored ?? newStored()
  const windows = fingerprint(secretOf(base), key)
  if (total + windows.length > maxWindows) throw hiveError(FULL, undefined, { kind: 'conflict' })
  await writeMarks({ ever: true })
  const next: Stored = { ...base, keys: [...base.keys, { at: new Date().toISOString(), conn, windows }] }
  await writeStored(next)
  const fresh = !stored
  stored = next
  total += windows.length
  if (fresh) setMasking({ state: 'ready', secret: secretOf(next), windows })
  else addWindows(windows)
}

/**
 * Reset Masking Data (the user confirmed it): fingerprints made again, under a new secret, from the keys that can still
 * be read (`keys`, decrypted by the key store for this alone), and a coverage gap recorded for good: what was masked by
 * fingerprints now lost can't be told apart any more, so every later output is masked strictly.
 */
export async function resetCoverage(keys: { conn: string; key: string }[]): Promise<void> {
  const s = newStored()
  const secret = secretOf(s)
  for (const k of keys) s.keys.push({ at: new Date().toISOString(), conn: k.conn, windows: fingerprint(secret, k.key) })
  const n = s.keys.reduce((a, k) => a + k.windows.length, 0)
  if (n > maxWindows) throw hiveError(FULL, undefined, { kind: 'conflict' })
  await writeMarks({ ever: true, gap: true, gapSince: new Date().toISOString() })
  await writeStored(s)
  stored = s
  total = n
  loading = Promise.resolve()
  setMasking({ state: 'ready', gap: true, secret, windows: s.keys.flatMap((k) => k.windows) })
  log.info(`key masking reset: ${keys.length} key(s) fingerprinted again; masking strict for good`)
}

/** Before an export, Copy Diagnostics or a recording is written: refused while the fingerprints can't be read. */
export async function requireMasking(): Promise<void> {
  await loadCoverage()
  if (maskingState().state === 'unavailable') throw hiveError(UNREADABLE, undefined, { kind: 'conflict' })
}

/** How many windows are kept, all keys together. */
export const coverageWindows = (): number => total

/** What Settings → Accounts & Connections shows of it. */
export function coverageView(): { state: ReturnType<typeof maskingState>['state']; gap: boolean; gapSince?: string; full: boolean } {
  const s = maskingState()
  const since = s.gap ? readMarksFile().gapSince : undefined
  return { state: s.state, gap: s.gap, ...(since ? { gapSince: since } : {}), full: total >= maxWindows * 0.95 }
}

/** For tests: a smaller bound (the same rules), so going past it takes a few keys. */
export function setMaxWindowsForTests(n: number): void {
  maxWindows = n
}

/** For tests: as after a restart, nothing loaded. */
export function forgetCoverageForTests(): void {
  stored = null
  total = 0
  loading = null
}
