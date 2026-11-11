// The Git platform behind the adapter interface (SPEC §16.3.2): a card's folder and line, its revision, the submission's
// fixed endpoints and keys, containment, sameness, observation and check brackets, all on `git()` (git.ts).
//
// P2 spike (#1118): not wired into the app yet.

import { createHash } from 'crypto'
import { existsSync, statSync } from 'original-fs'
import { dirname, join } from 'path'
import { git } from '../git'
import { withRepoLock } from '../repoLock'
import type { CardState, FileChange } from '../../shared/workflow/facts'
import { trailerRefusal, type GuardInputs, type GuardRefusal } from '../../shared/workflow/guards'
import type { WorkflowOptions } from '../../shared/workflow/options'
import type { CardRecord } from '../workflow/factStore'
import { attributeFolder, reconcileHistory, type ReconcileHooks } from '../workflow/reconcile'
import { snapshot } from '../workflow/checks'
import { lineName, type Workflow } from '../workflow/runtime'
import type { CheckBracket, FinishInputs, HeadMove, LineNow, PlatformAdapter, RunRevision, StartPlan, SubmitPlan, Unsubmitted } from './adapter'
import * as G from './git'
import type { Disposable, ObserveEvent } from './history'
import { historyFor, observePort } from './historyPorts'
import { UNREADABLE } from '../../shared/workflow/texts'
import { samePath } from '../../shared/movePaths'
import { isUnknown, unknown, type Containment, type Maybe, type Unknown } from './types'
import { CW_DIR } from '../../shared/defaults'

/** A file's or folder's size and time, for a fingerprint ("gone" when it isn't there). */
function statLine(p: string): string {
  try {
    const s = statSync(p)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return 'gone'
  }
}

/** The most commits an unsubmitted read counts (HI-2245): past it, a lower bound. */
export const UNSUBMITTED_MAX = 100

const unknownRefusal =(card: CardRecord, what: Unknown, rule: string): GuardRefusal => ({ rule: 'platform.unknown', values: { card: card.key, what: what.whatText ?? what.what, rule } })

/** What `prime` reads once per intent for the evidence: the card's folder, and the tracked files it covers. */
interface Primed {
  gitDir: string | null
  folder: string | null
  files: string[]
  /** A shared folder's paths other agents locked (#1481), left out of what the evidence covers; null: none, the whole folder. */
  others: string[] | null
  /** The index as prime read it (`ls-files --stage`, the whole folder's), for content's first answer only (#1373). */
  staged?: Awaited<ReturnType<typeof git>>
  /** A card in Todo: the target its start plans on (startTarget, #1401), whose ref the evidence covers. */
  target?: string | null
}

/** A path another agent's current card locked (G16, #1481), and that card. */
interface Locked {
  path: string
  agent: string
  card: CardRecord
}

/** Whether a path is `p` or inside it. */
/** A commit id an agent can name: its full 40 hex characters, or at least 7 of them from the start (HI-2671). */
const COMMIT_ID = /^[0-9a-f]{7,40}$/

/**
 * HI-2671: why a revision an agent named (cw_submit's, a check's) isn't the head `h` checked out in `folder`, or null
 * when it is: the head's full id, or an unambiguous start of it (as `git log --oneline` shows it), in any case. A start
 * of it that git finds more commits for is refused as ambiguous; anything else (non-hex, too short, another commit)
 * names the head that is checked out.
 */
export async function notTheHead(folder: string, named: string, h: string): Promise<GuardRefusal | null> {
  const n = named.trim().toLowerCase()
  if (n === h) return null
  const shown = n.length > 12 ? `${n.slice(0, 12)}…` : n
  const refusal = (why: 'ambiguous' | 'other'): GuardRefusal => ({ rule: 'check.revisionMismatch', values: { revision: shown || named, head: h.slice(0, 12), why } }) // i18n-ignore: a refusal's code and values
  if (!COMMIT_ID.test(n) || !h.startsWith(n)) return refusal('other')
  // A start of the head: git's own answer says whether it names only that commit here.
  const id = await G.resolve(folder, n)
  return id === h ? null : refusal(isUnknown(id) || id === null ? 'ambiguous' : 'other')
}

const under = (f: string, p: string): boolean => f === p || f.startsWith(`${p}/`)

/** G16: files of the change that another agent's current card locked (a warning, never a refusal), each with that card. */
function othersFiles(others: Locked[], files: string[]): string[] {
  const out: string[] = []
  for (const f of files) for (const x of others) if (under(f, x.path)) out.push(`${f} is ${x.agent}'s (${x.card.key})`) // i18n-ignore: agent-facing warning in the submit's reply
  return out
}

export class GitPlatform implements PlatformAdapter {
  readonly id = 'git' as const
  /** Its history and evidence reads (port 3, HI-2787): reconciliation and attribution go through them. */
  private readonly history = historyFor(this.id)

  constructor(private wf: Workflow) {}

  private get project(): string {
    return this.wf.cfg.project
  }

  /**
   * The line a start of the card works on (HI-2753): the one it had, while that branch is still there and is this card's
   * own (`cw/<project>/<its key>…`), so a restart after a retitle keeps its work; else its name from its title now.
   */
  private async lineFor(card: CardRecord): Promise<Maybe<string>> {
    const named = lineName(this.wf.cfg.projectKey, card)
    const s = this.wf.state(card)
    const own = `cw/${this.wf.cfg.projectKey}/${card.key}`
    // Its newest own line still there: the last started first, then the others it had, newest first.
    for (const l of new Set([s.started?.line, ...[...s.lines].reverse()])) {
      if (!l || (l !== own && !l.startsWith(`${own}-`))) continue
      if (l === named) return named
      const h = await G.lineHead(this.project, l)
      if (isUnknown(h)) return h
      if (h) return l
    }
    return named
  }

  async start(card: CardRecord, o: WorkflowOptions, builder?: string, dry = false): Promise<Maybe<StartPlan>> {
    // Before P7 (SPEC §16.19.1): the builder's own worktree stands in for a slot, and is where its work is whatever the
    // folder option says (as P3 recorded it). Its line is the worktree's branch, and the card's base the merge base of its
    // head with the target's (sound: a lane's next card starts once the last is Done).
    const own = builder && this.wf.cfg.agentFolder ? await this.wf.cfg.agentFolder(builder) : null
    if (own) {
      const target = card.target || o.target || own.base || (await G.defaultBranch(this.project))
      if (isUnknown(target)) return target
      // In one git (#1376); the target read in the worktree, whose branches are the project's.
      const { line, head, target: th } = await G.heads(own.path, target)
      if (isUnknown(line)) return line
      if (isUnknown(head)) return head
      if (isUnknown(th)) return th
      if (!head) return unknown(UNREADABLE.head, { where: own.path })
      if (!th) return unknown(UNREADABLE.head, { where: target })
      const base = head === th ? head : await G.mergeBase(own.path, head, th)
      if (isUnknown(base)) return base
      if (!base) return unknown(UNREADABLE.branchedOff, { a: line ?? own.path, b: target })
      return { folder: own.path, line, base, target, existing: true }
    }
    // A no-code card takes no slot (HI-2335): it changes nothing, so it starts where its agent is (`project`: no folder
    // of its own, its agent left where it runs, a lane's kept slot included), as with no slot here. Code cards go on.
    if (o.folder === 'slots' && this.wf.cfg.slotFor && card.kind === 'no-code') return this.start(card, { ...o, folder: 'project' })
    if (o.folder === 'slots' && this.wf.cfg.slotFor) {
      // Slots (#1438, SPEC §16.10): the card's own line from the target's head, in the slot its builder is lent (its
      // lane's, kept for the lane, else the card's own). None free: it waits for one (refused `start.slotAvailable`;
      // the user's start across it works where the agent is). No slot here (the rules off): where the agent is, as P3.
      const target = card.target || o.target || (await G.defaultBranch(this.project))
      if (isUnknown(target)) return target
      const got = builder ? await this.wf.cfg.slotFor(card, builder, { dry, target }) : null
      if (!got || 'wait' in got) {
        const here = await this.start(card, { ...o, folder: 'project' })
        return got && !isUnknown(here) ? { ...here, slotWait: got.wait } : here
      }
      const th = await G.lineHead(this.project, target)
      if (isUnknown(th)) return th
      if (!th) return unknown(UNREADABLE.head, { where: target })
      const line = await this.lineFor(card)
      if (isUnknown(line)) return line
      // A line of its from an earlier start (put back, then started again) carries on: its base is where it left the target.
      const had = await G.lineHead(this.project, line)
      if (isUnknown(had)) return had
      const base = had && had !== th ? await G.mergeBase(this.project, had, th) : th
      if (isUnknown(base)) return base
      if (!base) return unknown(UNREADABLE.branchedOff, { a: line, b: target })
      return { folder: got.folder, line, base, target, slot: got.slot, lease: got.lease, fresh: got.fresh }
    }
    if (o.folder === 'slots') {
      const target = card.target || o.target || (await G.defaultBranch(this.project))
      if (isUnknown(target)) return target
      const base = await G.lineHead(this.project, target)
      if (isUnknown(base)) return base
      if (!base) return unknown(UNREADABLE.head, { where: target })
      const line = await this.lineFor(card)
      if (isUnknown(line)) return line
      return { folder: join(this.wf.cfg.slots ?? join(this.project, CW_DIR, 'slots'), card.key), line, base, target }
    }
    const line = await G.branch(this.project)
    const base = await G.head(this.project)
    if (isUnknown(line)) return line
    if (isUnknown(base)) return base
    // Committed is done: the target is the line the folder works on.
    return { folder: 'project', line, base, target: o.finish === 'committed' ? line : card.target || o.target || line }
  }

  /**
   * The target `start` plans on, by its rule (#1401): with the builder's worktree (`own`), the card's, G7's, the
   * worktree's base, else the repository's default branch; slots, the card's, G7's, else the default branch; in the
   * project folder, the card's or G7's, or the line the folder works on (always, when finishing is a commit). Kept
   * beside `start`, whose branches it follows: `tests/workflow/boundaries.test.ts` checks the two agree.
   */
  async startTarget(card: CardRecord, o: WorkflowOptions, builder?: string): Promise<Maybe<string | null>> {
    const own = builder && this.wf.cfg.agentFolder ? await this.wf.cfg.agentFolder(builder) : null
    if (own) return card.target || o.target || own.base || G.defaultBranch(this.project)
    if (o.folder === 'slots' && !(card.kind === 'no-code' && this.wf.cfg.slotFor) && (this.slotsHere() || !this.wf.cfg.agentFolder)) return card.target || o.target || G.defaultBranch(this.project)
    if (o.finish !== 'committed' && (card.target || o.target)) return card.target || o.target
    return G.branch(this.project)
  }

  /** Whether a start here asks for a slot (#1438): the app's lending, while the rules are enforced. */
  private slotsHere(): boolean {
    return !!this.wf.cfg.slotFor && (this.wf.cfg.enforced?.() ?? true)
  }

  /** The plan's target is the one prime resolved and the evidence covers (a Todo card's; otherwise nothing was resolved). */
  planCovered(primed: unknown, plan: StartPlan): boolean {
    const p = primed as Primed | null
    return !p || p.target === undefined || p.target === plan.target
  }

  private common: string | null = null

  /** The slow part of the evidence, once per intent: the git folders, and the tracked files (and their folders) it covers. */
  async prime(card: CardRecord, s: CardState, o: WorkflowOptions, builder?: string): Promise<unknown> {
    if (!this.common) {
      const c = await G.commonDir(this.project)
      if (!isUnknown(c)) this.common = c
    }
    // A card in Todo has no folder of its own yet (or an earlier cycle's, gone): a start decides on its target alone,
    // resolved as the start resolves it (an empty G7 is the default branch, #1401). Unreadable: the evidence says so.
    if (!s.started || s.stage === 'todo') {
      const target = await this.startTarget(card, o, builder)
      if (isUnknown(target)) return null
      return { gitDir: null, folder: null, files: [], others: null, target } satisfies Primed
    }
    const folder = this.wf.folderOf(s)
    // Its git dir from its `.git` where it has one (no git process: #1373), else git's answer.
    let gitDir = G.gitDirSync(folder)
    if (!gitDir) {
      const gd = await git(folder, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'])
      if (!gd.ok) return null
      gitDir = gd.out.trim()
    }
    // The index's entries, once (#1373): the tracked files (a conflicted path's stages listed once), and content's first
    // answer where it covers the whole folder.
    const ls = await git(folder, ['ls-files', '--stage', '-z'])
    if (!ls.ok) return null
    // In a shared folder other agents' locked paths don't count (their edits are "not yours", §16.3.2's dirty, #1481),
    // unless this card recorded them too: ls-files gives paths relative to the folder, as the records are.
    const locked = this.wf.ownLine(s) ? [] : this.notMine(card, s).map((x) => x.path)
    const others = locked.length ? locked : null
    const all = [...new Set(ls.out.split('\0').filter(Boolean).map((rec) => rec.slice(rec.indexOf('\t') + 1)))]
    const files = others ? all.filter((f) => !others.some((p) => under(f, p))) : all
    return { gitDir, folder, files, others, ...(others ? {} : { staged: ls }) } satisfies Primed
  }

  /**
   * The state a card's guards read (ARCHITECTURE "The one path"): the target's and the line's refs, the folder's own
   * HEAD (a checkout or reset elsewhere shows), its index and any merge, rebase or cherry-pick under way, and each
   * covered tracked file's and folder's size and time (an edit, or a new file beside them, shows). Null when unreadable.
   */
  evidence(card: CardRecord, s: CardState, o: WorkflowOptions, primed: unknown): string | null {
    const p = primed as Primed | null
    if (!this.common || !p) return null
    // A card in Todo: the target its start plans on (prime's, #1401); started, the one it recorded.
    const target = p.target !== undefined ? p.target : (s.started?.target ?? card.target ?? o.target)
    const line = s.stage === 'todo' ? null : s.started?.line
    const parts = [target ? G.refSync(this.common, `refs/heads/${target}`) : '', line ? G.refSync(this.common, `refs/heads/${line}`) : '']
    if (p.gitDir && p.folder) {
      parts.push(`HEAD:${G.refSync(p.gitDir, 'HEAD') ?? ''}`, statLine(join(p.gitDir, 'index')))
      for (const m of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) parts.push(existsSync(join(p.gitDir, m)) ? m : '')
      const dirs = new Set<string>(['.'])
      for (const f of p.files) {
        parts.push(statLine(join(p.folder, f)))
        dirs.add(dirname(f))
      }
      for (const d of [...dirs].sort()) parts.push(statLine(join(p.folder, d)))
    }
    return parts.join('|')
  }

  /**
   * Git's own answer about what `evidence` covers (#1206): the same refs, HEAD and operations, the index's entries (mode,
   * object id, stage, path: `ls-files --stage`) and the content of each covered file that differs from them (the files
   * `diff-files` lists, hashed by `hash-object` with the path's own attributes, filters and line endings; one whose
   * content is its entry's, only its stat differing, isn't listed). An outside `git status`
   * refreshing the index's stat data, or a file only touched, changes the stat fingerprint but not this. Null when git
   * can't say. Never read inside the transaction (it runs git): the runtime asks it when the fingerprint moved.
   */
  async content(card: CardRecord, s: CardState, o: WorkflowOptions, primed: unknown): Promise<string | null> {
    const p = primed as Primed | null
    if (!this.common || !p) return null
    // A card in Todo: the target its start plans on (prime's, #1401); started, the one it recorded.
    const target = p.target !== undefined ? p.target : (s.started?.target ?? card.target ?? o.target)
    const line = s.stage === 'todo' ? null : s.started?.line
    const parts = [target ? G.refSync(this.common, `refs/heads/${target}`) : '', line ? G.refSync(this.common, `refs/heads/${line}`) : '']
    if (p.gitDir && p.folder) {
      parts.push(`HEAD:${G.refSync(p.gitDir, 'HEAD') ?? ''}`)
      for (const m of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) parts.push(existsSync(join(p.gitDir, m)) ? m : '')
      // In a shared folder, all but other agents' locked paths (#1481).
      {
        const spec = p.others ? ['--', '.', ...p.others.map((x) => `:(exclude,literal)${x}`)] : []
        // Prime's read of the index, just before, answers the first time (evidenceOf's); asked again (revalidate), git.
        const first = p.staged
        delete p.staged
        const staged = first ?? (await git(p.folder, ['ls-files', '--stage', '-z', ...spec]))
        const differ = await git(p.folder, ['diff-files', '--name-only', '-z', ...spec])
        if (!staged.ok || !differ.ok) return null
        parts.push(`index:${createHash('sha256').update(staged.buf).digest('hex')}`)
        // Each entry's object id, to tell a file whose stat alone differs (diff-files lists it: it doesn't refresh).
        const ids = new Map<string, string>()
        for (const rec of staged.out.split('\0')) {
          const m = rec.match(/^\d+ ([0-9a-f]+) 0\t(.*)$/s)
          if (m) ids.set(m[2], m[1])
        }
        const changed = differ.out.split('\0').filter(Boolean).sort()
        const present = changed.filter((f) => existsSync(join(p.folder!, f)))
        let oids: string[] = []
        if (present.length) {
          const h = await git(p.folder, ['hash-object', '--stdin-paths'], undefined, present.join('\n') + '\n')
          oids = h.ok ? h.out.split(/\r?\n/).filter(Boolean) : []
          if (oids.length !== present.length) return null
        }
        for (const f of changed) {
          const oid = present.includes(f) ? oids[present.indexOf(f)] : 'gone'
          if (oid !== ids.get(f)) parts.push(`${f}:${oid}`)
        }
      }
      // As in the fingerprint: a file made or removed beside the covered ones.
      const dirs = new Set<string>(['.'])
      for (const f of p.files) dirs.add(dirname(f))
      for (const d of [...dirs].sort()) parts.push(statLine(join(p.folder, d)))
    }
    return parts.join('|')
  }

  async revisionNow(card: CardRecord, s: CardState): Promise<Maybe<string | null>> {
    if (card.kind === 'no-code') return null
    if (this.wf.ownLine(s)) return G.head(this.wf.folderOf(s))
    return s.attributed.at(-1) ?? s.started?.base ?? null
  }

  /** The card's revision (its folder's head, or its newest attributed commit), and what's checked out where the run runs. */
  async runRevision(card: CardRecord, s: CardState, folder: string | null, named: string | null): Promise<RunRevision> {
    const known = (v: Maybe<string | null>): string | null => (isUnknown(v) ? null : v)
    const revision = known(await this.revisionNow(card, s))
    // Run in the card's own folder (its slot), what's checked out is the head just read as its revision: read once
    // (HI-1783: each git process was main's to start).
    const own = card.kind !== 'no-code' && this.wf.ownLine(s) && folder !== null && samePath(folder, this.wf.folderOf(s))
    const tested = own ? revision : folder ? known(await G.head(folder)) : null
    return { revision, tested, testedIs: 'checkout', ...(named !== null ? { named: folder ? known(await G.resolve(folder, named)) : null } : {}) }
  }

  async submission(card: CardRecord, s0: CardState, o: WorkflowOptions, args: { revision?: string; agent: string | null; guards: readonly string[]; predicted?: boolean }): Promise<SubmitPlan> {
    let s = s0
    const folder = this.wf.folderOf(s)
    let revision: string | null
    let base: string | null
    let commits: string[] | undefined
    let dirty: Maybe<string[]> | undefined
    if (this.wf.ownLine(s)) {
      // Its head and the target's, with its uncommitted state when a guard asks for it, read together (#1376): the target
      // read in the folder, whose branches are the project's.
      const target = s.started!.target ?? ''
      const now = args.guards.includes('submit.clean') && target ? await G.worktreeNow(folder, { target }) : null
      // Unreadable that way (or no commit yet): each read on its own, as before.
      const got = now && !isUnknown(now) && now.head ? now : null
      const read = got ? null : await G.heads(folder, target)
      const h = got ? got.head! : read!.head
      if (isUnknown(h)) return { ok: false, refusal: unknownRefusal(card, h, 'submit') }
      const mismatch = args.revision ? await notTheHead(folder, args.revision, h) : null
      if (mismatch) return { ok: false, refusal: mismatch }
      revision = h
      dirty = got?.dirty
      // The change's base: the merge base with the target at this moment, fixed with the submission.
      const th = got ? (got.target ?? null) : read!.target
      // HI-2753: the target it started on is gone (an integration branch merged and deleted): said so, with its way on.
      if (th === null && target) return { ok: false, refusal: { rule: 'platform.targetGone', values: { card: card.key, target } } }
      const mb = !isUnknown(th) && th ? (th === h ? h : await G.mergeBase(this.project, th, h)) : th
      if (isUnknown(mb) || !mb) return { ok: false, refusal: unknownRefusal(card, unknown(UNREADABLE.branchedOffTarget), 'submit') }
      base = mb
    } else {
      // A shared folder: the card's change is its own attributed commits (§16.3.2), attributed by reconciling first; a
      // start not written yet (a drag planning, #1265) has none yet, and nothing is written for it.
      if (!args.predicted) {
        await reconcileHistory(this.wf, this.history, card, {})
        s = this.wf.state(card)
      }
      commits = s.attributed
      revision = commits.at(-1) ?? s.started!.base
      base = s.started!.base
    }
    let files: FileChange[] = []
    let key: string | null = null
    if (revision && base) {
      const c = commits && commits.length ? await this.ownChange(base, commits) : await G.change(this.project, base, revision)
      if (isUnknown(c)) return { ok: false, refusal: unknownRefusal(card, c, 'submit') }
      files = c.files
      key = c.key
    }
    if (!revision || revision === base || !files.length) {
      // Whether its folder has changes says which next step fits (HI-2227): commit them, or a card needing none is no-code.
      // In a shared folder, other agents' recorded changes aren't this card's.
      if (args.predicted) return { ok: false, refusal: { rule: 'submit.empty', values: { card: card.key } } }
      // HI-2562: nothing of its own, but a commit naming no card since it started, with another card's agent in the
      // folder: most likely its own work without the trailer, so the trailer's refusal (the commit, and the amend that
      // fixes it when it is the head, else a report for the user), not "nothing committed". Whatever the rules hold: the submit is refused either way, and with every
      // rule off (no submit.trailer) the amend is still what lets it through.
      if (commits) {
        const u = await this.untrailered(card, s)
        if (isUnknown(u)) return { ok: false, refusal: unknownRefusal(card, u, 'submit') }
        if (u) return { ok: false, refusal: trailerRefusal(this.id, card.key, u) }
      }
      const all = dirty ?? (await G.dirty(folder))
      const notMine = this.wf.ownLine(s) || isUnknown(all) ? [] : await this.inRepo(this.notMine(card, s))
      const mine = isUnknown(all) ? null : all.filter((f) => !notMine.some((x) => under(f, x.path)))
      return { ok: false, refusal: { rule: 'submit.empty', values: { card: card.key, ...(mine ? { changes: mine.length ? 'yes' : 'none' } : {}) } } }
    }
    // The guards' platform inputs, gathered only for the guards the ruleset holds.
    const inputs: Partial<GuardInputs> = {}
    const shared = !this.wf.ownLine(s)
    // In a shared folder, other agents' locked changes aren't this card's, unless it recorded them too (#1481); git's
    // paths are the repository's. G16 warns of every other agent's recorded file the change includes.
    const others = shared ? await this.inRepo(this.othersLocked(card, s)) : []
    const notMine = shared ? await this.inRepo(this.notMine(card, s)) : []
    if (args.guards.includes('submit.clean')) {
      const all = dirty ?? (await G.dirty(folder))
      inputs.dirty = isUnknown(all) || !notMine.length ? all : all.filter((f) => f.startsWith('(') || !notMine.some((x) => under(f, x.path)))
    }
    if (args.guards.includes('submit.ready')) inputs.conflicts = [] // a Git commit can't store unresolved conflicts
    if (args.guards.includes('submit.trailer')) inputs.untrailered = await this.untrailered(card, s)
    if (args.guards.includes('submit.identity')) inputs.badIdentity = await this.badIdentity(base!, revision, commits, o)
    const warnings = o.sharedFolderWarning && shared ? othersFiles(others, files.map((f) => f.path)) : []
    return { ok: true, revision, base, key, files, ...(commits ? { commits } : {}), inputs, warnings }
  }

  /** The combined change of a shared-folder card's own commits, applied in order (§16.3.2). */
  private async ownChange(base: string, commits: string[]): Promise<Maybe<{ files: FileChange[]; key: string | null }>> {
    const files = new Map<string, string>()
    const keys: string[] = []
    for (const c of commits) {
      const parent = await G.resolve(this.project, `${c}^`)
      if (isUnknown(parent)) return parent
      const ch = await G.change(this.project, parent ?? base, c)
      if (isUnknown(ch)) return ch
      for (const f of ch.files) files.set(f.path, f.status)
      if (ch.key) keys.push(ch.key)
    }
    return { files: [...files].map(([path, status]) => ({ path, status })), key: keys.length ? keys.join('+') : null }
  }

  /**
   * A commit attributed to no card, made in the folder since the card's last submission, when another unfinished card
   * shares it: the newest, with whether it is the folder's head (HI-2562, HR1's round 1: only then does an amend fix it
   * without rewriting the commits after it). Only one made since the card started and still on the folder's line (one
   * an amend or a reset replaced isn't, nor one from before it started).
   */
  private async untrailered(card: CardRecord, s: CardState): Promise<Maybe<{ commit: string; head: boolean } | null>> {
    const others = this.wf.store.cards().filter((c) => c.id !== card.id && ['active', 'review', 'approved'].includes(c.stage) && this.wf.state(c).started?.folder === 'project')
    if (!others.length) return null
    const lastSub = s.latest?.commits?.at(-1)
    const rows = this.wf.store.folderCommits(this.project)
    const since = (lastSub ? rows.slice(rows.findIndex((x) => x.sha === lastSub) + 1) : rows).filter((x) => x.card === null && x.sha !== s.started!.base)
    if (!since.length) return null
    const head = await G.head(this.project)
    if (isUnknown(head)) return head
    if (!head) return null
    const base = s.started!.base
    for (const x of since.reverse()) {
      const on = await G.isAncestor(this.project, x.sha, head)
      if (isUnknown(on)) return on
      if (!on) continue
      const after = base ? await G.isAncestor(this.project, base, x.sha) : true
      if (isUnknown(after)) return after
      if (after) return { commit: x.sha, head: x.sha === head }
    }
    return null
  }

  /**
   * Other agents' lock records (G16, #1481): the paths each other agent's current card locked this cycle, relative to the
   * project folder, with that card; never this card's nor its builder's.
   */
  private othersLocked(card: CardRecord, s: CardState): Locked[] {
    const out: Locked[] = []
    for (const [agent, c] of this.wf.currentCards()) {
      if (c.card.id === card.id || agent === s.started?.builder) continue
      for (const path of c.s.locked) out.push({ path, agent, card: c.card })
    }
    return out
  }

  /**
   * What a shared folder leaves out of this card's own (its dirty files, its evidence): other agents' recorded paths,
   * except those this card recorded too (HR6's #1481 round 2: both agents locked one file in turn, and the submitter's
   * own uncommitted edit to it still counts).
   */
  private notMine(card: CardRecord, s: CardState): Locked[] {
    return this.othersLocked(card, s).filter((x) => !s.locked.some((p) => under(x.path, p) || under(p, x.path)))
  }

  /** Locked paths as git's status and diffs give them: relative to the repository's root. */
  private async inRepo(locked: Locked[]): Promise<Locked[]> {
    if (!locked.length) return locked
    const prefix = await this.repoPrefix()
    return locked.map((x) => ({ ...x, path: prefix + x.path }))
  }

  private prefix: string | null = null

  /** The project folder's place in its repository (`sub/dir/`; '' at its root), read once. */
  private async repoPrefix(): Promise<string> {
    if (this.prefix === null) {
      const r = await git(this.project, ['rev-parse', '--show-prefix'])
      if (!r.ok) return ''
      this.prefix = r.out.trim()
    }
    return this.prefix
  }

  /**
   * G12: the first commit not authored with the project's identity, as git reads it now (HI-2266: G12's saved value only
   * means "on"; the Git tab or git config changes the identity, and the guard expects the new one), or `missing`.
   */
  private async badIdentity(base: string, revision: string, commits: string[] | undefined, o: WorkflowOptions): Promise<Maybe<{ commit: string; email: string } | 'missing' | null>> {
    if (!o.identity) return null
    const id = await G.identity(this.project)
    if (isUnknown(id)) return id
    if (!id) return 'missing'
    const list = await G.commits(this.project, `${base}..${revision}`)
    if (isUnknown(list)) return list
    const mine = commits ? list.filter((c) => commits.includes(c.commit)) : list
    const bad = mine.find((c) => c.email.toLowerCase() !== id.email.toLowerCase())
    return bad ? { commit: bad.commit, email: id.email } : null
  }

  async finishInputs(card: CardRecord, s: CardState, o: WorkflowOptions, revision: string | null | undefined): Promise<FinishInputs> {
    if (card.kind === 'no-code' || !revision || o.finish !== 'committed' || !s.started?.line) return {}
    const lh = await G.lineHead(this.project, s.started.line)
    if (isUnknown(lh)) return { contained: lh }
    return { contained: lh ? await G.isAncestor(this.project, revision, lh) : false }
  }

  async headMoved(_card: CardRecord, s: CardState, o: WorkflowOptions, from: { base: string | null; revision: string; key?: string | null }): Promise<HeadMove | null> {
    if (!this.wf.ownLine(s)) return null
    const h = await G.head(this.wf.folderOf(s))
    if (isUnknown(h) || h === from.revision) return null
    const th = await G.lineHead(this.project, s.started!.target ?? '')
    const b2 = !isUnknown(th) && th ? await G.mergeBase(this.project, th, h) : null
    const base = b2 && !isUnknown(b2) ? b2 : null
    const same = o.sameness === 'change' && !!base && !!from.base && (await G.sameChange(this.project, { base: from.base, revision: from.revision, key: from.key }, { base, revision: h }))
    return { to: h, base, same }
  }

  /**
   * HI-2245: the commits on the card's line past its submission, in its folder (its slot, or the project folder) as
   * checked out there. Proven only: the folder there, on the card's line (not another branch, not detached), its HEAD the
   * project's line ref (read in the project, HR2's round 1: a clone put in its place has a line of the same name), the
   * folder one of the project's own worktrees (the same common git dir), the submission strictly an ancestor of it, and,
   * in the shared folder, only the commits attributed to the card. The folder is read again after the history: a
   * checkout, reset or swap meanwhile drops it. A dirty tree is never read.
   */
  async unsubmitted(card: CardRecord, s0: CardState, submitted: string, between?: () => void | Promise<void>): Promise<Unsubmitted | null> {
    const line = s0.started?.line
    if (card.kind === 'no-code' || !line) return null
    const folder = this.wf.folderOf(s0)
    const shared = !this.wf.ownLine(s0)
    const repo = await G.commonDir(this.project)
    if (isUnknown(repo)) return null
    const at = async (): Promise<string | null> => {
      if (!existsSync(folder)) return null
      const [c, b, h, lh] = await Promise.all([G.commonDir(folder), G.branch(folder), G.head(folder), G.lineHead(this.project, line)])
      if (isUnknown(c) || isUnknown(b) || isUnknown(h) || isUnknown(lh) || !samePath(c, repo)) return null
      return b !== line || !lh || h !== lh ? null : h
    }
    // The shared folder's attribution brought up to date first: a commit just made is the card's once attributed.
    if (shared && !(await attributeFolder(this.wf, {}, this.history).then(() => true, () => false))) return null
    const head = await at()
    if (!head || head === submitted || (await G.isAncestor(folder, submitted, head)) !== true) return null
    const ids = await G.commitIds(folder, `${submitted}..${head}`, UNSUBMITTED_MAX + 1)
    if (isUnknown(ids)) return null
    const capped = ids.length > UNSUBMITTED_MAX
    const read = ids.slice(0, UNSUBMITTED_MAX)
    // In the shared folder, of those on the line now, only the card's: an old attribution elsewhere never counts.
    const mine = shared ? new Set(this.wf.state(card).attributed) : null
    const count = mine ? read.filter((c) => mine.has(c)).length : read.length
    await between?.()
    if (!count || (await at()) !== head) return null
    return { count, atLeast: capped, since: submitted.slice(0, 7) }
  }

  contains(target: string, change: { base: string; revision: string; key?: string | null }, at?: string): Promise<Maybe<Containment | null>> {
    return G.contains(this.project, target, change, at)
  }

  targetHead(target: string): Promise<Maybe<string | null>> {
    return G.lineHead(this.project, target)
  }

  async lineNow(folder: string, target: string): Promise<Maybe<LineNow>> {
    // The target read in the folder: an agent's worktree is the project's, its branches the same (as the move reads it).
    const now = await G.worktreeNow(folder, { target })
    if (isUnknown(now)) return now
    const { line, head, dirty, target: th } = now
    if (!head) return unknown(UNREADABLE.head, { where: folder })
    if (!th) return unknown(UNREADABLE.head, { where: target })
    const inTarget = head === th || (await G.isAncestor(folder, head, th))
    if (isUnknown(inTarget)) return inTarget
    return { line, head, targetHead: th, inTarget, dirty }
  }

  async moveLine(folder: string, to: string, expect: { line: string | null; head: string; target?: string }, go: () => boolean): Promise<true | string | null> {
    // Under the repository lock (#1347): a merge into the repository, from this Combwork or another, isn't moving refs meanwhile.
    // Another Combwork merging past the lock's wait: nothing moved, and the lane waits for the next pass.
    // What the move itself throws (a move part way, not put back) is the caller's, as before.
    let ran = false
    return withRepoLock(folder, () => ((ran = true), G.moveLineLocked(folder, to, expect, go)), { quiet: true, project: this.project }).catch((e: unknown) => {
      if (ran) throw e
      return null
    })
  }

  async commitsBetween(folder: string, from: string, to: string): Promise<Maybe<string[]>> {
    const c = await G.commits(folder, `${from}..${to}`)
    return isUnknown(c) ? c : c.map((x) => `${x.commit.slice(0, 7)} ${x.subject}`)
  }

  reconcile(card: CardRecord, hooks: ReconcileHooks): Promise<void> {
    return reconcileHistory(this.wf, this.history, card, hooks)
  }

  /**
   * A Git check (§16.13): the tested checkout contains the card's revision, the folder clean at the start and the end,
   * and nothing written to a tracked file and no HEAD reflog entry in between: the watcher's write log (observe.ts), or,
   * where it has no complete record of the run (the folder not watched, the watch down meanwhile), a stat snapshot of the
   * tracked files and the reflog's length taken at the start and the end.
   */
  async checkRun(card: CardRecord, s: CardState, run: { command: string | undefined; revision?: string; isolated?: string; exec: (command: string, folder: string) => Promise<{ ok: boolean }> }): Promise<CheckBracket | GuardRefusal> {
    const folder = run.isolated ?? this.wf.folderOf(s)
    const rev = await this.revisionNow(card, s)
    // The folder before the run, its reads at once (#1478: S58's four runs were a long chain of gits): its head from the
    // uncommitted state's `status --branch` (head() where that can't say), the tracked files, its git dir from `.git`.
    const [before, ls] = await Promise.all([G.worktreeNow(folder), git(folder, ['ls-files', '-z'])])
    const h = !isUnknown(before) && before.head ? before.head : await G.head(folder)
    if (isUnknown(rev) || !rev || isUnknown(h)) return unknownRefusal(card, unknown(UNREADABLE.revisionIn, { folder }), 'submit.checksPassed')
    const mismatch = run.revision ? await notTheHead(folder, run.revision, h) : null
    if (mismatch) return mismatch
    const files = ls.out.split('\0').filter(Boolean)
    const gitDir = G.gitDirSync(folder) ?? (await git(folder, ['rev-parse', '--absolute-git-dir']).then((r) => (r.ok ? r.out.trim() : null)))
    const dirtyA = isUnknown(before) ? before : before.dirty
    const snapA = await snapshot(folder, files, gitDir)
    const t0 = Date.now()
    const ok = run.command ? (await run.exec(run.command, folder)).ok : false
    const seen = await observePort.changedBetween(folder, t0, Date.now())
    const snapB = await snapshot(folder, files, gitDir)
    const after = await G.worktreeNow(folder)
    const dirtyB = isUnknown(after) ? after : after.dirty
    const headB = !isUnknown(after) && after.head ? after.head : await G.head(folder)
    const contained = h === rev || (await G.isAncestor(this.project, rev, h)) === true
    let whyNot: CheckBracket['whyNot']
    if (!run.command) whyNot = 'notCheck'
    else if (!contained) whyNot = 'notContained'
    else if (isUnknown(dirtyA) || isUnknown(dirtyB) || dirtyA.length || dirtyB.length) whyNot = 'dirty'
    else if (headB !== h) whyNot = 'moved'
    else if (isUnknown(seen) ? snapA !== snapB : seen.changed) whyNot = 'changed'
    return { revision: rev, tested: h, ok, ...(whyNot ? { whyNot } : {}) }
  }

  observe(onChange: (e: ObserveEvent) => void): Disposable {
    return observePort.subscribe(this.project, onChange)
  }

  async checkCopy(card: CardRecord, s: CardState, folder: string): Promise<string | null> {
    const rev = await this.revisionNow(card, s)
    if (isUnknown(rev) || !rev) return null
    const r = await git(this.project, ['worktree', 'add', '--detach', folder, rev])
    return r.ok ? folder : null
  }

  async perform(kind: string, payload: Record<string, unknown>): Promise<boolean> {
    if (kind === 'prepareSlot') {
      const f = await G.isolate(this.project, String(payload.folder), String(payload.line), String(payload.base))
      if (isUnknown(f)) throw new Error(f.what) // i18n-ignore: an action's failure, recorded on the action
      return true
    }
    if (kind === 'pin') {
      if (!(await G.pin(this.project, String(payload.ref), String(payload.revision)))) throw new Error(`pinning ${String(payload.revision)} failed`) // i18n-ignore: an action's failure, recorded on the action
      return true
    }
    return false
  }
}
