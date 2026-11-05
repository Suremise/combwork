import { join } from 'path'
import { config } from './config'
import { emit } from './events'
import { adoptBenchmarkOwners, benchContext } from './benchmarks'
import { createLogger } from './logger'
import { applyMetricsRenames, metricsHandle } from './metrics'
import { adoptHandovers } from './notes'
import { progress } from './progressService'
import { nameJournal, noteNames, type NameJournal, type RenameEntry } from './projectNames'
import { PROJECT_PREFS, type ProjectPref } from '../shared/uiPrefs'
import type { ProjectSeen, WorkspaceService } from './workspace'
import type { WorkspaceConfig } from '../shared/types'

const log = createLogger('projectRename')

/**
 * Follows the projects' names (#514) after each read of their ids, in the background, one run at a time per workspace
 * (a read meanwhile is followed after it, with what it saw): the record of names by id (projectNames.ts) is brought up
 * to date, every rename not yet followed is followed (applyRenames), and the records kept by name are given to their
 * projects' ids (handovers, kept comparisons), at the first run and after each change of the record. A run that fails is tried again
 * (after `retryMs`, doubling up to 10 minutes, while the workspace stays open, or at the next read that changes): each
 * step knows what it has done.
 */
export function followNames(ws: WorkspaceService, seen: ProjectSeen[]): void {
  newest.set(ws, seen)
  followSeen(ws, seen)
}

function followSeen(ws: WorkspaceService, seen: ProjectSeen[]): void {
  latest.set(ws, seen)
  if (running.has(ws)) return
  running.add(ws)
  const life = ws.lifetime
  void (async () => {
    try {
      for (let s = latest.get(ws); s; s = latest.get(ws)) {
        latest.delete(ws)
        await follow(ws, s)
      }
      failures.delete(ws)
    } catch (e) {
      const n = (failures.get(ws) ?? 0) + 1
      failures.set(ws, n)
      const wait = Math.min(testHooks.retryMs * 2 ** (n - 1), 600_000)
      log.warn(`following the projects' names (tried again in ${Math.round(wait / 1000)} s)`, e)
      // Tried again with the newest read, never the one that failed: a read since may have been followed meanwhile, and
      // following an older one after it records a rename back that never happened (#555).
      setTimeout(() => {
        const s = newest.get(ws)
        if (s && !life.aborted && ws.lifetime === life) followSeen(ws, s)
      }, wait).unref?.()
    } finally {
      running.delete(ws)
    }
  })()
}

/** Whether the workspace's names are being followed now (tests wait for a run to end). */
export const followingNames = (ws: WorkspaceService): boolean => running.has(ws)

/** How soon a run that failed is tried again, at first (tests make it short). */
export const testHooks = { retryMs: 5000 }
const failures = new WeakMap<WorkspaceService, number>()

const running = new WeakSet<WorkspaceService>()
const latest = new WeakMap<WorkspaceService, ProjectSeen[]>()
/** Each workspace's newest read of its projects, followed or not: what a retry follows. */
const newest = new WeakMap<WorkspaceService, ProjectSeen[]>()
/** What a workspace's lifetime has done: the renames followed (all through `seq`), and whether its records were adopted. */
const done = new WeakMap<WorkspaceService, { life: AbortSignal; seq: number; adopted: NameJournal | null }>()

async function follow(ws: WorkspaceService, seen: ProjectSeen[]): Promise<void> {
  const path = ws.path
  const life = ws.lifetime
  const open = (): boolean => !life.aborted && ws.path === path
  if (!path) return
  const added = await noteNames(ws, seen)
  if (!open()) return
  const j = await nameJournal(ws)
  const had = done.get(ws)
  const state = had && had.life === life ? had : { life, seq: -1, adopted: null }
  done.set(ws, state)
  if (state.seq < j.seq) {
    await applyRenames(ws, j, open)
    if (!open()) return
    state.seq = j.seq
  }
  // At the first run, and whenever the record changed (a rename, a name a Repair found a project had).
  if (state.adopted !== j || added.length) {
    await adoptHandovers(ws)
    if (!open()) return
    await adoptBenchmarkOwners(benchContext(ws))
    state.adopted = j
  }
}

/** The record's renames as batches (renamed together, told together), oldest first, each with its last number. */
function batches(j: NameJournal): { seq: number; renames: RenameEntry[] }[] {
  const out: { seq: number; renames: RenameEntry[] }[] = []
  for (const r of j.renames) {
    const last = out[out.length - 1]
    if (last && last.renames[0].batch === r.batch) {
      last.renames.push(r)
      last.seq = r.seq
    } else out.push({ seq: r.seq, renames: [r] })
  }
  return out
}

/** Moves map entries by key all at once (a swap keeps each one's own): an entry already at a new key gives way to the moved one. */
function moveKeys<T>(map: Record<string, T> | undefined, moves: Map<string, string>): { next: Record<string, T>; moved: { from: string; to: string; value: T }[] } | null {
  if (!map || ![...moves.keys()].some((k) => k in map)) return null
  const next = { ...map }
  const moved: { from: string; to: string; value: T }[] = []
  for (const k of moves.keys()) delete next[k]
  for (const [from, to] of moves) {
    if (!(from in map)) continue
    next[to] = map[from]
    moved.push({ from, to, value: map[from] })
  }
  return { next, moved }
}

/**
 * Follows the record's renames not yet followed, batch by batch, each batch all at once (two projects that swapped
 * names keep their own), in what keeps a project by its folder's name or path. Each place saves the number of the last
 * rename it followed with what it changed (in the same write), so a rename is followed once, and one a failure (or a
 * stop) left behind is followed when this runs again:
 * - the view preferences kept by project path (`ui`'s per-project maps; windows hear, `ui-pref-changed`) and Working on
 *   (config.json's activeProjects), with config.json's `renamesApplied` for the workspace;
 * - Hide or Remove from Hive (workspace.json's hiddenProjects, and its `renamesApplied`);
 * - Progress runs, open and kept (with the kept runs);
 * - metrics measured under the old names (with the measurements).
 * The Progress panel's filter isn't: on a folder with no runs it shows them all.
 */
export async function applyRenames(ws: WorkspaceService, j: NameJournal, open: () => boolean): Promise<void> {
  const wsPath = ws.path
  if (!wsPath || !open()) return
  const all = batches(j)
  const wsKey = wsPath.toLowerCase()
  const fold = (p: string): string => `${wsPath}|${p}`.toLowerCase()
  // Preferences and Working on: one write of config.json, with its number.
  const events: { pref: ProjectPref; project: string; value: unknown }[] = []
  config.update((c) => {
    const appliedTo = c.renamesApplied?.[wsKey] ?? 0
    for (const b of all.filter((x) => x.seq > appliedTo)) {
      const paths = new Map(b.renames.map((r) => [join(wsPath, r.from).toLowerCase(), join(wsPath, r.to).toLowerCase()]))
      const folds = new Map(b.renames.map((r) => [fold(join(wsPath, r.from)), fold(join(wsPath, r.to))]))
      const ui = c.ui as Record<string, unknown>
      for (const pref of PROJECT_PREFS) {
        const r = moveKeys(ui[pref] as Record<string, unknown> | undefined, pref === 'assistantFold' ? folds : paths)
        if (!r) continue
        ui[pref] = r.next
        for (const m of r.moved) events.push({ pref, project: m.from, value: null })
        for (const m of r.moved) events.push({ pref, project: m.to, value: m.value })
      }
      const names = new Map(b.renames.map((r) => [r.from.toLowerCase(), r.to]))
      for (const [k, list] of Object.entries(c.activeProjects)) if (k.toLowerCase() === wsKey) c.activeProjects[k] = [...new Set(list.map((n) => names.get(n.toLowerCase()) ?? n))]
      c.renamesApplied = { ...c.renamesApplied, [wsKey]: b.seq }
    }
  })
  // (Each window applies them in order: a key cleared, then the value moved there.)
  for (const e of events.filter((x) => x.value === null)) emit({ type: 'ui-pref-changed', ...e })
  for (const e of events.filter((x) => x.value !== null)) emit({ type: 'ui-pref-changed', ...e })
  // Hide or Remove from Combwork: one write of workspace.json, with its number.
  // The settings change only once saved: a save that fails leaves them (and their number) as they were, so the next
  // run follows those renames again.
  const hiddenTo = ws.config.renamesApplied ?? 0
  const hiddenBatches = all.filter((x) => x.seq > hiddenTo)
  if (hiddenBatches.length && open()) {
    const renamed = (list: NonNullable<WorkspaceConfig['hiddenProjects']>): NonNullable<WorkspaceConfig['hiddenProjects']> => {
      for (const b of hiddenBatches) {
        const names = new Map(b.renames.map((r) => [r.from.toLowerCase(), r.to]))
        list = list.map((h) => ({ ...h, name: names.get(h.name.toLowerCase()) ?? h.name }))
      }
      return list
    }
    const seq = hiddenBatches[hiddenBatches.length - 1].seq
    await ws.saveWorkspaceConfigWith((c) => ({ ...(c.hiddenProjects ? { hiddenProjects: renamed(c.hiddenProjects) } : {}), renamesApplied: seq }))
    if (open()) await ws.refresh()
  }
  // Progress runs and metrics, each with its own number.
  for (const b of all) {
    if (!open()) return
    const moves = b.renames.map((r) => ({ from: join(wsPath, r.from), to: join(wsPath, r.to) }))
    await progress.applyRenames(wsPath, moves, b.seq)
    applyMetricsRenames(metricsHandle(ws), b.renames, b.seq)
  }
}
