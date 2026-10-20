// What a progress run ran for (#1220, SPEC §16.13): the card, the revision and the check that `hive-progress --card
// --revision --check` and `/v1/progress` name, or their defaults: the reporting agent's card in Doing, and the head of
// the folder it runs in, at the start. hive-progress asks for it before it starts the command
// (`POST /v1/progress/resolve`), so a revision that isn't what's checked out is refused before anything runs.
//
// P3: the run only shows what it ran for; recording `CheckRan` from it comes next (#1119's item 2). The folder's head is
// read with git until #1213's platform layer gives it.

import { isAbsolute } from 'path'
import { gitReading } from '../git'
import { ProgressError, type ProgressCaller } from '../progress'
import type { TaskColumn } from '../../shared/types'
import { cardRefText, shortRevision } from '../../shared/progress'

/** What a request names (any of it may be missing; `card: null` says the run is for no card, so none is defaulted). */
export interface RunLinkAsked {
  card?: unknown
  revision?: unknown
  check?: unknown
  folder?: unknown
  /** What the resolve step found checked out (hive-progress passes it on to the start), so the start doesn't read it again. */
  testedCheckout?: unknown
}

export interface RunLink {
  card: number | null
  revision: string | null
  testedCheckout: string | null
  check: { name: string; command: string } | null
  folder: string | null
}

export interface RunLinkDeps {
  /** A card by its number (its project's folder name, its column and agent), or null when there's none or it's archived. */
  card: (n: number) => Promise<{ project: string; column: TaskColumn; agent: string | null } | null>
  /** The cards in Doing given to an agent of a project. */
  doing: (projectPath: string, agentId: string) => Promise<number[]>
  /** What's checked out in a folder (a full commit id), or null where nothing is (no repository, no commit yet). */
  head: (folder: string) => Promise<string | null>
  /** The commit a revision names in a folder (a full id), or null when it names none there. */
  commitOf: (folder: string, revision: string) => Promise<string | null>
  /** A project's folder name, by its path. */
  projectName: (projectPath: string) => string
  /** The command a project (by its folder name) has configured for a named check, or null. */
  checkCommand: (project: string, name: string) => Promise<string | null>
}

const MAX_FOLDER = 1000
const MAX_REVISION = 100
const CHECK_NAME = /^[\w.:-]{1,60}$/
const FULL_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
// A revision as git takes one, never an option: a commit id, a branch or tag, HEAD~1.
const REVISION = /^[\w./@^~{}-]+$/

const refused = (message: string): ProgressError => new ProgressError(400, message)

/** A card reference from a request: `#1061`; a plain number is refused with the forms to use (SPEC §16.12). */
function cardNumber(v: unknown): number {
  if (typeof v === 'string') {
    const t = v.trim()
    const alias = /^#(\d{1,9})$/.exec(t)
    if (alias) return Number(alias[1])
    if (/^[A-Za-z]{2,4}-\d+$/.test(t)) throw refused(`Project keys aren't in use yet: name the card as #N (its number), such as #1061`)
  }
  throw refused(`card is a card reference such as "#1061": a plain number isn't taken (in a shell, quote it: an unquoted # starts a comment)`)
}

/**
 * Resolves what a run is for, checking what it names: a card the caller may see, a revision that is what's checked out
 * in the folder, a check the project has a command for. Defaults: the agent's one card in Doing (none when it has
 * several: a run counted for the wrong card is worse than none), and the folder's head. Throws a ProgressError (400)
 * with what to do instead.
 */
export async function resolveRunLink(caller: ProgressCaller, asked: RunLinkAsked, deps: RunLinkDeps): Promise<RunLink> {
  let folder: string | null = null
  if (asked.folder !== undefined && asked.folder !== null) {
    if (typeof asked.folder !== 'string' || !asked.folder.trim() || asked.folder.length > MAX_FOLDER || !isAbsolute(asked.folder)) throw refused('folder is the absolute path of the folder the run runs in')
    folder = asked.folder
  }
  const own = caller.source === 'agent' ? deps.projectName(caller.projectPath).toLowerCase() : null

  let card: number | null = null
  let cardProject: string | null = null
  if (asked.card !== undefined && asked.card !== null) {
    card = cardNumber(asked.card)
    const c = await deps.card(card)
    // A project agent sees only its own project's cards: another's answers as an unknown one does.
    if (!c || (own !== null && c.project.toLowerCase() !== own)) throw refused(`Unknown card ${cardRefText(card)}`)
    cardProject = c.project
  } else if (asked.card === undefined && caller.source === 'agent') {
    const doing = await deps.doing(caller.projectPath, caller.agentId)
    if (doing.length === 1) card = doing[0]
  }

  let tested: string | null = null
  if (typeof asked.testedCheckout === 'string' && FULL_ID.test(asked.testedCheckout)) tested = asked.testedCheckout
  else if (asked.testedCheckout !== undefined && asked.testedCheckout !== null) throw refused('testedCheckout is a full commit id')
  else if (folder) tested = await deps.head(folder)

  let revision = tested
  if (asked.revision !== undefined && asked.revision !== null) {
    if (typeof asked.revision !== 'string' || !asked.revision.trim() || asked.revision.length > MAX_REVISION || asked.revision.startsWith('-') || !REVISION.test(asked.revision.trim())) throw refused('revision is a commit (its id, or a name git knows)')
    const named = asked.revision.trim()
    if (!folder) throw refused('A revision is checked against what is checked out where the run runs: give folder too')
    if (!tested) throw refused(`Nothing is checked out in ${folder} to compare ${named} with: leave revision out`)
    const id = await deps.commitOf(folder, named)
    if (!id) throw refused(`${named} isn't a commit in ${folder}`)
    if (id !== tested) throw refused(`${named} isn't what's checked out here (${shortRevision(tested)} is): check it out first, or leave revision out`)
    revision = id
  }

  let check: RunLink['check'] = null
  if (asked.check !== undefined && asked.check !== null) {
    if (typeof asked.check !== 'string' || !CHECK_NAME.test(asked.check.trim())) throw refused('check is the name of one of the project\'s checks, such as "typecheck"')
    const name = asked.check.trim()
    const project = own !== null ? deps.projectName((caller as { projectPath: string }).projectPath) : cardProject
    if (!project) throw refused('A check runs its project\'s command for it: name the card too, so Hive knows the project')
    const command = await deps.checkCommand(project, name)
    if (!command) throw refused(`${project} has no command configured for the check "${name}", so nothing was run. hive-progress --check runs the command the project's options give for that name`)
    check = { name, command }
  }

  return { card, revision, testedCheckout: tested, check, folder }
}

/** A link as the Agent API gives it: the card by its reference, the commits in full. */
export function publicLink(l: RunLink): Record<string, unknown> {
  return { card: l.card === null ? null : cardRefText(l.card), revision: l.revision, testedCheckout: l.testedCheckout, check: l.check, folder: l.folder }
}

/** What's checked out in a folder (git; #1213's platform layer takes this over), or null where nothing is. */
export const folderHead = (folder: string): Promise<string | null> => gitReading(folder, ['rev-parse', '--verify', '--quiet', 'HEAD']).then((r) => (r.ok ? r.out.trim() || null : null))

/** The commit a revision names in a folder, in full, or null when it names none there. */
export const commitIn = (folder: string, revision: string): Promise<string | null> => gitReading(folder, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]).then((r) => (r.ok ? r.out.trim() || null : null))
