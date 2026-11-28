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

/** An image as the encoding ladder uses it (Electron's NativeImage, or a test's). */
export interface Encodable {
  png: () => Buffer
  jpeg: (quality: number) => Buffer
  /** The image at `factor` of its size. */
  scaled: (factor: number) => Encodable
}

/** A screenshot encoded within its limit: its bytes, format and scale. */
export type Encoded = { ok: true; data: Buffer; format: 'png' | 'jpeg'; quality: number | null; scale: number } | { ok: false; smallest: number }

/**
 * The ladder (s21 §D′): PNG, JPEG at 80, JPEG at 60, 75% at 60, 50% at 60, the final bytes checked after each step and
 * nothing kept that is over `maxBytes`. Every step over: not ok (the smallest it came to, for the error).
 */
export function encodeWithin(img: Encodable, maxBytes: number = SHOT.maxBytes): Encoded {
  const steps: { scale: number; quality: number | null }[] = [
    { scale: 1, quality: null },
    { scale: 1, quality: 80 },
    { scale: 1, quality: 60 },
    { scale: 0.75, quality: 60 },
    { scale: 0.5, quality: 60 }
  ]
  let smallest = Infinity
  for (const s of steps) {
    const at = s.scale === 1 ? img : img.scaled(s.scale)
    const data = s.quality === null ? at.png() : at.jpeg(s.quality)
    smallest = Math.min(smallest, data.length)
    if (data.length <= maxBytes) return { ok: true, data, format: s.quality === null ? 'png' : 'jpeg', quality: s.quality, scale: s.scale }
  }
  return { ok: false, smallest }
}

/** A place's shots folder's files, oldest first (their names start with their time). */
async function shotsIn(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((n) => /^shot-\d+-\d+\.(png|jpg)$/.test(n)).sort()
}

/**
 * Writes an encoded shot into a place's folder and keeps at most `keep` (the oldest removed first): its path and bytes.
 * Nothing is written for one that isn't ok.
 */
export async function saveShot(dir: string, e: Encoded, n: number, keep: number = SHOT.keep): Promise<{ path: string; bytes: number } | null> {
  if (!e.ok) return null
  await mkdir(dir, { recursive: true })
  const file = join(dir, `shot-${String(Date.now()).padStart(14, '0')}-${String(n).padStart(4, '0')}.${e.format === 'png' ? 'png' : 'jpg'}`)
  await writeFile(file, e.data)
  const all = await shotsIn(dir)
  for (const old of all.slice(0, Math.max(0, all.length - keep))) await rm(join(dir, old), { force: true }).catch(() => undefined)
  return { path: file, bytes: e.data.length }
}

/** How many shots a place's folder holds (tests). */
export async function shotCount(dir: string): Promise<number> {
  return (await shotsIn(dir)).length
}

/** Removes a place's shots folder (its preview stopped), or every one (Combwork starting or quitting). */
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
