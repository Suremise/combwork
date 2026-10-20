// What a progress run ran for (#1220, SPEC §16.13): the card, the revision and the check that `hive-progress --card
// --revision --check` and `/v1/progress` name, or their defaults: the reporting agent's card in Doing, and the head of
// the folder it runs in, at the start. hive-progress asks for it before it starts the command
// (`POST /v1/progress/resolve`), so a revision that isn't what's checked out is refused before anything runs.
//
// P3: the run only shows what it ran for; recording `CheckRan` from it comes next (#1119's item 2). The folder's head is
// read with git: the platform adapters (#1213) read a card's revision from its state, which comes with the fact store.

import { randomUUID } from 'crypto'
import { isAbsolute } from 'path'
import { gitReading } from '../git'
import { ProgressError, admitReport, type ProgressCaller, type ProgressGate } from '../progress'
import type { TaskColumn } from '../../shared/types'
import { cardRefText, shortRevision } from '../../shared/progress'

/** What a request names (any of it may be missing; `card: null` says the run is for no card, so none is defaulted). */
export interface RunLinkAsked {
  card?: unknown
  revision?: unknown
  check?: unknown
  folder?: unknown
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

  // Always read here, never taken from the request: what was checked out is what a run is checked against.
  const tested = folder ? await deps.head(folder) : null

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

/** A link as the Agent API gives it: the card by its reference, the commits in full, and the id its start passes back. */
export function publicLink(l: RunLink, id: string): Record<string, unknown> {
  return { link: id, card: l.card === null ? null : cardRefText(l.card), revision: l.revision, testedCheckout: l.testedCheckout, check: l.check, folder: l.folder }
}

/**
 * Admits a run's start with what it runs for (#1220 round 2): its caller and its link are looked up inside the admission,
 * so a panel turned off (or off and on) while they are is ignored as any report is (admitReport), and `settled` (the
 * request's workspace still open) is checked after both, right before the start.
 */
export function admitLinked<T>(gate: ProgressGate, ignored: T, steps: { caller: () => Promise<ProgressCaller>; link: (caller: ProgressCaller) => Promise<RunLink>; settled: () => void }, start: (caller: ProgressCaller, link: RunLink) => T): Promise<T> {
  return admitReport(
    gate,
    ignored,
    async () => {
      const caller = await steps.caller()
      const link = await steps.link(caller)
      steps.settled()
      return { caller, link }
    },
    ({ caller, link }) => start(caller, link)
  )
}

/** Who a link was given to: an agent, or a workspace's Assistant or scripts. */
export const linkOwner = (c: ProgressCaller): string => (c.source === 'agent' ? `agent|${c.projectPath.toLowerCase()}|${c.agentId}` : `${c.source}|${c.workspacePath.toLowerCase()}`)

/** How long a link resolve gave out waits for its start (hive-progress starts its run within seconds). */
export const LINK_TTL_MS = 10 * 60_000
/** Links kept at most: past it, the oldest go. */
export const MAX_LINKS = 200

/**
 * The links resolve gave out, so a run's start carries what was checked out when hive-progress asked, before its command
 * started, rather than reading it again seconds later (the command may have changed it) or taking a commit id from the
 * request (#1220 round 2: that is no proof of the checkout). Each is its caller's own, taken once, and gone after
 * LINK_TTL_MS; a start whose link is unknown, expired or someone else's is resolved again from what it names.
 */
export class IssuedLinks {
  private links = new Map<string, { owner: string; link: RunLink; at: number }>()
  constructor(private readonly now: () => number = Date.now) {}

  issue(owner: string, link: RunLink): string {
    this.sweep()
    while (this.links.size >= MAX_LINKS) this.links.delete(this.links.keys().next().value!)
    const id = randomUUID()
    this.links.set(id, { owner, link, at: this.now() })
    return id
  }

  take(owner: string, id: unknown): RunLink | null {
    this.sweep()
    if (typeof id !== 'string') return null
    const e = this.links.get(id)
    if (!e || e.owner !== owner) return null
    this.links.delete(id)
    return e.link
  }

  private sweep(): void {
    const cut = this.now() - LINK_TTL_MS
    for (const [id, e] of this.links) if (e.at < cut) this.links.delete(id)
  }
}

/** What's checked out in a folder (git, until runs read it through the card's platform adapter), or null where nothing is. */
export const folderHead = (folder: string): Promise<string | null> => gitReading(folder, ['rev-parse', '--verify', '--quiet', 'HEAD']).then((r) => (r.ok ? r.out.trim() || null : null))

/** The commit a revision names in a folder, in full, or null when it names none there. */
export const commitIn = (folder: string, revision: string): Promise<string | null> => gitReading(folder, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]).then((r) => (r.ok ? r.out.trim() || null : null))
