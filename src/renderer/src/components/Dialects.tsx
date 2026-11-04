/**
 * The Dialects view (HI-2444; plans/2026-11-03-dialects-design.md, section 4; Darren's decisions on HI-2065): the
 * workspace's dialect files in the sidebar (the Workspace file, each CLI's folder, the API's), and the file shown in the
 * main area with every agent text, even when the file is empty. A text the file overrides shows as written; one it
 * doesn't is dimmed, with the layer it comes from; expanding one shows each layer's value. Save checks the schema only
 * (main refuses a file that fails, saying why); outdated overrides are flagged beside the Default. The file's actions:
 * Duplicate (a test copy, no model), Import, Export, on/off, Revert to shipped, Use for <model> (Promote), Delete (the
 * user's own files only), and "restart to apply" for the running agents whose chain the file changed.
 *
 * One draft per file, kept across reloads (a change on disk is said, never overwritten): the Texts tab edits its texts,
 * the JSON tab its whole text, which must read as a dialect file before the Texts tab takes it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isKnownProvider, providerDescriptor } from '@shared/providers'
import { fmt, msg, tr } from '@shared/i18n'
import {
  changedAnywhere,
  changedHere,
  dialectFileText,
  layerValues,
  parseDialectFile,
  shownText,
  type DialectCatalogue,
  type DialectCatalogueText,
  type DialectFile,
  type DialectFileView,
  type DialectLayer,
  type DialectRefusal,
  type DialectRow,
  type DialectUsage,
  type FileProblem,
  type TextProblem,
  type TextSource
} from '@shared/dialects'
import { call } from '../api'
import * as actions from '../actions'
import { confirm, notify, prompt, set, useStore } from '../store'
import { useScopedLoad } from '../scopedLoad'
import { cx } from '../util'
import { CodeEditor } from './Editors'
import { dialectOnTip } from './dialectOnTip'
import { Section } from './Sidebar'
import { Icon, IconButton, LoadFailed, SearchInput, Switch, Tooltip } from './ui'

const M = {
  title: msg({ id: 'dialects.title', defaultMessage: 'Dialects', description: 'Title of the Dialects view (HI-2444): the wording Hive gives agents, tuned per model and CLI. Glossary: dialect.' }),
  tip: msg({ id: 'dialects.tip', defaultMessage: "The wording Combwork gives agents: its guidance, its tools' descriptions and replies, its wakes. A dialect file changes some of it, for a model, a CLI or the whole workspace; everything else stays Combwork's own. A change applies at each agent's next launch.", description: "Tooltip on the Dialects view's title (HI-2444). Glossary: dialect." }),
  import: msg({ id: 'dialects.import', defaultMessage: 'Import Dialect File…', description: 'A button in the Dialects view (HI-2444): adds a dialect file from a file. Glossary: dialect.' }),
  refresh: msg({ id: 'dialects.refresh', defaultMessage: 'Refresh', description: 'A button in the Dialects view: reads the dialect files again.' }),
  filter: msg({ id: 'dialects.filter', defaultMessage: 'Filter files', description: "The Dialects view's search box placeholder: filters the list of dialect files by name or model." }),
  workspaceGroup: msg({ id: 'dialects.group.workspace', defaultMessage: 'Workspace', description: "A group of the Dialects view's list: the workspace's own dialect file, which every agent's chain has. Glossary: dialect." }),
  apiGroup: msg({ id: 'dialects.group.api', defaultMessage: 'API (scripts)', description: "A group of the Dialects view's list: the dialect file for callers with no agent session (scripts, curl). Glossary: dialect." }),
  loading: msg({ id: 'dialects.loading', defaultMessage: 'Loading…', description: 'The Dialects view while it reads the dialect files.' }),
  noWorkspace: msg({ id: 'dialects.noWorkspace', defaultMessage: 'Open a workspace to see its dialects.', description: 'The Dialects view with no workspace open. Glossary: dialect.' }),
  listTarget: msg({ id: 'dialects.listTarget', defaultMessage: 'the dialect files', description: "What failed to load, in \"Couldn't load …\": the workspace's dialect files. Glossary: dialect." }),
  fileTarget: msg({ id: 'dialects.fileTarget', defaultMessage: 'this dialect file', description: "What failed to load, in \"Couldn't load …\": the dialect file shown. Glossary: dialect." }),
  select: msg({ id: 'dialects.select', defaultMessage: 'Choose a dialect file to see every text it gives agents.', description: 'The Dialects view with no file chosen. Glossary: dialect.' }),
  gone: msg({ id: 'dialects.gone', defaultMessage: 'This dialect file is no longer there.', description: 'The Dialects view: the file shown was deleted or renamed meanwhile. Glossary: dialect.' }),
  kind: {
    workspace: msg({ id: 'dialects.kind.workspace', defaultMessage: 'Every agent in the workspace', description: "What the Workspace dialect file applies to, under its name in the Dialects view's list. Glossary: dialect." }),
    cli: msg({ id: 'dialects.kind.cli', defaultMessage: 'Every {cli} agent', description: "What a CLI's dialect file applies to, under its name in the Dialects view's list; {cli} is the CLI (\"Codex\"). Glossary: dialect." }),
    api: msg({ id: 'dialects.kind.api', defaultMessage: 'Callers with no session', description: "What the API dialect file applies to (scripts, curl), under its name in the Dialects view's list. Glossary: dialect." }),
    model: msg({ id: 'dialects.kind.model', defaultMessage: 'Model {model}', description: "What a model file applies to, under its name in the Dialects view's list: agents running that model ID ({model}, as Hive matches it). Glossary: dialect." }),
    copy: msg({ id: 'dialects.kind.copy', defaultMessage: 'Test copy: agents that pick it', description: "What a test copy (a dialect file with no model) applies to, under its name in the Dialects view's list: only agents whose Dialect setting names it. Glossary: dialect, test copy." })
  },
  state: {
    shipped: msg({ id: 'dialects.state.shipped', defaultMessage: 'Shipped', description: 'A badge on a dialect file in the Dialects view: as Hive ships it. Glossary: dialect.' }),
    edited: msg({ id: 'dialects.state.edited', defaultMessage: 'Edited', description: 'A badge on a dialect file in the Dialects view: shipped with Hive, and changed here (Revert puts it back). Glossary: dialect.' }),
    yours: msg({ id: 'dialects.state.yours', defaultMessage: 'Yours', description: "A badge on a dialect file in the Dialects view: one the user made (a copy, an import), not Hive's. Glossary: dialect." })
  },
  outdatedBadge: msg({ id: 'dialects.outdatedBadge', defaultMessage: '{count, plural, one {# outdated} other {# outdated}}', description: "A warning badge on a dialect file in the Dialects view: how many of its texts no longer match this Hive's (they fall through to the layer below). Glossary: outdated." }),
  brokenBadge: msg({ id: 'dialects.brokenBadge', defaultMessage: "Can't be read", description: "A warning badge on a dialect file in the Dialects view: it isn't JSON or a dialect file's shape, so it adds nothing. Glossary: dialect." }),
  updateBadge: msg({ id: 'dialects.updateBadge', defaultMessage: 'Update available', description: 'A badge on an edited shipped dialect file: this Hive ships a newer version (Revert brings it in). Glossary: dialect.' }),
  claimTaken: msg({ id: 'dialects.claimTaken', defaultMessage: 'Another file of this folder, {by}, claims model {model} first: Auto never picks this one.', description: "A warning on a dialect file whose model another file of the same CLI folder claims too (made outside Hive): {by} is that file, {model} the model ID. Glossary: dialect." }),
  usedBy: msg({ id: 'dialects.usedBy', defaultMessage: '{count, plural, one {Used by # running agent: {agents}} other {Used by # running agents: {agents}}}', description: 'Tooltip on the agents count of a dialect file in the Dialects view: the running agents whose dialect chain has it, by name. Glossary: dialect.' }),
  onSwitch: msg({ id: 'dialects.onSwitch', defaultMessage: '{name} on', description: "A dialect file's on/off switch in the Dialects view, for screen readers. {name} is the file's name. Glossary: dialect." }),
  onFailed: msg({ id: 'dialects.onFailed', defaultMessage: "Couldn't switch {name} on or off", description: 'A notice: switching a dialect file on or off failed. {name} is the file. Glossary: dialect.' }),
  // The file
  save: msg({ id: 'dialects.save', defaultMessage: 'Save', description: "The Dialects view's Save button: writes the file's changes, checked against this Hive's texts first." }),
  saving: msg({ id: 'dialects.saving', defaultMessage: 'Saving…', description: "The Dialects view's Save button while it saves." }),
  discard: msg({ id: 'dialects.discard', defaultMessage: 'Discard Changes', description: "The Dialects view's button: drops the file's unsaved changes." }),
  saved: msg({ id: 'dialects.saved', defaultMessage: "{name} saved: it applies at each agent's next launch.", description: 'A notice after saving a dialect file. {name} is the file. Glossary: dialect.' }),
  duplicate: msg({ id: 'dialects.duplicate', defaultMessage: 'Duplicate…', description: "A button of a dialect file in the Dialects view: makes a test copy of it beside it (no model), to try on one agent. Glossary: test copy." }),
  duplicateTitle: msg({ id: 'dialects.duplicateTitle', defaultMessage: 'Duplicate {name}', description: 'Title of the dialog naming a copy of a dialect file. {name} is the file. Glossary: dialect.' }),
  duplicateMessage: msg({ id: 'dialects.duplicateMessage', defaultMessage: "The copy has the same texts and no model, so no agent uses it until its Dialect setting picks it (Agent Settings). Use for a model makes it the one Auto picks.", description: 'The Duplicate dialog of a dialect file. "Use for a model" names the Promote button. Glossary: dialect, test copy.' }),
  copyLabel: msg({ id: 'dialects.copyLabel', defaultMessage: '{name} copy', description: "A copy's suggested name in the Duplicate dialog. {name} is the file copied." }),
  create: msg({ id: 'dialects.create', defaultMessage: 'Create', description: "The Duplicate and Import dialogs' button." }),
  export: msg({ id: 'dialects.export', defaultMessage: 'Export…', description: 'A button of a dialect file in the Dialects view: writes it as it is to a file you choose.' }),
  exported: msg({ id: 'dialects.exported', defaultMessage: 'Exported to {path}', description: 'A notice after exporting a dialect file. {path} is where it was written.' }),
  revert: msg({ id: 'dialects.revert', defaultMessage: 'Revert to Shipped', description: 'A button of an edited shipped dialect file: puts back the file as Hive ships it. Glossary: dialect.' }),
  revertTitle: msg({ id: 'dialects.revertTitle', defaultMessage: 'Revert {name}?', description: 'Title of the confirmation before reverting a dialect file. {name} is the file.' }),
  revertMessage: msg({ id: 'dialects.revertMessage', defaultMessage: "Your changes to it are lost, and it follows Combwork's updates again.", description: 'The confirmation before reverting a dialect file to the version Hive ships. Glossary: dialect.' }),
  promote: msg({ id: 'dialects.promote', defaultMessage: 'Use for a Model…', description: "A button of a test copy in the Dialects view: makes it the file Auto picks for a model ID (the file that had it becomes a test copy). Glossary: test copy." }),
  promoteTitle: msg({ id: 'dialects.promoteTitle', defaultMessage: 'Use {name} for a model', description: 'Title of the Promote dialog of a test copy. {name} is the file. Glossary: dialect.' }),
  promoteMessage: msg({ id: 'dialects.promoteMessage', defaultMessage: "Agents on Auto running this model ID get this file from their next launch. A file that had the model keeps its texts, as a test copy.", description: 'The Promote dialog of a test copy (Dialects view). Glossary: dialect, test copy.' }),
  promoteField: msg({ id: 'dialects.promoteField', defaultMessage: 'Model ID', description: 'The Promote dialog\'s field: the real model ID ("claude-opus-5-5").' }),
  promoteButton: msg({ id: 'dialects.promoteButton', defaultMessage: 'Use for This Model', description: "The Promote dialog's button." }),
  deleteFile: msg({ id: 'dialects.delete', defaultMessage: 'Delete', description: 'A button of a dialect file the user made: moves it to the Recycle Bin.' }),
  deleteTitle: msg({ id: 'dialects.deleteTitle', defaultMessage: 'Delete {name}?', description: 'Title of the confirmation before deleting a dialect file. {name} is the file.' }),
  deleteMessage: msg({ id: 'dialects.deleteMessage', defaultMessage: 'It goes to the Recycle Bin. Agents whose Dialect setting names it use Auto from their next launch.', description: 'The confirmation before deleting a dialect file. Glossary: dialect.' }),
  restart: msg({ id: 'dialects.restart', defaultMessage: '{count, plural, one {Restart to apply: {agents} runs on this file as it was.} other {Restart to apply: {agents} run on this file as it was.}}', description: 'A banner on a dialect file in the Dialects view: running agents whose dialect chain this file changed since their launch; they get the change when they restart. {agents} is their names. Glossary: dialect.' }),
  changedOutside: msg({ id: 'dialects.changedOutside', defaultMessage: 'This file changed outside Combwork while you were editing it.', description: 'A banner in the Dialects view: the dialect file changed on disk (an editor, git, another window) while it has unsaved changes here.' }),
  reload: msg({ id: 'dialects.reload', defaultMessage: 'Reload (Lose My Changes)', description: "The Dialects view's button on a file changed outside Hive: reads it again, dropping the unsaved changes." }),
  keepMine: msg({ id: 'dialects.keepMine', defaultMessage: 'Keep My Changes', description: "The Dialects view's button on a file changed outside Hive: keeps the unsaved changes; the next Save writes over the change made outside." }),
  tabTexts: msg({ id: 'dialects.tab.texts', defaultMessage: 'Texts', description: "A tab of a dialect file in the Dialects view: every text, with the file's overrides." }),
  tabJson: msg({ id: 'dialects.tab.json', defaultMessage: 'JSON', description: "A tab of a dialect file in the Dialects view: the file's JSON text, to edit as text." }),
  tabs: msg({ id: 'dialects.tabs', defaultMessage: 'How to show {name}', description: "The Dialects view's tabs (Texts, JSON), for screen readers. {name} is the file." }),
  jsonBad: msg({ id: 'dialects.jsonBad', defaultMessage: 'Not a dialect file yet: {why}', description: "Under the Dialects view's JSON tab: the text as typed can't be read as a dialect file; {why} says why. Glossary: dialect." }),
  jsonLeaveTitle: msg({ id: 'dialects.jsonLeaveTitle', defaultMessage: "The JSON isn't a dialect file", description: "Title of the question when leaving the JSON tab with text that can't be read as a dialect file." }),
  jsonLeaveMessage: msg({ id: 'dialects.jsonLeaveMessage', defaultMessage: 'The Texts tab can only show the file as it last read: {why}. Drop what you typed since then?', description: "The question when leaving the Dialects view's JSON tab with text that isn't a dialect file; {why} says why." }),
  jsonLeave: msg({ id: 'dialects.jsonLeave', defaultMessage: 'Drop It', description: 'The button that drops the JSON typed since it last read as a dialect file, and shows the Texts tab.' }),
  // Texts
  search: msg({ id: 'dialects.search', defaultMessage: 'Search texts', description: "The Dialects view's search box over a file's texts (by id or wording)." }),
  show: msg({ id: 'dialects.show', defaultMessage: 'Show', description: "The label of the Dialects view's filter of texts (All, Changed in this file, Changed anywhere)." }),
  showAll: msg({ id: 'dialects.show.all', defaultMessage: 'All texts', description: "The Dialects view's filter: every agent text." }),
  showHere: msg({ id: 'dialects.show.here', defaultMessage: 'Changed in this file', description: "The Dialects view's filter: only the texts this file overrides." }),
  showAnywhere: msg({ id: 'dialects.show.anywhere', defaultMessage: 'Changed anywhere', description: "The Dialects view's filter: the texts this file or a layer beneath it overrides. Glossary: layer." }),
  counts: msg({ id: 'dialects.counts', defaultMessage: '{overrides, plural, one {# text changed here} other {# texts changed here}} of {total, number}', description: "The Dialects view's count over a file's texts: how many it overrides, of every agent text." }),
  outdatedGroup: msg({ id: 'dialects.outdatedGroup', defaultMessage: 'Outdated', description: "The Dialects view's group of a file's overrides that no longer match this Hive's texts: they fall through to the layer below until edited or removed. Glossary: outdated." }),
  showMore: msg({ id: 'dialects.showMore', defaultMessage: 'Show {count, number} more', description: 'A button under a long group of texts in the Dialects view: shows more of them.' }),
  noMatch: msg({ id: 'dialects.noMatch', defaultMessage: 'No text matches.', description: "The Dialects view's texts with a search or filter that matches none." }),
  from: {
    file: msg({ id: 'dialects.from.file', defaultMessage: 'This file', description: "Where a text in the Dialects view comes from: the file shown overrides it. Glossary: dialect." }),
    model: msg({ id: 'dialects.from.model', defaultMessage: 'from {name}', description: 'Where an inherited text in the Dialects view comes from: a model file or test copy, {name}.' }),
    cli: msg({ id: 'dialects.from.cli', defaultMessage: 'from {cli} CLI', description: "Where an inherited text in the Dialects view comes from: the CLI's dialect file ({cli}: \"Codex\")." }),
    api: msg({ id: 'dialects.from.api', defaultMessage: 'from API', description: 'Where an inherited text in the Dialects view comes from: the API dialect file (callers with no session).' }),
    workspace: msg({ id: 'dialects.from.workspace', defaultMessage: 'from Workspace', description: "Where an inherited text in the Dialects view comes from: the workspace's dialect file." }),
    default: msg({ id: 'dialects.from.default', defaultMessage: 'from Default', description: "Where an inherited text in the Dialects view comes from: Hive's own wording (the Default). Glossary: Default (dialects)." })
  },
  layerOff: msg({ id: 'dialects.layerOff', defaultMessage: '{layer} (off)', description: 'A layer in a text\'s expanded view in the Dialects view, switched off: its text doesn\'t apply. {layer} is its name ("from Workspace").' }),
  none: msg({ id: 'dialects.none', defaultMessage: '—', description: 'A layer with no text of its own in a text\'s expanded view (Dialects view). A dash: keep it short.' }),
  note: msg({ id: 'dialects.note', defaultMessage: 'Note', description: "In a text's expanded view (Dialects view): the note beside the text in Hive's code, saying where it is used." }),
  placeholders: msg({ id: 'dialects.placeholders', defaultMessage: 'Placeholders: {names}', description: "In a text's expanded view (Dialects view): the placeholders its text must have, exactly ({names}: \"{project}, {count}\")." }),
  noPlaceholders: msg({ id: 'dialects.noPlaceholders', defaultMessage: 'No placeholders', description: "In a text's expanded view (Dialects view): its text has no placeholders." }),
  why: msg({ id: 'dialects.why', defaultMessage: 'Why', description: "The field for an override's reason in the Dialects view: why it is worded so (shown to whoever reads the file)." }),
  whyPlaceholder: msg({ id: 'dialects.whyPlaceholder', defaultMessage: 'What it fixes, and how it was measured', description: "The placeholder of an override's Why field in the Dialects view." }),
  text: msg({ id: 'dialects.text', defaultMessage: 'Text', description: "The field for an override's text in the Dialects view." }),
  override: msg({ id: 'dialects.override', defaultMessage: 'Change Here', description: "A button on an inherited text in the Dialects view: starts this file's own override of it, from the text it inherits." }),
  removeOverride: msg({ id: 'dialects.removeOverride', defaultMessage: 'Remove Override', description: "A button on a text this dialect file overrides: removes the override, so the text inherits again." }),
  noDefault: msg({ id: 'dialects.noDefault', defaultMessage: 'No current Default: this text was removed or renamed in this Combwork.', description: "In the Dialects view, beside an outdated override whose id this Hive no longer has. Glossary: Default (dialects), outdated." }),
  defaultNow: msg({ id: 'dialects.defaultNow', defaultMessage: 'The Default now: {text}', description: "In the Dialects view, beside an outdated override: Hive's current wording of the text. Glossary: Default (dialects), outdated." }),
  problem: {
    unknown: msg({ id: 'dialects.problem.unknown', defaultMessage: '{id}: no such text in this Combwork (removed or renamed).', description: 'Why a dialect override is outdated or refused: its id ({id}) isn\'t one of this Hive\'s texts.' }),
    shape: msg({ id: 'dialects.problem.shape', defaultMessage: '{id}: not a "text" with an optional "why".', description: "Why a dialect override is outdated or refused: its entry ({id}) isn't an object with a text and an optional reason. \"text\" and \"why\" are the file's field names: keep them." }),
    unparsable: msg({ id: 'dialects.problem.unparsable', defaultMessage: "{id}: its text can't be read ({detail}).", description: "Why a dialect override is outdated or refused: its text ({id}) isn't valid message syntax; {detail} is the parser's English error." }),
    missing: msg({ id: 'dialects.problem.missing', defaultMessage: '{id}: missing {names}.', description: 'Why a dialect override is outdated or refused: its text ({id}) lacks placeholders it needs ({names}: "{project}, {count}").' }),
    extra: msg({ id: 'dialects.problem.extra', defaultMessage: '{id}: {names} not known here.', description: "Why a dialect override is outdated or refused: its text ({id}) has placeholders its id doesn't take ({names})." }),
    changed: msg({ id: 'dialects.problem.changed', defaultMessage: '{id}: {names} used as another kind.', description: 'Why a dialect override is outdated or refused: placeholders of its text ({id}) are used as another kind (a number as a plain value, say) ({names}).' })
  },
  refused: {
    title: msg({ id: 'dialects.refused.title', defaultMessage: 'Not saved', description: 'Heading of the reasons a dialect file was refused (Dialects view): nothing was written.' }),
    path: msg({ id: 'dialects.refused.path', defaultMessage: "That isn't a dialect file's place.", description: "A dialect file's save, import or copy refused: its path isn't one Hive accepts." }),
    file: msg({ id: 'dialects.refused.file', defaultMessage: "It isn't a dialect file: {why}", description: "A dialect file's save or import refused: the text isn't JSON or a dialect file's shape; {why} says what." }),
    modelHere: msg({ id: 'dialects.refused.modelHere', defaultMessage: 'Only a model file or test copy in a CLI folder can have a model: not the Workspace, CLI or API file.', description: "A dialect file's save refused: it names a model, where none may be. Glossary: dialect." }),
    modelClaimed: msg({ id: 'dialects.refused.modelClaimed', defaultMessage: '{by} already claims model {model}: a folder has one file per model.', description: "A dialect file's save refused: another file of the folder ({by}) claims the same model ID ({model}). Glossary: dialect." }),
    nameTaken: msg({ id: 'dialects.refused.nameTaken', defaultMessage: '{path} is already there: choose another name.', description: "A dialect file's import or copy refused: a file of that name ({path}) exists. Glossary: dialect." }),
    missing: msg({ id: 'dialects.refused.missing', defaultMessage: '{path} is no longer there.', description: 'A change to a dialect file refused: the file ({path}) was deleted meanwhile.' }),
    changedOnDisk: msg({ id: 'dialects.refused.changedOnDisk', defaultMessage: 'The file changed outside Combwork since you started editing it: nothing was saved.', description: "A dialect file's save refused: it changed on disk meanwhile (an editor, git, another window). The view then offers Reload or Keep My Changes." }),
    protected: msg({ id: 'dialects.refused.protected', defaultMessage: "The Workspace file, a CLI's file and a shipped file can't be deleted.", description: 'A dialect file\'s delete refused: it is part of the chain\'s baseline (a shipped one has Revert).' })
  },
  fileProblem: {
    json: msg({ id: 'dialects.fileProblem.json', defaultMessage: "it isn't JSON", description: 'Why a text isn\'t a dialect file (Dialects view). Lower case: it follows a colon.' }),
    shape: msg({ id: 'dialects.fileProblem.shape', defaultMessage: '"{field}" is missing or of the wrong kind', description: 'Why a text isn\'t a dialect file (Dialects view): one of its fields ({field}: name, model, texts) is wrong. Lower case: it follows a colon.' })
  },
  importTitle: msg({ id: 'dialects.importTitle', defaultMessage: 'Import {file}', description: 'Title of the Import dialog of a dialect file. {file} is the file chosen.' }),
  importMessage: msg({ id: 'dialects.importMessage', defaultMessage: "It is checked against this Combwork's texts. If its model is already claimed in the folder, it comes in as a test copy.", description: 'The Import dialog of a dialect file. Glossary: dialect, test copy.' }),
  importFolder: msg({ id: 'dialects.importFolder', defaultMessage: 'Folder', description: "The Import dialog's choice of folder: a CLI's, or the API's." }),
  importName: msg({ id: 'dialects.importName', defaultMessage: 'Name', description: "The Import and Duplicate dialogs' field: the file's name." }),
  imported: msg({ id: 'dialects.imported', defaultMessage: '{path} imported.', description: 'A notice after importing a dialect file. {path} is where it went.' }),
  importedCopy: msg({ id: 'dialects.importedCopy', defaultMessage: '{path} imported as a test copy: its model is already claimed in that folder.', description: 'A notice after importing a dialect file whose model another file of the folder claims: it came in without a model. Glossary: test copy.' }),
  nameProblem: msg({ id: 'dialects.nameProblem', defaultMessage: 'A name with no / \\ : * ? " < > |, not starting with a dot.', description: "The Import and Duplicate dialogs: the name has a character Windows refuses in a file name, or starts with a dot. Keep the characters." }),
  failed: msg({ id: 'dialects.failed', defaultMessage: "Couldn't change {name}", description: 'A notice: an action on a dialect file failed. {name} is the file.' })
}

const NO_ROWS: DialectRow[] = []
const NO_USAGE: DialectUsage[] = []
const ROWS_PER_PAGE = 200

/** The catalogue, read once a run (it is this Hive's, the same for every workspace). */
let catalogueRead: Promise<DialectCatalogue> | null = null
function useCatalogue(): DialectCatalogue | null {
  const [c, setC] = useState<DialectCatalogue | null>(null)
  useEffect(() => {
    let live = true
    catalogueRead ??= call('dialects:catalogue').catch((e) => {
      catalogueRead = null
      throw e
    })
    void catalogueRead.then((x) => live && setC(x)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  return c
}

/** The running agents' chains, read again when the files, skills or running sessions change; this workspace's only. */
function useUsage(wsPath: string): DialectUsage[] {
  const version = useStore((s) => s.dialectsVersion)
  const skills = useStore((s) => s.skillsVersion)
  // Its sessions as they start, stop and are told to restart: a string, so the same sessions select the same value.
  const running = useStore((s) => (s.workspace?.projects ?? []).flatMap((p) => p.agents.map((a) => (a.live ? `${a.id}:${a.live.runId}:${a.restartNeeded ? 1 : 0}` : ''))).join(','))
  const loaded = useScopedLoad<DialectUsage[]>(wsPath)
  const { load } = loaded
  useEffect(() => {
    if (wsPath) load(wsPath, () => call('dialects:usage'))
  }, [wsPath, load, version, skills, running])
  return loaded.data ?? NO_USAGE
}

/** The workspace's dialect files, read again when they change. */
function useDialectRows(wsPath: string) {
  const version = useStore((s) => s.dialectsVersion)
  const loaded = useScopedLoad<DialectRow[]>(wsPath)
  const { load } = loaded
  useEffect(() => {
    if (wsPath) load(wsPath, () => call('dialects:list'))
  }, [wsPath, load, version])
  return loaded
}

const reloadDialects = (): void => set((s) => ({ dialectsVersion: s.dialectsVersion + 1 }))

/** A folder's name as the view shows it: the CLI's, or the API's. */
const folderName = (folder: string): string => (folder === 'api' ? tr(M.apiGroup) : isKnownProvider(folder) ? providerDescriptor(folder).name : folder)

/** What a file applies to, under its name. */
function kindText(r: DialectRow): string {
  if (r.kind === 'workspace') return tr(M.kind.workspace)
  if (r.kind === 'api') return tr(M.kind.api)
  if (r.kind === 'cli') return tr(M.kind.cli, { cli: folderName(r.folder ?? '') })
  if (r.kind === 'model') return tr(M.kind.model, { model: r.model ?? '' })
  return tr(M.kind.copy)
}

/** Why a text isn't a dialect file, in words. */
const fileProblemText = (p: FileProblem): string => (p.problem === 'json' ? tr(M.fileProblem.json) : tr(M.fileProblem.shape, { field: p.field }))

/** Placeholder names as a text shows them: "{project}, {count}". */
const names = (list: readonly string[]): string => fmt.list(list.map((n) => `{${n}}`)) // i18n-ignore: placeholders as written in a text

/** Why one override doesn't match, in words: one line per thing wrong. */
export function problemLines(p: TextProblem): string[] {
  if (p.problem === 'unknown') return [tr(M.problem.unknown, { id: p.id })]
  if (p.problem === 'shape') return [tr(M.problem.shape, { id: p.id })]
  if (p.problem === 'unparsable') return [tr(M.problem.unparsable, { id: p.id, detail: p.detail })]
  return [
    ...(p.missing.length ? [tr(M.problem.missing, { id: p.id, names: names(p.missing) })] : []),
    ...(p.extra.length ? [tr(M.problem.extra, { id: p.id, names: names(p.extra) })] : []),
    ...(p.changed.length ? [tr(M.problem.changed, { id: p.id, names: names(p.changed) })] : [])
  ]
}

/** Why a change was refused, in words: one line per thing wrong. */
function refusalLines(r: DialectRefusal): string[] {
  switch (r.refused) {
    case 'path':
      return [tr(M.refused.path)]
    case 'file':
      return [tr(M.refused.file, { why: fileProblemText(r.problem) })]
    case 'texts':
      return r.problems.flatMap(problemLines)
    case 'modelHere':
      return [tr(M.refused.modelHere)]
    case 'modelClaimed':
      return [tr(M.refused.modelClaimed, { by: r.by, model: r.model })]
    case 'nameTaken':
      return [tr(M.refused.nameTaken, { path: r.path })]
    case 'missing':
      return [tr(M.refused.missing, { path: r.path })]
    case 'changedOnDisk':
      return [tr(M.refused.changedOnDisk)]
    case 'protected':
      return [tr(M.refused.protected)]
  }
}

const isRefusal = (r: unknown): r is DialectRefusal => !!r && typeof r === 'object' && 'refused' in r

/** A file name Windows takes, not hidden (as the service checks it). */
const labelProblem = (v: string): string | null => (!v.trim() || /[\\/:*?"<>|\x00-\x1f]/.test(v) || v.trim().startsWith('.') ? tr(M.nameProblem) : null)

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function DialectsPanel() {
  const wsPath = useStore((s) => s.workspace?.path ?? '')
  const selected = useStore((s) => s.selectedDialect)
  const loaded = useDialectRows(wsPath)
  const rows = loaded.data ?? NO_ROWS
  const usage = useUsage(wsPath)
  const [filter, setFilter] = useState('')
  const f = filter.trim().toLowerCase()
  const shown = rows.filter((r) => !f || `${r.name} ${r.model ?? ''} ${r.path}`.toLowerCase().includes(f))
  const groups: { key: string; title: string; rows: DialectRow[] }[] = []
  for (const r of shown) {
    const key = r.folder ?? ''
    let g = groups.find((x) => x.key === key)
    if (!g) groups.push((g = { key, title: key ? folderName(key) : tr(M.workspaceGroup), rows: [] }))
    g.rows.push(r)
  }
  return (
    <>
      <div className="pane-header">
        <Tooltip content={tr(M.tip)}>
          <span>{tr(M.title)}</span>
        </Tooltip>
        <div className="actions">
          <IconButton icon="file-add" title={tr(M.import)} onClick={() => void importDialect()} disabled={!wsPath} />
          <IconButton icon="refresh" title={tr(M.refresh)} onClick={reloadDialects} disabled={!wsPath} />
        </div>
      </div>
      <div style={{ padding: '0 8px 6px 12px' }}>
        <SearchInput style={{ height: 24 }} placeholder={tr(M.filter)} value={filter} onChange={setFilter} />
      </div>
      <div className="pane-body dialects-list">
        {!wsPath && <div className="pane-empty">{tr(M.noWorkspace)}</div>}
        {wsPath && loaded.error && !loaded.data && <LoadFailed inline what={tr(M.listTarget)} error={loaded.error} onRetry={reloadDialects} />}
        {wsPath && !loaded.error && !loaded.data && (
          <div className="pane-empty">
            <Icon name="loading" spin /> {tr(M.loading)}
          </div>
        )}
        {groups.map((g) => (
          <Section key={g.key} title={g.title} count={g.rows.length}>
            {g.rows.map((r) => (
              <DialectListRow key={r.path} row={r} selected={selected === r.path} users={usage.filter((u) => u.files.includes(r.path))} />
            ))}
          </Section>
        ))}
      </div>
    </>
  )
}

function DialectListRow({ row, selected, users }: { row: DialectRow; selected: boolean; users: DialectUsage[] }) {
  const change = (on: boolean): void => void actions.attempt(tr(M.onFailed, { name: row.name }), () => call('dialects:setOn', row.path, on))
  return (
    <div className={cx(/* i18n-ignore: class names */ 'row tall dialect-row', selected && 'selected', !row.on && 'off')} data-dialect={row.path} onClick={() => set({ selectedDialect: row.path })}>
      <Icon name={row.kind === 'workspace' ? 'globe' : row.kind === 'model' ? 'symbol-string' : row.kind === 'copy' ? 'beaker' : 'terminal'} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="label with-badges">
          <span className="row-name">{row.name}</span>
          {row.state !== 'shipped' && <span className={cx('badge', row.state === 'edited' && 'accent')}>{tr(M.state[row.state])}</span>}
          {row.updateAvailable && <span className="badge accent">{tr(M.updateBadge)}</span>}
          {row.outdated > 0 && <span className="badge warn" data-outdated={row.outdated}>{tr(M.outdatedBadge, { count: row.outdated })}</span>}
          {row.broken && <span className="badge warn">{tr(M.brokenBadge)}</span>}
        </div>
        <div className="desc" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {kindText(row)}
        </div>
      </div>
      {users.length > 0 && (
        <Tooltip content={tr(M.usedBy, { count: users.length, agents: fmt.list(users.map((u) => u.agent)) })}>
          <span className="dialect-users" data-users={users.length}>
            <Icon name="person" /> {fmt.number(users.length)}
          </span>
        </Tooltip>
      )}
      <div className="skill-delivered" onClick={(e) => e.stopPropagation()}>
        <Tooltip content={dialectOnTip(row, folderName, tr)}>
          <Switch small checked={row.on} label={tr(M.onSwitch, { name: row.name })} onChange={change} />
        </Tooltip>
      </div>
    </div>
  )
}

/** Import: the file picked in main (a token for this window), then its folder and name; a name taken asks again. */
async function importDialect(): Promise<void> {
  const picked = await call('dialects:pickImport')
  if (!picked) return
  const folders = ['claude-code', 'codex', 'copilot', 'api']
  let folder = 'claude-code'
  let label = picked.label
  for (;;) {
    const name = await prompt({
      title: tr(M.importTitle, { file: `${picked.label}.json` }),
      message: tr(M.importMessage),
      fieldLabel: tr(M.importName),
      initial: label,
      validate: labelProblem,
      confirmLabel: tr(M.create),
      select: { label: tr(M.importFolder), options: folders.map((f) => ({ value: f, label: folderName(f) })), initial: folder, set: (v) => (folder = v) }
    })
    if (name === null) return
    label = name.trim()
    const r = await call('dialects:import', picked.token, folder, label).catch((e: unknown) => {
      notify('error', tr(M.failed, { name: label }), String((e as Error)?.message ?? e))
      return null
    })
    if (!r) return
    if (isRefusal(r)) {
      if (r.refused === 'nameTaken') {
        notify('warning', refusalLines(r)[0])
        continue
      }
      notify('error', tr(M.failed, { name: label }), refusalLines(r).join('\n'))
      return
    }
    notify('info', tr(r.testCopy ? M.importedCopy : M.imported, { path: r.path }))
    set({ selectedDialect: r.path })
    reloadDialects()
    return
  }
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/**
 * A file's draft: the text on disk it started from (`base`), what it holds now (`file`), and on the JSON tab the text
 * as typed when it doesn't read as a dialect file (`json`, with why). Kept per workspace and file across reloads.
 */
interface Draft {
  base: string
  file: DialectFile | null
  json: string | null
  jsonProblem: FileProblem | null
}

const drafts = new Map<string, Draft>()
const draftKey = (ws: string, path: string): string => `${ws.toLowerCase()}|${path}`

export function DialectView() {
  const wsPath = useStore((s) => s.workspace?.path ?? '')
  const selected = useStore((s) => s.selectedDialect)
  const version = useStore((s) => s.dialectsVersion)
  const catalogue = useCatalogue()
  const usage = useUsage(wsPath)
  const scope = `${wsPath}|${selected ?? ''}`
  const loaded = useScopedLoad<DialectFileView | null>(scope)
  const { load } = loaded
  useEffect(() => {
    if (wsPath && selected) load(scope, () => call('dialects:file', selected))
  }, [scope, wsPath, selected, load, version])
  if (!wsPath || !selected) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="symbol-string" />
        {tr(M.select)}
      </div>
    )
  }
  if (loaded.error && !loaded.data) return <LoadFailed what={tr(M.fileTarget)} error={loaded.error} onRetry={reloadDialects} />
  // Not read yet (no answer, no error): loading. Read, and null: the file is gone (deleted or renamed meanwhile).
  if (loaded.data === null && !loaded.error && !loaded.at) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="loading" spin />
      </div>
    )
  }
  if (!loaded.data) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }} data-dialect-gone>
        <Icon name="warning" />
        {tr(M.gone)}
      </div>
    )
  }
  // Filling the main area, as the Skills view's page does: the texts scroll inside it.
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <DialectFilePane key={scope} ws={wsPath} view={loaded.data} catalogue={catalogue} usage={usage} />
    </div>
  )
}

function DialectFilePane({ ws, view, catalogue, usage }: { ws: string; view: DialectFileView; catalogue: DialectCatalogue | null; usage: DialectUsage[] }) {
  const path = view.row.path
  const key = draftKey(ws, path)
  const [, rerender] = useState(0)
  const draft = drafts.get(key)
  const dirty = !!draft
  const file = draft ? draft.file : view.file
  const changedOutside = !!draft && draft.base !== view.raw
  // A draft whose JSON tab holds text of its own (one that isn't a dialect file, or worded apart from the form) opens
  // on that tab, as it was left (HR2 on HI-2444 r1): the Texts tab never shows over it, nor edits it unasked.
  const [tab, setTab] = useState<'texts' | 'json'>(() => (drafts.get(key)?.json != null || !view.file ? 'json' : 'texts'))
  const [refusal, setRefusal] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const edit = useCallback(
    (next: Draft | null): void => {
      if (next) drafts.set(key, next)
      else drafts.delete(key)
      rerender((n) => n + 1)
    },
    [key]
  )
  const startDraft = (): Draft => drafts.get(key) ?? { base: view.raw, file: view.file ? structuredClone(view.file) : null, json: null, jsonProblem: null }
  const changeFile = (fn: (f: DialectFile) => void): void => {
    const d = startDraft()
    // A form edit only over a draft that reads as a file: JSON text that doesn't is kept until it is fixed or dropped.
    if (!d.file || d.jsonProblem) return
    const f = structuredClone(d.file)
    fn(f)
    edit({ ...d, file: f, json: null, jsonProblem: null })
  }

  // The JSON tab's text: typed text is read as a dialect file a moment after typing stops, and at once before Save or
  // leaving the tab (flushJson), so a Save never sends an older text than the one shown.
  const jsonShown = draft?.json ?? (file ? dialectFileText(file) : view.raw)
  const jsonTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingJson = useRef<string | null>(null)
  const flushJson = useCallback((): Draft | null => {
    if (jsonTimer.current) clearTimeout(jsonTimer.current)
    jsonTimer.current = null
    const text = pendingJson.current
    pendingJson.current = null
    const d = drafts.get(key) ?? null
    if (text === null) return d
    const parsed = parseDialectFile(text)
    const base = d ?? { base: view.raw, file: view.file, json: null, jsonProblem: null }
    const next: Draft = 'file' in parsed ? { ...base, file: parsed.file, json: text === dialectFileText(parsed.file) ? null : text, jsonProblem: null } : { ...base, json: text, jsonProblem: parsed.problem }
    edit(next)
    return next
  }, [key, view.raw, view.file, edit])
  // Leaving the pane (another file, another view) with JSON typed and not yet read: read now, into the draft kept for
  // the file, so what comes back is what was typed, its problem with it (HR2 on HI-2444 r1).
  const flushRef = useRef(flushJson)
  flushRef.current = flushJson
  useEffect(() => () => {
    if (jsonTimer.current) clearTimeout(jsonTimer.current)
    if (pendingJson.current !== null) flushRef.current()
  }, [])
  const typeJson = (text: string): void => {
    // The editor reports its own content as a change too (shown first, or put back after a reload): text that is what
    // it already shows is no edit, and starts no draft.
    const d0 = drafts.get(key)
    if (text === (pendingJson.current ?? d0?.json ?? (d0?.file ? dialectFileText(d0.file) : d0 ? jsonShown : view.file ? dialectFileText(view.file) : view.raw))) return
    pendingJson.current = text
    const d = d0 ?? { base: view.raw, file: view.file, json: null, jsonProblem: null }
    // Shown as typed at once; read as a file a moment later.
    edit({ ...d, json: text })
    if (jsonTimer.current) clearTimeout(jsonTimer.current)
    jsonTimer.current = setTimeout(() => void flushJson(), 300)
  }
  const showTab = async (t: 'texts' | 'json'): Promise<void> => {
    if (t === tab) return
    if (t === 'texts') {
      const d = flushJson()
      if (d?.jsonProblem) {
        const drop = await confirm({ title: tr(M.jsonLeaveTitle), message: tr(M.jsonLeaveMessage, { why: fileProblemText(d.jsonProblem) }), confirmLabel: tr(M.jsonLeave), danger: true })
        if (!drop) return
        edit({ ...d, json: null, jsonProblem: null })
      }
    }
    setTab(t)
  }

  const save = async (): Promise<void> => {
    const d = flushJson() ?? drafts.get(key)
    if (!d) return
    setBusy(true)
    setRefusal(null)
    try {
      const body = d.json !== null || !d.file ? { raw: d.json ?? jsonShown } : { file: d.file }
      const r = await call('dialects:save', path, body, d.base)
      if (r) {
        setRefusal(refusalLines(r))
        return
      }
      edit(null)
      notify('info', tr(M.saved, { name: view.row.name }))
      reloadDialects()
    } catch (e) {
      setRefusal([String((e as Error)?.message ?? e)])
    } finally {
      setBusy(false)
    }
  }
  const discard = (): void => {
    pendingJson.current = null
    edit(null)
    setRefusal(null)
  }
  const keepMine = (): void => {
    const d = drafts.get(key)
    if (d) edit({ ...d, base: view.raw })
    setRefusal(null)
  }

  const users = usage.filter((u) => u.files.includes(path))
  const moved = users.filter((u) => u.moved)
  const shipped = view.row.state !== 'yours'
  const deletable = !shipped && (view.row.kind === 'model' || view.row.kind === 'copy')

  return (
    <div className="dialect-detail" data-dialect-file={path}>
      <div className="dialect-head">
        <div className="dialect-title">
          <Icon name={view.row.kind === 'copy' ? 'beaker' : 'symbol-string'} />
          <div style={{ minWidth: 0 }}>
            <div className="dialect-name">
              {view.row.name} <span className="faint">{path}</span>
            </div>
            <div className="desc">{kindText(view.row)}</div>
          </div>
          <span className={cx('badge', view.row.state === 'edited' && 'accent')}>{tr(M.state[view.row.state])}</span>
          {view.row.outdated > 0 && <span className="badge warn">{tr(M.outdatedBadge, { count: view.row.outdated })}</span>}
          <Tooltip content={dialectOnTip(view.row, folderName, tr)}>
            <Switch small checked={view.row.on} label={tr(M.onSwitch, { name: view.row.name })} onChange={(on) => void actions.attempt(tr(M.onFailed, { name: view.row.name }), () => call('dialects:setOn', path, on))} />
          </Tooltip>
        </div>
        <div className="dialect-actions">
          <button className="btn small primary" data-dialect-save disabled={!dirty || busy} onClick={() => void save()}>
            <Icon name={busy ? 'loading' : 'save'} spin={busy} /> {tr(busy ? M.saving : M.save)}
          </button>
          {dirty && (
            <button className="btn small subtle" data-dialect-discard onClick={discard}>
              {tr(M.discard)}
            </button>
          )}
          {(view.row.kind === 'model' || view.row.kind === 'copy') && (
            <button className="btn small subtle" data-dialect-duplicate onClick={() => void duplicate(view)}>
              <Icon name="copy" /> {tr(M.duplicate)}
            </button>
          )}
          {view.row.kind === 'copy' && (
            <button className="btn small subtle" data-dialect-promote onClick={() => void promote(view)}>
              <Icon name="pass" /> {tr(M.promote)}
            </button>
          )}
          <button className="btn small subtle" data-dialect-export onClick={() => void exportFile(view)}>
            <Icon name="export" /> {tr(M.export)}
          </button>
          {view.row.state === 'edited' && (
            <button className="btn small subtle" data-dialect-revert onClick={() => void revert(view, () => edit(null))}>
              <Icon name="discard" /> {tr(M.revert)}
            </button>
          )}
          {deletable && <IconButton icon="trash" title={tr(M.deleteFile)} onClick={() => void remove(view, () => edit(null))} />}
        </div>
        {view.row.claimTaken && <div className="banner warn">{tr(M.claimTaken, { by: view.row.claimTaken, model: view.row.model ?? '' })}</div>}
        {moved.length > 0 && (
          <div className="banner info" data-dialect-restart>
            <Icon name="refresh" /> {tr(M.restart, { count: moved.length, agents: fmt.list(moved.map((u) => u.agent)) })}
          </div>
        )}
        {changedOutside && (
          <div className="banner warn" data-dialect-outside>
            <Icon name="warning" /> {tr(M.changedOutside)}
            <button className="btn small subtle" onClick={discard}>
              {tr(M.reload)}
            </button>
            <button className="btn small subtle" onClick={keepMine}>
              {tr(M.keepMine)}
            </button>
          </div>
        )}
        {refusal && (
          <div className="banner danger dialect-refused" data-dialect-refused role="alert">
            <strong>{tr(M.refused.title)}</strong>
            <ul>
              {refusal.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="segmented dialect-tabs" role="tablist" aria-label={tr(M.tabs, { name: view.row.name })}>
          <button role="tab" aria-selected={tab === 'texts'} className={cx(tab === 'texts' && 'active')} data-dialect-tab="texts" onClick={() => void showTab('texts')}>
            {tr(M.tabTexts)}
          </button>
          <button role="tab" aria-selected={tab === 'json'} className={cx(tab === 'json' && 'active')} data-dialect-tab="json" onClick={() => void showTab('json')}>
            {tr(M.tabJson)}
          </button>
        </div>
      </div>
      {tab === 'json' ? (
        <div className="dialect-json">
          {draft?.jsonProblem && (
            <div className="banner warn" data-dialect-json-bad>
              {tr(M.jsonBad, { why: fileProblemText(draft.jsonProblem) })}
            </div>
          )}
          <CodeEditor value={jsonShown} language="json" onChange={typeJson} onSave={() => void save()} />
        </div>
      ) : (
        <DialectTexts view={view} file={file} catalogue={catalogue} changeFile={changeFile} />
      )}
    </div>
  )
}

/** A text's source as the view names it: this file, a layer beneath it, or the Default. */
function sourceText(s: TextSource, below: readonly DialectLayer[], folder: string | null): string {
  if (s.from === 'file') return tr(M.from.file)
  if (s.from === 'default') return tr(M.from.default)
  const l = below[s.index]
  if (l.layer === 'workspace') return tr(M.from.workspace)
  if (l.layer === 'api') return tr(M.from.api)
  if (l.layer === 'cli') return folder === 'api' ? tr(M.from.api) : tr(M.from.cli, { cli: folderName(folder ?? '') })
  return tr(M.from.model, { name: l.name ?? l.path ?? '' })
}

type Show = 'all' | 'here' | 'anywhere'

function DialectTexts({ view, file, catalogue, changeFile }: { view: DialectFileView; file: DialectFile | null; catalogue: DialectCatalogue | null; changeFile: (fn: (f: DialectFile) => void) => void }) {
  const [search, setSearch] = useState('')
  const [show, setShow] = useState<Show>('all')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [more, setMore] = useState<Record<string, number>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const byId = useMemo(() => new Map((catalogue?.texts ?? []).map((t) => [t.id, t])), [catalogue])
  if (!catalogue) {
    return (
      <div className="pane-empty">
        <Icon name="loading" spin /> {tr(M.loading)}
      </div>
    )
  }
  const q = search.trim().toLowerCase()
  const outdatedIds = new Set(view.outdated.map((p) => p.id))
  const matches = (t: DialectCatalogueText): boolean => {
    if (show === 'here' && !changedHere(t.id, file)) return false
    if (show === 'anywhere' && !changedAnywhere(t.id, file, view.below)) return false
    if (!q) return true
    const shown = shownText(t.id, file, view.below, t.text).text ?? ''
    return t.id.toLowerCase().includes(q) || shown.toLowerCase().includes(q) || t.text.toLowerCase().includes(q)
  }
  const overrides = file ? Object.keys(file.texts).length : 0
  // Outdated overrides first, whatever the filter: those of an id this Hive no longer has show only here.
  const outdated = view.outdated.filter((p) => !q || p.id.toLowerCase().includes(q))
  const areas = catalogue.areas.map((area) => ({ area, texts: catalogue.texts.filter((t) => t.area === area && !outdatedIds.has(t.id) && matches(t)) })).filter((a) => a.texts.length)
  const searching = !!q || show !== 'all'
  const toggle = (area: string): void => setOpen((s) => {
    const n = new Set(s)
    if (n.has(area)) n.delete(area)
    else n.add(area)
    return n
  })
  const row = (id: string, entry: DialectCatalogueText | undefined, problem?: TextProblem): React.ReactNode => (
    <DialectTextRow key={id} id={id} entry={entry} problem={problem} view={view} file={file} expanded={expanded === id} onToggle={() => setExpanded((x) => (x === id ? null : id))} changeFile={changeFile} />
  )
  return (
    <div className="dialect-texts">
      <div className="dialect-filters">
        <SearchInput style={{ height: 24, flex: 1 }} placeholder={tr(M.search)} value={search} onChange={setSearch} />
        <label className="faint">{tr(M.show)}</label>
        <select className="input" value={show} data-dialect-show onChange={(e) => setShow(e.target.value as Show)}>
          <option value="all">{tr(M.showAll)}</option>
          <option value="here">{tr(M.showHere)}</option>
          <option value="anywhere">{tr(M.showAnywhere)}</option>
        </select>
        <span className="faint">{tr(M.counts, { overrides, total: catalogue.texts.length })}</span>
      </div>
      <div className="dialect-text-list">
        {outdated.length > 0 && (
          <div className="dialect-area open outdated" data-area="outdated">
            <div className="dialect-area-head">
              <Icon name="warning" /> {tr(M.outdatedGroup)} <span className="faint">{fmt.number(outdated.length)}</span>
            </div>
            {outdated.map((p) => row(p.id, byId.get(p.id), p))}
          </div>
        )}
        {areas.length === 0 && outdated.length === 0 && <div className="pane-empty">{tr(M.noMatch)}</div>}
        {areas.map(({ area, texts }) => {
          const isOpen = searching || open.has(area)
          const limit = more[area] ?? ROWS_PER_PAGE
          return (
            <div key={area} className={cx('dialect-area', isOpen && 'open')} data-area={area}>
              <button className="dialect-area-head" aria-expanded={isOpen} onClick={() => toggle(area)}>
                <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} /> {area} <span className="faint">{fmt.number(texts.length)}</span>
              </button>
              {isOpen && texts.slice(0, limit).map((t) => row(t.id, t))}
              {isOpen && texts.length > limit && (
                <button className="btn small subtle dialect-more" onClick={() => setMore((m) => ({ ...m, [area]: limit + ROWS_PER_PAGE }))}>
                  {tr(M.showMore, { count: Math.min(ROWS_PER_PAGE, texts.length - limit) })}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DialectTextRow({ id, entry, problem, view, file, expanded, onToggle, changeFile }: { id: string; entry: DialectCatalogueText | undefined; problem?: TextProblem; view: DialectFileView; file: DialectFile | null; expanded: boolean; onToggle: () => void; changeFile: (fn: (f: DialectFile) => void) => void }) {
  const shown = shownText(id, file, view.below, entry?.text)
  const own = file && Object.hasOwn(file.texts, id) ? file.texts[id] : undefined
  const ownText = own && typeof own.text === 'string' ? own.text : undefined
  const inherited = shown.source.from !== 'file'
  const layers = layerValues(id, file, view.below, entry?.text)
  const placeholders = Object.keys(entry?.placeholders ?? {})
  return (
    <div className={cx('dialect-text', inherited && !problem && 'inherited', problem && 'outdated', expanded && 'expanded')} data-text-id={id} data-source={shown.source.from}>
      <button className="dialect-text-head" aria-expanded={expanded} onClick={onToggle}>
        <code className="dialect-id">{id}</code>
        <span className="dialect-value">{problem ? (ownText ?? '') : (shown.text ?? '')}</span>
        <span className="dialect-source faint">{problem ? tr(M.outdatedGroup) : sourceText(shown.source, view.below, view.row.folder)}</span>
      </button>
      {problem && (
        <div className="dialect-problem" data-problem={problem.problem}>
          {problemLines(problem).map((l, i) => (
            <div key={i}>{l}</div>
          ))}
          <div className="faint">{entry ? tr(M.defaultNow, { text: entry.text }) : tr(M.noDefault)}</div>
        </div>
      )}
      {expanded && (
        <div className="dialect-text-body">
          {entry?.note && (
            <div className="dialect-note">
              <span className="faint">{tr(M.note)}:</span> {entry.note}
            </div>
          )}
          {entry && <div className="faint">{placeholders.length ? tr(M.placeholders, { names: names(placeholders) }) : tr(M.noPlaceholders)}</div>}
          <div className="dialect-layers" data-layers>
            {layers.map((l, i) => {
              const label = sourceText(l.source, view.below, view.row.folder)
              return (
                <div key={i} className={cx('dialect-layer', !l.on && 'off')} data-layer={l.source.from === 'layer' ? view.below[l.source.index].layer : l.source.from}>
                  <span className="faint">{l.on ? label : tr(M.layerOff, { layer: label })}</span>
                  <span className={cx(l.text === undefined && 'faint')}>{l.text ?? tr(M.none)}</span>
                </div>
              )
            })}
          </div>
          {file && own !== undefined && (
            <div className="dialect-edit">
              <label className="faint">{tr(M.text)}</label>
              <textarea className="input" data-dialect-edit-text value={ownText ?? ''} rows={Math.min(8, Math.max(2, Math.ceil((ownText ?? '').length / 90)))} onChange={(e) => changeFile((f) => void (f.texts[id] = { ...(typeof f.texts[id] === 'object' && f.texts[id] ? f.texts[id] : {}), text: e.target.value }))} />
              <label className="faint">{tr(M.why)}</label>
              <input className="input" data-dialect-edit-why placeholder={tr(M.whyPlaceholder)} value={own && typeof own.why === 'string' ? own.why : ''} onChange={(e) => changeFile((f) => void (f.texts[id] = { ...f.texts[id], text: typeof f.texts[id]?.text === 'string' ? f.texts[id].text : '', why: e.target.value || undefined }))} />
              <div>
                <button className="btn small subtle" data-dialect-remove onClick={() => changeFile((f) => void delete f.texts[id])}>
                  <Icon name="discard" /> {tr(M.removeOverride)}
                </button>
              </div>
            </div>
          )}
          {file && own === undefined && entry && (
            <button className="btn small subtle" data-dialect-override onClick={() => changeFile((f) => void (f.texts[id] = { text: shown.text ?? entry.text }))}>
              <Icon name="edit" /> {tr(M.override)}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The file's actions
// ---------------------------------------------------------------------------

async function duplicate(view: DialectFileView): Promise<void> {
  const label = await prompt({ title: tr(M.duplicateTitle, { name: view.row.name }), message: tr(M.duplicateMessage), fieldLabel: tr(M.importName), initial: tr(M.copyLabel, { name: view.row.name }), validate: labelProblem, confirmLabel: tr(M.create) })
  if (label === null) return
  const r = await call('dialects:duplicate', view.row.path, label.trim()).catch((e: unknown) => notify('error', tr(M.failed, { name: view.row.name }), String((e as Error)?.message ?? e)))
  if (!r) return
  if (isRefusal(r)) return notify('error', tr(M.failed, { name: view.row.name }), refusalLines(r).join('\n'))
  set({ selectedDialect: r.path })
  reloadDialects()
}

async function promote(view: DialectFileView): Promise<void> {
  const claimed = view.claims.map((c) => c.model)
  const model = await prompt({
    title: tr(M.promoteTitle, { name: view.row.name }),
    message: tr(M.promoteMessage),
    fieldLabel: tr(M.promoteField),
    initial: claimed[0] ?? '',
    list: view.claims.map((c) => `${c.model} · ${c.path}`), // i18n-ignore: a model ID and a file's path
    listOnly: true,
    validate: (v) => (v.trim() ? null : tr(M.promoteField)),
    confirmLabel: tr(M.promoteButton)
  })
  if (model === null) return
  const r = await call('dialects:promote', view.row.path, model.trim()).catch((e: unknown) => notify('error', tr(M.failed, { name: view.row.name }), String((e as Error)?.message ?? e)))
  if (!r) return
  if (isRefusal(r)) return notify('error', tr(M.failed, { name: view.row.name }), refusalLines(r).join('\n'))
  reloadDialects()
}

async function exportFile(view: DialectFileView): Promise<void> {
  const to = await call('dialects:export', view.row.path).catch((e: unknown) => notify('error', tr(M.failed, { name: view.row.name }), String((e as Error)?.message ?? e)))
  if (to) notify('info', tr(M.exported, { path: to }))
}

async function revert(view: DialectFileView, dropDraft: () => void): Promise<void> {
  const ok = await confirm({ title: tr(M.revertTitle, { name: view.row.name }), message: tr(M.revertMessage), confirmLabel: tr(M.revert), danger: true })
  if (!ok) return
  await actions.attempt(tr(M.failed, { name: view.row.name }), () => call('dialects:revert', view.row.path))
  dropDraft()
  reloadDialects()
}

async function remove(view: DialectFileView, dropDraft: () => void): Promise<void> {
  const ok = await confirm({ title: tr(M.deleteTitle, { name: view.row.name }), message: tr(M.deleteMessage), confirmLabel: tr(M.deleteFile), danger: true })
  if (!ok) return
  const r = await call('dialects:delete', view.row.path).catch((e: unknown) => notify('error', tr(M.failed, { name: view.row.name }), String((e as Error)?.message ?? e)))
  if (isRefusal(r)) return notify('error', tr(M.failed, { name: view.row.name }), refusalLines(r).join('\n'))
  dropDraft()
  set({ selectedDialect: null })
  reloadDialects()
}
