// What an agent's preview captures are made of (HI-3616, design HI-3597 s16 §D and s21 §D′): the screenshot's encoding
// within its byte limit, a place's shots kept to their number, the page's accessibility tree pruned to text, the console's
// errors and warnings, and the server log's tail. Node only: previewGuard.ts and previewApp.ts give it the page, unit
// tests their own.

import { mkdir, readdir, rm, stat, writeFile } from 'original-fs/promises'
import { join } from 'path'

/** A screenshot's limits: the viewport, a full page, and the file's bytes. */
export const SHOT = {
  viewport: { width: 1600, height: 1200 },
  full: { width: 1600, height: 6000 },
  maxBytes: 2 * 1024 * 1024,
  /** Shots kept for a place (the oldest removed first). */
  keep: 20
} as const

let testMax: number | null = null

/** A test copy's own byte limit (previewApp's previewTest, unpackaged only): null for SHOT.maxBytes again. */
export function setShotMaxForTests(bytes: number | null): number {
  testMax = bytes !== null && Number.isInteger(bytes) && bytes > 0 ? bytes : null
  return shotMax()
}

/** The byte limit a screenshot is held to. */
export const shotMax = (): number => testMax ?? SHOT.maxBytes

/** One step of the ladder: the image at `scale` of its size, as PNG (quality null) or JPEG at `quality`. */
export interface Step {
  scale: number
  quality: number | null
}

/** The ladder (s21 §D′): PNG, JPEG at 80, JPEG at 60, 75% at 60, 50% at 60. */
export const LADDER: readonly Step[] = [
  { scale: 1, quality: null },
  { scale: 1, quality: 80 },
  { scale: 1, quality: 60 },
  { scale: 0.75, quality: 60 },
  { scale: 0.5, quality: 60 }
]

/** A screenshot encoded within its limit: its bytes, format and scale. */
export type Encoded = { ok: true; data: Buffer; format: 'png' | 'jpeg'; quality: number | null; scale: number } | { ok: false; smallest: number }

/**
 * The ladder, each step's final bytes checked and nothing kept that is over `maxBytes`; every step over: not ok (the
 * smallest it came to, for the error). `shoot` makes a step's bytes where the work can be bounded (the page's own process,
 * never main's thread); the operation is checked before and after each step, so a cancelled one stops there.
 */
export async function encodeLadder(shoot: (s: Step) => Promise<Buffer>, maxBytes: number, op: Op): Promise<Encoded> {
  let smallest = Infinity
  for (const s of LADDER) {
    checkOp(op)
    const data = await shoot(s)
    checkOp(op)
    smallest = Math.min(smallest, data.length)
    if (data.length <= maxBytes) return { ok: true, data, format: s.quality === null ? 'png' : 'jpeg', quality: s.quality, scale: s.scale }
  }
  return { ok: false, smallest }
}

/** One operation of an agent on a preview (a load or a capture): cancelled past its deadline or by its preview's close. */
export interface Op {
  readonly id: string
  cancelled: 'timedOut' | 'closed' | null
}

/** Why an operation was refused or stopped: its deadline passed, or its preview was closing or closed. */
export class OpStopped extends Error {
  constructor(readonly why: 'timedOut' | 'closed') {
    super(why)
  }
}

/** Throws when the operation was cancelled: the step after a cancellation never runs. */
export function checkOp(op: Op): void {
  if (op.cancelled) throw new OpStopped(op.cancelled)
}

interface LiveOp {
  op: Op
  done: Promise<unknown>
  stop: (why: 'timedOut' | 'closed') => void
}
const liveOps = new Map<string, Set<LiveOp>>()
/** Previews whose close began: no new operation of theirs runs (kept for the newest CLOSED_KEPT). */
const closedIds = new Set<string>()
const CLOSED_KEPT = 1000

/**
 * Runs `work` as one operation of preview `id`, within `ms`: refused once the preview's close began; past `ms`, or at its
 * close, cancelled and stopped at once (OpStopped), the work itself stopping at its next check (checkOp) and its close
 * waiting for it (closeOps).
 */
export async function runOp<T>(id: string, ms: number, work: (op: Op) => Promise<T>): Promise<T> {
  if (closedIds.has(id)) throw new OpStopped('closed')
  const op: Op = { id, cancelled: null }
  let stopNow: (why: 'timedOut' | 'closed') => void = () => undefined
  const stopped = new Promise<never>((_, fail) => {
    stopNow = (why) => {
      if (!op.cancelled) op.cancelled = why
      fail(new OpStopped(op.cancelled))
    }
  })
  stopped.catch(() => undefined)
  const w = work(op)
  const entry: LiveOp = { op, done: w.catch(() => undefined), stop: stopNow }
  const set = liveOps.get(id) ?? new Set<LiveOp>()
  liveOps.set(id, set)
  set.add(entry)
  void entry.done.then(() => {
    set.delete(entry)
    if (!set.size && liveOps.get(id) === set) liveOps.delete(id)
  })
  const timer = setTimeout(() => stopNow('timedOut'), ms)
  try {
    const r = await Promise.race([w, stopped])
    checkOp(op)
    return r
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A preview's close (HI-3616 rounds 1 and 2): no new operation of it runs, those running are cancelled, and it waits for
 * them to end, at most `waitMs`. Its answer is the proof: true only once none is running. False (one still running past
 * the bound) is the runner's "not proved": the place stays held, and the close is asked again (retryHeldJob) until
 * true, so nothing of its operations can touch the place once it is given back. Asked again, it waits for those left.
 */
export async function closeOps(id: string, waitMs: number): Promise<boolean> {
  closedIds.add(id)
  if (closedIds.size > CLOSED_KEPT) closedIds.delete(closedIds.values().next().value as string)
  const set = [...(liveOps.get(id) ?? [])]
  for (const e of set) e.stop('closed')
  if (!set.length) return true
  let timer: NodeJS.Timeout | undefined
  await Promise.race([Promise.all(set.map((e) => e.done)), new Promise<void>((r) => (timer = setTimeout(r, waitMs)))])
  clearTimeout(timer)
  return opsRunning(id) === 0
}

/** How many operations of a preview are running (tests). */
export const opsRunning = (id: string): number => liveOps.get(id)?.size ?? 0

/** A place's shots folder's files, oldest first (their names start with their time). */
async function shotsIn(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((n) => /^shot-\d+-\d+\.(png|jpg)$/.test(n)).sort()
}

/**
 * Writes an encoded shot into a place's folder and keeps at most `keep` (the oldest removed first): its path and bytes.
 * Nothing is written for one that isn't ok, nor kept for a cancelled operation (`op`).
 */
export async function saveShot(dir: string, e: Encoded, n: number, keep: number = SHOT.keep, op?: Op): Promise<{ path: string; bytes: number } | null> {
  if (!e.ok) return null
  if (op) checkOp(op)
  await mkdir(dir, { recursive: true })
  // Checked again between the awaits: a close during the mkdir never starts the write.
  if (op) checkOp(op)
  const file = join(dir, `shot-${String(Date.now()).padStart(14, '0')}-${String(n).padStart(4, '0')}.${e.format === 'png' ? 'png' : 'jpg'}`)
  await writeFile(file, e.data)
  // Cancelled while it wrote (its deadline, its preview's close): nothing of it is kept.
  if (op?.cancelled) {
    await rm(file, { force: true }).catch(() => undefined)
    checkOp(op)
  }
  const all = await shotsIn(dir)
  for (const old of all.slice(0, Math.max(0, all.length - keep))) await rm(join(dir, old), { force: true }).catch(() => undefined)
  return { path: file, bytes: e.data.length }
}

/** How many shots a place's folder holds (tests). */
export async function shotCount(dir: string): Promise<number> {
  return (await shotsIn(dir)).length
}

/** Removes a place's shots folder (its preview stopped, or a new one starting there). */
export async function removeShots(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

/** Whether a path exists (tests). */
export const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false)

/** One node of the accessibility tree, as the DevTools protocol gives it. */
export interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  childIds?: string[]
  parentId?: string
}

/** Roles that only structure the tree: their children are kept, they aren't. */
const HIDDEN_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'presentation', 'ignored'])

/**
 * The accessibility tree as text (s8: the page's default reading): one line per kept node, indented by depth, its role,
 * its name in quotes and its value, cut at `maxBytes` with "…n more". Text nodes repeating their parent's name are left out.
 */
export function axText(nodes: readonly AxNode[], maxBytes: number): { text: string; lines: number; more: number } {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const root = nodes.find((n) => !n.parentId) ?? nodes[0]
  const lines: string[] = []
  const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')
  const clip = (s: string): string => (s.length > 200 ? `${s.slice(0, 199)}…` : s).replace(/\s+/g, ' ').trim()
  const walk = (n: AxNode | undefined, depth: number, parentName: string): void => {
    if (!n) return
    const role = str(n.role?.value)
    const name = clip(str(n.name?.value))
    const value = clip(str(n.value?.value))
    const kept = !n.ignored && !HIDDEN_ROLES.has(role) && !(role === 'StaticText' && name === parentName)
    if (kept) lines.push(`${'  '.repeat(Math.min(depth, 20))}${role}${name ? ` "${name}"` : ''}${value ? ` = ${value}` : ''}`)
    for (const c of n.childIds ?? []) walk(byId.get(c), kept ? depth + 1 : depth, kept ? name : parentName)
  }
  walk(root, 0, '')
  let size = 0
  let taken = 0
  for (const l of lines) {
    const b = Buffer.byteLength(l, 'utf8') + 1
    if (size + b > maxBytes) break
    size += b
    taken++
  }
  return { text: lines.slice(0, taken).join('\n'), lines: lines.length, more: lines.length - taken }
}

/** A console message the page logged. */
export interface ConsoleEntry {
  level: 'error' | 'warning'
  text: string
  at: number
}

/** The console's errors and warnings since load, newest last: at most `max`, each cut at `each` characters, `total` bytes in all. */
export function consoleList(entries: readonly ConsoleEntry[], max = 20, each = 300, total = 6 * 1024): ConsoleEntry[] {
  const newest = entries.slice(-max).map((e) => ({ ...e, text: e.text.length > each ? `${e.text.slice(0, each - 1)}…` : e.text }))
  let size = 0
  const kept: ConsoleEntry[] = []
  for (const e of [...newest].reverse()) {
    size += Buffer.byteLength(e.text, 'utf8') + 16
    if (size > total) break
    kept.unshift(e)
  }
  return kept
}

/** The last `lines` lines of a log's text, at most `maxBytes` (from the end). */
export function logTail(text: string, lines = 20, maxBytes = 2048): string {
  const all = text.replace(/\r\n/g, '\n').split('\n')
  if (all.length && all[all.length - 1] === '') all.pop()
  let out = all.slice(-lines).join('\n')
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(out.indexOf('\n') + 1 || out.length)
  return out
}
