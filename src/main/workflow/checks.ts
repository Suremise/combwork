// Runs as checks (SPEC §16.13): a run naming a card and a check counts for a submission only if it was that check's
// configured command, its tested checkout contains the card's revision, the folder was clean at the start and the end,
// and nothing changed in between. Otherwise it is recorded with `counted: false` and why, so the gate and the window
// read the same facts. The card's platform adapter brackets the run (Git: the checkout; None: the declared paths).
//
// "Nothing changed in between" is the watcher's write log (platform/observe.ts: every write and HEAD reflog entry, with
// times). Where it has no complete record of a run (the folder not watched, the watch down meanwhile), the stat snapshot
// below is the fallback: the tracked files (Git) or the deliverables (None) and the HEAD reflog, at the start and the end.

import { randomUUID } from 'crypto'
import { stat } from 'original-fs/promises'
import { join } from 'path'
import { atMost } from '../../shared/atMost'
import { snapshotLine } from '../platform/snapshotLine'
import type { CardRecord } from './factStore'
import type { FactData } from '../../shared/workflow/facts'
import { refusal, type Refusal } from '../../shared/workflow/refusals'
import type { Workflow } from './runtime'

/** Runs a command in a folder; a test acts while it runs. */
export type Exec = (command: string, folder: string) => Promise<{ ok: boolean }>

export interface CheckRun {
  card: CardRecord
  /** The check's name: the project's configured command for it runs (the agent doesn't pass the command). */
  name: string
  by: string
  /** A revision the agent names: must be what's checked out (else refused at once). */
  revision?: string
  /** Run it in a check copy: a folder at the card's revision that nothing else writes (§16.13, `checkCopy`). */
  isolated?: string
  exec: Exec
}

/** Files a snapshot stats at once, off main's thread (the queue's snapshot is of every tracked file). */
const SNAPSHOT_STATS = 8

/**
 * What a stat snapshot sees of a set of files: each one's size and time, and the HEAD reflog's size (each entry adds to
 * it; HI-1814: it was read in full on main to count its lines).
 */
export async function snapshot(folder: string, files: string[], gitDir: string | null): Promise<string> {
  const parts = await atMost(SNAPSHOT_STATS, files, (f) => stat(join(folder, f)).then((s) => snapshotLine(f, s), () => snapshotLine(f, null)))
  if (gitDir) parts.push(`reflog:${await stat(join(gitDir, 'logs', 'HEAD')).then((s) => s.size, () => 0)}`)
  return parts.join('\n')
}

/** Runs a check for a card and records `CheckRan`: counted, or not with why. */
export async function runCheck(wf: Workflow, run: CheckRun): Promise<FactData['CheckRan'] | Refusal> {
  const card = run.card
  const s = wf.state(card)
  const r = wf.rulesetOf(card, s)
  const command = r.options.commands[run.name]
  const started = Date.now()
  const b = await wf.platform(r.options).checkRun(card, s, { command, revision: run.revision, isolated: run.isolated, exec: run.exec })
  if (!('tested' in b)) return refusal(b.rule, b.values, b.rule === 'platform.unknown' ? 'the user' : null) // i18n-ignore: the override field, agent-facing (§16.8.3)
  const data: FactData['CheckRan'] = {
    name: run.name,
    command: command ?? '',
    revision: b.revision,
    tested: b.tested,
    result: b.ok ? 'passed' : 'failed',
    run: randomUUID(),
    durationMs: Date.now() - started,
    by: run.by,
    counted: !b.whyNot,
    ...(b.whyNot ? { whyNot: b.whyNot } : {}),
    ...(run.isolated ? { isolated: true } : {})
  }
  await wf.write(card, r, `agent:${run.by}`, (w) => w.fact('CheckRan', data))
  return data
}

/**
 * A check copy at the card's revision (§16.13's `--isolated`), the remedy when another agent changes files in a shared
 * folder during a run; null where the platform has no isolation (None, OP-16).
 */
export function checkCopy(wf: Workflow, card: CardRecord, folder: string): Promise<string | null> {
  return wf.platformOf(card).checkCopy(card, wf.state(card), folder)
}

/** Does a failed run block a gate? "blocks review for AM-12" (§16.13, P4's Progress panel), for the run's row. */
export function blocks(wf: Workflow, card: CardRecord, check: FactData['CheckRan']): 'review' | null {
  const o = wf.rulesetOf(card).options
  return check.result !== 'passed' && o.preChecks.includes(check.name) ? 'review' : null
}
