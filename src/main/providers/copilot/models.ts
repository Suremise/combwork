import { spawn } from 'child_process'
import { existsSync, mkdirSync } from 'original-fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CatalogModel } from '../../../shared/types'
import { copilotModelLabel } from '../../../shared/copilot'
import { removePath } from '../../fsutil'
import { createLogger } from '../../logger'
import { childArgs, toSpawnable } from '../common'
import type { CatalogRead } from '../types'
import { copilotEnv, copilotHome, noAutoUpdateArgs } from './home'

const log = createLogger('copilot')

/**
 * Copilot's models from the reply to an ACP session/new (`copilot --acp`): `models.availableModels`, each `{ modelId,
 * name, description, _meta: { copilotUsage, copilotEnablement } }`, and `currentModelId`. Read defensively: unknown
 * fields are ignored, a repeated id is listed once (Auto came twice with 1.0.93), and a model the account can't use
 * (copilotEnablement other than "enabled") is shown, not offered. Copilot Free lists Auto only.
 */
export function parseCopilotModels(result: unknown): CatalogRead | null {
  const r = result as { models?: { availableModels?: unknown; currentModelId?: unknown } } | null
  const list = r?.models?.availableModels
  if (!Array.isArray(list)) return null
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const seen = new Set<string>()
  const models: CatalogModel[] = []
  for (const m of list) {
    const value = str((m as Record<string, unknown>)?.modelId)
    if (!value || seen.has(value)) continue
    seen.add(value)
    const meta = ((m as Record<string, unknown>)._meta ?? {}) as Record<string, unknown>
    const out: CatalogModel = { value, label: str((m as Record<string, unknown>).name) ?? copilotModelLabel(value) }
    const description = [str((m as Record<string, unknown>).description), str(meta.copilotUsage) ? `uses ${str(meta.copilotUsage)}` : undefined].filter(Boolean).join(' · ')
    if (description) out.description = description
    const enabled = str(meta.copilotEnablement)
    if (enabled && enabled !== 'enabled') out.unavailable = true
    models.push(out)
  }
  if (!models.length) return null
  const current = str(r?.models?.currentModelId)
  return current ? { models, defaultModel: current } : { models }
}

/** Copilot's arguments for reading its models: an ACP server, not updating itself unless that switch is off (#1167). */
export const catalogArgs = (): string[] => ['--acp', ...noAutoUpdateArgs()]

/**
 * Asks the installed Copilot for the account's models: starts it as an ACP server (no prompt, no sign-in, no cost), opens
 * a session in a folder of Combwork's, and reads session/new's reply. That session leaves a folder in Copilot's session
 * store with no conversation in it; Combwork removes that folder (only it, and only while it holds no events). Null when
 * it couldn't be asked or listed nothing (not signed in, or offline).
 */
export async function readCopilotModels(executable: string, env: Record<string, string>, timeoutMs = 30000): Promise<CatalogRead | null> {
  const o = await askCopilotModels(executable, env, timeoutMs)
  return o.kind === 'ok' ? o.read : null
}

/**
 * What asking Copilot for its models found (HI-2779): its models (`ok`), an error reply (`error`, its message at most
 * 300 characters), no answer (`noAnswer`: not in time, or the process ended or couldn't start first), or an answer it
 * couldn't read (`malformed`). With the models, how many carry Copilot's enablement metadata, so a policy's refusal
 * (every one marked not enabled) is told from a listing that says nothing of it.
 */
export type CopilotModelsOutcome = { kind: 'ok'; read: CatalogRead; enablement: 'all' | 'some' | 'none'; allDisabled: boolean } | { kind: 'error'; message: string } | { kind: 'noAnswer' } | { kind: 'malformed' }

/** The enablement metadata of session/new's models: on all, some or none, and whether every one is marked not enabled. */
export function modelEnablement(result: unknown): { enablement: 'all' | 'some' | 'none'; allDisabled: boolean } {
  const list = (result as { models?: { availableModels?: unknown } } | null)?.models?.availableModels
  const marks = (Array.isArray(list) ? list : []).map((m) => {
    const v = ((m as Record<string, unknown> | null)?._meta as Record<string, unknown> | undefined)?.copilotEnablement
    return typeof v === 'string' && v.trim() ? v.trim() : null
  })
  const known = marks.filter((v): v is string => v !== null)
  const enablement = !known.length ? 'none' : known.length === marks.length ? 'all' : 'some'
  return { enablement, allDisabled: enablement === 'all' && known.every((v) => v !== 'enabled') }
}

/** A JSON-RPC reply as an outcome: its error's message, else its models, else malformed. */
export function modelsOutcome(reply: { result?: unknown; error?: unknown }): CopilotModelsOutcome {
  if (reply.error !== undefined && reply.error !== null) {
    const e = reply.error as { message?: unknown }
    const message = typeof e.message === 'string' ? e.message : (JSON.stringify(reply.error) ?? '')
    return { kind: 'error', message: message.replace(/\s+/g, ' ').trim().slice(0, 300) }
  }
  const read = parseCopilotModels(reply.result)
  return read ? { kind: 'ok', read, ...modelEnablement(reply.result) } : { kind: 'malformed' }
}

/** The same, saying what it found (HI-2779: the sign-in check per host). `env` is the host's, as its sessions get it. */
export function askCopilotModels(executable: string, env: Record<string, string>, timeoutMs = 30000): Promise<CopilotModelsOutcome> {
  const dir = join(tmpdir(), 'combwork-copilot-models')
  mkdirSync(dir, { recursive: true })
  const childEnv = copilotEnv(env)
  return new Promise((resolve) => {
    const s = toSpawnable(executable, catalogArgs())
    const a = childArgs(s)
    const p = spawn(s.file, a.args, { cwd: dir, env: childEnv, windowsHide: true, windowsVerbatimArguments: a.windowsVerbatimArguments, stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    let sessionId: string | null = null
    let settled = false
    const done = (v: CopilotModelsOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      p.kill()
      if (sessionId) void tidySession(childEnv, sessionId)
      resolve(v)
    }
    const noAnswer = (): void => done({ kind: 'noAnswer' })
    const timer = setTimeout(noAnswer, timeoutMs)
    const send = (m: unknown): void => void p.stdin.write(JSON.stringify(m) + '\n')
    p.on('error', noAnswer)
    p.on('exit', noAnswer)
    p.stdin.on('error', noAnswer)
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m: any
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (!m || typeof m !== 'object') continue
        if (m.id === 1) {
          // initialize refused: its error says why, as session/new's would.
          if (m.error !== undefined && m.error !== null) done(modelsOutcome(m))
          else send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: dir, mcpServers: [] } })
        } else if (m.id === 2) {
          sessionId = typeof m.result?.sessionId === 'string' ? m.result.sessionId : null
          done(modelsOutcome(m))
        }
      }
    })
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
  })
}

/** Removes the session folder a model listing left, once Copilot has let go of it: never one holding a conversation. */
async function tidySession(env: Record<string, string>, sessionId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return
  const folder = join(copilotHome(env), 'session-state', sessionId)
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (!existsSync(folder) || existsSync(join(folder, 'events.jsonl'))) return
    try {
      await removePath(folder)
      return
    } catch {
      // Still held by the closing CLI: try again in a moment.
    }
  }
  log.warn('Could not remove the session folder a model listing left in Copilot\'s session store')
}
