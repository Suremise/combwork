/**
 * Release Slot for the Agent API and the Assistant's hive_release_slot (#1561): the two releases the window offers in an
 * agent's ⋯, by slot name. A carried slot (#1441: an agent's adopted worktree, kept for it under a carried lease) stops
 * being kept for it; a held writer (#1506: a run that is over still holding the slot, its processes not known to have
 * ended) is cleared once the caller confirms the slot and run it was shown, ending the processes Hive lists first when
 * asked. The refusals are the window's own (`releaseHeldWriter`: its run live here, its Hive still running or not
 * known, the writer no longer that run), and a release racing a claim has one outcome (its write is fenced by the run).
 */
import { projectAgents } from '../shared/defaults'
import { folderFacts, heldWriter, releaseHeldWriter } from './agentFolders'
import { releaseCarried } from './slotMigration'
import { workspace, type WorkspaceService } from './workspace'
import type { HeldWriter } from '../shared/types'

/** A release refused before anything changed, with the Agent API's status. */
export class SlotReleaseRefused extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string
  ) {
    super(message)
  }
}

/** A carried slot (#1441) as listed: its slot and the agent it is kept for. */
export interface CarriedRow {
  slot: string
  agent: { id: string; name: string }
}

/** A held writer (#1506) as listed: the window's question's facts, with its agent's name. */
export type HeldRow = HeldWriter & { agentName: string }

/** What a project has to release: carried slots, and writers held (those the window offers Release for). */
export interface Releasable {
  carried: CarriedRow[]
  held: HeldRow[]
}

export type ReleaseKind = 'carried' | 'writer'

/** What a release did. */
export interface Released {
  kind: ReleaseKind
  slot: string
  agent: { id: string; name: string }
  /** A held writer's: whether the processes Hive listed were ended first. */
  ended?: boolean
}

async function agentNames(projectPath: string): Promise<(id: string) => string> {
  const agents = projectAgents(await workspace.projectConfig(projectPath))
  return (id) => agents.find((a) => a.id === id)?.name ?? id
}

/** A project's carried slots and held writers, as the agents' ⋯ offer Release Slot for them. */
export async function releasableSlots(projectPath: string): Promise<Releasable> {
  const facts = await folderFacts(projectPath)
  const name = await agentNames(projectPath)
  const carried = facts.slots.filter((s) => s.open?.kind === 'carried').map((s) => ({ slot: s.name, agent: { id: s.open!.agent, name: name(s.open!.agent) } }))
  const held: HeldRow[] = []
  for (const s of facts.slots.filter((x) => x.writer)) {
    const w = await heldWriter(projectPath, s.name)
    if (w && !w.live && (w.hive.self || w.hive.alive === false)) held.push({ ...w, agentName: name(w.agent) })
  }
  return { carried, held }
}

/**
 * Releases `slot`: its carried lease (`carried`), or its held writer (`writer`), which needs `confirm` naming the slot
 * and the run the user was shown, and with `end` ends what Hive lists of that run's processes first. `kind` may be left
 * out when the slot has only one of them. `guard`: the Assistant's change boundary (Control, its session), run again just
 * before processes are ended and inside the write that ends the lease or clears the writer, so a change it no longer
 * allows by then changes nothing.
 */
export async function releaseSlot(ws: WorkspaceService, projectPath: string, slot: string, o: { kind?: ReleaseKind; confirm?: { slot?: unknown; run?: unknown } | null; end?: boolean; guard?: () => void }): Promise<Released> {
  const facts = await folderFacts(projectPath)
  const s = facts.slots.find((x) => x.name.toLowerCase() === slot.toLowerCase())
  if (!s) throw new SlotReleaseRefused(404, `No slot ${slot} in this project${facts.slots.length ? ` (its slots: ${facts.slots.map((x) => x.name).join(', ')})` : ''}.`)
  const name = await agentNames(projectPath)
  const carried = s.open?.kind === 'carried' ? s.open.agent : null
  const kinds: ReleaseKind[] = [...(carried ? ['carried' as const] : []), ...(s.writer ? ['writer' as const] : [])]
  const kind = o.kind ?? (kinds.length === 1 ? kinds[0] : undefined)
  if (!kinds.length) throw new SlotReleaseRefused(409, `${s.name} has nothing to release: it is kept for no agent and no run holds it.`)
  if (!kind) throw new SlotReleaseRefused(400, `${s.name} is both kept for ${name(carried!)} (kind: carried) and held by a run (kind: writer): say which to release.`)
  if (kind === 'carried') {
    if (!carried) throw new SlotReleaseRefused(409, `${s.name} isn't kept for an agent (no carried lease).`)
    if (!(await releaseCarried(ws, projectPath, carried, o.guard))) throw new SlotReleaseRefused(409, `${s.name} changed meanwhile: it is no longer kept for ${name(carried)}. Look again.`)
    return { kind, slot: s.name, agent: { id: carried, name: name(carried) } }
  }
  const w = await heldWriter(projectPath, s.name)
  if (!w) throw new SlotReleaseRefused(409, `${s.name} changed meanwhile: no run holds it now. Look again.`)
  // The user's confirmation of what they were shown: this slot and this run, never a guess.
  const run = typeof o.confirm?.run === 'string' ? o.confirm.run : ''
  const named = typeof o.confirm?.slot === 'string' ? o.confirm.slot : ''
  if (!run || named.toLowerCase() !== s.name.toLowerCase()) throw new SlotReleaseRefused(400, `Releasing ${s.name}'s writer needs confirm: { slot: "${s.name}", run: "<its run>" }, the slot and run the user agreed to release (list shows them).`)
  await releaseHeldWriter(projectPath, s.name, run, { end: o.end === true, ...(o.guard ? { guard: o.guard } : {}) })
  return { kind, slot: s.name, agent: { id: w.agent, name: name(w.agent) }, ended: o.end === true && !!w.processes?.list.length }
}
