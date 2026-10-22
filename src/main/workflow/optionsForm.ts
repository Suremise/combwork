// P4's plain workflow options form (#1278, SPEC §16.19: operable without the Assistant and before the Version Control
// tab): a project's options as the Workflow section of Project Settings shows them, what saving a change would do
// (§16.6.5's warning: its problems, what it changes, the lanes and cards in flight that keep the old rules), and the save
// itself, checked again under the project's lock. The user may apply a change to cards in flight (§16.11.4, OP-38):
// each gets an Override naming the options changed, carrying the new ruleset, which the card works under from then on.
// Also the one-time notice offering the presets after the upgrade (§16.17, OP-22).

import { existsSync } from 'original-fs'
import { readFile } from 'original-fs/promises'
import { join } from 'path'
import { ADOPTION_UPTO, boardState, boardValue, boardWrite, setBoardValue } from '../boardStore'
import { config } from '../config'
import { HiveError } from '../hiveError'
import { listLanes } from '../lanes'
import { createLogger, userText } from '../logger'
import * as G from '../platform/git'
import type { Text } from '../../shared/advanced'
import { allOff, NAME_OPTIONS, PRESETS, preset, type PresetId, type PresetInputs, type WorkflowOptions } from '../../shared/workflow/options'
import { writeWorkflow } from '../../shared/workflow/projectWorkflow'
import { keptStageName, stagesOf } from '../../shared/workflow/stages'
import type { PlatformId } from '../../shared/platform/descriptors'
import type { ProjectStages, WorkflowChange, WorkflowCheck, WorkflowForm, WorkflowProblem } from '../../shared/types'
import { compile, mustCompile } from '../../shared/workflow/compile'
import type { WorkspaceService } from '../workspace'
import { FactStore } from './factStore'
import { checkOptions, problemText, problemShownOf, resolvedOf, resolveOptions, workflowChanged, type OptionLevels } from './rulesets'
import { workflowEnforced, workflowFor } from './service'
import { APPLY_OPTIONS } from './runtime'
import { queueChanged } from './queueHost'
import { isUnknown } from '../platform/types'

const log = createLogger('workflow')

/** board_meta's record that the presets notice was answered (§16.17): shown once per workspace. */
export const PRESETS_NOTICE_KEY = 'workflow.presetsNotice'

/** The stages a card in flight is in: started, not yet Done (or parked). */
const IN_FLIGHT = new Set(['active', 'review', 'approved', 'merging'])

/** A project of the workspace by its folder, with its platform (the Assistant's home has none). */
function projectOf(ws: WorkspaceService, projectPath: string): { path: string; name: string; platform: PlatformId } {
  const p = ws.info()?.projects.find((x) => x.path.toLowerCase() === projectPath.toLowerCase())
  if (!p?.platform) throw new HiveError({ lines: [`${projectPath} isn't a project of this workspace`] }, { kind: 'notFound' }) // i18n-ignore: a mistake in a caller, never the window's
  return { path: p.path, name: p.name, platform: p.platform.id }
}

const levelsOf = (ws: WorkspaceService, own: Partial<WorkflowOptions> | null): OptionLevels => ({ global: config.settings.workflow, workspace: ws.config.workflow, project: own })

/** The options the project sets itself, for its platform (a project's options for another platform don't apply). */
const ownOf = (cfg: { workflow?: { platform: PlatformId; options: Partial<WorkflowOptions> } }, platform: PlatformId): Partial<WorkflowOptions> => (cfg.workflow?.platform === platform ? cfg.workflow.options : {})

/**
 * What a preset fills in from the project (OP-24: suggested from its scripts, never guessed silently, and shown in the
 * form before it is saved): `typecheck` and `lint` as the quick checks and `test` as the tests, when its package.json
 * has them, the commit identity its git config has (G12), and its default branch as Pair's and Team's target (G7).
 */
export async function presetInputs(projectPath: string, platform: PlatformId): Promise<PresetInputs> {
  const scripts: Record<string, unknown> = {}
  const pkg = join(projectPath, 'package.json')
  if (existsSync(pkg)) {
    try {
      const v = JSON.parse(await readFile(pkg, 'utf8')) as { scripts?: Record<string, unknown> }
      if (v && typeof v.scripts === 'object' && v.scripts) Object.assign(scripts, v.scripts)
    } catch (e) {
      log.warn(`reading the scripts of ${userText(pkg)} for the presets`, e)
    }
  }
  const has = (n: string): boolean => typeof scripts[n] === 'string'
  const quick = ['typecheck', 'lint'].filter(has)
  const tests = has('test') ? ['test'] : []
  const commands = Object.fromEntries([...quick.map((n) => [n, `npm run ${n}`]), ...tests.map((n) => [n, 'npm test'])]) // i18n-ignore: commands, run as written
  if (platform !== 'git') return { quick, tests, commands, identity: null }
  const target = await G.defaultBranch(projectPath).catch(() => null)
  return { quick, tests, commands, identity: await G.identity(projectPath).catch(() => null), ...(typeof target === 'string' ? { target } : {}) }
}

/** The project's options as the Workflow section shows them. */
export async function workflowForm(ws: WorkspaceService, projectPath: string): Promise<WorkflowForm> {
  const project = projectOf(ws, projectPath)
  const cfg = await ws.projectConfig(project.path)
  const own = ownOf(cfg, project.platform)
  const levels = levelsOf(ws, own)
  const below = resolveOptions(project.platform, { ...levels, project: null })
  const now = checkOptions(project.platform, levels)
  const inputs = await presetInputs(project.path, project.platform)
  return {
    platform: project.platform,
    preset: cfg.workflow?.platform === project.platform ? cfg.workflow.preset : null,
    own,
    // A project's options that can't be used work as all-off (rulesets.ts): shown so, with why.
    options: now.problems.length ? resolveOptions(project.platform, levels).options : now.resolved.options,
    origins: now.problems.length ? resolveOptions(project.platform, levels).origins : now.resolved.origins,
    invalid: now.problems.length ? now.problems.map(problemEnglish).join(' ') : null,
    inherited: below.options,
    inheritedOrigins: below.origins,
    presets: PRESETS[project.platform].map((p) => ({ ...p, options: preset(project.platform, p.id, inputs) })),
    identity: inputs.identity ?? null,
    enforced: workflowEnforced()
  }
}

/**
 * The project's options for agents (`hive_project_status`, lean): the options in force, and which of them the project,
 * the workspace or Hive's settings set (the rest are the platform's all-off). `invalid`: why they work as all-off.
 */
export async function workflowSummary(ws: WorkspaceService, projectPath: string): Promise<Record<string, unknown> | null> {
  const p = ws.info()?.projects.find((x) => x.path.toLowerCase() === projectPath.toLowerCase())
  if (!p?.platform) return null
  const cfg = await ws.projectConfig(p.path)
  const r = resolvedOf(ws, p.path, p.platform.id, cfg)
  const from: Record<string, string[]> = {}
  for (const [k, o] of Object.entries(r.origins)) if (o !== 'platform' && k !== 'platform') (from[o] ??= []).push(k)
  const { platform, stageNames, ...options } = r.options
  // The stages the board shows, each with its category id (what agents move cards by) and the user's name for it (#1417).
  const compiled = compile(r.options)
  const stages = stagesOf(compiled.ok ? compiled.ruleset : mustCompile(allOff(platform)), stageNames).map((s) => ({ id: s.id, category: s.category, name: s.name }))
  return { platform, preset: cfg.workflow?.platform === platform ? cfg.workflow.preset : null, enforced: workflowEnforced(), options, stages, setBy: from, ...(r.invalid ? { invalid: r.invalid } : {}) }
}

/**
 * The project's stages as its options in force produce them (§16.5.2), and its own names for them (N5): what the board
 * and the other views name stages by (#1417). Null while its version control isn't recorded.
 */
export async function projectStages(ws: WorkspaceService, projectPath: string): Promise<ProjectStages | null> {
  const p = ws.info()?.projects.find((x) => x.path.toLowerCase() === projectPath.toLowerCase())
  if (!p?.platform) return null
  const cfg = await ws.projectConfig(p.path)
  const r = resolvedOf(ws, p.path, p.platform.id, cfg)
  const compiled = compile(r.options)
  return { stages: compiled.ok ? compiled.ruleset.stages : mustCompile(allOff(p.platform.id)).stages, names: r.options.stageNames ?? {} }
}

/** A problem in English (the Assistant's tools, the log). */
export const problemEnglish = (p: WorkflowProblem): string => problemText(p)

/** A problem as text for the window (its message, in the user's language), or its English reason. */
export const problemShown = (p: WorkflowProblem): Text => problemShownOf(p)

/** Checks a change's shape (it comes from the window or the API): a preset id and an object of options. */
function shapeOf(change: unknown): WorkflowChange {
  const c = change as Partial<WorkflowChange> | null
  const presets: (PresetId | null)[] = ['solo', 'pair', 'team', 'pairAgent', null]
  if (!c || typeof c !== 'object' || !presets.includes(c.preset ?? null) || !c.options || typeof c.options !== 'object' || Array.isArray(c.options)) throw new HiveError({ lines: ['A workflow change is { preset, options }'] }, { kind: 'invalid' }) // i18n-ignore: a mistake in a caller, never the window's
  return { preset: c.preset ?? null, options: keptNames(c.options) }
}

/** Options with each stage name (N5) as it is kept: trimmed. */
export function keptNames<T extends Partial<WorkflowOptions>>(options: T): T {
  const names = options.stageNames
  if (!names || typeof names !== 'object' || Array.isArray(names)) return options
  return { ...options, stageNames: Object.fromEntries(Object.entries(names).map(([k, v]) => [k, typeof v === 'string' ? keptStageName(v) : v])) }
}

/** Whether a change of these options applies at once (#1417): only names (N5) changed, which aren't rules. */
export const namesOnly = (changed: readonly (keyof WorkflowOptions)[]): boolean => changed.length > 0 && changed.every((k) => (NAME_OPTIONS as readonly string[]).includes(k))

/** The options a save would set, their problems, and what changes from the options in force now. */
function changeOf(ws: WorkspaceService, platform: PlatformId, current: Partial<WorkflowOptions>, change: WorkflowChange) {
  const before = checkOptions(platform, levelsOf(ws, current))
  const after = checkOptions(platform, levelsOf(ws, change.options))
  const was = before.problems.length ? resolveOptions(platform, levelsOf(ws, current)).options : before.resolved.options
  const changed = (Object.keys(after.resolved.options) as (keyof WorkflowOptions)[]).filter((k) => JSON.stringify(after.resolved.options[k]) !== JSON.stringify(was[k]))
  return { problems: after.problems, changed, options: after.resolved.options }
}

/** The project's cards in flight now: started this cycle and not Done. */
async function cardsInFlight(ws: WorkspaceService, project: { path: string; name: string }): Promise<{ number: number; title: string }[]> {
  const wf = await workflowFor(ws, project.path)
  if (!wf) return []
  const store = FactStore.forBoard(ws, { project: project.name, key: project.name })
  return store
    .cards()
    .filter((c) => {
      const s = wf.state(c)
      return !!s.started && IN_FLIGHT.has(s.stage)
    })
    .map((c) => ({ number: c.id, title: c.title }))
}

/** What saving a change would do (§16.6.5's warning), before it is saved. */
export async function checkWorkflowChange(ws: WorkspaceService, projectPath: string, raw: unknown): Promise<WorkflowCheck> {
  const project = projectOf(ws, projectPath)
  const change = shapeOf(raw)
  const cfg = await ws.projectConfig(project.path)
  const c = changeOf(ws, project.platform, ownOf(cfg, project.platform), change)
  // Names alone (N5) aren't rules: they apply at once, so no lane or card keeps old rules over them.
  const appliesNow = namesOnly(c.changed)
  const lanes = appliesNow ? [] : (await listLanes(ws, { project: project.name })).filter((l) => l.state === 'active' || l.state === 'paused')
  return { problems: c.problems, changed: c.changed, appliesNow, lanes: lanes.map((l) => ({ id: l.id, name: l.name, builder: l.builder.name })), inFlight: c.changed.length && !appliesNow ? await cardsInFlight(ws, project) : [] }
}

/** Options that can't be saved: refused with every reason, each a whole sentence of its own (in the window's language there). */
export class WorkflowRefused extends HiveError {
  constructor(readonly problems: WorkflowProblem[]) {
    super({ lines: problems.map(problemShown) }, { kind: 'invalid' })
  }
}

/**
 * Saves a change to a project's options: checked again under the project's lock (the window's check may be stale), and
 * refused whole with its reasons. `applyTo`: the user's cards in flight to work under the new options from now, each
 * recorded with an Override naming what changed (OP-38: the user only, per change, the cards listed first). Returns the
 * form as it is now.
 */
export async function setWorkflowOptions(ws: WorkspaceService, projectPath: string, raw: unknown, o: { applyTo?: number[] } = {}): Promise<WorkflowForm> {
  const project = projectOf(ws, projectPath)
  const change = shapeOf(raw)
  let changed: (keyof WorkflowOptions)[] = []
  await ws.mutateProjectConfig(project.path, (cfg) => {
    const c = changeOf(ws, project.platform, ownOf(cfg, project.platform), change)
    if (c.problems.length) throw new WorkflowRefused(c.problems)
    changed = c.changed
    const options = Object.fromEntries(Object.entries(change.options).filter(([k, v]) => k !== 'platform' && v !== undefined))
    return { workflow: writeWorkflow(cfg.workflow, { platform: project.platform, preset: change.preset, options }) }
  })
  log.info(`the workflow options of ${userText(project.name)} changed: ${changed.join(', ') || 'none'}`)
  workflowChanged(ws, project.path)
  // Names alone change no card's rules (#1417): nothing to apply to cards in flight, nor any queue to read again.
  if (namesOnly(changed)) return workflowForm(ws, project.path)
  const applyTo = [...new Set(o.applyTo ?? [])]
  if (applyTo.length && changed.length) await applyToInFlight(ws, project, applyTo, changed)
  // Whether Hive merges, and into what, may have changed: the windows read the project's queues again (#1356: which
  // show follows the options too), whoever changed them (the window, the Assistant).
  if (changed.length) {
    const t = change.options.target || (await G.defaultBranch(project.path).catch(() => null))
    queueChanged(ws, project.path, t && !isUnknown(t) ? t : '')
  }
  return workflowForm(ws, project.path)
}

/** The user applies the options now in force to cards in flight: an Override on each that is still in flight. */
async function applyToInFlight(ws: WorkspaceService, project: { path: string; name: string }, cards: number[], changed: (keyof WorkflowOptions)[]): Promise<void> {
  const wf = await workflowFor(ws, project.path)
  if (!wf) return
  const store = FactStore.forBoard(ws, { project: project.name, key: project.name })
  await boardWrite(ws, async () => {
    const ruleset = wf.currentRuleset()
    store.tx((tx) => {
      for (const n of cards) {
        const card = store.cards().find((c) => c.id === n)
        const s = card ? wf.state(card) : null
        // Only its own project's, and only while it is still in flight.
        if (!card || !s?.started || !IN_FLIGHT.has(s.stage)) continue
        tx.append(n, { kind: 'Override', actor: 'user', source: 'recorded', ruleset: ruleset.id, data: { rules: changed.map((k) => `option.${k}`), move: APPLY_OPTIONS, by: 'user', reason: '' } }) // i18n-ignore: a fact's kind and data, never shown as text
      }
    })
  })
}

/**
 * The one-time presets notice (§16.17, OP-22): after the upgrade from 0.9, the projects that kept today's way of working
 * (options the upgrade wrote, no preset chosen), until the user answers it once. Never on a board made by 1.0 (no card
 * from before it), nor while the upgrade waits.
 */
export async function presetsNotice(ws: WorkspaceService): Promise<{ path: string; name: string }[] | null> {
  if (!ws.path || boardState(ws).readOnly !== null) return null
  if (boardValue(ws, PRESETS_NOTICE_KEY) !== null || !(Number(boardValue(ws, ADOPTION_UPTO) ?? 0) > 0)) return null
  const out: { path: string; name: string }[] = []
  for (const p of ws.info()?.projects ?? []) {
    const cfg = await ws.projectConfig(p.path).catch(() => null)
    if (cfg?.workflow && cfg.workflow.preset === null) out.push({ path: p.path, name: p.name })
  }
  return out.length ? out : null
}

/** The presets notice was answered (Choose… or Not now): never shown again in this workspace. */
export async function presetsNoticeSaid(ws: WorkspaceService): Promise<void> {
  await boardWrite(ws, async () => setBoardValue(ws, PRESETS_NOTICE_KEY, new Date().toISOString()))
}
