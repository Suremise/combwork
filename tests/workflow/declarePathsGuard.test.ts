// HI-3517: declare paths only where the card's platform declares paths and its deliverables are installed. A Git card
// (whose port Combwork has none of: its work is its commits) and a None card on a runtime without None's deliverables (a
// build without None, HI-3489's option A) are refused `paths.notDeclared`: nothing stored on the card, nothing read.
// A None card declares as before.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { B1, moved, refusedBy, setup, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { isRefusal } from '../../src/main/workflow/runtime'
import { noneDeliverables } from '../../src/main/platform/none/noneDeliverables'

let env: Env | null = null
afterEach(() => {
  vi.restoreAllMocks()
  env?.close()
  env = null
})

const files = { 'docs/a.md': 'a\n' }

/** Spies on every way declare paths reads the deliverables: the runtime's content hashing and the port's whole read. */
function reads(e: Env) {
  const deliverables = vi.spyOn(e.wf, 'deliverables')
  const whole = vi.spyOn(noneDeliverables, 'readWhole')
  return () => deliverables.mock.calls.length + whole.mock.calls.length
}

describe('declare paths where nothing declares them (HI-3517)', () => {
  it("a Git card: refused, saying so as a fact, nothing stored or read", async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }))
    const card = e.wf.createCard({ title: 'Git work' })
    moved(await e.wf.start(card.key, B1))
    const count = reads(e)
    const r = refusedBy(await e.wf.declarePaths(card.key, B1, ['src/a.txt']), 'paths.notDeclared')
    expect(r.message).toBe(`${card.key}: cards under Git don’t declare paths here, so nothing was declared.`)
    expect(r.next).toBe('Nothing was stored or read.')
    expect(r.override).toBeNull()
    expect(e.store.card(card.id).paths ?? null).toBeNull()
    expect(count()).toBe(0)
  })

  it("a None card where None's deliverables aren't installed: refused the same way, not an internal error", async () => {
    const e = (env = setup({ ...preset('none', 'pair'), preChecks: [] }, { files }))
    const card = e.wf.createCard({ title: 'No port' })
    moved(await e.wf.start(card.key, B1))
    // As a build without None makes it (HI-3489): the runtime has no deliverables.
    Object.defineProperty(e.wf, 'none', { value: null })
    const count = reads(e)
    const r = refusedBy(await e.wf.declarePaths(card.key, B1, ['docs/a.md']), 'paths.notDeclared')
    expect(r.message).toBe(`${card.key}: cards under None don’t declare paths here, so nothing was declared.`)
    expect(r.next).toBe('Nothing was stored or read.')
    expect(e.store.card(card.id).paths ?? null).toBeNull()
    expect(count()).toBe(0)
  })

  it('a None card declares its paths as before', async () => {
    const e = (env = setup({ ...preset('none', 'pair'), preChecks: [] }, { files }))
    const card = e.wf.createCard({ title: 'Declared' })
    moved(await e.wf.start(card.key, B1))
    const r = await e.wf.declarePaths(card.key, B1, ['docs/a.md'])
    expect(isRefusal(r)).toBe(false)
    expect(e.store.card(card.id).paths).toEqual(['docs/a.md'])
  })

})
