// A provider's page's Check now (HI-2550) checks only that provider's CLI: it asks main to refresh just that one, keeps the
// other providers' results as they were, and reports only on it. Help's Check Coding Agents for Updates still checks all
// three. The real renderer actions and store, with the window's IPC faked to record what was asked.
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentInstallInfo, ProviderId } from '../src/shared/types'

const asked: unknown[][] = []
let reply: Record<string, AgentInstallInfo> = {}
;(globalThis as unknown as { window: unknown }).window = {
  hive: {
    invoke: async (...args: unknown[]) => {
      asked.push(args)
      return args[0] === 'provider:refresh' ? reply : null
    },
    on: () => () => {}
  },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
}

// The renderer's modules, typed here by what the test uses: the main process's typecheck doesn't follow renderer code.
interface Toast {
  title: string
}
interface RendererStore {
  get: () => { providers: Record<string, AgentInstallInfo>; toasts?: Toast[] }
  set: (u: Record<string, unknown>) => void
}
const rendererStore = '../src/renderer/src/store'
const rendererActions = '../src/renderer/src/actions'
const store = (await import(/* @vite-ignore */ rendererStore)) as RendererStore
const actions = (await import(/* @vite-ignore */ rendererActions)) as { refreshProviders: (only?: ProviderId) => Promise<void> }

const info = (provider: ProviderId, version: string, extra: Partial<AgentInstallInfo> = {}): AgentInstallInfo => ({ provider, found: true, version, path: `C:\\${provider}.exe`, ...extra }) as AgentInstallInfo
const cached = { 'claude-code': info('claude-code', '1.0.0'), codex: info('codex', '1.0.0'), 'github-copilot': info('github-copilot', '1.0.0') }
const refreshes = () => asked.filter((a) => a[0] === 'provider:refresh')

beforeEach(() => {
  asked.length = 0
  store.set({ providers: { ...cached } })
})

describe("a provider's page's Check now (HI-2550)", () => {
  it('asks main to refresh only that provider, and keeps the other providers as they were', async () => {
    // Main's reply has every provider; the others changed meanwhile (say, an install's own refresh): Check now leaves them.
    reply = { 'claude-code': info('claude-code', '9.9.9'), codex: info('codex', '9.9.9'), 'github-copilot': info('github-copilot', '2.0.0', { updateAvailable: true, latestVersion: '2.1.0' }) }
    await actions.refreshProviders('github-copilot')
    expect(refreshes()).toEqual([['provider:refresh', 'github-copilot']])
    const after = store.get().providers
    expect(after['github-copilot'].version).toBe('2.0.0')
    expect(after['claude-code']).toBe(cached['claude-code'])
    expect(after.codex).toBe(cached.codex)
  })

  it('Check Coding Agents for Updates still checks all three', async () => {
    reply = { 'claude-code': info('claude-code', '3.0.0'), codex: info('codex', '3.0.0'), 'github-copilot': info('github-copilot', '3.0.0') }
    await actions.refreshProviders()
    expect(refreshes()).toEqual([['provider:refresh']])
    expect(Object.values(store.get().providers).map((p) => p.version)).toEqual(['3.0.0', '3.0.0', '3.0.0'])
  })
})
