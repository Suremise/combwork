// A project's workflow options, resolved (SPEC §16.6.6): the platform's defaults (every check and balance off), then the
// global defaults (config), the workspace's (workspace.json) and the project's own (project.json's `workflow.options`),
// each level setting only what it names and inheriting the rest, with where each option came from. Read-only here: the
// Version Control tab (#1278) edits them. Checked as they are read: an unknown option, a value of the wrong type or a
// contradiction (options.ts) falls back to the platform's all-off and is logged, never a throw at a move.

import { createLogger, userText } from '../logger'
import { compile } from '../../shared/workflow/compile'
import { allOff, type WorkflowOptions } from '../../shared/workflow/options'
import type { PlatformId } from '../../shared/platform/descriptors'
import type { WorkflowDefaults } from '../../shared/types'

const log = createLogger('workflow')

/** Where an option's value came from: the platform's all-off, or the level that set it. */
export type OptionOrigin = 'platform' | 'global' | 'workspace' | 'project'

/** The options each level sets: the global and workspace defaults per platform, the project's for its own. */
export interface OptionLevels {
  global?: WorkflowDefaults | null
  workspace?: WorkflowDefaults | null
  project?: Partial<WorkflowOptions> | null
}

export interface ResolvedOptions {
  options: WorkflowOptions
  origins: Record<keyof WorkflowOptions, OptionOrigin>
  /** Why the levels couldn't be used, when they fell back to all-off (English, for the log and agents). */
  invalid: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** Whether a value has the type its option takes (its all-off value's shape; the choices are checked by compiling). */
function fits(key: keyof WorkflowOptions, v: unknown): boolean {
  switch (key) {
    case 'reviewers':
      return v === 1 || v === 2
    case 'preChecks':
    case 'mergeChecks':
    case 'excluded':
      return strings(v)
    case 'okBefore':
      return isRecord(v) && typeof v.mode === 'string' && strings(v.labels)
    case 'identity':
      return v === null || (isRecord(v) && typeof v.name === 'string' && typeof v.email === 'string')
    case 'commands':
      return isRecord(v) && Object.values(v).every((x) => typeof x === 'string')
    default:
      return typeof v === typeof allOff('git')[key]
  }
}

/** The options a level sets for a platform, or why they can't be read. */
function levelOf(raw: unknown, platform: PlatformId, known: Set<string>): { set: Partial<WorkflowOptions> } | { bad: string } {
  if (raw === undefined || raw === null) return { set: {} }
  if (!isRecord(raw)) return { bad: 'not an object' }
  const set: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue
    if (k === 'platform') {
      // A project's options name their platform: another one's don't apply here.
      if (v !== platform) return { bad: `options for ${String(v)}, not ${platform}` }
      continue
    }
    if (!known.has(k)) return { bad: `unknown option ${k}` }
    if (!fits(k as keyof WorkflowOptions, v)) return { bad: `${k} has a value of the wrong type` }
    set[k] = v
  }
  return { set: set as Partial<WorkflowOptions> }
}

/**
 * The options for a project on a platform: each level over the one before it, with each option's origin. A level that
 * can't be read, or options that contradict each other, fall back to the platform's all-off (`invalid` says why).
 */
export function resolveOptions(platform: PlatformId, levels: OptionLevels): ResolvedOptions {
  const base = allOff(platform)
  const known = new Set(Object.keys(base).filter((k) => k !== 'platform'))
  const origins = Object.fromEntries(Object.keys(base).map((k) => [k, 'platform'])) as Record<keyof WorkflowOptions, OptionOrigin>
  const options: WorkflowOptions = { ...base }
  const fallBack = (why: string): ResolvedOptions => ({ options: base, origins: Object.fromEntries(Object.keys(base).map((k) => [k, 'platform'])) as Record<keyof WorkflowOptions, OptionOrigin>, invalid: why })
  const steps: [Exclude<OptionOrigin, 'platform'>, unknown][] = [
    ['global', levels.global?.[platform]],
    ['workspace', levels.workspace?.[platform]],
    ['project', levels.project]
  ]
  for (const [origin, raw] of steps) {
    const l = levelOf(raw, platform, known)
    if ('bad' in l) return fallBack(`${origin} options: ${l.bad}`)
    for (const [k, v] of Object.entries(l.set)) {
      ;(options as unknown as Record<string, unknown>)[k] = v
      origins[k as keyof WorkflowOptions] = origin
    }
  }
  let compiled: ReturnType<typeof compile>
  try {
    compiled = compile(options)
  } catch (e) {
    return fallBack(`options that don't compile (${e instanceof Error ? e.message : String(e)})`)
  }
  if (!compiled.ok) return fallBack(`options that contradict each other (${compiled.contradictions.join(', ')})`)
  return { options, origins, invalid: null }
}

/** resolveOptions(), logging a fall-back once per project and reason (each read would log it again otherwise). */
const logged = new Map<string, string>()
export function resolveLogged(project: string, platform: PlatformId, levels: OptionLevels): ResolvedOptions {
  const r = resolveOptions(platform, levels)
  const key = project.toLowerCase()
  if (r.invalid && logged.get(key) !== r.invalid) log.warn(`the workflow options of ${userText(project)} can't be used, so every rule is off for it: ${r.invalid}`)
  if (r.invalid) logged.set(key, r.invalid)
  else logged.delete(key)
  return r
}
