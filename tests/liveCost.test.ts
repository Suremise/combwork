// A live session's cost follows Settings → <provider> → Session costs and the prices as they change (#436), with the
// real SessionManager: Claude Code's reported cost (from its status line) by default, the user's prices when chosen,
// at once for an idle session too and in both directions, and a report after an estimate is no longer marked as one.
// The CLI's report is kept while the user's prices are shown, so going back shows it again, and it is what shows when
// the user's prices have none for the model (its newest one). Without a price or a report, the cost is unknown.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { tempDir } from './tempDir'

const base = tempDir('hive-livecost-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { config } = await import('../src/main/config')
const { sessions } = await import('../src/main/sessions')
const { provider: providerAdapter } = await import('../src/main/providers')

type Live = { state: Record<string, unknown>; adapter: unknown; transcriptPath?: string; reportedCost?: number }
const manager = sessions as unknown as { live: Map<string, Live>; applyDetails: (l: Live, d: Record<string, unknown>) => void }
const project = 'C:/fake-ws/alpha'
const key = `${project.toLowerCase()}#a1`
const transcript = join(base, 'session.jsonl')
const rollout = join(base, 'codex.jsonl')
const was = structuredClone(config.settings.providers)

// A million input tokens of Sonnet 5.5, which Claude Code reported as $9: at the user's $2 per million, $2.
beforeAll(() => {
  mkdirSync(join(base, 'profile'), { recursive: true })
  const lines = [
    { type: 'user', timestamp: '2026-10-11T09:00:00Z', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', timestamp: '2026-10-11T09:00:01Z', requestId: 'r1', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'cost-state', timestamp: '2026-10-11T09:00:02Z', totalCostUSD: 9 }
  ]
  writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  // A million input tokens of GPT-6.1 Sol in a Codex rollout: $2 at Hive's price.
  const usage = { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 }
  const codex = [
    { timestamp: '2026-10-11T09:00:00Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
    { timestamp: '2026-10-11T09:00:01Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } } }
  ]
  writeFileSync(rollout, codex.map((l) => JSON.stringify(l)).join('\n') + '\n')
})
afterEach(() => {
  manager.live.delete(key)
  vi.restoreAllMocks()
})
afterAll(() => {
  config.settings.providers = was
})

/** Session costs and the user's price for Sonnet 5.5, as the settings would say. */
function choose(costSource: 'reported' | 'prices', input = 2): void {
  config.settings.providers = { ...DEFAULT_SETTINGS.providers, 'claude-code': { ...DEFAULT_SETTINGS.providers['claude-code'], costSource, prices: { 'claude-sonnet-5-5': { input, cachedInput: 0, output: 0 } } } }
  sessions.clearUsageCache()
}

/** An idle Claude Code session whose status line reported $9. */
function idle(): Live {
  const l: Live = { state: { projectPath: project, agentId: 'a1', provider: 'claude-code', sessionId: 'session', status: 'idle' }, adapter: providerAdapter('claude-code'), transcriptPath: transcript }
  manager.live.set(key, l)
  manager.applyDetails(l, { costUsd: 9 })
  return l
}

const cost = (l: Live) => ({ costUsd: l.state.costUsd, costEstimated: !!l.state.costEstimated })

describe("a live session's cost follows Session costs (#436)", () => {
  it("Claude Code's report by default; my prices at once for an idle session; back to the report again", async () => {
    choose('reported')
    const emitted = vi.spyOn(sessions as unknown as { emitState: () => void }, 'emitState')
    const l = idle()
    expect(cost(l)).toEqual({ costUsd: 9, costEstimated: false })
    choose('prices')
    await sessions.repriceLive()
    expect(cost(l)).toEqual({ costUsd: 2, costEstimated: true })
    choose('reported')
    await sessions.repriceLive()
    expect(cost(l)).toEqual({ costUsd: 9, costEstimated: false })
    expect(emitted).toHaveBeenCalledTimes(3)
  })

  it('a price changed while my prices are chosen: the new estimate at once', async () => {
    choose('prices')
    const l = idle()
    await sessions.repriceLive()
    expect(cost(l)).toEqual({ costUsd: 2, costEstimated: true })
    choose('prices', 3)
    await sessions.repriceLive()
    expect(cost(l)).toEqual({ costUsd: 3, costEstimated: true })
  })

  it("with my prices, a new report isn't shown; back to the report, a new one is, no longer marked as an estimate", async () => {
    choose('prices')
    const l = idle()
    await sessions.repriceLive()
    manager.applyDetails(l, { costUsd: 10 })
    expect(cost(l)).toEqual({ costUsd: 2, costEstimated: true })
    choose('reported')
    // A report as the source changes (before the settings' repricing): the report, as reported.
    manager.applyDetails(l, { costUsd: 11 })
    expect(cost(l)).toEqual({ costUsd: 11, costEstimated: false })
    await sessions.repriceLive()
    expect(cost(l)).toEqual({ costUsd: 11, costEstimated: false })
  })

  it("a report equal to the estimate shown still changes it to reported", () => {
    choose('reported')
    const emitted = vi.spyOn(sessions as unknown as { emitState: () => void }, 'emitState')
    const l = idle()
    Object.assign(l.state, { costUsd: 9, costEstimated: true })
    emitted.mockClear()
    manager.applyDetails(l, { costUsd: 9 })
    expect(cost(l)).toEqual({ costUsd: 9, costEstimated: false })
    expect(emitted).toHaveBeenCalledTimes(1)
  })

  it("my prices without a price for its model: the CLI's newest report, its status line's over its transcript's", async () => {
    choose('prices')
    config.settings.providers['claude-code'] = { ...config.settings.providers['claude-code'], prices: {}, pricesRemoved: ['claude-sonnet-5-5'] }
    sessions.clearUsageCache()
    const l = idle()
    // The transcript's last report is $9; the status line has said $11 since.
    manager.applyDetails(l, { costUsd: 11 })
    await sessions.repriceLive()
    expect(cost(l)).toEqual({ costUsd: 11, costEstimated: false })
  })

  it("a provider that reports no cost, its model's price removed while idle: unknown; restored: the estimate again", async () => {
    config.settings.providers = structuredClone(DEFAULT_SETTINGS.providers)
    sessions.clearUsageCache()
    const l: Live = { state: { projectPath: project, agentId: 'a1', provider: 'codex', sessionId: 'codex-session', status: 'idle' }, adapter: providerAdapter('codex'), transcriptPath: rollout }
    manager.live.set(key, l)
    await sessions.repriceLive()
    expect(cost(l)).toEqual({ costUsd: 2, costEstimated: true })
    config.settings.providers.codex = { ...config.settings.providers.codex, pricesRemoved: ['gpt-6.1-sol'] }
    sessions.clearUsageCache()
    const emitted = vi.spyOn(sessions as unknown as { emitState: () => void }, 'emitState')
    await sessions.repriceLive()
    expect(cost(l)).toEqual({ costUsd: undefined, costEstimated: false })
    expect(emitted).toHaveBeenCalledTimes(1)
    config.settings.providers.codex = { ...config.settings.providers.codex, pricesRemoved: [] }
    sessions.clearUsageCache()
    await sessions.repriceLive()
    expect(cost(l)).toEqual({ costUsd: 2, costEstimated: true })
  })

  it('my prices without a price for its model: the report stays', async () => {
    choose('prices')
    config.settings.providers['claude-code'] = { ...config.settings.providers['claude-code'], prices: {}, pricesRemoved: ['claude-sonnet-5-5'] }
    sessions.clearUsageCache()
    const l = idle()
    await sessions.repriceLive()
    expect(cost(l).costUsd).toBe(9)
  })
})

describe('a session that ran on a server connection (HI-1772)', () => {
  // A server's model (no price of Hive's) with the $9 Claude Code reported for it, priced as a Claude model.
  const serverTranscript = join(base, 'server-session.jsonl')
  type UsageFor = (projectPath: string, path: string, sessionId: string, provider: string, o?: { reportsIgnored?: boolean }) => Promise<{ costUsd: number | null; inputTokens: number } | null>
  const usageFor = (o?: { reportsIgnored?: boolean }) => (sessions as unknown as { usageFor: UsageFor }).usageFor(project, serverTranscript, 'server-session', 'claude-code', o)

  it("main's cached read answers only the policy it was read with: the report before, never after, the same tokens", async () => {
    choose('reported')
    const lines = [
      { type: 'user', timestamp: '2026-10-11T09:00:00Z', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', timestamp: '2026-10-11T09:00:01Z', requestId: 'r1', message: { model: 'deepseek-flash', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: 'cost-state', timestamp: '2026-10-11T09:00:02Z', totalCostUSD: 9 }
    ]
    writeFileSync(serverTranscript, lines.map((x) => JSON.stringify(x)).join('\n') + '\n')
    const before = await usageFor()
    expect(before).toMatchObject({ costUsd: 9, inputTokens: 1_000_000 })
    // The same file, unchanged, now as a server session: read again without the report.
    const after = await usageFor({ reportsIgnored: true })
    expect(after).toMatchObject({ costUsd: null, inputTokens: 1_000_000 })
    expect(await usageFor({ reportsIgnored: true })).toMatchObject({ costUsd: null })
  })

  it("its live cost never takes the CLI's report: a session that switched to a server connection drops the $9", async () => {
    choose('reported')
    const l = idle()
    expect(cost(l).costUsd).toBe(9)
    l.state.launchedConnection = { id: 'a-server', name: 'DeepSeek', server: { models: [] } }
    manager.applyDetails(l, { costUsd: 12 })
    await sessions.repriceLive()
    expect(cost(l).costUsd).not.toBe(12)
    expect(cost(l).costUsd).not.toBe(9)
  })

  it('free (Darren 27 Oct): a known $0 whatever prices are set, its tokens as read; the cache answers only the policy asked', async () => {
    // A price for its model: free overrides it.
    config.settings.providers = { ...DEFAULT_SETTINGS.providers, 'claude-code': { ...DEFAULT_SETTINGS.providers['claude-code'], prices: { 'deepseek-flash': { input: 5, cachedInput: 0, output: 0 } } } }
    sessions.clearUsageCache()
    type Free = (projectPath: string, path: string, sessionId: string, provider: string, o?: { reportsIgnored?: boolean; costFree?: boolean }) => Promise<{ costUsd: number | null; costFree?: true; inputTokens: number } | null>
    const read = (o?: { reportsIgnored?: boolean; costFree?: boolean }) => (sessions as unknown as { usageFor: Free }).usageFor(project, serverTranscript, 'server-session', 'claude-code', o)
    expect(await read({ reportsIgnored: true })).toMatchObject({ costUsd: 5, inputTokens: 1_000_000 })
    expect(await read({ reportsIgnored: true, costFree: true })).toMatchObject({ costUsd: 0, costFree: true, inputTokens: 1_000_000 })
    expect((await read({ reportsIgnored: true }))?.costFree).toBeUndefined()
  })

  it('a live session whose conversation ran only on servers on this PC: free (local), $0, whatever the CLI reports', async () => {
    choose('reported')
    const l = idle() as Live & { costFree?: boolean }
    l.state.launchedConnection = { id: 'a-ollama', name: 'Ollama', server: { models: [], local: true } }
    l.costFree = true
    manager.applyDetails(l, { costUsd: 12 })
    await sessions.repriceLive()
    expect(l.state.costFree).toBe(true)
    expect(cost(l).costUsd).toBe(0)
  })

  it('a local-only conversation, then a /resume into one that ran elsewhere: free (local) goes, both ways', async () => {
    choose('reported')
    const l = idle() as Live & { costFree?: boolean }
    l.state.launchedConnection = { id: 'a-ollama', name: 'Ollama', server: { models: [], local: true } }
    l.costFree = true
    await sessions.repriceLive()
    expect(l.state.costFree).toBe(true)
    // Its record for the new conversation says notLocal: not free, and the footer says so at once.
    l.costFree = false
    await sessions.repriceLive()
    expect(l.state.costFree).toBeUndefined()
    expect(cost(l).costUsd).not.toBe(0)
    // And back (another local-only conversation).
    l.costFree = true
    await sessions.repriceLive()
    expect(l.state.costFree).toBe(true)
    expect(cost(l).costUsd).toBe(0)
  })
})
