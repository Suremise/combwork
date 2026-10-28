import { useEffect, useState } from 'react'
import type { CloseCommandSetting } from '@shared/types'
import { closeCommandOf, fillCloseCommand, type CloseCommandValues } from '@shared/closeCommand'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { msg, tr } from '@shared/i18n'
import * as actions from '../actions'
import { call } from '../api'
import { set, useLanguage, useStore } from '../store'
import { basename } from '../util'

/**
 * Settings → Workspace → When this workspace closes, run, and Settings → General → When Hive quits, run (HI-1368): the
 * command, whether it runs before an update installs too, and what it runs here with its placeholders filled in.
 * Main runs them (closeCommand/) and shows CloseCommandPanel while one runs.
 */

const M = {
  command: msg({ id: 'settings.closeCommand.command', defaultMessage: 'Command', description: 'The label of the text box of "When this workspace closes, run" and "When Hive quits, run" (Settings): the command Hive runs.' }),
  onUpdate: msg({ id: 'settings.closeCommand.onUpdate', defaultMessage: 'Also when Hive restarts to install an update', description: 'A checkbox under the close command (Settings → Workspace → When this workspace closes, run, and Settings → General → When Hive quits, run): run it too when Hive restarts to install an update (by default it is skipped then).' }),
  runs: msg({ id: 'settings.closeCommand.runs', defaultMessage: 'Runs: {command}', description: 'Under the close command in Settings: the command exactly as Hive would run it, its placeholders filled in. {command} is that command: keep it as it is.' }),
  hint: msg({
    id: 'settings.closeCommand.hint',
    defaultMessage: 'Hive waits for it, showing it running. A command that shouldn\'t hold Hive up can start its job and return, e.g. start "" "backup.cmd".',
    description: 'A hint under the close command in Settings. start "" "backup.cmd" is a Windows command (cmd.exe starts the file and returns at once): keep it as it is.'
  }),
  noWorkspace: msg({ id: 'settings.closeCommand.noWorkspace', defaultMessage: 'Open a workspace to set its close command.', description: 'Settings → Workspace → When this workspace closes, run, with no workspace open.' }),
  saveFailed: msg({ id: 'settings.closeCommand.saveFailed', defaultMessage: "Couldn't save the command", description: "An error's title: saving the command Hive runs as the workspace closes or as Hive quits (Settings) failed (why follows)." })
}

const NO_SETTING: CloseCommandSetting = { command: '', onUpdate: false }

/** The text box, the update checkbox, what it runs here, and the hint. */
function CloseCommandControl({ value, values, onSave }: { value: CloseCommandSetting; values: CloseCommandValues; onSave: (next: CloseCommandSetting) => void }) {
  useLanguage()
  const [draft, setDraft] = useState(value.command)
  useEffect(() => setDraft(value.command), [value.command])
  const commit = (): void => {
    if (draft.trim() !== value.command) onSave({ command: draft.trim(), onUpdate: value.onUpdate })
  }
  const shown = closeCommandOf({ command: draft })
  return (
    <div className="close-command-settings">
      <input className="input close-command-input" spellCheck={false} aria-label={tr(M.command)} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      <label className="flex">
        <input type="checkbox" className="checkbox close-command-update" checked={value.onUpdate} onChange={(e) => onSave({ command: value.command, onUpdate: e.target.checked })} /> {tr(M.onUpdate)}
      </label>
      {shown && <div className="close-command-preview">{tr(M.runs, { command: fillCloseCommand(shown, values) })}</div>}
      <div className="s-desc muted">{tr(M.hint)}</div>
    </div>
  )
}

/** Settings → Workspace → When this workspace closes, run: saved in the workspace's workspace.json by main. */
export function WorkspaceCloseCommand() {
  const path = useStore((s) => s.workspace?.path ?? null)
  const value = useStore((s) => s.workspace?.config.onClose ?? NO_SETTING)
  if (!path) return <div className="muted">{tr(M.noWorkspace)}</div>
  const save = (next: CloseCommandSetting): void => {
    // The window gets workspace-changed with the saved config; until then, no copy of our own to keep in step.
    void actions.attempt(tr(M.saveFailed), () => call('closeCommand:setWorkspace', next))
  }
  return <CloseCommandControl value={value} values={{ workspace: path, name: basename(path), reason: 'window' }} onSave={save} /> // i18n-ignore: {reason}'s value, as main fills it in
}

/** Settings → General → When Hive quits, run: Hive's settings (general.onQuit). */
export function QuitCommand() {
  const value = useStore((s) => s.settings?.general.onQuit ?? DEFAULT_SETTINGS.general.onQuit)
  const save = (next: CloseCommandSetting): void => {
    void actions.attempt(tr(M.saveFailed), () => call('settings:update', { general: { onQuit: next } })).then((s) => void (s && set({ settings: s })))
  }
  return <CloseCommandControl value={value} values={{ reason: 'quit' }} onSave={save} /> // i18n-ignore: {reason}'s value, as main fills it in
}
