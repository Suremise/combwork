// The one writer of project.json's `workflow` (SPEC §16.6.6, #1417): the form's Save, presets and Paste and the
// Assistant's settings tool set a project's platform, preset and options through it, and every other field of `workflow`
// (`kept` for the other platforms, #1419; `presetAsked`, #1423; a field a later Combwork adds) stays as it was. Those fields
// are written by helpers beside this one (`setKept` for a switch of platform, `setPresetAsked` for the answer), never by
// replacing the object.

import type { PlatformId } from '../platform/descriptors'
import type { PresetAsked, ProjectWorkflow } from '../types'

/** What a save sets: the platform in force, the preset the options started from, and the options the project sets. */
export type WorkflowWrite = Pick<ProjectWorkflow, 'platform' | 'preset' | 'options'>

/**
 * `workflow` with its platform, preset and options set, and every other field of `current` kept. Git's commit message
 * (G19, HI-1997) set to Combwork's by this write, rather than left as it was, is marked chosen (`commitMessageChosen`); the
 * mark stays while it is Combwork's, and goes with it.
 */
export function writeWorkflow(current: ProjectWorkflow | null | undefined, next: WorkflowWrite): ProjectWorkflow {
  const { commitMessageChosen: was, ...rest } = current ?? {}
  if (next.platform !== 'git') return { ...rest, ...(was ? { commitMessageChosen: was } : {}), platform: next.platform, preset: next.preset, options: next.options }
  const before = current?.platform === 'git' ? current.options?.commitMessage : undefined
  const combwork = next.options.commitMessage === 'combwork'
  const chosen = combwork && (was || before !== 'combwork')
  return { ...rest, ...(chosen ? { commitMessageChosen: true as const } : {}), platform: next.platform, preset: next.preset, options: next.options }
}

/** What a platform keeps while another is in force: its preset, options and answer (`kept`'s entries). */
export type KeptWorkflow = NonNullable<ProjectWorkflow['kept']>[PlatformId]

/**
 * `workflow` switched to another platform (#1419, SPEC §16.6.5): the platform left goes into `kept` (its preset, options
 * and answer, when it has any), and the one chosen comes back from `kept` with its own, its entry removed; one never
 * kept starts with no preset, no options and no answer. Every other field stays. The same platform: unchanged.
 */
export function setKept(current: ProjectWorkflow, to: PlatformId): ProjectWorkflow {
  if (current.platform === to) return current
  const { kept, presetAsked, ...rest } = current
  const others: Partial<Record<PlatformId, KeptWorkflow>> = { ...kept }
  const back = others[to]
  delete others[to]
  const leaving: KeptWorkflow = { preset: current.preset, options: current.options, ...(presetAsked ? { presetAsked } : {}) }
  if (leaving.preset || Object.keys(leaving.options ?? {}).length || leaving.presetAsked) others[current.platform] = leaving
  else delete others[current.platform]
  return {
    ...rest,
    platform: to,
    preset: back?.preset ?? null,
    options: back?.options ?? {},
    ...(back?.presetAsked ? { presetAsked: back.presetAsked } : {}),
    ...(Object.keys(others).length ? { kept: others } : {})
  }
}

/**
 * `workflow` with the answer to "How do you work?" for the platform in force (#1423): `chosen` (a preset or options
 * saved from the Workflow section) or `notNow`. Every other field is kept; a project with no `workflow` yet gets one with
 * no preset and no options of its own, so it goes on inheriting.
 */
export function setPresetAsked(current: ProjectWorkflow | null | undefined, platform: PlatformId, answer: PresetAsked): ProjectWorkflow {
  if (!current || current.platform !== platform) return { ...current, platform, preset: null, options: {}, presetAsked: answer }
  return { ...current, presetAsked: answer }
}
