import { msg, tr } from '@shared/i18n'
import { useStore } from '../store'
import { Icon } from './ui'

const M = {
  opening: msg({ id: 'workspace.opening.title', defaultMessage: 'Opening {name}', description: "The heading of the view Hive shows while it opens a workspace ({name}: the workspace's folder name)." }),
  upgrading: msg({ id: 'workspace.opening.upgradingTitle', defaultMessage: 'Upgrading {name} to Hive 1.0', description: "The heading of the view Hive shows while it upgrades a workspace made by Hive 0.9 ({name}: its folder name), after the user said yes to the upgrade." }),
  projects: msg({ id: 'workspace.opening.projects', defaultMessage: 'Reading its projects…', description: 'A step of opening a workspace: Hive reads its projects.' }),
  upgrade: msg({ id: 'workspace.opening.upgrade', defaultMessage: 'Upgrading its board. The 0.9 board is kept as a backup.', description: "A step of upgrading a Hive 0.9 workspace to 1.0: its task board is converted to 1.0's format, after a copy of it as it was is kept." }),
  adoption: msg({ id: 'workspace.opening.adoption', defaultMessage: 'Adopting its cards and projects…', description: "A step of upgrading a Hive 0.9 workspace to 1.0: its projects get their workflow options and its cards are taken on by 1.0's workflow (or marked as from before 1.0)." }),
  slots: msg({ id: 'workspace.opening.slots', defaultMessage: "Adopting its agents' worktrees as slots…", description: "A step of upgrading a Hive 0.9 workspace to 1.0: each agent's own worktree becomes a slot (a working folder Hive lends to cards)." }),
  wait: msg({ id: 'workspace.opening.wait', defaultMessage: 'Another workspace can be opened in this window once this is done.', description: 'Under the steps of opening a workspace: why the window takes no other workspace meanwhile.' })
}

/**
 * The steady view while this window opens its workspace (HI-1694): its name and the step under way, over the window, so
 * nothing else (another workspace) is opened meanwhile. Main refuses one anyway, saying why.
 */
export function WorkspaceOpening() {
  const p = useStore((s) => s.openProgress)
  if (!p) return null
  const upgrade = p.step === 'upgrade' || p.step === 'adoption' || p.step === 'slots'
  return (
    <div className="overlay workspace-opening" role="status" aria-live="polite" data-step={p.step}>
      <div className="dialog workspace-opening-card">
        <div className="dialog-header">
          <Icon name="loading" spin />
          <h3>{tr(upgrade ? M.upgrading : M.opening, { name: p.name })}</h3>
        </div>
        <div className="dialog-body">
          <p className="workspace-opening-step">{tr(M[p.step])}</p>
          <p className="faint">{tr(M.wait)}</p>
        </div>
      </div>
    </div>
  )
}
