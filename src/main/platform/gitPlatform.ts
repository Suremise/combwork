// The Git platform behind the adapter interface (SPEC §16.3.2): a card's folder and line, its revision, the submission's
// fixed endpoints and keys, containment, sameness, observation and check brackets, all on `git()` (git.ts).
//
// P2 spike (#1118): not wired into the app yet.

import { createHash } from 'crypto'
import { existsSync, statSync } from 'original-fs'
import { dirname, join } from 'path'
import { git } from '../git'
import type { CardState, FileChange } from '../../shared/workflow/facts'
import type { GuardInputs, GuardRefusal } from '../../shared/workflow/guards'
import type { WorkflowOptions } from '../../shared/workflow/options'
import type { CardRecord } from '../workflow/factStore'
import { reconcileGit, type ReconcileHooks } from '../workflow/reconcile'
import { snapshot } from '../workflow/checks'
import { slugOf, type Workflow } from '../workflow/runtime'
import type { CheckBracket, FinishInputs, HeadMove, PlatformAdapter, StartPlan, SubmitPlan } from './adapter'
import * as G from './git'
import { observer, type Disposable, type ObserveEvent } from './observe'
import { isUnknown, type Containment, type Maybe } from './types'

/** A file's or folder's size and time, for a fingerprint ("gone" when it isn't there). */
function statLine(p: string): string {
  try {
    const s = statSync(p)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return 'gone'
  }
}

const unknownRefusal = (card: CardRecord, what: string, rule: string): GuardRefusal => ({ rule: 'platform.unknown', values: { card: card.key, what, rule } })

/** What `prime` reads once per intent for the evidence: the card's folder, and the tracked files it covers. */
interface Primed {
  gitDir: string | null
  folder: string | null
  files: string[]
  /** A shared folder's own paths (what the evidence covers there), or null: the whole folder. */
  own: string[] | null
}

export class GitPlatform implements PlatformAdapter {
  readonly id = 'git' as const

  constructor(private wf: Workflow) {}

  private get project(): string {
    return this.wf.cfg.project
  }

  async start(card: CardRecord, o: WorkflowOptions): Promise<Maybe<StartPlan>> {
    if (o.folder === 'slots') {
      const target = card.target || o.target || (await G.defaultBranch(this.project))
      if (isUnknown(target)) return target
      const base = await G.lineHead(this.project, target)
      if (isUnknown(base)) return base
      if (!base) return { unknown: true, what: `the head of ${target}` }
      const slug = slugOf(card.title)
      const line = `hive/${this.wf.cfg.projectKey}/${card.key}${slug ? `-${slug}` : ''}`
      return { folder: join(this.wf.cfg.slots, card.key), line, base, target }
    }
    const line = await G.branch(this.project)
    const base = await G.head(this.project)
    if (isUnknown(line)) return line
    if (isUnknown(base)) return base
    // Committed is done: the target is the line the folder works on.
    return { folder: 'project', line, base, target: o.finish === 'committed' ? line : card.target || o.target || line }
  }

  private common: string | null = null

  /** The slow part of the evidence, once per intent: the git folders, and the tracked files (and their folders) it covers. */
  async prime(card: CardRecord, s: CardState): Promise<unknown> {
    if (!this.common) {
      const c = await G.commonDir(this.project)
      if (!isUnknown(c)) this.common = c
    }
    // A card in Todo has no folder of its own yet (or an earlier cycle's, gone): a start decides on its target alone.
    if (!s.started || s.stage === 'todo') return { gitDir: null, folder: null, files: [], own: null } satisfies Primed
    const folder = this.wf.folderOf(s)
    const gd = await git(folder, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'])
    const ls = await git(folder, ['ls-files', '-z'])
    if (!gd.ok || !ls.ok) return null
    // In a shared folder only the builder's own paths count (others' edits are "not yours", §16.3.2's dirty).
    const own = !this.wf.ownLine(s) && this.wf.cfg.locksOf ? this.wf.cfg.locksOf(s.started.builder) : null
    const all = ls.out.split('\0').filter(Boolean)
    const files = own ? all.filter((f) => own.some((p) => f === p || f.startsWith(`${p}/`))) : all
    return { gitDir: gd.out.trim(), folder, files, own } satisfies Primed
  }

  /**
   * The state a card's guards read (ARCHITECTURE "The one path"): the target's and the line's refs, the folder's own
   * HEAD (a checkout or reset elsewhere shows), its index and any merge, rebase or cherry-pick under way, and each
   * covered tracked file's and folder's size and time (an edit, or a new file beside them, shows). Null when unreadable.
   */
  evidence(card: CardRecord, s: CardState, o: WorkflowOptions, primed: unknown): string | null {
    const p = primed as Primed | null
    if (!this.common || !p) return null
    const target = s.started?.target ?? card.target ?? o.target
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
    const target = s.started?.target ?? card.target ?? o.target
    const line = s.stage === 'todo' ? null : s.started?.line
    const parts = [target ? G.refSync(this.common, `refs/heads/${target}`) : '', line ? G.refSync(this.common, `refs/heads/${line}`) : '']
    if (p.gitDir && p.folder) {
      parts.push(`HEAD:${G.refSync(p.gitDir, 'HEAD') ?? ''}`)
      for (const m of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) parts.push(existsSync(join(p.gitDir, m)) ? m : '')
      // A shared folder with no paths of the builder's: nothing of the index or files is covered.
      if (!p.own || p.own.length) {
        const spec = p.own ? ['--', ...p.own] : []
        const staged = await git(p.folder, ['ls-files', '--stage', '-z', ...spec])
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

  async submission(card: CardRecord, s0: CardState, o: WorkflowOptions, args: { revision?: string; agent: string | null; guards: readonly string[] }): Promise<SubmitPlan> {
    let s = s0
    const folder = this.wf.folderOf(s)
    let revision: string | null
    let base: string | null
    let commits: string[] | undefined
    if (this.wf.ownLine(s)) {
      const h = await G.head(folder)
      if (isUnknown(h)) return { ok: false, refusal: unknownRefusal(card, h.what, 'submit') }
      if (args.revision && args.revision !== h) return { ok: false, refusal: { rule: 'check.revisionMismatch', values: { revision: args.revision.slice(0, 7) } } }
      revision = h
      // The change's base: the merge base with the target at this moment, fixed with the submission.
      const th = await G.lineHead(this.project, s.started!.target ?? '')
      const mb = !isUnknown(th) && th ? await G.mergeBase(this.project, th, h) : th
      if (isUnknown(mb) || !mb) return { ok: false, refusal: unknownRefusal(card, 'the merge base with the target', 'submit') }
      base = mb
    } else {
      // A shared folder: the card's change is its own attributed commits (§16.3.2).
      await reconcileGit(this.wf, card, {})
      s = this.wf.state(card)
      commits = s.attributed
      revision = commits.at(-1) ?? s.started!.base
      base = s.started!.base
    }
    let files: FileChange[] = []
    let key: string | null = null
    if (revision && base) {
      const c = commits && commits.length ? await this.ownChange(base, commits) : await G.change(this.project, base, revision)
      if (isUnknown(c)) return { ok: false, refusal: unknownRefusal(card, c.what, 'submit') }
      files = c.files
      key = c.key
    }
    if (!revision || revision === base || !files.length) return { ok: false, refusal: { rule: 'submit.empty', values: { card: card.key } } }
    // The guards' platform inputs, gathered only for the guards the ruleset holds.
    const inputs: Partial<GuardInputs> = {}
    const shared = !this.wf.ownLine(s)
    if (args.guards.includes('submit.clean')) inputs.dirty = await G.dirty(folder, !shared || !args.agent || !this.wf.cfg.locksOf ? undefined : this.wf.cfg.locksOf(args.agent))
    if (args.guards.includes('submit.ready')) inputs.conflicts = [] // a Git commit can't store unresolved conflicts
    if (args.guards.includes('submit.trailer')) inputs.untrailered = this.untrailered(card, s)
    if (args.guards.includes('submit.identity')) inputs.badIdentity = await this.badIdentity(base!, revision, commits, o)
    const warnings = o.sharedFolderWarning && shared ? this.othersFiles(card, s, files.map((f) => f.path)) : []
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

  /** A commit attributed to no card, made in the folder since the card's last submission, when another unfinished card shares it. */
  private untrailered(card: CardRecord, s: CardState): string | null {
    const others = this.wf.store.cards().filter((c) => c.id !== card.id && ['active', 'review', 'approved'].includes(c.stage) && this.wf.state(c).started?.folder === 'project')
    if (!others.length) return null
    const lastSub = s.latest?.commits?.at(-1)
    const rows = this.wf.store.folderCommits(this.project)
    const since = lastSub ? rows.slice(rows.findIndex((x) => x.sha === lastSub) + 1) : rows
    return since.find((x) => x.card === null)?.sha ?? null
  }

  /** G16: files of the change that another agent holds or held file locks on (a warning, never a refusal). */
  private othersFiles(card: CardRecord, s: CardState, files: string[]): string[] {
    if (!this.wf.cfg.locksOf) return []
    const out: string[] = []
    for (const c of this.wf.store.cards()) {
      const b = c.id === card.id ? null : this.wf.state(c).started?.builder
      if (!b || b === s.started?.builder) continue
      const theirs = this.wf.cfg.locksOf(b)
      for (const f of files) if (theirs.includes(f)) out.push(`${f} is ${b}'s (${c.key})`) // i18n-ignore: agent-facing warning in the spike's reply
    }
    return out
  }

  private async badIdentity(base: string, revision: string, commits: string[] | undefined, o: WorkflowOptions): Promise<Maybe<string | null>> {
    if (!o.identity) return null
    const list = await G.commits(this.project, `${base}..${revision}`)
    if (isUnknown(list)) return list
    const mine = commits ? list.filter((c) => commits.includes(c.commit)) : list
    return mine.find((c) => c.email.toLowerCase() !== o.identity!.email.toLowerCase())?.commit ?? null
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

  contains(target: string, change: { base: string; revision: string; key?: string | null }): Promise<Maybe<Containment | null>> {
    return G.contains(this.project, target, change)
  }

  targetHead(target: string): Promise<Maybe<string | null>> {
    return G.lineHead(this.project, target)
  }

  reconcile(card: CardRecord, hooks: ReconcileHooks): Promise<void> {
    return reconcileGit(this.wf, card, hooks)
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
    const h = await G.head(folder)
    if (isUnknown(rev) || !rev || isUnknown(h)) return unknownRefusal(card, `the revision in ${folder}`, 'submit.checksPassed')
    if (run.revision && run.revision !== h) return { rule: 'check.revisionMismatch', values: { revision: run.revision.slice(0, 7) } }
    const ls = await git(folder, ['ls-files', '-z'])
    const files = ls.out.split('\0').filter(Boolean)
    const gd = await git(folder, ['rev-parse', '--absolute-git-dir'])
    const gitDir = gd.ok ? gd.out.trim() : null
    const dirtyA = await G.dirty(folder)
    const snapA = await snapshot(folder, files, gitDir)
    const t0 = Date.now()
    const ok = run.command ? (await run.exec(run.command, folder)).ok : false
    const seen = await observer.changedBetween(folder, t0, Date.now())
    const snapB = await snapshot(folder, files, gitDir)
    const dirtyB = await G.dirty(folder)
    const headB = await G.head(folder)
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
    return observer.subscribe(this.project, onChange)
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
      await G.pin(this.project, String(payload.ref), String(payload.revision))
      return true
    }
    return false
  }
}
