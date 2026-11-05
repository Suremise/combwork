// Hive's own agent templates (#1436, OP-19; Darren's 19 Oct decision on #1123: templates from 0.9 are wiped and Hive
// ships these instead). Read-only, listed under the Hive scope; Duplicate… copies one into the workspace or a project to
// change it. They suggest a CLI per role and never a connection or model (HI-2109, decision G): the user picks
// connections when one is loaded. Names are patterns of the project's key
// (`{key}-B{n}`, #1123 names, #1440), made where the template is loaded (HI-B1…); the layout fits the count.
import { msg, type Msg } from './i18n/msg'
import { tr } from './i18n'
import { TEMPLATE_VERSION, type AgentTemplate, type SuggestedPreset, type TemplateAgent, type TemplatePair } from './templates'
import type { PageLayout } from './types'
import type { ReviewerMode } from './workflow/roles'
import { preset } from './workflow/options'
import { templateWorkflowOf, type TemplateWorkflows } from './workflow/templateOptions'

/** One of Hive's templates: its file name in the Hive scope (how calls name it), its name and description as messages. */
export interface HiveTemplate {
  file: string
  name: Msg
  description: Msg
  template: AgentTemplate
}

const builders = (n: number): TemplateAgent[] => Array.from({ length: n }, () => ({ name: '{key}-B{n}', role: 'builder', provider: 'claude-code' }))
const reviewers = (n: number, provider = 'codex'): TemplateAgent[] => Array.from({ length: n }, () => ({ name: '{key}-R{n}', role: 'reviewer', provider }))
/** Builder n with reviewer n, for each n both have (by their numbered names, `pairNames`). */
const paired = (n: number): TemplatePair[] => Array.from({ length: n }, (_, i) => ({ builder: `{key}-B${i + 1}`, reviewer: `{key}-R${i + 1}` }))

function hive(file: string, name: Msg, description: Msg, layout: PageLayout, agents: TemplateAgent[], suggestedPreset: SuggestedPreset, extra: { pairs?: TemplatePair[]; reviewerMode?: ReviewerMode } = {}): HiveTemplate {
  // Its name in English: what a copy is called before the window's language names it (main names copies in its own).
  return { file, name, description, template: { version: TEMPLATE_VERSION, name: name.defaultMessage, savedAt: '', layout, description: description.defaultMessage, agents, suggestedPreset, ...extra, workflow: presetWorkflow(suggestedPreset, extra.reviewerMode, agents.length) } }
}

/**
 * A preset as a template's sections (HI-1910: Hive's own carry their preset's), for None and Git, with its reviewer
 * mode on Git (Team 6 + pool's pool) and its size as Maximum agents (HI-2001: the team the template is). Its checks are
 * the preset's for no project (none): loading it into a project makes them that project's (the plan reads the preset as
 * the project's form offers it, `hiveSections`).
 */
export function presetWorkflow(id: SuggestedPreset, reviewerMode?: ReviewerMode, size?: number): TemplateWorkflows {
  const team = size ? { maxAgents: size } : {}
  return {
    none: templateWorkflowOf({ ...preset('none', id), ...team }, id),
    git: templateWorkflowOf({ ...preset('git', id), ...(reviewerMode ? { reviewerMode } : {}), ...team }, id)
  }
}

/** Hive's templates, in the order they are listed. */
export const CW_TEMPLATES: readonly HiveTemplate[] = [
  hive(
    'solo.json',
    msg({ id: 'assistant.hiveTemplates.solo', defaultMessage: 'Solo', description: "Name of one of Hive's own agent templates: one builder (glossary: builder). Like the preset Solo." }),
    msg({ id: 'assistant.hiveTemplates.soloText', defaultMessage: 'One builder (Claude Code), working alone.', description: "Description of Hive's template Solo (glossary: builder)." }),
    'single',
    builders(1),
    'solo'
  ),
  hive(
    'pair.json',
    msg({ id: 'assistant.hiveTemplates.pair', defaultMessage: 'Pair', description: "Name of one of Hive's own agent templates: a builder and a reviewer. Like the preset Pair." }),
    msg({ id: 'assistant.hiveTemplates.pairText', defaultMessage: 'A builder (Claude Code) and a reviewer (Codex) that reviews its cards.', description: "Description of Hive's template Pair (glossary: builder, reviewer)." }),
    'columns2',
    [...builders(1), ...reviewers(1)],
    'pair',
    { pairs: paired(1) }
  ),
  hive(
    'pair-one-provider.json',
    msg({ id: 'assistant.hiveTemplates.pairOne', defaultMessage: 'Pair: one provider', description: "Name of one of Hive's own agent templates: a builder and a reviewer on the same coding agent (provider: Claude Code, Codex…)." }),
    msg({ id: 'assistant.hiveTemplates.pairOneText', defaultMessage: 'A builder and a reviewer, both Claude Code: for when only one coding agent is installed.', description: "Description of Hive's template Pair: one provider (glossary: builder, reviewer)." }),
    'columns2',
    [...builders(1), ...reviewers(1, 'claude-code')],
    'pair',
    { pairs: paired(1) }
  ),
  hive(
    'team-3x3.json',
    msg({ id: 'assistant.hiveTemplates.team3', defaultMessage: 'Team 3×3', description: "Name of one of Hive's own agent templates: three builders and three reviewers. Keep 3×3." }),
    msg({ id: 'assistant.hiveTemplates.team3Text', defaultMessage: 'Three builders (Claude Code), each with its own reviewer (Codex).', description: "Description of Hive's template Team 3×3 (glossary: builder, reviewer)." }),
    'grid6',
    [...builders(3), ...reviewers(3)],
    'team',
    { pairs: paired(3) }
  ),
  hive(
    'team-6x6.json',
    msg({ id: 'assistant.hiveTemplates.team6', defaultMessage: 'Team 6×6', description: "Name of one of Hive's own agent templates: six builders and six reviewers. Keep 6×6." }),
    msg({ id: 'assistant.hiveTemplates.team6Text', defaultMessage: 'Six builders (Claude Code), each with its own reviewer (Codex), on two pages.', description: "Description of Hive's template Team 6×6 (glossary: builder, reviewer)." }),
    'grid6',
    [...builders(6), ...reviewers(6)],
    'team',
    { pairs: paired(6) }
  ),
  hive(
    'team-6-pool.json',
    msg({ id: 'assistant.hiveTemplates.team6Pool', defaultMessage: 'Team 6 + pool', description: "Name of one of Hive's own agent templates: six builders and a shared pool of reviewers." }),
    msg({ id: 'assistant.hiveTemplates.team6PoolText', defaultMessage: 'Six builders (Claude Code) and two reviewers (Codex) shared by all of them.', description: "Description of Hive's template Team 6 + pool (glossary: builder, reviewer)." }),
    'grid6',
    [...builders(6), ...reviewers(2)],
    'team',
    { reviewerMode: 'pool' }
  )
]

/** One of Hive's templates by its file name, or undefined. */
export const hiveTemplate = (file: string): HiveTemplate | undefined => CW_TEMPLATES.find((t) => t.file === file)

/**
 * A listed template's name and description as the window shows them: Hive's own in the window's language now (main
 * listed them in its own, which a change of language leaves behind), any other as saved.
 */
export function templateTitle(t: { scope: string; file: string; name: string }): string {
  const h = t.scope === 'hive' ? hiveTemplate(t.file) : undefined
  return h ? tr(h.name) : t.name
}
export function templateDescription(t: { scope: string; file: string; description?: string }): string | undefined {
  const h = t.scope === 'hive' ? hiveTemplate(t.file) : undefined
  return h ? tr(h.description) : t.description
}
