import { msg } from './i18n/msg'
import type { Tr } from './tasks'

// Agent names are unique across the workspace (#702): two projects' agents called B1 can't be told apart on the board,
// in notifications or by the Assistant. Adding, renaming and loading a template refuse a name another agent of the
// workspace has, suggesting one with the project's prefix (B1 in ambrosia: AB1); names from before stay, flagged once.

/** An agent of the workspace, by name: its project's folder name, and its id. */
export interface NamedAgent {
  project: string
  name: string
  id?: string
}

/** The longest agent name a template keeps, and what a load's names may be. */
export const AGENT_NAME_MAX = 60

const key = (name: string): string => name.replace(/\s+/g, ' ').trim().toLowerCase()

/** Whether two agent names are the same (case and spacing aside). */
export const sameAgentName = (a: string, b: string): boolean => key(a) === key(b)

/** The agent already called `name` (case aside), other than `self` (an agent being renamed): null when it is free. */
export function nameTaken(name: string, agents: readonly NamedAgent[], self?: { project: string; id: string }): NamedAgent | null {
  return agents.find((a) => sameAgentName(a.name, name) && !(self && a.id === self.id && a.project.toLowerCase() === self.project.toLowerCase())) ?? null
}

/** The project's initials, upper case: demo → D, web-dashboard → WD, ambrosiaLabs → AL. */
export function projectPrefix(project: string): string {
  const words = project.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean)
  return words.map((w) => w[0]).join('').toUpperCase() || 'P'
}

/** A short code (B1, R2, QA, b1): a prefix joins it, in capitals (AMB1); a word gets the project in brackets. */
const isCode = (name: string): boolean => /^([A-Z0-9]{1,6}|[A-Za-z]{1,4}\d{1,3})$/.test(name)

/** `base` cut short so that it and `suffix` fit in a name (AGENT_NAME_MAX), then `suffix`. */
const fit = (base: string, suffix: string): string => `${base.slice(0, Math.max(1, AGENT_NAME_MAX - suffix.length)).trimEnd()}${suffix}`

/**
 * A free name for an agent called `name` in `project` (#702): the project's prefix in front of a short code (B1 in
 * ambrosia: AB1, then AMB1, AMBB1…), a word with the project after it ("Builder (ambrosia)"), else numbered. Every
 * name tried fits AGENT_NAME_MAX (a long name is cut short, never refused), and the numbers end: each one differs, and
 * at most `taken.length` of them are taken.
 */
export function suggestAgentName(name: string, project: string, taken: readonly string[]): string {
  const used = new Set(taken.map(key))
  const free = (n: string): boolean => !used.has(key(n))
  const clean = name.replace(/\s+/g, ' ').trim() || 'Agent' // i18n-ignore: a stored agent name, not text shown as words
  const word = project.replace(/[^A-Za-z0-9]+/g, '').toUpperCase()
  const prefixes = [projectPrefix(project), ...Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(0, i + 2))]
  const code = isCode(clean)
  // A word keeps the project whole (its first 20 characters) and gives way itself.
  const tail = code ? '' : ` (${project.slice(0, 20).trim()})`
  const tries = code ? prefixes.map((p) => fit(p, clean.toUpperCase())) : [fit(clean, tail)]
  const found = tries.find(free)
  if (found) return found
  for (let n = 2; ; n++) {
    const numbered = code ? fit(tries[0], ` ${n}`) : fit(clean, `${tail} ${n}`)
    if (free(numbered)) return numbered
  }
}

/**
 * A free name for a template's agent in a project (#1440): another project's key in it swapped for this one's (AM-B1 in
 * a project keyed AP: AP-B1), else `suggestAgentName`'s. `taken`: every name it mustn't be (the workspace's agents and
 * the names already chosen for the template's others).
 */
export function suggestTemplateAgentName(name: string, project: string, projectKey: string | null | undefined, taken: readonly string[]): string {
  const m = /^([A-Za-z]{2,4})-(.+)$/.exec(name.trim())
  if (projectKey && m && m[1].toUpperCase() !== projectKey.toUpperCase()) {
    const swapped = `${projectKey.toUpperCase()}-${m[2]}`
    if (!taken.some((t) => sameAgentName(t, swapped))) return swapped
  }
  return suggestAgentName(name, project, taken)
}

/** "There is already an agent called "B1" in ambrosia…": the refusal, with a free name to use instead. */
export function nameTakenMessage(name: string, owner: NamedAgent, suggestion: string, tr?: Tr): string {
  if (tr) return tr(msg({ id: 'agents.name.taken', defaultMessage: 'There is already an agent called "{agent}" in {project}. Agent names are unique across the workspace: try "{suggestion}".', description: "Why an agent name can't be used: another agent ({agent}, in {project}) has it. {suggestion} is a free name to use instead." }), { agent: owner.name, project: owner.project, suggestion })
  return `There is already an agent called "${owner.name}" in ${owner.project}. Agent names are unique across the workspace: try "${suggestion}".` // i18n-ignore: English for main's error (the window passes tr)
}

/** Why a name can't be used for an agent (empty, too long), or null; in the window's language with tr, else English (main's errors). */
export function agentNameProblem(name: string, tr?: Tr): string | null {
  const clean = name.replace(/\s+/g, ' ').trim()
  if (!clean) return tr ? tr(msg({ id: 'agents.name.empty', defaultMessage: 'Enter a name.', description: "Why an agent name can't be used: it is empty." })) : 'Enter a name.' // i18n-ignore: English for main's error (the window passes tr)
  if (clean.length > AGENT_NAME_MAX) return tr ? tr(msg({ id: 'agents.name.tooLong', defaultMessage: 'A name is at most {max} characters.', description: "Why an agent name can't be used: it is longer than {max} characters." }), { max: AGENT_NAME_MAX }) : `A name is at most ${AGENT_NAME_MAX} characters.` // i18n-ignore: English for main's error (the window passes tr)
  return null
}

/** The names more than one agent of the workspace has, each with those agents (projects in order): duplicates from before #702. */
export function duplicateAgentNames(agents: readonly NamedAgent[]): { name: string; agents: NamedAgent[] }[] {
  const groups = new Map<string, NamedAgent[]>()
  for (const a of agents) groups.set(key(a.name), [...(groups.get(key(a.name)) ?? []), a])
  return [...groups.values()].filter((g) => g.length > 1).map((g) => ({ name: g[0].name, agents: [...g].sort((x, y) => x.project.localeCompare(y.project, undefined, { sensitivity: 'base' })) }))
}

/** The workspace's agents by name, from its projects as the window has them. */
export function workspaceAgentList(projects: readonly { name: string; agents: readonly { name: string; id: string }[] }[] | null | undefined): NamedAgent[] {
  return (projects ?? []).flatMap((p) => p.agents.map((a) => ({ project: p.name, name: a.name, id: a.id })))
}
