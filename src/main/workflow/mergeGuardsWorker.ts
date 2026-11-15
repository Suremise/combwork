import { parentPort } from 'worker_threads'
import { compileGuard, matchGuards, parseAddedLines, type GuardProblem, type GuardReport, type MergeGuard } from '../../shared/workflow/mergeGuards'

/**
 * The merge guards' worker (HI-3284, design HI-3284/s16): a user's patterns are run only here, never on main's thread,
 * where a pattern that backtracks would hold every keystroke. One worker per check, ended by its caller when the check
 * ends, runs past its time limit or is cancelled (mergeGuardsRun.ts), so a runaway pattern takes nothing with it. It
 * tells its caller which guard it starts on, so a time limit can name the guard that was running. No Electron here (a
 * worker can't load it).
 */

export type GuardsRequest = { type: 'check'; diff: string; guards: MergeGuard[]; maxLines: number } | { type: 'empty'; guards: MergeGuard[] }

export type GuardsReply = { running: string } | { report: GuardReport } | { problems: GuardProblem[] }

/** Runs one request, telling `post` of each guard it starts on; returns its answer. */
export function handleGuards(m: GuardsRequest, post: (r: GuardsReply) => void): GuardsReply {
  if (m.type === 'empty') {
    const problems: GuardProblem[] = []
    m.guards.forEach((g, i) => {
      post({ running: String(i) })
      try {
        if (compileGuard(g).test('')) problems.push({ guard: i, field: 'pattern', why: 'matchesEmpty' }) // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
      } catch (e) {
        problems.push({ guard: i, field: 'pattern', why: 'invalid', detail: e instanceof Error ? e.message : String(e) }) // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
      }
    })
    return { problems }
  }
  const added = parseAddedLines(m.diff, m.maxLines)
  if ('incomplete' in added) return { report: { hits: [], more: 0, messages: [], incomplete: added.incomplete === 'tooManyLines' ? 'tooLarge' : 'malformed' } } // i18n-ignore: a reason's code
  return { report: matchGuards(added.files, m.guards, (name) => post({ running: name })) }
}

const port = parentPort
if (port) {
  port.on('message', (m: GuardsRequest) => {
    const post = (r: GuardsReply): void => port.postMessage(r)
    post(handleGuards(m, post))
  })
}
