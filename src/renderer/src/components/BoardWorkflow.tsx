import { useEffect, useRef, useState } from 'react'
import type { ProjectInfo, WorkflowForm } from '@shared/types'
import { msg, tr } from '@shared/i18n'
import { PRESET_TEXT } from '@shared/workflow/optionTexts'
import { call } from '../api'
import { boardStagesFor, loadTasks, NO_PROJECTS, showVersionControl, useLanguage, useStore } from '../store'
import type { BoardProject } from '../boardStages'
import { M as VC_TEXT, PLATFORM_TEXT, presetState } from '../views/VersionControlHeader'
import { Icon, Tooltip, useContextMenu } from './ui'

/**
 * The board's link to each shown project's workflow (#1420): "Workflow: Git · Team" for the project shown, a line per
 * project in a menu with several; each opens its Version Control tab at Workflow. And the shown projects' stages, for
 * the board's columns (`board:stages`, read with the board's cards).
 */

/** The projects the board shows: one, or every project of the workspace. */
function useShown(project: string | null): ProjectInfo[] {
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  return project === null ? projects : projects.filter((p) => p.name.toLowerCase() === project.toLowerCase())
}

/** Something read for each shown project by its path, again when a workflow is written or the projects change. */
function usePerProject<T>(project: string | null, read: (path: string) => Promise<T>): Map<string, T> {
  const shown = useShown(project)
  const version = useStore((s) => s.workflowVersion)
  const key = shown.map((p) => `${p.path}|${JSON.stringify(p.config.workflow ?? null)}|${p.platform?.id ?? ''}`).join('\n')
  const [read_, setRead] = useState<{ key: string; values: Map<string, T> } | null>(null)
  useEffect(() => {
    let live = true
    void Promise.all(shown.map((p) => read(p.path).then((v) => [p.path.toLowerCase(), v] as const, () => null))).then((all) => {
      if (live) setRead({ key, values: new Map(all.filter((x): x is readonly [string, Awaited<T>] => !!x)) })
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])
  return read_?.values ?? new Map()
}

/**
 * The shown projects with their stages, for the board's columns: from the board's own read (`board:stages`, read with
 * its cards), so its columns are right in its first paint, never added after it (HI-1682). Null until that read is
 * there, and when the board opens on stages read for an older workflow or projects (read again meanwhile): it never
 * draws a set of columns the workflow then changes. Once drawn, a change of the workflow changes them once, when read.
 */
export function useBoardProjects(project: string | null): BoardProject[] | null {
  const shown = useShown(project)
  const stages = useStore((s) => s.boardStages)
  const current = useStore(boardStagesFor)
  const drawn = useRef(false)
  const fresh = stages?.for === current
  useEffect(() => {
    if (!fresh) void loadTasks()
  }, [fresh, current])
  if (!stages || (!fresh && !drawn.current)) return null
  drawn.current = true
  return shown.map((p) => ({ name: p.name, stages: stages.byPath[p.path.toLowerCase()] ?? null }))
}

/** "Workflow: Git · Team" for a project, as its Version Control tab says it. */
function workflowText(f: WorkflowForm): string {
  const p = presetState(f)
  return tr(VC_TEXT.workflow, { platform: tr(PLATFORM_TEXT[f.platform]), state: p.state, preset: p.preset ? tr(PRESET_TEXT[p.preset]) : '' })
}

const WORKFLOWS = msg({ id: 'board.workflows', defaultMessage: 'Workflows', description: "A button in the board's toolbar when it shows several projects: opens a list of each project's workflow (glossary 2.1: workflow), each opening that project's Version Control tab." })

/** The board toolbar's workflow link: the project shown, or a menu of them all. */
export function BoardWorkflowLink({ project }: { project: string | null }) {
  useLanguage()
  const shown = useShown(project).filter((p) => p.platform)
  const forms = usePerProject<WorkflowForm>(project, (path) => call('workflow:form', path))
  const menu = useContextMenu()
  if (!shown.length) return null
  const open = (p: ProjectInfo): void => showVersionControl(p.path, 'workflow')
  if (shown.length === 1) {
    const f = forms.get(shown[0].path.toLowerCase())
    if (!f) return null
    return (
      <Tooltip
        content={
          <>
            <strong>{workflowText(f)}</strong>
            <div>{tr(VC_TEXT.workflowTip)}</div>
          </>
        }
      >
        <button type="button" className="link board-workflow" data-action="board-workflow" onClick={() => open(shown[0])}>
          <Icon name="git-pull-request" /> {workflowText(f)}
        </button>
      </Tooltip>
    )
  }
  return (
    <>
      <button
        type="button"
        className="btn subtle board-workflow"
        data-action="board-workflows"
        onClick={(e) => {
          const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
          menu.openAt(
            b.left,
            b.bottom,
            shown.map((p) => {
              const f = forms.get(p.path.toLowerCase())
              return { label: f ? `${p.name} · ${workflowText(f)}` : p.name, icon: 'git-pull-request', onClick: () => open(p) } // i18n-ignore: a project's name beside its workflow line (a message)
            })
          )
        }}
      >
        <Icon name="git-pull-request" /> {tr(WORKFLOWS)}
      </button>
      {menu.element}
    </>
  )
}
