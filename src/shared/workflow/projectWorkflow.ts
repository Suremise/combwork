// The one writer of project.json's `workflow` (SPEC §16.6.6, #1417): the form's Save, presets and Paste and the
// Assistant's settings tool set a project's platform, preset and options through it, and every other field of `workflow`
// (`kept` for the other platforms, #1419; `presetAsked`, #1423; a field a later Hive adds) stays as it was. Those fields
// are written by helpers beside this one, never by replacing the object.

import type { ProjectWorkflow } from '../types'

/** What a save sets: the platform in force, the preset the options started from, and the options the project sets. */
export type WorkflowWrite = Pick<ProjectWorkflow, 'platform' | 'preset' | 'options'>

/** `workflow` with its platform, preset and options set, and every other field of `current` kept. */
export function writeWorkflow(current: ProjectWorkflow | null | undefined, next: WorkflowWrite): ProjectWorkflow {
  return { ...current, platform: next.platform, preset: next.preset, options: next.options }
}
