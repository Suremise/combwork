import { useEffect, useRef, useState } from 'react'
import type { CommandPoint, CommandRef, CommandsHive, CommandsWorkspace, CustomCommand } from '@shared/types'
import { EMPTY_HIVE, EMPTY_WORKSPACE, fillCommand, MAX_COMMAND, MAX_FOLDER, MAX_NAME, newCommandId, type CommandValues } from '@shared/commands'
import { msg, tr } from '@shared/i18n'
import * as actions from '../actions'
import { call } from '../api'
import { useLanguage, useStore } from '../store'
import { basename } from '../util'
import { IconButton, Modal } from './ui'

/**
 * Settings → Commands, at Hive's level (General) and the workspace's (Workspace), and the points that run them: When
 * this workspace opens, run; When this workspace closes, run; When Hive quits, run (HI-1954, design HI-1954/s15). Only
 * the user saves them, from here; main cleans what it saves and runs them (closeCommand/), showing CloseCommandPanel.
 */

const M = {
  empty: msg({ id: 'settings.commands.empty', defaultMessage: 'No commands yet.', description: 'Settings → Commands (HI-1954), when the list is empty.' }),
  add: msg({ id: 'settings.commands.add', defaultMessage: 'Add Command…', description: 'A button under Settings → Commands (HI-1954): opens the dialog to name a new command.' }),
  run: msg({ id: 'settings.commands.run', defaultMessage: 'Run it now', description: "A button beside one of the user's commands in Settings → Commands (HI-1954): runs it now, by hand, in Hive's commands dialog." }),
  edit: msg({ id: 'settings.commands.edit', defaultMessage: 'Edit…', description: "A button beside one of the user's commands in Settings → Commands (HI-1954)." }),
  up: msg({ id: 'settings.commands.up', defaultMessage: 'Move up', description: 'A button beside a command in a list (Settings → Commands, or a point such as When this workspace opens, run; HI-1954).' }),
  down: msg({ id: 'settings.commands.down', defaultMessage: 'Move down', description: 'A button beside a command in a list (Settings → Commands, or a point such as When this workspace opens, run; HI-1954).' }),
  remove: msg({ id: 'settings.commands.delete', defaultMessage: 'Delete', description: "A button beside one of the user's commands in Settings → Commands (HI-1954): deletes it, and takes it off this level's points." }),
  needed: msg({ id: 'settings.commands.needed', defaultMessage: 'The commands after this need it', description: "A checkbox of one of the user's commands (HI-1954): when it fails, Hive's dialog leads with Stop here, and when nobody is waiting, the commands after it don't run." }),
  neededBadge: msg({ id: 'settings.commands.neededBadge', defaultMessage: 'needed by the next', description: "A short tag beside a command in Settings → Commands (HI-1954) whose \"The commands after this need it\" is ticked." }),
  titleNew: msg({ id: 'settings.commands.titleNew', defaultMessage: 'Add a Command', description: 'The title of the dialog that names a new command (Settings → Commands, HI-1954).' }),
  titleEdit: msg({ id: 'settings.commands.titleEdit', defaultMessage: 'Edit a Command', description: "The title of the dialog that edits one of the user's commands (Settings → Commands, HI-1954)." }),
  name: msg({ id: 'settings.commands.name', defaultMessage: 'Name', description: "A field of the command dialog (HI-1954): the command's name, as lists and Hive's dialog show it." }),
  command: msg({ id: 'settings.closeCommand.command', defaultMessage: 'Command', description: 'The label of the text box of "When this workspace closes, run" and "When Hive quits, run" (Settings): the command Hive runs.' }),
  folder: msg({ id: 'settings.commands.folder', defaultMessage: 'Folder (empty: the workspace folder)', description: "A field of the command dialog (HI-1954): the folder the command runs in; empty, the workspace's folder (the user's home folder for Hive's quit point)." }),
  placeholders: msg({
    id: 'settings.commands.placeholders',
    defaultMessage: "cmd.exe runs it. '{workspace}' becomes the workspace's folder, '{name}' its name, '{reason}' why it runs (open, window, switch, quit, update or manual), and '{project:api}' the folder of the project api. Quote them where a path may hold spaces.",
    description: "A hint in the command dialog (HI-1954). '{workspace}', '{name}', '{reason}' and '{project:api}' are placeholders the user writes in the command (api is an example project name), and open, window, switch, quit, update and manual are the values {reason} becomes: keep all of them as they are (the quotes around them keep them from being read as placeholders here)."
  }),
  runs: msg({ id: 'settings.closeCommand.runs', defaultMessage: 'Runs: {command}', description: 'Under the close command in Settings: the command exactly as Hive would run it, its placeholders filled in. {command} is that command: keep it as it is.' }),
  hint: msg({
    id: 'settings.closeCommand.hint',
    defaultMessage: 'Hive waits for it, showing it running. A command that shouldn\'t hold Hive up can start its job and return, e.g. start "" "backup.cmd".',
    description: 'A hint under the close command in Settings. start "" "backup.cmd" is a Windows command (cmd.exe starts the file and returns at once): keep it as it is.'
  }),
  save: msg({ id: 'settings.commands.save', defaultMessage: 'Save', description: 'The command dialog\'s button (HI-1954).' }),
  cancel: msg({ id: 'settings.commands.cancel', defaultMessage: 'Cancel', description: 'The command dialog\'s button (HI-1954).' }),
  noWorkspace: msg({ id: 'settings.commands.noWorkspace', defaultMessage: "Open a workspace to set its commands.", description: "Settings → Workspace's commands and its open and close points (HI-1954), with no workspace open." }),
  saveFailed: msg({ id: 'settings.closeCommand.saveFailed', defaultMessage: "Couldn't save the command", description: "An error's title: saving the command Hive runs as the workspace closes or as Hive quits (Settings) failed (why follows)." }),
  runFailed: msg({ id: 'settings.commands.runFailed', defaultMessage: "Couldn't run the command", description: "An error's title: running one of the user's commands by hand failed to start (why follows; HI-1954)." }),
  pointEmpty: msg({ id: 'settings.commands.pointEmpty', defaultMessage: 'Nothing runs.', description: 'A point such as "When this workspace opens, run" (HI-1954) with no command picked.' }),
  pointAdd: msg({ id: 'settings.commands.pointAdd', defaultMessage: 'Add a command to run here…', description: 'A drop-down under a point such as "When this workspace opens, run" (HI-1954): picks one of the commands to run there, after those already picked.' }),
  pointRemove: msg({ id: 'settings.commands.pointRemove', defaultMessage: "Don't run it here", description: 'A button beside a command a point runs (HI-1954): takes it off that point; the command itself stays.' }),
  hiveBadge: msg({ id: 'settings.commands.hiveBadge', defaultMessage: 'Hive', description: "A short tag beside a command in a workspace's point (HI-1954): one of Hive's own commands (Settings → General → Commands), not the workspace's." }),
  gone: msg({ id: 'settings.commands.gone', defaultMessage: '(deleted)', description: 'A command a point still names but which was deleted (HI-1954): it is skipped.' }),
  cantFill: msg({ id: 'settings.commands.cantFill', defaultMessage: "{placeholders} can't be filled here: it won't run", description: "A warning beside a command a point runs (HI-1954): placeholders in it have no value at that point (for example {workspace} as Hive quits), so Hive won't run it there. {placeholders} lists them as written." }),
  onUpdate: msg({ id: 'settings.closeCommand.onUpdate', defaultMessage: 'Also when Hive restarts to install an update', description: 'A checkbox under the close command (Settings → Workspace → When this workspace closes, run, and Settings → General → When Hive quits, run): run it too when Hive restarts to install an update (by default it is skipped then).' })
}

/**
 * A value edited here and saved whole, in order: the one shown is the saved one only once no save of this control's is
 * pending, so a reply or event for an older save never undoes a newer edit (as HI-1368's command, HR6's round 1).
 */
function useSaved<T>(value: T, onSave: (next: T) => Promise<unknown>): [T, (next: T) => void] {
  const [shown, setShown] = useState(value)
  const pending = useRef(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => {
    if (!pending.current) setShown(value)
  }, [value])
  const save = (next: T): void => {
    setShown(next)
    pending.current++
    queue.current = queue.current
      .then(() => onSave(next))
      .catch(() => undefined)
      .finally(() => {
        pending.current--
      })
  }
  return [shown, save]
}

const move = <T,>(list: T[], i: number, by: number): T[] => {
  const j = i + by
  if (j < 0 || j >= list.length) return list
  const next = [...list]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

/** What placeholders stand for in this window now (the Settings preview and the points' warnings). */
function useValues(reason: CommandValues['reason']): CommandValues {
  const ws = useStore((s) => s.workspace)
  const projects: Record<string, string> = {}
  for (const p of ws?.projects ?? []) projects[p.name.toLowerCase()] = p.path
  return ws ? { workspace: ws.path, name: basename(ws.path), reason, projects } : { reason }
}

/** The dialog that names a new command or edits one. */
function CommandDialog({ initial, values, onSave, onClose }: { initial: CustomCommand | null; values: CommandValues; onSave: (c: CustomCommand) => void; onClose: () => void }) {
  useLanguage()
  const [name, setName] = useState(initial?.name ?? '')
  const [command, setCommand] = useState(initial?.command ?? '')
  const [folder, setFolder] = useState(initial?.folder ?? '')
  const [needed, setNeeded] = useState(!!initial?.needed)
  const ok = !!name.trim() && !!command.trim()
  const save = (): void => {
    if (!ok) return
    onSave({ id: initial?.id ?? newCommandId(), name: name.trim(), command: command.trim(), ...(folder.trim() ? { folder: folder.trim() } : {}), ...(needed ? { needed: true } : {}) })
    onClose()
  }
  const preview = command.trim() ? fillCommand(command.trim(), values).text : ''
  return (
    <Modal
      title={tr(initial ? M.titleEdit : M.titleNew)}
      icon="terminal"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>
            {tr(M.cancel)}
          </button>
          <button className="btn primary" disabled={!ok} onClick={save}>
            {tr(M.save)}
          </button>
        </>
      }
    >
      <div className="close-command-settings">
        <label>{tr(M.name)}</label>
        <input className="input" autoFocus maxLength={MAX_NAME} aria-label={tr(M.name)} value={name} onChange={(e) => setName(e.target.value)} />
        <label>{tr(M.command)}</label>
        <input className="input close-command-input" spellCheck={false} maxLength={MAX_COMMAND} aria-label={tr(M.command)} value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        {preview && <div className="close-command-preview">{tr(M.runs, { command: preview })}</div>}
        <label>{tr(M.folder)}</label>
        <input className="input close-command-input" spellCheck={false} maxLength={MAX_FOLDER} aria-label={tr(M.folder)} value={folder} onChange={(e) => setFolder(e.target.value)} />
        <label className="flex">
          <input type="checkbox" className="checkbox" checked={needed} onChange={(e) => setNeeded(e.target.checked)} /> {tr(M.needed)}
        </label>
        <div className="s-desc muted">{tr(M.placeholders)}</div>
        <div className="s-desc muted">{tr(M.hint)}</div>
      </div>
    </Modal>
  )
}

/** A level's list of commands: each with Run, Edit, Move and Delete, and Add Command…. */
function CommandList({ list, values, onChange, run }: { list: CustomCommand[]; values: CommandValues; onChange: (next: CustomCommand[]) => void; run: (id: string) => void }) {
  useLanguage()
  const [editing, setEditing] = useState<CustomCommand | 'new' | null>(null)
  return (
    <div className="close-command-settings commands-list">
      {!list.length && <div className="muted">{tr(M.empty)}</div>}
      {list.map((c, i) => (
        <div key={c.id} className="flex commands-row" data-command={c.id}>
          <div className="grow commands-row-text">
            <div>
              {c.name} {c.needed && <span className="badge subtle">{tr(M.neededBadge)}</span>}
            </div>
            <div className="close-command-preview">{c.command}</div>
          </div>
          <IconButton icon="play" title={tr(M.run)} onClick={() => run(c.id)} />
          <IconButton icon="edit" title={tr(M.edit)} onClick={() => setEditing(c)} />
          <IconButton icon="arrow-up" title={tr(M.up)} disabled={i === 0} onClick={() => onChange(move(list, i, -1))} />
          <IconButton icon="arrow-down" title={tr(M.down)} disabled={i === list.length - 1} onClick={() => onChange(move(list, i, 1))} />
          <IconButton icon="trash" title={tr(M.remove)} onClick={() => onChange(list.filter((x) => x.id !== c.id))} />
        </div>
      ))}
      <div>
        <button className="btn small" onClick={() => setEditing('new')}>
          {tr(M.add)}
        </button>
      </div>
      {editing && <CommandDialog initial={editing === 'new' ? null : editing} values={values} onClose={() => setEditing(null)} onSave={(c) => onChange(editing === 'new' ? [...list, c] : list.map((x) => (x.id === c.id ? c : x)))} />}
    </div>
  )
}

/** A point's commands in order, picked from the lists it may use, with what can't run there said. */
function PointPicker({ point, lists, values, update, onChange }: { point: CommandPoint; lists: { hive: CustomCommand[]; workspace?: CustomCommand[] }; values: CommandValues; update: boolean; onChange: (next: CommandPoint) => void }) {
  useLanguage()
  const find = (r: CommandRef): CustomCommand | undefined => (r.scope === 'hive' ? lists.hive : (lists.workspace ?? [])).find((c) => c.id === r.id)
  const picked = (r: CommandRef): boolean => point.run.some((x) => x.scope === r.scope && x.id === r.id)
  const choices: CommandRef[] = [...(lists.workspace ?? []).map((c) => ({ scope: 'workspace' as const, id: c.id })), ...lists.hive.map((c) => ({ scope: 'hive' as const, id: c.id }))].filter((r) => !picked(r))
  const label = (r: CommandRef): string => `${find(r)?.name ?? tr(M.gone)}${r.scope === 'hive' && lists.workspace ? ` (${tr(M.hiveBadge)})` : ''}`
  return (
    <div className="close-command-settings">
      {!point.run.length && <div className="muted">{tr(M.pointEmpty)}</div>}
      {point.run.map((r, i) => {
        const c = find(r)
        const missing = c ? [...new Set([...fillCommand(c.command, values).missing, ...fillCommand(c.folder ?? '', values).missing])] : []
        return (
          <div key={`${r.scope}:${r.id}`} className="flex commands-row">
            <div className="grow">
              <div className={c ? undefined : 'muted'}>{label(r)}</div>
              {missing.length > 0 && <div className="close-command-warn">{tr(M.cantFill, { placeholders: missing.join(' ') })}</div>}
            </div>
            <IconButton icon="arrow-up" title={tr(M.up)} disabled={i === 0} onClick={() => onChange({ ...point, run: move(point.run, i, -1) })} />
            <IconButton icon="arrow-down" title={tr(M.down)} disabled={i === point.run.length - 1} onClick={() => onChange({ ...point, run: move(point.run, i, 1) })} />
            <IconButton icon="close" title={tr(M.pointRemove)} onClick={() => onChange({ ...point, run: point.run.filter((_, j) => j !== i) })} />
          </div>
        )
      })}
      {choices.length > 0 && (
        <select
          className="select"
          aria-label={tr(M.pointAdd)}
          value=""
          onChange={(e) => {
            const r = choices.find((x) => `${x.scope}:${x.id}` === e.target.value)
            if (r) onChange({ ...point, run: [...point.run, r] })
          }}
        >
          <option value="">{tr(M.pointAdd)}</option>
          {choices.map((r) => (
            <option key={`${r.scope}:${r.id}`} value={`${r.scope}:${r.id}`}>
              {label(r)}
            </option>
          ))}
        </select>
      )}
      {update && (
        <label className="flex">
          <input type="checkbox" className="checkbox close-command-update" checked={!!point.onUpdate} onChange={(e) => onChange({ ...point, ...(e.target.checked ? { onUpdate: true } : { onUpdate: undefined }) })} /> {tr(M.onUpdate)}
        </label>
      )}
    </div>
  )
}

const runIt = (ref: CommandRef): void => void actions.attempt(tr(M.runFailed), () => call('commands:run', ref))

/** Hive's commands, as saved (settings.commands), and its save. */
function useHive(): [CommandsHive, (next: CommandsHive) => void] {
  const value = useStore((s) => s.settings?.commands ?? EMPTY_HIVE)
  // Every window gets settings-changed with what was saved.
  return useSaved(value, (next) => actions.attempt(tr(M.saveFailed), () => call('commands:setHive', next)))
}

/** The workspace's commands, as saved (workspace.json), and its save. */
function useWorkspace(): [CommandsWorkspace, (next: CommandsWorkspace) => void] {
  const value = useStore((s) => s.workspace?.config.commands ?? EMPTY_WORKSPACE)
  // The window gets workspace-changed with the saved config.
  return useSaved(value, (next) => actions.attempt(tr(M.saveFailed), () => call('commands:setWorkspace', next)))
}

/** Settings → General → Commands: Hive's own commands. Deleting one takes it off When Hive quits too. */
export function HiveCommands() {
  const [hive, save] = useHive()
  const values = useValues('manual')
  return (
    <CommandList
      list={hive.list}
      values={values}
      run={(id) => runIt({ scope: 'hive', id })}
      onChange={(list) => save({ list, onQuit: { ...hive.onQuit, run: hive.onQuit.run.filter((r) => list.some((c) => c.id === r.id)) } })}
    />
  )
}

/** Settings → General → When Hive quits, run: Hive's commands, in order. */
export function QuitPoint() {
  const [hive, save] = useHive()
  return <PointPicker point={hive.onQuit} lists={{ hive: hive.list }} values={{ reason: 'quit' }} update onChange={(onQuit) => save({ ...hive, onQuit })} /> // i18n-ignore: {reason}'s value, as main fills it in
}

/** Settings → Workspace → Commands: the workspace's own. Deleting one takes it off its open and close points. */
export function WorkspaceCommands() {
  const path = useStore((s) => s.workspace?.path ?? null)
  const [ws, save] = useWorkspace()
  const values = useValues('manual')
  if (!path) return <div className="muted">{tr(M.noWorkspace)}</div>
  const keep = (list: CustomCommand[]) => (p: CommandPoint): CommandPoint => ({ ...p, run: p.run.filter((r) => r.scope === 'hive' || list.some((c) => c.id === r.id)) })
  return <CommandList list={ws.list} values={values} run={(id) => runIt({ scope: 'workspace', id })} onChange={(list) => save({ list, onOpen: keep(list)(ws.onOpen), onClose: keep(list)(ws.onClose) })} />
}

/** Settings → Workspace → When this workspace opens, run, and When this workspace closes, run. */
export function WorkspacePoint({ which }: { which: 'onOpen' | 'onClose' }) {
  const path = useStore((s) => s.workspace?.path ?? null)
  const hive = useStore((s) => s.settings?.commands ?? EMPTY_HIVE)
  const [ws, save] = useWorkspace()
  const values = useValues(which === 'onOpen' ? 'open' : 'window') // i18n-ignore: {reason}'s values, as main fills them in
  if (!path) return <div className="muted">{tr(M.noWorkspace)}</div>
  return <PointPicker point={ws[which]} lists={{ hive: hive.list, workspace: ws.list }} values={values} update={which === 'onClose'} onChange={(p) => save({ ...ws, [which]: p })} />
}
