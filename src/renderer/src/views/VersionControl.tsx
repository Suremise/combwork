import { useEffect, useId, useRef, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import type { QueueView } from '@shared/workflow/queue'
import { merges, needsRepository } from '@shared/platform/descriptors'
import { msg, tr } from '@shared/i18n'
import { gitStatusText, gitStatusTip, VC_SECTIONS, vcSections, vcSectionShown, type GitRepoSummary } from '@shared/gitRepo'
import { get, notify, set, showVersionControl, useLanguage, useStore } from '../store'
import { loadTemplate, refreshWorkspace } from '../actions'
import { Icon, Tooltip } from '../components/ui'
import { tabIds, Tabs } from '../components/Tabs'
import { INIT_TEXT, InitRepoButton, InitRepoHost, type InitRepoEvents } from '../components/InitRepo'
import { GitQueueSection, useProjectQueues } from '../components/GitQueueSection'
import { WorkflowOptionsForm } from '../components/WorkflowOptions'
import { ChangesTab } from './ProjectTabs'
import { at, GitProblem, GitSetupNotes, HistorySection, useGitRead } from './GitTab'
import { BranchesSection } from './GitBranches'
import { switchAfterInit, switchPlatform, useWorkflowForm, VersionControlHeader } from './VersionControlHeader'
import { PresetStep } from '../components/PresetStep'
import { JjBookmarksSection, JjCompareSection, JjConflictsSection, JjHistorySection, JjOperationsSection, JjRepoSection } from './JjSections'

/**
 * The project's Version Control tab (#1416, SPEC §16.6; the Git tab before 1.0, its id still `changes`): the header
 * (VersionControlHeader.tsx), the section tablist and the section shown. Workflow comes first, then the platform's own
 * sections: for Git, Changes, History, Branches & remotes (GitBranches.tsx) and Merge queue. A None project shows
 * Workflow, and the Merge queue while an old Git ruleset's queue is still there (#1356's rule). Where its folder has no
 * repository of its own, Git can still be chosen (HI-1905): a view of Git's page, only Initialise repository…, saving
 * nothing; once the repository is made with its first commit, the project switches to Git. HI-1910: a template's Load
 * dialog opens Git's page (`vcGitPreview`) for a workflow that needs Git, and opens again once the project is Git.
 */

const NO_QUEUES: QueueView[] = []
/** The least the status line ("master · 2 ahead") keeps beside the sections before they fold to their icons (#1461). */
const STATUS_ROOM = 96

const M = {
  tabs: msg({ id: 'git.vc.sections', defaultMessage: 'Version Control', description: "Accessible name of the Version Control tab's row of sections (Workflow, Changes, History…). Glossary 2.1: Version Control (the tab)." }),
  notRepoYet: msg({ id: 'git.vc.notRepoYet', defaultMessage: "This folder isn't a Git repository yet.", description: 'Git’s page in the Version Control tab of a project whose folder has no repository, chosen before it has one: above the Initialise repository… button.' }),
  insideRepo: msg({ id: 'git.vc.insideRepo', defaultMessage: 'This folder is inside the Git repository at {root}: use that one, or give this folder its own.', description: 'Git’s page in the Version Control tab of a project inside another repository, chosen before it has its own: above the buttons Use that repository… and Initialise its own repository…. {root} is the outer repository’s folder.' }),
  noCommitYet: msg({ id: 'git.vc.noCommitYet', defaultMessage: "This folder's Git repository has no first commit yet.", description: 'Git’s page in the Version Control tab, when Initialise repository… made the repository but stopped before its first commit: above the Make first commit… button.' }),
  parentButton: msg({ id: 'git.vc.useParent', defaultMessage: 'Use that repository…', description: 'Button on Git’s page in the Version Control tab of a project inside another repository: switches the project to Git on that repository, after the warning (the … says it asks first: keep it).' }),
  initOwnHint: msg({ id: 'git.vc.initOwnHint', defaultMessage: 'Initialise its own repository… makes this folder a Git repository of its own on a branch called main, keeps its .combwork out of git and commits its files.', description: 'Git’s page in the Version Control tab of a project inside another repository, under its buttons. Initialise its own repository… is the button’s name: keep it as translated there. Keep main (the branch name).' }),
  templatePending: msg({ id: 'git.vc.templatePending', defaultMessage: 'For the template {template}: once the repository is made and this project uses Git, its Load dialog opens again.', description: 'Git’s page in the Version Control tab (HI-1910), opened from the Load template dialog because the template’s workflow needs Git. {template} is its name.' }),
  templateNotApplied: msg({ id: 'git.vc.templateNotApplied', defaultMessage: '{project} still uses None, so the Git workflow of {template} wasn’t applied. Switch the project to Git, then load the template again.', description: 'A notice (HI-1910): the repository was made from Git’s page for a template ({template}) whose workflow needs Git, but the project ({project}) wasn’t switched to Git (refused, or the warning cancelled). None and Git as Combwork names them.' }),
  initHint: msg({ id: 'git.vc.initHint', defaultMessage: 'Initialise repository… makes this folder a Git repository on a branch called main, keeps its .combwork out of git and commits its files.', description: 'Under the header of the Version Control tab of a project whose folder has no repository, beside the button. Initialise repository… is the button’s name: keep it as translated there. Keep main (the branch name).' })
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
  // A jj repository colocated with Git (HI-2799) is jj's to detect, as another system is: git reads it too.
  const differ = !!s && !s.gitProblem && !!detected && !detected.other && detected.platform !== 'jj' && readGit !== (detected.platform === 'git')
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

/**
 * Git's page before the folder has a repository of its own (HI-1905): only what makes one. Inside another repository,
 * using that one (the switch, after its warning) or making its own; a repository made with no commit yet, its first
 * commit; and the last init's failure, after its dialog has closed.
 */
function GitPreview({ project, s, error, template }: { project: ProjectInfo; s: GitRepoSummary | null; error: string | null; template: string | null }) {
  const parent = s?.parentRepo
  // A repository made by an init that stopped before its first commit: the dialog carries on from there.
  const noCommit = !!s?.isRepo && !parent && !s.head
  return (
    <div className="vc-init" data-vc-init="" data-vc-git-preview="" {...(parent ? { 'data-git-parent': '' } : {})}>
      <p className="vc-init-line">{parent ? tr(M.insideRepo, { root: parent }) : tr(noCommit ? M.noCommitYet : M.notRepoYet)}</p>
      <div className="vc-init-actions">
        {parent && (
          <button type="button" className="btn small" data-action="vc-use-parent" onClick={() => void switchPlatform(project, 'none', 'git')}>
            {tr(M.parentButton)}
          </button>
        )}
        <InitRepoButton project={project} small {...(parent ? { label: tr(INIT_TEXT.ownRepoButton) } : noCommit ? { label: tr(INIT_TEXT.firstCommitButton) } : {})} />
      </div>
      {!noCommit && <span className="hint">{tr(parent ? M.initOwnHint : M.initHint)}</span>}
      {template && (
        <div className="banner info" data-vc-template-pending="">
          <Icon name="info" /> {tr(M.templatePending, { template })}
        </div>
      )}
      {error && (
        <div className="banner danger" data-vc-init-error="">
          <Icon name="error" /> {error}
        </div>
      )}
    </div>
  )
}

export function VersionControl({ project }: { project: ProjectInfo }) {
  // Its sections' names in the window's language, again when it changes.
  useLanguage()
  const summary = useGitRead('git:summary', project)
  const s = summary.data
  const platform = project.platform?.id ?? (s?.isRepo ? 'git' : 'none')
  // The project's queues, read for themselves: an old Git ruleset's queue keeps its section (#1356's rule).
  const queues = useProjectQueues(project.path)
  const shown = vcSections(platform, queues ?? NO_QUEUES, Date.now())
  const section = vcSectionShown(useStore((st) => st.vcSection[project.path]), shown)
  // The project's workflow form, read once: the header's preset, and "How do you work?" while it asks (#1423).
  const form = useWorkflowForm(project)
  // A None folder with no repository of its own (none, or one around it): Git's page can be shown before it has one.
  const noRepo = !needsRepository(platform) && !!s && (!s.isRepo || !!s.parentRepo) && !s.gitProblem && !project.platform?.detected.other
  // Git's page shown before the repository (HI-1905): this component's alone, never saved, gone with the project or the
  // tab. It stays through an init that stopped part way (a repository with no commit yet) until the project is Git, and
  // ends once the folder has a repository of its own with a commit (made here, the switch then cancelled, or elsewhere):
  // None's page then, with Combwork's offer to switch.
  const [previewFor, setPreviewFor] = useState<string | null>(null)
  const [initError, setInitError] = useState<{ path: string; error: string } | null>(null)
  const preview = !needsRepository(platform) && previewFor === project.path && (noRepo || (!!s?.isRepo && !s.head))
  useEffect(() => {
    setPreviewFor(null)
    setInitError(null)
  }, [project.path])
  // A template waiting for this project's Git (HI-1910): its Load dialog's Set Up Git… opened Git's page here.
  const pending = useStore((st) => (st.templatePending?.path === project.path ? st.templatePending : null))
  const wantsGit = useStore((st) => st.vcGitPreview === project.path)
  useEffect(() => {
    if (!wantsGit || !s) return
    set({ vcGitPreview: null })
    if (noRepo) setPreviewFor(project.path)
  }, [wantsGit, s, noRepo, project.path])
  // Given up (None chosen): the template no longer waits. Leaving the tab keeps it waiting, said on Git's page while it
  // does (never on unmount: StrictMode mounts twice in development).
  const givenUp = (path: string): void => {
    if (get().templatePending?.path === path) set({ templatePending: null })
  }
  const onPreview = (on: boolean): void => {
    setPreviewFor(on ? project.path : null)
    setInitError(null)
    if (!on) givenUp(project.path)
  }
  /** After Initialise repository… and the switch: the waiting template's Load dialog again, or why its workflow wasn't applied. */
  const afterGit = (p: ProjectInfo, switched: boolean): void => {
    const waiting = get().templatePending
    if (!waiting || waiting.path !== p.path) return
    set({ templatePending: null })
    if (switched) void loadTemplate(p.path, waiting.entry, waiting.from)
    else notify('warning', tr(M.templateNotApplied, { project: p.name, template: waiting.entry.name }))
  }
  // The line's status (its branch, ahead and behind) where work merges between lines (Git's); jj's user integrates (HI-2799).
  const status = merges(platform) && !!s?.isRepo
  useDetectionCatchUp(project, s)
  const sectionsShown = VC_SECTIONS.filter((x) => shown.includes(x.id))
  const tabsId = useId()
  // Initialise repository… from Git's page: the project it made a repository of switches to Git; a failure stays shown.
  const initEvents: InitRepoEvents = preview
    ? {
        onInitialised: (p) => {
          setPreviewFor(null)
          void switchAfterInit(p).then((switched) => afterGit(p, switched))
        },
        onFailed: (error) => setInitError({ path: project.path, error })
      }
    : {}
  return (
    <div className="git-view vc-view" data-platform={platform}>
      <VersionControlHeader project={project} platform={platform} form={form} preview={preview} {...(noRepo || preview ? { onPreview } : {})} />
      {preview ? <GitPreview project={project} s={s} error={initError?.path === project.path ? initError.error : null} template={pending?.entry.name ?? null} /> : <PresetStep project={project} platform={platform} form={form} />}
      {!preview && (
        <>
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
            ) : section === 'jjRepo' ? (
              <JjRepoSection project={project} />
            ) : section === 'jjHistory' ? (
              <JjHistorySection project={project} />
            ) : section === 'jjCompare' ? (
              <JjCompareSection project={project} />
            ) : section === 'jjBookmarks' ? (
              <JjBookmarksSection project={project} />
            ) : section === 'jjConflicts' ? (
              <JjConflictsSection project={project} />
            ) : section === 'jjOperations' ? (
              <JjOperationsSection project={project} />
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
        </>
      )}
      <InitRepoHost project={project} {...initEvents} />
    </div>
  )
}
