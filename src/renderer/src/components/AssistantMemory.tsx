// The Assistant's own memory (HI-2666), in the Assistant view's main area: the files its coding agent saved about working
// with the user, kept for the workspace's folder, listed and opened as a project's Memory tab lists and opens its auto
// memory (the same editor, the same file guard). Loaded per workspace and provider: a reply for another, or a file of
// another, never shows here.
import { useCallback, useEffect, useState } from 'react'
import type { AgentInfo, AssistantMemory as Memory } from '@shared/types'
import { assistantMemoryProvider, assistantMemoryScope } from '@shared/assistantMemory'
import { providerName } from '@shared/providers'
import { msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { agentProviderOf, notify, useStore } from '../store'
import { cx } from '../util'
import { DocEditor } from './DocEditor'
import { PaneResizer, usePaneSize } from './Resizer'
import { useScopedLoad } from '../scopedLoad'
import { Icon, IconButton, InfoTip, LoadFailed, StaleNote } from './ui'

export const ASSISTANT_MEMORY_TEXT = {
  section: msg({ id: 'assistant.memory.section', defaultMessage: 'Memory', description: "The Assistant view (HI-2666): the section of the Assistant's own memory (what its coding agent saved about working with you)." }),
  row: msg({ id: 'assistant.memory.row', defaultMessage: 'Its Memory', description: "The Assistant view (HI-2666): the row that shows the Assistant's own memory files in the main area." }),
  tip: msg({ id: 'assistant.memory.tip', defaultMessage: "What the Assistant's coding agent saved about working with you, in its memory for the workspace's folder (where the Assistant's sessions run). A project whose folder is the workspace's own reads the same memory.", description: "The Assistant view (HI-2666): the info tip of its Memory section. It says whose memory it is and where it is kept, and makes no promise about who else can read it." }),
  heading: msg({ id: 'assistant.memory.heading', defaultMessage: "The Assistant's Memory · This Workspace", description: "The heading of the list of the Assistant's own memory files (HI-2666), as against a project's Memory tab." }),
  refresh: msg({ id: 'assistant.memory.refresh', defaultMessage: 'Refresh', description: "A button on the Assistant's memory list (HI-2666): reads the files again." }),
  target: msg({ id: 'assistant.memory.target', defaultMessage: "the Assistant's memory", description: "What failed to load, in \"Couldn't load {what}\" (HI-2666): the Assistant's own memory files." }),
  copyPath: msg({ id: 'assistant.memory.copyPath', defaultMessage: 'Copy Path', description: "A button beside the folder of the Assistant's memory (HI-2666): copies its path." }),
  copied: msg({ id: 'assistant.memory.copied', defaultMessage: 'Path copied', description: "A notification (HI-2666): the path of the Assistant's memory folder was copied." }),
  openFolder: msg({ id: 'assistant.memory.openFolder', defaultMessage: 'Open Folder', description: "A button beside the folder of the Assistant's memory (HI-2666): opens it in File Explorer (disabled while there is none yet)." }),
  empty: msg({ id: 'assistant.memory.empty', defaultMessage: 'No memory yet: {provider} saves what it learns about working with you here.', description: "The Assistant's memory list when its folder has no files yet (HI-2666). {provider}: the coding agent's name (Claude Code)." }),
  unsupported: msg({ id: 'assistant.memory.unsupported', defaultMessage: "This view shows saved memory for Claude Code only: {provider}'s, if it keeps any, isn't shown here.", description: "The Assistant's memory view when the Assistant runs on a coding agent ({provider}: Codex, GitHub Copilot) whose saved memory Combwork doesn't show (HI-2666). It says nothing of whether that agent keeps any." }),
  choose: msg({ id: 'assistant.memory.choose', defaultMessage: 'Choose a file on the left.', description: "The Assistant's memory view's main area before a file is chosen (HI-2666)." }),
  loading: msg({ id: 'assistant.memory.loading', defaultMessage: 'Loading…', description: "The Assistant's memory list while it reads the files (HI-2666)." })
}
const T = ASSISTANT_MEMORY_TEXT

export function AssistantMemoryView({ agent }: { agent: AgentInfo }) {
  const wsPath = useStore((s) => s.workspace?.path ?? '')
  // The CLI it runs on now, else the one its next launch uses.
  const provider = assistantMemoryProvider(agent.live, agentProviderOf(agent))
  const scope = assistantMemoryScope(wsPath, provider)
  const memory = useScopedLoad<Memory>(scope)
  const { load: loadScoped } = memory
  const load = useCallback(() => loadScoped(scope, () => call('assistant:memory', provider)), [scope, provider, loadScoped])
  useEffect(load, [load])
  // The file chosen, of this scope only: another workspace's or provider's never stays chosen.
  const [chosen, setChosen] = useState<{ scope: string; path: string } | null>(null)
  const files = memory.data?.files ?? []
  const selected = chosen?.scope === scope && files.some((f) => f.path === chosen.path) ? chosen.path : (files[0]?.path ?? null)
  const listWidth = usePaneSize('assistantMemory', 280)
  const folder = memory.data?.folder ?? null
  const name = providerName(provider)
  const copy = (): void => void navigator.clipboard.writeText(folder!).then(() => notify('success', tr(T.copied)))
  // Main opens the folder it names for this workspace and provider (HI-2736); a refusal is shown, never dropped.
  const openFolder = (): void => void call('assistant:openMemoryFolder', provider).catch((e: unknown) => notify('error', errorMessage(e)))
  return (
    <div className="split assistant-memory">
      <div className="split-list" style={{ width: listWidth }}>
        <PaneResizer paneKey="assistantMemory" />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          {tr(T.heading)}
          <InfoTip text={tr(T.tip)} />
          <div className="actions">
            <IconButton icon="refresh" title={tr(T.refresh)} onClick={load} />
          </div>
        </div>
        {memory.error && memory.data && <StaleNote what={tr(T.target)} error={memory.error} at={memory.at} onRetry={load} />}
        <div className="pane-body">
          {memory.error && !memory.data && <LoadFailed inline what={tr(T.target)} error={memory.error} onRetry={load} />}
          {!memory.error && !memory.data && (
            <div className="pane-empty">
              <Icon name="loading" spin /> {tr(T.loading)}
            </div>
          )}
          {memory.data && !folder && <div className="pane-empty assistant-memory-unsupported">{tr(T.unsupported, { provider: name })}</div>}
          {memory.data && folder && (
            <>
              <div className="assistant-memory-folder" data-folder={folder}>
                <span className="path" title={folder}>
                  {folder}
                </span>
                <IconButton icon="copy" title={tr(T.copyPath)} onClick={copy} />
                <IconButton icon="folder-opened" title={tr(T.openFolder)} disabled={!files.length} onClick={openFolder} />
              </div>
              {!files.length && <div className="pane-empty assistant-memory-empty">{tr(T.empty, { provider: name })}</div>}
              {files.map((f) => (
                <div key={f.path} className={cx('row', selected === f.path && 'selected')} data-path={f.path} title={f.path} onClick={() => setChosen({ scope, path: f.path })}>
                  <Icon name="lightbulb" />
                  <span className="label">{f.label}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      {selected ? (
        // Keyed to its scope and file: an editor never keeps another workspace's, provider's or file's text or save target.
        <DocEditor key={`${scope}|${selected}`} path={selected} title={files.find((f) => f.path === selected)?.label ?? selected} onSaved={load} />
      ) : (
        <div className="split-main">
          <div className="empty-state">{tr(T.choose)}</div>
        </div>
      )}
    </div>
  )
}
