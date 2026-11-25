// HI-3319: a start's release read (HI-3148) whose ground was unsettled or moved under it (Combwork's own writes beside
// it: a slot made or detached) is read again whole, at most RELEASE_READS reads, so the user's drag starts the card
// instead of asking to confirm a released line. A steady unknown is not read again; one unsettled every time is still unknown.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, moved, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { isRefusal, RELEASE_READS } from '../../src/main/workflow/runtime'
import { unknown } from '../../src/main/platform/types'
import { UNREADABLE } from '../../src/shared/workflow/texts'
import type { ReleaseReads } from '../../src/main/platform/releaseReads'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

/**
 * Release reads whose watch's checker answers `heads` in turn, a value a call (null: unsettled; the last one stays), and
 * whose read is unknown the first `movedReads` times (the head moving under it) or always
 * (`steadyUnknown`), else not released.
 */
function reads(heads: (string | null)[], o: { movedReads?: number; steadyUnknown?: boolean } = {}) {
  let i = 0
  const calls = { watch: 0, released: 0 }
  const r: ReleaseReads = {
    async watch() {
      calls.watch++
      return () => heads[Math.min(i++, heads.length - 1)]
    },
    async released() {
      calls.released++
      return o.steadyUnknown || calls.released <= (o.movedReads ?? 0) ? unknown(UNREADABLE.line, { branch: '1.4.0' }) : null
    },
    exists: async () => true
  }
  return { r, calls }
}

function project(r: ReleaseReads) {
  const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], target: '1.4.0' }, { releaseReads: () => r }))
  sh(e.project, 'branch', '1.4.0')
  return e
}

describe('a start’s release read under a moving head (HI-3319)', () => {
  it('the user’s drag, the head unsettled at the first read: read again, started, nothing asked', async () => {
    const f = reads([null, 'op-2'])
    const e = project(f.r)
    const card = e.wf.createCard({ title: 'Card two' })
    moved(await e.wf.move(card.key, 'active', 'user', { builder: 'b1', confirm: true, reason: 'start' }))
    expect(e.wf.state(card).stage).toBe('active')
    expect(e.store.facts(card.id).some((x) => x.kind === 'Override')).toBe(false)
  })

  it('an agent’s start, the head moved under the read: read again, started', async () => {
    const f = reads(['op-1', 'op-2'], { movedReads: 1 })
    const e = project(f.r)
    const card = e.wf.createCard({ title: 'Card two' })
    moved(await e.wf.start(card.key, B1))
    expect(f.calls.released).toBe(2)
  })

  it('unsettled at every read: still unknown after RELEASE_READS reads (refused; the drag asks)', async () => {
    const f = reads([null])
    const e = project(f.r)
    const card = e.wf.createCard({ title: 'Card two' })
    const r = await e.wf.start(card.key, B1)
    expect(isRefusal(r) && r.rule).toBe('start.releaseUnknown')
    expect(f.calls.watch).toBe(RELEASE_READS)
    expect(await e.wf.move(card.key, 'active', 'user', { builder: 'b1', confirm: true, reason: 'start' })).toMatchObject({ ask: true, released: '1.4.0' })
    expect(e.wf.state(card).stage).toBe('todo')
  })

  it('a steady unknown (nothing moved) is not read again', async () => {
    const f = reads(['op-1'], { steadyUnknown: true })
    const e = project(f.r)
    const r = await e.wf.start(e.wf.createCard({ title: 'Card two' }).key, B1)
    expect(isRefusal(r) && r.rule).toBe('start.releaseUnknown')
    expect(f.calls.released).toBe(1)
  })
})
