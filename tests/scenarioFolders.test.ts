// A scenario's work folder stays inside Windows' path limit (HI-3212): a jj project's deepest file is its operation
// store's, `.jj\repo\op_store\operations\<128 hex>` (jj 0.47 on Windows: a project folder of 101 characters works, 102
// fails "Failed to commit new operation"), and the jj scenarios' setup made `jj-card-submit-nc-fake-opencode` 260 long.
import path from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain CommonJS modules without types
import { SCENARIOS } from './scenarios/scenarios.cjs'
// @ts-expect-error: plain CommonJS modules without types
import { PROVIDERS, PROVIDER_TAGS, scenarioFolder } from './scenarios/harness.cjs'

type Scenario = { id: string; jj?: boolean }
// The longest path Windows' file calls take without the long-path prefix: 260 with its terminating NUL.
const MAX_PATH = 259
// jj's deepest file in the project (alpha, `ws\alpha` in the scenario's folder): an operation's 128-hex id.
const deepest = (folder: string): string => path.win32.join(folder, 'ws', 'alpha', '.jj', 'repo', 'op_store', 'operations', 'f'.repeat(128))
// The scenarios' lanes root (run.mjs, laneWork) for a user folder of `user` characters, in lane `lane`.
const lanesRoot = (user: number, lane: number): string => path.win32.join('C:\\Users', 'u'.repeat(user), 'AppData', 'Local', 'combwork-test', 'scenarios', 'lanes', String(lane))

describe("the scenarios' work folders", () => {
  const providers = Object.keys(PROVIDERS)
  const jjScenarios = (SCENARIOS as Scenario[]).filter((s) => s.jj)

  it('tag every provider, each tag its own', () => {
    expect(Object.keys(PROVIDER_TAGS).sort()).toEqual([...providers].sort())
    expect(new Set(Object.values(PROVIDER_TAGS)).size).toBe(providers.length)
    expect(scenarioFolder('jj-card-submit-nc', 'fake-opencode')).toBe('jj-card-submit-nc-foc')
  })

  it("keep every jj scenario's operation store inside MAX_PATH on every provider: a 10-character user folder, lane 99, an evidence copy's -9", () => {
    expect(jjScenarios.map((s) => s.id)).toContain('jj-card-submit-nc')
    const over = jjScenarios.flatMap((s) => providers.map((p) => deepest(path.win32.join(lanesRoot(10, 99), `${scenarioFolder(s.id, p)}-9`)))).filter((f) => f.length > MAX_PATH)
    expect(over).toEqual([])
  })

  it("would fail with the provider's whole key, as the first runs on fake-opencode did (the premise)", () => {
    // The runs' machine: a 6-character user folder, lane 0.
    expect(deepest(path.win32.join(lanesRoot(6, 0), 'jj-card-submit-nc-fake-opencode')).length).toBe(MAX_PATH + 1)
  })
})
