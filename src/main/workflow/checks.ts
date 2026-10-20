// Runs as checks (SPEC §16.13): a run naming a card and a check counts for a submission only if it was that check's
// configured command, its tested checkout contains the card's revision, the folder was clean at the start and the end,
// and nothing changed in between. Otherwise it is recorded with `counted: false` and why, so the gate and the window
// read the same facts.
//
// P2 spike (#1118): "nothing changed in between" is read from a stat snapshot of the tracked files (Git) or the
// deliverables (None) and the HEAD reflog, taken at the start and the end; P3's watcher records every write instead.

import { randomUUID } from 'crypto'
import { existsSync, readFileSync, statSync } from 'original-fs'
import { join } from 'path'
import { git } from '../git'
import type { CardRecord } from './factStore'
import type { FactData } from '../../shared/workflow/facts'
import { refusal, type Refusal } from '../../shared/workflow/refusals'
import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import type { Workflow } from './runtime'

/** Runs a command in a folder; `during` lets a test act while it runs. */
export type Exec = (command: string, folder: string) => Promise<{ ok: boolean }>

export interface CheckRun {
  card: CardRecord
  /** The check's name: the project's configured command for it runs (the agent doesn't pass the command). */
  name: string
  by: string
  /** A revision the agent names: must be what's checked out (else refused at once). */
  revision?: string
  /** Run it in a check copy: a detached worktree at the card's revision that nothing else writes (§16.13). */
  isolated?: string
  exec: Exec
}

/** What a stat snapshot sees of a set of files: each one's size and time, and the HEAD reflog's length. */
async function snapshot(folder: string, files: string[], gitDir: string | null): Promise<string> {
  const parts = files.map((f) => {
    try {
      const s = statSync(join(folder, f))
      return `${f}:${s.size}:${s.mtimeMs}`
    } catch {
      return `${f}:gone`
    }
  })
  if (gitDir) {
    const log = join(gitDir, 'logs', 'HEAD')
    parts.push(`reflog:${existsSync(log) ? readFileSync(log, 'utf8').split('\n').length : 0}`)
  }
  return parts.join('\n')
}

/** Runs a check for a card and records `CheckRan`: counted, or not with why. */
export async function runCheck(wf: Workflow, run: CheckRun): Promise<FactData['CheckRan'] | Refusal> {
  const card = run.card
  const s = wf.state(card)
  const r = wf.rulesetOf(card, s)
  const o = r.options
  const command = o.commands[run.name]
  const started = Date.now()
  let whyNot: FactData['CheckRan']['whyNot']
  let revision: string
  let tested: string
  let ok: boolean

  if (o.platform === 'none') {
    // None: the card's revision from its declared paths, at the start and the end, and no deliverable written between.
    const paths = card.paths ?? []
    const before = wf.none.revision(paths)
    const all = wf.none.deliverables()
    const files = isUnknown(all) ? [] : all
    const snapA = await snapshot(wf.cfg.project, files, null)
    ok = command ? (await run.exec(command, wf.cfg.project)).ok : false
    for (const f of files) wf.none.invalidate(f)
    const after = wf.none.revision(paths)
    const snapB = await snapshot(wf.cfg.project, files, null)
    revision = isUnknown(before) ? '' : before.revision
    tested = isUnknown(after) ? '' : after.revision
    if (!command) whyNot = 'notCheck'
    else if (isUnknown(before) || isUnknown(after) || before.revision !== after.revision) whyNot = 'revisionChanged'
    else if (snapA !== snapB) whyNot = 'changed'
  } else {
    const folder = run.isolated ?? wf.folderOf(s)
    // The card's revision: its own line's head, or in a shared folder its newest attributed commit.
    const rev = await wf.revisionNow(card, s)
    const h = await G.head(folder)
    if (isUnknown(rev) || !rev || isUnknown(h)) return refusal('platform.unknown', { card: card.key, what: `the revision in ${folder}`, rule: 'submit.checksPassed' })
    if (run.revision && run.revision !== h) return refusal('check.revisionMismatch', { revision: run.revision.slice(0, 7) }, null)
    revision = rev
    tested = h
    const ls = await git(folder, ['ls-files', '-z'])
    const files = ls.out.split('\0').filter(Boolean)
    const gd = await git(folder, ['rev-parse', '--absolute-git-dir'])
    const gitDir = gd.ok ? gd.out.trim() : null
    const dirtyA = await G.dirty(folder)
    const snapA = await snapshot(folder, files, gitDir)
    ok = command ? (await run.exec(command, folder)).ok : false
    const snapB = await snapshot(folder, files, gitDir)
    const dirtyB = await G.dirty(folder)
    const headB = await G.head(folder)
    const contained = h === rev || (await G.isAncestor(wf.cfg.project, rev, h)) === true
    if (!command) whyNot = 'notCheck'
    else if (!contained) whyNot = 'notContained'
    else if (isUnknown(dirtyA) || isUnknown(dirtyB) || dirtyA.length || dirtyB.length) whyNot = 'dirty'
    else if (headB !== h) whyNot = 'moved'
    else if (snapA !== snapB) whyNot = 'changed'
  }
  const data: FactData['CheckRan'] = {
    name: run.name,
    command: command ?? '',
    revision,
    tested,
    result: ok ? 'passed' : 'failed',
    run: randomUUID(),
    durationMs: Date.now() - started,
    by: run.by,
    counted: !whyNot,
    ...(whyNot ? { whyNot } : {}),
    ...(run.isolated ? { isolated: true } : {})
  }
  await wf.write(card, r, `agent:${run.by}`, (w) => w.fact('CheckRan', data))
  return data
}

/**
 * Makes a check copy: a detached worktree at the card's revision (§16.13's `--isolated`), the remedy when another agent
 * changes files in a shared folder during a run. None has no check copies (no isolation, OP-16).
 */
export async function checkCopy(wf: Workflow, card: CardRecord, folder: string): Promise<string | null> {
  const s = wf.state(card)
  const rev = await wf.revisionNow(card, s)
  if (isUnknown(rev) || !rev) return null
  const r = await git(wf.cfg.project, ['worktree', 'add', '--detach', folder, rev])
  return r.ok ? folder : null
}

/** Does a failed run block a gate? "blocks review for AM-12" (§16.13, P4's Progress panel), for the run's row. */
export function blocks(wf: Workflow, card: CardRecord, check: FactData['CheckRan']): 'review' | null {
  const o = wf.rulesetOf(card).options
  return check.result !== 'passed' && o.preChecks.includes(check.name) ? 'review' : null
}
