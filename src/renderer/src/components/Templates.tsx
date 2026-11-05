import { Children, useCallback, useEffect, useState } from 'react'
import { SESSION_LAYOUTS } from '@shared/defaults'
import { useAgentLimit } from '../advanced'
import { agentChoosesMcp, agentMcpText } from '@shared/agentMcp'
import { isKnownProvider, providerName } from '@shared/providers'
import { TEMPLATE_DESCRIPTION_MAX, TEMPLATE_NAME_MAX, pairIndex, pairNames, shownProblem, templateAgentNames, type TemplatePair, uniqueName, unknownProviders, type TemplateAgent, type TemplateDest, type TemplateEntry, type TemplateRef } from '@shared/templates'
import { templateDescription, templateTitle } from '@shared/templateDefaults'
import { WORKFLOW_ROLE_TEXT, buildsWork, reviewsWork } from '@shared/workflow/roles'
import { PRESET_TEXT } from '@shared/workflow/optionTexts'
import type { PageLayout, ProjectInfo } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { useScopedLoad } from '../scopedLoad'
import { choose, confirm, get, notify, prompt, set, showView, useStore, type TemplateDraft, type TemplateEdit } from '../store'
import { cx, timeAgo } from '../util'
import { clearEditorDraft, editorDraft, onEditorDrafts, setEditorDraft } from '../editorDrafts'
import { PaneResizer, usePaneSize } from './Resizer'
import { BusyButton, Icon, IconButton, InfoTip, LoadFailed, OneLineDesc, StaleNote, Tooltip, useBusy } from './ui'
import { fmt, msg, tr, tRich } from '@shared/i18n'
import { hasWorkflow, type TemplateWorkflows } from '@shared/workflow/templateOptions'
import { TemplateWorkflowSection } from './TemplateWorkflowView'

/**
 * Agent templates' own places (#127): the Templates view (activity bar: the workspace's templates and each project's)
 * and a project's Templates tab (its own and the workspace's). Both show what a template holds, edit it (#271: its
 * agents in the Agent Settings dialog), and load, rename, duplicate, delete, export and import them.
 */

export const TEMPLATES_TIP = msg({ id: 'assistant.templates.tip', defaultMessage: "A template is a project's agents (their roles in the workflow and settings) and layout, saved under a name. Combwork's own are read-only: duplicate one to change it. The workspace's are for every project, a project's are its own (kept in its .combwork, out of git). Export one to share it as a file.", description: 'Tooltip on Templates (the Templates view and a project\'s Templates tab). Keep .combwork as it is. Glossary: workflow role.' })

const M = {
  newAgentName: msg({ id: 'assistant.templates.newAgentName', defaultMessage: 'Agent', description: 'The name suggested for a new agent of a template (a number follows when it is taken: Agent 2).' }),
  draftLabel: msg({ id: 'assistant.templates.draftLabel', defaultMessage: 'Template "{name}"', description: 'A template with unsaved changes, as the list of unsaved edits names it (when quitting or closing the window).' }),
  noLongerEdited: msg({ id: 'assistant.templates.noLongerEdited', defaultMessage: 'That template is no longer being edited', description: "An error: a template's changes were saved after its editor closed." }),
  layout: msg({ id: 'assistant.templates.layout', defaultMessage: '{layout, select, auto {Automatic} single {One at a time} columns2 {Two columns} columns3 {Three columns} grid {Grid of four} grid6 {Grid of six} other {{layout}}}', description: "A template's layout of agent panes, as the Session tab's layout menu names it. Keep it short." }),
  layoutPhrase: msg({ id: 'assistant.templates.layoutPhrase', defaultMessage: '{layout, select, auto {automatic layout} single {one at a time layout} columns2 {two columns layout} columns3 {three columns layout} grid {grid of four layout} grid6 {grid of six layout} other {{layout} layout}}', description: 'A template\'s layout of agent panes inside a sentence ("2 agents, two columns layout").' }),
  agents: msg({ id: 'assistant.templates.agents', defaultMessage: '{count, plural, one {# agent} other {# agents}}', description: 'How many agents a template has.' }),
  aProject: msg({ id: 'assistant.templates.aProject', defaultMessage: 'a project', description: "A template's project when its name isn't known." }),
  unknown: msg({ id: 'assistant.templates.unknown', defaultMessage: "It uses a coding agent this Combwork doesn't know ({ids}): it can be kept, but not loaded until Combwork knows it.", description: "A template whose agents use a CLI this Combwork doesn't know (one from a newer Combwork). {ids} lists them." }),
  everyProject: msg({ id: 'assistant.templates.everyProject', defaultMessage: 'The workspace (every project)', description: 'Where to keep a template: a choice in a list.' }),
  thisProjectOnly: msg({ id: 'assistant.templates.thisProjectOnly', defaultMessage: '{project} (this project only)', description: 'Where to keep a template: a project, in a list.' }),
  keepIn: msg({ id: 'assistant.templates.keepIn', defaultMessage: 'Keep it in', description: 'Where to keep a template: the label of the list.' }),
  noProjects: msg({ id: 'assistant.templates.noProjects', defaultMessage: 'No projects', description: 'A notice: Load into Project with no projects in the workspace.' }),
  addProjectFirst: msg({ id: 'assistant.templates.addProjectFirst', defaultMessage: 'Add a project to the workspace first.', description: "Under the notice No projects, from Load into Project." }),
  loadTitle: msg({ id: 'assistant.templates.loadTitle', defaultMessage: 'Load "{name}" into a project', description: 'Load into Project: the dialog that asks which project.' }),
  loadMessage: msg({ id: 'assistant.templates.loadMessage', defaultMessage: 'It replaces every agent of the project you choose, and its layout. Combwork lists who goes and who comes before anything changes.', description: 'Load into Project: the dialog that asks which project.' }),
  project: msg({ id: 'assistant.templates.project', defaultMessage: 'Project', description: 'Load into Project: the label of the list of projects.' }),
  continue: msg({ id: 'assistant.templates.continue', defaultMessage: 'Continue', description: "Load into Project: the dialog's button (the plan is shown next)." }),
  renameTitle: msg({ id: 'assistant.templates.renameTitle', defaultMessage: 'Rename "{name}"', description: "The title of the dialog that renames a template ({name}: the template)." }),
  namePlaceholder: msg({ id: 'assistant.templates.namePlaceholder', defaultMessage: 'Template name', description: "Renaming a template: the name box when it is empty." }),
  rename: msg({ id: 'assistant.templates.rename', defaultMessage: 'Rename', description: "The button of the dialog that renames a template." }),
  enterName: msg({ id: 'assistant.templates.enterName', defaultMessage: 'Enter a name.', description: "Renaming a template: the name box is empty." }),
  atMost: msg({ id: 'assistant.templates.atMost', defaultMessage: 'At most {max} characters.', description: "Renaming a template: the name typed is too long." }),
  renameFailed: msg({ id: 'assistant.templates.renameFailed', defaultMessage: 'Could not rename the template', description: "An error notice: a template couldn't be renamed; the reason follows." }),
  duplicateTitle: msg({ id: 'assistant.templates.duplicateTitle', defaultMessage: 'Duplicate "{name}"', description: "The title of the dialog that duplicates a template ({name}: the template)." }),
  duplicateMessage: msg({ id: 'assistant.templates.duplicateMessage', defaultMessage: 'A copy to share or change on its own. A name already taken there gets a number.', description: "Duplicate's dialog, over where to keep the copy." }),
  duplicate: msg({ id: 'assistant.templates.duplicate', defaultMessage: 'Duplicate', description: "The button of the dialog that duplicates a template." }),
  duplicateFailed: msg({ id: 'assistant.templates.duplicateFailed', defaultMessage: 'Could not duplicate the template', description: "An error notice: a template couldn't be duplicated; the reason follows." }),
  duplicated: msg({ id: 'assistant.templates.duplicated', defaultMessage: 'Template duplicated', description: "A notice after a template was duplicated; where the copy is follows." }),
  where: msg({ id: 'assistant.templates.where', defaultMessage: '"{name}", in {scope, select, workspace {the workspace} other {{project}}}.', description: 'Under Template duplicated or Template imported: the template and where it is kept ({project}: a project\'s name).' }),
  deleteTitle: msg({ id: 'assistant.templates.deleteTitle', defaultMessage: 'Delete "{name}"?', description: 'Confirmation before a template is deleted.' }),
  deleteMessage: msg({ id: 'assistant.templates.deleteMessage', defaultMessage: 'The template goes to the Recycle Bin (from {scope, select, workspace {the workspace} other {{project}}}).', description: "Confirmation before a template is deleted ({project}: a project's name)." }),
  delete: msg({ id: 'assistant.templates.delete', defaultMessage: 'Delete', description: 'Confirmation before a template is deleted: its button.' }),
  deleting: msg({ id: 'assistant.templates.deleting', defaultMessage: 'Deleting…', description: "Delete's button while it works." }),
  exportFailed: msg({ id: 'assistant.templates.exportFailed', defaultMessage: 'Could not export the template', description: "An error notice: a template couldn't be saved as a file; the reason follows." }),
  exported: msg({ id: 'assistant.templates.exported', defaultMessage: 'Template exported', description: "A notice after a template was saved as a file; the file's path follows." }),
  exportedDetail: msg({ id: 'assistant.templates.exportedDetail', defaultMessage: "It holds the agents' roles, notes and settings and the layout: no paths, sessions or names of people. Import it into any Combwork.", description: "Under Template exported, after the file's path." }),
  importFailed: msg({ id: 'assistant.templates.importFailed', defaultMessage: 'Could not import the template', description: "An error notice: a template file couldn't be imported; the reason follows." }),
  importTitle: msg({ id: 'assistant.templates.importTitle', defaultMessage: 'Import "{name}"', description: "Import's dialog title: {name} is the template's." }),
  importMessage: msg({ id: 'assistant.templates.importMessage', defaultMessage: '{count, plural, one {# agent} other {# agents}}.{hasUnknown, select, yes { {unknown}} other {}} Where should it be kept?', description: "Import's dialog: how many agents the template has; {unknown} says when its coding agents aren't known here." }),
  import: msg({ id: 'assistant.templates.import', defaultMessage: 'Import', description: "The button of the dialog that imports a template, after choosing where to keep it." }),
  clashTitle: msg({ id: 'assistant.templates.clashTitle', defaultMessage: 'A template of that name is already there', description: 'Import, when where it is kept has a template of that name.' }),
  clashMessage: msg({ id: 'assistant.templates.clashMessage', defaultMessage: '{scope, select, workspace {The workspace} other {{project}}} already has "{name}".', description: "Import, when where it is kept has a template of that name ({project}: a project's name)." }),
  clashDetail: msg({ id: 'assistant.templates.clashDetail', defaultMessage: 'Replace it with the imported one, or keep both (the imported one gets a number).', description: 'Import, when where it is kept has a template of that name.' }),
  replace: msg({ id: 'assistant.templates.replace', defaultMessage: 'Replace', description: 'Import, a template of that name is there: replace it.' }),
  keepBoth: msg({ id: 'assistant.templates.keepBoth', defaultMessage: 'Keep Both', description: 'Import, a template of that name is there: keep both.' }),
  imported: msg({ id: 'assistant.templates.imported', defaultMessage: 'Template imported', description: "A notice after a template file was imported; where it is kept follows." }),
  importedDetail: msg({ id: 'assistant.templates.importedDetail', defaultMessage: '"{name}", in {scope, select, workspace {the workspace} other {{project}}}.{hasUnknown, select, yes { {unknown}} other {}}', description: "Under Template imported: the template and where it is kept; {unknown} says when its coding agents aren't known here." }),
  workspace: msg({ id: 'assistant.templates.workspace', defaultMessage: 'Workspace', description: "A badge, a group and a filter: the workspace's templates (for every project)." }),
  combwork: msg({ id: 'assistant.templates.cw', defaultMessage: 'Combwork', description: "A badge, a group and a filter: Combwork's own templates (#1436, shipped with Combwork, read-only)." }),
  combworkSummary: msg({ id: 'assistant.templates.combworkSummary', defaultMessage: "{count, plural, one {# agent} other {# agents}}, {layout}. One of Combwork's own templates: read-only. <b>Duplicate…</b> copies it into the workspace or a project to change it.", description: 'Over one of Combwork\'s own templates\' agents: how many, its layout ("two columns layout"). <b> is bold; Duplicate… is the button.' }),
  suggests: msg({ id: 'assistant.templates.suggests', defaultMessage: 'Suggests the {preset} preset: loading it offers to switch the project’s workflow options to it.{pool, select, yes { Its reviewers are a pool shared by every builder.} other {}}', description: "Over a template's agents: the workflow preset it suggests ({preset}: Solo, Pair, Team); pool when its reviewers are shared by all builders rather than one per lane. Glossary: preset, workflow, reviewer, builder, lane." }),
  pairedWith: msg({ id: 'assistant.templates.pairedWith', defaultMessage: 'paired: {name}', description: "A template's table, under an agent's role: the agent it is paired with ({name}). Lower case. The name after a colon (glossary §1 rule 4)." }),
  unsavedTip: msg({ id: 'assistant.templates.unsavedTip', defaultMessage: 'It is open in the editor with changes not saved yet', description: 'Tooltip on Not saved, beside a template.' }),
  notSaved: msg({ id: 'assistant.templates.notSaved', defaultMessage: 'Not saved', description: 'A badge on a template open in its editor with unsaved changes.' }),
  cantBeUsed: msg({ id: 'assistant.templates.cantBeUsed', defaultMessage: "Can't be used", description: "A badge on a template that can't be used (damaged, made by a newer Combwork…)." }),
  unknownAgent: msg({ id: 'assistant.templates.unknownAgent', defaultMessage: 'Unknown agent', description: "A badge on a template one of whose agents uses a coding agent this Combwork doesn't know." }),
  rowDesc: msg({ id: 'assistant.templates.rowDesc', defaultMessage: '{count, plural, one {# agent} other {# agents}} · {layout} layout', description: 'Under a template in a list: its agents and its layout ({layout}: "Two columns").' }),

  saved: msg({ id: 'assistant.templates.saved', defaultMessage: 'Template saved', description: "A notice after a template was saved; its name and agents follow." }),
  agentSaved: msg({ id: 'assistant.templates.agentSaved', defaultMessage: '"{name}": {agent} saved in it.', description: "Under Template saved: an agent's settings were saved in the template." }),
  savedDetail: msg({ id: 'assistant.templates.savedDetail', defaultMessage: '"{name}": {count, plural, one {# agent} other {# agents}}, {layout}.', description: 'Under Template saved: its agents and layout ({layout}: "two columns layout").' }),
  needName: msg({ id: 'assistant.templates.needName', defaultMessage: 'Enter a name for the template.', description: "Why a template being edited can't be saved yet." }),
  needAgent: msg({ id: 'assistant.templates.needAgent', defaultMessage: 'A template needs at least one agent.', description: "Why a template being edited can't be saved yet." }),
  discardTitle: msg({ id: 'assistant.templates.discardTitle', defaultMessage: 'Discard your changes?', description: 'Confirmation before closing a template editor with unsaved changes.' }),
  discardMessage: msg({ id: 'assistant.templates.discardMessage', defaultMessage: 'Your changes to "{name}" aren\'t saved.', description: 'Confirmation before closing a template editor with unsaved changes.' }),
  discard: msg({ id: 'assistant.templates.discard', defaultMessage: 'Discard', description: 'Confirmation before closing a template editor with unsaved changes: its button.' }),
  editTitle: msg({ id: 'assistant.templates.editTitle', defaultMessage: 'Edit "{name}"', description: "The template editor's heading ({name}: the template)." }),
  changesNotSaved: msg({ id: 'assistant.templates.changesNotSaved', defaultMessage: 'Changes not saved', description: 'The template editor: beside its buttons while there are unsaved changes.' }),
  cancel: msg({ id: 'assistant.templates.cancel', defaultMessage: 'Cancel', description: "The template editor's button with unsaved changes: closes it, asking first." }),
  close: msg({ id: 'assistant.templates.close', defaultMessage: 'Close', description: "The template editor's button with nothing to save." }),
  saving: msg({ id: 'assistant.templates.saving', defaultMessage: 'Saving…', description: "The template editor's Save Template button while it saves." }),
  saveTemplate: msg({ id: 'assistant.templates.saveTemplate', defaultMessage: 'Save Template', description: "The template editor's button that saves the template." }),
  stale: msg({ id: 'assistant.templates.stale', defaultMessage: '"{name}" was saved again since you started editing it, so these changes can\'t be saved over it.', description: 'The template editor, when the template was saved elsewhere meanwhile.' }),
  discardReload: msg({ id: 'assistant.templates.discardReload', defaultMessage: 'Discard and Reload', description: 'The template editor, when the template was saved elsewhere meanwhile: a button.' }),
  name: msg({ id: 'assistant.templates.name', defaultMessage: 'Name', description: "The template editor: the name's label." }),
  description: msg({ id: 'assistant.templates.description', defaultMessage: 'Description', description: "The template editor: the description's label." }),
  descriptionPlaceholder: msg({ id: 'assistant.templates.descriptionPlaceholder', defaultMessage: 'Optional: what it is for', description: "The template editor: the description's box, empty." }),
  layoutLabel: msg({ id: 'assistant.templates.layoutLabel', defaultMessage: 'Layout', description: "The template editor: the layout's label." }),
  automaticOption: msg({ id: 'assistant.templates.automaticOption', defaultMessage: 'Automatic (shows all the agents, up to six)', description: "The template editor's layouts: the one that fits the agents." }),
  agentsHeading: msg({ id: 'assistant.templates.agentsHeading', defaultMessage: 'Agents', description: "The template editor: the heading over its agents (a count follows)." }),
  fullTip: msg({ id: 'assistant.templates.fullTip', defaultMessage: 'A template can have up to {limit, number} agents, the most a project can have', description: 'Tooltip on Add Agent when the template is full: {limit} is the most agents a project can have (24).' }),
  addTip: msg({ id: 'assistant.templates.addTip', defaultMessage: 'Add an agent, in the Agent Settings dialog', description: 'Tooltip on Add Agent in the template editor.' }),
  addAgent: msg({ id: 'assistant.templates.addAgent', defaultMessage: 'Add Agent…', description: "A button in the template editor: adds an agent in the Agent Settings dialog." }),
  colAgent: msg({ id: 'assistant.templates.colAgent', defaultMessage: 'Agent', description: "A template's table: the agents' names." }),
  colRole: msg({ id: 'assistant.templates.colRole', defaultMessage: 'Role', description: "A template's table: each agent's role." }),
  colSuggests: msg({ id: 'assistant.templates.colSuggests', defaultMessage: 'Suggests', description: "A template's table (HI-2109): the coding agent CLI each agent suggests (Claude Code, Codex…), which only preselects a connection on it when the template is loaded. A short column heading." }),
  suggestsTip: msg({ id: 'assistant.templates.suggestsTip', defaultMessage: 'A template keeps no connection, model or effort: loading it offers the first connection on this coding agent, and you choose.', description: "Tooltip on the Suggests column heading of a template's table (HI-2109)." }),
  noSuggestion: msg({ id: 'assistant.templates.noSuggestion', defaultMessage: 'Any', description: "A template's table, the Suggests column (HI-2109): the agent suggests no coding agent CLI (the first connection in the order is offered)." }),
  colActions: msg({ id: 'assistant.templates.colActions', defaultMessage: 'Actions', description: "The template editor's table: the accessible name of the column of buttons." }),
  unknownProvider: msg({ id: 'assistant.templates.unknownProvider', defaultMessage: '{provider} (unknown)', description: "A template's table: a coding agent this Combwork doesn't know ({provider}: its id)." }),

  mcpServers: msg({ id: 'assistant.templates.mcpServers', defaultMessage: 'MCP servers: {servers}', description: "A template's table, under an agent's coding agent: the MCP servers it chose." }),
  editAgent: msg({ id: 'assistant.templates.editAgent', defaultMessage: 'Edit {name}…', description: "The template editor: a button on an agent's row." }),
  cantEdit: msg({ id: 'assistant.templates.cantEdit', defaultMessage: "This Combwork doesn't know its coding agent: it can be moved or removed, not edited", description: "The template editor: the edit button of an agent whose coding agent isn't known here." }),
  copyAgent: msg({ id: 'assistant.templates.copyAgent', defaultMessage: 'Copy {name}', description: "The template editor: a button on an agent's row." }),
  moveUp: msg({ id: 'assistant.templates.moveUp', defaultMessage: 'Move {name} up', description: "The template editor: a button on an agent's row." }),
  moveDown: msg({ id: 'assistant.templates.moveDown', defaultMessage: 'Move {name} down', description: "The template editor: a button on an agent's row." }),
  removeAgent: msg({ id: 'assistant.templates.removeAgent', defaultMessage: 'Remove {name}', description: "The template editor: a button on an agent's row." }),
  editorHint: msg({ id: 'assistant.templates.editorHint', defaultMessage: "The order is the order of the agents in a project: the layout's pages hold them in turn. Saving an agent saves the template too; other changes are saved with <b>Save Template</b>. Saving changes this template only, never a project loaded from it earlier.", description: 'Under the template editor\'s agents. <b> is bold; Save Template is the button.' }),
  loadHereTip: msg({ id: 'assistant.templates.loadHereTip', defaultMessage: "Replace this project's agents and layout with the template's", description: 'Tooltip on Load into This Project.' }),
  loadAnyTip: msg({ id: 'assistant.templates.loadAnyTip', defaultMessage: 'Choose a project; its agents and layout are replaced with the template’s', description: "Tooltip on Load into Project…, over a template in the Templates view." }),
  loadHere: msg({ id: 'assistant.templates.loadHere', defaultMessage: 'Load into This Project…', description: "A button on a template in a project's Templates tab." }),
  loadAny: msg({ id: 'assistant.templates.loadAny', defaultMessage: 'Load into Project…', description: 'A button on a template in the Templates view.' }),
  editTip: msg({ id: 'assistant.templates.editTip', defaultMessage: 'Change its agents (each in the Agent Settings dialog), their order, its name, description and layout', description: "Tooltip on Edit…, over a template: what its editor changes." }),
  edit: msg({ id: 'assistant.templates.edit', defaultMessage: 'Edit…', description: 'A button on a template: opens its editor.' }),
  renameButton: msg({ id: 'assistant.templates.renameButton', defaultMessage: 'Rename…', description: "A button over a template: renames it." }),
  duplicateButton: msg({ id: 'assistant.templates.duplicateButton', defaultMessage: 'Duplicate…', description: "A button over a template: copies it, asking where to keep the copy." }),
  exportButton: msg({ id: 'assistant.templates.exportButton', defaultMessage: 'Export…', description: 'A button on a template: saves it as a file to share.' }),
  deleteTip: msg({ id: 'assistant.templates.deleteTip', defaultMessage: 'Delete template', description: "A trash button over a template: deletes it (asking first)." }),
  problem: msg({ id: 'assistant.templates.problem', defaultMessage: "This template can't be used: {problem}", description: "Over a template that can't be used; {problem} says why." }),
  summary: msg({ id: 'assistant.templates.summary', defaultMessage: "{count, plural, one {# agent} other {# agents}}, {layout}{hasSaved, select, yes {, saved {when}} other {}}. Kept in {scope, select, workspace {the workspace, for every project} other {{project}, for that project only}}. Change it with <b>Edit…</b>, or save a project's agents again under the same name.", description: 'Over a template\'s agents: how many, its layout ("two columns layout"), when it was saved ({when}: "3 days ago"), and where it is kept. <b> is bold; Edit… is the button.' }),
  title: msg({ id: 'assistant.templates.title', defaultMessage: 'Templates', description: "The Templates view's and a project's Templates tab's heading." }),
  importButton: msg({ id: 'assistant.templates.importButton', defaultMessage: 'Import Template…', description: 'A button: imports a template from a file.' }),
  refresh: msg({ id: 'assistant.templates.refresh', defaultMessage: 'Refresh', description: 'A button: reads the templates again.' }),
  showOf: msg({ id: 'assistant.templates.showOf', defaultMessage: 'Show templates of', description: "The Templates view: the accessible name of the filter (All templates, Workspace, a project)." }),
  allTemplates: msg({ id: 'assistant.templates.allTemplates', defaultMessage: 'All templates', description: "The Templates view's filter: every template." }),
  noWorkspace: msg({ id: 'assistant.templates.noWorkspace', defaultMessage: 'Open a workspace to see its templates.', description: 'The Templates view with no workspace open.' }),
  loadTarget: msg({ id: 'assistant.templates.loadTarget', defaultMessage: 'the templates', description: 'What could not be loaded when the templates were first read: shown in "Could not load {what}: {error}", with Retry.' }),
  refreshTarget: msg({ id: 'assistant.templates.refreshTarget', defaultMessage: 'the templates', description: 'What could not be refreshed while the templates shown stay on screen: shown in "Could not refresh {what}; last updated …", with Retry.' }),
  loading: msg({ id: 'assistant.templates.loading', defaultMessage: 'Loading…', description: "The Templates view or tab while the templates are read." }),
  noWorkspaceTemplates: msg({ id: 'assistant.templates.noWorkspaceTemplates', defaultMessage: 'No workspace templates.', description: "Under Workspace, when the workspace has no templates." }),
  noneOfItsOwn: msg({ id: 'assistant.templates.noneOfItsOwn', defaultMessage: 'No templates of its own.', description: "The Templates view, under a project with no templates." }),
  panelHint: msg({ id: 'assistant.templates.panelHint', defaultMessage: "Save a project's agents as a template from its Session tab (<b>Save Template…</b>). Export one to share it; Import brings one in.", description: "Under the Templates view's list. <b> is bold; Save Template… is the Session tab's button." }),
  noneCombwork: msg({ id: 'assistant.templates.noneCombwork', defaultMessage: "Combwork's own templates couldn't be listed.", description: "The Templates view, under Combwork, when none of Combwork's own templates is listed (shouldn't happen)." }),
  gone: msg({ id: 'assistant.templates.gone', defaultMessage: 'That template is no longer there.', description: 'The Templates view: the selected template was deleted or moved.' }),
  selectOne: msg({ id: 'assistant.templates.selectOne', defaultMessage: 'Select a template to see its agents and layout, load it into a project, or export it to share.', description: "The Templates view's main area with no template selected." }),
  thisProject: msg({ id: 'assistant.templates.thisProject', defaultMessage: 'This project', description: "A project's Templates tab: the group of its own templates." }),
  noneYet: msg({ id: 'assistant.templates.noneYet', defaultMessage: 'None of its own yet.', description: "A project's Templates tab: it has no templates of its own." }),
  tabHint: msg({ id: 'assistant.templates.tabHint', defaultMessage: "<b>Save Template…</b> on the Session tab saves this project's agents and layout. All the workspace's templates are in the <view>Templates view</view>.", description: "Under a project's Templates tab's list. <b> is bold (the Session tab's button); <view> is a link that opens the Templates view." }),
  selectOneHere: msg({ id: 'assistant.templates.selectOneHere', defaultMessage: 'Select a template to see its agents and layout, load it into this project, or export it to share.', description: "A project's Templates tab with no template selected." })
}

const bold = (c: React.ReactNode[]): React.ReactNode => <strong>{c}</strong>
const templatesViewLink = (c: React.ReactNode[]): React.ReactNode => <a onClick={() => showView('templates')}>{c}</a>

/** A template's key, to select it (scope, project and file). */
export const templateKey = (t: TemplateRef): string => `${t.scope}|${(t.project ?? '').toLowerCase()}|${t.file}`
/** The key of a template's open editor (#510): the workspace's folder and the template. */
const editKey = (t: TemplateRef): string => `${(get().workspace?.path ?? '').toLowerCase()}|${templateKey(t)}`
const draftOf = (t: TemplateEntry): TemplateDraft => ({ name: t.name, description: t.description ?? '', layout: t.layout, agents: t.agents.map((a) => ({ ...a })), pairs: (t.pairs ?? []).map((p) => ({ builder: pairIndex(t.agents, p.builder), reviewer: pairIndex(t.agents, p.reviewer) })).filter((p) => p.builder >= 0 && p.reviewer >= 0), ...(t.workflow ? { workflow: JSON.parse(JSON.stringify(t.workflow)) as TemplateWorkflows } : {}) })

/**
 * A draft's pairs as a template keeps them (#1440): by the agents' numbered names as the draft has them now, each only
 * while its builder builds and its reviewer reviews (a role changed drops its own pair).
 */
function draftPairs(d: TemplateDraft): TemplatePair[] {
  const names = pairNames(d.agents)
  return (d.pairs ?? []).filter((p) => d.agents[p.builder] && d.agents[p.reviewer] && p.builder !== p.reviewer && buildsWork(d.agents[p.builder].role) && reviewsWork(d.agents[p.reviewer].role)).map((p) => ({ builder: names[p.builder], reviewer: names[p.reviewer] }))
}

/** A draft's pairs after an agent is put at `at` (the others there and after move down one). */
const pairsInserted = (d: TemplateDraft, at: number): TemplateDraft['pairs'] => (d.pairs ?? []).map((p) => ({ builder: p.builder >= at ? p.builder + 1 : p.builder, reviewer: p.reviewer >= at ? p.reviewer + 1 : p.reviewer }))
const changed = (e: TemplateEdit | undefined): boolean => !!e && JSON.stringify(e.draft) !== JSON.stringify(e.saved)
const putEdit = (key: string, e: TemplateEdit | null): void => {
  set((s) => {
    const next = { ...s.templateEdits }
    if (e) next[key] = e
    else delete next[key]
    return { templateEdits: next }
  })
  mirrorEdit(key, e)
}
const templateFile = (t: TemplateRef): string => `${t.scope === 'project' ? t.project : (get().workspace?.path ?? '')}\\.combwork\\templates\\${t.file}`
const draftKey = (key: string): string => `template:${key}`

/**
 * A template draft with changes is one of the window's unsaved edits too (#510, editorDrafts): quitting, closing or
 * reloading the window and switching the workspace ask about it (Save All saves it, as Save Template does; Discard
 * drops it), as they do for files.
 */
function mirrorEdit(key: string, e: TemplateEdit | null): void {
  if (!e || !changed(e)) return clearEditorDraft(draftKey(key))
  setEditorDraft({ key: draftKey(key), label: tr(M.draftLabel, { name: e.saved.name }), abs: templateFile(e.ref), text: JSON.stringify(e.draft), base: JSON.stringify(e.saved), save: async (text) => JSON.stringify(draftOf(await saveEdit(key, JSON.parse(text) as TemplateDraft))) })
}
// Discarded from outside the editor (the quit dialog's Discard, a removed project): the editor's draft goes too.
onEditorDrafts(() => {
  const edits = get().templateEdits
  for (const [key, e] of Object.entries(edits)) if (changed(e) && !editorDraft(draftKey(key))) putEdit(key, null)
})

/**
 * Saves a template's draft `d` (as it is in the window's store when the save starts), expecting the revision the editor
 * has: what was saved becomes what it compares with; a draft changed while it was saving stays, unsaved, over it.
 */
async function saveEdit(key: string, d: TemplateDraft): Promise<TemplateEntry> {
  const now = get().templateEdits[key]
  if (!now) throw new Error(tr(M.noLongerEdited))
  // Its workflow as the editor has it (HI-1910): every section, {} when none is left (main reads it through the whitelist).
  const saved = await call('templates:update', now.ref, { name: d.name, description: d.description.trim() || undefined, layout: d.layout, agents: d.agents, pairs: draftPairs(d), workflow: d.workflow ?? {} }, now.savedAt ?? null)
  const after = get().templateEdits[key] ?? now
  putEdit(key, { ...after, savedAt: saved.savedAt, was: now.savedAt ?? null, saved: draftOf(saved), draft: JSON.stringify(after.draft) === JSON.stringify(d) ? draftOf(saved) : after.draft })
  bump()
  return saved
}
/** Where a listed template is, to name it in a call: its scope as listed (Combwork's own too, #1436), a project's with its project. */
const refOf = (t: TemplateEntry): TemplateRef => (t.scope === 'project' ? { scope: 'project', project: t.project, file: t.file } : { scope: t.scope, file: t.file })
/** A layout's name ("Two columns"), and inside a sentence ("two columns layout"). */
export const layoutText = (l: PageLayout): string => tr(M.layout, { layout: l })
const layoutPhrase = (l: PageLayout): string => tr(M.layoutPhrase, { layout: l })
const bump = (): void => set((s) => ({ templatesVersion: s.templatesVersion + 1 }))
const projectsNow = (): ProjectInfo[] => get().workspace?.projects ?? []
const sameProject = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase()
const projectName = (path: string | undefined): string => projectsNow().find((p) => sameProject(p.path, path))?.name ?? path?.split(/[\\/]/).pop() ?? tr(M.aProject)
/** Where a template is kept, for a message's select: the workspace, or a project by its name. */
const placeOf = (d: TemplateDest): { scope: 'workspace' | 'project'; project: string } => (d.scope === 'project' ? { scope: 'project', project: projectName(d.project) } : { scope: 'workspace', project: '' })
const unknownText = (ids: string[]): string => tr(M.unknown, { ids: fmt.list(ids, 'unit') })

/** Asks where to keep a template: the workspace, or a project. `initial`: a project's path, or '' for the workspace. */
async function pickPlace(title: string, message: string, confirmLabel: string, initial: string): Promise<TemplateDest | null> {
  let picked = initial
  const options = [{ label: tr(M.everyProject), value: '' }, ...projectsNow().map((p) => ({ label: tr(M.thisProjectOnly, { project: p.name }), value: p.path }))]
  const r = await choose({ title, message, select: { label: tr(M.keepIn), options, initial, set: (v) => (picked = v) }, choices: [{ label: confirmLabel, value: 'ok' }] })
  if (r !== 'ok') return null
  return picked ? { scope: 'project', project: picked } : { scope: 'workspace' }
}

/** Load into Project…: which project, then loading's own confirmation (who goes and who comes) and checks. */
async function loadInto(t: TemplateEntry, initial: string | null): Promise<void> {
  const projects = projectsNow()
  if (!projects.length) return notify('info', tr(M.noProjects), tr(M.addProjectFirst))
  let picked = projects.find((p) => sameProject(p.path, initial ?? undefined))?.path ?? projects[0].path
  const r = await choose({
    title: tr(M.loadTitle, { name: t.name }),
    message: tr(M.loadMessage),
    select: { label: tr(M.project), options: projects.map((p) => ({ label: p.name, value: p.path })), initial: picked, set: (v) => (picked = v) },
    choices: [{ label: tr(M.continue), value: 'ok' }]
  })
  if (r === 'ok') await actions.loadTemplate(picked, t, t.scope === 'project' ? t.project : undefined)
}

async function renameTemplate(t: TemplateEntry): Promise<void> {
  const name = await prompt({
    title: tr(M.renameTitle, { name: t.name }),
    initial: t.name,
    placeholder: tr(M.namePlaceholder),
    confirmLabel: tr(M.rename),
    validate: (v) => (!v.trim() ? tr(M.enterName) : v.trim().length > TEMPLATE_NAME_MAX ? tr(M.atMost, { max: TEMPLATE_NAME_MAX }) : null)
  })
  if (name === null || name.trim() === t.name) return
  if (await actions.attempt(tr(M.renameFailed), () => call('templates:rename', refOf(t), name))) bump()
}

async function duplicateTemplate(t: TemplateEntry, initial: string): Promise<TemplateEntry | null> {
  const to = await pickPlace(tr(M.duplicateTitle, { name: t.name }), tr(M.duplicateMessage), tr(M.duplicate), initial)
  if (!to) return null
  const r = await actions.attempt(tr(M.duplicateFailed), () => call('templates:duplicate', refOf(t), to))
  if (!r) return null
  bump()
  notify('success', tr(M.duplicated), tr(M.where, { name: r.name, ...placeOf(r) }))
  return r
}

async function deleteTemplate(t: TemplateEntry): Promise<boolean> {
  const ok = await confirm({
    title: tr(M.deleteTitle, { name: t.name }),
    message: tr(M.deleteMessage, placeOf(t)),
    confirmLabel: tr(M.delete),
    danger: true,
    busyLabel: tr(M.deleting),
    run: () => call('templates:delete', refOf(t))
  })
  if (ok) bump()
  return ok
}

async function exportTemplate(t: TemplateEntry): Promise<void> {
  const path = await actions.attempt(tr(M.exportFailed), () => call('templates:export', refOf(t)))
  if (path) notify('success', tr(M.exported), `${path}\n${tr(M.exportedDetail)}`)
}

/** Import…: a file (checked first: an invalid one is refused, saying why), where to keep it, and a name already there. */
export async function importTemplate(initial: string): Promise<TemplateEntry | null> {
  const picked = await actions.attempt(tr(M.importFailed), () => call('templates:pickImport'))
  if (!picked) return null
  const unknownNote = { hasUnknown: picked.unknown.length ? 'yes' : 'no', unknown: picked.unknown.length ? unknownText(picked.unknown) : '' } as const
  const to = await pickPlace(tr(M.importTitle, { name: picked.name }), tr(M.importMessage, { count: picked.agents, ...unknownNote }), tr(M.import), initial)
  if (!to) return null
  let r = await actions.attempt(tr(M.importFailed), () => call('templates:import', picked.path, to))
  if (r && 'clash' in r) {
    const how = await choose({
      title: tr(M.clashTitle),
      message: tr(M.clashMessage, { name: r.clash, ...placeOf(to) }),
      detail: tr(M.clashDetail),
      choices: [
        { label: tr(M.replace), value: 'replace' },
        { label: tr(M.keepBoth), value: 'keep' }
      ]
    })
    if (how !== 'replace' && how !== 'keep') return null
    r = await actions.attempt(tr(M.importFailed), () => call('templates:import', picked.path, to, how))
  }
  if (!r || !('imported' in r)) return null
  bump()
  notify(picked.unknown.length ? 'warning' : 'success', tr(M.imported), tr(M.importedDetail, { name: r.imported.name, ...placeOf(r.imported), ...unknownNote }))
  return r.imported
}

function ScopeBadge({ t }: { t: TemplateEntry }) {
  if (t.scope === 'combwork') return <span className="badge accent">{tr(M.combwork)}</span>
  return t.scope === 'workspace' ? <span className="badge accent">{tr(M.workspace)}</span> : <span className="badge">{projectName(t.project)}</span>
}

/** The agent a template's agent is paired with (#1436), by name: a builder's reviewer, or a reviewer's builder. */
function partnerOf(t: Pick<TemplateEntry, 'pairs'>, name: string): string | undefined {
  const same = (a: string): boolean => a.toLowerCase() === name.toLowerCase()
  const p = t.pairs?.find((x) => same(x.builder) || same(x.reviewer))
  return p ? (same(p.builder) ? p.reviewer : p.builder) : undefined
}

/**
 * A template whose names are patterns (Combwork's own, one saved with "Use the project key in names") as a project would
 * get it (#1123 names, #1440): its agents' and pairs' names made with that project's key (`{key}-B{n}` as HI-B1), so what
 * is shown is what loading makes; with no project, or its key not known, `{key}` stays (`{key}-B1`), never a guessed
 * key. Any other template as it is. Only for showing: the editor changes the template as it is kept.
 */
function asLoaded(t: TemplateEntry, projectPath: string | null | undefined): TemplateEntry {
  if (!t.agents.some((a) => /\{(key|n)\}/.test(a.name))) return t
  const key = (projectPath && get().projectKeys.find((k) => sameProject(k.projectPath, projectPath))?.key) || '{key}'
  const names = templateAgentNames(t.agents, key)
  const of = (n: string): string => names[pairIndex(t.agents, n)] ?? n
  return { ...t, agents: t.agents.map((a, i) => ({ ...a, name: names[i] })), ...(t.pairs ? { pairs: t.pairs.map((x) => ({ builder: of(x.builder), reviewer: of(x.reviewer) })) } : {}) }
}

/** A template's agent's role in the workflow (#1436), with its note and the agent it is paired with under it. */
function RoleCell({ a, partner }: { a: TemplateAgent; partner?: string }) {
  return (
    <td data-role={a.role}>
      {tr(WORKFLOW_ROLE_TEXT[a.role].name)}
      {partner && <div className="faint">{tr(M.pairedWith, { name: partner })}</div>}
      {a.note && <div className="faint">{a.note}</div>}
    </td>
  )
}

function TemplateRow({ t, selected, onSelect, showScope }: { t: TemplateEntry; selected: boolean; onSelect: () => void; showScope?: boolean }) {
  const unknown = unknownProviders(t.agents)
  const unsaved = useStore((s) => changed(s.templateEdits[`${(s.workspace?.path ?? '').toLowerCase()}|${templateKey(t)}`]))
  return (
    <div className={cx(/* i18n-ignore: class names */ 'row tall template-row', selected && 'selected')} role="button" tabIndex={0} aria-label={templateTitle(t)} data-scope={t.scope} onClick={onSelect} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect())}>
      <Icon name="library" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="label">
          {templateTitle(t)}
          {showScope && <ScopeBadge t={t} />}
          {unsaved && (
            <Tooltip content={tr(M.unsavedTip)}>
              <span className="badge warn template-unsaved">{tr(M.notSaved)}</span>
            </Tooltip>
          )}
          {(t.problem || unknown.length > 0) && (
            <Tooltip content={shownProblem(t) ?? unknownText(unknown)}>
              <span className="badge warn">{tr(t.problem ? M.cantBeUsed : M.unknownAgent)}</span>
            </Tooltip>
          )}
        </div>
        <OneLineDesc text={shownProblem(t) ?? tr(M.rowDesc, { count: t.agents.length, layout: layoutText(t.layout) })} />
      </div>
    </div>
  )
}

/** The CLI a template's agent suggests (HI-2109), with the MCP servers it chose under it. */
function SuggestsCell({ a }: { a: TemplateAgent }) {
  return (
    <td data-suggests={a.provider ?? ''}>
      {!a.provider ? <span className="faint">{tr(M.noSuggestion)}</span> : isKnownProvider(a.provider) ? providerName(a.provider) : <span className="badge warn">{tr(M.unknownProvider, { provider: a.provider })}</span>}
      {agentChoosesMcp(a) && <div className="faint">{tr(M.mcpServers, { servers: agentMcpText(a) })}</div>}
    </td>
  )
}

/** The Suggests column's heading, saying what a suggestion does. */
const SuggestsHeading = () => (
  <th>
    <Tooltip content={tr(M.suggestsTip)}>
      <span>{tr(M.colSuggests)}</span>
    </Tooltip>
  </th>
)

/** Opens the Agent Settings dialog for a template's agent (#271): the agent as saved there, or null (cancelled). */
let agentRequests = 0
function editTemplateAgent(template: string, agent: TemplateAgent | null, others: TemplateAgent[], project: string | undefined): Promise<TemplateAgent | null> {
  const taken = others.map((a) => a.name)
  return new Promise((resolve) => set({ templateAgentFor: { key: ++agentRequests, template, agent, suggestedName: uniqueName(tr(M.newAgentName), taken), others, project, resolve } }))
}

/**
 * Editing a template where it is kept (#271): its name, description and layout, and its agents (add, copy, remove,
 * reorder; each in the Agent Settings dialog). Saved whole, checked as an import is; refused if the template changed
 * meanwhile. A project loaded from it earlier is never touched. An agent's Save in its dialog saves the template too
 * (#510: Save means save), with the editor's other changes; the editor stays open. Its draft is kept in the window
 * (templateEdits) until it is saved or discarded, so leaving it some other way loses nothing.
 */
function TemplateEditor({ t, project, onDone }: { t: TemplateEntry; project?: ProjectInfo; onDone: () => void }) {
  const key = editKey(t)
  // As many as a project of this workspace can have: more couldn't be loaded here (#562).
  const limit = useAgentLimit(null)
  // The template as the editor opened it (or last saved it), kept whatever the list shows later: what the draft is
  // compared with, and the revision a save expects (a newer one there refuses it, so a save made meanwhile is never
  // overwritten).
  const kept = useStore((s) => s.templateEdits[key])
  const [first] = useState<TemplateEdit>(() => kept ?? { ref: refOf(t), savedAt: t.savedAt, saved: draftOf(t), draft: draftOf(t) })
  const edit0 = kept ?? first
  useEffect(() => {
    if (!get().templateEdits[key]) putEdit(key, first)
    // Left with nothing changed: nothing to keep.
    return () => {
      const e = get().templateEdits[key]
      if (e && !changed(e)) putEdit(key, null)
    }
  }, [key, first])
  const draft = edit0.draft
  const action = useBusy()
  const dirty = changed(edit0)
  // Saved again since it was opened (from a project, or another window): this draft would overwrite it, so it can't be saved.
  const staleFor = (e: TemplateEdit): boolean => (t.savedAt ?? null) !== (e.savedAt ?? null) && (e.was === undefined || (t.savedAt ?? null) !== e.was)
  const stale = staleFor(edit0)
  const setDraft = (f: (d: TemplateDraft) => TemplateDraft): void => {
    const now = get().templateEdits[key] ?? edit0
    putEdit(key, { ...now, draft: f(now.draft) })
  }
  const put = (patch: Partial<TemplateDraft>): void => setDraft((d) => ({ ...d, ...patch }))
  const agents = draft.agents
  const full = agents.length >= limit
  const problemOf = (d: TemplateDraft): string | null => (!d.name.trim() ? tr(M.needName) : !d.agents.length ? tr(M.needAgent) : null)
  const problem = problemOf(draft)
  const where = project?.path ?? (t.scope === 'project' ? t.project : undefined)
  /** Saves the draft as it is now (in the window's store). */
  const store = (): Promise<TemplateEntry> => saveEdit(key, (get().templateEdits[key] ?? edit0).draft)
  // While a save runs nothing can change (#510): every change made is one a save took, or one still marked not saved.
  const busy = !!action.busy
  const edit = async (i: number | null, copy = false): Promise<void> => {
    const base = i === null ? null : agents[i]
    // A copy of a pattern (`{key}-B{n}`) is the same pattern: it makes the next number.
    const seed = copy && base ? { ...base, name: base.name.includes('{n}') ? base.name : uniqueName(base.name, agents.map((a) => a.name)) } : base
    const others = agents.filter((_, j) => copy || j !== i)
    const got = await editTemplateAgent(draft.name.trim() || t.name, seed, others, where)
    if (!got) return
    setDraft((d) => {
      const next = [...d.agents]
      if (i === null || copy) {
        const at = i === null ? next.length : i + 1
        next.splice(at, 0, got)
        return { ...d, agents: next, pairs: pairsInserted(d, at) }
      }
      next[i] = got
      return { ...d, agents: next }
    })
    // Save means save (#510): the template is saved with it, unless it can't be yet (the draft says why).
    const now = get().templateEdits[key]
    if (!now || problemOf(now.draft) || staleFor(now)) return
    await action.run('save', async () => {
      const saved = await store()
      notify('success', tr(M.saved), tr(M.agentSaved, { name: saved.name, agent: got.name }))
    })
  }
  // Pairs follow their agents (#1440): by place, swapped with a move, gone with a removal.
  const move = (i: number, by: number): void =>
    setDraft((d) => {
      const next = [...d.agents]
      const [a] = next.splice(i, 1)
      next.splice(i + by, 0, a)
      const to = (x: number): number => (x === i ? i + by : x === i + by ? i : x)
      return { ...d, agents: next, pairs: (d.pairs ?? []).map((p) => ({ builder: to(p.builder), reviewer: to(p.reviewer) })) }
    })
  const remove = (i: number): void =>
    setDraft((d) => ({
      ...d,
      agents: d.agents.filter((_, j) => j !== i),
      pairs: (d.pairs ?? []).filter((p) => p.builder !== i && p.reviewer !== i).map((p) => ({ builder: p.builder > i ? p.builder - 1 : p.builder, reviewer: p.reviewer > i ? p.reviewer - 1 : p.reviewer }))
    }))
  const close = (): void => {
    putEdit(key, null)
    onDone()
  }
  const cancel = async (): Promise<void> => {
    if (dirty && !(await confirm({ title: tr(M.discardTitle), message: tr(M.discardMessage, { name: edit0.saved.name }), confirmLabel: tr(M.discard), danger: true }))) return
    close()
  }
  const save = async (): Promise<void> => {
    if (problem) return
    const ok = await action.run('save', async () => {
      const saved = await store()
      notify('success', tr(M.saved), tr(M.savedDetail, { name: saved.name, count: saved.agents.length, layout: layoutPhrase(saved.layout) }))
    })
    // Closed only when what is open is what was saved: anything newer stays, marked not saved.
    if (ok && !changed(get().templateEdits[key])) close()
  }
  return (
    <div className="template-detail template-editor">
      <div className="template-detail-head">
        <div className="template-detail-title">
          <Icon name="edit" />
          <h2>{tr(M.editTitle, { name: t.name })}</h2>
          <ScopeBadge t={t} />
        </div>
        <div className="template-detail-actions">
          {dirty && <span className="template-unsaved-note">{tr(M.changesNotSaved)}</span>}
          <button className="btn small subtle" disabled={!!action.busy} onClick={() => void cancel()}>
            {tr(dirty ? M.cancel : M.close)}
          </button>
          <BusyButton className="small primary" disabled={!!problem || !dirty} busy={action.busy === 'save'} busyLabel={tr(M.saving)} onClick={() => void save()}>
            <Icon name="save" /> {tr(M.saveTemplate)}
          </BusyButton>
        </div>
      </div>
      <div className="template-detail-body">
        {stale && (
          <p className="template-problem template-stale" role="alert">
            <Icon name="warning" /> {tr(M.stale, { name: t.name })}
            <button className="btn small subtle" disabled={busy} onClick={() => void cancel()}>
              {tr(M.discardReload)}
            </button>
          </p>
        )}
        {action.error && (
          <p className="template-problem" role="alert">
            <Icon name="error" /> {action.error}
          </p>
        )}
        <div className="agent-form template-fields">
          <label htmlFor="template-name">{tr(M.name)}</label>
          <input id="template-name" className="input" disabled={busy} value={draft.name} maxLength={TEMPLATE_NAME_MAX} onChange={(e) => put({ name: e.target.value })} />
          <label htmlFor="template-description">{tr(M.description)}</label>
          <textarea id="template-description" className="input" disabled={busy} rows={2} value={draft.description} maxLength={TEMPLATE_DESCRIPTION_MAX} placeholder={tr(M.descriptionPlaceholder)} onChange={(e) => put({ description: e.target.value })} />
          <label htmlFor="template-layout">{tr(M.layoutLabel)}</label>
          <select id="template-layout" className="select" disabled={busy} value={draft.layout} onChange={(e) => put({ layout: e.target.value as PageLayout })}>
            <option value="auto">{tr(M.automaticOption)}</option>
            {SESSION_LAYOUTS.map((l) => (
              <option key={l.value} value={l.value}>
                {layoutText(l.value)}
              </option>
            ))}
          </select>
        </div>
        <div className="template-editor-agents-head">
          <h3 className="agent-dialog-h">
            {tr(M.agentsHeading)} <span className="count">{agents.length}</span>
          </h3>
          <Tooltip content={full ? tr(M.fullTip, { limit }) : tr(M.addTip)}>
            <button className="btn small subtle" disabled={full || busy} onClick={() => void edit(null)}>
              <Icon name="add" /> {tr(M.addAgent)}
            </button>
          </Tooltip>
        </div>
        {problem && <p className="hint">{problem}</p>}
        <table className="table template-agents">
          <thead>
            <tr>
              <th>{tr(M.colAgent)}</th>
              <th>{tr(M.colRole)}</th>
              <SuggestsHeading />
              <th aria-label={tr(M.colActions)} />
            </tr>
          </thead>
          <tbody>
            {agents.map((a, i) => {
              // A CLI this Combwork doesn't know can't be chosen in the dialog: edited only once it is replaced.
              const known = !a.provider || isKnownProvider(a.provider)
              return (
                <tr key={`${i}|${a.name}`} data-agent={a.name}>
                  <td>{a.name}</td>
                  <RoleCell a={a} />
                  <SuggestsCell a={a} />
                  <td className="template-agent-actions">
                    <IconButton icon="edit" title={known ? tr(M.editAgent, { name: a.name }) : tr(M.cantEdit)} disabled={!known || busy} onClick={() => void edit(i)} />
                    <IconButton icon="copy" title={tr(M.copyAgent, { name: a.name })} disabled={!known || full || busy} onClick={() => void edit(i, true)} />
                    <IconButton icon="arrow-up" title={tr(M.moveUp, { name: a.name })} disabled={i === 0 || busy} onClick={() => move(i, -1)} />
                    <IconButton icon="arrow-down" title={tr(M.moveDown, { name: a.name })} disabled={i === agents.length - 1 || busy} onClick={() => move(i, 1)} />
                    <IconButton icon="trash" title={tr(M.removeAgent, { name: a.name })} disabled={busy} onClick={() => remove(i)} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="hint">{Children.toArray(tRich<React.ReactNode>(M.editorHint, { b: bold }))}</p>
        <TemplateWorkflowSection workflow={draft.workflow} dropped={t.workflowDropped} edit={{ disabled: busy, onChange: (workflow) => put({ workflow }) }} />
      </div>
    </div>
  )
}

/**
 * What a template holds and what to do with it: Edit… (#271) opens the editor in its place. `project`: loading goes
 * into this project (a project's Templates tab); without it, Load into Project… asks which.
 */
export function TemplateDetail({ t: entry, project, onGone, onSelect }: { t: TemplateEntry; project?: ProjectInfo; onGone: () => void; onSelect: (t: TemplateEntry) => void }) {
  // An editor left open with its draft (#510) opens again.
  const [editing, setEditing] = useState(() => changed(get().templateEdits[editKey(entry)]))
  const selectedProject = useStore((s) => s.selectedProject)
  useStore((s) => s.projectKeys)
  // Combwork's own shown with the names this project (or the one selected) would get.
  const t = asLoaded(entry, project?.path ?? selectedProject)
  // Duplicate offers the other place first: a project's into the workspace, the workspace's into a project.
  const otherPlace = t.scope === 'project' ? '' : (project?.path ?? selectedProject ?? projectsNow()[0]?.path ?? '')
  const unknown = unknownProviders(t.agents)
  // Combwork's own (#1436): loaded, duplicated and exported, never changed where they are.
  const readOnly = t.scope === 'combwork'
  const description = templateDescription(t)
  // The editor has the template as it is kept (#1440: its patterns, never the names they make here).
  if (editing && !t.problem && !readOnly) return <TemplateEditor t={entry} project={project} onDone={() => setEditing(false)} />
  return (
    <div className="template-detail" data-scope={t.scope}>
      <div className="template-detail-head">
        <div className="template-detail-title">
          <Icon name="library" />
          <h2>{templateTitle(t)}</h2>
          <ScopeBadge t={t} />
        </div>
        <div className="template-detail-actions">
          {!t.problem && (
            <Tooltip content={tr(project ? M.loadHereTip : M.loadAnyTip)}>
              <button className="btn small primary" onClick={() => void (project ? actions.loadTemplate(project.path, t, t.scope === 'project' ? t.project : undefined) : loadInto(t, selectedProject))}>
                <Icon name="debug-start" /> {tr(project ? M.loadHere : M.loadAny)}
              </button>
            </Tooltip>
          )}
          {!readOnly && (
            <>
              <Tooltip content={tr(M.editTip)}>
                <button className="btn small subtle" disabled={!!t.problem} onClick={() => setEditing(true)}>
                  <Icon name="settings" /> {tr(M.edit)}
                </button>
              </Tooltip>
              <button className="btn small subtle" disabled={!!t.problem} onClick={() => void renameTemplate(t)}>
                <Icon name="edit" /> {tr(M.renameButton)}
              </button>
            </>
          )}
          <button className="btn small subtle" disabled={!!t.problem} onClick={() => void duplicateTemplate(t, otherPlace).then((r) => r && onSelect(r))}>
            <Icon name="copy" /> {tr(M.duplicateButton)}
          </button>
          <button className="btn small subtle" disabled={!!t.problem} onClick={() => void exportTemplate(t)}>
            <Icon name="export" /> {tr(M.exportButton)}
          </button>
          {!readOnly && <IconButton icon="trash" title={tr(M.deleteTip)} onClick={() => void deleteTemplate(t).then((ok) => ok && onGone())} />}
        </div>
      </div>
      <div className="template-detail-body">
        {t.problem ? (
          <p className="template-problem">
            <Icon name="warning" /> {tr(M.problem, { problem: shownProblem(t) ?? '' })}
          </p>
        ) : (
          <>
            {description && <p className="template-description">{description}</p>}
            <p className="muted">
              {readOnly
                ? Children.toArray(tRich<React.ReactNode>(M.combworkSummary, { count: t.agents.length, layout: layoutPhrase(t.layout), b: bold }))
                : Children.toArray(tRich<React.ReactNode>(M.summary, { count: t.agents.length, layout: layoutPhrase(t.layout), hasSaved: t.savedAt ? 'yes' : 'no', when: t.savedAt ? timeAgo(t.savedAt) : '', ...placeOf(t), b: bold }))}
            </p>
            {/* A suggestion only where it has no workflow of its own (HI-1910: its sections say more). */}
            {t.suggestedPreset && !hasWorkflow(t.workflow) && (
              <p className="muted template-suggests" data-suggests={t.suggestedPreset}>
                {tr(M.suggests, { preset: tr(PRESET_TEXT[t.suggestedPreset]), pool: t.reviewerMode === 'pool' ? 'yes' : 'no' })}
              </p>
            )}
            {unknown.length > 0 && (
              <p className="template-problem">
                <Icon name="warning" /> {unknownText(unknown)}
              </p>
            )}
            <table className="table template-agents">
              <thead>
                <tr>
                  <th>{tr(M.colAgent)}</th>
                  <th>{tr(M.colRole)}</th>
                  <SuggestsHeading />
                </tr>
              </thead>
              <tbody>
                {t.agents.map((a) => (
                  <tr key={a.name} data-agent={a.name}>
                    <td>{a.name}</td>
                    <RoleCell a={a} partner={partnerOf(t, a.name)} />
                    <SuggestsCell a={a} />
                  </tr>
                ))}
              </tbody>
            </table>
            {(hasWorkflow(t.workflow) || !!t.workflowDropped?.length) && <TemplateWorkflowSection workflow={t.workflow} dropped={t.workflowDropped} />}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The workspace's templates and each project's, kept fresh (a change anywhere in this window bumps templatesVersion).
 * The sidebar and the main area each read them; reload reads them again in both, so the main area recovers when the
 * sidebar's Retry succeeds (#841).
 */
function useAllTemplates() {
  const wsPath = useStore((s) => s.workspace?.path ?? '')
  const version = useStore((s) => s.templatesVersion)
  const loaded = useScopedLoad<TemplateEntry[]>(wsPath)
  const { load: loadScoped } = loaded
  const load = useCallback(() => {
    if (wsPath) loadScoped(wsPath, () => call('templates:all'))
  }, [wsPath, loadScoped])
  useEffect(load, [load, version])
  return { ...loaded, reload: bump, wsPath }
}

const ALL = 'all'
const HIVE = 'combwork'
const WORKSPACE = 'workspace'

/** The Templates view's sidebar: every template, grouped by where it is kept, with a filter (All, Workspace, a project). */
export function TemplatesPanel() {
  const { data, error, at, reload, wsPath } = useAllTemplates()
  const selected = useStore((s) => s.selectedTemplate)
  const filter = useStore((s) => s.templateFilter)
  const projects = useStore((s) => s.workspace?.projects) ?? []
  const shownFilter = filter === ALL || filter === HIVE || filter === WORKSPACE || projects.some((p) => p.path === filter) ? filter : ALL
  const all = data ?? []
  const groups: { key: string; title: string; items: TemplateEntry[] }[] = [
    { key: HIVE, title: tr(M.combwork), items: all.filter((t) => t.scope === 'combwork') },
    { key: WORKSPACE, title: tr(M.workspace), items: all.filter((t) => t.scope === 'workspace') },
    ...projects.map((p) => ({ key: p.path, title: p.name, items: all.filter((t) => t.scope === 'project' && sameProject(t.project, p.path)) }))
  ].filter((g) => (shownFilter === ALL ? g.key === HIVE || g.key === WORKSPACE || g.items.length > 0 : g.key === shownFilter))
  const doImport = (): void =>
    void importTemplate(shownFilter !== ALL && shownFilter !== HIVE && shownFilter !== WORKSPACE ? shownFilter : '').then((t) => t && set({ selectedTemplate: templateKey(t), templateFilter: ALL }))
  return (
    <>
      <div className="pane-header">
        {tr(M.title)} <InfoTip text={tr(TEMPLATES_TIP)} />
        <div className="actions">
          <IconButton icon="cloud-download" title={tr(M.importButton)} onClick={doImport} disabled={!wsPath} />
          <IconButton icon="refresh" title={tr(M.refresh)} onClick={reload} disabled={!wsPath} />
        </div>
      </div>
      {wsPath && (
        <div style={{ padding: '0 8px 6px 12px' }}>
          <select className="select" style={{ width: '100%' }} aria-label={tr(M.showOf)} value={shownFilter} onChange={(e) => set({ templateFilter: e.target.value })}>
            <option value={ALL}>{tr(M.allTemplates)}</option>
            <option value={HIVE}>{tr(M.combwork)}</option>
            <option value={WORKSPACE}>{tr(M.workspace)}</option>
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="pane-body">
        {!wsPath && <div className="pane-empty">{tr(M.noWorkspace)}</div>}
        {wsPath && error && data && <StaleNote what={tr(M.refreshTarget)} error={error} at={at} onRetry={reload} />}
        {wsPath && error && !data && <LoadFailed inline what={tr(M.loadTarget)} error={error} onRetry={reload} />}
        {wsPath && !error && !data && (
          <div className="pane-empty">
            <Icon name="loading" spin /> {tr(M.loading)}
          </div>
        )}
        {data &&
          groups.map((g) => (
            <div key={g.key} className="template-group" data-group={g.key === HIVE || g.key === WORKSPACE ? g.key : 'project'}>
              <div className="skill-group">
                {g.title} <span className="count">{g.items.length}</span>
              </div>
              {g.items.length === 0 && <div className="pane-empty">{tr(g.key === HIVE ? M.noneCombwork : g.key === WORKSPACE ? M.noWorkspaceTemplates : M.noneOfItsOwn)}</div>}
              {g.items.map((t) => (
                <TemplateRow key={templateKey(t)} t={t} selected={selected === templateKey(t)} onSelect={() => set({ selectedTemplate: templateKey(t) })} />
              ))}
            </div>
          ))}
        {data && (
          <p className="hint" style={{ padding: '4px 14px' }}>
            {Children.toArray(tRich<React.ReactNode>(M.panelHint, { b: bold }))}
          </p>
        )}
      </div>
    </>
  )
}

/** The Templates view's main area: the selected template. */
export function TemplatesView() {
  const { data } = useAllTemplates()
  const selected = useStore((s) => s.selectedTemplate)
  const t = selected ? data?.find((x) => templateKey(x) === selected) : undefined
  if (!t) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="library" />
        {tr(selected && data ? M.gone : M.selectOne)}
      </div>
    )
  }
  return (
    <div className="split">
      <TemplateDetail key={templateKey(t)} t={t} onGone={() => set({ selectedTemplate: null })} onSelect={(x) => set({ selectedTemplate: templateKey(x) })} />
    </div>
  )
}

/** A project's Templates tab: its own templates and the workspace's, each with its scope; loading goes into this project. */
export function ProjectTemplatesTab({ project }: { project: ProjectInfo }) {
  const version = useStore((s) => s.templatesVersion)
  const listWidth = usePaneSize('projectTemplates', 300)
  const loaded = useScopedLoad<TemplateEntry[]>(project.path)
  const { load: loadScoped } = loaded
  const load = useCallback(() => {
    const path = project.path
    loadScoped(path, () => call('templates:list', path))
  }, [project.path, loadScoped])
  useEffect(load, [load, version])
  const [selected, setSelected] = useState<string | null>(null)
  const list = loaded.data
  const mine = (list ?? []).filter((t) => t.scope === 'project')
  const shared = (list ?? []).filter((t) => t.scope === 'workspace')
  const combwork = (list ?? []).filter((t) => t.scope === 'combwork')
  const current = selected ? list?.find((t) => templateKey(t) === selected) : undefined
  const row = (t: TemplateEntry) => <TemplateRow key={templateKey(t)} t={t} showScope selected={selected === templateKey(t)} onSelect={() => setSelected(templateKey(t))} />
  // The list beside the template, or above it when the tab is narrow (#890; app.css `.templates-split`, as Changes').
  return (
    <div className="templates-split" style={{ '--list-width': `${listWidth}px` } as React.CSSProperties}>
    <div className="split">
      <div className="split-list">
        <PaneResizer paneKey="projectTemplates" max={600} />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          {tr(M.title)} <InfoTip text={tr(TEMPLATES_TIP)} />
          <div className="actions">
            <IconButton icon="cloud-download" title={tr(M.importButton)} onClick={() => void importTemplate(project.path).then((t) => t && setSelected(templateKey(t)))} />
            <IconButton icon="refresh" title={tr(M.refresh)} onClick={load} />
          </div>
        </div>
        {loaded.error && list && <StaleNote what={tr(M.refreshTarget)} error={loaded.error} at={loaded.at} onRetry={load} />}
        <div className="pane-body">
          {loaded.error && !list && <LoadFailed inline what={tr(M.loadTarget)} error={loaded.error} onRetry={load} />}
          {!loaded.error && !list && (
            <div className="pane-empty">
              <Icon name="loading" spin /> {tr(M.loading)}
            </div>
          )}
          {list && (
            <>
              <div className="skill-group">
                {tr(M.thisProject)} <span className="count">{mine.length}</span>
              </div>
              {mine.length === 0 && <div className="pane-empty">{tr(M.noneYet)}</div>}
              {mine.map(row)}
              <div className="skill-group">
                {tr(M.workspace)} <span className="count">{shared.length}</span>
              </div>
              {shared.length === 0 && <div className="pane-empty">{tr(M.noWorkspaceTemplates)}</div>}
              {shared.map(row)}
              <div className="skill-group">
                {tr(M.combwork)} <span className="count">{combwork.length}</span>
              </div>
              {combwork.map(row)}
              <p className="hint" style={{ padding: '4px 14px' }}>
                {Children.toArray(tRich<React.ReactNode>(M.tabHint, { b: bold, view: templatesViewLink }))}
              </p>
            </>
          )}
        </div>
      </div>
      <div className="split-main">
        {current ? (
          <TemplateDetail key={templateKey(current)} t={current} project={project} onGone={() => setSelected(null)} onSelect={(x) => setSelected(sameProject(x.project, project.path) || x.scope !== 'project' ? templateKey(x) : null)} />
        ) : (
          <div className="empty-state" style={{ paddingTop: '18vh' }}>
            <Icon name="library" />
            {tr(M.selectOneHere)}
          </div>
        )}
      </div>
    </div>
    </div>
  )
}
