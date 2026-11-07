// A template's workflow (HI-1910, Darren's decisions of 28 Oct): a section per version control, None and Git, holding the
// rules a project's workflow options set, never the project's own facts. Each option is on one side of the split
// (`TEMPLATE_CARRIED`, `TEMPLATE_NOT_CARRIED`; a unit test fails on a new option on neither). Every boundary goes
// through a whitelist: saving (`templateWorkflowOf`), reading a file or an edit (`readTemplateWorkflows`), and loading
// (`overlayTemplateWorkflow`): a section naming a target, commands or an identity's name never carries them anywhere.

import type { PlatformId } from '../platform/descriptors'
import { allOff, contradictions, FOCUSED_RUN, FORM_GROUPS, identityShown, OPTION_TAKES, PRESETS, sameOptionValue, type OptionKey, type PresetId, type WorkflowOptions } from './options'
import { stageNameProblems } from './stages'

/**
 * The options a template carries (Darren, 28 Oct ~01:25): the rules of review, checks (by name), carrying a pass over,
 * merging, your OK, where cards are built, the identity's on/off, agents' runs, dependencies, card loops and the stage
 * names; and G16 and file locks, how agents share a folder (HR5's OK on the design). G20, each card's focused tests
 * (HI-1367), is a rule too: its runner and picker are commands, the loading project's own (HR4's OK, HI-1949). Maximum
 * agents (HI-2001): the team the template is for.
 */
export const TEMPLATE_CARRIED = [
  'review',
  'reviewers',
  'reviewerMode',
  'noSelfReview',
  'sameness',
  'okBefore',
  'preChecks',
  'mergeChecks',
  'focusedTests',
  'mergeInstall',
  'finish',
  'style',
  'strict',
  'dependenciesDone',
  'folder',
  'slotsUpToDate',
  'identity',
  'stopOwnRuns',
  'sharedFolderWarning',
  'fileLocks',
  'loopWakes',
  'loopRounds',
  'loopWaitHours',
  'loopStepWaitMinutes',
  'stageNames',
  'maxAgents'
] as const satisfies readonly OptionKey[]

/**
 * The project's own facts, never carried: the branch its work merges into, the other branches it can (HI-2556), and
 * pushing it, the checks' commands, the merge commit's message (set per workspace) and None's excluded folders. The
 * identity's name and email aren't carried either: `identity` is, as on or off only, made from the loading project's own
 * git identity.
 */
export const TEMPLATE_NOT_CARRIED = ['target', 'targetOwn', 'otherTargets', 'pushTarget', 'commands', 'commitMessage', 'excluded'] as const satisfies readonly OptionKey[]

export type CarriedKey = (typeof TEMPLATE_CARRIED)[number]

/** A section's options: the carried ones a platform has, the identity as on or off. */
export type TemplateOptions = Partial<Omit<Pick<WorkflowOptions, CarriedKey>, 'identity'>> & { identity?: boolean }

/** One version control's section: the preset its options started from, and its options. */
export interface TemplateWorkflow {
  preset: PresetId | null
  options: TemplateOptions
}

/** A template's workflow: a section per version control, each optional. */
export type TemplateWorkflows = Partial<Record<PlatformId, TemplateWorkflow>>

/** The version controls a template's sections are for, in the order they are shown. */
export const TEMPLATE_PLATFORMS: readonly PlatformId[] = ['none', 'git']

/** The carried options a platform has (its form's): None has no merging, slots or G17. */
export const carriedFor = (platform: PlatformId): CarriedKey[] => TEMPLATE_CARRIED.filter((k) => FORM_GROUPS[platform].some((g) => g.options.includes(k)))

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

/** A section from options in force (a project's, a preset's): its platform's carried options only, the identity as on/off. */
export function templateWorkflowOf(o: WorkflowOptions, preset: PresetId | null): TemplateWorkflow {
  const options: Record<string, unknown> = {}
  for (const k of carriedFor(o.platform)) {
    if (k === 'identity') options.identity = !!o.identity
    else if (o[k] !== undefined) options[k] = copy(o[k])
  }
  return { preset: preset && PRESETS[o.platform].some((p) => p.id === preset) ? preset : null, options: options as TemplateOptions }
}

/**
 * A section as read (untrusted: a file, an import, an edit), or null when it can't be used: the preset one its platform
 * offers; each carried option its platform has, of a value it takes (the identity on or off); together, options that
 * can be saved (no contradiction, stage names that can be). Options it doesn't carry (a target, commands…) are left
 * out, never read; a carried option its platform doesn't have makes it unusable, as a section made for another
 * version control would be.
 */
export function readTemplateWorkflow(raw: unknown, platform: PlatformId): TemplateWorkflow | null {
  if (!isObj(raw) || !isObj(raw.options)) return null
  const preset = raw.preset ?? null
  if (preset !== null && !PRESETS[platform].some((p) => p.id === preset)) return null
  const own = carriedFor(platform)
  const options: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw.options)) {
    if (!(TEMPLATE_CARRIED as readonly string[]).includes(k)) continue
    if (!(own as string[]).includes(k)) return null
    if (k === 'identity' ? typeof v !== 'boolean' : !OPTION_TAKES[k as OptionKey](v)) return null
    options[k] = copy(v)
  }
  const section = { preset: preset as PresetId | null, options: options as TemplateOptions }
  // Whole: options that could be saved, on every rule off. G20's runner is a command, never in a section: the loading
  // project's own, flagged when it lays the section over its options (HI-1949).
  const whole = { ...allOff(platform), ...section.options, identity: section.options.identity ? { name: '', email: '' } : null } as WorkflowOptions
  if (contradictions(whole).some((c) => c !== 'focusedNeedsRunner') || stageNameProblems(whole.stageNames).length) return null
  return section
}

/** A template's sections as read: each usable one, and the platforms whose section was there but can't be used (said, never applied). */
export function readTemplateWorkflows(raw: unknown): { workflow: TemplateWorkflows; dropped: PlatformId[] } {
  const workflow: TemplateWorkflows = {}
  const dropped: PlatformId[] = []
  if (!isObj(raw)) return { workflow, dropped }
  for (const p of TEMPLATE_PLATFORMS) {
    if (raw[p] === undefined) continue
    const s = readTemplateWorkflow(raw[p], p)
    if (s) workflow[p] = s
    else dropped.push(p)
  }
  return { workflow, dropped }
}

/** Whether a template has any section. */
export const hasWorkflow = (w: TemplateWorkflows | undefined): w is TemplateWorkflows => !!w && TEMPLATE_PLATFORMS.some((p) => !!w[p])

/** What a project's form has that a section is laid over: its options in force and its own, and its git identity. */
export interface WorkflowBase {
  platform: PlatformId
  options: WorkflowOptions
  own: Partial<WorkflowOptions>
  identity: { name: string; email: string } | null
}

/** A section laid over a project's options: the draft to save, and what it changes and can't fill in. */
export interface TemplateWorkflowOverlay {
  preset: PresetId | null
  /** The draft's own options: the project's own, each carried option the section sets over them. */
  own: Partial<WorkflowOptions>
  /** The options in force with it. */
  options: WorkflowOptions
  /** Each carried option it changes, its value now and with it. */
  changes: { key: OptionKey; now: unknown; next: unknown }[]
  /** Its check names this project has no command for (each once), and G20's runner (`focused.run`) when it needs one: kept, flagged, never given another project's. */
  missingCommands: string[]
  /** It turns the identity on, but this project's git config has none: it stays off. */
  identityOff: boolean
}

/**
 * The Maximum agents the user's load of a template saves with its agents (HI-2058, Darren's decision: the template
 * raises it by itself), its workflow applied: the section's own (`m`, read as the option takes it) when it has one, never
 * under the `n` agents loaded; one with none, or none it can take, raises the project's (`now`) to `n` and never lowers
 * it. Null: none saved, the project's own as it is. A load past AGENT_LIMIT_MAX is refused before this is asked.
 */
export function loadedMaxAgents(m: unknown, n: number, now: number): number | null {
  if (OPTION_TAKES.maxAgents(m)) return Math.max(m as number, n)
  return n > now ? n : null
}

/**
 * A section laid over a project's options (the Load template dialog's preview, then the Workflow form's draft): each
 * carried option its platform has, from the section; everything else the project's own as it is, its target, commands
 * and identity among them. The identity on is this project's git identity, never another's: none here, it stays off.
 */
export function overlayTemplateWorkflow(section: TemplateWorkflow, base: WorkflowBase): TemplateWorkflowOverlay {
  const set: Partial<WorkflowOptions> = {}
  let identityOff = false
  for (const k of carriedFor(base.platform)) {
    const v = section.options[k]
    if (v === undefined) continue
    if (k === 'identity') {
      if (v && !base.identity) identityOff = true
      ;(set as Record<string, unknown>).identity = v && base.identity ? { ...base.identity } : null
    } else (set as Record<string, unknown>)[k] = copy(v)
  }
  const own = { ...base.own, ...set }
  const options = { ...base.options, ...set, platform: base.platform } as WorkflowOptions
  // G12 by on or off, shown as git's identity now (HI-2269): a saved copy that differs from it is neither a change nor
  // shown as the value now.
  const shown = (k: keyof WorkflowOptions, v: unknown): unknown => (k === 'identity' ? identityShown(v, base.identity) : v)
  const changes = carriedFor(base.platform)
    .filter((k) => k in set && !sameOptionValue(k, base.options[k], options[k]))
    .map((k) => ({ key: k as OptionKey, now: shown(k, base.options[k]), next: shown(k, options[k]) }))
  const named = [...new Set([...options.preChecks, ...(base.platform === 'git' ? options.mergeChecks : [])])]
  const missingCommands = named.filter((n) => !options.commands[n]?.trim())
  // G20 on where Combwork merges needs this project's runner (HI-1949): flagged as a check's command is; saving still refuses it.
  if (base.platform === 'git' && options.focusedTests && options.finish === 'combworkMerges' && !options.commands[FOCUSED_RUN]?.trim()) missingCommands.push(FOCUSED_RUN)
  return { preset: section.preset, own, options, changes, missingCommands, identityOff }
}
