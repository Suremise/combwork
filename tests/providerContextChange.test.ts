// A GitHub host change while a provider's refresh is still running (HI-2779, HR2's round 2): the refresh read the old
// routes (its locate's per-host catalogues) and is paused before it publishes; the change supersedes it in the same turn
// (forgetCatalog), so when it resumes, nothing of the old hosts' catalogues is published again, whatever it awaited.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstallInfo, ModelCatalog } from '../src/shared/types'
import { providerService } from '../src/main/providerService'
import { provider } from '../src/main/providers'

const old: ModelCatalog = { source: 'cli', version: '1.0.106', models: [{ value: 'public-only-model', label: 'P' }], at: 'then', context: 'github.com|github.com|env|c:\\h|stored:octo|strip:1|update:0|c:\\copilot.exe@1.0.106' }

afterEach(() => vi.restoreAllMocks())

describe('a host change during a refresh', () => {
  it('the paused refresh resumes after the change and publishes none of the old hosts’ catalogues', async () => {
    const copilot = provider('copilot')
    const located: AgentInstallInfo = { provider: 'copilot', found: true, path: 'C:\\bin\\copilot.exe', version: '1.0.106', source: 'PATH', latestVersion: null, updateAvailable: false, loggedIn: true, authMethod: 'Copilot login', account: 'octo', hostCatalogs: { 'github.com|github.com|env|c:\\h': old }, hostRouteOf: { 'd:\\ws': 'github.com|github.com|env|c:\\h' } }
    vi.spyOn(copilot, 'locate').mockResolvedValue(located)
    vi.spyOn(copilot, 'listModels').mockResolvedValue(null)
    // Paused after locate, in the latest version lookup (checkLatest), until released.
    let release: (v: string | null) => void = () => {}
    let paused: () => void = () => {}
    const reachedPause = new Promise<void>((r) => (paused = r))
    vi.spyOn(copilot, 'latestVersion').mockImplementation(() => {
      paused()
      return new Promise((r) => (release = r))
    })
    const running = (providerService as unknown as { refreshOne: (id: string, checkLatest?: boolean) => Promise<AgentInstallInfo> }).refreshOne('copilot', true)
    await reachedPause
    // The host changes (githubHostChanges.ts), while the replacement refresh waits for the workspace to read its projects.
    providerService.forgetCatalog('copilot')
    expect(providerService.info('copilot').hostCatalogs).toEqual({})
    release(null)
    await running
    // The old run is superseded: its per-host catalogues and routes are never published again.
    expect(providerService.info('copilot').hostCatalogs).toEqual({})
    expect(providerService.info('copilot').hostRouteOf).toEqual({})
    expect(providerService.info('copilot').catalog ?? null).toBeNull()
  })
})
