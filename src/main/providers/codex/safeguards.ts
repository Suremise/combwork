import { SAFEGUARD_DEFAULTS, SAFEGUARD_TOOLS, newStop, type SafeguardEvent } from '../../../shared/safeguards'

/** What the reading keeps between reads (the launch's memo): the model the agent runs on, its last tool calls, the turn, the stops seen. */
interface Memo {
  model?: string
  tools?: string[]
  /** The turn it is in (its turn_id, or the count of turns started where the rollout names none). */
  turn?: string
  turns?: number
  /** The stops' identities seen (newStop). */
  ids?: string[]
  /** The model a reroute moved the agent to: a turn on another one is the agent back on its own (a reroute is per request). */
  rerouted?: string
}

/** The error kind of Codex's structured error info: a code ("cyber_policy") or an object keyed by it. */
function errorKind(info: unknown): string | null {
  if (typeof info === 'string') return info
  if (info && typeof info === 'object') return Object.keys(info)[0] ?? null
  return null
}

/**
 * Codex's safeguards in rollout lines (#606), as Codex 0.160 names them (in its protocol; not seen in a real rollout
 * yet): a request it flags is rerouted to another model (event_msg `model_reroute`, with from_model, to_model and a
 * reason, SAFEGUARD_DEFAULTS.codexReroute), and a turn its usage policy stops ends with an error whose
 * `codex_error_info` names the policy (SAFEGUARD_DEFAULTS.codexStop), in an `error` event, the turn's end, or both.
 * A reroute is a stop on the model it left and a switch the safeguard made (flagged). Each stop counts once by its
 * turn (a policy's error and the turn's end report the same one; a reroute is one per turn and models), however close
 * two turns' stops are.
 */
export function codexSafeguards(appended: string, memo: Record<string, unknown>): SafeguardEvent[] {
  const m = memo as Memo
  const reroute: readonly string[] = SAFEGUARD_DEFAULTS.codexReroute
  const stops: readonly string[] = SAFEGUARD_DEFAULTS.codexStop
  const out: SafeguardEvent[] = []
  const stop = (at: number, id: string, model = m.model): void => {
    if (!newStop(m, id)) return
    out.push({ kind: 'stop', at, ...(model ? { model } : {}), tools: [...(m.tools ?? [])], id })
  }
  const turn = (): string => m.turn ?? `turn ${m.turns ?? 0}` // i18n-ignore: an id for a turn, never shown
  const tool = (name: string): void => {
    m.tools = [...(m.tools ?? []), name].slice(-SAFEGUARD_TOOLS)
  }
  for (const line of appended.split('\n')) {
    if (!line.trim()) continue
    let r: { timestamp?: string; type?: string; payload?: Record<string, any> }
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const p = r?.payload
    if (!p || typeof p !== 'object') continue
    const at = Date.parse(r.timestamp ?? '') || Date.now()
    if (r.type === 'event_msg' && p.type === 'task_started') {
      m.turns = (m.turns ?? 0) + 1
      m.turn = typeof p.turn_id === 'string' && p.turn_id ? p.turn_id : undefined
    }
    if (r.type === 'turn_context' && typeof p.model === 'string') {
      if (m.rerouted && p.model !== m.rerouted) out.push({ kind: 'switch', at, from: m.rerouted, to: p.model })
      m.rerouted = undefined
      m.model = p.model
    } else if (r.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const name = String(p.name ?? 'tool')
        tool(/exec_command|shell|local_shell/.test(name) ? 'Shell' : name === 'apply_patch' ? 'Edit' : name) // i18n-ignore: a tool's name, matched by the safeguards
      } else if (p.type === 'local_shell_call') tool('Shell') // i18n-ignore: a tool's name, matched by the safeguards
      else if (p.type === 'web_search_call') tool('WebSearch')
    } else if (r.type === 'event_msg') {
      if (p.type === 'thread_settings_applied' && typeof p.thread_settings?.model === 'string') m.model = p.thread_settings.model
      else if (p.type === 'model_reroute' && typeof p.to_model === 'string' && reroute.includes(String(p.reason ?? ''))) {
        const from = typeof p.from_model === 'string' && p.from_model ? p.from_model : m.model
        stop(at, `${turn()} reroute ${from ?? ''}>${p.to_model}`, from) // i18n-ignore: an id for a stop, never shown
        if (from && from !== p.to_model) out.push({ kind: 'switch', at, from, to: p.to_model, flagged: true })
        m.model = p.to_model
        m.rerouted = p.to_model
      } else if (p.type === 'error' || p.type === 'task_complete') {
        const info = p.type === 'error' ? p.codex_error_info : p.error?.codex_error_info
        const kind = errorKind(info)
        const its = p.type === 'task_complete' && typeof p.turn_id === 'string' && p.turn_id ? p.turn_id : turn()
        if (kind && stops.includes(kind)) stop(at, `${its} policy`)
      }
    }
  }
  return out
}
