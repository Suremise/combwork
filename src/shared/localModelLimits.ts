// HI-2682 (SPEC §11): the context and output budget a local model on a Claude Code server connection launches with. The
// window's model editor judges an ID only by itself (`staticSupport`); whether a launch uses the values is resolved per
// launch, in that session's settings (main/providers/claude/localLimits.ts).
import { fmt, msg } from './i18n'
import type { Tr } from './tasks'
import type { LaunchedLimits } from './types'

/** The most the default output budget is, in tokens: a candidate, not a proven fit (HI-2552 measured 12K–28K first requests). */
export const OUTPUT_DEFAULT_MAX = 8192

/**
 * Below this much room (`context − output`, tokens), the model row warns that Claude Code may not start or compacts at
 * once: HI-2552's full-catalogue first request (27,926 tokens on one server) plus a little. Advice, never a refusal.
 */
export const FIT_ROOM = 32_768

/**
 * The output budget a model launches with when it sets none (HI-2682): 8,192, and at most a quarter of its context; null
 * when the context is too small for any (a quarter of it under 1 token), which a launch refuses rather than sends 0.
 */
export function defaultOutput(context: number | null | undefined): number | null {
  if (!context) return OUTPUT_DEFAULT_MAX
  const n = Math.min(OUTPUT_DEFAULT_MAX, Math.floor(context / 4))
  return n >= 1 ? n : null
}

/** The output a model launches with: its own when set, else the default for its context (null: none fits). */
export const outputFor = (m: { context?: number; output?: number }): number | null => m.output ?? defaultOutput(m.context)

/** Whether a model's context leaves little room once its output is set aside (FIT_ROOM): advice for its row. */
export function tightFit(m: { context?: number; output?: number }): boolean {
  if (!m.context) return false
  const out = outputFor(m)
  return out === null || m.context - out < FIT_ROOM
}

/** Why a model's ID alone rules out its limits (HI-2682), by the CLI's patterns (advanced settings): null when it doesn't. */
export function staticSupport(id: string, alias: RegExp, spelling: RegExp): 'alias' | 'spelling' | null {
  const s = id.trim()
  if (alias.test(s)) return 'alias'
  if (spelling.test(s)) return 'spelling'
  return null
}

/** What a saved output and context say of each other (HI-2682): fine, or the output isn't below the context. */
export const outputFits = (m: { context?: number; output?: number }): boolean => !m.context || !m.output || m.output < m.context

// ---------------------------------------------------------------------------
// The context meter (HI-2682): a launch's limits as applied, never the connection's values now.

const SAME = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * The window the meter uses before Claude Code reports one (HI-2682): the context this launch applied, only while the
 * session runs the model it started on (another model's window is Claude Code's to report); else null (unknown).
 */
export function launchedWindow(limits: LaunchedLimits | undefined, reported: number | null | undefined, running: string | null | undefined): number | null {
  if (reported || !limits?.applied || !limits.context) return null
  return !running || SAME(running, limits.model) ? limits.context.value : null
}

const L = {
  context: msg({ id: 'providers.localLimits.context', defaultMessage: 'Context size {value, number} tokens ({from}){estimate, select, yes {: an estimate until Claude Code reports its window} other {}}', description: "A line of the context tooltip of an agent on a local model (HI-2682): the context its launch gave Claude Code. {value} is a number of tokens; {from} where it was set (\"Context size on Local\", \"env in …settings.json\"). estimate yes: Claude Code hasn't reported its window yet. Keep the select keys." }),
  output: msg({ id: 'providers.localLimits.output', defaultMessage: 'Output budget {value, number} tokens ({from}){fallback, select, none {} other {: {fallback} wasn’t below the context, so the default was used}}', description: "A line of the context tooltip of an agent on a local model (HI-2682): the output budget its launch gave Claude Code. {value} is a number of tokens; {from} where it was set; {fallback}: the budget it replaced, a number already formatted (none: leave that branch empty). Keep the select keys." }),
  ours: msg({ id: 'providers.localLimits.ours', defaultMessage: 'set on {connection}', description: "Where a local model's limit came from, in brackets in its context tooltip (HI-2682): the server connection's model fields, or their default. {connection} is the connection's name." }),
  inFile: msg({ id: 'providers.localLimits.inFile', defaultMessage: 'env in {file}', description: "Where a local model's limit came from, in brackets in its context tooltip (HI-2682): a Claude Code settings file's env block. {file} names the file. env is the block's name: keep it." }),
  switched: msg({ id: 'providers.localLimits.switched', defaultMessage: 'Started on {model} with these: they stay for the session, and Claude Code reports the window of the model it runs now.', description: "A line of the context tooltip of an agent on a local model (HI-2682): the session runs another model than it started on; the limits its launch passed still apply to the whole session. {model} is a model's id." }),
  notUsed: msg({ id: 'providers.localLimits.notUsed', defaultMessage: '{why, select, alias {Context size not used: Claude Code reads {model} as one of its aliases} spelling {Context size not used: IDs with claude, [1m] or a date suffix aren’t supported for it} mapped {Context size not used: {file} maps {model} to a Claude model} unreadable {Context size not used: {file} couldn’t be read, so Combwork can’t tell whether it maps {model}} other {Context size not used: {model} isn’t one of {connection}’s models}}', description: "A line of the context tooltip of an agent on a local model (HI-2682): why its launch passed no context size. {model} is a model's id, {file} a settings file, {connection} the connection's name. Keep [1m] and the select keys." })
}

/** The meter's lines about a launch's local-model limits (HI-2682), for its tooltip: none off a server connection. */
export function localLimitsLines(limits: LaunchedLimits | undefined, reported: number | null | undefined, running: string | null | undefined, tr: Tr): string[] {
  if (!limits) return []
  if (!limits.applied) return [tr(L.notUsed, { why: limits.why ?? 'other', model: limits.model, file: limits.whyFile ?? '', connection: limits.connection })] // i18n-ignore: a reason's code, said in words where it is shown
  const from = (f: string | null): string => (f ? tr(L.inFile, { file: f }) : tr(L.ours, { connection: limits.connection }))
  const switched = !!running && !SAME(running, limits.model)
  return [
    ...(limits.context ? [tr(L.context, { value: limits.context.value, from: from(limits.context.from), estimate: !reported && !switched ? 'yes' : 'no' })] : []),
    ...(limits.output ? [tr(L.output, { value: limits.output.value, from: from(limits.output.from), fallback: limits.output.fallback !== undefined ? fmt.number(limits.output.fallback) : 'none' })] : []),
    ...(switched ? [tr(L.switched, { model: limits.model })] : [])
  ]
}
