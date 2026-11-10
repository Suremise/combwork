// Copilot CLI 1.0.107's ACP replies as Combwork's model listing asks them (HI-2780; tests/fixtures/copilot/acp-1.0.107.json:
// `copilot --acp --no-auto-update`, initialize then session/new, BYOK against the scripted stand-in model, a throwaway home,
// the portable release copy; 1.0.106's replies were the same shape). Read by the real parsing code: its models, its default,
// and what its enablement metadata says (some marked, so never a policy's refusal).
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { modelEnablement, modelsOutcome, parseCopilotModels } from '../src/main/providers/copilot/models'
import { withModels } from '../src/main/providers/copilot/hosts'

const replies = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'copilot', 'acp-1.0.107.json'), 'utf8')) as { id: number; result?: Record<string, unknown> }[]
const init = replies.find((r) => r.id === 1)!
const sessionNew = replies.find((r) => r.id === 2)!

describe("Copilot 1.0.107's ACP model listing", () => {
  it('says its version in initialize, and offers the terminal sign-in Combwork never runs from a check', () => {
    expect(init.result?.agentInfo).toEqual({ name: 'Copilot', title: 'Copilot', version: '1.0.107' })
    expect(((init.result?.authMethods ?? []) as { id: string }[]).map((m) => m.id)).toContain('copilot-login')
  })

  it('lists its models with the default it runs, read as before', () => {
    expect(parseCopilotModels(sessionNew.result)).toEqual({ models: [{ value: 'auto', label: 'Auto', description: 'Let Copilot pick the best model' }, { value: 'gpt-4.1', label: 'gpt-4.1', description: 'gpt-4.1 · uses 0x' }], defaultModel: 'gpt-4.1' })
    expect(sessionNew.result?.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('marks enablement on some models only (Auto has none): entitlement unknown, never a policy refusal', () => {
    expect(modelEnablement(sessionNew.result)).toEqual({ enablement: 'some', allDisabled: false })
    const outcome = modelsOutcome(sessionNew)
    expect(outcome).toMatchObject({ kind: 'ok', enablement: 'some', allDisabled: false })
    // A model of its own (BYOK) needs no GitHub sign-in: the listing doesn't make it anything else.
    expect(withModels({ state: 'noSignIn', source: 'local', variable: null, account: null }, outcome)).toMatchObject({ state: 'noSignIn', models: { available: 2, unavailable: 0, metadata: 'some' } })
  })
})
