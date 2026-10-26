import { useEffect, useState } from 'react'
import type { ProjectInfo, ProjectStages, WorkflowForm } from '@shared/types'
import { msg, tr } from '@shared/i18n'
import { PRESET_TEXT } from '@shared/workflow/optionTexts'
import { call } from '../api'
import { NO_PROJECTS, showVersionControl, useLanguage, useStore } from '../store'
import type { BoardProject } from '../boardStages'
import { M as VC_TEXT, PLATFORM_TEXT, presetState } from '../views/VersionControlHeader'
import { Icon, Tooltip, useContextMenu } from './ui'

/**
 * The board's link to each shown project's workflow (#1420): "Workflow: Git · Team" for the project shown, a line per
 * project in a menu with several; each opens its Version Control tab at Workflow. And the shown projects' stages
 * (`workflow:stages`), read again when a project's workflow is written (`workflow-changed`).
 */

/** The projects the board shows: one, or every project of the workspace. */
function useShown(project: string | null): ProjectInfo[] {
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  return project === null ? projects : projects.filter((p) => p.name.toLowerCase() === project.toLowerCase())
}

/** What was last read for each project (by its path, lower case), kept while the board is closed: opened again, it
 *  draws with them at once, and the new read replaces them (HI-1682: read only after the first paint, the Merging
 *  column and the Approved group's heading came late, moving every column). */
const STAGES = new Map<string, ProjectStages | null>()
const FORMS = new Map<string, WorkflowForm>()

/**
 * Something read for each shown project by its path, again when a workflow is written or the projects change, starting
 * from what `cache` kept from the last read. known: every shown project has a value, read now or kept (one whose read
 * failed counts once it was tried).
 */
function usePerProject<T>(project: string | null, cache: Map<string, T>, read: (path: string) => Promise<T>): { values: Map<string, T>; known: boolean } {
  const shown = useShown(project)
  const version = useStore((s) => s.workflowVersion)
  const key = shown.map((p) => `${p.path}|${JSON.stringify(p.config.workflow ?? null)}|${p.platform?.id ?? ''}`).join('\n')
  const [read_, setRead] = useState<{ key: string; values: Map<string, T> } | null>(null)
  useEffect(() => {
    let live = true
    void Promise.all(shown.map((p) => read(p.path).then((v) => [p.path.toLowerCase(), v] as const, () => null))).then((all) => {
      if (!live) return
      const values = new Map(all.filter((x): x is readonly [string, Awaited<T>] => !!x))
      for (const [path, v] of values) cache.set(path, v)
      setRead({ key, values })
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])
  if (read_?.key === key) return { values: read_.values, known: true }
  // Every read is kept too, so what is kept stands in for an older read as well.
  const kept = new Map<string, T>()
  for (const p of shown) {
    const path = p.path.toLowerCase()
    if (cache.has(path)) kept.set(path, cache.get(path) as T)
  }
  return { values: kept, known: kept.size === shown.length }
}

/**
 * The shown projects with their stages, for the board's columns; null until they are known (read, or kept from the
 * board's last open), so the board never draws a default set of columns that the workflow then changes (HI-1682).
 */
export function useBoardProjects(project: string | null): BoardProject[] | null {
  const shown = useShown(project)
  const { values, known } = usePerProject<ProjectStages | null>(project, STAGES, (path) => call('workflow:stages', path))
  if (!known) return null
  return shown.map((p) => ({ name: p.name, stages: values.get(p.path.toLowerCase()) ?? null }))
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
  const forms = usePerProject<WorkflowForm>(project, FORMS, (path) => call('workflow:form', path)).values
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
