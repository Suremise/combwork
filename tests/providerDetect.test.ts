// Automatic is only decided once every turned-on CLI has answered (#506), and a wait that runs out refuses rather
// than committing a guess: no agent is made with a guessed provider. providerService's detection state set by hand,
// no CLI is run.
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import type { AgentInstallInfo, ProviderId } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-provider-detect-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { config } = await import('../src/main/config')
const { providerService } = await import('../src/main/providerService')
const { prepareAgent } = await import('../src/main/projectAgents')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

const ALL: ProviderId[] = ['claude-code', 'codex', 'copilot']
const svc = providerService as unknown as { set: (id: ProviderId, info: AgentInstallInfo) => void }
/** Hive's answer for a CLI: found, missing, or still looking (null). */
const hear = (id: ProviderId, found: boolean | null): void => svc.set(id, { ...providerService.info(id), found: !!found, path: found ? `C:\\fake\\${id}.exe` : null, checking: found === null })
const waitMs = providerService.detectWaitMs

beforeEach(() => {
  config.update((c) => {
    for (const id of ALL) c.settings.providers[id] = { ...c.settings.providers[id], enabled: true }
    c.settings.defaultProvider = 'auto'
  })
  providerService.detectWaitMs = 200
  for (const id of ALL) hear(id, null)
})

afterAll(() => {
  providerService.detectWaitMs = waitMs
})

describe('detection before Automatic decides (#506)', () => {
  it('waits for every turned-on CLI, in whatever order they answer', async () => {
    let settled: boolean | null = null
    const waiting = providerService.detected().then((ok) => (settled = ok))
    hear('codex', true)
    hear('claude-code', true)
    await new Promise((r) => setTimeout(r, 20))
    // Copilot hasn't answered.
    expect(settled).toBeNull()
    hear('copilot', false)
    expect(await waiting).toBe(true)
  })

  it('refuses once the wait runs out, rather than deciding from a guess', async () => {
    hear('codex', true)
    expect(await providerService.detected()).toBe(false)
    await expect(providerService.settle()).rejects.toThrow(/still looking for the coding agent CLIs/)
    // A launch of a CLI still being looked for names it.
    await expect(providerService.settle('claude-code')).rejects.toThrow(/still looking for Claude Code/)
  })

  it('makes no agent with a guessed provider: one following Automatic is refused, one with a provider is made', async () => {
    hear('codex', true)
    await expect(prepareAgent(join(base, 'p'), DEFAULT_PROJECT_CONFIG, { location: 'project' }, 'Guess', [])).rejects.toThrow(/still looking/)
    const { def } = await prepareAgent(join(base, 'p'), DEFAULT_PROJECT_CONFIG, { location: 'project', provider: 'codex' }, 'Chosen', [])
    expect(def.provider).toBe('codex')
    // Once all have answered: Claude Code, though Codex answered first.
    hear('claude-code', true)
    hear('copilot', false)
    expect((await prepareAgent(join(base, 'p'), DEFAULT_PROJECT_CONFIG, { location: 'project' }, 'Auto', [])).def.provider).toBe('claude-code')
  })

  it('a launch of a known provider waits only for its own CLI, not for another still being looked for', async () => {
    hear('codex', true)
    // Claude Code and Copilot never answer: Automatic is still unknown past the wait, but Codex is.
    await expect(providerService.settle('codex')).resolves.toBeUndefined()
    expect(await providerService.detected()).toBe(false)
    hear('codex', null)
    await expect(providerService.settle('codex')).rejects.toThrow(/still looking for Codex/)
  })

  it("doesn't wait for a provider turned off; a default provider chosen before 1.0 no longer skips the wait (decision A)", async () => {
    config.update((c) => {
      c.settings.providers.copilot = { ...c.settings.providers.copilot, enabled: false }
    })
    hear('claude-code', false)
    hear('codex', true)
    expect(await providerService.detected()).toBe(true)
    expect((await prepareAgent(join(base, 'p'), DEFAULT_PROJECT_CONFIG, { location: 'project' }, 'Codex', [])).def.provider).toBe('codex')
    // HI-2121: a 0.9 config's chosen default is read by no new agent: Claude Code being looked for again is waited for.
    config.update((c) => {
      c.settings.defaultProvider = 'codex'
    })
    hear('claude-code', null)
    await expect(prepareAgent(join(base, 'p'), DEFAULT_PROJECT_CONFIG, { location: 'project' }, 'Chosen', [])).rejects.toThrow(/still looking/)
    // One naming its CLI waits only for that CLI.
    expect((await prepareAgent(join(base, 'p'), DEFAULT_PROJECT_CONFIG, { location: 'project', provider: 'codex' }, 'Named', [])).def.provider).toBe('codex')
  })
})
