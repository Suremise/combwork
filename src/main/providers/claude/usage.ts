import type { CompactionEvent, DayUsage, SessionUsage, SubSession, UsageTokens } from '../../../shared/types'
import { addTokens, emptyDay, localDay } from '../../../shared/usageDays'
import { TimelineBuilder } from '../../../shared/usageTimeline'
import { CLAUDE_CODE } from '../../../shared/claude'
import { isSessionId } from '../../../shared/defaults'
import { countSafeguards } from '../../../shared/safeguards'
import { claudeSafeguards } from './safeguards'
import { isUserPrompt } from './prompts'

/**
 * Whether a transcript (its first line) is a sub-agent's: Claude Code marks a sub-agent's messages `isSidechain`, and
 * `sessionId` is the session that started it. (Claude Code keeps them apart from the conversations it lists, so the
 * project folder rarely has one.) Null for a conversation, and for a first line that says neither.
 */
export function transcriptSubSession(line: string, sessionId: string): SubSession | null {
  try {
    const o = JSON.parse(line)
    if (o?.isSidechain !== true) return null
    const parentId = typeof o.sessionId === 'string' && isSessionId(o.sessionId) && o.sessionId !== sessionId ? o.sessionId : null
    return { parentId, kind: 'sub-agent' }
  } catch {
    return null
  }
}

/**
 * Which entries are a sub-agent's work inside a conversation (skipped: its own transcript has it), as opposed to a
 * sub-agent's own transcript, where every entry is `isSidechain`: decided by the first message.
 */
export class SidechainFilter {
  private own: boolean | null = null

  skip(o: Record<string, any>): boolean {
    if (this.own === null && (o.type === 'user' || o.type === 'assistant')) this.own = o.isSidechain === true
    return o.isSidechain === true && this.own !== true
  }
}

/** Claude Code stores transcripts under ~/.claude/projects/<encoded>, where every non-alphanumeric character becomes '-'. */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-')
}

interface UsageBlock {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
}

/**
 * A request's tokens, the local day it ran on and when (its place in the timeline: usageTimeline.ts), and its model (#1106).
 * Its tokens only, not the usage block as written (HI-1912): the block's other fields took most of a saved state's space.
 */
interface Request {
  t: UsageTokens
  day: string
  at: string | undefined
  model: string | null
}

const tokensOf = (u: UsageBlock): UsageTokens => ({
  inputTokens: u.input_tokens ?? 0,
  outputTokens: u.output_tokens ?? 0,
  cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  cacheReadTokens: u.cache_read_input_tokens ?? 0
})

/**
 * Reads a Claude Code JSONL transcript into usage statistics, a piece at a time (transcripts only grow, so a
 * running session's is read from where it left off). Tolerant of unknown entry types and malformed lines: the
 * format belongs to Claude Code and may change.
 */
export class ClaudeUsageParser {
  private usage: SessionUsage
  // A single API response is written as several assistant entries (one per content block) that repeat
  // the same usage, so count each request once — the last entry for a request carries the final numbers.
  private byRequest = new Map<string, Request>()
  private sidechain = new SidechainFilter()
  private customTitle: string | null = null
  private aiTitle: string | null = null
  private saw1h = false
  /** Requests no cost report covers yet. */
  private uncovered = new Set<string>()
  /** Each cost report (Claude Code's running total, written now and then): its total and the requests it newly covers. */
  private reports: { total: number; keys: string[] }[] = []
  private prompts = new Map<string, number>()
  private compactionDays: string[] = []
  /** Safeguard stops by the model they stopped (#606), its records of stops it may have asked about per turn, and the detection's own memo. */
  private safeguards: Record<string, number> = {}
  private safeguardsAsked: Record<string, number> = {}
  private safeguardMemo: Record<string, unknown> = {}

  constructor(sessionId: string) {
    this.usage = {
      provider: CLAUDE_CODE,
      sessionId,
      title: null,
      model: null,
      cliVersion: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      requests: 0,
      reasoningTokens: 0,
      contextTokens: 0,
      contextWindow: null,
      compactions: [],
      cacheTtlSeconds: 300,
      firstActivity: null,
      lastActivity: null,
      userMessages: 0,
      lastPrompt: null,
      costUsd: null,
      costEstimated: false
    }
  }

  /** Reads whole lines of the transcript (the next part of it). */
  feed(text: string): void {
    const usage = this.usage
    countSafeguards(this.safeguards, claudeSafeguards(text, this.safeguardMemo), this.safeguardsAsked)
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let o: Record<string, any>
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      const ts: string | undefined = o.timestamp
      const side = this.sidechain.skip(o)
      if (ts && !side) {
        if (!usage.firstActivity || ts < usage.firstActivity) usage.firstActivity = ts
        if (!usage.lastActivity || ts > usage.lastActivity) usage.lastActivity = ts
      }
      const day = localDay(ts) || localDay(usage.lastActivity)
      if (o.version && typeof o.version === 'string') usage.cliVersion = o.version

      switch (o.type) {
        case 'assistant': {
          const msg = o.message ?? {}
          const u: UsageBlock | undefined = msg.usage
          if (msg.model && msg.model !== '<synthetic>') usage.model = msg.model
          if (!u) break
          const key = o.requestId ?? msg.id ?? o.uuid ?? String(this.byRequest.size)
          const known = this.byRequest.get(key)
          this.byRequest.set(key, { t: tokensOf(u), day: known?.day || day, at: known?.at ?? (ts || usage.lastActivity || undefined), model: known?.model ?? usage.model })
          if (!known) this.uncovered.add(key)
          if (!side) {
            // The output (thinking included) stays in the context: what Claude Code compacts on is input + output.
            usage.contextInputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
            usage.lastOutputTokens = u.output_tokens ?? 0
            usage.contextTokens = usage.contextInputTokens + usage.lastOutputTokens
          }
          if ((u.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) this.saw1h = true
          break
        }
        case 'user':
          if (!side && isUserPrompt(o)) {
            usage.userMessages++
            this.prompts.set(day, (this.prompts.get(day) ?? 0) + 1)
          }
          break
        case 'system':
          if (o.subtype === 'compact_boundary') {
            const m = o.compactMetadata ?? {}
            const c: CompactionEvent = {
              timestamp: ts ?? '',
              trigger: m.trigger ?? 'unknown',
              preTokens: m.preTokens ?? 0,
              postTokens: m.postTokens ?? 0,
              ...(usage.contextInputTokens !== undefined ? { lastInputTokens: usage.contextInputTokens, lastOutputTokens: usage.lastOutputTokens ?? 0 } : {})
            }
            usage.compactions.push(c)
            this.compactionDays.push(day)
            if (c.postTokens) {
              usage.contextTokens = c.postTokens
              usage.contextInputTokens = c.postTokens
              usage.lastOutputTokens = 0
            }
          }
          break
        case 'custom-title':
          if (o.customTitle ?? o.title) this.customTitle = o.customTitle ?? o.title
          break
        case 'ai-title':
          if (o.aiTitle ?? o.title) this.aiTitle = o.aiTitle ?? o.title
          break
        case 'last-prompt':
          if (typeof o.lastPrompt === 'string') usage.lastPrompt = o.lastPrompt
          break
        case 'cost-state':
          if (typeof o.totalCostUSD === 'number') {
            usage.costUsd = o.totalCostUSD
            this.reports.push({ total: o.totalCostUSD, keys: [...this.uncovered] })
            this.uncovered.clear()
          }
          break
        case 'summary':
          if (o.summary && !this.aiTitle) this.aiTitle = o.summary
          break
      }
    }
  }

  /** The usage so far: a new object each time (the parser keeps reading). Day costs come later (withDayCosts). */
  result(): SessionUsage {
    const usage: SessionUsage = { ...this.usage, compactions: [...this.usage.compactions] }
    const days: Record<string, DayUsage> = {}
    const dayOf = (d: string): DayUsage => (days[d] ??= emptyDay())
    // Each cost report's increase, and which report covers each request (for the timeline: a report's charge is split
    // only between its own requests).
    const reportOf = new Map<string, number>()
    let before = 0
    const charges = this.reports.map((rep, i) => {
      for (const key of rep.keys) reportOf.set(key, i)
      const costUsd = Math.max(0, rep.total - before)
      before = rep.total
      return costUsd
    })
    const timeline = new TimelineBuilder()
    for (const [key, r] of this.byRequest) {
      const t = r.t
      addTokens(usage, t)
      const d = dayOf(r.day)
      addTokens(d, t)
      d.requests++
      timeline.add(r.at, t, 1, reportOf.get(key) ?? -1, 0, r.model)
    }
    usage.timeline = timeline.timeline(charges)
    if (Object.keys(this.safeguards).length) usage.safeguards = { ...this.safeguards }
    if (Object.keys(this.safeguardsAsked).length) usage.safeguardsAsked = { ...this.safeguardsAsked }
    for (const [day, n] of this.prompts) dayOf(day).prompts += n
    for (const day of this.compactionDays) dayOf(day).compactions++
    delete days['']
    usage.days = days
    if (this.reports.length) {
      const unreported = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
      for (const key of this.uncovered) {
        const r = this.byRequest.get(key)
        if (r) addTokens(unreported, r.t)
      }
      if (Object.values(unreported).some((n) => n > 0)) usage.costUnreported = unreported
      usage.costReports = this.reports.map((rep, i) => {
        const byDay: Record<string, UsageTokens> = {}
        for (const key of rep.keys) {
          const r = this.byRequest.get(key)
          if (!r) continue
          addTokens((byDay[r.day] ??= { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }), r.t)
        }
        return { costUsd: charges[i], days: byDay }
      })
    }
    usage.requests = this.byRequest.size
    usage.title = this.customTitle ?? this.aiTitle
    usage.customTitle = this.customTitle
    usage.cacheTtlSeconds = this.saw1h ? 3600 : 300
    return usage
  }
}

/** Usage statistics for a whole Claude Code transcript (see ClaudeUsageParser). */
export function parseTranscript(text: string, sessionId: string): SessionUsage {
  const p = new ClaudeUsageParser(sessionId)
  p.feed(text)
  return p.result()
}
