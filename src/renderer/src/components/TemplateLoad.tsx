import { useEffect, useMemo, useState } from 'react'
import { agentNameProblem, nameTaken, sameAgentName, suggestTemplateAgentName, workspaceAgentList } from '@shared/agentNames'
import { templateLoadView } from '@shared/templateLoad'
import type { TemplateScope } from '@shared/templates'
import type { TemplateLoadPlan } from '@shared/types'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { set, useStore } from '../store'
import { TemplatePlan } from './TemplatePlan'

/**
 * The Load template dialog's plan with its agents' names to choose (#702, Darren's decision of 12 Oct; #1440): beside
 * each of the template's names (made with this project's key, a reference never changed) a box for the name the agent
 * will get. A name another project's agent has, or one used twice, starts as a free one (`suggestTemplateAgentName`:
 * the other project's key swapped for this one's, else suggestAgentName's), so loading is one click; any name can be
 * edited to any free one. One another project's agent has, one used twice or an empty one is marked, saying what it
 * clashes with, and the dialog's button stays greyed out (`dialogBlocked`) until none is; this project's own agents
 * don't count, as the load replaces them. The plan (who replaces whom) is asked for again once typing pauses.
 * `onChange` hears the names the button loads.
 */
const M = {
  sameTwice: msg({ id: 'assistant.loadNames.sameTwice', defaultMessage: 'Another of its agents has this name.', description: "Load template, under a name box: another of the template's agents is given the same name." }),
  taken: msg({ id: 'assistant.loadNames.taken', defaultMessage: '{project} has an agent called {name}.', description: 'Load template, under a name box: an agent of another project has that name.' }),
  blocked: msg({ id: 'assistant.loadNames.blocked', defaultMessage: 'Agent names are unique across the workspace: change the marked names first.', description: "Load template: why its button can't be used yet." }),
  takenNote: msg({ id: 'assistant.loadNames.filledNote', defaultMessage: 'Agent names are unique across the workspace, and {projects} already {count, plural, one {has an agent} other {has agents}} called {names}: {count, plural, one {a free name is} other {free names are}} filled in below. Change any name you like.', description: "Load template, above the plan: some of the template's names are taken by other projects' agents ({projects} lists the projects, {names} the names; {count} how many), so free names were filled in for them." })
}

export function TemplateLoadNames({ path, scope, file, from, initial, onChange }: { path: string; scope: TemplateScope; file: string; from?: string; initial: TemplateLoadPlan; onChange: (names: string[]) => void }) {
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === path) ?? null)
  const projects = useStore((s) => s.workspace?.projects)
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const [plan, setPlan] = useState(initial)
  const keys = useStore((s) => s.projectKeys)
  // A name taken, or used twice, starts as a free one (#1440): loading is then one click.
  const [names, setNames] = useState(() => {
    const own = initial.create.map((a) => a.name)
    const key = keys.find((k) => k.projectPath.toLowerCase() === path.toLowerCase())?.key
    const theirs = workspaceAgentList(projects).filter((a) => a.project.toLowerCase() !== (project?.name ?? '').toLowerCase())
    const chosen: string[] = []
    for (const n of own) {
      const clash = !!nameTaken(n, theirs) || chosen.some((c) => sameAgentName(c, n))
      chosen.push(clash ? suggestTemplateAgentName(n, project?.name ?? '', key, [...theirs.map((a) => a.name), ...chosen, ...own]) : n)
    }
    return chosen
  })
  const [planError, setPlanError] = useState<string | null>(null)
  // This project's agents don't count: the load replaces them.
  const others = useMemo(() => workspaceAgentList(projects).filter((a) => a.project.toLowerCase() !== (project?.name ?? '').toLowerCase()), [projects, project])
  const problems = names.map((n, i) => {
    const why = agentNameProblem(n)
    if (why) return why
    if (names.findIndex((m) => sameAgentName(m, n)) !== i) return tr(M.sameTwice)
    const owner = nameTaken(n, others)
    return owner ? tr(M.taken, { project: owner.project, name: owner.name }) : null
  })
  // Names the plan can't be made for (empty, too long, used twice): marked here, never asked about.
  const unusable = names.some((n, i) => !!agentNameProblem(n) || names.findIndex((m) => sameAgentName(m, n)) !== i)
  const blocked = problems.some(Boolean) ? tr(M.blocked) : planError
  const key = names.join('\n')
  useEffect(() => onChange(key.split('\n')), [key, onChange])
  useEffect(() => set({ dialogBlocked: blocked }), [blocked])
  useEffect(() => () => set({ dialogBlocked: null }), [])
  useEffect(() => {
    // Names changed: a refusal of the names before them no longer holds (the plan asked for these says its own).
    setPlanError(null)
    if (key === initial.create.map((a) => a.name).join('\n')) return setPlan(initial)
    if (unusable) return
    let live = true
    const t = setTimeout(() => {
      void call('templates:plan', path, scope, file, from, key.split('\n'))
        .then((p) => live && (setPlan(p), setPlanError(null)))
        .catch((e) => live && setPlanError(errorMessage(e)))
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [key, unusable, path, scope, file, from, initial])
  if (!project) return null
  const view = templateLoadView(plan, project.config, settings, (id) => providers[id])
  return (
    <>
      {initial.taken.length > 0 && (
        <p className="template-plan-note" data-names-taken>
          {tr(M.takenNote, { projects: fmt.list([...new Set(initial.taken.map((t) => t.project))], 'unit'), count: initial.taken.length, names: fmt.list(initial.taken.map((t) => t.name), 'unit') })}
        </p>
      )}
      <TemplatePlan view={view} edit={{ from: initial.templateNames, names, problems, onName: (i, v) => setNames((x) => x.map((n, j) => (j === i ? v : n))) }} />
      {planError && <div className="field-error">{planError}</div>}
    </>
  )
}
