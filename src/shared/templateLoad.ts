// What the Load template dialog says before a template replaces a project's agents (#126, #268): who goes (marking those
// a new agent of the same name replaces), who comes with their settings in short and, for a new worktree, its branch and
// folder in this project, the setup command those worktrees run, and what happens to the removed agents.
import type { AppSettings, OldWorktreeOutcome, ProjectConfig, ProviderId, TemplateLoadPlan } from './types'
import type { TemplateAgent } from './templates'
import { agentModelShown, effortLabel } from './defaults'
import { modelCaps, type ModelInfo } from './models'
import { agentLaunchSettings, permissionLabel, projectProviderConfig, providerName, providerSettings } from './providers'
import { fmt, tr } from './i18n'
import { msg } from './i18n/msg'

const M = {
  isDefault: msg({ id: 'assistant.templateLoad.isDefault', defaultMessage: '{setting} (default)', description: "A new agent's model, effort or mode that the template leaves to the project's or Hive's defaults: {setting} is what it comes to here (\"Opus 5.5\", \"High\")." }),
  reused: msg({ id: 'assistant.templateLoad.oldReused', defaultMessage: 'its worktree on {branch} goes on with the new {name}', description: "Load template, beside an agent that goes: a new agent of the same name ({name}) works in its worktree (on branch {branch}) again. Lower case: it follows the agent's name in brackets." }),
  removable: msg({ id: 'assistant.templateLoad.oldRemovable', defaultMessage: 'its worktree and branch {branch}, merged into {known, select, yes {{into}} other {the main branch}} and clean, stay unless you tick below', description: "Load template, beside an agent that goes: its worktree could be removed (a tick box below the list). {into} is the branch its work is merged into. Lower case: it follows the agent's name in brackets." }),
  kept: msg({ id: 'assistant.templateLoad.oldKept', defaultMessage: 'its worktree and branch {branch} stay{hasWhy, select, yes {: {why}} other {}}', description: "Load template, beside an agent that goes: its worktree is kept. {why} says why (\"2 commits not merged into main\"). Lower case: it follows the agent's name in brackets." }),
  newWhy: msg({ id: 'assistant.templateLoad.newWhy', defaultMessage: 'new: {why}', description: "Load template, after a new agent's worktree: why it gets a new one rather than the old one of its name ({why}: \"hive/claude has 1 uncommitted file\")." }),
  setup: msg({ id: 'assistant.templateLoad.setup', defaultMessage: "Each new worktree runs the project's setup command ({command}) before its agent first starts.", description: "Load template, a note under the list: {command} is the project's setup command (\"npm install\")." }),
  afterLoad: msg({ id: 'assistant.templateLoad.afterLoad', defaultMessage: "{removed, select, yes {Their conversations stay in the Sessions tab, and their open cards go back (Active ones to Todo). The layout becomes the template's.} other {The layout becomes the template's.}}", description: "Load template, the last note: what happens to the agents that go (when some do) and to the project's layout. Sessions, Active and Todo as Hive names them." }),
  removedHeading: msg({ id: 'assistant.templateLoad.removedHeading', defaultMessage: 'Removed:', description: "Load template's confirmation, as text: the heading over the agents that go." }),
  createdHeading: msg({ id: 'assistant.templateLoad.createdHeading', defaultMessage: 'Created:', description: "Load template's confirmation, as text: the heading over the template's agents." }),
  removedLine: msg({ id: 'assistant.templateLoad.removedLine', defaultMessage: '{name}{hasNote, select, yes { ({note})} other {}}{replaced, select, yes {: replaced by a new agent with the same name} other {}}', description: "Load template's confirmation, as text: an agent that goes, after a bullet. {note} is what happens to its worktree." }),
  createdLine: msg({ id: 'assistant.templateLoad.createdLine', defaultMessage: '{name}{hasRole, select, yes { — {role}} other {}}{replaces, select, yes { (new)} other {}}: {provider}, {settings}', description: "Load template's confirmation, as text: an agent the template brings, after a bullet: its role, (new) when it replaces an agent of the same name, its coding agent ({provider}) and its model · effort · mode ({settings})." }),
  reuseLine: msg({ id: 'assistant.templateLoad.reuseLine', defaultMessage: 'reuses its worktree on {branch} in {path} (clean; its branch is left as it is)', description: "Load template's confirmation, as text, under a new agent: it works in an old worktree again." }),
  newLine: msg({ id: 'assistant.templateLoad.newLine', defaultMessage: 'own worktree on {branch} (from {base}) in {path}{hasNote, select, yes { ({note})} other {}}', description: "Load template's confirmation, as text, under a new agent: its own new worktree, on branch {branch} made from {base}, in folder {path}." }),
  ownLine: msg({ id: 'assistant.templateLoad.ownLine', defaultMessage: 'own worktree', description: "Load template's confirmation, as text, under a new agent: it works in a worktree of its own." }),
  wholeTitle: msg({ id: 'assistant.templateLoad.wholeTitle', defaultMessage: 'Removed {count, plural, one {an old worktree} other {# old worktrees}}', description: "After loading a template: the old worktrees you chose to remove went, with their branches." }),
  wholeDetail: msg({ id: 'assistant.templateLoad.wholeDetail', defaultMessage: '{branches}, with {count, plural, one {its branch} other {their branches}}: merged and clean.', description: 'After loading a template: {branches} lists the removed worktrees by branch.' }),
  keptTitle: msg({ id: 'assistant.templateLoad.keptTitle', defaultMessage: '{count, plural, one {An old worktree was kept} other {# old worktrees were kept}}', description: "After loading a template: some old worktrees you chose to remove couldn't be." }),
  branchKeptTitle: msg({ id: 'assistant.templateLoad.branchKeptTitle', defaultMessage: "{count, plural, one {An old worktree's branch was kept} other {# old worktrees' branches were kept}}", description: "After loading a template: old worktrees whose folder went but whose branch stayed." }),
  removedWith: msg({ id: 'assistant.templateLoad.removedWith', defaultMessage: 'Removed with {count, plural, one {its branch} other {their branches}}: {branches}.', description: 'After loading a template, a line of the details: the worktrees that went whole, by branch.' }),
  folderOnly: msg({ id: 'assistant.templateLoad.folderOnly', defaultMessage: '{branch}: its folder was removed, but the branch was kept{hasWhy, select, yes { ({why})} other {}}.', description: 'After loading a template, a line of the details: an old worktree whose branch stayed, and why.' }),
  keptLine: msg({ id: 'assistant.templateLoad.keptLine', defaultMessage: '{branch}: kept{hasWhy, select, yes { ({why})} other {}}.', description: 'After loading a template, a line of the details: an old worktree that stayed, and why.' })
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

type PlanIn = Pick<TemplateLoadPlan, 'remove' | 'create' | 'worktrees' | 'setup'> & Partial<Pick<TemplateLoadPlan, 'oldWorktrees' | 'mergedInto'>>

/**
 * Where a created agent works (#511): the project folder, a new worktree (its branch, folder and base), one it works in
 * again (#289), or its own worktree with no place known yet; a note on why it is new.
 */
export interface PlaceShown {
  kind: 'folder' | 'new' | 'reuse' | 'own'
  branch?: string
  path?: string
  base?: string
  note?: string
}

/** The Load template dialog's plan (#511, as a table): who goes and what happens to their worktrees, who comes, and the notes after. */
export interface TemplateLoadView {
  removed: { name: string; note: string; replaced: boolean }[]
  created: { name: string; role?: string; replaces: boolean; provider: ProviderId; providerName: string; model: SettingShown; effort: SettingShown | null; mode: SettingShown | null; where: PlaceShown }[]
  notes: string[]
}

export function templateLoadView(plan: PlanIn, cfg: Pick<ProjectConfig, 'providers' | 'defaultProvider'>, settings: AppSettings | null, info: (p: ProviderId) => ModelInfo): TemplateLoadView {
  const coming = new Set(plan.create.map((a) => a.name.toLowerCase()))
  const replaced = new Set(plan.remove.filter((a) => coming.has(a.name.toLowerCase())).map((a) => a.name.toLowerCase()))
  // Worktrees a created agent works in again (#289): a removed agent's goes on with the new one rather than staying behind.
  const reused = new Set(plan.worktrees.flatMap((w) => (w?.reuse ? [w.path.toLowerCase()] : [])))
  // What happens to each removed agent's worktree: worked in again, removable (merged and clean: the tick box), or kept, why (#289).
  const old = (a: TemplateLoadPlan['remove'][number]): string => {
    if (!a.worktree) return ''
    const branch = a.worktree.branch
    if (reused.has(a.worktree.path.toLowerCase())) return tr(M.reused, { branch, name: a.name })
    const o = plan.oldWorktrees?.find((w) => w.path.toLowerCase() === a.worktree!.path.toLowerCase())
    if (o?.removable) return tr(M.removable, { branch, known: yesNo(plan.mergedInto), into: plan.mergedInto ?? '' })
    return tr(M.kept, { branch, hasWhy: yesNo(o?.why), why: o?.why ?? '' })
  }
  const removed = plan.remove.map((a) => ({ name: a.name, note: old(a), replaced: replaced.has(a.name.toLowerCase()) }))
  const created = plan.create.map((a, i) => {
    const w = plan.worktrees[i]
    const where: PlaceShown = w?.reuse
      ? { kind: 'reuse', branch: w.branch, path: w.path }
      : w
        ? { kind: 'new', branch: w.branch, path: w.path, base: w.base, ...(w.notReused ? { note: tr(M.newWhy, { why: w.notReused }) } : {}) }
        : { kind: a.worktree ? 'own' : 'folder' }
    return { name: a.name, ...(a.role ? { role: a.role } : {}), replaces: replaced.has(a.name.toLowerCase()), provider: a.provider, providerName: providerName(a.provider), ...templateAgentParts(a, cfg, settings, info(a.provider)), where }
  })
  const notes: string[] = []
  if (plan.setup && plan.worktrees.some((w) => w && !w.reuse)) notes.push(tr(M.setup, { command: plan.setup }))
  notes.push(tr(M.afterLoad, { removed: yesNo(plan.remove.length) }))
  return { removed, created, notes }
}

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
    lines.push(`• ${tr(M.createdLine, { name: a.name, hasRole: yesNo(a.role), role: a.role ?? '', replaces: yesNo(a.replaces), provider: a.providerName, settings: settingsText })}`)
    const w = a.where
    if (w.kind === 'reuse') lines.push(`    ${tr(M.reuseLine, { branch: w.branch ?? '', path: w.path ?? '' })}`)
    else if (w.kind === 'new') lines.push(`    ${tr(M.newLine, { branch: w.branch ?? '', base: w.base ?? '', path: w.path ?? '', hasNote: yesNo(w.note), note: w.note ?? '' })}`)
    else if (w.kind === 'own') lines.push(`    ${tr(M.ownLine)}`)
  }
  lines.push('')
  lines.push(...v.notes)
  return lines.join('\n')
}

/**
 * The notice after a load that removed old worktrees (#289, #313): those that went with their branches, those whose
 * folder went but whose branch stayed (why), and those kept (why). Success only when every one went whole; null when
 * none were asked for.
 */
export function oldWorktreesNotice(outcomes: readonly OldWorktreeOutcome[]): { level: 'success' | 'warning'; title: string; detail: string } | null {
  if (!outcomes.length) return null
  const whole = outcomes.filter((w) => w.removed && !w.branchKept)
  const branchStayed = outcomes.filter((w) => w.removed && w.branchKept)
  const kept = outcomes.filter((w) => !w.removed)
  const branches = fmt.list(whole.map((w) => w.branch), 'unit')
  if (!branchStayed.length && !kept.length) return { level: 'success', title: tr(M.wholeTitle, { count: whole.length }), detail: tr(M.wholeDetail, { count: whole.length, branches }) }
  const title = kept.length ? tr(M.keptTitle, { count: kept.length }) : tr(M.branchKeptTitle, { count: branchStayed.length })
  const detail = [
    ...(whole.length ? [tr(M.removedWith, { count: whole.length, branches })] : []),
    ...branchStayed.map((w) => tr(M.folderOnly, { branch: w.branch, hasWhy: yesNo(w.why), why: w.why ?? '' })),
    ...kept.map((w) => tr(M.keptLine, { branch: w.branch, hasWhy: yesNo(w.why), why: w.why ?? '' }))
  ].join('\n')
  return { level: 'warning', title, detail }
}
