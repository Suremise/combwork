// The merge queue (SPEC §16.9): Hive performs merges, one entry at a time per target. An entry's way through: check it
// is still approved and not already in the target; test-merge it in the queue's own worktree; run the merge checks on
// exactly that result (installing clean when the manifests changed); then advance the target only on green, after
// writing `IntegrationStarted`, by compare-and-swap (not checked out) or the journaled read-tree/update-ref protocol
// (checked out). A target that moved since the test is tested again; it never advances an untested target.
//
// P2 spike (#1118): the core of the queue over the spike's runtime. The repository lock across processes, hooks and
// signing pauses, and the Progress panel's runs are P5's.

import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'original-fs'
import { join } from 'path'
import { git } from '../git'
import { openEntry, type CardState, type FactData, type QueueEntry } from '../../shared/workflow/facts'
import { notApproved } from '../../shared/workflow/guards'
import { hasStage } from '../../shared/workflow/compile'
import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import type { CardRecord } from './factStore'
import { reconcile } from './reconcile'
import type { Workflow, Write } from './runtime'

export interface CheckResult {
  ok: boolean
  /** The failure was the environment (a check that didn't start, a network error, a timeout), not a result. */
  transient?: boolean
  output: string
}

export interface QueueConfig {
  /** The queue's own worktree (a merge slot, kept warm). */
  folder: string
  /** Runs a named merge check (its configured command) in a folder. */
  runCheck: (name: string, command: string, folder: string) => Promise<CheckResult>
  /** Installs dependencies there; `clean` from scratch (`npm ci`). */
  install?: (folder: string, clean: boolean) => Promise<CheckResult>
  /** The files whose change since the last install means a clean install (#187). */
  manifests?: string[]
  /** An agent builds in this folder (holds file locks there, or has a run going in it). */
  folderBusy?: (folder: string) => boolean
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

export type PauseReason = 'targetMovesFast' | 'folderBusy' | 'wrongBranch' | 'staged' | 'unstagedChanges' | 'identity' | 'needsYou'

/** How many times an entry is tested again for a target that moved, before it pauses (§16.9.1 step 6). */
export const MAX_RETESTS = 3

const refSafe = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '-')

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

  paused(target: string): { reason: PauseReason; card: string; files?: string[] } | null {
    const v = this.wf.store.meta(`queue:paused:${target}`)
    return v ? JSON.parse(v) : null
  }

  resume(target: string): void {
    this.wf.store.setMeta(`queue:paused:${target}`, '')
  }

  private pause(target: string, card: CardRecord, entry: QueueEntry, reason: PauseReason, files?: string[]): QueueOutcome {
    this.wf.store.setMeta(`queue:paused:${target}`, JSON.stringify({ reason, card: card.key, ...(files ? { files } : {}) }))
    return { card: card.key, entry: entry.id, outcome: 'paused', reason, ...(files ? { files } : {}) }
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
      const o = await this.runOnce(target)
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
    return this.process(next.card, next.entry)
  }

  private async write(card: CardRecord, fn: (w: Write) => void): Promise<void> {
    const s = this.wf.state(card)
    await this.wf.write(card, this.wf.rulesetOf(card, s), 'hive', fn)
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

      // The merge checks, on exactly that result (dependencies from scratch when the manifests changed).
      const checks = await this.mergeChecks(card)
      if (checks) return this.returnCard(card, entry, revision, target, 'checks', !!checks.transient, undefined, checks.output)
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
      const where = await G.checkouts(this.project)
      if (isUnknown(where)) return this.pause(target, card, entry, 'needsYou')
      const folder = where[target] ?? null
      const adv = folder ? await this.advanceCheckedOut(card, entry, target, expected, result, folder) : await this.advanceRef(card, entry, target, expected, result)
      if (adv === 'moved') {
        if (++retests > MAX_RETESTS) return this.pause(target, card, entry, 'targetMovesFast')
        entry = this.wf.state(card).entries.at(-1)!
        continue
      }
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
        w.fact('IntegrationCancelled', { entry: entry.id, reason: 'stale' })
        w.move(w.ruleset && hasStage(w.ruleset, 'review') ? 'review' : 'active', 'derived')
        this.wf.wake(w, w.state().started?.builder, `${card.key} left the merge queue: it isn't approved any more`)
      })
    }
    return { card: card.key, entry: entry.id, outcome: 'skipped', why: cancelled ? 'cancelled' : 'notApproved' }
  }

  private async identity(): Promise<{ name: string; email: string } | null> {
    return this.wf.cfg.options().identity ?? (await G.identity(this.project))
  }

  private async testMerge(card: CardRecord, s: CardState, revision: string, expected: string): Promise<{ result: string } | { fail: 'conflict' | 'hook'; files?: string[]; log: string } | { pause: PauseReason }> {
    const id = await this.identity()
    if (!id) return { pause: 'identity' }
    const f = this.cfg.folder
    if (!existsSync(f)) {
      const add = await git(this.project, ['worktree', 'add', '--detach', f, expected])
      if (!add.ok) return { pause: 'needsYou' }
    } else {
      const co = await git(f, ['checkout', '--detach', '-f', expected])
      if (!co.ok) return { pause: 'needsYou' }
      await git(f, ['clean', '-fdq'])
    }
    const r = this.wf.rulesetOf(card, s)
    // The reviewers whose passes count for what is merged: the latest submission, at the current generation.
    const reviewers = [...new Set(s.verdicts.filter((v) => v.pass && v.submission === s.latest?.id && v.generation === s.generation).map((v) => v.reviewer))].join(', ')
    const message = `${card.key}: ${card.title}\n\nHive-Card: ${card.key}\nHive-Revision: ${revision}${reviewers ? `\nHive-Reviewed-By: ${reviewers}` : ''}`
    const who = ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`]
    const squash = r.options.style === 'squash'
    const m = await git(f, [...who, 'merge', squash ? '--squash' : '--no-ff', ...(squash ? [] : ['--no-edit', '-m', message]), revision])
    if (!m.ok) {
      const u = await git(f, ['diff', '--name-only', '--diff-filter=U'])
      const files = u.out.split(/\r?\n/).filter(Boolean)
      await git(f, ['merge', '--abort'])
      await git(f, ['reset', '--hard', '-q', expected])
      if (files.length) return { fail: 'conflict', files, log: m.out + m.err }
      return { fail: 'hook', log: m.out + m.err }
    }
    if (squash) {
      const c = await git(f, [...who, 'commit', '-q', '-m', message])
      if (!c.ok) {
        await git(f, ['reset', '--hard', '-q', expected])
        return { fail: 'hook', log: c.out + c.err }
      }
    }
    const h = await G.head(f)
    if (isUnknown(h)) return { pause: 'needsYou' }
    await git(this.project, ['update-ref', `refs/hive/queue/${refSafe(card.key)}`, h])
    return { result: h }
  }

  /** Runs the merge checks (G9); null when they all pass. Installs clean first when the manifests changed (#187). */
  private async mergeChecks(card: CardRecord): Promise<CheckResult | null> {
    const o = this.wf.rulesetOf(card).options
    if (!o.mergeChecks.length) return null
    const f = this.cfg.folder
    const manifests = this.cfg.manifests ?? ['package.json', 'package-lock.json']
    const hash = createHash('sha256')
    for (const m of manifests) hash.update(existsSync(join(f, m)) ? readFileSync(join(f, m)) : `-${m}`)
    const now = hash.digest('hex')
    const key = `queue:installed:${f}`
    if (this.cfg.install && this.wf.store.meta(key) !== now) {
      const i = await this.cfg.install(f, true)
      if (!i.ok) return { ok: false, transient: !!i.transient, output: i.output }
      this.wf.store.setMeta(key, now)
    }
    for (const name of o.mergeChecks) {
      const r = await this.cfg.runCheck(name, o.commands[name] ?? name, f)
      if (!r.ok) return r
    }
    return null
  }

  /** The target checked out nowhere: one compare-and-swap (`update-ref <target> <result> <expected>`). */
  private async advanceRef(card: CardRecord, entry: QueueEntry, target: string, expected: string, result: string): Promise<'done' | 'moved'> {
    await this.write(card, (w) => {
      w.fact('IntegrationStarted', { entry: entry.id, expected, result, checkedOut: null })
    })
    await this.cfg.hooks?.afterStarted?.(entry.id)
    const u = await git(this.project, ['update-ref', `refs/heads/${target}`, result, expected])
    if (!u.ok) {
      await this.moved(card, entry, target)
      return 'moved'
    }
    await this.cfg.hooks?.afterAdvance?.(entry.id)
    return 'done'
  }

  /** The swap found the target moved: this entry failed (transient) and the card is queued again, to be tested again. */
  private async moved(card: CardRecord, entry: QueueEntry, target: string): Promise<void> {
    await this.write(card, (w) => {
      w.fact('IntegrationFailed', { entry: entry.id, revision: entry.revision, target, reason: 'targetMoved', transient: true })
      const s = w.state()
      w.fact('IntegrationRequested', { entry: `${card.key}/e${s.lastSeq + 1}`, revision: entry.revision, key: s.latest?.key ?? null, target, style: w.ruleset!.options.style })
    })
  }

  /**
   * The target checked out in a folder (§16.9.2): conditions checked before anything is touched (else a pause), then
   * a journal: `IntegrationStarted`, phase files, read-tree, phase ref, update-ref, `Integrated`.
   */
  private async advanceCheckedOut(card: CardRecord, entry: QueueEntry, target: string, expected: string, result: string, folder: string): Promise<'done' | 'moved' | { pause: PauseReason; files?: string[] }> {
    if (this.cfg.folderBusy?.(folder)) return { pause: 'folderBusy' }
    const b = await G.branch(folder)
    if (isUnknown(b) || b !== target) return { pause: 'wrongBranch' }
    const staged = await git(folder, ['diff', '--cached', '--quiet', expected])
    if (staged.code !== 0) return { pause: 'staged' }
    const changed = await git(this.project, ['diff', '--name-only', '-z', expected, result])
    if (!changed.ok) return { pause: 'needsYou' }
    const files = changed.out.split('\0').filter(Boolean)
    if (files.length) {
      const st = await git(folder, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...files])
      const busy = st.out.split('\0').filter(Boolean).map((l) => l.slice(3))
      if (!st.ok || busy.length) return { pause: 'unstagedChanges', files: busy }
    }
    const ref = await G.lineHead(this.project, target)
    if (ref !== expected) return 'moved'
    await this.write(card, (w) => {
      w.fact('IntegrationStarted', { entry: entry.id, expected, result, files, checkedOut: folder })
    })
    await this.cfg.hooks?.afterStarted?.(entry.id)
    await this.write(card, (w) => w.fact('IntegrationPhase', { entry: entry.id, phase: 'files' }))
    const rt = await git(folder, ['read-tree', '-m', '-u', expected, result])
    if (!rt.ok) {
      // git refused before writing: the files are as they were. The user's edit since the check pauses (named); anything
      // else is the target moving: back to the test merge.
      const st = await git(folder, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...files])
      const busy = st.out.split(' ').filter(Boolean).map((l) => l.slice(3))
      await this.moved(card, entry, target)
      if (busy.length) return { pause: 'unstagedChanges', files: busy }
      return 'moved'
    }
    await this.cfg.hooks?.afterFiles?.(entry.id)
    await this.write(card, (w) => w.fact('IntegrationPhase', { entry: entry.id, phase: 'ref' }))
    const u = await git(this.project, ['update-ref', `refs/heads/${target}`, result, expected])
    if (!u.ok) {
      await this.write(card, (w) => w.fact('IntegrationPhase', { entry: entry.id, phase: 'rollback' }))
      const back = await git(folder, ['read-tree', '-m', '-u', result, expected])
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
      const f = w.tx.append(card.id, { kind: 'Integrated', actor: 'hive', source: 'recorded', dedupe: `cycle:${st.cycle}`, ...(w.ruleset ? { ruleset: w.ruleset.id } : {}), data: { entry: entry.id, revision, target, result, method, by } })
      w.written.push(f)
      w.move('done', 'derived')
      w.action('releaseSlot', {})
      w.action('endLaneIfDone', {})
      if (this.wf.store.facts(card.id).some((x) => x.kind === 'Decision' && x.seq > startedAt)) this.wf.askUser(w, 'decide', 'decision', `${card.key} was decided after it merged: does it need a follow-up?`) // i18n-ignore: the request's text in the spike (P4 makes it a message)
    })
  }

  /** A conflict, red checks or a hook: `IntegrationFailed`, the card back to its builder with the output (§16.9.1 step 8). */
  private async returnCard(card: CardRecord, entry: QueueEntry, revision: string, target: string, reason: FactData['IntegrationFailed']['reason'], transient: boolean, files?: string[], log?: string): Promise<QueueOutcome> {
    await this.write(card, (w) => {
      w.fact('IntegrationFailed', { entry: entry.id, revision, target, reason, transient, ...(files ? { files } : {}), ...(log ? { log: log.slice(0, 4000) } : {}) })
      w.move('active', 'derived')
      this.wf.wake(w, w.state().started?.builder, `${card.key} came back from the merge queue: ${reason}`)
    })
    return { card: card.key, entry: entry.id, outcome: 'returned', reason, transient }
  }

  /**
   * After a restart (§16.4.5): an entry with `IntegrationStarted` and no outcome is reconciled from the platform, never
   * assumed. Target not checked out: the ref at the result → `Integrated` (observed); at the expected revision → runs
   * again from the test merge; anywhere else → failed (target moved) and containment decides. Checked out: §16.9.2's
   * recovery table, whose last row pauses the queue for that target ("needs you").
   */
  async recover(): Promise<{ card: string; entry: string; outcome: 'integrated' | 'rerun' | 'failed' | 'needsYou' }[]> {
    const out: { card: string; entry: string; outcome: 'integrated' | 'rerun' | 'failed' | 'needsYou' }[] = []
    for (const card of this.wf.store.cards()) {
      const s = this.wf.state(card)
      const e = openEntry(s)
      if (!e || e.state !== 'started' || !e.started) continue
      const { expected, result, checkedOut, files = [] } = e.started
      const ref = await G.lineHead(this.project, e.target)
      const done = async () => {
        await this.write(card, (w) => {
          const f = w.tx.appendObserved(card.id, { kind: 'Integrated', actor: 'outside', source: 'observed', dedupe: `cycle:${s.cycle}`, data: { entry: e.id, revision: e.revision, target: e.target, result, method: 'merge', by: 'hive' } })
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
          await this.write(card, (w) => w.fact('IntegrationFailed', { entry: e.id, revision: e.revision, target: e.target, reason: 'targetMoved', transient: true }))
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
      const at = async (rev: string) => files.length === 0 || ((await git(checkedOut, ['diff', '--cached', '--quiet', rev, '--', ...files])).code === 0 && (await git(checkedOut, ['diff', '--quiet', '--', ...files])).code === 0)
      const phase = e.phases.at(-1)
      const branchOk = (await G.branch(checkedOut)) === e.target
      if (branchOk && ref === expected && phase !== 'rollback' && (await at(expected))) {
        this.rerun.add(e.id)
        out.push({ card: card.key, entry: e.id, outcome: 'rerun' })
      } else if (branchOk && ref === expected && (phase === 'files' || phase === 'ref') && (await at(result))) {
        const u = await git(this.project, ['update-ref', `refs/heads/${e.target}`, result, expected])
        if (u.ok) await done()
        else {
          this.pause(e.target, card, e, 'needsYou', files)
          out.push({ card: card.key, entry: e.id, outcome: 'needsYou' })
        }
      } else if (phase === 'rollback' && (await at(expected))) {
        this.rerun.add(e.id)
        out.push({ card: card.key, entry: e.id, outcome: 'rerun' })
      } else {
        this.pause(e.target, card, e, 'needsYou', files)
        out.push({ card: card.key, entry: e.id, outcome: 'needsYou' })
      }
    }
    return out
  }
}
