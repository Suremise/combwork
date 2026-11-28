import { msg, tr } from '@shared/i18n'
import { useStore } from '../store'
import { Icon } from './ui'

const M = {
  opening: msg({ id: 'workspace.opening.title', defaultMessage: 'Opening {name}', description: "The heading of the view Combwork shows while it opens a workspace ({name}: the workspace's folder name)." }),
  projects: msg({ id: 'workspace.opening.projects', defaultMessage: 'Reading its projects…', description: 'A step of opening a workspace: Combwork reads its projects.' }),
  wait: msg({ id: 'workspace.opening.wait', defaultMessage: 'Another workspace can be opened in this window once this is done.', description: 'Under the steps of opening a workspace: why the window takes no other workspace meanwhile.' })
}

/**
 * The steady view while this window opens its workspace (HI-1694): its name and the step under way, over the window, so
 * nothing else (another workspace) is opened meanwhile. Main refuses one anyway, saying why.
 */
export function WorkspaceOpening() {
  const p = useStore((s) => s.openProgress)
  if (!p) return null
  return (
    <div className="overlay workspace-opening" role="status" aria-live="polite" data-step={p.step}>
      <div className="dialog workspace-opening-card">
        <div className="dialog-header">
          <Icon name="loading" spin />
          <h3>{tr(M.opening, { name: p.name })}</h3>
        </div>
        <div className="dialog-body">
          <p className="workspace-opening-step">{tr(M[p.step])}</p>
          <p className="faint">{tr(M.wait)}</p>
        </div>
      </div>
    </div>
  )
}
