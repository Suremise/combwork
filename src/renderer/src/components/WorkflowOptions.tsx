import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OwnWorkflowProblem, ProjectInfo, WorkflowChange, WorkflowCheck, WorkflowForm, WorkflowLevel, WorkflowLevelCheck, WorkflowOptionOrigin, WorkflowProblem } from '@shared/types'
import type { PlatformId } from '@shared/platform/descriptors'
import { allOff, CONTRADICTIONS, FOCUSED_PICK, FOCUSED_RUN, contradictions, FORM_GROUPS, FORM_OPTIONS, formShows, identityShown, isAllOff, liveContradictions, previewRows, reviewerAgent, setOption, withUnpreset, type OkBefore, type OptionKey, type PresetId, type WorkflowOptions } from '@shared/workflow/options'
import { GROUP_TEXT, optionTitle, OPTION_TEXT, OPTION_WHY, PRESET_NOTE_TEXT, PRESET_SUMMARY, PRESET_TEXT, VALUE_TEXT } from '@shared/workflow/optionTexts'
import { AGENT_LIMIT_DEFAULT, AGENT_LIMIT_MAX, FILE_LOCK_MODES } from '@shared/defaults'
import { ManyAgentsNote } from './ManyAgentsNote'
import { NumberField } from './NumberField'
import { LANE_MAX_ROUNDS, LOOP_STEP_WAIT_MAX_MINUTES, LOOP_WAIT_MAX_HOURS } from '@shared/lanes'
import { compile, mustCompile } from '@shared/workflow/compile'
import { STAGE_TEXT, stageNameProblems, stageNameProblemText, type StageNames } from '@shared/workflow/stages'
import type { StageId } from '@shared/workflow/facts'
import { shownText } from '@shared/advanced'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { agentProviderOf, cardLabelOf, confirm, notify, openVersionControl, set as setStore, setActivity, useStore } from '../store'
import { cx } from '../util'
import { SlotCopyLevel, SlotsAndCopies } from './SlotsAndCopies'
import { ORIGIN_TEXT } from '../workflowOrigins'
import { OriginText } from './OriginText'
import { providerDescriptor } from '@shared/providers'
import { agentWorkflowRole, reviewsWork } from '@shared/workflow/roles'
import { Icon, Switch, Tooltip } from './ui'
import { overlayTemplateWorkflow } from '@shared/workflow/templateOptions'
import { PLATFORM_NAME } from '@shared/platform/switching'

/**
 * The Version Control tab's Workflow section (#1418, SPEC §16.6; P4's plain form before it, #1278): the presets, each
 * with what it sets and why, previewed before it fills the form, and All off; then the options in groups (Review,
 * Checks, Merging, Where cards are built or The work, Stages, and what is shown here but set elsewhere), each worded as
 * an outcome with one sentence on what it does, where its value comes from and, when the project sets it, a way back to
 * inheriting. A value that contradicts another says why under both rows at once and keeps Save off. Edits are a draft
 * until Save, which shows what changes and what keeps the old rules first (§16.6.5), lets the user apply the change to
 * cards in flight (OP-38), and is refused if the options changed meanwhile (the save carries what it was read with).
 */

const T = {
  preset: msg({ id: 'workflow.form.preset', defaultMessage: 'Preset', description: 'A row of Project Settings → Workflow (glossary 2.1: preset): one choice that fills in every option.' }),
  presetDesc: msg({ id: 'workflow.form.presetDesc', defaultMessage: 'Fills in every option at once. Changing an option afterwards makes it Custom.', description: 'Under the row "Preset" of Project Settings → Workflow. Custom is a preset’s name: as translated there.' }),
  startedFrom: msg({ id: 'workflow.form.startedFrom', defaultMessage: 'Custom, started from {preset}', description: 'Project Settings → Workflow: the options were changed after a preset was chosen. {preset} is its name.' }),
  noPreset: msg({ id: 'workflow.form.noPreset', defaultMessage: 'No preset chosen', description: 'The Workflow section’s preset line when the options didn’t start from a preset (glossary 2.1: preset).' }),
  presetsLabel: msg({ id: 'workflow.form.presetsLabel', defaultMessage: 'Presets', description: 'Accessible name of the list of presets in the Workflow section (glossary 2.1: preset).' }),
  allOff: msg({ id: 'workflow.form.allOff', defaultMessage: 'All off', description: 'A choice beside the presets in the Workflow section: every rule off (SPEC §16.6.4).' }),
  allOffSummary: msg({ id: 'workflow.form.allOffSummary', defaultMessage: 'No review, nothing checked, everyone in the project folder: cards move freely, and Combwork still records what happens.', description: 'What the choice “All off” sets up, under its name in the Workflow section.' }),
  previewHead: msg({ id: 'workflow.form.previewHead', defaultMessage: 'What {preset} sets, and why:', description: 'Above the list of options a preset sets, in its preview in the Workflow section (glossary 2.1: preset). {preset} is its name.' }),
  previewChanges: msg({ id: 'workflow.form.previewChanges', defaultMessage: '{n, plural, =0 {Nothing here changes.} one {Marked: the option it changes here.} other {Marked: the # options it changes here.}}', description: 'In a preset’s preview in the Workflow section: how many of the options it sets differ from the form now (those are marked).' }),
  previewNow: msg({ id: 'workflow.form.previewNow', defaultMessage: 'Now: {value}', description: 'In a preset’s preview, beside an option it changes: its value in the form now.' }),
  use: msg({ id: 'workflow.form.use', defaultMessage: 'Use {preset}', description: 'A button in a preset’s preview: fills the form with it (saved only with Save…). {preset} is its name.' }),
  closePreview: msg({ id: 'workflow.form.closePreview', defaultMessage: 'Close', description: 'A button in a preset’s preview: closes it without changing the form.' }),
  neverOffHead: msg({ id: 'workflow.form.neverOffHead', defaultMessage: 'What never turns off, to keep your work safe:', description: 'Above the list of protections that stay on with every rule off (SPEC §16.6.4), in the Workflow section.' }),
  neverOff: {
    fileLocks: msg({ id: 'workflow.form.neverOff.fileLocks', defaultMessage: 'File locks, while their own setting has them on.', description: 'A protection that stays on with every rule off: agents can’t edit one file at once (its own setting decides).' }),
    indexLock: msg({ id: 'workflow.form.neverOff.indexLock', defaultMessage: 'Combwork never deletes git’s index.lock.', description: 'A protection that stays on with every rule off. Keep index.lock (a file name).' }),
    folderGit: msg({ id: 'workflow.form.neverOff.folderGit', defaultMessage: 'No branch switch, pull or other git that changes the folder while an agent works there.', description: 'A protection that stays on with every rule off.' }),
    queue: msg({ id: 'workflow.form.neverOff.queue', defaultMessage: 'The merge queue moves a target branch only if nothing else moved it meanwhile.', description: 'A protection that stays on with every rule off (glossary 2.1: merge queue).' })
  },
  from: ORIGIN_TEXT,
  inherit: msg({ id: 'workflow.form.inherit', defaultMessage: 'Inherit', description: 'A button beside a workflow option set for this project: stop setting it here, and use the workspace’s or Combwork’s value.' }),
  inheritTip: msg({ id: 'workflow.form.inheritTip', defaultMessage: 'Use the inherited value: {value}', description: 'The tooltip of the Inherit button of a workflow option. {value} is the value it would have.' }),
  on: msg({ id: 'workflow.form.on', defaultMessage: 'On', description: 'A workflow option’s value: on.' }),
  off: msg({ id: 'workflow.form.off', defaultMessage: 'Off', description: 'A workflow option’s value: off.' }),
  focusedPick: msg({ id: 'workflow.form.focusedPick', defaultMessage: 'Command that chooses the tests (optional)', description: 'The placeholder and label of a field under “Each card’s focused tests” (G20) in Project Settings → Workflow: the project’s command that lists the tests a change needs. Left empty, each card’s builder names its tests.' }),
  focusedRun: msg({ id: 'workflow.form.focusedRun', defaultMessage: 'Command that runs them', description: 'The placeholder and label of a field under “Each card’s focused tests” (G20) in Project Settings → Workflow: the project’s command that runs a list of tests.' }),
  defaultBranch: msg({ id: 'workflow.form.defaultBranch', defaultMessage: 'The repository’s default branch', description: 'The placeholder of the target branch field in Project Settings → Workflow: left empty, the default branch.' }),
  labels: msg({ id: 'workflow.form.labels', defaultMessage: 'Labels, separated by commas', description: 'The placeholder of the labels field of “Your OK before merging”.' }),
  noIdentity: msg({ id: 'workflow.form.noIdentity', defaultMessage: 'No name and email are set in git config yet.', description: 'Under “Commits use the project’s identity” when git has no identity configured.' }),
  identity: msg({ id: 'workflow.form.identity', defaultMessage: 'Commits as {name} <{email}>.', description: 'Under “Commits use the project’s identity”: the identity used, from git config.' }),
  checkName: msg({ id: 'workflow.form.checkName', defaultMessage: 'Name', description: 'The placeholder of a check’s name field (Project Settings → Workflow → Checks pass before review).' }),
  checkCommand: msg({ id: 'workflow.form.checkCommand', defaultMessage: 'Command', description: 'The placeholder of a check’s command field (Project Settings → Workflow → Checks pass before review).' }),
  addCheck: msg({ id: 'workflow.form.addCheck', defaultMessage: 'Add Check', description: 'A button under the checks of “Checks pass before review”.' }),
  removeCheck: msg({ id: 'workflow.form.removeCheck', defaultMessage: 'Remove', description: 'The tooltip of the button removing a check from “Checks pass before review”.' }),
  labelsValue: msg({ id: 'workflow.form.labelsValue', defaultMessage: 'Cards with these labels: {labels}', description: 'A value of “Your OK before merging” in the list of what changes before saving workflow options. {labels} is a list of card labels.' }),
  identityValue: msg({ id: 'workflow.form.identityValue', defaultMessage: 'On, as {name} <{email}>', description: 'A value of “Commits use the project’s identity” in the list of what changes before saving workflow options: on, with the name and email commits use.' }),
  noneValue: msg({ id: 'workflow.form.noneValue', defaultMessage: 'None', description: 'An empty value in the list of what changes before saving workflow options: no checks, no commands, no folders.' }),
  noChecks: msg({ id: 'workflow.form.noChecks', defaultMessage: 'No checks.', description: 'Under “Checks pass before review” when it has none.' }),
  folders: msg({ id: 'workflow.form.folders', defaultMessage: 'Folders and files, separated by commas', description: 'The placeholder of the field “What the work is” (folders and files left out).' }),
  carried: msg({ id: 'workflow.form.carried', defaultMessage: 'Agents’ old worktrees finish their current work first: {agents}. Then they work in slots too.', description: 'Under “Where cards are built” (G11) while agents still hold their worktrees from before 1.0 (#1441), kept until their current card or lane ends. {agents} is a list of agent names (glossary 2.5: slot).' }),
  readOnly: msg({ id: 'workflow.form.readOnly', defaultMessage: '{agents} can’t be given review copies by their coding agent, so they review the builder’s folder read-only.', description: 'Under “Reviewers” (G17) when some reviewing agents use a coding agent that Combwork can’t give review copies (folders at the exact revision, glossary 2.5: review copy). {agents} is a list of agent names.' }),
  stageName: msg({ id: 'workflow.form.stageName', defaultMessage: 'Name of the stage {stage}', description: 'Accessible name of a stage’s name box under “Stage names” (glossary 2.2: stage). {stage} is its default name.' }),
  stageNamesValue: msg({ id: 'workflow.form.stageNamesValue', defaultMessage: '{n, plural, =0 {The default names} one {# stage renamed} other {# stages renamed}}', description: 'A value of “Stage names” in the list of what changes before saving workflow options, and in a preset’s preview (glossary 2.2: stage).' }),
  fileLocksNote: msg({ id: 'workflow.form.fileLocksNote', defaultMessage: 'Applies to agents working in the same folder, outside a slot.', description: 'Under the workflow option “File locks”: a slot is a folder Combwork lends to a card or its lane (glossary 2.5: slot), so agents in different slots never share a file.' }),
  loopsReadNote: msg({ id: 'workflow.form.loopsReadNote', defaultMessage: 'Read when a loop starts: a loop already running keeps its own, and one started with its own (“rounds: 5, wait: 2h”) keeps those.', description: 'Under the workflow options “Rounds” and “Wait (hours)” (Card loops), when a change applies. “rounds: 5, wait: 2h” is what the user types to an agent: keep it in English.' }),
  overMax: msg({ id: 'workflow.form.overMax', defaultMessage: 'This project has {count, plural, one {# agent} other {# agents}}: none is removed, but no agent can be added until it has fewer than {max, number}.', description: 'Under the workflow option “Maximum agents” (HI-2001) when the project already has more agents ({count}) than it is set to ({max}): nobody can add one (HI-2058), neither the user nor the Assistant.' }),
  stepWaitNote: msg({ id: 'workflow.form.stepWaitNote', defaultMessage: 'A design left unchecked longer shows its card as stalled; one already posted keeps its wait.', description: 'Under the workflow option “Design check wait (minutes)” (Card loops), when a change applies.' }),
  hoursValue: msg({ id: 'workflow.form.hoursValue', defaultMessage: '{n, plural, one {# hour} other {# hours}}', description: 'The value of the workflow option “Wait (hours)” (Card loops) in words, as in the Inherit box and a preset preview.' }),
  minutesValue: msg({ id: 'workflow.form.minutesValue', defaultMessage: '{n, plural, one {# minute} other {# minutes}}', description: 'The value of the workflow option “Design check wait (minutes)” (Card loops) in words, as in the Inherit box.' }),
  notEnforced: msg({ id: 'workflow.form.notEnforced', defaultMessage: 'Workflow rules aren’t enforced (Settings → Advanced). These options are saved, and apply once the rules are enforced again.', description: 'A note atop Project Settings → Workflow while the switch "Workflow rules are enforced" is off.' }),
  invalid: msg({ id: 'workflow.form.invalid', defaultMessage: 'These options can’t be used, so every rule is off in this project:', description: 'A note atop Project Settings → Workflow: the saved options contradict each other or can’t be read; the reason follows.' }),
  save: msg({ id: 'workflow.form.save', defaultMessage: 'Save…', description: 'The button saving the workflow options (it shows what changes first).' }),
  saveBlocked: msg({ id: 'workflow.form.saveBlocked', defaultMessage: 'Resolve what the options say first.', description: 'The tooltip of Save… in the Workflow section while some options contradict each other (their reasons are shown under them).' }),
  discard: msg({ id: 'workflow.form.discard', defaultMessage: 'Discard Changes', description: 'The button dropping unsaved changes to the workflow options.' }),
  copy: msg({ id: 'workflow.form.copy', defaultMessage: 'Copy as JSON', description: 'The button copying the project’s workflow options as JSON, to paste into another project.' }),
  copied: msg({ id: 'workflow.form.copied', defaultMessage: 'Workflow options copied', description: 'A notification: the workflow options were copied to the clipboard.' }),
  paste: msg({ id: 'workflow.form.paste', defaultMessage: 'Paste JSON…', description: 'The button pasting workflow options copied from another project.' }),
  pasteTitle: msg({ id: 'workflow.form.pasteTitle', defaultMessage: 'Paste Workflow Options', description: 'The title of the dialog pasting workflow options as JSON.' }),
  pasteMessage: msg({ id: 'workflow.form.pasteMessage', defaultMessage: 'Paste options copied from a project with the same version control. They replace the form’s, to save afterwards.', description: 'The message of the dialog pasting workflow options as JSON.' }),
  pasteApply: msg({ id: 'workflow.form.pasteApply', defaultMessage: 'Use These Options', description: 'The confirm button of the dialog pasting workflow options.' }),
  pasteBad: msg({ id: 'workflow.form.pasteBad', defaultMessage: 'That isn’t workflow options copied from Combwork.', description: 'An error pasting workflow options: the text isn’t the JSON Combwork copies.' }),
  pastePlatform: msg({ id: 'workflow.form.pastePlatform', defaultMessage: 'These options are for another version control.', description: 'An error pasting workflow options: they were copied from a project with another version control.' }),
  cantSave: msg({ id: 'workflow.form.cantSave', defaultMessage: 'These options can’t be saved:', description: 'Above the reasons the workflow options can’t be saved, each a sentence of its own.' }),
  confirmTitle: msg({ id: 'workflow.form.confirmTitle', defaultMessage: 'Save Workflow Options', description: 'The title of the dialog before saving workflow options.' }),
  confirmMessage: msg({ id: 'workflow.form.confirmMessage', defaultMessage: 'The new options apply from the next card that starts.', description: 'The message of the dialog before saving workflow options.' }),
  appliesNow: msg({ id: 'workflow.form.appliesNow', defaultMessage: 'Only the stage names change: names aren’t rules, so they apply now, to every card.', description: 'The message of the dialog before saving workflow options when only stage names change (glossary 2.2: stage).' }),
  changesHead: msg({ id: 'workflow.form.changesHead', defaultMessage: 'What changes:', description: 'In the dialog before saving workflow options: above the list of options that change, each with its old and new value.' }),
  changeLine: msg({ id: 'workflow.form.changeLine', defaultMessage: '{option}: {from} → {to}', description: 'A line of the list of what changes, in the dialog before saving workflow options: an option’s name, its value now and its new value.' }),
  noChanges: msg({ id: 'workflow.form.noChanges', defaultMessage: 'No option changes: only the preset they started from.', description: 'In the dialog before saving workflow options, when no option’s value changes.' }),
  lanes: msg({ id: 'workflow.form.lanes', defaultMessage: '{n, plural, one {This running lane keeps the old rules until it ends:} other {These running lanes keep the old rules until they end:}}', description: 'In the dialog before saving workflow options, above a list of lanes (glossary 2.1: old rules).' }),
  lane: msg({ id: 'workflow.form.lane', defaultMessage: 'Builder {builder}: {name}', description: 'A running lane in the dialog before saving workflow options: its builder agent and its name.' }),
  laneUnnamed: msg({ id: 'workflow.form.laneUnnamed', defaultMessage: 'Builder {builder}', description: 'A running lane without a name in the dialog before saving workflow options: its builder agent.' }),
  inFlight: msg({ id: 'workflow.form.inFlight', defaultMessage: '{n, plural, one {This card in flight keeps the old rules. Tick it to apply the new options to it now.} other {These cards in flight keep the old rules. Tick one to apply the new options to it now.}}', description: 'In the dialog before saving workflow options, above the cards already started (glossary 2.1: old rules). Ticking a card records an override on it.' }),
  fromTemplate: msg({ id: 'workflow.form.fromTemplateDraft', defaultMessage: 'Filled in from the template {template}: these options aren’t saved yet. Check them, then Save… (they apply from the next card), or Discard Changes.', description: "A note atop the Workflow section (HI-1910, HI-2083) after loading a template whose workflow was applied and saved nothing of it: its options are filled in but not saved. Save… and Discard Changes are the buttons below: as translated there." }),
  fromTemplateMax: msg({ id: 'workflow.form.fromTemplateMax', defaultMessage: 'Filled in from the template {template}. Its Maximum agents ({max, number}) is saved already, with its agents; the other options aren’t saved yet. Check them, then Save… (they apply from the next card), or Discard Changes.', description: "A note atop the Workflow section (HI-2083) after loading a template whose workflow was applied: the load saved its Maximum agents ({max}) with its agents (HI-2058), the rest is filled in but not saved. Maximum agents, Save… and Discard Changes are names in the form: as translated there." }),
  templateNoCommand: msg({ id: 'workflow.form.templateNoCommand', defaultMessage: '{count, plural, one {This project has no command for the check {checks} yet: add it under Checks before cards need it.} other {This project has no commands for the checks {checks} yet: add them under Checks before cards need them.}}', description: "A note atop the Workflow section (HI-1910), with the template's options filled in: checks ({checks}, a list of names; {count} of them) have no command in this project. Checks is the group below: as translated there. Glossary: check." }),
  templateIdentityOff: msg({ id: 'workflow.form.templateIdentityOff', defaultMessage: 'The template turns the project identity on, but this project’s git config has no name and email, so it stays off.', description: "A note atop the Workflow section (HI-1910), with a template's options filled in: it turns the project identity (G12) on, but the project's git config has none. Glossary: identity." }),
  templateOtherPlatform: msg({ id: 'workflow.form.templateOtherPlatform', defaultMessage: 'The workflow of {template} is for {platform}, and {project} doesn’t use it now, so it wasn’t filled in.', description: "A notification (HI-1910): a loaded template's workflow ({template}) is for a version control ({platform}: None or Git) the project ({project}) no longer uses (switched meanwhile)." }),
  saved: msg({ id: 'workflow.form.saved', defaultMessage: 'Workflow options saved', description: 'A notification: the workflow options were saved.' }),
  inheritor: msg({ id: 'workflow.form.inheritor', defaultMessage: 'Project {project} inherits these options, and the change would make its options contradict each other:', description: 'Why saving workflow defaults was refused: a project inheriting them would have contradictory options. Its reason follows on its own line. {project} is its name.' }),
  levelConfirm: msg({ id: 'workflow.form.levelConfirm', defaultMessage: 'Projects that don’t set these options themselves use the new defaults from their next card.', description: 'The message of the dialog before saving workflow defaults (Settings → Workflow defaults or Settings → Workspace).' }),
  heirs: msg({ id: 'workflow.form.heirs', defaultMessage: '{n, plural, one {This project inherits the change:} other {These # projects inherit the change:}}', description: 'In the dialog before saving workflow defaults, above the projects that use them (they don’t set the changed options themselves).' }),
  noHeirs: msg({ id: 'workflow.form.noHeirs', defaultMessage: 'No project inherits the change now: each sets these options itself, or none uses this version control.', description: 'In the dialog before saving workflow defaults, when no open project uses the changed options.' }),
  heir: msg({ id: 'workflow.form.heir', defaultMessage: 'Project {project}: {options}', description: 'A project inheriting a change of workflow defaults, in the dialog before saving them: its name, then the options that change for it, as a list.' }),
  heirElsewhere: msg({ id: 'workflow.form.heirElsewhere', defaultMessage: 'Project {project} (workspace {workspace}): {options}', description: 'A project of another open workspace inheriting a change of Combwork’s workflow defaults, in the dialog before saving them: its name, its workspace’s name, then the options that change for it, as a list.' }),
  heirLanes: msg({ id: 'workflow.form.heirLanes', defaultMessage: '{n, plural, one {Its running lane keeps the old rules until it ends:} other {Its # running lanes keep the old rules until they end:}}', description: 'Under a project inheriting a change of workflow defaults, in the dialog before saving them, above a list of those lanes (glossary 2.1: old rules).' }),
  heirCards: msg({ id: 'workflow.form.heirCards', defaultMessage: '{n, plural, one {Its card in flight keeps the old rules:} other {Its # cards in flight keep the old rules:}}', description: 'Under a project inheriting a change of workflow defaults, in the dialog before saving them: its cards already started, listed below (glossary 2.1: old rules).' }),
  levelPlatform: msg({ id: 'workflow.form.levelPlatform', defaultMessage: 'Version control', description: 'Accessible name of the None · Git choice above workflow defaults: which version control’s defaults are shown (glossary 2.1).' }),
  levelNone: msg({ id: 'workflow.form.levelNone', defaultMessage: 'None', description: 'The choice of the defaults for projects without version control (glossary 2.1: None).' }),
  levelGit: msg({ id: 'workflow.form.levelGit', defaultMessage: 'Git', description: 'The choice of the defaults for Git projects (glossary 2.1: keep).' }),
  levelForNone: msg({ id: 'workflow.form.levelForNone', defaultMessage: 'The defaults of projects without version control.', description: 'Beside the None · Git choice above workflow defaults, while None is chosen.' }),
  levelForGit: msg({ id: 'workflow.form.levelForGit', defaultMessage: 'The defaults of Git projects.', description: 'Beside the None · Git choice above workflow defaults, while Git is chosen.' }),
  changedMeanwhile: msg({ id: 'workflow.form.changedMeanwhile', defaultMessage: 'The workflow options changed meanwhile, so nothing was saved. They’re shown as they are now.', description: 'A notification: saving the Workflow section was refused because the options changed after it was read (in another window, or by the Combwork Assistant); the section reloads them.' }),
  loadFailed: msg({ id: 'workflow.form.loadFailed', defaultMessage: 'Couldn’t read the workflow options: {error}', description: 'An error showing Project Settings → Workflow. {error} says why.' })
}

/** A problem's sentence, in the window's language (an English reason when it has no message). */
const ownProblemText = (p: OwnWorkflowProblem): string => (p.kind === 'contradiction' ? tr(CONTRADICTIONS[p.id]) : p.kind === 'stageName' ? shownText(stageNameProblemText(p)) : p.why)

/** A problem's lines: an inheriting project's (a level's save, #1422) names it, its reason on a line of its own. */
const problemLines = (p: WorkflowProblem): string[] => (p.kind === 'inheritor' ? [tr(T.inheritor, { project: p.project }), ownProblemText(p.problem)] : [ownProblemText(p)])
export const problemText = (p: WorkflowProblem): string => problemLines(p).join('\n')

/**
 * Where the editor's options come from and go to (#1422): a project's (the Version Control tab's Workflow section) or a
 * level's defaults (Hive's in Settings → Workflow defaults, the workspace's in Settings → Workspace). `key` scopes what
 * is shown: another source's read never shows.
 */
export interface FormSource {
  key: string
  level: WorkflowLevel | null
  read: () => Promise<WorkflowForm>
  check: (change: WorkflowChange) => Promise<WorkflowCheck | WorkflowLevelCheck>
  save: (change: WorkflowChange, applyTo: number[]) => Promise<WorkflowForm>
}

/** The JSON Copy as JSON gives: the version control, the preset and every option in force. */
interface CopiedOptions {
  hiveWorkflow: 1
  platform: WorkflowOptions['platform']
  preset: PresetId | null
  options: Partial<WorkflowOptions>
}

/** A choice the preset area previews: a preset, or All off (§16.6.4). */
export type Choice = PresetId | 'allOff'

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const list = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

/** Options without their platform, as a draft keeps them. */
const ownOptions = (o: WorkflowOptions): Partial<WorkflowOptions> => {
  const { platform: _p, ...rest } = o
  return rest
}

/** Whether the project's own preset and options are still those the form was read with (keys in any order). */
const sameOwn = (a: { preset: PresetId | null; options: Partial<WorkflowOptions> }, b: { preset: PresetId | null; options: Partial<WorkflowOptions> }): boolean => {
  const sorted = (o: object): string => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y))))
  return a.preset === b.preset && sorted(a.options) === sorted(b.options)
}

/** A project's options, in its Version Control tab. */
export function WorkflowOptionsForm({ project }: { project: ProjectInfo }) {
  const path = project.path
  const source = useMemo(
    (): FormSource => ({
      key: path,
      level: null,
      read: () => call('workflow:form', path),
      check: (change) => call('workflow:check', path, change),
      save: (change, applyTo) => call('workflow:setOptions', path, change, { applyTo })
    }),
    [path]
  )
  return <WorkflowEditor source={source} project={project} />
}

/**
 * A level's workflow defaults (#1422): Hive's (Settings → Workflow defaults) or the workspace's (Settings → Workspace),
 * for None or for Git, in the project form's editor: the same groups and checks, each option inheriting from the level
 * below (the workspace's from Hive's, Hive's from every rule off).
 */
export function WorkflowLevelForm({ level, onDirty }: { level: WorkflowLevel; onDirty?: (dirty: boolean) => void }) {
  const [platform, setPlatform] = useState<PlatformId>('git')
  const workspacePath = useStore((s) => s.workspace?.path ?? '')
  const source = useMemo(
    (): FormSource => ({
      key: `${level}:${platform}:${level === 'workspace' ? workspacePath : ''}`,
      level,
      read: () => call('workflow:levelForm', level, platform),
      check: (change) => call('workflow:levelCheck', level, platform, change),
      save: (change) => call('workflow:setLevel', level, platform, change)
    }),
    [level, platform, workspacePath]
  )
  return (
    <div className="workflow-level" data-level={level}>
      <div className="workflow-level-head">
        <div className="segmented workflow-level-platform" role="radiogroup" aria-label={tr(T.levelPlatform)}>
          {(['none', 'git'] as const).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={platform === p} className={cx(platform === p && 'active')} data-platform={p} onClick={() => setPlatform(p)}>
              {tr(p === 'git' ? T.levelGit : T.levelNone)}
            </button>
          ))}
        </div>
        <span className="s-desc">{tr(platform === 'git' ? T.levelForGit : T.levelForNone)}</span>
      </div>
      <WorkflowEditor source={source} project={null} onDirty={onDirty} />
    </div>
  )
}

/**
 * The editor: a project's options or a level's defaults (`source`), with `project` for a project's own rows; `onDirty`
 * hears whether its draft is unsaved (Settings → Version Control marks its tab, HI-1837).
 */
function WorkflowEditor({ source, project, onDirty }: { source: FormSource; project: ProjectInfo | null; onDirty?: (dirty: boolean) => void }) {
  // The form as read and its draft, kept with the project they are for: another project's never shows (HR5's round 1).
  const [loaded, setLoaded] = useState<{ for: string; form: WorkflowForm; draft: WorkflowChange } | null>(null)
  const [failed, setFailed] = useState<{ for: string; error: string } | null>(null)
  const [problems, setProblems] = useState<WorkflowProblem[]>([])
  const [preview, setPreview] = useState<Choice | null>(null)
  const settings = useStore((s) => s.settings)
  const version = useStore((s) => s.workflowVersion)
  /** The project shown now (a read's answer for another is dropped), the newest read's number, and the draft's edits. */
  const pathRef = useRef(source.key)
  pathRef.current = source.key
  const reads = useRef(0)
  const edits = useRef(0)
  const shownFor = useRef<string | null>(null)
  const dirtyRef = useRef(false)
  const form = loaded?.for === source.key ? loaded.form : null
  /** Whether the shown project's form is on screen (a failed reload keeps it, with any edits). */
  const hasForm = useRef(false)
  hasForm.current = !!form
  const draft = loaded?.for === source.key ? loaded.draft : null
  const error = failed?.for === source.key ? failed.error : null

  /** The form as read (or saved) for a project, its draft reset to it; any read still under way is outdated by it. */
  const show = useCallback((path: string, f: WorkflowForm): void => {
    reads.current++
    if (pathRef.current !== path) return
    setLoaded({ for: path, form: f, draft: { preset: f.preset, options: { ...f.own } } })
    setProblems([])
    setFailed(null)
  }, [])
  /** An edit of the draft (by the user: a reload under way never replaces it). */
  const setDraft = (change: WorkflowChange): void => {
    edits.current++
    setLoaded((l) => (l && l.for === pathRef.current ? { ...l, draft: change } : l))
  }
  /**
   * Reads the project's form. Only the newest read's answer is shown, and only while its project is shown; a reload
   * (`auto`: the options changed elsewhere) is dropped if the draft was edited while it waited, and its failure leaves
   * the form shown as it is.
   */
  const load = useCallback(
    async (auto: boolean): Promise<void> => {
      const path = source.key
      const n = ++reads.current
      const edited = edits.current
      try {
        const f = await source.read()
        if (n !== reads.current || pathRef.current !== path || (auto && edits.current !== edited)) return
        show(path, f)
      } catch (e) {
        // A reload that fails keeps the form shown, and the edits in it (HR5's round 2): its save is still checked
        // against what is saved. Only a first read's failure, with no form to show, is said in its place.
        if (n !== reads.current || pathRef.current !== path || (auto && hasForm.current)) return
        setFailed({ for: path, error: errorMessage(e) })
      }
    },
    [source, show]
  )
  // Read for each project, and again when its options change elsewhere (`workflow-changed`: the Assistant's tool, another
  // window) while nothing here is unsaved; unsaved edits stay, and their Save is refused as changed meanwhile.
  useEffect(() => {
    const again = shownFor.current === source.key
    shownFor.current = source.key
    if (!again) {
      setPreview(null)
      setProblems([])
    }
    if (again && dirtyRef.current) return
    void load(again)
  }, [load, source.key, version])
  // "How do you work?"'s Customise… (#1423): the preset filled in once the project's form is read, not saved. A loaded
  // template's workflow (HI-1910): the project's options read again, its section laid over them, not saved either.
  const prefill = useStore((s) => s.workflowPrefill)
  const [fromTemplate, setFromTemplate] = useState<{ for: string; name: string; identityOff: boolean; savedMax?: number } | null>(null)
  useEffect(() => {
    if (!prefill || source.level || prefill.path !== source.key || loaded?.for !== source.key) return
    setStore({ workflowPrefill: null })
    const t = prefill.template
    if (t) {
      const path = source.key
      // HI-2033: the form is shown while this read waits; an edit made meanwhile (a preset chosen) is the user's and
      // stays, as with a reload (`load`), rather than be replaced by the template's options under the same preset.
      const edited = edits.current
      void source.read().then(
        (f) => {
          if (pathRef.current !== path || edits.current !== edited) return
          show(path, f)
          if (f.platform !== t.platform) return notify('warning', tr(T.templateOtherPlatform, { template: t.name, platform: tr(PLATFORM_NAME[t.platform]), project: project?.name ?? '' }))
          const o = overlayTemplateWorkflow(t.section, { platform: f.platform, options: f.options, own: f.own, identity: f.identity })
          setDraft({ preset: o.preset, options: o.own })
          setFromTemplate({ for: path, name: t.name, identityOff: o.identityOff, ...(t.savedMax !== undefined ? { savedMax: t.savedMax } : {}) })
        },
        (e) => notify('error', errorMessage(e))
      )
      return
    }
    const p = prefill.preset ? loaded.form.presets.find((x) => x.id === prefill.preset)?.options : null
    if (p) setDraft({ preset: prefill.preset, options: withUnpreset(ownOptions(p), loaded.draft.options) })
  }, [prefill, loaded, source, show, project])

  const effective = useMemo((): WorkflowOptions | null => (form && draft ? ({ ...form.inherited, ...draft.options, platform: form.platform } as WorkflowOptions) : null), [form, draft])
  const dirty = !!form && !!draft && (draft.preset !== form.preset || !same(draft.options, form.own))
  dirtyRef.current = dirty
  useEffect(() => onDirty?.(dirty), [onDirty, dirty])
  if (error) return <div className="s-desc error">{tr(T.loadFailed, { error })}</div>
  if (!form || !draft || !effective) return null
  const platform = form.platform
  const presetOf = (id: PresetId | null): WorkflowOptions | null => form.presets.find((p) => p.id === id)?.options ?? null
  const presetOptions = presetOf(draft.preset)
  const custom = !!presetOptions && FORM_OPTIONS[platform].some((k) => !same(presetOptions[k], effective[k]))
  const live = liveContradictions(effective)
  const stageProblems = stageNameProblems(effective.stageNames, tr)
  const blocked = contradictions(effective).length > 0 || stageProblems.length > 0
  const set = <K extends OptionKey>(key: K, value: WorkflowOptions[K]): void => setDraft({ ...draft, options: setOption(draft.options, effective, key, value) })
  const inheritKey = (key: OptionKey): void => {
    const { [key]: _gone, ...rest } = draft.options
    setDraft({ ...draft, options: rest })
  }
  /** The options a choice fills in; the stage names (N5) and preferences (HI-1766) aren't rules, so the draft's own stay (#1417). */
  const choiceOptions = (c: Choice): WorkflowOptions | null => (c === 'allOff' ? allOff(platform) : presetOf(c))
  const choose = (c: Choice): void => {
    const p = choiceOptions(c)
    if (!p) return
    setDraft({ preset: c === 'allOff' ? null : c, options: withUnpreset(ownOptions(p), draft.options) })
    setPreview(null)
  }
  const originOf = (key: OptionKey): WorkflowOptionOrigin | 'preset' | 'here' => {
    if (!(key in draft.options)) return form.inheritedOrigins[key]
    return presetOptions && same(presetOptions[key], draft.options[key]) ? 'preset' : source.level ? 'here' : 'project'
  }

  const save = async (): Promise<void> => {
    // What the form was read with: the save is refused if the project's options are no longer these (#1418).
    const change: WorkflowChange = { ...draft, base: { preset: form.preset, options: form.own } }
    const check = await source.check(change)
    setProblems(check.problems)
    if (check.problems.length) return
    // Each option that changes, its value now and its new one (the Assistant for Darren: a list, never one sentence).
    const changes = check.changed.flatMap((k) => {
      const title = k === 'platform' ? null : (optionTitle(k, platform, effective.folder) ?? OPTION_TEXT[k]?.title)
      return title && k !== 'platform' ? [tr(T.changeLine, { option: tr(title), from: valueText(k, form.options[k]), to: valueText(k, effective[k]) })] : []
    })
    const picked = new Set<number>()
    let stale = false
    const ok = await confirm({
      title: tr(T.confirmTitle),
      message: tr(source.level ? T.levelConfirm : check.appliesNow ? T.appliesNow : T.confirmMessage),
      wide: true,
      content: <SaveDetails changes={changes} check={check} picked={picked} title={(k) => tr(optionTitle(k, platform, effective.folder) ?? OPTION_TEXT[k]!.title)} />,
      confirmLabel: tr(T.save).replace(/…$/, ''),
      run: async () => {
        const path = source.key
        try {
          show(path, await source.save(change, [...picked]))
        } catch (e) {
          // Changed meanwhile (the Assistant's tool, another window): never written over; shown as it is now.
          const now = await source.read().catch(() => null)
          if (!now || sameOwn({ preset: now.preset, options: now.own }, { preset: form.preset, options: form.own })) throw e
          stale = true
          show(path, now)
        }
      }
    })
    if (stale) notify('warning', tr(T.changedMeanwhile))
    else if (ok) notify('success', tr(T.saved))
  }
  const copy = (): void => {
    const { platform: p, ...options } = effective
    const out: CopiedOptions = { hiveWorkflow: 1, platform: p, preset: draft.preset, options }
    void navigator.clipboard.writeText(JSON.stringify(out, null, 2)).then(() => notify('success', tr(T.copied)))
  }
  const paste = async (): Promise<void> => {
    let text = ''
    await confirm({
      title: tr(T.pasteTitle),
      message: tr(T.pasteMessage),
      wide: true,
      content: <textarea className="input mono workflow-paste" rows={10} onChange={(e) => (text = e.target.value)} />,
      confirmLabel: tr(T.pasteApply),
      run: async () => {
        let v: Partial<CopiedOptions> | null = null
        try {
          v = JSON.parse(text) as Partial<CopiedOptions>
        } catch {
          v = null
        }
        if (!v || v.hiveWorkflow !== 1 || !v.options || typeof v.options !== 'object') throw new Error(tr(T.pasteBad))
        if (v.platform !== platform) throw new Error(tr(T.pastePlatform))
        const change: WorkflowChange = { preset: v.preset ?? null, options: v.options }
        // Checked as a save would check it (OP-5): refused with its reasons, else it fills the form, to save.
        const check = await source.check(change)
        if (check.problems.length) throw new Error([tr(T.cantSave), ...check.problems.map(problemText)].join('\n'))
        setDraft(change)
        setProblems([])
      }
    })
  }

  /** A value in words: the Inherit button's tooltip, what a save changes, a preset's preview. */
  // G12 as git's identity now (HI-2269), never a saved copy that may be stale.
  const valueText = (key: OptionKey, v: unknown): string => optionValueText(key, key === 'identity' ? identityShown(v, form.identity) : v, platform)

  const rowOf = (key: OptionKey): React.ReactNode => {
    const title = optionTitle(key, platform, effective.folder)
    const text = OPTION_TEXT[key]
    if (!title || !text || !formShows(key, effective)) return null
    // A level has no project identity to use (G12 is a project’s own).
    if (key === 'identity' && source.level) return null
    const origin = originOf(key)
    const reasons = live[key] ?? []
    const stageReasons = key === 'stageNames' ? stageProblems : []
    return (
      <div className={cx('setting', 'workflow-option', (reasons.length > 0 || stageReasons.length > 0) && 'contradicted')} key={key} data-option={key}>
        <div className="s-text">
          <div className="s-title">
            {key in draft.options && <span className="modified" />}
            {tr(title)}
          </div>
          <div className="s-desc">{tr(text.desc)}</div>
          {controlNote(key)}
          <div className="s-desc workflow-origin">
            <OriginText origin={origin} />
            {key in draft.options && (
              <Tooltip content={tr(T.inheritTip, { value: valueText(key, form.inherited[key]) })}>
                <button className="btn subtle small workflow-inherit" onClick={() => inheritKey(key)}>
                  {tr(T.inherit)}
                </button>
              </Tooltip>
            )}
          </div>
          {reasons.map((c) => (
            <div className="workflow-contradiction" role="alert" data-contradiction={c} key={c}>
              <Icon name="warning" /> {tr(CONTRADICTIONS[c])}
            </div>
          ))}
          {stageReasons.map((p) => (
            <div className="workflow-contradiction" role="alert" data-stage-problem={`${p.stage}:${p.why}`} key={`${p.stage}:${p.why}`}>
              <Icon name="warning" /> {shownText(stageNameProblemText(p))}
            </div>
          ))}
        </div>
        <div className="s-control">{controlOf(key)}</div>
      </div>
    )
  }
  const select = <K extends OptionKey>(key: K, values: [string, string][], convert: (s: string) => WorkflowOptions[K] = (s) => s as WorkflowOptions[K]): React.ReactNode => (
    <select className="select" value={String(effective[key])} onChange={(e) => set(key, convert(e.target.value))}>
      {values.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  )
  const controlNote = (key: OptionKey): React.ReactNode => {
    if (key === 'identity') return <div className="s-desc">{form.identity ? tr(T.identity, { name: form.identity.name, email: form.identity.email }) : tr(T.noIdentity)}</div>
    // Agents still on their worktrees from before 1.0 (#1441) finish their current work there first.
    const carried = project?.agents.filter((a) => a.carriedSlot) ?? []
    if (key === 'folder' && effective.folder === 'slots' && carried.length) return <div className="s-desc" data-note="carried">{tr(T.carried, { agents: fmt.list(carried.map((a) => a.name)) })}</div>
    // A reviewer whose CLI can't be given folders reviews the builder's folder read-only (§16.10.5).
    const readOnly = project?.agents.filter((a) => reviewsWork(agentWorkflowRole(a)) && !providerDescriptor(agentProviderOf(a)).capabilities.extraDirs) ?? []
    if (key === 'reviewerMode' && readOnly.length) return <div className="s-desc" data-note="read-only">{tr(T.readOnly, { agents: fmt.list(readOnly.map((a) => a.name)) })}</div>
    // The preferences (HI-1766): where file locks apply, and when a change reaches a loop.
    if (key === 'fileLocks') return <div className="s-desc" data-note="file-locks">{tr(T.fileLocksNote)}</div>
    if (key === 'loopRounds' || key === 'loopWaitHours') return <div className="s-desc" data-note="loop-read">{tr(T.loopsReadNote)}</div>
    if (key === 'loopStepWaitMinutes') return <div className="s-desc" data-note="step-wait">{tr(T.stepWaitNote)}</div>
    // Maximum agents (HI-2001): above the default, what more agents cost here; below the agents there are, that none go.
    if (key === 'maxAgents') {
      const max = effective.maxAgents ?? AGENT_LIMIT_DEFAULT
      const count = project?.agents.length ?? 0
      return (
        <>
          {max > AGENT_LIMIT_DEFAULT && <ManyAgentsNote />}
          {count > max && <div className="s-desc" data-note="over-max">{tr(T.overMax, { count, max })}</div>}
        </>
      )
    }
    return null
  }
  const controlOf = (key: OptionKey): React.ReactNode => {
    const V = VALUE_TEXT
    switch (key) {
      case 'review':
        return select('review', [
          ['none', tr(platform === 'none' ? V.review.noneNone : V.review.none)],
          ['agent', tr(V.review.agent)],
          ['agentThenYou', tr(V.review.agentThenYou)],
          ['you', tr(V.review.you)]
        ])
      case 'reviewers':
        return select('reviewers', [['1', fmt.number(1)], ['2', fmt.number(2)]], (s) => (s === '2' ? 2 : 1))
      case 'sameness':
        return select('sameness', [['change', tr(V.sameness.change)], ['exact', tr(V.sameness.exact)]])
      case 'finish':
        // Hive merges since P5's queue (#1355).
        return select('finish', [['combworkMerges', tr(V.finish.combworkMerges)], ['agentMerges', tr(V.finish.agentMerges)], ['committed', tr(V.finish.committed)], ['notChecked', tr(V.finish.notChecked)]])
      case 'mergeInstall':
        return select('mergeInstall', [['onManifestChange', tr(V.mergeInstall.onManifestChange)], ['always', tr(V.mergeInstall.always)]])
      case 'style':
        return select('style', [['merge', tr(V.style.merge)], ['squash', tr(V.style.squash)], ['rebase', tr(V.style.rebase)]])
      case 'commitMessage':
        return select('commitMessage', [['combwork', tr(V.commitMessage.combwork)], ['branch', tr(V.commitMessage.branch)]])
      case 'folder':
        return select('folder', [['slots', tr(V.folder.slots)], ['project', tr(V.folder.project)]])
      case 'reviewerMode':
        return select('reviewerMode', [['lane', tr(V.reviewerMode.lane)], ['pool', tr(V.reviewerMode.pool)]])
      case 'target':
        return <DraftText value={effective.target} placeholder={tr(T.defaultBranch)} onCommit={(v) => set('target', v.trim())} />
      case 'okBefore':
        return (
          <div className="workflow-stack">
            {/* Bound to its mode: the option itself is an object (HR6's round 1). */}
            <select className="select" value={effective.okBefore.mode} onChange={(e) => set('okBefore', { mode: e.target.value as OkBefore['mode'], labels: effective.okBefore.labels })}>
              <option value="never">{tr(V.okBefore.never)}</option>
              <option value="labels">{tr(V.okBefore.labels)}</option>
              <option value="every">{tr(V.okBefore.every)}</option>
            </select>
            {effective.okBefore.mode === 'labels' && <DraftText value={effective.okBefore.labels.join(', ')} placeholder={tr(T.labels)} onCommit={(v) => set('okBefore', { mode: 'labels', labels: list(v) })} />}
          </div>
        )
      case 'identity':
        return <Switch checked={!!effective.identity} disabled={!form.identity && !effective.identity} onChange={(v) => set('identity', v ? form.identity : null)} />
      case 'noSelfReview':
        return <Switch checked={effective.noSelfReview || reviewerAgent(effective.review)} disabled={reviewerAgent(effective.review)} onChange={(v) => set('noSelfReview', v)} />
      case 'stopOwnRuns':
      case 'slotsUpToDate':
      case 'strict':
      case 'pushTarget':
      case 'dependenciesDone':
      case 'sharedFolderWarning':
        return <Switch checked={effective[key]} onChange={(v) => set(key, v)} />
      // The preferences (HI-1766): resolved with their defaults, so the effective options always have them.
      case 'loopWakes':
        return <Switch checked={effective.loopWakes !== false} onChange={(v) => set('loopWakes', v)} />
      case 'fileLocks':
        return select('fileLocks', FILE_LOCK_MODES.map((m) => [m.value, tr(m.text.label)]))
      case 'loopRounds':
      case 'loopWaitHours':
      case 'loopStepWaitMinutes':
      case 'maxAgents': {
        const max = key === 'loopRounds' ? LANE_MAX_ROUNDS : key === 'loopWaitHours' ? LOOP_WAIT_MAX_HOURS : key === 'maxAgents' ? AGENT_LIMIT_MAX : LOOP_STEP_WAIT_MAX_MINUTES
        // Empty inherits: the box shows the inherited value as its placeholder. Staged as typed or stepped (HI-2058), so
        // Save lights at once, as the selects and switches do.
        return <NumberField live value={draft.options[key] ?? null} min={1} max={max} step={key === 'loopStepWaitMinutes' ? 5 : 1} label={tr(optionTitle(key, platform)!)} inherit={valueText(key, form.inherited[key])} onCommit={(v) => (v === null ? inheritKey(key) : set(key, v))} />
      }
      case 'focusedTests': {
        // G20 (HI-1367): its picker and runner are commands of their own, kept in the same map as the checks'.
        const command = (name: string, v: string): void => {
          const { [name]: _gone, ...rest } = effective.commands
          set('commands', v.trim() ? { ...rest, [name]: v.trim() } : rest)
        }
        return (
          <div className="workflow-stack">
            <Switch checked={effective.focusedTests} onChange={(v) => set('focusedTests', v)} />
            {effective.focusedTests && <DraftText value={effective.commands[FOCUSED_PICK] ?? ''} placeholder={tr(T.focusedPick)} label={tr(T.focusedPick)} onCommit={(v) => command(FOCUSED_PICK, v)} />}
            {effective.focusedTests && <DraftText value={effective.commands[FOCUSED_RUN] ?? ''} placeholder={tr(T.focusedRun)} label={tr(T.focusedRun)} onCommit={(v) => command(FOCUSED_RUN, v)} />}
          </div>
        )
      }
      case 'preChecks':
      case 'mergeChecks': {
        // One commands map for both lists (§16.13): the other list's commands are kept through this one's change, and
        // G20's picker and runner (HI-1367).
        const other = effective[key === 'preChecks' ? 'mergeChecks' : 'preChecks']
        const kept = Object.fromEntries(Object.entries(effective.commands).filter(([n]) => other.includes(n) || n === FOCUSED_PICK || n === FOCUSED_RUN))
        return <ChecksEditor names={effective[key]} commands={effective.commands} onChange={(names, commands) => setDraft({ ...draft, options: { ...draft.options, [key]: names, commands: { ...kept, ...commands } } })} />
      }
      case 'excluded':
        return <DraftText value={effective.excluded.join(', ')} placeholder={tr(T.folders)} onCommit={(v) => set('excluded', list(v))} />
      case 'stageNames':
        return <StageNamesEditor options={effective} onChange={(names) => (Object.keys(names).length ? set('stageNames', names) : inheritKey('stageNames'))} />
      default:
        return null
    }
  }

  // A template's options filled in (HI-1910), while unsaved: its name, and the checks this project can't run yet, from the
  // draft as it is (never the dialog's list: a command added here clears it).
  const filled = fromTemplate?.for === source.key && dirty ? fromTemplate : null
  const noCommand = filled ? [...new Set([...effective.preChecks, ...(platform === 'git' ? effective.mergeChecks : [])])].filter((n) => !effective.commands[n]?.trim()) : []
  const choices: Choice[] = [...form.presets.map((p) => p.id), 'allOff']
  const choiceName = (c: Choice): string => tr(c === 'allOff' ? T.allOff : PRESET_TEXT[c])
  const presetNow = draft.preset ? (custom ? tr(T.startedFrom, { preset: tr(PRESET_TEXT[draft.preset]) }) : tr(PRESET_TEXT[draft.preset])) : tr(T.noPreset)
  const shownChoice = preview ? choiceOptions(preview) : null
  return (
    <div className="workflow-form" data-platform={platform}>
      {!form.enforced && (
        <div className="banner warn workflow-note" role="status">
          <Icon name="warning" />
          <span>{tr(T.notEnforced)}</span>
          <button className="btn subtle small" onClick={() => (setStore({ settingsSection: 'advanced', settingsQuery: '' }), setActivity('settings'))}>
            {tr(msg({ id: 'workflow.form.openAdvanced', defaultMessage: 'Open Advanced', description: 'A button beside the note that workflow rules aren’t enforced: opens Settings → Advanced.' }))}
          </button>
        </div>
      )}
      {filled && (
        <div className="banner info workflow-note" role="status" data-from-template={filled.name}>
          <Icon name="info" />
          <span>
            {filled.savedMax !== undefined ? tr(T.fromTemplateMax, { template: filled.name, max: filled.savedMax }) : tr(T.fromTemplate, { template: filled.name })}
            {noCommand.length > 0 && <span data-template-no-command={noCommand.join(' ')}> {tr(T.templateNoCommand, { count: noCommand.length, checks: fmt.list(noCommand) })}</span>}
            {filled.identityOff && <span data-template-identity-off=""> {tr(T.templateIdentityOff)}</span>}
          </span>
        </div>
      )}
      {form.invalid && (
        <div className="banner warn workflow-note" role="status">
          <Icon name="warning" />
          <span>
            {tr(T.invalid)} {form.invalid}
          </span>
        </div>
      )}
      <section className="workflow-group workflow-presets" data-group="presets">
        <h3 className="workflow-group-h">
          {tr(T.preset)} <span className="workflow-preset-now" data-preset-now={draft.preset ?? ''}>{presetNow}</span>
        </h3>
        <div className="s-desc">{tr(T.presetDesc)}</div>
        <div className="workflow-choices" role="list" aria-label={tr(T.presetsLabel)}>
          {choices.map((c) => (
            <button key={c} type="button" role="listitem" className={cx('workflow-choice', preview === c && 'open', draft.preset === c && !custom && 'current')} data-choice={c} aria-expanded={preview === c} onClick={() => setPreview(preview === c ? null : c)}>
              <span className="workflow-choice-name">{choiceName(c)}</span>
              <span className="workflow-choice-summary">{tr(c === 'allOff' ? T.allOffSummary : (PRESET_SUMMARY[platform][c] ?? PRESET_TEXT[c]))}</span>
            </button>
          ))}
        </div>
        {/* Git's presets only: None has no merged result. */}
        {platform === 'git' && draft.preset && PRESET_NOTE_TEXT[draft.preset] && <div className="s-desc workflow-preset-note">{tr(PRESET_NOTE_TEXT[draft.preset]!)}</div>}
        {preview && shownChoice && <ChoicePreview choice={preview} name={choiceName(preview)} options={shownChoice} effective={effective} valueText={valueText} onUse={() => choose(preview)} onClose={() => setPreview(null)} />}
      </section>
      {FORM_GROUPS[platform].map((g) => {
        const rows = g.options.filter((k) => formShows(k, effective))
        if (!rows.length) return null
        return (
          <Fragment key={g.id}>
            <section className="workflow-group" data-group={g.id}>
              <h3 className="workflow-group-h">{tr(GROUP_TEXT[g.id])}</h3>
              {rows.map(rowOf)}
            </section>
            {/* A Git project's slots and copies, after where cards are built (a level has none: they're a project's). */}
            {g.id === 'where' && project && <SlotsAndCopies project={project} slots={effective.folder === 'slots'} />}
            {g.id === 'where' && !project && source.level && platform === 'git' && <SlotCopyLevel level={source.level} />}
          </Fragment>
        )
      })}
      {isAllOff(effective) && <NeverOff />}
      {problems.length > 0 && (
        <div className="workflow-problems" role="alert">
          <div>{tr(T.cantSave)}</div>
          {problems.flatMap((p, i) => problemLines(p).map((line, j) => <div key={`${i}:${j}`}>{line}</div>))}
        </div>
      )}
      {/* Discard Changes reads the form again too: a change elsewhere it skipped while the draft was unsaved (another level
          saved meanwhile, HI-1768) shows at once. */}
      <div className="workflow-actions">
        <Tooltip content={blocked ? tr(T.saveBlocked) : null}>
          <button className="btn primary" data-action="save" disabled={!dirty || !settings || blocked} onClick={() => void save().catch((e) => notify('error', errorMessage(e)))}>
            {tr(T.save)}
          </button>
        </Tooltip>
        <button className="btn" disabled={!dirty} onClick={() => (setDraft({ preset: form.preset, options: { ...form.own } }), setProblems([]), void load(true))}>
          {tr(T.discard)}
        </button>
        <span className="workflow-spacer" />
        <button className="btn subtle" onClick={copy}>
          {tr(T.copy)}
        </button>
        <button className="btn subtle" onClick={() => void paste()}>
          {tr(T.paste)}
        </button>
      </div>
    </div>
  )
}

/**
 * A preset's preview (#1418, §16.6.3): each option it sets, with its value and why in one sentence, those it would change
 * here marked with their value now; Use fills the form (saved only with Save…). All off lists what never turns off.
 */
export function ChoicePreview({ choice, name, options, effective, valueText, onUse, onClose }: { choice: Choice; name: string; options: WorkflowOptions; effective: WorkflowOptions; valueText: (key: OptionKey, v: unknown) => string; onUse?: () => void; onClose?: () => void }) {
  // The rules and what a preset sets beside them (HI-2001: Maximum agents), each change counted.
  const { keys, changed } = previewRows(options, effective)
  return (
    <div className="workflow-preview" data-preview={choice} role="region" aria-label={tr(T.previewHead, { preset: name })}>
      <div className="workflow-preview-h">{tr(T.previewHead, { preset: name })}</div>
      <div className="s-desc">{tr(T.previewChanges, { n: changed.length })}</div>
      <ul className="workflow-preview-list">
        {keys.map((k) => {
          const title = optionTitle(k, options.platform, options.folder)
          const why = OPTION_WHY[k]
          if (!title) return null
          const changes = changed.includes(k)
          return (
            <li key={k} data-option={k} className={cx(changes && 'changes')}>
              <span className="workflow-preview-option">{tr(title)}</span>: <strong>{valueText(k, options[k])}</strong>
              {changes && <span className="workflow-preview-now faint"> · {tr(T.previewNow, { value: valueText(k, effective[k]) })}</span>}
              {why && <div className="s-desc">{tr(why)}</div>}
            </li>
          )
        })}
      </ul>
      {choice === 'allOff' && <NeverOff />}
      {/* Its own Use and Close, unless the caller has its own (#1423: How do you work?). */}
      {onUse && onClose && (
        <div className="workflow-preview-actions">
          <button className="btn primary small" data-action="use-choice" onClick={onUse}>
            {tr(T.use, { preset: name })}
          </button>
          <button className="btn subtle small" onClick={onClose}>
            {tr(T.closePreview)}
          </button>
        </div>
      )}
    </div>
  )
}

/** An option's value in words (the rows' Inherit tips, a preview), as its platform names it. */
export function optionValueText(key: OptionKey, v: unknown, platform: PlatformId): string {
  if (typeof v === 'boolean') return tr(v ? T.on : T.off)
  if (key === 'review') return tr(platform === 'none' && v === 'none' ? VALUE_TEXT.review.noneNone : VALUE_TEXT.review[v as keyof typeof VALUE_TEXT.review])
  const values = (VALUE_TEXT as Record<string, Record<string, ReturnType<typeof msg>>>)[key]
  if (values && typeof v === 'string' && values[v]) return tr(values[v])
  // A structured value with what it holds (HR6's round 3: the labels, the identity), not only its kind.
  if (key === 'okBefore') {
    const ok = v as OkBefore
    return ok.mode === 'labels' ? tr(T.labelsValue, { labels: ok.labels.length ? fmt.list(ok.labels) : tr(T.noneValue) }) : tr(VALUE_TEXT.okBefore[ok.mode])
  }
  if (key === 'identity') {
    const id = v as WorkflowOptions['identity']
    return id ? tr(T.identityValue, { name: id.name, email: id.email }) : tr(T.off)
  }
  if (key === 'stageNames') return tr(T.stageNamesValue, { n: Object.keys((v as StageNames | undefined) ?? {}).length })
  if (key === 'reviewers' || key === 'loopRounds' || key === 'maxAgents') return fmt.number(v as number)
  if (key === 'loopWaitHours') return tr(T.hoursValue, { n: v as number })
  if (key === 'loopStepWaitMinutes') return tr(T.minutesValue, { n: v as number })
  if (key === 'fileLocks') {
    const mode = FILE_LOCK_MODES.find((m) => m.value === v)
    return mode ? tr(mode.text.label) : String(v)
  }
  if (key === 'commands') return Object.keys(v as Record<string, string>).length ? fmt.list(Object.entries(v as Record<string, string>).map(([name, command]) => `${name} (${command})`)) : tr(T.noneValue) // i18n-ignore: a check's name and command, shown as they are
  if (Array.isArray(v)) return v.length ? fmt.list(v.map(String)) : tr(T.noneValue)
  if (key === 'target') return (v as string) || tr(T.defaultBranch)
  return String(v)
}

/** What never turns off, whatever the options (§16.6.4: data safety). */
function NeverOff() {
  return (
    <div className="workflow-never-off" data-never-off="">
      <div>{tr(T.neverOffHead)}</div>
      <ul>
        {Object.entries(T.neverOff).map(([k, m]) => (
          <li key={k}>{tr(m)}</li>
        ))}
      </ul>
    </div>
  )
}

/** N5's names (OP-30): a box per stage the options produce, its default name as the placeholder; empty keeps it. */
function StageNamesEditor({ options, onChange }: { options: WorkflowOptions; onChange: (names: StageNames) => void }) {
  const compiled = compile(options)
  const stages = (compiled.ok ? compiled.ruleset : mustCompile(allOff(options.platform))).stages.map((s) => s.id)
  const names = options.stageNames ?? {}
  const rename = (id: StageId, v: string): void => {
    const { [id]: _old, ...rest } = names
    onChange(v.trim() ? { ...rest, [id]: v } : rest)
  }
  return (
    <div className="workflow-stages">
      {stages.map((id) => (
        <DraftText key={id} value={names[id] ?? ''} placeholder={tr(STAGE_TEXT[id])} label={tr(T.stageName, { stage: tr(STAGE_TEXT[id]) })} onCommit={(v) => rename(id, v)} />
      ))}
    </div>
  )
}

/**
 * A text field typed freely (spaces, commas) and taken when it loses focus or on Enter: tidied then, never per keystroke
 * (HR6's round 1). A value changed from outside (a preset, a paste, Discard Changes) replaces what it shows.
 */
function DraftText({ value, placeholder, onCommit, className = 'input', label }: { value: string; placeholder: string; onCommit: (v: string) => void; className?: string; label?: string }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return <input className={className} value={text} placeholder={placeholder} aria-label={label} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onCommit(text)} onKeyDown={(e) => e.key === 'Enter' && onCommit(text)} />
}

type CheckRow = { name: string; command: string }

/** The checks before review: each a name and its command (§16.13: a run counts as the check only as that command). */
function ChecksEditor({ names, commands, onChange }: { names: string[]; commands: Record<string, string>; onChange: (names: string[], commands: Record<string, string>) => void }) {
  const given = JSON.stringify([names, commands])
  const [rows, setRows] = useState<CheckRow[]>(() => names.map((n) => ({ name: n, command: commands[n] ?? '' })))
  // What it last gave back: the props coming back as that keep the rows as typed; anything else (a preset, a paste,
  // Discard Changes) replaces them.
  const sent = useRef(given)
  useEffect(() => {
    if (given === sent.current) return
    sent.current = given
    const [n, c] = JSON.parse(given) as [string[], Record<string, string>]
    setRows(n.map((x) => ({ name: x, command: c[x] ?? '' })))
  }, [given])
  // Typed freely and taken as the field loses focus, tidied then (HR6's round 1: never trimmed per keystroke).
  const commit = (next: CheckRow[]): void => {
    const kept = next.map((r) => ({ name: r.name.trim(), command: r.command.trim() })).filter((r) => r.name || r.command)
    const n = kept.map((r) => r.name)
    const c = Object.fromEntries(kept.filter((r) => r.name && r.command).map((r) => [r.name, r.command]))
    sent.current = JSON.stringify([n, c])
    onChange(n, c)
  }
  const edit = (i: number, part: keyof CheckRow, v: string): void => setRows(rows.map((x, j) => (j === i ? { ...x, [part]: v } : x)))
  const change = (next: CheckRow[]): void => {
    setRows(next)
    commit(next)
  }
  return (
    <div className="workflow-stack workflow-checks">
      {!rows.length && <div className="s-desc">{tr(T.noChecks)}</div>}
      {rows.map((r, i) => (
        <div className="workflow-check" key={i}>
          <input className="input" value={r.name} placeholder={tr(T.checkName)} onChange={(e) => edit(i, 'name', e.target.value)} onBlur={() => commit(rows)} />
          <input className="input mono" value={r.command} placeholder={tr(T.checkCommand)} onChange={(e) => edit(i, 'command', e.target.value)} onBlur={() => commit(rows)} />
          <Tooltip content={tr(T.removeCheck)}>
            <button className="btn subtle small" aria-label={tr(T.removeCheck)} onClick={() => change(rows.filter((_x, j) => j !== i))}>
              <Icon name="close" />
            </button>
          </Tooltip>
        </div>
      ))}
      <button className="btn subtle small" onClick={() => change([...rows, { name: `check${rows.length + 1}`, command: '' }])}>
        {tr(T.addCheck)}
      </button>
    </div>
  )
}

/**
 * What a save changes, the lanes keeping the old rules, and the cards in flight to apply the change to (OP-38); for a
 * level (#1422), each project inheriting the change, what changes for it, and its running lanes and cards in flight,
 * which keep their rules until their next card.
 */
function SaveDetails({ changes, check, picked, title }: { changes: string[]; check: WorkflowCheck | WorkflowLevelCheck; picked: Set<number>; title: (k: OptionKey) => string }) {
  const [, redraw] = useState(0)
  const tasks = useStore((s) => s.tasks)
  const workspacePath = useStore((s) => s.workspace?.path ?? '')
  return (
    <div className="workflow-save">
      {changes.length ? (
        <>
          <p>{tr(T.changesHead)}</p>
          <ul className="workflow-changes">
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>{tr(T.noChanges)}</p>
      )}
      {check.lanes.length > 0 && (
        <>
          <p>{tr(T.lanes, { n: check.lanes.length })}</p>
          <ul>
            {check.lanes.map((l) => (
              <li key={l.id}>{l.name ? tr(T.lane, { builder: l.builder, name: l.name }) : tr(T.laneUnnamed, { builder: l.builder })}</li>
            ))}
          </ul>
        </>
      )}
      {check.inFlight.length > 0 && (
        <>
          <p>{tr(T.inFlight, { n: check.inFlight.length })}</p>
          {check.inFlight.map((c) => (
            <label className="workflow-card" key={c.number}>
              <input
                type="checkbox"
                checked={picked.has(c.number)}
                onChange={(e) => {
                  if (e.target.checked) picked.add(c.number)
                  else picked.delete(c.number)
                  redraw((n) => n + 1)
                }}
              />{' '}
              {cardLabelOf({ tasks }, c.number)} {c.title}
            </label>
          ))}
        </>
      )}
      {'projects' in check && (
        <div className="workflow-heirs" data-heirs="">
          <p>{check.projects.length ? tr(T.heirs, { n: check.projects.length }) : tr(T.noHeirs)}</p>
          <ul>
            {check.projects.map((h) => (
              <li key={h.path} data-heir={h.name}>
                {/* Another workspace's project (Hive's level) says which: names repeat across workspaces. */}
                {h.workspace.path.toLowerCase() === workspacePath.toLowerCase() ? tr(T.heir, { project: h.name, options: fmt.list(h.changed.filter((k): k is OptionKey => k !== 'platform').map(title)) }) : tr(T.heirElsewhere, { project: h.name, workspace: h.workspace.name, options: fmt.list(h.changed.filter((k): k is OptionKey => k !== 'platform').map(title)) })}
                {/* Each lane and card by name (HR5's round 1), as a project's warning lists its own. */}
                {h.lanes.length > 0 && (
                  <div className="s-desc" data-heir-lanes="">
                    {tr(T.heirLanes, { n: h.lanes.length })}
                    <ul>
                      {h.lanes.map((l) => (
                        <li key={l.id}>{l.name ? tr(T.lane, { builder: l.builder, name: l.name }) : tr(T.laneUnnamed, { builder: l.builder })}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {h.inFlight.length > 0 && (
                  <div className="s-desc" data-heir-cards="">
                    {tr(T.heirCards, { n: h.inFlight.length })}
                    <ul>
                      {h.inFlight.map((c) => (
                        <li key={c.number}>
                          {/* Its own workspace's key: card numbers repeat across workspaces (HR5's round 2). */}
                          {c.key} {c.title}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

const N = {
  text: msg({ id: 'workflow.presetsNotice.text', defaultMessage: '{n, plural, one {{projects} works} other {{projects} work}} as before this version. A preset sets up a workflow in one click: who reviews the work, which checks pass first and who merges.', description: 'The one-time notice after the upgrade to 1.0 (glossary 2.1: preset, workflow). {projects} is a list of project names; {n} how many.' }),
  choose: msg({ id: 'workflow.presetsNotice.choose', defaultMessage: 'Choose…', description: 'A button of the one-time presets notice: opens the first project’s Version Control tab at Workflow.' }),
  notNow: msg({ id: 'workflow.presetsNotice.notNow', defaultMessage: 'Not Now', description: 'A button of the one-time presets notice: dismisses it for good.' })
}

/**
 * The one-time notice after the upgrade (§16.17, OP-22): the projects kept today's way of working, and the presets on
 * offer. Choose… opens the first one's Workflow section; either answer is the last time it shows in the workspace.
 */
export function PresetsNotice() {
  const path = useStore((s) => s.workspace?.path ?? null)
  const readOnly = useStore((s) => s.boardState?.readOnly ?? null)
  // What main's answer depends on, as a string (HI-1807): the projects' names, and which have a workflow with no preset.
  // Not the workspace object, replaced with each agent's change of state: a dozen agents working read it again more than
  // once a second. The board's own part (answered, the upgrade's) changes only with readOnly or a reload.
  const asked = useStore((s) => (s.workspace ? JSON.stringify([s.workspace.path, s.workspace.projects.map((p) => [p.path, p.name, !!p.config.workflow && p.config.workflow.preset === null])]) : null))
  const [projects, setProjects] = useState<{ path: string; name: string }[] | null>(null)
  // The workspaces answered in this window (#1464): a reload begun before the answer's board write commits (a new
  // workspace object meanwhile, or one already in flight) reads the old board, and must not show it again.
  const answered = useRef(new Set<string>())
  useEffect(() => {
    if (!asked || !path || readOnly !== null || answered.current.has(path)) return setProjects(null)
    let live = true
    call('workflow:presetsNotice')
      .then((p) => live && setProjects(answered.current.has(path) ? null : p))
      .catch(() => live && setProjects(null))
    return () => {
      live = false
    }
  }, [path, asked, readOnly])
  if (!projects?.length) return null
  const answer = (choose: boolean): void => {
    if (path) answered.current.add(path)
    if (choose) openVersionControl(projects[0].path, 'workflow')
    setProjects(null)
    void call('workflow:presetsNoticeSaid').catch((e) => notify('error', errorMessage(e)))
  }
  return (
    <div className="banner info presets-notice" role="status">
      <Icon name="info" />
      <span className="grow">{tr(N.text, { projects: fmt.list(projects.map((p) => p.name)), n: projects.length })}</span>
      <button className="btn small primary" onClick={() => answer(true)}>
        {tr(N.choose)}
      </button>
      <button className="btn small subtle" onClick={() => answer(false)}>
        {tr(N.notNow)}
      </button>
    </div>
  )
}
