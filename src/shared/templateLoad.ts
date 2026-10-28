// What the Load template dialog says before a template replaces a project's agents (#126, #268): who goes (marking those
// a new agent of the same name replaces), who comes with their role in the workflow, pairing and settings in short
// (#1436: every one in the project folder; one of Hive's own templates' agents on another provider says so), and what
// happens to the removed agents.
import type { AppSettings, ProjectConfig, ProviderId, TemplateLoadPlan } from './types'
import type { TemplateAgent } from './templates'
import { WORKFLOW_ROLE_TEXT, type WorkflowRole } from './workflow/roles'
import { agentModelShown, effortLabel } from './defaults'
import { modelCaps, type ModelInfo } from './models'
import { agentLaunchSettings, permissionLabel, projectProviderConfig, providerName, providerSettings } from './providers'
import { tr } from './i18n'
import { msg } from './i18n/msg'

const M = {
  isDefault: msg({ id: 'assistant.templateLoad.isDefault', defaultMessage: '{setting} (default)', description: "A new agent's model, effort or mode that the template leaves to the project's or Hive's defaults: {setting} is what it comes to here (\"Opus 5.5\", \"High\")." }),
  kept: msg({ id: 'assistant.templateLoad.oldKept', defaultMessage: 'its worktree and branch {branch} stay{hasWhy, select, yes {: {why}} other {}}', description: "Load template, beside an agent that goes: its worktree is kept. {why} says why (\"2 commits not merged into main\"). Lower case: it follows the agent's name in brackets." }),
  afterLoad: msg({ id: 'assistant.templateLoad.afterLoad', defaultMessage: "{removed, select, yes {Their conversations stay in the Sessions tab, and their open cards go back (Active ones to Todo). The layout becomes the template's.} other {The layout becomes the template's.}}", description: "Load template, the last note: what happens to the agents that go (when some do) and to the project's layout. Sessions, Active and Todo as Hive names them." }),
  removedHeading: msg({ id: 'assistant.templateLoad.removedHeading', defaultMessage: 'Removed:', description: "Load template's confirmation, as text: the heading over the agents that go." }),
  createdHeading: msg({ id: 'assistant.templateLoad.createdHeading', defaultMessage: 'Created:', description: "Load template's confirmation, as text: the heading over the template's agents." }),
  removedLine: msg({ id: 'assistant.templateLoad.removedLine', defaultMessage: '{name}{hasNote, select, yes { ({note})} other {}}{replaced, select, yes {: replaced by a new agent with the same name} other {}}', description: "Load template's confirmation, as text: an agent that goes, after a bullet. {note} is what happens to its worktree." }),
  createdLine: msg({ id: 'assistant.templateLoad.createdLine', defaultMessage: '{name}{hasRole, select, yes { — {role}} other {}}{replaces, select, yes { (new)} other {}}: {provider}, {settings}', description: "Load template's confirmation, as text: an agent the template brings, after a bullet: its role, (new) when it replaces an agent of the same name, its coding agent ({provider}) and its model · effort · mode ({settings})." }),
  swapped: msg({ id: 'assistant.templateLoad.swapped', defaultMessage: '{problem, select, off {{from} is turned off (Settings → Providers): {to} instead.} other {{from} isn’t installed: {to} instead.}}', description: "Load template, on the row of an agent of one of Hive's own templates: the coding agent the template gives it ({from}, \"Codex\") can't run here, so it gets another ({to}, \"Claude Code\"). {problem} is why: off (turned off in Settings → Providers) or not installed." }),
  pairedWith: msg({ id: 'assistant.templateLoad.pairedWith', defaultMessage: 'paired: {name}', description: "Load template, under an agent's role: the agent it is paired with ({name}): a builder's reviewer, or a reviewer's builder. Lower case. The name after a colon (glossary §1 rule 4)." }),
  roleLine: msg({ id: 'assistant.templateLoad.roleLine', defaultMessage: '{role}{paired, select, yes { (paired: {name})} other {}}', description: "Load template's confirmation, as text: an agent's role in the workflow ({role}: Builder, Reviewer, Either) and the agent it is paired with ({name}). The name after a colon (glossary §1 rule 4)." })
}

/** A created agent's setting as the dialog shows it: what it resolves to here, and whether the template left it to the defaults. */
export interface SettingShown {
  text: string
  isDefault: boolean
}

const yesNo = (b: unknown): 'yes' | 'no' => (b ? 'yes' : 'no')

/**
 * A created agent's settings, as its footer will show them: model, effort and mode. What the template leaves to the
 * project or Hive's defaults is shown as what it resolves to here, marked as the default. Each is worked out from the
 * values, never read back from a label: labels are in the window's language.
 */
export function templateAgentParts(a: TemplateAgent, cfg: Pick<ProjectConfig, 'providers' | 'defaultProvider'>, settings: AppSettings | null, info: ModelInfo): { model: SettingShown; effort: SettingShown | null; mode: SettingShown | null } {
  const provider = a.provider
  const pc = projectProviderConfig(cfg, provider)
  const ps = providerSettings(settings, provider)
  const own = (v: string | undefined): v is string => !!v && v !== 'inherit'
  // What it resolves to here; marked the default whenever the template leaves it to the project or Hive, the project's own
  // choice included (#310), as its effort and mode are.
  const runModel = (own(a.model) ? a.model : own(pc.model) ? pc.model : ps.defaultModel) || info?.defaultModel || ''
  // Nothing says which model: the CLI's own default ("Claude Code default"), which is one already and isn't marked again.
  const model = { text: agentModelShown(provider, runModel || undefined, '', info).label, isDefault: !own(a.model) && !!runModel }
  const chosenEffort = a.effort ?? pc.effort
  const effortValue = (chosenEffort && chosenEffort !== 'inherit' ? chosenEffort : ps.defaultEffort) || modelCaps(provider, runModel || null, info, settings).defaultEffort
  const effortText = effortValue ? effortLabel(provider, effortValue, undefined, undefined, null, settings) : null
  const effort = effortText ? { text: effortText, isDefault: !own(a.effort) } : null
  const modeText = settings ? permissionLabel(provider, agentLaunchSettings({ provider, model: a.model, effort: a.effort, permissionMode: a.permissionMode, use200kContext: a.use200kContext }, cfg, settings).permissionMode, tr) : null
  const mode = modeText ? { text: modeText, isDefault: !own(a.permissionMode) } : null
  return { model, effort, mode }
}

const shownText = (s: SettingShown): string => (s.isDefault ? tr(M.isDefault, { setting: s.text }) : s.text)

/** A created agent's settings in short, as its footer will show them: model · effort · mode ("Opus 5.5 · High · Auto"), defaults marked "(default)". */
export function templateAgentSettings(a: TemplateAgent, cfg: Pick<ProjectConfig, 'providers' | 'defaultProvider'>, settings: AppSettings | null, info: ModelInfo): string {
  const { model, effort, mode } = templateAgentParts(a, cfg, settings, info)
  return [model, effort, mode].filter((x): x is SettingShown => !!x).map(shownText).join(' · ')
}

type PlanIn = Pick<TemplateLoadPlan, 'remove' | 'create'> & Partial<Pick<TemplateLoadPlan, 'pairs' | 'swaps'>>

/** The Load template dialog's plan (#511, as a table): who goes and what happens to their worktrees, who comes, and the notes after. */
export interface TemplateLoadView {
  removed: { name: string; note: string; replaced: boolean }[]
  created: { name: string; role: WorkflowRole; note?: string; pairedWith?: string; swapped?: string; replaces: boolean; provider: ProviderId; providerName: string; model: SettingShown; effort: SettingShown | null; mode: SettingShown | null }[]
  notes: string[]
}

export function templateLoadView(plan: PlanIn, cfg: Pick<ProjectConfig, 'providers' | 'defaultProvider'>, settings: AppSettings | null, info: (p: ProviderId) => ModelInfo): TemplateLoadView {
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
    const swap = plan.swaps?.find((w) => w.index === i)
    const pairedWith = partner(i)
    return {
      name: a.name,
      role: a.role,
      ...(a.note ? { note: a.note } : {}),
      ...(pairedWith ? { pairedWith } : {}),
      ...(swap ? { swapped: tr(M.swapped, { problem: swap.problem, from: providerName(swap.from), to: providerName(swap.to) }) } : {}),
      replaces: replaced.has(a.name.toLowerCase()),
      provider: a.provider,
      providerName: providerName(a.provider),
      ...templateAgentParts(a, cfg, settings, info(a.provider))
    }
  })
  return { removed, created, notes: [tr(M.afterLoad, { removed: yesNo(plan.remove.length) })] }
}

/** An agent's role in the workflow and, paired, its partner, in words ("Builder, with HI-R1"). */
export const roleShown = (a: { role: WorkflowRole; pairedWith?: string }): string => tr(M.roleLine, { role: tr(WORKFLOW_ROLE_TEXT[a.role].name), paired: yesNo(a.pairedWith), name: a.pairedWith ?? '' })

/** "with HI-R1": the agent it is paired with, under its role in the dialog's table. */
export const pairedShown = (name: string): string => tr(M.pairedWith, { name })

/** The dialog's detail as text: Removed and Created, the setup command, and what happens to the removed agents. */
export function templateLoadDetail(plan: PlanIn, cfg: Pick<ProjectConfig, 'providers' | 'defaultProvider'>, settings: AppSettings | null, info: (p: ProviderId) => ModelInfo): string {
  const v = templateLoadView(plan, cfg, settings, info)
  const lines: string[] = []
  if (v.removed.length) {
    lines.push(tr(M.removedHeading))
    for (const a of v.removed) lines.push(`• ${tr(M.removedLine, { name: a.name, hasNote: yesNo(a.note), note: a.note, replaced: yesNo(a.replaced) })}`)
    lines.push('')
  }
  lines.push(tr(M.createdHeading))
  for (const a of v.created) {
    const settingsText = [a.model, a.effort, a.mode].filter((x): x is SettingShown => !!x).map(shownText).join(' · ')
    lines.push(`• ${tr(M.createdLine, { name: a.name, hasRole: 'yes', role: roleShown(a), replaces: yesNo(a.replaces), provider: a.providerName, settings: settingsText })}`)
    if (a.swapped) lines.push(`    ${a.swapped}`)
  }
  lines.push('')
  lines.push(...v.notes)
  return lines.join('\n')
}
