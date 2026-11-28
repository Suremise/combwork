// Project Settings → Preview (HI-3614, SPEC §16.21): the command that runs the project's dev server, its page's path, and
// whether it gets a second port for hot reload. A command suggested from package.json's scripts is only offered: Use it
// fills the box, and nothing is saved until Save. It says the address the server must listen on. Shown only while
// Settings → Advanced's Preview switch is on (ProjectTabs.tsx); main refuses every call while it is off.

import { useEffect, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import { previewConfigOf, PREVIEW_ENV, validPreviewPath, type PreviewConfig, type PreviewSuggestion } from '@shared/preview'
import { msg, tr } from '@shared/i18n'
import * as actions from '../actions'
import { call } from '../api'
import { notify } from '../store'
import { Icon, Switch } from './ui'

const M = {
  command: msg({ id: 'preview.settings.command', defaultMessage: 'Command', description: "A field's label (Project Settings → Preview): the command line that starts the project's development server." }),
  commandPlaceholder: msg({ id: 'preview.settings.commandPlaceholder', defaultMessage: 'npm run dev', description: 'The example in the empty Command box (Project Settings → Preview): a command line, keep it as it is.' }),
  path: msg({ id: 'preview.settings.path', defaultMessage: 'Page', description: "A field's label (Project Settings → Preview): the path of the page to open on the server, such as / or /app." }),
  hmr: msg({ id: 'preview.settings.hmr', defaultMessage: 'A second port for hot reload', description: "A switch's label (Project Settings → Preview): the server also gets a port of its own for its hot reload socket, in CW_PREVIEW_HMR_PORT." }),
  hmrNote: msg({ id: 'preview.settings.hmrNote', defaultMessage: 'In {variable}, for a server whose hot reload socket listens apart.', description: 'Beside the switch "A second port for hot reload" (Project Settings → Preview). {variable} is CW_PREVIEW_HMR_PORT, an environment variable.' }),
  suggested: msg({ id: 'preview.settings.suggested', defaultMessage: 'package.json’s {script} script runs {line}. Suggested command: {command}', description: "A line under the Command box (Project Settings → Preview): Combwork found a script in the project's package.json. {script} is its name (dev, start, preview), {line} its command line, {command} the command Combwork suggests (npm run dev): keep them as they are." }),
  takeIt: msg({ id: 'preview.settings.useIt', defaultMessage: 'Use it', description: 'A button beside the suggested command (Project Settings → Preview): puts it in the Command box, unsaved until Save.' }),
  noSuggestion: msg({ id: 'preview.settings.noSuggestion', defaultMessage: 'No dev, start or preview script in package.json to suggest.', description: "A line under the Command box (Project Settings → Preview): the project's package.json has none of these scripts (keep their names as they are), or there is no package.json." }),
  address: msg({ id: 'preview.settings.address', defaultMessage: 'Each start gets a free port from {first}–{last} in {variable}. The server must listen on it on localhost: the page is then at {url}.', description: "A line in Project Settings → Preview: where the dev server must listen. {first} and {last} are port numbers (the range), {variable} is PORT (an environment variable), {url} an address such as http://127.0.0.1:%PORT%/: keep the last two as they are." }),
  save: msg({ id: 'preview.settings.save', defaultMessage: 'Save', description: "A button (Project Settings → Preview): saves the preview's command, page and hot reload port." }),
  clear: msg({ id: 'preview.settings.clear', defaultMessage: 'Remove', description: "A button (Project Settings → Preview): removes the project's preview command." }),
  saved: msg({ id: 'preview.settings.saved', defaultMessage: 'Preview saved', description: "A notification: Project Settings → Preview's values were saved." }),
  failed: msg({ id: 'preview.settings.failed', defaultMessage: "Couldn't save the preview", description: "An error's title: saving Project Settings → Preview's values failed." }),
  badPath: msg({ id: 'preview.settings.badPath', defaultMessage: 'A page path starts with / and has no spaces or backslashes.', description: "An error under the Page box (Project Settings → Preview): what was typed isn't a page path." })
}

export function PreviewSettings({ project }: { project: ProjectInfo }) {
  const saved = previewConfigOf(project.config.preview)
  const [command, setCommand] = useState(saved?.command ?? '')
  const [path, setPath] = useState(saved?.path ?? '/')
  const [hmr, setHmr] = useState(!!saved?.hmrPort)
  const [setup, setSetup] = useState<{ suggestion: PreviewSuggestion | null; range: [number, number] } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setCommand(saved?.command ?? '')
    setPath(saved?.path ?? '/')
    setHmr(!!saved?.hmrPort)
    // Read again when the saved setting changes (another window, the Assistant).
  }, [saved?.command, saved?.path, saved?.hmrPort])
  useEffect(() => {
    let live = true
    call('preview:suggest', project.path).then(
      (r) => live && setSetup(r),
      () => live && setSetup(null)
    )
    return () => {
      live = false
    }
  }, [project.path])
  const p = path.trim() || '/'
  const pathOk = validPreviewPath(p)
  const changed = command.trim() !== (saved?.command ?? '') || p !== (saved?.path ?? '/') || hmr !== !!saved?.hmrPort
  const save = async (config: PreviewConfig | null): Promise<void> => {
    setBusy(true)
    const done = await actions.attempt(tr(M.failed), () => call('preview:setConfig', project.path, config))
    setBusy(false)
    if (done !== undefined) {
      notify('success', tr(M.saved))
      await actions.refreshWorkspace()
    }
  }
  const s = setup?.suggestion
  return (
    <div className="preview-settings" data-setting="preview">
      <label className="field">
        <span>{tr(M.command)}</span>
        <input className="input mono" data-field="command" value={command} spellCheck={false} placeholder={tr(M.commandPlaceholder)} maxLength={1000} disabled={busy} onChange={(e) => setCommand(e.target.value)} />
      </label>
      {setup && (s ? (
        <div className="field-hint" data-preview="suggestion">
          {tr(M.suggested, { script: s.script, line: s.line, command: s.command })}{' '}
          <button className="btn small subtle" data-action="use-suggestion" disabled={busy || command.trim() === s.command} onClick={() => setCommand(s.command)}>
            {tr(M.takeIt)}
          </button>
        </div>
      ) : (
        <div className="field-hint faint" data-preview="no-suggestion">{tr(M.noSuggestion)}</div>
      ))}
      <label className="field">
        <span>{tr(M.path)}</span>
        <input className={`input mono${pathOk ? '' : ' invalid'}`} data-field="path" value={path} spellCheck={false} maxLength={200} disabled={busy} aria-invalid={!pathOk} onChange={(e) => setPath(e.target.value)} />
      </label>
      {!pathOk && <div className="field-error">{tr(M.badPath)}</div>}
      <div className="preview-row">
        <Switch checked={hmr} disabled={busy} label={tr(M.hmr)} onChange={setHmr} />
        <span className="preview-hmr-label">{tr(M.hmr)}</span>
        <span className="faint small">{tr(M.hmrNote, { variable: PREVIEW_ENV.hmr })}</span>
      </div>
      {setup && (
        <div className="field-hint" data-preview="address">
          {tr(M.address, { first: String(setup.range[0]), last: String(setup.range[1]), variable: PREVIEW_ENV.port, url: `http://127.0.0.1:%PORT%${p}` })}
        </div>
      )}
      <div className="preview-row">
        <button className="btn" data-action="save-preview" disabled={busy || !changed || !command.trim() || !pathOk} onClick={() => void save({ command: command.trim(), ...(p !== '/' ? { path: p } : {}), ...(hmr ? { hmrPort: true } : {}) })}>
          <Icon name="save" /> {tr(M.save)}
        </button>
        {saved && (
          <button className="btn subtle" data-action="clear-preview" disabled={busy} onClick={() => void save(null)}>
            <Icon name="discard" /> {tr(M.clear)}
          </button>
        )}
      </div>
    </div>
  )
}
