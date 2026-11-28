// HI-3620: an option's value in words, as Save… lists what changes (from → to) and a preset or template shows them.
// Its own module (no React), so a unit test reads it: relative imports, as tsconfig.node.json's program (the unit
// tests' and the WorkspaceService rule's) has no @shared.

import type { MergeGuard } from '../../shared/workflow/mergeGuards'
import type { StageNames } from '../../shared/workflow/stages'
import type { AssistantWakes } from '../../shared/laneEvents'
import type { OkBefore, OptionKey, WorkflowOptions } from '../../shared/workflow/options'
import { accepts, type PlatformId } from '../../shared/platform/descriptors'
import { VALUE_TEXT, WAKE_EVENT_TEXT } from '../../shared/workflow/optionTexts'
import { FILE_LOCK_MODES } from '../../shared/defaults'
import { fmt, msg, tr } from '../../shared/i18n'

export const VT = {
  on: msg({ id: 'workflow.form.on', defaultMessage: 'On', description: 'A workflow option’s value: on.' }),
  off: msg({ id: 'workflow.form.off', defaultMessage: 'Off', description: 'A workflow option’s value: off.' }),
  noneValue: msg({ id: 'workflow.form.noneValue', defaultMessage: 'None', description: 'An empty value in the list of what changes before saving workflow options: no checks, no commands, no folders.' }),
  labelsValue: msg({ id: 'workflow.form.labelsValue', defaultMessage: 'Cards with these labels: {labels}', description: 'A value of “Your OK before merging” in the list of what changes before saving workflow options. {labels} is a list of card labels.' }),
  identityValue: msg({ id: 'workflow.form.identityValue', defaultMessage: 'On, as {name} <{email}>', description: 'A value of “Commits use the project’s identity” in the list of what changes before saving workflow options: on, with the name and email commits use.' }),
  stageNamesValue: msg({ id: 'workflow.form.stageNamesValue', defaultMessage: '{n, plural, =0 {The default names} one {# stage renamed} other {# stages renamed}}', description: 'A value of “Stage names” in the list of what changes before saving workflow options, and in a preset’s preview (glossary 2.2: stage).' }),
  hoursValue: msg({ id: 'workflow.form.hoursValue', defaultMessage: '{n, plural, one {# hour} other {# hours}}', description: 'The value of the workflow option “Wait (hours)” (Card loops) in words, as in the Inherit box and a preset preview.' }),
  minutesValue: msg({ id: 'workflow.form.minutesValue', defaultMessage: '{n, plural, one {# minute} other {# minutes}}', description: 'The value of the workflow option “Design check wait (minutes)” (Card loops) in words, as in the Inherit box.' }),
  customWakesValue: msg({ id: 'workflow.form.customWakesValue', defaultMessage: 'Custom: {events}', description: 'An inherited value of the workflow option “Wake the Assistant for” (HI-3211) set to Custom: the events ticked, joined as a list (e.g. “A card fails review and A lane ends”).' }),
  defaultBranch: msg({ id: 'workflow.form.defaultBranch', defaultMessage: 'The repository’s default branch', description: 'The placeholder of the target branch field in Project Settings → Workflow: left empty, the default branch.' })
}

/** An option's value in words (the rows' Inherit tips, a preview), as its platform names it. */
export function optionValueText(key: OptionKey, v: unknown, platform: PlatformId): string {
  if (typeof v === 'boolean') return tr(v ? VT.on : VT.off)
  if (key === 'review') return tr(accepts(platform) && v === 'none' ? VALUE_TEXT.review.noneNone : VALUE_TEXT.review[v as keyof typeof VALUE_TEXT.review])
  const values = (VALUE_TEXT as Record<string, Record<string, ReturnType<typeof msg>>>)[key]
  if (values && typeof v === 'string' && values[v]) return tr(values[v])
  // A structured value with what it holds (HR6's round 3: the labels, the identity), not only its kind.
  if (key === 'okBefore') {
    const ok = v as OkBefore
    return ok.mode === 'labels' ? tr(VT.labelsValue, { labels: ok.labels.length ? fmt.list(ok.labels) : tr(VT.noneValue) }) : tr(VALUE_TEXT.okBefore[ok.mode])
  }
  if (key === 'identity') {
    const id = v as WorkflowOptions['identity']
    return id ? tr(VT.identityValue, { name: id.name, email: id.email }) : tr(VT.off)
  }
  if (key === 'stageNames') return tr(VT.stageNamesValue, { n: Object.keys((v as StageNames | undefined) ?? {}).length })
  // HI-3284: the guards by name (the user's own words), or none.
  if (key === 'mergeGuards') return Array.isArray(v) && v.length ? fmt.list((v as MergeGuard[]).map((g) => g.name)) : tr(VT.noneValue)
  if (key === 'reviewers' || key === 'loopRounds' || key === 'maxAgents') return fmt.number(v as number)
  if (key === 'simplifyAt' || key === 'churnStopAt') return v === 0 ? tr(VT.off) : fmt.number(v as number)
  if (key === 'loopWaitHours') return tr(VT.hoursValue, { n: v as number })
  if (key === 'loopStepWaitMinutes') return tr(VT.minutesValue, { n: v as number })
  if (key === 'assistantWakes') {
    const w = v as AssistantWakes
    return w.level === 'custom' ? tr(VT.customWakesValue, { events: w.events.length ? fmt.list(w.events.map((e) => tr(WAKE_EVENT_TEXT[e]))) : tr(VT.noneValue) }) : tr(VALUE_TEXT.assistantWakes[w.level])
  }
  if (key === 'fileLocks') {
    const mode = FILE_LOCK_MODES.find((m) => m.value === v)
    return mode ? tr(mode.text.label) : String(v)
  }
  if (key === 'commands') return Object.keys(v as Record<string, string>).length ? fmt.list(Object.entries(v as Record<string, string>).map(([name, command]) => `${name} (${command})`)) : tr(VT.noneValue) // i18n-ignore: a check's name and command, shown as they are
  if (Array.isArray(v)) return v.length ? fmt.list(v.map(String)) : tr(VT.noneValue)
  if (key === 'target') return (v as string) || tr(VT.defaultBranch)
  // HI-3620: an option left unset (a list emptied, as Other branches work can merge into) has no value: None.
  return v === undefined || v === null ? tr(VT.noneValue) : String(v)
}
