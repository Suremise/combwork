// HI-2680 (SPEC §16.5.4): when a project's Work merges into moves on (a release shipped: 1.1.0 → 1.2.0), what still
// points at the finished branch, and what can follow the new one. A preview first, read-only: the Todo cards whose own
// target is the finished branch with no work of their own, and the free slots recording it that are clean with nothing
// the finished branch lacks; what stays, and why (work, started, lent, changes, unmerged; running lanes are never
// rewritten). Then the apply, bound to that preview: each item moved only as it was seen, rechecked under its own lock
// (a card's in `tasks.setTarget`'s board lock with its expected target; a slot's in the pool's own operation), with the
// project's target still the new one and the caller's authority checked before each. Never all or nothing: each item
// says what happened to it.

import { existsSync } from 'original-fs'
import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import type { WorkspaceService } from '../workspace'
import type { TaskActor } from '../tasks'
import { cardKeys } from '../boardStore'
import { cardLabel } from '../../shared/projectKeys'
import { listLanes } from '../lanes'
import { projectAgents } from '../../shared/defaults'
import { targetOfRulesetId } from '../../shared/workflow/compile'
import { workflowFor } from './service'
import { hasOwnWork, projectTargets } from './targets'
import type { RetargetPreview, RetargetResult } from '../../shared/types'
import { combworkError } from '../combworkError'
import { fmt, msg } from '../../shared/i18n'

/** Where a card in flight, a Todo card and a lane stand (codes the window and the tools say in words). */
type KeepWhy = RetargetPreview['cards']['keep'][number]['why']

/**
 * What a change of Work merges into from `from` to `to` would move, and what stays with why (HI-2680), read-only. Slots
 * recording none count as `from`'s when it is the project's target they fell back to (the preview is made while it is).
 */
export async function retargetPreview(ws: WorkspaceService, projectPath: string, from: string, to: string): Promise<RetargetPreview> {
  const out: RetargetPreview = { from, to, cards: { move: [], keep: [] }, slots: { move: [], keep: [] }, lanes: [] }
  const wf = await workflowFor(ws, projectPath)
  if (!wf || from === to) return out
  const store = wf.store
  const cards = store.cards()
  const keys = cardKeys(ws, cards.map((c) => c.id))
  const row = (c: (typeof cards)[number]) => ({ number: c.id, key: cardLabel({ number: c.id, key: keys.get(c.id) }), title: c.title })
  for (const c of cards) {
    const s = wf.state(c)
    if (s.stage === 'done') continue
    const own = c.target ?? null
    // Started on it: fixed until Done (HI-2674), whatever its own target says.
    if (s.stage !== 'todo' && s.stage !== 'hold' && s.started?.target === from) {
      out.cards.keep.push({ ...row(c), why: 'started' }) // i18n-ignore: a reason's code, said in words where it is shown
      continue
    }
    if (own !== from) continue
    const w = await hasOwnWork(projectPath, s, wf.folderOf(s))
    if (w === false) out.cards.move.push(row(c))
    else out.cards.keep.push({ ...row(c), why: (w === 'unknown' ? 'cantCheck' : 'work') as KeepWhy }) // i18n-ignore: a reason's code, said in words where it is shown
  }
  for (const l of (await listLanes(ws, { project: wf.store.scope.project })).filter((x) => x.state === 'active' || x.state === 'paused')) {
    const rec = wf.lane(l.id)
    const t = rec?.ruleset ? (targetOfRulesetId(rec.ruleset) ?? store.ruleset(rec.ruleset).options.target ?? null) : null
    if ((t || null) === from) out.lanes.push({ id: l.id, name: l.name, builder: l.builder.name })
  }
  const { poolFor } = await import('../slotsApp')
  const pool = await poolFor(ws, projectPath).catch(() => null)
  const fromHead = await G.lineHead(projectPath, from)
  for (const s of pool ? pool.deps.store.slots() : []) {
    if ((s.target ?? from) !== from) continue
    const keep = (why: RetargetPreview['slots']['keep'][number]['why']) => out.slots.keep.push({ name: s.name, why })
    if (s.state !== 'ready') {
      keep(s.state === 'lent' ? 'lent' : s.state === 'dirty' ? 'dirty' : 'busy')
      continue
    }
    if (s.op || s.job || s.writer || pool!.deps.store.openLease(s.name)) {
      keep('busy')
      continue
    }
    if (!existsSync(s.folder) || isUnknown(fromHead) || !fromHead) {
      keep('cantCheck')
      continue
    }
    const d = await G.dirty(s.folder)
    const h = await G.head(s.folder)
    if (isUnknown(d) || isUnknown(h) || !h) {
      keep('cantCheck')
      continue
    }
    if (d.length) {
      keep('dirty')
      continue
    }
    const inIt = h === fromHead || (await G.isAncestor(projectPath, h, fromHead))
    if (inIt !== true) {
      keep(isUnknown(inIt) ? 'cantCheck' : 'unmerged')
      continue
    }
    out.slots.move.push({ name: s.name, folder: s.folder, target: s.target ?? null, head: h })
  }
  return out
}

/**
 * Moves what a confirmed preview listed (HI-2680), each only as it was seen: a card from `from` (its own target as
 * expected, under the board's lock: `tasks.setTarget`'s), a slot from its recorded target, folder and head (the pool's
 * retarget). Before each, the project's target must still be `to` (else the rest stops: "the target changed
 * meanwhile") and `still()` (the caller's authority) must hold (else the rest stops). What happened to each is said.
 */
export async function retargetApply(ws: WorkspaceService, projectPath: string, preview: Pick<RetargetPreview, 'from' | 'to' | 'cards' | 'slots'>, actor: TaskActor, still: () => void = () => undefined): Promise<RetargetResult> {
  const { from, to } = preview
  const out: RetargetResult = { from, to, moved: { cards: [], slots: [] }, skipped: [] }
  const targetNow = async (): Promise<boolean> => (await projectTargets(ws, projectPath).catch(() => null))?.default === to
  const allowed = (): boolean => {
    try {
      still()
      return true
    } catch {
      return false
    }
  }
  let stop: 'targetChanged' | 'refused' | null = null
  const { setTarget } = await import('../tasks')
  for (const c of preview.cards.move) {
    if (!stop && !(await targetNow())) stop = 'targetChanged'
    if (!stop && !allowed()) stop = 'refused'
    if (stop) {
      out.skipped.push({ card: c.number, key: c.key, why: stop })
      continue
    }
    try {
      await setTarget(c.number, to, actor, { commit: still, expect: from })
      out.moved.cards.push({ number: c.number, key: c.key })
    } catch (e) {
      out.skipped.push({ card: c.number, key: c.key, why: 'changed', detail: (e as Error).message }) // i18n-ignore: a reason's code, said in words where it is shown
    }
  }
  const { poolFor } = await import('../slotsApp')
  const pool = preview.slots.move.length ? await poolFor(ws, projectPath) : null
  for (const s of preview.slots.move) {
    if (!stop && !(await targetNow())) stop = 'targetChanged'
    if (!stop && !allowed()) stop = 'refused'
    if (stop || !pool) {
      out.skipped.push({ slot: s.name, why: stop ?? 'changed' }) // i18n-ignore: a reason's code, said in words where it is shown
      continue
    }
    const end = await pool.retarget(s.name, { folder: s.folder, target: s.target, head: s.head }, from, to, async () => allowed() && (await targetNow()))
    if (end.kind === 'moved') out.moved.slots.push(s.name)
    else if (end.kind === 'kept') out.skipped.push({ slot: s.name, why: end.why === 'refused' ? 'refused' : end.why === 'changed' ? 'changed' : end.why, ...(end.detail ? { detail: end.detail } : {}) }) // i18n-ignore: a reason's code, said in words where it is shown
    else out.skipped.push({ slot: s.name, why: end.state === 'gone' ? 'gone' : 'setAside', ...(end.detail ? { detail: end.detail } : {}) }) // i18n-ignore: a reason's code, said in words where it is shown
  }
  return out
}

/**
 * What still records `branch` (HI-2680: a finished target taken out of Other branches work can merge into): running
 * lanes on it, cards in flight started on it, cards whose own target it is, open queue entries for it, and slots
 * recording it. Read as the board is; the save's guard reads it inside its board write.
 */
export async function referencesTo(ws: WorkspaceService, projectPath: string, branch: string, slots?: readonly { name: string; target: string | null }[]): Promise<string[]> {
  const wf = await workflowFor(ws, projectPath)
  if (!wf) return []
  const out: string[] = []
  const cards = wf.store.cards()
  const keys = cardKeys(ws, cards.map((c) => c.id))
  for (const c of cards) {
    const s = wf.state(c)
    if (s.stage === 'done') continue
    const named = (c.target ?? null) === branch || (s.stage !== 'todo' && s.started?.target === branch) || s.entries.some((e) => (e.state === 'open' || e.state === 'started') && e.target === branch)
    if (named) out.push(cardLabel({ number: c.id, key: keys.get(c.id) }))
  }
  // The runtime's own lane records (board reads): never lanes.ts's listing, whose views wait on the board's lock.
  const names = new Map(projectAgents(await ws.projectConfig(projectPath)).map((a) => [a.id, a.name] as const))
  for (const id of wf.store.runningLanes()) {
    const rec = wf.lane(id)
    if (!rec || rec.ended || !rec.ruleset || targetOfRulesetId(rec.ruleset) !== branch) continue
    const builder = wf.store.laneBuilder(id)
    out.push(builder ? (names.get(builder) ?? builder) : id)
  }
  for (const s of slots ?? (await slotTargets(ws, projectPath))) if (s.target === branch) out.push(s.name)
  return out
}

/**
 * The project's slots and the target each records (HI-2680), read from its pool: before a save takes its locks (the
 * pool keeps its own connection to the board's database, never opened inside the board's write).
 */
export async function slotTargets(ws: WorkspaceService, projectPath: string): Promise<{ name: string; target: string | null }[]> {
  const { poolFor } = await import('../slotsApp')
  const pool = await poolFor(ws, projectPath).catch(() => null)
  return pool ? pool.deps.store.slots().map((s) => ({ name: s.name, target: s.target ?? null })) : []
}

/** A preview as the window sends it back (HI-2680): its shape checked, item by item; anything else refused. */
export function retargetArg(raw: unknown): RetargetPreview {
  const r = raw as Partial<RetargetPreview> | null
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 250
  const ok =
    !!r &&
    str(r.from) &&
    str(r.to) &&
    Array.isArray(r.cards?.move) &&
    r.cards!.move.every((c) => Number.isInteger(c?.number) && typeof c.key === 'string') &&
    Array.isArray(r.slots?.move) &&
    r.slots!.move.every((s) => str(s?.name) && str(s.folder) && (s.target === null || str(s.target)) && str(s.head))
  if (!ok) throw new Error('A retarget is a preview: from, to, cards.move and slots.move') // i18n-ignore: a mistake in a caller, never the window's
  return { from: r!.from!, to: r!.to!, cards: { move: r!.cards!.move, keep: [] }, slots: { move: r!.slots!.move, keep: [] }, lanes: [] }
}

const IN_USE = msg({ id: 'service.workflow.targetInUse', defaultMessage: '{branch} can’t be taken out of Other branches work can merge into while these use it: {uses}. Retarget or finish them first.', description: 'HI-2680: a save of workflow options refused: it takes a branch out of Other branches work can merge into while cards, lanes, queue entries or slots still use it ({uses}: their keys and names). Other branches work can merge into is the option’s name: as translated there.' })

/**
 * HI-2680: refused when a save takes a branch out of the project's Other branches work can merge into (`before` → `after`,
 * the new default not counted) while anything still records it (`referencesTo`). Called inside the save's board write,
 * which every writer of those references (card targets and starts, enqueues, lane lists) takes too: serial with them.
 */
export async function refuseRemovedTargets(ws: WorkspaceService, projectPath: string, before: readonly string[], after: readonly string[], keep: string | null, slots: readonly { name: string; target: string | null }[]): Promise<void> {
  for (const branch of before.filter((b) => !after.includes(b) && b !== keep)) {
    const uses = await referencesTo(ws, projectPath, branch, slots)
    if (uses.length) throw combworkError(IN_USE, { branch, uses: fmt.list(uses) }, { kind: 'conflict' })
  }
}
