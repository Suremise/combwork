import { useEffect, useRef, useState } from 'react'
import type { CloseCommandSetting } from '@shared/types'
import { closeCommandOf, fillCloseCommand, type CloseCommandValues } from '@shared/closeCommand'
import { msg, tr } from '@shared/i18n'
import * as actions from '../actions'
import { call } from '../api'
import { useLanguage, useStore } from '../store'
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

/**
 * The text box, the update checkbox, what it runs here, and the hint. The command and the tick are one value, saved
 * whole and in order (HR6's round 1, finding 5: a tick right after typing saved the old command over the new one); the
 * value saved comes back from main, and is taken as the shown one only once no save of this control's is pending, so a
 * reply or event for an older save never undoes a newer edit.
 */
function CloseCommandControl({ value, values, onSave }: { value: CloseCommandSetting; values: CloseCommandValues; onSave: (next: CloseCommandSetting) => Promise<unknown> }) {
  useLanguage()
  const [draft, setDraft] = useState(value.command)
  const [onUpdate, setOnUpdate] = useState(value.onUpdate)
  const saved = useRef<CloseCommandSetting>(value)
  const pending = useRef(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => {
    if (pending.current) return
    saved.current = value
    setDraft(value.command)
    setOnUpdate(value.onUpdate)
  }, [value])
  const save = (next: CloseCommandSetting): void => {
    if (next.command === saved.current.command && next.onUpdate === saved.current.onUpdate) return
    saved.current = next
    pending.current++
    queue.current = queue.current
      .then(() => onSave(next))
      .catch(() => undefined)
      .finally(() => {
        pending.current--
      })
  }
  const commit = (): void => save({ command: draft.trim(), onUpdate })
  const shown = closeCommandOf({ command: draft })
  return (
    <div className="close-command-settings">
      <input className="input close-command-input" spellCheck={false} aria-label={tr(M.command)} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      <label className="flex">
        <input
          type="checkbox"
          className="checkbox close-command-update"
          checked={onUpdate}
          onChange={(e) => {
            setOnUpdate(e.target.checked)
            // The command as typed now, not as last saved: one value, the tick with it.
            save({ command: draft.trim(), onUpdate: e.target.checked })
          }}
        />{' '}
        {tr(M.onUpdate)}
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
  // The window gets workspace-changed with the saved config.
  const save = (next: CloseCommandSetting): Promise<unknown> => actions.attempt(tr(M.saveFailed), () => call('closeCommand:setWorkspace', next))
  return <CloseCommandControl value={value} values={{ workspace: path, name: basename(path), reason: 'window' }} onSave={save} /> // i18n-ignore: {reason}'s value, as main fills it in
}

/** Settings → General → When Hive quits, run: Hive's settings (general.onQuit). */
export function QuitCommand() {
  const value = useStore((s) => s.settings?.general.onQuit ?? NO_SETTING)
  // Every window gets settings-changed with what was saved: no reply written here, which could be an older save's.
  const save = (next: CloseCommandSetting): Promise<unknown> => actions.attempt(tr(M.saveFailed), () => call('settings:update', { general: { onQuit: next } }))
  return <CloseCommandControl value={value} values={{ reason: 'quit' }} onSave={save} /> // i18n-ignore: {reason}'s value, as main fills it in
}
