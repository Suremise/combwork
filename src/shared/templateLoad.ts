// What the Load template dialog says before a template replaces a project's agents (#126, #268): who goes (marking those
// a new agent of the same name replaces), who comes with their role in the workflow, pairing and the connection each is
// given (HI-2109: a template keeps none; the picker chooses them), and what happens to the removed agents.
import type { AppSettings, ProviderId, TemplateLoadPlan } from './types'
import { WORKFLOW_ROLE_TEXT, type WorkflowRole } from './workflow/roles'
import { effortLabel } from './defaults'
import { isKnownProvider, permissionLabel, providerName } from './providers'
import { tr } from './i18n'
import { msg } from './i18n/msg'
import type { ConnectionOption } from './templateConnections'

const M = {
  kept: msg({ id: 'assistant.templateLoad.oldKept', defaultMessage: 'its worktree and branch {branch} stay{hasWhy, select, yes {: {why}} other {}}', description: "Load template, beside an agent that goes: its worktree is kept. {why} says why (\"2 commits not merged into main\"). Lower case: it follows the agent's name in brackets." }),
  afterLoad: msg({ id: 'assistant.templateLoad.afterLoad', defaultMessage: "{removed, select, yes {Their conversations stay in the Sessions tab, and their open cards go back (Active ones to Todo). The layout becomes the template's.} other {The layout becomes the template's.}}", description: "Load template, the last note: what happens to the agents that go (when some do) and to the project's layout. Sessions, Active and Todo as Hive names them." }),
  removedHeading: msg({ id: 'assistant.templateLoad.removedHeading', defaultMessage: 'Removed:', description: "Load template's confirmation, as text: the heading over the agents that go." }),
  createdHeading: msg({ id: 'assistant.templateLoad.createdHeading', defaultMessage: 'Created:', description: "Load template's confirmation, as text: the heading over the template's agents." }),
  removedLine: msg({ id: 'assistant.templateLoad.removedLine', defaultMessage: '{name}{hasNote, select, yes { ({note})} other {}}{replaced, select, yes {: replaced by a new agent with the same name} other {}}', description: "Load template's confirmation, as text: an agent that goes, after a bullet. {note} is what happens to its worktree." }),
  createdLine: msg({ id: 'assistant.templateLoad.createdOn', defaultMessage: '{name}{hasRole, select, yes { — {role}} other {}}{replaces, select, yes { (new)} other {}}: {connection}', description: "Load template's confirmation, as text (HI-2109): an agent the template brings, after a bullet: its role, (new) when it replaces an agent of the same name, and the connection it is given ({connection}: its name and what it runs, \"Claude · High (Opus · High · Auto)\")." }),
  connectionLine: msg({ id: 'assistant.templateLoad.connectionLine', defaultMessage: '{name} ({values})', description: "A connection (HI-2109) with what it runs, in brackets: {name} is its name (\"Claude · High\"), {values} its model, effort and mode (\"Opus · High · Auto\"). Japanese and Chinese: full-width brackets, no space before them." }),
  cliDefaults: msg({ id: 'assistant.templateLoad.cliDefaults', defaultMessage: '{cli} defaults', description: "What a connection runs (HI-2109) when it sets no model, effort or mode of its own: its coding agent CLI's ({cli}: \"Claude Code\") defaults." }),
  noConnection: msg({ id: 'assistant.templateLoad.noConnection', defaultMessage: 'no connection', description: "Load template's confirmation (HI-2109), in place of an agent's connection: none can run it here. Lower case." }),
  pairedWith: msg({ id: 'assistant.templateLoad.pairedWith', defaultMessage: 'paired: {name}', description: "Load template, under an agent's role: the agent it is paired with ({name}): a builder's reviewer, or a reviewer's builder. Lower case. The name after a colon (glossary §1 rule 4)." }),
  roleLine: msg({ id: 'assistant.templateLoad.roleLine', defaultMessage: '{role}{paired, select, yes { (paired: {name})} other {}}', description: "Load template's confirmation, as text: an agent's role in the workflow ({role}: Builder, Reviewer, Either) and the agent it is paired with ({name}). The name after a colon (glossary §1 rule 4)." })
}

const yesNo = (b: unknown): 'yes' | 'no' => (b ? 'yes' : 'no')

/**
 * What a connection runs, in short (HI-2109): its model, effort, mode and 200K context as it sets them ("opus · High ·
 * Auto"), or its CLI's defaults when it sets none. Worked out from the values, never read back from a label.
 */
export function connectionValues(o: ConnectionOption, settings: Pick<AppSettings, 'providers'> | null = null): string {
  const parts = [o.model, o.effort ? effortLabel(o.cli, o.effort, undefined, undefined, null, settings) : null, o.permissionMode ? permissionLabel(o.cli, o.permissionMode, tr) : null, o.use200kContext ? '200K' : null].filter((x): x is string => !!x) // i18n-ignore: 200K is a token count's short form, as the settings name it
  return parts.length ? parts.join(' · ') : tr(M.cliDefaults, { cli: isKnownProvider(o.cli) ? providerName(o.cli) : o.cli })
}

/** A connection with what it runs ("Claude · High (opus · High · Auto)"). */
export const connectionShown = (o: ConnectionOption, settings: Pick<AppSettings, 'providers'> | null = null): string => tr(M.connectionLine, { name: o.name, values: connectionValues(o, settings) })

type PlanIn = Pick<TemplateLoadPlan, 'remove' | 'create'> & Partial<Pick<TemplateLoadPlan, 'pairs'>>

/** The Load template dialog's plan (#511, as a table): who goes and what happens to their worktrees, who comes on which connection, and the notes after. */
export interface TemplateLoadView {
  removed: { name: string; note: string; replaced: boolean }[]
  created: { name: string; role: WorkflowRole; note?: string; pairedWith?: string; replaces: boolean; suggested?: ProviderId; connection: ConnectionOption | null }[]
  notes: string[]
}

/** The plan as the dialog shows it, each created agent on the connection the picker gives it now (`connectionAt`, by its place). */
export function templateLoadView(plan: PlanIn, connectionAt: (index: number) => ConnectionOption | null): TemplateLoadView {
  const coming = new Set(plan.create.map((a) => a.name.toLowerCase()))
  const replaced = new Set(plan.remove.filter((a) => coming.has(a.name.toLowerCase())).map((a) => a.name.toLowerCase()))
  // A removed agent's worktree and branch stay (#1436: a template's agents work in the project folder, never in one).
  const old = (a: TemplateLoadPlan['remove'][number]): string => (a.worktree ? tr(M.kept, { branch: a.worktree.branch, hasWhy: 'no', why: '' }) : '')
  const removed = plan.remove.map((a) => ({ name: a.name, note: old(a), replaced: replaced.has(a.name.toLowerCase()) }))
  const partner = (i: number): string | undefined => {
    const p = plan.pairs?.find((x) => x.builder === i || x.reviewer === i)
    return p ? plan.create[p.builder === i ? p.reviewer : p.builder]?.name : undefined
  }
  const created = plan.create.map((a, i) => {
    const pairedWith = partner(i)
    return {
      name: a.name,
      role: a.role,
      ...(a.note ? { note: a.note } : {}),
      ...(pairedWith ? { pairedWith } : {}),
      replaces: replaced.has(a.name.toLowerCase()),
      ...(a.provider ? { suggested: a.provider } : {}),
      connection: connectionAt(i)
    }
  })
  return { removed, created, notes: [tr(M.afterLoad, { removed: yesNo(plan.remove.length) })] }
}

/** An agent's role in the workflow and, paired, its partner, in words ("Builder, with HI-R1"). */
export const roleShown = (a: { role: WorkflowRole; pairedWith?: string }): string => tr(M.roleLine, { role: tr(WORKFLOW_ROLE_TEXT[a.role].name), paired: yesNo(a.pairedWith), name: a.pairedWith ?? '' })

/** "with HI-R1": the agent it is paired with, under its role in the dialog's table. */
export const pairedShown = (name: string): string => tr(M.pairedWith, { name })

/** The dialog's detail as text: Removed and Created (each on its connection), and what happens to the removed agents. */
export function templateLoadDetail(plan: PlanIn, connectionAt: (index: number) => ConnectionOption | null, settings: Pick<AppSettings, 'providers'> | null = null): string {
  const v = templateLoadView(plan, connectionAt)
  const lines: string[] = []
  if (v.removed.length) {
    lines.push(tr(M.removedHeading))
    for (const a of v.removed) lines.push(`• ${tr(M.removedLine, { name: a.name, hasNote: yesNo(a.note), note: a.note, replaced: yesNo(a.replaced) })}`)
    lines.push('')
  }
  lines.push(tr(M.createdHeading))
  for (const a of v.created) lines.push(`• ${tr(M.createdLine, { name: a.name, hasRole: 'yes', role: roleShown(a), replaces: yesNo(a.replaces), connection: a.connection ? connectionShown(a.connection, settings) : tr(M.noConnection) })}`)
  lines.push('')
  lines.push(...v.notes)
  return lines.join('\n')
}
