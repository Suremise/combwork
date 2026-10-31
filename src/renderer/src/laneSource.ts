import { useEffect, useMemo } from 'react'
import { panelOrder } from '@shared/laneBar'
import { columnSince, type LaneOrderView } from '@shared/tasks'
import type { LaneCard, LaneInfo, LaneSlotInfo, TaskCard } from '@shared/types'
import { call } from './api'
import { get, set, setLoaded, useStore } from './store'

/**
 * Where the Progress panel's lanes come from (#484): the one place that knows the lane data's shape (#483's
 * `LaneInfo`, from `lanes:list` and the `lanes-changed` event). Everything else reads `Lane` through `useLanes()`.
 */

/** A lane as the panel shows it: a builder and its reviewer working through cards in order. */
export interface Lane {
  id: string
  /** Its project's folder (path). */
  project: string
  builder: { agentId: string; name: string }
  reviewer: { agentId: string; name: string } | null
  /** Reviewed by the project's reviewer pool (#1443): no reviewer of its own. */
  pool: boolean
  /** A pool lane's current card (#1446): who gave its last verdict, and who reviews it now. */
  poolReview: LaneInfo['poolReview'] | null
  /** The slot its builder works in (#1446: lent to the lane, or the builder's carried one), as its hover tells it; null: none. */
  slot: LaneSlotInfo | null
  /** What the lane is about, in a few words, when it has a name. */
  name: string | null
  /** Its cards' numbers, in the order they are worked. The panel reads each card from the board itself, as it is now. */
  cards: number[]
  /** Its cards as main read them (HI-1926: each one's round; an ended lane's as it left them), in the same order. */
  info: LaneCard[]
  /** paused: it waits for the user (a blocked card, nothing else worked); ended: merged; abandoned: an agent was removed, or it was given up. */
  state: LaneInfo['state']
  /** Ended or abandoned: its cards as it left them (#512), never the board's now. */
  frozen: LaneCard[] | null
  startedAt: string
  endedAt: string | null
  /** The merge commit its builder reported when it ended (the board's record, before cards had facts: #1225's fallback). */
  mergeCommit: string | null
  /** Why a running lane waits (#1270), as main computed it: its header says so (#1279). */
  status: LaneInfo['status']
  /** Running under old rules (#1421): its project's options changed since it started. */
  oldRules: boolean
  /** A running lane's own stages (its recorded ruleset's, #1421), which its cards in Todo take; null: its project's now. */
  stages: LaneInfo['stages']
  /** A list change queued behind its card in flight (#1270), as main has it: shown in the Lanes tab (HI-2151); null: none. */
  queued: number[] | null
}

const NO_LANES: Lane[] = []
const NO_INFO: LaneInfo[] = []
const NO_ORDER: string[] = []

const folderName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? ''

/** This workspace's running lanes in the user's order (#568), or none: the usual order. */
export function useLaneOrder(): string[] {
  return useStore((s) => (s.workspace ? s.laneOrder[s.workspace.path.toLowerCase()] : undefined) ?? NO_ORDER)
}

/**
 * Keeps this workspace's running lanes in this order (#568; null: back to the usual order): shown at once, and saved by
 * main for this workspace only, on what is saved now.
 */
export function saveLaneOrder(ids: string[] | null): void {
  const ws = get().workspace?.path
  if (!ws) return
  const all = { ...get().laneOrder }
  if (ids?.length) all[ws.toLowerCase()] = ids
  else delete all[ws.toLowerCase()]
  set({ laneOrder: all })
  void call('ui:setLaneOrder', ids)
    .then((saved) => set({ laneOrder: saved }))
    .catch(() => undefined)
}

/**
 * This window's lanes, loaded when its workspace changes (events keep them current), in the workspace's projects, in the
 * panel's order (running first, in the user's order once they moved one; panelOrder). `load: false` only reads what the
 * Progress panel and the sidebar loaded (a tooltip's table, shown for a moment).
 */
export function useLanes(load = true): Lane[] {
  const ws = useStore((s) => s.workspace?.path)
  useEffect(() => {
    if (!ws || !load) return
    let current = true
    void call('lanes:list').then((lanes) => current && setLoaded({ lanes }))
    // The order as saved now: another window may have changed it while it had this workspace open.
    void call('ui:get').then((ui) => current && setLoaded({ laneOrder: ui.laneOrder ?? {} }), () => undefined)
    return () => {
      current = false
    }
  }, [ws, load])
  const raw = useStore((s) => s.lanes ?? NO_INFO)
  const projects = useStore((s) => s.workspace?.projects)
  const order = useLaneOrder()
  return useMemo(() => {
    if (!raw.length || !projects) return NO_LANES
    // A lane names its project by folder name; one whose project isn't in the workspace is left out.
    const pathOf = new Map(projects.map((p) => [folderName(p.path), p.path]))
    const who = (a: { id: string; name: string }): Lane['builder'] => ({ agentId: a.id, name: a.name })
    const lanes = raw.flatMap((d): Lane[] => {
      const project = pathOf.get(d.project.toLowerCase())
      const frozen = d.state === 'ended' || d.state === 'abandoned' ? d.cards : null
      return project ? [{ id: d.id, project, builder: who(d.builder), reviewer: d.reviewer ? who(d.reviewer) : null, pool: !!d.pool, poolReview: d.poolReview ?? null, slot: d.slotInfo ?? null, name: d.name, cards: d.cards.map((c) => c.number), info: d.cards, state: d.state, frozen, startedAt: d.startedAt, endedAt: d.endedAt, mergeCommit: d.mergeCommit, status: d.status ?? null, oldRules: !!d.oldRules, stages: d.stages ?? null, queued: d.queued ?? null }] : []
    })
    return lanes.length ? panelOrder(lanes, order) : NO_LANES
  }, [raw, projects, order])
}

/**
 * A card's running lane as the stall check reads it (#1410: the lane's deadlock), from the lanes loaded now (useLanes
 * loads them); null when it is in none. Its cards' places as the board has them now, their keys and last moves.
 */
export function useLaneOf(): (c: Pick<TaskCard, 'number' | 'project'>) => LaneOrderView | null {
  const raw = useStore((s) => s.lanes ?? NO_INFO)
  const tasks = useStore((s) => s.tasks)
  return useMemo(() => {
    const byNumber = new Map(tasks.map((t) => [t.number, t]))
    const running = raw.filter((l) => (l.state === 'active' || l.state === 'paused') && l.reviewer)
    return (c) => {
      const l = running.find((x) => x.project.toLowerCase() === c.project.toLowerCase() && x.cards.some((y) => y.number === c.number))
      if (!l) return null
      return {
        builder: l.builder.id,
        reviewer: l.reviewer?.id ?? null,
        cards: l.cards.map((y) => {
          const t = byNumber.get(y.number)
          return { number: y.number, column: t?.column ?? y.column, movedAt: t ? columnSince(t) : null, ...(t?.key ? { key: t.key } : {}) }
        })
      }
    }
  }, [raw, tasks])
}
