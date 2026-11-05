import { basename } from 'path'
import type { CapturedEvent } from '../shared/devConsole'
import { DETAILS_FIELDS, TRANSCRIPT_FIELDS, safeWord } from '../shared/devConsole'
import type { LiveSessionState, ProviderId } from '../shared/types'
import type { LiveDetails } from './providers/types'

/**
 * The developer console's summary lines (#636): what came in and what Combwork made of it, in Combwork's own words. Never the
 * CLI's or anyone's text: values go through safeWord(), which keeps numbers and identifiers only and says the rest is
 * text; Combwork's own names (agents, projects) through combworkName() as the event is kept.
 */

export function hookSummary(name: string, tool: unknown, event: string, status: string, actions: string[], replied: boolean): string {
  const t = safeWord(tool)
  return `${safeWord(name) || '(unnamed)'}${t ? ` (${t})` : ''} → ${event}; ${status}${actions.length ? `; ${actions.join(', ')}` : ''}${replied ? '; replied' : ''}`
}

export function detailsSummary(d: LiveDetails): string {
  const parts: string[] = []
  if (d.modelId || d.modelName) parts.push(`model ${safeWord(d.modelId ?? d.modelName)}`) // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
  if (d.effort) parts.push(`effort ${safeWord(d.effort)}`) // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
  if (typeof d.costUsd === 'number' && Number.isFinite(d.costUsd)) parts.push(`$${d.costUsd.toFixed(2)}`)
  if (typeof d.contextWindow === 'number') parts.push(`window ${d.contextWindow}`) // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
  if (d.permissionMode) parts.push(`mode ${safeWord(d.permissionMode)}`) // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
  if (d.planMode !== undefined) parts.push(`plan mode ${d.planMode ? 'on' : 'off'}`) // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
  for (const l of (d.planUsage?.limits ?? []).slice(0, 6)) parts.push(`${safeWord(l.id)} ${Math.round(Number(l.usedPercent) || 0)}%`)
  if (d.signIn) parts.push('sign-in refused') // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
  if (d.interruptedAt) parts.push('interrupted')
  return parts.join(' · ')
}

export const statusLineSummary = (d: LiveDetails): string => `status line → ${detailsSummary(d) || 'nothing new'}` // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)

/** At most this many of a read's newest records go into its event (each redacted, the event bounded). */
const RECORDS = 10

/** A transcript read: its newest records as they were written, next to the details Combwork read from them. */
export function transcriptEvent(provider: ProviderId, chunk: string, d: LiveDetails): CapturedEvent {
  const lines = chunk.split('\n').filter((l) => l.trim())
  const newest = lines.slice(-RECORDS).map((l) => {
    try {
      return JSON.parse(l) as unknown
    } catch {
      return { unparsed: l.length }
    }
  })
  const said = detailsSummary(d)
  return { kind: 'transcript', name: 'transcript', provider, raw: { records: lines.length, newest }, made: d, safe: { raw: TRANSCRIPT_FIELDS, made: DETAILS_FIELDS }, summary: `transcript +${lines.length} record${lines.length === 1 ? '' : 's'} → ${said || 'nothing new'}` } // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
}

/**
 * Option names the CLIs Combwork runs take (Claude Code's, Codex's, Copilot's): a launch keeps an argument only when it is
 * exactly one of these. A name from this list is never someone's text; anything else (an option's value, inline after
 * `=` or the next argument, even one that begins with a dash, and positionals) is only counted.
 */
const KNOWN_SWITCHES = new Set([
  '--acp', '--additional-mcp-config', '--allow-all', '--allow-all-mcp-server-instructions', '--allow-all-tools', '--allow-tool', '--allowedTools', '--append-system-prompt-file', '--autopilot',
  '--continue', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-skip-permissions', '--disable-builtin-mcps', '--disable-mcp-server', '--effort', '--full-auto', '--mcp-config', '--model',
  '--name', '--no-auto-update', '--no-daemon', '--permission-mode', '--plugin-dir', '--reasoning-effort', '--resume', '--sandbox', '--ask-for-approval', '--session-id', '--settings',
  '--strict-mcp-config', '--system-prompt-snapshot', '--verbose', '-c', '-m', '-a', '-s', '-C', '-p'
])

/**
 * A launch: the CLI, its version, the known option names it was given (KNOWN_SWITCHES) and how many other arguments,
 * never their text: an option's value, inline (`--append-system-prompt=…`) or not, can be a prompt, and a value can
 * begin with a dash.
 */
export function launchEvent(l: { provider: ProviderId; name: string; file: string; args: string[]; cwd: string; version: string | null; state: Pick<LiveSessionState, 'status' | 'permissionMode' | 'modelId' | 'effort'>; resumed: boolean }): CapturedEvent {
  const switches = l.args.filter((a) => KNOWN_SWITCHES.has(a)).slice(0, 40)
  return {
    kind: 'launch',
    name: 'launch',
    provider: l.provider,
    raw: { file: basename(l.file), switches, otherArgs: l.args.length - switches.length, cwd: l.cwd, version: l.version },
    made: { status: l.state.status, permissionMode: l.state.permissionMode, modelId: l.state.modelId, effort: l.state.effort, resumed: l.resumed },
    safe: { raw: { file: true, switches: true, cwd: true, version: true }, made: { status: true, permissionMode: true, modelId: true, effort: true } },
    summary: `${l.name} ${safeWord(l.version)} started${l.resumed ? ' (resumed)' : ''}; ${l.state.status}`
  }
}
