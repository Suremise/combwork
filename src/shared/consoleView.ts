/**
 * The developer console window's view of the events (#366, #637): the list it keeps, its filters, its source picker's
 * groups and when a payload starts collapsed. Pure, so it is unit tested; the window (ConsoleApp.tsx) draws it.
 */
import { jsonBytes, type ConsoleEvent, type ConsoleSource } from './devConsole'
import { msg, tr } from './i18n'
import { APP_NAME } from './appName'

const M = {
  assistant: msg({ id: 'console.assistant', defaultMessage: 'Assistant', description: "The developer console's source picker: the Assistant's session as a source." }),
  withCount: msg({ id: 'console.sourceCount', defaultMessage: '{name} ({n, number})', description: "The developer console's source picker: a source ({name}: an agent, the Assistant or Combwork itself) with how many events it has captured." })
}

/** The most events the window keeps for its source (the ring holds 500; a long watch keeps more, still bounded). */
export const VIEW_MAX_EVENTS = 2000

/** A payload larger than this as JSON starts collapsed below its top level. */
export const COLLAPSE_BYTES = 1500

/** Adds events to the list, in seq order, each once (a resume's snapshot and a live delivery may overlap), bounded. */
export function mergeEvents(list: readonly ConsoleEvent[], add: readonly ConsoleEvent[], max = VIEW_MAX_EVENTS): ConsoleEvent[] {
  if (!add.length) return list as ConsoleEvent[]
  let last = list.length ? list[list.length - 1].seq : 0
  const inOrder = add.every((e) => {
    const after = e.seq > last
    last = e.seq
    return after
  })
  let next: ConsoleEvent[]
  if (inOrder) next = list.concat(add)
  else {
    const bySeq = new Map<number, ConsoleEvent>()
    for (const e of list) bySeq.set(e.seq, e)
    for (const e of add) bySeq.set(e.seq, e)
    next = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  }
  return next.length > max ? next.slice(next.length - max) : next
}

export interface ConsoleFilter {
  /** A provider id, or '' for all. */
  provider: string
  /** Kinds the user turned off. */
  hiddenKinds: ReadonlySet<string>
  /** Matches an event's name, kind, summary or payload, ignoring case. */
  search: string
  /** Clear hides what came before it: only events after this seq show. */
  afterSeq: number
}

export const NO_FILTER: ConsoleFilter = { provider: '', hiddenKinds: new Set(), search: '', afterSeq: 0 }

const searchTexts = new WeakMap<ConsoleEvent, string>()

/** The event's payloads as one lower-case string, made once per event. */
function payloadText(e: ConsoleEvent): string {
  let t = searchTexts.get(e)
  if (t === undefined) {
    try {
      t = JSON.stringify([e.raw ?? null, e.made ?? null]).toLowerCase()
    } catch {
      t = ''
    }
    searchTexts.set(e, t)
  }
  return t
}

export function filterEvents(list: readonly ConsoleEvent[], f: ConsoleFilter): ConsoleEvent[] {
  const q = f.search.trim().toLowerCase()
  return list.filter(
    (e) =>
      e.seq > f.afterSeq &&
      !f.hiddenKinds.has(e.kind) &&
      (!f.provider || e.provider === f.provider) &&
      (!q || e.name.toLowerCase().includes(q) || e.kind.includes(q) || e.summary.toLowerCase().includes(q) || payloadText(e).includes(q))
  )
}

/** The kinds and providers the events have, for the filter's choices, in a stable order. */
export function filterChoices(list: readonly ConsoleEvent[]): { kinds: string[]; providers: string[] } {
  const kinds = new Set<string>()
  const providers = new Set<string>()
  for (const e of list) {
    kinds.add(e.kind)
    if (e.provider) providers.add(e.provider)
  }
  return { kinds: [...kinds].sort(), providers: [...providers].sort() }
}

export interface SourceGroup {
  label: string
  sources: ConsoleSource[]
}

/** The source picker's groups: Combwork and its Assistant first, then each project's agents, by name. */
export function sourceGroups(sources: readonly ConsoleSource[]): SourceGroup[] {
  const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
  const own = sources.filter((s) => s.kind !== 'session').sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'combwork' ? -1 : 1))
  const projects = new Map<string, ConsoleSource[]>()
  for (const s of sources) {
    if (s.kind !== 'session') continue
    const name = s.project ?? s.projectPath ?? ''
    projects.set(name, [...(projects.get(name) ?? []), s])
  }
  return [
    ...(own.length ? [{ label: APP_NAME, sources: own }] : []), // the app's name (HI-2511), as the picker's group of its own sources
    ...[...projects.entries()].sort(([a], [b]) => byName(a, b)).map(([label, list]) => ({ label, sources: list.sort((a, b) => byName(a.agent ?? a.label, b.agent ?? b.label)) }))
  ]
}

/** A source's name in the picker, within its group. */
export function sourceOption(s: ConsoleSource): string {
  const name = s.kind === 'session' ? (s.agent ?? s.label) : s.kind === 'assistant' ? tr(M.assistant) : s.label
  return s.events ? tr(M.withCount, { name, n: s.events }) : name
}

/** Whether a payload node starts open: the top level always, below it only when it is small. */
export function startsOpen(value: unknown, depth: number): boolean {
  return depth === 0 || jsonBytes(value) <= COLLAPSE_BYTES
}

/** An event's time to the millisecond, local: "14:05:09.312". */
export function clockTime(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}
