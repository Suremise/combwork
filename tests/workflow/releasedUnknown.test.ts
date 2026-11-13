// HI-3148: whether a start's line is released can't be read: the start is refused (start.releaseUnknown), saying what
// couldn't be read, and nothing of it is written (no Started); never taken for "not released". The user's
// or the Assistant's override lets it through as for a released line. The release reads stand in for a platform's.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { B1, moved, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { isRefusal } from '../../src/main/workflow/runtime'
import { unknown } from '../../src/main/platform/types'
import { UNREADABLE } from '../../src/shared/workflow/texts'

vi.mock('../../src/main/platform/releaseReadsPorts', () => ({
  releaseReadsOf: () => ({
    released: async () => unknown(UNREADABLE.line, { branch: 'refs/tags/v1.4.0' }),
    exists: async () => true
  })
}))

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

describe('a start whose line can’t be checked (HI-3148)', () => {
  it('is refused saying what couldn’t be read, writing nothing; the user’s override lets it through', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], target: '1.4.0' }))
    sh(e.project, 'branch', '1.4.0')
    const card = e.wf.createCard({ title: 'New work' })
    const r = await e.wf.start(card.key, B1)
    expect(isRefusal(r) && r.rule).toBe('start.releaseUnknown')
    expect(isRefusal(r) && r.message).toBe('Combwork couldn’t check whether 1.4.0 is released (the branch refs/tags/v1.4.0), so AM-1 wasn’t started.')
    expect(e.wf.state(card).stage).toBe('todo')
    expect(e.store.facts(card.id).some((f) => f.kind === 'Started')).toBe(false)
    moved(await e.wf.start(card.key, 'user', { builder: 'b1', released: { target: '1.4.0', reason: 'hotfix now' } }))
  })
})
