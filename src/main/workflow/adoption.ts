// The upgrade's adoption (#1218, SPEC §16.17 "Old cards" and "Options at the upgrade"): after the 1.0 migration
// commits, the "idempotent observations" half of the one upgrade. Each project gets options matching how it works
// today (its platform recorded, `workflow` in project.json, the compiled ruleset stored); every card that has no facts
// yet is either marked as from before 1.0 (Done, On Hold, Todo, archived: `pre_workflow`, no facts) or, in flight
// (Doing, Review, Passed), adopted: `Adopted` (and a Review card's adopted `Submitted`) from what its folder shows now.
//
// Only the cards from before 1.0 (board_meta ADOPTION_UPTO, recorded in the upgrade's transaction): a board made by 1.0
// has none, and a card made since is never marked. Safe to repeat: run at each workspace open until it has finished
// once (board_meta `adoption`), and right after the upgrade. Each card is checked again inside the board change that
// writes it, against how it was classified and read: one started, adopted or marked meanwhile (another Hive, a rerun)
// is left as it is, and one changed meanwhile (moved, given another agent or folder) is classified again from fresh
// data by another run, its stale reads never written. Nothing moves on the board and nothing is refused (S53).

import { basename } from 'path'
import { compile } from '../../shared/workflow/compile'
import { agentWorkflowRole, reviewsWork } from '../../shared/workflow/roles'
import { legacyWorktree } from '../../shared/agentFolders'
import type { StageId } from '../../shared/workflow/facts'
import type { ProjectConfig } from '../../shared/types'
import type { PlatformId } from '../../shared/platform/descriptors'
import { ADOPTION_UPTO, adoptionCardNow, adoptionCards, boardValue, boardWrite, markPreWorkflow, setBoardValue, upgradeWaiting, type AdoptionCard } from '../boardStore'
import { coalesced } from '../coalesce'
import { listLanes } from '../lanes'
import { createLogger, userText } from '../logger'
import * as G from '../platform/git'
import { projectPlatform } from '../platform/registry'
import { isUnknown } from '../platform/types'
import type { WorkspaceService } from '../workspace'
import { resolvedOf } from './rulesets'
import { FactStore } from './factStore'
import { adoptionInputs, upgradeOptions, writeAdoption, type AdoptionAt, type AdoptionInputs, type InFlight } from './upgrade'

const log = createLogger('workflow')

/** board_meta's mark that a workspace's adoption has finished (every card handled once). */
const DONE_KEY = 'adoption'

/** The columns of cards in flight at the upgrade. */
const IN_FLIGHT = new Set<string>(['doing', 'review', 'passed'])


export interface AdoptionResult {
  /** Cards adopted (in flight). */
  adopted: number
  /** Cards marked as from before 1.0. */
  marked: number
  /** Projects whose options were recorded. */
  configured: number
  /** Cards that couldn't be handled (an error: tried again at the next start). */
  failed: number
  /** Cards that changed between their classification and their write: classified again by another run. */
  changed: number
}

/** How many runs one adoption makes while cards change under it, before leaving the rest for the next start. */
const RUNS = 3

/** Runs a workspace's adoption, one at a time per workspace (a second call while one runs waits for it). */
export function adoptWorkspace(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  if (!path) return Promise.resolve()
  return coalesced(`adoption:${path.toLowerCase()}`, async () => {
    try {
      for (let run = 1; run <= RUNS; run++) {
        const r = await adoptNow(ws)
        if (r && (r.adopted || r.marked || r.configured || r.failed || r.changed)) log.info(`1.0 adoption in ${userText(path)}: ${r.adopted} card(s) in flight adopted, ${r.marked} marked as from before 1.0, ${r.configured} project(s) given their options${r.failed ? `, ${r.failed} failed (tried again at the next start)` : ''}${r.changed ? `, ${r.changed} changed meanwhile (${run < RUNS ? 'read again now' : 'tried again at the next start'})` : ''}`)
        if (!r?.changed || r.failed) return
      }
    } catch (e) {
      log.warn(`adopting the cards of ${userText(path)} (tried again at the next start)`, e)
    }
  })
}

/** The adoption itself; null when there is nothing to do (the upgrade waits, or it finished before). */
export async function adoptNow(ws: WorkspaceService): Promise<AdoptionResult | null> {
  const path = ws.path
  if (!path || upgradeWaiting(path) || boardValue(ws, DONE_KEY) !== null) return null
  // The workspace as it was when the run began: once it closes, or its window opens another, the run stops (checked
  // after each wait, and inside each board change before the board is touched), never writing another workspace's.
  const life = ws.lifetime
  const alive = (): boolean => !life.aborted && ws.lifetime === life && ws.path === path
  const write = <T>(fn: () => T): Promise<T> => boardWrite(ws, async () => fn(), { alive })
  const out: AdoptionResult = { adopted: 0, marked: 0, configured: 0, failed: 0, changed: 0 }
  const cards = adoptionCards(ws, Number(boardValue(ws, ADOPTION_UPTO) ?? 0)).filter((c) => !c.facts && !c.preWorkflow)
  // Projects by their name on the board (the cards' `project`), with their folder: hidden ones too (their cards stay).
  const folders = new Map<string, string>()
  for (const p of [...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))]) folders.set(basename(p).toLowerCase(), p)
  const lanes = await listLanes(ws, { all: true }).catch(() => [])
  if (!alive()) return null
  const byProject = new Map<string, AdoptionCard[]>()
  const toMark: AdoptionCard[] = []
  for (const c of cards) {
    const folder = c.project ? folders.get(c.project.toLowerCase()) : undefined
    // A workspace card, or a removed project's: no folder or platform to read, so from before 1.0 whatever its column.
    if (!folder || c.archived || !IN_FLIGHT.has(c.column)) toMark.push(c)
    else byProject.set(folder, [...(byProject.get(folder) ?? []), c])
  }
  // Every project from before 1.0 gets its options, cards in flight or not (the ruleset its next card starts under). One
  // made by 1.0 keeps none of the upgrade's, and asks "How do you work?" instead (#1423, §16.3.5).
  for (const folder of new Set(folders.values())) {
    const name = basename(folder)
    const r = await projectOptions(ws, folder, lanes.some((l) => l.project.toLowerCase() === name.toLowerCase()), alive)
    if (!r) return null
    if (r === MADE_BY_1_0) continue
    if (r.configured) out.configured++
    const inFlight = byProject.get(folder) ?? []
    // What each card's folder shows now: read before the board's lock (git), never inside it.
    const reads: { card: AdoptionCard; column: InFlight; at: AdoptionAt; inputs: AdoptionInputs }[] = []
    for (const c of inFlight) {
      try {
        const at = await whereItWorks(folder, r.cfg, c, r.platform)
        reads.push({ card: c, column: c.column as InFlight, at, inputs: await adoptionInputs(folder, r.platform, c.column as InFlight, at) })
      } catch (e) {
        out.failed++
        log.warn(`reading card #${c.number}'s folder for its adoption`, e)
      }
    }
    if (!alive()) return null
    await boardWrite(ws, async () => {
      // Where each agent works now, under the board's lock: a card whose agent's folder changed since it was read is read again.
      const now = await ws.projectConfig(folder)
      const store = FactStore.forBoard(ws, { project: name, key: name })
      // Resolved over the workspace's and Hive's: a project may set only some (#1278).
      const resolved = resolvedOf(ws, folder, r.platform, r.cfg)
      if (resolved.invalid) throw new Error(`the options for ${name} can't be used: ${resolved.invalid}`) // i18n-ignore: a mistake in Hive's code, logged
      const compiled = compile(resolved.options)
      if (!compiled.ok) throw new Error(`the upgrade's options for ${name} contradict each other: ${compiled.contradictions.join(', ')}`) // i18n-ignore: a mistake in Hive's code, logged
      store.saveRuleset(compiled.ruleset)
      for (const x of reads) {
        const c = adoptionCardNow(ws, x.card.number)
        // Started, adopted or marked meanwhile (another Hive, a rerun), or gone: not this run's to change.
        if (!c || c.facts || c.preWorkflow) continue
        if (c.project !== x.card.project || c.column !== x.card.column || c.archived !== x.card.archived || c.agent !== x.card.agent || placeOf(now, c.agent) !== placeOf(r.cfg, c.agent)) {
          out.changed++
          continue
        }
        store.tx((tx) => {
          const card = tx.card(x.card.number)
          // The stage its column stands for: a card no 1.0 rule has moved is at its column's already, so this writes nothing
          // unless the card's stage was set otherwise meanwhile.
          const move = (to: StageId): void => {
            if (to === card.stage) return
            tx.append(card.id, { kind: 'Moved', actor: 'combwork', source: 'recorded', ruleset: compiled.ruleset.id, data: { from: card.stage, to, cause: 'derived' } }) // i18n-ignore: a fact's kind and codes, not text
            tx.setStage(card.id, to)
          }
          if (writeAdoption(tx, card, compiled.ruleset, x.column, x.at, x.inputs, move)) out.adopted++
        })
      }
    }, { alive })
  }
  if (toMark.length) {
    const m = await write(() => markPreWorkflow(ws, toMark))
    out.marked = m.marked
    out.changed += m.changed
  }
  // Finished once every card was handled; a failure, or a card changed meanwhile, leaves it for another run.
  if (!out.failed && !out.changed) await write(() => setBoardValue(ws, DONE_KEY, JSON.stringify({ at: new Date().toISOString(), ...out })))
  return out
}

/**
 * A project's options at the upgrade (§16.17): those project.json has, else the upgrade's from how it works today
 * (its platform as recorded, else detected; a reviewer agent if it has reviewer agents or a lane; slots if an agent has
 * a worktree), written once through mutateProjectConfig with the platform recorded too (#1213's note).
 */
async function projectOptions(ws: WorkspaceService, folder: string, hasLane: boolean, alive: () => boolean): Promise<{ cfg: ProjectConfig; platform: PlatformId; configured: boolean } | typeof MADE_BY_1_0 | null> {
  const before = await ws.projectConfig(folder)
  if (before.workflow) return { cfg: before, platform: before.workflow.platform, configured: false }
  if (madeBy1_0(before)) return MADE_BY_1_0
  if (!alive()) return null
  let configured = false
  let made = false
  const cfg = await ws.mutateProjectConfig(folder, (c) => {
    // Under the lock, from the file as it is now: another Hive (or a rerun) may have written them meanwhile.
    if (c.workflow) return {}
    if (madeBy1_0(c)) {
      made = true
      return {}
    }
    configured = true
    const platform = projectPlatform(folder, c.platform).id
    const agents = c.agents ?? []
    const options = upgradeOptions(platform, { reviewers: hasLane || agents.some((a) => reviewsWork(agentWorkflowRole(a))), worktrees: agents.some((a) => !!legacyWorktree(a)) })
    // HI-1697: the merge style and commit message are asked when the queue first merges, never set silently.
    return { platform: c.platform ?? platform, workflow: { platform, preset: null, options, ...(platform === 'git' ? { mergeAsk: true as const } : {}) } }
  })
  if (made || !cfg.workflow) return MADE_BY_1_0
  return { cfg, platform: cfg.workflow.platform, configured }
}

/** A project made by 1.0, which has no options from before it to keep (#1423): its upgrade gives it none. */
const MADE_BY_1_0 = 'madeBy1.0' as const

/**
 * Whether a project was made by 1.0: Hive records its platform as it makes its project.json (§16.3.5, ensureProject),
 * which no Hive before 1.0 did. Its provenance, whatever the board (an upgraded board with no cards included, HR3's
 * #1423 round 1).
 */
const madeBy1_0 = (c: Pick<ProjectConfig, 'platform'>): boolean => c.platform !== undefined

/** The folder an agent works in, as its project's config says (its worktree and the branch it merges into, or none). */
function placeOf(cfg: ProjectConfig, agent: string | null): string {
  const wt = agent ? legacyWorktree((cfg.agents ?? []).find((a) => a.id === agent)) : null
  return wt ? JSON.stringify([wt.path, wt.base]) : ''
}

/** Where a card in flight works: its agent's worktree (merging into the branch it came from), else the project folder's line. */
async function whereItWorks(folder: string, cfg: ProjectConfig, c: AdoptionCard, platform: PlatformId): Promise<AdoptionAt> {
  const agent = c.agent ? (cfg.agents ?? []).find((a) => a.id === c.agent) : undefined
  const tree = legacyWorktree(agent)
  if (agent && tree) return { agent: agent.id, worktree: tree.path, target: tree.base }
  const line = platform === 'git' ? await G.branch(folder) : null
  return { agent: c.agent ?? 'user', target: line && !isUnknown(line) ? line : null }
}
