import { msg, tr } from './i18n'
import { samePath } from './movePaths'
import type { NamedFolder } from './agentFolders'
import type { SessionListItem } from './types'

/**
 * Where a session ran and whose it was, for the Sessions tab: "Coder · Project folder", "Reviewer · Worktree ·
 * hive/reviewer". From what the session recorded (its agent's id and name, its folder and branch), never from which
 * agent has that name or folder now: an agent added later with the same name or worktree isn't the one that ran it.
 * Which agent resumes it now is separate (resumeTarget).
 */
export interface SessionOrigin {
  /** The agent: its current name; "Coder (removed)" or "Removed agent" once gone; null when none was recorded. */
  agent: string | null
  /** "Project folder", "Slot · <name>", "Home · <name>" (#1442), or "Worktree · <branch>". */
  location: string
  /** The badge: agent and location. */
  label: string
  /** For a tooltip: the full folder, and the agent's id. */
  detail: string
}

type Recorded = Pick<SessionListItem, 'source' | 'agentId' | 'agentName' | 'cwd' | 'branch'>

/** A removed agent's name as the Sessions tab shows it: "Coder (removed)", or "Removed agent" from before names were kept. */
export function removedAgentName(name: string | null | undefined): string {
  return name ? tr(msg({ id: 'sessions.origin.removedName', defaultMessage: '{agent} (removed)', description: 'An agent that ran sessions and has since been removed from the project, in the Sessions tab: its name ({agent}).' }), { agent: name }) : tr(msg({ id: 'sessions.origin.removedUnnamed', defaultMessage: 'Removed agent', description: "An agent that ran sessions and has since been removed, from before Hive kept agents' names (the Sessions tab)." }))
}

/**
 * Null for sessions started outside Hive. (The Assistant's conversations aren't labelled: it has one place to run.)
 * `folders`: the project's slots and retired homes (ProjectInfo.folders), which name a folder by its slot or home.
 */
export function sessionOrigin(projectPath: string, agents: readonly { id: string; name: string }[], s: Recorded, folders: readonly NamedFolder[] = []): SessionOrigin | null {
  if (s.source !== 'hive') return null
  const folder = s.cwd || projectPath
  const inWorktree = folder.toLowerCase() !== projectPath.toLowerCase()
  const named = inWorktree ? folders.find((f) => samePath(f.path, folder)) : undefined
  const location = named
    ? tr(msg({ id: 'sessions.origin.named', defaultMessage: '{is, select, slot {Slot · {name}} other {Home · {name}}}', description: "Where a session ran (the Sessions tab): in one of the project's slots (a working folder Hive lends to cards; {name} is its name, such as slot-b) or a reviewer's retired home ({name}: its folder's name, such as hr4). Glossary: slot." }), { is: named.is, name: named.name })
    : inWorktree
      ? tr(msg({ id: 'sessions.origin.worktree', defaultMessage: 'Worktree · {branch}', description: "Where a session ran (the Sessions tab): in a worktree, named by its branch ({branch}) or folder." }), { branch: s.branch || folder.split(/[\\/]/).filter(Boolean).pop() || folder })
      : tr(msg({ id: 'sessions.origin.projectFolder', defaultMessage: 'Project folder', description: "Where a session ran (the Sessions tab): in the project's own folder." }))
  const now = s.agentId ? agents.find((a) => a.id === s.agentId) : undefined
  const agent = !s.agentId ? null : now ? now.name : removedAgentName(s.agentName)
  const who = !s.agentId
    ? tr(msg({ id: 'sessions.origin.noAgent', defaultMessage: 'No agent recorded (adopted, or from before Hive recorded agents).', description: "A session's origin hover (the Sessions tab): Hive has no record of which agent ran it." }))
    : now
      ? tr(msg({ id: 'sessions.origin.agent', defaultMessage: 'Agent {agent} ({id}).', description: "A session's origin hover (the Sessions tab): the agent that ran it, by name ({agent}) and id ({id})." }), { agent: now.name, id: s.agentId })
      : tr(msg({ id: 'sessions.origin.removed', defaultMessage: 'Its agent ({id}) has since been removed.', description: "A session's origin hover (the Sessions tab): the agent that ran it ({id}: its id) was removed from the project." }), { id: s.agentId })
  const ran = tr(msg({ id: 'sessions.origin.ranIn', defaultMessage: 'Ran in {folder}', description: "A session's origin hover (the Sessions tab), its first line: the folder it ran in ({folder}, a path)." }), { folder })
  return { agent, location, label: agent ? `${agent} · ${location}` : location, detail: `${ran}\n${who}` }
}
