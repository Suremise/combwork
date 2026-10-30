import { useEffect, useMemo, useState } from 'react'
import { agentNameProblem, nameTaken, sameAgentName, suggestTemplateAgentName, workspaceAgentList } from '@shared/agentNames'
import { templateLoadView } from '@shared/templateLoad'
import type { TemplateScope } from '@shared/templates'
import type { TemplateLoadPlan } from '@shared/types'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { set, useStore } from '../store'
import { TemplatePlan } from './TemplatePlan'
import { ConnectionsSection } from './TemplateConnections'
import { answerFor, initialPicker, loadFallback, pickerAnswers, type ConnectionAnswers, type PickerState } from '@shared/templateConnections'
import { TemplateLoadWorkflowPart, workflowBlocks } from './TemplateLoadWorkflow'
import { useAgentLimit } from '../advanced'
import { OPEN_WORKFLOW_OPTIONS } from '@shared/defaults'
import { loadedMaxAgents } from '@shared/workflow/templateOptions'

/**
 * The Load template dialog's plan with its agents' names to choose (#702, Darren's decision of 12 Oct; #1440): beside
 * each of the template's names (made with this project's key, a reference never changed) a box for the name the agent
 * will get. A name another project's agent has, or one used twice, starts as a free one (`suggestTemplateAgentName`:
 * the other project's key swapped for this one's, else suggestAgentName's), so loading is one click; any name can be
 * edited to any free one. One another project's agent has, one used twice or an empty one is marked, saying what it
 * clashes with, and the dialog's button stays greyed out (`dialogBlocked`) until none is; this project's own agents
 * don't count, as the load replaces them. The plan (who replaces whom) is asked for again once typing pauses.
 * `onChange` hears the names the button loads. HI-2109: under the plan, the Connections section (TemplateConnections.tsx)
 * choosing what each agent runs on, the table following it; `onConnections` hears its answers, by the names chosen.
 * HI-1910: under it, the template's workflow (TemplateLoadWorkflow.tsx): `onWorkflow` hears whether to apply it; a
 * Git-only one, ticked in a project with no version control, holds the button.
 */
const M = {
  sameTwice: msg({ id: 'assistant.loadNames.sameTwice', defaultMessage: 'Another of its agents has this name.', description: "Load template, under a name box: another of the template's agents is given the same name." }),
  taken: msg({ id: 'assistant.loadNames.taken', defaultMessage: '{project} has an agent called {name}.', description: 'Load template, under a name box: an agent of another project has that name.' }),
  blocked: msg({ id: 'assistant.loadNames.blocked', defaultMessage: 'Agent names are unique across the workspace: change the marked names first.', description: "Load template: why its button can't be used yet." }),
  savesMax: msg({ id: 'assistant.loadNames.savesMax', defaultMessage: 'Maximum agents goes from {now, number} to {next, number} for this project, saved with its agents.', description: "Load template (HI-2058), with its workflow applied: the template's own Maximum agents ({next}) is saved with its agents, in place of the project's ({now}). Maximum agents is a name in the window: as translated there." }),
  overMax: msg({ id: 'assistant.loadNames.overMax', defaultMessage: 'It has {count, number} agents, and this project’s workflow allows {max, plural, one {# agent} other {# agents}}: raise Maximum agents first, or load it with its workflow.', description: "Load template (HI-2058), why its button can't be used: the template's agents ({count}) are more than the project's Maximum agents ({max}), and its workflow, which would raise it, isn't applied. Maximum agents is a name in the window: as translated there." }),
  takenNote: msg({ id: 'assistant.loadNames.filledNote', defaultMessage: 'Agent names are unique across the workspace, and {count, plural, one {this name is} other {these names are}} taken already: {names} (projects: {projects}). {count, plural, one {A free name is} other {Free names are}} filled in below. Change any name you like.', description: "Load template, above the plan: some of the template's names are taken by other projects' agents ({projects} lists the projects, {names} the names; {count} how many), so free names were filled in for them. Each sentence whole, the verb never agreeing with a list (HI-1585: glossary §1 rules 3 and 4)." })
}

export function TemplateLoadNames({ path, scope, file, from, initial, onChange, onConnections, onWorkflow, onOpenWorkflow, onSetUpGit, onPlan }: { path: string; scope: TemplateScope; file: string; from?: string; initial: TemplateLoadPlan; onChange: (names: string[]) => void; onConnections?: (answers: ConnectionAnswers) => void; onWorkflow?: (apply: boolean) => void; onOpenWorkflow?: () => void; onSetUpGit?: () => void; onPlan?: (plan: TemplateLoadPlan) => void }) {
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === path) ?? null)
  const projects = useStore((s) => s.workspace?.projects)
  const [plan, setPlan] = useState(initial)
  // The plan shown now (HR5's HI-1910 round 1): its workflow is the one the load is checked against.
  useEffect(() => onPlan?.(plan), [plan, onPlan])
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
  // The connections (HI-2109): each role's preselected (the first on the CLI it suggests, else the first usable), changed
  // in the Connections section; the load takes its answers, each agent's by its name in the template (its key).
  const [picker, setPicker] = useState<PickerState>(() => initialPicker(initial.create, initial.options))
  const picked = names.map((n, i) => ({ key: initial.templateNames[i] ?? '', name: n, role: initial.create[i]?.role ?? 'generalist', provider: initial.create[i]?.provider }))
  const answers = pickerAnswers(picker, picked)
  const answersKey = JSON.stringify(answers)
  useEffect(() => onConnections?.(JSON.parse(answersKey) as ConnectionAnswers), [answersKey, onConnections])
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
  // Its workflow applied, unless unticked (HI-1910).
  const [apply, setApply] = useState(true)
  useEffect(() => onWorkflow?.(apply), [apply, onWorkflow])
  // Maximum agents (HI-2058, Darren's decisions): its workflow applied, the template's own is saved with its agents (main
  // works it out again under the project's lock); without it, more agents than the project's maximum can't be loaded.
  const now = useAgentLimit(project)
  const section = apply ? (plan.workflow?.section ?? null) : null
  const saves = section ? loadedMaxAgents(section.options.maxAgents, plan.create.length, now) : null
  const over = !section && plan.create.length > now ? tr(M.overMax, { count: plan.create.length, max: now }) : null
  const blocked = problems.some(Boolean) ? tr(M.blocked) : (planError ?? workflowBlocks(plan.workflow, apply) ?? over)
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
  // Each agent on the connection the section gives it now, as the load will.
  const refs = answerFor(picked, answers, loadFallback(picked, plan.options))
  const shown = templateLoadView(plan, (i) => plan.options.find((o) => o.id === refs[i]) ?? null)
  // Each agent's partner by the name in its box (#1440, the Assistant's screenshots): "with AP-R1" follows the edits,
  // as the load pairs them (by place) under the names chosen.
  const partnerOf = (i: number): number | undefined => {
    const p = plan.pairs?.find((x) => x.builder === i || x.reviewer === i)
    return p ? (p.builder === i ? p.reviewer : p.builder) : undefined
  }
  const view = { ...shown, created: shown.created.map((a, i) => { const o = partnerOf(i); return o !== undefined && names[o] ? { ...a, pairedWith: names[o] } : a }) }
  return (
    <>
      {initial.taken.length > 0 && (
        <p className="template-plan-note" data-names-taken>
          {tr(M.takenNote, { projects: fmt.list([...new Set(initial.taken.map((t) => t.project))], 'unit'), count: initial.taken.length, names: fmt.list(initial.taken.map((t) => t.name), 'unit') })}
        </p>
      )}
      <TemplatePlan view={view} edit={{ from: initial.templateNames, names, problems, onName: (i, v) => setNames((x) => x.map((n, j) => (j === i ? v : n))) }} />
      {planError && <div className="field-error">{planError}</div>}
      <ConnectionsSection agents={picked} options={plan.options} state={picker} onState={setPicker} />
      {plan.workflow && <TemplateLoadWorkflowPart workflow={plan.workflow} apply={apply} onApply={setApply} onSetUpGit={() => onSetUpGit?.()} />}
      {saves !== null && saves !== now && (
        <p className="template-plan-note" data-saves-max={saves}>
          {tr(M.savesMax, { now, next: saves })}
        </p>
      )}
      {over && (
        <div className="banner warn" data-over-max="">
          <span>{over}</span>{' '}
          <button className="btn small" onClick={() => onOpenWorkflow?.()}>
            {tr(OPEN_WORKFLOW_OPTIONS)}
          </button>
        </div>
      )}
    </>
  )
}
