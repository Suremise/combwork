import { useEffect, useMemo } from 'react'
import { panelOrder } from '@shared/laneBar'
import type { LaneCard, LaneInfo } from '@shared/types'
import { call } from './api'
import { get, set, useStore } from './store'

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
  /** What the lane is about, in a few words, when it has a name. */
  name: string | null
  /** Its cards' numbers, in the order they are worked. The panel reads each card from the board itself, as it is now. */
  cards: number[]
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
    void call('lanes:list').then((lanes) => current && set({ lanes }))
    // The order as saved now: another window may have changed it while it had this workspace open.
    void call('ui:get').then((ui) => current && set({ laneOrder: ui.laneOrder ?? {} }), () => undefined)
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
      return project ? [{ id: d.id, project, builder: who(d.builder), reviewer: d.reviewer ? who(d.reviewer) : null, name: d.name, cards: d.cards.map((c) => c.number), state: d.state, frozen, startedAt: d.startedAt, endedAt: d.endedAt, mergeCommit: d.mergeCommit, status: d.status ?? null }] : []
    })
    return lanes.length ? panelOrder(lanes, order) : NO_LANES
  }, [raw, projects, order])
}
