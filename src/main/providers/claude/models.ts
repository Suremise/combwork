import { spawn } from 'child_process'
import { mkdirSync } from 'original-fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CatalogModel } from '../../../shared/types'
import { childArgs, toSpawnable } from '../common'
import type { CatalogRead } from '../types'

/**
 * Claude Code's models, from the Agent SDK's initialize control request (#125): what its VS Code extension builds its
 * model menu from. It sends no prompt and uses no tokens. The reply is the SDK's protocol, not a documented command,
 * so it is read defensively: only the models are read (never `account` or the other personal fields), unknown fields
 * are ignored, and a model's missing or odd field is left out, so Combwork falls back for it. Checked with 2.1.289.
 */

/** The arguments: print mode reading and writing stream-json, nothing saved, no MCP servers started. */
export const INITIALIZE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config']
const REQUEST_ID = 'combwork-models'
export const INITIALIZE_REQUEST = JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'initialize' } })

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const levels = (v: unknown): string[] | undefined => (Array.isArray(v) ? [...new Set(v.map(str).filter((x): x is string => !!x))] : undefined)

/** Whether a model states its effort levels validly: supportsEffort a boolean, or a list with at least one level. */
const statesEffort = (m: Record<string, unknown>): boolean => typeof m.supportsEffort === 'boolean' || !!levels(m.supportedEffortLevels)?.length

/**
 * A model's effort levels as the reply establishes them (#125, round 2): its valid levels; none ([]) only when that is
 * what it says (supportsEffort false, an empty list, or, in a reply whose models state their levels, neither field: Haiku
 * with 2.1.289); unknown (undefined: Combwork falls back) when a field is odd: supportsEffort not a boolean, a list that
 * isn't one or holds no valid level, levels with supportsEffort false, or supportsEffort true without levels.
 */
function effortsOf(m: Record<string, unknown>, replyStates: boolean): string[] | undefined {
  if (!replyStates) return undefined
  const flag = m.supportsEffort
  if (flag !== undefined && typeof flag !== 'boolean') return undefined
  if (!('supportedEffortLevels' in m)) return flag === true ? undefined : []
  const list = m.supportedEffortLevels
  if (!Array.isArray(list)) return undefined
  if (!list.length) return flag === true ? undefined : []
  const valid = levels(list)!
  return valid.length && flag !== false ? valid : undefined
}

/**
 * Whether a model runs in Auto, as the reply establishes it: supportsAutoMode when a boolean; absent, in a reply whose
 * models state it, no (Haiku with 2.1.289); anything else (a string, a number) unknown, so Combwork falls back.
 */
function autoOf(m: Record<string, unknown>, replyStates: boolean): boolean | undefined {
  if (!replyStates) return undefined
  if (!('supportsAutoMode' in m)) return false
  return typeof m.supportsAutoMode === 'boolean' ? m.supportsAutoMode : undefined
}

/**
 * The models in an initialize reply (its `response`: the control_response's inner one), or null when it has none.
 * "default" (what runs when no model is passed) isn't offered: it is the pickers' "Claude Code default", and its model
 * is defaultModel. Per-model flags are only trusted when the reply states them validly at all: then a model without
 * them has no effort or no Auto, and an odd field means unknown, never "none" (effortsOf, autoOf); an older reply
 * without them says nothing either way.
 */
export function parseClaudeInitialize(reply: unknown): CatalogRead | null {
  const r = reply && typeof reply === 'object' ? (reply as Record<string, unknown>) : null
  const raw = Array.isArray(r?.models) ? (r!.models as unknown[]) : null
  if (!raw) return null
  const entries = raw.filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && !!str((m as Record<string, unknown>).value))
  // Only valid fields are evidence that the reply states these at all (an odd field on one model isn't).
  const usesEffort = entries.some(statesEffort)
  const usesAuto = entries.some((m) => typeof m.supportsAutoMode === 'boolean')
  const read = (m: Record<string, unknown>, unavailable: boolean): CatalogModel => {
    const value = str(m.value)!
    const out: CatalogModel = { value, label: str(m.displayName) ?? value }
    const resolved = str(m.resolvedModel)
    if (resolved && resolved !== value) out.resolved = resolved
    const description = str(m.description)
    if (description) out.description = description
    const efforts = effortsOf(m, usesEffort)
    if (efforts) out.efforts = efforts
    const auto = autoOf(m, usesAuto)
    if (auto !== undefined) out.supportsAuto = auto
    if (unavailable) out.unavailable = true
    return out
  }
  const def = entries.find((m) => m.value === 'default')
  const models = entries.filter((m) => m.value !== 'default').map((m) => read(m, false))
  const seen = new Set(models.map((m) => m.value))
  const off = Array.isArray(r!.unavailable_models) ? (r!.unavailable_models as unknown[]) : []
  for (const m of off) if (m && typeof m === 'object' && str((m as Record<string, unknown>).value) && !seen.has(str((m as Record<string, unknown>).value)!)) models.push(read(m as Record<string, unknown>, true))
  if (!models.length) return null
  const defaultModel = def ? (str(def.resolvedModel) ?? undefined) : undefined
  return { models, ...(defaultModel ? { defaultModel } : {}) }
}

/**
 * Asks the installed Claude Code for its models: starts it in print mode in a folder of Combwork's own, sends initialize,
 * and closes it as soon as the reply comes (or after timeoutMs). Null on any failure. env: the sessions' environment
 * (ptyHost childEnv), without Combwork's own variables.
 */
export function readClaudeModels(executable: string, env: Record<string, string>, timeoutMs = 20_000): Promise<CatalogRead | null> {
  const cwd = join(tmpdir(), 'combwork-claude-models')
  mkdirSync(cwd, { recursive: true })
  const s = toSpawnable(executable, INITIALIZE_ARGS)
  return new Promise((resolve) => {
    let done = false
    let buf = ''
    let p: ReturnType<typeof spawn>
    const finish = (v: CatalogRead | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        // Its input closed first: through a .cmd launcher, kill() ends only cmd.exe, and the CLI then sees its input end.
        p.stdin?.end()
        p.kill()
      } catch {
        // already gone
      }
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      const a = childArgs(s)
      p = spawn(s.file, a.args, { cwd, env, windowsHide: true, windowsVerbatimArguments: a.windowsVerbatimArguments, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      finish(null)
      return
    }
    p.on('error', () => finish(null))
    p.on('exit', () => finish(null))
    p.stdout!.setEncoding('utf8')
    p.stdout!.on('data', (d: string) => {
      buf += d
      if (buf.length > 4 * 1024 * 1024) return finish(null)
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('{')) continue
        let m: Record<string, any>
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.type !== 'control_response' || m.response?.request_id !== REQUEST_ID) continue
        // An error reply has no inner response: null.
        return finish(parseClaudeInitialize(m.response?.response))
      }
    })
    p.stdin!.on('error', () => undefined)
    p.stdin!.write(INITIALIZE_REQUEST + '\n')
  })
}
