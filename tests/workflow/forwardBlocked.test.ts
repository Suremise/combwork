// HI-2709 (HR2's round 5): a forward merge whose frozen source is in its destination already is closed with no advance
// of its own; that close keeps the blocker rule too, read in its write. A dependency added while the queue reads the
// containment holds it (waiting, its entry open, Merging); once the blocker is Done the queue closes it. On real temporary
// repositories, the containment read the queue makes given a hook at its end.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { commit, GIT_HEAVY_MS, moved, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { forwardOf } from '../../src/shared/workflow/compile'
import { boardFile } from '../../src/main/boardStore'
import type { CardRecord } from '../../src/main/workflow/factStore'

const flags = vi.hoisted(() => ({ afterContains: null as (() => void) | null }))
vi.mock('../../src/main/platform/git', async (orig) => {
  const actual = (await orig()) as typeof import('../../src/main/platform/git')
  return {
    ...actual,
    contains: async (...args: Parameters<typeof actual.contains>) => {
      const r = await actual.contains(...args)
      const then = flags.afterContains
      flags.afterContains = null
      then?.()
      return r
    }
  }
})

let env: Env | null = null
beforeEach(() => {
  flags.afterContains = null
})
afterEach(() => {
  env?.close()
  env = null
})

const head = (e: Env, ref: string): string => sh(e.project, 'rev-parse', ref)
const block = (e: Env, card: CardRecord, by: CardRecord[]): void => {
  const db = new DatabaseSync(boardFile(e.home))
  try {
    db.prepare("DELETE FROM card_links WHERE card = ? AND kind = 'blockedBy'").run(card.id)
    by.forEach((b, i) => db.prepare("INSERT INTO card_links (card, kind, ord, target) VALUES (?, 'blockedBy', ?, ?)").run(card.id, i, b.id))
  } finally {
    db.close()
  }
}

describe('HI-2709: a forward merge already in its destination', () => {
  it('a dependency added while the queue reads that it is there: not closed, waiting; its blocker Done, closed', { timeout: GIT_HEAVY_MS }, async () => {
    const e = (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], commitMessage: 'combwork', okBefore: { mode: 'never', labels: [] } }))
    sh(e.project, 'branch', '1.2.0')
    commit(e.project, { 'fix.txt': 'the release fix\n' }, 'the release fix')
    sh(e.project, 'checkout', '-q', '--detach')
    const blocker = e.wf.createCard({ title: 'Blocker' })
    const card = e.wf.createCard({ title: 'Bring 1.2.0 up to date with main' })
    const source = head(e, 'main')
    moved(await e.wf.forwardStart(card.key, { from: 'main', to: '1.2.0', source, base: sh(e.project, 'merge-base', 'main', '1.2.0') }, 'user', forwardOf(e.wf.currentRuleset(), '1.2.0')))
    // Brought up to date by hand meanwhile.
    sh(e.project, 'checkout', '-q', '1.2.0')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', source)
    sh(e.project, 'checkout', '-q', '--detach')
    const dest = head(e, '1.2.0')
    flags.afterContains = () => block(e, card, [blocker])
    expect(await e.queue().drain('1.2.0')).toEqual([{ card: card.key, entry: expect.any(String), outcome: 'waiting', on: [blocker.key] }])
    const s = e.wf.state(card)
    expect(s.stage).toBe('merging')
    expect(s.integrated).toBeNull()
    expect(s.entries.at(-1)?.state).toBe('open')
    expect(head(e, '1.2.0')).toBe(dest)
    moved(await e.wf.move(blocker.key, 'done', 'user', { confirm: true, reason: 'finished elsewhere' }))
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: card.key, outcome: 'integratedOutside' }])
    expect(e.wf.state(card)).toMatchObject({ stage: 'done', integrated: { by: 'outside', revision: source } })
  })
})
