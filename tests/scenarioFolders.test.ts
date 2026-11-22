// A scenario's work folder is named by its id and a short tag of its provider (HI-3212: the provider's whole key made the
// jj scenarios' folders pass Windows' path limit), each provider its own tag.
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain CommonJS modules without types
import { PROVIDERS, PROVIDER_TAGS, scenarioFolder } from './scenarios/harness.cjs'

describe("the scenarios' work folders", () => {
  const providers = Object.keys(PROVIDERS)

  it('tag every provider, each tag its own', () => {
    expect(Object.keys(PROVIDER_TAGS).sort()).toEqual([...providers].sort())
    expect(new Set(Object.values(PROVIDER_TAGS)).size).toBe(providers.length)
    expect(scenarioFolder('work-on-card', 'fake-opencode')).toBe('work-on-card-foc')
  })
})
