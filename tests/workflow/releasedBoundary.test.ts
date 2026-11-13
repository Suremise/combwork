// HI-3148, HR2's round 1: what lets a start onto its line through without the user's confirmation (the line not released,
// or the card's lane's grant) is checked again inside the start's write. A release tag made, or the lane's grant ended,
// after the start decided but before it is written: the start is decided again and refused, nothing of it written (no
// Started, no Override, no open lease). The user's drag the same: asked, never started. Real Git.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, GIT_HEAVY_MS, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { isRefusal } from '../../src/main/workflow/runtime'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const TAG = ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'tag', '-a', 'v1.4.0', '-m', 'release 1.4.0', '1.4.0']

/**
 * A Pair project merging into 1.4.0, merged into main but not tagged yet: not released. `at` names the write whose
 * beforeWrite makes the tag, once (the start then decided again sees it); `grant` is the lane's grant as stored, which a
 * test may end.
 */
function fixture(o: { at?: string; grant?: { now: string | null } } = {}) {
  let tagged = false
  const e = (env = setup(
    { ...preset('git', 'pair'), preChecks: [], mergeChecks: [], target: '1.4.0' },
    {
      releaseGrant: () => o.grant?.now ?? null,
      hooks: {
        beforeWrite: (move) => {
          if (move !== o.at || tagged) return
          tagged = true
          sh(e.project, ...TAG)
        }
      }
    }
  ))
  sh(e.project, 'checkout', '-q', '-b', '1.4.0')
  commit(e.project, { 'release.txt': '1.4.0\n' }, '1.4.0')
  sh(e.project, 'checkout', '-q', 'main')
  sh(e.project, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'merge', '-q', '--no-ff', '-m', 'release 1.4.0', '1.4.0')
  sh(e.project, 'checkout', '-q', '--detach')
  return e
}

/** Nothing of a start written: no Started, no Override, no lease open. */
function nothingWritten(e: Env, id: number): void {
  const facts = e.store.facts(id)
  expect(facts.some((f) => f.kind === 'Started')).toBe(false)
  expect(facts.some((f) => f.kind === 'Override')).toBe(false)
  expect(e.wf.state(id).stage).toBe('todo')
  expect(e.wf.state(id).started).toBeNull()
}

describe('a start’s release decision, bound to its write (HI-3148, HR2’s round 1)', () => {
  it('a tag made between the decision and the write: an agent’s start is refused start.released, nothing written', { timeout: GIT_HEAVY_MS }, async () => {
    const e = fixture({ at: 'start' })
    const card = e.wf.createCard({ title: 'New work' })
    const r = await e.wf.start(card.key, B1)
    expect(isRefusal(r) && r.rule).toBe('start.released')
    nothingWritten(e, card.id)
  })

  it('the user’s drag the same: asked naming the line, never started', { timeout: GIT_HEAVY_MS }, async () => {
    const e = fixture({ at: 'move' })
    const card = e.wf.createCard({ title: 'Dragged' })
    expect(await e.wf.move(card.key, 'active', 'user', { builder: 'b1' })).toMatchObject({ ask: true, rules: ['start.released'], released: '1.4.0' })
    nothingWritten(e, card.id)
  })

  it('the lane’s grant ended while its card’s start waits: refused, nothing written', { timeout: GIT_HEAVY_MS }, async () => {
    const grant = { now: '1.4.0' as string | null }
    const e = fixture({ grant })
    sh(e.project, ...TAG)
    const card = e.wf.createCard({ title: 'In the lane' })
    e.wf.startLane('lane-1', [card.id], 'R1')
    // The grant read as the start decides, gone (the lane ended or replaced) by the time it is written.
    const hooks = (e.wf as unknown as { cfg: { hooks: { beforeWrite: (m: string) => void } } }).cfg.hooks
    hooks.beforeWrite = (m) => {
      if (m === 'start') grant.now = null
    }
    const r = await e.wf.start(card.key, B1)
    expect(isRefusal(r) && r.rule).toBe('start.released')
    nothingWritten(e, card.id)
  })
})
