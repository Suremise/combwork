// HI-2682 (SPEC §11): a local model's context and output budget, passed to Claude Code at launch on a server connection.
// Resolved for this launch alone, in its own settings scopes (the ones autoCompact.ts reads): a model the session's
// settings map to a Claude model (modelOverrides, modelPicker's behavesAs), or that can't be told because a scope
// couldn't be read, gets none; otherwise the connection's values go into the launch environment, and the values Claude
// Code ends up with (each scope's `env` over the launch's, as it reads them) are recorded with where each came from.
// Never the user's CLI config: the launch environment only.
import type { ServerCaps } from '../../../shared/providers'
import type { LaunchedLimits, ServerModel } from '../../../shared/types'
import { defaultOutput, outputFor } from '../../../shared/localModelLimits'
import { msg, tr } from '../../../shared/i18n'
import { combworkError } from '../../combworkError'
import { effectiveEnv, type SettingsScope } from './autoCompact'

const NOT_BELOW = msg({
  id: 'providers.claude.localLimits.outputNotBelow',
  defaultMessage: '{agent} wasn’t started: its output budget ({output, number} tokens, {outputFrom}) isn’t below its context size ({context, number} tokens, {contextFrom}). Change one of them, then start it again.',
  description: "An error starting an agent on a local model (HI-2682): the output budget Claude Code would get isn't smaller than its context. {agent} is the agent's name; {output} and {context} are numbers of tokens; {outputFrom} and {contextFrom} say where each was set (\"Context size on Local\", \"env in the project's .claude/settings.json\")."
})
const TOO_SMALL = msg({
  id: 'providers.claude.localLimits.tooSmall',
  defaultMessage: '{agent} wasn’t started: its context size ({context, number} tokens, {contextFrom}) is too small for any output budget. Set a larger context size.',
  description: "An error starting an agent on a local model (HI-2682): its context is so small that no output budget fits. {agent} is the agent's name; {context} is a number of tokens; {contextFrom} says where it was set."
})
const OURS_CONTEXT = msg({ id: 'providers.claude.localLimits.oursContext', defaultMessage: 'Context size on {connection}', description: "Where a local model's context came from (HI-2682), in an error or a tooltip: the server connection's model field. {connection} is the connection's name. Context size is the field's name: as translated there." })
const OURS_OUTPUT = msg({ id: 'providers.claude.localLimits.oursOutput', defaultMessage: 'Output budget on {connection}', description: "Where a local model's output budget came from (HI-2682), in an error or a tooltip: the server connection's model field, or its default. {connection} is the connection's name. Output budget is the field's name: as translated there." })
const IN_FILE = msg({ id: 'providers.claude.localLimits.inFile', defaultMessage: 'env in {file}', description: "Where a local model's limit came from (HI-2682): a Claude Code settings file's env block. {file} names the file. env is the block's name: keep it." })

/** A positive whole number of tokens from a variable's value, or null. */
const tokens = (v: string | undefined): number | null => {
  const n = v === undefined ? NaN : Number(v.trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Whether a settings file maps `id` to a Claude model: a modelOverrides value, or a modelPicker row for it with behavesAs. */
export function mapsModel(json: unknown, id: string): boolean {
  if (!json || typeof json !== 'object') return false
  const o = json as Record<string, unknown>
  const same = (v: unknown): boolean => typeof v === 'string' && v.trim().toLowerCase() === id.trim().toLowerCase()
  const overrides = o.modelOverrides
  if (overrides && typeof overrides === 'object' && Object.values(overrides as Record<string, unknown>).some(same)) return true
  const picker = o.modelPicker
  const rows = Array.isArray(picker) ? picker : picker && typeof picker === 'object' ? (picker as Record<string, unknown>).options : undefined
  return Array.isArray(rows) && rows.some((r) => !!r && typeof r === 'object' && same((r as Record<string, unknown>).model) && typeof (r as Record<string, unknown>).behavesAs === 'string')
}

/**
 * The launch's local-model limits (HI-2682): the variables to add to its environment, and what it records. `model` is the
 * model it is told to start on (`--model`), else the effective model variable. Refuses (throws) a launch whose effective
 * output, set in a settings file, isn't below its effective context, or whose context is too small for any output;
 * Combwork's own output that isn't below a context a settings file lowered is replaced by the default for that context.
 */
export function localLimitsFor(o: { caps: ServerCaps; models: readonly ServerModel[]; connection: string; agent: string; model: string | null; env: Record<string, string | undefined>; scopes: readonly SettingsScope[]; test: (id: string) => 'alias' | 'spelling' | null }): { env: Record<string, string>; record: LaunchedLimits | null } {
  const l = o.caps.localLimits
  if (!l) return { env: {}, record: null }
  const model = o.model ?? effectiveEnv(o.env, o.scopes).env[o.caps.modelEnv] ?? null
  if (!model) return { env: {}, record: null }
  const base = { model, connection: o.connection }
  const entry = o.models.find((m) => m.id === model)
  if (!entry) return { env: {}, record: { ...base, applied: false, why: 'notListed' } } // i18n-ignore: a reason's code, said in words where it is shown
  const ruled = o.test(model)
  if (ruled) return { env: {}, record: { ...base, applied: false, why: ruled } }
  // Settings of this session's that Combwork couldn't read could map it: it can't tell, so none.
  const unread = o.scopes.find((s) => s.unsure || s.notJson)
  if (unread) return { env: {}, record: { ...base, applied: false, why: 'unreadable', whyFile: unread.label } } // i18n-ignore: a reason's code, said in words where it is shown
  const mapped = o.scopes.find((s) => mapsModel(s.json, model))
  if (mapped) return { env: {}, record: { ...base, applied: false, why: 'mapped', whyFile: mapped.label } } // i18n-ignore: a reason's code, said in words where it is shown
  const ownOutput = outputFor(entry)
  const ours: Record<string, string> = { ...l.fixedEnv, ...(entry.context ? { [l.contextEnv]: String(entry.context) } : {}), ...(ownOutput ? { [l.outputEnv]: String(ownOutput) } : {}) }
  // What Claude Code ends up with: each settings scope's env over the launch's (the highest wins).
  const eff = effectiveEnv({ ...o.env, ...ours }, o.scopes)
  const context = tokens(eff.env[l.contextEnv])
  const contextFrom = eff.from[l.contextEnv] ?? null
  let output = tokens(eff.env[l.outputEnv])
  const outputFrom = eff.from[l.outputEnv] ?? null
  const fromText = (from: string | null, kind: 'context' | 'output'): string => (from ? tr(IN_FILE, { file: from }) : tr(kind === 'context' ? OURS_CONTEXT : OURS_OUTPUT, { connection: o.connection }))
  let fallback: number | undefined
  if (output === null && !outputFrom) {
    // No output fits its own context (a quarter of it under 1 token): refused, never 0 sent.
    throw combworkError(TOO_SMALL, { agent: o.agent, context: entry.context ?? 0, contextFrom: fromText(null, 'context') }, { kind: 'invalid' })
  }
  if (context !== null && output !== null && output >= context) {
    // A settings file's output wins over the launch's: Combwork can't replace it, so the launch is refused.
    if (outputFrom) throw combworkError(NOT_BELOW, { agent: o.agent, output, outputFrom: fromText(outputFrom, 'output'), context, contextFrom: fromText(contextFrom, 'context') }, { kind: 'invalid' })
    const instead = defaultOutput(context)
    if (instead === null) throw combworkError(TOO_SMALL, { agent: o.agent, context, contextFrom: fromText(contextFrom, 'context') }, { kind: 'invalid' })
    fallback = output
    output = instead
    ours[l.outputEnv] = String(instead)
  }
  return {
    env: ours,
    record: {
      ...base,
      applied: true,
      ...(context !== null ? { context: { value: context, from: contextFrom } } : {}),
      ...(output !== null ? { output: { value: output, from: outputFrom, ...(fallback !== undefined ? { fallback } : {}) } } : {})
    }
  }
}
