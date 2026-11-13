// What a jj card's builder and its card are told when its pre-integration candidate returns it (HI-2871, design
// HI-2871/s21): a conflict with its target, or a change that isn't up to date or the same once brought up to date. The
// facts are the queue's (`IntegrationFailed`, its entry `jj:<attempt>`: jj has no merge queue), the words jj's own:
// nothing came back "from the merge queue", and the next step is jj's (bring the target in on the card's line).

import { agentMsg, say } from '../../shared/agentText'
import { inDefaultDialect } from '../../shared/agentText/asyncScope'
import type { FactData } from '../../shared/workflow/facts'
import { HISTORY, storedText } from '../../shared/taskHistory'
import type { StoredText } from '../../shared/types'

/** The files a wake or comment names at most. */
const FILES_MAX = 8
/** The log's last lines a wake quotes, on one line, at most this long. */
const LOG_MAX = 600

const T = {
  checks: agentMsg({ id: 'jj.candidate.checks', text: '{card} came back from its jj candidate on {target}: its merge check {check} failed on the candidate.{log, select, none {} other { Last lines: {log}}}{path, select, none {} other { Its whole log: {path}}} Fix it in your change with jj (bring {target} in first if the failure is in how they combine), commit and submit again (cw_submit). Combwork builds a new candidate and runs its checks once it is approved again.', note: "HI-2938: a jj card's builder is told its approved card came back to it: Combwork built the change onto its target bookmark ({target}) and the project's merge check {check} (its name) failed on that result. {card}: its key. {log}: the check's last lines (none: left out). {path}: its log file (none: left out). jj is the tool's name; cw_submit is a tool's name." }),
  returned: agentMsg({ id: 'jj.candidate.returned', text: '{card} came back from its jj candidate on {target}: {why, select, conflict {it conflicts with {target}} notUpToDate {it isn\'t up to date with {target}} other {{why}}}{files, select, none {} other { (in {files})}}.{log, select, none {} other { Last lines: {log}}} Bring {target} into your change with jj (rebase it onto {target}, or merge {target} in), resolve any conflict, commit and submit again (cw_submit). Combwork builds a new candidate once it is approved again.', note: "HI-2871: a jj card's builder is told its approved card came back to it: Combwork built the change onto its target bookmark ({target}) to check it before the user integrates it, and it conflicts or isn't up to date. {card}: its key. {why}: the reason (keep the select keys). {files}: the files concerned (none: that part is left out). {log}: the last lines of what jj said (none: left out). jj is the tool's name; cw_submit is a tool's name." })
}

/** The entry an IntegrationFailed of a jj candidate names: its attempt (no queue entry exists for jj). */
export const jjCandidateEntry = (attempt: string): string => `jj:${attempt}`

const filesOf = (f: FactData['IntegrationFailed']): string => (f.files?.length ? `${f.files.slice(0, FILES_MAX).join(', ')}${f.files.length > FILES_MAX ? ', …' : ''}` : 'none')
const logOf = (f: FactData['IntegrationFailed']): string => {
  const l = (f.log ?? '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' | ')
  return !l ? 'none' : l.length > LOG_MAX ? `…${l.slice(l.length - LOG_MAX + 1)}` : l
}

/** The builder's wake for a returned jj card (agent-facing, English). */
export const jjReturnedWake = (key: string, f: FactData['IntegrationFailed']): string =>
  f.reason === 'checks' ? say(T.checks, { card: key, target: f.target, check: f.check ?? '', log: logOf(f), path: f.logPath ?? 'none' }) : say(T.returned, { card: key, target: f.target, why: f.reason, files: filesOf(f), log: logOf(f) })

/** The card's comment for a returned jj card: its English text for agents, and what the window shows (translated). */
export function jjReturnedComment(key: string, f: FactData['IntegrationFailed']): { text: string; shown: StoredText } {
  return { text: inDefaultDialect(() => jjReturnedWake(key, f)), shown: storedText(HISTORY.jjCandidateReturned, { reason: f.reason, target: f.target, files: filesOf(f), check: f.check ?? '' }) }
}
