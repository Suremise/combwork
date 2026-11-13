// HI-3148: a fresh start onto a released line (tagged v1.4.0 and merged into main) is refused, naming the tag and where it
// went, with the line to start on instead when one exists and isn't released. The user's or the Assistant's override,
// given for exactly that line, lets that start through and is recorded with it; an agent's isn't one; another start
// needs its own. A card's running lane granted the line lets its starts onto it through. Real Git.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, GIT_HEAVY_MS, moved, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { isRefusal } from '../../src/main/workflow/runtime'
import { agentActor } from '../../src/shared/workflow/facts'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

/** A Pair project merging into 1.4.0, which is released: tagged v1.4.0 (annotated) and merged into main. */
function released(o: { grant?: string | null } = {}) {
  const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], target: '1.4.0' }, { releaseGrant: async () => o.grant ?? null }))
  sh(e.project, 'checkout', '-q', '-b', '1.4.0')
  commit(e.project, { 'release.txt': '1.4.0\n' }, '1.4.0')
  sh(e.project, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'tag', '-a', 'v1.4.0', '-m', 'release 1.4.0')
  sh(e.project, 'checkout', '-q', 'main')
  sh(e.project, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'merge', '-q', '--no-ff', '-m', 'release 1.4.0', '1.4.0')
  sh(e.project, 'checkout', '-q', '--detach')
  return e
}

describe('a start onto a released line (HI-3148)', () => {
  it('is refused naming the tag, its date and where it went; no next version: no suggestion', { timeout: GIT_HEAVY_MS }, async () => {
    const e = released()
    const card = e.wf.createCard({ title: 'New work' })
    const r = await e.wf.start(card.key, B1)
    expect(isRefusal(r) && r.rule).toBe('start.released')
    expect(isRefusal(r) && r.message).toMatch(/^AM-1 can’t start on 1\.4\.0: 1\.4\.0 is released \(v1\.4\.0, tagged .+, merged into main\)\.$/)
    expect(isRefusal(r) && r.next).toMatch(/^Start it on a branch that isn’t released/)
    expect(isRefusal(r) && r.override).toBe('the user or the Assistant')
    expect(e.wf.state(card).stage).toBe('todo')
    expect(e.wf.state(card).started).toBeNull()
  })

  it('suggests the next version once it exists and isn’t released', { timeout: GIT_HEAVY_MS }, async () => {
    const e = released()
    sh(e.project, 'branch', '1.5.0', '1.4.0')
    const r = await e.wf.start(e.wf.createCard({ title: 'New work' }).key, B1)
    expect(isRefusal(r) && r.next).toMatch(/^Did you mean 1\.5\.0\? Set its Merges into to 1\.5\.0/)
  })

  it('the user’s override for exactly that line lets this start through, recorded with it; an agent’s, another line’s or another start’s doesn’t', { timeout: GIT_HEAVY_MS }, async () => {
    const e = released()
    const card = e.wf.createCard({ title: 'Hotfix' })
    // An agent's "override" isn't one.
    expect(isRefusal(await e.wf.start(card.key, B1, { released: { target: '1.4.0', reason: 'hotfix' } })) ).toBe(true)
    // Given for another line (the target changed since it was confirmed): refused.
    const stale = await e.wf.start(card.key, 'user', { builder: 'b1', released: { target: '1.3.0', reason: 'hotfix' } })
    expect(isRefusal(stale) && stale.rule).toBe('start.released')
    // The user's, for 1.4.0: started, and the override recorded with the line it was given for.
    moved(await e.wf.start(card.key, 'user', { builder: 'b1', released: { target: '1.4.0', reason: 'hotfix for 1.4.1' } }))
    expect(e.wf.state(card).started?.target).toBe('1.4.0')
    const o = e.store.facts(card.id).findLast((f) => f.kind === 'Override')?.data
    expect(o).toMatchObject({ rules: ['start.released'], by: 'user', reason: 'hotfix for 1.4.1', target: '1.4.0' })
    // Another card: refused again (the override was that start's).
    const other = await e.wf.start(e.wf.createCard({ title: 'More' }).key, B1)
    expect(isRefusal(other) && other.rule).toBe('start.released')
  })

  it('the Assistant’s override counts as the user’s does', { timeout: GIT_HEAVY_MS }, async () => {
    const e = released()
    const card = e.wf.createCard({ title: 'Hotfix' })
    moved(await e.wf.start(card.key, 'assistant', { builder: 'b1', released: { target: '1.4.0', reason: 'the user asked' } }))
    expect(e.store.facts(card.id).findLast((f) => f.kind === 'Override')?.data).toMatchObject({ by: 'assistant', target: '1.4.0' })
  })

  it('a card in a running lane granted 1.4.0 starts on it; not one granted another line', { timeout: GIT_HEAVY_MS }, async () => {
    const granted = released({ grant: '1.4.0' })
    const card = granted.wf.createCard({ title: 'In the lane' })
    granted.wf.startLane('lane-1', [card.id], 'R1')
    moved(await granted.wf.start(card.key, B1))
    env?.close()
    const other = released({ grant: '1.3.0' })
    const c2 = other.wf.createCard({ title: 'In another lane' })
    other.wf.startLane('lane-2', [c2.id], 'R1')
    const r = await other.wf.start(c2.key, agentActor('b1'))
    expect(isRefusal(r) && r.rule).toBe('start.released')
  })

  it('a line that isn’t released, or is only tagged: started as before', { timeout: GIT_HEAVY_MS }, async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], target: '1.4.0' }))
    sh(e.project, 'branch', '1.4.0')
    sh(e.project, 'tag', 'v1.4.0', '1.4.0')
    commit(e.project, { 'main.txt': 'main moves on\n' }, 'main moves on')
    sh(e.project, 'checkout', '-q', '1.4.0')
    commit(e.project, { 'release.txt': 'more\n' }, 'more on 1.4.0')
    sh(e.project, 'checkout', '-q', '--detach')
    moved(await e.wf.start(e.wf.createCard({ title: 'Ordinary' }).key, B1))
  })
})
