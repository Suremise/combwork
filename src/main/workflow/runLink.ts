// What a progress run ran for (#1220, SPEC §16.13): the card, the revision and the check that `cw-progress --card
// --revision --check` and `/v1/progress` name, or their defaults: the reporting agent's card in Doing, and the head of
// the folder it runs in, at the start. hive-progress asks for it before it starts the command
// (`POST /v1/progress/resolve`), so a revision that isn't what's checked out is refused before anything runs.
//
// A run for a card with a start in its facts reads its revisions through the card's platform adapter (#1233): Git, the
// card's revision (its folder's head, or its newest attributed commit) and what's checked out where the run runs;
// None, its declared paths' hash. Any other run reads its folder's head with git.

import { randomUUID } from 'crypto'
import { isAbsolute } from 'path'
import { gitReading } from '../git'
import { ProgressError, admitReport, type ProgressCaller, type ProgressGate } from '../progress'
import type { RunRevision } from '../platform/adapter'
import type { TaskColumn } from '../../shared/types'
import { cardRefText, shortRevision } from '../../shared/progress'
import { focusedCheckName, validTestId } from '../../shared/workflow/focused'
import { agentMsg, say } from '../../shared/agentText'

/** cw-progress's refusals of what a run names (agent text, HI-2065): said in the request's scope, as the run is resolved. */
const A = {
  cardForm: agentMsg({
    id: 'check.link.cardForm',
    text: 'card is a card reference such as "HI-12" or "#1061": a plain number isn\'t taken (in a shell, quote "#1061": an unquoted # starts a comment)',
    note: '#1219, SPEC §16.12: a plain number is refused with the forms to use. An unquoted #1061 in a shell is a comment.'
  }),
  folder: agentMsg({ id: 'check.link.folder', text: 'folder is the absolute path of the folder the run runs in', note: 'A request whose folder is missing, not absolute or too long.' }),
  unknownCard: agentMsg({
    id: 'check.link.unknownCard',
    text: 'Unknown card {card}',
    note: "card: the reference as the caller wrote it. Another project's card answers as an unknown one does, so nothing of it shows."
  }),
  otherCopy: agentMsg({
    id: 'check.link.otherCopy',
    text: "{copy} holds {held}'s revision, not {card}'s: run it there for {held}, or elsewhere for {card}",
    note: "#1435: a run in a review or check copy is a check of the copy's lease. copy: the copy's name; held: its lease's card; card: the card the run names."
  }),
  revisionForm: agentMsg({ id: 'check.link.revisionForm', text: 'revision is a commit (its id, or a name git knows)', note: 'A revision that is empty, too long, starts with "-" or has characters git refs never have.' }),
  revisionNeedsFolder: agentMsg({
    id: 'check.link.revisionNeedsFolder',
    text: 'A revision is checked against what is checked out where the run runs: give folder too',
    note: 'A revision named with no folder.'
  }),
  noContentRevision: agentMsg({
    id: 'check.link.noContentRevision',
    text: '{card} has no revision to compare {named} with: leave revision out',
    note: "A card on the None platform (#1233): its revision is its declared paths' hash, and it has none yet. named: the revision asked for."
  }),
  notContentRevision: agentMsg({
    id: 'check.link.notContentRevision',
    text: "{named} isn't {card}'s revision now (its paths hash to {hash}): leave revision out",
    note: "A card on the None platform (#1233): its revision is its declared paths' hash. hash: that hash, short."
  }),
  nothingCheckedOut: agentMsg({
    id: 'check.link.nothingCheckedOut',
    text: 'Nothing is checked out in {folder} to compare {named} with: leave revision out',
    note: 'folder: where the run runs; named: the revision asked for.'
  }),
  notACommit: agentMsg({ id: 'check.link.notACommit', text: "{named} isn't a commit in {folder}", note: 'named: the revision asked for; folder: where the run runs.' }),
  notCheckedOut: agentMsg({
    id: 'check.link.notCheckedOut',
    text: "{named} isn't what's checked out here ({head} is): check it out first, or leave revision out",
    note: '#1220: a run is checked against what is checked out where it runs. head: that commit, short.'
  }),
  focusedForm: agentMsg({
    id: 'check.link.focusedForm',
    text: 'A focused test\'s check is "focused:<test>", the test\'s id as its card lists it',
    note: "HI-1367: a focused test's check names a test id its card lists."
  }),
  checkForm: agentMsg({ id: 'check.link.checkForm', text: 'check is the name of one of the project\'s checks, such as "typecheck"', note: 'A check name with characters no check has.' }),
  checkNeedsCard: agentMsg({
    id: 'check.link.checkNeedsCard',
    text: "A check runs its project's command for it: name the card too, so Combwork knows the project",
    note: 'A check named by a caller with no project (a script), and no card.'
  }),
  noCommand: agentMsg({
    id: 'check.link.noCommand',
    text: '{project} has no command configured for the check "{name}", so nothing was run. cw-progress --check runs the command the project\'s options give for that name',
    note: "#1220: a check runs the command the project's options give for it. project: its folder name; name: the check."
  })
}

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
  /** `command` empty: a focused test's check (`focused:<test>`, HI-1367), which runs the command given after `--`. */
  check: { name: string; command: string } | null
  folder: string | null
  /** The review or check copy it runs in (#1435): its card and revision are the copy's lease's. */
  copy?: string
  /** Run with `--isolated` (#1435): in a check copy leased to it alone. */
  isolated?: true
}

export interface RunLinkDeps {
  /** A card by its number (its project's folder name, its column and agent), or null when there's none or it's archived. */
  card: (n: number) => Promise<{ project: string; column: TaskColumn; agent: string | null } | null>
  /** The cards in Doing given to an agent of a project. */
  doing: (projectPath: string, agentId: string) => Promise<number[]>
  /**
   * A card's run read through its platform adapter (#1233): its revision now, what the run in `folder` is tested on, and
   * `named` as the platform reads it; null when the card has no start in its facts yet (from before 1.0, not started),
   * so the folder is read with `head` instead.
   */
  cardRun: (card: number, folder: string | null, named: string | null) => Promise<RunRevision | null>
  /** What's checked out in a folder (a full commit id), or null where nothing is (no repository, no commit yet). */
  head: (folder: string) => Promise<string | null>
  /** The commit a revision names in a folder (a full id), or null when it names none there. */
  commitOf: (folder: string, revision: string) => Promise<string | null>
  /** A project's folder name, by its path. */
  projectName: (projectPath: string) => string
  /** The card a key names (`HI-12`: #1219), or null; with a scope (a project's folder name), only that project's. */
  keyCard: (key: string, scope: string | null) => number | null
  /** The command a project (by its folder name) has configured for a named check, or null. */
  checkCommand: (project: string, name: string) => Promise<string | null>
  /**
   * The review or check copy a folder is in (#1435), with its lease's card and revision while it is out (null when it
   * has none); null when the folder is no copy. `scope`: a project agent's own project (its folder name): another
   * project's copies are no copies to it.
   */
  copyAt?: (folder: string, scope: string | null) => Promise<{ copy: string; card: number | null; revision: string | null } | null>
}

const MAX_FOLDER = 1000
const MAX_REVISION = 100
const CHECK_NAME = /^[\w.:-]{1,60}$/
// A revision as git takes one, never an option: a commit id, a branch or tag, HEAD~1.
const REVISION = /^[\w./@^~{}-]+$/

const refused = (message: string): ProgressError => new ProgressError(400, message)

/**
 * A card reference from a request: its key (`HI-12`, any case, an old key too: #1219) or `#1061`; a plain number is refused
 * with the forms to use (SPEC §16.12). Its number, or null for a key no card has (or another project's, for an agent).
 */
function cardNumber(v: unknown, deps: RunLinkDeps, scope: string | null): number | null {
  if (typeof v === 'string') {
    const t = v.trim()
    const alias = /^#(\d{1,9})$/.exec(t)
    if (alias) return Number(alias[1])
    if (/^[A-Za-z]{2,4}-\d{1,9}$/.test(t)) return deps.keyCard(t, scope)
  }
  throw refused(say(A.cardForm))
}

/**
 * Resolves what a run is for, checking what it names: a card the caller may see, a revision that is what's checked out
 * in the folder, a check the project has a command for. Defaults: the agent's one card in Doing (none when it has
 * several: a run counted for the wrong card is worse than none), and the card's revision (else the folder's head). A
 * named revision must be what the run is tested on (Git: what's checked out; None: the paths' hash). Throws a ProgressError (400)
 * with what to do instead.
 */
export async function resolveRunLink(caller: ProgressCaller, asked: RunLinkAsked, deps: RunLinkDeps): Promise<RunLink> {
  let folder: string | null = null
  if (asked.folder !== undefined && asked.folder !== null) {
    if (typeof asked.folder !== 'string' || !asked.folder.trim() || asked.folder.length > MAX_FOLDER || !isAbsolute(asked.folder)) throw refused(say(A.folder))
    folder = asked.folder
  }
  const own = caller.source === 'agent' ? deps.projectName(caller.projectPath).toLowerCase() : null
  // A run in a review or check copy (#1435) is a check of the copy's lease: its card and revision, never another's. Only
  // the caller's own project's copies (an agent's): another project's folder is just a folder, revealing nothing of it.
  let inCopy = folder && deps.copyAt ? await deps.copyAt(folder, caller.source === 'agent' ? deps.projectName(caller.projectPath) : null) : null
  // Its lease's card, checked as a card named would be (HR1's #1435 round 1): one the caller can't see makes it no copy.
  if (inCopy?.card != null && own !== null) {
    const c = await deps.card(inCopy.card)
    if (!c || c.project.toLowerCase() !== own) inCopy = null
  }

  let card: number | null = null
  let cardProject: string | null = null
  if (asked.card !== undefined && asked.card !== null) {
    const named = typeof asked.card === 'string' ? asked.card.trim() : String(asked.card)
    const n = cardNumber(asked.card, deps, caller.source === 'agent' ? deps.projectName(caller.projectPath) : null)
    if (n === null) throw refused(say(A.unknownCard, { card: named }))
    card = n
    const c = await deps.card(card)
    // A project agent sees only its own project's cards: another's answers as an unknown one does (in the words it used).
    if (!c || (own !== null && c.project.toLowerCase() !== own)) throw refused(say(A.unknownCard, { card: named }))
    cardProject = c.project
  } else if (asked.card === undefined && inCopy?.card != null) {
    card = inCopy.card
  } else if (asked.card === undefined && caller.source === 'agent') {
    const doing = await deps.doing(caller.projectPath, caller.agentId)
    if (doing.length === 1) card = doing[0]
  }
  if (inCopy && card !== null && inCopy.card !== null && card !== inCopy.card) throw refused(say(A.otherCopy, { copy: inCopy.copy, held: cardRefText(inCopy.card), card: cardRefText(card) }))

  let named: string | null = null
  if (asked.revision !== undefined && asked.revision !== null) {
    if (typeof asked.revision !== 'string' || !asked.revision.trim() || asked.revision.length > MAX_REVISION || asked.revision.startsWith('-') || !REVISION.test(asked.revision.trim())) throw refused(say(A.revisionForm))
    named = asked.revision.trim()
    if (!folder) throw refused(say(A.revisionNeedsFolder))
  }

  // Always read here, never taken from the request: what was checked out is what a run is checked against. A card with
  // a start in its facts is read through its platform's adapter (#1233): its revision now, and what the run is tested
  // on; any other run, the folder's head with git.
  const viaCard = card !== null ? await deps.cardRun(card, folder, named) : null
  const tested = viaCard ? viaCard.tested : folder ? await deps.head(folder) : null
  let revision = viaCard ? viaCard.revision : tested
  if (named !== null && folder) {
    if (viaCard?.testedIs === 'content') {
      // None: the card's content is its revision, so a name must be that hash.
      if (!tested) throw refused(say(A.noContentRevision, { card: cardRefText(card!), named }))
      if (named !== tested) throw refused(say(A.notContentRevision, { named, card: cardRefText(card!), hash: shortRevision(tested) }))
    } else {
      if (!tested) throw refused(say(A.nothingCheckedOut, { folder, named }))
      const id = viaCard ? (viaCard.named ?? null) : await deps.commitOf(folder, named)
      if (!id) throw refused(say(A.notACommit, { named, folder }))
      if (id !== tested) throw refused(say(A.notCheckedOut, { named, head: shortRevision(tested) }))
    }
    revision = tested
  }

  let check: RunLink['check'] = null
  // A focused test's check (G20, HI-1367: a reviewer proving a real-CLI or packaged test at the revision submitted): its
  // own command, the one after `--`, recorded with its run; it counts as any check does, at exactly the revision.
  const focused = typeof asked.check === 'string' && asked.check.trim().startsWith(focusedCheckName('')) ? asked.check.trim().slice(focusedCheckName('').length) : null
  if (focused !== null) {
    if (!validTestId(focused)) throw refused(say(A.focusedForm))
    check = { name: focusedCheckName(focused), command: '' }
  } else if (asked.check !== undefined && asked.check !== null) {
    if (typeof asked.check !== 'string' || !CHECK_NAME.test(asked.check.trim())) throw refused(say(A.checkForm))
    const name = asked.check.trim()
    const project = own !== null ? deps.projectName((caller as { projectPath: string }).projectPath) : cardProject
    if (!project) throw refused(say(A.checkNeedsCard))
    const command = await deps.checkCommand(project, name)
    if (!command) throw refused(say(A.noCommand, { project, name }))
    check = { name, command }
  }

  // In a copy: its lease's revision is the run's, whatever the card's is now (a later one is another review's).
  if (inCopy?.revision && named === null) revision = inCopy.revision
  return { card, revision, testedCheckout: tested, check, folder, ...(inCopy ? { copy: inCopy.copy } : {}) }
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

/** What's checked out in a folder (git: a run for no card, or for one with no start yet), or null where nothing is. */
export const folderHead = (folder: string): Promise<string | null> => gitReading(folder, ['rev-parse', '--verify', '--quiet', 'HEAD']).then((r) => (r.ok ? r.out.trim() || null : null))

/** The commit a revision names in a folder, in full, or null when it names none there. */
export const commitIn = (folder: string, revision: string): Promise<string | null> => gitReading(folder, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]).then((r) => (r.ok ? r.out.trim() || null : null))
