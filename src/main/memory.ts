import { mkdirSync, readdirSync, statSync, unlinkSync } from 'original-fs'
import { join } from 'path'
import { getHeapStatistics, setHeapSnapshotNearHeapLimit } from 'v8'
import { createLogger } from './logger'

/**
 * The main process's memory (#1005, after #988's out-of-memory crash): a line in hive.log at start, every 5 minutes and
 * as the process exits, a warning when the used heap passes 70% and 85% of its limit, and, when Settings → Advanced
 * says so, a heap snapshot written as the heap nears its limit, so the next such crash shows what filled it.
 */
const log = createLogger('memory')

const MB = 1024 * 1024
/** How often the memory line is logged. */
export const MEMORY_EVERY_MS = 5 * 60_000
/** The shares of the heap limit whose crossing is warned of, once each time the used heap rises past one. */
export const HEAP_WARN_AT = [0.7, 0.85]
/** The memory lines Copy Diagnostics shows. */
const RECENT = 6
/** The snapshots kept: the oldest go as the setting arms the next, so one more still keeps the folder to this many. */
export const SNAPSHOTS_KEPT = 2

export interface MemoryNow {
  used: number
  total: number
  limit: number
  external: number
  arrayBuffers: number
  rss: number
}

export function memoryNow(): MemoryNow {
  const h = getHeapStatistics()
  const m = process.memoryUsage()
  return { used: h.used_heap_size, total: h.total_heap_size, limit: h.heap_size_limit, external: m.external, arrayBuffers: m.arrayBuffers, rss: m.rss }
}

const mb = (n: number): number => Math.round(n / MB)

/** The memory line: "heap 512 of 600 MB used (limit 4096 MB, 13%); external 20 MB, array buffers 5 MB, rss 900 MB". */
export function memoryLine(m: MemoryNow = memoryNow()): string {
  return `heap ${mb(m.used)} of ${mb(m.total)} MB used (limit ${mb(m.limit)} MB, ${Math.round((m.used / m.limit) * 100)}%); external ${mb(m.external)} MB, array buffers ${mb(m.arrayBuffers)} MB, rss ${mb(m.rss)} MB` // i18n-ignore: hive.log's memory line, for the maintainer, in English
}

/** How many of HEAP_WARN_AT the used heap is past. */
export const heapLevel = (m: MemoryNow): number => HEAP_WARN_AT.filter((at) => m.used >= at * m.limit).length

const recent: string[] = []
let level = 0

/** Logs the memory line (a warning instead when the heap has passed a level since the last), and keeps it for Copy Diagnostics. */
export function logMemory(why: string, m: MemoryNow = memoryNow()): void {
  const now = heapLevel(m)
  const rose = now > level
  level = now
  const line = rose ? `Memory, ${why}: past ${HEAP_WARN_AT[now - 1] * 100}% of the heap limit: ${memoryLine(m)}` : `Memory, ${why}: ${memoryLine(m)}` // i18n-ignore: hive.log's memory line, for the maintainer, in English
  if (rose) log.warn(line)
  else log.info(line)
  recent.push(`${new Date().toISOString()} ${rose ? 'WARN ' : ''}${line}`)
  if (recent.length > RECENT) recent.shift()
}

/** Logs the memory line now (Hive is starting) and every 5 minutes. */
export function startMemoryLog(): void {
  logMemory('at start') // i18n-ignore: hive.log's memory line, for the maintainer, in English
  setInterval(() => logMemory('every 5 min'), MEMORY_EVERY_MS).unref()
}

/** The last memory lines logged, oldest first. */
export const recentMemoryLines = (): string[] => [...recent]

/** The folder heap snapshots are written to: `heap` in Hive's profile. */
export const heapSnapshotsDir = (profile: string): string => join(profile, 'heap')

export type HeapSnapshot = { file: string; at: number; bytes: number }

/** The snapshots in `dir`, newest first. */
export function heapSnapshots(dir: string): HeapSnapshot[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const found: HeapSnapshot[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.heapsnapshot')) continue
    try {
      const st = statSync(join(dir, name))
      found.push({ file: join(dir, name), at: st.mtimeMs, bytes: st.size })
    } catch {
      // Gone meanwhile.
    }
  }
  return found.sort((a, b) => b.at - a.at)
}

/** Deletes the oldest snapshots in `dir` so `keep` are left. Hive's own diagnostics, in its profile: not to the Recycle Bin, where gigabytes would stay. */
export function pruneHeapSnapshots(dir: string, keep: number): void {
  for (const s of heapSnapshots(dir).slice(keep)) {
    try {
      unlinkSync(s.file)
      log.info(`Deleted an older memory snapshot (${mb(s.bytes)} MB)`)
    } catch (e) {
      log.warn("Couldn't delete an older memory snapshot", e)
    }
  }
}

let snapshotsOn = false

/**
 * Settings → Advanced → Save a memory snapshot if Hive is about to run out of memory: Node writes one heap snapshot as the
 * main process nears its heap limit, before the crash. Node writes it to its diagnostic folder, which only its command
 * line sets, or else the working folder: so the main process works in the snapshots' folder (nothing in main relies on
 * its working folder; what it starts is given its own). Older snapshots go first, so the folder keeps at most two.
 */
export function startHeapSnapshots(profile: string, on: boolean): void {
  const dir = heapSnapshotsDir(profile)
  const had = heapSnapshots(dir)
  if (had.length) log.info(`${had.length} memory snapshot(s) in ${dir}; the newest from ${new Date(had[0].at).toISOString()}`)
  if (!on) return
  try {
    mkdirSync(dir, { recursive: true })
    pruneHeapSnapshots(dir, SNAPSHOTS_KEPT - 1)
    process.chdir(dir)
    setHeapSnapshotNearHeapLimit(1)
    snapshotsOn = true
    log.info(`Memory snapshots on: if the main process nears its heap limit, a snapshot is written to ${dir}`)
  } catch (e) {
    log.warn("Couldn't turn memory snapshots on", e)
  }
}

/** Copy Diagnostics' memory section: the memory now, the snapshot setting and snapshots kept, and the last lines logged. */
export function memoryDiagnostics(profile: string): string[] {
  const dir = heapSnapshotsDir(profile)
  const kept = heapSnapshots(dir)
  return [
    `- Now: ${memoryLine()}`,
    `- Memory snapshots: ${snapshotsOn ? 'on' : 'off'}; ${kept.length ? `${kept.length} in \`${dir}\`, the newest from ${new Date(kept[0].at).toISOString()} (${mb(kept[0].bytes)} MB): they hold what Combwork had in memory, so never attached` : 'none kept'}`, // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
    ...(recent.length ? ['- Logged:', ...recent.map((l) => `  - ${l}`)] : [])
  ]
}
