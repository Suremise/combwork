// P4's plain workflow options form (#1278, SPEC §16.19: operable without the Assistant and before the Version Control
// tab): a project's options as the Workflow section of Project Settings shows them, what saving a change would do
// (§16.6.5's warning: its problems, what it changes, the lanes and cards in flight that keep the old rules), and the save
// itself, checked again under the project's lock. The user may apply a change to cards in flight (§16.11.4, OP-38):
// each gets an Override naming the options changed, carrying the new ruleset, which the card works under from then on.
// Also the one-time notice offering the presets after the upgrade (§16.17, OP-22).

import { app } from 'electron'
import { existsSync } from 'original-fs'
import { readFile } from 'original-fs/promises'
import { join } from 'path'
import { ADOPTION_UPTO, boardState, boardValue, boardWrite, cardKeys, setBoardValue } from '../boardStore'
import { cardLabel } from '../../shared/projectKeys'
import { MERGE_CHOICE_GATE, MERGE_CHOICE_KEY, openEntry } from '../../shared/workflow/facts'
import { refusal } from '../../shared/workflow/refusals'
import { config } from '../config'
import { CombworkError, combworkError } from '../combworkError'
import { projectPlatform } from '../platform/registry'
import { PLATFORM_NAME, SWITCH_REFUSED } from '../../shared/platform/switching'
import { listLanes, withLanesLock } from '../lanes'
import { createLogger, userText } from '../logger'
import * as G from '../platform/git'
import { agentText, linesOf, withValues, type Text } from '../../shared/advanced'
import { msg } from '../../shared/i18n/msg'
import { tr } from '../../shared/i18n'
import { MERGE_ANSWER, OPTION_TEXT, VALUE_TEXT } from '../../shared/workflow/optionTexts'
import { allOff, BRANCH_OPTIONS, FOCUSED_PICK, FOCUSED_RUN, NAME_OPTIONS, PRESETS, preset, sameOptionValue, takesOption, type CommitMessage, type PresetId, type PresetInputs, type WorkflowOptions } from '../../shared/workflow/options'
import { setPresetAsked, writeWorkflow } from '../../shared/workflow/projectWorkflow'
import { keptStageName, stagesOf } from '../../shared/workflow/stages'
import type { PlatformId } from '../../shared/platform/descriptors'
import type { KeptTargets, RetargetPreview, ProjectConfig, ProjectStages, ProjectWorkflow, WorkflowChange, WorkflowCheck, WorkflowForm, WorkflowProblem } from '../../shared/types'
import { compile, mustCompile, type Ruleset } from '../../shared/workflow/compile'
import type { WorkspaceService } from '../workspace'
import { FactStore } from './factStore'
import { checkOptions, problemText, problemShownOf, resolvedOf, resolveOptions, workflowChanged, type OptionLevels } from './rulesets'
import { workflowEnforced, workflowFor } from './service'
import { APPLY_OPTIONS } from './runtime'
import { kickQueue, queueChanged } from './queueHost'
import { isUnknown } from '../platform/types'
import { refuseRemovedTargets, retargetPreview, slotTargets } from './retarget'
import { newlyMissing, projectTargets, refuseMissingTargets } from './targets'
import { workflowWrite } from './writes'
import { withFolderRepoLocks } from '../platform/repoPorts'
import { exitBy } from '../exitLog'
import { LEGACY_CONSUMED, legacyPreferences } from '../../shared/workflow/preferences'

const log = createLogger('workflow')

/** board_meta's record that the presets notice was answered (§16.17): shown once per workspace. */
export const PRESETS_NOTICE_KEY = 'workflow.presetsNotice'

/** The stages a card in flight is in: started, not yet Done (or parked). */
const IN_FLIGHT = new Set(['active', 'review', 'approved', 'merging'])

/** A project of the workspace by its folder, with its platform (the Assistant's home has none). */
function projectOf(ws: WorkspaceService, projectPath: string): { path: string; name: string; platform: PlatformId } {
  const p = ws.info()?.projects.find((x) => x.path.toLowerCase() === projectPath.toLowerCase())
  if (!p?.platform) throw new CombworkError({ lines: [`${projectPath} isn't a project of this workspace`] }, { kind: 'notFound' }) // i18n-ignore: a mistake in a caller, never the window's
  return { path: p.path, name: p.name, platform: p.platform.id }
}

/** The levels of a project's options; `folder` checks its place too (OP-29: inside a larger repository, #1419). */
const levelsOf = (ws: WorkspaceService, own: Partial<WorkflowOptions> | null, folder?: string): OptionLevels => ({ global: config.settings.workflow, workspace: ws.config.workflow, project: own, ...(folder ? { folder } : {}) })

/** The options the project sets itself, for its platform (a project's options for another platform don't apply). */
// A project with no options yet shows its card loops and file locks from before HI-1766 as its own (they're read so).
const ownOf = (cfg: Pick<ProjectConfig, 'workflow'>, platform: PlatformId): Partial<WorkflowOptions> => (cfg.workflow?.platform === platform ? cfg.workflow.options : cfg.workflow ? {} : legacyPreferences(cfg))

/**
 * The project config's change that sets one of a project's preferences as its own (HI-2058: a template's load sets
 * Maximum agents with its agents, in the same write), its other options and preset kept as a save keeps them. For a
 * `mutateProjectConfig` the caller holds; the windows are told by `workflowChanged` once it is written.
 */
export function ownPreferenceChange<K extends 'maxAgents'>(cfg: ProjectConfig, platform: PlatformId, key: K, value: WorkflowOptions[K]): Partial<ProjectConfig> {
  const options = { ...ownOf(cfg, platform), [key]: value }
  return { workflow: writeWorkflow(cfg.workflow, { platform, preset: cfg.workflow?.platform === platform ? cfg.workflow.preset : null, options }), ...LEGACY_CONSUMED }
}

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
  // HI-2019: a read git couldn't make is asked once more; still unread, the form shows no identity (it has no state for
  // "couldn't read", and the queue reads it again itself before a merge).
  const read = () => G.identity(projectPath).catch(() => null)
  const first = await read()
  const id = isUnknown(first) ? await read() : first
  return { quick, tests, commands, identity: isUnknown(id) ? null : id, ...(typeof target === 'string' ? { target } : {}) }
}

/** The project's options as the Workflow section shows them. */
export async function workflowForm(ws: WorkspaceService, projectPath: string): Promise<WorkflowForm> {
  const project = projectOf(ws, projectPath)
  const cfg = await ws.projectConfig(project.path)
  const own = ownOf(cfg, project.platform)
  const levels = levelsOf(ws, own, project.path)
  const below = resolveOptions(project.platform, { ...levels, project: null })
  const now = checkOptions(project.platform, levels)
  const inputs = await presetInputs(project.path, project.platform)
  // G20's commands as the project has them now (HR4's HI-1367 round 1 finding 7): Team turns G20 on with its runner, and
  // every preset keeps the project's own commands (a preset fills in its checks' commands over them, never drops them).
  const commands = (now.problems.length ? resolveOptions(project.platform, levels) : now.resolved).options.commands
  const focused = commands[FOCUSED_RUN] ? { focused: { run: commands[FOCUSED_RUN], ...(commands[FOCUSED_PICK] ? { pick: commands[FOCUSED_PICK] } : {}) } } : {}
  const offered = (id: PresetId): WorkflowOptions => {
    const o = preset(project.platform, id, { ...inputs, ...focused })
    return { ...o, commands: { ...commands, ...o.commands } }
  }
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
    presets: PRESETS[project.platform].map((p) => ({ ...p, options: offered(p.id) })),
    identity: inputs.identity ?? null,
    enforced: workflowEnforced()
  }
}

/**
 * The project's options for agents (`cw_project_status`, lean): the options in force, and which of them the project,
 * the workspace or Combwork's settings set (the rest are the platform's all-off). `invalid`: why they work as all-off.
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
  return { stages: compiled.ok ? compiled.ruleset.stages : mustCompile(allOff(p.platform.id)).stages, names: r.options.stageNames ?? {}, preset: cfg.workflow?.platform === p.platform.id ? (cfg.workflow.preset ?? null) : null }
}

const IM = {
  inheritor: msg({ id: 'service.workflow.inheritor', defaultMessage: 'Project {project} inherits these options, and the change would make its options contradict each other:', description: 'Why saving workflow defaults (Settings → Workflow defaults or Settings → Workspace) was refused: a project that inherits them would have contradictory options. The reason follows on its own line. {project} is its name.' })
}

/** A problem in English (the Assistant's tools, the log); an inheriting project's names it (#1422). */
export const problemEnglish = (p: WorkflowProblem): string => (p.kind === 'inheritor' ? `${agentText(withValues(IM.inheritor, { project: p.project }))} ${problemText(p.problem)}` : problemText(p))

/** A problem as text for the window (its message, in the user's language), or its English reason; an inheriting project's on two lines. */
export const problemShown = (p: WorkflowProblem): Text => (p.kind === 'inheritor' ? linesOf([withValues(IM.inheritor, { project: p.project }), problemShownOf(p.problem)]) : problemShownOf(p))

const PRESET_IDS: (PresetId | null)[] = ['solo', 'pair', 'team', 'pairAgent', null]
const isOptions = (v: unknown): v is Partial<WorkflowOptions> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Checks a change's shape (it comes from the window or the API): a preset id and an object of options, and its base. */
function shapeOf(change: unknown): WorkflowChange {
  const c = change as Partial<WorkflowChange> | null
  const base = c?.base
  if (!c || typeof c !== 'object' || !PRESET_IDS.includes(c.preset ?? null) || !isOptions(c.options) || (base !== undefined && (!base || !PRESET_IDS.includes(base.preset ?? null) || !isOptions(base.options)))) throw new CombworkError({ lines: ['A workflow change is { preset, options, base? }'] }, { kind: 'invalid' }) // i18n-ignore: a mistake in a caller, never the window's
  return { preset: c.preset ?? null, options: keptNames(c.options), ...(base ? { base: { preset: base.preset ?? null, options: base.options } } : {}) }
}

/** The project's own preset and options now, as a form reads them (for its platform). */
const ownNow = (cfg: { workflow?: { platform: PlatformId; preset: PresetId | null; options: Partial<WorkflowOptions> } }, platform: PlatformId): { preset: PresetId | null; options: Partial<WorkflowOptions> } => ({ preset: cfg.workflow?.platform === platform ? cfg.workflow.preset : null, options: ownOf(cfg, platform) })

/** Whether a form's base is still the project's preset and options (keys in any order). */
const sameBase = (a: { preset: PresetId | null; options: Partial<WorkflowOptions> }, b: { preset: PresetId | null; options: Partial<WorkflowOptions> }): boolean => a.preset === b.preset && sorted(a.options) === sorted(b.options)
const sorted = (o: object): string => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y))))

const M = {
  changedMeanwhile: msg({ id: 'service.workflow.changedMeanwhile', defaultMessage: 'The workflow options changed meanwhile (in another window, or by the Assistant), so nothing was saved. The section shows them as they are now.', description: 'Why saving the Workflow section of the Version Control tab was refused: the options changed after the section was read. It reloads them.' })
}

/** A form's save refused: the options changed after it read them (#1418). */
export class WorkflowStale extends CombworkError {
  constructor() {
    super(M.changedMeanwhile, { kind: 'conflict' })
  }
}

/** Options with each stage name (N5) as it is kept: trimmed. */
export function keptNames<T extends Partial<WorkflowOptions>>(options: T): T {
  const names = options.stageNames
  if (!names || typeof names !== 'object' || Array.isArray(names)) return options
  return { ...options, stageNames: Object.fromEntries(Object.entries(names).map(([k, v]) => [k, typeof v === 'string' ? keptStageName(v) : v])) }
}

/** Whether a change of these options applies at once (#1417): only names (N5), or the branches lanes and cards may pick (HI-2556), changed, which aren't rules. */
export const namesOnly = (changed: readonly (keyof WorkflowOptions)[]): boolean => changed.length > 0 && changed.every((k) => (NAME_OPTIONS as readonly string[]).includes(k) || (BRANCH_OPTIONS as readonly string[]).includes(k))

/** The options a save would set, their problems, and what changes from the options in force now. */
function changeOf(ws: WorkspaceService, platform: PlatformId, current: Partial<WorkflowOptions>, change: WorkflowChange, folder: string) {
  const before = checkOptions(platform, levelsOf(ws, current, folder))
  const after = checkOptions(platform, levelsOf(ws, change.options, folder))
  const was = before.problems.length ? resolveOptions(platform, levelsOf(ws, current)).options : before.resolved.options
  // Every key either has: an optional option (the names, N5) set before and gone now is a change too.
  const keys = [...new Set([...Object.keys(after.resolved.options), ...Object.keys(was)])] as (keyof WorkflowOptions)[]
  // G12 by on or off (HI-2269): its saved copy refreshed from git is no change.
  const changed = keys.filter((k) => !sameOptionValue(k, after.resolved.options[k], was[k]))
  return { problems: after.problems, changed, options: after.resolved.options }
}

/** The project's cards in flight now: started this cycle and not Done (also the platform switch's warning, #1419). */
export async function cardsInFlight(ws: WorkspaceService, project: { path: string; name: string }): Promise<{ number: number; key: string; title: string }[]> {
  const wf = await workflowFor(ws, project.path)
  if (!wf) return []
  const store = FactStore.forBoard(ws, { project: project.name, key: project.name })
  const cards = store.cards().filter((c) => {
    const s = wf.state(c)
    return !!s.started && IN_FLIGHT.has(s.stage)
  })
  // Each named as its own workspace's window names it (its key, else #n): a level's check lists other workspaces' cards
  // too, whose numbers repeat (#1422, HR5's round 2).
  const keys = cardKeys(ws, cards.map((c) => c.id))
  return cards.map((c) => ({ number: c.id, key: cardLabel({ number: c.id, key: keys.get(c.id) }), title: c.title }))
}

/** What saving a change would do (§16.6.5's warning), before it is saved. */
export async function checkWorkflowChange(ws: WorkspaceService, projectPath: string, raw: unknown): Promise<WorkflowCheck> {
  const project = projectOf(ws, projectPath)
  const change = shapeOf(raw)
  const cfg = await ws.projectConfig(project.path)
  const c = changeOf(ws, project.platform, ownOf(cfg, project.platform), change, project.path)
  // Names alone (N5) aren't rules: they apply at once, so no lane or card keeps old rules over them.
  const appliesNow = namesOnly(c.changed)
  const lanes = appliesNow ? [] : (await listLanes(ws, { project: project.name })).filter((l) => l.state === 'active' || l.state === 'paused')
  const targets = c.changed.includes('target') ? await keptTargets(ws, project, c.options.target ?? '') : null
  // HI-2680: what can follow the new target (Retarget), read while the old one is the project's.
  const retarget = targets ? await retargetOf(ws, project, targets.to) : null
  // HI-2807: branches newly named as targets that don't exist (the save refuses them; the section offers to create each).
  const missing = project.platform === 'git' && (c.changed.includes('target') || c.changed.includes('otherTargets')) ? await newlyMissing(project.path, resolvedOf(ws, project.path, 'git', cfg).options, c.options) : []
  return { problems: c.problems, ...(missing.length ? { missing } : {}), changed: c.changed, appliesNow, lanes: lanes.map((l) => ({ id: l.id, name: l.name, builder: l.builder.name })), inFlight: c.changed.length && !appliesNow ? await cardsInFlight(ws, project) : [], ...(targets ? { targets } : {}), ...(retarget ? { retarget } : {}) }
}

/**
 * HI-2674: the cards and lanes a change of the project's target to `to` leaves on another target, each with its own. A
 * card's is the one its start recorded (`Started.target`, what its queue entry takes: an Override doesn't change it); a
 * running lane's, the one a start of each card it has still to start would record, for its builder under its rules
 * (`baseRulesetOf`, §16.5.4), by the start's own rule (`startTarget`: the card's own, G7, a builder worktree's base, the
 * default branch; HR3's round 1). Cards committed where they are (G6 Committed is done) merge nowhere, so are left out.
 */
export async function keptTargets(ws: WorkspaceService, project: { path: string; name: string }, to: string): Promise<KeptTargets> {
  // The new target, empty: the default branch, as a start in a slot resolves it.
  let fallback: Promise<string> | null = null
  const resolved = (t: string | null | undefined): Promise<string> =>
    t ? Promise.resolve(t) : (fallback ??= G.defaultBranch(project.path).then((d) => (d && !isUnknown(d) ? d : ''), () => ''))
  const now = await resolved(to)
  const out: KeptTargets = { to: now, cards: [], lanes: [] }
  const wf = await workflowFor(ws, project.path)
  if (!wf) return out
  const store = FactStore.forBoard(ws, { project: project.name, key: project.name })
  // The board's cards read once (a whole-project read on main's thread), for the lanes too (HR3's round 2).
  const all = store.cards()
  const byId = new Map(all.map((c) => [c.id, c]))
  const cards = all.flatMap((c) => {
    const s = wf.state(c)
    const target = s.started && IN_FLIGHT.has(s.stage) && wf.rulesetOf(c, s).options.finish !== 'committed' ? s.started.target : null
    return target && target !== now ? [{ c, target }] : []
  })
  const keys = cardKeys(ws, cards.map((x) => x.c.id))
  out.cards = cards.map(({ c, target }) => ({ number: c.id, key: cardLabel({ number: c.id, key: keys.get(c.id) }), title: c.title, target }))
  for (const l of (await listLanes(ws, { project: project.name })).filter((x) => x.state === 'active' || x.state === 'paused')) {
    const rec = wf.lane(l.id)
    if (!rec || rec.ended || !rec.ruleset) continue
    const laneOptions = wf.store.ruleset(rec.ruleset).options
    // Its cards still to start (its queued list, once it applies), each under the rules it would start with; none left,
    // a card it is given next (its own target none), under the lane's.
    const listed = (rec.pending ?? rec.cards).flatMap((n) => {
      const c = byId.get(n)
      return c && wf.state(c).stage === 'todo' ? [c] : []
    })
    const stand = listed.length ? undefined : rec.cards.map((n) => byId.get(n)).find((c) => !!c)
    const next = listed.length ? listed.map((c) => ({ card: c, options: wf.rulesetOf(c).options })) : stand ? [{ card: { ...stand, target: undefined, kind: 'code' as const }, options: laneOptions }] : []
    const targets = new Set<string>()
    for (const { card, options } of next) {
      if (options.finish === 'committed') continue
      const t = await wf.platform(options).startTarget?.(card, options, l.builder.id)
      if (t && !isUnknown(t) && t !== now) targets.add(t)
    }
    for (const target of targets) out.lanes.push({ id: l.id, name: l.name, builder: l.builder.name, target })
  }
  return out
}

/** HI-2680: a change of the project's target to `to`: what can follow it from the target in force now (null: none to say). */
async function retargetOf(ws: WorkspaceService, project: { path: string }, to: string): Promise<RetargetPreview | null> {
  const from = (await projectTargets(ws, project.path).catch(() => null))?.default
  if (!from || from === to) return null
  const p = await retargetPreview(ws, project.path, from, to)
  return p.cards.move.length + p.cards.keep.length + p.slots.move.length + p.slots.keep.length + p.lanes.length ? p : null
}

/** Options that can't be saved: refused with every reason, each a whole sentence of its own (in the window's language there). */
export class WorkflowRefused extends CombworkError {
  constructor(readonly problems: WorkflowProblem[]) {
    // agent-text: problemShown
    super({ lines: problems.map(problemShown) }, { kind: 'invalid' })
  }
}

/**
 * Saves a change to a project's options: checked again under the project's lock (the window's check may be stale), and
 * refused whole with its reasons. `applyTo`: the user's cards in flight to work under the new options from now, each
 * recorded with an Override naming what changed (OP-38: the user only, per change, the cards listed first). `check`: the
 * caller's, run at the write itself, under its lock (its throw saves nothing). Returns the form as it is now.
 */
export function setWorkflowOptions(ws: WorkspaceService, projectPath: string, raw: unknown, o: { applyTo?: number[]; check?: () => void } = {}): Promise<WorkflowForm> {
  // Checked against the levels as they are now and written in the same turn of workflow writes (#1422), holding the
  // project's repository lock first (#1642 round 5): its target can't move while a clean-up checks a branch against it,
  // from this Combwork or another.
  return withFolderRepoLocks([projectPath], () => workflowWrite(() => saveWorkflowOptions(ws, projectPath, raw, o)), { quiet: true, project: projectPath })
}

/** HI-1697: the user's answer to the merge queue's question before an upgraded project's first merge. */
interface MergeAnswer {
  card: number
  request: string
  style: WorkflowOptions['style']
  commitMessage: CommitMessage
}

/**
 * The user's answer to the merge queue's question before an upgraded project's first merge (HI-1697, For you): saved as
 * a Workflow save is, through the same function, as one change (`saveWorkflowOptions`).
 */
export async function chooseMerge(ws: WorkspaceService, projectPath: string, raw: unknown): Promise<void> {
  const project = projectOf(ws, projectPath)
  const a = raw as { card?: unknown; request?: unknown; style?: unknown; commitMessage?: unknown } | null
  if (!a || !Number.isInteger(a.card) || typeof a.request !== 'string' || !takesOption('style', a.style) || !takesOption('commitMessage', a.commitMessage)) throw new CombworkError({ lines: ['A merge choice is { card, request, style, commitMessage }'] }, { kind: 'invalid' }) // i18n-ignore: a mistake in a caller, never the window's
  const answer: MergeAnswer = { card: a.card as number, request: a.request, style: a.style as WorkflowOptions['style'], commitMessage: a.commitMessage as CommitMessage }
  await withFolderRepoLocks([project.path], () => workflowWrite(() => saveWorkflowOptions(ws, project.path, null, { answer })), { quiet: true, project: project.path })
}

/**
 * A save, under the repository's lock and in its turn of workflow writes. HI-1697: the upgrade's merge question is open
 * while the project has the upgrade's mark (`mergeAsk`, kept for good) and the board no recorded choice
 * (`MERGE_CHOICE_KEY`). Its answer, or a save that chooses (changes G6 or G19 as they resolve), is recorded on the board
 * first, as one change of the board (its lock and transaction, which every answer, move and retirement of a request
 * takes, in this Combwork or another): the answer's request checked there (still open, of its gate, bound to the card's
 * open entry; else refused, nothing written), the choice recorded with its file write pending, the cards' rules (an
 * answer's: the project's cards in flight; a save's: those ticked and the card waiting with the question), then the
 * request answered as the user, or the question closed. project.json follows once that has committed, and the record
 * is marked written. A save stopped between the two leaves the board's record pending: `settleMergeChoice` writes the
 * file from it (at the workspace's open, before the queue goes on, before the next save). The board decides; the file
 * follows. The caller holds the repository's lock and this Combwork's turn of workflow writes (`setWorkflowOptions`;
 * HI-2807: Start the next version, in its own hold of both): never called inside another turn, which would wait on itself.
 */
export async function saveWorkflowOptions(ws: WorkspaceService, projectPath: string, raw: unknown, o: { applyTo?: number[]; answer?: MergeAnswer; check?: () => void }): Promise<WorkflowForm> {
  const project = projectOf(ws, projectPath)
  await settleLocked(ws, project)
  const cfg = await ws.projectConfig(project.path)
  const asking = !!cfg.workflow?.mergeAsk && !mergeChoiceOf(ws, project.name)
  if (o.answer && !asking) throw await refusedAnswer(ws, project, o.answer)
  const change: WorkflowChange = o.answer ? answerChange(cfg, project.platform, o.answer) : shapeOf(raw)
  // Checked against the options as they are now (they can't change meanwhile: this save holds the repository's lock and
  // the turn of workflow writes, which every other write of a project's options takes too).
  const plan = planOptions(ws, project, cfg, change, asking && !!o.answer)
  let target = change.options.target ?? ''
  const was = resolvedOf(ws, project.path, project.platform, cfg).options
  const will = resolvedOf(ws, project.path, project.platform, { ...cfg, workflow: plan.workflow }).options
  // HI-2807: a branch newly named as a target must exist, checked here at the save (one deleted since the window's check
  // too), for both ways a save goes: the plain write and the one recording the merge choice (HR1's round 1, finding 3).
  if (project.platform === 'git') await refuseMissingTargets(project.path, was, will)
  if (!plan.chosen) {
    const write = () =>
      ws.mutateProjectConfig(project.path, (c) => {
        // The caller's own check (HI-1502: the Assistant's guard), at the write itself: under the project file's lock.
        o.check?.()
        return { workflow: planOptions(ws, project, c, change, false).workflow, ...LEGACY_CONSUMED }
      })
    // HI-2680: a branch taken out of Other branches work can merge into: refused while anything records it, checked in
    // the board's write (serial with every writer of those), the file written in it.
    if ((was.otherTargets ?? []).some((b) => !(will.otherTargets ?? []).includes(b) && b !== will.target)) {
      const slots = await slotTargets(ws, project.path)
      await withLanesLock(ws, () =>
        boardWrite(ws, async () => {
          await refuseRemovedTargets(ws, project.path, was.otherTargets ?? [], will.otherTargets ?? [], will.target || null, slots)
          await write()
        })
      )
    } else if ((was.target || null) !== (will.target || null)) {
      // HI-2680: Work merges into written in the board's write too, so a retarget's move (which checks it under the
      // board's lock, `tasks.setTarget`'s `expectDefault`) and this change are serial.
      await boardWrite(ws, write)
    } else await write()
    if (!namesOnly(plan.changed) && o.applyTo?.length && plan.changed.length) await applyToInFlight(ws, project, [...new Set(o.applyTo)], plan.changed)
  } else {
    const store = FactStore.forBoard(ws, { project: project.name, key: project.name })
    const options = resolvedOf(ws, project.path, project.platform, { ...cfg, workflow: plan.workflow }).options
    await saveSeams.beforeBoard?.()
    await boardWrite(ws, async () => {
      if (o.answer) target = await stillAsked(ws, project, o.answer)
      // Chosen meanwhile (another Combwork's answer): this one is refused, as an answered question's is.
      else if (mergeChoiceOf(ws, project.name)) throw new WorkflowStale()
      // The caller's own check (HI-1502), in the board change that decides the save.
      o.check?.()
      const ruleset = mustCompile(options)
      store.saveRuleset(ruleset)
      const cards = o.answer ? (await cardsInFlight(ws, project)).map((c) => c.number) : [...(o.applyTo ?? []), ...(await askedCards(ws, project.path))]
      if (cards.length) await applyToInFlight(ws, project, [...new Set(cards)], [...new Set([...plan.changed, 'style' as const])], ruleset)
      store.setMeta(MERGE_CHOICE_KEY, JSON.stringify({ style: options.style, commitMessage: options.commitMessage, at: new Date().toISOString(), pending: true } satisfies MergeChoiceRecord))
      if (o.answer) await answerIt(o.answer)
      else await closeAsked(ws, project.path)
      await saveSeams.recorded?.()
    })
    // The board has the choice: the file follows it, then the record is marked written.
    await saveSeams.beforeFile?.()
    await settleLocked(ws, project, plan.workflow)
  }
  log.info(`the workflow options of ${userText(project.name)} changed: ${plan.changed.join(', ') || 'none'}${plan.chosen ? ' (the merge question answered)' : ''}`)
  workflowChanged(ws, project.path)
  // Names alone change no card's rules (#1417): nothing to apply to cards in flight, nor any queue to read again.
  if (namesOnly(plan.changed) && !plan.chosen) return workflowForm(ws, project.path)
  // Whether Combwork merges, and into what, may have changed: the windows read the project's queues again (#1356: which
  // show follows the options too), whoever changed them (the window, the Assistant). A queue waiting for the merge
  // question (paused `mergeChoice`) carries on.
  const t = target || (await G.defaultBranch(project.path).catch(() => null))
  if (t && !isUnknown(t)) {
    queueChanged(ws, project.path, t)
    if (plan.chosen) void kickQueue(ws, project.path, t)
  }
  return workflowForm(ws, project.path)
}

interface MergeChoiceRecord {
  style: WorkflowOptions['style']
  commitMessage: CommitMessage
  at: string
  pending: boolean
}

/** The project's recorded merge choice (HI-1697), or null; one that can't be read counts as recorded, never asked again. */
export function mergeChoiceOf(ws: WorkspaceService, projectName: string): MergeChoiceRecord | null {
  const v = FactStore.forBoard(ws, { project: projectName, key: projectName }).meta(MERGE_CHOICE_KEY)
  if (!v) return null
  try {
    const r = JSON.parse(v) as Partial<MergeChoiceRecord>
    return takesOption('style', r.style) && takesOption('commitMessage', r.commitMessage) ? (r as MergeChoiceRecord) : { style: 'merge', commitMessage: 'combwork', at: '', pending: false }
  } catch {
    return { style: 'merge', commitMessage: 'combwork', at: '', pending: false }
  }
}

/**
 * HI-1697: project.json brought in line with the board's recorded merge choice while its file write is pending (a save
 * stopped after the board's commit): G6 and G19 set as recorded over the project's options as they are now, then the
 * record marked written. Under the repository's lock and in a turn of workflow writes, as every save. At the
 * workspace's open, and before the queue goes on (`QueueConfig.settle`).
 */
export async function settleMergeChoice(ws: WorkspaceService, projectPath: string): Promise<void> {
  const project = projectOf(ws, projectPath)
  if (!mergeChoiceOf(ws, project.name)?.pending) return
  await withFolderRepoLocks([project.path], () => workflowWrite(() => settleLocked(ws, project)), { quiet: true, project: project.path })
}

/** Every project of the workspace settled (its open), each on its own: one that fails is logged and tried again later. */
export async function settleMergeChoices(ws: WorkspaceService): Promise<void> {
  for (const p of ws.info()?.projects ?? []) {
    if (!p.platform) continue
    await settleMergeChoice(ws, p.path).catch((e: unknown) => log.warn(`writing the merge choice of ${userText(p.name)} to its options (tried again later)`, e))
  }
}

/** Settles a pending record, holding the locks; `workflow`: the save's own workflow to write (its whole change), else G6 and G19 only. */
async function settleLocked(ws: WorkspaceService, project: { path: string; name: string; platform: PlatformId }, workflow?: ProjectWorkflow): Promise<void> {
  const rec = mergeChoiceOf(ws, project.name)
  if (!rec?.pending) return
  await ws.mutateProjectConfig(project.path, (c) => {
    // The options as the form had them, the old keys among them (ownOf): consumed with them (HR5's HI-1766 round 1).
    if (workflow) return { workflow, ...LEGACY_CONSUMED }
    const own = ownOf(c, project.platform)
    return { workflow: writeWorkflow(c.workflow, { platform: project.platform, preset: c.workflow?.platform === project.platform ? c.workflow.preset : null, options: { ...own, style: rec.style, commitMessage: rec.commitMessage } }), ...LEGACY_CONSUMED }
  })
  await boardWrite(ws, async () => {
    const now = mergeChoiceOf(ws, project.name)
    if (now?.at === rec.at) FactStore.forBoard(ws, { project: project.name, key: project.name }).setMeta(MERGE_CHOICE_KEY, JSON.stringify({ ...rec, pending: false }))
  })
  if (!workflow) {
    log.info(`the merge choice of ${userText(project.name)} written to its options from the board (${rec.style}, ${rec.commitMessage})`)
    workflowChanged(ws, project.path)
  }
}

/**
 * Tests only (HI-1697's races and crash boundaries): seams in a save that answers the merge question: before it takes
 * the board's lock, inside the board's change once the choice is recorded, and after its commit, before project.json.
 */
export const saveSeams: { beforeBoard?: () => Promise<void>; recorded?: () => Promise<void>; beforeFile?: () => Promise<void> } = {}

// A test copy (an unpackaged build) crashes at one of them when CW_TEST_MERGE_CHOICE_CRASH names it (HI-1697's crash
// boundaries, tests/e2e/queueupgrade.cjs): Combwork gone part way, as a crash leaves it.
const crashAt = app?.isPackaged ? undefined : process.env.CW_TEST_MERGE_CHOICE_CRASH
if (crashAt === 'recorded' || crashAt === 'beforeFile') saveSeams[crashAt] = () => (exitBy('app.exit', `a test crash at the merge choice's ${crashAt}`, () => app.exit(1)), new Promise<void>(() => undefined))

/** What a save makes of the project's options: its workflow, the options it changes, whether it chooses (HI-1697). */
function planOptions(ws: WorkspaceService, project: { path: string; name: string; platform: PlatformId }, cfg: ProjectConfig, change: WorkflowChange, answering: boolean): { workflow: ProjectWorkflow; changed: (keyof WorkflowOptions)[]; chosen: boolean } {
  // Its version control switched since the form was read (#1419): these options are the other platform's, refused.
  const now = projectPlatform(project.path, cfg.platform).id
  if (now !== project.platform) throw combworkError(SWITCH_REFUSED.changed, { platform: PLATFORM_NAME[now] }, { kind: 'conflict' })
  // A form read before another change (the Assistant's tool, another window) never writes over it (#1418).
  if (change.base && !sameBase(change.base, ownNow(cfg, project.platform))) throw new WorkflowStale()
  const c = changeOf(ws, project.platform, ownOf(cfg, project.platform), change, project.path)
  if (c.problems.length) throw new WorkflowRefused(c.problems)
  const options = Object.fromEntries(Object.entries(change.options).filter(([k, v]) => k !== 'platform' && v !== undefined))
  // Saved from the Workflow section: the answer to "How do you work?" for this platform is given (#1423).
  const workflow = setPresetAsked(writeWorkflow(cfg.workflow, { platform: project.platform, preset: change.preset, options }), project.platform, 'chosen')
  // HI-1697: with the question open, the answer chooses; so does a change to G6 or G19 as they resolve (one left out
  // inherits).
  let chosen = answering
  if (!chosen && workflow.mergeAsk && !mergeChoiceOf(ws, project.name)) {
    const was = resolvedOf(ws, project.path, project.platform, cfg).options
    const next = resolvedOf(ws, project.path, project.platform, { ...cfg, workflow }).options
    chosen = was.style !== next.style || was.commitMessage !== next.commitMessage
  }
  return { workflow, changed: c.changed, chosen }
}

/** The answer's change: the project's own options and preset as they are now, its merge style and commit message set. */
function answerChange(cfg: { workflow?: ProjectWorkflow }, platform: PlatformId, a: MergeAnswer): WorkflowChange {
  const from = cfg.workflow?.platform === platform ? cfg.workflow.preset : null
  return { preset: from, options: { ...ownOf(cfg, platform), style: a.style, commitMessage: a.commitMessage } }
}

/** An answer refused as `tasks:answer` refuses one: a stale dialog's, or one answered or retired meanwhile. */
async function refusedAnswer(ws: WorkspaceService, project: { path: string }, a: MergeAnswer): Promise<Error> {
  const { WorkflowRefusedError } = await import('../tasks')
  const wf = await workflowFor(ws, project.path)
  const rec = wf?.store.cards().find((c) => c.id === a.card)
  const s = wf && rec ? wf.state(rec) : null
  return new WorkflowRefusedError(refusal('move.notFromHere', { card: rec ? cardLabel({ number: a.card, key: rec.key }) : `#${a.card}`, stage: s?.stage ?? 'todo', move: 'answer', moves: '' }))
}

/**
 * The answer's request still asks, checked under the board's lock: the card this project's, the request open, the merge
 * question, bound to the card's open queue entry; its target. Else refused.
 */
async function stillAsked(ws: WorkspaceService, project: { path: string }, a: MergeAnswer): Promise<string> {
  const wf = await workflowFor(ws, project.path)
  const rec = wf?.store.cards().find((c) => c.id === a.card)
  const s = wf && rec ? wf.state(rec) : null
  const req = s?.requests.find((r) => r.request === a.request)
  const entry = s ? openEntry(s) : undefined
  if (!s || !req || req.gate !== MERGE_CHOICE_GATE || !entry || req.entry !== entry.id) throw await refusedAnswer(ws, project, a)
  return entry.target
}

/** The request answered as the user (For you's path: its refusal propagated), its words kept on the card as their comment. */
async function answerIt(a: MergeAnswer): Promise<void> {
  const { answerTask } = await import('../tasks')
  // In the user's language (HI-1733), as Version Control → Workflow names the options and their values: the comment is
  // theirs, and nothing reads its words (the choice is the board's record and the project's options).
  const reply = tr(MERGE_ANSWER, { styleTitle: tr(OPTION_TEXT.style!.title), style: tr(VALUE_TEXT.style[a.style]), messageTitle: tr(OPTION_TEXT.commitMessage!.title), message: tr(VALUE_TEXT.commitMessage[a.commitMessage]) })
  await answerTask(a.card, a.request, { outcome: 'answered', reply })
}

/** A save chose them: each open merge question of the project closed, with the save. */
async function closeAsked(ws: WorkspaceService, projectPath: string): Promise<void> {
  const wf = await workflowFor(ws, projectPath)
  if (!wf) return
  for (const id of await askedCards(ws, projectPath)) {
    const rec = wf.store.card(id)
    await wf.write(rec, wf.rulesetOf(rec), 'combwork', (w) => {
      for (const r of w.state().requests.filter((x) => x.gate === MERGE_CHOICE_GATE)) w.fact('RequestClosed', { request: r.request, why: 'done' }) // i18n-ignore: a fact's kind and codes, not text
    })
  }
}

/** The project's cards whose merge waits for the upgrade's question (HI-1697): a request of its gate open. */
async function askedCards(ws: WorkspaceService, projectPath: string): Promise<number[]> {
  const wf = await workflowFor(ws, projectPath)
  return wf ? wf.store.cards().filter((c) => wf.state(c).requests.some((r) => r.gate === MERGE_CHOICE_GATE)).map((c) => c.id) : []
}

/** The user applies the options now in force to cards in flight: an Override on each that is still in flight. */
async function applyToInFlight(ws: WorkspaceService, project: { path: string; name: string }, cards: number[], changed: (keyof WorkflowOptions)[], given?: Ruleset): Promise<void> {
  const wf = await workflowFor(ws, project.path)
  if (!wf) return
  const store = FactStore.forBoard(ws, { project: project.name, key: project.name })
  await boardWrite(ws, async () => {
    // The options now in force, or the ruleset given (HI-1697: the merge choice's, recorded before project.json has it).
    const ruleset = given ?? wf.currentRuleset()
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
