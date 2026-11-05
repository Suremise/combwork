import { closeSync, existsSync, openSync, readSync, renameSync } from 'original-fs'
import { join, resolve } from 'path'
import { createHash } from 'crypto'
import { config } from './config'
import { placeKey } from './fsutil'
import { createLogger, userText } from './logger'
import { keepAsBackup } from './storeBackup'
import { readTable, saveTable } from './storeTables'
import { dbGeneration, onDbReplaced, upgradeWaiting } from './boardStore'
import { englishText } from '../shared/advanced'
import { msg } from '../shared/i18n'
import { combworkError } from './combworkError'
import type { WorkspaceService } from './workspace'
import { CW_TOOLS } from '../shared/assistantTools'
import { PROVIDERS } from '../shared/providers'
import {
  addTiming,
  emptyTimed,
  LATENCY_BOUNDS_MS,
  mergeTimed,
  type ApiSeries,
  type CatalogSeries,
  type GuidanceSeries,
  type McpSeries,
  type MetricOutcome,
  type MetricsCoverage,
  type MetricsFilters,
  type MetricsPart,
  type MetricsQuery,
  type MetricsReport,
  type MetricsRole,
  type SkillServiceSeries,
  type StreamSeries,
  type Timed,
  type TrendPoint
} from '../shared/metrics'
import type { LaunchWorkflow } from '../shared/workflow/roles'
import { CW_DIR } from '../shared/defaults'

/**
 * Combwork's performance metrics, one store per open workspace (shared/metrics.ts has the contract). Recording is a few
 * map updates into the current hour's bucket; nothing is read from disk on the request path. Buckets are hourly for 7
 * days, then folded into days, kept 30 days, and saved (debounced) in the workspace's database (#1019: `.combwork/combwork.db`,
 * a bucket and its series in their typed tables since #1212, storeTables.ts, so a save writes the buckets that changed, the hour under way, and appends a new
 * one; `.combwork/metrics/metrics.json` before, moved in by the first save), which is git-ignored and machine-local. Every dimension comes from a fixed set (route templates, Combwork's tool names, provider ids), each
 * bucket has caps on projects and series, the store has a cap on buckets whichever way the clock moves, and the file
 * has a size cap: what doesn't fit is dropped and counted. The saved file is untrusted input: size-checked before it
 * is read and checked field by field. Nothing stores a prompt, a body, a token, a URL or a path.
 *
 * Work is recorded against the workspace it started in: a MetricsHandle (its store and lifetime) is taken before any
 * await, and a record after that workspace closed or its window opened another is dropped, never moved to the next.
 * Turned off (Settings → Sessions → Record performance metrics), nothing is recorded; what was recorded stays until it
 * is reset.
 */

const log = createLogger('metrics')

export const METRICS_LIMITS = {
  /** Hourly buckets kept before they are folded into days, and days kept in all. */
  hourlyDays: 7,
  keepDays: 30,
  /** Per bucket: projects, and series of every kind in all. */
  projects: 100,
  series: 2000,
  /** Buckets in a store: the hours of a week and the days of a month, with a little room. */
  buckets: 7 * 24 + 31 + 2,
  /** What is saved (measured as metrics.json's text was): past this the oldest buckets go; a bigger metrics.json from before isn't read. */
  fileBytes: 2 * 1024 * 1024,
  /** How long changes wait before they are saved. */
  saveDelayMs: 30_000,
  /**
   * Observation: how often an open, recording workspace notes that it is still being observed, and the stretches kept
   * (newest last). A gap longer than touchMs and a little is a gap in observation (Combwork closed, recording off, a reset).
   */
  touchMs: 5 * 60_000,
  stretches: 500
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Clocks: wall time picks a bucket, a monotonic one times things. Tests replace them. */
export const clock = { now: (): number => Date.now(), mono: (): number => performance.now() }

interface PartData {
  api: Record<string, ApiSeries>
  mcp: Record<string, McpSeries>
  guidance: Record<string, GuidanceSeries>
  catalog: Record<string, CatalogSeries>
}

interface Bucket {
  start: number
  span: 'hour' | 'day'
  projects: Record<string, PartData>
  workspace: PartData
  skills: SkillServiceSeries
  /** Measurements dropped (a cap was full): in all, and by whose they were (a project's name; '' the workspace's own). */
  dropped: number
  droppedBy: Record<string, number>
  series: number
}

/**
 * A dictionary with no prototype: a project or series named like an Object method ("constructor", "__proto__",
 * "toString") is just a key.
 */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>
const emptyPart = (): PartData => ({ api: dict(), mcp: dict(), guidance: dict(), catalog: dict() })

/**
 * Losses whose owner isn't tracked (the owners' own cap was full): a key no project can have (\0 is never in a name).
 * A project report only says that some losses couldn't be attributed (`lossesUnattributed`), with no count: the count
 * is the workspace's (`droppedUntracked` on a workspace report).
 */
const UNTRACKED = '\0untracked'

/**
 * Counts a dropped measurement against its owner (a project, or '' for the workspace's own). Owners are capped like
 * projects (METRICS_LIMITS.projects, plus the workspace's own); past that a loss is untracked, so bookkeeping never grows
 * where the data couldn't.
 */
function drop(b: Bucket, owner: string, n = 1): void {
  b.dropped += n
  const tracked = owner in b.droppedBy || owner === '' || owner === UNTRACKED || Object.keys(b.droppedBy).filter((k) => k !== '' && k !== UNTRACKED).length < METRICS_LIMITS.projects
  const key = tracked ? owner : UNTRACKED
  b.droppedBy[key] = (b.droppedBy[key] ?? 0) + n
}
const SKILL_COUNTS = ['sharedScans', 'hits', 'misses', 'invalidations', 'tooLarge', 'files', 'bytes', 'headerBytes', 'entries'] as const
const emptySkills = (): SkillServiceSeries => ({ scans: emptyTimed(), sharedScans: 0, hits: 0, misses: 0, invalidations: 0, tooLarge: 0, files: 0, bytes: 0, headerBytes: 0, entries: 0 })
const GUIDANCE_COUNTS = ['launches', 'guidanceBytes', 'guidanceChars', 'customBytes', 'customChars', 'roleBytes', 'roleChars', 'modeBytes', 'modeChars', 'skills', 'skillCatalogBytes', 'skillBytes', 'skillsNotDelivered', 'skillsUnmeasured'] as const
const CATALOG_COUNTS = ['starts', 'tools', 'toolsBytes', 'toolsChars', 'charStarts', 'partStarts', 'partToolsChars', 'descriptionChars', 'paramChars'] as const
const newBucket = (start: number, span: Bucket['span']): Bucket => ({ start, span, projects: dict(), workspace: emptyPart(), skills: emptySkills(), dropped: 0, droppedBy: dict(), series: 0 })
const emptyCatalog = (role: CatalogSeries['role'], workflow: CatalogSeries['workflow']): CatalogSeries => ({ role, workflow, starts: 0, tools: 0, toolsBytes: 0, toolsChars: 0, charStarts: 0, partStarts: 0, partToolsChars: 0, descriptionChars: 0, paramChars: 0 })
/** A guidance series' key: by CLI, role and workflow side, and its dialect chain where one overrides text (HI-2443). */
const guidanceKey = (provider: string, role: string, workflow: string, dialect?: string): string => `${provider} ${role} ${workflow}${dialect ? ` ${dialect}` : ''}`
const emptyGuidance = (provider: string, role: GuidanceSeries['role'], workflow: GuidanceSeries['workflow'], dialect?: string): GuidanceSeries => ({ provider, role, workflow, ...(dialect ? { dialect } : {}), launches: 0, guidanceBytes: 0, guidanceChars: 0, customBytes: 0, customChars: 0, roleBytes: 0, roleChars: 0, modeBytes: 0, modeChars: 0, skills: 0, skillCatalogBytes: 0, skillBytes: 0, skillsNotDelivered: 0, skillsUnmeasured: 0 })

// ---------------------------------------------------------------------------
// Labels: each from a fixed set. Anything else is "(other)", so a label never grows or carries what it shouldn't.
// ---------------------------------------------------------------------------

const ROUTES = new Set<string>(['(no route)']) // i18n-ignore: a route label (a key, as metrics files keep it)
/** The Agent API's route templates (servers.ts registers them), the only route labels. */
export function knownRoute(template: string): void {
  ROUTES.add(template)
}
/** The Assistant's state view at a session start (#1032), measured as a reply of Combwork's own beside the tools'. */
export const START_VIEW_METRIC = 'session start view' // i18n-ignore: a metrics key, shown as a tool name in the developer's Performance view
const TOOLS = new Set<string>([...CW_TOOLS, START_VIEW_METRIC])
const PROVIDER_IDS = new Set<string>(PROVIDERS.map((p) => p.id))
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const ROLES = new Set(['agent', 'assistant', 'api', 'viewer', 'unknown'])
const WORKFLOWS = new Set<string>(['builder', 'reviewer', 'either', 'none'])
/** A series' workflow side as saved: one Combwork records, else `unknown` (saved before HI-2049, or not one it knows). */
const workflowOf = (v: unknown): GuidanceSeries['workflow'] => (typeof v === 'string' && WORKFLOWS.has(v) ? (v as LaunchWorkflow) : 'unknown')
const OUTCOMES = new Set(['ok', 'client-error', 'denied', 'server-error', 'cancelled', 'waiting'])
const OTHER = '(other)'
const inSet = (set: Set<string>, v: unknown): string => (typeof v === 'string' && set.has(v) ? v : OTHER)
/** The longest project label kept as it is; a longer name gets a bounded label of its own (projectLabel). */
const LABEL_MAX = 128
/**
 * A project name as a label: the name itself, or for a name longer than LABEL_MAX its first characters, "|" and a hash
 * of the whole name (case-folded, as names are matched). "|" can't be in a project's name (Windows doesn't allow it in a
 * folder name, and Combwork doesn't in a project's), so a shortened label never equals a real project's name: two folders
 * never share a label. A raw name with "|" (or that couldn't be a folder: empty, a separator, a NUL) gets none: null,
 * counted as untracked, never as the workspace's own. The same labels when recording, loading and querying.
 */
function projectLabel(v: unknown): string | null {
  if (typeof v !== 'string' || !v || /[\\/\0|]/.test(v)) return null
  if (v.length <= LABEL_MAX) return v
  return `${v.slice(0, LABEL_MAX - 17)}|${createHash('sha256').update(v.toLowerCase()).digest('hex').slice(0, 16)}`
}

/** A shortened label as projectLabel makes it: kept as it is when loaded (it is already a label, not a name). */
const SHORTENED = new RegExp(`^[^\\\\/\\0|]{${LABEL_MAX - 17}}\\|[0-9a-f]{16}$`)

/** A label read back from the file: a shortened one as it is, anything else checked as a name would be. */
const storedLabel = (v: unknown): string | null => (typeof v === 'string' && SHORTENED.test(v) ? v : projectLabel(v))

// ---------------------------------------------------------------------------
// The saved file, checked as untrusted input.
// ---------------------------------------------------------------------------

const count = (v: unknown, max = Number.MAX_SAFE_INTEGER): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null)
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

function readTimed(v: unknown): Timed | null {
  const o = obj(v)
  if (!o || !Array.isArray(o.histogram) || o.histogram.length !== LATENCY_BOUNDS_MS.length + 1) return null
  const histogram = o.histogram.map((x) => count(x))
  const c = count(o.count)
  const total = count(o.totalMs)
  const max = count(o.maxMs)
  if (histogram.some((x) => x === null) || c === null || total === null || max === null) return null
  return { count: c, totalMs: total, maxMs: max, histogram: histogram as number[] }
}

function readCounts<K extends string>(o: Record<string, unknown>, keys: readonly K[], optional: readonly K[] = []): Record<K, number> | null {
  const out = {} as Record<K, number>
  for (const k of keys) {
    const v = o[k] === undefined && optional.includes(k) ? 0 : count(o[k])
    if (v === null) return null
    out[k] = v
  }
  return out
}

/** A saved part, keeping only valid series under known labels (keyed as recording keys them), within the bucket's caps. */
function readPart(v: unknown, b: Bucket, owner: string): PartData {
  const part = emptyPart()
  const o = obj(v)
  if (!o) return part
  const each = (m: unknown, fn: (s: Record<string, unknown>) => void): void => {
    for (const s of Object.values(obj(m) ?? {})) {
      const so = obj(s)
      if (so) fn(so)
    }
  }
  const room = (): boolean => (b.series < METRICS_LIMITS.series ? (b.series++, true) : (drop(b, owner), false))
  each(o.api, (s) => {
    const t = readTimed(s)
    const bytes = readCounts(s, ['requestBytes', 'responseBytes'] as const)
    const role = inSet(ROLES, s.role) as ApiSeries['role']
    const outcome = inSet(OUTCOMES, s.outcome) as MetricOutcome
    if (!t || !bytes || (role as string) === OTHER || (outcome as string) === OTHER) return
    const route = inSet(ROUTES, s.route)
    const method = inSet(METHODS, s.method)
    const key = `${method} ${route} ${role} ${outcome}`
    const had = part.api[key] ?? (room() ? (part.api[key] = { route, method, role, outcome, ...emptyTimed(), requestBytes: 0, responseBytes: 0 }) : null)
    if (!had) return
    mergeTimed(had, t)
    had.requestBytes += bytes.requestBytes
    had.responseBytes += bytes.responseBytes
  })
  each(o.mcp, (s) => {
    const t = readTimed(s)
    const sizes = readCounts(s, ['chars', 'bytes'] as const)
    if (!t || !sizes || (s.role !== 'agent' && s.role !== 'assistant') || (s.mode !== 'compact' && s.mode !== 'detail') || (s.outcome !== 'ok' && s.outcome !== 'error')) return
    const tool = inSet(TOOLS, s.tool)
    const key = `${tool} ${s.role} ${s.mode} ${s.outcome}`
    const had = part.mcp[key] ?? (room() ? (part.mcp[key] = { tool, role: s.role, mode: s.mode, outcome: s.outcome, ...emptyTimed(), chars: 0, bytes: 0 }) : null)
    if (!had) return
    mergeTimed(had, t)
    had.chars += sizes.chars
    had.bytes += sizes.bytes
  })
  each(o.guidance, (saved) => {
    // Saved before 0.9.3, when the Assistant's mode was its persona (#1084).
    const s: Record<string, unknown> = { ...saved, modeBytes: saved.modeBytes ?? saved.personaBytes, modeChars: saved.modeChars ?? saved.personaChars }
    const c = readCounts(s, GUIDANCE_COUNTS, ['skillsNotDelivered', 'skillsUnmeasured', 'customBytes', 'customChars', 'roleBytes', 'roleChars', 'modeBytes', 'modeChars'])
    if (!c || (s.role !== 'agent' && s.role !== 'assistant')) return
    const provider = inSet(PROVIDER_IDS, s.provider)
    const workflow = workflowOf(s.workflow)
    const dialect = typeof s.dialect === 'string' && /^[0-9a-f]{1,64}$/.test(s.dialect) ? s.dialect : undefined
    const key = guidanceKey(provider, s.role, workflow, dialect)
    const g = part.guidance[key] ?? (room() ? (part.guidance[key] = emptyGuidance(provider, s.role, workflow, dialect)) : null)
    if (g) for (const k of GUIDANCE_COUNTS) g[k] += c[k]
  })
  each(o.catalog, (s) => {
    // Saved before HI-2049: bytes only, so none of its starts has its characters; before HI-2063, none has their parts.
    const c = readCounts(s, CATALOG_COUNTS, ['toolsChars', 'charStarts', 'partStarts', 'partToolsChars', 'descriptionChars', 'paramChars'])
    if (!c || (s.role !== 'agent' && s.role !== 'assistant') || c.charStarts > c.starts || c.partStarts > c.charStarts || c.partToolsChars > c.toolsChars || c.descriptionChars + c.paramChars > c.partToolsChars) return
    const workflow = workflowOf(s.workflow)
    const key = `${s.role} ${workflow}`
    const g = part.catalog[key] ?? (room() ? (part.catalog[key] = emptyCatalog(s.role, workflow)) : null)
    if (g) for (const k of CATALOG_COUNTS) g[k] += c[k]
  })
  return part
}

/** A saved bucket, or null if it isn't one. Bounded like a live bucket (projects, series). */
function readBucket(v: unknown): Bucket | null {
  const o = obj(v)
  const start = count(o?.start)
  if (!o || start === null || (o.span !== 'hour' && o.span !== 'day')) return null
  const b = newBucket(start, o.span)
  b.workspace = readPart(o.workspace, b, '')
  for (const [name, part] of Object.entries(obj(o.projects) ?? {})) {
    const p = storedLabel(name)
    if (!p) continue
    if (Object.keys(b.projects).length >= METRICS_LIMITS.projects) {
      drop(b, p)
      continue
    }
    b.projects[p] = readPart(part, b, p)
  }
  const s = obj(o.skills)
  if (s) {
    const scans = readTimed(s.scans)
    const c = readCounts(s, SKILL_COUNTS)
    if (scans && c) b.skills = { scans, ...c }
  }
  // Drops saved by owner (a total alone, from before, is the workspace's: it can't be put on a project).
  const by = obj(o.droppedBy)
  let attributed = 0
  for (const [owner, n] of Object.entries(by ?? {})) {
    const c = count(n)
    if (c && (owner === '' || owner === UNTRACKED || storedLabel(owner) === owner)) {
      drop(b, owner, c)
      attributed += c
    }
  }
  const total = count(o.dropped) ?? 0
  if (total > attributed) drop(b, '', total - attributed)
  return b
}

/** A file's text, if it is at most `max` bytes (reading no more than max + 1 to tell); null if bigger. */
function readCappedSync(file: string, max: number): string | null {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(max + 1)
    let n = 0
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null)
      if (!got) break
      n += got
    }
    return n > max ? null : buf.toString('utf8', 0, n)
  } finally {
    closeSync(fd)
  }
}

/** A metrics.json that isn't Combwork's (too big, damaged) renamed `metrics.json.<why>-<time>`, kept as it was; false if Windows refused. */
function setAside(file: string, why: 'too-big' | 'damaged'): boolean {
  const to = `${file}.${why}-${Date.now()}`
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(file, to)
      log.warn(`metrics.json was ${why === 'too-big' ? 'too big' : 'damaged'}: set aside as ${userText(to)}`)
      return true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
        log.warn('setting metrics.json aside', e)
        return false
      }
    }
  }
  log.warn("couldn't set metrics.json aside (held open): tried again when the workspace opens next")
  return false
}

/** Saved observation stretches: [start, end] pairs of finite times, in order, at most the cap (the newest kept). */
function readStretches(v: unknown): [number, number][] {
  if (!Array.isArray(v)) return []
  const out: [number, number][] = []
  for (const x of v) {
    if (!Array.isArray(x) || x.length !== 2) continue
    const a = count(x[0])
    const b = count(x[1])
    if (a === null || b === null || b < a || (out.length && a < out[out.length - 1][1])) continue
    out.push([a, b])
  }
  return out.slice(-METRICS_LIMITS.stretches)
}

class Store {
  buckets: Bucket[] = []
  /**
   * When this workspace was observed (open, recording on, since the last reset), as [start, end] stretches in order:
   * extended while it stays observed (each record and query, and every touchMs), so a gap is time nothing was seen.
   */
  observed: [number, number][] = []
  /**
   * Whether the last stretch has ended for good: recording was turned off, the workspace closed in every window, the
   * store was loaded (whatever happened while it wasn't open was not seen). The next touch starts a new stretch, however
   * soon, so a known gap is never joined over.
   */
  private sealed = true
  /**
   * History removed to keep the file under its cap (not by age): through this time, what was recorded is gone, so
   * nothing before it counts as observed. 0: none.
   */
  evictedThrough = 0
  /** The last project rename (#514, projectNames.ts's number) its measurements follow: saved with them, so one is applied once. */
  renamesApplied = 0
  private timer: NodeJS.Timeout | null = null
  private dirty = false
  private saving: Promise<void> = Promise.resolve()
  /** The workspace whose database keeps them (#1019). */
  readonly workspace: string
  /** Not moved in yet (loaded from metrics.json, or there was none): the next save moves it in with the mark (and keeps the file as a backup). */
  private importing = false
  /** What is saved couldn't be read (the database unavailable): nothing is saved over it. */
  private unreadable = false
  /** The workspace database's generation it was read from (#1207 round 2): a save from an older one is refused. */
  private gen = 0
  constructor(readonly file: string) {
    this.workspace = resolve(file, '..', '..', '..')
    this.gen = dbGeneration(this.workspace)
    this.load()
    const now = clock.now()
    if (this.roll(now)) this.changed()
    this.touch(now)
  }

  /**
   * Notes that the workspace is observed now (if recording): the last stretch goes on if it is still open and ended at
   * most a touch (and a little) ago, else a new one starts. Recording found off ends the stretch where it was last
   * seen. Saved with the next save, never one of its own.
   */
  touch(now: number): void {
    if (!recording()) {
      this.sealed = true
      return
    }
    const last = this.observed[this.observed.length - 1]
    if (last && !this.sealed && now >= last[0] && now - last[1] <= METRICS_LIMITS.touchMs + 60_000) {
      if (now <= last[1]) return // already observed: nothing changes
      last[1] = now
    } else if (!last || now >= last[1]) {
      this.observed.push([now, now])
      if (this.observed.length > METRICS_LIMITS.stretches) this.observed.shift()
      this.sealed = false
    } else return // the clock went back into observed time: nothing new
    this.dirty = true
  }

  /** Ends the current stretch now (observed up to now, if it was still going): recording off, or the last window closed. */
  seal(now: number): void {
    const last = this.observed[this.observed.length - 1]
    if (!this.sealed && last && now > last[1] && now - last[1] <= METRICS_LIMITS.touchMs + 60_000) {
      last[1] = now
      this.dirty = true
    }
    this.sealed = true
  }

  /**
   * A bucket removed for space (the file's cap, the bucket count), not by age: what it held is gone, so the time it
   * covered (up to now) is no longer observed, and reports say history before then is unavailable.
   */
  private evicted(b: Bucket, now: number): void {
    const through = Math.min(b.start + (b.span === 'day' ? DAY : HOUR), now)
    if (through <= this.evictedThrough) return
    this.evictedThrough = through
    this.observed = this.observed.filter(([, end]) => end > through)
    if (this.observed.length && this.observed[0][0] < through) this.observed[0][0] = through
  }

  /**
   * What was saved: the workspace database's rows (#1019), each bucket checked as the file's were. Before they were moved
   * in, metrics.json, if it is no bigger than the file's cap and parses as buckets (the read itself capped: a file replaced
   * or grown meanwhile can't make it read more); the next save moves it in. A metrics.json found after the move (an older
   * Combwork's) is kept as a backup, unread.
   */
  private load(): void {
    try {
      const saved = readTable(this.workspace, 'metrics')
      if (saved.meta.has('imported')) {
        const num = (k: string): unknown => (saved.meta.has(k) ? JSON.parse(saved.meta.get(k)!) : undefined)
        this.fromSaved({ buckets: saved.docs, observed: num('observed'), evictedThrough: num('evictedThrough'), renamesApplied: num('renamesApplied') })
        if (existsSync(this.file)) {
          log.warn("A metrics.json was found after the metrics moved into the workspace database (an older Hive's): kept as a backup, not read")
          keepAsBackup(this.file)
        }
        return
      }
    } catch (e) {
      // Not known to be empty: never saved over (a save would replace what the database has with nothing) until reopened.
      log.warn('Could not read the performance metrics from the workspace database: they are not saved until the workspace is opened again', e)
      this.unreadable = true
      return
    }
    // Not moved in yet: the next save moves in what it has (metrics.json's buckets, or none) and marks it (#1019).
    let text: string | null
    try {
      text = readCappedSync(this.file, METRICS_LIMITS.fileBytes)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.importing = true
        return
      }
      // Can't be read now (held open, no permission; #1019 round 1): nothing is marked, moved or saved over, and the next
      // open reads it again.
      log.warn('Could not read metrics.json to move it into the workspace database: tried again when the workspace opens next; nothing is saved meanwhile', e)
      this.unreadable = true
      return
    }
    let data: Record<string, unknown> | null = null
    try {
      data = text === null ? null : obj(JSON.parse(text))
    } catch {
      data = null
    }
    if (!data || data.version !== 1 || !Array.isArray(data.buckets)) {
      // Too big or not Combwork's metrics: set aside as it is (renamed, never deleted), and the metrics start again; if it
      // can't be set aside, nothing is saved over it, as above.
      if (!setAside(this.file, text === null ? 'too-big' : 'damaged')) {
        this.unreadable = true
        return
      }
      this.importing = true
      this.dirty = true
      return
    }
    this.importing = true
    this.dirty = true
    this.fromSaved(data)
  }

  /** The buckets and observation as saved, each checked. */
  private fromSaved(data: Record<string, unknown>): void {
    for (const raw of (data.buckets as unknown[]).slice(0, METRICS_LIMITS.buckets)) {
      const b = readBucket(raw)
      if (b) this.buckets.push(b)
    }
    this.observed = readStretches(data.observed)
    this.evictedThrough = count(data.evictedThrough) ?? 0
    this.renamesApplied = count(data.renamesApplied) ?? 0
  }

  /** The bucket for now (wall clock): hourly. A clock set back lands in an older hour, if it is still kept. */
  bucket(): Bucket {
    const now = clock.now()
    const start = Math.floor(now / HOUR) * HOUR
    let b = this.buckets.find((x) => x.span === 'hour' && x.start === start)
    if (!b) {
      b = newBucket(start, 'hour')
      this.buckets.push(b)
      this.roll(now)
    }
    return b
  }

  /**
   * Keeps what is kept, by the clock now: hours older than a week folded into their day, days past 30 dropped, and
   * buckets dated more than a day ahead (a clock that was well ahead) dropped too, while a small correction (the clock
   * set back a little) keeps its hours; then at most METRICS_LIMITS.buckets, the oldest going first, whichever way the
   * clock has moved.
   */
  roll(now: number): boolean {
    const before = this.buckets.length
    let folded = false
    const hourCut = now - METRICS_LIMITS.hourlyDays * DAY
    const dayCut = now - METRICS_LIMITS.keepDays * DAY
    const future = Math.floor(now / HOUR) * HOUR + DAY
    const keep: Bucket[] = []
    for (const b of this.buckets.sort((x, y) => x.start - y.start)) {
      if (b.start + (b.span === 'day' ? DAY : HOUR) <= dayCut || b.start >= future) continue
      if (b.span === 'hour' && b.start < hourCut) {
        const dayStart = Math.floor(b.start / DAY) * DAY
        let d = keep.find((x) => x.span === 'day' && x.start === dayStart)
        if (!d) {
          d = newBucket(dayStart, 'day')
          keep.push(d)
        }
        mergeBucket(d, b)
        folded = true
        continue
      }
      keep.push(b)
    }
    while (keep.length > METRICS_LIMITS.buckets) this.evicted(keep.shift()!, now)
    this.buckets = keep
    // Observation outside what is kept goes too (clipped to the oldest kept day), and any dated ahead.
    const seen = this.observed.length
    const firstKept = Math.floor(dayCut / DAY) * DAY
    this.observed = this.observed.filter(([a, b]) => b > firstKept && a < future)
    const clipped = this.observed.length > 0 && this.observed[0][0] < firstKept
    if (clipped) this.observed[0][0] = firstKept
    // Anything folded, expired or dropped is a change to save; nothing changed, nothing to write.
    return folded || keep.length !== before || this.observed.length !== seen || clipped
  }

  changed(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.save()
    }, METRICS_LIMITS.saveDelayMs)
    this.timer.unref?.()
  }

  /** Saves now (after any save already going, so saves never overlap and a flush waits for the last one). */
  save(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.saving = this.saving.then(() => this.write())
    return this.saving
  }

  /**
   * Whether the workspace's board waits for its upgrade to 1.0 (HI-1694): it takes no writes ("attempt to write a readonly
   * database"), so nothing is saved meanwhile; the upgrade replaces the database, and what is observed after it is saved.
   */
  private waiting(): boolean {
    try {
      return upgradeWaiting(this.workspace)
    } catch {
      return false
    }
  }

  private async write(): Promise<void> {
    if (!this.dirty || this.unreadable || this.waiting()) return
    this.dirty = false
    this.roll(clock.now())
    try {
      const now = clock.now()
      const json = (): string => JSON.stringify({ version: 1, buckets: this.buckets, observed: this.observed, ...(this.evictedThrough ? { evictedThrough: this.evictedThrough } : {}), ...(this.renamesApplied ? { renamesApplied: this.renamesApplied } : {}) })
      let text = json()
      // Over the file's cap (in UTF-8 bytes, as it is read back): the oldest buckets go first, all of them if need be,
      // so Combwork never writes a file it would refuse to load.
      // Then, the buckets all gone, the oldest observation (it is small: this is only for a tiny cap).
      while (Buffer.byteLength(text, 'utf8') > METRICS_LIMITS.fileBytes && (this.buckets.length > 0 || this.observed.length > 0)) {
        if (this.buckets.length) this.evicted(this.buckets.sort((x, y) => x.start - y.start).shift()!, now)
        else this.observed.shift()
        text = json()
      }
      // A row a bucket, by its span and start: one leaving the front moves no other (#1019, #1212).
      const rows = this.buckets
      const importing = this.importing
      const gen = this.gen
      const replaced = (): void => {
        if (gen !== dbGeneration(this.workspace)) throw new Error("the workspace's database was replaced since these metrics were read: not saved over it") // i18n-ignore: logged
      }
      await saveTable(this.workspace, 'metrics', rows, {
        observed: JSON.stringify(this.observed),
        evictedThrough: this.evictedThrough ? String(this.evictedThrough) : null,
        renamesApplied: this.renamesApplied ? String(this.renamesApplied) : null,
        // The first save after metrics.json was read moves it in: marked in the same transaction, then the file kept.
        ...(importing ? { imported: JSON.stringify({ at: new Date(now).toISOString(), rows: rows.length, file: this.file }) } : {})
      }, replaced)
      if (importing) {
        this.importing = false
        if (existsSync(this.file)) keepAsBackup(this.file)
      }
    } catch (e) {
      log.warn('Could not save the performance metrics', e)
    }
  }

  /**
   * The workspace's database was replaced (#1207 round 2: the upgrade to 1.0, a restore): what is in memory, read from
   * the file before (saves failed while the upgrade waited), goes for what the file has now; observing starts again.
   */
  reread(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.gen = dbGeneration(this.workspace)
    this.buckets = []
    this.observed = []
    this.evictedThrough = 0
    this.renamesApplied = 0
    this.importing = false
    this.unreadable = false
    this.dirty = false
    this.sealed = true
    this.load()
    this.touch(clock.now())
  }

  /** Everything goes, observation too: from now on is all a report covers. */
  reset(): void {
    this.buckets = []
    this.observed = []
    this.evictedThrough = 0
    this.sealed = true
    this.dirty = true
    this.touch(clock.now())
  }
}

/** Adds bucket b into a (folding hours into a day), within a's caps. */
function mergeBucket(a: Bucket, b: Bucket, capped = true): void {
  for (const [p, part] of Object.entries(b.projects)) {
    if (capped && !a.projects[p] && Object.keys(a.projects).length >= METRICS_LIMITS.projects) {
      drop(a, p)
      continue
    }
    mergePart(a, (a.projects[p] ??= emptyPart()), part, capped, p)
  }
  mergePart(a, a.workspace, b.workspace, capped, '')
  mergeTimed(a.skills.scans, b.skills.scans)
  for (const k of SKILL_COUNTS) a.skills[k] += b.skills[k]
  for (const [owner, n] of Object.entries(b.droppedBy)) drop(a, owner, n)
}

/** Adds part b's series into part a of bucket a, each new series within the bucket's cap (unless summing for a query). */
function mergePart(bucket: Bucket, a: PartData, b: PartData, capped: boolean, owner: string): void {
  const room = (): boolean => {
    if (!capped || bucket.series < METRICS_LIMITS.series) {
      bucket.series++
      return true
    }
    drop(bucket, owner)
    return false
  }
  for (const [k, v] of Object.entries(b.api)) {
    const t = a.api[k] ?? (room() ? (a.api[k] = { ...v, ...emptyTimed(), requestBytes: 0, responseBytes: 0 }) : null)
    if (!t) continue
    mergeTimed(t, v)
    t.requestBytes += v.requestBytes
    t.responseBytes += v.responseBytes
  }
  for (const [k, v] of Object.entries(b.mcp)) {
    const t = a.mcp[k] ?? (room() ? (a.mcp[k] = { ...v, ...emptyTimed(), chars: 0, bytes: 0 }) : null)
    if (!t) continue
    mergeTimed(t, v)
    t.chars += v.chars
    t.bytes += v.bytes
  }
  for (const [k, v] of Object.entries(b.guidance)) {
    const t = a.guidance[k] ?? (room() ? (a.guidance[k] = emptyGuidance(v.provider, v.role, v.workflow, v.dialect)) : null)
    if (!t) continue
    for (const f of GUIDANCE_COUNTS) t[f] += v[f] ?? 0
  }
  for (const [k, v] of Object.entries(b.catalog)) {
    const t = a.catalog[k] ?? (room() ? (a.catalog[k] = emptyCatalog(v.role, v.workflow)) : null)
    if (!t) continue
    for (const f of CATALOG_COUNTS) t[f] += v[f]
  }
}

// ---------------------------------------------------------------------------
// Stores and handles.
// ---------------------------------------------------------------------------

/**
 * Where a piece of work is recorded: the workspace's store as it was when the work started, and that workspace's
 * lifetime. Take it before any await; a record through it after that workspace closed (or its window opened another)
 * is dropped.
 */
export interface MetricsHandle {
  readonly store: Store
  readonly lifetime: AbortSignal
}

const stores = new WeakMap<WorkspaceService, MetricsHandle>()
const live = new Set<Store>()
/**
 * Every store by its file (canonical: resolved, case-folded on Windows): a workspace reopened (by any window, written
 * any way) while its last store is still saving gets that same store, so its saves, a Reset and new records stay in one
 * order and an older snapshot can never overwrite a newer one. A store is forgotten after its final save if nobody
 * reopened it meanwhile.
 */
const byFile = new Map<string, { store: Store; lifetime: AbortSignal; place: string }>()
const fileKey = (file: string): string => (process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file))
// The workspace's database replaced (the upgrade to 1.0, a restore): its store reads what the file has now.
// Under every spelling of the workspace, by the place each store's handle recorded as it entered (#1456).
onDbReplaced((workspacePath, place) => {
  const key = fileKey(join(workspacePath, CW_DIR, 'metrics', 'metrics.json'))
  for (const store of new Set([...byFile].filter(([k, o]) => k === key || o.place === place).map(([, o]) => o.store))) store.reread()
})
/** Saves started by a workspace closing, still going (quitting waits for them). */
const closing = new Set<Promise<void>>()

const recording = (): boolean => config.settings.sessions?.recordPerformance !== false

/** How many open workspaces (windows, lifetimes) hold each store: observed while one does. */
const holders = new Map<Store, number>()

/** Notes every held store as observed every touchMs (unref'd: it never keeps Combwork running). */
let ticker: NodeJS.Timeout | null = null
function startTicker(): void {
  if (ticker) return
  ticker = setInterval(() => {
    const now = clock.now()
    for (const s of holders.keys()) s.touch(now)
  }, METRICS_LIMITS.touchMs)
  ticker.unref?.()
}

/** Recording turned off ends every stretch at once; turned on, a new one starts at once (not at the next touch). */
config.onSettingsChanged?.((next, prev) => {
  const on = next.sessions?.recordPerformance !== false
  if (on === (prev.sessions?.recordPerformance !== false)) return
  const now = clock.now()
  for (const s of holders.keys()) {
    if (on) s.touch(now)
    else s.seal(now)
  }
})

/** The workspace's store now (made, and loaded, on first use; saved and forgotten when the workspace closes). */
export function metricsHandle(w: WorkspaceService | null | undefined): MetricsHandle | null {
  if (!w?.path || w.lifetime.aborted) return null
  const had = stores.get(w)
  if (had && had.lifetime === w.lifetime) return had
  const lifetime = w.lifetime
  const file = join(w.path, CW_DIR, 'metrics', 'metrics.json')
  const key = fileKey(file)
  // The same file's store if one is still here (saving after its workspace closed): reused, under this lifetime.
  const shared = byFile.get(key)
  const store = shared?.store ?? new Store(file)
  // Its workspace's place resolved as it enters (#1456).
  const owner = { store, lifetime, place: placeKey(w.path) }
  byFile.set(key, owner)
  const entry: MetricsHandle = { lifetime, store }
  stores.set(w, entry)
  live.add(store)
  holders.set(store, (holders.get(store) ?? 0) + 1)
  store.touch(clock.now())
  startTicker()
  lifetime.addEventListener('abort', () => {
    // The last workspace holding it closed: what follows isn't observed, however soon it is reopened.
    const n = (holders.get(store) ?? 1) - 1
    if (n > 0) holders.set(store, n)
    else {
      holders.delete(store)
      store.seal(clock.now())
    }
    // Still this file's store under this lifetime: it closes now (a later lifetime has taken it over otherwise).
    if (byFile.get(key) !== owner) return
    live.delete(store)
    const saving = store
      .save()
      .finally(() => {
        closing.delete(saving)
        if (byFile.get(key) === owner) byFile.delete(key)
      })
    closing.add(saving)
  })
  return entry
}

/**
 * Projects renamed within the workspace together (#514, one batch of projectNames.ts's renames, `seq` its last): what
 * was measured under each old name is that project's, under its new name now, bucket by bucket, all at once (two that
 * swapped names keep their own), merged with what the new name has (its caps aside: nothing measured is lost to them),
 * its losses counted the same way. Applied once (`renamesApplied`, saved with the measurements); whether it was now.
 */
export function applyMetricsRenames(h: MetricsHandle | null, batch: { from: string; to: string }[], seq: number): boolean {
  if (!h || h.lifetime.aborted || seq <= h.store.renamesApplied) return false
  const moves = batch.map((r) => [projectLabel(r.from), projectLabel(r.to)] as const).filter((m): m is readonly [string, string] => !!m[0] && !!m[1] && m[0] !== m[1])
  for (const bucket of h.store.buckets) {
    // Taken out first, every one, then given to the new names: a swap never merges the two.
    const parts = moves.map(([a]) => bucket.projects[a])
    const dropped = moves.map(([a]) => bucket.droppedBy[a])
    for (const [a] of moves) {
      const part = bucket.projects[a]
      // Its series leave with it; merging counts those the new name hasn't (so the bucket's count stays true).
      if (part) bucket.series -= Object.keys(part.api).length + Object.keys(part.mcp).length + Object.keys(part.guidance).length + Object.keys(part.catalog).length
      delete bucket.projects[a]
      delete bucket.droppedBy[a]
    }
    moves.forEach(([, b], i) => {
      if (parts[i]) mergePart(bucket, (bucket.projects[b] ??= emptyPart()), parts[i], false, b)
      if (dropped[i]) bucket.droppedBy[b] = (bucket.droppedBy[b] ?? 0) + dropped[i]
    })
  }
  h.store.renamesApplied = seq
  h.store.changed()
  return true
}

/** The handle's bucket now, if its workspace is still the one it was taken for and Combwork is recording. */
function bucketOf(h: MetricsHandle | null): { store: Store; b: Bucket } | null {
  if (!h || h.lifetime.aborted || !recording()) return null
  h.store.touch(clock.now())
  return { store: h.store, b: h.store.bucket() }
}

/** A part of the bucket: a project's, or the workspace's own. Past the projects cap, dropped (and counted). */
function partOf(b: Bucket, project: string | null): PartData | null {
  if (!project) return b.workspace
  const p = projectLabel(project)
  if (!p) {
    drop(b, UNTRACKED)
    return null
  }
  if (b.projects[p]) return b.projects[p]
  if (Object.keys(b.projects).length >= METRICS_LIMITS.projects) {
    drop(b, p)
    return null
  }
  return (b.projects[p] = emptyPart())
}

/** Whose a part's measurements are, for drop counting: the project's label, '' for the workspace's own, untracked if it has none. */
const ownerOf = (project: string | null): string => (project ? (projectLabel(project) ?? UNTRACKED) : '')

/** A series in a part, made if there is room in the bucket (else dropped, and counted against its owner). */
function series<T>(b: Bucket, owner: string, map: Record<string, T>, key: string, make: () => T): T | null {
  const had = map[key]
  if (had) return had
  if (b.series >= METRICS_LIMITS.series) {
    drop(b, owner)
    return null
  }
  b.series++
  return (map[key] = make())
}

// ---------------------------------------------------------------------------
// Recording. Each one is cheap and never throws: metrics must not break a request or a launch.
// ---------------------------------------------------------------------------

/**
 * How an Agent API request ended: cancelled if its reply wasn't finished (the client went away), waiting if it answered
 * with a wait (HI-1831: resolve's 409 while no check copy is free, which says to ask again), else by its status.
 */
export function apiOutcome(r: { finished: boolean; status: number; waiting: boolean }): MetricOutcome {
  if (!r.finished) return 'cancelled'
  if (r.waiting) return 'waiting'
  const s = r.status
  return s < 400 ? 'ok' : s === 401 || s === 403 ? 'denied' : s < 500 ? 'client-error' : 'server-error'
}

export function recordApi(h: MetricsHandle | null, project: string | null, r: { route: string; method: string; role: ApiSeries['role']; outcome: MetricOutcome; requestBytes: number; responseBytes: number; ms: number }): void {
  try {
    const at = bucketOf(h)
    if (!at) return
    const part = partOf(at.b, project)
    if (!part) return at.store.changed()
    const route = inSet(ROUTES, r.route)
    const method = inSet(METHODS, r.method)
    const s = series(at.b, ownerOf(project), part.api, `${method} ${route} ${r.role} ${r.outcome}`, () => ({ route, method, role: r.role, outcome: r.outcome, ...emptyTimed(), requestBytes: 0, responseBytes: 0 }))
    if (s) {
      addTiming(s, r.ms)
      s.requestBytes += Math.max(0, Math.floor(r.requestBytes))
      s.responseBytes += Math.max(0, Math.floor(r.responseBytes))
    }
    at.store.changed()
  } catch (e) {
    log.warn('recordApi', e)
  }
}

/** At most this many reports in one bridge post, and these as the largest values taken. */
export const MCP_REPORT_LIMITS = { events: 50, chars: 50_000_000, ms: 3_600_000, tools: 200 }

/** One Combwork tool call the bridge answered (its report, checked: bad values are refused, not stored). */
export function recordMcp(h: MetricsHandle | null, project: string | null, role: McpSeries['role'], e: { tool: unknown; mode: unknown; ok: unknown; chars: unknown; bytes: unknown; ms: unknown }): boolean {
  const chars = count(e.chars, MCP_REPORT_LIMITS.chars)
  const bytes = count(e.bytes, MCP_REPORT_LIMITS.chars * 4)
  const ms = count(e.ms, MCP_REPORT_LIMITS.ms)
  if (chars === null || bytes === null || ms === null || typeof e.ok !== 'boolean' || (e.mode !== 'compact' && e.mode !== 'detail')) return false
  try {
    const at = bucketOf(h)
    if (!at) return true
    const part = partOf(at.b, project)
    if (!part) {
      // Dropped (a cap, or a name with no label): the loss itself is a change to save.
      at.store.changed()
      return true
    }
    const tool = inSet(TOOLS, e.tool)
    const outcome = e.ok ? 'ok' : 'error'
    const s = series(at.b, ownerOf(project), part.mcp, `${tool} ${role} ${e.mode} ${outcome}`, () => ({ tool, role, mode: e.mode as McpSeries['mode'], outcome, ...emptyTimed(), chars: 0, bytes: 0 }))
    if (s) {
      addTiming(s, ms)
      s.chars += chars
      s.bytes += bytes
    }
    at.store.changed()
  } catch (err) {
    log.warn('recordMcp', err)
  }
  return true
}

/**
 * The bridge's tool list as one session start sent it to its CLI, on the workflow side of the launch it reported for
 * (HI-2049: that launch's own, `unknown` when Combwork doesn't know it). A bridge from before HI-2049 sends no `toolsChars`:
 * its start counts in `starts`, not `charStarts`; one from before HI-2063 sends no parts: in `charStarts`, not
 * `partStarts`. Parts come both or neither, with the characters, and add up to no more than them.
 */
export function recordCatalog(h: MetricsHandle | null, project: string | null, role: CatalogSeries['role'], workflow: CatalogSeries['workflow'], c: { tools: unknown; toolsBytes: unknown; toolsChars?: unknown; descriptionChars?: unknown; paramChars?: unknown }): boolean {
  const int = (v: unknown): number | null => {
    const n = count(v, 10_000_000)
    return n !== null && Number.isInteger(n) ? n : null
  }
  const tools = count(c.tools, MCP_REPORT_LIMITS.tools)
  const toolsBytes = int(c.toolsBytes)
  const toolsChars = c.toolsChars === undefined ? undefined : int(c.toolsChars)
  if (tools === null || toolsBytes === null || toolsChars === null || !Number.isInteger(tools)) return false
  const hasParts = c.descriptionChars !== undefined || c.paramChars !== undefined
  const parts = hasParts ? { description: int(c.descriptionChars), param: int(c.paramChars) } : null
  if (parts && (toolsChars === undefined || parts.description === null || parts.param === null || parts.description + parts.param > toolsChars)) return false
  try {
    const at = bucketOf(h)
    if (!at) return true
    const part = partOf(at.b, project)
    if (!part) {
      // Dropped (a cap, or a name with no label): the loss itself is a change to save.
      at.store.changed()
      return true
    }
    const side = workflowOf(workflow)
    const s = series(at.b, ownerOf(project), part.catalog, `${role} ${side}`, () => emptyCatalog(role, side))
    if (s) {
      s.starts++
      s.tools += tools
      s.toolsBytes += toolsBytes
      if (toolsChars !== undefined) {
        s.toolsChars += toolsChars
        s.charStarts++
      }
      if (parts && toolsChars !== undefined) {
        s.partStarts++
        s.partToolsChars += toolsChars
        s.descriptionChars += parts.description!
        s.paramChars += parts.param!
      }
    }
    at.store.changed()
  } catch (err) {
    log.warn('recordCatalog', err)
  }
  return true
}

/** One launch's Combwork-supplied guidance (exact sizes of each part; the skills as delivered). */
export function recordLaunch(h: MetricsHandle | null, project: string | null, g: Omit<GuidanceSeries, 'launches'>): void {
  try {
    const at = bucketOf(h)
    if (!at) return
    const part = partOf(at.b, project)
    if (!part) return at.store.changed()
    const provider = inSet(PROVIDER_IDS, g.provider)
    const workflow = workflowOf(g.workflow)
    const dialect = g.dialect || undefined
    const s = series(at.b, ownerOf(project), part.guidance, guidanceKey(provider, g.role, workflow, dialect), () => emptyGuidance(provider, g.role, workflow, dialect))
    if (s) {
      s.launches++
      for (const f of GUIDANCE_COUNTS) if (f !== 'launches') s[f] += Math.max(0, Math.floor(g[f]))
    }
    at.store.changed()
  } catch (e) {
    log.warn('recordLaunch', e)
  }
}

/** The skill service's work: a scan's time, or counts from the inventory (the workspace's, never a project's). */
export function recordSkills(h: MetricsHandle | null, d: Partial<Omit<SkillServiceSeries, 'scans'>> & { scanMs?: number }): void {
  try {
    const at = bucketOf(h)
    if (!at) return
    const s = at.b.skills
    if (d.scanMs !== undefined) addTiming(s.scans, d.scanMs)
    for (const f of SKILL_COUNTS) if (d[f]) s[f] += d[f]!
    at.store.changed()
  } catch (e) {
    log.warn('recordSkills', e)
  }
}

// Process-wide: not any workspace's.
const app = { unauthenticated: 0, inFlight: 0, streams: { connections: 0, events: 0, bytes: 0, openMs: 0 } as StreamSeries }
export const appMetrics = {
  unauthenticated(): void {
    if (recording()) app.unauthenticated++
  },
  requestStarted(): void {
    app.inFlight++
  },
  requestEnded(): void {
    app.inFlight = Math.max(0, app.inFlight - 1)
  },
  stream(d: Partial<StreamSeries>): void {
    if (!recording()) return
    for (const f of ['connections', 'events', 'bytes', 'openMs'] as const) if (d[f]) app.streams[f] += d[f]!
  }
}

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------

const toPart = (p: PartData): MetricsPart => ({ api: Object.values(p.api), mcp: Object.values(p.mcp), guidance: Object.values(p.guidance), catalog: Object.values(p.catalog) })

/** What Combwork doesn't measure (#850): the window's text, and its English for agents (`notMeasured`), item for item. */
const NOT_MEASURED_TEXT = [
  msg({ id: 'service.metrics.notTokens', defaultMessage: 'Provider tokens per Combwork tool or per guidance part: providers report a session’s usage, not what each part of its context cost.', description: "On the Performance page, under What isn't measured: Combwork can't tell how many tokens each of its tools or guidance parts cost." }),
  msg({ id: 'service.metrics.notNetwork', defaultMessage: 'Provider network traffic: Combwork starts the CLIs; it is not a proxy between them and their providers.', description: "On the Performance page, under What isn't measured: the coding agent CLIs' own network traffic." }),
  msg({ id: 'service.metrics.notCliContext', defaultMessage: 'Context a CLI adds itself (its own system prompt, tool definitions, files it reads).', description: "On the Performance page, under What isn't measured: what a coding agent CLI puts in its model's context itself." }),
  msg({ id: 'service.metrics.notSkillReads', defaultMessage: 'Whether a model read a skill: delivered skills are counted, reading one is not observable.', description: "On the Performance page, under What isn't measured: whether a model read a skill Combwork gave it." }),
  msg({ id: 'service.metrics.notTransport', defaultMessage: 'HTTP headers and transport: request sizes are the body bytes received, response sizes the JSON body written (an aborted reply may not all have been sent).', description: "On the Performance page, under What isn't measured: the Agent API's request and response sizes count only the bodies." })
]
// agent-stored: metricsForAgents says each for the agent reading the report (servers.ts)
const NOT_MEASURED = NOT_MEASURED_TEXT.map((m) => englishText(m))

/** What a role or provider filter can't narrow (#850), each item's text for the window. */
const NOT_FILTERED = {
  provider: msg({ id: 'service.metrics.notPerProvider', defaultMessage: 'Agent API requests, tool calls and the tool list aren’t recorded per provider: they are every provider’s.', description: "A note on the Performance page while it is filtered by provider: these numbers can't be narrowed to one provider." }),
  shared: msg({ id: 'service.metrics.sharedNumbers', defaultMessage: 'The skill service and Combwork-wide numbers are shared: not per role or provider.', description: "A note on the Performance page while it is filtered by role or provider: these numbers can't be narrowed." }),
  dropped: msg({ id: 'service.metrics.droppedPerProject', defaultMessage: 'Dropped measurements are counted per project, not per role or provider.', description: "A note on the Performance page while it is filtered by role or provider: dropped measurements can't be narrowed." })
}

/** At most this many points in a trend. */
const TREND_MAX = 200

/** A part with only the series the filters keep (role everywhere it is known; provider on launches only). */
function filtered(p: PartData, f: { role?: MetricsRole; provider?: string }): PartData {
  if (!f.role && !f.provider) return p
  const keep = <T extends { role: string }>(m: Record<string, T>, more?: (v: T) => boolean): Record<string, T> => {
    const out = dict<T>()
    for (const [k, v] of Object.entries(m)) if ((!f.role || v.role === f.role) && (!more || more(v))) out[k] = v
    return out
  }
  return { api: keep(p.api), mcp: keep(p.mcp), guidance: keep(p.guidance, (g) => !f.provider || g.provider === f.provider), catalog: keep(p.catalog) }
}

/** How much of [from, to) the stretches cover, ms. */
function overlap(stretches: [number, number][], from: number, to: number): number {
  let n = 0
  for (const [a, b] of stretches) n += Math.max(0, Math.min(b, to) - Math.max(a, from))
  return n
}

/**
 * The scope's totals per hour (a range of up to 2 days) or per day, every slot of the range present with how much of it
 * was observed (zeros in an unobserved slot mean nothing was seen), from the buckets in range and the scope's parts of
 * each, filtered as the report is.
 */
function trendOf(inRange: Bucket[], from: number, to: number, parts: (b: Bucket) => PartData[], observed: [number, number][]): { trend: TrendPoint[]; trendStep: 'hour' | 'day' } {
  const step = to - from <= 2 * DAY ? HOUR : DAY
  const first = Math.floor(from / step) * step
  const slots = Math.min(TREND_MAX, Math.max(1, Math.ceil((to - first) / step)))
  const start = to - first > slots * step ? Math.floor((to - (slots - 1) * step) / step) * step : first
  const points: TrendPoint[] = Array.from({ length: slots }, (_, i) => {
    const a = start + i * step
    return { start: new Date(a).toISOString(), observedMs: overlap(observed, Math.max(a, from), Math.min(a + step, to)), requests: 0, failed: 0, cancelled: 0, waits: 0, requestBytes: 0, responseBytes: 0, toolCalls: 0, toolChars: 0, launches: 0, guidanceBytes: 0 }
  })
  for (const b of inRange) {
    const pt = points[Math.floor((b.start - start) / step)]
    if (!pt) continue
    for (const part of parts(b)) {
      for (const a of Object.values(part.api)) {
        pt.requests += a.count
        if (a.outcome === 'waiting') pt.waits += a.count
        else if (a.outcome !== 'ok') pt.failed += a.count
        if (a.outcome === 'cancelled') pt.cancelled += a.count
        pt.requestBytes += a.requestBytes
        pt.responseBytes += a.responseBytes
      }
      for (const m of Object.values(part.mcp)) {
        pt.toolCalls += m.count
        pt.toolChars += m.chars
      }
      for (const g of Object.values(part.guidance)) {
        pt.launches += g.launches
        pt.guidanceBytes += g.guidanceBytes + g.customBytes + g.roleBytes + g.modeBytes + g.skillCatalogBytes
      }
    }
  }
  return { trend: points, trendStep: step === HOUR ? 'hour' : 'day' }
}

const QUERY_ROLES = new Set<string>(['agent', 'assistant', 'api', 'viewer'])

/**
 * The workspace's metrics for a scope, range and filters, by the clock now (what has expired is gone before anything is
 * read). A project scope has that project's part only; a workspace scope has every project's and the workspace's own
 * (or, `own`, the workspace's own only), which add up to its totals without counting anything twice. Role and provider
 * filters narrow every part, the trend and the totals alike, and the report says what they couldn't narrow. The
 * provider usage summary is added by the caller.
 */
export function queryMetrics(w: WorkspaceService, q: MetricsQuery): Omit<MetricsReport, 'providers'> {
  const now = clock.now()
  const to = q.to ? Date.parse(q.to) : now
  const from = q.from ? Date.parse(q.from) : to - DAY
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw combworkError(msg({ id: 'service.metrics.badRange', defaultMessage: 'from and to must be ISO times, from before to', description: 'An error reading metrics: the range asked for is not two times in order. from and to are the parameters\' names: keep them, and ISO.' }), undefined, { kind: 'invalid' })
  if (q.role !== undefined && !QUERY_ROLES.has(q.role)) throw combworkError(msg({ id: 'service.metrics.badRole', defaultMessage: 'role must be agent, assistant, api or viewer', description: "An error reading metrics: the role filter isn't one of its values. Keep role, agent, assistant, api and viewer as they are (a parameter and its values)." }), undefined, { kind: 'invalid' })
  if (q.provider !== undefined && (typeof q.provider !== 'string' || q.provider.length > 64)) throw combworkError(msg({ id: 'service.metrics.badProvider', defaultMessage: 'provider must be a provider id', description: "An error reading metrics: the provider filter isn't a provider's id. Keep provider as it is (a parameter's name)." }), undefined, { kind: 'invalid' })
  const h = metricsHandle(w)
  if (h) {
    h.store.touch(now)
    if (h.store.roll(now)) h.store.changed()
  }
  const inRange: Bucket[] = []
  for (const b of h?.store.buckets ?? []) {
    const end = b.start + (b.span === 'day' ? DAY : HOUR)
    if (end > from && b.start < to) inRange.push(b)
  }
  const f = { role: q.role, provider: q.provider || undefined }
  const own = q.scope.kind === 'workspace' && q.own === true
  const want = q.scope.kind === 'project' ? (projectLabel(q.scope.project) ?? '').toLowerCase() : ''
  // The scope's parts of a bucket, filtered, by owner ('' the workspace's own).
  const partsOf = (b: Bucket): [string, PartData][] =>
    q.scope.kind === 'project'
      ? Object.entries(b.projects)
          .filter(([name]) => name.toLowerCase() === want)
          .map(([name, p]) => [name, filtered(p, f)])
      : [...(own ? [] : Object.entries(b.projects).map(([name, p]): [string, PartData] => [name, filtered(p, f)])), ['', filtered(b.workspace, f)]]

  const observed = h?.store.observed ?? []
  // Stretches that touch the range (one that starts as it ends is the observation made now).
  const inRangeStretches = observed.filter(([a, b]) => b >= from && a <= to)
  const evictedThrough = h?.store.evictedThrough ?? 0
  const coverage: MetricsCoverage = {
    rangeMs: to - from,
    observedMs: overlap(observed, from, to),
    observedSince: inRangeStretches.length ? new Date(Math.max(from, inRangeStretches[0][0])).toISOString() : null,
    stretches: inRangeStretches.length,
    // The storage's own fact (no project's): history it removed for space, if any of it was in the range.
    ...(evictedThrough > from ? { evictedThrough: new Date(Math.min(evictedThrough, to)).toISOString() } : {})
  }
  const notFilteredText = [
    ...(f.provider ? [NOT_FILTERED.provider] : []),
    ...((f.role || f.provider) && q.scope.kind === 'workspace' ? [NOT_FILTERED.shared] : []),
    ...(f.role || f.provider ? [NOT_FILTERED.dropped] : [])
  ]
  // agent-stored: metricsForAgents says each for the agent reading the report (servers.ts)
  const notFiltered = notFilteredText.map((m) => englishText(m))
  const filters: MetricsFilters = { ...(f.role ? { role: f.role } : {}), ...(f.provider ? { provider: f.provider } : {}), ...(own ? { own: true as const } : {}), notFiltered, ...(notFilteredText.length ? { notFilteredText } : {}) }
  const base = { workspacePath: w.path ?? '', from: new Date(from).toISOString(), to: new Date(to).toISOString(), recording: recording(), notMeasured: NOT_MEASURED, notMeasuredText: NOT_MEASURED_TEXT, filters, coverage }
  const trend = q.trend ? trendOf(inRange, from, to, (b) => partsOf(b).map(([, p]) => p), observed) : {}

  // A sum isn't capped like a bucket: it is bounded by the buckets it adds, which are.
  const sum = newBucket(from, 'hour')
  for (const b of inRange) {
    for (const [name, p] of partsOf(b)) mergePart(sum, name ? (sum.projects[name] ??= emptyPart()) : sum.workspace, p, false, name)
    mergeTimed(sum.skills.scans, b.skills.scans)
    for (const k of SKILL_COUNTS) sum.skills[k] += b.skills[k]
  }

  if (q.scope.kind === 'project') {
    // Projects are folder names, matched as the API matches them (case-insensitively); its drops are its own.
    const part = emptyPart()
    for (const [name, pt] of Object.entries(sum.projects)) mergePart(sum, part, pt, false, name)
    // Its own losses, bucket by bucket (each bucket's owners are its own, never capped again by the sum); others' and
    // untracked ones are not this project's to see: only whether some couldn't be attributed.
    let dropped = 0
    let unattributed = false
    for (const b of inRange) {
      for (const [owner, n] of Object.entries(b.droppedBy)) {
        if (owner === UNTRACKED) unattributed ||= n > 0
        else if (owner && owner.toLowerCase() === want) dropped += n
      }
    }
    return { ...base, dropped, ...(unattributed ? { lossesUnattributed: true as const } : {}), ...trend, scope: q.scope, projects: { [q.scope.project]: toPart(part) } }
  }
  const untracked = own ? 0 : inRange.reduce((n, b) => n + (b.droppedBy[UNTRACKED] ?? 0), 0)
  const dropped = own ? inRange.reduce((n, b) => n + (b.droppedBy[''] ?? 0), 0) : inRange.reduce((n, b) => n + b.dropped, 0)
  return {
    ...base,
    ...trend,
    dropped,
    ...(untracked ? { droppedUntracked: untracked } : {}),
    scope: q.scope,
    projects: Object.fromEntries(Object.entries(sum.projects).map(([p, part]) => [p, toPart(part)])),
    workspace: toPart(sum.workspace),
    skills: sum.skills,
    app: { unauthenticated: app.unauthenticated, streams: { ...app.streams }, inFlight: app.inFlight }
  }
}

/** Clears the workspace's metrics (and its file at the next save). */
export function resetMetrics(w: WorkspaceService): void {
  const h = metricsHandle(w)
  if (!h) return
  h.store.reset()
  h.store.changed()
  void h.store.save()
}

/** Saves every open workspace's metrics now (quitting). */
export async function flushMetrics(): Promise<void> {
  await Promise.all([...[...live].map((s) => s.save()), ...closing])
}
