// The merge queue (SPEC §16.9): Hive performs merges, one entry at a time per target. An entry's way through: check it
// is still approved and not already in the target; test-merge it in the queue's own worktree; run the merge checks on
// exactly that result (installing clean when the manifests changed); then advance the target only on green, after
// writing `IntegrationStarted`, by compare-and-swap (not checked out) or the journaled read-tree/update-ref protocol
// (checked out). A target that moved since the test is tested again; it never advances an untested target.
//
// P2 spike (#1118): the core of the queue over the spike's runtime. The repository lock across processes, hooks and
// signing pauses are P5's. The merge checks (#1349) run as Hive's own runs (queueChecks.ts), each bracketed here: green
// only when it exited 0 and its `CheckRan` counted for exactly the test merge's revision.

import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'original-fs'
import { join } from 'path'
import { git } from '../git'
import { openEntry, type CardState, type FactData, type QueueEntry } from '../../shared/workflow/facts'
import { notApproved } from '../../shared/workflow/guards'
import { hasStage } from '../../shared/workflow/compile'
import { FOR_YOU, workflowText } from '../../shared/workflow/texts'
import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import { withWriteFence, type CardRecord } from './factStore'
import { LeaseLost } from './queueRunner'
import { reconcile } from './reconcile'
import { bracketEnd, bracketStart } from './queueChecks'
import { HIVE_RUNS } from '../progress'
import type { Workflow, Write } from './runtime'
import type { RunCheck } from '../../shared/types'

export interface CheckResult {
  ok: boolean
  /** The failure was the environment (a check that didn't start, a network error, a timeout), not a result. */
  transient?: boolean
  output: string
  /** The command that ran, and its run's id (a progress run's, when Hive keeps runs). */
  command?: string
  run?: string
  /** Tells the check's run how it counted (its details say why not). */
  note?: (c: RunCheck) => void
}

/** What a merge check or install runs for: the card, and the test merge's result revision it runs on. */
export interface CheckContext {
  card: string
  number: number
  revision: string
  /** Nothing was installed before the checks (no setup command and no lock file): this check's run says so. */
  noInstall?: boolean
}

/** What the merge checks of a test merge came to: green (every one passed and counted), red, or not proved. */
type ChecksOutcome = { kind: 'green' } | { kind: 'red'; transient: boolean; output: string } | { kind: 'uncounted' }

export interface QueueConfig {
  /** The queue's own worktree (a merge slot, kept warm). */
  folder: string
  /** Runs a named merge check (its configured command) in a folder, on the test merge's result. */
  runCheck: (name: string, command: string, folder: string, ctx: CheckContext) => Promise<CheckResult>
  /** Installs dependencies there; `clean` from scratch (`npm ci`). `skipped`: there was nothing to install. */
  install?: (folder: string, clean: boolean, ctx: CheckContext) => Promise<CheckResult & { skipped?: boolean }>
  /** The files whose change since the last install means a clean install (#187). */
  manifests?: string[]
  /** An agent builds in this folder (holds file locks there, or has a run going in it). */
  folderBusy?: (folder: string) => boolean
  /**
   * Whether this queue's runner still holds its target's lease (#1360, QueueRunner.holds): checked inside every store
   * write the queue's work makes (its facts, reconciliation's, values, a pause: withWriteFence), which is refused whole
   * once it doesn't, and the queue stops. Left out, always.
   */
  holds?: () => boolean
  /**
   * Runs git for the queue (its test merges, the advance, the pins): the runner's recording one in the app (#1360,
   * QueueRunner.git: its processes in the lease's job, recorded before they run); left out, Hive's own git().
   */
  git?: (cwd: string, args: string[]) => Promise<{ ok: boolean; out: string; err: string; code: number }>
  /**
   * Runs the advance under the repository's lock across processes (#1347, withRepoLock), its `IntegrationStarted` and
   * the ref's compare-and-swap together; left out, as it is.
   */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>
  /**
   * Whether workflow rules are enforced now (Settings → Advanced, `hive.workflow.enforce`, read at each use): off, an
   * entry stops just before its advance, paused `rulesOff`, and an advance already begun finishes. Left out, always.
   */
  enforced?: () => boolean
  /**
   * A target checked out in a folder (§16.9.2) pauses `checkedOut` instead of being advanced there (#1348: until
   * #1351 builds that advance).
   */
  pauseCheckedOut?: boolean
  /** Test seams: crash injection and races between the queue's steps. */
  hooks?: {
    afterTest?: (entry: string) => void | Promise<void>
    afterChecks?: (entry: string) => void | Promise<void>
    afterStarted?: (entry: string) => void | Promise<void>
    afterFiles?: (entry: string) => void | Promise<void>
    afterAdvance?: (entry: string) => void | Promise<void>
  }
}

export type QueueOutcome =
  | { card: string; entry: string; outcome: 'integrated'; result: string; retests: number }
  | { card: string; entry: string; outcome: 'returned'; reason: FactData['IntegrationFailed']['reason']; transient: boolean }
  | { card: string; entry: string; outcome: 'paused'; reason: PauseReason; files?: string[] }
  | { card: string; entry: string; outcome: 'skipped'; why: 'notApproved' | 'cancelled' }
  | { card: string; entry: string; outcome: 'integratedOutside' }

/** `uncounted`: its checks passed but didn't count for the result MAX_RETESTS times in a row (the card's `CheckRan` says why). */
export type PauseReason = 'targetMovesFast' | 'folderBusy' | 'wrongBranch' | 'staged' | 'unstagedChanges' | 'identity' | 'needsYou' | 'uncounted' | 'checkedOut' | 'rulesOff'

/**
 * How many times an entry is tested again for a target that moved (§16.9.1 step 6), or for checks that passed without
 * counting (#1349), before it pauses.
 */
export const MAX_RETESTS = 3

const refSafe = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '-')

/** A runner that lost its lease stops at once: no outcome (another Hive's runner carries on). */
const lostIsNull = (e: unknown): null => {
  if (e instanceof LeaseLost) return null
  throw e
}

export class MergeQueue {
  /** Entries a restart's recovery found should run again from the test merge. */
  private rerun = new Set<string>()

  constructor(
    readonly wf: Workflow,
    readonly cfg: QueueConfig
  ) {}

  private get project(): string {
    return this.wf.cfg.project
  }

  private git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string; code: number }> {
    return (this.cfg.git ?? git)(cwd, args)
  }

  paused(target: string): { reason: PauseReason; card: string; files?: string[] } | null {
    return this.wf.store.queuePause(target) as { reason: PauseReason; card: string; files?: string[] } | null
  }

  resume(target: string): void {
    this.wf.store.setQueuePause(target, null)
  }

  private async pause(target: string, card: CardRecord, entry: QueueEntry, reason: PauseReason, files?: string[]): Promise<QueueOutcome> {
    await this.wf.locked(() => this.wf.store.setQueuePause(target, { reason, card: card.key, ...(files ? { files } : {}) }))
    return { card: card.key, entry: entry.id, outcome: 'paused', reason, ...(files ? { files } : {}) }
  }

  /**
   * Runs the queue's work with every store write it makes fenced by the runner's lease (withWriteFence): checked inside
   * each write, which throws LeaseLost (undone whole) once the runner doesn't hold the target.
   */
  private fenced<T>(target: string, fn: () => Promise<T>): Promise<T> {
    const holds = this.cfg.holds
    if (!holds) return fn()
    return withWriteFence(() => {
      if (!holds()) throw new LeaseLost(target)
    }, fn)
  }

  /** The queue's entries for a target, in the order they were requested: open, or recovered to run again. */
  entries(target?: string): { card: CardRecord; entry: QueueEntry }[] {
    const out: { card: CardRecord; entry: QueueEntry }[] = []
    for (const f of this.wf.store.factsOfKind('IntegrationRequested')) {
      const d = f.data as FactData['IntegrationRequested']
      if (target && d.target !== target) continue
      const s = this.wf.state(f.card)
      const e = s.entries.find((x) => x.id === d.entry)
      if (e && (e.state === 'open' || (e.state === 'started' && this.rerun.has(e.id)))) out.push({ card: this.wf.store.card(f.card), entry: e })
    }
    return out
  }

  /** Runs the queue for a target until it is empty or paused; the outcomes in order. */
  async drain(target: string): Promise<QueueOutcome[]> {
    const out: QueueOutcome[] = []
    for (let i = 0; i < 50; i++) {
      const o = await this.runOnce(target).catch(lostIsNull)
      if (!o) break
      out.push(o)
      if (o.outcome === 'paused') break
    }
    return out
  }

  /** Takes the next entry for the target and takes it as far as it goes. Null when there's none or the queue is paused. */
  async runOnce(target: string): Promise<QueueOutcome | null> {
    if (this.paused(target)) return null
    const next = this.entries(target)[0]
    if (!next) return null
    return this.fenced(target, () => this.process(next.card, next.entry)).catch(lostIsNull)
  }

  private async write<T>(card: CardRecord, fn: (w: Write) => T): Promise<T> {
    const s = this.wf.state(card)
    return this.wf.write(card, this.wf.rulesetOf(card, s), 'hive', fn)
  }

  /**
   * The advance's authority, decided in the transaction that writes `IntegrationStarted` (§16.4.6, §16.9.1 step 6):
   * the entry still the card's open one, the card in Merging, approved at the current generation and not stale. A
   * decision, a cancel or a stale pass that landed after the queue's last check stops it here, before git is touched.
   */
  private startAdvance(card: CardRecord, entry: QueueEntry, data: FactData['IntegrationStarted']): Promise<boolean> {
    return this.write(card, (w) => {
      const s = w.state()
      const e = s.entries.find((x) => x.id === entry.id)
      const open = !!e && (e.state === 'open' || (e.state === 'started' && this.rerun.has(e.id)))
      const r = w.ruleset!
      const approved = r.options.review === 'none' ? !s.stale : !notApproved(s, r, card.labels)
      if (!open || s.stage !== 'merging' || !approved) return false
      w.fact('IntegrationStarted', data)
      return true
    })
  }

  /** Is the entry still the card's open one, approved at the current generation and not stale (§16.9.1 step 2)? */
  private stillApproved(card: CardRecord, entry: QueueEntry): { s: CardState; ok: boolean; cancelled: boolean } {
    const s = this.wf.state(card)
    const e = s.entries.find((x) => x.id === entry.id)
    const cancelled = !e || e.state === 'cancelled' || e.state === 'failed' || e.state === 'integrated'
    const r = this.wf.rulesetOf(card, s)
    const ok = !cancelled && (r.options.review === 'none' ? !s.stale : !notApproved(s, r, card.labels))
    return { s, ok, cancelled }
  }

  private async process(card: CardRecord, entry: QueueEntry): Promise<QueueOutcome> {
    const target = entry.target
    let retests = 0
    let uncounted = 0
    for (;;) {
      const check = this.stillApproved(card, entry)
      if (!check.ok) return this.skip(card, entry, check.cancelled)
      const s = check.s
      const revision = s.approved?.revision ?? entry.revision
      const base = s.approved?.base ?? s.latest?.base ?? s.started?.base ?? ''
      // Already in the target (merged by hand meanwhile): observed, no empty merge.
      const found = await G.contains(this.project, target, { base, revision, key: s.latest?.key })
      if (!isUnknown(found) && found) {
        await reconcile(this.wf, card)
        return { card: card.key, entry: entry.id, outcome: 'integratedOutside' }
      }
      const expected = await G.lineHead(this.project, target)
      if (isUnknown(expected) || !expected) return this.pause(target, card, entry, 'needsYou')

      // The test merge, in the queue's own worktree, at the expected revision.
      const test = await this.testMerge(card, s, revision, expected)
      if ('pause' in test) return this.pause(target, card, entry, test.pause)
      if ('fail' in test) return this.returnCard(card, entry, revision, target, test.fail, false, test.files, test.log)
      const result = test.result
      await this.cfg.hooks?.afterTest?.(entry.id)

      // The merge checks, on exactly that result (dependencies from scratch when the manifests changed). Passed but not
      // proved (something changed the folder while one ran): tested again from a fresh test merge, then paused.
      const checks = await this.mergeChecks(card, result)
      if (checks.kind === 'red') return this.returnCard(card, entry, revision, target, 'checks', checks.transient, undefined, checks.output)
      if (checks.kind === 'uncounted') {
        if (++uncounted > MAX_RETESTS) return this.pause(target, card, entry, 'uncounted')
        continue
      }
      await this.cfg.hooks?.afterChecks?.(entry.id)

      // The last check before the target moves: still approved (a decision since cancels the entry).
      const last = this.stillApproved(card, entry)
      if (!last.ok) return this.skip(card, entry, last.cancelled)
      const now = await G.lineHead(this.project, target)
      if (isUnknown(now) || now !== expected) {
        // The target moved since the test: tested again against the new head; never an untested advance.
        if (++retests > MAX_RETESTS) return this.pause(target, card, entry, 'targetMovesFast')
        continue
      }
      // Workflow rules turned off meanwhile: no advance begins (an entry already begun finishes: recover).
      if (this.cfg.enforced && !this.cfg.enforced()) return this.pause(target, card, entry, 'rulesOff')
      const where = await G.checkouts(this.project)
      if (isUnknown(where)) return this.pause(target, card, entry, 'needsYou')
      const folder = where[target] ?? null
      if (folder && this.cfg.pauseCheckedOut) return this.pause(target, card, entry, 'checkedOut', [folder])
      const adv = folder ? await this.advanceCheckedOut(card, entry, target, expected, result, folder) : await this.advanceRef(card, entry, target, expected, result)
      if (adv === 'moved') {
        if (++retests > MAX_RETESTS) return this.pause(target, card, entry, 'targetMovesFast')
        entry = this.wf.state(card).entries.at(-1)!
        continue
      }
      if (adv === 'denied') return this.skip(card, entry, this.stillApproved(card, entry).cancelled)
      if (typeof adv === 'object') return this.pause(target, card, entry, adv.pause, adv.files)
      await this.integrated(card, entry, revision, target, result, s.started?.target === target && this.wf.rulesetOf(card, s).options.style === 'squash' ? 'squash' : 'merge', 'hive')
      return { card: card.key, entry: entry.id, outcome: 'integrated', result, retests }
    }
  }

  /**
   * An entry that isn't approved any more (its pass stale, a pass or approval missing at the current generation) gets
   * an outcome, so the queue never stalls on it: cancelled, the card back to Review (or Active), its builder woken. An
   * entry already cancelled (a decision, the user) needs nothing more.
   */
  private async skip(card: CardRecord, entry: QueueEntry, cancelled: boolean): Promise<QueueOutcome> {
    if (!cancelled) {
      await this.write(card, (w) => {
        w.fact('IntegrationCancelled', { entry: entry.id, reason: 'stale' }) // i18n-ignore: a fact's kind and codes, not text
        w.move(w.ruleset && hasStage(w.ruleset, 'review') ? 'review' : 'active', 'derived')
        this.wf.wake(w, w.state().started?.builder, `${card.key} left the merge queue: it isn't approved any more`) // i18n-ignore: a wake, agent-facing
      })
    }
    return { card: card.key, entry: entry.id, outcome: 'skipped', why: cancelled ? 'cancelled' : 'notApproved' } // i18n-ignore: a reason's key, not text
  }

  private async identity(): Promise<{ name: string; email: string } | null> {
    return this.wf.cfg.options().identity ?? (await G.identity(this.project))
  }

  private async testMerge(card: CardRecord, s: CardState, revision: string, expected: string): Promise<{ result: string } | { fail: 'conflict' | 'hook'; files?: string[]; log: string } | { pause: PauseReason }> {
    const id = await this.identity()
    if (!id) return { pause: 'identity' }
    const f = this.cfg.folder
    if (!existsSync(f)) {
      const add = await this.git(this.project, ['worktree', 'add', '--detach', f, expected])
      if (!add.ok) return { pause: 'needsYou' }
    } else {
      const co = await this.git(f, ['checkout', '--detach', '-f', expected])
      if (!co.ok) return { pause: 'needsYou' }
      await this.git(f, ['clean', '-fdq'])
    }
    const r = this.wf.rulesetOf(card, s)
    // The reviewers whose passes count for what is merged: the latest submission, at the current generation.
    const reviewers = [...new Set(s.verdicts.filter((v) => v.pass && v.submission === s.latest?.id && v.generation === s.generation).map((v) => v.reviewer))].join(', ')
    const message = `${card.key}: ${card.title}\n\nHive-Card: ${card.key}\nHive-Revision: ${revision}${reviewers ? `\nHive-Reviewed-By: ${reviewers}` : ''}` // i18n-ignore: a commit message, in English
    const who = ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`]
    const squash = r.options.style === 'squash'
    const m = await this.git(f, [...who, 'merge', squash ? '--squash' : '--no-ff', ...(squash ? [] : ['--no-edit', '-m', message]), revision])
    if (!m.ok) {
      const u = await this.git(f, ['diff', '--name-only', '--diff-filter=U'])
      const files = u.out.split(/\r?\n/).filter(Boolean)
      await this.git(f, ['merge', '--abort'])
      await this.git(f, ['reset', '--hard', '-q', expected])
      if (files.length) return { fail: 'conflict', files, log: m.out + m.err }
      return { fail: 'hook', log: m.out + m.err }
    }
    if (squash) {
      const c = await this.git(f, [...who, 'commit', '-q', '-m', message])
      if (!c.ok) {
        await this.git(f, ['reset', '--hard', '-q', expected])
        return { fail: 'hook', log: c.out + c.err }
      }
    }
    const h = await G.head(f)
    if (isUnknown(h)) return { pause: 'needsYou' }
    await this.git(this.project, ['update-ref', `refs/hive/queue/${refSafe(card.key)}`, h])
    return { result: h }
  }

  /**
   * Runs the merge checks (G9) on the test merge's result, one after another, stopping at the first that isn't green.
   * Installs clean first when the manifests changed since the folder's last install (#187, always), or before every
   * entry's checks (`mergeInstall: 'always'`). Each check is bracketed and writes `CheckRan` at the result revision
   * (§16.13): green only if it exited 0 and counted; exit 0 but uncounted is `uncounted`, never green.
   */
  private async mergeChecks(card: CardRecord, result: string): Promise<ChecksOutcome> {
    const o = this.wf.rulesetOf(card).options
    if (!o.mergeChecks.length) return { kind: 'green' }
    const f = this.cfg.folder
    const ctx: CheckContext = { card: card.key, number: card.id, revision: result }
    const manifests = this.cfg.manifests ?? ['package.json', 'package-lock.json']
    const hash = createHash('sha256')
    for (const m of manifests) hash.update(existsSync(join(f, m)) ? readFileSync(join(f, m)) : `-${m}`)
    const now = hash.digest('hex')
    const key = `queue:installed:${f}`
    let noInstall = false
    if (this.cfg.install && (o.mergeInstall === 'always' || this.wf.store.meta(key) !== now)) {
      const i = await this.cfg.install(f, true, ctx)
      if (!i.ok) return { kind: 'red', transient: !!i.transient, output: i.output }
      noInstall = !!i.skipped
      await this.wf.locked(() => this.wf.store.setMeta(key, now))
    }
    for (const name of o.mergeChecks) {
      const command = o.commands[name] ?? name
      const start = await bracketStart(f)
      const r = await this.cfg.runCheck(name, command, f, { ...ctx, ...(noInstall ? { noInstall } : {}) })
      noInstall = false
      const b = await bracketEnd(f, result, start)
      const data: FactData['CheckRan'] = {
        name,
        command: r.command ?? command,
        revision: result,
        tested: b.tested,
        result: r.ok ? 'passed' : 'failed',
        run: r.run ?? randomUUID(),
        durationMs: Math.max(0, Date.now() - start.t0),
        by: HIVE_RUNS,
        counted: b.counted,
        ...(b.whyNot ? { whyNot: b.whyNot } : {})
      }
      await this.write(card, (w) => w.fact('CheckRan', data))
      r.note?.({ name, counted: b.counted, ...(b.whyNot ? { whyNot: b.whyNot } : {}) })
      if (!r.ok) return { kind: 'red', transient: !!r.transient, output: r.output }
      if (!b.counted) return { kind: 'uncounted' }
    }
    return { kind: 'green' }
  }

  /** The target checked out nowhere: one compare-and-swap (`update-ref <target> <result> <expected>`). */
  private async advanceRef(card: CardRecord, entry: QueueEntry, target: string, expected: string, result: string): Promise<'done' | 'moved' | 'denied'> {
    const lock = this.cfg.lock ?? (<T,>(fn: () => Promise<T>) => fn())
    // Under the repository's lock (#1347): `IntegrationStarted` (its write checks the lease: the fence) and the ref's
    // compare-and-swap, the lease checked once more just before the swap.
    const r = await lock(async () => {
      if (!(await this.startAdvance(card, entry, { entry: entry.id, expected, result, checkedOut: null }))) return 'denied' as const
      await this.cfg.hooks?.afterStarted?.(entry.id)
      if (this.cfg.holds && !this.cfg.holds()) throw new LeaseLost(target)
      return (await this.git(this.project, ['update-ref', `refs/heads/${target}`, result, expected])).ok ? ('done' as const) : ('moved' as const)
    })
    if (r === 'moved') {
      await this.moved(card, entry, target)
      return 'moved'
    }
    if (r === 'done') await this.cfg.hooks?.afterAdvance?.(entry.id)
    return r
  }

  /** The swap found the target moved: this entry failed (transient) and the card is queued again, to be tested again. */
  private async moved(card: CardRecord, entry: QueueEntry, target: string): Promise<void> {
    await this.write(card, (w) => {
      w.fact('IntegrationFailed', { entry: entry.id, revision: entry.revision, target, reason: 'targetMoved', transient: true }) // i18n-ignore: a fact's kind and codes, not text
      const s = w.state()
      w.fact('IntegrationRequested', { entry: `${card.key}/e${s.lastSeq + 1}`, revision: entry.revision, key: s.latest?.key ?? null, target, style: w.ruleset!.options.style })
    })
  }

  /**
   * The target checked out in a folder (§16.9.2): conditions checked before anything is touched (else a pause), then
   * a journal: `IntegrationStarted`, phase files, read-tree, phase ref, update-ref, `Integrated`.
   */
  private async advanceCheckedOut(card: CardRecord, entry: QueueEntry, target: string, expected: string, result: string, folder: string): Promise<'done' | 'moved' | 'denied' | { pause: PauseReason; files?: string[] }> {
    if (this.cfg.folderBusy?.(folder)) return { pause: 'folderBusy' }
    const b = await G.branch(folder)
    if (isUnknown(b) || b !== target) return { pause: 'wrongBranch' }
    const staged = await this.git(folder, ['diff', '--cached', '--quiet', expected])
    if (staged.code !== 0) return { pause: 'staged' }
    const changed = await this.git(this.project, ['diff', '--name-only', '-z', expected, result])
    if (!changed.ok) return { pause: 'needsYou' }
    const files = changed.out.split('\0').filter(Boolean)
    if (files.length) {
      const st = await this.git(folder, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...files])
      const busy = st.out.split('\0').filter(Boolean).map((l) => l.slice(3))
      if (!st.ok || busy.length) return { pause: 'unstagedChanges', files: busy }
    }
    const ref = await G.lineHead(this.project, target)
    if (ref !== expected) return 'moved'
    if (!(await this.startAdvance(card, entry, { entry: entry.id, expected, result, files, checkedOut: folder }))) return 'denied'
    await this.cfg.hooks?.afterStarted?.(entry.id)
    await this.write(card, (w) => w.fact('IntegrationPhase', { entry: entry.id, phase: 'files' }))
    const rt = await this.git(folder, ['read-tree', '-m', '-u', expected, result])
    if (!rt.ok) {
      // git refused before writing: the files are as they were. The user's edit since the check pauses (named); anything
      // else is the target moving: back to the test merge.
      const st = await this.git(folder, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...files])
      const busy = st.out.split('\0').filter(Boolean).map((l) => l.slice(3))
      await this.moved(card, entry, target)
      if (busy.length) return { pause: 'unstagedChanges', files: busy }
      return 'moved'
    }
    await this.cfg.hooks?.afterFiles?.(entry.id)
    await this.write(card, (w) => w.fact('IntegrationPhase', { entry: entry.id, phase: 'ref' }))
    const u = await this.git(this.project, ['update-ref', `refs/heads/${target}`, result, expected])
    if (!u.ok) {
      await this.write(card, (w) => w.fact('IntegrationPhase', { entry: entry.id, phase: 'rollback' }))
      const back = await this.git(folder, ['read-tree', '-m', '-u', result, expected])
      if (!back.ok) return { pause: 'needsYou', files }
      await this.moved(card, entry, target)
      return 'moved'
    }
    await this.cfg.hooks?.afterAdvance?.(entry.id)
    return 'done'
  }

  /** `Integrated` → Done; the slot released, the lane ended if done; a decision recorded after the advance began → For you. */
  private async integrated(card: CardRecord, entry: QueueEntry, revision: string, target: string, result: string, method: 'merge' | 'squash', by: 'hive' | 'outside'): Promise<void> {
    await this.write(card, (w) => {
      // One Integrated per cycle, whoever writes it (the queue, or another Hive's recovery or observation).
      const st = w.state()
      if (st.integrated) return
      const startedAt = this.wf.store.facts(card.id).filter((f) => f.kind === 'IntegrationStarted' && (f.data as FactData['IntegrationStarted']).entry === entry.id).at(-1)?.seq ?? Infinity
      const f = w.tx.append(card.id, { kind: 'Integrated', actor: 'hive', source: 'recorded', dedupe: `cycle:${st.cycle}`, ...(w.ruleset ? { ruleset: w.ruleset.id } : {}), data: { entry: entry.id, revision, target, result, method, by } }) // i18n-ignore: a fact's kind and codes, not text
      w.written.push(f)
      w.move('done', 'derived')
      w.action('releaseSlot', {})
      w.action('endLaneIfDone', {})
      if (this.wf.store.facts(card.id).some((x) => x.kind === 'Decision' && x.seq > startedAt)) this.wf.askUser(w, 'decide', 'decision', workflowText(FOR_YOU.decidedAfterMerge, { card: card.key }))
    })
  }

  /** A conflict, red checks or a hook: `IntegrationFailed`, the card back to its builder with the output (§16.9.1 step 8). */
  private async returnCard(card: CardRecord, entry: QueueEntry, revision: string, target: string, reason: FactData['IntegrationFailed']['reason'], transient: boolean, files?: string[], log?: string): Promise<QueueOutcome> {
    await this.write(card, (w) => {
      w.fact('IntegrationFailed', { entry: entry.id, revision, target, reason, transient, ...(files ? { files } : {}), ...(log ? { log: log.slice(0, 4000) } : {}) })
      w.move('active', 'derived')
      this.wf.wake(w, w.state().started?.builder, `${card.key} came back from the merge queue: ${reason}`) // i18n-ignore: a wake, agent-facing
    })
    return { card: card.key, entry: entry.id, outcome: 'returned', reason, transient }
  }

  /**
   * After a restart (§16.4.5): an entry with `IntegrationStarted` and no outcome is reconciled from the platform, never
   * assumed. Target not checked out: the ref at the result → `Integrated` (observed); at the expected revision → runs
   * again from the test merge; anywhere else → failed (target moved) and containment decides. Checked out: §16.9.2's
   * recovery table, whose last row pauses the queue for that target ("needs you").
   */
  /**
   * Recovers a target's entries (#1348: each target's host its own; every target's when none is given, the tests'). A
   * runner that lost its lease meanwhile stops, its recovery the next runner's.
   */
  async recover(target?: string): Promise<{ card: string; entry: string; outcome: 'integrated' | 'rerun' | 'failed' | 'needsYou' }[]> {
    return this.fenced(target ?? '', () => this.recoverAll(target)).catch((e) => lostIsNull(e) ?? [])
  }

  private async recoverAll(target?: string): Promise<{ card: string; entry: string; outcome: 'integrated' | 'rerun' | 'failed' | 'needsYou' }[]> {
    const out: { card: string; entry: string; outcome: 'integrated' | 'rerun' | 'failed' | 'needsYou' }[] = []
    for (const card of this.wf.store.cards()) {
      const s = this.wf.state(card)
      const e = openEntry(s)
      if (!e || e.state !== 'started' || !e.started || (target !== undefined && e.target !== target)) continue
      const { expected, result, checkedOut, files = [] } = e.started
      const ref = await G.lineHead(this.project, e.target)
      const done = async () => {
        await this.write(card, (w) => {
          const f = w.tx.appendObserved(card.id, { kind: 'Integrated', actor: 'outside', source: 'observed', dedupe: `cycle:${s.cycle}`, data: { entry: e.id, revision: e.revision, target: e.target, result, method: 'merge', by: 'hive' } }) // i18n-ignore: a fact's kind and codes, not text
          if (!f) return
          w.move('done', 'derived')
          w.action('releaseSlot', {})
          w.action('endLaneIfDone', {})
        })
        out.push({ card: card.key, entry: e.id, outcome: 'integrated' })
      }
      if (ref === result) {
        await done()
        continue
      }
      if (!checkedOut) {
        if (ref === expected) {
          this.rerun.add(e.id)
          out.push({ card: card.key, entry: e.id, outcome: 'rerun' })
        } else {
          // The target moved meanwhile: containment decides. Found → Done (observed); not found → tested again.
          await this.write(card, (w) => w.fact('IntegrationFailed', { entry: e.id, revision: e.revision, target: e.target, reason: 'targetMoved', transient: true })) // i18n-ignore: a fact's kind and codes, not text
          await reconcile(this.wf, card)
          if (this.wf.state(card).stage === 'merging') {
            await this.write(card, (w) => {
              const st = w.state()
              w.fact('IntegrationRequested', { entry: `${card.key}/e${st.lastSeq + 1}`, revision: e.revision, key: st.latest?.key ?? null, target: e.target, style: w.ruleset!.options.style })
            })
          }
          out.push({ card: card.key, entry: e.id, outcome: 'failed' })
        }
        continue
      }
      const at = async (rev: string) => files.length === 0 || ((await this.git(checkedOut, ['diff', '--cached', '--quiet', rev, '--', ...files])).code === 0 && (await this.git(checkedOut, ['diff', '--quiet', '--', ...files])).code === 0)
      const phase = e.phases.at(-1)
      const branchOk = (await G.branch(checkedOut)) === e.target
      if (branchOk && ref === expected && phase !== 'rollback' && (await at(expected))) {
        this.rerun.add(e.id)
        out.push({ card: card.key, entry: e.id, outcome: 'rerun' })
      } else if (branchOk && ref === expected && (phase === 'files' || phase === 'ref') && (await at(result))) {
        const u = await this.git(this.project, ['update-ref', `refs/heads/${e.target}`, result, expected])
        if (u.ok) await done()
        else {
          await this.pause(e.target, card, e, 'needsYou', files)
          out.push({ card: card.key, entry: e.id, outcome: 'needsYou' })
        }
      } else if (phase === 'rollback' && (await at(expected))) {
        this.rerun.add(e.id)
        out.push({ card: card.key, entry: e.id, outcome: 'rerun' })
      } else {
        await this.pause(e.target, card, e, 'needsYou', files)
        out.push({ card: card.key, entry: e.id, outcome: 'needsYou' })
      }
    }
    return out
  }
}
