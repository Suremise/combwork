import type { ProjectInfo } from '@shared/types'
import type { QueueView } from '@shared/workflow/queue'
import { msg, tr } from '@shared/i18n'
import { gitStatusText, gitStatusTip, VC_SECTIONS, vcSections, vcSectionShown } from '@shared/gitRepo'
import { showVersionControl, useStore } from '../store'
import { cx } from '../util'
import { Icon, Tooltip } from '../components/ui'
import { INIT_TEXT, InitRepoButton, InitRepoHost } from '../components/InitRepo'
import { GitQueueSection, useProjectQueues } from '../components/GitQueueSection'
import { WorkflowOptionsForm } from '../components/WorkflowOptions'
import { ChangesTab } from './ProjectTabs'
import { at, GitProblem, GitSetupNotes, HistorySection, useGitRead } from './GitTab'
import { BranchesSection } from './GitBranches'
import { useWorkflowForm, VersionControlHeader } from './VersionControlHeader'
import { PresetStep } from '../components/PresetStep'

/**
 * The project's Version Control tab (#1416, SPEC §16.6; the Git tab before 1.0, its id still `changes`): the header
 * (VersionControlHeader.tsx), the section tablist and the section shown. Workflow comes first, then the platform's own
 * sections: for Git, Changes, History, Branches & remotes (GitBranches.tsx) and Merge queue. A None project shows
 * Workflow, Initialise repository… when its folder has none, and the Merge queue while an old Git ruleset's queue is
 * still there (#1356's rule).
 */

const NO_QUEUES: QueueView[] = []

const M = {
  tabs: msg({ id: 'git.vc.sections', defaultMessage: 'Version Control', description: "Accessible name of the Version Control tab's row of sections (Workflow, Changes, History…). Glossary 2.1: Version Control (the tab)." }),
  initHint: msg({ id: 'git.vc.initHint', defaultMessage: 'Initialise repository… makes this folder a Git repository on a branch called main, keeps its .hive out of git and commits its files.', description: 'Under the header of the Version Control tab of a project whose folder has no repository, beside the button. Initialise repository… is the button’s name: keep it as translated there. Keep main (the branch name).' })
}

export function VersionControl({ project }: { project: ProjectInfo }) {
  const summary = useGitRead('git:summary', project)
  const s = summary.data
  const platform = project.platform?.id ?? (s?.isRepo ? 'git' : 'none')
  // The project's queues, read for themselves: an old Git ruleset's queue keeps its section (#1356's rule).
  const queues = useProjectQueues(project.path)
  const shown = vcSections(platform, queues ?? NO_QUEUES, Date.now())
  const section = vcSectionShown(useStore((st) => st.vcSection[project.path]), shown)
  // The project's workflow form, read once: the header's preset, and "How do you work?" while it asks (#1423).
  const form = useWorkflowForm(project)
  // None's page offers Initialise repository… while the folder has no repository of its own (none, or one around it).
  const noRepo = platform === 'none' && !!s && (!s.isRepo || !!s.parentRepo) && !s.gitProblem && !project.platform?.detected.other
  return (
    <div className="git-view vc-view" data-platform={platform}>
      <VersionControlHeader project={project} platform={platform} form={form} />
      {noRepo && (
        <div className="vc-init" data-vc-init="" {...(s?.parentRepo ? { 'data-git-parent': '' } : {})}>
          <InitRepoButton project={project} small {...(s?.parentRepo ? { label: tr(INIT_TEXT.ownRepoButton) } : {})} />
          <span className="hint">{tr(M.initHint)}</span>
        </div>
      )}
      <PresetStep project={project} platform={platform} form={form} />
      <div className="git-head">
        <div className="segmented git-sections" role="tablist" aria-label={tr(M.tabs)}>
          {VC_SECTIONS.filter((x) => shown.includes(x.id)).map((x) => (
            <button key={x.id} role="tab" data-section={x.id} aria-selected={section === x.id} className={cx(section === x.id && 'active')} onClick={() => showVersionControl(project.path, x.id)}>
              <Icon name={x.icon} /> {tr(x.label)}
            </button>
          ))}
        </div>
        {platform === 'git' && s?.isRepo && (
          <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{gitStatusTip(s, at(s.fetchedAt))}</span>}>
            <span className="git-head-status faint">
              <Icon name="git-branch" /> {gitStatusText(s)}
            </span>
          </Tooltip>
        )}
      </div>
      <div className="git-body">
        {section === 'workflow' ? (
          <div className="scroll-page">
            <div className="page-narrow vc-workflow-page" data-vc-workflow="">
              <WorkflowOptionsForm project={project} />
            </div>
          </div>
        ) : section === 'queue' ? (
          <GitQueueSection project={project} />
        ) : s && !s.isRepo && !s.gitProblem ? (
          <GitSetupNotes project={project} />
        ) : section === 'changes' ? (
          <ChangesTab project={project} />
        ) : s?.gitProblem ? (
          <GitProblem problem={s.gitProblem} retry={summary.reload} />
        ) : section === 'history' ? (
          <HistorySection project={project} summary={s} />
        ) : (
          <BranchesSection project={project} />
        )}
      </div>
      <InitRepoHost project={project} />
    </div>
  )
}
