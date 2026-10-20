// The Git platform behind the adapter interface (SPEC §16.3.2): a card's folder and line, its revision, the submission's
// fixed endpoints and keys, containment, sameness, observation and check brackets, all on `git()` (git.ts).
//
// P2 spike (#1118): not wired into the app yet.

import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync } from 'original-fs'
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
import { readIndex, statMatches, type IndexEntry } from './gitIndex'
import { observer, type Disposable, type ObserveEvent } from './observe'
import { isUnknown, type Containment, type Maybe } from './types'

/** A file this size or larger isn't hashed in the fingerprint: its size and time stand for it (the safe side). */
const HASH_MAX_BYTES = 16 * 1024 * 1024

/**
 * A tracked file's content for a fingerprint (#1206), with no process: its index entry's object id while its stat shows
 * it, else the object id `prime` hashed at this size and time. Otherwise (touched or edited since) it is hashed here as
 * git stores a blob and compared with the id expected: the same content is that id (a touch changes nothing); with
 * `core.autocrlf` on, its CRLF content with LF too. Anything else is its size and time ("gone" when it isn't there).
 */
function contentLine(abs: string, e: IndexEntry | undefined, hashed: { size: number; mtimeMs: number; oid: string } | undefined, writtenMs: number, p: Pick<Primed, 'oidBytes' | 'autocrlf'>): string {
  let st
  try {
    st = statSync(abs)
  } catch {
    return 'gone'
  }
  if (e && statMatches(e, st.size, st.mtimeMs, writtenMs)) return e.oid
  if (hashed && hashed.size === st.size && hashed.mtimeMs === st.mtimeMs) return hashed.oid
  const expected = hashed?.oid ?? e?.oid
  if (expected && st.size < HASH_MAX_BYTES) {
    try {
      const body = readFileSync(abs)
      if (blobId(body, p.oidBytes) === expected) return expected
      if (p.autocrlf && body.includes(13) && blobId(Buffer.from(body.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'), p.oidBytes) === expected) return expected
    } catch {
      // Unreadable now: its size and time stand for it.
    }
  }
  return `${st.size}:${st.mtimeMs}`
}

/** A blob's object id as git computes it. */
function blobId(body: Buffer, oidBytes: 20 | 32): string {
  return createHash(oidBytes === 32 ? 'sha256' : 'sha1').update(`blob ${body.length}\0`).update(body).digest('hex')
}

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

/** What `prime` reads once per intent for the evidence: the card's folder, the files it covers, and their content. */
interface Primed {
  gitDir: string | null
  folder: string | null
  /** The tracked files the evidence covers (the builder's own paths in a shared folder). */
  files: string[]
  /** A shared folder's own paths (the index entries covered), or null: the whole index. */
  own: string[] | null
  oidBytes: 20 | 32
  /** `core.autocrlf` is on: a file's CRLF content is stored with LF, so its object id is of that. */
  autocrlf: boolean
  /** Files whose stat didn't show the index's content when primed: their content's object id, at that size and time. */
  hashed: Map<string, { size: number; mtimeMs: number; oid: string }>
}

const covers = (own: string[] | null, f: string): boolean => !own || own.some((p) => f === p || f.startsWith(`${p}/`))

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
    if (!s.started || s.stage === 'todo') return { gitDir: null, folder: null, files: [], own: null, oidBytes: 20, autocrlf: false, hashed: new Map() } satisfies Primed
    const folder = this.wf.folderOf(s)
    const gd = await git(folder, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'])
    const ls = await git(folder, ['ls-files', '-z'])
    if (!gd.ok || !ls.ok) return null
    const fmt = await git(folder, ['rev-parse', '--show-object-format'])
    const oidBytes = fmt.ok && fmt.out.trim() === 'sha256' ? 32 : 20
    const crlf = await git(folder, ['config', '--type=bool', 'core.autocrlf'])
    // In a shared folder only the builder's own paths count (others' edits are "not yours", §16.3.2's dirty).
    const own = !this.wf.ownLine(s) && this.wf.cfg.locksOf ? this.wf.cfg.locksOf(s.started.builder) : null
    const files = ls.out.split('\0').filter(Boolean).filter((f) => covers(own, f))
    const gitDir = gd.out.trim()
    return { gitDir, folder, files, own, oidBytes, autocrlf: crlf.ok && crlf.out.trim() === 'true', hashed: await this.contentOfChanged(folder, gitDir, files, oidBytes) } satisfies Primed
  }

  /**
   * The content's object id of each covered file whose stat doesn't show the index's (#1206): edited, or only touched.
   * Hashed by git itself (its filters, line endings), once per intent, so a fingerprint can tell a touched file, or an
   * index whose stat data an outside `git status` refreshed meanwhile, from an edit.
   */
  private async contentOfChanged(folder: string, gitDir: string, files: string[], oidBytes: 20 | 32): Promise<Primed['hashed']> {
    const out: Primed['hashed'] = new Map()
    const idxFile = join(gitDir, 'index')
    let written = 0
    try {
      written = statSync(idxFile).mtimeMs
    } catch {
      return out
    }
    const idx = readIndex(idxFile, oidBytes, written)
    if (!idx) return out
    const entries = new Map(idx.entries.filter((e) => e.stage === 0).map((e) => [e.path, e]))
    const todo: { path: string; size: number; mtimeMs: number }[] = []
    for (const f of files) {
      try {
        const st = statSync(join(folder, f))
        const e = entries.get(f)
        if (!e || !statMatches(e, st.size, st.mtimeMs, idx.writtenMs)) todo.push({ path: f, size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        // Gone: the fingerprint says so.
      }
    }
    if (!todo.length) return out
    const r = await git(folder, ['hash-object', '--stdin-paths'], undefined, todo.map((t) => t.path).join('\n') + '\n')
    const oids = r.ok ? r.out.split(/\r?\n/).filter(Boolean) : []
    if (oids.length !== todo.length) return out
    todo.forEach((t, i) => out.set(t.path, { size: t.size, mtimeMs: t.mtimeMs, oid: oids[i] }))
    return out
  }

  /**
   * The state a card's guards read (ARCHITECTURE "The one path"): the target's and the line's refs, the folder's own
   * HEAD (a checkout or reset elsewhere shows), any merge, rebase or cherry-pick under way, the index's entries (mode,
   * object id, stage, path: a staged change shows), each covered tracked file's content and each folder's size and time
   * (an edit, or a new file beside them, shows). Content, not cached stat data (#1206): an outside `git status` rewriting
   * the index to refresh its stat data, or a file only touched, changes nothing. A file's content is its index entry's
   * object id while its stat shows it (git's own test), else what `prime` hashed at that size and time, else its size
   * and time (changed since: refused, the safe side). An index this can't read falls back to the file's stat. Null when
   * unreadable.
   */
  evidence(card: CardRecord, s: CardState, o: WorkflowOptions, primed: unknown): string | null {
    const p = primed as Primed | null
    if (!this.common || !p) return null
    const target = s.started?.target ?? card.target ?? o.target
    const line = s.stage === 'todo' ? null : s.started?.line
    const parts = [target ? G.refSync(this.common, `refs/heads/${target}`) : '', line ? G.refSync(this.common, `refs/heads/${line}`) : '']
    if (p.gitDir && p.folder) {
      parts.push(`HEAD:${G.refSync(p.gitDir, 'HEAD') ?? ''}`)
      for (const m of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) parts.push(existsSync(join(p.gitDir, m)) ? m : '')
      const idxFile = join(p.gitDir, 'index')
      let written = 0
      try {
        written = statSync(idxFile).mtimeMs
      } catch {
        // No index: read as none below.
      }
      const idx = written ? readIndex(idxFile, p.oidBytes, written) : null
      const entries = new Map<string, IndexEntry>()
      if (idx) {
        const h = createHash('sha256')
        for (const e of idx.entries) {
          if (!covers(p.own, e.path)) continue
          h.update(`${e.mode.toString(8)} ${e.oid} ${e.stage} ${e.path}\n`)
          if (e.stage === 0) entries.set(e.path, e)
        }
        parts.push(`index:${h.digest('hex')}`)
      } else parts.push(statLine(idxFile))
      const dirs = new Set<string>(['.'])
      for (const f of p.files) {
        parts.push(idx ? contentLine(join(p.folder, f), entries.get(f), p.hashed.get(f), idx.writtenMs, p) : statLine(join(p.folder, f)))
        dirs.add(dirname(f))
      }
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
