import { useEffect, useId, useRef } from 'react'
import type { ProjectInfo } from '@shared/types'
import type { QueueView } from '@shared/workflow/queue'
import { msg, tr } from '@shared/i18n'
import { gitStatusText, gitStatusTip, VC_SECTIONS, vcSections, vcSectionShown, type GitRepoSummary } from '@shared/gitRepo'
import { showVersionControl, useStore } from '../store'
import { refreshWorkspace } from '../actions'
import { Icon, Tooltip } from '../components/ui'
import { tabIds, Tabs } from '../components/Tabs'
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
/** The least the status line ("master · 2 ahead") keeps beside the sections before they fold to their icons (#1461). */
const STATUS_ROOM = 96

const M = {
  tabs: msg({ id: 'git.vc.sections', defaultMessage: 'Version Control', description: "Accessible name of the Version Control tab's row of sections (Workflow, Changes, History…). Glossary 2.1: Version Control (the tab)." }),
  initHint: msg({ id: 'git.vc.initHint', defaultMessage: 'Initialise repository… makes this folder a Git repository on a branch called main, keeps its .hive out of git and commits its files.', description: 'Under the header of the Version Control tab of a project whose folder has no repository, beside the button. Initialise repository… is the button’s name: keep it as translated there. Keep main (the branch name).' })
}

/**
 * The tab's own read of git (on focus, on a change) finds a repository where the project's detection, read at the last
 * workspace refresh, has none, or none where it has one (#1492: `.git` moved away): the workspace is read again, once
 * for each such answer, so the header's fact, its offer and the notice follow at once (§16.3.5), never a header saying
 * "is a Git repository" over a page saying there's none. Another system found (a jj repository colocated with git) is
 * detection's call, so the two may differ there for good.
 */
function useDetectionCatchUp(project: ProjectInfo, s: GitRepoSummary | null): void {
  const asked = useRef<string | null>(null)
  const detected = project.platform?.detected
  const readGit = !!s && s.isRepo && !s.gitProblem
  const differ = !!s && !s.gitProblem && !!detected && !detected.other && readGit !== (detected.platform === 'git')
  const key = `${project.path}:${readGit}`
  useEffect(() => {
    // Agreeing again (however detection caught up: this refresh, F5, another's) rearms it for the next change (HR6's
    // #1492 round 1: .git gone a second time after a restore was never asked about).
    if (!differ) {
      asked.current = null
      return
    }
    if (asked.current === key) return
    asked.current = key
    void refreshWorkspace().catch(() => undefined)
  }, [differ, key])
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
  const status = platform === 'git' && !!s?.isRepo
  useDetectionCatchUp(project, s)
  const sectionsShown = VC_SECTIONS.filter((x) => shown.includes(x.id))
  const tabsId = useId()
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
        {/* The sections, tabs (HI-1837) folded to their icons when short of room (#1461), the status line giving way first. */}
        <Tabs idBase={tabsId} className="git-sections" label={tr(M.tabs)} value={section} onChange={(id) => showVersionControl(project.path, id)} fold reserve={status ? STATUS_ROOM : 0} items={sectionsShown.map((x) => ({ id: x.id, label: tr(x.label), icon: x.icon, attrs: { 'data-section': x.id } }))} />
        {status && s && (
          <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{gitStatusTip(s, at(s.fetchedAt))}</span>}>
            <span className="git-head-status faint">
              <Icon name="git-branch" /> {gitStatusText(s)}
            </span>
          </Tooltip>
        )}
      </div>
      <div className="git-body" role="tabpanel" id={tabIds(tabsId, section).panel} aria-labelledby={tabIds(tabsId, section).tab}>
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
