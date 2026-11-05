import { useEffect, useReducer, useState } from 'react'
import type { CommandPoint, CommandRef, CommandsCombwork, CommandsWorkspace, CustomCommand } from '@shared/types'
import { EMPTY_CW, EMPTY_WORKSPACE, fillCommand, MAX_COMMAND, MAX_FOLDER, MAX_NAME, newCommandId, type CommandValues } from '@shared/commands'
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
  run: msg({ id: 'settings.commands.run', defaultMessage: 'Run it now', description: "A button beside one of the user's commands in Settings → Commands (HI-1954): runs it now, by hand, in Combwork's commands dialog." }),
  edit: msg({ id: 'settings.commands.edit', defaultMessage: 'Edit…', description: "A button beside one of the user's commands in Settings → Commands (HI-1954)." }),
  up: msg({ id: 'settings.commands.up', defaultMessage: 'Move up', description: 'A button beside a command in a list (Settings → Commands, or a point such as When this workspace opens, run; HI-1954).' }),
  down: msg({ id: 'settings.commands.down', defaultMessage: 'Move down', description: 'A button beside a command in a list (Settings → Commands, or a point such as When this workspace opens, run; HI-1954).' }),
  remove: msg({ id: 'settings.commands.delete', defaultMessage: 'Delete', description: "A button beside one of the user's commands in Settings → Commands (HI-1954): deletes it, and takes it off this level's points." }),
  needed: msg({ id: 'settings.commands.needed', defaultMessage: 'The commands after this need it', description: "A checkbox of one of the user's commands (HI-1954): when it fails, Combwork's dialog leads with Stop here, and when nobody is waiting, the commands after it don't run." }),
  neededBadge: msg({ id: 'settings.commands.neededBadge', defaultMessage: 'needed by the next', description: "A short tag beside a command in Settings → Commands (HI-1954) whose \"The commands after this need it\" is ticked." }),
  titleNew: msg({ id: 'settings.commands.titleNew', defaultMessage: 'Add a Command', description: 'The title of the dialog that names a new command (Settings → Commands, HI-1954).' }),
  titleEdit: msg({ id: 'settings.commands.titleEdit', defaultMessage: 'Edit a Command', description: "The title of the dialog that edits one of the user's commands (Settings → Commands, HI-1954)." }),
  name: msg({ id: 'settings.commands.name', defaultMessage: 'Name', description: "A field of the command dialog (HI-1954): the command's name, as lists and Combwork's dialog show it." }),
  command: msg({ id: 'settings.closeCommand.command', defaultMessage: 'Command', description: 'The label of the text box of "When this workspace closes, run" and "When Combwork quits, run" (Settings): the command Combwork runs.' }),
  folder: msg({ id: 'settings.commands.folder', defaultMessage: 'Folder (empty: the workspace folder)', description: "A field of the command dialog (HI-1954): the folder the command runs in; empty, the workspace's folder (the user's home folder for Combwork's quit point)." }),
  placeholders: msg({
    id: 'settings.commands.placeholders',
    defaultMessage: "cmd.exe runs it. '{workspace}' becomes the workspace's folder, '{name}' its name, '{reason}' why it runs (open, window, switch, quit, update or manual), and '{project:api}' the folder of the project api. Quote them where a path may hold spaces.",
    description: "A hint in the command dialog (HI-1954). '{workspace}', '{name}', '{reason}' and '{project:api}' are placeholders the user writes in the command (api is an example project name), and open, window, switch, quit, update and manual are the values {reason} becomes: keep all of them as they are (the quotes around them keep them from being read as placeholders here)."
  }),
  runs: msg({ id: 'settings.closeCommand.runs', defaultMessage: 'Runs: {command}', description: 'Under the close command in Settings: the command exactly as Combwork would run it, its placeholders filled in. {command} is that command: keep it as it is.' }),
  hint: msg({
    id: 'settings.closeCommand.hint',
    defaultMessage: 'Combwork waits for it, showing it running. A command that shouldn\'t hold Combwork up can start its job and return, e.g. start "" "backup.cmd".',
    description: 'A hint under the close command in Settings. start "" "backup.cmd" is a Windows command (cmd.exe starts the file and returns at once): keep it as it is.'
  }),
  save: msg({ id: 'settings.commands.save', defaultMessage: 'Save', description: 'The command dialog\'s button (HI-1954).' }),
  cancel: msg({ id: 'settings.commands.cancel', defaultMessage: 'Cancel', description: 'The command dialog\'s button (HI-1954).' }),
  noWorkspace: msg({ id: 'settings.commands.noWorkspace', defaultMessage: "Open a workspace to set its commands.", description: "Settings → Workspace's commands and its open and close points (HI-1954), with no workspace open." }),
  saveFailed: msg({ id: 'settings.closeCommand.saveFailed', defaultMessage: "Couldn't save the command", description: "An error's title: saving the command Combwork runs as the workspace closes or as Combwork quits (Settings) failed (why follows)." }),
  runFailed: msg({ id: 'settings.commands.runFailed', defaultMessage: "Couldn't run the command", description: "An error's title: running one of the user's commands by hand failed to start (why follows; HI-1954)." }),
  pointEmpty: msg({ id: 'settings.commands.pointEmpty', defaultMessage: 'Nothing runs.', description: 'A point such as "When this workspace opens, run" (HI-1954) with no command picked.' }),
  pointAdd: msg({ id: 'settings.commands.pointAdd', defaultMessage: 'Add a command to run here…', description: 'A drop-down under a point such as "When this workspace opens, run" (HI-1954): picks one of the commands to run there, after those already picked.' }),
  pointRemove: msg({ id: 'settings.commands.pointRemove', defaultMessage: "Don't run it here", description: 'A button beside a command a point runs (HI-1954): takes it off that point; the command itself stays.' }),
  combworkBadge: msg({ id: 'settings.commands.combworkBadge', defaultMessage: 'Combwork', description: "A short tag beside a command in a workspace's point (HI-1954): one of Combwork's own commands (Settings → General → Commands), not the workspace's." }),
  gone: msg({ id: 'settings.commands.gone', defaultMessage: '(deleted)', description: 'A command a point still names but which was deleted (HI-1954): it is skipped.' }),
  cantFill: msg({ id: 'settings.commands.cantFill', defaultMessage: "{placeholders} can't be filled here: it won't run", description: "A warning beside a command a point runs (HI-1954): placeholders in it have no value at that point (for example {workspace} as Combwork quits), so Combwork won't run it there. {placeholders} lists them as written." }),
  onUpdate: msg({ id: 'settings.closeCommand.onUpdate', defaultMessage: 'Also when Combwork restarts to install an update', description: 'A checkbox under the close command (Settings → Workspace → When this workspace closes, run, and Settings → General → When Combwork quits, run): run it too when Combwork restarts to install an update (by default it is skipped then).' })
}

/**
 * A scope's commands as this window edits them (Hive's, or a workspace's by its path), shared by every control of that
 * scope (HR2's round 1: each control's own copy, saving the whole scope, dropped a sibling's pending edit). An edit is a
 * change of the latest value, pending ones included; saves go one after another, in order; the value saved comes back
 * from main and is taken as the shown one only once none of the scope's saves is pending, so a reply or event for an
 * older save never undoes a newer edit.
 */
interface Scope<T> {
  /** The value shown while edits are pending or before main's copy has caught up; null: main's. */
  edited: T | null
  /** main's copy, as last seen: a new one, with nothing pending, is shown from then on. */
  seen: T | null
  pending: number
  queue: Promise<unknown>
  listeners: Set<() => void>
}
const scopes = new Map<string, Scope<unknown>>()
const scopeOf = <T,>(key: string): Scope<T> => {
  let s = scopes.get(key) as Scope<T> | undefined
  if (!s) scopes.set(key, (s = { edited: null, seen: null, pending: 0, queue: Promise.resolve(), listeners: new Set() }))
  return s
}

/** main's copy as rendered: a new one, with nothing pending, is shown from then on. */
function adopt<T>(s: Scope<T>, saved: T): void {
  if (saved === s.seen) return
  s.seen = saved
  if (!s.pending) s.edited = null
}

/** An edit of the latest value (pending ones included), shown at once and saved after the saves before it. */
function edit<T>(s: Scope<T>, change: (current: T) => T, onSave: (next: T) => Promise<unknown>): void {
  const next = change(s.edited ?? (s.seen as T))
  s.edited = next
  s.pending++
  for (const l of s.listeners) l()
  s.queue = s.queue
    .then(() => onSave(next))
    .catch(() => undefined)
    .finally(() => {
      s.pending--
      for (const l of s.listeners) l()
    })
}

function useScope<T>(key: string, saved: T, onSave: (next: T) => Promise<unknown>): [T, (change: (current: T) => T) => void] {
  const s = scopeOf<T>(key)
  adopt(s, saved)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    s.listeners.add(rerender)
    return () => void s.listeners.delete(rerender)
  }, [s])
  return [s.edited ?? saved, (change) => edit(s, change, onSave)]
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
function PointPicker({ point, lists, values, update, onChange }: { point: CommandPoint; lists: { combwork: CustomCommand[]; workspace?: CustomCommand[] }; values: CommandValues; update: boolean; onChange: (next: CommandPoint) => void }) {
  useLanguage()
  const find = (r: CommandRef): CustomCommand | undefined => (r.scope === 'combwork' ? lists.combwork : (lists.workspace ?? [])).find((c) => c.id === r.id)
  const picked = (r: CommandRef): boolean => point.run.some((x) => x.scope === r.scope && x.id === r.id)
  const choices: CommandRef[] = [...(lists.workspace ?? []).map((c) => ({ scope: 'workspace' as const, id: c.id })), ...lists.combwork.map((c) => ({ scope: 'combwork' as const, id: c.id }))].filter((r) => !picked(r))
  const label = (r: CommandRef): string => `${find(r)?.name ?? tr(M.gone)}${r.scope === 'combwork' && lists.workspace ? ` (${tr(M.combworkBadge)})` : ''}`
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

/** Hive's commands, as saved (settings.commands), and its edit. */
function useCombwork(): [CommandsCombwork, (change: (current: CommandsCombwork) => CommandsCombwork) => void] {
  const value = useStore((s) => s.settings?.commands ?? EMPTY_CW)
  // Every window gets settings-changed with what was saved.
  return useScope('combwork', value, (next) => actions.attempt(tr(M.saveFailed), () => call('commands:setCombwork', next)))
}

/** The workspace's commands, as saved (workspace.json), and its edit: saved to that workspace, whatever the window shows by then. */
function useWorkspace(): [CommandsWorkspace, (change: (current: CommandsWorkspace) => CommandsWorkspace) => void] {
  const path = useStore((s) => s.workspace?.path ?? '')
  const value = useStore((s) => s.workspace?.config.commands ?? EMPTY_WORKSPACE)
  // The window gets workspace-changed with the saved config.
  return useScope(`workspace:${path.toLowerCase()}`, value, (next) => actions.attempt(tr(M.saveFailed), () => call('commands:setWorkspace', path, next)))
}

/** Settings → General → Commands: Hive's own commands. Deleting one takes it off When Hive quits too. */
export function CombworkCommands() {
  const [combwork, save] = useCombwork()
  const values = useValues('manual')
  return (
    <CommandList
      list={combwork.list}
      values={values}
      run={(id) => runIt({ scope: 'combwork', id })}
      onChange={(list) => save((cur) => ({ list, onQuit: { ...cur.onQuit, run: cur.onQuit.run.filter((r) => list.some((c) => c.id === r.id)) } }))}
    />
  )
}

/** Settings → General → When Hive quits, run: Hive's commands, in order. */
export function QuitPoint() {
  const [combwork, save] = useCombwork()
  return <PointPicker point={combwork.onQuit} lists={{ combwork: combwork.list }} values={{ reason: 'quit' }} update onChange={(onQuit) => save((cur) => ({ ...cur, onQuit }))} /> // i18n-ignore: {reason}'s value, as main fills it in
}

/** Settings → Workspace → Commands: the workspace's own. Deleting one takes it off its open and close points. */
export function WorkspaceCommands() {
  const path = useStore((s) => s.workspace?.path ?? null)
  const [ws, save] = useWorkspace()
  const values = useValues('manual')
  if (!path) return <div className="muted">{tr(M.noWorkspace)}</div>
  const keep = (list: CustomCommand[]) => (p: CommandPoint): CommandPoint => ({ ...p, run: p.run.filter((r) => r.scope === 'combwork' || list.some((c) => c.id === r.id)) })
  return <CommandList list={ws.list} values={values} run={(id) => runIt({ scope: 'workspace', id })} onChange={(list) => save((cur) => ({ list, onOpen: keep(list)(cur.onOpen), onClose: keep(list)(cur.onClose) }))} />
}

/** Settings → Workspace → When this workspace opens, run, and When this workspace closes, run. */
export function WorkspacePoint({ which }: { which: 'onOpen' | 'onClose' }) {
  const path = useStore((s) => s.workspace?.path ?? null)
  const combwork = useStore((s) => s.settings?.commands ?? EMPTY_CW)
  const [ws, save] = useWorkspace()
  const values = useValues(which === 'onOpen' ? 'open' : 'window') // i18n-ignore: {reason}'s values, as main fills them in
  if (!path) return <div className="muted">{tr(M.noWorkspace)}</div>
  return <PointPicker point={ws[which]} lists={{ combwork: combwork.list, workspace: ws.list }} values={values} update={which === 'onClose'} onChange={(p) => save((cur) => ({ ...cur, [which]: p }))} />
}
